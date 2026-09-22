import { describe, expect, it } from "vitest";
import { createAwenToolWorkflowSession } from "./awen-tool-workflow";
import type { ModelProvider } from "./model-provider";
import type { SearchResultItem, WebSearchClient } from "./web-search";
import type { ContentProjectRepository } from "../content/content-project-repository";
import type { ContentSourceService } from "../content/content-source-service";
import type { GitSourceService } from "../agent/git-source-service";
import type { PermissionGrantRepository } from "../agent/permission-grant-repository";
import type { SystemToolRegistry } from "../agent/system-tool-registry";

describe("Awen tool workflow adapter", () => {
  it("uses the workflow protocol without prepending the legacy assistant skill", async () => {
    const requests: Array<{ prependInstructions?: boolean; outputSchema?: unknown }> = [];
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "final", text: JSON.stringify({ reply: "已完成", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }) }
    ], undefined, undefined, (request) => requests.push(request)), { prompt: "分析仓库" });

    await session.start();
    expect(requests[0]?.prependInstructions).toBe(false);
    const schema = requests[0]?.outputSchema as { properties?: { calls?: { anyOf?: Array<{ items?: { anyOf?: Array<{ properties?: { input?: { type?: string; additionalProperties?: boolean; properties?: Record<string, unknown> } } }> } }> } } } | undefined;
    const callVariants = schema?.properties?.calls?.anyOf?.[0]?.items?.anyOf ?? [];
    expect(callVariants).toHaveLength(4);
    expect(callVariants.some((variant) => variant.properties?.input?.properties?.repositoryUrl)).toBe(true);
    expect(callVariants.every((variant) => variant.properties?.input?.type === "object" && variant.properties?.input?.additionalProperties === false)).toBe(true);
    assertStrictObjectSchemas(requests[0]?.outputSchema);
    assertEveryObjectPropertyIsRequired(requests[0]?.outputSchema);
  });

  it("automatically runs a low-risk web search before the final answer", async () => {
    const searches: string[] = [];
    const webSearch: WebSearchClient = {
      activeProviderId: "test",
      async search(query: string): Promise<SearchResultItem[]> {
        searches.push(query);
        return [{ title: "Result", url: "https://example.com", snippet: "bounded result" }];
      },
      async extract() { return { content: "" }; }
    };
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "tool_calls", calls: [{ toolId: "web_search", action: "network_read", input: { query: "ContentFerry" } }] },
      { kind: "final", text: JSON.stringify({ reply: "已核验", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }) }
    ], webSearch), { prompt: "核验 ContentFerry" });

    const result = await session.start();
    expect(result.status).toBe("completed");
    expect(searches).toEqual(["ContentFerry"]);
    expect(result.transcript.some((item) => item.role === "tool" && item.content.includes("example.com"))).toBe(true);
  });

  it("removes required null placeholders before invoking a tool", async () => {
    const searches: string[] = [];
    const webSearch: WebSearchClient = {
      activeProviderId: "test",
      async search(query: string): Promise<SearchResultItem[]> {
        searches.push(query);
        return [];
      },
      async extract() { return { content: "" }; }
    };
    const session = createAwenToolWorkflowSession(createServices([
      {
        kind: "tool_calls",
        text: null,
        calls: [{
          toolId: "web_search",
          action: "network_read",
          target: null,
          input: {
            query: "ContentFerry",
            relativePath: null,
            repositoryUrl: null,
            destination: null,
            ref: null,
            networkPolicy: null,
            allowedHosts: null,
            paths: null,
            maxLinesPerFile: null
          }
        }]
      },
      { kind: "final", text: JSON.stringify({ reply: "已核验", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }), calls: null }
    ], webSearch), { prompt: "核验 ContentFerry" });

    const result = await session.start();
    expect(result.status).toBe("completed");
    expect(searches).toEqual(["ContentFerry"]);
  });

  it("pauses a high-risk Git operation and continues only after authorization", async () => {
    let cloneCalls = 0;
    const gitSources = { clone: async () => { cloneCalls += 1; return { commitSha: "abc" }; } } as unknown as GitSourceService;
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "tool_calls", calls: [{ toolId: "git_clone_source", action: "write", target: "D:/staging/repo", input: { repositoryUrl: "https://github.com/example/repo", destination: "D:/staging/repo", networkPolicy: "direct" } }] },
      { kind: "final", text: JSON.stringify({ reply: "源码已固定", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }) }
    ], undefined, gitSources), { prompt: "分析仓库" });

    const waiting = await session.start();
    expect(waiting.status).toBe("waiting_user");
    expect(cloneCalls).toBe(0);
    const completed = await session.respond({ decision: "allow", scope: "run" });
    expect(completed.status).toBe("completed");
    expect(cloneCalls).toBe(1);
  });

  it("supplies a controlled staging destination when the user did not specify one", async () => {
    let cloneDestination = "";
    const gitSources = {
      createAwenStagingDestination: () => "D:/contentferry-staging/skills-123",
      clone: async (input: unknown) => {
        cloneDestination = (input as { destination: string }).destination;
        return { commitSha: "abc" };
      }
    } as unknown as GitSourceService;
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "tool_calls", calls: [{ toolId: "git_clone_source", action: "write", input: { repositoryUrl: "https://github.com/mattpocock/skills.git", networkPolicy: "direct" } }] },
      { kind: "final", text: JSON.stringify({ reply: "源码已固定", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }) }
    ], undefined, gitSources), { prompt: "git clone Matt Pocock Skills" });

    const waiting = await session.start();
    expect(waiting.status).toBe("waiting_user");
    expect(waiting.pendingPermission?.request.target).toBe("D:/contentferry-staging/skills-123");
    const completed = await session.respond({ decision: "allow", scope: "run" });
    expect(completed.status).toBe("completed");
    expect(cloneDestination).toBe("D:/contentferry-staging/skills-123");
  });

  it("trusts the configured Awen workspace without a second directory prompt", async () => {
    const workspace = "D:/contentferry-awen-workspace";
    let cloneCalls = 0;
    const gitSources = {
      getAwenWorkspaceRootPath: () => workspace,
      assertAwenWorkspacePath: () => undefined,
      clone: async () => { cloneCalls += 1; return { commitSha: "abc" }; }
    } as unknown as GitSourceService;
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "tool_calls", calls: [{ toolId: "git_clone_source", action: "write", target: `${workspace}/git-sources/repo`, input: { repositoryUrl: "https://github.com/example/repo", destination: `${workspace}/git-sources/repo`, networkPolicy: "direct" } }] },
      { kind: "final", text: JSON.stringify({ reply: "源码已固定", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }) }
    ], undefined, gitSources), { prompt: "分析仓库" });

    const result = await session.start();
    expect(result.status).toBe("completed");
    expect(cloneCalls).toBe(1);
  });

  it("keeps a completed Git side effect audited when the final reply is malformed", async () => {
    const workspace = "D:/contentferry-awen-workspace";
    let cloneCalls = 0;
    const gitSources = {
      getAwenWorkspaceRootPath: () => workspace,
      assertAwenWorkspacePath: () => undefined,
      clone: async () => { cloneCalls += 1; return { commitSha: "abc" }; }
    } as unknown as GitSourceService;
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "tool_calls", calls: [{ toolId: "git_clone_source", action: "write", target: `${workspace}/git-sources/repo`, input: { repositoryUrl: "https://github.com/example/repo", destination: `${workspace}/git-sources/repo`, networkPolicy: "direct" } }] },
      { kind: "final", text: "clone 已完成，但这里不是 JSON" },
      { kind: "final", text: JSON.stringify({ reply: "源码已固定，正在继续处理。", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }) }
    ], undefined, gitSources), { prompt: "git clone 仓库" });

    const result = await session.start();
    expect(cloneCalls).toBe(1);
    expect(result.status).toBe("completed");
    expect(result.toolResults).toHaveLength(1);
    expect(result.finalText).toContain("源码已固定");
    expect(result.events.map((event) => event.type)).toEqual(expect.arrayContaining(["tool_completed", "model_output_repair_requested", "workflow_completed"]));
  });

  it("does not execute a shell command hidden inside a final answer", async () => {
    const session = createAwenToolWorkflowSession(createServices([
      { kind: "final", text: "可以执行：git clone https://github.com/mattpocock/skills.git" },
      { kind: "final", text: "可以执行：git clone https://github.com/mattpocock/skills.git" },
      { kind: "final", text: "可以执行：git clone https://github.com/mattpocock/skills.git" }
    ], undefined, {
      createAwenStagingDestination: () => "D:/contentferry-staging/skills-456",
      clone: async () => ({ commitSha: "abc" })
    } as unknown as GitSourceService), { prompt: "git clone 一下 Matt Pocock Skills" });

    const result = await session.start();
    expect(result.status).toBe("failed");
    expect(result.toolResults).toHaveLength(0);
    expect(result.events.at(-1)?.message).toContain("最终回复不是有效 JSON");
  });
});

