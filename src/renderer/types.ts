// 应用与业务类型定义（自 main.tsx 拆分，语义保持不变）
export type AppSettingsContract = {
  schemaVersion: 1;
  dataDir: string;
  firstRunCompleted: boolean;
  aiInitStatus: "not_initialized" | "ready" | "login_required" | "binary_missing";
  codexBinaryPath: string | null;
  auditAiCalls: boolean;
  createdAt: string;
  updatedAt: string;
};

export type RootState =
  | { status: "loading" }
  | { status: "wizard"; settings: AppSettingsContract }
  | { status: "ready"; settings: AppSettingsContract };

export type AccountPlatform = "wechat_official" | "csdn" | "cnblogs" | "juejin";
export type AccountProfile = { positioning: string; targetAudience: string; prohibitedTopics: string; writingStyle: string; regularColumns: string };
export type MediaAccount = { id: string; platform: AccountPlatform; displayName: string; externalAccountId: string | null; credentialsConfigured: boolean; profile: AccountProfile };
export type ContentSourcePreview = { rootPath: string; articleCount: number; sitePageCount: number; items: Array<{ relativePath: string; title: string | null; frontMatterKeys: string[]; createdAt: string | null }>; truncated: boolean; warnings: string[] };
export type ContentSourceArticle = { relativePath: string; title: string | null; markdown: string; frontMatter: string };
export type ContentProject = { id: string; targetAccountId: string | null; sourceRelativePath: string | null; topic: string; status: "idea"; briefReady: boolean; researchReady: boolean; outlineReady: boolean; draftReady: boolean; reviewStatus: "pending" | "needs_revision" | "approved" | null };
export type ContentBrief = { projectId: string; topic: string; objective: string; audience: string; angle: string; sourceNotes: string; generatedFromAccountProfile: boolean };
export type ResearchSource = { id: string; title: string; url: string; excerpt: string; keyClaims: string[]; sourceType: "official" | "public"; retrievedAt: string; selected: boolean };
export type ContentResearch = { projectId: string; planMarkdown: string; sources: ResearchSource[]; updatedAt: string | null; provider?: string; model?: string | null };
export type TitleSuggestion = { projectId: string; titles: string[]; historicalSeries: Array<{ name: string; count: number; examples: string[] }> };
export type ContentOutline = { projectId: string; markdown: string; generatedFromBrief: boolean };
export type ContentDraft = { projectId: string; markdown: string; generatedFromOutline: boolean; sourceRelativePath?: string | null };
export type ContentReview = { projectId: string; status: "pending" | "needs_revision" | "approved"; factChecked: boolean; accountFitChecked: boolean; aiCheckResult: string; notes: string };
export type WechatPublishJob = {
  id: string; accountId: string; projectId: string | null; sourceRelativePath: string | null; mode: "draft" | "publish" | "mass"; title: string;
  draftMediaId: string | null; publishId: string | null; messageId: string | null;
  status: "draft_ready" | "browser_editing" | "submitted" | "published" | "failed" | "cancelled"; errorMessage: string | null;
  statusSource: "system" | "wechat" | "browser" | "manual"; statusNote: string | null;
  declareOriginal: boolean; enableReward: boolean; collectionName: string; updatedAt: string;
};
export type CsdnChannelDraft = {
  id: string; accountId: string; projectId: string | null; sourceRelativePath: string; sourceHash: string;
  generationMode: "rewrite" | "source"; title: string; markdown: string; author: string; digest: string; coverSource: string;
  status: "draft" | "approved" | "superseded"; updatedAt: string;
};
export type CsdnPublishJob = {
  id: string; accountId: string; channelDraftId: string;
  status: "queued" | "needs_login" | "filling" | "needs_user" | "ready_for_final_confirmation" | "submitting" | "published" | "needs_manual_reconciliation" | "failed_before_submit" | "failed" | "cancelled";
  statusNote: string | null; errorMessage: string | null;
  remoteUrl: string | null; remoteContentId: string | null;
  updatedAt: string;
};
export type CnblogsChannelDraft = {
  id: string; accountId: string; projectId: string | null; sourceRelativePath: string; sourceHash: string;
  generationMode: "rewrite" | "source"; title: string; markdown: string; author: string; digest: string; coverSource: string;
  status: "draft" | "approved" | "superseded"; updatedAt: string;
};
export type CnblogsPublishJob = {
  id: string; accountId: string; channelDraftId: string;
  status: "draft_creating" | "draft_created" | "confirming" | "published" | "failed" | "needs_manual_reconciliation" | "cancelled" | "needs_credentials";
  statusNote: string | null; errorMessage: string | null;
  remoteUrl: string | null; remoteContentId: string | null;
  updatedAt: string;
};
export type CnblogsPublishOptions = {
  categories: string[];
  tags: string[];
};
export type JuejinChannelDraft = {
  id: string; accountId: string; projectId: string | null; sourceRelativePath: string; sourceHash: string;
  generationMode: "rewrite" | "source"; title: string; markdown: string; author: string; digest: string; coverSource: string;
  status: "draft" | "approved" | "superseded"; updatedAt: string;
};
export type JuejinPublishJob = {
  id: string; accountId: string; channelDraftId: string;
  status: "draft_creating" | "draft_created" | "confirming" | "published" | "failed" | "needs_manual_reconciliation" | "cancelled" | "needs_credentials";
  statusNote: string | null; errorMessage: string | null;
  remoteUrl: string | null; remoteContentId: string | null;
  updatedAt: string;
};
export type JuejinPublishOptions = {
  categoryId: string;
  tagIds: string[];
};
export type ChannelAction =
  | { kind: "enter"; label: string; onClick: () => void }
  | { kind: "generate"; label: string; onClick: () => void }
  | { kind: "continue"; label: string; onClick: () => void };
