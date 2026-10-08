# Yealink MeetingBar A10 내장 터널 PoC

## 목적과 제약

현장 공유기 포트포워딩, 고정 공인 IP, Raspberry Pi, OpenWrt 또는 별도 게이트웨이 없이 관리 PC에서 A10의 원격 관리 기능에 접근한다. 터널은 기존 TV 제어 Agent APK 내부에서 실행하며 USB-Serial TV 제어와 장애 영역을 분리한다.

## 확인된 실패 경로

Tailscale 별도 APK는 Agent의 `PackageInstaller`와 Yealink 관리자 메뉴 양쪽에서 승인 화면 없이 종료되거나 장비가 멈췄다. 따라서 1.2.0부터 APK 다운로드·설치·자동 재시도를 제거한다. 이 결과는 “별도 앱 설치 차단”을 뜻하며, 이미 설치된 Agent가 Android 표준 `VpnService`를 사용하는 것까지 차단됐다는 증거는 아니다.

## 1.2.0 사전검증

Agent APK에 공식 `com.wireguard.android:tunnel:1.0.20230706` 라이브러리를 포함한다. 이 라이브러리는 비루팅 사용자 공간 WireGuard 엔진이다. 앱의 **내장 터널 권한 테스트**는 `VpnService.prepare()`를 호출한다.

- 시스템 VPN 동의 화면이 표시되고 승인되면 `permissionStatus: granted`를 서버 Heartbeat에 보고한다.
- 이미 승인된 장비는 동의 화면 없이 즉시 `granted`가 된다.
- 화면이 닫히거나 거부되면 `denied`, 화면이 열리지 않고 멈추면 `requesting` 상태가 남는다.
- 별도 VPN APK를 설치하거나 실행하지 않는다.

이 단계에서는 중앙 WireGuard 키와 경로를 넣지 않으므로 실제 터널은 아직 연결하지 않는다. 권한 검증 전 장기 키를 APK에 포함하지 않는다.

## 권한 승인 후 구현 구조

```text
관리자 PC ── WireGuard ── 중앙 허브(공인 서버) ── WireGuard ── A10 Agent
                                                              └─ TV USB-Serial
```

1. 중앙 서버에 WireGuard 허브와 장비 등록 API를 둔다.
2. A10에서 키쌍을 생성하고 개인키는 Android 앱 전용 저장소에만 둔다.
3. 서버는 장비별 공개키, 터널 IP와 짧은 설정 수명을 관리한다.
4. 부팅 시 Agent foreground service가 터널을 자동 복구한다.
5. 서버에는 연결 상태, 터널 IP, 마지막 handshake만 보고하고 개인키는 보내지 않는다.

## 남은 핵심 검증

내장 터널이 연결돼도 Yealink `YLServer`가 VPN 인터페이스로 들어온 TCP 443 요청을 수신하는지는 별도 시험이 필요하다. 이전의 `127.0.0.1` 및 장비 자체 LAN IP 접속 실패는 앱 프로세스에서 관리 페이지로 나가는 연결이 막혔다는 뜻이며, VPN 인터페이스의 외부 인바운드까지 동일하다고 단정할 수 없다.

합격 순서는 다음과 같다.

1. A10에서 VPN 권한 승인
2. 중앙 허브와 handshake 및 재부팅 후 자동 재연결
3. 관리자 PC에서 A10 터널 IP 도달
4. `https://A10-터널-IP/`의 YLServer 응답
5. 24시간/72시간 무조작 상태에서 터널과 TV 제어 유지

4번이 실패하고 A10 앱 자신도 LAN의 YLServer에 연결할 수 없다면, 비루팅 앱만으로 관리 페이지를 중계할 경로가 없을 수 있다. 이 경우 제조사 서명 권한 또는 Yealink 공식 원격관리 인터페이스가 필요하다.

2026-10-08 실장 확인에서 외부 관리 PC는 `https://192.168.80.67/`에 HTTP 200, `Server: YLServer`로 접속했지만 A10 앱은 자기 주소와 `127.0.0.1`의 443에 연결할 수 없었다. 따라서 앱 내부 점검 실패는 관리 웹서비스 중지를 뜻하지 않는다. 실제 WireGuard 인바운드 시험으로 판단한다.

중앙 운영 서버는 `192.168.80.252` 사설망에 있다. 외부 현장 PoC에는 중앙 공유기에서 운영 서버로 UDP 51820 포워딩이 필요하며 2026-10-08 설정 완료를 확인했다.

2026-10-08 중앙 서버에 `wg0`를 구성하고 UDP 51820 리스닝을 확인했다. PoC 주소는 서버 `10.77.0.1`, A10 `10.77.0.2`, 관리자 PC `10.77.0.3`이다. A10의 AllowedIPs는 `10.77.0.0/24`로 제한해 기존 인터넷과 Agent 서버 경로를 터널로 보내지 않는다. PoC APK에 포함된 A10 개인키는 이 장비 전용이며 시험 종료 후 폐기·재발급한다.

같은 날 유선 전용 환경에서 A10의 실제 주소가 `192.168.128.6`으로 변경된 뒤 중앙 허브와 관리자 PC 양쪽 라우팅을 갱신했다. 중앙 허브에서 이 주소까지 ICMP는 손실 없이 도달했으므로 WireGuard handshake와 사이트 경로는 정상이다. 그러나 TCP 80, 443, 8080, 8443은 모두 즉시 연결 거부됐고 같은 LAN의 브라우저에서도 443에 접속할 수 없었다. 이 결과는 VPN 장애가 아니라 해당 유선 인터페이스에서 `YLServer`가 리스닝하지 않는 상태를 뜻한다. Yealink 관리 페이지 활성화 설정 또는 서비스의 인터페이스 바인딩을 먼저 확인해야 한다.

앱 1.3.2부터 네트워크 인터페이스 열거 순서 때문에 `10.77.0.2`를 장비의 로컬 IP로 잘못 선택하지 않도록 Ethernet, Wi-Fi, VPN 순으로 주소 우선순위를 적용한다.

## 라이선스와 보안

- WireGuard tunnel Android 라이브러리는 Apache-2.0이며 저작권/라이선스 고지를 배포물에 포함한다.
- 개인키, 등록키와 장비 토큰은 Git, BuildConfig 및 일반 로그에 넣지 않는다.
- 장비별 키 폐기와 재발급이 가능해야 하며 하나의 공용 개인키를 APK에 넣지 않는다.
- 터널 장애가 USB-Serial TV 제어 서비스를 중단시키지 않도록 별도 실행 상태로 관리한다.

## 공식 자료

- WireGuard Android: https://github.com/WireGuard/wireguard-android
- WireGuard tunnel Maven: https://central.sonatype.com/artifact/com.wireguard.android/tunnel
- Android VpnService: https://developer.android.com/reference/android/net/VpnService
