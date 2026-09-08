import { z } from "zod";

export const accountInput = z.object({
  platform: z.enum(["wechat_official", "csdn", "cnblogs", "juejin", "51cto"]),
  displayName: z.string().trim().min(1).max(100),
  externalAccountId: z.string().trim().min(1).max(200).optional()
});
export const accountRenameInput = z.object({
  displayName: z.string().trim().min(1).max(100),
  externalAccountId: z.string().trim().max(200).optional().nullable()
});

export const profileInput = z.object({
  positioning: z.string().max(4000).default(""),
  targetAudience: z.string().max(4000).default(""),
  prohibitedTopics: z.string().max(4000).default(""),
  writingStyle: z.string().max(4000).default(""),
  regularColumns: z.string().max(4000).default(""),
  articleSignature: z.string().max(4000).default("")
});

export const credentialInput = z.object({ secret: z.string().min(1).max(10000) });
export const contentSourceInput = z.object({
  rootPath: z.string().trim().min(1).max(1000),
  sourceType: z.enum(["vitepress", "plain"]).default("vitepress"),
  pattern: z.object({
    baseDir: z.string().trim().max(200).optional(),
    entryFile: z.string().trim().max(120).optional(),
    assetDir: z.string().trim().max(120).optional(),
    extraIgnoreDirs: z.array(z.string().trim().min(1).max(120)).max(20).optional()
  }).optional()
});
export const contentSourceArticleQuery = z.object({ path: z.string().trim().min(1).max(1000) });
export const contentSourceArticleInput = z.object({ path: z.string().trim().min(1).max(1000), markdown: z.string().max(500000) });
export const contentSourceArchiveInput = z.object({ path: z.string().trim().min(1).max(1000), archived: z.boolean() });
export const contentSourceAssetInput = z.object({
  path: z.string().trim().min(1).max(1000),
  mimeType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
  base64: z.string().min(1).max(21_000_000)
});
export const contentProjectInput = z.object({
  topic: z.string().trim().min(1).max(12000),
  title: z.string().trim().min(1).max(120).optional(),
  targetAccountId: z.string().uuid().optional(),
  objective: z.string().max(4000).optional(),
  audience: z.string().max(4000).optional(),
  angle: z.string().max(4000).optional(),
  sourceNotes: z.string().max(12000).optional()
});
export const contentProjectTitleInput = z.object({ title: z.string().trim().min(1).max(120) });
export const contentBriefInput = z.object({ topic: z.string().trim().min(1).max(12000).optional(), objective: z.string().max(4000), audience: z.string().max(4000), angle: z.string().max(4000), sourceNotes: z.string().max(12000) });
export const titleSuggestionInput = contentBriefInput;
export const contentOutlineInput = z.object({ markdown: z.string().trim().min(1).max(30000) });
export const contentDraftInput = z.object({ markdown: z.string().trim().min(1).max(100000) });
export const researchSelectionInput = z.object({ selected: z.boolean() });
export const researchFollowUpInput = z.object({ message: z.string().trim().min(1).max(4000) });
export const researchManualSourceInput = z.object({
  title: z.string().trim().min(1).max(300),
  url: z.string().trim().max(4000).optional(),
  excerpt: z.string().trim().min(1).max(5000),
  keyClaims: z.array(z.string().trim().min(1).max(1000)).max(10).default([])
});
export const executionRequestInput = z.object({
  projectId: z.string().uuid().optional(),
  targetType: z.enum(["host_trusted", "wsl", "docker", "windows_sandbox"]),
  runtime: z.enum(["python", "node", "git", "custom"]),
  executable: z.string().trim().max(2000).optional(),
  args: z.array(z.string().max(4000)).min(1).max(64),
  cwd: z.string().trim().min(1).max(2000),
  directoryGrants: z.array(z.object({ path: z.string().trim().min(1).max(2000), access: z.enum(["read", "write"]) })).min(1).max(20),
  networkPolicy: z.enum(["disabled", "allowlist", "direct"]),
  allowedHosts: z.array(z.string().trim().max(255)).max(50).optional(),
  dependencies: z.array(z.object({ executable: z.string().trim().min(1).max(2000), args: z.array(z.string().max(4000)).max(64), approved: z.boolean(), source: z.string().trim().max(1000).optional() })).max(10).optional(),
  timeoutMs: z.number().int().min(1000).max(600000).optional(),
  outputLimitBytes: z.number().int().min(4096).max(10485760).optional(),
  outputDirectory: z.string().trim().max(2000).optional(),
  targetOptions: z.object({
    wslDistribution: z.string().trim().max(64).optional(),
    dockerImage: z.string().trim().max(240).optional(),
    dockerMemoryInMb: z.number().int().min(256).max(16384).optional(),
    dockerCpus: z.number().min(0.1).max(32).optional(),
    dockerPidsLimit: z.number().int().min(32).max(4096).optional(),
    sandboxMemoryInMb: z.number().int().min(1024).max(8192).optional()
  }).strict().optional(),
  confirmed: z.boolean().default(false),
  acknowledgeHostRisk: z.boolean().default(false)
}).strict();
export const executionProjectQuery = z.object({ projectId: z.string().uuid().optional() });
export const executionObservationInput = z.object({
  title: z.string().trim().min(1).max(300),
  claim: z.string().trim().min(1).max(3000)
}).strict();
export const executionRunParams = z.object({ runId: z.string().uuid() });
export const gitSourceInput = z.object({
  projectId: z.string().uuid().optional(),
  repositoryUrl: z.string().url().max(2000),
  destination: z.string().trim().min(1).max(2000),
  ref: z.string().trim().max(200).optional(),
  networkPolicy: z.enum(["allowlist", "direct"]),
  allowedHosts: z.array(z.string().trim().max(255)).max(50).optional(),
  confirmed: z.boolean().default(false)
}).strict();
export const gitAnalyzeInput = z.object({
  projectId: z.string().uuid().optional(),
  destination: z.string().trim().min(1).max(2000),
  repositoryUrl: z.string().url().max(2000),
  paths: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  maxLinesPerFile: z.number().int().min(20).max(800).default(400),
  confirmed: z.boolean().default(false)
}).strict();
export const permissionGrantInput = z.object({
  scope: z.enum(["global", "project", "run"]),
  decision: z.enum(["allow", "ask", "deny"]),
  toolId: z.string().trim().max(200).optional(),
  action: z.enum(["read", "network_read", "write", "delete", "install", "external_write", "publish", "sensitive_read"]).optional(),
  projectId: z.string().uuid().optional(),
  targetPrefix: z.string().trim().max(2000).optional(),
  expiresAt: z.string().datetime().nullable().optional()
}).strict().superRefine((value, context) => {
  if (value.scope === "project" && !value.projectId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["projectId"], message: "项目授权必须指定 projectId。" });
  if (value.scope !== "project" && value.projectId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["projectId"], message: "只有项目授权可以指定 projectId。" });
});
export const permissionGrantQuery = z.object({ projectId: z.string().uuid().optional() });
export const permissionGrantParams = z.object({ grantId: z.string().uuid() });
export const contentRevisionInput = z.object({ aiCheckResult: z.string().max(4000), guidance: z.string().max(8000) });
export const contentAssetInput = z.object({
  contextId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  mimeType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
  base64: z.string().min(1).max(21_000_000)
});
export const remoteImageImportInput = z.object({
  url: z.string().url().max(4000),
  contextId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
  path: z.string().trim().min(1).max(1000).optional()
}).superRefine((value, context) => {
  if (Boolean(value.contextId) === Boolean(value.path)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "必须提供文章路径或素材上下文。" });
  }
});
export const contentReviewInput = z.object({ status: z.enum(["pending", "needs_revision", "approved"]), factChecked: z.boolean(), accountFitChecked: z.boolean(), aiCheckResult: z.string().max(4000), notes: z.string().max(8000) });
export const wechatDraftInput = z.object({
  accountId: z.string().uuid(),
  projectId: z.string().uuid(),
  author: z.string().max(16).optional(),
  digest: z.string().max(120).optional(),
  thumbMediaId: z.string().max(256).optional(),
  coverSource: z.string().max(2000).optional(),
  needOpenComment: z.boolean().default(true),
  onlyFansCanComment: z.boolean().default(false),
  declareOriginal: z.boolean().default(false),
  enableReward: z.boolean().default(false),
  collectionName: z.string().trim().max(80).default("")
});
export const wechatSourceDraftInput = z.object({
  accountId: z.string().uuid(),
  relativePath: z.string().trim().min(1).max(1000),
  author: z.string().max(16).optional(),
  digest: z.string().max(120).optional(),
  thumbMediaId: z.string().max(256).optional(),
  coverSource: z.string().max(2000).optional(),
  needOpenComment: z.boolean().default(true),
  onlyFansCanComment: z.boolean().default(false),
  declareOriginal: z.boolean().default(false),
  enableReward: z.boolean().default(false),
  collectionName: z.string().trim().max(80).default("")
});
export const wechatSubmitInput = z.object({ mode: z.enum(["publish", "mass"]) });
export const csdnChannelDraftInput = z.object({
  accountId: z.string().uuid(),
  relativePath: z.string().trim().min(1).max(1000),
  projectId: z.string().uuid().optional(),
  generationMode: z.enum(["rewrite", "source"]).default("source")
});
export const csdnChannelDraftSaveInput = z.object({
  title: z.string().trim().min(1).max(120),
  markdown: z.string().trim().min(1).max(100_000),
  author: z.string().trim().max(16).optional(),
  digest: z.string().trim().max(200).optional(),
  coverSource: z.string().trim().max(2000).optional()
});
export const cnblogsChannelDraftInput = z.object({
  accountId: z.string().uuid(),
  relativePath: z.string().trim().min(1).max(1000),
  projectId: z.string().uuid().optional(),
  generationMode: z.enum(["rewrite", "source"]).default("source")
});
export const cnblogsChannelDraftSaveInput = z.object({
  title: z.string().trim().min(1).max(120),
  markdown: z.string().trim().min(1).max(100_000),
  author: z.string().trim().max(16).optional(),
  digest: z.string().trim().max(200).optional(),
  coverSource: z.string().trim().max(2000).optional()
});
export const cnblogsPublishOptionsInput = z.object({
  categories: z.array(z.string().trim().max(80)).max(10).optional(),
  tags: z.array(z.string().trim().max(40)).max(20).optional()
});
export const juejinChannelDraftInput = z.object({
  accountId: z.string().uuid(),
  relativePath: z.string().trim().min(1).max(1000),
  projectId: z.string().uuid().optional(),
  generationMode: z.enum(["rewrite", "source"]).default("source")
});
export const juejinChannelDraftSaveInput = z.object({
  title: z.string().trim().min(1).max(80),
  markdown: z.string().trim().min(1).max(100_000),
  author: z.string().trim().max(16).optional(),
  digest: z.string().trim().max(200).optional(),
  coverSource: z.string().trim().max(2000).optional()
});
export const juejinPublishOptionsInput = z.object({
  categoryId: z.string().trim().max(80).optional(),
  tagIds: z.array(z.string().trim().max(80)).max(5).optional()
});
export const fiftyoneCtoChannelDraftInput = z.object({
  accountId: z.string().uuid(),
  relativePath: z.string().trim().min(1).max(1000),
  projectId: z.string().uuid().optional(),
  generationMode: z.enum(["rewrite", "source"]).default("source")
});
export const fiftyoneCtoChannelDraftSaveInput = z.object({
  title: z.string().trim().min(1).max(120),
  markdown: z.string().trim().min(1).max(100_000),
  author: z.string().trim().max(16).optional(),
  digest: z.string().trim().max(200).optional(),
  coverSource: z.string().trim().max(2000).optional()
});
export const fiftyoneCtoPublishOptionsInput = z.object({
  pid: z.string().trim().max(40).optional(),
  cateId: z.string().trim().max(40).optional(),
  tags: z.array(z.string().trim().max(40)).max(10).optional(),
  blogType: z.enum(["1", "2", "3"]).default("1")
});
export const modelProviderSchema = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9:_-]+$/);
export const modelConnectionInput = z.object({
  displayName: z.string().trim().min(1).max(100),
  modelId: z.string().trim().max(200).default(""),
  baseUrl: z.string().trim().max(1000).default(""),
  proxyUrl: z.string().trim().max(1000).default(""),
  enabled: z.boolean().default(true),
  builtInSearch: z.boolean().default(true),
  credential: z.string().max(10000).optional()
});
export const modelCustomConnectionInput = z.object({
  displayName: z.string().trim().min(1).max(100),
  modelId: z.string().trim().max(200).default(""),
  baseUrl: z.string().trim().min(1).max(1000),
  proxyUrl: z.string().trim().max(1000).default(""),
  credential: z.string().max(10000).optional()
});
export const tavilySettingsInput = z.object({ apiKey: z.string().trim().min(1).max(10000) });
export const tavilyTestInput = z.object({ apiKey: z.string().trim().min(1).max(10000).optional() });
export const skillInput = z.object({
  markdown: z.string().min(1).max(100000),
  enabled: z.boolean(),
  provider: modelProviderSchema.nullable()
});
export const skillFileQuery = z.object({ path: z.string().trim().min(1).max(500) });
export const skillFileInput = z.object({ path: z.string().trim().min(1).max(500), content: z.string().max(200000) });
export const articleSummaryInput = z.object({
  platform: z.enum(["wechat_official", "csdn", "cnblogs", "juejin", "51cto"]),
  title: z.string().trim().max(500).default(""),
  markdown: z.string().trim().min(1).max(500000)
});
export const articleSummaryOutput = z.object({ summary: z.string().trim().min(1).max(500) });
export const selectionEditInput = z.object({
  action: z.enum(["rewrite", "expand", "shorten", "example", "humanize"]),
  contextKey: z.string().trim().min(1).max(1200).optional(),
  selectedText: z.string().min(1).max(20000),
  beforeText: z.string().max(6000).default(""),
  afterText: z.string().max(6000).default(""),
  title: z.string().max(500).default(""),
  instruction: z.string().trim().max(1000).default("")
});
export const selectionEditOutput = z.object({ replacement: z.string().min(1).max(50000) });
export const coverPromptInput = z.object({
  title: z.string().trim().max(500).default(""),
  markdown: z.string().trim().min(1).max(500000)
});
export const coverPromptOutput = z.object({ prompt: z.string().trim().min(1).max(2000) });
export const articleChatQuery = z.object({ contextKey: z.string().trim().min(1).max(1200) });
export const articleChatInput = z.object({
  contextKey: z.string().trim().min(1).max(1200),
  clientMessageId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  title: z.string().trim().max(500).default(""),
  markdown: z.string().max(500000),
  message: z.string().trim().min(1).max(12000)
});
export const articleChatSuggestion = z.object({
  original: z.string().trim().min(6).max(2000),
  replacement: z.string().trim().min(1).max(3000),
  reason: z.string().trim().min(1).max(500),
  status: z.enum(["pending", "accepted", "rejected", "unavailable"]).default("pending")
});
export const articleChatOutput = z.object({ reply: z.string().trim().min(1).max(20000), memorySuggestion: z.string().trim().max(1000).default(""), writingMemorySuggestion: z.string().trim().max(1000).default(""), suggestions: z.array(articleChatSuggestion).max(5).default([]) });
export const articleChatMemoryInput = z.object({ contextKey: z.string().trim().min(1).max(1200), memory: z.string().trim().min(1).max(1000) });
export const agentMemoryQuery = z.object({
  scopeKey: z.string().trim().min(1).max(1200),
  status: z.enum(["candidate", "active", "superseded", "expired", "rejected", "deleted", "all"]).default("active")
});
export const agentMemoryStatusInput = z.object({ status: z.enum(["active", "expired", "deleted"]) });
export const agentMemoryForgetInput = z.object({ scopeKey: z.string().trim().min(1).max(1200), mode: z.enum(["derived", "all"]) });
export const agentMemoryExportQuery = z.object({
  scopeKey: z.string().trim().min(1).max(12000),
  includeEvents: z.enum(["0", "1"]).default("1")
});
export const agentMemoryImportInput = z.object({
  snapshot: z.unknown(),
  mode: z.enum(["merge", "replace"]).default("merge")
});
export const agentMemoryCandidateParams = z.object({ candidateId: z.string().uuid() });
export const agentMemoryParams = z.object({ memoryId: z.string().uuid() });
export const articleChatSuggestionParams = z.object({
  messageId: z.string().uuid(),
  suggestionIndex: z.coerce.number().int().min(0).max(4)
});
export const articleChatSuggestionStatusInput = z.object({ status: z.enum(["accepted", "rejected", "unavailable"]) });

export interface CsdnBrowserConfirmResult {
  remoteUrl: string | null;
  remoteContentId: string | null;
}
