# opensquilla-subagent

Pi extension that delegates a task to an isolated [OpenSquilla](https://github.com/opensquilla/opensquilla) agent with its own **SquillaRouter** model routing.

Each call runs `opensquilla agent --json` as a subprocess. OpenSquilla handles provider auth, tool dispatch, context management, and per-turn model tier routing (c0–c3) internally. Pi only sees the final text plus routing metadata.

```
Pi → opensquilla_subagent tool → opensquilla agent --json
    → SquillaRouter classifies (c0/c1/c2/c3) → routes model → returns text + routing
```

## Why

- **Independent context window** — the subagent does not consume the parent's context budget; good for long investigations or reviews.
- **Automatic model selection** — OpenSquilla's SquillaRouter V4.2 Phase 3 classifier picks the cheapest model that can handle the task (flash for trivial, pro/glm/kimi-code for complex).
- **Routing transparency** — every result includes `routed_tier`, `routed_model`, and `routing_source`, so you can see what happened.
- **Safe defaults** — read-only by default (`permissions: "restricted"`); write modes are gated behind TUI confirmation and workspace containment.

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

   Then point `[llm]` and `[squilla_router.tiers]` in `~/.opensquilla/config.toml` at that provider. Verify with `opensquilla models probe`.

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
  task: "Review the current git diff for correctness regressions and missing tests. Return findings with file:line references.",
  permissions: "restricted",   // "restricted" (default, read-only) | "bypass" | "full"
  timeout: 300,                // seconds (max 600)
  maxIterations: 8             // max 15
})
```

You can also ask in plain language:

> Use opensquilla_subagent to review the current diff for regressions.

### Parameters

| Parameter | Default | Description |
|---|---|---|
| `task` | (required) | Complete, self-contained task description |
| `permissions` | `"restricted"` | `restricted` (read-only), `bypass` (workspace-contained writes), `full` (unrestricted). `bypass`/`full` prompt in TUI; non-interactive modes refuse. |
| `timeout` | `300` | Total subagent wall-clock seconds (max 600) |
| `maxIterations` | `8` | Max model/tool loop iterations (max 15) |

### Result

- `content` — subagent's final text, truncated to 50KB / 2000 lines. Full output saved to `details.outputPath`.
- `details.routing` — `{ routed_tier, routed_model, routing_source }` (e.g. `c0` / `deepseek-v4-flash` / `v4_phase3`).
- `details.usage` — token accounting from the OpenSquilla turn.

### Chain mode

For multi-phase work where each phase deserves its own model tier, run a chain. Each step is an independent OpenSquilla turn with its own routing; `{previous}` inlines the prior step's output.

```typescript
opensquilla_chain({
  steps: [
    { task: "List the main types and entry points of the auth module." },
    { task: "Based on {previous}, review for the highest-risk regression." },
    { task: "Based on {previous}, propose the smallest safe fix. Do not edit files." }
  ],
  permissions: "restricted",   // chain-level default; per-step override allowed
  timeout: 300,                // chain-level default (max 600)
  maxIterations: 8             // chain-level default (max 15)
})
```

Returns the final step's text plus `details.steps[]` with each step's routing. A failed step stops the chain with `details.failedAt`.

## Configuration

OpenSquilla's router tier mapping lives in `~/.opensquilla/config.toml` under `[squilla_router.tiers]`. The default mapping targets TokenRhythm:

| Tier | Model | Use case |
|---|---|---|
| c0 | deepseek-v4-flash | trivial chat, extraction, short rewrites |
| c1 | deepseek-v4-pro | default coding, debugging, moderate analysis |
| c2 | glm-5.2 | multi-step coding, structured reasoning |
| c3 | kimi-k2.7-code | architecture, deep review, high-stakes synthesis |
| image | kimi-k2.6 | vision/image input |

To use a different provider (OpenRouter, OpenAI, Anthropic, …), set `[llm]` and each tier's `provider`/`model` accordingly. See `opensquilla config get squilla_router`.

## How It Works

1. Pi calls `opensquilla_subagent({ task, ... })`.
2. The extension spawns `opensquilla agent --json --workspace <cwd> --workspace-strict --scratch-dir <tmp> --permissions <p> --stateless-keep-project-rules --no-memory-capture ...`.
3. OpenSquilla runs its pre-turn pipeline, which includes the `apply_squilla_router` step: the V4.2 Phase 3 classifier (LightGBM + ONNX MLP + BGE embeddings) scores the prompt and picks a tier.
4. The tier's model answers the task using OpenSquilla's own tool surface.
5. OpenSquilla emits a JSON payload (`{ status, text, usage, routing, errors }`).
6. The extension parses it, truncates, persists full output to a temp file, and returns it to Pi.

Routing happens inside OpenSquilla — Pi does not see intermediate tool calls, session state, or the model's streaming output. Only the final text and routing metadata cross the process boundary.

## License

MIT
