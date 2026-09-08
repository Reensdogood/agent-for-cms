**“이 문서를 먼저 읽고, 범위를 벗어나지 말고 순서대로 구현하라”**

`P2_SAMSUNG_DISPLAY_CONTROL.md`를 이번 작업의 authoritative implementation plan으로 사용한다.

먼저 `AGENTS.md`와 P2 문서를 끝까지 읽고 현재 `main` 브랜치와 실제 repository 구조를 검사한다.

기존 별도 branch에서 진행 중인 PC Remote Control 작업은 수정하거나 merge하지 않는다.

추정으로 framework, directory, CI/CD command 또는 deployment 구조를 만들지 말고 현재 repository에서 확인된 사실을 기준으로 작업한다.

P2-1부터 순서대로 진행한다. 각 단계에서는 변경 범위에 직접 관련된 테스트만 먼저 실행한다. 관련 테스트가 통과하기 전에는 다음 단계로 넘어가지 않는다.

Samsung MDC protocol 값은 코드에 넣기 전에 Samsung 공식 문서와 QE75T 호환성을 확인한다.

특히 다음은 절대 하드코딩하지 않는다.

- COM3
- PC별 Serial Port
- 환경별 Server 주소
- credential/secret

COM3은 기본 추천값일 뿐이다.

NEXT-340PL / Prolific PL23XX 장치를 탐지하고 Driver Missing 상태를 식별하되, 이번 P2에서 Driver 자동설치는 구현하지 않는다.

Frontend 주요 UI 구현이 완료되면 `apple-design` skill을 reviewer로 사용해 디자인을 점검하고 필요한 수정만 반영한다.

전체 regression/build/security 검사는 P2 기능 구현이 완료된 뒤 수행한다.

작업 중 `P2_SAMSUNG_DISPLAY_CONTROL.md`의 Progress Tracking을 실제 진행상황에 맞게 갱신한다.

범위를 확대하지 않는다.

작업을 시작하라.


# P2 — Samsung LH75QET Serial Display Control

## 0. Purpose

이번 P2의 목표는 Windows Agent와 중앙 관리 Server에 **Samsung LH75QET / QE75T Signage 제어 기능**을 추가하고 실제 운영 환경에 배포 가능한 수준까지 완성하는 것이다.

이번 작업은 현재 `main`을 기준으로 진행한다.

기존 별도 branch에서 개발 중인 **PC Remote Control 기능은 이번 P2에 포함하지 않는다.**

P2의 우선순위는 다음과 같다.

```text
1. Serial Adapter / COM Port 인식
2. Samsung TV 연결 확인
3. Agent Local Display Control
4. TV 상태 조회
5. Server Individual Control
6. Server Bulk Control
7. UI
8. Test
9. Deployment
```

Codex는 위 순서를 임의로 변경하지 않는다.

---

# 1. Target Environment

## Display

Target Model:

```text
Samsung LH75QET
Samsung QE75T family
```

Physical connection:

```text
Windows PC
    │
    │ USB
    ▼
NEXT-340PL USB-to-Serial Adapter
    │
    │ RS-232C
    ▼
Samsung LH75QET
RS232C IN
```

현장에서 케이블 및 물리 연결은 이미 확인되었다.

따라서 이번 개발 범위에서:

```text
RS232 cable pinout 확인
케이블 선정
어댑터 구매 검증
```

은 제외한다.

---

# 2. Serial Adapter

현장 사용 USB Serial Adapter:

```text
NEXT-340PL
```

Chip / Driver Family:

```text
Prolific PL23XX / PL2303 계열
```

Agent는 PC마다 COM Port가 다를 수 있다는 것을 전제로 개발한다.

예:

```text
PC-001 → COM3
PC-002 → COM4
PC-003 → COM5
```

`COM3`은 현장에서 가장 흔한 기본값일 뿐이다.

## 절대 금지

```text
COM3 하드코딩
```

---

# 3. Serial Communication Parameters

Samsung MDC RS-232 기본 설정:

```text
Baud Rate   : 9600 bps
Data Bits   : 8
Parity      : None
Stop Bits   : 1
Flow Control: None
```

즉:

```text
9600 / 8N1 / No Flow Control
```

을 기본값으로 사용한다.

