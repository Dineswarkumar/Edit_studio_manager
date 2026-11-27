# Thumbnail Studio Pro — Bug Audit

Scope: `static/thumbnail.html`, `static/js/thumbnail.js`, `engine/thumbnail_processor.py`, thumbnail endpoints in `server.py` (lines ~590–850), plus shared helpers `engine/video_processor.py` / `engine/font_manager.py` where they feed the thumbnail flow. Read-only audit on branch `fix/censor-tracking-bugs` (uncommitted redesign present).

Method: static review + dynamic verification against an isolated copy of the app (`_audit_tmp/server_copy`, uvicorn on 127.0.0.1:8899/8901) so the real project's `uploads/`, `outputs/`, `thumbnails/` were never touched. Engine tests rendered real images; media behaviour tested with `ffmpeg`/`ffprobe` (9.0.1) and OpenCV 5.0.0 on `test_data/sample_video.mp4` (640×480, 30 fps, 2.00 s), `test_data/sample.jpg` (800×600), `BLUR_TEST_1.mp4` (1080×1920, 50 fps, 104.0 s stream / 104.049 s container), plus a synthetic VFR clip. Repro scripts: `_audit_tmp/probe.py`, `probe_media.py`, `test_compositor.py`, `test_extra.py`, `frontend_check.py`, `api_test.py`, `api_extra.py`.

Checked and found **fine** (so they can be stated as working):
- **Output dimensions are exact for all 6 ratios.** Render produced 1920×1080 / 1080×1920 / 1080×1080 / 1080×1350 / 1080×1440 / 1440×1080 at scale 1 and 3840×2160 / 2160×3840 / 2160×2160 / 2160×2700 / 2160×2880 / 2880×2160 at scale 2, matching `ASPECT_RATIOS` (`engine/thumbnail_processor.py:10-17`). Preview and export use the same `render_thumbnail` path, so their dimensions agree.
- **"Crop to fill" is genuinely centred and does not stretch.** Black→white gradient source, 1:1 output: measured left/right edge luminance 55.5/198.5 vs expected 55.8/199.2; 9:16: 87.0 vs expected 87.2. A white circle in a square source stayed circular in 16:9/9:16/4:3/4:5 outputs (bbox aspect 1.000–1.001). `stretch` mode is the only non-uniform mode (circle aspect 1.778 by design).
- **Aspect-ratio/fit math for `fit` (blur letterbox)** produced exact target dimensions and an undistorted foreground.
- **ffmpeg time seeking is accurate** (`-ss` before `-i` vs accurate decode seek: byte-identical frames at 0.017/0.5/0.51/1.001/1.5 s). Candidate extraction is timestamp-based, not frame-index-based, so CFR seek math is not a bug source. VFR duration from OpenCV was also correct on the synthetic VFR clip (fps was reported as `frames/duration`).
- **Enhancement math is correct** where wired: saturation 1.25 → mean HSV-S 139.95→161.88 (1.6 → 184.89); contrast 1.15 → RGB std 22.5→26.1. Sticker alpha/opacity math is correct (alpha-128 red over RGB(40,40,40) gave (148,20,19) at opacity 1.0 and (94,30,30) at 0.5, matching the alpha blend).
- **JPEG export really is quality 98 with 4:4:4 chroma** (verified SOF sampling factors 1×1/1×1/1×1; 3840×2160 file 440 KB), and **PNG export is lossless RGBA** (3840×2160, mode RGBA, 296 KB).
- **No duplicate element IDs in `thumbnail.html`** (89 ids, 0 duplicates); `workspace.js` references only existing ids.
- **No object-URL leak in the normal path**: one `URL.createObjectURL` (`thumbnail.js:669`), revoked on replacement (`:654`) and on `beforeunload` (`:82`).
- **The sync `def` thumbnail endpoints don't freeze the event loop**: during a 9-variation 4K export, `GET /api/media` stayed at 5.5 ms median / 121 ms max (baseline 5.1/23.5 ms). The blocking problem is the *async* upload endpoint (bug 15).
- **Export filename collisions do not occur**: `batch_id = uuid4()[:8]` gives distinct names across repeated exports (verified two consecutive exports).
- **Storyboard cells no longer distort** (the uncommitted rewrite to `ImageOps.fit` fixed that): 3×3 at scale 2 → 3840×2160, correct cell crop; output JPEG q96 4:2:0 (see weakness W6).

