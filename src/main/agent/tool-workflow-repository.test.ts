import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../db/database";
import { ToolWorkflowRepository } from "./tool-workflow-repository";
import type { ToolWorkflowSnapshot } from "./tool-workflow-runner";

describe("ToolWorkflowRepository", () => {
  it("persists workflow snapshots and preserves the audit event chain", () => {
    const database = openInMemoryDatabase();
    const repository = new ToolWorkflowRepository(database.connection);
    const snapshot: ToolWorkflowSnapshot = {
      workflowId: "11111111-1111-4111-8111-111111111111",
      status: "waiting_user",
      round: 1,
      userRequest: "分析仓库",
      transcript: [{ role: "user", content: "分析仓库" }],
      events: [{ id: "event-1", type: "workflow_created", at: new Date().toISOString(), message: "created" }],
      toolResults: [],
      pendingPermission: { callId: "call-1", request: { toolId: "git_clone_source", action: "write", target: "D:/staging", input: { destination: "D:/staging" } }, permission: { decision: "ask", reason: "needs approval", matchedScope: null } },
      finalText: null,
      warningCount: 0
    };
    repository.save(snapshot, { contextKey: "source:posts/demo/index.md", request: { contextKey: "source:posts/demo/index.md", projectId: "project-1", message: "分析" } });
    const stored = repository.require(snapshot.workflowId);
    expect(stored.contextKey).toBe("source:posts/demo/index.md");
    expect(stored.snapshot.pendingPermission?.request.toolId).toBe("git_clone_source");
    expect(stored.snapshot.events[0]?.type).toBe("workflow_created");
    expect(stored.input?.message).toBe("分析");
    database.close();
  });

  it("marks active workflows interrupted after restart without replaying them", () => {
    const database = openInMemoryDatabase();
    const repository = new ToolWorkflowRepository(database.connection);
    const snapshot: ToolWorkflowSnapshot = {
      workflowId: "22222222-2222-4222-8222-222222222222",
      status: "running",
      round: 1,
      userRequest: "检查",
      transcript: [],
      events: [],
      toolResults: [],
      pendingPermission: null,
      finalText: null,
      warningCount: 0
    };
    repository.save(snapshot, { contextKey: "project:demo" });
    expect(repository.recoverInterrupted()).toBe(1);
    const recovered = repository.require(snapshot.workflowId).snapshot;
    expect(recovered.status).toBe("interrupted");
    expect(recovered.events.at(-1)).toMatchObject({ type: "workflow_interrupted", data: { previousStatus: "running" } });
    database.close();
  });

  it("preserves a new practice goal in an interrupted workflow until the user chooses to resume", () => {
    const database = openInMemoryDatabase();
    const repository = new ToolWorkflowRepository(database.connection);
    const snapshot: ToolWorkflowSnapshot = {
      workflowId: "44444444-4444-4444-8444-444444444444",
      status: "running",
      round: 1,
      userRequest: "原始验证",
      transcript: [{ role: "user", content: "原始验证" }],
      events: [],
      toolResults: [],
      pendingPermission: null,
      finalText: null,
      warningCount: 0
    };
    repository.save(snapshot, { contextKey: "project:demo", request: { projectId: "project-id", practiceTaskId: "task-id" } });
    repository.recoverInterrupted();

    const updated = repository.appendUserInstruction(snapshot.workflowId, "再验证边界条件");

    expect(updated.snapshot.status).toBe("interrupted");
    expect(updated.snapshot.transcript.at(-1)?.content).toContain("再验证边界条件");
    expect(updated.input).toMatchObject({ practiceTaskId: "task-id" });
    expect(updated.snapshot.events.at(-1)).toMatchObject({ type: "user_instruction_added" });
    database.close();
  });

  it("preserves the distinction between a restart and an existing cancel request", () => {
    const database = openInMemoryDatabase();
    const repository = new ToolWorkflowRepository(database.connection);
    const snapshot: ToolWorkflowSnapshot = {
      workflowId: "33333333-3333-4333-8333-333333333333",
      status: "cancel_requested",
      round: 1,
      userRequest: "取消分析",
      transcript: [],
      events: [],
      toolResults: [],
      pendingPermission: null,
      finalText: null,
      warningCount: 0
    };
    repository.save(snapshot, { contextKey: "project:demo" });
    expect(repository.recoverInterrupted()).toBe(1);
    expect(repository.require(snapshot.workflowId).snapshot.events.at(-1)).toMatchObject({
      type: "workflow_interrupted",
      data: { previousStatus: "cancel_requested" }
    });
    database.close();
  });

  it("reconstructs the consecutive no-progress guard from persisted workflow events", () => {
    const database = openInMemoryDatabase();
    const repository = new ToolWorkflowRepository(database.connection);
    const snapshot: ToolWorkflowSnapshot = {
      workflowId: "55555555-5555-4555-8555-555555555555",
      status: "interrupted",
      round: 3,
      userRequest: "检查命令结果",
      transcript: [],
      events: [
        { id: "one", type: "tool_completed", at: "2026-09-28T00:00:00.000Z", message: "空结果", data: { noProgress: true } },
        { id: "two", type: "tool_failed", at: "2026-09-28T00:00:01.000Z", message: "失败", data: { noProgress: true } }
      ],
      toolResults: [],
      pendingPermission: null,
      finalText: null,
      warningCount: 2
    };
    repository.save(snapshot, { contextKey: "project:demo" });

    expect(repository.require(snapshot.workflowId).snapshot.consecutiveNoProgressCalls).toBe(2);

    const progressed: ToolWorkflowSnapshot = {
      ...snapshot,
      events: [...snapshot.events, {
        id: "three", type: "tool_completed", at: "2026-09-28T00:00:02.000Z", message: "有效观察", data: { noProgress: false }
      }]
    };
    repository.save(progressed, { contextKey: "project:demo" });
    expect(repository.require(snapshot.workflowId).snapshot.consecutiveNoProgressCalls).toBe(0);
    database.close();
  });
});
