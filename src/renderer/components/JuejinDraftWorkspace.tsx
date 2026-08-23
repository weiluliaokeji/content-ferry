import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { VisualMarkdownEditor } from "./VisualMarkdownEditor";
import type { VisualMarkdownSelection } from "./VisualMarkdownEditor";
import { request, apiBase, renderPhonePreview, resolveArticleImageUrl, extractMarkdownImages } from "../main";
import { locateMarkdownSelection } from "../markdown-selection";

interface JuejinChannelDraftShape {
  id: string; accountId: string; sourceRelativePath: string; generationMode: "rewrite" | "source";
  title: string; markdown: string; author: string; digest: string; coverSource: string;
  status: "draft" | "approved" | "superseded";
}

export type JuejinDraftPatch = Partial<Pick<JuejinChannelDraftShape, "title" | "markdown" | "author" | "digest" | "coverSource">>;

interface JuejinPublishJobShape {
  id: string;
  status: "draft_creating" | "draft_created" | "confirming" | "published" | "failed" | "needs_manual_reconciliation" | "cancelled" | "needs_credentials";
  statusNote: string | null;
  errorMessage: string | null;
  remoteUrl: string | null;
  remoteContentId: string | null;
  updatedAt: string;
}

interface JuejinPublishOptions {
  categoryId: string;
  tagIds: string[];
}

interface JuejinDraftWorkspaceProps {
  draft: JuejinChannelDraftShape;
  accountDisplay: string;
  saving: boolean;
  job?: JuejinPublishJobShape;
  error?: string;
  onClearError?: () => void;
  onChange: (patch: JuejinDraftPatch) => void;
  onSave: () => Promise<void> | void;
  onPublish: (options: JuejinPublishOptions) => void;
  onConfirmPublish: (jobId: string) => Promise<void> | void;
  onCorrectStatus: (jobId: string, status: "published" | "failed" | "cancelled", reason: string) => Promise<void> | void;
  onGoToCredentials: () => void;
  onDelete: () => Promise<void> | void;
  onBack: () => void;
}

function juejinJobLabel(status: JuejinPublishJobShape["status"]): string {
  switch (status) {
    case "draft_creating": return "正在创建掘金草稿";
    case "draft_created": return "掘金草稿已创建，待确认公开";
    case "confirming": return "正在公开发布";
    case "published": return "已发布";
    case "failed": return "已标记为发布失败";
    case "needs_manual_reconciliation": return "待人工核对发布结果";
    case "cancelled": return "已取消发布";
    case "needs_credentials": return "需要配置掘金凭据";
  }
}

/** 掘金固定分类 ID（来自 PsChina/web-publish adapters/juejin.yaml 实测）。 */
const JUEJIN_CATEGORIES: Array<{ label: string; id: string }> = [
  { label: "后端", id: "6809637769959178254" },
  { label: "前端", id: "6809637767543259144" },
  { label: "Android", id: "6809635626879549454" },
  { label: "iOS", id: "6809635626661445640" },
  { label: "人工智能", id: "6809637773935378440" },
  { label: "开发工具", id: "6809637771511070734" },
  { label: "代码人生", id: "6809637776263217160" },
  { label: "阅读", id: "6809637772874219534" }
];

/** 掘金已知 tag 名 → ID 映射；未命中的输入按 tag ID 原文透传。 */
const JUEJIN_KNOWN_TAGS: Record<string, string> = {
  "AI编程": "7467857238494020000",
  "OpenAI": "6809641073527226000",
  "AIGC": "7197380506562871000"
};

