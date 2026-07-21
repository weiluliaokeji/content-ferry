import { FormEvent, lazy, StrictMode, Suspense, type ReactNode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import wenduLogo from "./assets/wendu-icon.png";

const apiBase = "http://127.0.0.1:4317/api";
const VisualMarkdownEditor = lazy(() =>
  import("./components/VisualMarkdownEditor").then((module) => ({ default: module.VisualMarkdownEditor }))
);

type AccountPlatform = "wechat_official" | "csdn";
type AccountProfile = { positioning: string; targetAudience: string; prohibitedTopics: string; writingStyle: string; regularColumns: string };
type MediaAccount = { id: string; platform: AccountPlatform; displayName: string; credentialsConfigured: boolean; profile: AccountProfile };
type ContentSourcePreview = { rootPath: string; articleCount: number; sitePageCount: number; items: Array<{ relativePath: string; title: string | null; frontMatterKeys: string[]; createdAt: string | null }>; truncated: boolean; warnings: string[] };
type ContentSourceArticle = { relativePath: string; title: string | null; markdown: string; frontMatter: string };
type ContentProject = { id: string; targetAccountId: string | null; sourceRelativePath: string | null; topic: string; status: "idea"; briefReady: boolean; outlineReady: boolean; draftReady: boolean; reviewStatus: "pending" | "needs_revision" | "approved" | null };
type ContentBrief = { projectId: string; objective: string; audience: string; angle: string; sourceNotes: string; generatedFromAccountProfile: boolean };
type ContentOutline = { projectId: string; markdown: string; generatedFromBrief: boolean };
type ContentDraft = { projectId: string; markdown: string; generatedFromOutline: boolean; sourceRelativePath?: string | null };
type ContentReview = { projectId: string; status: "pending" | "needs_revision" | "approved"; factChecked: boolean; accountFitChecked: boolean; aiCheckResult: string; notes: string };
type WechatPublishJob = {
  id: string; accountId: string; projectId: string | null; sourceRelativePath: string | null; mode: "draft" | "publish" | "mass"; title: string;
  draftMediaId: string | null; publishId: string | null; messageId: string | null;
  status: "draft_ready" | "submitted" | "published" | "failed" | "cancelled"; errorMessage: string | null;
  statusSource: "system" | "wechat" | "manual"; statusNote: string | null; updatedAt: string;
};
type WechatCredentialStatus = { appId: string; appSecretConfigured: boolean; callbackTokenConfigured: boolean; localCallbackUrl: string };
type WechatMaterial = { mediaId: string; name: string; updatedAt: string; url: string | null };
type SelectedImage = { fileName: string; mimeType: string; base64: string };
type ArticleSettings = { author: string; digest: string; coverSource: string; accountId: string };
type ModelProviderId = "openai_codex" | "openai" | "openrouter" | "github_copilot" | "modelscope" | "gemini";
type ModelConnection = {
  provider: ModelProviderId; displayName: string; modelId: string; baseUrl: string; proxyUrl: string;
  enabled: boolean; credentialConfigured: boolean;
};
type ManagedSkill = {
  id: string; name: string; description: string; category: "创作" | "改写" | "检测" | "图片";
  enabled: boolean; provider: ModelProviderId | null; markdown: string; filePath: string;
};
type ZhuqueReport = {
  verdict: string;
  humanPercent: number | null;
  uncertainPercent: number | null;
  aiPercent: number | null;
  ratioSource: "official" | "segments";
  segments: Array<{ text: string; kind: "human" | "uncertain" | "ai" }>;
};
type RuntimeLogEntry = {
  time: number | null; level: number; message: string; requestId: string; method: string; url: string;
  statusCode: number | null; responseTime: number | null; error: string;
};
type RuntimeLogResponse = {
  filePath: string; items: RuntimeLogEntry[]; availableDates?: string[];
  totalMatched: number; hasMore: boolean; sourceTruncated: boolean; readWindowBytes: number;
};

const emptyProfile: AccountProfile = { positioning: "", targetAudience: "", prohibitedTopics: "", writingStyle: "", regularColumns: "" };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${apiBase}${path}`, { ...init, headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(payload?.error ?? `本地服务暂不可用（${response.status}）`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function streamGeneration<T>(path: string, signal: AbortSignal, onEvent: (event: string, data: Record<string, unknown>) => void): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal });
  if (!response.ok || !response.body) throw new Error(`本地服务暂不可用（${response.status}）。`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: T | undefined;
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const event = /^event:\s*(.+)$/m.exec(frame)?.[1] ?? "message";
      const raw = /^data:\s*(.+)$/m.exec(frame)?.[1];
      if (!raw) continue;
      const data = JSON.parse(raw) as Record<string, unknown>;
      onEvent(event, data);
      if (event === "error") throw new Error(String(data.error ?? "AI 生成失败。"));
      if (event === "complete") completed = data as T;
    }
    if (done) break;
  }
  if (!completed) throw new Error("AI 生成未返回完成结果。");
  return completed;
}

const platformName = (platform: AccountPlatform) => platform === "wechat_official" ? "微信公众号" : "CSDN";
const providerName = (provider: ModelProviderId | null) => provider === null ? "无需模型" : ({
  openai_codex: "OpenAI Codex",
  openai: "OpenAI API",
  openrouter: "OpenRouter",
  github_copilot: "GitHub Copilot",
  modelscope: "ModelScope",
  gemini: "Google Gemini"
} as Record<ModelProviderId, string>)[provider];

function markdownTitle(markdown: string): string | undefined {
  return markdown.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim() || undefined;
}

function App() {
  const [accounts, setAccounts] = useState<MediaAccount[]>([]);
  const [projects, setProjects] = useState<ContentProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [platform, setPlatform] = useState<AccountPlatform>("wechat_official");
  const [displayName, setDisplayName] = useState("");
  const [editing, setEditing] = useState<MediaAccount>();
  const [editingDisplayName, setEditingDisplayName] = useState("");
  const [profile, setProfile] = useState<AccountProfile>(emptyProfile);
  const [sourceModalOpen, setSourceModalOpen] = useState(false);
  const [sourcePath, setSourcePath] = useState("");
  const [sourcePreview, setSourcePreview] = useState<ContentSourcePreview>();
  const [sourceArticle, setSourceArticle] = useState<ContentSourceArticle>();
  const [articleWorkspacePanel, setArticleWorkspacePanel] = useState<"assistant" | "preview" | "settings">("assistant");
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projectTopic, setProjectTopic] = useState("");
  const [projectAccountId, setProjectAccountId] = useState("");
  const [briefProject, setBriefProject] = useState<ContentProject>();
  const [brief, setBrief] = useState<ContentBrief>();
  const [outlineProject, setOutlineProject] = useState<ContentProject>();
  const [outline, setOutline] = useState<ContentOutline>();
  const [outlineGenerating, setOutlineGenerating] = useState(false);
  const outlineAbortRef = useRef<AbortController | undefined>(undefined);
  const [draftProject, setDraftProject] = useState<ContentProject>();
  const [draft, setDraft] = useState<ContentDraft>();
  const [draftGenerating, setDraftGenerating] = useState(false);
  const draftAbortRef = useRef<AbortController | undefined>(undefined);
  const [reviewProject, setReviewProject] = useState<ContentProject>();
  const [review, setReview] = useState<ContentReview>();
  const [zhuqueReport, setZhuqueReport] = useState<ZhuqueReport>();
  const [zhuqueRunning, setZhuqueRunning] = useState(false);
  const [activeView, setActiveView] = useState<"dashboard" | "library" | "publish" | "skills" | "accounts" | "logs">("dashboard");
  const [wechatAccount, setWechatAccount] = useState<MediaAccount>();
  const [wechatAppId, setWechatAppId] = useState("");
  const [wechatAppSecret, setWechatAppSecret] = useState("");
  const [wechatCallbackToken, setWechatCallbackToken] = useState("");
  const [wechatCredentialStatus, setWechatCredentialStatus] = useState<WechatCredentialStatus>();
  const [wechatTestResult, setWechatTestResult] = useState<"success" | "">("");
  const [wechatTestError, setWechatTestError] = useState("");
  const [wechatJobs, setWechatJobs] = useState<WechatPublishJob[]>([]);
  const [wechatJobsRefreshing, setWechatJobsRefreshing] = useState(false);
  const [wechatJobsRefreshedAt, setWechatJobsRefreshedAt] = useState<Date>();
  const [correctingWechatJob, setCorrectingWechatJob] = useState<WechatPublishJob>();
  const [orphanedWechatJob, setOrphanedWechatJob] = useState<WechatPublishJob>();
  const [correctedWechatStatus, setCorrectedWechatStatus] = useState<"published" | "failed" | "cancelled">("published");
  const [wechatStatusReason, setWechatStatusReason] = useState("");
  const [wechatCorrectionSaving, setWechatCorrectionSaving] = useState(false);
  const [wechatCorrectionError, setWechatCorrectionError] = useState("");
  const [publishProject, setPublishProject] = useState<ContentProject>();
  const [publishSource, setPublishSource] = useState<ContentSourceArticle>();
  const [publishAccountId, setPublishAccountId] = useState("");
  const [publishAuthor, setPublishAuthor] = useState("");
  const [publishDigest, setPublishDigest] = useState("");
  const [publishThumbMediaId, setPublishThumbMediaId] = useState("");
  const [publishCoverSource, setPublishCoverSource] = useState("");
  const [publishCoverPreview, setPublishCoverPreview] = useState("");
  const [publishCoverLabel, setPublishCoverLabel] = useState("");
  const [wechatMaterials, setWechatMaterials] = useState<WechatMaterial[]>([]);
  const [modelScopePrompt, setModelScopePrompt] = useState("");
  const [coverGenerating, setCoverGenerating] = useState(false);
  const [skills, setSkills] = useState<ManagedSkill[]>([]);
  const [modelConnections, setModelConnections] = useState<ModelConnection[]>([]);
  const [editingSkill, setEditingSkill] = useState<ManagedSkill>();
  const [editingConnection, setEditingConnection] = useState<ModelConnection>();
  const [connectionCredential, setConnectionCredential] = useState("");
  const [coverProvider, setCoverProvider] = useState<"modelscope" | "gemini">("modelscope");
  const [publishCropImage, setPublishCropImage] = useState<SelectedImage>();
  const [publishCheckMarkdown, setPublishCheckMarkdown] = useState("");
  const [publishAiCheckResult, setPublishAiCheckResult] = useState("");
  const [publishZhuqueReport, setPublishZhuqueReport] = useState<ZhuqueReport>();
  const [publishAiCheckTool, setPublishAiCheckTool] = useState<"zhuque" | "contentany">();
  const [publishAiOverrideReason, setPublishAiOverrideReason] = useState("");
  const [publishAiCheckRunning, setPublishAiCheckRunning] = useState(false);
  const [publishDetector, setPublishDetector] = useState<"zhuque" | "contentany">("zhuque");
  const [runtimeLogs, setRuntimeLogs] = useState<RuntimeLogEntry[]>([]);
  const [runtimeLogPath, setRuntimeLogPath] = useState("");
  const [runtimeLogsLoading, setRuntimeLogsLoading] = useState(false);
  const [logDate, setLogDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [runtimeLogFilter, setRuntimeLogFilter] = useState<"all" | "errors" | "wechat" | "callbacks">("all");
  const [runtimeLogSearch, setRuntimeLogSearch] = useState("");
  const [runtimeLogMeta, setRuntimeLogMeta] = useState<Pick<RuntimeLogResponse, "totalMatched" | "hasMore" | "sourceTruncated" | "readWindowBytes">>({ totalMatched: 0, hasMore: false, sourceTruncated: false, readWindowBytes: 0 });

  const loadAccounts = async () => {
    setLoading(true);
    try { setAccounts((await request<{ items: MediaAccount[] }>("/media-accounts")).items); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取账号。"); }
    finally { setLoading(false); }
  };
  const loadProjects = async () => {
    try { setProjects((await request<{ items: ContentProject[] }>("/content-projects")).items); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取内容项目。"); }
  };
  const loadWechatJobs = async () => {
    try { setWechatJobs((await request<{ items: WechatPublishJob[] }>("/integrations/wechat/jobs")).items); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取微信发布记录。"); }
  };
  const loadRuntimeLogs = async () => {
    setRuntimeLogsLoading(true);
    try {
      const result = await request<RuntimeLogResponse>(`/runtime-logs?limit=300&date=${encodeURIComponent(logDate)}&scope=${runtimeLogFilter}&search=${encodeURIComponent(runtimeLogSearch.trim())}`);
      setRuntimeLogs(result.items);
      setRuntimeLogPath(result.filePath);
      setRuntimeLogMeta({ totalMatched: result.totalMatched, hasMore: result.hasMore, sourceTruncated: result.sourceTruncated, readWindowBytes: result.readWindowBytes });
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取运行日志。");
    } finally {
      setRuntimeLogsLoading(false);
    }
  };
  const refreshWechatStatus = async () => {
    setWechatJobsRefreshing(true);
    try {
      await Promise.all([loadWechatJobs(), loadProjects()]);
      setWechatJobsRefreshedAt(new Date());
    } finally {
      setWechatJobsRefreshing(false);
    }
  };
  const openWechatStatusCorrection = (job: WechatPublishJob) => {
    setCorrectingWechatJob(job);
    setCorrectedWechatStatus("published");
    setWechatStatusReason("已在微信后台核实");
    setWechatCorrectionError("");
  };
  const saveWechatStatusCorrection = async (event: FormEvent) => {
    event.preventDefault();
    if (!correctingWechatJob) {
      setWechatCorrectionError("核实依据不能超过 500 个字。");
      return;
    }
    const action = correctedWechatStatus === "published" ? "已发布" : correctedWechatStatus === "cancelled" ? "取消发布" : "发布失败";
    if (!window.confirm(`确定将“${correctingWechatJob.title}”人工标记为“${action}”吗？\n\n此操作只校正文渡中的记录，不会调用微信接口，也不会重新发布。`)) return;
    setWechatCorrectionSaving(true);
    try {
      await request<WechatPublishJob>(`/integrations/wechat/jobs/${correctingWechatJob.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: correctedWechatStatus, reason: wechatStatusReason.trim() })
      });
      setCorrectingWechatJob(undefined);
      setWechatStatusReason("");
      setWechatCorrectionError("");
      await Promise.all([loadWechatJobs(), loadProjects()]);
    } catch (cause) {
      setWechatCorrectionError(cause instanceof Error ? cause.message : "人工校正发布状态失败。");
    } finally {
      setWechatCorrectionSaving(false);
    }
  };
  const loadSkillsAndConnections = async () => {
    try {
      const [skillResult, connectionResult] = await Promise.all([
        request<{ items: ManagedSkill[] }>("/skills"),
        request<{ items: ModelConnection[] }>("/model-connections")
      ]);
      setSkills(skillResult.items);
      setModelConnections(connectionResult.items);
      const coverSkill = skillResult.items.find((skill) => skill.id === "cover-generation");
      if (coverSkill?.provider === "modelscope" || coverSkill?.provider === "gemini") setCoverProvider(coverSkill.provider);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取技能和模型连接。");
    }
  };
  useEffect(() => {
    void loadAccounts();
    void loadProjects();
    void loadWechatJobs();
    void (async () => {
      try {
        const source = await request<{ rootPath: string | null }>("/content-source");
        if (source.rootPath) {
          setSourcePath(source.rootPath);
          setSourcePreview(await request<ContentSourcePreview>("/content-source/preview"));
        }
      } catch {
        // The article library is optional during first-run setup.
      }
    })();
  }, []);
  useEffect(() => { if (activeView === "publish" || activeView === "dashboard" || activeView === "library") void loadWechatJobs(); }, [activeView]);
  useEffect(() => { if (activeView === "skills") void loadSkillsAndConnections(); }, [activeView]);
  useEffect(() => { if (activeView === "logs") void loadRuntimeLogs(); }, [activeView, logDate, runtimeLogFilter]);

  const addAccount = async (event: FormEvent) => {
    event.preventDefault();
    if (!displayName.trim()) { setError("请填写账号名称。"); return; }
    setSaving(true);
    try { await request<MediaAccount>("/media-accounts", { method: "POST", body: JSON.stringify({ platform, displayName: displayName.trim() }) }); setDisplayName(""); await loadAccounts(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "账号添加失败。"); }
    finally { setSaving(false); }
  };

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    setSaving(true);
    if (!editingDisplayName.trim()) { setError("请填写账号名称。"); setSaving(false); return; }
    try {
      await request<MediaAccount>(`/media-accounts/${editing.id}`, { method: "PUT", body: JSON.stringify({ displayName: editingDisplayName.trim() }) });
      await request<MediaAccount>(`/media-accounts/${editing.id}/profile`, { method: "PUT", body: JSON.stringify(profile) });
      setEditing(undefined); await loadAccounts();
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "账号定位保存失败。"); }
    finally { setSaving(false); }
  };

  const openSource = async () => {
    setSourceModalOpen(true);
    setSourcePreview(undefined);
    try {
      const source = await request<{ rootPath: string | null }>("/content-source");
      setSourcePath(source.rootPath ?? "");
      if (source.rootPath) setSourcePreview(await request<ContentSourcePreview>("/content-source/preview"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取文章库设置。"); }
  };

  const scanSource = async (event: FormEvent) => {
    event.preventDefault();
    if (!sourcePath.trim()) { setError("请填写文章库路径。"); return; }
    setSaving(true);
    try {
      await request<{ rootPath: string }>("/content-source", { method: "PUT", body: JSON.stringify({ rootPath: sourcePath.trim() }) });
      setSourcePreview(await request<ContentSourcePreview>("/content-source/preview"));
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "文章库扫描失败。"); }
    finally { setSaving(false); }
  };

  const chooseDirectory = async () => {
    if (!window.contentFerry) { setError("浏览文件夹仅在文渡桌面窗口中可用；浏览器访问时请手动粘贴绝对路径。"); return; }
    const selected = await window.contentFerry.selectDirectory();
    if (selected) setSourcePath(selected);
  };

  const openSourceArticle = async (relativePath: string, panel: "assistant" | "preview" | "settings" = "assistant", showError = true): Promise<boolean> => {
    setSaving(true);
    try {
      setArticleWorkspacePanel(panel);
      setSourceArticle(await request<ContentSourceArticle>(`/content-source/article?path=${encodeURIComponent(relativePath)}`));
      setError("");
      return true;
    } catch (cause) {
      if (showError) setError(cause instanceof Error ? cause.message : "无法打开文章。");
      return false;
    }
    finally { setSaving(false); }
  };

  const saveSourceArticle = async (): Promise<{ success: boolean; markdown?: string; error?: string }> => {
    if (!sourceArticle) return { success: false, error: "没有可保存的文章。" };
    setSaving(true);
    try {
      const saved = await request<ContentSourceArticle>("/content-source/article", {
        method: "PUT",
        body: JSON.stringify({ path: sourceArticle.relativePath, markdown: sourceArticle.markdown })
      });
      setSourceArticle(saved);
      setSourcePreview(await request<ContentSourcePreview>("/content-source/preview"));
      setError("");
      return { success: true, markdown: saved.markdown };
    } catch (cause) { const message = cause instanceof Error ? cause.message : "文章保存失败。"; setError(message); return { success: false, error: message }; }
    finally { setSaving(false); }
  };

  const createProject = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectTopic.trim()) { setError("请先填写文章主题或想法。"); return; }
    setSaving(true);
    try {
      await request<ContentProject>("/content-projects", { method: "POST", body: JSON.stringify({ topic: projectTopic.trim(), ...(projectAccountId ? { targetAccountId: projectAccountId } : {}) }) });
      setProjectTopic(""); setProjectAccountId(""); setProjectModalOpen(false); await loadProjects();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "内容项目创建失败。"); }
    finally { setSaving(false); }
  };
  const deleteProjectDraft = async (project: ContentProject) => {
    const relativePath = project.sourceRelativePath ?? "对应的 VitePress 文章目录";
    const publishJob = wechatJobs.find((job) => job.projectId === project.id || job.sourceRelativePath === project.sourceRelativePath || job.title === project.topic);
    const publishedNotice = publishJob
      ? "\n\n微信公众号中的草稿、已提交任务或已发布文章不会被撤回；文渡会保留微信发布记录。"
      : "";
    if (!window.confirm(`确定删除本地文章“${project.topic}”吗？\n\n将永久删除 VitePress 文章目录：\n${relativePath}${publishedNotice}\n\n此操作不能撤销。`)) return;
    setSaving(true);
    try {
      await request<void>(`/content-projects/${project.id}`, { method: "DELETE" });
      await loadProjects();
      if (sourcePreview) setSourcePreview(await request<ContentSourcePreview>("/content-source/preview"));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "草稿删除失败。");
    } finally {
      setSaving(false);
    }
  };

  const openBrief = async (project: ContentProject) => {
    setBriefProject(project);
    setBrief(undefined);
    try { setBrief(await request<ContentBrief>(`/content-projects/${project.id}/brief`)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取创作简报。"); setBriefProject(undefined); }
  };

  const saveBrief = async (event: FormEvent) => {
    event.preventDefault();
    if (!briefProject || !brief) return;
    setSaving(true);
    try { await request<ContentBrief>(`/content-projects/${briefProject.id}/brief`, { method: "PUT", body: JSON.stringify({ objective: brief.objective, audience: brief.audience, angle: brief.angle, sourceNotes: brief.sourceNotes }) }); setBriefProject(undefined); setBrief(undefined); await loadProjects(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "创作简报保存失败。"); }
    finally { setSaving(false); }
  };
  const changeBrief = (field: keyof Omit<ContentBrief, "projectId" | "generatedFromAccountProfile">, value: string) => setBrief((current) => current ? { ...current, [field]: value } : current);
  const openOutline = async (project: ContentProject) => {
    setOutlineProject(project); setOutline(undefined); setSaving(false);
    try {
      if (project.outlineReady) {
        setOutline(await request<ContentOutline>(`/content-projects/${project.id}/outline`));
        return;
      }
      const controller = new AbortController();
      outlineAbortRef.current = controller;
      setOutlineGenerating(true);
      setOutline({ projectId: project.id, markdown: "", generatedFromBrief: true });
      const generated = await streamGeneration<ContentOutline>(`/content-projects/${project.id}/outline/generate/stream`, controller.signal, (event, data) => {
        if (event === "delta") setOutline((current) => current ? { ...current, markdown: String(data.markdown ?? "") } : current);
      });
      setOutline(generated);
    }
    catch (cause) { if (!(cause instanceof Error && /已停止本次 AI 生成/.test(cause.message))) setError(cause instanceof Error ? cause.message : "无法生成提纲。"); setOutlineProject(undefined); }
    finally { setOutlineGenerating(false); outlineAbortRef.current = undefined; }
  };
  const saveOutline = async (event: FormEvent) => {
    event.preventDefault(); if (!outlineProject || !outline) return;
    setSaving(true);
    try { await request<ContentOutline>(`/content-projects/${outlineProject.id}/outline`, { method: "PUT", body: JSON.stringify({ markdown: outline.markdown }) }); setOutlineProject(undefined); setOutline(undefined); await loadProjects(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "提纲保存失败。"); }
    finally { setSaving(false); }
  };
  const openDraft = async (project: ContentProject) => {
    setDraftProject(project); setDraft(undefined); setSaving(false);
    setArticleWorkspacePanel("assistant");
    try {
      let opened: ContentDraft;
      if (project.draftReady) opened = await request<ContentDraft>(`/content-projects/${project.id}/draft`);
      else {
        const controller = new AbortController();
        draftAbortRef.current = controller;
        setDraftGenerating(true);
        setDraft({ projectId: project.id, markdown: "", generatedFromOutline: true, sourceRelativePath: project.sourceRelativePath });
        opened = await streamGeneration<ContentDraft>(`/content-projects/${project.id}/draft/generate/stream`, controller.signal, (event, data) => {
          if (event === "delta") setDraft((current) => current ? { ...current, markdown: String(data.markdown ?? "") } : current);
        });
      }
      setDraft(opened);
      if (opened.sourceRelativePath && opened.sourceRelativePath !== project.sourceRelativePath) {
        setDraftProject({ ...project, sourceRelativePath: opened.sourceRelativePath });
      }
    }
    catch (cause) { if (!(cause instanceof Error && /已停止本次 AI 生成/.test(cause.message))) setError(cause instanceof Error ? cause.message : "无法起草正文。"); setDraftProject(undefined); }
    finally { setDraftGenerating(false); draftAbortRef.current = undefined; }
  };
  const saveDraft = async (): Promise<{ success: boolean; markdown?: string; error?: string }> => {
    if (!draftProject || !draft) return { success: false, error: "没有可保存的草稿。" };
    setSaving(true);
    try {
      const saved = await request<ContentDraft>(`/content-projects/${draftProject.id}/draft`, { method: "PUT", body: JSON.stringify({ markdown: draft.markdown }) });
      setDraft((current) => current ? { ...current, markdown: saved.markdown, sourceRelativePath: saved.sourceRelativePath } : current);
      if (saved.sourceRelativePath) setDraftProject((current) => current ? { ...current, sourceRelativePath: saved.sourceRelativePath ?? current.sourceRelativePath } : current);
      await loadProjects();
      return { success: true, markdown: saved.markdown };
    }
    catch (cause) { const message = cause instanceof Error ? cause.message : "正文草稿保存失败。"; setError(message); return { success: false, error: message }; }
    finally { setSaving(false); }
  };
  const openReview = async (project: ContentProject) => {
    setReviewProject(project); setReview(undefined); setZhuqueReport(undefined);
    try { setReview(await request<ContentReview>(`/content-projects/${project.id}/review`)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法打开发之前优化。"); setReviewProject(undefined); }
  };
  const openZhuque = async () => {
    if (window.contentFerry) {
      await window.contentFerry.openZhuque();
      return;
    }
    window.open("https://matrix.tencent.com/ai-detect/ai_gen_txt/", "_blank", "noopener,noreferrer");
  };
  const runZhuque = async () => {
    if (!reviewProject || !review) return;
    if (!window.contentFerry) {
      setError("朱雀自动检测需要在文渡桌面应用中运行。");
      return;
    }
    setZhuqueRunning(true);
    try {
      const currentDraft = await request<ContentDraft>(`/content-projects/${reviewProject.id}/draft`);
      const result = await window.contentFerry.runZhuqueDetection(currentDraft.markdown);
      if (result.status === "completed" && result.result) {
        setReview({ ...review, aiCheckResult: result.result });
        setZhuqueReport(result.report);
        setError("");
      } else {
        setError(result.message ?? "朱雀检测需要你接管浏览器。处理完成后再次点击自动检测即可继续。");
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "朱雀自动检测失败。"); }
    finally { setZhuqueRunning(false); }
  };
  const saveReview = async (status: ContentReview["status"]) => {
    if (!reviewProject || !review) return;
    setSaving(true);
    try { await request<ContentReview>(`/content-projects/${reviewProject.id}/review`, { method: "PUT", body: JSON.stringify({ ...review, status }) }); setReviewProject(undefined); setReview(undefined); await loadProjects(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "发布前优化结果保存失败。"); }
    finally { setSaving(false); }
  };
  const optimizeDraft = async () => {
    if (!reviewProject || !review) return;
    setSaving(true);
    try {
      const revised = await request<ContentDraft>(`/content-projects/${reviewProject.id}/draft/revise`, {
        method: "POST",
        body: JSON.stringify({ aiCheckResult: review.aiCheckResult, guidance: review.notes })
      });
      await request<ContentReview>(`/content-projects/${reviewProject.id}/review`, {
        method: "PUT",
        body: JSON.stringify({ ...review, status: "needs_revision" })
      });
      setDraftProject(reviewProject);
      setDraft(revised);
      setReviewProject(undefined);
      setReview(undefined);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "AI 优化正文失败。"); }
    finally { setSaving(false); }
  };

  const openProfile = (account: MediaAccount) => { setEditing(account); setEditingDisplayName(account.displayName); setProfile(account.profile); setError(""); };
  const changeProfile = (field: keyof AccountProfile, value: string) => setProfile((current) => ({ ...current, [field]: value }));
  const saveWechatConnection = async (event: FormEvent) => {
    event.preventDefault();
    if (!wechatAccount || !wechatAppId.trim()) {
      setError("请填写 AppID。");
      return;
    }
    if (!wechatCredentialStatus?.appSecretConfigured && !wechatAppSecret.trim()) {
      setError("首次连接需要填写 AppSecret。");
      return;
    }
    if (!wechatCredentialStatus?.callbackTokenConfigured && !wechatCallbackToken.trim()) {
      setError("首次连接需要填写消息校验 Token。");
      return;
    }
    setSaving(true);
    try {
      await request<void>(`/media-accounts/${wechatAccount.id}/credentials/app_id`, { method: "PUT", body: JSON.stringify({ secret: wechatAppId.trim() }) });
      if (wechatAppSecret.trim()) await request<void>(`/media-accounts/${wechatAccount.id}/credentials/app_secret`, { method: "PUT", body: JSON.stringify({ secret: wechatAppSecret.trim() }) });
      if (wechatCallbackToken.trim()) await request<void>(`/media-accounts/${wechatAccount.id}/credentials/callback_token`, { method: "PUT", body: JSON.stringify({ secret: wechatCallbackToken.trim() }) });
      await request(`/integrations/wechat/accounts/${wechatAccount.id}/test`, { method: "POST", body: "{}" });
      setWechatAppSecret(""); setWechatCallbackToken(""); setWechatTestResult("success"); setWechatTestError(""); setError("");
      await loadAccounts();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "微信公众号连接失败。";
      setWechatTestResult(""); setWechatTestError(message); setError("");
    }
    finally { setSaving(false); }
  };
  const openWechatConnection = async (account: MediaAccount) => {
    setWechatAccount(account); setWechatAppSecret(""); setWechatCallbackToken(""); setWechatCredentialStatus(undefined); setWechatTestResult(""); setWechatTestError(""); setError("");
    try {
      const status = await request<WechatCredentialStatus>(`/media-accounts/${account.id}/credentials/status`);
      setWechatCredentialStatus(status);
      setWechatAppId(status.appId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取微信连接状态。"); }
  };
  const deleteAccount = async (account: MediaAccount) => {
    if (!window.confirm(`确定删除账号“${account.displayName}”吗？本机保存的该账号凭证也会删除，历史发布记录会保留。`)) return;
    setSaving(true);
    try {
      await request<void>(`/media-accounts/${account.id}`, { method: "DELETE" });
      setError(""); await loadAccounts();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "账号删除失败。"); }
    finally { setSaving(false); }
  };
  const resetPublishCover = () => {
    setPublishThumbMediaId(""); setPublishCoverSource(""); setPublishCoverPreview(""); setPublishCoverLabel("");
    setWechatMaterials([]); setModelScopePrompt("");
  };
  const openPublishPreparation = (project: ContentProject) => {
    const preferred = accounts.find((account) => account.id === project.targetAccountId && account.platform === "wechat_official")
      ?? accounts.find((account) => account.platform === "wechat_official");
    setPublishProject(project);
    setPublishAccountId(preferred?.id ?? "");
    setPublishAuthor("");
    setPublishDigest("");
    setPublishThumbMediaId("");
    setPublishCheckMarkdown("");
    setPublishAiCheckResult("");
    setPublishZhuqueReport(undefined); setPublishAiCheckTool(undefined);
    setPublishAiOverrideReason("");
    resetPublishCover();
    setError("");
    void loadSkillsAndConnections();
    const contextKey = project.sourceRelativePath ? `source:${project.sourceRelativePath}` : `project:${project.id}`;
    void request<ArticleSettings>(`/article-settings?contextKey=${encodeURIComponent(contextKey)}`)
      .then((settings) => {
        setPublishAuthor(settings.author); setPublishDigest(settings.digest); setPublishAccountId(settings.accountId || preferred?.id || "");
        if (settings.coverSource) {
          setPublishCoverSource(settings.coverSource);
          setPublishCoverLabel("文章设置中的封面");
          setPublishCoverPreview(resolveArticleImageUrl(settings.coverSource, project.id));
        }
      }).catch(() => undefined);
    void Promise.all([
      request<ContentDraft>(`/content-projects/${project.id}/draft`),
      request<{ aiCheckResult: string; aiCheckReport: string; overrideReason: string }>(`/article-quality-check?contextKey=${encodeURIComponent(contextKey)}`)
    ]).then(([savedDraft, quality]) => {
      setPublishCheckMarkdown(savedDraft.markdown);
      setPublishAiCheckResult(quality.aiCheckResult);
      setPublishZhuqueReport(parseZhuqueReport(quality.aiCheckReport));
      setPublishAiCheckTool(quality.aiCheckResult.startsWith("ContentAny") ? "contentany" : quality.aiCheckResult ? "zhuque" : undefined);
      setPublishAiOverrideReason(quality.overrideReason);
    }).catch(() => undefined);
  };
  const openSourcePublishPreparation = (article: ContentSourceArticle) => {
    const preferred = accounts.find((account) => account.platform === "wechat_official");
    setPublishSource(article);
    setSourceArticle(undefined);
    setPublishAccountId(preferred?.id ?? "");
    setPublishAuthor("");
    setPublishDigest("");
    setPublishThumbMediaId("");
    setPublishCheckMarkdown(article.markdown);
    setPublishAiCheckResult("");
    setPublishZhuqueReport(undefined); setPublishAiCheckTool(undefined);
    setPublishAiOverrideReason("");
    resetPublishCover();
    setError("");
    void loadSkillsAndConnections();
    void request<ArticleSettings>(`/article-settings?contextKey=${encodeURIComponent(`source:${article.relativePath}`)}`)
      .then((settings) => {
        setPublishAuthor(settings.author); setPublishDigest(settings.digest); setPublishAccountId(settings.accountId || "");
        if (settings.coverSource) {
          setPublishCoverSource(settings.coverSource);
          setPublishCoverLabel("文章设置中的封面");
          setPublishCoverPreview(resolveArticleImageUrl(settings.coverSource, sourceAssetContextId(article.relativePath), article.relativePath));
        }
      }).catch(() => undefined);
    void request<{ aiCheckResult: string; aiCheckReport: string; overrideReason: string }>(`/article-quality-check?contextKey=${encodeURIComponent(`source:${article.relativePath}`)}`)
      .then((quality) => {
        setPublishAiCheckResult(quality.aiCheckResult);
        setPublishZhuqueReport(parseZhuqueReport(quality.aiCheckReport));
        setPublishAiCheckTool(quality.aiCheckResult.startsWith("ContentAny") ? "contentany" : quality.aiCheckResult ? "zhuque" : undefined);
        setPublishAiOverrideReason(quality.overrideReason);
      }).catch(() => undefined);
  };
  const runPublishZhuque = async () => {
    if (!publishCheckMarkdown) {
      setError("尚未读取到文章正文，请关闭窗口后重新打开文章再试。");
      return;
    }
    if (!window.contentFerry) {
      setError("腾讯朱雀自动检测需要在文渡桌面应用中运行。");
      return;
    }
    setPublishAiCheckRunning(true);
    try {
      const result = await window.contentFerry.runZhuqueDetection(publishCheckMarkdown);
      if (result.status === "completed" && result.result) {
        setPublishAiCheckResult(result.result);
        setPublishZhuqueReport(result.report);
        setPublishAiCheckTool("zhuque");
        const contextKey = publishSource ? `source:${publishSource.relativePath}` : publishProject ? `project:${publishProject.id}` : "";
        if (contextKey) {
          await request("/article-quality-check", {
            method: "PUT",
            body: JSON.stringify({
              contextKey,
              aiCheckResult: result.result,
              aiCheckReport: result.report ? JSON.stringify(result.report) : "",
              overrideReason: publishAiOverrideReason.trim()
            })
          });
        }
        setError("");
      } else {
        setError(result.message ?? "朱雀自动检测需要人工接管。");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "腾讯朱雀自动检测失败。");
    } finally {
      setPublishAiCheckRunning(false);
    }
  };
  const runPublishContentAny = async () => {
    if (!publishCheckMarkdown) { setError("尚未读取到文章正文，请重新打开发布设置后再试。"); return; }
    if (!window.contentFerry) { setError("ContentAny 自动检测需要在文渡桌面应用中运行。"); return; }
    setPublishAiCheckRunning(true);
    try {
      const result = await window.contentFerry.runContentAnyDetection(publishCheckMarkdown);
      if (result.status === "completed" && result.result) {
        const value = `ContentAny 检测：\n${result.result}`;
        setPublishAiCheckResult(value);
        setPublishZhuqueReport(undefined);
        setPublishAiCheckTool("contentany");
        const contextKey = publishSource ? `source:${publishSource.relativePath}` : publishProject ? `project:${publishProject.id}` : "";
        if (contextKey) await request("/article-quality-check", { method: "PUT", body: JSON.stringify({ contextKey, aiCheckResult: value, aiCheckReport: "", overrideReason: publishAiOverrideReason.trim() }) });
        setError("");
      } else setError(result.message ?? "ContentAny 检测需要人工接管。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "ContentAny 自动检测失败。"); }
    finally { setPublishAiCheckRunning(false); }
  };
  const chooseLocalCover = async () => {
    if (!window.contentFerry) { setError("选择本地封面需要在文渡桌面窗口中操作。"); return; }
    const selected = await window.contentFerry.selectImage();
    if (!selected || (!publishProject && !publishSource)) return;
    setPublishCropImage(selected);
  };
  const saveCroppedPublishCover = async (selected: SelectedImage) => {
    setSaving(true);
    try {
      const endpoint = publishSource ? "/content-source/article-asset" : "/content-assets";
      const payload = publishSource
        ? { path: publishSource.relativePath, mimeType: selected.mimeType, base64: selected.base64 }
        : { contextId: publishProject!.id, mimeType: selected.mimeType, base64: selected.base64 };
      const saved = await request<{ assetUrl: string; previewUrl?: string }>(endpoint, { method: "POST", body: JSON.stringify(payload) });
      setPublishCoverSource(saved.assetUrl); setPublishThumbMediaId(""); setPublishCoverLabel(selected.fileName);
      setPublishCoverPreview(publishSource
        ? `${apiBase}/content-source/article-resource?path=${encodeURIComponent(publishSource.relativePath)}&src=${encodeURIComponent(saved.assetUrl)}`
        : `${apiBase}${saved.previewUrl}`);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "本地封面保存失败。"); }
    finally { setSaving(false); setPublishCropImage(undefined); }
  };
  const loadWechatMaterials = async () => {
    if (!publishAccountId) { setError("请先选择微信公众号。"); return; }
    setSaving(true);
    try {
      const result = await request<{ items: WechatMaterial[] }>(`/integrations/wechat/accounts/${publishAccountId}/materials/images?offset=0&count=20`);
      setWechatMaterials(result.items); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "读取微信素材库失败。"); }
    finally { setSaving(false); }
  };
  const chooseWechatMaterial = (material: WechatMaterial) => {
    setPublishThumbMediaId(material.mediaId); setPublishCoverSource("");
    setPublishCoverPreview(`${apiBase}/integrations/wechat/accounts/${publishAccountId}/materials/images/${encodeURIComponent(material.mediaId)}`);
    setPublishCoverLabel(`微信素材：${material.name || "未命名图片"}`);
  };
  const generateCover = async () => {
    if (!publishProject && !publishSource) return;
    setCoverGenerating(true);
    try {
      const connection = modelConnections.find((item) => item.provider === coverProvider);
      if (!connection?.credentialConfigured) throw new Error(`请先到“技能与模型”配置 ${providerName(coverProvider)} 凭证。`);
      const generated = await request<{ assetUrl: string; previewUrl?: string }>("/skills/cover-generation/run", {
        method: "POST",
        body: JSON.stringify({
          ...(publishSource ? { relativePath: publishSource.relativePath } : { projectId: publishProject!.id }),
          provider: coverProvider,
          ...(modelScopePrompt.trim() ? { prompt: modelScopePrompt.trim() } : {})
        })
      });
      setPublishCoverSource(generated.assetUrl); setPublishThumbMediaId(""); setPublishCoverLabel(`${providerName(coverProvider)} 生成封面`);
      setPublishCoverPreview(publishSource
        ? `${apiBase}/content-source/article-resource?path=${encodeURIComponent(publishSource.relativePath)}&src=${encodeURIComponent(generated.assetUrl)}`
        : `http://127.0.0.1:4317${generated.previewUrl}`);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "封面生成失败。"); }
    finally { setCoverGenerating(false); }
  };
  const prepareSourcePublish = async (article: ContentSourceArticle) => {
    setSaving(true);
    try {
      const saved = await request<ContentSourceArticle>("/content-source/article", {
        method: "PUT", body: JSON.stringify({ path: article.relativePath, markdown: article.markdown })
      });
      openSourcePublishPreparation(saved);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存文章后准备发布失败。"); }
    finally { setSaving(false); }
  };
  const prepareProjectPublish = async (project: ContentProject, currentDraft: ContentDraft) => {
    setSaving(true);
    try {
      await request<ContentDraft>(`/content-projects/${project.id}/draft`, {
        method: "PUT", body: JSON.stringify({ markdown: currentDraft.markdown })
      });
      setDraftProject(undefined); setDraft(undefined);
      openPublishPreparation(project);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存正文后准备发布失败。"); }
    finally { setSaving(false); }
  };
  const createWechatDraft = async (event: FormEvent) => {
    event.preventDefault();
    if (!publishProject && !publishSource) return;
    if (!publishAccountId) { setError("请先返回文章编辑页，在“发布设置”中选择微信公众号。"); return; }
    if (!publishCoverSource && !publishThumbMediaId) { setError("请先返回文章编辑页，在“发布设置”中选择封面。"); return; }
    const qualityContextKey = publishSource ? `source:${publishSource.relativePath}` : `project:${publishProject!.id}`;
    const highAiRisk = isHighAiDetectionResult(publishAiCheckResult, publishZhuqueReport);
    if (!publishAiCheckResult && publishAiOverrideReason.trim().length < 5) {
      setError("请先完成腾讯朱雀或 ContentAny 任一项 AIGC 特征检测；如检测暂时无法完成，请填写至少 5 个字的例外发布理由。");
      return;
    }
    if (highAiRisk && publishAiOverrideReason.trim().length < 5) {
      setError("检测结果显示 AI 特征偏高。仍需发布时，请填写至少 5 个字的例外发布理由。");
      return;
    }
    setSaving(true);
    try {
      await request("/article-quality-check", {
        method: "PUT",
        body: JSON.stringify({
          contextKey: qualityContextKey,
          aiCheckResult: publishAiCheckResult,
          aiCheckReport: publishZhuqueReport ? JSON.stringify(publishZhuqueReport) : "",
          overrideReason: publishAiOverrideReason.trim()
        })
      });
      await request<WechatPublishJob>(publishSource ? "/integrations/wechat/source-drafts" : "/integrations/wechat/drafts", {
        method: "POST",
        body: JSON.stringify({
          accountId: publishAccountId,
          ...(publishSource ? { relativePath: publishSource.relativePath } : { projectId: publishProject!.id }),
          author: publishAuthor,
          digest: publishDigest,
          thumbMediaId: publishThumbMediaId,
          coverSource: publishCoverSource
        })
      });
      setPublishProject(undefined); setPublishSource(undefined); setActiveView("publish"); setError("");
      await loadWechatJobs();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "同步微信草稿失败。"); }
    finally { setSaving(false); }
  };
  const returnToPublishSettings = async () => {
    const project = publishProject;
    const source = publishSource;
    setPublishProject(undefined);
    setPublishSource(undefined);
    setArticleWorkspacePanel("settings");
    if (source) {
      setSourceArticle(source);
      return;
    }
    if (project) await openDraft(project);
    setArticleWorkspacePanel("settings");
  };
  const submitWechatJob = async (job: WechatPublishJob, mode: "publish" | "mass") => {
    const warning = mode === "mass"
      ? "群发会向全部关注者推送，并消耗公众号群发额度。请确认你已经在微信草稿箱完成手机预览。是否继续？"
      : "普通发布不会向粉丝群发，提交后仍需等待微信异步审核结果。是否继续？";
    if (!window.confirm(warning)) return;
    setSaving(true);
    try {
      await request<WechatPublishJob>(`/integrations/wechat/jobs/${job.id}/submit`, { method: "POST", body: JSON.stringify({ mode }) });
      setError(""); await loadWechatJobs();
      // 微信提交后仍需在公众平台处理原创、转载与赞赏等设置；打开平台作为下一步入口。
      await window.contentFerry?.openWechatBackend();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "微信提交失败。"); }
    finally { setSaving(false); }
  };
  const retryWechatJob = async (job: WechatPublishJob) => {
    const project = job.projectId ? projects.find((item) => item.id === job.projectId) : undefined;
    if (project) {
      openPublishPreparation(project);
      return;
    }
    if (job.sourceRelativePath) {
      if (!await openSourceArticle(job.sourceRelativePath, "settings", false)) setOrphanedWechatJob(job);
      return;
    }
    setOrphanedWechatJob(job);
  };
  const deleteWechatJob = async () => {
    if (!orphanedWechatJob) return;
    setSaving(true);
    try {
      await request<void>(`/integrations/wechat/jobs/${orphanedWechatJob.id}`, { method: "DELETE" });
      setOrphanedWechatJob(undefined);
      setError("");
      await loadWechatJobs();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发布记录删除失败。");
    } finally {
      setSaving(false);
    }
  };
  const saveSkill = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingSkill) return;
    setSaving(true);
    try {
      const saved = await request<ManagedSkill>(`/skills/${editingSkill.id}`, {
        method: "PUT",
        body: JSON.stringify({
          markdown: editingSkill.markdown,
          enabled: editingSkill.enabled,
          provider: editingSkill.provider
        })
      });
      setEditingSkill(saved);
      setError("");
      await loadSkillsAndConnections();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "技能保存失败。");
    } finally {
      setSaving(false);
    }
  };
  const saveModelConnection = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingConnection) return;
    setSaving(true);
    try {
      const saved = await request<ModelConnection>(`/model-connections/${editingConnection.provider}`, {
        method: "PUT",
        body: JSON.stringify({
          displayName: editingConnection.displayName,
          modelId: editingConnection.modelId,
          baseUrl: editingConnection.baseUrl,
          proxyUrl: editingConnection.proxyUrl,
          enabled: editingConnection.enabled,
          ...(connectionCredential.trim() ? { credential: connectionCredential.trim() } : {})
        })
      });
      setEditingConnection(saved);
      setConnectionCredential("");
      setError("");
      await loadSkillsAndConnections();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "模型连接保存失败。");
    } finally {
      setSaving(false);
    }
  };

  if (reviewProject) {
    return <QualityWorkspace
      title={reviewProject.topic}
      review={review}
      zhuqueReport={zhuqueReport}
      error={error}
      saving={saving}
      detecting={zhuqueRunning}
      onChange={(next) => setReview(next)}
      onBack={() => { setReviewProject(undefined); setReview(undefined); setZhuqueReport(undefined); setError(""); }}
      onAutoDetect={() => void runZhuque()}
      onOpenZhuque={() => void openZhuque()}
      onOptimize={() => void optimizeDraft()}
      onContinueEditing={() => void saveReview("needs_revision")}
      onReady={() => void saveReview("approved")}
    />;
  }

  if (sourceArticle) {
    return <ArticleWorkspace
      title={sourceArticle.title ?? sourceArticle.relativePath}
      subtitle={`VitePress 文章 · ${sourceArticle.relativePath}`}
      markdown={sourceArticle.markdown}
      assetContextId={sourceAssetContextId(sourceArticle.relativePath)}
      sourceArticlePath={sourceArticle.relativePath}
      accounts={accounts}
      initialRightPanel={articleWorkspacePanel}
      saving={saving}
      onChange={(markdown) => setSourceArticle((current) => current ? { ...current, markdown } : current)}
      onBack={() => setSourceArticle(undefined)}
      onSave={saveSourceArticle}
      onPublish={() => void prepareSourcePublish(sourceArticle)}
    />;
  }

  if (draftProject) {
    if (!draft) return <WorkspaceLoading title={draftProject.topic} onBack={() => setDraftProject(undefined)} message={saving ? "AI 正在按照已确认提纲起草正文…" : "正在打开正文…"} />;
    return <ArticleWorkspace
      title={markdownTitle(draft.markdown) || draftProject.topic}
      subtitle="文渡创作项目 · 正文草稿"
      markdown={draft.markdown}
      assetContextId={draftProject.id}
      sourceArticlePath={draftProject.sourceRelativePath ?? draft.sourceRelativePath ?? undefined}
      projectId={draftProject.id}
      accounts={accounts}
      initialRightPanel={articleWorkspacePanel}
      saving={saving}
      generating={draftGenerating}
      onStopGeneration={() => draftAbortRef.current?.abort()}
      onChange={(markdown) => setDraft((current) => current ? { ...current, markdown } : current)}
      onBack={() => { draftAbortRef.current?.abort(); setDraftProject(undefined); setDraft(undefined); }}
      onSave={saveDraft}
      onPublish={() => void prepareProjectPublish(draftProject, draft)}
    />;
  }

  const selectedPublishAccount = accounts.find((account) => account.id === publishAccountId);
  const publishAccountReady = selectedPublishAccount?.platform === "wechat_official";
  const pageTitle = activeView === "dashboard"
    ? projects.length === 0 ? "开始创作" : "工作台"
    : activeView === "library" ? "内容库"
      : activeView === "publish" ? "发布中心"
        : activeView === "skills" ? "技能与模型"
          : activeView === "accounts" ? "账号与连接" : "运行日志";
  const filteredRuntimeLogs = runtimeLogs;
  const pendingWechatJobs = wechatJobs.filter((job) => job.status !== "published" && job.status !== "cancelled");
  const completedWechatJobs = wechatJobs.filter((job) => job.status === "published" || job.status === "cancelled");

  return <div className="app-shell">
    <aside className="app-sidebar">
      <div className="app-brand"><img src={wenduLogo} alt="" /><strong>文渡<small>ContentFerry</small></strong></div>
      <nav>
        <button className={activeView === "dashboard" ? "active" : ""} onClick={() => setActiveView("dashboard")}>工作台</button>
        <button className={activeView === "library" ? "active" : ""} onClick={() => setActiveView("library")}>内容库</button>
        <button className={activeView === "publish" ? "active" : ""} onClick={() => setActiveView("publish")}>发布</button>
        <button disabled>素材库 <small>即将开放</small></button>
        <button className={activeView === "skills" ? "active" : ""} onClick={() => setActiveView("skills")}>技能与模型</button>
        <button className={activeView === "accounts" ? "active" : ""} onClick={() => setActiveView("accounts")}>账号</button>
        <button className={activeView === "logs" ? "active" : ""} onClick={() => setActiveView("logs")}>运行日志</button>
        <button disabled>数据 <small>即将开放</small></button>
      </nav>
    </aside>
    <main className="app-main">
    <div className="page-heading"><h1>{pageTitle}</h1>{((activeView === "dashboard" && projects.length > 0) || activeView === "library") && <button onClick={() => setProjectModalOpen(true)}>＋ 新建文章</button>}</div>
    {error && <p className="error">{error}</p>}
    {error && <Modal title="操作未完成" eyebrow="需要你的注意" onClose={() => setError("")} disabled={false} priority><p className="error error-dialog-message">{error}</p><div className="modal-actions"><button type="button" onClick={() => setError("")}>知道了</button></div></Modal>}

    {activeView === "skills" && <>
      <section className="card">
        <div className="section-heading"><div><h2>技能</h2><p className="hint compact-hint">每个技能都有独立的 SKILL.md，可修改执行规则、停用，或更换模型连接。</p></div><button className="text-button" onClick={() => void loadSkillsAndConnections()}>刷新</button></div>
        <div className="skill-grid">{skills.map((skill) => <button type="button" className="skill-card" key={skill.id} onClick={() => { setEditingSkill(skill); setError(""); }}><span><em>{skill.category}</em><strong>{skill.name}</strong></span><p>{skill.description}</p><small>{skill.enabled ? `已启用 · ${providerName(skill.provider)}` : "已停用"}</small></button>)}</div>
      </section>
      <section className="card">
        <div className="section-heading"><div><h2>模型连接</h2><p className="hint compact-hint">凭证加密保存在本机，页面只显示是否已配置，不回显明文。</p></div></div>
        <ul className="account-list">{modelConnections.map((connection) => <li key={connection.provider}><span><strong>{connection.displayName}</strong><small>{connection.modelId || "使用服务默认模型"}{connection.proxyUrl ? ` · 代理 ${connection.proxyUrl}` : ""}</small></span><span className="account-actions"><em>{connection.provider === "openai_codex" ? "使用 ChatGPT 登录" : connection.credentialConfigured ? "凭证已配置" : "待配置凭证"}</em><button className="text-button" onClick={() => { setEditingConnection(connection); setConnectionCredential(""); setError(""); }}>配置</button></span></li>)}</ul>
      </section>
    </>}

    {activeView === "accounts" && <>
    <section className="card">
      <div className="section-heading"><h2>已绑定账号</h2><button className="text-button" onClick={() => void loadAccounts()} disabled={loading}>刷新</button></div>
      {loading ? <p>正在读取本地账号…</p> : accounts.length === 0 ? <p className="muted">还没有账号。先添加“围炉聊科技”或你的测试公众号。</p> : <ul className="account-list bound-account-list">{accounts.map((account) => <li key={account.id}>
        <span className="bound-account-summary"><strong>{account.displayName}</strong><small>{platformName(account.platform)} · {account.profile.positioning ? "已设置定位" : "待设置定位"}</small></span>
        <em className={`connection-status${account.credentialsConfigured ? " connected" : ""}`}>{account.credentialsConfigured ? "凭据已配置" : "待完成接入"}</em>
        <span className="account-row-actions">{account.platform === "wechat_official" && <button className="secondary-button compact-action" onClick={() => void openWechatConnection(account)}>连接微信</button>}<button className="secondary-button compact-action" onClick={() => openProfile(account)}>编辑定位</button><button className="text-button danger-text compact-action" onClick={() => void deleteAccount(account)} disabled={saving}>删除</button></span>
      </li>)}</ul>}
    </section>
    </>}

    {activeView === "library" && <>
    <section className="card"><div className="section-heading"><div><h2>VitePress 文章库</h2><p className="hint compact-hint">这里的 Markdown 文件是正式内容源，可同时用 Obsidian 编辑，也可以直接发布到微信公众号。</p></div><button onClick={() => void openSource()}>配置并扫描</button></div>{sourcePreview && <><p className="library-summary">已连接 {sourcePreview.rootPath}，发现 {sourcePreview.articleCount} 篇文章。</p><ul className="content-library-list">{sourcePreview.items.map((item) => { const job = wechatJobs.find((entry) => entry.sourceRelativePath === item.relativePath || entry.title === item.title); return <li key={item.relativePath}><span><button className="article-title-button" onClick={() => void openSourceArticle(item.relativePath)}>{item.title ?? "未命名文章"}</button>{job && <small>{wechatJobLabel(job)}</small>}</span><span className="account-actions">{job?.status === "draft_ready" ? <button className="secondary-button" onClick={() => setActiveView("publish")}>继续发布</button> : job?.status === "submitted" ? <span className="status-badge">微信处理中</span> : job?.status === "published" ? <span className="status-badge success">已发布</span> : job?.status === "cancelled" ? <span className="status-badge warning">已取消发布</span> : <button className="secondary-button" onClick={() => void openSourceArticle(item.relativePath, "settings")}>设置并发布</button>}</span></li>; })}</ul></>}</section>
    </>}

    {activeView === "publish" && <>
      <div className="publish-page-actions"><span>{wechatJobsRefreshedAt && `已更新 ${wechatJobsRefreshedAt.toLocaleTimeString()}`}</span><button className="text-button" onClick={() => void refreshWechatStatus()} disabled={wechatJobsRefreshing}>{wechatJobsRefreshing ? "正在刷新…" : "刷新状态"}</button></div>
      {wechatJobs.length === 0 ? <section className="card"><div className="empty-guidance"><strong>还没有发布任务</strong><p>请先在内容库中选择文章并发起发布。</p><button onClick={() => setActiveView("library")}>前往内容库</button></div></section> : <>
        {pendingWechatJobs.length > 0 && <section className="card">
          <div className="section-heading"><h2>待处理</h2></div>
          <ul className="publish-job-list">{pendingWechatJobs.map((job) => {
            const account = accounts.find((item) => item.id === job.accountId);
            return <li key={job.id}><span><strong>{job.title}</strong><small>{account ? `${platformName(account.platform)} · ${account.displayName} · ` : ""}{wechatJobLabel(job)} · {new Date(job.updatedAt).toLocaleString()}</small>{job.errorMessage && <em className="error">{job.errorMessage}</em>}</span><span className="account-actions">{job.status === "draft_ready" && <><button className="secondary-button" onClick={() => void submitWechatJob(job, "publish")} disabled={saving}>普通发布</button><button className="danger-button" onClick={() => void submitWechatJob(job, "mass")} disabled={saving}>群发所有关注者</button><button className="text-button" onClick={() => void window.contentFerry?.openWechatBackend()}>打开微信草稿箱</button><button className="text-button" onClick={() => openWechatStatusCorrection(job)}>已在微信后台处理</button></>}{job.status === "submitted" && <><span className="status-badge">等待微信回执</span><button className="text-button" onClick={() => openWechatStatusCorrection(job)}>校正状态</button></>}{job.status === "failed" && <><button className="secondary-button" onClick={() => void retryWechatJob(job)}>重新设置并同步</button><button className="text-button" onClick={() => openWechatStatusCorrection(job)}>校正状态</button></>}</span></li>;
          })}</ul>
        </section>}
        {completedWechatJobs.length > 0 && <section className="card">
          <div className="section-heading"><h2>发布记录</h2></div>
          <ul className="publish-job-list">{completedWechatJobs.map((job) => {
            const account = accounts.find((item) => item.id === job.accountId);
            return <li key={job.id}><span><strong>{job.title}</strong><small>{account ? `${platformName(account.platform)} · ${account.displayName} · ` : ""}{job.status === "cancelled" ? "已取消发布" : job.mode === "mass" ? "已群发" : "已发布"} · {new Date(job.updatedAt).toLocaleString()}</small>{job.statusSource === "manual" && <small className="manual-status-note">人工校正：{job.statusNote}</small>}</span><span className={`status-badge ${job.status === "cancelled" ? "warning" : "success"}`}>{job.status === "cancelled" ? "已取消" : "已完成"}</span></li>;
          })}</ul>
        </section>}
      </>}
    </>}

    {activeView === "dashboard" && <>
    <section className={`card${projects.length === 0 ? " dashboard-empty-card" : ""}`}>
      {projects.length === 0 ? <div className="dashboard-empty"><h2>写下一个主题，开始第一篇文章</h2><p>文渡会创建草稿，并结合账号定位辅助整理方向、提纲和正文。</p><button onClick={() => setProjectModalOpen(true)}>＋ 新建文章</button></div> : <ul className="project-list">{projects.map((project) => { const job = wechatJobs.find((item) => item.projectId === project.id || item.sourceRelativePath === project.sourceRelativePath || item.title === project.topic); const nextText = job?.status === "published" ? "微信公众号已确认发布完成" : job?.status === "cancelled" ? "发布任务已人工取消，可重新设置后再发布" : job?.status === "submitted" ? "已提交微信，正在等待最终回执" : job?.status === "draft_ready" ? "已同步微信草稿箱，等待预览和发布" : project.draftReady ? "正文已保存，可继续编辑或准备发布" : project.outlineReady ? "提纲已确认，下一步生成正文" : project.briefReady ? "创作方向已整理，下一步生成提纲" : "下一步整理创作方向和资料"; const action = project.draftReady || project.outlineReady ? () => void openDraft(project) : project.briefReady ? () => void openOutline(project) : () => void openBrief(project); const label = project.draftReady ? "打开正文" : project.outlineReady ? "起草正文" : project.briefReady ? "生成提纲" : "整理创作方向"; const account = project.targetAccountId ? accounts.find((item) => item.id === project.targetAccountId) : undefined; const canPrepare = !job || job.status === "failed" || job.status === "cancelled"; return <li key={project.id}><span><strong>{project.topic}</strong><small>{nextText}</small></span><span className="account-actions"><span className="account-badge">{account ? `${platformName(account.platform)} · ${account.displayName}` : "未选发布账号"}</span><button onClick={action}>{label}</button>{project.draftReady && canPrepare && <button className="secondary-button" onClick={() => openPublishPreparation(project)}>准备发布</button>}{job?.status === "draft_ready" && <span className="status-badge">草稿已同步</span>}{job?.status === "submitted" && <span className="status-badge">微信处理中</span>}{job?.status === "published" && <span className="status-badge success">已发布</span>}{job?.status === "cancelled" && <span className="status-badge warning">已取消发布</span>}<button className="text-button danger-text" onClick={() => void deleteProjectDraft(project)} disabled={saving}>{job ? "删除本地文章" : "删除草稿"}</button></span></li>; })}</ul>}
    </section>
    </>}

    {activeView === "logs" && <section className="card runtime-log-card">
      <div className="runtime-log-toolbar">
        <label>日期<input type="date" value={logDate} onChange={(event) => setLogDate(event.target.value)} /></label>
        <label>范围<select value={runtimeLogFilter} onChange={(event) => setRuntimeLogFilter(event.target.value as typeof runtimeLogFilter)}><option value="all">全部</option><option value="errors">错误与失败</option><option value="wechat">微信接口</option><option value="callbacks">微信回调</option></select></label>
        <label className="runtime-log-search">查找<input value={runtimeLogSearch} onChange={(event) => setRuntimeLogSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void loadRuntimeLogs(); }} placeholder="请求路径、错误内容或 requestId" /></label>
        <span><button className="secondary-button compact-action" onClick={() => void loadRuntimeLogs()} disabled={runtimeLogsLoading}>{runtimeLogsLoading ? "正在查询…" : "查询"}</button><button className="text-button compact-action" onClick={() => void window.contentFerry?.showLogFile(logDate)}>打开当天日志文件</button></span>
      </div>
      {runtimeLogPath && <p className="runtime-log-path">{runtimeLogPath}</p>}
      <p className="runtime-log-summary">显示 {runtimeLogs.length} / {runtimeLogMeta.totalMatched} 条匹配记录（按时间倒序）。{runtimeLogMeta.hasMore && " 当前仅展示最近 300 条匹配记录。"}{runtimeLogMeta.sourceTruncated && ` 当前日期日志超过 ${Math.round(runtimeLogMeta.readWindowBytes / 1024 / 1024)} MB，较早记录请通过“打开当天日志文件”查看。`}</p>
      {filteredRuntimeLogs.length === 0 ? <div className="empty-guidance"><strong>当前范围没有日志</strong><p>执行一次接口操作或切换到“全部”后再刷新。</p></div> : <ol className="runtime-log-list">{filteredRuntimeLogs.map((entry, index) => <li className={entry.level >= 50 || (entry.statusCode ?? 0) >= 400 ? "error-log" : ""} key={`${entry.time}-${entry.requestId}-${index}`}><time>{entry.time ? new Date(entry.time).toLocaleString() : "时间未知"}</time><span className="runtime-log-level">{runtimeLogLevel(entry.level)}</span><div><strong>{entry.method && entry.url ? `${entry.method} ${entry.url}` : entry.message || "运行记录"}</strong><small>{entry.statusCode != null ? `HTTP ${entry.statusCode}` : ""}{entry.responseTime != null ? ` · ${entry.responseTime.toFixed(1)} ms` : ""}{entry.message && entry.method ? ` · ${entry.message}` : ""}</small>{entry.error && <em>{entry.error}</em>}</div></li>)}</ol>}
    </section>}

    {activeView === "accounts" && <>
    <section className="card"><h2>添加账号</h2><form onSubmit={addAccount} className="account-form"><label>平台<select value={platform} onChange={(event) => setPlatform(event.target.value as AccountPlatform)}><option value="wechat_official">微信公众号</option><option value="csdn">CSDN</option></select></label><label>账号名称<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="例如：围炉聊科技" maxLength={100} /></label><button disabled={saving}>{saving ? "正在保存…" : "添加账号"}</button></form></section>
    </>}

    {editingSkill && <Modal onClose={() => setEditingSkill(undefined)} disabled={saving} title={editingSkill.name} eyebrow="技能管理" wide>
      <form onSubmit={saveSkill} className="profile-form">
        <p className="hint">{editingSkill.description}</p>
        <div className="skill-settings-row">
          <label className="toggle-label"><input type="checkbox" checked={editingSkill.enabled} onChange={(event) => setEditingSkill((current) => current ? { ...current, enabled: event.target.checked } : current)} />启用此技能</label>
          {editingSkill.id === "zhuque-detection" ? <p className="hint">此技能使用可见浏览器自动化，不需要大模型连接。</p> : <label>模型连接<select value={editingSkill.provider ?? ""} onChange={(event) => setEditingSkill((current) => current ? { ...current, provider: (event.target.value || null) as ModelProviderId | null } : current)}>{modelConnections.filter((connection) => editingSkill.category === "图片" ? connection.provider === "modelscope" || connection.provider === "gemini" : connection.provider === "openai_codex" || connection.provider === "openai" || connection.provider === "openrouter" || connection.provider === "github_copilot").map((connection) => <option key={connection.provider} value={connection.provider}>{connection.displayName}</option>)}</select></label>}
        </div>
        <label>SKILL.md<textarea className="skill-markdown-editor" value={editingSkill.markdown} onChange={(event) => setEditingSkill((current) => current ? { ...current, markdown: event.target.value } : current)} spellCheck={false} /></label>
        <small className="hint">文件位置：{editingSkill.filePath}</small>
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setEditingSkill(undefined)}>取消</button><button disabled={saving}>{saving ? "正在保存…" : "保存技能"}</button></div>
      </form>
    </Modal>}
    {editingConnection && <Modal onClose={() => setEditingConnection(undefined)} disabled={saving} title={`配置 ${editingConnection.displayName}`} eyebrow="模型连接">
      <form onSubmit={saveModelConnection} className="profile-form">
        <label>显示名称<input value={editingConnection.displayName} onChange={(event) => setEditingConnection((current) => current ? { ...current, displayName: event.target.value } : current)} /></label>
        <label>模型名称<input value={editingConnection.modelId} onChange={(event) => setEditingConnection((current) => current ? { ...current, modelId: event.target.value } : current)} placeholder="留空时使用服务默认模型" /></label>
        {editingConnection.provider !== "openai_codex" && <label>{editingConnection.provider === "github_copilot" ? "GitHub Token" : "API Key"}<input type="password" value={connectionCredential} onChange={(event) => setConnectionCredential(event.target.value)} autoComplete="new-password" placeholder={editingConnection.credentialConfigured ? "已配置；留空不修改" : "请输入访问凭证"} /></label>}
        {editingConnection.provider !== "openai_codex" && editingConnection.provider !== "github_copilot" && <label>服务地址<input value={editingConnection.baseUrl} onChange={(event) => setEditingConnection((current) => current ? { ...current, baseUrl: event.target.value } : current)} /></label>}
        {editingConnection.provider === "gemini" && <label>代理地址（可选）<input value={editingConnection.proxyUrl} onChange={(event) => setEditingConnection((current) => current ? { ...current, proxyUrl: event.target.value } : current)} placeholder="例如：http://127.0.0.1:7890" /><small>留空表示直连。代理不可用时，Gemini 请求会明确报错，不会静默切换。</small></label>}
        {editingConnection.provider === "openai_codex" && <p className="hint">OpenAI Codex 使用本机 ChatGPT/Codex 登录状态，不需要 API Key。安装包会携带 SDK 所需运行组件，不要求安装 Hermes Agent。</p>}
        {editingConnection.provider === "github_copilot" && <p className="hint">支持 GitHub Copilot Token。后续还会补充浏览器设备授权入口；现在也可使用本机已有的 GitHub/Copilot 登录环境。</p>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setEditingConnection(undefined)}>取消</button><button disabled={saving}>{saving ? "正在保存…" : "保存连接"}</button></div>
      </form>
    </Modal>}

    {editing && <Modal onClose={() => setEditing(undefined)} disabled={saving} title={`编辑定位：${editing.displayName}`} eyebrow="账号创作上下文"><p className="hint">这些内容会在后续创作时自动作为默认上下文；不确定的项目可以先留空。</p><form onSubmit={saveProfile} className="profile-form"><label>账号名称<input value={editingDisplayName} maxLength={100} onChange={(event) => setEditingDisplayName(event.target.value)} /></label><ProfileFields profile={profile} onChange={changeProfile} /><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setEditing(undefined)} disabled={saving}>取消</button><button disabled={saving}>{saving ? "正在保存…" : "保存定位"}</button></div></form></Modal>}
    {wechatAccount && <Modal onClose={() => setWechatAccount(undefined)} disabled={saving} title={`连接微信：${wechatAccount.displayName}`} eyebrow="微信公众号开发者接口">
      {!wechatCredentialStatus ? <p>正在读取已有配置…</p> : <><p className="hint">AppID 可以回显。出于安全原因，AppSecret 和消息校验 Token 不会把明文返回页面；显示“已配置”时留空即可保留，填写新值才会覆盖。</p>
      <form onSubmit={saveWechatConnection} className="profile-form">
        <label>AppID<input autoFocus value={wechatAppId} onChange={(event) => setWechatAppId(event.target.value)} autoComplete="off" /></label>
        <label>AppSecret<input type="password" value={wechatAppSecret} onChange={(event) => setWechatAppSecret(event.target.value)} autoComplete="new-password" placeholder={wechatCredentialStatus.appSecretConfigured ? "已配置；留空不修改" : "首次连接必须填写"} /></label>
        <label>消息校验 Token<input type="password" value={wechatCallbackToken} onChange={(event) => setWechatCallbackToken(event.target.value)} autoComplete="new-password" placeholder={wechatCredentialStatus.callbackTokenConfigured ? "已配置；留空不修改" : "首次连接必须填写"} /><small>填写公众号后台“服务器配置”中的 Token，不是 EncodingAESKey。</small></label>
        <div className="connection-explanation"><strong>本地回调监听地址</strong><code>{wechatCredentialStatus.localCallbackUrl}</code><small>文渡本地固定监听 4317 端口。公众号不能直接访问 127.0.0.1；你的公网 HTTPS 回调服务需要把请求转发到这个本地地址，公网通常使用 443 端口。</small></div>
        <p className="hint">“保存并测试连接”会向微信申请一次 access_token，用来验证 AppID、AppSecret、网络和 IP 白名单；不会创建草稿、发布文章或验证公网回调。</p>
        {wechatTestResult === "success" && <p className="success-message">连接测试成功：AppID、AppSecret、网络和当前 IP 白名单均可用。配置已保存。</p>}
        {wechatTestError && <p className="error">连接测试失败：{wechatTestError}。窗口会保留，请修改后重试。</p>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setWechatAccount(undefined)}>{wechatTestResult === "success" ? "完成" : "取消"}</button><button disabled={saving}>{saving ? "正在验证连接…" : wechatTestResult === "success" ? "重新测试" : "保存并测试连接"}</button></div>
      </form></>}
    </Modal>}
    {(publishProject || publishSource) && <Modal onClose={() => { setPublishProject(undefined); setPublishSource(undefined); }} disabled={saving || coverGenerating} title={`同步微信草稿：${publishProject?.topic ?? publishSource?.title ?? publishSource?.relativePath}`} eyebrow="第一步只创建草稿" wide>
      <p className="hint">这里仅确认文章设置并同步草稿，不再重复编辑账号、作者、摘要和封面。同步成功后请到公众号草稿箱进行手机预览。</p>
      <form onSubmit={createWechatDraft} className="profile-form">
        <div className="publish-readiness">
          <p className={publishAccountReady ? "ready" : "missing"}><strong>微信公众号</strong><span>{publishAccountReady ? selectedPublishAccount?.displayName : selectedPublishAccount ? `${selectedPublishAccount.displayName} 不是微信公众号` : "尚未选择微信公众号"}</span></p>
          <p className={publishCoverSource || publishThumbMediaId ? "ready" : "missing"}><strong>文章封面</strong><span>{publishCoverSource || publishThumbMediaId ? "已设置" : "尚未设置"}</span></p>
          <p className={publishAiCheckResult && !isHighAiDetectionResult(publishAiCheckResult, publishZhuqueReport) || publishAiOverrideReason.trim().length >= 5 ? "ready" : "missing"}><strong>AIGC 特征检测</strong><span>{publishAiCheckResult ? isHighAiDetectionResult(publishAiCheckResult, publishZhuqueReport) ? "AI 特征偏高，需要填写例外理由" : `${publishAiCheckTool === "contentany" ? "ContentAny" : "腾讯朱雀"} 已完成检测` : publishAiOverrideReason.trim().length >= 5 ? "已填写例外发布理由" : "尚未检测"}</span></p>
          <p className="ready"><strong>作者</strong><span>{publishAuthor || "未填写（允许）"}</span></p>
          <p className="ready"><strong>摘要</strong><span>{publishDigest ? `${publishDigest.length}/120 字` : "未填写（允许）"}</span></p>
        </div>
        <section className="publish-ai-check">
          <div className="detector-switch"><label>检测工具<select value={publishDetector} onChange={(event) => setPublishDetector(event.target.value as "zhuque" | "contentany")}><option value="zhuque">腾讯朱雀</option><option value="contentany">ContentAny</option></select></label><button type="button" className="secondary-button" onClick={() => void (publishDetector === "zhuque" ? runPublishZhuque() : runPublishContentAny())} disabled={publishAiCheckRunning || saving}>{publishAiCheckRunning ? "正在自动检测…" : publishDetector === "zhuque" ? "开始腾讯朱雀检测" : "开始 ContentAny 检测"}</button></div>
          <div><strong>发布前 AIGC 特征检测</strong><small>腾讯朱雀或 ContentAny 任一项完成即可。文渡会自动填入正文、触发检测并读取结果；仅在登录、验证码或页面变化时人工接管。</small></div>
          {publishZhuqueReport ? <ZhuqueReportView report={publishZhuqueReport} /> : publishAiCheckResult && <pre>{publishAiCheckResult}</pre>}
          {publishAiCheckResult && publishAiCheckTool === "zhuque" && <button type="button" className="text-button zhuque-original-button" onClick={() => void openZhuque()}>查看朱雀原始结果窗口</button>}
          {(!publishAiCheckResult || isHighAiDetectionResult(publishAiCheckResult, publishZhuqueReport)) && <label>例外发布理由<textarea value={publishAiOverrideReason} maxLength={1000} onChange={(event) => setPublishAiOverrideReason(event.target.value)} placeholder={publishAiCheckResult ? "检测结果 AI 特征偏高，但仍决定发布的原因" : "仅在任一检测暂时无法完成时填写"} /><small>{publishAiOverrideReason.length}/1000，至少填写 5 个字</small></label>}
        </section>
        {(!publishAccountReady || (!publishCoverSource && !publishThumbMediaId)) && <p className="error">发布信息不完整。请返回文章编辑页，在右侧“发布设置”中补充标红项目并保存。</p>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => void returnToPublishSettings()}>返回发布设置</button><button disabled={saving || publishAiCheckRunning || !publishAccountReady || (!publishCoverSource && !publishThumbMediaId) || (!publishAiCheckResult && publishAiOverrideReason.trim().length < 5) || (isHighAiDetectionResult(publishAiCheckResult, publishZhuqueReport) && publishAiOverrideReason.trim().length < 5)}>{saving ? "正在上传素材并创建草稿…" : "确认并创建微信草稿"}</button></div>
      </form>
    </Modal>}
    {correctingWechatJob && <Modal onClose={() => setCorrectingWechatJob(undefined)} disabled={wechatCorrectionSaving} title="人工校正微信状态" eyebrow="回执异常兜底">
      <form onSubmit={saveWechatStatusCorrection} className="profile-form status-correction-modal">
        <p className="hint">如果你是在微信公众号后台直接发布，核实结果后即可立即校正，无需等待。此操作不会再次调用发布接口。</p>
        <div className="status-correction-warning"><strong>请先在公众号后台核实</strong><span>特别是群发任务，错误标记可能导致后续误判和重复发送。</span></div>
        <label>最终状态<select value={correctedWechatStatus} disabled={wechatCorrectionSaving} onChange={(event) => setCorrectedWechatStatus(event.target.value as "published" | "failed" | "cancelled")}><option value="published">已发布</option><option value="failed">发布失败</option><option value="cancelled">取消发布</option></select></label>
        <label>核实依据（可选）<textarea autoFocus value={wechatStatusReason} disabled={wechatCorrectionSaving} onChange={(event) => { setWechatStatusReason(event.target.value); setWechatCorrectionError(""); }} maxLength={500} placeholder="例如：在公众号后台“发表记录”确认已发布，文章链接为……" /><small>{wechatStatusReason.length}/500，可留空</small></label>
        {wechatCorrectionError && <p className="error">{wechatCorrectionError}</p>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setCorrectingWechatJob(undefined)} disabled={wechatCorrectionSaving}>取消</button><button disabled={wechatCorrectionSaving}>{wechatCorrectionSaving ? "正在保存…" : "确认校正"}</button></div>
      </form>
    </Modal>}
    {orphanedWechatJob && <Modal onClose={() => setOrphanedWechatJob(undefined)} disabled={saving} title="找不到本地文章" eyebrow="发布记录需要处理">
      <p>“{orphanedWechatJob.title}”对应的本地文章已经被删除，无法重新设置或同步。你可以保留这条记录用于追溯，也可以只删除这条发布记录。</p>
      <p className="hint">删除发布记录不会删除微信公众号中的草稿或已经发布的文章。</p>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setOrphanedWechatJob(undefined)} disabled={saving}>保留记录</button><button type="button" className="danger-button" onClick={() => void deleteWechatJob()} disabled={saving}>{saving ? "正在删除…" : "删除记录"}</button></div>
    </Modal>}
    {publishCropImage && <CoverCropModal image={publishCropImage} onCancel={() => setPublishCropImage(undefined)} onConfirm={(cropped) => void saveCroppedPublishCover(cropped)} />}

    {sourceModalOpen && <Modal onClose={() => setSourceModalOpen(false)} disabled={saving} title="配置文章库" eyebrow="只读导入预览" wide><p className="hint">选择 VitePress 仓库中的 `docs` 文件夹。只会识别 `posts/文章标题/index.md` 为文章；首页、列表页和排序配置页会自动排除。</p><form onSubmit={scanSource} className="source-form"><label>文章库路径<input autoFocus value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} placeholder="例如：D:\\MySite\\docs" /></label><button type="button" className="secondary-button" onClick={() => void chooseDirectory()}>浏览…</button><button disabled={saving}>{saving ? "正在扫描…" : "保存并扫描"}</button></form>{sourcePreview && <div className="scan-result"><p><strong>发现 {sourcePreview.articleCount} 篇文章</strong><br /><small>{sourcePreview.rootPath}</small></p>{sourcePreview.sitePageCount > 0 && <p className="hint compact-hint">已自动排除 {sourcePreview.sitePageCount} 个站点页、列表页或配置页，不会作为文章导入。</p>}{sourcePreview.warnings.map((warning) => <p className="error" key={warning}>{warning}</p>)}<ul className="preview-list">{sourcePreview.items.map((item) => <li key={item.relativePath}><span><strong>{item.title ?? item.relativePath}</strong><small>{item.relativePath}</small></span><em>{item.frontMatterKeys.length ? item.frontMatterKeys.join(" · ") : "无 Front Matter"}</em></li>)}</ul>{sourcePreview.truncated && <p className="hint">预览已截断，但文章总数已完整统计。</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setSourceModalOpen(false)}>稍后再说</button><button type="button" onClick={() => { setSourceModalOpen(false); setProjectModalOpen(true); }}>下一步：新建文章</button></div></div>}</Modal>}

    {projectModalOpen && <Modal onClose={() => setProjectModalOpen(false)} disabled={saving} title="新建文章" eyebrow="从想法开始"><p className="hint">写下一句主题、观点或想解决的问题即可。后续 AI 会结合账号定位和你的资料，补充研究并生成创作简报。</p><form onSubmit={createProject} className="profile-form"><label>文章主题或想法<textarea autoFocus value={projectTopic} onChange={(event) => setProjectTopic(event.target.value)} placeholder="例如：我想写 AI Agent 如何改变个人开发者的工作流" /></label><label>发布账号（可稍后选择）<select value={projectAccountId} onChange={(event) => setProjectAccountId(event.target.value)}><option value="">暂不选择</option>{accounts.map((account) => <option value={account.id} key={account.id}>{platformName(account.platform)} · {account.displayName}</option>)}</select></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setProjectModalOpen(false)} disabled={saving}>取消</button><button disabled={saving}>{saving ? "正在创建…" : "创建并进入创作"}</button></div></form></Modal>}
    {briefProject && <Modal onClose={() => { setBriefProject(undefined); setBrief(undefined); }} disabled={saving} title={`创作简报：${briefProject.topic}`} eyebrow="第二步：确认创作方向">{!brief ? <p>正在准备简报…</p> : <><p className="hint">{brief.generatedFromAccountProfile ? "这是根据已选账号定位生成的初始草稿，请补充和调整。" : "你可以继续完善这份已保存的简报。"} 保存后，AI 会结合这份简报和账号定位生成文章提纲。</p><form onSubmit={saveBrief} className="profile-form"><label>写作目标<textarea autoFocus value={brief.objective} onChange={(event) => changeBrief("objective", event.target.value)} placeholder="希望这篇文章帮助读者完成什么？" /></label><label>目标读者<textarea value={brief.audience} onChange={(event) => changeBrief("audience", event.target.value)} placeholder="这篇文章主要给谁看？" /></label><label>核心角度<textarea value={brief.angle} onChange={(event) => changeBrief("angle", event.target.value)} placeholder="这篇文章独特的观点、切入角度或边界" /></label><label>已有资料与想法<textarea value={brief.sourceNotes} onChange={(event) => changeBrief("sourceNotes", event.target.value)} placeholder="粘贴链接、笔记、数据、个人经历或必须参考的资料" /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => { setBriefProject(undefined); setBrief(undefined); }} disabled={saving}>稍后继续</button><button disabled={saving}>{saving ? "正在保存…" : "保存简报"}</button></div></form></>}</Modal>}
    {outlineProject && <Modal onClose={() => { outlineAbortRef.current?.abort(); setOutlineProject(undefined); setOutline(undefined); }} disabled={saving} title={`文章提纲：${outlineProject.topic}`} eyebrow="第三步：审核文章结构" wide>{!outline ? <p>正在准备提纲…</p> : <><p className="hint">{outlineGenerating ? "AI 正在逐步生成提纲；可继续等待，或停止后保留当前内容。" : outline.generatedFromBrief ? "这是 AI 根据账号定位、创作简报和已有资料生成的提纲。请审核论证方向和待核查项。" : "你可以继续编辑已保存的提纲。"}</p><form onSubmit={saveOutline} className="profile-form"><label>文章提纲</label><Suspense fallback={<p className="hint">正在打开可视化编辑器…</p>}><VisualMarkdownEditor value={outline.markdown} assetContextId={outlineProject.id} onChange={(markdown) => setOutline((current) => current ? { ...current, markdown } : current)} /></Suspense><div className="modal-actions">{outlineGenerating && <button type="button" className="secondary-button" onClick={() => outlineAbortRef.current?.abort()}>停止生成</button>}<button type="button" className="secondary-button" onClick={() => { outlineAbortRef.current?.abort(); setOutlineProject(undefined); setOutline(undefined); }} disabled={saving}>稍后继续</button><button disabled={saving || outlineGenerating}>{saving ? "正在保存…" : "确认并保存提纲"}</button></div></form></>}</Modal>}
  </main></div>;
}

