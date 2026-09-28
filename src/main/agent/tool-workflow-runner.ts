import { createHash, randomUUID } from "node:crypto";
import { evaluatePermission, type PermissionDecision, type PermissionScope, type ToolAction, type ToolRisk, type ToolPermissionGrant, type ToolPermissionRequest } from "./permission-policy";
import { ToolRunner, type ToolRunResult } from "./tool-runner";

export type ToolWorkflowStatus = "queued" | "planning" | "running" | "waiting_user" | "replanning" | "completed" | "completed_with_warnings" | "incomplete" | "failed" | "cancel_requested" | "cancelled" | "interrupted";
export type ToolWorkflowEventType = "progress" | "workflow_created" | "model_round_started" | "model_plan_superseded" | "model_output_repair_requested" | "goal_verification_passed" | "goal_verification_continued" | "goal_verification_incomplete" | "permission_requested" | "permission_decided" | "user_instruction_added" | "tool_started" | "tool_output" | "tool_completed" | "tool_duplicate_blocked" | "tool_deferred" | "tool_denied" | "tool_failed" | "workflow_completed" | "workflow_incomplete" | "workflow_failed" | "workflow_cancel_requested" | "workflow_cancelled" | "workflow_interrupted";

export interface ModelToolRequest {
  toolId: string;
  action: ToolAction;
  target?: string;
  input: unknown;
}

export type ModelTurn =
  | { kind: "tool_calls"; calls: ModelToolRequest[] }
  | { kind: "final"; text: string; goalAssessment?: "achieved" | "incomplete" | "uncertain" };

export interface ToolWorkflowModelInput {
  workflowId: string;
  round: number;
  userRequest: string;
  transcript: ToolWorkflowMessage[];
  /** Only concise runtime/provider lifecycle status; never model reasoning text. */
  onProgress?: (message: string) => void;
}

export interface ToolWorkflowCompletionVerificationInput extends ToolWorkflowModelInput {
  candidateFinal: string;
  goalAssessment?: "achieved" | "incomplete" | "uncertain";
  toolResults: ToolWorkflowToolResult[];
}

export interface ToolWorkflowCompletionEvidence {
  source: "request" | "tool";
  quote: string;
}

export interface ToolWorkflowCompletionVerification {
  decision: "verified" | "continue" | "incomplete";
  reason: string;
  nextStep?: string;
  evidence: ToolWorkflowCompletionEvidence[];
}

export interface ToolWorkflowModel {
  next(input: ToolWorkflowModelInput): Promise<unknown>;
  /** Independent semantic check called before Awen can end a workflow successfully. */
  verifyCompletion?(input: ToolWorkflowCompletionVerificationInput): Promise<ToolWorkflowCompletionVerification>;
}

export interface ToolWorkflowMessage {
  role: "user" | "assistant" | "tool";
  content: string;
}

export interface ToolWorkflowEvent {
  id: string;
  /** Monotonic per workflow; older stored events without this field remain readable. */
  sequence?: number;
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
  practiceTaskId?: string;
  workspaceId?: string;
  grants: ToolPermissionGrant[];
  defaultAllowReadOnly: boolean;
  /** Fails closed when a final answer has not passed the model's separate verifier. */
  requireCompletionVerification?: boolean;
  /** Restricts pre-existing grants for selected tools (for example, host code execution). */
  allowedGrantScopesByTool?: Record<string, PermissionScope[]>;
  /** Validates an author-edited pending input using the same runtime schemas as the tool adapter. */
  validatePermissionRequest?: (request: ModelToolRequest) => ModelToolRequest;
  /** Gives the app a chance to attach durable task context before a requested tool is authorized or run. */
  onToolProposed?: (request: ModelToolRequest, workflowId: string) => Promise<(Partial<Pick<ToolWorkflowPolicy, "practiceTaskId">> & { deferMessage?: string }) | void>;
  resolveRisk(request: ModelToolRequest): ToolRisk;
}

