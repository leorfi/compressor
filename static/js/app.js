/* ═══════════════════════════════════════════
   Compressor — Frontend Logic (audited)
   ═══════════════════════════════════════════ */

// ── State ─────────────────────────────────

const state = {
    files: [],        // {path, name, size, format, status, progress, result}
    compressing: false,
    eventSource: null,
    sseRetryCount: 0,
    sseMaxRetries: 5,
};

// ── Init ──────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    setupDropZone();
    setupSidebar();
    setupHistoryPanel();
    setupPreviewModal();
    setupFileListDelegation();
    setupModals();
    setupSettingsModal();
    setupUpdateModal();
    loadHistory();
    loadSettings();
    loadAppVersion();
    loadAppSettings();
});

// ── Drop Zone & File Selection ────────────

let _dialogOpen = false;   // Empêche l'ouverture de 2 dialogues en même temps
let _justDropped = false;  // Ignore les clics juste après un drop

function setupDropZone() {
    const zone = document.getElementById("drop-zone");
    const chooseBtn = document.getElementById("choose-files-btn");
    const addBtn = document.getElementById("add-more-btn");
    const clearBtn = document.getElementById("clear-files-btn");

    // Empêcher le comportement par défaut sur tout le document (évite l'ouverture du fichier)
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
        _justDropped = true;
        setTimeout(() => { _justDropped = false; }, 500);
        handleDrop(e);
    });

    zone.addEventListener("click", (e) => {
        if (_justDropped) return;
        if (e.target !== chooseBtn) chooseFiles();
    });
    chooseBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (_justDropped) return;
        chooseFiles();
    });
    addBtn.addEventListener("click", chooseFiles);
    clearBtn.addEventListener("click", clearFiles);
}

async function handleDrop(e) {
    if (state.compressing) return;

    if (window.pywebview && window.pywebview.api) {
        try {
            // Lire les chemins directement depuis le pasteboard macOS natif
            const paths = await window.pywebview.api.get_drop_paths();
            if (paths && paths.length > 0) {
                addFiles(paths);
                return;
            }
        } catch (err) {
            console.warn("get_drop_paths failed:", err);
        }
    }

    // Fallback : ouvrir le dialogue natif si le pasteboard n'a rien donné
    chooseFiles();
}

async function chooseFiles() {
    if (state.compressing || _dialogOpen) return;
    _dialogOpen = true;
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
        _dialogOpen = false;
    }
}

async function addFiles(paths) {
    // Pré-extraire les ZIP côté backend avant d'ajouter à la liste
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

    for (const path of paths) {
        if (state.files.find(f => f.path === path)) continue;
        const name = path.split("/").pop();
        const ext = name.split(".").pop().toLowerCase();
        const format = detectFormat(ext);
        if (format === "unknown") continue;
        state.files.push({
            path, name, format,
            status: "pending", progress: 0, result: null,
        });
    }
    renderFileList();
    updateCompressButton();
}

function removeFile(index) {
    if (index < 0 || index >= state.files.length) return;
    state.files.splice(index, 1);
    renderFileList();
    updateCompressButton();
}

function clearFiles() {
    state.files = [];
    renderFileList();
    updateCompressButton();
}

function detectFormat(ext) {
    const map = { pdf: "pdf", jpg: "jpeg", jpeg: "jpeg", png: "png", webp: "webp", zip: "zip" };
    return map[ext] || "unknown";
}

// ── Event Delegation for File List ────────
// Remplace les onclick inline (vecteur XSS) par de la délégation d'événements

function setupFileListDelegation() {
    const ul = document.getElementById("files");
    ul.addEventListener("click", (e) => {
        const target = e.target;

        // Bouton supprimer
        if (target.classList.contains("remove-btn")) {
            const index = parseInt(target.dataset.index, 10);
            if (!isNaN(index)) removeFile(index);
            return;
        }

        // Bouton aperçu
        if (target.classList.contains("preview-btn")) {
            const index = parseInt(target.dataset.index, 10);
            if (!isNaN(index)) showPreview(index);
            return;
        }
    });
}

// ── File List Rendering ───────────────────