function WorkspaceLoading({ title, message, onBack }: { title: string; message: string; onBack: () => void }) {
  return <div className="editor-workspace"><header className="editor-topbar"><button className="secondary-button" onClick={onBack}>← 返回内容库</button><div className="editor-document-title"><strong>{title}</strong><small>文渡创作工作台</small></div><span /></header><div className="workspace-loading"><div className="loading-dot" /><p>{message}</p></div></div>;
}

function ArticleWorkspace({
  title,
  subtitle,
  markdown,
  assetContextId,
  sourceArticlePath,
  projectId,
  accounts,
  initialRightPanel,
  saving,
  generating = false,
  onStopGeneration,
  onChange,
  onBack,
  onSave,
  onPublish
}: {
  title: string;
  subtitle: string;
  markdown: string;
  assetContextId: string;
  sourceArticlePath?: string;
  projectId?: string;
  accounts: MediaAccount[];
  initialRightPanel: "assistant" | "preview" | "settings";
  saving: boolean;
  generating?: boolean;
  onStopGeneration?: () => void;
  onChange: (markdown: string) => void;
  onBack: () => void;
  onSave: () => Promise<{ success: boolean; markdown?: string; error?: string }>;
  onPublish?: () => void;
}) {
  const [rightPanel, setRightPanel] = useState<"assistant" | "preview" | "settings">(initialRightPanel);
  const [editorMode, setEditorMode] = useState<"visual" | "markdown">("visual");
  const [leftTool, setLeftTool] = useState<"body" | "structure" | "sources" | "images">("body");
  const [articleSettings, setArticleSettings] = useState<ArticleSettings>({ author: "", digest: "", coverSource: "", accountId: "" });
  const [authorHistory, setAuthorHistory] = useState<string[]>([]);
  const [workspaceError, setWorkspaceError] = useState("");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [coverCropImage, setCoverCropImage] = useState<SelectedImage>();
  const [settingsMaterials, setSettingsMaterials] = useState<WechatMaterial[]>([]);
  const [settingsCoverProvider, setSettingsCoverProvider] = useState<"modelscope" | "gemini">("modelscope");
  const [settingsCoverPrompt, setSettingsCoverPrompt] = useState("");
  const [settingsCoverBusy, setSettingsCoverBusy] = useState(false);
  const [settingsCoverPromptBusy, setSettingsCoverPromptBusy] = useState(false);
  const [settingsSummaryBusy, setSettingsSummaryBusy] = useState(false);
  const [selectionRange, setSelectionRange] = useState<{ start: number; end: number }>();
  const [selectionAiAction, setSelectionAiAction] = useState<"rewrite" | "expand" | "shorten" | "example" | "humanize">("humanize");
  const [selectionAiBusy, setSelectionAiBusy] = useState(false);
  const [selectionAiResult, setSelectionAiResult] = useState("");
  const [selectionDetectionTool, setSelectionDetectionTool] = useState<"zhuque" | "contentany">("zhuque");
  const [selectionDetectionBusy, setSelectionDetectionBusy] = useState(false);
  const [selectionDetectionResult, setSelectionDetectionResult] = useState("");
  const [selectionZhuqueReport, setSelectionZhuqueReport] = useState<ZhuqueReport>();
  const [savedMarkdown, setSavedMarkdown] = useState(markdown);
  const [savedSettings, setSavedSettings] = useState<ArticleSettings>({ author: "", digest: "", coverSource: "", accountId: "" });
  const contextKey = sourceArticlePath ? `source:${sourceArticlePath}` : `project:${projectId ?? assetContextId}`;
  useEffect(() => {
    void Promise.all([
      request<ArticleSettings>(`/article-settings?contextKey=${encodeURIComponent(contextKey)}`),
      request<{ items: string[] }>("/article-settings/authors")
    ]).then(([settings, authors]) => {
      setArticleSettings(settings);
      setSavedSettings(settings);
      setAuthorHistory(authors.items);
    }).catch((cause) => setWorkspaceError(cause instanceof Error ? cause.message : "无法读取文章设置。"));
  }, [contextKey]);

  const hasUnsavedChanges = markdown !== savedMarkdown || JSON.stringify(articleSettings) !== JSON.stringify(savedSettings);
  useEffect(() => {
    const warnBeforeWindowClose = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeWindowClose);
    return () => window.removeEventListener("beforeunload", warnBeforeWindowClose);
  }, [hasUnsavedChanges]);

  const persistArticleSettings = async () => {
    setSettingsSaving(true);
    try {
      await request("/article-settings", {
        method: "PUT",
        body: JSON.stringify({ contextKey, ...articleSettings })
      });
      setWorkspaceError("");
      return true;
    } catch (cause) {
      setWorkspaceError(cause instanceof Error ? cause.message : "文章设置保存失败。");
      return false;
    } finally {
      setSettingsSaving(false);
    }
  };
  const saveArticleAndSettings = async () => {
    if (!await persistArticleSettings()) return;
    const result = await onSave();
    if (result.success) {
      setSavedMarkdown(result.markdown ?? markdown);
      setSavedSettings(articleSettings);
      setWorkspaceError("");
    } else {
      setWorkspaceError(result.error ?? "文章保存失败，请查看运行日志。 ");
    }
  };
  const prepareFromWorkspace = async () => {
    if (await persistArticleSettings()) onPublish?.();
  };
  const chooseArticleCover = async () => {
    if (!window.contentFerry) {
      setWorkspaceError("选择本地封面需要在文渡桌面窗口中操作。");
      return;
    }
    const selected = await window.contentFerry.selectImage();
    if (!selected) return;
    setCoverCropImage(selected);
  };
  const saveCroppedArticleCover = async (selected: SelectedImage) => {
    try {
      const endpoint = sourceArticlePath ? "/content-source/article-asset" : "/content-assets";
      const payload = sourceArticlePath
        ? { path: sourceArticlePath, mimeType: selected.mimeType, base64: selected.base64 }
        : { contextId: assetContextId, mimeType: selected.mimeType, base64: selected.base64 };
      const saved = await request<{ assetUrl: string }>(endpoint, { method: "POST", body: JSON.stringify(payload) });
      setArticleSettings((current) => ({ ...current, coverSource: saved.assetUrl }));
      setWorkspaceError("");
    } catch (cause) {
      setWorkspaceError(cause instanceof Error ? cause.message : "封面保存失败。");
    } finally {
      setCoverCropImage(undefined);
    }
  };
  const cropExistingCover = async (url: string, fileName: string) => {
    try {
      setCoverCropImage(await readImageUrl(url, fileName));
    } catch (cause) {
      setWorkspaceError(cause instanceof Error ? cause.message : "无法读取所选图片。");
    }
  };
  const loadSettingsMaterials = async () => {
    if (!articleSettings.accountId) {
      setWorkspaceError("请先在文章设置中选择微信公众号。");
      return;
    }
    setSettingsCoverBusy(true);
    try {
      const result = await request<{ items: WechatMaterial[] }>(`/integrations/wechat/accounts/${articleSettings.accountId}/materials/images?offset=0&count=20`);
      setSettingsMaterials(result.items);
      setWorkspaceError("");
    } catch (cause) {
      setWorkspaceError(cause instanceof Error ? cause.message : "读取微信素材库失败。");
    } finally {
      setSettingsCoverBusy(false);
    }
  };
  const chooseSettingsMaterial = async (material: WechatMaterial) => {
    const url = `${apiBase}/integrations/wechat/accounts/${articleSettings.accountId}/materials/images/${encodeURIComponent(material.mediaId)}`;
    await cropExistingCover(url, material.name || "微信素材.png");
  };
  const generateSettingsCover = async () => {
    if (!sourceArticlePath && !projectId) return;
    if (!settingsCoverPrompt.trim()) {
      setWorkspaceError("请先让 AI 根据正文生成封面提示词，或自行填写提示词。");
      return;
    }
    setSettingsCoverBusy(true);
    try {
      const generated = await request<{ assetUrl: string }>("/skills/cover-generation/run", {
        method: "POST",
        body: JSON.stringify({
          ...(sourceArticlePath ? { relativePath: sourceArticlePath } : { projectId }),
          provider: settingsCoverProvider,
          ...(settingsCoverPrompt.trim() ? { prompt: settingsCoverPrompt.trim() } : {})
        })
      });
      setArticleSettings((current) => ({ ...current, coverSource: generated.assetUrl }));
      setWorkspaceError("");
    } catch (cause) {
      setWorkspaceError(cause instanceof Error ? cause.message : "AI 封面生成失败。");
    } finally {
      setSettingsCoverBusy(false);
    }
  };
  const generateSettingsCoverPrompt = async () => {
    setSettingsCoverPromptBusy(true);
    try {
      const generated = await request<{ prompt: string }>("/skills/cover-prompt-generation/run", {
        method: "POST",
        body: JSON.stringify({ title, markdown })
      });
      setSettingsCoverPrompt(generated.prompt);
      setWorkspaceError("");
    } catch (cause) {
      setWorkspaceError(cause instanceof Error ? cause.message : "封面提示词生成失败。");
    } finally {
      setSettingsCoverPromptBusy(false);
    }
  };
  const selectedSettingsAccount = accounts.find((account) => account.id === articleSettings.accountId);
  const digestMaxLength = selectedSettingsAccount?.platform === "csdn" ? 200 : 120;
  const generateArticleSummary = async () => {
    if (!selectedSettingsAccount) {
      setWorkspaceError("请先选择发布账号，系统需要根据平台生成对应长度的摘要。");
      return;
    }
    setSettingsSummaryBusy(true);
    try {
      const generated = await request<{ summary: string; maxLength: number }>("/skills/article-summary/run", {
        method: "POST",
        body: JSON.stringify({
          platform: selectedSettingsAccount.platform,
          title,
          markdown
        })
      });
      setArticleSettings((current) => ({ ...current, digest: generated.summary }));
      setWorkspaceError("");
    } catch (cause) {
      setWorkspaceError(cause instanceof Error ? cause.message : "文章摘要生成失败。");
    } finally {
      setSettingsSummaryBusy(false);
    }
  };
  const captureVisualSelection = (selectedText: string) => {
    setSelectionAiResult("");
    if (!selectedText) {
      setSelectionRange(undefined);
      return;
    }
    const start = markdown.indexOf(selectedText);
    if (start < 0 || markdown.indexOf(selectedText, start + selectedText.length) >= 0) {
      setSelectionRange(undefined);
      setWorkspaceError("这段文字在正文中出现了多次，暂时无法准确定位。请切换到 Markdown 原文模式后重新选择。");
      return;
    }
    setSelectionRange({ start, end: start + selectedText.length });
    setSelectionAiAction("humanize");
    setRightPanel("assistant");
    setWorkspaceError("");
  };
  const runSelectionAi = async () => {
    if (!selectionRange || selectionRange.end <= selectionRange.start) {
      setWorkspaceError("请先在正文编辑区选中一段文字。");
      return;
    }
    setSelectionAiBusy(true);
    try {
      const selectedText = markdown.slice(selectionRange.start, selectionRange.end);
      const generated = await request<{ replacement: string }>("/skills/selection-edit/run", {
        method: "POST",
        body: JSON.stringify({
          action: selectionAiAction,
          title,
          selectedText,
          beforeText: markdown.slice(Math.max(0, selectionRange.start - 3000), selectionRange.start),
          afterText: markdown.slice(selectionRange.end, selectionRange.end + 3000)
        })
      });
      setSelectionAiResult(generated.replacement);
      setWorkspaceError("");
    } catch (cause) {
      setWorkspaceError(cause instanceof Error ? cause.message : "选区 AI 处理失败。");
    } finally {
      setSelectionAiBusy(false);
    }
  };
  const applySelectionAiResult = () => {
    if (!selectionRange || !selectionAiResult) return;
    onChange(`${markdown.slice(0, selectionRange.start)}${selectionAiResult}${markdown.slice(selectionRange.end)}`);
    setSelectionRange(undefined);
    setSelectionAiResult("");
  };
  const runSelectionDetection = async () => {
    if (!selectionRange || selectionRange.end <= selectionRange.start) {
      setWorkspaceError("请先在正文中选中要检测的段落。");
      return;
    }
    setSelectionDetectionBusy(true);
    setSelectionDetectionResult("");
    setSelectionZhuqueReport(undefined);
    try {
      if (!window.contentFerry) throw new Error("当前桌面环境未启用 AIGC 检测能力。");
      const desktop = window.contentFerry;
      const selectedText = markdown.slice(selectionRange.start, selectionRange.end);
      if (selectionDetectionTool === "zhuque") {
        const result = await desktop.runZhuqueDetection(selectedText);
        if (result.status !== "completed" || !result.report) throw new Error(result.message || "腾讯朱雀未返回可用检测结果。");
        setSelectionZhuqueReport(result.report);
      } else {
        const result = await desktop.runContentAnyDetection(selectedText);
        if (result.status !== "completed") throw new Error(result.message || "ContentAny 未返回可用检测结果。");
        setSelectionDetectionResult(result.result || "ContentAny 已完成检测，但没有返回可展示的文字结果。");
      }
      setWorkspaceError("");
    } catch (cause) {
      setWorkspaceError(cause instanceof Error ? cause.message : "AIGC 特征检测失败。");
    } finally {
      setSelectionDetectionBusy(false);
    }
  };
  const wordCount = markdown.replace(/[#>*_`\-\[\]()]/g, "").replace(/\s/g, "").length;
  const images = extractMarkdownImages(markdown);
  const coverCandidates = images.filter((image) => sourceArticlePath
    ? !/^https?:\/\//i.test(image.src)
    : image.src.startsWith("contentferry-asset://"));
  const headings = markdown.split(/\r?\n/).map((line) => /^(#{1,6})\s+(.+)$/.exec(line)).filter((value): value is RegExpExecArray => Boolean(value));
  const sources = [...new Set([...markdown.matchAll(/https?:\/\/[^\s)>]+/g)].map((match) => match[0]))];
  const editorBusy = saving || settingsSaving || settingsCoverBusy || settingsCoverPromptBusy || settingsSummaryBusy;
  const busy = editorBusy;
  useEffect(() => {
    const saveWithShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      if (!hasUnsavedChanges || editorBusy || generating) return;
      void saveArticleAndSettings();
    };
    window.addEventListener("keydown", saveWithShortcut);
    return () => window.removeEventListener("keydown", saveWithShortcut);
  }, [hasUnsavedChanges, editorBusy, generating, markdown, articleSettings]);
  const leaveWorkspace = () => {
    if (hasUnsavedChanges && !window.confirm("文章还有未保存的修改。确定放弃这些修改并返回内容库吗？")) return;
    onBack();
  };
  return <div className="editor-workspace">
    <header className="editor-topbar">
      <button className="secondary-button" onClick={leaveWorkspace}>← 返回内容库</button>
      <div className="editor-document-title"><strong>{title}</strong><small>{subtitle}</small></div>
      <div className="editor-top-actions"><span>{generating ? "AI 正在逐步生成…" : busy ? "正在保存…" : hasUnsavedChanges ? "有未保存修改" : "已保存"}</span>{generating && <button className="secondary-button" onClick={onStopGeneration}>停止生成</button>}<button onClick={() => void saveArticleAndSettings()} disabled={busy || generating || !hasUnsavedChanges}>保存文章</button>{onPublish && <button onClick={() => void prepareFromWorkspace()} disabled={busy || generating}>准备发布</button>}</div>
    </header>
    <div className="editor-columns">
      <aside className="editor-left-panel">
        <h3>文章工具</h3>
        <button className={`workspace-tool${leftTool === "body" ? " active" : ""}`} onClick={() => setLeftTool("body")}>正文</button>
        <button className={`workspace-tool${leftTool === "structure" ? " active" : ""}`} onClick={() => setLeftTool("structure")}>文章结构</button>
        <button className={`workspace-tool${leftTool === "sources" ? " active" : ""}`} onClick={() => setLeftTool("sources")}>资料来源</button>
        <button className={`workspace-tool${leftTool === "images" ? " active" : ""}`} onClick={() => setLeftTool("images")}>图片素材</button>
        {leftTool === "body" && <div className="editor-stats"><span>{wordCount} 字</span><span>{images.length} 张图片</span><span>约 {Math.max(1, Math.ceil(wordCount / 500))} 分钟阅读</span></div>}
        {leftTool === "structure" && <div className="tool-detail"><strong>文章结构</strong>{headings.length ? headings.map((heading, index) => <button className="structure-link" key={index} style={{ paddingLeft: `${(heading[1].length - 1) * 10}px` }} onClick={() => scrollEditorToHeading(heading[2], index, markdown, editorMode)}>{heading[2]}</button>) : <small>正文中还没有标题。</small>}</div>}
        {leftTool === "sources" && <div className="tool-detail"><strong>资料来源</strong>{sources.length ? sources.map((source) => <a className="source-link" href={source} target="_blank" rel="noreferrer" title={`在浏览器中打开：${source}`} key={source}>{source}</a>) : <small>暂未识别到链接来源。</small>}</div>}
        {leftTool === "images" && <div className="tool-detail"><strong>图片素材</strong>{images.length ? images.map((image, index) => <img key={`${image.src}-${index}`} src={resolveArticleImageUrl(image.src, assetContextId, sourceArticlePath)} alt={image.alt || "文章图片"} />) : <small>正文中还没有图片。</small>}<button disabled className="text-button">独立素材库即将开放</button></div>}
      </aside>
      <section className="editor-canvas">
        <div className="editor-canvas-toolbar">
          <div className="editor-mode-switch"><button className={editorMode === "visual" ? "active" : ""} onClick={() => setEditorMode("visual")}>所见即所得</button><button className={editorMode === "markdown" ? "active" : ""} onClick={() => setEditorMode("markdown")}>Markdown 原文</button></div>
          <small>{editorMode === "visual" ? "图片可直接拖入、粘贴，或输入 “/” 后选择图片" : "直接编辑 Markdown，切回后会重新渲染"}</small>
        </div>
        {workspaceError && <p className="error editor-inline-error">{workspaceError}</p>}
        {editorMode === "visual" ? <Suspense fallback={<p className="hint">正在打开文章编辑器…</p>}>
          <VisualMarkdownEditor key={sourceArticlePath ?? assetContextId} value={markdown} assetContextId={assetContextId} sourceArticlePath={sourceArticlePath} minHeight={680} onChange={onChange} onError={setWorkspaceError} onTextSelection={captureVisualSelection} />
        </Suspense> : <textarea className="markdown-source-editor" value={markdown} onChange={(event) => onChange(event.target.value)} onSelect={(event) => { const target = event.currentTarget; const selected = target.selectionEnd > target.selectionStart; setSelectionRange(selected ? { start: target.selectionStart, end: target.selectionEnd } : undefined); if (selected) { setSelectionAiAction("humanize"); setRightPanel("assistant"); } setSelectionAiResult(""); }} spellCheck={false} />}
      </section>
      <aside className="editor-right-panel">
        <div className="panel-tabs">
          <button className={rightPanel === "assistant" ? "active" : ""} onClick={() => setRightPanel("assistant")}>AI 助手</button>
          <button className={rightPanel === "preview" ? "active" : ""} onClick={() => setRightPanel("preview")}>手机预览</button>
          <button className={rightPanel === "settings" ? "active" : ""} onClick={() => setRightPanel("settings")}>文章设置</button>
        </div>
        {rightPanel === "assistant" && <div className="side-panel-content selection-assistant"><h3>AI 处理选中文字</h3>{selectionRange ? <><p className="selection-ready">已选中 {selectionRange.end - selectionRange.start} 个字符，默认使用“去 AI 味”。</p><blockquote>{markdown.slice(selectionRange.start, selectionRange.end)}</blockquote></> : <div className="selection-guide"><strong>去 AI 味怎么用？</strong><ol><li>在中间正文里拖动选中一段文字</li><li>右侧会自动识别并默认选择“去 AI 味”</li><li>生成建议，确认后再替换原文</li></ol></div>}<div className="selection-action-grid">{([["humanize", "去 AI 味"], ["rewrite", "改写"], ["expand", "扩写"], ["shorten", "缩写"], ["example", "补充案例"]] as const).map(([value, label]) => <button type="button" className={selectionAiAction === value ? "active" : ""} onClick={() => setSelectionAiAction(value)} key={value}>{label}</button>)}</div><button type="button" onClick={() => void runSelectionAi()} disabled={!selectionRange || selectionAiBusy}>{selectionAiBusy ? "AI 正在处理…" : selectionAiAction === "humanize" ? "AI 去 AI 味（先预览）" : "生成替换建议（先预览）"}</button>{selectionAiResult && <div className="selection-result"><strong>AI 建议，不会自动覆盖原文</strong><pre>{selectionAiResult}</pre><div className="selection-result-actions"><button type="button" className="secondary-button" onClick={() => setSelectionAiResult("")}>放弃</button><button type="button" onClick={applySelectionAiResult}>用建议替换选中文字</button></div></div>}<small>“去 AI 味”的处理规则来自“技能与模型”中的“选中文字去 AI 味”技能，可单独修改和切换模型。</small></div>}
        {rightPanel === "assistant" && <div className="side-panel-content selection-detection"><h3>AIGC 特征检测</h3><p>针对当前选中段落检测；朱雀或 ContentAny 任一结果都可作为优化参考。</p><div className="selection-detection-controls"><select value={selectionDetectionTool} onChange={(event) => setSelectionDetectionTool(event.target.value as "zhuque" | "contentany")}><option value="zhuque">腾讯朱雀</option><option value="contentany">ContentAny</option></select><button type="button" className="secondary-button" onClick={() => void runSelectionDetection()} disabled={!selectionRange || selectionDetectionBusy}>{selectionDetectionBusy ? "正在检测…" : "检测选中内容"}</button></div>{!selectionRange && <small>先在正文中选中一段内容，检测不会自动发送整篇文章。</small>}{selectionZhuqueReport && <ZhuqueReportView report={selectionZhuqueReport} />}{selectionDetectionResult && <pre className="selection-detection-result">{selectionDetectionResult}</pre>}</div>}
        {rightPanel === "preview" && <div className="phone-frame"><div className="phone-screen"><h2>{title}</h2><small className="phone-byline">{articleSettings.author || selectedSettingsAccount?.displayName || "未填写作者"}</small>{renderPhonePreview(markdown, assetContextId, sourceArticlePath, title)}</div></div>}
        {rightPanel === "settings" && <div className="side-panel-content">
          <h3>发布设置</h3>
          <label>发布账号
            <select value={articleSettings.accountId} onChange={(event) => {
              setArticleSettings((current) => ({ ...current, accountId: event.target.value }));
              setSettingsMaterials([]);
            }}>
              <option value="">请选择发布账号</option>
              {accounts.map((account) => <option value={account.id} key={account.id}>{platformName(account.platform)} · {account.displayName}{account.platform === "csdn" ? "（发布接口即将开放）" : ""}</option>)}
            </select>
            <small>选择后会随文章保存；发布前仍可更改。</small>
          </label>
          <label>作者<input list={`author-history-${assetContextId}`} value={articleSettings.author} maxLength={16} onChange={(event) => setArticleSettings((current) => ({ ...current, author: event.target.value }))} placeholder="可输入或选择过去使用过的作者" /><datalist id={`author-history-${assetContextId}`}>{authorHistory.map((author) => <option value={author} key={author} />)}</datalist><small>{articleSettings.author.length}/16 字</small></label>
          <label>摘要
            <textarea value={articleSettings.digest} maxLength={digestMaxLength} onChange={(event) => setArticleSettings((current) => ({ ...current, digest: event.target.value }))} placeholder={`用于${selectedSettingsAccount ? platformName(selectedSettingsAccount.platform) : "目标平台"}的内容卡片和分享，最多 ${digestMaxLength} 字`} />
            <small>{articleSettings.digest.length}/{digestMaxLength} 字{selectedSettingsAccount ? ` · ${platformName(selectedSettingsAccount.platform)}限制` : " · 选择账号后按平台适配"}</small>
            <button type="button" className="secondary-button" onClick={() => void generateArticleSummary()} disabled={busy}>{settingsSummaryBusy ? "AI 正在提炼摘要…" : "AI 生成适配摘要"}</button>
          </label>
          <div className="settings-cover-section">
            <strong>封面</strong>
            {articleSettings.coverSource && <><img className="settings-cover-preview" src={resolveArticleImageUrl(articleSettings.coverSource, assetContextId, sourceArticlePath)} alt="文章封面" /><button type="button" className="text-button danger-text" onClick={() => setArticleSettings((current) => ({ ...current, coverSource: "" }))}>移除封面</button></>}
            <button type="button" className="secondary-button" onClick={() => void chooseArticleCover()}>选择本地图片并裁剪</button>
            {coverCandidates.length > 0 && <details><summary>从正文图片选择</summary><div className="article-cover-choices">{coverCandidates.map((image, index) => <button type="button" key={`${image.src}-${index}`} onClick={() => void cropExistingCover(resolveArticleImageUrl(image.src, assetContextId, sourceArticlePath), image.alt || `正文图片-${index + 1}.png`)}><img src={resolveArticleImageUrl(image.src, assetContextId, sourceArticlePath)} alt={image.alt || "正文图片"} /><small>选择并裁剪</small></button>)}</div></details>}
            {articleSettings.accountId && accounts.find((account) => account.id === articleSettings.accountId)?.platform === "wechat_official" && <details><summary>从微信素材库选择</summary><button type="button" className="secondary-button" onClick={() => void loadSettingsMaterials()} disabled={settingsCoverBusy}>加载最近图片</button>{settingsMaterials.length > 0 && <div className="article-cover-choices">{settingsMaterials.map((material) => <button type="button" key={material.mediaId} onClick={() => void chooseSettingsMaterial(material)}><img src={`${apiBase}/integrations/wechat/accounts/${articleSettings.accountId}/materials/images/${encodeURIComponent(material.mediaId)}`} alt={material.name || "微信素材"} /><small>{material.name || "未命名图片"}</small></button>)}</div>}</details>}
            <details className="ai-cover-details"><summary>AI 生成封面</summary><label>图片模型<select value={settingsCoverProvider} onChange={(event) => setSettingsCoverProvider(event.target.value as "modelscope" | "gemini")}><option value="modelscope">ModelScope</option><option value="gemini">Google Gemini</option></select></label><div className="cover-prompt-heading"><strong>封面提示词</strong><button type="button" className="secondary-button compact-action" onClick={() => void generateSettingsCoverPrompt()} disabled={settingsCoverPromptBusy || settingsCoverBusy}>{settingsCoverPromptBusy ? "AI 正在分析正文…" : settingsCoverPrompt.trim() ? "重新生成提示词" : "AI 根据正文生成提示词"}</button></div><textarea value={settingsCoverPrompt} maxLength={2000} onChange={(event) => setSettingsCoverPrompt(event.target.value)} placeholder="可以自己填写，也可以让 AI 根据标题和正文生成；生成后仍可修改构图、风格和是否包含文字" /><small>{settingsCoverPrompt.length}/2000 字 · 图片模型只会收到这里最终确认的提示词</small><button type="button" className="secondary-button" onClick={() => void generateSettingsCover()} disabled={settingsCoverBusy || settingsCoverPromptBusy || !settingsCoverPrompt.trim()}>{settingsCoverBusy ? "正在生成封面…" : "使用此提示词生成并设为封面"}</button></details>
          </div>
          <button type="button" onClick={() => void persistArticleSettings()} disabled={busy}>保存发布设置</button>
          <p className="hint">发布时只做完整性检查，不再重复填写账号、作者、摘要和封面。</p>
        </div>}
      </aside>
    </div>
    {coverCropImage && <CoverCropModal image={coverCropImage} onCancel={() => setCoverCropImage(undefined)} onConfirm={(cropped) => void saveCroppedArticleCover(cropped)} />}
  </div>;
}

function CoverCropModal({ image, onCancel, onConfirm }: {
  image: SelectedImage;
  onCancel: () => void;
  onConfirm: (image: SelectedImage) => void;
}) {
  const [sourceAspect, setSourceAspect] = useState(16 / 9);
  const [selection, setSelection] = useState({ x: 10, y: 10, width: 80 });
  const [working, setWorking] = useState(false);
  const interaction = useRef<{ kind: "move" | "resize"; startX: number; startY: number; selection: typeof selection } | undefined>(undefined);
  const source = `data:${image.mimeType};base64,${image.base64}`;
  const selectionHeight = selection.width * sourceAspect / (16 / 9);
  const startInteraction = (event: React.PointerEvent<HTMLDivElement>, kind: "move" | "resize") => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    interaction.current = { kind, startX: event.clientX, startY: event.clientY, selection };
  };
  const moveInteraction = (event: React.PointerEvent<HTMLDivElement>) => {
    const active = interaction.current;
    const stage = event.currentTarget.closest(".crop-stage") as HTMLElement | null;
    if (!active || !stage) return;
    const bounds = stage.getBoundingClientRect();
    const dx = (event.clientX - active.startX) / bounds.width * 100;
    const dy = (event.clientY - active.startY) / bounds.height * 100;
    if (active.kind === "move") {
      const height = active.selection.width * sourceAspect / (16 / 9);
      setSelection({ ...active.selection,
        x: clamp(active.selection.x + dx, 0, 100 - active.selection.width),
        y: clamp(active.selection.y + dy, 0, 100 - height)
      });
    } else {
      const maxByX = 100 - active.selection.x;
      const maxByY = (100 - active.selection.y) * (16 / 9) / sourceAspect;
      const width = clamp(active.selection.width + dx, 20, Math.min(maxByX, maxByY));
      setSelection({ ...active.selection, width });
    }
  };
  const confirm = async () => {
    setWorking(true);
    try {
      onConfirm(await cropImageTo16x9(image, selection.x, selection.y, selection.width, selectionHeight));
    } finally {
      setWorking(false);
    }
  };
  return <div className="modal-backdrop crop-backdrop" role="presentation"><section className="modal-card crop-modal" role="dialog" aria-modal="true" aria-label="裁剪文章封面"><div className="section-heading"><div><p className="eyebrow">16:9 微信封面</p><h2>拖动方框选择封面区域</h2></div></div><div className="crop-stage" style={{ aspectRatio: String(sourceAspect) }}><img src={source} alt="待裁剪封面" onLoad={(event) => {
    const aspect = event.currentTarget.naturalWidth / event.currentTarget.naturalHeight;
    setSourceAspect(aspect);
    const width = Math.min(80, 80 * (16 / 9) / aspect);
    const height = width * aspect / (16 / 9);
    setSelection({ x: (100 - width) / 2, y: (100 - height) / 2, width });
  }} /><div className="crop-shade" /><div className="crop-selection" style={{ left: `${selection.x}%`, top: `${selection.y}%`, width: `${selection.width}%`, height: `${selectionHeight}%` }} onPointerDown={(event) => startInteraction(event, "move")} onPointerMove={moveInteraction} onPointerUp={() => { interaction.current = undefined; }}><span>拖动调整位置</span><div className="crop-resize-handle" onPointerDown={(event) => startInteraction(event, "resize")} onPointerMove={moveInteraction} onPointerUp={() => { interaction.current = undefined; }} /></div></div><p className="hint">拖动蓝色方框调整位置，拖动右下角控制点改变取景范围。确认后生成 1280×720 封面，不修改原图。</p><div className="modal-actions"><button className="secondary-button" onClick={onCancel} disabled={working}>取消</button><button onClick={() => void confirm()} disabled={working}>{working ? "正在裁剪…" : "确认使用此区域"}</button></div></section></div>;
}

