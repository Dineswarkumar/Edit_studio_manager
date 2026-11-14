import requests
import time
import os

BASE_URL = "http://127.0.0.1:8000"

def test_e2e():
    print("Testing Watermark Studio Pro E2E...")
    
    # Check index page
    res = requests.get(f"{BASE_URL}/")
    assert res.status_code == 200, f"Index failed: {res.status_code}"
    print("✓ Web app static page served successfully")
    
    # 1. Upload media files
    files = [
        ("files", ("sample.jpg", open("test_data/sample.jpg", "rb"), "image/jpeg")),
        ("files", ("sample_video.mp4", open("test_data/sample_video.mp4", "rb"), "video/mp4")),
    ]
    res = requests.post(f"{BASE_URL}/api/upload-media", files=files)
    assert res.status_code == 200, f"Upload media failed: {res.text}"
    media_data = res.json()["media"]
    assert len(media_data) == 2
    img_item = [m for m in media_data if m["media_type"] == "image"][0]
    vid_item = [m for m in media_data if m["media_type"] == "video"][0]
    print(f"✓ Uploaded {len(media_data)} media items (Image ID: {img_item['id']}, Video ID: {vid_item['id']})")
    
    # 2. Upload logo
    logo_file = {"file": ("logo.png", open("test_data/logo.png", "rb"), "image/png")}
    res = requests.post(f"{BASE_URL}/api/upload-watermark-logo", files=logo_file)
    assert res.status_code == 200, f"Upload logo failed: {res.text}"
    logo_data = res.json()
    logo_filename = logo_data["filename"]
    print(f"✓ Uploaded watermark logo: {logo_filename}")
    
    # 3. Test Preview endpoint
    preview_payload = {
        "file_ids": [img_item["id"]],
        "config": {
            "layers": [
                {
                    "id": "l_text",
                    "layer_type": "text",
                    "text": "CONFIDENTIAL WATERMARK",
                    "font_family": "Arial",
                    "font_size": 32,
                    "color": "#ffffff",
                    "opacity": 0.8,
                    "position": "bottom-right",
                    "bg_enabled": True,
                    "bg_color": "#000000",
                    "bg_opacity": 0.5
                },
                {
                    "id": "l_logo",
                    "layer_type": "image",
                    "image_filename": logo_filename,
                    "scale_percent": 15.0,
                    "opacity": 0.85,
                    "position": "top-left"
                }
            ]
        }
    }
    res = requests.post(f"{BASE_URL}/api/preview", json=preview_payload)
    assert res.status_code == 200, f"Preview failed: {res.text}"
    print(f"✓ Live preview generated: {res.json()['preview_url']}")
    
    # 4. Start Batch Processing
    process_payload = {
        "file_ids": [img_item["id"], vid_item["id"]],
        "config": preview_payload["config"]
    }
    res = requests.post(f"{BASE_URL}/api/process", json=process_payload)
    assert res.status_code == 200, f"Process start failed: {res.text}"
    job_id = res.json()["job_id"]
    print(f"✓ Batch process job created: {job_id}")
    
    # 5. Poll Job Status
    completed = False
    for attempt in range(20):
        time.sleep(1)
        res = requests.get(f"{BASE_URL}/api/job/{job_id}")
        assert res.status_code == 200
        job_status = res.json()
        print(f"   Job status: {job_status['status']} ({int(job_status['progress']*100)}%)")
        if job_status["status"] == "completed":
            completed = True
            break
            
    assert completed, "Job did not complete in time"
    print(f"✓ Batch job completed successfully with {len(job_status['items'])} items")
    
    # 6. Test ZIP Download
    res = requests.get(f"{BASE_URL}/api/download-zip/{job_id}")
    assert res.status_code == 200, f"ZIP download failed: {res.status_code}"
    assert len(res.content) > 1000, "ZIP archive is too small or empty"
    print(f"✓ ZIP bundle download verified (Size: {len(res.content)} bytes)")
    
    print("\n==========================================")
    print("ALL END-TO-END ACCEPTANCE TESTS PASSED! 🎉")
    print("==========================================\n")

if __name__ == "__main__":
    test_e2e()
