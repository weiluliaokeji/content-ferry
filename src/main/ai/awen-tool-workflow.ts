import { z } from "zod";
import type { ContentProjectRepository } from "../content/content-project-repository";
import type { ContentSourceService } from "../content/content-source-service";
import type { GitSourceService } from "../agent/git-source-service";
import type { PermissionGrantRepository } from "../agent/permission-grant-repository";
import type { ToolPermissionGrant } from "../agent/permission-policy";
import type { ToolWorkflowRepository } from "../agent/tool-workflow-repository";
import type { SystemToolRegistry } from "../agent/system-tool-registry";
import { ToolRunner } from "../agent/tool-runner";
import {
  parseModelTurn,
  ToolWorkflowRunner,
  type PermissionResponse,
  type ToolWorkflowModel,
  type ToolWorkflowPolicy,
  type ToolWorkflowSnapshot
} from "../agent/tool-workflow-runner";
import type { ModelProvider } from "./model-provider";
import type { WebSearchClient } from "./web-search";

export interface AwenToolWorkflowServices {
  provider: ModelProvider;
  webSearch?: WebSearchClient;
  systemTools: SystemToolRegistry;
  contentSources: ContentSourceService;
  contentProjects: ContentProjectRepository;
  permissionGrants: PermissionGrantRepository;
  workflowRepository?: ToolWorkflowRepository;
  gitSources: GitSourceService;
}

export interface AwenToolWorkflowContext {
  projectId?: string;
  workspaceId?: string;
  prompt: string;
  onModelResult?: (provider: string, model: string | null) => void;
  validateFinal?: (text: string) => void;
}

export interface AwenToolWorkflowSession {
  runner: ToolWorkflowRunner;
  start: () => Promise<ToolWorkflowSnapshot>;
  respond: (response: PermissionResponse) => Promise<ToolWorkflowSnapshot>;
  restoreWaiting: (snapshot: ToolWorkflowSnapshot) => ToolWorkflowSnapshot;
  resumeInterrupted: (snapshot: ToolWorkflowSnapshot) => Promise<ToolWorkflowSnapshot>;
}

type JsonSchema = Record<string, unknown>;

function strictObject(properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

const nullableTarget = { anyOf: [{ type: "string", maxLength: 2000 }, { type: "null" }] };

const toolCallSchemas: Record<string, JsonSchema> = {
  web_search: strictObject({
    toolId: { type: "string", enum: ["web_search"] },
    action: { type: "string", enum: ["network_read"] },
    target: nullableTarget,
    input: strictObject({ query: { type: "string", minLength: 1 } })
  }),
  list_system_tools: strictObject({
    toolId: { type: "string", enum: ["list_system_tools"] },
    action: { type: "string", enum: ["read"] },
    target: nullableTarget,
    input: strictObject({})
  }),
  read_source_article: strictObject({
    toolId: { type: "string", enum: ["read_source_article"] },
    action: { type: "string", enum: ["read"] },
    target: nullableTarget,
    input: strictObject({ relativePath: { type: "string", minLength: 1 } })
  }),
  git_clone_source: strictObject({
    toolId: { type: "string", enum: ["git_clone_source"] },
    action: { type: "string", enum: ["write"] },
    target: nullableTarget,
    input: strictObject({
      repositoryUrl: { type: "string", minLength: 1 },
      destination: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
      ref: { anyOf: [{ type: "string" }, { type: "null" }] },
      networkPolicy: { type: "string", enum: ["direct", "allowlist"] },
      allowedHosts: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] }
    })
  }),
  git_analyze_source: strictObject({
    toolId: { type: "string", enum: ["git_analyze_source"] },
    action: { type: "string", enum: ["read"] },
    target: nullableTarget,
    input: strictObject({
      repositoryUrl: { type: "string", minLength: 1 },
      destination: { type: "string", minLength: 1 },
      paths: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
      maxLinesPerFile: { anyOf: [{ type: "integer" }, { type: "null" }] }
    })
  })
};

function toolCallArraySchema(toolIds: string[]): JsonSchema {
  return {
    type: "array",
    maxItems: 8,
    items: { anyOf: toolIds.map((toolId) => toolCallSchemas[toolId]) }
  };
}

const toolTurnSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["tool_calls", "final"] },
    text: { anyOf: [{ type: "string", maxLength: 60_000 }, { type: "null" }] },
    calls: { anyOf: [toolCallArraySchema(Object.keys(toolCallSchemas)), { type: "null" }] }
  },
  required: ["kind", "text", "calls"],
  additionalProperties: false
};

function getToolTurnSchema(projectId?: string) {
  const toolIds = projectId
    ? ["web_search", "list_system_tools", "read_source_article", "git_clone_source", "git_analyze_source"]
    : ["web_search", "list_system_tools", "git_clone_source", "git_analyze_source"];
  return {
    ...toolTurnSchema,
    properties: {
      ...toolTurnSchema.properties,
      calls: {
        ...toolTurnSchema.properties.calls,
        anyOf: [toolCallArraySchema(toolIds), { type: "null" }]
      }
    }
  };
}

const toolTurnPrompt = `
你处于 ContentFerry 阿文工具工作流中，只能返回一个 JSON 对象。当前模型会话本身是只读的，不能直接运行命令、写入本机或访问网络；需要这些能力时必须请求下面的应用侧工具，不能回复用户说“环境只读所以无法执行”。
如果用户要求 git clone、下载/固定公开 Git 仓库、分析源码仓库，或直接粘贴 git clone 命令，必须返回 git_clone_source 或 git_analyze_source 的结构化 tool_calls；不得返回 final，不得说“已请求克隆”“等待应用侧授权”“请用户在 PowerShell 执行”，也不得声称工具已经完成。只有收到工具结果后，才能返回 final。
严格输出格式：工具调用必须返回 {"kind":"tool_calls","text":null,"calls":[{"toolId":"工具名","action":"动作","target":string|null,"input":工具对应的输入对象}]}；最终回复必须返回 {"kind":"final","text":"...","calls":null}。每个工具只填写自己的 input 字段：web_search 使用 {"query":string}，list_system_tools 使用 {}，read_source_article 使用 {"relativePath":string}，git_clone_source 使用 {"repositoryUrl":string,"destination":string|null,"ref":string|null,"networkPolicy":"direct"|"allowlist","allowedHosts":string[]|null}，git_analyze_source 使用 {"repositoryUrl":string,"destination":string,"paths":string[]|null,"maxLinesPerFile":number|null}。不适用的可选字段填 null；不要把其他工具的字段塞进 input。未指定 Git clone 目录时 destination 可为 null，应用会创建受控 staging 目录。

可用工具：
- web_search：检索公开资料；action=network_read；input={"query": string}。
- list_system_tools：读取本机已发现的工具及版本；action=read；input={}。
- read_source_article：读取文章库中的另一篇 Markdown；action=read；input={"relativePath": string}。
- git_clone_source：从公开 HTTPS Git 仓库浅克隆到受控 staging 目录；action=write，target=staging 目录，input={"repositoryUrl": string,"destination?": string,"ref?": string,"networkPolicy":"direct"|"allowlist","allowedHosts?": string[]}。用户只给出仓库地址或名称时可以省略 destination，应用会创建临时 staging 目录并在授权卡中展示实际目标。这是高风险操作，应用会先询问用户并在获准后执行。
- git_analyze_source：读取已固定版本的 Git staging 仓库；action=read，target=staging 目录，input={"repositoryUrl": string,"destination": string,"paths?": string[],"maxLinesPerFile?": number}。这是高风险本机取证，应用会先询问用户。

模型绝不能返回 confirmed、permission、grant、lease、authorization 或 approval 字段，也不能把这些字段放入 input；授权只能由应用和用户决定。工具被拒绝后必须在不执行被拒绝操作的前提下重规划，不能重复同一个被拒绝调用来绕过决定。

final.text 必须是 JSON 字符串，内容符合文章助手回复结构：{"reply":string,"memorySuggestion":string,"writingMemorySuggestion":string,"suggestions":array,"imageSearchRequest":object|null}。
`;

const MAX_FINAL_REPAIR_ATTEMPTS = 2;