function renderFileList() {
    const zone = document.getElementById("drop-zone");
    const listDiv = document.getElementById("file-list");
    const content = document.getElementById("content");

    if (state.files.length === 0) {
        zone.classList.remove("hidden");
        listDiv.classList.add("hidden");
        content.style.alignItems = "center";
        return;
    }

    zone.classList.add("hidden");
    listDiv.classList.remove("hidden");
    content.style.alignItems = "stretch";
    document.getElementById("file-count").textContent = `${state.files.length} fichier(s)`;

    const ul = document.getElementById("files");
    ul.innerHTML = state.files.map((f, i) => {
        let statusClass = "";
        if (f.status === "compressing") statusClass = "compressing";
        if (f.status === "done") statusClass = "done";
        if (f.status === "error") statusClass = "error";

        let sizeInfo = "";
        let reduction = "";
        let previewBtn = "";
        if (f.result) {
            sizeInfo = `<span class="file-sizes">${humanSize(f.result.original_size)} → ${humanSize(f.result.compressed_size)}</span>`;
            const rClass = reductionClass(f.result.reduction_pct);
            reduction = `<span class="file-reduction ${rClass}">-${f.result.reduction_pct}%</span>`;
            previewBtn = `<button class="preview-btn" data-index="${i}">Apercu</button>`;
        }

        let progressBar = "";
        if (f.status === "compressing") {
            progressBar = `<div class="file-progress"><div class="progress-bar"><div class="progress-fill" style="width:${(f.progress * 100)}%" id="fprog-${i}"></div></div></div>`;
        }

        // Échapper le path pour l'attribut title
        const escapedPath = f.path.replace(/"/g, "&quot;").replace(/</g, "&lt;");
        const escapedName = f.name.replace(/</g, "&lt;").replace(/>/g, "&gt;");

        return `<li class="file-item ${statusClass}">
            <div class="file-info">
                <span class="format-badge ${f.format}">${f.format.toUpperCase()}</span>
                <span class="file-name" title="${escapedPath}">${escapedName}</span>
                ${sizeInfo}${reduction}
            </div>
            ${progressBar}
            ${previewBtn}
            <button class="remove-btn" data-index="${i}" ${state.compressing ? 'disabled' : ''}>&times;</button>
        </li>`;
    }).join("");
}

function reductionClass(pct) {
    if (pct > 30) return "reduction-good";
    if (pct > 10) return "reduction-ok";
    return "reduction-poor";
}

function updateCompressButton() {
    const btn = document.getElementById("compress-btn");
    btn.disabled = state.files.length === 0 || state.compressing;
}

// ── Sidebar & Settings ────────────────────

function setupSidebar() {
    // Level buttons
    document.getElementById("level-buttons").addEventListener("click", (e) => {
        if (!e.target.classList.contains("level-btn")) return;
        document.querySelectorAll(".level-btn").forEach(b => b.classList.remove("active"));
        e.target.classList.add("active");
        document.getElementById("custom-quality").classList.toggle("hidden", e.target.dataset.level !== "custom");
    });

    // Quality slider
    const slider = document.getElementById("quality-slider");
    const valSpan = document.getElementById("quality-value");
    slider.addEventListener("input", () => { valSpan.textContent = slider.value; });

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

function gatherSettings() {
    const activeBtn = document.querySelector(".level-btn.active");
    return {
        level: activeBtn ? activeBtn.dataset.level : "medium",
        custom_quality: parseInt(document.getElementById("quality-slider").value) || 70,
        max_resolution: document.getElementById("max-resolution").value || null,
        output_format: document.getElementById("output-format").value || null,
        target_size_kb: document.getElementById("target-size").value || null,
        output_dir: document.getElementById("output-dir").value || null,
    };
}

async function loadSettings() {
    try {
        const res = await fetch("/api/settings");
        const s = await res.json();
        if (s.level) {
            document.querySelectorAll(".level-btn").forEach(b => {
                b.classList.toggle("active", b.dataset.level === s.level);
            });
            document.getElementById("custom-quality").classList.toggle("hidden", s.level !== "custom");
        }
        if (s.custom_quality) document.getElementById("quality-slider").value = s.custom_quality;
        if (s.max_resolution) document.getElementById("max-resolution").value = s.max_resolution;
        if (s.output_format) document.getElementById("output-format").value = s.output_format;
        if (s.target_size_kb) document.getElementById("target-size").value = s.target_size_kb;
        if (s.output_dir) document.getElementById("output-dir").value = s.output_dir;
        document.getElementById("quality-value").textContent = document.getElementById("quality-slider").value;
    } catch (e) {
        console.error("Load settings error:", e);
    }
}

// ── Compression ───────────────────────────

async function startCompression() {
    if (state.compressing || state.files.length === 0) return;
    state.compressing = true;
    updateCompressButton();

    // Save settings
    const settings = gatherSettings();
    fetch("/api/settings", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(settings),
    });

    // Reset file states
    state.files.forEach(f => { f.status = "pending"; f.progress = 0; f.result = null; });
    renderFileList();

    // Show global progress
    const gp = document.getElementById("global-progress");
    gp.classList.remove("hidden");
    document.getElementById("progress-fill").style.width = "0%";

    // Connect SSE
    state.sseRetryCount = 0;
    connectSSE();

    // Start compression
    const filePaths = state.files.map(f => f.path);
    try {
        const res = await fetch("/api/compress", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({ files: filePaths, settings }),
        });
        if (!res.ok) {
            const err = await res.json();
            alert("Erreur: " + (err.error || "inconnue"));
            state.compressing = false;
            updateCompressButton();
        }
    } catch (e) {
        console.error("Compress request error:", e);
        state.compressing = false;
        updateCompressButton();
    }
}

