# 전용 PC 빌드 러너

운영 서버의 업데이트 배포 화면에서 지역과 제품을 선택하면 전용 Windows PC가 빌드 작업을 가져와 결과물을 자동 등록한다.

- `windows_agent`: 지역 서버 주소·등록키를 포함한 Windows 설치 EXE
- `meetingbar_a10`: 지역 서버 주소·등록키, TV 모델과 Display ID 0을 포함한 A10 APK
- 지역 등록키와 러너 키는 브라우저 및 빌드 로그에 출력하지 않는다.
- 결과 파일은 서버가 다시 SHA-256으로 계산한 뒤 배포 목록에 등록한다.

관리자 PowerShell에서 `scripts/Install-BuildRunner.ps1`을 실행하면 `Funnet Build Runner` 시작 작업이 등록된다. 설정은 `%ProgramData%\Funnet\BuildRunner\config.json`에 저장되고 SYSTEM과 설치 사용자만 읽을 수 있다.
