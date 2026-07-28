import { describe, it, expect } from "vitest";
import { consumeStructuredStream, mapCodexEventToStatus } from "./openai-codex-provider";
import type { ThreadEvent } from "@openai/codex-sdk";

async function* toAsyncIterable(events: ThreadEvent[]): AsyncGenerator<ThreadEvent> {
  for (const event of events) yield event;
}

const usage = { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 };

describe("mapCodexEventToStatus", () => {
  it("surfaces the live web-search query", () => {
    const event = { type: "item.started", item: { id: "w", type: "web_search", query: "NVIDIA Build 价格" } } as ThreadEvent;
    expect(mapCodexEventToStatus(event)).toBe("正在检索网页：NVIDIA Build 价格");
  });

  it("returns null for non-progress events", () => {
    expect(mapCodexEventToStatus({ type: "turn.completed", usage })).toBeNull();
  });

  it("maps reasoning and agent_message milestones to Chinese status", () => {
    expect(mapCodexEventToStatus({ type: "item.started", item: { id: "r", type: "reasoning", text: "x" } } as ThreadEvent)).toBe("正在分析并规划内容…");
    expect(mapCodexEventToStatus({ type: "item.completed", item: { id: "a", type: "agent_message", text: "x" } } as ThreadEvent)).toBe("正在整理可追溯内容…");
    expect(mapCodexEventToStatus({ type: "turn.started" })).toBe("正在理解任务要求…");
  });
});

describe("consumeStructuredStream", () => {
  it("extracts JSON from the final agent_message text and reports usage", async () => {
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: "t1" },
      { type: "turn.started" },
      { type: "item.started", item: { id: "a", type: "agent_message", text: "" } },
      { type: "item.updated", item: { id: "a", type: "agent_message", text: '{"title":"示例标题"}' } },
      { type: "item.completed", item: { id: "a", type: "agent_message", text: '{"title":"示例标题"}' } },
      { type: "turn.completed", usage }
    ];
    const statuses: string[] = [];
    const { value, usage: used } = await consumeStructuredStream(toAsyncIterable(events), (message) => statuses.push(message));
    expect(value).toEqual({ title: "示例标题" });
    expect(used).toEqual(usage);
    expect(statuses.length).toBeGreaterThan(0);
  });

  it("throws when no agent_message text is produced", async () => {
    const events: ThreadEvent[] = [
      { type: "turn.started" },
      { type: "turn.completed", usage }
    ];
    await expect(consumeStructuredStream(toAsyncIterable(events))).rejects.toThrow(/没有返回可用内容/);
  });

  it("throws on turn.failed with the underlying message", async () => {
    const events: ThreadEvent[] = [{ type: "turn.failed", error: { message: "rate limited" } }];
    await expect(consumeStructuredStream(toAsyncIterable(events))).rejects.toThrow("rate limited");
  });

  it("throws on a fatal error event with the underlying message", async () => {
    const events: ThreadEvent[] = [{ type: "error", message: "context length exceeded" }];
    await expect(consumeStructuredStream(toAsyncIterable(events))).rejects.toThrow("context length exceeded");
  });
});
