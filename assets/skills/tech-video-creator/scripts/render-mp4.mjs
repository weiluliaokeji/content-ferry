// Render an anatomy explainer (a single HTML page built by build-video.mjs
// or any page that exposes window.__seek(t) and a .ev-video element) to MP4.
//
//   node render-mp4.mjs [--page <html>] [--out <mp4>] \
//                      [--theme dark|light] [--fps 24] [--scale 1.5] \
//                      [--seconds N] [--port 9333]
//
// Drives one headless Chrome over the DevTools Protocol: opens the explainer,
// calls the page's __seek(t) hook for every frame, screenshots just the
// .ev-video element, and pipes the PNGs straight into ffmpeg (no frame files).
//
// --page / --out are the generic knobs: pass an arbitrary HTML and the MP4
// path. When omitted, behaviour falls back to the bundled ev-brake-pedal
// example (theme decides the default filename) so old commands still work.
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, def) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

const PAGE = arg("page", "");        // optional explicit input HTML
const OUT = arg("out", "");          // optional explicit output MP4
const THEME = arg("theme", "dark");
const FPS = Number(arg("fps", "24"));
const SCALE = Number(arg("scale", "1.5"));
const SECONDS = Number(arg("seconds", "0"));
const PORT = Number(arg("port", "9333"));
const DUR_SCALE = Number(process.env.DUR_SCALE || "1");
const BASE_TOTAL = 67; // scene durations sum in build-video.mjs (DUR_SCALE=1)
const TOTAL = SECONDS > 0 ? SECONDS : BASE_TOTAL * DUR_SCALE;

const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const FFMPEG = process.env.FFMPEG_PATH || "D:/Tools/ffmpeg-2024-09-12-git-504c1ffcd8-full_build/bin/ffmpeg.exe";

// Resolve input HTML + output MP4.
let file, outMp4;
if (PAGE) {
  file = PAGE;
  outMp4 = OUT || PAGE.replace(/\.html$/i, ".mp4");
} else {
  // Backward-compatible default: bundled ev-brake-pedal example.
  file = THEME === "light" ? "ev-brake-pedal-video-light.html" : "ev-brake-pedal-video.html";
  outMp4 = THEME === "light" ? "ev-brake-pedal-video-light.mp4" : "ev-brake-pedal-video.mp4";
}
const url = "file:///" + resolve(file).replace(/\\/g, "/");
const profile = join(tmpdir(), `tech-video-chrome-profile-${THEME}-${PORT}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitPort() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(150);
  }
  throw new Error("Chrome DevTools port never came up");
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.method + " " + JSON.stringify(m.error))) : res(m.result);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const myId = ++id;
      pending.set(myId, { res, rej });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  return { ws, ready, send };
}

const main = async () => {
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${PORT}`,
      "--window-size=800,1100",
      "--user-data-dir=" + profile,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let ffmpeg = null;
  try {
    const ver = await waitPort();
    console.log("chrome:", ver.Browser);

    const created = await (
      await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })
    ).json();
    const tab = connect(created.webSocketDebuggerUrl);
    await tab.ready;
    await tab.send("Page.enable");
    await tab.send("Runtime.enable");
    await tab.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 1100, deviceScaleFactor: 1, mobile: false });

    for (let i = 0; i < 80; i++) {
      const r = await tab.send("Runtime.evaluate", {
        expression: "typeof window.__seek==='function' && document.querySelector('.ev-video')!==null",
        returnByValue: true,
      });
      if (r.result.value === true) break;
      await sleep(120);
    }

    const rectRes = await tab.send("Runtime.evaluate", {
      expression:
        "(()=>{const r=document.querySelector('.ev-video').getBoundingClientRect();return {x:r.x+window.scrollX,y:r.y+window.scrollY,w:r.width,h:r.height};})()",
      returnByValue: true,
    });
    const rect = rectRes.result.value;
    const clip = { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: SCALE };
    const outW = Math.round(rect.w * SCALE);
    const outH = Math.round(rect.h * SCALE);
    console.log(`clip ${Math.round(rect.w)}x${Math.round(rect.h)} -> ~${outW}x${outH}`);
    console.log(`out: ${outMp4}`);

    ffmpeg = spawn(
      FFMPEG,
      [
        "-y",
        "-f", "image2pipe",
        "-framerate", String(FPS),
        "-i", "-",
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v", "libx264",
        "-preset", "slow",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        outMp4,
      ],
      { stdio: ["pipe", "inherit", "inherit"] },
    );
    const feed = (buf) =>
      new Promise((res) => {
        if (ffmpeg.stdin.write(buf)) res();
        else ffmpeg.stdin.once("drain", res);
      });

    const frames = SECONDS > 0 ? Math.round(SECONDS * FPS) : Math.round(TOTAL * FPS);
    const t0 = Date.now();
    for (let i = 0; i < frames; i++) {
      const t = (i / FPS) % TOTAL;
      await tab.send("Runtime.evaluate", {
        expression: `__seek(${t.toFixed(4)}); new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(1))))`,
        awaitPromise: true,
      });
      const shot = await tab.send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: false });
      await feed(Buffer.from(shot.data, "base64"));
      if (i % 48 === 0 || i === frames - 1) {
        const pct = (((i + 1) / frames) * 100).toFixed(0);
        const eta = (((Date.now() - t0) / (i + 1)) * (frames - i - 1)) / 1000;
        process.stdout.write(`\rframe ${i + 1}/${frames} (${pct}%) eta ${eta.toFixed(0)}s   `);
      }
    }
    process.stdout.write("\n");
    ffmpeg.stdin.end();
    await new Promise((res, rej) => ffmpeg.on("exit", (c) => (c === 0 ? res() : rej(new Error("ffmpeg exit " + c)))));
    console.log("wrote", outMp4);
  } finally {
    chrome.kill();
  }
};

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