function assertStrictObjectSchemas(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertStrictObjectSchemas);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.type === "object") expect(record.additionalProperties).toBe(false);
  Object.values(record).forEach(assertStrictObjectSchemas);
}

function assertEveryObjectPropertyIsRequired(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertEveryObjectPropertyIsRequired);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.type === "object") {
    const properties = record.properties as Record<string, unknown> | undefined;
    const required = record.required as string[] | undefined;
    expect(required ?? []).toEqual(Object.keys(properties ?? {}));
  }
  Object.values(record).forEach(assertEveryObjectPropertyIsRequired);
}

function createServices(turns: unknown[], webSearch?: WebSearchClient, gitSources?: GitSourceService, onRequest?: (request: { prependInstructions?: boolean; outputSchema?: unknown }) => void) {
  let index = 0;
  const provider: ModelProvider = {
    id: "test",
    async generateStructured<T>(request: { parse(value: unknown): T; prependInstructions?: boolean; outputSchema?: unknown }): Promise<{ value: T; provider: string; model: string | null; usage: null }> {
      onRequest?.(request);
      return { value: request.parse(turns[index++]), provider: "test", model: "test-model", usage: null };
    },
    async webResearch() { throw new Error("not used"); }
  };
  return {
    provider,
    webSearch,
    systemTools: { list: async () => [] } as unknown as SystemToolRegistry,
    contentSources: {} as ContentSourceService,
    contentProjects: {} as ContentProjectRepository,
    permissionGrants: { list: () => [] } as unknown as PermissionGrantRepository,
    gitSources: gitSources ?? ({} as GitSourceService)
  };
}