## Confirmed bugs

1. **Tilt angle slider is dead: JS sends `angle`, backend reads `rotation`.**
   - `static/js/thumbnail.js:1200` and `:1363` send `angle: state.tiltAngle`; `engine/thumbnail_processor.py:309` reads `text_item.get("rotation", 0.0)`. Preview and export payloads both wrong.
   - Observed vs expected: rendering with `angle:-20` produced output **byte/mean-abs-diff 0.000** vs no tilt (completely ignored); `rotation:-20` changed the image (mean-abs-diff 1.586). Endpoint test: preview with JS `angle`/`shadow` keys vs the same payload without them → **identical file MD5**.
   - Impact: the "Tilt Angle" control in the UI never tilts anything; `thumbnail.html:296` slider is decorative.

2. **Drop-shadow toggle is dead: JS sends `shadow`, backend reads `shadow_enabled`.**
   - `thumbnail.js:1201`/`:1364` send `shadow`; `thumbnail_processor.py:286` reads `shadow_enabled` (default `True`).
   - Observed vs expected: unchecking "Drop Shadow" (`thumbnail.html:300`) produced **0.000** diff vs default (ignored); backend `shadow_enabled:false` produced a 0.154 diff (works). Shadow is always on.

3. **Vignette unit mismatch: UI sends 0–100, backend expects 0.0–1.0.**
   - UI `sliderVignette` is `min=0 max=100 value=35` (`thumbnail.html:354`), sent raw as `adjustments.vignette` (`thumbnail.js:1189`, `:1351`); backend uses it as a 0–1 amount (`thumbnail_processor.py:175`, `:188`: `opacity = min(1, vignette_amount * 0.85)`).
   - Observed vs expected: `vignette=35` and `vignette=100` produced **exactly identical output** (mean-abs-diff 50.57 each — max effect); any slider value ≥ ~1.18 clamps to maximum. The default ("35%") already applies the maximum vignette, darkening centre 127→103 (−19%) and corners to ~1.1. Expected 35 → `0.35` (mean-abs-diff 14.8, centre 120).
   - Secondary: mask is built as a full-frame ellipse then inverted, blurred with `radius = min(w,h)*0.35` (`:183-184`) — at 4K that is a 756-px blur; it behaves as heavy fog over all edges/corners, not a radial focus vignette.

4. **Live preview can show stale/out-of-order results: no request sequencing or cancellation.**
   - `schedulePreview()` debounces only 180 ms (`thumbnail.js:1172-1176`); `fetchLivePreview()` (`:1178-1237`) has no sequence token / `AbortController` and assigns `el.thumbPreviewImg.src` unconditionally (`:1231`).
   - Measured: 4K preview from the 1080×1920 frame took **1435/1421/1667 ms** (16:9: 1568 ms); from a 640×480 candidate 1215–1527 ms. With a 180 ms debounce, ~7–9 requests can be in flight while dragging a slider; responses arriving late overwrite a newer, correct preview. Same race when switching candidate frames (`selectCandidate` → `schedulePreview`, `:1020`).
   - Note: the **scrubber itself does not fetch** frames (`fineScrubber` only seeks the `<video>`, `:332-336`; single-frame capture is button-driven, `:390-393`), so there is no "out-of-order scrub frame response" — the out-of-order problem is the preview race above.

