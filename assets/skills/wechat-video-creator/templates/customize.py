#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""【模板文件】把 composition.html 的演示文案替换为本文实际内容。

用法：
    1. 复制本文件到 composition/ 目录（与 index.html 同级）
    2. 先跑 fill_template.py 生成 index.html，再按本文改 SCENES / CHROME
    3. 在 composition/ 内运行：python customize.py

背景：
    fill_template.py 只填充**时间/字幕**占位符（{{SCENE_N_START}} 等），
    不会替换模板里的演示文案。模板自带的标题与内容区都是占位符
    （“标题”“观点 N 高亮”“选型 矩阵”“总结 高亮” + <!-- 场景内容 --> + chrome 的 TAG）。
    不跑本脚本，成片会在每个场景顶部显示这些占位文字。

注意：本脚本已幂等——首次运行会备份 `index.html` 为 `index.html.orig`，
      后续重跑自动从 `.orig` 重建占位符再应用 SCENES，无需先手动 fill_template.py。
      前提：先跑一次 fill_template.py 生成含时间/字幕占位符的 index.html（.orig 即其快照）。
"""

import re, pathlib

H = pathlib.Path(__file__).parent / "index.html"

# ── 内容构造函数（对应模板 CSS：.steps / .tag-row / .matrix / .warn-bar） ──


def steps(items):
    """编号列表：items = [(标题, 说明), ...]，硬性上限 4 条，单条 desc ≤ 12 字。
    超出会被 .scene-inner 的 overflow:hidden 裁切，必须精简文案而非放宽 CSS。"""
    lis = "".join(
        '<li><span class="idx">%02d</span><div><b>%s</b><span class="desc">%s</span></div></li>'
        % (i, t, d)
        for i, (t, d) in enumerate(items, 1)
    )
    return '<ul class="steps">%s</ul>' % lis


def tags(items):
    """标签行：items = [(文字, 是否高亮), ...]。"""
    spans = "".join(
        '<span class="tag%s">%s</span>' % (" is-accent" if a else "", t)
        for t, a in items
    )
    return '<div class="tag-row">%s</div>' % spans


def matrix(headers, rows):
    """选型矩阵：1 个维度列 + 4 个对比列（CSS 固定 repeat(4, 1fr)）。
    headers = 4 个对比对象名；rows = [(维度名, [4 个单元格]), ...]。
    硬性上限 4 行，超出会被 overflow:hidden 裁切，必须精简文案。"""
    cells = ['<div class="m-head">维度</div>']
    cells += ['<div class="m-head">%s</div>' % h for h in headers]
    for label, vals in rows:
        cells.append('<div class="m-label">%s</div>' % label)
        cells.extend('<div class="m-cell">%s</div>' % v for v in vals)
    return '<div class="matrix" data-gsap="t7Matrix">%s</div>' % "".join(cells)


def screenshot(img_path, caption="", style="", max_height=None):
    """中间区域单图展示（非背景）：img_path 相对于 composition/ 的路径。
    caption = 图片下方简短标注（不是字幕，字幕仍是 .caption 贴底）。
    style = 额外 CSS 类，可选 'is-dark-bg' / 'is-highlight'。
    max_height = 可选像素上限（如 480），以内联 style 设在 <img> 上，避免外部字符串替换。"""
    cls = "screenshot %s" % style.strip() if style else "screenshot"
    cap = '<p class="caption-note">%s</p>' % caption if caption else ""
    inline = ' style="max-height:%dpx"' % max_height if max_height else ""
    return '<img class="%s" src="%s" alt="%s"%s>%s' % (cls, img_path, caption, inline, cap)


def screenshot_compare(left_img, right_img, left_cap="", right_cap=""):
    """两张截图并排对比（before/after 或两个界面）。
    每张图 max-height: 480px，总宽度不超过 scene-inner。"""
    return (
        '<div class="ss-compare">'
        '<div class="ss-side">%s<p class="caption-note">%s</p></div>'
        '<div class="ss-divider"></div>'
        '<div class="ss-side">%s<p class="caption-note">%s</p></div>'
        '</div>'
    ) % (
        screenshot(left_img, max_height=480),
        left_cap,
        screenshot(right_img, max_height=480),
        right_cap,
    )


def screenshot_stack(images, captions=None):
    """多张截图垂直堆叠展示（适合步骤流程）。
    images = [路径, ...]；captions = [标注, ...]，与 images 一一对应。
    硬性上限 3 张，超出请拆分场景。"""
    caps = captions or []
    items = []
    for i, path in enumerate(images[:3]):
        cap = caps[i] if i < len(caps) else ""
        img = screenshot(path, max_height=340)
        items.append(img + ('<p class="caption-note">%s</p>' % cap if cap else ""))
    return '<div class="ss-stack">%s</div>' % "".join(items)


# ── 每个场景的（标题, 内容区）──────────────────────────────────────────────
# 标题里用 <em>…</em> 标记高亮词（渲染为主题绿色 accent）。
# 场景数与模板一致（模板当前为 8 主场景；多出的场景会被 fill_template 隐藏）。
SCENES = {
    "scene-01": (
        "一句话钩子 <em>高亮词</em>",
        tags(
            [("要点 A", True), ("要点 B", True), ("要点 C", False), ("要点 D", False)]
        ),
    ),
    "scene-02": (
        "免责 / 前提 <em>高亮</em>",
        '<div class="warn-bar"><span>这里放提醒，<b>关键约束加粗</b>，其余正常说明。</span></div>',
    ),
    "scene-03": (
        "对象一 <em>名称</em>",
        steps([("指标 1", "说明 1"), ("指标 2", "说明 2"), ("指标 3", "说明 3")]),
    ),
    "scene-04": (
        "对象二 <em>名称</em>",
        steps([("指标 1", "说明 1"), ("指标 2", "说明 2"), ("指标 3", "说明 3")]),
    ),
    "scene-05": (
        "对象三 <em>名称</em>",
        steps([("指标 1", "说明 1"), ("指标 2", "说明 2"), ("指标 3", "说明 3")]),
    ),
    "scene-06": (
        "对象四 <em>名称</em>",
        steps([("指标 1", "说明 1"), ("指标 2", "说明 2"), ("指标 3", "说明 3")]),
    ),
    "scene-07": (
        "横向 <em>对比</em>",
        matrix(
            ["对象 A", "对象 B", "对象 C", "对象 D"],
            [
                ("维度 1", ["值", "值", "值", "值"]),
                ("维度 2", ["值", "值", "值", "值"]),
                ("维度 3", ["值", "值", "值", "值"]),
                ("推荐场景", ["…", "…", "…", "…"]),
            ],
        ),
    ),
    "scene-08": (
        "怎么选 <em>按场景</em>",
        steps(
            [
                ("场景 1", "选 X"),
                ("场景 2", "选 Y"),
                ("场景 3", "选 Z"),
                ("场景 4", "选 W"),
            ]
        ),
    ),
}

# ── chrome 装饰条标签（右上的大写短标签）──────────────────────────────────
CHROME = {
    "scene-01": "GUIDE",
    "scene-02": "NOTICE",
    "scene-03": "PICK 01",
    "scene-04": "PICK 02",
    "scene-05": "PICK 03",
    "scene-06": "PICK 04",
    "scene-07": "MATRIX",
    "scene-08": "TAKEAWAY",
}


def main():
    # 幂等：从 index.html.orig 备份重建占位符，使重跑无需先手动 fill_template.py
    ORIG = H.with_name("index.html.orig")
    if not ORIG.exists():
        # 首次定制：把当前（已 fill_template 填充时间/字幕、仍含演示文案占位符的）index.html 备份
        ORIG.write_text(H.read_text(encoding="utf-8"), encoding="utf-8")
    text = ORIG.read_text(encoding="utf-8")

    for sid, (title, body) in SCENES.items():
        # 1) 替换标题
        pat = re.compile(
            r'(<section id="%s".*?<h2 class="section-title"[^>]*>)(.*?)(</h2>)' % sid,
            re.S,
        )
        text, n = pat.subn(lambda m: m.group(1) + title + m.group(3), text, count=1)
        assert n == 1, "title replace failed: %s" % sid

        # 2) 替换场景内容（紧跟 h2 的注释块；scene-07 为 matrix 示例注释）
        pat2 = re.compile(
            r'(<section id="%s".*?</h2>\s*)(<!-- 场景内容 -->|<!-- matrix 示例：.*?-->)'
            % sid,
            re.S,
        )
        text, n2 = pat2.subn(lambda m: m.group(1) + body, text, count=1)
        assert n2 == 1, "body replace failed: %s" % sid

        # 3) 替换 chrome 标签（跳过 label-accent 的 SCN-XX，命中纯 class="label"）
        pat3 = re.compile(
            r'(<section id="%s".*?<span class="label">)([^<]*)(</span>)' % sid, re.S
        )
        text, n3 = pat3.subn(
            lambda m: m.group(1) + CHROME[sid] + m.group(3), text, count=1
        )
        assert n3 == 1, "chrome replace failed: %s" % sid

    H.write_text(text, encoding="utf-8")
    print("[customize] 已定制 %d 个场景" % len(SCENES))


if __name__ == "__main__":
    main()
