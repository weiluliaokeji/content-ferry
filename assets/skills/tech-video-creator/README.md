# tech-video-creator

把任一技术主题做成**带中文配音的科普讲解视频**（MP4 + 可交互 HTML）。

内核是 [anatomy](https://github.com/wheresryan22/anatomy) 等距插图渲染引擎 + 自建的视频渲染/配音管线，打包为可复用技能。

## 它能做什么

1. 用等距 SVG 画一张技术原理图（踏板、电池、管路……任意你能在 `figure.mjs` 里建模的几何体）。
2. 切成多镜分镜动画，暴露 `window.__seek(t)` 时间轴钩子。
3. headless Chrome 逐帧寻址、截取画面，经 `image2pipe` 直灌 ffmpeg 编码成无声 MP4。
4. 用 edge-tts 合成中文配音，ffmpeg 混流成带声成片。

## 快速开始（以示例 `ev-brake-pedal` 为例）

```bash
SKILL="D:/Workbench/ContentFerry/assets/skills/tech-video-creator"
EX="$SKILL/examples/ev-brake-pedal"
NODE="C:/Users/adams/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"

# 1) 生成渲染源 HTML（分镜时间轴随 DUR_SCALE 拉伸对齐配音）
cd "$EX"
DUR_SCALE=1.54228810 $NODE build-video.mjs --light

# 2) 渲染无声 MP4（--seconds 必须等于配音时长）
$NODE "$SKILL/scripts/render-mp4.mjs" \
  --page ./ev-brake-pedal-video-light.html --theme light \
  --seconds 103.314286 --port 9335

# 3) 混流配音（示例已带 narration.mp3；重生成见下）
FF="D:/Tools/ffmpeg-2024-09-12-git-504c1ffcd8-full_build/bin"
"$FF/ffmpeg.exe" -y -i ev-brake-pedal-video-light.mp4 -i narration.mp3 \
  -c:v copy -c:a aac -b:a 192k -af loudnorm=I=-16 -shortest \
  ev-brake-pedal-video-light-narrated.mp4
```

## 重生成配音（或做新主题）

```bash
# 示例自带（EV 专用，SCENES 硬编码）
python gen_narration.py

# 通用版：读 scenes.txt（每行一段，与 build-video.mjs 的 SCENES 对齐）
python "$SKILL/scripts/narrate.py" --scenes scenes.txt --out narration.mp3
```

拿到 `narration.mp3` 后用 `ffprobe` 读时长，算 `DUR_SCALE = 时长 / 67`，回填第 1 步。

## 目录结构

```
tech-video-creator/
├── SKILL.md            # 完整规格 / 依赖 / 工作流 / 踩坑
├── README.md
├── scripts/
│   ├── inline-kit.mjs  # 内核胶水（必须保持与 kit/ 的相对布局）
│   ├── render-mp4.mjs  # 通用渲染器（--page/--out/--theme/--seconds/--port）
│   └── narrate.py      # 通用中文配音生成器
├── kit/                # anatomy 等距渲染内核
└── examples/
    └── ev-brake-pedal/ # 已验证完整成品（源 + HTML + 配音 + 旁白稿）
```

## 必看坑（详见 SKILL.md）

- ffmpeg 走 **image2pipe 直灌**，不写帧文件（防沙箱拦截）。
- edge-tts **必须 ≥7.3.1**（7.2.8 有 GEC 令牌 403）。
- 别用 bash 内置变量名 **`SECONDS`** 传时长（会错乱）。
- 深/浅两版**串行**渲染（并行抢 CPU 会卡死 + MP4 损坏）。
- 浅色主题配色用 `mix-blend-mode: multiply` + `radialGradient` 软光晕。
