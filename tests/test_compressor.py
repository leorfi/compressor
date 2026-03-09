#!/usr/bin/env python3
"""Tests unitaires pour le moteur de compression."""

import os
import shutil
import tempfile
import zipfile

import pytest
from PIL import Image

# Ajouter le dossier parent au path
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from compressor import (
    detect_format,
    compress_jpeg,
    compress_png,
    convert_to_webp,
    compress_file,
    extract_zip,
    expand_paths,
    _resize_image,
    _resolve_quality,
    _finalize_result,
    _build_output_path,
    CompressionSettings,
    CompressionResult,
    SUPPORTED_EXTENSIONS,
    MAX_ZIP_EXTRACT_MB,
)


# ── Fixtures ─────────────────────────────────

@pytest.fixture
def tmp_dir():
    """Crée un dossier temporaire, nettoyé après le test."""
    d = tempfile.mkdtemp(prefix="test_compressor_")
    yield d
    shutil.rmtree(d, ignore_errors=True)


@pytest.fixture
def sample_jpeg(tmp_dir):
    """Crée un JPEG de test (200x200, rouge)."""
    path = os.path.join(tmp_dir, "test.jpg")
    img = Image.new("RGB", (200, 200), color=(255, 0, 0))
    img.save(path, "JPEG", quality=95)
    img.close()
    return path


@pytest.fixture
def sample_png(tmp_dir):
    """Crée un PNG de test (200x200, bleu)."""
    path = os.path.join(tmp_dir, "test.png")
    img = Image.new("RGB", (200, 200), color=(0, 0, 255))
    img.save(path, "PNG")
    img.close()
    return path


@pytest.fixture
def sample_png_rgba(tmp_dir):
    """Crée un PNG RGBA de test (200x200, avec alpha)."""
    path = os.path.join(tmp_dir, "test_alpha.png")
    img = Image.new("RGBA", (200, 200), color=(0, 255, 0, 128))
    img.save(path, "PNG")
    img.close()
    return path


@pytest.fixture
def sample_webp(tmp_dir):
    """Crée un WebP de test (200x200, vert)."""
    path = os.path.join(tmp_dir, "test.webp")
    img = Image.new("RGB", (200, 200), color=(0, 255, 0))
    img.save(path, "WEBP", quality=95)
    img.close()
    return path


@pytest.fixture
def sample_zip(tmp_dir, sample_jpeg, sample_png):
    """Crée un ZIP contenant un JPEG et un PNG."""
    zip_path = os.path.join(tmp_dir, "archive.zip")
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.write(sample_jpeg, "photos/image.jpg")
        zf.write(sample_png, "photos/logo.png")
    return zip_path


# ── detect_format ────────────────────────────

class TestDetectFormat:
    def test_jpeg(self):
        assert detect_format("photo.jpg") == "jpeg"
        assert detect_format("photo.jpeg") == "jpeg"

    def test_png(self):
        assert detect_format("logo.png") == "png"

    def test_webp(self):
        assert detect_format("image.webp") == "webp"

    def test_pdf(self):
        assert detect_format("document.pdf") == "pdf"

    def test_unknown(self):
        assert detect_format("file.txt") == "unknown"
        assert detect_format("file.bmp") == "unknown"

    def test_case_insensitive(self):
        assert detect_format("PHOTO.JPG") == "jpeg"
        assert detect_format("Logo.PNG") == "png"


# ── _resize_image ────────────────────────────

class TestResizeImage:
    def test_no_resize_needed(self):
        img = Image.new("RGB", (100, 100))
        result = _resize_image(img, 200)
        assert result.size == (100, 100)
        img.close()

    def test_resize_landscape(self):
        img = Image.new("RGB", (1000, 500))
        result = _resize_image(img, 200)
        assert result.size[0] == 200
        assert result.size[1] == 100
        img.close()
        result.close()

    def test_resize_portrait(self):
        img = Image.new("RGB", (500, 1000))
        result = _resize_image(img, 200)
        assert result.size[0] == 100
        assert result.size[1] == 200
        img.close()
        result.close()

    def test_exact_match(self):
        img = Image.new("RGB", (200, 200))
        result = _resize_image(img, 200)
        assert result.size == (200, 200)
        img.close()