프로토콜 구현 전에 대상 QE75T 문서와 Samsung MDC 공식 문서를 다시 확인한다.

---

# 4. Samsung MDC Protocol

Samsung Multiple Display Control protocol을 직접 구현한다.

MagicINFO는 사용하지 않는다.

LAN/Wi-Fi MDC도 이번 P2에서는 사용하지 않는다.

Transport:

```text
RS-232C
```

Packet 기본 구조:

```text
Header
Command
ID
Data Length
Data
Checksum
```

Header:

```text
0xAA
```

Checksum은 CRC가 아니다.

정확한 용어는:

```text
Samsung MDC Checksum
```

이다.

Checksum 계산은 Header `0xAA`를 제외한 나머지 바이트 합계의 하위 8bit를 사용한다.

---

# 5. Required MDC Commands

이번 P2에서 필요한 명령만 구현한다.

## Power

```text
Command: 0x11
```

Required:

```text
Get Power
Set Power ON
Set Power OFF
```

Power:

```text
0x00 = OFF / Standby
0x01 = ON
```

Power ON은:

```text
AC power connected
Display standby
```

상태에서 동작해야 한다.

AC가 물리적으로 차단된 상태는 지원 대상이 아니다.

---

# 6. Input Source

Input Source:

```text
Command: 0x14
```

이번 P2에서 지원하는 입력:

```text
HDMI1
HDMI2
```

Expected Samsung MDC source codes:

```text
HDMI1 = 0x21
HDMI2 = 0x23
```

Codex는 구현 전에 대상 QE75T 호환 MDC 문서에서 값을 재확인하고 constant로 정의한다.

예:

```text
SamsungInput.HDMI1
SamsungInput.HDMI2
```

raw hex value를 비즈니스 로직 전체에 흩어놓지 않는다.

---

# 7. Volume

Volume:

```text
Command: 0x12
```

Range:

```text
0 ~ 100
```

Required:

```text
Get Volume
Set Volume
```

Server Individual Control에서만 제공한다.

Bulk Control에는 Volume을 넣지 않는다.

---

# 8. Brightness

Brightness:

```text
Command: 0x25
```

Range:

```text
0 ~ 100
```

Required:

```text
Get Brightness
Set Brightness
```

Server Individual Control에서만 제공한다.

Bulk Control에는 Brightness를 넣지 않는다.

MDC Brightness 기능은 모델/현재 Picture Mode/Input 상태의 제약 가능성을 고려한다.

Unsupported / rejected response가 오면:

```text
명령 실패
```

로 정확히 처리하고 정상 성공으로 표시하지 않는다.

---

# 9. Agent Functional Scope

Agent의 Samsung Display module은 최소 다음 인터페이스를 제공한다.

```text
power_on()
power_off()

set_hdmi1()
set_hdmi2()

set_volume(value)
set_brightness(value)

get_power()
get_input()
get_volume()
get_brightness()
```

가능하면 실제 내부 API는 enum/type-safe 구조를 사용한다.

예:

```text
set_power(PowerState.ON)
set_input(DisplayInput.HDMI1)
```

---

# 10. Serial Adapter Detection

Agent가 시작될 때 Windows의 Serial Port 목록을 확인한다.

확인 가능한 Windows API/WMI/CIM/PnP 정보를 사용한다.

확인 대상 정보:

```text
COM Port
Device Name
Description
Manufacturer
PNPDeviceID
Device Status
```

NEXT-340PL은 Prolific 계열로 나타날 가능성이 높으므로 다음 특성을 후보 검색에 활용한다.

```text
Prolific
PL2303
PL23XX
USB-to-Serial
```

단 하나의 문자열만으로 장치를 확정하지 않는다.

---

# 11. COM Port Selection Logic

우선순위:

```text
1. 기존 저장 설정에 지정된 COM Port
2. NEXT-340PL / Prolific 후보 자동검색
3. COM3
4. 기타 사용 가능한 Serial Port
```

그러나 `COM3`을 강제로 사용해서는 안 된다.

---

# 12. Auto Detection

Startup 시:

```text
Agent Start
    ↓
Enumerate Serial Ports
    ↓
Load previous configured port
    ↓
Configured port exists?
    ├─ YES → Open/Test
    └─ NO
        ↓
Detect Prolific candidates
        ↓
candidate == 1 ?
    ├─ YES → Test candidate
    └─ NO → Configuration Required
```

