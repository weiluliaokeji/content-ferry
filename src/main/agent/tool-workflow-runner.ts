import { randomUUID } from "node:crypto";
import type { PermissionDecision, PermissionScope, ToolAction, ToolRisk, ToolPermissionGrant, ToolPermissionRequest } from "./permission-policy";
import { ToolRunner, type ToolRunResult } from "./tool-runner";

export type ToolWorkflowStatus = "queued" | "planning" | "running" | "waiting_user" | "replanning" | "completed" | "completed_with_warnings" | "failed" | "cancel_requested" | "cancelled" | "interrupted";
export type ToolWorkflowEventType = "workflow_created" | "model_round_started" | "model_output_repair_requested" | "permission_requested" | "permission_decided" | "tool_started" | "tool_completed" | "tool_denied" | "tool_failed" | "workflow_completed" | "workflow_failed" | "workflow_cancel_requested" | "workflow_cancelled" | "workflow_interrupted";

export interface ModelToolRequest {
  toolId: string;
  action: ToolAction;
  target?: string;
  input: unknown;
}

export type ModelTurn =
  | { kind: "tool_calls"; calls: ModelToolRequest[] }
  | { kind: "final"; text: string };

export interface ToolWorkflowModelInput {
  workflowId: string;
  round: number;
  userRequest: string;
  transcript: ToolWorkflowMessage[];
}

export interface ToolWorkflowModel {
  next(input: ToolWorkflowModelInput): Promise<unknown>;
}

export interface ToolWorkflowMessage {
  role: "user" | "assistant" | "tool";
  content: string;
}

export interface ToolWorkflowEvent {
  id: string;
  type: ToolWorkflowEventType;
  at: string;
  callId?: string;
  toolId?: string;
  message: string;
  data?: Record<string, string | number | boolean | null>;
}

export interface ToolWorkflowToolResult {
  callId: string;
  toolId: string;
  output: unknown;
}

export interface ToolWorkflowPolicy {
  projectId?: string;
  workspaceId?: string;
  grants: ToolPermissionGrant[];
  defaultAllowReadOnly: boolean;
  resolveRisk(request: ModelToolRequest): ToolRisk;
}

export interface ToolWorkflowOptions {
  maxRounds?: number;
  maxCallsPerRound?: number;
  maxRetainedWorkflows?: number;
}

export interface ToolWorkflowPermissionRequest {
  callId: string;
  request: ModelToolRequest;
  permission: {
    decision: PermissionDecision;
    reason: string;
    matchedScope: PermissionScope | null;
  };
}

export interface ToolWorkflowSnapshot {
  workflowId: string;
  status: ToolWorkflowStatus;
  round: number;
  userRequest: string;
  transcript: ToolWorkflowMessage[];
  events: ToolWorkflowEvent[];
  toolResults: ToolWorkflowToolResult[];
  pendingPermission: ToolWorkflowPermissionRequest | null;
  finalText: string | null;
  warningCount: number;
}

interface WorkflowState extends ToolWorkflowSnapshot {
  policy: ToolWorkflowPolicy;
  busy: boolean;
  cancelRequested: boolean;
  controller: AbortController;
  activeAdvance?: Promise<ToolWorkflowSnapshot>;
}

export type PermissionResponse =
  | { decision: "allow"; scope: Exclude<PermissionScope, "global">; expiresAt?: string }
  | { decision: "deny" };

const FORBIDDEN_MODEL_FIELDS = new Set(["confirmed", "permission", "permissions", "grant", "grants", "lease", "authorization", "authorized", "approval"]);
const DEFAULT_MAX_ROUNDS = 8;
const DEFAULT_MAX_CALLS_PER_ROUND = 8;
const MAX_TOOL_TRANSCRIPT_CHARS = 12_000;

/**
 * Application-side orchestration seam. The model can request tools and produce
 * text, but it cannot grant itself permission or bypass ToolRunner.
 */
export class ToolWorkflowRunner {
  private readonly workflows = new Map<string, WorkflowState>();
  private readonly maxRounds: number;
  private readonly maxCallsPerRound: number;
  private readonly maxRetainedWorkflows: number;

