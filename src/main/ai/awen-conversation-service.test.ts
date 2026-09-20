import { describe, expect, it } from "vitest";

import { filterActionableArticleSuggestions } from "./awen-conversation-service";
import type { ArticleChatSuggestion } from "./awen-conversation-service";

describe("Awen actionable suggestions", () => {
  it("does not expose feedback as content that can be inserted into the article", () => {
    const suggestions: ArticleChatSuggestion[] = [
      { original: "原文段落", replacement: "建议把这段写得更具体", reason: "这是反馈", operation: "insert_after", kind: "feedback", status: "pending" },
      { original: "原文段落", replacement: "可直接放入正文的新段落。", reason: "补充必要背景", operation: "insert_after", kind: "content", status: "pending" }
    ];

    expect(filterActionableArticleSuggestions("原文段落", suggestions)).toEqual([suggestions[1]]);
  });
});
