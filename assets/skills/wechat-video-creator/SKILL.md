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
| 主配音原始时长 | **78–168s**（约 300–500 字中文）|
| 调速（owner 硬性）| **一律 1.3x**；安全区间 1.2–1.7x；**1.0x = 缺陷，禁止交付**；仅主配音 <78s 且提速后 <60s 才扩充脚本（不保留 1.0x）|
| 含 CTA 总时长 | **67–136s**（CTA 实际时长以 `cta_tail.mp3` 的 `ffprobe` 为准，约 6.77s）|
| 视频编码 | H.264 (libx264, -crf 20, -pix_fmt yuv420p) |
| 音频编码 | AAC (192k) |
| 字幕 | 每场景 ≤1 条、单行 ≤28 字（防重叠）；贴底 `--caption-bottom:100px` |
| 发布短标题符号 | **仅支持 `《》“”：+？%℃`**；逗号/顿号/破折号/括号等一律不可用，**逗号用空格代替**（细则见 `references/05-cover-cta.md`；不约束封面图文字）|
| 渲染 | Edge/Chromium CDP `127.0.0.1:19222`（启动必须 `--disable-extensions`）|

**口播字数门禁（唯一定义，Step 2 与 Step 3 共用，不在别处重复）**：
- ≤300 字：绿灯，进配音
- 301–400 字：黄灯，建议精简到 ≤300（不阻断）
- >400 字：红灯阻断，禁止进配音
- 统计口径：仅口播正文（`文案：` 后），排除字幕/画面/markdown。300 字 ≈ 90–105s 原始配音，是 1.2–1.7x 安全甜点。

## 依赖与环境

- **运行时**：Python 3.11+；`pip install websockets`；ffmpeg（PATH 中，libx264/aac）；faster-whisper；Edge/Chromium 无头（CDP）。
- **Inworld TTS**：API key + `voiceId` 持久化于本地 `config/voice_cache.json`（**非环境变量**）；仓库只提供 `config/voice_cache.example.json`，真实文件由使用者在本地创建，不能随技能迁移或提交。克隆只需一次，永久复用；多 key 数组轮询，失败不降级其他 TTS。
- **文生图**：`baidu-image-gen`（系统预装优先，支持文生图/图生图/编辑/超分/扩图/局部重绘）；备用 `cover-image-gen`（仅文生图）。
- **CTA 文案/样式**：`config/cta_config.json`（可设 `"enabled": false` 关闭片尾）。
- **文章目录**：文档中的 `D:\Workbench\weiluliaokejiBlogs\docs\posts\...` 只是示例，实际执行必须传入文章目录的绝对路径；产物默认写入 `<article_dir>/assets/video-assets/`。
- **CTA 音频**：`assets/audio/cta_tail.mp3` 当前针对微信公众号“围炉聊科技”；其他公众号需要自行替换同名文件，并用 `ffprobe` 重新确认实际时长。
- **环境预检（渲染前确认）**：`where msedge` / `where ffmpeg` / `python -c "import websockets"` 均可用；`ffprobe -v error -show_entries format=duration assets/audio/cta_tail.mp3` 读 CTA 实际时长。

## 工作流（步骤索引）

源文章用 `<article_dir>` 指代（如 `D:\Workbench\weiluliaokejiBlogs\docs\posts\{标题}`），产物落 `<article_dir>/assets/video-assets/`。各步明细见 `references/`：

1. **读取源文章** → 提炼 3–5 核心论点 [`references/01-article-script.md`]
2. **撰写口播脚本 + 分镜**（钩子优先）[同上]
3. **脚本复核**（原文比对：数据/术语/结论/逻辑）[同上]
4. **克隆配音**（Inworld TTS，复用 `voiceId`）[`references/02-tts-audio.md`]
5. **分段处理 + stutter 检测**（faster-whisper → `segments.json`）[同上]
6. **生成场景素材图**（baidu-image-gen，必要时 cover-image-gen 兜底）[`references/03-images-screenshots.md`]
7. **复用文章真实截图**（实操/产品/教程类必做）[同上]
8. **构建渲染源 HTML**（`fill_template.py` 填时间/字幕）[`references/04-html-render-ffmpeg.md`]
9. **定制场景文案**（`customize.py`，**已幂等**，重跑即重建）[同上]
10. **逐帧渲染**（Edge CDP `render_frames.py`）[同上]
11. **ffmpeg 合成 MP4**[同上]
12. **封面 + 发布物料 + CTA**（`cover_overlay.py` / `cta_config.json`）[`references/05-cover-cta.md`]

## 渲染前检查清单（必做）

- [ ] 占位符已替换：`grep -nE '主标题 <em>高亮词</em>|观点 [0-9] <em>高亮</em>|选型 <em>矩阵</em>|总结 <em>高亮</em>' composition/index.html` 不应命中
- [ ] `grep -c '<!-- 场景内容 -->' composition/index.html` = 0；`grep -c '<!-- matrix 示例' composition/index.html` = 0
- [ ] 实操/产品类文章：相关场景含 `.screenshot` / `.ss-compare` / `.ss-stack`（真实截图已复用，非全 AI 抽象图）
- [ ] `snapshot_frames.py` 在每场景中段截图，核对字幕贴底、内容未裁切（`.scene-inner` 计算高度 ≤ 1540px）
- [ ] `unset HTTP_PROXY`（沙箱代理会假 502）；路径用 Windows 原生 `D:/...` 非 `/d/...`；ffmpeg 不接 `tail`/`head` 管道
- [ ] **vendor 目录必检（新增）**：`Test-Path composition/assets/vendor/gsap.min.js` 为 True；缺失则 `Invoke-WebRequest "https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js" -OutFile composition/assets/vendor/gsap.min.js`。缺失会导致 `FATAL: page not ready` 超时退出（`is_ready` 检查含 `!!window.__timelines.main`，gsap 加载失败时短路为 false）（详见 `references/06-troubleshooting.md` 坑 6）
- [ ] **evaluate 返回值须为标量（新增）**：所有 `window.__timelines.main.time(t)` / `.progress(p)` 调用须包 IIFE 返回 number（`(() => { ...; return 0; })()`），否则 playwright 序列化 GSAP timeline 对象（含循环引用）会递归卡死；CDP 路径虽默认 `returnByValue: false` 不受影响，但 IIFE 仍是最佳实践（详见坑 7）

## 排错

高频问题与 Windows/代理/精简 shim 实测坑（代理 502、`/d/` 路径、ffmpeg 无 tail、CDP Host 头、Edge 守护常驻、字幕重叠、GSAP 预置隐藏、**vendor 缺失假死、evaluate 返回 timeline 卡死**）见 [`references/06-troubleshooting.md`]。

## Bundled Resources

- `scripts/`：`render_frames.py`（CDP 逐帧）、`segment_processor.py`（分段+stutter）、`snapshot_frames.py`（渲染前目检）、`fill_template.py`（占位符填充）、`audio_post_process.py`（时长检测+atempo）、`inworld_tts.py`（TTS 合成）、`voice_manager.py`（配置读写）、`cover_overlay.py`（封面文字叠加）、`batch_tts.py`（批量配音）
- `templates/`：`composition.html`（渲染源模板，含 F9 片尾 CTA）、`customize.py`（场景文案定制，幂等）
- `skills/`：`baidu-image-gen/`、`cover-image-gen/`（文生图）
- `config/`：`voice_cache.example.json`（配置格式示例）、本地忽略的 `voice_cache.json`（Inworld key+voiceId）、`cta_config.json`（CTA 文案/样式）
- `assets/audio/cta_tail.mp3`：默认片尾配音模板
