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
    max_resolution: Optional[int] = None      # Compat v1 — preferer resize_mode
    output_format: Optional[str] = None
    target_size_kb: Optional[int] = None
    output_dir: Optional[str] = None
    # ── Phase 2 ──
    resize_mode: str = "none"                  # none|percent|width|height|fit|exact
    resize_width: Optional[int] = None
    resize_height: Optional[int] = None
    resize_percent: int = 100
    strip_metadata: bool = False               # True = supprimer EXIF/XMP
    suffix: str = "_compressed"                # suffixe du fichier de sortie
    keep_date: bool = False                    # True = copier mtime de l'original
    lossless: bool = False                     # True = WebP lossless / PNG sans quantization
    pdf_custom_dpi: int = 150                    # DPI custom pour PDF


# ──────────────────────────────────────────────
#  Presets
# ──────────────────────────────────────────────

PDF_LEVELS = {
    "high":   {"dpi": 180, "quality": 80},
    "medium": {"dpi": 130, "quality": 60},
    "low":    {"dpi": 100, "quality": 30},
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
MAX_ZIP_EXTRACT_MB = 2048  # Limite d'extraction ZIP : 2 GB

# Taille du crop pour estimation rapide (pixels)
ESTIMATE_CROP_SIZE = 512


# ──────────────────────────────────────────────
#  Estimation par sample compression
# ──────────────────────────────────────────────

def estimate_file(input_path: str, settings: CompressionSettings) -> dict:
    """Estimation du poids après compression via crop à résolution native.

    Retourne {"estimated_size": int, "ratio": float} ou {"error": str}.
    Pour les images : crop central à résolution native, compression réelle,
    extrapolation par ratio de surface.
    Pour les PDF : compression de la 1ère page, extrapolation par nb pages.
    """
    if not os.path.isfile(input_path):
        return {"error": "Fichier introuvable"}

    fmt = detect_format(input_path)
    output_format = settings.output_format or fmt
    orig_size = os.path.getsize(input_path)

    try:
        if fmt == "pdf":
            return _estimate_pdf(input_path, settings, orig_size)
        else:
            return _estimate_image(input_path, settings, fmt, output_format, orig_size)
    except Exception as e:
        return {"error": str(e)}


def _compress_sample(sample: Image.Image, out_fmt: str, src_fmt: str,
                     settings: CompressionSettings) -> int:
    """Compresse un sample et retourne sa taille en bytes."""
    buf = BytesIO()

    # Convertir le mode si nécessaire
    has_alpha = sample.mode == "RGBA"
    if out_fmt in ("jpeg",) and has_alpha:
        sample = sample.convert("RGB")
    elif out_fmt in ("jpeg", "webp") and sample.mode not in ("RGB", "RGBA", "L"):
        sample = sample.convert("RGB")

    if out_fmt == "webp":
        params = _resolve_quality(settings, WEBP_LEVELS)
        if settings.lossless:
            sample.save(buf, "WEBP", lossless=True, method=6)
        else:
            sample.save(buf, "WEBP", quality=params["quality"], method=6)

    elif out_fmt == "jpeg" or (out_fmt in ("", None) and src_fmt == "jpeg"):
        params = _resolve_quality(settings, JPEG_LEVELS)
        if sample.mode not in ("RGB", "L"):
            sample = sample.convert("RGB")
        sample.save(buf, "JPEG", quality=params["quality"], optimize=True,
                    subsampling=params.get("subsampling", "4:2:0"))

    elif out_fmt == "png" or (out_fmt in ("", None) and src_fmt == "png"):
        if settings.level == "custom":
            params = {"colors": 256 if settings.custom_quality < 70 else None}
        else:
            params = PNG_LEVELS.get(settings.level, PNG_LEVELS["medium"])
        colors = params.get("colors")
        if not settings.lossless and colors:
            if sample.mode == "RGBA":
                alpha = sample.split()[3]
                rgb = sample.convert("RGB").convert("P", palette=Image.ADAPTIVE, colors=colors).convert("RGB")
                rgb.putalpha(alpha)
                rgb.save(buf, "PNG", optimize=True)
            elif sample.mode != "P":
                sample = sample.convert("RGB").convert("P", palette=Image.ADAPTIVE, colors=colors)
                sample.save(buf, "PNG", optimize=True)
            else:
                sample.save(buf, "PNG", optimize=True)
        else:
            sample.save(buf, "PNG", optimize=True)
    else:
        if sample.mode not in ("RGB", "L"):
            sample = sample.convert("RGB")
        sample.save(buf, "JPEG", quality=70, optimize=True)

    return buf.tell()


def _estimate_image(input_path: str, settings: CompressionSettings,
                    src_fmt: str, out_fmt: str, orig_size: int) -> dict:
    """Estimation pour images via crop à résolution native.

    Prend un crop central de l'image à résolution native (pas de downscale),
    le compresse avec les vrais paramètres, et extrapole par ratio de surface.
    Si resize est actif, applique le resize d'abord puis prend le crop.
    """
    img = Image.open(input_path)
    try:
        orig_w, orig_h = img.size

        # Appliquer le resize si demandé
        if settings.resize_mode != "none":
            img = _resize_image_v2(img, settings)

        final_w, final_h = img.size
        final_pixels = final_w * final_h

        # Pour les petites images : compresser directement (pas besoin de crop)
        crop_size = ESTIMATE_CROP_SIZE
        if final_w <= crop_size * 1.5 and final_h <= crop_size * 1.5:
            # Image assez petite pour compresser entièrement
            compressed_size = _compress_sample(img, out_fmt, src_fmt, settings)
            compressed_size = min(compressed_size, orig_size)
            ratio = compressed_size / orig_size if orig_size > 0 else 1
            return {
                "estimated_size": compressed_size,
                "ratio": round(ratio, 4),
                "final_w": final_w,
                "final_h": final_h,
            }

        # Multi-crop à résolution native : centre + 4 coins
        # Ça donne une moyenne représentative du contenu de toute l'image
        cw = min(crop_size, final_w)
        ch = min(crop_size, final_h)
        margin_x = max(0, final_w - cw)
        margin_y = max(0, final_h - ch)

        crop_positions = [
            (final_w // 2 - cw // 2, final_h // 2 - ch // 2),  # centre
            (0, 0),                                              # haut-gauche
            (margin_x, 0),                                       # haut-droite
            (0, margin_y),                                       # bas-gauche
            (margin_x, margin_y),                                # bas-droite
        ]

        total_crop_bytes = 0
        total_crop_pixels = 0
        for x0, y0 in crop_positions:
            crop = img.crop((x0, y0, x0 + cw, y0 + ch))
            crop_compressed = _compress_sample(crop, out_fmt, src_fmt, settings)
            total_crop_bytes += crop_compressed
            total_crop_pixels += crop.size[0] * crop.size[1]
            crop.close()

        # Extrapoler : le bytes/pixel moyen des 5 crops
        if total_crop_pixels > 0:
            bytes_per_pixel = total_crop_bytes / total_crop_pixels
            estimated = int(bytes_per_pixel * final_pixels)
        else:
            estimated = orig_size

        # Sécurité : ne jamais estimer plus que l'original
        estimated = min(estimated, orig_size)
        ratio = estimated / orig_size if orig_size > 0 else 1

        return {
            "estimated_size": estimated,
            "ratio": round(ratio, 4),
            "final_w": final_w,
            "final_h": final_h,
        }
    finally:
        img.close()


def _estimate_pdf(input_path: str, settings: CompressionSettings, orig_size: int) -> dict:
    """Estimation pour PDF : compresse la 1ère page, extrapole."""
    if settings.level == "custom":
        params = {"dpi": settings.pdf_custom_dpi, "quality": settings.custom_quality}
    else:
        params = PDF_LEVELS.get(settings.level, PDF_LEVELS["medium"])

    dpi = params["dpi"]
    quality = params["quality"]

    src = fitz.open(input_path)
    try:
        total_pages = len(src)
        if total_pages == 0:
            return {"estimated_size": 0, "ratio": 0}

        # Compresser les N premières pages (max 3) pour un échantillon fiable
        sample_pages = min(total_pages, 3)
        dst = fitz.open()
        for pn in range(sample_pages):
            sp = src[pn]
            mat = fitz.Matrix(dpi / 72.0, dpi / 72.0)
            pix = sp.get_pixmap(matrix=mat)
            img_data = pix.tobytes(output="jpeg", jpg_quality=quality)
            dp = dst.new_page(width=sp.rect.width, height=sp.rect.height)
            dp.insert_image(sp.rect, stream=img_data)

        buf = BytesIO()
        dst.save(buf, deflate=True, garbage=4)
        sample_size = buf.tell()
        dst.close()

        # Extrapoler
        per_page = sample_size / sample_pages
        estimated = int(per_page * total_pages)
        estimated = min(estimated, orig_size)
        ratio = estimated / orig_size if orig_size > 0 else 1

        return {
            "estimated_size": estimated,
            "ratio": round(ratio, 4),
            "pages": total_pages,
        }
    finally:
        src.close()


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
    """Compat v1 — simple cap sur la plus grande dimension."""
    w, h = img.size
    if max(w, h) <= max_px:
        return img
    ratio = max_px / max(w, h)
    nw, nh = int(w * ratio), int(h * ratio)
    return img.resize((nw, nh), Image.LANCZOS)


def _resize_image_v2(img: Image.Image, settings: CompressionSettings) -> Image.Image:
    """Redimensionnement avance — 6 modes.

    - none    : pas de changement
    - percent : reduction par pourcentage (10-100)
    - width   : largeur fixe, aspect ratio conserve
    - height  : hauteur fixe, aspect ratio conserve
    - fit     : contenir dans une boite WxH, aspect ratio conserve, jamais agrandir
    - exact   : dimensions exactes WxH (peut deformer)
    """
    mode = settings.resize_mode
    if mode == "none":
        return img

    w, h = img.size

    if mode == "percent":
        pct = max(1, min(100, settings.resize_percent))
        nw, nh = max(1, int(w * pct / 100)), max(1, int(h * pct / 100))

    elif mode == "width":
        tw = settings.resize_width
        if not tw or tw <= 0 or tw >= w:
            return img  # pas d'agrandissement
        ratio = tw / w
        nw, nh = tw, max(1, int(h * ratio))

    elif mode == "height":
        th = settings.resize_height
        if not th or th <= 0 or th >= h:
            return img
        ratio = th / h
        nw, nh = max(1, int(w * ratio)), th

    elif mode == "fit":
        tw = settings.resize_width
        th = settings.resize_height
        if not tw or not th or tw <= 0 or th <= 0:
            return img
        # Ne jamais agrandir
        if w <= tw and h <= th:
            return img
        ratio = min(tw / w, th / h)
        nw, nh = max(1, int(w * ratio)), max(1, int(h * ratio))

    elif mode == "exact":
        tw = settings.resize_width
        th = settings.resize_height
        if not tw or not th or tw <= 0 or th <= 0:
            return img
        nw, nh = tw, th

    else:
        return img

    return img.resize((nw, nh), Image.LANCZOS)


def _resolve_quality(settings: CompressionSettings, levels: dict) -> dict:
    if settings.level == "custom":
        q = settings.custom_quality
        return {"quality": q, "subsampling": "4:2:0" if q <= 70 else "4:4:4"}
    return levels.get(settings.level, levels["medium"])


def _finalize_result(input_path: str, output_path: str, orig_size: int,
                     fmt: str, t0: float,
                     keep_date: bool = False) -> CompressionResult:
    """Bloc commun : compare tailles, garde l'original si plus petit, retourne le résultat."""
    comp_size = os.path.getsize(output_path)
    kept = False
    if comp_size >= orig_size:
        shutil.copy2(input_path, output_path)
        comp_size = orig_size
        kept = True

    # Preserver la date de modification originale
    if keep_date:
        try:
            st = os.stat(input_path)
            os.utime(output_path, (st.st_atime, st.st_mtime))
        except OSError:
            pass

    reduction = round((1 - comp_size / orig_size) * 100, 1) if orig_size > 0 else 0
    return CompressionResult(
        input_path=input_path, output_path=output_path,
        original_size=orig_size, compressed_size=comp_size,
        format=fmt, level="", reduction_pct=reduction,
        duration=round(time.time() - t0, 1), kept_original=kept,
    )


def _build_output_path(input_path: str, settings: CompressionSettings, ext: Optional[str] = None) -> str:
    dirname = settings.output_dir or os.path.dirname(input_path)
    basename = os.path.splitext(os.path.basename(input_path))[0]
    if ext is None:
        ext = os.path.splitext(input_path)[1]
    if settings.output_format:
        ext_map = {"jpeg": ".jpg", "png": ".png", "webp": ".webp", "pdf": ".pdf"}
        ext = ext_map.get(settings.output_format, ext)
    os.makedirs(dirname, exist_ok=True)
    suffix = settings.suffix if settings.suffix else ""
    # Securite : supprimer tout separateur de chemin du suffix
    suffix = suffix.replace("/", "").replace("\\", "").replace("..", "")
    out = os.path.join(dirname, f"{basename}{suffix}{ext}")
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
        # Protection zip bomb : vérifier la taille totale avant extraction
        total_size = sum(info.file_size for info in zf.infolist())
        if total_size > MAX_ZIP_EXTRACT_MB * 1024 * 1024:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            return [], None

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


def expand_paths(paths: list) -> tuple[list[str], list[str]]:
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
                 quality: int = 70, progress_cb: Callable = None,
                 keep_date: bool = False,
                 target_size_kb: int = None) -> CompressionResult:
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

        # Target size : binary search sur la qualite JPEG des pages
        if target_size_kb:
            lo, hi = 10, 95
            best_q = quality
            # Tester sur les N premieres pages pour limiter le cout
            test_pages = min(total_pages, 5)
            ratio = total_pages / test_pages if test_pages > 0 else 1
            for _ in range(12):
                q = (lo + hi) // 2
                test_dst = fitz.open()
                for pn in range(test_pages):
                    sp = src[pn]
                    mat = fitz.Matrix(dpi / 72.0, dpi / 72.0)
                    pix = sp.get_pixmap(matrix=mat)
                    d = pix.tobytes(output="jpeg", jpg_quality=q)
                    dp = test_dst.new_page(width=sp.rect.width, height=sp.rect.height)
                    dp.insert_image(sp.rect, stream=d)
                buf = BytesIO()
                test_dst.save(buf, deflate=True, garbage=4)
                test_dst.close()
                estimated_kb = (buf.tell() / 1024) * ratio
                if estimated_kb <= target_size_kb:
                    best_q = q
                    lo = q + 1
                else:
                    hi = q - 1
            quality = best_q

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

    return _finalize_result(input_path, output_path, orig_size, "pdf", t0,
                            keep_date=keep_date)


# ──────────────────────────────────────────────
#  JPEG compression (from daemon-jpeg.py)
# ──────────────────────────────────────────────

def compress_jpeg(input_path: str, output_path: str, quality: int = 70,
                  subsampling: str = "4:2:0", max_resolution: int = None,
                  settings: CompressionSettings = None) -> CompressionResult:
    if not os.path.isfile(input_path):
        raise FileNotFoundError(f"Fichier introuvable: {input_path}")

    t0 = time.time()
    orig_size = os.path.getsize(input_path)
    strip_metadata = settings.strip_metadata if settings else False
    keep_date = settings.keep_date if settings else False

    img = Image.open(input_path)
    try:
        exif = img.info.get("exif", None)
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")

        # Resize : Phase 2 mode ou compat v1
        if settings and settings.resize_mode != "none":
            img = _resize_image_v2(img, settings)
        elif max_resolution:
            img = _resize_image(img, max_resolution)

        # Target size : binary search sur la qualite
        target_size_kb = settings.target_size_kb if settings else None
        if target_size_kb:
            lo, hi = 10, 95
            best_q = quality
            for _ in range(15):
                q = (lo + hi) // 2
                buf = BytesIO()
                kw_test = {"quality": q, "optimize": True, "subsampling": subsampling}
                if exif and not strip_metadata:
                    kw_test["exif"] = exif
                img.save(buf, "JPEG", **kw_test)
                if buf.tell() / 1024 <= target_size_kb:
                    best_q = q
                    lo = q + 1
                else:
                    hi = q - 1
            quality = best_q

        kw = {"quality": quality, "optimize": True, "subsampling": subsampling}
        if exif and not strip_metadata:
            kw["exif"] = exif
        img.save(output_path, "JPEG", **kw)
    finally:
        img.close()

    return _finalize_result(input_path, output_path, orig_size, "jpeg", t0,
                            keep_date=keep_date)


# ──────────────────────────────────────────────
#  PNG compression
# ──────────────────────────────────────────────

def compress_png(input_path: str, output_path: str, colors: int = None,
                 max_resolution: int = None,
                 settings: CompressionSettings = None) -> CompressionResult:
    if not os.path.isfile(input_path):
        raise FileNotFoundError(f"Fichier introuvable: {input_path}")

    t0 = time.time()
    orig_size = os.path.getsize(input_path)
    strip_metadata = settings.strip_metadata if settings else False
    lossless = settings.lossless if settings else False
    keep_date = settings.keep_date if settings else False

    img = Image.open(input_path)
    try:
        # Resize : Phase 2 mode ou compat v1
        if settings and settings.resize_mode != "none":
            img = _resize_image_v2(img, settings)
        elif max_resolution:
            img = _resize_image(img, max_resolution)

        # Strip metadata
        if strip_metadata:
            img.info = {}

        # Target size : binary search sur le nombre de couleurs
        target_size_kb = settings.target_size_kb if settings else None
        if target_size_kb and not lossless:
            lo, hi = 32, 256
            best_colors = colors or 256
            for _ in range(10):
                c = (lo + hi) // 2
                buf = BytesIO()
                test_img = img.copy()
                if test_img.mode == "RGBA":
                    alpha = test_img.split()[3]
                    rgb = test_img.convert("RGB").convert("P", palette=Image.ADAPTIVE, colors=c).convert("RGB")
                    rgb.putalpha(alpha)
                    rgb.save(buf, "PNG", optimize=True)
                elif test_img.mode != "P":
                    test_img = test_img.convert("RGB").convert("P", palette=Image.ADAPTIVE, colors=c)
                    test_img.save(buf, "PNG", optimize=True)
                else:
                    test_img.save(buf, "PNG", optimize=True)
                if buf.tell() / 1024 <= target_size_kb:
                    best_colors = c
                    lo = c + 1
                else:
                    hi = c - 1
            colors = best_colors

        # Lossless = pas de quantization, meme en mode medium/low
        if not lossless and colors:
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

    return _finalize_result(input_path, output_path, orig_size, "png", t0,
                            keep_date=keep_date)


# ──────────────────────────────────────────────
#  WebP conversion
# ──────────────────────────────────────────────

def convert_to_webp(input_path: str, output_path: str, quality: int = 70,
                    target_size_kb: int = None, max_resolution: int = None,
                    settings: CompressionSettings = None) -> CompressionResult:
    if not os.path.isfile(input_path):
        raise FileNotFoundError(f"Fichier introuvable: {input_path}")

    t0 = time.time()
    orig_size = os.path.getsize(input_path)
    strip_metadata = settings.strip_metadata if settings else False
    lossless = settings.lossless if settings else False
    keep_date = settings.keep_date if settings else False

    img = Image.open(input_path)
    try:
        has_alpha = img.mode == "RGBA"
        if not has_alpha and img.mode != "RGB":
            img = img.convert("RGB")

        # Resize : Phase 2 mode ou compat v1
        if settings and settings.resize_mode != "none":
            img = _resize_image_v2(img, settings)
        elif max_resolution:
            img = _resize_image(img, max_resolution)

        # Strip metadata
        if strip_metadata:
            img.info = {}

        if lossless:
            # Mode lossless — ignore quality et target_size
            img.save(output_path, "WEBP", lossless=True, method=6)
        elif target_size_kb:
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

    return _finalize_result(input_path, output_path, orig_size, "webp", t0,
                            keep_date=keep_date)


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

    # Compat v1 : max_resolution → resize_mode "fit" (un seul cote)
    # IMPORTANT : copie pour ne pas muter l'objet original (batch safety)
    if settings.max_resolution and settings.resize_mode == "none":
        from dataclasses import replace
        settings = replace(
            settings,
            resize_mode="fit",
            resize_width=settings.max_resolution,
            resize_height=settings.max_resolution,
        )

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
            settings=settings,
        )

    elif fmt == "pdf":
        if settings.level == "custom":
            params = {"dpi": settings.pdf_custom_dpi, "quality": settings.custom_quality}
        else:
            params = PDF_LEVELS.get(settings.level, PDF_LEVELS["medium"])
        result = compress_pdf(
            input_path, output_path,
            dpi=params["dpi"],
            quality=params["quality"],
            progress_cb=progress_cb,
            keep_date=settings.keep_date,
            target_size_kb=settings.target_size_kb,
        )

    elif fmt == "jpeg":
        params = _resolve_quality(settings, JPEG_LEVELS)
        result = compress_jpeg(
            input_path, output_path,
            quality=params["quality"],
            subsampling=params.get("subsampling", "4:2:0"),
            max_resolution=settings.max_resolution,
            settings=settings,
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
            settings=settings,
        )

    elif fmt == "webp":
        params = _resolve_quality(settings, WEBP_LEVELS)
        result = convert_to_webp(
            input_path, output_path,
            quality=params["quality"],
            target_size_kb=settings.target_size_kb,
            max_resolution=settings.max_resolution,
            settings=settings,
        )

    else:
        raise ValueError(f"Format non supporte: {fmt}")

    result.level = settings.level
    return result
