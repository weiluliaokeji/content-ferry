import { BrowserWindow } from "electron";
import { state } from "./state";
import { createWenduWindowIcon } from "./windows";
import { applyProxyToPartition } from "./research-automation";
import { delay } from "./delay";

const CNBLOGS_POST_EDITOR_URL = "https://i.cnblogs.com/posts/edit";
const PARTITION = "persist:contentferry-cnblogs";

export interface CnblogsPersonalOptions {
  categories: string[];
  tags: string[];
}

export async function readCnblogsPersonalOptions(): Promise<CnblogsPersonalOptions> {
  const window = await getOrCreateCnblogsOptionsWindow();
  window.show();
  window.focus();
  const categories = await readOptionList(window, "categories", 15_000);
  const tags = await readOptionList(window, "tags", 15_000);
  if (categories.length === 0 && tags.length === 0) {
    throw new Error("未读取到个人分类或 Tag。请先在打开的博客园窗口登录；如页面刚加载完成，请点击一次“个人分类”和“Tag 标签”下拉框后重试。");
  }
  return { categories, tags };
}

async function getOrCreateCnblogsOptionsWindow(): Promise<BrowserWindow> {
  if (state.cnblogsOptionsWindow && !state.cnblogsOptionsWindow.isDestroyed()) return state.cnblogsOptionsWindow;
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    show: true,
    title: "文渡 · 博客园发布设置",
    icon: createWenduWindowIcon(),
    webPreferences: { contextIsolation: true, nodeIntegration: false, partition: PARTITION }
  });
  state.cnblogsOptionsWindow = window;
  window.on("closed", () => { if (state.cnblogsOptionsWindow === window) state.cnblogsOptionsWindow = undefined; });
  await applyProxyToPartition(PARTITION);
  await window.loadURL(CNBLOGS_POST_EDITOR_URL);
  return window;
}

async function readOptionList(window: BrowserWindow, kind: "categories" | "tags", timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !window.isDestroyed()) {
    const values = await window.webContents.executeJavaScript(readOptionsScript(kind), true) as unknown;
    if (Array.isArray(values) && values.length > 0 && values.every((value) => typeof value === "string")) return values;
    await delay(500);
  }
  return [];
}

function readOptionsScript(kind: "categories" | "tags"): string {
  return `(() => {
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const inputForLabel = (label) => {
      const labelNode = [...document.querySelectorAll('body *')].find((node) => node.children.length === 0 && clean(node.textContent).replace(/[：:]/g, '') === label);
      let parent = labelNode?.parentElement;
      for (let depth = 0; parent && depth < 6; depth += 1, parent = parent.parentElement) {
        const input = parent.querySelector('input');
        if (input && parent.querySelector('.ant-select-selector, nz-select, nz-tree-select')) return input;
      }
      return undefined;
    };
    const open = (input) => {
      const trigger = input?.closest('.ant-select, nz-select, nz-tree-select')?.querySelector('.ant-select-selector, input') || input;
      if (!(trigger instanceof HTMLElement)) return;
      for (const type of ['mousedown', 'mouseup', 'click']) trigger.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    };
    const kind = ${JSON.stringify(kind)};
    if (kind === 'categories') {
      const options = [...document.querySelectorAll('.ant-select-tree-list nz-tree-node-title[title], nz-tree-node-title[title]')]
        .map((node) => clean(node.getAttribute('title')))
        .filter(Boolean);
      if (options.length) return [...new Set(options)].slice(0, 100);
      const input = [...document.querySelectorAll('input')].find((node) => /个人分类/.test(node.getAttribute('placeholder') || '')) || inputForLabel('个人分类');
      open(input);
      return [];
    }
    const options = [...document.querySelectorAll('nz-option-item[title]')]
      .map((node) => clean(node.getAttribute('title')))
      .filter((text) => text && !/^(请选择|暂无|加载中)/.test(text));
    if (options.length) {
      const seen = new Set();
      return options.filter((text) => {
        const key = text.normalize('NFKC').toLocaleLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 100);
    }
    const input = [...document.querySelectorAll('input')].find((node) => /tag/i.test(node.getAttribute('placeholder') || '') || /tag/i.test(node.id + ' ' + node.name)) || inputForLabel('Tag 标签');
    open(input);
    return [];
  })()`;
}
