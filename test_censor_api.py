"""
End-to-end API tests for Censor & Privacy Studio Pro endpoints in server.py
"""

import os
import time
import cv2
import numpy as np
from fastapi.testclient import TestClient
from server import app, uploaded_media, jobs
from test_censor import create_synthetic_face_image

client = TestClient(app)
TEST_DIR = "test_output/censor_api"
os.makedirs(TEST_DIR, exist_ok=True)


def test_api_censor_image_flow():
    print("=== Testing Censor & Privacy API (Image Flow) ===")
    
    # 1. Create and upload synthetic face image
    face_img = create_synthetic_face_image(640, 480, 200, 140, 160)
    img_path = os.path.join(TEST_DIR, "test_face_upload.jpg")
    cv2.imwrite(img_path, face_img)

    with open(img_path, "rb") as f:
        upload_res = client.post("/api/upload-media", files={"files": ("test_face_upload.jpg", f, "image/jpeg")})
    assert upload_res.status_code == 200
    media_list = upload_res.json()["media"]
    assert len(media_list) == 1
    file_id = media_list[0]["id"]
    print(f"✓ Uploaded test face image, file_id: {file_id}")

    # 2. Call detect-faces
    det_res = client.post("/api/censor/detect-faces", json={"file_id": file_id})
    assert det_res.status_code == 200
    det_data = det_res.json()
    faces = det_data["faces"]
    assert len(faces) >= 1, "Face detection endpoint did not find face!"
    face_box = faces[0]
    print(f"✓ Detected {len(faces)} face(s): [{face_box['x']}, {face_box['y']}, {face_box['w']}, {face_box['h']}]")

    # 2b. Call detect-nsfw endpoint
    nsfw_res = client.post("/api/censor/detect-nsfw", json={"file_id": file_id})
    assert nsfw_res.status_code == 200
    assert "candidates" in nsfw_res.json()
    print("✓ NSFW detection endpoint responded with candidates list")

    # 3. Call preview with Gaussian Blur
    prev_res = client.post("/api/censor/preview", json={
        "file_id": file_id,
        "boxes": [face_box],
        "mask_config": {
            "mask_type": "blur",
            "intensity": 70,
            "shape": "oval"
        }
    })
    assert prev_res.status_code == 200
    prev_url = prev_res.json()["preview_url"]
    assert "/api/thumbnails/" in prev_url
    print(f"✓ Generated blur preview: {prev_url}")

    # 4. Call preview with Emoji
    emoji_prev_res = client.post("/api/censor/preview", json={
        "file_id": file_id,
        "boxes": [face_box],
        "mask_config": {
            "mask_type": "emoji",
            "emoji_name": "sunglasses"
        }
    })
    assert emoji_prev_res.status_code == 200
    print(f"✓ Generated emoji preview: {emoji_prev_res.json()['preview_url']}")

    # 5. Process and export final image
    proc_res = client.post("/api/censor/process", json={
        "file_id": file_id,
        "boxes": [face_box],
        "mask_config": {
            "mask_type": "blur",
            "intensity": 85,
            "shape": "oval"
        }
    })
    assert proc_res.status_code == 200
    proc_data = proc_res.json()
    assert proc_data["type"] == "image"
    assert os.path.exists(os.path.join("outputs", proc_data["filename"]))
    print(f"✓ Exported masked image: {proc_data['filename']} (Size: {proc_data['size_bytes']} bytes)")