export function createAwenToolWorkflowSession(services: AwenToolWorkflowServices, context: AwenToolWorkflowContext): AwenToolWorkflowSession {
  let workflowId: string | undefined;
  let runner: ToolWorkflowRunner | undefined;
  const model: ToolWorkflowModel = {
    next: async ({ workflowId: currentWorkflowId, transcript }) => {
      let repairFeedback = "";
      let lastRepairError: Error | undefined;
      for (let repairAttempt = 0; repairAttempt <= MAX_FINAL_REPAIR_ATTEMPTS; repairAttempt += 1) {
        const transcriptText = transcript.map((message) => `[${message.role}] ${message.content}`).join("\n\n");
        const generated = await services.provider.generateStructured({
          task: "assistant",
          skillId: "awen-assistant",
          prependInstructions: false,
          prompt: `${toolTurnPrompt}${context.projectId ? "" : "\n当前文章尚未关联内容项目；不要调用 read_source_article，可直接使用 Git、公开网络和系统工具。"}\n\n${context.prompt}\n\n<tool-workflow-transcript>\n${transcriptText}\n</tool-workflow-transcript>${repairFeedback}\n\n根据当前上下文决定下一步，只返回上述 JSON。`,
          outputSchema: getToolTurnSchema(context.projectId),
          parse: (value) => parseAwenModelTurn(value)
        });
        context.onModelResult?.(generated.provider, generated.model);
        const turn = normalizeToolTurn(generated.value, services.gitSources);
        if (turn.kind === "tool_calls") {
          if (repairAttempt === 0) return turn;
          lastRepairError = new Error("最终回复修复阶段再次返回工具调用；已阻止重复执行已完成的工具。");
        } else {
          try {
            parseWorkflowFinalText(turn.text);
            context.validateFinal?.(turn.text);
            return turn;
          } catch (error) {
            lastRepairError = error instanceof Error ? error : new Error(String(error));
          }
        }
        if (repairAttempt === MAX_FINAL_REPAIR_ATTEMPTS) break;
        runner?.recordModelOutputRepair(currentWorkflowId, "最终回复未通过校验，阿文正在重新整理回复；已完成的工具不会重复执行。", repairAttempt + 1);
        repairFeedback = `\n\n<final-repair-feedback>\n上一轮最终回复未通过应用校验：${describeFinalRepairError(lastRepairError)}\n这是最终回复修复阶段：已经完成的工具调用不能再次执行；请只返回修复后的 final，不要返回 tool_calls。\n</final-repair-feedback>`;
      }
      throw lastRepairError ?? new Error("阿文最终回复修复失败。");
    }
  };

  const toolRunner = new ToolRunner([
    {
      id: "web_search",
      run: async (input, executionContext) => {
        const query = readStringField(input, "query");
        if (!services.webSearch) throw new Error("联网检索服务尚未初始化。");
        const result = await services.webSearch.search(query);
        if (executionContext.signal?.aborted) throw new Error("联网检索已取消。");
        return { query, items: result.slice(0, 8).map((item) => ({ title: item.title, url: item.url, snippet: item.snippet.slice(0, 3500) })) };
      }
    },
    { id: "list_system_tools", run: async () => services.systemTools.list() },
    {
      id: "read_source_article",
      run: async (input) => {
        if (!context.projectId) throw new Error("当前文章尚未关联内容项目，无法读取文章库中的其他文章。");
        const project = services.contentProjects.require(context.projectId);
        const article = services.contentSources.getArticle(project.workspaceId, readStringField(input, "relativePath"));
        return { relativePath: article.relativePath, title: article.title, markdown: article.markdown.slice(0, 20_000) };
      }
    },
    {
      id: "git_clone_source",
      run: async (input, executionContext) => {
        const parsed = gitCloneInput.parse(input);
        const destination = parsed.destination ?? services.gitSources.createAwenStagingDestination(parsed.repositoryUrl);
        const value = { ...parsed, destination };
        services.gitSources.assertAwenWorkspacePath?.(value.destination);
        assertToolTarget(executionContext.target, value.destination);
        return services.gitSources.clone({ ...value, projectId: context.projectId, confirmed: true }, executionContext.signal, executionContext.authorization ?? null);
      }
    },
    {
      id: "git_analyze_source",
      run: async (input, executionContext) => {
        const value = gitAnalyzeInput.parse(input);
        services.gitSources.assertAwenWorkspacePath?.(value.destination);
        assertToolTarget(executionContext.target, value.destination);
        return services.gitSources.analyze({ ...value, projectId: context.projectId, confirmed: true }, executionContext.signal, executionContext.authorization ?? null);
      }
    }
  ]);

  const configuredWorkspaceGrants: ToolPermissionGrant[] = services.gitSources.getAwenWorkspaceRootPath
    ? [
      { scope: "global", decision: "allow", toolId: "git_clone_source", action: "write", targetPrefix: services.gitSources.getAwenWorkspaceRootPath() },
      { scope: "global", decision: "allow", toolId: "git_analyze_source", action: "read", targetPrefix: services.gitSources.getAwenWorkspaceRootPath() }
    ]
    : [];
  const policy: ToolWorkflowPolicy = {
    projectId: context.projectId,
    workspaceId: context.workspaceId,
    grants: [...services.permissionGrants.list(context.projectId), ...configuredWorkspaceGrants],
    defaultAllowReadOnly: true,
    resolveRisk: (request) => request.toolId === "web_search" || request.toolId === "list_system_tools" || request.toolId === "read_source_article" ? "low" : "high"
  };
  runner = new ToolWorkflowRunner(toolRunner, model);
  return {
    runner,
    start: async () => {
      const snapshot = await runner.start(context.prompt, policy);
      workflowId = snapshot.workflowId;
      return snapshot;
    },
    respond: (response) => {
      if (!workflowId) throw new Error("工具工作流尚未启动。");
      return runner.respondToPermission(workflowId, response);
    },
    restoreWaiting: (snapshot) => {
      workflowId = snapshot.workflowId;
      return runner.restoreWaiting(snapshot, policy);
    },
    resumeInterrupted: async (snapshot) => {
      workflowId = snapshot.workflowId;
      return runner.resumeInterrupted(snapshot, policy);
    }
  };
}

