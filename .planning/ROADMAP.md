# Roadmap: Frame Studio

## Vision
A unified high-performance local web application and offline Android 14+ APK for creators: batch watermarking, smart file/document compression, thumbnail creation, client-side collage building, AI privacy redaction, 3D LUT color grading, and EBU R128 audio normalization. Zero cloud dependencies, 100% privacy on local hardware, with PIN-protected mobile LAN offload.

## Milestones
- [x] **Milestone 1: Watermark Studio** (`static/watermark.html`, `engine/image_processor.py`, `engine/video_processor.py`) — text outline stroke, style presets, Undo/Redo, zoom & peek
- [x] **Milestone 2: File & Media Compressor** (`static/compressor.html`, `engine/compression_processor.py`, `routers/watermark.py`) — target MB exact sizing + split before/after compare
- [x] **Milestone 3: Thumbnail Studio & Theme System** (`static/thumbnail.html`, `engine/thumbnail_processor.py`) — style presets + cancelable multi-stage export
- [x] **Milestone 4: Privacy / Censor Studio v2** (`static/censor.html`, `engine/censor_processor.py`, `routers/censor.py`) — Images & Videos batch tabs, NudeNet ONNX (`320n.onnx`) 18-class body-part detector, 5 mask shapes, Exact Face Fit, smooth separable Gaussian blur, Brush + Eraser, 67 Microsoft Fluent 3D emojis, Video In/Out time ranges
- [x] **Milestone 5: Collage Studio** (`static/collage.html`, `static/js/collage.js`) — Undo/Redo + 2x/4K resolution scaling & WebP/JPEG/PNG export
- [x] **Milestone 6: Modularization, Hardware Accel & LAN Security** (`core/state.py`, `engine/hw_accel.py`, `routers/`) — Intel `h264_qsv` probing + fallback, `HEAVY_TASK_SEMAPHORE`, `--lan` 6-digit pairing PIN + lockouts
- [x] **Milestone 7: Color & LUT Studio** (`static/color.html`, `engine/color_processor.py`, `routers/color.py`, `static/assets/luts/`) — 6 bundled Adobe `.cube` 3D LUTs + custom `.cube`, trilinear interpolation & FFmpeg `lut3d` + QSV video grading
- [x] **Milestone 8: Audio Booster & Normalizer** (`static/audio.html`, `engine/audio_processor.py`, `routers/audio.py`) — EBU R128 LUFS/true-peak analysis & 2-pass normalization, voice clarity EQ, FFT denoise, `-c:v copy` video audio boost
- [x] **Milestone 9: Android 14+ Mobile Parity** (`android/`, `static/js/mobile-engine.js`, `FrameStudio-Android.apk`) — Android 14/16 manifest & loopback token hardening, 5 shapes, Exact Face Fit, sequential 1080p video batching, offline Color & Audio engines
