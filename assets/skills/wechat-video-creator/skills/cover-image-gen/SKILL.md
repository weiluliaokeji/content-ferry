---
name: cover-image-gen
description: 文生图封面技能：根据文章标题与正文（或任意主题）提炼生图提示词，经用户确认后调用 ModelScope（Qwen-Image，异步任务轮询）或 Agnes（同步 b64）图片模型生成横版/竖版封面并保存到本地。Use when 需要为文章、公众号、视频生成封面图、题图、配图时使用（触发词：封面、配图、生图、文生图、cover、image generation）。图像编辑、图生图、超分、扩图、局部重绘当前不支持，请改用真实截图复用或纯色/渐变背景。
---

# Cover Image Gen（封面生图）

## 🎯 触发场景（Usage）

### 适合使用本技能的场景
- 为文章、公众号、视频从零生成 16:9 横版封面。
- 只有主题或正文，需要先提炼出生图提示词再生图。
- 需要调用 ModelScope（Qwen-Image 系列）或 Agnes 图片模型生图，并把结果保存到本地。

### 不适合使用本技能的场景
- 图生图、图像编辑、风格迁移、扩图、局部重绘、超分 —— 当前不支持；如需展示产品界面/截图，复用文章内真实图片；如需纯背景，用 HTML/CSS 渐变。
- 纯图像后处理（格式转换、裁剪、压缩）—— 用普通图像处理工具。
- 用户未提供 prompt 且无法从上下文推断生图意图。

## 🧩 两阶段流程（硬性门禁）

```
阶段一：提示词生成          阶段二：生图执行
阅读主题/正文 ──→ 按规则写提示词 ──→ 【用户确认门】──→ 只把最终确认的提示词 ──→ 调用图片模型 ──→ 保存并展示
                                     （用户可编辑）      原样交给图片模型
```

1. **提示词生成阶段**：阅读文章标题和正文（或用户给定的主题），按下方规则生成一段可直接交给图片模型的提示词。
2. **用户确认门（阻断步骤）**：提示词必须先展示给用户确认或编辑。不得自动拼接文章标题、正文、摘要或其他限制到提示词中。
3. **生图执行阶段**：只把用户最终确认的提示词**原样**交给图片模型；是否在图中生成文字，完全以用户确认的提示词为准。
4. **结果展示门**：生成结果必须先展示给用户确认，不能自动发布或上传。

## 📝 提示词生成规则

1. 提炼内容真正的主题、对象和情绪，不机械复述标题。
2. 明确画面主体、环境、构图、镜头、色彩、光线和视觉风格，适配 16:9 横版封面。
3. 主体应在缩略图中仍然清楚，并为可能的标题排版预留干净区域。
4. 默认不要在图片中生成文字、Logo、水印、二维码、界面小字或无意义符号。
5. 涉及抽象技术概念时，将其转化为可理解的视觉隐喻，避免堆砌芯片、机器人和霓虹电路等套路元素。
6. 不添加原文没有的人物、品牌背书、产品能力或事件事实。
7. 只输出一段完整的中文生图提示词，不附解释。

## ⚙️ 生图执行（两种接入模式）

### 模式一：ModelScope（异步任务模式，推荐）

```
提交 → task_id → 每 3 秒轮询 → SUCCEED → 下载 output_images[0]
```

| 步骤 | 请求 |
|---|---|
| 提交 | `POST {base}/v1/images/generations`，Header：`Authorization: Bearer <key>`、`x-modelscope-async-mode: true`（**必须**，否则不返回 task_id）；Body：`{model, prompt, n: 1, size}` |
| 轮询 | `GET {base}/v1/tasks/{task_id}`，Header：`Authorization`、`x-modelscope-task-type: image_generation` |
| 取图 | `task_status === "SUCCEED"` 时下载 `output_images[0]`；`"FAILED"` 时读取 `errors` 并报错 |

- 默认模型 `Qwen/Qwen-Image-2512`，默认 base `https://api-inference.modelscope.cn`。
- 尺寸由 `--resolution` + `--aspect_ratio` 映射（如 1K/16:9 → `1280x720`，2K/9:16 → `1584x2816`），完整映射见脚本 `MODELSCOPE_SIZE_MAP`。
- **429 处理**：ModelScope 在突发调用/单分钟限流时会把 429 误报为 `insufficient balance`。首次撞限流退避 2 秒重试一次；第二次仍失败才是真的余额不足，原样抛出。
- 提交是异步的，即使轮询断开任务也不会丢失，重新轮询即可。

### 模式二：Agnes（同步 b64 模式）

```
POST {base}/images/generations → data[0].b64_json | data[0].url
```

