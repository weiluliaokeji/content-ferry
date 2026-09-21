---
name: wechat-video-creator
description: >
  为微信公众号视频号制作 1080×1920 竖屏短视频（9:16）的完整工作流技能。
  输入：一篇博客/长文（.md/.txt）或文章目录；产出：逐帧渲染合成的 MP4（含克隆人声配音、AI 场景配图、逐句字幕）、封面图与发布物料（视频号发布物料.md）。
  覆盖 读文→脚本→复核→TTS 克隆→whisper 分段→调速→生图/复用真实截图→HTML→CDP 逐帧→ffmpeg→封面 CTA 全链路。
  触发：用户提到"做视频号/竖屏/9:16 视频""根据文章做视频""克隆声音/AI 配音"，或给出博客路径要求制视频。
version: "1.0.0"
---

# wechat-video-creator

为微信视频号制作 1080×1920 竖屏短视频（9:16）。完整链路约 15–20 分钟。

> 详细步骤、踩坑实录、排错均拆到 `references/`，本文件只保留规格真值表、依赖、步骤索引与渲染前检查清单，避免每次触发全量加载。

## 视频规格（唯一真值表）

| 参数 | 值 |
|------|-----|
| 分辨率 / 宽高比 | 1080×1920 / 9:16 |
| 帧率 | 25fps |
| 主配音原始时长 | **78–168s**（经验参考区间；字数以下方门禁为准，实际时长以 whisper 实测为准）|
| 调速（owner 硬性）| **一律 1.3x**；安全区间 1.2–1.7x；**1.0x = 缺陷，禁止交付**；仅主配音 <78s 且提速后 <60s 才扩充脚本（不保留 1.0x）。由 `audio_post_process.py --speed` **默认 1.3 强制执行**（旧实现按「向区间中点靠拢」自动算倍率，会产出 <1.0x 的减速片，已修）|
| 含 CTA 总时长 | **67–136s**（CTA 实际时长以 `cta_tail.mp3` 的 `ffprobe` 为准，约 6.77s）|
| 视频编码 | H.264 (libx264, -crf 20, -pix_fmt yuv420p) |
| 音频编码 | AAC (192k) |
| 字幕 | 每场景 ≤1 条、单行 ≤28 字（防重叠）；贴底 `--caption-bottom:100px` |
| 发布短标题符号 | **仅支持 `《》“”：+？%℃`**；逗号/顿号/破折号/括号等一律不可用，**逗号用空格代替**（细则见 `references/05-cover-cta.md`；不约束封面图文字）|
| 渲染 | Edge/Chromium CDP `127.0.0.1:19222`（启动必须 `--disable-extensions`）|

**口播字数门禁（唯一定义，Step 2 与 Step 3 共用，不在别处重复；与上方时长区间冲突时以本门禁为准）**：
- ≤300 字：绿灯，进配音
- 301–400 字：黄灯，建议精简到 ≤300（不阻断）
- >400 字：红灯阻断，禁止进配音
- 统计口径：仅口播正文（`文案：` 后），排除字幕/画面/markdown。300 字 ≈ 90–105s 原始配音，是 1.2–1.7x 安全甜点。

## 产物目录契约（唯一真值表）

> 所有智能体必须产出**完全一致**的目录结构与命名。以本表为唯一规范，参考样本 `.../你从IDE切到ADE了吗？.../assets/video-assets/` 即此结构。差异只能源于本表允许的 `-vN` 重渲染版本，不允许任何自由发挥。

`<article_dir>/assets/video-assets/` 下：