/** 掘金分类关键词组（id 对应 JUEJIN_CATEGORIES）：按标题+正文命中数最多的分类胜出。 */
const JUEJIN_CATEGORY_KEYWORDS: Array<{ id: string; keywords: string[] }> = [
  { id: "6809637769959178254", keywords: ["后端", "java", "spring", "微服务", "数据库", "mysql", "redis", "golang", "服务端", "接口", "架构", "分布式", "中间件", "docker", "kubernetes", "k8s", "linux", "nginx", "消息队列", "kafka", "高并发"] },
  { id: "6809637767543259144", keywords: ["前端", "react", "vue", "javascript", "typescript", "html", "css", "组件", "界面", "网页", "浏览器", "web", "node"] },
  { id: "6809635626879549454", keywords: ["android", "安卓", "kotlin", "gradle", "apk"] },
  { id: "6809635626661445640", keywords: ["ios", "swift", "objective-c", "xcode", "iphone", "macos"] },
  { id: "6809637773935378440", keywords: ["人工智能", "大模型", "llm", "gpt", "机器学习", "深度学习", "神经网络", "nlp", "多模态", "rag", "智能体", "aigc", "prompt", "提示词", "微调", "finetune", "embedding", "token", "ai"] },
  { id: "6809637771511070734", keywords: ["开发工具", "vscode", "ide", "编辑器", "命令行", "终端", "git", "github", "调试", "性能优化", "测试", "构建", "ci/cd", "自动化"] },
  { id: "6809637776263217160", keywords: ["程序员", "代码人生", "职场", "面试", "职业", "成长", "心得", "经验", "随笔"] },
  { id: "6809637772874219534", keywords: ["阅读", "读书", "书评", "读后感", "荐书", "书单"] }
];

/** 判断 text 是否包含 keyword：纯英文/数字类关键词按单词边界匹配，其余按子串匹配。 */
function textContainsKeyword(text: string, keyword: string): boolean {
  const lower = text.toLowerCase();
  const kw = keyword.toLowerCase();
  if (/^[a-z0-9][a-z0-9+#._-]*$/.test(kw)) {
    return new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower);
  }
  return lower.includes(kw);
}

