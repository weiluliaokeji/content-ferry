import { describe, expect, it } from "vitest";

import { buildPracticeStepRetryContext, buildPracticeStepRetryUnavailablePrompt, filterActionableArticleSuggestions, getWorkflowBlockerMessage, selectPracticeEvidenceResults } from "./awen-conversation-service";
import type { ArticleChatSuggestion } from "./awen-conversation-service";
import type { ToolWorkflowSnapshot } from "../agent/tool-workflow-runner";
import { ToolWorkflowRepository } from "../agent/tool-workflow-repository";
import { openInMemoryDatabase } from "../db/database";

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

  it("explains when a retry request follows a verifier-only stop instead of a failed tool call", () => {
    const workflow: ToolWorkflowSnapshot = {
      workflowId: "workflow-verifier-only", status: "incomplete", round: 2, userRequest: "只重试失败步骤",
      transcript: [], toolResults: [], pendingPermission: null, finalText: null, warningCount: 1,
      events: [
        { id: "verified-blocker", sequence: 1, type: "goal_verification_incomplete", at: "2026-10-06T00:00:00Z", message: "完成核验连续两轮未通过；缺少可定位的本机命令输出。" },
        { id: "stopped", sequence: 2, type: "workflow_incomplete", at: "2026-10-06T00:00:01Z", message: "已保留候选答复。" }
      ]
    };

    const prompt = buildPracticeStepRetryUnavailablePrompt(workflow);
    expect(prompt).toContain("没有记录失败或无有效输出的工具调用");
    expect(prompt).toContain("停在完成核验阶段");
    expect(prompt).toContain("缺少可定位的本机命令输出");
    expect(prompt).toContain("先说明需要做什么并等待作者指示");
  });

  it("distinguishes a duplicate call blocked before execution from a failed tool step", () => {
    const workflow: ToolWorkflowSnapshot = {
      workflowId: "workflow-duplicate-blocked", status: "incomplete", round: 3, userRequest: "只重试失败步骤",
      transcript: [], toolResults: [], pendingPermission: null, finalText: null, warningCount: 1,
      events: [
        { id: "duplicate", sequence: 1, type: "tool_duplicate_blocked", at: "2026-10-06T00:00:00Z", message: "已拦截完成核验未通过后的相同调用 practice_run_command；上一轮的观察结果仍保留在记录中。本次没有再次运行。" },
        { id: "stopped", sequence: 2, type: "workflow_incomplete", at: "2026-10-06T00:00:01Z", message: "已保留候选答复。" }
      ]
    };

    const prompt = buildPracticeStepRetryUnavailablePrompt(workflow);
    expect(prompt).toContain("模型提出了重复调用，但运行时已拦截");
    expect(prompt).toContain("实际没有再次执行");
    expect(prompt).toContain("practice_run_command");
    expect(prompt).toContain("不要重放此前已成功的调用");
  });

  it("does not offer an older failed tool as the retry target after a later duplicate was blocked", () => {
    const database = openInMemoryDatabase();
    try {
      const now = new Date().toISOString();
      database.connection.prepare("INSERT INTO workspaces (id, display_name, created_at) VALUES (?, ?, ?)").run("workspace-1", "test", now);
      database.connection.prepare("INSERT INTO content_projects (id, workspace_id, topic, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run("project-1", "workspace-1", "测试", now, now);
      const repository = new ToolWorkflowRepository(database.connection);
      const snapshot: ToolWorkflowSnapshot = {
        workflowId: "workflow-latest-duplicate", status: "incomplete", round: 3, userRequest: "只重试上次失败步骤",
        transcript: [], toolResults: [], pendingPermission: null, finalText: "候选答复", warningCount: 1,
        events: [
          { id: "old-failure", sequence: 1, type: "tool_failed", at: "2026-10-06T00:00:00Z", message: "旧调用失败。", data: { toolId: "practice_run_command", retryFingerprint: "a".repeat(64) } },
          { id: "latest-duplicate", sequence: 2, type: "tool_duplicate_blocked", at: "2026-10-06T00:00:01Z", message: "已拦截相同调用 practice_run_command；本次没有再次运行。", data: { toolId: "practice_run_command" } },
          { id: "stopped", sequence: 3, type: "workflow_incomplete", at: "2026-10-06T00:00:02Z", message: "已保留候选答复。" }
        ]
      };
      repository.save(snapshot, { contextKey: "article-1", projectId: "project-1", request: { practiceTaskId: "task-1" } });

      const retry = buildPracticeStepRetryContext(repository, "task-1", "project-1", snapshot.workflowId, "只重试上次失败步骤");

      expect(retry.retry.mode).toBe("exact_tool_retry");
      expect(retry.retry.failedToolId).toBeNull();
      expect(retry.prompt).toContain("重复调用，但运行时已拦截");
      expect(retry.prompt).toContain("本次没有再次运行");
    } finally {
      database.close();
    }
  });

  it("turns an explicit retry after verifier-only failure into answer repair using saved observations", () => {
    const database = openInMemoryDatabase();
    try {
      const now = new Date().toISOString();
      database.connection.prepare("INSERT INTO workspaces (id, display_name, created_at) VALUES (?, ?, ?)").run("workspace-1", "test", now);
      database.connection.prepare("INSERT INTO content_projects (id, workspace_id, topic, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run("project-1", "workspace-1", "已安装的 Java 包", now, now);
      const repository = new ToolWorkflowRepository(database.connection);
      const snapshot: ToolWorkflowSnapshot = {
        workflowId: "workflow-verifier-repair",
        status: "incomplete",
        round: 2,
        userRequest: "请在本机统计已安装的 Java 包",
        transcript: [
          { role: "user", content: "请在本机统计已安装的 Java 包" },
          { role: "assistant", content: "本机已安装 4 个 Java 包。" },
          { role: "tool", content: "goal_verification：证据引文未能定位。" }
        ],
        events: [
          { id: "verified-blocker", sequence: 1, type: "goal_verification_incomplete", at: "2026-10-06T00:00:00Z", message: "核验引文格式无效；已有命令输出保留在本轮观察中。" },
          { id: "stopped", sequence: 2, type: "workflow_incomplete", at: "2026-10-06T00:00:01Z", message: "已保留候选答复。" }
        ],
        toolResults: [{ callId: "previous-cli-run", toolId: "practice_run_command", output: { stdout: "corretto8-jdk\ncorretto11-jdk\ncorretto17-jdk\ncorretto21-jdk" } }],
        pendingPermission: null,
        finalText: "本机已安装 4 个 Java 包。",
        warningCount: 1
      };
      repository.save(snapshot, { contextKey: "article-1", projectId: "project-1", request: { practiceTaskId: "task-1" } });

      const retry = buildPracticeStepRetryContext(repository, "task-1", "project-1", snapshot.workflowId, "请只重试上一次失败的步骤");

      expect(retry.retry.mode).toBe("answer_repair");
      expect(retry.prompt).toContain("只允许依据已保存的候选答复和工具观察修复答复并重新核验");
      expect(retry.seed?.toolResults).toEqual(snapshot.toolResults);
      expect(retry.seed?.transcript).toEqual(snapshot.transcript);
    } finally {
      database.close();
    }
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
