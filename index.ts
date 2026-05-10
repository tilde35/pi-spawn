/**
 * spawn — Minimal subagent extension
 *
 * One tool. One prompt. The orchestrator controls concurrency.
 *
 *   Single call   → one subagent, one task
 *   Multiple calls → pi runs them in parallel (the model decides)
 *   Sequential    → the model waits for each spawn to finish before calling again
 *
 * Design:
 *   Each spawn creates an isolated in-process AgentSession via the pi SDK.
 *   Custom renderCall/renderResult shows live streaming + token/cost stats.
 *   No task batching, no concurrency parameter — the orchestrator's
 *   call pattern IS the concurrency model.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message, Model } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ModelRegistry,
	type TruncationResult,
	DefaultResourceLoader,
	createAgentSession,
	defineTool,
	formatSize,
	getAgentDir,
	getMarkdownTheme,
	keyHint,
	SessionManager,
	SettingsManager,
	truncateHead,
	truncateTail,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// Path of this extension file — used to exclude spawn from subagent sessions.
const SELF_PATH = fileURLToPath(import.meta.url);

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
	model: string;
	stopReason: string | undefined;
}

interface TaskResult {
	prompt: string;
	output: string;
	usage: SubagentUsage;
	error?: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

interface SpawnDetails {
	mode: "spawn";
	results: TaskResult[];
}

// ─────────────────────────────────────────────────────────────
// Render components
// ─────────────────────────────────────────────────────────────

/** Reusable Text component for renderCall — carries state across renders. */
class SpawnCallComponent extends Text {
	constructor() {
		super("", 0, 0);
	}
}

/** Reusable Text component for renderResult (collapsed + streaming) — avoids allocation on each render. */
class SpawnResultText extends Text {
	constructor() {
		super("", 0, 0);
	}
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

const STREAM_MAX_BYTES = 8 * 1024;
const STREAM_MAX_LINES = 200;

function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10_000) return (n / 1000).toFixed(1) + "k";
	return Math.round(n / 1000) + "k";
}

