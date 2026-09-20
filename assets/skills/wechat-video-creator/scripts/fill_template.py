#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Template filler: 读取 segments.json，填充 composition.html 中的占位符。

用法:
    python fill_template.py <segments.json> <templates/composition.html> <output/index.html>

占位符规则（在模板中以 {{KEY}} 形式出现）:
    {{SCENE_N_START}}      → segments[N-1].start
    {{SCENE_N_DURATION}}   → segments[N-1].duration
    {{SCENE_N_END}}        → segments[N-1].end
    {{MAIN_DURATION}}        → main_duration
    {{CTA_DURATION}}         → cta_duration (default 6.77)
    {{TOTAL_DURATION}}       → total_duration
    {{ENABLE_CTA}}           → true/false based on cta_duration > 0
    {{CAPTION_N}}            → segment text (smart_truncate, 句末断句, 上限 28 字 = 单行字幕防重叠)
    {{CAP_N_IN}}             → segment start + 0.3s
    {{CAP_N_OUT}}            → segment end - 0.3s

同时同步更新 HTML 中 section 的 data-start / data-duration 属性。
未使用的场景占位符自动替换为 0，对应 HTML section 自动隐藏（display:none）。
"""

import json, re, os, argparse


def load_segments(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def smart_truncate(text, limit=120):
    """字幕文本截断：优先在句末（。！？；）断句，其次在句中停顿（，、）

    处保留完整语义；仅在超过 limit 且无合适断句点时硬截断并加省略号。
    直接 [:80] 硬截会切断句子、丢失标点，造成字幕与口播不一致。
    """
    text = (text or "").strip()
    if not text or len(text) <= limit:
        return text
    head = text[:limit]
    # 句末断点（最靠近 limit 的优先）
    for cut in ("。", "！", "？", "；"):
        idx = head.rfind(cut)
        if idx >= int(limit * 0.5):
            return text[: idx + 1]
    # 句中停顿断点（同样为省略号留 2 码位）
    for cut in ("，", "、", "："):
        idx = head.rfind(cut)
        if idx >= int(limit * 0.5):
            return text[: min(idx, limit - 2)] + "……"
    # 硬截断留 2 码位给省略号（……占 2 码位），保证返回值恒 ≤ limit
    return text[: limit - 2] + "……"


def fill_template(template_path, output_path, segments_data):
    with open(template_path, "r", encoding="utf-8") as f:
        text = f.read()

    segs = segments_data.get("segments", [])
    main_dur = segments_data.get("main_duration", 0)
    cta_dur = segments_data.get("cta_duration", 6.77)
    total_dur = segments_data.get("total_duration", main_dur + cta_dur)

    # ── 1. 构建 replacements 字典 ──
    # 动态探测模板可渲染的场景容量（从模板占位符推断，而非硬编码 8）
    scene_nums = [int(x) for x in re.findall(r"\{\{SCENE_(\d+)_START\}\}", text)]
    template_scenes = max(scene_nums) if scene_nums else 8

    replacements = {
        "{{MAIN_DURATION}}": str(round(main_dur, 3)),
        "{{CTA_DURATION}}": str(round(cta_dur, 3)),
        "{{TOTAL_DURATION}}": str(round(total_dur, 3)),
        "{{ENABLE_CTA}}": "true" if cta_dur > 0 else "false",
    }

    # 场景占位符（用 % 格式化，避免 f-string 大括号转义 bug）
    for i, seg in enumerate(segs, start=1):
        replacements["{{SCENE_%d_START}}" % i] = str(round(seg.get("start", 0), 3))
        replacements["{{SCENE_%d_DURATION}}" % i] = str(
            round(seg.get("duration", 0), 3)
        )
        replacements["{{SCENE_%d_END}}" % i] = str(round(seg.get("end", 0), 3))

    # 字幕占位符（每场景 1 条，单行 ≤ 28 字防重叠，与模板 cap-01..cap-NN 对应；
    # cap-09 CTA 引导字幕由 composition.html 模板硬编码，不由本脚本注入）
    empty_captions = []
    for i in range(1, template_scenes + 1):
        if i <= len(segs):
            seg = segs[i - 1]
            raw_text = (seg.get("text") or "").strip()
            cap_text = smart_truncate(raw_text, 28)
            if cap_text != raw_text:
                print(
                    "[fill_template] WARN: cap-%02d 已截断为 %d 字（原文 %d 字），"
                    "字幕与口播不一致；请在口播脚本中把该段拆短，而不是放宽字幕上限"
                    % (i, len(cap_text), len(raw_text))
                )
            cap_in = round(seg.get("start", 0) + 0.3, 3)
            cap_out = round(seg.get("end", 0) - 0.3, 3)
        else:
            cap_text = ""
            cap_in = 0
            cap_out = 0
        replacements["{{CAPTION_%d}}" % i] = cap_text
        replacements["{{CAP_%d_IN}}" % i] = str(cap_in)
        replacements["{{CAP_%d_OUT}}" % i] = str(cap_out)
        if not cap_text:
            empty_captions.append(i)

    # ── 2. 执行替换 ──
    for placeholder, value in replacements.items():
        text = text.replace(placeholder, value)

    # ── 3. 清理未匹配的占位符（兜底） ──
    def default_replacer(m):
        key = m.group(1)
        if key.startswith("SCENE_"):
            return "0"  # 数值型默认值
        elif key.startswith("CAPTION_"):
            return ""  # 字符串型默认值
        elif key.startswith("CAP_"):
            return "0"  # 数值型默认值
        return m.group(0)  # 未知占位符保留原样

    text = re.sub(r"\{\{([A-Z_0-9]+)\}\}", default_replacer, text)

    # ── 4a. 删除空字幕的 capIn/capOut 注册，避免无意义 tween ──
    if empty_captions:
        for ci in empty_captions:
            text = re.sub(
                r"\s*capIn\(\"cap-%02d\"[^)]*\);\s*capOut\(\"cap-%02d\"[^)]*\);"
                % (ci, ci),
                "",
                text,
            )
        print(
            "[fill_template] INFO: skipped %d empty caption tween(s): cap-%s"
            % (len(empty_captions), ", cap-".join("%02d" % c for c in empty_captions))
        )

    # ── 5. 段落数超过模板容量时的处理 ──
    if len(segs) > template_scenes:
        dropped = [s.get("label", s.get("id", "?")) for s in segs[template_scenes:]]
        print(
            "[fill_template] WARN: %d segments > %d template scenes;"
            " the following %d scene(s) are DROPPED (no lyrics/timeline slot): %s"
            "\n    Consider extending composition.html with scene-%02d.. or"
            " merging paragraphs."
            % (
                len(segs),
                template_scenes,
                len(segs) - template_scenes,
                ", ".join(str(d) for d in dropped),
                template_scenes + 1,
            )
        )

    # ── 5. 隐藏未使用的 HTML section ──
    for n in range(min(len(segs), template_scenes) + 1, template_scenes + 1):
        sid = "scene-0%d" % n if n < 10 else "scene-%d" % n
        text = text.replace('id="%s"' % sid, 'id="%s" style="display:none"' % sid)

    # ── 6. 同步更新 HTML section 的 data-start / data-duration ──
    def repl_section_attr(m):
        attrs = m.group(1)
        sid_match = re.search(r'id="(scene-\d+)"', attrs)
        if sid_match:
            sid = sid_match.group(1)
            idx = int(sid.split("-")[-1]) - 1
            if 0 <= idx < len(segs):
                s = segs[idx]
                attrs = re.sub(
                    r'data-start="[^"]*"', 'data-start="%.3f"' % s["start"], attrs
                )
                attrs = re.sub(
                    r'data-duration="[^"]*"',
                    'data-duration="%.3f"' % s["duration"],
                    attrs,
                )
        return "<section%s>" % attrs

    text = re.sub(r"<section(\s+[^>]*)>", repl_section_attr, text)

    out_dir = os.path.dirname(output_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(text)

    print(
        "[fill_template] Wrote %s (%d replacements, %d segments)"
        % (output_path, len(replacements), len(segs))
    )


def main():
    parser = argparse.ArgumentParser(
        description="Fill composition.html from segments.json"
    )
    parser.add_argument("segments", help="Path to segments.json")
    parser.add_argument("template", help="Path to composition.html template")
    parser.add_argument("output", help="Path to output index.html")
    args = parser.parse_args()

    data = load_segments(args.segments)
    fill_template(args.template, args.output, data)


if __name__ == "__main__":
    main()
