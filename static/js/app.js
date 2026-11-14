// Watermark Studio Pro Frontend Logic

let state = {
  mediaList: [],
  selectedMediaIds: new Set(),
  activeMediaId: null,
  activeLayerId: 'layer_1',
  layers: [
    {
      id: 'layer_1',
      layer_type: 'text',
      enabled: true,
      layout_mode: 'single',
      position: 'bottom-right',
      custom_x: 0.8,
      custom_y: 0.8,
      margin_x: 24,
      margin_y: 24,
      rotation: 0,
      opacity: 0.8,
      tile_spacing_x: 160,
      tile_spacing_y: 120,
      tile_stagger: true,
      text: '© Watermark Studio',
      font_family: 'Arial',
      font_size: 36,
      font_bold: false,
      color: '#ffffff',
      shadow_enabled: true,
      shadow_color: '#000000',
      shadow_offset: 2,
      stroke_enabled: false,
      stroke_color: '#000000',
      stroke_width: 2,
      bg_enabled: false,
      bg_color: '#000000',
      bg_opacity: 0.5,
      bg_padding: 8,
      bg_radius: 6,
      image_filename: null,
      scale_percent: 15.0
    }
  ],
  previewDebounceTimer: null,
  activeJobId: null,
  jobPollTimer: null,
  undoStack: [],
  redoStack: [],
  wmZoom: 1,
  isPeekingOriginal: false,
  lastRenderedPreviewUrl: null,
  exportSettings: {
    mode: "watermark_and_compress",
    video_preset: "balanced",
    video_resolution: "original",
    image_quality: 85
  }
};

// DOM Elements
const mediaDropzone = document.getElementById('mediaDropzone');
const mediaFileInput = document.getElementById('mediaFileInput');
const mediaListEl = document.getElementById('mediaList');
const mediaCountEl = document.getElementById('mediaCount');
const selectAllCheckbox = document.getElementById('selectAllCheckbox');
const selectedCountBadge = document.getElementById('selectedCountBadge');
const btnClearMedia = document.getElementById('btnClearMedia');

const previewImg = document.getElementById('previewImg');
const canvasWrapper = document.getElementById('canvasWrapper');
const emptyStagePrompt = document.getElementById('emptyStagePrompt');
const canvasDimLabel = document.getElementById('canvasDimLabel');
const watermarkOverlayStage = document.getElementById('watermarkOverlayStage');
const btnRefreshPreview = document.getElementById('btnRefreshPreview');

// Video preview elements
const videoContainer = document.getElementById('videoContainer');
const previewVideo = document.getElementById('previewVideo');
const videoWatermarkOverlay = document.getElementById('videoWatermarkOverlay');
const btnPlayPause = document.getElementById('btnPlayPause');
const videoProgress = document.getElementById('videoProgress');
const videoTimeDisplay = document.getElementById('videoTimeDisplay');
const btnMuteToggle = document.getElementById('btnMuteToggle');

const layersTabs = document.getElementById('layersTabs');
const btnAddTextLayer = document.getElementById('btnAddTextLayer');
const btnAddImageLayer = document.getElementById('btnAddImageLayer');
const btnDeleteLayer = document.getElementById('btnDeleteLayer');

const modeSingleBtn = document.getElementById('modeSingleBtn');
const modeTiledBtn = document.getElementById('modeTiledBtn');
const singleLayoutControls = document.getElementById('singleLayoutControls');
const tiledLayoutControls = document.getElementById('tiledLayoutControls');

const textSettingsGroup = document.getElementById('textSettingsGroup');
const imageSettingsGroup = document.getElementById('imageSettingsGroup');

const layerTextInput = document.getElementById('layerTextInput');
const layerFontSelect = document.getElementById('layerFontSelect');
const layerFontSizeSlider = document.getElementById('layerFontSizeSlider');
const fontSizeVal = document.getElementById('fontSizeVal');
const layerTextColor = document.getElementById('layerTextColor');
const layerTextColorHex = document.getElementById('layerTextColorHex');
const layerBoldCheck = document.getElementById('layerBoldCheck');
const layerShadowCheck = document.getElementById('layerShadowCheck');

const layerBgEnableCheck = document.getElementById('layerBgEnableCheck');
const badgeOptionsPanel = document.getElementById('badgeOptionsPanel');
const layerBgColor = document.getElementById('layerBgColor');
const layerBgOpacitySlider = document.getElementById('layerBgOpacitySlider');
const layerStrokeEnableCheck = document.getElementById('layerStrokeEnableCheck');
const strokeOptionsPanel = document.getElementById('strokeOptionsPanel');
const layerStrokeColor = document.getElementById('layerStrokeColor');
const layerStrokeWidthSlider = document.getElementById('layerStrokeWidthSlider');
const strokeWidthVal = document.getElementById('strokeWidthVal');

const btnWmUndo = document.getElementById('btnWmUndo');
const btnWmRedo = document.getElementById('btnWmRedo');
const btnWmZoomOut = document.getElementById('btnWmZoomOut');
const wmZoomVal = document.getElementById('wmZoomVal');
const btnWmZoomIn = document.getElementById('btnWmZoomIn');
const btnWmZoomReset = document.getElementById('btnWmZoomReset');
const btnWmPeekOriginal = document.getElementById('btnWmPeekOriginal');

const btnSaveWmPreset = document.getElementById('btnSaveWmPreset');
const savedWmPresetsRow = document.getElementById('savedWmPresetsRow');
const savedWmPresetsSelect = document.getElementById('savedWmPresetsSelect');
const btnApplySavedPreset = document.getElementById('btnApplySavedPreset');
const btnDeleteSavedPreset = document.getElementById('btnDeleteSavedPreset');

const btnUploadLogo = document.getElementById('btnUploadLogo');
const logoFileInput = document.getElementById('logoFileInput');
const logoPreviewThumb = document.getElementById('logoPreviewThumb');
const layerLogoScaleSlider = document.getElementById('layerLogoScaleSlider');
const logoScaleVal = document.getElementById('logoScaleVal');

const layerOpacitySlider = document.getElementById('layerOpacitySlider');
const opacityVal = document.getElementById('opacityVal');
const layerRotationSlider = document.getElementById('layerRotationSlider');
const rotationVal = document.getElementById('rotationVal');