export type ChannelRow = {
  platform: AccountPlatform;
  label: string;
  statusLabel: string;
  tone: "neutral" | "info" | "success" | "warning";
  action: ChannelAction;
};
export type WechatCredentialStatus = { appId: string; appSecretConfigured: boolean; callbackTokenConfigured: boolean; localCallbackUrl: string; cnblogsUsername?: string; cnblogsApiKeyConfigured?: boolean; juejinCookieConfigured?: boolean; juejinAidConfigured?: boolean; juejinUuidConfigured?: boolean };
export type WechatMaterial = { mediaId: string; name: string; updatedAt: string; url: string | null };
export type SelectedImage = { fileName: string; mimeType: string; base64: string };
export type ArticleSettings = {
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
export type ModelProviderId = "openai_codex" | "openai" | "openrouter" | "nous" | "nvidia_build" | "github_copilot" | "modelscope" | "agnes";
export type ModelConnection = {
  provider: ModelProviderId; displayName: string; modelId: string; baseUrl: string; proxyUrl: string;
  enabled: boolean; builtInSearch: boolean; credentialConfigured: boolean;
};
export type WebSearchSettings = {
  tavilyConfigured: boolean;
  tavilyCredentialSource: "local" | "environment" | "none";
  researchProxyUrl: string;
};
export type ManagedSkill = {
  id: string; name: string; description: string; category: "创作" | "改写" | "检测" | "图片" | "研究";
  enabled: boolean; provider: ModelProviderId | null; markdown: string; filePath: string;
  files: Array<{ relativePath: string; size: number }>;
};
export type SkillFileContent = { relativePath: string; content: string; size: number };
export type ArticleChatSuggestion = { original: string; replacement: string; reason: string; status?: "pending" | "accepted" | "rejected" | "unavailable" };
export type ArticleChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  memorySuggestion: string;
  suggestions: ArticleChatSuggestion[];
  createdAt: string;
  deliveryState?: "sending" | "failed";
};
export type ZhuqueReport = {
  verdict: string;
  humanPercent: number | null;
  uncertainPercent: number | null;
  aiPercent: number | null;
  ratioSource: "official" | "segments";
  segments: Array<{ text: string; kind: "human" | "uncertain" | "ai" }>;
};
export type ContentAnyReference = { label: string; score: string | null; summary: string; detail: string };
export type RuntimeLogEntry = {
  time: number | null; level: number; message: string; requestId: string; method: string; url: string;
  statusCode: number | null; responseTime: number | null; error: string;
};
export type RuntimeLogResponse = {
  filePath: string; items: RuntimeLogEntry[]; availableDates?: string[];
  totalMatched: number; hasMore: boolean; sourceTruncated: boolean; readWindowBytes: number;
};

