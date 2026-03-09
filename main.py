#!/usr/bin/env python3
"""Compressor — App macOS de compression (Flask + pywebview)"""

import os
import sys
import json
import logging
import threading
import queue
import time
import subprocess
import shutil
import base64
from io import BytesIO

import webview
from flask import Flask, request, jsonify, render_template, Response

from compressor import (
    compress_file, detect_format, expand_paths,
    CompressionSettings, SUPPORTED_EXTENSIONS,
)
from history import (
    add_entry, get_history, clear_history,
    get_stats, load_settings, save_settings,
)

# ──────────────────────────────────────────────
#  Logging
# ──────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────
#  Flask app
# ──────────────────────────────────────────────

app = Flask(
    __name__,
    template_folder=os.path.join(os.path.dirname(__file__), "templates"),
    static_folder=os.path.join(os.path.dirname(__file__), "static"),
)

# SSE state — protégé par un Lock pour éviter les race conditions
_queues_lock = threading.Lock()
progress_queues: list[queue.Queue] = []
compression_active = False

NOTIFIER = "/opt/homebrew/bin/terminal-notifier"
APP_DIR = os.path.dirname(os.path.abspath(__file__))
ICON_PATH = os.path.join(APP_DIR, "static", "icon.png")
VERSION_FILE = os.path.join(APP_DIR, "VERSION")

# Temp dirs créés par l'extraction ZIP (nettoyés après compression)
_tmp_dirs_lock = threading.Lock()
_pending_tmp_dirs: list[str] = []


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
    with _queues_lock:
        dead = []
        for q in progress_queues:
            try:
                q.put_nowait(msg)
            except queue.Full:
                dead.append(q)
        for q in dead:
            progress_queues.remove(q)


def _notify(title: str, message: str):
    try:
        settings = load_settings()
        if not settings.get("notifications_enabled", True):
            return
        if os.path.isfile(NOTIFIER):
            subprocess.run(
                [NOTIFIER, "-title", title, "-message", message, "-sound", "default"],
                timeout=10,
            )
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
    global _pending_tmp_dirs
    data = request.json or {}
    paths = data.get("paths", [])
    if not isinstance(paths, list):
        return jsonify({"error": "paths doit etre une liste"}), 400
    for p in paths:
        if not isinstance(p, str):
            return jsonify({"error": f"Chemin invalide: {p}"}), 400
    files, tmp_dirs = expand_paths(paths)
    with _tmp_dirs_lock:
        _pending_tmp_dirs.extend(tmp_dirs)
    return jsonify({"files": files})


@app.route("/api/compress", methods=["POST"])
def api_compress():
    global compression_active
    if compression_active:
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

    settings = CompressionSettings(
        level=level,
        custom_quality=custom_q,
        max_resolution=max_res,
        output_format=out_fmt,
        target_size_kb=target_kb,
        output_dir=output_dir,
    )

    def run():
        global compression_active
        compression_active = True
        try:
            results = []
            total = len(files)

            for i, fpath in enumerate(files):
                fname = os.path.basename(fpath)
                _broadcast({"type": "file_start", "index": i, "total": total, "filename": fname})
                try:
                    def page_cb(page, total_pages, _i=i):
                        _broadcast({
                            "type": "page_progress",
                            "file_index": _i, "page": page, "total_pages": total_pages,
                        })

                    result = compress_file(fpath, settings, progress_cb=page_cb)
                    result.level = settings.level
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
            _broadcast({"type": "batch_done", "count": len(results), "saved_mb": round(saved_mb, 1)})
            _notify(
                "Compression terminee",
                f"{len(results)} fichier(s) — {saved_mb:.1f} MB economises",
            )
        except Exception:
            logger.exception("Erreur fatale dans le thread de compression")
        finally:
            compression_active = False
            # Nettoyer les dossiers temporaires (extraction ZIP)
            with _tmp_dirs_lock:
                all_tmps = list(set(tmp_dirs + _pending_tmp_dirs))
                _pending_tmp_dirs.clear()
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
    with _queues_lock:
        progress_queues.append(q)

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
            with _queues_lock:
                if q in progress_queues:
                    progress_queues.remove(q)

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


@app.route("/api/settings", methods=["GET"])
def api_get_settings():
    return jsonify(load_settings())


@app.route("/api/settings", methods=["POST"])
def api_save_settings():
    save_settings(request.json or {})
    return jsonify({"ok": True})


# ──────────────────────────────────────────────
#  App version & Updates
# ──────────────────────────────────────────────

@app.route("/api/app/version")
def api_app_version():
    return jsonify({"version": _read_version()})


@app.route("/api/updates/check")
def api_updates_check():
    """Vérifie les mises à jour via git fetch --tags."""
    try:
        # Vérifier que c'est un repo git
        result = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            cwd=APP_DIR, capture_output=True, text=True, timeout=5,
        )
        if result.returncode != 0:
            return jsonify({"error": "Pas un depot git", "update_available": False})

        # Fetch les tags distants
        fetch = subprocess.run(
            ["git", "fetch", "--tags", "--quiet"],
            cwd=APP_DIR, capture_output=True, text=True, timeout=30,
        )
        if fetch.returncode != 0:
            logger.warning("git fetch --tags failed: %s", fetch.stderr)
            return jsonify({"error": "Impossible de contacter le serveur", "update_available": False})

        # Récupérer le dernier tag (trié par version)
        tags = subprocess.run(
            ["git", "tag", "--sort=-v:refname"],
            cwd=APP_DIR, capture_output=True, text=True, timeout=5,
        )
        tag_list = [t.strip() for t in tags.stdout.strip().split("\n") if t.strip()]
        if not tag_list:
            return jsonify({"error": "Aucun tag trouve", "update_available": False})

        latest_tag = tag_list[0]
        latest_version = latest_tag.lstrip("v")
        current_version = _read_version()

        update_available = _parse_version(latest_version) > _parse_version(current_version)

        # Récupérer le message du tag (changelog)
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
        })
    except subprocess.TimeoutExpired:
        return jsonify({"error": "Timeout lors de la verification", "update_available": False})
    except Exception as e:
        logger.exception("Erreur check updates")
        return jsonify({"error": str(e), "update_available": False})


@app.route("/api/updates/apply", methods=["POST"])
def api_updates_apply():
    """Applique la mise à jour via git pull --ff-only."""
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
                pix = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5))
                img_bytes = pix.tobytes(output="png")
            finally:
                doc.close()
        else:
            from PIL import Image
            img = Image.open(path)
            try:
                img.thumbnail((600, 600))
                buf = BytesIO()
                fmt = "PNG" if img.mode == "RGBA" else "JPEG"
                img.save(buf, format=fmt)
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

def find_port(start=5050, end=5060):
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
        width=1100,
        height=750,
        min_size=(800, 600),
        resizable=True,
        js_api=api,
    )
    webview.start(debug=os.environ.get("COMPRESSOR_DEBUG", "").lower() in ("1", "true"))


if __name__ == "__main__":
    start_app()
