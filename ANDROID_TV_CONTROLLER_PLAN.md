# Android TV Controller 기본 기획안

이 문서는 기존 `agent-windows` 서버와 Samsung MDC 구현을 기준으로 Android TV Box/Stick용 별도 앱을 개발하기 위한 기준 문서다. 개발 중 판단이 달라질 때에는 이 문서, `PHASE2_DEVELOPMENT.md`, 실제 서버 API와 테스트 순으로 확인한다.

## 1. 목표와 범위

- 제품 형태: Windows Agent와 별개로 설치되는 Android 앱
- 권장 실행 장비: 별도 전원, USB Host, Ethernet을 갖춘 Android TV Box
- TV 연결: Android USB Host → USB-to-RS232 → Samsung RS232C IN
- 대상 TV: Samsung QET 계열(HDMI 2개), Samsung QBC 계열(HDMI 3개)
- 서버: 기존 `agent-windows/server`와 `https://agent.funnet.kr` 재사용
- 앱 동작: 부팅 자동 시작, Foreground Service 상주, 절전 예외, USB 재연결, 서버 명령 처리
- 제어 범위: 전원, HDMI 입력, 볼륨, 실제 상태 조회
- 모니터링 범위: 전원·입력·볼륨·MDC 연결상태·USB 상태·앱 상태. 실제 TV 화면 픽셀 캡처는 범위 밖이다.

## 2. 변경하지 않을 기존 서버 계약

Android 앱은 서버에서 별도의 제어 프로토콜을 만들지 않고 아래 계약을 재사용한다.

| 기능 | 서버 계약 |
|---|---|
| 최초 등록 | `POST /api/agent/register`, `X-Enrollment-Key` |
| 상태 전송 | `POST /api/agent/heartbeat`, Device Bearer Token |
| 명령 수신 | `GET /api/agent/commands` |
| 결과 보고 | `POST /api/agent/commands/{commandId}/result` |
| 명령 | `display.power`, `display.input`, `display.volume`, `display.status`, `health.probe` |
| Heartbeat 기본 주기 | 30초 |
| 명령 조회 기본 주기 | 5초 |
| 온라인 판정 | 최근 Heartbeat 120초 이내 |

등록 후 받은 Device Token은 Android Keystore로 보호한다. 등록 키는 최초 등록이 완료되면 앱의 일반 설정 저장소에서 제거한다.

서버 응답이 유실되어 같은 명령이 다시 전달될 수 있으므로 Android 앱은 최근 완료 `commandId`와 결과를 로컬에 보관한다. 같은 ID를 다시 받으면 TV 명령을 중복 실행하지 않고 저장된 결과만 서버에 다시 보고한다.

## 3. Android 앱 구성

권장 프로젝트 경로는 `android-tv-controller/`이며 Windows 프로젝트와 빌드 산출물을 분리한다.

```text
BootReceiver / LockedBootReceiver
        ↓
TvControlForegroundService (connectedDevice)
        ├─ ServerClient
        │    ├─ Registration
        │    ├─ Heartbeat 30초
        │    └─ Command polling 5초
        ├─ UsbSerialTransport
        │    ├─ USB 권한 및 VID/PID 확인
        │    ├─ Attach/Detach 감지
        │    └─ 9600 / 8-N-1 / Flow control 없음
        ├─ SamsungMdcClient
        │    ├─ 패킷 생성과 checksum
        │    ├─ 부분 수신 누적
        │    ├─ ACK/NAK 및 Display ID 검증
        │    └─ SET 후 실제값 재조회
        └─ RecoveryController
             ├─ USB 자동 재연결
             ├─ 지수형 네트워크 재시도
             ├─ 명령 중복 실행 방지
             └─ 진단 로그 순환 보관
```

앱 UI는 최초 설정과 현장 진단에만 사용한다. 제어 서비스는 화면이나 현재 HDMI 입력과 무관하게 계속 실행되어야 한다.

## 4. Android 실행·절전 정책

- `RECEIVE_BOOT_COMPLETED`와 필요한 경우 `LOCKED_BOOT_COMPLETED`를 수신한다.
- Android 14 이상을 고려해 Foreground Service 유형을 `connectedDevice`로 선언한다.
- 서비스는 `START_STICKY`로 실행하고 상시 알림을 표시한다.
- USB 연결/분리 Broadcast와 서비스 시작 시 USB 장치 열거를 모두 사용한다.
- 최초 설치 시 앱 1회 실행, USB 접근 허용, 기본 USB 앱 지정, 배터리 최적화 제외가 필요하다.
- 영구 Wake Lock은 기본값으로 사용하지 않는다. 후보 장비 시험에서 CPU suspend가 확인될 때 최소 범위의 `PARTIAL_WAKE_LOCK`을 적용한다.
- 장비 설정에서 자동 절전, 앱 자동 정리, HDMI-CEC 연동 종료를 해제한다.
- 정전 복구 후 Android Box 자체가 자동 부팅되는 제품만 운영 후보로 승인한다.
- 앱 프로세스가 종료되어도 서비스 재시작과 부팅 수신으로 복구하되, 제조사 펌웨어의 강제 종료를 앱만으로 100% 방지할 수 있다고 가정하지 않는다.

