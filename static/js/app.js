/* ═══════════════════════════════════════════
   Compressor V2 — Frontend Logic (M3 Layout)
   ═══════════════════════════════════════════ */

// ── Constants ─────────────────────────────

const REDUCTION_THRESHOLD_GOOD = 30;
const REDUCTION_THRESHOLD_OK = 10;
const SIZE_MB = 1048576;
const SSE_MAX_RETRIES = 5;
const SSE_MAX_DELAY_MS = 10000;
const AUTO_CHECK_DELAY_MS = 2000;
const SNACKBAR_DURATION_MS = 4000;
const DROP_DEBOUNCE_MS = 500;

// ── State ─────────────────────────────────

const state = {
    files: [],        // {path, name, size, format, status, progress, result}
    compressing: false,
    eventSource: null,
    sseRetryCount: 0,
    viewMode: "grid",  // "grid" or "list"
    dialogOpen: false,
    justDropped: false,
    renderPending: false,
    _snackbarTimeout: null,
    _previousFocus: null,
    compressionStartTime: 0,
    filesCompletedCount: 0,
    lastOutputDir: null,
    // Presets
    presets: [],
    categories: [],
    activePresetId: null,
    // Format filter
    formatFilter: null,  // null = all, "jpeg", "png", "pdf", "webp"
    // Folder drop
    sourceRootDir: null,  // root dir when a folder is dropped
    formatPresetMap: {},  // {jpeg: "preset_id", png: "preset_id", ...} — per-format presets
};

// ── Init ──────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    setupDropZone();
    setupSideSheet();
    setupSections();
    setupResizeMode();
    setupLosslessToggle();
    setupViewToggle();
    setupFileListDelegation();
    setupModals();
    setupSettingsModal();
    setupUpdateModal();
    setupHistoryModal();
    setupCompareSlider();
    setupZoom();
    setupOpenFolderButton();
    setupPresets();
    setupQuickPresets();
    setupPresetsModal();
    setupFormatConfigModal();
    loadHistory();
    loadSettings().then(() => loadPresets());
    loadAppVersion();
});

// ── Drop Zone & File Selection ────────────

function setupDropZone() {
    const zone = document.getElementById("drop-zone");
    const fileContainer = document.getElementById("file-container");
    const chooseBtn = document.getElementById("choose-files-btn");
    const addBtn = document.getElementById("add-more-btn");
    const clearBtn = document.getElementById("clear-files-btn");

    // Drop global — fonctionne partout dans la fenetre (zone vide + liste de fichiers)
    document.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (!zone.classList.contains("hidden")) {
            zone.classList.add("drag-over");
        } else if (!fileContainer.classList.contains("hidden")) {
            fileContainer.classList.add("drag-over");
        }
    });
    document.addEventListener("dragleave", (e) => {
        if (!e.relatedTarget || e.relatedTarget === document.documentElement) {
            zone.classList.remove("drag-over");
            fileContainer.classList.remove("drag-over");
        }
    });
    document.addEventListener("drop", (e) => {
        e.preventDefault();
        zone.classList.remove("drag-over");
        fileContainer.classList.remove("drag-over");
        state.justDropped = true;
        setTimeout(() => { state.justDropped = false; }, DROP_DEBOUNCE_MS);
        handleDrop(e);
    });

    zone.addEventListener("click", (e) => {
        if (state.justDropped) return;
        if (e.target !== chooseBtn) chooseFiles();
    });
    chooseBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (state.justDropped) return;
        chooseFiles();
    });
    addBtn.addEventListener("click", chooseFiles);
    clearBtn.addEventListener("click", clearFiles);
}

async function handleDrop(e) {
    if (state.compressing) return;
    if (window.pywebview && window.pywebview.api) {
        try {
            const paths = await window.pywebview.api.get_drop_paths();
            if (paths && paths.length > 0) {
                addFiles(paths);
                return;
            }
        } catch (err) {
            console.warn("get_drop_paths failed:", err);
        }
    }
    chooseFiles();
}

async function chooseFiles() {
    if (state.compressing || state.dialogOpen) return;
    state.dialogOpen = true;
    try {
        if (window.pywebview && window.pywebview.api) {
            const paths = await window.pywebview.api.choose_files();
            if (paths && paths.length > 0) addFiles(paths);
        } else {
            console.warn("pywebview API not available");
        }
    } catch (e) {
        console.error("File dialog error:", e);
    } finally {
        state.dialogOpen = false;
    }
}

async function addFiles(paths) {
    const hasZip = paths.some(p => p.toLowerCase().endsWith(".zip"));
    if (hasZip) {
        try {
            const res = await fetch("/api/expand", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({ paths }),
            });
            const data = await res.json();
            if (data.files && data.files.length > 0) {
                paths = data.files;
            }
        } catch (e) {
            console.error("Expand ZIP error:", e);
        }
    }

    // Detecter le dossier racine commun (si les fichiers viennent d'un meme dossier)
    if (paths.length > 1 && !state.sourceRootDir) {
        const dirs = paths.map(p => {
            const parts = p.split("/");
            parts.pop(); // enlever le fichier
            return parts.join("/");
        });
        // Trouver le prefix commun
        let common = dirs[0] || "";
        for (const d of dirs) {
            while (common && !d.startsWith(common)) {
                common = common.substring(0, common.lastIndexOf("/"));
            }
        }
        if (common && dirs.some(d => d !== common)) {
            // Il y a des sous-dossiers → c'est un drop de dossier
            state.sourceRootDir = common;
        }
    }

    const newPaths = [];
    for (const path of paths) {
        if (state.files.find(f => f.path === path)) continue;
        const name = path.split("/").pop();
        const ext = name.split(".").pop().toLowerCase();
        const format = detectFormat(ext);
        if (format === "unknown") continue;

        // Chemin relatif par rapport au dossier source
        let relativePath = null;
        if (state.sourceRootDir && path.startsWith(state.sourceRootDir + "/")) {
            relativePath = path.substring(state.sourceRootDir.length + 1);
        }

        state.files.push({
            path, name, format, size: 0,
            status: "pending", progress: 0, result: null,
            relativePath,
        });
        newPaths.push(path);
    }
    renderFiles();
    updateCompressButton();
    updateSummary();

    // Fetch file sizes for quality estimation
    if (newPaths.length > 0) {
        try {
            const res = await fetch("/api/file-sizes", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({ paths: newPaths }),
            });
            const data = await res.json();
            if (data.sizes) {
                for (const f of state.files) {
                    if (data.sizes[f.path]) f.size = data.sizes[f.path];
                    if (data.dimensions && data.dimensions[f.path]) f.dimensions = data.dimensions[f.path];
                }
                renderFiles();
                updateQualityEstimate();
                updateLevelEstimates();
            }
        } catch (e) {
            console.warn("File sizes fetch error:", e);
        }
    }

    // Detecter multi-format → proposer config par format
    if (newPaths.length > 0) {
        const formats = new Set(state.files.map(f => f.format));
        if (formats.size >= 2 && state.presets.length > 0) {
            showFormatConfigModal(formats);
        }
    }
}

function removeFile(index) {
    if (index < 0 || index >= state.files.length) return;
    state.files.splice(index, 1);
    renderFiles();
    updateCompressButton();
    updateSummary();
    updateLevelEstimates();
}

function clearFiles() {
    state.files = [];
    state.formatFilter = null;
    state.formatPresetMap = {};
    state.sourceRootDir = null;
    state.lastOutputDir = null;
    hideOpenFolderButton();
    renderFiles();
    updateCompressButton();
    updateSummary();
    updateLevelEstimates();
}

// ── Open Folder Button ────────────────────

function setupOpenFolderButton() {
    document.getElementById("open-folder-btn").addEventListener("click", async () => {
        if (!state.lastOutputDir) return;
        try {
            await fetch("/api/open-folder", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({ path: state.lastOutputDir }),
            });
        } catch (e) {
            console.error("Open folder error:", e);
        }
    });
}

function showOpenFolderButton() {
    document.getElementById("open-folder-btn").classList.remove("hidden");
}

function hideOpenFolderButton() {
    document.getElementById("open-folder-btn").classList.add("hidden");
}

function detectFormat(ext) {
    const map = { pdf: "pdf", jpg: "jpeg", jpeg: "jpeg", png: "png", webp: "webp", zip: "zip" };
    return map[ext] || "unknown";
}

// ── Event Delegation (unified) ───────────

function setupFileListDelegation() {
    const handler = (e) => {
        // Remove button (works for both grid and list)
        const removeBtn = e.target.closest("[data-action='remove']");
        if (removeBtn) {
            const index = parseInt(removeBtn.dataset.index, 10);
            if (!isNaN(index)) removeFile(index);
            return;
        }
        // Preview button (after compression)
        const previewBtn = e.target.closest("[data-action='preview']");
        if (previewBtn) {
            const index = parseInt(previewBtn.dataset.index, 10);
            if (!isNaN(index)) showPreview(index);
            return;
        }
        // Fullscreen thumbnail (before compression)
        const fullscreenBtn = e.target.closest("[data-action='fullscreen']");
        if (fullscreenBtn) {
            const index = parseInt(fullscreenBtn.dataset.index, 10);
            if (!isNaN(index)) showFullscreen(index);
            return;
        }
    };
    document.getElementById("file-grid").addEventListener("click", handler);
    document.getElementById("file-list").addEventListener("click", handler);
}

// ── View Toggle ───────────────────────────

function setupViewToggle() {
    const toggle = document.getElementById("view-toggle");
    toggle.addEventListener("click", (e) => {
        const item = e.target.closest(".segmented-button__item");
        if (!item || item.classList.contains("active")) return;
        toggle.querySelectorAll(".segmented-button__item").forEach(b => b.classList.remove("active"));
        item.classList.add("active");
        state.viewMode = item.dataset.view;
        renderFiles();
    });
}

// ── File Rendering ────────────────────────

/** Coalesces multiple render calls into a single rAF. */
function scheduleRender() {
    if (state.renderPending) return;
    state.renderPending = true;
    requestAnimationFrame(() => {
        state.renderPending = false;
        renderFiles();
    });
}

function renderFiles() {
    const zone = document.getElementById("drop-zone");
    const container = document.getElementById("file-container");
    const content = document.getElementById("content");

    if (state.files.length === 0) {
        zone.classList.remove("hidden");
        container.classList.add("hidden");
        content.classList.remove("has-files");
        return;
    }

    zone.classList.add("hidden");
    container.classList.remove("hidden");
    content.classList.add("has-files");

    // Compter les formats presents
    const formatCounts = {};
    for (const f of state.files) {
        const fmt = (f.format || "unknown").toLowerCase();
        formatCounts[fmt] = (formatCounts[fmt] || 0) + 1;
    }

    // Generer les chips de filtre
    renderFormatFilters(formatCounts);

    // Filtrer les fichiers selon le filtre actif
    const filtered = state.formatFilter
        ? state.files.filter(f => (f.format || "").toLowerCase() === state.formatFilter)
        : state.files;

    // Valider que le filtre est encore pertinent
    if (state.formatFilter && !formatCounts[state.formatFilter]) {
        state.formatFilter = null;
    }

    const countText = state.formatFilter
        ? `${filtered.length} / ${state.files.length} fichier(s)`
        : `${state.files.length} fichier(s)`;
    const countEl = document.getElementById("file-count");
    if (state.sourceRootDir) {
        const folderName = state.sourceRootDir.split("/").pop();
        countEl.innerHTML = `${countText} <span class="source-folder-badge">${escapeHtml(folderName)} → ${escapeHtml(folderName)}-export</span>`;
    } else {
        countEl.textContent = countText;
    }

    const gridEl = document.getElementById("file-grid");
    const listEl = document.getElementById("file-list");

    if (state.viewMode === "grid") {
        gridEl.classList.remove("hidden");
        listEl.classList.add("hidden");
        renderGrid(gridEl, filtered);
    } else {
        gridEl.classList.add("hidden");
        listEl.classList.remove("hidden");
        renderList(listEl, filtered);
    }
}


function renderFormatFilters(formatCounts) {
    const container = document.getElementById("format-filters");
    const formats = Object.keys(formatCounts).sort();

    // Ne pas afficher si un seul format
    if (formats.length <= 1) {
        container.innerHTML = "";
        return;
    }

    container.innerHTML = formats.map(fmt => {
        const active = state.formatFilter === fmt ? "active" : "";
        const label = fmt.toUpperCase();
        return `<button class="format-chip ${active}" data-format="${fmt}">${label} <span class="format-chip__count">${formatCounts[fmt]}</span></button>`;
    }).join("");

    container.querySelectorAll(".format-chip").forEach(chip => {
        chip.addEventListener("click", () => {
            const fmt = chip.dataset.format;
            state.formatFilter = (state.formatFilter === fmt) ? null : fmt;
            renderFiles();
        });
    });
}

