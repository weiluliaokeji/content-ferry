import { afterEach, describe, expect, it } from "vitest";
import { openInMemoryDatabase, type AppDatabase } from "../db/database";
import { AgentMemoryRepository } from "./agent-memory-repository";

describe("AgentMemoryRepository", () => {
  let database: AppDatabase | undefined;

  afterEach(() => database?.close());

  it("keeps candidates traceable and promotes only explicit or repeated low-risk memory", () => {
    database = openInMemoryDatabase();
    const repository = new AgentMemoryRepository(database.connection);
    const event = repository.appendEvent({ scopeKey: "account:a", eventType: "feedback", payload: { text: "句子更短" } });
    const candidate = repository.addCandidate({ scopeKey: "account:a", kind: "writing_preference", content: "句子更短", sourceEventIds: [event] });

    expect(repository.retrieve(["account:a"])).toHaveLength(0);
    repository.promoteCandidate(candidate);
    const hits = repository.retrieve(["account:a"], "句子");
    expect(hits).toHaveLength(1);
    expect(hits[0].sourceEventIds).toEqual([event]);

    repository.recordUse([hits[0].id], "article-chat:one");
    expect(repository.retrieve(["account:a"])[0].recallCount).toBe(1);
    repository.forget("account:a", "derived");
    expect(repository.retrieve(["account:a"])).toEqual([]);
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM agent_events WHERE scope_key = ?").get("account:a")).toEqual({ count: 1 });
  });

  it("lists, disables and forgets derived memory without touching events by default", () => {
    database = openInMemoryDatabase();
    const repository = new AgentMemoryRepository(database!.connection);
    const eventId = repository.appendEvent({ scopeKey: "account:test", eventType: "writing.preference", payload: { value: "短句" } });
    const candidateId = repository.addCandidate({ scopeKey: "account:test", kind: "writing_preference", content: "偏好短句。", sourceEventIds: [eventId] });
    const memoryId = repository.promoteCandidate(candidateId);
    expect(repository.listMemories(["account:test"])).toHaveLength(1);
    expect(repository.setMemoryStatus(memoryId, "deleted")).toBe(true);
    expect(repository.listMemories(["account:test"])).toHaveLength(0);
    repository.forget("account:test", "derived");
    expect((database!.connection.prepare("SELECT COUNT(*) AS count FROM agent_events WHERE scope_key = ?").get("account:test") as { count: number }).count).toBe(1);
  });

  it("exports a scope and merges it into another database without duplicating records", () => {
    database = openInMemoryDatabase();
    const source = new AgentMemoryRepository(database.connection);
    const eventId = source.appendEvent({ scopeKey: "article:one", eventType: "note", payload: { value: "保留事实" } });
    const candidateId = source.addCandidate({ scopeKey: "article:one", kind: "article_fact", content: "保留事实", sourceEventIds: [eventId], confidence: 1 });
    source.promoteCandidate(candidateId);
    const snapshot = source.exportSnapshot(["article:one"]);

    const targetDatabase = openInMemoryDatabase();
    try {
      const target = new AgentMemoryRepository(targetDatabase.connection);
      expect(target.importSnapshot(snapshot, "merge")).toMatchObject({ events: 1, candidates: 1, memories: 1, mode: "merge" });
      target.importSnapshot(snapshot, "merge");
      expect(target.listMemories(["article:one"])).toHaveLength(1);
      expect((targetDatabase.connection.prepare("SELECT COUNT(*) AS count FROM agent_events WHERE scope_key = ?").get("article:one") as { count: number }).count).toBe(1);
    } finally {
      targetDatabase.close();
    }
  });

  it("rejects imported records outside the declared scopes", () => {
    database = openInMemoryDatabase();
    const repository = new AgentMemoryRepository(database.connection);
    const eventId = repository.appendEvent({ scopeKey: "article:one", eventType: "note", payload: {} });
    const snapshot = repository.exportSnapshot(["article:one"]);
    snapshot.candidates.push({
      id: "candidate-outside-scope", scopeKey: "account:other", kind: "article_fact", content: "越界", sourceEventIds: [eventId],
      status: "candidate", supportCount: 1, confidence: 0, importance: 0, promotedMemoryId: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: null
    });
    expect(() => repository.importSnapshot(snapshot)).toThrow("作用域");
  });

  it("records background maintenance state and expires stale derived memory", () => {
    database = openInMemoryDatabase();
    const repository = new AgentMemoryRepository(database.connection);
    const eventId = repository.appendEvent({ scopeKey: "article:stale", eventType: "note", payload: {} });
    const candidateId = repository.addCandidate({ scopeKey: "article:stale", kind: "article_fact", content: "过期事实", sourceEventIds: [eventId], expiresAt: "2000-01-01T00:00:00.000Z" });
    const memoryId = repository.promoteCandidate(candidateId);
    const result = repository.maintain();
    expect(result.expired).toBe(1);
    expect(repository.listMemories(["article:stale"], "all").find((memory) => memory.id === memoryId)?.status).toBe("expired");
    expect(database.connection.prepare("SELECT status FROM memory_maintenance_state WHERE scope_key = ?").get("article:stale")).toEqual({ status: "idle" });
  });

  it("fully forgets a scope and never exports deleted memory content", () => {
    database = openInMemoryDatabase();
    const repository = new AgentMemoryRepository(database.connection);
    const eventId = repository.appendEvent({ scopeKey: "article:forgotten", eventType: "note", payload: { secret: "不要保留" } });
    const candidateId = repository.addCandidate({ scopeKey: "article:forgotten", kind: "article_fact", content: "不要保留", sourceEventIds: [eventId] });
    const memoryId = repository.promoteCandidate(candidateId);
    repository.recordUse([memoryId], "test-forget");

    repository.forget("article:forgotten", "all");

    expect(repository.exportSnapshot(["article:forgotten"])).toMatchObject({ events: [], candidates: [], memories: [] });
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM memory_uses WHERE memory_id = ?").get(memoryId)).toEqual({ count: 0 });
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM agent_events WHERE scope_key = ?").get("article:forgotten")).toEqual({ count: 0 });
  });

  it("removes the compatibility conversation when fully forgetting an article scope", () => {
    database = openInMemoryDatabase();
    database.connection.prepare("INSERT INTO article_chat_threads (context_key, memory, updated_at) VALUES (?, '', ?)")
      .run("article:forgotten-chat", new Date().toISOString());
    database.connection.prepare(`INSERT INTO article_chat_messages
      (id, context_key, role, content, memory_suggestion, suggestions_json, created_at)
      VALUES (?, ?, 'user', ?, '', '[]', ?)`)
      .run("forgotten-message", "article:forgotten-chat", "不应继续进入模型上下文的内容", new Date().toISOString());

    new AgentMemoryRepository(database.connection).forget("article:forgotten-chat", "all");

    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM article_chat_threads WHERE context_key = ?").get("article:forgotten-chat")).toEqual({ count: 0 });
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM article_chat_messages WHERE context_key = ?").get("article:forgotten-chat")).toEqual({ count: 0 });
  });

  it("advances maintenance watermark only after a successful incremental pass", () => {
    database = openInMemoryDatabase();
    const repository = new AgentMemoryRepository(database.connection);
    repository.appendEvent({ scopeKey: "article:watermark", eventType: "note", payload: { value: 1 } });
    const first = repository.maintain();
    expect(first).toEqual({ expired: 0, consolidated: 0 });
    const firstWatermark = (database.connection.prepare("SELECT watermark FROM memory_maintenance_state WHERE scope_key = ?").get("article:watermark") as { watermark: string }).watermark;
    expect(firstWatermark).toBeTruthy();

    repository.appendEvent({ scopeKey: "article:watermark", eventType: "note", payload: { value: 2 } });
    repository.maintain();
    const secondWatermark = (database.connection.prepare("SELECT watermark FROM memory_maintenance_state WHERE scope_key = ?").get("article:watermark") as { watermark: string }).watermark;
    expect(secondWatermark >= firstWatermark).toBe(true);
  });
});
