import { Suspense, useMemo, useRef, useState } from "react";
import { VisualMarkdownEditor } from "./VisualMarkdownEditor";
import type { VisualMarkdownSelection } from "./VisualMarkdownEditor";
import { request, apiBase, renderPhonePreview, resolveArticleImageUrl, extractMarkdownImages } from "../main";
import { locateMarkdownSelection } from "../markdown-selection";

interface CsdnChannelDraftShape {
  id: string; accountId: string; sourceRelativePath: string; generationMode: "rewrite" | "source";
  title: string; markdown: string; author: string; digest: string; coverSource: string;
  status: "draft" | "approved" | "superseded";
}

export type CsdnDraftPatch = Partial<Pick<CsdnChannelDraftShape, "title" | "markdown" | "author" | "digest" | "coverSource">>;

interface CsdnPublishJobShape {
  id: string;
  status: "queued" | "needs_login" | "filling" | "needs_user" | "ready_for_final_confirmation" | "submitting" | "published" | "needs_manual_reconciliation" | "failed_before_submit" | "failed" | "cancelled";
  statusNote: string | null;
  errorMessage: string | null;
  remoteUrl: string | null;
  remoteContentId: string | null;
  updatedAt: string;
}

interface CsdnDraftWorkspaceProps {
  draft: CsdnChannelDraftShape;
  accountDisplay: string;
  saving: boolean;
  job?: CsdnPublishJobShape;
  onChange: (patch: CsdnDraftPatch) => void;
  onSave: () => Promise<void> | void;
  onApprove: () => Promise<void> | void;
  onCreateJob: () => Promise<void> | void;
  onStartBrowserAssist: (jobId: string) => Promise<void> | void;
  onConfirmPublish: (jobId: string) => Promise<void> | void;
  onCorrectStatus: (jobId: string, status: "published" | "failed" | "cancelled", reason: string) => Promise<void> | void;
  onBack: () => void;
}

function csdnJobLabel(status: CsdnPublishJobShape["status"]): string {
  switch (status) {
    case "queued": return "等待开始浏览器发布";
    case "needs_login": return "需要登录 CSDN";
    case "filling": return "浏览器填充中";
    case "needs_user": return "部分字段未可靠填充，需手动补齐";
    case "ready_for_final_confirmation": return "待你在文渡确认发布";
    case "submitting": return "正在读取 CSDN 回执";
    case "published": return "已发布";
    case "needs_manual_reconciliation": return "待人工核对发布结果";
    case "failed_before_submit": return "浏览器填充失败";
    case "failed": return "已标记为发布失败";
    case "cancelled": return "已取消发布";
  }
}

function normalizeImageMime(file: File): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  if (file.type === "image/jpeg" || file.type === "image/png" || file.type === "image/gif" || file.type === "image/webp") return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  throw new Error("只支持 JPG、PNG、GIF 和 WebP 图片。");
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

const SELECTION_ACTIONS: Array<{ value: "humanize" | "rewrite" | "expand" | "shorten" | "example"; label: string }> = [
  { value: "humanize", label: "去 AI 味" },
  { value: "rewrite", label: "改写" },
  { value: "expand", label: "扩写" },
  { value: "shorten", label: "缩写" },
  { value: "example", label: "补充案例" }
];

