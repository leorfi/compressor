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
    loadHistory();
    loadSettings();
    loadAppVersion();
});

// ── Drop Zone & File Selection ────────────

function setupDropZone() {
    const zone = document.getElementById("drop-zone");
    const chooseBtn = document.getElementById("choose-files-btn");
    const addBtn = document.getElementById("add-more-btn");
    const clearBtn = document.getElementById("clear-files-btn");

    document.addEventListener("dragover", (e) => { e.preventDefault(); });
    document.addEventListener("drop", (e) => { e.preventDefault(); });

    zone.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.add("drag-over");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
    zone.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.remove("drag-over");
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

    const newPaths = [];
    for (const path of paths) {
        if (state.files.find(f => f.path === path)) continue;
        const name = path.split("/").pop();
        const ext = name.split(".").pop().toLowerCase();
        const format = detectFormat(ext);
        if (format === "unknown") continue;
        state.files.push({
            path, name, format, size: 0,
            status: "pending", progress: 0, result: null,
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
                }
                updateQualityEstimate();
            }
        } catch (e) {
            console.warn("File sizes fetch error:", e);
        }
    }
}

function removeFile(index) {
    if (index < 0 || index >= state.files.length) return;
    state.files.splice(index, 1);
    renderFiles();
    updateCompressButton();
    updateSummary();
}

