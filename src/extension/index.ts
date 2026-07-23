/**
 * OpenSquilla Subagent + Chain — delegate tasks to isolated OpenSquilla agents
 * with their own SquillaRouter model routing (c0–c3).
 *
 * - opensquilla_subagent: single delegation, one model tier
 * - opensquilla_chain: sequential steps, each an independent task boundary so
 *   SquillaRouter can pick a different tier per phase. {previous} inlines the
 *   prior step's output into the next step's task.
 *
 * Each call runs `opensquilla agent --json` as a subprocess. OpenSquilla
 * handles provider auth, tool dispatch, context, and per-turn routing
 * internally; Pi receives sanitized activity updates plus the final result.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const OPENSQUILLA_BIN = process.env.OPENSQUILLA_BIN ?? "opensquilla";
const MIN_TIMEOUT_SECONDS = 10;
const MAX_TIMEOUT_SECONDS = 600;
const DEFAULT_TIMEOUT_SECONDS = 300;
const MIN_ITERATIONS = 1;
const MAX_ITERATIONS = 15;
const DEFAULT_ITERATIONS = 8;
const MAX_TASK_BYTES = 120 * 1024;
const DEFAULT_CHAIN_PREVIOUS_BYTES = 12 * 1024;
const MAX_CHAIN_PREVIOUS_BYTES = 32 * 1024;
const MIN_CHAIN_PREVIOUS_BYTES = 1024;
const CHAIN_PREVIOUS_MAX_LINES = 500;
const PROGRESS_POLL_MS = 750;
const PROGRESS_HEARTBEAT_MS = 3000;

const PERMS_DESC =
	'restricted=agent read-only (default); bypass/full enable broader OpenSquilla capabilities, but writes remain contained to the workspace/scratch directory. OpenSquilla may maintain .opensquilla-cache runtime files in any mode. bypass/full require UI confirmation.';

interface Routing {
	routed_tier?: string;
	routed_model?: string;
	routing_source?: string;
}

interface OpenSquillaUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	reasoning_tokens?: number;
	cached_tokens?: number;
	cost_usd?: number;
}

interface Payload {
	status: string;
	text: string;
	errors?: Array<{ message?: string; code?: string }>;
	usage?: OpenSquillaUsage;
	routing?: Routing | null;
	artifacts?: unknown[];
	session_key?: string;
}

type ProgressCb = (text: string) => void;
type Effort = "fast" | "balanced" | "deep";
type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive";

interface ResolvedRunOptions {
	effort: Effort;
	timeout: number;
	maxIter: number;
	thinking?: Thinking;
	providerRetries: number;
}

interface WorkerActivityPayload {
	kind?: unknown;
	displayPath?: unknown;
	path?: unknown;
	root?: unknown;
	pattern?: unknown;
	include?: unknown;
}

interface ActivityMonitor {
	stop(): Promise<string[]>;
}

const EFFORT_DEFAULTS: Record<
	Effort,
	{ timeout: number; maxIter: number; thinking?: Thinking; providerRetries: number }
> = {
	fast: { timeout: 120, maxIter: 4, thinking: "off", providerRetries: 1 },
	balanced: { timeout: DEFAULT_TIMEOUT_SECONDS, maxIter: DEFAULT_ITERATIONS, providerRetries: 2 },
	deep: { timeout: MAX_TIMEOUT_SECONDS, maxIter: 12, providerRetries: 2 },
};

function boundedInteger(
	value: number | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
	name: string,
): number {
	const resolved = value ?? fallback;
	if (!Number.isInteger(resolved)) throw new Error(`${name} must be an integer`);
	return Math.max(minimum, Math.min(resolved, maximum));
}

function resolveRunOptions(input: {
	effort?: Effort;
	timeout?: number;
	maxIterations?: number;
	thinking?: Thinking;
}): ResolvedRunOptions {
	const effort = input.effort ?? "balanced";
	const defaults = EFFORT_DEFAULTS[effort];
	return {
		effort,
		timeout: boundedInteger(
			input.timeout,
			defaults.timeout,
			MIN_TIMEOUT_SECONDS,
			MAX_TIMEOUT_SECONDS,
			"timeout",
		),
		maxIter: boundedInteger(
			input.maxIterations,
			defaults.maxIter,
			MIN_ITERATIONS,
			MAX_ITERATIONS,
			"maxIterations",
		),
		thinking: input.thinking ?? defaults.thinking,
		providerRetries: defaults.providerRetries,
	};
}

function assertTaskSize(task: string): void {
	if (!task.trim()) throw new Error("task must not be empty");
	const bytes = Buffer.byteLength(task, "utf8");
	if (bytes > MAX_TASK_BYTES) {
		throw new Error(
			`task is too large (${formatSize(bytes)}); maximum is ${formatSize(MAX_TASK_BYTES)} because OpenSquilla receives it as one command-line argument`,
		);
	}
}

function toPiUsage(raw: OpenSquillaUsage | undefined): Usage | undefined {
	if (!raw) return undefined;
	const input = Math.max(0, raw.input_tokens ?? 0);
	const output = Math.max(0, raw.output_tokens ?? 0);
	const cacheRead = Math.max(0, raw.cached_tokens ?? 0);
	const reasoning = Math.max(0, raw.reasoning_tokens ?? 0);
	const totalTokens = Math.max(0, raw.total_tokens ?? input + output);
	const totalCost = Math.max(0, raw.cost_usd ?? 0);
	return {
		input,
		output,
		cacheRead,
		cacheWrite: 0,
		reasoning,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totalCost },
	};
}

function combineUsages(usages: Usage[]): Usage | undefined {
	if (usages.length === 0) return undefined;
	return usages.reduce<Usage>(
		(total, usage) => ({
			input: total.input + usage.input,
			output: total.output + usage.output,
			cacheRead: total.cacheRead + usage.cacheRead,
			cacheWrite: total.cacheWrite + usage.cacheWrite,
			reasoning: (total.reasoning ?? 0) + (usage.reasoning ?? 0),
			totalTokens: total.totalTokens + usage.totalTokens,
			cost: {
				input: total.cost.input + usage.cost.input,
				output: total.cost.output + usage.cost.output,
				cacheRead: total.cost.cacheRead + usage.cost.cacheRead,
				cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
				total: total.cost.total + usage.cost.total,
			},
		}),
		{
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	);
}

function truncateUtf8ToBytes(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}

function composeChainTask(
	template: string,
	previous: string,
	previousMaxBytes: number,
	outputPath?: string,
): string {
	if (!template.includes("{previous}")) {
		assertTaskSize(template);
		return template;
	}
	let inlined = previous;
	const trunc = truncateHead(previous, {
		maxLines: CHAIN_PREVIOUS_MAX_LINES,
		maxBytes: previousMaxBytes,
	});
	if (trunc.truncated) {
		const content = trunc.content || truncateUtf8ToBytes(previous, previousMaxBytes);
		const outputBytes = Buffer.byteLength(content, "utf8");
		inlined = `${content}\n\n[Previous step output truncated to ${formatSize(outputBytes)} of ${formatSize(trunc.totalBytes)}.${outputPath ? ` Full output: ${outputPath}` : ""}]`;
	}
	const task = template.replace(/\{previous\}/g, inlined);
	assertTaskSize(task);
	return task;
}

function shortWorkspacePath(cwd: string, value: unknown): string {
	if (typeof value !== "string" || !value) return ".";
	const rel = relative(cwd, value);
	const display = rel === "" ? "." : rel.startsWith("..") ? value : rel;
	return display.length > 120 ? `...${display.slice(-117)}` : display;
}

function formatWorkerActivity(cwd: string, payload: WorkerActivityPayload): string | undefined {
	if (typeof payload.kind !== "string") return undefined;
	const target = shortWorkspacePath(cwd, payload.displayPath ?? payload.path ?? payload.root);
	switch (payload.kind) {
		case "read_file":
			return `read ${target}`;
		case "list_dir":
			return `list ${target}`;
		case "glob_search":
			return `search in ${target}`;
		case "write_file":
		case "write":
			return `write ${target}`;
		case "edit_file":
		case "edit":
			return `edit ${target}`;
		case "shell":
		case "run_shell":
		case "execute":
			return `run shell in ${target}`;
		default:
			return `${payload.kind.replaceAll("_", " ")} ${target}`;
	}
}

async function startActivityMonitor(input: {
	cwd: string;
	label: string;
	perms: string;
	onProgress?: ProgressCb;
}): Promise<ActivityMonitor> {
	if (!input.onProgress) return { async stop() { return []; } };

	const workerDir = join(input.cwd, ".opensquilla-cache", "fs-worker");
	const initialNames = await readdir(workerDir).catch(() => [] as string[]);
	const seen = new Set(initialNames);
	const activities: string[] = [];
	const startedAt = Date.now();
	let lastEmitAt = 0;
	let polling = false;

	const emit = (force = false) => {
		const now = Date.now();
		if (!force && now - lastEmitAt < PROGRESS_HEARTBEAT_MS) return;
		lastEmitAt = now;
		const elapsed = Math.max(0, Math.round((now - startedAt) / 1000));
		const recent = activities.slice(-4);
		const status =
			recent.length > 0
				? `Recent activity:\n${recent.map((activity) => `- ${activity}`).join("\n")}`
				: elapsed < 8
					? "Starting runtime and selecting a model route..."
					: "Waiting for the model response or its next tool call...";
		input.onProgress?.(
			`${input.label} running ${elapsed}s (permissions=${input.perms})\n${status}`,
		);
	};

	const poll = async (forceEmit = false) => {
		if (polling) return;
		polling = true;
		let changed = false;
		try {
			const names = await readdir(workerDir).catch(() => [] as string[]);
			for (const name of names.sort()) {
				if (seen.has(name) || !name.endsWith(".json")) continue;
				try {
					const raw = await readFile(join(workerDir, name), "utf8");
					const activity = formatWorkerActivity(
						input.cwd,
						JSON.parse(raw) as WorkerActivityPayload,
					);
					seen.add(name);
					if (activity && activity !== activities.at(-1)) {
						activities.push(activity);
						if (activities.length > 20) activities.shift();
						changed = true;
					}
				} catch {
					// The worker may still be writing this JSON file; retry on the next poll.
				}
			}
		} finally {
			polling = false;
		}
		if (changed) emit(true);
		else emit(forceEmit);
	};

	emit(true);
	const interval = setInterval(() => void poll(), PROGRESS_POLL_MS);
	interval.unref();

	return {
		async stop() {
			clearInterval(interval);
			await poll(true);
			return [...activities];
		},
	};
}

/** Run one `opensquilla agent --json` turn. Throws on any failure. */
async function runTurn(
	pi: ExtensionAPI,
	input: {
		task: string;
		perms: string;
		timeout: number;
		maxIter: number;
		thinking?: Thinking;
		providerRetries: number;
		progressLabel: string;
		cwd: string;
		signal?: AbortSignal;
		onProgress?: ProgressCb;
	},
): Promise<{ payload: Payload; outputPath: string; activities: string[] }> {
	if (input.signal?.aborted) throw new Error("OpenSquilla subagent aborted");
	assertTaskSize(input.task);

	const scratch = await mkdtemp(join(tmpdir(), "opensquilla-subagent-"));
	let keepScratch = false;
	try {
		const args = [
			"agent",
			"--json",
			"--workspace",
			input.cwd,
			"--workspace-strict",
			"--scratch-dir",
			scratch,
			"--permissions",
			input.perms,
			"--stateless-keep-project-rules",
			"--no-memory-capture",
			"--timeout",
			String(input.timeout),
			"--max-iterations",
			String(input.maxIter),
			"--max-provider-retries",
			String(input.providerRetries),
			"--message",
			input.task,
		];
		if (input.thinking) args.push("--thinking", input.thinking);
		if (input.perms === "bypass" || input.perms === "full") {
			args.push("--workspace-lockdown");
		}

		const monitor = await startActivityMonitor({
			cwd: input.cwd,
			label: input.progressLabel,
			perms: input.perms,
			onProgress: input.onProgress,
		});
		let activities: string[] = [];
		let result;
		try {
			result = await pi.exec(OPENSQUILLA_BIN, args, {
				cwd: input.cwd,
				signal: input.signal,
				timeout: (input.timeout + 15) * 1000,
			});
		} catch (err) {
			if (input.signal?.aborted) throw new Error("OpenSquilla subagent aborted");
			throw new Error(
				`failed to run opensquilla: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			activities = await monitor.stop();
		}
		if (input.signal?.aborted) throw new Error("OpenSquilla subagent aborted");
		if (result.killed) {
			throw new Error(`OpenSquilla subagent was killed after ${input.timeout + 15} seconds`);
		}
		if (result.code !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
			if (detail.includes("ProfileLockBusyError")) {
				throw new Error(
					"OpenSquilla profile is busy in another process. Calls using the same profile cannot run concurrently; wait for the other run to finish or configure a separate OpenSquilla profile.",
				);
			}
			throw new Error(`opensquilla exited ${result.code}: ${detail.slice(0, 500)}`);
		}

		let payload: Payload;
		try {
			payload = JSON.parse(result.stdout);
		} catch {
			throw new Error(`opensquilla returned non-JSON: ${result.stdout.slice(0, 200)}`);
		}
		if (payload.status !== "ok") {
			const errs =
				payload.errors
					?.map((e) => e.message || e.code || "unknown")
					.join("; ") || "agent failed";
			throw new Error(`OpenSquilla agent failed: ${errs}`);
		}

		const outputPath = join(scratch, "result.txt");
		await writeFile(outputPath, payload.text || "", { encoding: "utf8", mode: 0o600 });
		keepScratch = true;
		return { payload, outputPath, activities };
	} finally {
		if (!keepScratch) {
			await rm(scratch, { recursive: true, force: true }).catch(() => {});
		}
	}
}

/** Truncate + append a routing line + truncation notice. */
function formatWithRouting(
	text: string,
	routing: Routing | null | undefined,
	outputPath: string,
): string {
	const trunc = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	let out = trunc.content;
	if (trunc.truncated) {
		out += `\n\n[Output truncated: ${trunc.outputLines}/${trunc.totalLines} lines (${formatSize(trunc.outputBytes)}/${formatSize(trunc.totalBytes)}). Full output: ${outputPath}]`;
	}
	if (routing) {
		out += `\n\n[opensquilla routing: tier=${routing.routed_tier ?? "?"} model=${routing.routed_model ?? "?"} source=${routing.routing_source ?? "?"}]`;
	}
	return out;
}

async function confirmWrite(
	ctx: ExtensionContext,
	perms: string,
	cwd: string,
): Promise<void> {
	if (perms !== "bypass" && perms !== "full") return;
	if (!ctx.hasUI) {
		throw new Error(
			`permissions=${perms} requires UI confirmation; rerun in TUI/RPC mode or use permissions="restricted"`,
		);
	}
	const ok = await ctx.ui.confirm(
		"OpenSquilla write mode",
		`Run with permissions=${perms}? OpenSquilla gets broader capabilities, while --workspace-lockdown contains writes to ${cwd} and its scratch directory.`,
	);
	if (!ok) throw new Error("cancelled by user");
}

export default function (pi: ExtensionAPI) {
	// ── opensquilla_subagent: single delegation ──────────────────────────
	pi.registerTool({
		name: "opensquilla_subagent",
		label: "OpenSquilla Subagent",
		description: [
			"Delegate one bounded, self-contained objective to an isolated OpenSquilla agent.",
			"The subagent has its own context window, tool surface, and per-turn",
			"SquillaRouter model routing (c0 flash / c1 pro / c2 kimi-code / c3 glm-5.2).",
			"Progress updates show elapsed time and recent file/search activity.",
			"Use effort=fast for scouting, extraction, and narrow checks; reserve deep for",
			"one tightly scoped high-risk question. Simple work stays with Pi. Scout only",
			"when scope is unknown; use separate calls for independent checks and a chain",
			"only for dependent phases. Pi performs final synthesis by default. Sibling calls",
			"in one Pi response execute sequentially to avoid profile-lock collisions; another",
			"process using the same profile can still conflict.",
		].join(" "),
		promptSnippet:
			"Delegate an isolated task to OpenSquilla with its own SquillaRouter model routing",
		promptGuidelines: [
			"Handle simple questions, small edits, and a few local reads directly in Pi; delegation is optional.",
			"Give each opensquilla_subagent call one bounded objective with explicit scope, an output limit, and an evidence format.",
			"Run one fast scout only when relevant scope, entry points, or key files are unknown; it maps the path without a full bug review, then Pi reads the key files and decides what to delegate next.",
			"When scope is known, select relevant lenses and use 2-3 separate opensquilla_subagent calls for independent checks; sibling calls in one Pi response execute sequentially to avoid profile-lock collisions, while another process using the same profile can still conflict.",
			"Use opensquilla_chain only when a later step depends on earlier output; keep dependent handoffs concise.",
			"The Pi parent performs final synthesis by default; do not launch a fast synthesis subagent by default.",
		],
		executionMode: "sequential",
		parameters: Type.Object(
			{
				task: Type.String({
					minLength: 1,
					description: "Complete, self-contained task description and expected output format",
				}),
				permissions: Type.Optional(
					StringEnum(["restricted", "bypass", "full"] as const, {
						description: PERMS_DESC,
						default: "restricted",
					}),
				),
				effort: Type.Optional(
					StringEnum(["fast", "balanced", "deep"] as const, {
						description: "Execution preset. fast=120s/4 iterations/thinking off/1 retry; balanced=300s/8; deep=600s/12. Explicit timeout/maxIterations/thinking override preset defaults.",
						default: "balanced",
					}),
				),
				thinking: Type.Optional(
					StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "adaptive"] as const, {
						description: "Optional OpenSquilla thinking-level override",
					}),
				),
				timeout: Type.Optional(
					Type.Integer({
						minimum: MIN_TIMEOUT_SECONDS,
						maximum: MAX_TIMEOUT_SECONDS,
						description: "Explicit wall-clock timeout override in seconds. Presets: fast 120, balanced 300, deep 600.",
					}),
				),
				maxIterations: Type.Optional(
					Type.Integer({
						minimum: MIN_ITERATIONS,
						maximum: MAX_ITERATIONS,
						description: "Explicit model/tool loop iteration override. Presets: fast 4, balanced 8, deep 12.",
					}),
				),
			},
			{ additionalProperties: false },
		),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const perms = params.permissions ?? "restricted";
			const options = resolveRunOptions({
				effort: params.effort,
				timeout: params.timeout,
				maxIterations: params.maxIterations,
				thinking: params.thinking,
			});
			await confirmWrite(ctx, perms, ctx.cwd);

			const onProgress: ProgressCb = (t) =>
				onUpdate?.({ content: [{ type: "text", text: t }], details: undefined });

			const { payload, outputPath, activities } = await runTurn(pi, {
				task: params.task,
				perms,
				timeout: options.timeout,
				maxIter: options.maxIter,
				thinking: options.thinking,
				providerRetries: options.providerRetries,
				progressLabel: `OpenSquilla subagent (${options.effort})`,
				cwd: ctx.cwd,
				signal,
				onProgress,
			});

			const text = formatWithRouting(
				payload.text || "(no output)",
				payload.routing,
				outputPath,
			);
			return {
				content: [{ type: "text", text }],
				details: {
					usage: payload.usage,
					routing: payload.routing,
					artifacts: payload.artifacts,
					sessionKey: payload.session_key,
					effort: options.effort,
					thinking: options.thinking,
					activities,
					outputPath,
				},
				usage: toPiUsage(payload.usage),
			};
		},
	});

	// ── opensquilla_chain: sequential steps, per-step routing ───────────
	const ChainStep = Type.Object(
		{
			task: Type.String({
				minLength: 1,
				description:
					"Task for this step. Use {previous} to inline the prior step's output text.",
			}),
			permissions: Type.Optional(
				StringEnum(["restricted", "bypass", "full"] as const, {
					description: "Per-step permission override (default: chain-level permissions)",
				}),
			),
			effort: Type.Optional(
				StringEnum(["fast", "balanced", "deep"] as const, {
					description: "Per-step execution preset override",
				}),
			),
			thinking: Type.Optional(
				StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "adaptive"] as const, {
					description: "Per-step thinking-level override",
				}),
			),
			previousMaxBytes: Type.Optional(
				Type.Integer({
					minimum: MIN_CHAIN_PREVIOUS_BYTES,
					maximum: MAX_CHAIN_PREVIOUS_BYTES,
					description: "Maximum prior-step output bytes inserted into this step (default 12KB)",
				}),
			),
			timeout: Type.Optional(
				Type.Integer({
					minimum: MIN_TIMEOUT_SECONDS,
					maximum: MAX_TIMEOUT_SECONDS,
					description: "Per-step wall-clock timeout override; otherwise inherits the chain preset/override",
				}),
			),
			maxIterations: Type.Optional(
				Type.Integer({
					minimum: MIN_ITERATIONS,
					maximum: MAX_ITERATIONS,
					description: "Per-step iteration override; otherwise inherits the chain preset/override",
				}),
			),
		},
		{ additionalProperties: false },
	);

	pi.registerTool({
		name: "opensquilla_chain",
		label: "OpenSquilla Chain",
		description: [
			"Run 2-4 dependent OpenSquilla phases when a later step needs earlier output.",
			"Each step is an independent turn with separate SquillaRouter classification",
			"and visible activity updates.",
			"Use {previous} only for concise handoffs; 12KB is inserted by default.",
			"Use separate opensquilla_subagent calls for independent checks. Pi performs",
			"final synthesis by default. Sibling calls in one Pi response execute sequentially",
			"to avoid profile-lock collisions; another process can still conflict.",
			"Fails fast: a failed step stops the chain and reports completed outputs.",
		].join(" "),
		promptSnippet: "Run a multi-step OpenSquilla chain where each step gets its own SquillaRouter tier",
		promptGuidelines: [
			"Use opensquilla_chain only when a later step depends on earlier output; keep it to 2-4 bounded steps with concise structured handoffs.",
			"Use separate opensquilla_subagent calls for independent checks; sibling calls in one Pi response execute sequentially to avoid profile-lock collisions, while another process using the same profile can still conflict.",
			"The Pi parent performs final synthesis by default; do not add a synthesis chain step by default.",
		],
		executionMode: "sequential",
		parameters: Type.Object(
			{
				steps: Type.Array(ChainStep, {
					minItems: 1,
					maxItems: 10,
					description: "Ordered steps (max 10). Each is an independent OpenSquilla turn with its own routing.",
				}),
				permissions: Type.Optional(
					StringEnum(["restricted", "bypass", "full"] as const, {
						description: PERMS_DESC,
						default: "restricted",
					}),
				),
				effort: Type.Optional(
					StringEnum(["fast", "balanced", "deep"] as const, {
						description: "Default execution preset for steps",
						default: "balanced",
					}),
				),
				thinking: Type.Optional(
					StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "adaptive"] as const, {
						description: "Default thinking-level override for steps",
					}),
				),
				previousMaxBytes: Type.Optional(
					Type.Integer({
						minimum: MIN_CHAIN_PREVIOUS_BYTES,
						maximum: MAX_CHAIN_PREVIOUS_BYTES,
						description: "Default maximum prior-step output bytes inserted into the next step (default 12KB)",
					}),
				),
				timeout: Type.Optional(
					Type.Integer({
						minimum: MIN_TIMEOUT_SECONDS,
						maximum: MAX_TIMEOUT_SECONDS,
						description: "Explicit default timeout override for chain steps; otherwise uses each step's effort preset",
					}),
				),
				maxIterations: Type.Optional(
					Type.Integer({
						minimum: MIN_ITERATIONS,
						maximum: MAX_ITERATIONS,
						description: "Explicit default iteration override for chain steps; otherwise uses each step's effort preset",
					}),
				),
			},
			{ additionalProperties: false },
		),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const defaultPerms = params.permissions ?? "restricted";

			if (params.steps.length === 0) throw new Error("chain requires at least one step");
			if (params.steps.length > 10) {
				throw new Error(`chain too long (${params.steps.length} steps); max 10`);
			}

			// If any step is write-capable, confirm once up front through Pi's UI.
			const hasWrite = params.steps.some((s) => {
				const p = s.permissions ?? defaultPerms;
				return p === "bypass" || p === "full";
			});
			if (hasWrite) {
				if (!ctx.hasUI) {
					throw new Error(
						"chain has bypass/full steps which require UI confirmation; use permissions=restricted or rerun in TUI/RPC mode",
					);
				}
				const ok = await ctx.ui.confirm(
					"OpenSquilla chain write mode",
					`One or more chain steps use bypass/full permissions under ${ctx.cwd}.`,
				);
				if (!ok) throw new Error("cancelled by user");
			}

			const onProgress: ProgressCb = (t) =>
				onUpdate?.({ content: [{ type: "text", text: t }], details: undefined });

			const results: Array<{
				step: number;
				taskPreview: string;
				status: string;
				routing?: Routing | null;
				usage?: OpenSquillaUsage;
				effort: Effort;
				thinking?: Thinking;
				activities: string[];
				outputPath: string;
			}> = [];
			const usages: Usage[] = [];
			let previous = "";
			let previousOutputPath: string | undefined;

			for (let i = 0; i < params.steps.length; i++) {
				if (signal?.aborted) throw new Error("chain aborted");
				const step = params.steps[i];
				const perms = step.permissions ?? defaultPerms;
				const options = resolveRunOptions({
					effort: step.effort ?? params.effort,
					timeout: step.timeout ?? params.timeout,
					maxIterations: step.maxIterations ?? params.maxIterations,
					thinking: step.thinking ?? params.thinking,
				});
				const previousMaxBytes = boundedInteger(
					step.previousMaxBytes ?? params.previousMaxBytes,
					DEFAULT_CHAIN_PREVIOUS_BYTES,
					MIN_CHAIN_PREVIOUS_BYTES,
					MAX_CHAIN_PREVIOUS_BYTES,
					`steps[${i}].previousMaxBytes`,
				);
				const task = composeChainTask(
					step.task,
					previous,
					previousMaxBytes,
					previousOutputPath,
				);

				let turn;
				try {
					turn = await runTurn(pi, {
						task,
						perms,
						timeout: options.timeout,
						maxIter: options.maxIter,
						thinking: options.thinking,
						providerRetries: options.providerRetries,
						progressLabel: `Chain step ${i + 1}/${params.steps.length} (${options.effort})`,
						cwd: ctx.cwd,
						signal,
						onProgress,
					});
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					const completed = results
						.map(
							(r) =>
								`step ${r.step}: ${r.routing?.routed_tier ?? "?"} / ${r.routing?.routed_model ?? "?"}; output=${r.outputPath}`,
						)
						.join("\n");
					throw new Error(
						`chain failed at step ${i + 1}: ${msg}${completed ? `\nCompleted steps:\n${completed}` : ""}`,
					);
				}
				previous = turn.payload.text || "";
				previousOutputPath = turn.outputPath;
				const usage = toPiUsage(turn.payload.usage);
				if (usage) usages.push(usage);
				results.push({
					step: i + 1,
					taskPreview: step.task.slice(0, 120),
					status: turn.payload.status,
					routing: turn.payload.routing,
					usage: turn.payload.usage,
					effort: options.effort,
					thinking: options.thinking,
					activities: turn.activities,
					outputPath: turn.outputPath,
				});
			}

			const finalText = previous || "(no output)";
			const finalOutputPath = results[results.length - 1].outputPath;
			const trunc = truncateHead(finalText, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			let out = trunc.content;
			if (trunc.truncated) {
				out += `\n\n[Output truncated: ${trunc.outputLines}/${trunc.totalLines} lines (${formatSize(trunc.outputBytes)}/${formatSize(trunc.totalBytes)}). Full output: ${finalOutputPath}]`;
			}
			const summary = results
				.map(
					(r) =>
						`step ${r.step}: ${r.routing?.routed_tier ?? "?"} / ${r.routing?.routed_model ?? "?"} (${r.effort}, ${r.routing?.routing_source ?? "?"})`,
				)
				.join("\n");
			out += `\n\n[chain routing per step]\n${summary}`;

			return {
				content: [{ type: "text", text: out }],
				details: { steps: results, finalOutputPath },
				usage: combineUsages(usages),
			};
		},
	});
}
