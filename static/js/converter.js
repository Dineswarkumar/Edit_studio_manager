(() => {
  const state = { files: [], selected: new Set(), capabilities: null, working: false, lastResultsKey: "" };
  const el = {
    input: document.getElementById("converterFileInput"), dropzone: document.getElementById("converterDropzone"),
    queue: document.getElementById("converterQueue"), notices: document.getElementById("converterNotices"),
    count: document.getElementById("converterFileCount"), convert: document.getElementById("btnConvertSelected"),
    combine: document.getElementById("btnCombineImages"), zip: document.getElementById("btnZipSelected"),
    results: document.getElementById("converterResults"), title: document.getElementById("converterStatusTitle"),
    progress: document.getElementById("converterProgress"), fill: document.getElementById("converterProgressFill"),
    percent: document.getElementById("converterPercent"), bundle: document.getElementById("converterBundleLink"),
    layout: document.querySelector(".converter-layout"), filesPanel: document.querySelector(".converter-files-panel"),
    resizer: document.getElementById("converterResizer"),
    modal: document.getElementById("converterPreviewModal"), modalTitle: document.getElementById("converterModalTitle"),
    modalDownload: document.getElementById("converterModalDownload"), modalClose: document.getElementById("converterModalClose"),
    modalBody: document.getElementById("converterModalBody"),
  };

  const labelForTarget = (target) => ({ jpg: "JPG", png: "PNG", webp: "WebP", bmp: "BMP", tiff: "TIFF", gif: "GIF", pdf: "PDF", docx: "Word (DOCX)", mp4: "MP4", mov: "MOV", mkv: "MKV", webm: "WebM", avi: "AVI", mp3: "MP3", wav: "WAV", aac: "AAC", m4a: "M4A", flac: "FLAC", ogg: "OGG", zip: "Extract as ZIP" }[target] || target.toUpperCase());
  const formatBytes = (value) => {
    if (!value) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const rank = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
    return `${(value / Math.pow(1024, rank)).toFixed(rank ? 1 : 0)} ${units[rank]}`;
  };

  function notice(message, error = false) {
    const row = document.createElement("div");
    row.className = "converter-notice";
    if (error) row.style.borderColor = "var(--accent-rose)";
    row.textContent = message;
    el.notices.appendChild(row);
  }

  function init() {
    el.dropzone.addEventListener("click", (event) => { if (event.target !== el.input) el.input.click(); });
    el.dropzone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); el.input.click(); }
    });
    el.input.addEventListener("change", (event) => { uploadFiles(event.target.files); event.target.value = ""; });
    el.dropzone.addEventListener("dragover", (event) => { event.preventDefault(); el.dropzone.classList.add("dragover"); });
    el.dropzone.addEventListener("dragleave", () => el.dropzone.classList.remove("dragover"));
    el.dropzone.addEventListener("drop", (event) => {
      event.preventDefault(); el.dropzone.classList.remove("dragover");
      if (event.dataTransfer.files.length) uploadFiles(event.dataTransfer.files);
    });
    el.convert.addEventListener("click", () => runAction("convert"));
    el.combine.addEventListener("click", () => runAction("combine"));
    el.zip.addEventListener("click", () => runAction("zip"));
    if (el.modalClose) el.modalClose.addEventListener("click", closePreviewModal);
    if (el.modal) el.modal.addEventListener("click", (event) => { if (event.target === el.modal) closePreviewModal(); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && el.modal?.classList.contains("open")) closePreviewModal(); });
    initResizer();
    loadCapabilities();
  }

  function initResizer() {
    if (!el.layout || !el.filesPanel || !el.resizer) return;
    const stacked = () => window.matchMedia("(max-width:760px)").matches;
    const readSaved = (key) => {
      try { const value = Number(localStorage.getItem(key)); return Number.isFinite(value) && value > 0 ? value : null; }
      catch (_) { return null; }
    };
    const savedWidth = readSaved("converter-files-width");
    const savedHeight = readSaved("converter-files-height");
    if (savedWidth) el.layout.style.setProperty("--converter-files-width", `${savedWidth}px`);
    if (savedHeight) el.layout.style.setProperty("--converter-files-height", `${savedHeight}px`);

    const updateAria = () => {
      const vertical = !stacked();
      el.resizer.setAttribute("aria-orientation", vertical ? "vertical" : "horizontal");
      el.resizer.setAttribute("aria-valuemin", vertical ? "250" : "280");
      el.resizer.setAttribute("aria-valuemax", String(vertical ? maxWidth() : maxHeight()));
      const value = vertical ? el.filesPanel.getBoundingClientRect().width : el.filesPanel.getBoundingClientRect().height;
      el.resizer.setAttribute("aria-valuenow", String(Math.round(value)));
      el.resizer.setAttribute("aria-valuetext", `${Math.round(value)} pixels`);
    };
    const maxWidth = () => Math.max(250, el.layout.clientWidth - 20 - 14 - 8 - 280);
    const maxHeight = () => Math.max(280, window.innerHeight - 58 - 20 - 14 - 280);
    const apply = (coordinate) => {
      if (stacked()) {
        const size = Math.max(280, Math.min(maxHeight(), Math.round(coordinate - el.layout.getBoundingClientRect().top - 10)));
        el.layout.style.setProperty("--converter-files-height", `${size}px`);
        try { localStorage.setItem("converter-files-height", String(size)); } catch (_) {}
      } else {
        const size = Math.max(250, Math.min(maxWidth(), Math.round(coordinate - el.layout.getBoundingClientRect().left - 10)));
        el.layout.style.setProperty("--converter-files-width", `${size}px`);
        try { localStorage.setItem("converter-files-width", String(size)); } catch (_) {}
      }
      updateAria();
    };

    el.resizer.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      el.resizer.setPointerCapture(event.pointerId);
      el.resizer.classList.add("dragging");
      document.body.classList.add("workspace-resizing");
      const move = (pointerEvent) => apply(stacked() ? pointerEvent.clientY : pointerEvent.clientX);
      const finish = () => {
        el.resizer.classList.remove("dragging");
        document.body.classList.remove("workspace-resizing");
        el.resizer.removeEventListener("pointermove", move);
        el.resizer.removeEventListener("pointerup", finish);
        el.resizer.removeEventListener("pointercancel", finish);
        updateAria();
      };
      el.resizer.addEventListener("pointermove", move);
      el.resizer.addEventListener("pointerup", finish);
      el.resizer.addEventListener("pointercancel", finish);
    });
    el.resizer.addEventListener("keydown", (event) => {
      const vertical = !stacked();
      const relevant = vertical ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
      if (!relevant.includes(event.key) && !["Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const current = vertical ? el.filesPanel.getBoundingClientRect().width : el.filesPanel.getBoundingClientRect().height;
      const delta = event.shiftKey ? 40 : 12;
      const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
      const min = vertical ? 250 : 280;
      const max = vertical ? maxWidth() : maxHeight();
      const value = event.key === "Home" ? min : event.key === "End" ? max : current + direction * delta;
      if (vertical) {
        el.layout.style.setProperty("--converter-files-width", `${Math.max(min, Math.min(max, value))}px`);
        try { localStorage.setItem("converter-files-width", String(value)); } catch (_) {}
      } else {
        el.layout.style.setProperty("--converter-files-height", `${Math.max(min, Math.min(max, value))}px`);
        try { localStorage.setItem("converter-files-height", String(value)); } catch (_) {}
      }
      updateAria();
    });
    window.addEventListener("resize", updateAria);
    updateAria();
  }

  async function loadCapabilities() {
    try {
      const response = await fetch("/api/converter/capabilities");
      if (!response.ok) throw new Error("Could not check available converters.");
      state.capabilities = await response.json();
      ["media", "office", "archives"].forEach((key) => {
        if (state.capabilities.notes[key]) notice(state.capabilities.notes[key]);
      });
      renderQueue();
    } catch (error) { notice(error.message, true); }
  }

  async function uploadFiles(fileList) {
    if (!fileList || !fileList.length) return;
    const data = new FormData();
    Array.from(fileList).forEach((file) => data.append("files", file));
    if (window.STUDIO_TAB_SESSION_ID) data.append("session_id", window.STUDIO_TAB_SESSION_ID);
    el.title.textContent = "Adding files…";
    try {
      const response = await fetch("/api/converter/upload", { method: "POST", body: data });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || "Could not upload those files.");
      (result.media || []).forEach((file) => { state.files.push(file); state.selected.add(file.id); });
      (result.rejected || []).forEach((file) => notice(`${file.filename}: ${file.error}`, true));
      renderQueue();
      el.title.textContent = state.files.length ? "Ready" : "No supported files added";
    } catch (error) {
      notice(error.message, true);
      el.title.textContent = "Could not add files";
    }
  }

  function renderQueue() {
    el.queue.replaceChildren();
    if (!state.files.length) {
      const empty = document.createElement("div");
      empty.className = "converter-empty";
      empty.textContent = "Add files to see the formats available on this computer.";
      el.queue.appendChild(empty);
    }
    state.files.forEach((file) => {
      const row = document.createElement("div");
      row.className = "converter-file";
      const check = document.createElement("input");
      check.type = "checkbox"; check.checked = state.selected.has(file.id); check.setAttribute("aria-label", `Select ${file.filename}`);
      check.addEventListener("change", () => { check.checked ? state.selected.add(file.id) : state.selected.delete(file.id); syncButtons(); });
      const copy = document.createElement("div"); copy.style.minWidth = "0";
      const filename = document.createElement("div"); filename.className = "converter-file-name"; filename.title = file.filename; filename.textContent = file.filename;
      const metadata = document.createElement("div"); metadata.className = "converter-file-meta"; metadata.textContent = `${file.format_name} · ${formatBytes(file.size_bytes)}`;
      copy.append(filename, metadata);
      const select = document.createElement("select"); select.disabled = !file.targets || !file.targets.length || state.working;
      select.setAttribute("aria-label", `Convert ${file.filename} to`);
      const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = file.targets?.length ? "Choose output…" : "No conversion available"; select.appendChild(placeholder);
      (file.targets || []).forEach((target) => { const option = document.createElement("option"); option.value = target; option.textContent = labelForTarget(target); select.appendChild(option); });
      select.value = file.targets?.includes(file.target) ? file.target : "";
      file.target = select.value;
      select.addEventListener("change", () => { file.target = select.value; syncButtons(); });
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "converter-file-remove"; remove.title = "Remove file"; remove.setAttribute("aria-label", `Remove ${file.filename}`); remove.textContent = "×";
      remove.disabled = state.working;
      remove.addEventListener("click", async () => {
        state.files = state.files.filter((item) => item.id !== file.id); state.selected.delete(file.id); renderQueue();
        try { await fetch(`/api/media/${encodeURIComponent(file.id)}`, { method: "DELETE" }); } catch (_) { /* Session cleanup removes it later. */ }
      });
      row.append(check, copy, select, remove);
      el.queue.appendChild(row);
    });
    el.count.textContent = `${state.files.length} ${state.files.length === 1 ? "file" : "files"}`;
    syncButtons();
  }

  function syncButtons() {
    const selected = state.files.filter((file) => state.selected.has(file.id));
    const withTarget = selected.filter((file) => file.target);
    el.convert.disabled = state.working || withTarget.length === 0;
    el.zip.disabled = state.working || selected.length === 0;
    el.combine.disabled = state.working || selected.filter((file) => file.media_type === "image").length === 0;
    el.convert.textContent = withTarget.length ? `Convert selected (${withTarget.length})` : "Convert selected";
  }

  async function runAction(action) {
    if (state.working) return;
    const selected = state.files.filter((file) => state.selected.has(file.id));
    const request = { conversions: [], combine_image_ids: [], zip_file_ids: [], session_id: window.STUDIO_TAB_SESSION_ID || null };
    if (action === "convert") {
      request.conversions = selected.filter((file) => file.target).map((file) => ({ file_id: file.id, target: file.target }));
      if (!request.conversions.length) { notice("Choose an output format for at least one selected file.", true); return; }
    } else if (action === "combine") {
      request.combine_image_ids = selected.filter((file) => file.media_type === "image").map((file) => file.id);
      if (!request.combine_image_ids.length) return;
    } else {
      request.zip_file_ids = selected.map((file) => file.id);
    }
    state.working = true; state.lastResultsKey = ""; renderQueue();
    el.results.replaceChildren(); el.bundle.style.display = "none"; el.progress.style.display = "block";
    el.fill.style.width = "0%"; el.percent.textContent = "0%"; el.title.textContent = "Starting…";
    try {
      const response = await fetch("/api/converter/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Could not start conversion.");
      await pollJob(data.job_id);
    } catch (error) {
      notice(error.message, true); el.title.textContent = "Conversion could not start";
      state.working = false; renderQueue();
    }
  }

  async function pollJob(jobId) {
    while (true) {
      const response = await fetch(`/api/converter/jobs/${encodeURIComponent(jobId)}`);
      const job = await response.json();
      if (!response.ok) throw new Error(job.detail || "Could not read conversion progress.");
      const percent = Math.max(0, Math.min(100, Math.round((job.progress || 0) * 100)));
      el.fill.style.width = `${percent}%`; el.percent.textContent = `${percent}%`;
      el.title.textContent = job.status === "processing" ? "Converting…" : (job.status === "completed" ? "Finished" : "Conversion failed");
      renderResults(job.items || []);
      if (job.status !== "processing") {
        if (job.zip_download_url) { el.bundle.href = job.zip_download_url; el.bundle.download = "converted-files.zip"; el.bundle.style.display = "inline-flex"; }
        if (job.status === "failed" && job.error) notice(job.error, true);
        state.working = false; renderQueue();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
  }

  function closePreviewModal() {
    if (!el.modal) return;
    el.modalBody.querySelectorAll("video, audio").forEach((media) => { try { media.pause(); } catch (_) {} });
    el.modal.classList.remove("open");
    el.modalBody.replaceChildren();
  }

  function createVideoElement(item) {
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    let triedFallback = false;
    video.src = item.preview_url;
    video.addEventListener("error", () => {
      if (!triedFallback && item.output_filename) {
        triedFallback = true;
        video.src = `/api/converter/preview-video/${encodeURIComponent(item.output_filename)}`;
      }
    });
    return video;
  }

  async function renderStructuredPreview(container, item) {
    const loading = document.createElement("div");
    loading.className = "converter-empty";
    loading.textContent = "Loading preview…";
    container.replaceChildren(loading);
    try {
      const res = await fetch(`/api/converter/preview/${encodeURIComponent(item.output_filename)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Could not load preview.");
      container.replaceChildren();
      if (data.type === "zip") {
        const entries = data.entries || [];
        if (!entries.length) {
          const empty = document.createElement("div"); empty.className = "converter-empty"; empty.textContent = "This ZIP archive is empty."; container.appendChild(empty); return;
        }
        const imageEntries = entries.filter((entry) => entry.is_image && entry.preview_url);
        if (imageEntries.length) {
          const grid = document.createElement("div"); grid.className = "converter-zip-grid";
          imageEntries.forEach((entry) => {
            const card = document.createElement("div"); card.className = "converter-zip-thumb";
            const img = document.createElement("img"); img.src = entry.preview_url; img.alt = entry.name; img.loading = "lazy";
            const caption = document.createElement("span"); caption.textContent = `${entry.name} (${formatBytes(entry.size)})`; caption.style.wordBreak = "break-word";
            card.append(img, caption);
            grid.appendChild(card);
          });
          container.appendChild(grid);
        }
        const otherEntries = entries.filter((entry) => !entry.is_image);
        if (otherEntries.length) {
          const list = document.createElement("ul"); list.className = "converter-zip-list";
          otherEntries.forEach((entry) => {
            const li = document.createElement("li");
            const n = document.createElement("span"); n.textContent = entry.name; n.style.wordBreak = "break-word";
            const s = document.createElement("span"); s.textContent = formatBytes(entry.size); s.style.color = "var(--text-muted)";
            li.append(n, s); list.appendChild(li);
          });
          container.appendChild(list);
        }
      } else if (data.type === "docx") {
        const box = document.createElement("div"); box.className = "converter-docx-preview";
        box.textContent = (data.paragraphs && data.paragraphs.length) ? data.paragraphs.join("\n\n") : "(Empty Word document)";
        container.appendChild(box);
      }
    } catch (error) {
      const err = document.createElement("div"); err.className = "converter-empty"; err.textContent = error.message; container.replaceChildren(err);
    }
  }

  function openPreviewModal(item) {
    if (!el.modal || !item.preview_url) return;
    el.modalTitle.textContent = item.display_filename || item.filename || "Preview";
    el.modalDownload.href = item.download_url || "#";
    el.modalDownload.download = item.display_filename || "converted-file";
    el.modalBody.replaceChildren();
    const kind = item.preview_type || "other";
    if (kind === "image") {
      const img = document.createElement("img"); img.src = item.preview_url; img.alt = item.display_filename || "Converted image";
      el.modalBody.appendChild(img);
    } else if (kind === "video") {
      el.modalBody.appendChild(createVideoElement(item));
    } else if (kind === "audio") {
      const audio = document.createElement("audio"); audio.controls = true; audio.preload = "metadata"; audio.src = item.preview_url;
      el.modalBody.appendChild(audio);
    } else if (kind === "pdf") {
      const frame = document.createElement("iframe"); frame.src = item.preview_url; frame.title = item.display_filename || "PDF preview";
      el.modalBody.appendChild(frame);
    } else if (kind === "zip" || kind === "docx") {
      renderStructuredPreview(el.modalBody, item);
    } else {
      const msg = document.createElement("div"); msg.className = "converter-empty"; msg.textContent = "Preview is not available for this file type. Use Download to open it locally.";
      el.modalBody.appendChild(msg);
    }
    el.modal.classList.add("open");
  }

  function buildInlinePreview(item) {
    const kind = item.preview_type || "other";
    if (!item.preview_url || !["image", "video", "audio", "pdf"].includes(kind)) return null;
    const wrap = document.createElement("div"); wrap.className = "converter-inline-preview";
    if (kind === "image") {
      const img = document.createElement("img");
      img.src = item.preview_url; img.alt = item.display_filename || "Converted image"; img.loading = "lazy";
      img.addEventListener("click", () => openPreviewModal(item));
      wrap.appendChild(img);
    } else if (kind === "video") {
      wrap.appendChild(createVideoElement(item));
    } else if (kind === "audio") {
      const audio = document.createElement("audio"); audio.controls = true; audio.preload = "metadata"; audio.src = item.preview_url;
      wrap.appendChild(audio);
    } else if (kind === "pdf") {
      const frame = document.createElement("iframe"); frame.src = item.preview_url; frame.title = item.display_filename || "PDF preview";
      wrap.appendChild(frame);
    }
    return wrap;
  }

  function renderResults(items) {
    const key = items.map((item) => `${item.output_filename || item.filename}:${item.status}`).join("|");
    if (key === state.lastResultsKey && items.length) return;
    state.lastResultsKey = key;
    el.results.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("div"); empty.className = "converter-empty"; empty.textContent = "Preparing the first file…"; el.results.appendChild(empty); return;
    }
    items.forEach((item) => {
      const row = document.createElement("div"); row.className = `converter-result${item.status === "failed" ? " failed" : ""}`;
      const head = document.createElement("div"); head.className = "converter-result-head";
      const text = document.createElement("div"); text.style.minWidth = "0";
      const name = document.createElement("strong"); name.textContent = item.display_filename || item.filename || "File"; name.style.wordBreak = "break-word";
      const detail = document.createElement("small"); detail.textContent = item.status === "failed" ? (item.error || "Conversion failed") : `${item.status === "completed" ? formatBytes(item.output_size_bytes) : "Working…"}${item.filename && item.display_filename ? ` · from ${item.filename}` : ""}`;
      text.append(name, detail); head.appendChild(text);
      if (item.download_url && item.status === "completed") {
        const actions = document.createElement("div"); actions.className = "converter-result-actions";
        if (item.preview_url && item.preview_type !== "other") {
          const previewBtn = document.createElement("button");
          previewBtn.type = "button"; previewBtn.className = "btn-secondary";
          previewBtn.textContent = ["video", "audio"].includes(item.preview_type) ? "Expand" : "Preview";
          previewBtn.style.cssText = "padding:6px 9px;font-size:10px";
          previewBtn.addEventListener("click", () => openPreviewModal(item));
          actions.appendChild(previewBtn);
        }
        const link = document.createElement("a"); link.className = "btn-secondary"; link.href = item.download_url;
        link.download = item.display_filename || "converted-file";
        link.textContent = "Download"; link.style.cssText = "padding:6px 9px;text-decoration:none;font-size:10px";
        actions.appendChild(link);
        head.appendChild(actions);
      }
      row.appendChild(head);
      if (item.status === "completed") {
        const inlinePreview = buildInlinePreview(item);
        if (inlinePreview) row.appendChild(inlinePreview);
      }
      el.results.appendChild(row);
    });
  }

  init();
})();
