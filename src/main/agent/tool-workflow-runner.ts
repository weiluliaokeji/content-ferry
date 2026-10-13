import { createHash, randomUUID } from "node:crypto";
import { evaluatePermission, type PermissionDecision, type PermissionScope, type ToolAction, type ToolRisk, type ToolPermissionGrant, type ToolPermissionRequest } from "./permission-policy";
import { ToolRunner, type ToolRunResult } from "./tool-runner";
import { containsLiteralEvidence } from "../../shared/literal-evidence";

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

export interface ToolWorkflowRecoveryPlan {
  action: "reuse_observations" | "collect_new_evidence" | "request_author";
  requirementIds: string[];
  nextAction: string;
  expectedResult: string;
}

export interface ToolWorkflowCompletionEvidence {
  source: "request" | "tool";
  /** Stable one-based source reference (request-1, tool-1, ...), when available. */
  sourceId?: string | null;
  quote: string;
}

export interface ToolWorkflowCompletionVerification {
  decision: "verified" | "continue" | "incomplete";
  reason: string;
  nextStep?: string;
  /** Concrete unmet parts of the author's request; used to direct and audit recovery. */
  unresolvedRequirements?: string[];
  /** Stable IDs paired by index with unresolvedRequirements across verifier rounds. */
  unresolvedRequirementIds?: string[];
  /** Structured recovery direction so the next model turn can act on the gap, not just paraphrase it. */
  recoveryPlan?: ToolWorkflowRecoveryPlan | null;
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
  /** Allows an evidence-free result only for a bounded stage decision such as deciding whether practice is needed. */
  allowEvidenceFreeCompletion?: boolean;
  /** Recovery mode that can only reuse seeded observations and must not execute new tools. */
  reuseObservationsOnly?: boolean;
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
  /** Prior immutable observations used only for an answer-only recovery workflow. */
  initialTranscript?: ToolWorkflowMessage[];
  initialToolResults?: ToolWorkflowToolResult[];
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
  private readonly options: ToolWorkflowOptions;

  constructor(private readonly toolRunner: ToolRunner, private readonly model: ToolWorkflowModel, options: ToolWorkflowOptions = {}) {
    this.maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
    this.maxCallsPerRound = options.maxCallsPerRound ?? DEFAULT_MAX_CALLS_PER_ROUND;
    this.maxRetainedWorkflows = options.maxRetainedWorkflows ?? 100;
    this.options = options;
    this.onSnapshot = options.onSnapshot;
  }

  private readonly onSnapshot: ToolWorkflowOptions["onSnapshot"];

  async start(userRequest: string, policy: ToolWorkflowPolicy): Promise<ToolWorkflowSnapshot> {
    const snapshot = this.startBackground(userRequest, policy);
    const state = this.requireWorkflow(snapshot.workflowId);
    if (state.activeAdvance) await state.activeAdvance;
    return this.cloneSnapshot(state);
  }

