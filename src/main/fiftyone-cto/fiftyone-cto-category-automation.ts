/**
 * 51CTO 发布分类抓取（镜像博客园的「弹窗加载后保存到本地」做法）。
 *
 * 与博客园不同：博客园的登录态保存在持久化 session 分区里，弹窗直接读 DOM 即可；
 * 51CTO 的 Cookie 只存在 vault（加密），发布页不会自动带登录态。因此这里打开一个
 * 浏览器窗口，先把 vault 里的 51CTO Cookie 注入到该窗口 session，再加载发布页，
 * 用 executeJavaScript 抓取「一级栏目(pid)」「授权分类(cate_id)」的 `<select>` 选项，
 * 返回 {value,label} 列表供发布设置下拉使用，并由调用方持久化到 account_profiles。
 */
import { BrowserWindow } from "electron";
import { state } from "../automation/state";
import { createWenduWindowIcon } from "../automation/windows";
import { delay } from "../automation/delay";
import type { AccountRepository, MediaAccount } from "../accounts/account-repository";
import type { CredentialVault } from "../security/credential-vault";

const FIFTYONE_CTO_PUBLISH_URL = "https://blog.51cto.com/blogger/publish?old=1&orig=first-publish";
const COOKIE_SETTLE_MS = 600;

export interface FiftyoneCtoCategoryOption {
  value: string;
  label: string;
}

export interface FiftyoneCtoCategories {
  pidOptions: FiftyoneCtoCategoryOption[];
  cateOptions: FiftyoneCtoCategoryOption[];
  /** 调试用：真实 DOM 结构与抓取到的分类相关文本节点，便于校准选择器。 */
  debug?: {
    selects: Array<{ name: string; id: string; label: string; count: number; sample: FiftyoneCtoCategoryOption[] }>;
    categoryTextNodes: Array<{ tag: string; text: string }>;
  };
}

/**
 * 打开 51CTO 发布页（注入 vault Cookie 后），抓取一级栏目与授权分类选项。
 * 抓取成功后由调用方负责持久化到 account_profiles，弹窗随后关闭。
 */
export async function readFiftyoneCtoCategories(account: MediaAccount, accounts: AccountRepository, vault: CredentialVault): Promise<FiftyoneCtoCategories> {
  const window = await getOrCreateWindow();
  window.show();
  window.focus();

  let cookie = "";
  try {
    cookie = accounts.getCredential(account.id, "fiftyone_cto_cookie", vault);
  } catch {
    throw new Error("51CTO 账号尚未配置 Cookie，请先到账号管理完成配置后再加载分类。");
  }
  if (!cookie.trim()) throw new Error("51CTO 账号尚未配置 Cookie，请先到账号管理完成配置后再加载分类。");

  await injectCookie(window, cookie);
  await window.loadURL(FIFTYONE_CTO_PUBLISH_URL).catch(() => { /* loadURL 在登录态保活/重定向下可能延迟 reject，下面用轮询兜底 */ });

  const result = await scrapeWithRetry(window, 20_000);
  if (!window.isDestroyed()) window.close();
  return result;
}

async function getOrCreateWindow(): Promise<BrowserWindow> {
  if (state.fiftyoneCtoCategoryWindow && !state.fiftyoneCtoCategoryWindow.isDestroyed()) return state.fiftyoneCtoCategoryWindow;
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    show: true,
    title: "文渡 · 51CTO 发布分类",
    icon: createWenduWindowIcon(),
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  state.fiftyoneCtoCategoryWindow = window;
  window.on("closed", () => { if (state.fiftyoneCtoCategoryWindow === window) state.fiftyoneCtoCategoryWindow = undefined; });
  return window;
}

/** 把 vault 里的 51CTO Cookie 字符串写入窗口 session（domain 统一为 .51cto.com）。 */
async function injectCookie(window: BrowserWindow, cookie: string): Promise<void> {
  const pairs = cookie.split(";").map((piece) => piece.trim()).filter(Boolean);
  for (const piece of pairs) {
    const eq = piece.indexOf("=");
    if (eq < 0) continue;
    const name = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    if (!name) continue;
    try {
      await window.webContents.session.cookies.set({
        url: "https://blog.51cto.com",
        name,
        value,
        domain: ".51cto.com",
        path: "/",
        secure: false,
        httpOnly: false
      });
    } catch {
      /* 单个 cookie 写入失败不影响其余 */
    }
  }
  await delay(COOKIE_SETTLE_MS);
}

/**
 * 轮询抓取：发布页可能 SPA 异步填充分类下拉，给足等待时间。
 * 若「授权分类」在选了一级栏目后才出现（级联），会先选第一个 pid 触发级联再抓 cate。
 */
