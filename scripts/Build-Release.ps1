[CmdletBinding()]
param([string]$Version = "0.4.0")

$ErrorActionPreference = "Stop"
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$distRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "dist"))
if (-not $distRoot.StartsWith($projectRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Invalid distribution path." }
if (Test-Path -LiteralPath $distRoot) { Remove-Item -LiteralPath $distRoot -Recurse -Force }

$agentOutput = Join-Path $distRoot "agent"
$payloadDirectory = Join-Path $projectRoot "installer\payload"
$installerOutput = Join-Path $distRoot "installer-build"
New-Item -ItemType Directory -Path $agentOutput, $payloadDirectory, $installerOutput -Force | Out-Null

dotnet publish (Join-Path $projectRoot "agent\Funnet.Gwanak.Agent.csproj") -c Release -r win-x64 --self-contained true -p:Version=$Version -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -o $agentOutput
if ($LASTEXITCODE -ne 0) { throw "Agent publish failed." }

$agentExe = Join-Path $agentOutput "funnet-gwanak-agent.exe"
Copy-Item -LiteralPath $agentExe -Destination (Join-Path $payloadDirectory "funnet-gwanak-agent.exe") -Force
dotnet publish (Join-Path $projectRoot "installer\Funnet.Gwanak.Agent.Installer.csproj") -c Release -r win-x64 --self-contained true -p:Version=$Version -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -o $installerOutput
if ($LASTEXITCODE -ne 0) { throw "Installer publish failed." }

$finalInstaller = Join-Path $distRoot "funnet-gwanak-agent-setup-$Version.exe"
Copy-Item -LiteralPath (Join-Path $installerOutput "funnet-gwanak-agent-setup.exe") -Destination $finalInstaller -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "agent\agent-settings.example.json") -Destination (Join-Path $distRoot "agent-settings.example.json") -Force

$serverStage = Join-Path $distRoot "server-package"
New-Item -ItemType Directory -Path $serverStage -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot "server") -Destination $serverStage -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot "deploy") -Destination $serverStage -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot "package.json"),(Join-Path $projectRoot "Dockerfile"),(Join-Path $projectRoot "compose.yaml"),(Join-Path $projectRoot ".dockerignore") -Destination $serverStage
Compress-Archive -Path (Join-Path $serverStage "*") -DestinationPath (Join-Path $distRoot "funnet-gwanak-server-$Version.zip") -CompressionLevel Optimal

$hashes = Get-ChildItem -LiteralPath $distRoot -File | Get-FileHash -Algorithm SHA256 | ForEach-Object { "{0}  {1}" -f $_.Hash, $_.Path.Substring($distRoot.Length + 1) }
$hashes | Set-Content -LiteralPath (Join-Path $distRoot "SHA256SUMS.txt") -Encoding utf8
Write-Host "Release created at $distRoot"
