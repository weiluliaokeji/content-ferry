import { FormEvent, lazy, Suspense, useEffect, useRef, useState } from "react";
import wenduLogo from "./assets/wendu-icon.png";
import { apiBase, loadSettings, patchAppSettings, platformName, request, streamGeneration } from "./api";
import { HelpCenter } from "./components/HelpCenter";
import { CsdnDraftWorkspace } from "./components/CsdnDraftWorkspace";
import { CnblogsDraftWorkspace } from "./components/CnblogsDraftWorkspace";
import { JuejinDraftWorkspace } from "./components/JuejinDraftWorkspace";
import { WorkspaceLoading } from "./components/WorkspaceLoading";
import { Modal, ProfileFields } from "./components/Modal";
import { CoverCropModal } from "./components/CoverCropModal";
import { QualityWorkspace } from "./components/QualityWorkspace";
import { ArticleWorkspace } from "./components/ArticleWorkspace";
import { ZhuqueReportView } from "./components/ZhuqueReportViews";
import { resolveArticleImageUrl } from "./markdown-preview";
import { bestWechatJob, csdnJobCanConfirm, csdnJobCanCorrect, csdnJobCanStart, csdnJobLabel, cnblogsJobLabel, juejinJobLabel, wechatJobLabel } from "./publish-labels";
import { emptyProfile, isHighAiDetectionResult, markdownOffsetAtTextareaTop, markdownTitle, parseZhuqueReport, providerName, runtimeLogLevel, skillModelStatus, sourceAssetContextId } from "./utils";
import type { AppSettingsContract, RootState, AccountPlatform, AccountProfile, MediaAccount, ContentSourcePreview, ContentSourceArticle, ContentProject, ContentBrief, ResearchSource, ContentResearch, TitleSuggestion, ContentOutline, ContentDraft, ContentReview, WechatPublishJob, CsdnChannelDraft, CsdnPublishJob, CnblogsChannelDraft, CnblogsPublishJob, CnblogsPublishOptions, JuejinChannelDraft, JuejinPublishJob, JuejinPublishOptions, ChannelAction, ChannelRow, WechatCredentialStatus, WechatMaterial, SelectedImage, ArticleSettings, ModelProviderId, ModelConnection, WebSearchSettings, ManagedSkill, SkillFileContent, ArticleChatSuggestion, ArticleChatMessage, ZhuqueReport, ContentAnyReference, RuntimeLogEntry, RuntimeLogResponse } from "./types";

// 可视化 Markdown 编辑器（按需加载）
const VisualMarkdownEditor = lazy(() =>
  import("./components/VisualMarkdownEditor").then((module) => ({ default: module.VisualMarkdownEditor }))
);

