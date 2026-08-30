import type { AccountPlatform, AppSettingsContract } from "./types";

// HTTP API 封装（自 main.tsx 拆分）
export const apiBase = "http://127.0.0.1:4317/api";

export async function loadSettings(): Promise<AppSettingsContract> {
  // On a clean install the first-run wizard is intentionally shown before
  // the local HTTP service/database starts. Prefer preload IPC there; retain
  // the HTTP fallback for browser-only development.
  if (window.contentFerry?.app) {
    return (await window.contentFerry.app.getSettings()) as AppSettingsContract;
  }
  const response = await fetch(`${apiBase}/app/settings`);
  if (!response.ok) {
    throw new Error(`无法读取应用设置（${response.status}）。`);
  }
  return (await response.json()) as AppSettingsContract;
}

export async function patchAppSettings(patch: Partial<AppSettingsContract>): Promise<AppSettingsContract> {
  if (window.contentFerry?.app) {
    return (await window.contentFerry.app.updateSettings(patch)) as AppSettingsContract;
  }
  const response = await fetch(`${apiBase}/app/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch)
  });
  if (!response.ok) {
    throw new Error(`无法保存应用设置（${response.status}）。`);
  }
  return (await response.json()) as AppSettingsContract;
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${apiBase}${path}`, { ...init, headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(payload?.error ?? `本地服务暂不可用（${response.status}）`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function streamGeneration<T>(path: string, signal: AbortSignal, onEvent: (event: string, data: Record<string, unknown>) => void, body?: string): Promise<T> {
  try {
    const response = await fetch(`${apiBase}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: body ?? "{}", signal });
    if (!response.ok || !response.body) throw new Error(`本地服务暂不可用（${response.status}）。`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completed: T | undefined;
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const event = /^event:\s*(.+)$/m.exec(frame)?.[1] ?? "message";
        const raw = /^data:\s*(.+)$/m.exec(frame)?.[1];
        if (!raw) continue;
        const data = JSON.parse(raw) as Record<string, unknown>;
        onEvent(event, data);
        if (event === "error") throw new Error(String(data.error ?? "AI 生成失败。"));
        if (event === "complete") completed = data as T;
      }
      if (done) break;
    }
    if (!completed) throw new Error("AI 生成未返回完成结果。");
    return completed;
  } catch (cause) {
    if (signal.aborted) throw new Error("已停止本次 AI 生成。");
    const message = cause instanceof Error ? cause.message : "";
    if (/BodyStreamBuffer was aborted|stream.*aborted|networkerror/i.test(message)) {
      throw new Error("生成过程中的本地连接被中断，可能是文渡正在重启。请等待窗口稳定后重试。");
    }
    throw cause;
  }
}

export const platformName = (platform: AccountPlatform) => ({ wechat_official: "微信公众号", csdn: "CSDN", cnblogs: "博客园", juejin: "掘金", "51cto": "51CTO" } as const)[platform];

