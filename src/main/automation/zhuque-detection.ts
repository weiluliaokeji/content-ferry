import { BrowserWindow } from "electron";
import { state } from "./state";
import { createWenduWindowIcon } from "./windows";
import { delay } from "./delay";

type ZhuqueSegmentKind = "human" | "uncertain" | "ai";
type ZhuqueReport = {
  verdict: string;
  humanPercent: number | null;
  uncertainPercent: number | null;
  aiPercent: number | null;
  ratioSource: "official" | "segments";
  segments: Array<{ text: string; kind: ZhuqueSegmentKind }>;
};
type ZhuqueDetectionResponse = {
  status: "completed" | "needs_user";
  result?: string;
  report?: ZhuqueReport;
  message?: string;
};
export async function getOrCreateZhuqueWindow(): Promise<BrowserWindow> {
  if (state.zhuqueWindow && !state.zhuqueWindow.isDestroyed()) return state.zhuqueWindow;
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    show: true,
    title: "文渡 · 腾讯朱雀自动检测",
    icon: createWenduWindowIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: "persist:contentferry-zhuque"
    }
  });
  state.zhuqueWindow = window;
  window.on("closed", () => { if (state.zhuqueWindow === window) state.zhuqueWindow = undefined; });
  await window.loadURL("https://matrix.tencent.com/ai-detect/ai_gen_txt/");
  await delay(1200);
  return window;
}

