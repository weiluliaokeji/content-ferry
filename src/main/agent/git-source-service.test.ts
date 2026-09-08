import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExecutionService } from "./execution-service";
import { ExecutionRepository } from "./execution-repository";
import { openInMemoryDatabase } from "../db/database";
import { GitSourceService } from "./git-source-service";

describe("GitSourceService", () => {
  it("builds a structured shallow clone request without shell text", () => {
    const database = openInMemoryDatabase();
    try {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-git-source-"));
      const service = new GitSourceService(new ExecutionService(), new ExecutionRepository(database.connection));
      const request = service.toExecutionRequest({ repositoryUrl: "https://github.com/example/repo", destination: path.join(root, "repo"), ref: "main", networkPolicy: "direct" });
      expect(request.args).toEqual(["clone", "--no-tags", "--filter=blob:none", "--depth=1", "--branch", "main", "https://github.com/example/repo", path.join(root, "repo")]);
      expect(request.args.some((arg) => arg.includes("&&") || arg.includes("|"))).toBe(false);
    } finally { database.close(); }
  });

  it("rejects embedded credentials and unsafe refs", () => {
    const database = openInMemoryDatabase();
    try {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-git-source-"));
      const service = new GitSourceService(new ExecutionService(), new ExecutionRepository(database.connection));
      expect(() => service.toExecutionRequest({ repositoryUrl: "https://user:secret@example.com/repo", destination: path.join(root, "repo"), networkPolicy: "direct" })).toThrow("凭据");
      expect(() => service.toExecutionRequest({ repositoryUrl: "https://github.com/example/repo", destination: path.join(root, "repo"), ref: "main && del", networkPolicy: "direct" })).toThrow("不允许");
    } finally { database.close(); }
  });

  it("rejects private Git endpoints and query-string credentials", () => {
    const database = openInMemoryDatabase();
    try {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-git-source-"));
      const service = new GitSourceService(new ExecutionService(), new ExecutionRepository(database.connection));
      expect(() => service.toExecutionRequest({ repositoryUrl: "https://127.0.0.1/repo", destination: path.join(root, "repo"), networkPolicy: "direct" })).toThrow("公开 HTTPS");
      expect(() => service.toExecutionRequest({ repositoryUrl: "https://[::ffff:7f00:1]/repo", destination: path.join(root, "mapped-repo"), networkPolicy: "direct" })).toThrow("公开 HTTPS");
      expect(() => service.toExecutionRequest({ repositoryUrl: "https://[::]/repo", destination: path.join(root, "unspecified-repo"), networkPolicy: "direct" })).toThrow("公开 HTTPS");
      expect(() => service.toExecutionRequest({ repositoryUrl: "https://github.com/example/repo?token=secret", destination: path.join(root, "repo"), networkPolicy: "direct" })).toThrow("公开 HTTPS");
    } finally { database.close(); }
  });
});
