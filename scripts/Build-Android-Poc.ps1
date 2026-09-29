[CmdletBinding()]
param(
  [string]$Version = "0.5.0-poc",
  [string]$OutputDirectory = "dist-android-poc",
  [string]$ServerUrl = "",
  [string]$RegionId = "",
  [string]$RegionName = "",
  [string]$EnrollmentKey = "",
  [string]$TvModel = "LH65QET",
  [ValidateRange(0, 253)][int]$DisplayId = 0
)

$fixedValues = @($ServerUrl, $RegionId, $RegionName, $EnrollmentKey)
$providedFixedValues = @($fixedValues | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count
if ($providedFixedValues -gt 0 -and $providedFixedValues -ne $fixedValues.Count) {
  throw "고정 배포본은 ServerUrl, RegionId, RegionName, EnrollmentKey를 모두 지정해야 합니다."
}

$repoRoot = Split-Path $PSScriptRoot -Parent
$project = Join-Path $repoRoot "android-tv-controller"
$buildProject = $project
if ($project -match '[^\x00-\x7F]') {
  $pathBytes = [System.Text.Encoding]::UTF8.GetBytes($repoRoot)
  $pathHash = [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($pathBytes)).Substring(0, 12)
  $junctionRoot = "C:\Users\Public\FunnetAndroidBuild-$pathHash"
  if (-not (Test-Path -LiteralPath $junctionRoot)) {
    New-Item -ItemType Junction -Path $junctionRoot -Target $repoRoot | Out-Null
  }
  $junction = Get-Item -LiteralPath $junctionRoot
  if (-not ($junction.Target -contains $repoRoot)) { throw "Android 빌드용 Junction 대상이 현재 저장소와 다릅니다: $junctionRoot" }
  $buildProject = Join-Path $junctionRoot "android-tv-controller"
  $env:GRADLE_USER_HOME = "C:\Users\Public\FunnetGradleCache"
  New-Item -ItemType Directory -Path $env:GRADLE_USER_HOME -Force | Out-Null
}
$gradle = Join-Path $buildProject "gradlew.bat"
if (-not (Test-Path -LiteralPath $gradle)) { throw "Android Gradle Wrapper를 찾을 수 없습니다." }

Push-Location $buildProject
$previousBuildEnvironment = $null
try {
  $previousBuildEnvironment = @{
    ServerUrl = $env:FUNNET_ANDROID_SERVER_URL
    RegionId = $env:FUNNET_ANDROID_REGION_ID
    RegionName = $env:FUNNET_ANDROID_REGION_NAME
    EnrollmentKey = $env:FUNNET_ANDROID_ENROLLMENT_KEY
    TvModel = $env:FUNNET_ANDROID_TV_MODEL
    DisplayId = $env:FUNNET_ANDROID_DISPLAY_ID
  }
  $env:FUNNET_ANDROID_SERVER_URL = $ServerUrl
  $env:FUNNET_ANDROID_REGION_ID = $RegionId
  $env:FUNNET_ANDROID_REGION_NAME = $RegionName
  $env:FUNNET_ANDROID_ENROLLMENT_KEY = $EnrollmentKey
  $env:FUNNET_ANDROID_TV_MODEL = $TvModel
  $env:FUNNET_ANDROID_DISPLAY_ID = [string]$DisplayId
  & $gradle testDebugUnitTest assembleDebug
  if ($LASTEXITCODE -ne 0) { throw "Android 테스트 또는 APK 빌드가 실패했습니다." }
} finally {
  if ($null -ne $previousBuildEnvironment) {
    $env:FUNNET_ANDROID_SERVER_URL = $previousBuildEnvironment.ServerUrl
    $env:FUNNET_ANDROID_REGION_ID = $previousBuildEnvironment.RegionId
    $env:FUNNET_ANDROID_REGION_NAME = $previousBuildEnvironment.RegionName
    $env:FUNNET_ANDROID_ENROLLMENT_KEY = $previousBuildEnvironment.EnrollmentKey
    $env:FUNNET_ANDROID_TV_MODEL = $previousBuildEnvironment.TvModel
    $env:FUNNET_ANDROID_DISPLAY_ID = $previousBuildEnvironment.DisplayId
  }
  Pop-Location
}

$source = Join-Path $project "app\build\outputs\apk\debug\app-debug.apk"
$output = Join-Path $repoRoot $OutputDirectory
New-Item -ItemType Directory -Path $output -Force | Out-Null
$destination = Join-Path $output "funnet-tv-controller-$Version.apk"
Copy-Item -LiteralPath $source -Destination $destination -Force
$hash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
$hashLine = "$hash  $(Split-Path $destination -Leaf)"
Set-Content -LiteralPath (Join-Path $output "SHA256SUMS.txt") -Value $hashLine -Encoding utf8
Get-Item -LiteralPath $destination | Select-Object FullName, Length, LastWriteTime
Write-Host "SHA-256: $hash"