const layerMarginXSlider = document.getElementById('layerMarginXSlider');
const marginXVal = document.getElementById('marginXVal');
const layerMarginYSlider = document.getElementById('layerMarginYSlider');
const marginYVal = document.getElementById('marginYVal');

const layerTileSpaceXSlider = document.getElementById('layerTileSpaceXSlider');
const tileSpaceXVal = document.getElementById('tileSpaceXVal');
const layerTileSpaceYSlider = document.getElementById('layerTileSpaceYSlider');
const tileSpaceYVal = document.getElementById('tileSpaceYVal');
const layerTileStaggerCheck = document.getElementById('layerTileStaggerCheck');

const btnProcessBatch = document.getElementById('btnProcessBatch');
const progressModal = document.getElementById('progressModal');
const btnCloseModal = document.getElementById('btnCloseModal');
const modalSpinner = document.getElementById('modalSpinner');
const modalProgressText = document.getElementById('modalProgressText');
const modalProgressPercent = document.getElementById('modalProgressPercent');
const modalProgressFill = document.getElementById('modalProgressFill');
const modalItemList = document.getElementById('modalItemList');
const btnDownloadZip = document.getElementById('btnDownloadZip');

// Initial Setup
const WM_PRESETS_STORAGE_KEY = 'wm_studio_saved_presets_v1';
const WM_BUILTIN_PRESETS = {
  'subtle-corner': {
    layout_mode: 'single',
    position: 'bottom-right',
    margin_x: 24,
    margin_y: 24,
    rotation: 0,
    opacity: 0.55,
    font_size: 28,
    font_bold: false,
    color: '#ffffff',
    shadow_enabled: true,
    stroke_enabled: false,
    bg_enabled: false,
  },
  'diagonal-grid': {
    layout_mode: 'tiled',
    tile_spacing_x: 190,
    tile_spacing_y: 140,
    tile_stagger: true,
    rotation: -30,
    opacity: 0.25,
    font_size: 34,
    font_bold: true,
    color: '#ffffff',
    shadow_enabled: false,
    stroke_enabled: false,
    bg_enabled: false,
  },
  'bold-outline': {
    layout_mode: 'single',
    position: 'bottom-center',
    margin_x: 24,
    margin_y: 36,
    rotation: 0,
    opacity: 0.92,
    font_size: 48,
    font_bold: true,
    color: '#facc15',
    shadow_enabled: true,
    stroke_enabled: true,
    stroke_color: '#000000',
    stroke_width: 4,
    bg_enabled: false,
  },
  'badge-stamp': {
    layout_mode: 'single',
    position: 'top-left',
    margin_x: 20,
    margin_y: 20,
    rotation: 0,
    opacity: 0.9,
    font_size: 26,
    font_bold: true,
    color: '#ffffff',
    shadow_enabled: false,
    stroke_enabled: false,
    bg_enabled: true,
    bg_color: '#0f172a',
    bg_opacity: 0.78,
  },
};

function init() {
  bindEvents();
  pushWmHistorySnapshot(false);
  renderSavedPresetsList();
  renderLayersTabs();
  renderMediaList();
  syncFormToActiveLayer();
  updateSelectedCount();
  updatePreviewDisplay();
}

function getActiveLayer() {
  return state.layers.find(l => l.id === state.activeLayerId) || state.layers[0];
}

