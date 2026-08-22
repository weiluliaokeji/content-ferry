import { BrowserWindow, shell } from "electron";
import { state } from "./state";
import { createWenduWindowIcon } from "./windows";
import { delay } from "./delay";

type ContentAnyDetectionResponse = {
  status: "completed" | "needs_user";
  result?: string;
  reference?: { label: string; score: string | null; summary: string; detail: string };
  message?: string;
};

export async function getOrCreateContentAnyWindow(): Promise<BrowserWindow> {
  if (state.contentAnyWindow && !state.contentAnyWindow.isDestroyed()) return state.contentAnyWindow;
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    show: true,
    title: "文渡 · ContentAny AI 检测",
    icon: createWenduWindowIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: "persist:contentferry-contentany"
    }
  });
  state.contentAnyWindow = window;
  window.on("closed", () => { if (state.contentAnyWindow === window) state.contentAnyWindow = undefined; });
  await window.loadURL("https://cn.aifoxs.com/ai-detect");
  await delay(1500);
  return window;
}

export async function runContentAnyDetection(markdown: string): Promise<ContentAnyDetectionResponse> {
  const window = await getOrCreateContentAnyWindow();
  window.show();
  window.focus();
  const filled = await window.webContents.executeJavaScript(`(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 120 && rect.height > 30 && style.display !== "none" && style.visibility !== "hidden";
    };
    const editor = [...document.querySelectorAll("textarea, [contenteditable='true']")]
      .filter(visible)
      .sort((left, right) => right.getBoundingClientRect().width * right.getBoundingClientRect().height - left.getBoundingClientRect().width * left.getBoundingClientRect().height)[0];
    if (!editor) return { ok: false, reason: "未找到 ContentAny 正文输入区" };
    const value = ${JSON.stringify(markdown)};
    if (editor instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(editor, value);
    } else {
      editor.textContent = value;
    }
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));
    const button = [...document.querySelectorAll("button, [role='button']")].find((item) => {
      const rect = item.getBoundingClientRect();
      const style = getComputedStyle(item);
      return /AI指数检测|AI.*检测/i.test((item.textContent || "").replace(/\\s+/g, "").trim()) && rect.width > 30 && rect.height > 20 && style.display !== "none" && style.visibility !== "hidden";
    });
    if (!button) return { ok: false, reason: "未找到 ContentAny 的 AI 指数检测按钮" };
    button.click();
    return { ok: true };
  })()`, true) as { ok: boolean; reason?: string };
  if (!filled.ok) return { status: "needs_user", message: `${filled.reason ?? "ContentAny 页面结构发生变化"}。请在已打开的 ContentAny 窗口中登录或完成必要操作后重试。` };
  await delay(3500);
  for (let attempt = 0; attempt < 30 && !window.isDestroyed(); attempt += 1) {
    const result = await window.webContents.executeJavaScript(`(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 20 && rect.height > 12 && style.display !== "none" && style.visibility !== "hidden";
      };
      const isReportText = (value) => /AI\\s*(?:指数|检测|内容|特征)|检测(?:结果|报告)|原创(?:度|指数)|疑似\\s*AI|人工(?:创作|特征)/i.test(value);
      const pageText = (document.body?.innerText || "").replace(/\s+/g, " ");
      // ContentAny first renders the full page shell and “检测中” placeholders.
      // Only read results once those placeholders have disappeared.
      if (/检测中|正在生成报告|汇总多维度分析结果|检测结果统计中/.test(pageText)) return null;
      const referenceNodes = [...document.querySelectorAll("*")].filter((node) => {
        if (!(node instanceof HTMLElement) || !visible(node)) return false;
        const text = (node.innerText || "").replace(/\s+/g, " ").trim();
        return /^参考(?:\s|$)/.test(text) && text.length < 1200 && (/%|概率|人工|AIGC|AI/.test(text));
      }).map((node) => (node.innerText || "").replace(/\s+/g, " ").trim());
      const referenceText = referenceNodes.sort((left, right) => left.length - right.length)[0] ?? "";
      const tables = [...document.querySelectorAll("table")].filter(visible).map((table) => (table.innerText || "").trim()).filter(isReportText);
      const reportNodes = [...document.querySelectorAll("[class*='result' i], [class*='report' i], [class*='detect' i], [class*='score' i], [class*='index' i], [class*='segment' i], [id*='result' i], [id*='report' i]")]
        .filter(visible)
        .map((node) => (node.innerText || "").trim())
        .filter((value) => value.length > 0 && value.length < 12000 && isReportText(value));
      const candidates = [...reportNodes, ...tables];
      const best = candidates.sort((left, right) => right.length - left.length)[0];
      // The product surface deliberately shows the detector's concise
      // “参考” conclusion, not a copied page shell or marketing content.
      if (!referenceText) return null;
      const lines = referenceText.split(/\n|(?<=%)\s+/).map((line) => line.trim()).filter(Boolean);
      const score = lines.find((line) => /^\d+(?:\.\d+)?%$/.test(line)) ?? referenceText.match(/\d+(?:\.\d+)?\s*%/)?.[0] ?? null;
      const summary = lines.find((line) => /概率|偏人工|偏\s*AI|仅供参考/.test(line)) ?? "检测完成，可结合分段结果查看。";
      return {
        result: referenceText.slice(0, 12000),
        reference: { label: "参考", score, summary, detail: referenceText }
      };
    })()`, true) as { result: string; reference: { label: string; score: string | null; summary: string; detail: string } | null } | null;
    if (result) return { status: "completed", result: result.result, ...(result.reference ? { reference: result.reference } : {}) };
    await delay(1500);
  }
  window.focus();
  return { status: "needs_user", message: "ContentAny 已打开并提交检测，但暂时未能读取报告。请检查页面是否需要登录或验证码，完成后再次点击检测。" };
}
