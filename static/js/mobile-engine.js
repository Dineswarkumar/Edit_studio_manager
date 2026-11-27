/**
 * Frame Studio — Offline Mobile Processing Engine & Bridge
 *
 * When running inside the offline Android APK WebView or with ?offline=1,
 * transparently intercepts /api/* fetch and XHR calls so all 5 studios
 * (Watermark, Compress, Thumbnail, Collage, Privacy/Censor) execute 100% locally
 * in the device's browser/WebView engine with Canvas, Shape Detection / JS CV,
 * WebCodecs/MediaRecorder, and JSZip, and routes file downloads to Android's
 * native MediaStore bridge when present.
 *
 * On desktop / LAN server sessions, acts as a zero-overhead pass-through.
 */
(function (global) {
  "use strict";

  const params = new URLSearchParams(global.location ? global.location.search : "");
  const IS_ANDROID_BRIDGE = typeof global.FrameStudioNative !== "undefined";
  const IS_ANDROID_ASSET_HOST =
    typeof global.location !== "undefined" &&
    (global.location.protocol === "file:" ||
      global.location.hostname === "appassets.androidplatform.net");
  const IS_OFFLINE_PARAM = params.get("offline") === "1";

  const OFFLINE_MODE = Boolean(IS_ANDROID_BRIDGE || IS_ANDROID_ASSET_HOST || IS_OFFLINE_PARAM);
  global.FRAME_STUDIO_OFFLINE = OFFLINE_MODE;

  // Virtual object store for offline mode
  const blobUrlMap = new Map(); // virtual /api/... path -> blob:... url
  const blobMetaMap = new Map(); // blob:... url -> { blob, filename, mimeType }
  const mediaRegistry = new Map(); // file_id -> media metadata + { file, objectUrl, mediaEl }
  const savedFilenameToId = new Map(); // saved_filename -> file_id
  const logoRegistry = new Map(); // filename -> { blob, url, width, height }
  const tempFrameRegistry = new Map(); // filename -> { blob, url, width, height, timestamp_sec }
  const jobRegistry = new Map(); // job_id -> job state

  let seqCounter = 1;
  function nextId(prefix) {
    seqCounter += 1;
    return `${prefix}_${Date.now().toString(36)}_${seqCounter}`;
  }

  function stripQueryAndOrigin(url) {
    if (!url || typeof url !== "string") return "";
    let clean = url.trim();
    if (clean.startsWith("http://") || clean.startsWith("https://")) {
      try {
        const parsed = new URL(clean);
        if (parsed.origin === global.location.origin) {
          clean = parsed.pathname + parsed.search;
        }
      } catch (_) {}
    }
    const qIdx = clean.indexOf("?");
    if (qIdx !== -1 && clean.startsWith("/api/")) {
      clean = clean.slice(0, qIdx);
    }
    return clean;
  }

  function registerBlobUrl(virtualPath, blob, filename, mimeType) {
    const resolvedMime = mimeType || blob.type || "application/octet-stream";
    const blobUrl = URL.createObjectURL(blob);
    blobMetaMap.set(blobUrl, {
      blob,
      filename: filename || (virtualPath ? virtualPath.split("/").pop() : "export.bin"),
      mimeType: resolvedMime,
    });
    if (virtualPath) {
      blobUrlMap.set(virtualPath, blobUrl);
      const encoded = virtualPath.replace(/[^/]+$/, (part) => encodeURIComponent(part));
      if (encoded !== virtualPath) {
        blobUrlMap.set(encoded, blobUrl);
      }
      try {
        const decoded = decodeURIComponent(virtualPath);
        if (decoded !== virtualPath) {
          blobUrlMap.set(decoded, blobUrl);
        }
      } catch (_) {}
    }
    return blobUrl;
  }

  function resolveStudioUrl(url) {
    if (!url || typeof url !== "string") return url;
    if (!OFFLINE_MODE) return url;
    if (url.startsWith("blob:") || url.startsWith("data:")) return url;

    const clean = stripQueryAndOrigin(url);
    if (blobUrlMap.has(url)) return blobUrlMap.get(url);
    if (blobUrlMap.has(clean)) return blobUrlMap.get(clean);
    try {
      const dec = decodeURIComponent(clean);
      if (blobUrlMap.has(dec)) return blobUrlMap.get(dec);
    } catch (_) {}
    return url;
  }

  global.resolveStudioUrl = resolveStudioUrl;

  // Preserve ?offline=1 across internal navigation links when testing locally in browser
  if (IS_OFFLINE_PARAM && !IS_ANDROID_BRIDGE && !IS_ANDROID_ASSET_HOST) {
    global.addEventListener("DOMContentLoaded", () => {
      document.querySelectorAll("a[href]").forEach((anchor) => {
        const href = anchor.getAttribute("href");
        if (!href || href.startsWith("#") || href.startsWith("http") || href.startsWith("blob:") || href.startsWith("data:")) {
          return;
        }
        if (href.startsWith("/") && !href.startsWith("/api/") && !href.includes("offline=")) {
          anchor.setAttribute("href", href + (href.includes("?") ? "&" : "?") + "offline=1");
        }
      });
    });
  }

  // Android WebView native download bridge (chunked to stay well under Binder 1MB limit)
  async function saveBlobToAndroidNative(blob, filename, mimeType) {
    const bridge = global.FrameStudioNative;
    if (!bridge) return false;

    const safeName = (filename || "framestudio_export.bin").replace(/[\\/:*?"<>|]/g, "_");
    const safeMime = mimeType || blob.type || "application/octet-stream";
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    if (typeof bridge.beginFileWrite === "function" &&
        typeof bridge.appendFileChunk === "function" &&
        typeof bridge.finishFileWrite === "function") {
      const handle = bridge.beginFileWrite(safeName, safeMime);
      const CHUNK_BYTES = 180 * 1024; // multiple of 3 -> no base64 padding mid-stream; ~240KB string per IPC call
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        const slice = bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.length));
        const b64 = uint8ToBase64(slice);
        bridge.appendFileChunk(handle, b64);
      }
      bridge.finishFileWrite(handle);
      return true;
    }

    if (typeof bridge.saveBase64File === "function") {
      bridge.saveBase64File(safeName, safeMime, uint8ToBase64(bytes));
      return true;
    }
    return false;
  }

  function uint8ToBase64(bytes) {
    let binary = "";
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + step, bytes.length)));
    }
    return btoa(binary);
  }

  async function tryInterceptDownloadAnchor(anchor) {
    if (!anchor || !IS_ANDROID_BRIDGE) return false;
    const rawHref = anchor.getAttribute("href") || anchor.href || "";
    const hasDownload = anchor.hasAttribute("download");
    const resolved = resolveStudioUrl(rawHref);
    if (!hasDownload && !resolved.startsWith("blob:") && !resolved.startsWith("data:") && !rawHref.includes("/api/download")) {
      return false;
    }

    const dlName =
      anchor.getAttribute("download") ||
      (blobMetaMap.get(resolved) && blobMetaMap.get(resolved).filename) ||
      (rawHref.split("/").pop().split("?")[0] || "framestudio_export");

    try {
      let blob = null;
      let mime = "";
      if (blobMetaMap.has(resolved)) {
        const meta = blobMetaMap.get(resolved);
        blob = meta.blob;
        mime = meta.mimeType;
      } else if (resolved.startsWith("blob:") || resolved.startsWith("data:")) {
        const r = await ORIGINAL_FETCH(resolved);
        blob = await r.blob();
        mime = blob.type;
      }
      if (blob) {
        await saveBlobToAndroidNative(blob, dlName, mime);
        return true;
      }
    } catch (err) {
      console.error("[MobileEngine] Native download bridge failed:", err);
    }
    return false;
  }

  // Intercept both user clicks and JS programmatic anchor.click() calls inside Android APK
  if (IS_ANDROID_BRIDGE) {
    document.addEventListener(
      "click",
      (event) => {
        const anchor = event.target && event.target.closest ? event.target.closest("a") : null;
        if (!anchor) return;
        const href = anchor.getAttribute("href") || "";
        if (anchor.hasAttribute("download") || href.startsWith("blob:") || href.startsWith("data:") || href.includes("/api/download")) {
          event.preventDefault();
          event.stopPropagation();
          tryInterceptDownloadAnchor(anchor);
        }
      },
      true
    );

    const origAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      const href = this.getAttribute("href") || this.href || "";
      if (this.hasAttribute("download") || href.startsWith("blob:") || href.startsWith("data:") || href.includes("/api/download")) {
        tryInterceptDownloadAnchor(this);
        return;
      }
      return origAnchorClick.apply(this, arguments);
    };
  }

  const ORIGINAL_FETCH = global.fetch ? global.fetch.bind(global) : null;
  const ORIGINAL_XHR = global.XMLHttpRequest;

  if (!OFFLINE_MODE) {
    return;
  }

  // Load bundled TrueType fonts once so offline Canvas matches backend Pillow typography
  const BUNDLED_FONT_FILES = [
    { family: "Arial", weight: "normal", url: "/assets/fonts/arial.ttf" },
    { family: "Arial", weight: "bold", url: "/assets/fonts/arialbd.ttf" },
    { family: "Verdana", weight: "normal", url: "/assets/fonts/verdana.ttf" },
    { family: "Verdana", weight: "bold", url: "/assets/fonts/verdanab.ttf" },
    { family: "Georgia", weight: "normal", url: "/assets/fonts/georgia.ttf" },
    { family: "Georgia", weight: "bold", url: "/assets/fonts/georgiab.ttf" },
    { family: "Courier New", weight: "normal", url: "/assets/fonts/cour.ttf" },
    { family: "Impact", weight: "normal", url: "/assets/fonts/impact.ttf" },
  ];

  let fontsLoadedPromise = null;
  function ensureFontsLoaded() {
    if (fontsLoadedPromise) return fontsLoadedPromise;
    if (typeof FontFace === "undefined" || !document.fonts) {
      fontsLoadedPromise = Promise.resolve();
      return fontsLoadedPromise;
    }
    fontsLoadedPromise = Promise.all(
      BUNDLED_FONT_FILES.map(async (spec) => {
        try {
          const face = new FontFace(spec.family, `url(${spec.url})`, { weight: spec.weight });
          const loaded = await face.load();
          document.fonts.add(loaded);
        } catch (_) {}
      })
    );
    return fontsLoadedPromise;
  }

  // Font stack matching engine/font_manager.py
  const CANVAS_FONT_MAP = {
    Arial: 'Arial, "Helvetica Neue", Helvetica, sans-serif',
    Helvetica: '"Helvetica Neue", Arial, Helvetica, sans-serif',
    Verdana: "Verdana, Geneva, sans-serif",
    Georgia: 'Georgia, "Times New Roman", serif',
    "Times New Roman": 'Georgia, "Times New Roman", serif',
    "Courier New": '"Courier New", Courier, monospace',
    Impact: 'Impact, "Arial Black", sans-serif',
    "Trebuchet MS": '"Trebuchet MS", Verdana, sans-serif',
  };

  function cssFont(family, sizePx, bold) {
    const stack = CANVAS_FONT_MAP[family] || CANVAS_FONT_MAP.Arial;
    return `${bold ? "bold " : ""}${Math.max(8, Math.round(sizePx))}px ${stack}`;
  }

  function hexToRgba(hex, alpha) {
    const a = typeof alpha === "number" ? Math.max(0, Math.min(1, alpha)) : 1;
    let clean = String(hex || "#ffffff").trim().replace("#", "");
    if (clean.length === 3) {
      clean = clean
        .split("")
        .map((c) => c + c)
        .join("");
    }
    if (clean.length !== 6) return `rgba(255,255,255,${a})`;
    const r = parseInt(clean.slice(0, 2), 16) || 0;
    const g = parseInt(clean.slice(2, 4), 16) || 0;
    const b = parseInt(clean.slice(4, 6), 16) || 0;
    return `rgba(${r},${g},${b},${a})`;
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error("Canvas encoding returned empty blob"));
        },
        mime || "image/png",
        quality
      );
    });
  }

  function loadImageFromBlobOrUrl(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = (err) => reject(new Error(`Image load failed: ${src}`));
      img.src = src;
    });
  }

  function loadVideoMetadata(objectUrl) {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      const cleanup = () => {
        video.onloadedmetadata = null;
        video.onerror = null;
      };
      video.onloadedmetadata = () => {
        cleanup();
        resolve({
          width: video.videoWidth || 1280,
          height: video.videoHeight || 720,
          duration: Number.isFinite(video.duration) ? Math.round(video.duration * 100) / 100 : 0,
        });
      };
      video.onerror = () => {
        cleanup();
        reject(new Error("Unsupported or unreadable video file in offline browser"));
      };
      video.src = objectUrl;
    });
  }

  function seekAndGrabVideoFrame(objectUrl, timestampSec, maxDim) {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.preload = "auto";
      video.muted = true;
      video.playsInline = true;

      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          video.src = "";
          reject(new Error("Video seek timed out"));
        }
      }, 15000);

      video.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("Failed to decode video frame"));
      };

      video.onloadeddata = () => {
        const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
        const targetTime = dur > 0 ? Math.max(0, Math.min(dur - 0.02, timestampSec || 0)) : 0;
        try {
          video.currentTime = targetTime;
        } catch (_) {
          video.currentTime = 0;
        }
      };

      video.onseeked = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const vw = video.videoWidth || 1280;
        const vh = video.videoHeight || 720;
        let tw = vw;
        let th = vh;
        if (maxDim && Math.max(vw, vh) > maxDim) {
          const ratio = maxDim / Math.max(vw, vh);
          tw = Math.max(2, Math.round(vw * ratio));
          th = Math.max(2, Math.round(vh * ratio));
        }
        const canvas = document.createElement("canvas");
        canvas.width = tw;
        canvas.height = th;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(video, 0, 0, tw, th);
        video.pause();
        video.removeAttribute("src");
        video.load();
        resolve({ canvas, width: tw, height: th, origWidth: vw, origHeight: vh });
      };

      video.src = objectUrl;
    });
  }

  function classifyFile(file) {
    const name = (file.name || "").toLowerCase();
    const type = (file.type || "").toLowerCase();
    const ext = name.includes(".") ? name.split(".").pop() : "";
    if (
      type.startsWith("image/") ||
      ["jpg", "jpeg", "png", "webp", "bmp", "gif", "avif"].includes(ext)
    ) {
      return { mediaType: "image", formatName: ext.toUpperCase() || "IMAGE" };
    }
    if (
      type.startsWith("video/") ||
      ["mp4", "mov", "webm", "mkv", "m4v", "avi", "3gp"].includes(ext)
    ) {
      return { mediaType: "video", formatName: ext.toUpperCase() || "VIDEO" };
    }
    return { mediaType: "document", formatName: (ext || "FILE").toUpperCase() };
  }

  function makeDocumentThumbDataUrl(label) {
    const c = document.createElement("canvas");
    c.width = 240;
    c.height = 180;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#161b26";
    ctx.fillRect(0, 0, 240, 180);
    ctx.strokeStyle = "#2d3748";
    ctx.lineWidth = 3;
    ctx.strokeRect(12, 12, 216, 156);
    ctx.fillStyle = "#06b6d4";
    ctx.font = "bold 28px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(label || "FILE").slice(0, 6), 120, 90);
    return c.toDataURL("image/png");
  }

  async function ingestUploadedFile(file) {
    const id = nextId("m");
    const safeOrig = (file.name || `upload_${id}`).replace(/[^\w.\-() ]+/g, "_");
    const savedFilename = `${id}_${safeOrig}`;
    const objectUrl = registerBlobUrl(`/api/uploads/${savedFilename}`, file, file.name, file.type);
    const { mediaType, formatName } = classifyFile(file);

    let width = 0;
    let height = 0;
    let duration = 0;
    let thumbUrl = "";

    if (mediaType === "image") {
      const img = await loadImageFromBlobOrUrl(objectUrl);
      width = img.naturalWidth || img.width || 1280;
      height = img.naturalHeight || img.height || 720;

      const tMax = 360;
      const ratio = Math.min(1, tMax / Math.max(width, height));
      const tw = Math.max(1, Math.round(width * ratio));
      const th = Math.max(1, Math.round(height * ratio));
      const tc = document.createElement("canvas");
      tc.width = tw;
      tc.height = th;
      tc.getContext("2d").drawImage(img, 0, 0, tw, th);
      const thumbBlob = await canvasToBlob(tc, "image/jpeg", 0.8);
      thumbUrl = registerBlobUrl(`/api/thumbnails/thumb_${savedFilename}.jpg`, thumbBlob, `thumb_${savedFilename}.jpg`, "image/jpeg");
    } else if (mediaType === "video") {
      try {
        const meta = await loadVideoMetadata(objectUrl);
        width = meta.width;
        height = meta.height;
        duration = meta.duration;
        const grabbed = await seekAndGrabVideoFrame(objectUrl, Math.min(0.25, duration * 0.1), 400);
        const thumbBlob = await canvasToBlob(grabbed.canvas, "image/jpeg", 0.82);
        thumbUrl = registerBlobUrl(`/api/thumbnails/thumb_${savedFilename}.jpg`, thumbBlob, `thumb_${savedFilename}.jpg`, "image/jpeg");
      } catch (err) {
        console.warn("[MobileEngine] Video metadata fallback:", err);
        width = 1280;
        height = 720;
        duration = 0;
        thumbUrl = makeDocumentThumbDataUrl(formatName);
      }
    } else {
      thumbUrl = makeDocumentThumbDataUrl(formatName);
    }

    const record = {
      id,
      filename: file.name || savedFilename,
      saved_filename: savedFilename,
      media_type: mediaType,
      format_name: formatName,
      thumb_url: thumbUrl,
      width,
      height,
      duration,
      size_bytes: file.size || 0,
      _file: file,
      _objectUrl: objectUrl,
    };

    mediaRegistry.set(id, record);
    savedFilenameToId.set(savedFilename, id);
    tempFrameRegistry.set(savedFilename, {
      url: objectUrl,
      width,
      height,
      blob: file,
    });

    const publicRecord = { ...record };
    delete publicRecord._file;
    delete publicRecord._objectUrl;
    return publicRecord;
  }

  function getMediaRecord(fileId) {
    if (!fileId) return null;
    if (mediaRegistry.has(fileId)) return mediaRegistry.get(fileId);
    if (savedFilenameToId.has(fileId)) return mediaRegistry.get(savedFilenameToId.get(fileId));
    return null;
  }

  async function renderMediaBaseCanvas(mediaOrFilename, maxDim, timestampSec) {
    if (tempFrameRegistry.has(mediaOrFilename)) {
      const f = tempFrameRegistry.get(mediaOrFilename);
      const img = await loadImageFromBlobOrUrl(f.url);
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      const scale = maxDim && Math.max(w, h) > maxDim ? maxDim / Math.max(w, h) : 1;
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;
      canvas.getContext("2d").drawImage(img, 0, 0, cw, ch);
      return { canvas, width: cw, height: ch, origWidth: w, origHeight: h };
    }

    const media = typeof mediaOrFilename === "string" ? getMediaRecord(mediaOrFilename) : mediaOrFilename;
    if (!media) throw new Error("Media file not found in offline session");

    if (media.media_type === "video") {
      return await seekAndGrabVideoFrame(media._objectUrl, timestampSec || 0, maxDim);
    }

    const img = await loadImageFromBlobOrUrl(media._objectUrl);
    const w = img.naturalWidth || img.width || media.width || 1280;
    const h = img.naturalHeight || img.height || media.height || 720;
    const scale = maxDim && Math.max(w, h) > maxDim ? maxDim / Math.max(w, h) : 1;
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    canvas.getContext("2d").drawImage(img, 0, 0, cw, ch);
    return { canvas, width: cw, height: ch, origWidth: w, origHeight: h };
  }

  // =========================================================================
  // 1. WATERMARK RENDERING ENGINE (Parity with engine/image_processor.py)
  // =========================================================================

  function computeSinglePosition(baseW, baseH, patchW, patchH, position, customX, customY, marginX, marginY) {
    if (position === "custom") {
      return [Math.round(customX * baseW - patchW / 2), Math.round(customY * baseH - patchH / 2)];
    }
    let x = marginX;
    let y = marginY;
    if (position.includes("center") || position === "center") {
      if (position === "top-center" || position === "center" || position === "bottom-center") {
        x = Math.round((baseW - patchW) / 2);
      }
    }
    if (position.includes("right")) {
      x = Math.round(baseW - patchW - marginX);
    }
    if (position.startsWith("middle-") || position === "center") {
      y = Math.round((baseH - patchH) / 2);
    } else if (position.startsWith("bottom-")) {
      y = Math.round(baseH - patchH - marginY);
    }
    return [x, y];
  }

  function renderTextPatchCanvas(layer, scaleFactor) {
    const text = (layer.text || "").trim();
    if (!text) return null;

    const scaledFontSize = Math.max(8, Math.round((layer.font_size || 36) * scaleFactor));
    const fontStr = cssFont(layer.font_family || "Arial", scaledFontSize, !!layer.font_bold);
    const measureCanvas = document.createElement("canvas");
    const mCtx = measureCanvas.getContext("2d");
    mCtx.font = fontStr;

    const lines = text.split("\n");
    const lineHeight = Math.round(scaledFontSize * 1.24);
    let maxW = 10;
    lines.forEach((line) => {
      const m = mCtx.measureText(line);
      if (m.width > maxW) maxW = m.width;
    });

    const strokeW = layer.stroke_enabled ? Math.max(0, Math.round((layer.stroke_width || 2) * scaleFactor * 2)) : 0;
    const shadowOffset = layer.shadow_enabled ? Math.max(1, Math.round((layer.shadow_offset || 2) * scaleFactor)) : 0;
    const bgPad = layer.bg_enabled ? Math.max(2, Math.round((layer.bg_padding || 8) * scaleFactor)) : 0;
    const pad = bgPad + shadowOffset + Math.ceil(strokeW / 2) + 8;

    const innerW = Math.ceil(maxW);
    const innerH = Math.ceil(lines.length * lineHeight);
    const patchW = innerW + pad * 2;
    const patchH = innerH + pad * 2;

    const patch = document.createElement("canvas");
    patch.width = Math.max(4, patchW);
    patch.height = Math.max(4, patchH);
    const ctx = patch.getContext("2d");

    if (layer.bg_enabled) {
      const rx = pad - bgPad;
      const ry = pad - bgPad;
      const rw = innerW + bgPad * 2;
      const rh = innerH + bgPad * 2;
      const rad = Math.min(Math.round((layer.bg_radius || 6) * scaleFactor), rw / 2, rh / 2);
      ctx.fillStyle = hexToRgba(layer.bg_color || "#000000", layer.bg_opacity ?? 0.5);
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") {
        ctx.roundRect(rx, ry, rw, rh, rad);
      } else {
        ctx.rect(rx, ry, rw, rh);
      }
      ctx.fill();
    }

    ctx.font = fontStr;
    ctx.textBaseline = "top";
    const alpha = Math.max(0, Math.min(1, layer.opacity ?? 0.8));

    lines.forEach((line, idx) => {
      const ly = pad + idx * lineHeight;
      if (layer.shadow_enabled) {
        ctx.fillStyle = hexToRgba(layer.shadow_color || "#000000", alpha * 0.75);
        ctx.fillText(line, pad + shadowOffset, ly + shadowOffset);
      }
      if (strokeW > 0) {
        ctx.lineWidth = strokeW;
        ctx.lineJoin = "round";
        ctx.strokeStyle = hexToRgba(layer.stroke_color || "#000000", alpha);
        ctx.strokeText(line, pad, ly);
      }
      ctx.fillStyle = hexToRgba(layer.color || "#ffffff", alpha);
      ctx.fillText(line, pad, ly);
    });

    if (Math.abs(layer.rotation || 0) > 0.05) {
      return rotateCanvas(patch, -(layer.rotation || 0));
    }
    return patch;
  }

  function rotateCanvas(srcCanvas, deg) {
    const rad = (deg * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const nw = Math.ceil(srcCanvas.width * cos + srcCanvas.height * sin);
    const nh = Math.ceil(srcCanvas.width * sin + srcCanvas.height * cos);
    const out = document.createElement("canvas");
    out.width = Math.max(2, nw);
    out.height = Math.max(2, nh);
    const ctx = out.getContext("2d");
    ctx.translate(nw / 2, nh / 2);
    ctx.rotate(rad);
    ctx.drawImage(srcCanvas, -srcCanvas.width / 2, -srcCanvas.height / 2);
    return out;
  }

  async function renderWatermarkLayers(ctx, baseW, baseH, layers) {
    await ensureFontsLoaded();
    const scaleFactor = Math.max(baseW, baseH) / 1920.0;

    for (const layer of layers || []) {
      if (!layer || layer.enabled === false) continue;

      let patch = null;
      if (layer.layer_type === "image") {
        if (!layer.image_filename || !logoRegistry.has(layer.image_filename)) continue;
        const logoRec = logoRegistry.get(layer.image_filename);
        const logoImg = await loadImageFromBlobOrUrl(logoRec.url);
        const targetW = Math.max(12, Math.round(baseW * ((layer.scale_percent || 15) / 100)));
        const aspect = (logoImg.naturalHeight || 1) / Math.max(1, logoImg.naturalWidth || 1);
        const targetH = Math.max(12, Math.round(targetW * aspect));
        const imgCanvas = document.createElement("canvas");
        imgCanvas.width = targetW;
        imgCanvas.height = targetH;
        const iCtx = imgCanvas.getContext("2d");
        iCtx.globalAlpha = Math.max(0, Math.min(1, layer.opacity ?? 0.8));
        iCtx.drawImage(logoImg, 0, 0, targetW, targetH);
        patch = Math.abs(layer.rotation || 0) > 0.05 ? rotateCanvas(imgCanvas, -(layer.rotation || 0)) : imgCanvas;
      } else {
        patch = renderTextPatchCanvas(layer, scaleFactor);
      }

      if (!patch) continue;
      const pw = patch.width;
      const ph = patch.height;

      if (layer.layout_mode === "tiled") {
        const spX = Math.max(10, Math.round((layer.tile_spacing_x || 160) * scaleFactor));
        const spY = Math.max(10, Math.round((layer.tile_spacing_y || 120) * scaleFactor));
        const stepX = pw + spX;
        const stepY = ph + spY;
        const stagger = layer.tile_stagger !== false;
        let row = 0;
        for (let y = -ph; y < baseH + ph; y += stepY) {
          const offsetX = stagger && row % 2 === 1 ? Math.round(stepX / 2) : 0;
          for (let x = -pw - offsetX; x < baseW + pw; x += stepX) {
            ctx.drawImage(patch, x, y);
          }
          row += 1;
        }
      } else {
        const marginX = Math.round((layer.margin_x ?? 24) * scaleFactor);
        const marginY = Math.round((layer.margin_y ?? 24) * scaleFactor);
        const [px, py] = computeSinglePosition(
          baseW,
          baseH,
          pw,
          ph,
          layer.position || "bottom-right",
          layer.custom_x ?? 0.5,
          layer.custom_y ?? 0.5,
          marginX,
          marginY
        );
        ctx.drawImage(patch, px, py);
      }
    }
  }

  // =========================================================================
  // 2. DOCUMENT & VIDEO COMPRESSION + ZIP PACKAGING
  // =========================================================================

  async function compressDocumentBlob(file, ext) {
    const lower = (ext || "").toLowerCase();
    const origName = file.name || "document.bin";

    // Optimize embedded images inside OOXML/EPUB/ZIP archives via JSZip
    if (["docx", "pptx", "xlsx", "odt", "odp", "ods", "epub", "zip"].includes(lower) && global.JSZip) {
      try {
        const zip = await global.JSZip.loadAsync(await file.arrayBuffer());
        const outZip = new global.JSZip();
        const entries = Object.keys(zip.files);
        for (const entryPath of entries) {
          const entry = zip.files[entryPath];
          if (entry.dir) {
            outZip.folder(entryPath);
            continue;
          }
          const lowerEntry = entryPath.toLowerCase();
          if (/\.(jpe?g|png|webp)$/.test(lowerEntry)) {
            try {
              const rawBlob = await entry.async("blob");
              if (rawBlob.size > 40 * 1024) {
                const tmpUrl = URL.createObjectURL(rawBlob);
                try {
                  const img = await loadImageFromBlobOrUrl(tmpUrl);
                  const c = document.createElement("canvas");
                  c.width = img.naturalWidth;
                  c.height = img.naturalHeight;
                  c.getContext("2d").drawImage(img, 0, 0);
                  const mime = lowerEntry.endsWith(".png") ? "image/png" : "image/jpeg";
                  const recompressed = await canvasToBlob(c, mime, 0.78);
                  if (recompressed.size < rawBlob.size) {
                    outZip.file(entryPath, recompressed);
                    continue;
                  }
                } finally {
                  URL.revokeObjectURL(tmpUrl);
                }
              }
            } catch (_) {}
          }
          outZip.file(entryPath, await entry.async("uint8array"));
        }
        const outBlob = await outZip.generateAsync({
          type: "blob",
          compression: "DEFLATE",
          compressionOptions: { level: 9 },
        });
        return { blob: outBlob, filename: `compressed_${origName}` };
      } catch (err) {
        console.warn("[MobileEngine] ZIP optimization fell back to gzip:", err);
      }
    }

    // Standard document gzip via browser CompressionStream (Chromium / Android WebView)
    if (typeof CompressionStream !== "undefined") {
      const stream = file.stream().pipeThrough(new CompressionStream("gzip"));
      const compressedBlob = await new Response(stream).blob();
      return { blob: compressedBlob, filename: `${origName}.gz`, mimeType: "application/gzip" };
    }

    if (global.JSZip) {
      const zip = new global.JSZip();
      zip.file(origName, file);
      const outBlob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 9 },
      });
      return { blob: outBlob, filename: `${origName}.zip`, mimeType: "application/zip" };
    }

    throw new Error("Offline compression stream unavailable for this document format");
  }

  function pickMediaRecorderMime() {
    if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
      return null;
    }
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
      "video/mp4",
    ];
    for (const mime of candidates) {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    }
    return null;
  }

  async function processVideoWithCanvas(media, options) {
    const { layers, videoPreset, videoResolution, drawFrameCallback, onProgress, isCancelled } = options;
    const mimeType = pickMediaRecorderMime();
    if (!mimeType) {
      throw new Error("This device browser does not support offline MediaRecorder video encoding");
    }

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = media._objectUrl;

    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error("Could not decode video stream offline"));
    });

    const origW = video.videoWidth || media.width || 1280;
    const origH = video.videoHeight || media.height || 720;
    let maxHeightLimit = origH;
    if (videoResolution === "1080p") maxHeightLimit = 1080;
    else if (videoResolution === "720p") maxHeightLimit = 720;
    else if (videoResolution === "480p") maxHeightLimit = 480;

    let outW = origW;
    let outH = origH;
    if (origH > maxHeightLimit && maxHeightLimit > 0) {
      const ratio = maxHeightLimit / origH;
      outW = Math.max(2, Math.round((origW * ratio) / 2) * 2);
      outH = Math.max(2, Math.round((origH * ratio) / 2) * 2);
    } else {
      outW = Math.max(2, outW - (outW % 2));
      outH = Math.max(2, outH - (outH % 2));
    }

    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");

    // Pre-render static watermark overlay once so per-frame composite is ultra fast
    let overlayCanvas = null;
    if (layers && layers.length > 0) {
      overlayCanvas = document.createElement("canvas");
      overlayCanvas.width = outW;
      overlayCanvas.height = outH;
      await renderWatermarkLayers(overlayCanvas.getContext("2d"), outW, outH, layers);
    }

    const bpsMap = {
      master: 8_000_000,
      balanced: 4_000_000,
      compressed: 1_800_000,
    };
    const bitsPerSecond = bpsMap[videoPreset] || 4_000_000;

    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitsPerSecond });
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    const donePromise = new Promise((resolve, reject) => {
      recorder.onstop = () => {
        const cleanMime = mimeType.split(";")[0];
        resolve(new Blob(chunks, { type: cleanMime }));
      };
      recorder.onerror = (e) => reject(new Error(e.error ? e.error.message : "MediaRecorder failed"));
    });

    recorder.start(250);
    await video.play().catch(() => {});

    const totalDur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;

    await new Promise((resolve) => {
      let stopped = false;
      function tick() {
        if (stopped) return;
        if (isCancelled && isCancelled()) {
          stopped = true;
          video.pause();
          recorder.stop();
          resolve();
          return;
        }
        ctx.drawImage(video, 0, 0, outW, outH);
        if (drawFrameCallback) {
          drawFrameCallback(ctx, outW, outH, video.currentTime);
        }
        if (overlayCanvas) {
          ctx.drawImage(overlayCanvas, 0, 0);
        }
        if (onProgress) {
          onProgress(Math.min(0.99, Math.max(0.02, video.currentTime / totalDur)));
        }
        if (video.ended || video.currentTime >= totalDur - 0.03) {
          stopped = true;
          setTimeout(() => {
            if (recorder.state !== "inactive") recorder.stop();
            resolve();
          }, 80);
          return;
        }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });

    video.removeAttribute("src");
    video.load();
    const outBlob = await donePromise;
    const ext = mimeType.includes("mp4") ? "mp4" : "webm";
    return { blob: outBlob, ext, mimeType: outBlob.type };
  }

  // =========================================================================
  // 3. WATERMARK + COMPRESSOR JOB ENGINE (/api/process, /api/job/*)
  // =========================================================================

  async function encodeCanvasToTargetMb(srcCanvas, targetMb, preferWebp) {
    const targetBytes = Math.max(8 * 1024, Math.round(targetMb * 1024 * 1024));
    const mime = preferWebp ? "image/webp" : "image/jpeg";
    const ext = preferWebp ? "webp" : "jpg";
    let working = srcCanvas;
    for (let down = 0; down < 4; down += 1) {
      let lo = 12;
      let hi = 92;
      let bestBlob = null;
      for (let step = 0; step < 6; step += 1) {
        const mid = Math.round((lo + hi) / 2);
        const blob = await canvasToBlob(working, mime, mid / 100);
        if (blob.size <= targetBytes) {
          bestBlob = blob;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (bestBlob) return { blob: bestBlob, mime, ext };
      const scaled = document.createElement("canvas");
      scaled.width = Math.max(16, Math.round(working.width * 0.8));
      scaled.height = Math.max(16, Math.round(working.height * 0.8));
      scaled.getContext("2d").drawImage(working, 0, 0, scaled.width, scaled.height);
      working = scaled;
    }
    const fallback = await canvasToBlob(working, mime, 0.15);
    return { blob: fallback, mime, ext };
  }

  async function runOfflineBatchJob(jobId, fileIds, config) {
    const job = jobRegistry.get(jobId);
    const layers = (config && config.layers) || [];
    const exportSettings = (config && config.export_settings) || {};
    const compressOnly = exportSettings.mode === "compress_only" || layers.length === 0;
    const imgQuality = Math.max(0.4, Math.min(0.96, (exportSettings.image_quality || 85) / 100));
    const targetMb = Number(exportSettings.target_size_mb) > 0 ? Number(exportSettings.target_size_mb) : null;

    for (let i = 0; i < job.items.length; i += 1) {
      if (job.status === "cancelled") break;
      const item = job.items[i];
      const media = getMediaRecord(item.file_id);
      if (!media) {
        item.status = "failed";
        item.error = "Media missing from session";
        continue;
      }

      try {
        if (media.media_type === "image") {
          const { canvas, width, height } = await renderMediaBaseCanvas(media, null, 0);
          const ctx = canvas.getContext("2d");
          if (!compressOnly && layers.length > 0) {
            await renderWatermarkLayers(ctx, width, height, layers);
          }

          const origLower = (media.filename || "").toLowerCase();
          const baseStem = media.filename.replace(/\.[^.]+$/, "") || media.id;
          let outMime = "image/jpeg";
          let outExt = "jpg";
          let outBlob;
          if (targetMb) {
            const fitted = await encodeCanvasToTargetMb(canvas, targetMb, origLower.endsWith(".webp"));
            outBlob = fitted.blob;
            outMime = fitted.mime;
            outExt = fitted.ext;
          } else {
            outBlob = await canvasToBlob(canvas, "image/jpeg", imgQuality);
            if (origLower.endsWith(".png") && !compressOnly && imgQuality >= 0.9) {
              outMime = "image/png";
              outExt = "png";
              outBlob = await canvasToBlob(canvas, "image/png");
            } else if (compressOnly && imgQuality < 0.9 && outBlob.size >= media.size_bytes * 0.98) {
              const webpBlob = await canvasToBlob(canvas, "image/webp", Math.max(0.5, imgQuality - 0.1));
              if (webpBlob && webpBlob.size < outBlob.size) {
                outBlob = webpBlob;
                outMime = "image/webp";
                outExt = "webp";
              }
            }
          }

          const outFilename = `${compressOnly ? "compressed" : "wm"}_${baseStem}.${outExt}`;
          item.output_filename = outFilename;
          item.output_size_bytes = outBlob.size;
          item.download_url = registerBlobUrl(`/api/download/${outFilename}`, outBlob, outFilename, outMime);
          item.status = "completed";
          item.progress = 1;
          item._blob = outBlob;
        } else if (media.media_type === "video") {
          const baseStem = media.filename.replace(/\.[^.]+$/, "") || media.id;
          const res = await processVideoWithCanvas(media, {
            layers: compressOnly ? [] : layers,
            videoPreset: exportSettings.video_preset || "balanced",
            videoResolution: exportSettings.video_resolution || "original",
            isCancelled: () => job.status === "cancelled",
            onProgress: (p) => {
              item.progress = p;
              job.progress = (i + p) / Math.max(1, job.items.length);
            },
          });
          const outFilename = `${compressOnly ? "compressed" : "wm"}_${baseStem}.${res.ext}`;
          item.output_filename = outFilename;
          item.output_size_bytes = res.blob.size;
          item.download_url = registerBlobUrl(`/api/download/${outFilename}`, res.blob, outFilename, res.mimeType);
          item.status = "completed";
          item.progress = 1;
          item._blob = res.blob;
        } else {
          const ext = (media.filename.split(".").pop() || "bin").toLowerCase();
          const docRes = await compressDocumentBlob(media._file, ext);
          item.output_filename = docRes.filename;
          item.output_size_bytes = docRes.blob.size;
          item.download_url = registerBlobUrl(
            `/api/download/${docRes.filename}`,
            docRes.blob,
            docRes.filename,
            docRes.mimeType || "application/octet-stream"
          );
          item.status = "completed";
          item.progress = 1;
          item._blob = docRes.blob;
        }
      } catch (err) {
        console.error("[MobileEngine] Batch item failed:", err);
        item.status = "failed";
        item.error = err.message || "Offline processing failed";
      }

      job.progress = (i + 1) / Math.max(1, job.items.length);
    }

    if (job.status !== "cancelled") {
      // Build ZIP bundle proactively for /api/download-zip/{job_id}
      if (global.JSZip) {
        const zip = new global.JSZip();
        job.items.forEach((it) => {
          if (it.status === "completed" && it._blob) {
            zip.file(it.output_filename || it.filename, it._blob);
          }
        });
        const zipBlob = await zip.generateAsync({ type: "blob" });
        registerBlobUrl(`/api/download-zip/${jobId}`, zipBlob, `FrameStudio_${jobId}.zip`, "application/zip");
      }
      job.progress = 1.0;
      job.status = "completed";
    }
  }

  // =========================================================================
  // 4. THUMBNAIL STUDIO OFFLINE ENGINE
  // =========================================================================

  const ASPECT_RATIOS = {
    "16:9": [1920, 1080],
    "9:16": [1080, 1920],
    "1:1": [1080, 1080],
    "4:5": [1080, 1350],
    "3:4": [1080, 1440],
    "4:3": [1440, 1080],
  };

  function fitCanvasToAspect(srcCanvas, tw, th, fitMode) {
    const out = document.createElement("canvas");
    out.width = tw;
    out.height = th;
    const ctx = out.getContext("2d");

    const sw = srcCanvas.width;
    const sh = srcCanvas.height;

    if (fitMode === "fit_black") {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, tw, th);
      const s = Math.min(tw / sw, th / sh);
      const dw = Math.round(sw * s);
      const dh = Math.round(sh * s);
      ctx.drawImage(srcCanvas, Math.round((tw - dw) / 2), Math.round((th - dh) / 2), dw, dh);
    } else if (fitMode === "fit_blur") {
      const coverScale = Math.max(tw / sw, th / sh);
      const bw = Math.round(sw * coverScale);
      const bh = Math.round(sh * coverScale);
      ctx.save();
      ctx.filter = "blur(26px) brightness(0.65)";
      ctx.drawImage(srcCanvas, Math.round((tw - bw) / 2), Math.round((th - bh) / 2), bw, bh);
      ctx.restore();

      const containScale = Math.min(tw / sw, th / sh);
      const dw = Math.round(sw * containScale);
      const dh = Math.round(sh * containScale);
      ctx.drawImage(srcCanvas, Math.round((tw - dw) / 2), Math.round((th - dh) / 2), dw, dh);
    } else {
      // crop (cover)
      const s = Math.max(tw / sw, th / sh);
      const dw = Math.round(sw * s);
      const dh = Math.round(sh * s);
      ctx.drawImage(srcCanvas, Math.round((tw - dw) / 2), Math.round((th - dh) / 2), dw, dh);
    }
    return out;
  }

  async function renderThumbnailComposition(baseFilename, design, maxPreviewWidth) {
    await ensureFontsLoaded();
    const [baseW, baseH] = ASPECT_RATIOS[design.aspect_ratio || "16:9"] || [1280, 720];
    const resScale = Number(design.resolution_scale) || 1.0;
    let tw = Math.round(baseW * resScale);
    let th = Math.round(baseH * resScale);

    if (maxPreviewWidth && tw > maxPreviewWidth) {
      const ratio = maxPreviewWidth / tw;
      tw = maxPreviewWidth;
      th = Math.max(2, Math.round(th * ratio));
    }

    const src = await renderMediaBaseCanvas(baseFilename, Math.max(tw, th) * 1.2, 0);
    const canvas = fitCanvasToAspect(src.canvas, tw, th, design.fit_mode || "crop");
    const ctx = canvas.getContext("2d");

    const adj = design.adjustments || {};
    const sat = typeof adj.saturation === "number" ? adj.saturation : 1.0;
    const con = typeof adj.contrast === "number" ? adj.contrast : 1.0;
    if (Math.abs(sat - 1) > 0.01 || Math.abs(con - 1) > 0.01) {
      const filtered = document.createElement("canvas");
      filtered.width = tw;
      filtered.height = th;
      const fCtx = filtered.getContext("2d");
      fCtx.filter = `saturate(${Math.round(sat * 100)}%) contrast(${Math.round(con * 100)}%)`;
      fCtx.drawImage(canvas, 0, 0);
      ctx.clearRect(0, 0, tw, th);
      ctx.drawImage(filtered, 0, 0);
    }

    const vignette = typeof adj.vignette === "number" ? adj.vignette : 0;
    if (vignette > 0.01) {
      const rad = ctx.createRadialGradient(tw / 2, th / 2, Math.min(tw, th) * 0.25, tw / 2, th / 2, Math.hypot(tw, th) * 0.55);
      rad.addColorStop(0, "rgba(0,0,0,0)");
      rad.addColorStop(1, `rgba(0,0,0,${Math.min(0.85, vignette * 0.85)})`);
      ctx.fillStyle = rad;
      ctx.fillRect(0, 0, tw, th);
    }

    // Stickers / Cutouts
    for (const st of design.stickers || []) {
      if (!st || !st.image_filename || !logoRegistry.has(st.image_filename)) continue;
      const stImg = await loadImageFromBlobOrUrl(logoRegistry.get(st.image_filename).url);
      const sw = Math.max(16, Math.round(tw * ((st.scale_percent || 25) / 100)));
      const sh = Math.round(sw * ((stImg.naturalHeight || 1) / Math.max(1, stImg.naturalWidth || 1)));
      const cx = (st.custom_x ?? 0.78) * tw;
      const cy = (st.custom_y ?? 0.52) * th;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, st.opacity ?? 1));
      ctx.translate(cx, cy);
      ctx.rotate(((st.rotation || 0) * Math.PI) / 180);
      ctx.drawImage(stImg, -sw / 2, -sh / 2, sw, sh);
      ctx.restore();
    }

    // Display Text Items
    const scaleFactor = tw / 1280.0;
    for (const item of design.text_items || []) {
      if (!item || !item.text) continue;
      const fontSize = Math.max(14, Math.round((item.font_size || 84) * scaleFactor));
      const fontStr = cssFont(item.font_family || "Impact", fontSize, item.font_bold !== false);
      ctx.save();
      ctx.font = fontStr;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const cx = (item.custom_x ?? 0.5) * tw;
      const cy = (item.custom_y ?? 0.82) * th;
      ctx.translate(cx, cy);
      ctx.rotate(((item.rotation || 0) * Math.PI) / 180);

      const lines = String(item.text).split("\n");
      const lh = fontSize * 1.18;
      let maxW = 0;
      lines.forEach((l) => {
        maxW = Math.max(maxW, ctx.measureText(l).width);
      });
      const totalH = lines.length * lh;

      if (item.bg_enabled) {
        const padX = Math.round(22 * scaleFactor);
        const padY = Math.round(12 * scaleFactor);
        const rx = -maxW / 2 - padX;
        const ry = -totalH / 2 - padY;
        const rw = maxW + padX * 2;
        const rh = totalH + padY * 2;
        ctx.fillStyle = hexToRgba(item.bg_color || "#000000", item.bg_opacity ?? 0.72);
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") ctx.roundRect(rx, ry, rw, rh, 14 * scaleFactor);
        else ctx.rect(rx, ry, rw, rh);
        ctx.fill();
      }

      const strokeW = Math.max(0, Math.round((item.stroke_width || 0) * scaleFactor * 2));
      lines.forEach((line, idx) => {
        const yOff = (idx - (lines.length - 1) / 2) * lh;
        if (item.shadow_enabled) {
          ctx.save();
          ctx.shadowColor = "rgba(0,0,0,0.85)";
          ctx.shadowBlur = Math.round(14 * scaleFactor);
          ctx.shadowOffsetY = Math.round(5 * scaleFactor);
          ctx.fillStyle = item.color || "#ffffff";
          ctx.fillText(line, 0, yOff);
          ctx.restore();
        }
        if (strokeW > 0) {
          ctx.lineWidth = strokeW;
          ctx.lineJoin = "round";
          ctx.strokeStyle = item.stroke_color || "#000000";
          ctx.strokeText(line, 0, yOff);
        }
        ctx.fillStyle = item.color || "#ffffff";
        ctx.fillText(line, 0, yOff);
      });
      ctx.restore();
    }

    return canvas;
  }

  // =========================================================================
  // 5. PRIVACY / CENSOR OFFLINE ENGINE (YuNet-parity Shape API + Skin CV)
  // =========================================================================

  const emojiBitmapCache = new Map();
  async function loadEmojiAsset(emojiId, customStickerFilename) {
    if (customStickerFilename && logoRegistry.has(customStickerFilename)) {
      return await loadImageFromBlobOrUrl(logoRegistry.get(customStickerFilename).url);
    }
    const cleanId = (emojiId || "sunglasses").replace(/[^a-zA-Z0-9_-]/g, "") || "sunglasses";
    if (emojiBitmapCache.has(cleanId)) {
      return emojiBitmapCache.get(cleanId);
    }
    const img = await loadImageFromBlobOrUrl(`/assets/emojis/${cleanId}.png`).catch(() => null);
    if (img) emojiBitmapCache.set(cleanId, img);
    return img;
  }

  function isSkinYCbCr(r, g, b) {
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    return y > 45 && cb >= 77 && cb <= 135 && cr >= 131 && cr <= 178;
  }

  function findConnectedSkinComponents(imageData, w, h) {
    const data = imageData.data;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i += 1) {
      const p = i * 4;
      if (isSkinYCbCr(data[p], data[p + 1], data[p + 2])) mask[i] = 1;
    }

    const visited = new Uint8Array(w * h);
    const boxes = [];
    const queue = new Int32Array(w * h);

    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const start = y * w + x;
        if (!mask[start] || visited[start]) continue;

        let head = 0;
        let tail = 0;
        queue[tail++] = start;
        visited[start] = 1;

        let minX = x,
          maxX = x,
          minY = y,
          maxY = y,
          area = 0;

        while (head < tail) {
          const cur = queue[head++];
          const cx = cur % w;
          const cy = (cur - cx) / w;
          area += 1;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;

          const neighbors = [
            cx > 0 ? cur - 1 : -1,
            cx + 1 < w ? cur + 1 : -1,
            cy > 0 ? cur - w : -1,
            cy + 1 < h ? cur + w : -1,
          ];
          for (let k = 0; k < 4; k += 1) {
            const nb = neighbors[k];
            if (nb >= 0 && mask[nb] && !visited[nb]) {
              visited[nb] = 1;
              queue[tail++] = nb;
            }
          }
        }

        const bw = maxX - minX + 1;
        const bh = maxY - minY + 1;
        const fillRatio = area / Math.max(1, bw * bh);
        if (bw >= 10 && bh >= 10 && fillRatio > 0.25) {
          boxes.push({ minX, minY, bw, bh, area, fillRatio });
        }
      }
    }

    boxes.sort((a, b) => b.area - a.area);
    return boxes;
  }

  async function detectFacesOffline(media, frameSec) {
    const grabbed = await renderMediaBaseCanvas(media, 640, frameSec || 0);
    const { canvas, width, height, origWidth, origHeight } = grabbed;
    const scaleX = (origWidth || width) / width;
    const scaleY = (origHeight || height) / height;

    // 1) Native Chromium / Android WebView Shape Detection API if present
    if (typeof global.FaceDetector === "function") {
      try {
        const detector = new global.FaceDetector({ fastMode: false, maxDetectedFaces: 12 });
        const detected = await detector.detect(canvas);
        if (Array.isArray(detected) && detected.length > 0) {
          return detected.map((f, idx) => {
            const bb = f.boundingBox;
            const fx = Math.round(bb.x * scaleX);
            const fy = Math.round(bb.y * scaleY);
            const fw = Math.round(bb.width * scaleX);
            const fh = Math.round(bb.height * scaleY);
            const landmarks = [];
            if (Array.isArray(f.landmarks)) {
              const eyeL = f.landmarks.find((l) => l.type === "eye");
              f.landmarks.forEach((l) => {
                if (l.locations && l.locations[0]) {
                  landmarks.push([
                    Math.round(l.locations[0].x * scaleX),
                    Math.round(l.locations[0].y * scaleY),
                  ]);
                }
              });
              if (!eyeL && landmarks.length === 0) {
                landmarks.push([Math.round(fx + fw * 0.34), Math.round(fy + fh * 0.38)]);
                landmarks.push([Math.round(fx + fw * 0.66), Math.round(fy + fh * 0.38)]);
              }
            }
            if (landmarks.length < 2) {
              landmarks.push(
                [Math.round(fx + fw * 0.34), Math.round(fy + fh * 0.38)],
                [Math.round(fx + fw * 0.66), Math.round(fy + fh * 0.38)],
                [Math.round(fx + fw * 0.5), Math.round(fy + fh * 0.55)],
                [Math.round(fx + fw * 0.38), Math.round(fy + fh * 0.72)],
                [Math.round(fx + fw * 0.62), Math.round(fy + fh * 0.72)]
              );
            }
            return {
              x: fx,
              y: fy,
              w: fw,
              h: fh,
              confidence: 0.94,
              track_id: idx + 1,
              label: "Face",
              landmarks,
            };
          });
        }
      } catch (err) {
        console.warn("[MobileEngine] Native FaceDetector skipped:", err);
      }
    }

    // 2) Portable skin + portrait component fallback for universal offline execution
    const dMax = 240;
    const dScale = Math.min(1, dMax / Math.max(width, height));
    const dw = Math.max(32, Math.round(width * dScale));
    const dh = Math.max(32, Math.round(height * dScale));
    const dc = document.createElement("canvas");
    dc.width = dw;
    dc.height = dh;
    const dCtx = dc.getContext("2d");
    dCtx.drawImage(canvas, 0, 0, dw, dh);
    const imgData = dCtx.getImageData(0, 0, dw, dh);
    const comps = findConnectedSkinComponents(imgData, dw, dh);

    const toOrigX = (origWidth || width) / dw;
    const toOrigY = (origHeight || height) / dh;

    const results = [];
    for (const c of comps) {
      const ratio = c.bw / Math.max(1, c.bh);
      const areaFrac = c.area / (dw * dh);
      if (ratio >= 0.45 && ratio <= 1.7 && areaFrac >= 0.008 && areaFrac <= 0.65) {
        const fx = Math.round(c.minX * toOrigX);
        const fy = Math.round(c.minY * toOrigY);
        const fw = Math.round(c.bw * toOrigX);
        const fh = Math.round(c.bh * toOrigY);
        results.push({
          x: fx,
          y: fy,
          w: fw,
          h: fh,
          confidence: Math.min(0.89, 0.58 + c.fillRatio * 0.3),
          track_id: results.length + 1,
          label: "Face",
          landmarks: [
            [Math.round(fx + fw * 0.34), Math.round(fy + fh * 0.38)],
            [Math.round(fx + fw * 0.66), Math.round(fy + fh * 0.38)],
            [Math.round(fx + fw * 0.5), Math.round(fy + fh * 0.55)],
            [Math.round(fx + fw * 0.38), Math.round(fy + fh * 0.72)],
            [Math.round(fx + fw * 0.62), Math.round(fy + fh * 0.72)],
          ],
        });
        if (results.length >= 6) break;
      }
    }
    return results;
  }

  async function detectNsfwOffline(media, frameSec, sensitivity, faceBoxes, allowedClasses) {
    const grabbed = await renderMediaBaseCanvas(media, 260, frameSec || 0);
    const { canvas, width, height, origWidth, origHeight } = grabbed;
    const imgData = canvas.getContext("2d").getImageData(0, 0, width, height);
    const comps = findConnectedSkinComponents(imgData, width, height);
    const minAreaFrac = sensitivity >= 70 ? 0.015 : sensitivity >= 40 ? 0.028 : 0.05;
    const toOrigX = (origWidth || width) / width;
    const toOrigY = (origHeight || height) / height;
    const faces = Array.isArray(faceBoxes) ? faceBoxes : [];

    const overlapsFace = (rx, ry, rw, rh) => {
      for (const fb of faces) {
        const fx = fb.x || 0, fy = fb.y || 0, fw = fb.w || 0, fh = fb.h || 0;
        const ix = Math.max(0, Math.min(rx + rw, fx + fw) - Math.max(rx, fx));
        const iy = Math.max(0, Math.min(ry + rh, fy + fh) - Math.max(ry, fy));
        if ((ix * iy) / Math.max(1, rw * rh) > 0.35) return true;
      }
      return false;
    };

    const candidates = [];
    for (const c of comps) {
      if (c.area / (width * height) < minAreaFrac) continue;
      const rx = Math.round(c.minX * toOrigX);
      const ry = Math.round(c.minY * toOrigY);
      const rw = Math.round(c.bw * toOrigX);
      const rh = Math.round(c.bh * toOrigY);
      if (overlapsFace(rx, ry, rw, rh)) continue;
      candidates.push({
        x: rx,
        y: ry,
        w: rw,
        h: rh,
        confidence: Math.min(0.92, 0.55 + (sensitivity || 50) / 250),
        track_id: candidates.length + 1,
        label: `Body Region #${candidates.length + 1}`,
      });
      if (candidates.length >= 6) break;
    }
    return candidates;
  }

  function faceFitScaleMultiplier(cfg) {
    const fit = (cfg.face_fit || "exact").toLowerCase();
    const fitBase = fit === "exact" ? 0.94 : fit === "loose" ? 1.28 : 1.08;
    const padPct = Number(cfg.padding_percent) || 0;
    const scaleMult = Math.max(0.5, Math.min(2.5, Number(cfg.mask_scale ?? 1.0)));
    return scaleMult * fitBase * Math.max(0.5, 1 + padPct / 100);
  }

  function strokePolylineWithBreaks(ctx, pts, scaleX, scaleY) {
    if (!Array.isArray(pts) || pts.length === 0) return;
    ctx.beginPath();
    let drawing = false;
    let segPoints = 0;
    let lastPt = null;
    for (let i = 0; i < pts.length; i += 1) {
      const pt = pts[i];
      if (!pt || pt[0] < 0 || pt[1] < 0) {
        if (drawing && segPoints === 1 && lastPt) {
          ctx.lineTo(lastPt[0] + 0.1, lastPt[1] + 0.1);
        }
        drawing = false;
        segPoints = 0;
        continue;
      }
      const sx = pt[0] * scaleX;
      const sy = pt[1] * scaleY;
      if (!drawing) {
        ctx.moveTo(sx, sy);
        drawing = true;
        segPoints = 1;
      } else {
        ctx.lineTo(sx, sy);
        segPoints += 1;
      }
      lastPt = [sx, sy];
    }
    if (drawing && segPoints === 1 && lastPt) {
      ctx.lineTo(lastPt[0] + 0.1, lastPt[1] + 0.1);
    }
    ctx.stroke();
  }

  async function applyCensorMasksOnCanvas(ctx, origCanvas, boxes, maskConfig, scaleX, scaleY) {
    const cfg = maskConfig || {};
    const defaultStyle = cfg.mask_type || cfg.style || "blur";
    const region = cfg.mask_region || cfg.region || "face";
    const intensity = Math.max(5, Math.min(100, Number(cfg.intensity ?? 60)));
    const pixelSize = Math.max(4, Math.min(64, Number(cfg.pixel_size ?? Math.round(6 + intensity * 0.35))));
    const shape = cfg.shape || cfg.mask_shape || "oval";
    const combinedScale = faceFitScaleMultiplier(cfg);

    let emojiImg = null;
    if (defaultStyle === "emoji") {
      emojiImg = await loadEmojiAsset(cfg.emoji_name || cfg.emoji_id || "sunglasses", cfg.custom_sticker_filename);
    }

    const standaloneErasers = [];
    for (const rawBox of boxes || []) {
      if (!rawBox) continue;
      if (rawBox.kind === "eraser") {
        standaloneErasers.push(rawBox);
        continue;
      }
      const style = rawBox.mask_type || defaultStyle;
      if (style === "emoji" && !emojiImg) {
        emojiImg = await loadEmojiAsset(cfg.emoji_name || cfg.emoji_id || "sunglasses", cfg.custom_sticker_filename);
      }
      if (rawBox.kind === "brush" && Array.isArray(rawBox.brush_points) && rawBox.brush_points.length > 0) {
        await applyBrushCensor(ctx, origCanvas, rawBox, style, cfg, scaleX, scaleY, intensity, pixelSize);
        continue;
      }

      let bx = (rawBox.x || 0) * scaleX;
      let by = (rawBox.y || 0) * scaleY;
      let bw = (rawBox.w || 0) * scaleX;
      let bh = (rawBox.h || 0) * scaleY;

      const isFaceBox = (Array.isArray(rawBox.landmarks) && rawBox.landmarks.length >= 2) ||
        rawBox.label === "Face" ||
        String(rawBox.label || "").startsWith("Face #");
      if (region === "eyes" && isFaceBox && bw > 0 && bh > 0) {
        if (Array.isArray(rawBox.landmarks) && rawBox.landmarks.length >= 2) {
          const [lx, ly] = [rawBox.landmarks[0][0] * scaleX, rawBox.landmarks[0][1] * scaleY];
          const [rx, ry] = [rawBox.landmarks[1][0] * scaleX, rawBox.landmarks[1][1] * scaleY];
          const midY = (ly + ry) / 2;
          const eyeH = Math.max(bh * 0.24, Math.abs(rx - lx) * 0.45);
          by = midY - eyeH * 0.55;
          bh = eyeH;
        } else {
          by = by + bh * 0.2;
          bh = bh * 0.28;
        }
      }

      // Apply Exact Face Fit + Padding + Scale Multiplier
      const cx = bx + bw / 2;
      const cy = by + bh / 2;
      const effScale = rawBox.kind === "box" ? Math.max(0.5, Number(cfg.mask_scale ?? 1.0)) : combinedScale;
      bw *= effScale;
      bh *= effScale;
      bx = cx - bw / 2;
      by = cy - bh / 2;

      if (bw < 2 || bh < 2) continue;

      if (style === "emoji" && emojiImg) {
        const size = Math.max(bw, bh) * 1.1;
        ctx.save();
        ctx.drawImage(emojiImg, cx - size / 2, cy - size / 2, size, size);
        ctx.restore();
        continue;
      }

      if (style === "redact" || style === "solid" || style === "black") {
        ctx.save();
        traceMaskShapePath(ctx, bx, by, bw, bh, shape === "oval" ? "rect" : shape);
        ctx.fillStyle = cfg.solid_color || "#000000";
        ctx.fill();
        if (cfg.redact_text) {
          const fontSize = Math.max(10, Math.min(28, Math.round(bh * 0.35)));
          ctx.fillStyle = "#ffffff";
          ctx.font = `bold ${fontSize}px monospace`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(cfg.redact_text), cx, cy, Math.max(10, bw - 8));
        }
        ctx.restore();
        continue;
      }

      if (style === "pixelate") {
        const sx = Math.max(0, Math.floor(bx));
        const sy = Math.max(0, Math.floor(by));
        const sw = Math.max(1, Math.min(origCanvas.width - sx, Math.ceil(bw)));
        const sh = Math.max(1, Math.min(origCanvas.height - sy, Math.ceil(bh)));
        const block = Math.max(4, Math.round(pixelSize * scaleX));
        const tinyW = Math.max(1, Math.round(sw / block));
        const tinyH = Math.max(1, Math.round(sh / block));

        const tiny = document.createElement("canvas");
        tiny.width = tinyW;
        tiny.height = tinyH;
        tiny.getContext("2d").drawImage(origCanvas, sx, sy, sw, sh, 0, 0, tinyW, tinyH);

        ctx.save();
        traceMaskShapePath(ctx, bx, by, bw, bh, shape);
        ctx.clip();
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tiny, 0, 0, tinyW, tinyH, sx, sy, sw, sh);
        ctx.restore();
        continue;
      }

      // Default / blur
      const blurPx = Math.max(4, Math.round((intensity * 0.45) * scaleX));
      ctx.save();
      traceMaskShapePath(ctx, bx, by, bw, bh, shape);
      ctx.clip();
      ctx.filter = `blur(${blurPx}px)`;
      ctx.drawImage(origCanvas, 0, 0);
      ctx.restore();
    }

    // Apply standalone eraser strokes to restore original unblurred pixels underneath
    if (standaloneErasers.length > 0) {
      const eraseMask = document.createElement("canvas");
      eraseMask.width = origCanvas.width;
      eraseMask.height = origCanvas.height;
      const eCtx = eraseMask.getContext("2d");
      eCtx.strokeStyle = "#ffffff";
      eCtx.lineCap = "round";
      eCtx.lineJoin = "round";
      for (const eb of standaloneErasers) {
        const radius = Math.max(6, (eb.eraser_radius || eb.brush_radius || 28) * Math.max(scaleX, scaleY));
        eCtx.lineWidth = radius * 2;
        strokePolylineWithBreaks(eCtx, eb.eraser_points || eb.brush_points || [], scaleX, scaleY);
      }
      const restoreLayer = document.createElement("canvas");
      restoreLayer.width = origCanvas.width;
      restoreLayer.height = origCanvas.height;
      const rCtx = restoreLayer.getContext("2d");
      rCtx.drawImage(origCanvas, 0, 0);
      rCtx.globalCompositeOperation = "destination-in";
      rCtx.drawImage(eraseMask, 0, 0);
      ctx.drawImage(restoreLayer, 0, 0);
    }
  }

  function traceMaskShapePath(ctx, x, y, w, h, shape) {
    ctx.beginPath();
    if (shape === "oval" || shape === "ellipse") {
      ctx.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, Math.PI * 2);
    } else if (shape === "circle") {
      const rad = Math.max(1, Math.min(w, h) / 2);
      ctx.arc(x + w / 2, y + h / 2, rad, 0, Math.PI * 2);
    } else if (shape === "triangle") {
      ctx.moveTo(x + w / 2, y);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x, y + h);
      ctx.closePath();
    } else if (shape === "heart") {
      const cx = x + w / 2;
      const topY = y + h * 0.28;
      ctx.moveTo(cx, y + h * 0.96);
      ctx.bezierCurveTo(x - w * 0.05, y + h * 0.62, x, y + h * 0.14, cx - w * 0.25, y + h * 0.12);
      ctx.bezierCurveTo(x + w * 0.10, y + h * 0.02, cx, y + h * 0.18, cx, topY);
      ctx.bezierCurveTo(cx, y + h * 0.18, x + w * 0.90, y + h * 0.02, cx + w * 0.25, y + h * 0.12);
      ctx.bezierCurveTo(x + w, y + h * 0.14, x + w * 1.05, y + h * 0.62, cx, y + h * 0.96);
      ctx.closePath();
    } else if (shape === "rounded" && typeof ctx.roundRect === "function") {
      ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.22);
    } else {
      ctx.rect(x, y, w, h);
    }
  }

  async function applyBrushCensor(ctx, origCanvas, box, style, cfg, scaleX, scaleY, intensity, pixelSize) {
    const pts = box.brush_points || [];
    const radius = Math.max(6, (box.brush_radius || 28) * Math.max(scaleX, scaleY));
    const fillLayer = document.createElement("canvas");
    fillLayer.width = origCanvas.width;
    fillLayer.height = origCanvas.height;
    const fCtx = fillLayer.getContext("2d");

    if (style === "redact" || style === "solid") {
      fCtx.fillStyle = cfg.solid_color || "#000000";
      fCtx.fillRect(0, 0, fillLayer.width, fillLayer.height);
    } else if (style === "pixelate") {
      const tinyW = Math.max(2, Math.round(fillLayer.width / Math.max(4, pixelSize)));
      const tinyH = Math.max(2, Math.round(fillLayer.height / Math.max(4, pixelSize)));
      const tiny = document.createElement("canvas");
      tiny.width = tinyW;
      tiny.height = tinyH;
      tiny.getContext("2d").drawImage(origCanvas, 0, 0, tinyW, tinyH);
      fCtx.imageSmoothingEnabled = false;
      fCtx.drawImage(tiny, 0, 0, tinyW, tinyH, 0, 0, fillLayer.width, fillLayer.height);
    } else {
      fCtx.filter = `blur(${Math.max(4, Math.round(intensity * 0.45 * scaleX))}px)`;
      fCtx.drawImage(origCanvas, 0, 0);
    }

    const strokeMask = document.createElement("canvas");
    strokeMask.width = origCanvas.width;
    strokeMask.height = origCanvas.height;
    const mCtx = strokeMask.getContext("2d");
    mCtx.strokeStyle = "#ffffff";
    mCtx.lineCap = "round";
    mCtx.lineJoin = "round";
    mCtx.lineWidth = radius * 2;
    strokePolylineWithBreaks(mCtx, pts, scaleX, scaleY);

    if (Array.isArray(box.eraser_points) && box.eraser_points.length > 0) {
      mCtx.globalCompositeOperation = "destination-out";
      mCtx.lineWidth = Math.max(6, (box.eraser_radius || box.brush_radius || 28) * Math.max(scaleX, scaleY)) * 2;
      strokePolylineWithBreaks(mCtx, box.eraser_points, scaleX, scaleY);
      mCtx.globalCompositeOperation = "source-over";
    }

    fCtx.globalCompositeOperation = "destination-in";
    fCtx.drawImage(strokeMask, 0, 0);
    ctx.drawImage(fillLayer, 0, 0);
  }

  // =========================================================================
  // 5B. COLOR & LUT + AUDIO OFFLINE ENGINES (Phase E Mobile Parity)
  // =========================================================================

  const BUNDLED_LUTS = [
    { id: "teal_orange", label: "Teal & Orange", description: "Warm highlights with cool teal shadows", filename: "teal_orange.cube" },
    { id: "kodak_2383", label: "Kodak 2383 Film", description: "Classic print-film contrast and warm depth", filename: "kodak_2383.cube" },
    { id: "crisp_daylight", label: "Crisp Daylight", description: "Clean bright tones with subtle vibrance", filename: "crisp_daylight.cube" },
    { id: "moody_noir", label: "Moody Noir", description: "High-contrast cool silver monochrome", filename: "moody_noir.cube" },
    { id: "warm_sunset", label: "Warm Sunset", description: "Golden amber warmth and soft roll-off", filename: "warm_sunset.cube" },
    { id: "matte_fade", label: "Matte Fade", description: "Lifted matte shadows and soft editorial tones", filename: "matte_fade.cube" },
  ];
  const parsedLutCache = new Map();
  const customLutRegistry = new Map();

  function parseCubeText(text) {
    let size = 0;
    const dMin = [0, 0, 0];
    const dMax = [1, 1, 1];
    const entries = [];
    const lines = String(text || "").split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.split("#")[0].trim();
      if (!line) continue;
      const up = line.toUpperCase();
      if (up.startsWith("TITLE")) continue;
      if (up.startsWith("LUT_3D_SIZE")) {
        size = parseInt(line.split(/\s+/)[1], 10) || 0;
        continue;
      }
      if (up.startsWith("DOMAIN_MIN")) {
        const p = line.split(/\s+/).slice(1).map(Number);
        if (p.length === 3) { dMin[0] = p[0]; dMin[1] = p[1]; dMin[2] = p[2]; }
        continue;
      }
      if (up.startsWith("DOMAIN_MAX")) {
        const p = line.split(/\s+/).slice(1).map(Number);
        if (p.length === 3) { dMax[0] = p[0]; dMax[1] = p[1]; dMax[2] = p[2]; }
        continue;
      }
      const nums = line.split(/\s+/);
      if (nums.length >= 3) {
        entries.push(parseFloat(nums[0]), parseFloat(nums[1]), parseFloat(nums[2]));
      }
    }
    if (size < 2 || entries.length !== size * size * size * 3) {
      throw new Error("Invalid .cube 3D LUT file");
    }
    return { size, table: new Float32Array(entries), dMin, dMax };
  }

  async function resolveOfflineLut(cfg) {
    if (cfg.custom_lut_filename && customLutRegistry.has(cfg.custom_lut_filename)) {
      return customLutRegistry.get(cfg.custom_lut_filename);
    }
    if (!cfg.lut_id) return null;
    if (parsedLutCache.has(cfg.lut_id)) return parsedLutCache.get(cfg.lut_id);
    const meta = BUNDLED_LUTS.find((l) => l.id === cfg.lut_id);
    if (!meta || !ORIGINAL_FETCH) return null;
    try {
      const res = await ORIGINAL_FETCH(`/assets/luts/${meta.filename}`);
      if (!res.ok) return null;
      const parsed = parseCubeText(await res.text());
      parsedLutCache.set(cfg.lut_id, parsed);
      return parsed;
    } catch (_) {
      return null;
    }
  }

  async function applyColorGradeToCanvas(canvas, cfg) {
    const w = canvas.width;
    const h = canvas.height;
    const ctx = canvas.getContext("2d");
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;

    const lut = await resolveOfflineLut(cfg || {});
    const lutStrength = Math.max(0, Math.min(1, Number(cfg.lut_strength ?? 1.0)));
    const expMul = Math.pow(2, Number(cfg.exposure || 0));
    const contrast = Number(cfg.contrast ?? 1.0);
    const shadows = Number(cfg.shadows || 0);
    const highlights = Number(cfg.highlights || 0);
    const saturation = Number(cfg.saturation ?? 1.0);
    const temp = Number(cfg.temperature || 0);
    const vignette = Math.max(0, Math.min(1, Number(cfg.vignette || 0)));
    const grain = Math.max(0, Math.min(1, Number(cfg.grain || 0)));

    const lSize = lut ? lut.size : 0;
    const lTbl = lut ? lut.table : null;
    const lS2 = lSize * lSize;
    const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

    let seed = 1337;
    const nextRand = () => {
      seed = (seed * 16807) % 2147483647;
      return ((seed - 1) / 2147483646) - 0.5;
    };

    for (let y = 0; y < h; y += 1) {
      const ny = h > 1 ? (y - (h - 1) * 0.5) / (h * 0.5) : 0;
      for (let x = 0; x < w; x += 1) {
        const idx = (y * w + x) * 4;
        let r = clamp01((data[idx] / 255) * expMul);
        let g = clamp01((data[idx + 1] / 255) * expMul);
        let b = clamp01((data[idx + 2] / 255) * expMul);

        if (Math.abs(temp) > 1e-3) {
          r = clamp01(r * (1 + 0.14 * temp));
          g = clamp01(g * (1 + 0.02 * temp));
          b = clamp01(b * (1 - 0.14 * temp));
        }
        if (Math.abs(contrast - 1.0) > 1e-3) {
          r = clamp01((r - 0.5) * contrast + 0.5);
          g = clamp01((g - 0.5) * contrast + 0.5);
          b = clamp01((b - 0.5) * contrast + 0.5);
        }
        if (Math.abs(shadows) > 1e-3 || Math.abs(highlights) > 1e-3) {
          const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          if (Math.abs(shadows) > 1e-3) {
            const sm = Math.pow(clamp01((0.55 - luma) / 0.55), 1.5) * shadows * 0.28;
            r = clamp01(r + sm * (1 - r));
            g = clamp01(g + sm * (1 - g));
            b = clamp01(b + sm * (1 - b));
          }
          if (Math.abs(highlights) > 1e-3) {
            const hm = Math.pow(clamp01((luma - 0.45) / 0.55), 1.5) * highlights * 0.28;
            r = clamp01(r + hm * r);
            g = clamp01(g + hm * g);
            b = clamp01(b + hm * b);
          }
        }
        if (Math.abs(saturation - 1.0) > 1e-3) {
          const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          r = clamp01(luma + (r - luma) * saturation);
          g = clamp01(luma + (g - luma) * saturation);
          b = clamp01(luma + (b - luma) * saturation);
        }
        if (lTbl && lutStrength > 1e-3) {
          const rf = clamp01(r) * (lSize - 1);
          const gf = clamp01(g) * (lSize - 1);
          const bf = clamp01(b) * (lSize - 1);
          const r0 = Math.floor(rf), r1 = Math.min(r0 + 1, lSize - 1), dr = rf - r0;
          const g0 = Math.floor(gf), g1 = Math.min(g0 + 1, lSize - 1), dg = gf - g0;
          const b0 = Math.floor(bf), b1 = Math.min(b0 + 1, lSize - 1), db = bf - b0;
          const i000 = (b0 * lS2 + g0 * lSize + r0) * 3;
          const i001 = (b0 * lS2 + g0 * lSize + r1) * 3;
          const i010 = (b0 * lS2 + g1 * lSize + r0) * 3;
          const i011 = (b0 * lS2 + g1 * lSize + r1) * 3;
          const i100 = (b1 * lS2 + g0 * lSize + r0) * 3;
          const i101 = (b1 * lS2 + g0 * lSize + r1) * 3;
          const i110 = (b1 * lS2 + g1 * lSize + r0) * 3;
          const i111 = (b1 * lS2 + g1 * lSize + r1) * 3;
          const interp = (c) => {
            const c00 = lTbl[i000 + c] * (1 - dr) + lTbl[i001 + c] * dr;
            const c01 = lTbl[i010 + c] * (1 - dr) + lTbl[i011 + c] * dr;
            const c10 = lTbl[i100 + c] * (1 - dr) + lTbl[i101 + c] * dr;
            const c11 = lTbl[i110 + c] * (1 - dr) + lTbl[i111 + c] * dr;
            return (c00 * (1 - dg) + c01 * dg) * (1 - db) + (c10 * (1 - dg) + c11 * dg) * db;
          };
          r = clamp01(r * (1 - lutStrength) + interp(0) * lutStrength);
          g = clamp01(g * (1 - lutStrength) + interp(1) * lutStrength);
          b = clamp01(b * (1 - lutStrength) + interp(2) * lutStrength);
        }
        if (vignette > 1e-3) {
          const nx = w > 1 ? (x - (w - 1) * 0.5) / (w * 0.5) : 0;
          const t = clamp01((Math.sqrt(nx * nx + ny * ny) - 0.48) / 0.85);
          const mul = 1 - vignette * 0.72 * t * t * (3 - 2 * t);
          r *= mul; g *= mul; b *= mul;
        }
        if (grain > 1e-3) {
          const n = nextRand() * grain * 0.14;
          r = clamp01(r + n);
          g = clamp01(g + n);
          b = clamp01(b + n);
        }
        data[idx] = Math.round(r * 255);
        data[idx + 1] = Math.round(g * 255);
        data[idx + 2] = Math.round(b * 255);
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  function audioBufferToWavBlob(audioBuffer) {
    const numCh = audioBuffer.numberOfChannels;
    const len = audioBuffer.length;
    const sampleRate = audioBuffer.sampleRate;
    const dataBytes = len * numCh * 2;
    const buf = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buf);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numCh, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numCh * 2, true);
    view.setUint16(32, numCh * 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, dataBytes, true);
    let offset = 44;
    const channels = [];
    for (let ch = 0; ch < numCh; ch += 1) channels.push(audioBuffer.getChannelData(ch));
    for (let i = 0; i < len; i += 1) {
      for (let ch = 0; ch < numCh; ch += 1) {
        const s = Math.max(-1, Math.min(1, channels[ch][i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        offset += 2;
      }
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  function measureAudioBufferLufs(audioBuffer) {
    let sumSq = 0;
    let total = 0;
    let peak = 0;
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch += 1) {
      const arr = audioBuffer.getChannelData(ch);
      for (let i = 0; i < arr.length; i += 1) {
        const v = arr[i];
        const av = Math.abs(v);
        if (av > peak) peak = av;
        sumSq += v * v;
        total += 1;
      }
    }
    const rms = Math.sqrt(sumSq / Math.max(1, total));
    const lufs = rms > 1e-6 ? Math.round((-0.691 + 20 * Math.log10(rms)) * 100) / 100 : null;
    const peakDb = peak > 1e-6 ? Math.round(20 * Math.log10(peak) * 100) / 100 : null;
    return {
      has_audio: true,
      has_video: false,
      codec: "pcm/web",
      sample_rate: audioBuffer.sampleRate,
      channels: audioBuffer.numberOfChannels,
      duration: Math.round(audioBuffer.duration * 100) / 100,
      integrated_lufs: lufs,
      true_peak_db: peakDb,
    };
  }

  async function decodeMediaAudioBuffer(media) {
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) throw new Error("Web Audio API unavailable on this device");
    const ac = new AC();
    try {
      const buf = await media._file.arrayBuffer();
      return await ac.decodeAudioData(buf);
    } finally {
      await ac.close().catch(() => {});
    }
  }

  async function processAudioBufferOffline(audioBuffer, cfg) {
    const inStats = measureAudioBufferLufs(audioBuffer);
    const targetLufs = cfg.normalize_target_lufs !== null && cfg.normalize_target_lufs !== undefined
      ? Number(cfg.normalize_target_lufs)
      : null;
    const manualDb = Number(cfg.gain_db || 0);
    const makeupDb = targetLufs !== null && inStats.integrated_lufs !== null
      ? Math.max(-20, Math.min(28, targetLufs - inStats.integrated_lufs))
      : 0;
    const totalGainLin = Math.pow(10, (manualDb + makeupDb) / 20);

    const OAC = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    const off = new OAC(audioBuffer.numberOfChannels, audioBuffer.length, audioBuffer.sampleRate);
    const src = off.createBufferSource();
    src.buffer = audioBuffer;
    let node = src;

    if (Number(cfg.highpass_hz) > 0) {
      const hp = off.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = Number(cfg.highpass_hz);
      node.connect(hp);
      node = hp;
    }
    if (cfg.voice_clarity) {
      const low = off.createBiquadFilter();
      low.type = "peaking";
      low.frequency.value = 180;
      low.gain.value = 1.5;
      const hi = off.createBiquadFilter();
      hi.type = "peaking";
      hi.frequency.value = 3200;
      hi.gain.value = 3.2;
      node.connect(low);
      low.connect(hi);
      node = hi;
    }
    const gainNode = off.createGain();
    gainNode.gain.value = totalGainLin;
    node.connect(gainNode);
    node = gainNode;

    if (cfg.limiter_enabled !== false) {
      const comp = off.createDynamicsCompressor();
      comp.threshold.value = Number(cfg.true_peak_db ?? -1.5);
      comp.knee.value = 1.5;
      comp.ratio.value = 20;
      comp.attack.value = 0.002;
      comp.release.value = 0.05;
      node.connect(comp);
      node = comp;
    }
    node.connect(off.destination);
    src.start(0);

    const rendered = await off.startRendering();
    const outStats = measureAudioBufferLufs(rendered);
    const blob = audioBufferToWavBlob(rendered);
    return { blob, inStats, outStats };
  }

  function drawCensorFrameSync(ctx, outW, outH, origW, origH, boxes, mCfg, emojiImg, currentTimeSec) {
    const sx = outW / Math.max(1, origW);
    const sy = outH / Math.max(1, origH);
    const snapshot = document.createElement("canvas");
    snapshot.width = outW;
    snapshot.height = outH;
    snapshot.getContext("2d").drawImage(ctx.canvas, 0, 0);

    const vidStyle = mCfg.mask_type || mCfg.style || "blur";
    const shape = mCfg.shape || mCfg.mask_shape || "oval";
    const fitMult = faceFitScaleMultiplier(mCfg);
    const intensity = Math.max(5, Math.min(100, Number(mCfg.intensity ?? 60)));
    const pixelSize = Math.max(4, Math.min(64, Number(mCfg.pixel_size ?? Math.round(6 + intensity * 0.35))));

    const activeBoxes = (boxes || []).filter((b) => {
      if (!b) return false;
      const st = b.start_sec !== null && b.start_sec !== undefined ? Number(b.start_sec) : null;
      const en = b.end_sec !== null && b.end_sec !== undefined ? Number(b.end_sec) : null;
      if (st !== null && currentTimeSec < st) return false;
      if (en !== null && currentTimeSec > en) return false;
      return true;
    });

    const erasers = [];
    for (const rawBox of activeBoxes) {
      if (rawBox.kind === "eraser") { erasers.push(rawBox); continue; }
      const style = rawBox.mask_type || vidStyle;
      if (rawBox.kind === "brush" && Array.isArray(rawBox.brush_points)) {
        const radius = Math.max(6, (rawBox.brush_radius || 28) * Math.max(sx, sy));
        const fill = document.createElement("canvas");
        fill.width = outW; fill.height = outH;
        const fc = fill.getContext("2d");
        if (style === "redact" || style === "solid") {
          fc.fillStyle = mCfg.solid_color || "#000000";
          fc.fillRect(0, 0, outW, outH);
        } else {
          fc.filter = `blur(${Math.max(4, Math.round(intensity * 0.45 * sx))}px)`;
          fc.drawImage(snapshot, 0, 0);
        }
        const mask = document.createElement("canvas");
        mask.width = outW; mask.height = outH;
        const mc = mask.getContext("2d");
        mc.strokeStyle = "#ffffff"; mc.lineCap = "round"; mc.lineJoin = "round";
        mc.lineWidth = radius * 2;
        strokePolylineWithBreaks(mc, rawBox.brush_points, sx, sy);
        if (Array.isArray(rawBox.eraser_points) && rawBox.eraser_points.length > 0) {
          mc.globalCompositeOperation = "destination-out";
          mc.lineWidth = Math.max(6, (rawBox.eraser_radius || rawBox.brush_radius || 28) * Math.max(sx, sy)) * 2;
          strokePolylineWithBreaks(mc, rawBox.eraser_points, sx, sy);
        }
        fc.globalCompositeOperation = "destination-in";
        fc.drawImage(mask, 0, 0);
        ctx.drawImage(fill, 0, 0);
        continue;
      }

      const rawW = (rawBox.w || 0) * sx;
      const rawH = (rawBox.h || 0) * sy;
      const eff = rawBox.kind === "box" ? Math.max(0.5, Number(mCfg.mask_scale ?? 1.0)) : fitMult;
      const bw = rawW * eff;
      const bh = rawH * eff;
      const bx = (rawBox.x || 0) * sx - (bw - rawW) / 2;
      const by = (rawBox.y || 0) * sy - (bh - rawH) / 2;
      if (bw < 2 || bh < 2) continue;

      if (style === "emoji" && emojiImg) {
        const s = Math.max(bw, bh) * 1.1;
        ctx.drawImage(emojiImg, bx + (bw - s) / 2, by + (bh - s) / 2, s, s);
      } else if (style === "redact" || style === "solid" || style === "black") {
        ctx.save();
        traceMaskShapePath(ctx, bx, by, bw, bh, shape === "oval" ? "rect" : shape);
        ctx.fillStyle = mCfg.solid_color || "#000000";
        ctx.fill();
        ctx.restore();
      } else {
        const px0 = Math.max(0, Math.floor(bx));
        const py0 = Math.max(0, Math.floor(by));
        const pw = Math.max(1, Math.min(outW - px0, Math.ceil(bw)));
        const ph = Math.max(1, Math.min(outH - py0, Math.ceil(bh)));
        const tiny = document.createElement("canvas");
        const block = Math.max(4, Math.round(pixelSize * sx));
        tiny.width = Math.max(1, Math.round(pw / block));
        tiny.height = Math.max(1, Math.round(ph / block));
        tiny.getContext("2d").drawImage(snapshot, px0, py0, pw, ph, 0, 0, tiny.width, tiny.height);
        ctx.save();
        traceMaskShapePath(ctx, bx, by, bw, bh, shape);
        ctx.clip();
        ctx.imageSmoothingEnabled = style === "blur";
        ctx.drawImage(tiny, 0, 0, tiny.width, tiny.height, px0, py0, pw, ph);
        ctx.restore();
      }
    }

    if (erasers.length > 0) {
      const em = document.createElement("canvas");
      em.width = outW; em.height = outH;
      const ec = em.getContext("2d");
      ec.strokeStyle = "#ffffff"; ec.lineCap = "round"; ec.lineJoin = "round";
      erasers.forEach((eb) => {
        ec.lineWidth = Math.max(6, (eb.eraser_radius || eb.brush_radius || 28) * Math.max(sx, sy)) * 2;
        strokePolylineWithBreaks(ec, eb.eraser_points || eb.brush_points || [], sx, sy);
      });
      const rest = document.createElement("canvas");
      rest.width = outW; rest.height = outH;
      const rc = rest.getContext("2d");
      rc.drawImage(snapshot, 0, 0);
      rc.globalCompositeOperation = "destination-in";
      rc.drawImage(em, 0, 0);
      ctx.drawImage(rest, 0, 0);
    }
  }

  // =========================================================================
  // 6. FETCH & XHR INTERCEPTOR ROUTER
  // =========================================================================

  function jsonResponse(payload, status) {
    return new Response(JSON.stringify(payload), {
      status: status || 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  async function handleOfflineApiRequest(url, options) {
    const clean = stripQueryAndOrigin(url);
    const method = ((options && options.method) || "GET").toUpperCase();

    // 1) Media Uploads
    if ((clean === "/api/upload-media" || clean === "/api/compress/upload") && method === "POST") {
      const form = options.body;
      const files = form && typeof form.getAll === "function" ? form.getAll("files") : [];
      const media = [];
      for (const file of files) {
        if (file && typeof file.name === "string") {
          media.push(await ingestUploadedFile(file));
        }
      }
      return jsonResponse({ media });
    }

    if (clean === "/api/upload-watermark-logo" && method === "POST") {
      const form = options.body;
      const file = form && typeof form.get === "function" ? form.get("file") : null;
      if (!file) return jsonResponse({ detail: "Missing logo file" }, 400);
      const fname = `logo_${Date.now()}_${(file.name || "logo.png").replace(/[^\w.\-]+/g, "_")}`;
      const blobUrl = registerBlobUrl(`/api/uploads/${fname}`, file, fname, file.type || "image/png");
      logoRegistry.set(fname, { url: blobUrl, blob: file });
      return jsonResponse({ filename: fname, preview_url: blobUrl });
    }

    if (clean === "/api/session/cleanup" && method === "POST") {
      return jsonResponse({ ok: true });
    }

    if (clean === "/api/system/capabilities" && method === "GET") {
      return jsonResponse({
        hw_accel: { h264_encoder: "webcodecs/mediarecorder", hardware_accelerated: true, fallback: "canvas" },
        nudenet_available: false,
        offline_mode: true,
        mobile_1080p_guardrail: true,
      });
    }

    if (clean === "/api/emojis" && method === "GET") {
      if (ORIGINAL_FETCH) {
        try {
          const r = await ORIGINAL_FETCH("/assets/emojis/manifest.json");
          if (r.ok) return r;
        } catch (_) {}
      }
      return jsonResponse({ count: 0, emojis: [] });
    }

    // 2) Watermark Preview & Overlay
    if (clean === "/api/preview" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      const media = getMediaRecord(body.file_ids && body.file_ids[0]);
      if (!media) return jsonResponse({ detail: "Media not found" }, 404);
      const { canvas, width, height } = await renderMediaBaseCanvas(media, 1280, 0);
      await renderWatermarkLayers(canvas.getContext("2d"), width, height, (body.config && body.config.layers) || []);
      const blob = await canvasToBlob(canvas, "image/jpeg", 0.88);
      const previewUrl = registerBlobUrl(`/api/thumbnails/preview_${media.id}_${Date.now()}.jpg`, blob, "preview.jpg", "image/jpeg");
      return jsonResponse({ preview_url: previewUrl, width, height });
    }

    if (clean === "/api/watermark-overlay" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      const media = getMediaRecord(body.file_ids && body.file_ids[0]);
      if (!media) return jsonResponse({ detail: "Media not found" }, 404);
      const vw = media.width || 1280;
      const vh = media.height || 720;
      const scale = Math.max(vw, vh) > 1280 ? 1280 / Math.max(vw, vh) : 1;
      const ow = Math.max(2, Math.round(vw * scale));
      const oh = Math.max(2, Math.round(vh * scale));
      const c = document.createElement("canvas");
      c.width = ow;
      c.height = oh;
      await renderWatermarkLayers(c.getContext("2d"), ow, oh, (body.config && body.config.layers) || []);
      const blob = await canvasToBlob(c, "image/png");
      const overlayUrl = registerBlobUrl(`/api/thumbnails/overlay_${media.id}_${Date.now()}.png`, blob, "overlay.png", "image/png");
      return jsonResponse({ overlay_url: overlayUrl, width: ow, height: oh });
    }

    // 3) Batch Watermark & Compression Processing
    if (clean === "/api/process" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      const fileIds = body.file_ids || [];
      const jobId = nextId("job");
      const items = fileIds.map((fid) => {
        const m = getMediaRecord(fid);
        return {
          file_id: fid,
          filename: m ? m.filename : fid,
          orig_size_bytes: m ? m.size_bytes : 0,
          output_size_bytes: 0,
          output_filename: "",
          download_url: "",
          status: "queued",
          progress: 0,
          error: null,
        };
      });
      jobRegistry.set(jobId, {
        job_id: jobId,
        status: "in_progress",
        progress: 0,
        items,
      });
      setTimeout(() => runOfflineBatchJob(jobId, fileIds, body.config || {}), 10);
      return jsonResponse({ job_id: jobId });
    }

    // 4) Thumbnail Studio Endpoints
    if (clean === "/api/thumbnail/extract-candidates-stream" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      const media = getMediaRecord(body.file_id);
      if (!media) return jsonResponse({ detail: "Media not found" }, 404);
      const count = Math.max(1, Math.min(24, Number(body.count) || 9));
      const duration = media.duration || 1;
      const startSec = Math.max(0, Number(body.start_sec) || 0);
      const endSec = Math.min(duration, Number(body.end_sec) > 0 ? Number(body.end_sec) : duration);

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(JSON.stringify({ type: "start", total: count, duration }) + "\n"));
          try {
            const span = Math.max(0.05, endSec - startSec);
            for (let i = 0; i < count; i += 1) {
              const frac = count === 1 ? 0.5 : (i + 0.5) / count;
              const ts = Math.round((startSec + span * frac) * 100) / 100;
              const grabbed = await seekAndGrabVideoFrame(media._objectUrl, ts, 960);
              const blob = await canvasToBlob(grabbed.canvas, "image/jpeg", 0.86);
              const fname = `cand_${media.id}_${i}_${Date.now()}.jpg`;
              const frameUrl = registerBlobUrl(`/api/thumbnails/${fname}`, blob, fname, "image/jpeg");
              tempFrameRegistry.set(fname, { url: frameUrl, blob, width: grabbed.width, height: grabbed.height, timestamp_sec: ts });
              controller.enqueue(
                encoder.encode(
                  JSON.stringify({
                    type: "frame",
                    frame: {
                      index: i,
                      timestamp_sec: ts,
                      filename: fname,
                      url: frameUrl,
                      width: grabbed.width,
                      height: grabbed.height,
                    },
                    completed: i + 1,
                    total: count,
                  }) + "\n"
                )
              );
            }
            controller.enqueue(encoder.encode(JSON.stringify({ type: "done", total: count }) + "\n"));
          } catch (err) {
            controller.enqueue(encoder.encode(JSON.stringify({ type: "error", message: err.message }) + "\n"));
          } finally {
            controller.close();
          }
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
    }

    if (clean === "/api/thumbnail/extract-single-frame" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      const media = getMediaRecord(body.file_id);
      if (!media) return jsonResponse({ detail: "Media not found" }, 404);
      const ts = Number(body.timestamp_sec) || 0;
      const grabbed = await seekAndGrabVideoFrame(media._objectUrl, ts, 1920);
      const blob = await canvasToBlob(grabbed.canvas, "image/jpeg", 0.92);
      const fname = `exact_${media.id}_${Date.now()}.jpg`;
      const frameUrl = registerBlobUrl(`/api/thumbnails/${fname}`, blob, fname, "image/jpeg");
      tempFrameRegistry.set(fname, { url: frameUrl, blob, width: grabbed.width, height: grabbed.height, timestamp_sec: ts });
      return jsonResponse({ filename: fname, url: frameUrl, timestamp_sec: ts, width: grabbed.width, height: grabbed.height });
    }

    if (clean === "/api/thumbnail/generate-storyboard" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      const rows = Math.max(1, Number(body.rows) || 2);
      const cols = Math.max(1, Number(body.cols) || 2);
      const [baseW, baseH] = ASPECT_RATIOS[body.aspect_ratio || "16:9"] || [1280, 720];
      const scale = Number(body.resolution_scale) || 1;
      const tw = Math.round(baseW * scale);
      const th = Math.round(baseH * scale);
      const border = Math.max(0, Number(body.border_px) || 0);

      const sbCanvas = document.createElement("canvas");
      sbCanvas.width = tw;
      sbCanvas.height = th;
      const ctx = sbCanvas.getContext("2d");
      ctx.fillStyle = body.border_color || "#000000";
      ctx.fillRect(0, 0, tw, th);

      const cellW = (tw - border * (cols + 1)) / cols;
      const cellH = (th - border * (rows + 1)) / rows;
      const names = body.frame_filenames || [];
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          const fname = names[r * cols + c];
          if (!fname || !tempFrameRegistry.has(fname)) continue;
          const img = await loadImageFromBlobOrUrl(tempFrameRegistry.get(fname).url);
          const fitted = fitCanvasToAspect(img, Math.max(2, Math.round(cellW)), Math.max(2, Math.round(cellH)), "crop");
          ctx.drawImage(fitted, Math.round(border + c * (cellW + border)), Math.round(border + r * (cellH + border)));
        }
      }

      const sbBlob = await canvasToBlob(sbCanvas, "image/jpeg", 0.92);
      const sbName = `storyboard_${Date.now()}.jpg`;
      const sbUrl = registerBlobUrl(`/api/thumbnails/${sbName}`, sbBlob, sbName, "image/jpeg");
      tempFrameRegistry.set(sbName, { url: sbUrl, blob: sbBlob, width: tw, height: th });
      return jsonResponse({ filename: sbName, url: sbUrl });
    }

    if (clean === "/api/thumbnail/preview" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      const canvas = await renderThumbnailComposition(body.base_image_filename, body, 960);
      const blob = await canvasToBlob(canvas, "image/jpeg", 0.88);
      const previewUrl = registerBlobUrl(`/api/thumbnails/thumb_prev_${Date.now()}.jpg`, blob, "thumb_preview.jpg", "image/jpeg");
      return jsonResponse({ preview_url: previewUrl });
    }

    if (clean === "/api/thumbnail/export" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      const format = (body.format || "jpg").toLowerCase();
      const mime = format === "png" ? "image/png" : "image/jpeg";
      const ext = format === "png" ? "png" : "jpg";
      const baseFiles = body.base_image_filenames || [];
      const batchId = nextId("tbatch");
      const items = [];
      const zip = global.JSZip ? new global.JSZip() : null;

      for (let i = 0; i < baseFiles.length; i += 1) {
        const canvas = await renderThumbnailComposition(baseFiles[i], body, null);
        const blob = await canvasToBlob(canvas, mime, format === "png" ? undefined : 0.94);
        const label = i === 0 && body.include_main_thumbnail ? "Generated Thumbnail" : `Variation ${i + 1}`;
        const fname = `thumbnail_${batchId}_${i + 1}.${ext}`;
        const dlUrl = registerBlobUrl(`/api/download/${fname}`, blob, fname, mime);
        items.push({ filename: fname, label, download_url: dlUrl, size_bytes: blob.size });
        if (zip) zip.file(fname, blob);
      }

      let zipUrl = null;
      if (zip && items.length > 1) {
        const zBlob = await zip.generateAsync({ type: "blob" });
        const zName = `thumbnails_${batchId}.zip`;
        zipUrl = registerBlobUrl(`/api/download/${zName}`, zBlob, zName, "application/zip");
      }
      return jsonResponse({ batch_id: batchId, items, zip_url: zipUrl });
    }

    // 5) Privacy / Censor Studio Endpoints
    if (clean === "/api/censor/detect-faces" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      const media = getMediaRecord(body.file_id);
      if (!media) return jsonResponse({ detail: "Media not found" }, 404);
      const faces = await detectFacesOffline(media, body.frame_sec || 0);
      return jsonResponse({ file_id: media.id, width: media.width, height: media.height, faces });
    }

    if (clean === "/api/censor/detect-nsfw" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      const media = getMediaRecord(body.file_id);
      if (!media) return jsonResponse({ detail: "Media not found" }, 404);
      const candidates = await detectNsfwOffline(media, body.frame_sec || 0, body.sensitivity ?? 50, body.face_boxes || [], body.nsfw_classes || null);
      return jsonResponse({
        file_id: media.id,
        width: media.width,
        height: media.height,
        candidates,
        detector: "offline-skin-heuristic",
        warning: "Offline mobile skin heuristic used. Review masks before exporting or use LAN PC mode for ONNX NudeNet.",
      });
    }

    if (clean === "/api/censor/preview" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      const media = getMediaRecord(body.file_id);
      if (!media) return jsonResponse({ detail: "Media not found" }, 404);
      const { canvas, width, height, origWidth, origHeight } = await renderMediaBaseCanvas(media, 1080, body.frame_sec || 0);
      const origCopy = document.createElement("canvas");
      origCopy.width = width;
      origCopy.height = height;
      origCopy.getContext("2d").drawImage(canvas, 0, 0);

      await applyCensorMasksOnCanvas(
        canvas.getContext("2d"),
        origCopy,
        body.boxes || [],
        body.mask_config || {},
        width / Math.max(1, origWidth || width),
        height / Math.max(1, origHeight || height)
      );
      const blob = await canvasToBlob(canvas, "image/jpeg", 0.88);
      const previewUrl = registerBlobUrl(`/api/thumbnails/censor_prev_${media.id}_${Date.now()}.jpg`, blob, "censor_preview.jpg", "image/jpeg");
      return jsonResponse({ preview_url: previewUrl });
    }

    if (clean === "/api/censor/process" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      const media = getMediaRecord(body.file_id);
      if (!media) return jsonResponse({ detail: "Media not found" }, 404);

      if (media.media_type === "image") {
        const { canvas, width, height } = await renderMediaBaseCanvas(media, null, 0);
        const origCopy = document.createElement("canvas");
        origCopy.width = width;
        origCopy.height = height;
        origCopy.getContext("2d").drawImage(canvas, 0, 0);

        await applyCensorMasksOnCanvas(
          canvas.getContext("2d"),
          origCopy,
          body.boxes || [],
          body.mask_config || {},
          1,
          1
        );
        const isPng = (media.filename || "").toLowerCase().endsWith(".png");
        const mime = isPng ? "image/png" : "image/jpeg";
        const ext = isPng ? "png" : "jpg";
        const stem = media.filename.replace(/\.[^.]+$/, "") || media.id;
        const displayName = `protected_${stem}.${ext}`;
        const outFilename = `censor_${Date.now()}_${displayName}`;
        const outBlob = await canvasToBlob(canvas, mime, isPng ? undefined : 0.94);
        const dlUrl = registerBlobUrl(`/api/download/${outFilename}`, outBlob, displayName, mime);
        return jsonResponse({
          type: "image",
          filename: outFilename,
          display_name: displayName,
          download_url: dlUrl,
          size_bytes: outBlob.size,
        });
      }

      // Offline censored video job (progress reported in 0..100 for censor.js)
      const jobId = nextId("cjob");
      const job = {
        job_id: jobId,
        status: "in_progress",
        progress: 2,
        filename: "",
        display_name: "",
        download_url: "",
        size_bytes: 0,
        error: null,
        items: [],
      };
      jobRegistry.set(jobId, job);

      setTimeout(async () => {
        try {
          const origW = media.width || 1280;
          const origH = media.height || 720;
          let boxes = body.boxes || [];
          if (boxes.length === 0) {
            boxes = await detectFacesOffline(media, 0);
          }
          const mCfg = body.mask_config || {};
          const vidStyle = mCfg.mask_type || mCfg.style || "blur";
          const emojiImg = await loadEmojiAsset(mCfg.emoji_name || mCfg.emoji_id || "sunglasses", mCfg.custom_sticker_filename);
          const guardrailRes = (origH > 1080 && !body.full_res_override) ? "1080p" : "original";

          const res = await processVideoWithCanvas(media, {
            layers: [],
            videoPreset: "balanced",
            videoResolution: guardrailRes,
            drawFrameCallback: (ctx, outW, outH, currentTimeSec) => {
              drawCensorFrameSync(ctx, outW, outH, origW, origH, boxes, mCfg, emojiImg, currentTimeSec || 0);
            },
            onProgress: (p) => {
              job.progress = Math.min(99, Math.max(2, Math.round(p * 100)));
            },
            isCancelled: () => job.status === "cancelled",
          });

          const stem = media.filename.replace(/\.[^.]+$/, "") || media.id;
          const displayName = `protected_${stem}.${res.ext}`;
          const outFilename = `censor_${jobId}_${displayName}`;
          job.filename = outFilename;
          job.display_name = displayName;
          job.size_bytes = res.blob.size;
          job.download_url = registerBlobUrl(`/api/download/${outFilename}`, res.blob, displayName, res.mimeType);
          job.progress = 100;
          job.status = "completed";
        } catch (err) {
          job.status = "failed";
          job.error = err.message || "Offline video protection failed";
        }
      }, 20);

      return jsonResponse({ type: "video", job_id: jobId });
    }

    if (clean === "/api/censor/process-batch" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      const batchId = nextId("cbatch");
      const itemsOut = [];
      const zip = global.JSZip ? new global.JSZip() : null;

      for (const reqItem of body.items || []) {
        const media = getMediaRecord(reqItem.file_id);
        if (!media) continue;
        const { canvas, width, height } = await renderMediaBaseCanvas(media, null, 0);
        const origCopy = document.createElement("canvas");
        origCopy.width = width;
        origCopy.height = height;
        origCopy.getContext("2d").drawImage(canvas, 0, 0);
        await applyCensorMasksOnCanvas(canvas.getContext("2d"), origCopy, reqItem.boxes || [], body.mask_config || {}, 1, 1);

        const isPng = (media.filename || "").toLowerCase().endsWith(".png");
        const mime = isPng ? "image/png" : "image/jpeg";
        const ext = isPng ? "png" : "jpg";
        const stem = media.filename.replace(/\.[^.]+$/, "") || media.id;
        const displayName = `protected_${stem}.${ext}`;
        const fname = `${batchId}_${displayName}`;
        const outBlob = await canvasToBlob(canvas, mime, isPng ? undefined : 0.94);
        const dlUrl = registerBlobUrl(`/api/download/${fname}`, outBlob, displayName, mime);
        if (zip) zip.file(displayName, outBlob);
        itemsOut.push({
          file_id: media.id,
          filename: fname,
          display_name: displayName,
          target_count: (reqItem.boxes || []).length,
          download_url: dlUrl,
          size_bytes: outBlob.size,
        });
      }

      let zipFilename = `protected_batch_${batchId}.zip`;
      let zipUrl = "";
      let zipSize = 0;
      if (zip) {
        const zBlob = await zip.generateAsync({ type: "blob" });
        zipSize = zBlob.size;
        zipUrl = registerBlobUrl(`/api/download/${zipFilename}`, zBlob, zipFilename, "application/zip");
      }
      return jsonResponse({
        type: "batch",
        batch_id: batchId,
        zip_filename: zipFilename,
        zip_download_url: zipUrl,
        zip_size_bytes: zipSize,
        processed_count: itemsOut.length,
        items: itemsOut,
      });
    }

    if (clean === "/api/censor/process-video-batch" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      const reqItems = body.items || [];
      const mCfg = body.mask_config || {};
      const jobId = nextId("cvbatch");
      const job = {
        job_id: jobId,
        type: "video_batch",
        status: "processing",
        progress: 1,
        filename: "",
        download_url: "",
        zip_download_url: "",
        items: [],
      };
      jobRegistry.set(jobId, job);

      setTimeout(async () => {
        const zip = global.JSZip ? new global.JSZip() : null;
        const emojiImg = await loadEmojiAsset(mCfg.emoji_name || mCfg.emoji_id || "sunglasses", mCfg.custom_sticker_filename);
        for (let i = 0; i < reqItems.length; i += 1) {
          if (job.status === "cancelled") break;
          const reqItem = reqItems[i];
          const media = getMediaRecord(reqItem.file_id);
          if (!media) continue;
          try {
            const origW = media.width || 1280;
            const origH = media.height || 720;
            let boxes = reqItem.boxes || [];
            if (boxes.length === 0) boxes = await detectFacesOffline(media, 0);
            const guardrailRes = (origH > 1080 && !body.full_res_override) ? "1080p" : "original";
            const res = await processVideoWithCanvas(media, {
              layers: [],
              videoPreset: "balanced",
              videoResolution: guardrailRes,
              drawFrameCallback: (ctx, outW, outH, tSec) => {
                drawCensorFrameSync(ctx, outW, outH, origW, origH, boxes, mCfg, emojiImg, tSec || 0);
              },
              onProgress: (p) => {
                job.progress = Math.min(99, Math.max(1, Math.round(((i + p) / Math.max(1, reqItems.length)) * 100)));
              },
              isCancelled: () => job.status === "cancelled",
            });
            const stem = media.filename.replace(/\.[^.]+$/, "") || media.id;
            const displayName = `protected_${stem}.${res.ext}`;
            const fname = `${jobId}_${displayName}`;
            const dlUrl = registerBlobUrl(`/api/download/${fname}`, res.blob, displayName, res.mimeType);
            if (zip) zip.file(displayName, res.blob);
            job.items.push({ file_id: media.id, filename: fname, display_name: displayName, download_url: dlUrl, size_bytes: res.blob.size, status: "completed" });
          } catch (err) {
            job.items.push({ file_id: media.id, filename: media.filename, status: "failed", error: err.message });
          }
        }
        const completed = job.items.filter((x) => x.status === "completed");
        if (zip && completed.length > 0) {
          const zBlob = await zip.generateAsync({ type: "blob" });
          const zName = `protected_videos_${jobId}.zip`;
          job.zip_download_url = registerBlobUrl(`/api/download-zip/${jobId}`, zBlob, zName, "application/zip");
          job.filename = completed[0].display_name;
          job.download_url = completed[0].download_url;
        }
        job.progress = 100;
        job.status = completed.length ? "completed" : "failed";
      }, 20);

      return jsonResponse({ job_id: jobId, type: "video_batch", status: "processing" });
    }

    // 5C) Color & LUT Studio Offline Routes
    if (clean === "/api/color/luts" && method === "GET") {
      return jsonResponse({ luts: BUNDLED_LUTS });
    }

    if (clean === "/api/color/upload-lut" && method === "POST") {
      const form = options.body;
      const file = form && typeof form.get === "function" ? form.get("file") : null;
      if (!file) return jsonResponse({ detail: "Missing .cube file" }, 400);
      const parsed = parseCubeText(await file.text());
      const fname = `custom_${Date.now()}.cube`;
      customLutRegistry.set(fname, parsed);
      return jsonResponse({ filename: fname, label: file.name.replace(/\.cube$/i, ""), lut_size: parsed.size });
    }

    if (clean === "/api/color/preview" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      const media = getMediaRecord(body.file_id);
      if (!media) return jsonResponse({ detail: "Media not found" }, 404);
      const before = await renderMediaBaseCanvas(media, 1080, Number(body.frame_sec) || 0);
      const beforeBlob = await canvasToBlob(before.canvas, "image/jpeg", 0.88);
      const beforeUrl = registerBlobUrl(`/api/thumbnails/cb_${media.id}.jpg`, beforeBlob, "before.jpg", "image/jpeg");

      const after = document.createElement("canvas");
      after.width = before.width;
      after.height = before.height;
      after.getContext("2d").drawImage(before.canvas, 0, 0);
      await applyColorGradeToCanvas(after, body.config || {});
      const afterBlob = await canvasToBlob(after, "image/jpeg", 0.9);
      const afterUrl = registerBlobUrl(`/api/thumbnails/ca_${media.id}_${Date.now()}.jpg`, afterBlob, "after.jpg", "image/jpeg");
      return jsonResponse({ before_url: beforeUrl, after_url: afterUrl });
    }

    if (clean === "/api/color/process" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      const jobId = nextId("clr");
      const items = (body.file_ids || []).map((fid) => ({ file_id: fid, filename: (getMediaRecord(fid) || {}).filename || fid, status: "processing" }));
      const job = { id: jobId, status: "processing", progress: 0, items };
      jobRegistry.set(jobId, job);

      setTimeout(async () => {
        const zip = global.JSZip ? new global.JSZip() : null;
        for (let i = 0; i < job.items.length; i += 1) {
          const it = job.items[i];
          const media = getMediaRecord(it.file_id);
          try {
            if (!media || media.media_type !== "image") {
              throw new Error("Video LUT export requires LAN PC mode or image selection offline.");
            }
            const base = await renderMediaBaseCanvas(media, null, 0);
            await applyColorGradeToCanvas(base.canvas, body.config || {});
            const stem = media.filename.replace(/\.[^.]+$/, "") || media.id;
            const outName = `graded_${stem}.jpg`;
            const outBlob = await canvasToBlob(base.canvas, "image/jpeg", 0.92);
            it.download_url = registerBlobUrl(`/api/download/${jobId}_${outName}`, outBlob, outName, "image/jpeg");
            it.output_filename = outName;
            it.status = "completed";
            if (zip) zip.file(outName, outBlob);
          } catch (err) {
            it.status = "failed";
            it.error = err.message;
          }
          job.progress = (i + 1) / Math.max(1, job.items.length);
        }
        if (zip) {
          const zBlob = await zip.generateAsync({ type: "blob" });
          registerBlobUrl(`/api/download-zip/${jobId}`, zBlob, `graded_${jobId}.zip`, "application/zip");
        }
        job.status = job.items.some((x) => x.status === "completed") ? "completed" : "failed";
      }, 20);
      return jsonResponse({ job_id: jobId, status: "processing" });
    }

    // 5D) Audio Booster & Normalizer Offline Routes
    if (clean === "/api/audio/analyze" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      const media = getMediaRecord(body.file_id);
      if (!media) return jsonResponse({ detail: "Media not found" }, 404);
      const ab = await decodeMediaAudioBuffer(media);
      return jsonResponse({ file_id: media.id, filename: media.filename, stats: measureAudioBufferLufs(ab) });
    }

    if (clean === "/api/audio/preview" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      const media = getMediaRecord(body.file_id);
      if (!media) return jsonResponse({ detail: "Media not found" }, 404);
      const ab = await decodeMediaAudioBuffer(media);
      const res = await processAudioBufferOffline(ab, body.config || {});
      const prevUrl = registerBlobUrl(`/api/thumbnails/audio_prev_${media.id}_${Date.now()}.wav`, res.blob, "audio_preview.wav", "audio/wav");
      return jsonResponse({ preview_url: prevUrl, input_stats: res.inStats, output_stats: res.outStats });
    }

    if (clean === "/api/audio/process" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      const jobId = nextId("aud");
      const items = (body.file_ids || []).map((fid) => ({ file_id: fid, filename: (getMediaRecord(fid) || {}).filename || fid, status: "processing" }));
      const job = { id: jobId, status: "processing", progress: 0, items };
      jobRegistry.set(jobId, job);

      setTimeout(async () => {
        const zip = global.JSZip ? new global.JSZip() : null;
        for (let i = 0; i < job.items.length; i += 1) {
          const it = job.items[i];
          const media = getMediaRecord(it.file_id);
          try {
            if (!media) throw new Error("Media missing");
            const decoded = await decodeMediaAudioBuffer(media);
            const res = await processAudioBufferOffline(decoded, body.config || {});
            const stem = media.filename.replace(/\.[^.]+$/, "") || media.id;
            const outName = `boosted_${stem}.wav`;
            it.output_filename = outName;
            it.input_lufs = res.inStats.integrated_lufs;
            it.output_lufs = res.outStats.integrated_lufs;
            it.true_peak_db = res.outStats.true_peak_db;
            it.download_url = registerBlobUrl(`/api/download/${jobId}_${outName}`, res.blob, outName, "audio/wav");
            it.status = "completed";
            if (zip) zip.file(outName, res.blob);
          } catch (err) {
            it.status = "failed";
            it.error = err.message;
          }
          job.progress = (i + 1) / Math.max(1, job.items.length);
        }
        if (zip) {
          const zBlob = await zip.generateAsync({ type: "blob" });
          registerBlobUrl(`/api/download-zip/${jobId}`, zBlob, `audio_${jobId}.zip`, "application/zip");
        }
        job.status = job.items.some((x) => x.status === "completed") ? "completed" : "failed";
      }, 20);
      return jsonResponse({ job_id: jobId, status: "processing" });
    }

    // 5E) File Converter Offline Routes (images + ZIP bundling)
    if (clean === "/api/converter/capabilities" && method === "GET") {
      return jsonResponse({
        notes: {
          media: "Offline Android mode: image conversion (PNG, JPG, WebP) and ZIP bundling run locally on-device. Video, audio, PDF, and Office conversions require the PC/LAN server.",
          office: "",
          archives: "",
        },
      });
    }

    if (clean === "/api/converter/upload" && method === "POST") {
      const form = options.body;
      const files = form && typeof form.getAll === "function" ? form.getAll("files") : [];
      const mediaList = [];
      const rejected = [];
      for (const f of files) {
        if (!f || !f.name) continue;
        const ext = (f.name.split(".").pop() || "").toLowerCase();
        const normExt = ext === "jpeg" ? "jpg" : ext;
        const isImg = (f.type && f.type.startsWith("image/")) || ["png", "jpg", "jpeg", "webp", "bmp", "gif"].includes(ext);
        const fid = nextId("conv");
        const objUrl = URL.createObjectURL(f);
        mediaRegistry.set(fid, {
          id: fid,
          filename: f.name,
          media_type: isImg ? "image" : "file",
          size_bytes: f.size || 0,
          file: f,
          objectUrl: objUrl,
        });
        const targets = isImg ? ["png", "jpg", "webp"].filter((t) => t !== normExt) : [];
        mediaList.push({
          id: fid,
          filename: f.name,
          media_type: isImg ? "image" : "file",
          format_name: normExt ? normExt.toUpperCase() : "FILE",
          size_bytes: f.size || 0,
          targets,
        });
      }
      return jsonResponse({ media: mediaList, rejected });
    }

    if (clean === "/api/converter/jobs" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      const jobId = nextId("cjob");
      const job = { id: jobId, status: "processing", progress: 0, items: [], zip_download_url: null };
      jobRegistry.set(jobId, job);

      setTimeout(async () => {
        const conversions = body.conversions || [];
        const zipIds = body.zip_file_ids || [];
        const zip = global.JSZip ? new global.JSZip() : null;
        const mimeMap = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

        if (zipIds.length > 0 && zip) {
          for (const fid of zipIds) {
            const rec = mediaRegistry.get(fid);
            if (rec && rec.file) zip.file(rec.filename, rec.file);
          }
          const zBlob = await zip.generateAsync({ type: "blob" });
          const zName = `archive_${jobId}.zip`;
          const dlUrl = registerBlobUrl(`/api/download/${zName}`, zBlob, zName, "application/zip");
          registerBlobUrl(`/api/converter/preview/${zName}`, zBlob, zName, "application/zip");
          job.items.push({
            filename: "ZIP Archive",
            output_filename: zName,
            target: "zip",
            status: "completed",
            size_bytes: zBlob.size,
            download_url: dlUrl,
          });
          job.progress = 1;
          job.status = "completed";
          return;
        }

        if ((body.combine_image_ids || []).length > 0) {
          job.error = "Combine images to PDF requires the PC/LAN server.";
          job.progress = 1;
          job.status = "failed";
          return;
        }

        for (let i = 0; i < conversions.length; i += 1) {
          const req = conversions[i];
          const rec = mediaRegistry.get(req.file_id);
          try {
            if (!rec || rec.media_type !== "image") {
              throw new Error("Only image conversion is available offline on Android.");
            }
            const base = await renderMediaBaseCanvas(rec, null, 0);
            const target = (req.target || "png").toLowerCase();
            const mime = mimeMap[target] || "image/png";
            if (target === "jpg") {
              const bgCanvas = document.createElement("canvas");
              bgCanvas.width = base.width;
              bgCanvas.height = base.height;
              const bctx = bgCanvas.getContext("2d");
              bctx.fillStyle = "#ffffff";
              bctx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
              bctx.drawImage(base.canvas, 0, 0);
              base.canvas = bgCanvas;
            }
            const outBlob = await canvasToBlob(base.canvas, mime, 0.92);
            const stem = rec.filename.replace(/\.[^.]+$/, "") || rec.id;
            const outName = `${stem}.${target}`;
            const storedName = `${jobId}_${outName}`;
            const dlUrl = registerBlobUrl(`/api/download/${storedName}`, outBlob, outName, mime);
            registerBlobUrl(`/api/converter/preview/${storedName}`, outBlob, outName, mime);
            if (zip) zip.file(outName, outBlob);
            job.items.push({
              file_id: rec.id,
              filename: rec.filename,
              output_filename: storedName,
              target,
              status: "completed",
              size_bytes: outBlob.size,
              download_url: dlUrl,
            });
          } catch (err) {
            job.items.push({
              file_id: req.file_id,
              filename: rec ? rec.filename : req.file_id,
              target: req.target,
              status: "failed",
              error: err.message,
            });
          }
          job.progress = (i + 1) / Math.max(1, conversions.length);
        }

        const completed = job.items.filter((x) => x.status === "completed");
        if (zip && completed.length > 1) {
          const zBlob = await zip.generateAsync({ type: "blob" });
          const zName = `converted_${jobId}.zip`;
          job.zip_download_url = registerBlobUrl(`/api/download/${zName}`, zBlob, zName, "application/zip");
        }
        job.progress = 1;
        job.status = completed.length ? "completed" : "failed";
      }, 20);

      return jsonResponse({ job_id: jobId, status: "processing" });
    }

    const convJobMatch = clean.match(/^\/api\/converter\/jobs\/([^/]+)$/);
    if (convJobMatch && method === "GET") {
      const job = jobRegistry.get(convJobMatch[1]);
      if (!job) return jsonResponse({ detail: "Job not found" }, 404);
      return jsonResponse(job);
    }

    // 6) Job Status & Cancel & Mapped Static Blobs
    const jobCancelMatch = clean.match(/^\/api\/job\/([^/]+)\/cancel$/);
    if (jobCancelMatch && method === "POST") {
      const job = jobRegistry.get(jobCancelMatch[1]);
      if (!job) return jsonResponse({ detail: "Job not found" }, 404);
      job.status = "cancelled";
      return jsonResponse({ status: "cancelled" });
    }

    const jobMatch = clean.match(/^\/api\/job\/([^/]+)$/);
    if (jobMatch && method === "GET") {
      const job = jobRegistry.get(jobMatch[1]);
      if (!job) return jsonResponse({ detail: "Job not found" }, 404);
      return jsonResponse({
        ...job,
        items: (job.items || []).map(({ _blob, ...rest }) => rest),
      });
    }

    if (blobUrlMap.has(clean)) {
      const mappedUrl = blobUrlMap.get(clean);
      return ORIGINAL_FETCH(mappedUrl);
    }

    return jsonResponse({ detail: `Offline endpoint not mapped: ${clean}` }, 404);
  }

  // Patch global.fetch for /api/* in offline mode
  if (ORIGINAL_FETCH) {
    global.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input && input.url ? input.url : "";
      const clean = stripQueryAndOrigin(url);
      if (clean.startsWith("/api/")) {
        return handleOfflineApiRequest(url, init || {}).catch((err) => {
          console.error("[MobileEngine] API error:", clean, err);
          return jsonResponse({ detail: err.message || "Offline engine error" }, 500);
        });
      }
      return ORIGINAL_FETCH(input, init);
    };
  }

  // Patch sendBeacon for /api/session/cleanup
  if (navigator && typeof navigator.sendBeacon === "function") {
    const origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      if (stripQueryAndOrigin(url).startsWith("/api/")) {
        return true;
      }
      return origBeacon(url, data);
    };
  }

  // Patch XMLHttpRequest for /api/upload-media progress (used by thumbnail.js)
  if (ORIGINAL_XHR) {
    global.XMLHttpRequest = function () {
      const inner = new ORIGINAL_XHR();
      let isOfflineApi = false;
      let targetUrl = "";
      let targetMethod = "GET";
      let uploadListeners = {};
      let xhrListeners = {};

      const wrapper = {
        responseType: "",
        status: 0,
        response: null,
        responseText: "",
        upload: {
          addEventListener(type, fn) {
            if (!uploadListeners[type]) uploadListeners[type] = [];
            uploadListeners[type].push(fn);
          },
        },
        addEventListener(type, fn) {
          if (!xhrListeners[type]) xhrListeners[type] = [];
          xhrListeners[type].push(fn);
          inner.addEventListener(type, fn);
        },
        open(method, url) {
          targetMethod = method;
          targetUrl = url;
          isOfflineApi = stripQueryAndOrigin(url).startsWith("/api/");
          if (!isOfflineApi) {
            return inner.open.apply(inner, arguments);
          }
        },
        setRequestHeader() {
          if (!isOfflineApi) return inner.setRequestHeader.apply(inner, arguments);
        },
        abort() {
          if (!isOfflineApi) return inner.abort();
          (xhrListeners.abort || []).forEach((fn) => fn(new ProgressEvent("abort")));
        },
        send(body) {
          if (!isOfflineApi) return inner.send.apply(inner, arguments);

          (uploadListeners.progress || []).forEach((fn) =>
            fn({ lengthComputable: true, loaded: 50, total: 100 })
          );
          handleOfflineApiRequest(targetUrl, { method: targetMethod, body })
            .then(async (res) => {
              wrapper.status = res.status;
              const txt = await res.text();
              wrapper.responseText = txt;
              wrapper.response = wrapper.responseType === "json" ? JSON.parse(txt) : txt;
              (uploadListeners.progress || []).forEach((fn) =>
                fn({ lengthComputable: true, loaded: 100, total: 100 })
              );
              (uploadListeners.load || []).forEach((fn) => fn(new ProgressEvent("load")));
              (xhrListeners.load || []).forEach((fn) => fn(new ProgressEvent("load")));
            })
            .catch((err) => {
              wrapper.status = 500;
              wrapper.responseText = JSON.stringify({ detail: err.message });
              (xhrListeners.error || []).forEach((fn) => fn(new ProgressEvent("error")));
            });
        },
      };
      return wrapper;
    };
  }
})(window);
