import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContentSourceService, withSvgIntrinsicSize } from "./content-source-service";
import { AccountRepository } from "../accounts/account-repository";
import { openInMemoryDatabase } from "../db/database";
import { ImageSearchHistoryRepository } from "./image-search-history-repository";

describe("withSvgIntrinsicSize", () => {
  it("injects width/height from the viewBox when both are missing", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 720"></svg>';
    const result = withSvgIntrinsicSize(svg);
    expect(result).toContain('width="900"');
    expect(result).toContain('height="720"');
    expect(result).toContain('viewBox="0 0 900 720"');
  });

  it("parses viewBox with comma separators", () => {
    const svg = '<svg viewBox="0,0,480,360"><rect/></svg>';
    const result = withSvgIntrinsicSize(svg);
    expect(result).toContain('width="480"');
    expect(result).toContain('height="360"');
  });

  it("leaves an already-sized svg untouched", () => {
    const svg = '<svg width="320" height="240" viewBox="0 0 900 720"></svg>';
    expect(withSvgIntrinsicSize(svg)).toBe(svg);
  });

  it("fills only the missing dimension", () => {
    const svg = '<svg height="720" viewBox="0 0 900 720"></svg>';
    const result = withSvgIntrinsicSize(svg);
    expect(result).toContain('width="900"');
    expect(result).toContain('height="720"');
  });

  it("does nothing when there is no viewBox and no dimensions", () => {
    const svg = "<svg><rect/></svg>";
    expect(withSvgIntrinsicSize(svg)).toBe(svg);
  });

  it("returns non-svg content unchanged", () => {
    expect(withSvgIntrinsicSize("not an svg")).toBe("not an svg");
  });

  it("handles the real article svg (viewBox only)", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 720">\n  <rect width="100%" height="100%" fill="#0f172a"/>\n</svg>';
    const result = withSvgIntrinsicSize(svg);
    expect(result).toContain('width="900"');
    expect(result).toContain('height="720"');
  });
});

