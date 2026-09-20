import { describe, expect, it } from "vitest";
import { removeUnavailableAwenSuggestions, shouldAutoScrollAwenTranscript } from "./AwenPanels";
import { applyAwenSuggestionToMarkdown, getPendingAwenSuggestionIds, isAwenSuggestionApplied, shouldPersistAcceptedAwenSuggestion } from "./awen-suggestion-utils";
import type { ArticleChatMessage } from "../types";

function assistantMessage(status: "pending" | "accepted"): ArticleChatMessage[] {
  return [{
    id: "11111111-1111-4111-8111-111111111111",
    role: "assistant",
    content: "建议",
    memorySuggestion: "",
    suggestions: [{ original: "原始段落内容", replacement: "改写后的段落内容", reason: "表达更清楚", status }],
    createdAt: "2026-09-19T00:00:00.000Z"
  }];
}

describe("Awen suggestion recovery", () => {
  it("keeps an accepted suggestion after the author edits the applied text", () => {
    const result = removeUnavailableAwenSuggestions(assistantMessage("accepted"), "标题\n\n原始段落内容");

    expect(result.messages[0].suggestions[0].status).toBe("accepted");
    expect(result.staleSuggestions).toEqual([]);
  });

  it("keeps an accepted suggestion when the original text is gone", () => {
    const result = removeUnavailableAwenSuggestions(assistantMessage("accepted"), "标题\n\n改写后的段落内容");

    expect(result.messages[0].suggestions[0].status).toBe("accepted");
  });

  it("appends an insert-after suggestion without replacing the original", () => {
    const suggestion = {
      original: "Socket API",
      replacement: "随后安装 Agent Skill，作为上层编排入口。",
      reason: "补充两者的关系",
      operation: "insert_after" as const
    };
    const markdown = "本文介绍 Socket API。\n\n下一节继续。";

    const updated = applyAwenSuggestionToMarkdown(markdown, suggestion);

    if (!updated) throw new Error("追加建议没有生成新正文");
    expect(updated).toBe("本文介绍 Socket API。\n\n随后安装 Agent Skill，作为上层编排入口。\n\n下一节继续。");
    expect(updated).toContain("本文介绍 Socket API。");
    expect(isAwenSuggestionApplied(updated, suggestion)).toBe(true);
  });

  it("does not treat an unapplied insert-after suggestion as accepted", () => {
    const suggestion = {
      original: "Socket API",
      replacement: "补充内容",
      reason: "补充说明",
      operation: "insert_after" as const
    };

    expect(isAwenSuggestionApplied("本文介绍 Socket API。", suggestion)).toBe(false);
  });

  it("keeps an accepted insert-after suggestion after the author edits its inserted text", () => {
    const suggestion = {
      original: "Socket API",
      replacement: "补充内容",
      reason: "补充说明",
      operation: "insert_after" as const
    };

    expect(shouldPersistAcceptedAwenSuggestion("本文介绍 Socket API。\n\n作者改写后的补充内容。", suggestion)).toBe(true);
  });

  it("recognizes an old suggestion that explicitly said to preserve the original", () => {
    const suggestion = {
      original: "Socket API",
      replacement: "补充内容",
      reason: "建议接在 Socket API 之后，不替换原文"
    };
    const updated = applyAwenSuggestionToMarkdown("本文介绍 Socket API。", suggestion);

    expect(updated).toBe("本文介绍 Socket API。\n\n补充内容");
  });

  it("only counts actionable anchored suggestions before a new Awen turn", () => {
    const messages: ArticleChatMessage[] = [{
      id: "22222222-2222-4222-8222-222222222222",
      role: "assistant",
      content: "建议",
      memorySuggestion: "",
      suggestions: [
        { original: "待处理原文", replacement: "改写", reason: "更清楚", status: "pending" },
        { original: "已拒绝原文", replacement: "改写", reason: "已处理", status: "rejected" },
        { original: "草稿原文", replacement: "改写", reason: "已接受" },
        { original: "已失效原文", replacement: "改写", reason: "找不到了", status: "pending" }
      ],
      createdAt: "2026-09-19T00:00:00.000Z"
    }];
    const unsaved = new Set(["22222222-2222-4222-8222-222222222222:2"]);

    expect(getPendingAwenSuggestionIds(messages, "待处理原文\n\n草稿原文", unsaved)).toEqual(["22222222-2222-4222-8222-222222222222:0"]);
  });
});

describe("Awen transcript scrolling", () => {
  it("does not scroll when only a suggestion status changes", () => {
    expect(shouldAutoScrollAwenTranscript(4, false, 4, false)).toBe(false);
  });

  it("scrolls for the initial view, a new message, or loading start", () => {
    expect(shouldAutoScrollAwenTranscript(undefined, undefined, 4, false)).toBe(true);
    expect(shouldAutoScrollAwenTranscript(4, false, 5, false)).toBe(true);
    expect(shouldAutoScrollAwenTranscript(4, false, 4, true)).toBe(true);
    expect(shouldAutoScrollAwenTranscript(4, true, 4, false)).toBe(false);
  });
});
