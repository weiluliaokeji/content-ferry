import { afterEach, describe, expect, it } from "vitest";
import { openInMemoryDatabase, type AppDatabase } from "./database";

describe("article settings schema", () => {
  let database: AppDatabase | undefined;

  afterEach(() => database?.close());

  it("stores the confirmed cover prompt with article settings", () => {
    database = openInMemoryDatabase();
    const columns = database.connection.prepare("PRAGMA table_info(article_settings)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("cover_prompt");
  });
});