  constructor(private readonly toolRunner: ToolRunner, private readonly model: ToolWorkflowModel, options: ToolWorkflowOptions = {}) {
    this.maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
    this.maxCallsPerRound = options.maxCallsPerRound ?? DEFAULT_MAX_CALLS_PER_ROUND;
    this.maxRetainedWorkflows = options.maxRetainedWorkflows ?? 100;
  }

  async start(userRequest: string, policy: ToolWorkflowPolicy): Promise<ToolWorkflowSnapshot> {
    const workflowId = randomUUID();
    const state: WorkflowState = {
      workflowId,
      status: "queued",
      round: 0,
      userRequest,
      transcript: [{ role: "user", content: userRequest }],
      events: [],
      toolResults: [],
      pendingPermission: null,
      finalText: null,
      warningCount: 0,
      policy,
      busy: true,
      cancelRequested: false,
      controller: new AbortController()
    };
    this.workflows.set(workflowId, state);
    this.pruneRetainedWorkflows();
    this.addEvent(state, "workflow_created", "已创建工具工作流。", { workflowId });
    const activeAdvance = this.advance(state);
    state.activeAdvance = activeAdvance;
    try {
      return await activeAdvance;
    } finally {
      state.activeAdvance = undefined;
      state.busy = false;
    }
  }

  async respondToPermission(workflowId: string, response: PermissionResponse): Promise<ToolWorkflowSnapshot> {
    const state = this.requireWorkflow(workflowId);
    if (state.busy) throw new Error("当前工作流正在推进，请等待本轮结果。" );
    if (state.cancelRequested || state.status === "cancel_requested" || state.status === "cancelled") throw new Error("当前工作流已取消，不能继续授权。" );
    const pending = state.pendingPermission;
    if (state.status !== "waiting_user" || !pending) throw new Error("当前工作流没有等待处理的授权请求。" );

    state.busy = true;
    try {
      state.pendingPermission = null;
      this.addEvent(state, "permission_decided", response.decision === "allow" ? "用户已授权本次工具调用。" : "用户拒绝了本次工具调用。", { decision: response.decision, scope: response.decision === "allow" ? response.scope : null });
      if (response.decision === "allow") {
        const grant: ToolPermissionGrant = { scope: response.scope, decision: "allow", toolId: pending.request.toolId, action: pending.request.action, projectId: state.policy.projectId, targetPrefix: pending.request.target, expiresAt: response.expiresAt };
        if (response.scope !== "run") state.policy = { ...state.policy, grants: [grant, ...state.policy.grants] };
        const activeAdvance = response.scope === "run"
          ? this.advance(state, pending, grant)
          : this.advance(state, pending);
        state.activeAdvance = activeAdvance;
        return await activeAdvance;
      }

      state.warningCount += 1;
      state.status = "replanning";
      state.transcript.push({ role: "tool", content: `${pending.request.toolId}：用户拒绝执行；请在不执行该操作的前提下重新规划。` });
      const activeAdvance = this.advance(state);
      state.activeAdvance = activeAdvance;
      return await activeAdvance;
    } finally {
      state.activeAdvance = undefined;
      state.busy = false;
    }
  }

  restoreWaiting(snapshot: ToolWorkflowSnapshot, policy: ToolWorkflowPolicy): ToolWorkflowSnapshot {
    if (snapshot.status !== "interrupted" || !snapshot.pendingPermission) {
      throw new Error("只有带待授权调用的中断工作流才能安全恢复；其他工作流必须重新规划。" );
    }
    if (this.workflows.has(snapshot.workflowId)) return this.getSnapshot(snapshot.workflowId);
    const restored = structuredClone(snapshot);
    restored.status = "waiting_user";
    const state: WorkflowState = {
      ...restored,
      policy,
      busy: false,
      cancelRequested: false,
      controller: new AbortController()
    };
    this.workflows.set(state.workflowId, state);
    this.pruneRetainedWorkflows();
    this.addEvent(state, "permission_requested", "应用重启后恢复待授权调用，仍需重新确认。", { recovered: true });
    return this.cloneSnapshot(state);
  }