// The rasterize option gates a wire-boundary conversion from SVG to PNG so the
// renderer's `<img>` does not have to load the SVG as a self-contained
// document (which would fail in sandboxed previews when the SVG references
// external fonts). These tests pin the contract: on -> PNG, off -> SVG.
describe("ContentSourceService.readArticleResource rasterize option", () => {
  let database: ReturnType<typeof openInMemoryDatabase>;
  let sourceDirectory: string;
  let contentSources: ContentSourceService;
  let workspaceId: string;

  beforeEach(() => {
    database = openInMemoryDatabase();
    sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-svg-rasterize-"));
    const assetsDirectory = path.join(sourceDirectory, "posts", "sample", "assets");
    fs.mkdirSync(assetsDirectory, { recursive: true });
    fs.writeFileSync(path.join(assetsDirectory, "diagram.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360"><rect width="100%" height="100%" fill="#0f172a"/></svg>');
    fs.writeFileSync(path.join(assetsDirectory, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    fs.writeFileSync(path.join(sourceDirectory, "posts", "sample", "index.md"), "---\ntitle: 测试\n---\n");
    contentSources = new ContentSourceService(database.connection);
    const accounts = new AccountRepository(database.connection);
    workspaceId = accounts.getOrCreateDefaultWorkspace().id;
    contentSources.setSource(workspaceId, sourceDirectory);
  });

  afterEach(() => {
    fs.rmSync(sourceDirectory, { recursive: true, force: true });
    database.connection.close();
  });

  it("returns SVG bytes with image/svg+xml when rasterize is not requested", async () => {
    const resource = await contentSources.readArticleResource(workspaceId, "posts/sample/index.md", "./assets/diagram.svg");
    expect(resource.mimeType).toBe("image/svg+xml");
    const bytes: Buffer = await readStreamToBuffer(resource.stream);
    expect(bytes.toString("utf-8")).toContain("<svg");
  });

  it("returns PNG bytes with image/png when rasterize is requested for an SVG", async () => {
    const resource = await contentSources.readArticleResource(workspaceId, "posts/sample/index.md", "./assets/diagram.svg", { rasterize: true });
    expect(resource.mimeType).toBe("image/png");
    const bytes: Buffer = await readStreamToBuffer(resource.stream);
    expect(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(bytes.length).toBeGreaterThan(8);
  });

  it("leaves non-SVG images untouched when rasterize is requested", async () => {
    const resource = await contentSources.readArticleResource(workspaceId, "posts/sample/index.md", "./assets/photo.png", { rasterize: true });
    expect(resource.mimeType).toBe("image/png");
    const bytes: Buffer = await readStreamToBuffer(resource.stream);
    expect(bytes.length).toBe(11);
  });
});

describe("ContentSourceService plain Markdown source", () => {
  it("scans and creates nested index articles without a posts directory", async () => {
    const database = openInMemoryDatabase();
    const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-plain-source-"));
    try {
      const articleDirectory = path.join(sourceDirectory, "已有文章", "assets");
      fs.mkdirSync(articleDirectory, { recursive: true });
      fs.writeFileSync(path.join(articleDirectory, "cover.png"), "image");
      fs.writeFileSync(path.join(sourceDirectory, "已有文章", "index.md"), "---\ntitle: 已有文章\nstatus: published\ntags: [AI]\n---\n正文\n");
      const service = new ContentSourceService(database.connection);
      const workspaceId = new AccountRepository(database.connection).getOrCreateDefaultWorkspace().id;
      service.setSource(workspaceId, sourceDirectory, "plain");
      expect(service.preview(workspaceId).items.map((item) => item.relativePath)).toEqual(["已有文章/index.md"]);
      expect(service.preview(workspaceId).items[0]).toMatchObject({ status: "published", tags: ["AI"] });
      const created = service.createArticle(workspaceId, "新文章");
      expect(created.relativePath).toBe("新文章/index.md");
      expect(fs.readFileSync(path.join(sourceDirectory, "新文章", "index.md"), "utf8")).toContain("status: draft");
      const resource = service.readArticleResource(workspaceId, "已有文章/index.md", "./assets/cover.png");
      expect(resource.mimeType).toBe("image/png");
      await readStreamToBuffer(resource.stream);
    } finally {
      fs.rmSync(sourceDirectory, { recursive: true, force: true });
      database.close();
    }
  });
});

describe("ContentSourceService article rename", () => {
  it("migrates article-scoped history when the article directory follows its title", () => {
    const database = openInMemoryDatabase();
    const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-article-rename-"));
    try {
      const articleDirectory = path.join(sourceDirectory, "posts", "旧标题");
      fs.mkdirSync(articleDirectory, { recursive: true });
      fs.writeFileSync(path.join(articleDirectory, "index.md"), "---\ntitle: 旧标题\n---\n\n# 旧标题\n\n旧正文\n");

      const workspaceId = new AccountRepository(database.connection).getOrCreateDefaultWorkspace().id;
      const contentSources = new ContentSourceService(database.connection);
      contentSources.setSource(workspaceId, sourceDirectory);

      const history = new ImageSearchHistoryRepository(database.connection);
      const historyItem = { imageUrl: "https://example.com/image.png", thumbnailUrl: null, caption: "示例图", sourceUrl: null, sourceTitle: null };
      history.add("source:posts/旧标题/index.md", "旧标题配图", "tavily", [historyItem]);
      database.connection.prepare("INSERT INTO article_chat_threads (context_key, memory, updated_at) VALUES (?, ?, ?)")
        .run("source:posts/旧标题/index.md", "旧文章记忆", "2026-09-20T00:00:00.000Z");
      database.connection.prepare(`INSERT INTO article_chat_messages
        (id, context_key, role, content, memory_suggestion, suggestions_json, created_at)
        VALUES (?, ?, 'user', ?, '', '[]', ?)`)
        .run("rename-chat-message", "source:posts/旧标题/index.md", "请帮我修改标题", "2026-09-20T00:01:00.000Z");
      database.connection.prepare("INSERT INTO agent_events (id, scope_key, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
        .run("rename-chat-event", "source:posts/旧标题/index.md", "article_chat.user_message", "{}", "2026-09-20T00:01:00.000Z");

      const saved = contentSources.saveArticle(workspaceId, "posts/旧标题/index.md", "# 新标题\n\n更新后的正文");

      expect(saved.relativePath).toBe("posts/新标题/index.md");
      expect(history.list("source:posts/旧标题/index.md")).toHaveLength(0);
      expect(history.list("source:posts/新标题/index.md")[0]?.query).toBe("旧标题配图");
      expect(database.connection.prepare("SELECT memory FROM article_chat_threads WHERE context_key = ?")
        .get("source:posts/新标题/index.md")).toEqual({ memory: "旧文章记忆" });
      expect(database.connection.prepare("SELECT content FROM article_chat_messages WHERE context_key = ?")
        .get("source:posts/新标题/index.md")).toEqual({ content: "请帮我修改标题" });
      expect(database.connection.prepare("SELECT COUNT(*) AS count FROM article_chat_messages WHERE context_key = ?")
        .get("source:posts/旧标题/index.md")).toEqual({ count: 0 });
      expect(database.connection.prepare("SELECT scope_key AS scopeKey FROM agent_events WHERE id = ?")
        .get("rename-chat-event")).toEqual({ scopeKey: "source:posts/新标题/index.md" });
    } finally {
      fs.rmSync(sourceDirectory, { recursive: true, force: true });
      database.close();
    }
  });

  it("rolls the directory back when article context migration conflicts", () => {
    const database = openInMemoryDatabase();
    const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-article-rename-conflict-"));
    try {
      const articleDirectory = path.join(sourceDirectory, "posts", "旧标题");
      fs.mkdirSync(articleDirectory, { recursive: true });
      fs.writeFileSync(path.join(articleDirectory, "index.md"), "---\ntitle: 旧标题\n---\n\n# 旧标题\n\n旧正文\n");

      const workspaceId = new AccountRepository(database.connection).getOrCreateDefaultWorkspace().id;
      const contentSources = new ContentSourceService(database.connection);
      contentSources.setSource(workspaceId, sourceDirectory);
      const now = "2026-09-20T00:00:00.000Z";
      database.connection.prepare("INSERT INTO article_settings (context_key, updated_at) VALUES (?, ?)")
        .run("source:posts/旧标题/index.md", now);
      database.connection.prepare(`INSERT INTO memory_candidates
        (id, scope_key, kind, content, content_hash, source_event_ids_json, status, support_count, confidence, importance, created_at, updated_at)
        VALUES (?, ?, 'article_fact', ?, ?, '[]', 'candidate', 1, 1, 1, ?, ?)`)
        .run("old-memory", "source:posts/旧标题/index.md", "同一条记忆", "same-hash", now, now);
      database.connection.prepare(`INSERT INTO memory_candidates
        (id, scope_key, kind, content, content_hash, source_event_ids_json, status, support_count, confidence, importance, created_at, updated_at)
        VALUES (?, ?, 'article_fact', ?, ?, '[]', 'candidate', 1, 1, 1, ?, ?)`)
        .run("new-memory", "source:posts/新标题/index.md", "另一条记忆", "same-hash", now, now);

      expect(() => contentSources.saveArticle(workspaceId, "posts/旧标题/index.md", "# 新标题\n\n更新后的正文")).toThrow();
      expect(fs.existsSync(path.join(sourceDirectory, "posts", "旧标题"))).toBe(true);
      expect(fs.existsSync(path.join(sourceDirectory, "posts", "新标题"))).toBe(false);
      expect(database.connection.prepare("SELECT context_key AS contextKey FROM article_settings")
        .get()).toEqual({ contextKey: "source:posts/旧标题/index.md" });
      expect(database.connection.prepare("SELECT scope_key AS scopeKey FROM memory_candidates WHERE id = ?")
        .get("old-memory")).toEqual({ scopeKey: "source:posts/旧标题/index.md" });
    } finally {
      fs.rmSync(sourceDirectory, { recursive: true, force: true });
      database.close();
    }
  });
});

async function readStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
