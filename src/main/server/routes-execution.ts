import { z } from "zod";
import { randomUUID } from "node:crypto";
import { AgentMemoryRepository } from "../ai/agent-memory-repository";
import { ExecutionPolicyError, type ExecutionRequest } from "../agent/execution-service";
import { evaluatePermission, type PermissionResult, type ToolAction } from "../agent/permission-policy";
import type { ExecutionAuthorizationRecord } from "../agent/execution-repository";
import { executionObservationInput, executionProjectQuery, executionRequestInput, executionRunParams, gitAnalyzeInput, gitSourceInput, permissionGrantInput, permissionGrantParams, permissionGrantQuery } from "./schemas";
import type { ServerContext } from "./server-context";

export function registerExecutionRoutes(ctx: ServerContext): void {
  const { server, execution, executionRuns, systemTools, permissionGrants, contentResearch } = ctx;
  const memory = new AgentMemoryRepository(ctx.database.connection);

  server.get("/api/tools/system", async () => ({ items: await systemTools.list() }));

  server.post("/api/execution/git/preflight", async (request) => {
    const input = gitSourceInput.parse(request.body);
    return execution.preflight(ctx.gitSources.toExecutionRequest(input));
  });

  server.post("/api/execution/git/clone", async (request) => {
    const input = gitSourceInput.parse(request.body);
    if (!input.confirmed) throw new ExecutionPolicyError("Git 源码取证尚未得到本次运行确认。");
    if (!input.projectId) throw new ExecutionPolicyError("Git 源码取证必须关联一个文章项目。");
    ctx.contentProjects.require(input.projectId);
    const executionRequest = ctx.gitSources.toExecutionRequest(input);
    const checks = [
      assertGitPermission(ctx, input.projectId, "write", executionRequest.cwd, "Git 目标目录", input.confirmed),
      assertGitPermission(ctx, input.projectId, "network_read", new URL(input.repositoryUrl).hostname, "Git 网络访问", input.confirmed)
    ];
    return ctx.gitSources.clone(input, undefined, toAuthorization(input.confirmed, ["write", "network_read"], checks));
  });

  server.post("/api/execution/git/analyze", async (request) => {
    const input = gitAnalyzeInput.parse(request.body);
    if (!input.confirmed) throw new ExecutionPolicyError("Git 文件分析尚未得到本次运行确认。");
    if (!input.projectId) throw new ExecutionPolicyError("Git 源码分析必须关联一个文章项目。");
    ctx.contentProjects.require(input.projectId);
    const check = assertGitPermission(ctx, input.projectId, "read", input.destination, "Git 源码目录", input.confirmed);
    return ctx.gitSources.analyze(input, undefined, toAuthorization(input.confirmed, ["read"], [check]));
  });

  server.get("/api/agent/permissions", async (request) => ({ items: permissionGrants.list(permissionGrantQuery.parse(request.query).projectId) }));

  server.post("/api/agent/permissions", async (request, reply) => {
    const input = permissionGrantInput.parse(request.body);
    return reply.code(201).send(permissionGrants.create(input));
  });

  server.delete("/api/agent/permissions/:grantId", async (request, reply) => {
    permissionGrants.remove(permissionGrantParams.parse(request.params).grantId);
    return reply.code(204).send();
  });

  server.post("/api/execution/preflight", async (request) => {
    const input = executionRequestInput.parse(request.body) as ExecutionRequest;
    return execution.preflight(input);
  });

  server.post("/api/execution/run", async (request) => {
    const input = executionRequestInput.parse(request.body) as ExecutionRequest;
    if (!input.confirmed) throw new ExecutionPolicyError("每次执行都需要重新确认目标、目录、网络和参数；已保存的授权不能代替本次确认。 ");
    const grants = permissionGrants.list(input.projectId);
    const checks = requiredPermissionChecks(input).map((check) => {
      const result = evaluatePermission({
        toolId: `execution:${input.runtime}`,
        action: check.action,
        risk: input.targetType === "host_trusted" || input.networkPolicy === "direct" ? "high" : "medium",
        projectId: input.projectId,
        target: check.target
      }, grants);
      if (result.decision === "deny") throw new ExecutionPolicyError(`当前执行的${check.label}已被权限设置拒绝：${result.reason}`);
      return { ...check, result };
    });
    const runnable = input;
    const preflight = await execution.preflight(runnable);
    if (!preflight.available) throw new ExecutionPolicyError(preflight.reason ?? "执行目标不可用。");
    const recordId = executionRuns.create(runnable, preflight, toAuthorization(Boolean(runnable.confirmed), checks.map((check) => check.action), checks.map((check) => check.result)));
    try {
      const result = await execution.run(runnable, undefined, preflight);
      const record = executionRuns.finish(recordId, result);
      try { rememberToolUse(memory, { ...record, durationMs: record.startedAt && record.finishedAt ? Math.max(0, Date.parse(record.finishedAt) - Date.parse(record.startedAt)) : 0 }); }
      catch (memoryError) { ctx.server.log.warn({ err: memoryError, executionRunId: record.id }, "Execution memory update failed after successful run"); }
      return { run: record };
    } catch (error) {
      const record = executionRuns.fail(recordId, error);
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { executionRunId: record.id });
    }
  });

  server.get("/api/execution/runs", async (request) => {
    const query = executionProjectQuery.parse(request.query);
    return { items: executionRuns.list(query.projectId) };
  });

  server.get("/api/execution/runs/:runId", async (request) => {
    const params = z.object({ runId: z.string().uuid() }).parse(request.params);
    return executionRuns.require(params.runId);
  });

  server.post("/api/execution/runs/:runId/observation", async (request, reply) => {
    const run = executionRuns.require(executionRunParams.parse(request.params).runId);
    if (run.status !== "completed") throw new ExecutionPolicyError("只有成功完成的执行记录才能保存为实验观察。");
    if (!run.projectId) throw new ExecutionPolicyError("该执行记录没有关联文章项目，不能进入资料卡。");
    const input = executionObservationInput.parse(request.body);
    const observationId = randomUUID();
    const research = contentResearch.addExecutionObservation(run.projectId, {
      observationId,
      executionRunId: run.id,
      title: input.title,
      claim: input.claim,
      artifacts: run.artifacts,
      provenance: {
        kind: "execution_observation",
        executionRunId: run.id,
        observationId,
        status: "pending",
        targetType: run.preflight.targetType,
        runtime: run.request.runtime,
        command: [run.preflight.executable, ...run.request.args],
        networkPolicy: run.request.networkPolicy,
        artifacts: run.artifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 }))
      }
    });
    return reply.code(201).send({ observationId, research });
  });
}

