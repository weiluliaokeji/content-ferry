---
name: tech-video-creator
description: >
  把任一技术主题做成「带中文配音的科普讲解视频」的完整工作流技能。
  内核是 anatomy 等距插图渲染引擎（kit/ + scripts/inline-kit.mjs）：先由 figure.mjs
  产出 SVG 几何真相源，build-video.mjs 把它切成多镜分镜并暴露 window.__seek(t)
  时间轴钩子；再用 headless Chrome 走 DevTools 协议逐帧寻址、截取 .ev-video 元素，
  经 image2pipe 直灌 ffmpeg 编码成 MP4；最后用 edge-tts 合成中文配音并混流。
  触发：用户说「做个科普视频 / 原理讲解动画 / 技术可视化视频」，或给出某主题要求制视频。
version: "1.0.0"
---

# tech-video-creator

把任一技术主题渲染成**带中文配音的科普讲解视频**（MP4 + 可交互 HTML）。

> 本技能不是从零造轮子，而是把 `anatomy` 等距插图引擎 + 自建的视频渲染/配音管线
> 打包成可复用技能。配套示例 `examples/ev-brake-pedal/`（新能源车刹车踏板原理）
> 是已验证跑通的完整成品，新主题照它仿写 `figure.mjs` + `build-video.mjs` 即可。

## 视频规格（唯一真值表）

| 参数 | 值 |
|------|-----|
| 画布宽（WIDTH） | 720px（figure.mjs 定义）|
| 渲染缩放 SCALE | 1.5 → 输出约 **1080×1090**（按 `.ev-video` 实际包围盒 ×1.5）|
| 帧率 | 24fps |
| 视频编码 | H.264 (libx264, -crf 18, -pix_fmt yuv420p, -movflags +faststart) |
| 音频编码 | AAC (192k) |
| 配音 | edge-tts `zh-CN-XiaoxiaoNeural`（暖声中女声；可用 `zh-CN-YunxiNeural` 男声）|
| 时序对齐 | `DUR_SCALE = 配音时长 / 67`（BASE_TOTAL=67 是 build-video.mjs 各镜 dur 之和）；渲染 `--seconds` 须 = 配音时长 |
| 主题 | `dark` / `light` 双主题（浅色版用 `mix-blend-mode: multiply` + `radialGradient` 软光晕，见坑 5）|

## 产物目录契约（示例 `examples/<topic>/`）

```
examples/<topic>/
├── figure.mjs            # 几何真相源：export buildFigure() + WIDTH/HEIGHT/EV_* 常量（必改）
├── build-video.mjs       # 分镜脚本：RAW 分镜数组 + 暴露 window.__seek(t)（必改）
├── build.mjs             # （可选）交互巡航版网页生成器
├── <topic>-video.html            # 渲染源（dark 主题，build-video.mjs 产物）
├── <topic>-video-light.html      # 渲染源（light 主题，build-video.mjs --light 产物）
├── <topic>.html                  # （可选）交互版成品
├── scenes.txt            # 配音文案：每行 = 一个分镜口播（与 build-video.mjs 的 SCENES 对齐）
├── narration.mp3         # 中文配音（narrate.py / gen_narration.py 产物）
├── narration-script.md   # 旁白稿 + 时间轴（人读版，可不出）
└── <topic>-video-light-narrated.mp4   # 最终带声成片
```

**约定**：
- 渲染器 `scripts/render-mp4.mjs` 的输入 HTML 由 `--page` 显式指定，输出 MP4 由 `--out` 指定；不传则回退到 `ev-brake-pedal` 示例默认值（向后兼容）。
- 所有脚本从**示例目录**调用，路径参数用 Windows 原生绝对路径（`D:/...`），不要用 `/d/...`（代理/沙箱下会 502 或解析失败）。
- `node` 用 WorkBuddy 托管运行时：`C:/Users/adams/.workbuddy/binaries/node/versions/22.22.2-6/node.exe`；`python` 用系统 Python 3（含 edge-tts）。

## 依赖与环境

- **Node**：22+（仅用于 build-video.mjs / render-mp4.mjs，纯 ESM，无 npm 依赖）。
- **Chrome**：任意 Chromium 系无头浏览器，默认 `C:/Program Files/Google/Chrome/Application/chrome.exe`；可用 `CHROME_PATH` 覆盖。
- **ffmpeg + ffprobe**：默认 `D:/Tools/ffmpeg-2024-09-12-git-504c1ffcd8-full_build/bin/`；可用 `FFMPEG_PATH` 覆盖。须经 image2pipe 直灌（见坑 1），不可写帧文件。
- **Python 3 + edge-tts**：`pip install --upgrade edge-tts`（**必须 ≥7.3.1**，7.2.8 有 GEC 令牌 403 报错，见坑 2）。
- **渲染内核**：`kit/`（iso-kit.mjs 等距投影内核，自包含）+ `scripts/inline-kit.mjs`（`..`/kit 相对定位，**两者必须保持本布局**，build-video.mjs 通过 `../../scripts/inline-kit.mjs` 与 `../../kit/iso-kit.mjs` 引用）。

## 工作流（步骤索引）

以新主题为例，骨架可完全照搬 `examples/ev-brake-pedal/`：