function bindEvents() {
  // Dropzone
  mediaDropzone.addEventListener('click', () => mediaFileInput.click());
  mediaFileInput.addEventListener('change', (e) => {
    handleFilesUpload(e.target.files);
    e.target.value = '';
  });

  mediaDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    mediaDropzone.classList.add('dragover');
  });
  mediaDropzone.addEventListener('dragleave', () => mediaDropzone.classList.remove('dragover'));
  mediaDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    mediaDropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
      handleFilesUpload(e.dataTransfer.files);
    }
  });

  // Select all checkbox
  selectAllCheckbox.addEventListener('change', (e) => {
    if (e.target.checked) {
      state.mediaList.forEach(m => state.selectedMediaIds.add(m.id));
    } else {
      state.selectedMediaIds.clear();
    }
    updateSelectedCount();
    renderMediaList();
  });

  btnClearMedia.addEventListener('click', () => {
    state.mediaList = [];
    state.selectedMediaIds.clear();
    state.activeMediaId = null;
    renderMediaList();
    updatePreviewDisplay();
  });

  // Layer add/delete
  btnAddTextLayer.addEventListener('click', () => addLayer('text'));
  btnAddImageLayer.addEventListener('click', () => addLayer('image'));
  btnDeleteLayer.addEventListener('click', deleteActiveLayer);

  // Layout mode buttons
  modeSingleBtn.addEventListener('click', () => setLayoutMode('single'));
  modeTiledBtn.addEventListener('click', () => setLayoutMode('tiled'));

  // 9-grid position matrix
  document.querySelectorAll('.matrix-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      pushWmHistorySnapshot(true);
      document.querySelectorAll('.matrix-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const layer = getActiveLayer();
      layer.position = btn.dataset.pos;
      requestLivePreview();
    });
  });

  // Text inputs & sliders
  layerTextInput.addEventListener('change', () => pushWmHistorySnapshot(true));
  layerFontSizeSlider.addEventListener('change', () => pushWmHistorySnapshot(true));
  layerTextColor.addEventListener('change', () => pushWmHistorySnapshot(true));
  layerOpacitySlider.addEventListener('change', () => pushWmHistorySnapshot(true));
  layerRotationSlider.addEventListener('change', () => pushWmHistorySnapshot(true));
  layerTextInput.addEventListener('input', (e) => {
    getActiveLayer().text = e.target.value;
    updateLayerTabTitle();
    requestLivePreview();
  });

  layerFontSelect.addEventListener('change', (e) => {
    getActiveLayer().font_family = e.target.value;
    requestLivePreview();
  });

  layerFontSizeSlider.addEventListener('input', (e) => {
    fontSizeVal.innerText = `${e.target.value}px`;
    getActiveLayer().font_size = parseInt(e.target.value);
    requestLivePreview();
  });

  layerTextColor.addEventListener('input', (e) => {
    layerTextColorHex.innerText = e.target.value;
    getActiveLayer().color = e.target.value;
    requestLivePreview();
  });

  layerBoldCheck.addEventListener('change', (e) => {
    getActiveLayer().font_bold = e.target.checked;
    requestLivePreview();
  });

  layerShadowCheck.addEventListener('change', (e) => {
    getActiveLayer().shadow_enabled = e.target.checked;
    requestLivePreview();
  });

  layerBgEnableCheck.addEventListener('change', (e) => {
    getActiveLayer().bg_enabled = e.target.checked;
    badgeOptionsPanel.style.display = e.target.checked ? 'flex' : 'none';
    requestLivePreview();
  });

  layerBgColor.addEventListener('input', (e) => {
    getActiveLayer().bg_color = e.target.value;
    requestLivePreview();
  });

  layerBgOpacitySlider.addEventListener('input', (e) => {
    getActiveLayer().bg_opacity = parseInt(e.target.value) / 100.0;
    requestLivePreview();
  });

  if (layerStrokeEnableCheck) {
    layerStrokeEnableCheck.addEventListener('change', (e) => {
      pushWmHistorySnapshot(true);
      getActiveLayer().stroke_enabled = e.target.checked;
      if (strokeOptionsPanel) strokeOptionsPanel.style.display = e.target.checked ? 'flex' : 'none';
      requestLivePreview();
    });
  }
  if (layerStrokeColor) {
    layerStrokeColor.addEventListener('input', (e) => {
      getActiveLayer().stroke_color = e.target.value;
      requestLivePreview();
    });
    layerStrokeColor.addEventListener('change', () => pushWmHistorySnapshot(true));
  }
  if (layerStrokeWidthSlider) {
    layerStrokeWidthSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10) || 2;
      if (strokeWidthVal) strokeWidthVal.innerText = `${val}px`;
      getActiveLayer().stroke_width = val;
      requestLivePreview();
    });
    layerStrokeWidthSlider.addEventListener('change', () => pushWmHistorySnapshot(true));
  }

  // Undo / Redo + Zoom + Peek + Presets
  if (btnWmUndo) btnWmUndo.addEventListener('click', wmUndo);
  if (btnWmRedo) btnWmRedo.addEventListener('click', wmRedo);
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) wmRedo();
      else wmUndo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      wmRedo();
    }
  });

  if (btnWmZoomOut) btnWmZoomOut.addEventListener('click', () => setWmZoom(state.wmZoom - 0.25));
  if (btnWmZoomIn) btnWmZoomIn.addEventListener('click', () => setWmZoom(state.wmZoom + 0.25));
  if (btnWmZoomReset) btnWmZoomReset.addEventListener('click', () => setWmZoom(1));

  if (btnWmPeekOriginal) {
    const startPeek = () => setPeekOriginal(true);
    const stopPeek = () => setPeekOriginal(false);
    btnWmPeekOriginal.addEventListener('mousedown', startPeek);
    btnWmPeekOriginal.addEventListener('touchstart', startPeek, { passive: true });
    window.addEventListener('mouseup', stopPeek);
    window.addEventListener('touchend', stopPeek);
  }

  document.querySelectorAll('.wm-preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = WM_BUILTIN_PRESETS[btn.dataset.preset];
      if (!preset) return;
      pushWmHistorySnapshot(true);
      Object.assign(getActiveLayer(), preset);
      syncFormToActiveLayer();
      requestLivePreview(true);
    });
  });
  if (btnSaveWmPreset) btnSaveWmPreset.addEventListener('click', saveCurrentWmPreset);
  if (btnApplySavedPreset) btnApplySavedPreset.addEventListener('click', applySelectedSavedPreset);
  if (btnDeleteSavedPreset) btnDeleteSavedPreset.addEventListener('click', deleteSelectedSavedPreset);

  // Image logo controls
  btnUploadLogo.addEventListener('click', () => logoFileInput.click());
  logoFileInput.addEventListener('change', handleLogoUpload);

  layerLogoScaleSlider.addEventListener('input', (e) => {
    logoScaleVal.innerText = `${e.target.value}%`;
    getActiveLayer().scale_percent = parseFloat(e.target.value);
    requestLivePreview();
  });

  // Opacity & rotation
  layerOpacitySlider.addEventListener('input', (e) => {
    opacityVal.innerText = `${e.target.value}%`;
    getActiveLayer().opacity = parseInt(e.target.value) / 100.0;
    requestLivePreview();
  });

  layerRotationSlider.addEventListener('input', (e) => {
    rotationVal.innerText = `${e.target.value}°`;
    getActiveLayer().rotation = parseFloat(e.target.value);
    requestLivePreview();
  });

  // Margins & Tile Spacing
  layerMarginXSlider.addEventListener('input', (e) => {
    marginXVal.innerText = `${e.target.value}px`;
    getActiveLayer().margin_x = parseInt(e.target.value);
    requestLivePreview();
  });

  layerMarginYSlider.addEventListener('input', (e) => {
    marginYVal.innerText = `${e.target.value}px`;
    getActiveLayer().margin_y = parseInt(e.target.value);
    requestLivePreview();
  });

  layerTileSpaceXSlider.addEventListener('input', (e) => {
    tileSpaceXVal.innerText = `${e.target.value}px`;
    getActiveLayer().tile_spacing_x = parseInt(e.target.value);
    requestLivePreview();
  });

  layerTileSpaceYSlider.addEventListener('input', (e) => {
    tileSpaceYVal.innerText = `${e.target.value}px`;
    getActiveLayer().tile_spacing_y = parseInt(e.target.value);
    requestLivePreview();
  });

  layerTileStaggerCheck.addEventListener('change', (e) => {
    getActiveLayer().tile_stagger = e.target.checked;
    requestLivePreview();
  });

  // Video Player Controls & Scrubbing
  const videoControlsBar = document.querySelector('.video-controls-bar');
  if (videoControlsBar) {
    // Prevent clicks on controls from triggering watermark canvas dragging
    videoControlsBar.addEventListener('mousedown', (e) => e.stopPropagation());
    videoControlsBar.addEventListener('click', (e) => e.stopPropagation());
  }

  btnPlayPause.addEventListener('click', (e) => {
    e.stopPropagation();
    if (previewVideo.paused) {
      previewVideo.play();
      btnPlayPause.innerText = '❚❚';
    } else {
      previewVideo.pause();
      btnPlayPause.innerText = '▶';
    }
  });

  let isScrubbing = false;

  videoProgress.addEventListener('mousedown', () => { isScrubbing = true; });
  videoProgress.addEventListener('touchstart', () => { isScrubbing = true; });

  videoProgress.addEventListener('input', (e) => {
    if (!previewVideo.duration) return;
    const targetTime = (parseFloat(e.target.value) / 100.0) * previewVideo.duration;
    previewVideo.currentTime = targetTime;
    videoTimeDisplay.innerText = `${formatTime(targetTime)} / ${formatTime(previewVideo.duration)}`;
  });

  videoProgress.addEventListener('change', (e) => {
    if (!previewVideo.duration) return;
    const targetTime = (parseFloat(e.target.value) / 100.0) * previewVideo.duration;
    previewVideo.currentTime = targetTime;
    isScrubbing = false;
  });

  window.addEventListener('mouseup', () => {
    if (isScrubbing) isScrubbing = false;
  });

  previewVideo.addEventListener('timeupdate', () => {
    if (isScrubbing || !previewVideo.duration) return;
    const pct = (previewVideo.currentTime / previewVideo.duration) * 100.0;
    videoProgress.value = pct;
    videoTimeDisplay.innerText = `${formatTime(previewVideo.currentTime)} / ${formatTime(previewVideo.duration)}`;
  });

  btnMuteToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    previewVideo.muted = !previewVideo.muted;
    btnMuteToggle.innerText = previewVideo.muted ? '🔇' : '🔊';
  });

  // Refresh & Batch Actions
  btnRefreshPreview.addEventListener('click', () => requestLivePreview(true));
  
  // Show Export & Compression Options Modal when clicking Process
  const exportOptionsModal = document.getElementById('exportOptionsModal');
  const btnCloseExportModal = document.getElementById('btnCloseExportModal');
  const btnCancelExport = document.getElementById('btnCancelExport');
  const btnConfirmExport = document.getElementById('btnConfirmExport');
  const exportModalFileCount = document.getElementById('exportModalFileCount');
  
  const exportModeBothBtn = document.getElementById('exportModeBothBtn');
  const exportModeCompressOnlyBtn = document.getElementById('exportModeCompressOnlyBtn');
  const compressionEstimateLabel = document.getElementById('compressionEstimateLabel');
  const exportResolutionSelect = document.getElementById('exportResolutionSelect');
  const exportImageQualitySlider = document.getElementById('exportImageQualitySlider');
  const exportImageQualityVal = document.getElementById('exportImageQualityVal');

  btnProcessBatch.addEventListener('click', () => {
    if (state.selectedMediaIds.size === 0) {
      alert("Please select at least one media file to process.");
      return;
    }
    exportModalFileCount.innerText = state.selectedMediaIds.size;
    exportOptionsModal.classList.add('open');
  });

  btnCloseExportModal.addEventListener('click', () => exportOptionsModal.classList.remove('open'));
  btnCancelExport.addEventListener('click', () => exportOptionsModal.classList.remove('open'));

  // Export Mode toggles (Watermark + Compress vs Standalone Compress Only)
  exportModeBothBtn.addEventListener('click', () => {
    state.exportSettings.mode = 'watermark_and_compress';
    exportModeBothBtn.classList.add('active');
    exportModeCompressOnlyBtn.classList.remove('active');
  });

  exportModeCompressOnlyBtn.addEventListener('click', () => {
    state.exportSettings.mode = 'compress_only';
    exportModeCompressOnlyBtn.classList.add('active');
    exportModeBothBtn.classList.remove('active');
  });

  // Compression Preset Cards
  document.querySelectorAll('.preset-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.preset-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      const preset = card.dataset.preset;
      state.exportSettings.video_preset = preset;
      if (preset === 'balanced') {
        compressionEstimateLabel.innerText = '~50-65% smaller';
      } else if (preset === 'master') {
        compressionEstimateLabel.innerText = '~20% smaller (Master)';
      } else if (preset === 'compressed') {
        compressionEstimateLabel.innerText = '~75-85% smaller (Max)';
      }
    });
  });

  // Resolution selection
  exportResolutionSelect.addEventListener('change', (e) => {
    state.exportSettings.video_resolution = e.target.value;
  });

  // Image quality slider
  exportImageQualitySlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    state.exportSettings.image_quality = val;
    let label = `${val}%`;
    if (val >= 90) label += ' (High Quality)';
    else if (val >= 80) label += ' (Optimized - Recommended)';
    else label += ' (Compact)';
    exportImageQualityVal.innerText = label;
  });

  btnConfirmExport.addEventListener('click', () => {
    exportOptionsModal.classList.remove('open');
    startBatchProcessing();
  });

  btnCloseModal.addEventListener('click', () => progressModal.classList.remove('open'));

  // Canvas Drag for Freeform Placement
  setupCanvasDraggable();
}