def test_api_censor_video_flow():
    print("\n=== Testing Censor & Privacy API (Video Tracking Flow) ===")

    # 1. Create a 1.5-second test video with moving face
    vid_path = os.path.join(TEST_DIR, "test_moving_face.mp4")
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(vid_path, fourcc, 25.0, (480, 360))
    for i in range(35):
        frame = create_synthetic_face_image(480, 360, face_x=80 + i * 4, face_y=70, face_size=110)
        out.write(frame)
    out.release()

    # 2. Upload video
    with open(vid_path, "rb") as f:
        upload_res = client.post("/api/upload-media", files={"files": ("test_moving_face.mp4", f, "video/mp4")})
    assert upload_res.status_code == 200
    file_id = upload_res.json()["media"][0]["id"]
    print(f"✓ Uploaded test video, file_id: {file_id}")

    # 3. Detect faces at second 0.5
    det_res = client.post("/api/censor/detect-faces", json={"file_id": file_id, "frame_sec": 0.5})
    assert det_res.status_code == 200
    faces = det_res.json()["faces"]
    assert len(faces) >= 1
    print(f"✓ Detected faces on video frame @ 0.5s: {len(faces)}")

    # 4. Trigger video tracking & censoring job
    proc_res = client.post("/api/censor/process", json={
        "file_id": file_id,
        "boxes": [], # Empty means auto-track all faces across video
        "mask_config": {
            "mask_type": "pixelate",
            "intensity": 65,
            "shape": "rect"
        }
    })
    assert proc_res.status_code == 200
    job_id = proc_res.json()["job_id"]
    print(f"✓ Video tracking job started: {job_id}")

    # 5. Poll job status until complete
    for _ in range(40):
        time.sleep(0.3)
        status_res = client.get(f"/api/job-status/{job_id}")
        assert status_res.status_code == 200
        job_info = status_res.json()
        if job_info["status"] == "completed":
            print(f"✓ Video job completed! File: {job_info['filename']} (Size: {job_info['size_bytes']} bytes)")
            assert os.path.exists(os.path.join("outputs", job_info["filename"]))
            return
        elif job_info["status"] == "failed":
            raise RuntimeError(f"Video job failed: {job_info.get('error')}")

    raise TimeoutError("Video censor job timed out!")


def test_api_censor_video_single_face_flow():
    print("\n=== Testing Censor & Privacy API (Single-Face Focus Video Flow) ===")

    # 1. Create a 1-second video with a face
    vid_path = os.path.join(TEST_DIR, "test_single_face.mp4")
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(vid_path, fourcc, 25.0, (480, 360))
    for i in range(25):
        frame = create_synthetic_face_image(480, 360, face_x=100 + i * 2, face_y=80, face_size=110)
        out.write(frame)
    out.release()

    # 2. Upload video
    with open(vid_path, "rb") as f:
        upload_res = client.post("/api/upload-media", files={"files": ("test_single_face.mp4", f, "video/mp4")})
    assert upload_res.status_code == 200
    file_id = upload_res.json()["media"][0]["id"]

    # 3. Detect faces
    det_res = client.post("/api/censor/detect-faces", json={"file_id": file_id, "frame_sec": 0.0})
    assert det_res.status_code == 200
    faces = det_res.json()["faces"]
    assert len(faces) >= 1
    face_to_focus = faces[0]

    # 4. Trigger video tracking & censoring job in single-face mode
    proc_res = client.post("/api/censor/process", json={
        "file_id": file_id,
        "mode": "face_single",
        "selected_track_id": face_to_focus["track_id"],
        "selected_face_box": face_to_focus,
        "mask_config": {
            "mask_type": "blur",
            "intensity": 70,
            "shape": "oval"
        }
    })
    assert proc_res.status_code == 200
    job_id = proc_res.json()["job_id"]
    print(f"✓ Single-face video tracking job started: {job_id}")

    # 5. Poll job status until complete
    for _ in range(40):
        time.sleep(0.3)
        status_res = client.get(f"/api/job-status/{job_id}")
        assert status_res.status_code == 200
        job_info = status_res.json()
        if job_info["status"] == "completed":
            print(f"✓ Single-face video job completed! File: {job_info['filename']} (Size: {job_info['size_bytes']} bytes)")
            disk_path = os.path.join("outputs", job_info["filename"])
            assert os.path.exists(disk_path)
            assert os.path.getsize(disk_path) > 1000

            # 6. Test download endpoint for clean filename
            dl_res = client.get(job_info["download_url"])
            assert dl_res.status_code == 200
            content_disp = dl_res.headers.get("content-disposition", "")
            print(f"✓ Download header verified: {content_disp}")
            assert "censored_test_single_face.mp4" in content_disp
            return
        elif job_info["status"] == "failed":
            raise RuntimeError(f"Single-face video job failed: {job_info.get('error')}")

    raise TimeoutError("Single-face video censor job timed out!")


