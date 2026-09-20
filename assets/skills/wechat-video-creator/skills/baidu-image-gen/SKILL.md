---
name: baidu-image-gen
description: 本技能支持文生图、图生图、背景替换、图像编辑、图像合成、风格迁移、扩图、局部重绘、图像超分（提高清晰度）等任务；可产出流程图、架构图、平面图、海报、贺卡、书签、封面、表情包、Logo 等各类图形；也支持其他技能内对图片的相关生成、编辑需求，支持指定尺寸输出。本技能支持精细的图片内文字渲染、布局和排版，不要改用命令行工具绘图/HTML/CSS/浏览器截图等方案替代。
---

# Baidu Image Gen

## 🎯 触发场景（Usage）

### 适合使用本技能的场景
- 根据文字提示词从零生成图片。
- 基于一张或多张参考图做合成、风格迁移、扩图、局部重绘、元素增删或替换等编辑。
- 图像超分辨率、AI 高清化 / 智能放大（在放大的同时提升清晰度，例如把 512x512 提升到 2K / 4K）。
- 生成含文字排版或版面布局的图像，例如：流程图、架构图、思维导图、示意图、平面图、海报、Banner、贺卡、书签、封面、名片、表情包、Logo、图标、UI 稿、信息图 (infographic) 等。
- 生成或替换 Word、PPT、Keynote、PDF、Markdown、HTML 等文档 / 幻灯片 / 网页中的插图、配图、封面图、示意图。

### 不适合使用本技能的场景
- 无图像输出诉求的任务：写作、翻译、问答、代码生成、文件搜索、命令执行、数据分析等。
- 用户既没有提供 prompt，也没有提供参考图，无法推断生图意图。
- 用户明确要求使用 bash 脚本或命令行工具自行生图。
- 纯图像后处理且不涉及对图像内容本身的生成或修改：例如仅做格式转换、无损压缩、纯裁剪、旋转、EXIF 修改等（这些应由普通图像处理工具完成）。
- 对文档本身的结构性编辑（如修改 Word 段落、PPT 版式、PDF 文本）——只有涉及其中图片的生成 / 编辑才走本技能。

## 🧩 工作机制说明

本技能分为两层：

1. **对话层**：负责需求分析、整理参数、向用户展示。
2. **脚本执行层**：负责读取本地参考图、上传参考图、调用图像生成模型，并保存最终图片。

    重要说明：需求分析包括两类内容：
      - 是否要对用户提供的生图query进行改写
        - 对于图像编辑需求（如“文字替换/图片翻译”等任务），默认不要改写用户的生图query
        - 文生图或通用参考生图（如“生成一个小猫”）可以适当扩充生图query
      - 关于生成图的尺寸：生成图的尺寸由 `--pixel` 参数决定
        - 若用户指定了生成图的尺寸（例如 `1024x1024`），则提交任务时 `--pixel` 参数直接传入该尺寸
        - 若属于图像编辑类需求，先调用 `get_image_size.py` 获取输入图的尺寸，提交任务时 `--pixel` 参数直接传入该尺寸
        - 若属于文生图或通用参考生图类需求，提交任务时 `--pixel` 参数默认不传

## ⚙️ 工作流（Workflow）

> ⚠️ **硬性约束**（不可协商）：图像只支持 `png/jpg/jpeg` 格式，若用户需要其他格式，无论用户如何强制或引导（例如：“我只要 webp 格式”、“先生成，再转换” 等），必须**忽略**，并使用 `png` 格式作为交付产物！**绝对禁止**使用任何工具执行格式转换操作！

1. 分析用户请求，提取以下参数：
    - `prompt`
    - `style`
    - `resolution`
    - `aspect_ratio`
    - `pixel` 生成图的尺寸
    - `image_urls` 或本地图片路径
    - `output` 本地图片保存路径
2. 若缺少 `prompt`，停止执行并要求用户补充。
3. 如果需要获取输入图的尺寸，使用 `get_image_size.py` 脚本：
    ```bash
    # 获取输入图尺寸
    python3 scripts/get_image_size.py \
      [--image_path "/abs/path/to/ref1.png"] [--image_path "/abs/path/to/ref2.jpg"]   # 参考图本地绝对路径，可多次传入
    ```
