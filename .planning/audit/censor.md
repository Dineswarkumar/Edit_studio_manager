# Censor & Privacy Studio — Audit Report

Scope: `static/censor.html`, `static/js/censor.js`, `engine/censor_processor.py`, censor endpoints in `server.py` (branch `fix/censor-tracking-bugs`, working tree changes present).
Method: static tracing + reproducible probes on a real portrait talking-head video (`BLUR_TEST_1.mp4`, 1080×1920@50 fps) and rendered pages in headless Chrome. Probe scripts and artifacts are in `_audit_tmp/` (not part of the project). No project source file was modified.
Every "observed" figure below was measured in this session; images are linked where useful.

Environment: Python 3.14.7, OpenCV 5.0.0 (`cv2.TrackerMIL` exists, `cv2.legacy` does **not**), NumPy 2.5.1, ffmpeg 9.0.1.

---

## Confirmed bugs

### 1. Preview overlay is misaligned on portrait media (letterbox bug) — mask box does not land on the face
`static/js/censor.js:732-747` sizes the overlay canvas to the `<img>` **element box** (`rect.width/rect.height`) and `:857-858` maps native coords with `canvas.width / activeMedia.width`. The image is `width:100%;height:auto` (`static/censor.html:263`) plus `max-height:calc(100vh - 230px); object-fit:contain` (`static/css/style.css:1028`, wrapper rule `:1027`). When `max-height` clamps the element, `object-fit:contain` letterboxes the bitmap **inside** that box, but the canvas keeps the full element box — so `scaleX` is the element/native ratio, not the visible-content ratio.
Measured in headless Chrome (1440×900 window, app CSS reproduced 1:1, portrait 1080×1920):
- `<img>` element box 972×670, content rect 376.9×670 centred at x-offset 297.6 px
- `censor.js` scaleX = 0.9 vs true content scaleX = 0.349 (2.58× too wide); scaleY happens to be correct (0.349)
- detection box (566,376,323,429) is drawn as 291×386 at x≈509 while the face is really 113×150 at x≈495
- portrait: [`_audit_tmp/letterbox_portrait.png`](../../_audit_tmp/letterbox_portrait.png); landscape is correct: [`_audit_tmp/letterbox_landscape.png`](../../_audit_tmp/letterbox_landscape.png)
Same broken transform is used for pointer→native mapping (`static/js/censor.js:793-816`), so in Objects mode a user-drawn box lands in the wrong place and the exported mask hits the wrong region; in Single-Focus mode clicking a face selects the wrong face. DPR is *not* a bug (backing store = CSS px, so coordinates stay 1:1; only crispness suffers).
Impact: portrait phone/reel videos (the dominant case here) show boxes/metrics unrelated to the mask the backend produced.

### 2. Video export uses a different (smaller) face box than the preview — 43 % of the previewed mask is unprotected in the export
`/api/censor/detect-faces` detects with `padding_percent=0.20` (`server.py:980,985`), so preview boxes are padded. The exporter never passes that padding: `VideoFaceTracker.update` calls `self.detector.detect(frame_bgr)` (`engine/censor_processor.py:329`, default `padding_percent=0.0`) — used for both `faces_all` and `face_single` (`:742,782`). Preview and export therefore mask different rectangles.
Measured on the same frame (frame 80 of the 50 fps clip):
- preview mask bbox x390-923 / y284-958, 14.64 % of the frame
- export mask bbox x466-847 / y396-906, 8.38 % of the frame
- export covers **57 %** of the preview mask; **130,492 px (43.0 %)** that are blurred in the preview are exposed in the export (forehead/cheeks/chin edges)
- [`_audit_tmp/preview_vs_export_f80.jpg`](../../_audit_tmp/preview_vs_export_f80.jpg) (yellow = preview box, red = export box; middle = preview mask, right = export mask)
The export box is also not safe by itself: YuNet's raw box cuts the right cheek/ear (raw right edge 889 vs face ≈940), and `apply_gaussian_blur` only adds 8 %/10 % (bottom 5 %) padding (`engine/censor_processor.py:414-417`).
Impact: "the preview looked protected, the exported file isn't" — exactly the user's complaint.