/** 根据标题+正文自动推断掘金分类 id：命中关键词最多的分类胜出，无命中时返回默认分类（代码人生）。 */
export function inferJuejinCategory(title: string, markdown: string): string {
  const text = `${title}\n${markdown}`.toLowerCase();
  let bestId = "";
  let bestScore = 0;
  for (const group of JUEJIN_CATEGORY_KEYWORDS) {
    let score = 0;
    for (const keyword of group.keywords) {
      if (textContainsKeyword(text, keyword)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestId = group.id;
    }
  }
  if (bestId) return bestId;
  const fallback = JUEJIN_CATEGORIES.find((category) => category.label === "代码人生");
  return fallback?.id ?? JUEJIN_CATEGORIES[0]?.id ?? "";
}

/** 根据标题+正文从官方标签中推断最多 3 个掘金标签 id（id 必须真实存在于 availableTags，严禁造非法 tag_id）。 */
export function inferJuejinTags(title: string, markdown: string, availableTags: Array<{ id: string; name: string }>): string[] {
  const text = `${title}\n${markdown}`.toLowerCase();
  const matched: string[] = [];
  for (const tag of availableTags) {
    if (matched.length >= 3) break;
    const name = tag.name.trim();
    if (!name) continue;
    if (textContainsKeyword(text, name)) {
      matched.push(tag.id);
      continue;
    }
    // 内置映射兜底：标题/正文出现内置标签名时，选中官方标签中同名者。
    for (const knownName of Object.keys(JUEJIN_KNOWN_TAGS)) {
      if (knownName.toLowerCase() === name.toLowerCase() && textContainsKeyword(text, knownName)) {
        matched.push(tag.id);
        break;
      }
    }
  }
  return matched;
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

export function JuejinDraftWorkspace({ draft, accountDisplay, saving, job, error, onClearError, onChange, onSave, onPublish, onConfirmPublish, onCorrectStatus, onGoToCredentials, onDelete, onBack }: JuejinDraftWorkspaceProps) {
  const [leftTool, setLeftTool] = useState<"body" | "structure" | "images">("body");
  const [rightPanel, setRightPanel] = useState<"assistant" | "preview" | "settings">("preview");
  const [dirty, setDirty] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverError, setCoverError] = useState("");
  const [editorMode, setEditorMode] = useState<"visual" | "markdown">("visual");
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [publishCategory, setPublishCategory] = useState("");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [availableTags, setAvailableTags] = useState<Array<{ id: string; name: string }>>([]);
  const [tagsLoading, setTagsLoading] = useState(true);
  const [tagsError, setTagsError] = useState("");
  const [tagSearch, setTagSearch] = useState("");
  const [correcting, setCorrecting] = useState(false);
  const [correctionStatus, setCorrectionStatus] = useState<"published" | "failed" | "cancelled">("published");
  const [correctionReason, setCorrectionReason] = useState("已在掘金后台核实");
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const [correctionError, setCorrectionError] = useState("");
  const markdownSourceRef = useRef<HTMLTextAreaElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const userTouchedPublishRef = useRef(false);

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
  const [coverProvider, setCoverProvider] = useState<"modelscope" | "agnes">("modelscope");
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
    if (dirty && !window.confirm("掘金渠道稿还有未保存的修改。确定放弃这些修改并返回内容库吗？")) return;
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

  const patch = (next: JuejinDraftPatch) => {
    setDirty(true);
    onChange(next);
  };

  const handleSave = async () => {
    await onSave();
    setDirty(false);
  };

  const handlePublish = () => {
    if (!publishCategory) return;
    if (selectedTagIds.length === 0) {
      setTagsError("请至少选择一个掘金标签后再发布。");
      return;
    }
    onPublish({ categoryId: publishCategory, tagIds: selectedTagIds });
  };

  const handleConfirmPublish = async () => {
    if (!job) return;
    setConfirmBusy(true);
    try {
      await onConfirmPublish(job.id);
    } catch {
      // 失败由 onConfirmPublish 内部统一 setError 上报，并在下方 error 条中显示
    } finally {
      setConfirmBusy(false);
    }
  };

  const handleCorrectStatus = async () => {
    if (!job) return;
    const action = correctionStatus === "published" ? "已发布" : correctionStatus === "cancelled" ? "取消发布" : "发布失败";
    if (!window.confirm(`确定将掘金发布任务人工标记为“${action}”吗？\n\n此操作只校正文渡中的记录，不会调用掘金接口，也不会重新发布。`)) return;
    setCorrectionBusy(true);
    setCorrectionError("");
    try {
      await onCorrectStatus(job.id, correctionStatus, correctionReason);
      setCorrecting(false);
      setCorrectionReason("已在掘金后台核实");
    } catch (cause) {
      setCorrectionError(cause instanceof Error ? cause.message : "人工校正掘金发布状态失败。");
    } finally {
      setCorrectionBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm("确定删除这篇掘金渠道稿吗？删除后将从头重新生成，已绑定的发布任务也会一并清除，且不可恢复。")) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await onDelete();
      // 成功后由父级 onDelete 重新拉起生成入口并卸载本组件；
      // 若未卸载（例如接口未真正删除）则恢复按钮状态。
      setDeleteBusy(false);
    } catch (cause) {
      setDeleteBusy(false);
      setDeleteError(cause instanceof Error ? cause.message : "删除失败。");
    }
  };

  const isDraft = draft.status === "draft";
  const jobStatus = job?.status;

  // 分类/标签可编辑条件：草稿始终可编辑；已冻结稿只有在尚未创建任务、
  // 或任务已取消/失败（可重新发布）时才允许重新选择分类与标签。
  const canEditPublishOptions = isDraft || !job || jobStatus === "cancelled" || jobStatus === "failed";

  // 加载掘金官方标签选项（掘金要求至少 1 个标签，且必须是官方 tag_id）。
  useEffect(() => {
    let cancelled = false;
    setTagsLoading(true);
    setTagsError("");
    request<{ items: Array<{ id: string; name: string }> }>(`/integrations/juejin/tags/${draft.accountId}`)
      .then((payload) => {
        if (cancelled) return;
        const items = Array.isArray(payload?.items) ? payload.items : [];
        if (items.length === 0) throw new Error("掘金标签列表为空。");
        setAvailableTags(items);
      })
      .catch((cause) => {
        if (cancelled) return;
        setTagsError(cause instanceof Error ? cause.message : "无法加载掘金标签。");
        setAvailableTags(Object.entries(JUEJIN_KNOWN_TAGS).map(([name, id]) => ({ id, name })));
      })
      .finally(() => { if (!cancelled) setTagsLoading(false); });
    return () => { cancelled = true; };
  }, [draft.accountId]);

  // 自动按文章内容推断分类与标签：仅当用户尚未手动设置过、且分类标签可编辑时生效；
  // 用户手动改动过分类或标签后不再覆盖。
  useEffect(() => {
    if (!canEditPublishOptions) return;
    if (userTouchedPublishRef.current) return;
    const category = inferJuejinCategory(draft.title, draft.markdown);
    if (category) setPublishCategory(category);
    if (availableTags.length > 0) {
      setSelectedTagIds(inferJuejinTags(draft.title, draft.markdown, availableTags));
    }
  }, [draft.title, draft.markdown, availableTags, canEditPublishOptions]);

  const toggleTag = (id: string) => {
    userTouchedPublishRef.current = true;
    setSelectedTagIds((current) =>
      current.includes(id)
        ? current.filter((tagId) => tagId !== id)
        : current.length >= 5 ? current : [...current, id]
    );
  };

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
          contextKey: `juejin:${draft.id}`,
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
        body: JSON.stringify({ platform: "juejin", title: draft.title, markdown: draft.markdown })
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

  const showReconciliationForm = jobStatus === "needs_manual_reconciliation";

  return <div className="editor-workspace cnblogs-workspace">
    {error && <div className="cnblogs-workspace-error" role="alert">
      <span className="cnblogs-workspace-error-text">{error}</span>
      <button type="button" className="text-button" onClick={() => onClearError?.()}>知道了</button>
    </div>}
    <header className="editor-topbar">
      <button className="secondary-button" onClick={leaveWorkspace}>← 返回内容库</button>
      <div className="editor-document-title"><strong>{draft.title || "未命名掘金渠道稿"}</strong><small>掘金渠道稿 · {accountDisplay}</small></div>
      <div className="editor-top-actions">
        <span>{saving ? "正在保存…" : dirty ? "有未保存修改" : "已保存"}</span>
        {job && <span className="hint cnblogs-inline-status">{juejinJobLabel(job.status)}</span>}
        {isDraft && <button onClick={() => void handleSave()} disabled={saving || !dirty}>保存渠道稿</button>}
        {!job && <button onClick={handlePublish} disabled={saving || !publishCategory || selectedTagIds.length === 0}>发布到掘金</button>}
        {jobStatus === "draft_creating" && <span className="status-badge neutral">正在创建掘金草稿…</span>}
        {jobStatus === "draft_created" && <>
          {job?.remoteUrl && <a href={job.remoteUrl} target="_blank" rel="noreferrer" className="secondary-button">查看掘金草稿</a>}
          <button onClick={() => void handleConfirmPublish()} disabled={confirmBusy || saving}>{confirmBusy ? "正在公开…" : "确认公开"}</button>
        </>}
        {jobStatus === "confirming" && <span className="status-badge neutral">正在公开发布…</span>}
        {jobStatus === "published" && (job?.remoteUrl ? <a href={job.remoteUrl} target="_blank" rel="noreferrer" className="text-button">查看已发布文章</a> : <span className="status-badge success">已发布</span>)}
        {jobStatus === "failed" && <button onClick={handlePublish} disabled={saving}>重试发布</button>}
        {jobStatus === "cancelled" && <button onClick={handlePublish} disabled={saving}>重新发布</button>}
        {jobStatus === "needs_credentials" && <>
          <button onClick={onGoToCredentials} className="secondary-button">前往账号管理配置凭据</button>
          <button onClick={handlePublish} disabled={saving}>重新尝试发布</button>
        </>}
        {showReconciliationForm && !correcting && <button className="secondary-button" onClick={() => setCorrecting(true)} disabled={correctionBusy}>人工校正</button>}
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
      <section className={`editor-canvas cnblogs-canvas${editorMode === "markdown" ? " markdown-mode" : ""}`} ref={canvasRef}>
        <p className="hint">当前来源：{draft.generationMode === "source" ? "主稿直接复制（未调用 AI）" : "阿文按掘金调性改写"}。冻结后不能直接修改；主稿变更时应重新生成并审核。</p>
        <label className="cnblogs-title-field">标题<input value={draft.title} maxLength={80} disabled={!isDraft || saving} onChange={(event) => patch({ title: event.target.value })} /><small>{draft.title.length}/80 字 · 掘金标题上限 80 字</small></label>
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
          {jobStatus === "needs_credentials" && <div className="status-badge warning cnblogs-credential-banner">掘金账号尚未配置 Cookie / aid / uuid，请先前往账号管理补凭据后重试。</div>}
          {jobStatus === "failed" && job?.errorMessage && <div className="cnblogs-publish-error" role="alert"><strong>发布失败</strong><span>{job.errorMessage}</span><small>可重新选择分类与标签后点击顶部「重试发布」再次尝试；如仍失败，可在掘金后台核对后使用人工校正。</small></div>}
          {jobStatus === "cancelled" && <p className="hint">本次发布任务已取消。可重新选择分类与标签后，点击顶部「重新发布」创建新任务。</p>}
          {showReconciliationForm && <div className="cnblogs-reconcile-form">
            {!correcting ? <p className="hint">发布结果无法自动确认（回执缺失或异常）。请到掘金后台核对草稿/文章实际状态后人工校正。</p> : <>
              <label>最终状态<select value={correctionStatus} onChange={(event) => setCorrectionStatus(event.target.value as "published" | "failed" | "cancelled")}><option value="published">已发布</option><option value="failed">发布失败</option><option value="cancelled">取消发布</option></select></label>
              <label>核实依据（可选）<textarea autoFocus value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} maxLength={500} placeholder="例如：在掘金“创作中心”页确认已发布，文章链接为……" /><small>{correctionReason.length}/500，可留空</small></label>
              {correctionError && <p className="error editor-inline-error">{correctionError}</p>}
              <div className="cnblogs-reconcile-actions"><button type="button" className="secondary-button" onClick={() => { setCorrecting(false); setCorrectionError(""); }} disabled={correctionBusy}>取消</button><button type="button" onClick={() => void handleCorrectStatus()} disabled={correctionBusy}>{correctionBusy ? "正在保存…" : "确认校正"}</button></div>
            </>}
          </div>}
          <label>发布账号<output className="readonly-account">{accountDisplay}</output><small>该渠道稿已绑定此掘金账号；重新生成可选择其他账号。</small></label>
          <label>作者<input value={draft.author} maxLength={16} disabled={!isDraft || saving} onChange={(event) => patch({ author: event.target.value })} placeholder="仅用于本地标识与预览署名" /><small>掘金 API 不含作者字段，此字段不会随文章发布。</small></label>
          <label>摘要
            <textarea value={draft.digest} maxLength={100} disabled={!isDraft || saving} onChange={(event) => patch({ digest: event.target.value })} placeholder="用于掘金列表摘要（brief_content），最多 100 字" />
            <small>{draft.digest.length}/100 字{draft.digest ? "" : " · 默认沿用主稿摘要，也可让 AI 重新生成"}</small>
            <button type="button" className="secondary-button" onClick={() => void generateSummary()} disabled={!isDraft || saving || summaryBusy}>{summaryBusy ? "AI 正在提炼摘要…" : draft.digest ? "AI 重新生成摘要" : "AI 生成适配摘要"}</button>
          </label>
          <label>分类（必选）<select value={publishCategory} disabled={!canEditPublishOptions} onChange={(event) => { userTouchedPublishRef.current = true; setPublishCategory(event.target.value); }}><option value="">请选择分类…</option>{JUEJIN_CATEGORIES.map((category) => <option key={category.id} value={category.id}>{category.label}</option>)}</select><small>掘金要求必选一个分类；草稿已创建且任务进行中时不可修改。</small></label>
          <label>标签（必选 1~5 个）
            {tagsLoading ? <p className="hint">正在加载掘金官方标签…</p> : <>
              <input value={tagSearch} disabled={!canEditPublishOptions} onChange={(event) => setTagSearch(event.target.value)} placeholder="搜索掘金标签…" />
              <div className="juejin-tag-options">
                {availableTags.filter((tag) => tag.name.includes(tagSearch.trim())).map((tag) => (
                  <button type="button" key={tag.id} className={selectedTagIds.includes(tag.id) ? "active" : ""} disabled={!canEditPublishOptions} onClick={() => toggleTag(tag.id)}>{tag.name}</button>
                ))}
              </div>
              <small>已选 {selectedTagIds.length}/5 个 · 选项来自掘金官方标签{tagsError ? `（加载失败：${tagsError}，已回退内置常用标签）` : ""}；草稿已创建且任务进行中时不可修改。</small>
            </>}
          </label>
          <div className="cnblogs-publish-flow"><strong>发布流程</strong><small>1. 点击「发布到掘金」，渠道稿冻结为快照并创建掘金草稿；2. 草稿创建完成后可先到掘金草稿箱预览；3. 点击「确认公开」后文章正式对外可见。</small></div>
          <div className="settings-cover-section">
            <strong>封面</strong>
            {draft.coverSource && <><img className="settings-cover-preview" src={resolveArticleImageUrl(draft.coverSource, draft.id, draft.sourceRelativePath)} alt="渠道稿封面" /><button type="button" className="text-button danger-text" onClick={() => patch({ coverSource: "" })} disabled={!isDraft || saving}>移除封面</button></>}
            <button type="button" className="secondary-button" onClick={() => document.getElementById("juejin-cover-input")?.click()} disabled={!isDraft || saving || coverBusy}>{coverBusy ? "正在上传…" : "选择本地图片"}</button>
            <input id="juejin-cover-input" type="file" accept="image/jpeg,image/png,image/gif,image/webp" hidden onChange={(event) => void chooseCover(event)} />
            {coverError && <p className="error">{coverError}</p>}
            <details className="ai-cover-details">
              <summary>AI 生成封面</summary>
              <label>图片模型
                <select value={coverProvider} onChange={(event) => { setCoverProvider(event.target.value as "modelscope" | "agnes"); setCoverGenError(""); }}>
                  <option value="modelscope">ModelScope</option>
                  <option value="agnes">Agnes AI</option>
                </select>
              </label>
              <div className="cover-prompt-heading"><strong>封面提示词</strong><button type="button" className="secondary-button compact-action" onClick={() => void generateCoverPrompt()} disabled={coverPromptBusy || coverGenBusy || !isDraft || saving}>{coverPromptBusy ? "AI 正在分析正文…" : coverPrompt.trim() ? "重新生成提示词" : "AI 根据正文生成提示词"}</button></div>
              <textarea value={coverPrompt} maxLength={2000} disabled={!isDraft || saving} onChange={(event) => { setCoverPrompt(event.target.value); setCoverGenError(""); }} placeholder="可以自己填写，也可以让 AI 根据标题和正文生成；生成后仍可修改构图、风格和是否包含文字" />
              <small>{coverPrompt.length}/2000 字 · 图片模型只会收到这里最终确认的提示词</small>
              <button type="button" className="secondary-button" onClick={() => void generateCover()} disabled={coverGenBusy || coverPromptBusy || !coverPrompt.trim() || !isDraft || saving}>{coverGenBusy ? "正在生成封面…" : "使用此提示词生成并设为封面"}</button>
              {coverGenError && <div className="cover-action-error" role="alert"><strong>封面生成未完成</strong><span>{coverGenError}</span></div>}
            </details>
          </div>
          {!isDraft && <p className="status-badge success">已锁定发布快照（如需修改可重新生成渠道稿）</p>}
          {!isDraft && !job && <p className="hint">渠道稿已锁定为快照。点击顶部的「发布到掘金」会创建掘金草稿（默认不公开），确认后再正式发布。</p>}
          <div className="settings-danger-section">
            <strong>删除渠道稿</strong>
            <small>删除后该渠道稿及已绑定的发布任务都会被清除，需从头重新生成。</small>
            <button type="button" className="danger-button" onClick={() => void handleDelete()} disabled={deleteBusy || saving}>{deleteBusy ? "正在删除…" : "删除这篇掘金渠道稿"}</button>
            {deleteError && <p className="error editor-inline-error">{deleteError}</p>}
          </div>
        </div>}
      </aside>
    </div>
  </div>;
}
