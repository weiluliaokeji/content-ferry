import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ExecutionPolicyError, type ExecutionService } from "./execution-service";
import type { ExecutionRepository } from "./execution-repository";
import type { ToolExecutionContext } from "./tool-runner";
import type { SystemToolRegistry } from "./system-tool-registry";
import type { AwenPracticeCodeRunner } from "./awen-practice-code-runner";

export interface AwenPracticeCommandInput {
  command: string;
  args: string[];
}

const BLOCKED_COMMANDS = new Set([
  "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "bash", "bash.exe", "sh", "wsl", "wsl.exe",
  "cscript", "cscript.exe", "wscript", "wscript.exe", "mshta", "mshta.exe", "rundll32", "rundll32.exe", "regsvr32", "regsvr32.exe"
]);

const POWERSHELL_DISPATCHER = [
  "param([Parameter(Mandatory=$true)][string]$RequestPath)",
  "$ErrorActionPreference = 'Stop'",
  "$request = Get-Content -Raw -LiteralPath $RequestPath | ConvertFrom-Json",
  "$programArgs = [string[]]$request.args",
  "& $request.executable @programArgs",
  "if ($null -eq $LASTEXITCODE) { exit 0 }",
  "exit $LASTEXITCODE"
].join("\r\n");

/** Runs an installed CLI selected by goal, passing arguments as an array without a shell command string. */
export class AwenPracticeCommandRunner {
  constructor(
    private readonly execution: ExecutionService,
    private readonly runs: ExecutionRepository,
    private readonly tools: SystemToolRegistry,
    private readonly codeRunner: Pick<AwenPracticeCodeRunner, "getWorkflowDirectory">,
    private readonly powershellPath = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  ) {}

  getWorkflowDirectory(projectId: string | undefined, workflowId: string): string {
    return this.codeRunner.getWorkflowDirectory(projectId, workflowId);
  }

  getTarget(projectId: string | undefined, workflowId: string, command: string, args: string[]): string {
    const action = classifyPracticeCommandAction({ command, args });
    const operation = getOperationScope(args);
    const scopeFingerprint = createHash("sha256").update(`${action}:${operation}`).digest("hex");
    return `system-cli:${command.toLowerCase()}@${scopeFingerprint}@${this.getWorkflowDirectory(projectId, workflowId)}`;
  }

  matchesCommandTarget(target: string | undefined, command: string, args: string[]): boolean {
    const action = classifyPracticeCommandAction({ command, args });
    const operation = getOperationScope(args);
    const scopeFingerprint = createHash("sha256").update(`${action}:${operation}`).digest("hex");
    return typeof target === "string" && target.startsWith(`system-cli:${command.toLowerCase()}@${scopeFingerprint}@`);
  }

  matchesCommandScope(target: string | undefined, command: string, projectId: string | undefined, workflowId: string): boolean {
    const prefix = `system-cli:${command.toLowerCase()}@`;
    const suffix = `@${this.getWorkflowDirectory(projectId, workflowId)}`;
    if (typeof target !== "string" || !target.startsWith(prefix) || !target.endsWith(suffix)) return false;
    return /^[a-f0-9]{64}$/iu.test(target.slice(prefix.length, -suffix.length));
  }

  parseInput(input: unknown): AwenPracticeCommandInput {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new ExecutionPolicyError("本机工具请求必须是结构化对象。");
    const record = input as Record<string, unknown>;
    if (typeof record.command !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(record.command)) throw new ExecutionPolicyError("请指定一个工具名称，不能填写路径或整段命令文本。");
    if (BLOCKED_COMMANDS.has(record.command.toLowerCase())) throw new ExecutionPolicyError("通用工具不能启动命令解释器；请描述要完成的目标，让阿文调用具体工具或代码运行能力。");
    if (!Array.isArray(record.args) || record.args.length > 64 || record.args.some((arg) => typeof arg !== "string" || arg.length > 4000)) throw new ExecutionPolicyError("工具参数必须是最多 64 项的独立文本参数。");
    return { command: record.command, args: [...record.args] as string[] };
  }

  async validate(input: unknown): Promise<AwenPracticeCommandInput> {
    const parsed = this.parseInput(input);
    const tool = await this.tools.resolveCommand(parsed.command);
    if (!tool) throw new ExecutionPolicyError(`本机没有找到“${parsed.command}”这个可执行工具；没有运行命令。`);
    assertSafeLauncherArguments(tool.path, parsed.args);
    return parsed;
  }