function formatUsage(u: SubagentUsage): string {
	const parts: string[] = [];
	if (u.turns) parts.push(u.turns + " turn" + (u.turns > 1 ? "s" : ""));
	if (u.input) parts.push("\u2191" + formatTokens(u.input));
	if (u.output) parts.push("\u2193" + formatTokens(u.output));
	if (u.cacheRead) parts.push("R" + formatTokens(u.cacheRead));
	if (u.cacheWrite) parts.push("W" + formatTokens(u.cacheWrite));
	if (u.cost) parts.push("$" + u.cost.toFixed(4));
	if (u.contextTokens > 0) parts.push("ctx:" + formatTokens(u.contextTokens));
	if (u.model) parts.push(u.model);
	return parts.join(" ");
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "assistant") {
			for (const part of m.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function truncateStreamingPreview(text: string): string {
	const truncation = truncateTail(text, {
		maxLines: STREAM_MAX_LINES,
		maxBytes: STREAM_MAX_BYTES,
	});
	if (!truncation.truncated) return truncation.content;
	return (
		`[stream preview truncated to last ${STREAM_MAX_LINES} lines / ${formatSize(STREAM_MAX_BYTES)}]\n` +
		truncation.content
	);
}

async function truncateFinalOutput(
	output: string,
): Promise<Pick<TaskResult, "output" | "truncation" | "fullOutputPath">> {
	if (!output) return { output: "" };

	const truncation = truncateHead(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	let resultText = truncation.content;
	let fullOutputPath: string | undefined;

	if (truncation.truncated) {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-spawn-"));
		fullOutputPath = join(tempDir, "output.md");
		await withFileMutationQueue(fullOutputPath, async () => {
			await writeFile(fullOutputPath!, output, "utf8");
		});

		const omittedLines = truncation.totalLines - truncation.outputLines;
		const omittedBytes = truncation.totalBytes - truncation.outputBytes;
		resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
		resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
		resultText += ` ${omittedLines} lines (${formatSize(omittedBytes)}) omitted.`;
		resultText += ` Full output saved to: ${fullOutputPath}]`;
	}

	return {
		output: resultText,
		truncation: truncation.truncated ? truncation : undefined,
		fullOutputPath,
	};
}

function formatToolError(result: TaskResult): string {
	if (result.output) return `Subagent failed: ${result.error}\n\n${result.output}`;
	return `Subagent failed: ${result.error}`;
}

const SUBAGENT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
type SubagentTool = typeof SUBAGENT_TOOLS[number];
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const SUBAGENT_SYSTEM_PROMPT =
	"You are a focused coding subagent. Your context is fresh — the parent agent delegated this task because it requires isolated attention. Complete the task, then call return_result with a concise summary of what you did and what you found, including evidence such as file paths, line numbers, and specific values.";

const SPAWN_DESCRIPTION = `Spawn an isolated subagent with a fresh context window. Zero access to parent state. All context must be in the prompt.

## Writing a prompt
1. Ground with references, not inline code — give file paths. Have the subagent read them. Don't dump contents.
2. State what, not how. 3. Define output format. 4. Require return_result with evidence (cite paths, lines).

## When to spawn
Tasks with a different focus than the parent that benefit from isolation: fresh review, parallel recon, research, validation, non-trivial codegen (where you do NOT already know the exact implementation).

## When NOT to spawn
If you know the exact implementation, write the file directly. Signs you're spawning wrong: prompt has more code than task; subagent can't discover anything new; prompt dictates variable names and line-by-line behavior.

> Empty-shell test: If removing the code leaves an empty prompt, write the file directly.

## Dependencies & order
| Pattern | When | How |
|---------|------|-----|
| Serial | Step B needs Step A's output | Sequential spawn calls (pi waits) |
| Parallel | Independent work | Fire multiple in one turn (pi runs concurrently) |
| Mixed | Scout then build | Parallel scouts → parent merges → serial implementation |

Rule: if spawn A's output feeds spawn B, use serial. Never fire both in one turn and hope A finishes first.

## Cost awareness
Each spawn costs tokens independently. No free lunch.

BAD — inline code (write directly instead):
  spawn agent
    Implement this: [400 lines of code]
    Save to src/foo.ts

GOOD — reference delegation:
  spawn agent
    Read src/foo.ts for patterns. Implement retry wrapper at
    src/retry.ts with exponential backoff and jitter.
    Call return_result with path + summary.

Bad: "Find the bug in the auth code."
Good: "Read src/auth/login.ts lines 40-80. The login handler crashes when the token expires. Identify the root cause and call return_result with your findings. Cite the specific lines and values that demonstrate the bug."`;

// ─────────────────────────────────────────────────────────────
// Core: run a single subagent in an isolated in-process session
// ─────────────────────────────────────────────────────────────

async function runOne(
	prompt: string,
	parentModel: Model<any>,
	modelRegistry: ModelRegistry,
	thinking: ThinkingLevel,
	signal: AbortSignal | undefined,
	cwd: string,
	activeTools: readonly string[],
	onOutput: (text: string) => void,
): Promise<TaskResult> {
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		appendSystemPromptOverride: (base) => [...base, SUBAGENT_SYSTEM_PROMPT],
		noThemes: true,
		extensionsOverride: (base) => ({
			...base,
			extensions: base.extensions.filter((ext) => ext.resolvedPath !== SELF_PATH),
		}),
	});
	await resourceLoader.reload();

	const allowed = new Set<string>(SUBAGENT_TOOLS);
	const inheritedTools = activeTools.filter((tool): tool is SubagentTool =>
		allowed.has(tool),
	);

	// return_result tool — captures structured output from the subagent
	let returnedResult: string | undefined;
	const returnResultTool = defineTool({
		name: "return_result",
		label: "Return Result",
		description: "Call this tool exactly once when you have completed your task to return the final result to the parent agent.",
		parameters: Type.Object({
			result: Type.String({ description: "The result of your work, with evidence such as file paths, line numbers, and values." }),
		}),
		async execute(_toolCallId, params) {
			returnedResult = params.result;
			return {
				content: [{ type: "text", text: "Result submitted." }],
				details: {},
			};
		},
	});

	const { session } = await createAgentSession({
		cwd,
		sessionManager: SessionManager.inMemory(cwd),
		tools: [...inheritedTools],
		customTools: [returnResultTool],
		model: parentModel,
		modelRegistry,
		thinkingLevel: thinking,
		resourceLoader,
		settingsManager,
	});

	const messages: Message[] = [];
	const unsub = session.subscribe((evt: AgentSessionEvent) => {
		if (evt.type === "message_update" && evt.assistantMessageEvent.type === "text_delta") {
			onOutput(evt.assistantMessageEvent.delta);
		}
		if (evt.type === "message_end") {
			messages.push(evt.message as Message);
		}
		if (evt.type === "tool_execution_start") {
			onOutput("\n[" + evt.toolName + "] ");
		}
		if (evt.type === "tool_execution_update") {
			const text = evt.partialResult?.content?.find((c: { type: string; text?: string }) => c.type === "text")?.text;
			if (text) onOutput(text);
		}
	});

	const abortListener = () => {
		void session.abort();
	};

	try {
		if (signal?.aborted) {
			void session.abort();
		}
		signal?.addEventListener("abort", abortListener, { once: true });

		await session.prompt(prompt);

		const modelId = session.model?.id ?? parentModel.id;
		const usage = collectUsage(messages, modelId);
		const finalOutput = await truncateFinalOutput(returnedResult ?? getFinalOutput(messages));
		return { prompt, usage, ...finalOutput };
	} catch (err: any) {
		const modelId = session.model?.id ?? parentModel.id;
		const usage = collectUsage(messages, modelId);
		const finalOutput = await truncateFinalOutput(returnedResult ?? getFinalOutput(messages));
		return {
			prompt,
			usage,
			error: err?.message ?? String(err),
			...finalOutput,
		};
	} finally {
		signal?.removeEventListener("abort", abortListener);
		unsub();
		session.dispose();
	}
}

function collectUsage(messages: Message[], modelId: string): SubagentUsage {
	const usage: SubagentUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
		model: modelId,
		stopReason: undefined,
	};
	for (const m of messages) {
		if (m.role === "assistant") {
			usage.turns++;
			if (m.usage) {
				usage.input += m.usage.input || 0;
				usage.output += m.usage.output || 0;
				usage.cacheRead += m.usage.cacheRead || 0;
				usage.cacheWrite += m.usage.cacheWrite || 0;
				usage.cost += m.usage.cost?.total || 0;
				usage.contextTokens = m.usage.totalTokens || 0;
			}
			if (m.stopReason) usage.stopReason = m.stopReason;
			if (m.model && m.model !== modelId) usage.model = m.model;
		}
	}
	return usage;
}

