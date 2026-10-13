import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isCurrentImageSearchRequest } from "./image-search-utils";
import { isCurrentAwenSuggestionSync } from "./awen-suggestion-utils";
import { reconcileMarkdownAfterSave } from "./article-save-state";
import { reconcileAwenSuggestionSaveState } from "./awen-suggestion-save-state";
import { resolveLoadedCoverPrompt } from "./article-settings-state";
import { getDraftWorkflowProgressEvents } from "./DraftWorkflowProgress";
import { getGenerationReviewHeading } from "./GenerationReviewSummary";
import { appendDraftRunEvent } from "../draft-run-events";
import type { DraftRunEvent } from "../../shared/draft-workflow";

const rendererStyles = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
const articleWorkspaceSource = readFileSync(resolve(__dirname, "./ArticleWorkspace.tsx"), "utf8");
const draftNoticesSource = readFileSync(resolve(__dirname, "./DraftGenerationNotices.tsx"), "utf8");
const visualMarkdownEditorSource = readFileSync(resolve(__dirname, "./VisualMarkdownEditor.tsx"), "utf8");
const draftWorkflowProgressSource = readFileSync(resolve(__dirname, "./DraftWorkflowProgress.tsx"), "utf8");
const workbenchSource = readFileSync(resolve(__dirname, "../hooks/useWorkbench.ts"), "utf8");

