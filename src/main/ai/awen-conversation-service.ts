import { randomUUID } from "node:crypto";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { ModelProvider } from "./model-provider";
import type { SkillRegistry } from "../skills/skill-registry";
import {
  articleChatInput,
  articleChatOutput,
  articleChatSuggestion
} from "../server/schemas";
import { SqliteMemoryStore } from "./memory-store";
import { AgentMemoryRepository } from "./agent-memory-repository";

export type ArticleChatInput = z.infer<typeof articleChatInput>;
export type ArticleChatSuggestion = z.infer<typeof articleChatSuggestion>;

export interface ArticleChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  memorySuggestion: string;
  suggestions: ArticleChatSuggestion[];
  createdAt: string;
}

export interface ArticleChatThread {
  memory: string;
  updatedAt: string | null;
  messages: Array<ArticleChatMessage & { suggestionsJson?: string }>;
}

/**
 * Deep module for the Awen article conversation.
 *
 * HTTP routes should only validate transport input and return this module's
 * result. Prompt construction, history selection, persistence and memory
 * handling stay behind this seam.
 */
export class AwenConversationService {
  private readonly memory: SqliteMemoryStore;
  private readonly formalMemory: AgentMemoryRepository;
  private maintenanceScheduled = false;
  private maintenanceRunning = false;
  private maintenancePending = false;

  constructor(
    private readonly db: Database.Database,
    private readonly provider: ModelProvider,
    private readonly skills?: SkillRegistry,
    private readonly onMaintenanceError?: (error: unknown) => void
  ) {
    this.memory = new SqliteMemoryStore(db);
    this.formalMemory = new AgentMemoryRepository(db);
  }

  getThread(contextKey: string): ArticleChatThread {
    const thread = this.db.prepare("SELECT memory, updated_at FROM article_chat_threads WHERE context_key = ?")
      .get(contextKey) as { memory: string; updated_at: string } | undefined;
    const rows = this.db.prepare(`SELECT id, role, content, memory_suggestion AS memorySuggestion, suggestions_json AS suggestionsJson, created_at AS createdAt
      FROM article_chat_messages WHERE context_key = ? ORDER BY created_at ASC LIMIT 100`)
      .all(contextKey) as Array<{ id: string; role: "user" | "assistant"; content: string; memorySuggestion: string; suggestionsJson: string; createdAt: string }>;
    return {
      memory: thread?.memory ?? "",
      updatedAt: thread?.updated_at ?? null,
      messages: rows.map((item) => ({
        id: item.id,
        role: item.role,
        content: item.content,
        memorySuggestion: item.memorySuggestion,
        suggestions: parseChatSuggestions(item.suggestionsJson),
        createdAt: item.createdAt
      }))
    };
  }

  updateSuggestion(messageId: string, suggestionIndex: number, status: ArticleChatSuggestion["status"]): ArticleChatSuggestion[] | null {
    const row = this.db.prepare("SELECT suggestions_json AS suggestionsJson FROM article_chat_messages WHERE id = ? AND role = 'assistant'")
      .get(messageId) as { suggestionsJson: string } | undefined;
    if (!row) return null;
    const suggestions = parseChatSuggestions(row.suggestionsJson);
    if (!suggestions[suggestionIndex]) return null;
    suggestions[suggestionIndex] = { ...suggestions[suggestionIndex], status };
    this.db.prepare("UPDATE article_chat_messages SET suggestions_json = ? WHERE id = ?")
      .run(JSON.stringify(suggestions), messageId);
    return suggestions;
  }