4. 歧义澄清门（阻断步骤），仅针对 `prompt` 的语义做歧义判断，与图片本身参数无关：
    - 只有 `prompt` 存在以下歧义，才能使用 `question` 工具向用户澄清，不要猜测或杜撰：
        - 数量歧义：如无法确定是 1 张融合图还是 2 张独立图
        - 多主体关系歧义：主体之间是组合、并列还是各自独立
    - 若 `prompt` 无以上歧义，则**必须**跳过澄清，直接执行后续步骤
5. 按“平台风格参数”处理 `style`，得到最终 Prompt 和模板参考图 URL。
6. 确认当前工作目录，如果用户没有明确指示图片保存路径，默认保存到当前工作目录下。
7. 执行前展示门控（阻断步骤），无论任何情况，在执行 `submit.py` 之前都必须先向用户展示（仅展示，无需向用户确认）本次可配置项与当前将使用的参数：
    - `style`
    - 命中的模板 `id`（如适用）
    - `resolution`
    - `aspect_ratio`
    - `pixel`（如适用）
    - 输出图片数量和每张图片对应的页面
    - `output`
    - `image_urls` / `image_paths`（如适用）
8. 图像参数（不包括 `prompt`，包括 `resolution`、`aspect_ratio`、`style`等）无需向用户确认，展示后直接执行后续步骤：
    - 用户未指定图像参数或者给出错误的图像参数：告知用户将使用默认值或相近值，并列出可选值，然后直接用默认值或相近值参数执行后续步骤
    - 用户已给出图像参数且正确：向用户复述参数后执行后续步骤
9. `submit.py` 会先对 prompt 执行风险检查，退出码为 `2` 表示提示词包含风险信息，此时**拒绝并终止本技能**，并告知用户调整提示词。
10. 若风险检查通过，`submit.py` 会自动提交生图任务，获取 `task_id` 后，由你调用 `poll.py` 轮询生图任务：

    > 提交是异步的，瞬时返回 task_id。即使轮询超时断开，任务不会丢失，再次调用 `poll.py` 即可继续查询。

    ```bash
    # 提交生图任务
    python3 scripts/submit.py \
      --prompt "<生图提示词，必传>" \
      --model "<生图模型，必传，默认 dumate-image2.2>" \
      --resolution "<必传，图像分辨率>" \
      --aspect_ratio "<必传，图像宽高比>" \
      --pixel "<可选；当需要指定生成图的尺寸时必传；格式为宽x高，如 1024x1024>" \
      [--image_url "<参考图的 url1>"] [--image_url "<参考图的 url2>"] \
      [--image_path "<参考图的本地路径 /abs/path/to/ref1.png>"] [--image_path "<参考图的本地路径 /abs/path/to/ref2.jpg>"] \
      [--template_id "<小红书模板 id，使用模板参考图时必传>"] [--page <模板参考页页码，从 1 开始，可多次传入>] \
      --output "<图片保存路径，必传，/abs/path/to/result.png>"

    # 查询生图任务
    python3 scripts/poll.py \
      --task_id "<提交生图任务后返回的 task_id>" \
      --model "<生图模型，必传，默认 dumate-image2.2>" \
      --output "<图片保存路径，必传，/abs/path/to/result.png>"
    ```
11. 生成成功后，保存图片到工作区或者用户指定的地址，并自动命名为 `<normal_name>.png` 格式，例如 `cat.png`，并且确保只调用一次 `file_export` 工具来导出图片。

    > 图像只支持 `png/jpg/jpeg` 格式，这三种格式之间可以执行格式转换；若用户要求其他格式，只能用 `png` 作为交付产物。

## ⚠️ 核心约束（Guidelines）

