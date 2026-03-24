#!/usr/bin/env python3
"""Compressor — App macOS de compression (Flask + pywebview)"""

import os
import re
import sys
import json
import logging
import threading
import queue
import time
import subprocess
import shutil
import base64
from datetime import datetime
from io import BytesIO

import webview
from flask import Flask, request, jsonify, render_template, Response, send_file

import config  # Charge .env et expose les constantes
from compressor import (
    compress_file, detect_format, expand_paths, estimate_file,
    CompressionSettings, SUPPORTED_EXTENSIONS,
)
from history import (
    add_entry, get_history, clear_history,
    get_stats, load_settings, save_settings,
    load_presets, save_presets, validate_preset_settings, generate_preset_id,
)

# ──────────────────────────────────────────────
#  Logging
# ──────────────────────────────────────────────

logging.basicConfig(
    level=getattr(logging, config.LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────
#  Flask app
# ──────────────────────────────────────────────

app = Flask(
    __name__,
    template_folder=os.path.join(config.APP_DIR, "templates"),
    static_folder=os.path.join(config.APP_DIR, "static"),
)

# ──────────────────────────────────────────────
#  App State — encapsule tout l'état mutable
# ──────────────────────────────────────────────

class AppState:
    """Encapsule l'état global mutable de l'application."""

    def __init__(self):
        self.queues_lock = threading.Lock()
        self.progress_queues: list[queue.Queue] = []
        self.compression_active = False
        self.tmp_dirs_lock = threading.Lock()
        self.pending_tmp_dirs: list[str] = []


state = AppState()

NOTIFIER = config.NOTIFIER_PATH
APP_DIR = config.APP_DIR
ICON_PATH = os.path.join(APP_DIR, "static", "icon.png")
VERSION_FILE = os.path.join(APP_DIR, "VERSION")


def _read_version() -> str:
    """Lit la version depuis le fichier VERSION."""
    try:
        with open(VERSION_FILE, "r") as f:
            return f.read().strip()
    except (FileNotFoundError, IOError):
        return "0.0.0"


def _parse_version(v: str) -> tuple:
    """Parse une version semver 'X.Y.Z' en tuple (X, Y, Z)."""
    try:
        parts = v.lstrip("v").split(".")
        return tuple(int(p) for p in parts[:3])
    except (ValueError, IndexError):
        return (0, 0, 0)


def _broadcast(data: dict):
    """Envoie un message SSE à tous les clients connectés (thread-safe)."""
    msg = f"data: {json.dumps(data)}\n\n"
    with state.queues_lock:
        dead = []
        for q in state.progress_queues:
            try:
                q.put_nowait(msg)
            except queue.Full:
                dead.append(q)
        for q in dead:
            state.progress_queues.remove(q)


def _notify(title: str, message: str, open_path: str = None):
    try:
        settings = load_settings()
        if not settings.get("notifications_enabled", True):
            return

        sent = False

        # Méthode 1 : terminal-notifier (supporte clic → ouvrir dossier)
        if os.path.isfile(NOTIFIER):
            cmd = [NOTIFIER, "-title", title, "-message", message,
                   "-sound", "default", "-sender", "com.apple.Terminal"]
            if open_path:
                cmd += ["-open", f"file://{open_path}"]
            r = subprocess.run(cmd, timeout=10, capture_output=True)
            sent = r.returncode == 0

        # Méthode 2 : osascript (natif, toujours dispo)
        if not sent:
            safe_title = title.replace('"', '\\"').replace("'", "\\'")
            safe_msg = message.replace('"', '\\"').replace("'", "\\'")
            subprocess.run([
                "osascript", "-e",
                f'display notification "{safe_msg}" with title "{safe_title}" sound name "default"'
            ], timeout=10)
    except Exception:
        pass


# ──────────────────────────────────────────────
#  Routes
# ──────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/expand", methods=["POST"])
def api_expand():
    """Pré-extraction des ZIP/dossiers en fichiers individuels."""
    data = request.json or {}
    paths = data.get("paths", [])
    if not isinstance(paths, list):
        return jsonify({"error": "paths doit etre une liste"}), 400
    for p in paths:
        if not isinstance(p, str):
            return jsonify({"error": f"Chemin invalide: {p}"}), 400
    files, tmp_dirs = expand_paths(paths)
    with state.tmp_dirs_lock:
        state.pending_tmp_dirs.extend(tmp_dirs)
    return jsonify({"files": files})


@app.route("/api/file-sizes", methods=["POST"])
def api_file_sizes():
    """Retourne la taille et dimensions de chaque fichier."""
    data = request.json or {}
    paths = data.get("paths", [])
    if not isinstance(paths, list):
        return jsonify({"error": "paths doit etre une liste"}), 400
    if len(paths) > 1000:
        return jsonify({"error": "Trop de chemins (max 1000)"}), 400
    sizes = {}
    dimensions = {}
    for p in paths:
        if not isinstance(p, str):
            continue
        ext = os.path.splitext(p)[1].lower()
        if ext not in SUPPORTED_EXTENSIONS:
            continue
        safe = os.path.realpath(p)
        if os.path.isfile(safe):
            try:
                sizes[p] = os.path.getsize(safe)
            except OSError:
                sizes[p] = 0
            # Get dimensions for images
            try:
                if ext in {".jpg", ".jpeg", ".png", ".webp"}:
                    from PIL import Image
                    with Image.open(safe) as img:
                        dimensions[p] = {"w": img.width, "h": img.height}
                elif ext == ".pdf":
                    import fitz
                    doc = fitz.open(safe)
                    if len(doc) > 0:
                        page = doc[0]
                        dimensions[p] = {
                            "w": int(page.rect.width),
                            "h": int(page.rect.height),
                            "pages": len(doc),
                        }
                    doc.close()
            except Exception:
                pass
    return jsonify({"sizes": sizes, "dimensions": dimensions})


@app.route("/api/estimate", methods=["POST"])
def api_estimate():
    """Estimation temps réel par sample compression.

    Reçoit la liste de fichiers + settings, retourne une estimation
    par fichier et par niveau (high/medium/low/custom).
    """
    data = request.json or {}
    paths = data.get("paths", [])
    s = data.get("settings", {})

    if not isinstance(paths, list) or len(paths) == 0:
        return jsonify({"error": "paths requis"}), 400
    if len(paths) > 100:
        return jsonify({"error": "Trop de fichiers (max 100)"}), 400

    # Paramètres communs
    out_fmt = s.get("output_format") or None
    if out_fmt and out_fmt not in ("jpeg", "png", "webp", "pdf"):
        out_fmt = None

    resize_mode = s.get("resize_mode", "none")
    if resize_mode not in ("none", "percent", "width", "height", "fit", "exact"):
        resize_mode = "none"

    resize_width = None
    if s.get("resize_width"):
        try:
            resize_width = max(1, min(10000, int(s["resize_width"])))
        except (ValueError, TypeError):
            resize_width = None

    resize_height = None
    if s.get("resize_height"):
        try:
            resize_height = max(1, min(10000, int(s["resize_height"])))
        except (ValueError, TypeError):
            resize_height = None

    resize_percent = 100
    if s.get("resize_percent"):
        try:
            resize_percent = max(1, min(100, int(s["resize_percent"])))
        except (ValueError, TypeError):
            resize_percent = 100

    lossless = bool(s.get("lossless", False))

    custom_q = max(1, min(100, int(s.get("custom_quality", 70))))
    pdf_custom_dpi = 150
    if s.get("pdf_custom_dpi"):
        try:
            pdf_custom_dpi = max(36, min(600, int(s["pdf_custom_dpi"])))
        except (ValueError, TypeError):
            pdf_custom_dpi = 150
    pdf_custom_quality = custom_q
    if s.get("pdf_custom_quality"):
        try:
            pdf_custom_quality = max(1, min(100, int(s["pdf_custom_quality"])))
        except (ValueError, TypeError):
            pdf_custom_quality = custom_q

    strip_metadata = bool(s.get("strip_metadata", False))

    target_size_kb = None
    if s.get("target_size_kb"):
        try:
            target_size_kb = max(1, int(s["target_size_kb"]))
        except (ValueError, TypeError):
            target_size_kb = None

    # Estimer seulement le niveau actif (les labels globaux sont masques)
    active_level = s.get("active_level", "medium")
    if active_level not in ("high", "medium", "low", "custom"):
        active_level = "medium"
    levels_to_estimate = [active_level]
    results = {}

    for path in paths:
        if not isinstance(path, str) or not os.path.isfile(path):
            continue

        ext = os.path.splitext(path)[1].lower()
        if ext not in SUPPORTED_EXTENSIONS:
            continue

        file_estimates = {}
        for level in levels_to_estimate:
            settings = CompressionSettings(
                level=level,
                custom_quality=pdf_custom_quality if (out_fmt == "pdf" and level == "custom") else custom_q,
                pdf_custom_dpi=pdf_custom_dpi,
                output_format=out_fmt,
                resize_mode=resize_mode,
                resize_width=resize_width,
                resize_height=resize_height,
                resize_percent=resize_percent,
                strip_metadata=strip_metadata,
                lossless=lossless,
                target_size_kb=target_size_kb,
            )
            est = estimate_file(path, settings)
            file_estimates[level] = est

        results[path] = file_estimates

    # Agrégation : totaux par niveau
    totals = {}
    for level in levels_to_estimate:
        total = 0
        for path, ests in results.items():
            if level in ests and "estimated_size" in ests[level]:
                total += ests[level]["estimated_size"]
        totals[level] = total

    return jsonify({"estimates": results, "totals": totals})


def _apply_rename_template(template, src_path, index, total, output_path, clean=True):
    """Applique un template de renommage. Retourne le nouveau nom de fichier complet."""
    try:
        base_name = os.path.splitext(os.path.basename(src_path))[0]
        out_ext = os.path.splitext(output_path)[1]  # .png, .jpg, etc.

        if clean:
            base_name = _clean_filename(base_name)

        # Dimensions du fichier de sortie
        w, h = "0", "0"
        try:
            from PIL import Image
            with Image.open(output_path) as img:
                w, h = str(img.width), str(img.height)
        except Exception:
            pass

        folder = os.path.basename(os.path.dirname(src_path))
        today = datetime.now().strftime("%Y-%m-%d")
        fmt = out_ext.lstrip(".").lower()

        result = template
        result = re.sub(r'\{nom\}', base_name, result, flags=re.IGNORECASE)
        result = re.sub(r'\{index\}', str(index + 1).zfill(2), result, flags=re.IGNORECASE)
        result = re.sub(r'\{largeur\}', w, result, flags=re.IGNORECASE)
        result = re.sub(r'\{hauteur\}', h, result, flags=re.IGNORECASE)
        result = re.sub(r'\{dossier\}', folder, result, flags=re.IGNORECASE)
        result = re.sub(r'\{date\}', today, result, flags=re.IGNORECASE)
        result = re.sub(r'\{format\}', fmt, result, flags=re.IGNORECASE)

        # Sanitize le résultat final
        result = re.sub(r'[<>:"/\\|?*]', '', result)
        if not result.strip():
            return None
        return result.strip() + out_ext
    except Exception:
        return None


def _clean_filename(name):
    """Nettoie un nom de fichier : retire caractères non-latins, normalise."""
    # Retirer les caractères non-ASCII (chinois, etc.)
    cleaned = re.sub(r'[^\x00-\x7F]', '', name)
    # Espaces et underscores → tirets
    cleaned = re.sub(r'[\s_]+', '-', cleaned)
    # Garder alphanum, tirets, points
    cleaned = re.sub(r'[^a-zA-Z0-9\-.]', '', cleaned)
    # Fusionner tirets multiples
    cleaned = re.sub(r'-{2,}', '-', cleaned)
    # Retirer tirets début/fin
    cleaned = cleaned.strip('-')
    # Minuscules
    cleaned = cleaned.lower()
    return cleaned or "image"


@app.route("/api/compress", methods=["POST"])
def api_compress():
    if state.compression_active:
        return jsonify({"error": "Compression deja en cours"}), 409

    data = request.json or {}
    raw_files = data.get("files", [])

    # — Validation des entrées —
    if not isinstance(raw_files, list):
        return jsonify({"error": "Le champ 'files' doit etre une liste"}), 400
    for p in raw_files:
        if not isinstance(p, str):
            return jsonify({"error": f"Chemin invalide: {p}"}), 400

    # expand_paths gère les ZIP, dossiers, et fichiers individuels
    # (les ZIP sont normalement déjà expandés par /api/expand côté frontend)
    files, tmp_dirs = expand_paths(raw_files)
    if not files:
        return jsonify({"error": "Aucun fichier supporte"}), 400

    s = data.get("settings", {})
    level = s.get("level", "medium")
    if level not in ("high", "medium", "low", "custom"):
        level = "medium"

    custom_q = max(1, min(100, int(s.get("custom_quality", 70))))
    max_res = None
    if s.get("max_resolution"):
        max_res = max(100, min(10000, int(s["max_resolution"])))

    out_fmt = s.get("output_format") or None
    if out_fmt and out_fmt not in ("jpeg", "png", "webp", "pdf"):
        out_fmt = None

    target_kb = None
    if s.get("target_size_kb"):
        target_kb = max(10, min(50000, int(s["target_size_kb"])))

    output_dir = s.get("output_dir") or None
    if output_dir and not os.path.isdir(output_dir):
        return jsonify({"error": f"Dossier de sortie introuvable: {output_dir}"}), 400

    # ── Phase 2 : nouveaux champs ──
    resize_mode = s.get("resize_mode", "none")
    if resize_mode not in ("none", "percent", "width", "height", "fit", "exact"):
        resize_mode = "none"

    resize_width = None
    if s.get("resize_width"):
        try:
            resize_width = max(1, min(10000, int(s["resize_width"])))
        except (ValueError, TypeError):
            resize_width = None

    resize_height = None
    if s.get("resize_height"):
        try:
            resize_height = max(1, min(10000, int(s["resize_height"])))
        except (ValueError, TypeError):
            resize_height = None

    resize_percent = 100
    if s.get("resize_percent"):
        try:
            resize_percent = max(1, min(100, int(s["resize_percent"])))
        except (ValueError, TypeError):
            resize_percent = 100

    strip_metadata = bool(s.get("strip_metadata", False))
    raw_suffix = str(s.get("suffix", ""))[:50]
    # Sanitize : garder uniquement alphanum, -, _, . et espaces
    suffix = re.sub(r'[^a-zA-Z0-9_\-. ]', '', raw_suffix)
    keep_date = bool(s.get("keep_date", False))
    lossless = bool(s.get("lossless", False))
    pdf_multi_level = bool(s.get("pdf_multi_level", False))

    # PDF custom DPI + quality
    pdf_custom_dpi = 150
    if s.get("pdf_custom_dpi"):
        try:
            pdf_custom_dpi = max(36, min(600, int(s["pdf_custom_dpi"])))
        except (ValueError, TypeError):
            pdf_custom_dpi = 150

    pdf_custom_quality = custom_q
    if s.get("pdf_custom_quality"):
        try:
            pdf_custom_quality = max(1, min(100, int(s["pdf_custom_quality"])))
        except (ValueError, TypeError):
            pdf_custom_quality = custom_q

    # Rename template
    rename_template = str(s.get("rename_template", ""))[:100]
    rename_clean = bool(s.get("rename_clean", True))

    # Folder bac settings (per-folder rename + preset)
    raw_folder_settings = data.get("folder_settings", {})
    folder_settings_map = {}  # { "Accessoires": { rename_template, preset_settings } }
    if isinstance(raw_folder_settings, dict):
        for folder_name, fs in raw_folder_settings.items():
            if not isinstance(fs, dict):
                continue
            folder_settings_map[folder_name] = {
                "rename_template": str(fs.get("rename_template", ""))[:100],
                "preset_settings": fs.get("preset_settings"),
            }

    # Source root dir pour export structure
    source_root_dir = data.get("source_root_dir") or None
    if source_root_dir:
        source_root_dir = os.path.realpath(source_root_dir)
        if not os.path.isdir(source_root_dir):
            source_root_dir = None

    settings = CompressionSettings(
        level=level,
        custom_quality=pdf_custom_quality if (out_fmt == "pdf" and level == "custom") else custom_q,
        pdf_custom_dpi=pdf_custom_dpi,
        max_resolution=max_res,
        output_format=out_fmt,
        target_size_kb=target_kb,
        output_dir=output_dir,
        resize_mode=resize_mode,
        resize_width=resize_width,
        resize_height=resize_height,
        resize_percent=resize_percent,
        strip_metadata=strip_metadata,
        suffix=suffix,
        keep_date=keep_date,
        lossless=lossless,
        source_root_dir=source_root_dir,
    )

    # Per-format settings (from format config modal)
    format_settings_map = {}  # {"jpeg": CompressionSettings(...), ...}
    raw_format_settings = data.get("format_settings", {})
    if isinstance(raw_format_settings, dict):
        for fmt, fmt_s in raw_format_settings.items():
            if not isinstance(fmt_s, dict):
                continue
            fmt_level = fmt_s.get("level", level)
            if fmt_level not in ("high", "medium", "low", "custom"):
                fmt_level = "medium"
            fmt_cq = max(1, min(100, int(fmt_s.get("custom_quality", 70))))
            fmt_out = fmt_s.get("output_format") or None
            fmt_resize = fmt_s.get("resize_mode", "none")
            fmt_rw = None
            if fmt_s.get("resize_width"):
                try: fmt_rw = max(1, min(10000, int(fmt_s["resize_width"])))
                except: pass
            fmt_rh = None
            if fmt_s.get("resize_height"):
                try: fmt_rh = max(1, min(10000, int(fmt_s["resize_height"])))
                except: pass
            fmt_rp = max(1, min(100, int(fmt_s.get("resize_percent", 100))))
            fmt_suffix = fmt_s.get("suffix", suffix)
            if fmt_suffix:
                fmt_suffix = fmt_suffix.replace("/", "").replace("\\", "").replace("..", "")

            format_settings_map[fmt] = CompressionSettings(
                level=fmt_level,
                custom_quality=fmt_cq,
                max_resolution=max_res,
                output_format=fmt_out,
                target_size_kb=fmt_s.get("target_size_kb"),
                output_dir=output_dir,
                resize_mode=fmt_resize,
                resize_width=fmt_rw,
                resize_height=fmt_rh,
                resize_percent=fmt_rp,
                strip_metadata=fmt_s.get("strip_metadata", False),
                suffix=fmt_suffix if fmt_suffix else "",
                keep_date=fmt_s.get("keep_date", False),
                lossless=fmt_s.get("lossless", False),
                source_root_dir=source_root_dir,
            )

    def run():
        state.compression_active = True
        try:
            results = []

            if pdf_multi_level:
                # ── PDF multi-level: 3 compressions per file ──
                from compressor import PDF_LEVELS
                levels = ["high", "medium", "low"]
                total = len(files) * 3
                global_index = 0

                for parent_idx, fpath in enumerate(files):
                    fname = os.path.basename(fpath)
                    ext = os.path.splitext(fpath)[1].lower()

                    if ext != ".pdf":
                        _broadcast({
                            "type": "file_error", "index": global_index,
                            "parent_index": parent_idx,
                            "filename": fname, "error": "Pas un PDF",
                        })
                        global_index += 3  # skip 3 slots
                        continue

                    for lvl in levels:
                        lvl_suffix = f"{suffix}_{lvl}" if suffix else f"_{lvl}"
                        lvl_settings = CompressionSettings(
                            level=lvl,
                            custom_quality=custom_q,
                            max_resolution=max_res,
                            output_format="pdf",
                            target_size_kb=None,
                            output_dir=output_dir,
                            resize_mode="none",
                            resize_width=None,
                            resize_height=None,
                            resize_percent=100,
                            strip_metadata=strip_metadata,
                            suffix=lvl_suffix,
                            keep_date=keep_date,
                            lossless=False,
                            source_root_dir=source_root_dir,
                        )
                        _broadcast({
                            "type": "file_start", "index": global_index, "total": total,
                            "parent_index": parent_idx, "sub_level": lvl,
                            "filename": fname,
                        })
                        try:
                            def page_cb(page, total_pages, _gi=global_index, _pi=parent_idx):
                                _broadcast({
                                    "type": "page_progress",
                                    "file_index": _gi, "parent_index": _pi,
                                    "page": page, "total_pages": total_pages,
                                })

                            result = compress_file(fpath, lvl_settings, progress_cb=page_cb)
                            result.level = lvl
                            add_entry(result.to_dict())
                            results.append(result.to_dict())
                            _broadcast({
                                "type": "file_done", "index": global_index, "total": total,
                                "parent_index": parent_idx, "sub_level": lvl,
                                "result": result.to_dict(),
                            })
                        except Exception as e:
                            logger.exception("Erreur compression PDF %s [%s]: %s", fname, lvl, e)
                            _broadcast({
                                "type": "file_error", "index": global_index,
                                "parent_index": parent_idx, "sub_level": lvl,
                                "filename": fname, "error": str(e),
                            })
                        global_index += 1
            else:
                # ── Standard single compression ──
                total = len(files)
                folder_index_counters = {}  # Per-folder index for rename
                for i, fpath in enumerate(files):
                    fname = os.path.basename(fpath)
                    # Choisir les settings selon le format du fichier
                    file_fmt = detect_format(fpath)
                    file_settings = format_settings_map.get(file_fmt, settings)

                    # Per-folder bac: override rename_template + settings
                    file_folder = None
                    file_rename_template = rename_template
                    if source_root_dir:
                        rel = os.path.relpath(fpath, source_root_dir)
                        parts = rel.split(os.sep)
                        if len(parts) > 1:
                            file_folder = parts[0]
                    if file_folder and file_folder in folder_settings_map:
                        fs = folder_settings_map[file_folder]
                        if fs.get("rename_template"):
                            file_rename_template = fs["rename_template"]
                        if fs.get("preset_settings"):
                            # Build per-folder settings (same logic as format_settings_map)
                            ps = fs["preset_settings"]
                            from compressor import CompressionSettings as CS
                            file_settings = CS(
                                level=ps.get("level", file_settings.level),
                                custom_quality=max(1, min(100, int(ps.get("custom_quality", file_settings.custom_quality)))),
                                max_resolution=file_settings.max_resolution,
                                output_format=ps.get("output_format") or file_settings.output_format,
                                target_size_kb=ps.get("target_size_kb", file_settings.target_size_kb),
                                output_dir=file_settings.output_dir,
                                resize_mode=ps.get("resize_mode", file_settings.resize_mode),
                                resize_width=ps.get("resize_width", file_settings.resize_width),
                                resize_height=ps.get("resize_height", file_settings.resize_height),
                                resize_percent=ps.get("resize_percent", file_settings.resize_percent),
                                strip_metadata=ps.get("strip_metadata", file_settings.strip_metadata),
                                suffix=ps.get("suffix", file_settings.suffix) or "",
                                keep_date=ps.get("keep_date", file_settings.keep_date),
                                lossless=ps.get("lossless", file_settings.lossless),
                                source_root_dir=file_settings.source_root_dir,
                            )

                    _broadcast({"type": "file_start", "index": i, "total": total, "filename": fname})
                    try:
                        def page_cb(page, total_pages, _i=i):
                            _broadcast({
                                "type": "page_progress",
                                "file_index": _i, "page": page, "total_pages": total_pages,
                            })

                        result = compress_file(fpath, file_settings, progress_cb=page_cb)
                        result.level = file_settings.level

                        # Renommage par lot
                        if file_rename_template and result.output_path and os.path.isfile(result.output_path):
                            # Per-folder index (reset par dossier)
                            folder_key = file_folder or "__global__"
                            if folder_key not in folder_index_counters:
                                folder_index_counters[folder_key] = 0
                            file_index = folder_index_counters[folder_key]
                            folder_index_counters[folder_key] += 1

                            new_name = _apply_rename_template(
                                file_rename_template, fpath, file_index, total,
                                result.output_path, rename_clean
                            )
                            if new_name:
                                new_path = os.path.join(os.path.dirname(result.output_path), new_name)
                                # Eviter écrasement
                                base, ext = os.path.splitext(new_path)
                                counter = 1
                                while os.path.exists(new_path) and new_path != result.output_path:
                                    new_path = f"{base}-{counter}{ext}"
                                    counter += 1
                                os.rename(result.output_path, new_path)
                                result.output_path = new_path

                        add_entry(result.to_dict())
                        results.append(result.to_dict())
                        _broadcast({"type": "file_done", "index": i, "total": total, "result": result.to_dict()})
                    except Exception as e:
                        logger.exception("Erreur compression: %s", fpath)
                        _broadcast({"type": "file_error", "index": i, "filename": fname, "error": str(e)})

            # Summary
            total_orig = sum(r["original_size"] for r in results)
            total_comp = sum(r["compressed_size"] for r in results)
            saved_mb = (total_orig - total_comp) / 1048576
            # Determine output directory from first result
            batch_output_dir = None
            if results:
                batch_output_dir = os.path.dirname(results[0].get("output_path", ""))
            _broadcast({"type": "batch_done", "count": len(results), "saved_mb": round(saved_mb, 1), "output_dir": batch_output_dir})
            _notify(
                "Compression terminee",
                f"{len(results)} fichier(s) — {saved_mb:.1f} MB economises",
                open_path=batch_output_dir,
            )
        except Exception:
            logger.exception("Erreur fatale dans le thread de compression")
        finally:
            state.compression_active = False
            # Nettoyer les dossiers temporaires (extraction ZIP)
            with state.tmp_dirs_lock:
                all_tmps = list(set(tmp_dirs + state.pending_tmp_dirs))
                state.pending_tmp_dirs.clear()
            for tmp_dir in all_tmps:
                try:
                    shutil.rmtree(tmp_dir, ignore_errors=True)
                except Exception:
                    pass

    threading.Thread(target=run, daemon=True).start()
    return jsonify({"status": "started", "total": len(files)})


@app.route("/api/progress")
def api_progress():
    q = queue.Queue(maxsize=200)
    with state.queues_lock:
        state.progress_queues.append(q)

    def generate():
        try:
            while True:
                try:
                    msg = q.get(timeout=30)
                    yield msg
                except queue.Empty:
                    yield "data: {\"type\": \"keepalive\"}\n\n"
        except GeneratorExit:
            pass
        finally:
            with state.queues_lock:
                if q in state.progress_queues:
                    state.progress_queues.remove(q)

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/api/history")
def api_history():
    limit = request.args.get("limit", 50, type=int)
    return jsonify({"entries": get_history(limit=limit), "stats": get_stats()})


@app.route("/api/history/clear", methods=["POST"])
def api_clear_history():
    clear_history()
    return jsonify({"ok": True})


@app.route("/api/open-folder", methods=["POST"])
def api_open_folder():
    data = request.get_json(silent=True) or {}
    folder = data.get("path")
    if not folder or not os.path.isdir(folder):
        return jsonify({"error": "Dossier introuvable"}), 400
    import subprocess
    subprocess.Popen(["open", folder])
    return jsonify({"ok": True})


@app.route("/api/settings", methods=["GET"])
def api_get_settings():
    return jsonify(load_settings())


@app.route("/api/settings", methods=["POST"])
def api_save_settings():
    save_settings(request.json or {})
    return jsonify({"ok": True})


# ──────────────────────────────────────────────
#  Presets API
# ──────────────────────────────────────────────

@app.route("/api/presets", methods=["GET"])
def api_get_presets():
    return jsonify(load_presets())


@app.route("/api/presets", methods=["POST"])
def api_create_preset():
    body = request.get_json(silent=True) or {}
    name = str(body.get("name", "")).strip()
    if not name:
        return jsonify({"error": "Nom requis"}), 400
    category = body.get("category") or None
    settings = validate_preset_settings(body.get("settings", {}))

    data = load_presets()
    preset = {
        "id": generate_preset_id(),
        "name": name,
        "category": category,
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
        "settings": settings,
    }
    data["presets"].append(preset)
    data["active_preset_id"] = preset["id"]
    save_presets(data)
    return jsonify({"ok": True, "preset": preset})


@app.route("/api/presets/<preset_id>", methods=["PUT"])
def api_update_preset(preset_id):
    body = request.get_json(silent=True) or {}
    data = load_presets()
    preset = next((p for p in data["presets"] if p["id"] == preset_id), None)
    if not preset:
        return jsonify({"error": "Preset introuvable"}), 404

    if "name" in body:
        name = str(body["name"]).strip()
        if name:
            preset["name"] = name
    if "category" in body:
        preset["category"] = body["category"] or None
    if "settings" in body:
        preset["settings"] = validate_preset_settings(body["settings"])
    preset["updated_at"] = datetime.now().isoformat()

    save_presets(data)
    return jsonify({"ok": True, "preset": preset})


@app.route("/api/presets/<preset_id>", methods=["DELETE"])
def api_delete_preset(preset_id):
    data = load_presets()
    data["presets"] = [p for p in data["presets"] if p["id"] != preset_id]
    if data["active_preset_id"] == preset_id:
        data["active_preset_id"] = None
    save_presets(data)
    return jsonify({"ok": True})


@app.route("/api/presets/active", methods=["POST"])
def api_set_active_preset():
    body = request.get_json(silent=True) or {}
    data = load_presets()
    data["active_preset_id"] = body.get("id") or None
    save_presets(data)
    return jsonify({"ok": True})


@app.route("/api/presets/categories", methods=["POST"])
def api_add_category():
    body = request.get_json(silent=True) or {}
    name = str(body.get("name", "")).strip()
    if not name:
        return jsonify({"error": "Nom requis"}), 400
    data = load_presets()
    if name not in data["categories"]:
        data["categories"].append(name)
        save_presets(data)
    return jsonify({"ok": True, "categories": data["categories"]})


@app.route("/api/presets/categories/delete", methods=["POST"])
def api_delete_category():
    body = request.get_json(silent=True) or {}
    name = str(body.get("name", "")).strip()
    if not name:
        return jsonify({"error": "Nom requis"}), 400
    data = load_presets()
    if name not in data["categories"]:
        return jsonify({"error": "Categorie introuvable"}), 404
    data["categories"].remove(name)
    # Reassign presets from this category to null
    for p in data["presets"]:
        if p.get("category") == name:
            p["category"] = None
    save_presets(data)
    return jsonify({"ok": True, "categories": data["categories"]})


@app.route("/api/presets/categories/rename", methods=["POST"])
def api_rename_category():
    body = request.get_json(silent=True) or {}
    old_name = str(body.get("old_name", "")).strip()
    new_name = str(body.get("new_name", "")).strip()
    if not old_name or not new_name:
        return jsonify({"error": "Ancien et nouveau nom requis"}), 400
    data = load_presets()
    if old_name not in data["categories"]:
        return jsonify({"error": "Categorie introuvable"}), 404
    if new_name in data["categories"] and new_name != old_name:
        return jsonify({"error": "Cette categorie existe deja"}), 409
    # Rename in categories list
    idx = data["categories"].index(old_name)
    data["categories"][idx] = new_name
    # Update all presets referencing old name
    for p in data["presets"]:
        if p.get("category") == old_name:
            p["category"] = new_name
    save_presets(data)
    return jsonify({"ok": True, "categories": data["categories"]})


# ──────────────────────────────────────────────
#  Presets Import/Export (below)
# ──────────────────────────────────────────────

# ──────────────────────────────────────────────
#  Presets Import/Export
# ──────────────────────────────────────────────

@app.route("/api/presets/import", methods=["POST"])
def api_import_presets():
    body = request.get_json(silent=True) or {}
    import_presets = body.get("presets", [])
    if not isinstance(import_presets, list) or not import_presets:
        return jsonify({"error": "Aucun preset a importer"}), 400

    data = load_presets()
    existing_names = {p["name"] for p in data["presets"]}
    imported = 0
    for p in import_presets:
        if not isinstance(p, dict) or not p.get("name"):
            continue
        settings = validate_preset_settings(p.get("settings", {}))
        name = str(p["name"]).strip()
        # Deduplicate names
        final_name = name
        counter = 2
        while final_name in existing_names:
            final_name = f"{name} ({counter})"
            counter += 1
        category = p.get("category") or None
        if category and category not in data["categories"]:
            data["categories"].append(category)
        preset = {
            "id": generate_preset_id(),
            "name": final_name,
            "category": category,
            "created_at": datetime.now().isoformat(),
            "updated_at": datetime.now().isoformat(),
            "settings": settings,
        }
        data["presets"].append(preset)
        existing_names.add(final_name)
        imported += 1

    save_presets(data)
    return jsonify({"ok": True, "imported": imported})


@app.route("/api/presets/export", methods=["POST"])
def api_export_presets():
    body = request.get_json(silent=True) or {}
    ids = body.get("ids")
    data = load_presets()
    if ids:
        presets = [p for p in data["presets"] if p["id"] in ids]
    else:
        presets = data["presets"]
    export_data = {
        "app": "compressor",
        "version": 1,
        "exported_at": datetime.now().isoformat(),
        "presets": presets,
    }
    return jsonify(export_data)


# ──────────────────────────────────────────────
#  App version & Updates
# ──────────────────────────────────────────────

@app.route("/api/app/version")
def api_app_version():
    return jsonify({"version": _read_version()})


def _github_api_request(path: str):
    """Fait une requete a l'API GitHub avec token si dispo (repo prive)."""
    import urllib.request
    url = f"https://api.github.com/repos/{config.GITHUB_REPO}/{path}"
    headers = {"Accept": "application/vnd.github.v3+json"}
    if config.GITHUB_TOKEN:
        headers["Authorization"] = f"token {config.GITHUB_TOKEN}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


def _github_download_asset(asset_url: str, dest_path: str):
    """Telecharge un asset GitHub (gere l'auth pour repos prives)."""
    import urllib.request
    headers = {"Accept": "application/octet-stream"}
    if config.GITHUB_TOKEN:
        headers["Authorization"] = f"token {config.GITHUB_TOKEN}"
    req = urllib.request.Request(asset_url, headers=headers)
    with urllib.request.urlopen(req, timeout=300) as resp:
        with open(dest_path, "wb") as f:
            while True:
                chunk = resp.read(8192)
                if not chunk:
                    break
                f.write(chunk)


# Cache la derniere release pour eviter de re-fetcher entre check et apply
_latest_release_cache = {}


@app.route("/api/updates/check")
def api_updates_check():
    """Verifie les mises a jour — GitHub Releases (bundle) ou git tags (dev)."""
    current_version = _read_version()

    if config.IS_BUNDLED:
        try:
            release = _github_api_request("releases/latest")
            _latest_release_cache.clear()
            _latest_release_cache.update(release)

            latest_version = release.get("tag_name", "").lstrip("v")
            update_available = _parse_version(latest_version) > _parse_version(current_version)
            changelog = release.get("body", "")

            return jsonify({
                "current_version": current_version,
                "latest_version": latest_version,
                "update_available": update_available,
                "changelog": changelog,
                "is_bundled": True,
            })
        except Exception as e:
            logger.exception("Erreur check updates (bundle)")
            return jsonify({"error": str(e), "update_available": False})
    else:
        # Mode dev : check via git tags
        try:
            result = subprocess.run(
                ["git", "rev-parse", "--is-inside-work-tree"],
                cwd=APP_DIR, capture_output=True, text=True, timeout=5,
            )
            if result.returncode != 0:
                return jsonify({"error": "Pas un depot git", "update_available": False})

            fetch = subprocess.run(
                ["git", "fetch", "--tags", "--quiet"],
                cwd=APP_DIR, capture_output=True, text=True, timeout=30,
            )
            if fetch.returncode != 0:
                logger.warning("git fetch --tags failed: %s", fetch.stderr)
                return jsonify({"error": "Impossible de contacter le serveur", "update_available": False})

            tags = subprocess.run(
                ["git", "tag", "--sort=-v:refname"],
                cwd=APP_DIR, capture_output=True, text=True, timeout=5,
            )
            tag_list = [t.strip() for t in tags.stdout.strip().split("\n") if t.strip()]
            if not tag_list:
                return jsonify({"error": "Aucun tag trouve", "update_available": False})

            latest_tag = tag_list[0]
            latest_version = latest_tag.lstrip("v")
            update_available = _parse_version(latest_version) > _parse_version(current_version)

            changelog = ""
            if update_available:
                msg = subprocess.run(
                    ["git", "tag", "-l", "--format=%(contents)", latest_tag],
                    cwd=APP_DIR, capture_output=True, text=True, timeout=5,
                )
                changelog = msg.stdout.strip()

            return jsonify({
                "current_version": current_version,
                "latest_version": latest_version,
                "latest_tag": latest_tag,
                "update_available": update_available,
                "changelog": changelog,
                "is_bundled": False,
            })
        except subprocess.TimeoutExpired:
            return jsonify({"error": "Timeout lors de la verification", "update_available": False})
        except Exception as e:
            logger.exception("Erreur check updates")
            return jsonify({"error": str(e), "update_available": False})


@app.route("/api/updates/apply", methods=["POST"])
def api_updates_apply():
    """Applique la mise a jour — auto-replace (bundle) ou git pull (dev)."""
    if config.IS_BUNDLED:
        import tempfile
        tmp_dir = None
        mount_point = None

        try:
            # Trouver l'asset DMG dans le cache de la derniere release
            release = _latest_release_cache
            if not release:
                return jsonify({"ok": False, "error": "Verifiez d'abord les mises a jour"}), 400

            asset_url = None
            asset_name = "Compressor-update.dmg"
            for asset in release.get("assets", []):
                if asset.get("name", "").endswith(".dmg"):
                    asset_url = asset.get("url")  # API URL (pas browser URL)
                    asset_name = asset["name"]
                    break
            if not asset_url:
                return jsonify({"ok": False, "error": "Aucun DMG dans cette release"}), 400

            # Trouver le .app actuel
            app_bundle = os.path.realpath(sys.executable)
            while app_bundle and not app_bundle.endswith(".app"):
                app_bundle = os.path.dirname(app_bundle)
            if not app_bundle or not os.path.isdir(app_bundle):
                return jsonify({"ok": False, "error": "Impossible de localiser l'application"}), 500

            logger.info("App bundle: %s", app_bundle)

            # Telecharger le DMG via l'API GitHub (authentifie)
            tmp_dir = tempfile.mkdtemp(prefix="compressor-update-")
            dmg_path = os.path.join(tmp_dir, asset_name)
            logger.info("Telechargement: %s", asset_url)
            _github_download_asset(asset_url, dmg_path)

            # Monter le DMG
            mount_result = subprocess.run(
                ["hdiutil", "attach", dmg_path, "-nobrowse", "-quiet"],
                capture_output=True, text=True, timeout=30,
            )
            if mount_result.returncode != 0:
                return jsonify({"ok": False, "error": "Impossible de monter le DMG"}), 500

            mount_point = None
            for line in mount_result.stdout.strip().split("\n"):
                parts = line.split("\t")
                if len(parts) >= 3:
                    mount_point = parts[-1].strip()
            if not mount_point:
                return jsonify({"ok": False, "error": "Point de montage introuvable"}), 500

            # Trouver le .app dans le DMG
            new_app = None
            for item in os.listdir(mount_point):
                if item.endswith(".app"):
                    new_app = os.path.join(mount_point, item)
                    break
            if not new_app:
                return jsonify({"ok": False, "error": "Aucune app dans le DMG"}), 500

            # Remplacer avec backup + rollback
            old_backup = app_bundle + ".old"
            if os.path.exists(old_backup):
                shutil.rmtree(old_backup, ignore_errors=True)
            os.rename(app_bundle, old_backup)
            try:
                shutil.copytree(new_app, app_bundle)
                logger.info("App remplacee avec succes")
            except Exception:
                # Rollback
                if not os.path.exists(app_bundle) and os.path.exists(old_backup):
                    os.rename(old_backup, app_bundle)
                raise
            shutil.rmtree(old_backup, ignore_errors=True)

            # Demonter + cleanup + relancer
            subprocess.run(["hdiutil", "detach", mount_point, "-quiet"], timeout=10)
            mount_point = None
            shutil.rmtree(tmp_dir, ignore_errors=True)
            tmp_dir = None

            subprocess.Popen(["open", app_bundle])

            return jsonify({
                "ok": True,
                "message": "Mise a jour installee. Redemarrage...",
                "restarting": True,
            })
        except Exception as e:
            logger.exception("Erreur mise a jour bundle")
            # Cleanup en cas d'erreur
            if mount_point:
                subprocess.run(["hdiutil", "detach", mount_point, "-quiet"], timeout=10)
            if tmp_dir and os.path.isdir(tmp_dir):
                shutil.rmtree(tmp_dir, ignore_errors=True)
            return jsonify({"ok": False, "error": str(e)}), 500

    try:
        result = subprocess.run(
            ["git", "pull", "--ff-only"],
            cwd=APP_DIR, capture_output=True, text=True, timeout=60,
        )
        if result.returncode != 0:
            return jsonify({"ok": False, "error": result.stderr.strip() or "git pull a echoue"}), 500

        new_version = _read_version()
        return jsonify({
            "ok": True,
            "message": "Mise a jour installee. Redemarrez l'application.",
            "new_version": new_version,
        })
    except subprocess.TimeoutExpired:
        return jsonify({"ok": False, "error": "Timeout lors de la mise a jour"}), 500
    except Exception as e:
        logger.exception("Erreur apply update")
        return jsonify({"ok": False, "error": str(e)}), 500


# ──────────────────────────────────────────────
#  Security headers
# ──────────────────────────────────────────────

@app.after_request
def add_security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.route("/api/preview", methods=["POST"])
def api_preview():
    data = request.json or {}
    orig_path = data.get("original", "")
    comp_path = data.get("compressed", "")

    # — Protection path traversal —
    for p in (orig_path, comp_path):
        if not p or not os.path.isfile(p):
            return jsonify({"error": f"Fichier introuvable: {p}"}), 400
        # Vérifier que c'est un format supporté
        ext = os.path.splitext(p)[1].lower()
        if ext not in SUPPORTED_EXTENSIONS:
            return jsonify({"error": f"Format non supporte: {ext}"}), 400
        # Bloquer les chemins suspects
        real = os.path.realpath(p)
        if ".." in os.path.relpath(real, os.path.dirname(real)):
            return jsonify({"error": "Chemin invalide"}), 400

    def make_thumb(path: str) -> str:
        ext = os.path.splitext(path)[1].lower()
        if ext == ".pdf":
            import fitz
            doc = fitz.open(path)
            try:
                page = doc[0]
                pix = page.get_pixmap(matrix=fitz.Matrix(2.0, 2.0))
                img_bytes = pix.tobytes(output="png")
            finally:
                doc.close()
        else:
            from PIL import Image
            img = Image.open(path)
            try:
                img.thumbnail((1600, 1600), Image.LANCZOS)
                buf = BytesIO()
                fmt = "PNG" if img.mode == "RGBA" else "JPEG"
                save_kwargs = {"format": fmt}
                if fmt == "JPEG":
                    save_kwargs["quality"] = 95
                    save_kwargs["subsampling"] = 0  # 4:4:4
                img.save(buf, **save_kwargs)
                img_bytes = buf.getvalue()
            finally:
                img.close()
        return base64.b64encode(img_bytes).decode("ascii")

    try:
        return jsonify({
            "original": {
                "base64": make_thumb(orig_path),
                "size": os.path.getsize(orig_path),
            },
            "compressed": {
                "base64": make_thumb(comp_path),
                "size": os.path.getsize(comp_path),
            },
        })
    except Exception as e:
        logger.exception("Erreur preview")
        return jsonify({"error": str(e)}), 500


# ──────────────────────────────────────────────
#  Serve files in full quality (no downscaling)
# ──────────────────────────────────────────────

_SERVE_MIME = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".webp": "image/webp",
}


@app.route("/api/serve")
def api_serve():
    """Serve an image/PDF file in full original quality."""
    path = request.args.get("path", "")
    if not path or not os.path.isfile(path):
        return Response(status=404)

    ext = os.path.splitext(path)[1].lower()
    if ext not in SUPPORTED_EXTENSIONS:
        return Response(status=400)

    real = os.path.realpath(path)

    if ext == ".pdf":
        import fitz
        doc = fitz.open(real)
        try:
            page = doc[0]
            pix = page.get_pixmap(matrix=fitz.Matrix(3.0, 3.0))
            img_bytes = pix.tobytes(output="png")
        finally:
            doc.close()
        return Response(
            img_bytes, mimetype="image/png",
            headers={"Cache-Control": "private, max-age=300"},
        )

    return send_file(
        real,
        mimetype=_SERVE_MIME.get(ext, "application/octet-stream"),
    )


# ──────────────────────────────────────────────
#  Thumbnail API (cache memoire)
# ──────────────────────────────────────────────

_thumb_cache = {}
_THUMB_CACHE_MAX = 200


@app.route("/api/thumbnail")
def api_thumbnail():
    """Genere et retourne un thumbnail pour un fichier (image ou PDF)."""
    path = request.args.get("path", "")
    size = request.args.get("size", 128, type=int)
    size = max(32, min(512, size))

    if not path or not os.path.isfile(path):
        return Response(status=404)

    ext = os.path.splitext(path)[1].lower()
    if ext not in SUPPORTED_EXTENSIONS:
        return Response(status=400)

    real = os.path.realpath(path)

    try:
        mtime = os.path.getmtime(real)
        cache_key = f"{real}:{mtime}:{size}"
    except OSError:
        return Response(status=400)

    if cache_key in _thumb_cache:
        img_bytes, content_type = _thumb_cache[cache_key]
        return Response(img_bytes, mimetype=content_type,
                        headers={"Cache-Control": "private, max-age=300"})

    try:
        if ext == ".pdf":
            import fitz
            doc = fitz.open(real)
            try:
                page = doc[0]
                zoom = size / max(page.rect.width, page.rect.height)
                mat = fitz.Matrix(zoom, zoom)
                pix = page.get_pixmap(matrix=mat)
                img_bytes = pix.tobytes(output="png")
                content_type = "image/png"
            finally:
                doc.close()
        else:
            from PIL import Image
            img = Image.open(real)
            try:
                img.thumbnail((size, size), Image.LANCZOS)
                buf = BytesIO()
                # PNG pour les modes avec transparence ou palette
                needs_png = img.mode in ("RGBA", "P", "PA", "LA")
                fmt = "PNG" if needs_png else "JPEG"
                if fmt == "JPEG" and img.mode not in ("RGB", "L"):
                    img = img.convert("RGB")
                content_type = f"image/{fmt.lower()}"
                img.save(buf, format=fmt, quality=92)
                img_bytes = buf.getvalue()
            finally:
                img.close()

        # Evict oldest if cache full
        if len(_thumb_cache) >= _THUMB_CACHE_MAX:
            oldest_key = next(iter(_thumb_cache))
            del _thumb_cache[oldest_key]
        _thumb_cache[cache_key] = (img_bytes, content_type)

        return Response(img_bytes, mimetype=content_type,
                        headers={"Cache-Control": "private, max-age=300"})

    except Exception as e:
        logger.warning("Thumbnail error for %s: %s", path, e)
        return Response(status=500)


# ──────────────────────────────────────────────
#  pywebview JS API (native dialogs)
# ──────────────────────────────────────────────

class Api:
    def choose_files(self):
        result = webview.windows[0].create_file_dialog(
            webview.OPEN_DIALOG,
            allow_multiple=True,
            file_types=(
                "Tous les fichiers supportes (*.pdf;*.jpg;*.jpeg;*.png;*.webp;*.zip)",
                "PDF (*.pdf)",
                "Images (*.jpg;*.jpeg;*.png;*.webp)",
                "Archives (*.zip)",
            ),
        )
        return list(result) if result else []

    def choose_folder(self):
        result = webview.windows[0].create_file_dialog(webview.FOLDER_DIALOG)
        return result[0] if result else None

    def choose_preset_file(self):
        """Dialog natif pour ouvrir un fichier JSON de presets."""
        result = webview.windows[0].create_file_dialog(
            webview.OPEN_DIALOG,
            allow_multiple=False,
            file_types=("Fichiers JSON (*.json)",),
        )
        if not result:
            return None
        path = result[0] if isinstance(result, (list, tuple)) else result
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.warning("Error reading preset file %s: %s", path, e)
            return None

    def save_preset_file(self, json_data):
        """Dialog natif pour sauvegarder un fichier JSON de presets."""
        result = webview.windows[0].create_file_dialog(
            webview.SAVE_DIALOG,
            save_filename="compressor-presets.json",
            file_types=("Fichiers JSON (*.json)",),
        )
        if not result:
            return False
        path = result if isinstance(result, str) else result[0]
        if not path.endswith(".json"):
            path += ".json"
        try:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(json_data, f, indent=2, ensure_ascii=False)
            return True
        except Exception as e:
            logger.warning("Error writing preset file %s: %s", path, e)
            return False

    def get_drop_paths(self):
        """Lit les chemins de fichiers depuis le pasteboard macOS natif (drag & drop)."""
        from compressor import ZIP_EXTENSIONS
        try:
            from AppKit import NSPasteboard
            pb = NSPasteboard.pasteboardWithName_("Apple CFPasteboard drag")
            filenames = pb.propertyListForType_("NSFilenamesPboardType")
            if filenames:
                valid = []
                for f in filenames:
                    path = str(f)
                    if os.path.isfile(path):
                        ext = os.path.splitext(path)[1].lower()
                        if ext in SUPPORTED_EXTENSIONS or ext in ZIP_EXTENSIONS:
                            valid.append(path)
                    elif os.path.isdir(path):
                        files, _ = expand_paths([path])
                        valid.extend(files)
                return valid
        except Exception as e:
            logger.warning("get_drop_paths error: %s", e)
        return []


# ──────────────────────────────────────────────
#  Main
# ──────────────────────────────────────────────

def find_port(start=config.PORT_START, end=config.PORT_END):
    import socket
    for port in range(start, end):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind(("127.0.0.1", port))
            return port
        except OSError:
            continue
        finally:
            s.close()
    return start


def _set_dock_icon():
    """Set macOS dock icon from static/icon.png."""
    try:
        from AppKit import NSApplication, NSImage
        icon = NSImage.alloc().initWithContentsOfFile_(ICON_PATH)
        if icon:
            NSApplication.sharedApplication().setApplicationIconImage_(icon)
    except Exception:
        pass  # Non-critical — skip silently


def start_app():
    port = find_port()
    api = Api()

    # Start Flask in background
    server = threading.Thread(
        target=lambda: app.run(host="127.0.0.1", port=port, threaded=True, use_reloader=False),
        daemon=True,
    )
    server.start()
    time.sleep(0.5)

    # Set dock icon
    _set_dock_icon()

    # Native window
    window = webview.create_window(
        title="Compressor",
        url=f"http://127.0.0.1:{port}",
        width=1280,
        height=800,
        min_size=(1000, 700),
        resizable=True,
        js_api=api,
    )
    webview.start(debug=config.DEBUG)


if __name__ == "__main__":
    start_app()
