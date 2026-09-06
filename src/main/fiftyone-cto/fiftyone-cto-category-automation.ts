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
/**
 * 抓取总预算。过去只抓「一级栏目 + 当前选中的二级分类」，20s 足够；
 * 现在要逐个一级栏目触发联动并各抓一次二级分类，预算需覆盖多个 pid 的往返。
 */
const CATEGORY_SCRAPE_TIMEOUT_MS = 45_000;
/** 单个一级栏目下等待二级列表刷新的上限；实际还会受总预算约束。 */
const PER_PID_WAIT_MS = 2_500;

export interface FiftyoneCtoCategoryOption {
  value: string;
  label: string;
}

export interface FiftyoneCtoCategories {
  pidOptions: FiftyoneCtoCategoryOption[];
  cateOptions: FiftyoneCtoCategoryOption[];
  /**
   * 按一级栏目分组的二级分类：{ "<pid>": [{value,label}...] }。
   * 51CTO 的「授权分类」是随「一级栏目」联动的，只有选中某个 pid 才能读到它名下的二级分类，
   * 因此必须逐个 pid 抓取并分组保存；渲染层据此在切换一级栏目时刷新二级下拉。
   */
  cateOptionsByPid: Record<string, FiftyoneCtoCategoryOption[]>;
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

  const result = await scrapeWithRetry(window, CATEGORY_SCRAPE_TIMEOUT_MS);
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
 * 抓取分类：
 * 1. 轮询等「一级栏目(pid)」填充完成（发布页是 SPA，异步渲染）；
 * 2. 逐个选中每个一级栏目，读取它名下的「授权分类(cate_id)」——51CTO 的二级分类是
 *    随一级联动的，不逐个点开就只能拿到默认那一个 pid 的子集，会出现「二级分类写死」。
 *
 * 任一步超时都返回已抓到的部分，并保留 debug 供诊断，不抛错中断用户操作。
 */
async function scrapeWithRetry(window: BrowserWindow, timeoutMs: number): Promise<FiftyoneCtoCategories> {
  const deadline = Date.now() + timeoutMs;
  let last: FiftyoneCtoCategories = { pidOptions: [], cateOptions: [], cateOptionsByPid: {}, debug: undefined };

  // 阶段一：等一级栏目出现。
  while (Date.now() < deadline && !window.isDestroyed()) {
    const snapshot = await readSnapshot(window);
    if (snapshot) {
      last = snapshot;
      if (snapshot.pidOptions.length > 0) break;
    }
    await delay(800);
  }
  if (last.pidOptions.length === 0 || window.isDestroyed()) return last;

  // 阶段二：逐个选中一级栏目，抓各自名下的二级分类。
  const cateOptionsByPid: Record<string, FiftyoneCtoCategoryOption[]> = {};
  for (const pid of last.pidOptions) {
    if (window.isDestroyed() || Date.now() >= deadline) break;
    const clicked = await window.webContents
      .executeJavaScript(selectPidScript(pid.value), true)
      .then((ok) => ok === true)
      .catch(() => false);
    if (!clicked) continue;
    const options = await waitForCateOptions(window, Math.min(PER_PID_WAIT_MS, Math.max(0, deadline - Date.now())));
    if (options.length > 0) cateOptionsByPid[pid.value] = options;
  }

  // cateOptions 保留为所有分组的并集（去重），供老数据/降级路径使用：
  // 没拿到分组映射时，至少还能像以前一样给出一份可用选项。
  const merged = new Map<string, FiftyoneCtoCategoryOption>();
  for (const options of Object.values(cateOptionsByPid)) {
    for (const option of options) if (!merged.has(option.value)) merged.set(option.value, option);
  }
  // 若一个分组都没抓到（例如页面结构变了），退回阶段一读到的 cateOptions，避免清空已有缓存。
  const fallbackCate = Object.keys(cateOptionsByPid).length > 0 ? [...merged.values()] : last.cateOptions;
  return { pidOptions: last.pidOptions, cateOptions: fallbackCate, cateOptionsByPid, debug: last.debug };
}

/** 在页面上下文里读取当前已选一级栏目对应的二级分类列表。 */
function waitForCateOptions(window: BrowserWindow, timeoutMs: number): Promise<FiftyoneCtoCategoryOption[]> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let last: FiftyoneCtoCategoryOption[] = [];
  const attempt = async (): Promise<FiftyoneCtoCategoryOption[]> => {
    while (Date.now() < deadline && !window.isDestroyed()) {
      const options = await readCurrentCateOptions(window);
      if (options.length > 0) return options;
      last = options;
      await delay(400);
    }
    return last;
  };
  return attempt();
}

async function readCurrentCateOptions(window: BrowserWindow): Promise<FiftyoneCtoCategoryOption[]> {
  if (window.isDestroyed()) return [];
  const value = await window.webContents.executeJavaScript(scrapeCateScript(), true).catch(() => null) as unknown;
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is FiftyoneCtoCategoryOption => !!item && typeof item === "object" && typeof (item as { value?: unknown }).value === "string" && typeof (item as { label?: unknown }).label === "string")
    .map((item) => ({ value: item.value, label: item.label }));
}

async function readSnapshot(window: BrowserWindow): Promise<FiftyoneCtoCategories | null> {
  if (window.isDestroyed()) return null;
  const value = await window.webContents.executeJavaScript(scrapeScript(), true).catch(() => null) as unknown;
  return isCategories(value) ? value : null;
}

/** 选中指定 value 的一级栏目：先展开下拉面板（若有触发区），再点击对应项。 */
function selectPidScript(pidValue: string): string {
  return `(() => {
    const wanted = ${JSON.stringify(String(pidValue))};
    const one = document.getElementById('oneLever');
    if (!one) return false;
    // 自定义下拉通常需要先点开面板，选项才可见/可点（不同页面实现不同，两步都试）。
    const trigger = one.querySelector('.select_header, .select-current, .select_current, .current, .select_box, .select_trigger');
    if (trigger) trigger.click();
    const items = [...one.querySelectorAll('.select_item')];
    const target = items.find((el) => (el.getAttribute('value') || (el.dataset && el.dataset.value) || '') === wanted)
      || items.find((el) => ((el.textContent || '').trim()) === wanted);
    if (!target) return false;
    target.click();
    return true;
  })()`;
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

/**
 * 只读取当前已展开的二级分类列表（在选中某个一级栏目之后调用）。
 * 选择器与 scrapeScript 保持一致，避免两处漂移。
 */
function scrapeCateScript(): string {
  return `(() => {
    const clean = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
    const twoLever = document.getElementById('twoLever');
    const fromDiv = twoLever
      ? [...twoLever.querySelectorAll('.second-types-item')].map((el) => ({
          value: el.getAttribute('value') || el.dataset.value || '',
          label: clean(el.textContent)
        })).filter((o) => o.value && o.label && !/^(请选择|选择|不限|无)$/.test(o.label))
      : [];
    if (fromDiv.length > 0) return fromDiv;
    // 兜底：原生 select
    const selects = [...document.querySelectorAll('select')];
    const cateSelect = selects.find((s) => /cate/.test((s.name || '').toLowerCase()) || /cate/.test((s.id || '').toLowerCase()));
    if (!cateSelect) return [];
    return [...cateSelect.querySelectorAll('option')]
      .map((o) => ({ value: o.value, label: clean(o.textContent) }))
      .filter((o) => o.value && o.label && !/^(请选择|选择|不限)/.test(o.label));
  })()`;
}
