import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const visualMarkdownEditorSource = readFileSync(resolve(__dirname, "./VisualMarkdownEditor.tsx"), "utf8");

describe("visual editor mount lifecycle", () => {
  it("destroys an editor whose create() completes after the effect was cleaned up", () => {
    // React StrictMode remounts every effect once in development: mount →
    // cleanup → mount. The cleanup's crepe.destroy() then runs while
    // Milkdown's create() has not started yet — a no-op that cannot cancel
    // the pending create(), which goes on to mount a second editor into the
    // same root element. That is how one article ended up rendered twice,
    // with two toolbars. The create() chain must therefore re-check the
    // disposed flag before creating and again after create() resolves,
    // destroying the orphan and dropping the empty ProseMirror shell a
    // destroyed view leaves behind.
    expect(visualMarkdownEditorSource).toContain("if (disposed) return undefined;");
    expect(visualMarkdownEditorSource).toContain("void crepe.destroy().then(removeOrphanedEditorShells);");
    expect(visualMarkdownEditorSource).toContain('root.querySelectorAll(":scope > .ProseMirror")');
  });

  it("keeps the cleanup destroy so a mid-create unmount still tears the editor down", () => {
    // The post-create guard covers a create() that finishes after cleanup,
    // but a destroy() issued while create() is still in flight defers 50ms
    // and retries inside Milkdown. The cleanup must keep calling it.
    expect(visualMarkdownEditorSource).toContain("void crepe.destroy();");
  });

  it("keeps code block conversion available in the selection toolbar while the top bar fades", () => {
    expect(visualMarkdownEditorSource).toContain('.addItem("code-block"');
    expect(visualMarkdownEditorSource).toContain('label: "Code block"');
    expect(visualMarkdownEditorSource).toContain('.addItem("inline-code"');
    expect(visualMarkdownEditorSource).toContain('label: "Inline code"');
    expect(visualMarkdownEditorSource).toContain("setBlockTypeCommand.key");
    expect(visualMarkdownEditorSource).toContain("codeBlockSchema.type(ctx)");
    expect(visualMarkdownEditorSource).toContain("toggleInlineCodeCommand.key");
    expect(visualMarkdownEditorSource).toContain('builder.getGroup("block").clear().addItem("code-block"');
    expect(visualMarkdownEditorSource).toContain('item.key === "code"');
    expect(visualMarkdownEditorSource).toContain('blockGroup.addItem("inline-code"');
    expect(visualMarkdownEditorSource).toContain("codeIcon: inlineCodeIcon");
    expect(visualMarkdownEditorSource).toContain("paragraphSchema.type(ctx)");
  });
});
