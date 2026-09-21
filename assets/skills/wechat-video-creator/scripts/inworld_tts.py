#!/usr/bin/env python3
"""
Inworld TTS client with multi-key rotation.
Corrected endpoints: api.inworld.ai (NOT studio.inworld.ai)
Auth: Basic <API_KEY> (NOT Bearer)
Config loaded from skill-local config/voice_cache.json via voice_manager.
Supports multi-key rotation: automatically cycles to next key on quota limit (429/403).
All keys exhausted -> fatal error (no fallback).

Usage:
    python inworld_tts.py --text-file _tts.txt --output audio.mp3 [--voice_id xxx]
    python inworld_tts.py --text "短文案"   --output audio.mp3 [--voice_id xxx]

--text / --text-file 二选一必填。长中文口播推荐 --text-file（UTF-8 文件），
避免把整段文案塞进命令行导致的 shell 引号/换行转义问题（bash 的 $(cat ...)
在 PowerShell 下不可用）。
"""

import os, sys, re, json, urllib.request, base64, argparse, urllib.error

# Ensure voice_manager can be imported from the same directory
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from voice_manager import load_config, get_active_key, get_api_keys, rotate_key

API = "https://api.inworld.ai"


def _is_quota_error(e):
    """Detect quota / auth exhaustion that warrants key rotation.
    Transient network errors (SSL, connection, timeout, IncompleteRead)
    should be retried on the SAME key, NOT rotated.

    Note: callers often pass a *stringified* exception (speak() returns
    str(e)), so the HTTPError branch above is dead there. We also recover
    the status code from the message text (e.g. "HTTP Error 429: Too Many
    Requests") so 429/403/401 are detected even after stringification.
    """
    if isinstance(e, urllib.error.HTTPError):
        return e.code in (429, 403, 401)
    msg = str(e).lower()
    m = re.search(r"http\s*error\s*(\d+)", msg)
    if m and int(m.group(1)) in (429, 403, 401):
        return True
    return any(
        kw in msg
        for kw in (
            "429",
            "too many requests",
            "quota",
            "rate limit",
            "unauthorized",
            "forbidden",
            "billing",
            "exhausted",
            "limit exceeded",
        )
    )