5. **Overlapping candidate scans corrupt state and gallery↔array indexes.**
   - `extractCandidates()` only disables `btnRescanFrames` (`thumbnail.js:704-705`); the grid preset buttons (`:304-310`) and custom-grid Apply (`:312-319`) call `setGridSize()` (`:569-577`) which calls `extractCandidates()` again while a scan is running. No `AbortController`/token anywhere in the file.
   - Each second call resets `state.candidateFrames`/`storyboardFrames` and clears the gallery (`:706-714`), while the first stream keeps pushing frames (`:744-756`) and appending cards built with `candidateIndex = state.candidateFrames.length - 1` (`:747-748`). Result: mixed/duplicated candidates, wrong storyboard ordering, and stale card `idx` closures (`createCandidateCard(..., idx)` → `selectCandidate(idx)`, `:814`) so clicking a card can select a different frame than shown.
   - Server permits concurrent scans (each stream is a separate sync generator; a 9-frame scan of the 125 MB 50 fps clip took 1.68 s, so overlap windows are large).

6. **Custom capture range is silently overwritten after each scan; range label never updates.**
   - On `start` message the client does `el.inputEndSec.value = message.duration.toFixed(2)` (`thumbnail.js:739-743`) **even when a custom end was requested**; `state.endSec` keeps the old custom value, so the visible field no longer matches the last scan. The next "Scan & Extract Frames" click reads the overwritten field (`:320-328`) and silently rescans the full video.
   - `el.intervalRangeLabel` (`thumbnail.html:111`) is assigned but never written again (`thumbnail.js:104` only) → the label always says "Full Video" even for a custom range.

7. **Scanning at/after the end of the video "succeeds" with zero frames and no error.**
   - `get_grid_candidate_timestamps` clamps `start = min(start_sec, duration)` (`thumbnail_processor.py:77`); if `start == duration` then `span = 0` and every timestamp equals `duration` (verified: `[2.0, 2.0, ...]` for a 2.0 s clip with `start_sec=5`). ffmpeg yields no frame for `-ss 2.0` on a clip whose last frame PTS is 1.967; the stream endpoint emits `frame: null` and then `done` (server.py:643-661), HTTP 200.
   - API evidence: `start_sec=5.0` on the 2.0 s sample → 9/9 frames null, `done`, HTTP 200; JS then shows "Ready · 0 frames extracted" (`thumbnail.js:782`) and just disables export.

8. **Capturing the frame at the scrubber's maximum returns HTTP 500.**
   - `fineScrubber.max` is set to the duration (`thumbnail.js:343`, `:674`, `:741`); at max the server runs ffmpeg at `ts == duration`, which produces no file → `raise HTTPException(500, "Failed to capture frame")` (`server.py:693-695`). No nearest-frame/frame-0 fallback exists in the thumbnail path (`thumbnail_processor.py:54-66`; contrast `extract_video_frame` does have a frame-0 fallback).
   - API evidence: `extract-single-frame` ts=0.75 → 200, ts=0.0 → 200, **ts=1.99 → 500, ts=2.0 → 500**. In the UI: drag the "Exact Moment Scrubber" to the end, click capture → alert "Capture error: Failed to capture exact frame".

9. **Candidate timestamps are neither frame-snapped nor deduplicated, so dense grids waste ~40% of extractions and can lose frames.**
   - `get_grid_candidate_timestamps` (`thumbnail_processor.py:70-87`) = `span/(count+1)` stepped; no clamp to the last decodable frame and no dedupe against the frame grid. UI allows custom grids up to 10×10 = 100 candidates (`thumbnail.html:99-102`, `thumbnail.js:314-315`; server cap 100, `server.py:593`).
   - Evidence on the 2.0 s 30 fps sample with `count=100`: **99 files written, only 59 unique frames, 40 duplicate candidate JPEGs**, and the last candidate (index 99, t=1.9802 s) **failed entirely** (no file; last frame PTS is 1.9667). Also `count=1` returns the midpoint by design, but `start>duration` produces nine identical timestamps (bug 7).

