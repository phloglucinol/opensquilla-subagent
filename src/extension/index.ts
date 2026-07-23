/**
 * OpenSquilla Subagent — delegate a task to an isolated OpenSquilla agent
 * with its own SquillaRouter model routing (c0–c3).
 *
 * Runs `opensquilla agent --json` as a subprocess. OpenSquilla handles
 * provider auth, tool surface, per-turn model routing, and context
 * management internally; Pi only sees the final text + routing metadata.
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

interface Routing {
	routed_tier?: string;
	routed_model?: string;
	routing_source?: string;
	routing_confidence?: number;
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

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "opensquilla_subagent",
		label: "OpenSquilla Subagent",
		description: [
			"Delegate a self-contained task to an isolated OpenSquilla agent.",
			"The subagent has its own context window, tool surface, and per-turn",
			"SquillaRouter model routing (c0 flash / c1 pro / c2 glm-5.2 / c3 kimi-code).",
			"Returns final text plus routing metadata (tier, model, source).",
			"Use for: isolated investigations, code reviews, synthesis that benefits",
			"from an independent context and automatic model selection.",
			"NOT for: simple edits (use edit), reading files (use read), or work",
			"needing shared Pi session state.",
		].join(" "),
		promptSnippet:
			"Delegate an isolated task to OpenSquilla with its own SquillaRouter model routing",
		promptGuidelines: [
			"Use opensquilla_subagent when a task benefits from an isolated context window or independent model routing, such as reviewing a change, investigating a codebase area, or synthesizing a report. For simple edits or reads, use the built-in tools directly.",
		],
		parameters: Type.Object({
			task: Type.String({
				description: "Complete, self-contained task description and expected output format",
			}),
			permissions: StringEnum(["restricted", "bypass", "full"] as const, {
				description:
					"restricted=read-only (default), bypass=workspace-contained writes, full=unrestricted. bypass/full prompt in TUI.",
				default: "restricted",
			}),
			timeout: Type.Optional(
				Type.Integer({
					minimum: 10,
					maximum: 3600,
					description: "Total subagent wall-clock timeout in seconds (default 600)",
				}),
			),
			maxIterations: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 100,
					description: "Max model/tool loop iterations (default 20)",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const perms = params.permissions ?? "restricted";
			const timeout = params.timeout ?? 600;
			const maxIter = params.maxIterations ?? 20;

			// Gate write-capable modes behind a TUI confirm. In non-interactive
			// (print/rpc/json) mode ctx.hasUI is false and we refuse bypass/full
			// so a runaway model cannot escalate writes silently.
			if (perms === "bypass" || perms === "full") {
				if (!ctx.hasUI) {
					throw new Error(
						`permissions=${perms} requires interactive confirmation; rerun in TUI mode or use permissions="restricted"`,
					);
				}
				const ok = await ctx.ui.confirm(
					"OpenSquilla write mode",
					`Run subagent with permissions=${perms}? This lets the OpenSquilla process write files under ${ctx.cwd}.`,
				);
				if (!ok) throw new Error("cancelled by user");
			}

			const scratch = await mkdtemp(join(tmpdir(), "opensquilla-subagent-"));

			const args = [
				"agent",
				"--json",
				"--workspace",
				ctx.cwd,
				"--workspace-strict",
				"--scratch-dir",
				scratch,
				"--permissions",
				perms,
				"--stateless-keep-project-rules",
				"--no-memory-capture",
				"--timeout",
				String(timeout),
				"--max-iterations",
				String(maxIter),
				"--max-provider-retries",
				"2",
				"--message",
				params.task,
			];
			// Contain writes to workspace/scratch in write-capable modes.
			if (perms === "bypass" || perms === "full") {
				args.push("--workspace-lockdown");
			}

			onUpdate?.({
				content: [{ type: "text", text: `OpenSquilla subagent running (permissions=${perms})...` }],
			});

			let result;
			try {
				result = await pi.exec(OPENSQUILLA_BIN, args, {
					cwd: ctx.cwd,
					signal,
					timeout: (timeout + 15) * 1000,
				});
			} catch (err) {
				if (signal?.aborted) throw new Error("OpenSquilla subagent aborted");
				throw new Error(
					`failed to run opensquilla: ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			if (signal?.aborted || result.killed) {
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
				throw new Error(
					`opensquilla returned non-JSON: ${result.stdout.slice(0, 200)}`,
				);
			}

			if (payload.status !== "ok") {
				const errs =
					payload.errors
						?.map((e) => e.message || e.code || "unknown")
						.join("; ") || "agent failed";
				throw new Error(`OpenSquilla agent failed: ${errs}`);
			}

			const fullText = payload.text || "(no output)";
			const trunc = truncateHead(fullText, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			// Always persist full output for later inspection.
			const outputPath = join(scratch, "result.txt");
			await writeFile(outputPath, fullText, "utf8");

			let out = trunc.content;
			if (trunc.truncated) {
				out += `\n\n[Output truncated: ${trunc.outputLines}/${trunc.totalLines} lines (${formatSize(trunc.outputBytes)}/${formatSize(trunc.totalBytes)}). Full output: ${outputPath}]`;
			}

			// Append a compact routing line so the model sees what happened.
			const r = payload.routing;
			if (r) {
				out += `\n\n[opensquilla routing: tier=${r.routed_tier ?? "?"} model=${r.routed_model ?? "?"} source=${r.routing_source ?? "?"}]`;
			}

			return {
				content: [{ type: "text", text: out }],
				details: {
					usage: payload.usage,
					routing: payload.routing,
					artifacts: payload.artifacts,
					sessionKey: payload.session_key,
					outputPath,
					scratchDir: scratch,
				},
			};
		},
	});
}
