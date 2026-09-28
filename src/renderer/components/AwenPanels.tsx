import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from "react";
import type { AgentMemoryCandidateRecord, AgentMemoryRecord, ArticleChatMessage, ArticlePracticeTask, ToolWorkflowSnapshot } from "../types";
import { request } from "../api";
import { resolveArticleImageUrl } from "../markdown-preview";
import { findUniqueSuggestionRange, getAwenAlternativeSuggestionIds, suggestionOperation } from "./awen-suggestion-utils";

type AwenResizeTarget = "panel" | "transcript";
type GitAnalysisResult = { runId: string; commitSha: string; files: Array<{ path: string; sha256: string; excerpt: string }> };
type LegacyExecutionRunSummary = {
  id: string; projectId: string; runtime: string | null; targetType: string | null; workflowId: string | null; practiceTaskId: string | null;
  status: string; exitCode: number | null; hasError: boolean; truncated: boolean; artifactCount: number; createdAt: string;
  startedAt: string | null; finishedAt: string | null;
  observation: { id: string; title: string; claim: string; status: "pending" | "accepted" | "rejected" } | null;
};
type LegacyExecutionRunDetails = {
  id: string; status: string; exitCode: number | null; errorMessage: string; stdout: string; stderr: string; truncated: boolean;
  artifacts: Array<{ path: string; size: number; sha256: string }>;
  observation: { id: string; title: string; claim: string; status: "pending" | "accepted" | "rejected" } | null;
};

const clampPercentage = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

