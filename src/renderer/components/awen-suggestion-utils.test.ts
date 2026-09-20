import { describe, expect, it } from "vitest";

import { getAwenAlternativeSuggestionIds } from "./awen-suggestion-utils";
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
});
