# 在 Docker 里使用 loop-guard

面向用 [官方 Docker 镜像](https://usemagpie.ai/docs/docker)（NAS、服务器、`ghcr.io/yetone/magpie`）跑 magpie 的用户。本目录给出一套**可复制的完整做法**：compose 文件 + 一个幂等的"后注入脚本"，装完之后的一切配置都在网页界面里改，不需要再进容器。

## 官方镜像里有什么（指引依据）

| 事实 | 值 | 对你的意义 |
| --- | --- | --- |
| 镜像 | `ghcr.io/yetone/magpie`（debian-slim，非 root uid 65532） | 挂载进容器的文件要对 65532 可读（默认权限即可） |
| 配置目录 | `XDG_CONFIG_HOME=/config`，即 **`/config/magpie/`** | `plugins.json`、已装插件全在这里；`/config` 是卷，**重启/升级不丢** |
| 端口 | 3425（网关 API + 网页 UI）、3430 | 浏览器开 3425 就能进 Plugins 页 |
| 命令 | `magpie` 在 PATH；`ENTRYPOINT /magpie`，`CMD serve` | `docker compose exec magpie magpie …` 可直接用 CLI |
| 健康检查 | `magpie healthcheck`（镜像自带） | compose 可以用它编排注入时机 |

## 快速开始

```sh
git clone https://github.com/StrayDragon/magpie-loop-guard.git
cd magpie-loop-guard
docker compose -f deploy/docker-compose.yml up -d
```

就这些。之后浏览器打开 `http://<主机>:3425` → **Plugins**，能看到 loop-guard（Gateway middleware）卡片。

**发生了什么**：compose 把本仓库以只读方式挂到容器的 `/config/magpie-loop-guard`；`installer` 是一个 one-shot 服务（`restart: "no"`），等 magpie 健康后执行 `deploy/install-loop-guard.sh`：

- 未安装 → `magpie plugin add /config/magpie-loop-guard`，并（若设置了 `LOOPGUARD_OPTIONS`）写入一次初始 options——示例里特意用 `"mode":"log"`，先只记录不拦截，观察几天日志再在界面切成 `reject`
- 已安装 → **什么都不做**。你后来在界面里改过的 options 原样保留（与 magpie "默认绝不覆盖用户设置"的准则一致；确要重设给脚本 `FORCE=1`）
- 网关在运行中约 1 秒内感知 `plugins.json` 变化并装载中间件，**不需要重启任何容器**；脚本本身也从不重启容器

不想用 installer 服务的话，手动一次也行：

```sh
docker compose -f deploy/docker-compose.yml exec magpie bash \
  /config/magpie-loop-guard/deploy/install-loop-guard.sh
```

> 注：首次 `plugin add` 可能会下载 Bun（官方镜像带齐了它需要的 glibc 库），下载后缓存在 `/config/cache`，随卷持久——之后离线重启也没问题。本插件是纯中间件包，不需要 npm 依赖。

## 能不能在界面动态修改配置？——能，这是推荐方式

magpie 的中间件 options 不是"启动时读一次"的静态文件，改完即热生效：

| 方式 | 操作 | 生效时机 |
| --- | --- | --- |
| **网页 UI（推荐）** | 浏览器开 `:3425` → **Plugins → Installed** → loop-guard 卡片 → **Options** → JSON 编辑器保存 | 下一个请求起（配置变更 ≤1s 被网关重载） |
| CLI | `docker compose -f deploy/docker-compose.yml exec magpie magpie plugin options magpie-loop-guard '{"threshold":8}'` | 同上 |
| 开关/卸载 | 同一个卡片上的开关与 Remove | 同上 |
| 改源码 | 中间件文件变了（挂载目录里改）也被 stamp 检测热重载 | 同上 |

机制，一句话：**options 存在卷上的 `/config/magpie/plugins.json`**，网关每秒看一次"plugins.json + 中间件文件"的戳，变了就重编译重装载，每个请求拿到的都是最新 options——所以**改配置永远不需要重启容器或重建卷**。可改的项（`targets`/`threshold`/`mode`/`status`…）见[主 README 的配置表](../README.md#配置)。

## 常见问题

- **怎么确认装上了/生效了？** 界面卡片显示 `onRequest` 钩子、调用数与平均耗时；`docker compose exec magpie magpie plugin` 列出已装插件；`mode:"log"` 阶段看 magpie 日志里的 `loop-guard: … repeated the same reply …` 行。
- **升级插件**：仓库只读挂载 → `git pull` 后文件变化被热重载，无需其他操作。
- **卸载**：Plugins → Installed → Remove（写入 plugins.json，立即生效）；卷上的其余内容不动。
- **NAS（群晖/Unraid）**：同样的两个挂载（`/config` 卷 + 本仓库只读）+ 一次性执行注入脚本即可；群晖的容器界面支持设置启动后命令，等价于 installer 服务。