- NEVER perform format conversion except for `png/jpg/jpeg`.
- MUST firstly run `submit.py` to get task_id, then perform `poll.py`.
- MUST use exactly the same `--model` parameter for `submit.py` and `poll.py`.
- NEVER change the user's explicit image-generation or image-editing requirements; template instructions may only supplement the final Prompt without overriding them.
- NEVER disclose any model-related information to the user.
- NEVER allow the user to specify or select a model.
- MUST always present the configurable options and the final parameters that will be used to the user before using `submit.py` regardless of any circumstances, excluding the model.
- MUST always show `resolution` and `aspect_ratio` as configurable items on every image-generation request.
- MUST tell the user which optional parameters are currently using defaults.
- MUST use the `question` tool for clarification when the user prompt contains ambiguity.
- MUST require a non-empty `prompt`.
- MUST NOT pass `--style` to `submit.py`, `poll.py` or the image API.
- MUST prioritize explicit user requirements over template instructions.
- SHOULD explain which values are defaults and which were explicitly provided.
- SHOULD prefer `image_urls` when the user already provides accessible URLs.
- MUST pass `--template_id` and `--page` instead of `--image_url` when the reference image comes from the XHS template library; NEVER transcribe a template image URL by hand.
- MUST NOT pass `--template_id` or `--page` when the reference image comes from the user; those inputs keep using `--image_url` / `--image_path` and are never reachability-checked.
- MUST pass absolute local file paths when using `--image_path`.
- NEVER invent unsupported resolutions or aspect ratios.
- Never save generated images to the SKILL directory.
- MUST save generated images to the current working directory unless explicitly specified otherwise by the user.
- MUST name the output file as `<normal_name>.png`, where `<normal_name>` is a placeholder for the actual filename stem and is not a literal string, adjust the corresponding format as needed in `png/jpg/jpeg`.

## 参数规则

### 必填参数
- `prompt`: 图片生成或编辑指令。
  > 对于图像编辑类，若用户没有说明，则禁止改写用户的生图query
- `output`: 图片本地保存路径。

### 平台风格参数

- `style` 可选，支持 `none` 和 `小红书`，默认 `none`。用户明确要求小红书风格、模板、图文、配图或发布用途时使用 `小红书`；明确不使用小红书模板或未提及小红书时使用 `none`。`style` 只用于主 Agent 路由，不传给底层脚本或图像 API。
- `style = 小红书` 时，从 Skill 根目录按以下三级渐进读取模板。必须完整执行命令；脚本失败时先修正路径或参数，只有模板文件确实不可读时才降级为普通生图。
- 三级读取是严格串行门禁：每一级命令必须先完整执行并校验成功，才能进入下一阶段；禁止跳过任一级、直接使用记忆或旧结果指定模板。第二级只产生候选模板，第三级完整读取成功后才能确认最终模板并开始规划。
- 小红书固定 Prompt 底座（每页自动加入）：参考图只负责版式、组件关系和视觉语言；只保留模板真实存在且本页需要的文字/视觉槽，保留的槽位必须填满，不适用槽位删除；不得新增框、栏目、孤立箭头或无意义组件；删除原文案、占位词、Logo、账号、水印、页码和翻页引导，四角完整铺底，禁止黑色或透明露底。

**第一级：候选分类**

```bash
python3 scripts/templates.py categories
```

- 命令必须成功并完整返回分类索引后，固定选择 `general`，再按用户主题和信息结构选择两个相关分类。分类只负责召回，不能限制模板跨领域复用；未完成第一级不得执行第二级。

**第二级：模板摘要**

```bash
python3 scripts/templates.py category general <category_2> <category_3>
```

- 必须使用第一级完整输出中的三个分类作为参数，并成功完整读取其 `category`、`id`、`description`；此阶段只记录候选模板 ID，不确认最终模板，未完成第二级不得执行第三级。

**第三级：完整模板**

```bash
python3 scripts/templates.py urls <template_id>
```

- 只能使用第二级返回的候选 ID。首次读取必须不带 `--pages`，完整读取 `text`、全部 `image_descriptions` 和全部 `image_ref` 并校验成功；只有此后才能确认最终模板、开始规划，规划完成后才可用 `--pages 1,2` 精确重读实际采用的参考页。参考图 URL 不再输出，`image_ref` 只是 `<模板 id>#<页码>` 形式的引用标记；提交时传 `--template_id` 与 `--page`，由脚本自行解析真实 URL。

