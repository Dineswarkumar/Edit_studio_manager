import os
import tempfile
import numpy as np
from PIL import Image
from engine.models import WatermarkConfig, WatermarkLayer, ExportSettings
from engine.image_processor import apply_watermark_to_image


def test_watermark_text_outline_stroke():
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "src.png")
        out_plain = os.path.join(tmp, "plain.png")
        out_stroked = os.path.join(tmp, "stroked.png")

        Image.new("RGB", (600, 400), (120, 130, 140)).save(src)

        base_layer = dict(
            id="l1",
            layer_type="text",
            text="SAMPLE STROKE",
            font_family="Arial",
            font_size=48,
            font_bold=True,
            color="#ffffff",
            shadow_enabled=False,
            bg_enabled=False,
            position="center",
            opacity=1.0,
        )
        apply_watermark_to_image(src, out_plain, WatermarkConfig(layers=[WatermarkLayer(**base_layer)]), tmp)
        apply_watermark_to_image(
            src,
            out_stroked,
            WatermarkConfig(
                layers=[
                    WatermarkLayer(
                        **base_layer,
                        stroke_enabled=True,
                        stroke_color="#ff0000",
                        stroke_width=6,
                    )
                ]
            ),
            tmp,
        )

        arr_plain = np.array(Image.open(out_plain).convert("RGB"))
        arr_stroked = np.array(Image.open(out_stroked).convert("RGB"))
        assert arr_plain.shape == arr_stroked.shape
        # Red channel minus blue channel should have significantly more strong red outline pixels
        red_mask = (arr_stroked[:, :, 0].astype(int) - arr_stroked[:, :, 2].astype(int)) > 120
        assert int(red_mask.sum()) > 100


def test_export_target_size_mb_jpeg_and_webp():
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "noisy.png")
        rng = np.random.default_rng(42)
        noise = rng.integers(0, 255, size=(1200, 1600, 3), dtype=np.uint8)
        Image.fromarray(noise).save(src)

        for ext in ("jpg", "webp"):
            out = os.path.join(tmp, f"compressed.{ext}")
            cfg = WatermarkConfig(
                layers=[],
                export_settings=ExportSettings(
                    mode="compress_only",
                    image_quality=92,
                    target_size_mb=0.05,
                ),
            )
            apply_watermark_to_image(src, out, cfg, tmp)
            assert os.path.exists(out)
            size_bytes = os.path.getsize(out)
            assert size_bytes <= 56 * 1024, f"{ext} output too large: {size_bytes} bytes"