def test_api_capabilities_and_shapes_preview():
    cap_res = client.get("/api/system/capabilities")
    assert cap_res.status_code == 200
    caps = cap_res.json()
    assert "hw_accel" in caps and "nudenet_available" in caps
    assert caps["nudenet_available"] is True

    # Upload an image and verify 5-shape + exact-face-fit preview
    img = create_synthetic_face_image(360, 280, 90, 40, 120)
    img_path = os.path.join(TEST_DIR, "shapes_preview.jpg")
    cv2.imwrite(img_path, img)
    with open(img_path, "rb") as f:
        up = client.post("/api/upload-media", files={"files": ("shapes_preview.jpg", f, "image/jpeg")})
    assert up.status_code == 200
    file_id = up.json()["media"][0]["id"]

    det = client.post("/api/censor/detect-faces", json={"file_id": file_id, "frame_sec": 0.0, "face_fit": "exact", "padding_percent": 0.0})
    assert det.status_code == 200
    assert len(det.json()["faces"]) >= 1

    for shape in ("circle", "triangle", "heart"):
        prev = client.post("/api/censor/preview", json={
            "file_id": file_id,
            "frame_sec": 0.0,
            "boxes": det.json()["faces"],
            "mask_config": {"mask_type": "blur", "intensity": 75, "feather": 25, "shape": shape}
        })
        assert prev.status_code == 200
        assert "preview_url" in prev.json()


def test_api_video_batch_and_error_isolation():
    vid1 = os.path.join(TEST_DIR, "batch_clip_1.mp4")
    vid2 = os.path.join(TEST_DIR, "batch_clip_2.mp4")
    for vp in (vid1, vid2):
        out = cv2.VideoWriter(vp, cv2.VideoWriter_fourcc(*"mp4v"), 15.0, (320, 240))
        for i in range(10):
            out.write(create_synthetic_face_image(320, 240, 90 + i * 2, 50, 90))
        out.release()

    with open(vid1, "rb") as f1, open(vid2, "rb") as f2:
        up = client.post("/api/upload-media", files=[
            ("files", ("batch_clip_1.mp4", f1, "video/mp4")),
            ("files", ("batch_clip_2.mp4", f2, "video/mp4")),
        ])
    assert up.status_code == 200
    media = up.json()["media"]
    assert len(media) == 2

    res = client.post("/api/censor/process-video-batch", json={
        "items": [
            {"file_id": media[0]["id"], "mode": "faces_all"},
            {"file_id": media[1]["id"], "mode": "faces_all"},
            {"file_id": "non_existent_clip_id", "mode": "faces_all"},
        ],
        "mask_config": {"mask_type": "blur", "intensity": 65, "shape": "heart"}
    })
    assert res.status_code == 200
    job_id = res.json()["job_id"]

    for _ in range(60):
        time.sleep(0.3)
        st = client.get(f"/api/job/{job_id}")
        assert st.status_code == 200
        job = st.json()
        if job["status"] == "completed":
            items = job.get("items", [])
            assert len(items) == 3
            ok_items = [it for it in items if it["status"] == "completed"]
            failed_items = [it for it in items if it["status"] == "failed"]
            assert len(ok_items) == 2 and len(failed_items) == 1
            assert job["download_url"].endswith(".zip") or "download" in job["download_url"]
            return
        elif job["status"] == "failed":
            raise RuntimeError(f"Batch video job failed unexpectedly: {job.get('error')}")
    raise TimeoutError("Batch video job timed out!")


