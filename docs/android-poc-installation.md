# Android TV Controller PoC 설치 및 시험

## 준비물

- Android TV Stick 또는 Box와 전용 전원 어댑터
- Android 9(API 28) 이상이 설치된 USB Host 지원 장비
- 전원 공급과 USB Host를 동시에 지원하는 powered OTG hub(스틱인 경우)
- FTDI, CP210x, Prolific 또는 CDC ACM 기반 USB-to-RS232 케이블
- Samsung RS232C IN Gender/3.5mm 변환 케이블
- Samsung QET 계열 또는 QBC 계열(QBC는 HDMI1/2/3 지원)
- 로컬서버 PC와 Android 장비가 접속할 수 있는 동일 LAN

USB-to-TTL 케이블은 사용하지 않는다. Android 장비 전원은 TV USB가 아닌 별도 어댑터에서 공급한다.

## 1. 로컬서버 실행

PowerShell에서 저장소 루트로 이동한 뒤 실행한다.

```powershell
.\scripts\Start-Android-PocLocalServer.ps1 `
  -AdminPassword "10자 이상의 PoC 관리자 비밀번호" `
  -EnrollmentKey "16자 이상의 PoC 장비 등록 키"
```

스크립트가 표시하는 `http://PC의-LAN-IP:4170` 주소를 Android 앱에 입력한다. Android에서 접속되지 않으면 관리자 PowerShell에서 `-OpenFirewall`을 추가해 Private 네트워크용 TCP 4170 규칙을 생성한다.

로컬서버 데이터는 `server/poc-data`에 유지된다. 기존 운영서버 데이터와 섞이지 않는다.

## 2. APK 빌드

```powershell
.\scripts\Build-Android-Poc.ps1
```

일반 PoC 결과는 `dist-android-poc/funnet-tv-controller-0.5.3-poc.apk`와 `SHA256SUMS.txt`이다. 앱의 최소 지원 버전은 Android 9(API 28)이다. 한글이 포함된 Windows 경로에서 JVM 단위 테스트 실행이 실패하면 영문 경로의 저장소 복사본 또는 Junction에서 빌드한다. APK 패키징 자체는 프로젝트의 `android.overridePathCheck=true` 설정으로 지원한다.

Funnet 현장 테스트용 고정 배포본은 등록키를 Git에 저장하지 않고 환경 변수로 전달해 빌드한다.

```powershell
$env:FUNNET_ANDROID_ENROLLMENT_KEY = "관리 서버에서 확인한 Funnet 지역 등록키"
.\scripts\Build-Android-FunnetTest.ps1
Remove-Item Env:FUNNET_ANDROID_ENROLLMENT_KEY
```

결과는 `dist-android-funnet-test/funnet-tv-controller-0.5.5-funnet-test.apk`이다. 이 배포본은 서버 `https://agent.funnet.kr`, Funnet 지역, TV Device ID `0`이 고정되어 서버 주소와 등록키를 리모컨으로 입력하지 않는다. 등록키가 APK에 포함되는 현장 시험 전용 파일이므로 외부 공개 저장소나 메신저에 배포하지 않는다. 0.5.3부터 USB 진단에 앱 내장 드라이버 목록, Android USB Host 기능, 마지막 attach/detach 이벤트와 접근 가능한 Linux sysfs USB 장치 목록이 함께 포함된다. 0.5.4부터 주기적인 USB 점검이 마지막 명령의 수신·포트 열기·송신·수신/타임아웃 기록을 덮어쓰지 않으며, 명령 ID와 단계별 이벤트 이력을 함께 보존한다. 0.5.5부터 PL2303 USB bulk 응답을 패킷 단위로 읽고 남은 바이트를 내부 버퍼에 보존해 Samsung MDC ACK가 유실되지 않도록 한다.

## 3. Android 스틱 설치

개발자 옵션과 USB 디버깅을 켜고 PC에서 장치가 `adb devices`에 보이는지 확인한다.

```powershell
.\scripts\Install-Android-Poc.ps1
```

네트워크 ADB를 쓰거나 여러 장치가 연결된 경우 `-DeviceSerial`에 `adb devices`의 장치 ID를 지정한다. ADB를 쓸 수 없는 장비는 APK를 USB 메모리에 복사해 파일 관리자에서 설치한다. 출처를 알 수 없는 앱 설치 허용이 필요할 수 있다.

## 4. 최초 앱 설정

1. 서버 주소에 `http://PC-LAN-IP:4170` 입력
2. 로컬서버 실행 시 사용한 등록 키 입력
3. 장비 이름과 TV 모델, TV Display ID 입력(기본 0)
4. `설정 저장 및 서비스 시작` 선택
5. USB 접근 창에서 허용하고 가능한 경우 항상 사용 선택
6. 배터리 최적화에서 Funnet TV Controller를 제한 없음/최적화 제외로 설정
7. Android 자동 절전과 앱 자동 정리 기능 해제

서비스가 실행되는 동안 앱은 화면을 켜지 않고 CPU 동작만 유지하는 부분 Wake Lock을 사용한다. 시스템 감시 알람도 주기적으로 서비스를 확인해 제조사 절전 또는 프로세스 종료 후 재기동을 시도한다. 앱 화면의 `절전 감시` 항목에서 마지막 활성화 또는 복구 상태를 확인할 수 있다.

서버 주소가 바뀌었거나 서버에서 장비를 삭제했다면 앱의 `서버 장비 등록 초기화`를 선택하고 새 등록 키로 다시 등록한다.

## 5. 서버 승인과 제어

1. PC에서 `http://127.0.0.1:4170` 접속
2. 관리자 계정으로 로그인
3. 장비 관리에서 `Android TV PoC` 장비 승인
4. TV 제어에서 현재 상태 조회
5. 전원 ON/OFF, HDMI1/2, 볼륨 순서로 시험하고 QBC 모델은 HDMI3도 확인

Android 장비에는 UME, i-vision, Windows 종료 기능이 표시되거나 전송되지 않아야 한다.

## 6. TV 설정

- TV Device ID와 앱 Display ID를 동일하게 설정한다.
- 앱에서 실제 TV 계열을 선택한다. QET 계열은 HDMI1/2, QBC 계열은 HDMI1/2/3으로 서버에 보고한다.
- PC Connection Cable/연결 케이블을 RS232C로 설정한다.
- 대기 중 원격제어와 Remote Configuration 관련 옵션을 허용한다.
- 자동 전원 끄기와 최대 절전 설정은 PoC 동안 해제한다.

## 7. 필수 시험

- 앱 설치 후 USB 접근 허용
- TV 상태 조회가 `connected` 또는 전원 OFF 시 `standby`로 표시
- HDMI 전환 지연 후 실제 상태가 올바르게 반영
- USB 케이블 분리 후 재연결 복구
- Wi-Fi 단절 후 복구
- Android 재부팅 후 서비스 자동 시작
- 재부팅 후 USB 권한 재요청 여부 확인
- 화면을 끄고 1시간 후 서버 Heartbeat와 TV 제어 확인
- 최종적으로 72시간 무조작 유지 시험

PoC에서 재부팅마다 USB 권한창이 나타나거나 제조사 절전 기능이 서비스를 종료하면 해당 스틱은 무인 운영 후보에서 제외하고 산업용 Android Box로 전환한다.
