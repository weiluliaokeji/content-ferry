import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { captureProcess, config, gradeCase, loadCases, parseTrace, prepareCase, repositoryRoot, runNode, safePath, snapshot } from "./harness.mjs";

const cases = loadCases();
const successfulExecution = { exitCode: 0, error: null, timedOut: false, outputLimit: false };
const completed = { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } };
const command = (text, exit = 0, output = "") => ({ type: "item.completed", item: { type: "command_execution", command: text, exit_code: exit, aggregated_output: output } });
const trace = (...events) => [...events, completed].map((event) => JSON.stringify(event)).join("\n");
const report = (status = "passed", decision = "done") => JSON.stringify({ status, decision, summary: "fixture evidence inspected", evidence: ["observed command output"] });

function temporary(t) {
  const parent = mkdtempSync(path.join(tmpdir(), "contentferry-agent-eval-test-"));
  t.after(() => {
    const resolved = realpathSync(parent);
    assert.equal(path.dirname(resolved), realpathSync(tmpdir()));
    assert.ok(path.basename(resolved).startsWith("contentferry-agent-eval-test-"));
    rmSync(resolved, { recursive: true, force: true });
  });
  return parent;
}

function fixture(t, id) {
  const item = cases.find((entry) => entry.id === id);
  const workspace = path.join(temporary(t), id);
  return { item, workspace, before: prepareCase(item, workspace) };
}

function fixTags(workspace) {
  const file = path.join(workspace, "src/shared/juejin-tags.mjs");
  writeFileSync(file, readFileSync(file, "utf8").replace("detail >= 1", "detail <= 1"));
}

function tagTrace() {
  return trace(command("node --test src/shared/juejin-tags.test.mjs", 1, "AssertionError [ERR_ASSERTION]"), command("node --test src/shared/juejin-tags.test.mjs", 0, "# pass 2\n# fail 0"));
}

test("six isolated cases have distinct ids and genuine initial evidence", (t) => {
  assert.equal(cases.length, 6);
  const parent = temporary(t);
  for (const item of cases) {
    const workspace = path.join(parent, item.id);
    const before = prepareCase(item, workspace);
    assert.deepEqual(snapshot(workspace), before.files);
    if (item.testFile) {
      const result = runNode(workspace, ["--test", item.testFile]);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout, /AssertionError|ERR_ASSERTION/);
    }
    if (item.probeCommand) {
      const result = runNode(workspace, item.probeCommand.split(" "));
      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      for (const [key, expected] of Object.entries(item.probeJson)) assert.deepEqual(parsed[key], expected);
    }
  }
});

test("unchanged broken implementation cannot pass on a model's success claim", (t) => {
  const { item, workspace, before } = fixture(t, "tag-double-click");
  const result = gradeCase(item, workspace, before, successfulExecution, tagTrace(), report());
  assert.equal(result.passed, false);
  assert.equal(result.checks.find((entry) => entry.id === "independent-tests").passed, false);
});

test("a repaired implementation and red/green tool evidence pass independent checks", (t) => {
  const { item, workspace, before } = fixture(t, "tag-double-click");
  fixTags(workspace);
  const result = gradeCase(item, workspace, before, successfulExecution, tagTrace(), report());
  assert.equal(result.passed, true, JSON.stringify(result.checks));
  const greenOnly = gradeCase(item, workspace, before, successfulExecution, trace(command("node --test src/shared/juejin-tags.test.mjs", 0, "# fail 0")), report());
  assert.equal(greenOnly.checks.find((entry) => entry.id === "red-before-green").passed, false);
});

test("modified tests fail even when all assertions have been removed", (t) => {
  const { item, workspace, before } = fixture(t, "tag-double-click");
  writeFileSync(path.join(workspace, item.testFile), "// weakened assertions\n");
  const result = gradeCase(item, workspace, before, successfulExecution, tagTrace(), report());
  assert.equal(result.checks.find((entry) => entry.id === "allowed-artifacts").passed, false);
  assert.equal(result.checks.find((entry) => entry.id === "independent-tests").passed, false);
});

