# Yealink MeetingBar A10 자체 OpenVPN 구성

## 결론

A10 관리페이지의 **네트워크 → 고급 네트워크 → VPN**은 장비 펌웨어에 포함된 OpenVPN 클라이언트다. 근거는 다음과 같다.

- A10 웹 UI가 VPN 설정 업로드 API `/api/vpn/file`을 제공한다.
- UI가 루트 인증서, 클라이언트 인증서, 클라이언트 추가 인증서, 클라이언트 키, TLS 인증 키를 각각 받는다.
- TLS 인증 유형은 `Static`, `Dynamic`, `TLS-Crypt` 세 가지다.
- A10 언어 리소스가 VPN 구성 파일을 명시적으로 `openVPN` 구성 파일이라고 설명한다.
- 기존 Yealink OpenVPN 구성 사례도 구성 파일명을 `vpn.cnf`로 고정하고 `/config/openvpn/keys/` 경로를 사용한다.

따라서 WireGuard `.conf` 파일은 이 화면에 업로드할 수 없다. 업로드 대상은 OpenVPN 문법의 `vpn.cnf`다.

## Agent 정책

Android Agent 1.4.0부터 다음 기능을 제거한다.

- WireGuard Android 라이브러리
- Android `VpnService` 권한 요청
- 내장 터널 시작
- APK에 VPN 개인키/구성 포함
- VPN 권한·터널 상태 UI 및 Heartbeat 보고

Agent는 TV 제어, 절전 감시, 서버 명령 처리만 담당한다. VPN 연결은 A10 펌웨어가 담당한다.

## 필요한 파일

| A10 화면 | 권장 파일 | 용도 |
|---|---|---|
| VPN 구성 업로드 | `vpn.cnf` | OpenVPN 클라이언트 옵션 |
| 루트 인증서 | `ca.crt` | VPN 서버 인증 CA |
| 클라이언트 인증서 | `client.crt` | A10 장비 인증서 |
| 클라이언트 추가 인증서 | 필요할 때만 중간 인증서 | 인증서 체인 보완 |
| 클라이언트 키 | `client.key` | A10 전용 개인키 |
| TLS 인증 키 | `ta.key` 또는 `tls-crypt.key` | `tls-auth`/`tls-crypt` 사용 시 제어 채널 보호 |

개인키와 TLS 키는 장비별로 발급하고 Git, APK, 일반 배포 파일에 포함하지 않는다.

## `vpn.cnf` 기준안

다음은 UDP 1194 OpenVPN 서버용 기준안이다. 실제 서버 주소, 암호군 및 TLS 방식은 서버 설정과 같아야 한다.

```conf
client
dev tun
proto udp
remote agent.funnet.kr 1194
resolv-retry infinite
nobind
persist-key
persist-tun
ca /config/openvpn/keys/ca.crt
cert /config/openvpn/keys/client.crt
key /config/openvpn/keys/client.key
remote-cert-tls server
cipher AES-128-CBC
auth SHA256
verb 3
```

TLS 인증 키를 쓰는 경우 서버와 A10의 선택값을 맞춘다.

- `Static`: 일반적으로 `tls-auth`와 `ta.key` 조합이다. 서버가 지정한 key direction도 일치시킨다.
- `TLS-Crypt`: `tls-crypt`와 `tls-crypt.key` 조합이다.
- `Dynamic`: 서버가 동적 TLS 인증을 지원한다고 명시한 경우에만 사용한다.

A10 UI가 인증서와 키를 별도 업로드하므로, 먼저 각 파일을 해당 항목에 업로드한 뒤 `vpn.cnf`를 업로드한다. 펌웨어가 파일을 고정 경로에 저장하므로 구성 파일의 경로는 `/config/openvpn/keys/` 관례를 따른다. 펌웨어별 차이가 있으면 업로드 오류 로그와 A10 네트워크 진단을 기준으로 조정한다.

## 적용 순서

1. 중앙 서버에 OpenVPN 서버와 장비별 PKI를 준비한다.
2. 방화벽과 포트포워딩에서 UDP 1194를 중앙 OpenVPN 서버로 전달한다.
3. A10 전용 `client.crt`, `client.key`를 발급한다.
4. A10 웹 관리에서 `ca.crt`, `client.crt`, `client.key`를 업로드한다.
5. TLS 인증을 사용할 경우 키를 업로드하고 유형을 서버와 동일하게 선택한다.
6. `vpn.cnf`를 업로드하고 VPN을 활성화한다.
7. A10을 재부팅하라는 안내가 나오면 재부팅한다.
8. 중앙 서버에서 클라이언트 접속과 VPN 주소 할당을 확인한다.
9. 관리자 PC에서 A10 VPN 주소의 HTTPS 443을 확인한다.

## 성공 판정

- OpenVPN 서버에 A10 인증서 CN의 접속 기록이 나타난다.
- A10에 VPN IPv4 주소가 할당된다.
- 관리자 PC에서 VPN 주소로 ping 또는 경로 확인이 된다.
- `curl -k -I https://A10-VPN-IP/`가 `HTTP 200`과 `Server: YLServer`를 반환한다.

펌웨어 자체 VPN은 Android 앱의 `VpnService`와 달리 장비 네트워크 계층에서 동작하므로 YLServer가 VPN 주소에서 수신할 가능성이 있다. 다만 실제 443 바인딩 여부는 위 시험으로 최종 확인해야 한다.

## 참고

- [Yealink Support](https://support.yealink.com/)
- [Yealink OpenVPN client configuration example](https://github.com/Jamous/mylilserver.net/blob/master/build/unixArticles/openvpn.rst)
- [OpenVPN 2.4 manual](https://openvpn.net/community-resources/reference-manual-for-openvpn-2-4/)
