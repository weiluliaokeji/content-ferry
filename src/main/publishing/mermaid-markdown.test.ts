import { describe, expect, it, vi } from "vitest";
import { renderMermaidBlocks, type MermaidRenderer } from "./mermaid-markdown";

function fakeRenderer(fixture: Record<string, Buffer> = {}): MermaidRenderer {
  return (source: string) => Promise.resolve(fixture[source] ?? Buffer.from(`png:${source.length}`));
}

describe("renderMermaidBlocks", () => {
  it("replaces a single mermaid block with an uploaded image reference", async () => {
    const uploadImage = vi.fn(async (_png: Buffer, name: string) => `https://img.example.com/${name}`);
    const markdown = [
      "# 标题",
      "",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
      "",
      "正文。"
    ].join("\n");
    const result = await renderMermaidBlocks(markdown, { uploadImage, renderer: fakeRenderer() });
    expect(uploadImage).toHaveBeenCalledTimes(1);
    expect(result).toContain("![mermaid 图 1](https://img.example.com/mermaid-1.png)");
    expect(result).not.toContain("```mermaid");
    expect(result).toContain("# 标题");
    expect(result).toContain("正文。");
  });

  it("does not touch ordinary code blocks", async () => {
    const markdown = ["```ts", "const a = 1;", "```"].join("\n");
    const result = await renderMermaidBlocks(markdown, { uploadImage: async () => "x", renderer: fakeRenderer() });
    expect(result).toBe(markdown);
  });

  it("numbers multiple mermaid blocks and uploads each", async () => {
    const uploadImage = vi.fn(async (_png: Buffer, name: string) => `https://img.example.com/${name}`);
    const markdown = [
      "```mermaid",
      "graph TD",
      "  A --> B",
      "```",
      "",
      "中间文字",
      "",
      "```mermaid",
      "sequenceDiagram",
      "  A->>B: hi",
      "```"
    ].join("\n");
    const result = await renderMermaidBlocks(markdown, { uploadImage, renderer: fakeRenderer() });
    expect(uploadImage).toHaveBeenCalledTimes(2);
    expect(result).toContain("![mermaid 图 1](https://img.example.com/mermaid-1.png)");
    expect(result).toContain("![mermaid 图 2](https://img.example.com/mermaid-2.png)");
    expect(result).toContain("中间文字");
  });

  it("keeps the original block when rendering fails", async () => {
    const onError = vi.fn();
    const markdown = ["```mermaid", "broken graph", "```"].join("\n");
    const result = await renderMermaidBlocks(markdown, {
      uploadImage: async () => "x",
      renderer: async () => { throw new Error("render failed"); },
      onError
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(result).toBe(markdown);
  });

  it("returns the input unchanged when there is no mermaid block", async () => {
    const markdown = "# 标题\n\n正文，没有图。";
    const result = await renderMermaidBlocks(markdown, { uploadImage: async () => "x", renderer: fakeRenderer() });
    expect(result).toBe(markdown);
  });
});