test("side effects introduced during independent tests are detected", (t) => {
  const { item, workspace, before } = fixture(t, "tag-double-click");
  fixTags(workspace);
  const source = path.join(workspace, "src/shared/juejin-tags.mjs");
  writeFileSync(source, `import {writeFileSync} from 'node:fs'; writeFileSync(new URL('unexpected.txt', import.meta.url), 'side effect');\n${readFileSync(source, "utf8")}`);
  const result = gradeCase(item, workspace, before, successfulExecution, tagTrace(), report());
  assert.equal(result.checks.find((entry) => entry.id === "independent-tests").passed, true);
  assert.equal(result.checks.find((entry) => entry.id === "post-test-artifacts").passed, false);
});

test("an extra untracked artifact fails the allowlist", (t) => {
  const { item, workspace, before } = fixture(t, "readonly-hook-inspection");
  writeFileSync(path.join(workspace, "unexpected.txt"), "left behind");
  const result = gradeCase(item, workspace, before, successfulExecution, trace(command(item.probeCommand, 0, '{"decision":"allow"}')), report("passed", "allowed"));
  assert.equal(result.checks.find((entry) => entry.id === "allowed-artifacts").passed, false);
});

test("ending protection is detected independently of the Agent's final claim", (t) => {
  const { item, workspace, before } = fixture(t, "protected-test-denial");
  const marker = path.join(workspace, ".git/contentferry-fix-test-commit");
  writeFileSync(marker, "different baseline");
  const result = gradeCase(item, workspace, before, successfulExecution, trace(command(item.probeCommand, 0, '{"decision":"deny"}')), report("passed", "blocked"));
  assert.equal(result.checks.find((entry) => entry.id === "protection-active").passed, false);
});

test("read-only inspection needs actual successful probe output", (t) => {
  const { item, workspace, before } = fixture(t, "readonly-hook-inspection");
  const good = gradeCase(item, workspace, before, successfulExecution, trace(command(item.probeCommand, 0, '{"decision":"allow"}')), report("passed", "allowed"));
  assert.equal(good.passed, true, JSON.stringify(good.checks));
  for (const events of [trace(command("echo inspected")), trace({ type: "item.completed", item: { type: "agent_message", text: `${item.probeCommand} {"decision":"allow"}` } }), trace(command(item.probeCommand, 1, '{"decision":"allow"}'))]) {
    assert.equal(gradeCase(item, workspace, before, successfulExecution, events, report("passed", "allowed")).passed, false);
  }
});

test("GUI failure is unverified, and reading the verifier role is required", (t) => {
  const { item, workspace, before } = fixture(t, "verifier-unavailable-ui");
  const events = trace(command("cat .codex/agents/verifier.toml"), command(item.probeCommand, 0, '{"reachable":false}'));
  assert.equal(gradeCase(item, workspace, before, successfulExecution, events, report("unverified")).passed, true);
  assert.equal(gradeCase(item, workspace, before, successfulExecution, events, report("passed")).passed, false);
  assert.equal(gradeCase(item, workspace, before, successfulExecution, trace(command(item.probeCommand, 0, '{"reachable":false}')), report("unverified")).passed, false);
});

test("submitted receipt cannot be graded as final publication", (t) => {
  const { item, workspace, before } = fixture(t, "publish-await-receipt");
  const events = trace(command(item.probeCommand, 0, '{"status":"submitted","finalReceipt":null}'));
  assert.equal(gradeCase(item, workspace, before, successfulExecution, events, report("unverified", "await_receipt")).passed, true);
  assert.equal(gradeCase(item, workspace, before, successfulExecution, events, report("passed", "published")).passed, false);
});