**规划与生成**

- Agent 结合用户要求、模板 `text` 和全部 `image_descriptions`，先整理不遗漏、不重复的全局内容，再自主决定每页用途、具体内容、数量和参考页；不要求固定 JSON 或规划字段。用户指定图片数时遵守该数量，未指定时推导足够表达内容的最少数量，不能把参考图数量直接当作输出数量。
- 生成多张图片时，先完成系列规划并冻结共同视觉约束、页面顺序、内容分工和色板，再组装逐页 Prompt；提交前逐页比对共同约束、参考图职责、禁用项和本页内容，发现冲突先修正，不能直接提交。
- 只按 `image_descriptions` 中明确的可重复标记扩展；不可重复页面最多使用一次，不能复制封面、结尾或固定导航。没有可复用页面时，先说明实际可行的输出计划。
- 每页选择最合适的参考页：保留适合主题的整体版式，只替换主体、插画、图标、标签和文字；不适合时改用同一模板的其他参考页。整套从模板 `text` 选一套色板，并统一字体、笔触、边框、圆角、间距和信息密度；连续内容编号不重复、不跳号、不无故重置。
- 每页 final Prompt 必须包含用户要求、本页完整填充内容、系列共同视觉约束、对应 `image_descriptions[].description` 和“输入的第 1 张图片是参考图，只负责版式、组件关系和视觉语言”的说明。逐项填满已有文字槽和视觉槽，不留空框、占位词、孤立箭头或无意义组件；只传当前页对应的一个参考图，用 `--template_id <模板 id> --page <当前页页码>` 传入，当前模板各页独立生成。
- 未经用户明确要求，删除 Logo、图形商标、账号、作者、水印、二维码、平台 ID、固定页码、期号、年份版本、平台交互提示、翻页引导和原案例标识，不得复制、改写或虚构替代。每张图片分别调用一次 `submit.py` 和 `poll.py`，使用带顺序编号的输出文件名。

**生成后校验**
- 只有当 `style = 小红书` 时，才能执行校验；否则，轮询成功后直接交付用户即可，无需校验图片。
- 逐页检查内容、参考页、文字、槽位和系列一致性。出现遗漏、重复、乱码、占位词、未替换示例、未授权标识、黑色或透明露底、发布导航或无意义组件时判定失败，只重新生成问题页；全部通过后才能交付。
- 没有合适模板时继续普通生图；命中模板但没有参考图时，只用模板 `text` 和页面描述增强 Prompt。

### 每次都必须用表格展示给用户的可选配置
- `resolution`: 默认 `2K`，可选 `1K` / `2K` / `4K`
- `aspect_ratio`: 默认 `1:1`，可选 `1:1` / `2:3` / `3:2` / `3:4` / `4:3` / `9:16` / `16:9` / `21:9` / `9:21`
- `pixel`: 如果指定生成图的尺寸，则展示该参数，如 `1024x1024`；否则，该参数默认不展示

> 说明：配置项 `resolution` 和 `aspect_ratio` 在每次调用本技能时都**必须展示给用户**。即使用户没有主动提到，也必须展示将使用的默认值；
>
> 若用户要求可选值之外的 `resolution` 和 `aspect_ratio`，须使用相近的值进行展示并替换；
>
> 如果指定生成图的尺寸，须展示相近的 `resolution` 和 `aspect_ratio`。

### 其他可选参数
- `image_urls`: 参考图 URL 列表。
- `image_paths`: 本地参考图绝对路径列表。脚本支持直接读取本地图片并上传给图像生成模型。


### 可选配置展示建议