  async resumeInterrupted(snapshot: ToolWorkflowSnapshot, policy: ToolWorkflowPolicy): Promise<ToolWorkflowSnapshot> {
    if (snapshot.status !== "interrupted" || snapshot.pendingPermission) {
      throw new Error("只有没有待授权调用的中断工作流才能重新规划。带待授权调用的工作流必须先恢复授权。" );
    }
    if (this.workflows.has(snapshot.workflowId)) return this.getSnapshot(snapshot.workflowId);
    const restored = structuredClone(snapshot);
    restored.status = "replanning";
    const state: WorkflowState = {
      ...restored,
      policy,
      busy: true,
      cancelRequested: false,
      controller: new AbortController()
    };
    this.workflows.set(state.workflowId, state);
    this.pruneRetainedWorkflows();
    this.addEvent(state, "workflow_interrupted", "应用重启后由用户重新规划；不会重放之前未确认的工具调用。", { recovered: true });
    const activeAdvance = this.advance(state);
    state.activeAdvance = activeAdvance;
    try {
      return await activeAdvance;
    } finally {
      state.activeAdvance = undefined;
      state.busy = false;
    }
  }

  async waitForSettled(workflowId: string): Promise<ToolWorkflowSnapshot> {
    const state = this.requireWorkflow(workflowId);
    return state.activeAdvance ? await state.activeAdvance : this.cloneSnapshot(state);
  }

  cancel(workflowId: string): ToolWorkflowSnapshot {
    const state = this.requireWorkflow(workflowId);
    if (state.status === "completed" || state.status === "completed_with_warnings" || state.status === "failed" || state.status === "cancelled") return this.cloneSnapshot(state);
    state.cancelRequested = true;
    state.status = "cancel_requested";
    state.controller.abort();
    this.addEvent(state, "workflow_cancel_requested", "已请求取消工具工作流。", { workflowId });
    if (!state.busy) this.markCancelled(state);
    return this.cloneSnapshot(state);
  }

  getSnapshot(workflowId: string): ToolWorkflowSnapshot {
    return this.cloneSnapshot(this.requireWorkflow(workflowId));
  }

  recordModelOutputRepair(workflowId: string, message: string, attempt: number): void {
    const state = this.requireWorkflow(workflowId);
    this.addEvent(state, "model_output_repair_requested", message, { attempt });
  }

