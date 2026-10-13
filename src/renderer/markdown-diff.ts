export type MarkdownDiffLine = {
  kind: "context" | "added" | "removed";
  text: string;
  oldLine?: number;
  newLine?: number;
};

export type MarkdownDiff = {
  lines: MarkdownDiffLine[];
  added: number;
  removed: number;
};

type Operation = { kind: "context" | "added" | "removed"; text: string };

/**
 * Produces a bounded, line-oriented diff suitable for reviewing Markdown.
 * The dynamic-programming window is capped so an unexpectedly large model
 * response cannot freeze the renderer; in that case the changed middle is
 * represented as one replacement hunk between the shared prefix and suffix.
 */
export function diffMarkdownLines(before: string, after: string): MarkdownDiff {
  const oldLines = before.replace(/\r\n?/g, "\n").split("\n");
  const newLines = after.replace(/\r\n?/g, "\n").split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;

  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;

  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const operations: Operation[] = oldLines.slice(0, prefix).map((text) => ({ kind: "context", text }));
  const MAX_CELLS = 1_000_000;

  if ((oldMiddle.length + 1) * (newMiddle.length + 1) > MAX_CELLS) {
    operations.push(...oldMiddle.map((text) => ({ kind: "removed" as const, text })));
    operations.push(...newMiddle.map((text) => ({ kind: "added" as const, text })));
  } else {
    const width = newMiddle.length + 1;
    const table = Array.from({ length: oldMiddle.length + 1 }, () => new Uint32Array(width));
    for (let oldIndex = oldMiddle.length - 1; oldIndex >= 0; oldIndex -= 1) {
      for (let newIndex = newMiddle.length - 1; newIndex >= 0; newIndex -= 1) {
        table[oldIndex][newIndex] = oldMiddle[oldIndex] === newMiddle[newIndex]
          ? table[oldIndex + 1][newIndex + 1] + 1
          : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
      }
    }
    let oldIndex = 0;
    let newIndex = 0;
    while (oldIndex < oldMiddle.length && newIndex < newMiddle.length) {
      if (oldMiddle[oldIndex] === newMiddle[newIndex]) {
        operations.push({ kind: "context", text: oldMiddle[oldIndex] });
        oldIndex += 1;
        newIndex += 1;
      } else if (table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) {
        operations.push({ kind: "removed", text: oldMiddle[oldIndex] });
        oldIndex += 1;
      } else {
        operations.push({ kind: "added", text: newMiddle[newIndex] });
        newIndex += 1;
      }
    }
    while (oldIndex < oldMiddle.length) operations.push({ kind: "removed", text: oldMiddle[oldIndex++] });
    while (newIndex < newMiddle.length) operations.push({ kind: "added", text: newMiddle[newIndex++] });
  }

  operations.push(...oldLines.slice(oldLines.length - suffix).map((text) => ({ kind: "context" as const, text })));
  let oldLine = 0;
  let newLine = 0;
  const lines = operations.map((operation): MarkdownDiffLine => {
    if (operation.kind === "removed") {
      oldLine += 1;
      return { ...operation, oldLine };
    }
    if (operation.kind === "added") {
      newLine += 1;
      return { ...operation, newLine };
    }
    oldLine += 1;
    newLine += 1;
    return { ...operation, oldLine, newLine };
  });

  return {
    lines,
    added: lines.filter((line) => line.kind === "added").length,
    removed: lines.filter((line) => line.kind === "removed").length
  };
}

export function trimMarkdownDiffContext(diff: MarkdownDiff, context = 3): Array<MarkdownDiffLine | { kind: "omitted"; count: number }> {
  const changed = diff.lines.map((line, index) => line.kind === "context" ? -1 : index).filter((index) => index >= 0);
  if (changed.length === 0) return diff.lines;
  const visible = new Set<number>();
  for (const index of changed) {
    for (let cursor = Math.max(0, index - context); cursor <= Math.min(diff.lines.length - 1, index + context); cursor += 1) visible.add(cursor);
  }
  const result: Array<MarkdownDiffLine | { kind: "omitted"; count: number }> = [];
  let omitted = 0;
  diff.lines.forEach((line, index) => {
    if (!visible.has(index)) {
      omitted += 1;
      return;
    }
    if (omitted) {
      result.push({ kind: "omitted", count: omitted });
      omitted = 0;
    }
    result.push(line);
  });
  if (omitted) result.push({ kind: "omitted", count: omitted });
  return result;
}
