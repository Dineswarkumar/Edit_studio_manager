import os
import cv2
import numpy as np
from PIL import Image, ImageDraw
from engine.models import WatermarkConfig, WatermarkLayer
from engine.image_processor import apply_watermark_to_image
from engine.video_processor import apply_watermark_to_video, extract_video_frame

def run_tests():
    os.makedirs("test_data", exist_ok=True)
    os.makedirs("test_output", exist_ok=True)
    
    # 1. Create a test image (800x600 gradient)
    test_img_path = "test_data/sample.jpg"
    img = Image.new("RGB", (800, 600), color=(40, 60, 90))
    draw = ImageDraw.Draw(img)
    draw.rectangle([50, 50, 750, 550], outline=(100, 150, 200), width=3)
    draw.text((100, 100), "Original Sample Image Content", fill=(220, 220, 220))
    img.save(test_img_path)
    print("Created test image:", test_img_path)
    
    # 2. Create a test logo image (200x200 transparent star/circle)
    logo_path = "test_data/logo.png"
    logo = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    logo_draw = ImageDraw.Draw(logo)
    logo_draw.ellipse([10, 10, 190, 190], fill=(240, 180, 40, 230), outline=(255, 255, 255, 255), width=4)
    logo_draw.text((55, 85), "MY LOGO", fill=(30, 30, 30, 255))
    logo.save(logo_path)
    print("Created test logo:", logo_path)
    
    # 3. Create a short test video (640x480, 2 seconds, 30fps)
    test_video_path = "test_data/sample_video.mp4"
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(test_video_path, fourcc, 30.0, (640, 480))
    for i in range(60):
        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        frame[:, :] = (30, 40, 50)
        cv2.circle(frame, (100 + i * 7, 240), 40, (0, 200, 255), -1)
        cv2.putText(frame, f"Frame {i}", (50, 50), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)
        out.write(frame)
    out.release()
    print("Created test video:", test_video_path)
    
    # Test 4: Configure watermark with 2 layers:
    # Layer 1: Text badge at Bottom-Right
    # Layer 2: Image logo at Top-Left
    config = WatermarkConfig(layers=[
        WatermarkLayer(
            id="l1",
            layer_type="text",
            text="© 2026 Watermark Studio PRO",
            font_family="Arial",
            font_size=32,
            font_bold=True,
            color="#ffffff",
            opacity=0.9,
            position="bottom-right",
            margin_x=30,
            margin_y=30,
            bg_enabled=True,
            bg_color="#000000",
            bg_opacity=0.6,
            bg_padding=10
        ),
        WatermarkLayer(
            id="l2",
            layer_type="image",
            image_filename="logo.png",
            scale_percent=18.0,
            opacity=0.85,
            rotation=-15.0,
            position="top-left",
            margin_x=20,
            margin_y=20
        )
    ])
    
    # Test 5: Watermark Image
    out_img = "test_output/watermarked_image.jpg"
    apply_watermark_to_image(test_img_path, out_img, config, "test_data")
    assert os.path.exists(out_img), "Image output not created!"
    print(f"SUCCESS: Watermarked image created at {out_img} (Size: {os.path.getsize(out_img)} bytes)")
    
    # Test 6: Tiled Watermark on Image
    tiled_config = WatermarkConfig(layers=[
        WatermarkLayer(
            id="tile1",
            layer_type="text",
            text="PREVIEW - DO NOT COPY",
            font_family="Arial",
            font_size=28,
            color="#ffffff",
            opacity=0.3,
            rotation=-30.0,
            layout_mode="tiled",
            tile_spacing_x=80,
            tile_spacing_y=80
        )
    ])
    out_tiled_img = "test_output/tiled_image.jpg"
    apply_watermark_to_image(test_img_path, out_tiled_img, tiled_config, "test_data")
    assert os.path.exists(out_tiled_img), "Tiled image output not created!"
    print(f"SUCCESS: Tiled watermarked image created at {out_tiled_img}")
    
    # Test 7: Watermark Video
    out_vid = "test_output/watermarked_video.mp4"
    def on_prog(p):
        print(f"Video processing progress: {p*100:.1f}%")
        
    apply_watermark_to_video(test_video_path, out_vid, config, "test_data", progress_callback=on_prog)
    assert os.path.exists(out_vid), "Video output not created!"
    print(f"SUCCESS: Watermarked video created at {out_vid} (Size: {os.path.getsize(out_vid)} bytes)")
    
    print("\nALL ENGINE TESTS PASSED PERFECTLY!\n")

if __name__ == "__main__":
    run_tests()