def test_api_lan_pin_auth_guard():
    import core.state as app_state
    was_enabled = bool(app_state.lan_auth_state["enabled"])
    orig_pin = app_state.lan_auth_state["pin"]
    orig_tokens = set(app_state.lan_auth_state["tokens"])
    try:
        app_state.enable_lan_pin("123456")
        bad = client.post("/api/auth/lan-verify", json={"pin": "000000"})
        assert bad.status_code == 401
        ok = client.post("/api/auth/lan-verify", json={"pin": "123456"})
        assert ok.status_code == 200
        token = ok.json()["token"]
        assert app_state.is_lan_token_valid(token) is True
        status = client.get("/api/auth/lan-status")
        assert status.status_code == 200
        assert status.json()["lan_protected"] is True
    finally:
        if was_enabled and orig_pin:
            app_state.enable_lan_pin(orig_pin)
            app_state.lan_auth_state["tokens"].update(orig_tokens)
        else:
            app_state.disable_lan_pin()


def test_api_null_eraser_and_large_brush_radius():
    import socket
    from server import _resolve_bind_port

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    sock.bind(("0.0.0.0", 0))
    sock.listen(1)
    occupied = sock.getsockname()[1]
    try:
        resolved = _resolve_bind_port("0.0.0.0", occupied, allow_fallback=True)
        assert resolved != occupied and resolved > occupied
    finally:
        sock.close()

    img_path = os.path.join(TEST_DIR, "test_brush_payload.jpg")
    cv2.imwrite(img_path, create_synthetic_face_image(480, 360, face_x=150, face_y=80, face_size=140))
    with open(img_path, "rb") as f:
        up = client.post("/api/upload-media", files={"files": ("test_brush_payload.jpg", f, "image/jpeg")})
    assert up.status_code == 200
    fid = up.json()["media"][0]["id"]
    try:
        box = {
            "x": 140,
            "y": 70,
            "w": 160,
            "h": 160,
            "kind": "brush",
            "brush_points": [[160, 90], [220, 140]],
            "brush_radius": 1820,
            "eraser_points": [[190, 120]],
            "eraser_radius": None,
            "label": "Brush Mask #1",
        }
        prev = client.post("/api/censor/preview", json={"file_id": fid, "boxes": [box]})
        assert prev.status_code == 200, prev.text
        batch = client.post("/api/censor/process-batch", json={"items": [{"file_id": fid, "boxes": [box]}]})
        assert batch.status_code == 200, batch.text
        assert batch.json()["processed_count"] == 1
    finally:
        client.delete(f"/api/media/{fid}")