export interface ToolWorkflowOptions {
  maxRounds?: number;
  maxCallsPerRound?: number;
  maxRetainedWorkflows?: number;
  /** Called after every durable lifecycle event so the host can persist/stream the latest state. */
  onSnapshot?: (snapshot: ToolWorkflowSnapshot) => void;
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
  /** Persisted, so a restart cannot reset the consecutive no-observation guard. */
  consecutiveNoProgressCalls?: number;
}

interface WorkflowState extends ToolWorkflowSnapshot {
  policy: ToolWorkflowPolicy;
  busy: boolean;
  cancelRequested: boolean;
  controller: AbortController;
  activeAdvance?: Promise<ToolWorkflowSnapshot>;
  consecutiveNoProgressCalls: number;
  lastUnverifiedFinal?: string;
  lastVerificationBlocker?: string;
}

export type PermissionResponse =
  | { decision: "allow"; scope: Exclude<PermissionScope, "global">; expiresAt?: string; input?: unknown }
  | { decision: "deny" };

const FORBIDDEN_MODEL_FIELDS = new Set(["confirmed", "permission", "permissions", "grant", "grants", "lease", "authorization", "authorized", "approval"]);
const DEFAULT_MAX_ROUNDS = 8;
const DEFAULT_MAX_CALLS_PER_ROUND = 8;
const MAX_TOOL_TRANSCRIPT_CHARS = 12_000;
const MAX_CONSECUTIVE_NO_PROGRESS_CALLS = 2;

/**
 * Application-side orchestration seam. The model can request tools and produce
 * text, but it cannot grant itself permission or bypass ToolRunner.
 */
export class ToolWorkflowRunner {
  private readonly workflows = new Map<string, WorkflowState>();
  private readonly eventListeners = new Map<string, Set<(event: ToolWorkflowEvent) => void>>();
  private readonly maxRounds: number;
  private readonly maxCallsPerRound: number;
  private readonly maxRetainedWorkflows: number;

  constructor(private readonly toolRunner: ToolRunner, private readonly model: ToolWorkflowModel, options: ToolWorkflowOptions = {}) {
    this.maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
    this.maxCallsPerRound = options.maxCallsPerRound ?? DEFAULT_MAX_CALLS_PER_ROUND;
    this.maxRetainedWorkflows = options.maxRetainedWorkflows ?? 100;
    this.onSnapshot = options.onSnapshot;
  }

  private readonly onSnapshot: ToolWorkflowOptions["onSnapshot"];

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
      controller: new AbortController(),
      consecutiveNoProgressCalls: 0
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
    const allowedScopes = state.policy.allowedGrantScopesByTool?.[pending.request.toolId];
    if (response.decision === "allow" && allowedScopes && !allowedScopes.includes(response.scope)) {
      throw new Error("当前操作不支持此授权范围；请改为单次或本次任务授权。" );
    }

    const approvedCall = response.decision === "allow" && Object.prototype.hasOwnProperty.call(response, "input")
      ? { ...pending, request: state.policy.validatePermissionRequest?.({ ...pending.request, input: response.input }) ?? (() => { throw new Error("当前工具不支持直接修改待执行参数。" ); })() }
      : pending;