function formatAwenMessageTime(value: string): { visible: string; full: string } {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { visible: "时间未知", full: "时间未知" };
  const visible = date.toLocaleString(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  return { visible, full: date.toLocaleString() };
}

// 阿文（AI 助手）对话面板（自 main.tsx 拆分）
export function removeUnavailableAwenSuggestions(messages: ArticleChatMessage[], markdown: string): {
  messages: ArticleChatMessage[];
  staleSuggestions: Array<{ messageId: string; index: number }>;
} {
  const staleSuggestions: Array<{ messageId: string; index: number }> = [];
  const normalizedMessages = messages.map((message) => {
    if (message.role !== "assistant" || message.suggestions.length === 0) return message;
    const updated = message.suggestions.map((suggestion, index) => {
      // A persisted status is an explicit author decision. In particular,
      // do not downgrade `accepted` after the author edits the accepted text;
      // the exact replacement is no longer expected to be present then.
      if (suggestion.status && suggestion.status !== "pending") return suggestion;
      const stillAnchored = Boolean(findUniqueSuggestionRange(markdown, suggestion.original));
      if (!stillAnchored) staleSuggestions.push({ messageId: message.id, index });
      return stillAnchored ? suggestion : { ...suggestion, status: "unavailable" as const };
    });
    return updated.some((suggestion, index) => suggestion !== message.suggestions[index]) ? { ...message, suggestions: updated } : message;
  });
  return { messages: normalizedMessages, staleSuggestions };
}

export function markUnansweredAwenMessages(messages: ArticleChatMessage[]): ArticleChatMessage[] {
  // Earlier versions persisted the user message before asking the model but
  // did not persist a failure state. Recover that history: a final user turn
  // with no later Awen turn is safe to expose as retryable.
  let lastUserIndex = -1;
  let hasAssistantAfterLastUser = false;
  messages.forEach((message, index) => {
    if (message.role === "user") {
      lastUserIndex = index;
      hasAssistantAfterLastUser = false;
    } else if (lastUserIndex >= 0) hasAssistantAfterLastUser = true;
  });
  if (lastUserIndex < 0 || hasAssistantAfterLastUser) return messages;
  return messages.map((message, index) => index === lastUserIndex
    ? { ...message, deliveryState: "failed" as const }
    : message);
}

/** Finishes one displayed turn without changing the author's message identity or duplicating the reply. */
export function completeAwenAssistantResponse(
  messages: ArticleChatMessage[],
  assistant: ArticleChatMessage,
  pendingUserMessageId?: string
): ArticleChatMessage[] {
  const pendingUser = messages.find((message) => message.id === pendingUserMessageId)
    ?? messages.find((message) => message.role === "user" && ["sending", "waiting_permission", "authorized"].includes(message.deliveryState ?? ""));
  const completedUser = pendingUser ? { ...pendingUser, deliveryState: undefined } : undefined;
  const keepIds = new Set([pendingUser?.id, assistant.id].filter((id): id is string => Boolean(id)));
  return [
    ...messages.filter((message) => !keepIds.has(message.id)),
    ...(completedUser ? [completedUser] : []),
    assistant
  ];
}

export function getAwenDeliveryStateLabel(message: Pick<ArticleChatMessage, "role" | "deliveryState">, workflowStatus?: ToolWorkflowSnapshot["status"]): string | undefined {
  if (message.deliveryState === "waiting_permission") return "等待你授权工具操作";
  if (message.deliveryState === "authorized") {
    if (workflowStatus === "replanning" || workflowStatus === "planning") return "已取得观察结果，阿文正在重新判断下一步…";
    if (workflowStatus === "running") return "已授权，阿文正在执行下一步…";
    return "已授权，阿文正在执行…";
  }
  if (message.deliveryState !== "sending") return undefined;
  return message.role === "user" ? "已发送，阿文正在处理…" : "阿文正在处理…";
}

const workflowStatusLabels: Record<ToolWorkflowSnapshot["status"], string> = {
  queued: "排队中", planning: "规划中", running: "执行中", waiting_user: "等待授权", replanning: "重新规划中",
  completed: "目标已核验", completed_with_warnings: "目标已核验 · 有提醒", incomplete: "未完成 · 结论待核查", failed: "本轮失败", cancel_requested: "正在取消", cancelled: "已取消", interrupted: "已中断"
};

function getWorkflowDisplayGoal(displayGoal: string | undefined, userRequest: string): string {
  const goal = displayGoal?.trim();
  if (goal) return goal.length > 180 ? `${goal.slice(0, 177)}…` : goal;
  const request = userRequest.trim();
  return request.length > 180 ? "查看本轮执行活动详情" : request || "查看本轮执行活动详情";
}

function workflowStatusLabel(workflow: ToolWorkflowSnapshot): string {
  if (workflow.status === "completed" || workflow.status === "completed_with_warnings") {
    const wasVerified = workflow.events.some((event) => event.type === "goal_verification_passed");
    if (wasVerified) return workflow.status === "completed" ? "目标已核验" : "目标已核验 · 有提醒";
    return workflow.status === "completed" ? "本轮已结束（旧记录无目标核验）" : "本轮已结束 · 有提醒（旧记录无目标核验）";
  }
  return workflowStatusLabels[workflow.status];
}

function getWorkflowPermissionSummary(toolId: string, action: string, input?: unknown): { title: string; impact: string } {
  if (toolId === "git_clone_source") return {
    title: "阿文想获取公开代码仓库",
    impact: "文渡会从公开网站下载仓库文件到显示的工作区，仅用于阅读和分析；不会安装或运行其中的代码。"
  };
  if (toolId === "git_analyze_source") return {
    title: "阿文想分析已获取的代码",
    impact: "文渡只读取工作区中的代码文件并生成分析结果，不会修改项目文件。"
  };
  if (toolId === "practice_run_command") {
    const inputRecord = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const command = typeof inputRecord.command === "string" ? inputRecord.command : "本机工具";
    return {
      title: `阿文想调用 ${command}`,
      impact: `文渡会在本次实践工作目录启动 ${command}，并直接传递单独参数。程序仍以当前 Windows 用户权限运行，可能读取或修改该用户可访问的文件，也可能访问网络；临时目录不构成系统级隔离。请按展开详情中的具体操作和影响授权。`
    };
  }
  if (toolId === "web_search") return {
    title: "阿文想搜索公开网页",
    impact: "文渡会把搜索内容发送给公开搜索服务，并读取返回的公开结果。"
  };
  if (toolId === "read_source_article") return {
    title: "阿文想读取关联文章资料",
    impact: "文渡只读取当前文章库中指定的资料，不会修改文件。"
  };
  if (toolId === "list_system_tools") return {
    title: "阿文想查看可用工具",
    impact: "文渡按名称查找当前电脑上可用的命令入口，只检查文件位置，不会启动工具或探测版本。"
  };
  if (toolId === "registered_cli_task") {
    return {
      title: "旧版本机工具任务",
      impact: "这项任务来自旧版记录。文渡会按当前通用工具规则重新规划，并重新检查操作范围与授权。"
    };
  }
  return {
    title: action === "read" ? "阿文想读取一项资料" : "阿文想执行一项操作",
    impact: "文渡暂时无法用通俗语言概括此操作的影响。请展开查看具体范围和参数，确认后再授权。"
  };
}

function humanizeWorkflowEvent(type: string): string {
  const labels: Record<string, string> = {
    progress: "阿文正在处理当前步骤",
    workflow_created: "执行活动已开始",
    model_round_started: "阿文正在安排下一步",
    model_plan_superseded: "已根据新增要求重新安排",
    model_output_repair_requested: "阿文正在整理回复",
    permission_requested: "等待你确认操作",
    permission_decided: "授权选择已记录",
    user_instruction_added: "已加入新的验证目标",
    tool_started: "正在执行已确认的操作",
    tool_output: "已收到运行结果，正在核验",
    tool_completed: "操作已完成",
    tool_duplicate_blocked: "已拦截重复操作，阿文需要换一种方法",
    goal_verification_passed: "目标核验通过",
    goal_verification_continued: "目标仍需核实，阿文正在继续",
    goal_verification_incomplete: "目标未达成，结论待核查",
    tool_deferred: "等待当前事项处理后继续",
    tool_denied: "未获授权，操作没有执行",
    tool_failed: "操作未完成",
    workflow_completed: "阿文已返回答复",
    workflow_incomplete: "目标未完成，答复待核查",
    workflow_failed: "本轮未完成",
    workflow_cancel_requested: "正在停止",
    workflow_cancelled: "本轮已停止",
    workflow_interrupted: "应用关闭后中断"
  };
  return labels[type] ?? "实践进度已更新";
}

function AwenWorkflowPermissionCard({ workflow, loading, compact, practiceTask, focusRequest, onWorkflowPermission, onCancelWorkflow, onResumeWorkflow }: {
  workflow: ToolWorkflowSnapshot;
  loading: boolean;
  compact?: boolean;
  practiceTask?: boolean;
  focusRequest?: number;
  onWorkflowPermission: (decision: "allow" | "deny", scope?: "run" | "task" | "project", input?: unknown) => void;
  onCancelWorkflow?: () => void;
  onResumeWorkflow?: () => void;
}) {
  const pending = workflow.pendingPermission;
  const permissionCardRef = useRef<HTMLElement>(null);
  const [inputText, setInputText] = useState(() => JSON.stringify(pending?.request.input ?? {}, null, 2));
  const [inputError, setInputError] = useState("");
  useEffect(() => {
    setInputText(JSON.stringify(pending?.request.input ?? {}, null, 2));
    setInputError("");
  }, [pending?.callId]);
  useEffect(() => {
    if (focusRequest && pending) permissionCardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusRequest, pending?.callId]);
  if (!pending && workflow.status !== "interrupted") return null;
  const isPracticeCode = pending?.request.toolId === "practice_run_code";
  const isPracticeProjectEdit = pending?.request.toolId === "practice_edit_project_file";
  const isPracticeDemoCapture = pending?.request.toolId === "practice_capture_demo";
  const isCommandOutputCapture = pending?.request.toolId === "practice_capture_command_output";
  const canEditInput = isPracticeCode || isPracticeProjectEdit || pending?.request.toolId === "practice_capture_webpage";
  const permissionSummary = pending ? getWorkflowPermissionSummary(pending.request.toolId, pending.request.action, pending.request.input) : undefined;
  const inputDirty = Boolean(pending && inputText !== JSON.stringify(pending.request.input ?? {}, null, 2));
  const allow = (scope: "run" | "task" | "project") => {
    if (!inputDirty) { onWorkflowPermission("allow", scope); return; }
    try {
      onWorkflowPermission("allow", scope, JSON.parse(inputText) as unknown);
      setInputError("");
    } catch {
      setInputError("参数必须是有效的 JSON 对象。修正后再授权。");
    }
  };
  return <section ref={permissionCardRef} data-pending-permission-card={pending ? "true" : undefined} className="awen-tool-permission" role={pending ? "alertdialog" : undefined} aria-label={pending ? "阿文请求工具授权" : "阿文工作流已中断"}>
    {pending ? <>
      <strong>{workflow.status === "interrupted" ? "重启后仍需重新授权" : isPracticeCode ? "阿文想运行示例代码" : isPracticeProjectEdit ? "阿文想修改关联代码项目中的文件" : isPracticeDemoCapture ? "阿文想预览并截取本地 Demo" : isCommandOutputCapture ? "阿文想把本机命令结果制成图片" : permissionSummary?.title ?? "阿文请求执行一项操作"}</strong>
      {isPracticeCode && <p>影响范围：代码写入文渡为本次实践建立的临时文件夹，并在这台电脑上运行。程序可能访问当前 Windows 用户有权访问的文件和网络；文渡不能强制断网或完全隔离。</p>}
      {isPracticeProjectEdit && <p>影响范围：只修改这篇文章已关联目录中的现有文本文件，不会新建或删除文件、安装依赖、运行项目代码或提交到网络。文渡会备份原文件，显示修改并提供恢复。</p>}
      {isPracticeDemoCapture && <p>影响范围：只预览本次任务临时目录中的 HTML 页面，并把截图保存到本篇文章素材。预览会阻止外网请求、下载、弹窗和系统权限，也不会打开关联项目里的既有页面。</p>}
      {isCommandOutputCapture && <p>影响范围：只读取本次已成功命令的实际输出，生成明确标注的结果展示图，并保存到本篇文章素材；这不是 Windows 终端窗口截图，也不会再次运行命令。</p>}
      {!isPracticeCode && !isPracticeProjectEdit && !isPracticeDemoCapture && !isCommandOutputCapture && <p>{permissionSummary?.impact ?? pending.permission.reason}</p>}
      <small>{isPracticeCode ? "运行方式：本机 · 临时实践文件夹" : isPracticeProjectEdit ? "修改方式：本篇文章的关联目录 · 本次任务内有效" : isPracticeDemoCapture || isCommandOutputCapture ? "截图去向：本篇文章素材 · 仅本次任务范围" : "具体目录和参数可展开查看；你可以按本次任务范围授权。"}</small>
      <details><summary>{isPracticeCode ? "查看运行环境、实际目录和代码" : isPracticeProjectEdit ? "查看项目目录和文件内容" : isPracticeDemoCapture || isCommandOutputCapture ? "查看工作区路径和截图参数" : "查看具体范围和参数"}</summary>
        <pre>授权目标（本次不可改）：{pending.request.target || "当前工作区"}</pre>
        {canEditInput
          ? <label className="awen-permission-input-editor">调整本次操作参数（JSON）
            <textarea value={inputText} rows={isPracticeCode ? 12 : 8} spellCheck={false} onChange={(event) => { setInputText(event.currentTarget.value); setInputError(""); }} />
            <small>{isPracticeCode ? "可调整运行环境和示例代码；仍只在上方显示的临时目录运行。" : isPracticeProjectEdit ? "可调整项目内相对文件名和内容；项目目录边界保持不变。" : "可调整页面地址与只读操作；授权站点边界保持不变。"}</small>
            {inputError && <small role="alert">{inputError}</small>}
          </label>
          : <pre>{JSON.stringify(pending.request.input, null, 2)}</pre>}
        {inputDirty && <p className="hint">授权前参数已修改；点击授权后，文渡会先按该工具的输入规则校验。</p>}
      </details>
      {workflow.status === "waiting_user" && <div className="awen-pending-review-actions">
        <button type="button" onClick={() => allow("task")} disabled={loading}>{isPracticeCode ? "允许本次任务在临时目录继续运行" : isPracticeProjectEdit ? "允许本次任务修改此目录中的现有文件" : isPracticeDemoCapture ? "允许本次任务预览 Demo 并保存截图" : isCommandOutputCapture ? "允许本次任务生成命令结果图片" : "允许本次任务在此范围内继续"}</button>
        <button type="button" className="secondary-button" onClick={() => allow("run")} disabled={loading}>仅允许阿文这次操作</button>
        <button type="button" className="secondary-button" onClick={() => onWorkflowPermission("deny")} disabled={loading}>{compact ? "拒绝并让阿文调整方案" : "拒绝并调整方案"}</button>
        {onCancelWorkflow && <button type="button" className="text-button" onClick={onCancelWorkflow} disabled={loading}>{practiceTask ? "停止实践" : "取消工作流"}</button>}
      </div>}
      {workflow.status === "interrupted" && onResumeWorkflow && <button type="button" onClick={onResumeWorkflow} disabled={loading}>恢复并重新授权</button>}
    </> : <>
      <strong>为避免重放副作用，未自动继续</strong>
      <p>恢复会重新规划并重新评估权限；可能写入本机或网络的动作不会被静默重放。</p>
      {onResumeWorkflow && <button type="button" onClick={onResumeWorkflow} disabled={loading}>恢复并重新规划</button>}
    </>}
  </section>;
}

type AwenToolWorkflowActivityProps = {
  workflow?: ToolWorkflowSnapshot;
  displayGoal?: string;
  projectId?: string;
  articlePath?: string;
  loading: boolean;
  onWorkflowPermission: (decision: "allow" | "deny", scope?: "run" | "task" | "project", input?: unknown) => void;
  onCancelWorkflow: () => void;
  onResumeWorkflow: () => void;
  onOpenAwen?: (prefill?: string) => void;
  focusPermissionRequest?: number;
  onExpand?: () => void;
  practiceTask?: boolean;
  showHeader?: boolean;
  showGoal?: boolean;
};

export function AwenToolWorkflowActivity({ workflow, displayGoal, projectId, articlePath, loading, onWorkflowPermission, onCancelWorkflow, onResumeWorkflow, onOpenAwen, onExpand, practiceTask = false, showHeader = true, showGoal = true, focusPermissionRequest }: AwenToolWorkflowActivityProps) {
  if (!workflow) return <div className="side-panel-content awen-activity-empty"><h3>执行活动</h3><p className="hint">{getAwenActivityEmptyMessage(loading)}</p></div>;
  const visibleGoal = getWorkflowDisplayGoal(displayGoal, workflow.userRequest);
  const gitAnalysis = readGitAnalysis(workflow);
  const active = ["queued", "planning", "running", "waiting_user", "replanning", "cancel_requested"].includes(workflow.status);
  return <div className={`side-panel-content awen-activity-panel${showHeader ? "" : " awen-activity-modal-body"}`}>
    {showHeader && <div className="assistant-heading"><div><p className="eyebrow">阿文 · 执行活动</p><h3>{workflowStatusLabel(workflow)}</h3></div><div className="awen-activity-heading-actions">{onExpand && <button type="button" className="secondary-button compact-action" onClick={onExpand}>展开查看</button>}</div></div>}
    {showGoal && <p className="hint compact-hint">验证目标：{visibleGoal}</p>}
    <AwenWorkflowPermissionCard workflow={workflow} loading={loading} practiceTask={practiceTask} focusRequest={focusPermissionRequest} onWorkflowPermission={onWorkflowPermission} onCancelWorkflow={onCancelWorkflow} onResumeWorkflow={onResumeWorkflow} />
    {gitAnalysis && projectId && <AwenGitEvidenceCard analysis={gitAnalysis} projectId={projectId} />}
    {projectId && workflow.toolResults.filter((result) => result.toolId === "practice_edit_project_file").map((result) => {
      const change = readPracticeProjectFileChange(result.output);
      return change ? <AwenPracticeProjectFileChangeCard key={change.id} change={change} projectId={projectId} /> : null;
    })}
    {articlePath && workflow.toolResults.filter((result) => result.toolId === "practice_capture_webpage" || result.toolId === "practice_capture_demo" || result.toolId === "practice_capture_command_output").map((result, index) => {
      const capture = result.toolId === "practice_capture_webpage" ? readPracticeWebCaptureResult(result.output) : readPracticeDemoCaptureResult(result.output);
      return capture ? <AwenPracticeScreenshotCard key={`${workflow.workflowId}:capture:${index}`} capture={capture} articlePath={articlePath} /> : null;
    })}
    {onOpenAwen && <AwenAdvancedOperationPrompt onOpenAwen={onOpenAwen} />}
    {active && workflow.status !== "waiting_user" && workflow.status !== "cancel_requested" && <button type="button" className="text-button" onClick={onCancelWorkflow} disabled={loading}>{practiceTask ? "停止实践" : "取消工作流"}</button>}
    <section className="awen-activity-events" aria-label="执行进度"><h4>执行进度</h4><ol>{workflow.events.map((event) => <li key={event.id}><time>{new Date(event.at).toLocaleTimeString()}</time><div><strong>{humanizeWorkflowEvent(event.type)}</strong><details><summary>查看记录详情</summary><span>{event.message}</span>{event.data && <pre>{JSON.stringify(event.data, null, 2)}</pre>}</details></div></li>)}</ol></section>
    <details className="awen-activity-transcript"><summary>查看高级运行记录（{workflow.transcript.length} 条）</summary>{workflow.transcript.map((message, index) => <article key={`${workflow.workflowId}:${index}`}><small>{message.role}</small><pre>{message.content}</pre></article>)}</details>
  </div>;
}

function AwenAdvancedOperationPrompt({ onOpenAwen }: { onOpenAwen: (prefill?: string) => void }) {
  const [guidance, setGuidance] = useState("");
  return <details className="awen-activity-manual-controls">
    <summary>高级操作与排查</summary>
    <p>指定运行环境、参数、目录或排查要求。内容会先放入阿文对话，检查后由你发送；操作范围仍由文渡判定。</p>
    <label>给阿文的执行要求
      <textarea value={guidance} maxLength={2000} rows={3} placeholder="例如：请用 Python 3.12，输入文件放在临时工作区的 sample.csv；先只输出前 5 行。" onChange={(event) => setGuidance(event.currentTarget.value)} />
    </label>
    <button type="button" className="secondary-button" disabled={!guidance.trim()} onClick={() => onOpenAwen(guidance.trim())}>在对话中检查并发送</button>
  </details>;
}

export function AwenToolWorkflowActivityModal({ onClose, loadError, onRetryLoad, ...activityProps }: AwenToolWorkflowActivityProps & { onClose: () => void; loadError?: string; onRetryLoad?: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const workflow = activityProps.workflow;
  return <div className="modal-backdrop priority-modal awen-activity-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal-card awen-activity-modal" role="dialog" aria-modal="true" aria-label="阿文完整执行活动">
      <div className="section-heading awen-activity-modal-header">
        <div><p className="eyebrow">阿文 · 执行活动</p><h2>{workflow ? workflowStatusLabel(workflow) : loadError ? "暂时无法读取执行记录" : "正在读取授权记录"}</h2>{workflow && <p className="hint compact-hint">验证目标：{getWorkflowDisplayGoal(activityProps.displayGoal, workflow.userRequest)}</p>}</div>
        <button type="button" className="text-button" onClick={onClose}>关闭</button>
      </div>
      {workflow ? <AwenToolWorkflowActivity {...activityProps} showHeader={false} showGoal={false} /> : <div className="side-panel-content awen-activity-empty"><p>{loadError ?? "正在读取授权记录，请稍候…"}</p>{loadError && onRetryLoad && <button type="button" onClick={onRetryLoad}>重新读取</button>}</div>}
    </section>
  </div>;
}

type PracticeProjectFileChangeView = {
  id: string;
  taskId: string;
  relativePath: string;
  beforeSha256: string;
  afterSha256: string;
  diff: { before: string; after: string };
};

function readPracticeProjectFileChange(value: unknown): PracticeProjectFileChangeView | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.taskId !== "string" || typeof record.relativePath !== "string" ||
    typeof record.beforeSha256 !== "string" || typeof record.afterSha256 !== "string" || !record.diff || typeof record.diff !== "object") return undefined;
  const diff = record.diff as Record<string, unknown>;
  if (typeof diff.before !== "string" || typeof diff.after !== "string") return undefined;
  return { id: record.id, taskId: record.taskId, relativePath: record.relativePath, beforeSha256: record.beforeSha256, afterSha256: record.afterSha256, diff: { before: diff.before, after: diff.after } };
}