후보가 하나라고 해서 단순 장치명만 보고 확정하면 안 된다.

가능하면 Samsung MDC 상태조회 명령을 보내 실제 TV 응답을 확인한 뒤 정상 포트로 판정한다.

---

# 13. Driver Detection

Agent는 PL23XX Driver 설치 여부 또는 Device 정상 동작 여부를 확인한다.

이번 P2에서는:

```text
Driver 자동 설치
Driver 자동 업데이트
Driver 다운로드
```

는 하지 않는다.

지원 범위는:

```text
Driver Installed
Driver Missing
Driver Error
Device Not Detected
Unknown
```

상태를 판별해서 서버와 Local UI에 표시하는 것까지이다.

예:

```text
Serial Adapter
----------------------------
Device : NEXT-340PL / Prolific
Driver : Installed
Port   : COM3
Status : Ready
```

드라이버가 없으면:

```text
Serial Adapter
----------------------------
Device : Prolific USB Serial
Driver : Missing
Port   : -
Status : Driver installation required
```

관리자가 원격 접속해서 드라이버를 설치하는 운영방식을 사용한다.

---

# 14. Device Error Handling

다음 상황을 구분한다.

```text
DRIVER_MISSING
DEVICE_NOT_FOUND
PORT_NOT_FOUND
PORT_BUSY
PORT_OPEN_FAILED
NO_DISPLAY_RESPONSE
CHECKSUM_ERROR
NAK_RECEIVED
TIMEOUT
UNSUPPORTED_COMMAND
```

단순히 모든 오류를:

```text
TV ERROR
```

로 처리하지 않는다.

운영자가 원인을 알 수 있어야 한다.

---

# 15. Persisted Agent Configuration

PC별 설정을 저장한다.

예시:

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

Baud / parity 등의 Samsung 고정값은 일반 사용자가 변경할 필요가 없다.

필요한 경우 내부 advanced setting으로만 둔다.

---

# 16. COM Reassignment

USB Serial Device 재연결이나 Windows 재부팅 등으로 COM 번호가 달라질 수 있다.

Agent는 저장된 COM port가 사라졌을 때 즉시 fatal error로 끝내지 않는다.

```text
Configured COM missing
    ↓
Re-enumerate ports
    ↓
Find PL23XX candidate
    ↓
Samsung MDC probe
    ↓
Valid response?
    ├─ YES → candidate detected
    └─ NO → configuration required
```

자동으로 새 포트를 저장할지 여부는 기존 Agent 설정 구조와 운영정책에 맞게 결정한다.

자동 변경이 위험하다고 판단되면:

```text
Detected COM5
Configured COM3
```

상태만 Server에 보고하고 관리자 승인 후 저장한다.

---

# 17. Samsung Device Connection Validation

Serial Port open 성공만으로 TV 연결 성공으로 판단하지 않는다.

반드시 Samsung MDC Query를 하나 이상 수행한다.

권장:

```text
Get Power Status
```

가능하면 Power ON 상태에서는:

```text
Get Input
Get Volume
Get Brightness
```

도 수행한다.

---

# 18. ACK / NAK Handling

Samsung MDC ACK/NAK 응답을 처리한다.

SET 명령 성공 판단은 단순히:

```text
Serial write success
```

가 아니다.

최소:

```text
Command sent
→ ACK
→ state re-read
→ expected state confirmed
```

방식을 사용한다.

---

# 19. Verification after Control

예:

## Power ON

```text
Send Power ON
↓
ACK
↓
wait appropriate short interval
↓
Get Power
↓
ON?
    YES → SUCCESS
    NO  → FAILED
```

## HDMI2

```text
Send HDMI2
↓
ACK
↓
Get Input
↓
HDMI2?
    YES → SUCCESS
    NO  → FAILED
```

## Volume

```text
Set Volume 30
↓
ACK
↓
Get Volume
↓
30?
```

Brightess도 동일하다.

---

# 20. State Polling

Agent는 TV 상태를 지나치게 자주 polling하지 않는다.

기본 원칙:

```text
Agent startup
명령 실행 직후
정기 heartbeat/status interval
```

