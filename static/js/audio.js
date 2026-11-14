// Audio Booster & Normalizer Frontend Logic
(function () {
  const state = {
    mediaList: [],
    selectedIds: new Set(),
    activeMediaId: null,
    activeJobId: null,
    config: {
      gain_db: 0.0,
      normalize_target_lufs: -14.0,
      true_peak_db: -1.5,
      highpass_hz: 0,
      voice_clarity: false,
      noise_reduce: false,
      limiter_enabled: true,
      output_format: "original",
      bitrate_kbps: 192,
    },
  };

  const el = {
    dropzone: document.getElementById("audioDropzone"),
    fileInput: document.getElementById("audioFileInput"),
    mediaCount: document.getElementById("audioMediaCount"),
    selectAll: document.getElementById("audioSelectAll"),
    clearBtn: document.getElementById("btnAudioClear"),
    mediaList: document.getElementById("audioMediaList"),
    selectedBadge: document.getElementById("audioSelectedBadge"),
    processBtn: document.getElementById("btnProcessAudioBatch"),
    activeTitle: document.getElementById("audioActiveTitle"),
    emptyStage: document.getElementById("audioEmptyStage"),
    inspectorCard: document.getElementById("audioInspectorCard"),
    statLufs: document.getElementById("statLufs"),
    statPeak: document.getElementById("statPeak"),
    statFormat: document.getElementById("statFormat"),
    audioPlayer: document.getElementById("audioPlayerEl"),
    videoPlayer: document.getElementById("videoAudioPlayerEl"),
    selectTargetLufs: document.getElementById("selectTargetLufs"),
    sliderGainDb: document.getElementById("sliderGainDb"),
    valGainDb: document.getElementById("valGainDb"),
    selectHighpass: document.getElementById("selectHighpass"),
    chkVoiceClarity: document.getElementById("chkVoiceClarity"),
    chkNoiseReduce: document.getElementById("chkNoiseReduce"),
    chkLimiter: document.getElementById("chkLimiter"),
    selectAudioFmt: document.getElementById("selectAudioFmt"),
    selectAudioBitrate: document.getElementById("selectAudioBitrate"),
    modal: document.getElementById("audioProgressModal"),
    btnCloseModal: document.getElementById("btnCloseAudioModal"),
    jobText: document.getElementById("audioJobText"),
    jobFill: document.getElementById("audioJobFill"),
    jobItems: document.getElementById("audioJobItems"),
    btnZip: document.getElementById("btnAudioDownloadZip"),
  };

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]));
  }

  function init() {
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
      inspectActiveMedia();
    });

    document.querySelectorAll(".audio-preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".audio-preset-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        applyPreset(btn.dataset.preset);
      });
    });

    el.selectTargetLufs.addEventListener("change", (e) => {
      state.config.normalize_target_lufs = e.target.value === "none" ? null : parseFloat(e.target.value);
    });
    el.sliderGainDb.addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      state.config.gain_db = val;
      el.valGainDb.textContent = `${val >= 0 ? "+" : ""}${val.toFixed(1)} dB`;
    });
    el.selectHighpass.addEventListener("change", (e) => { state.config.highpass_hz = parseInt(e.target.value, 10) || 0; });
    el.chkVoiceClarity.addEventListener("change", (e) => { state.config.voice_clarity = e.target.checked; });
    el.chkNoiseReduce.addEventListener("change", (e) => { state.config.noise_reduce = e.target.checked; });
    el.chkLimiter.addEventListener("change", (e) => { state.config.limiter_enabled = e.target.checked; });
    el.selectAudioFmt.addEventListener("change", (e) => { state.config.output_format = e.target.value; });
    el.selectAudioBitrate.addEventListener("change", (e) => { state.config.bitrate_kbps = parseInt(e.target.value, 10) || 192; });

    el.processBtn.addEventListener("click", startAudioBatch);
    el.btnCloseModal.addEventListener("click", () => el.modal.classList.remove("open"));
  }

  function applyPreset(key) {
    if (key === "youtube") {
      Object.assign(state.config, { normalize_target_lufs: -14.0, gain_db: 0.0, highpass_hz: 0, voice_clarity: false, noise_reduce: false, limiter_enabled: true });
    } else if (key === "podcast") {
      Object.assign(state.config, { normalize_target_lufs: -16.0, gain_db: 2.0, highpass_hz: 80, voice_clarity: true, noise_reduce: false, limiter_enabled: true });
    } else if (key === "voice") {
      Object.assign(state.config, { normalize_target_lufs: -14.0, gain_db: 6.0, highpass_hz: 120, voice_clarity: true, noise_reduce: true, limiter_enabled: true });
    } else if (key === "broadcast") {
      Object.assign(state.config, { normalize_target_lufs: -23.0, gain_db: 0.0, highpass_hz: 80, voice_clarity: false, noise_reduce: false, limiter_enabled: true });
    }
    el.selectTargetLufs.value = state.config.normalize_target_lufs === null ? "none" : String(Math.round(state.config.normalize_target_lufs));
    el.sliderGainDb.value = state.config.gain_db;
    el.valGainDb.textContent = `${state.config.gain_db >= 0 ? "+" : ""}${state.config.gain_db.toFixed(1)} dB`;
    el.selectHighpass.value = String(state.config.highpass_hz);
    el.chkVoiceClarity.checked = state.config.voice_clarity;
    el.chkNoiseReduce.checked = state.config.noise_reduce;
    el.chkLimiter.checked = state.config.limiter_enabled;
  }

  async function uploadFiles(files) {
    const fd = new FormData();
    Array.from(files).forEach((f) => fd.append("files", f));
    if (window.STUDIO_TAB_SESSION_ID) fd.append("session_id", window.STUDIO_TAB_SESSION_ID);
    const res = await fetch("/api/upload-media", { method: "POST", body: fd });
    const data = await res.json();
    (data.media || []).forEach((m) => {
      if (m.media_type === "audio" || m.media_type === "video") {
        state.mediaList.push(m);
        state.selectedIds.add(m.id);
        if (!state.activeMediaId) state.activeMediaId = m.id;
      }
    });
    renderMediaList();
    syncCount();
    inspectActiveMedia();
  }

  function renderMediaList() {
    el.mediaCount.textContent = `${state.mediaList.length} files`;
    if (!state.mediaList.length) {
      el.mediaList.innerHTML = `<div style="text-align:center;color:var(--text-dim);padding:30px 10px;font-size:13px;">No audio/video clips queued.</div>`;
      return;
    }
    el.mediaList.innerHTML = "";
    state.mediaList.forEach((m) => {
      const card = document.createElement("div");
      card.className = `media-card ${m.id === state.activeMediaId ? "active" : ""}`;
      card.innerHTML = `
        <input type="checkbox" class="aud-chk" ${state.selectedIds.has(m.id) ? "checked" : ""}>
        <div class="media-thumb-wrapper" style="display:flex;align-items:center;justify-content:center;font-size:18px;background:var(--bg-card);">${m.media_type === "video" ? "🎬" : "🎵"}</div>
        <div class="media-info"><div class="media-filename">${escapeHtml(m.filename)}</div><div class="media-meta">${m.duration ? m.duration.toFixed(1) + "s · " : ""}${(m.size_bytes / (1024 * 1024)).toFixed(1)}MB</div></div>
      `;
      card.querySelector(".aud-chk").addEventListener("change", (ev) => {
        if (ev.target.checked) state.selectedIds.add(m.id);
        else state.selectedIds.delete(m.id);
        syncCount();
      });
      card.addEventListener("click", (ev) => {
        if (ev.target.classList.contains("aud-chk")) return;
        state.activeMediaId = m.id;
        renderMediaList();
        inspectActiveMedia();
      });
      el.mediaList.appendChild(card);
    });
  }

  function syncCount() {
    el.selectedBadge.textContent = state.selectedIds.size;
    el.processBtn.disabled = state.selectedIds.size === 0;
  }

  async function inspectActiveMedia() {
    const active = state.mediaList.find((m) => m.id === state.activeMediaId);
    if (!active) {
      el.emptyStage.style.display = "block";
      el.inspectorCard.style.display = "none";
      el.activeTitle.textContent = "No clip selected";
      el.audioPlayer.pause();
      el.videoPlayer.pause();
      return;
    }
    el.activeTitle.textContent = active.filename;
    el.emptyStage.style.display = "none";
    el.inspectorCard.style.display = "flex";
    el.statLufs.textContent = "Scanning…";
    el.statPeak.textContent = "…";
    el.statFormat.textContent = "…";

    const rawUrl = `/api/uploads/${encodeURIComponent(active.saved_filename)}`;
    const mediaUrl = window.resolveStudioUrl ? window.resolveStudioUrl(rawUrl) : rawUrl;
    if (active.media_type === "video") {
      el.audioPlayer.style.display = "none";
      el.audioPlayer.pause();
      el.videoPlayer.style.display = "block";
      el.videoPlayer.src = mediaUrl;
    } else {
      el.videoPlayer.style.display = "none";
      el.videoPlayer.pause();
      el.audioPlayer.style.display = "block";
      el.audioPlayer.src = mediaUrl;
    }

    const res = await fetch("/api/audio/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: active.id }),
    });
    const data = await res.json();
    const s = data.stats || {};
    el.statLufs.textContent = s.integrated_lufs !== null && s.integrated_lufs !== undefined ? `${s.integrated_lufs} LUFS` : "Silent / N/A";
    el.statPeak.textContent = s.true_peak_db !== null && s.true_peak_db !== undefined ? `${s.true_peak_db} dBTP` : "—";
    el.statFormat.textContent = `${(s.codec || "audio").toUpperCase()} · ${s.sample_rate ? Math.round(s.sample_rate / 1000) + "kHz" : "—"}`;
  }

  async function startAudioBatch() {
    const ids = Array.from(state.selectedIds);
    if (!ids.length) return;
    el.modal.classList.add("open");
    el.btnZip.style.display = "none";
    el.jobFill.style.width = "0%";
    el.jobText.textContent = `Processing ${ids.length} clip(s)…`;
    el.jobItems.innerHTML = "";

    const res = await fetch("/api/audio/process", {
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
    pollAudioJob();
  }

  async function pollAudioJob() {
    if (!state.activeJobId) return;
    const res = await fetch(`/api/job/${state.activeJobId}`);
    const job = await res.json();
    const pct = Math.round((job.progress || 0) * 100);
    el.jobFill.style.width = `${pct}%`;
    el.jobItems.innerHTML = "";
    (job.items || []).forEach((it) => {
      const row = document.createElement("div");
      row.className = "job-item-row";
      const statsLabel = it.status === "completed" && it.output_lufs !== null
        ? `<small style="color:var(--text-dim);margin-left:6px;">(${it.input_lufs ?? "?"} → ${it.output_lufs} LUFS, Peak ${it.true_peak_db ?? "?"} dBTP)</small>`
        : "";
      row.innerHTML = `
        <span style="font-size:12px;">${escapeHtml(it.filename)}${statsLabel}</span>
        ${it.status === "completed"
          ? `<a href="${it.download_url}" download class="btn-secondary" style="padding:4px 10px;font-size:11px;text-decoration:none;">Download</a>`
          : `<span style="font-size:11px;color:${it.status === "failed" ? "var(--accent-rose)" : "var(--text-dim)"};">${it.status === "failed" ? escapeHtml(it.error) : "Normalizing…"}</span>`}
      `;
      el.jobItems.appendChild(row);
    });
    if (job.status === "completed") {
      el.jobText.textContent = "Audio boost & normalization complete!";
      el.btnZip.href = `/api/download-zip/${state.activeJobId}`;
      el.btnZip.style.display = "inline-flex";
    } else if (job.status === "failed") {
      el.jobText.textContent = job.error || "Audio processing failed.";
    } else {
      el.jobText.textContent = `Normalizing audio (${pct}%)…`;
      setTimeout(pollAudioJob, 700);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
