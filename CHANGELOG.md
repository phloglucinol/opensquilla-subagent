# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
