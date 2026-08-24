#!/usr/bin/env bash
# 每日备份（开发文档 §16）：SQLite / secrets.enc / 数据目录，保留 7 天
set -euo pipefail

DATA_DIR="${DATA_DIR:-/root/AI工作台/data}"
BACKUP_DIR="${BACKUP_DIR:-/root/backups/workbench}"
KEEP_DAYS="${KEEP_DAYS:-7}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
TAR="$BACKUP_DIR/workbench-$STAMP.tar.gz"

tar -czf "$TAR" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
find "$BACKUP_DIR" -name 'workbench-*.tar.gz' -mtime "+$KEEP_DAYS" -delete
echo "backup ok: $TAR"
