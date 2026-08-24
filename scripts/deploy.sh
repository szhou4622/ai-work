#!/usr/bin/env bash
# AI 工作台部署脚本（开发文档 §16）
# 用法: ./scripts/deploy.sh [服务器用户@IP]
set -euo pipefail

REMOTE="${1:-root@118.196.92.95}"
REMOTE_DIR="/root/AI工作台"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> 同步源码到 $REMOTE:$REMOTE_DIR"
rsync -az --delete \
  --exclude node_modules --exclude data --exclude dist \
  --exclude .npm-cache --exclude '*.docx' --exclude .DS_Store \
  "$LOCAL_DIR/" "$REMOTE:$REMOTE_DIR/"

echo "==> 服务器安装依赖并构建"
ssh "$REMOTE" "cd $REMOTE_DIR && npm install --cache \"\$PWD/.npm-cache\" && npm run build"

echo "==> 重启服务"
ssh "$REMOTE" "systemctl restart workbench && sleep 2 && systemctl is-active workbench"

echo "==> 健康检查"
ssh "$REMOTE" "curl -fsS http://127.0.0.1:8620/healthz"
echo
echo "部署完成"
