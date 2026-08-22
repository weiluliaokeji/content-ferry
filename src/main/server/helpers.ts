import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDatabase } from "../db/database";
import { articleChatSuggestion, selectionEditInput } from "./schemas";

export function mergeArticleMemory(database: AppDatabase, contextKey: string, candidate: string): string {
  const normalized = candidate.replace(/\s+/g, " ").trim();
  if (!normalized) return (database.connection.prepare("SELECT memory FROM article_chat_threads WHERE context_key = ?").get(contextKey) as { memory: string } | undefined)?.memory ?? "";
  const row = database.connection.prepare("SELECT memory FROM article_chat_threads WHERE context_key = ?").get(contextKey) as { memory: string } | undefined;
  const entries = (row?.memory ?? "").split("\n").map((item) => item.replace(/^-\s*/, "").trim()).filter(Boolean);
  if (!entries.some((item) => item === normalized)) entries.push(normalized);
  const memory = entries.slice(-20).map((item) => `- ${item}`).join("\n").slice(0, 6000);
  database.connection.prepare(`INSERT INTO article_chat_threads (context_key, memory, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(context_key) DO UPDATE SET memory = excluded.memory, updated_at = excluded.updated_at`)
    .run(contextKey, memory, new Date().toISOString());
  return memory;
}

export function persistResearchConversation(
  database: AppDatabase,
  contextKey: string,
  instruction: string,
  planMarkdown: string,
  sources: Array<{ title: string; url: string }>
): void {
  const userCreatedAt = new Date().toISOString();
  const assistantCreatedAt = new Date(Date.now() + 1).toISOString();
  const sourceSummary = sources.length > 0
    ? `\n\n本轮新增资料：\n${sources.map((source) => `- ${source.title}\n  ${source.url}`).join("\n")}`
    : "\n\n本轮未找到可确认的新增资料。";
  const save = database.connection.transaction(() => {
    database.connection.prepare(`INSERT INTO article_chat_threads (context_key, memory, updated_at) VALUES (?, '', ?)
      ON CONFLICT(context_key) DO UPDATE SET updated_at = excluded.updated_at`).run(contextKey, assistantCreatedAt);
    database.connection.prepare(`INSERT INTO article_chat_messages (id, context_key, role, content, memory_suggestion, suggestions_json, created_at)
      VALUES (?, ?, 'user', ?, '', '[]', ?)`)
      .run(randomUUID(), contextKey, `【补充资料】\n${instruction}`, userCreatedAt);
    database.connection.prepare(`INSERT INTO article_chat_messages (id, context_key, role, content, memory_suggestion, suggestions_json, created_at)
      VALUES (?, ?, 'assistant', ?, '', '[]', ?)`)
      .run(randomUUID(), contextKey, `【补研结果】\n${planMarkdown.trim()}${sourceSummary}`, assistantCreatedAt);
  });
  save();
}

export function mergeWritingMemory(database: AppDatabase, scopeKey: string, candidate: string): string {
  const normalized = candidate.replace(/\s+/g, " ").trim();
  const row = database.connection.prepare("SELECT memory FROM writing_memories WHERE scope_key = ?").get(scopeKey) as { memory: string } | undefined;
  if (!normalized) return row?.memory ?? "";
  const entries = (row?.memory ?? "").split("\n").map((item) => item.replace(/^-\s*/, "").trim()).filter(Boolean);
  if (!entries.includes(normalized)) entries.push(normalized);
  const memory = entries.slice(-30).map((item) => `- ${item}`).join("\n").slice(0, 8000);
  database.connection.prepare(`INSERT INTO writing_memories (scope_key, memory, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(scope_key) DO UPDATE SET memory = excluded.memory, updated_at = excluded.updated_at`)
    .run(scopeKey, memory, new Date().toISOString());
  return memory;
}

export function isUniqueArticleSuggestion(markdown: string, original: string): boolean {
  const first = markdown.indexOf(original);
  return first >= 0 && markdown.indexOf(original, first + original.length) < 0;
}

export function parseChatSuggestions(value: string): Array<{ original: string; replacement: string; reason: string; status: "pending" | "accepted" | "rejected" | "unavailable" }> {
  try { return z.array(articleChatSuggestion).parse(JSON.parse(value)); }
  catch { return []; }
}

