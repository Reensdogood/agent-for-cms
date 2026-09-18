# P2 Samsung Display Control 배포 가이드

## Agent

1. `scripts/Build-Release.ps1 -Version <version> -RegionName '<지역명>' -EnrollmentKey '<해당 지역 등록 키>'`로 지역 전용 self-contained `win-x64` 패키지를 생성한다.
2. 대상 PC에 `funnet-gwanak-agent-setup-<version>.exe`를 설치한다.
3. 설치 파일에 서버 URL과 enrollment key가 포함되어 있으므로 설치 중 입력하지 않는다. 성공적으로 관리자 권한 Agent 시작을 확인하면 설치 창은 자동으로 닫힌다. 서버 URL 변경은 트레이 아이콘의 설정에서만 한다.

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
