# Adaptive Delegation Guidance Plan

## Status

Proposed documentation and prompt-guidance change. This plan deliberately does
not add a runtime planner, a fixed review pipeline, or a new tool.

## Problem

A broad task such as "deeply review this repository" can route a single
OpenSquilla turn to c3 and exceed its execution budget. A fixed internal
`scout -> review -> synthesis` pipeline would reduce some of those failures,
but it would also impose review-specific stages on tasks that may be narrow,
already scoped, non-review work, or better handled directly by the Pi parent.

Claude Code's official agent and workflow patterns make a useful distinction:

- generic delegation remains a small primitive;
- the parent agent decides whether and how to delegate;
- specialist agents receive one bounded responsibility;
- independent lenses fan out, while data-dependent work is sequenced;
- the parent reads important source files and synthesizes specialist results;
- fixed multi-phase workflows are explicit, domain-specific opt-ins rather than
  hidden behavior inside every generic subagent call.

OpenSquilla 0.5.0rc4 adds one operational constraint: a profile-wide writer
lock prevents concurrent agent processes. Independent calls therefore remain
logically independent but execute sequentially through Pi's existing
`executionMode: "sequential"` behavior.

## Decision

Keep the existing tools as execution primitives:

- `opensquilla_subagent`: one self-contained, bounded objective;
- `opensquilla_chain`: two to four turns only when a later turn consumes an
  earlier turn's output through `{previous}`.

Do not add `strategy: "phased-review"`, an automatic planner turn, or a fixed
synthesis turn. Strengthen the tool descriptions, `promptGuidelines`, skill,
and README so the Pi parent follows an adaptive delegation policy and performs
final synthesis itself.

## Goals

1. Reduce broad single-turn prompts that unnecessarily route to c3.
2. Preserve the parent agent's ability to adapt after each result.
3. Make independent review lenses explicit and bounded.
4. Use chains only for real data dependencies.
5. Avoid an extra OpenSquilla synthesis call when the Pi parent can synthesize.
6. Keep all existing schemas, tool names, defaults, result formats, and runtime
   behavior backward compatible.

## Non-Goals

- No new tool or public parameter.
- No semantic task classifier inside the extension.
- No automatic retry or timeout fallback in this change.
- No parallel OpenSquilla processes on one profile.
- No hard-coded roles that must run for every review.
- No replacement for the Pi parent's own repository reads or engineering
  judgment.

## Adaptive Delegation Policy

The Pi parent should apply this decision order.

### 1. Handle simple work directly

If the task is a straightforward question, a small edit, or can be completed
with a few local reads, the parent should not delegate merely because a
subagent exists.

### 2. Use one subagent for one bounded objective

Use `opensquilla_subagent` when the scope and desired output are already clear.
The task should name a module, workflow, file set, or risk class and include a
bounded output contract.

Example:

```typescript
opensquilla_subagent({
  task: "Inspect src/session.ts for state-restoration bugs. Report at most 3 findings with file:line evidence.",
  effort: "balanced",
  permissions: "restricted"
})
```

### 3. Scout only when the relevant scope is unknown

Use one `fast` explorer call when the parent cannot yet identify the relevant
entry points, ownership boundaries, or files. The explorer returns a concise
map and a short list of essential files. After it returns, the parent should
read those files itself and decide which specialist work, if any, remains.

Example:

```typescript
opensquilla_subagent({
  task: "Map the authentication request path from entry point to persistence. Return at most 15 lines and the 5 most important files to inspect. Do not review for bugs.",
  effort: "fast",
  permissions: "restricted"
})
```

Do not run this scout when the user already supplied the relevant files or the
parent already understands the scope.

### 4. Split broad reviews by orthogonal responsibility

When scope is known but the review has multiple independent concerns, issue
two or three separate bounded `opensquilla_subagent` calls. Typical lenses may
include correctness, state/transaction behavior, security, tests, API
compatibility, or platform-specific behavior. Select only lenses relevant to
the request.

The calls may be emitted as sibling tool calls in one Pi response. Pi will run
them sequentially because the tools declare sequential execution, then return
all results to the parent for synthesis.

Example task boundaries:

```text
Correctness reviewer:
Trace only invalid-target and rollback behavior in the named files. Report at
most 3 high-confidence findings with exact evidence.

Test reviewer:
Compare the changed behavior with existing tests. Report only missing cases
that could allow a concrete regression, at most 3.
```

Independent calls must not pretend to depend on each other and should not use
`{previous}`.

