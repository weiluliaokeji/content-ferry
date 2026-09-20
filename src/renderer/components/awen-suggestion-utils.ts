import type { ArticleChatMessage, ArticleChatSuggestion, ArticleChatSuggestionOperation } from "../types";

type SuggestionLike = Pick<ArticleChatSuggestion, "original" | "replacement"> & {
  reason?: string;
  operation?: ArticleChatSuggestionOperation;
};

type MarkdownRange = { start: number; end: number };

export function suggestionOperation(suggestion: SuggestionLike): ArticleChatSuggestionOperation {
  if (suggestion.operation) return suggestion.operation;
  return /不替换|保留原文|接在.{0,40}(之后|后面)|追加到/u.test(suggestion.reason ?? "")
    ? "insert_after"
    : "replace";
}

export function getAwenAlternativeSuggestionIds(messages: ArticleChatMessage[], selectedId: string): string[] {
  const [messageId, rawIndex] = selectedId.split(":");
  const index = Number(rawIndex);
  if (!messageId || !Number.isInteger(index)) return [];
  const selected = messages.find((message) => message.id === messageId)?.suggestions[index];
  if (!selected) return [];
  const anchorKey = normalizeSuggestionAnchor(selected.original);
  return messages.flatMap((message) => message.role === "assistant"
    ? message.suggestions.flatMap((suggestion, suggestionIndex) => {
      const id = `${message.id}:${suggestionIndex}`;
      if (id === selectedId || (suggestion.status && suggestion.status !== "pending")) return [];
      return normalizeSuggestionAnchor(suggestion.original) === anchorKey ? [id] : [];
    })
    : []);
}

export function findUniqueSuggestionRange(markdown: string, original: string): MarkdownRange | undefined {
  const start = markdown.indexOf(original);
  if (start < 0) return undefined;
  const second = markdown.indexOf(original, start + original.length);
  if (second >= 0) return undefined;
  return { start, end: start + original.length };
}

export function applyAwenSuggestionToMarkdown(markdown: string, suggestion: SuggestionLike): string | undefined {
  const range = findUniqueSuggestionRange(markdown, suggestion.original);
  if (!range) return undefined;
  const operation = suggestionOperation(suggestion);
  if (operation === "replace") {
    return `${markdown.slice(0, range.start)}${suggestion.replacement}${markdown.slice(range.end)}`;
  }
  if (operation === "insert_before") {
    const paragraphStart = findParagraphStart(markdown, range.start);
    return `${markdown.slice(0, paragraphStart)}${suggestion.replacement}\n\n${markdown.slice(paragraphStart)}`;
  }
  const paragraphEnd = findParagraphEnd(markdown, range.end);
  return `${markdown.slice(0, paragraphEnd)}\n\n${suggestion.replacement}${markdown.slice(paragraphEnd)}`;
}

export function isAwenSuggestionApplied(markdown: string, suggestion: SuggestionLike): boolean {
  const operation = suggestionOperation(suggestion);
  const range = findUniqueSuggestionRange(markdown, suggestion.original);
  if (operation === "replace") return !range && markdown.includes(suggestion.replacement);
  if (!range) return false;
  if (operation === "insert_before") {
    const before = markdown.slice(0, range.start);
    return before.endsWith(`${suggestion.replacement}\n\n`)
      || (range.start === suggestion.replacement.length + 2 && markdown.startsWith(`${suggestion.replacement}\n\n`));
  }
  const paragraphEnd = findParagraphEnd(markdown, range.end);
  return markdown.slice(paragraphEnd).startsWith(`\n\n${suggestion.replacement}`);
}

/**
 * A local accept is an explicit user decision. When the accepted text is
 * subsequently edited, the exact replacement is no longer detectable, but
 * an insert suggestion whose original anchor is still present should still
 * be finalized as accepted when the article is saved.
 */
export function shouldPersistAcceptedAwenSuggestion(markdown: string, suggestion: SuggestionLike): boolean {
  return isAwenSuggestionApplied(markdown, suggestion)
    || Boolean(findUniqueSuggestionRange(markdown, suggestion.original));
}

/**
 * Return suggestions that still need an explicit decision before a new Awen
 * turn is sent. Suggestions already applied to the unsaved draft are handled
 * by the save/discard flow and must not be batch-rejected here.
 */
export function getPendingAwenSuggestionIds(
  messages: ArticleChatMessage[],
  markdown: string,
  unsavedSuggestionIds: ReadonlySet<string>
): string[] {
  return messages.flatMap((message) => message.role === "assistant"
    ? message.suggestions.flatMap((suggestion, index) => {
      const id = `${message.id}:${index}`;
      if ((suggestion.status && suggestion.status !== "pending") || unsavedSuggestionIds.has(id)) return [];
      return findUniqueSuggestionRange(markdown, suggestion.original) ? [id] : [];
    })
    : []);
}

function findParagraphStart(markdown: string, position: number): number {
  const previousBreak = markdown.lastIndexOf("\n\n", Math.max(0, position - 1));
  return previousBreak < 0 ? 0 : previousBreak + 2;
}

function findParagraphEnd(markdown: string, position: number): number {
  const nextBreak = markdown.indexOf("\n\n", position);
  return nextBreak < 0 ? markdown.length : nextBreak;
}

function normalizeSuggestionAnchor(value: string): string {
  return value.trim().replace(/\r\n/g, "\n");
}
