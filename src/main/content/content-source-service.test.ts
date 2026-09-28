import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContentSourceService, resolvePracticeCaptureBodyStatus, withSvgIntrinsicSize } from "./content-source-service";
import { AccountRepository } from "../accounts/account-repository";
import { openInMemoryDatabase } from "../db/database";
import { ImageSearchHistoryRepository } from "./image-search-history-repository";

describe("resolvePracticeCaptureBodyStatus", () => {
  it("follows a matching image when moved, detaches removed body references, and flags changed or missing files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-practice-image-link-"));
    try {
      const articleDirectory = path.join(root, "posts", "sample");
      const assetsDirectory = path.join(articleDirectory, "assets");
      fs.mkdirSync(assetsDirectory, { recursive: true });
      const originalBytes = Buffer.from("capture bytes");
      const imagePath = path.join(assetsDirectory, "capture.png");
      const movedPath = path.join(assetsDirectory, "moved.png");
      fs.writeFileSync(imagePath, originalBytes);
      const source = {
        type: "web_capture" as const,
        title: "Demo", sourceUrl: "https://example.com", capturedAt: "2026-09-25T10:00:00.000Z",
        conditions: "Read-only", imagePath: "./assets/capture.png", imageSha256: createHash("sha256").update(originalBytes).digest("hex")
      };
      expect(resolvePracticeCaptureBodyStatus("![demo](./assets/capture.png)", path.join(articleDirectory, "index.md"), assetsDirectory, source))
        .toMatchObject({ bodyStatus: "linked", bodyImagePath: source.imagePath });

      fs.copyFileSync(imagePath, movedPath);
      expect(resolvePracticeCaptureBodyStatus("![demo](./assets/moved.png)", path.join(articleDirectory, "index.md"), assetsDirectory, source))
        .toMatchObject({ bodyStatus: "moved", bodyImagePath: "./assets/moved.png" });
      expect(resolvePracticeCaptureBodyStatus("# no image", path.join(articleDirectory, "index.md"), assetsDirectory, source))
        .toEqual({ bodyStatus: "not_in_body" });

      fs.writeFileSync(imagePath, "cropped or overwritten");
      expect(resolvePracticeCaptureBodyStatus("![demo](./assets/capture.png)", path.join(articleDirectory, "index.md"), assetsDirectory, source))
        .toMatchObject({ bodyStatus: "modified" });
      fs.unlinkSync(imagePath);
      expect(resolvePracticeCaptureBodyStatus("![demo](./assets/capture.png)", path.join(articleDirectory, "index.md"), assetsDirectory, source))
        .toEqual({ bodyStatus: "missing" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

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

  it("saves a webpage screenshot beside the article and keeps a shareable source manifest", async () => {
    const screenshot = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]);
    const saved = contentSources.saveArticlePracticeCapture(workspaceId, "posts/sample/index.md", screenshot.toString("base64"), {
      title: "Demo page",
      sourceUrl: "https://example.com/demo?token=private#session",
      capturedAt: "2026-09-25T10:00:00.000Z",
      conditions: "公开 HTTPS 页面只读打开。"
    });
    expect(saved.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const image = await contentSources.readArticleResource(workspaceId, "posts/sample/index.md", saved.assetUrl);
    expect(await readStreamToBuffer(image.stream)).toEqual(screenshot);
    const manifestPath = path.join(sourceDirectory, "posts", "sample", "assets", ".wendu-practice-sources.json");
    const manifestText = fs.readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(manifestText) as { version: number; sources: Array<Record<string, unknown>> };
    expect(manifest.version).toBe(4);
    expect(manifest.sources).toEqual([{
      type: "web_capture",
      title: "Demo page",
      sourceUrl: "https://example.com/demo",
      capturedAt: "2026-09-25T10:00:00.000Z",
      conditions: "公开 HTTPS 页面只读打开。",
      imagePath: saved.assetUrl,
      imageSha256: saved.sha256
    }]);
    expect(manifestText).not.toContain("token");
    expect(manifestText).not.toContain(sourceDirectory);
  });

  it("saves a local Demo screenshot and portable source details without a local path or fake URL", async () => {
    const screenshot = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const saved = contentSources.saveArticlePracticeDemoCapture(workspaceId, "posts/sample/index.md", screenshot.toString("base64"), {
      title: "示例界面",
      capturedAt: "2026-09-26T10:00:00.000Z",
      conditions: "文渡临时工作区中的本地 HTML Demo；预览禁用外网请求、下载和系统权限。"
    });
    contentSources.saveArticle(workspaceId, "posts/sample/index.md", `---\ntitle: 测试\n---\n\n![Demo](${saved.assetUrl})\n`);
    const source = contentSources.listArticlePracticeSources(workspaceId, "posts/sample/index.md")[0];
    expect(source).toMatchObject({ type: "demo_capture", bodyStatus: "linked", imagePath: saved.assetUrl, imageSha256: saved.sha256 });
    const image = await contentSources.readArticleResource(workspaceId, "posts/sample/index.md", saved.assetUrl);
    expect(await readStreamToBuffer(image.stream)).toEqual(screenshot);

    const manifestPath = path.join(sourceDirectory, "posts", "sample", "assets", ".wendu-practice-sources.json");
    const manifestText = fs.readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(manifestText) as { version: number; sources: Array<Record<string, unknown>> };
    expect(manifest).toMatchObject({ version: 4, sources: [{ type: "demo_capture", imagePath: saved.assetUrl, imageSha256: saved.sha256 }] });
    expect(manifestText).not.toContain(sourceDirectory);
    expect(manifestText).not.toContain("file:");
    expect(manifestText).not.toContain("sourceUrl");

    const croppedBytes = Buffer.from("cropped local Demo screenshot");
    const cropped = contentSources.saveArticleAsset(workspaceId, "posts/sample/index.md", "image/jpeg", croppedBytes.toString("base64"), saved.assetUrl);
    expect(contentSources.listArticlePracticeSources(workspaceId, "posts/sample/index.md").find((item) => item.type === "image_derivative"))
      .toMatchObject({ type: "image_derivative", parentImagePath: saved.assetUrl, parentImageSha256: saved.sha256, imagePath: cropped.assetUrl });
  });

  it("writes and reads command-output screenshot records from the portable source manifest", () => {
    const screenshot = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const saved = contentSources.saveArticlePracticeDemoCapture(workspaceId, "posts/sample/index.md", screenshot.toString("base64"), {
      captureKind: "command_output",
      title: "Scoop 已安装的 Java",
      capturedAt: "2026-09-26T10:00:00.000Z",
      conditions: "根据本次授权的本机命令实际输出生成。"
    });
    contentSources.saveArticle(workspaceId, "posts/sample/index.md", `---\ntitle: 测试\n---\n\n![命令输出](${saved.assetUrl})\n`);

    expect(contentSources.listArticlePracticeSources(workspaceId, "posts/sample/index.md")[0])
      .toMatchObject({ type: "demo_capture", captureKind: "command_output", imagePath: saved.assetUrl, bodyStatus: "linked" });
  });

  it("does not leave an orphan screenshot if the existing manifest is invalid", () => {
    const articleAssetsDirectory = path.join(sourceDirectory, "posts", "sample", "assets");
    fs.writeFileSync(path.join(articleAssetsDirectory, ".wendu-practice-sources.json"), "not json");
    const before = fs.readdirSync(articleAssetsDirectory).length;
    expect(() => contentSources.saveArticlePracticeCapture(workspaceId, "posts/sample/index.md", Buffer.from("png").toString("base64"), {
      title: "Demo page", sourceUrl: "https://example.com/demo", capturedAt: "2026-09-25T10:00:00.000Z", conditions: "公开 HTTPS 页面只读打开。"
    })).toThrow("来源清单格式损坏");
    expect(fs.readdirSync(articleAssetsDirectory)).toHaveLength(before);
  });

  it("tracks screenshot image movement by content hash and keeps evidence after the body link is removed", () => {
    const articlePath = "posts/sample/index.md";
    const screenshot = Buffer.from("practice screenshot bytes");
    const saved = contentSources.saveArticlePracticeCapture(workspaceId, articlePath, screenshot.toString("base64"), {
      title: "Demo page", sourceUrl: "https://example.com/demo", capturedAt: "2026-09-25T10:00:00.000Z", conditions: "公开页面只读验证。"
    });
    contentSources.saveArticle(workspaceId, articlePath, `# 测试\n\n![验证画面](${saved.assetUrl})\n`);
    expect(contentSources.listArticlePracticeSources(workspaceId, articlePath)[0]).toMatchObject({ type: "web_capture", bodyStatus: "linked", bodyImagePath: saved.assetUrl });

    const articleDirectory = path.join(sourceDirectory, "posts", "sample");
    const movedPath = "./assets/moved-practice.png";
    fs.copyFileSync(path.join(articleDirectory, saved.assetUrl.slice(2)), path.join(articleDirectory, movedPath.slice(2)));
    contentSources.saveArticle(workspaceId, articlePath, `# 测试\n\n![验证画面](${movedPath})\n`);
    expect(contentSources.listArticlePracticeSources(workspaceId, articlePath)[0]).toMatchObject({ type: "web_capture", bodyStatus: "moved", bodyImagePath: movedPath });

    contentSources.saveArticle(workspaceId, articlePath, "# 测试\n\n截图已从正文移除。\n");
    expect(contentSources.listArticlePracticeSources(workspaceId, articlePath)[0]).toMatchObject({ type: "web_capture", bodyStatus: "not_in_body", imageSha256: saved.sha256 });
    expect(fs.existsSync(path.join(articleDirectory, saved.assetUrl.slice(2)))).toBe(true);
  });

  it("records a cropped practice screenshot as a separate cover version with parent and child fingerprints", () => {
    const articlePath = "posts/sample/index.md";
    const original = contentSources.saveArticlePracticeCapture(workspaceId, articlePath, Buffer.from("original screenshot").toString("base64"), {
      title: "Interactive demo", sourceUrl: "https://example.com/demo", capturedAt: "2026-09-25T10:00:00.000Z", conditions: "公开页面只读操作。"
    });
    const manifestPath = path.join(sourceDirectory, "posts", "sample", "assets", ".wendu-practice-sources.json");
    const legacyManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { version: number; sources: unknown[] };
    fs.writeFileSync(manifestPath, JSON.stringify({ ...legacyManifest, version: 2 }));
    const croppedBytes = Buffer.from("cropped screenshot pixels");
    const cropped = contentSources.saveArticleAsset(workspaceId, articlePath, "image/jpeg", croppedBytes.toString("base64"), original.assetUrl);
    const sources = contentSources.listArticlePracticeSources(workspaceId, articlePath);
    const derivative = sources.find((source) => source.type === "image_derivative");

    expect(derivative).toMatchObject({
      type: "image_derivative", purpose: "article_cover", parentImagePath: original.assetUrl, parentImageSha256: original.sha256,
      imagePath: cropped.assetUrl, imageSha256: createHash("sha256").update(croppedBytes).digest("hex")
    });
    const manifestText = fs.readFileSync(manifestPath, "utf8");
    expect(JSON.parse(manifestText)).toMatchObject({ version: 4, sources: [{ type: "web_capture" }, { type: "image_derivative" }] });
    expect(manifestText).not.toContain(sourceDirectory);
    fs.writeFileSync(path.join(sourceDirectory, "posts", "sample", cropped.assetUrl.slice(2)), "changed after cropping");
    expect(contentSources.listArticlePracticeSources(workspaceId, articlePath).find((source) => source.type === "image_derivative"))
      .toMatchObject({ parentStatus: "matched", imageStatus: "changed" });
  });

  it("tracks a cropped practice screenshot replaced in the body and keeps its evidence after removal", () => {
    const articlePath = "posts/sample/index.md";
    const original = contentSources.saveArticlePracticeCapture(workspaceId, articlePath, Buffer.from("original screenshot").toString("base64"), {
      title: "Interactive demo", sourceUrl: "https://example.com/demo", capturedAt: "2026-09-25T10:00:00.000Z", conditions: "公开页面只读操作。"
    });
    contentSources.saveArticle(workspaceId, articlePath, `# 测试\n\n![原始截图](${original.assetUrl})\n`);

    const croppedBytes = Buffer.from("body crop pixels");
    const cropped = contentSources.saveArticleAsset(workspaceId, articlePath, "image/jpeg", croppedBytes.toString("base64"), original.assetUrl, "article_body");
    contentSources.saveArticle(workspaceId, articlePath, `# 测试\n\n![正文裁剪版本](${cropped.assetUrl})\n`);

    expect(contentSources.listArticlePracticeSources(workspaceId, articlePath)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "web_capture", bodyStatus: "not_in_body" }),
      expect.objectContaining({ type: "image_derivative", purpose: "article_body", bodyStatus: "linked", bodyImagePath: cropped.assetUrl, imageStatus: "matched" })
    ]));

    contentSources.saveArticle(workspaceId, articlePath, "# 测试\n\n裁剪图已从正文移除。\n");
    expect(contentSources.listArticlePracticeSources(workspaceId, articlePath)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "web_capture", bodyStatus: "not_in_body" }),
      expect.objectContaining({ type: "image_derivative", purpose: "article_body", bodyStatus: "not_in_body", imageStatus: "matched" })
    ]));
    expect(fs.existsSync(path.join(sourceDirectory, "posts", "sample", original.assetUrl.slice(2)))).toBe(true);
    expect(fs.existsSync(path.join(sourceDirectory, "posts", "sample", cropped.assetUrl.slice(2)))).toBe(true);
  });

  it("saves a cover crop from an ordinary article image without treating it as practice evidence", () => {
    const articlePath = "posts/sample/index.md";
    const articleDirectory = path.join(sourceDirectory, "posts", "sample");
    const ordinaryImagePath = path.join(articleDirectory, "images", "existing-cover.png");
    fs.mkdirSync(path.dirname(ordinaryImagePath), { recursive: true });
    fs.writeFileSync(ordinaryImagePath, "ordinary article image");

    const croppedBytes = Buffer.from("ordinary image crop");
    const cropped = contentSources.saveArticleAsset(workspaceId, articlePath, "image/jpeg", croppedBytes.toString("base64"), "./images/existing-cover.png");

    expect(fs.readFileSync(path.join(articleDirectory, cropped.assetUrl.slice(2)))).toEqual(croppedBytes);
    expect(contentSources.listArticlePracticeSources(workspaceId, articlePath)).toEqual([]);
    expect(fs.existsSync(path.join(articleDirectory, "assets", ".wendu-practice-sources.json"))).toBe(false);
  });

  it("links a uniquely saved paragraph to its practice observation and marks changed text for review", () => {
    const paragraph = "实测后确认，示例可以正常生成结果。";
    const articlePath = "posts/sample/index.md";
    contentSources.saveArticle(workspaceId, articlePath, `# 测试\n\n${paragraph}\n`);
    const capture = contentSources.saveArticlePracticeCapture(workspaceId, articlePath, Buffer.from("png").toString("base64"), {
      title: "Demo page", sourceUrl: "https://example.com/demo", capturedAt: "2026-09-25T09:59:00.000Z", conditions: "公开页面只读验证。"
    });
    const linked = contentSources.linkArticlePracticeParagraph(workspaceId, articlePath, {
      title: "代码示例验证", claim: "示例运行成功并输出预期结果。", capturedAt: "2026-09-25T10:00:00.000Z", paragraphText: paragraph,
      conditions: "Windows 本机 · Node.js · Node.js v24.9.0 · 运行成功 · 退出码 0",
      sourceUrl: "https://example.com/demo?token=private#session", screenshotSha256: capture.sha256
    });
    expect(linked.status).toBe("linked");
    expect(linked).toMatchObject({ conditions: "Windows 本机 · Node.js · Node.js v24.9.0 · 运行成功 · 退出码 0", sourceUrl: "https://example.com/demo", screenshotSha256: capture.sha256 });
    expect(linked).not.toHaveProperty("paragraphText");
    expect(contentSources.listArticlePracticeSources(workspaceId, articlePath)).toHaveLength(2);
    expect(contentSources.listArticlePracticeSources(workspaceId, articlePath)).toContainEqual(linked);

    contentSources.saveArticle(workspaceId, articlePath, "# 测试\n\n改写后的结论尚未重新验证。\n");
    expect(contentSources.listArticlePracticeSources(workspaceId, articlePath).find((source) => source.type === "practice_paragraph_link"))
      .toMatchObject({ status: "pending_review", claim: "示例运行成功并输出预期结果。" });
    const manifestText = fs.readFileSync(path.join(sourceDirectory, "posts", "sample", "assets", ".wendu-practice-sources.json"), "utf8");
    expect(manifestText).not.toContain(sourceDirectory);
    expect(manifestText).not.toContain("stdout");
    expect(manifestText).not.toContain(paragraph);
  });

  it("replaces non-shareable runtime paths in portable practice conditions", () => {
    const articlePath = "posts/sample/index.md";
    const paragraph = "本次示例运行成功并生成结果。";
    contentSources.saveArticle(workspaceId, articlePath, `# 测试\n\n${paragraph}\n`);
    const linked = contentSources.linkArticlePracticeParagraph(workspaceId, articlePath, {
      title: "代码运行", claim: "示例生成结果。", capturedAt: "2026-09-25T10:00:00.000Z", paragraphText: paragraph,
      conditions: "Windows 本机 · Python · C:\\Users\\Alice\\private\\python.exe"
    });
    expect(linked.conditions).toBe("运行条件未单独记录。");
    const manifestText = fs.readFileSync(path.join(sourceDirectory, "posts", "sample", "assets", ".wendu-practice-sources.json"), "utf8");
    expect(manifestText).not.toContain("C:\\\\Users");
    expect(manifestText).not.toContain("Alice");
  });

  it("reconnects an edited paragraph only when the proposed replacement is unique and the stored source still matches", () => {
    const original = "实测后确认，示例可以正常生成结果。";
    const revised = "在本次 Windows 环境运行后，示例成功生成预期结果。";
    const articlePath = "posts/sample/index.md";
    contentSources.saveArticle(workspaceId, articlePath, `# 测试\n\n${original}\n`);
    const linked = contentSources.linkArticlePracticeParagraph(workspaceId, articlePath, {
      title: "代码示例验证", claim: "示例运行成功并输出预期结果。", capturedAt: "2026-09-25T10:00:00.000Z", paragraphText: original
    });
    contentSources.saveArticle(workspaceId, articlePath, `# 测试\n\n${revised}\n`);

    expect(contentSources.reanchorArticlePracticeParagraph(workspaceId, articlePath, {
      claim: linked.claim, capturedAt: linked.capturedAt, expectedParagraphSha256: linked.paragraphSha256, paragraphText: `${revised}\n\n${revised}`
    })).toBe(false);
    expect(contentSources.reanchorArticlePracticeParagraph(workspaceId, articlePath, {
      claim: "不同的实践结论", capturedAt: linked.capturedAt, expectedParagraphSha256: linked.paragraphSha256, paragraphText: revised
    })).toBe(false);
    expect(contentSources.listArticlePracticeSources(workspaceId, articlePath).find((source) => source.type === "practice_paragraph_link"))
      .toMatchObject({ status: "pending_review", paragraphSha256: linked.paragraphSha256 });

    expect(contentSources.reanchorArticlePracticeParagraph(workspaceId, articlePath, {
      claim: linked.claim, capturedAt: linked.capturedAt, expectedParagraphSha256: linked.paragraphSha256, paragraphText: revised
    })).toBe(true);
    expect(contentSources.listArticlePracticeSources(workspaceId, articlePath).find((source) => source.type === "practice_paragraph_link"))
      .toMatchObject({ status: "linked", claim: linked.claim });
  });

  it("keeps first-draft practice observations in the portable article manifest without claiming a paragraph match", () => {
    const articlePath = "posts/sample/index.md";
    contentSources.saveArticle(workspaceId, articlePath, "# 测试\n\n本段整合了实践观察。\n");
    const input = {
      title: "阿文实践观察", claim: "示例运行后输出一行结果。", capturedAt: "2026-09-25T10:00:00.000Z",
      conditions: "具体运行条件和原始输出保留在文渡本机实践记录中。", sourceUrl: "https://example.com/demo?session=private#result",
      screenshotSha256: "a".repeat(64)
    };
    const first = contentSources.recordArticlePracticeObservation(workspaceId, articlePath, input);
    const repeated = contentSources.recordArticlePracticeObservation(workspaceId, articlePath, input);
    expect(first).toMatchObject({ type: "practice_observation", status: "pending_review", sourceUrl: "https://example.com/demo", screenshotSha256: "a".repeat(64) });
    expect(repeated).toEqual(first);
    const sources = contentSources.listArticlePracticeSources(workspaceId, articlePath);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toEqual(first);
    const manifestText = fs.readFileSync(path.join(sourceDirectory, "posts", "sample", "assets", ".wendu-practice-sources.json"), "utf8");
    expect(manifestText).not.toContain("session=private");
    expect(manifestText).not.toContain(sourceDirectory);
  });
});

