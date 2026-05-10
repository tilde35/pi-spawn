<div align="center">

# pi-spawn

**Spawn sub-agents. Keep your context clean.**

[![npm version](https://img.shields.io/npm/v/pi-spawn?color=blue&logo=npm)](https://www.npmjs.com/package/pi-spawn)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![pi package](https://img.shields.io/badge/pi-package-%23f472b6)](https://github.com/badlogic/pi-mono)

</div>

Sub-agents exist for one reason: **context compression.**

A spawned agent can burn 150,000 tokens on research, reading files, and searching. It returns a few thousand tokens of synthesis. Your main agent's context stays lean and focused — no bloat, no attention decay, no critical constraints pushed into the noise floor.

```bash
pi install npm:pi-spawn
```

---

## Why context hygiene matters

Context windows lie. Advertised capacity is 200K tokens. Reliable attention tops out at 60–120K. Transformers have a U-shaped attention curve — information in the middle gets skimmed or ignored entirely.

Every file your agent reads, every search result it processes, pushes your actual task constraints deeper into that dead zone. Sub-agents fix this: they do the heavy lifting in isolation, then return a tight summary.

The result: your orchestrator agent holds only what it needs. First-iteration accuracy goes up. Token waste goes down.

---

## How it works

Tell your agent to spawn a sub-agent for focused work:

> Spawn a sub-agent to review `src/auth.ts` for security issues. Get a fresh perspective.

Your agent calls `spawn` once. A clean sub-agent reviews the file and returns findings. Your main context never sees the raw file — just the synthesis.

> Spawn three sub-agents in parallel: find all model definitions, all route registrations, and all tool configurations.

Your agent fires three `spawn` calls in one turn. pi runs them concurrently. Results come back together — each sub-agent's noise stays in its own sandbox.

> Spawn a sub-agent to research the best retry strategy for fetch, then implement it.

Agent spawns research, gets a synthesis, spawns implementation with the findings. Two isolated contexts, one clean orchestrator.

No batching API. No concurrency knob. No scheduling. Your agent calls `spawn` as many times as the task needs — once, N in parallel, or chained. You control the strategy.

---

## What's inside a spawned agent

- **Same tools** as your main agent (read, write, edit, bash, grep)
- **Same model and credentials** — plug and play
- **Zero context** — no history from your main session
- **Your thinking level** — override per spawn if needed
- **No nesting** — spawn is blocked inside sub-agents

---

## Why this exists

`pi-spawn` is the minimal spawn tool. If you need persistent agent memory, cron scheduling, custom agent types, cross-agent RPC, or worktree isolation — check out [`@tintinweb/pi-subagents`](https://agenticoding.ai/docs/methodology/lesson-5-grounding). It's excellent software.

If you want a single sharp tool that keeps your context clean — stay here.

---

## License

MIT
