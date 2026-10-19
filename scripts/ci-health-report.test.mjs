import assert from "node:assert/strict";
import test from "node:test";
import { buildWindows, fetchWorkflowRuns, formatRate, inWindow, summarize } from "./ci-health-report.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const CUTOFF = new Date("2026-09-12T00:00:00.000Z");

function stubWorkflowRuns(t, respond) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    calls.push(url);
    return { ok: true, json: async () => ({ workflow_runs: respond(url, calls.length) }) };
  });
  return calls;
}

function workflowRun(overrides = {}) {
  return {
    id: 1,
    event: "pull_request",
    head_branch: "feature/test",
    created_at: "2026-10-18T12:00:00.000Z",
    run_attempt: 1,
    conclusion: "success",
    head_sha: "a".repeat(40),
    ...overrides
  };
}

function fetchOptions() {
  return {
    apiBase: "https://api.example.test",
    repository: "owner/repo",
    workflowId: 123,
    token: "test-token",
    event: "pull_request",
    cutoff: CUTOFF
  };
}

test("health report windows cover recent 7 days, prior 30 days, and rolling 30 days", () => {
  const now = new Date("2026-10-19T01:00:00.000Z");
  const windows = buildWindows(now);

  assert.deepEqual(windows.recent7d, {
    from: new Date(now.getTime() - 7 * DAY_MS),
    to: now
  });
  assert.deepEqual(windows.preceding30d, {
    from: new Date(now.getTime() - 37 * DAY_MS),
    to: new Date(now.getTime() - 7 * DAY_MS)
  });
  assert.deepEqual(windows.rolling30d, {
    from: new Date(now.getTime() - 30 * DAY_MS),
    to: now
  });
});

test("health report windows include their start and exclude their end", () => {
  const window = { from: new Date("2026-10-18T00:00:00.000Z"), to: new Date("2026-10-19T00:00:00.000Z") };

  assert.equal(inWindow("2026-10-18T00:00:00.000Z", window), true);
  assert.equal(inWindow("2026-10-19T00:00:00.000Z", window), false);
  assert.equal(inWindow("2026-10-17T23:59:59.999Z", window), false);
});

test("all failed conclusions are counted while cancelled, skipped, and other stay outside the rate", () => {
  const window = { from: new Date("2026-10-18T00:00:00.000Z"), to: new Date("2026-10-19T00:00:00.000Z") };
  const runs = ["success", "failure", "timed_out", "startup_failure", "action_required", "stale", "cancelled", "skipped", "neutral", null].map((conclusion, index) => ({
    id: index + 1,
    run_attempt: 1,
    created_at: "2026-10-18T12:00:00.000Z",
    head_sha: "a".repeat(40),
    conclusion
  }));
  runs.push({ id: 8, run_attempt: 1, created_at: "2026-10-19T00:00:00.000Z", conclusion: "failure" });

  const result = summarize(runs, window);

  assert.deepEqual({
    success: result.success,
    failed: result.failed,
    cancelled: result.cancelled,
    skipped: result.skipped,
    other: result.other,
    eligible: result.eligible,
    failureRate: result.failureRate,
    failedIds: result.failureRuns.map((run) => run.id)
  }, {
    success: 1,
    failed: 5,
    cancelled: 1,
    skipped: 1,
    other: 2,
    eligible: 6,
    failureRate: "83.3%",
    failedIds: [2, 3, 4, 5, 6]
  });
});

test("failure rate formatting handles empty and fractional samples", () => {
  assert.equal(formatRate(0, 0), "—");
  assert.equal(formatRate(1, 6), "16.7%");
});

test("workflow run pagination marks a full ten-page sample as potentially truncated", async (t) => {
  const calls = stubWorkflowRuns(t, (_url, page) => Array.from({ length: 100 }, (_, index) => workflowRun({ id: page * 100 + index })));

  const result = await fetchWorkflowRuns(fetchOptions());

  assert.equal(calls.length, 10);
  assert.equal(result.pagesRead, 10);
  assert.equal(result.runs.length, 1000);
  assert.equal(result.mayBeTruncated, true);
  assert.equal(calls.at(-1).searchParams.get("page"), "10");
});

test("workflow run pagination stops after a short page without marking truncation", async (t) => {
  const calls = stubWorkflowRuns(t, () => [workflowRun({ id: 1 }), workflowRun({ id: 2 }), workflowRun({ id: 3 })]);

  const result = await fetchWorkflowRuns(fetchOptions());

  assert.equal(calls.length, 1);
  assert.equal(result.pagesRead, 1);
  assert.equal(result.runs.length, 3);
  assert.equal(result.mayBeTruncated, false);
});

test("workflow run pagination stops when a page reaches the lookback cutoff", async (t) => {
  const calls = stubWorkflowRuns(t, () => [
    ...Array.from({ length: 99 }, (_, index) => workflowRun({ id: index + 1 })),
    workflowRun({ id: 100, created_at: "2026-09-11T23:59:59.999Z" })
  ]);

  const result = await fetchWorkflowRuns(fetchOptions());

  assert.equal(calls.length, 1);
  assert.equal(result.pagesRead, 1);
  assert.equal(result.runs.length, 99);
  assert.equal(result.runs.some((run) => run.id === 100), false);
  assert.equal(result.mayBeTruncated, false);
});

test("workflow run pagination keeps the highest attempt for a repeated run id", async (t) => {
  const calls = stubWorkflowRuns(t, () => [
    workflowRun({ id: 42, run_attempt: 3, conclusion: "failure" }),
    workflowRun({ id: 42, run_attempt: 2, conclusion: "success" })
  ]);

  const result = await fetchWorkflowRuns(fetchOptions());

  assert.equal(calls.length, 1);
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].id, 42);
  assert.equal(result.runs[0].run_attempt, 3);
  assert.equal(result.runs[0].conclusion, "failure");
});
