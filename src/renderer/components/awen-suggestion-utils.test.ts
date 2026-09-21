import { describe, expect, it } from "vitest";

import { canFinalizeAwenSuggestionSync, canSendAwenMessage, getArticleChatContextKey, getAwenAlternativeSuggestionIds, isCurrentAwenLoad, isCurrentAwenSuggestionSync, shouldReloadAwenConversation } from "./awen-suggestion-utils";
import type { ArticleChatMessage } from "../types";

describe("Awen suggestion alternatives", () => {
  it("groups pending options that use the same original anchor", () => {
    const messages: ArticleChatMessage[] = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        role: "assistant",
        content: "方案",
        memorySuggestion: "",
        suggestions: [
          { original: "同一段原文", replacement: "方案一", reason: "更紧凑" },
          { original: "同一段原文", replacement: "方案二", reason: "更具体" },
          { original: "另一段原文", replacement: "方案三", reason: "不同位置" },
          { original: "同一段原文", replacement: "已拒绝方案", reason: "旧方案", status: "rejected" }
        ],
        createdAt: "2026-09-20T00:00:00.000Z"
      }
    ];

    expect(getAwenAlternativeSuggestionIds(messages, "11111111-1111-4111-8111-111111111111:0"))
      .toEqual(["11111111-1111-4111-8111-111111111111:1"]);
  });

  it("uses the saved source path for article chat after a title rename", () => {
    expect(getArticleChatContextKey("posts/新标题/index.md", "source:posts/旧标题/index.md"))
      .toBe("source:posts/新标题/index.md");
    expect(getArticleChatContextKey(undefined, "project:project-id"))
      .toBe("project:project-id");
  });

  it("reloads an open Awen panel when its article context changes", () => {
    expect(shouldReloadAwenConversation(true, true, "source:posts/旧标题/index.md", "source:posts/新标题/index.md")).toBe(true);
    expect(shouldReloadAwenConversation(true, true, "source:posts/新标题/index.md", "source:posts/新标题/index.md")).toBe(false);
    expect(shouldReloadAwenConversation(false, true, "source:posts/旧标题/index.md", "source:posts/新标题/index.md")).toBe(false);
    expect(shouldReloadAwenConversation(true, false, undefined, "source:posts/新标题/index.md")).toBe(true);
    expect(shouldReloadAwenConversation(true, false, undefined, "source:posts/新标题/index.md", "source:posts/新标题/index.md")).toBe(false);
  });

  it("blocks a new Awen message until the current article context is loaded", () => {
    expect(canSendAwenMessage(true, "source:posts/旧标题/index.md", "source:posts/新标题/index.md", false)).toBe(false);
    expect(canSendAwenMessage(true, "source:posts/新标题/index.md", "source:posts/新标题/index.md", false)).toBe(true);
    expect(canSendAwenMessage(false, undefined, "source:posts/新标题/index.md", false)).toBe(false);
    expect(canSendAwenMessage(false, undefined, "source:posts/新标题/index.md", true)).toBe(true);
  });

  it("accepts only the latest Awen conversation load result", () => {
    expect(isCurrentAwenLoad(2, 2, "source:posts/新标题/index.md", "source:posts/新标题/index.md")).toBe(true);
    expect(isCurrentAwenLoad(1, 2, "source:posts/旧标题/index.md", "source:posts/新标题/index.md")).toBe(false);
    expect(isCurrentAwenLoad(2, 2, "source:posts/旧标题/index.md", "source:posts/新标题/index.md")).toBe(false);
  });

  it("only applies suggestion sync results to the current article context", () => {
    expect(isCurrentAwenSuggestionSync(2, 2, "source:posts/新标题/index.md", "source:posts/新标题/index.md")).toBe(true);
    expect(isCurrentAwenSuggestionSync(1, 2, "source:posts/新标题/index.md", "source:posts/新标题/index.md")).toBe(false);
    expect(isCurrentAwenSuggestionSync(2, 2, "source:posts/旧标题/index.md", "source:posts/新标题/index.md")).toBe(false);
  });

  it("does not finalize a suggestion when the conversation refresh failed or the suggestion is missing", () => {
    expect(canFinalizeAwenSuggestionSync(false, undefined)).toBe(false);
    expect(canFinalizeAwenSuggestionSync(true, undefined)).toBe(false);
  });
});
