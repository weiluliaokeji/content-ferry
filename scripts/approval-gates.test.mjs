import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createCandidate, verifyCandidate, validateEnvironment, validateApproval } from "./release-gates.mjs";
import { evaluateReleaseCall } from "../.codex/hooks/approval-gates.mjs";
import { requestEndApproval } from "../.codex/hooks/verify-fix-test-immutability.mjs";

test("release writes are denied while build and read-only operations remain available", () => {
  for (const command of ["gh release create v1.0.0", "gh release upload v1.0.0 a.exe", "git push origin v1.0.0", "git push --tags", "gh api -X PUT repos/a/b/environments/release-production"])
    assert.equal(evaluateReleaseCall("Bash", { command }), "release.external-write", command);
  for (const command of ["npm run dist:win", "git tag v1.0.0", "gh release view v1.0.0", "gh api repos/a/b/environments/release-production", "git push origin master"])
    assert.equal(evaluateReleaseCall("Bash", { command }), null, command);
  assert.equal(evaluateReleaseCall("mcp__github__create_release", {}), "release.external-write");
});

test("release hook audits the tool call ID and commit without raw commands", () => {
  const directory = mkdtempSync(join(tmpdir(), "contentferry-release-audit-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: directory });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], { cwd: directory });
    const result = spawnSync(process.execPath, [resolve(".codex/hooks/approval-gates.mjs")], { cwd: directory, encoding: "utf8",
      input: JSON.stringify({ tool_name: "Bash", tool_use_id: "release-call-1", tool_input: { command: "gh release create v1.0.0 secret-canary" } }) });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
    const raw = readFileSync(join(directory, ".git/contentferry-gate-audit.jsonl"), "utf8");
    const audit = JSON.parse(raw);
    assert.equal(audit.callId, "release-call-1");
    assert.match(audit.head, /^[a-f0-9]{40}$/);
    assert.ok(!raw.includes("secret-canary"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("release requires named reviewer, environment protection and an actual approval", () => {
  const environment = { name: "release-production", can_admins_bypass: false, protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { login: "weiluliaokeji" } }] }] };
  assert.doesNotThrow(() => validateEnvironment(environment));
  assert.throws(() => validateEnvironment({ ...environment, can_admins_bypass: true }));
  assert.throws(() => validateEnvironment({ ...environment, protection_rules: [] }));
  assert.throws(() => validateEnvironment({ ...environment, name: "test" }));
  const approval = { state: "approved", user: { login: "weiluliaokeji" }, environments: [{ name: "release-production" }] };
  assert.doesNotThrow(() => validateApproval([approval]));
  assert.throws(() => validateApproval([]));
  assert.throws(() => validateApproval([{ ...approval, user: { login: "other" } }]));
  assert.throws(() => validateApproval([{ ...approval, state: "rejected" }]));
});

test("candidate verification binds exact files to tag, commit and run attempt", () => {
  const source = mkdtempSync(join(tmpdir(), "contentferry-release-test-"));
  const output = join(source, "candidate");
  const context = { tag: "v1.0.0", sha: "a".repeat(40), runId: "123", runAttempt: "1" };
  try {
    writeFileSync(join(source, "ContentFerry.exe"), "isolated fixture, not an executable");
    createCandidate(source, output, context);
    assert.equal(verifyCandidate(output, context).files.length, 2);
    assert.throws(() => verifyCandidate(output, { ...context, sha: "b".repeat(40) }));
    assert.throws(() => verifyCandidate(output, { ...context, runAttempt: "2" }));
    writeFileSync(join(output, "unexpected.exe"), "extra");
    assert.throws(() => verifyCandidate(output, context));
    rmSync(join(output, "unexpected.exe"));
    writeFileSync(join(output, "ContentFerry.exe"), "tampered");
    assert.throws(() => verifyCandidate(output, context));
    const manifest = JSON.parse(readFileSync(join(output, "release-manifest.json"), "utf8"));
    manifest.files[0].name = "../escape.exe";
    writeFileSync(join(output, "release-manifest.json"), JSON.stringify(manifest));
    assert.throws(() => verifyCandidate(output, context));
  } finally { rmSync(source, { recursive: true, force: true }); }
});

test("unlock approval requires an interactive non-agent session and exact scope", async () => {
  const scope = "a".repeat(64);
  const answer = (values) => async () => values.shift();
  await assert.rejects(requestEndApproval(scope, answer([]), { interactive: false, agentSession: false }));
  await assert.rejects(requestEndApproval(scope, answer([]), { interactive: true, agentSession: true }));
  await assert.rejects(requestEndApproval(scope, answer(["maintainer", "completed", "UNLOCK old"]), { interactive: true, agentSession: false }));
  const approval = await requestEndApproval(scope, answer(["maintainer", "test-correction", `UNLOCK ${scope}`]), { interactive: true, agentSession: false });
  assert.equal(approval.scope, scope);
  assert.equal(approval.reason, "test-correction");
  assert.ok(approval.approvalId);
});