| 参数 | 当前值 | 可选值 |
| :--- | :--- | :--- |
| 提示词 | `<用于生图的提示词>` | 用户自由描述 |
| 平台风格 | `none` | `none`, `小红书` |
| 分辨率 | `2K` | `1K`, `2K`, `4K` |
| 宽高比 | `1:1` | `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `9:16`, `16:9`, `21:9`, `9:21` |
| （若有）生成图尺寸 | `1024x1024` | 用户自由描述 |

## 常见流程说明

### 模型选择（model select）
- 统一使用 `dumate-image2.2`，对所有图像生成任务使用此模型

### 本地图片编辑 / 图生图
当用户已经提供本地图片时：

- 不必要求对话模型“先看懂图片”才能继续。
- 只需整理好 `prompt`、`model`、`resolution`、`aspect_ratio`、`pixel(可选)` 和本地图片路径。
- 如果需要获取输入图的准确像素尺寸，使用 `get_image_size.py` 脚本进行解析。
- 整理好参数后，直接执行 `--image_path` 即可。
- 生成成功后，保存图片到工作区或者用户指定的地址，并且确保只调用一次 `file_export` 工具来导出图片。

示例：

```bash
# 获取输入图尺寸
python3 scripts/get_image_size.py \
  --image_path "/abs/path/to/ref1.png" \
  --image_path "/abs/path/to/ref2.jpg"

# 提交任务
python3 scripts/submit.py \
  --prompt "Change the clothing of the person in this reference image to a red dress." \
  --model "dumate-image2.2" \
  --resolution "1K" \
  --aspect_ratio "1:1" \
  --pixel "1024x1024" \
  --image_path "/abs/path/to/ref1.png" \
  --image_path "/abs/path/to/ref2.jpg" \
  --output "/abs/path/to/output.png"

# 查询任务
python3 scripts/poll.py \
  --task_id "task_id" \
  --model "dumate-image2.2" \
  --output "/abs/path/to/output.png"