10. **Upload-time preview frame uses frame-index seeking and is badly wrong for VFR.**
    - `extract_video_frame` computes `target_frame = int(timestamp_sec * CAP_PROP_FPS)` then `CAP_PROP_POS_FRAMES` (`engine/video_processor.py:37-39`); `get_video_info` uses `frames/fps` for duration (`:18-20`). OpenCV reports the average fps for VFR, so on the synthetic VFR clip (48 frames, real PTS 0–3.7 s) requests landed on the wrong frame: want 0.5 s → actual PTS 0.200 s (−0.300 s), 1.5 s → 0.667 s (−0.833 s), 2.5 s → 1.500 s (−1.000 s).
    - `server.py:270` calls this at upload time to build the thumbnail module's initial `preview_base_*`/`thumb_*` image, so a VFR video's initial base frame is from the wrong moment (candidate/scrubber extraction is unaffected because it uses ffmpeg time seeks).

11. **Generated thumbnail files accumulate; only session-close cleans them.**
    - Every preview writes a brand-new JPEG (`server.py:760-774`), every stream scan writes 9–100 new JPEGs with a fresh UUID prefix (`server.py:636-649`, filename `..._f{idx}_{int(ts*1000)}.jpg`, `thumbnail_processor.py:40`), and `delete_media` only removes `thumb_*`/`preview_base_*` (`server.py:315-337`) — old `cand_*`/`exact_*`/`sheet_*`/`thumb_prev_*` files are never removed when the video changes or is deleted.
    - Measured: 3 previews → +3 files (440–600 KB each at 4K); one short API session left 36 files in `thumbnails/`; session cleanup did delete 45 registered files (36→1 left over because one storyboard request had no `session_id`). Browser crash/force-quit means the 2-hour janitor (`server.py:98-117`) is the only cleanup.

12. **"All Variations" export silently drops the current design when the base is a collage.**
    - `executeExport` sends `state.candidateFrames.map(c => c.filename)` for scope "all" (`thumbnail.js:1340-1342`); a collage sheet produced by `makeStoryboardBackground` becomes `state.activeBaseFilename` (`:1115`) but is never in `candidateFrames`. The ZIP therefore contains only the candidate frames, not the current collage/base or the exact-capture-only current design — while `updateExportSummary` promises "Exporting N variations" (`:1323-1325`). API evidence: 3-base export produced ZIP with exactly the 3 candidate names; the active sheet was not included.
    - Related: the ZIP always contains the candidate set, so "All Variations" ≠ "current + variations".

13. **Export silently no-ops when bases are missing, and one bad frame aborts the whole batch.**
    - Missing bases are `continue`d (`server.py:800-806`); if none resolve the endpoint returns 200 with `items: []` and `zip_url: null` (verified). The client only triggers a download for `items.length === 1` or `zip_url` (`thumbnail.js:1399-1414`), so the user gets no file, no error, and an empty results area.
    - Conversely, `render_thumbnail` is called without per-item try/except (`server.py:811-821`), so a single corrupt/unreadable base raises and the entire export (all variations) returns 500.

14. **Download filenames are mangled: `/api/download` splits at the first underscore.**
    - `parts = filename.split("_", 1)` (`server.py:551-552`) keeps only the remainder as the display name. Verified export `thumbnail_aadf7ed4_1.jpg` serves `Content-Disposition: attachment; filename="aadf7ed4_1.jpg"`; ZIP `thumbnails_bundle_*.zip` downloads as `bundle_*.zip`. Expected the full generated name.

15. **The async upload endpoint does blocking CPU/disk work on the event loop.**
    - `/api/upload-media` is `async def` (`server.py:220`) but performs blocking `shutil.copyfileobj(file.file, buffer)` (`:233`), PIL thumbnails (`:249-283`), `get_video_info` (OpenCV) and `extract_video_frame` (`:264-270`) inline.
    - Measured during a 125 MB (`BLUR_TEST_1.mp4`) upload: `GET /api/media` latency median 7 ms but **max 588 ms** (loop stalled); upload took 2.33 s end-to-end. Expected: threadpool/`run_in_threadpool` so concurrent requests and previews don't freeze. (All thumbnail endpoints themselves are sync `def` and correctly threadpooled — see "found fine".)

