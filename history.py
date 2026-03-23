#!/usr/bin/env python3
"""Persistance historique, settings, presets et utilisateurs — avec file locking"""

import fcntl
import json
import os
import re
import shutil
import uuid
from datetime import datetime
from werkzeug.security import generate_password_hash, check_password_hash

CONFIG_DIR = os.path.expanduser("~/.config/compressor")
USERS_FILE = os.path.join(CONFIG_DIR, "users.json")
SESSION_FILE = os.path.join(CONFIG_DIR, "session.json")
USERS_DIR = os.path.join(CONFIG_DIR, "users")
MAX_HISTORY = 500

# Active user (set by login, used by _user_file)
_active_user_id = None

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

AVATAR_COLORS = [
    "#D0BCFF", "#CCC2DC", "#EFB8C8", "#81C784",
    "#FFB74D", "#42A5F5", "#EF5350", "#AB47BC",
]


def _ensure_dir():
    os.makedirs(CONFIG_DIR, exist_ok=True)


# ── User file path resolution ───────────────

def _user_dir(user_id: str) -> str:
    safe_id = re.sub(r'[^a-zA-Z0-9_-]', '', user_id)[:32]
    return os.path.join(USERS_DIR, safe_id)


def _user_file(filename: str) -> str:
    """Return per-user file path, or root fallback if no active user."""
    if _active_user_id:
        d = _user_dir(_active_user_id)
        os.makedirs(d, exist_ok=True)
        return os.path.join(d, filename)
    return os.path.join(CONFIG_DIR, filename)


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
    parent_dir = os.path.dirname(filepath)
    os.makedirs(parent_dir, exist_ok=True)
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


# ── Users ────────────────────────────────────

def set_active_user(user_id):
    global _active_user_id
    _active_user_id = user_id


def get_active_user_id():
    return _active_user_id


def load_users() -> dict:
    return _read_json_locked(USERS_FILE, default={"version": 1, "users": []})


def save_users(data: dict):
    _write_json_locked(USERS_FILE, data)


def load_session() -> dict:
    return _read_json_locked(SESSION_FILE, default={})


def save_session(data: dict):
    _write_json_locked(SESSION_FILE, data)


def create_user(name: str, password: str) -> dict:
    data = load_users()
    user_id = uuid.uuid4().hex[:12]
    avatar_color = AVATAR_COLORS[len(data["users"]) % len(AVATAR_COLORS)]
    user = {
        "id": user_id,
        "name": name.strip()[:30],
        "password_hash": generate_password_hash(password),
        "created_at": datetime.now().isoformat(),
        "avatar_color": avatar_color,
    }
    data["users"].append(user)
    save_users(data)
    os.makedirs(_user_dir(user_id), exist_ok=True)
    return user


def verify_user(user_id: str, password: str) -> bool:
    data = load_users()
    user = next((u for u in data["users"] if u["id"] == user_id), None)
    if not user:
        return False
    return check_password_hash(user["password_hash"], password)


def update_user(user_id: str, name: str = None, password: str = None):
    data = load_users()
    user = next((u for u in data["users"] if u["id"] == user_id), None)
    if not user:
        return None
    if name:
        user["name"] = name.strip()[:30]
    if password:
        user["password_hash"] = generate_password_hash(password)
        user.pop("must_change_password", None)  # Effacer le flag apres changement
    save_users(data)
    return user


def delete_user(user_id: str):
    data = load_users()
    data["users"] = [u for u in data["users"] if u["id"] != user_id]
    save_users(data)
    user_dir = _user_dir(user_id)
    if os.path.isdir(user_dir):
        shutil.rmtree(user_dir, ignore_errors=True)


def migrate_to_default_user():
    """Migration one-shot : deplace les fichiers root vers un user par defaut."""
    data = load_users()
    if data.get("users"):
        return  # Deja migre

    root_settings = os.path.join(CONFIG_DIR, "settings.json")
    root_presets = os.path.join(CONFIG_DIR, "presets.json")
    root_history = os.path.join(CONFIG_DIR, "history.json")

    has_data = any(os.path.isfile(f) for f in [root_settings, root_presets, root_history])
    if not has_data:
        return  # Fresh install

    # Mot de passe temporaire — l'utilisateur devra le changer
    user = create_user("Utilisateur", "compressor-temp-2024")
    # Marquer pour forcer le changement de mot de passe
    data = load_users()
    for u in data["users"]:
        if u["id"] == user["id"]:
            u["must_change_password"] = True
            break
    save_users(data)
    user_dir = _user_dir(user["id"])

    for filename in ["settings.json", "presets.json", "history.json"]:
        src = os.path.join(CONFIG_DIR, filename)
        dst = os.path.join(user_dir, filename)
        if os.path.isfile(src):
            shutil.copy2(src, dst)
            os.rename(src, src + ".bak")

    save_session({"active_user_id": user["id"]})
    set_active_user(user["id"])


# ── History ──────────────────────────────────

def load_history() -> list:
    return _read_json_locked(_user_file("history.json"), default=[])


def _save_history(entries: list):
    _write_json_locked(_user_file("history.json"), entries[-MAX_HISTORY:])


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
    saved = _read_json_locked(_user_file("settings.json"), default={})
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

    _write_json_locked(_user_file("settings.json"), cleaned)


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
    data = _read_json_locked(_user_file("presets.json"), default={})
    if not isinstance(data, dict) or "presets" not in data:
        return _default_presets_data()
    if "categories" not in data or not isinstance(data["categories"], list):
        data["categories"] = list(DEFAULT_CATEGORIES)
    if "active_preset_id" not in data:
        data["active_preset_id"] = None
    return data


def save_presets(data: dict):
    _write_json_locked(_user_file("presets.json"), data)


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