// ── Format Config Modal ─────────────────

function setupFormatConfigModal() {
    document.getElementById("format-config-skip").addEventListener("click", () => {
        state.formatPresetMap = {};
        closeModal("format-config-modal");
    });

    document.getElementById("format-config-apply").addEventListener("click", () => {
        // Lire les selections
        const selects = document.querySelectorAll("#format-config-list .format-config-row__select");
        state.formatPresetMap = {};
        selects.forEach(sel => {
            const fmt = sel.dataset.format;
            const presetId = sel.value;
            if (presetId) {
                state.formatPresetMap[fmt] = presetId;
            }
        });
        closeModal("format-config-modal");

        // Feedback
        const count = Object.keys(state.formatPresetMap).length;
        if (count > 0) {
            showSnackbar(`${count} format(s) configure(s)`);
        }
    });
}

function showFormatConfigModal(formats) {
    const list = document.getElementById("format-config-list");
    const formatArr = Array.from(formats).sort();

    // Compter les fichiers par format
    const counts = {};
    for (const f of state.files) {
        counts[f.format] = (counts[f.format] || 0) + 1;
    }

    // Construire les options de presets
    const presetOptions = state.presets.map(p =>
        `<option value="${p.id}">${escapeHtml(p.name)}${p.category ? ` (${escapeHtml(p.category)})` : ""}</option>`
    ).join("");

    list.innerHTML = formatArr.map(fmt => {
        const currentPresetId = state.formatPresetMap[fmt] || "";
        return `
            <div class="format-config-row">
                <span class="format-config-row__badge ${fmt}">${fmt.toUpperCase()}</span>
                <span class="format-config-row__count">${counts[fmt] || 0} fichier(s)</span>
                <select class="field__select format-config-row__select" data-format="${fmt}">
                    <option value="">Reglages actuels</option>
                    ${presetOptions}
                </select>
            </div>
        `;
    }).join("");

    // Pre-selectionner si deja configure
    list.querySelectorAll(".format-config-row__select").forEach(sel => {
        const fmt = sel.dataset.format;
        if (state.formatPresetMap[fmt]) {
            sel.value = state.formatPresetMap[fmt];
        }
    });

    openModal("format-config-modal");
}


// ── Shared rendering helpers ─────────────

function getStatusClass(status) {
    if (status === "compressing") return "compressing";
    if (status === "done") return "done";
    if (status === "error") return "error";
    return "";
}

function buildProgressBarHtml(prefix, index, progress) {
    return `<div class="${prefix}__progress"><div class="${prefix}__progress-fill" style="width:${(progress * 100)}%" id="fprog-${index}"></div></div>`;
}

function buildRemoveBtn(index, extraClass) {
    return `<button class="${extraClass}" data-action="remove" data-index="${index}" ${state.compressing ? 'disabled' : ''} aria-label="Supprimer">&times;</button>`;
}

function buildPreviewBtn(index) {
    return `<button class="preview-btn" data-action="preview" data-index="${index}">Apercu</button>`;
}

// ── Grid Rendering ────────────────────────

function renderGrid(container, files) {
    const filesToRender = files || state.files;
    container.innerHTML = filesToRender.map((f) => {
        const i = state.files.indexOf(f);
        const statusClass = getStatusClass(f.status);
        const escapedName = escapeHtml(f.name);
        const escapedPath = escapeHtml(f.path);

        let progressBar = "";
        if (f.status === "compressing") {
            progressBar = buildProgressBarHtml("file-card", i, f.progress);
        }

        let footerContent = "";
        if (f.result) {
            if (f.subResults && f.subResults.length >= 3) {
                // PDF multi-level: show 3 badges
                const badges = f.subResults.map(sr => {
                    const rClass = reductionClass(sr.result.reduction_pct);
                    const label = sr.level.charAt(0).toUpperCase() + sr.level.slice(1);
                    return `<span class="multi-badge ${rClass}">${label}: -${sr.result.reduction_pct}%</span>`;
                }).join("");
                footerContent = `<div class="file-card__multi-results">${badges}</div>`;
            } else {
                const rClass = reductionClass(f.result.reduction_pct);
                footerContent = `
                    <span class="file-card__result ${rClass}">-${f.result.reduction_pct}%</span>
                    ${buildPreviewBtn(i)}`;
            }
        }

        const thumbUrl = `/api/thumbnail?path=${encodeURIComponent(f.path)}&size=512`;
        const dimText = f._displayDimensions
            ? `${f._displayDimensions} px`
            : f.dimensions
                ? (f.dimensions.pages ? `${f.dimensions.w}\u00d7${f.dimensions.h} pt \u00b7 ${f.dimensions.pages} p.` : `${f.dimensions.w}\u00d7${f.dimensions.h} px`)
                : '';

        // Size badge: dual badge when estimate available (before compression)
        let sizeBadgeHtml;
        if (f.result) {
            // After compression: show actual result
            sizeBadgeHtml = `<span class="file-card__size">${humanSize(f.result.original_size)} \u2192 ${humanSize(f.result.compressed_size)}</span>`;
        } else if (f._estimatedSize != null && f._estimatedSize > 0) {
            // Before compression: dual badge original → estimated
            const pct = Math.round((1 - f._estimatedSize / f.size) * 100);
            const estClass = pct > REDUCTION_THRESHOLD_GOOD ? "estimate-good" : (pct > REDUCTION_THRESHOLD_OK ? "estimate-ok" : "estimate-neutral");
            sizeBadgeHtml = `<span class="file-card__size">${humanSize(f.size)}</span><span class="file-card__arrow">\u2192</span><span class="file-card__size file-card__estimate ${estClass}">~${humanSize(f._estimatedSize)}</span>`;
        } else {
            sizeBadgeHtml = `<span class="file-card__size">${humanSize(f.size)}</span>`;
        }

        // Expand icon (M3 open_in_full — two arrows pointing outward)
        const expandSvg = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 3v6h-2V6.41l-4.29 4.3-1.42-1.42L17.59 5H15V3h6zM3 21v-6h2v2.59l4.29-4.3 1.42 1.42L6.41 19H9v2H3z"/></svg>`;
        const expandAction = f.result ? "preview" : "fullscreen";
        const expandOverlay = `<div class="file-card__thumb-overlay" data-action="${expandAction}" data-index="${i}">${expandSvg}</div>`;

        return `<div class="file-card ${statusClass}" title="${escapedPath}">
            ${progressBar}
            <div class="file-card__header">
                <div class="file-card__header-left">
                    <span class="format-badge ${f.format}">${f.format.toUpperCase()}</span>
                    ${dimText ? `<span class="file-card__dim">${dimText}</span>` : ''}
                </div>
                ${buildRemoveBtn(i, "file-card__remove")}
            </div>
            <div class="file-card__thumb">
                <img src="${thumbUrl}" alt="" loading="lazy" onerror="this.parentElement.classList.add('no-thumb')">
                ${expandOverlay}
            </div>
            <div class="file-card__body">
                ${f.relativePath && f.relativePath.includes("/") ? `<span class="file-card__folder">${escapeHtml(f.relativePath.substring(0, f.relativePath.lastIndexOf("/")))}</span>` : ""}
                <span class="file-card__name">${escapedName}</span>
                <span class="file-card__meta">${sizeBadgeHtml}</span>
            </div>
            ${footerContent ? `<div class="file-card__footer">${footerContent}</div>` : ''}
        </div>`;
    }).join("");
}

// ── List Rendering ────────────────────────

function renderList(container, files) {
    const filesToRender = files || state.files;
    container.innerHTML = filesToRender.map((f) => {
        const i = state.files.indexOf(f);
        const statusClass = getStatusClass(f.status);
        const escapedName = escapeHtml(f.name);
        const escapedPath = escapeHtml(f.path);

        let sizeInfo = "";
        let reduction = "";
        let previewBtn = "";
        if (f.result) {
            sizeInfo = `<span class="file-row__sizes">${humanSize(f.result.original_size)} \u2192 ${humanSize(f.result.compressed_size)}</span>`;
            if (f.subResults && f.subResults.length >= 3) {
                const badges = f.subResults.map(sr => {
                    const rClass = reductionClass(sr.result.reduction_pct);
                    const label = sr.level.charAt(0).toUpperCase() + sr.level.slice(1);
                    return `<span class="multi-badge ${rClass}">${label}: -${sr.result.reduction_pct}%</span>`;
                }).join("");
                reduction = `<div class="file-card__multi-results">${badges}</div>`;
            } else {
                const rClass = reductionClass(f.result.reduction_pct);
                reduction = `<span class="file-row__result ${rClass}">-${f.result.reduction_pct}%</span>`;
                previewBtn = buildPreviewBtn(i);
            }
        }

        let progressBar = "";
        if (f.status === "compressing") {
            progressBar = buildProgressBarHtml("file-row", i, f.progress);
        }

        const thumbUrl = `/api/thumbnail?path=${encodeURIComponent(f.path)}&size=80`;
        const dimInfo = f._displayDimensions
            ? `${f._displayDimensions} px`
            : f.dimensions
                ? (f.dimensions.pages ? `${f.dimensions.w}\u00d7${f.dimensions.h} pt \u00b7 ${f.dimensions.pages} p.` : `${f.dimensions.w}\u00d7${f.dimensions.h} px`)
                : '';
        if (!f.result) {
            // Dual badge when estimate available
            let sizeBadgeHtml;
            if (f._estimatedSize != null && f._estimatedSize > 0) {
                const pct = Math.round((1 - f._estimatedSize / f.size) * 100);
                const estClass = pct > REDUCTION_THRESHOLD_GOOD ? "estimate-good" : (pct > REDUCTION_THRESHOLD_OK ? "estimate-ok" : "estimate-neutral");
                sizeBadgeHtml = `<span class="file-card__size">${humanSize(f.size)}</span><span class="file-card__arrow">\u2192</span><span class="file-card__size file-card__estimate ${estClass}">~${humanSize(f._estimatedSize)}</span>`;
            } else {
                sizeBadgeHtml = `<span class="file-card__size">${humanSize(f.size)}</span>`;
            }
            sizeInfo = `<span class="file-row__meta">${sizeBadgeHtml}</span>`;
        }

        return `<li class="file-row ${statusClass}">
            <img class="file-row__thumb" src="${thumbUrl}" alt="" loading="lazy" onerror="this.style.display='none'">
            <span class="format-badge ${f.format}">${f.format.toUpperCase()}</span>
            ${dimInfo ? `<span class="file-row__dim">${dimInfo}</span>` : ''}
            <span class="file-row__name" title="${escapedPath}">${escapedName}</span>
            ${sizeInfo}${reduction}
            ${progressBar}
            ${previewBtn}
            ${buildRemoveBtn(i, "file-row__remove")}
        </li>`;
    }).join("");
}

function reductionClass(pct) {
    if (pct > REDUCTION_THRESHOLD_GOOD) return "reduction-good";
    if (pct > REDUCTION_THRESHOLD_OK) return "reduction-ok";
    return "reduction-poor";
}

function resetResultsOnSettingsChange() {
    // Quand un paramètre change, on efface les résultats précédents
    // pour permettre la recompression avec les nouveaux paramètres
    let changed = false;
    state.files.forEach(f => {
        if (f.result) {
            f.result = null;
            f.subResults = null;
            f.status = "pending";
            f._estimatedSize = null;
            f._displayDimensions = null;
            changed = true;
        }
    });
    if (changed) {
        renderFiles();
        updateCompressButton();
        updateSummary();
    }
}

function updateCompressButton() {
    const btn = document.getElementById("compress-btn");
    btn.disabled = state.files.length === 0 || state.compressing;
}

function updateSummary() {
    const el = document.getElementById("summary-text");
    if (state.files.length === 0) {
        el.textContent = "Aucun fichier";
        return;
    }

    const doneFiles = state.files.filter(f => f.result);
    if (doneFiles.length > 0) {
        const totalSaved = doneFiles.reduce((sum, f) => sum + (f.result.original_size - f.result.compressed_size), 0);
        el.textContent = `${state.files.length} fichier(s) \u2014 ${formatSavedSize(totalSaved)} economises`;
    } else {
        el.textContent = `${state.files.length} fichier(s) selectionne(s)`;
    }
    updatePreCompressionSummary();
}

// ── Side Sheet ────────────────────────────