// ── SSE Progress (avec reconnexion contrôlée) ──

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

        // Validation minimale du message
        if (!data || typeof data.type !== "string") return;

        switch (data.type) {
            case "file_start":
                if (state.files[data.index]) {
                    state.files[data.index].status = "compressing";
                    state.files[data.index].progress = 0;
                }
                document.getElementById("progress-text").textContent = `${data.index + 1} / ${data.total}`;
                renderFileList();
                break;

            case "page_progress":
                if (state.files[data.file_index]) {
                    state.files[data.file_index].progress = data.page / data.total_pages;
                    const bar = document.getElementById(`fprog-${data.file_index}`);
                    if (bar) bar.style.width = `${(data.page / data.total_pages * 100)}%`;
                }
                break;

            case "file_done":
                if (state.files[data.index]) {
                    state.files[data.index].status = "done";
                    state.files[data.index].result = data.result;
                }
                const pct = ((data.index + 1) / data.total * 100);
                document.getElementById("progress-fill").style.width = `${pct}%`;
                renderFileList();
                break;

            case "file_error":
                if (state.files[data.index]) {
                    state.files[data.index].status = "error";
                }
                renderFileList();
                break;

            case "batch_done":
                state.compressing = false;
                updateCompressButton();
                document.getElementById("progress-text").textContent = `Termine — ${data.saved_mb} MB economises`;
                loadHistory();
                closeSSE();
                break;

            case "keepalive":
                break;
        }
    };

    es.onerror = () => {
        closeSSE();
        // Reconnexion avec backoff exponentiel (seulement pendant une compression)
        if (state.compressing && state.sseRetryCount < state.sseMaxRetries) {
            state.sseRetryCount++;
            const delay = Math.min(1000 * Math.pow(2, state.sseRetryCount), 10000);
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

// ── History Panel ─────────────────────────

function setupHistoryPanel() {
    document.getElementById("history-header").addEventListener("click", () => {
        const content = document.getElementById("history-content");
        content.classList.toggle("collapsed");
        const btn = document.getElementById("history-toggle");
        btn.textContent = content.classList.contains("collapsed") ? "\u25BC" : "\u25B2";
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
        // Échapper pour éviter XSS
        const escapedFname = fname.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const escapedPath = (e.input_path || "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
        const date = e.timestamp ? new Date(e.timestamp).toLocaleDateString("fr-FR", {
            day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
        }) : "";
        return `<tr>
            <td title="${escapedPath}">${escapedFname}</td>
            <td><span class="format-badge ${e.format || ""}">${(e.format || "").toUpperCase()}</span></td>
            <td>${humanSize(e.original_size || 0)}</td>
            <td>${humanSize(e.compressed_size || 0)}</td>
            <td class="${rClass}">-${e.reduction_pct || 0}%</td>
            <td>${e.duration || 0}s</td>
            <td class="text-muted">${date}</td>
        </tr>`;
    }).join("");
}

function renderHistoryStats(stats) {
    const el = document.getElementById("history-stats-inline");
    if (!stats || !stats.total_files) {
        el.textContent = "";
        return;
    }
    const saved = stats.total_saved_bytes > 1048576
        ? `${(stats.total_saved_bytes / 1048576).toFixed(1)} MB`
        : `${Math.round(stats.total_saved_bytes / 1024)} KB`;
    el.textContent = `${stats.total_files} fichiers — ${saved} economises — moy. -${stats.avg_reduction}%`;
}

// ── Preview Modal ─────────────────────────

function setupPreviewModal() {
    document.getElementById("close-preview").addEventListener("click", closePreview);
    document.querySelector(".modal-overlay").addEventListener("click", closePreview);
}

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
        if (data.error) { alert(data.error); return; }

        const fmt = file.format === "png" ? "image/png" : "image/jpeg";
        document.getElementById("preview-original").src = `data:${fmt};base64,${data.original.base64}`;
        document.getElementById("preview-compressed").src = `data:${fmt};base64,${data.compressed.base64}`;
        document.getElementById("preview-original-size").textContent = humanSize(data.original.size);
        document.getElementById("preview-compressed-size").textContent = humanSize(data.compressed.size);
        document.getElementById("preview-modal").classList.remove("hidden");
    } catch (e) {
        console.error("Preview error:", e);
    }
}

function closePreview() {
    document.getElementById("preview-modal").classList.add("hidden");
    // Libérer la mémoire des data URIs
    document.getElementById("preview-original").src = "";
    document.getElementById("preview-compressed").src = "";
}

// ── Utils ─────────────────────────────────

function humanSize(bytes) {
    if (!bytes || bytes === 0) return "0 KB";
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
}

// ── Generic Modal Helpers ─────────────────

function openModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.remove("hidden");
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.add("hidden");
}

