import path from "node:path";
import { z } from "zod";
import { TavilyProvider } from "../ai/web-search";
import { loadAppSettings, saveAppSettings } from "../config/first-run";
import {
  credentialInput, modelConnectionInput, modelCustomConnectionInput, modelProviderSchema, skillFileInput,
  skillFileQuery, skillInput, tavilySettingsInput, tavilyTestInput
} from "./schemas";
import type { ServerContext } from "./server-context";

export function registerSettingsRoutes(ctx: ServerContext): void {
  const { server, accounts, appCredentials, getTavilyApiKey, modelConnections, skills, coverGenerator } = ctx;

  server.get("/api/settings/modelscope", async () => ({ configured: appCredentials.configured("modelscope_api_key") }));

  server.put("/api/settings/modelscope", async (request, reply) => {
    const input = credentialInput.parse(request.body);
    appCredentials.save("modelscope_api_key", input.secret);
    return reply.code(204).send();
  });

  server.post("/api/covers/modelscope", async (request, reply) => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const input = z.object({
      projectId: z.string().uuid().optional(),
      relativePath: z.string().trim().min(1).max(1000).optional(),
      prompt: z.string().max(2000).optional()
    }).refine((value) => Boolean(value.projectId) !== Boolean(value.relativePath), "必须指定一篇文章。").parse(request.body);
    try {
      return await coverGenerator.generate({ workspaceId: workspace.id, provider: "modelscope", ...input });
    } catch (error) {
      request.log.warn({ err: error, provider: "modelscope" }, "Cover generation failed");
      return reply.code(400).send({ error: error instanceof Error ? error.message : "ModelScope 生成封面失败。" });
    }
  });

  server.get("/api/model-connections", async () => ({ items: modelConnections.list() }));

  server.get("/api/web-search/settings", async () => ({
    tavilyConfigured: appCredentials.configured("web_search:tavily_api_key") || Boolean(process.env.TAVILY_API_KEY?.trim()),
    tavilyCredentialSource: appCredentials.configured("web_search:tavily_api_key")
      ? "local"
      : process.env.TAVILY_API_KEY?.trim() ? "environment" : "none",
    researchProxyUrl: loadAppSettings().researchProxyUrl?.trim() ?? ""
  }));

  server.put("/api/web-search/tavily", async (request) => {
    const { apiKey } = tavilySettingsInput.parse(request.body);
    appCredentials.save("web_search:tavily_api_key", apiKey);
    return { tavilyConfigured: true, tavilyCredentialSource: "local" };
  });

  server.delete("/api/web-search/tavily", async () => {
    appCredentials.remove("web_search:tavily_api_key");
    return {
      tavilyConfigured: Boolean(process.env.TAVILY_API_KEY?.trim()),
      tavilyCredentialSource: process.env.TAVILY_API_KEY?.trim() ? "environment" : "none"
    };
  });

  const researchProxyInput = z.object({
    proxyUrl: z
      .string()
      .trim()
      .max(1000)
      .refine((value) => {
        if (value === "") return true;
        try {
          const parsed = new URL(value);
          return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "socks5:";
        } catch {
          return false;
        }
      }, "代理地址格式无效，应为 http://、https:// 或 socks5:// 开头的完整地址。")
  });
  server.put("/api/web-search/proxy", async (request) => {
    const { proxyUrl } = researchProxyInput.parse(request.body);
    saveAppSettings({ researchProxyUrl: proxyUrl });
    return { researchProxyUrl: loadAppSettings().researchProxyUrl?.trim() ?? "" };
  });
  server.delete("/api/web-search/proxy", async () => {
    saveAppSettings({ researchProxyUrl: "" });
    return { researchProxyUrl: "" };
  });

  server.post("/api/web-search/tavily/test", async (request, reply) => {
    try {
      const { apiKey } = tavilyTestInput.parse(request.body);
      const key = apiKey ?? getTavilyApiKey();
      if (!key) return reply.code(400).send({ error: "请先填写 Tavily API Key。" });
      const results = await new TavilyProvider(key).search("ContentFerry 文渡", 1);
      return { ok: true, resultCount: results.length };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Tavily 连接测试失败。" });
    }
  });

  server.put("/api/model-connections/:provider", async (request) => {
    const params = z.object({ provider: modelProviderSchema }).parse(request.params);
    const input = modelConnectionInput.parse(request.body);
    return modelConnections.save({ provider: params.provider, ...input });
  });

  server.post("/api/model-connections", async (request) => {
    const input = modelCustomConnectionInput.parse(request.body);
    return modelConnections.createCustom(input);
  });

  server.delete("/api/model-connections/:provider", async (request, reply) => {
    const params = z.object({ provider: modelProviderSchema }).parse(request.params);
    try {
      modelConnections.deleteCustom(params.provider);
      return reply.code(204).send();
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.get("/api/skills", async (_request, reply) => {
    if (!skills) return reply.code(503).send({ error: "技能目录尚未启用。" });
    return { items: skills.list() };
  });

  server.put("/api/skills/:skillId", async (request, reply) => {
    if (!skills) return reply.code(503).send({ error: "技能目录尚未启用。" });
    const params = z.object({ skillId: z.string().regex(/^[a-z0-9-]+$/) }).parse(request.params);
    return skills.save(params.skillId, skillInput.parse(request.body));
  });

  server.get("/api/skills/:skillId/file", async (request, reply) => {
    if (!skills) return reply.code(503).send({ error: "技能目录尚未启用。" });
    const params = z.object({ skillId: z.string().regex(/^[a-z0-9-]+$/) }).parse(request.params);
    const query = skillFileQuery.parse(request.query);
    return skills.readFile(params.skillId, query.path);
  });

  server.put("/api/skills/:skillId/file", async (request, reply) => {
    if (!skills) return reply.code(503).send({ error: "技能目录尚未启用。" });
    const params = z.object({ skillId: z.string().regex(/^[a-z0-9-]+$/) }).parse(request.params);
    const input = skillFileInput.parse(request.body);
    return skills.saveFile(params.skillId, input.path, input.content);
  });

}