export async function runZhuqueDetection(markdown: string): Promise<ZhuqueDetectionResponse> {
  const window = await getOrCreateZhuqueWindow();
  window.show();
  window.focus();

  const filled = await window.webContents.executeJavaScript(`(async () => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 100 && rect.height > 30 && style.display !== "none" && style.visibility !== "hidden";
    };
    let candidates = [...document.querySelectorAll("textarea, [contenteditable='true']")].filter(visible);
    if (candidates.length === 0) {
      document.querySelector(".clear-btn")?.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      candidates = [...document.querySelectorAll("textarea, [contenteditable='true']")].filter(visible);
    }
    const editor = document.querySelector(".txt-input textarea") || candidates.sort((left, right) => right.getBoundingClientRect().width * right.getBoundingClientRect().height - left.getBoundingClientRect().width * left.getBoundingClientRect().height)[0];
    if (!editor) return { ok: false, reason: "未找到正文输入区域" };
    const previousResult = (document.querySelector(".txt-segment-box")?.textContent || "").trim();
    const value = ${JSON.stringify(markdown)};
    if (editor instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(editor, value);
    } else {
      editor.focus();
      editor.textContent = value;
    }
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));
    window.__contentFerryChartLabels = [];
    window.__contentFerryNetworkPayloads = [];
    window.__contentFerryDetectionStartedAt = Date.now();
    if (!window.__contentFerryNetworkPatched) {
      window.__contentFerryNetworkPatched = true;
      const recordPayload = (url, body) => {
        try {
          const text = String(body || "");
          if (text && text.length <= 2_000_000) {
            window.__contentFerryNetworkPayloads.push({ url: String(url || ""), body: text, capturedAt: Date.now() });
          }
        } catch {}
      };
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        response.clone().text().then((body) => recordPayload(args[0]?.url || args[0], body)).catch(() => {});
        return response;
      };
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this.__contentFerryUrl = url;
        return originalOpen.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function(...args) {
        this.addEventListener("load", () => {
          if (typeof this.responseText === "string") recordPayload(this.__contentFerryUrl, this.responseText);
        }, { once: true });
        return originalSend.apply(this, args);
      };
    }
    if (!window.__contentFerryCanvasPatched) {
      window.__contentFerryCanvasPatched = true;
      const originalFillText = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...rest) {
        try {
          const value = String(text).trim();
          if (/^\\d+(?:\\.\\d+)?\\s*%$/.test(value)) {
            window.__contentFerryChartLabels.push({
              text: value,
              x,
              y,
              width: this.canvas.width,
              height: this.canvas.height,
              capturedAt: Date.now()
            });
          }
        } catch {}
        return originalFillText.call(this, text, x, y, ...rest);
      };
    }
    const buttons = [...document.querySelectorAll("button, [role='button']")].filter(visible);
    const detect = document.querySelector(".submit-btn") || buttons.find((button) => /开始检测|立即检测|检测|detect now/i.test((button.textContent || "").trim()));
    if (!detect) return { ok: false, reason: "未找到检测按钮" };
    detect.click();
    return { ok: true, previousResult };
  })()`, true) as { ok: boolean; reason?: string; previousResult?: string };

  if (!filled.ok) {
    window.focus();
    return { status: "needs_user", message: `${filled.reason ?? "网页结构发生变化"}。请在已打开的朱雀窗口中完成操作，然后回到文渡重试。` };
  }

  await delay(3500);
  let incompleteReportAttempts = 0;
  for (let attempt = 0; attempt < 58 && !window.isDestroyed(); attempt += 1) {
    await delay(2000);
    const report = await window.webContents.executeJavaScript(`(() => {
      const text = document.body?.innerText || "";
      const resultBox = document.querySelector(".txt-segment-box");
      const resultText = (resultBox?.textContent || "").trim();
      const previousResult = ${JSON.stringify(filled.previousResult ?? "")};
      if (!resultText || resultText === previousResult) return null;

      const segmentSelector = ".txt-segmentType-danger, .txt-segmentType-warning, .txt-segmentType-success";
      const segments = [...document.querySelectorAll(segmentSelector)]
        .filter((segment) => !segment.querySelector(segmentSelector))
        .map((segment) => {
          const value = (segment.textContent || "").trim();
          const kind = segment.classList.contains("txt-segmentType-success")
            ? "human"
            : segment.classList.contains("txt-segmentType-warning") ? "uncertain" : "ai";
          return { text: value, kind };
        })
        .filter((segment) => segment.text.length > 0)
        .slice(0, 500);

      let humanPercent = null;
      let uncertainPercent = null;
      let aiPercent = null;
      let ratioSource = "official";
      const percent = (value) => {
        const number = Number.parseFloat(String(value).replace("%", ""));
        return Number.isFinite(number) ? number : null;
      };
      const normalizeTriple = (values) => {
        if (!Array.isArray(values) || values.length !== 3 || values.some((value) => !Number.isFinite(value) || value < 0)) return null;
        const total = values.reduce((sum, value) => sum + value, 0);
        if (total >= .995 && total <= 1.005) return values.map((value) => value * 100);
        if (total >= 99.5 && total <= 100.5) return values;
        return null;
      };
      const applyTriple = (values) => {
        const normalized = normalizeTriple(values);
        if (!normalized) return false;
        humanPercent = normalized[0];
        uncertainPercent = normalized[1];
        aiPercent = normalized[2];
        return true;
      };
      const featureKind = (name) => {
        const normalized = String(name || "").toLowerCase().replace(/[\\s_-]+/g, "");
        if (/疑似|suspect|uncertain|maybe/.test(normalized)) return "uncertain";
        if (/人工|人类|human|manual/.test(normalized)) return "human";
        if (/ai特征|ai生成|aigc|machine|artificial/.test(normalized)) return "ai";
        return null;
      };
      const findNamedTriple = (root) => {
        const found = {};
        const visit = (value, depth = 0) => {
          if (depth > 12 || value == null || Object.keys(found).length === 3) return;
          if (Array.isArray(value)) {
            for (const item of value) visit(item, depth + 1);
            return;
          }
          if (typeof value !== "object") return;
          const entries = Object.entries(value);
          const nameEntry = entries.find(([key]) => /name|label|type|feature|category|title/i.test(key));
          const numberEntry = entries.find(([key, item]) => /value|percent|percentage|ratio|score|rate/i.test(key) && Number.isFinite(Number(item)));
          if (nameEntry && numberEntry) {
            const kind = featureKind(nameEntry[1]);
            if (kind) found[kind] = Number(numberEntry[1]);
          }
          for (const [key, item] of entries) {
            const kind = featureKind(key);
            if (kind && Number.isFinite(Number(item))) found[kind] = Number(item);
            else visit(item, depth + 1);
          }
        };
        visit(root);
        return found.human != null && found.uncertain != null && found.ai != null
          ? normalizeTriple([found.human, found.uncertain, found.ai])
          : null;
      };

      const startedAt = window.__contentFerryDetectionStartedAt || 0;
      for (const payload of (window.__contentFerryNetworkPayloads || []).filter((item) => item.capturedAt >= startedAt).reverse()) {
        try {
          const triple = findNamedTriple(JSON.parse(payload.body));
          if (triple && applyTriple(triple)) break;
        } catch {}
      }

      const chartElements = [...document.querySelectorAll("[_echarts_instance_]")];
      for (const chartElement of chartElements) {
        if (humanPercent !== null && uncertainPercent !== null && aiPercent !== null) break;
        try {
          let echartsApi = window.echarts;
          if (!echartsApi?.getInstanceByDom) {
            for (const key of Object.getOwnPropertyNames(window)) {
              try {
                const candidate = window[key];
                if (candidate?.getInstanceByDom && candidate?.getInstanceById) {
                  echartsApi = candidate;
                  break;
                }
              } catch {}
            }
          }
          const instance = echartsApi?.getInstanceByDom?.(chartElement);
          const data = instance?.getOption?.()?.series?.flatMap((series) => series.data || []) || [];
          for (const item of data) {
            const name = String(item?.name || "");
            const value = percent(item?.value);
            if (value === null) continue;
            if (/人工特征|人类特征/.test(name)) humanPercent = value;
            else if (/疑似/.test(name)) uncertainPercent = value;
            else if (/AI特征|AI生成/.test(name)) aiPercent = value;
          }
        } catch {}
      }

      if (humanPercent === null || uncertainPercent === null || aiPercent === null) {
        const svgCandidates = [...document.querySelectorAll("svg")]
          .map((svg) => [...svg.querySelectorAll("text")]
            .map((node) => (node.textContent || "").trim())
            .filter((value) => /^\\d+(?:\\.\\d+)?\\s*%$/.test(value))
            .map((value) => percent(value)))
          .filter((values) => values.length >= 3);
        let svgTriple = null;
        for (const values of svgCandidates) {
          for (let index = 0; index <= values.length - 3; index += 1) {
            const candidate = normalizeTriple(values.slice(index, index + 3));
            if (candidate) {
              svgTriple = candidate;
              break;
            }
          }
          if (svgTriple) break;
        }
        if (svgTriple) applyTriple(svgTriple);
      }

      if (humanPercent === null || uncertainPercent === null || aiPercent === null) {
        const reportCandidates = [...document.querySelectorAll("div, section")]
          .filter((element) => {
            const value = element.textContent || "";
            return value.includes("人工特征") && value.includes("疑似AI") && value.includes("AI特征") && /\\d+(?:\\.\\d+)?\\s*%/.test(value);
          })
          .sort((left, right) => (left.textContent || "").length - (right.textContent || "").length);
        for (const candidate of reportCandidates) {
          const values = [...candidate.querySelectorAll("*")]
            .filter((element) => element.children.length === 0)
            .map((element) => (element.textContent || "").trim())
            .filter((value) => /^\\d+(?:\\.\\d+)?\\s*%$/.test(value))
            .map((value) => percent(value));
          for (let index = 0; index <= values.length - 3; index += 1) {
            if (applyTriple(values.slice(index, index + 3))) break;
          }
          if (humanPercent !== null && uncertainPercent !== null && aiPercent !== null) break;
        }
      }

      if (humanPercent === null || uncertainPercent === null || aiPercent === null) {
        const captured = (window.__contentFerryChartLabels || [])
          .filter((item) => item.capturedAt >= startedAt && item.width >= 180 && item.height >= 150)
          .map((item) => ({ ...item, value: percent(item.text) }))
          .filter((item) => item.value !== null);
        const byCanvas = new Map();
        for (const item of captured) {
          const key = item.width + "x" + item.height;
          const values = byCanvas.get(key) || [];
          values.push(item);
          byCanvas.set(key, values);
        }
        const labelGroups = [...byCanvas.values()].flatMap((items) => {
          const groups = [];
          for (let index = items.length - 3; index >= 0; index -= 1) {
            const candidate = items.slice(index, index + 3);
            const total = candidate.reduce((sum, item) => sum + item.value, 0);
            if (total >= 99.5 && total <= 100.5) {
              groups.push(candidate);
              break;
            }
          }
          return groups;
        });
        const officialLabels = labelGroups
          .sort((left, right) => right[0].width * right[0].height - left[0].width * left[0].height)[0];
        if (officialLabels) {
          applyTriple(officialLabels.map((item) => item.value));
        }
      }

      if (humanPercent === null || uncertainPercent === null || aiPercent === null) {
        const characterCounts = { human: 0, uncertain: 0, ai: 0 };
        for (const segment of segments) {
          characterCounts[segment.kind] += Array.from(segment.text.replace(/\\s+/g, "")).length;
        }
        const totalCharacters = characterCounts.human + characterCounts.uncertain + characterCounts.ai;
        if (totalCharacters > 0) {
          humanPercent = characterCounts.human / totalCharacters * 100;
          uncertainPercent = characterCounts.uncertain / totalCharacters * 100;
          aiPercent = characterCounts.ai / totalCharacters * 100;
          ratioSource = "segments";
        }
      }

      const chartRoot = chartElements[0] || [...document.querySelectorAll("svg")].find((svg) => /\\d+(?:\\.\\d+)?\\s*%/.test(svg.textContent || ""));
      let reportRoot = chartRoot;
      for (let depth = 0; reportRoot && depth < 7; depth += 1) {
        const value = reportRoot.innerText || reportRoot.textContent || "";
        if (value.includes("人工特征") && value.includes("疑似AI") && value.includes("AI特征")) break;
        reportRoot = reportRoot.parentElement;
      }
      const reportLines = (reportRoot?.innerText || reportRoot?.textContent || "").split(/\\n+/).map((line) => line.trim()).filter(Boolean);
      const verdict = reportLines.find((line) => /人工创作特征|AI创作特征/.test(line) && /较强|较弱|明显|一般/.test(line))
        || reportLines.find((line) => /人工创作特征|AI创作特征/.test(line))
        || "腾讯朱雀检测已完成";
      return { verdict, humanPercent, uncertainPercent, aiPercent, ratioSource, segments };
    })()`, true) as ZhuqueReport | null;
    if (report && report.humanPercent !== null && report.uncertainPercent !== null && report.aiPercent !== null) {
      const formatPercent = (value: number | null) => value === null ? "未读取" : `${value.toFixed(2)}%`;
      const result = [
        report.verdict,
        `人工特征 ${formatPercent(report.humanPercent)} · 疑似 AI ${formatPercent(report.uncertainPercent)} · AI 特征 ${formatPercent(report.aiPercent)}${report.ratioSource === "segments" ? "（按已识别分段字数计算）" : ""}`,
        `已读取 ${report.segments.length} 个分段，原始朱雀结果窗口已保留。`
      ].join("\n");
      if (!window.isDestroyed()) {
        window.show();
        window.focus();
      }
      return { status: "completed", result, report };
    }
    if (report) {
      incompleteReportAttempts += 1;
      if (incompleteReportAttempts >= 8) {
        if (!window.isDestroyed()) {
          window.show();
          window.focus();
        }
        return {
          status: "needs_user",
          message: "朱雀正文分段已经生成，但图表的三项官方比例仍未能读取。原始结果窗口已保留，请核对页面后再次点击检测。"
        };
      }
    }
  }

  if (!window.isDestroyed()) window.focus();
  return { status: "needs_user", message: "自动填充和检测已经执行，但未能可靠读取结果。请在已打开的朱雀窗口中检查是否需要登录、验证码或其他确认。" };
}