### 3. Single-Person Focus silently stops masking forever once the track is lost
`process_video` resolves the focused track **once**, from the first frame (`engine/censor_processor.py:746-769`), and the render loop only keeps boxes whose `track_id == resolved_single_id` (`:801`). When the person is not detected for ~15-18 frames the tracker deletes the track (`:394-405`, `lost_count += detection_interval` at `:396`, `max_lost_frames=15` at `:742`). Any re-acquired face gets a **new** track id and is never masked again. The export still returns success because the "no faces detected" guard only fires when *zero* frames were masked (`:856-859`).
Reproduced with a 70-frame synthetic video (15 frames face → 25 frames no face → 30 frames face again):
- `faces_all`: re-masked 30/30 frames after re-appearance
- `face_single`: re-masked **0/30** frames after re-appearance; file exported successfully
- [`_audit_tmp/single_mode_reacquire.jpg`](../../_audit_tmp/single_mode_reacquire.jpg) (src | faces_all | face_single at frames 5/20/50)
Impact: worst-case privacy failure with no warning.

### 4. Multi-Face export ignores per-face enable checkboxes
`static/js/censor.js:978-988` filters **all** `Face` targets out of the API payload for videos, and the server re-detects every face (`engine/censor_processor.py:781-803`). Unchecking a specific face in Multi-Face mode changes only the preview; the exported video masks every detected face.
Expected: enabled state should translate to an explicit box/track allow-list for export.

### 5. Exports with zero targets silently produce an unmodified file
- Image: `server.py:1194` only auto-detects when `mode == "faces_all" and len(boxes) == 0`; if detection finds nothing, `process_image` writes a re-encoded but unmasked file and returns 200.
- Video: the only guard against "nothing masked" is for `faces_all`/`face_single` (`engine/censor_processor.py:856-859`); `objects` and `nsfw` modes export unchanged files.
Measured: Objects mode with `custom_boxes=[]` on a 152-frame clip → HTTP-equivalent success, 152/152 frames unchanged.
Expected: refuse to export / confirm with the user when no mask would be applied.

### 6. Partial output file is left on disk when the encoder fails mid-export
`engine/censor_processor.py:842-847` (`finally`) closes `cap` and `encoder.stdin` but performs **no cleanup on the exception path**. Only the `encoder.wait() != 0` path deletes the output (`:849-854`) and only the no-face path (`:856-859`). Simulating an encoder pipe failure after it had already created the container left a 2,048-byte partial `.mp4` in `outputs/`; the job is marked `failed` (`server.py:1112-1117`) and the file survives until the 2-hour janitor (`server.py:98-117`).
Expected: `os.remove(output_path)` when the encode did not complete successfully.

### 7. Custom PNG sticker path: a JPG sticker silently masks nothing
UI accepts `accept="image/*"` (`static/censor.html:350`), the upload endpoint accepts any extension and stores it as `logo_<id>.<ext>` (`server.py:364-380`), but `apply_emoji_overlay` requires a 4-channel image and returns the untouched frame for JPG/opaque stickers (`engine/censor_processor.py:496-498`). Verified: JPEG custom sticker → **0 changed pixels**, preview looks unchanged, no error is shown. There is also no size/aspect validation, and the sticker is stretched to the face box (see weakness "emoji aspect").
Expected: convert to RGBA (or paste as rectangle with alpha=1), validate min size, reject animated/unsupported files with an explicit error.

### 8. EXIF-rotated photos: media dimensions come from PIL (raw) while every mask/detect path uses cv2 (EXIF applied)
`server.py:249-250` stores `width,height` from `PIL.Image.size` (raw pixel matrix). Censor frame reading uses `safe_imread` → `cv2.imdecode` / `cv2.imread` (`engine/censor_processor.py:26-38`), and OpenCV 5.0 applies EXIF orientation by default; `_read_censor_frame` (`server.py:882-889`) and the export use that rotated frame. Verified with an orientation-6 JPEG: uploaded metadata 1200×1600 (W×H) but decoded preview/detection frame is 1600×1200. Consequences:
- `censor.js` overlay scale (`activeMedia.width/height`, `static/js/censor.js:854-858`) is transposed relative to the displayed preview ⇒ boxes wrong on phone photos
- user-drawn Object/NSFW boxes are stored in the metadata space but applied in the cv2 space ⇒ wrong region is masked in the export
- dimension badge (`static/js/censor.js:512`) is wrong, and the other studios' `preview_base` (PIL, unrotated) shows a different orientation than the censor preview (cv2, rotated)
Expected: one decode pipeline (e.g. `cv2.imdecode` with `IMREAD_IGNORE_ORIENTATION` + explicit `exif_transpose`) and use its dimensions/thumbs everywhere.

