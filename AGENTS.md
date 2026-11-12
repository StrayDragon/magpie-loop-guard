# AGENTS.md — 给编码代理的本仓库须知

改动前先读 [README.md](README.md) 的「配置」「兼容性边界」「测试与 CI」三节；本文件只写 README 没有的代理专用约定与路线规划入口。

## 仓库约定（代理容易踩的）

- 中间件本体 `loop-guard.middleware.js` 是 magpie 生产引擎（moejs）跑的，语言下限 ES5 加 const/let/箭头函数：不用 `?.`、`??`、展开、模板字符串、类、`for...of`、Map/Set/Symbol 和正则字面量。
- `cases.json` 是三种引擎（node/bun/moejs）共用的唯一用例源；加用例后 `node test.mjs`、`bun test.mjs`、`cd verify && go run . -file ../loop-guard.middleware.js -cases ../cases.json` 必须全绿才算完成，CI 另有 25 ms 成本红线（`-bench`）。
- 语义约定「配置则生效」：不写 options 就不保护任何模型。新增选项必须保持这条（未写/ null/"" = 关）。
- verify/ 的 moejs 依赖与 magpie 生产引擎同模块同版本、精确固定；升级时对照 magpie 仓库 go.mod。
- 对 magpie 契约的依赖面必须保持最小：当前仅 `onRequest` 钩子与 ctx 的 `protocol`/`model`/`agent`/`options`/`reject`，`inject` 模式依赖「onRequest 返回对象即整体替换请求体」。升级 magpie 目标版本时先在 magpie 仓库 `git log <旧>..<新> -- internal/middleware/ internal/plugin/middleware.go` 核对契约变化再动手。

## 路线规划

之后的功能路线以 [docs/PRD.md](docs/PRD.md) 为准：本文件不复制 PRD 内容，只声明它的路径与优先级顺序。当前唯一在册的路线项是 **R1 独立观测页**（插件自带 GUI 页面，脱离 magpie 内置界面看拦截/注入事件）；实现前请先读 PRD 里的「开放问题」，其中跨运行时状态通道是设计关键。
