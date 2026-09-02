import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContentSourceService, withSvgIntrinsicSize } from "./content-source-service";
import { AccountRepository } from "../accounts/account-repository";
import { openInMemoryDatabase } from "../db/database";

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

async function readStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
