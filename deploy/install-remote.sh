#!/usr/bin/env bash
# install-remote.sh — 不 clone 仓库,一条命令把 loop-guard 装进正在运行的
# magpie 官方 Docker 容器(ghcr.io/yetone/magpie)。
#
#   curl -fsSL https://raw.githubusercontent.com/StrayDragon/magpie-loop-guard/main/deploy/install-remote.sh -o install-remote.sh
#   bash install-remote.sh                 # 交互式:选卷映射方式
#   bash install-remote.sh --method copy   # 免改 compose:文件直接进 /config 卷
#   bash install-remote.sh --method bind   # 文件留在宿主机,bind-mount 进容器
#
# 两种 volume 映射方式的取舍:
#   copy — 文件落在容器 /config 卷里。不改 compose、不重启容器;随卷持久
#          (容器删除重建都在),换卷/清卷后重跑本脚本即可。升级=重跑。
#   bind — 文件留在宿主机目录,以只读方式挂进容器。文件由 git/你自己管理,
#          但挂载需要在 compose 里加一行 volumes 并重建容器才生效。
#
# 幂等:重复运行安全;真正的安装由仓库内的 deploy/install-loop-guard.sh
# 在容器里完成,它绝不覆盖你在 magpie 网页界面里改过的 options。

set -euo pipefail

REPO="${REPO:-StrayDragon/magpie-loop-guard}"
REF="${REF:-main}"
RAW_BASE="https://raw.githubusercontent.com/${REPO}/${REF}"
MIRROR="${MIRROR:-}" # 中国大陆等场景的 raw 加速前缀,如 --mirror https://ghproxy.net/
CONTAINER=""
METHOD=""
DIR=""
OPTIONS='{"targets":["*"],"threshold":5,"mode":"log"}'
CDIR="/config/magpie-loop-guard" # 容器内插件目录(/config 是官方镜像的数据卷)
TMP_DOWNLOAD="" # copy 方式的临时下载目录;EXIT 清理(trap 看不到函数局部变量)
FILES=("loop-guard.middleware.js" "package.json" "deploy/install-loop-guard.sh")

usage() { sed -n '2,20p' "$0"; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m | --method) METHOD="$2"; shift 2 ;;
    -c | --container) CONTAINER="$2"; shift 2 ;;
    -d | --dir) DIR="$2"; shift 2 ;;
    -o | --options) OPTIONS="$2"; shift 2 ;;
    --mirror) MIRROR="$2"; shift 2 ;;
    --ref) REF="$2"; RAW_BASE="https://raw.githubusercontent.com/${REPO}/${REF}"; shift ;;
    -h | --help) usage ;;
    *) echo "未知参数: $1(--help 看用法)" >&2; exit 1 ;;
  esac
done

say() { echo "install-remote: $*"; }
cleanup() { [[ -n "${TMP_DOWNLOAD:-}" ]] && rm -rf "$TMP_DOWNLOAD"; }
trap cleanup EXIT
die() { echo "install-remote: $*" >&2; exit 1; }

command -v docker >/dev/null || die "需要 docker 命令"
command -v curl >/dev/null || die "需要 curl 命令(或用 --mirror 走可用的加速镜像)"

# ---- 找到正在运行的 magpie 容器 --------------------------------------------
pick_container() {
  if [[ -n "$CONTAINER" ]]; then
    docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" ||
      die "容器 $CONTAINER 不在运行(docker ps 确认,或用 -c 指定)"
    return
  fi
  local list
  list=$(docker ps --filter "ancestor=ghcr.io/yetone/magpie" --format '{{.Names}}')
  [[ -n "$list" ]] || list=$(docker ps --format '{{.Names}}' | grep -i magpie || true)
  [[ -n "$list" ]] || die "没找到运行中的 magpie 容器。先启动它,或用 -c 容器名指定"
  if [[ $(echo "$list" | wc -l) -gt 1 ]]; then
    echo "找到多个 magpie 容器: $list" >&2
    die "用 -c 容器名 指定一个"
  fi
  CONTAINER="$list"
  say "目标容器: $CONTAINER"
}