function setupSideSheet() {
    // Level buttons
    document.getElementById("level-buttons").addEventListener("click", (e) => {
        const item = e.target.closest(".segmented-button__item");
        if (!item) return;
        document.querySelectorAll("#level-buttons .segmented-button__item").forEach(b => b.classList.remove("active"));
        item.classList.add("active");
        const isCustom = item.dataset.level === "custom";
        const isPdf = document.getElementById("output-format").value === "pdf";
        document.getElementById("custom-quality").classList.toggle("hidden", !(isCustom && !isPdf));
        document.getElementById("custom-pdf").classList.toggle("hidden", !(isCustom && isPdf));
        resetResultsOnSettingsChange();
        updateLevelEstimates();
        updatePreCompressionSummary();
    });

    // Quality slider
    const slider = document.getElementById("quality-slider");
    const valSpan = document.getElementById("quality-value");
    slider.addEventListener("input", () => {
        valSpan.textContent = slider.value;
        updateQualityEstimate();
        resetResultsOnSettingsChange();
        updateLevelEstimates();
        updatePreCompressionSummary();
    });

    // Browse folder
    document.getElementById("browse-btn").addEventListener("click", async () => {
        try {
            if (window.pywebview && window.pywebview.api) {
                const folder = await window.pywebview.api.choose_folder();
                if (folder) document.getElementById("output-dir").value = folder;
            }
        } catch (e) {
            console.error("Folder dialog error:", e);
        }
    });

    // Compress button
    document.getElementById("compress-btn").addEventListener("click", startCompression);
}

// ── Collapsible Sections ──────────────────

function setupSections() {
    document.querySelectorAll(".side-sheet__section-header").forEach(header => {
        header.addEventListener("click", () => {
            const section = header.closest(".side-sheet__section");
            section.classList.toggle("collapsed");
        });
    });
}

// ── Resize Mode ───────────────────────

function setupResizeMode() {
    const select = document.getElementById("resize-mode");
    const percentField = document.getElementById("resize-percent-field");
    const widthField = document.getElementById("resize-width-field");
    const heightField = document.getElementById("resize-height-field");
    const fitField = document.getElementById("resize-fit-field");
    const percentSlider = document.getElementById("resize-percent");
    const percentValue = document.getElementById("resize-percent-value");

    function updateResizeFields() {
        const mode = select.value;
        percentField.classList.toggle("hidden", mode !== "percent");
        widthField.classList.toggle("hidden", mode !== "width");
        heightField.classList.toggle("hidden", mode !== "height");
        fitField.classList.toggle("hidden", mode !== "fit" && mode !== "exact");
    }

    select.addEventListener("change", () => {
        updateResizeFields();
        resetResultsOnSettingsChange();
        updateLevelEstimates();
        updatePreCompressionSummary();
    });
    percentSlider.addEventListener("input", () => {
        percentValue.textContent = `${percentSlider.value}%`;
        resetResultsOnSettingsChange();
        updateLevelEstimates();
        updatePreCompressionSummary();
    });

    // Listen to resize input fields for live estimate updates
    ["resize-width", "resize-height", "resize-fit-w", "resize-fit-h"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("input", () => {
            resetResultsOnSettingsChange();
            updateLevelEstimates();
            updatePreCompressionSummary();
        });
    });

    // Preset chips
    document.querySelectorAll(".preset-chip").forEach(chip => {
        chip.addEventListener("click", () => {
            const input = document.getElementById(chip.dataset.target);
            if (input) {
                input.value = chip.dataset.value;
                input.dispatchEvent(new Event("input"));
            }
        });
    });

    updateResizeFields();
}

// ── Lossless Toggle ───────────────────

function setupLosslessToggle() {
    const formatSelect = document.getElementById("output-format");
    const losslessField = document.getElementById("lossless-field");
    const losslessToggle = document.getElementById("lossless-toggle");
    const qualitySlider = document.getElementById("quality-slider");
    const qualityValue = document.getElementById("quality-value");
    const levelButtons = document.getElementById("level-buttons");

    function updateLosslessVisibility() {
        const fmt = formatSelect.value;
        // Show lossless toggle for WebP and PNG (or empty = depends on input files)
        const showLossless = fmt === "webp" || fmt === "png";
        losslessField.classList.toggle("hidden", !showLossless);
        if (!showLossless) {
            losslessToggle.checked = false;
        }
        updateQualityDisabled();
    }

    function updateQualityDisabled() {
        const isLossless = losslessToggle.checked;
        qualitySlider.disabled = isLossless;
        qualityValue.style.opacity = isLossless ? "0.38" : "1";
        levelButtons.querySelectorAll(".segmented-button__item").forEach(btn => {
            if (btn.dataset.level === "custom") return;
            btn.disabled = isLossless;
            btn.style.opacity = isLossless ? "0.38" : "1";
        });
    }

    formatSelect.addEventListener("change", () => {
        updateLosslessVisibility();
        // Switch custom panel if Custom is active
        const activeBtn = document.querySelector("#level-buttons .segmented-button__item.active");
        const isCustom = activeBtn && activeBtn.dataset.level === "custom";
        const isPdf = formatSelect.value === "pdf";
        document.getElementById("custom-quality").classList.toggle("hidden", !(isCustom && !isPdf));
        document.getElementById("custom-pdf").classList.toggle("hidden", !(isCustom && isPdf));
        resetResultsOnSettingsChange();
        updateLevelEstimates();
        updatePreCompressionSummary();
    });
    losslessToggle.addEventListener("change", () => {
        updateQualityDisabled();
        resetResultsOnSettingsChange();
        updateLevelEstimates();
        updatePreCompressionSummary();
    });
    updateLosslessVisibility();

    // target-size, strip-metadata : reset on change
    document.getElementById("target-size").addEventListener("input", () => {
        resetResultsOnSettingsChange();
        updateLevelEstimates();
        updatePreCompressionSummary();
    });
    document.getElementById("strip-metadata").addEventListener("change", () => {
        resetResultsOnSettingsChange();
        updateLevelEstimates();
        updatePreCompressionSummary();
    });
}

// ── Quality Estimation ────────────────

function updateQualityEstimate() {
    const estimateEl = document.getElementById("quality-estimate");
    if (!estimateEl) return;

    if (state.files.length === 0) {
        estimateEl.textContent = "";
        return;
    }

    // Utiliser les données API quand disponibles
    if (_lastEstimates && _lastEstimates.custom != null) {
        estimateEl.textContent = `~${humanSize(_lastEstimates.custom)} estimes`;
    } else {
        estimateEl.textContent = "...";
    }

    // Relancer l'estimation API (debounced) pour mettre à jour
    updateLevelEstimates();
}

// ── Level Estimates (WP3) ─────────────────

// ── Estimation temps réel (server-side sample compression) ──

let _estimateTimer = null;
let _estimateAbort = null;
let _lastEstimates = null;  // cache des dernières estimations

function updateLevelEstimates() {
    if (_estimateTimer) clearTimeout(_estimateTimer);
    _estimateTimer = setTimeout(_fetchEstimates, 300);
}

async function _fetchEstimates() {
    // Masquer les labels globaux sous High/Medium/Low (on garde juste les per-file)
    const container = document.getElementById("level-estimates");
    if (container) container.classList.add("hidden");

    const paths = state.files.map(f => f.path).filter(Boolean);
    if (paths.length === 0) {
        _lastEstimates = null;
        return;
    }

    // Annuler la requête précédente si encore en cours
    if (_estimateAbort) _estimateAbort.abort();
    _estimateAbort = new AbortController();

    // Construire les settings pour l'estimation
    const settings = _gatherEstimateSettings();

    try {
        const res = await fetch("/api/estimate", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({ paths, settings }),
            signal: _estimateAbort.signal,
        });
        const data = await res.json();

        if (data.totals) {
            _lastEstimates = data.totals;
            ["high", "medium", "low", "custom"].forEach(level => {
                const el = container.querySelector(`[data-est="${level}"]`);
                if (el) {
                    const val = data.totals[level] || 0;
                    el.textContent = val > 0 ? `~${humanSize(val)}` : "—";
                }
            });
        }

        // Store per-file estimates & re-render cards
        if (data.estimates) {
            const activeBtn = document.querySelector("#level-buttons .segmented-button__item.active");
            const level = activeBtn ? activeBtn.dataset.level : "medium";
            let changed = false;
            state.files.forEach(f => {
                const est = data.estimates[f.path];
                if (est && est[level]) {
                    const newVal = est[level].estimated_size;
                    if (f._estimatedSize !== newVal) {
                        f._estimatedSize = newVal;
                        changed = true;
                    }
                    // Mettre à jour les dimensions affichées si resize actif
                    const fw = est[level].final_w;
                    const fh = est[level].final_h;
                    if (fw && fh && f.dimensions) {
                        const newDim = `${fw}×${fh}`;
                        if (f._displayDimensions !== newDim) {
                            f._displayDimensions = newDim;
                            changed = true;
                        }
                    } else if (f._displayDimensions) {
                        f._displayDimensions = null;
                        changed = true;
                    }
                } else if (f._estimatedSize != null) {
                    f._estimatedSize = null;
                    changed = true;
                }
            });
            if (changed) renderFiles();
        }
    } catch (e) {
        if (e.name !== "AbortError") {
            console.warn("Estimate fetch error:", e);
        }
    }

    updatePreCompressionSummary();
}

function _gatherEstimateSettings() {
    const resizeMode = document.getElementById("resize-mode").value;
    let resizeWidth = null, resizeHeight = null;
    if (resizeMode === "width") {
        resizeWidth = parseInt(document.getElementById("resize-width").value) || null;
    } else if (resizeMode === "height") {
        resizeHeight = parseInt(document.getElementById("resize-height").value) || null;
    } else if (resizeMode === "fit" || resizeMode === "exact") {
        resizeWidth = parseInt(document.getElementById("resize-fit-w").value) || null;
        resizeHeight = parseInt(document.getElementById("resize-fit-h").value) || null;
    }

    const activeBtn = document.querySelector("#level-buttons .segmented-button__item.active");
    const activeLevel = activeBtn ? activeBtn.dataset.level : "medium";

    return {
        output_format: document.getElementById("output-format").value || null,
        resize_mode: resizeMode,
        resize_width: resizeWidth,
        resize_height: resizeHeight,
        resize_percent: parseInt(document.getElementById("resize-percent").value) || 100,
        custom_quality: parseInt(document.getElementById("quality-slider").value) || 70,
        pdf_custom_dpi: parseInt(document.getElementById("pdf-custom-dpi").value) || 150,
        pdf_custom_quality: parseInt(document.getElementById("pdf-custom-quality").value) || 70,
        strip_metadata: document.getElementById("strip-metadata").checked,
        lossless: document.getElementById("lossless-toggle").checked,
        active_level: activeLevel,
        target_size_kb: parseInt(document.getElementById("target-size").value) || null,
    };
}

// ── Pre-Compression Summary (WP6) ─────────

function updatePreCompressionSummary() {
    const container = document.getElementById("summary-estimate");
    const sizeEl = document.getElementById("summary-est-size");
    const timeEl = document.getElementById("summary-est-time");
    if (!container || !sizeEl || !timeEl) return;

    const totalBytes = state.files.reduce((sum, f) => sum + (f.size || 0), 0);

    if (state.files.length === 0 || totalBytes === 0 || state.compressing) {
        container.classList.add("hidden");
        return;
    }

    container.classList.remove("hidden");

    // Estimated size from server-side sample compression
    const activeBtn = document.querySelector("#level-buttons .segmented-button__item.active");
    const level = activeBtn ? activeBtn.dataset.level : "medium";

    let estimatedBytes;
    if (_lastEstimates && _lastEstimates[level] != null) {
        estimatedBytes = _lastEstimates[level];
    } else {
        // Fallback si pas encore de données
        estimatedBytes = totalBytes * 0.5;
    }
    sizeEl.textContent = `~${humanSize(estimatedBytes)} estimes`;

    // Estimated time: ~1 MB/s for images, ~0.5 MB/s for PDFs
    const hasPdf = state.files.some(f => f.format === "pdf");
    const speed = hasPdf ? 0.5 : 1;  // MB/s
    const estimatedTime = Math.ceil((totalBytes / (1024 * 1024)) / speed);
    timeEl.textContent = estimatedTime > 0 ? `~${estimatedTime}s` : "<1s";
}

// ── Settings Gather ───────────────────────