type PracticeWebCaptureView = {
  kind: "web";
  title: string;
  url: string;
  observedAt: string;
  observation: string;
  assetUrl: string;
  screenshotSha256: string;
  operationSummary: string;
};

function readPracticeWebCaptureResult(value: unknown): PracticeWebCaptureView | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.title !== "string" || typeof record.url !== "string" || typeof record.observedAt !== "string" ||
    typeof record.observation !== "string" || typeof record.assetUrl !== "string" || typeof record.screenshotSha256 !== "string" || typeof record.operationSummary !== "string" ||
    !/^[a-f0-9]{64}$/iu.test(record.screenshotSha256) || !/^\.\/(?:[\w-]+\/)*[a-f0-9-]{36}\.png$/iu.test(record.assetUrl)) return undefined;
  try { if (new URL(record.url).protocol !== "https:") return undefined; } catch { return undefined; }
  return { kind: "web", title: record.title, url: record.url, observedAt: record.observedAt, observation: record.observation, assetUrl: record.assetUrl, screenshotSha256: record.screenshotSha256, operationSummary: record.operationSummary };
}

type PracticeDemoCaptureView = Omit<PracticeWebCaptureView, "kind" | "url"> & { kind: "demo" | "command_output" };

function readPracticeDemoCaptureResult(value: unknown): PracticeDemoCaptureView | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.url === "string" && /^local-command-output:[0-9a-f-]{36}$/iu.test(record.url)) {
    if (typeof record.title !== "string" || typeof record.observedAt !== "string" || typeof record.observation !== "string" ||
      typeof record.assetUrl !== "string" || typeof record.screenshotSha256 !== "string" || typeof record.operationSummary !== "string" ||
      !/^[a-f0-9]{64}$/iu.test(record.screenshotSha256) || !/^\.\/(?:[\w-]+\/)*[a-f0-9-]{36}\.png$/iu.test(record.assetUrl)) return undefined;
    return { kind: "command_output", title: record.title, observedAt: record.observedAt, observation: record.observation, assetUrl: record.assetUrl, screenshotSha256: record.screenshotSha256, operationSummary: record.operationSummary };
  }
  const demoPath = typeof record.url === "string" && record.url.startsWith("local-demo:") ? record.url.slice("local-demo:".length) : "";
  if (typeof record.title !== "string" || typeof record.observedAt !== "string" || typeof record.observation !== "string" ||
    typeof record.assetUrl !== "string" || typeof record.screenshotSha256 !== "string" || typeof record.operationSummary !== "string" ||
    !/^[a-f0-9]{64}$/iu.test(record.screenshotSha256) || !/^\.\/(?:[\w-]+\/)*[a-f0-9-]{36}\.png$/iu.test(record.assetUrl) ||
    !demoPath || demoPath.startsWith("/") || demoPath.includes("\\") || demoPath.split("/").some((segment) => segment === ".." || segment === ".") || !/\.html?$/iu.test(demoPath)) return undefined;
  return { kind: "demo", title: record.title, observedAt: record.observedAt, observation: record.observation, assetUrl: record.assetUrl, screenshotSha256: record.screenshotSha256, operationSummary: record.operationSummary };
}

function AwenPracticeScreenshotCard({ capture, articlePath }: { capture: PracticeWebCaptureView | PracticeDemoCaptureView; articlePath: string }) {
  const imageUrl = resolveArticleImageUrl(capture.assetUrl, "", articlePath);
  const isDemo = capture.kind === "demo";
  const isCommandOutput = capture.kind === "command_output";
  const sourceName = isDemo ? "本地 Demo" : isCommandOutput ? "本机命令输出" : capture.kind === "web" ? new URL(capture.url).hostname : "实践截图";
  return <section className="awen-tool-permission awen-practice-web-capture" aria-label={`${sourceName}实践观察和截图`}>
    <strong>{sourceName}：{capture.title || (isDemo ? "本地演示" : isCommandOutput ? "命令结果" : capture.kind === "web" ? new URL(capture.url).hostname : "实践")}</strong>
    <small>{isDemo ? "本次任务临时工作区" : sourceName} · {capture.operationSummary} · {new Date(capture.observedAt).toLocaleString()}</small>
    <img src={imageUrl} alt={`阿文${sourceName}实践截图：${capture.title}`} loading="lazy" />
    <details><summary>查看观察与来源信息</summary><p>{capture.observation || "没有可读取的文字观察。"}</p>{capture.kind === "web" && <a href={capture.url} target="_blank" rel="noreferrer">打开原网页</a>}<small>截图 SHA-256：{capture.screenshotSha256}</small></details>
  </section>;
}

function AwenPracticeProjectFileChangeCard({ change, projectId }: { change: PracticeProjectFileChangeView; projectId: string }) {
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(false);
  const [error, setError] = useState("");
  const restore = async () => {
    setBusy(true);
    setError("");
    try {
      await request(`/content-projects/${projectId}/practice-task/${change.taskId}/project-file-changes/${change.id}/restore`, { method: "POST" });
      setRestored(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "恢复文件改动失败。");
    } finally {
      setBusy(false);
    }
  };
  return <section className="awen-tool-permission awen-project-file-change" aria-label="阿文项目文件改动">
    <strong>阿文修改了一个项目文件</strong>
    <p>{change.relativePath}</p>
    <details><summary>查看修改前后内容</summary><div className="awen-project-file-diff"><section><strong>修改前</strong><pre>{change.diff.before || "（空文件）"}</pre></section><section><strong>修改后</strong><pre>{change.diff.after || "（空文件）"}</pre></section></div></details>
    <small>原文件已备份。恢复前会检查文件是否仍是阿文修改后的版本，以免覆盖你后续的编辑。</small>
    {restored ? <p role="status">已恢复原文件。</p> : <button type="button" className="secondary-button" onClick={() => void restore()} disabled={busy}>{busy ? "正在恢复…" : "恢复原文件"}</button>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}

export function AwenPracticeProjectDirectoryCard({ projectId }: { projectId: string }) {
  const [directory, setDirectory] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void request<{ directory: string | null }>(`/content-projects/${projectId}/practice-directory`)
      .then((result) => { if (active) setDirectory(result.directory); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "无法读取代码目录设置。"); });
    return () => { active = false; };
  }, [projectId]);
  const save = async (next: string | null) => {
    setBusy(true);
    setError("");
    try {
      const result = await request<{ project: { practiceProjectDirectory: string | null } }>(`/content-projects/${projectId}/practice-directory`, { method: "PUT", body: JSON.stringify({ directory: next }) });
      setDirectory(result.project.practiceProjectDirectory);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存代码目录失败。");
    } finally { setBusy(false); }
  };
  const choose = async () => {
    const picker = window.contentFerry?.selectDirectory;
    if (!picker) { setError("请在文渡桌面应用中选择代码目录。"); return; }
    setBusy(true);
    setError("");
    try {
      const selected = await picker();
      if (selected) await save(selected);
      else setBusy(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "选择代码目录失败。");
      setBusy(false);
    }
  };
  return <section className="awen-tool-permission awen-practice-directory" aria-label="文章代码项目目录">
    <details>
      <summary>关联现有代码项目（可选）{directory ? " · 已设置" : ""}</summary>
      <p>需要阿文验证这篇文章的现有代码时再选择。阿文获本次任务授权后，才会修改已有文本文件；你可以查看改动并恢复。</p>
      {directory && <details><summary>查看本地目录</summary><code>{directory}</code></details>}
      <div className="awen-pending-review-actions">
        <button type="button" onClick={() => void choose()} disabled={busy}>{busy ? "处理中…" : directory ? "更换目录" : "选择目录"}</button>
        {directory && <button type="button" className="secondary-button" onClick={() => void save(null)} disabled={busy}>取消关联</button>}
      </div>
    </details>
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}

export function getAwenActivityEmptyMessage(loading: boolean): string {
  return loading ? "正在创建新的执行活动…" : "阿文调用本地工具后，目标、权限、进度和结果会显示在这里。";
}