export function persistSelectionEditConversation(
  database: AppDatabase,
  contextKey: string,
  input: z.infer<typeof selectionEditInput>,
  replacement: string
): {
  userMessage: { id: string; role: "user"; content: string; memorySuggestion: string; suggestions: []; createdAt: string };
  assistantMessage: { id: string; role: "assistant"; content: string; memorySuggestion: string; suggestions: Array<{ original: string; replacement: string; reason: string }>; createdAt: string };
} {
  const now = new Date().toISOString();
  database.connection.prepare(`INSERT INTO article_chat_threads (context_key, memory, updated_at) VALUES (?, '', ?)
    ON CONFLICT(context_key) DO UPDATE SET updated_at = excluded.updated_at`).run(contextKey, now);
  const userMessage = {
    id: randomUUID(),
    role: "user" as const,
    content: `[选区 AI 编辑 · ${selectionActionLabel(input.action)}]${input.instruction ? `\n要求：${input.instruction}` : ""}\n\n${input.selectedText}`,
    memorySuggestion: "",
    suggestions: [] as [],
    createdAt: now
  };
  database.connection.prepare(`INSERT INTO article_chat_messages (id, context_key, role, content, memory_suggestion, created_at)
    VALUES (?, ?, ?, ?, '', ?)`).run(userMessage.id, contextKey, userMessage.role, userMessage.content, now);
  const suggestions = input.selectedText.trim().length >= 6
    ? [{ original: input.selectedText, replacement, reason: `按“${selectionActionLabel(input.action)}”生成的替换建议${input.instruction ? `；已考虑你的补充要求` : ""}`, status: "pending" as const }]
    : [];
  const assistantMessage = {
    id: randomUUID(),
    role: "assistant" as const,
    content: suggestions.length > 0 ? "已生成一条可应用的选区修改建议。你可以在正文旁或本对话中接受、拒绝，或先查看对比。" : "已生成选区修改结果；选区过短，无法作为可定位的正文建议保存。",
    memorySuggestion: "",
    suggestions,
    createdAt: now
  };
  database.connection.prepare(`INSERT INTO article_chat_messages (id, context_key, role, content, memory_suggestion, suggestions_json, created_at)
    VALUES (?, ?, ?, ?, '', ?, ?)`)
    .run(assistantMessage.id, contextKey, assistantMessage.role, assistantMessage.content, JSON.stringify(suggestions), now);
  return { userMessage, assistantMessage };
}

export function selectionActionLabel(action: z.infer<typeof selectionEditInput>["action"]): string {
  return {
    rewrite: "改写",
    expand: "扩写",
    shorten: "缩写",
    example: "补充案例",
    humanize: "去 AI 味"
  }[action];
}

export async function streamMarkdownGeneration(
  request: FastifyRequest,
  reply: FastifyReply,
  generate: (onDelta: (markdown: string) => void, onStatus: (message: string) => void, signal: AbortSignal) => Promise<{ value: { markdown: string }; provider: string; usage: unknown }>,
  projectId: string,
  sourceRelativePath?: string | null
) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) request.log.warn({ projectId }, "AI generation stream was aborted by the client connection");
    controller.abort();
  };
  request.raw.once("aborted", abort);
  reply.hijack();
  // `reply.hijack()` bypasses Fastify's normal reply lifecycle. That is
  // required for SSE, but also means @fastify/cors does not serialize its
  // headers into `reply.raw`. Without this explicit header Chromium accepts
  // the preflight but rejects the actual stream as a CORS failure, which the
  // renderer can only surface as "Failed to fetch".
  const requestOrigin = request.headers.origin;
  const corsOrigin = requestOrigin === "http://127.0.0.1:5175"
    ? requestOrigin
    : undefined;
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    ...(corsOrigin ? { "access-control-allow-origin": corsOrigin, vary: "Origin" } : {})
  });
  reply.raw.flushHeaders();
  const send = (event: string, data: unknown) => {
    if (!reply.raw.writableEnded) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const startedAt = Date.now();
  send("status", { phase: "connecting", elapsedSeconds: 0, message: "正在连接 AI…" });
  // Codex can spend a while reasoning before its first Markdown item is
  // emitted. Keep the SSE connection visibly alive during that period so the
  // renderer can distinguish "still working" from a frozen dialog.
  let latestPhase = "正在连接 AI…";
  const reportStatus = (message: string) => {
    latestPhase = message;
    send("status", { phase: "generating", elapsedSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)), message });
  };
  const progressTimer = setInterval(() => {
    const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    send("status", {
      phase: "generating",
      elapsedSeconds,
      message: `${latestPhase}（已等待 ${elapsedSeconds} 秒）`
    });
  }, 2_000);
  try {
    const generated = await generate((markdown) => send("delta", { markdown }), reportStatus, controller.signal);
    send("complete", { projectId, markdown: generated.value.markdown, generatedFromBrief: true, sourceRelativePath, provider: generated.provider, usage: generated.usage });
  } catch (error) {
    send("error", { error: error instanceof Error ? error.message : "AI 生成失败。", cancelled: controller.signal.aborted });
  } finally {
    clearInterval(progressTimer);
    request.raw.off("aborted", abort);
    reply.raw.end();
  }
}

