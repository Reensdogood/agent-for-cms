# Phase 2 개발 기준서

이 문서는 UME global 통합관리 PoC의 Phase 2 현재 구현을 고정하는 기준 문서다. 다음 세션에서 기능을 수정하거나 고도화할 때에는 이 문서를 먼저 읽고, 이미 해결한 문제를 다시 구현하지 않는다.

## 1. 현재 구성

- Windows Agent: .NET 8, self-contained `win-x64`, 트레이 상주 프로세스
- 서버: Node.js 24 + `node:sqlite`, Docker Compose, nginx는 외부 HTTPS를 종료하고 내부 4170으로 프록시
- 운영 서버 작업 위치: `/data/gwanak-agent`
- 운영 데이터: Docker 볼륨의 `/data/funnet.db`, 릴리스 파일은 `/data/releases`
- 최신 운영 Agent: **1.3.3** (`dist-windows-control-1.3.3`)
- 최신 Agent는 Windows 종료 제어, 지연 응답 HDMI 검증, 중복 실행 무음 종료를 포함한다.

## 2. Phase 2 기능 범위

- 장비 등록/승인, 지역 키, 장비별 지역 권한
- 역할별 메뉴/API 권한: 전체 시스템, 운영, 지역 관리자, 시스템 관리자
- Agent heartbeat/health probe, Agent·UME·i-vision·OS 상태 표시
- UME 배포와 Agent 업데이트 배포를 분리한 릴리스 관리
- Agent 릴리스 신규 등록 시 이전 Agent 릴리스와 대기 명령 자동 정리
- TV 제어: 전원 ON/OFF, HDMI1/HDMI2, 볼륨, 실제 상태 조회
- I-Vision 제어: 종료/재실행 및 전체·개별 제어
- Windows 제어: 개별·전체 Windows 종료(확인 팝업 필수, 온라인 승인 장비만)
- 스케줄: 지역 선택, 전체 지역, TV 제어와 I-Vision 제어 분리
- 대시보드/장비관리 지역 필터
- 실제 TV 조회값과 마지막 서버 명령값을 구분하는 상태 구조

## 3. Samsung MDC 프로토콜 고정값

프로토콜을 다시 조사하지 말고 아래 구현과 P2 문서를 기준으로 한다.

| 항목 | 값 |
|---|---|
| 헤더 | `0xAA` |
| Power 명령 | `0x11` |
| Volume 명령 | `0x12` |
| Input 명령 | `0x14` |
| HDMI1 | `0x21` |
| HDMI2 | `0x23` |
| 기본 Display ID | `0x00` |
| ACK/NAK | `0x41` / `0x4E` |

응답은 checksum, display ID, 명령 byte, ACK/NAK를 모두 검증한다. 지원 입력은 P2 범위인 HDMI1/HDMI2만 유지한다. Brightness는 공식 확인 불가로 SKIP한다.

## 4. TV 상태 처리 규칙

- Agent의 `display.status`는 전원·입력·볼륨을 항목별로 조회하고 각 항목을 2회 재시도한다.
- 한 항목이 실패해도 전체를 실패로 버리지 않고 `partial`, `errors`, `connection`을 반환한다.
- `connection`: `connected`, `standby`, `timeout`을 구분한다.
- HDMI 전환 후 ACK/검증 응답이 늦으면 500ms 후 실제 입력을 재조회한다. 목표값이면 `confirmed_after_delayed_response`로 성공 처리한다.
- 서버 GET 상태 조회는 **가장 최근 완료된 `display.status` 한 건만** 반영한다. 과거 상태 결과가 최신값을 덮어쓰면 안 된다.
- 서버는 장비 heartbeat의 display 설정과 실제 조회 결과를 혼동하지 않는다.
- 리모컨 조작은 TV가 MDC 조회에 응답할 때 다음 polling/status 조회에서 반영된다. 절전 중 응답하지 않으면 마지막 확인값과 현재 조회 실패를 구분한다.
- 절전 중 입력·볼륨이 응답하지 않는 것은 TV의 대기 중 MDC 허용 설정, RS-232 변환기, 에코 설정을 확인해야 하는 하드웨어/설정 문제다.

## 5. 과거 오류와 재발 방지

### HDMI1인데 HDMI2로 표시

원인: 서버가 최신 상태부터 과거의 여러 `display.status` 결과를 모두 병합해 오래된 값이 최신값을 덮어씀.

방지: 최신 완료 status 한 건만 적용(`statusApplied` guard). 명령 매핑(`0x21`/`0x23`)은 정상이며 변경하지 않는다.

### HDMI 명령 응답 시간 초과

