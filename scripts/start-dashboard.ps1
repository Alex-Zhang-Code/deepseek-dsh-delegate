[CmdletBinding()]
param([int]$Port = 8766)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
$launcher = Join-Path $PSScriptRoot '..\tools\dsh-mcp\dashboard-launcher.mjs'
$env:DSH_DASHBOARD_PORT = $Port.ToString()
& $node $launcher
$exitCode = $LASTEXITCODE
exit $exitCode