function gatherSettings() {
    const activeBtn = document.querySelector("#level-buttons .segmented-button__item.active");
    const resizeMode = document.getElementById("resize-mode").value;

    // Resize values selon le mode (convertis en int)
    let resizeWidth = null, resizeHeight = null;
    if (resizeMode === "width") {
        resizeWidth = parseInt(document.getElementById("resize-width").value) || null;
    } else if (resizeMode === "height") {
        resizeHeight = parseInt(document.getElementById("resize-height").value) || null;
    } else if (resizeMode === "fit" || resizeMode === "exact") {
        resizeWidth = parseInt(document.getElementById("resize-fit-w").value) || null;
        resizeHeight = parseInt(document.getElementById("resize-fit-h").value) || null;
    }

    const targetSizeRaw = document.getElementById("target-size").value;

    const outputFormat = document.getElementById("output-format").value || null;
    return {
        level: activeBtn ? activeBtn.dataset.level : "medium",
        custom_quality: parseInt(document.getElementById("quality-slider").value) || 70,
        output_format: outputFormat,
        target_size_kb: targetSizeRaw ? parseInt(targetSizeRaw) : null,
        output_dir: document.getElementById("output-dir").value || null,
        // Phase 2
        resize_mode: resizeMode,
        resize_width: resizeWidth,
        resize_height: resizeHeight,
        resize_percent: parseInt(document.getElementById("resize-percent").value) || 50,
        strip_metadata: document.getElementById("strip-metadata").checked,
        suffix: document.getElementById("output-suffix").value,
        keep_date: document.getElementById("keep-date").checked,
        lossless: document.getElementById("lossless-toggle").checked,
        // PDF custom
        pdf_custom_dpi: parseInt(document.getElementById("pdf-custom-dpi").value) || 150,
        pdf_custom_quality: parseInt(document.getElementById("pdf-custom-quality").value) || 70,
    };
}

function applySettingsToUI(s) {
    // Sidebar compression settings
    if (s.level) {
        document.querySelectorAll("#level-buttons .segmented-button__item").forEach(b => {
            b.classList.toggle("active", b.dataset.level === s.level);
        });
        document.getElementById("custom-quality").classList.toggle("hidden", s.level !== "custom");
    }
    if (s.custom_quality) document.getElementById("quality-slider").value = s.custom_quality;
    if (s.output_format !== undefined) document.getElementById("output-format").value = s.output_format || "";
    if (s.target_size_kb) {
        document.getElementById("target-size").value = s.target_size_kb;
    } else if (s.target_size_kb === null) {
        document.getElementById("target-size").value = "";
    }
    if (s.output_dir) document.getElementById("output-dir").value = s.output_dir;
    document.getElementById("quality-value").textContent = document.getElementById("quality-slider").value;

    // Resize
    if (s.resize_mode) {
        document.getElementById("resize-mode").value = s.resize_mode;
        document.getElementById("resize-mode").dispatchEvent(new Event("change"));
    }
    if (s.resize_percent) {
        document.getElementById("resize-percent").value = s.resize_percent;
        document.getElementById("resize-percent-value").textContent = `${s.resize_percent}%`;
    }
    if (s.resize_width) document.getElementById("resize-width").value = s.resize_width;
    if (s.resize_height) document.getElementById("resize-height").value = s.resize_height;
    if (s.resize_mode === "fit" || s.resize_mode === "exact") {
        if (s.resize_width) document.getElementById("resize-fit-w").value = s.resize_width;
        if (s.resize_height) document.getElementById("resize-fit-h").value = s.resize_height;
    }

    // Toggles
    document.getElementById("strip-metadata").checked = !!s.strip_metadata;
    if (s.suffix !== undefined && s.suffix !== null) {
        document.getElementById("output-suffix").value = s.suffix;
    }
    document.getElementById("keep-date").checked = !!s.keep_date;
    document.getElementById("lossless-toggle").checked = !!s.lossless;
    if (s.lossless) {
        document.getElementById("lossless-toggle").dispatchEvent(new Event("change"));
    }

    // PDF custom
    if (s.pdf_custom_dpi) document.getElementById("pdf-custom-dpi").value = s.pdf_custom_dpi;
    if (s.pdf_custom_quality) document.getElementById("pdf-custom-quality").value = s.pdf_custom_quality;

    // Update lossless visibility based on format
    document.getElementById("output-format").dispatchEvent(new Event("change"));
}

async function loadSettings() {
    try {
        const res = await fetch("/api/settings");
        const s = await res.json();

        if (s.has_compressed) {
            // Previous session ended with a compression → reset fields to defaults
            resetFieldsToDefaults();
            // Clear the flag
            fetch("/api/settings", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({...s, has_compressed: false,
                    level: "medium", custom_quality: 70, output_format: null,
                    target_size_kb: null, resize_mode: "none", resize_width: null,
                    resize_height: null, resize_percent: 100, strip_metadata: false,
                    suffix: "_compressed", keep_date: false, lossless: false,
                }),
            });
        } else {
            applySettingsToUI(s);
        }

        // App settings (modal) — toujours restaurer
        const notifToggle = document.getElementById("toggle-notifications");
        const updateToggle = document.getElementById("toggle-auto-updates");
        if (notifToggle) notifToggle.checked = s.notifications_enabled !== false;
        if (updateToggle) updateToggle.checked = s.auto_check_updates !== false;
        if (s.default_output_dir) {
            document.getElementById("default-output-dir").value = s.default_output_dir;
        }

        // Quick presets
        loadQuickPresets(s);

        // Auto-check updates
        if (s.auto_check_updates !== false) {
            setTimeout(() => checkForUpdates(true), AUTO_CHECK_DELAY_MS);
        }
    } catch (e) {
        console.error("Load settings error:", e);
    }
}

function resetFieldsToDefaults() {
    // Quality
    document.querySelectorAll("#level-buttons .segmented-button__item").forEach(b => {
        b.classList.toggle("active", b.dataset.level === "medium");
    });
    document.getElementById("custom-quality").classList.add("hidden");
    document.getElementById("quality-slider").value = 70;
    document.getElementById("quality-value").textContent = "70";

    // Format
    document.getElementById("output-format").value = "";
    document.getElementById("output-format").dispatchEvent(new Event("change"));

    // Resize
    document.getElementById("resize-mode").value = "none";
    document.getElementById("resize-mode").dispatchEvent(new Event("change"));
    document.getElementById("resize-width").value = "";
    document.getElementById("resize-height").value = "";
    document.getElementById("resize-fit-w").value = "";
    document.getElementById("resize-fit-h").value = "";
    document.getElementById("resize-percent").value = 50;
    document.getElementById("resize-percent-value").textContent = "50%";

    // Options
    document.getElementById("strip-metadata").checked = false;
    document.getElementById("target-size").value = "";
    document.getElementById("lossless-toggle").checked = false;

    // Export
    document.getElementById("output-suffix").value = "";
    document.getElementById("keep-date").checked = false;
    document.getElementById("output-dir").value = "";

    // PDF custom
    document.getElementById("pdf-custom-dpi").value = 150;
    document.getElementById("pdf-custom-quality").value = 70;
}

// ── Compression ───────────────────────────

async function startCompression() {
    if (state.compressing || state.files.length === 0) return;
    state.compressing = true;
    updateCompressButton();

    const settings = gatherSettings();
    fetch("/api/settings", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(settings),
    });

    state.files.forEach(f => { f.status = "pending"; f.progress = 0; f.result = null; f.subResults = null; f._estimatedSize = null; });
    renderFiles();

    const totalItems = state.files.length;
    const gp = document.getElementById("global-progress");
    gp.classList.remove("hidden");
    document.getElementById("progress-fill").style.width = "0%";
    document.getElementById("progress-text").textContent = `0 / ${totalItems}`;

    state.compressionStartTime = Date.now();
    state.filesCompletedCount = 0;
    state.sseRetryCount = 0;
    connectSSE();

    const filePaths = state.files.map(f => f.path);
    const compressPayload = { files: filePaths, settings };
    if (state.sourceRootDir) {
        compressPayload.source_root_dir = state.sourceRootDir;
    }
    if (Object.keys(state.formatPresetMap).length > 0) {
        // Resoudre les preset IDs en settings
        const formatSettings = {};
        for (const [fmt, presetId] of Object.entries(state.formatPresetMap)) {
            const preset = state.presets.find(p => p.id === presetId);
            if (preset) {
                formatSettings[fmt] = preset.settings;
            }
        }
        if (Object.keys(formatSettings).length > 0) {
            compressPayload.format_settings = formatSettings;
        }
    }
    try {
        const res = await fetch("/api/compress", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(compressPayload),
        });
        if (!res.ok) {
            const err = await res.json();
            showSnackbar(err.error || "Erreur inconnue", true);
            state.compressing = false;
            updateCompressButton();
        }
    } catch (e) {
        console.error("Compress request error:", e);
        showSnackbar("Erreur de connexion au serveur", true);
        state.compressing = false;
        updateCompressButton();
    }
}

// ── SSE Progress ──────────────────────────

function connectSSE() {
    if (state.eventSource) {
        state.eventSource.close();
        state.eventSource = null;
    }

    const es = new EventSource("/api/progress");
    state.eventSource = es;

    es.onmessage = (event) => {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (e) {
            console.warn("SSE parse error:", e);
            return;
        }

        if (!data || typeof data.type !== "string") return;

        switch (data.type) {
            case "file_start": {
                // PDF multi-level uses parent_index for the file, index for global progress
                const fileIdx = data.parent_index !== undefined ? data.parent_index : data.index;
                if (state.files[fileIdx]) {
                    state.files[fileIdx].status = "compressing";
                    state.files[fileIdx].progress = 0;
                }
                const globalIdx = data.index;
                document.getElementById("progress-fill").style.width =
                    `${(globalIdx / data.total * 100)}%`;
                {
                    const completed = state.filesCompletedCount;
                    const remaining = data.total - completed;
                    let timeStr = "";
                    if (completed > 0) {
                        const elapsed = (Date.now() - state.compressionStartTime) / 1000;
                        const avgPerFile = elapsed / completed;
                        const eta = Math.ceil(avgPerFile * remaining);
                        timeStr = ` \u2014 ~${eta}s`;
                    }
                    document.getElementById("progress-text").textContent =
                        `${globalIdx + 1} / ${data.total}${timeStr}`;
                }
                scheduleRender();
                break;
            }

            case "page_progress": {
                const fileIdx = data.parent_index !== undefined ? data.parent_index : data.file_index;
                if (state.files[fileIdx]) {
                    state.files[fileIdx].progress = data.page / data.total_pages;
                    const bar = document.getElementById(`fprog-${fileIdx}`);
                    if (bar) bar.style.width = `${(data.page / data.total_pages * 100)}%`;
                }
                break;
            }

            case "file_done": {
                const isMulti = data.sub_level !== undefined;
                if (isMulti) {
                    // PDF multi-level: accumulate sub-results
                    const parentIdx = data.parent_index;
                    const f = state.files[parentIdx];
                    if (f) {
                        if (!f.subResults) f.subResults = [];
                        f.subResults.push({ level: data.sub_level, result: data.result });
                        // Mark done when all 3 received
                        if (f.subResults.length >= 3) {
                            f.status = "done";
                            // Main result = medium level
                            const med = f.subResults.find(r => r.level === "medium");
                            f.result = med ? med.result : f.subResults[0].result;
                        }
                    }
                } else {
                    if (state.files[data.index]) {
                        state.files[data.index].status = "done";
                        state.files[data.index].result = data.result;
                    }
                }
                state.filesCompletedCount++;
                document.getElementById("progress-fill").style.width =
                    `${((data.index + 1) / data.total * 100)}%`;
                {
                    const completed = state.filesCompletedCount;
                    const remaining = data.total - completed;
                    let timeStr = "";
                    if (remaining > 0) {
                        const elapsed = (Date.now() - state.compressionStartTime) / 1000;
                        const avgPerFile = elapsed / completed;
                        const eta = Math.ceil(avgPerFile * remaining);
                        timeStr = ` \u2014 ~${eta}s`;
                    }
                    document.getElementById("progress-text").textContent =
                        `${completed} / ${data.total}${timeStr}`;
                }
                scheduleRender();
                updateSummary();
                break;
            }

            case "file_error": {
                const fileIdx = data.parent_index !== undefined ? data.parent_index : data.index;
                if (state.files[fileIdx]) {
                    state.files[fileIdx].status = "error";
                }
                state.filesCompletedCount++;
                scheduleRender();
                break;
            }

            case "batch_done":
                state.compressing = false;
                if (data.output_dir) {
                    state.lastOutputDir = data.output_dir;
                    showOpenFolderButton();
                }
                updateCompressButton();
                // Animation de fin : checkmark + texte
                document.getElementById("progress-fill").style.width = "100%";
                document.getElementById("progress-fill").classList.add("progress-bar__fill--done");
                document.getElementById("progress-text").innerHTML =
                    `<span class="progress-check">\u2713</span> ${data.count} fichier(s) \u2014 ${data.saved_mb} MB economises`;
                // Masquer la barre après 5s
                setTimeout(() => {
                    const gp = document.getElementById("global-progress");
                    gp.classList.add("hidden");
                    document.getElementById("progress-fill").classList.remove("progress-bar__fill--done");
                    document.getElementById("progress-fill").style.width = "0%";
                }, 5000);
                updateSummary();
                loadHistory();
                closeSSE();
                // Mark as compressed — on next launch, fields will be cleared
                fetch("/api/settings", {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({...gatherSettings(), has_compressed: true}),
                });
                break;

            case "keepalive":
                break;
        }
    };

    es.onerror = () => {
        closeSSE();
        if (state.compressing && state.sseRetryCount < SSE_MAX_RETRIES) {
            state.sseRetryCount++;
            const delay = Math.min(1000 * Math.pow(2, state.sseRetryCount), SSE_MAX_DELAY_MS);
            console.warn(`SSE reconnection attempt ${state.sseRetryCount} in ${delay}ms`);
            setTimeout(connectSSE, delay);
        }
    };
}