export function ArticlePracticeTaskCard({ task, busy, onDecision, onOpenAwen, onOpenExecutionActivity }: {
  task: ArticlePracticeTask;
  busy: boolean;
  onDecision: (decision: "continue_draft" | "stop_draft" | "new_goal" | "resume", value?: string) => Promise<void>;
  onOpenAwen: (prefill?: string) => void;
  onOpenExecutionActivity?: () => void;
}) {
  const [goal, setGoal] = useState("");
  const [reconciliation, setReconciliation] = useState("");
  const recordedGoals = (task.events ?? []).flatMap((event) => {
    if (event.kind !== "created" && event.kind !== "goal_added") return [];
    const value = event.payload.goal;
    return typeof value === "string" ? [{ sequence: event.sequence, goal: value }] : [];
  });
  const goalsSummary = recordedGoals.length > 1 ? <details className="awen-practice-goals"><summary>本任务的验证目标（{recordedGoals.length}）</summary><ol>{recordedGoals.map((item) => <li key={item.sequence}>{item.goal}</li>)}</ol></details> : null;
  if (task.status === "waiting_stop_choice") return <section className="awen-tool-permission" aria-label="实践停止后的选择">
    <strong>实践已停止，请选择正文接下来的处理方式</strong>
    {goalsSummary}
    <p>已完成的观察会保留。继续起草时，尚未验证的结论会标为待核查。</p>
    <div className="awen-pending-review-actions">
      <button type="button" onClick={() => void onDecision("continue_draft")} disabled={busy}>继续起草并标待核查</button>
      <button type="button" className="secondary-button" onClick={() => void onDecision("stop_draft")} disabled={busy}>停止起草</button>
    </div>
    <label>补充新的实践要求<textarea value={goal} onChange={(event) => setGoal(event.target.value)} maxLength={4000} placeholder="例如：改用 Python 3.12 再验证一次" /></label>
    <button type="button" className="secondary-button" onClick={() => void onDecision("new_goal", goal.trim())} disabled={busy || !goal.trim()}>按新要求继续</button>
  </section>;
  if (task.status === "waiting_resume_choice") return <section className="awen-tool-permission" aria-label="恢复实践的选择">
    <strong>上次实践中断了，是否从保存的位置继续？</strong>
    {goalsSummary}
    <p>已完成步骤不会重做；可能改动文件而结果不确定的步骤会先核对。</p>
    {task.checkpoint.uncertainSideEffect && <>
      <label>核对该步骤的当前状态<textarea value={reconciliation} onChange={(event) => setReconciliation(event.target.value)} maxLength={1000} placeholder="记录你确认到的实际结果" /></label>
      <button type="button" onClick={() => void onDecision("resume", reconciliation.trim())} disabled={busy || !reconciliation.trim()}>记录核对结果并继续</button>
    </>}
    {!task.checkpoint.uncertainSideEffect && <button type="button" onClick={() => void onDecision("resume")} disabled={busy}>从中断处续做</button>}
    <div className="awen-pending-review-actions">
      <button type="button" className="secondary-button" onClick={() => void onDecision("continue_draft")} disabled={busy}>用已完成结果起草，缺口标待核查</button>
      <button type="button" className="secondary-button" onClick={() => void onDecision("stop_draft")} disabled={busy}>停止起草</button>
    </div>
  </section>;
  if (task.status === "waiting_feedback") return <section className="awen-tool-permission" aria-label="等待实践反馈">
    <strong>阿文遇到一个无法完成的步骤，正在等待你的指示</strong><p>{task.waitingReason}</p>
    {goalsSummary}
    {task.feedbackDeadline && <small>等待反馈至 {new Date(task.feedbackDeadline).toLocaleTimeString()}；届时若没有指示，会继续起草并标记待核查。</small>}
    <div className="awen-pending-review-actions">
      <button type="button" className="secondary-button" onClick={() => onOpenAwen()}>告诉阿文如何处理</button>
      <button type="button" className="secondary-button" onClick={() => onOpenAwen(RETRY_FAILED_PRACTICE_STEP_PROMPT)}>重试上次失败的步骤</button>
    </div>
  </section>;
  if (task.status === "waiting_edit_confirmation") return <section className="awen-tool-permission" aria-label="实践建议待确认">
    <strong>实践结果已整理成正文建议</strong>
    {goalsSummary}
    <p>请像处理其他阿文建议一样，查看锚定段落与运行条件，再应用或拒绝。应用后保存文章，任务才会记录为已采纳到草稿。</p>
    <button type="button" className="secondary-button" onClick={() => onOpenAwen()}>查看阿文建议</button>
  </section>;
  const statusLabel = task.status === "queued" ? "等待阿文判断是否需要实践"
    : task.status === "assessing" ? "阿文正在判断是否需要实践"
      : task.status === "practicing" ? "阿文正在实践"
        : task.status === "waiting_permission" ? "等待你处理授权请求"
          : task.status === "drafting" ? getArticlePracticeDraftingLabel(task)
            : "实践任务进度";
  return <section className="awen-tool-permission awen-practice-progress" aria-label="实践任务进度">
    <strong>{statusLabel}</strong>
    <p>{task.latestGoal}</p>
    {goalsSummary}
    {task.status === "waiting_permission" && <button type="button" className="secondary-button" onClick={() => (onOpenExecutionActivity ?? onOpenAwen)()}>查看授权与执行活动</button>}
  </section>;
}

export function getArticlePracticeDraftingLabel(task: ArticlePracticeTask): string {
  const events = task.events ?? [];
  const practiceStarted = events.some((event) => event.kind === "practice_started" || event.kind === "additional_practice_started");
  const practiceCompleted = events.some((event) => event.kind === "practice_result");
  if (!practiceStarted) return task.hasGaps
    ? "判断未完成，正在准备正文；相关结论将标待核查"
    : "阿文判断无需实践，正在准备正文";
  if (!practiceCompleted) return "实践未能完成，正在准备正文；相关结论将标待核查";
  return task.hasGaps
    ? "实践已取得结果，部分结论待核查；正在准备正文"
    : "实践已完成，正在准备正文";
}

export const RETRY_FAILED_PRACTICE_STEP_PROMPT = "请只重试上一次实践中失败的步骤，不要重新执行已经完成的步骤。如果失败原因要求调整参数或扩大影响范围，请先说明并等我确认。";

type PracticeEventView = NonNullable<ArticlePracticeTask["events"]>[number];

export function summarizePracticeEvent(event: PracticeEventView): string {
  const names: Record<string, string> = {
    created: "实践目标已记录",
    goal_added: "新增实践目标",
    assessment_started: "阿文开始判断是否需要实践",
    practice_started: "开始实践",
    additional_practice_started: "开始补充实践",
    permission_needed: "等待授权",
    permission_resolved: "授权已处理",
    practice_blocked: "遇到阻碍，等待反馈",
    feedback_received: "收到处理指示，继续实践",
    feedback_expired: "等待反馈结束，缺口将标为待核查",
    stop_requested: "实践已停止，等待正文处理选择",
    stop_choice: "已处理停止后的选择",
    resume_choice_needed: "应用重启，等待恢复选择",
    resume_choice: "已处理恢复选择",
    resumed: "从检查点恢复",
    reconciled: "已核对中断步骤",
    checkpoint: "已保存安全检查点",
    draft_started: "开始起草正文",
    legacy_execution_linked: "旧版执行记录已归入本篇历史",
    edit_suggestion_ready: "实践结果已整理成正文建议",
    edit_suggestion_accepted: "正文建议已确认",
    edit_suggestion_rejected: "正文建议已拒绝",
    edit_suggestion_unavailable: "正文建议无法定位",
    draft_completed: "正文起草完成"
  };
  if (event.kind === "practice_result" && event.payload.kind === "project_file_change_restored") return "已恢复项目文件改动";
  if (event.kind === "practice_result") return "已保存实践结果";
  return names[event.kind] ?? "实践任务已更新";
}

export interface PracticeAttemptComparison {
  sequence: number;
  createdAt: string;
  summary: string;
  conditions: string[];
}

export function getPracticeAttemptComparisons(events: readonly PracticeEventView[]): PracticeAttemptComparison[] {
  return events.filter((event) => event.kind === "practice_result" && typeof event.payload.summary === "string")
    .map((event) => {
      const summaryValue = event.payload.summary as string;
      let summary = summaryValue;
      try {
        const parsed: unknown = JSON.parse(summaryValue);
        const record = asPlainRecord(parsed);
        if (typeof record?.reply === "string") summary = record.reply;
      } catch { /* Historical workflow summaries may be plain text. */ }
      const outputs = Array.isArray(event.payload.results) ? event.payload.results : [];
      const conditions = [...new Set(outputs.flatMap((item) => {
        const tool = asPlainRecord(item);
        const result = asPlainRecord(tool?.result);
        if (!result) return [];
        return ["runtime", "status", "exitCode", "operationSummary", "conditions", "observedAt"]
          .flatMap((key) => typeof result[key] === "string" || typeof result[key] === "number" ? [`${key}=${String(result[key])}`] : []);
      }))];
      return { sequence: event.sequence, createdAt: event.createdAt, summary: summary.slice(0, 1200), conditions };
    });
}

export function getUnlinkedLegacyToolWorkflows(
  workflows: readonly ToolWorkflowSnapshot[],
  tasks: readonly ArticlePracticeTask[]
): ToolWorkflowSnapshot[] {
  const linkedWorkflowIds = new Set(tasks.map((task) => task.checkpoint.workflowId).filter((id): id is string => Boolean(id)));
  return workflows.filter((workflow) => !linkedWorkflowIds.has(workflow.workflowId) &&
    (workflow.events.length > 0 || workflow.toolResults.length > 0));
}

export function getUnlinkedLegacyExecutionRuns(
  runs: readonly LegacyExecutionRunSummary[],
  workflows: readonly ToolWorkflowSnapshot[],
  tasks: readonly ArticlePracticeTask[]
): LegacyExecutionRunSummary[] {
  const linkedWorkflowIds = new Set([
    ...workflows.map((workflow) => workflow.workflowId),
    ...tasks.map((task) => task.checkpoint.workflowId).filter((id): id is string => Boolean(id))
  ]);
  const linkedTaskIds = new Set(tasks.map((task) => task.id));
  const importedRunIds = new Set(tasks.map((task) => task.legacyExecutionRunId).filter((id): id is string => Boolean(id)));
  return runs.filter((run) =>
    !importedRunIds.has(run.id) &&
    !(run.workflowId && linkedWorkflowIds.has(run.workflowId)) &&
    !(run.practiceTaskId && linkedTaskIds.has(run.practiceTaskId))
  );
}

function PracticeAttemptComparisonList({ events }: { events: readonly PracticeEventView[] }) {
  const attempts = getPracticeAttemptComparisons(events);
  if (attempts.length < 2) return null;
  return <section className="awen-practice-attempt-comparison" aria-label="多次实践结果对照">
    <h4>多次实践结果对照</h4>
    <p>每次观察都单独保留。结论不一致时，请结合时间和条件核对，不以后一次覆盖前一次。</p>
    <div className="awen-practice-attempt-grid">{attempts.map((attempt, index) => <article key={attempt.sequence}>
      <strong>第 {index + 1} 次 · {new Date(attempt.createdAt).toLocaleString()}</strong>
      <p>{attempt.summary}</p>
      {attempt.conditions.length > 0 && <small>{attempt.conditions.join(" · ")}</small>}
    </article>)}</div>
  </section>;
}

