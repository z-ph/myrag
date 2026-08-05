#!/usr/bin/env bash
#
# 轮询式自动部署：git fetch 对比远端 main，有新提交则构建重启，健康检查失败自动回滚。
# 由 systemd timer / cron 周期性调用（配合 myrag-auto-deploy.timer）。
#
# 部署机一次性配置：
#   1. 安装 git、docker + compose 插件
#   2. 仓库凭据（HTTPS 私有仓库，任选其一）：
#      - git config credential.helper store   # 首次手动 pull 时输入账号/token
#      - git remote set-url origin git@<host>:cwc-admin/zph-rag.git   # SSH 部署密钥
#   3. 服务器 .env 按环境配置好（.env 被 gitignore，部署过程不会覆盖）
#   4. systemctl enable --now myrag-auto-deploy.timer
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-main}"

LOG_FILE="${LOG_FILE:-$REPO_DIR/deploy/deploy.log}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"     # 30 × 5s = 150s 等待上限
HEALTH_INTERVAL="${HEALTH_INTERVAL:-5}"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG_FILE"; }

# 并发保护：timer 与手动执行重叠时直接退出
exec 9>/tmp/myrag-deploy.lock
flock -n 9 || { echo "another deploy in progress, skip"; exit 0; }

# 无凭据时快速失败，避免 git 交互式挂起等超时
export GIT_TERMINAL_PROMPT=0

# 健康检查地址：读 .env 的 SERVER_HOST_PORT（缺省 8808，与 compose 默认一致）
host_port="$(sed -n 's/^SERVER_HOST_PORT=//p' "$REPO_DIR/.env" 2>/dev/null | head -1)"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${host_port:-8808}/health}"

cd "$REPO_DIR"

# 1. 轮询：对比远端 HEAD
before="$(git rev-parse HEAD)"
if ! git fetch --quiet "$REMOTE" "$BRANCH"; then
  log "git fetch failed（网络/凭据问题），skip"
  exit 1
fi
after="$(git rev-parse FETCH_HEAD)"
if [ "$before" = "$after" ]; then
  exit 0   # 无更新
fi
log "update found: ${before:0:8} -> ${after:0:8}"

# 2. 快速前进；拒绝非 ff（说明部署机有本地漂移，需人工处理）
if ! git merge --ff-only FETCH_HEAD; then
  log "not fast-forward，abort（部署 checkout 应保持纯净）"
  exit 1
fi

# 3. 构建并启动（镜像层缓存，无变化部分秒过；.env 不受影响）
if ! docker compose up -d --build; then
  log "build/up failed，回滚到 ${before:0:8}"
  git reset --hard "$before"
  docker compose up -d --build || log "回滚构建失败，需要人工介入"
  exit 1
fi

# 4. 健康检查，失败回滚
for _ in $(seq 1 "$HEALTH_RETRIES"); do
  if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
    log "deployed ${after:0:8}，health OK"
    exit 0
  fi
  sleep "$HEALTH_INTERVAL"
done

log "health check 失败，回滚到 ${before:0:8}"
git reset --hard "$before"
if ! docker compose up -d --build; then
  log "回滚构建失败，需要人工介入"
  exit 1
fi
if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
  log "回滚完成（${before:0:8}），health OK"
  exit 1
fi
log "回滚后 health check 仍失败，需要人工介入"
exit 1