# ---- 下载(支持 --mirror 前缀加速) ------------------------------------------
fetch() { curl -fsSL "${MIRROR}${1}" -o "$2" || die "下载失败: ${MIRROR}${1}(网络不通可加 --mirror 前缀)"; }

download_into() {
  local dest="$1" f
  mkdir -p "$dest/deploy"
  for f in "${FILES[@]}"; do
    say "下载 $f"
    fetch "$RAW_BASE/$f" "$dest/$f"
  done
}

# ---- 交互选择方式 -----------------------------------------------------------
choose_method() {
  local a
  if [[ -n "$METHOD" ]]; then return; fi
  echo "选择插件文件的 volume 映射方式:"
  echo "  1) copy — 复制进容器 /config 卷(默认;不改 compose、不重启容器,随卷持久)"
  echo "  2) bind — 宿主机目录只读挂载(文件留在宿主机;需在 compose 加一行 volumes 并重建容器)"
  read -rp "方式 [1/2,回车=1]: " a
  case "$a" in 2) METHOD="bind" ;; *) METHOD="copy" ;; esac
}

# ---- 方式一:复制进 /config 卷 -----------------------------------------------
install_by_copy() {
  TMP_DOWNLOAD=$(mktemp -d)
  local tmp="$TMP_DOWNLOAD"
  download_into "$tmp"
  say "复制文件到 $CONTAINER:$CDIR"
  docker exec "$CONTAINER" mkdir -p "$CDIR/deploy"
  docker cp "$tmp/loop-guard.middleware.js" "$CONTAINER:$CDIR/loop-guard.middleware.js"
  docker cp "$tmp/package.json" "$CONTAINER:$CDIR/package.json"
  docker cp "$tmp/deploy/install-loop-guard.sh" "$CONTAINER:$CDIR/deploy/install-loop-guard.sh"
  docker exec -u 0 "$CONTAINER" chown -R 65532:65532 "$CDIR" 2>/dev/null || true
  say "在容器内执行安装(幂等,不覆盖界面改过的 options)"
  docker exec -e LOOPGUARD_OPTIONS="$OPTIONS" -i "$CONTAINER" bash -s <"$tmp/deploy/install-loop-guard.sh"
}

# ---- 方式二:宿主机目录 bind-mount -------------------------------------------
install_by_bind() {
  DIR="${DIR:-$PWD/magpie-loop-guard}"
  download_into "$DIR"
  say "文件已就绪: $DIR"
  if docker exec "$CONTAINER" grep -qs "$CDIR" /proc/mounts; then
    say "检测到挂载已生效,继续安装"
  else
    cat <<EOF

还差一步:把宿主机目录挂进容器。在 magpie 的 compose 文件里该服务下加:

    volumes:
      - $DIR:$CDIR:ro

然后 docker compose up -d 重建容器(挂载要重建才生效),再重跑本脚本;
脚本会检测到挂载并完成安装。(如果 magpie 就是用本仓库 deploy/ 下的
compose 起的,这一步已经配好,直接重跑即可。)
EOF
    exit 0
  fi
  say "在容器内执行安装(幂等,不覆盖界面改过的 options)"
  docker exec -e LOOPGUARD_OPTIONS="$OPTIONS" -i "$CONTAINER" bash -s <"$DIR/deploy/install-loop-guard.sh"
}

# ---- 验证 -------------------------------------------------------------------
verify() {
  say "验证:"
  docker exec "$CONTAINER" magpie plugin | grep -i loop-guard ||
    die "安装后没有在 magpie plugin 列表里看到 loop-guard"
  echo "  ✓ magpie plugin 列出了 loop-guard"
  echo "  打开 http://<主机>:3425 → Plugins → Installed → loop-guard"
  echo "  首次建议先用 mode:\"log\" 观察日志,再在界面里切成 reject"
}

pick_container
choose_method
case "$METHOD" in
  copy) install_by_copy ;;
  bind) install_by_bind ;;
  *) die "--method 只接受 copy 或 bind" ;;
esac
verify