정기 상태조회는 기존 Agent heartbeat 구조를 우선한다.

별도 polling이 필요하면:

```text
30 ~ 60 seconds
```

정도에서 결정한다.

불필요한 1초 단위 polling을 만들지 않는다.

---

# 21. Agent Status Model

Server에 최소 다음 값을 제공한다.

```json
{
  "display": {
    "serial_connected": true,
    "port": "COM3",
    "driver_status": "installed",
    "power": "on",
    "input": "hdmi1",
    "volume": 30,
    "brightness": 50,
    "last_seen": "..."
  }
}
```

실제 프로젝트 naming convention을 따른다.

---

# 22. Server Individual Control

관리자는 개별 Agent/PC 화면에서 해당 TV를 제어할 수 있어야 한다.

Required controls:

```text
Power ON
Power OFF

HDMI1
HDMI2

Volume
Brightness
```

Display status:

```text
Serial Connection
COM Port
Driver Status

TV Power
Input
Volume
Brightness

Last Response
```

---

# 23. Individual Control UI

예:

```text
Samsung Display

Serial      Connected
COM Port    COM3
Driver      Installed

Power       ON
Input       HDMI1
Volume      30
Brightness  55

[ ON ] [ OFF ]

[ HDMI 1 ] [ HDMI 2 ]

Volume
[-] 30 [+]

Brightness
[-] 55 [+]
```

Volume / Brightness UI는 지나치게 복잡하게 만들지 않는다.

권장:

```text
number input
small +/- controls
```

슬라이더는 기존 디자인 시스템에 적합하면 사용할 수 있으나 필수는 아니다.

---

# 24. apple-design QA

Frontend 주요 UI 변경 후 프로젝트에 설치된:

```text
apple-design
```

Skill로 Design QA를 수행한다.

apple-design은 화면 전체 재설계 도구가 아니다.

검수 항목:

```text
Visual hierarchy
Spacing
Typography
Alignment
Button clarity
Status readability
Error readability
Responsive behavior
Accessibility
Professional management-console appearance
```

기존 UI Design System을 우선한다.

---

# 25. Server Bulk Control

서버는 여러 Agent에 Display 명령을 동시에 보낼 수 있어야 한다.

이번 P2 Bulk Control에서 허용되는 명령은 정확히 네 개다.

```text
ALL TV ON

ALL TV OFF

ALL HDMI1

ALL HDMI2
```

---

# 26. Bulk Control — Explicitly Prohibited

Bulk Control에서 다음 기능은 구현하지 않는다.

```text
Volume
Brightness
Mute
```

운영 실수 위험 때문에 이번 범위에서 제외한다.

---

# 27. Bulk Target

기존 서버에 Site / Group 개념이 있으면 해당 구조를 사용한다.

새로운 그룹 시스템을 임의로 만들지 않는다.

최소한:

```text
All registered active Agents
```

에 명령을 fan-out할 수 있어야 한다.

Offline Agent 처리정책도 정의한다.

---

# 28. Bulk Command Execution

중앙 Server가 TV에 직접 RS232 명령을 보내지 않는다.

Architecture:

```text
Admin Web
    ↓
Management Server
    ↓
Logical Display Command
    ↓
Windows Agent
    ↓
Serial COM
    ↓
LH75QET
```

Server는 Samsung MDC byte protocol을 알 필요가 없다.

MDC implementation은 Agent에만 존재한다.

---

# 29. Bulk Result

전체 명령 실행 결과를:

```text
전체 성공/실패
```

한 값으로만 표시하지 않는다.

예:

```text
TV Power ON

Total      80
Success    76
Failed      3
Offline     1
```

실패 목록:

```text
Site 018  → COM Port unavailable
Site 036  → Display timeout
Site 051  → NAK
Site 077  → Agent offline
```

를 확인할 수 있어야 한다.

---

# 30. Confirmation for Bulk Commands

전체 Power OFF 같은 영향력이 큰 명령은 사용자 실수를 방지해야 한다.

예:

```text
80대 TV의 전원을 끕니다.

[Cancel]
[Power OFF]
```

같은 최소 확인 절차를 사용한다.

불필요하게 복잡한 승인 workflow까지 만들지는 않는다.