    state.busy = true;
    try {
      state.pendingPermission = null;
      this.addEvent(state, "permission_decided", response.decision === "allow" ? "用户已授权本次工具调用。" : "用户拒绝了本次工具调用。", {
        decision: response.decision,
        scope: response.decision === "allow" ? response.scope : null,
        parametersEdited: response.decision === "allow" && approvedCall.request !== pending.request,
        toolId: pending.request.toolId,
        action: pending.request.action,
        target: pending.request.target ?? null,
        projectId: state.policy.projectId ?? null,
        practiceTaskId: state.policy.practiceTaskId ?? null
      });
      if (response.decision === "allow") {
        const grant: ToolPermissionGrant = { scope: response.scope, decision: "allow", toolId: approvedCall.request.toolId, action: approvedCall.request.action, projectId: state.policy.projectId, targetPrefix: approvedCall.request.target, expiresAt: response.expiresAt };
        if (response.scope !== "run") state.policy = { ...state.policy, grants: [grant, ...state.policy.grants] };
        const activeAdvance = response.scope === "run"
          ? this.advance(state, approvedCall, grant)
          : this.advance(state, approvedCall);
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

  async restoreWaiting(snapshot: ToolWorkflowSnapshot, policy: ToolWorkflowPolicy): Promise<ToolWorkflowSnapshot> {
    if (snapshot.status !== "interrupted" || !snapshot.pendingPermission) {
      throw new Error("只有带待授权调用的中断工作流才能安全恢复；其他工作流必须重新规划。" );
    }
    if (this.workflows.has(snapshot.workflowId)) return this.getSnapshot(snapshot.workflowId);
    const restoredPolicy = restoreTaskGrants(snapshot, policy);
    const restored = structuredClone(snapshot);
    restored.status = "waiting_user";
    const state: WorkflowState = {
      ...restored,
      policy: restoredPolicy,
      busy: false,
      cancelRequested: false,
      controller: new AbortController(),
      consecutiveNoProgressCalls: snapshot.consecutiveNoProgressCalls ?? 0
    };
    this.workflows.set(state.workflowId, state);
    this.pruneRetainedWorkflows();
    const pending = state.pendingPermission;
    if (pending) {
      const request: ToolPermissionRequest = {
        ...pending.request,
        projectId: restoredPolicy.projectId,
        risk: restoredPolicy.resolveRisk(pending.request),
        defaultAllow: restoredPolicy.defaultAllowReadOnly
      };
      const permission = evaluatePermission(request, restoredPolicy.grants);
      const taskGrant = permission.decision === "allow" && permission.matchedScope === "task"
        ? restoredPolicy.grants.find((grant) => grant.scope === "task" && grant.decision === "allow" &&
          evaluatePermission(request, [grant]).decision === "allow")
        : undefined;
      if (taskGrant) {
        state.pendingPermission = null;
        state.busy = true;
        this.addEvent(state, "permission_decided", "已按你选择的恢复操作，沿用本次任务中仍匹配的授权。", {
          decision: "allow", scope: "task", resumed: true, toolId: pending.request.toolId,
          action: pending.request.action, target: pending.request.target ?? null,
          projectId: restoredPolicy.projectId ?? null, practiceTaskId: restoredPolicy.practiceTaskId ?? null
        });
        const activeAdvance = this.advance(state, pending, taskGrant);
        state.activeAdvance = activeAdvance;
        try { return await activeAdvance; }
        finally { state.activeAdvance = undefined; state.busy = false; }
      }
    }
    this.addEvent(state, "permission_requested", "应用重启后恢复待授权调用，仍需重新确认。", { recovered: true });
    return this.cloneSnapshot(state);
  }

  async resumeInterrupted(snapshot: ToolWorkflowSnapshot, policy: ToolWorkflowPolicy): Promise<ToolWorkflowSnapshot> {
    if (snapshot.status !== "interrupted" || snapshot.pendingPermission) {
      throw new Error("只有没有待授权调用的中断工作流才能重新规划。带待授权调用的工作流必须先恢复授权。" );
    }
    if (this.workflows.has(snapshot.workflowId)) return this.getSnapshot(snapshot.workflowId);
    const restored = structuredClone(snapshot);
    const restoredPolicy = restoreTaskGrants(snapshot, policy);
    restored.status = "replanning";
    const state: WorkflowState = {
      ...restored,
      policy: restoredPolicy,
      busy: true,
      cancelRequested: false,
      controller: new AbortController(),
      consecutiveNoProgressCalls: snapshot.consecutiveNoProgressCalls ?? 0
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
    if (state.status === "completed" || state.status === "completed_with_warnings" || state.status === "incomplete" || state.status === "failed" || state.status === "cancelled") return this.cloneSnapshot(state);
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

  subscribe(workflowId: string, listener: (event: ToolWorkflowEvent) => void, afterSequence = 0): () => void {
    const state = this.requireWorkflow(workflowId);
    state.events.forEach((event, index) => {
      const sequence = event.sequence ?? index + 1;
      if (sequence > afterSequence) listener({ ...event, sequence, data: event.data ? { ...event.data } : undefined });
    });
    const listeners = this.eventListeners.get(workflowId) ?? new Set<(event: ToolWorkflowEvent) => void>();
    listeners.add(listener);
    this.eventListeners.set(workflowId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.eventListeners.delete(workflowId);
    };
  }

  recordModelOutputRepair(workflowId: string, message: string, attempt: number): void {
    const state = this.requireWorkflow(workflowId);
    this.addEvent(state, "model_output_repair_requested", message, { attempt });
  }

  appendUserInstruction(workflowId: string, instruction: string): ToolWorkflowSnapshot {
    const normalized = instruction.trim();
    if (!normalized || normalized.length > 4000) throw new Error("新增实践要求必须在 1 到 4000 个字符之间。" );
    const state = this.requireWorkflow(workflowId);
    if (["completed", "completed_with_warnings", "incomplete", "failed", "cancel_requested", "cancelled", "interrupted"].includes(state.status)) throw new Error("已结束或中断的工作流不能追加在线要求。" );
    state.transcript.push({ role: "user", content: `新增实践目标：${normalized}` });
    this.addEvent(state, "user_instruction_added", "新增实践目标已并入此工作流，后续规划将据此更新。", { taskId: state.policy.practiceTaskId ?? null });
    return this.cloneSnapshot(state);
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
      if (state.consecutiveNoProgressCalls >= MAX_CONSECUTIVE_NO_PROGRESS_CALLS) {
        return this.finishAfterNoProgress(state);
      }
    }

    while (state.round < this.maxRounds && !state.finalText && !state.pendingPermission) {
      state.round += 1;
      state.status = state.status === "replanning" ? "replanning" : "planning";
      this.addEvent(state, "model_round_started", `开始第 ${state.round} 轮模型规划。`, { round: state.round });
      let turn: ModelTurn;
      const promptTranscriptLength = state.transcript.length;
      try {
        turn = parseModelTurn(await this.model.next({
          workflowId: state.workflowId,
          round: state.round,
          userRequest: state.userRequest,
          transcript: [...state.transcript],
          onProgress: (message) => {
            const safe = message.trim().replace(/[\r\n\t]+/gu, " ").slice(0, 240);
            if (safe) this.addEvent(state, "progress", safe);
          }
        }));
      } catch (error) {
        if (state.cancelRequested) return this.markCancelled(state);
        state.status = "failed";
        this.addEvent(state, "workflow_failed", error instanceof Error ? error.message : String(error));
        return this.cloneSnapshot(state);
      }

      if (state.cancelRequested) return this.markCancelled(state);
      if (state.transcript.length !== promptTranscriptLength) {
        state.status = "replanning";
        this.addEvent(state, "model_plan_superseded", "规划期间收到新的作者要求；已丢弃旧计划并重新评估。", { round: state.round });
        continue;
      }

      if (turn.kind === "final") {
        if (state.policy.requireCompletionVerification) {
          if (!this.model.verifyCompletion) {
            state.status = "failed";
            this.addEvent(state, "workflow_failed", "完成条件验证器不可用；本轮没有标记为完成。", { round: state.round });
            return this.cloneSnapshot(state);
          }
          let verification: ToolWorkflowCompletionVerification;
          try {
            verification = await this.model.verifyCompletion({
              workflowId: state.workflowId,
              round: state.round,
              userRequest: state.userRequest,
              transcript: [...state.transcript],
              candidateFinal: turn.text,
              goalAssessment: turn.goalAssessment,
              toolResults: state.toolResults.map((result) => ({ ...result, output: cloneUnknown(result.output) }))
            });
          } catch (error) {
            state.status = "failed";
            this.addEvent(state, "workflow_failed", `完成条件验证失败；本轮没有标记为完成：${error instanceof Error ? error.message : String(error)}`);
            return this.cloneSnapshot(state);
          }
          const usefulToolResults = state.toolResults.filter((result) =>
            !state.events.some((event) => event.type === "tool_completed" && event.data?.callId === result.callId && event.data.noProgress === true));
          const grounded = hasGroundedCompletionEvidence(verification.evidence, state.transcript, usefulToolResults);
          const verifiedWithToolEvidence = verification.decision !== "verified" || state.toolResults.length === 0 || (usefulToolResults.length > 0 &&
            verification.evidence.some((evidence) => evidence.source === "tool" && hasToolObservationQuote(evidence.quote, usefulToolResults)));
          const decision = grounded && verifiedWithToolEvidence ? verification.decision : "continue";
          const reason = decision === "continue" && (!grounded || !verifiedWithToolEvidence)
            ? "验证器没有提供能在本轮请求或工具观察中逐字找到的依据；不能据此判定目标已达成。"
            : verification.reason.trim().slice(0, 1200) || "验证器未说明判定依据。";
          const eventType = decision === "verified" ? "goal_verification_passed" : decision === "incomplete" ? "goal_verification_incomplete" : "goal_verification_continued";
          this.addEvent(state, eventType, reason, { round: state.round, evidenceCount: verification.evidence.length });

          if (decision === "continue" || (decision === "incomplete" && turn.goalAssessment === "achieved")) {
            state.lastUnverifiedFinal = turn.text;
            state.lastVerificationBlocker = reason;
            state.status = "replanning";
            const nextStep = verification.nextStep?.trim().slice(0, 800);
            state.transcript.push({
              role: "tool",
              content: `goal_verification：${decision === "incomplete" ? "阿文声称目标已达成，但验证器判定证据不足" : "尚未通过"}。${reason}${nextStep ? ` 下一步方向：${nextStep}` : "请检查目标范围与已观察结果，选择其他相关方法继续核验。"}不得把未核实内容写成事实。`
            });
            continue;
          }

          if (decision === "incomplete") {
            state.warningCount += 1;
            state.status = "incomplete";
            state.finalText = turn.text;
            state.transcript.push({ role: "assistant", content: turn.text });
            this.addEvent(state, "workflow_incomplete", "验证器确认当前证据不足，已返回明确标注待核查的答复；本轮不计为目标完成。", { warningCount: state.warningCount });
            return this.cloneSnapshot(state);
          }
        }
        state.finalText = turn.text;
        state.transcript.push({ role: "assistant", content: turn.text });
        if (turn.goalAssessment && turn.goalAssessment !== "achieved") state.warningCount += 1;
        state.status = state.warningCount > 0 ? "completed_with_warnings" : "completed";
        const assessmentMessage = turn.goalAssessment === "incomplete" ? "目标尚未达成" : turn.goalAssessment === "uncertain" ? "目标是否达成仍不确定" : undefined;
        const message = state.status === "completed"
          ? "阿文已结束本轮并返回答复。"
          : `阿文已结束本轮并返回答复；${assessmentMessage ?? "其中有需要注意的结果"}。`;
        this.addEvent(state, "workflow_completed", message, { warningCount: state.warningCount });
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
      let deferredCall = false;
      for (const request of turn.calls) {
        const proposalContext = await state.policy.onToolProposed?.(request, state.workflowId);
        if (proposalContext?.practiceTaskId) state.policy = { ...state.policy, practiceTaskId: proposalContext.practiceTaskId };
        if (proposalContext?.deferMessage) {
          const callId = randomUUID();
          const message = proposalContext.deferMessage.slice(0, 1000);
          state.transcript.push({ role: "tool", content: `${request.toolId}：${message}` });
          this.addEvent(state, "tool_deferred", message, { callId, toolId: request.toolId });
          state.status = "replanning";
          deferredCall = true;
          break;
        }
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
        if (state.consecutiveNoProgressCalls >= MAX_CONSECUTIVE_NO_PROGRESS_CALLS) {
          return this.finishAfterNoProgress(state);
        }
      }
      if (deferredCall) continue;
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
    const requestFingerprint = fingerprintToolRequest(request);
    const invocation: ToolPermissionRequest & { input: unknown } = {
      ...request,
      projectId: state.policy.projectId,
      risk: state.policy.resolveRisk(request),
      defaultAllow: state.policy.defaultAllowReadOnly
    };
    this.addEvent(state, "tool_started", `准备执行 ${request.toolId}。`, { callId, toolId: request.toolId, target: request.target ?? null });
    const allowedScopes = state.policy.allowedGrantScopesByTool?.[request.toolId];
    const existingGrants = allowedScopes
      ? state.policy.grants.filter((grant) => allowedScopes.includes(grant.scope))
      : state.policy.grants;
    const permission = evaluatePermission(invocation, [...extraGrants, ...existingGrants]);
    const previousAttempt = [...state.events].reverse().find((event) =>
      (event.type === "tool_completed" || event.type === "tool_failed" || event.type === "tool_denied") && event.data?.requestFingerprint === requestFingerprint);
    const verifierRejected = previousAttempt?.type === "tool_completed" &&
      state.events.slice(state.events.indexOf(previousAttempt) + 1).some((event) => event.type === "goal_verification_continued");
    if (permission.decision === "allow" && previousAttempt && (previousAttempt.data?.noProgress === true || verifierRejected)) {
      const message = previousAttempt.data?.noProgress === true
        ? `已拦截没有新信息的重复调用 ${request.toolId}；上一轮没有产生可用观察，本次没有再次运行。请改用能取得结果的方法，或如实说明限制。`
        : `已拦截完成条件核验未通过后的相同调用 ${request.toolId}；上一轮的观察结果仍保留在记录中。本次没有再次运行，请改用其他方法或说明限制。`;
      state.transcript.push({ role: "tool", content: `${request.toolId}：${message}` });
      this.addEvent(state, "tool_duplicate_blocked", message, { callId, toolId: request.toolId, requestFingerprint, reason: previousAttempt.data?.noProgress === true ? "no_progress" : "verification_rejected" });
      return { status: "failed", toolId: request.toolId, permission, error: message };
    }
    const result = await this.toolRunner.run(invocation, [...extraGrants, ...existingGrants], {
      signal: state.controller.signal, workflowId: state.workflowId,
      practiceTaskId: state.policy.practiceTaskId,
      projectId: state.policy.projectId, workspaceId: state.policy.workspaceId
    });
    if (result.status === "waiting_user") {
      state.status = "waiting_user";
      state.pendingPermission = { callId, request, permission: result.permission };
      this.addEvent(state, "permission_requested", result.permission.reason, { callId, toolId: request.toolId, target: request.target ?? null });
      return result;
    }
    if (result.status === "completed") {
      const noProgress = !hasUsefulObservation(result.output);
      state.consecutiveNoProgressCalls = noProgress ? state.consecutiveNoProgressCalls + 1 : 0;
      state.transcript.push({ role: "tool", content: noProgress
        ? `${request.toolId}：本次运行没有产生可用观察；运行元数据不能作为目标结果。`
        : formatToolContent(request.toolId, result.output) });
      state.toolResults.push({ callId, toolId: request.toolId, output: cloneUnknown(result.output) });
      if (noProgress) state.warningCount += 1;
      this.addEvent(state, "tool_output", noProgress ? `${request.toolId} 没有返回可用于回答目标的结果。` : `${request.toolId} 返回了结果，正在继续核验。`, { callId, toolId: request.toolId, noProgress });
      this.addEvent(state, "tool_completed", noProgress ? `${request.toolId} 已运行，但没有产生可用观察。` : `${request.toolId} 已完成。`, { callId, toolId: request.toolId, requestFingerprint, noProgress });
      return result;
    }
    if (result.status === "denied") {
      state.transcript.push({ role: "tool", content: `${request.toolId}：策略拒绝执行；请重新规划替代方案。` });
      this.addEvent(state, "tool_denied", result.permission.reason, { callId, toolId: request.toolId });
      return result;
    }
    state.transcript.push({ role: "tool", content: `${request.toolId}：执行失败：${result.error}` });
    state.consecutiveNoProgressCalls += 1;
      this.addEvent(state, "tool_failed", result.error, { callId, toolId: request.toolId, requestFingerprint, noProgress: true });
    return result;
  }

  private finishAfterNoProgress(state: WorkflowState): ToolWorkflowSnapshot {
    const detail = state.lastVerificationBlocker?.trim();
    const reason = `连续 ${MAX_CONSECUTIVE_NO_PROGRESS_CALLS} 次后续工具调用都没有带来新观察，阿文已停止重复尝试。${detail ? ` 当前未完成项：${detail}` : "请改用能取得新结果的方法，或告诉阿文按已取得的结果继续并标记剩余内容待核查。"}`;
    state.status = "incomplete";
    state.warningCount += 1;
    state.finalText = appendIncompleteBlockerToFinal(state.lastUnverifiedFinal ?? "", reason);
    state.transcript.push({ role: "assistant", content: state.finalText });
    this.addEvent(state, "workflow_incomplete", reason, { warningCount: state.warningCount, noProgressCalls: state.consecutiveNoProgressCalls });
    return this.cloneSnapshot(state);
  }

  private addEvent(state: WorkflowState, type: ToolWorkflowEventType, message: string, data?: Record<string, string | number | boolean | null>): void {
    const event: ToolWorkflowEvent = { id: randomUUID(), sequence: state.events.length + 1, type, at: new Date().toISOString(), message, data };
    state.events.push(event);
    for (const listener of this.eventListeners.get(state.workflowId) ?? []) listener({ ...event, data: event.data ? { ...event.data } : undefined });
    this.onSnapshot?.(this.cloneSnapshot(state));
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
      warningCount: state.warningCount,
      consecutiveNoProgressCalls: state.consecutiveNoProgressCalls
    };
  }
}

function isTerminalStatus(status: ToolWorkflowStatus): boolean {
	return status === "completed" || status === "completed_with_warnings" || status === "incomplete" || status === "failed" || status === "cancelled";
}

export function parseModelTurn(value: unknown): ModelTurn {
  if (!isRecord(value)) throw new Error("模型工具回合必须是对象。" );
  rejectForbiddenFields(value);
  if (value.kind === "final") {
    if (typeof value.text !== "string") throw new Error("模型最终回复缺少文本。" );
    if (value.goalAssessment !== undefined && value.goalAssessment !== "achieved" && value.goalAssessment !== "incomplete" && value.goalAssessment !== "uncertain") throw new Error("模型目标核对状态不受支持。" );
    return { kind: "final", text: value.text, ...(value.goalAssessment ? { goalAssessment: value.goalAssessment } : {}) };
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

function hasGroundedCompletionEvidence(evidence: ToolWorkflowCompletionEvidence[], transcript: ToolWorkflowMessage[], toolResults: ToolWorkflowToolResult[]): boolean {
  if (!evidence.length) return false;
  return evidence.every(({ source, quote }) => {
    if (!quote.trim()) return false;
    return source === "request"
      ? transcript.some((message) => message.role === "user" && message.content.includes(quote))
      : hasToolObservationQuote(quote, toolResults);
  });
}

function hasToolObservationQuote(quote: string, toolResults: ToolWorkflowToolResult[]): boolean {
  return toolResults.some((result) => formatToolContent(result.toolId, result.output).includes(quote) || collectTextLeaves(result.output).some((text) => text.includes(quote)));
}

function collectTextLeaves(value: unknown, result: string[] = [], depth = 0): string[] {
  if (depth > 12) return result;
  if (typeof value === "string") {
    result.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectTextLeaves(item, result, depth + 1);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectTextLeaves(item, result, depth + 1);
  }
  return result;
}

function fingerprintToolRequest(request: ModelToolRequest): string {
  const normalized = stableValue({ toolId: request.toolId, action: request.action, target: request.target ?? null, input: request.input });
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/** Treat echoed request metadata as no observation. This is tool-agnostic and
 * intentionally preserves explicit scalar results such as a count of zero. */
function hasUsefulObservation(value: unknown, depth = 0): boolean {
  if (depth > 12 || value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some((item) => hasUsefulObservation(item, depth + 1));
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.observationStatus === "empty") return false;
  const echoedOrDiagnosticFields = new Set(["query", "command", "args", "request", "runId", "toolId", "status", "exitCode", "durationMs", "warnings", "observationWarnings", "truncated", "artifacts", "observationStatus"]);
  return Object.entries(record).some(([key, item]) => !echoedOrDiagnosticFields.has(key) && hasUsefulObservation(item, depth + 1));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function formatToolContent(toolId: string, output: unknown): string {
  let serialized: string;
  try { serialized = JSON.stringify(output) ?? "null"; } catch { serialized = "[无法序列化的工具结果]"; }
  if (serialized.length > MAX_TOOL_TRANSCRIPT_CHARS) serialized = `${serialized.slice(0, MAX_TOOL_TRANSCRIPT_CHARS)}…[工具结果已截断]`;
  return `${toolId}：${serialized}`;
}

function appendIncompleteBlockerToFinal(candidate: string, blocker: string): string {
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (isRecord(parsed) && typeof parsed.reply === "string") {
      return JSON.stringify({ ...parsed, reply: `${parsed.reply.trim()}\n\n实践暂未完成：${blocker}`.trim() });
    }
  } catch { /* The verifier's prior candidate may not use the article reply schema. */ }
  const reply = candidate.trim() ? `${candidate.trim()}\n\n实践暂未完成：${blocker}` : `实践暂未完成：${blocker}`;
  return JSON.stringify({ reply, memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null });
}

function cloneUnknown(value: unknown): unknown {
  try { return structuredClone(value); }
  catch (error) {
    throw new Error(`工作流快照包含无法复制的数据：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function restoreTaskGrants(snapshot: ToolWorkflowSnapshot, policy: ToolWorkflowPolicy): ToolWorkflowPolicy {
  const projectId = policy.projectId ?? null;
  const practiceTaskId = policy.practiceTaskId ?? null;
  const grants: ToolPermissionGrant[] = snapshot.events.flatMap((event) => {
    if (event.type !== "permission_decided" || event.data?.decision !== "allow" || event.data.scope !== "task") return [];
    if ((event.data.projectId ?? null) !== projectId || (event.data.practiceTaskId ?? null) !== practiceTaskId) return [];
    const { toolId, action, target } = event.data;
    if (typeof toolId !== "string" || !toolId || !isToolAction(action)) return [];
    return [{
      scope: "task",
      decision: "allow",
      toolId,
      action,
      ...(typeof target === "string" && target ? { targetPrefix: target } : {}),
      ...(projectId ? { projectId } : {})
    }];
  });
  return grants.length > 0 ? { ...policy, grants: [...grants, ...policy.grants] } : policy;
}
