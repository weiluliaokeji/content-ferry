#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Audio post-processor: 按固定倍速压缩主配音（owner 硬性：一律 1.3x），换算 segments.json 时间戳并记录。

用法:
    python audio_post_process.py <input.mp3> [--speed 1.3] [--target-min 78] [--target-max 168]
                                 [--output output.mp3] [--segments segments.json]

流程:
    1. 用 ffprobe 获取音频时长（主配音，不含 CTA）
    2. 固定倍速 atempo（默认 1.3x，安全区间 1.2–1.7x）：**不是**向区间中点靠拢，
       也**不会**输出 1.0x——未调速视为缺陷，禁止交付
    3. 提速后仍 > target_max → RED 退出（必须精简脚本，不得靠超压倍速蒙混）
       提速后 < 60s → 警告建议扩充脚本（但仍按固定倍速交付）
    4. 如有 segments.json，换算后更新（无需重新 whisper；segments 时间戳是原始配音的
       whisper 时间，此处统一乘 1/speed_ratio 换算到调速后的时间轴）
    5. 记录调整日志到音频文件同级的 speed_adjustment.log（可用 --log 覆盖）

依赖:
    ffmpeg, ffprobe
"""

import json, os, subprocess, sys, argparse, math


# Skill root resolution for CTA template
SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CTA_TEMPLATE_PATH = os.path.join(SKILL_ROOT, "assets", "audio", "cta_tail.mp3")

# owner 硬性调速规格（与 SKILL.md「视频规格（唯一真值表）」保持一致）
DEFAULT_SPEED = 1.3  # 一律 1.3x；安全区间 1.2–1.7x；1.0x = 缺陷，禁止交付
MIN_SPEED_DURATION = 60.0  # 提速后下限，低于此建议扩充脚本（但不得退回 1.0x）


def assert_cta_template():
    """Assert CTA template exists. Returns True if found, else warns."""
    if os.path.exists(CTA_TEMPLATE_PATH):
        print(f"[OK] CTA template found: {CTA_TEMPLATE_PATH}")
        return True
    print(
        f"[WARN] CTA template NOT found at {CTA_TEMPLATE_PATH}. "
        "Must regenerate or copy template before concatenation.",
        file=sys.stderr,
    )
    return False


def concatenate_cta(main_path, output_path):
    """Concatenate main narration with CTA template via ffmpeg concat."""
    if not os.path.exists(CTA_TEMPLATE_PATH):
        raise RuntimeError(f"CTA template missing: {CTA_TEMPLATE_PATH}")
    # Write concat list
    list_path = os.path.join(os.path.dirname(output_path), "_concat_list.txt")
    with open(list_path, "w", encoding="utf-8") as f:
        f.write(f"file '{os.path.abspath(main_path).replace(os.sep, '/')}'\n")
        f.write(f"file '{os.path.abspath(CTA_TEMPLATE_PATH).replace(os.sep, '/')}'\n")
    cmd = [
        "ffmpeg",
        "-y",
        "-v",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list_path,
        "-c:a",
        "libmp3lame",
        "-ar",
        "44100",
        "-b:a",
        "192k",
        output_path,
    ]
    subprocess.check_call(cmd)
    os.remove(list_path)
    return output_path


def get_duration(path):
    """Get audio duration via ffprobe."""
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        path,
    ]
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, text=True).strip()
        return float(out)
    except Exception:
        return None


def apply_atempo(input_path, output_path, speed_ratio):
    """Apply ffmpeg atempo filter. atempo range is 0.5-2.0;
    for ratios outside this range, chain multiple atempo filters."""
    # atempo supports 0.5 to 2.0. For higher speeds, chain them.
    filters = []
    remaining = speed_ratio
    while remaining > 2.0:
        filters.append("atempo=2.0")
        remaining /= 2.0
    while remaining < 0.5:
        filters.append("atempo=0.5")
        remaining /= 0.5
    filters.append(f"atempo={remaining:.4f}")
    filter_str = ",".join(filters)

    cmd = [
        "ffmpeg",
        "-y",
        "-v",
        "error",
        "-i",
        input_path,
        "-af",
        filter_str,
        "-c:a",
        "libmp3lame",
        "-b:a",
        "192k",
        output_path,
    ]
    subprocess.check_call(cmd)
    return output_path


def update_segments(segments_path, speed_ratio):
    """Multiply all segment timestamps by 1/speed_ratio and write back."""
    with open(segments_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    inv = 1.0 / speed_ratio
    for s in data.get("segments", []):
        if s.get("start") is not None:
            s["start"] = round(s["start"] * inv, 3)
        if s.get("end") is not None:
            s["end"] = round(s["end"] * inv, 3)
        if s.get("duration") is not None:
            s["duration"] = round(s["duration"] * inv, 3)

    for key in ["main_duration", "total_duration"]:
        if key in data:
            data[key] = round(data[key] * inv, 3)

    data["speed_ratio"] = speed_ratio
    with open(segments_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def log_adjustment(
    log_path, original, target_min, target_max, speed_ratio, output_path
):
    """Append adjustment record to log file."""
    os.makedirs(
        os.path.dirname(log_path) if os.path.dirname(log_path) else ".", exist_ok=True
    )
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(
            f"{os.path.basename(output_path)}: original={original:.2f}s target=[{target_min},{target_max}] speed={speed_ratio:.3f}x\n"
        )


def main():
    parser = argparse.ArgumentParser(description="Post-process narration audio")
    parser.add_argument("input", help="Input MP3 path")
    parser.add_argument(
        "--output", default="", help="Output MP3 path (default: overwrite input)"
    )
    parser.add_argument(
        "--target-min",
        type=float,
        default=78.0,
        help="Minimum acceptable duration (main narration only, before CTA merge)",
    )
    parser.add_argument(
        "--target-max",
        type=float,
        default=168.0,
        help="Hard ceiling for main narration (before CTA). Audio > this triggers RED exit(2). "
        "Total = main + 6.77s CTA; >209s blocks publishing.",
    )
    parser.add_argument(
        "--speed",
        type=float,
        default=DEFAULT_SPEED,
        help=f"atempo speed ratio (default {DEFAULT_SPEED}; 安全区间 1.2-1.7x；"
        "1.0x 视为缺陷，禁止交付)",
    )
    parser.add_argument(
        "--speed-cap",
        type=float,
        default=1.7,
        help="Maximum atempo speed ratio (1.7x recommended to avoid audio degradation)",
    )
    parser.add_argument(
        "--segments", default="", help="Path to segments.json to update"
    )
    parser.add_argument(
        "--log", default="", help="Adjustment log path (default: alongside the input MP3)"
    )
    parser.add_argument(
        "--no-concat-cta",
        action="store_true",
        default=False,
        help="Skip concatenating CTA template after main narration (default: concats)",
    )
    args = parser.parse_args()

    output = args.output or args.input
    # Resolve the log next to the audio rather than relative to CWD, so the
    # layout does not depend on which directory the shell happened to start in.
    log_path = args.log or os.path.join(
        os.path.dirname(os.path.abspath(args.input)), "speed_adjustment.log"
    )
    duration = get_duration(args.input)
    if duration is None:
        print("[audio_post_process] ERROR: could not get duration", file=sys.stderr)
        sys.exit(1)

    print(
        f"[audio_post_process] Duration: {duration:.2f}s (target: {args.target_min}-{args.target_max}s, speed cap: {args.speed_cap}x)"
    )

    # CTA template assertion
    assert_cta_template()

    if duration > args.target_max:
        print(
            f"[audio_post_process] RED ALERT: Duration {duration:.1f}s exceeds target_max "
            f"{args.target_max:.0f}s (total = main + {6.77}s CTA would be {duration + 6.77:.1f}s > "
            f"209s hard cap). Must shorten script to ≤300 words before proceeding.",
            file=sys.stderr,
        )
        sys.exit(2)

    # owner 硬性：按固定倍速提速（默认 1.3x），**不是**向 target 区间中点靠拢。
    # 1.0x = 缺陷禁止交付，因此即使 duration 已落在 [target_min, target_max] 内也必须提速。
    speed_ratio = args.speed
    # owner 硬性：安全区间 1.2–1.7x，默认 1.3x；1.0x 视为缺陷禁止交付。
    # 低于 1.2x（含 1.0x）一律阻断，禁止用「不调速 / 轻微减速」蒙混过关——
    # 旧实现只在上界 >1.7x 时拦截，下界缺失，显式传 --speed 1.0 仍能产出缺陷片。
    if speed_ratio < 1.2:
        print(
            f"[audio_post_process] RED ALERT: requested {speed_ratio:.2f}x is below the "
            f"1.2x safe floor (default 1.3x; safe range 1.2-1.7x; 1.0x is an undeliverable "
            f"defect). Pass --speed 1.3 or shorten the script.",
            file=sys.stderr,
        )
        sys.exit(2)
    if speed_ratio > args.speed_cap:
        print(
            f"[audio_post_process] RED ALERT: requested {speed_ratio:.2f}x exceeds speed cap "
            f"{args.speed_cap}x. Audio would degrade; lower --speed or shorten the script.",
            file=sys.stderr,
        )
        sys.exit(2)

    sped_duration = duration / speed_ratio
    if sped_duration > args.target_max:
        print(
            f"[audio_post_process] RED ALERT: even at {speed_ratio:.2f}x the narration is "
            f"{sped_duration:.1f}s > target_max {args.target_max:.0f}s. Must shorten the script "
            f"to ≤300 words instead of over-compressing.",
            file=sys.stderr,
        )
        sys.exit(2)

    if sped_duration < MIN_SPEED_DURATION:
        print(
            f"[audio_post_process] WARN: after {speed_ratio:.2f}x the narration is only "
            f"{sped_duration:.1f}s (<{MIN_SPEED_DURATION:.0f}s). Consider expanding the script "
            f"— 1.0x is NOT an option (undeliverable defect)."
        )

    if speed_ratio != 1.0:
        print(
            f"[audio_post_process] Applying atempo={speed_ratio:.3f}x "
            f"({duration:.2f}s -> {sped_duration:.2f}s)"
        )
        apply_atempo(args.input, output, speed_ratio)
        new_dur = get_duration(output)
        print(f"[audio_post_process] New duration: {new_dur:.2f}s")
        log_adjustment(
            log_path, duration, args.target_min, args.target_max, speed_ratio, output
        )
    elif args.input != output:
        subprocess.check_call(
            ["ffmpeg", "-y", "-v", "error", "-i", args.input, "-c", "copy", output]
        )

    if args.segments and speed_ratio != 1.0:
        print(
            f"[audio_post_process] Updating {args.segments} with speed_ratio={speed_ratio:.3f}"
        )
        update_segments(args.segments, speed_ratio)

    # Concatenate CTA template
    if not args.no_concat_cta and os.path.exists(CTA_TEMPLATE_PATH):
        final_output = (
            output.replace(".mp3", "_v2.mp3")
            if output.endswith(".mp3")
            else output + "_v2"
        )
        if not final_output.endswith(".mp3"):
            final_output += ".mp3"
        print(f"[audio_post_process] Concatenating CTA template -> {final_output}")
        concatenate_cta(output, final_output)
        # Optionally replace original with concatenated version
        if output != args.input:
            os.replace(final_output, output)
            print(
                f"[audio_post_process] Replaced {output} with CTA-concatenated version"
            )


if __name__ == "__main__":
    main()