## 5. Samsung MDC 고정 규칙

Windows에서 검증한 다음 값을 Android에서도 그대로 사용한다.

| 항목 | 값 |
|---|---|
| Header | `0xAA` |
| Display ID | 기본 `0x00`, 설정 가능 |
| Power | `0x11` |
| Volume | `0x12` |
| Input | `0x14` |
| HDMI1 | `0x21` |
| HDMI2 | `0x23` |
| HDMI3 | `0x31` |
| ACK / NAK | `0x41` / `0x4E` |
| Serial | 9600bps, 8 data bits, no parity, 1 stop bit, no flow control |

- 브로드캐스트 ID `0xFE`는 ACK가 없으므로 상태 검증이 필요한 운영 명령에는 사용하지 않는다.
- 응답은 Header, 길이, checksum, Display ID, 원명령 byte, ACK/NAK를 모두 검증한다.
- 한 번의 USB read가 전체 패킷을 반환한다고 가정하지 않고 길이가 완성될 때까지 누적한다.
- 모든 SET 명령은 ACK만으로 성공 처리하지 않고 GET으로 실제 상태를 다시 확인한다.
- QE75T에서 확인된 입력 전환 응답 지연을 고려해, 최초 검증 실패 시 500ms 후 입력을 한 번 더 조회한다. 목표 입력이면 `confirmed_after_delayed_response`로 성공 처리한다.
- Brightness는 기존 기준대로 지원하지 않는다.

## 6. Windows 오류 재발 방지 규칙

### 오래된 상태가 최신 상태를 덮는 문제

- 서버는 가장 최근 완료된 `display.status` 한 건만 적용하는 현재 동작을 유지한다.
- Android Heartbeat의 `display` 항목은 장치 설정·capability이고 실제 TV 조회값으로 사용하지 않는다.
- 마지막 명령값과 마지막 실제 조회값을 구분한다.

### HDMI 전환 직후 타임아웃

- ACK 또는 최초 read-back 실패 직후 실패를 확정하지 않는다.
- 500ms 후 실제 입력을 다시 읽고 목표값과 비교한다.
- 최종 확인이 되지 않을 때만 `NO_DISPLAY_RESPONSE`로 보고한다.

### 부분 상태 조회 실패

- `display.status`는 전원, 입력, 볼륨을 각각 최대 2회 조회한다.
- 한 항목 실패로 전체 결과를 폐기하지 않는다.
- 결과에 `partial`, `errors`, `connection`, `retryCount`를 포함한다.
- `connection`은 `connected`, `standby`, `timeout`을 구분한다.

### 전체 제어 대상 오류

- 온라인 여부는 DB의 존재하지 않는 상태 컬럼이 아니라 최근 `last_seen_at` 120초를 기준으로 한다.
- 승인됨, 온라인, 지역 권한, `display.enabled` 조건은 서버가 계속 검사한다.

### 중복 명령 실행

- 서버는 결과를 받지 못한 delivered 명령을 최대 5회 재전달할 수 있다.
- Android는 완료된 `commandId`를 영속 저장하여 동일 명령을 다시 실행하지 않는다.
- 명령 실행과 로컬 완료기록을 먼저 확정한 후 서버 결과를 전송한다.

### USB 분리와 권한 오류

- `DEVICE_NOT_FOUND`, `USB_PERMISSION_REQUIRED`, `PORT_OPEN_FAILED`, `TIMEOUT`, `NAK_RECEIVED`, `CHECKSUM_ERROR`를 구분한다.
- USB 분리 시 진행 중 요청을 취소하고 포트를 닫는다.
- 동일 VID/PID 장치가 여러 개면 자동으로 임의 선택하지 않고 serial number 또는 관리자 지정값으로 구분한다.

## 7. 서버 호환성 보완 사항

기존 Windows 장비를 깨뜨리지 않도록 모든 변경은 선택 필드 추가 방식으로 한다.

- Heartbeat에 `platform: "android"`와 `capabilities`를 선택 필드로 추가한다.
- Android 장비에는 UME, i-vision, Windows 종료 기능이 없음을 capability로 표시한다.
- 관리 화면은 capability가 없는 Windows 전용 버튼을 숨기고 API도 거부해야 한다.
- Android 0.4.0 PoC부터 Windows Agent와 동일하게 QBC 모델 문자열을 기준으로 HDMI3를 지원한다.
- QET에는 HDMI3가 없으므로 장비의 `display.inputSources`와 `capabilities.supportedInputs`를 기준으로 서버가 버튼과 명령을 제한한다.
- 과거 Android 설정의 `QB75B` 값은 마이그레이션 호환을 위해 HDMI 3개 모델로 인식한다.