export function parseWorkflowFinalText(text: string): unknown {
  try { return JSON.parse(text) as unknown; }
  catch (error) { throw new Error(`阿文工具工作流最终回复不是有效 JSON：${error instanceof Error ? error.message : String(error)}`); }
}

function describeFinalRepairError(error: Error | undefined): string {
  const message = error?.message ?? "未知格式错误";
  return message.length > 1000 ? `${message.slice(0, 1000)}…` : message;
}

function readStringField(value: unknown, field: string): string {
  if (!value || typeof value !== "object") throw new Error("工具输入必须是对象。");
  const item = (value as Record<string, unknown>)[field];
  if (typeof item !== "string" || !item.trim()) throw new Error(`工具输入缺少 ${field}。`);
  return item.trim();
}

function assertToolTarget(target: string | undefined, destination: string): void {
  if (!target || target.trim() !== destination.trim()) throw new Error("工具声明的授权目标与实际 staging 目录不一致。");
}

const gitCloneInput = z.object({
  repositoryUrl: z.string().url().max(2000),
  destination: z.string().trim().min(1).max(2000).optional(),
  ref: z.string().trim().max(200).optional(),
  networkPolicy: z.enum(["allowlist", "direct"]),
  allowedHosts: z.array(z.string().trim().max(255)).max(50).optional()
}).strict();

function normalizeToolTurn(turn: ReturnType<typeof parseModelTurn>, gitSources: GitSourceService): ReturnType<typeof parseModelTurn> {
  if (turn.kind !== "tool_calls") return turn;
  return {
    ...turn,
    calls: turn.calls.map((call) => {
      const input = omitNullFields(call.input);
      if ((call.toolId !== "git_clone_source" && call.toolId !== "git_analyze_source") || !isRecord(input)) {
        return input === call.input ? call : { ...call, input };
      }
      const destination = typeof input.destination === "string" && input.destination.trim()
        ? input.destination.trim()
        : call.toolId === "git_clone_source"
          ? gitSources.createAwenStagingDestination(String(input.repositoryUrl ?? "repository"))
          : undefined;
      return destination && call.target?.trim() === destination && input === call.input
        ? call
        : { ...call, ...(destination ? { target: destination, input: { ...input, destination } } : {}) };
    })
  };
}

function omitNullFields(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const entries = Object.entries(value).filter(([, fieldValue]) => fieldValue !== null);
  return entries.length === Object.keys(value).length ? value : Object.fromEntries(entries);
}

function parseAwenModelTurn(value: unknown): ReturnType<typeof parseModelTurn> {
  return parseModelTurn(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const gitAnalyzeInput = z.object({
  repositoryUrl: z.string().url().max(2000),
  destination: z.string().trim().min(1).max(2000),
  paths: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  maxLinesPerFile: z.number().int().min(20).max(800).default(400)
}).strict();