0. **初始化示例目录**：复制 `examples/ev-brake-pedal/` 为 `examples/<topic>/`，删掉成品只留 `figure.mjs`/`build-video.mjs`/`build.mjs`/配音脚本/文案。
1. **写几何真相源 `figure.mjs`**：导出 `buildFigure()` 返回 `{ svg }`，并 `export` 需要的常量（WIDTH/HEIGHT/EV_LIVE/EV_STYLE 等）。可拆 `data-sys` 子系统分组（input/vcu/regen/friction/gauge…）供分镜高亮。
2. **写分镜 `build-video.mjs`**：`RAW` 数组每项 `{ sys, force, dur, title, body, demo? }`；`dur` 之和须 = 67（即 BASE_TOTAL），否则改 `render-mp4.mjs` 的 `BASE_TOTAL`；`body` 即该镜口播文案（与 `scenes.txt` 对齐）。跑 `node build-video.mjs --light` 生成 `<topic>-video-light.html`，确认含 `__seek` 钩子与 `.ev-video` 元素。
3. **写配音文案 `scenes.txt`**：每行一段，顺序与 `RAW` 一致。
4. **合成配音**：`python ../../scripts/narrate.py --scenes scenes.txt --out narration.mp3`（或示例自带 `gen_narration.py`）。读 `_narr_duration.json` 拿时长。
5. **算 `DUR_SCALE`**：`DUR_SCALE = 配音时长 / 67`。该值同时拉伸分镜时间轴，使画面节奏与配音对齐。
6. **渲染无声 MP4**：在示例目录跑
   `DUR_SCALE=<值> node ../../scripts/render-mp4.mjs --page ./<topic>-video-light.html --theme light --seconds <配音时长> --port 9335`
   （`--seconds` 必须等于配音时长，否则画面会循环包裹错位）。
7. **混流配音**：
   `ffmpeg -y -i <silent>.mp4 -i narration.mp3 -c:v copy -c:a aac -b:a 192k -af loudnorm=I=-16 -shortest <topic>-video-light-narrated.mp4`
8. **校验**：`ffprobe` 看时长≈配音时长；`ffmpeg -i out.mp4 -af volumedetect -f null -` 看 `mean_volume` 非静音（示例成片 mean≈-19dB）。

## 渲染前检查清单（必做）

- [ ] `grep -c "__seek" <topic>-video-light.html` ≥ 1；页面含 `.ev-video` 元素（渲染器靠这两个定位）。
- [ ] 浅色主题：配色/光晕用 `mix-blend-mode: multiply` + `radialGradient`，否则在浅底上发暗/糊（坑 5）。
- [ ] `--seconds` = 配音时长；`DUR_SCALE` 已注入（否则分镜 67s 与配音 103s 错位）。
- [ ] 深/浅两版**串行**渲染（坑 4）；若并行抢 CPU 会卡死且 MP4 损坏（moov atom not found）。
- [ ] ffmpeg 走 image2pipe 直灌 stdin，**不写帧文件**（坑 1，防沙箱批量删除拦截）。
- [ ] `unset HTTP_PROXY`（沙箱代理会假 502）；路径用 Windows 原生 `D:/...`。

## 排错 / 高频坑（实测）

1. **禁止写帧文件**：早期用 `rmSync` 清帧触发沙箱批量删除拦截导致失败。改用 image2pipe 把 PNG 直灌 ffmpeg stdin，零帧文件落盘。
2. **edge-tts 403（GEC 令牌）**：`pip install --upgrade edge-tts` 升到 ≥7.3.1（`7.2.8` 有令牌失效 403）。升级后 `zh-CN-XiaoxiaoNeural` 正常。
3. **bash 内置变量 `SECONDS` 陷阱**：渲染命令若写 `SECONDS=$(cat _seconds.txt)` 会被 shell 实时改写，导致深浅时长错乱（深色 67s / 浅色 245s）。**绝不用 `SECONDS` 作变量名**，改用 `VL` 等，或直接传字面数值。
4. **并行渲染卡死**：深/浅两版同时跑会抢 CPU 卡死 1 小时且 MP4 损坏。串行渲染，或给不同 `--port`（9333/9335）并确保机器空闲。
5. **浅色主题配色**：heat glow 等光晕在浅底上要用 `mix-blend-mode: multiply` 混合、用 `radialGradient` 软光晕，否则发黑发糊。
6. **`__seek` 钩子必须存在**：渲染器循环调用 `__seek(t)` 定位每一帧；若页面未暴露该全局函数，逐帧全黑。build-video.mjs 已在 driver 段 `window.__seek=seekTo` 暴露。

## Bundled Resources

- `kit/`：anatomy 等距投影渲染内核（`iso-kit.mjs` 自包含纯函数；`inline-kit.mjs` 经 `..`/kit 引用 gl/turn/canvas-painter 等）。
- `scripts/inline-kit.mjs`：把内核打包进 HTML 的胶水（build-video.mjs / build.mjs 依赖，必须保持 `scripts/inline-kit.mjs` + `kit/` 布局）。
- `scripts/render-mp4.mjs`：通用渲染器（headless Chrome CDP 逐帧 + image2pipe→ffmpeg）。参数 `--page/--out/--theme/--fps/--scale/--seconds/--port`；`DUR_SCALE` 走 env。
- `scripts/narrate.py`：通用中文配音生成器（读 `--scenes` 文件逐段合成 + 段间静音），基于示例 `gen_narration.py` 改造。
- `examples/ev-brake-pedal/`：已验证完整成品（源 + 渲染输入 HTML + 配音 + 旁白稿）。`gen_narration.py` 为该示例的 EV 专用配音脚本（SCENES 硬编码，可作模板改写）。
