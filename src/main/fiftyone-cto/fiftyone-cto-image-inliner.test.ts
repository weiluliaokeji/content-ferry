import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountRepository } from "../accounts/account-repository";
import { ContentSourceService } from "../content/content-source-service";
import { openInMemoryDatabase, type AppDatabase } from "../db/database";
import { inlineFiftyoneCtoLocalImages } from "./fiftyone-cto-image-inliner";

describe("inlineFiftyoneCtoLocalImages", () => {
  let database: AppDatabase | undefined;
  let sourceDirectory: string | undefined;

  afterEach(() => {
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
    sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-51cto-img-"));
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
    const result = await inlineFiftyoneCtoLocalImages(markdown, workspaceId, relativePath, contentSources);

    expect(result.inlinedCount).toBe(1);
    expect(result.failed).toHaveLength(0);
    expect(result.markdown).toContain("data:image/png;base64,");
    expect(result.markdown).toContain(Buffer.from("fake-png-bytes", "utf8").toString("base64"));
    expect(result.markdown).not.toContain("./assets/diagram.png");
  });

  it("leaves remote http(s) image URLs untouched (external-link strategy)", async () => {
    const { workspaceId, relativePath, contentSources } = setupArticle();
    const markdown = "# 测试\n\n![远程图](https://img.example.com/diagram.png)\n";
    const result = await inlineFiftyoneCtoLocalImages(markdown, workspaceId, relativePath, contentSources);

    expect(result.inlinedCount).toBe(0);
    expect(result.failed).toHaveLength(0);
    expect(result.markdown).toBe(markdown);
  });

  it("leaves code-block image syntax untouched", async () => {
    const { workspaceId, relativePath, contentSources } = setupArticle();
    const markdown = "```md\n![示意图](./assets/diagram.png)\n```\n\n![真实图](./assets/diagram.png)\n";
    const result = await inlineFiftyoneCtoLocalImages(markdown, workspaceId, relativePath, contentSources);

    expect(result.inlinedCount).toBe(1);
    expect(result.markdown).toContain("![示意图](./assets/diagram.png)");
    expect(result.markdown).toContain("data:image/png;base64,");
  });

  it("reports a missing local image without crashing", async () => {
    const { workspaceId, relativePath, contentSources } = setupArticle();
    const markdown = "# 测试\n\n![缺失图](./assets/missing.png)\n";
    const result = await inlineFiftyoneCtoLocalImages(markdown, workspaceId, relativePath, contentSources);

    expect(result.inlinedCount).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].source).toBe("./assets/missing.png");
    expect(result.markdown).toContain("![缺失图](./assets/missing.png)");
  });

  it("leaves data URI images untouched", async () => {
    const { workspaceId, relativePath, contentSources } = setupArticle();
    const markdown = "# 测试\n\n![内联图](data:image/png;base64,AAAA)\n";
    const result = await inlineFiftyoneCtoLocalImages(markdown, workspaceId, relativePath, contentSources);

    expect(result.inlinedCount).toBe(0);
    expect(result.failed).toHaveLength(0);
    expect(result.markdown).toBe(markdown);
  });
});
