# Step 6–7：生成场景素材图 / 复用文章真实截图

> 对应 SKILL.md 步骤索引 6–7。

## Step 6：生成竖屏场景素材图（baidu-image-gen）

调用 `baidu-image-gen` 生成场景配图：
- `aspect_ratio`: `9:16`；`pixel`: `1080x1920`（百度千帆自动校正为 1072×1920，正常）；`resolution`: `2K`；`style`: `none`

**运行时探测与自动路由（执行前并行探测，二选一生效）**：
```bash
python3 skills/baidu-image-gen/scripts/submit.py --self-check --dry-run
python3 skills/cover-image-gen/scripts/generate_image.py --self-check --dry-run
```
- 双链路均通：按场景类型选最优（编辑类→百度，纯文生图→任一）
- 仅百度通：强制百度，禁用 fallback
- 仅 MS/Agnes 通：**仅纯文生图可用**；编辑类直接报错
- 双不通：报错并给配置指引

**Fallback 能力校验门（阻断）**：若场景需图生图/局部重绘/扩图/超分/参考图编辑且 `baidu-image-gen` 不可用 → 直接报错停止，提示配置百度千帆或简化场景为纯文生图；仅纯文生图才静默切 `cover-image-gen`。

**判定为不可用（满足其一即切，切换前同场景最多重试一次）**：技能缺失且 `dumate-find-skill` 无法装；`submit.py` 退出码 2（提示词风险，用户改措辞仍不过）；按模型列表切 `--model` 后仍退出码 1；轮询超时/下载失败重试仍失败。

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
