#!/usr/bin/env python3
"""Generate Chinese voiceover for a tech explainer via edge-tts.

Generic version of the EV-brake example's gen_narration.py. Instead of
hardcoding scene text, it reads a plain-text "scenes" file where each
non-empty line is one narration segment (aligned 1:1 with the SCENES in
build-video.mjs). Segments are synthesized separately, then concatenated
with a short silence between them so audio cuts line up roughly with the
visual scene changes.

Usage:
    python narrate.py --scenes scenes.txt --out narration.mp3
    python narrate.py --scenes scenes.txt --out narration.mp3 \
        --voice zh-CN-YunxiNeural --rate -8% --gap 0.45

Requires: edge-tts>=7.3.1 (pip install --upgrade edge-tts). Works through
the system proxy. ffmpeg/ffprobe must be on PATH or FFMPEG_PATH.
"""
import asyncio, os, sys, subprocess, argparse, json

DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"  # warm female, good for 科普
DEFAULT_RATE = "-8%"                    # slightly slower for clarity
DEFAULT_GAP = 0.45                       # seconds of silence between scenes
HERE = os.path.dirname(os.path.abspath(__file__))
FFMPEG = os.environ.get("FFMPEG_PATH", "D:/Tools/ffmpeg-2024-09-12-git-504c1ffcd8-full_build/bin/ffmpeg.exe")


async def synth(text, path):
    import edge_tts
    comm = edge_tts.Communicate(text, VOICE, rate=RATE, volume="+0%")
    await comm.save(path)


def read_scenes(path):
    with open(path, encoding="utf-8") as f:
        lines = [ln.strip() for ln in f if ln.strip()]
    if not lines:
        raise SystemExit(f"[narrate] no scenes found in {path}")
    return lines


def main():
    global VOICE, RATE, GAP, FFMPEG
    ap = argparse.ArgumentParser(description="Generate Chinese voiceover via edge-tts")
    ap.add_argument("--scenes", required=True, help="plain-text file, one narration segment per non-empty line")
    ap.add_argument("--out", required=True, help="output mp3 path")
    ap.add_argument("--voice", default=DEFAULT_VOICE)
    ap.add_argument("--rate", default=DEFAULT_RATE)
    ap.add_argument("--gap", type=float, default=DEFAULT_GAP)
    ap.add_argument("--ffmpeg", default=FFMPEG)
    args = ap.parse_args()
    VOICE, RATE, GAP = args.voice, args.rate, args.gap
    FFMPEG = args.ffmpeg

    scenes = read_scenes(args.scenes)
    out_dir = os.path.dirname(os.path.abspath(args.out))
    asyncio.run(_run(scenes, args.out, out_dir))


async def _run(scenes, out, out_dir):
    parts = []
    for i, txt in enumerate(scenes, 1):
        seg = os.path.join(out_dir, f"_narr_seg_{i:02d}.mp3")
        await synth(txt, seg)
        parts.append(seg)
        print(f"[narr] scene {i}: {len(txt)} chars -> {os.path.getsize(seg)} bytes")

    list_path = os.path.join(out_dir, "_narr_concat.txt")
    gap = os.path.join(out_dir, "_narr_gap.wav")
    subprocess.run(
        [FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i",
         f"anullsrc=r=24000:cl=mono:d={GAP}", gap],
        check=True,
    )
    with open(list_path, "w", encoding="utf-8") as f:
        for p in parts:
            f.write(f"file '{p.replace(chr(92), '/')}'\n")
            f.write(f"file '{gap.replace(chr(92), '/')}'\n")

    subprocess.run(
        [FFMPEG, "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list_path,
         "-ar", "44100", "-ac", "2", "-b:a", "192k", out],
        check=True,
    )
    for p in parts:
        try: os.remove(p)
        except OSError: pass
    for tmp in (list_path, gap):
        try: os.remove(tmp)
        except OSError: pass

    ffprobe = os.path.join(os.path.dirname(FFMPEG), "ffprobe.exe") if os.path.dirname(FFMPEG) else "ffprobe.exe"
    if not os.path.exists(ffprobe):
        ffprobe = FFMPEG.replace("ffmpeg.exe", "ffprobe.exe")
    dur = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nokey=1:noprint_wrappers=1", out],
        capture_output=True, text=True,
    ).stdout.strip()
    print(f"[narr] wrote {out}  duration={dur}s")
    with open(os.path.join(out_dir, "_narr_duration.json"), "w") as f:
        json.dump({"duration": float(dur) if dur else 0, "voice": VOICE, "rate": RATE}, f)
    # Hand the duration back for downstream DUR_SCALE alignment.
    print(f"[narr] DUR_SCALE hint: re-run build-video.mjs with DUR_SCALE="
          f"{(float(dur)/67):.6f} to match this audio length.")


if __name__ == "__main__":
    main()
