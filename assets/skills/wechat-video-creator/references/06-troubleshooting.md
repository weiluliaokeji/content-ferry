# 常见问题与排错（含本机/沙箱环境特有坑）

> 本文件是环境坑的**唯一来源**，SKILL.md 与其余 references 只引用不重复。坑均在「带 `HTTP_PROXY` 的沙箱/CI + Windows Python + MSYS2 精简 shim」组合下逐一实测。

## 本机/沙箱环境特有坑（按出现频率）

1. **代理导致 CDP 端口返回 502（最常见，伪占用）**
   - 现象：`curl`/`urllib` 访问 `http://127.0.0.1:19222/json` 返回 `502 Bad Gateway`，但端口实际空闲、无进程占用
   - 根因：环境设了 `HTTP_PROXY`/`HTTPS_PROXY`，localhost 请求也发往代理 → 假 502；直连实际 `200 OK`
   - 修复：渲染前 `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy`；探测用 `curl --noproxy 127.0.0.1 ...`；脚本内部 `urllib` 同样受代理影响，必须 unset

2. **Windows 路径陷阱：`/d/...` 被解析成 `D:\d\...`**
   - 现象：渲染报 DONE 但 `frames/` 空，帧落在 `D:\d\Workbench\...\frames\`（d: 盘根多截 `d`）
   - 根因：Git Bash 给 Windows Python 传 `/d/Workbench/...`，`os.path.abspath()` 不解 Git Bash 路径 → 当相对 d: 盘根
   - 修复：`<index.html_path>` 与 `<frames_dir>` **必须用 Windows 原生路径**（`D:/...` 或 `D:\...`）；已落错用 `shutil.move`（同盘 rename 秒级）归位并清畸形 `D:\d` 树

3. **ffmpeg 勿接 `tail`/`head`（broken pipe 失败）**
   - 现象：`ffmpeg ... 2>&1 | tail -20` 后台失败，报 `tail: command not found` 或 broken pipe
   - 根因：精简 shim 无 `tail`/`head`（`ls`/`find`/`head`/`tail` 可能缺失），管道另一端缺失 → 提前退出
   - 修复：合成**不接 tail/head 管道**，用 `ffmpeg -nostats ...` 直接落盘；看进度就 `> render.log 2>&1`

4. **CDP 健康探测的 Host 头**
   - 现象：裸 socket 发 `GET /json` 返回 `500: Host header is specified and is not an IP address or localhost`
   - 根因：CDP 要求 Host 为 `127.0.0.1:19222` 或 `localhost`；用 `Host: x` 被拒（正常 `curl`/`urllib` 自动带正确 Host，不受影响）
   - 修复：裸 socket 探测用正确 Host 头；脚本内部不受影响

5. **Edge 守护进程需常驻（避免渲染中断连）**
   - 现象：`powershell Start-Process msedge ...` 拉起后渲染一启动 CDP 连不上，或 `DevTools listening` 后又消失
   - 根因：某些 shell 会话命令返回后回收子进程树，Edge 随会话被杀，端口关闭
   - 修复：可常驻方式启动——Bash `run_in_background` 直接 `msedge.exe --headless ... --remote-debugging-port=19222 about:blank`，让渲染期间持续存活；或独立终端 `start` 后保持窗口

6. **GSAP 库缺失导致 page not ready 超时退出**
   - 现象：`render_frames.py` 在 ready 检查循环超时后输出 `FATAL: page not ready` 并退出，不渲染任何帧
   - 根因：`composition/assets/vendor/gsap.min.js` **不存在**（技能包不内置该文件）。HTML `<script src="assets/vendor/gsap.min.js">` 加载失败 → `gsap is not defined` → JS 在 timeline 构造前抛错 → `window.__timelines` 永不赋值。`render_frames.py` 的 `is_ready` 检查含 `!!window.__timelines && !!window.__timelines.main`，短路返回 `false`，循环 30s 超时退出
   - 诊断：`fill_template.py` 后跑 `Test-Path composition/assets/vendor/gsap.min.js`，为 `False` 即确认
   - 修复：**渲染前必检 vendor 目录**——`Test-Path "composition/assets/vendor/gsap.min.js"`；缺失则从 CDN 补：`Invoke-WebRequest "https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js" -OutFile "composition/assets/vendor/gsap.min.js"`。技能包不内置该文件（体积 ~70KB，避免仓库膨胀），由用户首次构建 `composition/` 后手动下载

7. **evaluate 返回 GSAP timeline 对象导致序列化卡死**
   - 现象：vendor 已补、timeline 存在，但渲染脚本在第一次调用 `window.__timelines.main.time(t)` 后**永久挂起**，CPU≈0
   - 根因：GSAP 的 `timeline.time(t)` / `timeline.progress(p)` 返回 **timeline 对象本身**（非 number），对象含循环引用（`_timeline`/`_parent`/`_prev`/`_next`）。playwright 的 `page.evaluate` 默认序列化返回值，递归遍历循环引用卡死。CDP 路径默认 `returnByValue: false`（返回 remote object reference，不受影响），但若传 `returnByValue: True` 或用 playwright 驱动则触发
   - 修复：所有 `window.__timelines.main.time(t)` / `.progress(p)` 的 evaluate 调用**包裹成 IIFE 返回标量**：
     ```python
     # CDP（render_frames.py / snapshot_frames.py）
     {"expression": "(() => { window.__timelines.main.pause().time(%f); return 0; })()" % t}
     # playwright（若用 page.evaluate）
     await page.evaluate("(() => { window.__timelines.main.time(%f); return 0; })()" % t)
     ```
     原写法 `"window.__timelines.main.pause().time(%f)"` 已废弃

## 通用排错

### CDP 连接失败
- 检查 Edge 无头运行：`curl --noproxy 127.0.0.1 http://127.0.0.1:19222/json`（有 `HTTP_PROXY` 必须 `--noproxy`，否则假 502）
- 不通则在 Windows 启动：`start msedge --headless --remote-debugging-port=19222`

