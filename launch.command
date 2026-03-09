#!/bin/bash
# Compressor — Double-clic pour lancer l'app
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
    echo "❌ Environnement virtuel introuvable (.venv)"
    echo "   Executez: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
    read -p "Appuyez sur Entree pour fermer..."
    exit 1
fi

source .venv/bin/activate

# Vérifier que les dépendances sont installées
if ! python3 -c "import webview, flask, PIL, fitz" 2>/dev/null; then
    echo "⚠️  Dependances manquantes. Installation..."
    pip install -r requirements.txt
fi

python3 main.py