- 请求 Body：`{model, prompt, size: "1K|2K|4K", ratio: "16:9", n: 1, response_format: "b64_json"}`（size 即 `--resolution` 的值，已实测 2K/4K 生效：2K/16:9 → 2624×1472，4K/16:9 → 5248×2944）。
- 默认 base `https://apihub.agnes-ai.com/v1`，默认模型 `agnes-image-2.1-flash`。
- 返回 `data[0].b64_json` 直接 base64 解码保存；只有 `url` 时下载该 URL。

## 🔧 脚本用法

```bash
# ModelScope（异步任务，内部自动提交+轮询+下载）—— 推荐用统一参数
python3 scripts/generate_image.py \
  --provider modelscope \
  --prompt "<用户确认后的提示词>" \
  --resolution "2K" --aspect_ratio "16:9" \
  --output "/abs/path/to/cover.png"

# Agnes（同步 b64）—— 推荐用统一参数
python3 scripts/generate_image.py \
  --provider agnes \
  --prompt "<用户确认后的提示词>" \
  --resolution "2K" --aspect_ratio "16:9" \
  --output "/abs/path/to/cover.png"

# 向后兼容：旧参数仍可用，但会提示建议迁移
# ModelScope 旧写法
python3 scripts/generate_image.py \
  --provider modelscope --prompt "..." --size "1024x576" --output "..."

# Agnes 旧写法
python3 scripts/generate_image.py \
  --provider agnes --prompt "..." --ratio "16:9" --output "..."

# 自检模式（验证环境变量、网络可达性、参数映射表）
python3 scripts/generate_image.py --self-check

# 空跑模式（只打印参数，不联网）
python3 scripts/generate_image.py --provider modelscope --prompt "..." --dry-run
```

- API Key 优先取 `--api-key`，否则读环境变量 `MODELSCOPE_API_KEY` / `AGNES_API_KEY`。
- **统一参数（分辨率与宽高比）**：
  - `--resolution`：`1K` / `2K` / `4K`（默认 `2K`）
  - `--aspect_ratio`：`1:1` / `9:16` / `16:9` / `2:3` / `3:2` / `3:4` / `4:3` / `21:9` / `9:21`（默认 `16:9`）
- 向后兼容别名：`--size`（ModelScope 尺寸，自动反解为 `--resolution`/`--aspect_ratio`，反解失败报错退出）、`--ratio`（Agnes 宽高比，须为合法宽高比），使用时会提示建议迁移到统一参数。
- 可选：`--model`、`--base-url`、`--timeout`（轮询上限，默认 300 秒）、`--dry-run`（只打印请求参数，不联网，用于校验参数）、`--self-check`（自检模式）。
- 退出码：`0` 成功；`1` 参数错误（缺 prompt/output）；`2` 生图失败（含限流重试后仍失败、任务 FAILED、轮询超时）。

## ⚠️ 核心约束（Guidelines)

- MUST 要求非空 prompt；为空时停止并要求先完成提示词生成阶段。
- MUST 在生图前通过用户确认门；未经确认的提示词不得直接生图。
- MUST 按响应 `content-type` 决定扩展名（jpeg→.jpg，webp→.webp，其余默认 .png）。
- MUST 将生成的图片保存到用户指定路径或当前工作目录；不要保存到 SKILL 目录。
- SHOULD 在提交前向用户展示将要使用的 provider、model、尺寸参数。
- NEVER 把 API Key 写进代码、日志或展示给用户。
- NEVER 修改用户已确认的提示词后再提交。

## ❌ 常见错误

| 现象 | 原因与处理 |
|---|---|
| `insufficient balance` 但余额充足 | ModelScope 把 429 限流误报为余额不足；退避 2 秒重试一次 |
| 一直没有 task_id | 提交时漏了 `x-modelscope-async-mode: true` 头 |
| 轮询一直 PENDING | 正常现象，任务不会丢；超过 `--timeout` 再报错 |
| content-type 缺失 | 按默认 png 保存 |
| 模型返回了结果但没有图片数据 | 检查 prompt 是否触发内容过滤，调整提示词重试 |

## 🌟 示例（Example）

**Input:** "给这篇讲 RAG 检索增强的文章生成一张封面。"

1. 生成提示词并展示：`一只纸船漂浮在由无数发光卡片组成的河流上，远处灯塔投下柔和光束，浅景深，暖色调，极简插画风格，画面上方留白。`
2. 用户确认（或编辑）后执行：

```bash
python3 scripts/generate_image.py \
  --provider modelscope \
  --prompt "一只纸船漂浮在由无数发光卡片组成的河流上，远处灯塔投下柔和光束，浅景深，暖色调，极简插画风格，画面上方留白。" \
  --resolution "2K" --aspect_ratio "16:9" \
  --output "./cover.png"
```

3. 展示生成的 `cover.png`，等待用户确认后再进入后续发布流程。