### 字幕与场景内容重叠（历史高频）
- **根因 1（内容超高）**：超 `.scene-inner` 上限被裁或侵入字幕区。模板内置 `--caption-safe` + `max-height` + `overflow:hidden` 硬性兜底，物理上无法重叠；仍看到重叠先确认用最新模板（含 `--caption-safe`），旧 HTML 直接重 `fill_template.py`，**别手改旧 HTML 的 CSS**
- **根因 2（字幕改位）**：`--safe-bottom: 280px` 已删，字幕只允许 `--caption-bottom:100px` 贴底；被改中间悬浮会与内容重叠——恢复贴底
- **根因 3（内容超限）**：steps>4 / desc>12 字 / matrix>4 行时即使不重叠也被裁缺字——精简口播或拆场景，别放宽 CSS
- **根因 4（缓存旧模板）**：渲染前杀旧 CDP 实例并以 `--disable-extensions --remote-debugging-port=19222` 重启干净实例，否则浏览器缓存旧 HTML 出幽灵重叠

### 画面叠加/提前可见
- 根因：GSAP `from` 初始态只在 tween 触发时应用，timeline seek 跳过触发点则场景不自动隐藏
- 修复：JS 初始化执行 `tl.set(".clip", {autoAlpha: 0})` 强制初始隐藏

### 配音尾部被截断或含平台声明
- faster-whisper 转写取最后一句结束时间；ffmpeg `-t <end_time>` 裁切（`ffmpeg -i input.mp3 -t 95.2 -acodec copy output.mp3`）；裁后再次 whisper 确认完整

### HTML 结构导致元素被截断
- CDP `Runtime.evaluate` + `getBoundingClientRect()` 查 DOM 实际位置尺寸；常见缺闭合 `</div>` 致 flex/grid 错嵌套
- DevTools 查 Computed Styles 确认 `height`/`display`/`grid-template-columns`

### 字体安装
- Inter/JetBrains Mono 优先本机安装；缺失自动回退系统默认字体，不影响渲染