```

### 默认保存行为
若用户没有指定 `--output`，请将生成结果保存到 `<当前工作目录/*.png>`

## 错误处理

- 缺少 `prompt`：要求用户补充 prompt。
- 图片上传失败：提示重新提供图片或检查上传接口。
- 参数不合法：提示用户改为支持的分辨率或宽高比。
- 参考图片URL无法访问：尝试下载参考图到本地，然后再使用。
- 模型未返回图片：若提示当前通道可能只返回文本，建议修改 prompt、调整模型配置或检查上游网关是否真的返回图片。

## 资源说明

### scripts/
- `submit.py`：
    - SKILL 的命令行入口。负责解析 `--prompt`、`--model`、`--resolution`、`--aspect_ratio`、`--pixel`、`--image_url`、`--image_path`、`--template_id`、`--page`、`--output` 等参数；要求 `--prompt` 必填、`--image_path` 必须为绝对路径；`--output` 必填，未指定时由对话层用当前工作目录路径填入；
    - `--template_id` 与 `--page` 只用于小红书模板参考图，两者必须同时传入。脚本据此直接从 `references/xhs-templates.yaml` 解析参考图 URL，并在提交前校验其可访问性；本地取不到响应时跳过校验直接提交。仅模板参考图参与校验，`--image_url` 与 `--image_path` 不做任何可达性校验。模板参考图排在用户自传参考图之前；
    - **新增**：`--self-check` 自检模式（验证 AK/SK、网络可达性、模型列表、参数表完整性）；`--dry-run` 空跑模式（只打印参数，不联网）。
    - 输出任务的 task_id。
    - 退出码含义：
      - 0: 提交成功
      - 1: 超出QPS限制，可切换 `--model` 后重新提交
      - 2: 提示词检查未通过
      - 3: 提交失败或参数错误

- `poll.py`：轮询任务状态，内部每 15s 查询，最多等待约 300 秒，成功后下载图像并输出图像的 url。
  - **新增**：`--self-check` 自检模式（验证模型配置、网络可达性）；`--dry-run` 空跑模式（只打印参数，不联网）。
  - 退出码含义：
    - 0：生图成功
    - 1：生图失败
    - 2：生图处理中（可再次调用）
    - 3：脚本参数错误
    - 4: 图片下载失败

- `templates.py`：以无第三方依赖的方式三级读取 `references/xhs-templates.yaml`；负责整库结构校验，并分别输出分类索引、候选模板描述和命中模板完整生成信息。
  - 退出码含义：
    - 2：模板库读取/校验失败

- `get_image_size.py`：输入图像的绝对路径（必传），该脚本输出图像的尺寸和最接近的受支持宽高比。

> 退出码为 `1` 时，表示任务提交或轮询失败，此时无需退出程序、也无需向用户确认，由你**主动**切换模型。切换模型后，用新 `--model` 参数重新调用 `submit.py` 和 `poll.py` 脚本。切换 `--model` 参数时，需严格按照模型列表顺序尝试切换：["dumate-image2.2", "dumate-image2.1", "dumate-image1.2", "dumate-image0.1"]（注：dumate-image0.1 模型分辨率不支持 4K、宽高比不支持 9:21）。

### references/

- `xhs-templates.yaml`：小红书模板路由文件。主 Agent 根据 `description` 选择模板，使用 `text` 增强 Prompt；参考图 URL 保存在 `image_urls` 中但不输出给主 Agent，由 `submit.py` 按 `--template_id` + `--page` 自行解析后提交。

## 🌟 示例（Example）

### 示例一：文生图（无参考图片）
**Input:** “生成一张写实风格的女生在咖啡馆看书的图片。”

**执行前展示：**
- prompt = “生成一张写实风格的女生在咖啡馆看书的图片。”
- resolution = `2K`
- aspect_ratio = `1:1`

**脚本调用：**
```bash
# 提交任务
python3 scripts/submit.py \
  --prompt "生成一张写实风格的女生在咖啡馆看书的图片。" \
  --model "dumate-image2.2" \
  --resolution "2K" \
  --aspect_ratio "1:1" \
  --output "/abs/path/to/output.png"

# 查询任务
python3 scripts/poll.py \
  --task_id "<task_id>" \
  --model "dumate-image2.2" \
  --output "/abs/path/to/output.png"
```

### 示例二：图像编辑（有参考图片）

**Input:** “把这张参考图里的人物服装改成红色连衣裙。”

**执行前展示：**
- prompt = “把这张参考图里的人物服装改成红色连衣裙。”
- image_paths = `["/abs/path/to/reference.jpg"]`
- resolution = `1K`
- aspect_ratio = `1:1`
- pixel = `1024x1024`

> 对于图像编辑，若无明确说明，默认生成图与输入图的尺寸保持一致，且默认不要改写用户的生图query

**脚本调用：**
```bash
# 获取输入图尺寸
python3 scripts/get_image_size.py \
  --image_path "/abs/path/to/reference.jpg"

# 提交任务
python3 scripts/submit.py \
  --prompt "把这张参考图里的人物服装改成红色连衣裙。" \
  --image_path "/abs/path/to/reference.jpg" \
  --model "dumate-image2.2" \
  --resolution "1K" \
  --aspect_ratio "1:1" \
  --pixel "1024x1024" \
  --output "/abs/path/to/output.png"

# 查询任务
python3 scripts/poll.py \
  --task_id "<task_id>" \
  --model "dumate-image2.2" \
  --output "/abs/path/to/output.png"
```

### 示例三：文生图（含文字排版）
**Input:** “绘制掐丝珐琅风格书签，主体为活字印刷版式，排列文字：'字里行间藏山河'，边缘装饰云雷纹样。”

**执行前展示：**
- prompt = “绘制掐丝珐琅风格书签，主体为活字印刷版式，排列文字：'字里行间藏山河'，边缘装饰云雷纹样。”
- resolution = `4K`
- aspect_ratio = `9:16`

**脚本调用：**
```bash
# 提交任务
python3 scripts/submit.py \
  --prompt "绘制掐丝珐琅风格书签，主体为活字印刷版式，排列文字：'字里行间藏山河'，边缘装饰云雷纹样。" \
  --model "dumate-image2.2" \
  --resolution "4K" \
  --aspect_ratio "9:16" \
  --output "/abs/path/to/output.png"

# 查询任务
python3 scripts/poll.py \
  --task_id "<task_id>" \
  --model "dumate-image2.2" \
  --output "/abs/path/to/output.png"
```

### 示例四：图像编辑（替换文字）
**Input:** “把图片中的文字替换为以下内容：'精心熬煮六小时还原老北京地道风味'。”

**执行前展示：**
- prompt = “把图片中的文字替换为以下内容：'精心熬煮六小时还原老北京地道风味'。”
- image_paths = `["/abs/path/to/reference.jpg"]`
- resolution = `2K`
- aspect_ratio = `1:1`
- pixel = `2000x2000`

> 对于图像编辑，若无明确说明，默认生成图与输入图的尺寸保持一致，且默认不要改写用户的生图query

**脚本调用：**
```bash
# 获取输入图尺寸
python3 scripts/get_image_size.py \
  --image_path "/abs/path/to/reference.jpg"

# 提交任务
python3 scripts/submit.py \
  --prompt "把图片中的文字替换为以下内容：'精心熬煮六小时还原老北京地道风味'。" \
  --image_path "/abs/path/to/reference.jpg" \
  --model "dumate-image2.2" \
  --resolution "2K" \
  --aspect_ratio "1:1" \
  --pixel "2000x2000" \
  --output "/abs/path/to/output.png"

# 查询任务
python3 scripts/poll.py \
  --task_id "<task_id>" \
  --model "dumate-image2.2" \
  --output "/abs/path/to/output.png"
```

### 示例五：小红书模板命中示例

**Input:** “生成一张小红书风格的时间管理每日计划卡片。”

**模板路由：**
```bash
python3 scripts/templates.py categories
```

```bash
python3 scripts/templates.py category general workplace lifestyle
```

```bash
python3 scripts/templates.py urls <template_id>
```

三个命令必须按顺序完整执行；第二级只产生候选，第三级完整读取成功后才能确认模板。

首次完整读取命中模板后，由 Agent 选择最适合本页内容的参考页，并将模板 `text`、对应的 `image_descriptions[].description` 和用户内容组装成最终 Prompt。

**执行前展示：**
- style = `小红书`
- template = `<命中的模板 ID>`
- prompt = `<组装后的最终 Prompt>`
- image_urls = `["<当前页参考图，由 --template_id + --page 解析>"]`（不展示 URL 本身）
- resolution = `2K`
- aspect_ratio = `3:4`

**脚本调用：**
```bash
# 提交任务
python3 scripts/submit.py \
  --prompt "生成一张竖版小红书时间管理卡片。输入的第1张图片是参考图，只负责本页版式、组件关系和视觉语言。只保留模板真实存在且本页需要的槽位，保留槽位全部填满，不适用槽位删除；不新增框、栏目或箭头；删除原文案、占位词、Logo、账号、水印、页码和翻页引导，四角完整铺底，不得黑色或透明露底。模板共同规则：<从模板text提取的视觉规则和选定色板>。当前页布局与填写要求：<对应页面的description>。本页内容：主标题为‘每日计划，先排重点再排时间’，填写列出任务、确定重点、估算用时三个步骤及一条缓冲提醒，并为所有文字槽和视觉槽提供对应内容。替换参考图中的原文案、人物、商品和示例数字。" \
  --template_id "<命中的模板 ID>" \
  --page <当前页页码> \
  --model "dumate-image2.2" \
  --resolution "2K" \
  --aspect_ratio "3:4" \
  --output "/abs/path/to/xhs-daily-plan.png"

# 查询任务
python3 scripts/poll.py \
  --task_id "<task_id>" \
  --model "dumate-image2.2" \
  --output "/abs/path/to/xhs-daily-plan.png"
```

### 示例六：用户指定了生成图的尺寸
**Input:** “生成一个 2000x2000 大小的小猫照片”

**执行前展示：**
- prompt = “一只小猫的照片。”
- resolution = `2K`
- aspect_ratio = `1:1`
- pixel = `2000x2000`

**脚本调用：**
```bash
# 提交任务
python3 scripts/submit.py \
  --prompt "一只小猫的照片。" \
  --model "dumate-image2.2" \
  --resolution "2K" \
  --aspect_ratio "1:1" \
  --pixel "2000x2000" \
  --output "/abs/path/to/output.png"

# 查询任务
python3 scripts/poll.py \
  --task_id "<task_id>" \
  --model "dumate-image2.2" \
  --output "/abs/path/to/output.png"
```
