import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolExecutionContext } from "./tool-runner";
import type { ExecutionService, ExecutionRuntime } from "./execution-service";
import { ExecutionPolicyError } from "./execution-service";
import type { ExecutionRepository } from "./execution-repository";
import type { SystemToolDescriptor } from "./system-tool-registry";

export interface AwenPracticeCodeInput {
  runtime: "python" | "node";
  code: string;
}

export interface PracticeRuntimeLookup {
  resolveCommand(command: string): Promise<SystemToolDescriptor | null>;
}

/** Runs only after ToolRunner has evaluated and, when needed, received permission. */
export class AwenPracticeCodeRunner {
  constructor(
    private readonly execution: ExecutionService,
    private readonly runs: ExecutionRepository,
    private readonly systemTools: PracticeRuntimeLookup,
    private readonly root = path.join(os.tmpdir(), "contentferry-practice")
  ) {}

  getWorkflowDirectory(projectId: string | undefined, workflowId: string): string {
    if (!/^[0-9a-f-]{36}$/iu.test(workflowId)) throw new ExecutionPolicyError("实践工作流标识不正确。");
    const projectSegment = projectId && /^[0-9a-f-]{36}$/iu.test(projectId) ? projectId : "unlinked";
    return path.join(path.resolve(this.root), projectSegment, workflowId);
  }

  async run(input: AwenPracticeCodeInput, context: ToolExecutionContext): Promise<unknown> {
    if (!context.workflowId) throw new ExecutionPolicyError("代码实践必须关联当前阿文工作流。");
    const directory = this.getWorkflowDirectory(context.projectId, context.workflowId);
    if (!context.target || path.resolve(context.target) !== directory) throw new ExecutionPolicyError("代码运行目标与当前实践工作区不一致。");
    if (input.code.trim().length === 0 || input.code.length > 40_000) throw new ExecutionPolicyError("示例代码必须在 1 到 40000 个字符之间。");

    assertNoSymlinkAncestors(path.resolve(this.root));
    fs.mkdirSync(directory, { recursive: true });
    assertNoSymlinkAncestors(directory);
    const canonicalDirectory = fs.realpathSync.native(directory);
    const canonicalRoot = fs.realpathSync.native(path.resolve(this.root));
    if (!isPathInside(canonicalRoot, canonicalDirectory)) throw new ExecutionPolicyError("实践工作目录越过了文渡临时工作区。");

    const interrupted = this.runs.list(context.projectId).find((run) => run.request.cwd === canonicalDirectory && run.status === "interrupted");
    if (interrupted) throw new ExecutionPolicyError(`发现上次实践运行 ${interrupted.id} 中断且结果不确定。请先核对该次运行，再决定是否重试。`);

    const runtimeTool = await this.findRuntime(input.runtime);
    const extension = input.runtime === "python" ? ".py" : ".cjs";
    const sourcePath = path.join(canonicalDirectory, `attempt-${randomUUID()}${extension}`);
    fs.writeFileSync(sourcePath, input.code, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const request = {
      projectId: context.projectId,
      workflowId: context.workflowId,
      practiceTaskId: context.practiceTaskId,
      targetType: "host_trusted" as const,
      runtime: input.runtime as ExecutionRuntime,
      executable: runtimeTool.path,
      args: [sourcePath],
      cwd: canonicalDirectory,
      directoryGrants: [{ path: canonicalDirectory, access: "write" as const }],
      networkPolicy: "disabled" as const,
      outputDirectory: canonicalDirectory,
      timeoutMs: 120_000,
      outputLimitBytes: 256 * 1024,
      confirmed: true,
      acknowledgeHostRisk: true
    };

    const preflight = await this.execution.preflight(request);
    if (!preflight.available) throw new ExecutionPolicyError(preflight.reason ?? "示例运行环境不可用。");
    const runId = this.runs.create(request, preflight, context.authorization ?? null);
    try {
      const result = await this.execution.run(request, context.signal, preflight);
      const run = this.runs.finish(runId, result);
      return {
        runId,
        runtime: input.runtime,
        runtimeVersion: runtimeTool.version.slice(0, 80),
        status: run.status,
        exitCode: run.exitCode,
        stdout: run.stdout.slice(0, 16_000),
        stderr: run.stderr.slice(0, 8_000),
        truncated: run.truncated,
        warnings: preflight.warnings,
        artifacts: run.artifacts.map(({ path: artifactPath, size, sha256 }) => ({ path: artifactPath, size, sha256 }))
      };
    } catch (error) {
      const failed = this.runs.fail(runId, error);
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { executionRunId: failed.id });
    }
  }

  private async findRuntime(runtime: AwenPracticeCodeInput["runtime"]): Promise<SystemToolDescriptor> {
    const tool = await this.systemTools.resolveCommand(runtime);
    if (tool) return tool;
    // Tests run Electron with ELECTRON_RUN_AS_NODE=1, where process.execPath is a
    // usable Node/Python runtime. Fall back to it when the system tool can't be
    // located so the practice runner still executes under the test harness.
    if (process.env.ELECTRON_RUN_AS_NODE === "1") {
      return { id: `cli:${runtime}`, command: runtime, path: process.execPath, version: "未探测", capabilities: ["task_cli"] };
    }
    throw new ExecutionPolicyError(`没有找到已安装的 ${runtime === "python" ? "Python" : "Node.js"}，阿文不会自动安装依赖。`);
  }
}

function assertNoSymlinkAncestors(target: string): void {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  let current = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new ExecutionPolicyError(`实践目录不能经过符号链接或 junction：${current}`);
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
