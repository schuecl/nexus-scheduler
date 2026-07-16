# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/). Every
workspace package, the Helm chart, and the built image tags move in lockstep
under a single version — this isn't a set of independently published
packages, so there's no per-package versioning here (see `scripts/release.mjs`).

## [Unreleased]

## [0.1.9] - 2026-07-16

### Added

- The dev Compose stack now runs LiteLLM as the model gateway between
  LibreChat and Ollama: every model call is metered at the gateway
  (per-key spend, hard budgets, RPM/TPM rate limits, admin dashboard
  at `:4000/ui`) — the authoritative usage data LibreChat's Agents API
  doesn't provide (#38, #102). LibreChat authenticates with a
  dedicated, auto-provisioned virtual key rather than the gateway's
  admin master key, so budget/rate ceilings actually bind to its
  traffic. The bundled local models switch from
  `qwen3:0.6b` to a small CPU-friendly set — `gemma3:1b` (default
  chat), `codegemma:2b` (coding), `phi4-mini-reasoning:3.8b`
  (reasoning) — loaded one at a time (`OLLAMA_MAX_LOADED_MODELS=1`).
  Ollama's unauthenticated `:11434` is no longer published to the
  host, every Compose service now carries a memory limit sized for a
  16GB machine, and the worker's `GLOBAL_MAX_CONCURRENT_RUNS` defaults
  to 5 in the dev stack (#102).

### Security

- Hardened the api, worker, pdf-service, and frontend runtime images:
  pruned devDependencies out of the copied `node_modules`, upgraded
  Debian/Alpine base packages at build time, and removed the unused
  bundled npm CLI (a recurring source of CRITICAL/HIGH CVEs unrelated
  to anything these images actually run) from the three Node runtime
  images. All four images now scan clean of fixable CRITICAL/HIGH
  findings, and the Trivy CI scan gates on regressions instead of
  running informationally (#91).

### Fixed

- The `nexus_scheduler_http_request_duration_seconds` metric's `route`
  label used the resolved mount path instead of its pattern for any
  router mounted with a param in its own mount path (`/api/projects/
  :projectId/jobs` and three others), so every project/job ever created
  permanently added a new, never-retired time series. Unmatched (404)
  requests had the same problem via the raw request path. Both now
  label with the bounded pattern / a constant instead (#108).
- Runs can now actually be cancelled. `CANCELLED` has been a reachable
  status in the schema for a while, and everything downstream already
  handled it (terminal-state guards, `notifyOnCancelled` on webhook
  destinations), but nothing ever set it and no endpoint accepted a
  cancel request — an operator could enable "notify me on cancellation"
  and it would silently never fire. Adds `POST /api/runs/:id/cancel`
  and a Cancel button in Run History: a still-queued run is stopped
  before it ever reaches the agent, an in-flight one has its LibreChat
  request aborted immediately rather than left to run to completion or
  time out, and either way the same webhook/email delivery a completed
  or failed run gets now fires for it too (#111).

## [0.1.7] - 2026-07-14

### Added

- The Helm chart is now packaged and published as an OCI artifact
  (`ghcr.io/<owner>/charts/nexus-scheduler`) on every release, with the
  `.tgz` attached to the GitHub Release too (#82).
- Contextual empty-state guidance and prerequisite hints across the
  Prompts, Jobs, Schedules, Runs, and API Keys create/list flows,
  including disabled-button tooltips naming the specific missing
  prerequisite (#83).
- Prompt version history is now viewable, comparable, and restorable:
  expand any past version to see its content, compare two versions
  with a line-level content diff and a variables diff, or restore an
  old version as a new one (#85).

### Fixed

- The release workflow's `helm package` step now derives the chart's
  version from the release tag instead of trusting `Chart.yaml`'s
  committed state, fixing a failure mode where a tag pushed without
  running `scripts/release.mjs` first packaged the chart under the
  wrong version and broke the publish step (#86).

## [0.1.5] - 2026-07-14

### Added

- Versioning and release tooling: `scripts/release.mjs` (`npm run
  release`) for lockstep version bumps across every workspace, the Helm
  chart, and image tags, plus `.github/workflows/release.yml` to build
  and publish images and cut a GitHub Release on tag push.

## [0.1.0] - 2026-07-14

### Added

- Initial tracked baseline. Versioning and releases (this file,
  `scripts/release.mjs`, `.github/workflows/release.yml`) started here;
  everything before this point is untagged history.

[Unreleased]: https://github.com/schuecl/nexus-scheduler/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/schuecl/nexus-scheduler/releases/tag/v0.1.0
