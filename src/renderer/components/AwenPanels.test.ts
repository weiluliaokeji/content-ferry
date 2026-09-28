import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArticlePracticeTaskCard, AwenBottomPanel, AwenToolWorkflowActivity, AwenToolWorkflowActivityModal, completeAwenAssistantResponse, getArticlePracticeDraftingLabel, getAwenActivityEmptyMessage, getAwenDeliveryStateLabel, getAwenWorkflowProgressMessage, getPracticeAttemptComparisons, getUnlinkedLegacyExecutionRuns, getUnlinkedLegacyToolWorkflows, removeUnavailableAwenSuggestions, RETRY_FAILED_PRACTICE_STEP_PROMPT, shouldAutoScrollAwenTranscript, summarizePracticeEvent } from "./AwenPanels";
import { applyAwenSuggestionToMarkdown, getPendingAwenSuggestionIds, isAwenSuggestionApplied, shouldPersistAcceptedAwenSuggestion } from "./awen-suggestion-utils";
import type { ArticleChatMessage, ArticlePracticeTask, ToolWorkflowSnapshot } from "../types";

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

describe("Awen authorization status", () => {
  it("describes retired CLI task records without software-specific permission copy", () => {
    const workflow: ToolWorkflowSnapshot = {
      workflowId: "legacy-cli", status: "waiting_user", round: 1, userRequest: "查看本机工具结果",
      transcript: [], events: [], toolResults: [], finalText: null, warningCount: 0,
      pendingPermission: {
        callId: "old-call", request: { toolId: "registered_cli_task", action: "write", target: "system-cli-task:old", input: { taskId: "scoop.list", parameters: {} } },
        permission: { decision: "ask", reason: "等待授权", matchedScope: null }
      }
    };
    const html = renderToStaticMarkup(createElement(AwenToolWorkflowActivity, {
      workflow, loading: false, onWorkflowPermission: () => undefined,
      onCancelWorkflow: () => undefined, onResumeWorkflow: () => undefined
    }));

    expect(html).toContain("旧版本机工具任务");
    expect(html).toContain("重新检查操作范围与授权");
    expect(html).not.toContain("Scoop");
  });

  it.each([
    ["waiting_permission", "等待你授权工具操作"],
    ["authorized", "已授权，阿文正在执行…"]
  ] as const)("shows the current %s state in the bottom conversation", (deliveryState, label) => {
    const html = renderToStaticMarkup(createElement(AwenBottomPanel, {
      messages: [{
        id: "33333333-3333-4333-8333-333333333333",
        role: "user",
        content: "运行一次验证",
        memorySuggestion: "",
        suggestions: [],
        createdAt: "2026-09-27T00:00:00.000Z",
        deliveryState
      }],
      memory: "",
      value: "",
      loading: false,
      unsavedSuggestionIds: new Set<string>(),
      savedSuggestionSyncPendingIds: new Set<string>(),
      pendingSuggestionCount: 0,
      pendingSuggestionReviewOpen: false,
      pendingSuggestionReviewBusy: false,
      bottomHeightPercent: 32,
      transcriptUserPercent: 34,
      onBottomHeightChange: () => undefined,
      onTranscriptUserPercentChange: () => undefined,
      onChange: () => undefined,
      onSend: () => undefined,
      onRetry: () => undefined,
      onAcceptSuggestion: () => undefined,
      onRejectSuggestion: () => undefined,
      onLocateSuggestion: () => undefined,
      onOpenMemoryManager: () => undefined,
      onRejectPendingAndContinue: () => undefined,
      onKeepPendingAndContinue: () => undefined,
      onCancelPendingSend: () => undefined,
      onOpenWorkflowActivity: () => undefined,
      onClose: () => undefined
    }));

    expect(html).toContain(label);
  });
});

