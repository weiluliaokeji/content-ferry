#!/usr/bin/env python3
"""
Inworld TTS client with multi-key rotation.
Corrected endpoints: api.inworld.ai (NOT studio.inworld.ai)
Auth: Basic <API_KEY> (NOT Bearer)
Config loaded from skill-local config/voice_cache.json via voice_manager.
Supports multi-key rotation: automatically cycles to next key on quota limit (429/403).
All keys exhausted -> fatal error (no fallback).

Usage:
    python inworld_tts.py --text "文案内容" --output audio.mp3 [--voice_id xxx]
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


def _rotation_log(msg):
    """Log key-rotation events to stderr and append to audio/key_rotation.log."""
    print(msg, file=sys.stderr)
    try:
        os.makedirs("audio", exist_ok=True)
        with open(os.path.join("audio", "key_rotation.log"), "a", encoding="utf-8") as f:
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
                        "  [key rotation] succeeded after trying: %s" % tried
                    )
                return True, info

            if _is_quota_error(RuntimeError(info) if isinstance(info, str) else info):
                _rotation_log(
                    "  [key rotation] key '%s' hit limit (%s), rotating..."
                    % (name, info[:60])
                )
                tried.append(
                    "%s(%s)" % (name, (info[:40] + "...") if len(info) > 40 else info)
                )
                rotate_key(api_key, cfg)
                break  # move to next key
            elif attempt == 0:
                _rotation_log(
                    "  [retry] transient error on '%s' (%s), retrying..."
                    % (name, info[:60])
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
    parser.add_argument("--text", required=True, help="Text to synthesize")
    parser.add_argument("--output", required=True, help="Output MP3 path")
    parser.add_argument(
        "--voice_id", default="", help="Inworld voiceId (optional, loaded from config)"
    )
    parser.add_argument("--api_key", default="", help="Override API key (optional)")
    args = parser.parse_args()

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
