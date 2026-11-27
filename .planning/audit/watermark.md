# Audit — Watermark, Compressor, Collage studios

Scope: `static/watermark.html`, `static/js/app.js`, `static/js/compressor.js`, `static/js/collage.js`,
`static/js/workspace.js`, `engine/image_processor.py`, `engine/video_processor.py`,
`engine/font_manager.py`, `engine/models.py`, watermark/compressor endpoints in `server.py`.
Method: static read + live probes against `python -m uvicorn server:app` (port 8765), ffmpeg 9.0.1,
Pillow 12.3, PyMuPDF 1.28.2. Artifacts/scripts in `_audit_tmp/wm_*.py`, `_audit_tmp/*.png`.
Read-only audit: no project file was modified; only this report and `_audit_tmp`/generated runtime files were written.

`node --check` on all frontend JS: **OK** — app.js, workspace.js, compressor.js, collage.js, censor.js, thumbnail.js, theme.js, session.js all parse.

## Confirmed bugs

Every item below was reproduced (screenshots / logs / numeric output in `_audit_tmp`).

1. **Tiled watermark grid drifts between preview and export (preview/export parity broken for tiled mode).**
   `engine/image_processor.py:180-193`. Tile step is `patch_w + max(10, int(tile_spacing*ref_scale))`; the
   patch size does not scale linearly (font size `int()` at `:25`, glyph bbox rounding at `:32-34`, and
   `max(...)` floors at `:36-38`), while spacing does, and stagger uses integer `step_x // 2` at `:191`.
   Observed (default tiled config, 1440×810 preview vs 3840×2160 export): normalised row period
   preview `0.14568` vs export `0.14722` (**1.06 % drift**), glyph-blob count 424 vs 452, best-alignment
   needs `dy = -5 px` at preview scale (**0.62 % of frame height**); alpha-mask IoU at zero shift **0.34**,
   rising to only **0.50** after best shift (`_audit_tmp/tiled_default_stagger.png`, `wm_tiled.py`).
   With `rotation=-30` the row period is not even comparable (preview 207 px vs export 92 px peak detection).
   Expected: identical normalised grid. Numeric per-tile offset grows across the frame, so 4K exports are
   visibly offset from the preview checkerboard; wide vs tall media show different tile counts.

