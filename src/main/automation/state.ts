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
  cnblogsOptionsWindow: undefined as BrowserWindow | undefined,
  // 当前 CSDN 编辑器窗口所载的发布任务 id。用于区分「重新打开」是复用仍存活的
  // 已填充窗口（轻量：只提到前台 + 重启对话框轮询）还是需要重跑完整辅助流程
  // （重新抓稿、重传图片、重填编辑器）。窗口销毁时清空。
  csdnWindowJobId: undefined as string | undefined,
  // 已上传到 CSDN 图床的「本地 source → 图片 URL」映射缓存，按 jobId 索引。
  // 用途：窗口被关闭后再点「重新打开 CSDN 后台」会走完整流程（csdnWindowJobId
  // 已随窗口销毁清空），此时若缓存命中且 source 集一致，就直接复用已传的 CSDN URL
  // 重建正文，跳过图床重传——避免每次重新打开都重复上传一份带新图片链接的草稿。
  // 注意：窗口销毁不清它（否则“关了再开”的复用就失效了）；同一 job 的图片若被
  // 用户改过，重新上传会自然覆盖此缓存。
  csdnImageUrlCache: new Map<string, Map<string, string>>(),
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
