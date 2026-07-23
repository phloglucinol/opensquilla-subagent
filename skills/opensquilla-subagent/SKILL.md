---
name: opensquilla-subagent
description: |
  Delegate a self-contained task to an isolated OpenSquilla agent that runs
  `opensquilla agent` as a subprocess. The subagent has its own context window,
  its own tool surface, and per-turn SquillaRouter model routing (c0 flash /
  c1 pro / c2 glm / c3 kimi-code). Use for isolated investigations, code
  reviews, or synthesis that benefits from an independent context and
  automatic model selection. NOT for simple edits, reading files, or work
  needing shared Pi session state.
---

# OpenSquilla Subagent

This skill is for the parent orchestrator. It delegates work to an external
OpenSquilla process that handles its own provider auth, tool dispatch, and
per-turn model routing. Pi only sees the final text and routing metadata.

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
  task: "Complete, self-contained task description and expected output format",
  permissions: "restricted",   // "restricted" (read-only, default) | "bypass" | "full"
  timeout: 600,                // seconds, default 600
  maxIterations: 20            // default 20
})
```

- `permissions: "restricted"` (default): read-only, safe to run without
  confirmation.
- `permissions: "bypass"` or `"full"`: allow writes; TUI prompts for
  confirmation, non-interactive modes refuse. Writes are contained to the
  workspace/scratch directory via `--workspace-lockdown`.

## Output and Routing Metadata

The tool returns the subagent's final text (truncated to 50KB / 2000 lines;
full output saved to a temp file) plus `details`:

- `details.routing.routed_tier` — c0/c1/c2/c3
- `details.routing.routed_model` — the model OpenSquilla selected
- `details.routing.routing_source` — `v4_phase3` for the real ML classifier
- `details.outputPath` — temp file with the full, untruncated output
- `details.usage` — token accounting from the OpenSquilla turn

Use the routing tier to decide whether a follow-up task should be delegated
again or handled inline.

## Prerequisites

1. OpenSquilla installed (`opensquilla` on `$PATH`): `recommended` profile
   with SquillaRouter V4.2 Phase 3 model assets.
2. A provider API key configured in `~/.opensquilla/config.toml` (the default
   tier mapping targets `tokenrhythm`; override `[squilla_router.tiers]` to
   point at a different provider).
3. Run `opensquilla onboard configure router --router recommended` once.

Verify with `opensquilla doctor` and `opensquilla models probe`.

## Chain Tool

For multi-phase work where each phase deserves its own model tier, use
`opensquilla_chain`. Each step is an independent `opensquilla agent` turn, so
SquillaRouter classifies and routes each step separately (step 1 may use c0,
step 3 may use c3).

```typescript
opensquilla_chain({
  steps: [
    { task: "Scout: list the auth module files and summarize each in one line." },
    { task: "Based on {previous}, review for the highest-risk correctness issue." },
    { task: "Based on {previous}, propose the smallest safe fix. Do not edit." }
  ],
  permissions: "restricted"
})
```

- `{previous}` is replaced with the prior step's output text.
- A failed step stops the chain; `details.failedAt` reports which step.
- `details.steps[].routing` has each step's tier/model/source.
- Max 10 steps. Per-step `permissions`/`timeout`/`maxIterations` override defaults.

## Example

```typescript
opensquilla_subagent({
  task: "Review the current `git diff` for correctness regressions and missing tests. Return findings as a bulleted list with file:line references.",
  permissions: "restricted"
})
```
