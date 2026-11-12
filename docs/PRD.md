# PRD — loop-guard 路线规划

状态：草稿。路线项按优先级排列；每项含目标、机制选项与开放问题。实现前先在 magpie 仓库核对当版契约（见仓库 AGENTS.md）。

## R1 独立观测页（未开始）

**一句话**：loop-guard 自带一个 GUI 页面，不用翻 magpie 内置界面就能观测它拦了什么、注了什么。

### 背景与目标

- 现状痛点：拦截/注入事件的唯一观测途径是 magpie 网关日志（`docker compose logs magpie | grep loop-guard`），NAS/服务器场景要先 ssh 再翻日志，且没有按模型/按类型的聚合视图。
- 目标（按优先级）：
  1. 事件流：最近 N 条拦截/注入事件（时间、模型、触发类型 = 碎片复读/跨轮循环、处置 = inject/reject/log、命中预设名、注入的 prompt 摘要）。
  2. 聚合视图：按模型 × 处置类型的计数（今天/7 天）。
  3. 便捷操作：页面上直接改当前生效的 options（表单化 preset 的五个字段：name/targets/fragment/mode/prompt），保存走既有 options API 热生效。
- 非目标：不改写 magpie 内置界面；不做多网关聚合。

### 机制选项

- **M-A 插件自带 page（倾向）**：把 loop-guard 从"纯中间件包"升级为完整插件（`package.json` 加 main/exports + `magpie.page`），宿主页面服务见 magpie `internal/plugin/page.go`。页面是插件自己画的前端，表单自由。
- **M-B 等上游 schema**：magpie 若实现 `magpie.optionsSchema` 表单渲染，只解决"配置表单化"，解决不了事件观测。作为 R1 的降级替代。

### 开放问题（实现前必须回答）

1. **跨运行时状态通道**（关键）：中间件跑在网关进程内的 moejs，页面服务跑在 Bun 宿主，两者无共享内存。事件数据怎么从 moejs 侧到达页面？候选：a) 中间件把事件编码进 `console.log` 结构化行，页面侧无 API 可读日志（待验证）；b) 网关是否有可注册的回写端点（待核对 internal/middleware/ 是否给中间件任何存储/HTTP 面）；c) 退而求其次：页面只做"options 表单编辑器 + 说明文案"，事件流继续走日志（最小可用版）。实现顺序大概率 c → a/b。
2. **宿主引入 Bun 依赖**：完整插件要宿主跑（Bun），当前 tufa 已有 Bun 缓存，但插件会失去"零依赖纯中间件"的卖点；package.json 需保留 magpie.middleware 字段兼容纯中间件安装路径。
3. **页面鉴权与作用域**：page 是否天然复用 Web 界面登录态（待核对 page.go）；写 options 的操作应与 GUI Options 按钮同权限。
4. **事件容量**：若走内存环形缓冲，上限（建议最近 500 条）与多会话并发写入的竞态。
