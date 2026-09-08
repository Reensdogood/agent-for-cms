[CmdletBinding()]
param(
  [string]$AdminUser = "admin",
  [Parameter(Mandatory)][string]$AdminPassword,
  [Parameter(Mandatory)][string]$EnrollmentKey,
  [int]$Port = 4170
)
$env:FUNNET_ADMIN_USER = $AdminUser
$env:FUNNET_ADMIN_PASSWORD = $AdminPassword
$env:FUNNET_ENROLLMENT_KEY = $EnrollmentKey
$env:PORT = $Port.ToString()
node (Join-Path $PSScriptRoot "..\server\server.mjs")
