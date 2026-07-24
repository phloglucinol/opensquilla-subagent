# opensquilla-subagent

Pi extension that delegates a task to an isolated [OpenSquilla](https://github.com/opensquilla/opensquilla) agent with its own **SquillaRouter** model routing.

Each call runs `opensquilla agent --json` as a subprocess. OpenSquilla handles provider auth, tool dispatch, context management, and per-turn model tier routing (c0–c3) internally. Pi receives sanitized live activity plus the final text, usage, and routing metadata.

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
2. **OpenSquilla** `0.5.0rc4` with `recommended` profile (includes SquillaRouter dependencies and V4.2 Phase 3 model assets):

   ```sh
   uv tool install --python 3.12 --force \
     "opensquilla[recommended] @ https://github.com/opensquilla/opensquilla/releases/download/v0.5.0rc4/opensquilla-0.5.0rc4-py3-none-any.whl"
   opensquilla onboard configure router --router recommended
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

While the subprocess is running, Pi receives periodic updates containing elapsed time and up to four recent activities such as `read src/auth.ts`, `list tests`, or `search in src`. Search patterns and queries are not exposed to Pi. This is best-effort metadata from OpenSquilla's fs-worker cache; model reasoning and partial answer text remain private until the turn completes.

- `content` — subagent's final text, truncated to Pi's 50KB / 2000-line tool limits. Full output is saved to `details.outputPath` with owner-only permissions.
- `details.routing` — `{ routed_tier, routed_model, routing_source }` (e.g. `c0` / `deepseek-v4-flash` / `v4_phase3`).
- `details.usage` — raw token accounting from the OpenSquilla turn.
- `details.activities` — recent sanitized file/search activity captured during the run.
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

Returns the final step's text plus `details.steps[]` with each step's routing, effort, activity, and raw usage. The chain reports aggregate usage to Pi. `{previous}` is capped at 12KB/500 lines by default before insertion into the next prompt; it can be raised to 32KB when needed. A timed-out step stops the chain and returns completed-step plus timeout details; other failed steps throw a tool error that includes completed-step routing and output paths.

## Task Sizing

Delegation is adaptive and parent-orchestrated. Broad prompts tend to route to c3 and can spend the full timeout, but a fixed review pipeline also wastes work on already-scoped tasks. Apply this decision order:

1. Handle straightforward questions, small edits, and a few local reads directly in Pi. A subagent is optional, not a required stage.
2. When scope is clear, give one `opensquilla_subagent` call one bounded objective. Name the module, workflow, file set, or risk class; cap the output and require an evidence format such as `file:line`.
3. When relevant entry points, call paths, or key files are unknown, use one `fast` explorer. It should return a concise map and essential files, not perform a complete bug review. Pi then reads those files and decides what to delegate next.
4. When scope is known but several independent concerns matter, select relevant lenses and issue two or three separate focused `opensquilla_subagent` calls. For example, rollback behavior and test coverage may be independent checks; do not hard-code every possible reviewer into every task.
5. Use `opensquilla_chain` only for genuine data dependency, where a later step consumes an earlier result through `{previous}`. Extracting an API/capability matrix and then checking mismatches is a chain; independent correctness, security, or test reviews are separate calls.
6. Let the Pi parent synthesize by default. It reads important source files, deduplicates and prioritizes specialist findings, and communicates the result. Do not add a final `fast` synthesis subagent unless the material is too large or specialized for reliable parent synthesis.

Independent calls may be emitted as sibling tool calls in one Pi response, while chain steps are explicitly data-dependent turns inside one tool call. The extension marks both tools as sequential, so Pi executes sibling calls in order to avoid collisions with OpenSquilla 0.5.0rc4's profile-wide writer lock. Separate Pi processes or projects using the same profile can still conflict; wait for the active run or configure another profile.

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
2. The extension starts a sanitized activity monitor, then spawns `opensquilla agent --json --workspace <cwd> --workspace-strict --scratch-dir <tmp> --permissions <p> --stateless-keep-project-rules --no-memory-capture ...`.
3. The monitor reports elapsed time and newly observed fs-worker operations while OpenSquilla runs its pre-turn pipeline. The `apply_squilla_router` step scores the prompt and picks a tier.
4. The tier's model answers the task using OpenSquilla's own tool surface.
5. OpenSquilla emits a JSON payload (`{ status, text, usage, routing, errors }`).
6. The extension parses it, truncates, persists full output to a temp file, and returns it to Pi.

Routing happens inside OpenSquilla. Pi sees best-effort sanitized activity updates, but not model reasoning, partial answer text, exact tool payloads, or session state. The final text, usage, and routing metadata arrive when the subprocess completes.

## Limits

OpenSquilla 0.5.0rc4 accepts the task only through `--message`, so the extension passes it as one process argument. Tasks are capped at 120KB to stay below common per-argument OS limits. On multi-user systems, process arguments may be visible to other local users; do not put secrets in delegated task text. A future OpenSquilla stdin or message-file option would remove this limitation.

OpenSquilla's sandbox currently maintains `.opensquilla-cache/` worker payloads inside the workspace even in `restricted` mode. This is runtime state rather than an agent-authored project edit, but it should be ignored by version control. The package's own `.gitignore` includes it; add the same rule in consuming repositories when needed.

Live activity is best effort. If another OpenSquilla process writes to the same workspace cache concurrently, activity records cannot be perfectly attributed; the profile lock normally prevents this for one profile.

## License

MIT
