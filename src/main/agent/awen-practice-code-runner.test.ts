import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openInMemoryDatabase, type AppDatabase } from "../db/database";
import { ExecutionRepository } from "./execution-repository";
import { ExecutionService } from "./execution-service";
import type { PracticeRuntimeLookup } from "./awen-practice-code-runner";
import { AwenPracticeCodeRunner } from "./awen-practice-code-runner";

describe("Awen practice code runner", () => {
  let database: AppDatabase | undefined;
  let temporaryRoot: string | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
    if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  });

  it("runs a bounded Node example in a workflow-specific temp folder and records its artifact", async () => {
    database = openInMemoryDatabase();
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-practice-test-"));
    const runs = new ExecutionRepository(database.connection);
    const codeRunner = new AwenPracticeCodeRunner(new ExecutionService(), runs, testNodeLookup(), temporaryRoot);
    const workflowId = "40d6ae9e-2ce0-4c6b-b51c-889a5fba2e8d";
    const target = codeRunner.getWorkflowDirectory(undefined, workflowId);

    const result = await codeRunner.run({ runtime: "node", code: "console.log('practice-ok')" }, {
      workflowId,
      target,
      authorization: { confirmed: true, decisionSource: "default_policy", checks: [{ action: "write", decision: "allow", reason: "test approval", matchedScope: "run" }] }
    }) as { runId: string; status: string; stdout: string; artifacts: Array<{ path: string; sha256: string }> };

    expect(result.status).toBe("completed");
    expect(result.stdout.trim()).toBe("practice-ok");
    expect(result.artifacts.some((artifact) => artifact.path.startsWith("attempt-") && /^[0-9a-f]{64}$/u.test(artifact.sha256))).toBe(true);
    expect(runs.require(result.runId).request.cwd).toBe(fs.realpathSync.native(target));
    expect(runs.require(result.runId).request.workflowId).toBe(workflowId);
  });

  it("rejects model-selected paths and blocks reruns after an interrupted side effect", async () => {
    database = openInMemoryDatabase();
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-practice-test-"));
    const runs = new ExecutionRepository(database.connection);
    const codeRunner = new AwenPracticeCodeRunner(new ExecutionService(), runs, testNodeLookup(), temporaryRoot);
    const workflowId = "40d6ae9e-2ce0-4c6b-b51c-889a5fba2e8d";
    const target = codeRunner.getWorkflowDirectory(undefined, workflowId);
    await expect(codeRunner.run({ runtime: "node", code: "console.log('no')" }, { workflowId, target: path.dirname(target) })).rejects.toThrow("目标与当前实践工作区不一致");

    fs.mkdirSync(target, { recursive: true });
    const preflight = await new ExecutionService().preflight({
      targetType: "host_trusted", runtime: "node", executable: process.execPath,
      args: ["unused.cjs"], cwd: target, directoryGrants: [{ path: target, access: "write" }],
      networkPolicy: "disabled", confirmed: true, acknowledgeHostRisk: true
    });
    runs.create({
      targetType: "host_trusted", runtime: "node", executable: process.execPath,
      args: [path.join(target, "uncertain.cjs")], cwd: fs.realpathSync.native(target),
      directoryGrants: [{ path: target, access: "write" }], networkPolicy: "disabled",
      confirmed: true, acknowledgeHostRisk: true
    }, preflight);
    runs.recoverInterrupted();
    await expect(codeRunner.run({ runtime: "node", code: "console.log('no replay')" }, { workflowId, target }))
      .rejects.toThrow("结果不确定");
  });
});

function testNodeLookup(): PracticeRuntimeLookup {
  return {
    resolveCommand: async (command) => command === "node"
      ? { id: "cli:node", command, path: process.execPath, version: "未探测", capabilities: ["task_cli"] }
      : null
  };
}
