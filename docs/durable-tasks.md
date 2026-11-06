# Durable local delegation

The local adapter borrows the Ticket/Assignment separation from DeepSeek's
[Super-agent reference prototype](https://github.com/deepseek-ai/dsh-superagent-prototype).
It does not install that prototype, add external message sources, or implement
the A2A network protocol.

## Model and tools

A Ticket preserves the requested task and acceptance criteria. An Assignment
is one execution attempt. Retrying appends an Assignment; it does not replace
the earlier result. SQLite transactions preserve submissions and state changes
in `local/observability/tickets.sqlite` (including its WAL/SHM sidecars).

| Tool | Purpose |
| --- | --- |
| `build_deepseek_task` | Validate simple fields and return a complete task; no execution |
| `submit_deepseek_task` | Build, persist and schedule a task; return its Ticket immediately |
| `get_deepseek_task` | Read state, results, all Assignments and handoff events |
| `list_deepseek_tasks` | Recover known Tickets and executor health |
| `cancel_deepseek_task` | Cancel queued work or request termination of running work |
| `retry_deepseek_task` | Explicit reviewed requeue of the same task |
| `resolve_deepseek_task` | Close an interrupted Ticket after reviewing effects and processes |
| `verify_deepseek_task` | Record caller acceptance against the latest terminal Assignment |

The existing synchronous `delegate_to_deepseek` and `scripts/invoke-dsh.ps1`
remain compatible. They use the full version 1.0 task schema and their existing
JSONL traces. They do not participate in durable scheduling, deduplication or
workspace admission. Do not mix direct synchronous and asynchronous writes in
the same workspace. Prefer durable submission for work that must survive a
client disconnect or coordinate with other Tickets.

## Simplified input

Both build and submit accept these fields directly (no `task` wrapper):

```json
{
  "task_id": "review-001",
  "objective": "Summarize the supplied log and identify blockers.",
  "working_directory": "C:\\Projects\\example",
  "context": "Paste a bounded, non-secret log excerpt here.",
  "acceptance_criteria": ["Every conclusion cites a supplied log line."],
  "output_format": "markdown",
  "output_requirements": ["Include blockers and evidence."],
  "metadata": {"delegated_by": "codex", "parent_task_id": "project-001"}
}
```

The directory must exist. Default `mode` is `read_only`; `allowed_paths` is
empty (context-only). Output defaults to Markdown and timeout to 120 seconds.
For file reads provide explicit absolute `allowed_paths` within the directory.
Writing requires `mode: workspace_write` and nonempty explicit paths. The
builder never guesses a directory, expands permissions or silently accepts
unknown fields. These scopes remain prompt constraints, not an OS sandbox.

Reusing a `task_id` with the same normalized task returns the existing Ticket,
even after completion. A different task body returns `TASK_CONFLICT`; use a new
ID for changed work. The persisted task is immutable. Metadata, paths and output
requirements are part of its fingerprint.

## Execution and recovery

```text
MCP / tickets CLI -> SQLite Ticket -> detached scheduler
                                     -> Assignment supervisor -> DSH
Dashboard        <- events / results / independent acceptance
```

The scheduler admits work transactionally across clients sharing the same
trace directory. Each Assignment supervisor owns its DSH process and survives
MCP or scheduler disconnects. Poll `get_deepseek_task` until the Ticket reaches
a terminal state, check the result/protocol, independently verify the evidence,
then call `verify_deepseek_task` with `ticket_id`, `assignment_id`, `verdict`,
`reviewer` and nonempty `evidence`. The existing `record_deepseek_verification`
also routes known Assignment run IDs to Ticket acceptance.

There is no automatic message that wakes an inactive Codex conversation. On
resume call `list_deepseek_tasks` and inspect existing results before creating
replacements. The dashboard normally polls every two seconds.

Tickets have `submitted`, `working`, `completed`, `failed`, `canceled` and an
additional local `interrupted` state. Process liveness and heartbeats are shown;
an alive process with a stale heartbeat is not replaced automatically.

On executor restart, queued Tickets remain queued. A live supervisor continues
its Assignment. A vanished supervisor (or an unowned Assignment older than
30 seconds) becomes `interrupted`. The adapter does not automatically rerun it,
kill unknown survivors, or infer that external operations were rolled back.
Its workspace remains reserved until explicit reviewed retry or resolution.
`PROCESS_CLEANUP_FAILED` also keeps the Ticket interrupted.

Retry requires the latest `assignment_id` (null if never started),
`side_effects_reviewed: true`, and a nonempty `reason` containing the review
evidence. Inspect project/remote state and surviving processes first. Retry
does not provide exactly-once side effects. Accepted Tickets require a new
task ID. Old Assignment acceptance cannot close a newer attempt.

Cancellation is a request, not rollback. A completion that wins the race stays
completed with the cancellation event retained. Check the final state.

## Concurrency

Default is one durable worker. Set `DSH_MAX_WORKERS` to 1..4 before starting the
executor. Existing executors keep their startup configuration; drain work,
stop the known scheduler PID and start it again to change this setting.

Concurrency requires separate nonoverlapping workspace roots, even for reads.
Junctions/symlinks are resolved at admission; nested directories and the same
resumed DSH session serialize. Create separate checkouts or Git worktrees
before submitting concurrent writing tasks. The adapter does not create or
delete worktrees for the caller. Local path isolation does not establish that
remote devices or external services are independent; the caller must schedule
those shared resources appropriately.

An invalid/moved queued workspace stays submitted and cancellable. Correct the
directory or cancel and submit a new task; the adapter does not widen scope.

## CLI and dashboard

Run from the repository root with a machine-local JSON input file:

```powershell
node tools/dsh-mcp/tickets-cli.mjs build --file local/task.local.json
node tools/dsh-mcp/tickets-cli.mjs submit --file local/task.local.json
node tools/dsh-mcp/tickets-cli.mjs list
node tools/dsh-mcp/tickets-cli.mjs get --id '<ticket-id>'
node tools/dsh-mcp/tickets-cli.mjs cancel --id '<ticket-id>'
node tools/dsh-mcp/tickets-cli.mjs retry --id '<ticket-id>' --assignment '<assignment-id>' --reviewed --reason 'Inspected effects and stopped old processes.'
node tools/dsh-mcp/tickets-cli.mjs start
```

Submit accepts either simplified input or a full 1.0 task. CLI success means
the request succeeded, not that the task completed. Inspect the returned state
and executor health. Submission remains durable even if executor startup fails.

Starting the dashboard starts the executor. After a machine reboot, open the
dashboard or run `start` to resume queued work. No Windows startup service or
scheduled task is installed. The dashboard binds only to loopback and validates
Host, Origin, JSON content type and a custom same-origin request header for
mutations. It is a local operator interface, not a multi-user auth service.

The dashboard shows durable Tickets plus legacy synchronous runs. A Ticket has
an Assignment selector, cancellation, reviewed retry/resolution and acceptance.
Interrupted work is included in the failure filter. Results are kept in full in
SQLite; timeline detail remains bounded by the trace redaction policy.

Keep all runtime data ignored in `local/`. Task bodies/results may contain
project content; never include credentials. Stop executors and supervisors
before a cold backup, and include the SQLite sidecars if copying a live DB.
Delivery should contain tracked code/docs/config only, not this machine's DB,
sessions, logs or credentials. Node >=22.13 is required for built-in SQLite;
some supported Node versions emit an experimental SQLite warning on stderr.

## Validation

```powershell
node --test tests/test-dsh-mcp.mjs tests/test-observability.mjs tests/test-tickets.mjs
```

The suite uses fake DSH and tests persistence, duplicate/conflicting requests,
workspace admission, interrupted recovery, stale acceptance, process cleanup,
MCP disconnects and localhost APIs. Process tests need permission to terminate
descendants on Windows. Live relay and browser checks are separate and should
be recorded with their exact outcomes.
