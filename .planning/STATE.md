# Project State: Frame Studio

## Status
- **Current Milestone**: Milestone 7 & 8 — Privacy v2, 3D Fluent Emojis, Hardware Accel (QSV), Color & LUT Studio, Audio Booster & Android 14+ Parity
- **Active Branch**: `feat/privacy-v2-color-audio`
- **Active Workspace**: `T:\Mods\watermarkmaker`
- **Hardware Profile**:
  - PC: Intel Core i9-13900H, 16 GB RAM, Intel Iris Xe Graphics (`h264_qsv` verified + `libx264` fallback), `HEAVY_TASK_SEMAPHORE = 2`
  - Mobile Target: Android 14+ (`READ_MEDIA_VISUAL_USER_SELECTED`, `FOREGROUND_SERVICE_MEDIA_PROCESSING`, loop-authenticated `LocalAssetServer`), Dimensity 6500+ / Snapdragon 6 Gen 1080p offline guardrail

## Studios Implemented
- [x] **Watermark Studio** (`/watermark.html`) — multi-layer text/logo, outline stroke, saved/built-in presets, Undo/Redo, zoom/peek
- [x] **Compress Studio** (`/compressor.html`) — video, image, PDF, Office packages, archives, target MB sizing, live before/after split compare
- [x] **Thumbnail Studio** (`/thumbnail.html`) — candidate frame hunter, zero-gap storyboard, one-click style presets, cancelable export
- [x] **Collage Studio** (`/collage.html`) — 100% client-side canvas templates, Undo/Redo, 2x/4K scale & PNG/JPEG/WebP export
- [x] **Privacy Studio v2** (`/censor.html`) — Images/Videos batch sub-tabs, NudeNet ONNX 18-class body detection + YuNet faces, 5 shapes (`oval`/`rect`/`circle`/`triangle`/`heart`), Exact Face Fit, Brush + Eraser, 67 Microsoft Fluent 3D emojis, Video In/Out ranges
- [x] **Color & LUT Studio** (`/color.html`) — 6 bundled + custom `.cube` 3D LUTs, exposure/contrast/highlights/shadows/warmth/vignette/grain, live split compare, FFmpeg `lut3d` + QSV video export
- [x] **Audio Booster & Normalizer** (`/audio.html`) — EBU R128 LUFS/dBTP inspection & 2-pass normalization (`-14`/`-16`/`-23` LUFS), voice clarity EQ, FFT denoise, `-c:v copy` video passthrough
- [x] **Android 14+ APK** (`FrameStudio-Android.apk`) — Offline 100% on-device Canvas/WebAudio engine + `--lan` 6-digit pairing PIN modal for PC offload