```
video-assets/
├── 视频号发布物料.md          # 发布物料：唯一位置在 video-assets/ 根
├── 封面.png                  # 最终封面（cover_overlay.py 输出，唯一命名；与发布物料同目录）
├── output.mp4                # 最终视频（最新一版；与发布物料同目录）
├── output-v2.mp4 …           # 重渲染版本（禁止覆盖，用 -vN 递增；同样在 video-assets/ 根）
└── composition/              # 渲染工程根目录（仅放工程源与中间产物，不放最终交付文件）
    ├── index.html            # 渲染源（fill_template.py 产物）
    ├── index.html.orig       # customize.py 首跑备份（幂等重建用，可无）
    ├── SCRIPT.md             # 口播脚本 + 分镜
    ├── _tts.txt              # TTS 原始口播文本
    ├── segments.json         # whisper 分段（所有时间参数唯一真值来源）
    ├── customize.py          # 场景文案定制脚本（仅此一个脚本允许复制到 composition/，幂等）
    ├── render.log            # 渲染日志
    ├── assets/
    │   ├── img/
    │   │   ├── cover.png     # 封面背景源图（AI 生成、未叠加文字；cover_overlay.py 的输入）
    │   │   ├── scene-01.png …# 场景配图（零填充两位编号）
    │   │   └── screens/      # 文章真实截图（实操/产品类必放）
    │   ├── audio/
    │   │   ├── narration.mp3     # 完整配音 = 调速后主配音 + CTA（ffmpeg 音轨输入）
    │   │   ├── narration_raw.mp3 # 调速前原始主配音（audio_post_process.py 入参）
    │   │   ├── narration_v2.mp3  # 仅当省略 --output 时出现（实际名 `<入参stem>_v2.mp3`，如 narration_raw_v2.mp3）；此时 ffmpeg 须改用此文件。显式 --output narration.mp3 时会被脚本回写为 narration.mp3（含 CTA），无需此文件
    │   │   ├── cta_tail.mp3      # CTA 片尾：渲染前须从技能包 assets/audio/cta_tail.mp3 复制到位
    │   │   └── *.log             # speed_adjustment.log / key_rotation.log（跟随音频目录，非 CWD）
    │   └── vendor/
    │       └── gsap.min.js   # 必须存在（渲染前 vendor 必检）
    ├── frames/               # 逐帧中间产物 frame_%05d.jpg（ffmpeg 后可选清理）
    └── _snap/                # 渲染前目检截图 snap_%05.1fs.jpg
```

**禁止出现在产物中的内容（硬性）**：

- 任何浏览器 profile 目录：`.edge-profile*`、`Edge`/`Chromium` `User Data` 等——**绝不可**出现在 `composition/` 或 `video-assets/` 下（来源与规避见 Step 10）。
- 技能脚本副本：`render_frames*.py`、`snapshot*.py`、`fill_template.py` 等 `scripts/` 下脚本**禁止复制进** `composition/`。一律从技能 `scripts/` 目录调用，把 article 路径作为参数传入。
- 封面临时/变体命名：`封面_v1.png`、`封面_v1_旧版.png`、`封面_final.png`、`cover.png`、`cover_final.png` 等。最终封面**唯一定为 `video-assets/封面.png`**（与 `视频号发布物料.md` 同目录）；源背景**唯一定为 `composition/assets/img/cover.png`**（AI 生成、未叠字，是 `cover_overlay.py` 的输入，留在工程目录）。
- 最终视频不得留在 `composition/` 内：必须输出到 `video-assets/output.mp4`（与 `视频号发布物料.md` 同目录）；重渲染版本 `output-vN.mp4` 同样在 `video-assets/` 根，禁止用 `composition/output.mp4` 之类路径。
- `视频号发布物料.md` 出现在 `composition/` 内或 article 其它位置——唯一位置是 `video-assets/` 根。

**产物合规自检（渲染前 / 交付前各跑一次）**：

```bash
# 在 video-assets/ 执行（与 视频号发布物料.md 同目录），期望全部无输出
ls composition/ | grep -E '\.edge-profile|render_frames_|snapshot_'   # 期望：无
ls composition/ | grep -E '封面'                                       # 期望：无（最终封面在 video-assets/ 根）
ls | grep -E '封面.*(v[0-9]|_旧版|final)|^cover'                       # 期望：无（仅 封面.png）
test -f 封面.png && echo OK_COVER
test -f output.mp4 && echo OK_VIDEO
test -f composition/assets/vendor/gsap.min.js && echo OK_VENDOR
test -f 视频号发布物料.md && echo OK_MATERIAL
test -f composition/assets/audio/cta_tail.mp3 && echo OK_CTA   # 关闭片尾 CTA 时可不检
```