---

# 31. API Contract

기존 Server API 패턴을 우선한다.

새 API를 설계할 경우 logical command를 사용한다.

예시:

```text
POST /agents/{agentId}/display/power

POST /agents/{agentId}/display/input

POST /agents/{agentId}/display/volume

POST /agents/{agentId}/display/brightness

GET /agents/{agentId}/display/status
```

Bulk:

```text
POST /display/bulk/power

POST /display/bulk/input
```

실제 path naming은 기존 프로젝트 규칙에 맞춘다.

---

# 32. Security

Display control command 역시 인증/인가를 통과해야 한다.

특히:

```text
Bulk Power OFF
Bulk Power ON
Bulk Input Change
```

는 일반 Agent heartbeat API와 동일하게 취급하면 안 된다.

기존 관리자 권한 체계가 있다면 반드시 사용한다.

새 인증 시스템을 P2에서 임의로 만들지 않는다.

---

# 33. Logging

다음은 Audit log에 남기는 것을 권장한다.

```text
User
Command
Target
Timestamp
Result
```

예:

```text
admin
DISPLAY_POWER_OFF
ALL
2026-xx-xx xx:xx
78 Success / 2 Failed
```

Serial raw packet 전체를 일반 운영로그에 과도하게 저장하지 않는다.

Debug 모드에서만 raw TX/RX를 허용한다.

---

# 34. Out of Scope

이번 P2에서 명확히 제외한다.

```text
PC Remote Desktop
PC Remote Control
Screen Capture

MagicINFO
LAN MDC
Wi-Fi TV Control

Firmware Management
Content Management

TV Scheduling
Volume Bulk Control
Brightness Bulk Control

Automatic Driver Installation
Driver Distribution
Driver Update

Multi-vendor Display
LG Display
Other Samsung Models
```

Codex는 이번 P2에서 위 기능으로 범위를 확대하지 않는다.

---

# 35. Testing Strategy

개발 중에는 변경 범위 중심 테스트만 실행한다.

```text
Serial packet unit tests
Checksum tests
Response parser tests

Port enumeration tests
Driver-state tests

Display service tests

Server command tests
Bulk fan-out tests

Frontend related tests
```

작은 변경마다 전체 repo 테스트를 실행하지 않는다.

---

# 36. Mandatory Unit Tests

최소 테스트:

```text
MDC checksum

Power packet
HDMI1 packet
HDMI2 packet
Volume packet
Brightness packet

ACK parsing
NAK parsing

Timeout
Invalid checksum

COM unavailable
COM busy

PL23XX device detected
Driver missing

Samsung probe success
Samsung probe failure
```

---

# 37. Mocking

자동테스트에서 실제 COM Port나 실제 TV가 필요하도록 만들지 않는다.

Serial Transport를 interface/adapter로 분리해 mock 가능하게 한다.

예:

```text
SerialTransport
    ├─ WindowsSerialTransport
    └─ FakeSerialTransport
```

MDC protocol layer와 Serial transport layer를 분리한다.

---

# 38. Hardware Integration Test

최종 P2에서는 실제:

```text
NEXT-340PL
Samsung LH75QET
```

한 세트를 사용한 Integration Test가 반드시 필요하다.

Test Matrix:

```text
Driver installed

Detect COM

Get Power OFF

Power ON from Standby

Get Power ON

HDMI1

HDMI2

Volume 20
Volume 50

Brightness 30
Brightness 60

Power OFF

Power ON again
```

---

# 39. Reboot / Reconnect Test

다음도 현장에서 확인한다.

```text
Windows reboot

Agent restart

USB serial disconnect/reconnect

TV standby

TV AC reconnect
```

이후 Agent가 정상 상태로 복귀하는지 확인한다.

---

# 40. Failure Test

다음 상태를 인위적으로 테스트한다.

```text
USB Serial unplugged

Wrong COM configured

TV disconnected

Driver missing

Port opened by another application

TV not responding
```

서버 UI가 명확한 상태를 표시해야 한다.

---

# 41. CI / Regression

P2 기능 구현 중에는 관련 테스트만 실행한다.

P2 완료 후:

```text
Agent full tests

Server full tests

Frontend lint

Frontend typecheck

Frontend tests

Build

Security scan

Secret scan
```

