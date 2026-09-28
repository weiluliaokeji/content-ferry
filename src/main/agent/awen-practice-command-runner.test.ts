import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openInMemoryDatabase, type AppDatabase } from "../db/database";
import { ExecutionRepository } from "./execution-repository";
import { ExecutionService } from "./execution-service";
import { AwenPracticeCodeRunner } from "./awen-practice-code-runner";
import { AwenPracticeCommandRunner, classifyPracticeCommandAction } from "./awen-practice-command-runner";
import type { SystemToolRegistry } from "./system-tool-registry";

describe("AwenPracticeCommandRunner", () => {
  let database: AppDatabase | undefined;
  let temporaryRoot: string | undefined;
  const hostNode = process.platform === "win32"
    ? execFileSync("where.exe", ["node"], { encoding: "utf8" }).split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? process.execPath
    : process.execPath;
  afterEach(() => {
    database?.close();
    database = undefined;
    if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
    vi.restoreAllMocks();
  });

  it("runs a discovered CLI with structured args in the article task workspace and records its output", async () => {
    database = openInMemoryDatabase();
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-command-test-"));
    const runs = new ExecutionRepository(database.connection);
    const execution = new ExecutionService();
    const codeRunner = new AwenPracticeCodeRunner(execution, runs, { list: async () => [] }, temporaryRoot);
    const tools = { async resolveCommand(command: string) { return command === "node" ? { id: "cli:node", command, path: hostNode, version: "test", capabilities: ["task_cli"] } : null; } } as unknown as SystemToolRegistry;
    const runner = new AwenPracticeCommandRunner(execution, runs, tools, codeRunner);
    const workflowId = "40d6ae9e-2ce0-4c6b-b51c-889a5fba2e8d";
    const input = await runner.validate({ command: "node", args: ["-e", "console.log('generic-cli-ok')"] });
    const result = await runner.run(input, {
      workflowId,
      target: runner.getTarget(undefined, workflowId, input.command, input.args),
      authorization: { confirmed: true, decisionSource: "permission_grant", checks: [{ action: "write", decision: "allow", reason: "approved for this task", matchedScope: "task" }] }
    }) as { runId: string; status: string; exitCode: number; stdout: string };

    expect(result).toMatchObject({ status: "completed", exitCode: 0, stdout: "generic-cli-ok\n" });
    expect(runs.require(result.runId).request.cwd).toBe(fs.realpathSync.native(runner.getWorkflowDirectory(undefined, workflowId)));
    expect(runs.require(result.runId).request.workflowId).toBe(workflowId);
    expect(runs.require(result.runId).request.args).toEqual(["-e", "console.log('generic-cli-ok')"]);
  });

  it("captures the complete output of a discovered Windows command launcher", async () => {
    database = openInMemoryDatabase();
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-launcher-test-"));
    const launcherPath = path.join(temporaryRoot, "packagemgr.cmd");
    fs.writeFileSync(launcherPath, "@echo off\r\necho Installed apps:\r\necho Name Version Source\r\necho example-jdk 21 java\r\n", "utf8");
    const runs = new ExecutionRepository(database.connection);
    const execution = new ExecutionService();
    const codeRunner = new AwenPracticeCodeRunner(execution, runs, { list: async () => [] }, temporaryRoot);
    const tools = { async resolveCommand(command: string) {
      return command === "packagemgr" ? { id: "cli:packagemgr", command, path: launcherPath, version: "test", capabilities: ["task_cli"] } : null;
    } } as unknown as SystemToolRegistry;
    const runner = new AwenPracticeCommandRunner(execution, runs, tools, codeRunner);
    const workflowId = "cb1bd68b-57d6-4975-a2b7-d2087e0adc4a";

    const output = await runner.run({ command: "packagemgr", args: ["list"] }, {
      workflowId,
      target: runner.getTarget(undefined, workflowId, "packagemgr", ["list"])
    }) as { status: string; exitCode: number; stdout: string; resolvedCommandPath: string };

    expect(output).toMatchObject({ status: "completed", exitCode: 0, resolvedCommandPath: launcherPath });
    expect(output.stdout).toContain("example-jdk 21 java");
  });

  it("does not accept shell strings, executable paths, or command interpreters", async () => {
    const resolveCommand = vi.fn(async () => null);
    const runner = new AwenPracticeCommandRunner({} as ExecutionService, {} as ExecutionRepository, { resolveCommand } as unknown as SystemToolRegistry, {} as AwenPracticeCodeRunner);

    expect(() => runner.parseInput({ command: "node -e console.log(1)", args: [] })).toThrow("不能填写路径或整段命令文本");
    expect(() => runner.parseInput({ command: "C:\\Tools\\java.exe", args: ["-version"] })).toThrow("不能填写路径或整段命令文本");
    expect(() => runner.parseInput({ command: "powershell", args: ["-Command", "..."] })).toThrow("不能启动命令解释器");
    expect(resolveCommand).not.toHaveBeenCalled();
  });

  it("rejects batch arguments that could become command syntax", async () => {
    const tools = { async resolveCommand(command: string) {
      return { id: `cli:${command}`, command, path: "C:\\Tools\\packagemgr.cmd", version: "test", capabilities: ["task_cli"] };
    } } as unknown as SystemToolRegistry;
    const runner = new AwenPracticeCommandRunner({} as ExecutionService, {} as ExecutionRepository, tools, {} as AwenPracticeCodeRunner);

    await expect(runner.validate({ command: "packagemgr", args: ["list", "& remove"] })).rejects.toThrow("批处理入口");
  });

  it("distinguishes read-only queries from state-changing CLI operations", () => {
    expect(classifyPracticeCommandAction({ command: "scoop", args: ["list"] })).toBe("read");
    expect(classifyPracticeCommandAction({ command: "scoop", args: ["bucket", "list"] })).toBe("read");
    expect(classifyPracticeCommandAction({ command: "nvm", args: ["list"] })).toBe("read");
    expect(classifyPracticeCommandAction({ command: "scoop", args: ["install", "java"] })).toBe("install");
    expect(classifyPracticeCommandAction({ command: "scoop", args: ["uninstall", "java"] })).toBe("delete");
    expect(classifyPracticeCommandAction({ command: "scoop", args: ["reset", "java"] })).toBe("write");
    expect(classifyPracticeCommandAction({ command: "scoop", args: ["search", "install"] })).toBe("read");
    expect(classifyPracticeCommandAction({ command: "git", args: ["push", "origin"] })).toBe("publish");
    expect(classifyPracticeCommandAction({ command: "scoop", args: ["search", "java"] })).toBe("read");
  });

  it("binds a command grant to task, command, risk category, and operation scope", () => {
    database = openInMemoryDatabase();
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-command-target-test-"));
    const runner = new AwenPracticeCommandRunner({} as ExecutionService, {} as ExecutionRepository, {} as SystemToolRegistry,
      new AwenPracticeCodeRunner({} as ExecutionService, {} as ExecutionRepository, { list: async () => [] }, temporaryRoot));
    const workflowId = "40d6ae9e-2ce0-4c6b-b51c-889a5fba2e8d";
    const approvedTarget = runner.getTarget("project-id", workflowId, "scoop", ["list", "java"]);

    expect(runner.matchesCommandTarget(approvedTarget, "scoop", ["list", "java"])).toBe(true);
    expect(runner.matchesCommandTarget(approvedTarget, "scoop", ["list", "nodejs"])).toBe(true);
    expect(runner.matchesCommandTarget(approvedTarget, "scoop", ["list", "install"])).toBe(true);
    expect(runner.matchesCommandTarget(approvedTarget, "scoop", ["reset", "java"])).toBe(false);
    expect(runner.getTarget("project-id", workflowId, "scoop", ["reset", "java"]))
      .toBe(runner.getTarget("project-id", workflowId, "scoop", ["reset", "groovy"]));
    expect(runner.getTarget("project-id", workflowId, "scoop", ["bucket", "list"]))
      .not.toBe(runner.getTarget("project-id", workflowId, "scoop", ["bucket", "add", "java"]));
  });
});
