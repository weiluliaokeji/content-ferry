import { describe, expect, it } from "vitest";

import { filterActionableArticleSuggestions, getWorkflowBlockerMessage, selectPracticeEvidenceResults } from "./awen-conversation-service";
import type { ArticleChatSuggestion } from "./awen-conversation-service";
import type { ToolWorkflowSnapshot } from "../agent/tool-workflow-runner";

describe("Awen actionable suggestions", () => {
  it("does not expose feedback as content that can be inserted into the article", () => {
    const suggestions: ArticleChatSuggestion[] = [
      { original: "原文段落", replacement: "建议把这段写得更具体", reason: "这是反馈", operation: "insert_after", kind: "feedback", status: "pending" },
      { original: "原文段落", replacement: "可直接放入正文的新段落。", reason: "补充必要背景", operation: "insert_after", kind: "content", status: "pending" }
    ];

    expect(filterActionableArticleSuggestions("原文段落", suggestions)).toEqual([suggestions[1]]);
  });
});

describe("Awen practice evidence selection", () => {
  it("persists results from registered CLI tasks alongside dedicated practice tools", () => {
    const results = [
      { toolId: "registered_cli_task", output: { taskId: "scoop.list", status: "completed" } },
      { toolId: "practice_run_code", output: { stdout: "ok" } },
      { toolId: "web_search", output: { results: [] } }
    ];

    expect(selectPracticeEvidenceResults(results)).toEqual(results.slice(0, 2));
  });

  it("prefers the actual missing outcome over a generic loop-limit error", () => {
    const workflow: ToolWorkflowSnapshot = {
      workflowId: "workflow-1", status: "failed", round: 8, userRequest: "run scoop and capture a screenshot",
      transcript: [], toolResults: [], pendingPermission: null, finalText: null, warningCount: 0,
      events: [
        { id: "verify", sequence: 1, type: "goal_verification_continued", at: "2026-09-28T00:00:00Z", message: "已取得已安装列表，但缺少终端截图，不能把截图要求标为完成。" },
        { id: "failed", sequence: 2, type: "workflow_failed", at: "2026-09-28T00:00:01Z", message: "模型回合超过上限 8。" }
      ]
    };

    expect(getWorkflowBlockerMessage(workflow)).toContain("缺少终端截图");
    expect(getWorkflowBlockerMessage(workflow)).not.toContain("模型回合超过上限");
  });

  it("shows the concrete tool failure when the goal verifier also reports an incomplete result", () => {
    const workflow: ToolWorkflowSnapshot = {
      workflowId: "workflow-2", status: "incomplete", round: 3, userRequest: "capture a GitHub screenshot",
      transcript: [], toolResults: [], pendingPermission: null, finalText: null, warningCount: 1,
      events: [
        { id: "tool-failed", sequence: 1, type: "tool_failed", at: "2026-09-28T00:00:00Z", message: "网页截图没有开始：github.com 当前解析到 RFC 2544 基准测试专用网段 198.18.0.0/15。" },
        { id: "incomplete", sequence: 2, type: "workflow_incomplete", at: "2026-09-28T00:00:01Z", message: "验证器确认当前证据不足，已返回明确标注待核查的答复；本轮不计为目标完成。" }
      ]
    };

    const message = getWorkflowBlockerMessage(workflow);
    expect(message).toContain("github.com");
    expect(message).toContain("198.18.0.0/15");
    expect(message).toContain("截图没有开始");
    expect(message).toContain("证据不足");
  });
});
