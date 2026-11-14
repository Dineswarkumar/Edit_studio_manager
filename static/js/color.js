// Color & 3D LUT Studio Frontend Logic
(function () {
  const state = {
    mediaList: [],
    selectedIds: new Set(),
    activeMediaId: null,
    luts: [],
    previewTimer: null,
    previewReqId: 0,
    activeJobId: null,
    isPeeking: false,
    splitPct: 55,
    config: {
      lut_id: null,
      custom_lut_filename: null,
      lut_strength: 1.0,
      exposure: 0.0,
      contrast: 1.0,
      highlights: 0.0,
      shadows: 0.0,
      saturation: 1.0,
      temperature: 0.0,
      vignette: 0.0,
      grain: 0.0,
      export_format: "original",
      image_quality: 92,
      video_preset: "balanced",
    },
  };

  const el = {
    dropzone: document.getElementById("colorDropzone"),
    fileInput: document.getElementById("colorFileInput"),
    mediaCount: document.getElementById("colorMediaCount"),
    selectAll: document.getElementById("colorSelectAll"),
    clearBtn: document.getElementById("btnColorClear"),
    mediaList: document.getElementById("colorMediaList"),
    selectedBadge: document.getElementById("colorSelectedBadge"),
    processBtn: document.getElementById("btnProcessColorBatch"),
    resetBtn: document.getElementById("btnResetGrade"),
    dimLabel: document.getElementById("colorDimLabel"),
    compareWrap: document.getElementById("colorCompareWrap"),
    beforeImg: document.getElementById("colorBeforeImg"),
    afterImg: document.getElementById("colorAfterImg"),
    splitLine: document.getElementById("colorSplitLine"),
    emptyStage: document.getElementById("colorEmptyStage"),
    splitSlider: document.getElementById("colorSplitSlider"),
    splitVal: document.getElementById("colorSplitVal"),
    peekBtn: document.getElementById("btnColorPeek"),
    lutGrid: document.getElementById("lutGrid"),
    btnUploadCustomLut: document.getElementById("btnUploadCustomLut"),
    customLutInput: document.getElementById("customLutInput"),
    customLutStatus: document.getElementById("customLutStatus"),
    sliderLutStrength: document.getElementById("sliderLutStrength"),
    valLutStrength: document.getElementById("valLutStrength"),
    sliderExposure: document.getElementById("sliderExposure"),
    valExposure: document.getElementById("valExposure"),
    sliderContrast: document.getElementById("sliderColorContrast"),
    valContrast: document.getElementById("valContrast"),
    sliderHighlights: document.getElementById("sliderHighlights"),
    valHighlights: document.getElementById("valHighlights"),
    sliderShadows: document.getElementById("sliderShadows"),
    valShadows: document.getElementById("valShadows"),
    sliderSat: document.getElementById("sliderColorSat"),
    valSat: document.getElementById("valSaturation"),
    sliderTemp: document.getElementById("sliderTemp"),
    valTemp: document.getElementById("valTemp"),
    sliderVignette: document.getElementById("sliderColorVignette"),
    valVignette: document.getElementById("valColorVignette"),
    sliderGrain: document.getElementById("sliderGrain"),
    valGrain: document.getElementById("valGrain"),
    exportFmt: document.getElementById("colorExportFmt"),
    videoPreset: document.getElementById("colorVideoPreset"),
    modal: document.getElementById("colorProgressModal"),
    btnCloseModal: document.getElementById("btnCloseColorModal"),
    jobText: document.getElementById("colorJobText"),
    jobFill: document.getElementById("colorJobFill"),
    jobItems: document.getElementById("colorJobItems"),
    btnZip: document.getElementById("btnColorDownloadZip"),
  };

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]));
  }

  async function init() {
    bindEvents();
    await loadLutCatalog();
    applySplitClip();
  }

  async function loadLutCatalog() {
    try {
      const res = await fetch("/api/color/luts");
      const data = await res.json();
      state.luts = data.luts || [];
    } catch (_) {
      state.luts = [];
    }
    renderLutChips();
  }

  function renderLutChips() {
    const active = state.config.custom_lut_filename ? "__custom__" : (state.config.lut_id || "");
    el.lutGrid.innerHTML = `<button type="button" class="lut-chip ${active === "" ? "active" : ""}" data-lut="">Original<small>No LUT applied</small></button>`;
    state.luts.forEach((lut) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `lut-chip ${active === lut.id ? "active" : ""}`;
      btn.dataset.lut = lut.id;
      btn.innerHTML = `${escapeHtml(lut.label)}<small>${escapeHtml(lut.description)}</small>`;
      el.lutGrid.appendChild(btn);
    });
    el.lutGrid.querySelectorAll(".lut-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        state.config.lut_id = chip.dataset.lut || null;
        state.config.custom_lut_filename = null;
        el.customLutStatus.style.display = "none";
        renderLutChips();
        schedulePreview(true);
      });
    });
  }

  function bindEvents() {
    el.dropzone.addEventListener("click", () => el.fileInput.click());
    el.fileInput.addEventListener("change", (e) => {
      if (e.target.files.length) uploadFiles(e.target.files);
      e.target.value = "";
    });
    el.dropzone.addEventListener("dragover", (e) => { e.preventDefault(); el.dropzone.classList.add("dragover"); });
    el.dropzone.addEventListener("dragleave", () => el.dropzone.classList.remove("dragover"));
    el.dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      el.dropzone.classList.remove("dragover");
      if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
    });

    el.selectAll.addEventListener("change", (e) => {
      if (e.target.checked) state.mediaList.forEach((m) => state.selectedIds.add(m.id));
      else state.selectedIds.clear();
      renderMediaList();
      syncCount();
    });

    el.clearBtn.addEventListener("click", () => {
      state.mediaList = [];
      state.selectedIds.clear();
      state.activeMediaId = null;
      renderMediaList();
      syncCount();
      renderPreview();
    });

    el.splitSlider.addEventListener("input", (e) => {
      state.splitPct = parseInt(e.target.value, 10);
      el.splitVal.textContent = `${state.splitPct}%`;
      applySplitClip();
    });

    const startPeek = () => { state.isPeeking = true; applySplitClip(); };
    const stopPeek = () => { state.isPeeking = false; applySplitClip(); };
    el.peekBtn.addEventListener("mousedown", startPeek);
    el.peekBtn.addEventListener("touchstart", startPeek, { passive: true });
    window.addEventListener("mouseup", stopPeek);
    window.addEventListener("touchend", stopPeek);

    el.btnUploadCustomLut.addEventListener("click", () => el.customLutInput.click());
    el.customLutInput.addEventListener("change", handleCustomLutUpload);

    const bindRange = (input, labelEl, key, fmt, scale = 1) => {
      input.addEventListener("input", () => {
        const raw = parseFloat(input.value);
        state.config[key] = raw * scale;
        labelEl.textContent = fmt(raw);
        schedulePreview(false);
      });
    };
    bindRange(el.sliderLutStrength, el.valLutStrength, "lut_strength", (v) => `${Math.round(v)}%`, 0.01);
    bindRange(el.sliderExposure, el.valExposure, "exposure", (v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`);
    bindRange(el.sliderContrast, el.valContrast, "contrast", (v) => `${v.toFixed(2)}x`);
    bindRange(el.sliderHighlights, el.valHighlights, "highlights", (v) => `${Math.round(v)}`, 0.01);
    bindRange(el.sliderShadows, el.valShadows, "shadows", (v) => `${Math.round(v)}`, 0.01);
    bindRange(el.sliderSat, el.valSat, "saturation", (v) => `${v.toFixed(2)}x`);
    bindRange(el.sliderTemp, el.valTemp, "temperature", (v) => `${Math.round(v)}`, 0.01);
    bindRange(el.sliderVignette, el.valVignette, "vignette", (v) => `${Math.round(v)}%`, 0.01);
    bindRange(el.sliderGrain, el.valGrain, "grain", (v) => `${Math.round(v)}%`, 0.01);

    el.exportFmt.addEventListener("change", (e) => { state.config.export_format = e.target.value; });
    el.videoPreset.addEventListener("change", (e) => { state.config.video_preset = e.target.value; });

    el.resetBtn.addEventListener("click", resetAllControls);
    el.processBtn.addEventListener("click", startBatchExport);
    el.btnCloseModal.addEventListener("click", () => el.modal.classList.remove("open"));
  }

  function resetAllControls() {
    Object.assign(state.config, {
      lut_id: null, custom_lut_filename: null, lut_strength: 1.0, exposure: 0.0,
      contrast: 1.0, highlights: 0.0, shadows: 0.0, saturation: 1.0,
      temperature: 0.0, vignette: 0.0, grain: 0.0,
    });
    el.sliderLutStrength.value = 100; el.valLutStrength.textContent = "100%";
    el.sliderExposure.value = 0; el.valExposure.textContent = "0.00";
    el.sliderContrast.value = 1.0; el.valContrast.textContent = "1.00x";
    el.sliderHighlights.value = 0; el.valHighlights.textContent = "0";
    el.sliderShadows.value = 0; el.valShadows.textContent = "0";
    el.sliderSat.value = 1.0; el.valSat.textContent = "1.00x";
    el.sliderTemp.value = 0; el.valTemp.textContent = "0";
    el.sliderVignette.value = 0; el.valVignette.textContent = "0%";
    el.sliderGrain.value = 0; el.valGrain.textContent = "0%";
    el.customLutStatus.style.display = "none";
    renderLutChips();
    schedulePreview(true);
  }

  function applySplitClip() {
    const pct = state.isPeeking ? 0 : state.splitPct;
    // Right side of split is Graded (or clip left = 100 - pct from right so left=Before, right=After)
    el.afterImg.style.clipPath = `inset(0 0 0 ${100 - pct}%)`;
    el.splitLine.style.left = `${100 - pct}%`;
  }

  async function uploadFiles(files) {
    const fd = new FormData();
    Array.from(files).forEach((f) => fd.append("files", f));
    if (window.STUDIO_TAB_SESSION_ID) fd.append("session_id", window.STUDIO_TAB_SESSION_ID);
    const res = await fetch("/api/upload-media", { method: "POST", body: fd });
    const data = await res.json();
    (data.media || []).forEach((m) => {
      if (m.media_type === "image" || m.media_type === "video") {
        state.mediaList.push(m);
        state.selectedIds.add(m.id);
        if (!state.activeMediaId) state.activeMediaId = m.id;
      }
    });
    renderMediaList();
    syncCount();
    schedulePreview(true);
  }

  async function handleCustomLutUpload(e) {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    if (window.STUDIO_TAB_SESSION_ID) fd.append("session_id", window.STUDIO_TAB_SESSION_ID);
    const res = await fetch("/api/color/upload-lut", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) {
      alert(data.detail || "Invalid .cube LUT file.");
      return;
    }
    state.config.lut_id = null;
    state.config.custom_lut_filename = data.filename;
    el.customLutStatus.textContent = `Custom LUT loaded: ${data.label} (${data.lut_size}³)`;
    el.customLutStatus.style.display = "block";
    renderLutChips();
    schedulePreview(true);
  }

  function renderMediaList() {
    el.mediaCount.textContent = `${state.mediaList.length} files`;
    if (!state.mediaList.length) {
      el.mediaList.innerHTML = `<div style="text-align:center;color:var(--text-dim);padding:30px 10px;font-size:13px;">No media queued yet.</div>`;
      return;
    }
    el.mediaList.innerHTML = "";
    state.mediaList.forEach((m) => {
      const card = document.createElement("div");
      card.className = `media-card ${m.id === state.activeMediaId ? "active" : ""}`;
      card.innerHTML = `
        <input type="checkbox" class="clr-chk" ${state.selectedIds.has(m.id) ? "checked" : ""}>
        <div class="media-thumb-wrapper"><img src="${m.thumb_url}" class="media-thumb-img" alt=""><span class="media-badge ${m.media_type === "video" ? "vid" : "img"}">${m.media_type === "video" ? "VID" : "IMG"}</span></div>
        <div class="media-info"><div class="media-filename">${escapeHtml(m.filename)}</div><div class="media-meta">${m.width}×${m.height}</div></div>
      `;
      card.querySelector(".clr-chk").addEventListener("change", (ev) => {
        if (ev.target.checked) state.selectedIds.add(m.id);
        else state.selectedIds.delete(m.id);
        syncCount();
      });
      card.addEventListener("click", (ev) => {
        if (ev.target.classList.contains("clr-chk")) return;
        state.activeMediaId = m.id;
        renderMediaList();
        schedulePreview(true);
      });
      el.mediaList.appendChild(card);
    });
  }

  function syncCount() {
    el.selectedBadge.textContent = state.selectedIds.size;
    el.processBtn.disabled = state.selectedIds.size === 0;
  }

  function schedulePreview(immediate) {
    if (state.previewTimer) clearTimeout(state.previewTimer);
    if (immediate) renderPreview();
    else state.previewTimer = setTimeout(renderPreview, 120);
  }

  async function renderPreview() {
    const active = state.mediaList.find((m) => m.id === state.activeMediaId);
    if (!active) {
      el.compareWrap.style.display = "none";
      el.emptyStage.style.display = "block";
      el.dimLabel.textContent = "No media selected";
      return;
    }
    el.dimLabel.textContent = `${active.filename} (${active.width}×${active.height})`;
    const reqId = ++state.previewReqId;
    const res = await fetch("/api/color/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_id: active.id,
        config: state.config,
        session_id: window.STUDIO_TAB_SESSION_ID || null,
      }),
    });
    const data = await res.json();
    if (reqId !== state.previewReqId || !res.ok) return;
    el.beforeImg.src = data.before_url;
    el.afterImg.src = data.after_url;
    el.compareWrap.style.display = "inline-block";
    el.emptyStage.style.display = "none";
    applySplitClip();
  }

  async function startBatchExport() {
    const ids = Array.from(state.selectedIds);
    if (!ids.length) return;
    el.modal.classList.add("open");
    el.btnZip.style.display = "none";
    el.jobFill.style.width = "0%";
    el.jobText.textContent = `Applying grade to ${ids.length} item(s)…`;
    el.jobItems.innerHTML = "";

    const res = await fetch("/api/color/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_ids: ids,
        config: state.config,
        session_id: window.STUDIO_TAB_SESSION_ID || null,
      }),
    });
    const data = await res.json();
    state.activeJobId = data.job_id;
    pollColorJob();
  }

  async function pollColorJob() {
    if (!state.activeJobId) return;
    const res = await fetch(`/api/job/${state.activeJobId}`);
    const job = await res.json();
    const pct = Math.round((job.progress || 0) * 100);
    el.jobFill.style.width = `${pct}%`;
    el.jobItems.innerHTML = "";
    (job.items || []).forEach((it) => {
      const row = document.createElement("div");
      row.className = "job-item-row";
      row.innerHTML = `
        <span style="font-size:12px;">${escapeHtml(it.filename)}</span>
        ${it.status === "completed"
          ? `<a href="${it.download_url}" download class="btn-secondary" style="padding:4px 10px;font-size:11px;text-decoration:none;">Download</a>`
          : `<span style="font-size:11px;color:${it.status === "failed" ? "var(--accent-rose)" : "var(--text-dim)"};">${it.status === "failed" ? escapeHtml(it.error) : "Processing…"}</span>`}
      `;
      el.jobItems.appendChild(row);
    });
    if (job.status === "completed") {
      el.jobText.textContent = "Color grade export complete!";
      el.btnZip.href = `/api/download-zip/${state.activeJobId}`;
      el.btnZip.style.display = "inline-flex";
    } else if (job.status === "failed") {
      el.jobText.textContent = job.error || "Grading failed.";
    } else {
      el.jobText.textContent = `Processing (${pct}%)…`;
      setTimeout(pollColorJob, 700);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
