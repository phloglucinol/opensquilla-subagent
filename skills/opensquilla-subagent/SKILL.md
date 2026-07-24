---
name: opensquilla-subagent
description: |
  Delegate a self-contained task to an isolated OpenSquilla agent that runs
  `opensquilla agent` as a subprocess. The subagent has its own context window,
  its own tool surface, and per-turn SquillaRouter model routing (c0 flash /
  c1 pro / c2 kimi-code / c3 glm-5.2). Use for isolated investigations, code
  reviews, or synthesis that benefits from an independent context and
  automatic model selection. NOT for simple edits, reading files, or work
  needing shared Pi session state. Delegate adaptively: one bounded objective
  per call, chains only for genuine dependencies, and parent synthesis by
  default.
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
- **Specialist analysis**: hand off one bounded report, comparison, or risk
  analysis that benefits from a different model tier and a clean context.
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

While running, the tool parses OpenSquilla's stderr JSONL event stream and
emits elapsed-time heartbeats, the selected route, the current phase, and up
to four recent tool names. Thinking text, partial answer text, tool arguments,
and tool results are not forwarded to Pi.

## Output and Routing Metadata

The tool returns the subagent's final text (truncated to 50KB / 2000 lines;
full output saved to a temp file) plus `details`:

- `details.routing.routed_tier` — c0/c1/c2/c3
- `details.routing.routed_model` — the model OpenSquilla selected
- `details.routing.routing_source` — `v4_phase3` for the real ML classifier
- `details.outputPath` — temp file with the full, untruncated output
- `details.usage` — raw token accounting from the OpenSquilla turn
- `details.activities` — recent sanitized route and tool activity from the event stream
- `details.timedOut` — `true` when a timeout returns elapsed time, recent
  activities, and `details.scratchPath` instead of throwing; the parent can
  narrow scope, synthesize locally, or stop, and the extension does not retry
  the prompt automatically
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

Use `opensquilla_chain` only when a later step cannot be specified without an
earlier result. Each step is an independent `opensquilla agent` turn, so
SquillaRouter classifies and routes every step separately.

```typescript
opensquilla_chain({
  steps: [
    { task: "Extract the public API and backend capability matrix in at most 20 lines.", effort: "fast" },
    { task: "Using {previous}, report only API promises unsupported by the backend, with file:line evidence." }
  ],
  permissions: "restricted",
  previousMaxBytes: 12288
})
```

- `{previous}` is capped at 12KB/500 lines by default; max override is 32KB.
- A timed-out step stops the chain and returns completed-step plus timeout
  details; other failed steps throw a tool error with completed-step
  routing/output paths.
- `details.steps[]` includes routing, effort, activity, and raw usage.
- Aggregate nested LLM usage is reported to Pi.
- Max 10 steps, but prefer 2-4 meaningful phases to avoid repeated startup cost.
- Per-step `permissions`/`effort`/`thinking`/`previousMaxBytes`/`timeout`/
  `maxIterations` override chain defaults.

## Adaptive Delegation

Apply this decision order:

1. **Do not delegate simple work.** Answer straightforward questions, make
   small edits, and perform a few local reads directly in Pi.
2. **Use one focused subagent when scope is clear.** Give it one bounded
   objective, explicit scope, an output limit, and an evidence format.
3. **Scout only when scope is unknown.** One `fast` explorer may identify entry
   points, call paths, and essential files, but should not perform the full bug
   review. Pi then reads those files and decides whether specialists are needed.
4. **Use separate calls for independent checks.** When scope is known, select
   relevant lenses and issue two or three focused `opensquilla_subagent` calls.
   They may be sibling tool calls; each call uses an isolated OpenSquilla
   profile, so sibling calls execute concurrently. Chain steps remain
   sequential because each step consumes the prior step's output through
   `{previous}` — that is chain semantics, not a profile-lock limitation.
5. **Use a chain only for genuine dependency.** A later step must consume an
   earlier result; independent reviewers do not belong in a chain.
6. **Synthesize in the parent.** Pi deduplicates and prioritizes results by
   default. Do not add a `fast` synthesis subagent unless offloading is
   explicitly justified.

Keep reviewer tasks concrete: name the scope, cap the findings, require
`file:line` evidence, and exclude unrelated modules.

## Examples

No delegation: read two named files and make a small local edit with Pi's
built-in tools.

One focused subagent:

```typescript
opensquilla_subagent({
  task: "Inspect src/session.ts for state-restoration bugs. Report at most 3 findings with file:line evidence.",
  permissions: "restricted"
})
```

Optional fast scout when the relevant scope is unknown:

```typescript
opensquilla_subagent({
  task: "Map the auth request path and list at most 5 essential files. Do not review for bugs.",
  effort: "fast",
  permissions: "restricted"
})
```

Independent specialists: issue separate bounded calls for only the relevant
lenses, such as rollback behavior and concrete missing regression tests. Do not
pass one result into the other.

Dependent chain: first extract an API/capability matrix, then use `{previous}`
to verify mismatches that cannot be scoped before the matrix exists.

Parent synthesis: after reading specialist results and key source files, Pi
deduplicates findings, orders them by severity, and writes the final response.