**脚本调用约定（防止 CWD 漂移，硬性）**

所有脚本**一律在 `<article_dir>/assets/video-assets/` 目录执行**，路径参数显式写成 `composition/...`。**禁止依赖脚本的 CWD 相对默认值**——旧版 `--log` 默认 `audio/speed_adjustment.log`、`key_rotation.log` 写死 `audio/`，在不同目录起跑会把日志散到 `video-assets/audio/` 或 `composition/audio/`，这是产物结构不一致的根源之一（两处默认值已改为跟随音频文件所在目录，但仍应显式传参）。

| 脚本 | 调用（CWD = `video-assets/`） |
|---|---|
| `inworld_tts.py` | `python3 <skill>/scripts/inworld_tts.py --text-file composition/_tts.txt --output composition/assets/audio/narration_raw.mp3`（`--text` / `--text-file` **二选一必填**，`--output` 必填）。**长中文口播一律用 `--text-file`**：`--text "$(cat ...)"` 是 bash 语法，PowerShell 下失效，且引号/换行转义必炸。首次克隆用 `voice_manager.py` 落 `voiceId` |
| `segment_processor.py` | `python3 <skill>/scripts/segment_processor.py composition/SCRIPT.md composition/assets/audio/narration_raw.mp3 --output composition/segments.json` |
| `audio_post_process.py` | `python3 <skill>/scripts/audio_post_process.py composition/assets/audio/narration_raw.mp3 --output composition/assets/audio/narration.mp3 --segments composition/segments.json --log composition/assets/audio/speed_adjustment.log` |
| `fill_template.py` | `python3 <skill>/scripts/fill_template.py composition/segments.json <skill>/templates/composition.html composition/index.html` |
| `render_frames.py` | `python3 <skill>/scripts/render_frames.py "D:/…/composition/index.html" "D:/…/composition/frames" 25`（**必须 Windows 原生绝对路径** `D:/…`，见坑 2） |
| `snapshot_frames.py` | `python3 <skill>/scripts/snapshot_frames.py composition/index.html composition/_snap 3,26,70,92` |
| `cover_overlay.py` | `python3 <skill>/scripts/cover_overlay.py --bg composition/assets/img/cover.png --output 封面.png --title … --subtitle … --brand …` |
| `batch_tts.py`（可选，分段合成替代路径） | `python3 <skill>/scripts/batch_tts.py composition/SCRIPT.md composition/assets/audio composition/assets/audio/narration_raw.mp3`。分段中间件 `seg_*.mp3` 拼接成功后自动清理（失败时保留供诊断，事后须手动清理）；`.concat.txt` 临时文件无论成败都会删除 |

## 依赖与环境

- **运行时**：Python 3.11+；`pip install websockets`；ffmpeg（PATH 中，libx264/aac）；faster-whisper；Edge/Chromium 无头（CDP）。
- **Inworld TTS**：API key + `voiceId` 持久化于本地 `config/voice_cache.json`（**非环境变量**）；仓库只提供 `config/voice_cache.example.json`，真实文件由使用者在本地创建，不能随技能迁移或提交。克隆只需一次，永久复用；多 key 数组轮询，失败不降级其他 TTS。
- **文生图**：`cover-image-gen`（仅纯文生图，支持 ModelScope Qwen-Image 与 Agnes 两套 provider；不支持图生图/编辑/超分/扩图/局部重绘，相关场景改为复用文章真实截图或纯色/渐变背景，不要假装支持）。
- **CTA 配置 `config/cta_config.json`**（由 `fill_template.py` 读取并注入 `index.html`）：
  - **已接线**：`display_text.main` / `display_text.sub`（片尾画面主副文案）、`subtitle`（片尾字幕）、`duration_seconds`（`segments.json` 缺 `cta_duration` 时的默认值）、`enabled: false`（强制关闭片尾，`cta_duration` 归 0）。缺失或解析失败时回落到内置默认文案，不报错。
  - **未接线**：`style.*` 与 `audio_template_path` 当前不被任何脚本读取，改它们**不会**影响成片；样式需改 `templates/composition.html`。
