#!/usr/bin/env node
// Cuts a release: bumps the lockstep version across every workspace
// package.json plus the Helm chart (Chart.yaml/values.yaml), rolls the
// CHANGELOG's [Unreleased] section into a dated version heading, syncs
// package-lock.json, and creates a commit + annotated tag. Doesn't push
// anything — pushing the tag is what triggers release.yml to build and
// publish images, so that step is left to the operator to review and
// run deliberately.
//
// Usage: node scripts/release.mjs <patch|minor|major|X.Y.Z> [--dry-run] [--allow-empty-changelog]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const bumpArg = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
const allowEmptyChangelog = args.includes("--allow-empty-changelog");

if (!bumpArg) {
  console.error("Usage: node scripts/release.mjs <patch|minor|major|X.Y.Z> [--dry-run] [--allow-empty-changelog]");
  process.exit(1);
}

function sh(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { cwd: repoRoot, encoding: "utf-8", ...opts });
}

function assertCleanWorktree() {
  const status = sh("git", ["status", "--porcelain"]);
  if (status.trim() !== "") {
    console.error("Working tree isn't clean. Commit or stash pending changes before releasing.");
    process.exit(1);
  }
}

function bumpVersion(current, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) throw new Error(`Root package.json version "${current}" isn't a plain X.Y.Z semver.`);
  const maj = Number(match[1]);
  const min = Number(match[2]);
  const pat = Number(match[3]);
  if (bump === "major") return `${maj + 1}.0.0`;
  if (bump === "minor") return `${maj}.${min + 1}.0`;
  if (bump === "patch") return `${maj}.${min}.${pat + 1}`;
  throw new Error(`Unrecognized bump "${bump}" — use patch, minor, major, or an explicit X.Y.Z.`);
}

const WORKSPACE_PACKAGE_JSONS = [
  "package.json",
  "packages/shared/package.json",
  "packages/pdf/package.json",
  "packages/pdf-service/package.json",
  "packages/api/package.json",
  "packages/worker/package.json",
  "packages/frontend/package.json",
];

function updatePackageJson(relPath, newVersion) {
  const abs = path.join(repoRoot, relPath);
  const raw = readFileSync(abs, "utf-8");
  const updated = raw.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${newVersion}$2`);
  if (updated === raw) throw new Error(`Didn't find a "version" field to update in ${relPath}`);
  if (!dryRun) writeFileSync(abs, updated);
  return abs;
}

function updateChartYaml(newVersion) {
  const relPath = "helm/nexus-scheduler/Chart.yaml";
  const abs = path.join(repoRoot, relPath);
  const raw = readFileSync(abs, "utf-8");
  // Anchored at column 0 so this only touches the chart's own top-level
  // version/appVersion, not the vendored subcharts' pinned `version:
  // "0.1.0"` lines under dependencies (those track the subchart's own
  // release, unrelated to this app's version).
  let updated = raw.replace(/^version: .*$/m, `version: ${newVersion}`);
  updated = updated.replace(/^appVersion: .*$/m, `appVersion: "${newVersion}"`);
  if (!dryRun) writeFileSync(abs, updated);
  return abs;
}

function updateValuesYaml(currentVersion, newVersion) {
  const relPath = "helm/nexus-scheduler/values.yaml";
  const abs = path.join(repoRoot, relPath);
  const raw = readFileSync(abs, "utf-8");
  const needle = `tag: "${currentVersion}"`;
  const replacement = `tag: "${newVersion}"`;
  if (!raw.includes(needle)) throw new Error(`Didn't find ${JSON.stringify(needle)} in ${relPath}`);
  const updated = raw.replace(needle, replacement);
  if (!dryRun) writeFileSync(abs, updated);
  return abs;
}

function updateChangelog(newVersion) {
  const relPath = "CHANGELOG.md";
  const abs = path.join(repoRoot, relPath);
  const raw = readFileSync(abs, "utf-8");
  const lines = raw.split("\n");
  const unreleasedIdx = lines.findIndex((l) => l.trim() === "## [Unreleased]");
  if (unreleasedIdx === -1) throw new Error(`CHANGELOG.md has no "## [Unreleased]" heading.`);
  let nextHeadingIdx = lines.findIndex((l, i) => i > unreleasedIdx && /^## \[/.test(l));
  if (nextHeadingIdx === -1) nextHeadingIdx = lines.length;
  const body = lines.slice(unreleasedIdx + 1, nextHeadingIdx);
  const bodyHasContent = body.some((l) => l.trim() !== "");
  if (!bodyHasContent && !allowEmptyChangelog) {
    throw new Error(
      "CHANGELOG.md's [Unreleased] section is empty. Add entries first, or pass --allow-empty-changelog.",
    );
  }
  const today = new Date().toISOString().slice(0, 10);
  const newSectionHeading = `## [${newVersion}] - ${today}`;
  const rebuilt = [
    ...lines.slice(0, unreleasedIdx),
    "## [Unreleased]",
    "",
    newSectionHeading,
    ...body,
    ...lines.slice(nextHeadingIdx),
  ].join("\n");
  if (!dryRun) writeFileSync(abs, rebuilt);
  return abs;
}

const rootPkgPath = path.join(repoRoot, "package.json");
const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf-8"));
const currentVersion = rootPkg.version;
const newVersion = bumpVersion(currentVersion, bumpArg);

console.log(`Releasing ${currentVersion} -> ${newVersion}${dryRun ? " (dry run)" : ""}`);

assertCleanWorktree();

const changedFiles = [];
for (const rel of WORKSPACE_PACKAGE_JSONS) {
  updatePackageJson(rel, newVersion);
  changedFiles.push(rel);
}
updateChartYaml(newVersion);
changedFiles.push("helm/nexus-scheduler/Chart.yaml");
updateValuesYaml(currentVersion, newVersion);
changedFiles.push("helm/nexus-scheduler/values.yaml");
updateChangelog(newVersion);
changedFiles.push("CHANGELOG.md");

if (dryRun) {
  console.log("Dry run — no files written, no lockfile sync, no commit/tag. Files that would change:");
  for (const f of changedFiles) console.log(`  ${f}`);
  process.exit(0);
}

console.log("Syncing package-lock.json...");
sh("npm", ["install", "--package-lock-only", "--ignore-scripts"]);
if (existsSync(path.join(repoRoot, "package-lock.json"))) changedFiles.push("package-lock.json");

sh("git", ["add", ...changedFiles]);
sh("git", ["commit", "-m", `chore(release): v${newVersion}`]);
sh("git", ["tag", "-a", `v${newVersion}`, "-m", `v${newVersion}`]);

console.log(`\nCommitted and tagged v${newVersion} locally. Review with:`);
console.log(`  git show HEAD`);
console.log(`Then push deliberately when ready (pushing the tag triggers the release workflow):`);
console.log(`  git push origin HEAD --follow-tags`);
