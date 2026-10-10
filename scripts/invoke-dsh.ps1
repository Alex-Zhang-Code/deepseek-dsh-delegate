[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TaskFile,
    [string]$DshPath,
    [string]$DshHome,
    [int]$TimeoutSeconds,
    [switch]$IncludeEvents
)

$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
$cli = Join-Path $PSScriptRoot '..\tools\dsh-mcp\cli.mjs'
$nativeArgs = @($cli, '--task-file', $TaskFile)
if ($DshPath) { $nativeArgs += @('--dsh-path', $DshPath) }
if ($DshHome) { $nativeArgs += @('--dsh-home', $DshHome) }
if ($PSBoundParameters.ContainsKey('TimeoutSeconds')) {
    $nativeArgs += @('--timeout-seconds', $TimeoutSeconds.ToString())
}
if ($IncludeEvents) { $nativeArgs += '--include-events' }

$previousEncoding = [Console]::OutputEncoding
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    & $node @nativeArgs
    $exitCode = $LASTEXITCODE
}
finally {
    [Console]::OutputEncoding = $previousEncoding
}
exit $exitCode
