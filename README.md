# agent-for-cms

Yealink MeetingBar A10용 USB-to-RS232 Samsung TV 제어 앱이 `android-tv-controller`에 포함되어 있습니다. 설치·시험은 `docs/android-poc-installation.md`, 인터넷 현장의 원격 관리 VPN PoC와 자체 구축 전환안은 `docs/a10-vpn-poc-and-self-hosting.md`를 따릅니다. Android 앱은 Windows Agent와 별도 앱이지만 기존 장비 등록, Heartbeat, 명령 큐와 결과 보고 API를 재사용합니다.

Android 1.1.1은 QET, QBC/QBCE, QMC/QMCE 계열을 지원한다. QBC와 QMC는 HDMI1/2/3을 제공한다. A10 화면에서 공식 Tailscale APK 설치를 시작할 수 있으며 APK의 SHA-256을 검증한 후 브라우저나 파일 관리자를 거치지 않고 Android `PackageInstaller` 세션에 전달한다. VPN 설치·연결은 TV 제어와 분리되어 있고, VPN 설치 여부·활성 상태·가상 IP는 서버 Heartbeat에 보고한다. 최초 APK 설치와 Android VPN 권한은 현장에서 한 번 승인해야 한다.

관악 지역 Windows 장비에서 UME 화상회의 실행과 i-vision DID 복귀 흐름을 관리하기 위한 운영 MVP입니다.

## 현재 구현 범위

- 관리자 로그인 화면
- 사용자 추가, 수정, 삭제, 계정 사용/중지
- 전체 시스템, 운영, 지역 관리자 권한 관리
- Apple 스타일의 장비 현황, 장비 관리, 스마트플러그, 스케줄, UME 배포, 외부 관리 UI
- 사용자 표시 Agent 이름: `funnet-agent` (실행 파일/프로세스 식별자 `funnet-gwanak-agent`는 기존 설치·자동업데이트 호환을 위해 유지)
- Windows Tray Agent 설치 프로그램
- 장비 자동 등록, 승인 대기, 장비명 수정
- 30초 Heartbeat와 관리자 즉시 상태 확인
- Agent/UME 버전, UME 실행 경로, i-vision 실행 여부 보고
- UME 실행 스케줄 등록, 수정, 사용/해제, 삭제, 전체 즉시 실행
- 장비별 UME 재실행 명령 전송
- UME 창 전체화면/최상단 전환 명령
- UME 콜 수신 시 녹색 참가/수락 버튼 화면 감지와 자동 클릭 시도
- UME 자동 로그인이 풀렸을 때 작은 로그인 창의 파란 로그인 버튼 자동 클릭 시도

## 2026-09-15 점검 기준

- UME 실행/종료는 Agent 명령 `ume.activate`/`ume.hide`로 분리한다. UME 프로세스 내부의 제목 없는 Chrome 컨테이너나 카메라 모니터 창을 회의창으로 단정하지 않는다.
- UME 창을 강제 종료·숨김·최상위 고정하지 않는다. 내부 보조창은 포커스만 양보하고 백그라운드로 보낸다. 이 원칙을 어기면 검은 공백창, 입력 잠김, 메모리 급증이 재현될 수 있다.
- 자동 응답은 제목이 `회의 초대`인 UME 초대 팝업의 녹색 참가 버튼에서만 수행한다. 더보기·카메라·마이크 메뉴나 UME 메인 창은 자동 클릭하지 않는다. 회의창 감지 시에만 전체 화면으로 전환하고, `topmost`는 사용하지 않는다.
- UME 창 분류가 의심될 때는 `runtime-windows10.jsonl` 또는 `runtime-windows11.jsonl`의 `ume.window.inventory`, `ume.invitation.accept.clicked`, `ume.meeting.fullscreen.applied` 이벤트로 제목·클래스·좌표·보조창 분류를 먼저 확인한다.
- 실제 화상회의 팝업(더보기, 카메라/마이크 선택)은 회의 본창의 자식 팝업으로 취급하고, 감시 루프가 본창을 다시 앞으로 올려 팝업을 가리지 않도록 한다.
- Agent 업데이트 중 기존 UME가 실행 중이면 watcher의 초기 상태를 현재 회의창 상태로 시드하여 종료 오판과 중복 알림을 막는다.
- I-Vision 권한 상승과 UME 버전 차이는 다음 Phase에서 별도 조사한다. 이번 변경에서 운영 배포하지 않는다.
- 장비 관리 화면은 온라인 우선 정렬, 지역/상태/장비명/Agent/UME/i-vision 정렬, 10/50/100개 페이지 선택을 지원한다.
- UME 숨김 처리와 i-vision 전면 복귀 시도
- 서버에 UME 설치파일 업로드
- 승인된 장비 전체로 UME 설치파일 다운로드 명령 전송
- Agent의 UME 설치파일 크기, SHA-256, Windows 전자서명 검증
- 최근 명령 이력 조회 API
- EnerCare 스마트플러그 장치 목록 조회, 실시간 상태 캐시, Online 상태 전원 ON/OFF 제어

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
.\scripts\Build-Release.ps1 -Version 1.0.0 -RegionName '관악' -EnrollmentKey '<해당 지역의 16자 이상 등록 키>' -OutputDirectory dist-1.0.0
```

생성물은 지정한 배포 폴더에 만들어집니다.

- `funnet-agent-setup-1.0.0.exe`: Windows Agent 설치 프로그램
- `funnet-gwanak-server-1.0.0.zip`: 서버 배포 패키지
- `SHA256SUMS.txt`: 배포 파일 해시
- `agent-settings.example.json`: Agent 설정 예시

Agent 설치 파일은 지정한 지역의 서버 주소와 등록 키를 내부에 포함한다. 일반 설치·자동 업데이트 화면에는 서버 주소나 등록 키를 표시하지 않으며, Agent가 관리자 권한 예약 작업으로 시작된 것을 확인하면 설치 창을 자동으로 닫는다. 서버 주소 변경은 트레이 아이콘의 **설정**에서만 가능하다.

설치 파일은 기존 일반 권한 Agent의 자동 업데이트 호환을 위해 실행 파일 매니페스트를 `asInvoker`로 유지한다. 수동 실행 시 설치기가 즉시 Windows UAC `runas`로 자신을 다시 시작하므로, 파일 탐색기에 방패 아이콘이 없더라도 승인 후 설치·예약 작업 등록은 관리자 권한으로 수행된다.

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
ENERCARE_BASE_URL=https://dwcon.enercare.co.kr:18443
ENERCARE_DWD_SERVER_ID=FUNNET
ENERCARE_DWD_GROUP_ID=FUNNET
ENERCARE_DWD_SERVER_SECRET=EnerCare에서 발급한 다원 서버 Secret
ENERCARE_CON_SERVER_SECRET=EnerCare 콜백용으로 생성한 강한 Secret
```

`ENERCARE_DWD_SERVER_SECRET`와 `ENERCARE_CON_SERVER_SECRET`는 서버 `.env`에만 저장하며 브라우저나 Agent에 전달하지 않습니다. EnerCare가 실시간 콜백을 사용할 경우 `https://agent.funnet.kr/conn/v1/publish/servertoken` 및 `https://agent.funnet.kr/conn/v1/transfer/device/realtimedata`를 사용합니다. 콜백 Secret은 서버 토큰 발급 시 상수 시간 비교로 검증하고, 발급 토큰은 `9999-12-31 23:59:59`까지 유효하게 처리합니다.

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
