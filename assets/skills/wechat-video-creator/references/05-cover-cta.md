# Step 12：封面 + 发布物料 + 片尾 CTA

> 对应 SKILL.md 步骤索引 12。

## 封面（不可跳过，文字叠加是硬性要求）

1. 用 AI 生成竖屏背景图（精确 1080×1920）
2. **必须叠加标题文字**（主标题 + 副标 + 品牌名），用 `scripts/cover_overlay.py`
3. 叠加参数：
   - 主标题：≤16 字，110px，顶部 1/3 主视觉区
   - 副标：项目/系列名，52px，主标题下方
   - 品牌：右下角小字，36px
   - 深色渐变蒙版（底部→中部 `#060d18`→透明）保证清晰；文字阴影（offset 3px `#000000a0`）
4. **禁止直接用纯背景图作发布封面**
5. 输出 PNG（质量 95）

> 在 `video-assets/` 目录内执行（命令引用的 `composition/assets/img/cover.png` 为相对路径）。最终封面**输出到 `video-assets/封面.png`**，与 `视频号发布物料.md` 同目录——**禁止**写 `composition/封面.png`。

```bash
# 当前目录 = video-assets/
python3 scripts/cover_overlay.py \
  --bg composition/assets/img/cover.png \
  --title "主标题\n可选第二行" \
  --subtitle "零成本基建系列" \
  --brand "围炉聊科技" \
  --output "封面.png"
```
> 副标/品牌为该系列固定文案（围炉聊科技公众号「零成本基建系列」）。若换系列，改 `--subtitle` / `--brand` 即可；CTA 口播/字幕文案见下方，可经 `config/cta_config.json` 调整。

**短标题**（≤16 字，按字符计：汉字/字母/数字/标点各 1 字；英文按字母拆，`AI`=2、`Playwright`=10）：
- 优先与文章同名或核心关键词同名（利于搜索承接）；备选：痛点+数字 / 结论式 / 提问式
- **符号白名单（硬性）**：视频号标题字段仅支持 `《》`、`“”`、`：`、`+`、`？`、`%`、`℃` 这几类符号；其余标点一律不可用——**逗号（，,）、顿号（、）、破折号（——）、括号、斜杠、句号、感叹号、连字符等都会被平台拒收或吞字**。需要停顿时，**逗号直接用空格代替**（如「一上午几十行 两周一个编译器」而非「一上午几十行，两周一个编译器」）。
- 该白名单只约束**发布时填的标题字段**，不约束封面图上的文字（封面由 `cover_overlay.py` 渲染成位图，任何字符都能画）。写脚本字幕/画面标题时若已用了逗号，发布短标题须单独换掉。

**封面主标题超长预警**（与上面的平台限制无关）：连续字母 >12（如 `PlaywrightTest`=14）在 110px 下首行大概率截断，改短中文或强制换行。

## 视频描述结构

1. 开头钩子（痛点/反常识，1–2 句）
2. 干货速记（3–5 点）
3. 互动提问（1 句）
4. 话题标签（8 个，如 `#AI大模型` `#免费API`）

写入 `video-assets/视频号发布物料.md`（与 `封面.png`、`output.mp4` 同目录），末尾含发布清单（短标题已填 / **短标题符号合规——仅含白名单符号，逗号已换成空格** / 描述已粘贴 / 封面已上传 / 首屏文字可见）。

## 片尾关注引导（CTA，固定模板）

所有视频默认末尾附固定 CTA 画面+配音，提升公众号/视频号关注转化。

**内容**：
- **口播**（实际时长以 `cta_tail.mp3` 的 `ffprobe` 为准，当前约 6.77s）："详细内容我整理成了文章，点我头像进主页，关注公众号【围炉聊科技】就能看到。"
- **画面字幕**："主页关注公众号「围炉聊科技」看完整版"

**使用方式**：
1. **音频拼接**：主口播 `narration.mp3` + CTA `cta_tail.mp3` → `narration_v2.mp3`
2. **模板强制复用**：`audio_post_process.py` 拼接前检查 `cta_tail.mp3` 存在性——存在则强制复用，禁止重调 Inworld；不存在先用 `inworld_tts.py` 生成放置
3. **HTML 模板**：`templates/composition.html` 内置 F9（`scene-09`），`MAIN_DURATION` / `CTA_DURATION` 由 `fill_template.py` 从 `segments.json` 自动填充
4. **关闭 CTA**：`config/cta_config.json` 设 `"enabled": false`，或生成 `segments.json` 时 `cta_duration = 0`

**重录版本规范**：
- 每次重渲染必须生成 `-vN` 新文件（如 `-v2.mp4`），禁止覆盖旧版
- 重录前环境清理：按 PID 精确 `taskkill /F /PID <占用19222进程>` + `rm frames/*` + `curl http://127.0.0.1:19222/json` 端口检测（不全杀 msedge）

**产物位置**：CTA 配音——技能自带模板在技能包 `assets/audio/cta_tail.mp3`，文章运行时副本在 `composition/assets/audio/cta_tail.mp3`（渲染前须手动复制一次，无脚本代劳；详见 SKILL.md「依赖与环境」）；CTA 配置 `config/cta_config.json`。
