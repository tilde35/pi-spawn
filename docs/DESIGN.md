# Spawn Subagent Extension — Design

## Overview

A minimal pi extension with a single `spawn` tool. Each call creates an
isolated, in-process subagent session that runs one task and returns structured
results. The orchestrator (the calling model) controls concurrency through its
call pattern — there is no batching or explicit concurrency parameter.

## Architecture

```
Parent model
   │
   ├─ spawn({prompt: "Refactor auth..."})    single task
   ├─ spawn({prompt: "Search models..."})    ┐
   ├─ spawn({prompt: "Search routes..."})    │ parallel (same turn)
   └─ spawn({prompt: "Search views..."})     ┘
```

Each `spawn` call:
1. Creates a fresh `AgentSession` via `createAgentSession(SessionManager.inMemory)`
2. Loads pi's normal resources/extensions through `DefaultResourceLoader`
3. Inherits the parent's model, thinking level, and currently active built-in tool subset
4. Appends a focused subagent instruction to the normal system prompt
5. Streams output via `onUpdate`
6. Collects final output + usage stats
7. Disposes the session

## Design Decisions

### 1. No concurrency parameter — orchestrator-driven

The original design had `tasks[]` with `concurrency: "serial" | "parallel"`.
This was removed because:

- **pi already supports parallel tool calls.** When the model fires N tool calls
  in one turn, pi's execution engine runs them concurrently. This is free.
- **Serial is the default.** When the model makes one `spawn` call at a time,
  pi waits for completion before the next turn. No parameter needed.
- **The model already has a concurrency model.** The model knows when to issue
  parallel calls (independent tasks) vs sequential calls (dependent tasks).

This removes 50+ lines of batch orchestration code and a confusing parameter.

### 2. In-process isolation via SDK

Uses `createAgentSession()` with `SessionManager.inMemory()` instead of
`child_process.spawn()` (used by the existing subagent example). Benefits:
- Zero serialization overhead
- Direct signal propagation (`ctx.signal` -> `session.abort()`)
- Same auth/model registry (no separate process auth)
- Fast startup

Requires passing `parentModel` and `modelRegistry` from the parent's
`ExtensionContext` so the subagent inherits API credentials.

The subagent also defaults to the parent's current thinking level unless the
caller overrides it explicitly.

### 3. Resource loading with policy inheritance

The subagent uses `DefaultResourceLoader` so normal pi resources still load:
- Extensions and their policy hooks
- Skills and prompt templates
- Project/global system prompt files

A focused subagent instruction is appended to the system prompt instead of
replacing pi's normal resource loading. This keeps permission gates and other
extension behavior active inside the subagent.

To keep the child scoped, only the currently active built-in tool subset from
`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` is enabled for the
subagent. If the parent is in a restricted mode (for example read-only plan
mode), the child inherits that restriction.

The spawn extension itself is explicitly excluded from the subagent's loaded
extensions via `extensionsOverride`, filtering by `SELF_PATH` (captured from
`import.meta.url` at module load). This is the authoritative recursion guard:
even if `tools: inheritedTools` acts as an allowlist, extension-registered
tools like spawn are added after session creation and could bypass it. The
extension filter removes the risk entirely.

### 4. Streaming UI via onUpdate + custom rendering

- `renderCall`: Bold `spawn subagent` label + first 3 lines of prompt (all lines when
  expanded). Uses `context.lastComponent` reuse via `SpawnCallComponent extends Text`.
- `renderResult` streaming (`isPartial`): `Running...` + live line preview (up to 20
  lines). Reuses `SpawnResultText` across streaming updates — no allocation per tick.
- `renderResult` collapsed: Status icon + first 10 lines of output +
  `... (N more lines, ⌃O to expand)` hint when output exceeds the preview limit.
  `keyHint` is shown inline when truncated, or as a standalone footer otherwise.
  Reuses `SpawnResultText` via `context.lastComponent`.
- `renderResult` expanded (⌃O): Full task prompt + formatted Markdown output +
  usage stats. Always creates a fresh `Container` (expanded views are infrequent
  and have variable children).
- `onUpdate`: Live text streaming as the subagent works.

### 5. Tool description as teaching document

The description teaches the model:
- **When to spawn**: refactors, parallel recon, research, code generation, review
- **How to write prompts**: self-contained, with file paths, expected format, bad/good examples
- **Tool inheritance**: child keeps the parent's currently active built-in tool subset
- **Concurrency model**: "Fire multiple spawn calls in one turn for parallel work"
- **Cost awareness**: independent token consumption, prefer read/grep for simple lookups
- **Context preservation**: only final output + stats returned

## Files

```
~/.pi/agent/extensions/spawn/
├── index.ts       (extension, 566 lines)
└── DESIGN.md      (this file)
```
