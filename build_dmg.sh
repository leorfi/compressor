#!/bin/bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION=$(cat "$APP_DIR/VERSION")
APP_NAME="Compressor"
DMG_NAME="${APP_NAME}-${VERSION}.dmg"

echo "=== Build $APP_NAME v${VERSION} ==="
echo ""

# 1. Activer le venv
echo "[1/5] Activation du venv..."
source "$APP_DIR/.venv/bin/activate"

# 2. Installer PyInstaller si absent
if ! pip show pyinstaller > /dev/null 2>&1; then
    echo "[2/5] Installation de PyInstaller..."
    pip install pyinstaller
else
    echo "[2/5] PyInstaller deja installe"
fi

# 3. Clean + Build
echo "[3/5] Build de l'app..."
rm -rf "$APP_DIR/build" "$APP_DIR/dist"
cd "$APP_DIR"
pyinstaller compressor.spec --noconfirm --clean

# 4. Verifier le build
APP_PATH="$APP_DIR/dist/Compressor.app"
if [ ! -d "$APP_PATH" ]; then
    echo "ERREUR: Build echoue — $APP_PATH introuvable"
    exit 1
fi
echo "[4/5] Build OK : $APP_PATH"

# 5. Creer le DMG
echo "[5/5] Creation du DMG..."
DMG_DIR="$APP_DIR/dist/dmg"
rm -rf "$DMG_DIR"
mkdir -p "$DMG_DIR"
cp -R "$APP_PATH" "$DMG_DIR/"
ln -s /Applications "$DMG_DIR/Applications"

hdiutil create -volname "$APP_NAME" \
    -srcfolder "$DMG_DIR" \
    -ov -format UDZO \
    "$APP_DIR/dist/$DMG_NAME"

rm -rf "$DMG_DIR"

echo ""
echo "=== Build termine ==="
echo "DMG : $APP_DIR/dist/$DMG_NAME"
echo "Taille : $(du -h "$APP_DIR/dist/$DMG_NAME" | cut -f1)"
echo ""
echo "Pour installer : ouvrir le DMG, glisser Compressor dans Applications."
echo "Premiere ouverture : clic-droit > Ouvrir (app non signee)."
