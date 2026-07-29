/**
 * Stealth preload for the research (DuckDuckGo) browser window.
 *
 * Ported from gstack's anti-detection `stealth.ts` — specifically its Layer C,
 * the always-on *consistency-first* default. gstack's full stealth is a
 * Chromium page init-script that masks automation tells; here it runs as an
 * Electron preload on the research window's own session so DuckDuckGo sees a
 * real, coherent browser instead of an automation-shaped one.
 *
 * We keep ONLY the consistency-first masks and deliberately drop gstack's
 * opt-in "extended" mode (which actively lies about plugins/WebGL) — those can
 * flag MORE bot-like and may break sites. Every patch is wrapped so a failure
 * on one tell never breaks page load.
 *
 * No DOM lib is in tsconfig.main.json, so the page globals are reached through
 * a single `globalThis` cast rather than ambient `window`/`navigator` types.
 */
interface PreloadNavigator {
  webdriver?: unknown;
  hardwareConcurrency?: unknown;
  deviceMemory?: unknown;
  permissions?: { query?: (params: { name?: string }) => Promise<{ state: string; onchange: null }> };
}
interface PreloadGlobal {
  navigator: PreloadNavigator;
  window?: { chrome?: Record<string, unknown> };
  Notification?: { permission?: unknown };
  performance?: { now?: () => number; timing?: Record<string, number> };
}

const g = globalThis as unknown as PreloadGlobal;

const markNative = (fn: (...args: unknown[]) => unknown, name: string): (...args: unknown[]) => unknown => {
  try {
    Object.defineProperty(fn, "name", { value: name });
  } catch {
    /* non-fatal */
  }
  return fn;
};

(() => {
  // ── navigator.webdriver (canonical headless / automation tell) ──
  try {
    Object.defineProperty(g.navigator, "webdriver", {
      get: markNative(() => false, "get webdriver") as () => boolean,
      configurable: true
    });
  } catch {
    /* non-fatal */
  }

  // ── window.chrome.* restoration (real Chrome ships these shapes) ──
  try {
    if (!g.window) g.window = {};
    const chrome = g.window.chrome ?? (g.window.chrome = {});
    if (!chrome.runtime) {
      chrome.runtime = {
        OnInstalledReason: { CHROME_UPDATE: "chrome_update", INSTALL: "install", SHARED_MODULE_UPDATE: "shared_module_update", UPDATE: "update" },
        OnRestartRequiredReason: { APP_UPDATE: "app_update", OS_UPDATE: "os_update", PERIODIC: "periodic" },
        PlatformArch: { ARM: "arm", ARM64: "arm64", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
        PlatformNaclArch: { ARM: "arm", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
        PlatformOs: { ANDROID: "android", CROS: "cros", LINUX: "linux", MAC: "mac", OPENBSD: "openbsd", WIN: "win" },
        RequestUpdateCheckStatus: { NO_UPDATE: "no_update", THROTTLED: "throttled", UPDATE_AVAILABLE: "update_available" },
        connect: markNative(() => { throw new TypeError("Error in invocation of runtime.connect: No matching signature."); }, "connect"),
        sendMessage: markNative(() => { throw new TypeError("Error in invocation of runtime.sendMessage: No matching signature."); }, "sendMessage"),
        id: undefined
      };
    }
    if (!chrome.app) {
      chrome.app = { isInstalled: false, InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" }, RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" } };
    }
    if (typeof chrome.csi !== "function") {
      chrome.csi = markNative(() => ({ onloadT: Date.now(), pageT: g.performance?.now?.() ?? 0, startE: Date.now() - 1000, tran: 15 }), "csi");
    }
    if (typeof chrome.loadTimes !== "function") {
      chrome.loadTimes = markNative(() => {
        const t = g.performance?.timing ?? {};
        return {
          requestTime: (t.requestStart ?? 0) / 1000,
          startLoadTime: (t.requestStart ?? 0) / 1000,
          commitLoadTime: (t.responseStart ?? 0) / 1000,
          finishDocumentLoadTime: (t.domContentLoadedEventEnd ?? 0) / 1000,
          finishLoadTime: (t.loadEventEnd ?? 0) / 1000,
          firstPaintTime: (t.responseEnd ?? 0) / 1000,
          firstPaintAfterLoadTime: 0,
          navigationType: "Other",
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true,
          npnNegotiatedProtocol: "h2",
          wasAlternateProtocolAvailable: false,
          connectionInfo: "h2"
        };
      }, "loadTimes");
    }
  } catch {
    /* non-fatal */
  }

  // ── Notification.permission aligned with the Permissions API spoof ──
  try {
    if (g.Notification) {
      Object.defineProperty(g.Notification, "permission", {
        get: markNative(() => "default", "get permission") as () => string,
        configurable: true
      });
    }
  } catch {
    /* non-fatal */
  }

  // ── Permissions API: automated Chromium reports 'denied' for notifications;
  //    real Chrome reports 'prompt'. Align the two surfaces for consistency. ──
  try {
    const orig = g.navigator.permissions?.query;
    if (orig) {
      g.navigator.permissions!.query = (params: { name?: string }) => {
        if (params && params.name === "notifications") {
          return Promise.resolve({ state: "prompt", onchange: null });
        }
        return orig.call(g.navigator.permissions, params);
      };
    }
  } catch {
    /* non-fatal */
  }

  // ── hardwareConcurrency / deviceMemory (avoid 0 / NaN bot tells) ──
  try {
    Object.defineProperty(g.navigator, "hardwareConcurrency", {
      get: markNative(() => 8, "get hardwareConcurrency") as () => number,
      configurable: true
    });
  } catch {
    /* non-fatal */
  }
  try {
    Object.defineProperty(g.navigator, "deviceMemory", {
      get: markNative(() => 8, "get deviceMemory") as () => number,
      configurable: true
    });
  } catch {
    /* non-fatal */
  }

  // ── Selenium / Playwright / Phantom global cleanup (defensive) ──
  try {
    const auto = [
      "__driver_evaluate", "__webdriver_evaluate", "__selenium_evaluate", "__fxdriver_evaluate",
      "__driver_unwrapped", "__webdriver_unwrapped", "__selenium_unwrapped", "__fxdriver_unwrapped",
      "_Selenium_IDE_Recorder", "_selenium", "calledSelenium",
      "$chrome_asyncScriptInfo", "__$webdriverAsyncExecutor", "__webdriverFunc",
      "domAutomation", "domAutomationController",
      "__lastWatirAlert", "__lastWatirConfirm", "__lastWatirPrompt",
      "__webdriver_script_fn", "_WEBDRIVER_ELEM_CACHE",
      "callPhantom", "_phantom", "phantom", "__nightmare",
      "__pwInitScripts", "__playwright__binding__"
    ];
    const w = g.window as unknown as Record<string, unknown> | undefined;
    if (w) {
      for (const k of auto) {
        try {
          delete w[k];
        } catch {
          /* non-fatal */
        }
      }
    }
  } catch {
    /* non-fatal */
  }
})();
