import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../db/database";
import { ResearchTaskRepository } from "./research-task-repository";

describe("ResearchTaskRepository", () => {
  it("persists lifecycle, cancellation and event history", () => {
    const database = openInMemoryDatabase();
    try {
      database.connection.prepare("INSERT INTO workspaces (id, display_name, created_at) VALUES (?, ?, ?)").run("workspace-1", "测试工作区", new Date().toISOString());
      database.connection.prepare("INSERT INTO content_projects (id, workspace_id, topic, status, created_at, updated_at) VALUES (?, ?, ?, 'idea', ?, ?)").run("project-1", "workspace-1", "测试", new Date().toISOString(), new Date().toISOString());
      const repository = new ResearchTaskRepository(database.connection);
      const task = repository.create("project-1", "generate", { topic: "测试" });
      expect(task.status).toBe("queued");
      expect(task.request).toEqual({ topic: "测试" });
      repository.transition(task.id, "running", { checkpoint: "正在检索" });
      const cancelled = repository.requestCancel(task.id);
      expect(cancelled.cancelRequested).toBe(true);
      expect(cancelled.status).toBe("cancelled");
      expect(repository.isCancelRequested(task.id)).toBe(true);
      expect((database.connection.prepare("SELECT COUNT(*) AS count FROM research_task_events WHERE task_id = ?").get(task.id) as { count: number }).count).toBeGreaterThanOrEqual(3);
    } finally {
      database.close();
    }
  });

  it("requeues stale work and claims it once", () => {
    const database = openInMemoryDatabase();
    try {
      database.connection.prepare("INSERT INTO workspaces (id, display_name, created_at) VALUES (?, ?, ?)").run("workspace-1", "测试工作区", new Date().toISOString());
      database.connection.prepare("INSERT INTO content_projects (id, workspace_id, topic, status, created_at, updated_at) VALUES (?, ?, ?, 'idea', ?, ?)").run("project-1", "workspace-1", "测试", new Date().toISOString(), new Date().toISOString());
      const repository = new ResearchTaskRepository(database.connection);
      const task = repository.create("project-1", "follow_up", { message: "继续查证" });
      repository.transition(task.id, "running");
      database.connection.prepare("UPDATE research_tasks SET last_heartbeat_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 60_000).toISOString(), task.id);
      expect(repository.recoverInterrupted()).toBe(1);
      expect(repository.listRecoverable().map((item) => item.id)).toEqual([task.id]);
      expect(repository.claim(task.id)).toBe(true);
      expect(repository.claim(task.id)).toBe(false);
      expect(repository.require(task.id).attempt).toBe(2);
    } finally {
      database.close();
    }
  });

  it("pauses and resumes queued work without losing its checkpoint", () => {
    const database = openInMemoryDatabase();
    try {
      database.connection.prepare("INSERT INTO workspaces (id, display_name, created_at) VALUES (?, ?, ?)").run("workspace-1", "测试工作区", new Date().toISOString());
      database.connection.prepare("INSERT INTO content_projects (id, workspace_id, topic, status, created_at, updated_at) VALUES (?, ?, ?, 'idea', ?, ?)").run("project-1", "workspace-1", "测试", new Date().toISOString(), new Date().toISOString());
      const repository = new ResearchTaskRepository(database.connection);
      const task = repository.create("project-1", "generate", { topic: "测试" });
      repository.transition(task.id, "running", { checkpoint: "已完成第一步" });
      expect(repository.requestPause(task.id).status).toBe("paused");
      expect(repository.isPaused(task.id)).toBe(true);
      expect(repository.resume(task.id).status).toBe("queued");
      expect(repository.require(task.id).lastCheckpoint).toBe("已恢复，等待后台继续。");
      expect(repository.isPaused(task.id)).toBe(false);
    } finally {
      database.close();
    }
  });

  it("stores a generated result checkpoint for resume", () => {
    const database = openInMemoryDatabase();
    try {
      database.connection.prepare("INSERT INTO workspaces (id, display_name, created_at) VALUES (?, ?, ?)").run("workspace-1", "测试工作区", new Date().toISOString());
      database.connection.prepare("INSERT INTO content_projects (id, workspace_id, topic, status, created_at, updated_at) VALUES (?, ?, ?, 'idea', ?, ?)").run("project-1", "workspace-1", "测试", new Date().toISOString(), new Date().toISOString());
      const repository = new ResearchTaskRepository(database.connection);
      const task = repository.create("project-1", "generate", { topic: "测试" });
      repository.saveCheckpoint(task.id, "generated", { planMarkdown: "结论", sources: [] });
      expect(repository.getCheckpoint(task.id, "generated")).toEqual({ planMarkdown: "结论", sources: [] });
      expect(repository.require(task.id).currentStepId).toBe("generated");
    } finally {
      database.close();
    }
  });
});
