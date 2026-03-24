#!/usr/bin/env python3
"""Persistance historique, settings et presets — avec file locking"""

import fcntl
import json
import os
import re
import uuid
from datetime import datetime

CONFIG_DIR = os.path.expanduser("~/.config/compressor")
HISTORY_FILE = os.path.join(CONFIG_DIR, "history.json")
SETTINGS_FILE = os.path.join(CONFIG_DIR, "settings.json")
PRESETS_FILE = os.path.join(CONFIG_DIR, "presets.json")
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
    "suffix": "",
    "keep_date": False,
    "lossless": False,
    "has_compressed": False,
    "quick_presets": [None, None, None],
}

VALID_LEVELS = {"high", "medium", "low", "custom"}
VALID_FORMATS = {"jpeg", "png", "webp", "pdf", None}
VALID_RESIZE_MODES = {"none", "percent", "width", "height", "fit", "exact"}

DEFAULT_CATEGORIES = ["Web", "Print", "Présentation", "Email", "Archive"]

PRESET_SETTINGS_KEYS = {
    "level", "custom_quality", "output_format", "resize_mode",
    "resize_width", "resize_height", "resize_percent",
    "strip_metadata", "suffix", "keep_date", "lossless",
    "target_size_kb", "pdf_custom_dpi", "pdf_custom_quality",
}


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
    """Écrit un fichier JSON de manière atomique (temp + rename)."""
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
    os.replace(tmp_path, filepath)


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

    if cleaned["level"] not in VALID_LEVELS:
        cleaned["level"] = "medium"
    if cleaned["custom_quality"] is not None:
        cleaned["custom_quality"] = max(1, min(100, int(cleaned["custom_quality"])))
    if cleaned["output_format"] not in VALID_FORMATS:
        cleaned["output_format"] = None

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
        cleaned["suffix"] = re.sub(r'[^a-zA-Z0-9_\-. ]', '', str(cleaned["suffix"])[:50])

    _write_json_locked(SETTINGS_FILE, cleaned)


# ── Presets ──────────────────────────────────

def generate_preset_id() -> str:
    return uuid.uuid4().hex[:12]


def _default_presets_data() -> dict:
    return {
        "version": 1,
        "categories": list(DEFAULT_CATEGORIES),
        "presets": [],
        "active_preset_id": None,
    }


def load_presets() -> dict:
    data = _read_json_locked(PRESETS_FILE, default={})
    if not isinstance(data, dict) or "presets" not in data:
        return _default_presets_data()
    if "categories" not in data or not isinstance(data["categories"], list):
        data["categories"] = list(DEFAULT_CATEGORIES)
    if "active_preset_id" not in data:
        data["active_preset_id"] = None
    return data


def save_presets(data: dict):
    _write_json_locked(PRESETS_FILE, data)


def validate_preset_settings(settings: dict) -> dict:
    """Sanitize un dict de settings pour un preset."""
    cleaned = {}
    for k in PRESET_SETTINGS_KEYS:
        if k in settings:
            cleaned[k] = settings[k]

    if cleaned.get("level") not in VALID_LEVELS:
        cleaned["level"] = "medium"
    if "custom_quality" in cleaned and cleaned["custom_quality"] is not None:
        try:
            cleaned["custom_quality"] = max(1, min(100, int(cleaned["custom_quality"])))
        except (ValueError, TypeError):
            cleaned["custom_quality"] = 70
    if cleaned.get("output_format") not in VALID_FORMATS:
        cleaned["output_format"] = None
    if cleaned.get("resize_mode") not in VALID_RESIZE_MODES:
        cleaned["resize_mode"] = "none"
    if "resize_percent" in cleaned and cleaned["resize_percent"] is not None:
        try:
            cleaned["resize_percent"] = max(1, min(100, int(cleaned["resize_percent"])))
        except (ValueError, TypeError):
            cleaned["resize_percent"] = 100
    for dim_key in ("resize_width", "resize_height"):
        if dim_key in cleaned and cleaned[dim_key] is not None:
            try:
                cleaned[dim_key] = max(1, min(10000, int(cleaned[dim_key])))
            except (ValueError, TypeError):
                cleaned[dim_key] = None
    if "suffix" in cleaned and cleaned["suffix"] is not None:
        cleaned["suffix"] = re.sub(r'[^a-zA-Z0-9_\-. ]', '', str(cleaned["suffix"])[:50])
    if "pdf_custom_dpi" in cleaned and cleaned["pdf_custom_dpi"] is not None:
        try:
            cleaned["pdf_custom_dpi"] = max(36, min(600, int(cleaned["pdf_custom_dpi"])))
        except (ValueError, TypeError):
            cleaned["pdf_custom_dpi"] = 150
    if "pdf_custom_quality" in cleaned and cleaned["pdf_custom_quality"] is not None:
        try:
            cleaned["pdf_custom_quality"] = max(1, min(100, int(cleaned["pdf_custom_quality"])))
        except (ValueError, TypeError):
            cleaned["pdf_custom_quality"] = 70

    return cleaned
