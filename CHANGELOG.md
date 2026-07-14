# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/). Every
workspace package, the Helm chart, and the built image tags move in lockstep
under a single version — this isn't a set of independently published
packages, so there's no per-package versioning here (see `scripts/release.mjs`).

## [Unreleased]

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