export function ArticlePracticeHistory({ projectId, articlePath, refreshKey }: { projectId: string; articlePath?: string | null; refreshKey?: string }) {
  const [tasks, setTasks] = useState<ArticlePracticeTask[]>([]);
  const [legacyWorkflows, setLegacyWorkflows] = useState<ToolWorkflowSnapshot[]>([]);
  const [legacyRuns, setLegacyRuns] = useState<LegacyExecutionRunSummary[]>([]);
  const [legacyRunDetails, setLegacyRunDetails] = useState<Record<string, LegacyExecutionRunDetails | { error: string } | { loading: true }>>({});
  const [error, setError] = useState("");
  const contextKey = articlePath ? `source:${articlePath}` : `project:${projectId}`;
  useEffect(() => {
    let active = true;
    void request<{ tasks: ArticlePracticeTask[] }>(`/content-projects/${projectId}/practice-task/history`)
      .then((history) => {
        if (!active) return;
        setTasks(history.tasks);
        setError("");
        const workflowContextKeys = [...new Set([contextKey, `project:${projectId}`])];
        void Promise.all([
          request<{ task: ArticlePracticeTask | null }>(`/content-projects/${projectId}/practice-task`),
          Promise.all(workflowContextKeys.map((key) => request<{ items: Array<{ snapshot: ToolWorkflowSnapshot }> }>(`/article-chat/workflows?contextKey=${encodeURIComponent(key)}`)))
        ]).then(([current, workflowLists]) => {
          if (!active) return;
          const knownTasks = [...history.tasks, ...(current.task ? [current.task] : [])];
          const workflows = new Map(workflowLists.flatMap((list) => list.items).map((item) => [item.snapshot.workflowId, item.snapshot]));
          const workflowSnapshots = [...workflows.values()];
          setLegacyWorkflows(getUnlinkedLegacyToolWorkflows(workflowSnapshots, knownTasks));
          void request<{ items: LegacyExecutionRunSummary[] }>(`/content-projects/${projectId}/practice-task/legacy-executions`)
            .then((executionHistory) => { if (active) setLegacyRuns(getUnlinkedLegacyExecutionRuns(executionHistory.items, workflowSnapshots, knownTasks)); })
            .catch(() => { if (active) setLegacyRuns([]); });
        }).catch(() => {
          if (!active) return;
          setLegacyWorkflows([]);
          void request<{ items: LegacyExecutionRunSummary[] }>(`/content-projects/${projectId}/practice-task/legacy-executions`)
            .then((executionHistory) => { if (active) setLegacyRuns(getUnlinkedLegacyExecutionRuns(executionHistory.items, [], history.tasks)); })
            .catch(() => { if (active) setLegacyRuns([]); });
        });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setTasks([]);
        setLegacyWorkflows([]);
        setError(cause instanceof Error ? cause.message : "暂时无法读取实践历史。");
      });
    return () => { active = false; };
  }, [contextKey, projectId, refreshKey]);
  const loadLegacyExecutionDetails = async (runId: string) => {
    setLegacyRunDetails((current) => ({ ...current, [runId]: { loading: true } }));
    try {
      const details = await request<LegacyExecutionRunDetails>(`/content-projects/${projectId}/practice-task/legacy-executions/${runId}`);
      setLegacyRunDetails((current) => ({ ...current, [runId]: details }));
    } catch (cause) {
      setLegacyRunDetails((current) => ({ ...current, [runId]: { error: cause instanceof Error ? cause.message : "无法读取旧执行输出。" } }));
    }
  };
  if (tasks.length === 0 && legacyWorkflows.length === 0 && legacyRuns.length === 0 && !error) return null;
  return <section className="awen-tool-permission awen-practice-history" aria-label="以往实践记录">
    {error && <p role="status">实践历史暂时不可用：{error}</p>}
    {legacyWorkflows.length > 0 && <details>
      <summary>早期工具运行记录（{legacyWorkflows.length}）</summary>
      <p>这些记录来自旧版执行流程，只供回看，不会作为本次文章的已验证结论。</p>
      <ol>{legacyWorkflows.map((workflow) => <li key={workflow.workflowId}>
        <details>
          <summary>{workflow.userRequest || "旧版工具运行"} · {legacyWorkflowStatus(workflow.status)}</summary>
          <small>{legacyWorkflowTime(workflow)} · 工作流 {workflow.workflowId.slice(0, 8)}</small>
          {workflow.finalText && <p>{workflow.finalText}</p>}
          {workflow.events.length > 0 && <ol className="awen-practice-history-events">{workflow.events.map((event) => <li key={event.id}>
            <strong>{event.message || event.type}</strong><small>{new Date(event.at).toLocaleString()}</small>
          </li>)}</ol>}
          {workflow.toolResults.length > 0 && <details><summary>工具结果（{workflow.toolResults.length}）</summary>
            <ol>{workflow.toolResults.map((result) => <li key={result.callId}>
              <strong>{result.toolId}</strong><pre>{legacyWorkflowOutput(result.output)}</pre>
            </li>)}</ol>
          </details>}
        </details>
      </li>)}</ol>
    </details>}
    {legacyRuns.length > 0 && <details>
      <summary>早期本机执行记录（{legacyRuns.length}）</summary>
      <p>这些记录来自旧版代码与工具流程，只供回看；输出按需读取，不会自动作为已验证结论。</p>
      <ol>{legacyRuns.map((run) => {
        const details = legacyRunDetails[run.id];
        return <li key={run.id}>
          <details>
            <summary>{run.runtime ?? "旧版工具"} · {legacyExecutionStatus(run.status)} · {new Date(run.createdAt).toLocaleString()}</summary>
            <small>{run.targetType ?? "执行环境未记录"} · {run.artifactCount} 个产物{run.hasError ? " · 有错误记录" : ""}{run.truncated ? " · 输出曾被截断" : ""}</small>
            {run.observation && <p><strong>关联旧实验观察 · {run.observation.status === "accepted" ? "已采纳" : run.observation.status === "rejected" ? "已拒绝" : "待核验"}：</strong>{run.observation.claim}</p>}
            {!details && <button type="button" className="secondary-button" onClick={() => void loadLegacyExecutionDetails(run.id)}>按需查看输出与产物</button>}
            {details && "loading" in details && <small role="status">正在读取旧执行输出…</small>}
            {details && "error" in details && <p role="alert">{details.error} <button type="button" className="secondary-button" onClick={() => void loadLegacyExecutionDetails(run.id)}>重试</button></p>}
            {details && "stdout" in details && <>
              {details.errorMessage && <p>{details.errorMessage}</p>}
              {details.stdout && <details><summary>标准输出</summary><pre>{details.stdout.slice(0, 12_000)}</pre></details>}
              {details.stderr && <details><summary>错误输出</summary><pre>{details.stderr.slice(0, 12_000)}</pre></details>}
              {details.artifacts.length > 0 && <details><summary>产物指纹</summary><ul>{details.artifacts.map((artifact) => <li key={artifact.path}><strong>{artifact.path.split(/[\\/]/u).at(-1) || "产物"}</strong><small>{artifact.size} 字节 · SHA-256 {artifact.sha256}</small></li>)}</ul></details>}
            </>}
          </details>
        </li>;
      })}</ol>
    </details>}
    {tasks.length > 0 && <details>
      <summary>以往实践（{tasks.length}）</summary>
      <ol>{tasks.map((task) => <li key={task.id}>
        <details>
          <summary>{task.sourceType === "legacy_manual" ? "旧版本机执行记录" : task.latestGoal} · {practiceHistoryStatus(task.status)}</summary>
          <small>开始于 {new Date(task.createdAt).toLocaleString()}，最近更新 {new Date(task.updatedAt).toLocaleString()}</small>
          <PracticeAttemptComparisonList events={task.events ?? []} />
          <ol className="awen-practice-history-events">{(task.events ?? []).map((event) => <li key={`${task.id}:${event.sequence}`}>
            <strong>{summarizePracticeEvent(event)}</strong><small>{new Date(event.createdAt).toLocaleString()}</small>
            {practiceEventMessage(event) && <p>{practiceEventMessage(event)}</p>}
            {event.kind === "practice_result" && <PracticeResultDetails event={event} articlePath={articlePath} />}
            {event.kind === "legacy_execution_linked" && task.legacyExecutionRunId && <LegacyPracticeExecutionDetails
              runId={task.legacyExecutionRunId}
              projectId={projectId}
              details={legacyRunDetails[task.legacyExecutionRunId]}
              onLoad={() => void loadLegacyExecutionDetails(task.legacyExecutionRunId!)}
            />}
          </li>)}</ol>
        </details>
      </li>)}</ol>
    </details>}
  </section>;
}

function legacyExecutionStatus(status: string): string {
  if (status === "completed") return "已完成";
  if (status === "running") return "曾在运行";
  if (status === "interrupted") return "中断";
  if (status === "cancelled") return "已取消";
  return "未完成";
}

function LegacyPracticeExecutionDetails({ runId, projectId, details, onLoad }: {
  runId: string;
  projectId: string;
  details: LegacyExecutionRunDetails | { loading: true } | { error: string } | undefined;
  onLoad: () => void;
}) {
  return <div className="awen-practice-legacy-details">
    {!details && <button type="button" className="secondary-button" onClick={onLoad}>按需查看原执行记录</button>}
    {details && "loading" in details && <small role="status">正在读取原执行记录…</small>}
    {details && "error" in details && <p role="alert">{details.error} <button type="button" className="secondary-button" onClick={onLoad}>重试</button></p>}
      {details && "stdout" in details && <details><summary>原执行记录 · {legacyExecutionStatus(details.status)}</summary>
      <small>记录编号：{runId} · 文章项目：{projectId}</small>
      {details.observation && <p><strong>关联旧实验观察 · {details.observation.status === "accepted" ? "已采纳" : details.observation.status === "rejected" ? "已拒绝" : "待核验"}：</strong>{details.observation.claim}</p>}
      {details.errorMessage && <p>{details.errorMessage}</p>}
      {details.stdout && <details><summary>标准输出</summary><pre>{details.stdout.slice(0, 12_000)}</pre></details>}
      {details.stderr && <details><summary>错误输出</summary><pre>{details.stderr.slice(0, 12_000)}</pre></details>}
      {details.artifacts.length > 0 && <details><summary>产物指纹</summary><ul>{details.artifacts.map((artifact) => <li key={artifact.path}><strong>{artifact.path.split(/[\\/]/u).at(-1) || "产物"}</strong><small>{artifact.size} 字节 · SHA-256 {artifact.sha256}</small></li>)}</ul></details>}
    </details>}
  </div>;
}

function legacyWorkflowStatus(status: ToolWorkflowSnapshot["status"]): string {
  if (status === "completed") return "已完成";
  if (status === "completed_with_warnings") return "完成，有提醒";
  if (status === "incomplete") return "未完成，结论待核查";
  if (status === "failed") return "未完成";
  if (status === "cancelled") return "已取消";
  if (status === "interrupted") return "中断";
  return "曾等待处理";
}

function legacyWorkflowTime(workflow: ToolWorkflowSnapshot): string {
  const firstEvent = workflow.events.map((event) => event.at).filter(Boolean).sort()[0];
  const lastEvent = workflow.events.map((event) => event.at).filter(Boolean).sort().at(-1);
  if (!firstEvent) return "时间未记录";
  if (!lastEvent || firstEvent === lastEvent) return new Date(firstEvent).toLocaleString();
  return `${new Date(firstEvent).toLocaleString()} 至 ${new Date(lastEvent).toLocaleString()}`;
}

function legacyWorkflowOutput(output: unknown): string {
  if (typeof output === "string") return output.slice(0, 12_000);
  try { return JSON.stringify(output, null, 2)?.slice(0, 12_000) ?? "（没有可显示的输出）"; }
  catch { return "（结果格式无法显示）"; }
}

interface PracticeSourceLinkView {
  type: "practice_paragraph_link" | "practice_observation" | "web_capture" | "demo_capture" | "image_derivative";
  captureKind?: "command_output";
  title?: string;
  claim?: string;
  conditions?: string;
  capturedAt?: string;
  createdAt?: string;
  status?: "linked" | "pending_review";
  bodyStatus?: "linked" | "moved" | "not_in_body" | "missing" | "modified";
  bodyImagePath?: string;
  sourceUrl?: string;
  screenshotSha256?: string;
  imagePath?: string;
  imageSha256?: string;
  parentImagePath?: string;
  parentImageSha256?: string;
  purpose?: "article_cover" | "article_body";
  parentStatus?: "matched" | "missing" | "changed";
  imageStatus?: "matched" | "missing" | "changed";
}