async function scrapeWithRetry(window: BrowserWindow, timeoutMs: number): Promise<FiftyoneCtoCategories> {
  const deadline = Date.now() + timeoutMs;
  let last: FiftyoneCtoCategories = { pidOptions: [], cateOptions: [], debug: undefined };
  let cascaded = false;
  while (Date.now() < deadline && !window.isDestroyed()) {
    const snapshot = await window.webContents.executeJavaScript(scrapeScript(), true) as unknown;
    if (isCategories(snapshot)) {
      last = snapshot;
      if (snapshot.pidOptions.length > 0 && snapshot.cateOptions.length > 0) return snapshot;
      // pid 有选项但 cate 还没有：可能是级联，先点第一个一级分类触发二级加载，再等一轮。
      if (snapshot.pidOptions.length > 0 && snapshot.cateOptions.length === 0 && !cascaded) {
        await window.webContents.executeJavaScript(`(() => {
          const one = document.getElementById('oneLever');
          const first = one && one.querySelector('.select_item');
          if (first) { first.click(); }
        })()`, true).catch(() => {});
        cascaded = true;
      }
    }
    await delay(800);
  }
  return last;
}

function isCategories(value: unknown): value is FiftyoneCtoCategories {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.pidOptions) && Array.isArray(record.cateOptions);
}

/** 在页面上下文里抓取分类选项。51CTO 发布页使用自定义 div 下拉（#oneLever / #twoLever），不是原生 <select>。 */
function scrapeScript(): string {
  return `(() => {
    const clean = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
    const cssEscape = (s) => (s || '').replace(/["\\\\]/g, '\\\\$&');
    const labelOf = (el) => {
      if (el.id) {
        const lab = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
        if (lab) return clean(lab.textContent);
      }
      let p = el.parentElement;
      for (let i = 0; p && i < 6; i++, p = p.parentElement) {
        const direct = [...p.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ');
        if (clean(direct)) return clean(direct);
        const lab = p.querySelector(':scope > label');
        if (lab) return clean(lab.textContent);
      }
      return '';
    };
    const toDivOpts = (container, itemSelector) => {
      if (!container) return [];
      return [...container.querySelectorAll(itemSelector)].map((el) => {
        const value = el.getAttribute('value') || el.dataset.value || '';
        const label = clean(el.textContent);
        return { value, label };
      }).filter((o) => o.value && o.label && !/^(请选择|选择|不限|无)$/.test(o.label));
    };
    const toSelectOpts = (sel) => [...sel.querySelectorAll('option')].map((o) => ({ value: o.value, label: clean(o.textContent) })).filter((o) => o.value && o.label && !/^(请选择|选择|不限)/.test(o.label));
    // 51CTO 当前实际使用自定义 div 下拉：#oneLever .select_item（一级），#twoLever .second-types-item（二级）
    const oneLever = document.getElementById('oneLever');
    const twoLever = document.getElementById('twoLever');
    const pid = toDivOpts(oneLever, '.select_item');
    const cate = toDivOpts(twoLever, '.second-types-item');
    // 兜底：如果 div 下拉为空，再尝试原生 select
    if (!pid.length || !cate.length) {
      const selects = [...document.querySelectorAll('select')];
      const norm = (s) => (s || '').toLowerCase();
      const pidSelect = selects.find((s) => /(^|[-_])pid($|[-_])/.test(norm(s.name)) || /(^|[-_])pid($|[-_])/.test(norm(s.id)) || /一级|栏目/.test(labelOf(s)));
      const cateSelect = selects.find((s) => /cate/.test(norm(s.name)) || /cate/.test(norm(s.id)) || /授权|分类/.test(labelOf(s)));
      if (!pid.length && pidSelect) pid.push(...toSelectOpts(pidSelect));
      if (!cate.length && cateSelect) cate.push(...toSelectOpts(cateSelect));
    }
    const debug = {
      divDropdowns: [
        { id: 'oneLever', selector: '.select_item', count: pid.length, sample: pid.slice(0, 5) },
        { id: 'twoLever', selector: '.second-types-item', count: cate.length, sample: cate.slice(0, 5) }
      ],
      selects: [...document.querySelectorAll('select')].map((s) => ({ name: s.name, id: s.id, label: labelOf(s), count: s.options.length, sample: toSelectOpts(s).slice(0, 5) })),
      categoryTextNodes: [...document.querySelectorAll('*')].filter((n) => n.children.length === 0 && /栏目|分类|授权/.test(n.textContent || '')).slice(0, 20).map((n) => ({ tag: n.tagName, text: clean(n.textContent) }))
    };
    return { pidOptions: pid, cateOptions: cate, debug };
  })()`;
}