function setRotationPreset(deg) {
  layerRotationSlider.value = deg;
  rotationVal.innerText = `${deg}°`;
  getActiveLayer().rotation = deg;
  requestLivePreview();
}

function setLayoutMode(mode) {
  const layer = getActiveLayer();
  layer.layout_mode = mode;
  if (mode === 'single') {
    modeSingleBtn.classList.add('active');
    modeTiledBtn.classList.remove('active');
    singleLayoutControls.style.display = 'flex';
    tiledLayoutControls.style.display = 'none';
  } else {
    modeSingleBtn.classList.remove('active');
    modeTiledBtn.classList.add('active');
    singleLayoutControls.style.display = 'none';
    tiledLayoutControls.style.display = 'flex';
  }
  requestLivePreview();
}

function addLayer(type) {
  pushWmHistorySnapshot(true);
  const newId = `layer_${Date.now()}`;
  const newLayer = {
    id: newId,
    layer_type: type,
    enabled: true,
    layout_mode: 'single',
    position: 'bottom-right',
    custom_x: 0.8,
    custom_y: 0.8,
    margin_x: 24,
    margin_y: 24,
    rotation: 0,
    opacity: 0.85,
    tile_spacing_x: 160,
    tile_spacing_y: 120,
    tile_stagger: true,
    text: type === 'text' ? 'New Watermark' : '',
    font_family: 'Arial',
    font_size: 36,
    font_bold: false,
    color: '#ffffff',
    shadow_enabled: true,
    shadow_color: '#000000',
    shadow_offset: 2,
    stroke_enabled: false,
    stroke_color: '#000000',
    stroke_width: 2,
    bg_enabled: false,
    bg_color: '#000000',
    bg_opacity: 0.5,
    bg_padding: 8,
    bg_radius: 6,
    image_filename: null,
    scale_percent: 15.0
  };
  state.layers.push(newLayer);
  state.activeLayerId = newId;
  renderLayersTabs();
  syncFormToActiveLayer();
  requestLivePreview();
}

