# DeepSeek delegation in this workspace

Use `scripts/invoke-dsh.ps1` for shell delegation, or the registered MCP tool
`delegate_to_deepseek`. Both use `tools/dsh-mcp/task-runner.mjs`.

- Read `docs/dsh-task-contract.md` before forming a task. The input is the task
  object itself, matching `schemas/dsh-task.schema.json`.
- Delegate bounded routine work such as explanations, log summaries, document
  drafts or mechanical transformations. The primary agent owns architecture,
  complex debugging and final review.
- Default to `read_only`, a new session and explicit absolute allowed paths.
  Empty `allowed_paths` means context-only work without project file access.
- These constraints are prompts, not an independent OS sandbox. Do not assume
  they enforce file or tool permissions.
- Never send, print or persist the API key. Credentials come from
  `DEEPSEEK_RELAY_API_KEY`; only its name belongs in configuration.
- Wait for the terminal result. Check status, error, protocol and output format.
  A `completed` result still requires independent verification of every
  acceptance criterion, file changes and relevant tests.
- Do not automatically retry failed or canceled tasks. Determine whether they
  already caused side effects before deciding to rerun.
- Calls are serialized per MCP server, not across all servers and CLI clients.
  Keep caller timeout longer than task timeout plus any queue time.

Validation commands (from this directory):

```powershell
node --test tests/test-dsh-mcp.mjs
node --test tests/test-dsh-live.mjs
```

The first is offline. The second calls the configured relay and consumes API
tokens. Windows cleanup tests require permission to terminate child processes;
a restricted sandbox can deny `taskkill`. DSH also writes its own profile/session
data under the user's `.dsh` directory even for a read-only project task.