# ── _resolve_quality ─────────────────────────

class TestResolveQuality:
    def test_preset_levels(self):
        from compressor import JPEG_LEVELS
        s = CompressionSettings(level="high")
        result = _resolve_quality(s, JPEG_LEVELS)
        assert result["quality"] == 85

    def test_custom_high_quality(self):
        from compressor import JPEG_LEVELS
        s = CompressionSettings(level="custom", custom_quality=90)
        result = _resolve_quality(s, JPEG_LEVELS)
        assert result["quality"] == 90
        assert result["subsampling"] == "4:4:4"

    def test_custom_low_quality(self):
        from compressor import JPEG_LEVELS
        s = CompressionSettings(level="custom", custom_quality=50)
        result = _resolve_quality(s, JPEG_LEVELS)
        assert result["quality"] == 50
        assert result["subsampling"] == "4:2:0"

    def test_fallback_to_medium(self):
        from compressor import JPEG_LEVELS
        s = CompressionSettings(level="unknown_level")
        result = _resolve_quality(s, JPEG_LEVELS)
        assert result["quality"] == 70


# ── _build_output_path ───────────────────────

class TestBuildOutputPath:
    def test_default(self, tmp_dir):
        input_path = os.path.join(tmp_dir, "photo.jpg")
        s = CompressionSettings()
        result = _build_output_path(input_path, s)
        assert result.endswith("photo_compressed.jpg")
        assert os.path.dirname(result) == tmp_dir

    def test_output_dir(self, tmp_dir):
        input_path = os.path.join(tmp_dir, "photo.jpg")
        out_dir = os.path.join(tmp_dir, "output")
        s = CompressionSettings(output_dir=out_dir)
        result = _build_output_path(input_path, s)
        assert os.path.dirname(result) == out_dir

    def test_output_format_webp(self, tmp_dir):
        input_path = os.path.join(tmp_dir, "photo.jpg")
        s = CompressionSettings(output_format="webp")
        result = _build_output_path(input_path, s)
        assert result.endswith("photo_compressed.webp")


# ── _finalize_result ─────────────────────────

class TestFinalizeResult:
    def test_compression_effective(self, tmp_dir):
        """Quand le fichier compressé est plus petit → on le garde."""
        orig = os.path.join(tmp_dir, "orig.bin")
        comp = os.path.join(tmp_dir, "comp.bin")
        with open(orig, "wb") as f:
            f.write(b"x" * 1000)
        with open(comp, "wb") as f:
            f.write(b"x" * 500)

        import time
        result = _finalize_result(orig, comp, 1000, "test", time.time() - 0.1)
        assert result.kept_original is False
        assert result.compressed_size == 500
        assert result.reduction_pct > 0

    def test_compression_larger(self, tmp_dir):
        """Quand le fichier compressé est plus gros → on garde l'original."""
        orig = os.path.join(tmp_dir, "orig.bin")
        comp = os.path.join(tmp_dir, "comp.bin")
        with open(orig, "wb") as f:
            f.write(b"x" * 500)
        with open(comp, "wb") as f:
            f.write(b"x" * 1000)

        import time
        result = _finalize_result(orig, comp, 500, "test", time.time())
        assert result.kept_original is True
        assert result.compressed_size == 500

    def test_zero_size(self, tmp_dir):
        """Fichier original de taille 0 → pas de division par zéro."""
        orig = os.path.join(tmp_dir, "empty.bin")
        comp = os.path.join(tmp_dir, "comp.bin")
        with open(orig, "wb") as f:
            pass
        with open(comp, "wb") as f:
            pass

        import time
        result = _finalize_result(orig, comp, 0, "test", time.time())
        assert result.reduction_pct == 0


# ── compress_jpeg ────────────────────────────

