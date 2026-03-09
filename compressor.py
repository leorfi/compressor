#!/usr/bin/env python3
"""Moteur de compression — PDF, JPEG, PNG, WebP"""

import os
import shutil
import time
import tempfile
import zipfile
from io import BytesIO
from dataclasses import dataclass, asdict
from typing import Optional, Callable

from PIL import Image
import fitz  # PyMuPDF


# ──────────────────────────────────────────────
#  Data classes
# ──────────────────────────────────────────────

@dataclass
class CompressionResult:
    input_path: str
    output_path: str
    original_size: int
    compressed_size: int
    format: str
    level: str
    reduction_pct: float
    duration: float
    kept_original: bool

    def to_dict(self):
        return asdict(self)


@dataclass
class CompressionSettings:
    level: str = "medium"
    custom_quality: int = 70
    max_resolution: Optional[int] = None
    output_format: Optional[str] = None
    target_size_kb: Optional[int] = None
    output_dir: Optional[str] = None


# ──────────────────────────────────────────────
#  Presets
# ──────────────────────────────────────────────

PDF_LEVELS = {
    "high":   {"dpi": 200, "quality": 85},
    "medium": {"dpi": 150, "quality": 70},
    "low":    {"dpi": 100, "quality": 50},
}

JPEG_LEVELS = {
    "high":   {"quality": 85, "subsampling": "4:4:4"},
    "medium": {"quality": 70, "subsampling": "4:2:0"},
    "low":    {"quality": 50, "subsampling": "4:2:0"},
}

PNG_LEVELS = {
    "high":   {"colors": None},
    "medium": {"colors": 256},
    "low":    {"colors": 128},
}

WEBP_LEVELS = {
    "high":   {"quality": 85},
    "medium": {"quality": 70},
    "low":    {"quality": 50},
}

SUPPORTED_EXTENSIONS = {".pdf", ".jpg", ".jpeg", ".png", ".webp"}
ZIP_EXTENSIONS = {".zip"}


# ──────────────────────────────────────────────
#  Helpers
# ──────────────────────────────────────────────

def detect_format(file_path: str) -> str:
    ext = os.path.splitext(file_path)[1].lower()
    mapping = {
        ".pdf": "pdf",
        ".jpg": "jpeg", ".jpeg": "jpeg",
        ".png": "png",
        ".webp": "webp",
    }
    return mapping.get(ext, "unknown")


def _resize_image(img: Image.Image, max_px: int) -> Image.Image:
    w, h = img.size
    if max(w, h) <= max_px:
        return img
    ratio = max_px / max(w, h)
    nw, nh = int(w * ratio), int(h * ratio)
    return img.resize((nw, nh), Image.LANCZOS)


def _resolve_quality(settings: CompressionSettings, levels: dict) -> dict:
    if settings.level == "custom":
        q = settings.custom_quality
        return {"quality": q, "subsampling": "4:2:0" if q <= 70 else "4:4:4"}
    return levels.get(settings.level, levels["medium"])


def _build_output_path(input_path: str, settings: CompressionSettings, ext: Optional[str] = None) -> str:
    dirname = settings.output_dir or os.path.dirname(input_path)
    basename = os.path.splitext(os.path.basename(input_path))[0]
    if ext is None:
        ext = os.path.splitext(input_path)[1]
    if settings.output_format:
        ext_map = {"jpeg": ".jpg", "png": ".png", "webp": ".webp", "pdf": ".pdf"}
        ext = ext_map.get(settings.output_format, ext)
    os.makedirs(dirname, exist_ok=True)
    out = os.path.join(dirname, f"{basename}_compressed{ext}")
    return out


def extract_zip(zip_path: str) -> tuple:
    """Extrait un ZIP dans un dossier temporaire.
    Retourne (liste de fichiers supportés, chemin du dossier temp).
    """
    if not zipfile.is_zipfile(zip_path):
        return [], None

    tmp_dir = tempfile.mkdtemp(prefix="compressor_zip_")
    files = []

    with zipfile.ZipFile(zip_path, "r") as zf:
        # Sécurité : ignorer les chemins qui sortent du dossier temp (zip slip)
        for member in zf.namelist():
            # Ignorer les dossiers, fichiers cachés, __MACOSX
            if member.endswith("/") or "/__MACOSX" in member or member.startswith("__MACOSX"):
                continue
            basename = os.path.basename(member)
            if basename.startswith("."):
                continue
            # Vérifier que l'extraction reste dans le dossier temp
            target = os.path.realpath(os.path.join(tmp_dir, member))
            if not target.startswith(os.path.realpath(tmp_dir)):
                continue
            ext = os.path.splitext(basename)[1].lower()
            if ext in SUPPORTED_EXTENSIONS:
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with zf.open(member) as src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                files.append(target)

    return sorted(files), tmp_dir


