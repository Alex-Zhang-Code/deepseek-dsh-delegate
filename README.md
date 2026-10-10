# DeepSeek DSH Delegate

A small local adapter for delegating bounded tasks to DeepSeek Harness (DSH).
The PowerShell entry point and the MCP tool `delegate_to_deepseek` share the
same task runner, JSON task contract and normalized result.

```text
Caller -> PowerShell or MCP -> shared runner -> DSH headless -> configured model
```

## Requirements

- Node.js 20.3 or newer, including npm.
- DeepSeek Harness installed and a working `headless` profile.
- An API credential available as `DEEPSEEK_RELAY_API_KEY`.
- Windows is the currently tested deployment target. Linux/Jetson deployment
  needs a compatible DSH launcher and separate validation.

The DSH desktop window does not need to be open. DSH still writes its own
profile/session data. This repository does not bundle DSH, Node.js or credentials.

## Install on another device

Clone or extract the repository into any directory. From its root, run:

```powershell
npm.cmd ci --prefix .\tools\dsh-mcp
```

Use the target device's DSH installation to initialize a `headless` profile.
The profile layout can depend on DSH version. The tested configuration used
DSH CLI `0.2.0-rc.2` and `<DSH_HOME>\profiles\headless\cordis.patch.yml`.
Adapt [config/cordis.patch.example.yml](config/cordis.patch.example.yml) to your
provider URL and exact supported model ID. Do not replace an existing profile
without reviewing its settings. The adapter requires the route to read the
credential named `DEEPSEEK_RELAY_API_KEY`.

Set that environment variable locally on the target device. Keep the value out
of Git, task files and MCP arguments. To persist a value already present in
your current terminal without printing it:

```powershell
if ([string]::IsNullOrWhiteSpace($env:DEEPSEEK_RELAY_API_KEY)) {
    throw 'Set DEEPSEEK_RELAY_API_KEY in this terminal first.'
}
[Environment]::SetEnvironmentVariable(
    'DEEPSEEK_RELAY_API_KEY', $env:DEEPSEEK_RELAY_API_KEY, 'User'
)
```

Restart the terminal and MCP client after changing user environment variables.
The adapter defaults to the current user's `.dsh` directory and the standard
Windows DSH desktop install location. Override them only if needed:

```text
DSH_HOME
DEEPSEEK_DSH_PATH
```

The supported desktop `dsh.cmd` is mapped to its Electron executable and CLI
entry point. A future DSH packaging change may require updating that mapping.

## Connectivity check

From the repository root, create a machine-local task using your current path:

```powershell
$task = Get-Content -LiteralPath .\examples\dsh-connectivity.task.json -Raw -Encoding UTF8 |
    ConvertFrom-Json
$task.working_directory = (Get-Location).Path
$json = $task | ConvertTo-Json -Depth 10
$localTask = Join-Path (Get-Location).Path 'connectivity.local.json'
[System.IO.File]::WriteAllText($localTask, $json, [System.Text.UTF8Encoding]::new($false))
powershell.exe -NoProfile -NonInteractive -File .\scripts\invoke-dsh.ps1 -TaskFile $localTask
```

The result should have `status = completed`, `protocol.passed = true`, and the
exact sentence requested by the task. `*.local.json` is excluded from Git.
If execution policy blocks this trusted script, use `-ExecutionPolicy Bypass`
for that invocation only.

## MCP clients

Configure the client to launch `node` with the absolute path to
`tools/dsh-mcp/server.mjs`. Forward environment variable names rather than
embedding credentials. The input to `delegate_to_deepseek` is the task object
itself, with no extra `task` wrapper.

For Codex, [config/codex-mcp.example.toml](config/codex-mcp.example.toml) is a
sample block to merge into the target device's configuration; replace its
example repository path. Do not replace an entire existing user configuration.
Start a new or resumed Codex session after registration.

## Tasks and verification

- [Task schema](schemas/dsh-task.schema.json)
- [Result schema](schemas/dsh-result.schema.json)
- [Contract, lifecycle and exit codes](docs/dsh-task-contract.md)
- [Agent delegation rules](AGENTS.md)

States are `submitted`, `working`, `completed`, `failed` and `canceled`.
The wrapper waits for a terminal result and records intermediate states in
`status_history`; it is not a persistent A2A task service.

`completed` means the DSH event stream and output format passed validation.
The caller must still verify the answer, acceptance criteria and any file
changes. `mode` and `allowed_paths` are prompt constraints, not an OS sandbox.
Calls are serialized within one MCP server. Timeout excludes queue time;
failed or canceled tasks are not automatically retried.

## Tests

Run from the repository root after installing dependencies:

```powershell
node --test tests/test-dsh-mcp.mjs
```

This offline suite uses a dummy credential and fake DSH. Windows timeout and
cancellation tests need permission to terminate their descendant processes.

Optional live checks use the configured provider and consume API tokens:

```powershell
node --test tests/test-dsh-live.mjs
```

The live tests use the repository root automatically; they do not read or
modify project files, but DSH updates its local runtime state.

## Minimal delivery

MCP needs only `server.mjs`, `task-runner.mjs`, `package.json`,
`package-lock.json` in `tools/dsh-mcp`, plus the two schema files in `schemas`.
Keep this layout: the runner locates schemas relative to its own file.
Add `scripts/invoke-dsh.ps1` and `tools/dsh-mcp/cli.mjs` for PowerShell use.

For client delivery, also include this README, the contract and configuration
templates. Each device needs its own DSH installation and credential setup.
No customer API keys, local profiles, session histories or generated
dependencies belong in the repository.