- **换公众号必须同时改两处**：`cta_tail.mp3`（声音）+ `cta_config.json` 的 `display_text` / `subtitle`（画面）。只换音频会出现「声音是新的、画面还写着旧号名」。
- **文章目录**：文档中的 `D:\Workbench\weiluliaokejiBlogs\docs\posts\...` 只是示例，实际执行必须传入文章目录的绝对路径；产物默认写入 `<article_dir>/assets/video-assets/`。
- **CTA 音频（两个位置，禁止混用）**：
  - **技能自带模板**：技能包内 `assets/audio/cta_tail.mp3`（针对微信公众号“围炉聊科技”；换号需替换同名文件并重跑 `ffprobe` 确认时长）。`audio_post_process.py` 拼接主配音+CTA 时读的是这一个（按 `SKILL_ROOT` 解析）。
  - **文章运行时副本**：**必须**在渲染前复制到 `composition/assets/audio/cta_tail.mp3`。HTML 模板以 `<audio src="assets/audio/cta_tail.mp3">` 加载它，缺文件则 CTA 段无声音。**该复制没有脚本代劳**（拼接脚本只读取技能自带模板、不会往文章里写），需手动复制一次。
- **环境预检（渲染前确认）**：`where msedge` / `where ffmpeg` / `python -c "import websockets"` 均可用；`ffprobe -v error -show_entries format=duration composition/assets/audio/cta_tail.mp3` 读 CTA 实际时长。

## 工作流（步骤索引）

源文章用 `<article_dir>` 指代（如 `D:\Workbench\weiluliaokejiBlogs\docs\posts\{标题}`），产物落 `<article_dir>/assets/video-assets/`。各步明细见 `references/`：

0. **初始化产物目录（必做，建骨架）**：开跑前一次性建好，之后各步只往既有目录里放文件，禁止临时自建新目录名
   ```bash
   # 在 <article_dir> 执行
   mkdir -p assets/video-assets/composition/assets/img/screens \
            assets/video-assets/composition/assets/audio \
            assets/video-assets/composition/assets/vendor \
            assets/video-assets/composition/frames \
            assets/video-assets/composition/_snap
   ```
   **同一步补齐 GSAP vendor（必做，见坑 6）**：技能包不内置 `gsap.min.js`，缺它渲染必在 ready 检查超时退出。建完骨架立即检查并补齐，不要等到 Step 10 才发现：
   ```bash
   # 在 <article_dir>/assets/video-assets 执行
   test -f composition/assets/vendor/gsap.min.js || \
     curl -sL -o composition/assets/vendor/gsap.min.js \
       https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js
   ```
   下载失败（离线/代理）时**停止并告知用户手动放置**，不要用改模板或删 `is_ready` 检查的方式绕过。
1. **读取源文章** → 提炼 3–5 核心论点 [`references/01-article-script.md`]
2. **撰写口播脚本 + 分镜**（钩子优先）[同上]
3. **脚本复核**（原文比对：数据/术语/结论/逻辑；`references/01-article-script.md` 中称 **Step 2.5 质量门**，同一件事）[同上]
4. **克隆配音**（口播正文先落 `composition/_tts.txt`，再 Inworld TTS 复用 `voiceId`）[`references/02-tts-audio.md`]
5. **分段处理 + stutter 检测**（faster-whisper → `segments.json`）[同上]
6. **生成场景素材图**（`cover-image-gen`，仅纯文生图；不支持图生图/编辑/超分/扩图）[`references/03-images-screenshots.md`]
7. **复用文章真实截图**（实操/产品/教程类必做）[同上]
8. **构建渲染源 HTML**（`fill_template.py` 填时间/字幕）[`references/04-html-render-ffmpeg.md`]
9. **定制场景文案**（`customize.py`，**已幂等**，改文案直接重跑；但改了配音/分段并重跑 Step 8 后**必须加 `--rebase`**，否则新时间戳被静默丢弃）[同上]
10. **逐帧渲染**（Edge CDP `render_frames.py`）[同上]
11. **ffmpeg 合成 MP4**[同上]
12. **封面 + 发布物料 + CTA**（`cover_overlay.py` / `cta_config.json`）[`references/05-cover-cta.md`]