async function cropImageTo16x9(image: SelectedImage, x: number, y: number, width: number, height: number): Promise<SelectedImage> {
  const element = new Image();
  element.src = `data:${image.mimeType};base64,${image.base64}`;
  await element.decode();
  const cropWidth = element.naturalWidth * width / 100;
  const cropHeight = element.naturalHeight * height / 100;
  const sourceX = element.naturalWidth * x / 100;
  const sourceY = element.naturalHeight * y / 100;
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前环境无法裁剪图片。");
  context.drawImage(element, sourceX, sourceY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
  return {
    fileName: image.fileName.replace(/\.[^.]+$/, "") + "-cover.jpg",
    mimeType: "image/jpeg",
    base64: canvas.toDataURL("image/jpeg", .9).split(",", 2)[1]
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

async function readImageUrl(url: string, fileName: string): Promise<SelectedImage> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("无法读取所选图片。");
  const blob = await response.blob();
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.onerror = () => reject(new Error("无法读取所选图片。"));
    reader.readAsDataURL(blob);
  });
  return { fileName, mimeType: blob.type || "image/png", base64 };
}

function scrollEditorToHeading(title: string, occurrence: number, markdown: string, mode: "visual" | "markdown"): void {
  if (mode === "markdown") {
    const textarea = document.querySelector<HTMLTextAreaElement>(".markdown-source-editor");
    const match = new RegExp(`^#{1,6}\\s+${escapeRegExp(title)}\\s*$`, "m").exec(markdown);
    if (textarea && match) {
      textarea.focus();
      textarea.setSelectionRange(match.index, match.index + match[0].length);
      const line = markdown.slice(0, match.index).split(/\r?\n/).length - 1;
      textarea.scrollTop = Math.max(0, line * 24 - textarea.clientHeight / 3);
    }
    return;
  }
  const headings = [...document.querySelectorAll<HTMLElement>(".visual-markdown-editor h1, .visual-markdown-editor h2, .visual-markdown-editor h3, .visual-markdown-editor h4, .visual-markdown-editor h5, .visual-markdown-editor h6")]
    .filter((heading) => heading.textContent?.trim() === title.trim());
  const target = headings[Math.min(occurrence, headings.length - 1)] ?? headings[0];
  target?.scrollIntoView({ behavior: "smooth", block: "center" });
  target?.focus({ preventScroll: true });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractMarkdownImages(markdown: string): Array<{ alt: string; src: string }> {
  return [...markdown.matchAll(/!\[([^\]]*)]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)]
    .map((match) => ({ alt: match[1], src: match[2] }));
}

