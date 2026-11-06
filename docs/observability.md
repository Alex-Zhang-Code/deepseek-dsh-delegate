# Local task observability

The adapter records each delegation in `local/observability/<run-id>.jsonl`.
The dashboard reads those records, so a task remains visible after the caller
disconnects or the dashboard restarts. Separate runs of the same `task_id` have
different UUIDs. Records are local diagnostics and are excluded from Git.

## Open the dashboard

```powershell
powershell.exe -NoProfile -File .\scripts\start-dashboard.ps1
```

The launcher prints a localhost URL, normally `http://127.0.0.1:8766`. It reuses
an existing dashboard for the same trace directory and tries another port if
the preferred port is occupied. `DSH_DASHBOARD_AUTO_START=1` starts it when the
MCP server starts. It runs hidden as the current user and remains available
after the MCP client closes. Starting it manually uses the same launcher.
If Windows execution policy blocks this trusted script, invoke it once with
`-ExecutionPolicy Bypass`; the user/machine policy does not need to change.

The interface shows the newest 200 runs, task handoffs, lifecycle events,
DSH status/tool events when present in the CLI stream, errors, final results,
token usage, and a separate acceptance verdict. It polls every two seconds.
It does not execute tasks, automatically retry operations, or inspect other
agents' internal reasoning. A worker that vanishes without a result remains
in its last recorded state; the dashboard does not infer success or failure.

## Handoffs and acceptance

Use existing task metadata to connect related work:

```json
{
  "metadata": {
    "delegated_by": "codex",
    "parent_task_id": "jetson-diagnostics",
    "trace_id": "0123456789abcdef0123456789abcdef",
    "parent_span_id": "0123456789abcdef"
  }
}
```

Only supply trace/span IDs when a real parent trace exists. Otherwise the
adapter generates a trace ID. It returns `observability.run_id`, `trace_id`,
`span_id`, and `recorded` with the normalized result.

`completed` still means protocol completion, not verified task success.
Acceptance begins as `pending`. After independently checking the criteria,
use the dashboard's acceptance form or the MCP tool:

```json
{
  "run_id": "<observability.run_id>",
  "verdict": "passed",
  "reviewer": "codex",
  "evidence": ["Compared the returned answer with the requested exact text."]
}
```

Call this input with `record_deepseek_verification`. A nonempty evidence list
is required; failed or canceled executions cannot be accepted as passed.
Every verdict is appended to the history, preserving earlier reviews.
The currently running MCP process needs a restart to expose newly added tools.

## Storage and content

- `DSH_TRACE_DIR`: override the trace directory; default is repository-local
  `local/observability`. All clients must use the same directory to share a view.
- `DSH_TRACE_ENABLED=0`: disable trace recording.
- `DSH_TRACE_CONTENT=1`: additionally store bounded raw DSH event content.
  The default stores event names/status and usage, not raw tool arguments.
- Task objectives and final results are stored locally. Known API credentials,
  bearer strings and credential fields are redacted. Avoid putting unrelated
  secrets into task text; arbitrary secret values cannot be detected reliably.
- Trace write/export failures do not change the task's actual execution result.
  Check `observability.recorded` and stderr if a run is absent.

The dashboard binds only to `127.0.0.1`. It validates Host and Origin and
requires same-origin JSON requests for acceptance changes. It is a local
single-user tool, not an authenticated multi-user deployment. Close its Node
process to stop it. Retain or archive local records according to your needs.

## Optional Langfuse export

The OTLP/HTTP interface is prepared but inactive until all three variables
are available to the MCP process:

```text
LANGFUSE_BASE_URL
LANGFUSE_PUBLIC_KEY
LANGFUSE_SECRET_KEY
```

The adapter exports a delegation span to
`<LANGFUSE_BASE_URL>/api/public/otel/v1/traces` using OTLP JSON and Basic
authentication. Use HTTPS except for a localhost instance. No task prompt,
tool arguments or final answer is sent. Only task identifiers, caller/parent
relationships, status, session and error metadata are included. Errors are
recorded locally; there is no automatic export retry. Local event details and
acceptance history stay in this dashboard. Add SDK instrumentation later if
you need live nested tool spans or Langfuse-side acceptance scoring.

The interface has a mock-receiver test. A real Langfuse service is not part of
this deployment and has not been verified.

## Windows execution workspace

Keep the adapter, DSH profile and execution workspace separate. A dedicated
current-user-owned workspace avoids granting the sandbox access to the full
DSH configuration directory. For example:

```text
C:\Tools\deepseek-dsh-delegate   adapter, dashboard and local trace data
C:\Tools\dsh-execution          shell-only diagnostic tasks
%USERPROFILE%\.dsh                  DSH profile and session state
```

Use the actual project directory for tasks that need project files. The
existing `allowed_paths` validation requires those paths to be within the
task's `working_directory`. Do not silently substitute the diagnostic
workspace for a file-editing task.

If `SetNamedSecurityInfoW ... grantWrite` fails, inspect ownership and current
user `FullControl` on the exact execution root. DSH's Windows sandbox needs
permission to edit directory security, beyond ordinary Modify. Its upstream
[ACL recovery guide](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sandbox/sandbox-windows-acl#failures-and-recovery)
provides a scoped repair tool. The dashboard is not an ACL repair service.
