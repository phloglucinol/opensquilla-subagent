import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerExtension from "../src/extension/index.ts";

interface RegisteredTool {
	name: string;
	parameters: Record<string, unknown>;
	executionMode?: "sequential" | "parallel";
	execute: (...args: any[]) => Promise<any>;
}

const originalTmpDir = process.env.TMPDIR;
let testTmpDir = "";

beforeEach(async () => {
	testTmpDir = await mkdtemp(join(tmpdir(), "opensquilla-extension-test-"));
	process.env.TMPDIR = testTmpDir;
});

afterEach(async () => {
	if (originalTmpDir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = originalTmpDir;
	await rm(testTmpDir, { recursive: true, force: true });
});

function payload(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		status: "ok",
		text: "done",
		usage: {
			input_tokens: 10,
			output_tokens: 4,
			total_tokens: 14,
			reasoning_tokens: 2,
			cached_tokens: 3,
			cost_usd: 0.25,
		},
		routing: {
			routed_tier: "c1",
			routed_model: "deepseek-v4-pro",
			routing_source: "v4_phase3",
		},
		artifacts: [],
		session_key: "agent:main:main",
		errors: [],
		...overrides,
	});
}

function createHarness(
	exec: (command: string, args: string[], options?: Record<string, unknown>) => Promise<any>,
) {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		exec,
	} as unknown as ExtensionAPI;
	registerExtension(pi);
	return {
		subagent: tools.get("opensquilla_subagent")!,
		chain: tools.get("opensquilla_chain")!,
	};
}

function context(options: { hasUI?: boolean; confirm?: boolean; cwd?: string } = {}) {
	return {
		cwd: options.cwd ?? process.cwd(),
		hasUI: options.hasUI ?? false,
		mode: options.hasUI ? "tui" : "print",
		ui: {
			confirm: async () => options.confirm ?? false,
		},
	};
}

function argValue(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
}

test("schemas make documented defaults optional and reject extra properties", () => {
	const { subagent, chain } = createHarness(async () => {
		throw new Error("not called");
	});
	const singleSchema = subagent.parameters as any;
	const chainSchema = chain.parameters as any;

	assert.deepEqual(singleSchema.required, ["task"]);
	assert.equal(singleSchema.additionalProperties, false);
	assert.deepEqual(chainSchema.required, ["steps"]);
	assert.equal(chainSchema.additionalProperties, false);
	assert.equal(chainSchema.properties.steps.minItems, 1);
	assert.equal(chainSchema.properties.steps.maxItems, 10);
	assert.equal(chainSchema.properties.steps.items.additionalProperties, false);
	assert.deepEqual(singleSchema.properties.effort.enum, ["fast", "balanced", "deep"]);
	assert.equal(subagent.executionMode, "sequential");
	assert.equal(chain.executionMode, "sequential");
	assert.equal(chainSchema.properties.previousMaxBytes.minimum, 1024);
	assert.equal(chainSchema.properties.previousMaxBytes.maximum, 32 * 1024);
});

test("single delegation applies defaults, persists output, and reports Pi usage", async () => {
	let invocation: { command: string; args: string[]; options?: Record<string, unknown> } | undefined;
	const { subagent } = createHarness(async (command, args, options) => {
		invocation = { command, args, options };
		return { code: 0, killed: false, stdout: payload(), stderr: "" };
	});

	const result = await subagent.execute("call-1", { task: "Inspect the module" }, undefined, undefined, context());
	assert.equal(invocation?.command, "opensquilla");
	assert.equal(argValue(invocation!.args, "--permissions"), "restricted");
	assert.equal(argValue(invocation!.args, "--timeout"), "300");
	assert.equal(argValue(invocation!.args, "--max-iterations"), "8");
	assert.equal(argValue(invocation!.args, "--max-provider-retries"), "2");
	assert.equal(invocation!.args.includes("--thinking"), false);
	assert.equal(invocation!.args.includes("--workspace-lockdown"), false);
	assert.equal(invocation?.options?.timeout, 315_000);
	assert.match(result.content[0].text, /tier=c1 model=deepseek-v4-pro/);
	assert.deepEqual(result.usage, {
		input: 10,
		output: 4,
		cacheRead: 3,
		cacheWrite: 0,
		reasoning: 2,
		totalTokens: 14,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
	});
	assert.equal(await readFile(result.details.outputPath, "utf8"), "done");
	assert.equal((await stat(result.details.outputPath)).mode & 0o777, 0o600);
});

