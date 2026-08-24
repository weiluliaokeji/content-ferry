import { FormEvent, useRef, useState } from "react";
import { request, streamGeneration } from "../api";
import { markdownTitle, parseZhuqueReport } from "../utils";
import { bestWechatJob, csdnJobCanConfirm, csdnJobCanCorrect, csdnJobCanStart, csdnJobLabel, cnblogsJobLabel, juejinJobLabel, wechatJobLabel } from "../publish-labels";
import { resolveArticleImageUrl } from "../markdown-preview";
import type { AccountPlatform, ChannelRow, CnblogsChannelDraft, CnblogsPublishJob, CnblogsPublishOptions, ContentSourceArticle, CsdnChannelDraft, CsdnPublishJob, JuejinChannelDraft, JuejinPublishJob, JuejinPublishOptions, MediaAccount, WechatPublishJob } from "../types";
import type { UseWorkbenchReturn } from "./useWorkbench";

export interface UseChannelOperationsParams {
  accounts: MediaAccount[];
  setAccounts: (value: MediaAccount[]) => void;
  loadAccounts: () => Promise<void>;
  loadProjects: () => Promise<void>;
  refreshSourcePreview: () => Promise<void>;
  saving: boolean;
  setError: (value: string) => void;
  setNotice: (value: string) => void;
  setActiveView: (value: "dashboard" | "library" | "publish" | "skills" | "accounts" | "logs" | "help") => void;
  wechatJobs: WechatPublishJob[];
  setWechatJobs: (value: WechatPublishJob[]) => void;
  wb: UseWorkbenchReturn;
}

// 渠道业务域：CSDN / 博客园 / 掘金三平台渠道草稿与发布作业
export function useChannelOperations(params: UseChannelOperationsParams) {
  const {
    accounts, setAccounts, loadAccounts, loadProjects, refreshSourcePreview,
    saving, setError, setNotice, setActiveView, wechatJobs, setWechatJobs, wb
  } = params;
  const {
    sourceModalOpen,
    setSourceModalOpen,
    sourcePath,
    setSourcePath,
    sourcePreview,
    setSourcePreview,
    libraryPage,
    setLibraryPage,
    expandedLibraryActions,
    setExpandedLibraryActions,
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
    optimizeDraft
  } = wb;
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
  const [correctingJuejinJob, setCorrectingJuejinJob] = useState<JuejinPublishJob | undefined>(undefined);
  const [correctedJuejinStatus, setCorrectedJuejinStatus] = useState<"published" | "failed" | "cancelled">("published");
  const [juejinStatusReason, setJuejinStatusReason] = useState("");
  const [juejinCorrectionSaving, setJuejinCorrectionSaving] = useState(false);
  const [juejinCorrectionError, setJuejinCorrectionError] = useState("");
  const cnblogsStatusRef = useRef<CnblogsPublishJob["status"] | null>(null);
  const juejinStatusRef = useRef<JuejinPublishJob["status"] | null>(null);
  const setCnblogsStatusRef = (value: CnblogsPublishJob["status"] | null) => {
    cnblogsStatusRef.current = value;
  };
  const setJuejinStatusRef = (value: JuejinPublishJob["status"] | null) => {
    juejinStatusRef.current = value;
  };
  const loadWechatJobs = async () => {
    try { setWechatJobs((await request<{ items: WechatPublishJob[] }>("/integrations/wechat/jobs")).items); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取微信发布记录。"); }
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
            rows.push({ platform: "wechat_official", label: "微信公众号", statusLabel: "已发布", tone: "success", action: { kind: "none" } });
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
    // 已是“已填充 / 待用户补齐”的任务：窗口多半还活着，主进程会走轻量“重新打开”
    // （仅提到前台 + 重启对话框轮询），不必再打 browser-assist 接口、刷新草稿列表，
    // 否则会额外触发一次网络往返，体验上像“又重新加载了一遍”。
    const knownJob = csdnJobs.find((entry) => entry.id === jobId);
    const alreadyPrepared = knownJob?.status === "ready_for_final_confirmation" || knownJob?.status === "needs_user";
      if (!alreadyPrepared) {
        const assistedJob = await request<CsdnPublishJob>(`/integrations/csdn/jobs/${jobId}/browser-assist`, { method: "POST" });
        setCsdnPublishJob(assistedJob);
      }
      await window.contentFerry.openCsdnPublisher(jobId);
      if (!alreadyPrepared) await loadCsdnChannelDrafts();
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
  return {
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
    refreshJuejinPublishJob
  };
}

export type UseChannelOperationsReturn = ReturnType<typeof useChannelOperations>;