  async send(input: ArticleChatInput) {
    if (!this.skills) throw new Error("技能目录尚未启用。");
    const skill = this.skills.get("awen-assistant");
    if (!skill.enabled) throw new Error("“阿文 · 文章顾问”技能已停用。");
    const now = new Date().toISOString();
    this.ensureThread(input.contextKey, now);
    const userMessage: ArticleChatMessage = {
      id: input.clientMessageId ?? randomUUID(),
      role: "user",
      content: input.message,
      memorySuggestion: "",
      suggestions: [],
      createdAt: now
    };
    const existing = this.db.prepare("SELECT id FROM article_chat_messages WHERE id = ? AND context_key = ? AND role = 'user'")
      .get(userMessage.id, input.contextKey) as { id: string } | undefined;
    const userEventId = existing
      ? null
      : this.formalMemory.appendEvent({ scopeKey: input.contextKey, eventType: "article_chat.user_message", payload: { messageId: userMessage.id, content: userMessage.content } });
    if (!existing) {
      this.db.prepare(`INSERT INTO article_chat_messages (id, context_key, role, content, memory_suggestion, created_at)
        VALUES (?, ?, 'user', ?, '', ?)`)
        .run(userMessage.id, input.contextKey, userMessage.content, now);
    }

    const thread = this.getThread(input.contextKey);
    const writingMemoryScope = input.accountId ? `account:${input.accountId}` : "workspace:default";
    const platform = input.accountId
      ? (this.db.prepare("SELECT platform FROM media_accounts WHERE id = ? AND deleted_at IS NULL").get(input.accountId) as { platform?: string } | undefined)?.platform
      : undefined;
    const seriesScope = deriveSeriesScope(input.title);
    const writingMemoryScopes = [...new Set(["workspace:default", writingMemoryScope, platform ? `platform:${platform}` : "", seriesScope ?? ""].filter(Boolean))];
    const writingMemory = writingMemoryScopes.map((scope) => this.memory.getWriting(scope)).filter(Boolean).join("\n");
    const articleMemoryScopes = [input.contextKey, ...(seriesScope ? [seriesScope] : []), ...(platform ? [`platform:${platform}`] : [])];
    const articleMemoryContext = this.formalMemory.retrieveContext(articleMemoryScopes, input.message, 8);
    const writingMemoryContext = this.formalMemory.retrieveContext(writingMemoryScopes, input.message, 8);
    const history = thread.messages.slice(-16)
      .map((item) => `${item.role === "user" ? "用户" : "阿文"}：${item.content}`)
      .join("\n\n");
    const article = input.markdown.length > 100000
      ? `${input.markdown.slice(0, 100000)}\n\n[正文过长，已截取前 100000 个字符]`
      : input.markdown;
    const generated = await this.provider.generateStructured({
      task: "assistant",
      skillId: "awen-assistant",
      prompt: buildPrompt(
        input,
        writingMemoryContext.text || writingMemory,
        articleMemoryContext.text || thread.memory,
        history,
        article
      ),
      outputSchema: {
        type: "object",
        properties: {
          reply: { type: "string" },
          memorySuggestion: { type: "string" },
          writingMemorySuggestion: { type: "string" },
          suggestions: {
            type: "array",
            items: {
              type: "object",
              properties: { original: { type: "string" }, replacement: { type: "string" }, reason: { type: "string" } },
              required: ["original", "replacement", "reason"],
              additionalProperties: false
            }
          }
        },
        required: ["reply", "memorySuggestion", "writingMemorySuggestion", "suggestions"],
        additionalProperties: false
      },
      parse: (value) => articleChatOutput.parse(value)
    });
    const suggestions = generated.value.suggestions.filter((item) => isUniqueArticleSuggestion(input.markdown, item.original));
    const assistantMessage: ArticleChatMessage = {
      id: randomUUID(),
      role: "assistant",
      content: generated.value.reply,
      memorySuggestion: generated.value.memorySuggestion,
      suggestions,
      createdAt: new Date().toISOString()
    };
    this.db.prepare(`INSERT INTO article_chat_messages (id, context_key, role, content, memory_suggestion, suggestions_json, created_at)
      VALUES (?, ?, 'assistant', ?, ?, ?, ?)`)
      .run(assistantMessage.id, input.contextKey, assistantMessage.content, assistantMessage.memorySuggestion, JSON.stringify(suggestions), assistantMessage.createdAt);
    const assistantEventId = this.formalMemory.appendEvent({
      scopeKey: input.contextKey,
      eventType: "article_chat.assistant_message",
      payload: { messageId: assistantMessage.id, content: assistantMessage.content, suggestions }
    });
    const sourceEventIds = [userEventId, assistantEventId].filter((value): value is string => Boolean(value));
    if (generated.value.memorySuggestion) {
      this.formalMemory.addCandidate({
        scopeKey: input.contextKey,
        kind: "article_fact",
        content: generated.value.memorySuggestion,
        sourceEventIds
      });
    }
    if (generated.value.writingMemorySuggestion) {
      for (const scopeKey of new Set([writingMemoryScope, ...(platform ? [`platform:${platform}`] : []), ...(seriesScope ? [seriesScope] : [])])) {
        this.formalMemory.addCandidate({ scopeKey, kind: "writing_preference", content: generated.value.writingMemorySuggestion, sourceEventIds });
      }
    }
    this.formalMemory.recordUse([...articleMemoryContext.ids, ...writingMemoryContext.ids], `article-chat:${input.contextKey}`);
    this.scheduleMemoryMaintenance();
    // Candidate summaries stay in the formal candidate store until repeated
    // evidence or explicit promotion. Do not mirror them into the legacy
    // active-memory tables on every chat turn.
    const memory = thread.memory;
    const writingMemoryResult = writingMemory;
    return {
      message: assistantMessage,
      memory,
      writingMemory: writingMemoryResult,
      provider: generated.provider,
      model: generated.model,
      usage: generated.usage
    };
  }