function deleteActiveLayer() {
  if (state.layers.length <= 1) {
    alert("You must keep at least one watermark layer.");
    return;
  }
  pushWmHistorySnapshot(true);
  state.layers = state.layers.filter(l => l.id !== state.activeLayerId);
  state.activeLayerId = state.layers[0].id;
  renderLayersTabs();
  syncFormToActiveLayer();
  requestLivePreview();
}

function renderLayersTabs() {
  btnDeleteLayer.disabled = state.layers.length <= 1;
  layersTabs.innerHTML = '';
  state.layers.forEach((layer, idx) => {
    const btn = document.createElement('button');
    btn.className = `layer-tab-btn ${layer.id === state.activeLayerId ? 'active' : ''}`;
    const icon = layer.layer_type === 'text' ? '🔤' : '🖼️';
    const label = layer.layer_type === 'text' ? (layer.text.substring(0, 10) || `Text ${idx + 1}`) : `Logo ${idx + 1}`;
    btn.innerHTML = `<span>${icon}</span> <span>${escapeHtml(label)}</span>`;
    btn.addEventListener('click', () => {
      state.activeLayerId = layer.id;
      renderLayersTabs();
      syncFormToActiveLayer();
    });
    layersTabs.appendChild(btn);
  });
}

function updateLayerTabTitle() {
  renderLayersTabs();
}

