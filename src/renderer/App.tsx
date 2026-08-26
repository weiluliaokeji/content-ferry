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
import { skillModelGroups } from "./app-constants";
import { byUpdatedAtDesc, getPageTitle, PublishEntry } from "./app-helpers";
import { useWorkbench } from "./hooks/useWorkbench";
import { useChannelOperations } from "./hooks/useChannelOperations";
import { useAccountsConnections } from "./hooks/useAccountsConnections";
import { useWechatPublish } from "./hooks/useWechatPublish";
import { useSkillsSettings } from "./hooks/useSkillsSettings";
import { AccountsView } from "./views/AccountsView";
import { DashboardView } from "./views/DashboardView";
import { LibraryView } from "./views/LibraryView";
import { LogsView } from "./views/LogsView";
import { PublishView } from "./views/PublishView";
import { SkillsView } from "./views/SkillsView";
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
  const [notice, setNotice] = useState("");
  // The audit directory's separator format is decided by the main process
  // (path.join) and surfaced via GET /api/app/audit-log, so the displayed path
  // is always correct for the current OS instead of hard-coding "/".
  const [auditDir, setAuditDir] = useState("");
  const [wechatJobs, setWechatJobs] = useState<WechatPublishJob[]>([]);
  const [runtimeLogs, setRuntimeLogs] = useState<RuntimeLogEntry[]>([]);
  const [runtimeLogPath, setRuntimeLogPath] = useState("");
  const [runtimeLogsLoading, setRuntimeLogsLoading] = useState(false);
  const [logDate, setLogDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [runtimeLogFilter, setRuntimeLogFilter] = useState<"all" | "errors" | "wechat" | "callbacks">("all");
  const [runtimeLogSearch, setRuntimeLogSearch] = useState("");
  const [runtimeLogMeta, setRuntimeLogMeta] = useState<Pick<RuntimeLogResponse, "totalMatched" | "hasMore" | "sourceTruncated" | "readWindowBytes">>({ totalMatched: 0, hasMore: false, sourceTruncated: false, readWindowBytes: 0 });
  const [dashboardPage, setDashboardPage] = useState(1);
  const [dashboardPageSize, setDashboardPageSize] = useState(10);

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
    setLibraryPage(1);
    setSourcePreview(await request<ContentSourcePreview>("/content-source/preview"));
  };

  // ── 工作台业务域（拆分自 App.tsx） ──
  const {
    sourceModalOpen,
    setSourceModalOpen,
    sourcePath,
    setSourcePath,
    sourcePreview,
    setSourcePreview,
    libraryPage,
    setLibraryPage,
    publishPendingPage,
    setPublishPendingPage,
    publishCompletedPage,
    setPublishCompletedPage,
    libraryPageSize,
    setLibraryPageSize,
    publishPendingPageSize,
    setPublishPendingPageSize,
    publishCompletedPageSize,
    setPublishCompletedPageSize,
    sourceArticle,
    setSourceArticle,
    articleWorkspacePanel,
    setArticleWorkspacePanel,
    projectModalOpen,
    setProjectModalOpen,
    projectTopic,
    setProjectTopic,
    projectTitle,
    setProjectTitle,
    projectAccountId,
    setProjectAccountId,
    projectObjective,
    setProjectObjective,
    projectAudience,
    setProjectAudience,
    projectAngle,
    setProjectAngle,
    projectSourceNotes,
    setProjectSourceNotes,
    briefProject,
    setBriefProject,
    brief,
    setBrief,
    briefRequestVersionRef,
    setBriefRequestVersionRef,
    titleSuggestionAbortRef,
    setTitleSuggestionAbortRef,
    briefTitle,
    setBriefTitle,
    titleSuggestions,
    setTitleSuggestions,
    historicalSeries,
    setHistoricalSeries,
    titleSuggesting,
    setTitleSuggesting,
    outlineProject,
    setOutlineProject,
    outline,
    setOutline,
    outlineGenerating,
    setOutlineGenerating,
    outlineGenerationStatus,
    setOutlineGenerationStatus,
    outlineAbortRef,
    setOutlineAbortRef,
    outlineEditorMode,
    setOutlineEditorMode,
    outlineModeScrollOffset,
    setOutlineModeScrollOffset,
    outlineMarkdownSourceRef,
    setOutlineMarkdownSourceRef,
    researchProject,
    setResearchProject,
    research,
    setResearch,
    researchGenerating,
    setResearchGenerating,
    researchFollowUp,
    setResearchFollowUp,
    researchFollowingUp,
    setResearchFollowingUp,
    researchStatus,
    setResearchStatus,
    researchError,
    setResearchError,
    draftProject,
    setDraftProject,
    draft,
    setDraft,
    draftGenerating,
    setDraftGenerating,
    draftGenerationStatus,
    setDraftGenerationStatus,
    draftAbortRef,
    setDraftAbortRef,
    reviewProject,
    setReviewProject,
    review,
    setReview,
    zhuqueReport,
    setZhuqueReport,
    zhuqueRunning,
    setZhuqueRunning,
    addAccount,
    saveProfile,
    openSource,
    scanSource,
    chooseDirectory,
    openProjectCreator,
    closeBrief,
    openSourceArticle,
    saveSourceArticle,
    setArticleArchived,
    archiveArticlesBefore,
    createProject,
    deleteProjectDraft,
    openBrief,
    saveBrief,
    suggestBriefTitles,
    changeBrief,
    openResearch,
    toggleResearchSource,
    continueResearch,
    generateOutline,
    openOutline,
    switchOutlineToMarkdown,
    switchOutlineToVisual,
    saveOutline,
    openDraft,
    saveDraft,
    openReview,
    openZhuque,
    runZhuque,
    saveReview,
    optimizeDraft,
    activeView, setActiveView,
  } = useWorkbench({
    accounts, setAccounts, setProjects, error, setError, saving, setSaving,
    wechatJobs, loadAccounts, loadProjects, refreshSourcePreview,
    platform, setPlatform, displayName, setDisplayName, platformExternalId, setPlatformExternalId,
    editing, setEditing, editingDisplayName, setEditingDisplayName, editingExternalId, setEditingExternalId,
    profile, setProfile
  });

  // ── 渠道业务域（拆分自 App.tsx） ──
  const {
    wechatJobsRefreshing,
    setWechatJobsRefreshing,
    wechatJobsRefreshedAt,
    setWechatJobsRefreshedAt,
    correctingWechatJob,
    setCorrectingWechatJob,
    orphanedWechatJob,
    setOrphanedWechatJob,
    correctedWechatStatus,
    setCorrectedWechatStatus,
    wechatStatusReason,
    setWechatStatusReason,
    wechatCorrectionSaving,
    setWechatCorrectionSaving,
    wechatCorrectionError,
    setWechatCorrectionError,
    correctingCsdnJob,
    setCorrectingCsdnJob,
    correctedCsdnStatus,
    setCorrectedCsdnStatus,
    csdnStatusReason,
    setCsdnStatusReason,
    csdnCorrectionSaving,
    setCsdnCorrectionSaving,
    csdnCorrectionError,
    setCsdnCorrectionError,
    csdnDraftSource,
    setCsdnDraftSource,
    csdnDraftAccountId,
    setCsdnDraftAccountId,
    csdnDraftGenerationMode,
    setCsdnDraftGenerationMode,
    csdnDraft,
    setCsdnDraft,
    csdnDraftSaving,
    setCsdnDraftSaving,
    csdnPublishJob,
    setCsdnPublishJob,
    csdnDrafts,
    setCsdnDrafts,
    csdnJobs,
    setCsdnJobs,
    csdnEntryChoices,
    setCsdnEntryChoices,
    cnblogsDrafts,
    setCnblogsDrafts,
    cnblogsJobs,
    setCnblogsJobs,
    cnblogsDraft,
    setCnblogsDraft,
    cnblogsPublishJob,
    setCnblogsPublishJob,
    cnblogsDraftSource,
    setCnblogsDraftSource,
    cnblogsDraftAccountId,
    setCnblogsDraftAccountId,
    cnblogsDraftGenerationMode,
    setCnblogsDraftGenerationMode,
    cnblogsDraftSaving,
    setCnblogsDraftSaving,
    cnblogsEntryChoices,
    setCnblogsEntryChoices,
    correctingCnblogsJob,
    setCorrectingCnblogsJob,
    correctedCnblogsStatus,
    setCorrectedCnblogsStatus,
    cnblogsStatusReason,
    setCnblogsStatusReason,
    cnblogsCorrectionSaving,
    setCnblogsCorrectionSaving,
    cnblogsCorrectionError,
    setCnblogsCorrectionError,
    juejinDrafts,
    setJuejinDrafts,
    juejinJobs,
    setJuejinJobs,
    juejinDraft,
    setJuejinDraft,
    juejinPublishJob,
    setJuejinPublishJob,
    juejinDraftSource,
    setJuejinDraftSource,
    juejinDraftAccountId,
    setJuejinDraftAccountId,
    juejinDraftGenerationMode,
    setJuejinDraftGenerationMode,
    juejinDraftSaving,
    setJuejinDraftSaving,
    juejinEntryChoices,
    setJuejinEntryChoices,
    correctingJuejinJob,
    setCorrectingJuejinJob,
    correctedJuejinStatus,
    setCorrectedJuejinStatus,
    juejinStatusReason,
    setJuejinStatusReason,
    juejinCorrectionSaving,
    setJuejinCorrectionSaving,
    juejinCorrectionError,
    setJuejinCorrectionError,
    cnblogsStatusRef,
    setCnblogsStatusRef,
    juejinStatusRef,
    setJuejinStatusRef,
    loadWechatJobs,
    refreshWechatStatus,
    loadCsdnChannelDrafts,
    loadCnblogsChannelDrafts,
    loadJuejinChannelDrafts,
    deleteCnblogsChannelDraft,
    openCnblogsChannelDraft,
    openExistingCnblogsDraft,
    deleteJuejinChannelDraft,
    openJuejinChannelDraft,
    openExistingJuejinDraft,
    deleteCsdnChannelDraft,
    openCsdnChannelDraft,
    openExistingCsdnDraft,
    channelRowsFor,
    isPublished,
    isFullyPublished,
    generateCsdnChannelDraft,
    saveCsdnChannelDraft,
    generateCnblogsChannelDraft,
    saveCnblogsChannelDraft,
    generateJuejinChannelDraft,
    saveJuejinChannelDraft,
    startCsdnBrowserAssist,
    confirmCsdnPublish,
    correctCsdnStatus,
    confirmCnblogsPublish,
    correctCnblogsStatus,
    confirmJuejinPublish,
    correctJuejinStatus,
    publishCsdnDraft,
    requestPublishCsdn,
    publishCnblogsDraft,
    requestPublishCnblogs,
    publishJuejinDraft,
    requestPublishJuejin,
    openCnblogsStatusCorrection,
    saveCnblogsStatusCorrection,
    openJuejinStatusCorrection,
    saveJuejinStatusCorrection,
    openCsdnStatusCorrection,
    saveCsdnStatusCorrection,
    openWechatStatusCorrection,
    saveWechatStatusCorrection,
    refreshCsdnPublishJob,
    refreshCnblogsPublishJob,
    refreshJuejinPublishJob,
  } = useChannelOperations({
    accounts, setAccounts, loadAccounts, loadProjects, refreshSourcePreview,
    saving, setError, setNotice, setActiveView, wechatJobs, setWechatJobs,
    wb: {
      sourceModalOpen,
      setSourceModalOpen,
      sourcePath,
      setSourcePath,
      sourcePreview,
      setSourcePreview,
      libraryPage,
      setLibraryPage,
      publishPendingPage,
      setPublishPendingPage,
      publishCompletedPage,
      setPublishCompletedPage,
      libraryPageSize,
      setLibraryPageSize,
      publishPendingPageSize,
      setPublishPendingPageSize,
      publishCompletedPageSize,
      setPublishCompletedPageSize,
      sourceArticle,
      setSourceArticle,
      articleWorkspacePanel,
      setArticleWorkspacePanel,
      projectModalOpen,
      setProjectModalOpen,
      projectTopic,
      setProjectTopic,
      projectTitle,
      setProjectTitle,
      projectAccountId,
      setProjectAccountId,
      projectObjective,
      setProjectObjective,
      projectAudience,
      setProjectAudience,
      projectAngle,
      setProjectAngle,
      projectSourceNotes,
      setProjectSourceNotes,
      briefProject,
      setBriefProject,
      brief,
      setBrief,
      briefRequestVersionRef,
      setBriefRequestVersionRef,
      titleSuggestionAbortRef,
      setTitleSuggestionAbortRef,
      briefTitle,
      setBriefTitle,
      titleSuggestions,
      setTitleSuggestions,
      historicalSeries,
      setHistoricalSeries,
      titleSuggesting,
      setTitleSuggesting,
      outlineProject,
      setOutlineProject,
      outline,
      setOutline,
      outlineGenerating,
      setOutlineGenerating,
      outlineGenerationStatus,
      setOutlineGenerationStatus,
      outlineAbortRef,
      setOutlineAbortRef,
      outlineEditorMode,
      setOutlineEditorMode,
      outlineModeScrollOffset,
      setOutlineModeScrollOffset,
      outlineMarkdownSourceRef,
      setOutlineMarkdownSourceRef,
      researchProject,
      setResearchProject,
      research,
      setResearch,
      researchGenerating,
      setResearchGenerating,
      researchFollowUp,
      setResearchFollowUp,
      researchFollowingUp,
      setResearchFollowingUp,
      researchStatus,
      setResearchStatus,
      researchError,
      setResearchError,
      draftProject,
      setDraftProject,
      draft,
      setDraft,
      draftGenerating,
      setDraftGenerating,
      draftGenerationStatus,
      setDraftGenerationStatus,
      draftAbortRef,
      setDraftAbortRef,
      reviewProject,
      setReviewProject,
      review,
      setReview,
      zhuqueReport,
      setZhuqueReport,
      zhuqueRunning,
      setZhuqueRunning,
      addAccount,
      saveProfile,
      openSource,
      scanSource,
      chooseDirectory,
      openProjectCreator,
      closeBrief,
      openSourceArticle,
      saveSourceArticle,
      setArticleArchived,
      archiveArticlesBefore,
      createProject,
      deleteProjectDraft,
      openBrief,
      saveBrief,
      suggestBriefTitles,
      changeBrief,
      openResearch,
      toggleResearchSource,
      continueResearch,
      generateOutline,
      openOutline,
      switchOutlineToMarkdown,
      switchOutlineToVisual,
      saveOutline,
      openDraft,
      saveDraft,
      openReview,
      openZhuque,
      runZhuque,
      saveReview,
      optimizeDraft,
      activeView,
      setActiveView,
    }
  });

  // ── 账号与连接管理域（拆分自 App.tsx） ──
  const {
    wechatAccount,
    setWechatAccount,
    wechatAppId,
    setWechatAppId,
    wechatAppSecret,
    setWechatAppSecret,
    wechatCallbackToken,
    setWechatCallbackToken,
    wechatCredentialStatus,
    setWechatCredentialStatus,
    wechatTestResult,
    setWechatTestResult,
    wechatTestError,
    setWechatTestError,
    cnblogsCredentialAccount,
    setCnblogsCredentialAccount,
    cnblogsCredentialUsername,
    setCnblogsCredentialUsername,
    cnblogsCredentialApiKey,
    setCnblogsCredentialApiKey,
    cnblogsCredentialBlogUrl,
    setCnblogsCredentialBlogUrl,
    cnblogsCredentialApiKeyConfigured,
    setCnblogsCredentialApiKeyConfigured,
    cnblogsCredentialSaving,
    setCnblogsCredentialSaving,
    cnblogsCredentialError,
    setCnblogsCredentialError,
    juejinCredentialAccount,
    setJuejinCredentialAccount,
    juejinCredentialCookie,
    setJuejinCredentialCookie,
    juejinCredentialAid,
    setJuejinCredentialAid,
    juejinCredentialUuid,
    setJuejinCredentialUuid,
    juejinCredentialCookieConfigured,
    setJuejinCredentialCookieConfigured,
    juejinCredentialAidConfigured,
    setJuejinCredentialAidConfigured,
    juejinCredentialUuidConfigured,
    setJuejinCredentialUuidConfigured,
    juejinCredentialSaving,
    setJuejinCredentialSaving,
    juejinCredentialError,
    setJuejinCredentialError,
    juejinGrabRunning,
    setJuejinGrabRunning,
    juejinGrabStatus,
    setJuejinGrabStatus,
    openProfile,
    changeProfile,
    saveWechatConnection,
    openWechatConnection,
    openCnblogsConnection,
    saveCnblogsCredentials,
    openCnblogsCredentialEntry,
    openJuejinConnection,
    saveJuejinCredentials,
    startJuejinCookieGrab,
    openJuejinCredentialEntry,
    deleteAccount,
  } = useAccountsConnections({
    accounts, loadAccounts, setError, setSaving, setActiveView,
    platform, setPlatform, displayName, setDisplayName, platformExternalId, setPlatformExternalId,
    editing, setEditing, editingDisplayName, setEditingDisplayName, editingExternalId, setEditingExternalId,
    profile, setProfile
  });

  // 合并「审核并冻结」+「创建发布任务」为一步：自动保存未存修改 → 冻结（内容快照锁定）→ 建任务。
  // 已处于 approved（冻结）态时仅建任务。冻结不可逆，故从草稿态进入前需在 UI 弹确认框。
  async function loadSkillsAndConnections() {
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
      const coverProvider = coverSkill?.provider;
      if (coverProvider === "modelscope" || coverProvider === "agnes") setCoverProvider(coverProvider as "modelscope" | "agnes");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取技能和模型连接。");
    }
  }

  // ── 技能/模型连接/Tavily/代理设置域（拆分自 App.tsx） ──
  const {
    skills,
    setSkills,
    batchModelByGroup,
    setBatchModelByGroup,
    batchSaving,
    setBatchSaving,
    selectedSkillIds,
    setSelectedSkillIds,
    modelConnections,
    setModelConnections,
    webSearchSettings,
    setWebSearchSettings,
    editingSkill,
    setEditingSkill,
    editingSkillFile,
    setEditingSkillFile,
    savedSkillFileContent,
    setSavedSkillFileContent,
    editingConnection,
    setEditingConnection,
    connectionCredential,
    setConnectionCredential,
    connectionCreating,
    setConnectionCreating,
    tavilyModalOpen,
    setTavilyModalOpen,
    tavilyApiKey,
    setTavilyApiKey,
    tavilySaving,
    setTavilySaving,
    tavilyTesting,
    setTavilyTesting,
    tavilyError,
    setTavilyError,
    tavilyTestResult,
    setTavilyTestResult,
    researchProxyUrl,
    setResearchProxyUrl,
    researchProxyInput,
    setResearchProxyInput,
    researchProxySaving,
    setResearchProxySaving,
    researchProxyError,
    setResearchProxyError,
    researchProxyModalOpen,
    setResearchProxyModalOpen,
    openSkillEditor,
    chooseSkillFile,
    closeSkillEditor,
    saveSkill,
    toggleGroupSelection,
    applyBatchModel,
    saveModelConnection,
    openCreateConnection,
    closeConnectionModal,
    deleteModelConnection,
    openTavilySettings,
    testTavilyConnection,
    saveTavilySettings,
    clearTavilySettings,
    openResearchProxySettings,
    saveResearchProxySettings,
    clearResearchProxySettings,
  } = useSkillsSettings({
    loadSkillsAndConnections, setError, setSaving
  });

  const {
    publishProject,
    setPublishProject,
    publishSource,
    setPublishSource,
    publishAccountId,
    setPublishAccountId,
    publishAuthor,
    setPublishAuthor,
    publishDigest,
    setPublishDigest,
    publishNeedOpenComment,
    setPublishNeedOpenComment,
    publishOnlyFansCanComment,
    setPublishOnlyFansCanComment,
    publishDeclareOriginal,
    setPublishDeclareOriginal,
    publishEnableReward,
    setPublishEnableReward,
    publishCollectionName,
    setPublishCollectionName,
    publishThumbMediaId,
    setPublishThumbMediaId,
    publishCoverSource,
    setPublishCoverSource,
    publishCoverPreview,
    setPublishCoverPreview,
    publishCoverLabel,
    setPublishCoverLabel,
    wechatMaterials,
    setWechatMaterials,
    modelScopePrompt,
    setModelScopePrompt,
    coverGenerating,
    setCoverGenerating,
    coverProvider,
    setCoverProvider,
    publishCropImage,
    setPublishCropImage,
    publishCheckMarkdown,
    setPublishCheckMarkdown,
    publishAiCheckResult,
    setPublishAiCheckResult,
    publishZhuqueReport,
    setPublishZhuqueReport,
    publishAiCheckTool,
    setPublishAiCheckTool,
    publishAiOverrideReason,
    setPublishAiOverrideReason,
    publishAiOverrideReasonDirtyRef,
    setPublishAiOverrideReasonDirtyRef,
    publishAiCheckRunning,
    setPublishAiCheckRunning,
    publishDetector,
    setPublishDetector,
    resetPublishCover,
    openPublishPreparation,
    openSourcePublishPreparation,
    runPublishZhuque,
    runPublishContentAny,
    chooseLocalCover,
    saveCroppedPublishCover,
    loadWechatMaterials,
    chooseWechatMaterial,
    generateCover,
    prepareSourcePublish,
    prepareProjectPublish,
    createWechatDraft,
    returnToPublishSettings,
    openWechatDraftBox,
    startWechatBrowserAssist,
    submitWechatJob,
    retryWechatJob,
    deleteWechatJob,

  } = useWechatPublish({
    accounts, projects, settings, skills, modelConnections,
    loadProjects, loadSkillsAndConnections, setError, setSaving, setActiveView,
    setSourceArticle, setDraftProject, setDraft, setArticleWorkspacePanel,
    openDraft, openSourceArticle, loadWechatJobs, orphanedWechatJob, setOrphanedWechatJob
  });

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

  useEffect(() => {
    if (outlineEditorMode !== "markdown") return;
    requestAnimationFrame(() => {
      const textarea = outlineMarkdownSourceRef.current;
      const canvas = textarea?.closest<HTMLElement>(".editor-canvas");
      if (canvas) canvas.scrollTop = 0;
    });
  }, [outlineEditorMode]);

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
  const pageTitle = getPageTitle(activeView, projects.length);
  const filteredRuntimeLogs = runtimeLogs;
  const pendingWechatJobs = wechatJobs.filter((job) => job.status !== "published" && job.status !== "cancelled");
  const completedWechatJobs = wechatJobs.filter((job) => job.status === "published" || job.status === "cancelled");
  const activeCsdnJobs = csdnJobs.filter((job) => job.status !== "published" && job.status !== "cancelled");
  const completedCsdnJobs = csdnJobs.filter((job) => job.status === "published" || job.status === "cancelled");
  const activeCnblogsJobs = cnblogsJobs.filter((job) => job.status !== "published" && job.status !== "cancelled");
  const completedCnblogsJobs = cnblogsJobs.filter((job) => job.status === "published" || job.status === "cancelled");
  const activeJuejinJobs = juejinJobs.filter((job) => job.status !== "published" && job.status !== "cancelled");
  const completedJuejinJobs = juejinJobs.filter((job) => job.status === "published" || job.status === "cancelled");
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

  // 分页通用配置：每页条数选项；切换条数时页码重置到第 1 页。
  const PAGE_SIZE_OPTIONS = [5, 10, 20, 50];
  // 归档库 = 已归档集合（front matter archived: true）。
  const archivedLibraryItems = sourcePreview
    ? sourcePreview.items.filter((item) => item.archived).sort((left, right) => {
        const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
        const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
        return rightTime - leftTime;
      })
    : [];
  // 工作台 = 未归档集合：本应用 project + 外部直写 VitePress 文章；均按创建时间倒序。
  const dashboardItems = [
    ...projects
      .filter((project) => !sourcePreview?.items.find((item) => item.relativePath === project.sourceRelativePath)?.archived)
      .map((project) => ({ kind: "project" as const, id: project.id, title: project.topic, createdAt: project.createdAt, relativePath: project.sourceRelativePath, project })),
    ...(sourcePreview?.items ?? [])
      .filter((item) => !item.archived && !projects.some((project) => project.sourceRelativePath === item.relativePath))
      .map((item) => ({ kind: "external" as const, id: item.relativePath, title: item.title ?? "未命名文章", createdAt: item.createdAt ?? new Date().toISOString(), relativePath: item.relativePath }))
  ].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  // 工作台分页：默认每页 10 条；条目数变化时自动收敛页码。
  const dashboardTotalPages = dashboardItems.length > 0 ? Math.max(1, Math.ceil(dashboardItems.length / dashboardPageSize)) : 1;
  const dashboardSafePage = Math.min(dashboardPage, dashboardTotalPages);
  const dashboardPageItems = dashboardItems.slice((dashboardSafePage - 1) * dashboardPageSize, dashboardSafePage * dashboardPageSize);
  // 归档库分页：默认每页 5 条；扫描结果变化时自动收敛页码。
  const libraryTotalPages = archivedLibraryItems.length > 0 ? Math.max(1, Math.ceil(archivedLibraryItems.length / libraryPageSize)) : 1;
  const librarySafePage = Math.min(libraryPage, libraryTotalPages);
  const libraryPageItems = archivedLibraryItems.slice((librarySafePage - 1) * libraryPageSize, librarySafePage * libraryPageSize);

  // 发布中心分页：待处理与发布记录各一页，默认每页 5 条，页码超出时自动收敛。
  const pendingTotalPages = Math.max(1, Math.ceil(pendingEntries.length / publishPendingPageSize));
  const pendingSafePage = Math.min(publishPendingPage, pendingTotalPages);
  const pendingPageItems = pendingEntries.slice((pendingSafePage - 1) * publishPendingPageSize, pendingSafePage * publishPendingPageSize);
  const completedTotalPages = Math.max(1, Math.ceil(completedEntries.length / publishCompletedPageSize));
  const completedSafePage = Math.min(publishCompletedPage, completedTotalPages);
  const completedPageItems = completedEntries.slice((completedSafePage - 1) * publishCompletedPageSize, completedSafePage * publishCompletedPageSize);

  return <div className="app-shell">
    <aside className="app-sidebar">
      <div className="app-brand"><img src={wenduLogo} alt="" /><strong>文渡<small>ContentFerry</small></strong></div>
      <nav>
        <button className={activeView === "dashboard" ? "active" : ""} onClick={() => setActiveView("dashboard")}>工作台</button>
        <button className={activeView === "library" ? "active" : ""} onClick={() => setActiveView("library")}>归档库</button>
        <button className={activeView === "publish" ? "active" : ""} onClick={() => setActiveView("publish")}>发布记录</button>
        <button className={activeView === "skills" ? "active" : ""} onClick={() => setActiveView("skills")}>技能与模型</button>
        <button className={activeView === "accounts" ? "active" : ""} onClick={() => setActiveView("accounts")}>账号</button>
        <button className={activeView === "logs" ? "active" : ""} onClick={() => setActiveView("logs")}>运行日志</button>
        <button className={activeView === "help" ? "active" : ""} onClick={() => setActiveView("help")}>使用帮助</button>
      </nav>
    </aside>
    <main className="app-main">
    <div className="page-heading">
      <h1>{pageTitle}</h1>
      {activeView === "publish" ? (
        <div className="refresh-actions">
          <span>{wechatJobsRefreshedAt && `已更新 ${wechatJobsRefreshedAt.toLocaleTimeString()}`}</span>
          <button className="text-button" onClick={() => void refreshWechatStatus()} disabled={wechatJobsRefreshing}>{wechatJobsRefreshing ? "正在刷新…" : "刷新状态"}</button>
        </div>
      ) : activeView === "dashboard" ? (
        <div className="dashboard-heading-actions">
          <button className="secondary-button" onClick={() => void refreshSourcePreview()}>重新加载文章</button>
          <button onClick={openProjectCreator}>＋ 新建文章</button>
        </div>
      ) : null}
    </div>
    {error && <p className="error">{error}</p>}
    {error && <Modal title="操作未完成" eyebrow="需要你的注意" onClose={() => setError("")} disabled={false} priority><p className="error error-dialog-message">{error}</p><div className="modal-actions"><button type="button" onClick={() => setError("")}>知道了</button></div></Modal>}
    {notice && <div className="toast-notice" role="status">{notice}</div>}

    {activeView === "help" && <HelpCenter onNavigate={setActiveView} />}

    {activeView === "skills" && <SkillsView
            skills={skills}
      batchModelByGroup={batchModelByGroup}
      setBatchModelByGroup={setBatchModelByGroup}
      batchSaving={batchSaving}
      selectedSkillIds={selectedSkillIds}
      setSelectedSkillIds={setSelectedSkillIds}
      modelConnections={modelConnections}
      settings={settings}
      setSettings={setSettings}
      webSearchSettings={webSearchSettings}
      researchProxyUrl={researchProxyUrl}
      auditDir={auditDir}
      toggleGroupSelection={toggleGroupSelection}
      applyBatchModel={applyBatchModel}
      openSkillEditor={openSkillEditor}
      loadSkillsAndConnections={loadSkillsAndConnections}
      openTavilySettings={openTavilySettings}
      openResearchProxySettings={openResearchProxySettings}
      setEditingConnection={setEditingConnection}
      setConnectionCredential={setConnectionCredential}
      openCreateConnection={openCreateConnection}
      deleteModelConnection={deleteModelConnection}
      setError={setError}
    />}

    {activeView === "accounts" && <AccountsView
            accounts={accounts}
      loading={loading}
      saving={saving}
      platform={platform}
      setPlatform={setPlatform}
      displayName={displayName}
      setDisplayName={setDisplayName}
      platformExternalId={platformExternalId}
      setPlatformExternalId={setPlatformExternalId}
      loadAccounts={loadAccounts}
      deleteAccount={deleteAccount}
      openWechatConnection={openWechatConnection}
      openCnblogsConnection={openCnblogsConnection}
      openJuejinConnection={openJuejinConnection}
      openProfile={openProfile}
      addAccount={addAccount}
    />}

    {activeView === "library" && <LibraryView
            sourcePreview={sourcePreview}
      libraryPageItems={libraryPageItems}
      libraryPageSize={libraryPageSize}
      setLibraryPageSize={setLibraryPageSize}
      libraryTotalPages={libraryTotalPages}
      librarySafePage={librarySafePage}
      setLibraryPage={setLibraryPage}
      PAGE_SIZE_OPTIONS={PAGE_SIZE_OPTIONS}
      archivedCount={archivedLibraryItems.length}
      openSource={openSource}
      openSourceArticle={openSourceArticle}
      channelRowsFor={channelRowsFor}
      archiveArticlesBefore={archiveArticlesBefore}
    />}

    {activeView === "publish" && <PublishView
            wechatJobs={wechatJobs}
      csdnJobs={csdnJobs}
      cnblogsJobs={cnblogsJobs}
      juejinJobs={juejinJobs}
      accounts={accounts}
      pendingPageItems={pendingPageItems}
      pendingTotalPages={pendingTotalPages}
      pendingSafePage={pendingSafePage}
      setPublishPendingPage={setPublishPendingPage}
      publishPendingPageSize={publishPendingPageSize}
      setPublishPendingPageSize={setPublishPendingPageSize}
      completedPageItems={completedPageItems}
      completedTotalPages={completedTotalPages}
      completedSafePage={completedSafePage}
      setPublishCompletedPage={setPublishCompletedPage}
      publishCompletedPageSize={publishCompletedPageSize}
      setPublishCompletedPageSize={setPublishCompletedPageSize}
      PAGE_SIZE_OPTIONS={PAGE_SIZE_OPTIONS}
      saving={saving}
      wechatJobsRefreshedAt={wechatJobsRefreshedAt}
      wechatJobsRefreshing={wechatJobsRefreshing}
      csdnDraftSaving={csdnDraftSaving}
      cnblogsDraftSaving={cnblogsDraftSaving}
      juejinDraftSaving={juejinDraftSaving}
      csdnDrafts={csdnDrafts}
      cnblogsDrafts={cnblogsDrafts}
      juejinDrafts={juejinDrafts}
      setActiveView={setActiveView}
      refreshWechatStatus={refreshWechatStatus}
      startWechatBrowserAssist={startWechatBrowserAssist}
      openWechatDraftBox={openWechatDraftBox}
      submitWechatJob={submitWechatJob}
      openWechatStatusCorrection={openWechatStatusCorrection}
      retryWechatJob={retryWechatJob}
      startCsdnBrowserAssist={startCsdnBrowserAssist}
      openCsdnStatusCorrection={openCsdnStatusCorrection}
      confirmCsdnPublish={confirmCsdnPublish}
      csdnJobCanStart={csdnJobCanStart}
      csdnJobCanCorrect={csdnJobCanCorrect}
      confirmCnblogsPublish={confirmCnblogsPublish}
      openCnblogsStatusCorrection={openCnblogsStatusCorrection}
      openCnblogsCredentialEntry={openCnblogsCredentialEntry}
      openExistingCnblogsDraft={openExistingCnblogsDraft}
      confirmJuejinPublish={confirmJuejinPublish}
      openJuejinStatusCorrection={openJuejinStatusCorrection}
      openJuejinCredentialEntry={openJuejinCredentialEntry}
      openExistingJuejinDraft={openExistingJuejinDraft}
    />}

    {activeView === "dashboard" && <DashboardView
            items={dashboardPageItems}
      totalItems={dashboardItems.length}
      accounts={accounts}
      wechatJobs={wechatJobs}
      saving={saving}
      openProjectCreator={openProjectCreator}
      openBrief={openBrief}
      openResearch={openResearch}
      openOutline={openOutline}
      openDraft={openDraft}
      openPublishPreparation={openPublishPreparation}
      deleteProjectDraft={deleteProjectDraft}
      openSourceArticle={openSourceArticle}
      channelRowsFor={channelRowsFor}
      page={dashboardSafePage}
      totalPages={dashboardTotalPages}
      pageSize={dashboardPageSize}
      setPage={setDashboardPage}
      setPageSize={setDashboardPageSize}
      PAGE_SIZE_OPTIONS={PAGE_SIZE_OPTIONS}
    />}

    {activeView === "logs" && <LogsView
            runtimeLogs={runtimeLogs}
      filteredRuntimeLogs={filteredRuntimeLogs}
      runtimeLogMeta={runtimeLogMeta}
      runtimeLogsLoading={runtimeLogsLoading}
      logDate={logDate}
      setLogDate={setLogDate}
      runtimeLogFilter={runtimeLogFilter}
      setRuntimeLogFilter={setRuntimeLogFilter}
      runtimeLogSearch={runtimeLogSearch}
      setRuntimeLogSearch={setRuntimeLogSearch}
      runtimeLogPath={runtimeLogPath}
      loadRuntimeLogs={loadRuntimeLogs}
    />}

    {editingSkill && <Modal onClose={closeSkillEditor} disabled={saving} title={editingSkill.name} eyebrow="技能管理" wide>
      <form onSubmit={saveSkill} className="profile-form">
        <p className="hint">{editingSkill.description}</p>
        <div className="skill-settings-row">
          <label className="toggle-label"><input type="checkbox" checked={editingSkill.enabled} onChange={(event) => setEditingSkill((current) => current ? { ...current, enabled: event.target.checked } : current)} />启用此技能</label>
          {["zhuque-detection", "contentany-detection"].includes(editingSkill.id) ? <p className="hint">此技能使用可见浏览器自动化，不需要大模型连接；浏览器登录状态会在本机保留。</p> : <label>模型连接<select value={editingSkill.provider ?? ""} onChange={(event) => setEditingSkill((current) => current ? { ...current, provider: (event.target.value || null) as ModelProviderId | null } : current)}>{modelConnections.filter((connection) => editingSkill.category === "图片" ? connection.provider === "modelscope" || connection.provider === "agnes" : connection.provider === "openai_codex" || connection.custom).map((connection) => <option key={connection.provider} value={connection.provider}>{connection.displayName}</option>)}</select></label>}
        </div>
        <div className="skill-file-workspace">
          <aside><strong>技能文件</strong>{editingSkill.files.map((file) => <button type="button" className={editingSkillFile?.relativePath === file.relativePath ? "active" : ""} onClick={() => void chooseSkillFile(file.relativePath)} key={file.relativePath}><span>{file.relativePath}</span><small>{Math.max(1, Math.ceil(file.size / 1024))} KB</small></button>)}</aside>
          <label><span>{editingSkillFile?.relativePath ?? "正在读取…"}{editingSkillFile && editingSkillFile.content !== savedSkillFileContent ? " · 未保存" : ""}</span><textarea className="skill-markdown-editor" value={editingSkillFile?.content ?? ""} onChange={(event) => setEditingSkillFile((current) => current ? { ...current, content: event.target.value, size: new Blob([event.target.value]).size } : current)} spellCheck={false} disabled={!editingSkillFile} /></label>
        </div>
        <small className="hint">技能目录：{editingSkill.filePath.replace(/[\\/]SKILL\.md$/i, "")}</small>
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={closeSkillEditor}>取消</button><button disabled={saving || !editingSkillFile}>{saving ? "正在保存…" : `保存 ${editingSkillFile?.relativePath ?? "技能文件"}`}</button></div>
      </form>
    </Modal>}
    {(editingConnection || connectionCreating) && <Modal onClose={closeConnectionModal} disabled={saving} title={connectionCreating ? "添加模型连接" : `配置 ${editingConnection?.displayName}`} eyebrow="模型连接">
      <form onSubmit={saveModelConnection} className="profile-form">
        {connectionCreating && <p className="hint">添加一个 OpenAI 兼容文本接口连接（连接名称 + 服务地址 + API Key），可用于自建 vLLM、网关或任意兼容 Responses API 的服务。</p>}
        <label>显示名称<input value={editingConnection?.displayName ?? ""} onChange={(event) => setEditingConnection((current) => current ? { ...current, displayName: event.target.value } : current)} /></label>
        <label>模型名称<input value={editingConnection?.modelId ?? ""} onChange={(event) => setEditingConnection((current) => current ? { ...current, modelId: event.target.value } : current)} placeholder="留空时使用服务默认模型" /></label>
        {(connectionCreating || editingConnection?.custom || editingConnection?.provider !== "openai_codex") && <label>API Key<input type="password" value={connectionCredential} onChange={(event) => setConnectionCredential(event.target.value)} autoComplete="new-password" placeholder={editingConnection?.credentialConfigured ? "已配置；留空不修改" : "请输入访问凭证"} /></label>}
        {(connectionCreating || editingConnection?.custom) && <label>服务地址<input value={editingConnection?.baseUrl ?? ""} onChange={(event) => setEditingConnection((current) => current ? { ...current, baseUrl: event.target.value } : current)} placeholder="例如：https://api.openai.com/v1" /></label>}
        {(connectionCreating || editingConnection?.custom || editingConnection?.provider !== "openai_codex") && <label>代理地址（可选）<input value={editingConnection?.proxyUrl ?? ""} onChange={(event) => setEditingConnection((current) => current ? { ...current, proxyUrl: event.target.value } : current)} placeholder="例如：http://127.0.0.1:7890" /><small>留空表示直连。需要代理才能访问的模型（如 Nous / OpenRouter / OpenAI）请填写；格式 http://127.0.0.1:7890。代理不可用时请求会明确报错，不会静默切换。</small></label>}
        {!connectionCreating && !editingConnection?.custom && editingConnection?.provider === "openai_codex" && <p className="hint">OpenAI Codex 使用本机 ChatGPT/Codex 登录状态，不需要 API Key。安装包会携带 SDK 所需运行组件，不要求安装 Hermes Agent。</p>}
        {!connectionCreating && !editingConnection?.custom && editingConnection?.provider === "openai_codex" && (
          <label className="checkbox-row">
            <input type="checkbox" checked={editingConnection.builtInSearch} onChange={(event) => setEditingConnection((current) => current ? { ...current, builtInSearch: event.target.checked } : current)} />
            <span>联网补研使用 Codex 内置搜索<small>开启时由 Codex SDK 直接联网检索并综合资料卡，开箱即用、质量更好。关闭时改用应用的 Tavily / DuckDuckGo 检索链（资料 URL 由系统真实抓取、可追溯，且走全局检索代理）。默认开启。</small></span>
          </label>
        )}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={closeConnectionModal}>取消</button><button disabled={saving}>{saving ? "正在保存…" : "保存连接"}</button></div>
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
