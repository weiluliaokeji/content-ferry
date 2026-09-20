#!/usr/bin/env python3
"""
Voice config manager for wechat-video-creator skill.
Reads/writes Inworld API keys (array) and voiceId from skill-local config.
Supports multi-key rotation when one key hits quota.
"""

import json, os, pathlib


def _config_dir():
    return pathlib.Path(__file__).resolve().parent.parent / "config"


def _config_path():
    return _config_dir() / "voice_cache.json"


def _migrate_legacy(cfg):
    """Convert legacy single-key format to array format."""
    if "api_keys" not in cfg and "inworld_api_key" in cfg:
        old_key = cfg.pop("inworld_api_key", "")
        if old_key:
            cfg["api_keys"] = [{"key": old_key, "name": "legacy", "status": "active"}]
    return cfg


def load_config():
    """Load voice cache. Returns dict with keys: api_keys, voice_id, display_name, source_audio."""
    cfg_path = _config_path()
    if cfg_path.exists():
        with open(cfg_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        cfg = _migrate_legacy(cfg)
        return cfg
    # Fallback to environment for backward compatibility
    env_key = os.environ.get("INWORLD_API_KEY", "")
    return {
        "api_keys": [{"key": env_key, "name": "env", "status": "active"}]
        if env_key
        else [],
        "voice_id": os.environ.get("INWORLD_VOICE_ID", ""),
        "display_name": os.environ.get("INWORLD_VOICE_DISPLAY_NAME", "cloned"),
        "source_audio": os.environ.get("INWORLD_SOURCE_AUDIO", ""),
    }


def get_active_key(cfg=None):
    """Return the first active API key string, or empty string if none available."""
    if cfg is None:
        cfg = load_config()
    for entry in cfg.get("api_keys", []):
        if entry.get("status") == "active":
            return entry.get("key", "")
    return ""


def get_api_keys(cfg=None):
    """Return all API key entries (list of dicts)."""
    if cfg is None:
        cfg = load_config()
    return cfg.get("api_keys", [])


def rotate_key(failed_key, cfg=None):
    """Mark the given key as 'failed' and return the next active key (or None)."""
    if cfg is None:
        cfg = load_config()
    found = False
    next_key = None
    for entry in cfg.get("api_keys", []):
        if entry.get("key") == failed_key:
            entry["status"] = "failed"
            found = True
        elif found and next_key is None and entry.get("status") == "active":
            next_key = entry.get("key")
    if found:
        save_config(cfg)
    return next_key


def reset_all_keys(cfg=None):
    """Reset all keys to 'active'. Useful for manual retry."""
    if cfg is None:
        cfg = load_config()
    for entry in cfg.get("api_keys", []):
        entry["status"] = "active"
    save_config(cfg)


def save_config(data):
    """Save voice cache (array format)."""
    _config_dir().mkdir(parents=True, exist_ok=True)
    cfg_path = _config_path()
    # Ensure it's in new format
    data = _migrate_legacy(data)
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    return cfg_path
