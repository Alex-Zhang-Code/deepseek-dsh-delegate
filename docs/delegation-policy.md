# Persistent DSH delegation policy

This policy applies when a workspace AGENTS.md explicitly references it.
It expresses the user's preferred task routing; it is not a scheduler or a
guarantee that every model will follow every instruction.

## Routing

At the start of substantial work, decide whether there is a useful, bounded
routine subtask. Delegate suitable work such as supplied-log summarization,
limited file inspection, document drafting, independent checklist review or
mechanical transformations. Keep architecture, difficult debugging, scope
decisions and final acceptance with the primary agent.

When such a subtask exists, actually call `delegate_to_deepseek`; merely
describing a possible delegation does not satisfy this preference. Supply
enough context for a separate worker to understand the task without the
conversation history. Use the task contract, explicit acceptance criteria,
`metadata.delegated_by`, and `metadata.parent_task_id` for child tasks.

Durable `submit_deepseek_task` is also a delegation. Prefer it when work must
survive a client disconnect or coordinate workspace access. Use the simplified
builder fields, poll `get_deepseek_task`, and independently accept the latest
Assignment via `verify_deepseek_task`. After resume, call `list_deepseek_tasks`
before creating replacements. See `durable-tasks.md`; interrupted work requires
explicit review of side effects and surviving processes, never blind replay.

Simple knowledge questions, single trivial commands and work that cannot be
usefully separated do not need a worker. Do not invent tasks to meet a quota.
Do not delegate credentials, destructive operations or hardware actions
without applicable user authorization. A worker does not expand permission.

If the MCP tool is unavailable, use `scripts/invoke-dsh.ps1` where permitted.
If both paths are blocked, explain the blocker and continue independent work
within the existing authorization. Do not hide failed delegation or claim a
worker was used when no call was made. No automatic retries of failed tasks.

## Long tasks and context recovery

At a new task, after resume or after context compaction, re-read the applicable
workspace AGENTS.md and this policy before deciding whether to delegate.
The tool repository's AGENTS.md is not automatically a global instruction;
other workspaces need their own reference to this policy.

For a long task, save a checkpoint at meaningful milestones or before a planned
handoff under `local/tasks/<parent-task-id>.checkpoint.local.json`. Include:

- Current user objective, scope and constraints.
- Delegation decision and the reason for it.
- Active and finished task IDs, run IDs and session IDs.
- Acceptance evidence and work still needing verification.
- Remaining actions and known side effects.

Use structured JSON writes and never store credentials in checkpoints. Keep
machine-local state out of Git. Resume only the current task; an old checkpoint
does not authorize reviving an unrelated previous objective.

Check recorded runs before creating replacements. A last-known working state
does not prove a worker is still alive; inspect the actual process/session and
side effects before deciding what to do. If a run completed, inspect its result
and independently verify the criteria. Record the verdict and evidence using
`record_deepseek_verification`. Never treat protocol completion as acceptance.

## Visibility and enforcement

The local dashboard normally runs at http://127.0.0.1:8766. It shows calls that
reached the adapter, not a task the primary agent considered but never sent.
Record a meaningful blocker or a non-delegation decision in the checkpoint
and mention it in the task report when relevant.

These instructions and checkpoints improve recovery but are still interpreted
by a model. Strict enforcement needs an external workflow controller that
creates required worker steps and refuses completion until their execution
and acceptance evidence exist. MCP registration and a dashboard alone do not
provide that enforcement. No such mandatory controller is currently installed.
