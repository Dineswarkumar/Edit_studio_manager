// Censor & Privacy Studio Pro - Diversified Client Engine
(function() {
  const state = {
    activeMedia: null,
    mediaQueue: [],            // Uploaded batch items (images or single video)
    selectedBatchIds: new Set(),
    targetsByFile: {},         // file_id -> { targets: [], selectedFocusId: null }
    protectionMode: "faces",   // "faces" | "nsfw" | "objects"
    faceScope: "multi",        // "multi" (all people) | "single" (specific person)
    selectedFocusId: null,     // ID of the focused person when in single mode
    nsfwSensitivity: 0.5,
    selectedObjectTag: "License Plate",
    drawTool: "box",           // "box" | "brush" | "select"
    brushSize: 28,             // Screen-space radius in px
    activeBrushPoints: [],     // Current stroke points in natural image coords
    dragMoveState: null,       // { targetId, startNatX, startNatY, origX, origY }
    appendUploadMode: false,
    targets: [],               // List of { id, kind, x, y, w, h, brush_points, brush_radius, mask_type, confidence, label, enabled, track_id }
    maskConfig: {
      mask_type: "blur",       // "blur" | "pixelate" | "emoji" | "redact"
      intensity: 60,
      emoji_name: "sunglasses",
      custom_sticker_filename: null,
      redact_text: "[CENSORED]",
      shape: "oval",
      mask_region: "face"
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

    // Draw Bar
    el.censorDrawBar = document.getElementById("censorDrawBar");
    el.drawToolSegments = document.querySelectorAll("#drawToolSegments .segment-btn");
    el.btnToolBox = document.getElementById("btnToolBox");
    el.btnToolBrush = document.getElementById("btnToolBrush");
    el.btnToolSelect = document.getElementById("btnToolSelect");
    el.brushSizeGroup = document.getElementById("brushSizeGroup");
    el.sliderBrushSize = document.getElementById("sliderBrushSize");
    el.brushSizeVal = document.getElementById("brushSizeVal");
    el.quickPhotoPresetsGroup = document.getElementById("quickPhotoPresetsGroup");
    el.btnQuickFacePreset = document.getElementById("btnQuickFacePreset");
    el.btnQuickEyesPreset = document.getElementById("btnQuickEyesPreset");
    el.btnUndoTarget = document.getElementById("btnUndoTarget");
    el.btnClearCurrentTargets = document.getElementById("btnClearCurrentTargets");
    el.modalBatchItemsArea = document.getElementById("modalBatchItemsArea");

    // Diversified Modes
    el.protectionModeSegments = document.querySelectorAll("#protectionModeSegments .segment-btn");
    el.panelFaceMode = document.getElementById("panelFaceMode");
    el.panelNsfwMode = document.getElementById("panelNsfwMode");
    el.panelObjectMode = document.getElementById("panelObjectMode");

    // Face Mode Controls
    el.btnScopeMultiFace = document.getElementById("btnScopeMultiFace");
    el.btnScopeSingleFace = document.getElementById("btnScopeSingleFace");
    el.faceScopeBadge = document.getElementById("faceScopeBadge");
    el.singleFaceNotice = document.getElementById("singleFaceNotice");
    el.btnAutoDetectFaces = document.getElementById("btnAutoDetectFaces");

    // NSFW Controls
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
    el.censorOverlayCanvas = document.getElementById("censorOverlayCanvas");
    el.censorEmptyPrompt = document.getElementById("censorEmptyPrompt");
    el.censorHintText = document.getElementById("censorHintText");

    // Styling Controls
    el.maskTypeSegments = document.querySelectorAll("#maskTypeSegments .segment-btn");
    el.groupMaskShape = document.getElementById("groupMaskShape");
    el.btnShapeOval = document.getElementById("btnShapeOval");
    el.btnShapeRect = document.getElementById("btnShapeRect");
    el.btnRegionFace = document.getElementById("btnRegionFace");
    el.btnRegionEyes = document.getElementById("btnRegionEyes");
    el.groupIntensity = document.getElementById("groupIntensity");
    el.labelIntensity = document.getElementById("labelIntensity");
    el.intensityVal = document.getElementById("intensityVal");
    el.sliderIntensity = document.getElementById("sliderIntensity");
    el.groupEmoji = document.getElementById("groupEmoji");
    el.emojiBtns = document.querySelectorAll(".emoji-btn");
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

  function initEventListeners() {
    state.historySnapshot = makeHistorySnapshot();
    el.btnUndo.addEventListener("click", undoEdit);
    el.btnRedo.addEventListener("click", redoEdit);
    document.addEventListener("keydown", (event) => {
      const target = event.target;
      const isTextEntry = target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (isTextEntry || !(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "z" && !event.shiftKey) {
        event.preventDefault();
        undoEdit();
      } else if (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey)) {
        event.preventDefault();
        redoEdit();
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
    if (el.btnBatchApplyFaces) {
      el.btnBatchApplyFaces.addEventListener("click", () => applyBatchPreset("faces"));
    }
    if (el.btnBatchApplyEyes) {
      el.btnBatchApplyEyes.addEventListener("click", () => applyBatchPreset("eyes"));
    }
    if (el.btnBatchApplyNsfw) {
      el.btnBatchApplyNsfw.addEventListener("click", () => applyBatchPreset("nsfw"));
    }

    el.drawToolSegments.forEach(btn => {
      btn.addEventListener("click", () => {
        setDrawTool(btn.dataset.tool || "box");
      });
    });

    if (el.sliderBrushSize) {
      el.sliderBrushSize.addEventListener("input", (e) => {
        state.brushSize = parseInt(e.target.value, 10) || 28;
        if (el.brushSizeVal) el.brushSizeVal.textContent = `${state.brushSize}px`;
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

    if (el.btnUndoTarget) {
      el.btnUndoTarget.addEventListener("click", undoEdit);
    }
    if (el.btnClearCurrentTargets) {
      el.btnClearCurrentTargets.addEventListener("click", () => {
        if (!state.activeMedia) return;
        state.targets = [];
        state.selectedFocusId = null;
        saveCurrentMediaTargets();
        renderTargetsList();
        drawOverlayBoxes();
        schedulePreview();
        el.censorStatusBadge.textContent = "Photo Targets Cleared";
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

    // Face Scope Switcher (All Multi vs Single Person)
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
      // Pick first face as focus if none selected
      const firstFace = state.targets.find(t => t.label.startsWith("Face"));
      if (firstFace) {
        state.selectedFocusId = firstFace.id;
        state.targets.forEach(t => {
          if (t.label.startsWith("Face")) {
            t.enabled = (t.id === firstFace.id);
          }
        });
      }
      renderTargetsList();
      drawOverlayBoxes();
      schedulePreview();
      scheduleHistoryRecord();
    });

    // Face detection button
    el.btnAutoDetectFaces.addEventListener("click", () => detectFaces(state.scrubberSec));
    el.btnScanCurrentFrame.addEventListener("click", () => {
      if (state.protectionMode === "nsfw") {
        detectNsfw(state.scrubberSec);
      } else if (state.protectionMode === "faces") {
        detectFaces(state.scrubberSec);
      } else {
        addDefaultObjectBox();
      }
    });

    // NSFW Sensitivity buttons
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

    // NSFW Scan button
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

    // Add Object Box button
    el.btnAddManualBox.addEventListener("click", addDefaultObjectBox);
    el.checkTrackCustomObject.addEventListener("change", scheduleHistoryRecord);

    // Clear all targets
    el.btnClearAllTargets.addEventListener("click", () => {
      state.targets = [];
      state.selectedFocusId = null;
      saveCurrentMediaTargets();
      renderTargetsList();
      drawOverlayBoxes();
      schedulePreview();
      el.censorStatusBadge.textContent = "All Targets Cleared";
    });

    // Scrubber for videos
    el.censorScrubber.addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      state.scrubberSec = val;
      el.censorScrubberTimeText.textContent = formatTime(val);
      schedulePreview();
      if (state.activeMedia && state.activeMedia.media_type === "video") {
        if (state.protectionMode === "faces") {
          clearTimeout(state.scrubTimeout);
          state.scrubTimeout = setTimeout(() => {
            detectFaces(val, true);
          }, 220);
        } else if (state.protectionMode === "nsfw") {
          clearTimeout(state.scrubTimeout);
          state.scrubTimeout = setTimeout(() => {
            detectNsfw(val, true);
          }, 220);
        }
      }
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

    // Mask Shape
    el.btnShapeOval.addEventListener("click", () => {
      el.btnShapeOval.classList.add("active");
      el.btnShapeRect.classList.remove("active");
      state.maskConfig.shape = "oval";
      schedulePreview();
    });
    el.btnShapeRect.addEventListener("click", () => {
      el.btnShapeRect.classList.add("active");
      el.btnShapeOval.classList.remove("active");
      state.maskConfig.shape = "rect";
      schedulePreview();
    });
    el.btnRegionFace.addEventListener("click", () => setMaskRegion("face"));
    el.btnRegionEyes.addEventListener("click", () => setMaskRegion("eyes"));

    // Intensity Slider
    el.sliderIntensity.addEventListener("input", (e) => {
      const val = parseInt(e.target.value, 10);
      state.maskConfig.intensity = val;
      el.intensityVal.textContent = `${val}%`;
      schedulePreview();
    });

    // Emoji Grid Picker
    el.emojiBtns.forEach(btn => {
      btn.addEventListener("click", () => {
        el.emojiBtns.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        state.maskConfig.emoji_name = btn.dataset.emoji;
        state.maskConfig.custom_sticker_filename = null;
        schedulePreview();
      });
    });

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

  function updateProtectionModeUI() {
    el.panelFaceMode.style.display = (state.protectionMode === "faces") ? "flex" : "none";
    el.panelNsfwMode.style.display = (state.protectionMode === "nsfw") ? "flex" : "none";
    el.panelObjectMode.style.display = (state.protectionMode === "objects") ? "flex" : "none";

    if (state.protectionMode === "faces") {
      el.censorHintText.textContent = "💡 Tip: Auto-detect all faces or switch to 'Single Person Focus' to mask one specific individual.";
      el.btnScanCurrentFrame.textContent = "🎯 Scan Current Frame";
    } else if (state.protectionMode === "nsfw") {
      el.censorHintText.textContent = "💡 Skin-region scan only: review candidates before exporting; it is not an NSFW classifier.";
      el.btnScanCurrentFrame.textContent = "🔎 Scan Skin Regions Here";
    } else {
      el.censorHintText.textContent = "💡 Tip: Click and drag on the image to draw a box around any license plate, document, or logo.";
      el.btnScanCurrentFrame.textContent = "🎯 Draw Object Box Here";
    }
  }

  function updateMaskStylePanels() {
    const type = state.maskConfig.mask_type;
    el.groupIntensity.style.display = (type === "blur" || type === "pixelate") ? "block" : "none";
    el.groupMaskShape.style.display = (type === "blur" || type === "pixelate") ? "block" : "none";
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
      el.brushSizeGroup.style.display = (tool === "brush") ? "flex" : "none";
    }
    if (el.censorOverlayCanvas) {
      el.censorOverlayCanvas.style.cursor = tool === "select" ? "move" : "crosshair";
    }
    if (el.censorHintText && state.activeMedia) {
      if (tool === "brush") {
        el.censorHintText.textContent = "🖌️ Brush Tool: Paint over any part of the photo to blur or pixelate custom details.";
      } else if (tool === "select") {
        el.censorHintText.textContent = "👆 Select Tool: Click a target to focus/toggle or drag a box to reposition it.";
      } else {
        el.censorHintText.textContent = "▭ Box Tool: Click and drag anywhere on the preview to create a custom censor region.";
      }
    }
  }

  function toApiBox(t) {
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
      brush_radius: t.brush_radius || 24,
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
    state.selectedObjectTag = data.selectedObjectTag;
    state.targets = data.targets || [];
    state.maskConfig = data.maskConfig;
    state.scrubberSec = data.scrubberSec || 0;
    el.checkTrackCustomObject.checked = data.trackCustomObjects;

    el.protectionModeSegments.forEach(button => button.classList.toggle("active", button.dataset.mode === state.protectionMode));
    el.btnScopeMultiFace.classList.toggle("active", state.faceScope === "multi");
    el.btnScopeSingleFace.classList.toggle("active", state.faceScope === "single");
    el.faceScopeBadge.textContent = state.faceScope === "multi" ? "Multi-Face" : "Single Focus";
    el.singleFaceNotice.style.display = state.faceScope === "single" ? "block" : "none";
    [el.btnNsfwLow, el.btnNsfwBalanced, el.btnNsfwHigh].forEach(button => button.classList.toggle("active", Number(button.dataset.sens) === Number(state.nsfwSensitivity)));
    el.objectTagSegments.forEach(button => button.classList.toggle("active", button.dataset.tag === state.selectedObjectTag));
    el.maskTypeSegments.forEach(button => button.classList.toggle("active", button.dataset.type === state.maskConfig.mask_type));
    el.btnShapeOval.classList.toggle("active", state.maskConfig.shape === "oval");
    el.btnShapeRect.classList.toggle("active", state.maskConfig.shape === "rect");
    state.maskConfig.mask_region = state.maskConfig.mask_region || "face";
    el.btnRegionFace.classList.toggle("active", state.maskConfig.mask_region === "face");
    el.btnRegionEyes.classList.toggle("active", state.maskConfig.mask_region === "eyes");
    el.emojiBtns.forEach(button => button.classList.toggle("active", button.dataset.emoji === state.maskConfig.emoji_name));
    el.sliderIntensity.value = state.maskConfig.intensity;
    el.intensityVal.textContent = `${state.maskConfig.intensity}%`;
    el.inputRedactText.value = state.maskConfig.redact_text || "";
    if (state.activeMedia && state.activeMedia.media_type === "video") {
      el.censorScrubber.value = state.scrubberSec;
      el.censorScrubberTimeText.textContent = formatTime(state.scrubberSec);
    }
    updateProtectionModeUI();
    updateMaskStylePanels();
    saveCurrentMediaTargets();
    renderTargetsList();
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
    const isImageQueue = state.mediaQueue.length > 0 && state.mediaQueue.every(m => m.media_type === "image");
    if (!isImageQueue) {
      el.censorBatchPanel.style.display = "none";
      return;
    }
    el.censorBatchPanel.style.display = "flex";
    const selectedCount = state.mediaQueue.filter(m => state.selectedBatchIds.has(m.id)).length;
    if (el.censorBatchCount) {
      el.censorBatchCount.textContent = state.mediaQueue.length > 1
        ? `${selectedCount}/${state.mediaQueue.length} photos selected`
        : "1 photo loaded";
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

      const card = document.createElement("div");
      card.className = "censor-batch-card" + (isCurrent ? " active" : "");
      card.innerHTML = `
        <input type="checkbox" ${isChecked ? "checked" : ""} aria-label="Include ${item.filename}" style="flex:0 0 auto; cursor:pointer;">
        <img class="censor-batch-thumb" src="${item.thumb_url || ""}" alt="">
        <div class="censor-batch-meta">
          <div class="censor-batch-name" title="${item.filename}">${item.filename}</div>
          <div class="censor-batch-badge">${activeCnt} region${activeCnt === 1 ? "" : "s"}</div>
        </div>
        <button type="button" class="censor-batch-remove" title="Remove photo from batch">×</button>
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
      el.btnHeaderExport.textContent = selectedCount > 1
        ? `Export ${selectedCount} Photos (ZIP)`
        : "Export Protected File";
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
      el.mediaDetailsPanel.style.display = "none";
      if (el.censorDrawBar) el.censorDrawBar.style.display = "none";
      el.censorEmptyPrompt.style.display = "flex";
      el.censorPreviewImg.style.display = "none";
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
    state.scrubberSec = 0;
    state.isDrawing = false;
    state.activeBrushPoints = [];
    state.undoStack = [];
    state.redoStack = [];
    state.historySnapshot = makeHistorySnapshot();
    updateHistoryButtons();

    el.mediaDetailsPanel.style.display = "flex";
    el.mediaNameLabel.textContent = nextMedia.filename;
    el.mediaDimensionsBadge.textContent = `${nextMedia.width}×${nextMedia.height}`;
    el.censorScrubberPanel.style.display = nextMedia.media_type === "video" ? "block" : "none";
    if (el.censorDrawBar) el.censorDrawBar.style.display = "flex";
    if (el.btnToolBrush) el.btnToolBrush.style.display = nextMedia.media_type === "image" ? "" : "none";
    if (el.quickPhotoPresetsGroup) el.quickPhotoPresetsGroup.style.display = nextMedia.media_type === "image" ? "flex" : "none";

    el.censorEmptyPrompt.style.display = "none";
    el.censorPreviewImg.style.display = "block";
    el.censorOverlayCanvas.style.display = "block";

    renderBatchQueue();
    renderTargetsList();
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
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file_id: item.id,
            frame_sec: 0.0,
            sensitivity: state.nsfwSensitivity
          })
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
      el.censorStatusBadge.textContent = `${preset.toUpperCase()}: ${totalAdded} target(s) across ${targets.length} photo(s)`;
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

      if (append && uploadedImages.length > 0 && state.mediaQueue.every(m => m.media_type === "image")) {
        saveCurrentMediaTargets();
        uploadedImages.forEach(img => {
          state.mediaQueue.push(img);
          state.selectedBatchIds.add(img.id);
          state.targetsByFile[img.id] = { targets: [], selectedFocusId: null };
        });
        switchActiveMedia(uploadedImages[0].id);
        if (state.protectionMode === "nsfw") {
          await detectNsfw(0.0);
        } else {
          await detectFaces(0.0);
        }
        return;
      }

      if (uploadedImages.length > 0 && uploadedVideos.length === 0) {
        state.mediaQueue = uploadedImages;
        state.selectedBatchIds = new Set(uploadedImages.map(m => m.id));
        state.targetsByFile = {};
        uploadedImages.forEach(img => {
          state.targetsByFile[img.id] = { targets: [], selectedFocusId: null };
        });
        state.activeMedia = uploadedImages[0];
      } else {
        const firstMedia = uploadedVideos[0] || data.media[0];
        state.mediaQueue = [firstMedia];
        state.selectedBatchIds = new Set([firstMedia.id]);
        state.targetsByFile = { [firstMedia.id]: { targets: [], selectedFocusId: null } };
        state.activeMedia = firstMedia;
      }

      syncMediaActionButtons();
      state.targets = [];
      state.selectedFocusId = null;
      state.scrubberSec = 0;
      state.isDrawing = false;
      state.activeBrushPoints = [];
      state.previewRequestId += 1;
      state.undoStack = [];
      state.redoStack = [];
      state.historySnapshot = makeHistorySnapshot();
      updateHistoryButtons();
      el.mediaDetailsPanel.style.display = "flex";
      el.mediaNameLabel.textContent = state.activeMedia.filename;
      el.mediaDimensionsBadge.textContent = `${state.activeMedia.width}×${state.activeMedia.height}`;

      if (el.censorDrawBar) el.censorDrawBar.style.display = "flex";
      const isVideo = state.activeMedia.media_type === "video";
      if (el.btnToolBrush) el.btnToolBrush.style.display = isVideo ? "none" : "";
      if (el.quickPhotoPresetsGroup) el.quickPhotoPresetsGroup.style.display = isVideo ? "none" : "flex";
      if (isVideo && state.drawTool === "brush") setDrawTool("box");
      else setDrawTool(state.drawTool);

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
      renderBatchQueue();

      // Auto-detect on initial active item
      if (state.protectionMode === "nsfw") {
        await detectNsfw(0.0);
      } else {
        await detectFaces(0.0);
      }

      // If user dropped multiple photos at once in faces/nsfw mode, pre-scan remaining batch images cleanly
      if (!isVideo && state.mediaQueue.length > 1) {
        const restIds = state.mediaQueue.slice(1);
        const endpoint = state.protectionMode === "nsfw" ? "/api/censor/detect-nsfw" : "/api/censor/detect-faces";
        for (let i = 0; i < restIds.length; i++) {
          const item = restIds[i];
          try {
            const r = await fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ file_id: item.id, frame_sec: 0.0, sensitivity: state.nsfwSensitivity })
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
          frame_sec: frameSec
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
          // Match closest face spatially across scrubbed frames, falling back to track_id/first face.
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
    if (!silent) {
      el.btnScanNsfw.disabled = true;
      el.btnScanNsfw.textContent = "⏳ Checking Skin Regions...";
    }
    el.censorStatusBadge.textContent = "Checking Candidate Regions...";

    try {
      const res = await fetch("/api/censor/detect-nsfw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_id: state.activeMedia.id,
          frame_sec: frameSec,
          sensitivity: state.nsfwSensitivity
        })
      });
      if (!res.ok) throw new Error("NSFW scan request failed");
      const data = await res.json();

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
      el.censorStatusBadge.textContent = `${newNsfw.length} Candidate Region(s) Found`;
      if (data.warning) el.censorStatusBadge.title = data.warning;
    } catch (err) {
      if (!silent) alert("NSFW scan error: " + err.message);
      el.censorStatusBadge.textContent = "Scan Failed";
    } finally {
      if (!silent) {
        el.btnScanNsfw.disabled = false;
        el.btnScanNsfw.textContent = "🔞 Scan Candidate Regions";
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
      return target.label.startsWith("Face") || target.label.startsWith("Custom Face");
    }
    if (state.protectionMode === "nsfw") {
      return target.label.startsWith("Skin Region") || target.label.startsWith("NSFW");
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
      return;
    }

    state.targets.forEach((t, idx) => {
      const isFocused = (state.faceScope === "single" && t.id === state.selectedFocusId);
      const row = document.createElement("div");
      row.className = "target-item" + (isFocused ? " selected-focus" : "");

      row.innerHTML = `
        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; flex: 1;">
          <input type="checkbox" ${t.enabled ? "checked" : ""} data-idx="${idx}">
          <span style="${isFocused ? 'color: var(--accent-cyan); font-weight: 700;' : ''}">${t.label} ${isFocused ? '★ (Focus)' : ''}</span>
        </label>
        <span class="target-badge">${t.w}×${t.h}</span>
        <button data-remove="${idx}" title="Remove target" style="background: none; border: none; color: var(--text-dim); cursor: pointer; padding: 2px 6px; font-size: 14px; margin-left: 6px;">×</button>
      `;

      row.addEventListener("click", (e) => {
        if (e.target.tagName.toLowerCase() === "button" || e.target.tagName.toLowerCase() === "input") return;
        if (state.faceScope === "single" && t.label.startsWith("Face")) {
          state.selectedFocusId = t.id;
          state.targets.forEach(x => {
            if (x.label.startsWith("Face")) {
              x.enabled = (x.id === t.id);
            }
          });
          renderTargetsList();
          drawOverlayBoxes();
          schedulePreview();
        }
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
        state.targets.splice(idx, 1);
        saveCurrentMediaTargets();
        renderTargetsList();
        drawOverlayBoxes();
        schedulePreview();
      });

      el.targetsContainer.appendChild(row);
    });
  }

  // Live Canvas Overlay
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
        canvas.style.position = "absolute";
        canvas.style.left = `${rect.left - parentRect.left}px`;
        canvas.style.top = `${rect.top - parentRect.top}px`;
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
        canvas.width = Math.round(rect.width);
        canvas.height = Math.round(rect.height);
        drawOverlayBoxes();
      }
    }

    el.censorPreviewImg.addEventListener("load", resizeCanvas);
    window.addEventListener("resize", resizeCanvas);
    if (window.ResizeObserver && el.censorPreviewImg) {
      const ro = new ResizeObserver(() => { resizeCanvas(); });
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

    canvas.addEventListener("pointerdown", (e) => {
      if (!state.activeMedia || canvas.width === 0 || canvas.height === 0) return;
      if (state.activeMedia.media_type === "video" && state.protectionMode === "objects" && !state.manualDrawArmed && state.drawTool === "select") return;
      if (e.button !== undefined && e.button !== 0) return;

      const rect = canvas.getBoundingClientRect();
      const px = Math.max(0, Math.min(canvas.width, e.clientX - rect.left));
      const py = Math.max(0, Math.min(canvas.height, e.clientY - rect.top));
      const { naturalW, naturalH, scaleX, scaleY } = getCanvasScale();

      state.isDrawing = true;
      state.pointerId = e.pointerId;
      canvas.setPointerCapture(e.pointerId);
      state.drawStart = { x: px, y: py };

      if (state.drawTool === "brush" && state.activeMedia.media_type === "image") {
        state.activeBrushPoints = [[px * scaleX, py * scaleY]];
        drawOverlayBoxes();
        return;
      }

      if (state.drawTool === "select") {
        const imageX = px * scaleX;
        const imageY = py * scaleY;
        const hit = [...state.targets].reverse().find(target =>
          targetBelongsToMode(target) &&
          target.kind !== "brush" &&
          imageX >= target.x && imageX <= target.x + target.w &&
          imageY >= target.y && imageY <= target.y + target.h
        );
        if (hit) {
          state.dragMoveState = {
            target: hit,
            startNatX: imageX,
            startNatY: imageY,
            origX: hit.x,
            origY: hit.y,
            moved: false,
            naturalW,
            naturalH
          };
        } else {
          state.dragMoveState = null;
        }
      }
    });

    canvas.addEventListener("pointermove", (e) => {
      if (!state.isDrawing || e.pointerId !== state.pointerId) return;
      const rect = canvas.getBoundingClientRect();
      const curX = Math.max(0, Math.min(canvas.width, e.clientX - rect.left));
      const curY = Math.max(0, Math.min(canvas.height, e.clientY - rect.top));
      const { naturalW, naturalH, scaleX, scaleY } = getCanvasScale();

      if (state.drawTool === "brush" && state.activeMedia && state.activeMedia.media_type === "image") {
        const natX = curX * scaleX;
        const natY = curY * scaleY;
        const last = state.activeBrushPoints[state.activeBrushPoints.length - 1];
        if (!last || Math.hypot(natX - last[0], natY - last[1]) >= 3 * Math.min(scaleX, scaleY)) {
          state.activeBrushPoints.push([natX, natY]);
        }
        drawOverlayBoxes();
        // Live brush preview stroke on overlay
        ctx.save();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = state.brushSize * 2;
        ctx.strokeStyle = "rgba(0, 240, 255, 0.45)";
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
        const dxNat = curX * scaleX - state.dragMoveState.startNatX;
        const dyNat = curY * scaleY - state.dragMoveState.startNatY;
        if (Math.hypot(dxNat, dyNat) > 4) state.dragMoveState.moved = true;
        const t = state.dragMoveState.target;
        t.x = Math.max(0, Math.min(naturalW - t.w, Math.round(state.dragMoveState.origX + dxNat)));
        t.y = Math.max(0, Math.min(naturalH - t.h, Math.round(state.dragMoveState.origY + dyNat)));
        drawOverlayBoxes();
        return;
      }

      if (state.drawTool === "box" || state.manualDrawArmed) {
        drawOverlayBoxes();
        ctx.strokeStyle = (state.protectionMode === "nsfw") ? "#ff2b54" : "#00f0ff";
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        const w = curX - state.drawStart.x;
        const h = curY - state.drawStart.y;
        ctx.strokeRect(state.drawStart.x, state.drawStart.y, w, h);
        ctx.setLineDash([]);
      }
    });

    canvas.addEventListener("pointerup", (e) => {
      if (!state.isDrawing || e.pointerId !== state.pointerId) return;
      state.isDrawing = false;
      const rect = canvas.getBoundingClientRect();
      const endX = Math.max(0, Math.min(canvas.width, e.clientX - rect.left));
      const endY = Math.max(0, Math.min(canvas.height, e.clientY - rect.top));
      const { naturalW, naturalH, scaleX, scaleY } = getCanvasScale();

      if (state.drawTool === "brush" && state.activeMedia && state.activeMedia.media_type === "image") {
        const pts = state.activeBrushPoints || [];
        state.activeBrushPoints = [];
        if (pts.length > 0) {
          const natRadius = Math.max(6, Math.round(state.brushSize * ((scaleX + scaleY) / 2)));
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          pts.forEach(([px, py]) => {
            if (px < minX) minX = px;
            if (py < minY) minY = py;
            if (px > maxX) maxX = px;
            if (py > maxY) maxY = py;
          });
          const bx = Math.max(0, Math.floor(minX - natRadius));
          const by = Math.max(0, Math.floor(minY - natRadius));
          const bw = Math.max(10, Math.min(naturalW - bx, Math.ceil(maxX + natRadius) - bx));
          const bh = Math.max(10, Math.min(naturalH - by, Math.ceil(maxY + natRadius) - by));
          const count = state.targets.filter(t => t.label && t.label.startsWith("Brush Mask")).length + 1;
          state.targets.push({
            id: "brush_" + Date.now() + "_" + count,
            kind: "brush",
            x: bx, y: by, w: bw, h: bh,
            brush_points: pts.map(([px, py]) => [Math.round(px), Math.round(py)]),
            brush_radius: natRadius,
            confidence: 1.0,
            label: `Brush Mask #${count}`,
            enabled: true
          });
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

        state.targets.push({
          id: "custom_" + Date.now(),
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

    state.targets.forEach(t => {
      if (!t.enabled || !targetBelongsToMode(t)) return;
      const bx = t.x * scaleX;
      const by = t.y * scaleY;
      const bw = t.w * scaleX;
      const bh = t.h * scaleY;

      const isFocused = (state.faceScope === "single" && t.id === state.selectedFocusId);

      // Color coding per target type
      let strokeColor = "#00f0ff";
      if (t.kind === "brush") strokeColor = "#38bdf8";
      else if (t.label.startsWith("NSFW") || t.label.startsWith("Skin Region")) strokeColor = "#ff2b54";
      else if (t.label.startsWith("License") || t.label.startsWith("Document") || t.label.startsWith("Logo")) strokeColor = "#b026ff";
      else if (isFocused) strokeColor = "#00ff88";

      if (t.kind === "brush" && Array.isArray(t.brush_points) && t.brush_points.length > 0) {
        ctx.save();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = Math.max(4, (t.brush_radius || 24) * 2 * ((scaleX + scaleY) / 2));
        ctx.strokeStyle = "rgba(56, 189, 248, 0.28)";
        ctx.beginPath();
        t.brush_points.forEach(([px, py], i) => {
          const dx = px * scaleX;
          const dy = py * scaleY;
          if (i === 0) ctx.moveTo(dx, dy);
          else ctx.lineTo(dx, dy);
        });
        if (t.brush_points.length === 1) {
          const [px, py] = t.brush_points[0];
          ctx.lineTo(px * scaleX + 0.1, py * scaleY + 0.1);
        }
        ctx.stroke();
        ctx.restore();
      }

      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = isFocused ? 3 : 2;
      if (t.kind === "brush") ctx.setLineDash([4, 3]);
      ctx.strokeRect(bx, by, bw, bh);
      ctx.setLineDash([]);

      // Label background pill
      ctx.fillStyle = strokeColor;
      ctx.font = "bold 11px monospace";
      const txt = isFocused ? "★ FOCUS" : (t.kind === "brush" ? "BRUSH" : t.label.split(" ")[0]);
      const textW = ctx.measureText(txt).width;
      ctx.fillRect(bx, Math.max(0, by - 16), textW + 8, 16);

      ctx.fillStyle = "#000000";
      ctx.fillText(txt, bx + 4, Math.max(12, by - 4));
    });
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
          mask_config: state.maskConfig,
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
      return {
        file_id: item.id,
        boxes
      };
    });

    setExportBusy(true);
    try {
      const res = await fetch("/api/censor/process-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: itemsPayload,
          mask_config: state.maskConfig,
          nsfw_sensitivity: state.nsfwSensitivity,
          session_id: window.STUDIO_TAB_SESSION_ID || null
        })
      });
      if (!res.ok) {
        let errMessage = `Server error ${res.status}`;
        try {
          const errData = await res.json();
          if (errData && errData.detail) errMessage = errData.detail;
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

  async function startCensorExport() {
    if (state.exportBusy) return;
    if (!state.activeMedia) {
      alert("Please upload a photo or video first!");
      return;
    }

    const isImageQueue = state.mediaQueue.length > 0 && state.mediaQueue.every(m => m.media_type === "image");
    const selectedBatch = isImageQueue
      ? state.mediaQueue.filter(m => state.selectedBatchIds.has(m.id))
      : [];
    if (isImageQueue && selectedBatch.length > 1) {
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

    // Mode determination
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
          mask_config: state.maskConfig,
          nsfw_sensitivity: state.nsfwSensitivity,
          session_id: window.STUDIO_TAB_SESSION_ID || null
        })
      });

      if (!res.ok) {
        let errMessage = `Server error ${res.status}`;
        try {
          const errData = await res.json();
          if (errData && errData.detail) errMessage = errData.detail;
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

        // Auto trigger direct browser download
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
        el.modalStatusText.textContent = `Processing and tracking (${pct}% completed)...`;
      } else if (job.status === "completed") {
        setExportBusy(false);
        clearInterval(state.pollInterval);
        el.modalProgressBar.style.width = "100%";
        el.modalPctText.textContent = "100%";
        el.modalStatusText.textContent = "✓ Video protected and ready for download!";
        el.modalResultArea.style.display = "flex";
        const dlFilename = job.display_name || (job.filename.includes("_") ? job.filename.split("_").slice(1).join("_") : job.filename);
        el.btnDownloadResult.href = job.download_url;
        el.btnDownloadResult.setAttribute("download", dlFilename);

        // Auto trigger browser download
        const dlLink = document.createElement("a");
        dlLink.href = job.download_url;
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
