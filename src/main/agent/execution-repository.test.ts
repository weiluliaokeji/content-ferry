import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../db/database";
import { ExecutionRepository } from "./execution-repository";
import type { ExecutionRequest } from "./execution-service";
import { ContentProjectRepository } from "../content/content-project-repository";

describe("ExecutionRepository", () => {
  it("persists a run and its artifact hashes", () => {
    const database = openInMemoryDatabase();
    const repository = new ExecutionRepository(database.connection);
    const request: ExecutionRequest = {
      targetType: "host_trusted", runtime: "node", args: ["-e", ""], cwd: "C:\\work",
      directoryGrants: [{ path: "C:\\work", access: "write" }], networkPolicy: "disabled", confirmed: true,
      acknowledgeHostRisk: true
    };
    const preflight = { available: true, targetType: "host_trusted" as const, executable: "node", resolvedCwd: "C:\\work", warnings: [] };
    const id = repository.create(request, preflight);
    repository.finish(id, { id: "runner-id", status: "completed", exitCode: 0, signal: null, stdout: "ok", stderr: "", truncated: false, durationMs: 1, artifacts: [{ path: "out.txt", size: 2, sha256: "hash" }], preflight });
    const record = repository.require(id);
    expect(record.status).toBe("completed");
    expect(record.request.confirmed).toBeUndefined();
    expect(record.artifacts[0]?.sha256).toBe("hash");
    database.close();
  });

  it("marks unfinished runs interrupted on restart", () => {
    const database = openInMemoryDatabase();
    const repository = new ExecutionRepository(database.connection);
    const request: ExecutionRequest = {
      targetType: "host_trusted", runtime: "node", args: ["-e", ""], cwd: "C:\\work",
      directoryGrants: [{ path: "C:\\work", access: "read" }], networkPolicy: "disabled", confirmed: true,
      acknowledgeHostRisk: true
    };
    const preflight = { available: true, targetType: "host_trusted" as const, executable: "node", resolvedCwd: "C:\\work", warnings: [] };
    const id = repository.create(request, preflight);
    expect(repository.recoverInterrupted()).toBe(1);
    expect(repository.require(id).status).toBe("interrupted");
    database.close();
  });

  it("returns safe summaries for legacy article history and scopes detailed output to its project", () => {
    const database = openInMemoryDatabase();
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    database.connection.prepare("INSERT INTO workspaces (id, display_name, created_at) VALUES (?, ?, ?)")
      .run(workspaceId, "test", new Date().toISOString());
    const project = new ContentProjectRepository(database.connection).create({ workspaceId, topic: "test", sourceRelativePath: "posts/test.md" });
    const repository = new ExecutionRepository(database.connection);
    const request: ExecutionRequest = {
      projectId: project.id, workflowId: "22222222-2222-4222-8222-222222222222", practiceTaskId: "33333333-3333-4333-8333-333333333333",
      targetType: "host_trusted", runtime: "node", args: ["-e", "sensitive code"], cwd: "C:\\private\\project",
      directoryGrants: [{ path: "C:\\private\\project", access: "write" }], networkPolicy: "disabled", confirmed: true
    };
    const preflight = { available: true, targetType: "host_trusted" as const, executable: "node", resolvedCwd: "C:\\private\\project", warnings: [] };
    const id = repository.create(request, preflight);
    repository.finish(id, { id: "runner-id", status: "completed", exitCode: 0, signal: null, stdout: "visible only on demand", stderr: "", truncated: false, durationMs: 1, artifacts: [{ path: "out.txt", size: 2, sha256: "hash" }], preflight });
    database.connection.prepare(`INSERT INTO experimental_observations
      (id, project_id, execution_run_id, title, claim, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run("observation", project.id, id, "旧实验观察", "旧观察仍可回看。", "2026-09-20T10:00:00Z", "2026-09-20T10:00:00Z");

    const summary = repository.listHistorySummaries(project.id)[0];
    expect(summary).toMatchObject({ id, projectId: project.id, runtime: "node", targetType: "host_trusted", workflowId: request.workflowId, practiceTaskId: request.practiceTaskId, status: "completed", artifactCount: 1 });
    expect(summary).not.toHaveProperty("cwd");
    expect(summary).not.toHaveProperty("args");
    expect(summary).not.toHaveProperty("stdout");
    expect(repository.historyDetails(project.id, id)).toMatchObject({
      stdout: "visible only on demand", artifacts: [{ path: "out.txt", sha256: "hash" }],
      observation: { id: "observation", title: "旧实验观察", claim: "旧观察仍可回看。", status: "pending" }
    });
    expect(() => repository.historyDetails("44444444-4444-4444-8444-444444444444", id)).toThrow("不属于当前文章项目");
    database.close();
  });
});
