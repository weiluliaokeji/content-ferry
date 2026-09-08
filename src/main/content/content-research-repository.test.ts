import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../db/database";
import { ContentResearchRepository, normalizeResearchUrl } from "./content-research-repository";

describe("ContentResearchRepository", () => {
  it("normalizes tracking-only URL differences", () => {
    expect(normalizeResearchUrl("HTTPS://EXAMPLE.COM:443/docs/?utm_source=x#intro"))
      .toBe("https://example.com/docs");
    expect(normalizeResearchUrl("manual://local-note")).toBe("manual://local-note");
  });

  it("does not store duplicate sources during save or follow-up append", () => {
    const database = openInMemoryDatabase();
    try {
      const now = new Date().toISOString();
      database.connection.prepare("INSERT INTO workspaces (id, display_name, created_at) VALUES (?, ?, ?)").run("workspace-1", "测试工作区", now);
      database.connection.prepare("INSERT INTO content_projects (id, workspace_id, topic, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("project-1", "workspace-1", "测试", now, now);
      const repository = new ContentResearchRepository(database.connection);
      repository.save("project-1", {
        planMarkdown: "初次补研",
        sources: [
          { title: "文档", url: "https://example.com/docs/?utm_source=one", excerpt: "事实", keyClaims: ["主张"], sourceType: "official" },
          { title: "文档（重复）", url: "https://example.com/docs#section", excerpt: "重复", keyClaims: ["重复"], sourceType: "public" }
        ]
      });
      const appended = repository.append("project-1", {
        planMarkdown: "补充结论",
        sources: [
          { title: "文档（再次重复）", url: "https://example.com/docs/", excerpt: "重复", keyClaims: ["重复"], sourceType: "official" },
          { title: "新文档", url: "https://example.com/other?gclid=abc", excerpt: "新事实", keyClaims: ["新主张"], sourceType: "public" }
        ]
      });
      expect(appended.sources.map((source) => source.url)).toEqual([
        "https://example.com/other",
        "https://example.com/docs"
      ]);
    } finally {
      database.close();
    }
  });

  it("does not add a manually entered URL that is already a source card", () => {
    const database = openInMemoryDatabase();
    try {
      const now = new Date().toISOString();
      database.connection.prepare("INSERT INTO workspaces (id, display_name, created_at) VALUES (?, ?, ?)").run("workspace-2", "测试工作区", now);
      database.connection.prepare("INSERT INTO content_projects (id, workspace_id, topic, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("project-2", "workspace-2", "测试", now, now);
      const repository = new ContentResearchRepository(database.connection);
      repository.save("project-2", { planMarkdown: "已有", sources: [{ title: "已有来源", url: "https://example.com/page?utm_campaign=x", excerpt: "事实", keyClaims: ["主张"], sourceType: "official" }] });
      const result = repository.addManual("project-2", { title: "手工重复", url: "https://example.com/page", excerpt: "重复", keyClaims: ["重复"] });
      expect(result.sources).toHaveLength(1);
      expect(result.sources[0].title).toBe("已有来源");
    } finally {
      database.close();
    }
  });

  it("rejects unsafe manual source URL schemes", () => {
    const database = openInMemoryDatabase();
    try {
      const now = new Date().toISOString();
      database.connection.prepare("INSERT INTO workspaces (id, display_name, created_at) VALUES (?, ?, ?)").run("workspace-unsafe", "测试工作区", now);
      database.connection.prepare("INSERT INTO content_projects (id, workspace_id, topic, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("project-unsafe", "workspace-unsafe", "测试", now, now);
      const repository = new ContentResearchRepository(database.connection);
      expect(() => repository.addManual("project-unsafe", { title: "危险链接", url: "javascript:alert(1)", excerpt: "内容", keyClaims: [] })).toThrow("HTTP(S)");
    } finally {
      database.close();
    }
  });

  it("keeps execution provenance on an experimental research card", () => {
    const database = openInMemoryDatabase();
    try {
      const now = new Date().toISOString();
      database.connection.prepare("INSERT INTO workspaces (id, display_name, created_at) VALUES (?, ?, ?)").run("workspace-3", "测试工作区", now);
      database.connection.prepare("INSERT INTO content_projects (id, workspace_id, topic, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("project-3", "workspace-3", "测试", now, now);
      database.connection.prepare(`INSERT INTO execution_runs (id, project_id, request_json, preflight_json, status, created_at)
        VALUES (?, ?, ?, ?, 'completed', ?)`)
        .run("run-3", "project-3", JSON.stringify({ runtime: "python", args: ["demo.py"], networkPolicy: "disabled" }), JSON.stringify({ targetType: "host_trusted", executable: "python", warnings: [] }), now);
      const repository = new ContentResearchRepository(database.connection);
      const result = repository.addExecutionObservation("project-3", {
        observationId: "observation-3",
        executionRunId: "run-3",
        title: "运行结果",
        claim: "示例执行成功。",
        artifacts: [],
        provenance: {
          kind: "execution_observation", executionRunId: "run-3", observationId: "observation-3", status: "pending",
          targetType: "host_trusted", runtime: "python", command: ["python", "demo.py"], networkPolicy: "disabled", artifacts: []
        }
      });
      expect(result.sources[0].provenance?.executionRunId).toBe("run-3");
      expect(result.sources[0].excerpt).toContain("仅适用于记录的目标");
    } finally {
      database.close();
    }
  });
});
