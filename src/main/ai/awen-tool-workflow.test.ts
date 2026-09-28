import { describe, expect, it } from "vitest";
import { createAwenToolWorkflowSession } from "./awen-tool-workflow";
import type { ModelProvider } from "./model-provider";
import type { SearchResultItem, WebSearchClient } from "./web-search";
import type { ContentProjectRepository } from "../content/content-project-repository";
import type { ContentSourceService } from "../content/content-source-service";
import type { GitSourceService } from "../agent/git-source-service";
import type { PermissionGrantRepository } from "../agent/permission-grant-repository";
import type { SystemToolRegistry } from "../agent/system-tool-registry";
import type { AwenPracticeCodeRunner } from "../agent/awen-practice-code-runner";
import type { AwenPracticeWebCapture } from "../agent/awen-practice-web-capture";
import type { AwenPracticeDemoCapture } from "../agent/awen-practice-demo-capture";
import type { AwenPracticeCommandRunner } from "../agent/awen-practice-command-runner";
import type { AwenPracticeProjectEditor } from "../agent/awen-practice-project-editor";
import type { ToolPermissionGrant } from "../agent/permission-policy";
import type { ToolWorkflowSnapshot } from "../agent/tool-workflow-runner";

describe("Awen tool workflow adapter", () => {
  it("requires a fresh project-file read fingerprint before proposing an authorized write", async () => {
    const observedSha256 = "a".repeat(64);
    let writtenInput: unknown;
    let capturedSchema: unknown;
    const services = createServices([
      { kind: "tool_calls", calls: [{ toolId: "practice_read_project_file", action: "read", input: { relativePath: "src/app.ts" } }] },
      { kind: "tool_calls", calls: [{ toolId: "practice_edit_project_file", action: "write", input: { relativePath: "src/app.ts", content: "export const value = 2;", expectedSha256: observedSha256 } }] },
      { kind: "final", text: JSON.stringify({ reply: "项目文件已按读取版本修改。", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }) }
    ], undefined, undefined, (request) => { capturedSchema = request.outputSchema; });
    services.contentProjects = { require: () => ({ practiceProjectDirectory: "C:/article-project" }) } as unknown as ContentProjectRepository;
    services.practiceProjectEditor = {
      read: () => ({ relativePath: "src/app.ts", content: "export const value = 1;", sha256: observedSha256 }),
      write: (_taskId: string, _projectId: string, input: unknown) => { writtenInput = input; return { unchanged: true, relativePath: "src/app.ts" }; }
    } as unknown as AwenPracticeProjectEditor;
    const session = createAwenToolWorkflowSession(services, {
      projectId: "project-id",
      prompt: "在关联项目中核对并修改示例",
      onPracticeTaskRequested: async () => "practice-task-id"
    });

    const pending = await session.start();
    expect(pending.status).toBe("waiting_user");
    expect(pending.pendingPermission?.request.toolId).toBe("practice_edit_project_file");
    expect(JSON.stringify(capturedSchema)).toContain("practice_read_project_file");
    expect(JSON.stringify(capturedSchema)).toContain("expectedSha256");

    const completed = await session.respond({ decision: "allow", scope: "task" });
    expect(completed.status).toBe("completed");
    expect(writtenInput).toMatchObject({ relativePath: "src/app.ts", expectedSha256: observedSha256 });
  });

  it("searches the dynamic tool inventory by name and returns no local install paths to the model", async () => {
    let selectedQuery = "";
    const services = createServices([
      { kind: "tool_calls", calls: [{ toolId: "list_system_tools", action: "read", input: { query: "scoop" } }] },
      { kind: "final", text: "已找到 scoop 命令入口。" }
    ]);
    services.systemTools = {
      async list(query?: string) {
        selectedQuery = query ?? "";
        return [{ id: "cli:scoop", command: "scoop", path: "D:\\Tools\\Scoop\\shims\\scoop.cmd", version: "未探测", capabilities: ["task_cli"] }];
      }
    } as unknown as SystemToolRegistry;

    const result = await createAwenToolWorkflowSession(services, { prompt: "查找 scoop 命令" }).start();

    expect(selectedQuery).toBe("scoop");
    const toolObservation = result.transcript.find((item) => item.role === "tool" && item.content.includes("scoop"));
    expect(toolObservation?.content).toContain("commands");
    expect(toolObservation?.content).not.toContain("D:\\Tools");
  });

  it("replans an unapproved legacy CLI request through the general command interface after restart", async () => {
    const commandRunner = {
      async validate(input: unknown) { return input as { command: string; args: string[] }; },
      getTarget(_projectId: string | undefined, _workflowId: string, command: string) { return `system-cli:${command}@practice`; }
    } as unknown as AwenPracticeCommandRunner;
    const snapshot: ToolWorkflowSnapshot = {
      workflowId: "legacy-workflow",
      status: "interrupted",
      round: 1,
      userRequest: "在本机运行 scoop list",
      transcript: [{ role: "user", content: "在本机运行 scoop list" }],
      events: [],
      toolResults: [],
      pendingPermission: { callId: "old-call", request: { toolId: "registered_cli_task", action: "write", target: "system-cli-task:scoop.list", input: { taskId: "scoop.list", parameters: {} } }, permission: { decision: "ask", reason: "等待授权", matchedScope: null } },
      finalText: null,
      warningCount: 0
    };
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "tool_calls", calls: [{ toolId: "practice_run_command", action: "write", input: { command: "scoop", args: ["list"] } }] }
    ], undefined, undefined, undefined, undefined, [], undefined, undefined, commandRunner), {
      prompt: snapshot.userRequest,
      onPracticeTaskRequested: async () => "task-id"
    });

    const restored = await session.restoreWaiting(snapshot);

    expect(restored.status).toBe("waiting_user");
    expect(restored.pendingPermission?.request.toolId).toBe("practice_run_command");
    expect(restored.transcript.some((item) => item.content.includes("没有执行"))).toBe(true);
  });

  it("offers a general installed CLI through structured arguments and requires task authorization", async () => {
    let inputSeen: unknown;
    let promptSeen = "";
    const commandRunner = {
      parseInput(input: unknown) { return input as { command: string; args: string[] }; },
      async validate(input: unknown) { return input as { command: string; args: string[] }; },
      getTarget(_projectId: string | undefined, _workflowId: string, command: string) { return `system-cli:${command.toLowerCase()}@practice`; },
      matchesCommandTarget(target: string | undefined, command: string) { return target === `system-cli:${command.toLowerCase()}@practice`; },
      async run(input: unknown) {
        inputSeen = input;
        return { status: "completed", exitCode: 0, stdout: "1.2.3", stderr: "", artifacts: [] };
      }
    } as unknown as AwenPracticeCommandRunner;
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "tool_calls", calls: [{ toolId: "practice_run_command", action: "read", input: { command: "scoop", args: ["search", "java"] } }] },
      { kind: "final", text: JSON.stringify({ reply: "查询完成。", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }) }
    ], undefined, undefined, (request) => { promptSeen = request.prompt ?? ""; }, undefined, [], undefined, undefined, commandRunner), {
      projectId: "project-id",
      prompt: "查询 Scoop 中 Java 相关包",
      onPracticeTaskRequested: async () => "practice-task-id"
    });

    const pending = await session.start();

    expect(pending.status).toBe("waiting_user");
    expect(pending.pendingPermission?.request.toolId).toBe("practice_run_command");
    expect(pending.pendingPermission?.request.action).toBe("read");
    expect(pending.pendingPermission?.request.target).toContain("system-cli:scoop@");
    expect(promptSeen).toContain("软件无需预先登记在源码中");
    expect(promptSeen).not.toContain("没有合适已登记能力");

    const result = await session.respond({ decision: "allow", scope: "task" });

    expect(result.status).toBe("completed");
    expect(inputSeen).toEqual({ command: "scoop", args: ["search", "java"] });
    expect(result.transcript.some((entry) => entry.role === "tool" && entry.content.includes("1.2.3"))).toBe(true);
  });

  it("tries a different public method after an empty CLI result without treating it as local evidence", async () => {
    const prompts: string[] = [];
    let searchCount = 0;
    const commandRunner = {
      async validate(input: unknown) { return input as { command: string; args: string[] }; },
      getTarget(_projectId: string | undefined, _workflowId: string, command: string) { return `system-cli:${command.toLowerCase()}@practice`; },
      matchesCommandTarget(target: string | undefined, command: string) { return target === `system-cli:${command.toLowerCase()}@practice`; },
      async run() { return { status: "completed", exitCode: 0, stdout: "", stderr: "", artifacts: [] }; }
    } as unknown as AwenPracticeCommandRunner;
    const webSearch: WebSearchClient = {
      activeProviderId: "test",
      async search() { searchCount += 1; return [{ title: "Public source", url: "https://example.com/catalog", snippet: "public catalog result" }]; },
      async extract() { return { content: "" }; }
    };
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "tool_calls", calls: [{ toolId: "practice_run_command", action: "read", input: { command: "java", args: ["-version"] } }] },
      { kind: "tool_calls", calls: [{ toolId: "web_search", action: "network_read", input: { query: "public Java package catalog" } }] },
      { kind: "final", goalAssessment: "incomplete", text: JSON.stringify({ reply: "本机命令没有输出，因此本机状态未确认；公开资料仅能提供远程信息。", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }) }
    ], webSearch, undefined, (request) => { if (request.prompt) prompts.push(request.prompt); }, undefined, [], undefined, undefined, commandRunner), {
      prompt: "核实一个本机工具查询目标，并在本机结果不足时判断其他可行方法",
      onPracticeTaskRequested: async () => "practice-task-id"
    });

    const pending = await session.start();
    expect(pending.status).toBe("waiting_user");
    const result = await session.respond({ decision: "allow", scope: "task" });

    expect(result.status, JSON.stringify(result.events)).toBe("incomplete");
    expect(searchCount).toBe(1);
    expect(prompts.filter((prompt) => prompt.includes("<tool-workflow-transcript>")).length).toBe(3);
    expect(prompts[1]).toContain("运行元数据不能作为目标结果");
    expect(prompts[1]).not.toContain("exitCode");
    expect(result.transcript.some((item) => item.role === "tool" && item.content.includes("public catalog result"))).toBe(true);
  });

  it("uses the workflow protocol without prepending the legacy assistant skill", async () => {
    const requests: Array<{ prependInstructions?: boolean; outputSchema?: unknown; prompt?: string }> = [];
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "final", text: JSON.stringify({ reply: "已完成", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }) }
    ], undefined, undefined, (request) => requests.push(request)), { prompt: "分析仓库" });

    await session.start();
    expect(requests[0]?.prependInstructions).toBe(false);
    expect(requests[0]?.prompt).toContain("工具状态 completed、进程退出码 0、或出现任何输出，都不单独代表目标完成");
    expect(requests[0]?.prompt).toContain("包括公开网页检索");
    expect(requests[0]?.prompt).toContain("不能把它冒充本机状态");
    expect(requests[0]?.prompt).toContain("goalAssessment");
    expect(requests[0]?.prompt).toContain("achieved");
    expect(requests[0]?.prompt).toContain("不能用历史会话中的旧结果替代本轮执行");
    expect(requests[0]?.prompt).toContain("本轮最新消息决定要回答的问题与统计口径");
    expect(requests[0]?.prompt).toContain("本机已安装清单");
    expect(requests[0]?.prompt).toContain("空的筛选/搜索结果只说明该次筛选没有匹配项");
    const schema = requests[0]?.outputSchema as { properties?: { calls?: { anyOf?: Array<{ items?: { anyOf?: Array<{ properties?: { input?: { type?: string; additionalProperties?: boolean; properties?: Record<string, unknown> } } }> } }> } } } | undefined;
    const callVariants = schema?.properties?.calls?.anyOf?.[0]?.items?.anyOf ?? [];
    expect(callVariants).toHaveLength(4);
    expect(callVariants.some((variant) => variant.properties?.input?.properties?.repositoryUrl)).toBe(true);
    expect(callVariants.every((variant) => variant.properties?.input?.type === "object" && variant.properties?.input?.additionalProperties === false)).toBe(true);
    assertStrictObjectSchemas(requests[0]?.outputSchema);
    assertEveryObjectPropertyIsRequired(requests[0]?.outputSchema);
  });

  it("keeps the optional webpage operation compatible with strict structured-output schemas", async () => {
    let outputSchema: unknown;
    const webCapture = { async capture() { return {}; } } as unknown as AwenPracticeWebCapture;
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "final", text: JSON.stringify({ reply: "无需网页操作", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }) }
    ], undefined, undefined, (request) => { if ((request.outputSchema as { properties?: { calls?: unknown } } | undefined)?.properties?.calls) outputSchema = request.outputSchema; }, undefined, [], webCapture), {
      projectId: "project-id",
      prompt: "判断是否需要网页实践"
    });

    await session.start();

    assertEveryObjectPropertyIsRequired(outputSchema);
    const root = outputSchema as { properties?: { calls?: { anyOf?: Array<{ items?: { anyOf?: Array<{ properties?: { toolId?: { enum?: string[] }; input?: { required?: string[]; properties?: Record<string, { anyOf?: unknown[] }> } } }> } }> } } };
    const webpageCall = root.properties?.calls?.anyOf?.[0]?.items?.anyOf?.find((variant) => variant.properties?.toolId?.enum?.includes("practice_capture_webpage"));
    expect(webpageCall?.properties?.input?.required).toContain("operation");
    expect(webpageCall?.properties?.input?.properties?.operation?.anyOf).toContainEqual({ type: "null" });
  });

  it("automatically runs a low-risk web search before the final answer", async () => {
    const searches: string[] = [];
    const webSearch: WebSearchClient = {
      activeProviderId: "test",
      async search(query: string): Promise<SearchResultItem[]> {
        searches.push(query);
        return [{ title: "Result", url: "https://example.com", snippet: "bounded result" }];
      },
      async extract() { return { content: "" }; }
    };
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "tool_calls", calls: [{ toolId: "web_search", action: "network_read", input: { query: "ContentFerry" } }] },
      { kind: "final", text: JSON.stringify({ reply: "已核验", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }) }
    ], webSearch), { prompt: "核验 ContentFerry" });

    const result = await session.start();
    expect(result.status).toBe("completed");
    expect(searches).toEqual(["ContentFerry"]);
    expect(result.transcript.some((item) => item.role === "tool" && item.content.includes("example.com"))).toBe(true);
  });

  it("blocks a different tool when the author explicitly retries one failed practice step", async () => {
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "tool_calls", calls: [{ toolId: "web_search", action: "network_read", input: { query: "unrelated" } }] }
    ]), {
      projectId: "project-id", practiceTaskId: "practice-task-id", practiceIntentMode: "chat",
      practiceStepRetry: { failedToolId: "practice_run_code", completedToolIds: ["list_system_tools"] },
      prompt: "只重试失败的代码运行步骤"
    });

    const result = await session.start();

    expect(result.status).toBe("failed");
    expect(result.events.some((event) => event.type === "tool_started")).toBe(false);
    expect(result.events.at(-1)?.message).toContain("只允许重新规划上一次失败的步骤");
  });

  it("allows only one invocation of the failed tool across the retry workflow", async () => {
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "tool_calls", calls: [{ toolId: "list_system_tools", action: "read", input: { query: "python" } }] },
      { kind: "tool_calls", calls: [{ toolId: "list_system_tools", action: "read", input: { query: "python" } }] }
    ]), {
      projectId: "project-id", practiceTaskId: "practice-task-id", practiceIntentMode: "chat",
      practiceStepRetry: { failedToolId: "list_system_tools", completedToolIds: [] },
      prompt: "只重试失败的工具步骤"
    });

    const result = await session.start();

    expect(result.status).toBe("failed");
    expect(result.events.filter((event) => event.type === "tool_started")).toHaveLength(1);
    expect(result.events.filter((event) => event.type === "tool_completed")).toHaveLength(1);
    expect(result.events.at(-1)?.message).toContain("只允许重新规划上一次失败的步骤");
  });

  it("captures a public webpage inside the article practice task and returns its Markdown asset", async () => {
    let taskRequests = 0;
    let captureUrl = "";
    let captureOperation = "";
    const webCapture = {
      async capture(input: { url: string; operation?: { kind: string; query?: string } }, context: { practiceTaskId?: string }) {
        captureUrl = input.url;
        captureOperation = input.operation?.kind ?? "open";
        expect(context.practiceTaskId).toBe("practice-task-id");
        return { title: "Demo", url: input.url, observedAt: "2026-09-25T00:00:00.000Z", observation: "可见结果", assetUrl: "./assets/capture.png", screenshotMarkdown: "![验证截图](./assets/capture.png)", screenshotSha256: "a".repeat(64), operationSummary: "执行站内搜索" };
      }
    } as unknown as AwenPracticeWebCapture;
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "tool_calls", calls: [{ toolId: "practice_capture_webpage", action: "network_read", target: "https://example.com", input: { url: "https://example.com/demo", caption: "验证截图", operation: { kind: "search", query: "ContentFerry" } } }] },
      { kind: "final", text: JSON.stringify({ reply: "页面验证完成", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }) }
    ], undefined, undefined, undefined, undefined, [], webCapture), {
      projectId: "project-id",
      prompt: "验证公开 demo",
      onPracticeTaskRequested: async () => { taskRequests += 1; return "practice-task-id"; }
    });

    const result = await session.start();
    expect(result.status).toBe("completed");
    expect(taskRequests).toBe(1);
    expect(captureUrl).toBe("https://example.com/demo");
    expect(captureOperation).toBe("search");
    expect(result.transcript.some((item) => item.role === "tool" && item.content.includes("./assets/capture.png"))).toBe(true);
  });

  it("captures a local Demo only from the current task workspace and stores the image in article assets", async () => {
    let capturePath = "";
    let captureTarget = "";
    const demoCapture = {
      getWorkflowDirectory: () => "C:/Temp/practice/workflow",
      async capture(input: { relativePath: string; caption: string }, context: { practiceTaskId?: string; target?: string }) {
        capturePath = input.relativePath;
        captureTarget = context.target ?? "";
        expect(context.practiceTaskId).toBe("practice-task-id");
        return { title: "本地演示", url: "local-demo:demo/index.html", observedAt: "2026-09-26T00:00:00.000Z", observation: "按钮显示已连接", assetUrl: "./assets/demo.png", screenshotMarkdown: "![本地演示](./assets/demo.png)", screenshotSha256: "b".repeat(64), operationSummary: "打开本地 Demo 窗口并截取可见结果" };
      }
    } as unknown as AwenPracticeDemoCapture;
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "tool_calls", calls: [{ toolId: "practice_capture_demo", action: "write", input: { relativePath: "demo/index.html", caption: "本地演示" } }] },
      { kind: "final", text: JSON.stringify({ reply: "本地界面显示已连接。", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }) }
    ], undefined, undefined, undefined, undefined, [{ scope: "task", decision: "allow", toolId: "practice_capture_demo", action: "write", projectId: "project-id", targetPrefix: "C:/Temp/practice/workflow" }], undefined, demoCapture), {
      projectId: "project-id",
      prompt: "验证本地 Demo 的显示结果",
      onPracticeTaskRequested: async () => "practice-task-id"
    });

    const pending = await session.start();
    expect(pending.status).toBe("waiting_user");
    const result = await session.respond({ decision: "allow", scope: "task" });
    expect(capturePath).toBe("demo/index.html");
    expect(captureTarget).toBe("C:/Temp/practice/workflow");
    expect(result.transcript.some((item) => item.role === "tool" && item.content.includes("./assets/demo.png"))).toBe(true);
  });

  it("offers an explicitly requested command output image from the same task workspace", async () => {
    let received: unknown;
    let taskRequests = 0;
    const demoCapture = {
      getWorkflowDirectory: () => "C:/Temp/practice/workflow",
      async captureCommandOutput(input: unknown, context: { target?: string; practiceTaskId?: string }) {
        received = { input, target: context.target, practiceTaskId: context.practiceTaskId };
        return { title: "scoop list", url: "local-command-output:123e4567-e89b-12d3-a456-426614174000", observedAt: "2026-09-28T00:00:00.000Z", observation: "corretto11-jdk", assetUrl: "./assets/123e4567-e89b-12d3-a456-426614174001.png", screenshotMarkdown: "![scoop list](./assets/123e4567-e89b-12d3-a456-426614174001.png)", screenshotSha256: "c".repeat(64), operationSummary: "根据本次命令实际输出生成终端样式页面并截取；非操作系统终端窗口截图。" };
      }
    } as unknown as AwenPracticeDemoCapture;
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "tool_calls", calls: [{ toolId: "practice_capture_command_output", action: "write", input: { runId: "123e4567-e89b-12d3-a456-426614174000", label: "scoop list", caption: "本机已安装的 Java 包" } }] },
      { kind: "final", text: JSON.stringify({ reply: "本机清单列出一个 Java 包。", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }) }
    ], undefined, undefined, undefined, undefined, [], undefined, demoCapture), {
      projectId: "project-id",
      prompt: "把刚才的本机命令输出截成图片",
      onPracticeTaskRequested: async () => { taskRequests += 1; return "practice-task-id"; }
    });

    const waiting = await session.start();
    expect(waiting.status).toBe("waiting_user");
    expect(waiting.pendingPermission?.request.toolId).toBe("practice_capture_command_output");
    const completed = await session.respond({ decision: "allow", scope: "task" });

    expect(taskRequests).toBe(1);
    expect(received).toEqual({
      input: { runId: "123e4567-e89b-12d3-a456-426614174000", label: "scoop list", caption: "本机已安装的 Java 包" },
      target: "C:/Temp/practice/workflow",
      practiceTaskId: "practice-task-id"
    });
    expect(completed.transcript.some((item) => item.role === "tool" && item.content.includes("./assets/123e4567-e89b-12d3-a456-426614174001.png"))).toBe(true);
  });

  it("records a new practice request without running it when the current task is paused", async () => {
    let executed = false;
    const codeRunner = {
      getWorkflowDirectory: () => "C:/Temp/practice/workflow",
      async run() { executed = true; return { status: "completed", stdout: "done" }; }
    } as unknown as AwenPracticeCodeRunner;
    const modelTurns: string[][] = [];
    const services = createServices([
      { kind: "tool_calls", calls: [{ toolId: "practice_run_code", action: "write", input: { runtime: "node", code: "console.log('check')" } }] },
      { kind: "final", text: JSON.stringify({ reply: "已记录；当前等待处理的事项完成后再继续。", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }) }
    ], undefined, undefined, undefined, codeRunner);
    const originalGenerate = services.provider.generateStructured.bind(services.provider);
    services.provider.generateStructured = async (request) => {
      modelTurns.push((request.prompt.match(/<tool-workflow-transcript>[\s\S]*?<\/tool-workflow-transcript>/u)?.[0] ?? "").split("\n"));
      return originalGenerate(request);
    };
    const session = createAwenToolWorkflowSession(services, {
      projectId: "project-id",
      prompt: "请验证新补充的边界",
      onPracticeTaskRequested: async () => ({
        practiceTaskId: "practice-task-id",
        deferMessage: "新目标已记录；请先处理已有授权请求，当前步骤不会重复运行。"
      })
    });

    const result = await session.start();
    expect(result.status).toBe("completed");
    expect(executed).toBe(false);
    expect(result.events.some((event) => event.type === "tool_deferred")).toBe(true);
    expect(modelTurns[1]?.join("\n")).toContain("当前步骤不会重复运行");
  });

  it("holds generated code until the user authorizes its temporary task folder", async () => {
    let executed = 0;
    let capturedTarget = "";
    const workspace = "C:/Users/test/AppData/Local/Temp/contentferry-practice/project/workflow";
    const codeRunner = {
      getWorkflowDirectory: () => workspace,
      async run(input: unknown, context: { target?: string; authorization?: { confirmed: boolean } }) {
        executed += 1;
        capturedTarget = context.target ?? "";
        expect((input as { runtime: string }).runtime).toBe("node");
        expect(context.authorization?.confirmed).toBe(true);
        return { status: "completed", stdout: "verified" };
      }
    } as unknown as AwenPracticeCodeRunner;
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "tool_calls", calls: [{ toolId: "practice_run_code", action: "write", target: "C:/outside", input: { runtime: "node", code: "console.log('verified')" } }] },
      { kind: "final", text: JSON.stringify({ reply: "示例已运行", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }) }
    ], undefined, undefined, undefined, codeRunner), { projectId: "project-id", prompt: "验证这个示例" });

    const waiting = await session.start();
    expect(waiting.status).toBe("waiting_user");
    expect(waiting.pendingPermission?.request.toolId).toBe("practice_run_code");
    expect(waiting.pendingPermission?.request.action).toBe("write");
    expect(waiting.pendingPermission?.request.target).toBe(workspace);
    expect(executed).toBe(0);

    await expect(session.respond({ decision: "allow", scope: "project" })).rejects.toThrow();
    expect(executed).toBe(0);

    const completed = await session.respond({ decision: "allow", scope: "task" });
    expect(completed.status).toBe("completed");
    expect(executed).toBe(1);
    expect(capturedTarget).toBe(workspace);
  });

  it("does not let saved project or run grants authorize Awen code execution", async () => {
    const workspace = "C:/Users/test/AppData/Local/Temp/contentferry-practice/project/workflow";
    const codeRunner = { getWorkflowDirectory: () => workspace, async run() { throw new Error("must wait"); } } as unknown as AwenPracticeCodeRunner;
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "tool_calls", calls: [{ toolId: "practice_run_code", action: "write", input: { runtime: "python", code: "print('example')" } }] }
    ], undefined, undefined, undefined, codeRunner, [
      { scope: "project", decision: "allow", toolId: "practice_run_code", action: "write", projectId: "project-id", targetPrefix: workspace },
      { scope: "run", decision: "allow", toolId: "practice_run_code", action: "write", projectId: "project-id", targetPrefix: workspace }
    ]), { projectId: "project-id", prompt: "运行示例" });

    const waiting = await session.start();
    expect(waiting.status).toBe("waiting_user");
    expect(waiting.pendingPermission?.request.target).toBe(workspace);
  });

  it("removes required null placeholders before invoking a tool", async () => {
    const searches: string[] = [];
    const webSearch: WebSearchClient = {
      activeProviderId: "test",
      async search(query: string): Promise<SearchResultItem[]> {
        searches.push(query);
        return [];
      },
      async extract() { return { content: "" }; }
    };
    const session = createAwenToolWorkflowSession(createServices([
      {
        kind: "tool_calls",
        text: null,
        calls: [{
          toolId: "web_search",
          action: "network_read",
          target: null,
          input: {
            query: "ContentFerry",
            relativePath: null,
            repositoryUrl: null,
            destination: null,
            ref: null,
            networkPolicy: null,
            allowedHosts: null,
            paths: null,
            maxLinesPerFile: null
          }
        }]
      },
      { kind: "final", goalAssessment: "incomplete", text: JSON.stringify({ reply: "检索没有匹配结果，当前证据不足以核验。", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }), calls: null }
    ], webSearch), { prompt: "核验 ContentFerry" });

    const result = await session.start();
    expect(result.status, JSON.stringify(result.events)).toBe("incomplete");
    expect(searches).toEqual(["ContentFerry"]);
  });

  it("validates and executes author-edited code parameters only after explicit authorization", async () => {
    let captured: unknown;
    const codeRunner = {
      getWorkflowDirectory: () => "C:/Users/test/AppData/Local/Temp/practice/workflow",
      async run(input: unknown) { captured = input; return { status: "completed", stdout: "edited" }; }
    } as unknown as AwenPracticeCodeRunner;
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "tool_calls", calls: [{ toolId: "practice_run_code", action: "write", input: { runtime: "node", code: "console.log('original')" } }] },
      { kind: "final", text: JSON.stringify({ reply: "完成", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }) }
    ], undefined, undefined, undefined, codeRunner), { projectId: "project-id", prompt: "运行示例" });

    const waiting = await session.start();
    expect(waiting.status).toBe("waiting_user");
    await expect(session.respond({ decision: "allow", scope: "run", input: { runtime: "bash", code: "echo unsafe" } })).rejects.toThrow();
    expect(captured).toBeUndefined();
    expect(session.runner.getSnapshot(waiting.workflowId).status).toBe("waiting_user");

    const completed = await session.respond({ decision: "allow", scope: "run", input: { runtime: "python", code: "print('edited')" } });
    expect(completed.status).toBe("completed");
    expect(captured).toEqual({ runtime: "python", code: "print('edited')" });
    expect(completed.events.find((event) => event.type === "permission_decided")?.data?.parametersEdited).toBe(true);
  });

  it("pauses a high-risk Git operation and continues only after authorization", async () => {
    let cloneCalls = 0;
    const gitSources = { clone: async () => { cloneCalls += 1; return { commitSha: "abc" }; } } as unknown as GitSourceService;
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "tool_calls", calls: [{ toolId: "git_clone_source", action: "write", target: "D:/staging/repo", input: { repositoryUrl: "https://github.com/example/repo", destination: "D:/staging/repo", networkPolicy: "direct" } }] },
      { kind: "final", text: JSON.stringify({ reply: "源码已固定", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }) }
    ], undefined, gitSources), { prompt: "分析仓库" });

    const waiting = await session.start();
    expect(waiting.status).toBe("waiting_user");
    expect(cloneCalls).toBe(0);
    const completed = await session.respond({ decision: "allow", scope: "run" });
    expect(completed.status).toBe("completed");
    expect(cloneCalls).toBe(1);
  });

  it("does not let an older project grant authorize a high-impact Git action in Awen", async () => {
    let cloneCalls = 0;
    const gitSources = { clone: async () => { cloneCalls += 1; return { commitSha: "abc" }; } } as unknown as GitSourceService;
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "tool_calls", calls: [{ toolId: "git_clone_source", action: "write", target: "D:/staging/repo", input: { repositoryUrl: "https://github.com/example/repo", destination: "D:/staging/repo", networkPolicy: "direct" } }] },
      { kind: "final", text: JSON.stringify({ reply: "源码已固定", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }) }
    ], undefined, gitSources, undefined, undefined, [
      { scope: "global", decision: "allow", toolId: "git_clone_source", action: "write" },
      { scope: "project", decision: "allow", toolId: "git_clone_source", action: "write", projectId: "project-id", targetPrefix: "D:/staging" },
      { scope: "run", decision: "allow", toolId: "git_clone_source", action: "write", projectId: "project-id", targetPrefix: "D:/staging/repo" }
    ]), { projectId: "project-id", prompt: "分析仓库" });

    const waiting = await session.start();
    expect(waiting.status).toBe("waiting_user");
    expect(cloneCalls).toBe(0);
    const completed = await session.respond({ decision: "allow", scope: "task" });
    expect(completed.status).toBe("completed");
    expect(cloneCalls).toBe(1);
  });

  it("supplies a controlled staging destination when the user did not specify one", async () => {
    let cloneDestination = "";
    const gitSources = {
      createAwenStagingDestination: () => "D:/contentferry-staging/skills-123",
      clone: async (input: unknown) => {
        cloneDestination = (input as { destination: string }).destination;
        return { commitSha: "abc" };
      }
    } as unknown as GitSourceService;
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "tool_calls", calls: [{ toolId: "git_clone_source", action: "write", input: { repositoryUrl: "https://github.com/mattpocock/skills.git", networkPolicy: "direct" } }] },
      { kind: "final", text: JSON.stringify({ reply: "源码已固定", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }) }
    ], undefined, gitSources), { prompt: "git clone Matt Pocock Skills" });

    const waiting = await session.start();
    expect(waiting.status).toBe("waiting_user");
    expect(waiting.pendingPermission?.request.target).toBe("D:/contentferry-staging/skills-123");
    const completed = await session.respond({ decision: "allow", scope: "run" });
    expect(completed.status).toBe("completed");
    expect(cloneDestination).toBe("D:/contentferry-staging/skills-123");
  });

  it("trusts the configured Awen workspace without a second directory prompt", async () => {
    const workspace = "D:/contentferry-awen-workspace";
    let cloneCalls = 0;
    const gitSources = {
      getAwenWorkspaceRootPath: () => workspace,
      assertAwenWorkspacePath: () => undefined,
      clone: async () => { cloneCalls += 1; return { commitSha: "abc" }; }
    } as unknown as GitSourceService;
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "tool_calls", calls: [{ toolId: "git_clone_source", action: "write", target: `${workspace}/git-sources/repo`, input: { repositoryUrl: "https://github.com/example/repo", destination: `${workspace}/git-sources/repo`, networkPolicy: "direct" } }] },
      { kind: "final", text: JSON.stringify({ reply: "源码已固定", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }) }
    ], undefined, gitSources), { prompt: "分析仓库" });

    const result = await session.start();
    expect(result.status).toBe("completed");
    expect(cloneCalls).toBe(1);
  });

  it("keeps a completed Git side effect audited when the final reply is malformed", async () => {
    const workspace = "D:/contentferry-awen-workspace";
    let cloneCalls = 0;
    const gitSources = {
      getAwenWorkspaceRootPath: () => workspace,
      assertAwenWorkspacePath: () => undefined,
      clone: async () => { cloneCalls += 1; return { commitSha: "abc" }; }
    } as unknown as GitSourceService;
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "tool_calls", calls: [{ toolId: "git_clone_source", action: "write", target: `${workspace}/git-sources/repo`, input: { repositoryUrl: "https://github.com/example/repo", destination: `${workspace}/git-sources/repo`, networkPolicy: "direct" } }] },
      { kind: "final", text: "clone 已完成，但这里不是 JSON" },
      { kind: "final", text: JSON.stringify({ reply: "源码已固定，正在继续处理。", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }) }
    ], undefined, gitSources), { prompt: "git clone 仓库" });

    const result = await session.start();
    expect(cloneCalls).toBe(1);
    expect(result.status).toBe("completed");
    expect(result.toolResults).toHaveLength(1);
    expect(result.finalText).toContain("源码已固定");
    expect(result.events.map((event) => event.type)).toEqual(expect.arrayContaining(["tool_completed", "model_output_repair_requested", "workflow_completed"]));
  });

  it("does not execute a shell command hidden inside a final answer", async () => {
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "final", text: "可以执行：git clone https://github.com/mattpocock/skills.git" },
      { kind: "final", text: "可以执行：git clone https://github.com/mattpocock/skills.git" },
      { kind: "final", text: "可以执行：git clone https://github.com/mattpocock/skills.git" }
    ], undefined, {
      createAwenStagingDestination: () => "D:/contentferry-staging/skills-456",
      clone: async () => ({ commitSha: "abc" })
    } as unknown as GitSourceService), { prompt: "git clone 一下 Matt Pocock Skills" });

    const result = await session.start();
    expect(result.status).toBe("failed");
    expect(result.toolResults).toHaveLength(0);
    expect(result.events.at(-1)?.message).toContain("最终回复不是有效 JSON");
  });
});

