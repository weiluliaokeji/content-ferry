#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Segment processor: 从口播脚本 + 配音音频生成 segments.json。

用法:
    python segment_processor.py <script.md> <audio.mp3> [--output segments.json]

流程:
    1. 读取 SCRIPT.md，按 "## F数字" 切分段落
    2. 用 faster-whisper 转写 audio.mp3，获取逐句时间戳
    3. 按段落文本匹配 whisper segments，计算每段 start/end
    4. 检测 stutter（比对相邻 whisper 转写文本的相似度，相邻重复即告警）
    5. 输出 segments.json（含 main_duration / cta_duration / speed_ratio）

依赖:
    pip install faster-whisper
"""

import json, os, re, sys, argparse, difflib


def parse_script(script_path):
    """Read SCRIPT.md and extract segments by F-blocks."""
    with open(script_path, "r", encoding="utf-8") as f:
        text = f.read()

    # Find all ## F{number} ... blocks
    pattern = re.compile(r"##\s*(F\d+)[^\n]*\n(.*?)(?=##\s*F\d+|##\s*复核|$)", re.S)
    matches = pattern.findall(text)

    segments = []
    for scene_id, content in matches:
        # Extract the actual narration text
        lines = [l.strip() for l in content.splitlines() if l.strip()]
        narration = ""
        for line in lines:
            if line.startswith("文案：") or line.startswith("文案:"):
                narration = line[3:].strip()
                break
            elif line.startswith("字幕：") or line.startswith("字幕:"):
                continue
            elif line.startswith("画面：") or line.startswith("画面:"):
                continue
            elif not line.startswith("-") and not line.startswith("*"):
                if not narration:
                    narration = line
        segments.append(
            {
                "id": scene_id.lower().replace("f", "scene-0")
                if len(scene_id) == 2
                else scene_id.lower().replace("f", "scene-"),
                "label": scene_id,
                "text": narration,
                "start": None,
                "end": None,
                "duration": None,
            }
        )
    return segments


def whisper_transcribe(audio_path, model="small"):
    """Run faster-whisper and return list of {start, end, text}."""
    from faster_whisper import WhisperModel

    m = WhisperModel(model, device="cpu", compute_type="int8")
    segs = m.transcribe(audio_path, language="zh", vad_filter=True)
    return [{"start": s.start, "end": s.end, "text": s.text.strip()} for s in segs[0]]


def _text_sim(a, b):
    """Compute text similarity ratio using difflib."""
    return difflib.SequenceMatcher(None, a, b).ratio()


def match_segments(script_segments, whisper_segments):
    """Map whisper segments to script paragraphs by text similarity.
    Computes start/end/duration for each script segment."""
    ws_idx = 0
    for seg_idx, sp in enumerate(script_segments):
        sp_text = sp["text"]
        if not sp_text:
            continue

        matched_ws = []
        matched_indices = []
        while ws_idx < len(whisper_segments):
            w = whisper_segments[ws_idx]
            matched_ws.append(w)
            matched_indices.append(ws_idx)
            ws_idx += 1

            # Boundary detection: if next whisper text is highly similar
            # to next script paragraph, stop accumulating
            if ws_idx < len(whisper_segments):
                next_ws_text = whisper_segments[ws_idx]["text"]
                if seg_idx + 1 < len(script_segments):
                    next_sp_text = script_segments[seg_idx + 1]["text"]
                    sim = _text_sim(next_ws_text, next_sp_text)
                    if sim >= 0.6:
                        break

            # Fallback: if accumulated length reaches target, break
            accumulated = "".join(w2["text"] for w2 in matched_ws)
            if len(accumulated) >= len(sp_text) * 0.85:
                break

        if matched_ws:
            sp["start"] = matched_ws[0]["start"]
            sp["end"] = matched_ws[-1]["end"]
            sp["duration"] = round(sp["end"] - sp["start"], 3)
    return script_segments


def detect_stutter(whisper_segments, min_similarity=0.8):
    """Check adjacent whisper transcription segments for text repetition.
    Real stutter manifests as "script doesn't repeat but audio does" — the
    same phrase is spoken twice consecutively (e.g. 38.5-47.5s case). We
    therefore compare the RAW whisper texts of every adjacent pair (i vs
    i+1); sim >= threshold is reported as a stutter.
    """
    issues = []
    for i in range(len(whisper_segments) - 1):
        prev_text = whisper_segments[i].get("text", "")
        next_text = whisper_segments[i + 1].get("text", "")
        if not prev_text or not next_text:
            continue

        sim = _text_sim(prev_text, next_text)
        if sim >= min_similarity:
            issues.append(
                {
                    "type": "audio_stutter",
                    "indices": [i, i + 1],
                    "similarity": round(sim, 3),
                    "prev_text": prev_text[:60],
                    "next_text": next_text[:60],
                    "action": "Check audio for repeated phrase; use ffmpeg atrim or silence detection to trim duplicate",
                }
            )
    return issues


def build_segments_json(
    script_segments, whisper_segments, cta_duration=6.77, speed_ratio=1.0
):
    """Build the final segments.json structure."""
    valid = [s for s in script_segments if s.get("start") is not None]
    if not valid:
        raise RuntimeError("No valid segments matched")

    main_duration = round(valid[-1]["end"], 3)
    total_duration = round(main_duration + cta_duration, 3)

    # Run stutter detection on RAW whisper text
    issues = detect_stutter(whisper_segments)

    return {
        "version": "1.0",
        "main_duration": main_duration,
        "cta_duration": cta_duration,
        "total_duration": total_duration,
        "speed_ratio": speed_ratio,
        "segments": valid,
        "scene_count": len(valid),
        "issues": issues,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Generate segments.json from script + audio"
    )
    parser.add_argument("script", help="Path to SCRIPT.md")
    parser.add_argument("audio", help="Path to narration MP3")
    parser.add_argument("--output", default="segments.json", help="Output JSON path")
    parser.add_argument(
        "--cta-duration", type=float, default=6.77, help="CTA tail duration in seconds"
    )
    parser.add_argument(
        "--speed-ratio", type=float, default=1.0, help="Applied atempo speed ratio"
    )
    parser.add_argument(
        "--whisper-model", default="small", help="faster-whisper model size"
    )
    args = parser.parse_args()

    print("[segment_processor] Parsing script: %s" % args.script)
    script_segments = parse_script(args.script)
    print("[segment_processor] Found %d scene segments" % len(script_segments))

    print("[segment_processor] Running whisper on: %s" % args.audio)
    whisper_segments = whisper_transcribe(args.audio, model=args.whisper_model)
    print("[segment_processor] Whisper returned %d segments" % len(whisper_segments))

    print("[segment_processor] Matching script paragraphs to whisper timings...")
    matched = match_segments(script_segments, whisper_segments)

    result = build_segments_json(
        matched,
        whisper_segments,
        cta_duration=args.cta_duration,
        speed_ratio=args.speed_ratio,
    )

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    print("[segment_processor] Wrote %s" % args.output)
    print(
        "  main_duration=%.2fs  total=%.2fs  speed=%.2fx"
        % (result["main_duration"], result["total_duration"], result["speed_ratio"])
    )
    print("  scenes=%d" % result["scene_count"])
    if result["issues"]:
        print("  WARN: %d issue(s) detected" % len(result["issues"]))
        for issue in result["issues"]:
            print(
                "    - %s: ws[%d] sim=%.3f"
                % (
                    issue["type"],
                    issue["indices"][0],
                    issue.get("similarity", 0),
                )
            )


if __name__ == "__main__":
    main()
