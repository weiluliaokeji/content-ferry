#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_DAYS = 37;
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure", "action_required", "stale"]);
const EXCLUDED_CONCLUSIONS = new Set(["cancelled", "skipped"]);

function makeWindow(now, endDaysAgo, startDaysAgo) {
  return {
    from: new Date(now.getTime() - startDaysAgo * DAY_MS),
    to: new Date(now.getTime() - endDaysAgo * DAY_MS)
  };
}

export function buildWindows(now) {
  return {
    recent7d: makeWindow(now, 0, 7),
    preceding30d: makeWindow(now, 7, 37),
    rolling30d: makeWindow(now, 0, 30)
  };
}

export function inWindow(date, window) {
  const value = new Date(date).getTime();
  return value >= window.from.getTime() && value < window.to.getTime();
}

export function formatRate(failures, eligible) {
  if (eligible === 0) return "—";
  return `${((failures / eligible) * 100).toFixed(1)}%`;
}

export function summarize(runs, window) {
  const totals = { success: 0, failed: 0, cancelled: 0, skipped: 0, other: 0 };
  const failureRuns = [];

  for (const run of runs) {
    if (!inWindow(run.created_at, window)) continue;
    const conclusion = run.conclusion ?? "unknown";
    if (conclusion === "success") {
      totals.success += 1;
    } else if (FAILED_CONCLUSIONS.has(conclusion)) {
      totals.failed += 1;
      failureRuns.push({
        id: run.id,
        attempt: run.run_attempt,
        createdAt: run.created_at,
        headSha: run.head_sha,
        conclusion
      });
    } else if (EXCLUDED_CONCLUSIONS.has(conclusion)) {
      if (conclusion === "cancelled") totals.cancelled += 1;
      if (conclusion === "skipped") totals.skipped += 1;
    } else {
      totals.other += 1;
    }
  }

  const eligible = totals.success + totals.failed;
  return { ...totals, eligible, failureRate: formatRate(totals.failed, eligible), failureRuns };
}

async function githubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28"
    }
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000);
    throw new Error(`GitHub API ${response.status} for ${url}: ${detail}`);
  }
  return response.json();
}

export async function fetchWorkflowRuns({ apiBase, repository, workflowId, token, event, branch, cutoff }) {
  const runsById = new Map();
  let pagesRead = 0;
  let mayBeTruncated = false;
  for (let page = 1; page <= 10; page += 1) {
    const url = new URL(`${apiBase}/repos/${repository}/actions/workflows/${workflowId}/runs`);
    url.searchParams.set("event", event);
    url.searchParams.set("status", "completed");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    url.searchParams.set("sort", "created");
    url.searchParams.set("direction", "desc");
    if (branch) url.searchParams.set("branch", branch);

    const payload = await githubJson(url, token);
    const pageRuns = Array.isArray(payload.workflow_runs) ? payload.workflow_runs : [];
    pagesRead = page;
    if (pageRuns.length === 0) break;

    let olderThanCutoff = false;
    for (const run of pageRuns) {
      if (run.event !== event || (branch && run.head_branch !== branch)) continue;
      if (!Number.isSafeInteger(run.id) || run.id < 1 || !run.created_at || !Number.isSafeInteger(run.run_attempt)) continue;
      if (new Date(run.created_at).getTime() < cutoff.getTime()) {
        olderThanCutoff = true;
        continue;
      }
      const previous = runsById.get(run.id);
      if (!previous || run.run_attempt > previous.run_attempt) runsById.set(run.id, run);
    }
    if (olderThanCutoff || pageRuns.length < 100) break;
    if (page === 10) mayBeTruncated = true;
  }
  return { runs: [...runsById.values()], pagesRead, mayBeTruncated };
}