16. **After the uncommitted redesign, the sidebar resizer is referenced but its DOM was deleted.**
    - `thumbnail.js:187-188` fetch `btnToggleSidebarWidth` and `thumbPanelResizer`, which no longer exist in `thumbnail.html` (git diff shows their removal). `initSidebarResizer` early-returns at `:192`, so the width toggle/drag/dblclick handlers are dead code (75 lines) and `--thumb-sidebar-w` is never set. No crash (guarded), but the "expand/compress sidebar" feature is silently gone.

17. **Long titles overflow the canvas and are clipped — there is no autofit, wrap, or shrink.**
    - `render_thumbnail_patch_text` sizes text from the raw `font_size` (`thumbnail_processor.py:249`) and never compares its `text_w` to `canvas_w`; `render_thumbnail` centres the patch and alpha-composites at possibly negative coordinates (`:388-394`), so Pillow clips at the canvas edge.
    - Measured patch widths: 11-char title @90 → 550 px (fits 1920); 86-char title @90 → **3308 px vs 1920 canvas (+72%)** and vs 1080 canvas for 9:16 (+206%); 67-char @180 (4K scale-2 equivalent) → **5188 px** (6616 px equivalent at scale 2) vs 3840. Endpoint returns HTTP 200 with the title cut off on both sides. Badge boxes inherit the same overflow.
    - API evidence: preview with an 86-char title returned 200 while the text was clipped (`thumbnail.js` never warns).

18. **Scrubber precision is 100 ms, not the advertised millisecond.**
    - `<input type="range" step="0.1">` (`thumbnail.html:135`), time text shows tenths only (`thumbnail.js:1465-1470`), server rounds candidate timestamps to 2 decimals (`thumbnail_processor.py:60`), `inputStartSec`/`inputEndSec` step 0.5 (`thumbnail.html:114-115`) — while the button claims "Capturing exact millisecond" (`thumbnail.js:1050`). Actual position is quantised to 100 ms (and to the underlying frame interval); captured frame = first frame at/after the requested time.

19. **Preview errors are silent.**
    - `fetchLivePreview` catch only does `console.warn` (`thumbnail.js:1234-1236`); a failed render (bad base, oversized payload, server error) leaves the previous/stale preview on screen with no UI indication.

20. **A selected "Arial Black" font silently renders as Arial.**
    - `FONT_MAP` has no `"arial black"` entry (`engine/font_manager.py:4-17`); `get_font("Arial Black", 90, True)` resolves to `C:\Windows\Fonts\arial.ttf` (verified) because the bold lookup fails and the fallback is regular Arial (`:29`, `:39-44`). UI offers "Arial Black" at `thumbnail.html:262`.

## Quality weaknesses

