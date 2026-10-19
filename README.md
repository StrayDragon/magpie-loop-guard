# loop-guard · LLM 死循环保护（magpie 网关中间件）

模型在同一个会话里**连续返回一模一样的回复**时——最常见的是 agent 的工具调用死循环：同一句话、同一个工具调用、同样的参数，一轮又一轮——每多一轮都在白烧钱、白烧 token。

loop-guard 在请求发出前，从请求体自带的会话历史里数"**连续相同的助手回复**"：达到阈值（默认 **5** 次）就拒绝这个请求，把循环打断。即"重复 N 次一模一样的内容，就中断后续请求"。

- **按会话独立计算**：计数来自请求体自身携带的历史，天然逐会话独立；子代理、多个并行会话互不干扰。不需要任何跨请求的共享表、锁或淘汰策略。
- **性能开销极小**：只挂 `onRequest`，不挂 `onEvent`/`onResponse`——回复（含流式）路径完全不经过本中间件，零开销。请求侧只做模型名匹配（常数）+ 至多 `scan` 条消息的角色判断 + 至多 `threshold` 条回复的哈希（凑满阈值或遇到第一个不同就停）。哈希直接流式喂入，热路径零分配。
- **实测**（moejs——magpie 运行中间件的真实引擎，133 KB / 81 条消息、40 轮循环历史的极端请求体）：单次 `onRequest` ≈ **1.5 ms**（500 次平均 1.49–1.73 ms，预算 250 ms，余量 100 倍以上）。普通无循环请求只哈希 2 条回复即返回，远低于此。
- **不确定即放行**：比较前去掉 `id`、`signature`、`usage` 等每轮必变的字段只比内容；字符预算耗尽等任何"算不出来"的情况都当作不确定处理，放行而不是拒绝（fail open，与 magpie 中间件的失败语义一致）。

## 安装

```sh
# 从 GitHub（仓库需有 magpie-plugin 主题,见下文"让别人搜得到"）
magpie plugin add github:StrayDragon/magpie-loop-guard
# 或本地文件夹,即装即用
magpie plugin add ./magpie-loop-guard
# 应用里:Plugins → Add a plugin → 选择本文件夹

magpie plugin                                  # 确认:loop-guard (Gateway middleware)
```

装上后默认就生效（全部模型，阈值 5）。也可以发布到 npm 后 `magpie plugin add magpie-loop-guard` 安装。

## 配置

选项存在 plugins.json 里该插件的 `options`，改法：应用里 Plugins → Installed → 该中间件的 Options 按钮，或：

