#!/usr/bin/env bash
# 一键发布到服务器：构建镜像 → 服务器端 relayctl 备份数据并切换，失败自动恢复。
#
#   scripts/deploy.sh              发布当前工作区（含未提交改动，tag 会带 -dirty）
#   scripts/deploy.sh rollback     回到上一次发布前的版本和数据
#   scripts/deploy.sh status       查看服务器上的版本与备份
#   scripts/deploy.sh logs [n]     查看服务器日志
#
# 配置在 deploy/target.env（参考 deploy/target.env.example）：
#   DEPLOY_HOST   ssh 目标，例如 ubuntu@1.2.3.4（必填）
#   DEPLOY_DIR    服务器部署目录，默认 /opt/webhook-relay
#   DEPLOY_BUILD  remote（默认，上传源码在服务器构建）或 local（本机构建后传镜像）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=/dev/null
[[ -f deploy/target.env ]] && source deploy/target.env
HOST="${DEPLOY_HOST:?请在 deploy/target.env 设置 DEPLOY_HOST，例如 ubuntu@1.2.3.4}"
DIR="${DEPLOY_DIR:-/opt/webhook-relay}"
BUILD="${DEPLOY_BUILD:-remote}"
PLATFORM="${DEPLOY_PLATFORM:-linux/arm64}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
tarc() { COPYFILE_DISABLE=1 tar --no-xattrs "$@"; }
# shellcheck disable=SC2029  # 有意在本地展开 DIR
rsh() { ssh "$HOST" "$@"; }

sync_files() {
  tarc -C deploy -cf - compose.yaml relayctl | rsh "sudo tar -C '$DIR' -xf - --no-same-owner"
}

deploy() {
  local rev dirty="" tag labels
  rev="$(git rev-parse --short HEAD)"
  if [[ -n "$(git status --porcelain)" ]]; then
    dirty="-dirty"
    log "工作区有未提交的改动，镜像 tag 标记为 dirty"
  fi
  tag="$(date +%Y%m%d-%H%M%S)-$rev$dirty"
  labels="--label org.opencontainers.image.revision=$(git rev-parse HEAD)$dirty --label org.opencontainers.image.source=https://github.com/FooFishes/webhook-relay"

  if [[ $BUILD == local ]]; then
    log "本机构建 webhook-relay:$tag ($PLATFORM)"
    # shellcheck disable=SC2086
    docker build --platform "$PLATFORM" $labels -t "webhook-relay:$tag" .
    log "传输镜像到 $HOST"
    docker save "webhook-relay:$tag" | gzip -1 | rsh 'gunzip | sudo docker load' >/dev/null
  else
    log "上传源码到 $HOST:$DIR/src"
    rsh "sudo rm -rf '$DIR/src' && sudo mkdir -p '$DIR/src'"
    # 已跟踪 + 未忽略的新文件，跳过工作区中已删除的文件
    git ls-files -co --exclude-standard | while IFS= read -r f; do [[ -e $f ]] && printf '%s\n' "$f"; done |
      tarc -cf - -T - | rsh "sudo tar -C '$DIR/src' -xf - --no-same-owner"
    log "服务器构建 webhook-relay:$tag"
    rsh "sudo docker build $labels -t 'webhook-relay:$tag' '$DIR/src'"
  fi

  sync_files
  rsh "sudo '$DIR/relayctl' deploy '$tag'"
}

case "${1:-deploy}" in
  deploy) deploy ;;
  rollback | status) sync_files; rsh "sudo '$DIR/relayctl' $1" ;;
  logs) rsh "sudo '$DIR/relayctl' logs '${2:-200}'" ;;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
