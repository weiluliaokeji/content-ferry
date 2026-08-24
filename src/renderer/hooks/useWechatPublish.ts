import { FormEvent, useRef, useState } from "react";
import { apiBase, request, streamGeneration } from "../api";
import { isHighAiDetectionResult, markdownTitle, parseZhuqueReport, providerName, sourceAssetContextId } from "../utils";
import { resolveArticleImageUrl } from "../markdown-preview";
import type { AppSettingsContract, ArticleSettings, ContentDraft, ContentProject, ContentSourceArticle, ManagedSkill, MediaAccount, ModelConnection, SelectedImage, WechatMaterial, WechatPublishJob, ZhuqueReport } from "../types";

export interface UseWechatPublishParams {
  accounts: MediaAccount[];
  projects: ContentProject[];
  settings: AppSettingsContract | null;
  skills: ManagedSkill[];
  modelConnections: ModelConnection[];
  loadProjects: () => Promise<void>;
  loadSkillsAndConnections: () => Promise<void>;
  setError: (value: string) => void;
  setSaving: (value: boolean) => void;
  setActiveView: (value: "dashboard" | "library" | "publish" | "skills" | "accounts" | "logs" | "help") => void;
  setSourceArticle: (value: ContentSourceArticle | undefined) => void;
  setDraftProject: (value: ContentProject | undefined) => void;
  setDraft: (value: ContentDraft | undefined) => void;
  setArticleWorkspacePanel: (value: "assistant" | "preview" | "settings") => void;
  openDraft: (project: ContentProject) => Promise<void>;
  openSourceArticle: (relativePath: string, panel?: "assistant" | "preview" | "settings", showError?: boolean) => Promise<boolean>;
  loadWechatJobs: () => Promise<void>;
  orphanedWechatJob: WechatPublishJob | undefined;
  setOrphanedWechatJob: (value: WechatPublishJob | undefined) => void;
}

// 微信发布流程域（拆分自 App.tsx）
export function useWechatPublish(params: UseWechatPublishParams) {
  const {
    accounts, projects, settings, skills, modelConnections,
    loadProjects, loadSkillsAndConnections, setError, setSaving, setActiveView,
    setSourceArticle, setDraftProject, setDraft, setArticleWorkspacePanel,
    openDraft, openSourceArticle, loadWechatJobs, orphanedWechatJob, setOrphanedWechatJob
  } = params;

  const [publishProject, setPublishProject] = useState<ContentProject>();
  const [publishSource, setPublishSource] = useState<ContentSourceArticle>();
  const [publishAccountId, setPublishAccountId] = useState("");
  const [publishAuthor, setPublishAuthor] = useState("");
  const [publishDigest, setPublishDigest] = useState("");
  const [publishNeedOpenComment, setPublishNeedOpenComment] = useState(true);
  const [publishOnlyFansCanComment, setPublishOnlyFansCanComment] = useState(false);
  const [publishDeclareOriginal, setPublishDeclareOriginal] = useState(true);
  const [publishEnableReward, setPublishEnableReward] = useState(true);
  const [publishCollectionName, setPublishCollectionName] = useState("");
  const [publishThumbMediaId, setPublishThumbMediaId] = useState("");
  const [publishCoverSource, setPublishCoverSource] = useState("");
  const [publishCoverPreview, setPublishCoverPreview] = useState("");
  const [publishCoverLabel, setPublishCoverLabel] = useState("");
  const [wechatMaterials, setWechatMaterials] = useState<WechatMaterial[]>([]);
  const [modelScopePrompt, setModelScopePrompt] = useState("");
  const [coverGenerating, setCoverGenerating] = useState(false);
  const [coverProvider, setCoverProvider] = useState<"modelscope" | "agnes">("modelscope");
  const [publishCropImage, setPublishCropImage] = useState<SelectedImage>();
  const [publishCheckMarkdown, setPublishCheckMarkdown] = useState("");
  const [publishAiCheckResult, setPublishAiCheckResult] = useState("");
  const [publishZhuqueReport, setPublishZhuqueReport] = useState<ZhuqueReport>();
  const [publishAiCheckTool, setPublishAiCheckTool] = useState<"zhuque" | "contentany">();
  const [publishAiOverrideReason, setPublishAiOverrideReason] = useState("");
  const publishAiOverrideReasonDirtyRef = useRef(false);
  const setPublishAiOverrideReasonDirtyRef = (value: boolean) => {
    publishAiOverrideReasonDirtyRef.current = value;
  };
  const [publishAiCheckRunning, setPublishAiCheckRunning] = useState(false);
  const [publishDetector, setPublishDetector] = useState<"zhuque" | "contentany">("zhuque");
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
    if (!publishAiCheckResult && publishAiOverrideReason.length < 1) {
      setError("请先完成腾讯朱雀或 ContentAny 任一项 AIGC 特征检测；如检测暂时无法完成，请填写至少 1 个字的例外发布理由。");
      return;
    }
    if (highAiRisk && publishAiOverrideReason.length < 1) {
      setError("检测结果显示 AI 特征偏高。仍需发布时，请填写至少 1 个字的例外发布理由。");
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

  return {
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
  };
}

export type UseWechatPublishReturn = ReturnType<typeof useWechatPublish>;
