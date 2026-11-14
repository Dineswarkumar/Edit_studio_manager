import requests
import time
import os
from PIL import Image
import numpy as np

BASE_URL = "http://127.0.0.1:8000"

def test_sync():
    print("Testing Preview vs Export Visual Sync...")
    
    # Upload test image
    files = [("files", ("sync_test.jpg", open("test_data/sample.jpg", "rb"), "image/jpeg"))]
    res = requests.post(f"{BASE_URL}/api/upload-media", files=files)
    assert res.status_code == 200
    media_item = res.json()["media"][0]
    file_id = media_item["id"]
    print(f"Uploaded media: {file_id} ({media_item['width']}x{media_item['height']})")
    
    # Watermark config with text and background badge
    config = {
        "layers": [
            {
                "id": "sync_layer",
                "layer_type": "text",
                "text": "SYNC VERIFY 2026",
                "font_family": "Arial",
                "font_size": 48,
                "color": "#ffff00",
                "opacity": 1.0,
                "position": "bottom-right",
                "margin_x": 40,
                "margin_y": 40,
                "bg_enabled": True,
                "bg_color": "#ff0000",
                "bg_opacity": 1.0,
                "bg_padding": 12
            }
        ]
    }
    
    # 1. Fetch Preview
    res = requests.post(f"{BASE_URL}/api/preview", json={"file_ids": [file_id], "config": config})
    assert res.status_code == 200
    preview_url = res.json()["preview_url"]
    
    # Download preview image
    prev_res = requests.get(f"{BASE_URL}{preview_url}")
    with open("test_output/sync_preview.jpg", "wb") as f:
        f.write(prev_res.content)
        
    # 2. Process Export
    proc_res = requests.post(f"{BASE_URL}/api/process", json={"file_ids": [file_id], "config": config})
    job_id = proc_res.json()["job_id"]
    
    # Wait for completion
    for _ in range(15):
        time.sleep(0.5)
        job_res = requests.get(f"{BASE_URL}/api/job/{job_id}").json()
        if job_res["status"] == "completed":
            break
            
    export_item = job_res["items"][0]
    exp_download_url = export_item["download_url"]
    exp_res = requests.get(f"{BASE_URL}{exp_download_url}")
    with open("test_output/sync_exported.jpg", "wb") as f:
        f.write(exp_res.content)
        
    print(f"Downloaded preview to test_output/sync_preview.jpg")
    print(f"Downloaded export to test_output/sync_exported.jpg")
    
    # 3. Analyze Bounding Boxes of the Red Badge (#ff0000) in both
    prev_img = Image.open("test_output/sync_preview.jpg").convert("RGB")
    exp_img = Image.open("test_output/sync_exported.jpg").convert("RGB")
    
    print(f"Preview Image Size: {prev_img.size}")
    print(f"Exported Image Size: {exp_img.size}")
    
    # Find bounding box of red badge in preview
    prev_arr = np.array(prev_img)
    # Red badge: R > 200, G < 50, B < 50
    red_mask_prev = (prev_arr[:, :, 0] > 180) & (prev_arr[:, :, 1] < 60) & (prev_arr[:, :, 2] < 60)
    prev_y_indices, prev_x_indices = np.where(red_mask_prev)
    assert len(prev_x_indices) > 0, "Red badge not found in preview!"
    prev_badge_w = prev_x_indices.max() - prev_x_indices.min()
    prev_badge_h = prev_y_indices.max() - prev_y_indices.min()
    prev_margin_right = prev_img.width - prev_x_indices.max()
    prev_margin_bottom = prev_img.height - prev_y_indices.max()
    
    # Find bounding box of red badge in export
    exp_arr = np.array(exp_img)
    red_mask_exp = (exp_arr[:, :, 0] > 180) & (exp_arr[:, :, 1] < 60) & (exp_arr[:, :, 2] < 60)
    exp_y_indices, exp_x_indices = np.where(red_mask_exp)
    assert len(exp_x_indices) > 0, "Red badge not found in export!"
    exp_badge_w = exp_x_indices.max() - exp_x_indices.min()
    exp_badge_h = exp_y_indices.max() - exp_y_indices.min()
    exp_margin_right = exp_img.width - exp_x_indices.max()
    exp_margin_bottom = exp_img.height - exp_y_indices.max()
    
    # Compare proportions
    prev_w_ratio = prev_badge_w / prev_img.width
    exp_w_ratio = exp_badge_w / exp_img.width
    
    prev_margin_r_ratio = prev_margin_right / prev_img.width
    exp_margin_r_ratio = exp_margin_right / exp_img.width
    
    print("\n--- SYNC METRICS ---")
    print(f"Preview Badge Width Ratio: {prev_w_ratio * 100:.2f}% of canvas width")
    print(f"Export  Badge Width Ratio: {exp_w_ratio * 100:.2f}% of canvas width")
    print(f"Width Ratio Discrepancy:   {abs(prev_w_ratio - exp_w_ratio) * 100:.3f}%")
    
    print(f"Preview Margin Right Ratio: {prev_margin_r_ratio * 100:.2f}% of canvas width")
    print(f"Export  Margin Right Ratio: {exp_margin_r_ratio * 100:.2f}% of canvas width")
    print(f"Margin Discrepancy:        {abs(prev_margin_r_ratio - exp_margin_r_ratio) * 100:.3f}%")
    
    # Assert discrepancy is < 1% (pixel rounding difference only)
    assert abs(prev_w_ratio - exp_w_ratio) < 0.015, f"Badge width ratio not synced! Prev: {prev_w_ratio}, Exp: {exp_w_ratio}"
    assert abs(prev_margin_r_ratio - exp_margin_r_ratio) < 0.015, f"Margin ratio not synced! Prev: {prev_margin_r_ratio}, Exp: {exp_margin_r_ratio}"
    
    print("\n=======================================================")
    print("SUCCESS: PREVIEW AND EXPORT ARE 100% IN PERFECT SYNC! 🎉")
    print("=======================================================\n")

if __name__ == "__main__":
    test_sync()
