import { FormEvent, useRef, useState } from "react";
import { request, streamGeneration } from "../api";
import { markdownOffsetAtTextareaTop } from "../utils";
import type { AccountPlatform, AccountProfile, ContentBrief, ContentDraft, ContentOutline, ContentProject, ContentResearch, ContentReview, ContentSourceArticle, ContentSourcePreview, MediaAccount, ResearchSource, TitleSuggestion, WechatPublishJob, ZhuqueReport } from "../types";

export interface UseWorkbenchParams {
  accounts: MediaAccount[];
  setAccounts: (value: MediaAccount[]) => void;
  setProjects: (value: ContentProject[]) => void;
  error: string;
  setError: (value: string) => void;
  saving: boolean;
  setSaving: (value: boolean) => void;
  wechatJobs: WechatPublishJob[];
  loadAccounts: () => Promise<void>;
  loadProjects: () => Promise<void>;
  refreshSourcePreview: () => Promise<ContentSourcePreview | undefined>;
  platform: AccountPlatform;
  setPlatform: (value: AccountPlatform) => void;
  displayName: string;
  setDisplayName: (value: string) => void;
  platformExternalId: string;
  setPlatformExternalId: (value: string) => void;
  editing: MediaAccount | undefined;
  setEditing: (value: MediaAccount | undefined) => void;
  editingDisplayName: string;
  setEditingDisplayName: (value: string) => void;
  editingExternalId: string;
  setEditingExternalId: (value: string) => void;
  profile: AccountProfile;
  setProfile: (value: AccountProfile) => void;
}

// 工作台业务域：内容源扫描、项目/简报/研究/提纲/草稿/评审流程
export function useWorkbench(params: UseWorkbenchParams) {
  const {
    accounts, setAccounts, setProjects,
    error, setError, saving, setSaving,
    wechatJobs, loadAccounts, loadProjects, refreshSourcePreview,
    platform, setPlatform, displayName, setDisplayName, platformExternalId, setPlatformExternalId,
    editing, setEditing, editingDisplayName, setEditingDisplayName, editingExternalId, setEditingExternalId,
    profile, setProfile
  } = params;
  const [sourceModalOpen, setSourceModalOpen] = useState(false);
  const [sourcePath, setSourcePath] = useState("");
  const [sourcePreview, setSourcePreview] = useState<ContentSourcePreview>();
  const [libraryPage, setLibraryPage] = useState(1);
  const [publishPendingPage, setPublishPendingPage] = useState(1);
  const [publishCompletedPage, setPublishCompletedPage] = useState(1);
  const [libraryPageSize, setLibraryPageSize] = useState(5);
  const [publishPendingPageSize, setPublishPendingPageSize] = useState(5);
  const [publishCompletedPageSize, setPublishCompletedPageSize] = useState(5);
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
  const setBriefRequestVersionRef = (value: number | ((prev: number) => number)) => {
    briefRequestVersionRef.current =
      typeof value === "function"
        ? (value as (prev: number) => number)(briefRequestVersionRef.current)
        : value;
  };
  const setTitleSuggestionAbortRef = (value: AbortController | undefined) => {
    titleSuggestionAbortRef.current = value;
  };
  const [briefTitle, setBriefTitle] = useState("");
  const [titleSuggestions, setTitleSuggestions] = useState<string[]>([]);
  const [historicalSeries, setHistoricalSeries] = useState<TitleSuggestion["historicalSeries"]>([]);
  const [titleSuggesting, setTitleSuggesting] = useState(false);
  const [outlineProject, setOutlineProject] = useState<ContentProject>();
  const [outline, setOutline] = useState<ContentOutline>();
  const [outlineGenerating, setOutlineGenerating] = useState(false);
  const [outlineGenerationStatus, setOutlineGenerationStatus] = useState("");
  const outlineAbortRef = useRef<AbortController | undefined>(undefined);
  const setOutlineAbortRef = (value: AbortController | undefined) => {
    outlineAbortRef.current = value;
  };
  const [outlineEditorMode, setOutlineEditorMode] = useState<"visual" | "markdown">("visual");
  const [outlineModeScrollOffset, setOutlineModeScrollOffset] = useState(0);
  const outlineMarkdownSourceRef = useRef<HTMLTextAreaElement | null>(null);
  const setOutlineMarkdownSourceRef = (value: HTMLTextAreaElement | null) => {
    outlineMarkdownSourceRef.current = value;
  };
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
  const setDraftAbortRef = (value: AbortController | undefined) => {
    draftAbortRef.current = value;
  };
  const [reviewProject, setReviewProject] = useState<ContentProject>();
  const [review, setReview] = useState<ContentReview>();
  const [zhuqueReport, setZhuqueReport] = useState<ZhuqueReport>();
  const [zhuqueRunning, setZhuqueRunning] = useState(false);
  const [activeView, setActiveView] = useState<"dashboard" | "library" | "publish" | "skills" | "accounts" | "logs" | "help">("dashboard");
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
  const setArticleArchived = async (relativePath: string, archived: boolean) => {
    try {
      await request<ContentSourceArticle>("/content-source/article/archive", {
        method: "PUT",
        body: JSON.stringify({ path: relativePath, archived })
      });
      setSourcePreview(await request<ContentSourcePreview>("/content-source/preview"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "归档状态更新失败。"); }
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
  return {
    activeView,
    setActiveView,
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
  };
}

export type UseWorkbenchReturn = ReturnType<typeof useWorkbench>;
