/** Matches a literal excerpt while ignoring formatting-only whitespace differences. */
export function containsLiteralEvidence(source: string, quote: string): boolean {
  if (source.includes(quote)) return true;
  const normalize = (value: string) => value.normalize("NFC").replace(/[\s\u00a0]+/gu, " ").trim();
  const normalizedQuote = normalize(quote);
  return normalizedQuote.length > 0 && normalize(source).includes(normalizedQuote);
}
