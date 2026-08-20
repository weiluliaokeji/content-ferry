import fs from "node:fs";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountRepository } from "../accounts/account-repository";
import { ContentSourceService } from "../content/content-source-service";
import { openInMemoryDatabase, type AppDatabase } from "../db/database";
import { CNBLOGS_MAX_IMAGE_BYTES, collectCnblogsImageMatches, uploadCnblogsImages } from "./cnblogs-image-uploader";

describe("collectCnblogsImageMatches", () => {
  it("collects every image reference outside fenced code blocks", () => {
    const markdown = [
      "正文前",
      "![图A](./assets/a.png)",
      "```md",
      "![代码块图](./assets/ignored.png)",
      "```",
      "![远程图](https://example.com/x.png)",
      "![内嵌](data:image/png;base64,QUJD)",
      "![带标题](./assets/c.png \"标题\")"
    ].join("\n");

    const matches = collectCnblogsImageMatches(markdown);

    // 代码块内的图片不计入；远程、data: 与带标题的本地图都会被收集（是否替换由上传阶段决定）。
    expect(matches).toHaveLength(4);
    expect(matches.map((match) => match.source)).toEqual([
      "./assets/a.png",
      "https://example.com/x.png",
      "data:image/png;base64,QUJD",
      "./assets/c.png"
    ]);
    // 标题语法作为完整匹配的一部分被收集。
    expect(matches[3].alt).toBe("带标题");
    expect(matches[3].source).toBe("./assets/c.png");
  });

  it("tracks accurate start/end offsets for replacement", () => {
    const markdown = "a\n\n![图](./assets/a.png)\n\nb";
    const matches = collectCnblogsImageMatches(markdown);
    expect(matches).toHaveLength(1);
    expect(markdown.slice(matches[0].start, matches[0].end)).toBe("![图](./assets/a.png)");
  });
});

