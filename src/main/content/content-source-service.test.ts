import { describe, expect, it } from "vitest";
import { withSvgIntrinsicSize } from "./content-source-service";

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
