# agent-for-cms

Android TV Stick/Box용 USB-to-RS232 Samsung TV 제어 PoC가 `android-tv-controller`에 포함되어 있습니다. 기존 서버를 로컬 LAN에서 실행하고 APK를 빌드·설치하는 절차는 `docs/android-poc-installation.md`를 따릅니다. Android 앱은 Windows Agent와 별도 앱이지만 기존 장비 등록, Heartbeat, 명령 큐와 결과 보고 API를 재사용합니다.

관악 지역 Windows 장비에서 UME 화상회의 실행과 i-vision DID 복귀 흐름을 관리하기 위한 운영 MVP입니다.

## 현재 구현 범위

- 관리자 로그인 화면
- 사용자 추가, 수정, 삭제, 계정 사용/중지
- 전체 시스템, 운영, 지역 관리자 권한 관리
- Apple 스타일의 장비 현황, 장비 관리, 스케줄, UME 배포, 외부 관리 UI
- Agent 이름: `funnet-gwanak-agent`
- Windows Tray Agent 설치 프로그램
- 장비 자동 등록, 승인 대기, 장비명 수정
- 30초 Heartbeat와 관리자 즉시 상태 확인
- Agent/UME 버전, UME 실행 경로, i-vision 실행 여부 보고
- UME 실행 스케줄 등록, 수정, 사용/해제, 삭제, 전체 즉시 실행
- 장비별 UME 재실행 명령 전송
- UME 창 전체화면/최상단 전환 명령
- UME 콜 수신 시 녹색 참가/수락 버튼 화면 감지와 자동 클릭 시도
- UME 자동 로그인이 풀렸을 때 작은 로그인 창의 파란 로그인 버튼 자동 클릭 시도
- UME 숨김 처리와 i-vision 전면 복귀 시도
- 서버에 UME 설치파일 업로드
- 승인된 장비 전체로 UME 설치파일 다운로드 명령 전송
- Agent의 UME 설치파일 크기, SHA-256, Windows 전자서명 검증
- 최근 명령 이력 조회 API

## 운영 정책

사용자 권한은 서버 API에서 한 번 더 검증합니다. 화면에서 메뉴를 숨기는 것만으로 권한을 처리하지 않습니다.

- 전체 시스템: 사용자, 지역, 장비, 스케줄, UME 배포 전체 관리
- 운영: 장비 운영, 스케줄, UME 배포 관리
- 지역 관리자: 담당 지역 장비 조회, 승인, 이름 수정, 상태 확인

UME 업데이트는 개인정보 활용과 Windows 통신 제어 이슈를 고려해 자동 설치하지 않습니다.

서버는 `UME-release-{version}.exe` 또는 `UME-release-{version}+default.exe` 형식의 파일을 보관하고 배포 명령을 보냅니다. Agent는 파일을 다운로드하고 검증한 뒤 로컬에 보관합니다. 실제 설치는 운영자가 원격 접속해 수동으로 진행합니다.

i-vision과 UME 관리자 화면은 외부 사이트의 보안 정책에 따라 iframe 표시가 차단될 수 있습니다. 이 경우 관리자 화면 안의 현재 창 이동 버튼으로 열어 사용합니다. 외부 사이트 ID/PW는 서버에 저장하거나 자동 입력하지 않습니다.

## 로컬 실행

PowerShell에서 실행합니다.

```powershell
$env:FUNNET_ADMIN_USER = 'admin'
$env:FUNNET_ADMIN_PASSWORD = '<10자 이상의 관리자 비밀번호>'
$env:FUNNET_ENROLLMENT_KEY = '<16자 이상의 장비 등록 키>'
npm start
```

기본 주소는 `http://127.0.0.1:4170`입니다.

## Agent 점검

```powershell
dotnet build .\agent\Funnet.Gwanak.Agent.csproj -c Release
dotnet run --project .\agent\Funnet.Gwanak.Agent.csproj -c Release -- --self-test
dotnet run --project .\agent\Funnet.Gwanak.Agent.csproj -c Release -- --once
```

`--self-test`는 Agent를 상주시키지 않고 현재 PC의 UME/UME global 설치 버전, 실행 경로, 실행 상태를 JSON으로 출력합니다.

