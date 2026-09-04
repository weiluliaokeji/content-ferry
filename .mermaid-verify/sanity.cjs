/**
 * Sanity harness: verify a *simple* red rectangle renders correctly through
 * the same capturePage path. If a plain HTML page with a colored rect produces
 * a non-blank PNG, the capture path is fine and mermaid-specific layout is
 * the suspect. If the rect is also blank, the issue is in the BrowserWindow /
 * capturePage plumbing itself.
 */
const { app, nativeImage } = require("electron");
const fs = require("fs");
const path = require("path");

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");

const ROOT = "D:/Workbench/ContentFerry";
const OUT = path.join(ROOT, ".mermaid-verify/out");
fs.mkdirSync(OUT, { recursive: true });

async function main() {
  await app.whenReady();
  console.log("=== sanity Electron " + process.versions.electron + " ===");

  const { BrowserWindow } = require("electron");
  const win = new BrowserWindow({
    show: true,
    x: -4096,
    y: -4096,
    width: 800,
    height: 600,
    skipTaskbar: true,
    focusable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.on("page-title-updated", (e) => e.preventDefault());

  // Load data URL with a CLEARLY-visible red rectangle.
  const html = "<!doctype html><html><body style=\"margin:0;background:#ffffff\"><div style=\"width:600px;height:400px;background:#ff0000\"></div></body></html>";
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 800));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 800, height: 600 });
  const png = img.toPNG();
  fs.writeFileSync(path.join(OUT, "sanity-red.png"), png);
  console.log("captured " + img.getSize().width + "x" + img.getSize().height + " bytes=" + png.length);

  const bmp = img.toBitmap();
  let nonWhite = 0;
  for (let i = 0; i < bmp.length; i += 4) {
    const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2];
    if (r < 250 || g < 250 || b < 250) nonWhite++;
  }
  console.log("non-white pixels: " + nonWhite + " / " + (800 * 600));
  console.log((nonWhite > 1000 ? "[OK]   red rect rendered" : "[BLANK] capturePage still returns empty even for plain HTML!"));
  win.destroy();
  app.quit();
}

main().catch((e) => { console.error(e); app.quit(1); });
