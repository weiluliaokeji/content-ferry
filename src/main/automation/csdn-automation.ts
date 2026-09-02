import { BrowserWindow } from "electron";
import { dialog, session } from "electron";
import { FILL_CSDN_EDITOR_SCRIPT, FILL_CSDN_PUBLISH_DIALOG_SCRIPT } from "../csdn/csdn-editor-filler";
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
    show: true,
    title: "文渡 · CSDN 编辑器",
    icon: createWenduWindowIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // 账号隔离且持久：登录态在本机会话中保留，符合 FR-15.3 的“持久且账号隔离的可见浏览器会话”。
      partition: "persist:contentferry-csdn"
    }
  });
  state.csdnWindow = window;
  window.on("closed", () => {
    if (state.csdnWindow === window) state.csdnWindow = undefined;
    // 窗口销毁后其内容不再载在内存中的编辑器里，清空标记以便下次“重新打开”
    // 走完整流程重新填充（CSDN 编辑器窗口全局只有一个，无需判断“另一个窗口”）。
    state.csdnWindowJobId = undefined;
    stopCsdnDialogPoller();
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
      `<p style="margin:0 0 10px">如果你所在网络需要代理才能访问外网，请到文渡「设置 → 联网检索服务 → 检索代理」中填写代理地址（如 <code>http://127.0.0.1:7890</code>），保存后重新点击「在浏览器中完成发布」。</p>` +
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
      panel.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;max-width:360px;padding:12px 14px;background:rgba(23,32,51,.82);color:#fff;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.28);font-size:13px;line-height:1.6;white-space:pre-line;cursor:move;user-select:none;';
      document.body.appendChild(panel);
      var dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
      panel.addEventListener('mousedown', function(e){ dragging = true; var r = panel.getBoundingClientRect(); sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top; panel.style.left = sl + 'px'; panel.style.top = st + 'px'; panel.style.right = 'auto'; panel.style.bottom = 'auto'; e.preventDefault(); });
      document.addEventListener('mousemove', function(e){ if(!dragging) return; var nl = Math.max(0, Math.min(sl + e.clientX - sx, window.innerWidth - panel.offsetWidth)); var nt = Math.max(0, Math.min(st + e.clientY - sy, window.innerHeight - panel.offsetHeight)); panel.style.left = nl + 'px'; panel.style.top = nt + 'px'; });
      document.addEventListener('mouseup', function(){ dragging = false; });
    }
    panel.textContent = ${safe};
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

async function persistCsdnFill(jobId: string, body: unknown): Promise<void> {
  try {
    await fetch(`${CSDN_API_BASE}/api/integrations/csdn/jobs/${jobId}/fill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (error) {
    logCsdnBrowserAssist("fill-persist-failed", { error: error instanceof Error ? error.message : String(error) });
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

export async function driveCsdnBrowserPublish(jobId: string): Promise<void> {
  resetCsdnDiagnostics();
  let window: BrowserWindow;
  try {
    window = await getOrCreateCsdnWindow();
  } catch (error) {
    logCsdnBrowserAssist("window-create-failed", { error: error instanceof Error ? error.message : String(error) });
    // 不再静默吞掉：把错误抛回渲染进程，主窗口会显示提示，避免只剩一个白窗。
    throw error instanceof Error ? error : new Error("无法打开 CSDN 发布浏览器窗口。");
  }
  window.show();
  window.focus();

  // 轻量“重新打开”路径：同一份发布任务仍载在存活的编辑器窗口里（标题/正文已填好、
  // 图片也已传过 CSDN 图床）。此时只把窗口提到前台、重启发布对话框轮询即可，
  // 不要再抓稿、重传图片、重填编辑器——否则每次点“重新打开”都会重复上传一份草稿，
  // 并可能覆盖用户在编辑器里的手动修改。窗口被关闭后 csdnWindowJobId 会被清空，
  // 那时再点“重新打开”会走下面的完整流程重新填充。
  if (state.csdnWindow && !state.csdnWindow.isDestroyed() && state.csdnWindowJobId === jobId) {
    logCsdnBrowserAssist("reopen-skip-refill", { jobId });
    showCsdnAssistStatus(window, [
      "已切回 CSDN 编辑器窗口。",
      "内容已在窗口中，请直接点击 CSDN 编辑器的“发布文章”按钮；发布设置框弹出后文渡会自动填充。"
    ]);
    const loaded = await fetchCsdnJobAndDraft(jobId);
    // 仅当内容已填充（ready / needs_user）才重启对话框轮询；needs_login 等状态下
    // 编辑器尚未就绪，轮询只会产生无用的扫描循环。
    if (loaded && (loaded.status === "ready_for_final_confirmation" || loaded.status === "needs_user")) {
      startCsdnPublishDialogPoller(jobId, loaded.draft.digest, loaded.draft.coverDataUrl, window);
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
    logCsdnBrowserAssist("fetch-draft-failed", { error: error instanceof Error ? error.message : String(error) });
    showCsdnAssistStatus(window, [
      "无法读取 CSDN 渠道稿内容。",
      `完整诊断已写入文件：${csdnDiagnosticsPath()}`,
      "请把该文件的全部内容发给我，即可精准定位失败原因。"
    ]);
    return;
  }

  const ready = await waitForCsdnEditor(window);
  if (!ready) {
    logCsdnBrowserAssist("editor-not-ready", {});
    showCsdnAssistStatus(window, ["CSDN 编辑器加载超时。", "请确认浏览器已打开 CSDN 编辑器；若未登录请先登录，再重新发起。"]);
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
    await persistCsdnFill(jobId, { verifiedFields: [], state: "needs_login", reason: "CSDN 编辑器未登录，请先在浏览器登录后再发起发布。" });
    // 窗口载着该任务（停在登录页），标记后“重新打开”只提到前台，不再重跑。
    state.csdnWindowJobId = jobId;
    showCsdnAssistStatus(window, ["CSDN 编辑器尚未登录。", "请在打开的浏览器中登录 CSDN，然后回到文渡重新点击“在浏览器中完成发布”。"]);
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
    await persistCsdnFill(jobId, {
      verifiedFields,
      state: fill.title || fill.content ? "needs_user" : "failed_before_submit",
      reason: "未能可靠填充标题或正文；请在浏览器中手动补齐，再回到文渡点击“确认结果”。"
    });
    // needs_user：窗口确实载着该任务（只是没填全），标记后“重新打开”只提到前台，
    // 不再重填，避免覆盖用户在编辑器里的手动补齐。failed_before_submit 不标记，
    // 因为内容基本是空的，下次应走完整流程重填。
    if (fill.title || fill.content) state.csdnWindowJobId = jobId;
    showCsdnAssistStatus(window, [
      "已打开 CSDN 编辑器，但标题或正文未能自动填充。",
      "请在浏览器中手动补齐内容；确认无误后，回到文渡点击“确认结果”。"
    ]);
    return;
  }

  await persistCsdnFill(jobId, { verifiedFields: ["title", "content"], state: "ready_for_final_confirmation" });
  // 成功填充后标记窗口载着该任务：下次点“重新打开”走轻量路径（仅提到前台 + 重启轮询），
  // 不再抓稿/重传图片/重填编辑器。必须用持久化成功作为标记时机，避免一次失败的全流程
  // 让下次“重新打开”误判为轻量路径而跳过重填。
  state.csdnWindowJobId = jobId;
  const statusLines = [
    "已填充标题与正文。",
    imageUpload.replaced.size > 0 ? `已将 ${imageUpload.replaced.size} 张图片上传到 CSDN 图床并替换正文链接。` : (draft.images.length === 0 ? "" : "本文没有需要上传的本地图片。")
  ];
  if (imageUpload.failures.length > 0) {
    statusLines.push(`有 ${imageUpload.failures.length} 张图片未能上传到 CSDN 图床（CSDN 编辑器中这些图片会显示“转存失败”，需手动处理或重试）：`);
    for (const failure of imageUpload.failures.slice(0, 8)) {
      statusLines.push(`  • ${failure.source}`);
      if (failure.reason) statusLines.push(`    原因：${failure.reason}`);
    }
    if (imageUpload.failures.length > 8) {
      statusLines.push(`  … 还有 ${imageUpload.failures.length - 8} 张。`);
    }
    appendCsdnDiagnostics(`CSDN 图片上传失败明细（${imageUpload.failures.length} 张）：${JSON.stringify(imageUpload.failures)}`);
    statusLines.push(`完整诊断已写入文件：${csdnDiagnosticsPath()}`);
    statusLines.push("请把该文件的全部内容发给我，即可精准定位失败原因。");
  }
  statusLines.push("请在浏览器中点击 CSDN 编辑器的“发布文章”按钮；弹出设置框后，文渡会自动填充摘要、选项并提交。");
  statusLines.push("若自动提交失败，可回到文渡点击“确认结果”手动记录。");
  showCsdnAssistStatus(window, statusLines.filter(Boolean));

  // 启动后台轮询，等待用户点击“发布文章”后弹出的设置框并自动处理。
  // 封面用主稿真实封面（getBrowserDraft 已解析为 dataUrl），不再用正文第一张图。
  startCsdnPublishDialogPoller(jobId, draft.digest, draft.coverDataUrl, window);

  if (imageUpload.failures.length > 0) {
    console.error("[contentferry] CSDN 图片上传失败明细：", JSON.stringify({
      jobId,
      uploadedCount: imageUpload.replaced.size,
      failedCount: imageUpload.failures.length,
      failures: imageUpload.failures
    }, null, 2));
  }
}

let activeCsdnDialogPoller: { jobId: string; timer: NodeJS.Timeout } | null = null;

function stopCsdnDialogPoller(): void {
  if (activeCsdnDialogPoller) {
    clearInterval(activeCsdnDialogPoller.timer);
    activeCsdnDialogPoller = null;
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

function startCsdnPublishDialogPoller(jobId: string, digest: string, coverDataUrl: string | undefined, window: BrowserWindow): void {
  stopCsdnDialogPoller();
  logCsdnBrowserAssist("dialog-poller-started", { jobId });
  const timer = setInterval(async () => {
    if (window.isDestroyed()) {
      stopCsdnDialogPoller();
      return;
    }
    const result = await window.webContents.executeJavaScript(`(function(digest, coverDataUrl){
      ${FILL_CSDN_PUBLISH_DIALOG_SCRIPT}
      return fillCsdnPublishDialog({digest: digest, coverDataUrl: coverDataUrl});
    })(${JSON.stringify(digest)}, ${JSON.stringify(coverDataUrl)})`).catch((error: unknown) => ({
      dialogFound: false,
      error: error instanceof Error ? error.message : String(error)
    }));
    logCsdnBrowserAssist("dialog-scan", { jobId, ...result });
    if (result.dialogFound && result.submitClicked) {
      stopCsdnDialogPoller();
      logCsdnBrowserAssist("dialog-submitted", { jobId });
      const remoteUrl = await waitForCsdnArticleUrl(window, 25000);
      if (remoteUrl) {
        const contentIdMatch = /article\/details\/(\d+)/.exec(remoteUrl);
        const remoteContentId = contentIdMatch ? contentIdMatch[1] : null;
        logCsdnBrowserAssist("dialog-receipt-read", { jobId, remoteUrl, remoteContentId });
        try {
          await fetch(`${CSDN_API_BASE}/api/integrations/csdn/jobs/${jobId}/record-submission`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ remoteUrl, remoteContentId })
          });
          showCsdnAssistStatus(window, ["已在 CSDN 发布，已回写文章链接：", remoteUrl]);
        } catch (error) {
          logCsdnBrowserAssist("dialog-record-submission-failed", { jobId, error: error instanceof Error ? error.message : String(error) });
          showCsdnAssistStatus(window, ["已读取 CSDN 文章链接，但回写状态失败：", remoteUrl, "请回到文渡点击“我已在 CSDN 发布”完成记录。"]);
        }
      } else {
        logCsdnBrowserAssist("dialog-receipt-timeout", { jobId });
        showCsdnAssistStatus(window, ["已自动填写发布设置并点击发布，但未能自动读取文章链接。", "请在浏览器确认发布结果；如已发布，可人工校正并粘贴链接。"]);
      }
    }
  }, 1500);
  activeCsdnDialogPoller = { jobId, timer };
}

export async function confirmCsdnBrowserPublish(jobId: string): Promise<{ remoteUrl: string | null; remoteContentId: string | null } | null> {
  stopCsdnDialogPoller();
  const window = state.csdnWindow;
  if (!window || window.isDestroyed()) {
    logCsdnBrowserAssist("confirm-window-missing", { jobId });
    return null;
  }
  window.show();
  window.focus();

  // 读取渠道稿摘要与封面（封面为主稿真实封面，getBrowserDraft 已解析为 dataUrl）。
  let digest = "";
  let coverDataUrl: string | undefined;
  try {
    const response = await fetch(`${CSDN_API_BASE}/api/integrations/csdn/jobs/${jobId}`);
    if (response.ok) {
      const payload = await response.json() as { draft: { digest: string; images: Array<{ dataUrl: string }>; coverDataUrl?: string } };
      digest = payload.draft.digest || "";
      coverDataUrl = payload.draft.coverDataUrl;
    }
  } catch (error) {
    logCsdnBrowserAssist("confirm-fetch-draft-failed", { jobId, error: error instanceof Error ? error.message : String(error) });
  }

  showCsdnAssistStatus(window, ["正在点击 CSDN 的“发布文章”按钮……", "若页面要求二次确认，请在浏览器中完成。"]);
  const clicked = await window.webContents.executeJavaScript(`(function(){
    var buttons = Array.prototype.slice.call(document.querySelectorAll('button, .btn, a.btn'));
    var target = buttons.find(function(b){ return /发布文章|发布$/.test((b.textContent || '').trim()); });
    if (!target) return false;
    target.click();
    return true;
  })()`).catch(() => false);
  if (!clicked) {
    logCsdnBrowserAssist("publish-button-not-found", { jobId });
    showCsdnAssistStatus(window, ["未找到 CSDN 的“发布文章”按钮。", "请在浏览器中手动点击发布；发布成功后回到文渡点击“我已在 CSDN 发布”。"]);
    return null;
  }

  // 等待弹框出现并自动填充摘要、封面、选项，然后点击弹框内的发布按钮。
  // 弹框可能延迟出现，轮询至多约 9 秒。
  let dialogResult: Record<string, unknown> = { dialogFound: false };
  for (let attempt = 0; attempt < 6; attempt++) {
    await delay(1200);
    dialogResult = await window.webContents.executeJavaScript(`(function(digest, coverDataUrl){
      ${FILL_CSDN_PUBLISH_DIALOG_SCRIPT}
      return fillCsdnPublishDialog({digest: digest, coverDataUrl: coverDataUrl});
    })(${JSON.stringify(digest)}, ${JSON.stringify(coverDataUrl)})`).catch((error: unknown) => ({ dialogFound: false, error: error instanceof Error ? error.message : String(error) }));
    logCsdnBrowserAssist("confirm-dialog-fill", { jobId, attempt, ...dialogResult });
    if (dialogResult.submitClicked) break;
  }

  const remoteUrl = await waitForCsdnArticleUrl(window, 20000);
  if (!remoteUrl) {
    logCsdnBrowserAssist("receipt-not-read", { jobId });
    showCsdnAssistStatus(window, ["已尝试点击发布，但未能自动读取 CSDN 文章链接。", "请在浏览器确认发布结果；如已发布，可人工校正并粘贴链接。"]);
    return null;
  }
  const contentIdMatch = /article\/details\/(\d+)/.exec(remoteUrl);
  const remoteContentId = contentIdMatch ? contentIdMatch[1] : null;
  logCsdnBrowserAssist("receipt-read", { remoteUrl, remoteContentId });
  showCsdnAssistStatus(window, ["已在 CSDN 发布，已回写文章链接：", remoteUrl]);
  return { remoteUrl, remoteContentId };
}