- **W1 — "4K · sharper zoom" is pure upscaling (`thumbnail.html:232`).** Target resolution is fixed regardless of source: from a 1920×1080 source, 16:9 scale-2 is a 2× upscale; the *used* source crop and scale factors are 9:16 → 607×1080 crop → 2160×3840 (3.56×), 4:5 → 864 px → 2.5×, 3:4 → 810 px → 2.67×, 1:1 → 2×, 4:3 → 2×; from the 640×480 sample video, 16:9 4K is a 6× upscale (230 k source pixels → 8.3 MP). No detail is added; the option increases file size and render time for no resolution gain.
- **W2 — JPEG generation-loss chain contradicts the "zero quality loss"/"Ultra Quality" copy.** Candidates are extracted as ffmpeg `-q:v 2` JPEGs (`thumbnail_processor.py:45-52`), then re-encoded to q98 4:4:4 (`:401`); the docstring says "0 quality loss" (`:326`) and `server.py:793` says "zero quality loss", while the UI only claims 98 % for JPEG (`thumbnail.html:384`). The base frame is lossy before compositing; PNG export is the only truly lossless option (verified). A lossless intermediate (PNG/raw) for candidates would preserve quality.
- **W3 — 4K preview/export latency is high and invisible to the user.** Engine: 16:9 4K render 575–686 ms with no adjustments, 1140–1206 ms with UI-default saturation+contrast, 1167–1327 ms with the UI-default vignette; 9:16 4K: 858 ms without vignette. End-to-end: **preview 1.4–1.7 s**, **export of 9 variations 15.1–15.4 s** (1.7 s/variation). Causes: LANCZOS upscale to 8.3 MP, `ImageEnhance` on 8.3 MP, huge vignette blur, q98 4:4:4 JPEG encode. There is no progress indication for export beyond a button label, no cancel, and no reduced-resolution preview path (the preview always renders at full `resolution_scale`, `thumbnail.js:1185`).
- **W4 — Vignette mask shape.** See bug 3: inverted full-frame ellipse + `min(w,h)*0.35` Gaussian blur (756 px at 4K) produces a near-uniform dark border with corner/edge values ≈1–3 and a 19 % centre dip; a true radial falloff would use a distance ramp and a small blur.
- **W5 — Candidate extraction speed: 9 frames of the 125 MB 1080×1920 50 fps clip took 1.68 s (187 ms/frame);** the tiny 2 s clip took 461 ms (51 ms/frame). One ffmpeg process per candidate (`server.py:643-659` → `extract_frames_at_timestamps`) means N process starts and N seeks; a single ffmpeg pass (fps filter / select) or parallel workers would cut this substantially. The non-stream endpoint (`server.py:598-621`) duplicates the same logic and is now dead code (JS only calls the stream variant).
- **W6 — Storyboard JPEG is 4:2:0 at q96** (`server.py:731`; verified SOF sampling 2×2 for components 1, 2/3 are 1×1) — fine for a collage preview, but it is chroma-subsampled, unlike the export JPEG path.
- **W7 — Candidate timestamps are requested times, not the actual extracted frame PTS** (`thumbnail_processor.py:60` stores the requested `ts`). Displayed times are therefore off by up to one frame (33 ms @30 fps; for VFR, up to the inter-frame gap — the dense test showed timestamps landing on earlier frames) and `selectCandidate` seeks the source video to that approximate time. Honest limitation, but the UI presents them as exact.
- **W8 — Frontend state duplication / dead UI.** HTML defaults and JS `state` duplicate every control; `state.isBatchMode` and `state.stickerPreviewUrl` are written but never read; `RESOLUTION_MAP[...].cssAspect` is unused; `el.thumbStudioContainer` is unused; `intervalRangeLabel` never updated (bug 6); `btnCaptureScrubberFrame` is initially labelled "📸 Add Current Moment as Candidate" (`thumbnail.html:136-138`) but reset to "📸 Capture Current Scrubber Shot" after the first capture (`thumbnail.js:1077`) — the two labels disagree. There is no framework/state binding, so these drifts are expected to recur.
- **W9 — Backend accepts untyped `dict` blobs.** `ThumbnailDesignRequest.text_items` / `stickers` are `List[dict]` (`server.py:744-746`); unknown keys are silently ignored and no validation catches the `angle`/`shadow` mismatch (bugs 1–2). Pydantic models (or a pydantic extra="forbid") would have surfaced it. Backend-supported keys `bg_radius`, `bg_padding`, `shadow_offset`, `shadow_color` are unreachable from the UI.
- **W10 — Session cleanup deletes exported outputs.** Export outputs and the ZIP are registered to the tab session (`server.py:822`, `:839`), and `pagehide`/`beforeunload` sendBeacon cleanup (`static/js/session.js`) deletes them. If the browser is closing around the moment of export/download, the file can be removed before the download finishes (404). Consider not session-tracking `outputs/` files, or delaying cleanup.
- **W11 — Export has no per-variation progress/failure isolation** (see bug 13) and no server-side cap on variations beyond the candidate count; 100 candidates would export 100 × 4K images (~3 min at measured throughput).
- **W12 — Render path has no EXIF/colour-management handling beyond base-image `exif_transpose`; stickers are not `exif_transpose`d; `apply_image_enhancements` converts to RGB (alpha dropped, `thumbnail_processor.py:166`) before final save, so a transparent PNG base's alpha is discarded; irrelevant for JPEG/video frames but matters for uploaded PNG photos.

