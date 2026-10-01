[CmdletBinding()]
param(
  [string]$ConfigPath = "$env:LOCALAPPDATA\Funnet\BuildRunner\config.json",
  [switch]$Once
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path $PSScriptRoot -Parent

function Invoke-RunnerApi([string]$Method, [string]$Path, [object]$Body = $null, [string]$InFile = "", [hashtable]$ExtraHeaders = @{}) {
  $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  $headers = @{ "X-Build-Runner-Key" = $config.runnerKey; "X-Build-Runner-Name" = $config.runnerName }
  foreach ($entry in $ExtraHeaders.GetEnumerator()) { $headers[$entry.Key] = $entry.Value }
  $arguments = @{ Method = $Method; Uri = $config.serverUrl.TrimEnd('/') + $Path; Headers = $headers; TimeoutSec = 120 }
  if ($InFile) { $arguments.InFile = $InFile; $arguments.ContentType = "application/octet-stream" }
  elseif ($null -ne $Body) { $arguments.Body = ($Body | ConvertTo-Json -Compress); $arguments.ContentType = "application/json" }
  Invoke-RestMethod @arguments
}

function Invoke-BuildJob($job) {
  $output = "dist-runner/$($job.id)"
  if ($job.productType -eq "meetingbar_a10") {
    & (Join-Path $PSScriptRoot "Build-Android-Poc.ps1") -Version $job.version -OutputDirectory $output -ServerUrl $job.serverBaseUrl -RegionId $job.regionId -RegionName $job.regionName -EnrollmentKey $job.enrollmentKey -TvModel $job.tvModel -DisplayId 0
    if ($LASTEXITCODE -ne 0) { throw "MeetingBar A10 APK 빌드가 실패했습니다." }
    return Join-Path $repoRoot "$output\funnet-meetingbar-a10-controller-$($job.version).apk"
  }
  if ($job.productType -eq "windows_agent") {
    & (Join-Path $PSScriptRoot "Build-Release.ps1") -Version $job.version -OutputDirectory $output -ServerBaseUrl $job.serverBaseUrl -RegionName $job.regionName -EnrollmentKey $job.enrollmentKey
    if ($LASTEXITCODE -ne 0) { throw "Windows Agent 빌드가 실패했습니다." }
    return Join-Path $repoRoot "$output\funnet-agent-setup-$($job.version).exe"
  }
  throw "지원하지 않는 빌드 제품입니다: $($job.productType)"
}

do {
  try {
    $response = Invoke-RunnerApi -Method GET -Path "/api/build-runner/jobs/next"
    if ($null -ne $response.job) {
      $job = $response.job
      try {
        $artifact = Invoke-BuildJob $job
        if (-not (Test-Path -LiteralPath $artifact)) { throw "빌드 결과 파일을 찾을 수 없습니다." }
        Invoke-RunnerApi -Method POST -Path "/api/build-runner/jobs/$($job.id)/result" -InFile $artifact -ExtraHeaders @{ "X-File-Name" = [uri]::EscapeDataString((Split-Path $artifact -Leaf)) } | Out-Null
      } catch {
        try { Invoke-RunnerApi -Method POST -Path "/api/build-runner/jobs/$($job.id)/failure" -Body @{ error = $_.Exception.Message } | Out-Null } catch {}
      }
    }
  } catch {
    Write-Warning "빌드 서버 연결 실패: $($_.Exception.Message)"
  }
  if (-not $Once) { Start-Sleep -Seconds 15 }
} while (-not $Once)
