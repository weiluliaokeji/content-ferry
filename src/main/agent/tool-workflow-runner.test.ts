import { describe, expect, it, vi } from "vitest";
import { ToolRunner } from "./tool-runner";
import { ToolWorkflowRunner, type ModelTurn } from "./tool-workflow-runner";
import { ToolWorkflowRepository } from "./tool-workflow-repository";
import { openInMemoryDatabase } from "../db/database";

function policy() {
  return {
    projectId: "article-1",
    grants: [],
    defaultAllowReadOnly: true,
    resolveRisk: () => "low" as const
  };
}

describe("tool workflow runner", () => {
  it("runs an in-scope read and then returns the model result", async () => {
    const run = vi.fn(async (input: unknown) => ({ value: input }));
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "echo", action: "read", input: "hello" }] },
      { kind: "final", text: "done" }
    ]);
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "echo", run }]), model);

    const result = await workflow.start("check", policy());

    expect(result.status).toBe("completed");
    expect(run).toHaveBeenCalledWith("hello", expect.any(Object));
    expect(result.toolResults[0]?.toolId).toBe("echo");
    expect(result.events.some((event) => event.type === "tool_completed")).toBe(true);
    expect(result.events.find((event) => event.type === "workflow_completed")?.message).toContain("已结束本轮并返回答复");
  });

  it("does not rerun a successfully completed identical tool request", async () => {
    const run = vi.fn(async () => ({ stdout: "first observation" }));
    let verificationCount = 0;
    const verifyCompletion = vi.fn(async () => ({
      decision: verificationCount++ === 0 ? "continue" as const : "incomplete" as const,
      reason: "工具观察仍不足以回答目标。",
      evidence: [{ source: "tool" as const, quote: "first observation" }]
    }));
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "echo", action: "read", input: { query: "java" } }] },
      { kind: "final", text: "观察到的内容不足，正在尝试下一种办法。", goalAssessment: "achieved" },
      { kind: "tool_calls", calls: [{ toolId: "echo", action: "read", input: { query: "java" } }] },
      { kind: "final", text: "目前证据不足，结论待核查。", goalAssessment: "incomplete" }
    ]);
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "echo", run }]), { ...model, verifyCompletion }, { maxRounds: 4 });

    const result = await workflow.start("统计目标", { ...policy(), requireCompletionVerification: true });

    expect(run).toHaveBeenCalledTimes(1);
    expect(result.events.some((event) => event.type === "tool_duplicate_blocked")).toBe(true);
    expect(result.transcript.some((message) => message.content.includes("相同调用"))).toBe(true);
    expect(result.status).toBe("incomplete");
  });

  it("grounds verifier citations against raw multiline tool output", async () => {
    const rawOutput = "Java packages:\ncorretto11-jdk\ncorretto17-jdk";
    const run = vi.fn(async () => ({ stdout: rawOutput }));
    const verifyCompletion = vi.fn(async (input: { toolResults: Array<{ output: unknown }> }) => {
      expect(input.toolResults).toHaveLength(1);
      return {
        decision: "verified" as const,
        reason: "引用与原始观察一致。",
        evidence: [{ source: "tool" as const, quote: "corretto11-jdk\ncorretto17-jdk" }]
      };
    });
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "echo", action: "read", input: {} }] },
      { kind: "final", text: "观察到两个包。", goalAssessment: "achieved" }
    ]);
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "echo", run }]), { ...model, verifyCompletion });

    const result = await workflow.start("列出 Java 包", { ...policy(), requireCompletionVerification: true });

    expect(result.status).toBe("completed");
    expect(result.events.some((event) => event.type === "goal_verification_passed")).toBe(true);
  });

  it("marks a final answer with an unmet goal as completed with warnings", async () => {
    const workflow = new ToolWorkflowRunner(new ToolRunner([]), sequenceModel([
      { kind: "final", text: "本机命令成功启动，但没有返回目标所需的数据。", goalAssessment: "incomplete" }
    ]));

    const result = await workflow.start("统计目标数据", policy());

    expect(result.status).toBe("completed_with_warnings");
    expect(result.warningCount).toBe(1);
    expect(result.events.at(-1)?.message).toContain("目标尚未达成");
  });

  it("defers a proposed tool without executing it, then lets the model respond", async () => {
    const run = vi.fn(async () => ({ value: "ran" }));
    const modelInputs: Array<{ transcript: Array<{ role: string; content: string }> }> = [];
    const model = {
      async next(input: { transcript: Array<{ role: string; content: string }> }): Promise<ModelTurn> {
        modelInputs.push(input);
        return modelInputs.length === 1
          ? { kind: "tool_calls", calls: [{ toolId: "echo", action: "read", input: "check" }] }
          : { kind: "final", text: "已记录并等待选择" };
      }
    };
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "echo", run }]), model);
    const result = await workflow.start("请验证新的目标", {
      ...policy(),
      onToolProposed: async () => ({ practiceTaskId: "task-id", deferMessage: "目标已记录，需先处理当前选择。" })
    });

    expect(result.status).toBe("completed");
    expect(run).not.toHaveBeenCalled();
    expect(result.events.some((event) => event.type === "tool_deferred")).toBe(true);
    expect(modelInputs[1]?.transcript.at(-1)?.content).toContain("需先处理当前选择");
  });

  it("adds a new goal to a workflow waiting on user authorization", async () => {
    const run = vi.fn(async () => ({ value: "authorized" }));
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "echo", action: "write", target: "workspace/file", input: "write" }] },
      { kind: "final", text: "继续了新增目标" }
    ]);
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "echo", run }]), model);
    const waiting = await workflow.start("原始请求", { ...policy(), resolveRisk: () => "high" });
    expect(waiting.status).toBe("waiting_user");
    const updated = workflow.appendUserInstruction(waiting.workflowId, "再验证另一个边界");
    expect(updated.transcript.at(-1)?.content).toContain("再验证另一个边界");

    const completed = await workflow.respondToPermission(waiting.workflowId, { decision: "allow", scope: "run" });
    expect(completed.status).toBe("completed");
    expect(completed.transcript.some((item) => item.role === "user" && item.content.includes("再验证另一个边界"))).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("replans instead of executing a model plan generated before a new goal arrived", async () => {
    const run = vi.fn(async () => ({ value: "must not run" }));
    let returnFirstPlan: ((value: ModelTurn) => void) | undefined;
    let workflowId: string | undefined;
    const modelInputs: Array<{ transcript: Array<{ role: string; content: string }> }> = [];
    const model = {
      async next(input: { workflowId: string; transcript: Array<{ role: string; content: string }> }): Promise<ModelTurn> {
        workflowId = input.workflowId;
        modelInputs.push(input);
        if (modelInputs.length === 1) return await new Promise<ModelTurn>((resolve) => { returnFirstPlan = resolve; });
        return { kind: "final", text: "已按新要求重新规划" };
      }
    };
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "echo", run }]), model);
    const started = workflow.start("原验证", policy());
    await Promise.resolve();
    if (!workflowId) throw new Error("工作流尚未进入模型规划。" );
    workflow.appendUserInstruction(workflowId, "新增边界验证");
    returnFirstPlan?.({ kind: "tool_calls", calls: [{ toolId: "echo", action: "write", input: "old plan" }] });

    const result = await started;
    expect(result.status).toBe("completed");
    expect(run).not.toHaveBeenCalled();
    expect(result.events.some((event) => event.type === "model_plan_superseded")).toBe(true);
    expect(modelInputs[1]?.transcript.at(-1)?.content).toContain("新增边界验证");
  });

  it("pauses before an unapproved call and resumes after a one-run grant", async () => {
    const run = vi.fn(async () => "ok");
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", target: "D:/work", input: { text: "x" } }] },
      { kind: "final", text: "done" }
    ]);
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), model);
    const waiting = await workflow.start("save", { ...policy(), defaultAllowReadOnly: false });

    expect(waiting.status).toBe("waiting_user");
    expect(run).not.toHaveBeenCalled();
    const completed = await workflow.respondToPermission(waiting.workflowId, { decision: "allow", scope: "run" });
    expect(completed.status).toBe("completed");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reuses a task grant for matching calls in the same workflow", async () => {
    const run = vi.fn(async () => "ok");
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", target: "D:/work", input: {} }] },
      { kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", target: "D:/work", input: {} }] },
      { kind: "final", text: "done" }
    ]);
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), model);
    const waiting = await workflow.start("save", { ...policy(), defaultAllowReadOnly: false });
    const completed = await workflow.respondToPermission(waiting.workflowId, { decision: "allow", scope: "task" });

    expect(completed.status).toBe("completed");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not execute a denied call and lets the model replan", async () => {
    const danger = vi.fn(async () => "should-not-run");
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "danger", action: "delete", target: "D:/work", input: {} }] },
      { kind: "tool_calls", calls: [{ toolId: "echo", action: "read", input: "safe" }] },
      { kind: "final", text: "replanned" }
    ]);
    const workflow = new ToolWorkflowRunner(new ToolRunner([
      { id: "danger", run: danger },
      { id: "echo", run: async (input: unknown) => input }
    ]), model);
    const result = await workflow.start("delete old file", { ...policy(), grants: [{ scope: "global", decision: "deny", toolId: "danger" }] });

    expect(result.status).toBe("completed_with_warnings");
    expect(danger).not.toHaveBeenCalled();
    expect(result.events.some((event) => event.type === "tool_denied")).toBe(true);
  });

  it("rejects direct and nested model-controlled permission fields", async () => {
    const run = vi.fn(async () => "should-not-run");
    const direct = new ToolWorkflowRunner(new ToolRunner([{ id: "echo", run }]), { next: async () => ({ kind: "tool_calls", confirmed: true, calls: [] }) });
    const nested = new ToolWorkflowRunner(new ToolRunner([{ id: "echo", run }]), { next: async () => ({ kind: "tool_calls", calls: [{ toolId: "echo", action: "read", input: { options: { confirmed: true } } }] }) });

    expect((await direct.start("run", policy())).status).toBe("failed");
    expect((await nested.start("run", policy())).status).toBe("failed");
    expect(run).not.toHaveBeenCalled();
  });

  it("does not reuse a one-run grant for a later identical call", async () => {
    const run = vi.fn(async () => "ok");
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", target: "D:/work", input: {} }] },
      { kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", target: "D:/work", input: {} }] },
      { kind: "final", text: "done" }
    ]);
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), model);
    const waiting = await workflow.start("save", { ...policy(), defaultAllowReadOnly: false });
    const secondWaiting = await workflow.respondToPermission(waiting.workflowId, { decision: "allow", scope: "run" });

    expect(secondWaiting.status).toBe("waiting_user");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("blocks an identical tool request after an empty observation and feeds the reason back to planning", async () => {
    const run = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "cli", action: "read", target: "host:cli", input: { command: "nvm", args: ["list"] } }] },
      { kind: "tool_calls", calls: [{ toolId: "cli", action: "read", target: "host:cli", input: { command: "nvm", args: ["list"] } }] },
      { kind: "final", text: "No local result; use another method or report the limitation." }
    ]);
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "cli", run }]), model);

    const result = await workflow.start("list local versions", policy());

    expect(run).toHaveBeenCalledTimes(1);
    expect(result.events.map((event) => event.type)).toContain("tool_duplicate_blocked");
    expect(result.transcript.some((message) => message.content.includes("没有产生可用观察"))).toBe(true);
    expect(result.status).toBe("completed_with_warnings");
  });

  it("returns the known blocker after distinct retries produce no new observations", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ stdout: "corretto11-jdk\ncorretto17-jdk\ncorretto21-jdk\ncorretto8-jdk" })
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "" });
    const blocker = "当前没有能截取终端输出并插入文章的工具；Scoop 清单已经取得，但截图要求未完成。";
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "cli", action: "read", input: { command: "scoop", args: ["list"] } }] },
      { kind: "final", text: JSON.stringify({ reply: "本机列出 4 个 Java 包。", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }), goalAssessment: "achieved" },
      { kind: "tool_calls", calls: [{ toolId: "catalog", action: "read", input: { query: "terminal screenshot" } }] },
      { kind: "tool_calls", calls: [{ toolId: "catalog", action: "read", input: { query: "capture command window" } }] },
      { kind: "final", text: "不应再调用模型" }
    ]);
    const verifyCompletion = vi.fn(async () => ({ decision: "continue" as const, reason: blocker, nextStep: "查找可用的终端截图能力。", evidence: [{ source: "tool" as const, quote: "corretto11-jdk" }] }));
    const workflow = new ToolWorkflowRunner(new ToolRunner([
      { id: "cli", run },
      { id: "catalog", async run() { return { items: [] }; } }
    ]), { ...model, verifyCompletion }, { maxRounds: 8 });

    const result = await workflow.start("运行 scoop list，统计本机 Java 并截图放入文章", {
      ...policy(), requireCompletionVerification: true
    });

    expect(result.status).toBe("incomplete");
    expect(result.round).toBeLessThan(8);
    expect(result.toolResults[0]?.output).toEqual({ stdout: "corretto11-jdk\ncorretto17-jdk\ncorretto21-jdk\ncorretto8-jdk" });
    expect(result.finalText).toContain("本机列出 4 个 Java 包。");
    expect(result.finalText).toContain(blocker);
    expect(result.events.at(-1)).toMatchObject({ type: "workflow_incomplete", message: expect.stringContaining(blocker) });
  });

  it("keeps the no-progress cutoff across workflow resume", async () => {
    const run = vi.fn(async () => ({ items: [] }));
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "catalog", action: "read", input: { query: "java" } }] }
    ]);
    const runner = new ToolWorkflowRunner(new ToolRunner([{ id: "catalog", run }]), model);
    const snapshot = {
      workflowId: "workflow-resume-no-progress",
      status: "interrupted" as const,
      round: 1,
      userRequest: "获取可用的 Java 清单",
      transcript: [{ role: "user" as const, content: "获取可用的 Java 清单" }],
      events: [],
      toolResults: [],
      pendingPermission: null,
      finalText: null,
      warningCount: 1,
      consecutiveNoProgressCalls: 1
    };

    const result = await runner.resumeInterrupted(snapshot, policy());

    expect(run).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("incomplete");
    expect(result.consecutiveNoProgressCalls).toBe(2);
    expect(result.finalText).toContain("连续 2 次");
  });

  it("does not accept request metadata as verified evidence when a tool returned no observation", async () => {
    let verificationCount = 0;
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "cli", action: "read", input: { command: "nvm", args: ["list"] } }] },
      { kind: "final", text: "There are no Node versions.", goalAssessment: "achieved" },
      { kind: "final", text: "No usable local output was captured; result is unverified.", goalAssessment: "incomplete" }
    ]);
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "cli", async run() { return { command: "nvm", args: ["list"], exitCode: 0, stdout: "" }; } }]), {
      ...model,
      verifyCompletion: async () => verificationCount++ === 0
        ? { decision: "verified", reason: "引用了命令字段。", evidence: [{ source: "tool", quote: "nvm" }] }
        : { decision: "incomplete", reason: "观察为空。", evidence: [{ source: "request", quote: "List local Node versions" }] }
    }, { maxRounds: 4 });
    const snapshot = await workflow.start("List local Node versions", {
      ...policy(),
      requireCompletionVerification: true,
      resolveRisk: () => "low",
    });

    expect(verificationCount, JSON.stringify(snapshot)).toBe(2);
    expect(snapshot.status).toBe("incomplete");
    expect(snapshot.events.some((event) => event.type === "goal_verification_continued")).toBe(true);
  });

  it("records safe lifecycle progress with replayable monotonic event cursors", async () => {
    let workflowId = "";
    let continueModel: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const workflow = new ToolWorkflowRunner(new ToolRunner([]), {
      async next(input) {
        workflowId = input.workflowId;
        signalStarted?.();
        input.onProgress?.("已连接模型，开始处理任务…");
        await new Promise<void>((resolve) => { continueModel = resolve; });
        return { kind: "final", text: "done" };
      }
    });
    const running = workflow.start("check", policy());
    await started;
    const received: number[] = [];
    workflow.subscribe(workflowId, (event) => received.push(event.sequence ?? 0));
    continueModel?.();
    const snapshot = await running;

    expect(snapshot.events.some((event) => event.type === "progress" && event.message.includes("已连接模型"))).toBe(true);
    expect(received.length).toBeGreaterThan(0);
    expect(received).toEqual([...received].sort((left, right) => left - right));
  });

  it("does not let callers mutate a live snapshot", async () => {
    const input = { command: "read", nested: { value: 1 } };
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", async run() { return "ok"; } }]), { next: async () => ({ kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", input }] }) });
    const waiting = await workflow.start("run", { ...policy(), defaultAllowReadOnly: false });
    (waiting.pendingPermission?.request.input as typeof input).nested.value = 99;
    waiting.transcript[0].content = "changed";
    waiting.events[0].message = "changed";

    const snapshot = workflow.getSnapshot(waiting.workflowId);
    expect((snapshot.pendingPermission?.request.input as typeof input).nested.value).toBe(1);
    expect(snapshot.transcript[0]?.content).toBe("run");
  });

  it("rejects concurrent permission responses instead of executing twice", async () => {
    let releaseModel: (() => void) | undefined;
    const run = vi.fn(async () => "ok");
    let round = 0;
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), {
      next: async () => {
        round += 1;
        if (round === 1) return { kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", input: {} }] };
        return new Promise<ModelTurn>((resolve) => { releaseModel = () => resolve({ kind: "final", text: "done" }); });
      }
    });
    const waiting = await workflow.start("save", { ...policy(), defaultAllowReadOnly: false });
    const first = workflow.respondToPermission(waiting.workflowId, { decision: "allow", scope: "run" });
    await Promise.resolve();
    await expect(workflow.respondToPermission(waiting.workflowId, { decision: "allow", scope: "run" })).rejects.toThrow();
    releaseModel?.();
    expect((await first).status).toBe("completed");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("cancels a waiting workflow without invoking the adapter", async () => {
    const run = vi.fn(async () => "should-not-run");
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), { next: async () => ({ kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", input: {} }] }) });
    const waiting = await workflow.start("save", { ...policy(), defaultAllowReadOnly: false });
    expect(workflow.cancel(waiting.workflowId).status).toBe("cancelled");
    expect(run).not.toHaveBeenCalled();
    await expect(workflow.respondToPermission(waiting.workflowId, { decision: "allow", scope: "run" })).rejects.toThrow();
  });

  it("propagates cancellation to a running adapter and does not continue planning", async () => {
    let workflowId = "";
    let adapterStarted: (() => void) | undefined;
    const run = vi.fn(async (_input: unknown, context: { signal?: AbortSignal }) => {
      adapterStarted?.();
      return new Promise<string>((resolve) => context.signal?.addEventListener("abort", () => resolve("stopped"), { once: true }));
    });
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "read", run }]), {
      next: async (input: { workflowId: string }) => {
        workflowId = input.workflowId;
        return { kind: "tool_calls" as const, calls: [{ toolId: "read", action: "read" as const, input: {} }] };
      }
    });
    const started = new Promise<void>((resolve) => { adapterStarted = resolve; });
    const running = workflow.start("read", policy());
    await started;
    expect(workflow.cancel(workflowId).status).toBe("cancel_requested");
    expect((await running).status).toBe("cancelled");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("restores an interrupted pending permission without replaying the tool", async () => {
    const run = vi.fn(async () => "ok");
    const first = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), { next: async () => ({ kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", target: "D:/work", input: {} }] }) });
    const waiting = await first.start("save", { ...policy(), defaultAllowReadOnly: false });
    const second = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), { next: async () => ({ kind: "final" as const, text: "done" }) });
    const restored = await second.restoreWaiting({ ...waiting, status: "interrupted" }, { ...policy(), defaultAllowReadOnly: false });

    expect(restored.status).toBe("waiting_user");
    expect(run).not.toHaveBeenCalled();
    expect((await second.respondToPermission(restored.workflowId, { decision: "allow", scope: "run" })).status).toBe("completed");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reuses a matching task grant after explicit restart continuation", async () => {
    const run = vi.fn(async () => "ok");
    const database = openInMemoryDatabase();
    try {
      const now = new Date().toISOString();
      database.connection.prepare("INSERT INTO workspaces (id, display_name, created_at) VALUES (?, ?, ?)").run("workspace", "test", now);
      database.connection.prepare("INSERT INTO content_projects (id, workspace_id, topic, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run("article-1", "workspace", "task grant recovery", now, now);
      const repository = new ToolWorkflowRepository(database.connection);
      const first = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), sequenceModel([
        { kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", target: "D:/work", input: {} }] },
        { kind: "final", text: "first step done" }
      ]));
      const waiting = await first.start("save", { ...policy(), defaultAllowReadOnly: false, practiceTaskId: "task-id" });
      const completed = await first.respondToPermission(waiting.workflowId, { decision: "allow", scope: "task" });
      expect(completed.status).toBe("completed");
      repository.save(completed, { contextKey: "project:article-1", projectId: "article-1", request: { practiceTaskId: "task-id" } });

      // A second application process loads only the durable database snapshot.
      const persisted = repository.require(completed.workflowId).snapshot;
      const snapshot = { ...persisted, status: "interrupted" as const, finalText: null };
      const resumed = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), sequenceModel([
        { kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", target: "D:/work/subfile", input: {} }] },
        { kind: "final", text: "resumed" }
      ]));
      const result = await resumed.resumeInterrupted(snapshot, { ...policy(), defaultAllowReadOnly: false, practiceTaskId: "task-id" });

      expect(result.status).toBe("completed");
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
    }
  });

  it("does not extend a restored task grant beyond its saved target", async () => {
    const run = vi.fn(async () => "ok");
    const first = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", target: "D:/work", input: {} }] },
      { kind: "final", text: "saved" }
    ]));
    const waiting = await first.start("save", { ...policy(), defaultAllowReadOnly: false, practiceTaskId: "task-id" });
    const completed = await first.respondToPermission(waiting.workflowId, { decision: "allow", scope: "task" });
    const snapshot = {
      ...completed,
      status: "interrupted" as const,
      finalText: null,
      pendingPermission: {
        callId: "pending-call",
        request: { toolId: "write-file", action: "write" as const, target: "D:/outside", input: {} },
        permission: { decision: "ask" as const, reason: "需确认", matchedScope: null }
      }
    };
    const resumed = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), { next: async () => ({ kind: "final", text: "done" }) });
    const restored = await resumed.restoreWaiting(snapshot, { ...policy(), defaultAllowReadOnly: false, practiceTaskId: "task-id" });

    expect(restored.status).toBe("waiting_user");
    expect(restored.pendingPermission?.request.target).toBe("D:/outside");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("continues a matching pending request after the author chooses to resume", async () => {
    const run = vi.fn(async () => "ok");
    const first = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", target: "D:/work", input: {} }] },
      { kind: "final", text: "saved" }
    ]));
    const waiting = await first.start("save", { ...policy(), defaultAllowReadOnly: false, practiceTaskId: "task-id" });
    const completed = await first.respondToPermission(waiting.workflowId, { decision: "allow", scope: "task" });
    const snapshot = {
      ...completed,
      status: "interrupted" as const,
      finalText: null,
      pendingPermission: {
        callId: "pending-call",
        request: { toolId: "write-file", action: "write" as const, target: "D:/work/subfile", input: {} },
        permission: { decision: "ask" as const, reason: "需确认", matchedScope: null }
      }
    };
    const resumed = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), { next: async () => ({ kind: "final", text: "done" }) });
    const result = await resumed.restoreWaiting(snapshot, { ...policy(), defaultAllowReadOnly: false, practiceTaskId: "task-id" });

    expect(result.status).toBe("completed");
    expect(result.events.some((event) => event.type === "permission_decided" && event.data?.resumed === true)).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

function sequenceModel(turns: ModelTurn[]): { next: (input: { round: number }) => Promise<ModelTurn> } {
  let index = 0;
  return {
    async next() {
      const turn = turns[index] ?? turns.at(-1);
      if (!turn) throw new Error("missing test turn");
      index += 1;
      return turn;
    }
  };
}