  private async advance(state: WorkflowState, approvedCall?: ToolWorkflowPermissionRequest, temporaryGrant?: ToolPermissionGrant): Promise<ToolWorkflowSnapshot> {
    if (state.cancelRequested) return this.markCancelled(state);
    if (approvedCall) {
      const result = await this.runCall(state, approvedCall.callId, approvedCall.request, temporaryGrant ? [temporaryGrant] : []);
      if (state.cancelRequested) return this.markCancelled(state);
      if (result.status === "waiting_user") return this.cloneSnapshot(state);
      if (result.status === "denied") {
        state.warningCount += 1;
        state.status = "replanning";
      }
      if (result.status === "failed") state.warningCount += 1;
    }

    while (state.round < this.maxRounds && !state.finalText && !state.pendingPermission) {
      state.round += 1;
      state.status = state.status === "replanning" ? "replanning" : "planning";
      this.addEvent(state, "model_round_started", `开始第 ${state.round} 轮模型规划。`, { round: state.round });
      let turn: ModelTurn;
      try {
        turn = parseModelTurn(await this.model.next({ workflowId: state.workflowId, round: state.round, userRequest: state.userRequest, transcript: [...state.transcript] }));
      } catch (error) {
        if (state.cancelRequested) return this.markCancelled(state);
        state.status = "failed";
        this.addEvent(state, "workflow_failed", error instanceof Error ? error.message : String(error));
        return this.cloneSnapshot(state);
      }

      if (state.cancelRequested) return this.markCancelled(state);

      if (turn.kind === "final") {
        state.finalText = turn.text;
        state.transcript.push({ role: "assistant", content: turn.text });
        state.status = state.warningCount > 0 ? "completed_with_warnings" : "completed";
        this.addEvent(state, "workflow_completed", state.status === "completed" ? "工具工作流已完成。" : "工具工作流完成，但包含需要注意的结果。", { warningCount: state.warningCount });
        return this.cloneSnapshot(state);
      }

      if (turn.calls.length === 0) {
        state.status = "failed";
        this.addEvent(state, "workflow_failed", "模型返回了空工具计划。" );
        return this.cloneSnapshot(state);
      }
      if (turn.calls.length > this.maxCallsPerRound) {
        state.status = "failed";
        this.addEvent(state, "workflow_failed", `单轮工具调用超过上限 ${this.maxCallsPerRound}。`);
        return this.cloneSnapshot(state);
      }

      state.status = "running";
      for (const request of turn.calls) {
        const callId = randomUUID();
        const result = await this.runCall(state, callId, request);
        if (state.cancelRequested) return this.markCancelled(state);
        if (result.status === "waiting_user") return this.cloneSnapshot(state);
        if (result.status === "denied") {
          state.warningCount += 1;
          state.status = "replanning";
          break;
        }
        if (result.status === "failed") state.warningCount += 1;
      }
    }

    if (state.cancelRequested) return this.markCancelled(state);
    if (state.pendingPermission) return this.cloneSnapshot(state);
    if (!state.finalText && state.status !== "failed") {
      state.status = "failed";
      this.addEvent(state, "workflow_failed", `模型回合超过上限 ${this.maxRounds}。`);
    }
    return this.cloneSnapshot(state);
  }

  private async runCall(state: WorkflowState, callId: string, request: ModelToolRequest, extraGrants: ToolPermissionGrant[] = []): Promise<ToolRunResult> {
    const invocation: ToolPermissionRequest & { input: unknown } = {
      ...request,
      projectId: state.policy.projectId,
      risk: state.policy.resolveRisk(request),
      defaultAllow: state.policy.defaultAllowReadOnly
    };
    this.addEvent(state, "tool_started", `准备执行 ${request.toolId}。`, { callId, toolId: request.toolId, target: request.target ?? null });
    const result = await this.toolRunner.run(invocation, [...extraGrants, ...state.policy.grants], { signal: state.controller.signal, projectId: state.policy.projectId, workspaceId: state.policy.workspaceId });
    if (result.status === "waiting_user") {
      state.status = "waiting_user";
      state.pendingPermission = { callId, request, permission: result.permission };
      this.addEvent(state, "permission_requested", result.permission.reason, { callId, toolId: request.toolId, target: request.target ?? null });
      return result;
    }
    if (result.status === "completed") {
      state.transcript.push({ role: "tool", content: formatToolContent(request.toolId, result.output) });
      state.toolResults.push({ callId, toolId: request.toolId, output: cloneUnknown(result.output) });
      this.addEvent(state, "tool_completed", `${request.toolId} 已完成。`, { callId, toolId: request.toolId });
      return result;
    }
    if (result.status === "denied") {
      state.transcript.push({ role: "tool", content: `${request.toolId}：策略拒绝执行；请重新规划替代方案。` });
      this.addEvent(state, "tool_denied", result.permission.reason, { callId, toolId: request.toolId });
      return result;
    }
    state.transcript.push({ role: "tool", content: `${request.toolId}：执行失败：${result.error}` });
    this.addEvent(state, "tool_failed", result.error, { callId, toolId: request.toolId });
    return result;
  }

  private addEvent(state: WorkflowState, type: ToolWorkflowEventType, message: string, data?: Record<string, string | number | boolean | null>): void {
    state.events.push({ id: randomUUID(), type, at: new Date().toISOString(), message, data });
  }

  private markCancelled(state: WorkflowState): ToolWorkflowSnapshot {
    state.pendingPermission = null;
    state.status = "cancelled";
    if (!state.events.some((event) => event.type === "workflow_cancelled")) this.addEvent(state, "workflow_cancelled", "工具工作流已取消。", { workflowId: state.workflowId });
    return this.cloneSnapshot(state);
  }

