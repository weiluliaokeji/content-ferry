# .cto-image-verify

独立 Electron 脚手架：**只跑 51CTO 图床**（getUploadSign → getUploadConfig → COS multipart POST），跳过整篇发布流程。用于快速定位图床为什么会失败回退到 base64 内联。

## 用法

```bash
cd D:/Workbench/ContentFerry

# 方式 A：环境变量传 cookie
COOKIE='你的 51CTO cookie 整段' ./node_modules/electron/dist/electron.exe .cto-image-verify/main.cjs

# 方式 B：命令行参数
./node_modules/electron/dist/electron.exe .cto-image-verify/main.cjs --cookie='你的 51CTO cookie 整段'
```

cookie 从 Chrome DevTools > Application > blog.51cto.com > Cookies 复制整段（包括 `acw_tc`、`UIA_TOKEN`、`51cto_v2_*` 等）。

## 输出

- `out/log.txt`：每一步 HTTP 状态、响应片段、最终失败原因或成功 URL
- `out/verify-upload.png`：上传文件本身

## 成功 vs 失败

成功 → `✓ 成功，URL = https://s2.51cto.com/...`

失败 → 日志精确指出是 getUploadSign / getUploadConfig / COS POST 哪一步、状态码、响应前 300 字、常见原因清单。

## 不变量

- 不修改生产代码；只 require `dist/main/main/fiftyone-cto/fiftyone-cto-image-uploader.js`（已编译产物）
- 复用真实 `FiftyoneCtoImageUploader.upload()`，不走 inliner
- `out/` 不进 git（见 `.gitignore`）