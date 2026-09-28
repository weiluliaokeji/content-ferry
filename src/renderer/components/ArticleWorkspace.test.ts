import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isCurrentImageSearchRequest } from "./image-search-utils";
import { isCurrentAwenSuggestionSync } from "./awen-suggestion-utils";
import { reconcileMarkdownAfterSave } from "./article-save-state";
import { reconcileAwenSuggestionSaveState } from "./awen-suggestion-save-state";
import { resolveLoadedCoverPrompt } from "./article-settings-state";

const rendererStyles = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
const articleWorkspaceSource = readFileSync(resolve(__dirname, "./ArticleWorkspace.tsx"), "utf8");

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