function resolveArticleImageUrl(source: string, assetContextId: string, sourceArticlePath?: string): string {
  if (/^(?:https?:|data:|blob:)/i.test(source)) return source;
  if (sourceArticlePath) {
    return `${apiBase}/content-source/article-resource?path=${encodeURIComponent(sourceArticlePath)}&src=${encodeURIComponent(source)}`;
  }
  if (source.startsWith("contentferry-asset://")) {
    return `${apiBase}/content-assets/${source.slice("contentferry-asset://".length)}`;
  }
  return `${apiBase}/content-assets/${assetContextId}/${source.replace(/^\.?\//, "")}`;
}

function renderPhonePreview(markdown: string, assetContextId: string, sourceArticlePath: string | undefined, articleTitle: string): ReactNode[] {
  const lines = markdown.split(/\r?\n/);
  const firstHeadingIndex = lines.findIndex((line) => /^#\s+/.test(line));
  if (firstHeadingIndex >= 0) {
    const headingTitle = lines[firstHeadingIndex].replace(/^#\s+/, "").replace(/[*_`]/g, "").trim();
    if (headingTitle.localeCompare(articleTitle.trim(), "zh-CN", { sensitivity: "base" }) === 0) {
      lines.splice(firstHeadingIndex, 1);
    }
  }
  const result: ReactNode[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const codeFence = /^\s*```([\w+-]*)\s*$/.exec(line);
    if (codeFence) {
      const language = codeFence[1];
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      result.push(<div className="preview-code-block" key={`code-${index}`}>{language && <small>{language}</small>}<pre><code>{code.join("\n")}</code></pre></div>);
      continue;
    }
    if (!line.trim()) continue;
    if (isPreviewTableRow(line) && isPreviewTableDelimiter(lines[index + 1] ?? "")) {
      const header = splitPreviewTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && isPreviewTableRow(lines[index])) {
        rows.push(splitPreviewTableRow(lines[index]));
        index += 1;
      }
      index -= 1;
      result.push(<div className="preview-table-scroll" key={`table-${index}`}><table><thead><tr>{header.map((cell, cellIndex) => <th key={cellIndex}>{cleanPreviewText(cell)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{header.map((_cell, cellIndex) => <td key={cellIndex}>{cleanPreviewText(row[cellIndex] ?? "")}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    const image = /^!\[([^\]]*)]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/.exec(line.trim());
    if (image) {
      result.push(<img className="preview-article-image" key={index} src={resolveArticleImageUrl(image[2], assetContextId, sourceArticlePath)} alt={image[1] || "文章图片"} />);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      result.push(<h3 key={index}>{cleanPreviewText(heading[2])}</h3>);
      continue;
    }
    result.push(<p key={index}>{renderPreviewInline(line)}</p>);
  }
  return result;
}

function isPreviewTableRow(line: string): boolean {
  return line.includes("|") && /^\s*\|?.+\|.+\|?\s*$/.test(line);
}

function isPreviewTableDelimiter(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitPreviewTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function cleanPreviewText(value: string): string {
  return value.replace(/[*_`>]/g, "");
}

function parseZhuqueReport(value: string): ZhuqueReport | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as ZhuqueReport;
    return parsed && Array.isArray(parsed.segments) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isHighAiDetectionResult(result: string, report?: ZhuqueReport): boolean {
  if (report?.aiPercent != null) return report.aiPercent >= 50;
  if (!result.trim()) return false;
  if (/AI.{0,12}(?:偏高|较高|高风险|疑似)|疑似.{0,8}AI/i.test(result)) return true;
  return [...result.matchAll(/(?:AI[^\n%]{0,30}(\d{1,3}(?:\.\d+)?)\s*%|(\d{1,3}(?:\.\d+)?)\s*%[^\n]{0,30}AI)/gi)]
    .some((match) => Number(match[1] ?? match[2]) >= 50);
}

function ZhuqueReportView({ report }: { report: ZhuqueReport }) {
  const human = report.humanPercent ?? 0;
  const uncertain = report.uncertainPercent ?? 0;
  const humanEnd = Math.min(100, human);
  const uncertainEnd = Math.min(100, human + uncertain);
  const chartStyle = {
    background: `conic-gradient(#bfe8ad 0 ${humanEnd}%, #f5d9a5 ${humanEnd}% ${uncertainEnd}%, #f6bcbc ${uncertainEnd}% 100%)`
  };
  const format = (value: number | null) => value == null ? "未读取" : `${value.toFixed(2)}%`;
  return <section className="zhuque-report" aria-label="腾讯朱雀检测报告">
    <div className="zhuque-segment-panel">
      <div className="zhuque-report-heading"><strong>{report.verdict}</strong><small>{report.ratioSource === "segments" ? "右侧比例按各类彩色分段的非空白字符数计算，并非朱雀网页提供的官方比例。" : "右侧为朱雀网页读取的官方比例；不同底色对应朱雀对各段文字的判断。"}</small></div>
      <div className="zhuque-segments">
        {report.segments.length > 0
          ? report.segments.map((segment, index) => <span className={`zhuque-segment ${segment.kind}`} key={`${index}-${segment.text.slice(0, 12)}`}>{segment.text}</span>)
          : <p className="hint">已读取总体比例，但网页没有提供可识别的分段结果。可在右侧查看比例，或打开原始结果窗口核对。</p>}
      </div>
    </div>
    <aside className="zhuque-ratio-panel">
      <div className="zhuque-donut" style={chartStyle}><span /></div>
      <dl>
        <div className="human"><dt>人工特征</dt><dd>{format(report.humanPercent)}</dd></div>
        <div className="uncertain"><dt>疑似 AI</dt><dd>{format(report.uncertainPercent)}</dd></div>
        <div className="ai"><dt>AI 特征</dt><dd>{format(report.aiPercent)}</dd></div>
      </dl>
    </aside>
  </section>;
}

function renderPreviewInline(value: string): ReactNode[] {
  return value.split(/(`[^`]+`)/g).filter(Boolean).map((part, index) =>
    part.startsWith("`") && part.endsWith("`")
      ? <code className="preview-inline-code" key={index}>{part.slice(1, -1)}</code>
      : <span key={index}>{cleanPreviewText(part)}</span>
  );
}

function QualityWorkspace({
  title,
  review,
  zhuqueReport,
  error,
  saving,
  detecting,
  onChange,
  onBack,
  onAutoDetect,
  onOpenZhuque,
  onOptimize,
  onContinueEditing,
  onReady
}: {
  title: string;
  review: ContentReview | undefined;
  zhuqueReport: ZhuqueReport | undefined;
  error: string;
  saving: boolean;
  detecting: boolean;
  onChange: (review: ContentReview) => void;
  onBack: () => void;
  onAutoDetect: () => void;
  onOpenZhuque: () => void;
  onOptimize: () => void;
  onContinueEditing: () => void;
  onReady: () => void;
}) {
  return <div className="quality-workspace">
    <header className="editor-topbar">
      <button className="secondary-button" onClick={onBack} disabled={saving || detecting}>← 返回文章</button>
      <div className="editor-document-title"><strong>发布前优化：{title}</strong><small>自动检测优先，只有特殊情况才需要人工接管</small></div>
      <div className="editor-top-actions"><button onClick={onReady} disabled={!review || saving || detecting}>内容已准备好</button></div>
    </header>
    <main className="quality-main">
      {error && <p className="error">{error}</p>}
      {!review ? <section className="quality-card"><p>正在准备检测工具…</p></section> : <>
        <section className="quality-card primary">
          <div className="quality-step"><span>1</span><div><h2>腾讯朱雀自动检测</h2><p>文渡自动打开可见浏览器、填入当前正文、触发检测并读取结果。登录状态会保留。</p></div></div>
          <button onClick={onAutoDetect} disabled={detecting}>{detecting ? "正在自动操作朱雀，请稍候…" : review.aiCheckResult ? "重新自动检测" : "开始自动检测"}</button>
          <details><summary>只有自动化无法完成时才需要人工接管</summary><p>遇到登录、验证码或页面变化时，浏览器窗口会保持打开。完成操作后再次点击自动检测即可从当前会话继续。</p><button className="text-button" onClick={onOpenZhuque}>单独打开朱雀网页</button></details>
        </section>
        <section className="quality-card">
          <div className="quality-step"><span>2</span><div><h2>查看结果并决定怎么改</h2><p>自动读取的结果可以修正；系统不会把检测结果当成文章作者身份的最终判定。</p></div></div>
          {zhuqueReport && <ZhuqueReportView report={zhuqueReport} />}
          <label>检测摘要与补充备注<textarea value={review.aiCheckResult} onChange={(event) => onChange({ ...review, aiCheckResult: event.target.value })} placeholder="自动检测完成后会显示总体指标；也可以补充你对结果的判断" /></label>
          {zhuqueReport && <button className="text-button zhuque-original-button" onClick={onOpenZhuque}>查看朱雀原始结果窗口</button>}
          <label>希望 AI 重点修改什么<textarea value={review.notes} onChange={(event) => onChange({ ...review, notes: event.target.value })} placeholder="例如：减少机械分点，增加真实判断，重写开头和总结" /></label>
          <button className="ai-action-button" onClick={onOptimize} disabled={saving || detecting}>{saving ? "AI 正在生成优化稿…" : "让 AI 按检测结果生成可编辑新稿"}</button>
        </section>
        <div className="quality-footer"><button className="secondary-button" onClick={onContinueEditing} disabled={saving || detecting}>保存结果，自己继续修改</button><button onClick={onReady} disabled={saving || detecting}>跳过继续优化，进入发布准备</button></div>
      </>}
    </main>
  </div>;
}

function sourceAssetContextId(relativePath: string): string {
  let hash = 2166136261;
  for (const character of relativePath) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `source-${(hash >>> 0).toString(16)}`;
}

function runtimeLogLevel(level: number): string {
  if (level >= 60) return "严重";
  if (level >= 50) return "错误";
  if (level >= 40) return "警告";
  if (level >= 30) return "信息";
  return "调试";
}

function wechatJobLabel(job: WechatPublishJob): string {
  if (job.status === "draft_ready") return "微信草稿已创建，等待人工预览";
  if (job.status === "failed") return "提交失败，可查看原因后重试";
  if (job.status === "published") return "微信已确认发布完成";
  if (job.status === "cancelled") return "已人工标记为取消发布";
  return job.mode === "mass" ? "群发任务已提交，等待微信回执" : "发布任务已提交，等待微信回执";
}

function ProfileFields({ profile, onChange }: { profile: AccountProfile; onChange: (field: keyof AccountProfile, value: string) => void }) {
  return <><label>账号定位<textarea autoFocus value={profile.positioning} onChange={(event) => onChange("positioning", event.target.value)} placeholder="这个账号长期为谁解决什么问题？" /></label><label>目标读者<textarea value={profile.targetAudience} onChange={(event) => onChange("targetAudience", event.target.value)} placeholder="例如：关注 AI 工具的技术从业者" /></label><label>禁用话题<textarea value={profile.prohibitedTopics} onChange={(event) => onChange("prohibitedTopics", event.target.value)} placeholder="不希望涉及的话题、表达或承诺" /></label><label>写作风格<textarea value={profile.writingStyle} onChange={(event) => onChange("writingStyle", event.target.value)} placeholder="例如：务实、清晰、有案例" /></label><label>常用栏目<textarea value={profile.regularColumns} onChange={(event) => onChange("regularColumns", event.target.value)} placeholder="例如：工具实测、工作流拆解" /></label></>;
}

function Modal({ title, eyebrow, children, onClose, disabled, wide = false, priority = false }: { title: string; eyebrow: string; children: ReactNode; onClose: () => void; disabled: boolean; wide?: boolean; priority?: boolean }) {
  return <div className={`modal-backdrop${priority ? " priority-modal" : ""}`} role="presentation" onMouseDown={() => !disabled && onClose()}><section className={`modal-card${wide ? " wide-modal" : ""}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}><div className="section-heading"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div><button className="text-button" onClick={onClose} disabled={disabled}>关闭</button></div>{children}</section></div>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