def test_api_nsfw_all_classes_and_ignores_eyes_region():
    from engine.censor_processor import NUDENET_FACE_CLASSES, NUDENET_LABELS
    page = client.get("/censor.html")
    assert page.status_code == 200
    html = page.text
    assert 'src="/censor.js"' not in html
    assert 'src="/js/censor.js' in html
    for needle in ('id="protectionTaskSection"', 'id="protectionModeSegments"', 'protection-mode-btn', 'id="panelNsfwMode"', 'id="nsfwPartsCheckboxes"'):
        assert needle in html, f"Missing expected UI element {needle} in served /censor.html"
    # Mode switcher must sit outside hidden mediaDetailsPanel so it is visible on initial page load
    assert html.index('id="protectionTaskSection"') < html.index('id="mediaDetailsPanel"')
    body_classes = [c for c in NUDENET_LABELS if c not in NUDENET_FACE_CLASSES]
    for cls in body_classes:
        assert f'value="{cls}"' in html, f"Missing NudeNet class checkbox in censor.html: {cls}"

    img_path = os.path.join(TEST_DIR, "test_nsfw_full_region.jpg")
    checker = np.zeros((240, 240, 3), dtype=np.uint8)
    for y in range(0, 240, 10):
        for x in range(0, 240, 10):
            if ((x // 10) + (y // 10)) % 2 == 0:
                checker[y:y + 10, x:x + 10] = (235, 235, 235)
    cv2.imwrite(img_path, checker)

    with open(img_path, "rb") as f:
        up = client.post("/api/upload-media", files={"files": ("test_nsfw_full_region.jpg", f, "image/jpeg")})
    assert up.status_code == 200
    fid = up.json()["media"][0]["id"]
    try:
        box = {"x": 40, "y": 40, "w": 160, "h": 160, "label": "NudeNet: Buttocks (Exposed)", "confidence": 0.9}
        proc = client.post("/api/censor/process", json={
            "file_id": fid,
            "mode": "nsfw",
            "boxes": [box],
            "mask_config": {"mask_type": "redact", "shape": "rect", "mask_region": "eyes", "redact_text": ""}
        })
        assert proc.status_code == 200, proc.text
        out_path = os.path.join("outputs", proc.json()["filename"])
        assert os.path.isfile(out_path)
        out_img = cv2.imread(out_path)
        # Bottom region inside box should be dark redaction (~18,18,18), not bright checkerboard
        assert float(out_img[150:190, 60:180].mean()) < 40.0
    finally:
        client.delete(f"/api/media/{fid}")


def test_api_per_class_nsfw_filtering_and_rotated_face_detect():
    from routers.censor import get_censor_processor

    # Upload a 90 deg CW rotated face image and confirm /api/censor/detect-faces recovers it
    img_path = os.path.join(TEST_DIR, "test_rot90_face.jpg")
    upright = create_synthetic_face_image(360, 360, face_x=110, face_y=90, face_size=130)
    rot90 = cv2.rotate(upright, cv2.ROTATE_90_CLOCKWISE)
    cv2.imwrite(img_path, rot90)

    with open(img_path, "rb") as f:
        up = client.post("/api/upload-media", files={"files": ("test_rot90_face.jpg", f, "image/jpeg")})
    assert up.status_code == 200
    fid = up.json()["media"][0]["id"]
    try:
        df = client.post("/api/censor/detect-faces", json={"file_id": fid, "padding_percent": 0.1})
        assert df.status_code == 200, df.text
        assert len(df.json()["faces"]) >= 1, "API failed to detect 90-degree rotated face"

        proc = get_censor_processor()
        orig_infer = proc.nudenet._infer_single_orientation

        def fake_multi_class(img_bgr, conf_threshold, active_classes):
            preds = [
                ([40.0, 40.0, 80.0, 80.0], 0.88, "BUTTOCKS_EXPOSED"),
                ([160.0, 120.0, 80.0, 80.0], 0.85, "FEMALE_BREAST_EXPOSED"),
            ]
            kept = [p for p in preds if p[2] in active_classes]
            return [p[0] for p in kept], [p[1] for p in kept], [p[2] for p in kept]

        proc.nudenet._infer_single_orientation = fake_multi_class
        try:
            r_butt = client.post("/api/censor/detect-nsfw", json={
                "file_id": fid,
                "sensitivity": 0.5,
                "exclude_faces": False,
                "nsfw_classes": ["BUTTOCKS_EXPOSED"],
            })
            assert r_butt.status_code == 200, r_butt.text
            cands = r_butt.json()["candidates"]
            assert len(cands) == 1 and "Buttocks" in cands[0]["label"]

            r_breast = client.post("/api/censor/detect-nsfw", json={
                "file_id": fid,
                "sensitivity": 0.5,
                "exclude_faces": False,
                "nsfw_classes": ["FEMALE_BREAST_EXPOSED"],
            })
            assert r_breast.status_code == 200, r_breast.text
            cands2 = r_breast.json()["candidates"]
            assert len(cands2) == 1 and "Breast" in cands2[0]["label"]
        finally:
            proc.nudenet._infer_single_orientation = orig_infer
    finally:
        client.delete(f"/api/media/{fid}")


if __name__ == "__main__":
    test_api_censor_image_flow()
    test_api_censor_video_flow()
    test_api_censor_video_single_face_flow()
    test_api_capabilities_and_shapes_preview()
    test_api_video_batch_and_error_isolation()
    test_api_lan_pin_auth_guard()
    test_api_null_eraser_and_large_brush_radius()
    test_api_nsfw_all_classes_and_ignores_eyes_region()
    test_api_per_class_nsfw_filtering_and_rotated_face_detect()
    print("\n==============================================")
    print("ALL CENSOR API END-TO-END TESTS PASSED! 🚀")
    print("==============================================")
