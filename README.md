# Frame Studio

A lightweight, local-first web suite for everyday image and video editing. Built as a personal tool so media stays on your own machine—no cloud uploads, no subscriptions, and accessible from any device on your local network.

## Features

- **Watermark Studio** (`/watermark.html`) — Add multi-layer text and logo overlays to images and videos with 9-grid anchoring, freeform drag positioning, tiled patterns, and batch ZIP export.
- **Compressor Studio** (`/compressor.html`) — Shrink image and video file sizes with customizable quality controls.
- **Thumbnail Studio** (`/thumbnail.html`) — Extract key frames from videos, generate contact-sheet storyboards, preview edits live, and export batches as a ZIP.
- **Collage Studio** (`/collage.html`) — Arrange photos into preset or custom grids with draggable slots, annotations, and canvas export.
- **Privacy / Censor Studio** (`/censor.html`) — Automatically detect faces (YuNet ONNX) and sensitive regions, track objects across video frames, or draw manual blur, pixelate, and emoji censor boxes.

## Tech Stack

- **Backend:** Python, FastAPI, Uvicorn
- **Media Engine:** FFmpeg, OpenCV, Pillow, YuNet ONNX
- **Frontend:** Vanilla HTML, CSS, JavaScript (light/dark mode, desktop & mobile responsive)

## Getting Started

### Prerequisites

- Python 3.10+
- [FFmpeg](https://ffmpeg.org/) available on your system `PATH`

### 1. Install Dependencies

Install the Python packages first:

```bash
pip install -r requirements.txt
```

Make sure [FFmpeg](https://ffmpeg.org/) is also installed and available on your system `PATH` (required for video processing and thumbnails).

### 2. Run Locally

```bash
python server.py
```

*(On Windows, you can also double-click `run.bat`.)*

- **PC:** `http://127.0.0.1:8000`
- **Mobile (same Wi-Fi):** Open the local network URL printed in the terminal (e.g., `http://<your-lan-ip>:8000`).

## Project Structure

```text
├── server.py           # FastAPI app, routes, and background workers
├── engine/             # Image, video, thumbnail, font, and censor processors
├── models/             # YuNet ONNX face detection model
├── static/             # Studio HTML pages, CSS, JS, and emoji assets
├── run.bat             # Windows quick-launch script
└── test_engine.py      # Core engine test script
```

## Testing

```bash
python test_engine.py
```