// ─────────────────────────────────────────────────────────────
// Extension entry point
// ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const spawnTool = defineTool({
		name: "spawn",
		label: "Spawn Subagent",
		description: SPAWN_DESCRIPTION,

		promptSnippet: "Delegate one focused task to an isolated subagent",
		promptGuidelines: [
			"Ground prompts with file references, not inline code — have the subagent read files to discover patterns.",
			"State what, not how — if you know the exact implementation, write the file directly instead of spawning.",
			"Fire multiple spawn calls in one turn for parallel independent work — pi runs them concurrently.",
			"Make sequential spawn calls for dependent steps — each waits for the previous to finish.",
			"Every spawn consumes tokens independently — prefer handling simple lookups directly in the parent instead.",
		],

		parameters: Type.Object({
			prompt: Type.String({
				description:
					"Self-contained task for the subagent. Include file paths, code snippets, expected output format.",
			}),
			thinking: Type.Optional(
				StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, {
					description: "Override thinking level for this subagent. Defaults to the parent's current thinking level.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const thinking: ThinkingLevel = params.thinking ?? pi.getThinkingLevel();
			const parentModel = ctx.model;
			const modelRegistry = ctx.modelRegistry;
			const cwd = ctx.cwd;
			const activeTools = pi.getActiveTools();

			if (!parentModel || !modelRegistry) {
				throw new Error("No model selected. Select a model first.");
			}

			let streamedText = "";
			const onOut = (t: string) => {
				streamedText = truncateStreamingPreview(streamedText + t);
				onUpdate?.({
					content: [{ type: "text", text: streamedText }],
					details: {
						mode: "spawn",
						results: [{
							prompt: params.prompt,
							output: streamedText,
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, model: "", stopReason: undefined },
						}],
					} as SpawnDetails,
				});
			};

			const result = await runOne(
				params.prompt,
				parentModel,
				modelRegistry,
				thinking,
				signal,
				cwd,
				activeTools,
				onOut,
			);

			if (result.error) {
				throw new Error(formatToolError(result));
			}

			return {
				content: [{ type: "text", text: result.output }],
				details: { mode: "spawn", results: [result] } as SpawnDetails,
			};
		},

		renderCall(args, theme, context) {
			const comp = (context.lastComponent as SpawnCallComponent | undefined) ?? new SpawnCallComponent();
			const prompt = (args.prompt ?? "...") as string;
			const lines = prompt.split("\n");
			const maxLines = context.expanded ? lines.length : 3;
			const shown = lines.slice(0, maxLines).join("\n");
			const remaining = lines.length - maxLines;
			let text = theme.fg("toolTitle", theme.bold("spawn ")) + theme.fg("accent", "subagent");
			if (args.thinking) text += theme.fg("dim", ` [${args.thinking as string}]`);
			text += "\n" + theme.fg("dim", shown);
			if (remaining > 0) {
				text += theme.fg("muted", `\n... (${remaining} more lines, ${keyHint("app.tools.expand", "to expand")})`);
			}
			comp.setText(text);
			return comp;
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			// ── Streaming ──
			if (isPartial) {
				const comp = (context.lastComponent instanceof SpawnResultText
					? context.lastComponent
					: new SpawnResultText()) as SpawnResultText;
				const t = result.content[0];
				const raw = t?.type === "text" ? t.text : "";
				const lines = raw ? raw.split("\n") : [];
				const STREAM_PREVIEW = 20;
				const shown = lines.slice(0, STREAM_PREVIEW).join("\n");
				const remaining = lines.length - STREAM_PREVIEW;
				let text = theme.fg("warning", "Running...");
				if (shown) text += "\n" + theme.fg("dim", shown);
				if (remaining > 0) text += theme.fg("muted", `\n... (${remaining} more lines)`);
				comp.setText(text);
				return comp;
			}

			// ── No details (fallback) ──
			const details = result.details as SpawnDetails | undefined;
			if (!details || details.results.length === 0) {
				const comp = (context.lastComponent instanceof SpawnResultText
					? context.lastComponent
					: new SpawnResultText()) as SpawnResultText;
				const t = result.content[0];
				comp.setText(t?.type === "text" ? t.text : "(no output)");
				return comp;
			}

			const r = details.results[0];
			const isError = !!r.error;
			const icon = isError ? theme.fg("error", "\u2717") : theme.fg("success", "\u2713");
			const mdTheme = getMarkdownTheme();

			// ── Expanded ──
			if (expanded) {
				const container = new Container();
				container.addChild(new Text(icon + " " + theme.fg("toolTitle", "spawn"), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "\u2500\u2500\u2500 Task \u2500\u2500\u2500"), 0, 0));
				container.addChild(new Text(theme.fg("dim", r.prompt), 0, 0));
				container.addChild(new Spacer(1));
				if (isError) {
					container.addChild(new Text(theme.fg("error", "Error: " + r.error), 0, 0));
				} else if (r.output) {
					container.addChild(new Text(theme.fg("muted", "\u2500\u2500\u2500 Output \u2500\u2500\u2500"), 0, 0));
					container.addChild(new Markdown(r.output.trim(), 0, 0, mdTheme));
				} else {
					container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
				}
				if (r.fullOutputPath) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `Full output: ${r.fullOutputPath}`), 0, 0));
				}
				const usageStr = formatUsage(r.usage);
				if (usageStr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
				}
				return container;
			}

			// ── Collapsed ──
			const comp = (context.lastComponent instanceof SpawnResultText
				? context.lastComponent
				: new SpawnResultText()) as SpawnResultText;
			let text = icon + " " + theme.fg("toolTitle", "spawn");
			let hasExpandHint = false;
			if (isError) {
				text += "\n" + theme.fg("error", r.error as string);
			} else {
				const lines = r.output ? r.output.split("\n") : [];
				const COLLAPSED_PREVIEW = 10;
				const shown = lines.slice(0, COLLAPSED_PREVIEW).join("\n");
				const remaining = lines.length - COLLAPSED_PREVIEW;
				if (lines.length > 0) {
					text += "\n" + theme.fg("dim", shown);
					if (remaining > 0) {
						text += theme.fg("muted",
							`\n... (${remaining} more lines, ${keyHint("app.tools.expand", "to expand")})`
						);
						hasExpandHint = true;
					}
					if (r.truncation?.truncated) {
						text += "\n" + theme.fg("warning", "(output truncated \u2014 full saved to temp file)");
					}
				} else {
					text += "\n" + theme.fg("muted", "(no output)");
				}
			}
			const usageStr = formatUsage(r.usage);
			if (usageStr) text += "\n" + theme.fg("dim", usageStr);
			if (!hasExpandHint) {
				text += "\n" + theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`);
			}
			comp.setText(text);
			return comp;
		},
	});

	pi.registerTool(spawnTool);
}
