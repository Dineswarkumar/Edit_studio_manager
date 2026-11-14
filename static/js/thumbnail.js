// Thumbnail Studio Pro - Client Interactivity Engine
(function() {
  // Studio State
  const state = {
    activeMedia: null,
    candidateFrames: [],
    storyboardFrames: [],
    storyboardEdit: null,
    draggedStoryboardIndex: null,
    draggedCandidateFilename: null,
    videoObjectUrl: null,
    pendingVideoSeek: null,
    progressHideTimer: null,
    candidateUserSelected: false,
    storyboardWasEdited: false,
    activeBaseFilename: null,
    aspectRatio: "16:9",
    fitMode: "fill",
    resolutionScale: 2,
    gridRows: 3,
    gridCols: 3,
    startSec: 0.0,
    endSec: null,

    // Typography
    text: "MUST WATCH!",
    fontFamily: "Impact",
    fontSize: 90,
    textColor: "#ffee00",
    strokeColor: "#000000",
    strokeWidth: 8,
    tiltAngle: -3,
    dropShadow: true,
    badgeEnabled: false,
    badgeColor: "#ff0000",
    badgeOpacity: 0.85,
    textPos: { x: 0.5, y: 0.8 },

    // Cutout / Sticker Overlay
    stickerFilename: null,
    stickerPreviewUrl: null,
    stickerScale: 25,
    stickerPos: { x: 0.82, y: 0.5 },
    stickerRotation: 0,
    stickerOpacity: 1.0,

    // Visual Enhancements
    saturation: 1.25,
    contrast: 1.15,
    vignette: 35,

    // Export
    exportFormat: "jpg",
    exportScope: "current",
    isBatchMode: false,
    isExporting: false,
    previewTimeout: null,
    previewAbortController: null,
    scanAbortController: null,
    activeDragTarget: null, // "text" or "sticker"
  };

  // Resolution Map for 6 Aspect Ratios
  const RESOLUTION_MAP = {
    "16:9": { label: "16:9 (YouTube)", w: 1920, h: 1080, cssAspect: "16 / 9" },
    "9:16": { label: "9:16 (Reels/Shorts)", w: 1080, h: 1920, cssAspect: "9 / 16" },
    "1:1":  { label: "1:1 (Square Feed)", w: 1080, h: 1080, cssAspect: "1 / 1" },
    "4:5":  { label: "4:5 (Instagram)", w: 1080, h: 1350, cssAspect: "4 / 5" },
    "3:4":  { label: "3:4 (Pinterest/Display)", w: 1080, h: 1440, cssAspect: "3 / 4" },
    "4:3":  { label: "4:3 (Classic)", w: 1440, h: 1080, cssAspect: "4 / 3" }
  };

  // DOM Elements Cache
  const el = {};

  function initStudio() {
    initElements();
    initEventListeners();
    initCanvasDragging();
    updateRatioUI();
    syncExportAvailability();
    window.addEventListener("beforeunload", () => {
      if (state.videoObjectUrl) URL.revokeObjectURL(state.videoObjectUrl);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initStudio);
  } else {
    initStudio();
  }

  function initElements() {
    el.thumbDropzone = document.getElementById("thumbDropzone");
    el.thumbFileInput = document.getElementById("thumbFileInput");
    el.frameHunterPanel = document.getElementById("frameHunterPanel");
    el.videoDurationBadge = document.getElementById("videoDurationBadge");
    el.gridInfoBadge = document.getElementById("gridInfoBadge");
    el.gridSizeBtns = document.querySelectorAll(".grid-size-btn");
    el.customGridRows = document.getElementById("customGridRows");
    el.customGridCols = document.getElementById("customGridCols");
    el.btnApplyCustomGrid = document.getElementById("btnApplyCustomGrid");
    el.inputStartSec = document.getElementById("inputStartSec");
    el.inputEndSec = document.getElementById("inputEndSec");
    el.intervalRangeLabel = document.getElementById("intervalRangeLabel");
    el.btnRescanFrames = document.getElementById("btnRescanFrames");
    el.fineScrubber = document.getElementById("fineScrubber");
    el.scrubberTimeText = document.getElementById("scrubberTimeText");
    el.btnCaptureScrubberFrame = document.getElementById("btnCaptureScrubberFrame");
    el.btnMakeStoryboard = document.getElementById("btnMakeStoryboard");
    el.storyboardBorderPx = document.getElementById("storyboardBorderPx");
    el.valStoryboardGap = document.getElementById("valStoryboardGap");
    el.candidatesGallery = document.getElementById("candidatesGallery");
    el.candidatesCountText = document.getElementById("candidatesCountText");
    el.mediaProgressWrap = document.getElementById("mediaProgressWrap");
    el.mediaProgressLabel = document.getElementById("mediaProgressLabel");
    el.mediaProgressValue = document.getElementById("mediaProgressValue");
    el.mediaProgressFill = document.getElementById("mediaProgressFill");
    el.storyboardGallery = document.getElementById("storyboardGallery");
    el.storyboardFramesCount = document.getElementById("storyboardFramesCount");
    el.storyboardEditPrompt = document.getElementById("storyboardEditPrompt");
    el.storyboardEditPromptText = document.getElementById("storyboardEditPromptText");
    el.btnCancelStoryboardEdit = document.getElementById("btnCancelStoryboardEdit");
    el.sourceVideoWrap = document.getElementById("sourceVideoWrap");
    el.sourceVideo = document.getElementById("sourceVideo");
    el.videoLoadStatus = document.getElementById("videoLoadStatus");
    el.videoLoadFill = document.getElementById("videoLoadFill");

    // Center Stage
    el.targetResolutionBadge = document.getElementById("targetResolutionBadge");
    el.thumbCanvasWrapper = document.getElementById("thumbCanvasWrapper");
    el.thumbPreviewImg = document.getElementById("thumbPreviewImg");
    el.thumbEmptyPrompt = document.getElementById("thumbEmptyPrompt");
    el.arBtns = document.querySelectorAll(".ar-btn");
    el.selectFitMode = document.getElementById("selectFitMode");
    el.selectResolutionScale = document.getElementById("selectResolutionScale");

    // Typography & Enhancements
    el.inputThumbText = document.getElementById("inputThumbText");
    el.btnResetTitlePos = document.getElementById("btnResetTitlePos");
    el.selectThumbFont = document.getElementById("selectThumbFont");
    el.sliderThumbFontSize = document.getElementById("sliderThumbFontSize");
    el.thumbFontSizeVal = document.getElementById("thumbFontSizeVal");
    el.pickerThumbColor = document.getElementById("pickerThumbColor");
    el.hexThumbColor = document.getElementById("hexThumbColor");
    el.sliderStrokeWidth = document.getElementById("sliderStrokeWidth");
    el.strokeWidthVal = document.getElementById("strokeWidthVal");
    el.pickerStrokeColor = document.getElementById("pickerStrokeColor");
    el.sliderThumbAngle = document.getElementById("sliderThumbAngle");
    el.thumbAngleVal = document.getElementById("thumbAngleVal");
    el.checkThumbShadow = document.getElementById("checkThumbShadow");
    el.checkThumbBadge = document.getElementById("checkThumbBadge");
    el.thumbBadgePanel = document.getElementById("thumbBadgePanel");
    el.pickerThumbBadgeColor = document.getElementById("pickerThumbBadgeColor");
    el.sliderThumbBadgeOpacity = document.getElementById("sliderThumbBadgeOpacity");

    // Sticker
    el.stickerFileInput = document.getElementById("stickerFileInput");
    el.btnUploadSticker = document.getElementById("btnUploadSticker");
    el.stickerThumbPreview = document.getElementById("stickerThumbPreview");
    el.stickerScaleControls = document.getElementById("stickerScaleControls");
    el.sliderStickerScale = document.getElementById("sliderStickerScale");
    el.stickerScaleVal = document.getElementById("stickerScaleVal");

    // Adjustments
    el.sliderSaturation = document.getElementById("sliderSaturation");
    el.satVal = document.getElementById("satVal");
    el.sliderContrast = document.getElementById("sliderContrast");
    el.contrastVal = document.getElementById("contrastVal");
    el.sliderVignette = document.getElementById("sliderVignette");
    el.vignetteVal = document.getElementById("vignetteVal");

    // Export Modal
    el.btnOpenExportModal = document.getElementById("btnOpenExportModal");
    el.thumbExportModal = document.getElementById("thumbExportModal");
    el.btnCloseThumbExportModal = document.getElementById("btnCloseThumbExportModal");
    el.btnCancelThumbExport = document.getElementById("btnCancelThumbExport");
    el.btnScopeCurrent = document.getElementById("btnScopeCurrent");
    el.btnScopeAll = document.getElementById("btnScopeAll");
    el.btnExportJpg = document.getElementById("btnExportJpg");
    el.btnExportPng = document.getElementById("btnExportPng");
    el.exportSelectionSummary = document.getElementById("exportSelectionSummary");
    el.thumbExportProgress = document.getElementById("thumbExportProgress");
    el.thumbExportProgressText = document.getElementById("thumbExportProgressText");
    el.exportRatioText = document.getElementById("exportRatioText");
    el.exportResultsArea = document.getElementById("exportResultsArea");
    el.btnDoExportThumb = document.getElementById("btnDoExportThumb");
  }

  function initEventListeners() {
    // Dropzone Upload
    el.thumbDropzone.addEventListener("click", () => {
      el.thumbFileInput.value = "";
      el.thumbFileInput.click();
    });
    el.thumbFileInput.addEventListener("click", (e) => {
      e.stopPropagation();
    });
    el.thumbFileInput.addEventListener("change", (e) => {
      if (e.target.files && e.target.files[0]) {
        handleUploadFile(e.target.files[0]);
      }
    });

    el.thumbDropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      el.thumbDropzone.style.borderColor = "var(--primary)";
      el.thumbDropzone.style.background = "var(--bg-surface-hover)";
    });

    el.thumbDropzone.addEventListener("dragleave", () => {
      el.thumbDropzone.style.borderColor = "";
      el.thumbDropzone.style.background = "";
    });

    el.thumbDropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      el.thumbDropzone.style.borderColor = "";
      el.thumbDropzone.style.background = "";
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleUploadFile(e.dataTransfer.files[0]);
      }
    });

    // Grid Size Presets
    el.gridSizeBtns.forEach(btn => {
      btn.addEventListener("click", () => {
        el.gridSizeBtns.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        setGridSize(parseInt(btn.dataset.rows, 10), parseInt(btn.dataset.cols, 10));
      });
    });

    el.btnApplyCustomGrid.addEventListener("click", () => {
      el.gridSizeBtns.forEach(b => b.classList.remove("active"));
      const rows = Math.max(1, Math.min(10, parseInt(el.customGridRows.value, 10) || 3));
      const cols = Math.max(1, Math.min(10, parseInt(el.customGridCols.value, 10) || 3));
      el.customGridRows.value = rows;
      el.customGridCols.value = cols;
      setGridSize(rows, cols);
    });

    // Rescan Frames Interval
    el.btnRescanFrames.addEventListener("click", () => {
      if (!state.activeMedia) return;
      const s = parseFloat(el.inputStartSec.value);
      const e = parseFloat(el.inputEndSec.value);
      state.startSec = isNaN(s) ? 0.0 : Math.max(0, s);
      state.endSec = isNaN(e) ? null : Math.max(state.startSec + 0.1, e);
      extractCandidates();
    });

    // Scrubber
    el.fineScrubber.addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      el.scrubberTimeText.textContent = formatTime(val);
      seekSourceVideo(val, false);
    });

    el.sourceVideo.addEventListener("timeupdate", () => {
      if (!state.activeMedia || state.activeMedia.media_type !== "video") return;
      const currentTime = el.sourceVideo.currentTime || 0;
      el.fineScrubber.value = currentTime;
      el.scrubberTimeText.textContent = formatTime(currentTime);
    });

    el.sourceVideo.addEventListener("loadedmetadata", () => {
      const duration = Number.isFinite(el.sourceVideo.duration) ? el.sourceVideo.duration : 0;
      if (duration > 0) {
        el.fineScrubber.max = duration;
        el.videoDurationBadge.textContent = `${duration.toFixed(1)}s · ${state.activeMedia.width}×${state.activeMedia.height}`;
      }
      el.videoLoadStatus.textContent = "Video ready · choose a frame to preview";
      el.videoLoadFill.style.width = "100%";
      applyPendingVideoSeek();
    });

    el.sourceVideo.addEventListener("loadstart", () => {
      el.videoLoadStatus.textContent = "Loading video preview…";
      el.videoLoadFill.style.width = "0%";
    });
    el.sourceVideo.addEventListener("progress", () => updateVideoBufferProgress());
    el.sourceVideo.addEventListener("stalled", () => {
      el.videoLoadStatus.textContent = "Video is taking a while to load · extracted frames are still available";
      updateVideoBufferProgress();
    });
    el.sourceVideo.addEventListener("error", () => {
      el.videoLoadStatus.textContent = "This video format cannot play in the browser · use extracted frames below";
    });
    el.sourceVideo.addEventListener("waiting", () => {
      el.videoLoadStatus.textContent = `Buffering at ${formatTime(el.sourceVideo.currentTime || 0)}…`;
      updateVideoBufferProgress();
    });
    el.sourceVideo.addEventListener("canplay", () => {
      el.videoLoadStatus.textContent = "Video ready · choose a frame to preview";
      el.videoLoadFill.style.width = "100%";
    });
    el.sourceVideo.addEventListener("playing", () => {
      el.videoLoadStatus.textContent = `Playing · ${formatTime(el.sourceVideo.currentTime || 0)}`;
    });
    el.sourceVideo.addEventListener("pause", () => {
      if (el.sourceVideo.readyState >= 1) {
        el.videoLoadStatus.textContent = `Paused · ${formatTime(el.sourceVideo.currentTime || 0)}`;
      }
    });
    el.sourceVideo.addEventListener("seeked", () => {
      const currentTime = el.sourceVideo.currentTime || 0;
      el.fineScrubber.value = currentTime;
      el.scrubberTimeText.textContent = formatTime(currentTime);
    });

    el.btnCaptureScrubberFrame.addEventListener("click", () => {
      if (!state.activeMedia || state.activeMedia.media_type !== "video") return;
      captureExactFrame(parseFloat(el.fineScrubber.value));
    });

    // Storyboard Collage Background
    if (el.storyboardBorderPx) {
      el.storyboardBorderPx.addEventListener("input", () => {
        if (el.valStoryboardGap) el.valStoryboardGap.textContent = `${el.storyboardBorderPx.value}px`;
      });
    }
    el.btnMakeStoryboard.addEventListener("click", makeStoryboardBackground);
    el.btnCancelStoryboardEdit.addEventListener("click", () => {
      state.storyboardEdit = null;
      updateStoryboardEditPrompt();
      refreshCandidateAddButtons();
      renderStoryboardGallery();
    });
    el.storyboardGallery.addEventListener("dragover", (event) => event.preventDefault());
    el.storyboardGallery.addEventListener("drop", (event) => {
      event.preventDefault();
      if (event.target.closest(".storyboard-frame")) return;
      if (state.draggedCandidateFilename) {
        addFrameToStoryboard(state.draggedCandidateFilename);
        state.draggedCandidateFilename = null;
      }
    });

    // Aspect Ratio Switcher
    el.arBtns.forEach(btn => {
      btn.addEventListener("click", () => {
        el.arBtns.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        state.aspectRatio = btn.dataset.ar;
        updateRatioUI();
        schedulePreview();
      });
    });

    // Fit Mode
    el.selectFitMode.addEventListener("change", (e) => {
      state.fitMode = e.target.value;
      schedulePreview();
    });

    el.selectResolutionScale.addEventListener("change", (e) => {
      state.resolutionScale = parseInt(e.target.value, 10) === 1 ? 1 : 2;
      updateRatioUI();
      schedulePreview();
    });

    // Typography Controls
    el.inputThumbText.addEventListener("input", (e) => {
      state.text = e.target.value;
      schedulePreview();
    });

    el.btnResetTitlePos.addEventListener("click", () => {
      state.textPos = { x: 0.5, y: 0.8 };
      schedulePreview();
    });

    el.selectThumbFont.addEventListener("change", (e) => {
      state.fontFamily = e.target.value;
      schedulePreview();
    });

    el.sliderThumbFontSize.addEventListener("input", (e) => {
      state.fontSize = parseInt(e.target.value, 10);
      el.thumbFontSizeVal.textContent = `${state.fontSize}px`;
      schedulePreview();
    });

    el.pickerThumbColor.addEventListener("input", (e) => {
      state.textColor = e.target.value;
      el.hexThumbColor.textContent = state.textColor;
      schedulePreview();
    });

    el.sliderStrokeWidth.addEventListener("input", (e) => {
      state.strokeWidth = parseInt(e.target.value, 10);
      el.strokeWidthVal.textContent = `${state.strokeWidth}px`;
      schedulePreview();
    });

    el.pickerStrokeColor.addEventListener("input", (e) => {
      state.strokeColor = e.target.value;
      schedulePreview();
    });

    el.sliderThumbAngle.addEventListener("input", (e) => {
      state.tiltAngle = parseInt(e.target.value, 10);
      el.thumbAngleVal.textContent = `${state.tiltAngle}°`;
      schedulePreview();
    });

    el.checkThumbShadow.addEventListener("change", (e) => {
      state.dropShadow = e.target.checked;
      schedulePreview();
    });

    el.checkThumbBadge.addEventListener("change", (e) => {
      state.badgeEnabled = e.target.checked;
      el.thumbBadgePanel.style.display = state.badgeEnabled ? "flex" : "none";
      schedulePreview();
    });

    el.pickerThumbBadgeColor.addEventListener("input", (e) => {
      state.badgeColor = e.target.value;
      schedulePreview();
    });

    el.sliderThumbBadgeOpacity.addEventListener("input", (e) => {
      state.badgeOpacity = parseInt(e.target.value, 10) / 100.0;
      schedulePreview();
    });

    // Sticker / Cutout Upload
    el.btnUploadSticker.addEventListener("click", () => {
      el.stickerFileInput.value = "";
      el.stickerFileInput.click();
    });
    el.stickerFileInput.addEventListener("change", handleStickerUpload);

    el.sliderStickerScale.addEventListener("input", (e) => {
      state.stickerScale = parseInt(e.target.value, 10);
      el.stickerScaleVal.textContent = `${state.stickerScale}%`;
      schedulePreview();
    });

    // Enhancements / Pop
    el.sliderSaturation.addEventListener("input", (e) => {
      state.saturation = parseFloat(e.target.value);
      el.satVal.textContent = `${state.saturation.toFixed(2)}x`;
      schedulePreview();
    });

    el.sliderContrast.addEventListener("input", (e) => {
      state.contrast = parseFloat(e.target.value);
      el.contrastVal.textContent = `${state.contrast.toFixed(2)}x`;
      schedulePreview();
    });

    el.sliderVignette.addEventListener("input", (e) => {
      state.vignette = parseInt(e.target.value, 10);
      el.vignetteVal.textContent = `${state.vignette}%`;
      schedulePreview();
    });

    // Export Modal Controls
    el.btnOpenExportModal.addEventListener("click", openExportModal);
    el.btnCloseThumbExportModal.addEventListener("click", closeExportModal);
    el.btnCancelThumbExport.addEventListener("click", closeExportModal);

    if (el.btnScopeCurrent && el.btnScopeAll) {
      el.btnScopeCurrent.addEventListener("click", () => {
        el.btnScopeCurrent.classList.add("active");
        el.btnScopeAll.classList.remove("active");
        state.exportScope = "current";
        updateExportSummary();
      });
      el.btnScopeAll.addEventListener("click", () => {
        el.btnScopeAll.classList.add("active");
        el.btnScopeCurrent.classList.remove("active");
        state.exportScope = "all";
        updateExportSummary();
      });
    }

    el.btnExportJpg.addEventListener("click", () => {
      el.btnExportJpg.classList.add("active");
      el.btnExportPng.classList.remove("active");
      state.exportFormat = "jpg";
    });

    el.btnExportPng.addEventListener("click", () => {
      el.btnExportPng.classList.add("active");
      el.btnExportJpg.classList.remove("active");
      state.exportFormat = "png";
    });

    el.btnDoExportThumb.addEventListener("click", executeExport);
  }

  function setGridSize(rows, cols) {
    state.gridRows = rows;
    state.gridCols = cols;
    el.customGridRows.value = rows;
    el.customGridCols.value = cols;
    const count = rows * cols;
    el.gridInfoBadge.textContent = `${rows} × ${cols} (${count} Frames)`;
    if (state.activeMedia && state.activeMedia.media_type === "video") extractCandidates();
  }

  function setStudioProgress(label, percent = null) {
    if (state.progressHideTimer) clearTimeout(state.progressHideTimer);
    state.progressHideTimer = null;
    el.mediaProgressWrap.style.display = "flex";
    el.mediaProgressLabel.textContent = label;
    if (percent === null) {
      el.mediaProgressValue.textContent = "";
      el.mediaProgressFill.classList.add("indeterminate");
      el.mediaProgressFill.style.width = "35%";
      return;
    }
    const value = Math.max(0, Math.min(100, percent));
    el.mediaProgressValue.textContent = `${Math.round(value)}%`;
    el.mediaProgressFill.classList.remove("indeterminate");
    el.mediaProgressFill.style.width = `${value}%`;
  }

  function hideStudioProgress() {
    if (state.progressHideTimer) clearTimeout(state.progressHideTimer);
    state.progressHideTimer = null;
    el.mediaProgressWrap.style.display = "none";
    el.mediaProgressFill.classList.remove("indeterminate");
    el.mediaProgressFill.style.width = "0%";
  }

  function scheduleHideStudioProgress(delayMs) {
    if (state.progressHideTimer) clearTimeout(state.progressHideTimer);
    state.progressHideTimer = setTimeout(hideStudioProgress, delayMs);
  }

  function uploadMediaWithProgress(formData, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload-media");
      xhr.responseType = "json";
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
      });
      xhr.upload.addEventListener("load", () => onProgress(100));
      xhr.addEventListener("load", () => {
        const response = xhr.response || (xhr.responseText ? JSON.parse(xhr.responseText) : null);
        if (xhr.status >= 200 && xhr.status < 300) resolve(response);
        else reject(new Error(response?.detail || `Upload failed (${xhr.status})`));
      });
      xhr.addEventListener("error", () => reject(new Error("Network error while uploading media")));
      xhr.addEventListener("abort", () => reject(new Error("Upload was cancelled")));
      xhr.send(formData);
    });
  }

  // File Upload Handler
  async function handleUploadFile(file) {
    el.sourceVideo.pause();
    const formData = new FormData();
    formData.append("files", file);
    if (window.STUDIO_TAB_SESSION_ID) {
      formData.append("session_id", window.STUDIO_TAB_SESSION_ID);
    }

    el.thumbDropzone.querySelector(".dropzone-text").textContent = "Uploading & Analyzing...";
    setStudioProgress("Uploading media…", 0);

    try {
      const data = await uploadMediaWithProgress(formData, (percent) => {
        if (percent >= 100) {
          setStudioProgress("Upload complete · analyzing video and preparing its preview…", null);
        } else {
          setStudioProgress("Uploading media…", percent);
        }
      });
      if (!data.media || data.media.length === 0) throw new Error("No media returned");

      const item = data.media[0];
      state.activeMedia = item;

      if (state.videoObjectUrl) URL.revokeObjectURL(state.videoObjectUrl);
      state.videoObjectUrl = null;
      state.pendingVideoSeek = null;
      el.sourceVideo.pause();
      el.sourceVideo.removeAttribute("src");
      el.sourceVideo.load();

      el.thumbDropzone.querySelector(".dropzone-text").textContent = item.filename;
      el.thumbDropzone.querySelector(".dropzone-hint").textContent = `${item.width}×${item.height} · ${formatBytes(item.size_bytes)}`;

      if (item.media_type === "video") {
        el.frameHunterPanel.style.display = "flex";
        el.sourceVideoWrap.style.display = "block";
        el.videoLoadStatus.textContent = "Loading video preview…";
        el.videoLoadFill.style.width = "0%";
        state.videoObjectUrl = URL.createObjectURL(file);
        el.sourceVideo.src = state.videoObjectUrl;
        el.sourceVideo.load();
        el.videoDurationBadge.textContent = `${item.duration}s · ${item.width}×${item.height}`;
        el.fineScrubber.min = "0";
        el.fineScrubber.max = item.duration.toString();
        el.fineScrubber.value = "0";
        el.scrubberTimeText.textContent = "0:00.0";
        el.inputStartSec.value = "0";
        el.inputEndSec.value = item.duration.toString();
        state.startSec = 0;
        state.endSec = item.duration;

        await extractCandidates();
      } else {
        // Photo base
        el.frameHunterPanel.style.display = "none";
        el.sourceVideoWrap.style.display = "none";
        state.activeBaseFilename = item.saved_filename;
        syncExportAvailability();
        state.candidateFrames = [];
        state.storyboardFrames = [];
        schedulePreview();
        hideStudioProgress();
      }
    } catch (err) {
      alert("Upload failed: " + err.message);
      setStudioProgress("Upload failed · try selecting the file again", null);
      el.thumbDropzone.querySelector(".dropzone-text").textContent = "Drop Video or Photo";
    }
  }

  // Extract N Candidate Frames
  async function extractCandidates() {
    if (!state.activeMedia) return;
    el.btnRescanFrames.textContent = "⏳ Scanning Frames...";
    el.btnRescanFrames.disabled = true;
    state.candidateFrames = [];
    state.storyboardFrames = [];
    state.activeBaseFilename = null;
    syncExportAvailability();
    state.candidateUserSelected = false;
    state.storyboardWasEdited = false;
    state.storyboardEdit = null;
    updateStoryboardEditPrompt();
    renderCandidateGallery();
    setStudioProgress("Preparing frame scan…", null);

    try {
      if (state.scanAbortController) state.scanAbortController.abort();
      state.scanAbortController = new AbortController();
      const res = await fetch("/api/thumbnail/extract-candidates-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: state.scanAbortController.signal,
        body: JSON.stringify({
          file_id: state.activeMedia.id,
          count: state.gridRows * state.gridCols,
          start_sec: state.startSec,
          end_sec: state.endSec,
          session_id: window.STUDIO_TAB_SESSION_ID || null
        })
      });
      if (!res.ok) throw new Error("Candidate extraction failed");
      if (!res.body) throw new Error("This browser cannot show frame scan progress");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let scanFinished = false;

      const handleScanMessage = (message) => {
        if (message.type === "start") {
          setStudioProgress(`Extracting frames · 0 / ${message.total}`, 0);
          if (message.duration > 0) {
            el.fineScrubber.max = message.duration;
            el.inputEndSec.value = message.duration.toFixed(2);
          }
        } else if (message.type === "frame") {
          if (message.frame) {
            state.candidateFrames.push(message.frame);
            const candidateIndex = state.candidateFrames.length - 1;
            el.candidatesGallery.appendChild(createCandidateCard(message.frame, candidateIndex));
            if (!state.storyboardWasEdited && state.storyboardFrames.length < state.gridRows * state.gridCols) {
              state.storyboardFrames.push(message.frame);
              appendStoryboardCard(message.frame, state.storyboardFrames.length - 1);
            }
            updateStoryboardCount();
            refreshCandidateAddButtons();
            el.candidatesCountText.textContent = `${state.candidateFrames.length} shots · ${state.storyboardFrames.length} selected`;
          }
          const percent = message.total ? (message.completed / message.total) * 100 : 100;
          setStudioProgress(`Extracting frames · ${message.completed} / ${message.total}`, percent);
        } else if (message.type === "error") {
          throw new Error(message.message || "Frame scan failed");
        } else if (message.type === "done") {
          scanFinished = true;
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.trim()) handleScanMessage(JSON.parse(line));
        }
        if (done) break;
      }
      if (buffer.trim()) handleScanMessage(JSON.parse(buffer));
      if (!scanFinished) throw new Error("Frame scan ended before completion");

      if (state.candidateFrames.length > 0 && !state.candidateUserSelected) {
        selectCandidate(Math.min(2, state.candidateFrames.length - 1), false);
      }
      setStudioProgress(`Ready · ${state.candidateFrames.length} frames extracted`, 100);
      scheduleHideStudioProgress(1400);
    } catch (err) {
      if (err.name === "AbortError") return;
      console.error(err);
      setStudioProgress(`Frame scan failed · ${err.message}`, null);
      alert("Error scanning frames: " + err.message);
    } finally {
      el.btnRescanFrames.textContent = "🔄 Scan & Extract Frames";
      el.btnRescanFrames.disabled = false;
    }
  }

  // Render Candidates Gallery
  function renderCandidateGallery() {
    el.candidatesGallery.innerHTML = "";
    state.candidateFrames.forEach((c, idx) => {
      el.candidatesGallery.appendChild(createCandidateCard(c, idx));
    });
    renderStoryboardGallery();
    el.candidatesCountText.textContent = `${state.candidateFrames.length} shots · ${state.storyboardFrames.length} selected`;
  }

  function createCandidateCard(frame, idx) {
    const card = document.createElement("div");
    card.className = "candidate-card" + (state.activeBaseFilename === frame.filename ? " active" : "");
    card.dataset.filename = frame.filename;
    card.draggable = true;
    card.innerHTML = `
      <img src="${frame.url}" alt="Frame ${idx + 1}" loading="lazy">
      <span class="candidate-time">${formatTime(frame.timestamp_sec)}</span>
      <button class="candidate-add" type="button"></button>
    `;
    card.addEventListener("click", () => selectCandidate(idx, true));
    card.addEventListener("dragstart", (event) => {
      if (event.target.closest(".candidate-add")) {
        event.preventDefault();
        return;
      }
      state.draggedCandidateFilename = frame.filename;
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("text/plain", frame.filename);
    });
    card.addEventListener("dragend", () => { state.draggedCandidateFilename = null; });
    card.querySelector(".candidate-add").addEventListener("click", (event) => {
      event.stopPropagation();
      applyCandidateToStoryboard(frame.filename);
    });
    updateCandidateAddButton(card);
    return card;
  }

  function updateCandidateAddButton(card) {
    const frameFilename = card.dataset.filename;
    const addButton = card.querySelector(".candidate-add");
    const edit = state.storyboardEdit;
    const full = state.storyboardFrames.length >= state.gridRows * state.gridCols;
    if (edit?.type === "insert") {
      addButton.textContent = "Insert";
      addButton.disabled = full;
    } else if (edit?.type === "replace") {
      addButton.textContent = "Replace";
      addButton.disabled = false;
    } else {
      const added = state.storyboardFrames.some(frame => frame.filename === frameFilename);
      addButton.textContent = added ? "✓ Added" : "+ Add";
      addButton.disabled = added || full;
    }
  }

  function refreshCandidateAddButtons() {
    el.candidatesGallery.querySelectorAll(".candidate-card").forEach(updateCandidateAddButton);
  }

  function renderStoryboardGallery() {
    el.storyboardGallery.innerHTML = "";
    updateStoryboardCount();

    if (state.storyboardFrames.length === 0) {
      const empty = document.createElement("div");
      empty.className = "storyboard-empty";
      empty.textContent = "Drag a shot here or use + Add below.";
      el.storyboardGallery.appendChild(empty);
      return;
    }

    state.storyboardFrames.forEach((frame, idx) => {
      appendStoryboardCard(frame, idx);
    });
  }

  function updateStoryboardEditPrompt() {
    if (!state.storyboardEdit) {
      el.storyboardEditPrompt.style.display = "none";
      return;
    }
    const { type, index } = state.storyboardEdit;
    const action = type === "insert" ? "insert before" : "replace";
    el.storyboardEditPromptText.textContent = `Choose a shot to ${action} frame ${index + 1}.`;
    el.storyboardEditPrompt.style.display = "flex";
  }

  function beginStoryboardEdit(type, index) {
    if (type === "insert" && state.storyboardFrames.length >= state.gridRows * state.gridCols) {
      alert("The collage is full. Remove a frame first, then insert a new one.");
      return;
    }
    state.storyboardEdit = { type, index };
    updateStoryboardEditPrompt();
    refreshCandidateAddButtons();
    renderStoryboardGallery();
  }

  function appendStoryboardCard(frame, idx) {
    const emptyState = el.storyboardGallery.querySelector(".storyboard-empty");
    if (emptyState) emptyState.remove();
    const card = document.createElement("div");
    card.className = "storyboard-frame";
    if (state.storyboardEdit?.index === idx) {
      card.classList.add(state.storyboardEdit.type === "insert" ? "insert-target" : "replace-target");
    }
    card.draggable = true;
    card.innerHTML = `
      <img src="${frame.url}" alt="Collage frame ${idx + 1}" loading="lazy">
      <span class="storyboard-frame-number">${idx + 1}</span>
      <button class="storyboard-remove" type="button" aria-label="Remove frame ${idx + 1}" title="Remove this frame">×</button>
      <div class="storyboard-actions">
        <button class="storyboard-insert" type="button" title="Insert a shot before this frame">
          <span class="btn-icon">+</span><span>Before</span>
        </button>
        <button class="storyboard-replace" type="button" title="Choose a shot to replace this frame">
          <span class="btn-icon">↻</span><span>Replace</span>
        </button>
      </div>
    `;
    card.addEventListener("dragstart", (event) => {
      if (event.target.closest(".storyboard-actions") || event.target.closest(".storyboard-remove")) {
        event.preventDefault();
        return;
      }
      state.draggedStoryboardIndex = idx;
      event.dataTransfer.effectAllowed = "move";
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => {
      state.draggedStoryboardIndex = null;
      card.classList.remove("dragging");
    });
    card.addEventListener("dragover", (event) => event.preventDefault());
    card.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (state.draggedCandidateFilename) {
        const replacement = state.candidateFrames.find(item => item.filename === state.draggedCandidateFilename);
        if (replacement) {
          state.storyboardFrames[idx] = replacement;
          state.storyboardWasEdited = true;
        }
        state.storyboardEdit = null;
        updateStoryboardEditPrompt();
        state.draggedCandidateFilename = null;
        renderCandidateGallery();
        return;
      }
      const from = state.draggedStoryboardIndex;
      if (from === null || from === idx) return;
      const [moved] = state.storyboardFrames.splice(from, 1);
      state.storyboardFrames.splice(idx, 0, moved);
      state.storyboardWasEdited = true;
      state.storyboardEdit = null;
      updateStoryboardEditPrompt();
      renderCandidateGallery();
    });
    card.querySelector(".storyboard-insert").addEventListener("click", (event) => {
      event.stopPropagation();
      beginStoryboardEdit("insert", idx);
    });
    card.querySelector(".storyboard-replace").addEventListener("click", (event) => {
      event.stopPropagation();
      beginStoryboardEdit("replace", idx);
    });
    card.querySelector(".storyboard-remove").addEventListener("click", (event) => {
      event.stopPropagation();
      state.storyboardFrames.splice(idx, 1);
      state.storyboardWasEdited = true;
      state.storyboardEdit = null;
      updateStoryboardEditPrompt();
      renderCandidateGallery();
    });
    el.storyboardGallery.appendChild(card);
  }

  function updateStoryboardCount() {
    el.storyboardFramesCount.textContent = `${state.storyboardFrames.length} / ${state.gridRows * state.gridCols}`;
  }

  function addFrameToStoryboard(filename) {
    if (state.storyboardFrames.some(frame => frame.filename === filename)) return;
    if (state.storyboardFrames.length >= state.gridRows * state.gridCols) return;
    const frame = state.candidateFrames.find(candidate => candidate.filename === filename);
    if (!frame) return;
    state.storyboardFrames.push(frame);
    state.storyboardWasEdited = true;
    renderCandidateGallery();
  }

  function applyCandidateToStoryboard(filename) {
    if (!state.storyboardEdit) {
      addFrameToStoryboard(filename);
      return;
    }
    const frame = state.candidateFrames.find(candidate => candidate.filename === filename);
    if (!frame) return;
    const { type, index } = state.storyboardEdit;
    if (type === "insert") {
      if (state.storyboardFrames.length >= state.gridRows * state.gridCols) return;
      state.storyboardFrames.splice(index, 0, frame);
    } else {
      state.storyboardFrames[index] = frame;
    }
    state.storyboardWasEdited = true;
    state.storyboardEdit = null;
    updateStoryboardEditPrompt();
    renderCandidateGallery();
  }

  function selectCandidate(idx, userInitiated = false) {
    if (!state.candidateFrames[idx]) return;
    const cand = state.candidateFrames[idx];
    if (userInitiated) state.candidateUserSelected = true;
    state.activeBaseFilename = cand.filename;
    syncExportAvailability();
    el.fineScrubber.value = cand.timestamp_sec || 0;
    el.scrubberTimeText.textContent = formatTime(cand.timestamp_sec || 0);
    seekSourceVideo(cand.timestamp_sec || 0, userInitiated);

    const cards = el.candidatesGallery.querySelectorAll(".candidate-card");
    cards.forEach((c, i) => c.classList.toggle("active", i === idx));

    schedulePreview();
  }

  function seekSourceVideo(seconds, playAfterSeek) {
    if (!el.sourceVideo || !state.videoObjectUrl) return;
    state.pendingVideoSeek = { seconds, playAfterSeek };
    if (el.sourceVideo.readyState >= 1) applyPendingVideoSeek();
  }

  function applyPendingVideoSeek() {
    if (!state.pendingVideoSeek || !el.sourceVideo || el.sourceVideo.readyState < 1) return;
    const { seconds, playAfterSeek } = state.pendingVideoSeek;
    state.pendingVideoSeek = null;
    const duration = Number.isFinite(el.sourceVideo.duration) ? el.sourceVideo.duration : seconds;
    el.sourceVideo.currentTime = Math.max(0, Math.min(seconds, duration));
    if (playAfterSeek) el.sourceVideo.play().catch(() => {});
  }

  function updateVideoBufferProgress() {
    if (!el.sourceVideo || !Number.isFinite(el.sourceVideo.duration) || el.sourceVideo.duration <= 0) return;
    let bufferedEnd = 0;
    for (let i = 0; i < el.sourceVideo.buffered.length; i++) {
      bufferedEnd = Math.max(bufferedEnd, el.sourceVideo.buffered.end(i));
    }
    const percent = Math.max(0, Math.min(100, (bufferedEnd / el.sourceVideo.duration) * 100));
    el.videoLoadFill.style.width = `${percent}%`;
  }

  // Fine Scrubber Exact Frame Capture
  async function captureExactFrame(timestampSec) {
    el.btnCaptureScrubberFrame.textContent = "⏳ Capturing exact millisecond...";
    el.btnCaptureScrubberFrame.disabled = true;
    setStudioProgress(`Capturing frame at ${formatTime(timestampSec)}…`, null);

    try {
      const res = await fetch("/api/thumbnail/extract-single-frame", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_id: state.activeMedia.id,
          timestamp_sec: timestampSec,
          session_id: window.STUDIO_TAB_SESSION_ID || null
        })
      });
      if (!res.ok) throw new Error("Failed to capture exact frame");
      const data = await res.json();

      // Prepend to candidate list
      state.candidateFrames.unshift(data);
      renderCandidateGallery();
      selectCandidate(0);
      setStudioProgress("Frame added to available shots", 100);
      scheduleHideStudioProgress(1000);
    } catch (err) {
      setStudioProgress(`Frame capture failed · ${err.message}`, null);
      alert("Capture error: " + err.message);
    } finally {
      el.btnCaptureScrubberFrame.textContent = "📸 Capture Current Scrubber Shot";
      el.btnCaptureScrubberFrame.disabled = false;
    }
  }

  // Make Storyboard Collage Background
  async function makeStoryboardBackground() {
    if (state.storyboardFrames.length < 1) {
      alert("Add at least one frame to the collage first.");
      return;
    }
    el.btnMakeStoryboard.textContent = "🧩 Building Collage...";
    el.btnMakeStoryboard.disabled = true;
    setStudioProgress("Building collage background…", null);

    try {
      const rows = state.gridRows;
      const cols = state.gridCols;

      const fnames = state.storyboardFrames.slice(0, rows * cols).map(c => c.filename);

      const res = await fetch("/api/thumbnail/generate-storyboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          frame_filenames: fnames,
          rows: rows,
          cols: cols,
          aspect_ratio: state.aspectRatio,
          resolution_scale: state.resolutionScale,
          border_px: parseInt(el.storyboardBorderPx?.value ?? "0", 10) || 0,
          border_color: "#000000",
          session_id: window.STUDIO_TAB_SESSION_ID || null
        })
      });
      if (!res.ok) throw new Error("Failed to build collage");
      const data = await res.json();

      state.activeBaseFilename = data.filename;
      syncExportAvailability();
      schedulePreview();
      setStudioProgress("Collage ready · rendering preview…", 100);
      scheduleHideStudioProgress(1400);
    } catch (err) {
      setStudioProgress(`Collage failed · ${err.message}`, null);
      alert("Collage error: " + err.message);
    } finally {
      el.btnMakeStoryboard.textContent = "🧩 Build Collage Background";
      el.btnMakeStoryboard.disabled = false;
    }
  }

  // Sticker Upload
  async function handleStickerUpload(e) {
    if (!e.target.files || !e.target.files[0]) return;
    const file = e.target.files[0];
    const formData = new FormData();
    formData.append("file", file);
    if (window.STUDIO_TAB_SESSION_ID) {
      formData.append("session_id", window.STUDIO_TAB_SESSION_ID);
    }

    el.btnUploadSticker.textContent = "Uploading...";
    try {
      const res = await fetch("/api/upload-watermark-logo", {
        method: "POST",
        body: formData
      });
      if (!res.ok) throw new Error("Upload failed");
      const data = await res.json();
      state.stickerFilename = data.filename;
      state.stickerPreviewUrl = data.preview_url;

      el.stickerThumbPreview.innerHTML = `<img src="${data.preview_url}" style="width:100%; height:100%; object-fit:contain;">`;
      el.stickerScaleControls.style.display = "block";
      el.btnUploadSticker.textContent = "Replace Cutout";
      schedulePreview();
    } catch (err) {
      alert("Sticker upload error: " + err.message);
      el.btnUploadSticker.textContent = "Upload Cutout / Logo";
    }
  }

  // Aspect Ratio & Layout Updates
  function updateRatioUI() {
    const meta = RESOLUTION_MAP[state.aspectRatio] || RESOLUTION_MAP["16:9"];
    const width = meta.w * state.resolutionScale;
    const height = meta.h * state.resolutionScale;
    el.targetResolutionBadge.textContent = `${meta.label} · ${width}×${height}`;
    if (el.exportRatioText) {
      el.exportRatioText.textContent = `${state.aspectRatio} (${width}×${height})`;
    }
  }

  // Debounced Live Preview
  function schedulePreview() {
    if (!state.activeBaseFilename) return;
    clearTimeout(state.previewTimeout);
    state.previewTimeout = setTimeout(fetchLivePreview, 180);
  }

  function buildThumbnailDesignPayload() {
    return {
      aspect_ratio: state.aspectRatio,
      fit_mode: state.fitMode,
      resolution_scale: state.resolutionScale,
      adjustments: {
        saturation: state.saturation,
        contrast: state.contrast,
        vignette: state.vignette / 100.0
      },
      text_items: state.text ? [
        {
          text: state.text,
          font_family: state.fontFamily,
          font_size: state.fontSize,
          font_bold: true,
          color: state.textColor,
          stroke_width: state.strokeWidth,
          stroke_color: state.strokeColor,
          rotation: state.tiltAngle,
          shadow_enabled: state.dropShadow,
          bg_enabled: state.badgeEnabled,
          bg_color: state.badgeColor,
          bg_opacity: state.badgeOpacity,
          custom_x: state.textPos.x,
          custom_y: state.textPos.y
        }
      ] : [],
      stickers: state.stickerFilename ? [
        {
          image_filename: state.stickerFilename,
          scale_percent: state.stickerScale,
          custom_x: state.stickerPos.x,
          custom_y: state.stickerPos.y,
          rotation: state.stickerRotation,
          opacity: state.stickerOpacity
        }
      ] : [],
      session_id: window.STUDIO_TAB_SESSION_ID || null
    };
  }

  async function fetchLivePreview() {
    if (!state.activeBaseFilename) return;
    if (state.previewAbortController) state.previewAbortController.abort();
    state.previewAbortController = new AbortController();

    const payload = {
      ...buildThumbnailDesignPayload(),
      base_image_filename: state.activeBaseFilename
    };

    try {
      const res = await fetch("/api/thumbnail/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: state.previewAbortController.signal,
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error("Preview generation failed");
      const data = await res.json();

      el.thumbPreviewImg.src = data.preview_url;
      el.thumbPreviewImg.style.display = "block";
      el.thumbEmptyPrompt.style.display = "none";
    } catch (err) {
      if (err.name === "AbortError") return;
      console.warn("Preview error:", err);
    }
  }

  // Interactive Dragging on Live Canvas
  function initCanvasDragging() {
    let isDragging = false;

    function handleDragMove(e) {
      if (!isDragging) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const rect = el.thumbPreviewImg.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const normX = Math.max(0.05, Math.min(0.95, (clientX - rect.left) / rect.width));
      const normY = Math.max(0.05, Math.min(0.95, (clientY - rect.top) / rect.height));

      if (state.activeDragTarget === "sticker" && state.stickerFilename) {
        state.stickerPos = { x: normX, y: normY };
      } else {
        state.textPos = { x: normX, y: normY };
      }
      schedulePreview();
    }

    function handleDragStart(e) {
      if (!state.activeBaseFilename || el.thumbPreviewImg.style.display === "none") return;
      isDragging = true;

      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const rect = el.thumbPreviewImg.getBoundingClientRect();
      const normX = (clientX - rect.left) / rect.width;
      const normY = (clientY - rect.top) / rect.height;

      // Check proximity to sticker vs text
      if (state.stickerFilename) {
        const dSticker = Math.hypot(normX - state.stickerPos.x, normY - state.stickerPos.y);
        const dText = Math.hypot(normX - state.textPos.x, normY - state.textPos.y);
        state.activeDragTarget = dSticker < dText ? "sticker" : "text";
      } else {
        state.activeDragTarget = "text";
      }

      handleDragMove(e);
    }

    function handleDragEnd() {
      isDragging = false;
    }

    el.thumbCanvasWrapper.addEventListener("mousedown", handleDragStart);
    window.addEventListener("mousemove", handleDragMove);
    window.addEventListener("mouseup", handleDragEnd);

    el.thumbCanvasWrapper.addEventListener("touchstart", handleDragStart, { passive: true });
    window.addEventListener("touchmove", handleDragMove, { passive: true });
    window.addEventListener("touchend", handleDragEnd);
  }

  // Export Modal Functions
  function syncExportAvailability() {
    if (el.btnOpenExportModal) el.btnOpenExportModal.disabled = !state.activeBaseFilename || state.isExporting;
  }

  function openExportModal() {
    if (!state.activeBaseFilename) {
      alert("Please upload a video or photo first to design a thumbnail.");
      return;
    }
    updateRatioUI();
    updateExportSummary();
    el.exportResultsArea.style.display = "none";
    el.exportResultsArea.innerHTML = "";
    el.thumbExportProgress.hidden = true;
    el.btnDoExportThumb.disabled = false;
    el.thumbExportModal.classList.add("open");
    el.thumbExportModal.classList.add("active");
  }

  function closeExportModal() {
    el.thumbExportModal.classList.remove("open");
    el.thumbExportModal.classList.remove("active");
  }

  function updateExportSummary() {
    const meta = RESOLUTION_MAP[state.aspectRatio] || RESOLUTION_MAP["16:9"];
    const resolution = `${meta.w * state.resolutionScale}×${meta.h * state.resolutionScale}`;
    if (state.exportScope === "all" && state.candidateFrames.length > 1) {
      const varCount = state.candidateFrames.length;
      const totalCount = varCount + 1;
      el.exportSelectionSummary.innerHTML = `Exporting <strong>${totalCount} files</strong> (1 generated thumbnail + ${varCount} variations) at <strong style="color:var(--accent-cyan);">${meta.label} · ${resolution}</strong> into a ZIP bundle.`;
      el.btnDoExportThumb.textContent = `Download All ${totalCount} Files (.ZIP)`;
    } else {
      el.exportSelectionSummary.innerHTML = `Exporting current thumbnail at <strong style="color:var(--accent-cyan);">${meta.label} · ${resolution}</strong>.`;
      el.btnDoExportThumb.textContent = "Download High-Res Thumbnail";
    }
  }

  async function executeExport() {
    if (!state.activeBaseFilename) return;
    state.isExporting = true;
    syncExportAvailability();
    el.btnDoExportThumb.disabled = true;
    el.btnDoExportThumb.textContent = "⏳ Generating Ultra-Res Thumbnail(s)...";
    el.thumbExportProgress.hidden = false;
    el.thumbExportProgressText.textContent = "Rendering high-resolution thumbnail(s)…";
    el.exportSelectionSummary.setAttribute("aria-busy", "true");

    try {
      let baseFiles = [state.activeBaseFilename];
      let includeMainThumbnail = false;

      if (state.exportScope === "all" && state.candidateFrames.length > 1) {
        let mainBaseFilename = state.activeBaseFilename;
        const isCandidateBase = state.candidateFrames.some(c => c.filename === state.activeBaseFilename);
        if (isCandidateBase && state.storyboardFrames.length > 0) {
          const rows = state.gridRows;
          const cols = state.gridCols;
          const fnames = state.storyboardFrames.slice(0, rows * cols).map(c => c.filename);
          const sbRes = await fetch("/api/thumbnail/generate-storyboard", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              frame_filenames: fnames,
              rows: rows,
              cols: cols,
              aspect_ratio: state.aspectRatio,
              resolution_scale: state.resolutionScale,
              border_px: parseInt(el.storyboardBorderPx?.value ?? "0", 10) || 0,
              border_color: "#000000",
              session_id: window.STUDIO_TAB_SESSION_ID || null
            })
          });
          if (!sbRes.ok) throw new Error("Failed to build main collage thumbnail");
          const sbData = await sbRes.json();
          el.thumbExportProgressText.textContent = "Building the main collage thumbnail…";
          mainBaseFilename = sbData.filename;
          state.activeBaseFilename = sbData.filename;
        }
        baseFiles = [mainBaseFilename, ...state.candidateFrames.map(c => c.filename)];
        includeMainThumbnail = true;
      }

      const payload = {
        ...buildThumbnailDesignPayload(),
        base_image_filenames: baseFiles,
        format: state.exportFormat,
        include_main_thumbnail: includeMainThumbnail
      };

      const res = await fetch("/api/thumbnail/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      el.thumbExportProgressText.textContent = "Preparing downloads…";
      if (!res.ok) throw new Error("Export request failed");
      const data = await res.json();

      el.exportResultsArea.style.display = "flex";
      el.exportResultsArea.innerHTML = "";

      // Trigger automatic direct browser download
      if (data.items && data.items.length === 1) {
        const item = data.items[0];
        const dlLink = document.createElement("a");
        dlLink.href = item.download_url;
        dlLink.download = item.filename;
        document.body.appendChild(dlLink);
        dlLink.click();
        document.body.removeChild(dlLink);
      } else if (data.zip_url) {
        const zipLink = document.createElement("a");
        zipLink.href = data.zip_url;
        zipLink.download = data.zip_url.split("/").pop();
        document.body.appendChild(zipLink);
        zipLink.click();
        document.body.removeChild(zipLink);
      }

      if (data.zip_url) {
        const zipBtn = document.createElement("a");
        zipBtn.href = data.zip_url;
        zipBtn.className = "btn-primary";
        zipBtn.style.textDecoration = "none";
        zipBtn.style.margin = "8px 0";
        zipBtn.innerHTML = `📦 Download All ${data.items.length} Files (.ZIP Bundle)`;
        el.exportResultsArea.appendChild(zipBtn);
      }

      data.items.forEach((item, idx) => {
        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.justifyContent = "space-between";
        row.style.alignItems = "center";
        row.style.padding = "6px 10px";
        row.style.background = "var(--bg-card)";
        row.style.borderRadius = "var(--radius-sm)";
        row.style.fontSize = "12px";

        const label = item.label || (idx === 0 && includeMainThumbnail ? "Generated Thumbnail" : `Variation ${idx + 1}`);
        row.innerHTML = `
          <span>${label} (${formatBytes(item.size_bytes)})</span>
          <a href="${item.download_url}" download class="btn-secondary" style="padding: 4px 10px; font-size: 11px; text-decoration: none;">Download ↓</a>
        `;
        el.exportResultsArea.appendChild(row);
      });

      el.btnDoExportThumb.textContent = "✓ Export & Download Complete!";
      el.btnDoExportThumb.disabled = false;
      el.thumbExportProgress.hidden = true;
      el.exportSelectionSummary.removeAttribute("aria-busy");
      state.isExporting = false;
      syncExportAvailability();
    } catch (err) {
      alert("Export failed: " + err.message);
      el.btnDoExportThumb.disabled = false;
      el.btnDoExportThumb.textContent = "Retry Export";
      el.thumbExportProgress.hidden = true;
      el.exportSelectionSummary.removeAttribute("aria-busy");
      state.isExporting = false;
      syncExportAvailability();
    }
  }

  // Utilities
  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }

  function formatTime(sec) {
    if (isNaN(sec) || sec < 0) return "0:00.0";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 10);
    return `${m}:${s.toString().padStart(2, "0")}.${ms}`;
  }
})();
