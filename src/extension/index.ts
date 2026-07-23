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
 * internally; Pi only sees the final text + routing metadata.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const OPENSQUILLA_BIN = process.env.OPENSQUILLA_BIN ?? "opensquilla";

const PERMS_DESC =
	'restricted=read-only (default), bypass=workspace-contained writes, full=unrestricted. bypass/full prompt in TUI.';

interface Routing {
	routed_tier?: string;
	routed_model?: string;
	routing_source?: string;
}

interface Payload {
	status: string;
	text: string;
	errors?: Array<{ message?: string; code?: string }>;
	usage?: unknown;
	routing?: Routing | null;
	artifacts?: unknown[];
	session_key?: string;
}

type ProgressCb = (text: string) => void;

/** Run one `opensquilla agent --json` turn. Throws on any failure. */
async function runTurn(
	pi: ExtensionAPI,
	input: {
		task: string;
		perms: string;
		timeout: number;
		maxIter: number;
		cwd: string;
		signal?: AbortSignal;
		onProgress?: ProgressCb;
	},
): Promise<{ payload: Payload; outputPath: string; scratch: string }> {
	const scratch = await mkdtemp(join(tmpdir(), "opensquilla-subagent-"));
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
		"2",
		"--message",
		input.task,
	];
	if (input.perms === "bypass" || input.perms === "full") {
		args.push("--workspace-lockdown");
	}

	input.onProgress?.(`OpenSquilla subagent running (permissions=${input.perms})...`);

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
	}
	if (input.signal?.aborted || result.killed) {
		throw new Error("OpenSquilla subagent aborted");
	}
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
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
	await writeFile(outputPath, payload.text || "", "utf8");
	return { payload, outputPath, scratch };
}

/** Persist full text to a fresh temp file and return the path. */
async function persistFull(text: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "opensquilla-out-"));
	const p = join(dir, "result.txt");
	await writeFile(p, text, "utf8");
	return p;
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
	ctx: Parameters<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4]>,
	perms: string,
	cwd: string,
): Promise<void> {
	if (perms !== "bypass" && perms !== "full") return;
	if (!ctx.hasUI) {
		throw new Error(
			`permissions=${perms} requires interactive confirmation; rerun in TUI mode or use permissions="restricted"`,
		);
	}
	const ok = await ctx.ui.confirm(
		"OpenSquilla write mode",
		`Run with permissions=${perms}? This lets the OpenSquilla process write files under ${cwd}.`,
	);
	if (!ok) throw new Error("cancelled by user");
}