현재 repository에 실제로 존재하는 tool과 script만 사용한다.

존재하지 않는 command를 임의로 추가하지 않는다.

---

# 42. Deployment

이번 P2는 코드 구현에서 끝내지 않고 실제 배포까지 수행한다.

단계:

```text
1. Local development
2. Hardware integration test
3. Server integration
4. Frontend validation
5. Full regression
6. Build package
7. Test Agent installation/update
8. Server deployment
9. Small pilot
10. Wider deployment
```

---

# 43. Pilot Deployment

80대에 한꺼번에 바로 배포하지 않는다.

권장:

```text
1 PC
↓
3~5 PCs
↓
10 PCs
↓
remaining PCs
```

각 단계에서:

```text
Agent online
Serial driver
COM detection
TV query
TV Power
Input
```

을 확인한다.

---

# 44. Driver Deployment Policy

이번 버전에서 Agent가 Driver를 자동 설치하지 않는다.

운영 절차:

```text
Agent detects driver missing
↓
Server displays "Driver installation required"
↓
Administrator remote access
↓
Install Prolific PL23XX driver
↓
Reconnect / restart Agent
↓
Agent detects COM
↓
Samsung MDC probe
```

---

# 45. Existing Remote-Control Branch

기존 PC 원격제어 개발 branch는 이번 작업과 분리한다.

이번 P2에서:

```text
merge
rebase
rewrite
modify
```

하지 않는다.

Samsung Display Control P2는:

```text
main
```

의 현재 기준에서 작업한다.

---

# 46. Acceptance Criteria

P2 완료 조건은 아래를 모두 만족해야 한다.

## Agent

- NEXT-340PL/PL23XX 장치 상태 확인
- Driver 상태 확인
- COM Port 확인
- COM 설정 저장
- COM3 하드코딩 없음
- Samsung TV 응답 확인

## Display Control

- Standby → Power ON 성공
- Power OFF 성공
- HDMI1 성공
- HDMI2 성공
- Volume Set/Get 성공
- Brightness Set/Get 성공

## Status

- Power 조회
- Input 조회
- Volume 조회
- Brightness 조회
- Serial 상태 조회
- Driver 상태 조회

## Server Individual

- Power
- HDMI
- Volume
- Brightness

## Server Bulk

- All ON
- All OFF
- All HDMI1
- All HDMI2

## Reliability

- ACK/NAK 처리
- Timeout 처리
- state verification
- failure reporting

## Deployment

- Hardware Pilot 성공
- Regression 통과
- 배포 문서 작성
- Rollback 방법 확인

---

# 47. Codex Execution Rules

Codex는 작업을 시작하기 전에 반드시:

```text
1. AGENTS.md 읽기
2. 이 P2 문서 읽기
3. 현재 main 확인
4. existing branch 확인
5. 현재 Agent 구조 확인
6. 현재 Server 구조 확인
7. 현재 Frontend 구조 확인
8. 현재 test/build/deployment command 확인
```

한다.

추정으로 framework나 directory를 생성하지 않는다.

---

# 48. Implementation Order

반드시 다음 순서를 우선한다.

```text
P2-1
Repository / Architecture inspection

P2-2
Serial Port abstraction

P2-3
Windows Port / PL23XX detection

P2-4
Samsung MDC packet implementation

P2-5
Power/Input/Volume/Brightness status

P2-6
Individual control

P2-7
Agent → Server status reporting

P2-8
Server API

P2-9
Individual UI

P2-10
Bulk control

P2-11
apple-design review

P2-12
Hardware integration test

P2-13
Regression

P2-14
Pilot deployment

P2-15
Production rollout
```

하나의 큰 변경으로 전부 구현하지 않는다.

각 단계는 관련 테스트 통과 후 다음 단계로 간다.

---

# 49. Progress Tracking

Codex는 이 파일에 진행상태를 업데이트한다.

예:

```text
[ ] P2-1 Repository inspection
[ ] P2-2 Serial Port layer
[ ] P2-3 PL23XX detection
[ ] P2-4 Samsung MDC
[ ] P2-5 Display status
[ ] P2-6 Individual control
[ ] P2-7 Server reporting
[ ] P2-8 Server API
[ ] P2-9 Frontend
[ ] P2-10 Bulk control
[ ] P2-11 Design review
[ ] P2-12 Hardware test
[ ] P2-13 Regression
[ ] P2-14 Pilot
[ ] P2-15 Production deployment
```

