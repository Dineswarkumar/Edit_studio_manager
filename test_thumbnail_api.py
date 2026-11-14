import os
import requests
import json
import zipfile

BASE_URL = "http://127.0.0.1:8000"

def test_full_thumbnail_api():
    print("=== Testing Thumbnail Studio Pro API End-to-End ===")

    # 1. First upload a test video to get a real media item
    # Let's create a 3-second test mp4 using ffmpeg if one doesn't exist
    test_video_path = os.path.join("test_output", "test_video.mp4")
    os.makedirs("test_output", exist_ok=True)
    if not os.path.exists(test_video_path):
        import subprocess
        subprocess.run([
            "ffmpeg", "-y", "-f", "lavfi",
            "-i", "testsrc=duration=4:size=1280x720:rate=24",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            test_video_path
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    with open(test_video_path, "rb") as f:
        res = requests.post(f"{BASE_URL}/api/upload-media", files={"files": ("test_vid.mp4", f, "video/mp4")})
    assert res.status_code == 200, f"Upload failed: {res.text}"
    media_data = res.json()["media"][0]
    file_id = media_data["id"]
    duration = media_data["duration"]
    print(f"Uploaded video: {file_id}, duration: {duration}s")

    # 2. Test candidate extraction (3x3 = 9 frames)
    res = requests.post(f"{BASE_URL}/api/thumbnail/extract-candidates", json={
        "file_id": file_id,
        "count": 9,
        "start_sec": 0.5,
        "end_sec": 3.5
    })
    assert res.status_code == 200, f"Extract candidates failed: {res.text}"
    candidates = res.json()["candidates"]
    assert len(candidates) == 9, f"Expected 9 candidates, got {len(candidates)}"
    print(f"Extracted {len(candidates)} candidates successfully.")

    # 3. Test exact timestamp frame capture
    res = requests.post(f"{BASE_URL}/api/thumbnail/extract-single-frame", json={
        "file_id": file_id,
        "timestamp_sec": 1.25
    })
    assert res.status_code == 200, f"Extract single frame failed: {res.text}"
    exact_frame = res.json()
    assert "filename" in exact_frame, "No filename in exact frame response"
    print(f"Captured exact millisecond frame: {exact_frame['filename']}")

    # 4. Test storyboard contact sheet collage
    frame_filenames = [c["filename"] for c in candidates[:9]]
    res = requests.post(f"{BASE_URL}/api/thumbnail/generate-storyboard", json={
        "frame_filenames": frame_filenames,
        "rows": 3,
        "cols": 3,
        "aspect_ratio": "16:9"
    })
    assert res.status_code == 200, f"Storyboard failed: {res.text}"
    storyboard = res.json()
    assert "filename" in storyboard
    print(f"Generated 3x3 storyboard collage background: {storyboard['filename']}")

    # 5. Test Live Preview for all 6 aspect ratios including 3:4
    ratios = ["16:9", "9:16", "1:1", "4:5", "3:4", "4:3"]
    for ar in ratios:
        res = requests.post(f"{BASE_URL}/api/thumbnail/preview", json={
            "base_image_filename": candidates[0]["filename"],
            "aspect_ratio": ar,
            "fit_mode": "fill",
            "adjustments": {
                "saturation": 1.3,
                "contrast": 1.15,
                "vignette": 40
            },
            "text_items": [{
                "text": f"RATIO {ar}!",
                "font_family": "Impact",
                "font_size": 90,
                "color": "#ffee00",
                "stroke_width": 8,
                "stroke_color": "#000000",
                "angle": -4,
                "shadow": True,
                "bg_enabled": True,
                "bg_color": "#ff0000",
                "bg_opacity": 0.85,
                "custom_x": 0.5,
                "custom_y": 0.75
            }]
        })
        assert res.status_code == 200, f"Preview failed for ratio {ar}: {res.text}"
        prev = res.json()
        assert "preview_url" in prev
        print(f"Preview generated for {ar}: {prev['preview_url']}")

    # 6. Test Single Thumbnail Export (Lossless PNG)
    res = requests.post(f"{BASE_URL}/api/thumbnail/export", json={
        "base_image_filenames": [candidates[0]["filename"]],
        "aspect_ratio": "3:4",
        "fit_mode": "fill",
        "format": "png",
        "adjustments": { "saturation": 1.25, "contrast": 1.15, "vignette": 30 },
        "text_items": [{
            "text": "3:4 PINTEREST HIT",
            "font_family": "Arial Black",
            "font_size": 80,
            "color": "#ffffff",
            "stroke_width": 10,
            "stroke_color": "#ff0055",
            "shadow": True,
            "custom_x": 0.5,
            "custom_y": 0.85
        }]
    })
    assert res.status_code == 200, f"Single export failed: {res.text}"
    single_out = res.json()
    assert len(single_out["items"]) == 1
    assert single_out["items"][0]["filename"].endswith(".png")
    assert single_out["zip_url"] is None
    print(f"Single 3:4 PNG thumbnail exported: {single_out['items'][0]['filename']} ({single_out['items'][0]['size_bytes']} bytes)")

    # 7. Test Batch Export (Generated Main Thumbnail + All 9 Variations in ZIP bundle)
    res = requests.post(f"{BASE_URL}/api/thumbnail/export", json={
        "base_image_filenames": [storyboard["filename"]] + [c["filename"] for c in candidates],
        "aspect_ratio": "16:9",
        "fit_mode": "fill",
        "format": "jpg",
        "include_main_thumbnail": True,
        "adjustments": { "saturation": 1.3, "contrast": 1.2, "vignette": 35 },
        "text_items": [{
            "text": "EPIC YOUTUBE TITLE",
            "font_family": "Impact",
            "font_size": 100,
            "color": "#ffee00",
            "stroke_width": 10,
            "stroke_color": "#000000",
            "angle": -3,
            "shadow": True,
            "custom_x": 0.5,
            "custom_y": 0.8
        }]
    })
    assert res.status_code == 200, f"Batch export failed: {res.text}"
    batch_out = res.json()
    assert len(batch_out["items"]) == 10, f"Expected 10 items, got {len(batch_out['items'])}"
    assert batch_out["items"][0]["label"] == "Generated Thumbnail"
    assert batch_out["items"][1]["label"] == "Variation 1"
    assert batch_out["zip_url"] is not None

    zip_res = requests.get(f"{BASE_URL}{batch_out['zip_url']}")
    assert zip_res.status_code == 200, f"ZIP download failed: {zip_res.status_code}"
    import io
    with zipfile.ZipFile(io.BytesIO(zip_res.content), "r") as zf:
        names = zf.namelist()
        assert len(names) == 10, f"Expected 10 files in ZIP, got {len(names)}: {names}"
        assert any(n.endswith("_main.jpg") for n in names), f"Missing main thumbnail in ZIP: {names}"
        var_files = [n for n in names if "_variation_" in n]
        assert len(var_files) == 9, f"Expected 9 variations in ZIP, got {len(var_files)}: {names}"
    print(f"Batch exported: {len(batch_out['items'])} JPGs verified inside ZIP ({batch_out['zip_url']})")

    print("\nALL THUMBNAIL STUDIO API TESTS PASSED WITH 100% SUCCESS!")

if __name__ == "__main__":
    test_full_thumbnail_api()