def expand_paths(paths: list) -> list:
    """Résout les chemins : fichiers, dossiers, et ZIPs.
    Retourne (fichiers, liste de dossiers temp à nettoyer).
    """
    result = []
    tmp_dirs = []
    for path in paths:
        if os.path.isdir(path):
            for root, _, files in os.walk(path):
                for fname in sorted(files):
                    if os.path.splitext(fname)[1].lower() in SUPPORTED_EXTENSIONS:
                        result.append(os.path.join(root, fname))
        elif os.path.isfile(path):
            ext = os.path.splitext(path)[1].lower()
            if ext in SUPPORTED_EXTENSIONS:
                result.append(path)
            elif ext in ZIP_EXTENSIONS:
                extracted, tmp_dir = extract_zip(path)
                result.extend(extracted)
                if tmp_dir:
                    tmp_dirs.append(tmp_dir)
    return result, tmp_dirs


# ──────────────────────────────────────────────
#  PDF compression (from daemon-pdf.py)
# ──────────────────────────────────────────────

def compress_pdf(input_path: str, output_path: str, dpi: int = 150,
                 quality: int = 70, progress_cb: Callable = None) -> CompressionResult:
    if not os.path.isfile(input_path):
        raise FileNotFoundError(f"Fichier introuvable: {input_path}")

    t0 = time.time()
    orig_size = os.path.getsize(input_path)
    src = None
    dst = None

    try:
        src = fitz.open(input_path)
        dst = fitz.open()
        total_pages = len(src)

        for pn in range(total_pages):
            sp = src[pn]
            mat = fitz.Matrix(dpi / 72.0, dpi / 72.0)
            pix = sp.get_pixmap(matrix=mat)
            img_data = pix.tobytes(output="jpeg", jpg_quality=quality)
            dp = dst.new_page(width=sp.rect.width, height=sp.rect.height)
            dp.insert_image(sp.rect, stream=img_data)
            # Preserve links
            for link in sp.get_links():
                try:
                    dp.insert_link(link)
                except Exception:
                    pass
            if progress_cb:
                progress_cb(pn + 1, total_pages)

        dst.save(output_path, deflate=True, garbage=4)
    finally:
        if dst:
            dst.close()
        if src:
            src.close()

    comp_size = os.path.getsize(output_path)
    kept = False
    if comp_size >= orig_size:
        shutil.copy2(input_path, output_path)
        comp_size = orig_size
        kept = True

    reduction = round((1 - comp_size / orig_size) * 100, 1) if orig_size > 0 else 0
    return CompressionResult(
        input_path=input_path, output_path=output_path,
        original_size=orig_size, compressed_size=comp_size,
        format="pdf", level="", reduction_pct=reduction,
        duration=round(time.time() - t0, 1), kept_original=kept,
    )


# ──────────────────────────────────────────────
#  JPEG compression (from daemon-jpeg.py)
# ──────────────────────────────────────────────

def compress_jpeg(input_path: str, output_path: str, quality: int = 70,
                  subsampling: str = "4:2:0", max_resolution: int = None) -> CompressionResult:
    if not os.path.isfile(input_path):
        raise FileNotFoundError(f"Fichier introuvable: {input_path}")

    t0 = time.time()
    orig_size = os.path.getsize(input_path)

    img = Image.open(input_path)
    try:
        exif = img.info.get("exif", None)
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        if max_resolution:
            img = _resize_image(img, max_resolution)

        kw = {"quality": quality, "optimize": True, "subsampling": subsampling}
        if exif:
            kw["exif"] = exif
        img.save(output_path, "JPEG", **kw)
    finally:
        img.close()

    comp_size = os.path.getsize(output_path)
    kept = False
    if comp_size >= orig_size:
        shutil.copy2(input_path, output_path)
        comp_size = orig_size
        kept = True

    reduction = round((1 - comp_size / orig_size) * 100, 1) if orig_size > 0 else 0
    return CompressionResult(
        input_path=input_path, output_path=output_path,
        original_size=orig_size, compressed_size=comp_size,
        format="jpeg", level="", reduction_pct=reduction,
        duration=round(time.time() - t0, 1), kept_original=kept,
    )


# ──────────────────────────────────────────────
#  PNG compression
# ──────────────────────────────────────────────

