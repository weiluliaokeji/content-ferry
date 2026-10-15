import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceSource = readFileSync(resolve(__dirname, "./JuejinDraftWorkspace.tsx"), "utf8");

describe("JuejinDraftWorkspace tag controls", () => {
  it("does not put multiple clickable tag controls inside one label", () => {
    expect(workspaceSource).toContain('<div className="juejin-tag-field">');
    expect(workspaceSource).toContain('<span className="juejin-tag-field-title">标签（必选 1~{JUEJIN_MAX_TAGS} 个）</span>');
    expect(workspaceSource).not.toContain('<label>标签（必选 1~{JUEJIN_MAX_TAGS} 个）');
  });
});
