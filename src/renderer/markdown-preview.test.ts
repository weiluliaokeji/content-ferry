import { createElement, Fragment, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderPreviewInline, resolveArticleImageUrl } from "./markdown-preview";

function renderInlineToHtml(markdown: string): string {
  const nodes: ReactNode[] = renderPreviewInline(markdown);
  return renderToStaticMarkup(createElement(Fragment, null, ...nodes));
}

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

describe("renderPreviewInline（手机预览高亮）", () => {
  it("高亮跨行内代码时整体标黄", () => {
    // 编辑器层（remark 插件）已正确把这种写法解析为高亮节点；手机预览层用
    // split 把整段当成一个 highlight token，高亮本身生效。已知降级：内联 code
    // 的反引号与下划线被 cleanPreviewText 剥除（computer_use → computeruse），
    // 这是预览层既有行为，不在本次修复范围。
    const html = renderInlineToHtml("==`computer_use` 是 GPT-6 Astra 在 Responses API 下的原生内置工具==");
    expect(html).toContain("<mark");
    expect(html).toContain("原生内置工具");
    expect(html).toContain("computer"); // 字母保留，下划线被剥是已知降级
  });

  it("高亮内只含行内代码也标黄", () => {
    const html = renderInlineToHtml("==`code`==");
    expect(html).toContain("<mark");
    expect(html).toContain("code");
  });
});
