# Step 6–7：生成场景素材图 / 复用文章真实截图

> 对应 SKILL.md 步骤索引 6–7。

## Step 6：生成竖屏场景素材图（cover-image-gen）

调用 `cover-image-gen` 生成场景配图（仅纯文生图；图生图/编辑/超分/扩图/局部重绘当前不支持）：
- `aspect_ratio`: `9:16`；`resolution`: `2K`（ModelScope 映射为 1280×720 后由平台按 9:16 重算；Agnes 2K/9:16 → 1440×2560）

**运行时探测（执行前确认）**：
```bash
python3 skills/cover-image-gen/scripts/generate_image.py --self-check
```
- 通过：进入下方生图流程
- 不通过：报错并提示配置 `MODELSCOPE_API_KEY` 或 `AGNES_API_KEY`，不降级其他方案

**能力边界（硬约束）**：场景需要图生图/局部重绘/扩图/超分/参考图编辑时，**不要试图用 `cover-image-gen` 模拟**——直接走以下任一路径：
1. 复用文章真实截图（实操/产品/教程类必做，详见 Step 7）
2. 简化场景为纯文生图（重新设计画面主体）
3. 用 HTML/CSS 渐变背景 + 文字排版替代图片

**cover-image-gen 用法**（遵循其两阶段门禁：提示词先展示确认再生图，结果先展示不自动进后续）：
```bash
python3 skills/cover-image-gen/scripts/generate_image.py \
  --provider modelscope --prompt "<确认后提示词>" --resolution "2K" --aspect_ratio "9:16" \
  --output composition/assets/img/scene-02.png
# 或 --provider agnes（同步 b64）
```
需 `MODELSCOPE_API_KEY` 或 `AGNES_API_KEY`；均缺失报错交用户补，不降级其他方案。命名沿用 `composition/assets/img/scene-NN.png`（含 `cover.png`）。

**画面设计原则**：每场景 1 张，约 5–8 张（含封面）；图面文字只放核心标题/标签（2–4 字）；避免右侧/底部放重要元素（被字幕/警告条遮挡）；统一深蓝黑 `#0a0f1a`–`#060d18`。

**硬约束：禁止横向截图直接全屏铺底**——必须竖屏重构：局部放大+高斯虚化 / 上下留白遮罩 / 降透明度+网格线。模板 `.bg-img.is-landscape-reworked` 已内置。

## Step 7：提取并复用文章真实截图（实操/产品/教程类必做）

> ⚠️ **owner 硬性要求（覆盖 Step 6 默认全 AI 配图）**：源文章正文含产品界面/后台/账单/API 文档/代码/数据看板等真实截图（`![](...)` 或 `<img>` 引用本地图）→ 属实操/产品/教程类，**必须复用文章真实截图**作中间区域展示，不得用 AI 抽象配图替代。仅纯观点/盘点/行业观察类（无真实截图）才允许全 AI 抽象图。跳过真实截图视为成片缺陷（同"1.0x 未调速"级）。

**文章类型判定（Step 1 读取时即做）**：扫描源 `.md` 本地图片引用。有→实操/产品类走本步；无→纯观点类跳 Step 8。

**提取流程**：
1. 收集每张截图路径 + 原文语境，形成清单
2. 复制到 `composition/assets/img/screens/`（如 `screens/inworld-pricing.png`）
3. 横向截图必须竖屏重构（包 `.bg-img.is-landscape-reworked` 或 `.ss-side` 上下留白；或入库前裁 9:16）
4. 在 `customize.py` 的 `SCENES` 用截图构造函数替换对应场景内容区（`<!-- 场景内容 -->`），嵌真实截图到成片中间区域

**截图构造函数（`templates/customize.py`，已内置）**：
```python
screenshot(img_path, caption="", style="", max_height=None)            # 单张，img_path 相对 composition/
screenshot_compare(left_img, right_img, left_cap="", right_cap="")      # 并排对比，每张 max-height 480px
screenshot_stack(images, captions=None)                                # 垂直堆叠，硬上限 3 张
```
- `style` 可选 `'is-dark-bg'`（深底截图）/ `'is-highlight'`（高亮边框）
- 调用示例：`"scene-04": ("产品定价 <em>截图</em>", screenshot_compare("assets/img/screens/inworld-pricing.png", "assets/img/screens/inworld-billing.png", "定价页", "账单页"))`
- `customize.py` 现已幂等：重跑自动从 `index.html.orig` 重建，无需先手动 `fill_template.py`（详见 `references/04-html-render-ffmpeg.md` Step 9）

**与 Step 6 关系**：实操/产品类**背景**仍可用 AI 抽象图（`.bg-img` 保系列感），但**中间内容区必须出现真实截图**；纯观点类整屏 AI 抽象图即可。