## 8. 전원 및 하드웨어 기준

- Android 장비는 TV USB가 아니라 별도 AC 어댑터로 전원을 공급한다.
- 제어기 한 세트의 설치 전력 예산은 Android Box, USB-to-RS232, 손실과 여유를 포함해 20~25W로 잡는다.
- TV 포함 배전 예산은 QE75T와 QB75B 모두 한 세트당 300W를 기본값으로 잡는다.
- USB-to-TTL 케이블은 금지하고 실제 RS232 레벨 변환 제품만 사용한다.
- Android Box의 USB Host 출력은 최소 5V/500mA여야 한다.
- Stick을 사용할 경우 전원과 USB Host를 동시에 지원하는 powered OTG hub가 필요하며 후보별 실물 검증 없이는 승인하지 않는다.

## 9. 단계별 개발 계획

### Phase A — 계약 고정 및 테스트 Fixture

- Windows MDC 테스트 벡터를 Android 테스트 Fixture로 복사한다.
- 서버 등록, Heartbeat, 명령 수신, 결과 보고 JSON 계약 테스트를 만든다.
- Android platform/capability의 서버 하위 호환 정책을 테스트한다.

완료 기준: Android 코드 없이도 요청/응답 JSON과 MDC 바이트 기대값이 테스트로 고정된다.

### Phase B — Android 로컬 제어 PoC

- USB 권한, 장치 검색, FTDI/CP210x Serial 연결을 구현한다.
- 전원, HDMI1/2, 볼륨, 상태 조회를 실행하고 QBC에서는 HDMI3도 검증한다.
- ACK/NAK, checksum, 부분 read, timeout, SET read-back을 단위 테스트한다.

완료 기준: QE75T와 QB75B 각각에서 100회 명령 반복 시 잘못된 성공 보고가 없다.

### Phase C — 기존 서버 연결

- 등록과 Android Keystore 토큰 저장을 구현한다.
- Heartbeat, command polling, result reporting을 연결한다.
- commandId 중복 방지와 네트워크 재전송을 구현한다.
- 서버 관리 화면에서 Android capability를 반영한다.

완료 기준: Windows Agent와 Android 앱이 같은 서버에서 동시에 동작하고 서로의 기능 버튼을 혼동하지 않는다.

### Phase D — 무인 운영 안정화

- 부팅 자동 시작, USB 자동 재연결, 배터리 최적화 제외 안내를 구현한다.
- 재부팅 10회, USB 탈착 30회, 네트워크 단절/복구, TV 대기/복귀를 시험한다.
- 72시간 무조작 soak test와 로그 용량 제한을 확인한다.

완료 기준: 사람의 앱 재실행 없이 서비스와 서버 연결이 복구되고, USB 권한 팝업이 재부팅마다 나타나지 않는다.

### Phase E — 설치 표준화

- 승인된 Android Box, 전원 어댑터, USB-to-RS232, Samsung Gender를 모델명까지 고정한다.
- APK 설치, 최초 권한, 절전 해제, 서버 등록, TV 설정 절차를 현장 체크리스트로 만든다.
- 서명된 release APK와 버전·해시를 관리한다.

## 10. 필수 검증 항목

1. Android Box 정전 복구 자동 부팅
2. 앱 자동 시작 및 Foreground Service 유지
3. 재부팅 후 USB 권한 유지
4. TV OFF 상태에서 RS232 전원 ON 성공
5. HDMI 전환 지연 시 실제 상태 재확인
6. USB read 분할 수신과 잘못된 checksum 거부
7. 케이블 분리·재연결 후 자동 복구
8. 인터넷 10분 단절 후 Heartbeat와 결과 재전송
9. 같은 commandId 재수신 시 TV 명령 중복 실행 방지
10. 최신 `display.status`가 과거 결과에 덮이지 않음
11. Android 장비에 Windows/UME/i-vision 명령이 노출되지 않음
12. QE75T에서 HDMI3가 노출되지 않음
13. 72시간 무조작 상태에서 서비스·USB·네트워크 유지

## 11. 현재 기준선

- 서버 Node 테스트: 통과
- 서버와 관리 UI JavaScript 구문 검사: 통과
- Windows Agent 빌드: 경고 0, 오류 0
- Windows Samsung MDC 단위 테스트: 전체 23개 통과
- 저장소의 기존 구현 변경 없이 본 기획 문서만 추가