export function ArticlePracticeSources({ articlePath, refreshKey }: { articlePath?: string | null; refreshKey?: string }) {
  const [sources, setSources] = useState<PracticeSourceLinkView[]>([]);
  useEffect(() => {
    if (!articlePath) { setSources([]); return; }
    let active = true;
    void request<{ sources: PracticeSourceLinkView[] }>(`/content-source/article-practice-sources?path=${encodeURIComponent(articlePath)}`)
      .then((result) => { if (active) setSources(result.sources); })
      .catch(() => { if (active) setSources([]); });
    return () => { active = false; };
  }, [articlePath, refreshKey]);
  if (sources.length === 0) return null;
  return <section className="awen-tool-permission awen-practice-sources" aria-label="文章中的实践来源">
    <details><summary>正文实践来源（{sources.length}）</summary>
      <ul>{sources.map((source, index) => <li key={`${source.capturedAt}:${index}`}>
        <strong>{source.type === "practice_paragraph_link" ? source.status === "linked" ? "结论已关联正文" : "结论待核查" : source.type === "practice_observation" ? "首稿实践观察 · 待核查" : source.type === "image_derivative" ? source.parentStatus === "matched" && source.imageStatus === "matched" ? source.purpose === "article_body" ? source.bodyStatus === "linked" || source.bodyStatus === "moved" ? "正文裁剪版本 · 已关联" : "正文裁剪版本 · 已移出正文" : "封面裁剪版本" : "截图裁剪版本 · 待核查" : `${practiceCaptureBodyStatus(source.bodyStatus)}${source.type === "demo_capture" ? source.captureKind === "command_output" ? " · 本机命令输出" : " · 本地 Demo" : ""}`}</strong>
        {source.claim && <p>{source.claim}</p>}
        {source.conditions && <small>适用条件：{source.conditions}</small>}
        {source.type === "image_derivative" && <><p>{source.purpose === "article_body" ? `正文图片版本：${source.imagePath}` : `封面图片版本：${source.imagePath}`}</p><small>原截图：{source.parentImagePath} · {practiceImageStatusLabel(source.parentStatus)}</small><small>原截图指纹：{source.parentImageSha256?.slice(0, 16)}…</small><small>新版本指纹：{source.imageSha256?.slice(0, 16)}… · {practiceImageStatusLabel(source.imageStatus)}</small>{source.purpose === "article_body" && source.bodyStatus !== undefined && <small>正文引用：{source.bodyImagePath ?? "当前正文未引用"} · {source.bodyStatus === "linked" || source.bodyStatus === "moved" ? "已关联" : "待核查"}</small>}</>}
        {(source.type === "web_capture" || source.type === "demo_capture") && source.bodyStatus === "moved" && source.bodyImagePath && <small>当前图片位置：{source.bodyImagePath}</small>}
        {safePracticeSourceUrl(source.sourceUrl) && <a href={safePracticeSourceUrl(source.sourceUrl)} target="_blank" rel="noreferrer">查看公开来源</a>}
        {source.type !== "image_derivative" && (source.screenshotSha256 ?? source.imageSha256) && <small>截图指纹：{(source.screenshotSha256 ?? source.imageSha256)!.slice(0, 16)}…</small>}
        <small>{source.title ?? (source.type === "image_derivative" ? "实践截图裁剪记录" : "实践来源")} · {new Date(source.capturedAt ?? source.createdAt ?? 0).toLocaleString()}</small>
      </li>)}</ul>
    </details>
  </section>;
}

function practiceCaptureBodyStatus(status: PracticeSourceLinkView["bodyStatus"]): string {
  if (status === "linked") return "截图已关联正文";
  if (status === "moved") return "截图已移动，来源仍匹配";
  if (status === "modified") return "截图内容已变化，待核查";
  if (status === "missing") return "截图文件缺失，来源记录保留";
  return "未关联正文，来源记录保留";
}

function practiceImageStatusLabel(status: PracticeSourceLinkView["parentStatus"]): string {
  if (status === "matched") return "指纹一致";
  return status === "missing" ? "文件缺失" : status === "changed" ? "文件已变化" : "状态未知";
}

function practiceHistoryStatus(status: ArticlePracticeTask["status"]): string {
  if (status === "completed") return "已完成";
  if (status === "completed_with_gaps") return "完成，有待核查项";
  if (status === "stopped") return "已停止";
  if (status === "failed") return "未完成";
  return "已结束";
}

function practiceEventMessage(event: PracticeEventView): string {
  for (const key of ["goal", "reason", "outcome"]) {
    const value = event.payload[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const from = event.payload.from;
  const to = event.payload.to;
  if (typeof from === "string" && typeof to === "string") return `${practiceHistoryStatus(from as ArticlePracticeTask["status"])} → ${practiceHistoryStatus(to as ArticlePracticeTask["status"])}`;
  return "";
}

function PracticeResultDetails({ event, articlePath }: { event: PracticeEventView; articlePath?: string | null }) {
  const summary = event.payload.summary;
  const results = Array.isArray(event.payload.results) ? event.payload.results : [];
  if (typeof summary !== "string" && results.length === 0) return null;
  return <details className="awen-practice-result-details">
    <summary>展开实践结果</summary>
    {typeof summary === "string" && <p>{summary}</p>}
    {results.map((item, index) => {
      const record = asPlainRecord(item);
      const output = asPlainRecord(record?.result);
      if (!record) return null;
      const observation = typeof output?.observation === "string" ? output.observation : undefined;
      const stdout = typeof output?.stdout === "string" ? output.stdout : undefined;
      const stderr = typeof output?.stderr === "string" ? output.stderr : undefined;
      const relativePath = typeof output?.relativePath === "string" ? output.relativePath : undefined;
      const diff = asPlainRecord(output?.diff);
      const before = typeof diff?.before === "string" ? diff.before : undefined;
      const after = typeof diff?.after === "string" ? diff.after : undefined;
      const assetUrl = typeof output?.assetUrl === "string" && /^\.\/(?:[\w-]+\/)*[a-f0-9-]{36}\.png$/iu.test(output.assetUrl) ? output.assetUrl : undefined;
      const imageUrl = assetUrl && articlePath ? `/api/content-source/article-resource?path=${encodeURIComponent(articlePath)}&src=${encodeURIComponent(assetUrl)}` : undefined;
      return <div key={`${event.sequence}:${index}`}>
        {typeof record.toolId === "string" && <strong>{practiceToolName(record.toolId)}</strong>}
        {typeof output?.title === "string" && <p>{output.title}</p>}
        {safePracticeSourceUrl(output?.url) && <a href={safePracticeSourceUrl(output?.url)} target="_blank" rel="noreferrer">打开来源网页</a>}
        {imageUrl && <img src={imageUrl} alt={`实践截图：${typeof output?.title === "string" ? output.title : "网页观察"}`} loading="lazy" />}
        {observation && <p>{observation}</p>}
        {relativePath && <p>项目文件：{relativePath}</p>}
        {before !== undefined && after !== undefined && <details><summary>查看文件改动</summary><div className="awen-project-file-diff"><section><strong>改动前</strong><pre>{before}</pre></section><section><strong>改动后</strong><pre>{after}</pre></section></div></details>}
        {stdout && <pre>{stdout}</pre>}
        {stderr && <pre>{stderr}</pre>}
      </div>;
    })}
  </details>;
}

function practiceToolName(toolId: string): string {
  if (toolId === "practice_run_code") return "代码运行";
  if (toolId === "practice_run_command") return "本机工具实践";
  if (toolId === "practice_edit_project_file") return "项目文件修改";
  if (toolId === "practice_capture_webpage") return "网页读取与截图";
  if (toolId === "practice_capture_demo") return "本地 Demo 截图";
  if (toolId === "practice_capture_command_output") return "本机命令输出图片";
  if (toolId === "registered_cli_task") return "本机工具任务";
  return toolId;
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safePracticeSourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

function readGitAnalysis(workflow: ToolWorkflowSnapshot): GitAnalysisResult | undefined {
  for (const result of [...workflow.toolResults].reverse()) {
    if (result.toolId !== "git_analyze_source") continue;
    const parsed = parseGitAnalysisResult(result.output);
    if (parsed) return parsed;
  }
  for (const message of [...workflow.transcript].reverse()) {
    if (message.role !== "tool" || !message.content.includes("git_analyze_source")) continue;
    const start = message.content.indexOf("{");
    if (start < 0) continue;
    try {
      const parsed = parseGitAnalysisResult(JSON.parse(message.content.slice(start)) as unknown);
      if (parsed) return parsed;
    } catch {
      // The transcript may be bounded and contain a deliberately truncated result.
    }
  }
  return undefined;
}

function AwenGitEvidenceCard({ analysis, projectId }: { analysis: GitAnalysisResult; projectId: string }) {
  const [observationTitle, setObservationTitle] = useState("");
  const [observationClaim, setObservationClaim] = useState("");
  const [observationSaved, setObservationSaved] = useState(false);
  const [observationMessage, setObservationMessage] = useState("");
  const [observationBusy, setObservationBusy] = useState(false);
  const [observationAdopted, setObservationAdopted] = useState(false);
  const [adoptionBusy, setAdoptionBusy] = useState(false);
  const clearStatus = () => {
    setObservationSaved(false);
    setObservationAdopted(false);
    setObservationMessage("");
  };
  const saveObservation = async () => {
    setObservationBusy(true);
    setObservationMessage("");
    try {
      const result = await request<{ updated: boolean }>(`/execution/runs/${encodeURIComponent(analysis.runId)}/observation`, {
        method: "POST",
        body: JSON.stringify({
          title: observationTitle.trim(),
          claim: observationClaim.trim(),
          artifacts: analysis.files.map((file) => ({ path: file.path, sha256: file.sha256 }))
        })
      });
      setObservationSaved(true);
      setObservationMessage(result.updated ? "已有同一执行记录的待核验证据，原内容未覆盖。" : "已保存为待核验证据；请在资料来源中单独采纳后再用于提纲或正文。" );
    } catch (cause: unknown) {
      setObservationMessage(cause instanceof Error ? `保存失败：${cause.message}` : "保存失败，请检查网络后重试。" );
    } finally {
      setObservationBusy(false);
    }
  };
  const adoptObservation = async () => {
    setAdoptionBusy(true);
    try {
      await request(`/content-projects/${encodeURIComponent(projectId)}/research/sources/${encodeURIComponent(analysis.runId)}`, {
        method: "PATCH",
        body: JSON.stringify({ adoptionStatus: "adopted" })
      });
      setObservationAdopted(true);
      setObservationMessage("已采纳为证据卡；之后仍会保留执行条件和来源链。" );
    } catch (cause: unknown) {
      setObservationMessage(cause instanceof Error ? `采纳失败：${cause.message}` : "采纳失败，请重试。" );
    } finally {
      setAdoptionBusy(false);
    }
  };
  return <section className="awen-tool-permission awen-evidence-card">
    <strong>Git 取证结果</strong>
    <small>commit {analysis.commitSha} · {analysis.files.length} 个文件 · 执行记录 {analysis.runId}</small>
    {analysis.files.slice(0, 5).map((file) => <details key={file.path}><summary>{file.path} · SHA-256 {file.sha256}</summary><pre>{file.excerpt}</pre></details>)}
    <input value={observationTitle} onChange={(event) => { clearStatus(); setObservationTitle(event.target.value); }} placeholder="观察标题" />
    <textarea value={observationClaim} onChange={(event) => { clearStatus(); setObservationClaim(event.target.value); }} rows={3} placeholder="这次取证实际支持了什么主张？" />
    <button type="button" onClick={() => void saveObservation()} disabled={observationBusy || observationSaved || !observationTitle.trim() || !observationClaim.trim()}>保存为待核验证据</button>
    {observationSaved && <button type="button" className="secondary-button" onClick={() => void adoptObservation()} disabled={adoptionBusy || observationAdopted}>{adoptionBusy ? "正在采纳…" : observationAdopted ? "已采纳为证据卡" : "采纳为证据卡"}</button>}
    {observationMessage && <small className={observationSaved ? undefined : "error"} role={observationSaved ? undefined : "alert"}>{observationMessage}</small>}
  </section>;
}

function parseGitAnalysisResult(value: unknown): { runId: string; commitSha: string; files: Array<{ path: string; sha256: string; excerpt: string }> } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { run?: { id?: unknown }; commitSha?: unknown; files?: unknown };
  if (typeof record.run?.id !== "string" || typeof record.commitSha !== "string" || !Array.isArray(record.files)) return undefined;
  const files = record.files.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const file = item as { path?: unknown; sha256?: unknown; excerpt?: unknown };
        return typeof file.path === "string" && typeof file.sha256 === "string" && typeof file.excerpt === "string"
          ? [{ path: file.path, sha256: file.sha256, excerpt: file.excerpt }]
          : [];
      });
  return files.length > 0 ? { runId: record.run.id, commitSha: record.commitSha, files } : undefined;
}

