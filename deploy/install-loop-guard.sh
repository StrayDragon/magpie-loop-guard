#!/bin/bash
# install-loop-guard.sh — 在 magpie 容器内幂等地安装 loop-guard 中间件。
#
# 设计原则与 magpie 自己的一致:绝不覆盖用户已设置的值。
#   - 已安装(plugins.json 里有本插件) → 什么都不做:你后来在界面/CLI 里
#     改过的 options 原样保留。
#   - 未安装 → magpie plugin add <文件夹>, 然后仅当设置了 LOOPGUARD_OPTIONS
#     才写入一次初始 options。
#   - FORCE=1 时重设 options(明确要求覆盖才覆盖)。
#
# 网关在运行中就会感知 plugins.json 的变化(约 1 秒内重载)并装载中间件,
# 因此本脚本不需要、也不应该重启容器。

set -euo pipefail

PJ="${XDG_CONFIG_HOME:-/config}/magpie/plugins.json"
DIR="${LOOPGUARD_DIR:-/config/magpie-loop-guard}"
OPTS="${LOOPGUARD_OPTIONS:-}"

if [[ ! -f "$DIR/loop-guard.middleware.js" ]]; then
  echo "loop-guard: 插件文件夹不在 $DIR — 检查 compose 对本仓库的挂载" >&2
  exit 1
fi

if [[ -f "$PJ" ]] && grep -q 'magpie-loop-guard' "$PJ"; then
  echo "loop-guard: 已安装,跳过(你改过的 options 不会被覆盖)"
  if [[ "${FORCE:-}" == "1" && -n "$OPTS" ]]; then
    magpie plugin options magpie-loop-guard "$OPTS"
    echo "loop-guard: FORCE=1,options 已重设"
  fi
  exit 0
fi

magpie plugin add "$DIR"
echo "loop-guard: 已安装"
if [[ -n "$OPTS" ]]; then
  magpie plugin options magpie-loop-guard "$OPTS"
  echo "loop-guard: 初始 options 已写入"
fi
