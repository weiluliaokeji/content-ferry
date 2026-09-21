import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from "react";
import type { AgentMemoryCandidateRecord, AgentMemoryRecord, ArticleChatMessage } from "../types";
import { findUniqueSuggestionRange, getAwenAlternativeSuggestionIds, suggestionOperation } from "./awen-suggestion-utils";

type AwenResizeTarget = "panel" | "transcript";

const clampPercentage = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

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

export function getAwenDeliveryStateLabel(message: Pick<ArticleChatMessage, "role" | "deliveryState">): string | undefined {
  if (message.deliveryState !== "sending") return undefined;
  return message.role === "user" ? "已发送，阿文正在处理…" : "阿文正在处理…";
}

export function shouldAutoScrollAwenTranscript(previousMessageCount: number | undefined, previousLoading: boolean | undefined, messageCount: number, loading: boolean): boolean {
  if (previousMessageCount === undefined) return true;
  return messageCount > previousMessageCount || (loading && !previousLoading);
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

export function AwenBottomPanel({ messages, memory, value, loading, unsavedSuggestionIds, pendingSuggestionCount, pendingSuggestionReviewOpen, pendingSuggestionReviewBusy, bottomHeightPercent, transcriptUserPercent, onBottomHeightChange, onTranscriptUserPercentChange, onChange, onSend, onRetry, onAcceptSuggestion, onRejectSuggestion, onLocateSuggestion, onOpenMemoryManager, onRejectPendingAndContinue, onKeepPendingAndContinue, onCancelPendingSend, onClose }: {
  messages: ArticleChatMessage[];
  memory: string;
  value: string;
  loading: boolean;
  unsavedSuggestionIds: ReadonlySet<string>;
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
  onClose: () => void;
}) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptShellRef = useRef<HTMLDivElement>(null);
  const [resizeTarget, setResizeTarget] = useState<AwenResizeTarget>();
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
          {messages.map((message) => <article className={`awen-message ${message.role}`} key={message.id}>
            <strong>{message.role === "user" ? "你" : "阿文"}</strong>
            <div>{message.content}</div>
            {message.deliveryState === "sending" && <small className="awen-message-state">{getAwenDeliveryStateLabel(message)}</small>}
            {message.deliveryState === "failed" && <small className="awen-message-state error">阿文未能完成回复；这条消息已保留。<button type="button" className="text-button awen-retry-button" onClick={() => onRetry(message)} disabled={loading}>↻ 重新发送</button></small>}
            {message.role === "assistant" && message.suggestions.map((suggestion, index) => <details className="awen-conversation-suggestion" key={`${message.id}:${index}`} open>
               <summary>建议 {index + 1}：{suggestionOperation(suggestion) === "replace" ? "替换原文" : suggestionOperation(suggestion) === "insert_after" ? "追加到原文后" : "插入到原文前"}{getAwenAlternativeSuggestionIds(messages, `${message.id}:${index}`).length > 0 ? " · 同段落互斥方案" : ""} · {suggestion.reason}</summary>
               <small className="awen-suggestion-original">原文：{suggestion.original}</small>
               <pre>{suggestion.replacement}</pre>
               <div>{unsavedSuggestionIds.has(`${message.id}:${index}`) ? <><small className="awen-suggestion-status pending">已应用到当前草稿，尚未保存</small><button type="button" className="secondary-button" onClick={() => onLocateSuggestion(`${message.id}:${index}`)}>定位</button></> : (!suggestion.status || suggestion.status === "pending") ? <><button type="button" onClick={() => onAcceptSuggestion(`${message.id}:${index}`)}>{suggestionOperation(suggestion) === "replace" ? "接受替换" : "接受追加"}</button><button type="button" className="secondary-button" onClick={() => onRejectSuggestion(`${message.id}:${index}`)}>拒绝</button><button type="button" className="secondary-button" onClick={() => onLocateSuggestion(`${message.id}:${index}`)}>定位</button></> : suggestion.status === "accepted" ? <><small className="awen-suggestion-status accepted">已应用并保存</small><button type="button" className="secondary-button" onClick={() => onLocateSuggestion(`${message.id}:${index}`)}>定位</button></> : <small className={`awen-suggestion-status ${suggestion.status}`}>{suggestion.status === "rejected" ? "已拒绝，正文未修改" : "正文已变化，无法定位"}</small>}</div>
            </details>)}
          </article>)}
          {loading && <article className="awen-message assistant"><strong>阿文</strong><div>正在阅读文章并组织建议…</div></article>}
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
        <textarea value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); onSend(); } }} placeholder="输入问题，Ctrl+Enter 发送" disabled={loading || pendingSuggestionReviewOpen} />
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