describe("ContentSourceService plain Markdown source", () => {
  it("retrieves relevant historical articles with excerpts and excludes the current article", () => {
    const database = openInMemoryDatabase();
    const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-related-articles-"));
    try {
      fs.mkdirSync(path.join(sourceDirectory, "Markdown", "assets"), { recursive: true });
      fs.mkdirSync(path.join(sourceDirectory, "旅行", "assets"), { recursive: true });
      fs.mkdirSync(path.join(sourceDirectory, "当前", "assets"), { recursive: true });
      fs.mkdirSync(path.join(sourceDirectory, "未发布", "assets"), { recursive: true });
      fs.writeFileSync(path.join(sourceDirectory, "Markdown", "index.md"), "---\ntitle: Markdown 标题层级\nstatus: published\n---\n\n# Markdown 标题层级\n\n标题使用井号表示不同层级，本文讨论标题结构。\n\n另一个无关段落。\n");
      fs.writeFileSync(path.join(sourceDirectory, "旅行", "index.md"), "---\ntitle: 周末旅行\nstatus: published\n---\n\n周末去海边。\n");
      fs.writeFileSync(path.join(sourceDirectory, "当前", "index.md"), "---\ntitle: 当前文章\nstatus: draft\n---\n\nMarkdown 标题层级正在写作。\n");
      fs.writeFileSync(path.join(sourceDirectory, "未发布", "index.md"), "---\ntitle: Markdown 标题草稿\nstatus: draft\n---\n\nMarkdown 标题层级未完成草稿。\n");
      const service = new ContentSourceService(database.connection);
      const workspaceId = new AccountRepository(database.connection).getOrCreateDefaultWorkspace().id;
      service.setSource(workspaceId, sourceDirectory, "plain");

      const results = service.searchRelatedArticles(workspaceId, "Markdown 标题 层级", "当前/index.md");
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        title: "Markdown 标题层级",
        relativePath: "Markdown/index.md",
        excerpt: expect.stringContaining("标题使用井号")
      });
    } finally {
      fs.rmSync(sourceDirectory, { recursive: true, force: true });
      database.close();
    }
  });

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