function closeSSE() {
    if (state.eventSource) {
        state.eventSource.close();
        state.eventSource = null;
    }
}

// ── History Modal ─────────────────────────

function setupHistoryModal() {
    document.getElementById("history-icon").addEventListener("click", () => {
        loadHistory();
        openModal("history-modal");
    });

    document.getElementById("clear-history-btn").addEventListener("click", async () => {
        await fetch("/api/history/clear", { method: "POST" });
        loadHistory();
    });
}

async function loadHistory() {
    try {
        const res = await fetch("/api/history");
        const data = await res.json();
        renderHistory(data.entries || []);
        renderHistoryStats(data.stats || {});
    } catch (e) {
        console.error("Load history error:", e);
    }
}

function renderHistory(entries) {
    const table = document.getElementById("history-table");
    const empty = document.getElementById("history-empty");
    const actions = document.getElementById("history-actions");
    const tbody = document.getElementById("history-body");

    if (entries.length === 0) {
        table.classList.add("hidden");
        empty.classList.remove("hidden");
        actions.classList.add("hidden");
        return;
    }

    table.classList.remove("hidden");
    empty.classList.add("hidden");
    actions.classList.remove("hidden");

    tbody.innerHTML = entries.map(e => {
        const rClass = reductionClass(e.reduction_pct || 0);
        const fname = (e.input_path || "").split("/").pop();
        const escapedFname = escapeHtml(fname);
        const escapedPath = escapeHtml(e.input_path || "");
        const date = e.timestamp ? new Date(e.timestamp).toLocaleDateString("fr-FR", {
            day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
        }) : "";
        return `<tr>
            <td title="${escapedPath}">${escapedFname}</td>
            <td><span class="format-badge ${escapeHtml(e.format || "")}">${escapeHtml((e.format || "").toUpperCase())}</span></td>
            <td>${humanSize(e.original_size || 0)}</td>
            <td>${humanSize(e.compressed_size || 0)}</td>
            <td class="${rClass}">-${e.reduction_pct || 0}%</td>
            <td>${e.duration || 0}s</td>
            <td class="history-date">${escapeHtml(date)}</td>
        </tr>`;
    }).join("");
}

function renderHistoryStats(stats) {
    const el = document.getElementById("history-stats");
    if (!stats || !stats.total_files) {
        el.textContent = "";
        return;
    }
    el.textContent = `${stats.total_files} fichiers \u2014 ${formatSavedSize(stats.total_saved_bytes)} economises \u2014 moy. -${stats.avg_reduction}%`;
}

// ── Preview Modal — Before/After Slider ───

/** Adapt the modal width to image aspect ratio — no scroll, no black bars. */
function fitContainerToImage() {
    const img = document.getElementById("preview-compressed");
    const surface = document.querySelector(".modal__surface--compare");
    if (!img || !surface || !img.naturalWidth) return;

    const ratio = img.naturalWidth / img.naturalHeight;
    const pad = 20; // body side padding
    // Chrome = header (~28px) + zoom bar (~36px) + body vertical padding (~18px)
    const chrome = 82;
    const maxW = window.innerWidth * 0.92;
    const maxImgH = window.innerHeight * 0.94 - chrome;

    let imgW;
    if (ratio >= 1) {
        // Landscape — start at max width, check height
        imgW = Math.min(maxW - pad, 900);
        if (imgW / ratio > maxImgH) imgW = maxImgH * ratio;
    } else {
        // Portrait — start at max height, derive width
        imgW = maxImgH * ratio;
        if (imgW > maxW - pad) imgW = maxW - pad;
    }

    surface.style.width = Math.round(imgW + pad) + "px";
}

function showPreview(index) {
    const file = state.files[index];
    if (!file || !file.result) return;

    document.getElementById("preview-title").textContent = file.name;
    const infoParts = [];
    if (file.dimensions) {
        infoParts.push(file.dimensions.pages
            ? `${file.dimensions.w}\u00d7${file.dimensions.h} pt \u00b7 ${file.dimensions.pages} p.`
            : `${file.dimensions.w}\u00d7${file.dimensions.h} px`);
    }
    infoParts.push(humanSize(file.result.original_size));
    document.getElementById("preview-file-info").textContent = infoParts.join(" \u00b7 ");

    const origImg = document.getElementById("preview-original");
    const compImg = document.getElementById("preview-compressed");

    // Reset zoom
    resetZoom();

    // Reset slider to 50% and show all UI, then fit container
    compImg.onload = () => {
        fitContainerToImage();

        const handle = document.getElementById("compare-handle");
        origImg.style.clipPath = "inset(0 50% 0 0)";
        handle.style.left = "50%";
        handle.style.display = "";
        document.querySelectorAll(".compare-badge, .compare-filename").forEach(el => el.style.display = "");

        // Fill dimension info from natural size
        document.getElementById("preview-original-dims").textContent =
            `${origImg.naturalWidth} x ${origImg.naturalHeight}`;
        document.getElementById("preview-compressed-dims").textContent =
            `${compImg.naturalWidth} x ${compImg.naturalHeight}`;
    };

    // Full quality via /api/serve
    compImg.src = `/api/serve?path=${encodeURIComponent(file.result.output_path)}`;
    origImg.src = `/api/serve?path=${encodeURIComponent(file.path)}`;

    // Badges — use data we already have
    const fmtUpper = file.format.toUpperCase();
    document.getElementById("preview-original-format").textContent = fmtUpper;
    document.getElementById("preview-compressed-format").textContent = fmtUpper;
    document.getElementById("preview-original-size").textContent = humanSize(file.result.original_size);
    document.getElementById("preview-compressed-size").textContent = humanSize(file.result.compressed_size);

    // File names
    document.getElementById("compare-name-before").textContent = file.name;
    const compressedName = file.result.output_path.split("/").pop() || file.name;
    document.getElementById("compare-name-after").textContent = compressedName;

    openModal("preview-modal");
}

function setupCompareSlider() {
    const container = document.getElementById("compare-container");
    if (!container) return;

    let dragging = false;

    function updateSlider(clientX) {
        const rect = container.getBoundingClientRect();
        let x = clientX - rect.left;
        x = Math.max(0, Math.min(x, rect.width));
        const pct = (x / rect.width) * 100;

        document.getElementById("preview-original").style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
        document.getElementById("compare-handle").style.left = pct + "%";
    }

    // Slider only when zoom <= 1 (fit mode) or on the handle
    container.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        // When zoomed > 1, only allow slider from the handle grip
        if (zoomScale > 1) {
            const handle = document.getElementById("compare-handle");
            if (!handle || !handle.contains(e.target)) return;
        }
        e.preventDefault();
        dragging = true;
        updateSlider(e.clientX);
    });

    document.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        e.preventDefault();
        updateSlider(e.clientX);
    });

    document.addEventListener("mouseup", () => { dragging = false; });

    // Touch support
    container.addEventListener("touchstart", (e) => {
        if (zoomScale > 1) {
            const handle = document.getElementById("compare-handle");
            if (!handle || !handle.contains(e.target)) return;
        }
        dragging = true;
        updateSlider(e.touches[0].clientX);
    }, { passive: true });

    document.addEventListener("touchmove", (e) => {
        if (!dragging) return;
        updateSlider(e.touches[0].clientX);
    }, { passive: true });

    document.addEventListener("touchend", () => { dragging = false; });
}

// ── Zoom system (Photoshop-style: fixed frame, centered image) ────

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4.0;
const ZOOM_STEP = 0.25;

let zoomScale = 1;
let panX = 0, panY = 0;
let isPanning = false;
let panStartX = 0, panStartY = 0;
let panStartPanX = 0, panStartPanY = 0;

function resetZoom() {
    zoomScale = 1;
    panX = 0;
    panY = 0;
    applyZoom();
}

