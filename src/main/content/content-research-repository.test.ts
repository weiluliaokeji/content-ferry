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

  it("keeps author adoption decisions separate from AI recommendations", () => {
    const database = openInMemoryDatabase();
    try {
      const now = new Date().toISOString();
      database.connection.prepare("INSERT INTO workspaces (id, display_name, created_at) VALUES (?, ?, ?)").run("workspace-adoption", "测试工作区", now);
      database.connection.prepare("INSERT INTO content_projects (id, workspace_id, topic, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("project-adoption", "workspace-adoption", "测试", now, now);
      const repository = new ContentResearchRepository(database.connection);
      const created = repository.save("project-adoption", { planMarkdown: "结论", sources: [{ title: "AI 推荐", url: "https://example.com/recommended", excerpt: "事实", keyClaims: ["主张"], sourceType: "official" }] });
      expect(created.sources[0]).toMatchObject({ adoptionStatus: "recommended", selected: false });
      const pending = repository.updateAdoption("project-adoption", created.sources[0].id, "pending_verification");
      expect(pending.sources[0]).toMatchObject({ adoptionStatus: "pending_verification", selected: false });
      const adopted = repository.updateAdoption("project-adoption", created.sources[0].id, "adopted");
      expect(adopted.sources[0]).toMatchObject({ adoptionStatus: "adopted", selected: true });
    } finally { database.close(); }
  });

  it("splits and merges homogeneous sources without losing author adoption", () => {
    const database = openInMemoryDatabase();
    try {
      const now = new Date().toISOString();
      database.connection.prepare("INSERT INTO workspaces (id, display_name, created_at) VALUES (?, ?, ?)").run("workspace-merge", "测试工作区", now);
      database.connection.prepare("INSERT INTO content_projects (id, workspace_id, topic, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("project-merge", "workspace-merge", "测试", now, now);
      const repository = new ContentResearchRepository(database.connection);
      const created = repository.save("project-merge", { planMarkdown: "结论", sources: [{
        title: "合并资料", url: "https://example.com/one", excerpt: "事实", keyClaims: ["主张"], sourceType: "public", evidence: {
          claim: "同一主张", recommendation: "便于对比", qualityReason: "正文可核验", freshness: "当前", boundary: "仅供参考", kind: "review",
          sourceUrls: ["https://example.com/one", "https://example.com/two"], snapshots: [
            { url: "https://example.com/one", excerpt: "一", capturedAt: now, sha256: "a".repeat(64) },
            { url: "https://example.com/two", excerpt: "二", capturedAt: now, sha256: "b".repeat(64) }
          ]
        }
      }] });
      const adopted = repository.updateAdoption("project-merge", created.sources[0].id, "adopted");
      const split = repository.split("project-merge", adopted.sources[0].id);
      expect(split.sources).toHaveLength(2);
      expect(split.sources.every((source) => source.adoptionStatus === "adopted" && source.selected)).toBe(true);
      expect(split.sources.flatMap((source) => source.evidence?.snapshots ?? [])).toHaveLength(2);
      const merged = repository.merge("project-merge", split.sources[0].id, split.sources[1].id);
      expect(merged.sources).toHaveLength(1);
      expect(merged.sources[0]).toMatchObject({ adoptionStatus: "adopted", selected: true });
      expect(merged.sources[0].evidence?.snapshots).toHaveLength(2);
    } finally { database.close(); }
  });

  it("stores a compact, hashed evidence snapshot for a manual card", () => {
    const database = openInMemoryDatabase();
    try {
      const now = new Date().toISOString();
      database.connection.prepare("INSERT INTO workspaces (id, display_name, created_at) VALUES (?, ?, ?)").run("workspace-evidence", "测试工作区", now);
      database.connection.prepare("INSERT INTO content_projects (id, workspace_id, topic, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("project-evidence", "workspace-evidence", "测试", now, now);
      const result = new ContentResearchRepository(database.connection).addManual("project-evidence", { title: "手工资料", excerpt: "这是用户摘录的正文片段。", keyClaims: ["可供人工复核的主张"] });
      expect(result.sources[0].evidence).toMatchObject({ kind: "manual", claim: "可供人工复核的主张" });
      expect(result.sources[0].evidence?.snapshots[0].sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.sources[0].evidence?.snapshots[0].excerpt).toBe("这是用户摘录的正文片段。");
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