export default function (pi: ExtensionAPI) {
	// ── opensquilla_subagent: single delegation ──────────────────────────
	pi.registerTool({
		name: "opensquilla_subagent",
		label: "OpenSquilla Subagent",
		description: [
			"Delegate a self-contained task to an isolated OpenSquilla agent.",
			"The subagent has its own context window, tool surface, and per-turn",
			"SquillaRouter model routing (c0 flash / c1 pro / c2 kimi-code / c3 glm-5.2).",
			"Returns final text plus routing metadata (tier, model, source).",
			"Use for: isolated investigations, code reviews, synthesis that benefits",
			"from an independent context and automatic model selection.",
			"NOT for: simple edits (use edit), reading files (use read), or work",
			"needing shared Pi session state. For multi-phase work, use opensquilla_chain.",
		].join(" "),
		promptSnippet:
			"Delegate an isolated task to OpenSquilla with its own SquillaRouter model routing",
		promptGuidelines: [
			"Use opensquilla_subagent when a single task benefits from an isolated context window or independent model routing. For multi-phase work where each phase deserves its own model tier, use opensquilla_chain instead.",
		],
		parameters: Type.Object({
			task: Type.String({
				description: "Complete, self-contained task description and expected output format",
			}),
			permissions: StringEnum(["restricted", "bypass", "full"] as const, {
				description: PERMS_DESC,
				default: "restricted",
			}),
			timeout: Type.Optional(
				Type.Integer({
					minimum: 10,
					maximum: 600,
					description: "Total subagent wall-clock timeout in seconds (default 300). Simple tasks need 60-120; reserve 300+ for deep audits.",
				}),
			),
			maxIterations: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 15,
					description: "Max model/tool loop iterations (default 8). Trivial Q&A needs 1-3; deep audits need 10-15.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const perms = params.permissions ?? "restricted";
			const timeout = Math.min(params.timeout ?? 300, 600);
			const maxIter = Math.min(params.maxIterations ?? 8, 15);
			await confirmWrite(ctx, perms, ctx.cwd);

			const onProgress: ProgressCb = (t) =>
				onUpdate?.({ content: [{ type: "text", text: t }] });

			const { payload, outputPath } = await runTurn(pi, {
				task: params.task,
				perms,
				timeout,
				maxIter,
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
					outputPath,
				},
			};
		},
	});

	// ── opensquilla_chain: sequential steps, per-step routing ───────────
	const ChainStep = Type.Object({
		task: Type.String({
			description:
				"Task for this step. Use {previous} to inline the prior step's output text.",
		}),
		permissions: Type.Optional(
			StringEnum(["restricted", "bypass", "full"] as const, {
				description: "Per-step permission override (default: chain-level permissions)",
			}),
		),
		timeout: Type.Optional(
			Type.Integer({ minimum: 10, maximum: 600, description: "Per-step timeout override (default 300)" }),
		),
		maxIterations: Type.Optional(
			Type.Integer({ minimum: 1, maximum: 15, description: "Per-step iteration override (default 8)" }),
		),
	});

	pi.registerTool({
		name: "opensquilla_chain",
		label: "OpenSquilla Chain",
		description: [
			"Run a sequence of OpenSquilla agent turns as a chain. Each step runs",
			"`opensquilla agent --json` independently, so SquillaRouter classifies and",
			"routes each step separately (step 1 may use c0 flash, step 3 may use c3 glm).",
			"Use {previous} in a step's task to inline the prior step's output. Use for",
			"multi-phase work like scout→review→synthesize where each phase deserves its",
			"own model tier. Returns the final step's text plus a per-step routing summary.",
			"Fails fast: a failed step stops the chain and reports which step failed.",
		].join(" "),
		promptSnippet: "Run a multi-step OpenSquilla chain where each step gets its own SquillaRouter tier",
		promptGuidelines: [
			"Use opensquilla_chain for multi-phase work where each phase deserves its own model tier, such as scout→review→synthesize or research→plan→implement. Use {previous} to pass the prior step's output forward. For a single delegation, use opensquilla_subagent.",
		],
		parameters: Type.Object({
			steps: Type.Array(ChainStep, {
				description: "Ordered steps (max 10). Each is an independent OpenSquilla turn with its own routing.",
			}),
			permissions: StringEnum(["restricted", "bypass", "full"] as const, {
				description: PERMS_DESC,
				default: "restricted",
			}),
			timeout: Type.Optional(
				Type.Integer({
					minimum: 10,
					maximum: 600,
					description: "Default per-step timeout in seconds (default 300)",
				}),
			),
			maxIterations: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 15,
					description: "Default per-step max iterations (default 8)",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const defaultPerms = params.permissions ?? "restricted";
			const defaultTimeout = Math.min(params.timeout ?? 300, 600);
			const defaultMaxIter = Math.min(params.maxIterations ?? 8, 15);

			if (params.steps.length === 0) throw new Error("chain requires at least one step");
			if (params.steps.length > 10) {
				throw new Error(`chain too long (${params.steps.length} steps); max 10`);
			}

			// If any step is write-capable, confirm once up front in TUI.
			const hasWrite = params.steps.some((s) => {
				const p = s.permissions ?? defaultPerms;
				return p === "bypass" || p === "full";
			});
			if (hasWrite) {
				if (!ctx.hasUI) {
					throw new Error(
						"chain has bypass/full steps which require TUI; use permissions=restricted or rerun in TUI",
					);
				}
				const ok = await ctx.ui.confirm(
					"OpenSquilla chain write mode",
					`One or more chain steps use bypass/full permissions under ${ctx.cwd}.`,
				);
				if (!ok) throw new Error("cancelled by user");
			}

			const onProgress: ProgressCb = (t) =>
				onUpdate?.({ content: [{ type: "text", text: t }] });

			const results: Array<{
				step: number;
				taskPreview: string;
				status: string;
				routing?: Routing | null;
				outputPath: string;
			}> = [];
			let previous = "";

			for (let i = 0; i < params.steps.length; i++) {
				if (signal?.aborted) throw new Error("chain aborted");
				const step = params.steps[i];
				const perms = step.permissions ?? defaultPerms;
				const task = step.task.replace(/\{previous\}/g, previous);
				const timeout = Math.min(step.timeout ?? defaultTimeout, 600);
				const maxIter = Math.min(step.maxIterations ?? defaultMaxIter, 15);

				onProgress(`chain step ${i + 1}/${params.steps.length} (permissions=${perms})...`);

				let turn;
				try {
					turn = await runTurn(pi, {
						task,
						perms,
						timeout,
						maxIter,
						cwd: ctx.cwd,
						signal,
						onProgress,
					});
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return {
						content: [
							{ type: "text", text: `chain failed at step ${i + 1}: ${msg}` },
						],
						details: { steps: results, failedAt: i + 1, error: msg },
						isError: true,
					};
				}
				previous = turn.payload.text || "";
				results.push({
					step: i + 1,
					taskPreview: step.task.slice(0, 120),
					status: turn.payload.status,
					routing: turn.payload.routing,
					outputPath: turn.outputPath,
				});
			}

			const finalText = previous || "(no output)";
			const finalOutputPath = await persistFull(finalText);
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
						`step ${r.step}: ${r.routing?.routed_tier ?? "?"} / ${r.routing?.routed_model ?? "?"} (${r.routing?.routing_source ?? "?"})`,
				)
				.join("\n");
			out += `\n\n[chain routing per step]\n${summary}`;

			return {
				content: [{ type: "text", text: out }],
				details: { steps: results, finalOutputPath },
			};
		},
	});
}
