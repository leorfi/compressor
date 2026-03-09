#!/usr/bin/env python3
"""Configuration de l'application — lit .env si présent, sinon valeurs par défaut."""

import os

APP_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_FILE = os.path.join(APP_DIR, ".env")


def _load_env_file():
    """Charge un fichier .env basique (KEY=VALUE, pas de quotes nécessaires)."""
    if not os.path.isfile(ENV_FILE):
        return
    with open(ENV_FILE, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip("'\"")
            # Ne pas écraser les variables d'environnement déjà définies
            if key not in os.environ:
                os.environ[key] = value


# Charger le .env au moment de l'import
_load_env_file()


# ── Valeurs de configuration ──────────────────

DEBUG = os.environ.get("COMPRESSOR_DEBUG", "").lower() in ("1", "true")
PORT_START = int(os.environ.get("COMPRESSOR_PORT_START", "5050"))
PORT_END = int(os.environ.get("COMPRESSOR_PORT_END", "5060"))
NOTIFIER_PATH = os.environ.get("COMPRESSOR_NOTIFIER", "/opt/homebrew/bin/terminal-notifier")
LOG_LEVEL = os.environ.get("COMPRESSOR_LOG_LEVEL", "INFO").upper()
