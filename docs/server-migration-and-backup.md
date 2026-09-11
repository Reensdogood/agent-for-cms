# 서버 이전·설치·DB 마이그레이션 및 백업 (Phase 2)

## 운영 구성

- 프로젝트: `/data/gwanak-agent`
- Docker Compose 서비스: `app` (내부 4170, 호스트 4171), 필요 시 nginx/Caddy reverse proxy
- SQLite DB: Docker volume 내부 `/data/funnet.db`
- 릴리스 파일: `/data/releases`
- 비밀값: 프로젝트의 `.env`로 관리하며 Git에 커밋하지 않는다.

## 신규 서버 설치

1. Docker Engine과 Compose plugin을 설치한다.
2. 저장소를 `/data/gwanak-agent`에 배치한다.
3. `deploy/.env.example`을 `.env`로 복사하고 관리자 비밀번호·등록 키·도메인을 입력한다.
4. `docker compose up -d --build app`을 실행한다.
5. `curl http://127.0.0.1:4171/healthz`가 `ok:true`인지 확인한다.
6. 외부 공개가 필요하면 nginx/Caddy에서 HTTPS를 종료하고 내부 4170으로 프록시한다. 내부망은 호스트 4171을 사용한다.

## DB 마이그레이션

1. 기존 서버에서 먼저 `scripts/backup-server.sh`를 실행해 DB와 릴리스 백업을 만든다.
2. 기존 Docker volume을 삭제하지 않는다. SQLite 파일을 `VACUUM INTO`로 복제한 스냅샷만 이동한다.
3. 새 서버의 컨테이너를 중지한 뒤 `/data/funnet.db`를 복원하고 `/data/releases`를 복원한다.
4. 파일 소유자를 컨테이너 실행 사용자(node)에 맞춘다.
5. `docker compose up -d` 후 `/healthz`, 로그인, 장비 목록, 명령 큐, 릴리스 목록을 확인한다.
6. 검증 전 기존 서버와 DB를 삭제하거나 DNS를 전환하지 않는다. 문제 발생 시 기존 서버로 즉시 되돌린다.

DB에는 사용자·지역·장비·명령·감사 로그가 함께 있으므로 빈 DB로 재기동하거나 `.env`만 옮기는 방식은 금지한다.

## 주 1회 백업

스크립트: `scripts/backup-server.sh`

기본 백업 위치는 `/data/gwanak-agent-backups`이며 `FUNNET_BACKUP_DIR`로 별도 디스크/네트워크 경로를 지정할 수 있다.

예시 cron(매주 일요일 03:00):

```cron
0 3 * * 0 FUNNET_BACKUP_DIR=/backup/funnet /data/gwanak-agent/scripts/backup-server.sh >> /var/log/funnet-backup.log 2>&1
```

백업에는 SQLite 일관 스냅샷, 최근 8일 컨테이너 로그, 릴리스 보관본이 포함된다. 자동 삭제는 하지 않으므로 보존 정책과 오프사이트 복제는 운영자가 별도로 정한다. 복구 리허설은 분기 1회 권장한다.

## 운영 안전 규칙

- 운영 컨테이너·DB 볼륨·릴리스 디렉터리를 개발 정리 대상으로 취급하지 않는다.
- 서버 업데이트는 파일 교체 후 `docker compose up -d --build app`만 수행한다.
- DB 스키마 변경은 백업과 호환성 검증 후 별도 migration으로 추가한다.
- Agent 업데이트 릴리스 정리와 UME 릴리스 정리를 혼동하지 않는다.
