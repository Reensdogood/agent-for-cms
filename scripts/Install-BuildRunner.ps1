[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^https://')][string]$ServerUrl,
  [Parameter(Mandatory)][ValidateLength(24, 512)][string]$RunnerKey,
  [string]$RunnerName = $env:COMPUTERNAME
)

$ErrorActionPreference = "Stop"
$configDirectory = Join-Path $env:LOCALAPPDATA "Funnet\BuildRunner"
$configPath = Join-Path $configDirectory "config.json"
New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
[IO.File]::WriteAllText($configPath, (@{ serverUrl = $ServerUrl.TrimEnd('/'); runnerKey = $RunnerKey; runnerName = $RunnerName } | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))

$runnerScript = Join-Path $PSScriptRoot "Run-BuildRunner.ps1"
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$startupDirectory = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDirectory "Funnet Build Runner.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $pwsh
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runnerScript`" -ConfigPath `"$configPath`""
$shortcut.WorkingDirectory = Split-Path $runnerScript -Parent
$shortcut.WindowStyle = 7
$shortcut.Description = "Funnet 전용 빌드러너"
$shortcut.Save()

$existing = Get-CimInstance Win32_Process -Filter "Name = 'pwsh.exe'" | Where-Object {
  $_.CommandLine -like "*Run-BuildRunner.ps1*" -and $_.CommandLine -like "*$configPath*"
}
if (-not $existing) {
  Start-Process -FilePath $pwsh -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', $runnerScript, '-ConfigPath', $configPath
  ) -WindowStyle Hidden
}

Write-Host "Funnet Build Runner가 현재 사용자 자동 시작으로 설치되고 시작되었습니다."
Write-Host "설정: $configPath"
Write-Host "자동 시작: $shortcutPath"
