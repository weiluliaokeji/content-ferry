import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

/** A file sink for CSDN browser-assist diagnostics. The packaged app disables
 * devtools (Ctrl+Shift+I), so instead of relying on the console we persist the
 * full request/response detail to a stable file the user can open and paste
 * back to us. */

let diagnosticsPath: string | undefined;

function resolvePath(): string {
  if (diagnosticsPath) return diagnosticsPath;
  let base = process.cwd();
  try {
    if (typeof app.isReady === "function" && app.isReady()) {
      base = app.getPath("userData");
    } else {
      base = process.env.APPDATA || process.env.HOME || process.cwd();
    }
  } catch {
    base = process.cwd();
  }
  diagnosticsPath = path.join(base, "csdn-assist-diagnostics.log");
  return diagnosticsPath;
}

/** Absolute path of the diagnostics file, for showing the user where to look. */
export function csdnDiagnosticsPath(): string {
  return resolvePath();
}

/** Truncate the file at the start of a new assist run. */
export function resetCsdnDiagnostics(): void {
  try {
    fs.writeFileSync(resolvePath(), `=== CSDN 浏览器辅助诊断（${new Date().toISOString()}） ===\n`);
  } catch {
    /* best-effort */
  }
}

/** Append one line and also mirror it to stderr so `npm run dev` users see it. */
export function appendCsdnDiagnostics(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.error(`[contentferry] ${line}`);
  try {
    fs.appendFileSync(resolvePath(), `${stamped}\n`);
  } catch {
    /* best-effort */
  }
}
