#!/usr/bin/env node
// Guard against reintroducing GitHub Actions that target the deprecated
// Node.js 20 runtime.
//
// GitHub deprecated the node20 runtime on Actions runners on 2025-09-19:
// actions whose action.yml declares `runs.using: node20` are forced to run
// on node24 and emit a deprecation warning on every run. The fix is to pin
// a major version whose action.yml declares node24.
//
// The floors below are the lowest majors that declare node24, verified
// against each action's action.yml and release notes:
//
//   actions/checkout          v5  (v5.0.0: node24 migration only)
//   actions/setup-node        v5  (v5.0.0: node24 migration; the only
//                                  "breaking" change — automatic caching
//                                  when package.json has a packageManager
//                                  field — does not apply to this repo)
//   actions/upload-artifact   v6  (v6.0.0: node24 migration. Note v5 still
//                                  declares node20 — do not stop at v5)
//   actions/download-artifact v7  (v7.0.0: node24 migration. Note v5 and
//                                  v6 still declare node20)
//
// Runners must be >= v2.327.1 for these majors (GitHub-hosted runners are).
//
// Maintenance: when a new actions/* action is added to a workflow, add its
// floor here in the same change. When GitHub deprecates node24 in turn,
// raise every floor after verifying the new majors. Actions pinned by full
// commit SHA (deliberate immutable pins, e.g. openai/codex-action) are not
// governed — they are reviewed by hand.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ACTION_NODE24_FLOORS = {
  "actions/checkout": 5,
  "actions/setup-node": 5,
  "actions/upload-artifact": 6,
  "actions/download-artifact": 7
};

// Matches `- uses: owner/repo@ref`, `uses: "owner/repo@ref"`, and lines with
// trailing comments. Group 1 is the raw uses value.
const USES_LINE = /^\s*(?:-\s+)?uses:\s*["']?([^"'\s#]+)/;

export function parseUsesValue(raw) {
  const value = raw.trim().replace(/^["']|["']$/g, "");
  if (!value) return null;
  // Local composite actions and Docker actions are not governed.
  if (value.startsWith("./") || value.startsWith("../") || value.startsWith("docker://")) return null;
  const at = value.lastIndexOf("@");
  if (at <= 0) return null;
  const action = value.slice(0, at);
  const ref = value.slice(at + 1);
  if (!action.includes("/")) return null;
  return { action, ref };
}

export function isShaRef(ref) {
  return /^[0-9a-f]{40}$/i.test(ref);
}

// Major version of a `v5` / `v5.1.0` style ref, or null for refs that carry
// no leading version (branch names, arbitrary tags).
export function majorOf(ref) {
  const match = /^v?(\d+)/.exec(ref);
  return match ? Number(match[1]) : null;
}

/**
 * Scan one workflow source for `uses:` pins below the node24 floor.
 * Returns an array of { line, uses, action, ref, major, floor }.
 */
export function findViolations(source, floors = ACTION_NODE24_FLOORS) {
  const violations = [];
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = USES_LINE.exec(lines[index]);
    if (!match) continue;
    const parsed = parseUsesValue(match[1]);
    if (!parsed) continue;
    const { action, ref } = parsed;
    const floor = floors[action];
    if (floor === undefined) continue; // not a governed action
    if (isShaRef(ref)) continue; // deliberate immutable pin
    const major = majorOf(ref);
    if (major === null) continue; // branch/tag ref, cannot evaluate
    if (major < floor) {
      violations.push({ line: index + 1, uses: `${action}@${ref}`, action, ref, major, floor });
    }
  }
  return violations;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = path.join(root, ".github", "workflows");
  const files = readdirSync(dir)
    .filter((name) => /\.(?:ya?ml)$/.test(name))
    .sort();
  const violations = [];
  for (const file of files) {
    const source = readFileSync(path.join(dir, file), "utf8");
    for (const violation of findViolations(source)) {
      violations.push({ ...violation, file });
    }
  }
  if (violations.length > 0) {
    console.error(`\x1b[31m✘ ${violations.length} workflow action pin(s) below the Node.js 24 floor:\x1b[0m`);
    for (const violation of violations) {
      console.error(
        `  ${violation.file}:${violation.line}  ${violation.uses}  (needs major >= v${violation.floor})`
      );
    }
    console.error(
      "  These majors declare runs.using: node20, which GitHub deprecated on 2025-09-19 (forced onto node24 with a warning)."
    );
    console.error("  Update the pin to a major whose action.yml declares node24, then add the floor here if the action is new.");
    process.exit(1);
  }
  console.log(`\x1b[32m✓ ${files.length} workflow file(s) checked; all governed action pins meet the Node.js 24 floor.\x1b[0m`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main();
}
