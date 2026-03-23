# Compressor

> App macOS native de compression de fichiers — PDF, JPEG, PNG, WebP.
> Tout est traite en local, aucun upload cloud. Vos fichiers restent sur votre machine.

<p align="center">
  <img src="static/icon.png" alt="Compressor" width="128">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-2.2.0-D0BCFF?style=flat-square" alt="Version">
  <img src="https://img.shields.io/badge/platform-macOS%2012%2B-lightgrey?style=flat-square" alt="macOS">
  <img src="https://img.shields.io/badge/python-3.10%2B-3776AB?style=flat-square" alt="Python">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License">
</p>

---

## Fonctionnalites

### Compression

- **PDF** — Rasterisation par page avec controle DPI et qualite
- **JPEG** — Recompression avec qualite, subsampling, conservation EXIF
- **PNG** — Reduction de palette adaptative (128-256 couleurs)
- **WebP** — Compression lossy avec option taille cible (dichotomie)
- **Batch** — Glisser un dossier entier, traitement parallele

### Outils avances

- **Redimensionnement** — Par largeur, hauteur, pourcentage, fit ou dimensions exactes
- **Conversion de format** — JPEG vers WebP, PNG vers JPEG, etc.
- **Taille cible** — Recherche dichotomique de la qualite optimale
- **Strip metadata** — Suppression des donnees EXIF
- **Mode lossless** — Compression sans perte (WebP, PNG)
- **Suffixe personnalise** — `_compressed`, `_web`, `_hd`, etc.

### Presets

- **Systeme de presets** — Sauvegardez vos configs favorites (format, qualite, resize, etc.)
- **Categories** — Organisez vos presets (Web, Print, Email, Archive...)
- **Import / Export** — Partagez vos presets en JSON entre collegues
- **Application rapide** — Selectionnez un preset dans la sidebar, il s'applique instantanement

### Profils utilisateurs

- **Multi-utilisateurs** — Chaque personne a son profil avec ses propres presets et parametres
- **Mot de passe** — Protection par profil (hash scrypt via Werkzeug)
- **Donnees isolees** — Settings, presets, historique separes par utilisateur

### Interface

- **Design M3** — Material Design 3 dark theme
- **Drag & drop** — Glisser-deposer des fichiers ou dossiers
- **Preview** — Comparaison avant/apres cote a cote avec zoom
- **Historique** — 500 dernieres compressions avec statistiques
- **Progression** — Temps reel via Server-Sent Events
- **Notifications macOS** — Via `terminal-notifier` (optionnel)

### Mises a jour automatiques

- L'app verifie les nouvelles versions au demarrage
- Un badge apparait si une mise a jour est disponible
- Un clic pour telecharger, installer et redemarrer — sans intervention manuelle

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

# Lancer
python3 main.py
```

### Prerequis (sources uniquement)

- macOS 12+ (Monterey)
- Python 3.10+
- Git

---

## Utilisation

### Compression

1. **Glisser-deposer** des fichiers ou dossiers dans la zone de drop
2. Choisir le **niveau** (Haute qualite / Moyen / Leger / Personnalise)
3. Ajuster les options (format, resize, suffixe...)
4. Cliquer **Compresser**
5. Les fichiers sont crees a cote des originaux

### Presets

- **Sauvegarder** : Configurez vos options, cliquez l'icone enregistrer, nommez votre preset
- **Appliquer** : Selectionnez un preset dans le dropdown, les options s'appliquent
- **Gerer** : Ouvrez le gestionnaire (icone presets dans la top bar) pour renommer, modifier, supprimer, importer/exporter

### Profils

Au premier lancement, creez votre profil (nom + mot de passe). Vos presets et parametres sont lies a votre profil.

---

## Architecture

```
app/
├── main.py               # Flask + pywebview + routes API + updates
├── compressor.py          # Moteur de compression (pur, sans I/O reseau)
├── history.py             # Persistance : users, settings, presets, historique
├── config.py              # Configuration (.env + detection mode bundle)
├── VERSION                # Version semver
├── requirements.txt       # Dependances Python
├── compressor.spec        # Config PyInstaller (build .app)
├── build_dmg.sh           # Script de build DMG automatise
├── static/
│   ├── css/style.css      # Styles M3 dark theme
│   ├── js/app.js          # Frontend (drag&drop, SSE, modals, auth, presets)
│   ├── icon.png           # Icone 512x512
│   └── icon.icns          # Icone multi-resolution macOS
└── templates/
    └── index.html         # Page principale (Jinja2)
