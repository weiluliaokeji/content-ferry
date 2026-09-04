import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountRepository } from "../accounts/account-repository";
import { ContentSourceService } from "../content/content-source-service";
import { openInMemoryDatabase, type AppDatabase } from "../db/database";
import { inlineJuejinLocalImages } from "./juejin-image-inliner";
import type { JuejinImageUploader } from "./juejin-image-uploader";

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

  it("uploads a local image to ImageX and replaces it with the CDN URL when the uploader succeeds", async () => {
    const { workspaceId, relativePath, contentSources } = setupArticle();
    const uploader = {
      uploadImage: vi.fn(async () => ({ url: "https://p1-juejin.byteimg.com/tos-cn-i-test/up.png~tplv-k3u1fbpfcp-watermark.image", storeUri: "tos-cn-i-test/up.png" }))
    } as unknown as JuejinImageUploader;
    const markdown = "# 测试\n\n![示意图](./assets/diagram.png)\n";
    const result = await inlineJuejinLocalImages(markdown, workspaceId, relativePath, contentSources, uploader);

    expect(result.uploadedCount).toBe(1);
    expect(result.failed).toHaveLength(0);
    expect(result.markdown).toContain("https://p1-juejin.byteimg.com/tos-cn-i-test/up.png");
    expect(result.markdown).not.toContain("data:image/png;base64,");
    expect(result.markdown).not.toContain("./assets/diagram.png");
    expect(uploader.uploadImage).toHaveBeenCalledTimes(1);
  });

  it("records failure without base64 fallback when the ImageX upload throws", async () => {
    const { workspaceId, relativePath, contentSources } = setupArticle();
    const uploader = {
      uploadImage: vi.fn(async () => { throw new Error("HTTP 403"); })
    } as unknown as JuejinImageUploader;
    const markdown = "# 测试\n\n![示意图](./assets/diagram.png)\n";
    const result = await inlineJuejinLocalImages(markdown, workspaceId, relativePath, contentSources, uploader);

    // 不再回退 base64：上传失败时原路径保留，标记失败由 channel-service 转 failed。
    expect(result.uploadedCount).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].source).toBe("./assets/diagram.png");
    expect(result.failed[0].reason).toContain("HTTP 403");
    expect(result.markdown).toBe(markdown);
    expect(result.markdown).not.toContain("data:image/png;base64,");
  });

  it("reports partial upload success: counts uploaded and failed independently", async () => {
    const { workspaceId, relativePath, contentSources } = setupArticle();
    const articleDirectory = path.join(sourceDirectory!, "posts", "article");
    fs.writeFileSync(path.join(articleDirectory, "assets", "ok.png"), Buffer.from("ok-bytes", "utf8"));
    fs.writeFileSync(path.join(articleDirectory, "assets", "bad.png"), Buffer.from("bad-bytes", "utf8"));
    const uploadedUrls: string[] = [];
    const uploader = {
      uploadImage: vi.fn(async (buffer: Buffer) => {
        if (buffer.toString("utf8") === "bad-bytes") throw new Error("HTTP 502");
        const id = uploadedUrls.length + 1;
        uploadedUrls.push(`https://p1-juejin.byteimg.com/up-${id}.png`);
        return { url: uploadedUrls[uploadedUrls.length - 1], storeUri: `up-${id}.png` };
      })
    } as unknown as JuejinImageUploader;
    const markdown = "# 测试\n\n![ok](./assets/ok.png)\n\n![bad](./assets/bad.png)\n";
    const result = await inlineJuejinLocalImages(markdown, workspaceId, relativePath, contentSources, uploader);

    expect(result.uploadedCount).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].source).toBe("./assets/bad.png");
    // 任意一张成功上传的图都必须用掘金 CDN URL 替换原路径。
    expect(result.markdown).toMatch(/https:\/\/p1-juejin\.byteimg\.com\/up-\d+\.png/);
    expect(result.markdown).toContain("![bad](./assets/bad.png)");
    expect(result.markdown).not.toContain("data:image/png;base64,");
  });

  it("leaves remote http(s) image URLs untouched (external-link strategy)", async () => {
    const { workspaceId, relativePath, contentSources } = setupArticle();
    const uploader = {
      uploadImage: vi.fn(async () => ({ url: "https://cdn.example/up.png", storeUri: "up.png" }))
    } as unknown as JuejinImageUploader;
    const markdown = "# 测试\n\n![远程图](https://img.example.com/diagram.png)\n";
    const result = await inlineJuejinLocalImages(markdown, workspaceId, relativePath, contentSources, uploader);

    expect(result.uploadedCount).toBe(0);
    expect(result.failed).toHaveLength(0);
    expect(result.markdown).toBe(markdown);
    expect(uploader.uploadImage).not.toHaveBeenCalled();
  });

  it("leaves code-block image syntax untouched", async () => {
    const { workspaceId, relativePath, contentSources } = setupArticle();
    const uploader = {
      uploadImage: vi.fn(async () => ({ url: "https://cdn.example/up.png", storeUri: "up.png" }))
    } as unknown as JuejinImageUploader;
    const markdown = "```md\n![示意图](./assets/diagram.png)\n```\n\n![真实图](./assets/diagram.png)\n";
    const result = await inlineJuejinLocalImages(markdown, workspaceId, relativePath, contentSources, uploader);

    expect(result.uploadedCount).toBe(1);
    expect(result.failed).toHaveLength(0);
    expect(result.markdown).toContain("![示意图](./assets/diagram.png)");
    expect(result.markdown).toContain("https://cdn.example/up.png");
  });

  it("reports a missing local image without crashing", async () => {
    const { workspaceId, relativePath, contentSources } = setupArticle();
    const uploader = {
      uploadImage: vi.fn(async () => ({ url: "https://cdn.example/up.png", storeUri: "up.png" }))
    } as unknown as JuejinImageUploader;
    const markdown = "# 测试\n\n![缺失图](./assets/missing.png)\n";
    const result = await inlineJuejinLocalImages(markdown, workspaceId, relativePath, contentSources, uploader);

    expect(result.uploadedCount).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].source).toBe("./assets/missing.png");
    expect(result.markdown).toBe(markdown);
    expect(uploader.uploadImage).not.toHaveBeenCalled();
  });

  it("leaves data URI images untouched", async () => {
    const { workspaceId, relativePath, contentSources } = setupArticle();
    const uploader = {
      uploadImage: vi.fn(async () => ({ url: "https://cdn.example/up.png", storeUri: "up.png" }))
    } as unknown as JuejinImageUploader;
    const markdown = "# 测试\n\n![内联图](data:image/png;base64,AAAA)\n";
    const result = await inlineJuejinLocalImages(markdown, workspaceId, relativePath, contentSources, uploader);

    expect(result.uploadedCount).toBe(0);
    expect(result.failed).toHaveLength(0);
    expect(result.markdown).toBe(markdown);
    expect(uploader.uploadImage).not.toHaveBeenCalled();
  });
});
