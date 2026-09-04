// 51CTO 图床上传诊断：复用桌面端已登录 cookie，直接跑一次真实上传，打印每步 HTTP 状态。
// 运行：node_modules/electron/dist/electron.exe .cto-image-verify/diagnose.cjs
const path = require("path");
const { app, safeStorage } = require("electron");

function log(...a) { console.log("[diagnose]", ...a); }

log("app type =", typeof app, "safeStorage type =", typeof safeStorage);

app.whenReady().then(async () => {
  const Database = require("better-sqlite3");
  const UPLOADER = require(path.join(__dirname, "..", "dist", "main", "main", "fiftyone-cto", "fiftyone-cto-image-uploader.js"));
  const { FiftyoneCtoImageUploader } = UPLOADER;
  const DB_PATH = "D:/ToolsData/ContentFerry/contentferry.db";

  try {
    if (!safeStorage.isEncryptionAvailable()) {
      log("safeStorage 不可用，无法解密 cookie");
      app.exit(1);
      return;
    }
    const db = new Database(DB_PATH, { readonly: true });
    const cred = db.prepare(
      "SELECT secret_id FROM account_credentials WHERE credential_kind = 'fiftyone_cto_cookie'"
    ).get();
    if (!cred) {
      log("未找到 fiftyone_cto_cookie 凭证记录，请先在账号页配置 51CTO Cookie");
      app.exit(1);
      return;
    }
    const row = db.prepare("SELECT encrypted_value FROM credential_secrets WHERE id = ?").get(cred.secret_id);
    if (!row) {
      log("凭证 secret 不存在");
      app.exit(1);
      return;
    }
    const cookie = safeStorage.decryptString(Buffer.from(row.encrypted_value));
    log("解密 cookie 成功，长度 =", cookie.length);

    // 构造一张最小 PNG 做探针
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
      "base64"
    );
    const uploader = new FiftyoneCtoImageUploader(cookie, fetch);
    log("开始上传测试图（1x1 PNG, 67 字节）...");
    const url = await uploader.upload(png, "image/png", "diagnose-test.png");
    log("上传成功！URL =", url);
    app.exit(0);
  } catch (err) {
    log("上传失败：");
    if (err && err.stack) log(err.stack);
    else log(String(err));
    app.exit(2);
  }
});
