$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$wrapper = Join-Path $root 'scripts\invoke-dsh.ps1'
$fixture = Join-Path $PSScriptRoot 'fixtures\fake-dsh.mjs'
$task = Join-Path $PSScriptRoot 'fixtures\task.json'
$shell = Join-Path $PSHOME 'powershell.exe'
$oldKey = $env:DEEPSEEK_RELAY_API_KEY
$oldScenario = $env:DSH_FAKE_SCENARIO
$oldEncoding = [Console]::OutputEncoding
$localTask = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-wrapper-' + [guid]::NewGuid().ToString() + '.json')
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $taskObject = Get-Content -LiteralPath $task -Raw -Encoding UTF8 | ConvertFrom-Json
    $taskObject.working_directory = $root
    $taskJson = $taskObject | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($localTask, $taskJson, [System.Text.UTF8Encoding]::new($false))
    $env:DEEPSEEK_RELAY_API_KEY = 'offline-test-key'
    foreach ($scenario in @('success', 'unicode', 'failure', 'malformed')) {
        $env:DSH_FAKE_SCENARIO = $scenario
        $nativeArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', $wrapper, '-TaskFile', $localTask, '-DshPath', $fixture, '-IncludeEvents')
        $output = & $shell @nativeArgs
        $exitCode = $LASTEXITCODE
        if (@($output).Count -ne 1) { throw 'Wrapper stdout must contain exactly one JSON line.' }
        $result = $output | ConvertFrom-Json
        $expectedCode = if ($scenario -in @('success', 'unicode')) { 0 } else { 1 }
        if ($exitCode -ne $expectedCode) { throw "Unexpected exit code for $scenario : $exitCode" }
        if ($scenario -eq 'unicode') {
            $expected = -join (@(0x8fde, 0x63a5, 0x6b63, 0x5e38, 0x3002) | ForEach-Object { [char]$_ })
            if ($result.final_text -ne $expected) { throw 'Unicode output was corrupted.' }
        }
        if ($result.events.Count -lt 1) { throw 'IncludeEvents was not forwarded.' }
    }
    Write-Output 'PowerShell wrapper: 4 scenarios passed.'
}
finally {
    if (Test-Path -LiteralPath $localTask) { Remove-Item -LiteralPath $localTask -ErrorAction SilentlyContinue }
    $env:DEEPSEEK_RELAY_API_KEY = $oldKey
    $env:DSH_FAKE_SCENARIO = $oldScenario
    [Console]::OutputEncoding = $oldEncoding
}