function requiredPermissionChecks(input: ExecutionRequest): Array<{ action: ToolAction; target: string; label: string }> {
  const checks: Array<{ action: ToolAction; target: string; label: string }> = [];
  for (const grant of input.directoryGrants) {
    checks.push({ action: grant.access, target: grant.path, label: `${grant.access === "write" ? "写入" : "读取"}目录` });
  }
  if (input.outputDirectory) checks.push({ action: "write", target: input.outputDirectory, label: "输出目录" });
  if (input.networkPolicy === "direct") checks.push({ action: "network_read", target: "direct", label: "网络访问" });
  if (input.networkPolicy === "allowlist") {
    for (const host of input.allowedHosts ?? []) checks.push({ action: "network_read", target: host, label: `网络域名 ${host}` });
  }
  for (const dependency of input.dependencies ?? []) {
    checks.push({ action: "install", target: dependency.executable, label: `依赖安装 ${dependency.executable}` });
  }
  return checks;
}

function assertGitPermission(ctx: ServerContext, projectId: string, action: ToolAction, target: string, label: string, confirmed: boolean): PermissionResult {
  const result = evaluatePermission({
    toolId: "execution:git",
    action,
    risk: "high",
    projectId,
    target
  }, ctx.permissionGrants.list(projectId));
  if (result.decision === "deny") throw new ExecutionPolicyError(`${label}已被权限设置拒绝：${result.reason}`);
  if (result.decision === "ask" && !confirmed) throw new ExecutionPolicyError(`${label}尚未获得本次确认：${result.reason}`);
  return result;
}

function toAuthorization(confirmed: boolean, actions: string[], results: PermissionResult[]): ExecutionAuthorizationRecord {
  return {
    confirmed,
    checks: results.map((result, index) => ({
      action: actions[index] ?? "unknown",
      decision: result.decision === "deny" ? "ask" : result.decision,
      reason: result.reason,
      matchedScope: result.matchedScope
    }))
  };
}

function rememberToolUse(memory: AgentMemoryRepository, run: { id: string; projectId?: string | null; request: Pick<ExecutionRequest, "runtime" | "targetType">; status: string; durationMs: number }): void {
  const scopeKey = run.projectId ? `project:${run.projectId}` : "workspace:default";
  const eventId = memory.appendEvent({ scopeKey, eventType: "tool.execution.completed", payload: { runId: run.id, runtime: run.request.runtime, targetType: run.request.targetType, status: run.status } });
  memory.addCandidate({ scopeKey, kind: "tool_experience", content: `已使用 ${run.request.runtime} 在 ${run.request.targetType} 目标执行结构化参数（耗时 ${run.durationMs}ms）；下次仍需重新确认目录与网络权限。`, sourceEventIds: [eventId], importance: 0.4 });
}
