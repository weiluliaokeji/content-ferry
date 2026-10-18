import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { captureProcess, config, gradeCase, loadCases, prepareCase, repositoryRoot, runNode, suiteDirectory } from "./harness.mjs";

function argumentsFrom(values) {
  const options = { cases: [] };
  for (let index = 0; index < values.length; index++) {
    const flag = values[index];
    if (["--list", "--prepare-only"].includes(flag)) options[flag.slice(2)] = true;
    else if (["--case", "--model", "--codex-bin", "--output"].includes(flag)) {
      const value = values[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
      if (flag === "--case") options.cases.push(value); else options[flag.slice(2)] = value;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

function saveJson(file, data) { writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`); }

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const allCases = loadCases();
  if (options.list) {
    for (const item of allCases) console.log(`${item.id}\t${item.origin}`);
    return;
  }
  const selected = options.cases.length ? allCases.filter((item) => options.cases.includes(item.id)) : allCases;
  if (!selected.length || options.cases.some((id) => !allCases.some((item) => item.id === id))) throw new Error("Unknown or empty case selection");
  const output = path.resolve(options.output ?? path.join(repositoryRoot, ".cache/agent-evals", new Date().toISOString().replaceAll(/[:.]/g, "-")));
  // Never overwrite earlier evidence, or place artifacts inside a fixture.
  if (existsSync(output)) throw new Error(`Output directory already exists: ${output}`);
  mkdirSync(path.dirname(output), { recursive: true });
  mkdirSync(output);
  const resultsDirectory = path.join(output, "results");
  const workspaces = path.join(output, "workspaces");
  mkdirSync(resultsDirectory);
  mkdirSync(workspaces);
  const summary = {
    mode: options["prepare-only"] ? "prepare-only" : "live",
    status: "running", model: options.model ?? process.env.AGENT_EVAL_MODEL ?? null,
    codexVersion: config.codexVersion, actualCodexVersion: null,
    nodeVersion: process.version, startedAt: new Date().toISOString(),
    expected: selected.length, passed: 0, results: []
  };
  const persist = () => {
    summary.notRun = selected.filter((item) => !summary.results.some((result) => result.id === item.id && result.status !== "prepared")).map((item) => item.id);
    summary.agentAttempts = summary.results.filter((item) => item.status !== "prepared").length;
    summary.modelTasksRun = summary.results.filter((item) => item.checks?.some((check) => check.id === "turn-completed" && check.passed)).length;
    saveJson(path.join(resultsDirectory, "summary.json"), summary);
    const lines = ["# Agent quick evals", "", `Mode: ${summary.mode}; status: ${summary.status}; model: ${summary.model ?? "unset"}`, `Agent attempts: ${summary.agentAttempts}; completed model tasks: ${summary.modelTasksRun}/${summary.expected}; passed: ${summary.passed}; not run: ${summary.notRun.join(", ") || "none"}`, "", "| Case | Result | Elapsed ms | Failed checks |", "| --- | --- | --- | --- |"];
    for (const item of summary.results) lines.push(`| ${item.id} | ${item.status} | ${item.elapsedMs ?? "n/a"} | ${(item.checks ?? []).filter((check) => !check.passed).map((check) => check.id).join(", ")} |`);
    writeFileSync(path.join(resultsDirectory, "summary.md"), `${lines.join("\n")}\n`);
  };
  persist();
  try {
    const binary = options["codex-bin"] ?? "codex";
    const command = binary.endsWith(".js") ? process.execPath : binary;
    const prefix = binary.endsWith(".js") ? [path.resolve(binary)] : [];
    if (!options["prepare-only"]) {
      if (!summary.model) throw new Error("Set AGENT_EVAL_MODEL or --model to a fixed, accessible model before a live eval");
      const version = spawnSync(command, [...prefix, "--version"], { encoding: "utf8", timeout: 10000, windowsHide: true });
      summary.actualCodexVersion = version.stdout?.trim() ?? "";
      if (version.error || version.status !== 0 || !new RegExp(`\\b${config.codexVersion.replaceAll(".", "\\.")}\\b`).test(summary.actualCodexVersion)) {
        throw new Error(`Expected codex-cli ${config.codexVersion}; got ${summary.actualCodexVersion || version.error?.message || version.stderr}`);
      }
    }
    for (const item of selected) {
      const workspace = path.join(workspaces, item.id);
      const before = prepareCase(item, workspace);
      saveJson(path.join(resultsDirectory, `${item.id}.baseline.json`), before);
      const prompt = `${item.prompt}\n\n当前目录是从文渡问题提炼的隔离最小夹具，不是完整应用。遵循其中当前版本的 AGENTS.md 与 .codex 角色职责；只操作本夹具，不运行完整项目的编译或 Electron 命令。允许修改的文件：${item.allowedChanges.join("、") || "无，本题只读"}。保持 Git HEAD 与保护标记，不创建提交或结束保护。按提供的 JSON Schema 输出最终报告，证据必须来自实际工具执行。`;
      writeFileSync(path.join(resultsDirectory, `${item.id}.prompt.txt`), prompt);
      if (options["prepare-only"]) {
        const baseline = item.testFile ? runNode(workspace, ["--test", item.testFile]) : null;
        if (baseline && (baseline.status === 0 || baseline.error || !/ERR_ASSERTION|AssertionError/.test(baseline.stdout))) throw new Error(`${item.id}: fixture must fail an expected assertion before repair`);
        const probe = item.probeCommand ? runNode(workspace, item.probeCommand.split(" ")) : null;
        if (probe && (probe.status !== 0 || probe.error || !Object.entries(item.probeJson).every(([key, value]) => JSON.stringify(JSON.parse(probe.stdout)[key]) === JSON.stringify(value)))) throw new Error(`${item.id}: fixture probe failed`);
        summary.results.push({ id: item.id, status: "prepared", checks: [], baseline, probe });
        console.log(`PREPARED ${item.id} (no Agent run)`);
      } else {
        console.log(`RUN ${item.id}`);
        const reportPath = path.join(resultsDirectory, `${item.id}.agent.json`);
        const start = Date.now();
        const execution = await captureProcess(command, [...prefix, "exec", "--json", "--ephemeral", "--sandbox", "workspace-write", "--color", "never",
          "--model", summary.model, "-c", 'approval_policy="never"', "-c", `model_reasoning_effort="${config.reasoningEffort}"`,
          "--output-schema", path.join(suiteDirectory, "report.schema.json"), "-o", reportPath, "-"], { cwd: workspace }, prompt);
        const { stdout, stderr, ...processResult } = execution;
        writeFileSync(path.join(resultsDirectory, `${item.id}.trace.jsonl`), stdout);
        writeFileSync(path.join(resultsDirectory, `${item.id}.stderr.txt`), stderr);
        const result = gradeCase(item, workspace, before, processResult, stdout, existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "");
        result.status = result.passed ? "passed" : "failed";
        result.elapsedMs = Date.now() - start;
        saveJson(path.join(resultsDirectory, `${item.id}.result.json`), result);
        summary.results.push(result);
        summary.passed += Number(result.passed);
        console.log(`${result.status.toUpperCase()} ${item.id}: ${result.checks.filter((check) => !check.passed).map((check) => check.id).join(", ")}`);
        if (processResult.error || processResult.exitCode !== 0) throw new Error(`${item.id}: Codex runtime failed; inspect stderr/trace. Remaining cases were not run`);
      }
      persist();
    }
    summary.status = options["prepare-only"] ? "prepared" : summary.passed === selected.length ? "passed" : "failed";
    process.exitCode = summary.status === "failed" ? 1 : 0;
  } catch (error) {
    summary.status = "error";
    summary.error = error instanceof Error ? error.message : String(error);
    console.error(summary.error);
    process.exitCode = 1;
  } finally {
    summary.finishedAt = new Date().toISOString();
    persist();
    console.log(`Report: ${path.join(resultsDirectory, "summary.md")}`);
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