def clone_voice(wav_path, display_name, api_key):
    """Clone voice via Inworld. Returns voiceId string."""
    audio = base64.b64encode(open(wav_path, "rb").read()).decode()
    body = {
        "displayName": display_name,
        "langCode": "ZH_CN",
        "voiceSamples": [{"audioData": audio}],
    }
    req = urllib.request.Request(
        API + "/voices/v1/voices:clone",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": "Basic " + api_key,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())["voice"]["voiceId"]


def speak(text, voice_id, api_key, out_path):
    """Synthesize speech via Inworld. Returns (ok: bool, info: str)."""
    body = {
        "text": text,
        "voiceId": voice_id,
        "modelId": "inworld-tts-2",
        "deliveryMode": "BALANCED",
        "audioConfig": {"audioEncoding": "MP3", "sampleRateHertz": 24000},
    }
    req = urllib.request.Request(
        API + "/tts/v1/voice",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": "Basic " + api_key,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            audio_b64 = json.loads(resp.read())["audioContent"]
            audio = base64.b64decode(audio_b64)
            with open(out_path, "wb") as f:
                f.write(audio)
            return True, str(len(audio))
    except Exception as e:
        return False, str(e)


def _rotation_log(msg, log_dir=None):
    """Log key-rotation events to stderr and append to key_rotation.log.

    `log_dir` normally points at the directory of the output MP3 so the log
    lands next to the audio. Do not fall back to a CWD-relative "audio/" dir:
    that scatters logs across article directories depending on where the shell
    happened to be, which is one reason output layouts differed between runs.
    """
    print(msg, file=sys.stderr)
    if not log_dir:
        # 无明确落点时宁可不写文件日志，也不回退 CWD 相对目录——
        # 否则日志散落在起跑目录，是产物结构漂移的来源之一。
        return
    try:
        os.makedirs(log_dir, exist_ok=True)
        with open(os.path.join(log_dir, "key_rotation.log"), "a", encoding="utf-8") as f:
            f.write(msg + "\n")
    except OSError:
        pass


def _speak_with_key_rotation(text, voice_id, out_path, cfg):
    """Try all active keys until one succeeds or all exhausted.
    Transient network errors trigger a single retry on the SAME key.
    Quota/auth errors rotate to the next key."""
    keys = get_api_keys(cfg)
    if not keys:
        return False, "No API keys configured"
    # Keep key_rotation.log next to the generated MP3 instead of relative to CWD.
    log_dir = os.path.dirname(os.path.abspath(out_path))

    tried = []
    for entry in keys:
        api_key = entry.get("key", "")
        name = entry.get("name", "unnamed")
        if not api_key or entry.get("status") != "active":
            continue

        for attempt in range(2):  # 1 original + 1 retry
            ok, info = speak(text, voice_id, api_key, out_path)
            if ok:
                if tried:
                    _rotation_log(
                        "  [key rotation] succeeded after trying: %s" % tried,
                        log_dir,
                    )
                return True, info

            if _is_quota_error(RuntimeError(info) if isinstance(info, str) else info):
                _rotation_log(
                    "  [key rotation] key '%s' hit limit (%s), rotating..."
                    % (name, info[:60]),
                    log_dir,
                )
                tried.append(
                    "%s(%s)" % (name, (info[:40] + "...") if len(info) > 40 else info)
                )
                rotate_key(api_key, cfg)
                break  # move to next key
            elif attempt == 0:
                _rotation_log(
                    "  [retry] transient error on '%s' (%s), retrying..."
                    % (name, info[:60]),
                    log_dir,
                )
                continue  # retry same key once
            else:
                tried.append(
                    "%s(%s)" % (name, (info[:40] + "...") if len(info) > 40 else info)
                )
                return False, "key=%s: %s" % (name, info)

    return (
        False,
        "All Inworld keys exhausted (quota or auth limit). Tried: %s"
        % "; ".join(tried),
    )


def main():
    parser = argparse.ArgumentParser(
        description="Inworld TTS with multi-key rotation (no fallback)"
    )
    parser.add_argument(
        "--text", help="Text to synthesize (mutually exclusive with --text-file)"
    )
    parser.add_argument(
        "--text-file",
        help="Path to a UTF-8 text file to synthesize (recommended: avoids shell "
        "quoting/escaping issues with long Chinese copy; mutually exclusive with --text)",
    )
    parser.add_argument("--output", required=True, help="Output MP3 path")
    parser.add_argument(
        "--voice_id", default="", help="Inworld voiceId (optional, loaded from config)"
    )
    parser.add_argument("--api_key", default="", help="Override API key (optional)")
    args = parser.parse_args()

    if bool(args.text) == bool(args.text_file):
        parser.error("exactly one of --text / --text-file is required")
    if args.text_file:
        try:
            with open(args.text_file, "r", encoding="utf-8") as f:
                text = f.read().strip()
        except OSError as e:
            print("ERROR: cannot read --text-file: %s" % e, file=sys.stderr)
            sys.exit(1)
        if not text:
            print("ERROR: --text-file is empty: %s" % args.text_file, file=sys.stderr)
            sys.exit(1)
    else:
        text = args.text.strip()
        if not text:
            print("ERROR: --text is empty", file=sys.stderr)
            sys.exit(1)
    args.text = text

    cfg = load_config()

    # Load voice_id from config if not explicitly provided
    if not args.voice_id:
        args.voice_id = cfg.get("voice_id", "")
        if not args.voice_id:
            print("ERROR: No voice_id configured. Run clone first.", file=sys.stderr)
            sys.exit(1)

    # Override key if explicitly provided
    if args.api_key:
        ok, info = speak(args.text, args.voice_id, args.api_key, args.output)
        if ok:
            print("SUCCESS [inworld]: %s bytes -> %s" % (info, args.output))
            return
        print("ERROR: Inworld failed (%s)" % info, file=sys.stderr)
        sys.exit(1)

    # Multi-key rotation path
    ok, info = _speak_with_key_rotation(args.text, args.voice_id, args.output, cfg)
    if ok:
        print("SUCCESS [inworld]: %s bytes -> %s" % (info, args.output))
        return

    print("ERROR: %s" % info, file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