describe("uploadCnblogsImages", () => {
  let database: AppDatabase | undefined;
  let sourceDirectory: string | undefined;

  beforeEach(() => {
    uploadImage.mockClear();
  });

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

  function setupSource(): { workspaceId: string; contentSources: ContentSourceService; articleDirectory: string } {
    database = openInMemoryDatabase();
    const accounts = new AccountRepository(database.connection);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-cnblogs-img-"));
    const articleDirectory = path.join(sourceDirectory, "posts", "article");
    fs.mkdirSync(path.join(articleDirectory, "assets"), { recursive: true });
    fs.writeFileSync(path.join(articleDirectory, "index.md"), "---\ntitle: 测试\n---\n", "utf8");
    const contentSources = new ContentSourceService(database.connection);
    contentSources.setSource(workspace.id, sourceDirectory);
    return { workspaceId: workspace.id, contentSources, articleDirectory };
  }

  const uploadImage = vi.fn(async (_source: string, _buffer: Buffer, _mimeType: string, fileName: string) => {
    return `https://img.cnblogs.com/uploads/${fileName}`;
  });

  it("uploads a local image and rewrites the markdown reference", async () => {
    const { workspaceId, contentSources, articleDirectory } = setupSource();
    const imagePath = path.join(articleDirectory, "assets", "diagram.png");
    fs.writeFileSync(imagePath, Buffer.from("fake-png-bytes", "utf8"));

    const result = await uploadCnblogsImages({
      markdown: "# 测试\n\n![示意图](./assets/diagram.png)\n",
      workspaceId,
      sourceRelativePath: "posts/article/index.md",
      contentSources,
      uploadImage
    });

    expect(result.uploadedAssets).toHaveLength(1);
    expect(result.uploadedAssets[0]).toEqual({
      source: "./assets/diagram.png",
      url: "https://img.cnblogs.com/uploads/diagram.png"
    });
    expect(result.failedAssets).toHaveLength(0);
    expect(result.markdown).toContain("![示意图](https://img.cnblogs.com/uploads/diagram.png)");
    expect(result.markdown).not.toContain("./assets/diagram.png");
    expect(uploadImage).toHaveBeenCalledWith(
      "./assets/diagram.png",
      Buffer.from("fake-png-bytes", "utf8"),
      "image/png",
      "diagram.png"
    );
  });

  it("uploads the same local image once and reuses the URL for later occurrences", async () => {
    const { workspaceId, contentSources, articleDirectory } = setupSource();
    fs.writeFileSync(path.join(articleDirectory, "assets", "share.png"), Buffer.from("bytes", "utf8"));

    const result = await uploadCnblogsImages({
      markdown: "![第一处](./assets/share.png)\n\n![第二处](./assets/share.png)\n",
      workspaceId,
      sourceRelativePath: "posts/article/index.md",
      contentSources,
      uploadImage
    });

    expect(uploadImage).toHaveBeenCalledTimes(1);
    expect(result.uploadedAssets).toHaveLength(1);
    const occurrences = result.markdown.match(/https:\/\/img\.cnblogs\.com\/uploads\/share\.png/g);
    expect(occurrences).toHaveLength(2);
  });

  it("inserts an uploaded cover at the very beginning of the markdown", async () => {
    const { workspaceId, contentSources, articleDirectory } = setupSource();
    fs.writeFileSync(path.join(articleDirectory, "assets", "cover.png"), Buffer.from("cover", "utf8"));

    const result = await uploadCnblogsImages({
      markdown: "# 测试\n\n正文\n",
      workspaceId,
      sourceRelativePath: "posts/article/index.md",
      contentSources,
      coverSource: "./assets/cover.png",
      uploadImage
    });

    expect(result.markdown).toBe(
      "![封面](https://img.cnblogs.com/uploads/cover.png)\n\n# 测试\n\n正文\n"
    );
    expect(result.uploadedAssets[0]).toEqual({ source: "./assets/cover.png", url: "https://img.cnblogs.com/uploads/cover.png" });
  });

  it("keeps body image offsets valid when a cover is inserted (regression guard)", async () => {
    const { workspaceId, contentSources, articleDirectory } = setupSource();
    fs.writeFileSync(path.join(articleDirectory, "assets", "cover.png"), Buffer.from("cover", "utf8"));
    fs.writeFileSync(path.join(articleDirectory, "assets", "diagram.png"), Buffer.from("diagram", "utf8"));

    const result = await uploadCnblogsImages({
      markdown: "# 标题\n\n正文一段。\n\n![示意图](./assets/diagram.png)\n",
      workspaceId,
      sourceRelativePath: "posts/article/index.md",
      contentSources,
      coverSource: "./assets/cover.png",
      uploadImage
    });

    // 封面前插后，正文图片的 URL 替换仍落在原始位置，封面 URL 不被截断、不互相污染。
    expect(result.markdown).toBe(
      "![封面](https://img.cnblogs.com/uploads/cover.png)\n\n# 标题\n\n正文一段。\n\n![示意图](https://img.cnblogs.com/uploads/diagram.png)\n"
    );
    expect(result.uploadedAssets).toHaveLength(2);
  });

  it("leaves remote http(s) and data: images untouched", async () => {
    const { workspaceId, contentSources } = setupSource();
    const markdown = "![已托管](https://example.com/x.png)\n\n![内嵌](data:image/png;base64,QUJD)\n";
    const result = await uploadCnblogsImages({
      markdown,
      workspaceId,
      sourceRelativePath: "posts/article/index.md",
      contentSources,
      uploadImage
    });
    expect(result.markdown).toBe(markdown);
    expect(result.uploadedAssets).toHaveLength(0);
    expect(result.failedAssets).toHaveLength(0);
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it("reports images larger than 10 MB as failures and keeps the original reference", async () => {
    const { workspaceId, contentSources, articleDirectory } = setupSource();
    fs.writeFileSync(path.join(articleDirectory, "assets", "huge.png"), Buffer.alloc(CNBLOGS_MAX_IMAGE_BYTES + 1, 1));

    const result = await uploadCnblogsImages({
      markdown: "![大图](./assets/huge.png)\n",
      workspaceId,
      sourceRelativePath: "posts/article/index.md",
      contentSources,
      uploadImage
    });

    expect(result.failedAssets).toHaveLength(1);
    expect(result.failedAssets[0].reason).toContain("超过博客园 10 MB 限制");
    expect(result.uploadedAssets).toHaveLength(0);
    expect(result.markdown).toContain("![大图](./assets/huge.png)");
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it("reports an empty image buffer as a failure", async () => {
    const fakeContentSources = {
      readArticleResource: () => ({ stream: Readable.from([]), mimeType: "image/png" })
    } as unknown as ContentSourceService;

    const result = await uploadCnblogsImages({
      markdown: "![空图](./assets/empty.png)\n",
      workspaceId: "ws",
      sourceRelativePath: "posts/article/index.md",
      contentSources: fakeContentSources,
      uploadImage
    });

    expect(result.failedAssets).toHaveLength(1);
    expect(result.failedAssets[0].reason).toBe("图片内容为空。");
  });

  it("reports a missing local image as a failure without crashing", async () => {
    const { workspaceId, contentSources } = setupSource();
    const result = await uploadCnblogsImages({
      markdown: "![缺失](./assets/missing.png)\n",
      workspaceId,
      sourceRelativePath: "posts/article/index.md",
      contentSources,
      uploadImage
    });

    expect(result.failedAssets).toHaveLength(1);
    expect(result.failedAssets[0].source).toBe("./assets/missing.png");
    expect(result.failedAssets[0].reason).toBeTruthy();
    expect(result.markdown).toContain("![缺失](./assets/missing.png)");
  });

  it("reports a rejected uploadImage call as a failure", async () => {
    const { workspaceId, contentSources, articleDirectory } = setupSource();
    fs.writeFileSync(path.join(articleDirectory, "assets", "bad.png"), Buffer.from("x", "utf8"));
    const failingUpload = vi.fn(async () => {
      throw new Error("图床拒绝上传");
    });

    const result = await uploadCnblogsImages({
      markdown: "![坏图](./assets/bad.png)\n",
      workspaceId,
      sourceRelativePath: "posts/article/index.md",
      contentSources,
      uploadImage: failingUpload
    });

    expect(result.failedAssets).toHaveLength(1);
    expect(result.failedAssets[0].reason).toBe("图床拒绝上传");
  });

  it("reports an empty url returned by uploadImage as a failure", async () => {
    const { workspaceId, contentSources, articleDirectory } = setupSource();
    fs.writeFileSync(path.join(articleDirectory, "assets", "a.png"), Buffer.from("x", "utf8"));
    const emptyUpload = vi.fn(async () => "");

    const result = await uploadCnblogsImages({
      markdown: "![图](./assets/a.png)\n",
      workspaceId,
      sourceRelativePath: "posts/article/index.md",
      contentSources,
      uploadImage: emptyUpload
    });

    expect(result.failedAssets).toHaveLength(1);
    expect(result.failedAssets[0].reason).toBe("博客园没有返回图片地址。");
  });

  it("resolves a contentferry-asset:// cover from the asset store", async () => {
    const { workspaceId, contentSources } = setupSource();
    const bytes = Buffer.from("asset-cover", "utf8");
    const assetStore = {
      readBytes: (_ctx: string, _file: string) => ({ bytes, mimeType: "image/png" })
    } as unknown as import("../content/local-asset-store").LocalAssetStore;

    const result = await uploadCnblogsImages({
      markdown: "正文\n",
      workspaceId,
      sourceRelativePath: "posts/article/index.md",
      contentSources,
      assetStore,
      coverSource: "contentferry-asset://draft-1/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png",
      uploadImage
    });

    expect(result.uploadedAssets).toHaveLength(1);
    expect(result.markdown).toContain("![封面](https://img.cnblogs.com/uploads/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png)");
  });
});