  mergeArticleMemory(contextKey: string, candidate: string): string {
    const eventId = this.formalMemory.appendEvent({ scopeKey: contextKey, eventType: "memory.explicit_confirmation", payload: { content: candidate } });
    const candidateId = this.formalMemory.addCandidate({ scopeKey: contextKey, kind: "article_fact", content: candidate, sourceEventIds: [eventId], confidence: 1, importance: 1 });
    this.formalMemory.promoteCandidate(candidateId);
    return this.memory.mergeArticle(contextKey, candidate);
  }

  private ensureThread(contextKey: string, updatedAt: string): void {
    this.db.prepare(`INSERT INTO article_chat_threads (context_key, memory, updated_at) VALUES (?, '', ?)
      ON CONFLICT(context_key) DO UPDATE SET updated_at = excluded.updated_at`).run(contextKey, updatedAt);
  }

  private scheduleMemoryMaintenance(): void {
    this.maintenancePending = true;
    if (this.maintenanceScheduled || this.maintenanceRunning) return;
    this.maintenanceScheduled = true;
    setTimeout(() => {
      this.maintenanceScheduled = false;
      this.maintenancePending = false;
      if (!this.db.open) return;
      this.maintenanceRunning = true;
      try {
        this.formalMemory.maintain();
      } catch (error) {
        this.onMaintenanceError?.(error);
      } finally {
        this.maintenanceRunning = false;
        if (this.maintenancePending) this.scheduleMemoryMaintenance();
      }
    }, 0);
  }
}

export function parseChatSuggestions(value: string): ArticleChatSuggestion[] {
  try { return z.array(articleChatSuggestion).parse(JSON.parse(value)); }
  catch { return []; }
}

function isUniqueArticleSuggestion(markdown: string, original: string): boolean {
  const first = markdown.indexOf(original);
  return first >= 0 && markdown.indexOf(original, first + original.length) < 0;
}

function deriveSeriesScope(title: string): string | undefined {
  const match = /^(.{2,40}?系列)\s*(?:——|—|：|:|-|$)/u.exec(title.trim());
  return match ? `series:${match[1].trim()}` : undefined;
}

function buildPrompt(input: ArticleChatInput, writingMemory: string, articleMemory: string, history: string, article: string): string {
  return `你正在和作者讨论一篇文章。只基于文章、会话与记忆给出专业、具体、可执行的建议；不虚构事实。

文章标题：${input.title || "未命名"}

写作能力记忆（跨本账号文章，用于持续优化表达与修改策略）：
<memory-context>
${writingMemory || "暂无"}
</memory-context>

本文记忆（由系统从已完成会话自动提炼）：
<memory-context>
${articleMemory || "暂无"}
</memory-context>

最近会话：
${history}

当前文章全文：
${article}

请回答用户最后的问题。输出本文记忆摘要：只记录本篇可复用且已明确的事实、决定或未解决事项。输出写作能力记忆摘要：只记录跨文章稳定有效的风格偏好、读者反馈、修改取舍或表达策略；临时想法、未经核实的信息与闲聊必须留空。若用户明确要求修改、改写、优化或给出可执行文字建议，再返回最多 5 条建议。每条建议的 original 必须是正文中一段完全相同且唯一出现的原文，replacement 是替换文本，reason 说明理由；否则 suggestions 为空。`;
}
