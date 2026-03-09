#!/usr/bin/env python3
"""Tests unitaires pour la persistance (history + settings)."""

import os
import json
import shutil
import tempfile

import pytest

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import history


@pytest.fixture(autouse=True)
def isolated_config(monkeypatch, tmp_path):
    """Redirige les fichiers de config vers un dossier temp pour chaque test."""
    config_dir = str(tmp_path / "config")
    monkeypatch.setattr(history, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(history, "HISTORY_FILE", os.path.join(config_dir, "history.json"))
    monkeypatch.setattr(history, "SETTINGS_FILE", os.path.join(config_dir, "settings.json"))
    os.makedirs(config_dir, exist_ok=True)


# ── History ──────────────────────────────────

class TestHistory:
    def test_empty_history(self):
        entries = history.load_history()
        assert entries == []

    def test_add_entry(self):
        entry = history.add_entry({"format": "jpeg", "original_size": 1000, "compressed_size": 500})
        assert "timestamp" in entry
        assert entry["format"] == "jpeg"

    def test_get_history_order(self):
        history.add_entry({"format": "jpeg", "name": "first"})
        history.add_entry({"format": "png", "name": "second"})
        entries = history.get_history(limit=10)
        # Most recent first
        assert entries[0]["name"] == "second"
        assert entries[1]["name"] == "first"

    def test_get_history_limit(self):
        for i in range(10):
            history.add_entry({"index": i})
        entries = history.get_history(limit=3)
        assert len(entries) == 3

    def test_get_history_offset(self):
        for i in range(5):
            history.add_entry({"index": i})
        entries = history.get_history(limit=2, offset=2)
        assert len(entries) == 2

    def test_clear_history(self):
        history.add_entry({"format": "jpeg"})
        history.clear_history()
        assert history.load_history() == []

    def test_max_history_limit(self, monkeypatch):
        monkeypatch.setattr(history, "MAX_HISTORY", 5)
        for i in range(10):
            history.add_entry({"index": i})
        entries = history.load_history()
        assert len(entries) == 5


# ── Stats ────────────────────────────────────

class TestStats:
    def test_empty_stats(self):
        stats = history.get_stats()
        assert stats["total_files"] == 0
        assert stats["total_saved_bytes"] == 0

    def test_stats_calculation(self):
        history.add_entry({"format": "jpeg", "original_size": 1000, "compressed_size": 500, "reduction_pct": 50.0})
        history.add_entry({"format": "png", "original_size": 2000, "compressed_size": 1000, "reduction_pct": 50.0})
        stats = history.get_stats()
        assert stats["total_files"] == 2
        assert stats["total_saved_bytes"] == 1500
        assert stats["avg_reduction"] == 50.0
        assert stats["formats"]["jpeg"] == 1
        assert stats["formats"]["png"] == 1


# ── Settings ─────────────────────────────────

class TestSettings:
    def test_default_settings(self):
        s = history.load_settings()
        assert s["level"] == "medium"
        assert s["custom_quality"] == 70
        assert s["notifications_enabled"] is True

    def test_save_and_load(self):
        history.save_settings({"level": "high", "custom_quality": 90})
        s = history.load_settings()
        assert s["level"] == "high"
        assert s["custom_quality"] == 90

    def test_validation_invalid_level(self):
        history.save_settings({"level": "invalid_level"})
        s = history.load_settings()
        assert s["level"] == "medium"

    def test_validation_quality_bounds(self):
        history.save_settings({"custom_quality": 200})
        s = history.load_settings()
        assert s["custom_quality"] == 100

        history.save_settings({"custom_quality": -5})
        s = history.load_settings()
        assert s["custom_quality"] == 1

    def test_validation_invalid_format(self):
        history.save_settings({"output_format": "gif"})
        s = history.load_settings()
        assert s["output_format"] is None

    def test_unknown_keys_ignored(self):
        history.save_settings({"unknown_key": "value", "level": "low"})
        s = history.load_settings()
        assert "unknown_key" not in s
        assert s["level"] == "low"


# ── Atomic writes ────────────────────────────

class TestAtomicWrites:
    def test_write_creates_file(self):
        filepath = history.HISTORY_FILE
        history._write_json_locked(filepath, [{"test": True}])
        assert os.path.isfile(filepath)
        with open(filepath) as f:
            data = json.load(f)
        assert data == [{"test": True}]

    def test_no_tmp_file_left(self):
        filepath = history.HISTORY_FILE
        history._write_json_locked(filepath, {"key": "value"})
        # Le fichier .tmp ne doit pas rester
        assert not os.path.isfile(filepath + ".tmp")

    def test_corrupted_json_returns_default(self):
        filepath = history.HISTORY_FILE
        with open(filepath, "w") as f:
            f.write("{invalid json")
        result = history._read_json_locked(filepath, default=[])
        assert result == []
