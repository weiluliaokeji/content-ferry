export type MarkdownSelectionRange = { start: number; end: number };

/**
 * Locate Markdown serialized from a ProseMirror selection in the source text.
 * Milkdown normalizes blank lines around headings and other blocks, so an
 * otherwise identical selection may not be an exact source substring.
 */
export function locateMarkdownSelection(source: string, selectedMarkdown: string): MarkdownSelectionRange | undefined {
  const selected = selectedMarkdown.trim();
  if (!selected) return undefined;

  const exactStart = source.indexOf(selected);
  if (exactStart >= 0 && source.indexOf(selected, exactStart + selected.length) < 0) {
    return expandHeadingStart(source, { start: exactStart, end: exactStart + selected.length });
  }

  const compactSource = compactWithOffsets(source);
  const compactSelected = removeWhitespace(selected);
  if (!compactSelected) return undefined;
  const compactStart = compactSource.text.indexOf(compactSelected);
  if (compactStart >= 0 && compactSource.text.indexOf(compactSelected, compactStart + compactSelected.length) < 0) {
    const range = rangeFromCompactedSource(source, compactSource.offsets, compactStart, compactSelected.length);
    return range ? expandHeadingStart(source, range) : undefined;
  }

  // A browser/ProseMirror selection can occasionally expose heading text
  // without its Markdown marker. Match the semantic content, then expand the
  // range back to include the source heading marker so it is preserved.
  const semanticSource = compactWithoutHeadingMarkers(source);
  const semanticSelected = compactWithoutHeadingMarkers(selected);
  const semanticStart = semanticSource.text.indexOf(semanticSelected.text);
  if (semanticStart < 0 || semanticSource.text.indexOf(semanticSelected.text, semanticStart + semanticSelected.text.length) >= 0) {
    return undefined;
  }
  const range = rangeFromCompactedSource(source, semanticSource.offsets, semanticStart, semanticSelected.text.length);
  if (!range) return undefined;
  return expandHeadingStart(source, range);
}

function expandHeadingStart(source: string, range: MarkdownSelectionRange): MarkdownSelectionRange {
  const lineStart = source.lastIndexOf("\n", range.start - 1) + 1;
  if (!/^\s{0,3}#{1,6}\s+$/.test(source.slice(lineStart, range.start))) return range;
  return { start: lineStart, end: range.end };
}

function rangeFromCompactedSource(source: string, offsets: number[], compactStart: number, compactLength: number): MarkdownSelectionRange | undefined {
  const start = offsets[compactStart];
  const lastOffset = offsets[compactStart + compactLength - 1];
  if (start == null || lastOffset == null) return undefined;
  const lastCodePoint = source.codePointAt(lastOffset);
  const lastCharacterLength = lastCodePoint != null && lastCodePoint > 0xffff ? 2 : 1;
  return { start, end: lastOffset + lastCharacterLength };
}

function compactWithOffsets(value: string): { text: string; offsets: number[] } {
  let text = "";
  const offsets: number[] = [];
  for (let offset = 0; offset < value.length;) {
    const codePoint = value.codePointAt(offset);
    if (codePoint == null) break;
    const character = String.fromCodePoint(codePoint);
    if (!/\s/u.test(character)) {
      text += character;
      offsets.push(offset);
    }
    offset += character.length;
  }
  return { text, offsets };
}

function removeWhitespace(value: string): string {
  return value.replace(/\s/gu, "");
}

function compactWithoutHeadingMarkers(value: string): { text: string; offsets: number[] } {
  let text = "";
  const offsets: number[] = [];
  let lineOffset = 0;
  for (const line of value.split(/(?<=\n)/u)) {
    const headingPrefixLength = /^(\s{0,3}#{1,6})\s+/u.exec(line)?.[0].length ?? 0;
    for (let localOffset = headingPrefixLength; localOffset < line.length;) {
      const offset = lineOffset + localOffset;
      const codePoint = value.codePointAt(offset);
      if (codePoint == null) break;
      const character = String.fromCodePoint(codePoint);
      if (!/\s/u.test(character)) {
        text += character;
        offsets.push(offset);
      }
      localOffset += character.length;
    }
    lineOffset += line.length;
  }
  return { text, offsets };
}
