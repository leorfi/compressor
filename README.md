# Compressor

App macOS native de compression de fichiers (PDF, JPEG, PNG, WebP).
Interface graphique locale, aucun upload cloud, tout reste sur ta machine.

![Version](https://img.shields.io/badge/version-1.0.1-blue)
![macOS](https://img.shields.io/badge/platform-macOS%2012%2B-lightgrey)
![Python](https://img.shields.io/badge/python-3.10%2B-yellow)

---

## Fonctionnalites

- **Compression PDF** — rasterisation par page avec presets DPI/qualite
- **Compression JPEG** — qualite, subsampling, conservation EXIF
- **Compression PNG** — reduction de palette adaptative
- **Conversion WebP** — avec option taille cible (dichotomie)
- **Batch** — glisser un dossier entier, traitement de tous les fichiers supportes
- **Previsualisation** — comparaison avant/apres cote a cote
- **Historique** — 500 dernieres compressions avec statistiques
- **Parametres** — notifications, dossier de sortie par defaut, mise a jour auto
- **Mises a jour** — verification et installation via Git (pas besoin de token)
- **Progression temps reel** — Server-Sent Events (SSE) avec reconnexion auto
- **Notifications macOS** — via `terminal-notifier` (optionnel)

---

## Architecture

```
app/
├── main.py              # Point d'entree — Flask + pywebview + routes API
├── compressor.py         # Moteur de compression (PDF, JPEG, PNG, WebP)
├── history.py            # Persistance historique + settings (JSON + file locking)
├── VERSION               # Version courante (semver)
├── requirements.txt      # Dependances Python
├── launch.command         # Script de lancement double-clic macOS
├── .gitignore
├── static/
│   ├── css/style.css     # Styles (dark theme, modals, toggles)
│   ├── js/app.js         # Frontend (drag&drop, SSE, modals, settings, updates)
│   ├── icon.png          # Icone app 512x512
│   └── icon.icns         # Icone multi-resolution pour .app bundle
└── templates/
    └── index.html        # Page principale (Jinja2)
```

### Stack technique

| Composant | Technologie |
|-----------|-------------|
| GUI native | **pywebview** (WebKit macOS) |
| Serveur local | **Flask** (127.0.0.1, port 5050-5060) |
| Compression PDF | **PyMuPDF** (fitz) |
| Compression images | **Pillow** (PIL) |
| Progression | Server-Sent Events (SSE) via `queue.Queue` |
| Persistance | JSON avec `fcntl` file locking |
| Mises a jour | `git fetch --tags` + comparaison semver locale |
| Notifications | `terminal-notifier` (optionnel, Homebrew) |
| Icone dock | **AppKit** (NSImage via pyobjc) |

---

## Installation

### Prerequis

- macOS 12+ (Monterey ou plus recent)
- Python 3.10+
- Git

### Installation rapide

```bash
# 1. Cloner le depot
git clone https://github.com/leorfi/compressor.git
cd compressor

# 2. Creer l'environnement virtuel
python3 -m venv .venv
source .venv/bin/activate

# 3. Installer les dependances
pip install -r requirements.txt

# 4. Lancer l'app
python3 main.py
```

### Raccourci bureau (optionnel)

Un fichier `Compressor.app` peut etre place sur le bureau pour un lancement en double-clic.
La structure minimale :

```
Compressor.app/
└── Contents/
    ├── Info.plist
    ├── MacOS/Compressor     # Script bash : cd + activate + python3 main.py
    └── Resources/icon.icns
```

> Au premier lancement, macOS peut demander confirmation (app non signee).
> Solution : **clic droit > Ouvrir** une seule fois.

---

## Utilisation

### Lancement

```bash
# Methode 1 — Terminal
source .venv/bin/activate && python3 main.py

# Methode 2 — Double-clic sur launch.command (Finder)

# Methode 3 — Double-clic sur Compressor.app (Bureau)
```

L'app s'ouvre dans une fenetre native macOS (pas un navigateur).

### Compression

1. **Glisser-deposer** des fichiers ou dossiers dans la zone de drop
2. Ou cliquer **Parcourir** pour ouvrir le dialogue natif
3. Choisir le **niveau** de compression (Haute qualite / Moyen / Leger / Personnalise)
4. Cliquer **Compresser**
5. Les fichiers compresses sont crees a cote des originaux (suffixe `_compressed`)

### Formats supportes

| Format | Extensions | Methode |
|--------|-----------|---------|
| PDF | `.pdf` | Rasterisation page par page (DPI + qualite JPEG) |
| JPEG | `.jpg`, `.jpeg` | Recompression avec controle qualite + subsampling |
| PNG | `.png` | Reduction palette adaptative (128-256 couleurs) |
| WebP | `.webp` | Compression lossy avec option taille cible |

### Options avancees

- **Resolution max** — Redimensionne les images au-dela d'un seuil (px)
- **Format de sortie** — Forcer la conversion (ex: JPEG vers WebP)
- **Taille cible** — Recherche dichotomique de la qualite optimale (WebP)
- **Dossier de sortie** — Ecrire les fichiers compresses ailleurs que dans le dossier source

### Previsualisation

Apres compression, cliquer sur l'oeil (icone preview) pour comparer visuellement l'original et le fichier compresse cote a cote.

---

## API locale

Le serveur Flask expose ces endpoints (127.0.0.1 uniquement) :

| Methode | Route | Description |
|---------|-------|-------------|
| `GET` | `/` | Page principale |
| `POST` | `/api/compress` | Lance une compression batch |
| `GET` | `/api/progress` | Stream SSE (progression temps reel) |
| `GET` | `/api/history` | Historique des compressions |
| `POST` | `/api/history/clear` | Vider l'historique |
| `GET` | `/api/settings` | Lire les parametres |
| `POST` | `/api/settings` | Sauvegarder les parametres |
| `GET` | `/api/app/version` | Version courante |
| `GET` | `/api/updates/check` | Verifier les mises a jour (git fetch --tags) |
| `POST` | `/api/updates/apply` | Installer la mise a jour (git pull --ff-only) |
| `POST` | `/api/preview` | Generer les thumbnails avant/apres |

---

## Parametres

Les parametres sont stockes dans `~/.config/compressor/settings.json`.

| Cle | Type | Defaut | Description |
|-----|------|--------|-------------|
| `level` | string | `"medium"` | Preset de compression |
| `custom_quality` | int | `70` | Qualite personnalisee (1-100) |
| `max_resolution` | int/null | `null` | Resolution max en pixels |
| `output_format` | string/null | `null` | Format de sortie force |
| `target_size_kb` | int/null | `null` | Taille cible en Ko (WebP) |
| `output_dir` | string/null | `null` | Dossier de sortie |
| `notifications_enabled` | bool | `true` | Notifications macOS |
| `auto_check_updates` | bool | `true` | Verification auto au lancement |
| `default_output_dir` | string/null | `null` | Dossier de sortie par defaut |

L'historique est dans `~/.config/compressor/history.json` (500 entrees max).

---

## Mises a jour

L'app verifie les mises a jour via les tags Git du depot distant :

1. `git fetch --tags` — recupere les tags sans modifier le code
2. Compare le dernier tag (`v1.0.1`) avec la version locale (`VERSION`)
3. Si une MAJ est dispo, l'utilisateur peut l'installer (= `git pull --ff-only`)
4. Redemarrage manuel de l'app apres installation

> Fonctionne avec un depot prive — pas besoin de token GitHub.
> Condition : le clone local doit avoir acces au remote (SSH ou HTTPS).

---

## Securite

- **Aucun upload** — tout est traite en local
- **Serveur local uniquement** — Flask ecoute sur `127.0.0.1` (pas accessible depuis le reseau)
- **Headers de securite** — `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`
- **Protection path traversal** — verification `realpath` sur les chemins de preview
- **Validation des entrees** — types, bornes, formats valides sur toutes les routes
- **Thread safety** — `threading.Lock` sur les queues SSE, `fcntl` file locking sur le JSON
- **Pas de dependance externe pour les MAJ** — uniquement Git natif

---

## Developpement

### Structure du code

- **`compressor.py`** — Moteur pur (pas de Flask, pas d'I/O reseau). Peut etre utilise en standalone.
- **`history.py`** — Persistance avec file locking. Thread-safe pour les acces concurrents.
- **`main.py`** — Orchestrateur : Flask routes + pywebview + SSE + updates.
- **`app.js`** — Frontend complet : drag&drop, SSE reconnexion, modals, settings.

### Ajouter un format

1. Ajouter l'extension dans `SUPPORTED_EXTENSIONS` (`compressor.py`)
2. Creer les presets (`XX_LEVELS`)
3. Ecrire la fonction `compress_xx()`
4. Ajouter le cas dans `compress_file()` (dispatcher)
5. Mettre a jour le dialogue natif dans `Api.choose_files()` (`main.py`)

### Conventions Git

- Branche principale : `main`
- Format commit : `[type] Description courte (vX.Y.Z)`
- Types : `feat`, `fix`, `refactor`, `security`, `perf`, `docs`
- Tags annotes pour chaque version mineure/majeure
- Versioning semver dans `VERSION`

---

## Changelog

### v1.0.1 (2026-03-09)
- Ajout icone app (dock macOS + favicon)

### v1.0.0 (2026-03-09)
- Version initiale
- Compression PDF, JPEG, PNG, WebP
- Interface GUI native (pywebview + Flask)
- Drag & drop, preview, historique, statistiques
- Panneau Parametres (notifications, dossier de sortie, MAJ auto)
- Systeme de mises a jour via Git
- Audit securite (25 corrections appliquees)

---

## Licence

Projet interne IPLN. Usage prive.