// 主界面（自 main.tsx 拆分）
export function App() {
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
  const [platformExternalId, setPlatformExternalId] = useState("");
  const [editing, setEditing] = useState<MediaAccount>();
  const [editingDisplayName, setEditingDisplayName] = useState("");
  const [editingExternalId, setEditingExternalId] = useState("");
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
  const cnblogsStatusRef = useRef<CnblogsPublishJob["status"] | null>(null);
  const juejinStatusRef = useRef<JuejinPublishJob["status"] | null>(null);
  const [notice, setNotice] = useState("");
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
  const [cnblogsDrafts, setCnblogsDrafts] = useState<CnblogsChannelDraft[]>([]);
  const [cnblogsJobs, setCnblogsJobs] = useState<CnblogsPublishJob[]>([]);
  const [cnblogsDraft, setCnblogsDraft] = useState<CnblogsChannelDraft | undefined>(undefined);
  const [cnblogsPublishJob, setCnblogsPublishJob] = useState<CnblogsPublishJob | undefined>(undefined);
  const [cnblogsDraftSource, setCnblogsDraftSource] = useState<{ relativePath: string; title: string | null } | undefined>(undefined);
  const [cnblogsDraftAccountId, setCnblogsDraftAccountId] = useState("");
  const [cnblogsDraftGenerationMode, setCnblogsDraftGenerationMode] = useState<"rewrite" | "source">("rewrite");
  const [cnblogsDraftSaving, setCnblogsDraftSaving] = useState(false);
  const [cnblogsEntryChoices, setCnblogsEntryChoices] = useState<Array<{ draft: CnblogsChannelDraft; accountName: string; job?: CnblogsPublishJob }> | null>(null);
  const [cnblogsCredentialAccount, setCnblogsCredentialAccount] = useState<MediaAccount | undefined>(undefined);
  const [cnblogsCredentialUsername, setCnblogsCredentialUsername] = useState("");
  const [cnblogsCredentialApiKey, setCnblogsCredentialApiKey] = useState("");
  const [cnblogsCredentialBlogUrl, setCnblogsCredentialBlogUrl] = useState("");
  const [cnblogsCredentialApiKeyConfigured, setCnblogsCredentialApiKeyConfigured] = useState(false);
  const [cnblogsCredentialSaving, setCnblogsCredentialSaving] = useState(false);
  const [cnblogsCredentialError, setCnblogsCredentialError] = useState("");
  const [correctingCnblogsJob, setCorrectingCnblogsJob] = useState<CnblogsPublishJob | undefined>(undefined);
  const [correctedCnblogsStatus, setCorrectedCnblogsStatus] = useState<"published" | "failed" | "cancelled">("published");
  const [cnblogsStatusReason, setCnblogsStatusReason] = useState("");
  const [cnblogsCorrectionSaving, setCnblogsCorrectionSaving] = useState(false);
  const [cnblogsCorrectionError, setCnblogsCorrectionError] = useState("");
  const [juejinDrafts, setJuejinDrafts] = useState<JuejinChannelDraft[]>([]);
  const [juejinJobs, setJuejinJobs] = useState<JuejinPublishJob[]>([]);
  const [juejinDraft, setJuejinDraft] = useState<JuejinChannelDraft | undefined>(undefined);
  const [juejinPublishJob, setJuejinPublishJob] = useState<JuejinPublishJob | undefined>(undefined);
  const [juejinDraftSource, setJuejinDraftSource] = useState<{ relativePath: string; title: string | null } | undefined>(undefined);
  const [juejinDraftAccountId, setJuejinDraftAccountId] = useState("");
  const [juejinDraftGenerationMode, setJuejinDraftGenerationMode] = useState<"rewrite" | "source">("rewrite");
  const [juejinDraftSaving, setJuejinDraftSaving] = useState(false);
  const [juejinEntryChoices, setJuejinEntryChoices] = useState<Array<{ draft: JuejinChannelDraft; accountName: string; job?: JuejinPublishJob }> | null>(null);
  const [juejinCredentialAccount, setJuejinCredentialAccount] = useState<MediaAccount | undefined>(undefined);
  const [juejinCredentialCookie, setJuejinCredentialCookie] = useState("");
  const [juejinCredentialAid, setJuejinCredentialAid] = useState("");
  const [juejinCredentialUuid, setJuejinCredentialUuid] = useState("");
  const [juejinCredentialCookieConfigured, setJuejinCredentialCookieConfigured] = useState(false);
  const [juejinCredentialAidConfigured, setJuejinCredentialAidConfigured] = useState(false);
  const [juejinCredentialUuidConfigured, setJuejinCredentialUuidConfigured] = useState(false);
  const [juejinCredentialSaving, setJuejinCredentialSaving] = useState(false);
  const [juejinCredentialError, setJuejinCredentialError] = useState("");
  const [juejinGrabRunning, setJuejinGrabRunning] = useState(false);
  const [juejinGrabStatus, setJuejinGrabStatus] = useState("");
  const [correctingJuejinJob, setCorrectingJuejinJob] = useState<JuejinPublishJob | undefined>(undefined);
  const [correctedJuejinStatus, setCorrectedJuejinStatus] = useState<"published" | "failed" | "cancelled">("published");
  const [juejinStatusReason, setJuejinStatusReason] = useState("");
  const [juejinCorrectionSaving, setJuejinCorrectionSaving] = useState(false);
  const [juejinCorrectionError, setJuejinCorrectionError] = useState("");
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
      await Promise.all([loadWechatJobs(), loadProjects(), loadCsdnChannelDrafts(), loadCnblogsChannelDrafts(), loadJuejinChannelDrafts()]);
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
  const loadCnblogsChannelDrafts = async () => {
    try {
      const [drafts, jobs] = await Promise.all([
        request<{ items: CnblogsChannelDraft[] }>("/integrations/cnblogs/channel-drafts"),
        request<{ items: CnblogsPublishJob[] }>("/integrations/cnblogs/jobs")
      ]);
      setCnblogsDrafts(drafts.items);
      setCnblogsJobs(jobs.items);
    } catch {
      /* 读取失败时不阻塞内容库，按钮仍可作为“生成博客园稿”使用。 */
    }
  };
  const loadJuejinChannelDrafts = async () => {
    try {
      const [drafts, jobs] = await Promise.all([
        request<{ items: JuejinChannelDraft[] }>("/integrations/juejin/channel-drafts"),
        request<{ items: JuejinPublishJob[] }>("/integrations/juejin/jobs")
      ]);
      setJuejinDrafts(drafts.items);
      setJuejinJobs(jobs.items);
    } catch {
      /* 读取失败时不阻塞内容库，按钮仍可作为“生成掘金稿”使用。 */
    }
  };
  const deleteCnblogsChannelDraft = async (draftId: string) => {
    await request(`/integrations/cnblogs/channel-drafts/${draftId}`, { method: "DELETE" });
    // 删除后重新拉起该来源的生成入口，便于从头再试一次。
    if (cnblogsDraft) await openCnblogsChannelDraft(cnblogsDraft.sourceRelativePath);
  };
  const openCnblogsChannelDraft = async (relativePath: string) => {
    const cnblogsAccounts = accounts.filter((account) => account.platform === "cnblogs");
    if (cnblogsAccounts.length === 0) {
      setError("请先在“账号”中添加一个博客园账号，再创建博客园渠道稿。");
      return;
    }
    try {
      const [article, drafts, jobs] = await Promise.all([
        request<ContentSourceArticle>(`/content-source/article?path=${encodeURIComponent(relativePath)}`),
        request<{ items: CnblogsChannelDraft[] }>("/integrations/cnblogs/channel-drafts"),
        request<{ items: CnblogsPublishJob[] }>("/integrations/cnblogs/jobs")
      ]);
      setCnblogsDrafts(drafts.items);
      setCnblogsJobs(jobs.items);
      const existing = drafts.items.filter((candidate) => candidate.sourceRelativePath === relativePath);
      if (existing.length === 0) {
        setCnblogsDraftSource(article);
        setCnblogsDraftAccountId(cnblogsAccounts[0].id);
        setCnblogsDraftGenerationMode("rewrite");
        setCnblogsDraft(undefined);
        setCnblogsPublishJob(undefined);
        setError("");
        return;
      }
      setCnblogsDraftSource(article);
      setCnblogsEntryChoices(existing.map((draft) => ({
        draft,
        accountName: cnblogsAccounts.find((account) => account.id === draft.accountId)?.displayName ?? "博客园账号",
        job: jobs.items.find((job) => job.channelDraftId === draft.id)
      })));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法打开博客园渠道稿。");
    }
  };
  const openExistingCnblogsDraft = (choice: { draft: CnblogsChannelDraft; job?: CnblogsPublishJob }) => {
    setCnblogsDraft(choice.draft);
    setCnblogsPublishJob(choice.job);
    setCnblogsDraftSource(undefined);
    setCnblogsEntryChoices(null);
    setError("");
  };
  const deleteJuejinChannelDraft = async (draftId: string) => {
    await request(`/integrations/juejin/channel-drafts/${draftId}`, { method: "DELETE" });
    // 删除后重新拉起该来源的生成入口，便于从头再试一次。
    if (juejinDraft) await openJuejinChannelDraft(juejinDraft.sourceRelativePath);
  };
  const openJuejinChannelDraft = async (relativePath: string) => {
    const juejinAccounts = accounts.filter((account) => account.platform === "juejin");
    if (juejinAccounts.length === 0) {
      setError("请先在“账号”中添加一个掘金账号，再创建掘金渠道稿。");
      return;
    }
    try {
      const [article, drafts, jobs] = await Promise.all([
        request<ContentSourceArticle>(`/content-source/article?path=${encodeURIComponent(relativePath)}`),
        request<{ items: JuejinChannelDraft[] }>("/integrations/juejin/channel-drafts"),
        request<{ items: JuejinPublishJob[] }>("/integrations/juejin/jobs")
      ]);
      setJuejinDrafts(drafts.items);
      setJuejinJobs(jobs.items);
      const existing = drafts.items.filter((candidate) => candidate.sourceRelativePath === relativePath);
      if (existing.length === 0) {
        setJuejinDraftSource(article);
        setJuejinDraftAccountId(juejinAccounts[0].id);
        setJuejinDraftGenerationMode("rewrite");
        setJuejinDraft(undefined);
        setJuejinPublishJob(undefined);
        setError("");
        return;
      }
      setJuejinDraftSource(article);
      setJuejinEntryChoices(existing.map((draft) => ({
        draft,
        accountName: juejinAccounts.find((account) => account.id === draft.accountId)?.displayName ?? "掘金账号",
        job: jobs.items.find((job) => job.channelDraftId === draft.id)
      })));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法打开掘金渠道稿。");
    }
  };
  const openExistingJuejinDraft = (choice: { draft: JuejinChannelDraft; job?: JuejinPublishJob }) => {
    setJuejinDraft(choice.draft);
    setJuejinPublishJob(choice.job);
    setJuejinDraftSource(undefined);
    setJuejinEntryChoices(null);
    setError("");
  };
  const deleteCsdnChannelDraft = async (draftId: string) => {
    await request(`/integrations/csdn/channel-drafts/${draftId}`, { method: "DELETE" });
    // 删除后重新拉起该来源的生成入口，便于从头再试一次。
    if (csdnDraft) await openCsdnChannelDraft(csdnDraft.sourceRelativePath);
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
          case "browser_editing":
            rows.push({ platform: "wechat_official", label: "微信公众号", statusLabel: "待微信后台确认", tone: "info", action: { kind: "enter", label: "查看进度", onClick: () => setActiveView("publish") } });
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
        const csdnJob = csdnJobs.find((job) => job.channelDraftId === csdnExisting.id);
        const published = !!csdnJob && csdnJob.status === "published";
        const frozen = csdnExisting.status === "approved";
        rows.push({
          platform: "csdn", label: "CSDN",
          statusLabel: published ? "已发布" : frozen ? "已冻结" : "草稿",
          tone: (published || frozen) ? "success" : "neutral",
          action: { kind: "enter", label: "进入 CSDN 稿", onClick: () => void openCsdnChannelDraft(item.relativePath) }
        });
      } else {
        rows.push({ platform: "csdn", label: "CSDN", statusLabel: "未生成", tone: "neutral", action: { kind: "generate", label: "生成 CSDN 稿", onClick: () => void openCsdnChannelDraft(item.relativePath) } });
      }
    }
    if (accounts.some((account) => account.platform === "cnblogs")) {
      const cnblogsExisting = cnblogsDrafts.find((candidate) => candidate.sourceRelativePath === item.relativePath);
      if (cnblogsExisting) {
        const cnblogsJob = cnblogsJobs.find((job) => job.channelDraftId === cnblogsExisting.id);
        const published = !!cnblogsJob && cnblogsJob.status === "published";
        const frozen = cnblogsExisting.status === "approved";
        rows.push({
          platform: "cnblogs", label: "博客园",
          statusLabel: published ? "已发布" : frozen ? "已冻结" : "草稿",
          tone: (published || frozen) ? "success" : "neutral",
          action: { kind: "enter", label: "进入博客园稿", onClick: () => void openCnblogsChannelDraft(item.relativePath) }
        });
      } else {
        rows.push({ platform: "cnblogs", label: "博客园", statusLabel: "未生成", tone: "neutral", action: { kind: "generate", label: "生成博客园稿", onClick: () => void openCnblogsChannelDraft(item.relativePath) } });
      }
    }
    if (accounts.some((account) => account.platform === "juejin")) {
      const juejinExisting = juejinDrafts.find((candidate) => candidate.sourceRelativePath === item.relativePath);
      if (juejinExisting) {
        const juejinJob = juejinJobs.find((job) => job.channelDraftId === juejinExisting.id);
        const published = !!juejinJob && juejinJob.status === "published";
        const frozen = juejinExisting.status === "approved";
        rows.push({
          platform: "juejin", label: "掘金",
          statusLabel: published ? "已发布" : frozen ? "已冻结" : "草稿",
          tone: (published || frozen) ? "success" : "neutral",
          action: { kind: "enter", label: "进入掘金稿", onClick: () => void openJuejinChannelDraft(item.relativePath) }
        });
      } else {
        rows.push({ platform: "juejin", label: "掘金", statusLabel: "未生成", tone: "neutral", action: { kind: "generate", label: "生成掘金稿", onClick: () => void openJuejinChannelDraft(item.relativePath) } });
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
  const generateCnblogsChannelDraft = async () => {
    if (!cnblogsDraftSource || !cnblogsDraftAccountId) return;
    setCnblogsDraftSaving(true);
    try {
      const draft = await request<CnblogsChannelDraft>("/integrations/cnblogs/channel-drafts", {
        method: "POST",
        body: JSON.stringify({ accountId: cnblogsDraftAccountId, relativePath: cnblogsDraftSource.relativePath, generationMode: cnblogsDraftGenerationMode })
      });
      setCnblogsDraft(draft);
      setError("");
      void loadCnblogsChannelDrafts();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "生成博客园渠道稿失败。");
    } finally {
      setCnblogsDraftSaving(false);
    }
  };
  const saveCnblogsChannelDraft = async () => {
    if (!cnblogsDraft) return;
    setCnblogsDraftSaving(true);
    try {
      const saved = await request<CnblogsChannelDraft>(`/integrations/cnblogs/channel-drafts/${cnblogsDraft.id}`, {
        method: "PUT",
        body: JSON.stringify({ title: cnblogsDraft.title, markdown: cnblogsDraft.markdown, author: cnblogsDraft.author, digest: cnblogsDraft.digest, coverSource: cnblogsDraft.coverSource })
      });
      setCnblogsDraft(saved);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存博客园渠道稿失败。");
    } finally {
      setCnblogsDraftSaving(false);
    }
  };
  const generateJuejinChannelDraft = async () => {
    if (!juejinDraftSource || !juejinDraftAccountId) return;
    setJuejinDraftSaving(true);
    try {
      const draft = await request<JuejinChannelDraft>("/integrations/juejin/channel-drafts", {
        method: "POST",
        body: JSON.stringify({ accountId: juejinDraftAccountId, relativePath: juejinDraftSource.relativePath, generationMode: juejinDraftGenerationMode })
      });
      setJuejinDraft(draft);
      setError("");
      void loadJuejinChannelDrafts();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "生成掘金渠道稿失败。");
    } finally {
      setJuejinDraftSaving(false);
    }
  };
  const saveJuejinChannelDraft = async () => {
    if (!juejinDraft) return;
    setJuejinDraftSaving(true);
    try {
      const saved = await request<JuejinChannelDraft>(`/integrations/juejin/channel-drafts/${juejinDraft.id}`, {
        method: "PUT",
        body: JSON.stringify({ title: juejinDraft.title, markdown: juejinDraft.markdown, author: juejinDraft.author, digest: juejinDraft.digest, coverSource: juejinDraft.coverSource })
      });
      setJuejinDraft(saved);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存掘金渠道稿失败。");
    } finally {
      setJuejinDraftSaving(false);
    }
  };
  const startCsdnBrowserAssist = async (jobId: string) => {
    // 提前检查桌面端能力：网页版（无 contentFerry 注入）无法打开可见浏览器，
    // 必须在此明确提示，而不是先发请求、再静默抛错。
    if (!window.contentFerry) {
      setError("CSDN 浏览器发布需要在文渡桌面应用中进行（当前是网页版，无法打开可见浏览器）。请使用桌面端打开文渡后再发布。");
      return;
    }
    // 防御：jobId 缺失（例如轮询把 csdnPublishJob 错写成 {job,draft} 导致顶层 id 丢失）
    // 会拼出 /jobs/undefined/browser-assist，触发服务端 Zod 校验报错。这里提前给出清晰提示。
    if (!jobId) {
      setError("未找到可用的 CSDN 发布任务（任务 id 缺失）。请返回内容库，重新进入该渠道稿后再试。");
      return;
    }
    setCsdnDraftSaving(true);
    try {
      const assistedJob = await request<CsdnPublishJob>(`/integrations/csdn/jobs/${jobId}/browser-assist`, { method: "POST" });
      setCsdnPublishJob(assistedJob);
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
  const confirmCnblogsPublish = async (jobId: string) => {
    setCnblogsDraftSaving(true);
    try {
      const payload = await request<{ job: CnblogsPublishJob }>(`/integrations/cnblogs/jobs/${jobId}/confirm`, { method: "POST" });
      if (payload?.job) {
        cnblogsStatusRef.current = payload.job.status;
        setCnblogsPublishJob(payload.job);
        if (payload.job.status === "published") {
          // 发布完成：离开编辑工作区，跳转发布中心并给出成功反馈。
          setNotice("已成功发布到博客园。");
          setCnblogsDraft(undefined);
          setCnblogsDraftSource(undefined);
          setCnblogsEntryChoices(null);
          setActiveView("publish");
        } else {
          setNotice("已确认公开，正在发布…");
        }
      }
      await loadCnblogsChannelDrafts();
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法确认博客园发布结果。");
    } finally {
      setCnblogsDraftSaving(false);
    }
  };
  const correctCnblogsStatus = async (jobId: string, status: "published" | "failed" | "cancelled", reason: string) => {
    setCnblogsDraftSaving(true);
    try {
      const payload = await request<{ job: CnblogsPublishJob }>(`/integrations/cnblogs/jobs/${jobId}/status`, {
        method: "POST",
        body: JSON.stringify({ status, reason: reason.trim() })
      });
      if (payload?.job) setCnblogsPublishJob(payload.job);
      await loadCnblogsChannelDrafts();
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法校正博客园发布状态。");
    } finally {
      setCnblogsDraftSaving(false);
    }
  };
  const confirmJuejinPublish = async (jobId: string) => {
    setJuejinDraftSaving(true);
    try {
      const payload = await request<{ job: JuejinPublishJob }>(`/integrations/juejin/jobs/${jobId}/confirm`, { method: "POST" });
      if (payload?.job) {
        juejinStatusRef.current = payload.job.status;
        setJuejinPublishJob(payload.job);
        if (payload.job.status === "published") {
          // 发布完成：离开编辑工作区，跳转发布中心并给出成功反馈。
          setNotice("已成功发布到掘金。");
          setJuejinDraft(undefined);
          setJuejinDraftSource(undefined);
          setJuejinEntryChoices(null);
          setActiveView("publish");
        } else {
          setNotice("已确认公开，正在发布…");
        }
      }
      await loadJuejinChannelDrafts();
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法确认掘金发布结果。");
    } finally {
      setJuejinDraftSaving(false);
    }
  };
  const correctJuejinStatus = async (jobId: string, status: "published" | "failed" | "cancelled", reason: string) => {
    setJuejinDraftSaving(true);
    try {
      const payload = await request<{ job: JuejinPublishJob }>(`/integrations/juejin/jobs/${jobId}/status`, {
        method: "POST",
        body: JSON.stringify({ status, reason: reason.trim() })
      });
      if (payload?.job) setJuejinPublishJob(payload.job);
      await loadJuejinChannelDrafts();
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法校正掘金发布状态。");
    } finally {
      setJuejinDraftSaving(false);
    }
  };
  // 合并「审核并冻结」+「创建发布任务」为一步：自动保存未存修改 → 冻结（内容快照锁定）→ 建任务。
  // 已处于 approved（冻结）态时仅建任务。冻结不可逆，故从草稿态进入前需在 UI 弹确认框。
  const publishCsdnDraft = async () => {
    if (!csdnDraft) return;
    setCsdnDraftSaving(true);
    let createdJob: CsdnPublishJob | undefined;
    try {
      let current = csdnDraft;
      if (current.status === "draft") {
        const saved = await request<CsdnChannelDraft>(`/integrations/csdn/channel-drafts/${current.id}`, {
          method: "PUT",
          body: JSON.stringify({ title: current.title, markdown: current.markdown, author: current.author, digest: current.digest, coverSource: current.coverSource })
        });
        current = saved;
        setCsdnDraft(saved);
      }
      if (current.status === "draft") {
        const approved = await request<CsdnChannelDraft>(`/integrations/csdn/channel-drafts/${current.id}/approve`, { method: "POST" });
        current = approved;
        setCsdnDraft(approved);
      }
      const job = await request<CsdnPublishJob>(`/integrations/csdn/channel-drafts/${current.id}/jobs`, { method: "POST" });
      setCsdnPublishJob(job);
      createdJob = job;
      setError("");
      void loadCsdnChannelDrafts();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发布到 CSDN 失败。");
      return;
    } finally {
      setCsdnDraftSaving(false);
    }
    // 建任务后直接进入浏览器发布流程，无需用户在面板里再点一次。
    // 用 await 而非 void，确保自动启动的任何错误都能通过 setError 暴露给用户。
    if (createdJob) {
      try {
        await startCsdnBrowserAssist(createdJob.id);
      } catch {
        // 错误已在 startCsdnBrowserAssist 内部 setError 上报
      }
    }
  };
  const requestPublishCsdn = () => {
    if (!csdnDraft) return;
    if (csdnDraft.status === "draft") {
      const confirmed = window.confirm(
        "发布会把本 CSDN 渠道稿锁定为内容快照（冻结）：之后主稿的修改不会影响已发布版本，如需改动只能重新生成渠道稿。\n\n确认后将自动保存未保存的修改、创建发布任务，并进入浏览器发布流程。\n\n是否继续？"
      );
      if (!confirmed) return;
    }
    void publishCsdnDraft();
  };
  const publishCnblogsDraft = async (options?: CnblogsPublishOptions) => {
    if (!cnblogsDraft) return;
    setCnblogsDraftSaving(true);
    try {
      let current = cnblogsDraft;
      if (current.status === "draft") {
        const saved = await request<CnblogsChannelDraft>(`/integrations/cnblogs/channel-drafts/${current.id}`, {
          method: "PUT",
          body: JSON.stringify({ title: current.title, markdown: current.markdown, author: current.author, digest: current.digest, coverSource: current.coverSource })
        });
        current = saved;
        setCnblogsDraft(saved);
      }
      if (current.status === "draft") {
        const approved = await request<CnblogsChannelDraft>(`/integrations/cnblogs/channel-drafts/${current.id}/approve`, { method: "POST" });
        current = approved;
        setCnblogsDraft(approved);
      }
      const payload = await request<{ job: CnblogsPublishJob }>(`/integrations/cnblogs/channel-drafts/${current.id}/jobs`, {
        method: "POST",
        body: JSON.stringify({ categories: options?.categories ?? [], tags: options?.tags ?? [] })
      });
      if (payload?.job) {
        cnblogsStatusRef.current = payload.job.status;
        setCnblogsPublishJob(payload.job);
        setNotice("已创建博客园发布任务，正在创建草稿…");
        // 跳转到发布中心查看任务进度；清除编辑工作区状态，保持 cnblogsPublishJob 以继续轮询。
        setCnblogsDraft(undefined);
        setCnblogsDraftSource(undefined);
        setCnblogsEntryChoices(null);
        setActiveView("publish");
        void loadCnblogsChannelDrafts();
      }
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发布到博客园失败。");
    } finally {
      setCnblogsDraftSaving(false);
    }
  };
  const requestPublishCnblogs = (options?: CnblogsPublishOptions) => {
    if (!cnblogsDraft) return;
    if (cnblogsDraft.status === "draft") {
      const confirmed = window.confirm(
        "发布会把本博客园渠道稿锁定为内容快照（冻结）：之后主稿的修改不会影响已发布版本，如需改动只能重新生成渠道稿。\n\n确认后将自动保存未保存的修改、创建发布任务，并跳转到发布中心查看进度。\n\n是否继续？"
      );
      if (!confirmed) return;
    }
    void publishCnblogsDraft(options);
  };
  const publishJuejinDraft = async (options?: JuejinPublishOptions) => {
    if (!juejinDraft) return;
    setJuejinDraftSaving(true);
    try {
      let current = juejinDraft;
      if (current.status === "draft") {
        const saved = await request<JuejinChannelDraft>(`/integrations/juejin/channel-drafts/${current.id}`, {
          method: "PUT",
          body: JSON.stringify({ title: current.title, markdown: current.markdown, author: current.author, digest: current.digest, coverSource: current.coverSource })
        });
        current = saved;
        setJuejinDraft(saved);
      }
      if (current.status === "draft") {
        const approved = await request<JuejinChannelDraft>(`/integrations/juejin/channel-drafts/${current.id}/approve`, { method: "POST" });
        current = approved;
        setJuejinDraft(approved);
      }
      const payload = await request<{ job: JuejinPublishJob }>(`/integrations/juejin/channel-drafts/${current.id}/jobs`, {
        method: "POST",
        body: JSON.stringify({ categoryId: options?.categoryId ?? "", tagIds: options?.tagIds ?? [] })
      });
      if (payload?.job) {
        juejinStatusRef.current = payload.job.status;
        setJuejinPublishJob(payload.job);
        setNotice("已创建掘金发布任务，正在创建草稿…");
        // 跳转到发布中心查看任务进度；清除编辑工作区状态，保持 juejinPublishJob 以继续轮询。
        setJuejinDraft(undefined);
        setJuejinDraftSource(undefined);
        setJuejinEntryChoices(null);
        setActiveView("publish");
        void loadJuejinChannelDrafts();
      }
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发布到掘金失败。");
    } finally {
      setJuejinDraftSaving(false);
    }
  };
  const requestPublishJuejin = (options?: JuejinPublishOptions) => {
    if (!juejinDraft) return;
    if (juejinDraft.status === "draft") {
      const confirmed = window.confirm(
        "发布会把本掘金渠道稿锁定为内容快照（冻结）：之后主稿的修改不会影响已发布版本，如需改动只能重新生成渠道稿。\n\n确认后将自动保存未保存的修改、创建发布任务，并跳转到发布中心查看进度。\n\n是否继续？"
      );
      if (!confirmed) return;
    }
    void publishJuejinDraft(options);
  };
  const openCnblogsStatusCorrection = (job: CnblogsPublishJob) => {
    setCorrectingCnblogsJob(job);
    setCorrectedCnblogsStatus("published");
    setCnblogsStatusReason("已在博客园后台核实");
    setCnblogsCorrectionError("");
  };
  const saveCnblogsStatusCorrection = async (event: FormEvent) => {
    event.preventDefault();
    if (!correctingCnblogsJob) {
      setCnblogsCorrectionError("核实依据不能超过 500 个字。");
      return;
    }
    const action = correctedCnblogsStatus === "published" ? "已发布" : correctedCnblogsStatus === "cancelled" ? "取消发布" : "发布失败";
    if (!window.confirm(`确定将博客园发布任务人工标记为“${action}”吗？\n\n此操作只校正文渡中的记录，不会调用博客园接口，也不会重新发布。`)) return;
    setCnblogsCorrectionSaving(true);
    try {
      await correctCnblogsStatus(correctingCnblogsJob.id, correctedCnblogsStatus, cnblogsStatusReason);
      setCorrectingCnblogsJob(undefined);
      setCnblogsStatusReason("");
      setCnblogsCorrectionError("");
    } catch (cause) {
      setCnblogsCorrectionError(cause instanceof Error ? cause.message : "人工校正博客园发布状态失败。");
    } finally {
      setCnblogsCorrectionSaving(false);
    }
  };
  const openJuejinStatusCorrection = (job: JuejinPublishJob) => {
    setCorrectingJuejinJob(job);
    setCorrectedJuejinStatus("published");
    setJuejinStatusReason("已在掘金后台核实");
    setJuejinCorrectionError("");
  };
  const saveJuejinStatusCorrection = async (event: FormEvent) => {
    event.preventDefault();
    if (!correctingJuejinJob) {
      setJuejinCorrectionError("核实依据不能超过 500 个字。");
      return;
    }
    const action = correctedJuejinStatus === "published" ? "已发布" : correctedJuejinStatus === "cancelled" ? "取消发布" : "发布失败";
    if (!window.confirm(`确定将掘金发布任务人工标记为“${action}”吗？\n\n此操作只校正文渡中的记录，不会调用掘金接口，也不会重新发布。`)) return;
    setJuejinCorrectionSaving(true);
    try {
      await correctJuejinStatus(correctingJuejinJob.id, correctedJuejinStatus, juejinStatusReason);
      setCorrectingJuejinJob(undefined);
      setJuejinStatusReason("");
      setJuejinCorrectionError("");
    } catch (cause) {
      setJuejinCorrectionError(cause instanceof Error ? cause.message : "人工校正掘金发布状态失败。");
    } finally {
      setJuejinCorrectionSaving(false);
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
  const refreshCsdnPublishJob = async () => {
    if (!csdnPublishJob) return;
    try {
      // 该路由返回的是 { job, draft }，不是 job 本身；若不解构会丢失顶层 id，
      // 导致后续“在浏览器中打开 CSDN”把 undefined 拼进 URL（POST /jobs/undefined/browser-assist）。
      const payload = await request<{ job: CsdnPublishJob }>(`/integrations/csdn/jobs/${csdnPublishJob.id}`);
      if (payload?.job) setCsdnPublishJob(payload.job);
    } catch {
      /* 轮询失败不阻塞界面 */
    }
  };
  const refreshCnblogsPublishJob = async () => {
    if (!cnblogsPublishJob) return;
    try {
      // 该路由返回 { job, draft }；解构出 job 更新，避免丢失任务 id。
      const payload = await request<{ job: CnblogsPublishJob }>(`/integrations/cnblogs/jobs/${cnblogsPublishJob.id}`);
      if (payload?.job) {
        const previous = cnblogsStatusRef.current;
        cnblogsStatusRef.current = payload.job.status;
        setCnblogsPublishJob(payload.job);
        void loadCnblogsChannelDrafts();
        // 状态推进时给出强反馈，避免用户以为发布无响应。
        if (previous === "draft_creating" && payload.job.status === "draft_created") setNotice("博客园草稿已就绪，请确认公开。");
        if (previous === "draft_creating" && payload.job.status === "failed") setNotice(`博客园草稿创建失败：${payload.job.errorMessage ?? "请查看发布中心"}`);
        if (previous === "draft_creating" && payload.job.status === "needs_credentials") setNotice("博客园凭据不完整，请前往账号页配置。");
        if (previous === "confirming" && payload.job.status === "published") {
          setNotice("已成功发布到博客园。");
          // 发布完成：若仍停留在编辑工作区，则离开并回到发布中心查看发布记录。
          if (cnblogsDraft) {
            setCnblogsDraft(undefined);
            setCnblogsDraftSource(undefined);
            setCnblogsEntryChoices(null);
            setActiveView("publish");
          }
        }
        if (previous === "confirming" && payload.job.status === "needs_manual_reconciliation") setNotice("博客园公开未确认，请人工校正发布结果。");
      }
    } catch {
      /* 轮询失败不阻塞界面 */
    }
  };
  const refreshJuejinPublishJob = async () => {
    if (!juejinPublishJob) return;
    try {
      // 该路由返回 { job, draft }；解构出 job 更新，避免丢失任务 id。
      const payload = await request<{ job: JuejinPublishJob }>(`/integrations/juejin/jobs/${juejinPublishJob.id}`);
      if (payload?.job) {
        const previous = juejinStatusRef.current;
        juejinStatusRef.current = payload.job.status;
        setJuejinPublishJob(payload.job);
        void loadJuejinChannelDrafts();
        // 状态推进时给出强反馈，避免用户以为发布无响应。
        if (previous === "draft_creating" && payload.job.status === "draft_created") setNotice("掘金草稿已就绪，请确认公开。");
        if (previous === "draft_creating" && payload.job.status === "failed") setNotice(`掘金草稿创建失败：${payload.job.errorMessage ?? "请查看发布中心"}`);
        if (previous === "draft_creating" && payload.job.status === "needs_credentials") setNotice("掘金凭据不完整，请前往账号页配置。");
        if (previous === "confirming" && payload.job.status === "published") {
          setNotice("已成功发布到掘金。");
          // 发布完成：若仍停留在编辑工作区，则离开并回到发布中心查看发布记录。
          if (juejinDraft) {
            setJuejinDraft(undefined);
            setJuejinDraftSource(undefined);
            setJuejinEntryChoices(null);
            setActiveView("publish");
          }
        }
        if (previous === "confirming" && payload.job.status === "needs_manual_reconciliation") setNotice("掘金公开未确认，请人工校正发布结果。");
      }
    } catch {
      /* 轮询失败不阻塞界面 */
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
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (activeView === "publish" || activeView === "dashboard" || activeView === "library") void loadWechatJobs();
    if (activeView === "publish" || activeView === "library") { void refreshSourcePreview().catch(() => undefined); void loadCsdnChannelDrafts(); void loadCnblogsChannelDrafts(); void loadJuejinChannelDrafts(); }
  }, [activeView]);
  useEffect(() => { if (activeView === "skills") void loadSkillsAndConnections(); }, [activeView]);
  useEffect(() => {
    if (activeView !== "skills") return;
    void request<{ directory: string; enabled: boolean }>("/app/audit-log")
      .then((result) => setAuditDir(result.directory))
      .catch(() => setAuditDir(""));
  }, [activeView]);
  useEffect(() => { if (activeView === "logs") void loadRuntimeLogs(); }, [activeView, logDate, runtimeLogFilter]);
  // CSDN 任务进行中时轮询最新状态，让右栏发布面板实时反映登录/填充/待确认进度。
  useEffect(() => {
    if (!csdnPublishJob) return;
    const active = ["queued", "needs_login", "filling", "needs_user", "ready_for_final_confirmation", "submitting", "failed_before_submit", "needs_manual_reconciliation"].includes(csdnPublishJob.status);
    if (!active) return;
    const timer = setInterval(() => void refreshCsdnPublishJob(), 3000);
    return () => clearInterval(timer);
  }, [csdnPublishJob?.id, csdnPublishJob?.status]);
  // 博客园任务进行中时轮询最新状态：draft_creating → draft_created → confirming → published。
  useEffect(() => {
    if (!cnblogsPublishJob) return;
    const active = ["draft_creating", "confirming", "needs_credentials", "needs_manual_reconciliation"].includes(cnblogsPublishJob.status);
    if (!active) return;
    const timer = setInterval(() => void refreshCnblogsPublishJob(), 3000);
    return () => clearInterval(timer);
  }, [cnblogsPublishJob?.id, cnblogsPublishJob?.status]);
  // 掘金任务进行中时轮询最新状态：draft_creating → draft_created → confirming → published。
  useEffect(() => {
    if (!juejinPublishJob) return;
    const active = ["draft_creating", "confirming", "needs_credentials", "needs_manual_reconciliation"].includes(juejinPublishJob.status);
    if (!active) return;
    const timer = setInterval(() => void refreshJuejinPublishJob(), 3000);
    return () => clearInterval(timer);
  }, [juejinPublishJob?.id, juejinPublishJob?.status]);

  const addAccount = async (event: FormEvent) => {
    event.preventDefault();
    if (!displayName.trim()) { setError("请填写账号名称。"); return; }
    setSaving(true);
    try { await request<MediaAccount>("/media-accounts", { method: "POST", body: JSON.stringify({ platform, displayName: displayName.trim(), ...(platformExternalId.trim() ? { externalAccountId: platformExternalId.trim() } : {}) }) }); setDisplayName(""); setPlatformExternalId(""); await loadAccounts(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "账号添加失败。"); }
    finally { setSaving(false); }
  };

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    setSaving(true);
    if (!editingDisplayName.trim()) { setError("请填写账号名称。"); setSaving(false); return; }
    try {
      const renamePayload = editing.platform === "cnblogs" ? { displayName: editingDisplayName.trim(), externalAccountId: editingExternalId.trim() } : { displayName: editingDisplayName.trim() };
      await request<MediaAccount>(`/media-accounts/${editing.id}`, { method: "PUT", body: JSON.stringify(renamePayload) });
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

  const openProfile = (account: MediaAccount) => { setEditing(account); setEditingDisplayName(account.displayName); setEditingExternalId(account.externalAccountId ?? ""); setProfile(account.profile); setError(""); };
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
  const openCnblogsConnection = async (account: MediaAccount) => {
    setCnblogsCredentialAccount(account);
    setCnblogsCredentialUsername("");
    setCnblogsCredentialApiKey("");
    setCnblogsCredentialApiKeyConfigured(false);
    setCnblogsCredentialBlogUrl(account.externalAccountId ?? "");
    setCnblogsCredentialError("");
    setError("");
    try {
      const status = await request<WechatCredentialStatus>(`/media-accounts/${account.id}/credentials/status`);
      setCnblogsCredentialUsername(status.cnblogsUsername ?? "");
      setCnblogsCredentialApiKeyConfigured(Boolean(status.cnblogsApiKeyConfigured));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取博客园凭据状态。"); }
  };
  const saveCnblogsCredentials = async (event: FormEvent) => {
    event.preventDefault();
    if (!cnblogsCredentialAccount) return;
    if (!cnblogsCredentialUsername.trim()) {
      setCnblogsCredentialError("请填写博客园用户名。");
      return;
    }
    if (!cnblogsCredentialApiKeyConfigured && !cnblogsCredentialApiKey.trim()) {
      setCnblogsCredentialError("请填写 API Key；已配置时留空可保留原值。");
      return;
    }
    setCnblogsCredentialSaving(true);
    try {
      await request<MediaAccount>(`/media-accounts/${cnblogsCredentialAccount.id}/credentials/username`, {
        method: "PUT",
        body: JSON.stringify({ secret: cnblogsCredentialUsername.trim() })
      });
      if (cnblogsCredentialApiKey.trim()) {
        await request<MediaAccount>(`/media-accounts/${cnblogsCredentialAccount.id}/credentials/api_key`, {
          method: "PUT",
          body: JSON.stringify({ secret: cnblogsCredentialApiKey.trim() })
        });
      }
      await request<MediaAccount>(`/media-accounts/${cnblogsCredentialAccount.id}`, {
        method: "PUT",
        body: JSON.stringify({ displayName: cnblogsCredentialAccount.displayName, externalAccountId: cnblogsCredentialBlogUrl.trim() })
      });
      await loadAccounts();
      setCnblogsCredentialAccount(undefined);
      setCnblogsCredentialError("");
    } catch (cause) {
      setCnblogsCredentialError(cause instanceof Error ? cause.message : "保存博客园凭据失败。");
    } finally {
      setCnblogsCredentialSaving(false);
    }
  };
  const openCnblogsCredentialEntry = async (accountId?: string) => {
    const target = accountId ? accounts.find((item) => item.id === accountId) : undefined;
    const fallback = target ?? accounts.find((item) => item.platform === "cnblogs");
    if (!fallback) {
      setError("请先在“账号”中添加一个博客园账号，再配置用户名和 API Key。");
      return;
    }
    setActiveView("accounts");
    await openCnblogsConnection(fallback);
  };
  const openJuejinConnection = async (account: MediaAccount) => {
    setJuejinCredentialAccount(account);
    setJuejinCredentialCookie("");
    setJuejinCredentialAid("");
    setJuejinCredentialUuid("");
    setJuejinCredentialCookieConfigured(false);
    setJuejinCredentialAidConfigured(false);
    setJuejinCredentialUuidConfigured(false);
    setJuejinCredentialError("");
    setError("");
    try {
      const status = await request<WechatCredentialStatus>(`/media-accounts/${account.id}/credentials/status`);
      setJuejinCredentialCookieConfigured(Boolean(status.juejinCookieConfigured));
      setJuejinCredentialAidConfigured(Boolean(status.juejinAidConfigured));
      setJuejinCredentialUuidConfigured(Boolean(status.juejinUuidConfigured));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取掘金凭据状态。"); }
  };
  const saveJuejinCredentials = async (event: FormEvent) => {
    event.preventDefault();
    if (!juejinCredentialAccount) return;
    if (!juejinCredentialCookie.trim()) {
      setJuejinCredentialError("请填写 Cookie；已配置时留空可保留原值。");
      return;
    }
    setJuejinCredentialSaving(true);
    try {
      await request<MediaAccount>(`/media-accounts/${juejinCredentialAccount.id}/credentials/juejin_cookie`, {
        method: "PUT",
        body: JSON.stringify({ secret: juejinCredentialCookie.trim() })
      });
      if (juejinCredentialAid.trim()) {
        await request<MediaAccount>(`/media-accounts/${juejinCredentialAccount.id}/credentials/juejin_aid`, {
          method: "PUT",
          body: JSON.stringify({ secret: juejinCredentialAid.trim() })
        });
      }
      if (juejinCredentialUuid.trim()) {
        await request<MediaAccount>(`/media-accounts/${juejinCredentialAccount.id}/credentials/juejin_uuid`, {
          method: "PUT",
          body: JSON.stringify({ secret: juejinCredentialUuid.trim() })
        });
      }
      await loadAccounts();
      setJuejinCredentialAccount(undefined);
      setJuejinCredentialError("");
    } catch (cause) {
      setJuejinCredentialError(cause instanceof Error ? cause.message : "保存掘金凭据失败。");
    } finally {
      setJuejinCredentialSaving(false);
    }
  };
  const startJuejinCookieGrab = async () => {
    if (!juejinCredentialAccount) return;
    setJuejinGrabRunning(true);
    setJuejinGrabStatus("正在打开掘金登录窗口，请在弹出的窗口中登录掘金…");
    setJuejinCredentialError("");
    try {
      const started = await request<{ grabId: string }>("/integrations/juejin/cookie-grab/start", {
        method: "POST",
        body: JSON.stringify({ accountId: juejinCredentialAccount.id })
      });
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const snapshot = await request<{
          status: string;
          cookie?: string;
          aid?: string;
          uuid?: string;
          verified?: boolean;
          error?: string;
        }>(`/integrations/juejin/cookie-grab/status?grabId=${encodeURIComponent(started.grabId)}`);
        if (snapshot.status === "success") {
          if (snapshot.verified !== true) {
            // 防御：只有接口验证通过才自动保存；否则不保存，提示继续等待登录。
            setJuejinGrabStatus("已检测到登录 Cookie，但接口验证未通过，请确认登录态后重试。");
            return;
          }
          const cookie = snapshot.cookie ?? "";
          const aid = snapshot.aid ?? "";
          const uuid = snapshot.uuid ?? "";
          await request<MediaAccount>(`/media-accounts/${juejinCredentialAccount.id}/credentials/juejin_cookie`, {
            method: "PUT",
            body: JSON.stringify({ secret: cookie })
          });
          if (aid) {
            await request<MediaAccount>(`/media-accounts/${juejinCredentialAccount.id}/credentials/juejin_aid`, {
              method: "PUT",
              body: JSON.stringify({ secret: aid })
            });
          }
          if (uuid) {
            await request<MediaAccount>(`/media-accounts/${juejinCredentialAccount.id}/credentials/juejin_uuid`, {
              method: "PUT",
              body: JSON.stringify({ secret: uuid })
            });
          }
          await loadAccounts();
          setJuejinCredentialCookie(cookie);
          setJuejinCredentialAid(aid);
          setJuejinCredentialUuid(uuid);
          setJuejinCredentialCookieConfigured(Boolean(cookie));
          setJuejinCredentialAidConfigured(Boolean(aid));
          setJuejinCredentialUuidConfigured(Boolean(uuid));
          setJuejinGrabStatus("已自动获取并保存掘金凭据，接口验证通过。");
          return;
        }
        if (snapshot.status === "cancelled") {
          setJuejinGrabStatus("已取消自动获取（登录窗口已关闭）。");
          return;
        }
        if (snapshot.status === "error") {
          setJuejinGrabStatus(`自动获取失败：${snapshot.error ?? "未知错误"}`);
          return;
        }
      }
      setJuejinGrabStatus("等待登录超时，请在登录窗口完成登录后重试。");
    } catch (cause) {
      setJuejinGrabStatus(cause instanceof Error ? cause.message : "启动自动获取 Cookie 失败。");
    } finally {
      setJuejinGrabRunning(false);
    }
  };
  const openJuejinCredentialEntry = async (accountId?: string) => {
    const target = accountId ? accounts.find((item) => item.id === accountId) : undefined;
    const fallback = target ?? accounts.find((item) => item.platform === "juejin");
    if (!fallback) {
      setError("请先在“账号”中添加一个掘金账号，再配置 Cookie。");
      return;
    }
    setActiveView("accounts");
    await openJuejinConnection(fallback);
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
      error={error}
      onClearError={() => setError("")}
      onChange={(patch) => setCsdnDraft((current) => current ? { ...current, ...patch } : current)}
      onSave={() => void saveCsdnChannelDraft()}
      onPublish={() => requestPublishCsdn()}
      onStartBrowserAssist={(jobId) => void startCsdnBrowserAssist(jobId)}
      onDelete={() => void deleteCsdnChannelDraft(csdnDraft.id)}
      onBack={() => { setCsdnDraftSource(undefined); setCsdnDraft(undefined); setCsdnPublishJob(undefined); }}
    />;
  }

  if (cnblogsDraft) {
    const cnblogsAccount = accounts.find((account) => account.id === cnblogsDraft.accountId);
    return <CnblogsDraftWorkspace
      draft={cnblogsDraft}
      accountDisplay={cnblogsAccount ? `${cnblogsAccount.displayName}` : "博客园账号"}
      saving={cnblogsDraftSaving}
      job={cnblogsPublishJob}
      error={error}
      onClearError={() => setError("")}
      onChange={(patch) => setCnblogsDraft((current) => current ? { ...current, ...patch } : current)}
      onSave={() => void saveCnblogsChannelDraft()}
      onPublish={(options) => requestPublishCnblogs(options)}
      onConfirmPublish={(jobId) => void confirmCnblogsPublish(jobId)}
      onCorrectStatus={(jobId, status, reason) => void correctCnblogsStatus(jobId, status, reason)}
      onGoToCredentials={() => void openCnblogsCredentialEntry(cnblogsDraft?.accountId)}
      onDelete={() => cnblogsDraft && void deleteCnblogsChannelDraft(cnblogsDraft.id)}
      onBack={() => { setCnblogsDraft(undefined); setCnblogsPublishJob(undefined); setCnblogsDraftSource(undefined); setCnblogsEntryChoices(null); }}
    />;
  }

  if (juejinDraft) {
    const juejinAccount = accounts.find((account) => account.id === juejinDraft.accountId);
    return <JuejinDraftWorkspace
      draft={juejinDraft}
      accountDisplay={juejinAccount ? `${juejinAccount.displayName}` : "掘金账号"}
      saving={juejinDraftSaving}
      job={juejinPublishJob}
      error={error}
      onClearError={() => setError("")}
      onChange={(patch) => setJuejinDraft((current) => current ? { ...current, ...patch } : current)}
      onSave={() => void saveJuejinChannelDraft()}
      onPublish={(options) => requestPublishJuejin(options)}
      onConfirmPublish={(jobId) => void confirmJuejinPublish(jobId)}
      onCorrectStatus={(jobId, status, reason) => void correctJuejinStatus(jobId, status, reason)}
      onGoToCredentials={() => void openJuejinCredentialEntry(juejinDraft?.accountId)}
      onDelete={() => juejinDraft && void deleteJuejinChannelDraft(juejinDraft.id)}
      onBack={() => { setJuejinDraft(undefined); setJuejinPublishJob(undefined); setJuejinDraftSource(undefined); setJuejinEntryChoices(null); }}
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
  const activeCsdnJobs = csdnJobs.filter((job) => job.status !== "published" && job.status !== "cancelled");
  const completedCsdnJobs = csdnJobs.filter((job) => job.status === "published" || job.status === "cancelled");
  const activeCnblogsJobs = cnblogsJobs.filter((job) => job.status !== "published" && job.status !== "cancelled");
  const completedCnblogsJobs = cnblogsJobs.filter((job) => job.status === "published" || job.status === "cancelled");
  const activeJuejinJobs = juejinJobs.filter((job) => job.status !== "published" && job.status !== "cancelled");
  const completedJuejinJobs = juejinJobs.filter((job) => job.status === "published" || job.status === "cancelled");
  type PublishEntry =
    | { kind: "wechat"; job: WechatPublishJob }
    | { kind: "csdn"; job: CsdnPublishJob }
    | { kind: "cnblogs"; job: CnblogsPublishJob }
    | { kind: "juejin"; job: JuejinPublishJob };
  const byUpdatedAtDesc = (a: PublishEntry, b: PublishEntry) =>
    new Date(b.job.updatedAt).getTime() - new Date(a.job.updatedAt).getTime();
  // 待处理（置顶）：微信进行中 + CSDN 进行中 + 博客园进行中 + 掘金进行中，按时间倒序。
  const pendingEntries: PublishEntry[] = [
    ...pendingWechatJobs.map((job) => ({ kind: "wechat" as const, job })),
    ...activeCsdnJobs.map((job) => ({ kind: "csdn" as const, job })),
    ...activeCnblogsJobs.map((job) => ({ kind: "cnblogs" as const, job })),
    ...activeJuejinJobs.map((job) => ({ kind: "juejin" as const, job })),
  ].sort(byUpdatedAtDesc);
  // 发布记录（置底）：微信 + CSDN + 博客园 + 掘金 已完成，按时间倒序，四类任务交错排列。
  const completedEntries: PublishEntry[] = [
    ...completedWechatJobs.map((job) => ({ kind: "wechat" as const, job })),
    ...completedCsdnJobs.map((job) => ({ kind: "csdn" as const, job })),
    ...completedCnblogsJobs.map((job) => ({ kind: "cnblogs" as const, job })),
    ...completedJuejinJobs.map((job) => ({ kind: "juejin" as const, job })),
  ].sort(byUpdatedAtDesc);
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
    {notice && <div className="toast-notice" role="status">{notice}</div>}

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
        <span className="account-row-actions">{account.platform === "wechat_official" && <button className="secondary-button compact-action" onClick={() => void openWechatConnection(account)}>连接微信</button>}{account.platform === "cnblogs" && <button className="secondary-button compact-action" onClick={() => void openCnblogsConnection(account)}>配置博客园凭据</button>}{account.platform === "juejin" && <button className="secondary-button compact-action" onClick={() => void openJuejinConnection(account)}>配置掘金凭据</button>}<button className="secondary-button compact-action" onClick={() => openProfile(account)}>编辑定位</button><button className="text-button danger-text compact-action" onClick={() => void deleteAccount(account)} disabled={saving}>删除</button></span>
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
      {wechatJobs.length === 0 && csdnJobs.length === 0 && cnblogsJobs.length === 0 && juejinJobs.length === 0 ? <section className="card"><div className="empty-guidance"><strong>还没有发布任务</strong><p>请先在内容库中选择文章并发起发布。</p><button onClick={() => setActiveView("library")}>前往内容库</button></div></section> : <>
        {pendingEntries.length > 0 && <section className="card">
          <div className="section-heading"><h2>待处理</h2></div>
          <ul className="publish-job-list">{pendingEntries.map((entry) => {
            if (entry.kind === "wechat") {
              const job = entry.job;
              const account = accounts.find((item) => item.id === job.accountId);
              return <li key={job.id}><span><strong>{job.title}</strong><small>{account ? `${platformName(account.platform)} · ${account.displayName} · ` : ""}{wechatJobLabel(job)} · {new Date(job.updatedAt).toLocaleString()}</small>{job.statusNote && <small className="hint compact-hint">{job.statusNote}</small>}{job.errorMessage && <em className="error">{job.errorMessage}</em>}</span><span className="account-actions">{job.status === "draft_ready" && <><button onClick={() => void startWechatBrowserAssist(job)} disabled={saving}>在微信后台完善并发布</button><button className="secondary-button" onClick={() => void openWechatDraftBox()} disabled={saving}>微信草稿箱</button><details className="publish-more-actions"><summary>更多操作</summary><button className="text-button" onClick={() => void submitWechatJob(job, "publish")} disabled={saving}>接口普通发布</button><button className="text-button" onClick={() => void submitWechatJob(job, "mass")} disabled={saving}>接口群发所有关注者</button></details></>}{job.status === "browser_editing" && <><span className="status-badge">等待你在微信后台确认</span><button onClick={() => void startWechatBrowserAssist(job)} disabled={saving}>重新打开微信后台</button><button className="text-button" onClick={() => openWechatStatusCorrection(job)}>确认结果</button></>}{job.status === "submitted" && <><span className="status-badge">等待微信回执</span><button className="text-button" onClick={() => openWechatStatusCorrection(job)}>校正状态</button></>}{job.status === "failed" && <><button className="secondary-button" onClick={() => void retryWechatJob(job)}>重新设置并同步</button><button className="text-button" onClick={() => openWechatStatusCorrection(job)}>校正状态</button></>}</span></li>;
            }
            if (entry.kind === "csdn") {
              const job = entry.job;
              const account = accounts.find((item) => item.id === job.accountId);
              const draft = csdnDrafts.find((item) => item.id === job.channelDraftId);
              return <li key={job.id}><span><strong>{draft?.title ?? "CSDN 渠道稿"}</strong><small>{account ? `${platformName(account.platform)} · ${account.displayName} · ` : ""}{csdnJobLabel(job)} · {new Date(job.updatedAt).toLocaleString()}</small>{job.statusNote && <small className="hint compact-hint">{job.statusNote}</small>}{job.remoteUrl && <small><a href={job.remoteUrl} target="_blank" rel="noreferrer">查看已发布文章</a></small>}{job.errorMessage && <em className="error">{job.errorMessage}</em>}</span><span className="account-actions">
                {job.status === "ready_for_final_confirmation" && <span className="status-badge">等待你在 CSDN 后台确认</span>}
                {job.status === "needs_user" && <span className="status-badge">内容未自动填充完整，请手动补齐</span>}
                {(job.status === "ready_for_final_confirmation" || job.status === "needs_user") && <>
                  <button onClick={() => void startCsdnBrowserAssist(job.id)} disabled={csdnDraftSaving}>重新打开 CSDN 后台</button>
                  <button className="secondary-button" onClick={() => openCsdnStatusCorrection(job)} disabled={csdnDraftSaving}>确认结果</button>
                  <details className="publish-more-actions"><summary>更多操作</summary><button className="text-button" onClick={() => void confirmCsdnPublish(job.id)} disabled={csdnDraftSaving}>自动点击发布并读取链接</button></details>
                </>}
                {job.status !== "ready_for_final_confirmation" && job.status !== "needs_user" && csdnJobCanStart(job) && <button onClick={() => void startCsdnBrowserAssist(job.id)} disabled={csdnDraftSaving}>在浏览器中完成发布</button>}
                {job.status === "submitting" && <span className="status-badge">正在读取回执</span>}
                {csdnJobCanCorrect(job) && job.status !== "ready_for_final_confirmation" && job.status !== "needs_user" && <button className="text-button" onClick={() => openCsdnStatusCorrection(job)} disabled={csdnDraftSaving}>校正状态</button>}
              </span></li>;
            }
            if (entry.kind === "cnblogs") {
              const job = entry.job;
              const account = accounts.find((item) => item.id === job.accountId);
              const draft = cnblogsDrafts.find((item) => item.id === job.channelDraftId);
              const cnblogsLinkLabel = job.status === "draft_created" || job.status === "confirming" ? "查看博客园草稿" : "查看已发布文章";
              return <li key={job.id}><span><strong>{draft?.title ?? "博客园渠道稿"}</strong><small>{account ? `${platformName(account.platform)} · ${account.displayName} · ` : ""}{cnblogsJobLabel(job)} · {new Date(job.updatedAt).toLocaleString()}</small>{job.statusNote && <small className="hint compact-hint">{job.statusNote}</small>}{job.remoteUrl && <small><a href={job.remoteUrl} target="_blank" rel="noreferrer">{cnblogsLinkLabel}</a></small>}{job.errorMessage && <em className="error">{job.errorMessage}</em>}</span><span className="account-actions">
                {job.status === "draft_creating" && <span className="status-badge">正在创建博客园草稿</span>}
                {(job.status === "draft_created" || job.status === "confirming") && <>
                  <button className="secondary-button" onClick={() => void confirmCnblogsPublish(job.id)} disabled={cnblogsDraftSaving}>确认公开</button>
                  <button className="text-button" onClick={() => openCnblogsStatusCorrection(job)} disabled={cnblogsDraftSaving}>校正状态</button>
                </>}
                {job.status === "needs_credentials" && <>
                  <button className="secondary-button" onClick={() => void openCnblogsCredentialEntry(job.accountId)}>配置博客园凭据</button>
                  <button className="text-button" onClick={() => openCnblogsStatusCorrection(job)} disabled={cnblogsDraftSaving}>校正状态</button>
                </>}
                {job.status === "needs_manual_reconciliation" && <>
                  <button className="secondary-button" onClick={() => openCnblogsStatusCorrection(job)} disabled={cnblogsDraftSaving}>人工校正</button>
                  <button className="text-button" onClick={() => void confirmCnblogsPublish(job.id)} disabled={cnblogsDraftSaving}>重试确认公开</button>
                </>}
                {job.status === "failed" && <>
                  <button className="secondary-button" onClick={() => { const draft = cnblogsDrafts.find((d) => d.id === job.channelDraftId); if (draft) openExistingCnblogsDraft({ draft, job }); }} disabled={cnblogsDraftSaving}>重新发布</button>
                  <button className="text-button" onClick={() => openCnblogsStatusCorrection(job)} disabled={cnblogsDraftSaving}>校正状态</button>
                </>}
              </span></li>;
            }
            const job = entry.job;
            const account = accounts.find((item) => item.id === job.accountId);
            const draft = juejinDrafts.find((item) => item.id === job.channelDraftId);
            const juejinLinkLabel = job.status === "draft_created" || job.status === "confirming" ? "查看掘金草稿" : "查看已发布文章";
            return <li key={job.id}><span><strong>{draft?.title ?? "掘金渠道稿"}</strong><small>{account ? `${platformName(account.platform)} · ${account.displayName} · ` : ""}{juejinJobLabel(job)} · {new Date(job.updatedAt).toLocaleString()}</small>{job.statusNote && <small className="hint compact-hint">{job.statusNote}</small>}{job.remoteUrl && <small><a href={job.remoteUrl} target="_blank" rel="noreferrer">{juejinLinkLabel}</a></small>}{job.errorMessage && <em className="error">{job.errorMessage}</em>}</span><span className="account-actions">
              {job.status === "draft_creating" && <span className="status-badge">正在创建掘金草稿</span>}
              {(job.status === "draft_created" || job.status === "confirming") && <>
                <button className="secondary-button" onClick={() => void confirmJuejinPublish(job.id)} disabled={juejinDraftSaving}>确认公开</button>
                <button className="text-button" onClick={() => openJuejinStatusCorrection(job)} disabled={juejinDraftSaving}>校正状态</button>
              </>}
              {job.status === "needs_credentials" && <>
                <button className="secondary-button" onClick={() => void openJuejinCredentialEntry(job.accountId)}>配置掘金凭据</button>
                <button className="text-button" onClick={() => openJuejinStatusCorrection(job)} disabled={juejinDraftSaving}>校正状态</button>
              </>}
              {job.status === "needs_manual_reconciliation" && <>
                <button className="secondary-button" onClick={() => openJuejinStatusCorrection(job)} disabled={juejinDraftSaving}>人工校正</button>
                <button className="text-button" onClick={() => void confirmJuejinPublish(job.id)} disabled={juejinDraftSaving}>重试确认公开</button>
              </>}
              {job.status === "failed" && <>
                <button className="secondary-button" onClick={() => { const draft = juejinDrafts.find((d) => d.id === job.channelDraftId); if (draft) openExistingJuejinDraft({ draft, job }); }} disabled={juejinDraftSaving}>重新发布</button>
                <button className="text-button" onClick={() => openJuejinStatusCorrection(job)} disabled={juejinDraftSaving}>校正状态</button>
              </>}
            </span></li>;
          })}</ul>
        </section>}
        {completedEntries.length > 0 && <section className="card">
          <div className="section-heading"><h2>发布记录</h2></div>
          <ul className="publish-job-list">{completedEntries.map((entry) => {
            if (entry.kind === "wechat") {
              const job = entry.job;
              const account = accounts.find((item) => item.id === job.accountId);
              return <li key={job.id}><span><strong>{job.title}</strong><small>{account ? `${platformName(account.platform)} · ${account.displayName} · ` : ""}{job.status === "cancelled" ? "已取消发布" : job.mode === "mass" ? "已群发" : "已发布"} · {new Date(job.updatedAt).toLocaleString()}</small>{job.statusSource === "manual" && <small className="manual-status-note">人工校正：{job.statusNote}</small>}</span><span className={`status-badge ${job.status === "cancelled" ? "warning" : "success"}`}>{job.status === "cancelled" ? "已取消" : "已完成"}</span></li>;
            }
            if (entry.kind === "csdn") {
              const job = entry.job;
              const account = accounts.find((item) => item.id === job.accountId);
              const draft = csdnDrafts.find((item) => item.id === job.channelDraftId);
              const label = job.status === "cancelled" ? "已取消发布" : "已发布";
              return <li key={job.id}><span><strong>{draft?.title ?? "CSDN 渠道稿"}</strong><small>{account ? `${platformName(account.platform)} · ${account.displayName} · ` : ""}{label} · {new Date(job.updatedAt).toLocaleString()}</small>{job.remoteUrl && <small><a href={job.remoteUrl} target="_blank" rel="noreferrer">查看已发布文章</a></small>}</span><span className={`status-badge ${job.status === "cancelled" ? "warning" : "success"}`}>{job.status === "cancelled" ? "已取消" : "已完成"}</span></li>;
            }
            if (entry.kind === "cnblogs") {
              const job = entry.job;
              const account = accounts.find((item) => item.id === job.accountId);
              const draft = cnblogsDrafts.find((item) => item.id === job.channelDraftId);
              const label = job.status === "cancelled" ? "已取消发布" : "已发布";
              return <li key={job.id}><span><strong>{draft?.title ?? "博客园渠道稿"}</strong><small>{account ? `${platformName(account.platform)} · ${account.displayName} · ` : ""}{label} · {new Date(job.updatedAt).toLocaleString()}</small>{job.remoteUrl && <small><a href={job.remoteUrl} target="_blank" rel="noreferrer">查看已发布文章</a></small>}</span><span className={`status-badge ${job.status === "cancelled" ? "warning" : "success"}`}>{job.status === "cancelled" ? "已取消" : "已完成"}</span></li>;
            }
            const job = entry.job;
            const account = accounts.find((item) => item.id === job.accountId);
            const draft = juejinDrafts.find((item) => item.id === job.channelDraftId);
            const label = job.status === "cancelled" ? "已取消发布" : "已发布";
            return <li key={job.id}><span><strong>{draft?.title ?? "掘金渠道稿"}</strong><small>{account ? `${platformName(account.platform)} · ${account.displayName} · ` : ""}{label} · {new Date(job.updatedAt).toLocaleString()}</small>{job.remoteUrl && <small><a href={job.remoteUrl} target="_blank" rel="noreferrer">查看已发布文章</a></small>}</span><span className={`status-badge ${job.status === "cancelled" ? "warning" : "success"}`}>{job.status === "cancelled" ? "已取消" : "已完成"}</span></li>;
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
    <section className="card"><h2>添加账号</h2><form onSubmit={addAccount} className="account-form"><label>平台<select value={platform} onChange={(event) => setPlatform(event.target.value as AccountPlatform)}><option value="wechat_official">微信公众号</option><option value="csdn">CSDN</option><option value="cnblogs">博客园</option><option value="juejin">掘金</option></select></label><label>账号名称<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="例如：围炉聊科技" maxLength={100} /></label>{platform === "cnblogs" && <label>博客地址/博客名<input value={platformExternalId} onChange={(event) => setPlatformExternalId(event.target.value)} placeholder="例如：https://www.cnblogs.com/weiluliaokeji 或 weiluliaokeji" maxLength={200} /><small>用于定位博客园博客；建议填写，便于发布前自动校验博客名。</small></label>}<button disabled={saving}>{saving ? "正在保存…" : "添加账号"}</button></form></section>
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

    {editing && <Modal onClose={() => setEditing(undefined)} disabled={saving} title={`编辑定位：${editing.displayName}`} eyebrow="账号创作上下文"><p className="hint">这些内容会在后续创作时自动作为默认上下文；不确定的项目可以先留空。</p><form onSubmit={saveProfile} className="profile-form"><label>账号名称<input value={editingDisplayName} maxLength={100} onChange={(event) => setEditingDisplayName(event.target.value)} /></label>{editing.platform === "cnblogs" && <label>博客地址/博客名<input value={editingExternalId} onChange={(event) => setEditingExternalId(event.target.value)} placeholder="例如：https://www.cnblogs.com/weiluliaokeji 或 weiluliaokeji" maxLength={200} /><small>用于定位博客园博客；发布任务重试时会自动校验。留空会清空已保存的博客名。</small></label>}<ProfileFields profile={profile} onChange={changeProfile} /><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setEditing(undefined)} disabled={saving}>取消</button><button disabled={saving}>{saving ? "正在保存…" : "保存定位"}</button></div></form></Modal>}
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
    {cnblogsCredentialAccount && <Modal onClose={() => setCnblogsCredentialAccount(undefined)} disabled={cnblogsCredentialSaving} title={`配置博客园凭据：${cnblogsCredentialAccount.displayName}`} eyebrow="博客园 MetaWeblog API">
      <form onSubmit={saveCnblogsCredentials} className="profile-form">
        <p className="hint">博客园随笔发布使用 MetaWeblog API。用户名是博客园登录用户名，打开弹窗时会回显已保存的值；API Key 在博客园后台“设置 → MetaWeblog 访问令牌”中生成，出于安全原因不回显明文，已配置时留空即可保留原值。</p>
        <label>用户名<input autoFocus value={cnblogsCredentialUsername} onChange={(event) => { setCnblogsCredentialUsername(event.target.value); setCnblogsCredentialError(""); }} autoComplete="off" placeholder="博客园登录用户名" /></label>
        <label>API Key<input type="password" value={cnblogsCredentialApiKey} onChange={(event) => { setCnblogsCredentialApiKey(event.target.value); setCnblogsCredentialError(""); }} autoComplete="new-password" placeholder={cnblogsCredentialApiKeyConfigured ? "已配置；留空不修改" : "MetaWeblog 访问令牌"} /></label>
        <label>博客地址/博客名<input value={cnblogsCredentialBlogUrl} onChange={(event) => { setCnblogsCredentialBlogUrl(event.target.value); setCnblogsCredentialError(""); }} autoComplete="off" placeholder="https://www.cnblogs.com/weiluliaokeji 或 weiluliaokeji" /><small>发布校验需要博客名；可填博客地址或博客用户名。留空保存会清空已保存的博客名。</small></label>
        {cnblogsCredentialError && <p className="error">{cnblogsCredentialError}</p>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setCnblogsCredentialAccount(undefined)} disabled={cnblogsCredentialSaving}>取消</button><button disabled={cnblogsCredentialSaving}>{cnblogsCredentialSaving ? "正在保存…" : "保存凭据"}</button></div>
      </form>
    </Modal>}
    {juejinCredentialAccount && <Modal onClose={() => setJuejinCredentialAccount(undefined)} disabled={juejinCredentialSaving} title={`配置掘金凭据：${juejinCredentialAccount.displayName}`} eyebrow="掘金 Cookie + aid + uuid">
      <form onSubmit={saveJuejinCredentials} className="profile-form">
        <p className="hint">掘金发布使用登录后的 Cookie 会话。Cookie 为登录掘金网页版后浏览器开发者工具中请求的完整 Cookie 值；aid 与 uuid 可留空，留空时使用掘金默认值（aid=2608）。出于安全原因均不回显明文，已配置时留空即可保留原值。</p>
        <label>Cookie<input autoFocus value={juejinCredentialCookie} onChange={(event) => { setJuejinCredentialCookie(event.target.value); setJuejinCredentialError(""); }} autoComplete="off" placeholder="登录掘金后复制请求 Cookie（含 sessionid）" /></label>
        <label>aid<input value={juejinCredentialAid} onChange={(event) => { setJuejinCredentialAid(event.target.value); setJuejinCredentialError(""); }} autoComplete="off" placeholder={juejinCredentialAidConfigured ? "已配置；留空不修改" : "默认 2608"} /></label>
        <label>uuid<input value={juejinCredentialUuid} onChange={(event) => { setJuejinCredentialUuid(event.target.value); setJuejinCredentialError(""); }} autoComplete="off" placeholder={juejinCredentialUuidConfigured ? "已配置；留空不修改" : "掘金生成的访客标识，可留空"} /></label>
        {juejinCredentialError && <p className="error">{juejinCredentialError}</p>}
        {juejinGrabStatus && <p className="hint">{juejinGrabStatus}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={() => void startJuejinCookieGrab()} disabled={juejinGrabRunning || juejinCredentialSaving} title="弹出掘金登录窗口，登录成功后自动抓取 Cookie/aid/uuid 并回填保存">{juejinGrabRunning ? "等待登录…" : "自动获取 Cookie"}</button>
          <button type="button" className="secondary-button" onClick={() => setJuejinCredentialAccount(undefined)} disabled={juejinGrabRunning || juejinCredentialSaving}>取消</button>
          <button disabled={juejinCredentialSaving || juejinGrabRunning}>{juejinCredentialSaving ? "正在保存…" : "保存凭据"}</button></div>
      </form>
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
    {cnblogsDraftSource && cnblogsEntryChoices && <Modal onClose={() => setCnblogsEntryChoices(null)} disabled={cnblogsDraftSaving} title={`博客园渠道稿：${cnblogsDraftSource.title ?? cnblogsDraftSource.relativePath}`}>
      <section className="csdn-channel-start">
        <p className="hint">这篇文章已经生成过博客园渠道稿，直接选择进入即可继续编辑；也可以新建一份独立渠道稿。</p>
        <ul className="csdn-entry-list">{cnblogsEntryChoices.map((choice) => <li key={choice.draft.id}><span><strong>{choice.draft.title || "未命名渠道稿"}</strong><small>{choice.accountName} · {choice.draft.status === "approved" ? "已冻结" : "草稿"} · 更新于 {new Date(choice.draft.updatedAt).toLocaleString()}</small></span><button className="secondary-button" onClick={() => openExistingCnblogsDraft(choice)} disabled={cnblogsDraftSaving}>进入编辑</button></li>)}</ul>
        <button className="text-button" onClick={() => setCnblogsEntryChoices(null)} disabled={cnblogsDraftSaving}>＋ 新建渠道稿</button>
      </section>
    </Modal>}
    {cnblogsDraftSource && !cnblogsEntryChoices && <Modal onClose={() => { if (!cnblogsDraftSaving) { setCnblogsDraftSource(undefined); setCnblogsDraft(undefined); setCnblogsPublishJob(undefined); setCnblogsEntryChoices(null); } }} disabled={cnblogsDraftSaving} title={`博客园渠道稿：${cnblogsDraftSource.title ?? cnblogsDraftSource.relativePath}`} wide>
      { <section className="csdn-channel-start"><label className="csdn-account-field">目标博客园账号<select value={cnblogsDraftAccountId} onChange={(event) => setCnblogsDraftAccountId(event.target.value)} disabled={cnblogsDraftSaving}>{accounts.filter((account) => account.platform === "cnblogs").map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}</select></label><fieldset className="csdn-generation-mode" disabled={cnblogsDraftSaving}><legend>生成方式</legend><label className={cnblogsDraftGenerationMode === "rewrite" ? "csdn-mode-option selected" : "csdn-mode-option"}><input type="radio" name="cnblogs-generation-mode" checked={cnblogsDraftGenerationMode === "rewrite"} onChange={() => setCnblogsDraftGenerationMode("rewrite")} /><span className="csdn-mode-title">阿文改写为博客园调性</span><small>调用“平台稿改写”技能，生成一份独立渠道稿。</small></label><label className={cnblogsDraftGenerationMode === "source" ? "csdn-mode-option selected" : "csdn-mode-option"}><input type="radio" name="cnblogs-generation-mode" checked={cnblogsDraftGenerationMode === "source"} onChange={() => setCnblogsDraftGenerationMode("source")} /><span className="csdn-mode-title">直接使用主稿</span><small>不调用 AI，复制主稿正文作为渠道稿；仍会拦截公众号链接和其他禁止引流内容。</small></label></fieldset><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setCnblogsDraftSource(undefined)} disabled={cnblogsDraftSaving}>取消</button><button type="button" onClick={() => void generateCnblogsChannelDraft()} disabled={!cnblogsDraftAccountId || cnblogsDraftSaving}>{cnblogsDraftSaving ? (cnblogsDraftGenerationMode === "rewrite" ? "阿文正在改写…" : "正在复制主稿…") : cnblogsDraftGenerationMode === "rewrite" ? "生成博客园渠道稿" : "使用主稿创建渠道稿"}</button></div></section>}
    </Modal>}
    {juejinDraftSource && juejinEntryChoices && <Modal onClose={() => setJuejinEntryChoices(null)} disabled={juejinDraftSaving} title={`掘金渠道稿：${juejinDraftSource.title ?? juejinDraftSource.relativePath}`}>
      <section className="csdn-channel-start">
        <p className="hint">这篇文章已经生成过掘金渠道稿，直接选择进入即可继续编辑；也可以新建一份独立渠道稿。</p>
        <ul className="csdn-entry-list">{juejinEntryChoices.map((choice) => <li key={choice.draft.id}><span><strong>{choice.draft.title || "未命名渠道稿"}</strong><small>{choice.accountName} · {choice.draft.status === "approved" ? "已冻结" : "草稿"} · 更新于 {new Date(choice.draft.updatedAt).toLocaleString()}</small></span><button className="secondary-button" onClick={() => openExistingJuejinDraft(choice)} disabled={juejinDraftSaving}>进入编辑</button></li>)}</ul>
        <button className="text-button" onClick={() => setJuejinEntryChoices(null)} disabled={juejinDraftSaving}>＋ 新建渠道稿</button>
      </section>
    </Modal>}
    {juejinDraftSource && !juejinEntryChoices && <Modal onClose={() => { if (!juejinDraftSaving) { setJuejinDraftSource(undefined); setJuejinDraft(undefined); setJuejinPublishJob(undefined); setJuejinEntryChoices(null); } }} disabled={juejinDraftSaving} title={`掘金渠道稿：${juejinDraftSource.title ?? juejinDraftSource.relativePath}`} wide>
      { <section className="csdn-channel-start"><label className="csdn-account-field">目标掘金账号<select value={juejinDraftAccountId} onChange={(event) => setJuejinDraftAccountId(event.target.value)} disabled={juejinDraftSaving}>{accounts.filter((account) => account.platform === "juejin").map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}</select></label><fieldset className="csdn-generation-mode" disabled={juejinDraftSaving}><legend>生成方式</legend><label className={juejinDraftGenerationMode === "rewrite" ? "csdn-mode-option selected" : "csdn-mode-option"}><input type="radio" name="juejin-generation-mode" checked={juejinDraftGenerationMode === "rewrite"} onChange={() => setJuejinDraftGenerationMode("rewrite")} /><span className="csdn-mode-title">阿文改写为掘金调性</span><small>调用“平台稿改写”技能，生成一份独立渠道稿。</small></label><label className={juejinDraftGenerationMode === "source" ? "csdn-mode-option selected" : "csdn-mode-option"}><input type="radio" name="juejin-generation-mode" checked={juejinDraftGenerationMode === "source"} onChange={() => setJuejinDraftGenerationMode("source")} /><span className="csdn-mode-title">直接使用主稿</span><small>不调用 AI，复制主稿正文作为渠道稿；仍会拦截公众号链接和其他禁止引流内容。</small></label></fieldset><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setJuejinDraftSource(undefined)} disabled={juejinDraftSaving}>取消</button><button type="button" onClick={() => void generateJuejinChannelDraft()} disabled={!juejinDraftAccountId || juejinDraftSaving}>{juejinDraftSaving ? (juejinDraftGenerationMode === "rewrite" ? "阿文正在改写…" : "正在复制主稿…") : juejinDraftGenerationMode === "rewrite" ? "生成掘金渠道稿" : "使用主稿创建渠道稿"}</button></div></section>}
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
    {correctingCnblogsJob && <Modal onClose={() => setCorrectingCnblogsJob(undefined)} disabled={cnblogsCorrectionSaving} title="人工校正博客园状态" eyebrow="回执异常兜底">
      <form onSubmit={saveCnblogsStatusCorrection} className="profile-form status-correction-modal">
        <p className="hint">如果你在博客园后台直接发布或取消了发布，核实结果后即可立即校正，无需等待。此操作不会再次调用博客园接口。</p>
        <div className="status-correction-warning"><strong>请先在博客园后台核实</strong><span>错误标记可能导致后续误判和重复发布。</span></div>
        <label>最终状态<select value={correctedCnblogsStatus} disabled={cnblogsCorrectionSaving} onChange={(event) => setCorrectedCnblogsStatus(event.target.value as "published" | "failed" | "cancelled")}><option value="published">已发布</option><option value="failed">发布失败</option><option value="cancelled">取消发布</option></select></label>
        <label>核实依据（可选）<textarea autoFocus value={cnblogsStatusReason} disabled={cnblogsCorrectionSaving} onChange={(event) => { setCnblogsStatusReason(event.target.value); setCnblogsCorrectionError(""); }} maxLength={500} placeholder="例如：在博客园后台“随笔”确认已发布，文章链接为……" /><small>{cnblogsStatusReason.length}/500，可留空</small></label>
        {cnblogsCorrectionError && <p className="error">{cnblogsCorrectionError}</p>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setCorrectingCnblogsJob(undefined)} disabled={cnblogsCorrectionSaving}>取消</button><button disabled={cnblogsCorrectionSaving}>{cnblogsCorrectionSaving ? "正在保存…" : "确认校正"}</button></div>
      </form>
    </Modal>}
    {correctingJuejinJob && <Modal onClose={() => setCorrectingJuejinJob(undefined)} disabled={juejinCorrectionSaving} title="人工校正掘金状态" eyebrow="回执异常兜底">
      <form onSubmit={saveJuejinStatusCorrection} className="profile-form status-correction-modal">
        <p className="hint">如果你在掘金后台直接发布或删除了草稿，核实结果后即可立即校正，无需等待。此操作只校正文渡中的本地记录，不会调用掘金接口，也不会重新发布。</p>
        <div className="status-correction-warning"><strong>请先在掘金后台核实</strong><span>错误标记可能导致后续误判和重复发布。</span></div>
        <label>最终状态<select value={correctedJuejinStatus} disabled={juejinCorrectionSaving} onChange={(event) => setCorrectedJuejinStatus(event.target.value as "published" | "failed" | "cancelled")}><option value="published">已发布</option><option value="failed">发布失败</option><option value="cancelled">取消发布</option></select></label>
        <label>核实依据（可选）<textarea autoFocus value={juejinStatusReason} disabled={juejinCorrectionSaving} onChange={(event) => { setJuejinStatusReason(event.target.value); setJuejinCorrectionError(""); }} maxLength={500} placeholder="例如：掘金后台已删除该草稿，远端文章不存在" /><small>{juejinStatusReason.length}/500，可留空</small></label>
        {juejinCorrectionError && <p className="error">{juejinCorrectionError}</p>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setCorrectingJuejinJob(undefined)} disabled={juejinCorrectionSaving}>取消</button><button disabled={juejinCorrectionSaving}>{juejinCorrectionSaving ? "正在保存…" : "确认校正"}</button></div>
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