function syncFormToActiveLayer() {
  const layer = getActiveLayer();
  if (!layer) return;

  // Toggle Text vs Image groups
  if (layer.layer_type === 'text') {
    textSettingsGroup.style.display = 'flex';
    imageSettingsGroup.style.display = 'none';
    layerTextInput.value = layer.text;
    layerFontSelect.value = layer.font_family;
    layerFontSizeSlider.value = layer.font_size;
    fontSizeVal.innerText = `${layer.font_size}px`;
    layerTextColor.value = layer.color;
    layerTextColorHex.innerText = layer.color;
    layerBoldCheck.checked = layer.font_bold;
    layerShadowCheck.checked = layer.shadow_enabled;
    layerBgEnableCheck.checked = layer.bg_enabled;
    badgeOptionsPanel.style.display = layer.bg_enabled ? 'flex' : 'none';
    layerBgColor.value = layer.bg_color;
    layerBgOpacitySlider.value = Math.round(layer.bg_opacity * 100);
    if (layerStrokeEnableCheck) {
      layerStrokeEnableCheck.checked = !!layer.stroke_enabled;
      if (strokeOptionsPanel) strokeOptionsPanel.style.display = layer.stroke_enabled ? 'flex' : 'none';
      if (layerStrokeColor) layerStrokeColor.value = layer.stroke_color || '#000000';
      const sw = layer.stroke_width || 2;
      if (layerStrokeWidthSlider) layerStrokeWidthSlider.value = sw;
      if (strokeWidthVal) strokeWidthVal.innerText = `${sw}px`;
    }
  } else {
    textSettingsGroup.style.display = 'none';
    imageSettingsGroup.style.display = 'flex';
    layerLogoScaleSlider.value = layer.scale_percent;
    logoScaleVal.innerText = `${layer.scale_percent}%`;
    if (layer.image_filename) {
      const rawLogoUrl = `/api/uploads/${encodeURIComponent(layer.image_filename)}`;
      const resolvedLogoUrl = window.resolveStudioUrl ? window.resolveStudioUrl(rawLogoUrl) : rawLogoUrl;
      logoPreviewThumb.innerHTML = `<img src="${resolvedLogoUrl}" style="width:100%;height:100%;object-fit:cover;">`;
    } else {
      logoPreviewThumb.innerHTML = `<span style="font-size:10px;color:var(--text-dim);">None</span>`;
    }
  }

  // Layout mode
  setLayoutMode(layer.layout_mode);

  // Position Matrix
  document.querySelectorAll('.matrix-btn').forEach(btn => {
    if (btn.dataset.pos === layer.position) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // Margins
  layerMarginXSlider.value = layer.margin_x;
  marginXVal.innerText = `${layer.margin_x}px`;
  layerMarginYSlider.value = layer.margin_y;
  marginYVal.innerText = `${layer.margin_y}px`;

  // Tiled Spacing
  layerTileSpaceXSlider.value = layer.tile_spacing_x;
  tileSpaceXVal.innerText = `${layer.tile_spacing_x}px`;
  layerTileSpaceYSlider.value = layer.tile_spacing_y;
  tileSpaceYVal.innerText = `${layer.tile_spacing_y}px`;
  layerTileStaggerCheck.checked = layer.tile_stagger;

  // Opacity & Rotation
  layerOpacitySlider.value = Math.round(layer.opacity * 100);
  opacityVal.innerText = `${Math.round(layer.opacity * 100)}%`;
  layerRotationSlider.value = layer.rotation;
  rotationVal.innerText = `${layer.rotation}°`;
}

// Canvas Draggable Setup (Supports both Desktop Mouse and Mobile Touch Dragging)
function setupCanvasDraggable() {
  let isDragging = false;

  function getClientCoords(e) {
    if (e.touches && e.touches.length > 0) {
      return { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
    }
    return { clientX: e.clientX, clientY: e.clientY };
  }

  function updateCoordFromPointer(e) {
    const activeMedia = state.mediaList.find(m => m.id === state.activeMediaId);
    let targetEl = previewImg;
    if (activeMedia && activeMedia.media_type === 'video') {
      targetEl = videoWatermarkOverlay;
    }
    if (!targetEl || targetEl.style.display === 'none') return;
    const rect = targetEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const { clientX, clientY } = getClientCoords(e);

    // Constrain to actual media bounds on screen
    const xRatio = Math.max(0.01, Math.min(0.99, (clientX - rect.left) / rect.width));
    const yRatio = Math.max(0.01, Math.min(0.99, (clientY - rect.top) / rect.height));

    const layer = getActiveLayer();
    if (!layer || layer.layout_mode === 'tiled') return;

    layer.position = 'custom';
    layer.custom_x = Math.round(xRatio * 1000) / 1000;
    layer.custom_y = Math.round(yRatio * 1000) / 1000;

    // Deselect 9-grid buttons since it is now custom
    document.querySelectorAll('.matrix-btn').forEach(b => b.classList.remove('active'));

    requestLivePreview(false);
  }

  // Mouse events
  canvasWrapper.addEventListener('mousedown', (e) => {
    if (e.target.closest('.video-controls-bar')) return;
    const layer = getActiveLayer();
    if (!layer || layer.layout_mode === 'tiled') return;
    isDragging = true;
    updateCoordFromPointer(e);
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    updateCoordFromPointer(e);
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      pushWmHistorySnapshot(true);
      requestLivePreview(true);
    }
  });

  // Mobile Touch events
  canvasWrapper.addEventListener('touchstart', (e) => {
    if (e.target.closest('.video-controls-bar')) return;
    const layer = getActiveLayer();
    if (!layer || layer.layout_mode === 'tiled') return;
    e.preventDefault();
    isDragging = true;
    updateCoordFromPointer(e);
  }, { passive: false });

  window.addEventListener('touchmove', (e) => {
    if (!isDragging) return;
    e.preventDefault();
    updateCoordFromPointer(e);
  }, { passive: false });

  window.addEventListener('touchend', () => {
    if (isDragging) {
      isDragging = false;
      pushWmHistorySnapshot(true);
      requestLivePreview(true);
    }
  });
}

// Media Uploads
async function handleFilesUpload(files) {
  if (!files || !files.length) return;
  const formData = new FormData();
  for (let i = 0; i < files.length; i++) {
    formData.append('files', files[i]);
  }
  if (window.STUDIO_TAB_SESSION_ID) {
    formData.append('session_id', window.STUDIO_TAB_SESSION_ID);
  }

  try {
    const res = await fetch('/api/upload-media', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (data.media) {
      data.media.forEach(m => {
        state.mediaList.push(m);
        state.selectedMediaIds.add(m.id);
      });
      if (!state.activeMediaId && state.mediaList.length) {
        state.activeMediaId = state.mediaList[0].id;
      }
      renderMediaList();
      updateSelectedCount();
      requestLivePreview(true);
    }
  } catch (err) {
    console.error("Upload error:", err);
    alert("Failed to upload media files.");
  }
}

// Logo Upload
async function handleLogoUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);
  if (window.STUDIO_TAB_SESSION_ID) {
    formData.append('session_id', window.STUDIO_TAB_SESSION_ID);
  }
  e.target.value = '';

  try {
    const res = await fetch('/api/upload-watermark-logo', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (data.filename) {
      const layer = getActiveLayer();
      layer.image_filename = data.filename;
      logoPreviewThumb.innerHTML = `<img src="${data.preview_url}" style="width:100%;height:100%;object-fit:cover;">`;
      requestLivePreview(true);
    }
  } catch (err) {
    console.error("Logo upload error:", err);
    alert("Failed to upload logo.");
  }
}

function renderMediaList() {
  mediaCountEl.innerText = `${state.mediaList.length} files`;
  btnClearMedia.disabled = state.mediaList.length === 0;
  if (!state.mediaList.length) {
    mediaListEl.innerHTML = `
      <div style="text-align: center; color: var(--text-dim); padding: 30px 10px; font-size: 13px;">
        No media uploaded yet.<br>Drag and drop files to get started!
      </div>`;
    return;
  }

  mediaListEl.innerHTML = '';
  state.mediaList.forEach(m => {
    const card = document.createElement('div');
    card.className = `media-card ${m.id === state.activeMediaId ? 'active' : ''}`;

    const isChecked = state.selectedMediaIds.has(m.id);
    const badgeClass = m.media_type === 'image' ? 'img' : 'vid';
    const badgeText = m.media_type === 'image' ? 'IMG' : `${m.duration}s`;

    card.innerHTML = `
      <input type="checkbox" class="media-select-chk" ${isChecked ? 'checked' : ''} style="cursor: pointer;">
      <div class="media-thumb-wrapper">
        <img src="${m.thumb_url}" class="media-thumb-img" alt="">
        <span class="media-badge ${badgeClass}">${badgeText}</span>
      </div>
      <div class="media-info">
        <div class="media-filename" title="${escapeHtml(m.filename)}">${escapeHtml(m.filename)}</div>
        <div class="media-meta">${m.width}x${m.height} · ${(m.size_bytes / (1024*1024)).toFixed(1)}MB</div>
      </div>
      <button class="btn-delete-item" style="background:none;border:none;color:var(--text-dim);cursor:pointer;padding:4px;" title="Remove">&times;</button>
    `;

    // Click on card sets active preview
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('media-select-chk') || e.target.classList.contains('btn-delete-item')) return;
      state.activeMediaId = m.id;
      renderMediaList();
      requestLivePreview(true);
    });

    // Checkbox toggle
    card.querySelector('.media-select-chk').addEventListener('change', (e) => {
      if (e.target.checked) {
        state.selectedMediaIds.add(m.id);
      } else {
        state.selectedMediaIds.delete(m.id);
      }
      updateSelectedCount();
    });

    // Delete single
    card.querySelector('.btn-delete-item').addEventListener('click', (e) => {
      e.stopPropagation();
      state.mediaList = state.mediaList.filter(item => item.id !== m.id);
      state.selectedMediaIds.delete(m.id);
      if (state.activeMediaId === m.id) {
        state.activeMediaId = state.mediaList.length ? state.mediaList[0].id : null;
      }
      renderMediaList();
      updateSelectedCount();
      updatePreviewDisplay();
    });

    mediaListEl.appendChild(card);
  });
}

