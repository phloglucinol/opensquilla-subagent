---
name: opensquilla-subagent
description: |
  Delegate a self-contained task to an isolated OpenSquilla agent that runs
  `opensquilla agent` as a subprocess. The subagent has its own context window,
  its own tool surface, and per-turn SquillaRouter model routing (c0 flash /
  c1 pro / c2 kimi-code / c3 glm-5.2). Use for isolated investigations, code
  reviews, or synthesis that benefits from an independent context and
  automatic model selection. NOT for simple edits, reading files, or work
  needing shared Pi session state.
---

# OpenSquilla Subagent

This skill is for the parent orchestrator. It delegates work to an external
OpenSquilla process that handles its own provider auth, tool dispatch, and
per-turn model routing. Pi receives sanitized live activity plus the final
text, usage, and routing metadata.

## When to Use

- **Isolated investigation**: ask a fresh-context agent to map a codebase area,
  summarize a diff, or research a dependency without polluting the parent
  context window.
- **Independent review**: spawn a reviewer whose model is chosen by OpenSquilla's
  SquillaRouter based on task difficulty (c0–c3), not by the parent.
- **Synthesis offload**: hand off a report, comparison, or analysis that
  benefits from a different model tier and a clean context.
- **Cost-aware delegation**: trivial subtasks route to cheap models
  (deepseek-v4-flash), complex ones route to stronger models automatically.

## When NOT to Use

- Simple edits — use the built-in `edit` tool.
- Reading files — use `read`.
- Work that needs shared session state or continuation of the parent
  conversation — OpenSquilla runs stateless by default.
- Anything requiring Pi's OAuth subscription — OpenSquilla needs its own API
  key configured in `~/.opensquilla/config.toml`.

## Tool Reference

```typescript
opensquilla_subagent({
  task: "One bounded objective with an explicit output limit",
  permissions: "restricted",   // "restricted" (read-only, default) | "bypass" | "full"
  effort: "fast",              // "fast" | "balanced" (default) | "deep"
  timeout: 120,                // optional override, max 600
  maxIterations: 4             // optional override, max 15
})
```

- `permissions: "restricted"` (default): agent tool actions are read-only and
  safe to run without confirmation. OpenSquilla may still maintain ignored
  `.opensquilla-cache/` runtime files in the workspace.
- `permissions: "bypass"` or `"full"`: enable broader OpenSquilla
  capabilities. Pi TUI/RPC modes prompt for confirmation; print/JSON modes
  refuse. Writes remain contained to the workspace/scratch directory via
  `--workspace-lockdown`.
- `effort: "fast"`: 120s, 4 iterations, thinking off, 1 provider retry.
  Use for scouting, extraction, and narrow checks.
- `effort: "balanced"` (default): 300s, 8 iterations.
- `effort: "deep"`: 600s, 12 iterations. Reserve for one tightly scoped
  high-risk question, not a broad repository-wide audit.

## Live Progress

While running, the tool emits elapsed-time heartbeats and up to four recent
sanitized activities such as `read src/auth.ts`, `list tests`, or
`search in src`. Search patterns and queries are not exposed to Pi. These come
from OpenSquilla's fs-worker cache. Pi does not receive model reasoning or
partial answer text.

## Output and Routing Metadata

The tool returns the subagent's final text (truncated to 50KB / 2000 lines;
full output saved to a temp file) plus `details`:

- `details.routing.routed_tier` — c0/c1/c2/c3
- `details.routing.routed_model` — the model OpenSquilla selected
- `details.routing.routing_source` — `v4_phase3` for the real ML classifier
- `details.outputPath` — temp file with the full, untruncated output
- `details.usage` — raw token accounting from the OpenSquilla turn
- `details.activities` — recent sanitized activity captured during the run
- top-level `usage` — Pi-compatible nested LLM usage for session totals

Use the routing tier to decide whether a follow-up task should be delegated
again or handled inline.

## Prerequisites

1. OpenSquilla installed (`opensquilla` on `$PATH`): `recommended` profile
   with SquillaRouter V4.2 Phase 3 model assets.
2. A provider API key configured in `~/.opensquilla/config.toml` (the default
   tier mapping targets `tokenrhythm`; override `[squilla_router.tiers]` to
   point at a different provider).
3. Run `opensquilla onboard configure router --router recommended` once.

Verify provider access with `opensquilla models probe`. `opensquilla doctor`
may report a stopped gateway; single-shot `opensquilla agent` runs do not
require the gateway service.

## Chain Tool

Use `opensquilla_chain` only when later phases depend on earlier output. Each
step is an independent `opensquilla agent` turn, so SquillaRouter classifies
and routes every step separately.

```typescript
opensquilla_chain({
  steps: [
    { task: "Scout the auth entry points; return a concise map.", effort: "fast" },
    { task: "Using {previous}, inspect only the highest-risk path." },
    { task: "Using {previous}, synthesize one recommendation.", effort: "fast" }
  ],
  permissions: "restricted",
  previousMaxBytes: 12288
})
```

- `{previous}` is capped at 12KB/500 lines by default; max override is 32KB.
- A failed step throws a tool error with completed-step routing/output paths.
- `details.steps[]` includes routing, effort, activity, and raw usage.
- Aggregate nested LLM usage is reported to Pi.
- Max 10 steps, but prefer 2-4 meaningful phases to avoid repeated startup cost.
- Per-step `permissions`/`effort`/`thinking`/`previousMaxBytes`/`timeout`/
  `maxIterations` override chain defaults.

## Task Allocation

- Split broad audits into 2-4 independent calls by module or review dimension,
  and execute them sequentially. OpenSquilla holds a profile-wide writer lock.
- Use a chain only for data-dependent phases such as
  `scout (fast) -> focused review (balanced) -> synthesis (fast)`.
- Scope each task to one module, workflow, risk class, or explicit file set,
  and request a bounded output.
- Avoid one prompt asking for a complete repository-wide deep audit unless the
  user explicitly accepts c3 latency.
- Do not request concurrent OpenSquilla calls on the same profile. Both tools
  are marked sequential; another Pi process may still hold the profile lock.

## Example

```typescript
opensquilla_subagent({
  task: "Review the current `git diff` for correctness regressions and missing tests. Return findings as a bulleted list with file:line references.",
  permissions: "restricted"
})
```
