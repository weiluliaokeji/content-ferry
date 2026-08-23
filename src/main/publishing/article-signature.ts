/**
 * 文章签名：发布草稿时自动追加到正文末尾。
 * 仅在签名非空时追加，正文与签名之间用分隔线隔开。
 */
export function appendArticleSignature(markdown: string, signature: string): string {
  const trimmed = (signature ?? "").trim();
  if (!trimmed) return markdown;
  return `${markdown.replace(/\s+$/, "")}\n\n---\n\n${trimmed}`;
}