### 9. Video `detect-faces` is not tracker-based; IDs are meaningless; helper for tracked IDs is dead code
`api_censor_detect_faces` (`server.py:968-994`) detects a single decoded frame and assigns `track_id = idx + 1` in YuNet's arbitrary detection order (`:981-987`). That ID is not the ID any export run assigns (`VideoFaceTracker.next_track_id`). `_detect_tracked_faces_at_time` (`server.py:909-930`), which exists exactly to make preview IDs match export IDs, has **zero call sites** (verified by grep) — dead code. The frontend relies on those unstable IDs to keep the focused person across scans (`static/js/censor.js:555-577`, `:571-574`) ⇒ in Single mode, re-scanning after a scrub can select a different person.
Also, each call decodes the requested video frame **twice** (read at `server.py:979/984` and again at `:988`): measured 92-168 ms wasted per scan at 1080×1920 on top of 25 ms of detection.
Expected: use `_detect_tracked_faces_at_time` (or an explicit tracker pass) so IDs are stable, and decode once.

### 10. Closing the export modal during video processing permanently locks the studio
`closeModal` (`static/js/censor.js:1140-1144`) clears the poll interval but never calls `setExportBusy(false)`, and the header Export/Detect buttons stay disabled by `syncMediaActionButtons` (`:1152-1161`). The server keeps rendering in a daemon thread (`server.py:1226-1243`); the user has no progress, no download, and cannot start another export without reloading.
Expected: cancelling/closing should clear the busy state and either poll in the background or kill the job (currently no cancel endpoint exists).

### 11. Video object tracking drops to "never mask again" when the MIL track fails
`engine/censor_processor.py:805-817`: `if ok: ... active_frame_boxes.append(...)` — when `tracker.update()` returns `False` (MIL drift/occlusion) no mask is emitted for that frame **and the tracker is never re-initialised**, so from then on the object is unprotected for the rest of the export. Same for `_create_object_tracker` returning `None` (`:735-737` silently `break`s and falls back nowhere in `specific_object` mode). Preview cannot show this because tracking is not previewed.
`cv2 5.0.0` reality: `TrackerMIL`/`TrackerDaSiamRPN`/`TrackerNano`/`TrackerVit` exist, `cv2.legacy` does not; `_create_object_tracker` (`:869-884`) therefore always resolves to **TrackerMIL**, the slowest/least accurate option — measured init 67 ms, **update 159 ms/frame at 1080×1920** (≈5 fps just for tracking; a 5,200-frame 50 fps clip ≈ 828 s of tracking alone).
Expected: re-detect or re-init after N failed updates, mask the last-known box while unclear, and use a newer/smaller tracker (`TrackerNano`/`DaSiamRPN`) or periodic re-detection.

### 12. Eyes-only region is not applied to user-drawn "Custom Face" boxes
`engine/censor_processor.py:582` enables the eye-region crop only when `box.label.lower().startswith("face")`. Auto boxes are labelled `Face`, but boxes drawn by the user in Faces mode are labelled `Custom Face #n` (`static/js/censor.js:807`) → they are masked as a full box even when the user selected "Eyes Only". Verified by label inspection (`startswith` fails).
Expected: test `label` for both `face` and `custom face`, or carry an explicit target kind.

### 13. NSFW "sensitivity" has inverted semantics in the UI
`engine/censor_processor.py:280`: higher `sensitivity` increases `min_area` (`0.008 + sensitivity*0.04`), i.e. **fewer** candidates. The UI labels 0.8 as "Strict (80 %)" and the code comment says "stricter screen", which is defensible, but the control is called "Sensitivity Threshold" and users will read higher = more detections. Low (0.3) already allows 2 % of the frame; Strict allows 4.8 %.
Expected: rename to "Strictness" and document direction, or invert the mapping.

### 14. NSFW scan results are static boxes attached to the whole video
`server.py:821-823` recomputes candidates per frame in `nsfw` mode, but `engine/censor_processor.py:825-826` then also applies any client `custom_boxes` to **every** frame (`if custom_boxes and mode != "specific_object"`). Manual "NSFW Zone" boxes and any object box present are therefore frozen for the full duration. Combined with the false positives below this produces large, drifting, frame-long blurs.
Expected: time-scoped targets (`reference_frame_sec` is already recorded by the client at `static/js/censor.js:818` but never used by the server).

---

## Quality & algorithm weaknesses

