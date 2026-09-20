# Step 8–11：构建 HTML / 定制文案 / 逐帧渲染 / ffmpeg 合成

> 对应 SKILL.md 步骤索引 8–11。Windows/代理/精简 shim 环境坑统一见 `references/06-troubleshooting.md`，本文件只引用不重复。

## Step 8：构建渲染源 HTML

基于 `templates/composition.html` 构建 `composition/index.html`。**分段驱动，禁止硬编码时间**：

1. 确保 `segments.json` 已生成（见 `references/02-tts-audio.md` Step 5）
2. `fill_template.py` 填时间/字幕占位符：
   ```bash
   python scripts/fill_template.py segments.json templates/composition.html composition/index.html
   ```
3. 自动替换 `{{SCENE_N_START}}` / `{{SCENE_N_DURATION}}` / `{{MAIN_DURATION}}` 等，并更新 `<section>` 的 `data-start` / `data-duration`

**核心 DOM 结构**（模板预置占位符）：
```html
<div id="stage">
  <section id="scene-01" class="clip" data-start="{{SCENE_1_START}}" data-duration="{{SCENE_1_DURATION}}">
    <div class="bg-img"><img src="assets/img/cover.png" data-gsap-bg="1"></div>
    <div class="bg-veil"></div><div class="bg-grid"></div><div class="chrome">...</div>
    <div class="scene-inner">
      <h2 class="section-title" data-gsap="t1Title">标题</h2>
      <!-- 场景内容 -->
    </div>
  </section>
  <audio id="narration" src="assets/audio/narration.mp3" data-start="0" data-duration="{{MAIN_DURATION}}"></audio>
</div>
```

**字幕系统（粒度 + 防重叠）**：
- 每场景最多 1 条字幕，保持单行（≤28 汉字/全角，超长精简口播或拆场景，禁止换行堆叠）
- 时间戳来自 `segments.json`；GSAP tween 控 `opacity: 0→1→0`
- **字幕永远贴底**（`bottom: var(--caption-bottom)`=100px），禁止改中间悬浮
- **防重叠由 CSS 变量硬性兜底**（已内嵌模板，勿删）：`--caption-safe: 230px`（bottom 100 + 两行字幕约 86 + 间隙约 44）；`.scene-inner { max-height: calc(1920px - var(--safe-top) - var(--caption-safe)); overflow: hidden; }` 超出被裁，物理上不重叠。放宽内容高度须同步调大 `--caption-safe` 并复测

**场景内容密度上限**（超出被裁，须遵守）：`.steps` ≤4 条且单条 desc ≤12 字；`.tag-row` ≤6；`.warn-bar` 单行 ≤40 字；`.matrix` ≤4 行。超限先精简/拆场景，禁止放宽 CSS。

**场景显隐**：`section.clip` 初始 `opacity:0`；GSAP 进场 `autoAlpha:1`、离场 `autoAlpha:0`。**关键**：timeline seek 时若 tween 未触发，`from` 初始态不应用，须在 JS 初始化 `tl.set(".clip", {autoAlpha: 0})` 强制预置隐藏。

## Step 9：定制场景文案（customize.py，已幂等）

`fill_template.py` 只填时间/字幕占位符，**不替换演示文案**。模板自带标题/内容区是占位符，只跑它不跑本步会显示"主标题 高亮词"等占位文字。

**做法**：复制 `templates/customize.py` 到 `composition/`，改 `SCENES` / `CHROME` 两字典，运行 `python customize.py`。脚本按 section id 精确替换三类内容并断言成功（`n==1`）：
1. `<h2 class="section-title">` 内文（`<em>` 渲染绿色高亮）
2. `</h2>` 后注释块 → 真实内容，四类结构（密度上限为硬约束）：`.steps` / `.tag-row` / `.warn-bar` / `.matrix`
3. chrome 的 `.label`（GUIDE/NOTICE/PICK 01/MATRIX/TAKEAWAY）

**幂等说明**：`customize.py` 现于首次运行时备份 `index.html` 为 `index.html.orig`；后续重跑自动从 `.orig` 重建再应用 `SCENES`，**不再需要先手动 `fill_template.py`**。改图/改文案直接重跑即可。