function updateSelectedCount() {
  const count = state.selectedMediaIds.size;
  selectedCountBadge.innerText = count;
  btnProcessBatch.disabled = (count === 0);
  selectAllCheckbox.checked = (count === state.mediaList.length && count > 0);
}

// Live Preview
let previewRequestId = 0;
function requestLivePreview(immediate = false) {
  if (state.previewDebounceTimer) {
    clearTimeout(state.previewDebounceTimer);
  }

  if (immediate) {
    executePreview();
  } else {
    state.previewDebounceTimer = setTimeout(executePreview, 250);
  }
}

function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

async function executePreview() {
  if (!state.activeMediaId) {
    updatePreviewDisplay();
    return;
  }

  const activeMedia = state.mediaList.find(m => m.id === state.activeMediaId);
  if (!activeMedia) return;

  const reqId = ++previewRequestId;
  canvasDimLabel.innerText = `${activeMedia.filename} (${activeMedia.width} x ${activeMedia.height})`;

  if (activeMedia.media_type === 'video') {
    // Live Video Preview with playing video and real-time watermark overlay!
    previewImg.style.display = 'none';
    videoContainer.style.display = 'flex';
    emptyStagePrompt.style.display = 'none';

    const rawVideoSrc = `/api/uploads/${encodeURIComponent(activeMedia.saved_filename)}`;
    const videoSrc = window.resolveStudioUrl ? window.resolveStudioUrl(rawVideoSrc) : rawVideoSrc;
    // Compare the stored file id, not the resolved URL: names with '#', '?', '%'
    // or emoji are percent-encoded in previewVideo.src, so a raw includes() check
    // would always miss and reload the video on every render.
    if (previewVideo.dataset.mediaFile !== activeMedia.saved_filename) {
      previewVideo.dataset.mediaFile = activeMedia.saved_filename;
      previewVideo.src = videoSrc;
      previewVideo.load();
      previewVideo.play().then(() => {
        btnPlayPause.innerText = '❚❚';
      }).catch(() => {
        btnPlayPause.innerText = '▶';
      });
    }

    try {
      const res = await fetch('/api/watermark-overlay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_ids: [state.activeMediaId],
          session_id: window.STUDIO_TAB_SESSION_ID || null,
          config: { layers: state.layers }
        })
      });
      const data = await res.json();
      if (reqId !== previewRequestId) return;
      if (data.overlay_url) {
        videoWatermarkOverlay.src = data.overlay_url;
        videoWatermarkOverlay.style.display = 'block';
      }
    } catch (err) {
      console.error("Video overlay render failed:", err);
    }
  } else {
    // Picture Preview
    if (previewVideo) {
      previewVideo.pause();
    }
    videoContainer.style.display = 'none';

    try {
      const res = await fetch('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_ids: [state.activeMediaId],
          session_id: window.STUDIO_TAB_SESSION_ID || null,
          config: { layers: state.layers }
        })
      });
      const data = await res.json();
      if (reqId !== previewRequestId) return;
      if (data.preview_url) {
        state.lastRenderedPreviewUrl = data.preview_url;
        if (!state.isPeekingOriginal) {
          previewImg.src = data.preview_url;
        }
        previewImg.style.display = 'block';
        emptyStagePrompt.style.display = 'none';
      }
    } catch (err) {
      console.error("Preview render failed:", err);
    }
  }
}

function updatePreviewDisplay() {
  btnRefreshPreview.disabled = !state.activeMediaId;
  if (!state.activeMediaId) {
    if (previewVideo) {
      previewVideo.pause();
      previewVideo.src = '';
    }
    previewImg.style.display = 'none';
    videoContainer.style.display = 'none';
    emptyStagePrompt.style.display = 'block';
    canvasDimLabel.innerText = 'Select media to preview';
  } else {
    requestLivePreview(true);
  }
}

// Batch Processing
async function startBatchProcessing() {
  const fileIds = Array.from(state.selectedMediaIds);
  if (!fileIds.length) {
    alert("Please select at least one media file to process.");
    return;
  }

  progressModal.classList.add('open');
  modalSpinner.style.display = 'inline-block';
  btnDownloadZip.style.display = 'none';
  modalProgressFill.style.width = '0%';
  modalProgressPercent.innerText = '0%';
  modalProgressText.innerText = `Starting batch for ${fileIds.length} files...`;

  try {
    const res = await fetch('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_ids: fileIds,
        session_id: window.STUDIO_TAB_SESSION_ID || null,
        config: {
          layers: state.layers,
          export_settings: state.exportSettings
        }
      })
    });
    const data = await res.json();
    state.activeJobId = data.job_id;
    pollJobStatus();
  } catch (err) {
    console.error("Failed to start job:", err);
    modalSpinner.style.display = 'none';
    modalProgressText.innerText = "Could not start batch processing.";
    alert("Could not start batch processing.");
  }
}

