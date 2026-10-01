[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Version,
    [ValidatePattern('^https?://')][string]$ServerBaseUrl = "https://agent.funnet.kr",
    [string]$OutputDirectory = "dist-bootstrap"
)

$ErrorActionPreference = "Stop"
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$distRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputDirectory))
if (-not $distRoot.StartsWith($projectRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Invalid distribution path." }
if (Test-Path -LiteralPath $distRoot) { Remove-Item -LiteralPath $distRoot -Recurse -Force }

$agentOutput = Join-Path $distRoot "agent"
$payloadDirectory = Join-Path $projectRoot "installer\payload"
$installerOutput = Join-Path $distRoot "installer-build"
New-Item -ItemType Directory -Path $agentOutput, $payloadDirectory, $installerOutput -Force | Out-Null

# A regional key is never embedded here. The server appends a one-time token
# when the administrator downloads the installer for a region, and the
# installer exchanges that token for the current region key during setup.
$provisioningPath = Join-Path $installerOutput "funnet-provisioning.json"
[System.IO.File]::WriteAllText($provisioningPath, ([ordered]@{
    serverBaseUrl = $ServerBaseUrl.TrimEnd('/')
    enrollmentKey = "bootstrap-provisioning-placeholder"
    regionName = ""
} | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))

dotnet publish (Join-Path $projectRoot "agent\Funnet.Gwanak.Agent.csproj") -c Release -r win-x64 --self-contained true -p:Version=$Version -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -o $agentOutput
if ($LASTEXITCODE -ne 0) { throw "Agent publish failed." }
Copy-Item -LiteralPath (Join-Path $agentOutput "funnet-gwanak-agent.exe") -Destination (Join-Path $payloadDirectory "funnet-gwanak-agent.exe") -Force

dotnet publish (Join-Path $projectRoot "installer\Funnet.Gwanak.Agent.Installer.csproj") -c Release -r win-x64 --self-contained true -p:Version=$Version -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true "-p:FunnetProvisioningFile=$provisioningPath" -o $installerOutput
if ($LASTEXITCODE -ne 0) { throw "Installer publish failed." }
Remove-Item -LiteralPath $provisioningPath -Force

$finalInstaller = Join-Path $distRoot "funnet-agent-bootstrap-$Version.exe"
Copy-Item -LiteralPath (Join-Path $installerOutput "funnet-agent-setup.exe") -Destination $finalInstaller -Force
$hash = (Get-FileHash -LiteralPath $finalInstaller -Algorithm SHA256).Hash
"$hash  $(Split-Path -Leaf $finalInstaller)" | Set-Content -LiteralPath (Join-Path $distRoot "SHA256SUMS.txt") -Encoding utf8
Write-Host "Bootstrap installer created at $finalInstaller"
