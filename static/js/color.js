// Color & 3D LUT Studio Frontend Logic
(function () {
  const state = {
    mediaList: [],
    selectedIds: new Set(),
    activeMediaId: null,
    luts: [],
    previewTimer: null,
    previewReqId: 0,
    previewAbortController: null,
    activeJobId: null,
    isPeeking: false,
    splitPct: 50,
    videoFrameSec: 0.5,
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
    renderStatus: document.getElementById("colorRenderStatus"),
    dimLabel: document.getElementById("colorDimLabel"),
    compareWrap: document.getElementById("colorCompareWrap"),
    beforeImg: document.getElementById("colorBeforeImg"),
    afterImg: document.getElementById("colorAfterImg"),
    afterPill: document.getElementById("colorAfterPill"),
    splitLine: document.getElementById("colorSplitLine"),
    emptyStage: document.getElementById("colorEmptyStage"),
    videoScrubBar: document.getElementById("colorVideoScrubBar"),
    videoScrubber: document.getElementById("colorVideoScrubber"),
    videoTimeLabel: document.getElementById("colorVideoTimeLabel"),
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

  const LUT_SWATCHES = {
    "": "linear-gradient(135deg, #2b313a 0%, #64748b 52%, #cbd5e1 100%)",
    teal_orange: "linear-gradient(135deg, #0d4f5c 0%, #14b8a6 46%, #f59e0b 100%)",
    kodak_2383: "linear-gradient(135deg, #1e293b 0%, #b45309 52%, #fde68a 100%)",
    crisp_daylight: "linear-gradient(135deg, #0369a1 0%, #38bdf8 54%, #f8fafc 100%)",
    moody_noir: "linear-gradient(135deg, #090b0f 0%, #374151 55%, #9ca3af 100%)",
    warm_sunset: "linear-gradient(135deg, #7c2d12 0%, #ea580c 50%, #fcd34d 100%)",
    matte_fade: "linear-gradient(135deg, #3f3d46 0%, #7c7267 52%, #d6cfc4 100%)",
    __custom__: "linear-gradient(135deg, #6366f1 0%, #06b6d4 52%, #f43f5e 100%)",
  };

  function getSliderSpecs() {
    return [
      { id: "sliderLutStrength", input: el.sliderLutStrength, label: el.valLutStrength, key: "lut_strength", defRaw: 100, scale: 0.01, fmt: (v) => `${Math.round(v)}%`, group: "lut" },
      { id: "sliderExposure", input: el.sliderExposure, label: el.valExposure, key: "exposure", defRaw: 0, scale: 1, fmt: (v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`, group: "tone" },
      { id: "sliderColorContrast", input: el.sliderContrast, label: el.valContrast, key: "contrast", defRaw: 1.0, scale: 1, fmt: (v) => `${v.toFixed(2)}x`, group: "tone" },
      { id: "sliderHighlights", input: el.sliderHighlights, label: el.valHighlights, key: "highlights", defRaw: 0, scale: 0.01, fmt: (v) => `${Math.round(v)}`, group: "tone" },
      { id: "sliderShadows", input: el.sliderShadows, label: el.valShadows, key: "shadows", defRaw: 0, scale: 0.01, fmt: (v) => `${Math.round(v)}`, group: "tone" },
      { id: "sliderColorSat", input: el.sliderSat, label: el.valSat, key: "saturation", defRaw: 1.0, scale: 1, fmt: (v) => `${v.toFixed(2)}x`, group: "color" },
      { id: "sliderTemp", input: el.sliderTemp, label: el.valTemp, key: "temperature", defRaw: 0, scale: 0.01, fmt: (v) => `${Math.round(v)}`, group: "color" },
      { id: "sliderColorVignette", input: el.sliderVignette, label: el.valVignette, key: "vignette", defRaw: 0, scale: 0.01, fmt: (v) => `${Math.round(v)}%`, group: "color" },
      { id: "sliderGrain", input: el.sliderGrain, label: el.valGrain, key: "grain", defRaw: 0, scale: 0.01, fmt: (v) => `${Math.round(v)}%`, group: "color" },
    ];
  }

  function applySliderSpecValue(spec, rawVal) {
    if (!spec || !spec.input || !spec.label) return;
    spec.input.value = rawVal;
    state.config[spec.key] = rawVal * spec.scale;
    spec.label.textContent = spec.fmt(rawVal);
    const modified = Math.abs(rawVal - spec.defRaw) > 1e-4;
    spec.label.classList.toggle("is-modified", modified);
  }

  function renderLutChips() {
    const active = state.config.custom_lut_filename ? "__custom__" : (state.config.lut_id || "");
    const buildChipHtml = (id, label, desc) => {
      const swatch = LUT_SWATCHES[id] || LUT_SWATCHES.__custom__;
      return `<span class="lut-swatch" style="background: ${swatch};"></span><span class="lut-meta"><span class="lut-name">${escapeHtml(label)}</span><small>${escapeHtml(desc)}</small></span>`;
    };
    el.lutGrid.innerHTML = `<button type="button" class="lut-chip ${active === "" ? "active" : ""}" data-lut="">${buildChipHtml("", "Original", "No LUT applied")}</button>`;
    state.luts.forEach((lut) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `lut-chip ${active === lut.id ? "active" : ""}`;
      btn.dataset.lut = lut.id;
      btn.innerHTML = buildChipHtml(lut.id, lut.label, lut.description);
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

    if (el.compareWrap) {
      let draggingSplit = false;
      const updateSplitFromClientX = (clientX) => {
        const rect = el.compareWrap.getBoundingClientRect();
        if (rect.width <= 0) return;
        const pct = Math.max(0, Math.min(100, Math.round(((clientX - rect.left) / rect.width) * 100)));
        state.splitPct = pct;
        if (el.splitSlider) el.splitSlider.value = String(pct);
        if (el.splitVal) el.splitVal.textContent = `${pct}%`;
        applySplitClip();
      };
      el.compareWrap.addEventListener("pointerdown", (e) => {
        if (e.button !== undefined && e.button !== 0 && e.pointerType === "mouse") return;
        draggingSplit = true;
        if (el.compareWrap.setPointerCapture && e.pointerId !== undefined) {
          try { el.compareWrap.setPointerCapture(e.pointerId); } catch (_) {}
        }
        updateSplitFromClientX(e.clientX);
      });
      el.compareWrap.addEventListener("pointermove", (e) => {
        if (!draggingSplit) return;
        updateSplitFromClientX(e.clientX);
      });
      const stopSplitDrag = () => { draggingSplit = false; };
      el.compareWrap.addEventListener("pointerup", stopSplitDrag);
      el.compareWrap.addEventListener("pointercancel", stopSplitDrag);
    }

    if (el.videoScrubber) {
      el.videoScrubber.addEventListener("input", (e) => {
        const sec = parseFloat(e.target.value) || 0;
        state.videoFrameSec = sec;
        if (el.videoTimeLabel) el.videoTimeLabel.textContent = `${sec.toFixed(1)}s`;
        schedulePreview(false);
      });
    }

    const startPeek = () => { state.isPeeking = true; applySplitClip(); };
    const stopPeek = () => { state.isPeeking = false; applySplitClip(); };
    el.peekBtn.addEventListener("mousedown", startPeek);
    el.peekBtn.addEventListener("touchstart", startPeek, { passive: true });
    window.addEventListener("mouseup", stopPeek);
    window.addEventListener("touchend", stopPeek);

    el.btnUploadCustomLut.addEventListener("click", () => el.customLutInput.click());
    el.customLutInput.addEventListener("change", handleCustomLutUpload);

    const specs = getSliderSpecs();
    const specById = new Map(specs.map((s) => [s.id, s]));
    specs.forEach((spec) => {
      if (!spec.input) return;
      spec.input.addEventListener("input", () => {
        const raw = parseFloat(spec.input.value);
        applySliderSpecValue(spec, raw);
        applyInstantCssFeedback();
        schedulePreview(false);
      });
      spec.input.addEventListener("dblclick", () => {
        applySliderSpecValue(spec, spec.defRaw);
        applyInstantCssFeedback();
        schedulePreview(true);
      });
    });

    const toolsPanel = document.getElementById("toolsPanel");
    if (toolsPanel) {
      toolsPanel.addEventListener("click", (e) => {
        const groupBtn = e.target.closest("[data-reset-group]");
        if (groupBtn) {
          const grp = groupBtn.dataset.resetGroup;
          specs.filter((s) => s.group === grp).forEach((s) => applySliderSpecValue(s, s.defRaw));
          applyInstantCssFeedback();
          schedulePreview(true);
          return;
        }
        const badge = e.target.closest("[data-reset-slider]");
        if (badge && badge.classList.contains("is-modified")) {
          const spec = specById.get(badge.dataset.resetSlider);
          if (spec) {
            e.preventDefault();
            applySliderSpecValue(spec, spec.defRaw);
            applyInstantCssFeedback();
            schedulePreview(true);
          }
        }
      });
    }

    el.exportFmt.addEventListener("change", (e) => { state.config.export_format = e.target.value; });
    el.videoPreset.addEventListener("change", (e) => { state.config.video_preset = e.target.value; });

    el.resetBtn.addEventListener("click", resetAllControls);
    el.processBtn.addEventListener("click", startBatchExport);
    el.btnCloseModal.addEventListener("click", () => el.modal.classList.remove("open"));
  }

  function applyInstantCssFeedback() {
    if (!el.afterImg) return;
    // Provide zero-lag approximate preview while debounced server trilinear LUT renders
    const expMul = Math.max(0.25, Math.min(2.5, Math.pow(2, state.config.exposure * 0.45)));
    el.afterImg.style.filter = `brightness(${expMul.toFixed(2)}) contrast(${state.config.contrast.toFixed(2)}) saturate(${state.config.saturation.toFixed(2)})`;
  }

  function clearCssFeedback() {
    if (el.afterImg) el.afterImg.style.filter = "";
  }

  function resetAllControls() {
    state.config.lut_id = null;
    state.config.custom_lut_filename = null;
    getSliderSpecs().forEach((spec) => applySliderSpecValue(spec, spec.defRaw));
    el.customLutStatus.style.display = "none";
    clearCssFeedback();
    renderLutChips();
    schedulePreview(true);
  }

  function applySplitClip() {
    // Left side = Original (0..pct%), Right side = Graded (pct%..100%)
    const pct = state.isPeeking ? 100 : state.splitPct;
    el.afterImg.style.clipPath = `inset(0 0 0 ${pct}%)`;
    el.splitLine.style.left = `${pct}%`;
    if (el.afterPill) el.afterPill.style.opacity = pct >= 95 ? "0.25" : "1";
  }

  async function uploadFiles(files) {
    if (el.renderStatus) el.renderStatus.textContent = "Uploading…";
    try {
      const fd = new FormData();
      Array.from(files).forEach((f) => fd.append("files", f));
      if (window.STUDIO_TAB_SESSION_ID) fd.append("session_id", window.STUDIO_TAB_SESSION_ID);
      const res = await fetch("/api/upload-media", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) {
        alert(data.detail || "Upload failed.");
        return;
      }
      (data.media || []).forEach((m) => {
        if (m.media_type === "image" || m.media_type === "video") {
          state.mediaList.push(m);
          state.selectedIds.add(m.id);
          if (!state.activeMediaId) {
            state.activeMediaId = m.id;
            state.videoFrameSec = m.media_type === "video" ? Math.min(0.5, (m.duration || 1) / 2) : 0;
          }
        }
      });
      renderMediaList();
      syncCount();
      schedulePreview(true);
    } finally {
      if (el.renderStatus && el.renderStatus.textContent === "Uploading…") el.renderStatus.textContent = "";
    }
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
      el.mediaList.innerHTML = `<div style="text-align:center;color:var(--text-dim);padding:36px 10px;font-size:13px;">No media queued yet.</div>`;
      return;
    }
    el.mediaList.innerHTML = "";
    state.mediaList.forEach((m) => {
      const card = document.createElement("div");
      card.className = `media-card ${m.id === state.activeMediaId ? "active" : ""}`;
      card.innerHTML = `
        <input type="checkbox" class="clr-chk" ${state.selectedIds.has(m.id) ? "checked" : ""}>
        <div class="media-thumb-wrapper"><img src="${m.thumb_url || ""}" class="media-thumb-img" alt=""><span class="media-badge ${m.media_type === "video" ? "vid" : "img"}">${m.media_type === "video" ? "VID" : "IMG"}</span></div>
        <div class="media-info"><div class="media-filename">${escapeHtml(m.filename)}</div><div class="media-meta">${m.width}×${m.height}${m.media_type === "video" && m.duration ? ` · ${m.duration.toFixed(1)}s` : ""}</div></div>
      `;
      card.querySelector(".clr-chk").addEventListener("change", (ev) => {
        if (ev.target.checked) state.selectedIds.add(m.id);
        else state.selectedIds.delete(m.id);
        syncCount();
      });
      card.addEventListener("click", (ev) => {
        if (ev.target.classList.contains("clr-chk")) return;
        state.activeMediaId = m.id;
        state.videoFrameSec = m.media_type === "video" ? Math.min(0.5, (m.duration || 1) / 2) : 0;
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
    else state.previewTimer = setTimeout(renderPreview, 90);
  }

  async function renderPreview() {
    const active = state.mediaList.find((m) => m.id === state.activeMediaId);
    if (!active) {
      el.compareWrap.style.display = "none";
      el.emptyStage.style.display = "flex";
      if (el.videoScrubBar) el.videoScrubBar.style.display = "none";
      el.dimLabel.textContent = "No media selected";
      if (el.renderStatus) el.renderStatus.textContent = "";
      return;
    }

    const isVid = active.media_type === "video";
    if (el.videoScrubBar && el.videoScrubber) {
      el.videoScrubBar.style.display = isVid ? "flex" : "none";
      if (isVid) {
        const dur = Math.max(0.2, active.duration || 10);
        el.videoScrubber.max = dur.toFixed(1);
        el.videoScrubber.value = Math.min(state.videoFrameSec, dur).toFixed(1);
        if (el.videoTimeLabel) el.videoTimeLabel.textContent = `${Number(el.videoScrubber.value).toFixed(1)}s`;
      }
    }

    el.dimLabel.textContent = `${active.filename} (${active.width}×${active.height})`;
    if (el.renderStatus) el.renderStatus.textContent = "Rendering grade…";
    const reqId = ++state.previewReqId;

    try {
      if (state.previewAbortController) state.previewAbortController.abort();
      state.previewAbortController = new AbortController();
      const payload = {
        file_id: active.id,
        config: state.config,
        session_id: window.STUDIO_TAB_SESSION_ID || null,
      };
      if (isVid) payload.frame_sec = state.videoFrameSec;

      const res = await fetch("/api/color/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: state.previewAbortController.signal,
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (reqId !== state.previewReqId) return;
      if (!res.ok) {
        if (el.renderStatus) el.renderStatus.textContent = data.detail || "Preview failed";
        return;
      }
      el.beforeImg.src = data.before_url;
      el.afterImg.src = data.after_url;
      clearCssFeedback();
      el.compareWrap.style.display = "inline-block";
      el.emptyStage.style.display = "none";
      if (el.renderStatus) el.renderStatus.textContent = "Live 3D LUT";
      applySplitClip();
    } catch (err) {
      if (err.name === "AbortError" || reqId !== state.previewReqId) return;
      if (el.renderStatus) el.renderStatus.textContent = "Preview error";
    }
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
    if (!res.ok) {
      el.jobText.textContent = data.detail || "Could not start color grading job.";
      return;
    }
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
