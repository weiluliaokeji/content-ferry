import { z } from "zod";
import {
  articleChatInput, articleChatMemoryInput, articleChatQuery,
  articleChatSuggestionParams, articleChatSuggestionStatusInput, articleSummaryInput,
  agentMemoryCandidateParams, agentMemoryExportQuery, agentMemoryForgetInput, agentMemoryImportInput, agentMemoryParams, agentMemoryQuery, agentMemoryStatusInput,
  articleSummaryOutput, coverPromptInput, coverPromptOutput, selectionEditInput,
  selectionEditOutput
} from "./schemas";
import {
  persistSelectionEditConversation
} from "./helpers";
import type { ServerContext } from "./server-context";
import { AwenConversationService } from "../ai/awen-conversation-service";
import { AgentMemoryRepository } from "../ai/agent-memory-repository";

export function registerChatRoutes(ctx: ServerContext): void {
  const { server, database, accounts, skills, effectiveModelProvider, coverGenerator } = ctx;
  const awen = new AwenConversationService(
    database.connection,
    effectiveModelProvider,
    skills,
    (error) => server.log.error({ err: error }, "Agent memory maintenance failed")
  );
  const agentMemory = new AgentMemoryRepository(database.connection);

  server.get("/api/article-chat", async (request) => {
    const { contextKey } = articleChatQuery.parse(request.query);
    return awen.getThread(contextKey);
  });

  // A suggestion remains part of the conversation after a decision. Only its
  // status changes, allowing the author to review what Awen proposed later.
  server.patch("/api/article-chat/messages/:messageId/suggestions/:suggestionIndex", async (request, reply) => {
    const { messageId, suggestionIndex } = articleChatSuggestionParams.parse(request.params);
    const { status } = articleChatSuggestionStatusInput.parse(request.body);
    const suggestions = awen.updateSuggestion(messageId, suggestionIndex, status);
    if (!suggestions) return reply.code(404).send({ error: "未找到对应的阿文建议。" });
    return { messageId, suggestions };
  });

  server.post("/api/article-chat/messages", async (request, reply) => {
    if (!skills) return reply.code(503).send({ error: "技能目录尚未启用。" });
    const skill = skills.get("awen-assistant");
    if (!skill.enabled) return reply.code(409).send({ error: "“阿文 · 文章顾问”技能已停用。" });
    const input = articleChatInput.parse(request.body);
    return awen.send(input);
  });

  server.post("/api/article-chat/memory", async (request) => {
    const input = articleChatMemoryInput.parse(request.body);
    const memory = awen.mergeArticleMemory(input.contextKey, input.memory);
    return { memory };
  });

  server.get("/api/agent-memory", async (request) => {
    const input = agentMemoryQuery.parse(request.query);
    const scopeKeys = input.scopeKey.split(",").map((value) => value.trim()).filter(Boolean);
    return {
      memories: agentMemory.listMemories(scopeKeys, input.status),
      candidates: agentMemory.listCandidates(scopeKeys, input.status)
    };
  });

  server.get("/api/agent-memory/export", async (request) => {
    const input = agentMemoryExportQuery.parse(request.query);
    const scopeKeys = input.scopeKey.split(",").map((value) => value.trim()).filter(Boolean);
    return agentMemory.exportSnapshot(scopeKeys, input.includeEvents === "1");
  });

  server.post("/api/agent-memory/import", async (request) => {
    const input = agentMemoryImportInput.parse(request.body);
    return agentMemory.importSnapshot(input.snapshot, input.mode);
  });

  server.post("/api/agent-memory/candidates/:candidateId/promote", async (request) => {
    const { candidateId } = agentMemoryCandidateParams.parse(request.params);
    return { memoryId: agentMemory.promoteCandidate(candidateId) };
  });

  server.patch("/api/agent-memory/:memoryId", async (request, reply) => {
    const { memoryId } = agentMemoryParams.parse(request.params);
    const { status } = agentMemoryStatusInput.parse(request.body);
    if (!agentMemory.setMemoryStatus(memoryId, status)) return reply.code(404).send({ error: "未找到这条记忆。" });
    return { memoryId, status };
  });

  server.post("/api/agent-memory/forget", async (request) => {
    const input = agentMemoryForgetInput.parse(request.body);
    agentMemory.forget(input.scopeKey, input.mode);
    return { scopeKey: input.scopeKey, mode: input.mode, forgotten: true };
  });

  server.post("/api/agent-memory/maintain", async () => agentMemory.maintain());

  server.post("/api/skills/article-summary/run", async (request, reply) => {
    if (!skills) return reply.code(503).send({ error: "技能目录尚未启用。" });
    const skill = skills.get("article-summary");
    if (!skill.enabled) return reply.code(409).send({ error: "文章摘要生成技能已停用。" });
    const input = articleSummaryInput.parse(request.body);
    const targets = {
      wechat_official: { maxLength: 120, platformName: "微信公众号" },
      csdn: { maxLength: 200, platformName: "CSDN" },
      cnblogs: { maxLength: 120, platformName: "博客园" },
      juejin: { maxLength: 100, platformName: "掘金" },
      "51cto": { maxLength: 100, platformName: "51CTO" }
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
    const coverProvider = provider as "modelscope" | "agnes";
    try {
      return await coverGenerator.generate({ workspaceId: workspace.id, ...input, provider: coverProvider });
    } catch (error) {
      request.log.warn({ err: error, provider }, "Cover generation failed");
      return reply.code(400).send({ error: error instanceof Error ? error.message : "封面生成失败。" });
    }
  });

}