## 渲染前检查清单（必做）

- [ ] 占位符已替换：`grep -nE '主标题 <em>高亮词</em>|观点 [0-9] <em>高亮</em>|选型 <em>矩阵</em>|总结 <em>高亮</em>' composition/index.html` 不应命中
- [ ] `grep -c '<!-- 场景内容 -->' composition/index.html` = 0；`grep -c '<!-- matrix 示例' composition/index.html` = 0
- [ ] 实操/产品类文章：相关场景含 `.screenshot` / `.ss-compare` / `.ss-stack`（真实截图已复用，非全 AI 抽象图）
- [ ] `snapshot_frames.py` 在每场景中段截图，核对字幕贴底、内容未裁切（`.scene-inner` 计算高度 ≤ 1540px）
- [ ] `unset HTTP_PROXY`（沙箱代理会假 502）；路径用 Windows 原生 `D:/...` 非 `/d/...`；ffmpeg 不接 `tail`/`head` 管道
- [ ] **vendor 目录必检**：Step 0 已自动下载 `composition/assets/vendor/gsap.min.js`，此处**复核存在**（`is_ready` 检查含 `!!window.__timelines.main`，gsap 加载失败时短路为 false）（详见 `references/06-troubleshooting.md` 坑 6）
- [ ] **evaluate 返回值须为标量（新增）**：所有 `window.__timelines.main.time(t)` / `.progress(p)` 调用须包 IIFE 返回 number（`(() => { ...; return 0; })()`），否则 playwright 序列化 GSAP timeline 对象（含循环引用）会递归卡死；CDP 路径虽默认 `returnByValue: false` 不受影响，但 IIFE 仍是最佳实践（详见坑 7）
- [ ] **CTA 配音已落位**：`composition/assets/audio/cta_tail.mp3` 存在——缺失则 CTA 段无声音。从技能包 `assets/audio/cta_tail.mp3` 复制（该复制无脚本代劳，须手动做一次）；`cta_config.json` 关闭片尾时可跳过
- [ ] **产物目录合规（见「产物目录契约」）**：`composition/` 下无 `.edge-profile*`、无 `render_frames_*` / `snapshot_*` 脚本副本、无 `封面*.png`；最终 `封面.png` 与 `output.mp4`（及 `output-vN.mp4`）在 `video-assets/` 根、与 `视频号发布物料.md` 同目录；`视频号发布物料.md` 在 `video-assets/` 根。任一不符即未达统一规范，交付前必须整改

## 排错

高频问题与 Windows/代理/精简 shim 实测坑（代理 502、`/d/` 路径、ffmpeg 无 tail、CDP Host 头、Edge 守护常驻、字幕重叠、GSAP 预置隐藏、**vendor 缺失假死、evaluate 返回 timeline 卡死**）见 [`references/06-troubleshooting.md`]。

## Bundled Resources

- `scripts/`：`render_frames.py`（CDP 逐帧）、`segment_processor.py`（分段+stutter）、`snapshot_frames.py`（渲染前目检）、`fill_template.py`（占位符填充）、`audio_post_process.py`（时长检测+atempo）、`inworld_tts.py`（TTS 合成）、`voice_manager.py`（配置读写）、`cover_overlay.py`（封面文字叠加）、`batch_tts.py`（批量配音）
- `templates/`：`composition.html`（渲染源模板，含 F9 片尾 CTA）、`customize.py`（场景文案定制，幂等）
- `skills/`：`cover-image-gen/`（文生图，仅纯文生图）
- `config/`：`voice_cache.example.json`（配置格式示例）、本地忽略的 `voice_cache.json`（Inworld key+voiceId）、`cta_config.json`（CTA 文案/样式）
- `assets/audio/cta_tail.mp3`：默认片尾配音模板