function applyZoom() {
    const wrapper = document.getElementById("zoom-wrapper");
    if (!wrapper) return;

    // translate first, then scale — so pan is in screen pixels
    wrapper.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomScale})`;

    const container = document.getElementById("compare-container");
    if (container) {
        container.style.cursor = zoomScale > 1 ? "grab" : "col-resize";
    }

    const label = document.getElementById("zoom-level");
    if (label) label.textContent = `${Math.round(zoomScale * 100)}%`;
}

function setZoom(newScale) {
    zoomScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newScale));
    if (zoomScale <= 1) { panX = 0; panY = 0; }
    applyZoom();
}

function setupZoom() {
    const container = document.getElementById("compare-container");
    const wrapper = document.getElementById("zoom-wrapper");
    if (!container || !wrapper) return;

    // Buttons
    document.getElementById("zoom-in").addEventListener("click", () => setZoom(zoomScale + ZOOM_STEP));
    document.getElementById("zoom-out").addEventListener("click", () => setZoom(zoomScale - ZOOM_STEP));
    document.getElementById("zoom-fit").addEventListener("click", resetZoom);

    // Scroll wheel zoom (towards mouse position)
    container.addEventListener("wheel", (e) => {
        e.preventDefault();
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left - rect.width / 2;
        const mouseY = e.clientY - rect.top - rect.height / 2;

        const oldScale = zoomScale;
        const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
        const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomScale + delta));
        if (newScale === oldScale) return;

        // Adjust pan so zoom centers on mouse position
        const factor = newScale / oldScale;
        panX = mouseX - factor * (mouseX - panX);
        panY = mouseY - factor * (mouseY - panY);

        zoomScale = newScale;
        if (zoomScale <= 1) { panX = 0; panY = 0; }
        applyZoom();
    }, { passive: false });

    // Pan with left-drag when zoomed > 1 (except on handle)
    container.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || zoomScale <= 1) return;
        const handle = document.getElementById("compare-handle");
        if (handle && handle.contains(e.target)) return; // let slider handle it
        e.preventDefault();
        isPanning = true;
        panStartX = e.clientX;
        panStartY = e.clientY;
        panStartPanX = panX;
        panStartPanY = panY;
        container.classList.add("is-panning");
    });

    document.addEventListener("mousemove", (e) => {
        if (!isPanning) return;
        e.preventDefault();
        panX = panStartPanX + (e.clientX - panStartX);
        panY = panStartPanY + (e.clientY - panStartY);
        applyZoom();
    });

    document.addEventListener("mouseup", () => {
        if (isPanning) {
            isPanning = false;
            const c = document.getElementById("compare-container");
            if (c) c.classList.remove("is-panning");
        }
    });

    // Keyboard shortcuts when modal is open
    document.addEventListener("keydown", (e) => {
        const modal = document.getElementById("preview-modal");
        if (!modal || !modal.classList.contains("open")) return;
        if (e.key === "+" || e.key === "=") { e.preventDefault(); setZoom(zoomScale + ZOOM_STEP); }
        if (e.key === "-") { e.preventDefault(); setZoom(zoomScale - ZOOM_STEP); }
        if (e.key === "0") { e.preventDefault(); resetZoom(); }
    });
}

// Show fullscreen image (no compression yet) — full quality
function showFullscreen(index) {
    const file = state.files[index];
    if (!file) return;

    document.getElementById("preview-title").textContent = file.name;
    const infoParts = [];
    if (file.dimensions) {
        infoParts.push(file.dimensions.pages
            ? `${file.dimensions.w}\u00d7${file.dimensions.h} pt \u00b7 ${file.dimensions.pages} p.`
            : `${file.dimensions.w}\u00d7${file.dimensions.h} px`);
    }
    infoParts.push(humanSize(file.size));
    document.getElementById("preview-file-info").textContent = infoParts.join(" \u00b7 ");

    // Reset zoom
    resetZoom();

    const serveUrl = `/api/serve?path=${encodeURIComponent(file.path)}`;
    const origImg = document.getElementById("preview-original");
    const compImg = document.getElementById("preview-compressed");

    // Fit container when image loads
    compImg.onload = () => { fitContainerToImage(); };

    // Show same image, hide slider + badges
    compImg.src = serveUrl;
    origImg.src = serveUrl;
    origImg.style.clipPath = "inset(0 100% 0 0)";
    document.getElementById("compare-handle").style.display = "none";
    document.querySelectorAll(".compare-badge, .compare-filename").forEach(el => el.style.display = "none");

    document.getElementById("preview-original-size").textContent = humanSize(file.size);
    document.getElementById("preview-compressed-size").textContent = "";

    openModal("preview-modal");
}

// ── Generic Modal Helpers ─────────────────

function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    state._previousFocus = document.activeElement;
    modal.classList.add("open");
    trapFocus(modal);
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.remove("open");
    releaseFocus(modal);

    // Restore previous focus
    if (state._previousFocus && typeof state._previousFocus.focus === "function") {
        state._previousFocus.focus();
        state._previousFocus = null;
    }

    // Hide save form when closing presets modal
    if (id === "presets-modal") {
        const sf = document.getElementById("preset-modal-save-form");
        if (sf) sf.classList.add("hidden");
    }

    // Clean up preview images
    if (id === "preview-modal") {
        document.getElementById("preview-original").src = "";
        document.getElementById("preview-compressed").src = "";
    }
}

function setupModals() {
    // Close via scrim
    document.querySelectorAll(".modal__scrim[data-modal]").forEach(scrim => {
        scrim.addEventListener("click", () => closeModal(scrim.dataset.modal));
    });
    // Close via X button
    document.querySelectorAll(".modal-close-btn[data-modal]").forEach(btn => {
        btn.addEventListener("click", () => closeModal(btn.dataset.modal));
    });
    // Close via Escape key
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            document.querySelectorAll(".modal.open").forEach(m => closeModal(m.id));
        }
    });
}

// ── Focus Trap (accessibility) ────────────

function trapFocus(modal) {
    const focusable = modal.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    modal._trapHandler = (e) => {
        if (e.key !== "Tab") return;
        if (e.shiftKey) {
            if (document.activeElement === first) {
                e.preventDefault();
                last.focus();
            }
        } else {
            if (document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    };
    modal.addEventListener("keydown", modal._trapHandler);
    // Focus the close button (first focusable) after a tick
    requestAnimationFrame(() => first.focus());
}

function releaseFocus(modal) {
    if (modal._trapHandler) {
        modal.removeEventListener("keydown", modal._trapHandler);
        modal._trapHandler = null;
    }
}

// ── Settings Modal ────────────────────────

function setupSettingsModal() {
    document.getElementById("settings-icon").addEventListener("click", () => {
        openModal("settings-modal");
    });

    document.getElementById("toggle-notifications").addEventListener("change", saveAppSettings);
    document.getElementById("toggle-auto-updates").addEventListener("change", saveAppSettings);

    document.getElementById("browse-default-dir-btn").addEventListener("click", async () => {
        try {
            if (window.pywebview && window.pywebview.api) {
                const folder = await window.pywebview.api.choose_folder();
                if (folder) {
                    document.getElementById("default-output-dir").value = folder;
                    saveAppSettings();
                }
            }
        } catch (e) {
            console.error("Browse default dir error:", e);
        }
    });
}

async function saveAppSettings() {
    try {
        const settings = gatherSettings();
        settings.notifications_enabled = document.getElementById("toggle-notifications").checked;
        settings.auto_check_updates = document.getElementById("toggle-auto-updates").checked;
        settings.default_output_dir = document.getElementById("default-output-dir").value || null;

        await fetch("/api/settings", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(settings),
        });
    } catch (e) {
        console.error("Save app settings error:", e);
    }
}

// ── Update Modal ──────────────────────────

function setupUpdateModal() {
    document.getElementById("update-icon").addEventListener("click", () => {
        openModal("update-modal");
    });

    document.getElementById("check-updates-btn").addEventListener("click", () => {
        checkForUpdates(false);
    });

    document.getElementById("apply-update-btn").addEventListener("click", applyUpdate);
}

async function loadAppVersion() {
    try {
        const res = await fetch("/api/app/version");
        const data = await res.json();
        const v = `v${data.version}`;
        const aboutEl = document.getElementById("about-version");
        const updateEl = document.getElementById("update-current-version");
        if (aboutEl) aboutEl.textContent = v;
        if (updateEl) updateEl.textContent = v;
    } catch (e) {
        console.error("Load app version error:", e);
    }
}

async function checkForUpdates(silent) {
    const statusEl = document.getElementById("update-status");
    const statusText = document.getElementById("update-status-text");
    const changelogDiv = document.getElementById("update-changelog");
    const changelogText = document.getElementById("update-changelog-text");
    const checkBtn = document.getElementById("check-updates-btn");
    const applyBtn = document.getElementById("apply-update-btn");
    const badge = document.getElementById("update-badge");

    if (!silent) {
        statusEl.className = "update-status checking";
        setTextWithSpinner(statusText, "Verification...");
        checkBtn.disabled = true;
    }

    try {
        const res = await fetch("/api/updates/check");
        const data = await res.json();

        if (data.error && !data.update_available) {
            if (!silent) {
                statusEl.className = "update-status error";
                statusText.textContent = data.error;
            }
            badge.classList.add("hidden");
            checkBtn.disabled = false;
            return;
        }

        if (data.update_available) {
            statusEl.className = "update-status available";
            statusText.textContent = `Mise a jour disponible : v${data.latest_version}`;
            applyBtn.classList.remove("hidden");
            badge.classList.remove("hidden");

            applyBtn.dataset.isBundled = data.is_bundled ? "1" : "";

            if (data.changelog) {
                changelogText.textContent = data.changelog;
                changelogDiv.classList.remove("hidden");
            } else {
                changelogDiv.classList.add("hidden");
            }

            if (!silent) {
                openModal("update-modal");
            }
        } else {
            if (!silent) {
                statusEl.className = "update-status up-to-date";
                statusText.textContent = "Vous etes a jour \u2714";
            }
            badge.classList.add("hidden");
            applyBtn.classList.add("hidden");
            changelogDiv.classList.add("hidden");
        }
    } catch (e) {
        if (!silent) {
            statusEl.className = "update-status error";
            statusText.textContent = "Erreur de verification";
        }
        console.error("Check updates error:", e);
    } finally {
        checkBtn.disabled = false;
    }
}

async function applyUpdate() {
    const statusEl = document.getElementById("update-status");
    const statusText = document.getElementById("update-status-text");
    const applyBtn = document.getElementById("apply-update-btn");
    const checkBtn = document.getElementById("check-updates-btn");
    const isBundled = applyBtn.dataset.isBundled === "1";

    statusEl.className = "update-status installing";
    setTextWithSpinner(statusText, isBundled ? "Telechargement et installation..." : "Installation en cours...");
    applyBtn.disabled = true;
    checkBtn.disabled = true;

    try {
        const res = await fetch("/api/updates/apply", { method: "POST" });
        const data = await res.json();

        if (data.ok) {
            statusEl.className = "update-status installed";
            applyBtn.classList.add("hidden");
            document.getElementById("update-badge").classList.add("hidden");

            const changelogDiv = document.getElementById("update-changelog");
            const changelogTextEl = document.getElementById("update-changelog-text");
            changelogDiv.classList.remove("hidden");

            if (data.restarting) {
                statusText.textContent = "Mise a jour installee \u2714";
                changelogTextEl.textContent = "Redemarrage en cours...";
                // L'app va se fermer et relancer toute seule
                setTimeout(() => window.close(), 2000);
            } else if (isBundled) {
                statusText.textContent = "Mise a jour installee \u2714";
                changelogTextEl.textContent = "Relancez l'application.";
            } else {
                statusText.textContent = "Mise a jour installee \u2714";
                changelogTextEl.textContent = "Redemarrez l'application pour appliquer les changements.";
                if (data.new_version) {
                    const v = `v${data.new_version}`;
                    const aboutEl = document.getElementById("about-version");
                    const updateEl = document.getElementById("update-current-version");
                    if (aboutEl) aboutEl.textContent = v;
                    if (updateEl) updateEl.textContent = v;
                }
            }
        } else {
            statusEl.className = "update-status error";
            statusText.textContent = data.error || "Erreur lors de la mise a jour";
        }
    } catch (e) {
        statusEl.className = "update-status error";
        statusText.textContent = "Erreur de connexion";
        console.error("Apply update error:", e);
    } finally {
        applyBtn.disabled = false;
        checkBtn.disabled = false;
    }
}

// ── Snackbar (replaces alert()) ───────────

function showSnackbar(message, isError = false) {
    const el = document.getElementById("snackbar");
    el.textContent = message;
    el.className = "snackbar visible" + (isError ? " snackbar--error" : "");
    clearTimeout(state._snackbarTimeout);
    state._snackbarTimeout = setTimeout(() => {
        el.className = "snackbar";
    }, SNACKBAR_DURATION_MS);
}

// ── Presets ───────────────────────────────

function setupPresets() {
    const select = document.getElementById("preset-select");
    const saveBtn = document.getElementById("preset-save-btn");
    const clearBtn = document.getElementById("preset-clear-btn");
    const saveForm = document.getElementById("preset-modal-save-form");
    const cancelBtn = document.getElementById("preset-cancel-btn");
    const confirmBtn = document.getElementById("preset-confirm-btn");

    // Select preset
    select.addEventListener("change", () => {
        const id = select.value;
        setActivePreset(id || null);
        clearBtn.classList.toggle("hidden", !id);
        if (id) {
            const preset = state.presets.find(p => p.id === id);
            if (preset) {
                applySettingsToUI(preset.settings);
            }
        }
    });

    // Clear preset → reset settings without removing files
    clearBtn.addEventListener("click", () => {
        select.value = "";
        setActivePreset(null);
        resetFieldsToDefaults();
        clearBtn.classList.add("hidden");
    });

    // Save button → open modal in creation mode
    saveBtn.addEventListener("click", () => {
        const s = gatherSettings();
        const fmt = s.output_format ? s.output_format.toUpperCase() : "Original";
        const lvl = s.level.charAt(0).toUpperCase() + s.level.slice(1);
        document.getElementById("preset-name").value = `${fmt} ${lvl}`;
        renderCategorySelect();
        saveForm.classList.remove("hidden");
        openModal("presets-modal");
        setTimeout(() => {
            document.getElementById("preset-name").focus();
            document.getElementById("preset-name").select();
        }, 100);
    });

    cancelBtn.addEventListener("click", () => {
        saveForm.classList.add("hidden");
    });
    confirmBtn.addEventListener("click", () => {
        savePreset();
        saveForm.classList.add("hidden");
    });

    document.getElementById("preset-name").addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); savePreset(); saveForm.classList.add("hidden"); }
        if (e.key === "Escape") { saveForm.classList.add("hidden"); }
    });

    // Manage link → open modal
    document.getElementById("presets-manage-link").addEventListener("click", () => {
        renderPresetsModal();
        openModal("presets-modal");
    });
}

// ── Quick Presets (3 raccourcis) ─────────

// Stocke les IDs des presets assignes aux 3 slots
const quickPresetSlots = [null, null, null]; // index 0=slot1, 1=slot2, 2=slot3

function setupQuickPresets() {
    for (let slot = 1; slot <= 3; slot++) {
        const el = document.getElementById(`quick-preset-${slot}`);

        // Clic gauche : appliquer ou assigner
        el.addEventListener("click", () => {
            const presetId = quickPresetSlots[slot - 1];
            if (presetId) {
                // Appliquer le preset
                const preset = state.presets.find(p => p.id === presetId);
                if (preset) {
                    applySettingsToUI(preset.settings);
                    setActivePreset(preset.id);
                    document.getElementById("preset-select").value = preset.id;
                    document.getElementById("preset-clear-btn").classList.remove("hidden");
                    // Sync category filter
                    const catFilter = document.getElementById("preset-category-filter");
                    catFilter.value = preset.category || "";
                    renderPresetDropdown();
                    document.getElementById("preset-select").value = preset.id;
                    updateQuickPresetUI();
                    showSnackbar(`Preset "${preset.name}" applique`);
                } else {
                    // Preset supprime — vider le slot
                    quickPresetSlots[slot - 1] = null;
                    saveQuickPresets();
                    updateQuickPresetUI();
                }
            } else {
                // Slot vide → assigner le preset actif
                const activeId = state.activePresetId;
                if (!activeId) {
                    showSnackbar("Selectionnez d'abord un preset");
                    return;
                }
                quickPresetSlots[slot - 1] = activeId;
                saveQuickPresets();
                updateQuickPresetUI();
                const preset = state.presets.find(p => p.id === activeId);
                showSnackbar(`"${preset ? preset.name : 'Preset'}" assigne au raccourci ${slot}`);
            }
        });

        // Clic droit : menu contextuel (reassigner / vider)
        el.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            const presetId = quickPresetSlots[slot - 1];
            if (presetId) {
                // Vider le slot
                quickPresetSlots[slot - 1] = null;
                saveQuickPresets();
                updateQuickPresetUI();
                showSnackbar(`Raccourci ${slot} vide`);
            } else if (state.activePresetId) {
                // Assigner le preset actif
                quickPresetSlots[slot - 1] = state.activePresetId;
                saveQuickPresets();
                updateQuickPresetUI();
            }
        });
    }
}

function updateQuickPresetUI() {
    for (let slot = 1; slot <= 3; slot++) {
        const el = document.getElementById(`quick-preset-${slot}`);
        const label = el.querySelector(".quick-preset__label");
        const icon = el.querySelector(".quick-preset__icon");
        const summary = el.querySelector(".quick-preset__summary");
        const presetId = quickPresetSlots[slot - 1];

        if (presetId) {
            const preset = state.presets.find(p => p.id === presetId);
            if (preset) {
                label.textContent = preset.name;
                summary.textContent = generatePresetSummary(preset.settings);
                if (icon) icon.style.display = "none";
                el.classList.add("assigned");
                el.classList.toggle("active", state.activePresetId === presetId);
                el.title = `${preset.name}\nClic droit pour retirer`;
            } else {
                quickPresetSlots[slot - 1] = null;
                label.textContent = "Vide";
                summary.textContent = "";
                if (icon) icon.style.display = "";
                el.classList.remove("assigned", "active");
                el.title = "Cliquer pour assigner le preset actif";
            }
        } else {
            label.textContent = "Vide";
            summary.textContent = "";
            if (icon) icon.style.display = "";
            el.classList.remove("assigned", "active");
            el.title = "Cliquer pour assigner le preset actif";
        }
    }
}

function saveQuickPresets() {
    // Sauvegarder dans les settings utilisateur
    try {
        fetch("/api/settings").then(r => r.json()).then(settings => {
            settings.quick_presets = [...quickPresetSlots];
            fetch("/api/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(settings),
            });
        });
    } catch (e) {
        console.error("Save quick presets error:", e);
    }
}

function loadQuickPresets(settings) {
    const saved = settings.quick_presets;
    if (Array.isArray(saved) && saved.length === 3) {
        quickPresetSlots[0] = saved[0] || null;
        quickPresetSlots[1] = saved[1] || null;
        quickPresetSlots[2] = saved[2] || null;
    }
    updateQuickPresetUI();
}


// ── Presets Modal (gestion) ──────────────

function setupPresetsModal() {
    document.getElementById("presets-icon").addEventListener("click", () => {
        renderPresetsModal();
        openModal("presets-modal");
    });

    document.getElementById("preset-modal-import-btn").addEventListener("click", async () => {
        await importPresets();
        renderPresetsModal();
    });

    document.getElementById("preset-modal-add-cat-btn").addEventListener("click", () => {
        const form = document.getElementById("preset-modal-add-cat-form");
        form.classList.remove("hidden");
        const input = document.getElementById("preset-modal-cat-name");
        input.value = "";
        input.focus();
    });

    document.getElementById("preset-modal-cat-confirm").addEventListener("click", async () => {
        await addCategory(document.getElementById("preset-modal-cat-name").value);
        document.getElementById("preset-modal-add-cat-form").classList.add("hidden");
        renderPresetsModal();
    });

    document.getElementById("preset-modal-cat-cancel").addEventListener("click", () => {
        document.getElementById("preset-modal-add-cat-form").classList.add("hidden");
    });

    document.getElementById("preset-modal-cat-name").addEventListener("keydown", async (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            await addCategory(document.getElementById("preset-modal-cat-name").value);
            document.getElementById("preset-modal-add-cat-form").classList.add("hidden");
            renderPresetsModal();
        }
        if (e.key === "Escape") {
            document.getElementById("preset-modal-add-cat-form").classList.add("hidden");
        }
    });

    document.getElementById("preset-modal-export-btn").addEventListener("click", () => exportSelectedPresets());

    // Select all toggle
    document.getElementById("preset-select-all").addEventListener("change", (e) => {
        document.querySelectorAll("#preset-modal-list .preset-card__check").forEach(cb => {
            cb.checked = e.target.checked;
        });
    });

}

function renderPresetsModal() {
    renderPresetCards();
    document.getElementById("preset-select-all").checked = false;
}

function renderPresetCards() {
    const list = document.getElementById("preset-modal-list");
    const empty = document.getElementById("preset-modal-empty");
    const footer = document.getElementById("preset-modal-footer");

    list.innerHTML = "";

    if (state.presets.length === 0 && state.categories.length === 0) {
        empty.classList.remove("hidden");
        footer.classList.add("hidden");
        return;
    }
    empty.classList.add("hidden");
    footer.classList.toggle("hidden", state.presets.length === 0);

    // Group presets by category
    const byCategory = {};
    const noCat = [];
    for (const p of state.presets) {
        if (p.category) {
            if (!byCategory[p.category]) byCategory[p.category] = [];
            byCategory[p.category].push(p);
        } else {
            noCat.push(p);
        }
    }

    // Render each category as a group
    for (const cat of state.categories) {
        const presets = byCategory[cat] || [];
        const group = document.createElement("div");
        group.className = "preset-group";
        group.dataset.cat = cat;

        const countLabel = presets.length === 1 ? "1 preset" : `${presets.length} presets`;
        group.innerHTML = `
            <div class="preset-group__header" role="button">
                <svg class="preset-group__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="9 18 15 12 9 6"/></svg>
                <span class="preset-group__name">${escapeHtml(cat)}</span>
                <span class="preset-group__count">${countLabel}</span>
                <div class="preset-group__actions">
                    <button class="btn--icon btn--icon--sm preset-group__rename-btn" title="Renommer">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                    </button>
                    <button class="btn--icon btn--icon--sm btn--icon-error preset-group__delete-btn" title="Supprimer">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                    </button>
                </div>
            </div>
            <div class="preset-group__rename-form hidden">
                <input type="text" class="field__input field__input--sm" value="${escapeHtml(cat)}">
                <button class="btn btn--tonal btn--sm preset-group__rename-ok">OK</button>
                <button class="btn btn--text btn--sm preset-group__rename-cancel">Annuler</button>
            </div>
        `;

        // Add preset cards under this category (collapsed by default)
        const presetsContainer = document.createElement("div");
        presetsContainer.className = "preset-group__presets hidden";
        for (const p of presets) {
            presetsContainer.appendChild(_createPresetCard(p));
        }
        group.appendChild(presetsContainer);

        list.appendChild(group);
    }

    // Presets sans categorie
    if (noCat.length > 0) {
        const countLabel = noCat.length === 1 ? "1 preset" : `${noCat.length} presets`;
        const group = document.createElement("div");
        group.className = "preset-group";
        group.innerHTML = `
            <div class="preset-group__header preset-group__header--nocat" role="button">
                <svg class="preset-group__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="9 18 15 12 9 6"/></svg>
                <span class="preset-group__name">Sans categorie</span>
                <span class="preset-group__count">${countLabel}</span>
            </div>
        `;
        const presetsContainer = document.createElement("div");
        presetsContainer.className = "preset-group__presets hidden";
        for (const p of noCat) {
            presetsContainer.appendChild(_createPresetCard(p));
        }
        group.appendChild(presetsContainer);
        list.appendChild(group);
    }

    // Wire up category actions (read cat name from parent .preset-group dataset)
    list.querySelectorAll(".preset-group__rename-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const group = btn.closest(".preset-group");
            group.querySelector(".preset-group__header").classList.add("hidden");
            group.querySelector(".preset-group__rename-form").classList.remove("hidden");
            const input = group.querySelector(".preset-group__rename-form input");
            input.focus();
            input.select();
        });
    });
    list.querySelectorAll(".preset-group__rename-ok").forEach(btn => {
        btn.addEventListener("click", () => {
            const group = btn.closest(".preset-group");
            const oldName = group.dataset.cat;
            const input = group.querySelector(".preset-group__rename-form input");
            renameCategory(oldName, input.value.trim());
        });
    });
    list.querySelectorAll(".preset-group__rename-cancel").forEach(btn => {
        btn.addEventListener("click", () => {
            const group = btn.closest(".preset-group");
            group.querySelector(".preset-group__header").classList.remove("hidden");
            group.querySelector(".preset-group__rename-form").classList.add("hidden");
        });
    });
    list.querySelectorAll(".preset-group__rename-form input").forEach(input => {
        input.addEventListener("keydown", (e) => {
            const group = input.closest(".preset-group");
            if (e.key === "Enter") { e.preventDefault(); renameCategory(group.dataset.cat, input.value.trim()); }
            if (e.key === "Escape") {
                group.querySelector(".preset-group__header").classList.remove("hidden");
                group.querySelector(".preset-group__rename-form").classList.add("hidden");
            }
        });
    });
    list.querySelectorAll(".preset-group__delete-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const cat = btn.closest(".preset-group").dataset.cat;
            deleteCategory(cat);
        });
    });

    // Toggle collapse/expand on category header click
    list.querySelectorAll(".preset-group__header").forEach(header => {
        header.addEventListener("click", (e) => {
            // Don't toggle if clicking on action buttons or rename form
            if (e.target.closest(".preset-group__actions") || e.target.closest(".preset-group__rename-form")) return;
            const group = header.closest(".preset-group");
            const presets = group.querySelector(".preset-group__presets");
            if (!presets) return;
            const isOpen = !presets.classList.contains("hidden");
            presets.classList.toggle("hidden");
            group.classList.toggle("preset-group--open", !isOpen);
        });
    });

    // Wire up preset card actions
    _wirePresetCardActions(list);
}

function _createPresetCard(p) {
    const card = document.createElement("div");
    card.className = "preset-card";
    card.dataset.id = p.id;
    card.innerHTML = `
        <div class="preset-card__header">
            <input type="checkbox" class="preset-card__check" data-id="${p.id}">
            <span class="preset-card__name">${escapeHtml(p.name)}</span>
            <span class="preset-card__summary-inline">${generatePresetSummary(p.settings)}</span>
            <div class="preset-card__actions">
                <button class="btn--icon btn--icon--sm preset-card__rename" data-id="${p.id}" title="Renommer">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                </button>
                <button class="btn--icon btn--icon--sm btn--icon-error preset-card__delete" data-id="${p.id}" title="Supprimer">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                </button>
            </div>
        </div>
        <div class="preset-card__rename-form hidden">
            <input type="text" class="field__input field__input--sm preset-card__rename-input" value="${escapeHtml(p.name)}" data-id="${p.id}">
            <button class="btn btn--tonal btn--sm preset-card__rename-ok" data-id="${p.id}">OK</button>
            <button class="btn btn--text btn--sm preset-card__rename-cancel">Annuler</button>
        </div>
    `;
    return card;
}

function _wirePresetCardActions(list) {
    list.querySelectorAll(".preset-card__rename").forEach(btn => {
        btn.addEventListener("click", () => {
            const card = btn.closest(".preset-card");
            card.querySelector(".preset-card__header").classList.add("hidden");
            card.querySelector(".preset-card__rename-form").classList.remove("hidden");
            const input = card.querySelector(".preset-card__rename-input");
            input.focus();
            input.select();
        });
    });
    list.querySelectorAll(".preset-card__rename-ok").forEach(btn => {
        btn.addEventListener("click", () => renamePreset(btn.dataset.id, btn.closest(".preset-card").querySelector(".preset-card__rename-input").value));
    });
    list.querySelectorAll(".preset-card__rename-cancel").forEach(btn => {
        btn.addEventListener("click", () => {
            const card = btn.closest(".preset-card");
            card.querySelector(".preset-card__rename-form").classList.add("hidden");
            card.querySelector(".preset-card__header").classList.remove("hidden");
        });
    });
    list.querySelectorAll(".preset-card__rename-input").forEach(input => {
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); renamePreset(input.dataset.id, input.value); }
            if (e.key === "Escape") {
                const card = input.closest(".preset-card");
                card.querySelector(".preset-card__rename-form").classList.add("hidden");
                card.querySelector(".preset-card__header").classList.remove("hidden");
            }
        });
    });
    list.querySelectorAll(".preset-card__delete").forEach(btn => {
        btn.addEventListener("click", () => deletePreset(btn.dataset.id));
    });
    list.querySelectorAll(".preset-card__check").forEach(cb => {
        cb.addEventListener("change", () => {
            const anyChecked = list.querySelector(".preset-card__check:checked");
            document.getElementById("preset-modal-footer").classList.toggle("hidden", !anyChecked);
        });
    });
}

function generatePresetSummary(s) {
    const parts = [];
    if (s.output_format) parts.push(s.output_format.toUpperCase());
    if (s.level) {
        const lvl = s.level === "custom" && s.custom_quality ? `Custom ${s.custom_quality}%` : s.level.charAt(0).toUpperCase() + s.level.slice(1);
        parts.push(lvl);
    }
    if (s.resize_mode && s.resize_mode !== "none") {
        if (s.resize_mode === "width" && s.resize_width) parts.push(`W:${s.resize_width}px`);
        else if (s.resize_mode === "height" && s.resize_height) parts.push(`H:${s.resize_height}px`);
        else if (s.resize_mode === "percent" && s.resize_percent) parts.push(`${s.resize_percent}%`);
        else parts.push(`Resize: ${s.resize_mode}`);
    }
    if (s.strip_metadata) parts.push("Strip meta");
    if (s.lossless) parts.push("Lossless");
    if (s.target_size_kb) parts.push(`Target: ${s.target_size_kb}KB`);
    if (s.suffix) parts.push(`Suffix: ${s.suffix}`);
    return parts.join(" · ") || "Parametres par defaut";
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

async function exportSelectedPresets() {
    const checked = document.querySelectorAll("#preset-modal-list .preset-card__check:checked");
    const ids = Array.from(checked).map(cb => cb.dataset.id);
    if (ids.length === 0) {
        showSnackbar("Selectionnez au moins un preset");
        return;
    }
    try {
        const res = await fetch("/api/presets/export", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids }),
        });
        const exportData = await res.json();
        const saved = await window.pywebview.api.save_preset_file(exportData);
        if (saved) showSnackbar(`${ids.length} preset(s) exporte(s)`);
    } catch (e) {
        console.error("Export presets error:", e);
        showSnackbar("Erreur d'export");
    }
}

async function loadPresets() {
    try {
        const res = await fetch("/api/presets");
        const data = await res.json();
        state.presets = data.presets || [];
        state.categories = data.categories || [];
        state.activePresetId = data.active_preset_id || null;
        renderCategoryFilter();
        // If active preset, sync category filter to its category
        if (state.activePresetId) {
            const preset = state.presets.find(p => p.id === state.activePresetId);
            if (preset && preset.category) {
                document.getElementById("preset-category-filter").value = preset.category;
            }
        }
        renderPresetDropdown();
        // Restore active preset selection
        const select = document.getElementById("preset-select");
        const clearBtn = document.getElementById("preset-clear-btn");
        if (state.activePresetId) {
            select.value = state.activePresetId;
            const preset = state.presets.find(p => p.id === state.activePresetId);
            if (preset) applySettingsToUI(preset.settings);
            clearBtn.classList.remove("hidden");
        } else {
            clearBtn.classList.add("hidden");
        }
    } catch (e) {
        console.error("Load presets error:", e);
    }
}

function renderCategoryFilter() {
    const catFilter = document.getElementById("preset-category-filter");
    const currentVal = catFilter.value;
    catFilter.innerHTML = '<option value="">Toutes</option>';
    for (const cat of state.categories) {
        const opt = document.createElement("option");
        opt.value = cat;
        opt.textContent = cat;
        catFilter.appendChild(opt);
    }
    catFilter.value = currentVal;
    if (!catFilter.value && currentVal) catFilter.value = "";
}

function renderPresetDropdown() {
    const select = document.getElementById("preset-select");
    const currentVal = select.value;
    select.innerHTML = '<option value="">Aucun preset</option>';

    // Group presets by category using optgroup
    const byCategory = {};
    const noCat = [];
    for (const p of state.presets) {
        if (p.category) {
            if (!byCategory[p.category]) byCategory[p.category] = [];
            byCategory[p.category].push(p);
        } else {
            noCat.push(p);
        }
    }

    // Render optgroups for each category
    for (const cat of state.categories) {
        const presets = byCategory[cat];
        if (!presets || presets.length === 0) continue;
        const group = document.createElement("optgroup");
        group.label = cat;
        for (const p of presets) {
            const opt = document.createElement("option");
            opt.value = p.id;
            opt.textContent = p.name;
            group.appendChild(opt);
        }
        select.appendChild(group);
    }

    // Presets sans categorie
    for (const p of noCat) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name;
        select.appendChild(opt);
    }

    select.value = currentVal;
    if (!select.value && currentVal) select.value = "";
}

function renderCategorySelect() {
    const catSelect = document.getElementById("preset-category");
    catSelect.innerHTML = '<option value="">Sans categorie</option>';
    for (const cat of state.categories) {
        const opt = document.createElement("option");
        opt.value = cat;
        opt.textContent = cat;
        catSelect.appendChild(opt);
    }
}

async function savePreset() {
    const name = document.getElementById("preset-name").value.trim();
    if (!name) { showSnackbar("Nom requis"); return; }
    const category = document.getElementById("preset-category").value || null;
    const settings = gatherSettings();
    // Remove non-preset keys
    delete settings.output_dir;

    try {
        const res = await fetch("/api/presets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, category, settings }),
        });
        const data = await res.json();
        if (data.ok) {
            document.getElementById("preset-save-form").classList.add("hidden");
            await loadPresets();
            document.getElementById("preset-select").value = data.preset.id;
            state.activePresetId = data.preset.id;
            showSnackbar("Preset enregistre");
            if (document.getElementById("presets-modal").classList.contains("open")) {
                renderPresetsModal();
            }
        } else {
            showSnackbar(data.error || "Erreur");
        }
    } catch (e) {
        console.error("Save preset error:", e);
        showSnackbar("Erreur de sauvegarde");
    }
}

async function renamePreset(presetId, newName) {
    const name = (newName || "").trim();
    if (!name || !presetId) return;
    try {
        const res = await fetch(`/api/presets/${presetId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
        });
        const data = await res.json();
        if (data.ok) {
            await loadPresets();
            document.getElementById("preset-select").value = state.activePresetId || "";
            showSnackbar("Preset renomme");
            if (document.getElementById("presets-modal").classList.contains("open")) {
                renderPresetsModal();
            }
        }
    } catch (e) {
        console.error("Rename preset error:", e);
    }
}

