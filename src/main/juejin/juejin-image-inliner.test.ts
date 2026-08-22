import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountRepository } from "../accounts/account-repository";
import { ContentSourceService } from "../content/content-source-service";
import { openInMemoryDatabase, type AppDatabase } from "../db/database";
import { inlineJuejinLocalImages } from "./juejin-image-inliner";

describe("inlineJuejinLocalImages", () => {
  let database: AppDatabase | undefined;
  let sourceDirectory: string | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    database?.close();
    if (sourceDirectory) {
      try { fs.rmSync(sourceDirectory, { recursive: true, force: true }); }
      catch { /* ignore */ }
    }
    database = undefined;
    sourceDirectory = undefined;
  });

  function setupArticle(): { workspaceId: string; relativePath: string; contentSources: ContentSourceService } {
    database = openInMemoryDatabase();
    const accounts = new AccountRepository(database.connection);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-juejin-img-"));
    const articleDirectory = path.join(sourceDirectory, "posts", "article");
    fs.mkdirSync(path.join(articleDirectory, "assets"), { recursive: true });
    fs.writeFileSync(path.join(articleDirectory, "assets", "diagram.png"), Buffer.from("fake-png-bytes", "utf8"));
    fs.writeFileSync(path.join(articleDirectory, "index.md"), "---\ntitle: 测试\n---\n", "utf8");
    const contentSources = new ContentSourceService(database.connection);
    contentSources.setSource(workspace.id, sourceDirectory);
    return { workspaceId: workspace.id, relativePath: "posts/article/index.md", contentSources };
  }

  it("inlines a local asset image as a base64 data URI", async () => {
    const { workspaceId, relativePath, contentSources } = setupArticle();
    const markdown = "# 测试\n\n![示意图](./assets/diagram.png)\n";
    const result = await inlineJuejinLocalImages(markdown, workspaceId, relativePath, contentSources);

    expect(result.inlinedCount).toBe(1);
    expect(result.failed).toHaveLength(0);
    expect(result.markdown).toContain("data:image/png;base64,");
    expect(result.markdown).toContain(Buffer.from("fake-png-bytes", "utf8").toString("base64"));
    expect(result.markdown).not.toContain("./assets/diagram.png");
  });

  it("leaves remote http(s) image URLs untouched (external-link strategy)", async () => {
    const { workspaceId, relativePath, contentSources } = setupArticle();
    const markdown = "# 测试\n\n![远程图](https://img.example.com/diagram.png)\n";
    const result = await inlineJuejinLocalImages(markdown, workspaceId, relativePath, contentSources);

    expect(result.inlinedCount).toBe(0);
    expect(result.failed).toHaveLength(0);
    expect(result.markdown).toBe(markdown);
  });

  it("leaves code-block image syntax untouched", async () => {
    const { workspaceId, relativePath, contentSources } = setupArticle();
    const markdown = "```md\n![示意图](./assets/diagram.png)\n```\n\n![真实图](./assets/diagram.png)\n";
    const result = await inlineJuejinLocalImages(markdown, workspaceId, relativePath, contentSources);

    expect(result.inlinedCount).toBe(1);
    expect(result.markdown).toContain("![示意图](./assets/diagram.png)");
    expect(result.markdown).toContain("data:image/png;base64,");
  });

  it("reports a missing local image without crashing", async () => {
    const { workspaceId, relativePath, contentSources } = setupArticle();
    const markdown = "# 测试\n\n![缺失图](./assets/missing.png)\n";
    const result = await inlineJuejinLocalImages(markdown, workspaceId, relativePath, contentSources);

    expect(result.inlinedCount).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].source).toBe("./assets/missing.png");
    expect(result.markdown).toContain("![缺失图](./assets/missing.png)");
  });

  it("leaves data URI images untouched", async () => {
    const { workspaceId, relativePath, contentSources } = setupArticle();
    const markdown = "# 测试\n\n![内联图](data:image/png;base64,AAAA)\n";
    const result = await inlineJuejinLocalImages(markdown, workspaceId, relativePath, contentSources);

    expect(result.inlinedCount).toBe(0);
    expect(result.failed).toHaveLength(0);
    expect(result.markdown).toBe(markdown);
  });

  it("skips inlining when a single image would exceed the inline budget", async () => {
    const { workspaceId, relativePath, contentSources } = setupArticle();
    const articleDirectory = path.join(sourceDirectory!, "posts", "article");
    fs.writeFileSync(path.join(articleDirectory, "assets", "big.png"), Buffer.alloc(3000, 0x61));
    const markdown = "# 测试\n\n![大图](./assets/big.png)\n";
    // 3000 字节 base64 后约 4000 字符，预算 2000 应跳过。
    const result = await inlineJuejinLocalImages(markdown, workspaceId, relativePath, contentSources, 2000);

    expect(result.inlinedCount).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].source).toBe("./assets/big.png");
    expect(result.failed[0].reason).toContain("超过掘金正文长度预算");
    expect(result.markdown).toContain("./assets/big.png");
  });

  it("inlines images up to the budget then skips the rest", async () => {
    const { workspaceId, relativePath, contentSources } = setupArticle();
    const articleDirectory = path.join(sourceDirectory!, "posts", "article");
    fs.writeFileSync(path.join(articleDirectory, "assets", "small.png"), Buffer.alloc(1000, 0x62));
    fs.writeFileSync(path.join(articleDirectory, "assets", "big.png"), Buffer.alloc(3000, 0x63));
    const markdown = "# 测试\n\n![小图](./assets/small.png)\n\n![大图](./assets/big.png)\n";
    // 小图 base64 约 1336 字符，大图约 4000 字符；预算 2000 只允许内联小图。
    const result = await inlineJuejinLocalImages(markdown, workspaceId, relativePath, contentSources, 2000);

    expect(result.inlinedCount).toBe(1);
    expect(result.markdown).toContain("data:image/png;base64,");
    expect(result.markdown).toContain("![大图](./assets/big.png)");
    expect(result.failed.some((f) => f.source === "./assets/big.png" && f.reason.includes("预算"))).toBe(true);
  });
});