## Recommended fixes (prioritized)

P0 — correctness, small diffs:
1. Rename the JS keys (or the backend reads) so tilt/shadow work: send `rotation`/`shadow_enabled` from `thumbnail.js` (or accept both in `render_thumbnail_patch_text`). One-line each; verify with the angle/shadow test used above.
2. Fix the vignette unit: divide the slider value by 100 in JS (or accept >1 and normalise server-side). Then retune the default (35 → a visible-but-mild 0.35 works: measured mean-abs-diff 14.8 vs max 50.6) and replace the giant blurred inverted-ellipse mask with a proper radial ramp (small blur radius, e.g. `min(w,h)*0.02` + distance-based falloff).
3. Clamp candidate timestamps and capture requests to the last decodable frame: `end = min(duration - 1/fps, ...)` or probe the last frame PTS; retry/fallback to the previous frame (frame 0 fallback already exists in `extract_video_frame`) instead of returning 500 at scrubber max.
4. Add preview request sequencing: increment a `previewToken`, pass it through, drop results whose token is stale; optionally an `AbortController`. Also reduce preview cost (see P1) so 180 ms debounce is meaningful.
5. Guard `extractCandidates` with a generation counter / `AbortController`, disable grid and capture buttons while scanning, and call `renderCandidateGallery()` after any array mutation that can interleave (or rebuild cards from array indexes every time). Add a "scan in progress" state instead of only disabling the rescan button.
6. Don't overwrite `inputEndSec` from the `start` message; only initialise it when the field is empty, and update `intervalRangeLabel` when a custom range is applied. Show a clear error for 0-frame scans (or clamp invalid start/end before calling the API).
7. Dedupe/snap candidate timestamps: generate timestamps, drop ones closer than ~1 frame duration, and cap `count` by available frames; also clamp `count*` (server already caps at 100).

P1 — export/quality:
8. Fix `/api/download` display name: strip only the known generated prefix pattern instead of `split("_", 1)`, or return a proper `Content-Disposition` name from a mapping.
9. Make "All Variations" include the current design (collage/sheet/exact frame) when it isn't a candidate, and adjust the summary text accordingly; alternatively rename the scope to "All candidate frames".
10. Per-item try/except in export + explicit error when `items` is empty; return a 4xx for missing bases so the UI can show a message.
11. Add a lossless path for candidate frames (PNG/raw or `-q:v 1`?) before compositing, or at least correct the "zero quality loss"/"Ultra Quality" copy; keep PNG export as the truly lossless option.
12. Add text autofit: binary-search font size until `patch.width <= canvas_w * 0.92`, or wrap to N lines; clamp rotation-expanded patch. Same for badge boxes.
13. Only offer scale 2 when the source has enough resolution (compare source/crop pixels with target), or label it "4K upscale"; add a "preview quality" (downscaled) mode and render previews at scale 1 while keeping export at 2.
14. Move upload post-processing into the threadpool (`def` endpoint or `run_in_threadpool`) and use ffmpeg/OpenCV only off the loop. (Explicitely verified loop stall of up to 588 ms.)
15. Delete stale generated files when a video is replaced/deleted: remove `cand_*`, `exact_*`, `sheet_*`, `thumb_prev_*` for the media id, and overwrite a stable preview filename per design/hash instead of allocating a new file per render.

