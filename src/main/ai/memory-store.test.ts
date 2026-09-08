import { afterEach, describe, expect, it } from "vitest";
import { openInMemoryDatabase, type AppDatabase } from "../db/database";
import { SqliteMemoryStore } from "./memory-store";

describe("SqliteMemoryStore", () => {
  let database: AppDatabase | undefined;

  afterEach(() => database?.close());

  it("merges normalized, unique article and writing memories through one seam", () => {
    database = openInMemoryDatabase();
    const store = new SqliteMemoryStore(database.connection);

    expect(store.mergeArticle("source:article.md", "  保留具体例子。\n")).toBe("- 保留具体例子。");
    expect(store.mergeArticle("source:article.md", "保留具体例子。")).toBe("- 保留具体例子。");
    expect(store.mergeWriting("account:one", "句子要短一些")).toBe("- 句子要短一些");
    expect(store.mergeWriting("account:one", "   ")).toBe("- 句子要短一些");
  });
});