**渲染前校验（务必执行）**：
```bash
grep -nE '主标题 <em>高亮词</em>|观点 [0-9] <em>高亮</em>|选型 <em>矩阵</em>|总结 <em>高亮</em>' composition/index.html  # 不应命中
grep -c '<!-- 场景内容 -->' composition/index.html   # 应为 0
grep -c '<!-- matrix 示例' composition/index.html     # 应为 0
```

**渲染前快速目检（强烈推荐）**：`snapshot_frames.py` 在每场景中段截图（避免全量渲染 5 分钟后才发现文案问题）：
```bash
python3 scripts/snapshot_frames.py composition/index.html _snap 3,26,70,92
```

**防重叠专项抽查（必做，逐条核对）**：
1. 对含密集内容的场景取**内容最密的中间时刻**截图
2. 核对字幕贴底无同区文字；内容未被裁切（末条不缺字）
3. `.scene-inner` 计算高度 `getBoundingClientRect().height` ≤ 1540px（改过 CSS 变量按新值）
4. 任一项不符→精简文案回 Step 9 重来，禁止放宽 CSS
5. **截图复用核对（实操/产品类必做）**：相关场景中间区域应出现 `.screenshot`/`.ss-compare`/`.ss-stack`；整屏仍是 AI 抽象背景、无截图元素 → 回 Step 7 补真实截图，禁止渲染交付

## Step 10：逐帧渲染（Edge CDP，render_frames.py）

**启动干净 Edge CDP**（命令行必须含 `--disable-extensions`，否则插件悬浮窗混入成片）：
```bash
# Windows（可常驻方式：Bash run_in_background 直接 msedge.exe，避免会话结束被回收）
msedge.exe --headless --disable-extensions --disable-background-networking --disable-sync --remote-debugging-port=19222 about:blank
# macOS
/Applications/Microsoft\ Edge.app/Contents/MacOS/Microsoft\ Edge --headless --disable-extensions --disable-background-networking --disable-sync --remote-debugging-port=19222 about:blank
```
启动后 `curl --noproxy 127.0.0.1 http://127.0.0.1:19222/json` 应无 `extension://` / `background_page` target。

**端口清理（续渲不杀）**：`render_frames.py` 连外部拉起的 CDP 实例，杀它自己就断连。启动先 `GET /json`——有可用 page target 直接复用不杀；仅端口占但 CDP 无响应（残留崩溃）才按 PID `taskkill /F /PID <pid>`，绝不 `taskkill /F /IM msedge.exe` 全杀。手动清理前先 `curl --noproxy 127.0.0.1` 确认无响应再按 PID 精确 kill。

**脚本用法**（路径用 Windows 原生 `D:/...`，跑前 `unset HTTP_PROXY`；详见 `references/06-troubleshooting.md`）：
```bash
python3 scripts/render_frames.py <index.html_path> <frames_dir> <fps> [start_frame] [duration_seconds]
```
- 省略 `duration_seconds`：优先从 `index.html` 上级目录找 `segments.json`，再同级，读 `total_duration`；都没有回退默认 98.9
- 行为：viewport 1080×1920；导航 `file://`；轮询 `readyState==complete` + `fonts.status==loaded` + 图片 `complete`；timeline seek 到 `frame/total`；每帧 `captureScreenshot(jpeg,q88)`；支持断点续传（已存在帧跳过）；总帧数 `round(duration*fps)`；单次 CDP 30s 超时；截图失败重试 3 次后停并打印续跑命令（不跳帧）。帧命名 `frame_%05d.jpg`

## Step 11：ffmpeg 合成 MP4

```bash
ffmpeg -y -framerate 25 -i frames/frame_%05d.jpg -i assets/audio/narration.mp3 \
  -c:v libx264 -crf 20 -preset medium -pix_fmt yuv420p \
  -c:a aac -b:a 192k -shortest -movflags +faststart \
  output.mp4
```
**调速合成**（owner 要求一律 1.3x）：`[0:v]setpts=PTS/1.3[v];[1:a]atempo=1.3[a]` 后 `-map [v] -map [a]`。

校验：`ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_name,width,height,r_frame_rate output.mp4` → `duration`≈配音时长、`1080x1920`、`h264+aac`。
