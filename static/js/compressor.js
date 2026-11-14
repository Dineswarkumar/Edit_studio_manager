// Standalone File Space Compressor Client Logic

let compState = {
  mediaList: [],
  activeMediaId: null,
  activeJobId: null,
  settings: {
    mode: "compress_only",
    video_preset: "balanced",
    video_resolution: "original",
    image_quality: 85
  }
};

const compDropzone = document.getElementById('compDropzone');
const compFileInput = document.getElementById('compFileInput');
const compMediaList = document.getElementById('compMediaList');
const compQueueCount = document.getElementById('compQueueCount');
const totalInputSizeLabel = document.getElementById('totalInputSizeLabel');
const btnClearComp = document.getElementById('btnClearComp');
const btnStartCompress = document.getElementById('btnStartCompress');
const compCountBadge = document.getElementById('compCountBadge');

const compEstimateText = document.getElementById('compEstimateText');
const compResolutionSelect = document.getElementById('compResolutionSelect');
const compImageQualitySlider = document.getElementById('compImageQualitySlider');
const compImageQualityVal = document.getElementById('compImageQualityVal');

const compResultsSection = document.getElementById('compResultsSection');
const compSpinner = document.getElementById('compSpinner');
const compStatusTitle = document.getElementById('compStatusTitle');
const compOverallPct = document.getElementById('compOverallPct');
const compProgressFill = document.getElementById('compProgressFill');
const compSummaryBanner = document.getElementById('compSummaryBanner');
const compResultList = document.getElementById('compResultList');
const btnCompDownloadZip = document.getElementById('btnCompDownloadZip');
const compressPreviewImg = document.getElementById('compressPreviewImg');
const compressPreviewVideo = document.getElementById('compressPreviewVideo');
const compressPreviewEmpty = document.getElementById('compressPreviewEmpty');
const compressPreviewLabel = document.getElementById('compressPreviewLabel');
const compQualityHint = document.getElementById('compQualityHint');

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function initCompressor() {
  bindEvents();
  renderQueue();
}

function bindEvents() {
  compDropzone.addEventListener('click', () => compFileInput.click());
  compFileInput.addEventListener('change', (e) => { handleUpload(e.target.files); e.target.value = ''; });

  compDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    compDropzone.classList.add('dragover');
  });
  compDropzone.addEventListener('dragleave', () => compDropzone.classList.remove('dragover'));
  compDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    compDropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleUpload(e.dataTransfer.files);
  });

  btnClearComp.addEventListener('click', () => {
    compState.mediaList = [];
    compState.activeMediaId = null;
    renderQueue();
  });

  // Presets
  document.querySelectorAll('.preset-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.preset-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      const preset = card.dataset.preset;
      compState.settings.video_preset = preset;
      if (preset === 'balanced') compEstimateText.innerText = '~50-65% size reduction';
      else if (preset === 'master') compEstimateText.innerText = '~20% size reduction (Master)';
      else if (preset === 'compressed') compEstimateText.innerText = '~75-85% size reduction (Max)';
    });
  });

  compResolutionSelect.addEventListener('change', (e) => {
    compState.settings.video_resolution = e.target.value;
  });

  compImageQualitySlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    compState.settings.image_quality = val;
    let label = `${val}%`;
    if (val >= 90) label += ' (High Quality)';
    else if (val >= 80) label += ' (Optimized - Recommended)';
    else label += ' (Compact)';
    compImageQualityVal.innerText = label;
  });

  btnStartCompress.addEventListener('click', startCompressionJob);
}

async function handleUpload(files) {
  if (!files || !files.length) return;
  const formData = new FormData();
  for (let i = 0; i < files.length; i++) {
    formData.append('files', files[i]);
  }
  if (window.STUDIO_TAB_SESSION_ID) {
    formData.append('session_id', window.STUDIO_TAB_SESSION_ID);
  }

  try {
    const res = await fetch('/api/compress/upload', {
      method: 'POST',
      body: formData
    });
    if (!res.ok) throw new Error(`Upload failed (${res.status})`);
    const data = await res.json();
    if (data.media) {
      data.media.forEach(m => compState.mediaList.push(m));
      renderQueue();
    }
  } catch (err) {
    console.error("Upload error:", err);
    alert(err.message || "Failed to upload files.");
  }
}