export function shouldAutoScrollAwenTranscript(previousMessageCount: number | undefined, previousLoading: boolean | undefined, messageCount: number, loading: boolean): boolean {
  if (previousMessageCount === undefined) return true;
  return messageCount > previousMessageCount || (loading && !previousLoading);
}

export function getAwenWorkflowProgressMessage(workflow: ToolWorkflowSnapshot | undefined): string | undefined {
  if (!workflow || !["queued", "planning", "running", "waiting_user", "replanning", "cancel_requested"].includes(workflow.status)) return undefined;
  const event = [...workflow.events].reverse().find((item) => ["progress", "tool_started", "tool_output", "permission_requested", "goal_verification_continued", "model_plan_superseded"].includes(item.type));
  if (!event) return workflow.status === "running" ? "正在执行已授权的步骤…" : "正在分析目标并安排下一步…";
  if (event.type === "tool_started") {
    const toolId = event.data?.toolId;
    if (toolId === "practice_run_command") return "正在本机运行命令…";
    if (toolId === "practice_capture_command_output") return "正在把本机命令的实际输出制成图片…";
    if (toolId === "practice_capture_demo" || toolId === "practice_capture_webpage") return "正在生成并保存实践截图…";
    if (toolId === "web_search") return "正在搜索公开资料…";
    return "正在执行下一项操作…";
  }
  if (event.type === "tool_output") return event.message;
  if (event.type === "permission_requested") return "需要你处理一项授权；详情已显示在右侧执行活动。";
  if (event.type === "goal_verification_continued") return "已取得部分结果，正在根据缺口调整验证方法…";
  if (event.type === "model_plan_superseded") return "收到新的要求，正在重新安排步骤…";
  return event.message;
}

function useAwenTranscriptAutoScroll(transcriptRef: RefObject<HTMLDivElement | null>, messages: ArticleChatMessage[], loading: boolean) {
  const previousMessageCountRef = useRef<number | undefined>(undefined);
  const previousLoadingRef = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    const shouldScroll = shouldAutoScrollAwenTranscript(previousMessageCountRef.current, previousLoadingRef.current, messages.length, loading);
    previousMessageCountRef.current = messages.length;
    previousLoadingRef.current = loading;
    if (!shouldScroll) return;
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [messages, loading, transcriptRef]);
}

export function AwenBottomPanel({ messages, memory, value, loading, workflow, unsavedSuggestionIds, savedSuggestionSyncPendingIds, pendingSuggestionCount, pendingSuggestionReviewOpen, pendingSuggestionReviewBusy, bottomHeightPercent, transcriptUserPercent, onBottomHeightChange, onTranscriptUserPercentChange, onChange, onSend, onRetry, onAcceptSuggestion, onRejectSuggestion, onLocateSuggestion, onOpenMemoryManager, onRejectPendingAndContinue, onKeepPendingAndContinue, onCancelPendingSend, onOpenWorkflowActivity, onClose }: {
  messages: ArticleChatMessage[];
  memory: string;
  value: string;
  loading: boolean;
  workflow?: ToolWorkflowSnapshot;
  unsavedSuggestionIds: ReadonlySet<string>;
  savedSuggestionSyncPendingIds: ReadonlySet<string>;
  pendingSuggestionCount: number;
  pendingSuggestionReviewOpen: boolean;
  pendingSuggestionReviewBusy: boolean;
  bottomHeightPercent: number;
  transcriptUserPercent: number;
  onBottomHeightChange: (value: number) => void;
  onTranscriptUserPercentChange: (value: number) => void;
  onChange: (value: string) => void;
  onSend: () => void;
  onRetry: (message: ArticleChatMessage) => void;
  onAcceptSuggestion: (id: string) => void;
  onRejectSuggestion: (id: string) => void;
  onLocateSuggestion: (id: string) => void;
  onOpenMemoryManager: () => void;
  onRejectPendingAndContinue: () => void;
  onKeepPendingAndContinue: () => void;
  onCancelPendingSend: () => void;
  onOpenWorkflowActivity: () => void;
  onClose: () => void;
}) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptShellRef = useRef<HTMLDivElement>(null);
  const [resizeTarget, setResizeTarget] = useState<AwenResizeTarget>();
  const workflowProgressMessage = getAwenWorkflowProgressMessage(workflow);
  useAwenTranscriptAutoScroll(transcriptRef, messages, loading);
  useEffect(() => {
    if (!resizeTarget) return;
    const onPointerMove = (event: PointerEvent) => {
      if (resizeTarget === "panel") {
        const viewportHeight = Math.max(window.innerHeight, 1);
        onBottomHeightChange(clampPercentage(((viewportHeight - event.clientY) / viewportHeight) * 100, 22, 72));
        return;
      }
      const bounds = transcriptShellRef.current?.getBoundingClientRect();
      if (!bounds || bounds.width <= 0) return;
      onTranscriptUserPercentChange(clampPercentage(((event.clientX - bounds.left) / bounds.width) * 100, 20, 60));
    };
    const stopResizing = () => setResizeTarget(undefined);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
    };
  }, [onBottomHeightChange, onTranscriptUserPercentChange, resizeTarget]);
  const beginResize = (target: AwenResizeTarget, event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setResizeTarget(target);
  };
  const adjustResize = (target: AwenResizeTarget, delta: number) => {
    if (target === "panel") onBottomHeightChange(clampPercentage(bottomHeightPercent + delta, 22, 72));
    else onTranscriptUserPercentChange(clampPercentage(transcriptUserPercent + delta, 20, 60));
  };
  const onResizeKeyDown = (target: AwenResizeTarget, event: ReactKeyboardEvent<HTMLDivElement>) => {
    const increase = target === "panel" ? event.key === "ArrowUp" : event.key === "ArrowRight";
    const decrease = target === "panel" ? event.key === "ArrowDown" : event.key === "ArrowLeft";
    if (!increase && !decrease) return;
    event.preventDefault();
    adjustResize(target, increase ? 2 : -2);
  };
  const transcriptStyle = { "--awen-user-column": `${transcriptUserPercent}%` } as CSSProperties;
  return <section className={`awen-bottom-panel${resizeTarget ? ` resizing-${resizeTarget}` : ""}`} aria-label="与阿文讨论本文">
    <div className="awen-panel-resizer" role="separator" aria-orientation="horizontal" aria-label="调整阿文面板高度" aria-valuemin={22} aria-valuemax={72} aria-valuenow={Math.round(bottomHeightPercent)} tabIndex={0} onPointerDown={(event) => beginResize("panel", event)} onKeyDown={(event) => onResizeKeyDown("panel", event)} />
    <div className="awen-bottom-layout">
      <div className="awen-history">
        <div className="awen-transcript-shell" ref={transcriptShellRef}>
          <div className="awen-transcript" ref={transcriptRef} style={transcriptStyle}>
          {messages.length === 0 && <div className="awen-empty">可以问阿文：这篇文章的核心论点是否清楚？也可以选中正文后用快捷操作生成修改建议。</div>}
          {messages.map((message) => {
            const sentAt = formatAwenMessageTime(message.createdAt);
            return <article className={`awen-message ${message.role}`} key={message.id}>
            <strong><span>{message.role === "user" ? "你" : "阿文"}</span><time dateTime={message.createdAt} title={sentAt.full}>{sentAt.visible}</time></strong>
            <div>{message.content}</div>
            {(message.deliveryState === "sending" || message.deliveryState === "waiting_permission" || message.deliveryState === "authorized") && <small className="awen-message-state">{getAwenDeliveryStateLabel(message, workflow?.status)}</small>}
            {message.deliveryState === "failed" && <small className="awen-message-state error">阿文未能完成回复；这条消息已保留。<button type="button" className="text-button awen-retry-button" onClick={() => onRetry(message)} disabled={loading}>↻ 重新发送</button></small>}
            {message.role === "assistant" && message.suggestions.map((suggestion, index) => <details className="awen-conversation-suggestion" key={`${message.id}:${index}`} open>
               <summary>建议 {index + 1}：{suggestionOperation(suggestion) === "replace" ? "替换原文" : suggestionOperation(suggestion) === "insert_after" ? "追加到原文后" : "插入到原文前"}{getAwenAlternativeSuggestionIds(messages, `${message.id}:${index}`).length > 0 ? " · 同段落互斥方案" : ""} · {suggestion.reason}</summary>
               <small className="awen-suggestion-original">原文：{suggestion.original}</small>
               <pre>{suggestion.replacement}</pre>
               <div>{unsavedSuggestionIds.has(`${message.id}:${index}`) ? <><small className="awen-suggestion-status pending">已应用到当前草稿，尚未保存</small><button type="button" className="secondary-button" onClick={() => onLocateSuggestion(`${message.id}:${index}`)}>定位</button></> : savedSuggestionSyncPendingIds.has(`${message.id}:${index}`) ? <><small className="awen-suggestion-status pending">正文已保存，建议状态待同步；点击“保存文章”可重试</small><button type="button" className="secondary-button" onClick={() => onLocateSuggestion(`${message.id}:${index}`)}>定位</button></> : (!suggestion.status || suggestion.status === "pending") ? <><button type="button" onClick={() => onAcceptSuggestion(`${message.id}:${index}`)}>{suggestionOperation(suggestion) === "replace" ? "接受替换" : "接受追加"}</button><button type="button" className="secondary-button" onClick={() => onRejectSuggestion(`${message.id}:${index}`)}>拒绝</button><button type="button" className="secondary-button" onClick={() => onLocateSuggestion(`${message.id}:${index}`)}>定位</button></> : suggestion.status === "accepted" ? <><small className="awen-suggestion-status accepted">已应用并保存</small><button type="button" className="secondary-button" onClick={() => onLocateSuggestion(`${message.id}:${index}`)}>定位</button></> : <small className={`awen-suggestion-status ${suggestion.status}`}>{suggestion.status === "rejected" ? "已拒绝，正文未修改" : "正文已变化，无法定位"}</small>}</div>
            </details>)}
          </article>;
          })}
          {loading && <article className="awen-message assistant awen-live-progress"><strong>阿文</strong><div role="status">{workflowProgressMessage ?? "正在阅读文章并组织建议…"}{workflow && <button type="button" className="text-button" onClick={onOpenWorkflowActivity}>查看执行活动</button>}</div></article>}
          </div>
          <div className="awen-transcript-resizer" role="separator" aria-orientation="vertical" aria-label="调整你和阿文的对话宽度" aria-valuemin={20} aria-valuemax={60} aria-valuenow={Math.round(transcriptUserPercent)} tabIndex={0} onPointerDown={(event) => beginResize("transcript", event)} onKeyDown={(event) => onResizeKeyDown("transcript", event)} />
        </div>
      </div>
      <aside className={`awen-composer${pendingSuggestionReviewOpen ? " has-pending-review" : ""}`}>
        {pendingSuggestionReviewOpen && <div className="awen-pending-review" role="alertdialog" aria-label="处理之前的阿文建议">
          <strong>还有 {pendingSuggestionCount} 条之前的建议未处理</strong>
          <p>继续提问前，可以先批量拒绝这些仍然对应当前正文的建议。</p>
          <div className="awen-pending-review-actions">
            <button type="button" onClick={onRejectPendingAndContinue} disabled={pendingSuggestionReviewBusy}>{pendingSuggestionReviewBusy ? "正在处理…" : "批量拒绝并继续"}</button>
            <button type="button" className="secondary-button" onClick={onKeepPendingAndContinue} disabled={pendingSuggestionReviewBusy}>保留建议，继续提问</button>
            <button type="button" className="text-button" onClick={onCancelPendingSend} disabled={pendingSuggestionReviewBusy}>取消发送</button>
          </div>
        </div>}
        {workflow && ["waiting_user", "interrupted"].includes(workflow.status) && <section className="awen-tool-permission awen-workflow-handoff" role="status">
          <strong>{workflow.status === "waiting_user" ? "阿文正在等待授权" : "阿文工作流需要恢复"}</strong>
          <p>授权按钮和完整工具参数统一放在右侧“执行活动”中处理，避免同一个操作出现两张授权卡。</p>
          <button type="button" onClick={onOpenWorkflowActivity}>查看执行活动</button>
        </section>}
        <textarea value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); onSend(); } }} placeholder="输入问题，Ctrl+Enter 发送" disabled={loading || pendingSuggestionReviewOpen || Boolean(workflow)} />
        <div className="awen-composer-actions"><div className="awen-memory-actions">{memory && <details className="awen-memory"><summary>本文已提炼 {memory.split("\n").filter(Boolean).length} 条记忆</summary><pre>{memory}</pre></details>}<button type="button" className="secondary-button memory-manage-button" onClick={onOpenMemoryManager}><span aria-hidden="true">⚙</span>管理本文记忆</button></div><button type="button" className="text-button awen-collapse-button" onClick={onClose}>收起</button><button type="button" onClick={onSend} disabled={!value.trim() || loading || pendingSuggestionReviewOpen}>发送</button></div>
      </aside>
    </div>
  </section>;
}

