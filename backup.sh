#!/bin/bash
set -e

DATE=$(date +%Y-%m-%d_%H-%M)
BACKUP_DIR="/home/ubuntu/backups"
REMOTE="gdrive:grade"
DB_SRC="/home/ubuntu/grade/grades.db"
KEEP_DAYS=7

mkdir -p "$BACKUP_DIR"

DEST="$BACKUP_DIR/grades_${DATE}.db"
cp "$DB_SRC" "$DEST"
echo "[backup] Copie locale : $DEST"

rclone copy "$DEST" "$REMOTE/" --log-level ERROR
echo "[backup] Upload Drive OK"

find "$BACKUP_DIR" -name "grades_*.db" -mtime +${KEEP_DAYS} -delete
echo "[backup] Nettoyage local OK"