test("fast effort applies lower-latency defaults", async () => {
	let args: string[] = [];
	const { subagent } = createHarness(async (_command, receivedArgs) => {
		args = receivedArgs;
		return { code: 0, killed: false, stdout: payload(), stderr: "" };
	});

	const result = await subagent.execute(
		"call-fast",
		{ task: "Scout one module", effort: "fast" },
		undefined,
		undefined,
		context(),
	);
	assert.equal(argValue(args, "--timeout"), "120");
	assert.equal(argValue(args, "--max-iterations"), "4");
	assert.equal(argValue(args, "--thinking"), "off");
	assert.equal(argValue(args, "--max-provider-retries"), "1");
	assert.equal(result.details.effort, "fast");
	assert.equal(result.details.thinking, "off");
});

test("runtime bounds protect direct callers that bypass schema validation", async () => {
	let args: string[] = [];
	const { subagent } = createHarness(async (_command, receivedArgs) => {
		args = receivedArgs;
		return { code: 0, killed: false, stdout: payload(), stderr: "" };
	});

	await subagent.execute(
		"call-2",
		{ task: "Bounds", timeout: 1, maxIterations: 99 },
		undefined,
		undefined,
		context(),
	);
	assert.equal(argValue(args, "--timeout"), "10");
	assert.equal(argValue(args, "--max-iterations"), "15");
});

test("write-capable modes require confirmation and always enable lockdown", async () => {
	let calls = 0;
	let args: string[] = [];
	const { subagent } = createHarness(async (_command, receivedArgs) => {
		calls++;
		args = receivedArgs;
		return { code: 0, killed: false, stdout: payload(), stderr: "" };
	});

	await assert.rejects(
		subagent.execute(
			"call-3",
			{ task: "Edit", permissions: "full" },
			undefined,
			undefined,
			context(),
		),
		/requires UI confirmation/,
	);
	assert.equal(calls, 0);

	await subagent.execute(
		"call-4",
		{ task: "Edit", permissions: "full" },
		undefined,
		undefined,
		context({ hasUI: true, confirm: true }),
	);
	assert.equal(calls, 1);
	assert.equal(args.includes("--workspace-lockdown"), true);
});

test("chain truncates previous output, aggregates usage, and avoids a duplicate final file", async () => {
	const messages: string[] = [];
	let call = 0;
	const firstText = "\u{1F600}".repeat(10_000);
	const { chain } = createHarness(async (_command, args) => {
		messages.push(argValue(args, "--message")!);
		call++;
		return {
			code: 0,
			killed: false,
			stdout:
				call === 1
					? payload({ text: firstText })
					: payload({
							text: "final",
							usage: {
								input_tokens: 20,
								output_tokens: 5,
								total_tokens: 25,
								cached_tokens: 1,
								cost_usd: 0.5,
							},
						}),
			stderr: "",
		};
	});

	const result = await chain.execute(
		"chain-1",
		{ steps: [{ task: "Produce data" }, { task: "Review:\n{previous}" }] },
		undefined,
		undefined,
		context(),
	);
	assert.equal(call, 2);
	assert.match(messages[1], /Previous step output truncated to 12\.0KB of 39\.1KB/);
	assert.ok(Buffer.byteLength(messages[1], "utf8") < 20_000);
	assert.equal(messages[1].includes("\uFFFD"), false);
	assert.equal(result.details.finalOutputPath, result.details.steps[1].outputPath);
	assert.notEqual(result.details.steps[0].outputPath, result.details.finalOutputPath);
	assert.deepEqual(result.usage, {
		input: 30,
		output: 9,
		cacheRead: 4,
		cacheWrite: 0,
		reasoning: 2,
		totalTokens: 39,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.75 },
	});
	const tempEntries = await readdir(testTmpDir);
	assert.equal(tempEntries.filter((name) => name.startsWith("opensquilla-subagent-")).length, 2);
	assert.equal(tempEntries.some((name) => name.startsWith("opensquilla-out-")), false);
});

test("chain failures throw and remove the failed turn scratch directory", async () => {
	let call = 0;
	const { chain } = createHarness(async () => {
		call++;
		if (call === 1) return { code: 0, killed: false, stdout: payload({ text: "first" }), stderr: "" };
		return { code: 2, killed: false, stdout: "", stderr: "provider unavailable" };
	});

	await assert.rejects(
		chain.execute(
			"chain-2",
			{ steps: [{ task: "First" }, { task: "Second with {previous}" }] },
			undefined,
			undefined,
			context(),
		),
		(error: Error) => {
			assert.match(error.message, /chain failed at step 2/);
			assert.match(error.message, /provider unavailable/);
			assert.match(error.message, /Completed steps:/);
			return true;
		},
	);
	const tempEntries = await readdir(testTmpDir);
	assert.equal(tempEntries.filter((name) => name.startsWith("opensquilla-subagent-")).length, 1);
});

