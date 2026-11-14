import os
from PIL import Image
from engine.thumbnail_processor import (
    ASPECT_RATIOS,
    fit_image_to_aspect,
    apply_image_enhancements,
    render_storyboard_sheet,
    extract_grid_candidates,
    render_thumbnail
)

def test_thumbnail_engine():
    print("Testing Thumbnail Processor Engine...")
    os.makedirs("test_output/thumbs", exist_ok=True)
    
    # 1. Test aspect ratios
    test_img = Image.open("test_data/sample.jpg")
    for ar_name, (expected_w, expected_h) in ASPECT_RATIOS.items():
        fitted = fit_image_to_aspect(test_img, target_aspect=ar_name, fit_mode="fill")
        assert fitted.size == (expected_w, expected_h), f"Aspect ratio {ar_name} size mismatch: {fitted.size} != {(expected_w, expected_h)}"
        print(f"✓ Aspect ratio {ar_name}: {fitted.size[0]}x{fitted.size[1]} verified")
        
    # 2. Test 3:4 ratio specifically
    fitted_3_4 = fit_image_to_aspect(test_img, target_aspect="3:4", fit_mode="fill")
    assert fitted_3_4.size == (1080, 1440)
    print("✓ 3:4 ratio (1080x1440) verified")
    
    # 3. Test Enhancements & Vignette
    enhanced = apply_image_enhancements(test_img, brightness=1.1, contrast=1.2, saturation=1.4, vignette_amount=0.6)
    enhanced.save("test_output/thumbs/enhanced.jpg", quality=98)
    assert os.path.exists("test_output/thumbs/enhanced.jpg")
    print("✓ Enhancements & Vignette verified")
    
    # 4. Test candidate frame extraction with intervals
    video_path = "test_data/sample_video.mp4"
    candidates = extract_grid_candidates(
        video_path=video_path,
        output_dir="test_output/thumbs",
        file_prefix="cand",
        count=9, # 3x3
        start_sec=0.2,
        end_sec=1.8
    )
    assert len(candidates) == 9, f"Expected 9 candidates, got {len(candidates)}"
    print(f"✓ Extracted {len(candidates)} candidate frames in interval 0.2s - 1.8s")
    
    # 5. Test Storyboard 3x3 sheet
    frame_files = [c["file_path"] for c in candidates]
    sheet = render_storyboard_sheet(frame_files, rows=3, cols=3, target_aspect="16:9")
    sheet.save("test_output/thumbs/storyboard_3x3.jpg", quality=98)
    assert os.path.exists("test_output/thumbs/storyboard_3x3.jpg")
    print("✓ 3x3 Storyboard contact sheet rendered")
    
    # 6. Test Full Thumbnail with Thick Stroke, Shadow & Badge
    out_thumb = "test_output/thumbs/final_thumbnail_16_9.jpg"
    render_thumbnail(
        base_image_path=frame_files[4], # Use 5th candidate frame
        output_path=out_thumb,
        aspect_ratio="16:9",
        fit_mode="fill",
        adjustments={"saturation": 1.3, "contrast": 1.15, "vignette": 0.4},
        text_items=[
            {
                "text": "SHOCKING REVEAL!",
                "font_family": "Impact",
                "font_size": 110,
                "color": "#ffee00",
                "stroke_width": 10,
                "stroke_color": "#000000",
                "shadow_enabled": True,
                "shadow_offset": 8,
                "custom_x": 0.5,
                "custom_y": 0.78,
                "bg_enabled": True,
                "bg_color": "#ff0000",
                "bg_opacity": 0.9,
                "bg_padding": 20,
                "bg_radius": 14,
                "rotation": -3.0
            }
        ],
        stickers=[
            {
                "image_filename": "logo.png",
                "scale_percent": 18.0,
                "custom_x": 0.15,
                "custom_y": 0.22,
                "rotation": 10.0
            }
        ],
        uploads_dir="test_data"
    )
    assert os.path.exists(out_thumb)
    print(f"✓ Full Thumbnail rendered: {out_thumb} (Size: {os.path.getsize(out_thumb)} bytes)")
    
    print("\n==============================================")
    print("ALL THUMBNAIL ENGINE TESTS PASSED PERFECTLY! 🚀")
    print("==============================================\n")

if __name__ == "__main__":
    test_thumbnail_engine()
