import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  articleChatInput, articleChatMemoryInput, articleChatOutput, articleChatQuery,
  articleChatSuggestionParams, articleChatSuggestionStatusInput, articleSummaryInput,
  articleSummaryOutput, coverPromptInput, coverPromptOutput, selectionEditInput,
  selectionEditOutput
} from "./schemas";
import {
  isUniqueArticleSuggestion, mergeArticleMemory, mergeWritingMemory,
  parseChatSuggestions, persistSelectionEditConversation
} from "./helpers";
import type { ServerContext } from "./server-context";

export function registerChatRoutes(ctx: ServerContext): void {
  const { server, database, accounts, skills, effectiveModelProvider, coverGenerator } = ctx;

  server.get("/api/article-chat", async (request) => {
    const { contextKey } = articleChatQuery.parse(request.query);
    const thread = database.connection.prepare("SELECT memory, updated_at FROM article_chat_threads WHERE context_key = ?")
      .get(contextKey) as { memory: string; updated_at: string } | undefined;
    const rows = database.connection.prepare(`SELECT id, role, content, memory_suggestion AS memorySuggestion, suggestions_json AS suggestionsJson, created_at AS createdAt
      FROM article_chat_messages WHERE context_key = ? ORDER BY created_at ASC LIMIT 100`).all(contextKey) as Array<{ id: string; role: "user" | "assistant"; content: string; memorySuggestion: string; suggestionsJson: string; createdAt: string }>;
    const messages = rows.map((item) => ({ ...item, suggestions: parseChatSuggestions(item.suggestionsJson) }));
    return { memory: thread?.memory ?? "", updatedAt: thread?.updated_at ?? null, messages };
  });

  // A suggestion remains part of the conversation after a decision. Only its
  // status changes, allowing the author to review what Awen proposed later.
  server.patch("/api/article-chat/messages/:messageId/suggestions/:suggestionIndex", async (request, reply) => {
    const { messageId, suggestionIndex } = articleChatSuggestionParams.parse(request.params);
    const { status } = articleChatSuggestionStatusInput.parse(request.body);
    const row = database.connection.prepare("SELECT suggestions_json AS suggestionsJson FROM article_chat_messages WHERE id = ? AND role = 'assistant'")
      .get(messageId) as { suggestionsJson: string } | undefined;
    if (!row) return reply.code(404).send({ error: "未找到对应的阿文建议。" });
    const suggestions = parseChatSuggestions(row.suggestionsJson);
    if (!suggestions[suggestionIndex]) return reply.code(404).send({ error: "未找到对应的阿文建议。" });
    suggestions[suggestionIndex] = { ...suggestions[suggestionIndex], status };
    database.connection.prepare("UPDATE article_chat_messages SET suggestions_json = ? WHERE id = ?")
      .run(JSON.stringify(suggestions), messageId);
    return { messageId, suggestions };
  });

  server.post("/api/article-chat/messages", async (request, reply) => {
    if (!skills) return reply.code(503).send({ error: "技能目录尚未启用。" });
    const skill = skills.get("awen-assistant");
    if (!skill.enabled) return reply.code(409).send({ error: "“阿文 · 文章顾问”技能已停用。" });
    const input = articleChatInput.parse(request.body);
    const now = new Date().toISOString();
    database.connection.prepare(`INSERT INTO article_chat_threads (context_key, memory, updated_at) VALUES (?, '', ?)
      ON CONFLICT(context_key) DO UPDATE SET updated_at = excluded.updated_at`).run(input.contextKey, now);
    const userMessage = { id: input.clientMessageId ?? randomUUID(), role: "user" as const, content: input.message, memorySuggestion: "", createdAt: now };
    const existingUserMessage = database.connection.prepare("SELECT id FROM article_chat_messages WHERE id = ? AND context_key = ? AND role = 'user'")
      .get(userMessage.id, input.contextKey) as { id: string } | undefined;
    if (!existingUserMessage) {
      database.connection.prepare(`INSERT INTO article_chat_messages (id, context_key, role, content, memory_suggestion, created_at)
        VALUES (?, ?, ?, ?, '', ?)`).run(userMessage.id, input.contextKey, userMessage.role, userMessage.content, now);
    }
    const thread = database.connection.prepare("SELECT memory FROM article_chat_threads WHERE context_key = ?").get(input.contextKey) as { memory: string };
    const writingMemoryScope = input.accountId ? `account:${input.accountId}` : "workspace:default";
    const writingMemory = database.connection.prepare("SELECT memory FROM writing_memories WHERE scope_key = ?").get(writingMemoryScope) as { memory: string } | undefined;
    const history = database.connection.prepare(`SELECT role, content FROM article_chat_messages
      WHERE context_key = ? ORDER BY created_at DESC LIMIT 16`).all(input.contextKey) as Array<{ role: "user" | "assistant"; content: string }>;
    const historyText = history.reverse().map((item) => `${item.role === "user" ? "用户" : "阿文"}：${item.content}`).join("\n\n");
    const article = input.markdown.length > 100000 ? `${input.markdown.slice(0, 100000)}\n\n[正文过长，已截取前 100000 个字符]` : input.markdown;
    const generated = await effectiveModelProvider.generateStructured({
      task: "assistant",
      skillId: "awen-assistant",
      prompt: `你正在和作者讨论一篇文章。只基于文章、会话与记忆给出专业、具体、可执行的建议；不虚构事实。\n\n文章标题：${input.title || "未命名"}\n\n写作能力记忆（跨本账号文章，用于持续优化表达与修改策略）：\n${writingMemory?.memory || "暂无"}\n\n本文记忆（由系统从已完成会话自动提炼）：\n${thread.memory || "暂无"}\n\n最近会话：\n${historyText}\n\n当前文章全文：\n${article}\n\n请回答用户最后的问题。输出本文记忆摘要：只记录本篇可复用且已明确的事实、决定或未解决事项。输出写作能力记忆摘要：只记录跨文章稳定有效的风格偏好、读者反馈、修改取舍或表达策略；临时想法、未经核实的信息与闲聊必须留空。若用户明确要求修改、改写、优化或给出可执行文字建议，再返回最多 5 条建议。每条建议的 original 必须是正文中一段完全相同且唯一出现的原文，replacement 是替换文本，reason 说明理由；否则 suggestions 为空。`,
      outputSchema: { type: "object", properties: { reply: { type: "string" }, memorySuggestion: { type: "string" }, writingMemorySuggestion: { type: "string" }, suggestions: { type: "array", items: { type: "object", properties: { original: { type: "string" }, replacement: { type: "string" }, reason: { type: "string" } }, required: ["original", "replacement", "reason"], additionalProperties: false } } }, required: ["reply", "memorySuggestion", "writingMemorySuggestion", "suggestions"], additionalProperties: false },
      parse: (value) => articleChatOutput.parse(value)
    });
    const suggestions = generated.value.suggestions.filter((item) => isUniqueArticleSuggestion(input.markdown, item.original));
    const assistantMessage = { id: randomUUID(), role: "assistant" as const, content: generated.value.reply, memorySuggestion: generated.value.memorySuggestion, suggestions, createdAt: new Date().toISOString() };
    database.connection.prepare(`INSERT INTO article_chat_messages (id, context_key, role, content, memory_suggestion, suggestions_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(assistantMessage.id, input.contextKey, assistantMessage.role, assistantMessage.content, assistantMessage.memorySuggestion, JSON.stringify(suggestions), assistantMessage.createdAt);
    const memory = assistantMessage.memorySuggestion
      ? mergeArticleMemory(database, input.contextKey, assistantMessage.memorySuggestion)
      : thread.memory;
    const writingMemoryResult = generated.value.writingMemorySuggestion
      ? mergeWritingMemory(database, writingMemoryScope, generated.value.writingMemorySuggestion)
      : writingMemory?.memory ?? "";
    return { message: assistantMessage, memory, writingMemory: writingMemoryResult, provider: generated.provider, model: generated.model, usage: generated.usage };
  });

  server.post("/api/article-chat/memory", async (request) => {
    const input = articleChatMemoryInput.parse(request.body);
    const memory = mergeArticleMemory(database, input.contextKey, input.memory);
    return { memory };
  });

  server.post("/api/skills/article-summary/run", async (request, reply) => {
    if (!skills) return reply.code(503).send({ error: "技能目录尚未启用。" });
    const skill = skills.get("article-summary");
    if (!skill.enabled) return reply.code(409).send({ error: "文章摘要生成技能已停用。" });
    const input = articleSummaryInput.parse(request.body);
    const targets = {
      wechat_official: { maxLength: 120, platformName: "微信公众号" },
      csdn: { maxLength: 200, platformName: "CSDN" },
      cnblogs: { maxLength: 120, platformName: "博客园" },
      juejin: { maxLength: 100, platformName: "掘金" }
    } as const;
    const target = targets[input.platform];
    const generated = await effectiveModelProvider.generateStructured({
      task: "summary",
      prompt: `请根据以下原文生成适合${target.platformName}的文章摘要。

硬性要求：
- 摘要最多 ${target.maxLength} 个字符，中文标点也计入；
- 只输出一段摘要，不换行，不使用 Markdown；
- 不得补充原文中没有的事实；
- 标题：${input.title || "未单独提供"}

原文：
${input.markdown}`,
      outputSchema: {
        type: "object",
        properties: { summary: { type: "string", maxLength: target.maxLength } },
        required: ["summary"],
        additionalProperties: false
      },
      parse: (value) => articleSummaryOutput.parse(value)
    });
    const summary = Array.from(generated.value.summary.replace(/\s+/g, " ").trim())
      .slice(0, target.maxLength)
      .join("");
    return {
      summary,
      maxLength: target.maxLength,
      platform: input.platform,
      provider: generated.provider,
      model: generated.model,
      usage: generated.usage
    };
  });

  server.post("/api/skills/selection-edit/run", async (request, reply) => {
    if (!skills) return reply.code(503).send({ error: "技能目录尚未启用。" });
    const input = selectionEditInput.parse(request.body);
    const skillId = input.action === "humanize" ? "humanize-selection" : "selection-edit";
    const skill = skills.get(skillId);
    if (!skill.enabled) return reply.code(409).send({ error: `“${skill.name}”技能已停用。` });
    let actionName = {
      rewrite: "改写得更清楚自然",
      expand: "扩写并补足必要解释",
      shorten: "缩写并保留核心信息",
      example: "补充真实、具体且与上下文一致的案例",
      humanize: "降低套路感和 AI 写作痕迹"
    }[input.action];
    if (input.instruction) {
      actionName = `${actionName}；补充要求：${input.instruction}。补充要求不得突破技能中的事实、引用、Markdown 与不编造规则。`;
    }
    const generated = await effectiveModelProvider.generateStructured({
      task: "selection",
      skillId,
      prompt: `请对选区执行“${actionName}”。

文章标题：${input.title || "未提供"}

选区前文：
${input.beforeText || "无"}

需要处理的选区：
${input.selectedText}

选区后文：
${input.afterText || "无"}

只返回可以直接替换选区的文本。`,
      outputSchema: {
        type: "object",
        properties: { replacement: { type: "string" } },
        required: ["replacement"],
        additionalProperties: false
      },
      parse: (value) => selectionEditOutput.parse(value)
    });
    return {
      replacement: generated.value.replacement,
      provider: generated.provider,
      model: generated.model,
      usage: generated.usage,
      conversation: input.contextKey ? persistSelectionEditConversation(database, input.contextKey, input, generated.value.replacement) : undefined
    };
  });

  server.post("/api/skills/cover-prompt-generation/run", async (request, reply) => {
    if (!skills) return reply.code(503).send({ error: "技能目录尚未启用。" });
    const skill = skills.get("cover-prompt-generation");
    if (!skill.enabled) return reply.code(409).send({ error: "封面提示词生成技能已停用。" });
    const input = coverPromptInput.parse(request.body);
    const generated = await effectiveModelProvider.generateStructured({
      task: "cover_prompt",
      skillId: "cover-prompt-generation",
      prompt: `请根据文章标题和完整正文生成一段可编辑的 16:9 文章封面生图提示词。

文章标题：${input.title || "未单独提供"}

文章正文：
${input.markdown}`,
      outputSchema: {
        type: "object",
        properties: { prompt: { type: "string", maxLength: 2000 } },
        required: ["prompt"],
        additionalProperties: false
      },
      parse: (value) => coverPromptOutput.parse(value)
    });
    return {
      prompt: generated.value.prompt,
      provider: generated.provider,
      model: generated.model,
      usage: generated.usage
    };
  });

  server.post("/api/skills/cover-generation/run", async (request, reply) => {
    if (!skills) return reply.code(503).send({ error: "技能目录尚未启用。" });
    const skill = skills.get("cover-generation");
    if (!skill.enabled) return reply.code(409).send({ error: "文章封面生成技能已停用。" });
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const input = z.object({
      projectId: z.string().uuid().optional(),
      relativePath: z.string().trim().min(1).max(1000).optional(),
      prompt: z.string().max(2000).optional(),
      provider: z.enum(["modelscope", "agnes"]).optional()
    }).refine((value) => Boolean(value.projectId) !== Boolean(value.relativePath), "必须指定一篇文章。").parse(request.body);
    const provider = input.provider ?? skill.provider;
    if (provider !== "modelscope" && provider !== "agnes") {
      return reply.code(400).send({ error: "请在技能设置中选择 ModelScope 或 Agnes AI。" });
    }
    try {
      return await coverGenerator.generate({ workspaceId: workspace.id, ...input, provider });
    } catch (error) {
      request.log.warn({ err: error, provider }, "Cover generation failed");
      return reply.code(400).send({ error: error instanceof Error ? error.message : "封面生成失败。" });
    }
  });

}