export function CsdnDraftWorkspace({ draft, accountDisplay, saving, job, onChange, onSave, onApprove, onCreateJob, onStartBrowserAssist, onConfirmPublish, onCorrectStatus, onBack }: CsdnDraftWorkspaceProps) {
  const [leftTool, setLeftTool] = useState<"body" | "structure" | "images">("body");
  const [rightPanel, setRightPanel] = useState<"assistant" | "preview" | "settings">("preview");
  const [dirty, setDirty] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverError, setCoverError] = useState("");
  const [editorMode, setEditorMode] = useState<"visual" | "markdown">("visual");
  const markdownSourceRef = useRef<HTMLTextAreaElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  // AI 助手：选区处理
  const [selectionRange, setSelectionRange] = useState<{ start: number; end: number } | undefined>();
  const [selectionAction, setSelectionAction] = useState<"humanize" | "rewrite" | "expand" | "shorten" | "example">("humanize");
  const [selectionInstruction, setSelectionInstruction] = useState("");
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [selectionResult, setSelectionResult] = useState("");
  const [assistantError, setAssistantError] = useState("");
  const [aiChatLog, setAiChatLog] = useState<Array<{ role: "user" | "assistant"; content: string }>>([]);

  // AI 助手：摘要与封面
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [coverPrompt, setCoverPrompt] = useState("");
  const [coverPromptBusy, setCoverPromptBusy] = useState(false);
  const [coverGenBusy, setCoverGenBusy] = useState(false);
  const [coverProvider, setCoverProvider] = useState<"modelscope" | "gemini">("modelscope");
  const [coverGenError, setCoverGenError] = useState("");

  const wordCount = useMemo(
    () => draft.markdown.replace(/[#>*_`\-\[\]()]/g, "").replace(/\s/g, "").length,
    [draft.markdown]
  );
  const headings = useMemo(() => {
    const result: Array<{ level: number; text: string }> = [];
    for (const line of draft.markdown.split("\n")) {
      const match = /^(#{1,6})\s+(.+)$/.exec(line);
      if (match) result.push({ level: match[1].length, text: match[2].replace(/[*_`]/g, "").trim() });
    }
    return result;
  }, [draft.markdown]);
  const images = useMemo(() => extractMarkdownImages(draft.markdown), [draft.markdown]);

  const leaveWorkspace = () => {
    if (dirty && !window.confirm("CSDN 渠道稿还有未保存的修改。确定放弃这些修改并返回内容库吗？")) return;
    onBack();
  };

  const scrollToHeading = (text: string) => {
    const root = canvasRef.current?.querySelector<HTMLElement>(".visual-markdown-editor");
    if (!root) return;
    const target = [...root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")]
      .find((heading) => heading.textContent?.trim() === text.trim());
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const chooseCover = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setCoverError("");
    setCoverBusy(true);
    try {
      if (file.size > 15 * 1024 * 1024) throw new Error("封面图片不能超过 15 MB。");
      const mimeType = normalizeImageMime(file);
      const base64 = await fileToBase64(file);
      const response = await fetch(`${apiBase}/content-assets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contextId: draft.id, mimeType, base64 })
      });
      const payload = await response.json() as { assetUrl?: string; error?: string };
      if (!response.ok || !payload.assetUrl) throw new Error(payload.error ?? "封面保存失败。");
      setDirty(true);
      onChange({ coverSource: payload.assetUrl });
    } catch (error) {
      setCoverError(error instanceof Error ? error.message : "封面保存失败。");
    } finally {
      setCoverBusy(false);
    }
  };

  const patch = (next: CsdnDraftPatch) => {
    setDirty(true);
    onChange(next);
  };

  const handleSave = async () => {
    await onSave();
    setDirty(false);
  };

  const handleApprove = async () => {
    await onApprove();
    setDirty(false);
  };

  const handleCreateJob = async () => {
    await onCreateJob();
  };

  const isDraft = draft.status === "draft";

  const switchToMarkdown = () => {
    setEditorMode("markdown");
  };
  const switchToVisual = () => {
    setEditorMode("visual");
  };

  const captureVisualSelection = (selection?: VisualMarkdownSelection) => {
    setSelectionResult("");
    setAssistantError("");
    if (!selection) {
      setSelectionRange(undefined);
      return;
    }
    const range = locateMarkdownSelection(draft.markdown, selection.selectedMarkdown);
    if (!range) {
      setAssistantError("暂时无法准确定位这段选区；可能是相同内容出现多次。请缩小选区，或切换到 Markdown 原文模式后重试。");
      setSelectionRange(undefined);
      return;
    }
    setSelectionRange(range);
    setRightPanel("assistant");
  };

  const runSelectionAi = async () => {
    const source = draft.markdown;
    const range = selectionRange;
    const selectedText = range ? source.slice(range.start, range.end) : source;
    setSelectionBusy(true);
    setAssistantError("");
    try {
      const generated = await request<{ replacement: string; conversation?: { userMessage: { content: string }; assistantMessage: { content: string } } }>("/skills/selection-edit/run", {
        method: "POST",
        body: JSON.stringify({
          action: selectionAction,
          title: draft.title,
          contextKey: `csdn:${draft.id}`,
          instruction: selectionInstruction.trim(),
          selectedText,
          beforeText: range ? source.slice(Math.max(0, range.start - 3000), range.start) : "",
          afterText: range ? source.slice(range.end, range.end + 3000) : ""
        })
      });
      setSelectionResult(generated.replacement);
      const conversation = generated.conversation;
      if (conversation) {
        setAiChatLog((current) => [...current,
          { role: "user", content: conversation.userMessage.content },
          { role: "assistant", content: conversation.assistantMessage.content }]);
      }
    } catch (cause) {
      setAssistantError(cause instanceof Error ? cause.message : "选区 AI 处理失败。");
    } finally {
      setSelectionBusy(false);
    }
  };

  const applySelectionResult = () => {
    if (!selectionRange || !selectionResult) return;
    const next = draft.markdown.slice(0, selectionRange.start) + selectionResult + draft.markdown.slice(selectionRange.end);
    patch({ markdown: next });
    setSelectionResult("");
    setSelectionRange(undefined);
  };

  const generateSummary = async () => {
    setSummaryBusy(true);
    setAssistantError("");
    try {
      const generated = await request<{ summary: string }>("/skills/article-summary/run", {
        method: "POST",
        body: JSON.stringify({ platform: "csdn", title: draft.title, markdown: draft.markdown })
      });
      patch({ digest: generated.summary });
    } catch (cause) {
      setAssistantError(cause instanceof Error ? cause.message : "文章摘要生成失败。");
    } finally {
      setSummaryBusy(false);
    }
  };

  const generateCoverPrompt = async () => {
    setCoverPromptBusy(true);
    setCoverGenError("");
    try {
      const generated = await request<{ prompt: string }>("/skills/cover-prompt-generation/run", {
        method: "POST",
        body: JSON.stringify({ title: draft.title, markdown: draft.markdown })
      });
      setCoverPrompt(generated.prompt);
    } catch (cause) {
      setCoverGenError(cause instanceof Error ? cause.message : "封面提示词生成失败。");
    } finally {
      setCoverPromptBusy(false);
    }
  };

  const generateCover = async () => {
    if (!coverPrompt.trim()) {
      setCoverGenError("请先让 AI 根据正文生成提示词，或自行填写提示词。");
      return;
    }
    setCoverGenBusy(true);
    setCoverGenError("");
    try {
      const generated = await request<{ assetUrl: string }>("/skills/cover-generation/run", {
        method: "POST",
        body: JSON.stringify({
          relativePath: draft.sourceRelativePath,
          provider: coverProvider,
          prompt: coverPrompt.trim()
        })
      });
      patch({ coverSource: generated.assetUrl });
    } catch (cause) {
      setCoverGenError(cause instanceof Error ? cause.message : "AI 封面生成失败。");
    } finally {
      setCoverGenBusy(false);
    }
  };

  return <div className="editor-workspace csdn-workspace">
    <header className="editor-topbar">
      <button className="secondary-button" onClick={leaveWorkspace}>← 返回内容库</button>
      <div className="editor-document-title"><strong>{draft.title || "未命名 CSDN 渠道稿"}</strong><small>CSDN 渠道稿 · {accountDisplay}</small></div>
      <div className="editor-top-actions">
        <span>{saving ? "正在保存…" : dirty ? "有未保存修改" : "已保存"}</span>
        {isDraft && <button onClick={() => void handleSave()} disabled={saving || !dirty}>保存渠道稿</button>}
        {isDraft && <button onClick={() => void handleApprove()} disabled={saving}>审核并冻结</button>}
        {!isDraft && !job && <button onClick={() => void handleCreateJob()} disabled={saving}>创建 CSDN 发布任务</button>}
      </div>
    </header>
    <div className="editor-columns">
      <aside className="editor-left-panel">
        <h3>渠道稿工具</h3>
        <button className={`workspace-tool${leftTool === "body" ? " active" : ""}`} onClick={() => setLeftTool("body")}>正文</button>
        <button className={`workspace-tool${leftTool === "structure" ? " active" : ""}`} onClick={() => setLeftTool("structure")}>文章结构</button>
        <button className={`workspace-tool${leftTool === "images" ? " active" : ""}`} onClick={() => setLeftTool("images")}>图片素材</button>
        {leftTool === "body" && <div className="editor-stats"><span>{wordCount} 字</span><span>{images.length} 张图片</span><span>约 {Math.max(1, Math.ceil(wordCount / 500))} 分钟阅读</span></div>}
        {leftTool === "structure" && <div className="tool-detail"><strong>文章结构</strong>{headings.length ? headings.map((heading, index) => <button className="structure-link" key={index} style={{ paddingLeft: `${(heading.level - 1) * 10}px` }} onClick={() => scrollToHeading(heading.text)}>{heading.text}</button>) : <small>正文中还没有标题。</small>}</div>}
        {leftTool === "images" && <div className="tool-detail"><strong>图片素材</strong>{images.length ? images.map((image, index) => <img key={`${image.src}-${index}`} src={resolveArticleImageUrl(image.src, draft.id, draft.sourceRelativePath)} alt={image.alt || "文章图片"} />) : <small>正文中还没有图片。</small>}</div>}
      </aside>
      <section className={`editor-canvas csdn-canvas${editorMode === "markdown" ? " markdown-mode" : ""}`} ref={canvasRef}>
        <p className="hint">当前来源：{draft.generationMode === "source" ? "主稿直接复制（未调用 AI）" : "阿文按 CSDN 调性改写"}。冻结后不能直接修改；主稿变更时应重新生成并审核。</p>
        <label className="csdn-title-field">标题<input value={draft.title} maxLength={120} disabled={!isDraft || saving} onChange={(event) => patch({ title: event.target.value })} /></label>
        {editorMode === "visual" ? <Suspense fallback={<p className="hint">正在打开可视化编辑器…</p>}>
          <VisualMarkdownEditor
            key={draft.id}
            value={draft.markdown}
            assetContextId={draft.id}
            sourceArticlePath={draft.sourceRelativePath}
            uploadToSource={false}
            minHeight={600}
            readOnly={!isDraft || saving}
            onSwitchToMarkdown={switchToMarkdown}
            onTextSelection={isDraft ? captureVisualSelection : undefined}
            onChange={(markdown) => patch({ markdown })}
          />
        </Suspense> : <div className="markdown-editor-shell"><div className="markdown-mode-toolbar editor-mode-switch" aria-label="编辑模式"><button type="button" className="editor-mode-icon" title="切换到所见即所得编辑" aria-label="切换到所见即所得编辑" onClick={switchToVisual}>✎</button><button type="button" className="active editor-mode-icon" title="当前：Markdown 原文" aria-label="当前：Markdown 原文">{"</>"}</button></div><textarea ref={markdownSourceRef} className="markdown-source-editor" value={draft.markdown} disabled={!isDraft || saving} onChange={(event) => patch({ markdown: event.target.value })} onSelect={(event) => { const target = event.currentTarget; const selected = target.selectionEnd > target.selectionStart; setSelectionResult(""); setAssistantError(""); setSelectionRange(selected ? { start: target.selectionStart, end: target.selectionEnd } : undefined); if (selected) setRightPanel("assistant"); }} spellCheck={false} /></div>}
      </section>
      <aside className="editor-right-panel">
        <div className="panel-tabs">
          <button className={rightPanel === "assistant" ? "active" : ""} onClick={() => setRightPanel("assistant")}>AI 助手</button>
          <button className={rightPanel === "preview" ? "active" : ""} onClick={() => setRightPanel("preview")}>手机预览</button>
          <button className={rightPanel === "settings" ? "active" : ""} onClick={() => setRightPanel("settings")}>发布设置</button>
        </div>
        {rightPanel === "assistant" && <div className="side-panel-content selection-assistant">
          <div className="assistant-heading"><div><h3>AI 处理选中文字</h3><small>选中正文后可改写、去 AI 味或补充案例。</small></div></div>
          {assistantError && <p className="error editor-inline-error">{assistantError}</p>}
          {selectionRange ? <><p className="selection-ready">已选中 {selectionRange.end - selectionRange.start} 个字符，默认使用“去 AI 味”。</p><blockquote>{draft.markdown.slice(selectionRange.start, selectionRange.end)}</blockquote></> : <div className="selection-guide"><strong>先选中一段正文，再让 AI 处理</strong><p>未选中时，下达指令会对整篇渠道稿生效；生成建议后可预览，再决定是否应用。</p></div>}
          <div className="selection-action-grid">
            {SELECTION_ACTIONS.map(({ value, label }) => <button type="button" className={selectionAction === value ? "active" : ""} onClick={() => setSelectionAction(value)} key={value}>{label}</button>)}
          </div>
          <label className="selection-instruction"><span>补充要求（可选）</span><textarea value={selectionInstruction} onChange={(event) => setSelectionInstruction(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void runSelectionAi(); } }} disabled={!isDraft || selectionBusy} maxLength={1000} placeholder="例如：保留技术术语，语气更直接；不要使用营销化表达" /></label>
          <button type="button" onClick={() => void runSelectionAi()} disabled={!isDraft || selectionBusy}>{selectionBusy ? "AI 正在处理…" : selectionAction === "humanize" ? "AI 去 AI 味（先预览）" : "生成替换建议（先预览）"}</button>
          {selectionResult && <div className="selection-result"><strong>AI 建议，不会自动覆盖原文</strong><pre>{selectionResult}</pre><div className="selection-result-actions"><button type="button" className="secondary-button" onClick={applySelectionResult}>应用替换</button><button type="button" className="text-button" onClick={() => setSelectionResult("")}>忽略</button></div></div>}
          {aiChatLog.length > 0 && <div className="assistant-chat-log"><h4>与阿文的对话</h4>{aiChatLog.map((message, index) => <div className={`assistant-message ${message.role}`} key={index}><span className="assistant-role">{message.role === "user" ? "你" : "阿文"}</span><p>{message.content}</p></div>)}</div>}
        </div>}
        {rightPanel === "preview" && <div className="phone-frame"><div className="phone-screen"><h2>{draft.title}</h2><small className="phone-byline">{draft.author || accountDisplay}</small>{renderPhonePreview(draft.markdown, draft.id, draft.sourceRelativePath, draft.title)}</div></div>}
        {rightPanel === "settings" && <div className="side-panel-content">
          <h3>发布设置</h3>
          {assistantError && <p className="error editor-inline-error">{assistantError}</p>}
          <label>发布账号<output className="readonly-account">{accountDisplay}</output><small>该渠道稿已绑定此 CSDN 账号；重新生成可选择其他账号。</small></label>
          <label>作者<input value={draft.author} maxLength={16} disabled={!isDraft || saving} onChange={(event) => patch({ author: event.target.value })} placeholder="用于 CSDN 文章署名" /><small>{draft.author.length}/16 字</small></label>
          <label>摘要
            <textarea value={draft.digest} maxLength={200} disabled={!isDraft || saving} onChange={(event) => patch({ digest: event.target.value })} placeholder="用于 CSDN 内容卡片和分享，最多 200 字" />
            <small>{draft.digest.length}/200 字{draft.digest ? "" : " · 默认沿用主稿摘要，也可让 AI 重新生成"}</small>
            <button type="button" className="secondary-button" onClick={() => void generateSummary()} disabled={!isDraft || saving || summaryBusy}>{summaryBusy ? "AI 正在提炼摘要…" : draft.digest ? "AI 重新生成摘要" : "AI 生成适配摘要"}</button>
          </label>
          <div className="settings-cover-section">
            <strong>封面</strong>
            {draft.coverSource && <><img className="settings-cover-preview" src={resolveArticleImageUrl(draft.coverSource, draft.id, draft.sourceRelativePath)} alt="渠道稿封面" /><button type="button" className="text-button danger-text" onClick={() => patch({ coverSource: "" })} disabled={!isDraft || saving}>移除封面</button></>}
            <button type="button" className="secondary-button" onClick={() => document.getElementById("csdn-cover-input")?.click()} disabled={!isDraft || saving || coverBusy}>{coverBusy ? "正在上传…" : "选择本地图片"}</button>
            <input id="csdn-cover-input" type="file" accept="image/jpeg,image/png,image/gif,image/webp" hidden onChange={(event) => void chooseCover(event)} />
            {coverError && <p className="error">{coverError}</p>}
            <details className="ai-cover-details">
              <summary>AI 生成封面</summary>
              <label>图片模型
                <select value={coverProvider} onChange={(event) => { setCoverProvider(event.target.value as "modelscope" | "gemini"); setCoverGenError(""); }}>
                  <option value="modelscope">ModelScope</option>
                  <option value="gemini">Google Gemini</option>
                </select>
              </label>
              <div className="cover-prompt-heading"><strong>封面提示词</strong><button type="button" className="secondary-button compact-action" onClick={() => void generateCoverPrompt()} disabled={coverPromptBusy || coverGenBusy || !isDraft || saving}>{coverPromptBusy ? "AI 正在分析正文…" : coverPrompt.trim() ? "重新生成提示词" : "AI 根据正文生成提示词"}</button></div>
              <textarea value={coverPrompt} maxLength={2000} disabled={!isDraft || saving} onChange={(event) => { setCoverPrompt(event.target.value); setCoverGenError(""); }} placeholder="可以自己填写，也可以让 AI 根据标题和正文生成；生成后仍可修改构图、风格和是否包含文字" />
              <small>{coverPrompt.length}/2000 字 · 图片模型只会收到这里最终确认的提示词</small>
              <button type="button" className="secondary-button" onClick={() => void generateCover()} disabled={coverGenBusy || coverPromptBusy || !coverPrompt.trim() || !isDraft || saving}>{coverGenBusy ? "正在生成封面…" : "使用此提示词生成并设为封面"}</button>
              {coverGenError && <div className="cover-action-error" role="alert"><strong>封面生成未完成</strong><span>{coverGenError}</span></div>}
            </details>
          </div>
          {!isDraft && <p className="status-badge success">渠道稿已冻结</p>}
          {!isDraft && !job && <p className="hint">点击“创建 CSDN 发布任务”会生成一条本地可恢复任务，不会立即向 CSDN 提交内容。之后通过可见浏览器完成登录、填充与最终确认发布。</p>}
          {job && <CsdnPublishPanel job={job} saving={saving} onStartBrowserAssist={onStartBrowserAssist} onConfirmPublish={onConfirmPublish} onCorrectStatus={onCorrectStatus} />}
        </div>}
      </aside>
    </div>
  </div>;
}

function CsdnPublishPanel({ job, saving, onStartBrowserAssist, onConfirmPublish, onCorrectStatus }: {
  job: CsdnPublishJobShape;
  saving: boolean;
  onStartBrowserAssist: (jobId: string) => Promise<void> | void;
  onConfirmPublish: (jobId: string) => Promise<void> | void;
  onCorrectStatus: (jobId: string, status: "published" | "failed" | "cancelled", reason: string) => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [correctStatus, setCorrectStatus] = useState<"published" | "failed" | "cancelled">("published");
  const [correctReason, setCorrectReason] = useState("");

  const canStart = ["queued", "needs_login", "filling", "needs_user", "ready_for_final_confirmation", "failed_before_submit", "needs_manual_reconciliation"].includes(job.status);
  const canConfirm = job.status === "ready_for_final_confirmation" || job.status === "needs_user";
  const canCorrect = ["needs_login", "filling", "submitting", "needs_manual_reconciliation", "failed_before_submit", "failed", "cancelled", "published"].includes(job.status);

  const run = async (action: (id: string) => Promise<void> | void) => {
    setBusy(true);
    try {
      await action(job.id);
    } catch {
      // 错误已在父级统一提示
    } finally {
      setBusy(false);
    }
  };

  return <section className="csdn-publish-panel" role="status">
    <h3>浏览器发布</h3>
    <p className="hint">CSDN 通过可见浏览器完成登录、填充与发布；文渡不会绕过你的确认自动发布。</p>
    <p className="csdn-job-status">{csdnJobLabel(job.status)}<small>{new Date(job.updatedAt).toLocaleString()}</small></p>
    {job.statusNote && <p className="hint compact-hint">{job.statusNote}</p>}
    {job.errorMessage && <p className="error">{job.errorMessage}</p>}
    <div className="csdn-publish-actions">
      {canStart && <button onClick={() => void run(onStartBrowserAssist)} disabled={busy || saving}>在浏览器中完成发布</button>}
      {canConfirm && <button className="secondary-button" onClick={() => void run(onConfirmPublish)} disabled={busy || saving}>我已在 CSDN 发布</button>}
      {job.status === "submitting" && <span className="status-badge">正在读取 CSDN 回执…</span>}
      {job.status === "published" && job.remoteUrl && <a href={job.remoteUrl} target="_blank" rel="noreferrer" className="text-button">查看已发布文章</a>}
      {canCorrect && <button className="text-button" onClick={() => setCorrecting((current) => !current)} disabled={busy || saving}>校正状态</button>}
    </div>
    {job.status === "published" && !job.remoteUrl && <p className="hint">已发布，但未能自动读回文章链接，请在浏览器中核对。</p>}
    {correcting && <form className="csdn-correct-form" onSubmit={(event) => {
      event.preventDefault();
      void run((id) => onCorrectStatus(id, correctStatus, correctReason));
      setCorrecting(false);
    }}>
      <label>最终状态<select value={correctStatus} onChange={(event) => setCorrectStatus(event.target.value as "published" | "failed" | "cancelled")}>
        <option value="published">已发布</option>
        <option value="failed">发布失败</option>
        <option value="cancelled">取消发布</option>
      </select></label>
      <label>核实依据（可选）<textarea value={correctReason} maxLength={500} placeholder="例如：在 CSDN 后台确认已发布，文章链接为……" onChange={(event) => setCorrectReason(event.target.value)} /></label>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setCorrecting(false)}>取消</button><button type="submit" disabled={busy || saving}>确认校正</button></div>
    </form>}
  </section>;
}
