#!/usr/bin/env python3
"""Persistance historique et settings — avec file locking"""

import fcntl
import json
import os
from datetime import datetime

CONFIG_DIR = os.path.expanduser("~/.config/compressor")
HISTORY_FILE = os.path.join(CONFIG_DIR, "history.json")
SETTINGS_FILE = os.path.join(CONFIG_DIR, "settings.json")
MAX_HISTORY = 500

DEFAULT_SETTINGS = {
    "level": "medium",
    "custom_quality": 70,
    "max_resolution": None,
    "output_format": None,
    "target_size_kb": None,
    "output_dir": None,
    "notifications_enabled": True,
    "auto_check_updates": True,
    "default_output_dir": None,
    # Phase 2
    "resize_mode": "none",
    "resize_width": None,
    "resize_height": None,
    "resize_percent": 100,
    "strip_metadata": False,
    "suffix": "_compressed",
    "keep_date": False,
    "lossless": False,
}

VALID_LEVELS = {"high", "medium", "low", "custom"}
VALID_FORMATS = {"jpeg", "png", "webp", "pdf", None}
VALID_RESIZE_MODES = {"none", "percent", "width", "height", "fit", "exact"}


def _ensure_dir():
    os.makedirs(CONFIG_DIR, exist_ok=True)


# ── File locking helpers ─────────────────────

def _read_json_locked(filepath: str, default=None):
    """Lit un fichier JSON avec un lock partagé (lecture concurrente OK)."""
    if not os.path.isfile(filepath):
        return default if default is not None else []
    try:
        with open(filepath, "r") as f:
            fcntl.flock(f.fileno(), fcntl.LOCK_SH)
            try:
                return json.load(f)
            finally:
                fcntl.flock(f.fileno(), fcntl.LOCK_UN)
    except (json.JSONDecodeError, IOError):
        return default if default is not None else []


def _write_json_locked(filepath: str, data):
    """Écrit un fichier JSON de manière atomique (temp + rename).
    Evite la corruption si crash entre truncate et écriture."""
    _ensure_dir()
    tmp_path = filepath + ".tmp"
    with open(tmp_path, "w") as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        try:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        finally:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)
    os.replace(tmp_path, filepath)  # Atomique sur le même filesystem


# ── History ──────────────────────────────────

def load_history() -> list:
    return _read_json_locked(HISTORY_FILE, default=[])


def _save_history(entries: list):
    _write_json_locked(HISTORY_FILE, entries[-MAX_HISTORY:])


def add_entry(result_dict: dict) -> dict:
    entry = {**result_dict, "timestamp": datetime.now().isoformat()}
    entries = load_history()
    entries.append(entry)
    _save_history(entries)
    return entry


def get_history(limit: int = 50, offset: int = 0) -> list:
    limit = max(1, min(500, limit))
    offset = max(0, offset)
    entries = load_history()
    entries.reverse()  # Most recent first
    return entries[offset:offset + limit]


def clear_history():
    _save_history([])


def get_stats() -> dict:
    entries = load_history()
    if not entries:
        return {"total_files": 0, "total_saved_bytes": 0, "avg_reduction": 0, "formats": {}}
    total_saved = sum(e.get("original_size", 0) - e.get("compressed_size", 0) for e in entries)
    reductions = [e.get("reduction_pct", 0) for e in entries]
    formats = {}
    for e in entries:
        fmt = e.get("format", "unknown")
        formats[fmt] = formats.get(fmt, 0) + 1
    return {
        "total_files": len(entries),
        "total_saved_bytes": total_saved,
        "avg_reduction": round(sum(reductions) / len(reductions), 1),
        "formats": formats,
    }


# ── Settings ─────────────────────────────────

def load_settings() -> dict:
    saved = _read_json_locked(SETTINGS_FILE, default={})
    return {**DEFAULT_SETTINGS, **saved}


def save_settings(settings: dict):
    """Sauvegarde les settings en ne gardant que les clés connues + validation."""
    cleaned = {}
    for k, default_val in DEFAULT_SETTINGS.items():
        val = settings.get(k, default_val)
        cleaned[k] = val

    # Validation
    if cleaned["level"] not in VALID_LEVELS:
        cleaned["level"] = "medium"
    if cleaned["custom_quality"] is not None:
        cleaned["custom_quality"] = max(1, min(100, int(cleaned["custom_quality"])))
    if cleaned["output_format"] not in VALID_FORMATS:
        cleaned["output_format"] = None

    # Phase 2 validation
    if cleaned.get("resize_mode") not in VALID_RESIZE_MODES:
        cleaned["resize_mode"] = "none"
    if cleaned.get("resize_percent") is not None:
        try:
            cleaned["resize_percent"] = max(1, min(100, int(cleaned["resize_percent"])))
        except (ValueError, TypeError):
            cleaned["resize_percent"] = 100
    if cleaned.get("resize_width") is not None:
        try:
            cleaned["resize_width"] = max(1, min(10000, int(cleaned["resize_width"])))
        except (ValueError, TypeError):
            cleaned["resize_width"] = None
    if cleaned.get("resize_height") is not None:
        try:
            cleaned["resize_height"] = max(1, min(10000, int(cleaned["resize_height"])))
        except (ValueError, TypeError):
            cleaned["resize_height"] = None
    if cleaned.get("suffix") is not None:
        import re
        cleaned["suffix"] = re.sub(r'[^a-zA-Z0-9_\-. ]', '', str(cleaned["suffix"])[:50])

    _write_json_locked(SETTINGS_FILE, cleaned)
