import { describe, expect, it, vi } from "vitest";
import { ToolRunner } from "./tool-runner";
import { ToolWorkflowRunner, type ModelTurn } from "./tool-workflow-runner";

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
    const restored = second.restoreWaiting({ ...waiting, status: "interrupted" }, { ...policy(), defaultAllowReadOnly: false });

    expect(restored.status).toBe("waiting_user");
    expect(run).not.toHaveBeenCalled();
    expect((await second.respondToPermission(restored.workflowId, { decision: "allow", scope: "run" })).status).toBe("completed");
    expect(run).toHaveBeenCalledTimes(1);
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
