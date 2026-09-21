import { lazy, startTransition, Suspense, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { apiBase, platformName, request } from "../api";
import { extractMarkdownImages, renderPhonePreview, resolveArticleImageUrl } from "../markdown-preview";
import { locateMarkdownSelection } from "../markdown-selection";
import { markdownOffsetAtTextareaTop, readImageUrl, scrollEditorToHeading, scrollTextareaToMarkdownOffset } from "../utils";
import { AwenBottomPanel, AwenMemoryManager, markUnansweredAwenMessages, removeUnavailableAwenSuggestions } from "./AwenPanels";
import { applyAwenSuggestionToMarkdown, canFinalizeAwenSuggestionSync, canSendAwenMessage, findUniqueSuggestionRange, getArticleChatContextKey, getAwenAlternativeSuggestionIds, getPendingAwenSuggestionIds, isCurrentAwenLoad, isCurrentAwenSuggestionSync, shouldPersistAcceptedAwenSuggestion, shouldReloadAwenConversation } from "./awen-suggestion-utils";
import { CoverCropModal } from "./CoverCropModal";
import { SelectionDiffModal } from "./SelectionDiffModal";
import { ContentAnyReferenceView, ZhuqueReportView } from "./ZhuqueReportViews";
import { ExecutionPanel } from "./ExecutionPanel";
import { isCurrentImageSearchRequest } from "./image-search-utils";
import type { AppSettingsContract, RootState, AccountPlatform, AccountProfile, MediaAccount, ContentSourcePreview, ContentSourceArticle, ContentProject, ContentBrief, ResearchSource, ContentResearch, TitleSuggestion, ContentOutline, ContentDraft, ContentReview, WechatPublishJob, CsdnChannelDraft, CsdnPublishJob, CnblogsChannelDraft, CnblogsPublishJob, CnblogsPublishOptions, JuejinChannelDraft, JuejinPublishJob, JuejinPublishOptions, ChannelAction, ChannelRow, WechatCredentialStatus, WechatMaterial, SelectedImage, ArticleSettings, ModelProviderId, ModelConnection, WebSearchSettings, ManagedSkill, SkillFileContent, ArticleChatSuggestion, ArticleChatMessage, ZhuqueReport, ContentAnyReference, RuntimeLogEntry, RuntimeLogResponse, AgentMemoryRecord, AgentMemoryCandidateRecord, TemporaryResearchResult, TemporaryResearchScope, ImageSearchResultItem, ImageSearchHistoryRecord } from "../types";

type ArticleSaveResult = { success: boolean; markdown?: string; error?: string; sourceArticlePath?: string };

// 可视化 Markdown 编辑器（按需加载）
const VisualMarkdownEditor = lazy(() =>
  import("./VisualMarkdownEditor").then((module) => ({ default: module.VisualMarkdownEditor }))
);

type PendingAwenSend = { message: string; suggestionIds: string[] };

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
  onPublish,
  onEnterChannel
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
  onSave: () => Promise<ArticleSaveResult>;
  onPublish?: () => void;
  // 非微信平台的发布在渠道稿中进行：这里提供入口，直接打开对应平台的渠道稿。
  onEnterChannel?: (platform: AccountPlatform) => void;
}) {
  const [rightPanel, setRightPanel] = useState<"assistant" | "preview" | "settings">(initialRightPanel);
  const [editorMode, setEditorMode] = useState<"visual" | "markdown">("visual");
  const [modeScrollOffset, setModeScrollOffset] = useState(0);
  const markdownSourceRef = useRef<HTMLTextAreaElement>(null);
  const [leftTool, setLeftTool] = useState<"body" | "structure" | "sources" | "images" | "execution">("body");
  const [executionOpen, setExecutionOpen] = useState(false);
  const [articleSettings, setArticleSettings] = useState<ArticleSettings>({
    author: "",
    digest: "",
    coverSource: "",
    coverPrompt: "",
    accountId: "",
    needOpenComment: true,
    onlyFansCanComment: false,
    declareOriginal: true,
    enableReward: true,
    isAiGenerated: false,
    collectionName: ""
  });
  const [authorHistory, setAuthorHistory] = useState<string[]>([]);
  const [collectionHistory, setCollectionHistory] = useState<string[]>([]);
  const [collectionsSyncedAt, setCollectionsSyncedAt] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState("");
  const [imageSearchQuery, setImageSearchQuery] = useState("");
  const [imageCandidates, setImageCandidates] = useState<ImageSearchResultItem[]>([]);
  const [imageSearchBusy, setImageSearchBusy] = useState(false);
  const [imageInsertBusy, setImageInsertBusy] = useState<string>();
  const [imageSearchOpen, setImageSearchOpen] = useState(false);
  const [imagePreviewCandidate, setImagePreviewCandidate] = useState<ImageSearchResultItem>();
  const [imageHistory, setImageHistory] = useState<ImageSearchHistoryRecord[]>([]);
  const [imageHistoryOpen, setImageHistoryOpen] = useState(false);
  const imageSearchRequestIdRef = useRef(0);
  const imageSearchAbortRef = useRef<AbortController | undefined>(undefined);
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
  const [temporaryResearchScope, setTemporaryResearchScope] = useState<TemporaryResearchScope>("selection");
  const [temporaryResearch, setTemporaryResearch] = useState<TemporaryResearchResult>();
  const [temporaryResearchBusy, setTemporaryResearchBusy] = useState(false);
  const [savedResearchSources, setSavedResearchSources] = useState<ResearchSource[]>([]);
  useEffect(() => {
    if (temporaryResearch && temporaryResearch.scope !== temporaryResearchScope) setTemporaryResearch(undefined);
  }, [temporaryResearch, temporaryResearchScope]);
  useEffect(() => {
    if (!projectId || leftTool !== "sources") return;
    let cancelled = false;
    void request<ContentResearch>(`/content-projects/${projectId}/research`)
      .then((research) => { if (!cancelled) setSavedResearchSources(research.sources); })
      .catch(() => { if (!cancelled) setSavedResearchSources([]); });
    return () => { cancelled = true; };
  }, [projectId, leftTool]);
  const [selectionDetectionTool, setSelectionDetectionTool] = useState<"zhuque" | "contentany">("zhuque");
  const [selectionDetectionBusy, setSelectionDetectionBusy] = useState(false);
  const [selectionDetectionResult, setSelectionDetectionResult] = useState("");
  const [selectionContentAnyReference, setSelectionContentAnyReference] = useState<ContentAnyReference>();
  const [selectionZhuqueReport, setSelectionZhuqueReport] = useState<ZhuqueReport>();
  const [awenOpen, setAwenOpen] = useState(false);
  const [awenBottomHeightPercent, setAwenBottomHeightPercent] = useState(34);
  const [awenTranscriptUserPercent, setAwenTranscriptUserPercent] = useState(33);
  const [awenMessages, setAwenMessages] = useState<ArticleChatMessage[]>([]);
  const [awenMemory, setAwenMemory] = useState("");
  const [awenInput, setAwenInput] = useState("");
  const [awenLoading, setAwenLoading] = useState(false);
  const [awenLoaded, setAwenLoaded] = useState(false);
  const [awenLoadedContextKey, setAwenLoadedContextKey] = useState<string>();
  const awenLoadRequestIdRef = useRef(0);
  const awenLoadingContextKeyRef = useRef<string | undefined>(undefined);
  const awenSuggestionSyncRequestIdRef = useRef(0);
  const articleSaveInFlightRef = useRef(false);
  const [articleSaveInFlight, setArticleSaveInFlight] = useState(false);
  const [pendingAwenSend, setPendingAwenSend] = useState<PendingAwenSend>();
  const [pendingAwenReviewBusy, setPendingAwenReviewBusy] = useState(false);
  const [memoryManagerOpen, setMemoryManagerOpen] = useState(false);
  const [memoryManagerBusy, setMemoryManagerBusy] = useState(false);
  const [formalMemories, setFormalMemories] = useState<AgentMemoryRecord[]>([]);
  const [memoryCandidates, setMemoryCandidates] = useState<AgentMemoryCandidateRecord[]>([]);
  const [awenSuggestionOffsets, setAwenSuggestionOffsets] = useState<Record<string, { x: number; y: number }>>({});
  const [awenLocateSuggestionRequest, setAwenLocateSuggestionRequest] = useState<{ id: string; original: string; replacement: string; sequence: number }>();
  const [unsavedAwenSuggestionIds, setUnsavedAwenSuggestionIds] = useState<Set<string>>(new Set());
  const [leavePromptOpen, setLeavePromptOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [savedMarkdown, setSavedMarkdown] = useState(markdown);
  const [savedSettings, setSavedSettings] = useState<ArticleSettings>({
    author: "",
    digest: "",
    coverSource: "",
    coverPrompt: "",
    accountId: "",
    needOpenComment: true,
    onlyFansCanComment: false,
    declareOriginal: true,
    enableReward: true,
    isAiGenerated: false,
    collectionName: ""
  });
  const contextKey = sourceArticlePath ? `source:${sourceArticlePath}` : `project:${projectId ?? assetContextId}`;
  const awenContextKeyRef = useRef(contextKey);
  awenContextKeyRef.current = contextKey;
  const imageSearchContextKeyRef = useRef(contextKey);
  imageSearchContextKeyRef.current = contextKey;
  useEffect(() => {
    setImageSearchBusy(false);
    setImageCandidates([]);
    setImagePreviewCandidate(undefined);
    setImageSearchOpen(false);
    setImageHistoryOpen(false);
    return () => {
      imageSearchRequestIdRef.current += 1;
      imageSearchAbortRef.current?.abort();
      imageSearchAbortRef.current = undefined;
    };
  }, [contextKey]);
  useEffect(() => {
    if (leftTool !== "images") return;
    let active = true;
    void request<{ items: ImageSearchHistoryRecord[] }>(`/image-candidates/history?contextKey=${encodeURIComponent(contextKey)}`)
      .then((result) => { if (active) setImageHistory(result.items); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [contextKey, leftTool]);
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
    if (awenLoaded && awenLoadedContextKey === contextKey) return;
    const requestedContextKey = contextKey;
    const requestId = ++awenLoadRequestIdRef.current;
    awenLoadingContextKeyRef.current = requestedContextKey;
    setAwenMessages([]);
    try {
      const chat = await request<{ memory: string; messages: ArticleChatMessage[] }>(`/article-chat?contextKey=${encodeURIComponent(requestedContextKey)}`);
      if (!isCurrentAwenLoad(requestId, awenLoadRequestIdRef.current, requestedContextKey, awenContextKeyRef.current)) return;
      const normalized = removeUnavailableAwenSuggestions(markUnansweredAwenMessages(chat.messages), markdown);
      setAwenMemory(chat.memory);
      setAwenMessages(normalized.messages);
      setAwenLoaded(true);
      setAwenLoadedContextKey(requestedContextKey);
      // Suggestions whose original text no longer exists have already been
      // applied or superseded by a manual edit. Remove their persisted copy so
      // they cannot resurface on the next launch either.
      for (const stale of normalized.staleSuggestions) {
        try {
          await request(`/article-chat/messages/${encodeURIComponent(stale.messageId)}/suggestions/${stale.index}`, { method: "PATCH", body: JSON.stringify({ contextKey: requestedContextKey, status: "unavailable" }) });
        } catch {
          // The current session has already hidden it. A later open can retry
          // cleanup without interrupting the author with a non-actionable error.
        }
      }
    } catch (cause) {
      if (!isCurrentAwenLoad(requestId, awenLoadRequestIdRef.current, requestedContextKey, awenContextKeyRef.current)) return;
      setWorkspaceError(cause instanceof Error ? cause.message : "无法读取阿文的本文会话。");
    } finally {
      if (awenLoadingContextKeyRef.current === requestedContextKey) awenLoadingContextKeyRef.current = undefined;
    }
  };
  useEffect(() => {
    if (!shouldReloadAwenConversation(awenOpen, awenLoaded, awenLoadedContextKey, contextKey, awenLoadingContextKeyRef.current)) return;
    void openAwen();
  }, [awenOpen, awenLoaded, awenLoadedContextKey, contextKey]);
  const sendAwenMessage = async (retryMessage?: ArticleChatMessage, options?: { skipPendingReview?: boolean; message?: string }) => {
    const message = retryMessage?.content ?? options?.message ?? awenInput.trim();
    if (!message || awenLoading) return;
    if (!canSendAwenMessage(awenLoaded, awenLoadedContextKey, contextKey, Boolean(retryMessage))) {
      setWorkspaceError("正在读取阿文历史会话，请稍后再发送。");
      return;
    }
    if (!retryMessage && !options?.skipPendingReview) {
      const suggestionIds = getPendingAwenSuggestionIds(awenMessages, markdown, unsavedAwenSuggestionIds);
      if (suggestionIds.length > 0) {
        setPendingAwenSend({ message, suggestionIds });
        return;
      }
    }
    const requestContextKey = contextKey;
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
      const result = await request<{ message: ArticleChatMessage; memory: string }>("/article-chat/messages", { method: "POST", body: JSON.stringify({ contextKey: requestContextKey, clientMessageId: optimistic.id, accountId: articleSettings.accountId || undefined, title, markdown, message }) });
      if (requestContextKey !== awenContextKeyRef.current) return;
      setAwenMessages((current) => [...current.filter((item) => item.id !== optimistic.id), { ...optimistic, id: result.message.id, deliveryState: undefined }, result.message]);
      setAwenMemory(result.memory);
      setAwenLoaded(true);
      const imageSearch = result.message.imageSearch;
      if (imageSearch?.status === "ready" && imageSearch.items.length > 0) {
        setImageSearchQuery(imageSearch.query);
        setImageCandidates(imageSearch.items);
        setImageHistoryOpen(false);
        setImageSearchOpen(true);
        void request<{ items: ImageSearchHistoryRecord[] }>(`/image-candidates/history?contextKey=${encodeURIComponent(requestContextKey)}`)
          .then((history) => { if (requestContextKey === awenContextKeyRef.current) setImageHistory(history.items); })
          .catch(() => undefined);
      }
    } catch (cause) {
      if (requestContextKey !== awenContextKeyRef.current) return;
      // The server stores the user message before it calls the model. Do not
      // erase an optimistic message on an interrupted model/network request:
      // disappearing author input is worse than a visible failure state.
      setAwenMessages((current) => current.map((item) => item.id === optimistic.id ? { ...item, deliveryState: "failed" } : item));
      setWorkspaceError(cause instanceof Error ? cause.message : "阿文暂时无法回答。你的消息已保留，请稍后重新提问。");
    } finally { setAwenLoading(false); }
  };
  const continueAwenSend = async () => {
    const pending = pendingAwenSend;
    if (!pending) return;
    setAwenInput(pending.message);
    setPendingAwenSend(undefined);
    await sendAwenMessage(undefined, { message: pending.message, skipPendingReview: true });
  };
  const rejectPendingAwenSuggestionsAndContinue = async () => {
    const pending = pendingAwenSend;
    if (!pending || pendingAwenReviewBusy) return;
    setPendingAwenReviewBusy(true);
    try {
      const results = await Promise.all(pending.suggestionIds.map((id) => dismissAwenSuggestion(id, { suppressError: true })));
      if (results.some((success) => !success)) {
        setPendingAwenSend({ ...pending, suggestionIds: pending.suggestionIds.filter((_, index) => !results[index]) });
        setWorkspaceError("部分旧建议未能批量拒绝，已暂停发送；请重试或保留建议后继续提问。");
        return;
      }
      setAwenInput(pending.message);
      setPendingAwenSend(undefined);
      await sendAwenMessage(undefined, { message: pending.message, skipPendingReview: true });
    } finally {
      setPendingAwenReviewBusy(false);
    }
  };
  const cancelPendingAwenSend = () => setPendingAwenSend(undefined);
  const rememberAwenSuggestion = async (memory: string) => {
    try {
      const result = await request<{ memory: string }>("/article-chat/memory", { method: "POST", body: JSON.stringify({ contextKey, memory }) });
      setAwenMemory(result.memory);
    } catch (cause) { setWorkspaceError(cause instanceof Error ? cause.message : "无法保存本文记忆。"); }
  };
  const openMemoryManager = async () => {
    setMemoryManagerOpen(true);
    setMemoryManagerBusy(true);
    try {
      const data = await request<{ memories: AgentMemoryRecord[]; candidates: AgentMemoryCandidateRecord[] }>(`/agent-memory?scopeKey=${encodeURIComponent(contextKey)}&status=all`);
      setFormalMemories(data.memories.filter((item) => item.status === "active"));
      setMemoryCandidates(data.candidates.filter((item) => item.status === "candidate"));
    } catch (cause) { setWorkspaceError(cause instanceof Error ? cause.message : "无法读取本文记忆。"); }
    finally { setMemoryManagerBusy(false); }
  };
  const promoteMemoryCandidate = async (candidateId: string) => {
    setMemoryManagerBusy(true);
    try { await request(`/agent-memory/candidates/${encodeURIComponent(candidateId)}/promote`, { method: "POST" }); await openMemoryManager(); }
    catch (cause) { setWorkspaceError(cause instanceof Error ? cause.message : "无法启用记忆候选。"); }
    finally { setMemoryManagerBusy(false); }
  };
  const updateFormalMemory = async (memoryId: string, status: "active" | "expired" | "deleted") => {
    setMemoryManagerBusy(true);
    try { await request(`/agent-memory/${encodeURIComponent(memoryId)}`, { method: "PATCH", body: JSON.stringify({ status }) }); await openMemoryManager(); }
    catch (cause) { setWorkspaceError(cause instanceof Error ? cause.message : "无法更新记忆状态。"); }
    finally { setMemoryManagerBusy(false); }
  };
  const forgetArticleMemory = async (mode: "derived" | "all") => {
    setMemoryManagerBusy(true);
    try { await request("/agent-memory/forget", { method: "POST", body: JSON.stringify({ scopeKey: contextKey, mode }) }); setAwenMemory(""); await openMemoryManager(); }
    catch (cause) { setWorkspaceError(cause instanceof Error ? cause.message : "无法删除本文记忆。"); }
    finally { setMemoryManagerBusy(false); }
  };
  const exportArticleMemory = async () => {
    setMemoryManagerBusy(true);
    try {
      const snapshot = await request<unknown>(`/agent-memory/export?scopeKey=${encodeURIComponent(contextKey)}&includeEvents=1`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `wendu-memory-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) { setWorkspaceError(cause instanceof Error ? cause.message : "无法导出本文记忆。"); }
    finally { setMemoryManagerBusy(false); }
  };
  const importArticleMemory = async (file: File) => {
    setMemoryManagerBusy(true);
    try {
      const snapshot = JSON.parse(await file.text()) as unknown;
      await request("/agent-memory/import", { method: "POST", body: JSON.stringify({ snapshot, mode: "merge" }) });
      await openMemoryManager();
    } catch (cause) { setWorkspaceError(cause instanceof Error ? cause.message : "无法导入记忆备份。"); }
    finally { setMemoryManagerBusy(false); }
  };
  useEffect(() => {
    void Promise.all([
      request<ArticleSettings>(`/article-settings?contextKey=${encodeURIComponent(contextKey)}`),
      request<{ items: string[] }>("/article-settings/authors")
    ]).then(([settings, authors]) => {
      // 微信文章发布设置默认选好作者：未保存过作者时填最近使用过的作者，
      // 让“申请原创声明 / 开启赞赏”之外，作者也默认就位。
      const defaultAuthor = settings.author || authors.items[0] || "";
      const defaultWechatAccountId = accounts.find((account) => account.platform === "wechat_official")?.id ?? "";
      const accountId = settings.accountId || defaultWechatAccountId;
      setArticleSettings((prev) => ({ ...settings, author: defaultAuthor, accountId }));
      setSettingsCoverPrompt(settings.coverPrompt);
      setSavedSettings((prev) => ({ ...settings, author: defaultAuthor, accountId }));
      setAuthorHistory(authors.items);
    }).catch((cause) => setWorkspaceError(cause instanceof Error ? cause.message : "无法读取文章设置。"));
  }, [contextKey, accounts]);
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

  const hasArticleChanges = markdown !== savedMarkdown || JSON.stringify(articleSettings) !== JSON.stringify(savedSettings);
  const hasUnsavedChanges = hasArticleChanges || unsavedAwenSuggestionIds.size > 0;
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
  const persistAcceptedAwenSuggestions = async (ids: string[], targetContextKey = contextKey): Promise<string[]> => {
    const syncRequestId = ++awenSuggestionSyncRequestIdRef.current;
    const canUpdateCurrentArticle = () => isCurrentAwenSuggestionSync(
      syncRequestId,
      awenSuggestionSyncRequestIdRef.current,
      targetContextKey,
      awenContextKeyRef.current
    );
    const failed: string[] = [];
    let messages = awenMessages;
    let conversationReadSucceeded = true;
    if (ids.some((id) => {
      const [messageId, rawIndex] = id.split(":");
      const index = Number(rawIndex);
      return !messages.find((message) => message.id === messageId)?.suggestions[index];
    })) {
      conversationReadSucceeded = false;
      try {
        const chat = await request<{ memory: string; messages: ArticleChatMessage[] }>(`/article-chat?contextKey=${encodeURIComponent(targetContextKey)}`);
        messages = chat.messages;
        if (canUpdateCurrentArticle()) {
          setAwenMemory(chat.memory);
          setAwenMessages(messages);
          setAwenLoaded(true);
          setAwenLoadedContextKey(targetContextKey);
        }
        conversationReadSucceeded = true;
      } catch {
        // Without the refreshed conversation there is no safe way to verify
        // the applied suggestion. Keep it pending so the next save can retry.
      }
    }
    for (const id of ids) {
      const [messageId, rawIndex] = id.split(":");
      const index = Number(rawIndex);
      if (!messageId || !Number.isInteger(index)) {
        failed.push(id);
        continue;
      }
      const suggestion = messages.find((message) => message.id === messageId)?.suggestions[index];
      if (!canFinalizeAwenSuggestionSync(conversationReadSucceeded, suggestion)) {
        failed.push(id);
        continue;
      }
      if (!shouldPersistAcceptedAwenSuggestion(markdown, suggestion)) {
        // The accepted text may have been removed or replaced completely
        // before saving. Do not claim that this suggestion was saved.
        try {
          await request(`/article-chat/messages/${encodeURIComponent(messageId)}/suggestions/${index}`, { method: "PATCH", body: JSON.stringify({ contextKey: targetContextKey, status: "unavailable" }) });
          if (canUpdateCurrentArticle()) setAwenSuggestionStatusInView(messageId, index, "unavailable");
        } catch {
          failed.push(id);
        }
        continue;
      }
      try {
        const result = await request<{ suggestions: ArticleChatSuggestion[] }>(`/article-chat/messages/${encodeURIComponent(messageId)}/suggestions/${index}`, { method: "PATCH", body: JSON.stringify({ contextKey: targetContextKey, status: "accepted" }) });
        if (canUpdateCurrentArticle()) setAwenSuggestionsInView(messageId, result.suggestions);
      } catch {
        failed.push(id);
      }
    }
    if (canUpdateCurrentArticle()) setUnsavedAwenSuggestionIds(new Set(failed));
    return failed;
  };
  const saveArticleAndSettings = async (): Promise<boolean> => {
    if (articleSaveInFlightRef.current) return false;
    articleSaveInFlightRef.current = true;
    setArticleSaveInFlight(true);
    try {
      if (!await persistArticleSettings()) return false;
      const pendingSuggestionIds = [...unsavedAwenSuggestionIds];
      const result = await onSave();
      if (result.success) {
        setSavedMarkdown(result.markdown ?? markdown);
        setSavedSettings(articleSettings);
        const savedContextKey = getArticleChatContextKey(result.sourceArticlePath, contextKey);
        const failedSuggestionSync = await persistAcceptedAwenSuggestions(pendingSuggestionIds, savedContextKey);
        setWorkspaceError(failedSuggestionSync.length > 0 ? "文章已保存，但阿文建议状态尚未同步完成。请再次点击“保存文章”重试。" : "");
        return failedSuggestionSync.length === 0;
      }
      setWorkspaceError(result.error ?? "文章保存失败，请查看运行日志。 ");
      return false;
    } finally {
      articleSaveInFlightRef.current = false;
      setArticleSaveInFlight(false);
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
  // 非微信平台的发布设置在渠道稿里（栏目、分类、标签、发布形式等），这里只做交接，
  // 不在文章设置里维护第二份平台参数。
  const channelHandoffPlatform = selectedSettingsAccount && selectedSettingsAccount.platform !== "wechat_official" && onEnterChannel
    ? selectedSettingsAccount.platform
    : undefined;
  const enterChannelDraft = async () => {
    if (!channelHandoffPlatform || !onEnterChannel) return;
    // 渠道稿是从文章库里**已保存**的正文生成的，所以交接前必须把设置和正文一起存盘，
    // 否则用户刚改的正文不会出现在渠道稿里。任一步失败都中止交接，避免静默丢失改动。
    if (!await persistArticleSettings()) return;
    const result = await onSave();
    if (!result.success) {
      setWorkspaceError(result.error ?? "文章保存失败，未能进入渠道稿。请修正后重试。");
      return;
    }
    setSavedMarkdown(result.markdown ?? markdown);
    setSavedSettings(articleSettings);
    setWorkspaceError("");
    onEnterChannel(channelHandoffPlatform);
  };
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
      // Summary generation is independent from saving the article. Keep the
      // result update interruptible so a long editor view remains responsive
      // when the model response arrives.
      startTransition(() => {
        setArticleSettings((current) => ({ ...current, digest: generated.summary }));
        setWorkspaceError("");
      });
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
  const runTemporaryResearch = async () => {
    if (!projectId) {
      setWorkspaceError("这篇文章还没有内容项目，暂时无法发起临时调研。");
      return;
    }
    const source = selectionDocumentMarkdown ?? markdown;
    let context = source;
    if (temporaryResearchScope === "selection") {
      if (!selectionRange || selectionRange.end <= selectionRange.start) {
        setWorkspaceError("请先选中一段正文，再以“选中文本”发起临时调研。");
        return;
      }
      context = source.slice(selectionRange.start, selectionRange.end);
    } else if (temporaryResearchScope === "paragraph") {
      if (!selectionRange || selectionRange.end <= selectionRange.start) {
        setWorkspaceError("请先在目标段落中选中一小段文字，再以“当前段落”发起临时调研。");
        return;
      }
      context = markdownLineNearOffset(source, selectionRange.start);
    }
    if (!context.trim()) {
      setWorkspaceError("当前范围没有可供调研的正文。");
      return;
    }
    setTemporaryResearchBusy(true);
    setWorkspaceError("");
    try {
      const result = await request<TemporaryResearchResult>(`/content-projects/${projectId}/research/temporary`, {
        method: "POST",
        body: JSON.stringify({ scope: temporaryResearchScope, context: context.slice(0, 12000), depth: "quick" })
      });
      setTemporaryResearch(result);
    } catch (cause) {
      setWorkspaceError(cause instanceof Error ? cause.message : "临时调研失败，请稍后重试。");
    } finally {
      setTemporaryResearchBusy(false);
    }
  };
  const insertTemporaryText = (text: string) => {
    const value = text.trim();
    if (!value) return;
    if (!selectionRange || selectionRange.end <= selectionRange.start || selectionDocumentMarkdown !== markdown) {
      setWorkspaceError("请先在当前正文中选中要替换的文字，再插入临时调研结果。");
      return;
    }
    onChange(`${markdown.slice(0, selectionRange.start)}${value}${markdown.slice(selectionRange.end)}`);
    setSelectionRange(undefined);
    setSelectionDocumentMarkdown(undefined);
    setWorkspaceError("");
  };
  const saveTemporaryResearchSource = async (source: TemporaryResearchResult["sources"][number]) => {
    if (!projectId) return;
    setTemporaryResearchBusy(true);
    try {
      await request(`/content-projects/${projectId}/research/sources`, {
        method: "POST",
        body: JSON.stringify({
          title: source.title,
          url: source.url,
          excerpt: source.excerpt,
          keyClaims: source.keyClaims,
          adoptionStatus: "pending_verification",
          ...(source.evidence ? { evidence: source.evidence } : {})
        })
      });
      setWorkspaceError("");
      setTemporaryResearch((current) => current ? { ...current, sources: current.sources.filter((item) => item !== source) } : current);
    } catch (cause) {
      setWorkspaceError(cause instanceof Error ? cause.message : "保存临时资料失败，请稍后重试。");
    } finally {
      setTemporaryResearchBusy(false);
    }
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
  const searchImageCandidates = async () => {
    const query = imageSearchQuery.trim();
    if (!query) {
      setWorkspaceError("请先输入想找的图片主题或描述。");
      return;
    }
    const requestedContextKey = contextKey;
    const requestId = ++imageSearchRequestIdRef.current;
    imageSearchAbortRef.current?.abort();
    const controller = new AbortController();
    imageSearchAbortRef.current = controller;
    const timeoutId = window.setTimeout(() => controller.abort(), 180_000);
    const isCurrentRequest = () => isCurrentImageSearchRequest(
      requestId,
      imageSearchRequestIdRef.current,
      requestedContextKey,
      imageSearchContextKeyRef.current
    );
    setImageSearchBusy(true);
    setWorkspaceError("");
    try {
      const result = await request<{ query: string; provider: string | null; items: ImageSearchResultItem[] }>("/image-candidates/search", {
        method: "POST",
        body: JSON.stringify({ query, limit: 12 }),
        signal: controller.signal
      });
      if (!isCurrentRequest()) return;
      let reviewedItems = result.items;
      let historyProvider = result.provider;
      if (result.items.length > 0) {
        try {
          const reviewed = await request<{ query: string; provider: string | null; items: ImageSearchResultItem[] }>("/image-candidates/review", {
            method: "POST",
            body: JSON.stringify({ query, items: result.items }),
            signal: controller.signal
          });
          if (!isCurrentRequest()) return;
          reviewedItems = reviewed.items;
        } catch {
          // Candidate retrieval remains useful when the optional visual review
          // model is unavailable; keep the unreviewed candidates visible.
          if (controller.signal.aborted) throw new Error("图片初审请求超时或已取消。");
          if (!isCurrentRequest()) return;
        }
      }
      if (!isCurrentRequest()) return;
      setImageCandidates(reviewedItems);
      try {
        const saved = await request<{ item: ImageSearchHistoryRecord }>("/image-candidates/history", {
          method: "POST",
          body: JSON.stringify({ contextKey: requestedContextKey, query, provider: historyProvider, items: reviewedItems }),
          signal: controller.signal
        });
        if (isCurrentRequest()) setImageHistory((current) => [saved.item, ...current.filter((item) => item.id !== saved.item.id)].slice(0, 30));
      } catch {
        // History is an auxiliary record; a database hiccup must not hide usable candidates.
        if (controller.signal.aborted && !isCurrentRequest()) return;
      }
      if (reviewedItems.length === 0 && isCurrentRequest()) setWorkspaceError("没有找到可用图片候选，请换个描述重试。");
    } catch (cause) {
      if (!isCurrentRequest()) return;
      setImageCandidates([]);
      setWorkspaceError(controller.signal.aborted ? "图片检索超时或已取消，请重试。" : cause instanceof Error ? cause.message : "图片检索失败，请稍后重试。");
    } finally {
      window.clearTimeout(timeoutId);
      if (imageSearchAbortRef.current === controller) {
        imageSearchAbortRef.current = undefined;
        if (isCurrentRequest()) setImageSearchBusy(false);
      }
    }
  };
  const closeImageSearch = () => {
    imageSearchRequestIdRef.current += 1;
    imageSearchAbortRef.current?.abort();
    imageSearchAbortRef.current = undefined;
    setImageSearchBusy(false);
    setImageSearchOpen(false);
  };
  const restoreImageHistory = (record: ImageSearchHistoryRecord) => {
    setImageSearchQuery(record.query);
    setImageCandidates(record.items);
    setImageHistoryOpen(false);
  };
  const insertImageCandidate = async (candidate: ImageSearchResultItem) => {
    const label = candidate.caption || candidate.sourceTitle || "联网图片";
    const placement = resolveImagePlacement(markdown, candidate.placement);
    const placementLabel = placement.position === "end"
      ? "文章末尾"
      : `“${placement.anchor.slice(0, 80)}${placement.anchor.length > 80 ? "…" : ""}”${placement.position === "after" ? "之后" : "之前"}`;
    if (!window.confirm(`确认下载这张图片并插入${placementLabel}吗？文渡会先保存到当前文章的本地 assets 目录。`)) return;
    setImageInsertBusy(candidate.imageUrl);
    setWorkspaceError("");
    try {
      const endpoint = sourceArticlePath ? "/content-source/article-asset/import-remote" : "/content-assets/import-remote";
      const saved = await request<{ assetUrl: string }>(endpoint, {
        method: "POST",
        body: JSON.stringify(sourceArticlePath ? { path: sourceArticlePath, url: candidate.imageUrl } : { contextId: assetContextId, url: candidate.imageUrl })
      });
      const imageMarkdown = `![${label.replace(/[\[\]]/g, "")}](${saved.assetUrl})`;
      onChange(insertMarkdownAtPlacement(markdown, imageMarkdown, placement));
      setWorkspaceError("");
    } catch (cause) {
      setWorkspaceError(cause instanceof Error ? cause.message : "图片下载失败，文章没有写入远程地址。");
    } finally {
      setImageInsertBusy(undefined);
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
    ? message.suggestions.flatMap((suggestion, index) => (!suggestion.status || suggestion.status === "pending") && !unsavedAwenSuggestionIds.has(`${message.id}:${index}`)
      ? [{ ...suggestion, id: `${message.id}:${index}` }]
      : [])
    : []);
  const pendingAwenSuggestionIds = getPendingAwenSuggestionIds(awenMessages, markdown, unsavedAwenSuggestionIds);
  const pendingAwenSuggestionCount = pendingAwenSend?.suggestionIds.length ?? pendingAwenSuggestionIds.length;
  const locateAwenSuggestion = (id: string) => {
    const [messageId, rawIndex] = id.split(":");
    const index = Number(rawIndex);
    const suggestion = awenMessages.find((message) => message.id === messageId)?.suggestions[index];
    if (!suggestion) return;
    const range = findUniqueSuggestionRange(markdown, suggestion.original)
      ?? findUniqueSuggestionRange(markdown, suggestion.replacement);
    if (editorMode === "markdown" && range) {
      const textarea = markdownSourceRef.current;
      scrollTextareaToMarkdownOffset(textarea, markdown, range.start);
      textarea?.focus();
      textarea?.setSelectionRange(range.start, range.end);
    }
    setAwenLocateSuggestionRequest((current) => ({ id, original: suggestion.original, replacement: suggestion.replacement, sequence: (current?.sequence ?? 0) + 1 }));
  };
  const setAwenSuggestionStatusInView = (messageId: string, index: number, status: ArticleChatSuggestion["status"]) => {
    setAwenSuggestionOffsets((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([id]) => !id.startsWith(`${messageId}:`)));
      return next;
    });
    setAwenMessages((current) => current.map((message) => message.id === messageId ? { ...message, suggestions: message.suggestions.map((item, itemIndex) => itemIndex === index ? { ...item, status } : item) } : message));
  };
  const setAwenSuggestionsInView = (messageId: string, suggestions: ArticleChatSuggestion[]) => {
    setAwenMessages((current) => current.map((message) => message.id === messageId ? { ...message, suggestions } : message));
  };
  const dismissAwenSuggestion = async (id: string, options?: { suppressError?: boolean }) => {
    const [messageId, rawIndex] = id.split(":");
    const index = Number(rawIndex);
    if (!messageId || !Number.isInteger(index)) return false;
    try {
      await request(`/article-chat/messages/${encodeURIComponent(messageId)}/suggestions/${index}`, { method: "PATCH", body: JSON.stringify({ contextKey, status: "rejected" }) });
      setAwenSuggestionStatusInView(messageId, index, "rejected");
      return true;
    } catch (cause) {
      if (!options?.suppressError) setWorkspaceError(cause instanceof Error ? cause.message : "无法保存阿文建议的处理状态。");
      return false;
    }
  };
  const applyAwenSuggestion = async (id: string) => {
    const suggestion = awenSuggestions.find((item) => item.id === id);
    if (!suggestion) return;
    const [messageId, rawIndex] = id.split(":");
    const index = Number(rawIndex);
    if (!messageId || !Number.isInteger(index)) return;
    const updatedMarkdown = applyAwenSuggestionToMarkdown(markdown, suggestion);
    if (updatedMarkdown === undefined) {
      setWorkspaceError("这条阿文建议已无法准确定位到原文；可能正文已经修改。请重新向阿文提问。");
      try {
        await request(`/article-chat/messages/${encodeURIComponent(messageId)}/suggestions/${index}`, { method: "PATCH", body: JSON.stringify({ contextKey, status: "unavailable" }) });
        setAwenSuggestionStatusInView(messageId, index, "unavailable");
      } catch (cause) { setWorkspaceError(cause instanceof Error ? cause.message : "无法保存阿文建议的处理状态。"); }
      return;
    }
    onChange(updatedMarkdown);
    setUnsavedAwenSuggestionIds((current) => new Set(current).add(id));
    const alternativeIds = getAwenAlternativeSuggestionIds(awenMessages, id).filter((alternativeId) => !unsavedAwenSuggestionIds.has(alternativeId));
    const alternativeResults = await Promise.all(alternativeIds.map((alternativeId) => dismissAwenSuggestion(alternativeId, { suppressError: true })));
    setWorkspaceError(alternativeResults.every(Boolean) ? "" : "建议已应用，但部分同段落备选方案未能自动拒绝，请手动处理剩余建议。 ");
  };
  const wordCount = markdown.replace(/[#>*_`\-\[\]()]/g, "").replace(/\s/g, "").length;
  const images = extractMarkdownImages(markdown);
  const coverCandidates = images.filter((image) => sourceArticlePath
    ? !/^https?:\/\//i.test(image.src)
    : image.src.startsWith("contentferry-asset://"));
  const headings = markdown.split(/\r?\n/).map((line) => /^(#{1,6})\s+(.+)$/.exec(line)).filter((value): value is RegExpExecArray => Boolean(value));
  const sources = [...new Set([...markdown.matchAll(/https?:\/\/[^\s)>]+/g)].map((match) => match[0]))];
  const canInsertTemporaryText = Boolean(selectionRange && selectionRange.end > selectionRange.start && selectionDocumentMarkdown === markdown);
  // Generating a summary is an AI request, not a save operation. It must not
  // disable the editor, save button, or the Ctrl/Cmd+S shortcut while the
  // provider is working; only the summary action itself is locked below.
  const editorBusy = saving || settingsSaving || settingsCoverPromptBusy || articleSaveInFlight;
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
    if (!hasUnsavedChanges) {
      onBack();
      return;
    }
    setLeavePromptOpen(true);
  };
  const saveAndLeave = async () => {
    setLeaving(true);
    try {
      if (await saveArticleAndSettings()) {
        setLeavePromptOpen(false);
        onBack();
      }
    } finally {
      setLeaving(false);
    }
  };
  const discardAndLeave = () => {
    setLeavePromptOpen(false);
    onBack();
  };
  const editorWorkspaceStyle = awenOpen ? { "--awen-bottom-height": `${awenBottomHeightPercent}vh` } as CSSProperties : undefined;
  return <div className={`editor-workspace${awenOpen ? " with-awen-panel" : ""}`} style={editorWorkspaceStyle}>
    <header className="editor-topbar">
      <button className="secondary-button" onClick={leaveWorkspace}>← 返回归档库</button>
      <div className="editor-document-title"><strong>{title}</strong></div>
      <div className="editor-top-actions"><span title={generating ? generationStatus : undefined}>{generating ? (generationStatus || "AI 正在起草正文…") : busy ? "正在保存…" : hasUnsavedChanges ? "有未保存修改" : "已保存"}</span>{generating && <button className="secondary-button" onClick={onStopGeneration}>停止生成</button>}<button onClick={() => void saveArticleAndSettings()} disabled={busy || generating || !hasUnsavedChanges}>保存文章</button>{channelHandoffPlatform && onEnterChannel
  ? <button onClick={() => void enterChannelDraft()} disabled={busy || generating}>进入{platformName(channelHandoffPlatform)}渠道稿</button>
  : onPublish && <button onClick={() => void prepareFromWorkspace()} disabled={busy || generating}>准备发布</button>}</div>
    </header>
    <div className="editor-columns">
      <aside className="editor-left-panel">
        <h3>文章工具</h3>
        <button className={`workspace-tool${leftTool === "body" ? " active" : ""}`} onClick={() => setLeftTool("body")}>正文</button>
        <button className={`workspace-tool${leftTool === "structure" ? " active" : ""}`} onClick={() => setLeftTool("structure")}>文章结构</button>
        <button className={`workspace-tool${leftTool === "sources" ? " active" : ""}`} onClick={() => setLeftTool("sources")}>资料来源</button>
        <button className={`workspace-tool${leftTool === "images" ? " active" : ""}`} onClick={() => setLeftTool("images")}>图片素材</button>
        <button className={`workspace-tool${leftTool === "execution" ? " active" : ""}`} onClick={() => { setLeftTool("execution"); setExecutionOpen(true); }} aria-expanded={executionOpen}>代码与工具</button>
        {leftTool === "body" && <div className="editor-stats"><span>{wordCount} 字</span><span>{images.length} 张图片</span><span>约 {Math.max(1, Math.ceil(wordCount / 500))} 分钟阅读</span></div>}
        {leftTool === "structure" && <div className="tool-detail"><strong>文章结构</strong>{headings.length ? headings.map((heading, index) => <button className="structure-link" key={index} style={{ paddingLeft: `${(heading[1].length - 1) * 10}px` }} onClick={() => scrollEditorToHeading(heading[2], index, markdown, editorMode)}>{heading[2]}</button>) : <small>正文中还没有标题。</small>}</div>}
        {leftTool === "sources" && <div className="tool-detail"><strong>资料来源</strong>{sources.length ? <div className="article-source-links">{sources.map((source) => <a className="source-link" href={source} target="_blank" rel="noreferrer" title={`在浏览器中打开：${source}`} key={source}>{source}</a>)}</div> : <small>暂未识别到正文链接来源。</small>}{projectId && <>{savedResearchSources.length > 0 && <div className="temporary-research-results"><p><strong>已保存证据</strong><small>来自资料工作台；只有已采纳的卡会进入提纲和正文上下文。</small></p>{savedResearchSources.map((source) => <article className="temporary-research-card" key={source.id}><strong>{source.title}</strong><small>{source.adoptionStatus === "adopted" ? "已采纳" : source.adoptionStatus === "rejected" ? "已拒绝" : "待核验"}</small><a href={source.url} target="_blank" rel="noreferrer">{source.url}</a><p>{source.excerpt}</p></article>)}</div>}<div className="temporary-research-box"><label>临时调研范围<select value={temporaryResearchScope} onChange={(event) => setTemporaryResearchScope(event.target.value as TemporaryResearchScope)} disabled={temporaryResearchBusy}><option value="selection">选中文本</option><option value="paragraph">当前段落</option><option value="article">整篇文章</option></select></label><small>结果只在本次编辑会话保留，不会自动改写正文或进入正式资料。</small><button type="button" className="secondary-button" onClick={() => void runTemporaryResearch()} disabled={temporaryResearchBusy}>{temporaryResearchBusy ? "正在临时调研…" : "开始临时调研"}</button>{temporaryResearch && <div className="temporary-research-results"><p><strong>临时结果</strong><small>{temporaryResearchScope === "selection" ? "选中文本" : temporaryResearchScope === "paragraph" ? "当前段落" : "整篇文章"} · 本次范围已记录</small></p>{temporaryResearch.sources.length ? temporaryResearch.sources.map((source) => <article className="temporary-research-card" key={`${source.url}-${source.title}`}><strong>{source.title}</strong><a href={source.url} target="_blank" rel="noreferrer">{source.url}</a><p>{source.excerpt}</p>{source.keyClaims?.length ? <ul>{source.keyClaims.map((claim) => <li key={claim}>{claim}</li>)}</ul> : null}{source.recommendation && <p><strong>为什么值得看：</strong>{source.recommendation}</p>}{source.freshness?.startsWith("易变：") && <p><strong>发布前复核：</strong>{source.freshness.slice(3)}</p>}{source.evidence?.snapshots?.[0]?.capturedAt && <small>抓取时间：{new Date(source.evidence.snapshots[0].capturedAt).toLocaleString()}</small>}<div className="temporary-research-actions"><button type="button" className="text-button" onClick={() => insertTemporaryText(source.excerpt)} disabled={temporaryResearchBusy || !canInsertTemporaryText}>替换选区为摘录</button><button type="button" className="text-button" onClick={() => insertTemporaryText(source.claim ?? source.excerpt)} disabled={temporaryResearchBusy || !canInsertTemporaryText}>替换选区为改写建议</button><button type="button" className="text-button" onClick={() => void saveTemporaryResearchSource(source)} disabled={temporaryResearchBusy}>保存为待核验证据</button></div>{!canInsertTemporaryText && <small>请选择当前正文中的一段文字后再插入。</small>}</article>) : <small>本次没有获得可核验资料卡。</small>}</div>}</div></>}</div>}
        {leftTool === "images" && <div className="tool-detail image-materials-panel"><div className="image-panel-heading"><div><strong>图片素材</strong><small>{images.length ? `正文已有 ${images.length} 张图片` : "正文中还没有图片"}</small></div><span>{imageCandidates.length ? `${imageCandidates.length} 个候选` : ""}</span></div><button type="button" className="secondary-button image-search-launcher" onClick={() => { setImageHistoryOpen(false); setImageSearchOpen(true); }}>打开联网找图</button>{imageHistory.length > 0 && <button type="button" className="text-button image-candidate-reopen" onClick={() => { setImageHistoryOpen(true); setImageSearchOpen(true); }}>查看搜图历史（{imageHistory.length}）</button>}<small>找图和候选初审会在宽版面板中进行，历史记录会按当前文章保存。</small>{imageCandidates.length > 0 && <button type="button" className="text-button image-candidate-reopen" onClick={() => { setImageHistoryOpen(false); setImageSearchOpen(true); }}>查看最近候选</button>}{images.length ? <div className="article-image-list">{images.map((image, index) => <img key={`${image.src}-${index}`} src={resolveArticleImageUrl(image.src, assetContextId, sourceArticlePath)} alt={image.alt || "文章图片"} />)}</div> : <small>确认插入的图片会显示在这里。</small>}</div>}
      </aside>
      <section className={`editor-canvas${editorMode === "markdown" ? " markdown-mode" : ""}`}>
        {workspaceError && <p className="error editor-inline-error">{workspaceError}</p>}
        {generating && !markdown.trim() ? <div className="generation-placeholder editor-generation-placeholder" role="status"><span className="loading-dot" aria-hidden="true" /><span>{generationStatus || "正在等待 AI 的第一段正文内容…"}</span><small>收到内容后会直接显示在编辑器中；你可以随时停止并保留已生成的部分。</small></div> : editorMode === "visual" ? <Suspense fallback={<p className="hint">正在打开文章编辑器…</p>}>
          <VisualMarkdownEditor key={sourceArticlePath ?? assetContextId} value={markdown} assetContextId={assetContextId} sourceArticlePath={sourceArticlePath} minHeight={680} initialScrollOffset={modeScrollOffset} onSwitchToMarkdown={switchToMarkdown} suggestions={awenSuggestions} suggestionOffsets={awenSuggestionOffsets} onSuggestionOffsetChange={(id, offset) => setAwenSuggestionOffsets((current) => ({ ...current, [id]: offset }))} onAcceptSuggestion={(id) => void applyAwenSuggestion(id)} onRejectSuggestion={(id) => void dismissAwenSuggestion(id)} locateSuggestionRequest={awenLocateSuggestionRequest} onChange={onChange} onError={setWorkspaceError} onTextSelection={captureVisualSelection} />
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
          {channelHandoffPlatform && <div className="channel-handoff-hint" role="status">
            <strong>在{platformName(channelHandoffPlatform)}渠道稿中发布</strong>
            <p>{platformName(channelHandoffPlatform)}的栏目、分类、标签、发布形式等平台专属设置，以及发布前的正文调整，都在渠道稿里完成。这里保存的作者、摘要和封面会带到渠道稿。</p>
            <button type="button" onClick={() => void enterChannelDraft()}>进入{platformName(channelHandoffPlatform)}渠道稿</button>
          </div>}
          <label>作者<input list={`author-history-${assetContextId}`} value={articleSettings.author} maxLength={16} onChange={(event) => setArticleSettings((current) => ({ ...current, author: event.target.value }))} placeholder="可输入或选择过去使用过的作者" /><datalist id={`author-history-${assetContextId}`}>{authorHistory.map((author) => <option value={author} key={author} />)}</datalist><small>{articleSettings.author.length}/16 字</small></label>
          <label>摘要
            <textarea value={articleSettings.digest} maxLength={digestMaxLength} onChange={(event) => setArticleSettings((current) => ({ ...current, digest: event.target.value }))} placeholder={`用于${selectedSettingsAccount ? platformName(selectedSettingsAccount.platform) : "目标平台"}的内容卡片和分享，最多 ${digestMaxLength} 字`} />
            <small>{articleSettings.digest.length}/{digestMaxLength} 字{selectedSettingsAccount ? ` · ${platformName(selectedSettingsAccount.platform)}限制` : " · 选择账号后按平台适配"}</small>
            <button type="button" className="secondary-button" onClick={() => void generateArticleSummary()} disabled={busy || settingsSummaryBusy} aria-busy={settingsSummaryBusy}>{settingsSummaryBusy ? "AI 正在提炼摘要…" : "AI 生成适配摘要"}</button>
            {settingsSummaryBusy && <small className="settings-nonblocking-status" role="status">正在等待 AI 返回，文章滚动、编辑和保存仍可继续。</small>}
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
              <input type="checkbox" checked={articleSettings.isAiGenerated} onChange={(event) => setArticleSettings((current) => ({ ...current, isAiGenerated: event.target.checked }))} />
              <span><strong>文章由 AI 生成</strong><small>发布到微信公众号时，文渡会在微信后台将“创作来源”选择为“内容由AI生成”。</small></span>
            </label>
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
            <button type="button" className="secondary-button" onClick={() => void chooseArticleCover()}>选择本地图片并裁剪</button>
            {coverCandidates.length > 0 && <details><summary>从正文图片选择</summary><div className="article-cover-choices">{coverCandidates.map((image, index) => <button type="button" key={`${image.src}-${index}`} onClick={() => void cropExistingCover(resolveArticleImageUrl(image.src, assetContextId, sourceArticlePath), image.alt || `正文图片-${index + 1}.png`)}><img src={resolveArticleImageUrl(image.src, assetContextId, sourceArticlePath)} alt={image.alt || "正文图片"} /><small>选择并裁剪</small></button>)}</div></details>}
            {articleSettings.accountId && accounts.find((account) => account.id === articleSettings.accountId)?.platform === "wechat_official" && <details><summary>从微信素材库选择</summary><button type="button" className="secondary-button" onClick={() => void loadSettingsMaterials()} disabled={settingsCoverBusy}>加载最近图片</button>{settingsMaterials.length > 0 && <div className="article-cover-choices">{settingsMaterials.map((material) => <button type="button" key={material.mediaId} onClick={() => void chooseSettingsMaterial(material)}><img src={`${apiBase}/integrations/wechat/accounts/${articleSettings.accountId}/materials/images/${encodeURIComponent(material.mediaId)}`} alt={material.name || "微信素材"} /><small>{material.name || "未命名图片"}</small></button>)}</div>}</details>}
          </div>
          <button type="button" onClick={() => void persistArticleSettings()} disabled={busy}>保存发布设置</button>
          <p className="hint">{channelHandoffPlatform
            ? `这里保存的作者、摘要和封面会带到${platformName(channelHandoffPlatform)}渠道稿，平台专属设置在渠道稿中填写。`
            : "发布时只做完整性检查，不再重复填写账号、作者、摘要和封面。"}</p>
        </div>}
      </aside>
    </div>
    {awenOpen && <AwenBottomPanel messages={awenMessages} memory={awenMemory} value={awenInput} loading={awenLoading} unsavedSuggestionIds={unsavedAwenSuggestionIds} pendingSuggestionCount={pendingAwenSuggestionCount} pendingSuggestionReviewOpen={Boolean(pendingAwenSend)} pendingSuggestionReviewBusy={pendingAwenReviewBusy} bottomHeightPercent={awenBottomHeightPercent} transcriptUserPercent={awenTranscriptUserPercent} onBottomHeightChange={setAwenBottomHeightPercent} onTranscriptUserPercentChange={setAwenTranscriptUserPercent} onChange={setAwenInput} onSend={() => void sendAwenMessage()} onRetry={(message) => void sendAwenMessage(message)} onAcceptSuggestion={(id) => void applyAwenSuggestion(id)} onRejectSuggestion={(id) => void dismissAwenSuggestion(id)} onLocateSuggestion={locateAwenSuggestion} onOpenMemoryManager={() => void openMemoryManager()} onRejectPendingAndContinue={() => void rejectPendingAwenSuggestionsAndContinue()} onKeepPendingAndContinue={() => void continueAwenSend()} onCancelPendingSend={cancelPendingAwenSend} onClose={() => setAwenOpen(false)} />}
    {memoryManagerOpen && <AwenMemoryManager memories={formalMemories} candidates={memoryCandidates} busy={memoryManagerBusy} onPromote={(candidateId) => void promoteMemoryCandidate(candidateId)} onStatus={(memoryId, status) => void updateFormalMemory(memoryId, status)} onForget={(mode) => void forgetArticleMemory(mode)} onExport={() => void exportArticleMemory()} onImport={(file) => void importArticleMemory(file)} onClose={() => setMemoryManagerOpen(false)} />}
    {executionOpen && <div className="execution-modal-backdrop" role="presentation"><section className="execution-modal" role="dialog" aria-modal="true" aria-label="代码与工具执行"><div className="execution-modal-header"><div><p className="eyebrow">文章工具</p><h2>代码与工具</h2><p className="hint compact-hint">需要执行 Demo 或分析源码时再打开；授权目录可以跨文章复用。</p></div><button type="button" className="text-button" onClick={() => setExecutionOpen(false)}>关闭</button></div><ExecutionPanel projectId={projectId} onError={setWorkspaceError} onInsertCitation={(citation) => onChange(`${markdown}\n\n${citation}\n`)} onClose={() => setExecutionOpen(false)} /></section></div>}
    {selectionComparisonOpen && selectionAiResult && <SelectionDiffModal before={selectionAiOriginal} after={selectionAiResult} onClose={() => setSelectionComparisonOpen(false)} onApply={applySelectionAiResult} />}
    {imageSearchOpen && <ImageCandidateSearchModal query={imageSearchQuery} candidates={imageCandidates} history={imageHistory} historyOpen={imageHistoryOpen} busy={imageSearchBusy} insertBusy={imageInsertBusy} onQueryChange={setImageSearchQuery} onSearch={() => void searchImageCandidates()} onInsert={(candidate) => void insertImageCandidate(candidate)} onPreview={setImagePreviewCandidate} onToggleHistory={() => setImageHistoryOpen((open) => !open)} onSelectHistory={restoreImageHistory} onClose={closeImageSearch} />}
    {imagePreviewCandidate && <ImageCandidatePreviewModal candidate={imagePreviewCandidate} onClose={() => setImagePreviewCandidate(undefined)} />}
    {coverCropImage && <CoverCropModal image={coverCropImage} onCancel={() => setCoverCropImage(undefined)} onConfirm={(cropped) => void saveCroppedArticleCover(cropped)} />}
    {leavePromptOpen && <div className="modal-backdrop priority-modal" role="presentation"><section className="modal-card" role="dialog" aria-modal="true" aria-label="保存文章修改"><div className="section-heading"><div><p className="eyebrow">离开文章</p><h2>文章还有未保存修改</h2></div><button type="button" className="text-button" onClick={() => setLeavePromptOpen(false)} disabled={leaving}>继续编辑</button></div><p className="hint">{unsavedAwenSuggestionIds.size > 0 ? `其中有 ${unsavedAwenSuggestionIds.size} 条阿文建议已经应用到当前草稿，但还没有保存到文章文件。` : "当前文章还有未保存的修改。"}</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setLeavePromptOpen(false)} disabled={leaving}>继续编辑</button><button type="button" className="secondary-button" onClick={discardAndLeave} disabled={leaving}>放弃本次修改</button><button type="button" onClick={() => void saveAndLeave()} disabled={leaving}>{leaving ? "正在保存…" : "保存并返回"}</button></div></section></div>}
  </div>;
}

function ImageCandidateSearchModal({
  query,
  candidates,
  history,
  historyOpen,
  busy,
  insertBusy,
  onQueryChange,
  onSearch,
  onInsert,
  onPreview,
  onToggleHistory,
  onSelectHistory,
  onClose
}: {
  query: string;
  candidates: ImageSearchResultItem[];
  history: ImageSearchHistoryRecord[];
  historyOpen: boolean;
  busy: boolean;
  insertBusy?: string;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onInsert: (candidate: ImageSearchResultItem) => void;
  onPreview: (candidate: ImageSearchResultItem) => void;
  onToggleHistory: () => void;
  onSelectHistory: (record: ImageSearchHistoryRecord) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, onClose]);

  return <div className="image-search-backdrop" role="presentation">
    <section className="image-search-modal" role="dialog" aria-modal="true" aria-label="联网找图">
      <header className="image-search-modal-header">
        <div><p className="eyebrow">文章配图</p><h2>联网找图</h2><p className="hint compact-hint">先搜索候选，再参考视觉初审结果；点击图片可看大图。阿文会推荐相关段落，确认后按推荐位置插入；无法匹配时才插入文章末尾。</p></div>
        <div className="image-search-header-actions"><button type="button" className="secondary-button compact-action" onClick={onToggleHistory} disabled={busy}>{historyOpen ? "返回候选" : `搜图历史${history.length ? `（${history.length}）` : ""}`}</button><button type="button" className="text-button" onClick={onClose} disabled={busy}>关闭</button></div>
      </header>
      <form className="image-search-form" onSubmit={(event) => { event.preventDefault(); onSearch(); }}>
        <label><span>图片主题或描述</span><input autoFocus value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="例如：Skill Recorder 操作界面" maxLength={500} /></label>
        <button type="submit" disabled={busy || !query.trim()}>{busy ? "正在搜索并初审…" : "搜索图片"}</button>
      </form>
      {historyOpen ? <div className="image-search-history-list">{history.length === 0 ? <div className="image-search-empty"><strong>还没有搜图历史</strong><p>完成一次图片搜索后，搜索词和候选结果会保存在当前文章下。</p></div> : history.map((record) => <article className="image-search-history-item" key={record.id}><div><strong>{record.query}</strong><small>{new Date(record.createdAt).toLocaleString()} · {record.provider || "未记录服务"} · {record.items.length} 个候选</small><div className="image-history-thumbnails">{record.items.slice(0, 5).map((item) => <img key={item.imageUrl} src={item.thumbnailUrl ?? item.imageUrl} alt="" loading="lazy" />)}</div></div><button type="button" className="secondary-button compact-action" onClick={() => onSelectHistory(record)}>查看候选</button></article>)}</div> : <>
        {busy && <div className="image-search-progress" role="status"><span className="loading-dot" aria-hidden="true" /><span>正在获取图片并进行初审，未确认的图片不会写入文章。</span></div>}
        {!busy && candidates.length === 0 && <div className="image-search-empty"><strong>输入主题开始搜索</strong><p>结果会展示缩略图、来源和初审建议。图片来源与版权仍需要你在插入前确认。</p></div>}
      {candidates.length > 0 && <div className="image-candidate-grid image-candidate-grid-wide">{candidates.map((candidate) => {
        const review = candidate.review;
        const reviewLabel = review?.status === "accepted" ? "初审通过" : review?.status === "rejected" ? "初审不建议" : review?.status === "uncertain" ? "需要人工判断" : review?.status === "failed" ? "初审失败" : "未初审";
        return <article className="image-candidate image-candidate-wide" key={candidate.imageUrl}>
          <button type="button" className="image-candidate-image-button" onClick={() => onPreview(candidate)} aria-label="查看图片大图">
            <img src={candidate.thumbnailUrl ?? candidate.imageUrl} alt={candidate.caption || candidate.sourceTitle || "图片候选"} loading="lazy" onError={(event) => { const image = event.currentTarget; if (image.dataset.fallback === "1") { image.style.visibility = "hidden"; return; } image.dataset.fallback = "1"; image.src = `${apiBase}/image-candidates/preview?url=${encodeURIComponent(candidate.imageUrl)}`; }} />
            <span>点击查看大图</span>
          </button>
          <div><span className={`image-review-badge image-review-${review?.status ?? "unreviewed"}`}>{reviewLabel}</span><strong>{candidate.caption || candidate.sourceTitle || "未命名图片"}</strong>{review?.reason && <small title={review.reason}>{review.reason}</small>}{candidate.sourceTitle && <small>{candidate.sourceTitle}</small>}{candidate.placement && <small className="image-placement-recommendation">推荐位置：{candidate.placement.position === "end" ? "文章末尾" : candidate.placement.position === "after" ? "当前段落之后" : "当前段落之前"}{candidate.placement.position !== "end" ? `：${candidate.placement.anchor.slice(0, 90)}${candidate.placement.anchor.length > 90 ? "…" : ""}` : ""}<br />{candidate.placement.reason}</small>}<div className="image-candidate-links">{candidate.sourceUrl ? <a href={candidate.sourceUrl} target="_blank" rel="noreferrer">打开源网页</a> : <small>源网页未返回</small>}<a href={candidate.imageUrl} target="_blank" rel="noreferrer">打开原图</a></div><button type="button" onClick={() => onInsert(candidate)} disabled={insertBusy !== undefined}>{insertBusy === candidate.imageUrl ? "正在保存…" : candidate.placement?.position === "end" ? "确认下载并插入文章末尾" : "确认下载并插入推荐位置"}</button></div>
        </article>;
      })}</div>}
      </>}
    </section>
  </div>;
}

function ImageCandidatePreviewModal({ candidate, onClose }: { candidate: ImageSearchResultItem; onClose: () => void }) {
  const [directImage, setDirectImage] = useState(false);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const previewUrl = `${apiBase}/image-candidates/preview?url=${encodeURIComponent(candidate.imageUrl)}`;
  return <div className="image-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="image-preview-modal" role="dialog" aria-modal="true" aria-label="图片大图预览">
      <header className="image-preview-header"><div><p className="eyebrow">图片预览</p><h2>{candidate.caption || candidate.sourceTitle || "图片候选"}</h2></div><button type="button" className="text-button" onClick={onClose}>关闭</button></header>
      <div className="image-preview-stage"><img src={directImage ? candidate.imageUrl : previewUrl} alt={candidate.caption || candidate.sourceTitle || "图片候选"} onError={() => setDirectImage(true)} /></div>
      <footer className="image-preview-footer"><div className="image-preview-meta">{candidate.review?.reason && <small>{candidate.review.reason}</small>}{candidate.sourceUrl ? <small>搜索服务返回了源网页，可以打开核对上下文。</small> : <small>搜索服务没有返回源网页，下面仅提供原图地址。</small>}</div><div className="modal-actions">{candidate.sourceUrl && <a className="secondary-button" href={candidate.sourceUrl} target="_blank" rel="noreferrer">打开源网页</a>}<a className="secondary-button" href={candidate.imageUrl} target="_blank" rel="noreferrer">打开原图</a></div></footer>
    </section>
  </div>;
}

function resolveImagePlacement(markdown: string, placement?: ImageSearchResultItem["placement"]): NonNullable<ImageSearchResultItem["placement"]> {
  if (!placement || placement.position === "end") return { position: "end", anchor: "", reason: placement?.reason || "文章末尾", rank: placement?.rank || 1 };
  const first = markdown.indexOf(placement.anchor);
  if (!placement.anchor || first < 0 || first !== markdown.lastIndexOf(placement.anchor)) return { position: "end", anchor: "", reason: "推荐段落已变化，回退到文章末尾。", rank: placement.rank };
  return placement;
}

function insertMarkdownAtPlacement(markdown: string, imageMarkdown: string, placement: NonNullable<ImageSearchResultItem["placement"]>): string {
  if (placement.position === "end" || !placement.anchor) {
    const separator = markdown.trimEnd() ? "\n\n" : "";
    return `${markdown.trimEnd()}${separator}${imageMarkdown}\n`;
  }
  const anchorIndex = markdown.indexOf(placement.anchor);
  const insertionIndex = placement.position === "after" ? anchorIndex + placement.anchor.length : anchorIndex;
  const before = markdown.slice(0, insertionIndex).trimEnd();
  const after = markdown.slice(insertionIndex).trimStart();
  return `${before}\n\n${imageMarkdown}\n\n${after}`.trimEnd() + "\n";
}

function markdownLineNearOffset(markdown: string, offset: number): string {
  const safeOffset = Math.max(0, Math.min(markdown.length, offset));
  const before = markdown.lastIndexOf("\n", safeOffset);
  const after = markdown.indexOf("\n", safeOffset);
  const current = markdown.slice(before + 1, after < 0 ? markdown.length : after).trim();
  if (current.length >= 4) return current;
  return markdown.slice(after < 0 ? safeOffset : after + 1).split("\n").find((line) => line.trim().length >= 4)?.trim() ?? current;
}
