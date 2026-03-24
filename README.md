# Compressor

> App macOS native de compression de fichiers — PDF, JPEG, PNG, WebP, TIFF, SVG.
> Tout est traite en local, aucun upload cloud. Vos fichiers restent sur votre machine.

<p align="center">
  <img src="static/icon.png" alt="Compressor" width="128">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-3.0.2-D0BCFF?style=flat-square" alt="Version">
  <img src="https://img.shields.io/badge/platform-macOS%2012%2B-lightgrey?style=flat-square" alt="macOS">
  <img src="https://img.shields.io/badge/python-3.10%2B-3776AB?style=flat-square" alt="Python">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License">
</p>

---

## Fonctionnalites

### Compression

- **PDF** — Rasterisation par page avec controle DPI et qualite
- **JPEG** — Recompression avec qualite, subsampling, conservation EXIF
- **PNG** — Compression optimisee via **pngquant** + **oxipng** (jusqu'a -95%)
- **WebP** — Compression lossy/lossless avec option taille cible
- **TIFF** — Compression deflate ou conversion vers JPEG/PNG/WebP
- **SVG** — Import sans modification (pass-through)
- **Batch** — Glisser un dossier entier, traitement parallele

### Outils avances

- **Redimensionnement** — Par largeur, hauteur, pourcentage, fit ou dimensions exactes
- **Conversion de format** — JPEG vers WebP, PNG vers JPEG, TIFF vers PNG, etc.
- **Taille cible** — Recherche dichotomique de la qualite/couleurs optimales
- **Strip metadata** — Suppression des donnees EXIF, GPS, date de prise de vue
- **Mode lossless** — Compression sans perte (WebP, PNG via oxipng)
- **Suffixe personnalise** — `_compressed`, `_web`, `_hd`, etc.
- **Structure dossier** — Glisser un dossier → export dans `[dossier]-export/` avec la meme arborescence

### Presets

- **Presets** — Sauvegardez vos configs favorites (format, qualite, resize, etc.)
- **Categories** — Organisez vos presets (Web, Print, Email, Archive...)
- **Raccourcis rapides** — 3 slots d'acces direct dans la sidebar
- **Import / Export** — Partagez vos presets en JSON entre collegues
- **Config par format** — Au drop d'un dossier multi-format : assignez un preset par type (JPEG, PNG, WebP)

### Interface

- **Design M3** — Material Design 3 dark theme
- **Drag & drop** — Glisser-deposer des fichiers ou dossiers (y compris sur la liste existante)
- **Estimations en temps reel** — Poids estime par fichier, mis a jour en live quand vous changez les parametres
- **Dimensions live** — Les dimensions affichees se mettent a jour quand vous changez le redimensionnement
- **Preview** — Comparaison avant/apres cote a cote avec zoom
- **Filtres par format** — Filtrer la liste par JPEG, PNG, WebP, PDF
- **Historique** — 500 dernieres compressions avec statistiques
- **Barre de progression** — Compteur d'images + temps restant + animation de fin
- **Notifications macOS** — Notification native quand la compression est terminee

### Mises a jour automatiques

- L'app verifie les nouvelles versions au demarrage (via GitHub Releases)
- Un badge apparait si une mise a jour est disponible
- Un clic pour telecharger, installer et redemarrer

---

## Installation

### Option 1 — DMG (recommande)

1. Telechargez le `.dmg` depuis la [page Releases](https://github.com/leorfi/compressor/releases/latest)
2. Ouvrez le DMG, glissez **Compressor** dans **Applications**
3. Premiere ouverture : **clic-droit > Ouvrir** (app non signee par Apple)
4. C'est installe. Les futures mises a jour se font automatiquement depuis l'app.

### Option 2 — Depuis les sources

```bash
# Cloner le depot
git clone https://github.com/leorfi/compressor.git
cd compressor

# Environnement virtuel
python3 -m venv .venv
source .venv/bin/activate

# Dependances
pip install -r requirements.txt

# Outils PNG optionnels (fortement recommandes)
brew install pngquant oxipng

# Lancer
python3 main.py
```

### Prerequis (sources uniquement)

- macOS 12+ (Monterey)
- Python 3.10+
- Git
- **pngquant** + **oxipng** (optionnel, pour la compression PNG optimisee)

---

## Utilisation

### Compression

1. **Glisser-deposer** des fichiers ou dossiers dans la zone de drop
2. Choisir le **niveau** (High / Medium / Low / Custom)
3. Ajuster les options (format, resize, taille cible, suffixe...)
4. Cliquer **Compresser**
5. Les fichiers sont crees dans le dossier de sortie (ou `[dossier]-export/`)

### Presets

- **Sauvegarder** : Configurez vos options, cliquez l'icone disque, nommez votre preset
- **Raccourcis** : 3 slots rapides dans la sidebar — clic pour appliquer instantanement
- **Gerer** : Cliquez "Gerer les presets" pour renommer, supprimer, importer/exporter

### Config par format (dossiers multi-format)

Quand vous glissez un dossier contenant plusieurs formats (JPEG + PNG + WebP), un popup vous propose d'assigner un preset different par format. Chaque fichier sera compresse avec son propre preset.

---

## Architecture

```
app/
├── main.py               # Flask + pywebview + routes API
├── compressor.py          # Moteur de compression (PDF, JPEG, PNG, WebP, TIFF, SVG)
├── history.py             # Persistance : settings, presets, historique
├── config.py              # Configuration (.env + detection mode bundle)
├── VERSION                # Version semver
├── requirements.txt       # Dependances Python
├── compressor.spec        # Config PyInstaller (build .app)
├── build_dmg.sh           # Script de build DMG automatise
├── static/
│   ├── css/style.css      # Styles M3 dark theme (~2000 lignes)
│   ├── js/app.js          # Frontend (~3000 lignes)
│   ├── icon.png           # Icone 512x512
│   └── icon.icns          # Icone multi-resolution macOS
└── templates/
    └── index.html         # Page principale
```

### Stack technique

| Composant | Technologie |
|-----------|-------------|
| GUI native | **pywebview** (WebKit macOS) |
| Serveur local | **Flask** (127.0.0.1, port 5050-5060) |
| Compression PDF | **PyMuPDF** (fitz) |
| Compression images | **Pillow** (PIL) |
| Compression PNG | **pngquant** + **oxipng** (externe, optionnel) |
| Progression | Server-Sent Events (SSE) |
| Persistance | JSON + `fcntl` file locking + atomic writes |
| Build | **PyInstaller** + `hdiutil` (DMG natif macOS) |
| Mises a jour | GitHub Releases API |

---

## Stockage

Toutes les donnees sont stockees localement dans `~/.config/compressor/` :

```
~/.config/compressor/
├── settings.json       # Parametres globaux
├── presets.json        # Presets + categories
└── history.json        # Historique (500 max)
```

---

## Build

### Generer le DMG

```bash
bash build_dmg.sh
```

Resultat : `dist/Compressor-X.Y.Z.dmg` (~42 MB)

### Publier une release

```bash
# Tag + push
git tag -a v3.0.0 -m "Description"
git push origin main --tags

# Publier le DMG
gh release create v3.0.0 dist/Compressor-3.0.0.dmg --title "v3.0.0" --notes "Changelog"
```

Les utilisateurs recevront la notification de mise a jour dans l'app.

---

## Securite

- **Zero upload** — Tout est traite en local
- **Serveur local** — Flask sur `127.0.0.1` uniquement
- **Headers de securite** — `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`
- **Protection path traversal** — Verification `realpath` sur tous les chemins
- **Validation des entrees** — Types, bornes, formats sur toutes les routes
- **Thread safety** — `threading.Lock` sur les queues SSE, `fcntl` sur les fichiers JSON

---

## Changelog

### v3.0.2 (2026-03-24)
- Bandeau de mise a jour visible au lancement de l'app
- Fix SSL certificates pour auto-update dans le bundle macOS
- Fix thumbnails PNG mode palette (P/PA)

### v3.0.0 (2026-03-24)
- Compression PNG optimisee via **pngquant** + **oxipng** (jusqu'a -95%)
- Support **TIFF** et **SVG**
- Config par format : preset different par type de fichier (JPEG, PNG, WebP)
- Estimations precises en temps reel (thumbnail pngquant)
- Dimensions live (mise a jour quand on change le resize)
- Reset auto des resultats quand on change les parametres
- Barre de progression redesignee (compteur + temps restant + animation)
- Notification macOS native a la fin de la compression
- Correction thumbnails PNG mode palette (P/PA)
- Niveaux JPEG recalibres (Medium: Q60, Low: Q35)
- Simplification : retrait du systeme de profils utilisateurs
- Accordeon dans le gestionnaire de presets
- Raccourcis rapides (3 slots)

### v2.2.0 (2026-03-23)
- Systeme de presets complet (CRUD, categories, import/export)
- Build DMG distribuable (PyInstaller)
- Auto-update via GitHub Releases

### v2.1.0 (2026-03-10)
- Resize modes, metadata, suffixe, lossless, estimation

### v2.0.0 (2026-03-09)
- Refonte UI : Material Design 3, layout 2 colonnes

### v1.0.0 (2026-03-09)
- Version initiale — compression PDF, JPEG, PNG, WebP

---

## Licence

MIT — Libre d'utilisation et de modification.

---

<p align="center">
  <sub>Fait avec Python, Flask et pywebview — IPLN Design</sub>
</p>