function renderQueue() {
  const count = compState.mediaList.length;
  btnClearComp.disabled = count === 0;
  if (!compState.mediaList.some(m => m.id === compState.activeMediaId)) {
    compState.activeMediaId = compState.mediaList.length ? compState.mediaList[0].id : null;
  }
  compQueueCount.innerText = `${count} files ready`;
  compCountBadge.innerText = count;
  btnStartCompress.disabled = (count === 0);

  const totalBytes = compState.mediaList.reduce((acc, m) => acc + (m.size_bytes || 0), 0);
  totalInputSizeLabel.innerText = `Total: ${formatBytes(totalBytes)}`;

  if (count === 0) {
    compMediaList.innerHTML = `
      <div style="text-align: center; color: var(--text-dim); padding: 40px 10px; font-size: 13px;">
        No files added yet.<br>Drop any file above to compress it.
      </div>`;
    updateCompressorPreview();
    return;
  }

  compMediaList.innerHTML = '';
  compState.mediaList.forEach(m => {
    const card = document.createElement('div');
    card.className = `media-card ${m.id === compState.activeMediaId ? 'active' : ''}`;
    const isVisual = m.media_type === 'image' || m.media_type === 'video';
    const badgeClass = m.media_type === 'image' ? 'img' : (m.media_type === 'video' ? 'vid' : 'doc');
    const badgeText = m.media_type === 'image' ? 'IMG' : (m.media_type === 'video' ? `${m.duration}s` : escapeHtml(m.format_name || 'FILE'));
    const ext = (m.filename.split('.').pop() || '').toLowerCase();
    const documentMethod = ext === 'pdf' ? 'PDF image optimization'
      : ['docx','pptx','xlsx','odt','odp','ods','epub'].includes(ext) ? 'embedded image optimization'
      : ext === 'zip' ? 'lossless archive repackaging' : 'lossless .gz output';
    const dimensions = isVisual ? `${m.width} × ${m.height}` : `${m.format_name || 'File'} · ${documentMethod}`;

    card.innerHTML = `
      <div class="media-thumb-wrapper">
        ${isVisual ? `<img src="${m.thumb_url}" class="media-thumb-img" alt="">` : `<span class="media-file-icon" aria-hidden="true">${escapeHtml((m.format_name || 'FILE').slice(0,4))}</span>`}
        <span class="media-badge ${badgeClass}">${badgeText}</span>
      </div>
      <div class="media-info">
        <div class="media-filename" title="${escapeHtml(m.filename)}">${escapeHtml(m.filename)}</div>
        <div class="media-meta">${escapeHtml(dimensions)} · <span style="color: var(--accent-cyan); font-weight: 600;">${formatBytes(m.size_bytes)}</span></div>
      </div>
      <button class="btn-remove-item" style="background:none;border:none;color:var(--text-dim);cursor:pointer;padding:4px;" title="Remove">&times;</button>
    `;

    card.addEventListener('click', (event) => {
      if (event.target.closest('.btn-remove-item')) return;
      compState.activeMediaId = m.id;
      renderQueue();
    });

    card.querySelector('.btn-remove-item').addEventListener('click', () => {
      compState.mediaList = compState.mediaList.filter(item => item.id !== m.id);
      renderQueue();
    });

    compMediaList.appendChild(card);
  });
  updateCompressorPreview();
}

