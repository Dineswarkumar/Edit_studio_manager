# Detailed Implementation Plan

## Architecture Overview
1. **Engine Layer**:
   - `engine/watermark_layer.py`: Data models defining watermark layers (`TextWatermarkLayer`, `ImageWatermarkLayer`, `WatermarkConfig`).
     - Coordinates / Placement: Anchor (9-grid positions) or Normalized coordinates `(x, y)`, Rotation angle, Opacity (0.0 to 1.0).
     - Tiled pattern mode: diagonal angle (e.g. -30°), horizontal & vertical step gap, staggered repeat.
     - Text styling: font name, font size (auto-scaled or px), text color (HEX/RGBA), optional background badge (color, padding, border radius).
     - Image styling: file path, scale percentage (relative to base media width), opacity, rotation.
   - `engine/image_processor.py`:
     - Creates transparent RGBA watermark overlay canvas matched to base media dimensions.
     - Renders text with Pillow `ImageDraw.text` (supporting truetype fonts, rotation with `Image.rotate` and expanded bounding box, opacity manipulation with alpha channel).
     - Renders image watermark with proper resizing, rotation, and alpha blending.
     - Supports tiled pattern generation by tessellating across base media with angle.
     - Composites overlay onto target image with `Image.alpha_composite` and preserves format/quality.
   - `engine/video_processor.py`:
     - Extracts frame dimensions and duration using `ffprobe` / OpenCV.
     - Generates transparent full-frame watermark overlay PNG using the exact same `ImageProcessor` renderer (ensuring 100% visual parity between picture and video watermarks!).
     - Applies overlay onto video stream via FFmpeg:
       `ffmpeg -y -i input.mp4 -i overlay.png -filter_complex "[0:v][1:v]overlay=0:0" -c:v libx264 -preset veryfast -crf 22 -c:a copy output.mp4`
     - Supports progress tracking and cancellation.

2. **Server Layer (`server.py`)**:
   - FastAPI app serving static frontend and REST endpoints:
     - `POST /api/upload-media`: Upload one or multiple pictures and videos, generates immediate thumbnails and metadata.
     - `POST /api/upload-watermark-image`: Upload watermark logo image.
     - `POST /api/preview`: Renders live watermarked preview on a single image or first frame of a video.
     - `POST /api/process-batch`: Kicks off processing for selected files with provided watermark configuration.
     - `GET /api/job-status/{job_id}`: Polls or streams batch processing status.
     - `GET /api/download/{file_id}`: Downloads processed picture/video.
     - `GET /api/download-zip/{job_id}`: Bundles all processed files into a ZIP archive for one-click bulk download.

3. **Frontend Layer (`static/`)**:
   - Single-page application with modern responsive CSS (dark glassmorphism, accent colors, smooth sliders).
   - Multi-file drop zone for images and videos with thumbnail previews and badge indicators.
   - Real-time interactive visual stage:
     - Shows selected image or video frame.
     - Live preview canvas showing rendered watermarks with draggable handles.
   - Control panels:
     - Watermark Mode: Text vs Image Logo vs Combined / Multiple Layers.
     - Layout mode selector: 9-Grid Anchor buttons, Drag/Manual coordinates, or Tiled Repeating Pattern.
     - Sliders: Size / Scale, Opacity, Rotation Angle, Padding/Margin, Spacing for Tiled pattern.
     - Styling: Text input, Color pickers (foreground & background badge), Font family selector.
     - Batch queue table with individual download and "Download All ZIP".