  startBackground(userRequest: string, policy: ToolWorkflowPolicy): ToolWorkflowSnapshot {
    const workflowId = randomUUID();
    const state: WorkflowState = {
      workflowId,
      status: "queued",
      round: 0,
      userRequest,
      transcript: [...(this.options.initialTranscript ?? []).map((message) => ({ ...message })), { role: "user", content: userRequest }],
      events: [],
      toolResults: (this.options.initialToolResults ?? []).map((result) => ({ ...result, output: cloneUnknown(result.output) })),
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
    if (policy.reuseObservationsOnly) {
      this.addEvent(state, "progress", "已载入上次保存的候选答复与工具观察；本次只修复答复和核验，不会重新运行工具。", {
        reusedObservationCount: state.toolResults.length
      });
    }
    const activeAdvance = this.advance(state).catch((error: unknown) => {
      state.status = "failed";
      this.addEvent(state, "workflow_failed", error instanceof Error ? error.message : String(error));
      return this.cloneSnapshot(state);
    });
    state.activeAdvance = activeAdvance;
    void activeAdvance.finally(() => {
      state.activeAdvance = undefined;
      state.busy = false;
    });
    return this.cloneSnapshot(state);
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
    state.consecutiveNoProgressCalls = 0;
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

      if (state.policy.reuseObservationsOnly && turn.kind === "tool_calls") {
        state.consecutiveNoProgressCalls += 1;
        const reason = "本次恢复只允许复用上次保存的观察；新工具调用已拦截，没有执行。请直接据现有记录修订答复；若观察不足，说明具体缺口。";
        state.transcript.push({ role: "tool", content: `工具未执行：${reason}` });
        this.addEvent(state, "tool_duplicate_blocked", reason, { reason: "reuse_observations_only", noProgress: true });
        if (state.consecutiveNoProgressCalls >= MAX_CONSECUTIVE_NO_PROGRESS_CALLS) return this.finishAfterNoProgress(state);
        state.status = "replanning";
        continue;
      }

      if (turn.kind === "final") {
        if (state.policy.requireCompletionVerification) {
          if (!this.model.verifyCompletion) {
            state.status = "failed";
            state.transcript.push({ role: "assistant", content: turn.text });
            state.transcript.push({ role: "tool", content: "goal_verification_error：完成条件验证器不可用；候选答复没有通过验证。" });
            this.addEvent(state, "workflow_failed", "完成条件验证器不可用；本轮没有标记为完成。", { round: state.round, candidateChars: turn.text.length });
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
            const failure = `完成条件验证失败；本轮没有标记为完成：${(error instanceof Error ? error.message : String(error)).slice(0, 1200)}`;
            state.transcript.push({ role: "assistant", content: turn.text });
            state.transcript.push({ role: "tool", content: `goal_verification_error：${failure}` });
            this.addEvent(state, "workflow_failed", failure, { round: state.round, candidateChars: turn.text.length });
            return this.cloneSnapshot(state);
          }
          const usefulToolResults = state.toolResults.filter((result) =>
            !state.events.some((event) => event.type === "tool_completed" && event.data?.callId === result.callId && event.data.noProgress === true));
          const evidenceFreeStageCompletion = state.policy.allowEvidenceFreeCompletion === true
            && state.toolResults.length === 0
            && verification.decision === "verified"
            && verification.evidence.length === 0;
          let grounded = evidenceFreeStageCompletion || hasGroundedCompletionEvidence(verification.evidence, state.transcript, state.toolResults);
          let verifiedWithToolEvidence = verification.decision !== "verified" || state.toolResults.length === 0 || (usefulToolResults.length > 0 &&
            verification.evidence.some((evidence) => evidence.source === "tool" && hasToolObservationEvidence(evidence, state.toolResults)));
          let evidenceRepairFailed = false;
          let evidenceRepairCallFailed = false;
          if (verification.decision === "verified" && (!grounded || !verifiedWithToolEvidence)) {
            // Source IDs are assigned against the complete toolResults list shown to
            // the verifier. Keep that same index space when auditing; filtering
            // no-progress results here would make tool-2 point at a different result.
            const firstAttemptEvidenceAudit = auditCompletionEvidence(verification.evidence, state.transcript, state.toolResults);
            const firstAttemptReason = verification.reason.trim().slice(0, 900) || "验证器未说明判定依据。";
            const firstAttemptEvidenceProblem = describeCompletionEvidenceProblem(
              verification.evidence, firstAttemptEvidenceAudit, state.transcript, state.toolResults, !verifiedWithToolEvidence
            );
            const repairPrompt = `goal_verification_evidence_repair：你刚才判定 verified，但证据校验发现：${firstAttemptEvidenceProblem} 请仅根据原始工具观察重新核对同一个候选答复；若观察确实支持完成，evidence.quote 必须复制一段连续原文并选择正确来源。作者请求只能证明作者提出了什么要求，不能代替工具结果；若观察不支持目标，改判 continue 或 incomplete，并说明真实缺口。不要转述、拼接或引用这条修复提示。之前的诊断：${firstAttemptReason}。引文核对：${JSON.stringify(firstAttemptEvidenceAudit)}`;
            state.transcript.push({ role: "tool", content: repairPrompt });
            this.addEvent(state, "progress", `完成核验发现证据问题：${firstAttemptEvidenceProblem}；正在基于原始观察修正核验，不会重复正文生成或工具操作。`, {
              round: state.round,
              evidenceRepairAttempt: 1,
              evidenceRepairProblem: firstAttemptEvidenceProblem,
              ungroundedEvidenceCount: firstAttemptEvidenceAudit.filter((evidence) => !evidence.grounded).length
            });
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
              evidenceRepairFailed = true;
              evidenceRepairCallFailed = true;
              verification = {
                decision: "incomplete",
                reason: `核验器未能修正无法定位的证据引文：${(error instanceof Error ? error.message : String(error)).slice(0, 700)}`,
                evidence: []
              };
            }
            grounded = verification.decision === "verified"
              && (state.policy.allowEvidenceFreeCompletion === true && state.toolResults.length === 0 && verification.evidence.length === 0
            || hasGroundedCompletionEvidence(verification.evidence, state.transcript, state.toolResults));
            verifiedWithToolEvidence = verification.decision !== "verified" || state.toolResults.length === 0 || (usefulToolResults.length > 0 &&
              verification.evidence.some((evidence) => evidence.source === "tool" && hasToolObservationEvidence(evidence, state.toolResults)));
            evidenceRepairFailed = evidenceRepairFailed || (verification.decision === "verified" && (!grounded || !verifiedWithToolEvidence));
          }
          // Evidence grounding is a gate for claiming success. A conservative
          // `incomplete` result must remain incomplete without citations. A
          // malformed `verified` citation receives one same-round verifier-only
          // repair before any planning retry is considered.
          const groundingRejectedSuccess = verification.decision === "verified" && (!grounded || !verifiedWithToolEvidence);
          const verifierReason = verification.reason.trim().slice(0, 900) || "验证器未说明判定依据。";
          const evidenceRepairFailureDetail = evidenceRepairFailed
            ? describeCompletionEvidenceProblem(verification.evidence, auditCompletionEvidence(verification.evidence, state.transcript, state.toolResults), state.transcript, state.toolResults, !verifiedWithToolEvidence)
            : "";
          const unresolvedRequirements = (verification.unresolvedRequirements ?? [])
            .map((requirement) => requirement.trim())
            .filter(Boolean)
            .slice(0, 6);
          const unresolvedRequirementIds = normalizeUnresolvedRequirementIds(
            unresolvedRequirements,
            verification.unresolvedRequirementIds,
            state.events
          );
          const nextStep = verification.nextStep?.trim().slice(0, 800) ?? "";
          const continueWithoutActionableGap = !evidenceRepairFailed
            && (verification.decision === "continue" || groundingRejectedSuccess)
            && (unresolvedRequirements.length === 0 || !nextStep);
          // A malformed verifier citation is not proof that the task itself is
          // impossible. Give the planner one bounded chance to reuse existing
          // observations or choose a different evidence route; duplicate tool
          // calls and the ordinary no-progress cutoff still apply.
          const canReplanAfterEvidenceRepair = evidenceRepairFailed && !evidenceRepairCallFailed && state.round < this.maxRounds;
          const decision = continueWithoutActionableGap
            ? "incomplete"
            : evidenceRepairFailed
              ? canReplanAfterEvidenceRepair ? "continue" : "incomplete"
              : groundingRejectedSuccess ? "continue" : verification.decision;
          const reason = evidenceRepairCallFailed
            ? `完成核验引文修复调用失败；本轮未标记成功，也没有重跑工具操作。错误：${verifierReason}`
            : evidenceRepairFailed
            ? canReplanAfterEvidenceRepair
              ? `核验器经过一次引文修正后仍未通过证据校验：${evidenceRepairFailureDetail} 本轮没有标记成功。下一步可基于原始观察重整答复，必要时选择新的取证路线；已完成的操作不会重放。验证器说明：${verifierReason}`
              : `核验器经过一次引文修正后仍未通过证据校验：${evidenceRepairFailureDetail} 没有据此标记成功。请检查候选答复和原始观察。验证器说明：${verifierReason}`
            : groundingRejectedSuccess
              ? `验证器判定目标已达成，但证据校验未通过：${evidenceRepairFailureDetail || describeCompletionEvidenceProblem(verification.evidence, auditCompletionEvidence(verification.evidence, state.transcript, state.toolResults), state.transcript, state.toolResults, !verifiedWithToolEvidence)} 不能据此标记成功。验证器说明：${verifierReason}`
              : continueWithoutActionableGap
                ? `核验器要求继续，但没有同时提供具体未满足的作者要求和可执行的下一步；已停止盲目重试并保留候选答复。验证器说明：${verifierReason}`
            : verifierReason;
          const needsReplan = !continueWithoutActionableGap
            && (canReplanAfterEvidenceRepair || (!evidenceRepairFailed
              && (decision === "continue" || (decision === "incomplete" && turn.goalAssessment === "achieved"))));
          const candidateRevision = needsReplan && state.lastUnverifiedFinal !== undefined
            && isSubstantiveCandidateRevision(state.lastUnverifiedFinal, turn.text);
          if (candidateRevision) {
            this.addEvent(state, "progress", "阿文已根据上一轮核验意见实质修订候选答复，正在重新核验。", {
              round: state.round,
              candidateRevision: true,
              previousCandidateChars: state.lastUnverifiedFinal?.length ?? 0,
              candidateChars: turn.text.length
            });
          }
          const eventType = decision === "verified" ? "goal_verification_passed" : decision === "incomplete" ? "goal_verification_incomplete" : "goal_verification_continued";
          const evidenceAudit = auditCompletionEvidence(verification.evidence, state.transcript, state.toolResults);
          const groundedEvidenceCount = evidenceAudit.filter((evidence) => evidence.grounded).length;
          const ungroundedEvidenceCount = evidenceAudit.length - groundedEvidenceCount;
          this.addEvent(state, eventType, reason, {
            round: state.round,
            evidenceCount: verification.evidence.length,
            groundedEvidenceCount,
            candidateChars: turn.text.length,
            candidateRevision,
            unresolvedRequirementsJson: JSON.stringify(unresolvedRequirements),
            unresolvedRequirementIdsJson: JSON.stringify(unresolvedRequirementIds),
            recoveryAction: verification.recoveryPlan?.action ?? null,
            recoveryRequirementIdsJson: JSON.stringify(verification.recoveryPlan?.requirementIds ?? []),
            recoveryExpectedResult: verification.recoveryPlan?.expectedResult ?? null
          });

          if (needsReplan) {
            state.lastUnverifiedFinal = turn.text;
            state.lastVerificationBlocker = reason;
            const priorUnprogressedRejections = countVerifierRejectionsSinceProgress(state.events);
            const answerOnlyGraceAlreadyUsed = state.events.some((event) => event.type === "progress"
              && event.data?.answerOnlyVerifierGraceUsed === true);
            // A meaningful answer repair can make better use of existing
            // observations without producing another tool result. It does not
            // reset the no-progress counter, but one final verification is
            // useful before we conclude that the verifier/planner is stuck.
            // Keep this grace strictly bounded and require usable observations.
            const answerOnlyVerifierGrace = priorUnprogressedRejections >= 2
              && candidateRevision && usefulToolResults.length > 0 && !answerOnlyGraceAlreadyUsed;
            if (priorUnprogressedRejections >= 2 && !answerOnlyVerifierGrace) {
              const evidenceStatus = verification.evidence.length === 0
                ? "核验器没有返回证据引文；这表示核验依据缺失，不等同于工具没有取得观察"
                : ungroundedEvidenceCount > 0
                  ? `核验器返回 ${verification.evidence.length} 条引文，其中 ${ungroundedEvidenceCount} 条无法与其标注的本轮请求或工具观察逐字对应；这是引文定位失败，不能据此认定原始观察不存在`
                  : "核验引文都能定位到本轮请求或工具观察，但这些观察仍不足以满足目标";
              const unresolvedSummary = unresolvedRequirements.length > 0
                ? `仍未满足的要求：${unresolvedRequirements.join("；")}。`
                : "验证器没有列出具体未满足要求。";
              const revisionStatus = candidateRevision
                ? "上一轮候选答复有实质改动，但核验器仍保留相同未满足要求"
                : "上一轮候选答复没有实质改动";
              const stopPrefix = answerOnlyGraceAlreadyUsed
                ? "基于现有观察的额外修答核验仍未通过，期间没有新增工具观察或作者要求"
                : "完成核验连续两轮未通过，期间没有新增工具观察或作者要求";
              const stopReason = `${stopPrefix}；${revisionStatus}，已停止自动重试并保留候选答复。${unresolvedSummary}${evidenceStatus}。未通过原因：${reason}`;
              state.status = "incomplete";
              state.warningCount += 1;
              state.finalText = appendIncompleteBlockerToFinal(turn.text, stopReason);
              state.transcript.push({ role: "assistant", content: turn.text });
              state.transcript.push({ role: "tool", content: `goal_verification：连续重试保护已停止自动循环。${stopReason}\n证据核对：${JSON.stringify(evidenceAudit)}` });
              state.transcript.push({ role: "assistant", content: state.finalText });
              this.addEvent(state, "workflow_incomplete", stopReason, {
                round: state.round,
                noProgressVerifierRejections: priorUnprogressedRejections,
                evidenceCount: verification.evidence.length,
                groundedEvidenceCount,
                ungroundedEvidenceCount,
                candidateChangedSinceLastRejection: candidateRevision,
                answerOnlyVerifierGraceUsed: answerOnlyGraceAlreadyUsed,
                unresolvedRequirementSummary: unresolvedRequirements.join("；")
              });
              return this.cloneSnapshot(state);
            }
            if (answerOnlyVerifierGrace) {
              const graceMessage = "核验连续两次未通过，但候选答复已根据现有观察作出实质修订；允许最后一次核验，不会重跑工具。";
              state.transcript.push({ role: "tool", content: `${graceMessage} 下一轮只需基于现有观察修正答复；若同一要求仍未解决，将停止并保留具体原因。` });
              this.addEvent(state, "progress", graceMessage, {
                round: state.round,
                answerOnlyVerifierGraceUsed: true,
                candidateChars: turn.text.length,
                unresolvedRequirementSummary: unresolvedRequirements.join("；")
              });
            }
            state.status = "replanning";
            state.transcript.push({ role: "assistant", content: turn.text });
            const unresolvedBlock = unresolvedRequirements.length > 0
              ? `\n仍未满足的作者要求（下一轮必须逐项处理；相同缺口沿用同一标识；不得用增加无关内容替代）：\n${unresolvedRequirements.map((item, index) => `${unresolvedRequirementIds[index] ?? `R${index + 1}`}. ${item}`).join("\n")}`
              : "\n验证器没有列出具体未满足项。下一轮必须对照作者原始要求与候选答复找出确切缺口；若已有观察足够，直接修订答复，不要重复工具调用。";
            const evidenceRepairGuidance = answerOnlyVerifierGrace
              ? "这是唯一一次基于现有观察的额外修答机会：逐项对照作者原始要求，直接使用已有工具原文补齐候选答复；不要重跑已有调用、换句复述或加入无关内容。若现有观察确实无法支持要求，应明确指出具体缺口并停止。"
              : evidenceRepairFailed
              ? "核验器在一次引文修正后仍未能定位依据。下一步不要重复已完成的调用：先从原始工具观察中选择连续原文并据此重整候选答复；如果观察确实不支持目标，再选择能补足该具体事实的新路线。相同无进展请求会被拦截。"
              : ungroundedEvidenceCount > 0
              ? `本轮有 ${ungroundedEvidenceCount} 条核验引文无法定位（grounded=false）。下一轮先处理这些引文：只能从下方原始工具观察中复制连续原文作为依据；如果原始观察确实不包含所需事实，再选择不同且能补足该事实的方法。不要重复已完成且没有新结果的调用。`
              : verification.evidence.length === 0 && decision === "continue"
                ? "验证器没有给出可核对的证据摘录。下一轮先判断现有工具观察是否已经支持目标；能支持时引用其中的连续原文，不能支持时取得新的相关观察，不能只改写结论后再次提交。"
                : "按验证器指出的具体缺口继续；若现有观察已经足够，直接据此修正候选答复并引用原文，不要为了增加轮次而重复工具调用。";
            const recoveryPlanBlock = verification.recoveryPlan
              ? `\n结构化恢复计划（本轮必须按此执行；若发现计划与原始观察或权限不符，先说明冲突再选择安全路线）：\n${JSON.stringify(verification.recoveryPlan)}`
              : "";
            state.transcript.push({
              role: "tool",
              content: `goal_verification：${decision === "incomplete" ? "阿文声称目标已达成，但验证器判定证据不足" : "尚未通过"}。${reason}${nextStep ? ` 下一步方向：${nextStep}` : "请检查目标范围与已观察结果，选择其他相关方法继续核验。"}${unresolvedBlock}${recoveryPlanBlock}\n${evidenceRepairGuidance}\n证据核对：${JSON.stringify(evidenceAudit)}\n不得把未核实内容写成事实。`
            });
            this.addEvent(state, "progress", "已保存本轮候选答复、逐项未满足要求和证据核对结果；下一轮会据此修订或补充观察。", {
              round: state.round,
              unresolvedRequirementCount: unresolvedRequirements.length
            });
            continue;
          }

          if (decision === "incomplete") {
            state.warningCount += 1;
            state.status = "incomplete";
            state.finalText = evidenceRepairFailed || continueWithoutActionableGap ? appendIncompleteBlockerToFinal(turn.text, reason) : turn.text;
            state.transcript.push({ role: "assistant", content: turn.text });
            this.addEvent(state, "workflow_incomplete", evidenceRepairFailed
              ? "核验器无法提供可定位引文，已保留候选答复并说明核验故障；本轮不计为目标完成。"
              : continueWithoutActionableGap
                ? "核验器没有提供可执行的未满足要求，已停止重规划并保留具体诊断；本轮不计为目标完成。"
                : "验证器确认当前证据不足，已返回明确标注待核查的答复；本轮不计为目标完成。", {
              warningCount: state.warningCount,
              evidenceRepairFailed,
              evidenceRepairCallFailed,
              evidenceCount: verification.evidence.length,
              groundedEvidenceCount,
              ungroundedEvidenceCount,
              unresolvedRequirementSummary: unresolvedRequirements.join("；")
            });
            if (evidenceRepairFailed || continueWithoutActionableGap) state.transcript.push({ role: "assistant", content: state.finalText });
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
    const retryFingerprint = fingerprintToolRequestForRetry(request);
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
      this.addEvent(state, "tool_completed", noProgress ? `${request.toolId} 已运行，但没有产生可用观察。` : `${request.toolId} 已完成。`, { callId, toolId: request.toolId, requestFingerprint, retryFingerprint, noProgress });
      return result;
    }
    if (result.status === "denied") {
      state.transcript.push({ role: "tool", content: `${request.toolId}：策略拒绝执行；请重新规划替代方案。` });
      this.addEvent(state, "tool_denied", result.permission.reason, { callId, toolId: request.toolId });
      return result;
    }
    state.transcript.push({ role: "tool", content: `${request.toolId}：执行失败：${result.error}` });
    state.consecutiveNoProgressCalls += 1;
    this.addEvent(state, "tool_failed", result.error, { callId, toolId: request.toolId, requestFingerprint, retryFingerprint, noProgress: true });
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
  return evidence.every(({ source, sourceId, quote }) => {
    if (!quote.trim()) return false;
    return source === "request"
      ? hasRequestEvidence(sourceId, quote, transcript)
      : hasToolObservationEvidence({ source, sourceId, quote }, toolResults);
  });
}

function auditCompletionEvidence(evidence: ToolWorkflowCompletionEvidence[], transcript: ToolWorkflowMessage[], toolResults: ToolWorkflowToolResult[]): Array<ToolWorkflowCompletionEvidence & { grounded: boolean }> {
  return evidence.map((item) => ({
    ...item,
    grounded: item.source === "request"
      ? hasRequestEvidence(item.sourceId, item.quote, transcript)
      : hasToolObservationEvidence(item, toolResults)
  }));
}

function describeCompletionEvidenceProblem(
  evidence: ToolWorkflowCompletionEvidence[],
  audit: Array<ToolWorkflowCompletionEvidence & { grounded: boolean }>,
  transcript: ToolWorkflowMessage[],
  toolResults: ToolWorkflowToolResult[],
  requiresToolObservation: boolean
): string {
  if (evidence.length === 0) return "核验器没有返回任何证据引文";

  const ungrounded = audit.filter((item) => !item.grounded);
  if (ungrounded.length > 0) {
    const quoteAppearsSomewhere = ungrounded.some((item) => item.source === "request"
      ? transcript.some((message) => message.role === "user" && hasLiteralEvidenceQuote(message.content, item.quote))
      : toolResults.some((result) => hasLiteralEvidenceQuote(formatToolContent(result.toolId, result.output), item.quote)
        || collectTextLeaves(result.output).some((text) => hasLiteralEvidenceQuote(text, item.quote))));
    return quoteAppearsSomewhere
      ? "至少一条引文虽出现在本轮记录中，但未能对应到它标注的来源，或对应工具结果不构成可用于完成目标的有效观察"
      : "至少一条引文无法在本轮作者请求或原始工具观察中找到连续原文";
  }

  if (requiresToolObservation && !audit.some((item) => item.grounded && item.source === "tool")) {
    return "引文只能在作者请求中定位；请求能证明作者要求了什么，不能证明本机或其他工具实际取得了什么结果";
  }

  return "现有引文不能充分支持核验器的完成结论";
}

function hasRequestEvidence(sourceId: string | null | undefined, quote: string, transcript: ToolWorkflowMessage[]): boolean {
  const requests = transcript.filter((message) => message.role === "user");
  if (sourceId) {
    const match = /^request-(\d+)$/u.exec(sourceId);
    const request = match ? requests[Number(match[1]) - 1] : undefined;
    return request !== undefined && hasLiteralEvidenceQuote(request.content, quote);
  }
  return requests.some((message) => hasLiteralEvidenceQuote(message.content, quote));
}

function countVerifierRejectionsSinceProgress(events: ToolWorkflowEvent[]): number {
  let rejections = 0;
  let previousUnresolvedIds: string[] | undefined;
  for (const event of events) {
    if (event.type === "user_instruction_added"
      || (event.type === "tool_output" && event.data?.noProgress !== true)) {
      rejections = 0;
      previousUnresolvedIds = undefined;
      continue;
    }

    if (event.type !== "goal_verification_continued" && event.type !== "goal_verification_incomplete") continue;
    const unresolvedIds = readEventStringArray(event.data?.unresolvedRequirementIdsJson);

    // Rewriting candidate text or paraphrasing a blocker is not progress. Only
    // a stable ID disappearing from the unresolved set proves an earlier item
    // was resolved.
    if (previousUnresolvedIds && hasResolvedRequirementIds(previousUnresolvedIds, unresolvedIds)) rejections = 0;
    rejections += 1;
    previousUnresolvedIds = unresolvedIds;
  }
  return rejections;
}

function normalizeUnresolvedRequirementIds(requirements: string[], candidateIds: string[] | undefined, events: ToolWorkflowEvent[]): string[] {
  if (requirements.length === 0) return [];
  const previous = [...events].reverse().find((event) => event.type === "goal_verification_continued" || event.type === "goal_verification_incomplete");
  const previousRequirements = readEventStringArray(previous?.data?.unresolvedRequirementsJson);
  const previousIds = readEventStringArray(previous?.data?.unresolvedRequirementIdsJson);
  const usedPrevious = new Set<number>();
  return requirements.map((requirement, index) => {
    const exactPrior = previousRequirements.findIndex((prior, priorIndex) => !usedPrevious.has(priorIndex)
      && normalizeRequirement(prior) === normalizeRequirement(requirement));
    if (exactPrior >= 0) {
      usedPrevious.add(exactPrior);
      return previousIds[exactPrior] ?? candidateIds?.[index]?.trim() ?? `R${index + 1}`;
    }
    return candidateIds?.[index]?.trim() || `R${index + 1}`;
  });
}

function readEventStringArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

function normalizeRequirement(value: string): string {
  return Array.from(value.normalize("NFKC").toLocaleLowerCase())
    .filter((character) => /[\p{L}\p{N}]/u.test(character))
    .join("");
}

function hasResolvedRequirementIds(previous: string[], current: string[]): boolean {
  return previous.length > 0 && current.length > 0 && previous.some((requirementId) => !current.includes(requirementId));
}

/**
 * A changed candidate can be meaningful progress even when it reuses existing
 * observations. Ignore whitespace/punctuation-only edits so paraphrasing cannot
 * keep the verifier loop alive indefinitely.
 */
function isSubstantiveCandidateRevision(previous: string, current: string): boolean {
  const normalize = (value: string) => Array.from(value.normalize("NFKC").toLocaleLowerCase())
    .filter((character) => /[\p{L}\p{N}]/u.test(character));
  const before = normalize(previous);
  const after = normalize(current);
  if (!before.length || !after.length || before.join("") === after.join("")) return false;

  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;

  const changedLength = Math.max(before.length - prefix - suffix, after.length - prefix - suffix);
  const minimumChange = Math.max(12, Math.min(120, Math.ceil(Math.min(before.length, after.length) * 0.015)));
  return changedLength >= minimumChange;
}

function hasToolObservationQuote(quote: string, toolResults: ToolWorkflowToolResult[]): boolean {
  return toolResults.some((result) => hasLiteralEvidenceQuote(formatToolContent(result.toolId, result.output), quote)
    || collectTextLeaves(result.output).some((text) => hasLiteralEvidenceQuote(text, quote)));
}

function hasToolObservationEvidence(evidence: ToolWorkflowCompletionEvidence, toolResults: ToolWorkflowToolResult[]): boolean {
  if (evidence.sourceId) {
    const match = /^tool-(\d+)$/u.exec(evidence.sourceId);
    const result = match ? toolResults[Number(match[1]) - 1] : undefined;
    return result !== undefined && hasUsefulObservation(result.output) && (hasLiteralEvidenceQuote(formatToolContent(result.toolId, result.output), evidence.quote)
      || collectTextLeaves(result.output).some((text) => hasLiteralEvidenceQuote(text, evidence.quote)));
  }
  return hasToolObservationQuote(evidence.quote, toolResults);
}

/** Allow line wrapping differences while keeping the quoted words and punctuation literal. */
function hasLiteralEvidenceQuote(source: string, quote: string): boolean {
  return containsLiteralEvidence(source, quote);
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

export function fingerprintToolRequest(request: ModelToolRequest): string {
  const normalized = stableValue({ toolId: request.toolId, action: request.action, target: request.target ?? null, input: request.input });
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/**
 * Practice retry identity excludes only the fresh per-workflow sandbox path
 * generated by the runtime. The operation and its complete input stay bound;
 * permission evaluation still checks the new concrete target before running.
 */
export function fingerprintToolRequestForRetry(request: ModelToolRequest): string {
  const workflowScopedTools = new Set(["practice_run_code", "practice_run_command", "practice_capture_demo", "practice_capture_command_output"]);
  const normalized = stableValue({
    toolId: request.toolId,
    action: request.action,
    target: workflowScopedTools.has(request.toolId) ? null : request.target ?? null,
    input: request.input
  });
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
  serialized = truncateToolObservation(serialized, MAX_TOOL_TRANSCRIPT_CHARS);
  return `${toolId}：${serialized}`;
}

/** Keeps the beginning and end of bounded tool results so list tails survive context compaction. */
export function truncateToolObservation(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = "\n…[中间工具结果已省略]…\n";
  if (maxChars <= marker.length) return value.slice(0, maxChars);
  const available = maxChars - marker.length;
  const headLength = Math.ceil(available / 2);
  const tailLength = available - headLength;
  return `${value.slice(0, headLength)}${marker}${tailLength ? value.slice(-tailLength) : ""}`;
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
