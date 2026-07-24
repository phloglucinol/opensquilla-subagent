# opensquilla-subagent

Pi extension that delegates a task to an isolated [OpenSquilla](https://github.com/opensquilla/opensquilla) agent with its own **SquillaRouter** model routing.

Each call runs `opensquilla agent --json --event-stream-stderr` as a subprocess. OpenSquilla handles provider auth, tool dispatch, context management, and per-turn model tier routing (c0–c3) internally. Pi receives sanitized live event status plus the final text, usage, and routing metadata.

```
Pi → opensquilla_subagent tool → opensquilla agent --json
    → SquillaRouter classifies (c0/c1/c2/c3) → routes model → returns text + routing
```

## Why

- **Independent context window** — the subagent does not consume the parent's context budget; good for long investigations or reviews.
- **Automatic model selection** — OpenSquilla's SquillaRouter V4.2 Phase 3 classifier picks the cheapest model that can handle the task (flash for trivial, pro/glm/kimi-code for complex).
- **Routing transparency** — every result includes `routed_tier`, `routed_model`, and `routing_source`, so you can see what happened.
- **Safe defaults** — agent actions are read-only by default (`permissions: "restricted"`); broader write-capable modes require Pi UI confirmation and are still contained by OpenSquilla's `--workspace-lockdown`.

## Prerequisites

1. **Pi** `>= 0.81` — `npm install -g @earendil-works/pi-coding-agent`
2. **OpenSquilla** with `--event-stream-stderr` support and the `recommended` profile (including SquillaRouter dependencies and V4.2 Phase 3 model assets). Install a compatible OpenSquilla build, configure the router, and verify the event-stream option:

   ```sh
   opensquilla onboard configure router --router recommended
   opensquilla agent --help 2>&1 | grep event-stream-stderr
   ```

3. **A provider API key** for OpenSquilla (it does not share Pi's OAuth subscription). For example, TokenRhythm:

   ```sh
   mkdir -p ~/.opensquilla && umask 077
   printf 'TOKENRHYTHM_API_KEY=%s\n' 'your-key' >> ~/.opensquilla/.env
   ```

   Then point `[llm]` and `[squilla_router.tiers]` in `~/.opensquilla/config.toml` at that provider. Verify with `opensquilla models probe`. `opensquilla doctor` may still report a stopped gateway; single-shot `opensquilla agent` runs do not require the gateway service.

## Install

From a local checkout:

```sh
pi install .
```

From git (once published):

```sh
pi install git:github.com/phloglucinol/opensquilla-subagent
```

Or load it ad-hoc for testing:

```sh
pi -e ./index.ts
```

## Usage

In a Pi session, the `opensquilla_subagent` tool is available to the model:

```typescript
opensquilla_subagent({
  task: "Review one module for correctness regressions. Return at most five findings with file:line references.",
  permissions: "restricted",   // "restricted" (default, read-only) | "bypass" | "full"
  effort: "fast",              // "fast" | "balanced" (default) | "deep"
  timeout: 120,                // optional explicit override (max 600)
  maxIterations: 4             // optional explicit override (max 15)
})
```

You can also ask in plain language:

> Use opensquilla_subagent to review the current diff for regressions.

### Parameters

| Parameter | Default | Description |
|---|---|---|
| `task` | (required) | Complete, self-contained task description |
| `permissions` | `"restricted"` | `restricted` makes agent tool actions read-only. `bypass`/`full` enable broader OpenSquilla capabilities, require confirmation in Pi TUI/RPC modes, and remain write-contained to the workspace/scratch directory by `--workspace-lockdown`. Print/JSON modes refuse them. |
| `effort` | `"balanced"` | `fast`: 120s, 4 iterations, thinking off, 1 provider retry. `balanced`: 300s, 8 iterations. `deep`: 600s, 12 iterations. |
| `thinking` | preset/router default | Optional OpenSquilla thinking override: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `adaptive`. |
| `timeout` | effort preset | Total subagent wall-clock seconds (max 600) |
| `maxIterations` | effort preset | Max model/tool loop iterations (max 15) |

### Progress And Result

While the subprocess is running, Pi reads OpenSquilla's JSONL event stream from stderr and reports elapsed time, the selected route, the current phase, and up to four recent tool calls. Completed calls are matched by `tool_use_id` and marked in place, for example: `Route: c3 / glm-5.2`, `Phase: reasoning`, and `Tools: read_file ✓ → glob_search`. Thinking text, partial answer text, tool arguments, and tool results are not forwarded.

- `content` — subagent's final text, truncated to Pi's 50KB / 2000-line tool limits. Full output is saved to `details.outputPath` with owner-only permissions.
- `details.routing` — `{ routed_tier, routed_model, routing_source }` (e.g. `c0` / `deepseek-v4-flash` / `v4_phase3`).
- `details.usage` — raw token accounting from the OpenSquilla turn.
- `details.activities` — recent sanitized routing and tool activity derived from the event stream.
- top-level `usage` — the same usage converted to Pi's accounting format, so nested model cost appears in session totals.

If a subagent times out, the tool returns a structured result with `details.timedOut`, elapsed time, recent activities, and the scratch path, rather than throwing. The parent can narrow scope, synthesize from local reads, or stop. The extension never auto-retries a timed-out prompt.

### Chain mode

Use a chain only when a later step cannot be specified without an earlier result. Each step is an independent OpenSquilla turn with its own routing; `{previous}` inlines a bounded prior-step handoff.

```typescript
opensquilla_chain({
  steps: [
    { task: "Extract the public API and backend capability matrix in at most 20 lines.", effort: "fast" },
    { task: "Using {previous}, report only API promises unsupported by the backend, with file:line evidence." }
  ],
  permissions: "restricted",   // chain-level default; per-step override allowed
  effort: "balanced",
  previousMaxBytes: 12288       // default handoff cap; per-step override allowed, max 32768
})
```

Returns the final step's text plus `details.steps[]` with each newly executed step's routing, effort, activity, and raw usage. The chain reports aggregate usage to Pi. `{previous}` is capped at 12KB/500 lines by default before insertion into the next prompt; it can be raised to 32KB when needed. A timed-out step stops the chain and returns completed-step details plus a machine-usable `details.resume` checkpoint; other failed steps throw a tool error that includes completed-step routing and output paths.

Resume a timed-out chain by passing the original `steps` and the returned checkpoint:

```typescript
opensquilla_chain({
  steps: originalSteps,
  resume: {
    fromStep: 2,
    previousOutputPath: "/tmp/opensquilla-subagent-.../result.txt"
  }
})
```

`fromStep` is 1-based, so a first-step timeout resumes with `{ fromStep: 1 }`. Earlier steps are not rerun. `previousOutputPath` must be absolute and is required only when the resumed step contains `{previous}`; use the path returned in `details.resume`, not hidden session state. Resumed calls report usage only for the steps executed by that call and expose `details.resumedFromStep`.

## Task Sizing

Delegation is adaptive and parent-orchestrated. Broad prompts tend to route to c3 and can spend the full timeout, but a fixed review pipeline also wastes work on already-scoped tasks. Apply this decision order:

1. Use Pi's built-in tools by default for one trivial operation. A simple bounded read-only task may still use `opensquilla_subagent` when the user explicitly requests OpenSquilla, sibling tasks can run in parallel, or delegation avoids filling the parent context with intermediate file or command output. Use `effort="fast"`, `permissions="restricted"`, and a strict output limit for these calls. Keep small edits and work that depends on shared Pi session state in the parent.
2. When scope is clear, give one `opensquilla_subagent` call one bounded objective. Name the module, workflow, file set, or risk class; cap the output and require an evidence format such as `file:line`.
3. When relevant entry points, call paths, or key files are unknown, use one `fast` explorer. It should return a concise map and essential files, not perform a complete bug review. Pi then reads those files and decides what to delegate next.
4. When scope is known but several independent concerns matter, select relevant lenses and issue two or three separate focused `opensquilla_subagent` calls. For example, rollback behavior and test coverage may be independent checks; do not hard-code every possible reviewer into every task.
5. Use `opensquilla_chain` only for genuine data dependency, where a later step consumes an earlier result through `{previous}`. Extracting an API/capability matrix and then checking mismatches is a chain; independent correctness, security, or test reviews are separate calls.
6. Let the Pi parent synthesize by default. It reads important source files, deduplicates and prioritizes specialist findings, and communicates the result. Do not add a final `fast` synthesis subagent unless the material is too large or specialized for reliable parent synthesis.

Independent calls may be emitted as sibling tool calls in one Pi response, while chain steps are explicitly data-dependent turns inside one tool call. Each call spins up an isolated OpenSquilla profile (a fresh `OPENSQUILLA_STATE_DIR` temp directory created per call and removed afterwards, including on timeout), so sibling calls in one Pi response run concurrently without profile-lock collisions. The profile directory is `0700`; copied config, dotenv, and ownership marker files are `0600`. Normal process exit performs synchronous cleanup. Because SIGKILL cannot run any Node hook, the next extension load conservatively removes only profile directories whose marker or new PID-bearing name proves that the owner is no longer alive; active directories and unrecognized legacy directories are left untouched. Chain steps remain sequential because each step consumes the prior step's output through `{previous}` — that is chain semantics, not a profile-lock limitation.

Keep chains to two to four meaningful steps with concise handoffs. Very small steps are inefficient because each repeats OpenSquilla startup and routing.

## Configuration

OpenSquilla's router tier mapping lives in `~/.opensquilla/config.toml` under `[squilla_router.tiers]`. The default mapping targets TokenRhythm:

| Tier | Model | Use case |
|---|---|---|
| c0 | deepseek-v4-flash | trivial chat, extraction, short rewrites |
| c1 | deepseek-v4-pro | default coding, debugging, moderate analysis |
| c2 | kimi-k2.7-code | multi-step coding, structured reasoning |
| c3 | glm-5.2 | architecture, deep review, high-stakes synthesis |
| image | kimi-k2.6 | vision/image input |

To use a different provider (OpenRouter, OpenAI, Anthropic, …), set `[llm]` and each tier's `provider`/`model` accordingly. See `opensquilla config get squilla_router`.

## How It Works

1. Pi calls `opensquilla_subagent({ task, ... })`.
2. The extension spawns `opensquilla agent --json --event-stream-stderr --workspace <cwd> --workspace-strict --scratch-dir <tmp> --permissions <p> --stateless-keep-project-rules --no-memory-capture ...`.
3. The extension parses JSONL events from stderr and reports elapsed time, route, phase, and recent tool names while OpenSquilla runs. The `apply_squilla_router` step scores the prompt and picks a tier.
4. The tier's model answers the task using OpenSquilla's own tool surface.
5. OpenSquilla emits a JSON payload (`{ status, text, usage, routing, errors }`).
6. The extension parses it, truncates, persists full output to a temp file, and returns it to Pi.

Routing happens inside OpenSquilla. Pi sees event-derived status, but not model reasoning text, partial answer text, exact tool payloads, or session state. The final text, usage, and routing metadata arrive when the subprocess completes.

## Limits

OpenSquilla 0.5.0rc4 accepts the task only through `--message`, so the extension passes it as one process argument. Tasks are capped at 120KB to stay below common per-argument OS limits. On multi-user systems, process arguments may be visible to other local users; do not put secrets in delegated task text. A future OpenSquilla stdin or message-file option would remove this limitation.

OpenSquilla's sandbox currently maintains `.opensquilla-cache/` worker payloads inside the workspace even in `restricted` mode. This is runtime state rather than an agent-authored project edit, but it should be ignored by version control. The package's own `.gitignore` includes it; add the same rule in consuming repositories when needed.

Live status depends on OpenSquilla emitting `--event-stream-stderr` events. Heartbeats continue when no new event arrives, and a reasoning phase reports how long it has been idle. If OpenSquilla returns a failed JSON payload, the error includes a reminder to verify the source profile's `~/.opensquilla/config.toml` and `~/.opensquilla/.env` provider configuration.

## License

MIT