function pollJobStatus() {
  if (!state.activeJobId) return;

  fetch(`/api/job/${state.activeJobId}`)
    .then(r => r.json())
    .then(job => {
      const pct = Math.round(job.progress * 100);
      modalProgressFill.style.width = `${pct}%`;
      modalProgressPercent.innerText = `${pct}%`;

      // Render per-file item status rows
      modalItemList.innerHTML = '';
      job.items.forEach(item => {
        const row = document.createElement('div');
        row.className = 'job-item-row';
        let statusBadge = '';
        if (item.status === 'completed') {
          statusBadge = `<a href="${item.download_url}" download class="btn-secondary" style="padding:4px 10px;font-size:11px;text-decoration:none;color:var(--accent-cyan);border-color:var(--accent-cyan);">Download</a>`;
        } else if (item.status === 'failed') {
          statusBadge = `<span style="color:var(--accent-rose);font-size:11px;">Failed: ${escapeHtml(item.error || '')}</span>`;
        } else {
          statusBadge = `<span style="color:var(--text-dim);font-size:11px;display:flex;align-items:center;gap:6px;"><span class="spinner"></span> Processing</span>`;
        }

        row.innerHTML = `
          <div style="font-weight: 500; overflow:hidden; text-overflow:ellipsis; max-width: 320px;">${escapeHtml(item.filename)}</div>
          <div class="job-item-status">${statusBadge}</div>
        `;
        modalItemList.appendChild(row);
      });

      if (job.status === 'completed') {
        modalSpinner.style.display = 'none';
        const completedCount = job.items.filter(item => item.status === 'completed').length;
        const failedCount = job.items.filter(item => item.status === 'failed').length;
        modalProgressText.innerText = failedCount
          ? `${completedCount} of ${job.items.length} files processed; ${failedCount} failed.`
          : `All ${completedCount} files processed successfully!`;
        const rawZipUrl = `/api/download-zip/${state.activeJobId}`;
        btnDownloadZip.href = window.resolveStudioUrl ? window.resolveStudioUrl(rawZipUrl) : rawZipUrl;
        btnDownloadZip.style.display = completedCount ? 'inline-flex' : 'none';
      } else if (job.status === 'failed' || job.status === 'cancelled') {
        modalSpinner.style.display = 'none';
        modalProgressText.innerText = job.status === 'cancelled'
          ? 'Processing cancelled.'
          : (job.error || 'Processing failed.');
      } else {
        modalProgressText.innerText = `Processing batch (${pct}% completed)...`;
        setTimeout(pollJobStatus, 800);
      }
    })
    .catch(err => {
      console.error("Job status polling error:", err);
    });
}

function pushWmHistorySnapshot(clearRedo = true) {
  const snap = JSON.stringify({
    layers: state.layers,
    activeLayerId: state.activeLayerId
  });
  if (state.undoStack.length && state.undoStack[state.undoStack.length - 1] === snap) return;
  state.undoStack.push(snap);
  if (state.undoStack.length > 40) state.undoStack.shift();
  if (clearRedo) state.redoStack = [];
  syncWmHistoryButtons();
}

function syncWmHistoryButtons() {
  if (btnWmUndo) btnWmUndo.disabled = state.undoStack.length <= 1;
  if (btnWmRedo) btnWmRedo.disabled = state.redoStack.length === 0;
}

function wmUndo() {
  if (state.undoStack.length <= 1) return;
  const current = state.undoStack.pop();
  state.redoStack.push(current);
  const prev = JSON.parse(state.undoStack[state.undoStack.length - 1]);
  state.layers = prev.layers;
  state.activeLayerId = prev.activeLayerId;
  renderLayersTabs();
  syncFormToActiveLayer();
  syncWmHistoryButtons();
  requestLivePreview(true);
}

function wmRedo() {
  if (!state.redoStack.length) return;
  const nextSnap = state.redoStack.pop();
  state.undoStack.push(nextSnap);
  const next = JSON.parse(nextSnap);
  state.layers = next.layers;
  state.activeLayerId = next.activeLayerId;
  renderLayersTabs();
  syncFormToActiveLayer();
  syncWmHistoryButtons();
  requestLivePreview(true);
}

function setWmZoom(nextZoom) {
  state.wmZoom = Math.max(0.5, Math.min(3.0, Math.round(nextZoom * 100) / 100));
  if (wmZoomVal) wmZoomVal.innerText = `${Math.round(state.wmZoom * 100)}%`;
  if (canvasWrapper) {
    canvasWrapper.style.transformOrigin = 'center center';
    canvasWrapper.style.transform = state.wmZoom === 1 ? '' : `scale(${state.wmZoom})`;
  }
}

function setPeekOriginal(peeking) {
  state.isPeekingOriginal = peeking;
  const activeMedia = state.mediaList.find(m => m.id === state.activeMediaId);
  if (!activeMedia) return;
  if (activeMedia.media_type === 'video') {
    videoWatermarkOverlay.style.display = peeking ? 'none' : 'block';
  } else if (peeking) {
    const rawOrig = `/api/uploads/${encodeURIComponent(activeMedia.saved_filename)}`;
    previewImg.src = window.resolveStudioUrl ? window.resolveStudioUrl(rawOrig) : rawOrig;
  } else if (state.lastRenderedPreviewUrl) {
    previewImg.src = state.lastRenderedPreviewUrl;
  }
}

function getSavedWmPresets() {
  try {
    return JSON.parse(localStorage.getItem(WM_PRESETS_STORAGE_KEY) || '{}');
  } catch (_) {
    return {};
  }
}

function renderSavedPresetsList() {
  if (!savedWmPresetsRow || !savedWmPresetsSelect) return;
  const presets = getSavedWmPresets();
  const names = Object.keys(presets);
  if (!names.length) {
    savedWmPresetsRow.style.display = 'none';
    return;
  }
  savedWmPresetsRow.style.display = 'flex';
  savedWmPresetsSelect.innerHTML = names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
}

function saveCurrentWmPreset() {
  const name = prompt('Preset name (saved in browser):', 'My Watermark Style');
  if (!name || !name.trim()) return;
  const presets = getSavedWmPresets();
  presets[name.trim()] = state.layers;
  localStorage.setItem(WM_PRESETS_STORAGE_KEY, JSON.stringify(presets));
  renderSavedPresetsList();
  if (savedWmPresetsSelect) savedWmPresetsSelect.value = name.trim();
}

function applySelectedSavedPreset() {
  if (!savedWmPresetsSelect || !savedWmPresetsSelect.value) return;
  const presets = getSavedWmPresets();
  const layers = presets[savedWmPresetsSelect.value];
  if (!Array.isArray(layers) || !layers.length) return;
  pushWmHistorySnapshot(true);
  state.layers = JSON.parse(JSON.stringify(layers));
  state.activeLayerId = state.layers[0].id;
  renderLayersTabs();
  syncFormToActiveLayer();
  requestLivePreview(true);
}

function deleteSelectedSavedPreset() {
  if (!savedWmPresetsSelect || !savedWmPresetsSelect.value) return;
  const presets = getSavedWmPresets();
  delete presets[savedWmPresetsSelect.value];
  localStorage.setItem(WM_PRESETS_STORAGE_KEY, JSON.stringify(presets));
  renderSavedPresetsList();
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, function(m) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
  });
}

document.addEventListener('DOMContentLoaded', init);
