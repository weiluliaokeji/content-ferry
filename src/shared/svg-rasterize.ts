import { Resvg } from "@resvg/resvg-js";

/**
 * Render SVG bytes to PNG using resvg.
 *
 * Browsers render inline `<img src="...svg">` documents by loading the SVG
 * and resolving every external resource it references (`@import url(...)`,
 * web fonts, images). When those external references fail (sandboxed
 * environments, CSP, offline mode), the SVG keeps its background but loses
 * every glyph. The result is a flat coloured rectangle that authors mistake
 * for a broken image.
 *
 * Rasterizing at the wire boundary sidesteps the problem: by the time the
 * renderer sees the bytes, every external reference has already been
 * replaced by resvg's system-font fallback and the image is self-contained.
 */
export function rasterizeSvgToPng(svgBytes: Buffer): Buffer {
  const svg = svgBytes.toString("utf-8");
  let width = 1200;
  const viewBoxMatch = /\bviewBox\s*=\s*["']([^"']+)["']/i.exec(svg);
  if (viewBoxMatch) {
    const coords = viewBoxMatch[1].trim().split(/[\s,]+/).map(Number);
    if (coords.length === 4 && coords[2] > 0) width = Math.round(coords[2]);
  } else {
    const widthMatch = /\bwidth\s*=\s*["']([0-9.]+)/i.exec(svg);
    if (widthMatch) width = Math.round(Number(widthMatch[1]));
  }
  width = Math.max(1, Math.min(width, 2000));
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: { loadSystemFonts: true, defaultFontFamily: "Microsoft YaHei" }
  });
  return Buffer.from(resvg.render().asPng());
}
