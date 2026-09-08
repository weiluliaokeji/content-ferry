import { useEffect, useRef, useState } from "react";
import type { AgentMemoryCandidateRecord, AgentMemoryRecord, ArticleChatMessage, ArticleChatSuggestion } from "../types";

// 阿文（AI 助手）对话面板（自 main.tsx 拆分）
export function removeUnavailableAwenSuggestions(messages: ArticleChatMessage[], markdown: string): {
  messages: ArticleChatMessage[];
  staleSuggestions: Array<{ messageId: string; index: number }>;
} {
  const staleSuggestions: Array<{ messageId: string; index: number }> = [];
  const normalizedMessages = messages.map((message) => {
    if (message.role !== "assistant" || message.suggestions.length === 0) return message;
    const updated = message.suggestions.map((suggestion, index) => {
      if (suggestion.status && suggestion.status !== "pending") return suggestion;
      const first = markdown.indexOf(suggestion.original);
      const stillAnchored = first >= 0 && markdown.indexOf(suggestion.original, first + suggestion.original.length) < 0;
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

export function AwenBottomPanel({ messages, memory, value, loading, onChange, onSend, onRetry, onAcceptSuggestion, onRejectSuggestion, onOpenMemoryManager, onClose }: {
  messages: ArticleChatMessage[];
  memory: string;
  value: string;
  loading: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  onRetry: (message: ArticleChatMessage) => void;
  onAcceptSuggestion: (id: string) => void;
  onRejectSuggestion: (id: string) => void;
  onOpenMemoryManager: () => void;
  onClose: () => void;
}) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => { transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight }); }, [messages, loading]);
  return <section className="awen-bottom-panel" aria-label="与阿文讨论本文">
    <button type="button" className="text-button awen-collapse-button" onClick={onClose}>收起</button>
    <div className="awen-bottom-layout">
      <div className="awen-history">
        <div className="awen-memory-actions">{memory && <details className="awen-memory"><summary>本文已提炼 {memory.split("\n").filter(Boolean).length} 条记忆</summary><pre>{memory}</pre></details>}<button type="button" className="text-button" onClick={onOpenMemoryManager}>管理本文记忆</button></div>
        <div className="awen-transcript" ref={transcriptRef}>
          {messages.length === 0 && <div className="awen-empty">可以问阿文：这篇文章的核心论点是否清楚？也可以选中正文后用快捷操作生成修改建议。</div>}
          {messages.map((message) => <article className={`awen-message ${message.role}`} key={message.id}>
            <strong>{message.role === "user" ? "你" : "阿文"}</strong>
            <div>{message.content}</div>
            {message.deliveryState === "sending" && <small className="awen-message-state">正在发送…</small>}
            {message.deliveryState === "failed" && <small className="awen-message-state error">阿文未能完成回复；这条消息已保留。<button type="button" className="text-button awen-retry-button" onClick={() => onRetry(message)} disabled={loading}>↻ 重新发送</button></small>}
            {message.role === "assistant" && message.suggestions.map((suggestion, index) => <details className="awen-conversation-suggestion" key={`${message.id}:${index}`} open>
              <summary>建议 {index + 1}：{suggestion.reason}</summary>
              <small className="awen-suggestion-original">原文：{suggestion.original}</small>
              <pre>{suggestion.replacement}</pre>
              <div>{(!suggestion.status || suggestion.status === "pending") ? <><button type="button" onClick={() => onAcceptSuggestion(`${message.id}:${index}`)}>接受改写</button><button type="button" className="secondary-button" onClick={() => onRejectSuggestion(`${message.id}:${index}`)}>拒绝</button></> : <small className={`awen-suggestion-status ${suggestion.status}`}>{suggestion.status === "accepted" ? "已接受并应用" : suggestion.status === "rejected" ? "已拒绝，正文未修改" : "正文已变化，无法定位"}</small>}</div>
            </details>)}
          </article>)}
          {loading && <article className="awen-message assistant"><strong>阿文</strong><div>正在阅读文章并组织建议…</div></article>}
        </div>
      </div>
      <aside className="awen-composer"><textarea value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); onSend(); } }} placeholder="输入问题，Ctrl+Enter 发送" disabled={loading} /><button type="button" onClick={onSend} disabled={!value.trim() || loading}>发送</button></aside>
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
  return <div className="modal-backdrop priority-modal" role="presentation"><section className="modal-card awen-memory-manager" role="dialog" aria-modal="true" aria-label="管理本文记忆"><div className="section-heading"><div><p className="eyebrow">阿文记忆</p><h2>管理本文记忆</h2></div><button type="button" className="text-button" onClick={onClose}>关闭</button></div><p className="hint">长期记忆是从会话中提炼的派生信息，不是正文副本。停用或删除后不会再送入阿文上下文。</p><section><h3>已启用记忆</h3>{memories.length === 0 ? <p className="hint">当前文章还没有已启用的长期记忆。</p> : memories.map((memory) => <article className="memory-management-row" key={memory.id}><div><strong>{memory.content}</strong><small>{memory.kind} · 使用 {memory.recallCount} 次 · 更新于 {new Date(memory.updatedAt).toLocaleString()}</small></div><button type="button" className="secondary-button" onClick={() => onStatus(memory.id, "deleted")} disabled={busy}>删除</button></article>)}</section><section><h3>待确认候选</h3>{candidates.length === 0 ? <p className="hint">没有待确认候选。</p> : candidates.map((candidate) => <article className="memory-management-row" key={candidate.id}><div><strong>{candidate.content}</strong><small>{candidate.kind} · 来源 {candidate.sourceEventIds.length} 条 · 支持 {candidate.supportCount} 次</small></div><button type="button" onClick={() => onPromote(candidate.id)} disabled={busy}>启用</button></article>)}</section><div className="inline-actions"><button type="button" className="secondary-button" onClick={onExport} disabled={busy}>导出本文记忆</button><label className="secondary-button memory-import-label">导入记忆<input type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(file); event.currentTarget.value = ""; }} disabled={busy} /></label></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => requestForget("derived")} disabled={busy}>{forgetMode === "derived" ? "再次点击确认删除派生记忆" : "删除本文派生记忆"}</button><button type="button" className="danger-button" onClick={() => requestForget("all")} disabled={busy}>{forgetMode === "all" ? "再次点击确认删除全部记录" : "删除记忆与事件"}</button></div></section></div>;
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
  useEffect(() => { transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight }); }, [messages, loading]);
  return <section className="awen-bottom-panel" aria-label="与阿文讨论本文"><button type="button" className="text-button awen-collapse-button" onClick={onClose}>收起</button><div className="awen-bottom-layout"><div className="awen-history">{memory && <details className="awen-memory"><summary>本文已提炼 {memory.split("\n").filter(Boolean).length} 条记忆</summary><pre>{memory}</pre></details>}<div className="awen-transcript" ref={transcriptRef}>{messages.length === 0 && <div className="awen-empty">可以问阿文：这篇文章的核心论点是否清楚？哪里读起来像模板？也可以直接说“给出 3 条可直接应用的修改建议”。</div>}{messages.map((message) => <article className={`awen-message ${message.role}`} key={message.id}><strong>{message.role === "user" ? "你" : "阿文"}</strong><div>{message.content}</div>{message.deliveryState === "sending" && <small className="awen-message-state">正在发送…</small>}{message.deliveryState === "failed" && <small className="awen-message-state error">阿文未能完成回复；这条消息已保留。<button type="button" className="text-button awen-retry-button" onClick={() => onRetry(message)} disabled={loading} title="重新发送">↻ 重新发送</button></small>}{message.role === "assistant" && message.suggestions.length > 0 && <small className="awen-memory-note">已生成 {message.suggestions.length} 条可应用建议，已标记在正文对应位置。</small>}</article>)}{loading && <article className="awen-message assistant"><strong>阿文</strong><div>正在阅读文章并组织建议…</div></article>}</div></div><aside className="awen-composer"><textarea value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); onSend(); } }} placeholder="输入问题，Ctrl+Enter 发送" disabled={loading} /><button type="button" onClick={onSend} disabled={!value.trim() || loading}>发送</button></aside></div></section>;
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
  useEffect(() => { transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight }); }, [messages, loading]);
  return <div className="modal-backdrop priority-modal" role="presentation"><section className="modal-card awen-chat-modal" role="dialog" aria-modal="true" aria-label="与阿文讨论本文"><div className="section-heading"><div><p className="eyebrow">阿文 · 专业自媒体助理</p><h2>讨论当前文章</h2></div><button type="button" className="text-button" onClick={onClose}>关闭</button></div><p className="hint">阿文会携带当前文章和本篇历史会话，并自动提炼重要的偏好、决定和待解决事项；不保存完整会话作为记忆。</p>{memory && <details className="awen-memory"><summary>本文已提炼 {memory.split("\n").filter(Boolean).length} 条记忆</summary><pre>{memory}</pre></details>}<div className="awen-transcript" ref={transcriptRef}>{messages.length === 0 && <div className="awen-empty">可以问阿文：这篇文章的核心论点是否清楚？哪里读起来像模板？标题、结构或读者视角还缺什么？</div>}{messages.map((message) => <article className={`awen-message ${message.role}`} key={message.id}><strong>{message.role === "user" ? "你" : "阿文"}</strong><div>{message.content}</div>{message.role === "assistant" && message.memorySuggestion && <small className="awen-memory-note">已自动提炼：{message.memorySuggestion}</small>}</article>)}{loading && <article className="awen-message assistant"><strong>阿文</strong><div>正在阅读文章并组织建议…</div></article>}</div><div className="awen-composer"><textarea value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); onSend(); } }} placeholder="输入你想和阿文讨论的问题，Ctrl+Enter 发送" disabled={loading} /><button type="button" onClick={onSend} disabled={!value.trim() || loading}>发送</button></div></section></div>;
}
