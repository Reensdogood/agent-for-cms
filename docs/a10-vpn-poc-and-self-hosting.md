# Yealink MeetingBar A10 원격 관리 VPN PoC와 자체 구축 전환안

## 목적

현장 공유기 포트포워딩이나 고정 공인 IP 없이 관리 PC에서 MeetingBar A10의 Yealink 관리 페이지(`HTTPS 443`)에 접속한다. TV 제어 Agent의 USB-Serial 기능과 VPN은 분리하여, VPN 장애가 TV 제어를 중단시키지 않도록 한다.

## 1차 PoC: Tailscale

Agent 1.1.0은 Tailscale을 직접 포함하거나 수정하지 않는다. Tailscale 공식 stable 패키지 서버의 범용 APK를 내려받고 SHA-256을 검증한 뒤 Android 패키지 설치 화면을 연다.

- 공식 패키지: `tailscale-android-universal-1.102.4.apk`
- 공식 다운로드: `https://pkgs.tailscale.com/stable/tailscale-android-universal-1.102.4.apk`
- SHA-256: `7ecfb863e08f5fbd1ecd70235d8c34ba135a4124bdd8e166b9d6fb962782e0b5`
- 지원 기준: Android 8 이상. A10 배포본은 Android 9 이상을 요구한다.
- Tailscale 패키지명: `com.tailscale.ipn`

Android 보안 정책 때문에 최초 한 번은 운영자가 다음 항목을 승인해야 한다.

1. Agent의 알 수 없는 앱 설치 권한
2. Tailscale APK 설치
3. Tailscale의 VPN 연결 권한
4. QR 또는 등록 코드를 이용한 장비 등록

Agent는 설치 여부, Tailscale 버전, Android VPN 활성 상태, 가상 인터페이스 주소를 Heartbeat의 `vpn` 항목으로 보고한다. Agent 화면의 **Tailscale 설치 또는 실행**과 **VPN 상태 새로고침**으로 현장 상태를 확인한다.

## PoC 합격 조건

관리자 Windows PC도 같은 Tailnet에 연결한 후 아래 항목을 시험한다.

1. A10에 `100.x.x.x` 또는 Tailscale IPv6 주소가 할당된다.
2. 관리자 PC에서 A10 VPN 주소로 ping 또는 Tailscale 연결 진단이 성공한다.
3. 관리자 PC에서 `https://A10-VPN-IP/`를 열었을 때 Yealink `YLServer` 관리 페이지가 표시된다.
4. A10 재부팅 후 VPN이 다시 연결된다.
5. 24시간과 72시간 무조작 상태에서 VPN과 TV 제어 Heartbeat가 모두 유지된다.
6. VPN을 끊어도 USB-Serial TV 제어와 Agent Heartbeat는 계속 동작한다.

`VPN 연결 성공 + 443 실패`이면 Yealink 웹서버가 Android VPN 가상 인터페이스의 인바운드 요청을 받지 않는 것으로 판정한다. 이 경우 A10 내부의 다른 VPN 앱으로 교체하지 않고 현장 LAN의 공유기 또는 별도 게이트웨이에 VPN을 설치한다.

## 장기 권장안: NetBird 자체 호스팅

Tailscale PoC가 성공하면 장기적으로 NetBird를 자체 서버에 배치한다. NetBird는 WireGuard 기반이며 Android TV용 공식 절차, GitHub APK, 자체 관리 서버 주소, 설정키 등록, Windows 클라이언트와 중계 기능을 제공한다.

권장 구성:

```text
관리자 Windows PC ─┐
순천 A10 ──────────┼─ NetBird 관리/Signal/Relay 서버
관악 A10 ──────────┤          │
기타 지역 A10 ─────┘          └─ 접근정책·장비폐기·감사
```

서버 기본 요구사항은 공인 도메인, TCP 80/443, UDP 3478, Docker Compose 및 약 2GB 이상의 메모리다. 운영 서버와 포트가 충돌하면 별도 VPS 또는 별도 공인 IP에 둔다.

Android 장비는 장비별 또는 짧은 수명의 설정키로 등록한다. 하나의 영구 설정키를 모든 APK에 넣지 않는다. 지역별 접근 그룹을 분리하고 관리자 PC에서 A10의 443만 허용하는 정책부터 시작한다.

## 대안 순위

1. **NetBird**: Android TV와 자체 호스팅의 균형이 가장 좋다.
2. **Headscale**: Tailscale 클라이언트를 유지하면서 제어 서버를 자체 운영할 때 적합하지만 클라이언트 호환성을 지속 확인해야 한다.
3. **순수 WireGuard**: 소수 장비에는 단순하지만 키 수명, 폐기, NAT 중계, 상태 UI를 직접 개발해야 한다.
4. **현장 VPN 게이트웨이**: A10 자체 VPN 주소의 443 접속이 차단될 때 사용하는 확정 대안이다.

## 라이선스와 배포 원칙

- Tailscale과 NetBird APK는 Funnet 소스 저장소에 커밋하지 않는다.
- APK는 각 프로젝트의 공식 배포 URL에서 받고 배포 버전과 SHA-256을 고정한다.
- Agent는 외부 VPN 앱을 수정하거나 코드에 링크하지 않고 설치·실행·상태 확인만 담당한다.
- NetBird 서버를 수정하면 해당 구성요소의 AGPLv3 의무를 검토한다. 수정 없는 자체 운영도 라이선스 고지와 소스 버전 기록을 유지한다.
- VPN 인증키, 등록키, 장비 토큰은 Git과 일반 로그에 기록하지 않는다.

## 공식 자료

- Tailscale stable APK: https://pkgs.tailscale.com/stable/
- Tailscale Android: https://github.com/tailscale/tailscale-android
- NetBird Android TV: https://docs.netbird.io/get-started/install/android-tv
- NetBird Android APK: https://github.com/netbirdio/android-client/releases
- NetBird 자체 호스팅: https://docs.netbird.io/selfhosted/selfhosted-quickstart
- Headscale: https://github.com/juanfont/headscale
- WireGuard Android: https://github.com/WireGuard/wireguard-android