`--once`는 서버 등록, Heartbeat 전송, 대기 명령 처리를 한 번 수행한 뒤 종료합니다.

설정은 `agent-settings.example.json`을 참고해 Agent 실행 폴더에 `agent-settings.json`으로 배치합니다. 장비 토큰은 Windows DPAPI로 현재 사용자에게 암호화해 저장합니다. 등록이 끝나면 설정 파일의 enrollment key는 자동 제거됩니다.

## 배포 패키지 빌드

```powershell
.\scripts\Build-Release.ps1 -Version 1.0.0 -OutputDirectory dist-1.0.0
```

생성물은 지정한 배포 폴더에 만들어집니다.

- `funnet-gwanak-agent-setup-1.0.0.exe`: Windows Agent 설치 프로그램
- `funnet-gwanak-server-1.0.0.zip`: 서버 배포 패키지
- `SHA256SUMS.txt`: 배포 파일 해시
- `agent-settings.example.json`: Agent 설정 예시

현재 설치 프로그램은 코드 서명 인증서가 없는 상태에서는 unsigned입니다. 여러 PC에 운영 배포하기 전 조직 코드 서명 인증서로 서명해야 SmartScreen과 보안 솔루션 차단 가능성을 줄일 수 있습니다.

## 버전 정책

현재 기준 버전은 `1.0.0`입니다. 이후 기능 추가, UI 개선, 서버/Agent 배포 산출물 갱신 시마다 `0.1.0` 단위로 올립니다.

예: `1.0.0` 다음 버전은 `1.1.0`입니다.

## 서버 운영 배포

서버 배포 패키지를 운영 서버에 풀고 `.env`를 준비합니다.

```powershell
Copy-Item .\deploy\.env.example .\.env
```

`.env`에서 아래 값을 운영용으로 교체합니다.

```env
FUNNET_DOMAIN=control.example.com
FUNNET_ADMIN_USER=admin
FUNNET_ADMIN_PASSWORD=replace-with-a-long-random-password
FUNNET_ENROLLMENT_KEY=replace-with-a-separate-long-random-enrollment-key
```

Docker와 Docker Compose가 설치된 서버에서 실행합니다.

```powershell
docker compose up -d --build
```

Caddy가 `FUNNET_DOMAIN` 기준으로 HTTPS 인증서를 자동 발급합니다. 운영 전 DNS A 레코드가 서버 공인 IP를 바라봐야 합니다.

## 내부 개발서버 배포

도메인과 HTTPS 연결 전에는 내부망 IP로 먼저 운영할 수 있습니다.

```powershell
Copy-Item .\deploy\compose.dev-lan.yaml .\compose.override.yaml
docker compose up -d --build app
```

이 구성은 Caddy를 켜지 않고 앱 컨테이너만 `4170` 포트로 노출합니다. Agent 서버 주소는 `http://서버-내부-IP:4170`처럼 내부 IP를 사용합니다.

NAT 포워딩과 DNS A 레코드가 준비되면 `FUNNET_DOMAIN=agent.funnet.kr`로 바꾸고 override를 제거한 뒤 아래처럼 HTTPS 구성을 켭니다.

```powershell
docker compose --profile https up -d --build
```

기존 nginx가 80/443 포트를 이미 사용 중인 개발서버에서는 Caddy 대신 `deploy/nginx.agent.funnet.kr.conf`를 nginx에 추가하고, `deploy/compose.nginx-local.yaml`을 `compose.override.yaml`로 사용합니다. 이 구성은 앱을 `127.0.0.1:4170`에만 열고 nginx가 `https://agent.funnet.kr`로 프록시합니다.

## 테스트

```powershell
npm test
dotnet build .\agent\Funnet.Gwanak.Agent.csproj -c Release
dotnet build .\installer\Funnet.Gwanak.Agent.Installer.csproj -c Release
```

현재 서버 테스트는 로그인, 장비 등록, Heartbeat, 승인, 상태 확인 명령, UME 설치파일 업로드/다운로드/배포, 스케줄 전체 실행, 스케줄 사용 해제, 스케줄 삭제, 장비별 UME 실행, 정적 페이지와 CSP, 헬스 체크를 검증합니다.