def compress_png(input_path: str, output_path: str, colors: int = None,
                 max_resolution: int = None) -> CompressionResult:
    if not os.path.isfile(input_path):
        raise FileNotFoundError(f"Fichier introuvable: {input_path}")

    t0 = time.time()
    orig_size = os.path.getsize(input_path)

    img = Image.open(input_path)
    try:
        if max_resolution:
            img = _resize_image(img, max_resolution)
        if colors:
            if img.mode == "RGBA":
                alpha = img.split()[3]
                rgb = img.convert("RGB").convert("P", palette=Image.ADAPTIVE, colors=colors).convert("RGB")
                img.close()
                img = rgb
                img.putalpha(alpha)
            elif img.mode != "P":
                img = img.convert("RGB").convert("P", palette=Image.ADAPTIVE, colors=colors)
        img.save(output_path, "PNG", optimize=True)
    finally:
        img.close()

    comp_size = os.path.getsize(output_path)
    kept = False
    if comp_size >= orig_size:
        shutil.copy2(input_path, output_path)
        comp_size = orig_size
        kept = True

    reduction = round((1 - comp_size / orig_size) * 100, 1) if orig_size > 0 else 0
    return CompressionResult(
        input_path=input_path, output_path=output_path,
        original_size=orig_size, compressed_size=comp_size,
        format="png", level="", reduction_pct=reduction,
        duration=round(time.time() - t0, 1), kept_original=kept,
    )


# ──────────────────────────────────────────────
#  WebP conversion
# ──────────────────────────────────────────────

def convert_to_webp(input_path: str, output_path: str, quality: int = 70,
                    target_size_kb: int = None, max_resolution: int = None) -> CompressionResult:
    if not os.path.isfile(input_path):
        raise FileNotFoundError(f"Fichier introuvable: {input_path}")

    t0 = time.time()
    orig_size = os.path.getsize(input_path)

    img = Image.open(input_path)
    try:
        has_alpha = img.mode == "RGBA"
        if not has_alpha and img.mode != "RGB":
            img = img.convert("RGB")
        if max_resolution:
            img = _resize_image(img, max_resolution)

        if target_size_kb:
            lo, hi = 10, 95
            best_q = 50
            for _ in range(15):
                q = (lo + hi) // 2
                buf = BytesIO()
                img.save(buf, "WEBP", quality=q, method=6)
                sz = buf.tell() / 1024
                if sz <= target_size_kb:
                    best_q = q
                    lo = q + 1
                else:
                    hi = q - 1
            img.save(output_path, "WEBP", quality=best_q, method=6)
        else:
            img.save(output_path, "WEBP", quality=quality, method=6)
    finally:
        img.close()

    comp_size = os.path.getsize(output_path)
    kept = False
    if comp_size >= orig_size:
        shutil.copy2(input_path, output_path)
        comp_size = orig_size
        kept = True

    reduction = round((1 - comp_size / orig_size) * 100, 1) if orig_size > 0 else 0
    return CompressionResult(
        input_path=input_path, output_path=output_path,
        original_size=orig_size, compressed_size=comp_size,
        format="webp", level="", reduction_pct=reduction,
        duration=round(time.time() - t0, 1), kept_original=kept,
    )


# ──────────────────────────────────────────────
#  Dispatcher
# ──────────────────────────────────────────────

def compress_file(input_path: str, settings: CompressionSettings,
                  progress_cb: Callable = None) -> CompressionResult:
    """Dispatcher : détecte le format et route vers le bon compresseur."""
    if not os.path.isfile(input_path):
        raise FileNotFoundError(f"Fichier introuvable: {input_path}")

    fmt = detect_format(input_path)
    output_format = settings.output_format or fmt

    # Build output path
    output_path = _build_output_path(input_path, settings)

    # Résoudre les paramètres selon le format cible
    if output_format == "webp":
        params = _resolve_quality(settings, WEBP_LEVELS)
        result = convert_to_webp(
            input_path, output_path,
            quality=params.get("quality", 70),
            target_size_kb=settings.target_size_kb,
            max_resolution=settings.max_resolution,
        )

    elif fmt == "pdf":
        if settings.level == "custom":
            params = {"dpi": 150, "quality": settings.custom_quality}
        else:
            params = PDF_LEVELS.get(settings.level, PDF_LEVELS["medium"])
        result = compress_pdf(
            input_path, output_path,
            dpi=params["dpi"],
            quality=params["quality"],
            progress_cb=progress_cb,
        )

    elif fmt == "jpeg":
        params = _resolve_quality(settings, JPEG_LEVELS)
        result = compress_jpeg(
            input_path, output_path,
            quality=params["quality"],
            subsampling=params.get("subsampling", "4:2:0"),
            max_resolution=settings.max_resolution,
        )

    elif fmt == "png":
        if settings.level == "custom":
            params = {"colors": 256 if settings.custom_quality < 70 else None}
        else:
            params = PNG_LEVELS.get(settings.level, PNG_LEVELS["medium"])
        result = compress_png(
            input_path, output_path,
            colors=params.get("colors"),
            max_resolution=settings.max_resolution,
        )

    elif fmt == "webp":
        params = _resolve_quality(settings, WEBP_LEVELS)
        result = convert_to_webp(
            input_path, output_path,
            quality=params["quality"],
            target_size_kb=settings.target_size_kb,
            max_resolution=settings.max_resolution,
        )

    else:
        raise ValueError(f"Format non supporte: {fmt}")

    result.level = settings.level
    return result
