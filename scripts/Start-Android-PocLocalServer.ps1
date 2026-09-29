[CmdletBinding()]
param(
  [string]$AdminUser = "admin",
  [Parameter(Mandatory)][ValidateLength(10, 200)][string]$AdminPassword,
  [Parameter(Mandatory)][ValidateLength(16, 200)][string]$EnrollmentKey,
  [ValidateRange(1024, 65535)][int]$Port = 4170,
  [switch]$OpenFirewall
)

$repoRoot = Split-Path $PSScriptRoot -Parent
$serverEntry = Join-Path $repoRoot "server\server.mjs"
if (-not (Test-Path -LiteralPath $serverEntry)) {
  throw "로컬 서버 파일을 찾을 수 없습니다: $serverEntry"
}

if ($OpenFirewall) {
  $ruleName = "Funnet Android TV PoC TCP $Port"
  $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  if (-not $existing) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
  }
}

$addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object {
    $_.IPAddress -ne "127.0.0.1" -and
    -not $_.IPAddress.StartsWith("169.254.") -and
    $_.AddressState -eq "Preferred"
  } |
  Select-Object -ExpandProperty IPAddress -Unique

$env:FUNNET_ADMIN_USER = $AdminUser
$env:FUNNET_ADMIN_PASSWORD = $AdminPassword
$env:FUNNET_ENROLLMENT_KEY = $EnrollmentKey
$env:FUNNET_COOKIE_SECURE = "false"
$env:FUNNET_DATA_DIR = Join-Path $repoRoot "server\poc-data"
$env:PORT = $Port.ToString()

Write-Host ""
Write-Host "Funnet Android TV PoC 로컬서버"
Write-Host "관리 화면: http://127.0.0.1:$Port"
foreach ($address in $addresses) {
  Write-Host "Android 앱 서버 주소 후보: http://${address}:$Port"
}
if (-not $OpenFirewall) {
  Write-Host "스틱에서 접속되지 않으면 관리자 PowerShell에서 -OpenFirewall 옵션으로 다시 실행하세요."
}
Write-Host "종료하려면 Ctrl+C를 누르세요."
Write-Host ""

node $serverEntry
