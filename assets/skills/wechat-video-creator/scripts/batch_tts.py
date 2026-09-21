#!/usr/bin/env python3
"""Batch Inworld TTS: synthesize each segment from SCRIPT.md and concatenate."""

import os, sys, re, subprocess, json

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

INWORLD_TTS = os.path.join(SCRIPT_DIR, "inworld_tts.py")


def extract_narration(script_path):
    with open(script_path, "r", encoding="utf-8") as f:
        text = f.read()
    pattern = re.compile(
        r"##\s*F\d+[^\n]*\n文案[：:]\s*(.+?)(?=\n画面[：:]|\n字幕[：:]|\n##\s*F|\Z)",
        re.S,
    )
    return [s.strip() for s in pattern.findall(text)]


def synthesize_segment(text, out_path):
    cmd = [sys.executable, INWORLD_TTS, "--text", text, "--output", out_path]
    print("  TTS: %s -> %s" % (text[:30], out_path))
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    except subprocess.TimeoutExpired:
        print("  ERROR: TTS 超时（>90s），触发 ABORT")
        return False
    if result.returncode != 0:
        print("  ERROR: %s" % (result.stderr or result.stdout))
        return False
    if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        print("  ERROR: output empty")
        return False
    print("  OK: %d bytes" % os.path.getsize(out_path))
    return True


def concatenate(inputs, output):
    list_file = output + ".concat.txt"
    with open(list_file, "w", encoding="utf-8") as f:
        for p in inputs:
            f.write("file '%s'\n" % p.replace("'", "'\\''"))
    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list_file,
        "-c",
        "copy",
        output,
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    os.remove(list_file)
    if res.returncode != 0:
        print("  ERROR: ffmpeg concat 失败:\n%s" % (res.stderr or res.stdout))
        sys.exit(1)
    return output


def main():
    script_path = sys.argv[1]
    out_dir = sys.argv[2]
    final_out = sys.argv[3]

    os.makedirs(out_dir, exist_ok=True)
    segs = extract_narration(script_path)
    print("[batch_tts] %d segments to synthesize" % len(segs))

    pieces = []
    for i, text in enumerate(segs, 1):
        seg_path = os.path.join(out_dir, "seg_%02d.mp3" % i)
        if synthesize_segment(text, seg_path):
            pieces.append(seg_path)
        else:
            print("[batch_tts] ABORT: segment %d failed" % i)
            sys.exit(1)

    concatenate(pieces, final_out)
    print(
        "[batch_tts] Concatenated %d segments -> %s (%d bytes)"
        % (len(pieces), final_out, os.path.getsize(final_out))
    )
    # 拼接成功后清理分段中间件：seg_*.mp3 不在产物契约内，
    # 留下会造成目录结构漂移（失败时保留供诊断，事后须手动清理）。
    for p in pieces:
        try:
            os.remove(p)
        except OSError:
            pass
    print("[batch_tts] Cleaned %d intermediate segment(s)" % len(pieces))


if __name__ == "__main__":
    main()
