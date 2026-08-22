import path from "node:path";
import fs from "node:fs";
import { BrowserWindow, session } from "electron";
import { BrowserVerificationRequiredError, type SearchResultItem } from "../ai/web-search";
import { loadAppSettings } from "../config/first-run";
import { state, enqueueResearchSearch } from "./state";
import { createWenduWindowIcon } from "./windows";
import { delay } from "./delay";

async function getOrCreateResearchBrowserWindow(): Promise<BrowserWindow> {
  if (state.researchBrowserWindow && !state.researchBrowserWindow.isDestroyed()) return state.researchBrowserWindow;
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    show: false,
    title: "文渡 · 联网检索协助",
    icon: createWenduWindowIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: "persist:contentferry-research"
    }
  });
  state.researchBrowserWindow = window;
  window.on("closed", () => { if (state.researchBrowserWindow === window) state.researchBrowserWindow = undefined; });
  // Inject gstack's Layer-C stealth into the page's MAIN world. A plain preload
  // runs in Electron's isolated world under contextIsolation, so its patches on
  // navigator.webdriver/window.chrome would be invisible to the page — a silent
  // no-op. CDP addScriptToEvaluateOnNewDocument runs in the main world (exactly
  // like Playwright's addInitScript), so DuckDuckGo's own JS sees the masked
  // tells. Stealth is best-effort: any failure degrades to a visible window.
  await installResearchStealth(window);
  // Apply the global research proxy to this session partition too, so the
  // visible-browser fallback routes through the same proxy as the fetch layer.
  await applyResearchProxy(window);
  return window;
}

/**
 * Port of gstack's "consistency-first" anti-detection into the page main world.
 * Reads the compiled `research-stealth-preload.js` (same source of truth as the
 * old preload) and registers it as a CDP init script on the window's debugger.
 */
async function installResearchStealth(window: BrowserWindow): Promise<void> {
  const stealthSourcePath = path.join(__dirname, "research-stealth-preload.js");
  if (!fs.existsSync(stealthSourcePath)) return;
  let source: string;
  try {
    source = fs.readFileSync(stealthSourcePath, "utf8");
  } catch {
    return;
  }
  const dbg = window.webContents.debugger;
  try {
    if (!dbg.isAttached()) dbg.attach("1.3");
    await dbg.sendCommand("Page.enable");
    await dbg.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source });
  } catch {
    /* stealth is best-effort; never block research over it */
  }
}

/** Point a session partition at the global research proxy (or clear it).
 * Mirrors the proxy used by the fetch-based providers so both channels behave
 * identically. A blank/invalid value falls back to a direct connection. */
export async function applyProxyToPartition(partition: string): Promise<void> {
  const proxy = loadAppSettings().researchProxyUrl?.trim() ?? "";
  try {
    const targetSession = session.fromPartition(partition);
    if (proxy) {
      const parsed = new URL(proxy);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "socks5:") {
        console.warn(`[contentferry] 检索代理协议不支持，已忽略并直连：${proxy}`);
        await targetSession.setProxy({ proxyRules: "" });
        return;
      }
      await targetSession.setProxy({ proxyRules: proxy });
    } else {
      await targetSession.setProxy({ proxyRules: "" });
    }
  } catch {
    /* proxy misconfiguration must not block the browser */
  }
}

/** Apply the global research proxy to the research session partition. */
async function applyResearchProxy(window: BrowserWindow): Promise<void> {
  await applyProxyToPartition("persist:contentferry-research");
}

const RESEARCH_RENDER_TIMEOUT_MS = 12_000;
const RESEARCH_POLL_INTERVAL_MS = 400;

/** Read the current rendered results from the research window. DuckDuckGo's
 * result links are wrapped in `uddg=` redirectors; we decode them back to the
 * final source URL so citations, material cards and audit trails stay clean. */
async function readResearchOutcome(window: BrowserWindow, sliceLimit: number): Promise<{ blocked: boolean; links: SearchResultItem[] }> {
  return window.webContents.executeJavaScript(`(() => {
    const decodeDdg = (href) => {
      try {
        const m = /[?&]uddg=([^&]+)/.exec(href);
        if (m) {
          const b = decodeURIComponent(m[1]).replace(/-/g, "+").replace(/_/g, "/");
          const bin = atob(b);
          return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
        }
        const u = /[?&]url=([^&]+)/.exec(href);
        if (u) return decodeURIComponent(u[1]);
      } catch (e) {}
      return href;
    };
    const text = (document.body && document.body.innerText || "").replace(/\\s+/g, " ").trim();
    const blocked = /captcha|verify you are human|unusual traffic|anomaly|机器人|人机验证|安全验证/i.test(text);
    const links = [...document.querySelectorAll("a.result__a")].map((node) => ({
      title: (node.textContent || "").replace(/\\s+/g, " ").trim(),
      url: decodeDdg(node.href),
      snippet: (node.closest(".result")?.querySelector(".result__snippet")?.textContent || "").replace(/\\s+/g, " ").trim()
    })).filter((item) => /^https?:\\/\\//.test(item.url) && item.title);
    return { blocked: blocked, links: links.slice(0, ${sliceLimit}) };
  })()`, true) as Promise<{ blocked: boolean; links: SearchResultItem[] }>;
}

/** Wait for the page to actually render results instead of a blind fixed delay.
 * A slow network no longer produces a false "0 links" misread that would burn
 * every retry and wrongly escalate to a human-verification window. */
async function waitForResearchResults(window: BrowserWindow, sliceLimit: number, timeoutMs: number): Promise<{ blocked: boolean; links: SearchResultItem[] }> {
  const deadline = Date.now() + timeoutMs;
  let outcome = await readResearchOutcome(window, sliceLimit);
  while (!outcome.blocked && outcome.links.length === 0 && Date.now() < deadline) {
    await delay(RESEARCH_POLL_INTERVAL_MS);
    if (window.isDestroyed()) return outcome;
    outcome = await readResearchOutcome(window, sliceLimit);
  }
  return outcome;
}

export async function searchWithVisibleResearchBrowser(query: string, limit: number): Promise<SearchResultItem[]> {
  return enqueueResearchSearch(async () => {
    const window = await getOrCreateResearchBrowserWindow();
    const sliceLimit = Math.max(1, Math.min(limit, 10));
    // Layer 2 (lightweight auto-bypass): the window stays hidden and we retry a
    // few times before escalating to a human. Stealth (gstack Layer C, injected
    // into the main world via CDP) masks automation tells on every load, so most
    // blocks clear on the first pass.
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await window.loadURL(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=cn-zh`);
      const outcome = await waitForResearchResults(window, sliceLimit, RESEARCH_RENDER_TIMEOUT_MS);
      if (!outcome.blocked && outcome.links.length > 0) {
        // Success — keep the window out of the user's way.
        if (window.isVisible()) window.hide();
        return outcome.links;
      }
      if (outcome.blocked) break; // real block — stop retrying, go to human handoff
    }
    // Layer 3 (human handoff): automated bypass is exhausted. Surface the window
    // and hand control to the user. The persistent partition (Layer 4) keeps any
    // verification valid, so a retry after the user completes it usually succeeds
    // silently on the next pass.
    window.show();
    window.focus();
    throw new BrowserVerificationRequiredError();
  });
}

