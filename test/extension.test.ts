import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerExtension, {
	_setSpawnFn,
	spawnOpenSquilla,
	type SpawnResult,
} from "../src/extension/index.ts";

interface RegisteredTool {
	name: string;
	description: string;
	promptGuidelines?: string[];
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
	_setSpawnFn(spawnOpenSquilla);
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

interface FakeSpawnResult {
	stdout: string;
	stderrLines?: string[];
	stderr?: string;
	code: number;
	killed?: boolean;
}

interface SpawnOptions {
	cwd: string;
	signal?: AbortSignal;
	timeout?: number;
	onStderrLine?: (line: string) => boolean | void;
}

function createHarness(
	mockSpawn: (
		command: string,
		args: string[],
		options: SpawnOptions,
	) => FakeSpawnResult | Promise<FakeSpawnResult>,
) {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		async exec() {
			throw new Error("should not call pi.exec");
		},
	} as unknown as ExtensionAPI;
	registerExtension(pi);
	_setSpawnFn(async (command, args, options): Promise<SpawnResult> => {
		const mock = await mockSpawn(command, args, options);
		const lines = mock.stderrLines ?? mock.stderr?.split(/\r?\n/).filter(Boolean) ?? [];
		const unhandled: string[] = [];
		for (const line of lines) {
			if (options.onStderrLine?.(line) !== true) unhandled.push(line);
		}
		return {
			stdout: mock.stdout,
			stderr: unhandled.length > 0 ? `${unhandled.join("\n")}\n` : "",
			code: mock.code,
			killed: mock.killed ?? false,
		};
	});
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

test("spawnOpenSquilla streams stderr lines and retains only unhandled stderr", async () => {
	const received: string[] = [];
	const event = JSON.stringify({ _event: true, kind: "thinking" });
	const script = [
		"process.stdout.write('result')",
		`process.stderr.write(${JSON.stringify(event.slice(0, 12))})`,
		`process.stderr.write(${JSON.stringify(`${event.slice(12)}\nplain diagnostic`)})`,
	].join(";");

	const result = await spawnOpenSquilla(process.execPath, ["-e", script], {
		cwd: process.cwd(),
		onStderrLine: (line) => {
			received.push(line);
			return line.startsWith("{");
		},
	});

	assert.equal(result.code, 0);
	assert.equal(result.killed, false);
	assert.equal(result.stdout, "result");
	assert.deepEqual(received, [event, "plain diagnostic"]);
	assert.equal(result.stderr, "plain diagnostic\n");
});

test("spawnOpenSquilla terminates on timeout and AbortSignal", async () => {
	const script = "setInterval(() => {}, 1000)";
	const timedOut = await spawnOpenSquilla(process.execPath, ["-e", script], {
		cwd: process.cwd(),
		timeout: 25,
	});
	assert.equal(timedOut.killed, true);

	const controller = new AbortController();
	const abortedPromise = spawnOpenSquilla(process.execPath, ["-e", script], {
		cwd: process.cwd(),
		signal: controller.signal,
	});
	setTimeout(() => controller.abort(), 25);
	const aborted = await abortedPromise;
	assert.equal(aborted.killed, true);
});

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

test("tool guidance encodes adaptive parent-orchestrated delegation", () => {
	const { subagent, chain } = createHarness(async () => {
		throw new Error("not called");
	});
	const subagentGuidance = subagent.promptGuidelines ?? [];
	const chainGuidance = chain.promptGuidelines ?? [];

	assert.ok(subagentGuidance.some((line) => /one bounded objective/i.test(line)));
	assert.ok(subagentGuidance.some((line) => /fast scout only when .*scope.*unknown/i.test(line)));
	assert.ok(subagentGuidance.some((line) => /separate opensquilla_subagent calls for independent checks/i.test(line)));
	assert.ok(chainGuidance.some((line) => /only when a later step depends on earlier output/i.test(line)));
	assert.ok(
		[...subagentGuidance, ...chainGuidance].some(
			(line) => /Pi parent performs final synthesis by default/i.test(line),
		),
	);
	assert.ok(
		subagentGuidance.some(
			(line) =>
				/sibling calls in one Pi response execute sequentially to avoid profile-lock collisions/i.test(
					line,
				) && /another process using the same profile can still conflict/i.test(line),
		),
	);
	assert.match(subagent.description, /Simple work stays with Pi/i);
	assert.equal(subagent.executionMode, "sequential");
	assert.equal(chain.executionMode, "sequential");
});

test("single delegation applies defaults, persists output, and reports Pi usage", async () => {
	let invocation: { command: string; args: string[]; options?: SpawnOptions } | undefined;
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
	assert.equal(invocation!.args.includes("--event-stream-stderr"), true);
	assert.ok(invocation!.args.indexOf("--event-stream-stderr") < invocation!.args.indexOf("--message"));
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

test("subagent timeout returns structured details without routing metadata", async () => {
	const { subagent } = createHarness(async () => ({
		code: 1,
		killed: false,
		stdout: "",
		stderr: "Agent turn timed out after 300.0s",
	}));

	const result = await subagent.execute(
		"call-timeout-structured",
		{ task: "Inspect timeout behavior" },
		undefined,
		undefined,
		context(),
	);

	assert.equal(result.details.timedOut, true);
	assert.equal(typeof result.details.elapsedSeconds, "number");
	assert.ok(Array.isArray(result.details.activities));
	assert.equal(typeof result.details.scratchPath, "string");
	assert.match(result.content[0].text, /timed out/i);
	assert.match(result.content[0].text, /narrow the scope and retry/i);
	assert.match(result.content[0].text, /synthesize from local reads/i);
	assert.match(result.content[0].text, /or stop/i);
	assert.equal("routing" in result.details, false);
	assert.equal("outputPath" in result.details, false);
	assert.equal(result.usage, undefined);
});

test("subagent timeout preserves its scratch directory", async () => {
	const { subagent } = createHarness(async () => ({
		code: 1,
		killed: false,
		stdout: "",
		stderr: "Agent turn timed out after 300.0s",
	}));

	const result = await subagent.execute(
		"call-timeout-scratch",
		{ task: "Inspect timeout scratch" },
		undefined,
		undefined,
		context(),
	);

	assert.equal((await stat(result.details.scratchPath)).isDirectory(), true);
	const tempEntries = await readdir(testTmpDir);
	assert.deepEqual(
		tempEntries.filter((name) => name.startsWith("opensquilla-subagent-")),
		[result.details.scratchPath.split("/").at(-1)],
	);
});

test("chain stops on a timed-out middle step and returns completed steps", async () => {
	let calls = 0;
	const { chain } = createHarness(async () => {
		calls++;
		if (calls === 1) {
			return { code: 0, killed: false, stdout: payload({ text: "first" }), stderr: "" };
		}
		return {
			code: 1,
			killed: false,
			stdout: "",
			stderr: "Agent turn timed out after 300.0s",
		};
	});

	const result = await chain.execute(
		"chain-timeout",
		{ steps: [{ task: "First" }, { task: "Second with {previous}" }, { task: "Third" }] },
		undefined,
		undefined,
		context(),
	);

	assert.equal(calls, 2);
	assert.equal(result.details.timedOut, true);
	assert.equal(result.details.steps.length, 2);
	assert.equal(result.details.steps[0].status, "ok");
	assert.equal(result.details.steps[1].status, "timed_out");
	assert.equal(result.details.steps[1].timedOut, true);
	assert.ok(Array.isArray(result.details.steps[1].activities));
	assert.match(result.content[0].text, /timed out at step 2\/3/i);
	assert.match(result.content[0].text, /step 1: c1 \/ deepseek-v4-pro \(balanced, v4_phase3\)/);
});

test("non-timeout nonzero exits still throw", async () => {
	const { subagent } = createHarness(async () => ({
		code: 1,
		killed: false,
		stdout: "",
		stderr: "some other error",
	}));

	await assert.rejects(
		subagent.execute(
			"call-non-timeout",
			{ task: "Inspect failure" },
			undefined,
			undefined,
			context(),
		),
		(error: Error) => {
			assert.match(error.message, /some other error/);
			assert.doesNotMatch(error.message, /timed out/i);
			return true;
		},
	);
});

test("subagent timeout does not retry automatically", async () => {
	let calls = 0;
	const { subagent } = createHarness(async () => {
		calls++;
		return {
			code: 1,
			killed: false,
			stdout: "",
			stderr: "Agent turn timed out after 300.0s",
		};
	});

	const result = await subagent.execute(
		"call-timeout-no-retry",
		{ task: "Inspect once" },
		undefined,
		undefined,
		context(),
	);
	assert.equal(result.details.timedOut, true);
	assert.equal(calls, 1);
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

test("event stream reports route, phase, tools, and result activities", async () => {
	const updates: string[] = [];
	const events = [
		JSON.stringify({
			_event: true,
			kind: "router_decision",
			tier: "c3",
			model: "glm-5.2",
		}),
		JSON.stringify({ _event: true, kind: "thinking", text: "private reasoning" }),
		JSON.stringify({ _event: true, kind: "tool_use_start", tool_name: "read_file" }),
		JSON.stringify({ _event: true, kind: "tool_result", tool_name: "read_file" }),
		JSON.stringify({ _event: true, kind: "tool_use_start", tool_name: "glob_search" }),
	];
	const { subagent } = createHarness(async () => ({
		code: 0,
		stdout: payload(),
		stderrLines: events,
	}));

	const result = await subagent.execute(
		"call-progress",
		{ task: "Inspect live.ts", effort: "fast" },
		undefined,
		(partial: any) => updates.push(partial.content[0]?.text ?? ""),
		context(),
	);

	assert.ok(updates.some((text) => text.includes("OpenSquilla subagent (fast) running")));
	assert.ok(updates.some((text) => text.includes("Route: c3 / glm-5.2")));
	assert.ok(updates.some((text) => text.includes("Phase: reasoning")));
	assert.ok(updates.some((text) => text.includes("Phase: tool_calling")));
	assert.ok(updates.some((text) => text.includes("Tools: read_file → glob_search")));
	assert.ok(updates.every((text) => !text.includes("private reasoning")));
	assert.deepEqual(result.details.activities, [
		"routed c3 / glm-5.2",
		"tool read_file",
		"tool glob_search",
	]);
	assert.deepEqual(result.details.routing, {
		routed_tier: "c1",
		routed_model: "deepseek-v4-pro",
		routing_source: "v4_phase3",
	});
});

test("non-event stderr is ignored by progress and retained for failures", async () => {
	const updates: string[] = [];
	const { subagent } = createHarness(async () => ({
		code: 2,
		stdout: "",
		stderrLines: [
			"provider diagnostic text",
			"not-json",
			JSON.stringify({ _event: false, kind: "thinking" }),
			JSON.stringify({ _event: true, kind: "router_decision", tier: "c1", model: "model-a" }),
		],
	}));

	await assert.rejects(
		subagent.execute(
			"call-mixed-stderr",
			{ task: "Inspect failure" },
			undefined,
			(partial: any) => updates.push(partial.content[0]?.text ?? ""),
			context(),
		),
		/provider diagnostic text/,
	);
	assert.ok(updates.some((text) => text.includes("Route: c1 / model-a")));
	assert.ok(updates.every((text) => !text.includes("provider diagnostic text")));
	assert.ok(updates.every((text) => !text.includes("not-json")));
});

test("timeout returns event-stream activities", async () => {
	const { subagent } = createHarness(async () => ({
		code: 1,
		killed: true,
		stdout: "",
		stderrLines: [
			JSON.stringify({ _event: true, kind: "router_decision", tier: "c2", model: "kimi-code" }),
			JSON.stringify({ _event: true, kind: "tool_use_start", tool_name: "read_file" }),
		],
	}));

	const result = await subagent.execute(
		"call-event-timeout",
		{ task: "Inspect timeout" },
		undefined,
		undefined,
		context(),
	);
	assert.equal(result.details.timedOut, true);
	assert.deepEqual(result.details.activities, ["routed c2 / kimi-code", "tool read_file"]);
	assert.match(result.content[0].text, /routed c2 \/ kimi-code, tool read_file/);
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

test("spawn failure (missing binary) is wrapped as 'failed to run opensquilla' with the underlying message", async () => {
	// Exercises the real proc.on('error') -> reject path (post-R1), not an artificial mock throw.
	const { subagent } = createHarness(async (_cmd, _args, options) => {
		return await spawnOpenSquilla("definitely-not-a-real-binary-xyz-123", [], {
			cwd: options.cwd,
			onStderrLine: options.onStderrLine,
		});
	});
	await assert.rejects(
		subagent.execute("call-spawn-err", { task: "Inspect" }, undefined, undefined, context()),
		(error: Error) => {
			assert.match(error.message, /failed to run opensquilla:/);
			assert.match(error.message, /ENOENT|not found/i);
			return true;
		},
	);
	assert.deepEqual(await readdir(testTmpDir), []);
});

test("empty and whitespace-only tasks are rejected before spawning a process", async () => {
	let calls = 0;
	const { subagent } = createHarness(async () => {
		calls++;
		return { code: 0, killed: false, stdout: payload(), stderr: "" };
	});
	for (const task of ["", "   ", "\n\t  "]) {
		await assert.rejects(
			subagent.execute("call-empty", { task }, undefined, undefined, context()),
			/task must not be empty/,
		);
	}
	assert.equal(calls, 0, "spawn must never be called for empty/whitespace tasks");
	assert.deepEqual(await readdir(testTmpDir), []);
});

test("chain applies per-step effort and permissions overrides", async () => {
	const stepArgs: string[][] = [];
	const { chain } = createHarness(async (_command, args) => {
		stepArgs.push([...args]);
		return { code: 0, killed: false, stdout: payload(), stderr: "" };
	});
	await chain.execute(
		"chain-override",
		{
			steps: [
				{ task: "Scout", effort: "fast" },
				{ task: "Deep work", effort: "deep", permissions: "full" },
			],
		},
		undefined,
		undefined,
		context({ hasUI: true, confirm: true }),
	);
	assert.equal(stepArgs.length, 2);
	assert.equal(argValue(stepArgs[0], "--timeout"), "120");
	assert.equal(argValue(stepArgs[0], "--thinking"), "off");
	assert.equal(argValue(stepArgs[1], "--timeout"), "600");
	assert.equal(argValue(stepArgs[1], "--max-iterations"), "12");
	assert.equal(stepArgs[0].includes("--workspace-lockdown"), false);
	assert.equal(stepArgs[1].includes("--workspace-lockdown"), true);
});

test("large multi-line output is truncated with a notice pointing to the full file", async () => {
	const big = "line\n".repeat(3000);
	const { subagent } = createHarness(async () => ({
		code: 0,
		killed: false,
		stdout: payload({ text: big }),
		stderr: "",
	}));
	const result = await subagent.execute(
		"call-trunc",
		{ task: "Inspect" },
		undefined,
		undefined,
		context(),
	);
	const text = result.content[0].text;
	assert.ok(text.length < big.length, "truncated text must be shorter than the original");
	assert.match(text, /Output truncated:/);
	assert.ok(text.includes(result.details.outputPath), "must point to the full output file");
});