describe("practice attempt comparison", () => {
  it("keeps internal article context out of the activity dialog heading", () => {
    const internalContext = `你正在和作者讨论一篇文章。当前文章全文：${"内部提示上下文。".repeat(80)}`;
    const workflow: ToolWorkflowSnapshot = {
      workflowId: "workflow-long-request", status: "waiting_user", round: 1, userRequest: internalContext,
      transcript: [], events: [], toolResults: [], finalText: null, warningCount: 0,
      pendingPermission: {
        callId: "run-java", request: { toolId: "practice_run_command", action: "write", target: "system-cli:java", input: { command: "java", args: ["-version"] } },
        permission: { decision: "ask", reason: "本次任务尚未授权", matchedScope: null }
      }
    };
    const markup = renderToStaticMarkup(createElement(AwenToolWorkflowActivityModal, {
      workflow, displayGoal: "查看本机 Java 版本", loading: false,
      onWorkflowPermission: () => undefined, onCancelWorkflow: () => undefined,
      onResumeWorkflow: () => undefined, onClose: () => undefined
    }));
    const heading = markup.match(/<div class="section-heading awen-activity-modal-header">([\s\S]*?)<\/button><\/div>/)?.[1] ?? "";

    expect(heading).toContain("等待授权");
    expect(heading).toContain("查看本机 Java 版本");
    expect(heading).not.toContain("内部提示上下文");
    expect(markup.match(/查看本机 Java 版本/g)).toHaveLength(1);
  });

  it("shows the task goal instead of an internal drafting prompt in practice activity and permission cards", () => {
    const workflow: ToolWorkflowSnapshot = {
      workflowId: "workflow-draft", status: "waiting_user", round: 1,
      userRequest: "你正在和作者讨论一篇文章。最近会话：内部起草指令与当前文章全文……",
      transcript: [], events: [], toolResults: [], finalText: null, warningCount: 0,
      pendingPermission: {
        callId: "run-code", request: { toolId: "practice_run_code", action: "write", target: "temporary-workspace", input: { runtime: "node", code: "console.log('ok')" } },
        permission: { decision: "ask", reason: "本次任务尚未授权", matchedScope: null }
      }
    };
    const markup = renderToStaticMarkup(createElement(AwenToolWorkflowActivity, {
      workflow, displayGoal: "判断 Markdown 标题示例是否需要实测", loading: false,
      onWorkflowPermission: () => undefined, onCancelWorkflow: () => undefined, onResumeWorkflow: () => undefined
    }));

    expect(markup.match(/判断 Markdown 标题示例是否需要实测/g)).toHaveLength(1);
    expect(markup).not.toContain("你正在和作者讨论一篇文章");
    expect(markup).not.toContain("最近会话：内部起草指令");
  });

  it("keeps assessment-only workflow events neutral instead of calling them practice", () => {
    const workflow: ToolWorkflowSnapshot = {
      workflowId: "workflow-assessment", status: "completed", round: 1, userRequest: "判断是否需要实践",
      transcript: [],
      events: [
        { id: "created", type: "workflow_created", at: "2026-09-26T09:06:38.000Z", message: "工作流已创建" },
        { id: "completed", type: "workflow_completed", at: "2026-09-26T09:07:00.000Z", message: "工作流已完成" }
      ],
      toolResults: [], pendingPermission: null, finalText: "无需实践", warningCount: 0
    };
    const markup = renderToStaticMarkup(createElement(AwenToolWorkflowActivity, {
      workflow, loading: false, onWorkflowPermission: () => undefined,
      onCancelWorkflow: () => undefined, onResumeWorkflow: () => undefined
    }));

    expect(markup).toContain("执行活动已开始");
    expect(markup).toContain("本轮已结束");
    expect(markup).not.toContain("实践已开始");
    expect(markup).not.toContain("实践已结束");
    expect(markup).toContain('aria-label="执行进度"');
  });

  it("shows a local Demo screenshot in the task activity without inventing a public URL", () => {
    const workflow: ToolWorkflowSnapshot = {
      workflowId: "workflow-demo", status: "completed", round: 1, userRequest: "验证本地 Demo",
      transcript: [], events: [], pendingPermission: null, finalText: "已完成", warningCount: 0,
      toolResults: [{ callId: "capture-demo", toolId: "practice_capture_demo", output: {
        title: "本地演示", url: "local-demo:演示/demo page.html", observedAt: "2026-09-26T10:00:00.000Z", observation: "按钮显示已连接",
        assetUrl: "./assets/11111111-1111-4111-8111-111111111111.png", screenshotSha256: "a".repeat(64), operationSummary: "打开本地 Demo 窗口并截取可见结果"
      } }]
    };

    const markup = renderToStaticMarkup(createElement(AwenToolWorkflowActivity, {
      workflow, projectId: "project-1", articlePath: "posts/demo/index.md", loading: false,
      onWorkflowPermission: () => undefined, onCancelWorkflow: () => undefined, onResumeWorkflow: () => undefined, showHeader: false
    }));

    expect(markup).toContain("本地 Demo：本地演示");
    expect(markup).toContain("按钮显示已连接");
    expect(markup).toContain("src=.%2Fassets%2F11111111-1111-4111-8111-111111111111.png");
    expect(markup).not.toContain("打开原网页");
  });

  it("explains local Demo screenshot permission in plain language", () => {
    const workflow: ToolWorkflowSnapshot = {
      workflowId: "workflow-demo", status: "waiting_user", round: 1, userRequest: "检查本地 Demo",
      transcript: [], events: [], toolResults: [], finalText: null, warningCount: 0,
      pendingPermission: {
        callId: "capture-demo", request: { toolId: "practice_capture_demo", action: "write", target: "C:/temp/workflow", input: { relativePath: "demo/index.html", caption: "界面" } },
        permission: { decision: "ask", reason: "尚未找到覆盖当前工具、动作和目标的授权。", matchedScope: null }
      }
    };
    const markup = renderToStaticMarkup(createElement(AwenToolWorkflowActivity, {
      workflow, projectId: "project-1", articlePath: "posts/demo/index.md", loading: false,
      onWorkflowPermission: () => undefined, onCancelWorkflow: () => undefined, onResumeWorkflow: () => undefined, showHeader: false
    }));

    expect(markup).toContain("阿文想预览并截取本地 Demo");
    expect(markup).toContain("把截图保存到本篇文章素材");
    expect(markup).toContain("允许本次任务预览 Demo 并保存截图");
    expect(markup).toContain("查看工作区路径和截图参数");
  });

  it("explains generic CLI permission without asking the author to configure a tool", () => {
    const workflow: ToolWorkflowSnapshot = {
      workflowId: "workflow-cli", status: "waiting_user", round: 1, userRequest: "统计本机 Java 版本",
      transcript: [], events: [], toolResults: [], finalText: null, warningCount: 0,
      pendingPermission: {
        callId: "run-cli", request: { toolId: "practice_run_command", action: "write", target: "system-cli:java@temporary-workspace", input: { command: "java", args: ["-version"] } },
        permission: { decision: "ask", reason: "本次任务尚未授权", matchedScope: null }
      }
    };
    const markup = renderToStaticMarkup(createElement(AwenToolWorkflowActivity, {
      workflow, loading: false, practiceTask: true,
      onWorkflowPermission: () => undefined, onCancelWorkflow: () => undefined, onResumeWorkflow: () => undefined, showHeader: false
    }));

    expect(markup).toContain("阿文想调用 java");
    expect(markup).toContain("当前 Windows 用户权限");
    expect(markup).toContain("临时目录不构成系统级隔离");
    expect(markup).toContain("本次任务");
    expect(markup).not.toContain("Scoop");
  });

  it("marks the pending authorization card as the destination for activity navigation", () => {
    const workflow: ToolWorkflowSnapshot = {
      workflowId: "workflow-permission-target", status: "waiting_user", round: 1, userRequest: "检查本机 Java 版本",
      transcript: [], events: [], toolResults: [], finalText: null, warningCount: 0,
      pendingPermission: {
        callId: "run-cli", request: { toolId: "practice_run_command", action: "write", target: "system-cli:java", input: { command: "java", args: ["-version"] } },
        permission: { decision: "ask", reason: "本次任务尚未授权", matchedScope: null }
      }
    };
    const markup = renderToStaticMarkup(createElement(AwenToolWorkflowActivity, {
      workflow, loading: false, onWorkflowPermission: () => undefined,
      onCancelWorkflow: () => undefined, onResumeWorkflow: () => undefined
    }));

    expect(markup).toContain('data-pending-permission-card="true"');
  });

  it("lets the author stop practice from its right-side activity while a permission is pending", () => {
    const workflow: ToolWorkflowSnapshot = {
      workflowId: "practice-workflow", status: "waiting_user", round: 1, userRequest: "验证示例代码",
      transcript: [], events: [], toolResults: [], finalText: null, warningCount: 0,
      pendingPermission: {
        callId: "run-code", request: { toolId: "practice_run_code", action: "write", target: "temporary-workspace", input: { runtime: "python", code: "print('ok')" } },
        permission: { decision: "ask", reason: "本次任务尚未授权", matchedScope: null }
      }
    };
    const markup = renderToStaticMarkup(createElement(AwenToolWorkflowActivity, {
      workflow, loading: false, practiceTask: true,
      onWorkflowPermission: () => undefined, onCancelWorkflow: () => undefined, onResumeWorkflow: () => undefined, showHeader: false
    }));

    expect(markup).toContain("停止实践");
    expect(markup).not.toContain("取消工作流");
  });

  it("opens a useful activity dialog when the task is waiting but its workflow snapshot has not loaded", () => {
    const markup = renderToStaticMarkup(createElement(AwenToolWorkflowActivityModal, {
      workflow: undefined,
      loading: true,
      onWorkflowPermission: () => undefined,
      onCancelWorkflow: () => undefined,
      onResumeWorkflow: () => undefined,
      onClose: () => undefined
    }));

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("正在读取授权记录");
  });

  it("shows a plain-language purpose for generic permission requests and keeps workflow identifiers out of the activity view", () => {
    const workflow: ToolWorkflowSnapshot = {
      workflowId: "workflow-internal-identifier", status: "waiting_user", round: 7, userRequest: "分析这个公开仓库",
      transcript: [], events: [{ id: "event-1", type: "tool_started", at: "2026-09-26T10:00:00.000Z", toolId: "git_clone_source", message: "准备执行 git_clone_source。", data: { destination: "D:/private/staging" } }],
      toolResults: [], finalText: null, warningCount: 0,
      pendingPermission: {
        callId: "call-1", request: { toolId: "git_clone_source", action: "write", target: "D:/private/staging", input: { repositoryUrl: "https://example.com/public/repo.git" } },
        permission: { decision: "ask", reason: "需要授权", matchedScope: null }
      }
    };
    const markup = renderToStaticMarkup(createElement(AwenToolWorkflowActivity, {
      workflow, projectId: "project-1", loading: false,
      onWorkflowPermission: () => undefined, onCancelWorkflow: () => undefined, onResumeWorkflow: () => undefined
    }));

    expect(markup).toContain("阿文想获取公开代码仓库");
    expect(markup).toContain("不会安装或运行其中的代码");
    expect(markup).toContain("查看具体范围和参数");
    expect(markup).toContain("允许本次任务在此范围内继续");
    expect(markup).not.toContain("允许当前文章同类操作");
    expect(markup).toContain("正在执行已确认的操作");
    expect(markup).not.toContain("workflow-internal-identifier");
    expect(markup).not.toContain("第 7 轮");
    expect(markup).toMatch(/<details><summary>查看记录详情<\/summary><span>准备执行 git_clone_source/);
  });

  it("keeps each attempt summary and its execution conditions side by side", () => {
    const attempts = getPracticeAttemptComparisons([
      { sequence: 2, kind: "practice_result", createdAt: "2026-09-25T10:00:00.000Z", payload: {
        summary: JSON.stringify({ reply: "Python 3.12 下运行成功。" }),
        results: [{ toolId: "practice_run_code", result: { runtime: "python", status: "completed", exitCode: 0 } }]
      } },
      { sequence: 5, kind: "practice_result", createdAt: "2026-09-25T10:05:00.000Z", payload: {
        summary: JSON.stringify({ reply: "Node.js 下运行失败。" }),
        results: [{ toolId: "practice_run_code", result: { runtime: "node", status: "failed", exitCode: 1 } }]
      } }
    ]);

    expect(attempts).toEqual([
      expect.objectContaining({ sequence: 2, summary: "Python 3.12 下运行成功。", conditions: ["runtime=python", "status=completed", "exitCode=0"] }),
      expect.objectContaining({ sequence: 5, summary: "Node.js 下运行失败。", conditions: ["runtime=node", "status=failed", "exitCode=1"] })
    ]);
  });

  it("shows unlinked old tool workflows once and skips workflows already attached to a practice task", () => {
    const workflows: ToolWorkflowSnapshot[] = [
      { workflowId: "legacy", status: "completed", round: 1, userRequest: "旧版验证", transcript: [], events: [{ id: "e1", type: "tool_completed", at: "2026-09-20T10:00:00.000Z", message: "运行完成" }], toolResults: [{ callId: "c1", toolId: "run", output: "ok" }], pendingPermission: null, finalText: "成功", warningCount: 0 },
      { workflowId: "linked", status: "completed", round: 1, userRequest: "新任务工作流", transcript: [], events: [{ id: "e2", type: "tool_completed", at: "2026-09-20T10:01:00.000Z", message: "运行完成" }], toolResults: [{ callId: "c2", toolId: "run", output: "ok" }], pendingPermission: null, finalText: "成功", warningCount: 0 }
    ];
    const task: ArticlePracticeTask = {
      id: "task-1", projectId: "project-1", sourceType: "awen", legacyExecutionRunId: null, status: "completed", goalRevision: 1, latestGoal: "新任务工作流",
      waitingReason: null, feedbackDeadline: null, createdAt: "2026-09-20T10:01:00.000Z", updatedAt: "2026-09-20T10:01:00.000Z",
      checkpoint: { workflowId: "linked" }, hasGaps: false
    };

    expect(getUnlinkedLegacyToolWorkflows(workflows, [task]).map((workflow) => workflow.workflowId)).toEqual(["legacy"]);
  });

  it("hides old execution runs already represented by a workflow or imported legacy task", () => {
    const runs = [
      { id: "legacy-run", projectId: "project-1", runtime: "node", targetType: "host_trusted", workflowId: null, practiceTaskId: null, status: "completed", exitCode: 0, hasError: false, truncated: false, artifactCount: 0, createdAt: "2026-09-20T10:00:00.000Z", startedAt: null, finishedAt: null, observation: null },
      { id: "unlinked-run", projectId: "project-1", runtime: "python", targetType: "host_trusted", workflowId: null, practiceTaskId: null, status: "failed", exitCode: 1, hasError: true, truncated: false, artifactCount: 0, createdAt: "2026-09-20T10:00:30.000Z", startedAt: null, finishedAt: null, observation: null },
      { id: "workflow-run", projectId: "project-1", runtime: "node", targetType: "host_trusted", workflowId: "legacy-workflow", practiceTaskId: null, status: "completed", exitCode: 0, hasError: false, truncated: false, artifactCount: 0, createdAt: "2026-09-20T10:01:00.000Z", startedAt: null, finishedAt: null, observation: null },
      { id: "task-run", projectId: "project-1", runtime: "node", targetType: "host_trusted", workflowId: null, practiceTaskId: "task-1", status: "completed", exitCode: 0, hasError: false, truncated: false, artifactCount: 0, createdAt: "2026-09-20T10:02:00.000Z", startedAt: null, finishedAt: null, observation: null }
    ];
    const workflow: ToolWorkflowSnapshot = {
      workflowId: "legacy-workflow", status: "completed", round: 1, userRequest: "old", transcript: [], events: [], toolResults: [], pendingPermission: null, finalText: null, warningCount: 0
    };
    const task: ArticlePracticeTask = {
      id: "task-1", projectId: "project-1", sourceType: "legacy_manual", legacyExecutionRunId: "legacy-run", status: "completed_with_gaps", goalRevision: 1, latestGoal: "旧版本机执行记录",
      waitingReason: null, feedbackDeadline: null, createdAt: "2026-09-20T10:02:00.000Z", updatedAt: "2026-09-20T10:02:00.000Z",
      checkpoint: {}, hasGaps: false
    };

    expect(getUnlinkedLegacyExecutionRuns(runs, [workflow], [task]).map((run) => run.id)).toEqual(["unlinked-run"]);
  });
});