### Blur is a downscale-blur (pseudo-pixelation), not a Gaussian blur; the app default is not anonymising
`apply_gaussian_blur` (`engine/censor_processor.py:412-448`) resizes the ROI to `keep_ratio = 0.025 + (1-strength)*0.15` (2.5-17.5 % of the ROI, `:427-432`), applies only a 3×3 Gaussian, then upscales with `INTER_CUBIC`. For a 323×429 face that is a 9×12 → 59×78 px proxy. Measured/observed:
- Intensities 1-100 are monotonic (keep 17.35 %→2.5 %) but the range is compressed: the slider minimum (10, `static/censor.html:331`) is already a 6.25× downscale; there is no subtle-blur setting.
- At the app default 60 the face is still recognisable (eyes, brows, beard shape); only ~100 reads as anonymised. YuNet still re-detects the blurred face at **0.94 / 0.935 / 0.853** confidence for intensity 10/60/100 (`_audit_tmp/mask_gallery.jpg`).
- "Gaussian blur" output looks like smoothed pixelation; the visual result doesn't match the control name.
- The oval feather is effectively broken: the ellipse is drawn with radii exactly half the mask size (`:435-438`), so the alpha reaches 1.0 at the ROI edge midpoints (measured top/bottom row max alpha = 1.00, corners 0.00). Outside the ROI the alpha jumps from 0 to 1 — a hard rectangular seam with rounded corners. `blur100` shows the straight top/bottom boundary (`_audit_tmp/blur100_edgecrop.jpg`, difference map `_audit_tmp/blur100_diff.jpg`).
- ROI padding is asymmetric: 8 % horizontal, 10 % top, 5 % bottom (`:414-417`) — combined with the tighter export boxes this exposes forehead/chin edges.

### Pixelate mapping is far too aggressive after ~50 %
`apply_pixelate` (`engine/censor_processor.py:451-478`): `block_size = max(3, int(min(w_roi,h_roi) * (0.06 + strength^1.5*0.62)))` (`:463`), so block size is a percentage of the *face*, not a pixel size. For a 323×429 face (373×492 ROI): intensity 10 → 29 px (12×16 blocks), 50 → 104 px (3×4), **60 → 129 px (2×3 blocks), 100 → one flat block**. The slider therefore spends its upper half in "solid colour" territory. Upscale is `INTER_NEAREST` from a non-integer grid (`:468-469`), so block widths alternate by ±1 px; the oval has no feather at all (`:471-474`), leaving a hard ellipse edge. Blocky output also destroys YuNet detections (0 faces at intensity 10-100), i.e. pixelate is *more* privacy-effective than blur at equal label values.

### Emoji overlay: aspect ratio is thrown away, and the "emojis" are hand-drawn placeholders
`apply_emoji_overlay` (`engine/censor_processor.py:481-537`) resizes the sticker to exactly `(box.w*1.1, box.h*1.1)` (`:500-506`), ignoring the intrinsic aspect. Measured on real faces:
- built-in 256×256 stickers stretched to a 0.75 W/H face box ⇒ x-scale 1.39, y-scale 1.84 (visibly tall oval; `_audit_tmp/emoji_aspect_compare.jpg`)
- Eyes-only mode: eye box ≈ 2.9:1, so a square emoji is squashed to 0.34× height
- custom 512×128 banner forced to 355×471 ⇒ 3.7× vertical stretch, aspect distortion 5.3× (`emoji_custom_wide_asused.jpg` vs correct fit `emoji_custom_wide_aspectfit.jpg`)
- `INTER_AREA` is used for upscaling (`:506`), which behaves like nearest/box — blocky edges on large faces; no rotation/alignment to eye landmarks ("sunglasses" is centred on the face box, not on the eyes); the sticker covers the whole face box, which is probably why it looks wrong versus a "glasses over eyes" expectation.
- The bundled stickers are crude Pillow drawings (`tools/generate_emojis.py:8-131`, flat ellipses/polygons), so the output doesn't match the native emoji glyphs shown in the picker UI (`static/censor.html:338-346`). The sunglasses sticker is itself face-shaped and YuNet still detects a face in the masked output (0.40) — harmless for privacy, but a hint that the overlay isn't a "glasses" overlay at all.

