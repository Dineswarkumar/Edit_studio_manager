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


if __name__ == "__main__":
    test_api_censor_image_flow()
    test_api_censor_video_flow()
    test_api_censor_video_single_face_flow()
    print("\n==============================================")
    print("ALL CENSOR API END-TO-END TESTS PASSED! 🚀")
    print("==============================================")
