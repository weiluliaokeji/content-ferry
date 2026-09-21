import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../db/database";
import { ImageSearchHistoryRepository } from "./image-search-history-repository";

describe("ImageSearchHistoryRepository", () => {
  it("persists and lists history per article context", () => {
    const database = openInMemoryDatabase();
    try {
      const repository = new ImageSearchHistoryRepository(database.connection);
      const items = [{ imageUrl: "https://example.com/image.png", thumbnailUrl: null, caption: "示例图", sourceUrl: "https://example.com/article", sourceTitle: "示例页面", review: { status: "accepted" as const, score: 0.9, reason: "符合主题" } }];
      repository.add("source:article-a", "操作界面", "tavily", items);
      repository.add("source:article-b", "另一篇文章", "tavily", items);

      const history = repository.list("source:article-a");
      expect(history).toHaveLength(1);
      expect(history[0]?.query).toBe("操作界面");
      expect(history[0]?.items[0]?.review?.status).toBe("accepted");
      expect(repository.list("source:article-b")[0]?.query).toBe("另一篇文章");
    } finally {
      database.close();
    }
  });

  it("keeps only the latest thirty searches for one article", () => {
    const database = openInMemoryDatabase();
    try {
      const repository = new ImageSearchHistoryRepository(database.connection);
      const item = { imageUrl: "https://example.com/image.png", thumbnailUrl: null, caption: "", sourceUrl: null, sourceTitle: null };
      for (let index = 0; index < 31; index += 1) repository.add("project:article", `查询 ${index}`, "tavily", [item]);
      const history = repository.list("project:article");
      expect(history).toHaveLength(30);
      expect(history.some((record) => record.query === "查询 0")).toBe(false);
      expect(history[0]?.query).toBe("查询 30");
    } finally {
      database.close();
    }
  });
});