async function updatePreset(presetId) {
    const id = presetId || state.activePresetId;
    if (!id) return;
    const settings = gatherSettings();
    delete settings.output_dir;

    try {
        const res = await fetch(`/api/presets/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ settings }),
        });
        const data = await res.json();
        if (data.ok) {
            await loadPresets();
            document.getElementById("preset-select").value = state.activePresetId || "";
            showSnackbar("Preset mis a jour");
            // Refresh modal if open
            if (document.getElementById("presets-modal").classList.contains("open")) {
                renderPresetsModal();
            }
        }
    } catch (e) {
        console.error("Update preset error:", e);
    }
}

async function deletePreset(presetId) {
    const id = presetId || state.activePresetId;
    if (!id) return;
    const preset = state.presets.find(p => p.id === id);
    if (!confirm(`Supprimer le preset "${preset ? preset.name : id}" ?`)) return;

    try {
        await fetch(`/api/presets/${id}`, { method: "DELETE" });
        if (state.activePresetId === id) {
            state.activePresetId = null;
            document.getElementById("preset-select").value = "";
        }
        await loadPresets();
        showSnackbar("Preset supprime");
        // Refresh modal if open
        if (document.getElementById("presets-modal").classList.contains("open")) {
            renderPresetsModal();
        }
    } catch (e) {
        console.error("Delete preset error:", e);
    }
}

async function setActivePreset(id) {
    state.activePresetId = id;
    updateQuickPresetUI();
    try {
        await fetch("/api/presets/active", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id }),
        });
    } catch (e) {
        console.error("Set active preset error:", e);
    }
}

async function importPresets() {
    try {
        const fileData = await window.pywebview.api.choose_preset_file();
        if (!fileData) return;

        let presets;
        if (fileData.app === "compressor" && Array.isArray(fileData.presets)) {
            presets = fileData.presets;
        } else if (Array.isArray(fileData)) {
            presets = fileData;
        } else {
            showSnackbar("Format de fichier invalide");
            return;
        }

        const res = await fetch("/api/presets/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ presets }),
        });
        const data = await res.json();
        if (data.ok) {
            await loadPresets();
            showSnackbar(`${data.imported} preset(s) importe(s)`);
        } else {
            showSnackbar(data.error || "Erreur d'import");
        }
    } catch (e) {
        console.error("Import presets error:", e);
        showSnackbar("Erreur d'import");
    }
}

async function addCategory(name) {
    if (!name || !name.trim()) return;
    try {
        const res = await fetch("/api/presets/categories", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: name.trim() }),
        });
        const data = await res.json();
        if (data.ok) {
            state.categories = data.categories;
            renderCategorySelect();
            renderCategoryFilter();
            document.getElementById("preset-category").value = name.trim();
            showSnackbar("Categorie ajoutee");
        }
    } catch (e) {
        console.error("Add category error:", e);
    }
}

function renderCategoryList() {
    const container = document.getElementById("preset-modal-cat-list");
    container.innerHTML = "";

    if (state.categories.length === 0) {
        container.innerHTML = '<div class="preset-modal-empty" style="padding:12px 0">Aucune categorie</div>';
        return;
    }

    for (const cat of state.categories) {
        const count = state.presets.filter(p => p.category === cat).length;
        const item = document.createElement("div");
        item.className = "preset-cat-item";
        item.dataset.cat = cat;
        item.innerHTML = `
            <span class="preset-cat-item__name">${escapeHtml(cat)}</span>
            <span class="preset-cat-item__count">${count} preset${count !== 1 ? "s" : ""}</span>
            <div class="preset-cat-item__actions">
                <button class="icon-button preset-cat-rename-btn" title="Renommer" data-cat="${escapeHtml(cat)}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M17 3a2.85 2.85 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
                    </svg>
                </button>
                <button class="icon-button preset-cat-delete-btn" title="Supprimer" data-cat="${escapeHtml(cat)}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                    </svg>
                </button>
            </div>
        `;
        container.appendChild(item);
    }

    // Rename buttons — replace name with inline input
    container.querySelectorAll(".preset-cat-rename-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const catName = btn.dataset.cat;
            const item = btn.closest(".preset-cat-item");
            const nameEl = item.querySelector(".preset-cat-item__name");
            const countEl = item.querySelector(".preset-cat-item__count");
            const actionsEl = item.querySelector(".preset-cat-item__actions");

            // Hide name/count/actions, show rename form
            nameEl.style.display = "none";
            countEl.style.display = "none";
            actionsEl.style.display = "none";

            const form = document.createElement("div");
            form.className = "preset-cat-item__rename-form";
            form.innerHTML = `
                <input type="text" class="field__input field__input--sm" value="${escapeHtml(catName)}">
                <button class="btn btn--tonal btn--sm">OK</button>
                <button class="btn btn--text btn--sm">Annuler</button>
            `;
            item.appendChild(form);

            const input = form.querySelector("input");
            const okBtn = form.querySelector(".btn--tonal");
            const cancelBtn = form.querySelector(".btn--text");
            input.focus();
            input.select();

            const doRename = async () => {
                const newName = input.value.trim();
                if (newName && newName !== catName) {
                    await renameCategory(catName, newName);
                } else {
                    // Cancel — restore original view
                    form.remove();
                    nameEl.style.display = "";
                    countEl.style.display = "";
                    actionsEl.style.display = "";
                }
            };

            const doCancel = () => {
                form.remove();
                nameEl.style.display = "";
                countEl.style.display = "";
                actionsEl.style.display = "";
            };

            okBtn.addEventListener("click", doRename);
            cancelBtn.addEventListener("click", doCancel);
            input.addEventListener("keydown", (e) => {
                if (e.key === "Enter") { e.preventDefault(); doRename(); }
                if (e.key === "Escape") { doCancel(); }
            });
        });
    });

    // Delete buttons
    container.querySelectorAll(".preset-cat-delete-btn").forEach(btn => {
        btn.addEventListener("click", () => deleteCategory(btn.dataset.cat));
    });
}

async function deleteCategory(name) {
    try {
        const res = await fetch("/api/presets/categories/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
        });
        const data = await res.json();
        if (data.ok) {
            await loadPresets();
            renderPresetsModal();
            renderPresetDropdown();
            showSnackbar(`Categorie "${name}" supprimee`);
        } else {
            showSnackbar(data.error || "Erreur");
        }
    } catch (e) {
        console.error("Delete category error:", e);
        showSnackbar("Erreur de suppression");
    }
}

async function renameCategory(oldName, newName) {
    try {
        const res = await fetch("/api/presets/categories/rename", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ old_name: oldName, new_name: newName }),
        });
        const data = await res.json();
        if (data.ok) {
            await loadPresets();
            renderCategoryList();
            renderPresetsModal();
            showSnackbar("Categorie renommee");
        } else {
            showSnackbar(data.error || "Erreur");
        }
    } catch (e) {
        console.error("Rename category error:", e);
        showSnackbar("Erreur de renommage");
    }
}

// ── Utils ─────────────────────────────────

function humanSize(bytes) {
    if (!bytes || bytes === 0) return "0 KB";
    if (bytes >= SIZE_MB) return `${(bytes / SIZE_MB).toFixed(1)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
}

function formatSavedSize(bytes) {
    if (bytes >= SIZE_MB) return `${(bytes / SIZE_MB).toFixed(1)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
}

function escapeHtml(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Safely sets text content with a leading spinner element.
 * Avoids innerHTML to prevent potential XSS via interpolated strings.
 */
function setTextWithSpinner(el, text) {
    el.textContent = "";
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    el.appendChild(spinner);
    el.appendChild(document.createTextNode(" " + text));
}