describe("practice history labels", () => {
  it("uses plain language for stored task events without exposing raw event names", () => {
    expect(summarizePracticeEvent({ sequence: 1, kind: "practice_blocked", payload: {}, createdAt: "2026-09-25T00:00:00.000Z" }))
      .toBe("遇到阻碍，等待反馈");
    expect(summarizePracticeEvent({ sequence: 2, kind: "practice_result", payload: { kind: "project_file_change_restored" }, createdAt: "2026-09-25T00:00:01.000Z" }))
      .toBe("已恢复项目文件改动");
    expect(summarizePracticeEvent({ sequence: 3, kind: "legacy_execution_linked", payload: { executionRunId: "legacy-id" }, createdAt: "2026-09-25T00:00:02.000Z" }))
      .toBe("旧版执行记录已归入本篇历史");
  });
});

describe("live Awen workflow progress", () => {
  it("shows a plain-language current action in the article chat", () => {
    const workflow: ToolWorkflowSnapshot = {
      workflowId: "workflow-1", status: "running", round: 2, userRequest: "run local command",
      transcript: [], toolResults: [], pendingPermission: null, finalText: null, warningCount: 0,
      events: [{ id: "tool", sequence: 1, type: "tool_started", at: "2026-09-28T00:00:00Z", message: "准备执行 practice_run_command。", data: { toolId: "practice_run_command" } }]
    };

    expect(getAwenWorkflowProgressMessage(workflow)).toBe("正在本机运行命令…");
  });

  it("shows when Awen is turning actual command output into an article image", () => {
    const workflow: ToolWorkflowSnapshot = {
      workflowId: "workflow-1", status: "running", round: 3, userRequest: "capture output",
      transcript: [], toolResults: [], pendingPermission: null, finalText: null, warningCount: 0,
      events: [{ id: "tool", sequence: 1, type: "tool_started", at: "2026-09-28T00:00:00Z", message: "准备执行 practice_capture_command_output。", data: { toolId: "practice_capture_command_output" } }]
    };

    expect(getAwenWorkflowProgressMessage(workflow)).toBe("正在把本机命令的实际输出制成图片…");
  });

  it("loads practice capture images from the local API origin, including command output captures", () => {
    const workflow: ToolWorkflowSnapshot = {
      workflowId: "workflow-1", status: "completed", round: 1, userRequest: "capture output",
      transcript: [], pendingPermission: null, finalText: null, warningCount: 0, events: [],
      toolResults: [{
        callId: "call-1", toolId: "practice_capture_command_output",
        output: {
          title: "Scoop 已安装的 Java", url: "local-command-output:11111111-1111-4111-8111-111111111111",
          observedAt: "2026-09-28T00:00:00.000Z", observation: "corretto17-jdk 17.0.20.8.1",
          assetUrl: "./assets/11111111-1111-4111-8111-111111111111.png", screenshotSha256: "a".repeat(64),
          operationSummary: "根据本机命令输出生成展示图"
        }
      }]
    };
    const markup = renderToStaticMarkup(createElement(AwenToolWorkflowActivity, {
      workflow, projectId: "project-1", articlePath: "posts/Scoop管理Java/index.md", loading: false,
      onWorkflowPermission: () => undefined, onCancelWorkflow: () => undefined, onResumeWorkflow: () => undefined
    }));

    expect(markup).toContain("http://127.0.0.1:4317/api/content-source/article-resource?");
    expect(markup).toContain("path=posts%2FScoop%E7%AE%A1%E7%90%86Java%2Findex.md");
    expect(markup).toContain("src=.%2Fassets%2F11111111-1111-4111-8111-111111111111.png");
  });

  it("includes both the live action and activity shortcut in the conversation while loading", () => {
    const workflow: ToolWorkflowSnapshot = {
      workflowId: "workflow-1", status: "running", round: 2, userRequest: "run local command",
      transcript: [], toolResults: [], pendingPermission: null, finalText: null, warningCount: 0,
      events: [{ id: "tool", sequence: 1, type: "tool_started", at: "2026-09-28T00:00:00Z", message: "准备执行 practice_run_command。", data: { toolId: "practice_run_command" } }]
    };
    const props = {
      messages: [], memory: "", value: "", loading: true, workflow,
      unsavedSuggestionIds: new Set<string>(), savedSuggestionSyncPendingIds: new Set<string>(), pendingSuggestionCount: 0, pendingSuggestionReviewOpen: false, pendingSuggestionReviewBusy: false,
      bottomHeightPercent: 32, transcriptUserPercent: 34,
      onBottomHeightChange: () => undefined, onTranscriptUserPercentChange: () => undefined, onChange: () => undefined,
      onSend: () => undefined, onRetry: () => undefined, onAcceptSuggestion: () => undefined, onRejectSuggestion: () => undefined,
      onLocateSuggestion: () => undefined, onOpenMemoryManager: () => undefined, onRejectPendingAndContinue: () => undefined,
      onKeepPendingAndContinue: () => undefined, onCancelPendingSend: () => undefined, onOpenWorkflowActivity: () => undefined, onClose: () => undefined
    };
    const markup = renderToStaticMarkup(createElement(AwenBottomPanel, props));

    expect(markup).toContain("正在本机运行命令");
    expect(markup).toContain("查看执行活动");
  });

  it("shows that the article is saved when only suggestion metadata needs retry", () => {
    const messageId = "44444444-4444-4444-8444-444444444444";
    const props = {
      messages: [{
        id: messageId, role: "assistant" as const, content: "建议", memorySuggestion: "",
        suggestions: [{ original: "原段落", replacement: "补充段落", reason: "补充说明" }],
        createdAt: "2026-09-28T00:00:00.000Z"
      }],
      memory: "", value: "", loading: false, unsavedSuggestionIds: new Set<string>(),
      savedSuggestionSyncPendingIds: new Set([`${messageId}:0`]), pendingSuggestionCount: 0,
      pendingSuggestionReviewOpen: false, pendingSuggestionReviewBusy: false,
      bottomHeightPercent: 32, transcriptUserPercent: 34,
      onBottomHeightChange: () => undefined, onTranscriptUserPercentChange: () => undefined,
      onChange: () => undefined, onSend: () => undefined, onRetry: () => undefined,
      onAcceptSuggestion: () => undefined, onRejectSuggestion: () => undefined,
      onLocateSuggestion: () => undefined, onOpenMemoryManager: () => undefined,
      onRejectPendingAndContinue: () => undefined, onKeepPendingAndContinue: () => undefined,
      onCancelPendingSend: () => undefined, onOpenWorkflowActivity: () => undefined, onClose: () => undefined
    };

    const markup = renderToStaticMarkup(createElement(AwenBottomPanel, props));

    expect(markup).toContain("正文已保存，建议状态待同步；点击“保存文章”可重试");
    expect(markup).not.toContain("已应用到当前草稿，尚未保存");
  });
});

