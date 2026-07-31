import { FormEvent, lazy, StrictMode, Suspense, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import wenduLogo from "./assets/wendu-icon.png";
import { locateMarkdownSelection } from "./markdown-selection";
import { HelpCenter } from "./components/HelpCenter";
import { CsdnDraftWorkspace } from "./components/CsdnDraftWorkspace";

export const apiBase = "http://127.0.0.1:4317/api";
const VisualMarkdownEditor = lazy(() =>
  import("./components/VisualMarkdownEditor").then((module) => ({ default: module.VisualMarkdownEditor }))
);
const FirstRunWizard = lazy(() =>
  import("./components/FirstRunWizard").then((module) => ({ default: module.FirstRunWizard }))
);

type AppSettingsContract = {
  schemaVersion: 1;
  dataDir: string;
  firstRunCompleted: boolean;
  aiInitStatus: "not_initialized" | "ready" | "login_required" | "binary_missing";
  codexBinaryPath: string | null;
  auditAiCalls: boolean;
  createdAt: string;
  updatedAt: string;
};

type RootState =
  | { status: "loading" }
  | { status: "wizard"; settings: AppSettingsContract }
  | { status: "ready"; settings: AppSettingsContract };

function Root() {
  const [state, setState] = useState<RootState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void loadSettings().then((settings) => {
      if (cancelled) return;
      if (settings.firstRunCompleted) {
        setState({ status: "ready", settings });
      } else {
        setState({ status: "wizard", settings });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          color: "#64748b",
          fontSize: ".9rem"
        }}
      >
        正在加载文渡…
      </div>
    );
  }

  if (state.status === "wizard") {
    return (
      <Suspense fallback={<div style={{ padding: "3rem" }}>正在准备首次启动…</div>}>
        <FirstRunWizard
          onCompleted={(settings) => {
            setState({ status: "ready", settings });
          }}
        />
      </Suspense>
    );
  }

  return <App />;
}

async function loadSettings(): Promise<AppSettingsContract> {
  // On a clean install the first-run wizard is intentionally shown before
  // the local HTTP service/database starts. Prefer preload IPC there; retain
  // the HTTP fallback for browser-only development.
  if (window.contentFerry?.app) {
    return (await window.contentFerry.app.getSettings()) as AppSettingsContract;
  }
  const response = await fetch(`${apiBase}/app/settings`);
  if (!response.ok) {
    throw new Error(`无法读取应用设置（${response.status}）。`);
  }
  return (await response.json()) as AppSettingsContract;
}

async function patchAppSettings(patch: Partial<AppSettingsContract>): Promise<AppSettingsContract> {
  if (window.contentFerry?.app) {
    return (await window.contentFerry.app.updateSettings(patch)) as AppSettingsContract;
  }
  const response = await fetch(`${apiBase}/app/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch)
  });
  if (!response.ok) {
    throw new Error(`无法保存应用设置（${response.status}）。`);
  }
  return (await response.json()) as AppSettingsContract;
}

type AccountPlatform = "wechat_official" | "csdn";
type AccountProfile = { positioning: string; targetAudience: string; prohibitedTopics: string; writingStyle: string; regularColumns: string };
type MediaAccount = { id: string; platform: AccountPlatform; displayName: string; credentialsConfigured: boolean; profile: AccountProfile };
type ContentSourcePreview = { rootPath: string; articleCount: number; sitePageCount: number; items: Array<{ relativePath: string; title: string | null; frontMatterKeys: string[]; createdAt: string | null }>; truncated: boolean; warnings: string[] };
type ContentSourceArticle = { relativePath: string; title: string | null; markdown: string; frontMatter: string };
type ContentProject = { id: string; targetAccountId: string | null; sourceRelativePath: string | null; topic: string; status: "idea"; briefReady: boolean; researchReady: boolean; outlineReady: boolean; draftReady: boolean; reviewStatus: "pending" | "needs_revision" | "approved" | null };
type ContentBrief = { projectId: string; topic: string; objective: string; audience: string; angle: string; sourceNotes: string; generatedFromAccountProfile: boolean };
type ResearchSource = { id: string; title: string; url: string; excerpt: string; keyClaims: string[]; sourceType: "official" | "public"; retrievedAt: string; selected: boolean };
type ContentResearch = { projectId: string; planMarkdown: string; sources: ResearchSource[]; updatedAt: string | null; provider?: string; model?: string | null };
type TitleSuggestion = { projectId: string; titles: string[]; historicalSeries: Array<{ name: string; count: number; examples: string[] }> };
type ContentOutline = { projectId: string; markdown: string; generatedFromBrief: boolean };
type ContentDraft = { projectId: string; markdown: string; generatedFromOutline: boolean; sourceRelativePath?: string | null };
type ContentReview = { projectId: string; status: "pending" | "needs_revision" | "approved"; factChecked: boolean; accountFitChecked: boolean; aiCheckResult: string; notes: string };
type WechatPublishJob = {
  id: string; accountId: string; projectId: string | null; sourceRelativePath: string | null; mode: "draft" | "publish" | "mass"; title: string;
  draftMediaId: string | null; publishId: string | null; messageId: string | null;
  status: "draft_ready" | "browser_editing" | "submitted" | "published" | "failed" | "cancelled"; errorMessage: string | null;
  statusSource: "system" | "wechat" | "browser" | "manual"; statusNote: string | null;
  declareOriginal: boolean; enableReward: boolean; collectionName: string; updatedAt: string;
};
type CsdnChannelDraft = {
  id: string; accountId: string; projectId: string | null; sourceRelativePath: string; sourceHash: string;
  generationMode: "rewrite" | "source"; title: string; markdown: string; author: string; digest: string; coverSource: string;
  status: "draft" | "approved" | "superseded"; updatedAt: string;
};
type CsdnPublishJob = {
  id: string; accountId: string; channelDraftId: string;
  status: "queued" | "needs_login" | "filling" | "needs_user" | "ready_for_final_confirmation" | "submitting" | "published" | "needs_manual_reconciliation" | "failed_before_submit" | "failed" | "cancelled";
  statusNote: string | null; errorMessage: string | null;
  remoteUrl: string | null; remoteContentId: string | null;
  updatedAt: string;
};
type ChannelAction =
  | { kind: "enter"; label: string; onClick: () => void }
  | { kind: "generate"; label: string; onClick: () => void }
  | { kind: "continue"; label: string; onClick: () => void };
type ChannelRow = {
  platform: AccountPlatform;
  label: string;
  statusLabel: string;
  tone: "neutral" | "info" | "success" | "warning";
  action: ChannelAction;
};
type WechatCredentialStatus = { appId: string; appSecretConfigured: boolean; callbackTokenConfigured: boolean; localCallbackUrl: string };
type WechatMaterial = { mediaId: string; name: string; updatedAt: string; url: string | null };
type SelectedImage = { fileName: string; mimeType: string; base64: string };
type ArticleSettings = {
  author: string;
  digest: string;
  coverSource: string;
  coverPrompt: string;
  accountId: string;
  needOpenComment: boolean;
  onlyFansCanComment: boolean;
  declareOriginal: boolean;
  enableReward: boolean;
  collectionName: string;
};
type ModelProviderId = "openai_codex" | "openai" | "openrouter" | "nous" | "nvidia_build" | "github_copilot" | "modelscope" | "agnes";
type ModelConnection = {
  provider: ModelProviderId; displayName: string; modelId: string; baseUrl: string; proxyUrl: string;
  enabled: boolean; builtInSearch: boolean; credentialConfigured: boolean;
};
type WebSearchSettings = {
  tavilyConfigured: boolean;
  tavilyCredentialSource: "local" | "environment" | "none";
  researchProxyUrl: string;
};
type ManagedSkill = {
  id: string; name: string; description: string; category: "创作" | "改写" | "检测" | "图片" | "研究";
  enabled: boolean; provider: ModelProviderId | null; markdown: string; filePath: string;
  files: Array<{ relativePath: string; size: number }>;
};
type SkillFileContent = { relativePath: string; content: string; size: number };
type ArticleChatSuggestion = { original: string; replacement: string; reason: string; status?: "pending" | "accepted" | "rejected" | "unavailable" };
type ArticleChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  memorySuggestion: string;
  suggestions: ArticleChatSuggestion[];
  createdAt: string;
  deliveryState?: "sending" | "failed";
};
type ZhuqueReport = {
  verdict: string;
  humanPercent: number | null;
  uncertainPercent: number | null;
  aiPercent: number | null;
  ratioSource: "official" | "segments";
  segments: Array<{ text: string; kind: "human" | "uncertain" | "ai" }>;
};
type ContentAnyReference = { label: string; score: string | null; summary: string; detail: string };
type RuntimeLogEntry = {
  time: number | null; level: number; message: string; requestId: string; method: string; url: string;
  statusCode: number | null; responseTime: number | null; error: string;
};
type RuntimeLogResponse = {
  filePath: string; items: RuntimeLogEntry[]; availableDates?: string[];
  totalMatched: number; hasMore: boolean; sourceTruncated: boolean; readWindowBytes: number;
};

const emptyProfile: AccountProfile = { positioning: "", targetAudience: "", prohibitedTopics: "", writingStyle: "", regularColumns: "" };

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
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

async function streamGeneration<T>(path: string, signal: AbortSignal, onEvent: (event: string, data: Record<string, unknown>) => void, body?: string): Promise<T> {
  try {
    const response = await fetch(`${apiBase}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: body ?? "{}", signal });
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
  } catch (cause) {
    if (signal.aborted) throw new Error("已停止本次 AI 生成。");
    const message = cause instanceof Error ? cause.message : "";
    if (/BodyStreamBuffer was aborted|stream.*aborted|networkerror/i.test(message)) {
      throw new Error("生成过程中的本地连接被中断，可能是文渡正在重启。请等待窗口稳定后重试。");
    }
    throw cause;
  }
}

export const platformName = (platform: AccountPlatform) => platform === "wechat_official" ? "微信公众号" : "CSDN";
const providerName = (provider: ModelProviderId | null) => provider === null ? "无需模型" : ({
  openai_codex: "OpenAI Codex",
  openai: "OpenAI API",
  openrouter: "OpenRouter",
  nous: "Nous Research Portal",
  nvidia_build: "NVIDIA Build",
  github_copilot: "GitHub Copilot",
  modelscope: "ModelScope",
  agnes: "Agnes AI"
} as Record<ModelProviderId, string>)[provider];

/** Returns the model status label shown on a skill card. Detection skills genuinely
 *  need no model; every other category requires one, so null means "not selected". */
const skillModelStatus = (skill: ManagedSkill) => {
  if (skill.category === "检测") return providerName(null);
  if (skill.provider === null) return "未选择模型";
  return providerName(skill.provider);
};

function markdownTitle(markdown: string): string | undefined {
  return markdown.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim() || undefined;
}

