import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../db/database";
import { ExecutionRepository } from "./execution-repository";
import type { ExecutionRequest } from "./execution-service";

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
});