2. **EXIF-rotated photos: preview/queue show the un-rotated image, export is rotated (WYSIWYG break).**
   `server.py:249-255` builds `preview_base_*.jpg` and `thumb_*.jpg` from `img.copy()` **without**
   `ImageOps.exif_transpose`, and Pillow's JPEG save drops the EXIF orientation tag (verified: preview base
   EXIF keys `[]`). Export path does transpose (`engine/image_processor.py:219`). Observed with a 1200×800
   stored / orientation-6 JPEG: sidebar thumb `240×160` landscape, `/api/preview` output `1200×800`
   landscape, `/api/process` export **`800×1200` portrait`**, while `media.width/height` still report
   `1200×800` (`server.py:250`). Watermark normalised bbox in preview `(0.769,0.943)-(0.984,0.978)` vs
   export `(0.654,0.962)-(0.976,0.985)`: red/blue/yellow orientation markers move from top/bottom/left to
   right/left/top (`_audit_tmp/exif_preview_left_export_right.png`). Phone photos are the main use case, so
   this is a high-impact parity failure.

3. **All WebM exports fail — hard-coded H.264/AAC into a WebM container.** `engine/video_processor.py:100-105`
   (compress-only) and `:120-129` (watermark path) always use `libx264`/`aac`; output extension is the input
   extension (`server.py:462-470`). Observed: `src.webm` upload accepted (`server.py:137`), then both
   `compress_only` and `watermark_and_compress` jobs report `failed`; manual replay of the exact command:
   `[webm @ …] Only VP8 or VP9 or AV1 video and Vorbis or Opus audio … are supported for WebM` /
   `Could not write header`. No `-c:v libvpx-vp9` branch exists.

4. **ffmpeg failure reason is discarded — failed video items show an empty error string.**
   `engine/video_processor.py:142-158`: the `while` loop consumes `process.stderr.readline()` until EOF, then
   `process.stderr.read()` at `:157` returns `""`. Observed API item error exactly
   `"FFmpeg failed with exit code 4294967274: "` — users cannot see why a video failed (WebM/odd-dims cases
   above are indistinguishable from each other). Expected: capture/carry the stderr tail.

5. **Odd-dimension videos fail to export.** Input 1281×721 (`ffprobe` confirmed) uploaded fine; watermark
   export fails: `[vost#0:0/libx264] Could not open encoder before EOF`, `Conversion failed!`
   (`engine/video_processor.py:109-129` — overlay keeps the odd `yuv444p` size and libx264 4:2:0 needs even
   dimensions; no `scale=trunc(iw/2)*2:trunc(ih/2)*2` / `-pix_fmt yuv420p` normalisation). Verified 0-byte
   output left in `outputs/`. Expected: either succeed with padded dims or a clear error.

6. **"1080p/720p/480p" presets only cap width, never height.** `engine/video_processor.py:83-88`
   (`min(1920,iw)` etc.). Measured outputs: portrait 2160×3840 → `1080p` = **1920×3414**, `720p` =
   **1280×2276**, `480p` = **854×1518**; square 2160×2160 → `480p` = **854×854**. The UI promises
   "Downscale to 1080p Full HD / 720p / 480p" (`static/watermark.html:371-373`,
   `static/compressor.html:129-131`). Expected: height-aware `scale=-2:'min(1080,ih)'` (or width for landscape only).

7. **Same-basename files collide in outputs and ZIP.** `server.py:469-470` (`out_name` uses only the original
   basename), `:491/:502` (both items get the same `download_url`), `:567-569` (same `arcname` twice).
   Verified: two different `same.jpg` uploads (different bytes, 142 171 vs 139 952 B) → both items report
   `watermarked_same.jpg`, both download URLs identical, both downloads **identical bytes (119 276 B)** —
   the first export is silently lost; ZIP contains `watermarked_same.jpg` twice. Also applies to batch runs
   across folders and to ZIP entry names.

8. **SVG logos are accepted by the UI/API but silently ignored at render time.** `static/watermark.html:228`
   (`accept="image/svg+xml"`), `server.py:364-380` saves any upload, but `engine/image_processor.py:88-91`
   `Image.open(svg)` raises → `except: return None`; layer is skipped with no error in preview or export.
   Verified `render_image_patch(svg layer)` → `None`. Same silent-skip for a missing/renamed logo file
   (`image_processor.py:84-86`). Expected: reject SVG at upload with a clear message, or rasterise.

9. **Bold checkbox is a no-op for Georgia, Verdana, Trebuchet MS, Courier New.** `engine/font_manager.py:4-20`
   has no `"… bold"` entries for those families; `:26-29` appends `" bold"`, misses the map, and falls back to
   the regular file. Verified returned faces: Georgia bold → `georgia.ttf`, Verdana bold → `verdana.ttf`,
   Trebuchet bold → `trebuc.ttf`, Courier bold → `cour.ttf` (Windows ships `georgiab.ttf`, `verdanab.ttf`,
   `trebucbd.ttf`, `courbd.ttf`). Impact is smaller (Impact legitimately has no bold), but the control lies.

10. **Non-Latin text renders as tofu — no font fallback.** `engine/font_manager.py:39-47` always falls back to
    `C:\Windows\Fonts\arial.ttf`; the comment at `:39` claims a "direct try with family as file" but that code
    does not exist (`:40-45`). Verified render of `中文水印 Arabic: العربية Emoji: 🎉`: CJK characters and 🎉
    render as empty squares, Arabic renders correctly (`_audit_tmp/edge_text_3538.png`). Any Arabic-only text
    also loses shaping quality (Pillow basic layout, no `raqm`). Expected: fallback chain (e.g. `msyh.ttc`,
    `seguiemj.ttf`) or per-glyph fallback.

11. **TIFF export fails; `.tif` is not even classified as an image.** `IMAGE_EXTENSIONS` has `.tiff` but not
    `.tif` (`server.py:136`), so `.tif` uploads become `media_type="unknown"` and fail with
    `Unsupported media type` in the Watermark studio (verified); in the Compressor they become "document" and
    are gzipped (`compressed_photo.tif.gz`). `.tiff` passes upload but export crashes:
    `engine/image_processor.py:246-250` calls `composite.convert("RGB").save(out, quality=quality)` →
    Pillow: `quality setting only supported for 'jpeg' compression` (`/api/process` item failed, verified).
    Expected: explicit `compression=`/format handling per extension.

12. **Animated GIFs are flattened to one frame** in both modes. `engine/image_processor.py:226-231` converts
    to a single RGBA frame; `.gif` save writes one frame. Verified 4-frame animated GIF → output 1 frame in
    `watermark_and_compress` and `compress_only`. Expected: preserve frames or reject animation.

13. **Compressor can inflate JPEGs (quality slider mostly ineffective; 4:4:4 forced).**
    `engine/image_processor.py:236-238` always saves JPEG with `subsampling=0` and no size target. Measured on
    a 2.33 MB, quality-92 source: q60 → −61.2 %, q75 → −39.9 %, q85 (default) → only **−5.5 %**, q95 →
    **+54.6 % (larger)**. The UI in the export modal claims "85% quality cuts image file size by ~60%"
    (`static/watermark.html:384`). Expected: keep 4:2:0 unless quality ≥ ~92, and/or only keep the smaller of
    input/output.

14. **ODT/ODP/ODS/EPUB "embedded image optimisation" never runs, and ODF/EPUB `mimetype` is made spec-invalid.**
    `server.py:191` tests `"/pictures/" in path` but ODF zip entries are root-relative (`Pictures/img1.png`) →
    no match; verified embedded PNG byte-identical after compression (`3 538 713 → 3 538 713`). Worse,
    `server.py:184-194` rewrites every entry with `ZIP_DEFLATED` (`:193`), so the `mimetype` entry that ODF/EPUB
    require to be first + STORED becomes DEFLATED: verified input `compress_type=0` → output `compress_type=8`.
    Verified "compression" of spec ODT/EPUB produced **+2 bytes** (grew). Expected: case-insensitive match on
    `pictures/` etc., and copy `mimetype` (first entry) with STORED.

15. **Job/asset lifecycle leaks.** `server.py:64` `jobs: Dict[str, dict]` is never pruned (no TTL, no cap),
    and outputs are not registered to the tab session (`register_session_file` only covers uploads/thumbs,
    `server.py:73-77`; `/api/process` sends no `session_id` from app.js:1083-1092). Verified `outputs/` already
    holds 49 files/17.9 MB with no UI cleanup path; only the 2 h janitor (`server.py:98-134`) removes them, and
    failed ffmpeg runs leave 0-byte/partial files. There is no job cancellation endpoint — closing the progress
    modal (`app.js:569`) leaves the job running.

### Verified as working (no bug found — do not "fix" these)

- **Single-placement preview/export parity**: same config rendered at preview-base resolution vs native 4K
  gives normalised watermark bbox deltas ≤ 0.0014 (≤ 1.4 px at 3840 px; 0.017–0.04 %), including 9-grid
  anchors, margins, custom x/y, rotation (45°), bg badge radius/padding, font-size scaling by
  `max(w,h)/1920`, and image `scale_percent` (`engine/image_processor.py:112-208`). The design of compositing
  onto a `thumbnail((1440,1440))` base is sound because everything is proportional to `max(w,h)`.
- **Video preview/export placement parity**: `/api/watermark-overlay` 1920-wide cap vs native export gives
  ≤0.15 % normalised bbox delta on 4K, square 2000² and portrait 2160×3840 (`server.py:432-438`).
- **Video rotation metadata**: OpenCV auto-rotates (`get_video_info` returns display dims 720×1280) and
  ffmpeg 9 bakes auto-rotation into the output; verified watermark lands at the expected normalised position
  and output is 720×1280 without rotation side-data. (Preview overlay uses the same rotated dims → consistent.)
- **Video audio**: `-map 0:a?` + `-c:a copy` (master) and `aac 128k/160k` work; no-audio inputs export fine;
  progress parsing yields monotonic 0→1 on normal MP4/MKV/MOV/AVI; temp `.overlay.png` is cleaned in `finally`.
- **Compressor PDF branch** works (`pymupdf` 1.28.2 installed): 467 086 → 329 477 B (−29.5 %), page count,
  text and image preserved on reopen (`server.py:167-181`).
- **ZIP branch** repackages correctly (STORED→DEFLATED, 154 208 → 50 522 B, `testzip()` clean); **gzip
  fallback** round-trips byte-identically (`server.py:196-200`).
- **Download naming** preserves spaces/unicode (`Content-Disposition: filename*=utf-8''watermarked_my%20photo…`).
- **Concurrent jobs** started together both complete (2 simultaneous jobs verified); list/dict mutation in the
  worker does not crash the poller in practice (GIL-atomic field writes).

## Quality weaknesses

1. **No ICC/EXIF preservation on any image export.** `apply_watermark_to_image` composites to RGBA and saves
   fresh (`engine/image_processor.py:236-250`); wide-gamut (Display-P3) phone photos shift colour, EXIF
   camera data/GPS is dropped (only orientation is honoured on export, and not on preview — bug 2).
2. **Preview pipeline double-JPEGs**: preview base q92 (`server.py:255`) then composited preview saved at q92
   (`server.py:404-410`), so preview shows compression artifacts absent from export (fine for geometry,
   misleading for judging quality).
3. **Fixed preview filenames, no lock**: `server.py:400-401`, `:440-442` write `preview_{file_id}.jpg` /
   `overlay_{file_id}.png`. Two tabs or a debounced burst (250 ms, `app.js:959-969`) can serve one config's
   image for another; only cache-busting query params differ.
4. **Full-resolution RGBA in memory**: images are loaded/composited at native size (`image_processor.py:229-231`);
   a 100 MP photo needs ≈ 400 MB base + 400 MB overlay + copy. Video overlay is materialised at native size
   and PNG-encoded every job (`video_processor.py:109-111`) — 8K video ≈ 132 MB+ per layer and a slow PNG write.
5. **Video pixel format / HDR**: watermark path forces 8-bit output (`yuv420p`) even for 10-bit HEVC input (verified:
   compress-only keeps `yuv420p10le`, watermark export becomes `yuv420p`), so HDR/HLG content loses depth and
   may be colour-shifted without tonemapping.
6. **`image_quality` is silently ignored for PNG/BMP/GIF** (lossless/no-op) while the modal implies a global
   quality knob; BMP re-save produced byte-identical size (no savings); PNG "compression" is only
   `optimize=True` (verified 12 854 → 11 354 B, i.e. marginal).
7. **Text edge cases**: empty/whitespace text renders a 13×13 fully transparent patch, silently (no UI warning);
   a 300-char string creates a 9 614 px-wide patch and is clipped at canvas edges (no wrapping/auto-shrink);
   `render_text_patch` measures/rotates the patch even when fully off-canvas (wasted work on huge inputs).
8. **Compressor frontend uses a non-existent field** `media.preview_url` (`static/js/compressor.js:249`); the
   upload response only has `thumb_url` (`server.py:293-304`) even though a 1440 px `preview_base` already
   exists. Result: the "preview" pane loads the **original upload** (`/api/uploads/...`), decoding 20–100 MB
   images in the browser; TIFF/GIF originals cannot render at all.
9. **ZIP UI/behaviour**: `/api/download-zip` file is named `watermarked_bundle_*.zip` even for compress-only
   jobs (`server.py:561`); the compressor always shows the ZIP button after completion even when 0 files
   succeeded (`static/js/compressor.js:349-357`), yielding an empty archive; failed items are silently omitted
   from the ZIP (only counted in text). Outputs zip is rebuilt on every request (blocking, unbounded growth).
10. **Office/ZIP rewrite is memory- and trust-unsafe**: `server.py:184-194` does `source.read(item.filename)`
    for every entry (a multi-GB ZIP member is loaded whole), and encrypted archives raise mid-rewrite leaving
    a partial output; no `testzip`/CRC validation, no rollback on exception.
11. **`compress_document_file` PDF path has no error handling / dependency guard** (`server.py:167-181`):
    encrypted or malformed PDFs raise raw PyMuPDF errors into the job item; `pymupdf` is imported lazily and
    is not declared anywhere in the repo (no `requirements.txt` found).
12. **Collage `Border width` slider does nothing**: `static/collage.html:150` has `#collageBorderWidth`, but the
    binding list in `static/js/collage.js:387` omits it; `state.borderWidth` stays 2. Dead control.
13. **Collage export is fixed 1200 px-wide PNG only** (`static/js/collage.js:173-175`, `:397-403`): no output
    resolution/format choice (1200×1200, 1200×2133 for 9:16), and always PNG (large files); export canvas is
    re-rendered synchronously in the click handler (blocks on large collages).
14. **Collage ordering is load-order dependent**: `addPhotos` pushes into `state.photos` from each image's
    `onload` (`static/js/collage.js:358-365`), so adding 10 originals can produce an order different from the
    file picker order. Reordering exists only via ↑/↓ buttons/context menu — no drag-and-drop, despite the
    "dnd" expectation; canvas dragging pans the photo crop instead.
15. **Collage memory**: every photo is decoded at full resolution (`new Image()` from the object URL) and kept
    for the session; 20 × 24 MP photos ≈ several GB of browser memory; `redraw()` re-rasterises all of them on
    every pointermove (`static/js/collage.js:172-184` called from `:342`).
16. **Tiled pattern coverage is poor on extreme aspect ratios** (by design, but out-of-scale with the UI):
    3 840×1 080 → 78.5 % of pixel rows contain no watermark; tall 1 080×3 840 → 81.6 % empty rows; border
    coverage 1.5–18 %. Spacing is scaled by `max(w,h)`, so on a wide panorama the vertical pitch is relatively
    huge. Consider scaling spacing by min(w,h) or normalising tile density per megapixel.
17. **Frontend dead reference**: `app.js:65` looks up `#watermarkOverlayStage`, which does not exist in
    `watermark.html` (null, unused). `app.js` re-implements the whole workspace layout/resizer/section-toggle
    logic (`app.js:147-268`) that `static/js/workspace.js:3-130` provides for the other studios — two copies to
    maintain (and they already differ: 900 px vs 1000 px breakpoint, `maxWidth` 480 vs 500).
18. **Duplicated global listeners**: `window` `mouseup` bound twice in `app.js:472` and `:791`; resizer handles
    bind `pointermove/pointerup` per drag and remove them only on `pointerup` (lost `pointercancel` leaks).
19. **`upload_media` treats unknown extensions as zero-size media**: width/height 0 and `thumb_url` pointing at a
    file that was never written (`server.py:237-304`); the Compressor relies on the response and shows broken
    thumbnails for such files.

## Recommended fixes (prioritized)

1. **Make preview and export share one geometry pipeline.** Best: render the preview from
   `create_watermark_overlay` **at export pixel coordinates**, then downscale the *overlay+image composite* for
   display (server already does this for stills, so parity holds) and for tiled mode derive the step from the
   **unrounded** `patch + spacing` multiplied by the same `ref_scale`, computing tile origins in float then
   rounding only at composite time. Add a regression test comparing normalised bbox / blob centroids at
   1440 and 3840 (`_audit_tmp/wm_tiled.py` is a starting harness).
2. **Fix EXIF orientation end-to-end**: apply `ImageOps.exif_transpose` in `upload_media` before recording
   `width/height` and before generating `preview_base`/`thumb` (`server.py:249-262`); keep the raw file for
   export (already transposed there). Test with orientation 6/8/3 fixtures (have one in
   `_audit_tmp/fixtures/exif6_markers.jpg`).
3. **Pick container-appropriate video codecs**: map output extension to encoder
   (`webm → libvpx-vp9/libopus`, `mp4/mov/m4v → libx264/aac`, `mkv/avi → libx264`), force `-pix_fmt yuv420p`,
   pad odd dimensions, and **capture stderr into the raised error** (fix `video_processor.py:142-158`).
4. **Collision-proof outputs**: include the `file_id` (or an index) in `out_name`, e.g.
   `{prefix}_{fid8}_{name_root}{ext}`; dedupe ZIP arcnames; keep the original name only for the download
   `Content-Disposition` (`server.py:462-570`).
5. **Fix Compressor document branch**: case-insensitive ODF/Office media detection (`pictures/`, `media/`,
   `images/`), preserve `mimetype` first + STORED for ODF/EPUB, stream ZIP members instead of `read()`,
   fall back to `.gz` only for truly opaque formats, and surface per-format errors. Also fix JPEG output
   (4:2:0 unless very high quality) and never write a larger file than the input.
6. **Extend font handling**: add bold entries for Georgia/Verdana/Trebuchet/Courier, add a CJK + emoji fallback
   chain, and validate the user's text in the UI (warn on tofu / empty text). Add `.tif` to
   `IMAGE_EXTENSIONS` and explicit per-format save logic for TIFF/BMP/GIF (or reject unsupported formats at
   upload).
7. **Job lifecycle**: TTL/cap on `jobs`, register outputs to the session or delete job outputs after ZIP
   download, add `POST /api/job/{id}/cancel` that terminates the ffmpeg child and marks the job, and show real
   ffmpeg errors in the per-item status.
8. **Preview robustness**: unique temp names per request (`preview_{fid}_{uuid}.jpg`) or a short lock, and use
   server-side preview for the Compressor (add `preview_url` to the upload response).
9. **Collage**: bind `collageBorderWidth`, offer 1200/2400/4000 px export with PNG/JPEG choice, downscale
   decoded photos (e.g. to 2× the slot size) before storing, and add row drag-and-drop reordering. Optionally
   add a server-side render for large collages.
10. **Tile defaults**: default `tile_spacing` should be expressed relative to `max(w,h)` (e.g. 8 %/6 %) so the
    visual density does not collapse to two rows on 21:9/32:9 media; document the per-media coverage.

## Architecture notes

- **Single engine, two consumers.** Preview (`/api/preview`), video overlay (`/api/watermark-overlay`) and export
  (`/api/process` → `process_batch_worker`) all call `create_watermark_overlay`; stills preview composites at
  1440-px base, video overlay at ≤1920-px, export at native. Proportional `max(w,h)/1920` scaling
  (`BASE_REF_DIM`) is the right idea and is why non-tiled parity works; the only sources of divergence are
  integer rounding and the preview caps (see bugs 1–2).
- **Progress/state is in-process only.** `uploaded_media`, `jobs`, `session_files` are module globals
  (`server.py:63-71`); the app is single-worker (`run.bat` → `python server.py`, uvicorn `reload=True`, port
  8000). Two uvicorn workers or a restart would break job polling and media lookups. The `jobs` dict is mutated
  from FastAPI's background thread while being serialised by the poller; current mutations only append to lists
  and set existing keys, so it works, but it is not synchronised (no lock, unlike `session_files_lock`).
- **Video pipeline is a single ffmpeg pass** with a pre-rendered PNG overlay (`-filter_complex overlay`), which
  keeps audio/video in sync and one-pass quality good; the overlay is rendered for **every job** (no cache) and
  at full resolution. `ffmpeg` is invoked by bare name (`"ffmpeg"`), relying on PATH; no version check, no
  hardware-encode path (NVENC/AMF/QSV configured in the ffmpeg build but unused).
- **Compressor is a "renaming" surface over three backends**: video → `apply_watermark_to_video`
  (`compress_only` mode), images → `apply_watermark_to_image` (`compress_only`), documents → local
  `compress_document_file` (PyMuPDF / zipfile / gzip). The document backend is the newest uncommitted work
  (`git diff server.py`) and is where most of the confirmed document bugs live. `.gz`-fallback outputs change
  the file type while the UI still calls it "compression".
- **Collage is 100 % client-side** (`static/js/collage.js` makes no API calls; all state and the renderer live in
  the browser). It is untracked (`git status`: `?? static/collage.html`, `?? static/js/collage.js`,
  `?? static/js/workspace.js`) and therefore not covered by any server/engine test; its export is the live
  canvas at 1200 px, so it has no server-side parity risk but also no server-side validation/tests.
- **Shared layout module** `static/js/workspace.js` is loaded by compressor.html and collage.html but **not** by
  watermark.html, which carries a near-duplicate implementation in `app.js:147-268`; any layout change must be
  made twice. `workspace.js` is also untracked in git (new file) while being loaded in production pages — a
  commit/verification gap.
- **No requirements manifest** in the repo root (only `run.bat`); `pymupdf` is a new implicit dependency of the
  uncommitted PDF compressor, and `cv2`, `Pillow`, `fastapi`, `uvicorn` are similarly assumed. A fresh machine
  will fail the PDF branch at runtime (per-item error) rather than at startup.
- **Uncommitted-change risk**: the audit ran against a dirty tree on `fix/censor-tracking-bugs`
  (`M server.py`, `M static/js/app.js`, `M static/compressor.html`, `M static/js/compressor.js`,
  `M static/watermark.html`, `M static/css/style.css`, plus untracked collage/workspace files). Bugs 3–14 above
  touch modified/uncommitted code (document compressor, video presets, format handling), so treat the branch as
  pre-review, not as a regression baseline. No project source file was changed by this audit.
