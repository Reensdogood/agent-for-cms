# P2 Samsung Display Control 배포 가이드

## Agent

1. `scripts/Build-Release.ps1 -Version <version>`으로 self-contained `win-x64` 패키지를 생성한다.
2. 대상 PC에 `funnet-gwanak-agent-setup-<version>.exe`를 설치한다.
3. 설치 후 `agent-settings.json`의 서버 URL과 enrollment key를 입력하고, 실제 장치가 연결된 경우에만 다음 설정을 활성화한다.

```json
{
  "display": {
    "enabled": true,
    "vendor": "samsung",
    "model": "LH75QET",
    "port": "COM3"
  }
}
```

포트는 장치 관리자에서 확인한 값을 사용한다. Agent는 드라이버를 설치하거나 COM 번호를 임의 변경하지 않는다.

## Server

`dist/server-package`를 운영 서버에 배포하고 기존 `npm start`/Compose 절차를 사용한다. DB 백업 후 배포하며, API는 기존 관리자 세션·CSRF·역할 검사를 그대로 적용한다.

## 지원 명령

- 개별: `power`, `input(HDMI1/HDMI2)`, `volume(0~100)`
- Bulk: `power ON/OFF`, `input HDMI1/HDMI2`
- Brightness Get/Set: P2에서 SKIP

## 롤백

Agent는 이전 설치 프로그램으로 재설치하고, Server는 이전 server-package와 DB 백업을 복원한다. 배포 전 SHA256SUMS.txt를 검증한다.