class TestCompressJpeg:
    def test_basic(self, sample_jpeg, tmp_dir):
        out = os.path.join(tmp_dir, "out.jpg")
        result = compress_jpeg(sample_jpeg, out, quality=50)
        assert isinstance(result, CompressionResult)
        assert os.path.isfile(out)
        assert result.format == "jpeg"

    def test_with_resize(self, sample_jpeg, tmp_dir):
        out = os.path.join(tmp_dir, "out.jpg")
        result = compress_jpeg(sample_jpeg, out, quality=70, max_resolution=100)
        assert os.path.isfile(out)
        img = Image.open(out)
        assert max(img.size) <= 100
        img.close()

    def test_file_not_found(self, tmp_dir):
        with pytest.raises(FileNotFoundError):
            compress_jpeg("/nonexistent/file.jpg", os.path.join(tmp_dir, "out.jpg"))


# ── compress_png ─────────────────────────────

class TestCompressPng:
    def test_basic(self, sample_png, tmp_dir):
        out = os.path.join(tmp_dir, "out.png")
        result = compress_png(sample_png, out, colors=256)
        assert isinstance(result, CompressionResult)
        assert os.path.isfile(out)
        assert result.format == "png"

    def test_no_quantization(self, sample_png, tmp_dir):
        out = os.path.join(tmp_dir, "out.png")
        result = compress_png(sample_png, out, colors=None)
        assert os.path.isfile(out)

    def test_rgba(self, sample_png_rgba, tmp_dir):
        out = os.path.join(tmp_dir, "out.png")
        result = compress_png(sample_png_rgba, out, colors=128)
        assert os.path.isfile(out)

    def test_with_resize(self, sample_png, tmp_dir):
        out = os.path.join(tmp_dir, "out.png")
        compress_png(sample_png, out, max_resolution=50)
        img = Image.open(out)
        assert max(img.size) <= 50
        img.close()


# ── convert_to_webp ──────────────────────────

class TestConvertToWebp:
    def test_basic(self, sample_jpeg, tmp_dir):
        out = os.path.join(tmp_dir, "out.webp")
        result = convert_to_webp(sample_jpeg, out, quality=70)
        assert isinstance(result, CompressionResult)
        assert os.path.isfile(out)
        assert result.format == "webp"

    def test_target_size(self, sample_jpeg, tmp_dir):
        out = os.path.join(tmp_dir, "out.webp")
        result = convert_to_webp(sample_jpeg, out, target_size_kb=5)
        assert os.path.isfile(out)
        assert os.path.getsize(out) <= 5 * 1024 + 512  # marge de 512 bytes

    def test_from_png(self, sample_png, tmp_dir):
        out = os.path.join(tmp_dir, "out.webp")
        result = convert_to_webp(sample_png, out, quality=70)
        assert os.path.isfile(out)


# ── compress_file (dispatcher) ───────────────

class TestCompressFile:
    def test_jpeg(self, sample_jpeg, tmp_dir):
        s = CompressionSettings(level="medium", output_dir=tmp_dir)
        result = compress_file(sample_jpeg, s)
        assert result.format == "jpeg"
        assert result.level == "medium"

    def test_png(self, sample_png, tmp_dir):
        s = CompressionSettings(level="low", output_dir=tmp_dir)
        result = compress_file(sample_png, s)
        assert result.format == "png"
        assert result.level == "low"

    def test_webp(self, sample_webp, tmp_dir):
        s = CompressionSettings(level="high", output_dir=tmp_dir)
        result = compress_file(sample_webp, s)
        assert result.format == "webp"

    def test_jpeg_to_webp(self, sample_jpeg, tmp_dir):
        s = CompressionSettings(level="medium", output_format="webp", output_dir=tmp_dir)
        result = compress_file(sample_jpeg, s)
        assert result.format == "webp"
        assert result.output_path.endswith(".webp")

    def test_unknown_format(self, tmp_dir):
        txt_file = os.path.join(tmp_dir, "file.txt")
        with open(txt_file, "w") as f:
            f.write("hello")
        s = CompressionSettings()
        with pytest.raises(ValueError, match="Format non supporte"):
            compress_file(txt_file, s)

    def test_file_not_found(self):
        s = CompressionSettings()
        with pytest.raises(FileNotFoundError):
            compress_file("/nonexistent.jpg", s)

    def test_custom_level(self, sample_jpeg, tmp_dir):
        s = CompressionSettings(level="custom", custom_quality=30, output_dir=tmp_dir)
        result = compress_file(sample_jpeg, s)
        assert result.level == "custom"