원인: TV 입력 전환 직후 MDC ACK/재조회 응답 지연.

방지: Agent가 지연 후 실제 입력을 재확인하고, 목표값이면 성공으로 보고한다. 그래도 확인되지 않을 때만 실패한다.

### 전체 TV 제어 서버 오류

원인: 존재하지 않는 `devices.status` 컬럼을 온라인 조건으로 사용.

방지: `julianday(last_seen_at) >= julianday('now','-120 seconds')`로 온라인 여부를 판단한다. DB에 임의의 status 컬럼을 추가하지 않는다.

### Agent 중복 실행 팝업

원인: 자동 시작과 수동 실행이 겹쳐 단일 실행 Mutex의 MessageBox가 전면 표시됨.

방지: Mutex는 유지하되 두 번째 프로세스는 조용히 종료한다.

### 릴리스/DB 손실

릴리스 교체 시 DB를 초기화하거나 볼륨을 삭제하지 않는다. Agent 릴리스만 이전 파일·pending/delivered 명령을 정리하고 UME 릴리스와 장비·사용자 데이터는 유지한다.

### I-Vision 종료 후 재실행

PlayAgent/Player만 종료하면 감시자·Updater가 다시 실행할 수 있다. 종료 순서는 감시자/Updater → Player → PlayAgent이며, 프로세스명만 가정하지 말고 경로·부모 프로세스도 진단한다.

## 6. 운영 배포 체크리스트

1. Agent 변경 시 `dotnet build agent/Funnet.Gwanak.Agent.csproj -c Release --no-restore`
2. 서버 변경 시 `node --check server/server.mjs`, `node --check server/public/app.js`, `npm test -- --runInBand`
3. `scripts/Build-Release.ps1 -Version x.y.z`로 Agent와 서버 패키지를 같은 버전으로 생성
4. 운영 서버 업로드 후 `docker compose up -d --build app`
5. `/healthz` 확인 및 Docker 로그의 기동 오류 확인
6. Agent 릴리스 등록 후 전체 자동 배포는 별도 승인 없이 자동 실행하지 않는다.
7. DB 볼륨과 `/data/releases`가 유지되는지 확인한다.

## 7. Android 확장 고려

Samsung MDC 해석과 서버 명령 계약을 플랫폼 공통 계층으로 유지한다. Windows 전용인 `WindowsSerialTransport`, 트레이 UI, DPAPI, Windows shutdown 실행부만 Android 구현으로 교체한다. Android에서는 USB-Serial/BLE/네트워크 MDC transport와 foreground service, Android Keystore를 사용하고, 서버 API의 `display.*`, `health.probe`, command completion 계약은 그대로 재사용한다. OS 종료 명령은 Android의 재부팅/앱 종료 정책과 별도 capability로 정의한다.

## 8. 다음 작업 시 주의

- 서버가 표시하는 상태를 마지막 명령값으로 대체하지 않는다.
- UI에서 숨긴 권한도 API에서 반드시 다시 검사한다.
- 지역 관리자 범위를 전체 장비로 확장하지 않는다.
- Windows 종료·I-Vision 종료 같은 파괴적 명령은 개별/전체를 분리하고 확인·감사 로그를 유지한다.
- 기존 해결 내역과 중복되는 Samsung 프로토콜 조사를 다시 시작하지 않는다.

## 9. 2026-09-11 추가 반영 사항

- 운영 서버 내부 IP가 `192.168.128.252`에서 `192.168.80.252`로 변경되었다. 동일 서버·동일 계정·SSH 2222이며 이후 배포/로그/재기동은 새 IP를 사용한다.
- 외부 관리 메뉴명은 `운영 관리 페이지`로 통일했다.
- Enercare는 iframe에서 깨질 수 있어 실제 제공 캡처를 `server/public/assets/enercare-preview.png`로 표시하고, 실제 사이트는 `현재 창에서 열기`로 연다. i-vision과 Enercare 모두 현재 창 열기를 사용한다.
- 운영 관리 페이지 실행 영역은 가로 폭을 유지하고 세로를 최대 `84vh`까지 확장했다.
- Agent 1.3.3에 Windows 종료 명령이 포함되어 있다. 개별·전체 모두 서버 확인 팝업, 승인/온라인 필터, 감사 로그를 거치며 Agent는 완료 보고 후 종료한다.
- 주 1회 서버 백업 스크립트는 `/data/gwanak-agent/scripts/backup-server.sh`, cron은 매주 일요일 03:00이다. 백업 기본 경로는 `/data/gwanak-agent-backups`, 변경은 `FUNNET_BACKUP_DIR`이다.
