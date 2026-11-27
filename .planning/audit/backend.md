# Backend / platform audit — Media Studio Pro (`T:\Mods\watermarkmaker`)

Branch `fix/censor-tracking-bugs`, uncommitted changes present. Audit date 2026-11-11.
READ-ONLY audit: no project/test file was edited. Scratch scripts/logs live in `_audit_tmp/backend/`
(untracked). The only intended write is this report.

Environment verified: Python 3.14.7, cv2 5.0.0, numpy 2.5.1, Pillow 12.3.0, FastAPI 0.141.1,
uvicorn 0.52.1, ffmpeg 9.0.1, pymupdf 1.28.2 (used lazily by the PDF compressor). Server for probing:
`python -m uvicorn server:app --host 127.0.0.1 --port 8000` (port was free; 8137 was not needed).
All started servers were killed; port 8000 verified free afterwards. No `../` traversal was possible
via URL-encoded forward slashes, but Windows backslash traversal and absolute-drive paths **are** possible.

---

## Confirmed bugs

1. **Arbitrary filesystem read via download routes (critical).** `server.py:545-553`
   (`/api/download/{filename}`), `server.py:573-585` (`/api/thumbnails/{filename}`,
   `/api/uploads/{filename}`) do `os.path.join(DIR, filename)` with the raw path parameter and then
   `FileResponse`. On Windows `\` is a separator and a drive-letter path is absolute, so
   `os.path.join()` escapes the directory. Starlette's `{filename}` regex `[^/]+` only blocks `/`.
   Verified with raw HTTP requests (`http.client`, percent-encoded, not normalized by requests):

   | request | result |
   |---|---|
   | `GET /api/download/..%5Cserver.py` | `200`, 50,934 bytes = `server.py` source |
   | `GET /api/thumbnails/..%5Cserver.py` | `200`, 50,934 bytes = `server.py` |
   | `GET /api/uploads/..%5Cserver.py` | `200`, 50,934 bytes = `server.py` |
   | `GET /api/download/C:%5CWindows%5Cwin.ini` | `200`, 92 bytes = `C:\Windows\win.ini` |
   | `GET /api/download/T:%5CMods%5Cwatermarkmaker%5CREADME.md` | `200`, 2,544 bytes |
   | `GET /api/download/..%5Ctest_data%5Csample.jpg` | `200`, 13,778 bytes |
   | `GET /api/download/..%2F..%2Fserver.py` | `404` (encoded `/` is decoded before routing, no match) |

   => any existing file readable by the server process (secrets, SSH keys, other projects, whole disk).
   Same class in body/JSON filename fields that are joined and opened:
   `server.py:718` (`frame_filenames` -> `THUMBS_DIR`), `server.py:753-755` and `801-803`
   (`base_image_filename(s)`), `server.py:1007-1010` and `1140-1144` (`custom_sticker_filename`).
   Verified `POST /api/thumbnail/preview {"base_image_filename":"..\\server.py"}` reaches the file and
   fails only at PIL decode (plain `500`, no data returned); an absolute path to a real image would be
   read/rendered.

2. **No extension allow-list on uploads -> stored XSS / arbitrary file hosting (high).**
   `server.py:226-235` saves `{uuid8}_{basename}` with any extension; `server.py:364-380`
   (`/api/upload-watermark-logo`) takes the extension straight from the client filename; both are served
   by `FileResponse` (`server.py:580-585`), which sets Content-Type from the extension.
   Verified: uploading `evil.html` -> `GET /api/uploads/71ad1ca6_evil.html` returned
   `200 text/html; charset=utf-8` with `<script>alert(document.domain)</script>` intact; uploading
   `x.svg` to the logo endpoint returned `200 image/svg+xml` with `<script>` intact. Executed same-origin
   at `http://127.0.0.1:8000`, that script can read/delete every uploaded file via the unauthenticated API
   (and the server may be LAN-exposed, see #13).

3. **CORS is wide open and reflects arbitrary origins with credentials (high).** `server.py:54-60`
   (`allow_origins=["*"]`, `allow_credentials=True`, all methods/headers). Verified:
   `OPTIONS /api/media` with `Origin: http://evil.example` -> `Access-Control-Allow-Origin:
   http://evil.example`, `Access-Control-Allow-Credentials: true`,
   `Access-Control-Allow-Methods: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT`; plain `GET` with the same
   Origin also echoed it. Any web page the user visits can read `/api/media`, download/delete files, start
   exports, or call `/api/session/cleanup` against this localhost server (browser Private-Network-Access
   rules are the only, partial, mitigation).

4. **Session cleanup/trust: no authorization, cross-tab deletion, global delete (high).**
   `server.py:339-362` trusts `session_id` from the request body; there is no ownership check.
   `register_session_file` stores uploads/thumbs by session (`server.py:73-77`), and
   `GET /api/media` (`server.py:311-313`) returns every client's media **including `session_id`**
   (`server.py:303`). Verified: uploaded with `session_id="tab_probe_victim_*"`, then a *different* client
   POSTed `{"session_id": <victim>}` to `/api/session/cleanup` -> `{"status":"cleaned","cleaned":3}`,
   victim file deleted and media entry removed. Also `DELETE /api/media/{file_id}` (`server.py:315-337`)
   has no session check at all -> `200 {"success":true}` from any client for any tab's file.
   Tab ids are `tab_` + `Math.random().toString(36).slice(2,10)` + `Date.now()`
   (`static/js/session.js:5`), not cryptographic.

5. **Batch-export outputs are orphaned on tab close; batch jobs are not tracked as active.**
   `process_batch_worker` (`server.py:450-519`) never calls `register_session_file()` for its output files,
   and `session_active_jobs` is only incremented for censor *video* jobs (`server.py:1222-1224`), not for
   `/api/process` jobs. Verified: 2-image batch under `session_id=tab_probe_orphan_*` ->
   cleanup returned `{"status":"cleaned","cleaned":6}`, inputs deleted, but
   `outputs/f4e3ca15_watermarked_orphan0.jpg`/`_1.jpg` remained and were still downloadable via
   `/api/download/...` (only the 2-hour janitor will remove them). A ~6 s video batch export was in
   flight when cleanup was called and it was **not** deferred: `200 {"status":"cleaned","cleaned":3}`.
   (Positive: censor video cleanup *is* deferred correctly — verified
   `{"status":"cleanup_deferred_until_export_finishes","cleaned":0}`, files removed after `finally`.)

6. **`sendBeacon` cleanup also fires on intra-site navigation and reload, not just tab close.**
   `static/js/session.js:31-32` registers the same handler on `pagehide` **and** `beforeunload`; the id is
   kept in `sessionStorage` (`session.js:5`), which survives reload/navigation and is *copied* when a tab
   is duplicated. So moving between `/watermark.html` and `/thumbnail.html` in the same tab, reloading
   during a long export, or duplicating a tab can delete the shared session's uploads while still in use
   (call itself succeeds even with nothing to clean, and the cleanup request is accepted twice per page
   unload; second returns `cleaned:0`). Verified endpoint behaviour; the trigger semantics are from
   `session.js`.

7. **Async upload handlers block the event loop with CPU/ffmpeg work.** `server.py:220-309`
   (`upload_media`, also used by `/api/compress/upload` at `server.py:202-212`) is `async def` but does
   `shutil.copyfileobj`, PIL open/thumbnail/JPEG-compress and `get_video_info`/`extract_video_frame`
   (ffmpeg subprocess) inline with no `await`/thread offload. Measured: baseline `GET /api/media`
   21.3 ms; during a 32 MB image upload (767 ms handler) a concurrent `GET /api/media` took **634.5 ms**
   and only one probe completed during the whole upload. By contrast the heavy handlers declared `def`
   (`/api/preview`, `/api/process`, `/api/thumbnail/*`, `/api/censor/*`) are threadpool-offloaded:
   two concurrent thumbnail exports and `GET /api/media` gave max 25.9 ms — that part is fine.
   (`/api/compress/upload` also blocks because it `await`s the blocking `upload_media`.)

8. **Background jobs never expire; job/status data is unbounded and leaks absolute paths.**
   `jobs: Dict[str, dict] = {}` (`server.py:63-64`) is only ever written, never popped/deleted
   (grep: no `jobs.pop`/`del jobs`). `/api/job/{id}` and `/api/job-status/{id}` (`server.py:538-543`)
   return the live dict forever. Censor jobs store `input_path`/`output_path` (`server.py:1212-1220`) and
   those absolute paths are serialized to any client — observed payload:
   `{"job_id":"6268e8c9","status":"in_progress",...,"input_path":"T:\\Mods\\watermarkmaker\\uploads\\334af74a_race.mp4",
   "output_path":"T:\\Mods\\watermarkmaker\\outputs\\6268e8c9_censored_race.mp4"}`. `uploaded_media` is
   likewise only pruned on session cleanup/delete, so `GET /api/media` had grown to 61 entries of every
   client's/test's media during this audit; the janitor does not prune either registry (see #11).

9. **Job lifecycle lies / silently drops work.** `process_batch_worker` ends with
   `job["status"] = "completed"` unconditionally (`server.py:519`):
   - bogus/deleted `file_id` -> item `continue`d (`server.py:454-457`) => verified job says `completed`
     with `items: []`; a deleted media id likewise gave `completed` and no output, so the UI cannot tell
     failure from success.
   - duplicate ids in `file_ids` -> same `out_name` computed per original name (`server.py:462-470`), so
     verified `[fid, fid]` produced two job items pointing at the *same* download URL, only one file on
     disk, and a ZIP with duplicate arcname.
   - per-item exceptions leak `str(e)` into `item["error"]` (`server.py:512-514`), which can include
     filesystem paths; the batch worker itself never marks the overall job `failed`.

10. **Error handling: swallowed failures, plain 500s, path leaks, partial files.** `server.py:247-291`
    wraps upload processing in `except Exception: print(...)` and still returns a normal 200 item.
    Verified: uploading garbage bytes as `broken.jpg` -> `200`, `width=0,height=0`,
    `thumb_url=/api/thumbnails/thumb_418e2e41.jpg` -> `404`; UI gets a silently broken item.
    `os.path.getsize(save_path)` at `server.py:302` is outside the try and would 500 if the write failed;
    `raw_frame_*.jpg` is deleted only on the success path (`server.py:269-289`); partially written
    previews/outputs are never cleaned on exception. Directory paths hit an unhandled
    `RuntimeError("File at path ... is not a file.")` in `FileResponse` -> verified
    `GET /api/download/.` and `/api/thumbnails/.` return bare `500 Internal Server Error` (traceback only
    in the uvicorn log) instead of 404/400. `/api/censor/process` interpolates the exception into the HTTP
    500 detail (`server.py:1249-1252`) — potential internal-info leak. `/api/thumbnail/extract-single-frame`
    discards ffmpeg stderr (`server.py:693-695`): `timestamp_sec=1e9` -> `500 {"detail":"Failed to capture
    frame"}` with no diagnostics. No global exception handler / structured logging is configured.

11. **Janitor deletes files that open tabs still reference (data loss after 2 h).**
    `run_janitor_cleanup` (`server.py:98-117`) deletes any file in `uploads/`, `thumbnails/`,
    `outputs/` whose mtime is older than 7200 s, checking only `jobs[*]["input_path"/"output_path"]` of
    `in_progress` jobs. It does **not** consult `session_files`, `uploaded_media`, or `censor_preview_*`,
    and it does not prune those registries. Verified in-process: a 3 h-old upload was deleted while
    `session_files[<session>]` still contained its absolute path; that stale entry can never be cleaned
    (registry grows), and a tab left open >2 h loses its previews/inputs -> later export fails.
    The same sweep runs at import time (`server.py:119-123`) in every process that imports `server`
    (including `test_censor_api.py`), and the janitor thread is started twice under `reload=True`
    (`server.py:126-134`). Also `janitor_loop` iterates `jobs.values()` while request threads insert new
    job keys; that `RuntimeError` is caught and the whole cleanup cycle silently skipped (`server.py:129-132`).

12. **No locking around `jobs` / `uploaded_media` (latent thread-safety bug).**
    `session_files`/`censor_preview_*` have `RLock`s (`server.py:66,71`), but `jobs` and
    `uploaded_media` are mutated from background threads (`server.py:450-519`, `1070-1130`) and request
    threads with no synchronisation. `get_job_status` (`server.py:538-543`) returns the live dict object;
    `video_censor_worker` adds new keys (`download_url`, `filename`, `size_bytes`, `error`) to an existing
    job while FastAPI's `jsonable_encoder` may be iterating it (RuntimeError -> 500). I hammered
    `/api/job-status` with 8 threads / 3,200 requests during a censor job and got `3200x 200` — not
    reproduced, so treat as latent, not confirmed-often. Same race shape in the janitor (see #11).
    A duplicate-`file_ids` or concurrent preview/export also overwrites shared output names
    (`preview_{file_id}.jpg` `server.py:400/440`, `thumb` reuse).

13. **Launch path / docs are stale and the server is LAN-exposed.** `run.bat` is 4 functional lines:
    `cd /d "%~dp0"` then `python server.py` then `pause` (cwd handling is correct, no venv/activate, no
    dependency check). `server.py:1268-1276` hardcodes `uvicorn.run("server:app", host="0.0.0.0",
    port=8000, reload=True)`: listens on all interfaces (startup banner advertises the LAN URL
    `http://<lan-ip>:8000`) with CORS `*` and zero auth (#2/#3/#4), and uses the dev reloader in the
    "launch" path — verified `run.bat` starts a reloader parent + multiprocessing worker
    (`python server.py` + `spawn_main(parent_pid=...)`), i.e. two imports of `server` (duplicate janitor
    thread, duplicate import-time sweep/mkdirs), and file-watching in the app directory. Port conflict:
    a second instance exits with `[Errno 10048] ... bind on address ('127.0.0.1', 8000)` (verified); the
    `pause` then leaves the window open, but `run.bat` gives no friendly message. Startup banner
    "Watermark Studio Pro is LIVE!" is block-buffered and was lost when stdout was redirected (minor).
    Docs: `README.md:44` still says
    `cd "C:\Users\Admin\.gemini\antigravity\scratch\watermark-studio"` (stale path, project is
    `T:\Mods\watermarkmaker`); README documents only watermarking (no compressor/thumbnail/censor/collage),
    its Testing section (`README.md:57-62`) lists only 2 of the 7 test commands, and the app name is
    inconsistent (`Frame Studio` in `static/index.html`, `Watermark Studio Pro` in README/banner,
    `Media Studio Pro` in `.planning/STATE.md`). There is **no `requirements.txt`/`pyproject.toml`/
    `setup.py` anywhere** (root listing; no such file in git history either) and no documented
    `pip install ...` — a fresh machine cannot install deps (needs fastapi, uvicorn, python-multipart,
    pillow, opencv-python, numpy, requests, httpx for TestClient, pymupdf for PDF compression).

14. **Static serving / route ordering (mostly fine).** `server.py:1255` mounts
    `StaticFiles(directory=STATIC_DIR, html=True)` at `/` **after** all API routes, so it does not shadow
    `/api/*`, `/docs`, `/openapi.json` (all verified 200). `/` serves `index.html`; unknown paths return
    JSON `{"detail":"Not Found"}` (e.g. `/favicon.ico`, `/thumbnail`, `/static/css/style.css`). Small
    issues: (a) `index.html` has no `<link rel="icon">`, so browsers request `/favicon.ico` -> 404 JSON;
    (b) there is no `/static` prefix mount, so any asset path written as `/static/...` 404s (current HTML
    correctly uses `/css/...`, `/js/...`); (c) static responses have **no `Cache-Control`** header — only
    `ETag`/`Last-Modified` (verified revalidation -> 304, and HTML uses `?v=studio-redesign-19` query
    busting, so edits are normally picked up, but there is no explicit freshness policy);
    (d) `/api/download/.`, `/api/thumbnails/.`, `/api/uploads/.` return 500 instead of 404 (see #10).

15. **Censor endpoint dead code / wasted work.** `server.py:909-930` `_detect_tracked_faces_at_time()` is
    defined but never called (leftover from the old "track from frame 0" preview approach; would scan
    every frame from 0). `api_censor_detect_faces` (`server.py:968-994`) has identical `if` and `else`
    branches and decodes the frame **three** times (`server.py:979`, `984`, `988`). `get_censor_processor`
    (`server.py:850-856`) lazily creates one shared `CensorProcessor` (cv2 DNN detector) used concurrently
    by request handlers and export workers with no lock; 2 concurrent censor jobs + 18 concurrent
    `detect-faces` calls all returned 200 in this run (so no crash observed), but detector thread-safety
    is unguarded. Negative timestamps are accepted unvalidated: `extract-single-frame` with `-5.0` ->
    `200` and writes `exact_<id>_-5000.jpg`; with `1e9` -> 500; `extract-candidates` with
    `start_sec=-100` silently clamps to 0.33 s.

16. **Download names are mangled for non-job outputs.** `server.py:551-552` derives the display name with
    `filename.split("_", 1)[1]`, assuming a `{jobid}_` prefix only censor/job outputs have. Verified:
    `GET /api/download/thumbnail_54dfbe0b_1.jpg` -> `Content-Disposition: attachment;
    filename="54dfbe0b_1.jpg"`. Same for `preview_*`, `sheet_*`, `thumbnails_bundle_*`, `logo_*` downloads.

**Verified working (no bug):** upload filename sanitisation blocks direct traversal
(`os.path.basename((file.filename).replace("\\","/"))`, `server.py:226` — `../../escape_me.jpg`,
`..\..\escape_me2.jpg`, `C:\Windows\Temp\escape_me3.jpg` all saved as flat `uploads/<id>_escape_me*.jpg`);
Windows reserved names are harmless because of the uuid prefix (`CON.jpg`, `NUL.jpg` saved fine);
`/api/session/cleanup` accepts garbage/absent JSON gracefully; `sendBeacon` POST with
`Content-Type: application/json` works; censor-video cleanup deferral works; two concurrent censor
exports and concurrent face detections completed without error; static mount/route ordering is correct;
UTF-8/space filenames (e.g. `test_unicode (1).jpg`) work through upload/download.

---

## Security & safety issues

Ranked by real-world impact for a local app (worst case: user visits a malicious page while the app runs,
or the server is started by `run.bat` on a shared/LAN network, which the banner explicitly advertises).

1. **Critical — arbitrary local file read** via `/api/download|thumbnails|uploads/{filename}` using
   Windows `\`/absolute paths (#1). Read `server.py`, `README.md`, `C:\Windows\win.ini` from a plain GET.
   Also reachable pre-auth from any browser/process that can connect to port 8000.
2. **High — no auth of any kind** on a server that may bind `0.0.0.0:8000` (`server.py:1276`): anyone on
   the LAN can list (`GET /api/media`), upload, delete (`DELETE /api/media/{id}`), export, and purge
   another tab's files (`POST /api/session/cleanup`). Session ids leak in `/api/media` (#4).
3. **High — stored XSS / arbitrary HTML+SVG hosting on the app origin** (#2): uploaded `.html`/`.svg` are
   served with `text/html` / `image/svg+xml`; same-origin script can drive the whole unauthenticated API
   (delete/read/export everything, including cross-session).
4. **High — CORS `*` + credentials reflection** (#3): drive-by cross-origin reads/deletes/process starts
   from any website the user visits; preflight advertises DELETE/PATCH/PUT.
5. **Medium — path traversal in body-supplied filenames** (`thumbnail/preview`, `thumbnail/export`,
   `thumbnail/generate-storyboard`, censor `custom_sticker_filename`, `server.py:718,753-755,801-803,
   1007-1010,1140-1144`). Arbitrary existing image can be read/rendered to a served output; non-images
   raise plain 500 (confirmed `/api/thumbnail/preview` with `..\\server.py`).
6. **Medium — unbounded upload size and file count, no content validation** (`server.py:224-309`,
   `364-380`): 32.2 MB and 10.6 MB uploads accepted (no cap/`Content-Length` check, no disk-quota); no
   magic-byte check; filename/path length unbounded; unlimited `/api/media` accumulation -> disk/memory
   exhaustion and event-loop stalls (#7). `/api/compress/upload` accepts literally any file.
7. **Medium — session lifecycle enables cross-tab/cross-reload data loss** (#5, #6): any client can purge
   another session by id; tab navigation/reload triggers cleanup; outputs of batch jobs are not tracked,
   so they are neither cleaned on tab close nor protected if cleanup runs.
8. **Medium — absolute paths and internal error strings leak to clients** (`server.py:1212-1220` in
   `/api/job*`; `str(e)` in job item errors `512-514` and censor 500 `1252`): reveals usernames,
   directory layout, library internals.
9. **Low — info disclosure via unauthenticated `/api/download-zip/{job_id}`** (`server.py:555-571`): any
   job's completed outputs can be bundled by anyone who knows/guesses an 8-hex job id (32-bit ids from
   `uuid4()[:8]`; GUID collision/guess space small); no job expiry means URLs stay valid forever.
10. **Low — 8-hex ids** (`uuid.uuid4()[:8]`, `server.py:225,367,527,719,797,1034,1185,1207`) collide at
    ~77k uploads (birthday) and cause silent file overwrites (`{file_id}_{orig_name}`) — same id space for
    jobs/sessions; should be full UUIDs. `censor` image output uses random hex8 too.
11. **Low — no `X-Content-Type-Options`, `X-Frame-Options`, or CSP** on static/API responses; the local
    app can be framed by a remote page (clickjacking that drives exports) — same threat model as #3/#4.
12. **Low — DEBUG-ish info in console only** (`print()` tracebacks at `server.py:291, 1114, 1251`,
    janitor swallows all exceptions `116-117`, `129-132`): failures vanish; no log file/level; a failed
    cleanup or skipped janitor cycle is undiagnosable.
13. **Positive** — no SQL/command injection found: all ffmpeg calls use argument lists with static
    arguments (`server.py:685-693`), filenames are uuid-prefixed and basename-sanitised for direct use.
    Zip handling (`server.py:184-194, 564-569`) uses zipfile (no zip-slip extraction: it only writes).

---

## Test suite results

Run from `T:\Mods\watermarkmaker` with the environment above. Live-server tests need a server on
**port 8000** (hardcoded in the test files; README does not say to start one): I used
`python -m uvicorn server:app --host 127.0.0.1 --port 8000`. `test_censor_api.py` uses
`fastapi.testclient.TestClient` and needs no server. Every test was executed once, in the order below;
no project file was modified; `git status` before/after the test run was identical (test_data fixtures
are regenerated byte-identically).

| Command | Result | Note |
|---|---|---|
| `python test_engine.py` | **PASS** (0.8 s) | Writes/overwrites *tracked* fixtures `test_data/sample.jpg`, `logo.png`, `sample_video.mp4` (`test_engine.py:14,23,32`); asserts only output-file existence (`:79-112`) — no pixel/visual assertions. Prints progress callbacks. |
| `python test_thumbnail.py` | **PASS** (1.65 s) | Depends on `test_data/sample.jpg`. Asserts aspect-ratio sizes (good) but enhancement/storyboard/thumbnail steps assert only `os.path.exists` (`:30-31,50-51,93`) — weak. Writes `test_output/thumbs/*` (ignored). |
| `python test_censor.py` | **PASS** (2.26 s) | Real assertions on detection/tracking (`:77-81,148-149,180,209-211`), but relies on a synthetic-face heuristic (cv2-version brittle; passed 31/31 here) and stderr is full of `cv2 ... setPreferableTarget` warnings. `test_mask_styles` (`:94-121`) asserts nothing — only writes images. Writes `test_output/censor/*` (ignored). |
| `python test_thumbnail_api.py` | **PASS** (16.99 s — slowest) | Needs live server on `:8000` (`BASE_URL` `:6`); starts by generating `test_output/test_video.mp4` (ignored). Exercises candidates/exact-frame/storyboard/6 previews/PNG export/ZIP — good breadth, asserts only status/keys/lengths; no content validation of rendered images. |
| `python test_censor_api.py` | **PASS** (2.52 s) | Uses `TestClient` (`:9-13`) so no server needed — but importing `server` triggers the import-time janitor sweep + dir creation + janitor daemon thread in the test process. Covers image flow, video tracking job, single-face job, and download `Content-Disposition` (`:202-207`, real assertion). Deprecation warning `Using httpx with starlette.testclient`. Real per-file output files left in `uploads/`, `outputs/`, `thumbnails/` (ignored). |
| `python verify_e2e.py` | **PASS** (1.71 s) | Needs live server on `:8000` (`:5`). Uploads image+video, logo, preview, batch job, status polling, ZIP; asserts `len(res.content) > 1000` for the ZIP (`:97`) — decent, but only 2 media items and no negative cases. |
| `python verify_sync.py` | **PASS** (1.15 s) | Needs live server on `:8000` (`:5`). Best test of the suite: real pixel analysis of the red badge, asserts preview/export width and margin ratios within 1.5 % (`:117-118`); passed with 0.000 % discrepancy. Depends on `test_data/sample.jpg`. |

Suite health notes: no pytest/unittest/framework and no CI config — all are plain scripts with `assert`,
exit 0 on success; a failure raises traceback with non-zero exit (fine, but there is no aggregated
pass/fail report, no coverage, no frontend/browser tests, and zero tests for traversal, CORS, session
isolation, upload validation, or error handling — exactly the areas where bugs were found). No test is
currently FAILing; none is flaky by design, but `test_censor.py`'s detection thresholds and the
`verify_sync.py` red-pixel thresholds are environment-sensitive (OpenCV/PIL version drift).
Tests leave junk only in git-ignored dirs (`test_output/` ~34 files, plus uploads/outputs/thumbnails
artifacts; before this audit's own probes the suite had left 8 uploads / 13 outputs / 35 thumbs), which
the janitor removes after 2 h; `_audit_tmp/` (audit scratch) and `BLUR_TEST_1.mp4` are **not** ignored.
Total suite runtime ≈ 27 s, dominated by `test_thumbnail_api.py`.

**Repo hygiene / uncommitted change set (audited):**
- Uncommitted tracked modifications are 15 files (1,285 insertions / 348 deletions): `server.py` (+91/-~2:
  document compression for txt/office/pdf/zip via gzip/zipfile/pymupdf + `/api/compress/upload` + dead
  NSFW-processor line removal — clearly intentional, related to the new Compress features);
  `engine/thumbnail_processor.py` (+85); the rest are `static/` UI work (landing page redesign →
  "Frame Studio", compressor/censor/thumbnail/watermark pages, `style.css` +669, `js/app.js` +138,
  `js/theme.js`, `js/thumbnail.js`, `js/censor.js`, `js/compressor.js`) and `tools/generate_emojis.py`.
  This looks like an intentional, coherent feature/WIP changeset — **except**
  `engine/__pycache__/image_processor.cpython-314.pyc` being modified, which is pure build noise.
- **Tracked junk:** `git ls-files "*.pyc"` returns 4 `.pyc` files under `engine/__pycache__/`
  (`font_manager`, `image_processor`, `models`, `video_processor`) despite `.gitignore`
  `__pycache__/` + `*.pyc`; they were committed before the ignore rule and stay tracked (one shows as
  `M` in `git status`). Should `git rm --cached`.
- **Untracked junk:** `BLUR_TEST_1.mp4` = 124,939,586 bytes (~119 MB) at repo root, not ignored;
  `_audit_tmp/` (this audit's + another auditor's scratch, ~100 files) not ignored; new feature files not
  yet `git add`ed: `static/collage.html`, `static/js/collage.js`, `static/js/workspace.js`,
  `static/assets/emojis/{alien,cat,heart_eyes,robot}.png`.
- `.gitignore` gaps: `*.log`, `_audit_tmp/`, `BLUR_TEST_*.mp4` / large test videos. Present ignores for
  `uploads/*`, `thumbnails/*`, `outputs/*`, `test_output/*` (with `.gitkeep` exceptions) are correct, but
  no `.gitkeep` files are tracked, so dirs are recreated by `server.py:47-50`.
- `engine/` has **no `__init__.py`**: imports resolve as a PEP 420 namespace package, so
  `from engine.models import ...` works only with cwd = repo root (run.bat does `cd /d "%~dp0"`, and all
  tests/scripts assume that); the project is not installable and has no packaging metadata.
  `models/face_detection_yunet_2023mar.onnx` (232 KB) is tracked (required runtime asset, acceptable).

---

## Recommended fixes (prioritized)

**P0 — must fix before anyone other than the author runs this (security)**
1. Replace the three raw filename download endpoints with safe resolution:
   `safe = os.path.realpath(os.path.join(DIR, os.path.basename(filename)))`, then verify
   `os.path.commonpath([DIR, safe]) == os.path.realpath(DIR)` and `os.path.isfile(safe)`, else 404.
   Apply the same helper to every body-supplied filename (`thumbnail/preview|export|generate-storyboard`,
   censor `custom_sticker_filename`) and reject `..`, `/`, `\`, drive letters, and absolute paths.
2. Add an extension allow-list (images for logo; images/video/office/pdf/etc. for the studio tools) and
   magic-byte validation on upload; save with a server-chosen extension and serve with an explicit,
   safe `Content-Type` + `Content-Disposition: attachment` for anything non-image. At minimum force
   `text/plain` for `.html/.svg/.xml/.js` uploads.
3. Stop listing other clients' media and stop trusting `session_id`: sign/bind sessions (e.g.
   `HttpOnly` cookie or HMAC token), filter `/api/media` and deny download/delete/cleanup unless the
   session owns the file, and require a per-session token for `/api/session/cleanup`. If the tool is
   meant to be single-user local, bind `127.0.0.1` only (see P1 #9).
4. Restrict CORS: remove `allow_credentials=True` with `allow_origins=["*"]`; for a local app use
   `allow_origins=["http://127.0.0.1:8000","http://localhost:8000"]` (or no CORS middleware at all) and
   add a lightweight `Origin`/`Sec-Fetch-Site` check for state-changing endpoints.

**P1 — correctness / data-loss / UX**
5. Track session ownership for *all* jobs: increment/decrement `session_active_jobs` in
   `/api/process` as well, register every output (batch outputs, ZIPs, previews) via
   `register_session_file`, so cleanup never deletes in-flight inputs and never leaves orphans; also make
   cleanup idempotent and prune `jobs`/`uploaded_media` entries that reference removed files.
6. Fix `sendBeacon` over-firing: only clean on actual tab close (`pagehide` with `event.persisted ===
   false` is still not enough for navigation) — better: debounce/skip cleanup on same-origin navigation,
   or don't clean up at all and rely on short server-side expiry. Consider removing `beforeunload`
   duplicate registration.
7. Move blocking work out of async handlers: make `upload_media` a sync `def` (threadpool) or wrap the
   PIL/ffmpeg blocks in `run_in_threadpool`/`asyncio.to_thread`; make `/api/compress/upload` call the
   sync function via threadpool too. Keep the event loop for JSON/health endpoints.
8. Add job TTL + cleanup (e.g. completed/failed jobs older than 30–60 min are deleted together with their
   files; cap `jobs`/`uploaded_media` sizes), and never expose `input_path`/`output_path` in API JSON;
   add a single global exception handler that returns opaque 500s and logs with `logging` (no `print`),
   and wrap `FileResponse` path checks for directories to return 404.
9. Fix job status semantics: mark a job `failed` when every item fails / no valid items; don't silently
   `continue` on missing media (record a failed item); dedupe duplicate `file_ids`; compute output names
   from `file_id` so duplicates/unknown media cannot overwrite each other; verify `os.path.exists` after
   every write; remove partial files in `except` blocks.
10. Make the janitor session-aware: skip paths referenced in `session_files` / `uploaded_media` / active
    jobs, prune stale registry entries, and delete old files only when no live tab could own them
    (e.g. add upload timestamps/owner records). Also consider running the sweep only in the serving
    process (not at import time in tests) and guard `jobs.values()` iteration with the existing lock.
11. Constrain launch: default `--host 127.0.0.1`, `reload=False` for `run.bat` (add `run-dev.bat` for
    reload), make the port configurable (`--port`/env), friendly "port in use" message, dependency check
    + `requirements.txt` (pin fastapi, uvicorn, python-multipart, pillow, opencv-python, numpy, requests,
    httpx, pymupdf) and update README (real path, all 5 tools, all 7 test commands, how to start the
    server for the API tests, port). Kill the `_detect_tracked_faces_at_time` dead code and the duplicate
    frame decodes/branches in `api_censor_detect_faces`; add a lock or per-job `CensorProcessor` instance.
12. Fix download display names: only strip the known job-id prefix for paths produced by
    `process_batch_worker`/censor (pass an explicit `display_name`/`output_filename` query or store it),
    otherwise serve `os.path.basename(filename)`.

**P2 — hardening / hygiene**
13. Use full UUIDs (not `uuid4()[:8]`) for file/job/session ids; add `X-Content-Type-Options: nosniff`,
    `X-Frame-Options: DENY`, and a strict CSP on static responses; add `Cache-Control: no-cache` (or
    hashed asset names) for `static/` and a favicon.
14. `git rm --cached` the 4 tracked `.pyc` files and stop tracking `__pycache__`; add `_audit_tmp/`,
    `*.log`, and `BLUR_TEST_*.mp4` to `.gitignore`; decide whether the 119 MB `BLUR_TEST_1.mp4` is a
    test asset (move to `test_data/` with Git LFS or delete) and whether the untracked collage/workspace/
    emoji files should be committed. Add `engine/__init__.py` (or a `pyproject.toml`) so imports do not
    depend on cwd.
15. Test/tooling: switch to pytest (or a tiny runner) with exit codes, add negative tests
    (traversal, extension allow-list, CORS, cross-session cleanup, oversized upload, duplicate ids,
    deleted media), assert image content not just file existence, and make API tests read
    `BASE_URL` from env (default 8000) with a documented `conftest`/server fixture; add a CI script that
    starts the server once and runs all seven commands.

_Evidence logs for every claim above: `_audit_tmp/backend/probe.log`, `probe2.log`, `probe3.log`,
`probe4.log`, `probe5.log`, `janitor_test.log`, `launch_test.log`, `port_test.log`,
`test_*.log`, `verify_*.log`, `server8000*.log` (uvicorn tracebacks for the 500 cases)._
