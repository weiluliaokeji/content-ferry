# wechat-video-creator

为微信公众号视频号制作 1080×1920 竖屏短视频的完整工作流。

## 快速开始

### 前置依赖

- **Edge 无头浏览器**：`msedge --headless --remote-debugging-port=19222`
- **Python**：`pip install websockets`
- **ffmpeg**：确保在 PATH 中
- **Inworld key**：从本地 `config/voice_cache.json` 读取（首次使用需根据 `config/voice_cache.example.json` 创建，真实凭据只保存在本地，不随技能迁移或提交）
- **文章目录**：文档中的 `D:\Workbench\weiluliaokejiBlogs\docs\posts\...` 只是示例路径，执行时必须替换为实际文章目录的绝对路径；产物默认写入该文章目录下的 `assets/video-assets/`。
- **片尾 CTA 音频**：`assets/audio/cta_tail.mp3` 当前是为微信公众号“围炉聊科技”准备的片尾配音。制作其他公众号的视频前，需要自行替换为对应账号的音频，并保持文件名为 `cta_tail.mp3`；替换后用 `ffprobe` 检查实际时长，`cta_config.json` 只负责 CTA 文案和样式，不能替代音频更换。

### 文件结构

```
wechat-video-creator/
├── SKILL.md              # 精简索引：规格真值表 + 依赖 + 步骤索引 + 检查清单
├── README.md             # 本文件（快速开始）
├── references/           # 详细步骤与踩坑实录（SKILL.md 各步指向此处）
│   ├── 01-article-script.md
│   ├── 02-tts-audio.md
│   ├── 03-images-screenshots.md
│   ├── 04-html-render-ffmpeg.md
│   ├── 05-cover-cta.md
│   └── 06-troubleshooting.md
├── config/
│   ├── voice_cache.example.json # 配置格式示例
│   ├── voice_cache.json  # 本地 Inworld API key 与 voiceId（被 .gitignore 忽略）
│   └── cta_config.json   # 片尾 CTA 文案与样式配置
├── scripts/
│   ├── render_frames.py     # Edge CDP 逐帧渲染脚本
│   ├── inworld_tts.py       # Inworld TTS 合成（多 key 轮询，不降级）
│   ├── voice_manager.py     # 配置读写工具
│   ├── segment_processor.py # 分段计时 + stutter 检测（比对相邻 whisper 转写文本）
│   ├── audio_post_process.py # 时长检测 + atempo 压缩
│   ├── fill_template.py     # 模板占位符填充
│   ├── snapshot_frames.py   # 渲染前快速目检（CDP 时间点截图）
│   ├── cover_overlay.py     # 封面文字叠加
│   └── batch_tts.py         # 批量配音
├── skills/
│   └── cover-image-gen/  # 文生图技能（ModelScope / Agnes，仅纯文生图）
├── templates/
│   ├── composition.html  # 渲染源 HTML 模板（占位符驱动，含 F9 片尾 CTA）
│   └── customize.py      # 场景文案定制（已幂等）
└── assets/
    └── audio/
        └── cta_tail.mp3  # 默认片尾配音模板（实际时长以 ffprobe 为准）
```

### 使用流程

1. **读取源文章** → 提炼核心观点
2. **撰写脚本** → `composition/SCRIPT.md`（按 `## F数字` 格式分段）
3. **复核脚本** → 原文比对（数据、术语、结论、逻辑）
4. **克隆配音** → `python scripts/inworld_tts.py --text "文案" --output audio/narration.mp3`
5. **分段处理与 stutter 检测** → `python scripts/segment_processor.py composition/SCRIPT.md audio/narration.mp3 --output segments.json`
   - 自动按段落切分、whisper 转写、匹配时间戳、检测 stutter
6. **配音后处理（时长压缩）** → `python scripts/audio_post_process.py audio/narration.mp3 --segments segments.json`
   - **owner 硬性：一律 1.3x 提速**（安全区间 1.2–1.7x），1.0x 视为缺陷；>168s 阻断，<78s 警告扩充。详见 `references/02-tts-audio.md`
7. **生成素材** → 竖屏配图（见下方"图片生成备选方案"）
8. **填充模板构建 HTML** → `python scripts/fill_template.py segments.json templates/composition.html composition/index.html`
   - 自动替换所有 `{{SCENE_N_START}}` 等占位符为真实时间戳
9. **逐帧渲染** → `python scripts/render_frames.py <absolute_path_to_html> <frames_dir> 25`
10. **合成 MP4** → `ffmpeg -framerate 25 -i frame_%05d.jpg -i audio/narration.mp3 ...`
11. **产出物料** → 封面 + 描述 + 短标题

### 图片生成方案

通过 `cover-image-gen` 生成竖屏素材（仅纯文生图）：
1. **ModelScope（推荐）**：`python3 skills/cover-image-gen/scripts/generate_image.py --provider modelscope --prompt "<提示词>" --resolution 2K --aspect_ratio 9:16 --output composition/assets/img/scene-NN.png`（异步任务，需 `MODELSCOPE_API_KEY`）
2. **Agnes**：`--provider agnes`（同步 b64，需 `AGNES_API_KEY`）

图生图/编辑/超分/扩图/局部重绘当前不支持。需要展示产品界面、API 文档、数据看板等真实截图时，直接复用文章内图片（见 `references/03-images-screenshots.md` Step 7），不要用 AI 抽象图替代。仍需纯背景时用 HTML/CSS 渐变背景。

### 关键规格

| 参数 | 值 |
|------|-----|
| 分辨率 | 1080 × 1920 |
| 帧率 | 25fps |
| 时长 | 67–136 秒（含 CTA，主配音原始 78–168s；**一律 1.3x 提速**）|
| 视频编码 | H.264 (libx264, -crf 20) |
| 音频编码 | AAC (192k) |
| 字幕粒度 | 每场景 ≤ 1 条，单行 ≤ 28 字（防重叠） |
| atempo 上限 | 1.7x（超则回退精简脚本，禁止硬压）|

> 完整规格、口播字数门禁以 `SKILL.md`「视频规格（唯一真值表）」为准。

### 系列复用

同一系列（如"智能体基建系列"）只需替换 `composition/index.html` 中的场景内容与图片路径，CSS 变量、字体、chrome 装饰条保持一致。

## 已知坑点

1. **画面叠加**：必须在 JS 初始化时执行 `tl.set(".clip", {autoAlpha: 0})`
2. **HTML 闭合标签**：`hbar-track` 等容器必须正确闭合，否则 flex/grid 布局会错位
3. **配音尾部**：用 whisper 确认最后一句结束时间，再用 ffmpeg 裁切平台声明
4. **字体加载**：模板使用 Google Fonts，网络受限时需下载到本地
5. **字幕与内容重叠**：模板已内置 `--caption-safe` + `.scene-inner max-height` + `overflow:hidden` 硬性兜底。内容密度有硬上限（steps ≤4 条 / desc ≤12 字 / matrix ≤4 行 / 字幕单行 ≤28 字），超限请精简文案，不要放宽 CSS

## 目录示例

```
文章 assets/
└── video-assets/
    ├── composition/
    │   ├── index.html
    │   ├── assets/
    │   │   ├── audio/narration.mp3
    │   │   ├── img/
    │   │   │   ├── cover.png
    │   │   │   └── ...
    │   │   └── vendor/gsap.min.js
    │   └── SCRIPT.md
    ├── 视频号发布物料.md
    └── 封面.png
```