export function AwenMemoryManager({ memories, candidates, busy, onPromote, onStatus, onForget, onExport, onImport, onClose }: {
  memories: AgentMemoryRecord[];
  candidates: AgentMemoryCandidateRecord[];
  busy: boolean;
  onPromote: (candidateId: string) => void;
  onStatus: (memoryId: string, status: "active" | "expired" | "deleted") => void;
  onForget: (mode: "derived" | "all") => void;
  onExport: () => void;
  onImport: (file: File) => void;
  onClose: () => void;
}) {
  const [forgetMode, setForgetMode] = useState<"derived" | "all">();
  const requestForget = (mode: "derived" | "all") => {
    if (forgetMode === mode) { setForgetMode(undefined); onForget(mode); return; }
    setForgetMode(mode);
  };
  return <div className="modal-backdrop priority-modal" role="presentation">
    <section className="modal-card awen-memory-manager" role="dialog" aria-modal="true" aria-label="管理本文记忆">
      <div className="section-heading">
        <div><p className="eyebrow">阿文记忆</p><h2>管理本文记忆</h2></div>
        <button type="button" className="text-button" onClick={onClose}>关闭</button>
      </div>
      <p className="hint memory-manager-intro">长期记忆是从会话中提炼的派生信息，不是正文副本。停用或删除后不会再送入阿文上下文。</p>
      <section className="memory-manager-section">
        <div className="memory-section-heading"><h3>已启用记忆</h3><span>{memories.length} 条</span></div>
        {memories.length === 0 ? <p className="hint memory-empty">当前文章还没有已启用的长期记忆。</p> : memories.map((memory) => <article className="memory-management-row" key={memory.id}>
          <div className="memory-management-main"><strong>{memory.content}</strong><small>{memory.kind} · 使用 {memory.recallCount} 次 · 更新于 {new Date(memory.updatedAt).toLocaleString()}</small></div>
          <button type="button" className="secondary-button compact-action" onClick={() => onStatus(memory.id, "deleted")} disabled={busy}>删除</button>
        </article>)}
      </section>
      <section className="memory-manager-section">
        <div className="memory-section-heading"><h3>待确认候选</h3><span>{candidates.length} 条</span></div>
        {candidates.length === 0 ? <p className="hint memory-empty">没有待确认候选。</p> : candidates.map((candidate) => <article className="memory-management-row" key={candidate.id}>
          <div className="memory-management-main"><strong>{candidate.content}</strong><small>{candidate.kind} · 来源 {candidate.sourceEventIds.length} 条 · 支持 {candidate.supportCount} 次</small></div>
          <button type="button" className="compact-action" onClick={() => onPromote(candidate.id)} disabled={busy}>启用</button>
        </article>)}
      </section>
      <section className="memory-manager-tools" aria-label="记忆备份与恢复">
        <div><strong>备份与恢复</strong><small>迁移到其他文章或保留一份本地副本</small></div>
        <div className="memory-manager-tool-actions"><button type="button" className="secondary-button" onClick={onExport} disabled={busy}>导出本文记忆</button><label className="secondary-button memory-import-label">导入记忆<input type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(file); event.currentTarget.value = ""; }} disabled={busy} /></label></div>
      </section>
      <section className="memory-manager-danger" aria-label="删除记忆">
        <div><strong>删除记忆</strong><small>删除派生记忆不会删除文章正文；删除全部记录会同时清理相关事件。</small></div>
        <div className="memory-manager-danger-actions"><button type="button" className="secondary-button compact-action" onClick={() => requestForget("derived")} disabled={busy}>{forgetMode === "derived" ? "再次确认" : "删除派生记忆"}</button><button type="button" className="danger-button compact-action" onClick={() => requestForget("all")} disabled={busy}>{forgetMode === "all" ? "再次确认" : "删除全部记录"}</button></div>
      </section>
    </section>
  </div>;
}

export function LegacyAwenBottomPanel({ messages, memory, value, loading, onChange, onSend, onRetry, onClose }: {
  messages: ArticleChatMessage[];
  memory: string;
  value: string;
  loading: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  onRetry: (message: ArticleChatMessage) => void;
  onClose: () => void;
}) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  useAwenTranscriptAutoScroll(transcriptRef, messages, loading);
  return <section className="awen-bottom-panel" aria-label="与阿文讨论本文"><button type="button" className="text-button awen-collapse-button" onClick={onClose}>收起</button><div className="awen-bottom-layout"><div className="awen-history">{memory && <details className="awen-memory"><summary>本文已提炼 {memory.split("\n").filter(Boolean).length} 条记忆</summary><pre>{memory}</pre></details>}<div className="awen-transcript" ref={transcriptRef}>{messages.length === 0 && <div className="awen-empty">可以问阿文：这篇文章的核心论点是否清楚？哪里读起来像模板？也可以直接说“给出 3 条可直接应用的修改建议”。</div>}{messages.map((message) => <article className={`awen-message ${message.role}`} key={message.id}><strong>{message.role === "user" ? "你" : "阿文"}</strong><div>{message.content}</div>{message.deliveryState === "sending" && <small className="awen-message-state">{getAwenDeliveryStateLabel(message)}</small>}{message.deliveryState === "failed" && <small className="awen-message-state error">阿文未能完成回复；这条消息已保留。<button type="button" className="text-button awen-retry-button" onClick={() => onRetry(message)} disabled={loading} title="重新发送">↻ 重新发送</button></small>}{message.role === "assistant" && message.suggestions.length > 0 && <small className="awen-memory-note">已生成 {message.suggestions.length} 条可应用建议，已标记在正文对应位置。</small>}</article>)}{loading && <article className="awen-message assistant"><strong>阿文</strong><div>正在阅读文章并组织建议…</div></article>}</div></div><aside className="awen-composer"><textarea value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); onSend(); } }} placeholder="输入问题，Ctrl+Enter 发送" disabled={loading} /><button type="button" onClick={onSend} disabled={!value.trim() || loading}>发送</button></aside></div></section>;
}

export function AwenChatModal({ messages, memory, value, loading, onChange, onSend, onRemember, onClose }: {
  messages: ArticleChatMessage[];
  memory: string;
  value: string;
  loading: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  onRemember: (memory: string) => void;
  onClose: () => void;
}) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  useAwenTranscriptAutoScroll(transcriptRef, messages, loading);
  return <div className="modal-backdrop priority-modal" role="presentation"><section className="modal-card awen-chat-modal" role="dialog" aria-modal="true" aria-label="与阿文讨论本文"><div className="section-heading"><div><p className="eyebrow">阿文 · 专业自媒体助理</p><h2>讨论当前文章</h2></div><button type="button" className="text-button" onClick={onClose}>关闭</button></div><p className="hint">阿文会携带当前文章和本篇历史会话，并自动提炼重要的偏好、决定和待解决事项；不保存完整会话作为记忆。</p>{memory && <details className="awen-memory"><summary>本文已提炼 {memory.split("\n").filter(Boolean).length} 条记忆</summary><pre>{memory}</pre></details>}<div className="awen-transcript" ref={transcriptRef}>{messages.length === 0 && <div className="awen-empty">可以问阿文：这篇文章的核心论点是否清楚？哪里读起来像模板？标题、结构或读者视角还缺什么？</div>}{messages.map((message) => <article className={`awen-message ${message.role}`} key={message.id}><strong>{message.role === "user" ? "你" : "阿文"}</strong><div>{message.content}</div>{message.role === "assistant" && message.memorySuggestion && <small className="awen-memory-note">已自动提炼：{message.memorySuggestion}</small>}</article>)}{loading && <article className="awen-message assistant"><strong>阿文</strong><div>正在阅读文章并组织建议…</div></article>}</div><div className="awen-composer"><textarea value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); onSend(); } }} placeholder="输入你想和阿文讨论的问题，Ctrl+Enter 发送" disabled={loading} /><button type="button" onClick={onSend} disabled={!value.trim() || loading}>发送</button></div></section></div>;
}