### Face detection: 960 px cap, low threshold and no temporal/geometry filtering
`FaceDetector.detect` (`engine/censor_processor.py:155-249`): any frame with `max_dim > 1080` is downscaled to 960 (`:169-178`) — this includes **all 1080p media** (inference runs at 960×540), not just 4K as the docstring claims (`:157-161`). Consequences measured:
- 4K: 9/10 synthetic faces found (down to ~60 px native) vs native-resolution YuNet finding all 10 small faces including 20×27 px (`_audit_tmp/smallfaces_4k.jpg`); the 8×4 px after downscale ones are lost.
- 1080p: faces down to ~24 px native are still found (24 px → 12 px inference, conf 0.79), so 1080p is mostly OK.
- score threshold 0.35 (`:135-153`) plus no min-size/aspect check yields false positives on non-face content: on real B-roll, YuNet returned "faces" at 0.377 on a phone screen, 0.58 on a thumb/phone, 0.605 + 0.535 on hands and a game HUD (`_audit_tmp/fpcheck_t002.jpg`, `fpcheck_t090.jpg`). In `faces_all` export these become random blurred rectangles.
- low light: at 35 % brightness a 37×45 px face (conf 0.58 at normal exposure) is no longer detected; profile faces/partial faces are simply missed (threshold-only).
- the asymmetric padding `pad_h*1.1` top / `pad_h*0.5` bottom (`:214,216`) makes the padded box centre sit ~26 px above the raw box centre (frame 80) and biases the mask upward, while `apply_gaussian_blur` then adds more top than bottom padding — bottom/chin margin is the smallest of the four sides.
- nested-duplicate suppression (`:233-248`) is wrong in one direction: it drops the **lower-confidence** box whenever ≥68 % of the *smaller* box is contained, so a high-confidence small false box can suppress the larger true face.

### Tracker staleness / ghost masks
`VideoFaceTracker` (`engine/censor_processor.py:312-407`): detection runs only when `frame_idx % 3` (`detection_interval=3`, `:320-327`), boxes are held between detections and EMA-smoothed with `alpha=0.7` (`:359-364`). On the real clip (face present frames 0-99) coverage of the true face was ≈1.0 (the mask is padded), so static talking heads are fine — but:
- after the face disappears/scene cut at frame 100 the stale boxes kept masking the product B-roll until frame 116 (**17 frames ≈ 0.34 s**) because lost tracks are still emitted (`:394-402`).
- 3-frame interval is fps-relative: at 24 fps that is 125 ms between detections plus smoothing lag on fast motion; the comment at `:325-326` only justifies 50 fps.
- match gate `iou > 0.10 or dist < 0.22` with final `best_score > 0.12` (`:348-354`) can leave a detection unmatched while its track stays alive ⇒ duplicate tracks/new IDs (ID churn), which is also what breaks Single-Focus (bug 3).
- track IDs are monotonic (no reuse) — that part is fine.

### NSFW "detection" is a skin-colour blob detector, and it fails both ways on ordinary content
`detect_nsfw_candidates` (`engine/censor_processor.py:252-309`): YCrCb `(0,133,77)-(255,173,127)` AND HSV `(0,35,60)-(25,200,255)`, morphological open+dilate, contours ≥ `total_area*(0.008+sensitivity*0.04)`, aspect 0.25-4.0, skin ratio ≥ 42 %.
Measured false positives:
- a completely normal clothed talking-head frame → **2 candidates covering 25 % of the frame**: the face + beard region (conf 0.68) and the phone/hand/arm region (conf 0.51) — [`_audit_tmp/nsfw_on_face.jpg`](../../_audit_tmp/nsfw_on_face.jpg). In `nsfw` export mode this blurs the face/neck and hands every frame.
- synthetic skin-toned backgrounds (wood wall, oak, sand/beach, beige wall, plain skin-tone fill) each produce **one candidate covering 100 % of the frame** ⇒ export masks the entire video.
Measured false negatives:
- exposed-skin patches of 80×80…200×200 px on a dark background (0.3-1.9 % of a 1080p frame) → **0 candidates**; only 260×260 (3.3 %) is detected. Partial nudity / mostly-clothed images with limited exposed area are missed by construction (`min_area`).
- shadowed dark skin is excluded (whole-frame fill BGR (30,40,60) → 0 candidates) because the HSV V ≥ 60 bound; medium/dark tones (V ≥ 80) are accepted.
- per-frame cost 38.7 ms at 1080×1920 ⇒ ~201 s for a 5,200-frame clip in `nsfw` mode, plus masking.
A proper local solution: a trained detector/classifier (e.g. NudeNet ONNX detectors — YOLO-style, 320-640 px input, small model files; or a whole-image classifier such as opennsfw2, MIT-licensed, Keras/TF, ~24 M params) run through onnxruntime on CPU. Expect ~20-100 ms/frame at 640 px with 4 threads for a nano detector; a classifier only gives one score per frame and cannot localise. Verify the model's licence before bundling (NudeNet's repository is AGPL-3.0; opennsfw2 is MIT). The current heuristic cannot be "tuned" into a classifier — exposure semantics (genitalia/breasts) are not colour regions.

