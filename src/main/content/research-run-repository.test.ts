import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../db/database";
import { ResearchRunRepository } from "./research-run-repository";
import type { ContentResearch } from "./content-research-repository";

describe("ResearchRunRepository", () => {
  it("keeps each completed run immutable after current research changes", () => {
    const database = openInMemoryDatabase();
    try {
      const now = new Date().toISOString();
      database.connection.prepare("INSERT INTO workspaces (id, display_name, created_at) VALUES (?, ?, ?)").run("workspace-run", "测试", now);
      database.connection.prepare("INSERT INTO content_projects (id, workspace_id, topic, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("project-run", "workspace-run", "测试", now, now);
      database.connection.prepare(`INSERT INTO research_tasks (id, project_id, kind, request_hash, request_json, status, created_at, updated_at, last_heartbeat_at)
        VALUES ('task-1', 'project-run', 'generate', 'hash', '{}', 'completed', ?, ?, ?)` ).run(now, now, now);
      const runs = new ResearchRunRepository(database.connection);
      const research: ContentResearch = { projectId: "project-run", planMarkdown: "初始结论", plan: null, sources: [{ id: "source-1", title: "资料", url: "https://example.com", excerpt: "摘录", keyClaims: [], sourceType: "public", adoptionStatus: "adopted", retrievedAt: now, selected: true }], specifiedSources: [], updatedAt: now };
      runs.record("project-run", "task-1", "generate", research);
      research.planMarkdown = "已改变";
      research.sources[0].adoptionStatus = "rejected";
      const saved = runs.list("project-run");
      expect(saved[0].research.planMarkdown).toBe("初始结论");
      expect(saved[0].research.sources[0]).toMatchObject({ adoptionStatus: "adopted" });
    } finally { database.close(); }
  });
});
