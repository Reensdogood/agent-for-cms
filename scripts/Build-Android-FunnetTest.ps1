[CmdletBinding()]
param(
  [string]$EnrollmentKey = $env:FUNNET_ANDROID_ENROLLMENT_KEY,
  [string]$TvModel = "LH65QET"
)

if ([string]::IsNullOrWhiteSpace($EnrollmentKey)) {
  throw "FUNNET_ANDROID_ENROLLMENT_KEY 환경 변수 또는 -EnrollmentKey가 필요합니다. 등록키는 Git에 저장하지 않습니다."
}

& (Join-Path $PSScriptRoot "Build-Android-Poc.ps1") `
  -Version "0.5.2-funnet-test" `
  -OutputDirectory "dist-android-funnet-test" `
  -ServerUrl "https://agent.funnet.kr" `
  -RegionId "40cbbb16-3eab-48d9-975c-085032dcda0d" `
  -RegionName "펀네트" `
  -EnrollmentKey $EnrollmentKey `
  -TvModel $TvModel `
  -DisplayId 0

if ($LASTEXITCODE -ne 0) { throw "Funnet Android 테스트 배포본 빌드에 실패했습니다." }