describe("draft generation notices", () => {
  it("keeps style selection and image curation in separate author-facing notices", () => {
    expect(workbenchSource).not.toMatch(/setDraftGenerationStatus\(`阿文的风格选择:[^\n]*imageCuration/);
    expect(articleWorkspaceSource).toContain("draftStyleSelectionNote");
    expect(articleWorkspaceSource).toContain("draftImageCuration");
    expect(articleWorkspaceSource).toContain("<DraftGenerationNotices");
    expect(draftNoticesSource).toContain("aria-label=\"风格选择说明\"");
    expect(draftNoticesSource).toContain("aria-label=\"配图处理结果\"");
    expect(draftNoticesSource).toContain("阿文的风格选择");
    expect(draftNoticesSource).toContain("配图处理：{imageTitle}");
  });

  it("renders the complete progress history from an ordered workflow snapshot", () => {
    expect(articleWorkspaceSource).toContain("<DraftWorkflowProgress events={awenWorkflow?.events ?? []} draftRunId={draftRunId} draftRunEvents={draftRunEvents} />");
    expect(articleWorkspaceSource).not.toMatch(/awenWorkflow\.events[\s\S]{0,500}\.slice\(-6\)/);
    expect(articleWorkspaceSource).toContain('role="status"');
    expect(articleWorkspaceSource).toContain('generating ? (generationStatus || "AI 正在起草正文…")');
    expect(articleWorkspaceSource).toContain("generationStatus || \"正在等待 AI 的第一段正文内容…\"");
    expect(articleWorkspaceSource).toContain("draftRunEvents={draftRunEvents}");
  });
});

describe("draft workflow progress history", () => {
  it("keeps the complete ordered progress history instead of replacing it with a six-event window", () => {
    const events = Array.from({ length: 9 }, (_, index) => ({
      id: `event-${index + 1}`,
      sequence: index + 1,
      type: index === 4 ? "internal_note" : "progress",
      at: new Date(index).toISOString(),
      message: `进度 ${index + 1}`
    }));

    expect(getDraftWorkflowProgressEvents(events).map((event) => event.id)).toEqual([
      "event-1", "event-2", "event-3", "event-4", "event-6", "event-7", "event-8", "event-9"
    ]);
  });

  it("reconciles streamed draft events with a restored snapshot in sequence order without duplicates", () => {
    const restored: DraftRunEvent = { runId: "run-1", sequence: 1, kind: "stage_started", stage: "drafting",
      summary: "开始起草", payload: {}, createdAt: "2026-10-02T00:00:00.000Z" };
    const next: DraftRunEvent = { ...restored, sequence: 2, kind: "stage_completed", summary: "第一节已完成" };
    const skipped: DraftRunEvent = { ...restored, sequence: 3, kind: "stage_skipped", stage: "curating_images", summary: "本篇无需配图" };
    const late: DraftRunEvent = { ...restored, sequence: 4, kind: "review_completed", stage: "reviewing", summary: "评审完成" };

    const afterReconnect = appendDraftRunEvent([restored], late);
    const reconciled = appendDraftRunEvent(appendDraftRunEvent(appendDraftRunEvent(afterReconnect, skipped), next), next);

    expect(reconciled.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(reconciled.map((event) => event.summary)).toEqual(["开始起草", "第一节已完成", "本篇无需配图", "评审完成"]);
    expect(appendDraftRunEvent(reconciled, { runId: "run-1", sequence: 5, kind: "progress" })).toBe(reconciled);
  });

  it("keeps actionable tool and authorization updates in progress while excluding private notes", () => {
    const events = ["tool_started", "permission_requested", "tool_completed", "internal_note"].map((type, index) => ({
      id: `event-${index}`, sequence: index + 1, type, at: new Date(index).toISOString(), message: type
    }));
    expect(getDraftWorkflowProgressEvents(events).map((event) => event.type))
      .toEqual(["tool_started", "permission_requested", "tool_completed"]);
    expect(draftWorkflowProgressSource).toContain("event.message");
    expect(draftWorkflowProgressSource).toContain("event.summary");
  });

  it("distinguishes successful review, author action, and reviewer failure", () => {
    expect(getGenerationReviewHeading("passed", "正文")).toBe("正文评审通过");
    expect(getGenerationReviewHeading("needs_author", "正文")).toBe("正文需要处理");
    expect(getGenerationReviewHeading("review_failed", "正文")).toBe("正文评审未完成");
  });
});

describe("candidate source confirmation in the editor", () => {
  it("shows source, excerpt, and author decision beside candidate claims", () => {
    expect(articleWorkspaceSource).toContain("正文中的候选事实");
    expect(articleWorkspaceSource).toContain("依据：{link.supportingExcerpt}");
    expect(articleWorkspaceSource).toContain("待作者确认");
    expect(articleWorkspaceSource).toContain("拒绝依据");
    expect(articleWorkspaceSource).toContain("{link.sourceTitle}</a>");
    expect(articleWorkspaceSource).toContain("onLocate={locateResearchLink}");
  });

  it("rechecks associations after Markdown edits and only highlights unresolved claims", () => {
    expect(articleWorkspaceSource).toMatch(/draft\/research-links\/check[\s\S]{0,200}JSON\.stringify\(\{ markdown \}\)/);
    expect(articleWorkspaceSource).toMatch(/\}, \[projectId, markdown\]\);/);
    expect(visualMarkdownEditorSource).toContain('link.status !== "pending_author" && link.status !== "needs_recheck" && link.status !== "rejected"');
    expect(visualMarkdownEditorSource).toContain('"这处网页事实待作者确认"');
    expect(articleWorkspaceSource).toContain("researchLinks={articleResearchLinks}");
    expect(articleWorkspaceSource).toContain("待处理来源 {articleResearchLinks.filter");
    expect(articleWorkspaceSource).toContain("markdown.indexOf(claimText)");
    expect(articleWorkspaceSource).toContain("setSourceLocateRequest({ claimText, sequence: Date.now() })");
    expect(visualMarkdownEditorSource).toContain("locateResearchRequest.claimText");
    expect(visualMarkdownEditorSource).toContain('block.scrollIntoView({ behavior: "smooth", block: "center" })');
  });
});

describe("image preview layout", () => {
  it("wraps long titles and keeps the full image centered inside the modal", () => {
    const titleRule = rendererStyles.match(/\.image-preview-header h2 \{([^}]*)\}/)?.[1] ?? "";
    const stageRule = rendererStyles.match(/\.image-preview-stage \{([^}]*)\}/)?.[1] ?? "";
    const imageRule = rendererStyles.match(/\.image-preview-stage img \{([^}]*)\}/)?.[1] ?? "";

    expect(titleRule).toMatch(/white-space:\s*normal/);
    expect(titleRule).toMatch(/overflow-wrap:\s*anywhere/);
    expect(stageRule).toMatch(/display:\s*flex/);
    expect(stageRule).toMatch(/justify-content:\s*center/);
    expect(imageRule).toMatch(/max-width:\s*100%/);
    expect(imageRule).toMatch(/max-height:\s*65vh/);
    expect(imageRule).toMatch(/object-fit:\s*contain/);
  });
});

describe("image search request isolation", () => {
  it("only accepts a response for the current request and article context", () => {
    expect(isCurrentImageSearchRequest(2, 2, "source:posts/current/index.md", "source:posts/current/index.md")).toBe(true);
    expect(isCurrentImageSearchRequest(1, 2, "source:posts/current/index.md", "source:posts/current/index.md")).toBe(false);
    expect(isCurrentImageSearchRequest(2, 2, "source:posts/old/index.md", "source:posts/current/index.md")).toBe(false);
  });
});

describe("article save state", () => {
  it("adopts the saved Markdown normalization when no newer edit exists", () => {
    expect(reconcileMarkdownAfterSave("# Title  \n", "# Title  \n", "# Title\n"))
      .toEqual({ currentMarkdown: "# Title\n", savedMarkdown: "# Title\n" });
  });

  it("preserves edits made while the save request was in flight", () => {
    expect(reconcileMarkdownAfterSave("new edit", "submitted edit", "submitted edit\n"))
      .toEqual({ currentMarkdown: "new edit", savedMarkdown: "submitted edit\n" });
  });

  it("does not keep the article dirty when only suggestion metadata sync failed", () => {
    expect(reconcileAwenSuggestionSaveState(
      new Set(["message-1:0"]), new Set(), ["message-1:0"], ["message-1:0"]
    )).toEqual({ unsavedIds: new Set(), syncPendingIds: new Set(["message-1:0"]) });
  });

  it("keeps a save-time Awen sync current when saving assigns the article its first source path", () => {
    expect(isCurrentAwenSuggestionSync(3, 3, "project:project-1", "source:posts/example/index.md", "source:posts/example/index.md")).toBe(true);
    expect(isCurrentAwenSuggestionSync(3, 3, "project:project-1", "source:posts/other/index.md", "source:posts/example/index.md")).toBe(false);
  });
});

describe("cover prompt editing", () => {
  it("uses article settings as the single controlled value and captures input before state updates", () => {
    expect(articleWorkspaceSource).not.toMatch(/\[settingsCoverPrompt,\s*setSettingsCoverPrompt\]/);
    expect(articleWorkspaceSource).not.toContain("setSettingsCoverPrompt(");
    expect(articleWorkspaceSource).toMatch(/const coverPrompt = event\.currentTarget\.value;\s*coverPromptEditedContextKeyRef\.current = contextKey;\s*setArticleSettings\(\(current\) => \(\{ \.\.\.current, coverPrompt \}\)\);/);
    expect(articleWorkspaceSource).toContain("value={articleSettings.coverPrompt}");
    expect(articleWorkspaceSource).toContain("coverPromptEditedContextKeyRef.current = contextKey");
    expect(articleWorkspaceSource).toContain("if (cancelled) return");
  });

  it("does not overwrite prompt text edited while the same article settings were loading", () => {
    expect(resolveLoadedCoverPrompt("刚输入的新提示词", "之前保存的提示词", "source:article-a", "source:article-a"))
      .toBe("刚输入的新提示词");
    expect(resolveLoadedCoverPrompt("其他文章的提示词", "本篇已保存提示词", "source:article-b", "source:article-a"))
      .toBe("本篇已保存提示词");
  });
});

describe("execution activity navigation", () => {
  it("routes both activity shortcuts through a repeatable request to locate pending authorization", () => {
    expect(articleWorkspaceSource).toContain("onOpenExecutionActivity={openExecutionActivity}");
    expect(articleWorkspaceSource).toContain("onOpenWorkflowActivity={openExecutionActivity}");
    expect(articleWorkspaceSource).toContain("focusPermissionRequest={workflowActivityFocusRequest}");
    expect(articleWorkspaceSource).toMatch(/const openExecutionActivity = \(\) => \{\s*setRightPanel\("activity"\);\s*setWorkflowActivityFocusRequest\(\(request\) => request \+ 1\);\s*setAwenActivityExpanded\(true\);/);
    expect(articleWorkspaceSource).toMatch(/<AwenToolWorkflowActivityModal[^\n]*focusPermissionRequest=\{workflowActivityFocusRequest\}/);
  });
});

describe("Awen bottom panel overflow", () => {
  it("constrains the panel grids and gives overflowing conversation and composer visible scrollbars", () => {
    const bottomPanelRule = rendererStyles.match(/\.editor-workspace\.with-awen-panel \.awen-bottom-panel \{([^}]*)\}/)?.[1] ?? "";
    const bottomLayoutRule = rendererStyles.match(/\.awen-bottom-layout \{([^}]*)\}/)?.[1] ?? "";

    expect(bottomPanelRule).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)/);
    expect(bottomLayoutRule).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)/);
    expect(rendererStyles).toMatch(/\.awen-bottom-panel \.awen-composer \{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/);
    expect(rendererStyles).toContain(".awen-bottom-panel .awen-composer::-webkit-scrollbar");
  });
});