function renderMarkdown({ generatedAt, source, windows, channels, collection }) {
  const lines = [
    "# ContentFerry CI health snapshot",
    "",
    `Generated: ${generatedAt}`,
    "",
    "This report counts completed workflow runs. It is descriptive only: no control limits, anomaly decisions, model calls, comments, issues, or code changes are produced.",
    "",
    "Failure rate = failed runs / (successful runs + failed runs). Cancelled and skipped runs are excluded from the denominator.",
    ""
  ];

  if (Object.values(collection).some((status) => status.mayBeTruncated)) {
    lines.push("⚠️ At least one event reached the 1,000-run pagination limit before the lookback cutoff; its sample may be incomplete.", "");
  }

  for (const [channelName, periods] of Object.entries(channels)) {
    lines.push(`## ${channelName}`, "", "| Window | Success | Failed | Cancelled | Skipped | Other | Eligible | Failure rate |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const [periodName, summary] of Object.entries(periods)) {
      lines.push(`| ${periodName} | ${summary.success} | ${summary.failed} | ${summary.cancelled} | ${summary.skipped} | ${summary.other} | ${summary.eligible} | ${summary.failureRate} |`);
    }
    const failures = periods.recent7d.failureRuns;
    if (failures.length > 0) {
      lines.push("", "Recent failed runs:");
      for (const failure of failures.slice(0, 10)) {
        const runUrl = `https://github.com/${source.repository}/actions/runs/${failure.id}`;
        const headSha = /^[a-f0-9]{40}$/i.test(failure.headSha || "") ? failure.headSha : "unknown";
        lines.push(`- [Run ${failure.id}, attempt ${failure.attempt}](${runUrl}) — ${failure.conclusion}, ${failure.createdAt}, commit ${headSha}`);
      }
    }
    lines.push("");
  }

  lines.push(
    "## Interpretation",
    "",
    "This first phase establishes counts and rates only. It does not label a failure as flaky or product-caused, and it does not trigger Sigma bands. The next phase should be based on observed sample volume and reviewed failure categories.",
    ""
  );
  return lines.join("\n");
}

export async function generateCiHealthReport({ now = new Date(), env = process.env } = {}) {
  const token = env.GITHUB_TOKEN;
  const repository = env.GITHUB_REPOSITORY;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) throw new Error("GITHUB_REPOSITORY must be owner/repository");

  const apiBase = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  const cutoff = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS);
  const repositoryUrl = `${apiBase}/repos/${repository}`;
  const workflow = await githubJson(`${repositoryUrl}/actions/workflows/ci.yml`, token);
  if (!Number.isSafeInteger(workflow.id)) throw new Error("GitHub did not return a numeric CI workflow id");

  const [pullRequestFetch, masterPushFetch] = await Promise.all([
    fetchWorkflowRuns({ apiBase, repository, workflowId: workflow.id, token, event: "pull_request", cutoff }),
    fetchWorkflowRuns({ apiBase, repository, workflowId: workflow.id, token, event: "push", branch: "master", cutoff })
  ]);
  const windows = buildWindows(now);
  const summarizePeriods = (runs) => Object.fromEntries(
    Object.entries(windows).map(([name, window]) => [name, summarize(runs, window)])
  );
  const report = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    source: { workflow: "ci.yml", repository, events: ["pull_request", "push to master"] },
    windows: Object.fromEntries(Object.entries(windows).map(([name, window]) => [name, { from: window.from.toISOString(), to: window.to.toISOString() }])),
    collection: {
      pull_request: { pagesRead: pullRequestFetch.pagesRead, mayBeTruncated: pullRequestFetch.mayBeTruncated },
      master_push: { pagesRead: masterPushFetch.pagesRead, mayBeTruncated: masterPushFetch.mayBeTruncated }
    },
    channels: {
      pull_request: summarizePeriods(pullRequestFetch.runs),
      master_push: summarizePeriods(masterPushFetch.runs)
    },
    statisticalSignal: "not_evaluated"
  };
  const markdown = renderMarkdown(report);
  const outputDir = path.resolve(env.CI_HEALTH_OUTPUT_DIR || path.join(projectRoot, ".cache", "ci-health"));
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, "ci-health-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(path.join(outputDir, "ci-health-report.md"), markdown, "utf8");
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`, "utf8");
  return { outputDir, report, markdown };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateCiHealthReport()
    .then(({ outputDir, report }) => {
      console.log(`CI health report saved to ${outputDir}`);
      console.log(`Pull request runs: ${report.channels.pull_request.rolling30d.eligible}; master pushes: ${report.channels.master_push.rolling30d.eligible}`);
    })
    .catch((error) => {
      console.error(`CI health report failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
