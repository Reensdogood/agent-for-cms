[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][ValidateLength(16, 512)][string]$EnrollmentKey,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$RegionName,
    [ValidatePattern('^https?://')][string]$ServerBaseUrl = "https://agent.funnet.kr",
    [string]$OutputDirectory = "dist"
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

# Credentials are embedded only in this regional installer. Do not write them to console or release notes.
$provisioningPath = Join-Path $installerOutput "funnet-provisioning.json"
[System.IO.File]::WriteAllText($provisioningPath, ([ordered]@{
    serverBaseUrl = $ServerBaseUrl.TrimEnd('/')
    enrollmentKey = $EnrollmentKey
    regionName = $RegionName
} | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))

dotnet publish (Join-Path $projectRoot "agent\Funnet.Gwanak.Agent.csproj") -c Release -r win-x64 --self-contained true -p:Version=$Version -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -o $agentOutput
if ($LASTEXITCODE -ne 0) { throw "Agent publish failed." }

$agentExe = Join-Path $agentOutput "funnet-gwanak-agent.exe"
Copy-Item -LiteralPath $agentExe -Destination (Join-Path $payloadDirectory "funnet-gwanak-agent.exe") -Force
dotnet publish (Join-Path $projectRoot "installer\Funnet.Gwanak.Agent.Installer.csproj") -c Release -r win-x64 --self-contained true -p:Version=$Version -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true "-p:FunnetProvisioningFile=$provisioningPath" -o $installerOutput
if ($LASTEXITCODE -ne 0) { throw "Installer publish failed." }
# The provisioning JSON has already been embedded in the single-file installer.
# Do not leave a readable copy of the regional enrollment credential in dist.
Remove-Item -LiteralPath $provisioningPath -Force

$finalInstaller = Join-Path $distRoot "funnet-agent-setup-$Version.exe"
Copy-Item -LiteralPath (Join-Path $installerOutput "funnet-agent-setup.exe") -Destination $finalInstaller -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "agent\agent-settings.example.json") -Destination (Join-Path $distRoot "agent-settings.example.json") -Force

$serverStage = Join-Path $distRoot "server-package"
New-Item -ItemType Directory -Path $serverStage -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot "server") -Destination $serverStage -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot "deploy") -Destination $serverStage -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot "package.json"),(Join-Path $projectRoot "Dockerfile"),(Join-Path $projectRoot "compose.yaml"),(Join-Path $projectRoot ".dockerignore") -Destination $serverStage
Compress-Archive -Path (Join-Path $serverStage "*") -DestinationPath (Join-Path $distRoot "funnet-gwanak-server-$Version.zip") -CompressionLevel Optimal

# Some field PCs still invoke Windows PowerShell versions without Get-FileHash.
# Use the .NET crypto API directly so a valid installer is never reported as a
# failed release merely because the hash cmdlet is unavailable.
$hashes = Get-ChildItem -LiteralPath $distRoot -File | ForEach-Object {
    $stream = [System.IO.File]::OpenRead($_.FullName)
    try {
        $algorithm = [System.Security.Cryptography.SHA256]::Create()
        try {
            $hash = ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '')
            "{0}  {1}" -f $hash, $_.FullName.Substring($distRoot.Length + 1)
        }
        finally { $algorithm.Dispose() }
    }
    finally { $stream.Dispose() }
}
$hashes | Set-Content -LiteralPath (Join-Path $distRoot "SHA256SUMS.txt") -Encoding utf8
Write-Host "Release created at $distRoot"