function App() {
  const [accounts, setAccounts] = useState<MediaAccount[]>([]);
  const [projects, setProjects] = useState<ContentProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState<AppSettingsContract | null>(null);
  useEffect(() => {
    void loadSettings().then(setSettings).catch(() => {});
  }, []);
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
  const [projectTitle, setProjectTitle] = useState("");
  const [projectAccountId, setProjectAccountId] = useState("");
  const [projectObjective, setProjectObjective] = useState("");
  const [projectAudience, setProjectAudience] = useState("");
  const [projectAngle, setProjectAngle] = useState("");
  const [projectSourceNotes, setProjectSourceNotes] = useState("");
  const [briefProject, setBriefProject] = useState<ContentProject>();
  const [brief, setBrief] = useState<ContentBrief>();
  const briefRequestVersionRef = useRef(0);
  const titleSuggestionAbortRef = useRef<AbortController | undefined>(undefined);
  const [briefTitle, setBriefTitle] = useState("");
  const [titleSuggestions, setTitleSuggestions] = useState<string[]>([]);
  const [historicalSeries, setHistoricalSeries] = useState<TitleSuggestion["historicalSeries"]>([]);
  const [titleSuggesting, setTitleSuggesting] = useState(false);
  const [outlineProject, setOutlineProject] = useState<ContentProject>();
  const [outline, setOutline] = useState<ContentOutline>();
  const [outlineGenerating, setOutlineGenerating] = useState(false);
  const [outlineGenerationStatus, setOutlineGenerationStatus] = useState("");
  const outlineAbortRef = useRef<AbortController | undefined>(undefined);
  const [outlineEditorMode, setOutlineEditorMode] = useState<"visual" | "markdown">("visual");
  const [outlineModeScrollOffset, setOutlineModeScrollOffset] = useState(0);
  const outlineMarkdownSourceRef = useRef<HTMLTextAreaElement | null>(null);
  const [researchProject, setResearchProject] = useState<ContentProject>();
  const [research, setResearch] = useState<ContentResearch>();
  const [researchGenerating, setResearchGenerating] = useState(false);
  const [researchFollowUp, setResearchFollowUp] = useState("");
  const [researchFollowingUp, setResearchFollowingUp] = useState(false);
  const [researchStatus, setResearchStatus] = useState("");
  const [researchError, setResearchError] = useState("");
  const [draftProject, setDraftProject] = useState<ContentProject>();
  const [draft, setDraft] = useState<ContentDraft>();
  const [draftGenerating, setDraftGenerating] = useState(false);
  const [draftGenerationStatus, setDraftGenerationStatus] = useState("");
  const draftAbortRef = useRef<AbortController | undefined>(undefined);
  const [reviewProject, setReviewProject] = useState<ContentProject>();
  const [review, setReview] = useState<ContentReview>();
  const [zhuqueReport, setZhuqueReport] = useState<ZhuqueReport>();
  const [zhuqueRunning, setZhuqueRunning] = useState(false);
  const [activeView, setActiveView] = useState<"dashboard" | "library" | "publish" | "skills" | "accounts" | "logs" | "help">("dashboard");
  // The audit directory's separator format is decided by the main process
  // (path.join) and surfaced via GET /api/app/audit-log, so the displayed path
  // is always correct for the current OS instead of hard-coding "/".
  const [auditDir, setAuditDir] = useState("");
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
  const [correctingCsdnJob, setCorrectingCsdnJob] = useState<CsdnPublishJob>();
  const [correctedCsdnStatus, setCorrectedCsdnStatus] = useState<"published" | "failed" | "cancelled">("published");
  const [csdnStatusReason, setCsdnStatusReason] = useState("");
  const [csdnCorrectionSaving, setCsdnCorrectionSaving] = useState(false);
  const [csdnCorrectionError, setCsdnCorrectionError] = useState("");
  const [csdnDraftSource, setCsdnDraftSource] = useState<ContentSourceArticle>();
  const [csdnDraftAccountId, setCsdnDraftAccountId] = useState("");
  const [csdnDraftGenerationMode, setCsdnDraftGenerationMode] = useState<"rewrite" | "source">("rewrite");
  const [csdnDraft, setCsdnDraft] = useState<CsdnChannelDraft>();
  const [csdnDraftSaving, setCsdnDraftSaving] = useState(false);
  const [csdnPublishJob, setCsdnPublishJob] = useState<CsdnPublishJob>();
  const [csdnDrafts, setCsdnDrafts] = useState<CsdnChannelDraft[]>([]);
  const [csdnJobs, setCsdnJobs] = useState<CsdnPublishJob[]>([]);
  const [csdnEntryChoices, setCsdnEntryChoices] = useState<Array<{ draft: CsdnChannelDraft; accountName: string; job?: CsdnPublishJob }> | null>(null);
  const [publishProject, setPublishProject] = useState<ContentProject>();
  const [publishSource, setPublishSource] = useState<ContentSourceArticle>();
  const [publishAccountId, setPublishAccountId] = useState("");
  const [publishAuthor, setPublishAuthor] = useState("");
  const [publishDigest, setPublishDigest] = useState("");
  const [publishNeedOpenComment, setPublishNeedOpenComment] = useState(true);
  const [publishOnlyFansCanComment, setPublishOnlyFansCanComment] = useState(false);
  const [publishDeclareOriginal, setPublishDeclareOriginal] = useState(false);
  const [publishEnableReward, setPublishEnableReward] = useState(false);
  const [publishCollectionName, setPublishCollectionName] = useState("");
  const [publishThumbMediaId, setPublishThumbMediaId] = useState("");
  const [publishCoverSource, setPublishCoverSource] = useState("");
  const [publishCoverPreview, setPublishCoverPreview] = useState("");
  const [publishCoverLabel, setPublishCoverLabel] = useState("");
  const [wechatMaterials, setWechatMaterials] = useState<WechatMaterial[]>([]);
  const [modelScopePrompt, setModelScopePrompt] = useState("");
  const [coverGenerating, setCoverGenerating] = useState(false);
  const [skills, setSkills] = useState<ManagedSkill[]>([]);
  const [batchModelByGroup, setBatchModelByGroup] = useState<Record<string, ModelProviderId | null>>({});
  const [batchSaving, setBatchSaving] = useState(false);
  const [selectedSkillIds, setSelectedSkillIds] = useState<Record<string, boolean>>({});
  const skillModelGroups = [
    { key: "text", title: "文本类技能", description: "依赖文本大模型（OpenAI 系列）", match: (c: ManagedSkill["category"]) => c === "创作" || c === "改写" || c === "研究", providers: ["openai_codex", "openai", "openrouter", "nous", "nvidia_build", "github_copilot"] as ModelProviderId[] },
    { key: "image", title: "图像类技能", description: "依赖图像大模型（ModelScope / Agnes AI）", match: (c: ManagedSkill["category"]) => c === "图片", providers: ["modelscope", "agnes"] as ModelProviderId[] },
    { key: "none", title: "无模型技能", description: "走浏览器自动化，不需要大模型连接", match: (c: ManagedSkill["category"]) => c === "检测" }
  ];
  const [modelConnections, setModelConnections] = useState<ModelConnection[]>([]);
  const [webSearchSettings, setWebSearchSettings] = useState<WebSearchSettings>({ tavilyConfigured: false, tavilyCredentialSource: "none", researchProxyUrl: "" });
  const [editingSkill, setEditingSkill] = useState<ManagedSkill>();
  const [editingSkillFile, setEditingSkillFile] = useState<SkillFileContent>();
  const [savedSkillFileContent, setSavedSkillFileContent] = useState("");
  const [editingConnection, setEditingConnection] = useState<ModelConnection>();
  const [connectionCredential, setConnectionCredential] = useState("");
  const [tavilyModalOpen, setTavilyModalOpen] = useState(false);
  const [tavilyApiKey, setTavilyApiKey] = useState("");
  const [tavilySaving, setTavilySaving] = useState(false);
  const [tavilyTesting, setTavilyTesting] = useState(false);
  const [tavilyError, setTavilyError] = useState("");
  const [tavilyTestResult, setTavilyTestResult] = useState("");
  const [researchProxyUrl, setResearchProxyUrl] = useState("");
  const [researchProxyInput, setResearchProxyInput] = useState("");
  const [researchProxySaving, setResearchProxySaving] = useState(false);
  const [researchProxyError, setResearchProxyError] = useState("");
  const [researchProxyModalOpen, setResearchProxyModalOpen] = useState(false);
  const [coverProvider, setCoverProvider] = useState<"modelscope" | "agnes">("modelscope");
  const [publishCropImage, setPublishCropImage] = useState<SelectedImage>();
  const [publishCheckMarkdown, setPublishCheckMarkdown] = useState("");
  const [publishAiCheckResult, setPublishAiCheckResult] = useState("");
  const [publishZhuqueReport, setPublishZhuqueReport] = useState<ZhuqueReport>();
  const [publishAiCheckTool, setPublishAiCheckTool] = useState<"zhuque" | "contentany">();
  const [publishAiOverrideReason, setPublishAiOverrideReason] = useState("");
  const publishAiOverrideReasonDirtyRef = useRef(false);
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
  const refreshSourcePreview = async () => {
    const source = await request<{ rootPath: string | null }>("/content-source");
    if (!source.rootPath) { setSourcePreview(undefined); return; }
    setSourcePath(source.rootPath);
    setSourcePreview(await request<ContentSourcePreview>("/content-source/preview"));
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
  const loadCsdnChannelDrafts = async () => {
    try {
      const [drafts, jobs] = await Promise.all([
        request<{ items: CsdnChannelDraft[] }>("/integrations/csdn/channel-drafts"),
        request<{ items: CsdnPublishJob[] }>("/integrations/csdn/jobs")
      ]);
      setCsdnDrafts(drafts.items);
      setCsdnJobs(jobs.items);
    } catch {
      /* 读取失败时不阻塞内容库，按钮仍可作为“生成 CSDN 稿”使用。 */
    }
  };
  const openCsdnChannelDraft = async (relativePath: string) => {
    const csdnAccounts = accounts.filter((account) => account.platform === "csdn");
    if (csdnAccounts.length === 0) {
      setError("请先在“账号”中添加一个 CSDN 账号，再创建 CSDN 渠道稿。");
      return;
    }
    try {
      const [article, drafts, jobs] = await Promise.all([
        request<ContentSourceArticle>(`/content-source/article?path=${encodeURIComponent(relativePath)}`),
        request<{ items: CsdnChannelDraft[] }>("/integrations/csdn/channel-drafts"),
        request<{ items: CsdnPublishJob[] }>("/integrations/csdn/jobs")
      ]);
      setCsdnDrafts(drafts.items);
      setCsdnJobs(jobs.items);
      const existing = drafts.items.filter((candidate) => candidate.sourceRelativePath === relativePath);
      if (existing.length === 0) {
        setCsdnDraftSource(article);
        setCsdnDraftAccountId(csdnAccounts[0].id);
        setCsdnDraftGenerationMode("rewrite");
        setCsdnDraft(undefined);
        setCsdnPublishJob(undefined);
        setError("");
        return;
      }
      setCsdnDraftSource(article);
      setCsdnEntryChoices(existing.map((draft) => ({
        draft,
        accountName: csdnAccounts.find((account) => account.id === draft.accountId)?.displayName ?? "CSDN 账号",
        job: jobs.items.find((job) => job.channelDraftId === draft.id)
      })));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法打开 CSDN 渠道稿。");
    }
  };
  const openExistingCsdnDraft = (choice: { draft: CsdnChannelDraft; job?: CsdnPublishJob }) => {
    setCsdnDraft(choice.draft);
    setCsdnPublishJob(choice.job);
    setCsdnDraftSource(undefined);
    setCsdnEntryChoices(null);
    setError("");
  };
  const channelRowsFor = (item: { relativePath: string; title?: string | null }): ChannelRow[] => {
    const rows: ChannelRow[] = [];
    const wechatJob = bestWechatJob(wechatJobs, (entry) => entry.sourceRelativePath === item.relativePath || entry.title === item.title);
    if (accounts.some((account) => account.platform === "wechat_official")) {
      if (wechatJob) {
        switch (wechatJob.status) {
          case "draft_ready":
            rows.push({ platform: "wechat_official", label: "微信公众号", statusLabel: "草稿待发布", tone: "info", action: { kind: "continue", label: "继续发布", onClick: () => setActiveView("publish") } });
            break;
          case "submitted":
            rows.push({ platform: "wechat_official", label: "微信公众号", statusLabel: "微信处理中", tone: "neutral", action: { kind: "enter", label: "查看进度", onClick: () => setActiveView("publish") } });
            break;
          case "published":
            rows.push({ platform: "wechat_official", label: "微信公众号", statusLabel: "已发布", tone: "success", action: { kind: "enter", label: "查看", onClick: () => setActiveView("publish") } });
            break;
          case "cancelled":
            rows.push({ platform: "wechat_official", label: "微信公众号", statusLabel: "已取消发布", tone: "warning", action: { kind: "generate", label: "重新设置并发布", onClick: () => void openSourceArticle(item.relativePath, "settings") } });
            break;
          default:
            rows.push({ platform: "wechat_official", label: "微信公众号", statusLabel: "发布失败", tone: "warning", action: { kind: "generate", label: "重新设置", onClick: () => void openSourceArticle(item.relativePath, "settings") } });
        }
      } else {
        rows.push({ platform: "wechat_official", label: "微信公众号", statusLabel: "未发布", tone: "neutral", action: { kind: "generate", label: "设置并发布", onClick: () => void openSourceArticle(item.relativePath, "settings") } });
      }
    }
    if (accounts.some((account) => account.platform === "csdn")) {
      const csdnExisting = csdnDrafts.find((candidate) => candidate.sourceRelativePath === item.relativePath);
      if (csdnExisting) {
        rows.push({
          platform: "csdn", label: "CSDN",
          statusLabel: csdnExisting.status === "approved" ? "已冻结" : "草稿",
          tone: csdnExisting.status === "approved" ? "success" : "neutral",
          action: { kind: "enter", label: "进入 CSDN 稿", onClick: () => void openCsdnChannelDraft(item.relativePath) }
        });
      } else {
        rows.push({ platform: "csdn", label: "CSDN", statusLabel: "未生成", tone: "neutral", action: { kind: "generate", label: "生成 CSDN 稿", onClick: () => void openCsdnChannelDraft(item.relativePath) } });
      }
    }
    return rows;
  };
  const generateCsdnChannelDraft = async () => {
    if (!csdnDraftSource || !csdnDraftAccountId) return;
    setCsdnDraftSaving(true);
    try {
      const draft = await request<CsdnChannelDraft>("/integrations/csdn/channel-drafts", {
        method: "POST",
        body: JSON.stringify({ accountId: csdnDraftAccountId, relativePath: csdnDraftSource.relativePath, generationMode: csdnDraftGenerationMode })
      });
      setCsdnDraft(draft);
      setError("");
      void loadCsdnChannelDrafts();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "生成 CSDN 渠道稿失败。");
    } finally {
      setCsdnDraftSaving(false);
    }
  };
  const saveCsdnChannelDraft = async () => {
    if (!csdnDraft) return;
    setCsdnDraftSaving(true);
    try {
      const saved = await request<CsdnChannelDraft>(`/integrations/csdn/channel-drafts/${csdnDraft.id}`, {
        method: "PUT",
        body: JSON.stringify({ title: csdnDraft.title, markdown: csdnDraft.markdown, author: csdnDraft.author, digest: csdnDraft.digest, coverSource: csdnDraft.coverSource })
      });
      setCsdnDraft(saved);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存 CSDN 渠道稿失败。");
    } finally {
      setCsdnDraftSaving(false);
    }
  };
  const approveCsdnChannelDraft = async () => {
    if (!csdnDraft) return;
    setCsdnDraftSaving(true);
    try {
      const saved = await request<CsdnChannelDraft>(`/integrations/csdn/channel-drafts/${csdnDraft.id}`, {
        method: "PUT",
        body: JSON.stringify({ title: csdnDraft.title, markdown: csdnDraft.markdown, author: csdnDraft.author, digest: csdnDraft.digest, coverSource: csdnDraft.coverSource })
      });
      const approved = await request<CsdnChannelDraft>(`/integrations/csdn/channel-drafts/${saved.id}/approve`, { method: "POST" });
      setCsdnDraft(approved);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "冻结 CSDN 渠道稿失败。");
    } finally {
      setCsdnDraftSaving(false);
    }
  };
  const createCsdnPublishJob = async () => {
    if (!csdnDraft) return;
    setCsdnDraftSaving(true);
    try {
      const job = await request<CsdnPublishJob>(`/integrations/csdn/channel-drafts/${csdnDraft.id}/jobs`, { method: "POST" });
      setCsdnPublishJob(job);
      setError("");
      void loadCsdnChannelDrafts();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建 CSDN 发布任务失败。");
    } finally {
      setCsdnDraftSaving(false);
    }
  };
  const startCsdnBrowserAssist = async (jobId: string) => {
    setCsdnDraftSaving(true);
    try {
      const assistedJob = await request<CsdnPublishJob>(`/integrations/csdn/jobs/${jobId}/browser-assist`, { method: "POST" });
      setCsdnPublishJob(assistedJob);
      if (!window.contentFerry) throw new Error("CSDN 浏览器发布只能在文渡桌面应用中打开。");
      await window.contentFerry.openCsdnPublisher(jobId);
      await loadCsdnChannelDrafts();
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法启动 CSDN 浏览器发布流程。");
    } finally {
      setCsdnDraftSaving(false);
    }
  };
  const confirmCsdnPublish = async (jobId: string) => {
    setCsdnDraftSaving(true);
    try {
      const job = await request<CsdnPublishJob>(`/integrations/csdn/jobs/${jobId}/confirm`, { method: "POST" });
      setCsdnPublishJob(job);
      await loadCsdnChannelDrafts();
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法确认 CSDN 发布结果。");
    } finally {
      setCsdnDraftSaving(false);
    }
  };
  const correctCsdnStatus = async (jobId: string, status: "published" | "failed" | "cancelled", reason: string) => {
    setCsdnDraftSaving(true);
    try {
      const job = await request<CsdnPublishJob>(`/integrations/csdn/jobs/${jobId}/status`, {
        method: "POST",
        body: JSON.stringify({ status, reason: reason.trim() })
      });
      setCsdnPublishJob(job);
      await loadCsdnChannelDrafts();
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法校正 CSDN 发布状态。");
    } finally {
      setCsdnDraftSaving(false);
    }
  };
  const openCsdnStatusCorrection = (job: CsdnPublishJob) => {
    setCorrectingCsdnJob(job);
    setCorrectedCsdnStatus("published");
    setCsdnStatusReason("已在 CSDN 后台核实");
    setCsdnCorrectionError("");
  };
  const saveCsdnStatusCorrection = async (event: FormEvent) => {
    event.preventDefault();
    if (!correctingCsdnJob) {
      setCsdnCorrectionError("核实依据不能超过 500 个字。");
      return;
    }
    const action = correctedCsdnStatus === "published" ? "已发布" : correctedCsdnStatus === "cancelled" ? "取消发布" : "发布失败";
    if (!window.confirm(`确定将 CSDN 发布任务人工标记为“${action}”吗？\n\n此操作只校正文渡中的记录，不会调用 CSDN 接口，也不会重新发布。`)) return;
    setCsdnCorrectionSaving(true);
    try {
      await correctCsdnStatus(correctingCsdnJob.id, correctedCsdnStatus, csdnStatusReason);
      setCorrectingCsdnJob(undefined);
      setCsdnStatusReason("");
      setCsdnCorrectionError("");
    } catch (cause) {
      setCsdnCorrectionError(cause instanceof Error ? cause.message : "人工校正 CSDN 发布状态失败。");
    } finally {
      setCsdnCorrectionSaving(false);
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
      const [skillResult, connectionResult, searchSettingsResult] = await Promise.all([
        request<{ items: ManagedSkill[] }>("/skills"),
        request<{ items: ModelConnection[] }>("/model-connections"),
        request<WebSearchSettings>("/web-search/settings")
      ]);
      setSkills(skillResult.items);
      setModelConnections(connectionResult.items);
      setWebSearchSettings(searchSettingsResult);
      setResearchProxyUrl(searchSettingsResult.researchProxyUrl ?? "");
      const coverSkill = skillResult.items.find((skill) => skill.id === "cover-generation");
      if (coverSkill?.provider === "modelscope" || coverSkill?.provider === "agnes") setCoverProvider(coverSkill.provider);
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
  useEffect(() => {
    if (activeView === "publish" || activeView === "dashboard" || activeView === "library") void loadWechatJobs();
    if (activeView === "publish" || activeView === "library") { void refreshSourcePreview().catch(() => undefined); void loadCsdnChannelDrafts(); }
  }, [activeView]);
  useEffect(() => { if (activeView === "skills") void loadSkillsAndConnections(); }, [activeView]);
  useEffect(() => {
    if (activeView !== "skills") return;
    void request<{ directory: string; enabled: boolean }>("/app/audit-log")
      .then((result) => setAuditDir(result.directory))
      .catch(() => setAuditDir(""));
  }, [activeView]);
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

  const openProjectCreator = () => {
    setProjectAccountId(accounts.length === 1 ? accounts[0].id : "");
    setProjectModalOpen(true);
  };

  const closeBrief = () => {
    briefRequestVersionRef.current += 1;
    titleSuggestionAbortRef.current?.abort();
    titleSuggestionAbortRef.current = undefined;
    setTitleSuggesting(false);
    setBriefProject(undefined);
    setBrief(undefined);
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
    const topic = projectTopic.trim();
    const title = projectTitle.trim();
    const targetAccountId = projectAccountId.trim();
    const objective = projectObjective.trim();
    if (!topic) { setError("请先填写文章主题或想法。"); return; }
    if (topic.length > 12000) { setError("文章主题或想法不能超过 12000 个字符，请拆分资料后再创建。"); return; }
    if (title.length > 120) { setError("文章标题不能超过 120 个字符，请精简后再创建。"); return; }
    if (targetAccountId && !accounts.some((account) => account.id === targetAccountId)) {
      setError("所选发布账号已不存在或刚被修改，请关闭后重新打开“新建文章”再选择。");
      return;
    }
    setSaving(true);
    try {
      const project = await request<ContentProject>("/content-projects", { method: "POST", body: JSON.stringify({ topic, objective, audience: projectAudience.trim(), angle: projectAngle.trim(), sourceNotes: projectSourceNotes.trim(), ...(title ? { title } : {}), ...(targetAccountId ? { targetAccountId } : {}) }) });
      setProjectTopic(""); setProjectTitle(""); setProjectAccountId("");
      setProjectObjective(""); setProjectAudience(""); setProjectAngle(""); setProjectSourceNotes("");
      setProjectModalOpen(false);
      await loadProjects();
      await openResearch(project, true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "内容项目创建失败。"); }
    finally { setSaving(false); }
  };
  const deleteProjectDraft = async (project: ContentProject) => {
    const relativePath = project.sourceRelativePath ?? "对应的 VitePress 文章目录";
    const publishJob = wechatJobs.find((job) => job.projectId === project.id || job.sourceRelativePath === project.sourceRelativePath || job.title === project.topic);
    const publishedNotice = publishJob
      ? "\n\n微信公众号中的草稿、已提交任务或已发布文章不会被撤回；文渡会保留微信发布记录。"
      : "";
    const csdnNotice = "\n\n与本文关联的 CSDN 渠道稿（含其本地图片）也会被一并删除，无法恢复。";
    if (!window.confirm(`确定删除本地文章“${project.topic}”吗？\n\n将永久删除 VitePress 文章目录：\n${relativePath}${publishedNotice}${csdnNotice}\n\n此操作不能撤销。`)) return;
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
    const requestVersion = ++briefRequestVersionRef.current;
    titleSuggestionAbortRef.current?.abort();
    setTitleSuggesting(false);
    setBriefProject(project);
    setBrief(undefined);
    setBriefTitle(project.topic);
    setTitleSuggestions([]);
    setHistoricalSeries([]);
    try {
      const [loadedBrief, article] = await Promise.all([
        request<ContentBrief>(`/content-projects/${project.id}/brief`),
        project.sourceRelativePath
          ? request<ContentSourceArticle>(`/content-source/article?path=${encodeURIComponent(project.sourceRelativePath)}`)
          : Promise.resolve(undefined)
      ]);
      if (briefRequestVersionRef.current !== requestVersion) return;
      setBrief(loadedBrief);
      setBriefTitle(article?.title ?? project.topic);
    }
    catch (cause) {
      if (briefRequestVersionRef.current !== requestVersion) return;
      setError(cause instanceof Error ? cause.message : "无法读取创作简报。");
      closeBrief();
    }
  };

  const saveBrief = async (event: FormEvent) => {
    event.preventDefault();
    if (!briefProject || !brief) return;
    setSaving(true);
    try {
      await request<ContentBrief>(`/content-projects/${briefProject.id}/brief`, { method: "PUT", body: JSON.stringify({ topic: brief.topic, objective: brief.objective, audience: brief.audience, angle: brief.angle, sourceNotes: brief.sourceNotes }) });
      if (briefTitle.trim() && briefTitle.trim() !== briefProject.topic) {
        await request<ContentProject>(`/content-projects/${briefProject.id}/title`, { method: "PUT", body: JSON.stringify({ title: briefTitle.trim() }) });
      }
      closeBrief();
      await Promise.all([loadProjects(), refreshSourcePreview()]);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "创作简报保存失败。"); }
    finally { setSaving(false); }
  };
  const suggestBriefTitles = async () => {
    if (!briefProject) return;
    titleSuggestionAbortRef.current?.abort();
    const controller = new AbortController();
    titleSuggestionAbortRef.current = controller;
    setTitleSuggestions([]);
    setHistoricalSeries([]);
    setTitleSuggesting(true);
    try {
      const suggested = await request<TitleSuggestion>(`/content-projects/${briefProject.id}/title/suggest`, {
        method: "POST",
        body: JSON.stringify({ topic: brief?.topic ?? briefProject.topic, objective: brief?.objective ?? "", audience: brief?.audience ?? "", angle: brief?.angle ?? "", sourceNotes: brief?.sourceNotes ?? "" }),
        signal: controller.signal
      });
      setTitleSuggestions(suggested.titles);
      setHistoricalSeries(suggested.historicalSeries);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : "无法推荐文章标题。");
    } finally {
      if (titleSuggestionAbortRef.current === controller) {
        titleSuggestionAbortRef.current = undefined;
        setTitleSuggesting(false);
      }
    }
  };
  const changeBrief = (field: keyof Omit<ContentBrief, "projectId" | "generatedFromAccountProfile">, value: string) => setBrief((current) => current ? { ...current, [field]: value } : current);
  const openResearch = async (project: ContentProject, generate = false) => {
    setResearchProject(project);
    setResearch(undefined);
    setResearchFollowUp("");
    setResearchError("");
    try {
      if (generate) {
        setResearchGenerating(true);
        setResearchStatus("阿文正在检索官方与公开网页，并整理可追溯资料卡…");
        const research = await streamGeneration<ContentResearch>(`/content-projects/${project.id}/research/generate`, new AbortController().signal, (event, data) => {
          if (event === "status") setResearchStatus(String((data as { message?: string }).message ?? "阿文正在补研…"));
          if (event === "complete") setResearch(data as unknown as ContentResearch);
        });
        setResearch(research);
        setResearchStatus("");
        await loadProjects();
      } else {
        setResearch(await request<ContentResearch>(`/content-projects/${project.id}/research`));
      }
    } catch (cause) {
      setResearchError(cause instanceof Error ? cause.message : "联网补研失败。");
    } finally {
      setResearchGenerating(false);
      setResearchStatus("");
    }
  };
  const toggleResearchSource = async (source: ResearchSource) => {
    if (!researchProject) return;
    try {
      const next = await request<ContentResearch>(`/content-projects/${researchProject.id}/research/sources/${source.id}`, {
        method: "PATCH", body: JSON.stringify({ selected: !source.selected })
      });
      setResearch(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "资料卡更新失败。");
    }
  };
  const continueResearch = async () => {
    if (!researchProject || !researchFollowUp.trim() || researchFollowingUp) return;
    setResearchFollowingUp(true);
    setResearchError("");
    setResearchStatus("阿文正在针对你的补充继续联网补研…");
    try {
      const next = await streamGeneration<ContentResearch>(`/content-projects/${researchProject.id}/research/follow-up`, new AbortController().signal, (event, data) => {
        if (event === "status") setResearchStatus(String((data as { message?: string }).message ?? "阿文正在补研…"));
        if (event === "complete") setResearch(data as unknown as ContentResearch);
      }, JSON.stringify({ message: researchFollowUp.trim() }));
      setResearch(next);
      setResearchFollowUp("");
      setResearchStatus("");
      await loadProjects();
    } catch (cause) {
      setResearchError(cause instanceof Error ? cause.message : "补充资料失败。请检查模型连接后重试。");
    } finally {
      setResearchFollowingUp(false);
      setResearchStatus("");
    }
  };
  const generateOutline = async (project: ContentProject) => {
    setOutlineProject(project); setOutline(undefined); setSaving(false); setOutlineGenerationStatus("正在准备生成任务…");
    try {
      const controller = new AbortController();
      outlineAbortRef.current = controller;
      setOutlineGenerating(true);
      setOutline({ projectId: project.id, markdown: "", generatedFromBrief: true });
      const generated = await streamGeneration<ContentOutline>(`/content-projects/${project.id}/outline/generate/stream`, controller.signal, (event, data) => {
        if (event === "delta") setOutline((current) => current ? { ...current, markdown: String(data.markdown ?? "") } : current);
        if (event === "status") setOutlineGenerationStatus(String(data.message ?? "AI 正在生成…"));
      });
      setOutline(generated);
    }
    catch (cause) { if (!(cause instanceof Error && /已停止本次 AI 生成/.test(cause.message))) setError(cause instanceof Error ? cause.message : "无法生成提纲。"); setOutlineProject(undefined); }
    finally { setOutlineGenerating(false); outlineAbortRef.current = undefined; }
  };
  const openOutline = async (project: ContentProject) => {
    if (project.outlineReady) {
      setOutlineProject(project); setOutline(undefined); setSaving(false); setOutlineEditorMode("visual"); setOutlineModeScrollOffset(0);
      try { setOutline(await request<ContentOutline>(`/content-projects/${project.id}/outline`)); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取文章提纲。"); setOutlineProject(undefined); }
      return;
    }
    setOutlineEditorMode("visual"); setOutlineModeScrollOffset(0);
    await generateOutline(project);
  };
  const switchOutlineToMarkdown = (offset: number) => {
    setOutlineModeScrollOffset(offset);
    setOutlineEditorMode("markdown");
  };
  const switchOutlineToVisual = () => {
    const textarea = outlineMarkdownSourceRef.current;
    if (textarea) setOutlineModeScrollOffset(markdownOffsetAtTextareaTop(textarea, outline?.markdown ?? ""));
    setOutlineEditorMode("visual");
  };
  useEffect(() => {
    if (outlineEditorMode !== "markdown") return;
    requestAnimationFrame(() => {
      const textarea = outlineMarkdownSourceRef.current;
      const canvas = textarea?.closest<HTMLElement>(".editor-canvas");
      if (canvas) canvas.scrollTop = 0;
    });
  }, [outlineEditorMode]);
  const saveOutline = async (event: FormEvent) => {
    event.preventDefault(); if (!outlineProject || !outline) return;
    setSaving(true);
    try { await request<ContentOutline>(`/content-projects/${outlineProject.id}/outline`, { method: "PUT", body: JSON.stringify({ markdown: outline.markdown }) }); setOutlineProject(undefined); setOutline(undefined); await loadProjects(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "提纲保存失败。"); }
    finally { setSaving(false); }
  };
  const openDraft = async (project: ContentProject) => {
    setDraftProject(project); setDraft(undefined); setSaving(false); setDraftGenerationStatus("");
    setArticleWorkspacePanel("assistant");
    try {
      let opened: ContentDraft;
      if (project.draftReady) opened = await request<ContentDraft>(`/content-projects/${project.id}/draft`);
      else {
        const controller = new AbortController();
        draftAbortRef.current = controller;
        setDraftGenerating(true);
        setDraftGenerationStatus("正在准备正文生成任务…");
        setDraft({ projectId: project.id, markdown: "", generatedFromOutline: true, sourceRelativePath: project.sourceRelativePath });
        opened = await streamGeneration<ContentDraft>(`/content-projects/${project.id}/draft/generate/stream`, controller.signal, (event, data) => {
          if (event === "delta") setDraft((current) => current ? { ...current, markdown: String(data.markdown ?? "") } : current);
          if (event === "status") setDraftGenerationStatus(String(data.message ?? "AI 正在起草正文…"));
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
    setPublishNeedOpenComment(true);
    setPublishOnlyFansCanComment(false);
    setPublishThumbMediaId("");
    setPublishCheckMarkdown("");
    setPublishAiCheckResult("");
    setPublishZhuqueReport(undefined); setPublishAiCheckTool(undefined);
    setPublishAiOverrideReason("");
    publishAiOverrideReasonDirtyRef.current = false;
    resetPublishCover();
    setError("");
    void loadSkillsAndConnections();
    const contextKey = project.sourceRelativePath ? `source:${project.sourceRelativePath}` : `project:${project.id}`;
    void request<ArticleSettings>(`/article-settings?contextKey=${encodeURIComponent(contextKey)}`)
      .then((settings) => {
        setPublishAuthor(settings.author); setPublishDigest(settings.digest); setPublishAccountId(settings.accountId || preferred?.id || "");
        setPublishNeedOpenComment(settings.needOpenComment); setPublishOnlyFansCanComment(settings.onlyFansCanComment);
        setPublishDeclareOriginal(settings.declareOriginal); setPublishEnableReward(settings.enableReward); setPublishCollectionName(settings.collectionName);
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
        if (!publishAiOverrideReasonDirtyRef.current) setPublishAiOverrideReason(quality.overrideReason);
      }).catch(() => undefined);
  };
  const openSourcePublishPreparation = (article: ContentSourceArticle) => {
    const preferred = accounts.find((account) => account.platform === "wechat_official");
    setPublishSource(article);
    setSourceArticle(undefined);
    setPublishAccountId(preferred?.id ?? "");
    setPublishAuthor("");
    setPublishDigest("");
    setPublishNeedOpenComment(true);
    setPublishOnlyFansCanComment(false);
    setPublishThumbMediaId("");
    setPublishCheckMarkdown(article.markdown);
    setPublishAiCheckResult("");
    setPublishZhuqueReport(undefined); setPublishAiCheckTool(undefined);
    setPublishAiOverrideReason("");
    publishAiOverrideReasonDirtyRef.current = false;
    resetPublishCover();
    setError("");
    void loadSkillsAndConnections();
    void request<ArticleSettings>(`/article-settings?contextKey=${encodeURIComponent(`source:${article.relativePath}`)}`)
      .then((settings) => {
        setPublishAuthor(settings.author); setPublishDigest(settings.digest); setPublishAccountId(settings.accountId || "");
        setPublishNeedOpenComment(settings.needOpenComment); setPublishOnlyFansCanComment(settings.onlyFansCanComment);
        setPublishDeclareOriginal(settings.declareOriginal); setPublishEnableReward(settings.enableReward); setPublishCollectionName(settings.collectionName);
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
        if (!publishAiOverrideReasonDirtyRef.current) setPublishAiOverrideReason(quality.overrideReason);
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
          coverSource: publishCoverSource,
          needOpenComment: publishNeedOpenComment,
          onlyFansCanComment: publishNeedOpenComment && publishOnlyFansCanComment,
          declareOriginal: publishDeclareOriginal,
          enableReward: publishEnableReward,
          collectionName: publishCollectionName
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
  const openWechatDraftBox = async () => {
    if (!window.contentFerry) {
      setError("微信草稿箱只能从文渡桌面应用中打开。");
      return;
    }
    try {
      await window.contentFerry.openWechatBackend();
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法打开微信草稿箱。");
    }
  };
  const startWechatBrowserAssist = async (job: WechatPublishJob) => {
    setSaving(true);
    try {
      const assistedJob = await request<WechatPublishJob>(`/integrations/wechat/jobs/${job.id}/browser-assist`, { method: "POST" });
      if (!window.contentFerry) throw new Error("微信后台完善只能从文渡桌面应用中打开。");
      await window.contentFerry.openWechatBackend({
        accountId: assistedJob.accountId,
        title: assistedJob.title,
        declareOriginal: assistedJob.declareOriginal,
        enableReward: assistedJob.enableReward,
        collectionName: assistedJob.collectionName
      });
      await Promise.all([loadWechatJobs(), loadProjects()]);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法启动微信后台完善流程。");
    } finally {
      setSaving(false);
    }
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
      await openWechatDraftBox();
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
  const openSkillEditor = (skill: ManagedSkill) => {
    setEditingSkill(skill);
    setEditingSkillFile({ relativePath: "SKILL.md", content: skill.markdown, size: new Blob([skill.markdown]).size });
    setSavedSkillFileContent(skill.markdown);
    setError("");
  };
  const chooseSkillFile = async (relativePath: string) => {
    if (!editingSkill || editingSkillFile?.relativePath === relativePath) return;
    if (editingSkillFile && editingSkillFile.content !== savedSkillFileContent && !window.confirm("当前技能文件还有未保存修改。确定放弃并打开其他文件吗？")) return;
    setSaving(true);
    try {
      const file = await request<SkillFileContent>(`/skills/${editingSkill.id}/file?path=${encodeURIComponent(relativePath)}`);
      setEditingSkillFile(file);
      setSavedSkillFileContent(file.content);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "技能文件读取失败。");
    } finally {
      setSaving(false);
    }
  };
  const closeSkillEditor = () => {
    if (editingSkillFile && editingSkillFile.content !== savedSkillFileContent && !window.confirm("技能文件还有未保存修改。确定关闭吗？")) return;
    setEditingSkill(undefined);
    setEditingSkillFile(undefined);
    setSavedSkillFileContent("");
  };
  const saveSkill = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingSkill) return;
    setSaving(true);
    try {
      const selectedPath = editingSkillFile?.relativePath ?? "SKILL.md";
      const selectedContent = editingSkillFile?.content ?? editingSkill.markdown;
      if (selectedPath !== "SKILL.md") {
        await request<SkillFileContent>(`/skills/${editingSkill.id}/file`, {
          method: "PUT",
          body: JSON.stringify({ path: selectedPath, content: selectedContent })
        });
      }
      const saved = await request<ManagedSkill>(`/skills/${editingSkill.id}`, {
        method: "PUT",
        body: JSON.stringify({
          markdown: selectedPath === "SKILL.md" ? selectedContent : editingSkill.markdown,
          enabled: editingSkill.enabled,
          provider: editingSkill.provider
        })
      });
      setEditingSkill(saved);
      const refreshedFile = await request<SkillFileContent>(`/skills/${saved.id}/file?path=${encodeURIComponent(selectedPath)}`);
      setEditingSkillFile(refreshedFile);
      setSavedSkillFileContent(refreshedFile.content);
      setError("");
      await loadSkillsAndConnections();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "技能保存失败。");
    } finally {
      setSaving(false);
    }
  };
  const toggleGroupSelection = (groupKey: string, value: boolean) => {
    const group = skillModelGroups.find((item) => item.key === groupKey);
    if (!group) return;
    const groupSkills = skills.filter((skill) => group.match(skill.category));
    setSelectedSkillIds((current) => {
      const next = { ...current };
      for (const skill of groupSkills) next[skill.id] = value;
      return next;
    });
  };
  const applyBatchModel = async (groupKey: string) => {
    const group = skillModelGroups.find((item) => item.key === groupKey);
    const target = batchModelByGroup[groupKey];
    if (!group || !target) return;
    const groupSkills = skills.filter((skill) => group.match(skill.category));
    const selectedIds = new Set(Object.keys(selectedSkillIds).filter((id) => selectedSkillIds[id]));
    const targetSkills = groupSkills.filter((skill) => selectedIds.has(skill.id));
    if (targetSkills.length === 0) return;
    setBatchSaving(true);
    try {
      for (const skill of targetSkills) {
        await request<ManagedSkill>(`/skills/${skill.id}`, {
          method: "PUT",
          body: JSON.stringify({ markdown: skill.markdown, enabled: skill.enabled, provider: target })
        });
      }
      setSelectedSkillIds({});
      setBatchModelByGroup((current) => ({ ...current, [groupKey]: null }));
      await loadSkillsAndConnections();
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "批量设置模型失败。");
    } finally {
      setBatchSaving(false);
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
          builtInSearch: editingConnection.builtInSearch,
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

  const openTavilySettings = () => {
    setTavilyApiKey("");
    setTavilyError("");
    setTavilyTestResult("");
    setTavilyModalOpen(true);
  };
  const testTavilyConnection = async () => {
    setTavilyTesting(true);
    setTavilyError("");
    setTavilyTestResult("");
    try {
      const result = await request<{ ok: boolean; resultCount: number }>("/web-search/tavily/test", {
        method: "POST",
        body: JSON.stringify(tavilyApiKey.trim() ? { apiKey: tavilyApiKey.trim() } : {})
      });
      setTavilyTestResult(`连接成功：Tavily 已返回 ${result.resultCount} 条测试结果。${tavilyApiKey.trim() ? "请点击“保存”后用于正式补研。" : "当前保存的 Key 可用于正式补研。"}`);
    } catch (cause) {
      setTavilyError(cause instanceof Error ? cause.message : "Tavily 连接测试失败。");
    } finally {
      setTavilyTesting(false);
    }
  };
  const saveTavilySettings = async (event: FormEvent) => {
    event.preventDefault();
    if (!tavilyApiKey.trim()) {
      setTavilyError("请输入 Tavily API Key；如只想测试已有凭证，可直接点击“测试连接”。");
      return;
    }
    setTavilySaving(true);
    setTavilyError("");
    setTavilyTestResult("");
    try {
      const saved = await request<WebSearchSettings>("/web-search/tavily", {
        method: "PUT",
        body: JSON.stringify({ apiKey: tavilyApiKey.trim() })
      });
      setWebSearchSettings(saved);
      setTavilyApiKey("");
      setTavilyModalOpen(false);
    } catch (cause) {
      setTavilyError(cause instanceof Error ? cause.message : "Tavily 配置保存失败。");
    } finally {
      setTavilySaving(false);
    }
  };
  const clearTavilySettings = async () => {
    if (!window.confirm("确定移除本机保存的 Tavily API Key 吗？不会影响系统环境变量中的开发配置。")) return;
    setTavilySaving(true);
    setTavilyError("");
    setTavilyTestResult("");
    try {
      const saved = await request<WebSearchSettings>("/web-search/tavily", { method: "DELETE" });
      setWebSearchSettings(saved);
      setTavilyApiKey("");
    } catch (cause) {
      setTavilyError(cause instanceof Error ? cause.message : "Tavily 凭证移除失败。");
    } finally {
      setTavilySaving(false);
    }
  };
  const openResearchProxySettings = () => {
    setResearchProxyInput(researchProxyUrl);
    setResearchProxyError("");
    setResearchProxyModalOpen(true);
  };
  const saveResearchProxySettings = async (event: FormEvent) => {
    event.preventDefault();
    setResearchProxySaving(true);
    setResearchProxyError("");
    try {
      const saved = await request<WebSearchSettings>("/web-search/proxy", {
        method: "PUT",
        body: JSON.stringify({ proxyUrl: researchProxyInput.trim() })
      });
      setResearchProxyUrl(saved.researchProxyUrl ?? "");
      setResearchProxyModalOpen(false);
    } catch (cause) {
      setResearchProxyError(cause instanceof Error ? cause.message : "检索代理保存失败。");
    } finally {
      setResearchProxySaving(false);
    }
  };
  const clearResearchProxySettings = async () => {
    setResearchProxySaving(true);
    setResearchProxyError("");
    try {
      const saved = await request<WebSearchSettings>("/web-search/proxy", { method: "DELETE" });
      setResearchProxyUrl(saved.researchProxyUrl ?? "");
      setResearchProxyInput("");
      setResearchProxyModalOpen(false);
    } catch (cause) {
      setResearchProxyError(cause instanceof Error ? cause.message : "检索代理移除失败。");
    } finally {
      setResearchProxySaving(false);
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

  if (csdnDraft) {
    const csdnAccount = accounts.find((account) => account.id === csdnDraft.accountId);
    return <CsdnDraftWorkspace
      draft={csdnDraft}
      accountDisplay={csdnAccount ? `${csdnAccount.displayName}` : "CSDN 账号"}
      saving={csdnDraftSaving}
      job={csdnPublishJob}
      onChange={(patch) => setCsdnDraft((current) => current ? { ...current, ...patch } : current)}
      onSave={() => void saveCsdnChannelDraft()}
      onApprove={() => void approveCsdnChannelDraft()}
      onCreateJob={() => void createCsdnPublishJob()}
      onStartBrowserAssist={(jobId) => void startCsdnBrowserAssist(jobId)}
      onConfirmPublish={(jobId) => void confirmCsdnPublish(jobId)}
      onCorrectStatus={(jobId, status, reason) => void correctCsdnStatus(jobId, status, reason)}
      onBack={() => { setCsdnDraftSource(undefined); setCsdnDraft(undefined); setCsdnPublishJob(undefined); }}
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
      generationStatus={draftGenerationStatus}
      onStopGeneration={() => draftAbortRef.current?.abort()}
      onChange={(markdown) => setDraft((current) => current ? { ...current, markdown } : current)}
      onBack={() => { draftAbortRef.current?.abort(); setDraftProject(undefined); setDraft(undefined); setDraftGenerationStatus(""); }}
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
          : activeView === "accounts" ? "账号与连接" : activeView === "help" ? "使用帮助" : "运行日志";
  const filteredRuntimeLogs = runtimeLogs;
  const pendingWechatJobs = wechatJobs.filter((job) => job.status !== "published" && job.status !== "cancelled");
  const completedWechatJobs = wechatJobs.filter((job) => job.status === "published" || job.status === "cancelled");
  const researchReadOnly = researchProject ? bestWechatJob(wechatJobs, (item) => item.projectId === researchProject.id || item.sourceRelativePath === researchProject.sourceRelativePath || item.title === researchProject.topic)?.status === "published" : false;
  const outlineReadOnly = outlineProject ? bestWechatJob(wechatJobs, (item) => item.projectId === outlineProject.id || item.sourceRelativePath === outlineProject.sourceRelativePath || item.title === outlineProject.topic)?.status === "published" : false;

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
        <button className={activeView === "help" ? "active" : ""} onClick={() => setActiveView("help")}>使用帮助</button>
        <button disabled>数据 <small>即将开放</small></button>
      </nav>
    </aside>
    <main className="app-main">
    <div className="page-heading"><h1>{pageTitle}</h1>{((activeView === "dashboard" && projects.length > 0) || activeView === "library") && <button onClick={openProjectCreator}>＋ 新建文章</button>}</div>
    {error && <p className="error">{error}</p>}
    {error && <Modal title="操作未完成" eyebrow="需要你的注意" onClose={() => setError("")} disabled={false} priority><p className="error error-dialog-message">{error}</p><div className="modal-actions"><button type="button" onClick={() => setError("")}>知道了</button></div></Modal>}

    {activeView === "help" && <HelpCenter onNavigate={setActiveView} />}

    {activeView === "skills" && <>
      <section className="card">
        <div className="section-heading"><div><h2>技能</h2><p className="hint compact-hint">每个技能都有独立的 SKILL.md，可修改执行规则、停用，或更换模型连接。</p></div><button className="text-button" onClick={() => void loadSkillsAndConnections()}>刷新</button></div>
        {skillModelGroups.map((group) => {
          const groupSkills = skills.filter((skill) => group.match(skill.category));
          if (groupSkills.length === 0) return null;
          const selected = batchModelByGroup[group.key];
          const selectedInGroup = groupSkills.filter((skill) => selectedSkillIds[skill.id]);
          return (
            <div className="skill-group" key={group.key}>
              <div className="section-heading group-heading">
                <div><h3>{group.title}</h3><p className="hint compact-hint">{group.description}</p></div>
                {group.providers && <div className="group-batch-model">
                  <div className="group-select-all">
                    <button type="button" className="text-button" disabled={batchSaving || groupSkills.length === selectedInGroup.length} onClick={() => toggleGroupSelection(group.key, true)}>全选</button>
                    <button type="button" className="text-button" disabled={batchSaving || selectedInGroup.length === 0} onClick={() => toggleGroupSelection(group.key, false)}>取消全选</button>
                  </div>
                  <select value={selected ?? ""} onChange={(event) => setBatchModelByGroup((current) => ({ ...current, [group.key]: (event.target.value || null) as ModelProviderId | null }))} aria-label={`${group.title}批量模型`}>
                    <option value="">选择目标模型…</option>
                    {modelConnections.filter((connection) => group.providers!.includes(connection.provider)).map((connection) => <option key={connection.provider} value={connection.provider}>{connection.displayName}</option>)}
                  </select>
                  <button type="button" className="secondary-button" disabled={!selected || batchSaving || selectedInGroup.length === 0} onClick={() => void applyBatchModel(group.key)}>{batchSaving ? "正在应用…" : selectedInGroup.length > 0 ? `应用到选中的 ${selectedInGroup.length} 个技能` : "请先勾选技能"}</button>
                </div>}
              </div>
              <div className="skill-grid">{groupSkills.map((skill) => (
                <div className="skill-card" key={skill.id}>
                  <label className="skill-select" onClick={(event) => event.stopPropagation()} title="勾选后用于批量设置模型">
                    <input type="checkbox" checked={!!selectedSkillIds[skill.id]} onChange={(event) => setSelectedSkillIds((current) => ({ ...current, [skill.id]: event.target.checked }))} aria-label={`选择 ${skill.name} 批量设置模型`} />
                  </label>
                  <button type="button" className="skill-card-body" onClick={() => openSkillEditor(skill)}>
                    <span><em>{skill.category}</em><strong>{skill.name}</strong></span>
                    <p>{skill.description}</p>
                    <small>{skill.enabled ? `已启用 · ${skillModelStatus(skill)}` : "已停用"}</small>
                  </button>
                </div>
              ))}</div>
            </div>
          );
        })}
      </section>
      <section className="card">
        <div className="section-heading"><div><h2>模型连接</h2><p className="hint compact-hint">凭证加密保存在本机，页面只显示是否已配置，不回显明文。</p></div></div>
        <ul className="account-list">{modelConnections.map((connection) => <li key={connection.provider}><span><strong>{connection.displayName}</strong><small>{connection.modelId || "使用服务默认模型"}{connection.proxyUrl ? ` · 代理 ${connection.proxyUrl}` : ""}</small></span><span className="account-actions"><em>{connection.provider === "openai_codex" ? "使用 ChatGPT 登录" : connection.credentialConfigured ? "凭证已配置" : "待配置凭证"}</em><button className="text-button" onClick={() => { setEditingConnection(connection); setConnectionCredential(""); setError(""); }}>配置</button></span></li>)}</ul>
      </section>
      <section className="card">
        <div className="section-heading"><div><h2>联网检索服务</h2><p className="hint compact-hint">用于阿文补充公开资料，不属于任何一个模型连接。默认使用免配置搜索源；Tavily 可提升稳定性。</p></div></div>
        <ul className="account-list">
          <li><span><strong>Tavily</strong><small>{webSearchSettings.tavilyCredentialSource === "environment" ? "开发环境变量配置" : "用于稳定的联网资料检索"}</small></span><span className="account-actions"><em>{webSearchSettings.tavilyConfigured ? "已配置" : "可选"}</em><button className="text-button" onClick={openTavilySettings}>配置</button></span></li>
          <li><span><strong>检索代理</strong><small>{researchProxyUrl ? `已配置：${researchProxyUrl}` : "留空直连；防火墙后访问检索源时填写"}</small></span><span className="account-actions"><em>{researchProxyUrl ? "已配置" : "直连"}</em><button className="text-button" onClick={openResearchProxySettings}>配置</button></span></li>
        </ul>
      </section>
      <section className="card">
        <div className="section-heading"><div><h2>AI 调用审计</h2><p className="hint compact-hint">开启后，每次模型调用都会把完整请求与响应写入数据目录下的日志，用于排查生成质量与失败；默认关闭。</p></div></div>
        <div className="skill-settings-row">
          <label className="toggle-label"><input type="checkbox" checked={settings?.auditAiCalls ?? false} onChange={async (event) => {
            const next = event.target.checked;
            try {
              const updated = await patchAppSettings({ auditAiCalls: next });
              setSettings((prev) => prev ? { ...prev, auditAiCalls: updated.auditAiCalls } : prev);
            } catch (error) {
              setError(error instanceof Error ? error.message : "无法保存审计设置。");
            }
          }} />开启 AI 调用审计（记录完整请求与响应）</label>
          <button className="text-button" onClick={async () => { try { await request<void>("/app/audit-log/clear", { method: "POST" }); } catch (error) { setError(error instanceof Error ? error.message : "清空审计日志失败。"); } }}>清空审计日志</button>
        </div>
        {auditDir && <p className="hint compact-hint">日志路径：{auditDir}（按天分文件，保留 30 天）</p>}
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
    <section className="card"><div className="section-heading"><div><h2>VitePress 文章库</h2><p className="hint compact-hint">这里的 Markdown 文件是正式内容源，可同时用 Obsidian 编辑，也可以发布到已接入的平台。</p></div><button onClick={() => void openSource()}>配置并扫描</button></div>{sourcePreview && <><p className="library-summary">已连接 {sourcePreview.rootPath}，发现 {sourcePreview.articleCount} 篇文章。</p><ul className="content-library-list">
        {sourcePreview.items.map((item) => (
          <li key={item.relativePath}>
            <span className="article-primary">
              <button className="article-title-button" onClick={() => void openSourceArticle(item.relativePath)}>{item.title ?? "未命名文章"}</button>
            </span>
            <span className="channel-distribution">
              {channelRowsFor(item).map((row) => (
                <span className="channel-row" key={row.platform}>
                  <span className="channel-name">{row.label}</span>
                  <span className={"status-badge " + row.tone}>{row.statusLabel}</span>
                  <button className={row.action.kind === "continue" ? "secondary-button" : "text-button"} onClick={row.action.onClick}>{row.action.label}</button>
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul></>}</section>
    </>}

    {activeView === "publish" && <>
      <div className="publish-page-actions"><span>{wechatJobsRefreshedAt && `已更新 ${wechatJobsRefreshedAt.toLocaleTimeString()}`}</span><button className="text-button" onClick={() => void refreshWechatStatus()} disabled={wechatJobsRefreshing}>{wechatJobsRefreshing ? "正在刷新…" : "刷新状态"}</button></div>
      {wechatJobs.length === 0 && csdnJobs.length === 0 ? <section className="card"><div className="empty-guidance"><strong>还没有发布任务</strong><p>请先在内容库中选择文章并发起发布。</p><button onClick={() => setActiveView("library")}>前往内容库</button></div></section> : <>
        {pendingWechatJobs.length > 0 && <section className="card">
          <div className="section-heading"><h2>待处理</h2></div>
          <ul className="publish-job-list">{pendingWechatJobs.map((job) => {
            const account = accounts.find((item) => item.id === job.accountId);
            return <li key={job.id}><span><strong>{job.title}</strong><small>{account ? `${platformName(account.platform)} · ${account.displayName} · ` : ""}{wechatJobLabel(job)} · {new Date(job.updatedAt).toLocaleString()}</small>{job.statusNote && <small className="hint compact-hint">{job.statusNote}</small>}{job.errorMessage && <em className="error">{job.errorMessage}</em>}</span><span className="account-actions">{job.status === "draft_ready" && <><button onClick={() => void startWechatBrowserAssist(job)} disabled={saving}>在微信后台完善并发布</button><button className="secondary-button" onClick={() => void openWechatDraftBox()} disabled={saving}>微信草稿箱</button><details className="publish-more-actions"><summary>更多操作</summary><button className="text-button" onClick={() => void submitWechatJob(job, "publish")} disabled={saving}>接口普通发布</button><button className="text-button" onClick={() => void submitWechatJob(job, "mass")} disabled={saving}>接口群发所有关注者</button></details></>}{job.status === "browser_editing" && <><span className="status-badge">等待你在微信后台确认</span><button onClick={() => void startWechatBrowserAssist(job)} disabled={saving}>重新打开微信后台</button><button className="text-button" onClick={() => openWechatStatusCorrection(job)}>确认结果</button></>}{job.status === "submitted" && <><span className="status-badge">等待微信回执</span><button className="text-button" onClick={() => openWechatStatusCorrection(job)}>校正状态</button></>}{job.status === "failed" && <><button className="secondary-button" onClick={() => void retryWechatJob(job)}>重新设置并同步</button><button className="text-button" onClick={() => openWechatStatusCorrection(job)}>校正状态</button></>}</span></li>;
          })}</ul>
        </section>}
        {completedWechatJobs.length > 0 && <section className="card">
          <div className="section-heading"><h2>发布记录</h2></div>
          <ul className="publish-job-list">{completedWechatJobs.map((job) => {
            const account = accounts.find((item) => item.id === job.accountId);
            return <li key={job.id}><span><strong>{job.title}</strong><small>{account ? `${platformName(account.platform)} · ${account.displayName} · ` : ""}{job.status === "cancelled" ? "已取消发布" : job.mode === "mass" ? "已群发" : "已发布"} · {new Date(job.updatedAt).toLocaleString()}</small>{job.statusSource === "manual" && <small className="manual-status-note">人工校正：{job.statusNote}</small>}</span><span className={`status-badge ${job.status === "cancelled" ? "warning" : "success"}`}>{job.status === "cancelled" ? "已取消" : "已完成"}</span></li>;
          })}</ul>
        </section>}
        {csdnJobs.length > 0 && <section className="card">
          <div className="section-heading"><h2>CSDN 发布任务</h2></div>
          <ul className="publish-job-list">{csdnJobs.map((job) => {
            const account = accounts.find((item) => item.id === job.accountId);
            const draft = csdnDrafts.find((item) => item.id === job.channelDraftId);
            return <li key={job.id}><span><strong>{draft?.title ?? "CSDN 渠道稿"}</strong><small>{account ? `${platformName(account.platform)} · ${account.displayName} · ` : ""}{csdnJobLabel(job)} · {new Date(job.updatedAt).toLocaleString()}</small>{job.statusNote && <small className="hint compact-hint">{job.statusNote}</small>}{job.remoteUrl && <small><a href={job.remoteUrl} target="_blank" rel="noreferrer">查看已发布文章</a></small>}{job.errorMessage && <em className="error">{job.errorMessage}</em>}</span><span className="account-actions">{csdnJobCanStart(job) && <button onClick={() => void startCsdnBrowserAssist(job.id)} disabled={csdnDraftSaving}>在浏览器中完成发布</button>}{csdnJobCanConfirm(job) && <button className="secondary-button" onClick={() => void confirmCsdnPublish(job.id)} disabled={csdnDraftSaving}>我已在 CSDN 发布</button>}{job.status === "submitting" && <span className="status-badge">正在读取回执</span>}{csdnJobCanCorrect(job) && <button className="text-button" onClick={() => openCsdnStatusCorrection(job)} disabled={csdnDraftSaving}>校正状态</button>}</span></li>;
          })}</ul>
        </section>}
      </>}
    </>}

    {activeView === "dashboard" && <>
    <section className={`card${projects.length === 0 ? " dashboard-empty-card" : ""}`}>
      {projects.length === 0 ? (
        <div className="dashboard-empty"><h2>写下一个主题，开始第一篇文章</h2><p>文渡会创建草稿，并结合账号定位辅助整理方向、提纲和正文。</p><button onClick={openProjectCreator}>＋ 新建文章</button></div>
      ) : (
        <ul className="project-list">{projects.map((project) => {
          const job = bestWechatJob(wechatJobs, (item) => item.projectId === project.id || item.sourceRelativePath === project.sourceRelativePath || item.title === project.topic);
          const nextText = job?.status === "published" ? "微信公众号已确认发布完成" : job?.status === "cancelled" ? "发布任务已人工取消，可重新设置后再发布" : job?.status === "submitted" ? "已提交微信，正在等待最终回执" : job?.status === "draft_ready" ? "已同步微信草稿箱，等待预览和发布" : project.draftReady ? "正文已保存，可继续编辑或准备发布" : project.outlineReady ? "提纲已确认，下一步生成正文" : project.researchReady ? "资料已补充，下一步生成提纲" : project.briefReady ? "创作方向已整理，下一步联网补研" : "下一步整理创作方向和资料";
          const action = project.draftReady || project.outlineReady ? () => void openDraft(project) : project.researchReady ? () => void openOutline(project) : project.briefReady ? () => void openResearch(project, true) : () => void openBrief(project);
          const label = project.draftReady ? "打开正文" : project.outlineReady ? "起草正文" : project.researchReady ? "生成提纲" : project.briefReady ? "联网补研" : "整理创作方向";
          const account = project.targetAccountId ? accounts.find((item) => item.id === project.targetAccountId) : undefined;
          const canPrepare = !job || job.status === "failed" || job.status === "cancelled";
          const canEditBrief = project.briefReady && !project.outlineReady && !project.draftReady;
          return <li key={project.id}>
            <span>{project.draftReady ? <button className="article-title-button" onClick={() => void openDraft(project)}>{project.topic}</button> : <strong>{project.topic}</strong>}<small>{nextText}</small></span>
              <span className="account-actions">
              <span className="account-badge">{account ? `${platformName(account.platform)} · ${account.displayName}` : "未选发布账号"}</span>
              {canEditBrief && <button className="secondary-button" onClick={() => void openBrief(project)}>编辑创作方向</button>}
              {project.researchReady && <button className="secondary-button" onClick={() => void openResearch(project)}>查看资料</button>}
              {project.outlineReady && <button className="secondary-button" onClick={() => void openOutline(project)}>{job?.status === "published" ? "查看提纲" : "编辑提纲"}</button>}
              {!project.draftReady && <button onClick={action}>{label}</button>}
              {project.draftReady && canPrepare && <button className="secondary-button" onClick={() => openPublishPreparation(project)}>准备发布</button>}
              {job?.status === "draft_ready" && <span className="status-badge">草稿已同步</span>}
              {job?.status === "submitted" && <span className="status-badge">微信处理中</span>}
              {job?.status === "published" && <span className="status-badge success">已发布</span>}
              {job?.status === "cancelled" && <span className="status-badge warning">已取消发布</span>}
              <button className="text-button danger-text" onClick={() => void deleteProjectDraft(project)} disabled={saving}>{job ? "删除本地文章" : "删除草稿"}</button>
            </span>
          </li>;
        })}</ul>
      )}
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

    {editingSkill && <Modal onClose={closeSkillEditor} disabled={saving} title={editingSkill.name} eyebrow="技能管理" wide>
      <form onSubmit={saveSkill} className="profile-form">
        <p className="hint">{editingSkill.description}</p>
        <div className="skill-settings-row">
          <label className="toggle-label"><input type="checkbox" checked={editingSkill.enabled} onChange={(event) => setEditingSkill((current) => current ? { ...current, enabled: event.target.checked } : current)} />启用此技能</label>
          {["zhuque-detection", "contentany-detection"].includes(editingSkill.id) ? <p className="hint">此技能使用可见浏览器自动化，不需要大模型连接；浏览器登录状态会在本机保留。</p> : <label>模型连接<select value={editingSkill.provider ?? ""} onChange={(event) => setEditingSkill((current) => current ? { ...current, provider: (event.target.value || null) as ModelProviderId | null } : current)}>{modelConnections.filter((connection) => editingSkill.category === "图片" ? connection.provider === "modelscope" || connection.provider === "agnes" : connection.provider === "openai_codex" || connection.provider === "openai" || connection.provider === "openrouter" || connection.provider === "nous" || connection.provider === "nvidia_build" || connection.provider === "github_copilot").map((connection) => <option key={connection.provider} value={connection.provider}>{connection.displayName}</option>)}</select></label>}
        </div>
        <div className="skill-file-workspace">
          <aside><strong>技能文件</strong>{editingSkill.files.map((file) => <button type="button" className={editingSkillFile?.relativePath === file.relativePath ? "active" : ""} onClick={() => void chooseSkillFile(file.relativePath)} key={file.relativePath}><span>{file.relativePath}</span><small>{Math.max(1, Math.ceil(file.size / 1024))} KB</small></button>)}</aside>
          <label><span>{editingSkillFile?.relativePath ?? "正在读取…"}{editingSkillFile && editingSkillFile.content !== savedSkillFileContent ? " · 未保存" : ""}</span><textarea className="skill-markdown-editor" value={editingSkillFile?.content ?? ""} onChange={(event) => setEditingSkillFile((current) => current ? { ...current, content: event.target.value, size: new Blob([event.target.value]).size } : current)} spellCheck={false} disabled={!editingSkillFile} /></label>
        </div>
        <small className="hint">技能目录：{editingSkill.filePath.replace(/[\\/]SKILL\.md$/i, "")}</small>
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={closeSkillEditor}>取消</button><button disabled={saving || !editingSkillFile}>{saving ? "正在保存…" : `保存 ${editingSkillFile?.relativePath ?? "技能文件"}`}</button></div>
      </form>
    </Modal>}
    {editingConnection && <Modal onClose={() => setEditingConnection(undefined)} disabled={saving} title={`配置 ${editingConnection.displayName}`} eyebrow="模型连接">
      <form onSubmit={saveModelConnection} className="profile-form">
        <label>显示名称<input value={editingConnection.displayName} onChange={(event) => setEditingConnection((current) => current ? { ...current, displayName: event.target.value } : current)} /></label>
        <label>模型名称<input value={editingConnection.modelId} onChange={(event) => setEditingConnection((current) => current ? { ...current, modelId: event.target.value } : current)} placeholder="留空时使用服务默认模型" /></label>
        {editingConnection.provider !== "openai_codex" && <label>{editingConnection.provider === "github_copilot" ? "GitHub Token" : "API Key"}<input type="password" value={connectionCredential} onChange={(event) => setConnectionCredential(event.target.value)} autoComplete="new-password" placeholder={editingConnection.credentialConfigured ? "已配置；留空不修改" : "请输入访问凭证"} /></label>}
        {editingConnection.provider !== "openai_codex" && editingConnection.provider !== "github_copilot" && <label>服务地址<input value={editingConnection.baseUrl} onChange={(event) => setEditingConnection((current) => current ? { ...current, baseUrl: event.target.value } : current)} /></label>}
        {editingConnection.provider !== "openai_codex" && <label>代理地址（可选）<input value={editingConnection.proxyUrl} onChange={(event) => setEditingConnection((current) => current ? { ...current, proxyUrl: event.target.value } : current)} placeholder="例如：http://127.0.0.1:7890" /><small>留空表示直连。需要代理才能访问的模型（如 Nous / OpenRouter / OpenAI）请填写；格式 http://127.0.0.1:7890。代理不可用时请求会明确报错，不会静默切换。</small></label>}
        {editingConnection.provider === "openai_codex" && <p className="hint">OpenAI Codex 使用本机 ChatGPT/Codex 登录状态，不需要 API Key。安装包会携带 SDK 所需运行组件，不要求安装 Hermes Agent。</p>}
        {editingConnection.provider === "openai_codex" && (
          <label className="checkbox-row">
            <input type="checkbox" checked={editingConnection.builtInSearch} onChange={(event) => setEditingConnection((current) => current ? { ...current, builtInSearch: event.target.checked } : current)} />
            <span>联网补研使用 Codex 内置搜索<small>开启时由 Codex SDK 直接联网检索并综合资料卡，开箱即用、质量更好。关闭时改用应用的 Tavily / DuckDuckGo 检索链（资料 URL 由系统真实抓取、可追溯，且走全局检索代理）。默认开启。</small></span>
          </label>
        )}
        {editingConnection.provider === "github_copilot" && <p className="hint">支持 GitHub Copilot Token。后续还会补充浏览器设备授权入口；现在也可使用本机已有的 GitHub/Copilot 登录环境。</p>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setEditingConnection(undefined)}>取消</button><button disabled={saving}>{saving ? "正在保存…" : "保存连接"}</button></div>
      </form>
    </Modal>}
    {tavilyModalOpen && <Modal onClose={() => setTavilyModalOpen(false)} disabled={tavilySaving || tavilyTesting} title="配置 Tavily" eyebrow="联网检索服务">
      <form onSubmit={saveTavilySettings} className="profile-form">
        <p className="hint">Tavily 用于提升阿文联网补研的稳定性。API Key 会加密保存在本机，不会显示、写入日志或发送给模型服务。</p>
        <label>Tavily API Key<input type="password" value={tavilyApiKey} onChange={(event) => setTavilyApiKey(event.target.value)} autoComplete="new-password" placeholder={webSearchSettings.tavilyConfigured ? "已配置；填写新 Key 可替换" : "请输入 Tavily API Key"} /></label>
        {tavilyTestResult && <p className="success-message" role="status">{tavilyTestResult}</p>}
        {tavilyError && <p className="error" role="alert">连接测试失败：{tavilyError}</p>}
        <div className="modal-actions">
          {webSearchSettings.tavilyCredentialSource === "local" && <button type="button" className="danger-button" onClick={() => void clearTavilySettings()} disabled={tavilySaving || tavilyTesting}>移除本机 Key</button>}
          <button type="button" className="secondary-button" onClick={() => void testTavilyConnection()} disabled={tavilySaving || tavilyTesting}>{tavilyTesting ? "正在测试…" : "测试连接"}</button>
          <button type="button" className="secondary-button" onClick={() => setTavilyModalOpen(false)} disabled={tavilySaving || tavilyTesting}>取消</button>
          <button disabled={tavilySaving || tavilyTesting}>{tavilySaving ? "正在保存…" : "保存"}</button>
        </div>
      </form>
    </Modal>}
    {researchProxyModalOpen && <Modal onClose={() => setResearchProxyModalOpen(false)} disabled={researchProxySaving} title="配置检索代理" eyebrow="联网检索服务">
      <form onSubmit={saveResearchProxySettings} className="profile-form">
        <p className="hint">全局检索代理仅作用于联网补研流量（Tavily / Bing / DuckDuckGo 以及可见浏览器检索），与“模型连接级代理”相互独立。留空表示直连。</p>
        <label>检索代理地址<input value={researchProxyInput} onChange={(event) => setResearchProxyInput(event.target.value)} placeholder="例如：http://127.0.0.1:7890 或 socks5://127.0.0.1:1080" /><small>支持 http://、https:// 或 socks5:// 开头的完整地址。地址无效时检索会自动回退为直连，不会卡死。</small></label>
        {researchProxyError && <p className="error" role="alert">保存失败：{researchProxyError}</p>}
        <div className="modal-actions">
          {researchProxyUrl && <button type="button" className="danger-button" onClick={() => void clearResearchProxySettings()} disabled={researchProxySaving}>移除代理</button>}
          <button type="button" className="secondary-button" onClick={() => setResearchProxyModalOpen(false)} disabled={researchProxySaving}>取消</button>
          <button disabled={researchProxySaving}>{researchProxySaving ? "正在保存…" : "保存"}</button>
        </div>
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
    {csdnEntryChoices && <Modal onClose={() => { setCsdnEntryChoices(null); setCsdnDraftSource(undefined); }} disabled={csdnDraftSaving} title="已有 CSDN 渠道稿" wide>
      <section className="csdn-entry-choices">
        <p className="hint">这篇文章已经生成过 CSDN 渠道稿，直接选择进入即可继续编辑；也可以新建一份独立渠道稿。</p>
        <ul className="csdn-entry-list">{csdnEntryChoices.map((choice) => <li key={choice.draft.id}><span><strong>{choice.draft.title || "未命名渠道稿"}</strong><small>{choice.accountName} · {choice.draft.status === "approved" ? "已冻结" : "草稿"} · 更新于 {new Date(choice.draft.updatedAt).toLocaleString()}</small></span><button className="secondary-button" onClick={() => openExistingCsdnDraft(choice)} disabled={csdnDraftSaving}>进入编辑</button></li>)}</ul>
        <button className="text-button" onClick={() => setCsdnEntryChoices(null)} disabled={csdnDraftSaving}>＋ 新建渠道稿</button>
      </section>
    </Modal>}
    {csdnDraftSource && !csdnEntryChoices && <Modal onClose={() => { if (!csdnDraftSaving) { setCsdnDraftSource(undefined); setCsdnDraft(undefined); setCsdnPublishJob(undefined); setCsdnEntryChoices(null); } }} disabled={csdnDraftSaving} title={`CSDN 渠道稿：${csdnDraftSource.title ?? csdnDraftSource.relativePath}`} wide>
      { <section className="csdn-channel-start"><label className="csdn-account-field">目标 CSDN 账号<select value={csdnDraftAccountId} onChange={(event) => setCsdnDraftAccountId(event.target.value)} disabled={csdnDraftSaving}>{accounts.filter((account) => account.platform === "csdn").map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}</select></label><fieldset className="csdn-generation-mode" disabled={csdnDraftSaving}><legend>生成方式</legend><label className={csdnDraftGenerationMode === "rewrite" ? "csdn-mode-option selected" : "csdn-mode-option"}><input type="radio" name="csdn-generation-mode" checked={csdnDraftGenerationMode === "rewrite"} onChange={() => setCsdnDraftGenerationMode("rewrite")} /><span className="csdn-mode-title">阿文改写为 CSDN 调性</span><small>调用“平台稿改写”技能，生成一份独立渠道稿。</small></label><label className={csdnDraftGenerationMode === "source" ? "csdn-mode-option selected" : "csdn-mode-option"}><input type="radio" name="csdn-generation-mode" checked={csdnDraftGenerationMode === "source"} onChange={() => setCsdnDraftGenerationMode("source")} /><span className="csdn-mode-title">直接使用主稿</span><small>不调用 AI，复制主稿正文作为渠道稿；仍会拦截公众号链接和其他禁止引流内容。</small></label></fieldset><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setCsdnDraftSource(undefined)} disabled={csdnDraftSaving}>取消</button><button type="button" onClick={() => void generateCsdnChannelDraft()} disabled={!csdnDraftAccountId || csdnDraftSaving}>{csdnDraftSaving ? (csdnDraftGenerationMode === "rewrite" ? "阿文正在改写…" : "正在复制主稿…") : csdnDraftGenerationMode === "rewrite" ? "生成 CSDN 渠道稿" : "使用主稿创建渠道稿"}</button></div></section>}
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
          <p className="ready"><strong>微信留言</strong><span>{publishNeedOpenComment ? publishOnlyFansCanComment ? "已开启 · 仅关注者可留言" : "已开启 · 所有人可留言" : "已关闭"}</span></p>
          <p className="ready"><strong>微信后台选项</strong><span>{[publishDeclareOriginal ? "申请原创" : "", publishEnableReward ? "开启赞赏" : "", publishCollectionName ? `加入合集：${publishCollectionName}` : ""].filter(Boolean).join(" · ") || "未设置（创建草稿后仍可在微信后台调整）"}</span></p>
        </div>
        <section className="publish-ai-check">
          <div className="detector-switch"><label>检测工具<select value={publishDetector} onChange={(event) => setPublishDetector(event.target.value as "zhuque" | "contentany")}><option value="zhuque">腾讯朱雀</option><option value="contentany">ContentAny</option></select></label><button type="button" className="secondary-button" onClick={() => void (publishDetector === "zhuque" ? runPublishZhuque() : runPublishContentAny())} disabled={publishAiCheckRunning || saving}>{publishAiCheckRunning ? "正在自动检测…" : publishDetector === "zhuque" ? "开始腾讯朱雀检测" : "开始 ContentAny 检测"}</button></div>
          <div><strong>发布前 AIGC 特征检测</strong><small>腾讯朱雀或 ContentAny 任一项完成即可。文渡会自动填入正文、触发检测并读取结果；仅在登录、验证码或页面变化时人工接管。</small></div>
          {publishZhuqueReport ? <ZhuqueReportView report={publishZhuqueReport} /> : publishAiCheckResult && <pre>{publishAiCheckResult}</pre>}
          {publishAiCheckResult && publishAiCheckTool === "zhuque" && <button type="button" className="text-button zhuque-original-button" onClick={() => void openZhuque()}>查看朱雀原始结果窗口</button>}
          {(!publishAiCheckResult || isHighAiDetectionResult(publishAiCheckResult, publishZhuqueReport)) && <label>例外发布理由<textarea value={publishAiOverrideReason} maxLength={1000} onChange={(event) => { publishAiOverrideReasonDirtyRef.current = true; setPublishAiOverrideReason(event.target.value); }} placeholder={publishAiCheckResult ? "检测结果 AI 特征偏高，但仍决定发布的原因" : "仅在任一检测暂时无法完成时填写"} /><small>{publishAiOverrideReason.length}/1000，至少填写 5 个字</small></label>}
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
    {correctingCsdnJob && <Modal onClose={() => setCorrectingCsdnJob(undefined)} disabled={csdnCorrectionSaving} title="人工校正 CSDN 状态" eyebrow="回执异常兜底">
      <form onSubmit={saveCsdnStatusCorrection} className="profile-form status-correction-modal">
        <p className="hint">如果你是在 CSDN 后台直接发布或取消了发布，核实结果后即可立即校正，无需等待。此操作不会再次调用发布接口。</p>
        <div className="status-correction-warning"><strong>请先在 CSDN 后台核实</strong><span>错误标记可能导致后续误判和重复发布。</span></div>
        <label>最终状态<select value={correctedCsdnStatus} disabled={csdnCorrectionSaving} onChange={(event) => setCorrectedCsdnStatus(event.target.value as "published" | "failed" | "cancelled")}><option value="published">已发布</option><option value="failed">发布失败</option><option value="cancelled">取消发布</option></select></label>
        <label>核实依据（可选）<textarea autoFocus value={csdnStatusReason} disabled={csdnCorrectionSaving} onChange={(event) => { setCsdnStatusReason(event.target.value); setCsdnCorrectionError(""); }} maxLength={500} placeholder="例如：在 CSDN 后台“内容管理”确认已发布，文章链接为……" /><small>{csdnStatusReason.length}/500，可留空</small></label>
        {csdnCorrectionError && <p className="error">{csdnCorrectionError}</p>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setCorrectingCsdnJob(undefined)} disabled={csdnCorrectionSaving}>取消</button><button disabled={csdnCorrectionSaving}>{csdnCorrectionSaving ? "正在保存…" : "确认校正"}</button></div>
      </form>
    </Modal>}
    {orphanedWechatJob && <Modal onClose={() => setOrphanedWechatJob(undefined)} disabled={saving} title="找不到本地文章" eyebrow="发布记录需要处理">
      <p>“{orphanedWechatJob.title}”对应的本地文章已经被删除，无法重新设置或同步。你可以保留这条记录用于追溯，也可以只删除这条发布记录。</p>
      <p className="hint">删除发布记录不会删除微信公众号中的草稿或已经发布的文章。</p>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setOrphanedWechatJob(undefined)} disabled={saving}>保留记录</button><button type="button" className="danger-button" onClick={() => void deleteWechatJob()} disabled={saving}>{saving ? "正在删除…" : "删除记录"}</button></div>
    </Modal>}
    {publishCropImage && <CoverCropModal image={publishCropImage} onCancel={() => setPublishCropImage(undefined)} onConfirm={(cropped) => void saveCroppedPublishCover(cropped)} />}

    {sourceModalOpen && <Modal onClose={() => setSourceModalOpen(false)} disabled={saving} title="配置文章库" eyebrow="只读导入预览" wide><p className="hint">选择 VitePress 仓库中的 `docs` 文件夹。只会识别 `posts/文章标题/index.md` 为文章；首页、列表页和排序配置页会自动排除。</p><form onSubmit={scanSource} className="source-form"><label>文章库路径<input autoFocus value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} placeholder="例如：D:\\MySite\\docs" /></label><button type="button" className="secondary-button" onClick={() => void chooseDirectory()}>浏览…</button><button disabled={saving}>{saving ? "正在扫描…" : "保存并扫描"}</button></form>{sourcePreview && <div className="scan-result"><p><strong>发现 {sourcePreview.articleCount} 篇文章</strong><br /><small>{sourcePreview.rootPath}</small></p>{sourcePreview.sitePageCount > 0 && <p className="hint compact-hint">已自动排除 {sourcePreview.sitePageCount} 个站点页、列表页或配置页，不会作为文章导入。</p>}{sourcePreview.warnings.map((warning) => <p className="error" key={warning}>{warning}</p>)}<ul className="preview-list">{sourcePreview.items.map((item) => <li key={item.relativePath}><span><strong>{item.title ?? item.relativePath}</strong><small>{item.relativePath}</small></span><em>{item.frontMatterKeys.length ? item.frontMatterKeys.join(" · ") : "无 Front Matter"}</em></li>)}</ul>{sourcePreview.truncated && <p className="hint">预览已截断，但文章总数已完整统计。</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setSourceModalOpen(false)}>稍后再说</button><button type="button" onClick={() => { setSourceModalOpen(false); openProjectCreator(); }}>下一步：新建文章</button></div></div>}</Modal>}

    {projectModalOpen && <Modal onClose={() => setProjectModalOpen(false)} disabled={saving} title="新建文章" eyebrow="从想法到资料"><p className="hint">创作主题是唯一必填项；它决定文章要讨论什么。写作目标描述希望读者获得什么，两者不重复。阿文会结合账号定位和这些输入直接开始联网补研。</p><form onSubmit={createProject} className="profile-form"><label>创作主题或想法<textarea autoFocus value={projectTopic} onChange={(event) => setProjectTopic(event.target.value)} placeholder="例如：我想写 AI Agent 如何改变个人开发者的工作流" /></label><label>发布账号（可稍后选择）<select value={projectAccountId} onChange={(event) => setProjectAccountId(event.target.value)}><option value="">暂不选择</option>{accounts.map((account) => <option value={account.id} key={account.id}>{platformName(account.platform)} · {account.displayName}</option>)}</select></label><label>写作目标（可选）<textarea value={projectObjective} onChange={(event) => setProjectObjective(event.target.value)} placeholder="希望读者看完理解、判断或完成什么？" /></label><label>目标读者（可选）<textarea value={projectAudience} onChange={(event) => setProjectAudience(event.target.value)} placeholder="例如：需要低成本接入 AI 的个人开发者" /></label><label>核心角度（可选）<textarea value={projectAngle} onChange={(event) => setProjectAngle(event.target.value)} placeholder="这篇文章独特的观点、切入角度或边界" /></label><label>已有资料与想法（可选）<textarea value={projectSourceNotes} onChange={(event) => setProjectSourceNotes(event.target.value)} placeholder="粘贴链接、笔记、数据、个人经历或必须参考的资料" /></label><label>文章标题（可选）<input value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} maxLength={120} placeholder="可先留空，后续可在“编辑创作方向”中让阿文推荐" /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setProjectModalOpen(false)} disabled={saving}>取消</button><button disabled={saving}>{saving ? "正在创建…" : "创建并联网补研"}</button></div></form></Modal>}
    {briefProject && <Modal onClose={closeBrief} disabled={saving} title="确认创作方向" eyebrow="第二步：确认创作方向">{!brief ? <p>正在准备简报…</p> : <><p className="hint">{brief.generatedFromAccountProfile ? "这是根据已选账号定位生成的初始草稿，请补充和调整。" : "你可以继续完善这份已保存的简报。"} 保存后，阿文会默认联网补充资料，再生成文章提纲。</p><form onSubmit={saveBrief} className="profile-form"><label>创作主题或想法<textarea autoFocus value={brief.topic} onChange={(event) => changeBrief("topic", event.target.value)} maxLength={12000} placeholder="这篇文章想讨论的问题、判断或初始构思" /></label><label>写作目标<textarea value={brief.objective} onChange={(event) => changeBrief("objective", event.target.value)} placeholder="希望这篇文章帮助读者完成什么？" /></label><label>目标读者<textarea value={brief.audience} onChange={(event) => changeBrief("audience", event.target.value)} placeholder="这篇文章主要给谁看？" /></label><label>核心角度<textarea value={brief.angle} onChange={(event) => changeBrief("angle", event.target.value)} placeholder="这篇文章独特的观点、切入角度或边界" /></label><label>已有资料与想法<textarea value={brief.sourceNotes} onChange={(event) => changeBrief("sourceNotes", event.target.value)} placeholder="粘贴链接、笔记、数据、个人经历或必须参考的资料" /></label><label>文章标题<input value={briefTitle} onChange={(event) => setBriefTitle(event.target.value)} maxLength={120} placeholder="可直接填写，或让阿文推荐" /></label><div className="inline-actions"><button type="button" className="secondary-button" onClick={() => void suggestBriefTitles()} disabled={titleSuggesting}>{titleSuggesting ? "阿文正在推荐…" : "让阿文推荐标题"}</button></div>{historicalSeries.length > 0 && <p className="hint compact-hint">已用于推荐的历史系列：{historicalSeries.map((series) => `${series.name}（${series.count} 篇）`).join("、")}</p>}{titleSuggestions.length > 0 && <div className="title-suggestion-list">{titleSuggestions.map((title) => <button type="button" className={briefTitle === title ? "selected-title-suggestion" : "secondary-button"} onClick={() => setBriefTitle(title)} key={title}>{title}</button>)}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={closeBrief} disabled={saving}>稍后继续</button><button disabled={saving}>{saving ? "正在保存…" : "保存简报"}</button></div></form></>}</Modal>}
    {researchProject && <Modal onClose={() => { if (!researchGenerating && !researchFollowingUp) { setResearchProject(undefined); setResearch(undefined); setResearchError(""); } }} disabled={researchGenerating || researchFollowingUp} title={`联网资料：${researchProject.topic}`} eyebrow="第三步：补充资料" wide>{researchGenerating || researchFollowingUp ? <div className="generation-progress" role="status"><span className="loading-dot" aria-hidden="true" /><span>{researchStatus || "阿文正在检索官方与公开网页，并整理可追溯资料卡…"}</span></div> : researchError ? <section className="research-follow-up"><h3>联网检索需要处理</h3><p className="error" role="alert">{researchError}</p><p className="hint">若已打开“文渡 · 联网检索协助”窗口，请在该窗口中完成网站要求的验证或登录，再回到这里重试。浏览器会保留该站点会话。</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => { setResearchProject(undefined); setResearch(undefined); setResearchError(""); }}>稍后继续</button><button type="button" onClick={() => void openResearch(researchProject, true)}>完成验证后重试</button></div></section> : !research ? <div className="generation-progress" role="status"><span className="loading-dot" aria-hidden="true" /><span>正在准备资料窗口…</span></div> : <><p className="hint">{researchReadOnly ? "这篇文章已发布，以下资料仅供查看，不可修改。" : "阿文已默认联网补研。保留的资料卡会作为提纲和正文的事实依据；取消勾选后不会再交给写作模型。"}</p><section className="research-plan"><h3>补研结论</h3><pre>{research.planMarkdown}</pre></section><section className="research-sources"><h3>资料卡</h3>{research.sources.map((source) => <article className="research-source-card" key={source.id}><label><input type="checkbox" checked={source.selected} onChange={researchReadOnly ? undefined : () => void toggleResearchSource(source)} disabled={researchReadOnly} /> 用于后续写作</label><strong>{source.sourceType === "official" ? "官方" : "公开"} · {source.title}</strong><a href={source.url} target="_blank" rel="noreferrer">打开来源</a><p>{source.excerpt}</p><ul>{source.keyClaims.map((claim) => <li key={claim}>{claim}</li>)}</ul><small>获取时间：{new Date(source.retrievedAt).toLocaleString()}</small></article>)}</section>{!researchReadOnly && <section className="research-follow-up"><div><h3>继续补研</h3><p className="hint">告诉阿文还缺什么：需要核查的事实、指定来源、时间范围、反例或不想采用的方向。原有资料不会被覆盖；本轮对话会出现在正文编辑器的"与阿文对话"最前面。</p></div><textarea value={researchFollowUp} onChange={(event) => setResearchFollowUp(event.target.value)} maxLength={4000} disabled={researchFollowingUp} placeholder="例如：重点核查 NVIDIA Build 当前免费模型、调用限制和是否需要绑定付款方式；优先官方文档。" /><div className="inline-actions"><button type="button" className="secondary-button" onClick={() => void continueResearch()} disabled={!researchFollowUp.trim() || researchFollowingUp}>{researchFollowingUp ? "阿文正在补研…" : "让阿文继续补研"}</button><small>{researchFollowUp.length}/4000</small></div></section>}<div className="modal-actions">{researchReadOnly ? <button type="button" className="secondary-button" onClick={() => { setResearchProject(undefined); setResearch(undefined); }}>关闭</button> : <><button type="button" className="secondary-button" onClick={() => { setResearchProject(undefined); setResearch(undefined); }}>稍后继续</button><button disabled={researchFollowingUp} onClick={() => { const project = researchProject; setResearchProject(undefined); setResearch(undefined); void openOutline(project); }}>用已选资料生成提纲</button></>}</div></>}</Modal>}
    {outlineProject && <Modal onClose={() => { outlineAbortRef.current?.abort(); setOutlineProject(undefined); setOutline(undefined); setOutlineGenerationStatus(""); }} disabled={saving} title={`文章提纲：${outlineProject.topic}`} eyebrow="第四步：审核文章结构" wide>{!outline ? <p>正在准备提纲…</p> : <><p className="hint">{outlineReadOnly ? "这篇文章已发布，提纲仅供查看，不可编辑。" : outlineGenerating ? "AI 会在可用时逐步写入下方编辑区；可继续等待，或停止后保留已有内容。" : outline.generatedFromBrief ? "这是 AI 根据账号定位、创作简报和已选资料生成的提纲。请审核论证方向和文章结构。" : "你可以继续编辑已保存的提纲。"}</p>{outlineGenerating && <div className="generation-progress" role="status"><span className="loading-dot" aria-hidden="true" /> <span>{outlineGenerationStatus || "AI 正在生成…"}</span></div>}<form onSubmit={saveOutline} className="profile-form"><label>文章提纲</label>{outlineGenerating && !outline.markdown.trim() ? <div className="generation-placeholder">正在等待 AI 的第一段内容。生成过程中可以停止，已生成的内容会保留。</div> : outlineEditorMode === "markdown" ? <div className="markdown-editor-shell"><div className="markdown-mode-toolbar editor-mode-switch" aria-label="编辑模式"><button type="button" className="editor-mode-icon" title="切换到所见即所得编辑" aria-label="切换到所见即所得编辑" onClick={switchOutlineToVisual}>✎</button><button type="button" className="active editor-mode-icon" title="当前：Markdown 原文" aria-label="当前：Markdown 原文">{"</>"}</button></div><textarea ref={outlineMarkdownSourceRef} className="markdown-source-editor" value={outline.markdown} readOnly={outlineReadOnly} onChange={(event) => setOutline((current) => current ? { ...current, markdown: event.target.value } : current)} spellCheck={false} /></div> : <Suspense fallback={<p className="hint">正在打开可视化编辑器…</p>}><VisualMarkdownEditor value={outline.markdown} assetContextId={outlineProject.id} readOnly={outlineReadOnly} onSwitchToMarkdown={switchOutlineToMarkdown} onChange={(markdown) => setOutline((current) => current ? { ...current, markdown } : current)} /></Suspense>}<div className="modal-actions">{outlineReadOnly ? <button type="button" className="secondary-button" onClick={() => { outlineAbortRef.current?.abort(); setOutlineProject(undefined); setOutline(undefined); setOutlineGenerationStatus(""); }}>关闭</button> : <>{outlineGenerating && <button type="button" className="secondary-button" onClick={() => outlineAbortRef.current?.abort()}>停止生成</button>}<button type="button" className="secondary-button" onClick={() => { outlineAbortRef.current?.abort(); setOutlineProject(undefined); setOutline(undefined); setOutlineGenerationStatus(""); }} disabled={saving}>稍后继续</button><button disabled={saving || outlineGenerating || !outline.markdown.trim()}>{saving ? "正在保存…" : "确认并保存提纲"}</button></>}</div></form></>}</Modal>}
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
  generationStatus = "",
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
  generationStatus?: string;
  onStopGeneration?: () => void;
  onChange: (markdown: string) => void;
  onBack: () => void;
  onSave: () => Promise<{ success: boolean; markdown?: string; error?: string }>;
  onPublish?: () => void;
}) {
  const [rightPanel, setRightPanel] = useState<"assistant" | "preview" | "settings">(initialRightPanel);
  const [editorMode, setEditorMode] = useState<"visual" | "markdown">("visual");
  const [modeScrollOffset, setModeScrollOffset] = useState(0);
  const markdownSourceRef = useRef<HTMLTextAreaElement>(null);
  const [leftTool, setLeftTool] = useState<"body" | "structure" | "sources" | "images">("body");
  const [articleSettings, setArticleSettings] = useState<ArticleSettings>({
    author: "",
    digest: "",
    coverSource: "",
    coverPrompt: "",
    accountId: "",
    needOpenComment: true,
    onlyFansCanComment: false,
    declareOriginal: false,
    enableReward: false,
    collectionName: ""
  });
  const [authorHistory, setAuthorHistory] = useState<string[]>([]);
  const [collectionHistory, setCollectionHistory] = useState<string[]>([]);
  const [collectionsSyncedAt, setCollectionsSyncedAt] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState("");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [coverCropImage, setCoverCropImage] = useState<SelectedImage>();
  const [settingsMaterials, setSettingsMaterials] = useState<WechatMaterial[]>([]);
  const [settingsCoverProvider, setSettingsCoverProvider] = useState<"modelscope" | "agnes">("modelscope");
  const [settingsCoverPrompt, setSettingsCoverPrompt] = useState("");
  const [settingsCoverBusy, setSettingsCoverBusy] = useState(false);
  const [settingsCoverError, setSettingsCoverError] = useState("");
  const [settingsCoverPromptBusy, setSettingsCoverPromptBusy] = useState(false);
  const [settingsSummaryBusy, setSettingsSummaryBusy] = useState(false);
  const [selectionRange, setSelectionRange] = useState<{ start: number; end: number }>();
  const [selectionDocumentMarkdown, setSelectionDocumentMarkdown] = useState<string>();
  const [selectionAiAction, setSelectionAiAction] = useState<"rewrite" | "expand" | "shorten" | "example" | "humanize">("humanize");
  const [selectionAiInstruction, setSelectionAiInstruction] = useState("");
  const [selectionAiBusy, setSelectionAiBusy] = useState(false);
  const [selectionAiResult, setSelectionAiResult] = useState("");
  const [selectionAiOriginal, setSelectionAiOriginal] = useState("");
  const [selectionComparisonOpen, setSelectionComparisonOpen] = useState(false);
  const [selectionDetectionTool, setSelectionDetectionTool] = useState<"zhuque" | "contentany">("zhuque");
  const [selectionDetectionBusy, setSelectionDetectionBusy] = useState(false);
  const [selectionDetectionResult, setSelectionDetectionResult] = useState("");
  const [selectionContentAnyReference, setSelectionContentAnyReference] = useState<ContentAnyReference>();
  const [selectionZhuqueReport, setSelectionZhuqueReport] = useState<ZhuqueReport>();
  const [awenOpen, setAwenOpen] = useState(false);
  const [awenMessages, setAwenMessages] = useState<ArticleChatMessage[]>([]);
  const [awenMemory, setAwenMemory] = useState("");
  const [awenInput, setAwenInput] = useState("");
  const [awenLoading, setAwenLoading] = useState(false);
  const [awenLoaded, setAwenLoaded] = useState(false);
  const [awenSuggestionOffsets, setAwenSuggestionOffsets] = useState<Record<string, { x: number; y: number }>>({});
  const [savedMarkdown, setSavedMarkdown] = useState(markdown);
  const [savedSettings, setSavedSettings] = useState<ArticleSettings>({
    author: "",
    digest: "",
    coverSource: "",
    coverPrompt: "",
    accountId: "",
    needOpenComment: true,
    onlyFansCanComment: false,
    declareOriginal: false,
    enableReward: false,
    collectionName: ""
  });
  const contextKey = sourceArticlePath ? `source:${sourceArticlePath}` : `project:${projectId ?? assetContextId}`;
  const switchToMarkdown = (offset: number) => {
    setModeScrollOffset(offset);
    setEditorMode("markdown");
  };
  const switchToVisual = () => {
    const textarea = markdownSourceRef.current;
    setModeScrollOffset(textarea ? markdownOffsetAtTextareaTop(textarea, markdown) : modeScrollOffset);
    setEditorMode("visual");
  };
  useEffect(() => {
    if (editorMode !== "markdown") return;
    requestAnimationFrame(() => {
      const textarea = markdownSourceRef.current;
      const canvas = textarea?.closest<HTMLElement>(".editor-canvas");
      if (canvas) canvas.scrollTop = 0;
      scrollTextareaToMarkdownOffset(textarea, markdown, modeScrollOffset);
    });
  }, [editorMode, modeScrollOffset]);
  const openAwen = async () => {
    setAwenOpen(true);
    if (awenLoaded) return;
    try {
      const chat = await request<{ memory: string; messages: ArticleChatMessage[] }>(`/article-chat?contextKey=${encodeURIComponent(contextKey)}`);
      const normalized = removeUnavailableAwenSuggestions(markUnansweredAwenMessages(chat.messages), markdown);
      setAwenMemory(chat.memory);
      setAwenMessages(normalized.messages);
      setAwenLoaded(true);
      // Suggestions whose original text no longer exists have already been
      // applied or superseded by a manual edit. Remove their persisted copy so
      // they cannot resurface on the next launch either.
      for (const stale of normalized.staleSuggestions) {
        try {
          await request(`/article-chat/messages/${encodeURIComponent(stale.messageId)}/suggestions/${stale.index}`, { method: "PATCH", body: JSON.stringify({ status: "unavailable" }) });
        } catch {
          // The current session has already hidden it. A later open can retry
          // cleanup without interrupting the author with a non-actionable error.
        }
      }
    } catch (cause) { setWorkspaceError(cause instanceof Error ? cause.message : "无法读取阿文的本文会话。"); }
  };
  const sendAwenMessage = async (retryMessage?: ArticleChatMessage) => {
    const message = retryMessage?.content ?? awenInput.trim();
    if (!message || awenLoading) return;
    const optimistic: ArticleChatMessage = retryMessage
      ? { ...retryMessage, deliveryState: "sending" }
      : { id: crypto.randomUUID(), role: "user", content: message, memorySuggestion: "", suggestions: [], createdAt: new Date().toISOString(), deliveryState: "sending" };
    if (retryMessage) setAwenMessages((current) => current.map((item) => item.id === retryMessage.id ? optimistic : item));
    else {
      setAwenInput("");
      setAwenMessages((current) => [...current, optimistic]);
    }
    setAwenLoading(true);
    try {
      const result = await request<{ message: ArticleChatMessage; memory: string }>("/article-chat/messages", { method: "POST", body: JSON.stringify({ contextKey, clientMessageId: optimistic.id, accountId: articleSettings.accountId || undefined, title, markdown, message }) });
      setAwenMessages((current) => [...current.filter((item) => item.id !== optimistic.id), { ...optimistic, id: result.message.id, deliveryState: undefined }, result.message]);
      setAwenMemory(result.memory);
      setAwenLoaded(true);
    } catch (cause) {
      // The server stores the user message before it calls the model. Do not
      // erase an optimistic message on an interrupted model/network request:
      // disappearing author input is worse than a visible failure state.
      setAwenMessages((current) => current.map((item) => item.id === optimistic.id ? { ...item, deliveryState: "failed" } : item));
      setWorkspaceError(cause instanceof Error ? cause.message : "阿文暂时无法回答。你的消息已保留，请稍后重新提问。");
    } finally { setAwenLoading(false); }
  };
  const rememberAwenSuggestion = async (memory: string) => {
    try {
      const result = await request<{ memory: string }>("/article-chat/memory", { method: "POST", body: JSON.stringify({ contextKey, memory }) });
      setAwenMemory(result.memory);
    } catch (cause) { setWorkspaceError(cause instanceof Error ? cause.message : "无法保存本文记忆。"); }
  };
  useEffect(() => {
    void Promise.all([
      request<ArticleSettings>(`/article-settings?contextKey=${encodeURIComponent(contextKey)}`),
      request<{ items: string[] }>("/article-settings/authors")
    ]).then(([settings, authors]) => {
      setArticleSettings(settings);
      setSettingsCoverPrompt(settings.coverPrompt);
      setSavedSettings(settings);
      setAuthorHistory(authors.items);
    }).catch((cause) => setWorkspaceError(cause instanceof Error ? cause.message : "无法读取文章设置。"));
  }, [contextKey]);
  useEffect(() => {
    const accountQuery = articleSettings.accountId ? `?accountId=${encodeURIComponent(articleSettings.accountId)}` : "";
    const loadCollections = () => request<{ items: string[]; syncedAt: string | null }>(`/article-settings/collections${accountQuery}`)
      .then((result) => { setCollectionHistory(result.items); setCollectionsSyncedAt(result.syncedAt); })
      .catch(() => { setCollectionHistory([]); setCollectionsSyncedAt(null); });
    void loadCollections();
    // A visible WeChat editor runs in a separate Electron window. Refresh the
    // cached suggestions when the author returns to 文渡 after that picker has
    // reported the real options back to the local service.
    window.addEventListener("focus", loadCollections);
    return () => window.removeEventListener("focus", loadCollections);
  }, [articleSettings.accountId]);

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
      setSettingsCoverError("请先让 AI 根据正文生成封面提示词，或自行填写提示词。");
      return;
    }
    setSettingsCoverError("");
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
      setArticleSettings((current) => ({ ...current, coverSource: generated.assetUrl, coverPrompt: settingsCoverPrompt }));
      setSettingsCoverError("");
    } catch (cause) {
      setSettingsCoverError(cause instanceof Error ? cause.message : "AI 封面生成失败。");
    } finally {
      setSettingsCoverBusy(false);
    }
  };
  const generateSettingsCoverPrompt = async () => {
    setSettingsCoverError("");
    setSettingsCoverPromptBusy(true);
    try {
      const generated = await request<{ prompt: string }>("/skills/cover-prompt-generation/run", {
        method: "POST",
        body: JSON.stringify({ title, markdown })
      });
      setSettingsCoverPrompt(generated.prompt);
      setArticleSettings((current) => ({ ...current, coverPrompt: generated.prompt }));
      setSettingsCoverError("");
    } catch (cause) {
      setSettingsCoverError(cause instanceof Error ? cause.message : "封面提示词生成失败。");
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
  const captureVisualSelection = (selection?: { selectedMarkdown: string; documentMarkdown: string }) => {
    setSelectionAiResult("");
    setSelectionAiOriginal("");
    setSelectionComparisonOpen(false);
    if (!selection) {
      setSelectionRange(undefined);
      setSelectionDocumentMarkdown(undefined);
      return;
    }
    const range = locateMarkdownSelection(selection.documentMarkdown, selection.selectedMarkdown);
    if (!range) {
      setSelectionRange(undefined);
      setSelectionDocumentMarkdown(undefined);
      setWorkspaceError("暂时无法准确定位这段选区；可能是相同内容出现多次。请缩小选区，或切换到 Markdown 原文模式后重试。");
      return;
    }
    setSelectionRange(range);
    setSelectionDocumentMarkdown(selection.documentMarkdown);
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
      const selectionSource = selectionDocumentMarkdown ?? markdown;
      const selectedText = selectionSource.slice(selectionRange.start, selectionRange.end);
      const generated = await request<{ replacement: string; conversation?: { userMessage: ArticleChatMessage; assistantMessage: ArticleChatMessage } }>("/skills/selection-edit/run", {
        method: "POST",
        body: JSON.stringify({
          action: selectionAiAction,
          title,
          contextKey,
          instruction: selectionAiInstruction.trim(),
          selectedText,
          beforeText: selectionSource.slice(Math.max(0, selectionRange.start - 3000), selectionRange.start),
          afterText: selectionSource.slice(selectionRange.end, selectionRange.end + 3000)
        })
      });
      setSelectionAiOriginal(selectedText);
      setSelectionAiResult(generated.replacement);
      const conversation = generated.conversation;
      if (conversation) {
        setAwenOpen(true);
        setAwenLoaded(true);
        setAwenMessages((current) => [...current.filter((item) => item.id !== conversation.userMessage.id && item.id !== conversation.assistantMessage.id), conversation.userMessage, conversation.assistantMessage]);
      }
      setWorkspaceError("");
    } catch (cause) {
      setWorkspaceError(cause instanceof Error ? cause.message : "选区 AI 处理失败。");
    } finally {
      setSelectionAiBusy(false);
    }
  };
  const applySelectionAiResult = (replacement: string | React.MouseEvent = selectionAiResult) => {
    const resolvedReplacement = typeof replacement === "string" ? replacement : selectionAiResult;
    if (!selectionRange || !resolvedReplacement) return;
    const selectionSource = selectionDocumentMarkdown ?? markdown;
    onChange(`${selectionSource.slice(0, selectionRange.start)}${resolvedReplacement}${selectionSource.slice(selectionRange.end)}`);
    setSelectionRange(undefined);
    setSelectionDocumentMarkdown(undefined);
    setSelectionAiResult("");
    setSelectionAiOriginal("");
    setSelectionComparisonOpen(false);
  };
  const persistEditorAigcDetection = async (aiCheckResult: string, aiCheckReport: string) => {
    const existing = await request<{ overrideReason: string }>(`/article-quality-check?contextKey=${encodeURIComponent(contextKey)}`);
    await request("/article-quality-check", {
      method: "PUT",
      body: JSON.stringify({
        contextKey,
        aiCheckResult,
        aiCheckReport,
        overrideReason: existing.overrideReason
      })
    });
  };
  const importPastedRemoteMarkdownImage = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = event.clipboardData.getData("text/plain").trim();
    const image = /^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+["'][^"']*["'])?\)$/i.exec(text);
    if (!image) return;
    event.preventDefault();
    const textarea = event.currentTarget;
    const before = markdown;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    setWorkspaceError("正在下载远程图片并保存到本地素材目录…");
    try {
      const endpoint = sourceArticlePath ? "/content-source/article-asset/import-remote" : "/content-assets/import-remote";
      const saved = await request<{ assetUrl: string }>(endpoint, {
        method: "POST",
        body: JSON.stringify(sourceArticlePath ? { path: sourceArticlePath, url: image[2] } : { contextId: assetContextId, url: image[2] })
      });
      onChange(`${before.slice(0, start)}![${image[1] || "图片"}](${saved.assetUrl})${before.slice(end)}`);
      setWorkspaceError("");
    } catch (cause) {
      setWorkspaceError(cause instanceof Error ? cause.message : "远程图片下载失败。");
    }
  };
  const runSelectionDetection = async () => {
    const hasSelection = Boolean(selectionRange && selectionRange.end > selectionRange.start);
    const selectionSource = selectionDocumentMarkdown ?? markdown;
    const textToDetect = hasSelection && selectionRange
      ? selectionSource.slice(selectionRange.start, selectionRange.end)
      : markdown;
    if (!textToDetect.trim()) {
      setWorkspaceError("正文为空，暂时没有可检测的内容。");
      return;
    }
    setSelectionDetectionBusy(true);
    setSelectionDetectionResult("");
    setSelectionContentAnyReference(undefined);
    setSelectionZhuqueReport(undefined);
    try {
      if (!window.contentFerry) throw new Error("当前桌面环境未启用 AIGC 检测能力。");
      const desktop = window.contentFerry;
      if (selectionDetectionTool === "zhuque") {
        const result = await desktop.runZhuqueDetection(textToDetect);
        if (result.status !== "completed" || !result.report) throw new Error(result.message || "腾讯朱雀未返回可用检测结果。");
        setSelectionZhuqueReport(result.report);
        if (!hasSelection) await persistEditorAigcDetection(result.result || "腾讯朱雀检测已完成。", JSON.stringify(result.report));
      } else {
        const result = await desktop.runContentAnyDetection(textToDetect);
        if (result.status !== "completed") throw new Error(result.message || "ContentAny 未返回可用检测结果。");
        const value = `ContentAny 检测：\n${result.result || "已完成检测，未返回可展示的文字结果。"}`;
        setSelectionDetectionResult(value);
        setSelectionContentAnyReference(result.reference);
        if (!hasSelection) await persistEditorAigcDetection(value, "");
      }
      setWorkspaceError("");
    } catch (cause) {
      setWorkspaceError(cause instanceof Error ? cause.message : "AIGC 特征检测失败。");
    } finally {
      setSelectionDetectionBusy(false);
    }
  };
  const awenSuggestions = awenMessages.flatMap((message) => message.role === "assistant"
    ? message.suggestions.flatMap((suggestion, index) => !suggestion.status || suggestion.status === "pending"
      ? [{ ...suggestion, id: `${message.id}:${index}` }]
      : [])
    : []);
  const setAwenSuggestionStatusInView = (messageId: string, index: number, status: ArticleChatSuggestion["status"]) => {
    setAwenSuggestionOffsets((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([id]) => !id.startsWith(`${messageId}:`)));
      return next;
    });
    setAwenMessages((current) => current.map((message) => message.id === messageId ? { ...message, suggestions: message.suggestions.map((item, itemIndex) => itemIndex === index ? { ...item, status } : item) } : message));
  };
  const dismissAwenSuggestion = async (id: string) => {
    const [messageId, rawIndex] = id.split(":");
    const index = Number(rawIndex);
    if (!messageId || !Number.isInteger(index)) return;
    try {
      await request(`/article-chat/messages/${encodeURIComponent(messageId)}/suggestions/${index}`, { method: "PATCH", body: JSON.stringify({ status: "rejected" }) });
      setAwenSuggestionStatusInView(messageId, index, "rejected");
    } catch (cause) { setWorkspaceError(cause instanceof Error ? cause.message : "无法保存阿文建议的处理状态。"); }
  };
  const applyAwenSuggestion = async (id: string) => {
    const suggestion = awenSuggestions.find((item) => item.id === id);
    if (!suggestion) return;
    const [messageId, rawIndex] = id.split(":");
    const index = Number(rawIndex);
    if (!messageId || !Number.isInteger(index)) return;
    const first = markdown.indexOf(suggestion.original);
    if (first < 0 || markdown.indexOf(suggestion.original, first + suggestion.original.length) >= 0) {
      setWorkspaceError("这条阿文建议已无法准确定位到原文；可能正文已经修改。请重新向阿文提问。");
      try {
        await request(`/article-chat/messages/${encodeURIComponent(messageId)}/suggestions/${index}`, { method: "PATCH", body: JSON.stringify({ status: "unavailable" }) });
        setAwenSuggestionStatusInView(messageId, index, "unavailable");
      } catch (cause) { setWorkspaceError(cause instanceof Error ? cause.message : "无法保存阿文建议的处理状态。"); }
      return;
    }
    try {
      await request(`/article-chat/messages/${encodeURIComponent(messageId)}/suggestions/${index}`, { method: "PATCH", body: JSON.stringify({ status: "accepted" }) });
      onChange(`${markdown.slice(0, first)}${suggestion.replacement}${markdown.slice(first + suggestion.original.length)}`);
      setAwenSuggestionStatusInView(messageId, index, "accepted");
    } catch (cause) { setWorkspaceError(cause instanceof Error ? cause.message : "无法保存阿文建议的处理状态。"); }
  };
  const wordCount = markdown.replace(/[#>*_`\-\[\]()]/g, "").replace(/\s/g, "").length;
  const images = extractMarkdownImages(markdown);
  const coverCandidates = images.filter((image) => sourceArticlePath
    ? !/^https?:\/\//i.test(image.src)
    : image.src.startsWith("contentferry-asset://"));
  const headings = markdown.split(/\r?\n/).map((line) => /^(#{1,6})\s+(.+)$/.exec(line)).filter((value): value is RegExpExecArray => Boolean(value));
  const sources = [...new Set([...markdown.matchAll(/https?:\/\/[^\s)>]+/g)].map((match) => match[0]))];
  const editorBusy = saving || settingsSaving || settingsCoverPromptBusy || settingsSummaryBusy;
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
  return <div className={`editor-workspace${awenOpen ? " with-awen-panel" : ""}`}>
    <header className="editor-topbar">
      <button className="secondary-button" onClick={leaveWorkspace}>← 返回内容库</button>
      <div className="editor-document-title"><strong>{title}</strong></div>
      <div className="editor-top-actions"><span title={generating ? generationStatus : undefined}>{generating ? (generationStatus || "AI 正在起草正文…") : busy ? "正在保存…" : hasUnsavedChanges ? "有未保存修改" : "已保存"}</span>{generating && <button className="secondary-button" onClick={onStopGeneration}>停止生成</button>}<button onClick={() => void saveArticleAndSettings()} disabled={busy || generating || !hasUnsavedChanges}>保存文章</button>{onPublish && <button onClick={() => void prepareFromWorkspace()} disabled={busy || generating}>准备发布</button>}</div>
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
      <section className={`editor-canvas${editorMode === "markdown" ? " markdown-mode" : ""}`}>
        {workspaceError && <p className="error editor-inline-error">{workspaceError}</p>}
        {generating && !markdown.trim() ? <div className="generation-placeholder editor-generation-placeholder" role="status"><span className="loading-dot" aria-hidden="true" /><span>{generationStatus || "正在等待 AI 的第一段正文内容…"}</span><small>收到内容后会直接显示在编辑器中；你可以随时停止并保留已生成的部分。</small></div> : editorMode === "visual" ? <Suspense fallback={<p className="hint">正在打开文章编辑器…</p>}>
          <VisualMarkdownEditor key={sourceArticlePath ?? assetContextId} value={markdown} assetContextId={assetContextId} sourceArticlePath={sourceArticlePath} minHeight={680} initialScrollOffset={modeScrollOffset} onSwitchToMarkdown={switchToMarkdown} suggestions={awenSuggestions} suggestionOffsets={awenSuggestionOffsets} onSuggestionOffsetChange={(id, offset) => setAwenSuggestionOffsets((current) => ({ ...current, [id]: offset }))} onAcceptSuggestion={(id) => void applyAwenSuggestion(id)} onRejectSuggestion={(id) => void dismissAwenSuggestion(id)} onChange={onChange} onError={setWorkspaceError} onTextSelection={captureVisualSelection} />
        </Suspense> : <div className="markdown-editor-shell"><div className="markdown-mode-toolbar editor-mode-switch" aria-label="编辑模式"><button type="button" className="editor-mode-icon" title="切换到所见即所得编辑" aria-label="切换到所见即所得编辑" onClick={switchToVisual}>✎</button><button type="button" className="active editor-mode-icon" title="当前：Markdown 原文" aria-label="当前：Markdown 原文">{"</>"}</button></div><textarea ref={markdownSourceRef} className="markdown-source-editor" value={markdown} onChange={(event) => onChange(event.target.value)} onPaste={(event) => void importPastedRemoteMarkdownImage(event)} onSelect={(event) => { const target = event.currentTarget; const selected = target.selectionEnd > target.selectionStart; setSelectionRange(selected ? { start: target.selectionStart, end: target.selectionEnd } : undefined); setSelectionDocumentMarkdown(selected ? markdown : undefined); if (selected) { setSelectionAiAction("humanize"); setRightPanel("assistant"); } setSelectionAiResult(""); }} spellCheck={false} /></div>}
      </section>
      <aside className="editor-right-panel">
        <div className="panel-tabs">
          <button className={rightPanel === "assistant" ? "active" : ""} onClick={() => setRightPanel("assistant")}>AI 助手</button>
          <button className={rightPanel === "preview" ? "active" : ""} onClick={() => setRightPanel("preview")}>手机预览</button>
          <button className={rightPanel === "settings" ? "active" : ""} onClick={() => setRightPanel("settings")}>文章设置</button>
        </div>
        {rightPanel === "assistant" && <div className="side-panel-content selection-assistant"><div className="assistant-heading"><div><h3>AI 处理选中文字</h3><small>选中正文后可改写、去 AI 味或检测。</small></div><button type="button" className="secondary-button compact-action" onClick={() => void openAwen()}>与阿文讨论本文</button></div>{selectionRange ? <><p className="selection-ready">已选中 {selectionRange.end - selectionRange.start} 个字符，默认使用“去 AI 味”。</p><blockquote>{(selectionDocumentMarkdown ?? markdown).slice(selectionRange.start, selectionRange.end)}</blockquote></> : <div className="selection-guide"><strong>先选中一段正文，再让 AI 处理</strong><p>生成建议后可比较、选择部分修改，再决定是否应用。</p></div>}<div className="selection-action-grid">{([["humanize", "去 AI 味"], ["rewrite", "改写"], ["expand", "扩写"], ["shorten", "缩写"], ["example", "补充案例"]] as const).map(([value, label]) => <button type="button" className={selectionAiAction === value ? "active" : ""} onClick={() => setSelectionAiAction(value)} key={value}>{label}</button>)}</div><label className="selection-instruction"><span>补充要求（可选）</span><textarea value={selectionAiInstruction} onChange={(event) => setSelectionAiInstruction(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void runSelectionAi(); } }} disabled={!selectionRange || selectionAiBusy} maxLength={1000} placeholder="例如：保留技术术语，语气更直接；不要使用营销化表达" /></label><button type="button" onClick={() => void runSelectionAi()} disabled={!selectionRange || selectionAiBusy}>{selectionAiBusy ? "AI 正在处理…" : selectionAiAction === "humanize" ? "AI 去 AI 味（先预览）" : "生成替换建议（先预览）"}</button>{selectionAiResult && <div className="selection-result"><strong>AI 建议，不会自动覆盖原文</strong><pre>{selectionAiResult}</pre><div className="selection-result-actions"><button type="button" className="secondary-button" onClick={() => setSelectionComparisonOpen(true)}>对比修改</button><button type="button" className="secondary-button" onClick={() => { setSelectionAiResult(""); setSelectionAiOriginal(""); }}>放弃</button><button type="button" onClick={applySelectionAiResult}>用建议替换选中文字</button></div></div>}<small>“去 AI 味”的处理规则来自“技能与模型”中的“文章选区去 AI 味”技能，可单独修改和切换模型。</small></div>}
        {rightPanel === "assistant" && <div className="side-panel-content selection-detection"><h3>AIGC 特征检测</h3><p>{selectionRange ? "针对当前选中段落检测；朱雀或 ContentAny 任一结果都可作为优化参考。" : "未选中段落时会检测当前文章全文；朱雀或 ContentAny 任一结果都可作为优化参考。"}</p><div className="selection-detection-controls"><select value={selectionDetectionTool} onChange={(event) => setSelectionDetectionTool(event.target.value as "zhuque" | "contentany")}><option value="zhuque">腾讯朱雀</option><option value="contentany">ContentAny</option></select><button type="button" className="secondary-button" onClick={() => void runSelectionDetection()} disabled={!markdown.trim() || selectionDetectionBusy}>{selectionDetectionBusy ? "正在检测…" : selectionRange ? "检测选中内容" : "检测全文内容"}</button></div>{!selectionRange && <small>你也可以先选中一段文字，只检测这一段。</small>}{selectionZhuqueReport && <ZhuqueReportView report={selectionZhuqueReport} />}{selectionContentAnyReference && <ContentAnyReferenceView reference={selectionContentAnyReference} />}{selectionDetectionResult && !selectionContentAnyReference && <pre className="selection-detection-result">{selectionDetectionResult}</pre>}</div>}
        {rightPanel === "preview" && <div className="phone-frame"><div className="phone-screen"><h2>{title}</h2><small className="phone-byline">{articleSettings.author || selectedSettingsAccount?.displayName || "未填写作者"}</small>{renderPhonePreview(markdown, assetContextId, sourceArticlePath, title)}</div></div>}
        {rightPanel === "settings" && <div className="side-panel-content">
          <h3>发布设置</h3>
          <label>发布账号
            <select value={articleSettings.accountId} onChange={(event) => {
              setArticleSettings((current) => ({ ...current, accountId: event.target.value }));
              setSettingsMaterials([]);
            }}>
              <option value="">请选择发布账号</option>
              {accounts.map((account) => <option value={account.id} key={account.id}>{platformName(account.platform)} · {account.displayName}</option>)}
            </select>
            <small>选择后会随文章保存；发布前仍可更改。</small>
          </label>
          <label>作者<input list={`author-history-${assetContextId}`} value={articleSettings.author} maxLength={16} onChange={(event) => setArticleSettings((current) => ({ ...current, author: event.target.value }))} placeholder="可输入或选择过去使用过的作者" /><datalist id={`author-history-${assetContextId}`}>{authorHistory.map((author) => <option value={author} key={author} />)}</datalist><small>{articleSettings.author.length}/16 字</small></label>
          <label>摘要
            <textarea value={articleSettings.digest} maxLength={digestMaxLength} onChange={(event) => setArticleSettings((current) => ({ ...current, digest: event.target.value }))} placeholder={`用于${selectedSettingsAccount ? platformName(selectedSettingsAccount.platform) : "目标平台"}的内容卡片和分享，最多 ${digestMaxLength} 字`} />
            <small>{articleSettings.digest.length}/{digestMaxLength} 字{selectedSettingsAccount ? ` · ${platformName(selectedSettingsAccount.platform)}限制` : " · 选择账号后按平台适配"}</small>
            <button type="button" className="secondary-button" onClick={() => void generateArticleSummary()} disabled={busy}>{settingsSummaryBusy ? "AI 正在提炼摘要…" : "AI 生成适配摘要"}</button>
          </label>
          {selectedSettingsAccount?.platform === "wechat_official" && <fieldset className="wechat-comment-settings">
            <legend>微信留言</legend>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={articleSettings.needOpenComment}
                onChange={(event) => setArticleSettings((current) => ({
                  ...current,
                  needOpenComment: event.target.checked,
                  onlyFansCanComment: event.target.checked ? current.onlyFansCanComment : false
                }))}
              />
              <span><strong>开启留言</strong><small>默认开启；同步到微信草稿箱时一并设置。</small></span>
            </label>
            <label>谁可以留言
              <select
                value={articleSettings.onlyFansCanComment ? "fans" : "all"}
                disabled={!articleSettings.needOpenComment}
                onChange={(event) => setArticleSettings((current) => ({ ...current, onlyFansCanComment: event.target.value === "fans" }))}
              >
                <option value="all">所有人</option>
                <option value="fans">仅关注者</option>
              </select>
              <small>{articleSettings.needOpenComment ? "该设置由微信草稿接口支持。" : "开启留言后可设置留言范围。"}</small>
            </label>
          </fieldset>}
          {selectedSettingsAccount?.platform === "wechat_official" && <fieldset className="wechat-comment-settings">
            <legend>微信发布选项</legend>
            <label className="checkbox-row">
              <input type="checkbox" checked={articleSettings.declareOriginal} onChange={(event) => setArticleSettings((current) => ({ ...current, declareOriginal: event.target.checked }))} />
              <span><strong>申请原创声明</strong><small>创建草稿后，文渡会在微信后台尝试打开并开启该选项；平台审核结果以微信为准。</small></span>
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={articleSettings.enableReward} onChange={(event) => setArticleSettings((current) => ({ ...current, enableReward: event.target.checked }))} />
              <span><strong>开启赞赏</strong><small>创建草稿后由可见浏览器尝试设置；无法可靠确认时会保留在对应页面供你确认。</small></span>
            </label>
            <label>加入合集
              <input list="wechat-collection-options" value={articleSettings.collectionName} maxLength={80} onChange={(event) => setArticleSettings((current) => ({ ...current, collectionName: event.target.value }))} placeholder="输入或选择微信公众号已有合集的完整名称（可留空）" />
              <datalist id="wechat-collection-options">{collectionHistory.map((name) => <option key={name} value={name} />)}</datalist>
              <small>{collectionsSyncedAt
                ? `已从微信后台同步可见合集：${new Date(collectionsSyncedAt).toLocaleString()}；也可手工输入。发布时只选择微信后台完整匹配项。`
                : collectionHistory.length > 0
                  ? "可从文渡已知的合集名称中选择，也可手工输入；首次在微信后台打开“选择合集”后会同步可见选项。"
                  : "可手工输入合集名称；首次在微信后台打开“选择合集”后，文渡会同步可见的现有合集供下次选择。"}</small>
            </label>
          </fieldset>}
          <div className="settings-cover-section">
            <strong>封面</strong>
            {articleSettings.coverSource && <><img className="settings-cover-preview" src={resolveArticleImageUrl(articleSettings.coverSource, assetContextId, sourceArticlePath)} alt="文章封面" /><button type="button" className="text-button danger-text" onClick={() => setArticleSettings((current) => ({ ...current, coverSource: "" }))}>移除封面</button></>}
            <button type="button" className="secondary-button" onClick={() => void chooseArticleCover()}>选择本地图片并裁剪</button>
            {coverCandidates.length > 0 && <details><summary>从正文图片选择</summary><div className="article-cover-choices">{coverCandidates.map((image, index) => <button type="button" key={`${image.src}-${index}`} onClick={() => void cropExistingCover(resolveArticleImageUrl(image.src, assetContextId, sourceArticlePath), image.alt || `正文图片-${index + 1}.png`)}><img src={resolveArticleImageUrl(image.src, assetContextId, sourceArticlePath)} alt={image.alt || "正文图片"} /><small>选择并裁剪</small></button>)}</div></details>}
            {articleSettings.accountId && accounts.find((account) => account.id === articleSettings.accountId)?.platform === "wechat_official" && <details><summary>从微信素材库选择</summary><button type="button" className="secondary-button" onClick={() => void loadSettingsMaterials()} disabled={settingsCoverBusy}>加载最近图片</button>{settingsMaterials.length > 0 && <div className="article-cover-choices">{settingsMaterials.map((material) => <button type="button" key={material.mediaId} onClick={() => void chooseSettingsMaterial(material)}><img src={`${apiBase}/integrations/wechat/accounts/${articleSettings.accountId}/materials/images/${encodeURIComponent(material.mediaId)}`} alt={material.name || "微信素材"} /><small>{material.name || "未命名图片"}</small></button>)}</div>}</details>}
            <details className="ai-cover-details">
              <summary>AI 生成封面</summary>
              <label>图片模型
                <select value={settingsCoverProvider} onChange={(event) => { setSettingsCoverProvider(event.target.value as "modelscope" | "agnes"); setSettingsCoverError(""); }}>
                  <option value="modelscope">ModelScope</option>
                  <option value="agnes">Agnes AI</option>
                </select>
              </label>
              <div className="cover-prompt-heading"><strong>封面提示词</strong><button type="button" className="secondary-button compact-action" onClick={() => void generateSettingsCoverPrompt()} disabled={settingsCoverPromptBusy || settingsCoverBusy}>{settingsCoverPromptBusy ? "AI 正在分析正文…" : settingsCoverPrompt.trim() ? "重新生成提示词" : "AI 根据正文生成提示词"}</button></div>
              <textarea value={settingsCoverPrompt} maxLength={2000} onChange={(event) => { setSettingsCoverPrompt(event.target.value); setArticleSettings((current) => ({ ...current, coverPrompt: event.target.value })); setSettingsCoverError(""); }} placeholder="可以自己填写，也可以让 AI 根据标题和正文生成；生成后仍可修改构图、风格和是否包含文字" />
              <small>{settingsCoverPrompt.length}/2000 字 · 图片模型只会收到这里最终确认的提示词</small>
              <button type="button" className="secondary-button" onClick={() => void generateSettingsCover()} disabled={settingsCoverBusy || settingsCoverPromptBusy || !settingsCoverPrompt.trim()}>{settingsCoverBusy ? "正在生成封面…" : "使用此提示词生成并设为封面"}</button>
              {settingsCoverBusy && <small className="hint compact-hint">封面正在后台生成，可继续编辑正文和文章设置。</small>}
              {settingsCoverError && <div className="cover-action-error" role="alert"><strong>封面生成未完成</strong><span>{settingsCoverError}</span>{/凭证|credential|API\s*Key/i.test(settingsCoverError) && <small>请保存文章后，到“技能与模型”配置对应图片模型的访问凭证，再回来重试。</small>}<button type="button" className="text-button" onClick={() => setSettingsCoverError("")}>关闭提示</button></div>}
            </details>
          </div>
          <button type="button" onClick={() => void persistArticleSettings()} disabled={busy}>保存发布设置</button>
          <p className="hint">发布时只做完整性检查，不再重复填写账号、作者、摘要和封面。</p>
        </div>}
      </aside>
    </div>
    {awenOpen && <AwenBottomPanel messages={awenMessages} memory={awenMemory} value={awenInput} loading={awenLoading} onChange={setAwenInput} onSend={() => void sendAwenMessage()} onRetry={(message) => void sendAwenMessage(message)} onAcceptSuggestion={(id) => void applyAwenSuggestion(id)} onRejectSuggestion={(id) => void dismissAwenSuggestion(id)} onClose={() => setAwenOpen(false)} />}
    {selectionComparisonOpen && selectionAiResult && <SelectionDiffModal before={selectionAiOriginal} after={selectionAiResult} onClose={() => setSelectionComparisonOpen(false)} onApply={applySelectionAiResult} />}
    {coverCropImage && <CoverCropModal image={coverCropImage} onCancel={() => setCoverCropImage(undefined)} onConfirm={(cropped) => void saveCroppedArticleCover(cropped)} />}
  </div>;
}

function removeUnavailableAwenSuggestions(messages: ArticleChatMessage[], markdown: string): {
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

function markUnansweredAwenMessages(messages: ArticleChatMessage[]): ArticleChatMessage[] {
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

function AwenBottomPanel({ messages, memory, value, loading, onChange, onSend, onRetry, onAcceptSuggestion, onRejectSuggestion, onClose }: {
  messages: ArticleChatMessage[];
  memory: string;
  value: string;
  loading: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  onRetry: (message: ArticleChatMessage) => void;
  onAcceptSuggestion: (id: string) => void;
  onRejectSuggestion: (id: string) => void;
  onClose: () => void;
}) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => { transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight }); }, [messages, loading]);
  return <section className="awen-bottom-panel" aria-label="与阿文讨论本文">
    <button type="button" className="text-button awen-collapse-button" onClick={onClose}>收起</button>
    <div className="awen-bottom-layout">
      <div className="awen-history">
        {memory && <details className="awen-memory"><summary>本文已提炼 {memory.split("\n").filter(Boolean).length} 条记忆</summary><pre>{memory}</pre></details>}
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

function LegacyAwenBottomPanel({ messages, memory, value, loading, onChange, onSend, onRetry, onClose }: {
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

function AwenChatModal({ messages, memory, value, loading, onChange, onSend, onRemember, onClose }: {
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

type DiffSegment = { value: string; changed: boolean };

function SelectionDiffModal({ before, after, onClose, onApply }: { before: string; after: string; onClose: () => void; onApply: (replacement?: string | React.MouseEvent) => void }) {
  const diff = useMemo(() => compareText(before, after), [before, after]);
  const selectable = useMemo(() => buildSelectableDiff(before, after), [before, after]);
  const changedIndexes = selectable.map((item, index) => item.changed ? index : -1).filter((index) => index >= 0);
  const [accepted, setAccepted] = useState<Set<number>>(() => new Set(changedIndexes));
  const replacement = selectable.map((item, index) => item.changed && accepted.has(index) ? item.after : item.before).join("");
  return <div className="modal-backdrop priority-modal" role="presentation"><section className="modal-card selection-diff-modal" role="dialog" aria-modal="true" aria-label="AI 修改对比"><div className="section-heading"><div><p className="eyebrow">AI 建议</p><h2>修改前后对比</h2></div><button type="button" className="text-button" onClick={onClose}>关闭</button></div><p className="hint">每一处绿色建议均可单独选用；未勾选的地方会保留原文。</p><div className="selection-diff-columns"><section><h3>修改前</h3><pre>{selectable.map((item, index) => <span className={item.changed ? "diff-removed" : ""} key={index}>{item.before}</span>)}</pre></section><section><h3>修改后</h3><pre>{selectable.map((item, index) => item.changed ? <label className="diff-choice" key={index}><input type="checkbox" checked={accepted.has(index)} onChange={(event) => setAccepted((current) => { const next = new Set(current); if (event.target.checked) next.add(index); else next.delete(index); return next; })} /><span className="diff-added">{item.after || "（删除此处）"}</span></label> : <span key={index}>{item.after}</span>)}</pre></section></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setAccepted(new Set(changedIndexes))}>全选建议</button><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="button" onClick={() => onApply(replacement)}>应用已选 {accepted.size} 处</button></div></section></div>;
  return <div className="modal-backdrop priority-modal" role="presentation"><section className="modal-card selection-diff-modal" role="dialog" aria-modal="true" aria-label="AI 修改对比"><div className="section-heading"><div><p className="eyebrow">AI 建议</p><h2>修改前后对比</h2></div><button type="button" className="text-button" onClick={onClose}>关闭</button></div><p className="hint">红色表示将被替换的原文，绿色表示 AI 建议新增或改写的内容。未着色部分保持一致。</p><div className="selection-diff-columns"><section><h3>修改前</h3><pre>{diff.before.map((segment, index) => <span className={segment.changed ? "diff-removed" : ""} key={index}>{segment.value}</span>)}</pre></section><section><h3>修改后</h3><pre>{diff.after.map((segment, index) => <span className={segment.changed ? "diff-added" : ""} key={index}>{segment.value}</span>)}</pre></section></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>继续查看</button><button type="button" onClick={onApply}>采用右侧建议</button></div></section></div>;
}

function compareText(before: string, after: string): { before: DiffSegment[]; after: DiffSegment[] } {
  const beforeTokens = tokenizeForDiff(before);
  const afterTokens = tokenizeForDiff(after);
  if (beforeTokens.length > 1_200 || afterTokens.length > 1_200) return compareTextByCommonEdges(before, after);
  const rows = Array.from({ length: beforeTokens.length + 1 }, () => new Uint16Array(afterTokens.length + 1));
  for (let left = beforeTokens.length - 1; left >= 0; left -= 1) {
    for (let right = afterTokens.length - 1; right >= 0; right -= 1) {
      rows[left][right] = beforeTokens[left] === afterTokens[right]
        ? rows[left + 1][right + 1] + 1
        : Math.max(rows[left + 1][right], rows[left][right + 1]);
    }
  }
  const leftSegments: DiffSegment[] = [];
  const rightSegments: DiffSegment[] = [];
  let left = 0;
  let right = 0;
  while (left < beforeTokens.length || right < afterTokens.length) {
    if (left < beforeTokens.length && right < afterTokens.length && beforeTokens[left] === afterTokens[right]) {
      appendDiffSegment(leftSegments, beforeTokens[left], false);
      appendDiffSegment(rightSegments, afterTokens[right], false);
      left += 1;
      right += 1;
    } else if (right < afterTokens.length && (left >= beforeTokens.length || rows[left][right + 1] >= rows[left + 1][right])) {
      appendDiffSegment(rightSegments, afterTokens[right], true);
      right += 1;
    } else {
      appendDiffSegment(leftSegments, beforeTokens[left], true);
      left += 1;
    }
  }
  return { before: leftSegments, after: rightSegments };
}

function tokenizeForDiff(value: string): string[] {
  return value.match(/\s+|[\p{Script=Han}]|[\p{L}\p{N}_]+|[^\s]/gu) ?? [];
}

function appendDiffSegment(segments: DiffSegment[], value: string, changed: boolean): void {
  const previous = segments.at(-1);
  if (previous?.changed === changed) previous.value += value;
  else segments.push({ value, changed });
}

function compareTextByCommonEdges(before: string, after: string): { before: DiffSegment[]; after: DiffSegment[] } {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  const beforeSegments = [{ value: before.slice(0, prefix), changed: false }, { value: before.slice(prefix, before.length - suffix), changed: true }, { value: before.slice(before.length - suffix), changed: false }].filter((item) => item.value);
  const afterSegments = [{ value: after.slice(0, prefix), changed: false }, { value: after.slice(prefix, after.length - suffix), changed: true }, { value: after.slice(after.length - suffix), changed: false }].filter((item) => item.value);
  return { before: beforeSegments, after: afterSegments };
}

type SelectableDiffHunk = { before: string; after: string; changed: boolean };

function buildSelectableDiff(before: string, after: string): SelectableDiffHunk[] {
  const beforeTokens = tokenizeForDiff(before);
  const afterTokens = tokenizeForDiff(after);
  if (beforeTokens.length > 1200 || afterTokens.length > 1200) {
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
    return [{ before: before.slice(0, prefix), after: after.slice(0, prefix), changed: false }, { before: before.slice(prefix, before.length - suffix), after: after.slice(prefix, after.length - suffix), changed: true }, { before: before.slice(before.length - suffix), after: after.slice(after.length - suffix), changed: false }].filter((item) => item.before || item.after);
  }
  const rows = Array.from({ length: beforeTokens.length + 1 }, () => new Uint16Array(afterTokens.length + 1));
  for (let left = beforeTokens.length - 1; left >= 0; left -= 1) for (let right = afterTokens.length - 1; right >= 0; right -= 1) rows[left][right] = beforeTokens[left] === afterTokens[right] ? rows[left + 1][right + 1] + 1 : Math.max(rows[left + 1][right], rows[left][right + 1]);
  const result: SelectableDiffHunk[] = [];
  const append = (left: string, right: string, changed: boolean) => { const previous = result.at(-1); if (changed && previous?.changed) { previous.before += left; previous.after += right; } else result.push({ before: left, after: right, changed }); };
  let left = 0; let right = 0;
  while (left < beforeTokens.length || right < afterTokens.length) {
    if (left < beforeTokens.length && right < afterTokens.length && beforeTokens[left] === afterTokens[right]) { append(beforeTokens[left], afterTokens[right], false); left += 1; right += 1; }
    else if (right < afterTokens.length && (left >= beforeTokens.length || rows[left][right + 1] >= rows[left + 1][right])) { append("", afterTokens[right], true); right += 1; }
    else { append(beforeTokens[left], "", true); left += 1; }
  }
  return result;
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

function scrollTextareaToMarkdownOffset(textarea: HTMLTextAreaElement | null, markdown: string, offset: number): void {
  if (!textarea) return;
  const safeOffset = Math.max(0, Math.min(markdown.length, offset));
  const { mirror, lines } = createTextareaLineMirror(textarea, markdown);
  const lineIndex = markdown.slice(0, safeOffset).split(/\r?\n/).length - 1;
  const paddingTop = Number.parseFloat(getComputedStyle(textarea).paddingTop) || 0;
  textarea.scrollTop = Math.max(0, (lines[Math.min(lineIndex, lines.length - 1)]?.offsetTop ?? 0) - paddingTop);
  mirror.remove();
}

function markdownOffsetAtTextareaTop(textarea: HTMLTextAreaElement, markdown: string): number {
  const { mirror, lines, offsets } = createTextareaLineMirror(textarea, markdown);
  const paddingTop = Number.parseFloat(getComputedStyle(textarea).paddingTop) || 0;
  const visibleTop = textarea.scrollTop + paddingTop + 1;
  let index = lines.findIndex((line) => line.offsetTop + line.offsetHeight > visibleTop);
  if (index < 0) index = Math.max(0, lines.length - 1);
  const offset = offsets[index] ?? 0;
  mirror.remove();
  return offset;
}

function createTextareaLineMirror(textarea: HTMLTextAreaElement, markdown: string): {
  mirror: HTMLDivElement;
  lines: HTMLDivElement[];
  offsets: number[];
} {
  const mirror = createTextareaMirror(textarea);
  const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 24;
  const lines: HTMLDivElement[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const sourceLine of markdown.split(/\r?\n/)) {
    const line = document.createElement("div");
    line.style.minHeight = `${lineHeight}px`;
    line.style.margin = "0";
    line.style.padding = "0";
    line.style.whiteSpace = "pre-wrap";
    line.style.overflowWrap = "break-word";
    line.textContent = sourceLine || "\u200b";
    offsets.push(offset);
    lines.push(line);
    mirror.appendChild(line);
    offset += sourceLine.length + 1;
  }
  return { mirror, lines, offsets };
}

function createTextareaMirror(textarea: HTMLTextAreaElement): HTMLDivElement {
  const computed = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  Object.assign(mirror.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    visibility: "hidden",
    boxSizing: computed.boxSizing,
    width: `${textarea.getBoundingClientRect().width}px`,
    padding: computed.padding,
    border: computed.border,
    font: computed.font,
    lineHeight: computed.lineHeight,
    letterSpacing: computed.letterSpacing,
    tabSize: computed.tabSize,
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    wordBreak: computed.wordBreak
  });
  document.body.appendChild(mirror);
  return mirror;
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

export function extractMarkdownImages(markdown: string): Array<{ alt: string; src: string }> {
  return [...markdown.matchAll(/!\[([^\]]*)]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)]
    .map((match) => ({ alt: match[1], src: match[2] }));
}

export function resolveArticleImageUrl(source: string, assetContextId: string, sourceArticlePath?: string): string {
  if (/^(?:https?:|data:|blob:)/i.test(source)) return source;
  if (sourceArticlePath) {
    return `${apiBase}/content-source/article-resource?path=${encodeURIComponent(sourceArticlePath)}&src=${encodeURIComponent(source)}`;
  }
  if (source.startsWith("contentferry-asset://")) {
    return `${apiBase}/content-assets/${source.slice("contentferry-asset://".length)}`;
  }
  return `${apiBase}/content-assets/${assetContextId}/${source.replace(/^\.?\//, "")}`;
}

export function renderPhonePreview(markdown: string, assetContextId: string, sourceArticlePath: string | undefined, articleTitle: string): ReactNode[] {
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

function ContentAnyReferenceView({ reference }: { reference: ContentAnyReference }) {
  return <section className="contentany-reference" aria-label="ContentAny 参考结果"><div className="contentany-reference-header"><span>{reference.label}</span>{reference.score && <strong>{reference.score}</strong>}</div><p>{reference.summary}</p>{reference.detail !== reference.summary && <small>{reference.detail}</small>}</section>;
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

const WECHAT_JOB_STATUS_PRIORITY: Record<WechatPublishJob["status"], number> = {
  published: 5,
  submitted: 4,
  draft_ready: 3,
  browser_editing: 2,
  cancelled: 1,
  failed: 0,
};

function bestWechatJob(jobs: WechatPublishJob[], predicate: (job: WechatPublishJob) => boolean): WechatPublishJob | undefined {
  const matches = jobs.filter(predicate);
  if (matches.length === 0) return undefined;
  return matches.reduce((best, current) =>
    WECHAT_JOB_STATUS_PRIORITY[current.status] > WECHAT_JOB_STATUS_PRIORITY[best.status] ? current : best
  );
}

function wechatJobLabel(job: WechatPublishJob): string {
  if (job.status === "draft_ready") return "微信草稿已创建，等待人工预览";
  if (job.status === "browser_editing") return "等待你在微信后台核对设置并发布";
  if (job.status === "failed") return "提交失败，可查看原因后重试";
  if (job.status === "published") return "微信已确认发布完成";
  if (job.status === "cancelled") return "已人工标记为取消发布";
  return job.mode === "mass" ? "群发任务已提交，等待微信回执" : "发布任务已提交，等待微信回执";
}

function csdnJobLabel(job: CsdnPublishJob): string {
  switch (job.status) {
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

function csdnJobCanStart(job: CsdnPublishJob): boolean {
  return ["queued", "needs_login", "filling", "needs_user", "ready_for_final_confirmation", "failed_before_submit", "needs_manual_reconciliation"].includes(job.status);
}

function csdnJobCanConfirm(job: CsdnPublishJob): boolean {
  return job.status === "ready_for_final_confirmation" || job.status === "needs_user";
}

function csdnJobCanCorrect(job: CsdnPublishJob): boolean {
  return ["needs_login", "filling", "submitting", "needs_manual_reconciliation", "failed_before_submit", "failed", "cancelled", "published"].includes(job.status);
}

function ProfileFields({ profile, onChange }: { profile: AccountProfile; onChange: (field: keyof AccountProfile, value: string) => void }) {
  return <><label>账号定位<textarea autoFocus value={profile.positioning} onChange={(event) => onChange("positioning", event.target.value)} placeholder="这个账号长期为谁解决什么问题？" /></label><label>目标读者<textarea value={profile.targetAudience} onChange={(event) => onChange("targetAudience", event.target.value)} placeholder="例如：关注 AI 工具的技术从业者" /></label><label>禁用话题<textarea value={profile.prohibitedTopics} onChange={(event) => onChange("prohibitedTopics", event.target.value)} placeholder="不希望涉及的话题、表达或承诺" /></label><label>写作风格<textarea value={profile.writingStyle} onChange={(event) => onChange("writingStyle", event.target.value)} placeholder="例如：务实、清晰、有案例" /></label><label>常用栏目<textarea value={profile.regularColumns} onChange={(event) => onChange("regularColumns", event.target.value)} placeholder="例如：工具实测、工作流拆解" /></label></>;
}

function Modal({ title, eyebrow, children, onClose, disabled, wide = false, priority = false }: { title: string; eyebrow?: string; children: ReactNode; onClose: () => void; disabled: boolean; wide?: boolean; priority?: boolean }) {
  return <div className={`modal-backdrop${priority ? " priority-modal" : ""}`} role="presentation" onMouseDown={() => !disabled && onClose()}><section className={`modal-card${wide ? " wide-modal" : ""}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}><div className="section-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2>{title}</h2></div><button className="text-button" onClick={onClose} disabled={disabled}>关闭</button></div>{children}</section></div>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