Codex는 작업 종료 시 완료한 항목만 `[x]` 처리한다.

테스트하지 않은 항목을 완료 처리하지 않는다.

## Current Progress (2026-09-08)

- [x] P2-1 Repository inspection
- [x] P2-2 Serial Port layer
- [x] P2-3 PL23XX detection
- [x] P2-4 Samsung MDC (confirmed commands; Brightness SKIP)
- [ ] P2-5 Display status
- [ ] P2-6 Individual control
- [ ] P2-7 Server reporting
- [ ] P2-8 Server API
- [ ] P2-9 Frontend
- [ ] P2-10 Bulk control
- [ ] P2-11 Design review
- [ ] P2-12 Hardware test
- [ ] P2-13 Regression
- [ ] P2-14 Pilot
- [ ] P2-15 Production deployment

### P2-1 Inspection Record

- Base branch: local `main` at production release `1.0.0` (`94efb6e`).
- Deferred PC remote-control work: preserved separately as local `P2-Branch` at `c8098a4`; not merged, rebased, rewritten, or modified by this P2.
- Repository instructions: current `main` has no `AGENTS.md` or `agent.md`; this P2 file is the authoritative plan.
- Agent: .NET 8 Windows Forms tray application, `net8.0-windows`, self-contained `win-x64`, no package dependencies, HTTP heartbeat every 30 seconds and command polling every 5 seconds by default.
- Identity/authentication: immutable installation UUID plus server device UUID; the per-device bearer token is protected locally with Windows DPAPI.
- Server: Node.js 24 built-in HTTP server and `node:sqlite`, with HttpOnly admin sessions, CSRF, API-side roles, SQLite commands/audit, and no external npm runtime dependencies.
- Frontend: static `index.html`, `app.js`, and `styles.css`; no frontend framework, lint, typecheck, or separate frontend test command exists.
- Existing scope to reuse: device heartbeat/status JSON, logical command queue/result reporting, device/region targeting, API-side admin/operator authorization, audit log, and release builder.
- Build/test commands verified from the repository: `npm test`, Agent `dotnet build`, installer build through `scripts/Build-Release.ps1`, Docker/Compose deployment described in `README.md` and `DEVELOPMENT_CONTEXT.md`.
- CI: no `.github` workflow or other CI configuration exists in the current repository.
- Local hardware inventory during inspection: only motherboard serial `COM1` was present; no NEXT-340PL, Prolific, PL2303/PL23XX, or USB-to-Serial candidate was connected. This is not a hardware acceptance test.
- Official QE75T confirmation: Samsung's QE75T support page identifies the QET Series QE75T and lists `RS232C(in) thru stereo jack` as external control. The official English user manual (BN81-19339A-04, 2025-04-25) documents 9600 bps, 8 data bits, no parity, 1 stop bit, and no flow control on page 35.
- Official MDC values confirmed from that QE75T manual: header `0xAA`; checksum excludes the header; Power `0x11`; Volume `0x12`; Input Source `0x14`; HDMI1 `0x21`; HDMI2 `0x23`; ACK/NAK response command `0xFF` with `'A'`/`'N'` and returned command byte.
- Brightness decision: the QE75T manual's MDC command table and command pages do **not** document Brightness `0x25`. Per project decision, Brightness Get/Set is **SKIP** for this P2 and is excluded from the supported command set and bulk controls. No guessed packet is sent.
- Official sources: `https://www.samsung.com/us/business/support/owners/product/qet-series-digital-signage-qe75t/` and `https://downloadcenter.samsung.com/content/UM/202505/20250522165027679/BN81-19339A-04_WEB_LFD-Y20-T_SERIES-Stand_Alone_NA_ZB_ENG_250425.0.pdf`.

### P2-2 Completion Record