  private requireWorkflow(workflowId: string): WorkflowState {
    const state = this.workflows.get(workflowId);
    if (!state) throw new Error(`找不到工具工作流：${workflowId}`);
    return state;
  }

  private pruneRetainedWorkflows(): void {
    if (this.workflows.size <= this.maxRetainedWorkflows) return;
    for (const [workflowId, state] of this.workflows) {
      if (this.workflows.size <= this.maxRetainedWorkflows) break;
      if (state.busy || !isTerminalStatus(state.status)) continue;
      this.workflows.delete(workflowId);
    }
  }

  private cloneSnapshot(state: WorkflowState): ToolWorkflowSnapshot {
    return {
      workflowId: state.workflowId,
      status: state.status,
      round: state.round,
      userRequest: state.userRequest,
      transcript: state.transcript.map((message) => ({ ...message })),
      events: state.events.map((event) => ({ ...event, data: event.data ? { ...event.data } : undefined })),
      toolResults: state.toolResults.map((result) => ({ ...result, output: cloneUnknown(result.output) })),
      pendingPermission: state.pendingPermission ? { ...state.pendingPermission, request: { ...state.pendingPermission.request, input: cloneUnknown(state.pendingPermission.request.input) }, permission: { ...state.pendingPermission.permission } } : null,
      finalText: state.finalText,
      warningCount: state.warningCount
    };
  }
}

function isTerminalStatus(status: ToolWorkflowStatus): boolean {
  return status === "completed" || status === "completed_with_warnings" || status === "failed" || status === "cancelled";
}

export function parseModelTurn(value: unknown): ModelTurn {
  if (!isRecord(value)) throw new Error("模型工具回合必须是对象。" );
  rejectForbiddenFields(value);
  if (value.kind === "final") {
    if (typeof value.text !== "string") throw new Error("模型最终回复缺少文本。" );
    return { kind: "final", text: value.text };
  }
  if (value.kind !== "tool_calls" || !Array.isArray(value.calls)) throw new Error("模型工具回合格式不受支持。" );
  return { kind: "tool_calls", calls: value.calls.map(parseModelToolRequest) };
}

function parseModelToolRequest(value: unknown): ModelToolRequest {
  if (!isRecord(value)) throw new Error("工具请求必须是对象。" );
  rejectForbiddenFields(value);
  if (typeof value.toolId !== "string" || value.toolId.length === 0) throw new Error("工具请求缺少 toolId。" );
  if (!isToolAction(value.action)) throw new Error("工具请求 action 不受支持。" );
  const target = value.target === null ? undefined : value.target;
  if (target !== undefined && typeof target !== "string") throw new Error("工具请求 target 必须是字符串。" );
  return { toolId: value.toolId, action: value.action, target, input: value.input };
}

function rejectForbiddenFields(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) rejectForbiddenFields(item, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const field of FORBIDDEN_MODEL_FIELDS) if (field in record) throw new Error(`模型不能返回权限控制字段：${field}。`);
  for (const item of Object.values(record)) rejectForbiddenFields(item, seen);
}

function isToolAction(value: unknown): value is ToolAction {
  return value === "read" || value === "network_read" || value === "write" || value === "delete" || value === "install" || value === "external_write" || value === "publish" || value === "sensitive_read";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatToolContent(toolId: string, output: unknown): string {
  let serialized: string;
  try { serialized = JSON.stringify(output) ?? "null"; } catch { serialized = "[无法序列化的工具结果]"; }
  if (serialized.length > MAX_TOOL_TRANSCRIPT_CHARS) serialized = `${serialized.slice(0, MAX_TOOL_TRANSCRIPT_CHARS)}…[工具结果已截断]`;
  return `${toolId}：${serialized}`;
}

function cloneUnknown(value: unknown): unknown {
  try { return structuredClone(value); }
  catch (error) {
    throw new Error(`工作流快照包含无法复制的数据：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
