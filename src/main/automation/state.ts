import type { BrowserWindow } from "electron";
import type { AppDatabase } from "../db/database";
import type { SearchResultItem } from "../ai/web-search";

// 共享运行时状态（自 index.ts 拆分）
// 采用对象封装以便各模块通过 import 共享并可原地修改字段。

export type WechatBackendTarget = {
  accountId: string;
  title: string;
  declareOriginal: boolean;
  enableReward: boolean;
  collectionName: string;
};

export const state = {
  mainWindow: undefined as BrowserWindow | undefined,
  zhuqueWindow: undefined as BrowserWindow | undefined,
  contentAnyWindow: undefined as BrowserWindow | undefined,
  researchBrowserWindow: undefined as BrowserWindow | undefined,
  wechatBackendWindow: undefined as BrowserWindow | undefined,
  wechatEditorWindow: undefined as BrowserWindow | undefined,
  csdnWindow: undefined as BrowserWindow | undefined,
  juejinGrabWindow: undefined as BrowserWindow | undefined,
  wechatBackendAdvanceTask: undefined as Promise<void> | undefined,
  wechatBackendTarget: undefined as WechatBackendTarget | undefined,
  runtimeDatabase: undefined as AppDatabase | undefined,
  runtimeBootstrapPromise: undefined as Promise<void> | undefined,
  runtimeShutdown: undefined as (() => Promise<void>) | undefined,
  shutdownPromise: undefined as Promise<void> | undefined,
  runtimeInfoLogger: undefined as ((details: Record<string, unknown>, message: string) => void) | undefined,
  // Serializes every visible-browser research call so two overlapping searches
  // can't loadURL over each other (which would mix up results or yank the window
  // out from under a human mid-verification). gstack's Layer-3 handoff assumes a
  // single, stable window for the user to complete — a queue preserves that.
  researchSearchChain: Promise.resolve() as Promise<SearchResultItem[] | void>,
};

export function enqueueResearchSearch(task: () => Promise<SearchResultItem[]>): Promise<SearchResultItem[]> {
  const next = state.researchSearchChain.then(task, task);
  state.researchSearchChain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}
