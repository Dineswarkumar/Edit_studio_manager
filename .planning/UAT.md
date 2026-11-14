# User Acceptance Testing (UAT) Plan

## Test Scenarios

### 1. Single Image Watermarking
- [ ] Upload single JPG/PNG image.
- [ ] Add custom text watermark ("© 2026 MyBrand").
- [ ] Adjust font, size, opacity (50%), color (white/red), rotation (15°).
- [ ] Verify live canvas preview reflects changes instantaneously.
- [ ] Process and download; inspect result to ensure clean composite without degradation.

### 2. Single Video Watermarking
- [ ] Upload a sample MP4 video.
- [ ] Extract first frame for preview.
- [ ] Apply a logo image watermark at Bottom-Right with 20px margin and 80% opacity.
- [ ] Process video with FFmpeg.
- [ ] Verify video plays cleanly, audio is preserved, watermark stays in place.

### 3. Multiple Watermarks on Single Media
- [ ] Add Layer 1: Image logo at Top-Left.
- [ ] Add Layer 2: Text watermark at Bottom-Center with background badge.
- [ ] Verify both layers render simultaneously in preview and exported media.

### 4. Tiled / Repeated Watermark Layout
- [ ] Switch layout to "Tiled / Grid Pattern".
- [ ] Set text to "CONFIDENTIAL - SAMPLE ONLY", rotation -30°, opacity 25%.
- [ ] Check preview: verify even repetition across diagonal grid.
- [ ] Export image and video; verify full coverage.

### 5. Batch Processing (Multiple Media at Once)
- [ ] Upload mix of 3 images and 1 video.
- [ ] Configure watermark settings.
- [ ] Click "Start Batch Processing".
- [ ] Monitor real-time progress bar and status for each file.
- [ ] Click "Download All as ZIP" and verify zip contains all processed files intact.
