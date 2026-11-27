# Project: Frame Studio Verification & Memory Profiling

## Architecture
- **Backend**: FastAPI + Uvicorn on `127.0.0.1:8000` (`server.py`). Serves 26 API endpoints and static assets mounted at root. Background tasks handle janitor file cleanup, batch watermarking/compression, and video censor tracking.
- **Frontend**: 5 studio web applications located in `static/`:
  - `/watermark.html` (Watermark Studio: interactive canvas drag-and-drop, multi-layer overlays, batch processing modal).
  - `/compressor.html` (Space Compressor Studio: multi-format media and document compression with inline dashboard).
  - `/thumbnail.html` (Thumbnail Studio Pro: candidate frame extraction, contact sheet storyboards, live previews, 10-image ZIP batch exports).
  - `/collage.html` (Collage Studio: custom slot dragging `slot-move`, zero-gap snapping, canvas rendering).
  - `/censor.html` (Privacy / Blur Studio: YuNet DNN face detection, MIL object tracking, NSFW skin segmentation, manual censor boxes).
- **Styles & Responsive Design**: `static/css/style.css` provides responsive breakpoints:
  - Desktop (`@media (min-width: 1001px)`): Clamped viewport height (`100dvh`), independent panel scrolling via `.panel-content` (`overflow-y: auto`), pinned stage.
  - Mobile (`@media (max-width: 640px)`): Wrapped stage toolbar, horizontal scroll on aspect-ratio selectors with >=34px touch targets.
  - Modals: Flat solid backgrounds; universal CSS override (`background-image: none !important`).

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Server Process Management | Terminate existing port 8000 process and start clean server from repo root | M1 | R1, survey |
| 2 | Studio Endpoint Availability | Serve 5 studios (`/watermark.html`, `/compressor.html`, `/thumbnail.html`, `/collage.html`, `/censor.html`) with HTTP 200 | M1 | R1, survey |
| 3 | Thumbnail API Integration Suite | Execute `test_thumbnail_api.py` validating 7-stage candidate extraction, previews, and ZIP export | M1 | R1, survey |
| 4 | Desktop Independent Panel Scrolling | At viewport width >= 1001px, sidebars scroll independently without stage or header movement | M2 | R2, survey |
| 5 | Mobile Viewport Controls Accessibility | At viewport width <= 640px, stage toolbar and aspect-ratio selectors remain visible and usable | M2 | R2, survey |
| 6 | Zero Padding & Zero Grid Gap Styling | Collage stage and Thumbnail storyboard exhibit zero outer padding and zero gap between tiles | M2 | R2, survey |
| 7 | Gradient-Free Modal Dialogs | Modals and progress cards in Privacy, Watermark, and Thumbnail studios render flat, solid, gradient-free backgrounds | M2 | R2, survey |
| 8 | Collage Custom Slot Drag (`slot-move`) | Custom layout allows dragging slots within normalized stage boundaries without breaking coordinates | M3 | R3, survey |
| 9 | Thumbnail Storyboard Sheet (4:5, 4x4) | Seamless zero-gap storyboard sheet rendering in 4:5 aspect ratio with 4x4 (16 cells) grid | M3 | R3, survey |
| 10 | Thumbnail 10-Image ZIP Export | Batch export bundles exactly 10 images (1 main thumbnail + 9 variations) for 3x3 layout into ZIP | M3 | R3, survey |
| 11 | Privacy Studio NSFW Reactivity | Sensitivity buttons immediately trigger reactive detection without page reload | M3 | R3, survey |
| 12 | Privacy Studio Manual Box Retention | User-drawn `custom_*` censor boxes are strictly preserved across scrubbing, auto-detection, and video tracking | M3 | R3, survey |
| 13 | Watermark & Compressor Studio Workflows | Multi-layer watermark placement and media/document compression process without regression | M3 | R3, survey |
| 14 | DevTools Memory Leak Debugging (Collage) | Profile canvas rendering, photo clearing, object URLs, and backing store allocation | M4 | R4, survey |
| 15 | DevTools Memory Leak Debugging (Privacy) | Profile video scrubbing, YuNet/MIL tracking, detached DOM nodes, and event listeners | M4 | R4, survey |
| 16 | Comprehensive Diagnostic Report & Audit | Compile exhaustive verification and memory profiling test report across all 5 studios | M5 | R5, survey |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Server Startup & Baseline Verification | Kill any process on port 8000, start clean server, verify all 5 studio HTTP 200 endpoints, and run `test_thumbnail_api.py` | None | PLANNED |
| M2 | UI & Responsive Layout Verification | Test desktop panel scrolling (>=1001px), mobile controls (<=640px), zero padding/gap, and verify/remediate flat gradient-free modal styles | M1 | PLANNED |
| M3 | Functional Workflow Testing Across Studios | Validate Collage `slot-move`, Thumbnail 4:5 4x4 storyboard & 10-image ZIP, Privacy NSFW reactivity & manual box retention, and Watermark/Compressor processing | M1 | PLANNED |
| M4 | Chrome DevTools Memory Leak Profiling | Perform 5-phase heap snapshot analysis in Collage (canvas) and Privacy (video tracking), checking detached DOM nodes, event listeners, and heap growth | M1, M3 | PLANNED |
| M5 | Comprehensive Diagnostic Report & Forensic Audit | Compile the final diagnostic report detailing all test outcomes, UI measurements, and heap snapshot data; undergo independent forensic audit | M1, M2, M3, M4 | PLANNED |

## Interface Contracts
### Client ↔ Server Static & API
- `GET /<studio>.html` → HTTP 200 with HTML document.
- `POST /api/thumbnail/export` → JSON `{ success: true, count: 10, items: [...], zip_url: "..." }`.
- `POST /api/censor/detect-nsfw` → JSON `{ candidates: [{ x, y, w, h, score, ... }] }`.
- `POST /api/censor/detect-faces` → JSON `{ faces: [{ id, box, landmarks, ... }] }`.
- `POST /api/process` → JSON `{ job_id: "...", status: "queued" }`.

## Code Layout
- `server.py`: FastAPI server implementation, API routes, background workers.
- `engine/`: Core Python media processing algorithms (`censor_processor.py`, `thumbnail_processor.py`, `watermark_processor.py`, `compress_processor.py`).
- `static/`: HTML frontends (`watermark.html`, `compressor.html`, `thumbnail.html`, `collage.html`, `censor.html`, `index.html`).
- `static/js/`: Client scripts (`app.js`, `compressor.js`, `thumbnail.js`, `collage.js`, `censor.js`, `session.js`, `workspace.js`).
- `static/css/`: Main stylesheet (`style.css`).
- `test_data/`: Sample media assets (`sample_video.mp4`, `sample.jpg`, `logo.png`).
- `test_thumbnail_api.py`: Automated 7-stage HTTP integration test suite.
- `.agents/teamwork/`: Orchestration state and agent coordination files.