- Added a mockable raw serial transport/factory boundary and a Windows `System.IO.Ports` adapter.
- Samsung transport settings are type-safe 9600/8N1 with no handshake. A caller-supplied port is mandatory; no PC-specific COM port is selected or embedded in the transport.
- Port-open, port-busy, read-timeout, cancellation, read/write, input-buffer discard, and deterministic disposal behavior are separated from the later MDC protocol layer.
- Added the complete P2 display error-code vocabulary without collapsing distinct failures into a generic TV error.
- Added a dedicated Agent test project and fake serial transport. Focused P2-2 tests: 2 passed, 0 failed.

### P2-3 Completion Record

- Added disposable, read-only Windows WMI/PnP enumeration for COM port, name, description, manufacturer, PNPDeviceID, device status, service, and `ConfigManagerErrorCode`.
- NEXT-340PL/PL23XX candidacy requires the Prolific USB vendor ID or at least two independent product/brand/chip/USB-serial signals; one generic string does not confirm a candidate.
- Driver states distinguish Installed, Missing (Windows problem code 28), Error, DeviceNotDetected, and Unknown. No driver install/download/update path exists.
- Selection order is configured port, one healthy Prolific candidate, existing COM3 as probe-only recommendation, then a sole other port. Multiple Prolific candidates require configuration. Every selected port still requires Samsung MDC probe before it can be considered a connected display.
- Focused P2-3 tests: 7 passed, 0 failed. Actual Windows `--display-port-test` found only `COM1`, correctly reported no Prolific device, and returned COM1 only as a probe candidate. NEXT-340PL hardware and missing-driver integration remain P2-12.

### P2-4 Partial Record

- Implemented the officially documented QE75T packet envelope, low-8-bit checksum, Get/Set packet builders, response length/display-ID/returned-command validation, and explicit ACK/NAK parsing.
- Added type-safe confirmed commands and values only: Power `0x11`, Volume `0x12`, Input `0x14`, HDMI1 `0x21`, and HDMI2 `0x23`.
- Added serial exchange behavior with partial-read handling, timeout propagation, ACK validation, and mandatory state re-read after Set. Broadcast display ID `0xFE` is rejected because Samsung documents that broadcast commands do not return ACK.
- Focused P2-4 confirmed-protocol/client tests: 14 passed, 0 failed after the timeout case was added.
- Brightness Get/Set is intentionally SKIPPED because `0x25` is not documented for QE75T; the client returns `UNSUPPORTED_COMMAND` without writing any packet. Power/Input/Volume protocol work is complete for this stage; hardware verification remains P2-12.

### Agent/Server Integration Record (2026-09-08)

- Agent persisted configuration now accepts `display.enabled`, `display.vendor`, `display.model`, and an optional administrator-selected `display.port`.
- Agent command execution supports logical `display.power`, `display.input` (HDMI1/HDMI2), and `display.volume` commands. Every SET uses Samsung ACK plus state re-read verification; Brightness is not exposed.
- Server added authenticated, role-checked individual endpoints: `POST /api/devices/{id}/display/power`, `/input`, `/volume`, plus `GET /api/devices/{id}/display/status`.
- Server endpoints enqueue logical commands only; Samsung MDC bytes remain inside the Windows Agent.
- Server API tests and Agent Release build pass. Hardware status polling, heartbeat display payload, bulk commands, frontend, and deployment remain subsequent P2 steps.
- Added authenticated Bulk Power ON/OFF and Bulk Input HDMI1/HDMI2 queue APIs. Brightness is intentionally excluded.
- Added `docs/p2/deployment.md` with Agent/Server packaging, configuration, checksum verification, and rollback procedure.

---

# 50. Final Report

P2 종료 시 반드시 다음을 보고한다.

```text
Implemented

Files Changed

Agent Changes

Server Changes

Frontend Changes

Samsung MDC Commands Implemented

Serial/Driver Detection

Tests Executed

Hardware Test

apple-design Review

Known Issues

Deferred

Deployment Result

Rollback Status
```

---

# 51. Primary Rule

이번 P2의 성공기준은 기능 숫자가 아니다.

목표는:

```text
80대 Windows Agent 환경에서
Samsung LH75QET를
안정적으로 식별하고
안정적으로 제어하고
중앙서버에서 상태와 실패 원인을
확인할 수 있게 만드는 것
```

이다.

기능을 임의로 추가하지 않는다.

**Power / HDMI / Volume / Brightness / Serial 상태 관리에 집중한다.**