```sh
magpie plugin options loop-guard '{"targets":["deepseek/*"],"threshold":5}'
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `targets` | `["*"]` | 按请求的模型名（`ctx.model`）匹配，支持 `*` 通配，大小写不敏感；也接受单个字符串（等同单项列表）。magpie 的模型名是 `provider/model` 形式，所以 `"deepseek/*"` 就是"只管 DeepSeek 这个供应商"，`"*/deepseek-chat"` 是"只管这个模型"，也可以写确切全名 `"deepseek/deepseek-chat"` |
| `agents` | `[]` | 只对某些 agent 生效（如 `["claude-code"]`，也接受单个字符串）；空为全部 |
| `threshold` | `5` | 连续相同回复达到几次后，拒绝后续请求（最小按 2 算） |
| `status` | `400` | 拒绝时的 HTTP 状态码。**特意不用 429**：多数 agent 会对 429 自动退避重试，那与打断循环的目的相反 |
| `message` | 内置文案 | 自定义拒绝消息；默认文案说明次数与处理办法 |
| `mode` | `"reject"` | `"log"`：只记录不拒绝——先这样试运行几天，看日志确认不会误伤再切回 reject |
| `scan` | `500` | 最多回看多少条消息（成本上限；超出部分不参与计数） |
| `maxChars` | `4000000` | 参与比较的字符总量上限，超出按"不确定"放行 |
| `stopOnUser` | `false` | `true`：回看遇到真实用户发言就停止计数（更保守：每次都是人亲自追问的场景不触发） |
| `ignore` | `[]` | 在默认易变字段表之外，比较时额外忽略的字段名 |

示例——只保护 DeepSeek 的 deepseek-chat，重复 3 次就断，先只记录：

```sh
magpie plugin options loop-guard '{"targets":["*/deepseek-chat"],"threshold":3,"mode":"log"}'
```

## Docker 部署与界面热改配置

- **能动态改**：options 存在卷上的 `plugins.json`，网关每秒感知变化并重载——界面（`:3425` → Plugins → Installed → loop-guard → Options 的 JSON 编辑器）、CLI（`magpie plugin options magpie-loop-guard '{…}'`）、开关与卸载，全部**下一个请求即生效，无需重启**。
- **Docker/NAS 一键部署**：`deploy/` 里给了 compose + 幂等"后注入脚本"（首次自动安装并写初始 options；之后**绝不覆盖你在界面里改的配置**）。

详见 **[deploy/README.md](deploy/README.md)**。

## 被拒绝时看到什么

agent 会收到一个 400 错误（其自身 API 的错误形状）：

> loop-guard: the model has returned the same reply 5 times in a row in this session, so this request was stopped to break the loop. Start a new session or change the prompt, or raise "threshold" in this middleware's options.

解除方式：开新会话、或换个说法（历史里最新回复一变，计数自动归零——无状态设计的好处），或调高 `threshold`／关掉插件。

## 工作原理

1. `onRequest` 拿到的是 agent 发来的**完整会话**（四种 API 都含历史）。按 `ctx.protocol` 识别轮次：`anthropic`（`messages`，`tool_result` 是工具结果）、`chat`（`role:"tool"`）、`responses`（`input` 项；相邻的 `message`+`function_call`+`reasoning` 合并为一条逻辑回复）、`gemini`（`contents`，`functionResponse` 是工具结果）。识别不了的形状一律跳过、不影响计数方向。
2. 从最新一条往前走：助手回复按规范化形式（去掉易变字段后的内容，流式喂入双 32 位哈希，单碰撞不致误判）两两比较；工具结果跳过；真实用户轮默认也跳过（`stopOnUser: true` 则在此停止）。遇到第一个不同的回复就停。
3. 相同回复的连续条数 ≥ `threshold` → `ctx.reject`。因为历史里最新一条就是模型上一次的回复，被拒的正是"会产出第 N+1 次重复"的那个请求——**第 N 次重复已经付过钱，第 N+1 次不再发生**。

边界与已知限制：

- 依赖客户端回传完整历史（主流 agent 都如此）；只发增量、不带历史的客户端检测不到。
- 历史被压缩/截断后，更早的重复从请求体里消失，计数自然回落——压缩本身通常也会打断循环。
- 单条回复内部的复读（一次流式输出里同一句刷几千遍）不在本中间件范围内；它盯的是"跨轮一模一样"。
- 死循环通常每轮 id、签名、用量都不同，这是默认忽略表存在的原因；若你的供应商回复里还有别的每轮必变字段，把它们加进 `ignore`。

## 兼容性边界（刻意收窄的接触面）

插件对上游的一切依赖都是显式列出的、官方文档内的小集合；上游在这些面之外怎么变，都不影响本插件：

**对 magpie 的契约面（共 6 项，全部是插件作者文档中的公开 API）：**

- 1 个钩子：`onRequest(body, ctx)`。不用 `onProvider`/`onEvent`/`onResponse`/`strategies`/`onUsage`——这些钩子的任何变化都与本插件无关，回复路径也因此零开销。
- 5 个 ctx 字段：`protocol`、`model`、`agent`、`options`、`reject`。不读 `ctx.state`、不读任何头、不依赖 session 字段。
- 永不改写请求体：钩子只返回 `undefined`，唯一动作是 `ctx.reject`。因此请求体形状的变化不可能经由本插件弄坏请求——最坏情形是"检测不到"，绝不改变请求与回复。

**对 JS 引擎（moejs）的特性面：**

- 语言下限刻意压到 ES5 + `const`/`let`/箭头函数（magpie 官方示例中间件的同款水平）：无 `?.`/`??`/展开/模板串/类/`for...of`/`Map`/`Set`/`Symbol`/正则。
- `Math.imul` 有内联的 ES5 回退实现（引擎缺失时自动走 16 位拆分乘法）。
- 不用定时器、`fetch`、存储、`console` 之外的任何宿主能力（`console.log` 只在 `mode:"log"` 下使用，且 magpie 侧限速）。

**输入与协议漂移的容忍：**

- 未知协议：回退到通用 `messages[]` + role 启发式；未知轮次形状一律按"跳过"处理，不影响计数方向。
- 选项宽容：`targets`/`agents`/`ignore` 接受字符串或数组，`threshold` 等数值接受字符串数字，坏值一律落回默认。
- 任何"算不出来"（预算耗尽、形状怪异）都按不确定放行——与 magpie 中间件的 fail-open 语义一致：插件自身加载失败或钩子异常时，magpie 也照常放行请求，网关永远不会因本插件而不可用。

**依赖面：**

- npm 包零依赖（`dependencies` 不存在）。
- `verify/` 只有一个 Go 依赖（moejs，精确 pin），且纯属开发与 CI 工具——magpie 运行时不加载它；对 moejs API 的全部调用集中在 `verify/main.go` 一个文件里，上游改名时是一处修改。

## 让别人搜得到（magpie 的发现渠道）

按 magpie 官方文档，插件有三个被用户发现的入口，按门槛从低到高：

1. **GitHub 主题 `magpie-plugin`（已设置）** — 打上这个 topic 的仓库会出现在 magpie 的 **Plugins → Discover → Unofficial, on GitHub** 列表（按 star 排序，标注"未经审核"）。要求：`package.json` 在仓库根目录（✔）、它加载的文件已提交进仓库（✔，无构建产物）、非 fork/非 archived。
2. **发布到 npm** — `package.json` 的 `repository` 已指向本仓库，发布后 magpie 会从 npm 安装，新版本会出现在插件的更新提示里（`npm publish` 即可；社区 scope `@magpie-community/*` 属于官方社区组织，自己发布请用 `magpie-loop-guard` 这样的无 scope 名）。
3. **贡献进 [magpie-community/plugins](https://github.com/magpie-community/plugins)**（推荐，门槛最高也最正式）— 放到它的 `packages/loop-guard`，包名改为 `@magpie-community/middleware-loop-guard`。通过审核后出现在 **Plugins → Discover → Gateway middleware** 的"Ready-made middleware"列表，并且**在每个 magpie 里自动更新**，无需用户操作。

本仓库的目录与用例格式已按第 3 条的约定准备（`cases.json` 与社区仓库 `scripts/middleware.mjs` 兼容），想贡献时把文件挪过去、改个包名即可。

## 测试与 CI

同一份 `cases.json`（26 个用例）在**三种引擎**里跑，CI（`.github/workflows/ci.yml`）每次 push 都验证：

```sh
node test.mjs                                    # node(含 JSON/包元数据检查,CI 里还有 22/24 矩阵)
bun test.mjs                                     # bun
cd verify && go run . -file ../loop-guard.middleware.js -cases ../cases.json   # moejs:生产真实引擎
cd verify && go run . -bench                     # 133 KB 大请求体的单次 hook 耗时基准
```

- `verify/` 是独立的小型 Go 验证器，直接依赖 magpie 同款的 [moejs](https://github.com/Calcium-Ion/moejs) 引擎，用与网关一致的调用路径（`moejs.Compile` → `rt.Load` → `onRequest(body, ctx)`）跑同一份用例，并带 `-bench` 基准。
- 用例覆盖：四种协议的工具循环、阈值边界（4 过 / 5 断）、只有易变字段不同的两条回复算同一条、不同回复打断计数、`targets`/`agents` 匹配与不匹配、`mode:"log"`、自定义 `status`/`message`/`threshold`、`stopOnUser`、`ignore`、字符预算 fail-open、无历史/空请求体。
- CI 的 `moejs` 任务里有一条**成本红线**：大请求体的单次 hook 必须远低于 250 ms 预算（>25 ms 即失败），防止后续改动悄悄引入每请求开销。
- CI 还跑**部署资产 lint**：`shellcheck` 注入脚本、`bash -n`、`docker compose config` 校验 compose 文件。
- 红测试已验证：故意把阈值判断改坏，8+ 用例在三种引擎同时变红。

## 仓库结构

```
magpie-loop-guard/
├── loop-guard.middleware.js   # 中间件本体(唯一被 magpie 加载的文件)
├── package.json               # magpie.middleware 入口与示例选项
├── cases.json                 # 26 个用例(三种引擎共用)
├── test.mjs                   # node/bun 测试器
├── verify/                    # Go + moejs 验证器与基准(CI 的 moejs 任务)
├── deploy/                    # docker-compose + 幂等注入脚本(NAS/服务器)
├── .github/workflows/ci.yml   # node 矩阵 / bun / moejs+成本红线 / 交叉编译 / 部署资产 lint
└── README.md
```

## License

MIT