function updateCompressorPreview() {
  const media = compState.mediaList.find(item => item.id === compState.activeMediaId);
  if (!media) {
    compressPreviewImg.style.display = 'none';
    compressPreviewVideo.pause();
    compressPreviewVideo.removeAttribute('src');
    compressPreviewVideo.style.display = 'none';
    compressPreviewEmpty.style.display = 'block';
    compressPreviewEmpty.textContent = 'Add media to preview';
    compressPreviewLabel.innerText = 'Select a file';
    compQualityHint.innerText = 'Choose a file to see which settings apply.';
    return;
  }
  const source = `/api/uploads/${encodeURIComponent(media.saved_filename)}`;
  compressPreviewLabel.innerText = media.media_type === 'document'
    ? `${media.format_name || 'FILE'} · ${formatBytes(media.size_bytes)}`
    : `${media.width} × ${media.height}`;
  compressPreviewEmpty.textContent = 'Add media to preview';
  compressPreviewEmpty.style.display = 'none';
  if (media.media_type === 'document') {
    compressPreviewImg.style.display = 'none';
    compressPreviewVideo.pause();
    compressPreviewVideo.removeAttribute('src');
    compressPreviewVideo.style.display = 'none';
    const ext = (media.filename.split('.').pop() || '').toLowerCase();
    const packageFormats = ['docx','pptx','xlsx','odt','odp','ods','epub'];
    const note = ext === 'pdf'
      ? 'PDF ready. Embedded images can be downsampled and re-encoded; vector and text content stays intact.'
      : packageFormats.includes(ext)
        ? `${ext.toUpperCase()} ready. Supported embedded images can be re-encoded; document content stays intact.`
        : ext === 'zip'
          ? 'ZIP ready. Repacked losslessly; the output remains a ZIP archive.'
          : `${media.format_name || 'File'} ready. This format is packed losslessly as a .gz file; its internal quality is unchanged.`;
    compressPreviewEmpty.textContent = note;
    compressPreviewEmpty.style.display = 'block';
    compQualityHint.innerText = note;
    return;
  }
  compQualityHint.innerText = media.media_type === 'video'
    ? 'Video quality and resolution use the settings above.'
    : 'Image quality applies to JPEG and WebP. PNG stays lossless.';
  if (media.media_type === 'video') {
    compressPreviewImg.style.display = 'none';
    compressPreviewVideo.style.display = 'block';
    if (!compressPreviewVideo.src.endsWith(encodeURIComponent(media.saved_filename))) {
      compressPreviewVideo.src = source;
      compressPreviewVideo.load();
    }
  } else {
    compressPreviewVideo.pause();
    compressPreviewVideo.removeAttribute('src');
    compressPreviewVideo.style.display = 'none';
    compressPreviewImg.src = media.preview_url || source;
    compressPreviewImg.style.display = 'block';
  }
}

async function startCompressionJob() {
  const fileIds = compState.mediaList.map(m => m.id);
  if (!fileIds.length) return;

  compResultsSection.style.display = 'flex';
  compSpinner.style.display = 'inline-block';
  btnCompDownloadZip.style.display = 'none';
  compSummaryBanner.style.display = 'none';
  compProgressFill.style.width = '0%';
  compOverallPct.innerText = '0%';
  compStatusTitle.innerText = `Compressing ${fileIds.length} files...`;
  compResultList.innerHTML = '';

  btnStartCompress.disabled = true;

  try {
    const res = await fetch('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_ids: fileIds,
        session_id: window.STUDIO_TAB_SESSION_ID || null,
        config: {
          layers: [],
          export_settings: compState.settings
        }
      })
    });
    const data = await res.json();
    compState.activeJobId = data.job_id;
    pollCompressionJob();
  } catch (err) {
    console.error("Compression start failed:", err);
    alert("Could not start compression job.");
    btnStartCompress.disabled = false;
  }
}

