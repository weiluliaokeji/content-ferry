import { describe, expect, it } from "vitest";
import { resolveArticleImageUrl } from "./markdown-preview";

describe("resolveArticleImageUrl", () => {
  it("returns the source untouched when it is already an http(s) URL", () => {
    expect(resolveArticleImageUrl("https://cdn.example.com/foo.png", "ctx", "post/index.md")).toBe("https://cdn.example.com/foo.png");
    expect(resolveArticleImageUrl("http://example.org/bar.png", "ctx", "post/index.md")).toBe("http://example.org/bar.png");
  });

  it("returns data URIs and blob URIs untouched", () => {
    const dataUri = "data:image/png;base64,AAAA";
    expect(resolveArticleImageUrl(dataUri, "ctx", "post/index.md")).toBe(dataUri);
    const blobUri = "blob:https://example.com/abc";
    expect(resolveArticleImageUrl(blobUri, "ctx", "post/index.md")).toBe(blobUri);
  });

  it("routes contentferry-asset:// references through the asset store endpoint", () => {
    expect(resolveArticleImageUrl("contentferry-asset://abc/def.png", "ctx"))
      .toMatch(/\/content-assets\/abc\/def\.png$/);
  });

  it("asks the server to rasterize SVGs so the local editor renders them as PNG", () => {
    const url = resolveArticleImageUrl("./assets/langchain-line.svg", "ctx", "posts/article/index.md");
    expect(url).toContain("path=posts%2Farticle%2Findex.md");
    expect(url).toContain("src=.%2Fassets%2Flangchain-line.svg");
    expect(url).toContain("rasterize=1");
    // The &rasterize=1 suffix must not be mistaken for an SVG by the regex
    // when the same helper is called for a PNG (covers the false-positive
    // branch that would otherwise rasterize every image).
    const pngUrl = resolveArticleImageUrl("./assets/diagram.png", "ctx", "posts/article/index.md");
    expect(pngUrl).toContain("rasterize=0");
  });

  it("treats query-string suffixes on the SVG URL as still being an SVG", () => {
    const url = resolveArticleImageUrl("./assets/diagram.svg?v=1", "ctx", "posts/article/index.md");
    expect(url).toContain("rasterize=1");
  });
});
