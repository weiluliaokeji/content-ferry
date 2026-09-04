/**
 * 51CTO 图床连通性验证脚手架 —— 独立 Electron app，跳过发布全流程，
 * 直接用真实 cookie 跑一次完整图片上传链路（getUploadSign → getUploadConfig → COS POST）。
 *
 * 用法：
 *   1) 在「账号」页确认已配置 51CTO cookie。
 *   2) 终端跑：
 *        cd D:/Workbench/ContentFerry
 *        ./node_modules/electron/dist/electron.exe .cto-image-verify/main.cjs
 *      或带显式 cookie（从 DevTools Application > Cookies 复制整段）：
 *        COOKIE='...粘贴...' ./node_modules/electron/dist/electron.exe .cto-image-verify/main.cjs
 *   3) 看 out/log.txt。
 *
 * 成功：拿到形如 https://s2.51cto.com/... 的远程 URL，并在 out/uploaded.png 写一份验证文件。
 * 失败：在日志里精确指出哪一步、什么响应 —— 把这段给开发即可。
 */
const path = require("path");
const fs = require("fs");

const ROOT = "D:/Workbench/ContentFerry";
const DIST_UPLOADER = path.join(ROOT, "dist/main/main/fiftyone-cto/fiftyone-cto-image-uploader.js");
const OUT_DIR = path.join(__dirname, "out");

fs.mkdirSync(OUT_DIR, { recursive: true });

const logLines = [];
const logFile = path.join(OUT_DIR, "log.txt");
function log(line) {
  logLines.push(line);
  process.stdout.write(line + "\n");
}

try {
  // 清空旧日志，避免误读。
  fs.writeFileSync(logFile, "", "utf8");
  const { FiftyoneCtoImageUploader } = require(DIST_UPLOADER);

  // 1) 决定 cookie 来源：CLI 参数 > 环境变量 > 退出提示。
  let cookie = "";
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--cookie=")) cookie = arg.slice("--cookie=".length).trim();
  }
  if (!cookie) cookie = (process.env.COOKIE || "").trim();

  if (!cookie) {
    log("✘ 缺少 cookie。两种提供方式：");
    log("   方式 A：COOKIE='...' ./node_modules/electron/dist/electron.exe .cto-image-verify/main.cjs");
    log("   方式 B：./node_modules/electron/dist/electron.exe .cto-image-verify/main.cjs --cookie='...'");
    log("提示：在 Chrome DevTools > Application > blog.51cto.com > Cookies 复制整段 cookie。");
    fs.writeFileSync(logFile, logLines.join("\n"), "utf8");
    process.exit(2);
  }

  log("== 51CTO 图床连通性验证 ==");
  log(`cookie 长度：${cookie.length} 字符`);
  log("");

  // 2) 准备一个 1x1 PNG buffer（最简单有效的测试上传文件）。
  // 这里直接复用主稿里那张截图的 buffer：读最近发布过的 channel_draft 的源文件。
  // 退一步：用占位 PNG。
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64"
  );
  const filename = "verify-upload.png";
  fs.writeFileSync(path.join(OUT_DIR, filename), png);

  // 3) 真实链路：直接调 uploader.upload，每次 fetch 在日志里打印 status。
  const fetcher = async function (urlArg, init) {
    const url = typeof urlArg === "string" ? urlArg : urlArg.url;
    const method = init?.method ?? "GET";
    log(`→ ${method} ${url}`);
    const t0 = Date.now();
    const resp = await globalThis.fetch(url, init);
    const elapsed = Date.now() - t0;
    log(`  ← ${resp.status} (${elapsed}ms)`);
    if (resp.status >= 400 || resp.status === 302) {
      const text = await resp.clone().text().catch(() => "");
      log(`  body(head): ${text.slice(0, 300)}`);
    }
    return resp;
  };

  const uploader = new FiftyoneCtoImageUploader(cookie, fetcher);

  (async () => {
    try {
      log("");
      log("-- 步骤 1: getUploadSign --");
      const t0 = Date.now();
      const url = await uploader.upload(png, "image/png", filename);
      log(`✓ 成功，URL = ${url}`);
      log(`总耗时 ${Date.now() - t0}ms`);
      log("");
      log("诊断结论：图床链路正常。复测发布文章，截图应不再是 base64 内联。");
    } catch (err) {
      log("");
      log("✘ 失败");
      log(`步骤：${err?.stack?.split("\n")[0] ?? "?"}`);
      log(`原因：${err?.message ?? String(err)}`);
      log("");
      log("常见原因（按概率从高到低）：");
      log("1) cookie 已过期：在 Chrome 重新登录 blog.51cto.com → 文渡账号页重新抓取。");
      log("2) 51CTO 后端接口调整（getUploadSign/getUploadConfig 路径、参数或响应结构）。");
      log("3) 网络层屏蔽了 blog.51cto.com 或 *.cos.ap-beijing.myqcloud.com。");
      log("4) COS 桶（51cto-edu-image-1253198479.cos.ap-beijing.myqcloud.com）权限或配额变更。");
      log("5) 文渡传的 Content-Type / 上传字段与 51CTO 期望不一致。");
      log("");
      log("将以上日志发给开发排查。");
    } finally {
      fs.writeFileSync(logFile, logLines.join("\n"), "utf8");
      log("");
      log(`日志写到 ${logFile}`);
      // 让 Electron 退出（无 GUI）。
      process.exit(0);
    }
  })();
} catch (err) {
  log(`✘ 启动失败：${err?.message ?? String(err)}`);
  log(err?.stack ?? "");
  fs.writeFileSync(logFile, logLines.join("\n"), "utf8");
  process.exit(1);
}