```

### Stack technique

| Composant | Technologie |
|-----------|-------------|
| GUI native | **pywebview** (WebKit macOS) |
| Serveur local | **Flask** (127.0.0.1, port 5050-5060) |
| Compression PDF | **PyMuPDF** (fitz) |
| Compression images | **Pillow** (PIL) |
| Progression | Server-Sent Events (SSE) |
| Persistance | JSON + `fcntl` file locking + atomic writes |
| Auth | **Werkzeug** (scrypt password hashing) |
| Build | **PyInstaller** + `hdiutil` (DMG natif macOS) |
| Mises a jour | GitHub Releases API (bundle) / Git tags (dev) |

---

## API locale

Le serveur Flask ecoute sur `127.0.0.1` uniquement :

| Methode | Route | Description |
|---------|-------|-------------|
| `POST` | `/api/compress` | Lance une compression batch |
| `GET` | `/api/progress` | Stream SSE (progression temps reel) |
| `POST` | `/api/estimate` | Estime les tailles pour plusieurs niveaux |
| `GET` | `/api/settings` | Lire les parametres |
| `POST` | `/api/settings` | Sauvegarder les parametres |
| `GET` | `/api/presets` | Liste des presets + categories |
| `POST` | `/api/presets` | Creer un preset |
| `PUT` | `/api/presets/<id>` | Modifier un preset |
| `DELETE` | `/api/presets/<id>` | Supprimer un preset |
| `POST` | `/api/presets/import` | Importer des presets (JSON) |
| `POST` | `/api/presets/export` | Exporter des presets |
| `GET` | `/api/users/status` | Etat de l'auth (session active ?) |
| `POST` | `/api/users/login` | Connexion |
| `POST` | `/api/users/logout` | Deconnexion |
| `GET` | `/api/updates/check` | Verifier les mises a jour |
| `POST` | `/api/updates/apply` | Installer la mise a jour |
| `GET` | `/api/history` | Historique des compressions |

---

## Stockage

Toutes les donnees sont stockees localement dans `~/.config/compressor/` :

```
~/.config/compressor/
├── users.json              # Registre des profils (hash, pas de mdp en clair)
├── session.json            # Session active
└── users/
    └── <user_id>/
        ├── settings.json   # Parametres de l'utilisateur
        ├── presets.json    # Presets + categories
        └── history.json   # Historique (500 max)
```

---

## Build

### Generer le DMG

```bash
# Depuis le dossier app/
bash build_dmg.sh
```

Resultat : `dist/Compressor-X.Y.Z.dmg` (~42 MB)

Le script installe PyInstaller si necessaire, build le `.app`, et cree le DMG avec le layout drag-to-Applications.

### Publier une release

```bash
# Tag + push
git tag -a v2.2.0 -m "Description des changements"
git push origin main --tags

# Publier le DMG sur GitHub Releases
gh release create v2.2.0 dist/Compressor-2.2.0.dmg --title "v2.2.0" --notes "Changelog ici"
```

Les utilisateurs recevront automatiquement la notification de mise a jour dans l'app.

---

## Securite

- **Zero upload** — Tout est traite en local
- **Serveur local** — Flask sur `127.0.0.1` uniquement (pas accessible depuis le reseau)
- **Headers de securite** — `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`
- **Protection path traversal** — Verification `realpath` sur tous les chemins
- **Validation des entrees** — Types, bornes, formats sur toutes les routes
- **Thread safety** — `threading.Lock` sur les queues SSE, `fcntl` sur les fichiers JSON
- **Mots de passe** — Hash scrypt (Werkzeug), jamais stockes en clair
- **Auto-update securise** — Telechargement via API GitHub authentifiee, rollback si echec

---

## Conventions Git

- Branche principale : `main`
- Format commit : `[type] Description (vX.Y.Z)`
- Types : `feat`, `fix`, `refactor`, `security`, `perf`, `docs`
- Tags annotes pour chaque version
- Versioning semver dans `VERSION`

---

## Changelog

### v2.2.0 (2026-03-23)
- Systeme de profils utilisateurs avec mot de passe
- Systeme de presets complet (CRUD, categories, import/export)
- Build DMG distribuable (PyInstaller)
- Auto-update via GitHub Releases (telecharge + remplace + relance)
- Bouton "enlever preset" (reset sans supprimer les fichiers)
- Renommage de presets et categories
- Selection multiple + tout selectionner
- Audit securite (6 corrections : SSRF, migration mdp, cleanup)

### v2.1.1 (2026-03-10)
- Audit securite Phase 2 — 7 corrections

### v2.1.0 (2026-03-10)
- Resize modes (largeur, hauteur, pourcentage, fit, exact)
- Strip metadata, suffixe, lossless, estimation multi-niveaux

### v2.0.0 (2026-03-09)
- Refonte UI : Material Design 3, layout 2 colonnes
- Audit securite complet

### v1.0.0 (2026-03-09)
- Version initiale — compression PDF, JPEG, PNG, WebP
- Interface GUI native, drag & drop, preview, historique

---

## Licence

MIT — Libre d'utilisation et de modification.

---

<p align="center">
  <sub>Fait avec Python, Flask et pywebview — IPLN Design</sub>
</p>
