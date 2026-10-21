import { BrowserWindow } from "electron";
import { dialog, session } from "electron";
import { FILL_CSDN_EDITOR_SCRIPT, FILL_CSDN_PUBLISH_DIALOG_SCRIPT, HAS_CSDN_PUBLISH_DIALOG_SCRIPT } from "../csdn/csdn-editor-filler";
import { csdnDiagnosticsPath, resetCsdnDiagnostics, appendCsdnDiagnostics } from "../csdn/csdn-diagnostics";
import { collectImageMatches } from "../csdn/csdn-image-inliner";
import { extractCsdnUploadUrl } from "../csdn/csdn-upload-url";
import { state } from "./state";
import { createWenduWindowIcon } from "./windows";
import { applyProxyToPartition } from "./research-automation";
import { delay } from "./delay";

const CSDN_API_BASE = "http://127.0.0.1:4317";
const CSDN_EDITOR_URL = "https://editor.csdn.net/md/";

export function logCsdnBrowserAssist(step: string, details: Record<string, unknown> = {}): void {
  state.runtimeInfoLogger?.({ scope: "csdn-browser-assist", step, ...details }, "CSDN 浏览器辅助");
  try {
    appendCsdnDiagnostics(`[${step}] ${JSON.stringify(details)}`);
  } catch {
    /* best-effort */
  }
}

async function getOrCreateCsdnWindow(): Promise<BrowserWindow> {
  if (state.csdnWindow && !state.csdnWindow.isDestroyed()) return state.csdnWindow;
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    // Keep CSDN's authenticated renderer available for its first-party upload
    // and publish calls, without opening a user-visible window.
    show: false,
    title: "文渡 · CSDN 编辑器",
    icon: createWenduWindowIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // 账号隔离且持久：登录态在本机会话中保留，正常发布时窗口保持隐藏。
      partition: "persist:contentferry-csdn"
    }
  });
  state.csdnWindow = window;
  window.on("closed", () => {
    if (state.csdnWindow === window) state.csdnWindow = undefined;
    // 窗口销毁后其内容不再载在内存中的编辑器里，清空标记以便下次“重新打开”
    // 走完整流程重新填充（CSDN 编辑器窗口全局只有一个，无需判断“另一个窗口”）。
    state.csdnWindowJobId = undefined;
  });
  // CSDN 编辑器页面自身注册了 beforeunload（未保存内容拦截）。若不加处理器，
  // Electron 会静默尊重页面的 beforeunload、取消关闭——标题栏 × 点了没反应。
  // 逻辑与主窗口一致：退出流程中直接放行；否则弹确认框，选“放弃”才强制卸载。
  window.webContents.on("will-prevent-unload", (event) => {
    if (state.shutdownPromise) { event.preventDefault(); return; }
    if (window.isDestroyed()) return;
    const choice = dialog.showMessageBoxSync(window, {
      type: "warning",
      title: "文渡 · CSDN 编辑器",
      message: "CSDN 编辑器中有未发布的内容",
      detail: "关闭此窗口会丢失当前编辑器中的内容（文渡侧的发布任务记录保留）。你可以返回文渡继续发布，或放弃此窗口。",
      buttons: ["返回继续发布", "放弃并关闭"],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (choice === 1) event.preventDefault();
  });
  // 与检索浏览器一致：若用户在“联网检索服务”里配置了检索代理，CSDN 编辑器也走同一代理。
  // 否则在需要代理才能访问外网的环境里，窗口会静默加载失败（白屏）。
  await applyProxyToPartition("persist:contentferry-csdn");
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    logCsdnBrowserAssist("did-fail-load", { errorCode, errorDescription, validatedURL });
    if (window.isDestroyed()) return;
    // 不要把失败藏成白屏：用一张错误页告诉用户原因与对策。
    const safeDesc = (errorDescription || `错误码 ${errorCode}`).replace(/[<>&]/g, "");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>CSDN 编辑器加载失败</title></head>` +
      `<body style="font-family:system-ui,-apple-system,sans-serif;padding:40px;color:#222;line-height:1.7">` +
      `<h2 style="margin:0 0 12px">CSDN 编辑器加载失败</h2>` +
      `<p style="margin:0 0 10px">原因：${safeDesc}</p>` +
      `<p style="margin:0 0 10px">如果你所在网络需要代理才能访问外网，请到文渡「设置 → 联网检索服务 → 检索代理」中填写代理地址（如 <code>http://127.0.0.1:7890</code>），保存后重新点击「确认并发布到 CSDN」。</p>` +
      `</body></html>`;
    void window.loadURL(`data:text/html,${encodeURIComponent(html)}`).catch(() => undefined);
  });
  await window.loadURL(CSDN_EDITOR_URL);
  return window;
}

