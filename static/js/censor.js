// Censor & Privacy Studio Pro - Diversified Client Engine
(function() {
  const state = {
    activeMedia: null,
    mediaSubTab: "images",     // "images" | "videos"
    mediaQueue: [],            // Uploaded batch items (images or videos)
    selectedBatchIds: new Set(),
    targetsByFile: {},         // file_id -> { targets: [], selectedFocusId: null }
    protectionMode: "faces",   // "faces" | "nsfw" | "objects"
    faceScope: "multi",        // "multi" (all people) | "single" (specific person)
    selectedFocusId: null,     // ID of the focused person when in single mode
    selectedTargetId: null,    // Currently selected target ID (for resize, mask override, time range)
    nsfwSensitivity: 0.5,
    nsfwClasses: [
      "FEMALE_GENITALIA_EXPOSED",
      "MALE_GENITALIA_EXPOSED",
      "FEMALE_BREAST_EXPOSED",
      "BUTTOCKS_EXPOSED",
      "ANUS_EXPOSED"
    ],
    nsfwExcludeFaces: true,
    selectedObjectTag: "License Plate",
    drawTool: "box",           // "box" | "brush" | "eraser" | "select"
    brushSize: 28,             // Screen-space radius in px
    mergeBrushStrokes: true,
    activeBrushPoints: [],     // Current stroke points in natural image coords
    dragMoveState: null,       // { target, mode: 'move'|'resize', handle, startNatX, startNatY, origX, origY, origW, origH, origPts, origEraserPts, moved }
    panState: null,            // { startX, startY, origPanX, origPanY }
    spacePressed: false,
    hoverPoint: null,          // { x, y } in canvas px
    zoom: 1.0,
    panX: 0,
    panY: 0,
    showGuides: true,
    peekingOriginal: false,
    allEmojis: [],
    emojiCategory: "all",
    emojiSearch: "",
    appendUploadMode: false,
    targets: [],               // List of { id, kind, x, y, w, h, brush_points, brush_radius, eraser_points, eraser_radius, start_sec, end_sec, mask_type, confidence, label, enabled, track_id }
    maskConfig: {
      mask_type: "blur",       // "blur" | "pixelate" | "emoji" | "redact"
      intensity: 60,
      feather: 25,
      emoji_name: "sunglasses",
      custom_sticker_filename: null,
      redact_text: "[CENSORED]",
      shape: "oval",
      mask_region: "face",
      face_fit: "standard",
      padding_percent: 0.20
    },
    scrubberSec: 0.0,
    previewTimeout: null,
    scrubTimeout: null,
    previewAbortController: null,
    historyTimeout: null,
    undoStack: [],
    redoStack: [],
    historySnapshot: null,
    previewRequestId: 0,
    isDrawing: false,
    manualDrawArmed: false,
    drawStart: { x: 0, y: 0 },
    activeJobId: null,
    pollInterval: null,
    exportBusy: false
  };

  const el = {};

  function initStudio() {
    initElements();
    initEventListeners();
    updateProtectionModeUI();
    updateMaskStylePanels();
    loadEmojiPack();
    fetchCapabilities();
    initCanvasDrawing();
    renderTargetsList();
    syncMediaActionButtons();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initStudio);
  } else {
    initStudio();
  }

  function initElements() {
    el.censorMediaSubTabs = document.getElementById("censorMediaSubTabs");
    el.btnSubTabImages = document.getElementById("btnSubTabImages");
    el.btnSubTabVideos = document.getElementById("btnSubTabVideos");
    el.censorDropzoneTitle = document.getElementById("censorDropzoneTitle");
    el.censorDropzoneHint = document.getElementById("censorDropzoneHint");
    el.censorFileInput = document.getElementById("censorFileInput");
    el.censorDropzone = document.getElementById("censorDropzone");
    el.mediaDetailsPanel = document.getElementById("mediaDetailsPanel");
    el.mediaNameLabel = document.getElementById("mediaNameLabel");
    el.mediaDimensionsBadge = document.getElementById("mediaDimensionsBadge");
    el.targetCountBadge = document.getElementById("targetCountBadge");
    el.censorBatchPanel = document.getElementById("censorBatchPanel");
    el.censorBatchCount = document.getElementById("censorBatchCount");
    el.btnBatchSelectAll = document.getElementById("btnBatchSelectAll");
    el.btnAddMoreMedia = document.getElementById("btnAddMoreMedia");
    el.censorBatchList = document.getElementById("censorBatchList");
    el.btnBatchApplyFaces = document.getElementById("btnBatchApplyFaces");
    el.btnBatchApplyEyes = document.getElementById("btnBatchApplyEyes");
    el.btnBatchApplyNsfw = document.getElementById("btnBatchApplyNsfw");

    // Draw Bar & Viewport Controls
    el.censorDrawBar = document.getElementById("censorDrawBar");
    el.drawToolSegments = document.querySelectorAll("#drawToolSegments .segment-btn");
    el.btnToolBox = document.getElementById("btnToolBox");
    el.btnToolBrush = document.getElementById("btnToolBrush");
    el.btnToolEraser = document.getElementById("btnToolEraser");
    el.btnToolSelect = document.getElementById("btnToolSelect");
    el.brushSizeGroup = document.getElementById("brushSizeGroup");
    el.sliderBrushSize = document.getElementById("sliderBrushSize");
    el.brushSizeVal = document.getElementById("brushSizeVal");
    el.checkMergeBrushStrokes = document.getElementById("checkMergeBrushStrokes");
    el.quickPhotoPresetsGroup = document.getElementById("quickPhotoPresetsGroup");
    el.btnQuickFacePreset = document.getElementById("btnQuickFacePreset");
    el.btnQuickEyesPreset = document.getElementById("btnQuickEyesPreset");
    el.btnZoomOut = document.getElementById("btnZoomOut");
    el.btnZoomReset = document.getElementById("btnZoomReset");
    el.btnZoomIn = document.getElementById("btnZoomIn");
    el.btnToggleGuides = document.getElementById("btnToggleGuides");
    el.btnPeekOriginal = document.getElementById("btnPeekOriginal");
    el.btnUndoTarget = document.getElementById("btnUndoTarget");
    el.btnClearCurrentTargets = document.getElementById("btnClearCurrentTargets");
    el.modalBatchItemsArea = document.getElementById("modalBatchItemsArea");

    // Video Target Range Bar
    el.videoTargetRangeBar = document.getElementById("videoTargetRangeBar");
    el.rangeTargetLabel = document.getElementById("rangeTargetLabel");
    el.inputRangeStart = document.getElementById("inputRangeStart");
    el.btnSetRangeIn = document.getElementById("btnSetRangeIn");
    el.inputRangeEnd = document.getElementById("inputRangeEnd");
    el.btnSetRangeOut = document.getElementById("btnSetRangeOut");
    el.btnResetRangeFull = document.getElementById("btnResetRangeFull");

    // Diversified Modes
    el.protectionModeSegments = document.querySelectorAll("#protectionModeSegments .segment-btn");
    el.panelFaceMode = document.getElementById("panelFaceMode");
    el.panelNsfwMode = document.getElementById("panelNsfwMode");
    el.panelObjectMode = document.getElementById("panelObjectMode");

    // Face Mode Controls
    el.btnScopeMultiFace = document.getElementById("btnScopeMultiFace");
    el.btnScopeSingleFace = document.getElementById("btnScopeSingleFace");
    el.faceScopeBadge = document.getElementById("faceScopeBadge");
    el.faceFitSegments = document.querySelectorAll("#faceFitSegments .segment-btn");
    el.sliderFacePadding = document.getElementById("sliderFacePadding");
    el.facePaddingVal = document.getElementById("facePaddingVal");
    el.singleFaceNotice = document.getElementById("singleFaceNotice");
    el.btnAutoDetectFaces = document.getElementById("btnAutoDetectFaces");

    // NSFW Controls
    el.nsfwDetectorBadge = document.getElementById("nsfwDetectorBadge");
    el.nsfwDetectorNote = document.getElementById("nsfwDetectorNote");
    el.nsfwPartsCheckboxes = document.getElementById("nsfwPartsCheckboxes");
    el.btnNsfwSelectDefaults = document.getElementById("btnNsfwSelectDefaults");
    el.btnNsfwSelectAll = document.getElementById("btnNsfwSelectAll");
    el.checkNsfwExcludeFaces = document.getElementById("checkNsfwExcludeFaces");
    el.btnNsfwLow = document.getElementById("btnNsfwLow");
    el.btnNsfwBalanced = document.getElementById("btnNsfwBalanced");
    el.btnNsfwHigh = document.getElementById("btnNsfwHigh");
    el.btnScanNsfw = document.getElementById("btnScanNsfw");

    // Object Controls
    el.objectTagSegments = document.querySelectorAll("#objectTagSegments .segment-btn");
    el.btnAddManualBox = document.getElementById("btnAddManualBox");
    el.checkTrackCustomObject = document.getElementById("checkTrackCustomObject");

    // Scrubber
    el.censorScrubberPanel = document.getElementById("censorScrubberPanel");
    el.censorScrubber = document.getElementById("censorScrubber");
    el.censorScrubberTimeText = document.getElementById("censorScrubberTimeText");
    el.btnScanCurrentFrame = document.getElementById("btnScanCurrentFrame");
    el.targetsContainer = document.getElementById("targetsContainer");
    el.btnClearAllTargets = document.getElementById("btnClearAllTargets");

    // Center Stage
    el.censorStatusBadge = document.getElementById("censorStatusBadge");
    el.censorCanvasWrapper = document.getElementById("censorCanvasWrapper");
    el.censorPreviewImg = document.getElementById("censorPreviewImg");
    el.censorOriginalImg = document.getElementById("censorOriginalImg");
    el.censorOverlayCanvas = document.getElementById("censorOverlayCanvas");
    el.censorEmptyPrompt = document.getElementById("censorEmptyPrompt");
    el.censorHintText = document.getElementById("censorHintText");

    // Styling Controls
    el.maskTypeSegments = document.querySelectorAll("#maskTypeSegments .segment-btn");
    el.groupMaskShape = document.getElementById("groupMaskShape");
    el.maskShapeSegments = document.querySelectorAll("#maskShapeSegments .segment-btn");
    el.btnShapeOval = document.getElementById("btnShapeOval");
    el.btnShapeRect = document.getElementById("btnShapeRect");
    el.btnShapeCircle = document.getElementById("btnShapeCircle");
    el.btnShapeTriangle = document.getElementById("btnShapeTriangle");
    el.btnShapeHeart = document.getElementById("btnShapeHeart");
    el.groupMaskRegion = document.getElementById("groupMaskRegion");
    el.btnRegionFace = document.getElementById("btnRegionFace");
    el.btnRegionEyes = document.getElementById("btnRegionEyes");
    el.groupIntensity = document.getElementById("groupIntensity");
    el.labelIntensity = document.getElementById("labelIntensity");
    el.intensityVal = document.getElementById("intensityVal");
    el.sliderIntensity = document.getElementById("sliderIntensity");
    el.groupFeather = document.getElementById("groupFeather");
    el.featherVal = document.getElementById("featherVal");
    el.sliderFeather = document.getElementById("sliderFeather");
    el.groupEmoji = document.getElementById("groupEmoji");
    el.inputEmojiSearch = document.getElementById("inputEmojiSearch");
    el.emojiCategoryTabs = document.querySelectorAll("#emojiCategoryTabs .emoji-cat-tab");
    el.emojiGrid = document.getElementById("censorEmojiGrid") || document.querySelector("#groupEmoji .emoji-picker-grid");
    el.emojiBtns = document.querySelectorAll("#groupEmoji .emoji-btn");
    el.customStickerInput = document.getElementById("customStickerInput");
    el.btnUploadCustomSticker = document.getElementById("btnUploadCustomSticker");
    el.groupRedactText = document.getElementById("groupRedactText");
    el.inputRedactText = document.getElementById("inputRedactText");

    // Actions & Modal
    el.btnHeaderExport = document.getElementById("btnHeaderExport");
    el.btnUndo = document.getElementById("btnCensorUndo");
    el.btnRedo = document.getElementById("btnCensorRedo");
    el.censorStageViewport = document.getElementById("censorStageViewport");
    el.censorModal = document.getElementById("censorModal");
    el.btnCloseModal = document.getElementById("btnCloseModal");
    el.modalStatusText = document.getElementById("modalStatusText");
    el.modalProgressBar = document.getElementById("modalProgressBar");
    el.modalPctText = document.getElementById("modalPctText");
    el.modalResultArea = document.getElementById("modalResultArea");
    el.btnDownloadResult = document.getElementById("btnDownloadResult");
  }

  function applyMediaSubTab(subTab) {
    state.mediaSubTab = subTab === "videos" ? "videos" : "images";
    if (el.btnSubTabImages) el.btnSubTabImages.classList.toggle("active", state.mediaSubTab === "images");
    if (el.btnSubTabVideos) el.btnSubTabVideos.classList.toggle("active", state.mediaSubTab === "videos");
    if (el.censorFileInput) {
      el.censorFileInput.accept = state.mediaSubTab === "videos" ? "video/*" : "image/*";
    }
    if (el.censorDropzoneTitle) {
      el.censorDropzoneTitle.textContent = state.mediaSubTab === "videos"
        ? "Click or drop videos (batch)"
        : "Click or drop photos (batch)";
    }
    if (el.censorDropzoneHint) {
      el.censorDropzoneHint.textContent = state.mediaSubTab === "videos"
        ? "MP4, MOV, WebM, MKV supported • Multi-video batch queue"
        : "JPG, PNG, WebP supported • Select 1 or multiple files";
    }
  }

  function applyZoomTransform() {
    if (!el.censorCanvasWrapper) return;
    const z = state.zoom || 1;
    if (Math.abs(z - 1) < 0.01 && Math.abs(state.panX) < 1 && Math.abs(state.panY) < 1) {
      el.censorCanvasWrapper.style.transform = "";
    } else {
      el.censorCanvasWrapper.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${z})`;
    }
    if (el.btnZoomReset) {
      el.btnZoomReset.textContent = `${Math.round(z * 100)}%`;
    }
  }

  function adjustZoom(delta, reset = false) {
    if (reset) {
      state.zoom = 1.0;
      state.panX = 0;
      state.panY = 0;
    } else {
      state.zoom = Math.max(0.5, Math.min(4.0, Math.round((state.zoom + delta) * 10) / 10));
    }
    applyZoomTransform();
  }

  function setGuidesVisible(visible) {
    state.showGuides = Boolean(visible);
    if (el.btnToggleGuides) el.btnToggleGuides.classList.toggle("active", state.showGuides);
    drawOverlayBoxes();
  }

  function setPeekingOriginal(peeking) {
    state.peekingOriginal = Boolean(peeking && state.activeMedia);
    if (state.peekingOriginal) {
      refreshRawFrameForPeek();
    }
    if (el.censorOriginalImg) {
      el.censorOriginalImg.style.position = "absolute";
      el.censorOriginalImg.style.pointerEvents = "none";
      el.censorOriginalImg.style.zIndex = "2";
      el.censorOriginalImg.style.objectFit = "contain";
      el.censorOriginalImg.style.display = (state.peekingOriginal && el.censorOriginalImg.getAttribute("src")) ? "block" : "none";
    }
    if (el.btnPeekOriginal) el.btnPeekOriginal.classList.toggle("active", state.peekingOriginal);
  }

  async function fetchCapabilities() {
    try {
      const res = await fetch("/api/system/capabilities");
      if (!res.ok) return;
      const caps = await res.json();
      if (el.nsfwDetectorBadge && el.nsfwDetectorNote) {
        if (caps.nudenet_available) {
          el.nsfwDetectorBadge.textContent = "NudeNet v3 ONNX";
          el.nsfwDetectorBadge.style.color = "var(--accent-pink)";
          el.nsfwDetectorNote.textContent = "Uses local NudeNet v3 ONNX anatomical detection for body parts. Review boxes before export.";
        } else {
          el.nsfwDetectorBadge.textContent = "Skin Heuristic Fallback";
          el.nsfwDetectorBadge.style.color = "var(--accent-amber, #f59e0b)";
          el.nsfwDetectorNote.textContent = "NudeNet ONNX unavailable: running YCbCr skin-region fallback. Review boxes before export.";
        }
      }
    } catch (_) {}
  }

  function updateNsfwClassesFromDom() {
    if (!el.nsfwPartsCheckboxes) return;
    const checked = Array.from(el.nsfwPartsCheckboxes.querySelectorAll('input[type="checkbox"]:checked'))
      .map(cb => cb.value);
    state.nsfwClasses = checked;
  }

  function syncVideoRangeBar() {
    if (!el.videoTargetRangeBar) return;
    const isVideo = Boolean(state.activeMedia && state.activeMedia.media_type === "video");
    const target = state.targets.find(t => t.id === state.selectedTargetId);
    if (!isVideo || !target) {
      el.videoTargetRangeBar.style.display = "none";
      return;
    }
    const dur = Math.max(0.1, Number(state.activeMedia.duration || 10));
    el.videoTargetRangeBar.style.display = "flex";
    if (el.rangeTargetLabel) el.rangeTargetLabel.textContent = target.label || "Target";
    if (el.inputRangeStart) el.inputRangeStart.value = target.start_sec != null ? Number(target.start_sec).toFixed(1) : "0.0";
    if (el.inputRangeEnd) el.inputRangeEnd.value = target.end_sec != null ? Number(target.end_sec).toFixed(1) : dur.toFixed(1);
  }

  function initEventListeners() {
    state.historySnapshot = makeHistorySnapshot();
    el.btnUndo.addEventListener("click", undoEdit);
    el.btnRedo.addEventListener("click", redoEdit);

    if (el.btnSubTabImages) el.btnSubTabImages.addEventListener("click", () => applyMediaSubTab("images"));
    if (el.btnSubTabVideos) el.btnSubTabVideos.addEventListener("click", () => applyMediaSubTab("videos"));
    applyMediaSubTab(state.mediaSubTab);

    document.addEventListener("keydown", (event) => {
      const target = event.target;
      const isTextEntry = target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (isTextEntry) return;

      if (event.code === "Space" && !event.repeat && state.activeMedia) {
        state.spacePressed = true;
        if (el.censorOverlayCanvas) el.censorOverlayCanvas.style.cursor = "grab";
        return;
      }

      if (event.ctrlKey || event.metaKey) {
        if (event.key.toLowerCase() === "z" && !event.shiftKey) {
          event.preventDefault();
          undoEdit();
        } else if (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey)) {
          event.preventDefault();
          redoEdit();
        }
        return;
      }

      const k = event.key.toLowerCase();
      if (k === "b") setDrawTool("brush");
      else if (k === "e") setDrawTool("eraser");
      else if (k === "r") setDrawTool("box");
      else if (k === "v") setDrawTool("select");
      else if (k === "h") setGuidesVisible(!state.showGuides);
      else if (event.key === "[") {
        state.brushSize = Math.max(8, state.brushSize - 4);
        if (el.sliderBrushSize) el.sliderBrushSize.value = state.brushSize;
        if (el.brushSizeVal) el.brushSizeVal.textContent = `${state.brushSize}px`;
        drawOverlayBoxes();
      } else if (event.key === "]") {
        state.brushSize = Math.min(120, state.brushSize + 4);
        if (el.sliderBrushSize) el.sliderBrushSize.value = state.brushSize;
        if (el.brushSizeVal) el.brushSizeVal.textContent = `${state.brushSize}px`;
        drawOverlayBoxes();
      } else if ((event.key === "Delete" || event.key === "Backspace") && state.selectedTargetId) {
        const idx = state.targets.findIndex(t => t.id === state.selectedTargetId);
        if (idx !== -1) {
          state.targets.splice(idx, 1);
          state.selectedTargetId = null;
          saveCurrentMediaTargets();
          renderTargetsList();
          syncVideoRangeBar();
          drawOverlayBoxes();
          schedulePreview();
        }
      }
    });

    document.addEventListener("keyup", (event) => {
      if (event.code === "Space") {
        state.spacePressed = false;
        setDrawTool(state.drawTool);
      }
    });

    // Dropzone upload
    el.censorDropzone.addEventListener("click", () => {
      state.appendUploadMode = false;
      el.censorFileInput.value = "";
      el.censorFileInput.click();
    });
    if (el.btnAddMoreMedia) {
      el.btnAddMoreMedia.addEventListener("click", () => {
        state.appendUploadMode = true;
        el.censorFileInput.value = "";
        el.censorFileInput.click();
      });
    }
    el.censorFileInput.addEventListener("click", (e) => e.stopPropagation());
    el.censorFileInput.addEventListener("change", (e) => {
      if (e.target.files && e.target.files.length > 0) {
        const shouldAppend = state.appendUploadMode;
        state.appendUploadMode = false;
        uploadMediaFiles(e.target.files, shouldAppend);
      }
    });

    el.censorDropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      el.censorDropzone.style.borderColor = "var(--primary)";
    });
    el.censorDropzone.addEventListener("dragleave", () => {
      el.censorDropzone.style.borderColor = "";
    });
    el.censorDropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      el.censorDropzone.style.borderColor = "";
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        uploadMediaFiles(e.dataTransfer.files, false);
      }
    });

    if (el.btnBatchSelectAll) {
      el.btnBatchSelectAll.addEventListener("click", () => {
        const allIds = state.mediaQueue.map(m => m.id);
        const allSelected = allIds.length > 0 && allIds.every(id => state.selectedBatchIds.has(id));
        if (allSelected) {
          state.selectedBatchIds.clear();
        } else {
          allIds.forEach(id => state.selectedBatchIds.add(id));
        }
        renderBatchQueue();
        syncMediaActionButtons();
      });
    }
    if (el.btnBatchApplyFaces) el.btnBatchApplyFaces.addEventListener("click", () => applyBatchPreset("faces"));
    if (el.btnBatchApplyEyes) el.btnBatchApplyEyes.addEventListener("click", () => applyBatchPreset("eyes"));
    if (el.btnBatchApplyNsfw) el.btnBatchApplyNsfw.addEventListener("click", () => applyBatchPreset("nsfw"));

    el.drawToolSegments.forEach(btn => {
      btn.addEventListener("click", () => {
        setDrawTool(btn.dataset.tool || "box");
      });
    });

    if (el.sliderBrushSize) {
      el.sliderBrushSize.addEventListener("input", (e) => {
        state.brushSize = parseInt(e.target.value, 10) || 28;
        if (el.brushSizeVal) el.brushSizeVal.textContent = `${state.brushSize}px`;
        drawOverlayBoxes();
      });
    }
    if (el.checkMergeBrushStrokes) {
      state.mergeBrushStrokes = el.checkMergeBrushStrokes.checked;
      el.checkMergeBrushStrokes.addEventListener("change", (e) => {
        state.mergeBrushStrokes = e.target.checked;
      });
    }

    if (el.btnZoomOut) el.btnZoomOut.addEventListener("click", () => adjustZoom(-0.25));
    if (el.btnZoomReset) el.btnZoomReset.addEventListener("click", () => adjustZoom(0, true));
    if (el.btnZoomIn) el.btnZoomIn.addEventListener("click", () => adjustZoom(0.25));
    if (el.btnToggleGuides) el.btnToggleGuides.addEventListener("click", () => setGuidesVisible(!state.showGuides));
    if (el.btnPeekOriginal) {
      el.btnPeekOriginal.addEventListener("pointerenter", () => refreshRawFrameForPeek());
      el.btnPeekOriginal.addEventListener("pointerdown", () => setPeekingOriginal(true));
      ["pointerup", "pointerleave", "pointercancel"].forEach(ev =>
        el.btnPeekOriginal.addEventListener(ev, () => setPeekingOriginal(false))
      );
    }

    if (el.censorStageViewport) {
      el.censorStageViewport.addEventListener("wheel", (e) => {
        if (!state.activeMedia) return;
        if (e.shiftKey && (state.drawTool === "brush" || state.drawTool === "eraser")) {
          e.preventDefault();
          const delta = e.deltaY < 0 ? 4 : -4;
          state.brushSize = Math.max(8, Math.min(120, state.brushSize + delta));
          if (el.sliderBrushSize) el.sliderBrushSize.value = state.brushSize;
          if (el.brushSizeVal) el.brushSizeVal.textContent = `${state.brushSize}px`;
          drawOverlayBoxes();
        } else if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          adjustZoom(e.deltaY < 0 ? 0.2 : -0.2);
        }
      }, { passive: false });
    }

    // Video In/Out range bar handlers
    const updateSelectedTargetRange = (startVal, endVal) => {
      const target = state.targets.find(t => t.id === state.selectedTargetId);
      if (!target) return;
      target.start_sec = startVal;
      target.end_sec = endVal;
      saveCurrentMediaTargets();
      syncVideoRangeBar();
      renderTargetsList();
      schedulePreview();
    };
    if (el.btnSetRangeIn) {
      el.btnSetRangeIn.addEventListener("click", () => {
        const target = state.targets.find(t => t.id === state.selectedTargetId);
        if (!target) return;
        const start = Math.round(state.scrubberSec * 10) / 10;
        const end = target.end_sec != null ? Math.max(start + 0.1, target.end_sec) : null;
        updateSelectedTargetRange(start, end);
      });
    }
    if (el.btnSetRangeOut) {
      el.btnSetRangeOut.addEventListener("click", () => {
        const target = state.targets.find(t => t.id === state.selectedTargetId);
        if (!target) return;
        const end = Math.round(state.scrubberSec * 10) / 10;
        const start = target.start_sec != null ? Math.min(target.start_sec, Math.max(0, end - 0.1)) : 0;
        updateSelectedTargetRange(start, end);
      });
    }
    if (el.btnResetRangeFull) {
      el.btnResetRangeFull.addEventListener("click", () => updateSelectedTargetRange(null, null));
    }
    if (el.inputRangeStart) {
      el.inputRangeStart.addEventListener("change", () => {
        const target = state.targets.find(t => t.id === state.selectedTargetId);
        if (!target) return;
        const val = parseFloat(el.inputRangeStart.value);
        updateSelectedTargetRange(Number.isFinite(val) ? Math.max(0, val) : null, target.end_sec ?? null);
      });
    }
    if (el.inputRangeEnd) {
      el.inputRangeEnd.addEventListener("change", () => {
        const target = state.targets.find(t => t.id === state.selectedTargetId);
        if (!target) return;
        const val = parseFloat(el.inputRangeEnd.value);
        updateSelectedTargetRange(target.start_sec ?? null, Number.isFinite(val) ? Math.max(0.1, val) : null);
      });
    }

    if (el.btnQuickFacePreset) {
      el.btnQuickFacePreset.addEventListener("click", async () => {
        if (!state.activeMedia) return;
        setMaskRegion("face");
        setProtectionModeTab("faces");
        await detectFaces(state.scrubberSec, false);
      });
    }

    if (el.btnQuickEyesPreset) {
      el.btnQuickEyesPreset.addEventListener("click", async () => {
        if (!state.activeMedia) return;
        setMaskRegion("eyes");
        setProtectionModeTab("faces");
        const hasFaces = state.targets.some(t => t.label && t.label.startsWith("Face"));
        if (!hasFaces) {
          await detectFaces(state.scrubberSec, false);
        }
      });
    }

    if (el.btnUndoTarget) el.btnUndoTarget.addEventListener("click", undoEdit);
    if (el.btnClearCurrentTargets) {
      el.btnClearCurrentTargets.addEventListener("click", () => {
        if (!state.activeMedia) return;
        state.targets = [];
        state.selectedFocusId = null;
        state.selectedTargetId = null;
        saveCurrentMediaTargets();
        renderTargetsList();
        syncVideoRangeBar();
        drawOverlayBoxes();
        schedulePreview();
        el.censorStatusBadge.textContent = "Media Targets Cleared";
      });
    }

    // Protection Mode Switcher (Faces vs NSFW vs Objects)
    el.protectionModeSegments.forEach(btn => {
      btn.addEventListener("click", () => {
        el.protectionModeSegments.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        state.protectionMode = btn.dataset.mode;
        updateProtectionModeUI();
        if (state.activeMedia) {
          if (state.protectionMode === "nsfw" && !state.targets.some(t => String(t.id).startsWith("nsfw_"))) {
            detectNsfw(state.scrubberSec);
          } else if (state.protectionMode === "faces" && !state.targets.some(t => String(t.id).startsWith("face_"))) {
            detectFaces(state.scrubberSec);
          }
        }
        renderTargetsList();
        drawOverlayBoxes();
        schedulePreview();
      });
    });

    // Face Scope Switcher
    el.btnScopeMultiFace.addEventListener("click", () => {
      el.btnScopeMultiFace.classList.add("active");
      el.btnScopeSingleFace.classList.remove("active");
      state.faceScope = "multi";
      state.selectedFocusId = null;
      el.faceScopeBadge.textContent = "Multi-Face";
      el.singleFaceNotice.style.display = "none";
      state.targets.forEach(t => { if (t.label.startsWith("Face")) t.enabled = true; });
      renderTargetsList();
      drawOverlayBoxes();
      schedulePreview();
      scheduleHistoryRecord();
    });

    el.btnScopeSingleFace.addEventListener("click", () => {
      el.btnScopeSingleFace.classList.add("active");
      el.btnScopeMultiFace.classList.remove("active");
      state.faceScope = "single";
      el.faceScopeBadge.textContent = "Single Focus";
      el.singleFaceNotice.style.display = "block";
      const firstFace = state.targets.find(t => t.label.startsWith("Face"));
      if (firstFace) {
        state.selectedFocusId = firstFace.id;
        state.targets.forEach(t => {
          if (t.label.startsWith("Face")) t.enabled = (t.id === firstFace.id);
        });
      }
      renderTargetsList();
      drawOverlayBoxes();
      schedulePreview();
      scheduleHistoryRecord();
    });

    // Face Fit & Padding
    if (el.faceFitSegments) {
      el.faceFitSegments.forEach(btn => {
        btn.addEventListener("click", () => {
          el.faceFitSegments.forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
          state.maskConfig.face_fit = btn.dataset.fit || "standard";
          if (state.maskConfig.face_fit === "exact") {
            state.maskConfig.padding_percent = 0.0;
            if (el.sliderFacePadding) el.sliderFacePadding.value = "0";
            if (el.facePaddingVal) el.facePaddingVal.textContent = "0%";
          } else if (state.maskConfig.face_fit === "loose" && state.maskConfig.padding_percent < 0.25) {
            state.maskConfig.padding_percent = 0.25;
            if (el.sliderFacePadding) el.sliderFacePadding.value = "25";
            if (el.facePaddingVal) el.facePaddingVal.textContent = "+25%";
          }
          scheduleHistoryRecord();
          if (state.activeMedia && state.protectionMode === "faces") {
            detectFaces(state.scrubberSec, true);
          } else {
            schedulePreview();
          }
        });
      });
    }
    if (el.sliderFacePadding) {
      el.sliderFacePadding.addEventListener("input", (e) => {
        const pct = parseInt(e.target.value, 10) || 0;
        state.maskConfig.padding_percent = pct / 100.0;
        if (el.facePaddingVal) el.facePaddingVal.textContent = (pct > 0 ? `+${pct}%` : `${pct}%`);
        schedulePreview();
      });
      el.sliderFacePadding.addEventListener("change", () => {
        scheduleHistoryRecord();
        if (state.activeMedia && state.protectionMode === "faces") {
          detectFaces(state.scrubberSec, true);
        }
      });
    }

    // Face detection button
    el.btnAutoDetectFaces.addEventListener("click", () => detectFaces(state.scrubberSec));
    el.btnScanCurrentFrame.addEventListener("click", () => {
      if (state.protectionMode === "nsfw") detectNsfw(state.scrubberSec);
      else if (state.protectionMode === "faces") detectFaces(state.scrubberSec);
      else addDefaultObjectBox();
    });

    // NSFW Body Parts & Sensitivity
    if (el.nsfwPartsCheckboxes) {
      updateNsfwClassesFromDom();
      el.nsfwPartsCheckboxes.addEventListener("change", () => {
        updateNsfwClassesFromDom();
        scheduleHistoryRecord();
      });
    }
    const defaultNsfwSet = new Set([
      "FEMALE_GENITALIA_EXPOSED",
      "MALE_GENITALIA_EXPOSED",
      "FEMALE_BREAST_EXPOSED",
      "BUTTOCKS_EXPOSED",
      "ANUS_EXPOSED"
    ]);
    if (el.btnNsfwSelectDefaults && el.nsfwPartsCheckboxes) {
      el.btnNsfwSelectDefaults.addEventListener("click", () => {
        el.nsfwPartsCheckboxes.querySelectorAll('input[type="checkbox"]').forEach(cb => {
          cb.checked = defaultNsfwSet.has(cb.value);
        });
        updateNsfwClassesFromDom();
        scheduleHistoryRecord();
      });
    }
    if (el.btnNsfwSelectAll && el.nsfwPartsCheckboxes) {
      el.btnNsfwSelectAll.addEventListener("click", () => {
        el.nsfwPartsCheckboxes.querySelectorAll('input[type="checkbox"]').forEach(cb => {
          cb.checked = true;
        });
        updateNsfwClassesFromDom();
        scheduleHistoryRecord();
      });
    }
    if (el.checkNsfwExcludeFaces) {
      state.nsfwExcludeFaces = el.checkNsfwExcludeFaces.checked;
      el.checkNsfwExcludeFaces.addEventListener("change", (e) => {
        state.nsfwExcludeFaces = e.target.checked;
        scheduleHistoryRecord();
      });
    }

    const sensBtns = [el.btnNsfwLow, el.btnNsfwBalanced, el.btnNsfwHigh];
    sensBtns.forEach(btn => {
      btn.addEventListener("click", () => {
        sensBtns.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        state.nsfwSensitivity = parseFloat(btn.dataset.sens);
        scheduleHistoryRecord();
        if (state.activeMedia && state.protectionMode === "nsfw") {
          detectNsfw(state.scrubberSec);
        }
      });
    });

    el.btnScanNsfw.addEventListener("click", () => detectNsfw(state.scrubberSec));

    // Object Tag Segments
    el.objectTagSegments.forEach(btn => {
      btn.addEventListener("click", () => {
        el.objectTagSegments.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        state.selectedObjectTag = btn.dataset.tag;
        renderTargetsList();
        drawOverlayBoxes();
        schedulePreview();
      });
    });

    el.btnAddManualBox.addEventListener("click", addDefaultObjectBox);
    el.checkTrackCustomObject.addEventListener("change", scheduleHistoryRecord);

    el.btnClearAllTargets.addEventListener("click", () => {
      state.targets = [];
      state.selectedFocusId = null;
      state.selectedTargetId = null;
      saveCurrentMediaTargets();
      renderTargetsList();
      syncVideoRangeBar();
      drawOverlayBoxes();
      schedulePreview();
      el.censorStatusBadge.textContent = "All Targets Cleared";
    });

    // Scrubber for videos
    el.censorScrubber.addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      state.scrubberSec = val;
      el.censorScrubberTimeText.textContent = formatTime(val);
      invalidateRawPeek();
      if (state.activeMedia && state.activeMedia.media_type === "video") {
        if (state.protectionMode === "faces") {
          clearTimeout(state.scrubTimeout);
          state.scrubTimeout = setTimeout(() => detectFaces(val, true), 220);
          return;
        }
        if (state.protectionMode === "nsfw") {
          clearTimeout(state.scrubTimeout);
          state.scrubTimeout = setTimeout(() => detectNsfw(val, true), 220);
          return;
        }
      }
      schedulePreview();
    });

    // Mask Type Segmented Selector
    el.maskTypeSegments.forEach(btn => {
      btn.addEventListener("click", () => {
        el.maskTypeSegments.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        state.maskConfig.mask_type = btn.dataset.type;
        updateMaskStylePanels();
        schedulePreview();
      });
    });

    // 5 Mask Shapes
    if (el.maskShapeSegments) {
      el.maskShapeSegments.forEach(btn => {
        btn.addEventListener("click", () => {
          el.maskShapeSegments.forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
          state.maskConfig.shape = btn.dataset.shape || "oval";
          schedulePreview();
        });
      });
    }
    el.btnRegionFace.addEventListener("click", () => setMaskRegion("face"));
    el.btnRegionEyes.addEventListener("click", () => setMaskRegion("eyes"));

    // Intensity & Feather Sliders
    el.sliderIntensity.addEventListener("input", (e) => {
      const val = parseInt(e.target.value, 10);
      state.maskConfig.intensity = val;
      el.intensityVal.textContent = `${val}%`;
      schedulePreview();
    });
    if (el.sliderFeather) {
      el.sliderFeather.addEventListener("input", (e) => {
        const val = parseInt(e.target.value, 10) || 0;
        state.maskConfig.feather = val;
        if (el.featherVal) el.featherVal.textContent = `${val}%`;
        schedulePreview();
      });
    }

    // Emoji Search, Category Filter & Picker
    if (el.inputEmojiSearch) {
      el.inputEmojiSearch.addEventListener("input", (e) => {
        state.emojiSearch = (e.target.value || "").trim().toLowerCase();
        renderEmojiGrid();
      });
    }
    if (el.emojiCategoryTabs) {
      el.emojiCategoryTabs.forEach(tab => {
        tab.addEventListener("click", () => {
          el.emojiCategoryTabs.forEach(t => t.classList.remove("active"));
          tab.classList.add("active");
          state.emojiCategory = tab.dataset.cat || "all";
          renderEmojiGrid();
        });
      });
    }
    if (el.emojiGrid) {
      el.emojiGrid.addEventListener("click", (e) => {
        const btn = e.target.closest(".emoji-btn");
        if (!btn) return;
        el.emojiBtns = el.emojiGrid.querySelectorAll(".emoji-btn");
        el.emojiBtns.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        state.maskConfig.emoji_name = btn.dataset.emoji;
        state.maskConfig.custom_sticker_filename = null;
        schedulePreview();
      });
    }

    // Custom Sticker Upload
    el.btnUploadCustomSticker.addEventListener("click", () => {
      el.customStickerInput.value = "";
      el.customStickerInput.click();
    });
    el.customStickerInput.addEventListener("change", handleCustomStickerUpload);

    // Redaction text input
    el.inputRedactText.addEventListener("input", (e) => {
      state.maskConfig.redact_text = e.target.value;
      schedulePreview();
    });

    // Export Triggers
    el.btnHeaderExport.addEventListener("click", startCensorExport);
    el.btnCloseModal.addEventListener("click", closeModal);
  }

  function renderEmojiGrid() {
    if (!el.emojiGrid || !state.allEmojis.length) return;
    const cat = state.emojiCategory || "all";
    const q = state.emojiSearch || "";
    const filtered = state.allEmojis.filter(item => {
      const matchCat = cat === "all" || (item.category || "faces") === cat;
      const hay = `${item.id} ${item.label || ""}`.toLowerCase();
      const matchSearch = !q || hay.includes(q);
      return matchCat && matchSearch;
    });
    el.emojiGrid.replaceChildren();
    if (!filtered.length) {
      const msg = document.createElement("div");
      msg.style.cssText = "grid-column: 1 / -1; text-align: center; padding: 12px; color: var(--text-dim); font-size: 11px;";
      msg.textContent = "No matching 3D emojis";
      el.emojiGrid.appendChild(msg);
      return;
    }
    filtered.forEach((item) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "emoji-btn";
      if (item.id === state.maskConfig.emoji_name) btn.classList.add("active");
      btn.dataset.emoji = item.id;
      btn.title = item.label || item.id;
      const img = document.createElement("img");
      img.src = item.url || `/assets/emojis/${encodeURIComponent(item.id)}.png`;
      img.alt = item.label || item.id;
      img.loading = "lazy";
      btn.appendChild(img);
      el.emojiGrid.appendChild(btn);
    });
    el.emojiBtns = el.emojiGrid.querySelectorAll(".emoji-btn");
  }

  async function loadEmojiPack() {
    if (!el.emojiGrid) return;
    try {
      const res = await fetch("/assets/emojis/manifest.json");
      if (!res.ok) return;
      const data = await res.json();
      const items = Array.isArray(data.emojis) ? data.emojis : [];
      if (!items.length) return;
      state.allEmojis = items;
      renderEmojiGrid();
    } catch (err) {
      console.warn("Could not load emoji manifest:", err);
    }
  }

  function getEffectiveMaskConfig() {
    return Object.assign({}, state.maskConfig, {
      mask_region: state.protectionMode === "faces" ? (state.maskConfig.mask_region || "face") : "face"
    });
  }

  function updateProtectionModeUI() {
    el.panelFaceMode.style.display = (state.protectionMode === "faces") ? "flex" : "none";
    el.panelNsfwMode.style.display = (state.protectionMode === "nsfw") ? "flex" : "none";
    el.panelObjectMode.style.display = (state.protectionMode === "objects") ? "flex" : "none";

    const isFacesMode = state.protectionMode === "faces";
    if (!isFacesMode && state.maskConfig.mask_region !== "face") {
      state.maskConfig.mask_region = "face";
      if (el.btnRegionFace) el.btnRegionFace.classList.add("active");
      if (el.btnRegionEyes) el.btnRegionEyes.classList.remove("active");
    }
    if (el.groupMaskRegion) {
      el.groupMaskRegion.style.display = isFacesMode ? "block" : "none";
    }

    if (state.protectionMode === "faces") {
      el.censorHintText.textContent = "💡 Tip: Use Exact Visible for tight face contour masks, or Single Person Focus to mask only one person.";
      el.btnScanCurrentFrame.textContent = "🎯 Scan Current Frame";
    } else if (state.protectionMode === "nsfw") {
      el.censorHintText.textContent = "🛡️ Choose body parts above & scan, or rub fine details with Brush [B] / Eraser [E].";
      el.btnScanCurrentFrame.textContent = "🔎 Scan Body Parts Here";
    } else {
      el.censorHintText.textContent = "💡 Tip: Click and drag on the preview to draw a box around any license plate, document, or logo.";
      el.btnScanCurrentFrame.textContent = "🎯 Draw Object Box Here";
    }
  }

  function updateMaskStylePanels() {
    const type = state.maskConfig.mask_type;
    el.groupIntensity.style.display = (type === "blur" || type === "pixelate") ? "block" : "none";
    el.groupMaskShape.style.display = (type === "blur" || type === "pixelate" || type === "redact") ? "block" : "none";
    if (el.groupFeather) el.groupFeather.style.display = (type === "blur" || type === "pixelate") ? "block" : "none";
    el.groupEmoji.style.display = (type === "emoji") ? "block" : "none";
    el.groupRedactText.style.display = (type === "redact") ? "block" : "none";

    if (type === "blur") {
      el.labelIntensity.textContent = "Blur Intensity";
    } else if (type === "pixelate") {
      el.labelIntensity.textContent = "Pixel Block Size";
    }
  }

  function setProtectionModeTab(mode) {
    state.protectionMode = mode;
    el.protectionModeSegments.forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
    updateProtectionModeUI();
  }

  function setDrawTool(tool) {
    state.drawTool = tool;
    if (el.drawToolSegments) {
      el.drawToolSegments.forEach(b => b.classList.toggle("active", b.dataset.tool === tool));
    }
    if (el.brushSizeGroup) {
      el.brushSizeGroup.style.display = (tool === "brush" || tool === "eraser") ? "flex" : "none";
    }
    if (el.censorOverlayCanvas) {
      if (state.spacePressed) el.censorOverlayCanvas.style.cursor = "grab";
      else if (tool === "select") el.censorOverlayCanvas.style.cursor = "move";
      else if (tool === "brush" || tool === "eraser") el.censorOverlayCanvas.style.cursor = "none";
      else el.censorOverlayCanvas.style.cursor = "crosshair";
    }
    drawOverlayBoxes();
    if (el.censorHintText && state.activeMedia) {
      if (tool === "brush") {
        el.censorHintText.textContent = "🖌️ Brush [B]: Rub over any region to paint Blur/Pixelate. Adjust size with [ ] or Shift+Wheel.";
      } else if (tool === "eraser") {
        el.censorHintText.textContent = "🧽 Eraser [E]: Paint over brush strokes to subtract unwanted blurred areas.";
      } else if (tool === "select") {
        el.censorHintText.textContent = "👆 Select [V]: Click any target to set Video In/Out or drag corners to resize boxes.";
      } else {
        el.censorHintText.textContent = "▭ Box [R]: Click and drag anywhere on the preview to create a custom censor region.";
      }
    }
  }

  function formatApiError(errData, fallback) {
    if (!errData || errData.detail == null) return fallback;
    if (typeof errData.detail === "string") return errData.detail;
    if (Array.isArray(errData.detail)) {
      const parts = errData.detail.map(item => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const loc = Array.isArray(item.loc) ? item.loc.slice(1).join(".") : "";
          const msg = item.msg || JSON.stringify(item);
          return loc ? `${loc}: ${msg}` : msg;
        }
        return String(item);
      });
      return parts.join("; ") || fallback;
    }
    try { return JSON.stringify(errData.detail); } catch (_) { return fallback; }
  }

  function toApiBox(t) {
    const safeBrushRadius = Math.min(2000, Math.max(1, Number(t.brush_radius) || 24));
    const safeEraserRadius = Math.min(2000, Math.max(1, Number(t.eraser_radius) || 24));
    return {
      x: Math.round(t.x),
      y: Math.round(t.y),
      w: Math.max(1, Math.round(t.w)),
      h: Math.max(1, Math.round(t.h)),
      confidence: t.confidence ?? 1.0,
      label: t.label || "Custom Area",
      track_id: t.track_id || null,
      landmarks: t.landmarks || [],
      kind: t.kind === "brush" ? "brush" : "box",
      brush_points: t.kind === "brush" && Array.isArray(t.brush_points) ? t.brush_points : null,
      brush_radius: safeBrushRadius,
      eraser_points: t.kind === "brush" && Array.isArray(t.eraser_points) && t.eraser_points.length ? t.eraser_points : null,
      eraser_radius: safeEraserRadius,
      start_sec: t.start_sec != null ? Number(t.start_sec) : null,
      end_sec: t.end_sec != null ? Number(t.end_sec) : null,
      mask_type: t.mask_type || null
    };
  }

  function saveCurrentMediaTargets() {
    if (!state.activeMedia) return;
    state.targetsByFile[state.activeMedia.id] = {
      targets: state.targets,
      selectedFocusId: state.selectedFocusId
    };
    renderBatchQueue();
  }

  function setMaskRegion(region) {
    state.maskConfig.mask_region = region;
    el.btnRegionFace.classList.toggle("active", region === "face");
    el.btnRegionEyes.classList.toggle("active", region === "eyes");
    schedulePreview();
  }

  function makeHistorySnapshot() {
    return JSON.stringify({
      protectionMode: state.protectionMode,
      faceScope: state.faceScope,
      selectedFocusId: state.selectedFocusId,
      nsfwSensitivity: state.nsfwSensitivity,
      nsfwClasses: state.nsfwClasses,
      nsfwExcludeFaces: state.nsfwExcludeFaces,
      selectedObjectTag: state.selectedObjectTag,
      targets: state.targets,
      maskConfig: state.maskConfig,
      scrubberSec: state.scrubberSec,
      trackCustomObjects: el.checkTrackCustomObject.checked
    });
  }

  function scheduleHistoryRecord() {
    clearTimeout(state.historyTimeout);
    state.historyTimeout = setTimeout(recordHistoryChange, 300);
  }

  function recordHistoryChange() {
    clearTimeout(state.historyTimeout);
    const next = makeHistorySnapshot();
    if (next === state.historySnapshot) return;
    if (state.historySnapshot !== null) {
      state.undoStack.push(state.historySnapshot);
      if (state.undoStack.length > 100) state.undoStack.shift();
    }
    state.historySnapshot = next;
    state.redoStack = [];
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    if (el.btnUndo && el.btnRedo) {
      el.btnUndo.disabled = state.undoStack.length === 0;
      el.btnRedo.disabled = state.redoStack.length === 0;
    }
    if (el.btnUndoTarget) {
      el.btnUndoTarget.disabled = state.undoStack.length === 0 || state.exportBusy;
    }
  }

  function applyHistorySnapshot(snapshot) {
    const data = JSON.parse(snapshot);
    state.protectionMode = data.protectionMode;
    state.faceScope = data.faceScope;
    state.selectedFocusId = data.selectedFocusId;
    state.nsfwSensitivity = data.nsfwSensitivity;
    if (Array.isArray(data.nsfwClasses)) state.nsfwClasses = data.nsfwClasses;
    if (typeof data.nsfwExcludeFaces === "boolean") state.nsfwExcludeFaces = data.nsfwExcludeFaces;
    state.selectedObjectTag = data.selectedObjectTag;
    state.targets = data.targets || [];
    state.maskConfig = Object.assign({
      mask_type: "blur", intensity: 60, feather: 25, emoji_name: "sunglasses",
      custom_sticker_filename: null, redact_text: "[CENSORED]", shape: "oval",
      mask_region: "face", face_fit: "standard", padding_percent: 0.20
    }, data.maskConfig || {});
    state.scrubberSec = data.scrubberSec || 0;
    el.checkTrackCustomObject.checked = data.trackCustomObjects;

    el.protectionModeSegments.forEach(button => button.classList.toggle("active", button.dataset.mode === state.protectionMode));
    el.btnScopeMultiFace.classList.toggle("active", state.faceScope === "multi");
    el.btnScopeSingleFace.classList.toggle("active", state.faceScope === "single");
    el.faceScopeBadge.textContent = state.faceScope === "multi" ? "Multi-Face" : "Single Focus";
    el.singleFaceNotice.style.display = state.faceScope === "single" ? "block" : "none";
    if (el.faceFitSegments) {
      el.faceFitSegments.forEach(b => b.classList.toggle("active", b.dataset.fit === state.maskConfig.face_fit));
    }
    if (el.sliderFacePadding) {
      const pct = Math.round((state.maskConfig.padding_percent ?? 0.20) * 100);
      el.sliderFacePadding.value = pct;
      if (el.facePaddingVal) el.facePaddingVal.textContent = pct > 0 ? `+${pct}%` : `${pct}%`;
    }
    if (el.nsfwPartsCheckboxes) {
      const set = new Set(state.nsfwClasses);
      el.nsfwPartsCheckboxes.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = set.has(cb.value);
      });
    }
    if (el.checkNsfwExcludeFaces) el.checkNsfwExcludeFaces.checked = state.nsfwExcludeFaces;
    [el.btnNsfwLow, el.btnNsfwBalanced, el.btnNsfwHigh].forEach(button => button.classList.toggle("active", Number(button.dataset.sens) === Number(state.nsfwSensitivity)));
    el.objectTagSegments.forEach(button => button.classList.toggle("active", button.dataset.tag === state.selectedObjectTag));
    el.maskTypeSegments.forEach(button => button.classList.toggle("active", button.dataset.type === state.maskConfig.mask_type));
    if (el.maskShapeSegments) {
      el.maskShapeSegments.forEach(b => b.classList.toggle("active", b.dataset.shape === state.maskConfig.shape));
    }
    state.maskConfig.mask_region = state.maskConfig.mask_region || "face";
    el.btnRegionFace.classList.toggle("active", state.maskConfig.mask_region === "face");
    el.btnRegionEyes.classList.toggle("active", state.maskConfig.mask_region === "eyes");
    el.emojiBtns.forEach(button => button.classList.toggle("active", button.dataset.emoji === state.maskConfig.emoji_name));
    el.sliderIntensity.value = state.maskConfig.intensity;
    el.intensityVal.textContent = `${state.maskConfig.intensity}%`;
    if (el.sliderFeather) {
      el.sliderFeather.value = state.maskConfig.feather ?? 25;
      if (el.featherVal) el.featherVal.textContent = `${state.maskConfig.feather ?? 25}%`;
    }
    el.inputRedactText.value = state.maskConfig.redact_text || "";
    if (state.activeMedia && state.activeMedia.media_type === "video") {
      el.censorScrubber.value = state.scrubberSec;
      el.censorScrubberTimeText.textContent = formatTime(state.scrubberSec);
    }
    updateProtectionModeUI();
    updateMaskStylePanels();
    saveCurrentMediaTargets();
    renderTargetsList();
    syncVideoRangeBar();
    drawOverlayBoxes();
    state.historySnapshot = makeHistorySnapshot();
    updateHistoryButtons();
    schedulePreview();
  }

  function undoEdit() {
    recordHistoryChange();
    if (!state.undoStack.length) return;
    state.redoStack.push(state.historySnapshot);
    applyHistorySnapshot(state.undoStack.pop());
  }

  function redoEdit() {
    recordHistoryChange();
    if (!state.redoStack.length) return;
    state.undoStack.push(state.historySnapshot);
    applyHistorySnapshot(state.redoStack.pop());
  }

  function renderBatchQueue() {
    if (!el.censorBatchPanel || !el.censorBatchList) return;
    if (state.mediaQueue.length === 0) {
      el.censorBatchPanel.style.display = "none";
      return;
    }
    const isVideoQueue = state.mediaQueue.some(m => m.media_type === "video");
    el.censorBatchPanel.style.display = "flex";
    const selectedCount = state.mediaQueue.filter(m => state.selectedBatchIds.has(m.id)).length;
    const noun = isVideoQueue ? (state.mediaQueue.length === 1 ? "video" : "videos") : (state.mediaQueue.length === 1 ? "photo" : "photos");
    if (el.censorBatchCount) {
      el.censorBatchCount.textContent = state.mediaQueue.length > 1
        ? `${selectedCount}/${state.mediaQueue.length} ${noun} selected`
        : `1 ${noun} loaded`;
    }
    if (el.btnBatchSelectAll) {
      const allSel = state.mediaQueue.length > 0 && selectedCount === state.mediaQueue.length;
      el.btnBatchSelectAll.textContent = allSel ? "Unselect" : "All";
    }

    el.censorBatchList.innerHTML = "";
    state.mediaQueue.forEach(item => {
      const isCurrent = state.activeMedia && state.activeMedia.id === item.id;
      const isChecked = state.selectedBatchIds.has(item.id);
      const saved = item.id === (state.activeMedia && state.activeMedia.id)
        ? state.targets
        : ((state.targetsByFile[item.id] && state.targetsByFile[item.id].targets) || []);
      const activeCnt = saved.filter(t => t.enabled).length;
      const durText = item.media_type === "video" && item.duration ? ` • ${formatTime(item.duration)}` : "";

      const card = document.createElement("div");
      card.className = "censor-batch-card" + (isCurrent ? " active" : "");
      card.innerHTML = `
        <input type="checkbox" ${isChecked ? "checked" : ""} aria-label="Include ${item.filename}" style="flex:0 0 auto; cursor:pointer;">
        <img class="censor-batch-thumb" src="${item.thumb_url || ""}" alt="">
        <div class="censor-batch-meta">
          <div class="censor-batch-name" title="${item.filename}">${item.filename}</div>
          <div class="censor-batch-badge">${activeCnt} region${activeCnt === 1 ? "" : "s"}${durText}</div>
        </div>
        <button type="button" class="censor-batch-remove" title="Remove item from batch">×</button>
      `;

      const cb = card.querySelector('input[type="checkbox"]');
      cb.addEventListener("click", (ev) => ev.stopPropagation());
      cb.addEventListener("change", (ev) => {
        if (ev.target.checked) state.selectedBatchIds.add(item.id);
        else state.selectedBatchIds.delete(item.id);
        renderBatchQueue();
        syncMediaActionButtons();
      });

      const removeBtn = card.querySelector(".censor-batch-remove");
      removeBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        removeBatchItem(item.id);
      });

      card.addEventListener("click", () => {
        if (!state.activeMedia || state.activeMedia.id !== item.id) {
          switchActiveMedia(item.id);
        }
      });

      el.censorBatchList.appendChild(card);
    });

    if (el.btnHeaderExport) {
      if (selectedCount > 1) {
        el.btnHeaderExport.textContent = isVideoQueue
          ? `Export ${selectedCount} Videos (ZIP)`
          : `Export ${selectedCount} Photos (ZIP)`;
      } else {
        el.btnHeaderExport.textContent = "Export Protected File";
      }
    }
  }

  function removeBatchItem(fileId) {
    const idx = state.mediaQueue.findIndex(m => m.id === fileId);
    if (idx === -1) return;
    const wasActive = state.activeMedia && state.activeMedia.id === fileId;
    state.mediaQueue.splice(idx, 1);
    state.selectedBatchIds.delete(fileId);
    delete state.targetsByFile[fileId];

    if (state.mediaQueue.length === 0) {
      state.activeMedia = null;
      state.targets = [];
      state.selectedFocusId = null;
      state.selectedTargetId = null;
      el.mediaDetailsPanel.style.display = "none";
      if (el.censorDrawBar) el.censorDrawBar.style.display = "none";
      if (el.videoTargetRangeBar) el.videoTargetRangeBar.style.display = "none";
      el.censorEmptyPrompt.style.display = "flex";
      el.censorPreviewImg.style.display = "none";
      if (el.censorOriginalImg) {
        el.censorOriginalImg.style.display = "none";
        el.censorOriginalImg.removeAttribute("src");
      }
      el.censorOverlayCanvas.style.display = "none";
      el.censorStatusBadge.textContent = "Awaiting Media";
      if (el.btnHeaderExport) el.btnHeaderExport.textContent = "Export Protected File";
      renderTargetsList();
      renderBatchQueue();
      syncMediaActionButtons();
      return;
    }

    if (wasActive) {
      const next = state.mediaQueue[Math.min(idx, state.mediaQueue.length - 1)];
      state.activeMedia = null; // avoid overwriting deleted entry in switchActiveMedia
      switchActiveMedia(next.id);
    } else {
      renderBatchQueue();
      syncMediaActionButtons();
    }
  }

  function invalidateRawPeek() {
    state.rawPeekKey = null;
    if (el.censorOriginalImg) {
      el.censorOriginalImg.removeAttribute("src");
      el.censorOriginalImg.style.display = "none";
    }
  }

  async function refreshRawFrameForPeek() {
    if (!state.activeMedia || !el.censorOriginalImg) return;
    const peekKey = `${state.activeMedia.id}_${Number(state.scrubberSec || 0).toFixed(3)}`;
    if (state.rawPeekKey === peekKey && el.censorOriginalImg.getAttribute("src")) return;
    if (state.rawPeekInFlightKey === peekKey) return;
    state.rawPeekInFlightKey = peekKey;
    try {
      const res = await fetch("/api/censor/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_id: state.activeMedia.id,
          frame_sec: state.scrubberSec,
          boxes: [],
          mask_config: getEffectiveMaskConfig(),
          preview_revision: 0,
          session_id: window.STUDIO_TAB_SESSION_ID || null
        })
      });
      if (!res.ok) return;
      const data = await res.json();
      const currentKey = state.activeMedia
        ? `${state.activeMedia.id}_${Number(state.scrubberSec || 0).toFixed(3)}`
        : null;
      if (data && data.preview_url && el.censorOriginalImg && currentKey === peekKey) {
        state.rawPeekKey = peekKey;
        el.censorOriginalImg.src = data.preview_url;
        if (state.peekingOriginal) {
          el.censorOriginalImg.style.display = "block";
        }
      }
    } catch (_) {
    } finally {
      if (state.rawPeekInFlightKey === peekKey) state.rawPeekInFlightKey = null;
    }
  }

  function switchActiveMedia(fileId) {
    if (state.activeMedia && state.activeMedia.id !== fileId) {
      saveCurrentMediaTargets();
    }
    const nextMedia = state.mediaQueue.find(m => m.id === fileId);
    if (!nextMedia) return;

    state.activeMedia = nextMedia;
    const entry = state.targetsByFile[fileId] || { targets: [], selectedFocusId: null };
    state.targets = entry.targets || [];
    state.selectedFocusId = entry.selectedFocusId || null;
    state.selectedTargetId = null;
    state.scrubberSec = 0;
    state.isDrawing = false;
    state.activeBrushPoints = [];
    state.undoStack = [];
    state.redoStack = [];
    adjustZoom(0, true);
    state.historySnapshot = makeHistorySnapshot();
    updateHistoryButtons();

    const isVideo = nextMedia.media_type === "video";
    el.mediaDetailsPanel.style.display = "flex";
    el.mediaNameLabel.textContent = nextMedia.filename;
    el.mediaDimensionsBadge.textContent = isVideo && nextMedia.duration
      ? `${nextMedia.width}×${nextMedia.height} • ${formatTime(nextMedia.duration)}`
      : `${nextMedia.width}×${nextMedia.height}`;
    el.censorScrubberPanel.style.display = isVideo ? "block" : "none";
    if (isVideo) {
      el.censorScrubber.max = nextMedia.duration || 10;
      el.censorScrubber.value = 0;
      el.censorScrubberTimeText.textContent = "0:00.0";
    }
    if (el.censorDrawBar) el.censorDrawBar.style.display = "flex";
    if (el.btnToolBrush) el.btnToolBrush.style.display = "";
    if (el.btnToolEraser) el.btnToolEraser.style.display = "";
    if (el.quickPhotoPresetsGroup) el.quickPhotoPresetsGroup.style.display = "flex";

    el.censorEmptyPrompt.style.display = "none";
    el.censorPreviewImg.style.display = "block";
    el.censorOverlayCanvas.style.display = "block";

    invalidateRawPeek();
    renderBatchQueue();
    renderTargetsList();
    syncVideoRangeBar();
    drawOverlayBoxes();
    fetchLivePreview();
    syncMediaActionButtons();
  }

  async function applyBatchPreset(preset) {
    const selected = state.mediaQueue.filter(m => state.selectedBatchIds.has(m.id));
    const targets = selected.length > 0 ? selected : state.mediaQueue;
    if (!targets.length) return;

    saveCurrentMediaTargets();
    if (preset === "eyes") {
      setMaskRegion("eyes");
      setProtectionModeTab("faces");
    } else if (preset === "faces") {
      setMaskRegion("face");
      setProtectionModeTab("faces");
    } else if (preset === "nsfw") {
      setMaskRegion("face");
      setProtectionModeTab("nsfw");
    }

    const endpoint = preset === "nsfw" ? "/api/censor/detect-nsfw" : "/api/censor/detect-faces";
    const batchBtns = [el.btnBatchApplyFaces, el.btnBatchApplyEyes, el.btnBatchApplyNsfw].filter(Boolean);
    batchBtns.forEach(b => { b.disabled = true; });

    let totalAdded = 0;
    try {
      for (let i = 0; i < targets.length; i++) {
        const item = targets[i];
        el.censorStatusBadge.textContent = `Scanning ${i + 1}/${targets.length}: ${item.filename}`;
        const payload = preset === "nsfw"
          ? {
              file_id: item.id,
              frame_sec: 0.0,
              sensitivity: state.nsfwSensitivity,
              nsfw_classes: state.nsfwClasses,
              exclude_faces: state.nsfwExcludeFaces
            }
          : {
              file_id: item.id,
              frame_sec: 0.0,
              face_fit: state.maskConfig.face_fit || "standard",
              padding_percent: state.maskConfig.padding_percent ?? 0.20
            };
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!res.ok) continue;
        const data = await res.json();
        const prev = (state.targetsByFile[item.id] && state.targetsByFile[item.id].targets) || [];

        if (preset === "nsfw") {
          const keepOther = prev.filter(t => !String(t.id).startsWith("nsfw_"));
          const detected = (data.candidates || []).map((c, idx) => ({
            id: "nsfw_" + Date.now() + "_" + i + "_" + idx,
            kind: "box",
            x: c.x, y: c.y, w: c.w, h: c.h,
            confidence: c.confidence,
            label: c.label || `NSFW Zone #${idx + 1}`,
            enabled: true
          }));
          totalAdded += detected.length;
          state.targetsByFile[item.id] = { targets: [...keepOther, ...detected], selectedFocusId: null };
        } else {
          const keepManual = prev.filter(t => !String(t.id).startsWith("face_"));
          const detected = (data.faces || []).map((f, idx) => ({
            id: "face_" + Date.now() + "_" + i + "_" + idx,
            kind: "box",
            x: f.x, y: f.y, w: f.w, h: f.h,
            confidence: f.confidence,
            track_id: f.track_id,
            landmarks: f.landmarks || [],
            label: `Face #${idx + 1} (${Math.round(f.confidence * 100)}%)`,
            enabled: true
          }));
          totalAdded += detected.length;
          state.targetsByFile[item.id] = { targets: [...detected, ...keepManual], selectedFocusId: null };
        }

        if (state.activeMedia && state.activeMedia.id === item.id) {
          state.targets = state.targetsByFile[item.id].targets;
          state.selectedFocusId = state.targetsByFile[item.id].selectedFocusId;
        }
      }

      renderBatchQueue();
      renderTargetsList();
      drawOverlayBoxes();
      schedulePreview();
      el.censorStatusBadge.textContent = `${preset.toUpperCase()}: ${totalAdded} target(s) across ${targets.length} file(s)`;
    } catch (err) {
      alert("Batch scan error: " + err.message);
      el.censorStatusBadge.textContent = "Batch Scan Error";
    } finally {
      batchBtns.forEach(b => { b.disabled = false; });
      syncMediaActionButtons();
    }
  }

  async function uploadMediaFile(file) {
    return uploadMediaFiles([file], false);
  }

  async function uploadMediaFiles(fileList, append = false) {
    const files = Array.from(fileList || []).filter(Boolean);
    if (files.length === 0) return;

    el.censorStatusBadge.textContent = files.length > 1 ? `Uploading ${files.length} files...` : "Uploading...";
    const formData = new FormData();
    files.forEach(f => formData.append("files", f));

    const sessionId = window.STUDIO_TAB_SESSION_ID || null;
    if (sessionId) {
      formData.append("session_id", sessionId);
    }

    try {
      const res = await fetch("/api/upload-media", {
        method: "POST",
        body: formData
      });
      if (!res.ok) throw new Error("Upload failed with status " + res.status);
      const data = await res.json();
      if (!data.media || data.media.length === 0) throw new Error("No media returned by server");

      const uploadedImages = data.media.filter(m => m.media_type === "image");
      const uploadedVideos = data.media.filter(m => m.media_type === "video");
      const primaryGroup = state.mediaSubTab === "videos"
        ? (uploadedVideos.length > 0 ? uploadedVideos : uploadedImages)
        : (uploadedImages.length > 0 ? uploadedImages : uploadedVideos);

      if (primaryGroup[0] && primaryGroup[0].media_type === "video") {
        applyMediaSubTab("videos");
      } else if (primaryGroup[0]) {
        applyMediaSubTab("images");
      }

      const activeType = state.mediaQueue[0] ? state.mediaQueue[0].media_type : null;
      if (append && primaryGroup.length > 0 && activeType === primaryGroup[0].media_type) {
        saveCurrentMediaTargets();
        primaryGroup.forEach(item => {
          state.mediaQueue.push(item);
          state.selectedBatchIds.add(item.id);
          state.targetsByFile[item.id] = { targets: [], selectedFocusId: null };
        });
        switchActiveMedia(primaryGroup[0].id);
        if (state.protectionMode === "nsfw") await detectNsfw(0.0);
        else await detectFaces(0.0);
        return;
      }

      state.mediaQueue = primaryGroup;
      state.selectedBatchIds = new Set(primaryGroup.map(m => m.id));
      state.targetsByFile = {};
      primaryGroup.forEach(item => {
        state.targetsByFile[item.id] = { targets: [], selectedFocusId: null };
      });
      state.activeMedia = primaryGroup[0];

      syncMediaActionButtons();
      state.targets = [];
      state.selectedFocusId = null;
      state.selectedTargetId = null;
      state.scrubberSec = 0;
      state.isDrawing = false;
      state.activeBrushPoints = [];
      state.previewRequestId += 1;
      state.undoStack = [];
      state.redoStack = [];
      adjustZoom(0, true);
      state.historySnapshot = makeHistorySnapshot();
      updateHistoryButtons();

      const isVideo = state.activeMedia.media_type === "video";
      el.mediaDetailsPanel.style.display = "flex";
      el.mediaNameLabel.textContent = state.activeMedia.filename;
      el.mediaDimensionsBadge.textContent = isVideo && state.activeMedia.duration
        ? `${state.activeMedia.width}×${state.activeMedia.height} • ${formatTime(state.activeMedia.duration)}`
        : `${state.activeMedia.width}×${state.activeMedia.height}`;

      if (el.censorDrawBar) el.censorDrawBar.style.display = "flex";
      if (el.btnToolBrush) el.btnToolBrush.style.display = "";
      if (el.btnToolEraser) el.btnToolEraser.style.display = "";
      if (el.quickPhotoPresetsGroup) el.quickPhotoPresetsGroup.style.display = "flex";
      setDrawTool(state.drawTool);

      if (isVideo) {
        el.censorScrubberPanel.style.display = "block";
        el.censorScrubber.max = state.activeMedia.duration || 10;
        el.censorScrubber.value = 0;
        el.censorScrubberTimeText.textContent = "0:00.0";
      } else {
        el.censorScrubberPanel.style.display = "none";
      }

      el.censorEmptyPrompt.style.display = "none";
      el.censorPreviewImg.style.display = "block";
      el.censorOverlayCanvas.style.display = "block";
      invalidateRawPeek();
      renderBatchQueue();
      syncVideoRangeBar();

      if (state.protectionMode === "nsfw") {
        await detectNsfw(0.0);
      } else {
        await detectFaces(0.0);
      }

      if (state.mediaQueue.length > 1) {
        const restIds = state.mediaQueue.slice(1);
        const endpoint = state.protectionMode === "nsfw" ? "/api/censor/detect-nsfw" : "/api/censor/detect-faces";
        for (let i = 0; i < restIds.length; i++) {
          const item = restIds[i];
          try {
            const payload = state.protectionMode === "nsfw"
              ? {
                  file_id: item.id, frame_sec: 0.0, sensitivity: state.nsfwSensitivity,
                  nsfw_classes: state.nsfwClasses, exclude_faces: state.nsfwExcludeFaces
                }
              : {
                  file_id: item.id, frame_sec: 0.0,
                  face_fit: state.maskConfig.face_fit || "standard",
                  padding_percent: state.maskConfig.padding_percent ?? 0.20
                };
            const r = await fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload)
            });
            if (!r.ok) continue;
            const d = await r.json();
            if (state.protectionMode === "nsfw") {
              state.targetsByFile[item.id] = {
                targets: (d.candidates || []).map((c, idx) => ({
                  id: "nsfw_" + Date.now() + "_" + i + "_" + idx,
                  kind: "box", x: c.x, y: c.y, w: c.w, h: c.h,
                  confidence: c.confidence, label: c.label || `NSFW Zone #${idx + 1}`, enabled: true
                })),
                selectedFocusId: null
              };
            } else {
              state.targetsByFile[item.id] = {
                targets: (d.faces || []).map((f, idx) => ({
                  id: "face_" + Date.now() + "_" + i + "_" + idx,
                  kind: "box", x: f.x, y: f.y, w: f.w, h: f.h,
                  confidence: f.confidence, track_id: f.track_id, landmarks: f.landmarks || [],
                  label: `Face #${idx + 1} (${Math.round(f.confidence * 100)}%)`, enabled: true
                })),
                selectedFocusId: null
              };
            }
          } catch (_) {}
        }
        renderBatchQueue();
      }
    } catch (err) {
      alert("Error uploading media: " + err.message);
      el.censorStatusBadge.textContent = "Upload Error";
    }
  }

  async function detectFaces(frameSec = 0.0, silent = false) {
    if (!state.activeMedia) return;
    if (!silent) {
      el.btnAutoDetectFaces.disabled = true;
      el.btnAutoDetectFaces.textContent = "⏳ Scanning YuNet...";
    }
    el.censorStatusBadge.textContent = state.activeMedia.media_type === "video" && frameSec > 0
      ? `Scanning faces at ${formatTime(frameSec)}...`
      : "Scanning Faces...";

    try {
      const res = await fetch("/api/censor/detect-faces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_id: state.activeMedia.id,
          frame_sec: frameSec,
          face_fit: state.maskConfig.face_fit || "standard",
          padding_percent: state.maskConfig.padding_percent ?? 0.20
        })
      });
      if (!res.ok) throw new Error("Face detection request failed");
      const data = await res.json();

      const existingOther = state.targets.filter(t => !String(t.id).startsWith("face_"));
      const previousFocus = state.targets.find(t => t.id === state.selectedFocusId);
      const newFaces = (data.faces || []).map((f, idx) => ({
        id: "face_" + Date.now() + "_" + idx,
        x: f.x,
        y: f.y,
        w: f.w,
        h: f.h,
        confidence: f.confidence,
        track_id: f.track_id,
        landmarks: f.landmarks || [],
        label: `Face #${idx + 1} (${Math.round(f.confidence * 100)}%)`,
        enabled: (state.faceScope === "multi" || idx === 0)
      }));

      if (state.faceScope === "single") {
        let focusedFace = null;
        if (previousFocus && newFaces.length > 0) {
          let bestDist = Infinity;
          const pcx = previousFocus.x + previousFocus.w / 2;
          const pcy = previousFocus.y + previousFocus.h / 2;
          for (const face of newFaces) {
            const d = Math.hypot((face.x + face.w / 2) - pcx, (face.y + face.h / 2) - pcy);
            if (d < bestDist) {
              bestDist = d;
              focusedFace = face;
            }
          }
        } else {
          focusedFace = newFaces[0] || null;
        }
        state.selectedFocusId = focusedFace ? focusedFace.id : null;
        newFaces.forEach(face => { face.enabled = !!focusedFace && face.id === focusedFace.id; });
      } else {
        state.selectedFocusId = null;
      }

      state.targets = [...newFaces, ...existingOther];
      saveCurrentMediaTargets();
      renderTargetsList();
      drawOverlayBoxes();
      schedulePreview();
      el.censorStatusBadge.textContent = `${state.targets.length} Target(s) Ready`;
    } catch (err) {
      if (!silent) alert("Face detection error: " + err.message);
      el.censorStatusBadge.textContent = "Detection Failed";
    } finally {
      if (!silent) {
        el.btnAutoDetectFaces.disabled = false;
        el.btnAutoDetectFaces.textContent = "🔍 Auto-Detect Faces (YuNet)";
      }
      syncMediaActionButtons();
    }
  }

  async function detectNsfw(frameSec = 0.0, silent = false) {
    if (!state.activeMedia) return;
    updateNsfwClassesFromDom();
    if (!silent) {
      el.btnScanNsfw.disabled = true;
      el.btnScanNsfw.textContent = "⏳ Scanning Body Parts...";
    }
    el.censorStatusBadge.textContent = "Scanning Body Parts...";

    try {
      const res = await fetch("/api/censor/detect-nsfw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_id: state.activeMedia.id,
          frame_sec: frameSec,
          sensitivity: state.nsfwSensitivity,
          nsfw_classes: state.nsfwClasses,
          exclude_faces: state.nsfwExcludeFaces
        })
      });
      if (!res.ok) throw new Error("NSFW scan request failed");
      const data = await res.json();

      if (el.nsfwDetectorBadge && data.detector) {
        const isOnnx = data.detector === "nudenet_onnx";
        el.nsfwDetectorBadge.textContent = isOnnx ? "NudeNet v3 ONNX" : "Skin Heuristic Fallback";
      }

      const existingOther = state.targets.filter(t => !String(t.id).startsWith("nsfw_"));
      const newNsfw = (data.candidates || []).map((c, idx) => ({
        id: "nsfw_" + Date.now() + "_" + idx,
        x: c.x,
        y: c.y,
        w: c.w,
        h: c.h,
        confidence: c.confidence,
        label: c.label || `NSFW Zone #${idx + 1}`,
        enabled: true
      }));

      state.targets = [...existingOther, ...newNsfw];
      saveCurrentMediaTargets();
      renderTargetsList();
      drawOverlayBoxes();
      schedulePreview();
      el.censorStatusBadge.textContent = `${newNsfw.length} Body Region(s) Found`;
      if (data.warning) el.censorStatusBadge.title = data.warning;
    } catch (err) {
      if (!silent) alert("NSFW scan error: " + err.message);
      el.censorStatusBadge.textContent = "Scan Failed";
    } finally {
      if (!silent) {
        el.btnScanNsfw.disabled = false;
        el.btnScanNsfw.textContent = "🛡️ Scan Sensitive Body Parts";
      }
    }
  }

  function addDefaultObjectBox() {
    if (!state.activeMedia) return;
    setDrawTool("box");
    state.manualDrawArmed = true;
    el.censorHintText.textContent = "Drag a box around the object in the preview. The box is added to Protected Targets.";
    el.censorStatusBadge.textContent = "Ready to draw object box";
    el.censorStageViewport.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function targetBelongsToMode(target) {
    if (target.kind === "brush" || (target.label && (target.label.startsWith("Brush") || target.label.startsWith("Custom Area") || target.label.startsWith("Manual Box")))) {
      return true;
    }
    if (state.protectionMode === "faces") {
      return String(target.id).startsWith("face_") || target.label.startsWith("Face") || target.label.startsWith("Custom Face");
    }
    if (state.protectionMode === "nsfw") {
      return String(target.id).startsWith("nsfw_") || target.label.startsWith("Skin Region") || target.label.startsWith("NSFW") || target.label.startsWith("NudeNet");
    }
    return target.label.startsWith(state.selectedObjectTag || "License Plate");
  }

  function renderTargetsList() {
    syncMediaActionButtons();
    el.targetsContainer.innerHTML = "";
    const activeCount = state.targets.filter(t => t.enabled && targetBelongsToMode(t)).length;
    el.targetCountBadge.textContent = `${activeCount} active`;

    if (state.targets.length === 0) {
      el.targetsContainer.innerHTML = `
        <div style="text-align: center; color: var(--text-dim); padding: 20px 8px; font-size: 12px;">
          No targets selected yet.<br>Choose a task above to begin!
        </div>
      `;
      syncVideoRangeBar();
      return;
    }

    const maskOpts = [
      { value: "", label: "Global" },
      { value: "blur", label: "Blur" },
      { value: "pixelate", label: "Pixel" },
      { value: "emoji", label: "Emoji" },
      { value: "redact", label: "Redact" }
    ];

    state.targets.forEach((t, idx) => {
      const isFocused = (state.faceScope === "single" && t.id === state.selectedFocusId);
      const isSelected = t.id === state.selectedTargetId;
      const row = document.createElement("div");
      row.className = "target-item" + (isFocused ? " selected-focus" : "") + (isSelected ? " active" : "");
      if (isSelected) row.style.borderColor = "var(--accent-cyan)";

      const rangeText = (t.start_sec != null || t.end_sec != null)
        ? ` (${t.start_sec != null ? Number(t.start_sec).toFixed(1) : "0.0"}–${t.end_sec != null ? Number(t.end_sec).toFixed(1) : "end"}s)`
        : "";
      const selectOptions = maskOpts.map(o =>
        `<option value="${o.value}" ${(t.mask_type || "") === o.value ? "selected" : ""}>${o.label}</option>`
      ).join("");

      row.innerHTML = `
        <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; flex: 1; min-width: 0;">
          <input type="checkbox" ${t.enabled ? "checked" : ""} data-idx="${idx}">
          <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; ${isFocused ? 'color: var(--accent-cyan); font-weight: 700;' : ''}">${t.label}${rangeText} ${isFocused ? '★' : ''}</span>
        </label>
        <select class="target-mask-select" data-mask-override="${idx}" title="Per-target mask style">${selectOptions}</select>
        <span class="target-badge">${Math.round(t.w)}×${Math.round(t.h)}</span>
        <button data-remove="${idx}" title="Remove target" style="background: none; border: none; color: var(--text-dim); cursor: pointer; padding: 2px 6px; font-size: 14px; margin-left: 2px;">×</button>
      `;

      row.addEventListener("click", (e) => {
        const tag = e.target.tagName.toLowerCase();
        if (tag === "button" || tag === "input" || tag === "select") return;
        state.selectedTargetId = t.id;
        if (state.faceScope === "single" && t.label.startsWith("Face")) {
          state.selectedFocusId = t.id;
          state.targets.forEach(x => {
            if (x.label.startsWith("Face")) x.enabled = (x.id === t.id);
          });
        }
        renderTargetsList();
        syncVideoRangeBar();
        drawOverlayBoxes();
        if (state.faceScope === "single") schedulePreview();
      });

      row.querySelector('select[data-mask-override]').addEventListener("change", (e) => {
        t.mask_type = e.target.value || null;
        saveCurrentMediaTargets();
        schedulePreview();
      });

      row.querySelector('input[type="checkbox"]').addEventListener("change", (e) => {
        t.enabled = e.target.checked;
        if (state.faceScope === "single" && t.label.startsWith("Face") && t.enabled) {
          state.selectedFocusId = t.id;
          state.targets.forEach(x => {
            if (x.label.startsWith("Face") && x.id !== t.id) x.enabled = false;
          });
        } else if (state.faceScope === "single" && t.id === state.selectedFocusId && !t.enabled) {
          state.selectedFocusId = null;
        }
        saveCurrentMediaTargets();
        renderTargetsList();
        drawOverlayBoxes();
        schedulePreview();
      });

      row.querySelector("button[data-remove]").addEventListener("click", () => {
        if (state.selectedTargetId === t.id) state.selectedTargetId = null;
        state.targets.splice(idx, 1);
        saveCurrentMediaTargets();
        renderTargetsList();
        syncVideoRangeBar();
        drawOverlayBoxes();
        schedulePreview();
      });

      el.targetsContainer.appendChild(row);
    });
    syncVideoRangeBar();
  }

  function _getResizeHandles(bx, by, bw, bh) {
    return [
      { id: "nw", x: bx, y: by, cursor: "nwse-resize" },
      { id: "n", x: bx + bw / 2, y: by, cursor: "ns-resize" },
      { id: "ne", x: bx + bw, y: by, cursor: "nesw-resize" },
      { id: "e", x: bx + bw, y: by + bh / 2, cursor: "ew-resize" },
      { id: "se", x: bx + bw, y: by + bh, cursor: "nwse-resize" },
      { id: "s", x: bx + bw / 2, y: by + bh, cursor: "ns-resize" },
      { id: "sw", x: bx, y: by + bh, cursor: "nesw-resize" },
      { id: "w", x: bx, y: by + bh / 2, cursor: "ew-resize" }
    ];
  }

  function _traceSegmentedPolyline(ctx, pts, scaleX, scaleY) {
    let seg = [];
    const flushSeg = () => {
      if (!seg.length) return;
      ctx.beginPath();
      seg.forEach(([dx, dy], i) => {
        if (i === 0) ctx.moveTo(dx, dy);
        else ctx.lineTo(dx, dy);
      });
      if (seg.length === 1) ctx.lineTo(seg[0][0] + 0.1, seg[0][1] + 0.1);
      ctx.stroke();
      seg = [];
    };
    pts.forEach(([px, py]) => {
      if (px < 0 || py < 0) flushSeg();
      else seg.push([px * scaleX, py * scaleY]);
    });
    flushSeg();
  }

  // Live Canvas Overlay & Editing (Box / Brush / Eraser / Select+Resize / Pan)
  function initCanvasDrawing() {
    const canvas = el.censorOverlayCanvas;
    const ctx = canvas.getContext("2d");

    function getContainedImageRect(img) {
      const rect = img.getBoundingClientRect();
      const natW = (state.activeMedia && state.activeMedia.width) || img.naturalWidth || rect.width;
      const natH = (state.activeMedia && state.activeMedia.height) || img.naturalHeight || rect.height;
      if (!natW || !natH || !rect.width || !rect.height) return rect;
      const scale = Math.min(rect.width / natW, rect.height / natH);
      const contentW = natW * scale;
      const contentH = natH * scale;
      return {
        left: rect.left + (rect.width - contentW) / 2,
        top: rect.top + (rect.height - contentH) / 2,
        width: contentW,
        height: contentH
      };
    }

    function resizeCanvas() {
      if (!el.censorPreviewImg || el.censorPreviewImg.style.display === "none") return;
      const rect = getContainedImageRect(el.censorPreviewImg);
      const parentRect = el.censorCanvasWrapper.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const z = state.zoom || 1;
        canvas.style.position = "absolute";
        canvas.style.left = `${(rect.left - parentRect.left) / z}px`;
        canvas.style.top = `${(rect.top - parentRect.top) / z}px`;
        canvas.style.width = `${rect.width / z}px`;
        canvas.style.height = `${rect.height / z}px`;
        canvas.width = Math.round(rect.width / z);
        canvas.height = Math.round(rect.height / z);
        if (el.censorOriginalImg) {
          el.censorOriginalImg.style.left = canvas.style.left;
          el.censorOriginalImg.style.top = canvas.style.top;
          el.censorOriginalImg.style.width = canvas.style.width;
          el.censorOriginalImg.style.height = canvas.style.height;
        }
        drawOverlayBoxes();
      }
    }

    el.censorPreviewImg.addEventListener("load", resizeCanvas);
    window.addEventListener("resize", resizeCanvas);
    if (window.ResizeObserver && el.censorPreviewImg) {
      const ro = new ResizeObserver(() => resizeCanvas());
      ro.observe(el.censorPreviewImg);
    }

    function getCanvasScale() {
      const naturalW = (state.activeMedia && state.activeMedia.width) || el.censorPreviewImg.naturalWidth || 800;
      const naturalH = (state.activeMedia && state.activeMedia.height) || el.censorPreviewImg.naturalHeight || 600;
      return {
        naturalW,
        naturalH,
        scaleX: canvas.width > 0 ? naturalW / canvas.width : 1,
        scaleY: canvas.height > 0 ? naturalH / canvas.height : 1
      };
    }

    function canvasPointFromEvent(e) {
      const rect = canvas.getBoundingClientRect();
      const px = Math.max(0, Math.min(canvas.width, ((e.clientX - rect.left) / Math.max(1, rect.width)) * canvas.width));
      const py = Math.max(0, Math.min(canvas.height, ((e.clientY - rect.top) / Math.max(1, rect.height)) * canvas.height));
      return { px, py };
    }

    canvas.addEventListener("pointerleave", () => {
      state.hoverPoint = null;
      if (!state.isDrawing) drawOverlayBoxes();
    });

    canvas.addEventListener("pointerdown", (e) => {
      if (!state.activeMedia || canvas.width === 0 || canvas.height === 0) return;
      if (state.spacePressed || e.button === 1) {
        e.preventDefault();
        state.panState = { startX: e.clientX, startY: e.clientY, origPanX: state.panX, origPanY: state.panY };
        state.pointerId = e.pointerId;
        canvas.setPointerCapture(e.pointerId);
        canvas.style.cursor = "grabbing";
        return;
      }
      if (e.button !== undefined && e.button !== 0) return;

      const { px, py } = canvasPointFromEvent(e);
      const { naturalW, naturalH, scaleX, scaleY } = getCanvasScale();
      state.hoverPoint = { x: px, y: py };

      state.isDrawing = true;
      state.pointerId = e.pointerId;
      canvas.setPointerCapture(e.pointerId);
      state.drawStart = { x: px, y: py };

      if (state.drawTool === "brush" || state.drawTool === "eraser") {
        state.activeBrushPoints = [[px * scaleX, py * scaleY]];
        drawOverlayBoxes();
        return;
      }

      if (state.drawTool === "select") {
        const imageX = px * scaleX;
        const imageY = py * scaleY;

        // 1. Check 8 resize handles on currently selected box target first
        const sel = state.targets.find(t => t.id === state.selectedTargetId && t.kind !== "brush");
        if (sel) {
          const dispScaleX = canvas.width / naturalW;
          const dispScaleY = canvas.height / naturalH;
          const handles = _getResizeHandles(sel.x * dispScaleX, sel.y * dispScaleY, sel.w * dispScaleX, sel.h * dispScaleY);
          const hitHandle = handles.find(h => Math.hypot(px - h.x, py - h.y) <= 9);
          if (hitHandle) {
            state.dragMoveState = {
              target: sel,
              mode: "resize",
              handle: hitHandle.id,
              startNatX: imageX,
              startNatY: imageY,
              origX: sel.x, origY: sel.y, origW: sel.w, origH: sel.h,
              moved: false, naturalW, naturalH
            };
            return;
          }
        }

        // 2. Hit test box or brush targets (top-most first)
        const hit = [...state.targets].reverse().find(target =>
          targetBelongsToMode(target) &&
          imageX >= target.x - 6 && imageX <= target.x + target.w + 6 &&
          imageY >= target.y - 6 && imageY <= target.y + target.h + 6
        );
        if (hit) {
          state.selectedTargetId = hit.id;
          state.dragMoveState = {
            target: hit,
            mode: "move",
            startNatX: imageX,
            startNatY: imageY,
            origX: hit.x, origY: hit.y, origW: hit.w, origH: hit.h,
            origPts: hit.kind === "brush" && Array.isArray(hit.brush_points) ? hit.brush_points.map(p => [...p]) : null,
            origEraserPts: hit.kind === "brush" && Array.isArray(hit.eraser_points) ? hit.eraser_points.map(p => [...p]) : null,
            moved: false, naturalW, naturalH
          };
          renderTargetsList();
          drawOverlayBoxes();
        } else {
          state.selectedTargetId = null;
          state.dragMoveState = null;
          renderTargetsList();
          drawOverlayBoxes();
        }
      }
    });

    canvas.addEventListener("pointermove", (e) => {
      if (state.panState && e.pointerId === state.pointerId) {
        state.panX = state.panState.origPanX + (e.clientX - state.panState.startX);
        state.panY = state.panState.origPanY + (e.clientY - state.panState.startY);
        applyZoomTransform();
        return;
      }

      const { px: curX, py: curY } = canvasPointFromEvent(e);
      state.hoverPoint = { x: curX, y: curY };

      if (!state.isDrawing || e.pointerId !== state.pointerId) {
        if (state.drawTool === "brush" || state.drawTool === "eraser") drawOverlayBoxes();
        return;
      }

      const { naturalW, naturalH, scaleX, scaleY } = getCanvasScale();

      if (state.drawTool === "brush" || state.drawTool === "eraser") {
        const natX = curX * scaleX;
        const natY = curY * scaleY;
        const last = state.activeBrushPoints[state.activeBrushPoints.length - 1];
        if (!last || Math.hypot(natX - last[0], natY - last[1]) >= 2.5 * Math.min(scaleX, scaleY)) {
          state.activeBrushPoints.push([natX, natY]);
        }
        drawOverlayBoxes();
        // Live zero-lag stroke preview
        ctx.save();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = state.brushSize * 2;
        ctx.strokeStyle = state.drawTool === "eraser" ? "rgba(244, 63, 94, 0.55)" : "rgba(0, 240, 255, 0.48)";
        ctx.beginPath();
        state.activeBrushPoints.forEach(([bx, by], i) => {
          const dx = bx / scaleX;
          const dy = by / scaleY;
          if (i === 0) ctx.moveTo(dx, dy);
          else ctx.lineTo(dx, dy);
        });
        if (state.activeBrushPoints.length === 1) {
          const [bx, by] = state.activeBrushPoints[0];
          ctx.lineTo(bx / scaleX + 0.1, by / scaleY + 0.1);
        }
        ctx.stroke();
        ctx.restore();
        return;
      }

      if (state.drawTool === "select" && state.dragMoveState) {
        const st = state.dragMoveState;
        const dxNat = curX * scaleX - st.startNatX;
        const dyNat = curY * scaleY - st.startNatY;
        if (Math.hypot(dxNat, dyNat) > 3) st.moved = true;
        const t = st.target;

        if (st.mode === "resize") {
          let x1 = st.origX, y1 = st.origY, x2 = st.origX + st.origW, y2 = st.origY + st.origH;
          if (st.handle.includes("w")) x1 = Math.max(0, Math.min(x2 - 12, st.origX + dxNat));
          if (st.handle.includes("e")) x2 = Math.min(naturalW, Math.max(x1 + 12, x2 + dxNat));
          if (st.handle.includes("n")) y1 = Math.max(0, Math.min(y2 - 12, st.origY + dyNat));
          if (st.handle.includes("s")) y2 = Math.min(naturalH, Math.max(y1 + 12, y2 + dyNat));
          t.x = Math.round(x1);
          t.y = Math.round(y1);
          t.w = Math.max(12, Math.round(x2 - x1));
          t.h = Math.max(12, Math.round(y2 - y1));
        } else {
          const clampedDx = Math.max(-st.origX, Math.min(naturalW - (st.origX + st.origW), Math.round(dxNat)));
          const clampedDy = Math.max(-st.origY, Math.min(naturalH - (st.origY + st.origH), Math.round(dyNat)));
          t.x = st.origX + clampedDx;
          t.y = st.origY + clampedDy;
          if (t.kind === "brush" && st.origPts) {
            t.brush_points = st.origPts.map(([bx, by]) => (bx < 0 || by < 0) ? [bx, by] : [bx + clampedDx, by + clampedDy]);
            if (st.origEraserPts) {
              t.eraser_points = st.origEraserPts.map(([ex, ey]) => (ex < 0 || ey < 0) ? [ex, ey] : [ex + clampedDx, ey + clampedDy]);
            }
          }
        }
        drawOverlayBoxes();
        return;
      }

      if (state.drawTool === "box" || state.manualDrawArmed) {
        drawOverlayBoxes();
        ctx.strokeStyle = (state.protectionMode === "nsfw") ? "#ff2b54" : "#00f0ff";
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(state.drawStart.x, state.drawStart.y, curX - state.drawStart.x, curY - state.drawStart.y);
        ctx.setLineDash([]);
      }
    });

    function commitBrushStroke(pts, scaleX, scaleY, naturalW, naturalH) {
      const natRadius = Math.min(2000, Math.max(6, Math.round(state.brushSize * ((scaleX + scaleY) / 2))));
      const roundedPts = pts.map(([px, py]) => [Math.round(px), Math.round(py)]);
      const recomputeBrushBBox = (target) => {
        const valid = (target.brush_points || []).filter(p => p[0] >= 0 && p[1] >= 0);
        if (!valid.length) return;
        const r = target.brush_radius || natRadius;
        const xs = valid.map(p => p[0]);
        const ys = valid.map(p => p[1]);
        const bx = Math.max(0, Math.floor(Math.min(...xs) - r));
        const by = Math.max(0, Math.floor(Math.min(...ys) - r));
        const bw = Math.max(10, Math.min(naturalW - bx, Math.ceil(Math.max(...xs) + r) - bx));
        const bh = Math.max(10, Math.min(naturalH - by, Math.ceil(Math.max(...ys) + r) - by));
        target.x = bx; target.y = by; target.w = bw; target.h = bh;
      };

      const canMerge = state.mergeBrushStrokes;
      const existing = canMerge
        ? (state.targets.find(t => t.id === state.selectedTargetId && t.kind === "brush" && t.enabled) ||
           [...state.targets].reverse().find(t => t.kind === "brush" && t.enabled))
        : null;

      if (existing) {
        existing.brush_points = [...(existing.brush_points || []), [-1, -1], ...roundedPts];
        existing.brush_radius = Math.max(existing.brush_radius || natRadius, natRadius);
        recomputeBrushBBox(existing);
        state.selectedTargetId = existing.id;
      } else {
        const count = state.targets.filter(t => t.label && t.label.startsWith("Brush Mask")).length + 1;
        const newTarget = {
          id: "brush_" + Date.now() + "_" + count,
          kind: "brush",
          x: 0, y: 0, w: 10, h: 10,
          brush_points: roundedPts,
          brush_radius: natRadius,
          eraser_points: [],
          eraser_radius: null,
          confidence: 1.0,
          label: `Brush Mask #${count}`,
          enabled: true
        };
        recomputeBrushBBox(newTarget);
        state.targets.push(newTarget);
        state.selectedTargetId = newTarget.id;
      }
    }

    function commitEraserStroke(pts, scaleX, scaleY) {
      const natRadius = Math.min(2000, Math.max(6, Math.round(state.brushSize * ((scaleX + scaleY) / 2))));
      const roundedPts = pts.map(([px, py]) => [Math.round(px), Math.round(py)]);
      const xs = roundedPts.map(p => p[0]);
      const ys = roundedPts.map(p => p[1]);
      const ex1 = Math.min(...xs) - natRadius;
      const ey1 = Math.min(...ys) - natRadius;
      const ex2 = Math.max(...xs) + natRadius;
      const ey2 = Math.max(...ys) + natRadius;

      let touched = false;
      state.targets.forEach(t => {
        if (t.kind !== "brush" || !t.enabled) return;
        const overlap = !(ex2 < t.x || ex1 > t.x + t.w || ey2 < t.y || ey1 > t.y + t.h);
        if (!overlap) return;
        const prevEraser = Array.isArray(t.eraser_points) && t.eraser_points.length ? [...t.eraser_points, [-1, -1]] : [];
        t.eraser_points = [...prevEraser, ...roundedPts];
        t.eraser_radius = Math.max(t.eraser_radius || 0, natRadius);
        touched = true;
      });
      if (!touched && el.censorStatusBadge) {
        el.censorStatusBadge.textContent = "Eraser only removes painted Brush Mask strokes";
      }
    }

    canvas.addEventListener("pointerup", (e) => {
      if (state.panState && e.pointerId === state.pointerId) {
        state.panState = null;
        setDrawTool(state.drawTool);
        return;
      }
      if (!state.isDrawing || e.pointerId !== state.pointerId) return;
      state.isDrawing = false;
      const { px: endX, py: endY } = canvasPointFromEvent(e);
      const { naturalW, naturalH, scaleX, scaleY } = getCanvasScale();

      if (state.drawTool === "brush") {
        const pts = state.activeBrushPoints || [];
        state.activeBrushPoints = [];
        if (pts.length > 0) {
          commitBrushStroke(pts, scaleX, scaleY, naturalW, naturalH);
          saveCurrentMediaTargets();
          renderTargetsList();
          drawOverlayBoxes();
          schedulePreview();
        }
        return;
      }

      if (state.drawTool === "eraser") {
        const pts = state.activeBrushPoints || [];
        state.activeBrushPoints = [];
        if (pts.length > 0) {
          commitEraserStroke(pts, scaleX, scaleY);
          saveCurrentMediaTargets();
          renderTargetsList();
          drawOverlayBoxes();
          schedulePreview();
        }
        return;
      }

      if (state.drawTool === "select" && state.dragMoveState) {
        const moved = state.dragMoveState.moved;
        const hit = state.dragMoveState.target;
        state.dragMoveState = null;
        if (moved) {
          saveCurrentMediaTargets();
          renderTargetsList();
          drawOverlayBoxes();
          schedulePreview();
          return;
        }
        if (state.faceScope === "single" && hit.label.startsWith("Face")) {
          state.selectedFocusId = hit.id;
          state.targets.forEach(target => {
            if (target.label.startsWith("Face")) target.enabled = target.id === hit.id;
          });
          saveCurrentMediaTargets();
          renderTargetsList();
          drawOverlayBoxes();
          schedulePreview();
        }
        return;
      }

      const dispX = Math.min(state.drawStart.x, endX);
      const dispY = Math.min(state.drawStart.y, endY);
      const dispW = Math.abs(endX - state.drawStart.x);
      const dispH = Math.abs(endY - state.drawStart.y);

      if (dispW > 10 && dispH > 10 && state.activeMedia && (state.drawTool === "box" || state.manualDrawArmed)) {
        let tag = state.activeMedia.media_type === "image" && state.protectionMode !== "objects"
          ? "Custom Area"
          : (state.selectedObjectTag || "Manual Box");
        if (state.activeMedia.media_type === "video") {
          if (state.protectionMode === "nsfw") tag = "NSFW Zone";
          else if (state.protectionMode === "faces") tag = "Custom Face";
        } else if (state.protectionMode === "nsfw") {
          tag = "NSFW Zone";
        }

        const count = state.targets.filter(t => t.label.startsWith(tag)).length + 1;
        const newId = "custom_" + Date.now();
        state.targets.push({
          id: newId,
          kind: "box",
          x: Math.round(dispX * scaleX),
          y: Math.round(dispY * scaleY),
          w: Math.round(dispW * scaleX),
          h: Math.round(dispH * scaleY),
          confidence: 1.0,
          reference_frame_sec: state.scrubberSec,
          label: `${tag} #${count}`,
          enabled: true
        });
        state.selectedTargetId = newId;

        saveCurrentMediaTargets();
        renderTargetsList();
        drawOverlayBoxes();
        schedulePreview();
        state.manualDrawArmed = false;
      } else if (state.faceScope === "single") {
        const imageX = endX * naturalW / canvas.width;
        const imageY = endY * naturalH / canvas.height;
        const hit = [...state.targets].reverse().find(target =>
          target.label.startsWith("Face") && imageX >= target.x && imageX <= target.x + target.w && imageY >= target.y && imageY <= target.y + target.h
        );
        if (hit) {
          state.selectedFocusId = hit.id;
          state.targets.forEach(target => {
            if (target.label.startsWith("Face")) target.enabled = target.id === hit.id;
          });
          saveCurrentMediaTargets();
          renderTargetsList();
          drawOverlayBoxes();
          schedulePreview();
        }
      }
    });

    canvas.addEventListener("pointercancel", () => {
      state.isDrawing = false;
      state.activeBrushPoints = [];
      state.dragMoveState = null;
      state.panState = null;
    });
  }

  function drawOverlayBoxes() {
    const canvas = el.censorOverlayCanvas;
    if (!canvas || canvas.width === 0 || !state.activeMedia) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const naturalW = (state.activeMedia && state.activeMedia.width) || el.censorPreviewImg.naturalWidth || 800;
    const naturalH = (state.activeMedia && state.activeMedia.height) || el.censorPreviewImg.naturalHeight || 600;
    const scaleX = canvas.width / naturalW;
    const scaleY = canvas.height / naturalH;

    if (state.showGuides) {
      state.targets.forEach(t => {
        if (!t.enabled || !targetBelongsToMode(t)) return;
        const bx = t.x * scaleX;
        const by = t.y * scaleY;
        const bw = t.w * scaleX;
        const bh = t.h * scaleY;

        const isFocused = (state.faceScope === "single" && t.id === state.selectedFocusId);
        const isSelected = (t.id === state.selectedTargetId);

        let strokeColor = "#00f0ff";
        if (t.kind === "brush") strokeColor = "#38bdf8";
        else if (t.label.startsWith("NudeNet") || t.label.startsWith("NSFW") || t.label.startsWith("Skin Region") || t.label.startsWith("EXPOSED") || t.label.includes("BREAST") || t.label.includes("GENITALIA") || t.label.includes("BUTTOCKS")) strokeColor = "#ff2b54";
        else if (t.label.startsWith("License") || t.label.startsWith("Document") || t.label.startsWith("Logo")) strokeColor = "#b026ff";
        else if (isFocused) strokeColor = "#00ff88";

        if (t.kind === "brush" && Array.isArray(t.brush_points) && t.brush_points.length > 0) {
          ctx.save();
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.lineWidth = Math.max(4, (t.brush_radius || 24) * 2 * ((scaleX + scaleY) / 2));
          ctx.strokeStyle = isSelected ? "rgba(0, 240, 255, 0.34)" : "rgba(56, 189, 248, 0.22)";
          _traceSegmentedPolyline(ctx, t.brush_points, scaleX, scaleY);
          if (Array.isArray(t.eraser_points) && t.eraser_points.length > 0) {
            ctx.lineWidth = Math.max(4, (t.eraser_radius || 24) * 2 * ((scaleX + scaleY) / 2));
            ctx.strokeStyle = "rgba(244, 63, 94, 0.24)";
            _traceSegmentedPolyline(ctx, t.eraser_points, scaleX, scaleY);
          }
          ctx.restore();
        }

        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = (isFocused || isSelected) ? 2.5 : 1.8;
        if (t.kind === "brush") ctx.setLineDash([4, 3]);
        ctx.strokeRect(bx, by, bw, bh);
        ctx.setLineDash([]);

        if (isSelected && t.kind !== "brush") {
          const handles = _getResizeHandles(bx, by, bw, bh);
          ctx.fillStyle = "#ffffff";
          ctx.strokeStyle = "#00f0ff";
          ctx.lineWidth = 1.5;
          handles.forEach(h => {
            ctx.fillRect(h.x - 4, h.y - 4, 8, 8);
            ctx.strokeRect(h.x - 4, h.y - 4, 8, 8);
          });
        }

        ctx.fillStyle = strokeColor;
        ctx.font = "bold 10px monospace";
        const txt = isFocused ? "★ FOCUS" : (t.kind === "brush" ? "BRUSH" : t.label.split(" ")[0]);
        const textW = ctx.measureText(txt).width;
        ctx.fillRect(bx, Math.max(0, by - 15), textW + 8, 15);
        ctx.fillStyle = "#000000";
        ctx.fillText(txt, bx + 4, Math.max(11, by - 4));
      });
    }

    // Crisp circular cursor ring in brush / eraser mode
    if (state.hoverPoint && (state.drawTool === "brush" || state.drawTool === "eraser")) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(state.hoverPoint.x, state.hoverPoint.y, state.brushSize, 0, Math.PI * 2);
      ctx.strokeStyle = state.drawTool === "eraser" ? "#f43f5e" : "#00f0ff";
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(state.hoverPoint.x, state.hoverPoint.y, Math.max(2, state.brushSize - 1), 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
  }

  function schedulePreview() {
    if (!state.activeMedia) return;
    scheduleHistoryRecord();
    clearTimeout(state.previewTimeout);
    state.previewTimeout = setTimeout(fetchLivePreview, 160);
  }

  async function fetchLivePreview() {
    if (!state.activeMedia) return;
    const requestId = ++state.previewRequestId;
    const mediaId = state.activeMedia.id;
    el.censorStatusBadge.textContent = "Rendering...";

    const activeBoxes = state.targets
      .filter(t => t.enabled && targetBelongsToMode(t))
      .map(toApiBox);

    try {
      if (state.previewAbortController) state.previewAbortController.abort();
      state.previewAbortController = new AbortController();
      const res = await fetch("/api/censor/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: state.previewAbortController.signal,
        body: JSON.stringify({
          file_id: state.activeMedia.id,
          frame_sec: state.scrubberSec,
          boxes: activeBoxes,
          mask_config: getEffectiveMaskConfig(),
          preview_revision: requestId,
          session_id: window.STUDIO_TAB_SESSION_ID || null
        })
      });
      if (!res.ok) throw new Error("Preview generation failed");
      const data = await res.json();
      if (requestId !== state.previewRequestId || !state.activeMedia || mediaId !== state.activeMedia.id) return;
      el.censorPreviewImg.src = data.preview_url;
      el.censorStatusBadge.textContent = "Protected Preview Ready";
    } catch (err) {
      if (err.name === "AbortError" || requestId !== state.previewRequestId) return;
      console.warn("Preview render error:", err);
      el.censorStatusBadge.textContent = "Ready";
    }
  }

  async function handleCustomStickerUpload(e) {
    if (!e.target.files || !e.target.files[0]) return;
    const file = e.target.files[0];
    const formData = new FormData();
    formData.append("file", file);
    if (window.STUDIO_TAB_SESSION_ID) formData.append("session_id", window.STUDIO_TAB_SESSION_ID);

    el.btnUploadCustomSticker.textContent = "Uploading...";
    try {
      const res = await fetch("/api/upload-watermark-logo", {
        method: "POST",
        body: formData
      });
      if (!res.ok) throw new Error("Sticker upload failed");
      const data = await res.json();
      state.maskConfig.custom_sticker_filename = data.filename;
      el.btnUploadCustomSticker.textContent = "✓ Sticker Loaded";
      schedulePreview();
    } catch (err) {
      alert("Custom sticker error: " + err.message);
      el.btnUploadCustomSticker.textContent = "📁 Upload Custom PNG Sticker";
    }
  }

  async function exportBatchImages(selectedFiles) {
    saveCurrentMediaTargets();
    openModal();
    el.modalProgressBar.style.width = "15%";
    el.modalPctText.textContent = "15%";
    el.modalStatusText.style.color = "var(--text-muted)";
    el.modalStatusText.textContent = `Protecting ${selectedFiles.length} batch images...`;
    el.modalResultArea.style.display = "none";
    if (el.modalBatchItemsArea) {
      el.modalBatchItemsArea.innerHTML = "";
      el.modalBatchItemsArea.style.display = "none";
    }

    const itemsPayload = selectedFiles.map(item => {
      const saved = item.id === (state.activeMedia && state.activeMedia.id)
        ? state.targets
        : ((state.targetsByFile[item.id] && state.targetsByFile[item.id].targets) || []);
      const boxes = saved
        .filter(t => t.enabled && targetBelongsToMode(t))
        .map(toApiBox);
      return { file_id: item.id, boxes };
    });

    setExportBusy(true);
    try {
      const res = await fetch("/api/censor/process-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: itemsPayload,
          mask_config: getEffectiveMaskConfig(),
          nsfw_sensitivity: state.nsfwSensitivity,
          nsfw_classes: state.nsfwClasses,
          session_id: window.STUDIO_TAB_SESSION_ID || null
        })
      });
      if (!res.ok) {
        let errMessage = `Server error ${res.status}`;
        try {
          const errData = await res.json();
          errMessage = formatApiError(errData, errMessage);
        } catch (_) {}
        throw new Error(errMessage);
      }

      const data = await res.json();
      setExportBusy(false);
      el.modalProgressBar.style.width = "100%";
      el.modalPctText.textContent = "100%";
      el.modalStatusText.textContent = `✓ ${data.processed_count} batch photo(s) protected!`;
      el.modalResultArea.style.display = "flex";
      if (el.modalBatchItemsArea && Array.isArray(data.items) && data.items.length > 0) {
        el.modalBatchItemsArea.innerHTML = data.items.map(it => `
          <div class="modal-batch-row">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${it.display_name} (${it.target_count} mask${it.target_count === 1 ? "" : "s"})</span>
            <a href="${it.download_url}" download="${it.display_name}">Download</a>
          </div>
        `).join("");
        el.modalBatchItemsArea.style.display = "flex";
      }

      el.btnDownloadResult.href = data.zip_download_url;
      el.btnDownloadResult.setAttribute("download", data.zip_filename || "censored_batch.zip");
      el.btnDownloadResult.textContent = `Download All (${data.processed_count} Photos ZIP)`;

      const dlLink = document.createElement("a");
      dlLink.href = data.zip_download_url;
      dlLink.setAttribute("download", data.zip_filename || "censored_batch.zip");
      document.body.appendChild(dlLink);
      dlLink.click();
      setTimeout(() => {
        if (document.body.contains(dlLink)) document.body.removeChild(dlLink);
      }, 500);
    } catch (err) {
      setExportBusy(false);
      el.modalStatusText.style.color = "var(--accent-pink)";
      el.modalStatusText.textContent = `❌ Batch export error: ${err.message}`;
    }
  }

  async function exportBatchVideos(selectedFiles) {
    saveCurrentMediaTargets();
    openModal();
    el.modalProgressBar.style.width = "4%";
    el.modalPctText.textContent = "4%";
    el.modalStatusText.style.color = "var(--text-muted)";
    el.modalStatusText.textContent = `Queuing ${selectedFiles.length} videos for privacy processing...`;
    el.modalResultArea.style.display = "none";
    if (el.modalBatchItemsArea) {
      el.modalBatchItemsArea.innerHTML = "";
      el.modalBatchItemsArea.style.display = "none";
    }

    let mode = "faces_all";
    if (state.protectionMode === "nsfw") mode = "nsfw";
    else if (state.protectionMode === "objects") mode = "specific_object";

    const itemsPayload = selectedFiles.map(item => {
      const saved = item.id === (state.activeMedia && state.activeMedia.id)
        ? state.targets
        : ((state.targetsByFile[item.id] && state.targetsByFile[item.id].targets) || []);
      const boxes = saved
        .filter(t => t.enabled && targetBelongsToMode(t))
        .filter(t => state.protectionMode !== "faces" || !String(t.id).startsWith("face_"))
        .filter(t => state.protectionMode !== "nsfw" || !String(t.id).startsWith("nsfw_"))
        .map(toApiBox);
      return {
        file_id: item.id,
        mode,
        boxes,
        auto_detect_faces: state.protectionMode === "faces",
        auto_detect_nsfw: state.protectionMode === "nsfw",
        mask_config: getEffectiveMaskConfig()
      };
    });

    setExportBusy(true);
    try {
      const res = await fetch("/api/censor/process-video-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: itemsPayload,
          mask_config: getEffectiveMaskConfig(),
          nsfw_sensitivity: state.nsfwSensitivity,
          nsfw_classes: state.nsfwClasses,
          session_id: window.STUDIO_TAB_SESSION_ID || null
        })
      });
      if (!res.ok) {
        let errMessage = `Server error ${res.status}`;
        try {
          const errData = await res.json();
          errMessage = formatApiError(errData, errMessage);
        } catch (_) {}
        throw new Error(errMessage);
      }

      const data = await res.json();
      state.activeJobId = data.job_id;
      el.modalStatusText.textContent = `Processing ${selectedFiles.length} videos sequentially...`;
      clearInterval(state.pollInterval);
      state.pollInterval = setInterval(pollVideoJob, 700);
    } catch (err) {
      setExportBusy(false);
      el.modalStatusText.style.color = "var(--accent-pink)";
      el.modalStatusText.textContent = `❌ Video batch error: ${err.message}`;
    }
  }

  async function startCensorExport() {
    if (state.exportBusy) return;
    if (!state.activeMedia) {
      alert("Please upload a photo or video first!");
      return;
    }

    const selectedBatch = state.mediaQueue.filter(m => state.selectedBatchIds.has(m.id));
    if (selectedBatch.length > 1) {
      const hasVideo = selectedBatch.some(m => m.media_type === "video");
      if (hasVideo) {
        return exportBatchVideos(selectedBatch);
      }
      return exportBatchImages(selectedBatch);
    }

    if (state.activeMedia.media_type === "video" && state.protectionMode === "objects" && el.checkTrackCustomObject.checked) {
      const drawnAtLaterFrame = state.targets.some(target => target.enabled && targetBelongsToMode(target) && (target.reference_frame_sec || 0) > 0.05);
      if (drawnAtLaterFrame) {
        alert("Motion tracking starts at frame 1. Move the timeline to the start, draw the object box again, then export.");
        return;
      }
    }

    const activeBoxes = state.targets
      .filter(t => t.enabled && targetBelongsToMode(t))
      .filter(t => state.activeMedia.media_type !== "video" || state.protectionMode !== "faces" || !String(t.id).startsWith("face_"))
      .filter(t => state.activeMedia.media_type !== "video" || state.protectionMode !== "nsfw" || !String(t.id).startsWith("nsfw_"))
      .map(toApiBox);

    const excludedFaceBoxes = (state.activeMedia.media_type === "video" && state.protectionMode === "faces" && state.faceScope === "multi")
      ? state.targets
          .filter(t => !t.enabled && t.label.startsWith("Face"))
          .map(toApiBox)
      : [];

    if (state.activeMedia.media_type === "image" && activeBoxes.length === 0) {
      alert("Add or detect at least one target to protect before exporting.");
      return;
    }
    if (state.activeMedia.media_type === "video" && state.protectionMode === "objects" && activeBoxes.length === 0) {
      alert("Draw at least one object box before exporting.");
      return;
    }

    openModal();
    el.modalProgressBar.style.width = "2%";
    el.modalPctText.textContent = "2%";
    el.modalStatusText.style.color = "var(--text-muted)";
    el.modalStatusText.textContent = "Initializing protection engine...";
    el.modalResultArea.style.display = "none";
    if (el.modalBatchItemsArea) {
      el.modalBatchItemsArea.innerHTML = "";
      el.modalBatchItemsArea.style.display = "none";
    }
    el.btnDownloadResult.textContent = "Download Protected File";

    let exportMode = "faces_all";
    let selectedTrackId = null;
    let selectedFaceBox = null;

    if (state.protectionMode === "faces") {
      if (state.faceScope === "single") {
        exportMode = "face_single";
        const focused = state.targets.find(t => t.id === state.selectedFocusId && t.enabled);
        if (!focused) {
          closeModal();
          alert("Select an enabled face target before exporting single-person protection.");
          return;
        }
        selectedTrackId = focused.track_id || null;
        selectedFaceBox = toApiBox(focused);
      } else {
        exportMode = "faces_all";
      }
    } else if (state.protectionMode === "nsfw") {
      exportMode = "nsfw";
    } else if (state.protectionMode === "objects") {
      exportMode = "specific_object";
    }

    setExportBusy(true);
    try {
      const res = await fetch("/api/censor/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_id: state.activeMedia.id,
          mode: exportMode,
          selected_track_id: selectedTrackId,
          selected_face_box: selectedFaceBox,
          track_custom_objects: el.checkTrackCustomObject ? el.checkTrackCustomObject.checked : true,
          boxes: activeBoxes,
          excluded_face_boxes: excludedFaceBoxes,
          mask_config: getEffectiveMaskConfig(),
          nsfw_sensitivity: state.nsfwSensitivity,
          nsfw_classes: state.nsfwClasses,
          session_id: window.STUDIO_TAB_SESSION_ID || null
        })
      });

      if (!res.ok) {
        let errMessage = `Server error ${res.status}`;
        try {
          const errData = await res.json();
          errMessage = formatApiError(errData, errMessage);
        } catch (_) {}
        throw new Error(errMessage);
      }

      const data = await res.json();

      if (data.type === "image") {
        setExportBusy(false);
        el.modalProgressBar.style.width = "100%";
        el.modalPctText.textContent = "100%";
        el.modalStatusText.textContent = "✓ Image protected successfully!";
        el.modalResultArea.style.display = "flex";
        const dlFilename = data.display_name || (data.filename.includes("_") ? data.filename.split("_").slice(1).join("_") : data.filename);
        el.btnDownloadResult.href = data.download_url;
        el.btnDownloadResult.setAttribute("download", dlFilename);

        const dlLink = document.createElement("a");
        dlLink.href = data.download_url;
        dlLink.setAttribute("download", dlFilename);
        document.body.appendChild(dlLink);
        dlLink.click();
        setTimeout(() => {
          if (document.body.contains(dlLink)) document.body.removeChild(dlLink);
        }, 500);
      } else if (data.type === "video") {
        state.activeJobId = data.job_id;
        el.modalStatusText.textContent = "Tracking and rendering protected video...";
        clearInterval(state.pollInterval);
        state.pollInterval = setInterval(pollVideoJob, 600);
      }
    } catch (err) {
      setExportBusy(false);
      el.modalStatusText.style.color = "var(--accent-pink)";
      el.modalStatusText.textContent = `❌ Export error: ${err.message}`;
    }
  }

  async function pollVideoJob() {
    if (!state.activeJobId) return;
    try {
      const res = await fetch(`/api/job/${state.activeJobId}`);
      if (!res.ok) throw new Error("Job polling error: " + res.status);
      const job = await res.json();

      if (job.status === "in_progress") {
        const pct = Math.min(99, Math.max(2, Math.round(job.progress || 0)));
        el.modalProgressBar.style.width = `${pct}%`;
        el.modalPctText.textContent = `${pct}%`;
        el.modalStatusText.textContent = job.current_item
          ? `Processing ${job.current_item} (${pct}%)...`
          : `Processing and tracking (${pct}% completed)...`;
      } else if (job.status === "completed") {
        setExportBusy(false);
        clearInterval(state.pollInterval);
        el.modalProgressBar.style.width = "100%";
        el.modalPctText.textContent = "100%";
        el.modalResultArea.style.display = "flex";

        if (Array.isArray(job.items) && job.items.length > 0) {
          const okCount = job.items.filter(it => it.status === "completed").length;
          const failCount = job.items.length - okCount;
          el.modalStatusText.textContent = failCount > 0
            ? `✓ ${okCount} video(s) protected, ${failCount} skipped (hardware/codec error)`
            : `✓ ${okCount} batch video(s) protected!`;

          if (el.modalBatchItemsArea) {
            el.modalBatchItemsArea.innerHTML = job.items.map(it => {
              if (it.status === "completed") {
                return `
                  <div class="modal-batch-row">
                    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">✓ ${it.display_name || it.filename}</span>
                    <a href="${it.download_url}" download="${it.display_name || it.filename}">Download</a>
                  </div>`;
              }
              return `
                <div class="modal-batch-row" style="border-color: rgba(244,63,94,0.35);">
                  <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap; color: var(--accent-pink);">✕ ${it.filename}: ${it.error || "Skipped"}</span>
                </div>`;
            }).join("");
            el.modalBatchItemsArea.style.display = "flex";
          }
        } else {
          el.modalStatusText.textContent = "✓ Video protected and ready for download!";
        }

        const dlUrl = job.zip_download_url || job.download_url;
        const dlFilename = job.display_name || (job.filename && job.filename.includes("_") ? job.filename.split("_").slice(1).join("_") : (job.filename || "protected_output"));
        el.btnDownloadResult.href = dlUrl;
        el.btnDownloadResult.setAttribute("download", dlFilename);
        if (job.type === "video_batch" || Array.isArray(job.items)) {
          el.btnDownloadResult.textContent = `Download All Videos (ZIP)`;
        }

        const dlLink = document.createElement("a");
        dlLink.href = dlUrl;
        dlLink.setAttribute("download", dlFilename);
        document.body.appendChild(dlLink);
        dlLink.click();
        setTimeout(() => {
          if (document.body.contains(dlLink)) document.body.removeChild(dlLink);
        }, 500);
      } else if (job.status === "failed") {
        setExportBusy(false);
        clearInterval(state.pollInterval);
        el.modalStatusText.style.color = "var(--accent-pink)";
        el.modalStatusText.textContent = "❌ Video processing failed: " + (job.error || "Unknown error");
      }
    } catch (err) {
      console.warn("Polling warning:", err);
    }
  }

  function openModal() {
    el.censorModal.classList.add("open");
    el.censorModal.classList.add("active");
  }

  function closeModal() {
    el.censorModal.classList.remove("open");
    el.censorModal.classList.remove("active");
    clearInterval(state.pollInterval);
    if (state.exportBusy) {
      setExportBusy(false);
    }
  }

  function setExportBusy(isBusy) {
    state.exportBusy = isBusy;
    syncMediaActionButtons();
    el.btnHeaderExport.setAttribute("aria-busy", isBusy ? "true" : "false");
    const spinner = document.getElementById("censorModalSpinner");
    if (spinner) spinner.style.display = isBusy ? "inline-block" : "none";
  }

  function syncMediaActionButtons() {
    const hasMedia = Boolean(state.activeMedia);
    const unavailable = !hasMedia || state.exportBusy;
    if (el.btnHeaderExport) el.btnHeaderExport.disabled = unavailable;
    if (el.btnAutoDetectFaces) el.btnAutoDetectFaces.disabled = unavailable;
    if (el.btnScanNsfw) el.btnScanNsfw.disabled = unavailable;
    if (el.btnAddManualBox) el.btnAddManualBox.disabled = unavailable;
    if (el.btnScanCurrentFrame) el.btnScanCurrentFrame.disabled = unavailable;
    if (el.btnClearAllTargets) el.btnClearAllTargets.disabled = state.targets.length === 0 || state.exportBusy;
    if (el.btnClearCurrentTargets) el.btnClearCurrentTargets.disabled = state.targets.length === 0 || state.exportBusy;
    if (el.btnUndoTarget) el.btnUndoTarget.disabled = state.undoStack.length === 0 || state.exportBusy;
    if (el.btnQuickFacePreset) el.btnQuickFacePreset.disabled = unavailable;
    if (el.btnQuickEyesPreset) el.btnQuickEyesPreset.disabled = unavailable;
  }

  function formatTime(sec) {
    if (isNaN(sec) || sec < 0) return "0:00.0";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 10);
    return `${m}:${s.toString().padStart(2, "0")}.${ms}`;
  }
})();