export async function streamResearchGeneration(
  request: FastifyRequest,
  reply: FastifyReply,
  projectId: string,
  generate: (onStatus: (message: string) => void) => Promise<{ value: unknown; provider: string; model: string | null; usage: unknown }>,
  save: (value: unknown) => unknown
) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) request.log.warn({ projectId }, "research stream aborted by client connection");
    controller.abort();
  };
  request.raw.once("aborted", abort);
  reply.hijack();
  const requestOrigin = request.headers.origin;
  const corsOrigin = requestOrigin === "http://127.0.0.1:5175" ? requestOrigin : undefined;
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    ...(corsOrigin ? { "access-control-allow-origin": corsOrigin, vary: "Origin" } : {})
  });
  reply.raw.flushHeaders();
  const send = (event: string, data: unknown) => {
    if (!reply.raw.writableEnded) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const startedAt = Date.now();
  let latestPhase = "正在处理…";
  const reportStatus = (message: string) => {
    latestPhase = message;
    send("status", { phase: "researching", elapsedSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)), message });
  };
  const progressTimer = setInterval(() => {
    const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    send("status", { phase: "researching", elapsedSeconds, message: `${latestPhase}（已等待 ${elapsedSeconds} 秒）` });
  }, 2_000);
  try {
    const generated = await generate(reportStatus);
    const research = save(generated.value) as Record<string, unknown>;
    send("complete", { ...research, provider: generated.provider, model: generated.model, usage: generated.usage });
  } catch (error) {
    send("error", { error: error instanceof Error ? error.message : "资料补研失败。", cancelled: controller.signal.aborted });
  } finally {
    clearInterval(progressTimer);
    request.raw.off("aborted", abort);
    reply.raw.end();
  }
}

export function redactLogValue(value: string): string {
  return value
    .replace(/([?&]access_token=)[^&\s]+/gi, "$1***")
    .replace(/((?:api[_-]?key|appsecret|authorization|token)[\"'=:\s]+)[^,\s\"&]+/gi, "$1***");
}

export function describeValidationIssue(issue: z.core.$ZodIssue | undefined): string {
  if (!issue) return "请检查填写内容后重试。";
  const field = ({ topic: "文章主题或想法", title: "文章标题", targetAccountId: "发布账号" } as Record<string, string>)[issue.path.join(".")] ?? "填写内容";
  if (issue.code === "too_big") return `${field}过长。`;
  if (issue.code === "too_small") return `${field}不能为空。`;
  if (issue.code === "invalid_format") return `${field}格式不正确。`;
  return `${field}无效，请检查后重试。`;
}

export function initialArticleTitle(topic: string, title?: string): string {
  if (title) return title;
  const normalizedTopic = topic.replace(/\s+/g, " ").trim();
  if (normalizedTopic.length <= 120) return normalizedTopic;
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
  return `创作草稿-${timestamp}`;
}

export function extractHistoricalSeries(titles: Array<string | null>): Array<{ name: string; count: number; examples: string[] }> {
  const groups = new Map<string, string[]>();
  for (const title of titles) {
    if (!title) continue;
    const match = /^\s*(.{2,40}?系列)\s*(?:——|—|：|:|-)/.exec(title);
    if (!match) continue;
    const name = match[1].replace(/\s+/g, " ").trim();
    if (!name) continue;
    const entries = groups.get(name) ?? [];
    entries.push(title.trim());
    groups.set(name, entries);
  }
  return [...groups.entries()]
    .map(([name, examples]) => ({ name, count: examples.length, examples: examples.slice(0, 3) }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, "zh-CN"))
    .slice(0, 12);
}
