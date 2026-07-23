# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Node test suite for schemas, permission gates, subprocess arguments, usage
  accounting, chain context limits, failure cleanup, and output persistence.
- A 120KB task limit with a clear error for OpenSquilla's single-argument
  `--message` transport.
- Live elapsed-time and sanitized fs-worker activity updates while a subagent
  is running, with recent activity retained in result details.
- `effort` presets (`fast`, `balanced`, `deep`) and optional thinking-level
  overrides for single calls and chain steps.

### Changed

- `permissions` is now genuinely optional in both tool schemas, matching the
  documented `restricted` default; tool and chain objects reject unknown keys.
- Chain `{previous}` insertion defaults to 12KB/500 lines (configurable up to
  32KB), final output reuses the last step's persisted file, and failed steps
  throw proper Pi tool errors.
- OpenSquilla usage is converted to Pi's nested LLM usage format and aggregated
  across chain steps.
- Write-capable permission descriptions now reflect UI confirmation plus
  mandatory `--workspace-lockdown` containment.
- Corrected the documented router mapping to `c2=kimi-k2.7-code` and
  `c3=glm-5.2`, and synchronized skill defaults to `timeout=300` and
  `maxIterations=8`.
- Moved `typebox` from a bundled runtime dependency to a Pi peer dependency.
- Delegation guidance now follows an adaptive, parent-orchestrated policy:
  simple work stays in Pi, scouting is conditional, independent checks use
  separate bounded calls, chains require data dependency, and Pi synthesizes
  results by default.
- Both tools declare sequential execution to respect OpenSquilla's profile-wide
  writer lock; lock conflicts now return a concise actionable error.

### Fixed

- Glob search activity no longer exposes fs-worker `pattern` or `include`
  values in Pi progress updates or result details.
- Failed and malformed OpenSquilla turns now remove their scratch directories.
- Persisted output files are created with owner-only permissions.

## [0.2.1] - 2026-07-23

### Changed

- Tightened defaults to reduce latency and token cost: `timeout` 600→300
  (max 600), `maxIterations` 20→8 (max 15). Schema `maximum` clamps model
  requests; runtime `Math.min` clamps any out-of-range value.
- Updated SKILL.md and README defaults tables.

## [0.2.0] - 2026-07-23

### Added

- `opensquilla_chain` tool: sequential multi-step delegation where each step
  is an independent OpenSquilla turn with its own SquillaRouter routing.
  `{previous}` inlines the prior step's output. Fails fast on step errors.
  Max 10 steps; per-step `permissions`/`timeout`/`maxIterations` overrides.
- Refactored shared turn-execution logic into `runTurn` (shared by
  `opensquilla_subagent` and `opensquilla_chain`).

## [0.1.0] - 2026-07-23

### Added

- Initial release.
- `opensquilla_subagent` tool: delegates a task to an isolated OpenSquilla
  agent running `opensquilla agent --json`.
- Automatic per-turn model routing via OpenSquilla's SquillaRouter V4.2
  Phase 3 classifier (c0–c3).
- Read-only default (`permissions: "restricted"`); `bypass`/`full` gated
  behind TUI confirmation and `--workspace-lockdown`.
- Output truncation (50KB / 2000 lines) with full output persisted to a
  temp file.
- Routing metadata (`routed_tier`, `routed_model`, `routing_source`)
  returned in `details`.
- Bundled `opensquilla-subagent` skill with usage guidance.
