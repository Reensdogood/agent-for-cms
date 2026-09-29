[CmdletBinding()]
param(
  [string]$ApkPath = "dist-android-poc\funnet-tv-controller-0.5.1-poc.apk",
  [string]$DeviceSerial
)

$repoRoot = Split-Path $PSScriptRoot -Parent
$resolvedApk = if ([System.IO.Path]::IsPathRooted($ApkPath)) { $ApkPath } else { Join-Path $repoRoot $ApkPath }
if (-not (Test-Path -LiteralPath $resolvedApk)) { throw "APK를 찾을 수 없습니다: $resolvedApk" }
if (-not (Get-Command adb -ErrorAction SilentlyContinue)) { throw "adb를 찾을 수 없습니다. Android Platform Tools를 설치하고 PATH에 추가하세요." }

$target = @()
if ($DeviceSerial) { $target = @("-s", $DeviceSerial) }
& adb @target install -r $resolvedApk
if ($LASTEXITCODE -ne 0) { throw "APK 설치에 실패했습니다." }
& adb @target shell am start -n "kr.funnet.tvcontroller/.MainActivity"
if ($LASTEXITCODE -ne 0) { throw "앱 실행에 실패했습니다." }
Write-Host "앱을 설치하고 최초 설정 화면을 열었습니다."