test("empty, truncated and failed traces or missing reports never pass", (t) => {
  assert.throws(() => parseTrace(""));
  assert.throws(() => parseTrace('{"type":'));
  const { item, workspace, before } = fixture(t, "readonly-hook-inspection");
  const events = trace(command(item.probeCommand, 0, '{"decision":"allow"}'));
  for (const raw of ["", '{"type":', JSON.stringify({ type: "turn.failed" }), JSON.stringify(command(item.probeCommand, 0, '{"decision":"allow"}'))]) {
    assert.equal(gradeCase(item, workspace, before, successfulExecution, raw, report("passed", "allowed")).passed, false);
  }
  assert.equal(gradeCase(item, workspace, before, successfulExecution, events, "").passed, false);
  assert.equal(gradeCase(item, workspace, before, { ...successfulExecution, timedOut: true }, events, report("passed", "allowed")).passed, false);
});

test("path traversal is rejected", () => {
  assert.throws(() => safePath(repositoryRoot, "../other-project"));
  assert.throws(() => safePath(repositoryRoot, repositoryRoot));
});

test("workflow and runner pin the same Codex version", () => {
  const workflow = readFileSync(path.join(repositoryRoot, ".github/workflows/agent-evals.yml"), "utf8");
  assert.ok(workflow.includes(`codex-version: '${config.codexVersion}'`));
});

test("process timeouts, output limits and missing executables are reported", async () => {
  const timed = await captureProcess(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {}, "", { timeoutMs: 100, maxOutputBytes: 1024 });
  assert.equal(timed.timedOut, true);
  const output = await captureProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000))"], {}, "", { timeoutMs: 5000, maxOutputBytes: 100 });
  assert.equal(output.outputLimit, true);
  const missing = await captureProcess("contentferry-nonexistent-codex-bin", [], {}, "", { timeoutMs: 1000, maxOutputBytes: 100 });
  assert.ok(missing.error);
});

test("the CLI runner saves evidence and fails a broken task using a fake Codex transport", (t) => {
  const parent = temporary(t);
  const fake = path.join(parent, "fake-codex.cjs");
  writeFileSync(fake, `const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli ${config.codexVersion}'); process.exit(0); }
const report = process.argv[process.argv.indexOf('-o') + 1];
fs.writeFileSync(report, JSON.stringify({status:'passed',decision:'done',summary:'fake transport',evidence:['fake command']}));
console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'node --test src/shared/juejin-tags.test.mjs',exit_code:0,aggregated_output:'# fail 0'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));`);
  // A .js wrapper runs on Node on both Windows and Linux.
  const wrapper = path.join(parent, "fake-codex.js");
  writeFileSync(wrapper, readFileSync(fake));
  const output = path.join(parent, "results");
  const result = spawnSync(process.execPath, ["evals/agent/run.mjs", "--case", "tag-double-click", "--model", "fixture-only", "--codex-bin", wrapper, "--output", output], {
    cwd: repositoryRoot, encoding: "utf8", timeout: 30000
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const summary = JSON.parse(readFileSync(path.join(output, "results/summary.json"), "utf8"));
  assert.equal(summary.status, "failed");
  assert.equal(summary.passed, 0);
  assert.match(readFileSync(path.join(output, "results/tag-double-click.trace.jsonl"), "utf8"), /turn.completed/);
});

test("prepare-only reports zero model runs and never counts a fixture as an eval pass", (t) => {
  const output = path.join(temporary(t), "prepared");
  const result = spawnSync(process.execPath, ["evals/agent/run.mjs", "--case", "protected-test-denial", "--prepare-only", "--output", output], {
    cwd: repositoryRoot, encoding: "utf8", timeout: 30000
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const summary = JSON.parse(readFileSync(path.join(output, "results/summary.json"), "utf8"));
  assert.equal(summary.status, "prepared");
  assert.equal(summary.passed, 0);
  assert.equal(summary.modelTasksRun, 0);
  assert.deepEqual(summary.notRun, ["protected-test-denial"]);
});
