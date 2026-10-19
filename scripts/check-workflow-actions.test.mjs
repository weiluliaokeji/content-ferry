import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ACTION_NODE24_FLOORS,
  findViolations,
  isShaRef,
  majorOf,
  parseUsesValue
} from "./check-workflow-actions.mjs";

// Regression guard for the node20 deprecation warnings observed on the
// v0.3.6 release run (39238701086): actions/checkout@v4,
// actions/setup-node@v4, actions/upload-artifact@v4 and
// actions/download-artifact@v4 declare runs.using: node20, which GitHub
// deprecated on 2025-09-19 (forced onto node24 with a warning annotation).
// The workflows were moved to the first node24 majors (v5/v5/v6/v7); these
// tests keep them there and keep future pins honest.

test("parseUsesValue accepts owner/repo@ref and skips local/docker actions", () => {
  assert.deepEqual(parseUsesValue("actions/checkout@v5"), {
    action: "actions/checkout",
    ref: "v5"
  });
  assert.equal(parseUsesValue("./.github/actions/local"), null);
  assert.equal(parseUsesValue("docker://alpine:3.18"), null);
  assert.equal(parseUsesValue("no-at-sign"), null);
  assert.equal(parseUsesValue("justowner@v1"), null);
});

test("majorOf reads the major from v-prefixed and bare version refs", () => {
  assert.equal(majorOf("v5"), 5);
  assert.equal(majorOf("v5.1.0"), 5);
  assert.equal(majorOf("v7.0.2"), 7);
  assert.equal(majorOf("9"), 9);
  assert.equal(majorOf("main"), null);
  assert.equal(majorOf("release-1.2.3"), null);
});

test("isShaRef only matches full 40-hex commit pins", () => {
  assert.ok(isShaRef("1d82a3dba7c7988ec71ecae1ed5b8e8db96495c5"));
  assert.ok(!isShaRef("1d82a3d"));
  assert.ok(!isShaRef("v5"));
});

test("pins below the node24 floor are reported with line and floor", () => {
  const source = [
    "jobs:",
    "  build:",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 22",
    "      - uses: actions/upload-artifact@v4",
    "      - uses: actions/download-artifact@v4"
  ].join("\n");
  const violations = findViolations(source);
  assert.equal(violations.length, 4);
  assert.deepEqual(
    violations.map((violation) => [violation.line, violation.uses, violation.major, violation.floor]),
    [
      [4, "actions/checkout@v4", 4, 5],
      [5, "actions/setup-node@v4", 4, 5],
      [8, "actions/upload-artifact@v4", 4, 6],
      [9, "actions/download-artifact@v4", 4, 7]
    ]
  );
});

test("at-floor, above-floor and patch-level pins are accepted", () => {
  const source = [
    "      - uses: actions/checkout@v5",
    "      - uses: actions/setup-node@v5.0.0",
    "      - uses: actions/upload-artifact@v6",
    "      - uses: actions/download-artifact@v7",
    "      - uses: actions/checkout@v9"
  ].join("\n");
  assert.deepEqual(findViolations(source), []);
});

test("SHA pins, local actions, docker actions and branch refs are not governed", () => {
  const source = [
    "      - uses: openai/codex-action@1d82a3dba7c7988ec71ecae1ed5b8e8db96495c5 # v1",
    "      - uses: ./.github/actions/build",
    "      - uses: docker://alpine:3.18",
    "      - uses: actions/checkout@main",
    "      - uses: actions/setup-node@v4 # trailing comment is ignored"
  ].join("\n");
  const violations = findViolations(source);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].uses, "actions/setup-node@v4");
});

test("quoted uses values are parsed", () => {
  const source = ['      - uses: "actions/checkout@v4"'].join("\n");
  const violations = findViolations(source);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].action, "actions/checkout");
});

test("actions without a configured floor pass untouched", () => {
  // Unknown actions/* are not governed; adding a floor for a newly used
  // action is a deliberate, reviewed change (see the header comment).
  const source = ["      - uses: actions/cache@v3", "      - actions/stale@v9"].join("\n");
  assert.deepEqual(findViolations(source), []);
});

test("custom floors can be supplied for focused checks", () => {
  const source = ["      - uses: actions/checkout@v4", "      - uses: actions/setup-node@v5"].join("\n");
  const violations = findViolations(source, { "actions/checkout": 4 });
  assert.deepEqual(violations, []);
});

test("the repository's own workflows meet the node24 floor", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");
  const files = readdirSync(dir).filter((name) => /\.(?:ya?ml)$/.test(name));
  assert.ok(files.length > 0, "expected at least one workflow file");
  for (const file of files) {
    const source = readFileSync(path.join(dir, file), "utf8");
    assert.deepEqual(
      findViolations(source),
      [],
      `${file} pins an action below its Node.js 24 floor`
    );
  }
});

test("the floor table covers every action the repository uses", () => {
  // Keeps the self-check above honest: a newly pinned actions/* step must
  // either get a floor entry or be an explicit exception.
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");
  const used = new Set();
  for (const file of readdirSync(dir).filter((name) => /\.(?:ya?ml)$/.test(name))) {
    const source = readFileSync(path.join(dir, file), "utf8");
    for (const line of source.split(/\r?\n/)) {
      const match = /^\s*(?:-\s+)?uses:\s*["']?([^"'\s#]+)/.exec(line);
      if (!match) continue;
      const parsed = parseUsesValue(match[1]);
      if (parsed && parsed.action.startsWith("actions/")) used.add(parsed.action);
    }
  }
  for (const action of used) {
    assert.ok(
      action in ACTION_NODE24_FLOORS,
      `${action} is used but has no Node.js 24 floor entry`
    );
  }
});
