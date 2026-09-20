import { describe, expect, it } from "vitest";
import type { WebContents } from "electron";
import { handleWechatAssistConsoleMessage } from "./wechat-automation";

const PREFIX = "__contentferry_wechat_assist__:";

function nativeClickMessage(clickKind: "ai-source-radio" | "ai-source-confirm", x = 120, y = 240): string {
  return PREFIX + JSON.stringify({
    step: "native-click-request",
    details: { source: "editor", clickKind, x, y }
  });
}

describe("WeChat browser assist native clicks", () => {
  it("turns an AI-source click request into a real Electron mouse click", () => {
    const events: Array<Record<string, unknown>> = [];
    let focused = false;
    const webContents = {
      getURL: () => "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit",
      focus: () => { focused = true; },
      sendInputEvent: (event: Record<string, unknown>) => { events.push(event); }
    } as unknown as Pick<WebContents, "getURL" | "focus" | "sendInputEvent">;

    expect(handleWechatAssistConsoleMessage(nativeClickMessage("ai-source-confirm"), webContents)).toBe(true);
    expect(focused).toBe(true);
    expect(events).toEqual([
      { type: "mouseDown", x: 120, y: 240, button: "left", clickCount: 1 },
      { type: "mouseUp", x: 120, y: 240, button: "left", clickCount: 1 }
    ]);
  });

  it("does not dispatch page-requested clicks outside the WeChat origin", () => {
    const events: Array<Record<string, unknown>> = [];
    const webContents = {
      getURL: () => "https://example.com/",
      focus: () => undefined,
      sendInputEvent: (event: Record<string, unknown>) => { events.push(event); }
    } as unknown as Pick<WebContents, "getURL" | "focus" | "sendInputEvent">;

    expect(handleWechatAssistConsoleMessage(nativeClickMessage("ai-source-radio"), webContents)).toBe(true);
    expect(events).toEqual([]);
  });
});