# ── extract_zip ──────────────────────────────

class TestExtractZip:
    def test_basic(self, sample_zip):
        files, tmp_dir = extract_zip(sample_zip)
        try:
            assert len(files) == 2
            assert any("image.jpg" in f for f in files)
            assert any("logo.png" in f for f in files)
        finally:
            if tmp_dir:
                shutil.rmtree(tmp_dir, ignore_errors=True)

    def test_not_a_zip(self, tmp_dir):
        fake = os.path.join(tmp_dir, "fake.zip")
        with open(fake, "w") as f:
            f.write("not a zip")
        files, td = extract_zip(fake)
        assert files == []
        assert td is None

    def test_ignores_macosx(self, tmp_dir, sample_jpeg):
        zip_path = os.path.join(tmp_dir, "mac.zip")
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.write(sample_jpeg, "__MACOSX/._photo.jpg")
            zf.write(sample_jpeg, "photo.jpg")
        files, td = extract_zip(zip_path)
        try:
            assert len(files) == 1
            assert "photo.jpg" in files[0]
        finally:
            if td:
                shutil.rmtree(td, ignore_errors=True)

    def test_ignores_hidden_files(self, tmp_dir, sample_jpeg):
        zip_path = os.path.join(tmp_dir, "hidden.zip")
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.write(sample_jpeg, ".hidden.jpg")
            zf.write(sample_jpeg, "visible.jpg")
        files, td = extract_zip(zip_path)
        try:
            assert len(files) == 1
            assert "visible.jpg" in files[0]
        finally:
            if td:
                shutil.rmtree(td, ignore_errors=True)

    def test_ignores_unsupported_formats(self, tmp_dir):
        zip_path = os.path.join(tmp_dir, "mixed.zip")
        txt = os.path.join(tmp_dir, "note.txt")
        with open(txt, "w") as f:
            f.write("hello")
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.write(txt, "note.txt")
        files, td = extract_zip(zip_path)
        try:
            assert files == []
        finally:
            if td:
                shutil.rmtree(td, ignore_errors=True)


# ── expand_paths ─────────────────────────────

class TestExpandPaths:
    def test_single_file(self, sample_jpeg):
        files, tmps = expand_paths([sample_jpeg])
        assert len(files) == 1
        assert files[0] == sample_jpeg
        assert tmps == []

    def test_directory(self, tmp_dir, sample_jpeg, sample_png):
        files, tmps = expand_paths([tmp_dir])
        assert len(files) >= 2
        assert tmps == []

    def test_zip_extraction(self, sample_zip):
        files, tmps = expand_paths([sample_zip])
        try:
            assert len(files) == 2
            assert len(tmps) == 1
        finally:
            for td in tmps:
                shutil.rmtree(td, ignore_errors=True)

    def test_unsupported_file(self, tmp_dir):
        txt = os.path.join(tmp_dir, "file.txt")
        with open(txt, "w") as f:
            f.write("hello")
        files, tmps = expand_paths([txt])
        assert files == []

    def test_nonexistent_path(self):
        files, tmps = expand_paths(["/nonexistent/path"])
        assert files == []
        assert tmps == []


# ── CompressionResult ────────────────────────

class TestCompressionResult:
    def test_to_dict(self):
        r = CompressionResult(
            input_path="/in.jpg", output_path="/out.jpg",
            original_size=1000, compressed_size=500,
            format="jpeg", level="medium",
            reduction_pct=50.0, duration=1.2, kept_original=False,
        )
        d = r.to_dict()
        assert d["format"] == "jpeg"
        assert d["reduction_pct"] == 50.0
        assert isinstance(d, dict)


# ── CompressionSettings ─────────────────────

class TestCompressionSettings:
    def test_defaults(self):
        s = CompressionSettings()
        assert s.level == "medium"
        assert s.custom_quality == 70
        assert s.max_resolution is None

    def test_custom(self):
        s = CompressionSettings(level="low", custom_quality=30, max_resolution=800)
        assert s.level == "low"
        assert s.custom_quality == 30
        assert s.max_resolution == 800
