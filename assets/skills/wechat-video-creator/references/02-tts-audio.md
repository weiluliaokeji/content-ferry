# Step 4–5：克隆配音（Inworld TTS）/ 分段处理与 stutter 检测

> 对应 SKILL.md 步骤索引 4–5。调速规则（一律 1.3x、1.0x 视为缺陷）以 SKILL.md 真值表为准。

## Step 4：生成克隆配音（Inworld TTS）

**音色管理**：
- **克隆只需一次**：`POST https://api.inworld.ai/voices/v1/voices:clone` 返回的 `voiceId`（如 `balmy-topaz-3458_adams_zh`）永久有效；后续直接复用 `POST https://api.inworld.ai/tts/v1/voice`，无需重新克隆。
- `voiceId` 与 API key **数组**持久化于本地 `config/voice_cache.json`；仓库只提供 `config/voice_cache.example.json`，真实凭据不要随技能目录迁移、不要提交 Git。legacy 单 key 格式由 `voice_manager.py` 自动迁移为数组。

**多 API Key 配置与自动切换**：
- 返回 `429/403/401/billing/quota/rate limit/limit exceeded/unauthorized/forbidden` 时，`inworld_tts.py` 标记该 key `failed` 并尝试下一个 `active` key。
- 所有 key 耗尽直接报错退出，**不降级到其他 TTS**（用户明确禁止）。
- 瞬态网络错误（`ssl`/`eof`/`timeout`/`connection`/`urlopen error`/`incompleteread`）不切 key：对当前 key 重试 1 次后再失败才视为该 key 失败。
- **轮询结果记 `assets/audio/key_rotation.log`**（由 `inworld_tts.py` 写在输出 MP3 同级目录）。

**调速调用（推荐写法，CWD = `video-assets/`）**：
```bash
python3 <skill>/scripts/audio_post_process.py \
  composition/assets/audio/narration_raw.mp3 \
  --output composition/assets/audio/narration.mp3 \
  --segments composition/segments.json \
  --log composition/assets/audio/speed_adjustment.log
```
> **`--output` 不能省**：脚本只在「`--output` 与入参不同」时把拼接了 CTA 的版本回写为 `narration.mp3`。省略 `--output` 时 `narration.mp3` 仍是纯主配音，拼接版另存为 `narration_v2.mp3`——那样 Step 11 的 ffmpeg 必须改用 `narration_v2.mp3`，否则 `-shortest` 会裁掉 CTA 画面（详见 `references/04-html-render-ffmpeg.md` Step 11）。

**配音流程**：
1. **先把口播正文落盘**：写入 `composition/_tts.txt`（TTS 原始口播文本，产物契约要求保留；无脚本代劳，必须显式写这一步，否则该文件会缺失或位置随意）
2. 从 `config/voice_cache.json` 读 key + `voiceId`
3. 调合成接口：`python3 <skill>/scripts/inworld_tts.py --text-file composition/_tts.txt --output composition/assets/audio/narration_raw.mp3`
   - **长中文口播一律用 `--text-file`**（`--text` / `--text-file` 二选一必填）。不要用 `--text "$(cat _tts.txt)"`：那是 bash 语法，PowerShell 下失效，且文案含引号/换行时转义必炸
   - 鉴权 `Authorization: Basic <base64(API_KEY:)>`（注意非 Bearer，key 后接冒号再 base64）
4. 后处理：faster-whisper 转写取逐句时间戳 → `segments.json`；尾部含平台声明则用 ffmpeg 裁切（裁前用 whisper 确认最后一句结束时间，不切断口播）

**首次克隆（仅一次）**：`voice_cache.json` 无 `voiceId` 时调 clone 接口，传参考音频（先 ffmpeg 转单声道 24kHz wav），记录 `voiceId`。

## Step 4 配音时长自动调速（owner 硬性）

- 主配音（不含 CTA）原始 78–168s；默认 1.3x 提速后约 60–129s，含 CTA 后总目标 67–136s。
- `audio_post_process.py` 检测主配音时长，**调速倍率固定为 `--speed`（默认 1.3）**，不是自动向区间中点靠拢：
  - >168s：标红 `exit(2)` 阻断，必须精简脚本（>300 字触发 Step 2.5 拦截）
  - 提速后仍 >168s：同样 `exit(2)`，禁止靠加大倍速蒙混
  - 78–168s：**一律** 1.3x `atempo`（允许 1.2–1.7x 微调，不得低至 1.0x）
  - <78s：**仍按 1.3x 提速**（1.0x 是缺陷，不可交付）；仅当提速后 <60s 才警告扩充脚本
  - 压缩后 `update_segments` 把 `segments.json` 时间戳统一乘 `1/speed_ratio`（无需重 whisper），记音频同级的 `speed_adjustment.log`
  - `--speed` > `--speed-cap`（默认 1.7）时 `exit(2)`：音质红线，超则回退精简脚本，禁止硬压

## Step 5：分段处理与 stutter 检测

**核心：分段驱动，禁止硬编码时间。**

1. `segment_processor.py`：读 `SCRIPT.md` 的 `## F数字` 按段切分；faster-whisper 转写完整配音取逐句时间戳；按段文本匹配 whisper segments 算每段真实 start/end/duration；输出 `segments.json`（含 `main_duration` / `cta_duration` / `speed_ratio` / `segments[]`）。
2. **stutter 检测**：比对相邻 whisper 转写文本（`difflib.SequenceMatcher > 0.8`）。真实 stutter 是脚本不重复但音频播两遍，故比对转写文本而非脚本原文；检出重复记 `issues[]`，建议 ffmpeg `atrim` 切除。
3. `segments.json` 是后续所有时间参数的**唯一真实来源**：场景 `data-start`/`data-duration`、GSAP 切换点、字幕 capIn/capOut、总时长。