test("oversized tasks fail clearly before spawning a process or creating scratch", async () => {
	let calls = 0;
	const { subagent } = createHarness(async () => {
		calls++;
		return { code: 0, killed: false, stdout: payload(), stderr: "" };
	});

	await assert.rejects(
		subagent.execute(
			"call-5",
			{ task: "x".repeat(121 * 1024) },
			undefined,
			undefined,
			context(),
		),
		/task is too large/,
	);
	assert.equal(calls, 0);
	assert.deepEqual(await readdir(testTmpDir), []);
});

test("progress updates expose recent OpenSquilla file activity", async () => {
	const workspace = join(testTmpDir, "workspace");
	const workerDir = join(workspace, ".opensquilla-cache", "fs-worker");
	await mkdir(workspace, { recursive: true });
	const updates: string[] = [];
	const sensitiveValues = ["sk-live-SUPER_SECRET", "*.private.json"];
	const { subagent } = createHarness(async () => {
		await new Promise((resolve) => setTimeout(resolve, 100));
		await mkdir(workerDir, { recursive: true });
		await writeFile(
			join(workerDir, "activity-read.json"),
			JSON.stringify({
				kind: "read_file",
				displayPath: join(workspace, "src", "live.ts"),
				path: join(workspace, "src", "live.ts"),
			}),
			"utf8",
		);
		await writeFile(
			join(workerDir, "activity-search.json"),
			JSON.stringify({
				kind: "glob_search",
				pattern: sensitiveValues[0],
				include: sensitiveValues[1],
				root: join(workspace, "src"),
			}),
			"utf8",
		);
		await new Promise((resolve) => setTimeout(resolve, 800));
		return { code: 0, killed: false, stdout: payload(), stderr: "" };
	});

	const result = await subagent.execute(
		"call-progress",
		{ task: "Inspect live.ts", effort: "fast" },
		undefined,
		(partial: any) => updates.push(partial.content[0]?.text ?? ""),
		context({ cwd: workspace }),
	);
	assert.ok(updates.some((text) => text.includes("OpenSquilla subagent (fast) running")));
	assert.ok(updates.some((text) => text.includes("read src/live.ts")));
	assert.ok(updates.some((text) => text.includes("search in src")));
	assert.deepEqual(result.details.activities, ["read src/live.ts", "search in src"]);
	for (const sensitiveValue of sensitiveValues) {
		assert.ok(updates.every((text) => !text.includes(sensitiveValue)));
		assert.ok(result.details.activities.every((activity: string) => !activity.includes(sensitiveValue)));
	}
});

test("progress updates sanitize include-only glob search activity", async () => {
	const workspace = join(testTmpDir, "workspace");
	const workerDir = join(workspace, ".opensquilla-cache", "fs-worker");
	const sensitiveInclude = "*.private.json";
	await mkdir(workspace, { recursive: true });
	const updates: string[] = [];
	const { subagent } = createHarness(async () => {
		await new Promise((resolve) => setTimeout(resolve, 100));
		await mkdir(workerDir, { recursive: true });
		await writeFile(
			join(workerDir, "activity-search.json"),
			JSON.stringify({
				kind: "glob_search",
				include: sensitiveInclude,
				root: join(workspace, "src"),
			}),
			"utf8",
		);
		await new Promise((resolve) => setTimeout(resolve, 800));
		return { code: 0, killed: false, stdout: payload(), stderr: "" };
	});

	const result = await subagent.execute(
		"call-progress-include-only",
		{ task: "Inspect private JSON files", effort: "fast" },
		undefined,
		(partial: any) => updates.push(partial.content[0]?.text ?? ""),
		context({ cwd: workspace }),
	);
	assert.ok(updates.some((text) => text.includes("search in src")));
	assert.deepEqual(result.details.activities, ["search in src"]);
	assert.ok(updates.every((text) => !text.includes(sensitiveInclude)));
	assert.ok(result.details.activities.every((activity: string) => !activity.includes(sensitiveInclude)));
});

test("profile lock conflicts return a concise actionable error", async () => {
	const { subagent } = createHarness(async () => ({
		code: 1,
		killed: false,
		stdout: "",
		stderr: "Traceback... ProfileLockBusyError: profile is in use by another writer",
	}));

	await assert.rejects(
		subagent.execute("call-lock", { task: "Inspect" }, undefined, undefined, context()),
		/cannot run concurrently; wait for the other run/,
	);
	assert.deepEqual(await readdir(testTmpDir), []);
});

test("malformed OpenSquilla output cleans scratch state", async () => {
	const { subagent } = createHarness(async () => ({
		code: 0,
		killed: false,
		stdout: "not-json",
		stderr: "",
	}));

	await assert.rejects(
		subagent.execute("call-6", { task: "Parse" }, undefined, undefined, context()),
		/returned non-JSON/,
	);
	assert.deepEqual(await readdir(testTmpDir), []);
});
