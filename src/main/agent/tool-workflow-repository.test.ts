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
});