function pollCompressionJob() {
  if (!compState.activeJobId) return;

  fetch(`/api/job/${compState.activeJobId}`)
    .then(r => r.json())
    .then(job => {
      const pct = Math.round(job.progress * 100);
      compProgressFill.style.width = `${pct}%`;
      compOverallPct.innerText = `${pct}%`;

      compResultList.innerHTML = '';
      let totalOrig = 0;
      let totalComp = 0;

      job.items.forEach(item => {
        const row = document.createElement('div');
        row.className = 'job-item-row';
        
        const origBytes = item.orig_size_bytes || 0;
        const outBytes = item.output_size_bytes || 0;
        totalOrig += origBytes;
        totalComp += (outBytes > 0 ? outBytes : origBytes);

        let sizeTag = '';
        if (item.status === 'completed' && origBytes > 0 && outBytes > 0) {
          const byteDeltaPct = Math.round((1 - (outBytes / origBytes)) * 100);
          const sizeChangeText = byteDeltaPct >= 0
            ? `−${byteDeltaPct}%`
            : `${Math.abs(byteDeltaPct)}% larger`;
          const sizeChangeColor = byteDeltaPct >= 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)';
          sizeTag = `
            <span style="font-size: 11px; margin-right: 8px;">
              <span style="color: var(--text-dim); text-decoration: line-through;">${formatBytes(origBytes)}</span>
              → <span style="color: var(--text-main); font-weight: 700;">${formatBytes(outBytes)}</span>
              <span style="color: ${sizeChangeColor}; font-weight: 600;">(${sizeChangeText})</span>
            </span>
          `;
        }

        let actionBtn = '';
        if (item.status === 'completed') {
          actionBtn = `<a href="${item.download_url}" download class="btn-secondary" style="padding:4px 10px;font-size:11px;text-decoration:none;color:var(--accent-cyan);border-color:var(--accent-cyan);">Download</a>`;
        } else if (item.status === 'failed') {
          actionBtn = `<span style="color:var(--accent-rose);font-size:11px;">Error</span>`;
        } else {
          actionBtn = `<span style="color:var(--text-dim);font-size:11px;display:flex;align-items:center;gap:6px;"><span class="spinner"></span> Shrinking</span>`;
        }

        row.innerHTML = `
          <div style="font-weight: 500; overflow:hidden; text-overflow:ellipsis; max-width: 240px;" title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</div>
          <div class="job-item-status">
            ${sizeTag}
            ${actionBtn}
          </div>
        `;
        compResultList.appendChild(row);
      });

      if (job.status === 'completed') {
        compSpinner.style.display = 'none';
        const completedCount = job.items.filter(item => item.status === 'completed').length;
        const failedCount = job.items.filter(item => item.status === 'failed').length;
        compStatusTitle.innerText = failedCount
          ? `${completedCount} of ${job.items.length} files compressed; ${failedCount} failed.`
          : `All ${completedCount} files compressed!`;
        btnCompDownloadZip.href = `/api/download-zip/${compState.activeJobId}`;
        btnCompDownloadZip.style.display = 'inline-flex';
        btnStartCompress.disabled = false;

        if (totalOrig > 0 && totalComp > 0) {
          const savedTotalPct = Math.round((1 - (totalComp / totalOrig)) * 100);
          const totalChangeText = savedTotalPct >= 0
            ? `Saved ${savedTotalPct}% disk space.`
            : `Output is ${Math.abs(savedTotalPct)}% larger than the originals.`;
          const totalChangeColor = savedTotalPct >= 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)';
          compSummaryBanner.style.display = 'block';
          compSummaryBanner.innerHTML = `
            🎉 <strong>Compression Complete!</strong> <strong>${formatBytes(totalOrig)}</strong> → <strong>${formatBytes(totalComp)}</strong> — <span style="color: ${totalChangeColor}; font-weight: 700;">${totalChangeText}</span>${failedCount ? ` <span style="color: var(--accent-rose);">${failedCount} file${failedCount === 1 ? '' : 's'} failed.</span>` : ''}
          `;
        }
      } else if (job.status === 'failed' || job.status === 'cancelled') {
        compSpinner.style.display = 'none';
        compStatusTitle.innerText = job.status === 'cancelled' ? 'Compression cancelled.' : (job.error || 'Compression failed.');
        btnStartCompress.disabled = false;
      } else {
        compStatusTitle.innerText = `Compressing media (${pct}% done)...`;
        setTimeout(pollCompressionJob, 800);
      }
    })
    .catch(err => {
      console.error("Poll compression error:", err);
    });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, function(m) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
  });
}

document.addEventListener('DOMContentLoaded', initCompressor);
