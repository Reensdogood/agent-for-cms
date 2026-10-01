[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^https://')][string]$ServerUrl,
  [Parameter(Mandatory)][ValidateLength(24, 512)][string]$RunnerKey,
  [string]$RunnerName = $env:COMPUTERNAME
)

$ErrorActionPreference = "Stop"
$configDirectory = "$env:ProgramData\Funnet\BuildRunner"
$configPath = Join-Path $configDirectory "config.json"
New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
[IO.File]::WriteAllText($configPath, (@{ serverUrl = $ServerUrl.TrimEnd('/'); runnerKey = $RunnerKey; runnerName = $RunnerName } | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
& icacls.exe $configPath /inheritance:r /grant:r "SYSTEM:F" "$env:USERNAME:F" | Out-Null

$runnerScript = Join-Path $PSScriptRoot "Run-BuildRunner.ps1"
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runnerScript`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3)
Register-ScheduledTask -TaskName "Funnet Build Runner" -Action $action -Trigger $trigger -Settings $settings -User "SYSTEM" -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName "Funnet Build Runner"
Write-Host "Funnet Build Runner가 설치되고 시작되었습니다."
