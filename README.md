# pi-spawn

> Minimal subagent extension for the pi coding agent — isolated in-process tasks with a fresh context window.

## Install

```bash
pi install npm:pi-spawn
```

## What it does

`pi-spawn` adds a single `spawn` tool. Each call creates an isolated, in-process subagent session that runs one focused task and returns structured results. The subagent gets a completely fresh context window — it has zero access to your parent conversation history, so every file path, pattern, and requirement must be stated in the prompt.

There is no batching API and no concurrency parameter. The orchestrator (you, the calling model) controls concurrency naturally through your tool call pattern. Fire one `spawn` for a single task, fire several in one turn for parallel work, or chain them sequentially when steps depend on each other. pi's execution engine handles the rest.

## Concurrency model

| Pattern | When to use it | How |
|---------|---------------|-----|
| **Single** | One focused task | Call `spawn` once |
| **Parallel** | Independent tasks | Fire multiple `spawn` calls in one turn |
| **Serial** | Step B needs Step A's output | Call `spawn`, wait for result, then call again |
| **Mixed** | Scout then build | Parallel scouts → parent merges findings → serial implementation |

**Rule:** if spawn A's output feeds spawn B, use serial. Never fire both in one turn and hope A finishes first.

## When to spawn vs when NOT to spawn

**Spawn** when a task has a different focus than the parent and benefits from isolation: fresh code review, parallel reconnaissance across a codebase, research, validation, or non-trivial code generation where you do **not** already know the exact implementation.

**Do NOT spawn** if you know the exact implementation — write the file directly instead.

**Empty-shell test:** If removing the inline code from your prompt leaves an empty prompt, you are just dictating variable names line-by-line. Write the file directly.

## Security model

- **Tool inheritance:** The child inherits the parent's currently active built-in tool subset. If the parent is in a restricted mode (for example read-only plan mode), the child inherits that restriction.
- **Recursion guard:** The `spawn` extension is explicitly excluded from the subagent's loaded extensions, preventing nested self-spawn.
- **Same permissions:** Spawned agents run with the same model credentials and permissions as the parent.

## Usage examples

- "Spawn a subagent to review `src/auth.ts` for security issues"
- "Spawn three subagents in parallel: one to find all model definitions, one to find all provider configs, one to find all tool registrations"
- "Spawn a subagent to research the best retry strategy for fetch, then implement it"
- "Spawn a subagent to read `src/db/schema.ts` and validate that all foreign keys have matching indexes"

## Configuration

You can optionally override the thinking level for a single subagent via the `thinking` parameter:

```
spawn({
  prompt: "Refactor the error handling in src/api/client.ts",
  thinking: "high"
})
```

If omitted, the subagent defaults to the parent's current thinking level.

## License

MIT
