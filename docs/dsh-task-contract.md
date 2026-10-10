# DSH task contract 1.0

This contract is the local boundary between the primary agent and DeepSeek Harness. It borrows the A2A task-state vocabulary without implementing the full A2A network protocol.

## Files

- `schemas/dsh-task.schema.json`: delegated task input.
- `schemas/dsh-result.schema.json`: normalized wrapper result.
- `scripts/invoke-dsh.ps1`: PowerShell 5.1 entry point forwarding structured arguments to Node.
- `tools/dsh-mcp/cli.mjs`: UTF-8 task-file CLI; emits one normalized JSON result.
- `tools/dsh-mcp/task-runner.mjs`: shared validation, DSH launch, JSONL parser and process manager.
- `tools/dsh-mcp/server.mjs`: stdio server using the official MCP SDK.
- `examples/dsh-connectivity.task.json`: no-tools connectivity check.
- `examples/dsh-task.example.json`: read-only example.

## Lifecycle

The vocabulary is `submitted`, `working`, `completed`, `failed`, and `canceled`. The current wrapper is synchronous, so intermediate states are recorded in `status_history` and the wrapper returns one final result object.

`completed` means all of the following are true:

1. DSH exited with code `0`.
2. A `turn_end` event has `reason.kind = completed`.
3. Exactly one session, one completed `turn_end`, and one string `final` event were present, with no malformed JSONL.
4. The returned session/workspace matches the task.
5. The answer is nonempty; for `expected_output.format = json`, it parses as JSON.

It does not mean that the answer is factually correct or that requested file changes are good. The caller must inspect `final_text`, changed files, and test results against `acceptance_criteria`. This is represented by:

```json
{
  "verification": {
    "protocol": "passed",
    "semantic": "required_by_caller"
  }
}
```

## Permission semantics

`mode`, `allowed_paths`, and `forbidden_actions` are behavioral instructions sent to the delegated agent. They are not an operating-system sandbox. Keep high-risk operations, hardware access, credential handling, and final writes under the primary agent's control.

For `workspace_write`, at least one `allowed_paths` entry is required. All paths must be absolute and inside the existing `working_directory`; validation resolves existing symlinks/junctions. An empty list means use only supplied context and do not read project files. Validation rejects invalid task envelopes; it does not block the worker's tool calls at runtime.

Start with `read_only` tasks. The same list describes reads and (in write mode) writes; do not use it for tasks needing different read/write scopes. A resumed `session_id` can retain earlier context; prefer new sessions for independent tasks and do not resume into a narrower trust boundary.

## Direct invocation

From Windows PowerShell 5.1:

```powershell
$wrapper = Join-Path (Get-Location).Path 'scripts\invoke-dsh.ps1'
$task = Join-Path (Get-Location).Path 'task.local.json'

powershell.exe -NoProfile -NonInteractive -File $wrapper -TaskFile $task
```

Create `task.local.json` from an example, replacing `working_directory` and
`allowed_paths` with absolute paths on this device. README.md shows a connectivity
task setup that fills the current directory automatically.

The process writes exactly one JSON result to stdout. Exit codes are:

| Code | Meaning |
|---:|---|
| `0` | DSH protocol completed successfully |
| `1` | DSH returned a failed or incomplete run |
| `2` | Task validation or local configuration failed |
| `3` | Wrapper or process launch failed |
| `124` | DSH timeout |
| `130` | Task canceled |

Use `-IncludeEvents` only for diagnostics. It adds the parsed DSH events to the result and can make the response much larger.

Also supported: `-DshPath`, `-DshHome`, `-TimeoutSeconds` (1-300). Use UTF-8 JSON; BOM is accepted. Node 20.3+ is required. First install dependencies with `npm.cmd ci` in `tools/dsh-mcp`.

If execution policy blocks this trusted script, add `-ExecutionPolicy Bypass` for that process only. Do not change the machine/user execution policy.

The runner passes the prompt through UTF-8 stdin (`dsh --profile headless --json -`). For the installed desktop `dsh.cmd`, it invokes the Electron Node executable and CLI entry point used by that shim, avoiding another `cmd.exe` quoting layer. Future DSH packaging changes may require updating this mapping.

stdout/stderr together are limited to 16 MiB. Timeout/cancellation requests process-tree termination (`taskkill /T /F` on Windows). Unconfirmed cleanup returns `PROCESS_CLEANUP_FAILED`. The adapter never retries automatically. API key occurrences in returned text, stderr and optional events are redacted, including object keys; the adapter never persists the key.

## MCP adapter

The stdio MCP server uses the official `@modelcontextprotocol/sdk` and calls the same Node `executeTask` as the PowerShell entry point. It exposes `delegate_to_deepseek`; arguments are the task object defined by `schemas/dsh-task.schema.json`, without an extra `task` wrapper. It returns text and `structuredContent`, with `isError: true` for failed/canceled tasks.

No temporary task file or PowerShell subprocess is needed for MCP. Calls are serialized within one server; multiple servers/direct CLI calls are not coordinated. Timeout starts when DSH launches, excluding queue time. Set a client timeout longer than task timeout plus queue time. MCP cancellation aborts active work and skips queued canceled work. Closing stdin/ending the connection aborts all work. These are ordinary MCP calls, not persistent MCP/A2A task APIs.

Register it with the local Codex CLI from a terminal where `DEEPSEEK_RELAY_API_KEY` is already available:

```powershell
$server = Join-Path (Get-Location).Path 'tools\dsh-mcp\server.mjs'
codex mcp add deepseek-dsh -- node $server
codex mcp list
```

Do not put the API key in the command, MCP arguments, repository files, or `config.toml`. Restart Codex after changing a persistent user environment variable. If the client filters environment variables, explicitly forward names instead of storing values. In the Codex server TOML block, add:

```toml
env_vars = ["DEEPSEEK_RELAY_API_KEY", "DSH_HOME", "DEEPSEEK_DSH_PATH", "LOCALAPPDATA", "USERPROFILE"]
tool_timeout_sec = 360
```

Registration does not attach a new tool to an already running Codex conversation. Start a new or resumed session afterwards; check the registration with `codex mcp get deepseek-dsh`.

Optional machine-local overrides are environment variables:

```text
DEEPSEEK_DSH_PATH
DSH_HOME
```

The server writes protocol responses to stdout and diagnostics only to stderr. A successful MCP tool call still requires the primary agent to perform semantic verification.

## Tests

From the project root:

```powershell
node --test tests/test-dsh-mcp.mjs
node --test tests/test-dsh-live.mjs
```

The first is offline, using a local fixture and dummy credential, and includes the PowerShell wrapper. The second intentionally calls the configured relay/model and consumes API tokens; it verifies the exact connectivity response through the shared runner and MCP SDK.

Run process cleanup tests where child-process termination is permitted. A restricted Codex Windows sandbox may deny `taskkill` for a test descendant; this differs from an API/model failure.

The original Windows deployment passed 24/24 offline tests and 2/2 live connectivity checks on 2026-10-10. These checks cover the installed DSH launcher, not future packaging versions or correctness of arbitrary delegated tasks. Each target device needs its own configuration and verification.

## Caller verification

After a `completed` result, the primary agent should:

1. Check that `final_text` answers the stated objective.
2. Verify every acceptance criterion independently.
3. Inspect the working tree for unauthorized changes.
4. Run relevant tests or static checks when files were changed.
5. Reject or retry the task with narrower context when evidence is missing.
