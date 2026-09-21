import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isCurrentImageSearchRequest } from "./image-search-utils";

const rendererStyles = readFileSync(resolve(__dirname, "../styles.css"), "utf8");

describe("image preview layout", () => {
  it("wraps long titles and keeps the full image centered inside the modal", () => {
    const titleRule = rendererStyles.match(/\.image-preview-header h2 \{([^}]*)\}/)?.[1] ?? "";
    const stageRule = rendererStyles.match(/\.image-preview-stage \{([^}]*)\}/)?.[1] ?? "";
    const imageRule = rendererStyles.match(/\.image-preview-stage img \{([^}]*)\}/)?.[1] ?? "";

    expect(titleRule).toMatch(/white-space:\s*normal/);
    expect(titleRule).toMatch(/overflow-wrap:\s*anywhere/);
    expect(stageRule).toMatch(/display:\s*flex/);
    expect(stageRule).toMatch(/justify-content:\s*center/);
    expect(imageRule).toMatch(/max-width:\s*100%/);
    expect(imageRule).toMatch(/max-height:\s*65vh/);
    expect(imageRule).toMatch(/object-fit:\s*contain/);
  });
});

describe("image search request isolation", () => {
  it("only accepts a response for the current request and article context", () => {
    expect(isCurrentImageSearchRequest(2, 2, "source:posts/current/index.md", "source:posts/current/index.md")).toBe(true);
    expect(isCurrentImageSearchRequest(1, 2, "source:posts/current/index.md", "source:posts/current/index.md")).toBe(false);
    expect(isCurrentImageSearchRequest(2, 2, "source:posts/old/index.md", "source:posts/current/index.md")).toBe(false);
  });
});