function clearFiles() {
    state.files = [];
    renderFiles();
    updateCompressButton();
    updateSummary();
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
        // Preview button
        const previewBtn = e.target.closest("[data-action='preview']");
        if (previewBtn) {
            const index = parseInt(previewBtn.dataset.index, 10);
            if (!isNaN(index)) showPreview(index);
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
    document.getElementById("file-count").textContent = `${state.files.length} fichier(s)`;

    const gridEl = document.getElementById("file-grid");
    const listEl = document.getElementById("file-list");

    if (state.viewMode === "grid") {
        gridEl.classList.remove("hidden");
        listEl.classList.add("hidden");
        renderGrid(gridEl);
    } else {
        gridEl.classList.add("hidden");
        listEl.classList.remove("hidden");
        renderList(listEl);
    }
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

function renderGrid(container) {
    container.innerHTML = state.files.map((f, i) => {
        const statusClass = getStatusClass(f.status);
        const escapedName = escapeHtml(f.name);
        const escapedPath = escapeHtml(f.path);

        let progressBar = "";
        if (f.status === "compressing") {
            progressBar = buildProgressBarHtml("file-card", i, f.progress);
        }

        let footerContent = "";
        if (f.result) {
            const rClass = reductionClass(f.result.reduction_pct);
            footerContent = `
                <span class="file-card__result ${rClass}">-${f.result.reduction_pct}%</span>
                ${buildPreviewBtn(i)}`;
        }

        return `<div class="file-card ${statusClass}" title="${escapedPath}">
            ${progressBar}
            <div class="file-card__header">
                <span class="format-badge ${f.format}">${f.format.toUpperCase()}</span>
                ${buildRemoveBtn(i, "file-card__remove")}
            </div>
            <div class="file-card__body">
                <span class="file-card__name">${escapedName}</span>
                <span class="file-card__size">${f.result ? humanSize(f.result.original_size) + ' \u2192 ' + humanSize(f.result.compressed_size) : ''}</span>
            </div>
            ${footerContent ? `<div class="file-card__footer">${footerContent}</div>` : ''}
        </div>`;
    }).join("");
}

// ── List Rendering ────────────────────────

function renderList(container) {
    container.innerHTML = state.files.map((f, i) => {
        const statusClass = getStatusClass(f.status);
        const escapedName = escapeHtml(f.name);
        const escapedPath = escapeHtml(f.path);

        let sizeInfo = "";
        let reduction = "";
        let previewBtn = "";
        if (f.result) {
            sizeInfo = `<span class="file-row__sizes">${humanSize(f.result.original_size)} \u2192 ${humanSize(f.result.compressed_size)}</span>`;
            const rClass = reductionClass(f.result.reduction_pct);
            reduction = `<span class="file-row__result ${rClass}">-${f.result.reduction_pct}%</span>`;
            previewBtn = buildPreviewBtn(i);
        }

        let progressBar = "";
        if (f.status === "compressing") {
            progressBar = buildProgressBarHtml("file-row", i, f.progress);
        }

        return `<li class="file-row ${statusClass}">
            <span class="format-badge ${f.format}">${f.format.toUpperCase()}</span>
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
}

// ── Side Sheet ────────────────────────────

function setupSideSheet() {
    // Level buttons
    document.getElementById("level-buttons").addEventListener("click", (e) => {
        const item = e.target.closest(".segmented-button__item");
        if (!item) return;
        document.querySelectorAll("#level-buttons .segmented-button__item").forEach(b => b.classList.remove("active"));
        item.classList.add("active");
        document.getElementById("custom-quality").classList.toggle("hidden", item.dataset.level !== "custom");
    });

    // Quality slider
    const slider = document.getElementById("quality-slider");
    const valSpan = document.getElementById("quality-value");
    slider.addEventListener("input", () => {
        valSpan.textContent = slider.value;
        updateQualityEstimate();
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

    select.addEventListener("change", updateResizeFields);
    percentSlider.addEventListener("input", () => {
        percentValue.textContent = `${percentSlider.value}%`;
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

    formatSelect.addEventListener("change", updateLosslessVisibility);
    losslessToggle.addEventListener("change", updateQualityDisabled);
    updateLosslessVisibility();
}

// ── Quality Estimation ────────────────

function updateQualityEstimate() {
    const estimateEl = document.getElementById("quality-estimate");
    if (!estimateEl) return;

    if (state.files.length === 0) {
        estimateEl.textContent = "";
        return;
    }

    const quality = parseInt(document.getElementById("quality-slider").value) || 70;
    const format = document.getElementById("output-format").value;
    const lossless = document.getElementById("lossless-toggle").checked;

    // Total original size
    const totalBytes = state.files.reduce((sum, f) => sum + (f.size || 0), 0);
    if (totalBytes === 0) {
        estimateEl.textContent = "";
        return;
    }

    // Heuristique d'estimation
    let factor;
    if (lossless) {
        factor = format === "webp" ? 0.75 : 0.85;
    } else if (format === "webp") {
        factor = (quality / 100) * 0.6;
    } else if (format === "jpeg") {
        factor = (quality / 100) * 0.8;
    } else if (format === "png") {
        factor = quality < 70 ? 0.5 : 0.85;
    } else {
        // Format original — estimation mixte
        factor = (quality / 100) * 0.75;
    }

    const estimated = totalBytes * factor;
    estimateEl.textContent = `~${humanSize(estimated)} estimes`;
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

    return {
        level: activeBtn ? activeBtn.dataset.level : "medium",
        custom_quality: parseInt(document.getElementById("quality-slider").value) || 70,
        output_format: document.getElementById("output-format").value || null,
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
    };
}

async function loadSettings() {
    try {
        const res = await fetch("/api/settings");
        const s = await res.json();

        // Sidebar settings
        if (s.level) {
            document.querySelectorAll("#level-buttons .segmented-button__item").forEach(b => {
                b.classList.toggle("active", b.dataset.level === s.level);
            });
            document.getElementById("custom-quality").classList.toggle("hidden", s.level !== "custom");
        }
        if (s.custom_quality) document.getElementById("quality-slider").value = s.custom_quality;
        if (s.output_format) document.getElementById("output-format").value = s.output_format;
        if (s.target_size_kb) document.getElementById("target-size").value = s.target_size_kb;
        if (s.output_dir) document.getElementById("output-dir").value = s.output_dir;
        document.getElementById("quality-value").textContent = document.getElementById("quality-slider").value;

        // Phase 2 — restore resize, metadata, suffix, date, lossless
        if (s.resize_mode) {
            document.getElementById("resize-mode").value = s.resize_mode;
            // Trigger update to show/hide conditional fields
            document.getElementById("resize-mode").dispatchEvent(new Event("change"));
        }
        if (s.resize_percent) {
            document.getElementById("resize-percent").value = s.resize_percent;
            document.getElementById("resize-percent-value").textContent = `${s.resize_percent}%`;
        }
        if (s.resize_width) document.getElementById("resize-width").value = s.resize_width;
        if (s.resize_height) document.getElementById("resize-height").value = s.resize_height;
        // For fit/exact mode, populate both W and H fields
        if (s.resize_mode === "fit" || s.resize_mode === "exact") {
            if (s.resize_width) document.getElementById("resize-fit-w").value = s.resize_width;
            if (s.resize_height) document.getElementById("resize-fit-h").value = s.resize_height;
        }
        if (s.strip_metadata) document.getElementById("strip-metadata").checked = true;
        if (s.suffix !== undefined && s.suffix !== null) {
            document.getElementById("output-suffix").value = s.suffix;
        }
        if (s.keep_date) document.getElementById("keep-date").checked = true;
        if (s.lossless) {
            document.getElementById("lossless-toggle").checked = true;
            // Trigger update to disable quality controls
            document.getElementById("lossless-toggle").dispatchEvent(new Event("change"));
        }
        // Update lossless visibility based on format
        document.getElementById("output-format").dispatchEvent(new Event("change"));

        // App settings (modal)
        const notifToggle = document.getElementById("toggle-notifications");
        const updateToggle = document.getElementById("toggle-auto-updates");
        if (notifToggle) notifToggle.checked = s.notifications_enabled !== false;
        if (updateToggle) updateToggle.checked = s.auto_check_updates !== false;
        if (s.default_output_dir) {
            document.getElementById("default-output-dir").value = s.default_output_dir;
        }

        // Auto-check updates
        if (s.auto_check_updates !== false) {
            setTimeout(() => checkForUpdates(true), AUTO_CHECK_DELAY_MS);
        }
    } catch (e) {
        console.error("Load settings error:", e);
    }
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

    state.files.forEach(f => { f.status = "pending"; f.progress = 0; f.result = null; });
    renderFiles();

    const gp = document.getElementById("global-progress");
    gp.classList.remove("hidden");
    document.getElementById("progress-fill").style.width = "0%";

    state.sseRetryCount = 0;
    connectSSE();

    const filePaths = state.files.map(f => f.path);
    try {
        const res = await fetch("/api/compress", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({ files: filePaths, settings }),
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
            case "file_start":
                if (state.files[data.index]) {
                    state.files[data.index].status = "compressing";
                    state.files[data.index].progress = 0;
                }
                document.getElementById("progress-text").textContent = `${data.index + 1} / ${data.total}`;
                scheduleRender();
                break;

            case "page_progress":
                if (state.files[data.file_index]) {
                    state.files[data.file_index].progress = data.page / data.total_pages;
                    // Direct DOM update — no full re-render needed
                    const bar = document.getElementById(`fprog-${data.file_index}`);
                    if (bar) bar.style.width = `${(data.page / data.total_pages * 100)}%`;
                }
                break;

            case "file_done":
                if (state.files[data.index]) {
                    state.files[data.index].status = "done";
                    state.files[data.index].result = data.result;
                }
                document.getElementById("progress-fill").style.width =
                    `${((data.index + 1) / data.total * 100)}%`;
                scheduleRender();
                updateSummary();
                break;

            case "file_error":
                if (state.files[data.index]) {
                    state.files[data.index].status = "error";
                }
                scheduleRender();
                break;

            case "batch_done":
                state.compressing = false;
                updateCompressButton();
                document.getElementById("progress-text").textContent =
                    `Termine \u2014 ${data.saved_mb} MB economises`;
                updateSummary();
                loadHistory();
                closeSSE();
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

// ── Preview Modal ─────────────────────────

async function showPreview(index) {
    const file = state.files[index];
    if (!file || !file.result) return;

    document.getElementById("preview-title").textContent = file.name;

    try {
        const res = await fetch("/api/preview", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                original: file.path,
                compressed: file.result.output_path,
            }),
        });
        const data = await res.json();
        if (data.error) {
            showSnackbar(data.error, true);
            return;
        }

        const fmt = file.format === "png" ? "image/png" : "image/jpeg";
        document.getElementById("preview-original").src = `data:${fmt};base64,${data.original.base64}`;
        document.getElementById("preview-compressed").src = `data:${fmt};base64,${data.compressed.base64}`;
        document.getElementById("preview-original-size").textContent = humanSize(data.original.size);
        document.getElementById("preview-compressed-size").textContent = humanSize(data.compressed.size);
        openModal("preview-modal");
    } catch (e) {
        console.error("Preview error:", e);
        showSnackbar("Erreur lors du chargement de l'apercu", true);
    }
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

    statusEl.className = "update-status installing";
    setTextWithSpinner(statusText, "Installation en cours...");
    applyBtn.disabled = true;
    checkBtn.disabled = true;

    try {
        const res = await fetch("/api/updates/apply", { method: "POST" });
        const data = await res.json();

        if (data.ok) {
            statusEl.className = "update-status installed";
            statusText.textContent = "Mise a jour installee \u2714";
            applyBtn.classList.add("hidden");
            document.getElementById("update-badge").classList.add("hidden");

            if (data.new_version) {
                const v = `v${data.new_version}`;
                const aboutEl = document.getElementById("about-version");
                const updateEl = document.getElementById("update-current-version");
                if (aboutEl) aboutEl.textContent = v;
                if (updateEl) updateEl.textContent = v;
            }

            const changelogDiv = document.getElementById("update-changelog");
            const changelogTextEl = document.getElementById("update-changelog-text");
            changelogDiv.classList.remove("hidden");
            changelogTextEl.textContent = "Redemarrez l'application pour appliquer les changements.";
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