describe("practice drafting status labels", () => {
  const base: ArticlePracticeTask = {
    id: "task-1", projectId: "project-1", sourceType: "awen", legacyExecutionRunId: null,
    status: "drafting", goalRevision: 1, latestGoal: "按提纲准备正文", waitingReason: null, feedbackDeadline: null,
    checkpoint: {}, hasGaps: false, createdAt: "2026-09-26T09:06:38.276Z", updatedAt: "2026-09-26T09:07:00.360Z"
  };

  it("says no practice was needed when assessment goes straight to drafting", () => {
    const task = { ...base, events: [
      { sequence: 1, kind: "assessment_started", payload: {}, createdAt: "2026-09-26T09:06:38.276Z" },
      { sequence: 2, kind: "draft_started", payload: {}, createdAt: "2026-09-26T09:07:00.360Z" }
    ] };
    expect(getArticlePracticeDraftingLabel(task)).toBe("阿文判断无需实践，正在准备正文");
  });

  it("says practice completed only when an actual result was recorded", () => {
    const task = { ...base, events: [
      { sequence: 1, kind: "practice_started", payload: {}, createdAt: "2026-09-26T09:06:40.000Z" },
      { sequence: 2, kind: "practice_result", payload: {}, createdAt: "2026-09-26T09:07:00.000Z" }
    ] };
    expect(getArticlePracticeDraftingLabel(task)).toBe("实践已完成，正在准备正文");
  });

  it("does not call an attempted practice complete without a recorded result", () => {
    const task = { ...base, hasGaps: true, events: [
      { sequence: 1, kind: "practice_started", payload: {}, createdAt: "2026-09-26T09:06:40.000Z" }
    ] };
    expect(getArticlePracticeDraftingLabel(task)).toBe("实践未能完成，正在准备正文；相关结论将标待核查");
  });
});

