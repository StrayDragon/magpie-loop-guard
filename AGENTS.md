# AGENTS.md — 给编码代理的本仓库须知

改动前先读 [README.md](README.md) 的「配置」「兼容性边界」「测试与 CI」三节；本文件只写 README 没有的代理专用约定与路线规划入口。

## 仓库约定（代理容易踩的）

- 中间件本体 `loop-guard.middleware.js` 是 magpie 生产引擎（moejs）跑的，语言下限 ES5 加 const/let/箭头函数：不用 `?.`、`??`、展开、模板字符串、类、`for...of`、Map/Set/Symbol 和正则字面量。
- `cases.json` 是三种引擎（node/bun/moejs）共用的唯一用例源；加用例后 `node test.mjs`、`bun test.mjs`、`cd verify && go run . -file ../loop-guard.middleware.js -cases ../cases.json` 必须全绿才算完成，CI 另有 25 ms 成本红线（`-bench`）。
- 语义约定「配置则生效」：不写 options 就不保护任何模型。新增选项必须保持这条（未写/ null/"" = 关）。
- verify/ 的 moejs 依赖与 magpie 生产引擎同模块同版本、精确固定；升级时对照 magpie 仓库 go.mod。
- 对 magpie 契约的依赖面必须保持最小：中间件侧仅 `onRequest` 与 ctx 的 `protocol`/`model`/`agent`/`options`/`reject`（`inject` 依赖「onRequest 返回对象即整体替换请求体」）；Bun 侧仅 `magpie.hooks` 的 `onRequest` 与 ctx 的 `model`/`protocol`/`agent`/`session`/`kind`/`origin`/`options`；页面仅 `magpie.page` + `magpie.page.service`。升级 magpie 目标版本时先在 magpie 仓库 `git log <旧>..<新> -- internal/middleware/ internal/plugin/middleware.go internal/plugin/gateway.go internal/plugin/page.go internal/gui/pluginpage.go` 核对契约变化再动手。
- 判定只能有一处：中间件的 `decide()`。新增观测、页面或任何消费方都通过导出的 `inspect()` 读，不得重写一份判定逻辑，否则「报告的事件」与「实际的处置」会分岐。
- `test.hooks.mjs` 覆盖 Bun 侧记录行为（命中才写、不改请求、字段均正确），`node` 与 `bun` 都必须全绿。

## 路线规划

之后的功能路线以 [docs/PRD.md](docs/PRD.md) 为准：本文件不复制 PRD 内容，只声明它的路径与优先级顺序。

**R1 独立观测页（已完成）**：插件已自带页面。实测结论（当前 magpie）：

- 页面沙箱是 `connect-src 'none'`，窗口里的页面不能 fetch，因此页面必须从插件自己的服务打开（`magpie.page.service`），走 `magpie.service` 给的地址。
- 桌面窗口不代理这个服务（`pageServiceRoutes` 只在 `web` 下注册），只有 `magpie web` 可用。
- 中间件（moejs）除 `console` 外无 IO 能力，不能作为事件源；Bun hooks 能写文件，是唯一可行的事件源。
- Bun hooks 不能 reject，所以拦截仍由中间件负责，hooks 只观测。
