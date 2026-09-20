#!/usr/bin/env python3
"""
Video cover image overlay: compose a 1080x1920 WeChat-video cover
from a vertical AI-generated background + title / subtitle / brand.

Usage:
    python cover_overlay.py \
        --bg "assets/img/cover.png" \
        --title "主标题\n第二行" \
        --subtitle "零成本基建系列" \
        --brand "围炉聊科技" \
        --output "封面.png"

Font fallback order (Windows):
    1. msyhbd.ttc / msyh.ttc (微软雅黑)
    2. simhei.ttf
    3. simsun.ttc
"""

import argparse, os, re, sys
from PIL import Image, ImageDraw, ImageFont

WIN_FONTS = [
    "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/simsun.ttc",
    # Linux 沙箱回退：Noto Sans CJK（无 Windows 字体时保证中文标题可渲染）
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Medium.ttc",
    "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
]


def count_title_chars(text: str) -> int:
    """Count characters for short-title length limit (<=16).

    Rules (per WeChat video title policy):
    - Each CJK character: 1
    - Each English letter (a-zA-Z): 1 (NOT per word; "AI"=2, "MCP"=3, "Playwright"=10)
    - Each digit: 1
    - Each punctuation / symbol: 1
    - Whitespace (space, tab, newline): 0
    """
    text = text.strip()
    count = 0
    for ch in text:
        if ch.isspace():
            continue
        count += 1
    return count


def load_font(size, bold=False):
    for path in WIN_FONTS:
        if os.path.exists(path):
            try:
                idx = 0 if bold else 1
                return ImageFont.truetype(path, size, index=idx)
            except Exception:
                try:
                    return ImageFont.truetype(path, size)
                except Exception:
                    continue
    return ImageFont.load_default()


def gradient_overlay(
    img, start_y, end_y, color_start=(0, 0, 0, 180), color_end=(0, 0, 0, 0)
):
    """Draw vertical gradient overlay from start_y (opaque) to end_y (transparent).

    Supports both start_y < end_y (top->bottom) and start_y > end_y (bottom->top).
    """
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    step = 1 if start_y <= end_y else -1
    span = abs(end_y - start_y) or 1
    for y in range(start_y, end_y, step):
        ratio = abs(y - start_y) / span
        r = int(color_start[0] * (1 - ratio) + color_end[0] * ratio)
        g = int(color_start[1] * (1 - ratio) + color_end[1] * ratio)
        b = int(color_start[2] * (1 - ratio) + color_end[2] * ratio)
        a = int(color_start[3] * (1 - ratio) + color_end[3] * ratio)
        draw.line([(0, y), (img.width, y)], fill=(r, g, b, a))
    return overlay


def draw_text_shadow(draw, xy, text, font, fill, shadow=(0, 0, 0, 160), offset=(3, 3)):
    sx, sy = xy[0] + offset[0], xy[1] + offset[1]
    draw.text((sx, sy), text, font=font, fill=shadow)
    draw.text(xy, text, font=font, fill=fill)


def compose(
    bg_path: str,
    title: str,
    subtitle: str = "",
    brand: str = "",
    output: str = "cover_final.png",
    accent: tuple = (62, 224, 166),
):
    # Validate title length before rendering
    title_chars = count_title_chars(title)
    if title_chars > 16:
        print(
            f"[WARN] Title exceeds 16 chars ({title_chars} chars): '{title[:30]}...' "
            "Shorten or split into multiple lines to avoid truncation.",
            file=sys.stderr,
        )
    # Detect long continuous English in title
    english_runs = re.findall(r"[A-Za-z]{12,}", title)
    if english_runs:
        print(
            f"[WARN] Title contains long English sequence(s): {english_runs}. "
            f"At 110px font size this will likely truncate. Use shorter Chinese or force newline.",
            file=sys.stderr,
        )

    # Load background, force 1080x1920
    bg = Image.open(bg_path).convert("RGB")
    # LANCZOS/ANTIALIAS compatibility across Pillow versions
    resample = getattr(Image, "LANCZOS", None) or getattr(Image, "ANTIALIAS", None) or 1
    bg = bg.resize((1080, 1920), resample)
    base = bg.copy().convert("RGBA")

    # Bottom-to-mid gradient for readability
    grad = gradient_overlay(base, 1920, 960, (6, 13, 24, 200), (6, 13, 24, 0))
    base = Image.alpha_composite(base, grad)

    draw = ImageDraw.Draw(base)

    # Title
    title_font = load_font(110, bold=True)
    lines = title.split("\n")
    x, y = 72, 140
    for line in lines:
        draw_text_shadow(draw, (x, y), line, title_font, fill=(230, 233, 239))
        bbox = draw.textbbox((x, y), line, font=title_font)
        y += (bbox[3] - bbox[1]) + 28

    # Accent bar left of title
    draw.rectangle([48, 140, 56, y - 28], fill=accent)

    # Subtitle
    if subtitle:
        sub_font = load_font(52)
        sy = y + 36
        draw_text_shadow(draw, (x, sy), subtitle, sub_font, fill=(139, 149, 167))

    # Brand (bottom-right)
    if brand:
        brand_font = load_font(36)
        bw, bh = draw.textbbox((0, 0), brand, font=brand_font)[2:4]
        bx = base.width - bw - 72
        by = base.height - bh - 80
        draw_text_shadow(
            draw, (bx, by), brand, brand_font, fill=(139, 149, 167), offset=(2, 2)
        )

    # Convert to RGB and save
    final = base.convert("RGB")
    final.save(output, quality=95)
    print(f"[OK] Cover saved: {output} ({final.size})")
    return output


def main():
    parser = argparse.ArgumentParser(description="WeChat video cover overlay")
    parser.add_argument("--bg", required=True, help="Background image path")
    parser.add_argument("--title", required=True, help="Main title (\\n for newline)")
    parser.add_argument("--subtitle", default="", help="Subtitle line")
    parser.add_argument(
        "--brand", default="围炉聊科技", help="Brand name (bottom-right)"
    )
    parser.add_argument("--output", required=True, help="Output path")
    args = parser.parse_args()
    compose(
        args.bg, args.title.replace("\\n", "\n"), args.subtitle, args.brand, args.output
    )


if __name__ == "__main__":
    main()