### 5. Use a chain only for genuine data dependency

Use `opensquilla_chain` when a later task cannot be specified until an earlier
result exists. Keep it to two to four meaningful turns and request concise,
structured handoffs.

Appropriate example:

```text
fast: extract the public API and backend capability matrix
balanced: using that matrix, verify only mismatches between API promises and backend support
```

Inappropriate example:

```text
correctness review -> security review -> test review
```

Those are independent lenses and should be separate subagent calls, not a
chain.

### 6. Parent synthesis is the default

The Pi parent should consolidate, deduplicate, prioritize, and communicate
specialist results. It should not launch a final `fast` synthesis subagent by
default. A synthesis turn is justified only when the source material is too
large or domain-specific for the parent to combine reliably, and the reason
should be explicit.

## Prompt Design Rules

Every delegated task should include:

- one objective;
- explicit scope or a request to discover scope;
- an output limit such as finding count or line count;
- required evidence format, usually file and line references;
- exclusions such as "do not edit" or "do not review unrelated modules";
- the intended role without requiring a permanent role enum.

Avoid prompts containing several verbs such as "map, review, redesign, fix,
test, and summarize the entire repository". Split at ownership or reasoning
boundaries instead.

For review tasks, prefer high-confidence findings over exhaustive speculation.
For exploration tasks, request essential files and execution flow rather than
bug findings. For test analysis, require a concrete behavior that the missing
test would fail to protect.

## Required Implementation Changes

### `src/extension/index.ts`

Revise the two tools' descriptions and `promptGuidelines` so they encode the
adaptive policy concisely:

- simple work may not need delegation;
- one subagent equals one bounded objective;
- scout only when scope is unknown;
- independent lenses use separate subagent calls;
- chains require actual output dependency;
- the Pi parent performs final synthesis;
- OpenSquilla calls remain sequential because of the profile lock.

Do not change schemas or execute behavior.

### `skills/opensquilla-subagent/SKILL.md`

Replace the current broad "split into 2-4 calls" advice with the decision order
from this plan. Add short examples for:

- direct/no delegation;
- one bounded subagent;
- optional fast scout;
- independent specialist calls;
- a true dependent chain;
- parent synthesis.

Keep the skill concise enough to remain useful as model context.

### `README.md`

Update Task Sizing/Task Allocation guidance to explain the same policy for
human readers. Clearly distinguish independent sibling calls from chain steps
and state that the parent normally synthesizes results.

### `CHANGELOG.md`

Under `[Unreleased]`, record that delegation guidance now follows an adaptive,
parent-orchestrated policy instead of recommending a fixed review sequence.

### `test/extension.test.ts`

Extend the registered-tool test harness type to expose `description` and
`promptGuidelines` if needed. Add focused assertions that guard the important
contract without matching entire prose blocks:

- subagent guidance contains one bounded objective;
- guidance says scouting is conditional on unknown scope;
- independent checks use separate calls;
- chain guidance requires dependency;
- parent synthesis is the default;
- both tools remain `executionMode: "sequential"`.

Do not create brittle snapshots of complete descriptions.

## Acceptance Criteria

1. No new tool, parameter, schema field, or runtime branch is introduced.
2. Existing tool names and result text remain unchanged.
3. Guidance does not prescribe a mandatory three-stage review.
4. Guidance explicitly allows no delegation for simple work.
5. Guidance distinguishes unknown-scope scouting from known-scope review.
6. Independent review lenses are separate calls; chains are dependency-only.
7. The Pi parent is responsible for final synthesis by default.
8. Profile-lock sequencing remains documented.
9. TypeScript checks, all tests, package dry-run, and `git diff --check` pass.
10. README, skill, tool guidance, and changelog describe the same policy.

## Validation

Run:

```bash
npm run typecheck
npm test
npm run check
npm audit --omit=dev
git diff --check
git status --short --branch
```

No `.tgz` artifact should remain after the dry-run.

## Follow-Up Work

Do not include these in the first implementation:

1. Add structured timeout recovery advice so the parent can choose a split
   after an execution-budget failure.
2. Benchmark representative broad tasks against adaptive specialist calls,
   recording route tier, time, tokens, and completion rate.
3. Consider an explicit domain workflow only if repeated benchmarks show a
   stable sequence with clear value. Such a workflow should be opt-in, skip
   unnecessary stages, enforce budgets, and include a circuit breaker.
4. Revisit parallel execution only when OpenSquilla supports isolated or
   concurrent profiles safely.
