import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { apiBase, platformName, request } from "../api";
import { extractMarkdownImages, renderPhonePreview, resolveArticleImageUrl } from "../markdown-preview";
import { locateMarkdownSelection } from "../markdown-selection";
import { markdownOffsetAtTextareaTop, readImageUrl, scrollEditorToHeading, scrollTextareaToMarkdownOffset } from "../utils";
import { AwenBottomPanel, markUnansweredAwenMessages, removeUnavailableAwenSuggestions } from "./AwenPanels";
import { CoverCropModal } from "./CoverCropModal";
import { SelectionDiffModal } from "./SelectionDiffModal";
import { ContentAnyReferenceView, ZhuqueReportView } from "./ZhuqueReportViews";
import type { AppSettingsContract, RootState, AccountPlatform, AccountProfile, MediaAccount, ContentSourcePreview, ContentSourceArticle, ContentProject, ContentBrief, ResearchSource, ContentResearch, TitleSuggestion, ContentOutline, ContentDraft, ContentReview, WechatPublishJob, CsdnChannelDraft, CsdnPublishJob, CnblogsChannelDraft, CnblogsPublishJob, CnblogsPublishOptions, JuejinChannelDraft, JuejinPublishJob, JuejinPublishOptions, ChannelAction, ChannelRow, WechatCredentialStatus, WechatMaterial, SelectedImage, ArticleSettings, ModelProviderId, ModelConnection, WebSearchSettings, ManagedSkill, SkillFileContent, ArticleChatSuggestion, ArticleChatMessage, ZhuqueReport, ContentAnyReference, RuntimeLogEntry, RuntimeLogResponse } from "../types";

// 可视化 Markdown 编辑器（按需加载）
const VisualMarkdownEditor = lazy(() =>
  import("./VisualMarkdownEditor").then((module) => ({ default: module.VisualMarkdownEditor }))
);

// 文章编辑工作区（自 main.tsx 拆分）
export function ArticleWorkspace({
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
