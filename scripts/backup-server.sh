#!/usr/bin/env bash
set -euo pipefail

# 운영 서버에서 실행한다. 기본 경로는 별도 디스크로 바꾸도록 환경변수로 노출한다.
BACKUP_ROOT="${FUNNET_BACKUP_DIR:-/data/gwanak-agent-backups}"
PROJECT_DIR="${FUNNET_PROJECT_DIR:-/data/gwanak-agent}"
CONTAINER="${FUNNET_APP_CONTAINER:-gwanak-agent-app-1}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_ROOT/$STAMP"
mkdir -p "$DEST"

# DB는 SQLite 온라인 백업 API로 일관된 스냅샷을 만든다. 원본 DB를 중지하거나 이동하지 않는다.
docker exec "$CONTAINER" node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync('/data/funnet.db'); db.exec(\"VACUUM INTO '/data/backup-${STAMP}.db'\");"
docker cp "$CONTAINER:/data/backup-${STAMP}.db" "$DEST/funnet.db"
docker exec "$CONTAINER" rm -f "/data/backup-${STAMP}.db"
docker cp "$CONTAINER:/data/releases" "$DEST/releases"

# 릴리스 파일과 컨테이너 로그를 함께 보관한다.
if [ -d "$PROJECT_DIR" ]; then cp "$PROJECT_DIR/.env" "$DEST/.env" 2>/dev/null || true; fi
docker logs --since 8d "$CONTAINER" > "$DEST/app.log" 2>&1 || true
tar -czf "$DEST/funnet-backup.tar.gz" -C "$DEST" funnet.db app.log releases
rm -rf "$DEST/funnet.db" "$DEST/app.log" "$DEST/releases"

# 12주보다 오래된 백업은 자동 삭제하지 않는다. 보존 기간은 운영자가 별도로 결정한다.
echo "Backup created: $DEST"