describe("failed practice step recovery", () => {
  it("offers a targeted retry action and keeps the ordinary guidance action", () => {
    const task: ArticlePracticeTask = {
      id: "task-1", projectId: "project-1", sourceType: "awen", legacyExecutionRunId: null,
      status: "waiting_feedback", goalRevision: 1, latestGoal: "验证示例行为",
      waitingReason: "上一次运行失败", feedbackDeadline: "2026-09-25T00:05:00.000Z",
      checkpoint: { workflowId: "workflow-1" }, hasGaps: false,
      createdAt: "2026-09-25T00:00:00.000Z", updatedAt: "2026-09-25T00:00:00.000Z"
    };
    const markup = renderToStaticMarkup(createElement(ArticlePracticeTaskCard, {
      task, busy: false, onDecision: async () => {}, onOpenAwen: () => {}
    }));

    expect(markup).toContain("重试上次失败的步骤");
    expect(markup).toContain("告诉阿文如何处理");
    expect(RETRY_FAILED_PRACTICE_STEP_PROMPT).toContain("不要重新执行已经完成的步骤");
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

describe("Awen message delivery state", () => {
  it("shows an already submitted user message as sent while Awen is processing", () => {
    expect(getAwenDeliveryStateLabel({ role: "user", deliveryState: "sending" })).toBe("已发送，阿文正在处理…");
  });

  it("shows approval as execution in progress until Awen returns", () => {
    expect(getAwenDeliveryStateLabel({ role: "user", deliveryState: "authorized" })).toBe("已授权，阿文正在执行…");
  });

  it("shows when Awen is reconsidering the next step after an observation", () => {
    expect(getAwenDeliveryStateLabel({ role: "user", deliveryState: "authorized" }, "replanning")).toBe("已取得观察结果，阿文正在重新判断下一步…");
  });
});

describe("Awen completed response messages", () => {
  it("keeps the original user id and appends only one assistant response", () => {
    const user = { id: "user-1", role: "user" as const, content: "请执行", memorySuggestion: "", suggestions: [], createdAt: "1", deliveryState: "sending" as const };
    const assistant = { id: "assistant-1", role: "assistant" as const, content: "已完成", memorySuggestion: "", suggestions: [], createdAt: "2" };

    const completed = completeAwenAssistantResponse([user], assistant, user.id);

    expect(completed.map(({ id, role }) => ({ id, role }))).toEqual([
      { id: "user-1", role: "user" },
      { id: "assistant-1", role: "assistant" }
    ]);
    expect(new Set(completed.map((message) => message.id)).size).toBe(completed.length);
  });

  it("replaces the pending assistant response with the same id instead of rendering it twice", () => {
    const assistant = { id: "assistant-1", role: "assistant" as const, content: "新结果", memorySuggestion: "", suggestions: [], createdAt: "2" };
    const completed = completeAwenAssistantResponse([assistant], assistant);

    expect(completed).toEqual([assistant]);
  });

  it("finishes an already failed delivery when its workflow returns a concrete explanation", () => {
    const user: ArticleChatMessage = {
      id: "user-1", role: "user", content: "请运行本机命令", memorySuggestion: "", suggestions: [],
      createdAt: "2026-09-28T00:00:00.000Z", deliveryState: "failed"
    };
    const assistant: ArticleChatMessage = {
      id: "assistant-1", role: "assistant", content: "命令已运行；未能生成截图的原因是……",
      memorySuggestion: "", suggestions: [], createdAt: "2026-09-28T00:01:00.000Z"
    };

    expect(completeAwenAssistantResponse([user], assistant, user.id)).toEqual([
      { ...user, deliveryState: undefined },
      assistant
    ]);
  });
});

describe("Awen activity loading state", () => {
  it("does not present an old workflow while a new activity is being created", () => {
    expect(getAwenActivityEmptyMessage(true)).toBe("正在创建新的执行活动…");
    expect(getAwenActivityEmptyMessage(false)).toBe("阿文调用本地工具后，目标、权限、进度和结果会显示在这里。");
  });
});