function setupModals() {
    // Fermer via overlay
    document.querySelectorAll(".modal-overlay[data-modal]").forEach(overlay => {
        overlay.addEventListener("click", () => closeModal(overlay.dataset.modal));
    });
    // Fermer via bouton X
    document.querySelectorAll(".modal-close-btn[data-modal]").forEach(btn => {
        btn.addEventListener("click", () => closeModal(btn.dataset.modal));
    });
}

// ── Settings Modal ────────────────────────

function setupSettingsModal() {
    document.getElementById("settings-icon").addEventListener("click", () => {
        openModal("settings-modal");
    });

    // Toggles — sauvegarde auto au changement
    document.getElementById("toggle-notifications").addEventListener("change", saveAppSettings);
    document.getElementById("toggle-auto-updates").addEventListener("change", saveAppSettings);

    // Browse default output dir
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

async function loadAppSettings() {
    try {
        const res = await fetch("/api/settings");
        const s = await res.json();

        // Restore toggles
        const notifToggle = document.getElementById("toggle-notifications");
        const updateToggle = document.getElementById("toggle-auto-updates");
        if (notifToggle) notifToggle.checked = s.notifications_enabled !== false;
        if (updateToggle) updateToggle.checked = s.auto_check_updates !== false;

        // Restore default output dir
        if (s.default_output_dir) {
            document.getElementById("default-output-dir").value = s.default_output_dir;
        }

        // Auto-check updates si activé (silencieux, après 2s)
        if (s.auto_check_updates !== false) {
            setTimeout(() => checkForUpdates(true), 2000);
        }
    } catch (e) {
        console.error("Load app settings error:", e);
    }
}

async function saveAppSettings() {
    try {
        // On recharge d'abord les settings actuels pour ne pas écraser les settings de compression
        const res = await fetch("/api/settings");
        const current = await res.json();

        // Merge avec les nouvelles valeurs
        current.notifications_enabled = document.getElementById("toggle-notifications").checked;
        current.auto_check_updates = document.getElementById("toggle-auto-updates").checked;
        current.default_output_dir = document.getElementById("default-output-dir").value || null;

        await fetch("/api/settings", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(current),
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
        statusText.innerHTML = '<span class="spinner"></span> Verification...';
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

            // Si silent, on ouvre pas le modal, on met juste le badge
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
    statusText.innerHTML = '<span class="spinner"></span> Installation en cours...';
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

            // Mettre à jour la version affichée
            if (data.new_version) {
                const v = `v${data.new_version}`;
                const aboutEl = document.getElementById("about-version");
                const updateEl = document.getElementById("update-current-version");
                if (aboutEl) aboutEl.textContent = v;
                if (updateEl) updateEl.textContent = v;
            }

            // Message de redémarrage
            const changelogDiv = document.getElementById("update-changelog");
            const changelogText = document.getElementById("update-changelog-text");
            changelogDiv.classList.remove("hidden");
            changelogText.textContent = "Redemarrez l'application pour appliquer les changements.";
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
