#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Audio post-processor: 检测配音时长，超出 78-99s 区间（主配音，不含 CTA）时自动 atempo 压缩并记录。

用法:
    python audio_post_process.py <input.mp3> [--target-min 78] [--target-max 99] [--output output.mp3] [--segments segments.json]

流程:
    1. 用 ffprobe 获取音频时长（主配音，不含 CTA）
    2. 如果 > target_max: 计算 atempo 值（上限 2.0），ffmpeg 压缩
    3. 如果 < target_min: 警告（通常需要扩充脚本内容）
    4. 如有 segments.json，换算后更新（无需重新 whisper，因 segments 时间已被预乘 speed_ratio）
    5. 记录调整日志到 audio/speed_adjustment.log

依赖:
    ffmpeg, ffprobe
"""

import json, os, subprocess, sys, argparse, math


# Skill root resolution for CTA template
SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CTA_TEMPLATE_PATH = os.path.join(SKILL_ROOT, "assets", "audio", "cta_tail.mp3")


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
        "--speed-cap",
        type=float,
        default=1.7,
        help="Maximum atempo speed ratio (1.7x recommended to avoid audio degradation)",
    )
    parser.add_argument(
        "--segments", default="", help="Path to segments.json to update"
    )
    parser.add_argument(
        "--log", default="audio/speed_adjustment.log", help="Adjustment log path"
    )
    parser.add_argument(
        "--no-concat-cta",
        action="store_true",
        default=False,
        help="Skip concatenating CTA template after main narration (default: concats)",
    )
    args = parser.parse_args()

    output = args.output or args.input
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

    speed_ratio = 1.0
    if duration > args.target_min:
        # Calculate speed ratio to bring duration into target range (99-168s)
        target_mid = (args.target_min + args.target_max) / 2
        speed_ratio = duration / target_mid
        # Clamp to speed_cap (default 1.7x)
        if speed_ratio > args.speed_cap:
            # RED: script too long, must shorten instead of over-compressing
            print(
                f"[audio_post_process] RED ALERT: Required speed {speed_ratio:.2f}x exceeds cap {args.speed_cap}x. "
                f"Script is too long ({duration:.1f}s). Must shorten script to ≤300 words before proceeding.",
                file=sys.stderr,
            )
            sys.exit(2)
        print(
            f"[audio_post_process] Duration exceeds target_min. Applying atempo={speed_ratio:.3f}x"
        )
        apply_atempo(args.input, output, speed_ratio)
        new_dur = get_duration(output)
        print(f"[audio_post_process] New duration: {new_dur:.2f}s")
        log_adjustment(
            args.log, duration, args.target_min, args.target_max, speed_ratio, output
        )
    elif duration < args.target_min:
        print(
            f"[audio_post_process] WARN: Duration {duration:.2f}s is below minimum {args.target_min}s. Consider expanding script."
        )
        # Just copy and warn
        if args.input != output:
            subprocess.check_call(
                ["ffmpeg", "-y", "-v", "error", "-i", args.input, "-c", "copy", output]
            )
    else:
        print(
            "[audio_post_process] Duration within target range. No adjustment needed."
        )
        if args.input != output:
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