P2 — hardening/cleanup:
16. Remove or regenerate the dead sidebar-resizer code (or restore the two HTML elements); delete `isBatchMode`/`stickerPreviewUrl`/`cssAspect`/`intervalRangeLabel` dead paths or wire them up; unify the capture button labels.
17. Validate `text_items`/`stickers` with Pydantic models (extra="forbid") and define the schema in one place shared with the JS payload.
18. Add per-variation progress (stream or polling) for export; cap variations/scale combinations by available memory/CPU.
19. Add regression tests for the compositor matrix (6 ratios × 2 scales, crop centering, text overflow, rotation/shadow/vignette units) — these caught the current bugs in minutes.
20. Consider collapsing the duplicated candidate extraction endpoints into one (the JS never calls `/api/thumbnail/extract-candidates`).

## Architecture notes

- **Two candidate extraction paths.** `extract-candidates` (deterministic, reused filenames) and `extract-candidates-stream` (UUID-prefixed filenames, NDJSON progress) duplicate the same logic; only the stream one is used by the frontend. The non-stream endpoint is dead code that will silently drift. If kept, it should share a single `iter_candidates()` helper and filename policy.
- **Filename policy is content-addressed by accident.** `f"{file_prefix}_f{idx}_{int(ts*1000)}.jpg"` (`thumbnail_processor.py:40`) plus a per-scan UUID prefix in the stream means new URLs per scan; this avoids stale-cache bugs but guarantees disk growth. A cache key of `(file_id, rounded_timestamp, extraction_params)` with overwrite semantics (or a tmp-dir + explicit session cleanup) would be better.
- **Preview renders a full final image server-side per keystroke.** Each preview allocates a 4K RGBA canvas (~33 MB), runs the whole pipeline, writes a JPEG to `thumbnails/`, and returns a URL. This is the root of the preview race, the disk churn, and the 1.4–1.7 s latency. Options: (a) render previews at 960–1280 px and keep 4K only for export (with a "preview is approximate" note), (b) return PNG/binary directly instead of files (no disk lifetime), (c) move compositing to an offscreen canvas in the browser and use the server only for export/final render.
- **Design payload is untyped and duplicated between preview/export.** Two nearly identical payload builders (`thumbnail.js:1181-1220` and `:1344-1384`) are the reason the angle/shadow mismatch went unnoticed and will drift again. A single `buildDesignPayload()` helper plus Pydantic models would remove the class of bug.
- **Sync vs async split is mostly right but inconsistent.** Thumbnail endpoints are sync `def` → Starlette runs them in the anyio threadpool (40 threads); measured responsiveness is good (median 5.5 ms during heavy export). The one async endpoint (`upload_media`) does blocking work and is the outlier. Note a stream request holds a threadpool worker for the full scan (1.7 s for the 125 MB clip), so ~40 concurrent scans could exhaust the pool; `extract-candidates-stream` as a true async generator with `run_in_threadpool` per frame would be more scalable.
- **Shared helpers leak module responsibilities.** `engine/video_processor.py:get_video_info` (OpenCV) is used by the thumbnail pipeline for duration/metadata; its `frames/fps` duration is fine for CFR and for our VFR sample (OpenCV derives fps from frames/duration), but `extract_video_frame`'s frame-index seek is not VFR-safe. The thumbnail flow should prefer ffprobe/time-based extraction for both metadata and the upload preview, matching the candidate/scrubber path.
- **Session cleanup is a blunt instrument.** It deletes every file registered for the tab, including exported outputs and uploaded media, on `pagehide`/`beforeunload` via sendBeacon. It is the only cleanup for generated thumbnails besides the 2-hour janitor. A bounded per-module cache (LRU by design hash) plus explicit "clear media" would be more predictable and avoids the "download 404 at tab close" corner.
- **The compositor itself is in good shape** — crop centering, per-ratio geometry, output dimensions, sticker alpha, and enhancement math verified correct. The main compositor gaps are text autofit and the vignette mask/units; the storyboard rewrite (uncommitted) is a genuine improvement and no longer distorts cells.
- **Testability.** There is no test coverage of the compositor or the endpoint contract; a small pytest matrix (aspect × scale × fit, long titles, vignette units, export ZIP contents/dimensions, single-frame EOF) plus a static payload-schema check would prevent most of the confirmed bugs (1, 2, 3, 8, 9, 13).