function showCsdnAssistStatus(window: BrowserWindow, lines: string[]): void {
  if (window.isDestroyed()) return;
  const text = lines.join("\n");
  const safe = JSON.stringify(text);
  void window.webContents.executeJavaScript(`(function(){
    var panel = document.getElementById('contentferry-csdn-assist-status');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'contentferry-csdn-assist-status';
      panel.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;max-width:360px;padding:12px 14px;background:rgba(23,32,51,.82);color:#fff;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.28);font-size:13px;line-height:1.6;white-space:pre-line;pointer-events:none;user-select:none;';
      document.body.appendChild(panel);
    }
    panel.textContent = ${safe};
    panel.style.pointerEvents = 'none';
  })()`).catch(() => undefined);
}

async function waitForCsdnEditor(window: BrowserWindow, timeoutMs = 15_000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (window.isDestroyed()) return false;
    const ready = await window.webContents.executeJavaScript(`(function(){
      return document.readyState === 'complete' && (document.querySelector('input.title, #title, input[placeholder*="标题"]') || document.querySelector('.CodeMirror') || document.querySelector('[contenteditable="true"]')) != null;
    })()`).catch(() => false);
    if (ready) return true;
    await delay(400);
  }
  return false;
}

async function persistCsdnFill(jobId: string, body: unknown): Promise<boolean> {
  try {
    const response = await fetch(`${CSDN_API_BASE}/api/integrations/csdn/jobs/${jobId}/fill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      logCsdnBrowserAssist("fill-persist-failed", { status: response.status, detail });
      return false;
    }
    return true;
  } catch (error) {
    logCsdnBrowserAssist("fill-persist-failed", { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

async function persistCsdnPreSubmitFailure(jobId: string, reason: string): Promise<boolean> {
  const persisted = await persistCsdnFill(jobId, {
    verifiedFields: [],
    state: "failed_before_submit",
    reason: reason.slice(0, 500)
  });
  if (state.csdnWindowJobId === jobId) state.csdnWindowJobId = undefined;
  logCsdnBrowserAssist("failed-before-submit", { jobId, reason, persisted });
  return persisted;
}

async function persistCsdnNeedsLogin(jobId: string, reason: string): Promise<void> {
  try {
    const response = await fetch(`${CSDN_API_BASE}/api/integrations/csdn/jobs/${jobId}/needs-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason })
    });
    if (!response.ok) logCsdnBrowserAssist("needs-login-persist-failed", { jobId, status: response.status });
  } catch (error) {
    logCsdnBrowserAssist("needs-login-persist-failed", { jobId, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Page-context uploader source. Runs inside the CSDN editor page (same-origin,
 * logged-in) and calls CSDN's own image-hosting API. Kept as a string so the
 * browser-only globals (window/atob/Blob/File) are never type-checked by the
 * Node/Electron main build. */
// Inject the same pure extractor used in Node tests into the page context,
// so parsing stays consistent between the two environments. The function is
// self-contained (no imports/browser globals) so .toString() serializes cleanly.
const CSDN_UPLOAD_URL_EXTRACTOR_SOURCE = extractCsdnUploadUrl.toString();

const IN_PAGE_UPLOAD_FN_SOURCE = `
(function (arg) {
  return (async function uploadOneImage(a) {
    ${CSDN_UPLOAD_URL_EXTRACTOR_SOURCE}
    // 把任意值序列化为可读字符串（避免再出现 [object Object]）。
    // CSDN 的 window.csdn.upload.uploadImg 在失败时会以纯对象 reject，
    // 直接 String(err) 会得到 [object Object]，真实原因被吞。
    function safeStringify(value) {
      if (value === null || value === undefined) return String(value);
      if (typeof value === 'string') return value;
      if (value instanceof Error) return value.stack || (value.name + ': ' + value.message);
      if (typeof value === 'object') {
        try {
          var seen = [];
          return JSON.stringify(value, function (key, val) {
            if (typeof val === 'object' && val !== null) {
              if (seen.indexOf(val) >= 0) return '[Circular]';
              seen.push(val);
            }
            if (typeof val === 'function') return '[Function]';
            if (typeof val === 'undefined') return '[undefined]';
            if (typeof val === 'bigint') return val.toString() + 'n';
            return val;
          }, 2);
        } catch (e) {
          return Object.prototype.toString.call(value) + ' (stringify failed: ' + e.message + ')';
        }
      }
      return String(value);
    }
    // 从 SVG 文本里解析 viewBox 的宽高（多数 SVG 没有 width/height 属性）。
    // 用 charCodeAt 比较避免在模板字面量里写反斜杠转义。
    function parseSvgViewBox(svgText) {
      var idx = svgText.indexOf('viewBox=');
      if (idx < 0) return null;
      var rest = svgText.slice(idx + 8);
      var i = 0;
      while (i < rest.length) {
        var c = rest.charCodeAt(i);
        if (c === 32 || c === 9 || c === 10 || c === 13) i++;
        else break;
      }
      var qCode = rest.charCodeAt(i);
      if (qCode !== 34 && qCode !== 39) return null;
      var quoteChar = rest[i];
      i++;
      var end = rest.indexOf(quoteChar, i);
      if (end < 0) return null;
      var content = rest.slice(i, end);
      var parts = [];
      var current = '';
      for (var ci2 = 0; ci2 < content.length; ci2++) {
        var c2 = content.charCodeAt(ci2);
        if (c2 === 32 || c2 === 9 || c2 === 10 || c2 === 13 || c2 === 44) {
          if (current.length > 0) { parts.push(current); current = ''; }
        } else {
          current += content[ci2];
        }
      }
      if (current.length > 0) parts.push(current);
      if (parts.length < 4) return null;
      var w = parseFloat(parts[2]);
      var h = parseFloat(parts[3]);
      if (!(w > 0) || !(h > 0)) return null;
      return { w: w, h: h };
    }
    // CSDN 图床不接受 image/svg+xml：把 SVG 栅格化为 PNG 后再上传。
    // 2x 缩放保证 retina 清晰度；尺寸优先用 image.naturalWidth/Height，
    // 缺失时回退到 viewBox 解析，仍失败用 1200x800 兜底。
    function renderSvgDataUrlToPng(svgDataUrl) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
          var w = img.naturalWidth, h = img.naturalHeight;
          if (!w || !h) {
            var vb = parseSvgViewBox(svgDataUrl);
            if (vb) { w = vb.w; h = vb.h; }
          }
          if (!w || !h) { w = 1200; h = 800; }
          var scale = 2;
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          try { resolve(canvas.toDataURL('image/png')); }
          catch (e) { reject(new Error('CANVAS_TO_PNG_FAILED: ' + safeStringify(e))); }
        };
        img.onerror = function () { reject(new Error('SVG_IMAGE_LOAD_FAILED')); };
        img.src = svgDataUrl;
      });
    }
    if (typeof window.csdn === 'undefined' || typeof window.csdn.upload === 'undefined' || typeof window.csdn.upload.uploadImg !== 'function') {
      throw new Error('WINDOW_CSDN_UPLOAD_UNAVAILABLE');
    }
    // CSDN 图床拒绝 image/svg+xml：栅格化后再上传，避免整篇因一张 SVG 卡住。
    if (a.mimeType === 'image/svg+xml') {
      var pngDataUrl = await renderSvgDataUrlToPng(a.dataUrl);
      var newName = a.filename || 'image';
      if (newName.toLowerCase().endsWith('.svg')) newName = newName.slice(0, -4) + '.png';
      return uploadOneImage({ dataUrl: pngDataUrl, filename: newName, mimeType: 'image/png' });
    }
    var comma = a.dataUrl.indexOf(',');
    var b64 = comma >= 0 ? a.dataUrl.slice(comma + 1) : a.dataUrl;
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var blob = new Blob([bytes], { type: a.mimeType || 'application/octet-stream' });
    var file = new File([blob], a.filename || 'image', { type: a.mimeType });
    try {
      var res = await window.csdn.upload.uploadImg({ appName: 'direct_blog', type: 'blog', imageTemplate: '', file: file });
      var url = extractCsdnUploadUrl(res);
      if (!url) throw new Error('UPLOAD_NO_URL: ' + safeStringify(res));
      return url;
    } catch (err) {
      throw new Error('CSDN_UPLOAD_REJECTED: ' + safeStringify(err));
    }
  })(arg);
})
`;

interface InPageImageUpload {
  source: string;
  dataUrl: string;
  mimeType: string;
  filename: string;
}

interface PageUploadOutcome {
  replaced: Map<string, string>;
  failures: Array<{ source: string; reason: string }>;
}

/** Wait until the page's own upload API is ready (or give up after a short poll). */
async function waitForPageUploadApi(window: BrowserWindow, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await window.webContents
      .executeJavaScript(`typeof window.csdn?.upload?.uploadImg === 'function'`)
      .catch(() => false);
    if (ok === true) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function uploadOneImageInPage(window: BrowserWindow, image: InPageImageUpload): Promise<string> {
  const script = `(${IN_PAGE_UPLOAD_FN_SOURCE})(${JSON.stringify({ dataUrl: image.dataUrl, filename: image.filename, mimeType: image.mimeType })})`;
  return await window.webContents.executeJavaScript(script, false) as Promise<string>;
}

/** Upload every resolved image by driving CSDN's own in-page upload API. Returns
 * a map of original source → CSDN URL plus a list of failures. */
async function uploadCsdnImagesInPage(
  window: BrowserWindow,
  images: InPageImageUpload[],
  onProgress?: (done: number, total: number) => void
): Promise<PageUploadOutcome> {
  const replaced = new Map<string, string>();
  const failures: Array<{ source: string; reason: string }> = [];

  const apiReady = await waitForPageUploadApi(window);
  logCsdnBrowserAssist("page-upload-api", { ready: apiReady });
  if (!apiReady) {
    const pageUrl = await window.webContents.executeJavaScript("location.href").catch(() => "?");
    appendCsdnDiagnostics(`CSDN 页内上传 API 不可用（window.csdn.upload.uploadImg 未找到）。page=${pageUrl}`);
    for (const image of images) {
      failures.push({ source: image.source, reason: "CSDN 页内上传 API 不可用（window.csdn.upload.uploadImg 未找到）。" });
    }
    return { replaced, failures };
  }

  for (const image of images) {
    try {
      const url = await uploadOneImageInPage(window, image);
      replaced.set(image.source, url);
      logCsdnBrowserAssist("image-uploaded", { source: image.source, url });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push({ source: image.source, reason });
      appendCsdnDiagnostics(`CSDN 页内上传失败 ${image.source}：${reason}`);
    }
    if (onProgress) onProgress(replaced.size + failures.length, images.length);
  }

  return { replaced, failures };
}

/** Replace `![alt](source)` with `![alt](csdnUrl)` for every uploaded image. */
function rewriteMarkdownImages(markdown: string, replaced: Map<string, string>): string {
  if (replaced.size === 0) return markdown;
  const matches = collectImageMatches(markdown);
  let result = markdown;
  for (let index = matches.length - 1; index >= 0; index--) {
    const match = matches[index];
    const url = replaced.get(match.source);
    if (url) {
      result = result.slice(0, match.start) + `![${match.alt}](${url})` + result.slice(match.end);
    }
  }
  return result;
}

type CsdnBrowserDraft = {
  title: string;
  markdown: string;
  author: string;
  digest: string;
  images: Array<{ source: string; dataUrl: string; mimeType: string; filename: string }>;
  coverDataUrl?: string;
};

// 读取发布任务状态与渠道稿内容（图片为 dataUrl，真正上传到 CSDN 图床发生在已登录的
// 编辑器页面内）。网络或校验失败时返回 null，由调用方决定如何提示，而不是抛错打断流程。
async function fetchCsdnJobAndDraft(jobId: string): Promise<{ status: string; draft: CsdnBrowserDraft } | null> {
  try {
    const response = await fetch(`${CSDN_API_BASE}/api/integrations/csdn/jobs/${jobId}`);
    if (!response.ok) return null;
    const payload = await response.json() as { job: { status: string }; draft: CsdnBrowserDraft };
    return { status: payload.job.status, draft: payload.draft };
  } catch {
    return null;
  }
}

async function runCsdnBrowserPublish(jobId: string): Promise<void> {
  resetCsdnDiagnostics();
  let window: BrowserWindow;
  try {
    window = await getOrCreateCsdnWindow();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logCsdnBrowserAssist("window-create-failed", { error: reason });
    const failurePersisted = await persistCsdnPreSubmitFailure(jobId, `无法打开 CSDN 编辑器窗口：${reason}`);
    // 不再静默吞掉：把错误抛回渲染进程，主窗口会显示提示，避免只剩一个白窗。
    const persistenceHint = failurePersisted ? "" : "任务状态暂时未能更新，请恢复文渡本地服务后刷新发布记录。";
    throw new Error(`${error instanceof Error ? error.message : "无法打开 CSDN 发布浏览器窗口。"}${persistenceHint ? ` ${persistenceHint}` : ""}`);
  }
  window.hide();

  // 若同一任务的窗口仍然存在，说明前一次执行可能停在人工处理节点；
  // 只在需要登录或人工补齐时显示窗口。提交中/已提交任务绝不再次点击发布。
  if (state.csdnWindow && !state.csdnWindow.isDestroyed() && state.csdnWindowJobId === jobId) {
    const loaded = await fetchCsdnJobAndDraft(jobId);
    const loginRequired = await window.webContents.executeJavaScript(`(function(){
      var u = (location.href || '').toLowerCase();
      if (u.indexOf('passport.csdn.net') >= 0 || /\\/login/.test(u)) return true;
      var loginEl = document.querySelector('a[href*="passport"], .login_box, #csdn-login, [class*="loginBtn"], [class*="login-btn"]');
      return !!(loginEl && /登录/.test(loginEl.textContent || ''));
    })()`).catch(() => false);
    if (loginRequired) {
      await persistCsdnNeedsLogin(jobId, "CSDN 编辑器未登录，请先在窗口登录后继续。");
      // 登录完成后要重新走内容准备；不能把停在登录页的 renderer 当成已填充窗口复用。
      state.csdnWindowJobId = undefined;
      logCsdnBrowserAssist("reopen-human-handoff", { jobId, status: "needs_login" });
      window.show();
      window.focus();
      showCsdnAssistStatus(window, ["CSDN 登录已过期。请在此窗口登录后，回到文渡点击“登录 CSDN 后继续”。"]);
    } else if (loaded?.status === "needs_user") {
      logCsdnBrowserAssist("reopen-manual-handoff", { jobId });
      window.show();
      window.focus();
      showCsdnAssistStatus(window, ["请在 CSDN 窗口补齐未能自动填写的字段，确认无误后回到文渡继续发布。"]);
    } else {
      const readyPersisted = await persistCsdnFill(jobId, {
        verifiedFields: [],
        state: "ready_for_final_confirmation",
        reason: "用户已在 CSDN 窗口补齐内容并确认继续发布。"
      });
      if (!readyPersisted) {
        window.show();
        window.focus();
        showCsdnAssistStatus(window, ["无法保存 CSDN 发布准备状态，未提交文章。", "请恢复文渡本地服务后再继续。"]);
        return;
      }
      logCsdnBrowserAssist("reopen-confirm-submission", { jobId, previousStatus: loaded?.status ?? "unknown" });
      const response = await fetch(`${CSDN_API_BASE}/api/integrations/csdn/jobs/${jobId}/confirm`, { method: "POST" });
      if (!response.ok) {
        window.show();
        window.focus();
        showCsdnAssistStatus(window, ["无法继续提交 CSDN 文章。", "请核对 CSDN 后台状态后再回到文渡处理，避免重复发布。"]);
      }
    }
    return;
  }

  // 完整流程：窗口是新建的（或载着别的任务），需要重新抓稿、上传图片、填充编辑器。
  // 注意：csdnWindowJobId 在填充成功/needs_user/needs_login 时才写入，不在开头写——
  // 否则一次失败的全流程会让下次“重新打开”误判为轻量路径而跳过重填。
  // 第一时间给出可见进度：窗口刚打开后到图片上传完成前会有几秒"空白期"
  // （等待编辑器加载、登录预检、上传正文图片），右下角黑色状态框先提示，避免像"卡住"。
  showCsdnAssistStatus(window, [
    "正在准备 CSDN 发布…",
    "已打开编辑器窗口，正在读取登录态并准备内容。"
  ]);
  let draft: { title: string; markdown: string; author: string; digest: string; images: Array<{ source: string; dataUrl: string; mimeType: string; filename: string }>; coverDataUrl?: string };
  try {
    const cookies = await window.webContents.session.cookies.get({ url: CSDN_EDITOR_URL });
    logCsdnBrowserAssist("draft-fetch-started", {
      cookieCount: cookies.length,
      hasLoginCookie: cookies.some((c) => /^(UserName|UserToken|ssxin|csdn_user|uid)$/.test(c.name))
    });
    const fetched = await fetchCsdnJobAndDraft(jobId);
    if (!fetched) throw new Error("无法读取 CSDN 渠道稿内容。");
    draft = fetched.draft;
    logCsdnBrowserAssist("draft-fetched", {
      title: draft.title,
      markdownLength: draft.markdown.length,
      imageCount: draft.images.length
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logCsdnBrowserAssist("fetch-draft-failed", { error: reason });
    const failurePersisted = await persistCsdnPreSubmitFailure(jobId, `无法读取 CSDN 渠道稿内容：${reason}`);
    window.show();
    window.focus();
    showCsdnAssistStatus(window, [
      "无法读取 CSDN 渠道稿内容。",
      "发布尚未提交。请检查文渡本地服务后，在发布记录中点击“重试发布”。",
      ...(failurePersisted ? [] : ["任务状态暂时未能更新；恢复文渡本地服务后请刷新发布记录。"]),
      `完整诊断已写入文件：${csdnDiagnosticsPath()}`,
      "请把该文件的全部内容发给我，即可精准定位失败原因。"
    ]);
    return;
  }

  const ready = await waitForCsdnEditor(window);
  if (!ready) {
    const reason = "CSDN 编辑器加载超时。";
    logCsdnBrowserAssist("editor-not-ready", {});
    const failurePersisted = await persistCsdnPreSubmitFailure(jobId, reason);
    window.show();
    window.focus();
    showCsdnAssistStatus(window, [
      reason,
      "发布尚未提交。请确认网络或登录状态正常，再回到文渡点击“重试发布”。",
      ...(failurePersisted ? [] : ["任务状态暂时未能更新；恢复文渡本地服务后请刷新发布记录。"])
    ]);
    return;
  }

  // 登录预检：未登录时 CSDN 会跳转 passport 或显示登录入口。
  const loginState = await window.webContents.executeJavaScript(`(function(){
    var u = (location.href || '').toLowerCase();
    if (u.indexOf('passport.csdn.net') >= 0 || /\\/login/.test(u)) return 'login';
    var loginEl = document.querySelector('a[href*="passport"], .login_box, #csdn-login, [class*="loginBtn"], [class*="login-btn"]');
    if (loginEl && /登录/.test(loginEl.textContent || '')) return 'login';
    return 'ok';
  })()`).catch(() => "ok");
  if (loginState === "login") {
    logCsdnBrowserAssist("needs-login", {});
    await persistCsdnNeedsLogin(jobId, "CSDN 编辑器未登录，请先在浏览器登录后再发起发布。");
    // 该窗口尚未填充任务内容；登录后用户再次确认时必须走完整流程。
    state.csdnWindowJobId = undefined;
    window.show();
    window.focus();
    showCsdnAssistStatus(window, ["CSDN 登录已过期。请在此窗口登录后，回到文渡重新点击“确认并发布到 CSDN”。"]);
    return;
  }

  // 上传图片到 CSDN 图床：在已登录的编辑器页面内调用 CSDN 自带的
  // window.csdn.upload.uploadImg（同域、自带 cookie，无需反向工程私有接口）。
  // 若之前已为该任务上传过、且本次稿件的图片 source 与缓存完全一致，则直接复用
  // 已传的 CSDN URL，跳过图床重传——这是“关闭窗口后再重新打开”不再重复上传草稿的关键。
  const cachedUrls = state.csdnImageUrlCache.get(jobId);
  const reuseFromCache =
    !!cachedUrls && draft.images.length > 0 && draft.images.every((img) => cachedUrls.has(img.source));
  let imageUpload: PageUploadOutcome;
  if (reuseFromCache) {
    const replaced = new Map<string, string>();
    for (const img of draft.images) {
      const url = cachedUrls!.get(img.source);
      if (url) replaced.set(img.source, url);
    }
    imageUpload = { replaced, failures: [] };
    logCsdnBrowserAssist("images-reused-from-cache", { count: replaced.size });
    showCsdnAssistStatus(window, [
      `复用上次已上传的 ${replaced.size} 张 CSDN 图片，跳过图床重传。`,
      "正在填充标题与正文…"
    ]);
  } else {
    imageUpload = await uploadCsdnImagesInPage(window, draft.images, (done, total) => {
      showCsdnAssistStatus(window, [
        `正在上传文章图片到 CSDN 图床（${done}/${total}）…`,
        "请勿关闭此窗口，上传完成后会自动填充标题与正文。"
      ]);
    });
  }
  // 把本次成功上传的 source → URL 映射写入缓存，供下次“重新打开”复用。
  if (imageUpload.replaced.size > 0) {
    state.csdnImageUrlCache.set(jobId, new Map(imageUpload.replaced));
  }
  const finalMarkdown = rewriteMarkdownImages(draft.markdown, imageUpload.replaced);
  logCsdnBrowserAssist("images-uploaded", {
    total: draft.images.length,
    uploaded: imageUpload.replaced.size,
    failed: imageUpload.failures.length
  });

  // 填充标题与正文（Markdown）。先切到 Markdown 模式再写入 CodeMirror，避免富文本模式下
  // 标题/列表标记被当成普通文本；同时把 LF 规范化，保证块级 Markdown 不被压成一行。
  const fillArgs = JSON.stringify({ title: draft.title, markdown: finalMarkdown });
  const fill = await window.webContents.executeJavaScript(`(${FILL_CSDN_EDITOR_SCRIPT})(${fillArgs})`, false).catch((error: unknown) => {
    logCsdnBrowserAssist("fill-execute-failed", { error: error instanceof Error ? error.message : String(error) });
    return { title: false, content: false, mode: null, editorFound: false, contentLength: 0 };
  }) as { title: boolean; content: boolean; mode: string | null; editorFound: boolean; contentLength: number };

  const verifiedFields: string[] = [];
  if (fill.title) verifiedFields.push("title");
  if (fill.content) verifiedFields.push("content");
  logCsdnBrowserAssist("filled", {
    title: fill.title,
    content: fill.content,
    mode: fill.mode,
    editorFound: fill.editorFound,
    contentLength: fill.contentLength,
    expectedLength: finalMarkdown.length
  });

  if (!fill.title || !fill.content) {
    const failurePersisted = await persistCsdnFill(jobId, {
      verifiedFields,
      state: fill.title || fill.content ? "needs_user" : "failed_before_submit",
      reason: "未能可靠填充标题或正文；请在 CSDN 窗口中手动补齐，再回到文渡点击“在窗口中补齐后继续”。"
    });
    // needs_user：窗口确实载着该任务（只是没填全），标记后“重新打开”只提到前台，
    // 不再重填，避免覆盖用户在编辑器里的手动补齐。failed_before_submit 不标记，
    // 因为内容基本是空的，下次应走完整流程重填。
    if (failurePersisted && (fill.title || fill.content)) state.csdnWindowJobId = jobId;
    window.show();
    window.focus();
    showCsdnAssistStatus(window, [
      "已打开 CSDN 编辑器，但标题或正文未能自动填充。",
      "请在 CSDN 窗口中手动补齐内容；确认无误后，回到文渡点击“在窗口中补齐后继续”。",
      ...(failurePersisted ? [] : ["文渡暂时无法保存任务状态；请先恢复本地服务，再刷新发布记录。"])
    ]);
    return;
  }

  if (imageUpload.failures.length > 0) {
    const failurePersisted = await persistCsdnFill(jobId, {
      verifiedFields: ["title", "content"],
      state: "needs_user",
      reason: `${imageUpload.failures.length} 张图片未能上传到 CSDN 图床，请在编辑器中处理后再继续发布。`
    });
    if (failurePersisted) state.csdnWindowJobId = jobId;
    appendCsdnDiagnostics(`CSDN 图片上传失败明细（${imageUpload.failures.length} 张）：${JSON.stringify(imageUpload.failures)}`);
    console.error("[contentferry] CSDN 图片上传失败明细：", JSON.stringify({
      jobId,
      uploadedCount: imageUpload.replaced.size,
      failedCount: imageUpload.failures.length,
      failures: imageUpload.failures
    }, null, 2));
    window.show();
    window.focus();
    showCsdnAssistStatus(window, [
      `有 ${imageUpload.failures.length} 张图片未能上传到 CSDN 图床，发布已暂停。`,
      "请在 CSDN 编辑器中处理图片后，回到文渡点击“在窗口中补齐后继续”。",
      `诊断文件：${csdnDiagnosticsPath()}`,
      ...(failurePersisted ? [] : ["文渡暂时无法保存任务状态；请先恢复本地服务，再刷新发布记录。"])
    ]);
    return;
  }

  const fillPersisted = await persistCsdnFill(jobId, { verifiedFields: ["title", "content"], state: "ready_for_final_confirmation" });
  if (!fillPersisted) {
    window.show();
    window.focus();
    showCsdnAssistStatus(window, [
      "标题与正文已填入，但文渡暂时无法保存准备状态。",
      "发布尚未提交。请恢复文渡本地服务后刷新发布记录，再继续操作。"
    ]);
    return;
  }
  // 成功填充后标记窗口载着该任务：下次点“重新打开”走轻量路径（仅提到前台 + 重启轮询），
  // 不再抓稿/重传图片/重填编辑器。必须用持久化成功作为标记时机，避免一次失败的全流程
  // 让下次“重新打开”误判为轻量路径而跳过重填。
  state.csdnWindowJobId = jobId;
  const statusLines = [
    "已填充标题与正文。",
    imageUpload.replaced.size > 0 ? `已将 ${imageUpload.replaced.size} 张图片上传到 CSDN 图床并替换正文链接。` : (draft.images.length === 0 ? "" : "本文没有需要上传的本地图片。")
  ];
  statusLines.push("已在后台填充发布设置并提交，正在核对 CSDN 回执。");
  showCsdnAssistStatus(window, statusLines.filter(Boolean));

  // This IPC action is the user's final confirmation. The local confirm route
  // transitions the task to submitting before clicking CSDN's final button,
  // so an uncertain response can never be blindly retried.
  try {
    const response = await fetch(`${CSDN_API_BASE}/api/integrations/csdn/jobs/${jobId}/confirm`, { method: "POST" });
    if (!response.ok) throw new Error(`CSDN 提交状态回写失败（HTTP ${response.status}）。`);
  } catch (error) {
    logCsdnBrowserAssist("confirmed-publish-failed", { jobId, error: error instanceof Error ? error.message : String(error) });
    window.show();
    window.focus();
    showCsdnAssistStatus(window, ["CSDN 发布结果暂时无法自动核对。", "请先到 CSDN 后台确认是否已发布，再回到文渡校正状态；不要重复发布。"]);
  }

}

export async function driveCsdnBrowserPublish(jobId: string): Promise<void> {
  if (state.csdnPublisherActiveJobs.has(jobId)) {
    logCsdnBrowserAssist("duplicate-assist-ignored", { jobId });
    return;
  }
  state.csdnPublisherActiveJobs.add(jobId);
  try {
    await runCsdnBrowserPublish(jobId);
  } finally {
    state.csdnPublisherActiveJobs.delete(jobId);
  }
}

async function waitForCsdnArticleUrl(window: BrowserWindow, budgetMs = 25000): Promise<string | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < budgetMs) {
    if (window.isDestroyed()) return null;
    const found = await window.webContents.executeJavaScript(`(function(){
      var u = location.href || '';
      var detailsMatch = u.match(/blog\\.csdn\\.net\\/[^\\/]+\\/article\\/details\\/(\\d+)/);
      if (detailsMatch) return location.href;
      var links = Array.prototype.slice.call(document.querySelectorAll('a[href*="article/details/"]'));
      for (var i = 0; i < links.length; i++) {
        var href = links[i].href || '';
        if (/article\\/details\\/\\d+/.test(href)) return href;
      }
      return '';
    })()`).catch(() => "");
    if (found) return found;
    await delay(800);
  }
  return null;
}

export async function confirmCsdnBrowserPublish(jobId: string): Promise<{ remoteUrl: string | null; remoteContentId: string | null; submitted?: boolean; reason?: string } | null> {
  const window = state.csdnWindow;
  if (!window || window.isDestroyed()) {
    logCsdnBrowserAssist("confirm-window-missing", { jobId });
    return null;
  }

  // 读取渠道稿摘要与封面（封面为主稿真实封面，getBrowserDraft 已解析为 dataUrl）。
  let digest = "";
  let coverDataUrl: string | undefined;
  let tags: string[] = [];
  try {
    const response = await fetch(`${CSDN_API_BASE}/api/integrations/csdn/jobs/${jobId}`);
    if (response.ok) {
      const payload = await response.json() as { draft: { digest: string; tags?: string[]; images: Array<{ dataUrl: string }>; coverDataUrl?: string } };
      digest = payload.draft.digest || "";
      tags = payload.draft.tags ?? [];
      coverDataUrl = payload.draft.coverDataUrl;
    }
  } catch (error) {
    logCsdnBrowserAssist("confirm-fetch-draft-failed", { jobId, error: error instanceof Error ? error.message : String(error) });
  }

  const dialogAlreadyOpen = await window.webContents.executeJavaScript(`(function(){
    ${HAS_CSDN_PUBLISH_DIALOG_SCRIPT}
    return hasCsdnPublishDialog();
  })()`).catch((error: unknown) => {
    logCsdnBrowserAssist("publish-dialog-probe-failed", { jobId, error: error instanceof Error ? error.message : String(error) });
    return null;
  });
  if (dialogAlreadyOpen === null) return null;

  if (!dialogAlreadyOpen) {
    showCsdnAssistStatus(window, ["正在打开 CSDN 发布设置……"]);
    const opened = await window.webContents.executeJavaScript(`(function(){
      var dialogs = Array.prototype.slice.call(document.querySelectorAll('[role="dialog"], .el-dialog, .modal__publish-article, .publish-dialog'));
      var buttons = Array.prototype.slice.call(document.querySelectorAll('button, .btn, a.btn'));
      var target = buttons.find(function(b){
        if ((b.textContent || '').replace(/\\s+/g, '').trim() !== '发布文章') return false;
        return !dialogs.some(function(dialog){ return dialog.contains(b); });
      });
      if (!target) return false;
      target.click();
      return true;
    })()`).catch(() => false);
    if (!opened) {
      logCsdnBrowserAssist("publish-button-not-found", { jobId });
      window.show();
      window.focus();
      showCsdnAssistStatus(window, ["未找到 CSDN 编辑器的“发布文章”按钮。", "请在窗口中核对文章状态，再回到文渡处理；不要重复发布。"]);
      return { remoteUrl: null, remoteContentId: null, submitted: false, reason: "未找到 CSDN 编辑器的发布按钮，文章尚未提交。" };
    }
  } else {
    logCsdnBrowserAssist("publish-dialog-resume", { jobId });
  }

  // 等待弹框出现并自动填充摘要、封面、选项，然后点击弹框内的发布按钮。
  // 弹框可能延迟出现，轮询至多约 9 秒。
  let dialogResult: Record<string, unknown> = { dialogFound: false };
  for (let attempt = 0; attempt < 6; attempt++) {
    await delay(1200);
    dialogResult = await window.webContents.executeJavaScript(`(function(digest, coverDataUrl, tags){
      ${FILL_CSDN_PUBLISH_DIALOG_SCRIPT}
      return fillCsdnPublishDialog({digest: digest, coverDataUrl: coverDataUrl, tags: tags});
    })(${JSON.stringify(digest)}, ${JSON.stringify(coverDataUrl)}, ${JSON.stringify(tags)})`).catch((error: unknown) => ({ dialogFound: false, error: error instanceof Error ? error.message : String(error) }));
    logCsdnBrowserAssist("confirm-dialog-fill", { jobId, attempt, ...dialogResult });
    if (dialogResult.submitClicked) break;
  }

  if (typeof dialogResult.error === "string") {
    logCsdnBrowserAssist("confirm-dialog-result-uncertain", { jobId, error: dialogResult.error });
    window.show();
    window.focus();
    showCsdnAssistStatus(window, ["无法确认 CSDN 发布操作是否完成。", "请先到 CSDN 后台核对文章状态，再回到文渡校正；确认前不要重新发布。"]);
    return null;
  }

  if (!dialogResult.submitClicked) {
    window.show();
    window.focus();
    const reason = typeof dialogResult.reason === "string"
      ? dialogResult.reason
      : "CSDN 最终发布按钮未点击，文章尚未提交。";
    logCsdnBrowserAssist("publish-not-submitted", { jobId, reason });
    showCsdnAssistStatus(window, ["未点击 CSDN 最终发布按钮，文章尚未提交。", "请检查打开的 CSDN 发布设置后，回到文渡重新确认发布。"]);
    return { remoteUrl: null, remoteContentId: null, submitted: false, reason };
  }

  const remoteUrl = await waitForCsdnArticleUrl(window, 20000);
  if (!remoteUrl) {
    logCsdnBrowserAssist("receipt-not-read", { jobId });
    window.show();
    window.focus();
    showCsdnAssistStatus(window, ["已尝试点击发布，但未能自动读取 CSDN 文章链接。", "请核对当前 CSDN 编辑器和文章管理页的结果，再回到文渡校正状态；确认前不要重复发布。"]);
    return null;
  }
  const contentIdMatch = /article\/details\/(\d+)/.exec(remoteUrl);
  const remoteContentId = contentIdMatch ? contentIdMatch[1] : null;
  logCsdnBrowserAssist("receipt-read", { remoteUrl, remoteContentId });
  showCsdnAssistStatus(window, ["已在 CSDN 发布，已回写文章链接：", remoteUrl]);
  return { remoteUrl, remoteContentId };
}