  async run(input: AwenPracticeCommandInput, context: ToolExecutionContext): Promise<unknown> {
    if (!context.workflowId) throw new ExecutionPolicyError("本机工具实践必须关联当前阿文工作流。");
    const directory = this.getWorkflowDirectory(context.projectId, context.workflowId);
    if (context.target !== this.getTarget(context.projectId, context.workflowId, input.command, input.args)) throw new ExecutionPolicyError("本机工具目标与本次授权的软件、参数或实践任务不一致。");
    fs.mkdirSync(directory, { recursive: true });
    const canonicalDirectory = fs.realpathSync.native(directory);
    const interrupted = this.runs.list(context.projectId).find((run) => run.request.cwd === canonicalDirectory && run.status === "interrupted");
    if (interrupted) throw new ExecutionPolicyError(`发现上次实践运行 ${interrupted.id} 中断且结果不确定。请先核对该次运行，再决定是否重试。`);

    const tool = await this.tools.resolveCommand(input.command);
    if (!tool) throw new ExecutionPolicyError(`本机没有找到“${input.command}”这个可执行工具；没有运行命令。`);
    assertSafeLauncherArguments(tool.path, input.args);
    const invocation = await createInvocation(tool.path, input.args, this.powershellPath);
    const request = {
      projectId: context.projectId,
      workflowId: context.workflowId,
      practiceTaskId: context.practiceTaskId,
      targetType: "host_trusted" as const,
      runtime: "custom" as const,
      executable: invocation.executable,
      args: invocation.args,
      cwd: canonicalDirectory,
      directoryGrants: [{ path: canonicalDirectory, access: "write" as const }],
      networkPolicy: "direct" as const,
      outputDirectory: canonicalDirectory,
      timeoutMs: 120_000,
      outputLimitBytes: 256 * 1024,
      terminal: true,
      confirmed: true,
      acknowledgeHostRisk: true
    };
    const preflight = await this.execution.preflight(request);
    if (!preflight.available) throw new ExecutionPolicyError(preflight.reason ?? "本机工具运行环境不可用。");
    const runId = this.runs.create(request, preflight, context.authorization ?? null);
    try {
      const result = await this.execution.run(request, context.signal, preflight);
      const run = this.runs.finish(runId, result);
      return {
        runId,
        command: input.command,
        executableName: path.basename(tool.path),
        resolvedCommandPath: tool.path,
        status: run.status,
        exitCode: run.exitCode,
        stdout: run.stdout.slice(0, 16_000),
        stderr: run.stderr.slice(0, 8_000),
        truncated: run.truncated,
        observationWarnings: [
          ...(run.stderr.trim() ? ["命令有标准错误输出，请核对结果是否完整。"] : []),
          ...(!run.stdout.trim() && !run.stderr.trim() ? ["命令没有返回文本；不能据此推断目标集合为空。"] : []),
          ...(run.truncated ? ["工具输出已截断，不能据此统计完整集合。"] : [])
        ],
        warnings: preflight.warnings,
        artifacts: run.artifacts.map(({ path: artifactPath, size, sha256 }) => ({ path: artifactPath, size, sha256 }))
      };
    } catch (error) {
      const failed = this.runs.fail(runId, error);
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { executionRunId: failed.id });
    } finally {
      invocation.cleanup?.();
    }
  }
}

function assertSafeLauncherArguments(program: string, args: string[]): void {
  if (![".cmd", ".bat"].includes(path.extname(program).toLowerCase())) return;
  // Batch launchers commonly expand %* and delayed !variables! internally.
  // Keep each model-provided argument from becoming additional cmd syntax.
  if (args.some((arg) => /[\r\n&|<>^%!"]/u.test(arg))) {
    throw new ExecutionPolicyError("此工具的批处理入口不接受命令连接符、变量展开或引号参数；请换用安全的独立参数或其他工具入口。");
  }
}

export function classifyPracticeCommandAction(input: AwenPracticeCommandInput): "read" | "write" | "install" | "delete" | "external_write" | "publish" {
  return getOperationDetails(input.args).action;
}

const OPERATION_ACTIONS: Record<string, "read" | "write" | "install" | "delete" | "external_write" | "publish"> = {
  uninstall: "delete", remove: "delete", delete: "delete", rm: "delete", prune: "delete", clean: "delete",
  publish: "publish", deploy: "publish", push: "publish", submit: "publish", send: "publish",
  post: "external_write", upload: "external_write", release: "external_write",
  install: "install", update: "install", upgrade: "install", sync: "install",
  add: "write", reset: "write", switch: "write", use: "write", create: "write", configure: "write", config: "write", set: "write", enable: "write", disable: "write",
  list: "read", ls: "read", search: "read", find: "read", info: "read", show: "read", status: "read", version: "read", query: "read", get: "read", which: "read", where: "read", help: "read", inspect: "read", check: "read"
};

function getOperationDetails(args: string[]): { action: "read" | "write" | "install" | "delete" | "external_write" | "publish"; scope: string } {
  const positional = args.filter((argument) => !argument.startsWith("-")).slice(0, 3).map((argument) => argument.toLowerCase());
  const operationIndex = positional.findIndex((token) => Object.hasOwn(OPERATION_ACTIONS, token));
  if (operationIndex >= 0) {
    return { action: OPERATION_ACTIONS[positional[operationIndex]!]!, scope: positional.slice(0, operationIndex + 1).join(":") };
  }
  return { action: "write", scope: positional[0] ?? "default" };
}

function getOperationScope(args: string[]): string {
  return getOperationDetails(args).scope;
}

async function createInvocation(program: string, args: string[], powershellPath: string): Promise<{ executable: string; args: string[]; cleanup?: () => void }> {
  const extension = path.extname(program).toLowerCase();
  if (extension === ".exe" || extension === ".com") return { executable: program, args };
  if (!fs.existsSync(powershellPath)) throw new ExecutionPolicyError("此 Windows 环境缺少 PowerShell，无法安全启动该工具入口。");
  if (extension === ".ps1") return { executable: powershellPath, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File", program, ...args] };
  if (extension !== ".cmd" && extension !== ".bat") throw new ExecutionPolicyError("通用工具暂不支持这种脚本入口格式。");

  const controlDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-cli-"));
  const requestPath = path.join(controlDirectory, "request.json");
  const dispatcherPath = path.join(controlDirectory, "dispatch.ps1");
  fs.writeFileSync(requestPath, JSON.stringify({ executable: program, args }), { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.writeFileSync(dispatcherPath, POWERSHELL_DISPATCHER, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return {
    executable: powershellPath,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File", dispatcherPath, requestPath],
    cleanup: () => fs.rmSync(controlDirectory, { recursive: true, force: true })
  };
}
