import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountRepository } from "../accounts/account-repository";
import { ContentSourceService } from "../content/content-source-service";
import { openInMemoryDatabase, type AppDatabase } from "../db/database";
import { inlineCsdnImages, resolveCsdnImagesForBrowser } from "./csdn-image-inliner";

describe("inlineCsdnImages", () => {
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

  it("inlines a local asset image as a base64 data URI", async () => {
    database = openInMemoryDatabase();
    const accounts = new AccountRepository(database.connection);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-csdn-img-"));
    const articleDirectory = path.join(sourceDirectory, "posts", "article");
    fs.mkdirSync(path.join(articleDirectory, "assets"), { recursive: true });
    const imagePath = path.join(articleDirectory, "assets", "diagram.png");
    fs.writeFileSync(imagePath, Buffer.from("fake-png-bytes", "utf8"));
    fs.writeFileSync(path.join(articleDirectory, "index.md"), "---\ntitle: 测试\n---\n\n# 测试\n\n![示意图](./assets/diagram.png)\n", "utf8");

    const contentSources = new ContentSourceService(database.connection);
    contentSources.setSource(workspace.id, sourceDirectory);

    const markdown = "# 测试\n\n![示意图](./assets/diagram.png)\n";
    const result = await inlineCsdnImages(markdown, workspace.id, "posts/article/index.md", contentSources);

    expect(result.inlinedCount).toBe(1);
    expect(result.failed).toHaveLength(0);
    expect(result.markdown).toContain("data:image/png;base64,");
    expect(result.markdown).toContain(Buffer.from("fake-png-bytes", "utf8").toString("base64"));
    expect(result.markdown).not.toContain("./assets/diagram.png");
  });

  it("leaves code-block image syntax untouched", async () => {
    database = openInMemoryDatabase();
    const accounts = new AccountRepository(database.connection);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-csdn-img-"));
    const articleDirectory = path.join(sourceDirectory, "posts", "article");
    fs.mkdirSync(path.join(articleDirectory, "assets"), { recursive: true });
    fs.writeFileSync(path.join(articleDirectory, "assets", "diagram.png"), Buffer.from("fake-png-bytes", "utf8"));
    fs.writeFileSync(path.join(articleDirectory, "index.md"), "---\ntitle: 测试\n---\n", "utf8");

    const contentSources = new ContentSourceService(database.connection);
    contentSources.setSource(workspace.id, sourceDirectory);

    const markdown = "```md\n![示意图](./assets/diagram.png)\n```\n\n![真实图](./assets/diagram.png)\n";
    const result = await inlineCsdnImages(markdown, workspace.id, "posts/article/index.md", contentSources);

    expect(result.inlinedCount).toBe(1);
    expect(result.markdown).toContain("![示意图](./assets/diagram.png)");
    expect(result.markdown).toContain("data:image/png;base64,");
  });

  it("reports a missing local image without crashing", async () => {
    database = openInMemoryDatabase();
    const accounts = new AccountRepository(database.connection);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-csdn-img-"));
    const articleDirectory = path.join(sourceDirectory, "posts", "article");
    fs.mkdirSync(articleDirectory, { recursive: true });
    fs.writeFileSync(path.join(articleDirectory, "index.md"), "---\ntitle: 测试\n---\n", "utf8");

    const contentSources = new ContentSourceService(database.connection);
    contentSources.setSource(workspace.id, sourceDirectory);

    const markdown = "# 测试\n\n![缺失图](./assets/missing.png)\n";
    const result = await inlineCsdnImages(markdown, workspace.id, "posts/article/index.md", contentSources);

    expect(result.inlinedCount).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].source).toBe("./assets/missing.png");
    expect(result.markdown).toContain("![缺失图](./assets/missing.png)");
  });
});

describe("resolveCsdnImagesForBrowser", () => {
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

  it("resolves local images to data URLs and skips CSDN-hosted / data: sources", async () => {
    database = openInMemoryDatabase();
    const accounts = new AccountRepository(database.connection);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-csdn-res-"));
    const articleDirectory = path.join(sourceDirectory, "posts", "article");
    fs.mkdirSync(path.join(articleDirectory, "assets"), { recursive: true });
    fs.writeFileSync(path.join(articleDirectory, "assets", "diagram.png"), Buffer.from("fake-png-bytes", "utf8"));
    fs.writeFileSync(path.join(articleDirectory, "index.md"), "---\ntitle: 测试\n---\n", "utf8");

    const contentSources = new ContentSourceService(database.connection);
    contentSources.setSource(workspace.id, sourceDirectory);

    // 远程图片在测试环境无外网，mock fetch 让它返回一张假 PNG。
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const url = String(input);
      if (url.includes("example.com")) {
        return new Response(Buffer.from("remote-bytes"), { status: 200, headers: { "content-type": "image/png" } });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch);

    const markdown = [
      "![本地图](./assets/diagram.png)",
      "![已托管](https://img-blog.csdnimg.cn/20240101000000.png)",
      "![内嵌](data:image/png;base64,QUJD)",
      "![远程图](https://example.com/x.png)"
    ].join("\n");

    const images = await resolveCsdnImagesForBrowser(markdown, workspace.id, "posts/article/index.md", contentSources);

    // 本地 + 远程需要上传；已托管 + 内嵌跳过。
    expect(images).toHaveLength(2);
    const sources = images.map((image) => image.source);
    expect(sources).toContain("./assets/diagram.png");
    expect(sources).toContain("https://example.com/x.png");
    const local = images.find((image) => image.source === "./assets/diagram.png");
    expect(local?.dataUrl).toBe(`data:image/png;base64,${Buffer.from("fake-png-bytes", "utf8").toString("base64")}`);
    expect(local?.mimeType).toBe("image/png");
    expect(local?.filename).toBe("diagram.png");
    const remote = images.find((image) => image.source === "https://example.com/x.png");
    expect(remote?.dataUrl).toBe(`data:image/png;base64,${Buffer.from("remote-bytes", "utf8").toString("base64")}`);
  });

  it("returns an empty list when the markdown has no uploadable images", async () => {
    database = openInMemoryDatabase();
    const accounts = new AccountRepository(database.connection);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-csdn-res-"));
    const articleDirectory = path.join(sourceDirectory, "posts", "article");
    fs.mkdirSync(articleDirectory, { recursive: true });
    fs.writeFileSync(path.join(articleDirectory, "index.md"), "---\ntitle: 测试\n---\n", "utf8");

    const contentSources = new ContentSourceService(database.connection);
    contentSources.setSource(workspace.id, sourceDirectory);

    const images = await resolveCsdnImagesForBrowser(
      "纯文本，无图片。",
      workspace.id,
      "posts/article/index.md",
      contentSources
    );
    expect(images).toHaveLength(0);
  });
});