### Encoding / A-V handling in the video export
`process_video` builds a one-pass ffmpeg pipe (`engine/censor_processor.py:709-719`): rawvideo in, `libx264 -preset ultrafast -crf 20`, `-map 0:v:0 -map 1:a:0?`, `-c:a aac -b:a 192k`, `-movflags +faststart`.
Verified on a 3 s 1080×1920 clip with AAC stereo:
- output: 152/152 frames, 50 fps, AAC 2ch, duration 3.04 s ⇒ **audio mapping works for the common case**
- audio is always re-encoded (AAC→AAC generation loss, 192 kbps); only the **first** audio track is mapped; other audio tracks, subtitles/data streams and metadata are dropped (no `-map_metadata`, no `-c:a copy` fast path, no `-shortest`)
- odd sizes work: 641×481 source → 642×482 output (the `pad=ceil(iw/2)*2` filter, `:715`)
- rotation: OpenCV 5.0 auto-applies display rotation (checked 90/-90/180: decoded frame dims always equal `get_video_info`'s reported dims), so the raw-video path produces physically rotated frames and the output looks correct (`480×640` for a 90° source) even though the rotation side-data is not copied. So rotation is **not** visually broken; only metadata is lost.
- `-preset ultrafast` produces very large files (3 s portrait clip = 7.6 MB ≈ 20 Mbps) and is not configurable; there is no quality/format control in the censor UI.
- throughput measured 15.2 fps for 1080×1920 on this machine (≈5.7 min for that 104 s 50 fps source) — detection is not the only cost (encode + pipe).

### Server-side preview cost
`/api/censor/preview` (`server.py:996-1068`) decodes the full native frame (`:1004`), runs detection-free mask application (`:1032`) and JPEG-encodes the full-resolution image to `THUMBS_DIR` on **every** slider/box change (`:1034-1037`), then writes revision bookkeeping and deletes the previous file (`:1038-1062`). Measured decode-excluded cost: 35 ms @1080p, 82 ms @4K per preview, plus a full-size JPEG (277 KB / 711 KB) over HTTP. With a 160 ms debounce (`static/js/censor.js:895`) this is usable at 1080p but sluggish at 4K and it thrashes the disk. The revision dedupe can also return a URL to a file it just deleted in a race (`server.py:1043-1067` returns `preview_url` even when `accepted == False`), producing intermittent broken previews.

### Frontend state/race issues
- `detectFaces`/`detectNsfw` (`static/js/censor.js:535-590`, `:593-637`) have no request token/AbortController, unlike `fetchLivePreview` (`:900,929`). Auto-detect on upload plus a user "Scan Current Frame" click (or switching mode mid-scan) can apply stale results; also `syncMediaActionButtons` can re-enable buttons while a scan is running.
- The scrubber only calls `schedulePreview()` (`:277-282`) — it never invalidates or re-detects targets, so the mask at t=3 s is derived from boxes detected at t=0 (Lead independently confirmed this: chest/phone masked, face exposed). Targets carry no time validity; `reference_frame_sec` is recorded only for drawn boxes (`:818`) and never sent.
- `exportBusy` modal-close lock (bug 10); no cancel endpoint.
- Slider/emoji/mask changes each create a history entry (`scheduleHistoryRecord` from `schedulePreview`, `:891-896`) so the undo stack is polluted by slider drags/scrubs.
- DPR: canvas backing store is CSS pixels (`:743-744`) — no coordinate error, but blurry 2 px lines on HiDPI screens.
- No JSON schema/field-name mismatches found: every field `censor.js` sends exists on `CensorMaskConfigModel`/`CensorPreviewRequest`/`CensorProcessRequest` (`server.py:858-949`) and vice versa. Two unused-parameter notes: `MaskConfig.padding_percent` (`engine/censor_processor.py:105`) is unreachable from the API (always 0.20), `CensorDetectRequest.sensitivity` is accepted by `detect-faces` but ignored (`server.py:877-880,969`).
- No event-listener leaks found: all listeners and the `ResizeObserver` are attached once in `initStudio`/`initCanvasDrawing`; re-rendered target rows attach listeners to fresh nodes only.

### Test coverage gaps
`test_censor.py` (225 lines) and `test_censor_api.py` (221 lines) are smoke/unit tests on synthetic faces. They never assert preview-vs-export parity, portrait letterbox scaling, single-focus re-acquisition, EXIF orientation, or NSFW false positives/negatives — which is why these bugs survive. They also keep calling the all-legacy API, so `cv2.legacy` absence can silently go unnoticed (`_create_object_tracker` fallback masks it).

---

## Recommended fixes (prioritized)

**P0 — privacy correctness (user-visible "mask not on face / not protected")**
1. Make preview and export consume the **same box list**: pass the preview padding into `VideoFaceTracker`/`detector.detect(..., padding_percent=0.20)` for export (or, better, drop the detection-time padding and pad once inside `apply_masks_to_frame`). Add a parity test asserting preview mask ⊆ export mask for every frame.
2. Single-Focus: re-associate the focused identity every detection cycle (IoU against the last focused box + optional face embedding), or re-resolve by `selected_face_box` whenever the old track disappears; never finish an export with the focused target lost — fail or warn instead of silently exporting.
3. Fix the overlay transform: compute the `object-fit: contain` content rect (`naturalWidth/Height` vs element box), position the canvas over that content rect (or remove `max-height` clamping and let the wrapper scale with the image), and use `contentScale` for drawing **and** pointer→native conversions. Add a portrait letterbox case to the browser tests. Also encode DPR (`canvas.width = cssWidth*dpr`, `ctx.setTransform(dpr,0,0,dpr,0,0)`).
4. Fix EXIF: one orientation-normalised decode (`cv2.imdecode(..., IMREAD_IGNORE_ORIENTATION)` + `PIL.ImageOps.exif_transpose` or `cv2.imread` result) used for upload dimensions, previews, detection and export; make all studios agree on orientation.
5. Blur: implement a real blur that fades to zero at the ROI edge — pad the ROI, draw the ellipse inset by 2-3σ, `GaussianBlur(mask, ksize≈4σ)`, and clamp composite edges; raise the minimum usable anonymity (e.g. map intensity to sigma in ROI pixels, ensure ≥8×8 px downsample at max) so the default intensity is actually safe; add a quantitative privacy test (YuNet/ArcFace re-identification on the masked output must fail).
6. Multi-face export must honour the enabled list (send explicit per-target boxes/track ids, or selected ids).
7. Guard zero-target exports (image/objects/nsfw): return an error/`needs_confirmation`, not an unchanged file; and delete partial outputs in a `finally` block on any failure.
8. Custom sticker: normalise any uploaded image to RGBA, validate dimensions, reject unsupported formats with a visible error; preserve aspect ratio (see P1).

**P1 — quality**
9. Pixelate: block size in absolute pixels (e.g. 8-40 px scaled by face size) with integer-aligned blocks, `INTER_NEAREST` down/up, feathered rect/oval; cap at something face-recognisable-but-not-readable rather than one solid block.
10. Emoji: preserve sticker aspect (`s = min(boxW/sw, boxH/sh)`, optional user scale), align "eyes" stickers to eye landmarks when `mask_region=="eyes"`, support JPG stickers, replace hand-drawn stickers with real emoji assets (Twemoji/Noto Emoji, CC-BY 4.0) or render glyphs with Pillow; fix `INTER_AREA` upscaling to `INTER_CUBIC/INTER_LINEAR`.
11. Face detection: run at native (or ≥1080 px longest side) for stills and at ≥1280 px for video where speed allows; lower false positives (score threshold 0.5-0.6 for export, min face size ≥0.5 % of frame width, aspect/landmark sanity, reject detections whose landmarks are not face-like); fix nested-suppression to drop only the smaller box; test profile/low-light faces.
12. Video tracking: make `detection_interval` time-based (e.g. re-detect every 66 ms), re-detect at scene cuts (frame-difference), shrink `max_lost_frames`/hold to ~3-5 frames, and re-init failed object trackers or fall back to per-frame re-detection (`TrackerNano`/`DaSiamRPN` available in cv2 5.0; MIL is too slow).
13. NSFW: replace the heuristic with a trained ONNX detector (NudeNet or equivalent) run through `onnxruntime` + `CPUExecutionProvider`; classify per frame, localise with boxes, exclude face masks; keep the current heuristic only behind a clearly-labelled "skin-region highlight" tool that never auto-masks video. Document model licence in `README`.
14. Video export: configurable preset/crf (default `veryfast`/23), `-c:a copy` when the source codec is AAC/MP3, map all audio tracks, `-map_metadata 0`, `-shortest`; add `-map 0:a?` fallback when there is no audio; progress based on encoded frames; cleanup on every error path.
15. Preview: render at a display-sized proxy (e.g. max 1280 px) for the interactive preview and only use native resolution for the final export preview/compare; cache the decoded frame per (file, frame_sec); return 4xx instead of a stale URL when a preview revision is rejected.
16. Frontend: add request tokens/AbortController to scans, re-detect or invalidate targets when the scrubber changes (show "targets are from t=X, re-scan"), disable all mode/style controls while exporting, make modal close cancel rather than lock, and de-duplicate history entries for continuous sliders.

**P2 — engineering**
17. Replace `_audit_tmp`-style ad-hoc probes with automated regression tests: preview/export mask parity, letterbox transform, EXIF orientation, single-focus re-acquisition, NSFW false-positive/false-negative fixture set (clothed portrait, beach, wood wall, dark skin), odd dimensions, audio/rotation preservation.
18. Remove dead code / unused parameters (`_detect_tracked_faces_at_time` either used or deleted, `mask_config.padding_percent` exposed or removed, `sensitivity` on `detect-faces`).
19. Make the shared `CensorProcessor` truly thread-safe/stateless per request: the singleton detector's mutable `setInputSize` is serialised by a lock (`engine/censor_processor.py:180-185`), so a 4K preview and a 1080p export serialise every detection and thrash the model input size. Prefer one detector per worker/export job or an inference pool.

---

## Architecture notes

- **Two independent masking pipelines** are the root cause of most "preview lies" bugs. Preview = `detect-faces` (padded boxes) → client boxes → `/api/censor/preview` → `apply_masks_to_frame`. Export = fresh `VideoFaceTracker` (unpadded boxes, different IDs, different temporal behaviour) → `apply_masks_to_frame`. There is no shared "mask plan". Recommended: define a serialised `CensorPlan` (targets with time ranges + mask config + detection parameters) on the client; both preview and export execute `plan → frame masks` through one server module, and add a parity test.
- **Target timing** is missing: boxes are timeless. Add `start_sec/end_sec` (or "whole clip") to every target; the client already records `reference_frame_sec` for drawn boxes but never uses it. A static box is a legitimate feature (fixed redaction) but must be explicit, not the accidental default for every mode.
- **Video pipeline** is a sensible single-pass rawvideo→ffmpeg design; the gaps are quality settings, cleanup on error, track re-acquisition, and copy-vs-reencode decisions for audio/metadata. Rotation is handled by cv2 5.0 auto-rotation; if the app ever pins an older OpenCV or a frame source without auto-rotation, it must normalise display matrix itself and copy rotation metadata to the output.
- **OpenCV 5.0 contrib reality**: `cv2.legacy` is gone; only MIL/DaSiamRPN/Nano/Vit trackers are present. MIL at 159 ms/frame on a portrait 1080×1920 frame makes object tracking impractical at scale; use Nano/DaSiamRPN or per-N-frame re-detection.
- **NSFW cannot be a colour heuristic.** A proper local solution needs a small ONNX detector/classifier (trained network, 320-640 px input, onnxruntime CPU, ~tens of ms/frame) and a review UI; the present feature should be renamed "skin-region highlighter" and excluded from automatic video export. Verify the chosen model's licence before shipping (NudeNet repo is AGPL-3.0; opennsfw2 is MIT), and note the model file size/licence in `README`.
- **Shared singleton processor**: one `CensorProcessor` serves all previews and exports; detection is serialised by an RLock on `FaceDetectorYN.setInputSize`, and preview/export alternate input sizes constantly. For concurrent use (several tabs exporting) prefer a detector instance per job or a small inference pool.
- **Test strategy** should be fixture-driven and numeric: assert mask coverage ratios (IoU/coverage of the true face by the applied mask), id stability across frames, A/V stream properties, and orientation; the current smoke tests cannot catch any of the P0 regressions.
- Evidence artifacts (not shipped): `_audit_tmp/letterbox_portrait.png`, `_audit_tmp/letterbox_landscape.png`, `_audit_tmp/preview_vs_export_f80.jpg`, `_audit_tmp/single_mode_reacquire.jpg`, `_audit_tmp/mask_gallery.jpg`, `_audit_tmp/blur100_edgecrop.jpg`, `_audit_tmp/blur100_diff.jpg`, `_audit_tmp/emoji_aspect_compare.jpg`, `_audit_tmp/emoji_custom_wide_asused.jpg`, `_audit_tmp/nsfw_on_face.jpg`, `_audit_tmp/fpcheck_t090.jpg`, `_audit_tmp/smallfaces_4k.jpg`, `_audit_tmp/smallfaces_1920.jpg`.
