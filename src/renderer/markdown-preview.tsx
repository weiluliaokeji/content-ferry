import { type ReactNode } from "react";
import { apiBase } from "./api";

// 手机预览与图片地址解析（自 main.tsx 拆分）
export function extractMarkdownImages(markdown: string): Array<{ alt: string; src: string }> {
  return [...markdown.matchAll(/!\[([^\]]*)]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)]
    .map((match) => ({ alt: match[1], src: match[2] }));
}

export function resolveArticleImageUrl(source: string, assetContextId: string, sourceArticlePath?: string): string {
  if (/^(?:https?:|data:|blob:)/i.test(source)) return source;
  // contentferry-asset:// references take precedence over article-relative
  // paths: a cover uploaded via /api/content-assets lives in the asset store,
  // not in the VitePress article library, and must be served from there.
  if (source.startsWith("contentferry-asset://")) {
    return `${apiBase}/content-assets/${source.slice("contentferry-asset://".length)}`;
  }
  if (sourceArticlePath) {
    return `${apiBase}/content-source/article-resource?path=${encodeURIComponent(sourceArticlePath)}&src=${encodeURIComponent(source)}`;
  }
  return `${apiBase}/content-assets/${assetContextId}/${source.replace(/^\.?\//, "")}`;
}

export function renderPhonePreview(markdown: string, assetContextId: string, sourceArticlePath: string | undefined, articleTitle: string): ReactNode[] {
  const lines = markdown.split(/\r?\n/);
  const firstHeadingIndex = lines.findIndex((line) => /^#\s+/.test(line));
  if (firstHeadingIndex >= 0) {
    const headingTitle = lines[firstHeadingIndex].replace(/^#\s+/, "").replace(/[*_`]/g, "").trim();
    if (headingTitle.localeCompare(articleTitle.trim(), "zh-CN", { sensitivity: "base" }) === 0) {
      lines.splice(firstHeadingIndex, 1);
    }
  }
  const result: ReactNode[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const codeFence = /^\s*```([\w+-]*)\s*$/.exec(line);
    if (codeFence) {
      const language = codeFence[1];
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      result.push(<div className="preview-code-block" key={`code-${index}`}>{language && <small>{language}</small>}<pre><code>{code.join("\n")}</code></pre></div>);
      continue;
    }
    if (!line.trim()) continue;
    if (isPreviewTableRow(line) && isPreviewTableDelimiter(lines[index + 1] ?? "")) {
      const header = splitPreviewTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && isPreviewTableRow(lines[index])) {
        rows.push(splitPreviewTableRow(lines[index]));
        index += 1;
      }
      index -= 1;
      result.push(<div className="preview-table-scroll" key={`table-${index}`}><table><thead><tr>{header.map((cell, cellIndex) => <th key={cellIndex}>{cleanPreviewText(cell)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{header.map((_cell, cellIndex) => <td key={cellIndex}>{cleanPreviewText(row[cellIndex] ?? "")}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    const image = /^!\[([^\]]*)]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/.exec(line.trim());
    if (image) {
      result.push(<img className="preview-article-image" key={index} src={resolveArticleImageUrl(image[2], assetContextId, sourceArticlePath)} alt={image[1] || "文章图片"} />);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      result.push(<h3 key={index}>{cleanPreviewText(heading[2])}</h3>);
      continue;
    }
    result.push(<p key={index}>{renderPreviewInline(line)}</p>);
  }
  return result;
}

export function isPreviewTableRow(line: string): boolean {
  return line.includes("|") && /^\s*\|?.+\|.+\|?\s*$/.test(line);
}

export function isPreviewTableDelimiter(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

export function splitPreviewTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

export function cleanPreviewText(value: string): string {
  return value.replace(/[*_`>]/g, "");
}

export function renderPreviewInline(value: string): ReactNode[] {
  return value.split(/(`[^`]+`)/g).filter(Boolean).map((part, index) =>
    part.startsWith("`") && part.endsWith("`")
      ? <code className="preview-inline-code" key={index}>{part.slice(1, -1)}</code>
      : <span key={index}>{cleanPreviewText(part)}</span>
  );
}

