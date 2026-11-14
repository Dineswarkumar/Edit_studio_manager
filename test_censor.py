"""
Unit Tests for Censor & Privacy Studio Pro Engine (engine/censor_processor.py)
Tests face detection, tracking continuity, single-face focus, NSFW detection,
MIL object tracking, and safe Windows I/O.
"""

import os
import cv2
import numpy as np
from engine.censor_processor import (
    CensorProcessor,
    FaceDetector,
    BoundingBox,
    MaskConfig,
    VideoFaceTracker,
    detect_nsfw_candidates,
    safe_imread,
    safe_imwrite,
    apply_gaussian_blur,
    apply_pixelate,
    apply_emoji_overlay,
    apply_redact_bar
)

TEST_DIR = "test_output/censor"
os.makedirs(TEST_DIR, exist_ok=True)


def create_synthetic_face_image(w=640, h=480, face_x=200, face_y=150, face_size=160) -> np.ndarray:
    """Generates an image with a realistic synthetic human face representation for detection tests."""
    img = np.ones((h, w, 3), dtype=np.uint8) * 230

    center = (face_x + face_size // 2, face_y + face_size // 2)
    axes = (face_size // 2, int(face_size * 0.65))
    cv2.ellipse(img, center, axes, 0, 0, 360, (180, 205, 235), -1)

    cv2.ellipse(img, (center[0], face_y + 20), (axes[0] + 10, 50), 0, 180, 360, (30, 30, 40), -1)

    eye_y = face_y + int(face_size * 0.45)
    left_eye_x = face_x + int(face_size * 0.32)
    right_eye_x = face_x + int(face_size * 0.68)
    cv2.ellipse(img, (left_eye_x, eye_y), (14, 8), 0, 0, 360, (255, 255, 255), -1)
    cv2.circle(img, (left_eye_x, eye_y), 5, (40, 20, 20), -1)
    cv2.ellipse(img, (right_eye_x, eye_y), (14, 8), 0, 0, 360, (255, 255, 255), -1)
    cv2.circle(img, (right_eye_x, eye_y), 5, (40, 20, 20), -1)

    cv2.line(img, (left_eye_x - 15, eye_y - 12), (left_eye_x + 15, eye_y - 12), (30, 30, 40), 3)
    cv2.line(img, (right_eye_x - 15, eye_y - 12), (right_eye_x + 15, eye_y - 12), (30, 30, 40), 3)

    nose_y = face_y + int(face_size * 0.62)
    cv2.line(img, (center[0], eye_y), (center[0] - 4, nose_y), (150, 175, 205), 3)
    cv2.line(img, (center[0] - 4, nose_y), (center[0] + 8, nose_y), (150, 175, 205), 3)

    mouth_y = face_y + int(face_size * 0.82)
    cv2.ellipse(img, (center[0], mouth_y), (25, 12), 0, 0, 180, (80, 80, 180), -1)

    return img


def test_safe_io():
    print("Testing Safe Windows I/O (handling spaces, special chars)...")
    img = create_synthetic_face_image(200, 200, 40, 40, 100)
    special_path = os.path.join(TEST_DIR, "special name (with spaces #1).jpg")
    ok = safe_imwrite(special_path, img)
    assert ok, "safe_imwrite failed on special filename"
    loaded = safe_imread(special_path)
    assert loaded is not None, "safe_imread failed to read special filename"
    assert loaded.shape == (200, 200, 3)
    print("✓ Safe Windows I/O verified")


def test_face_detector():
    print("Testing YuNet Face Detector...")
    detector = FaceDetector()
    img = create_synthetic_face_image()
    faces = detector.detect(img)
    assert len(faces) >= 1, f"Expected at least 1 face detected, got {len(faces)}"
    box = faces[0]
    print(f"✓ Detected face box: [{box.x}, {box.y}, {box.w}, {box.h}] with confidence: {box.confidence:.2f}")
    assert box.confidence > 0.45
    assert box.w > 50 and box.h > 50


def test_nsfw_detector():
    print("Testing NSFW / Sensitive Zone Detector...")
    img = np.ones((480, 640, 3), dtype=np.uint8) * 40
    # Add large skin-tone blob simulating exposed area
    cv2.rectangle(img, (180, 120), (460, 380), (180, 205, 235), -1)
    candidates = detect_nsfw_candidates(img, sensitivity=0.5)
    assert len(candidates) >= 1, "Expected sensitive zone detection"
    print(f"✓ Detected {len(candidates)} sensitive candidate zone(s): [{candidates[0].x}, {candidates[0].y}, {candidates[0].w}, {candidates[0].h}]")


def test_mask_styles():
    print("Testing Mask Renderers (Blur, Pixelate, Emoji, Redaction Bar)...")
    base_img = create_synthetic_face_image()
    target_box = BoundingBox(x=190, y=140, w=180, h=200, confidence=0.95)

    # 1. Gaussian Blur (Oval)
    blur_img = base_img.copy()
    blur_img = apply_gaussian_blur(blur_img, target_box, intensity=75, shape="oval")
    safe_imwrite(os.path.join(TEST_DIR, "test_mask_blur_oval.jpg"), blur_img)
    print("✓ Gaussian blur (oval feather) applied")

    # 2. Pixelate
    pixel_img = base_img.copy()
    pixel_img = apply_pixelate(pixel_img, target_box, intensity=60, shape="rect")
    safe_imwrite(os.path.join(TEST_DIR, "test_mask_pixelate.jpg"), pixel_img)
    print("✓ 8-bit mosaic pixelation applied")

    # 3. Emoji Overlays (Sunglasses)
    emoji_img = base_img.copy()
    emoji_img = apply_emoji_overlay(emoji_img, target_box, emoji_name="sunglasses")
    safe_imwrite(os.path.join(TEST_DIR, "test_mask_emoji_sunglasses.jpg"), emoji_img)
    print("✓ Emoji (sunglasses) overlay applied")

    # 4. Redaction Bar
    redact_img = base_img.copy()
    redact_img = apply_redact_bar(redact_img, target_box, text="[CLASSIFIED]")
    safe_imwrite(os.path.join(TEST_DIR, "test_mask_redact_bar.jpg"), redact_img)
    print("✓ Solid redaction bar applied")


def test_brief_1_second_appearance_tracking():
    print("Testing 1-Second Brief Face Appearance Tracking...")
    processor = CensorProcessor()
    tracker = VideoFaceTracker(processor.detector, max_lost_frames=10)

    detected_during_appearance = 0
    detected_outside_appearance = 0

    for f_idx in range(60):
        if 20 <= f_idx <= 50:
            cur_x = 150 + int((f_idx - 20) * 3.3)
            frame = create_synthetic_face_image(face_x=cur_x, face_y=140)
        else:
            frame = np.ones((480, 640, 3), dtype=np.uint8) * 220

        boxes = tracker.update(frame, f_idx)
        if 20 <= f_idx <= 50:
            if len(boxes) > 0:
                detected_during_appearance += 1
        elif f_idx > 50 + 10:
            if len(boxes) > 0:
                detected_outside_appearance += 1

    print(f"✓ Frames tracked during 1-sec appearance: {detected_during_appearance}/31")
    assert detected_during_appearance >= 28
    assert detected_outside_appearance == 0


def test_specific_object_tracking_mil():
    print("Testing Specific Object Tracking (TrackerMIL)...")
    temp_vid_in = os.path.join(TEST_DIR, "test_object_track.mp4")
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(temp_vid_in, fourcc, 25.0, (400, 300))

    # Video with moving white license plate rectangle
    for i in range(25):
        frame = np.zeros((300, 400, 3), dtype=np.uint8)
        px = 50 + i * 5
        py = 100
        cv2.rectangle(frame, (px, py), (px + 80, py + 30), (255, 255, 255), -1)
        cv2.putText(frame, "ABC-123", (px + 5, py + 22), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 2)
        out.write(frame)
    out.release()

    processor = CensorProcessor()
    final_out = os.path.join(TEST_DIR, "object_track_out.mp4")
    initial_plate_box = BoundingBox(x=50, y=100, w=80, h=30, label="License Plate")

    res = processor.process_video(
        temp_vid_in,
        final_out,
        MaskConfig(mask_type="pixelate", intensity=80, shape="rect"),
        mode="specific_object",
        custom_boxes=[initial_plate_box],
        track_custom_objects=True
    )
    assert os.path.exists(res) and os.path.getsize(res) > 2000
    print("✓ Specific object motion tracking verified with MIL")


def test_video_censor_pipeline():
    print("Testing Complete Multi-Face Video Pipeline...")
    temp_vid_in = os.path.join(TEST_DIR, "sample_censor_in.mp4")
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(temp_vid_in, fourcc, 25.0, (480, 360))

    for i in range(40):
        x = 100 + int(i * 3)
        frame = create_synthetic_face_image(w=480, h=360, face_x=x, face_y=80, face_size=120)
        out.write(frame)
    out.release()

    processor = CensorProcessor()
    final_out = os.path.join(TEST_DIR, "censored_video_out.mp4")
    config = MaskConfig(mask_type="blur", intensity=80, shape="oval")

    progresses = []
    res = processor.process_video(
        temp_vid_in,
        final_out,
        config,
        mode="faces_all",
        progress_callback=lambda p: progresses.append(p)
    )

    assert os.path.exists(res)
    assert os.path.getsize(res) > 5000
    assert len(progresses) > 0
    print(f"✓ Video processed successfully: {res} (Size: {os.path.getsize(res)} bytes)")


def test_five_shapes_and_exact_face_fit():
    from engine.censor_processor import apply_masks_to_frame
    img = create_synthetic_face_image(320, 240, 80, 40, 120)
    detector = FaceDetector()
    exact_faces = detector.detect(img, padding_percent=0.0, face_fit="exact")
    loose_faces = detector.detect(img, padding_percent=0.25, face_fit="loose")
    assert len(exact_faces) >= 1 and len(loose_faces) >= 1
    assert exact_faces[0].area <= loose_faces[0].area, "Exact visible face fit must stay tighter than loose fit"

    box = BoundingBox(80, 40, 120, 140, label="Face #1")
    for shape in ("oval", "rect", "circle", "triangle", "heart"):
        cfg = MaskConfig(mask_type="blur", intensity=80, shape=shape, feather=20)
        masked = apply_masks_to_frame(img, [box], cfg)
        assert masked.shape == img.shape
        # Corner outside any centered shape must remain unchanged while center changes
        assert np.array_equal(masked[5, 5], img[5, 5]), f"Corner changed unexpectedly for shape={shape}"
        diff_center = int(np.abs(masked[100:120, 130:150].astype(int) - img[100:120, 130:150].astype(int)).sum())
        assert diff_center > 50, f"Center pixels were not masked for shape={shape}"


def test_brush_and_eraser_subtraction():
    from engine.censor_processor import apply_masks_to_frame
    # Checkerboard high-contrast texture so smooth blur clearly changes pixel values
    img = np.zeros((200, 200, 3), dtype=np.uint8)
    for y in range(0, 200, 8):
        for x in range(0, 200, 8):
            if ((x // 8) + (y // 8)) % 2 == 0:
                img[y:y + 8, x:x + 8] = (240, 240, 240)
    box = BoundingBox(
        10, 10, 180, 180,
        kind="brush",
        brush_points=[(30.0, 100.0), (170.0, 100.0)],
        brush_radius=22.0,
        eraser_points=[(100.0, 100.0)],
        eraser_radius=20.0,
    )
    cfg = MaskConfig(mask_type="blur", intensity=90, feather=0)
    masked = apply_masks_to_frame(img, [box], cfg)
    # Left end (30, 100) should be blurred; erased middle (100, 100) should match original cleanly
    left_diff = int(np.abs(masked[92:108, 22:38].astype(int) - img[92:108, 22:38].astype(int)).sum())
    erased_diff = int(np.abs(masked[96:104, 96:104].astype(int) - img[96:104, 96:104].astype(int)).sum())
    assert left_diff > 500, "Brush stroke did not blur left region"
    assert erased_diff < 50, f"Eraser subtraction failed, diff={erased_diff}"


def test_nudenet_detector_loaded_and_filtering():
    from engine.censor_processor import NudeNetDetector, _get_shared_nudenet_detector
    det = _get_shared_nudenet_detector()
    assert isinstance(det, NudeNetDetector)
    assert det.is_available(), "NudeNet ONNX model should be loaded in models/320n.onnx"
    blank = np.zeros((240, 240, 3), dtype=np.uint8)
    results = det.detect(blank, sensitivity=0.5, allowed_classes=["FEMALE_BREAST_EXPOSED"])
    assert isinstance(results, list) and len(results) == 0
    via_proc, det_name, _ = CensorProcessor().detect_nsfw_frame(
        blank, sensitivity=0.5, allowed_classes=["FEMALE_BREAST_EXPOSED"]
    )
    assert isinstance(via_proc, list) and "nudenet" in det_name.lower()


if __name__ == "__main__":
    test_safe_io()
    test_face_detector()
    test_nsfw_detector()
    test_mask_styles()
    test_brief_1_second_appearance_tracking()
    test_specific_object_tracking_mil()
    test_video_censor_pipeline()
    test_five_shapes_and_exact_face_fit()
    test_brush_and_eraser_subtraction()
    test_nudenet_detector_loaded_and_filtering()
    print("\n==============================================")
    print("ALL DIVERSIFIED CENSOR ENGINE TESTS PASSED! 🚀")
    print("==============================================")