function assertStrictObjectSchemas(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertStrictObjectSchemas);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.type === "object") expect(record.additionalProperties).toBe(false);
  Object.values(record).forEach(assertStrictObjectSchemas);
}

function assertEveryObjectPropertyIsRequired(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertEveryObjectPropertyIsRequired);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.type === "object") {
    const properties = record.properties as Record<string, unknown> | undefined;
    const required = record.required as string[] | undefined;
    expect(required ?? []).toEqual(Object.keys(properties ?? {}));
  }
  Object.values(record).forEach(assertEveryObjectPropertyIsRequired);
}

function createServices(
  turns: unknown[],
  webSearch?: WebSearchClient,
  gitSources?: GitSourceService,
  onRequest?: (request: { prependInstructions?: boolean; outputSchema?: unknown; prompt?: string }) => void,
  practiceCodeRunner?: AwenPracticeCodeRunner,
  grants: ToolPermissionGrant[] = [],
  practiceWebCapture?: AwenPracticeWebCapture,
  practiceDemoCapture?: AwenPracticeDemoCapture,
  practiceCommandRunner?: AwenPracticeCommandRunner
) {
  let index = 0;
  const provider: ModelProvider = {
    id: "test",
    async generateStructured<T>(request: { parse(value: unknown): T; prependInstructions?: boolean; outputSchema?: unknown; prompt?: string }): Promise<{ value: T; provider: string; model: string | null; usage: null }> {
      onRequest?.(request);
      if (request.prompt?.includes("你是与执行阿文分开的完成条件验证器")) {
        const incompleteAssessment = request.prompt.includes("<candidate-final goalAssessment=incomplete>");
        const requestText = request.prompt.match(/<author-request>\s*([\s\S]*?)\s*<\/author-request>/u)?.[1]?.trim() ?? "作者请求";
        const rawToolText = request.prompt.match(/\[原始工具观察\]\n([\s\S]*?)\n<candidate-final/u)?.[1] ?? "";
        const toolQuote = rawToolText.match(/\[[^\]]+\]\s*(.+)/u)?.[1]?.trim();
        const evidence = [
          { source: "request", quote: requestText.slice(0, 80) },
          ...(!incompleteAssessment && toolQuote ? [{ source: "tool", quote: toolQuote.slice(0, 80) }] : [])
        ];
        return { value: request.parse({ decision: incompleteAssessment ? "incomplete" : "verified", reason: incompleteAssessment ? "测试目标明确标为证据不足。" : "测试验证器确认请求范围符合测试预期。", nextStep: null, evidence }), provider: "test", model: "test-model", usage: null };
      }
      return { value: request.parse(turns[index++]), provider: "test", model: "test-model", usage: null };
    },
    async webResearch() { throw new Error("not used"); }
  };
  return {
    provider,
    webSearch,
    systemTools: { list: async () => [] } as unknown as SystemToolRegistry,
    contentSources: {} as ContentSourceService,
    contentProjects: {} as ContentProjectRepository,
    permissionGrants: { list: () => grants } as unknown as PermissionGrantRepository,
    gitSources: gitSources ?? ({} as GitSourceService),
    practiceCodeRunner,
    practiceWebCapture,
    practiceDemoCapture,
    practiceCommandRunner
  };
}
