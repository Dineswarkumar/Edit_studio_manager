import os
import math
from typing import Tuple, Optional
from PIL import Image, ImageDraw, ImageFont, ImageColor, ImageOps
from .models import WatermarkLayer, WatermarkConfig, PositionType
from .font_manager import get_font

# Standard 1080p reference baseline for responsive watermark sizing across resolutions
BASE_REF_DIM = 1920.0

def hex_to_rgba(hex_color: str, opacity: float = 1.0) -> Tuple[int, int, int, int]:
    hex_color = hex_color.strip()
    try:
        rgb = ImageColor.getrgb(hex_color)
        alpha = int(max(0.0, min(1.0, opacity)) * 255)
        if len(rgb) == 4:
            return (rgb[0], rgb[1], rgb[2], int(rgb[3] * opacity))
        return (rgb[0], rgb[1], rgb[2], alpha)
    except Exception:
        return (255, 255, 255, int(opacity * 255))

def render_text_patch(layer: WatermarkLayer, ref_scale: float) -> Image.Image:
    """Renders a text watermark layer into a cropped, rotated transparent RGBA patch scaled to the media."""
    # Scale font size proportionally to media resolution
    scaled_font_size = max(10, int(layer.font_size * ref_scale))
    font = get_font(layer.font_family, scaled_font_size, layer.font_bold)
    text = layer.text or ""
    
    # Measure text bounding box
    dummy_img = Image.new("RGBA", (1, 1), (0, 0, 0, 0))
    dummy_draw = ImageDraw.Draw(dummy_img)
    bbox = dummy_draw.textbbox((0, 0), text, font=font)
    text_w = max(1, bbox[2] - bbox[0])
    text_h = max(1, bbox[3] - bbox[1])
    
    scaled_padding = max(4, int(layer.bg_padding * ref_scale)) if layer.bg_enabled else (
        max(2, int((layer.shadow_offset + 4) * ref_scale)) if layer.shadow_enabled else 2
    )
    patch_w = text_w + scaled_padding * 2
    patch_h = text_h + scaled_padding * 2
    
    patch = Image.new("RGBA", (patch_w, patch_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(patch)
    
    # Background badge
    if layer.bg_enabled:
        bg_rgba = hex_to_rgba(layer.bg_color, layer.bg_opacity * layer.opacity)
        scaled_radius = max(2, int(layer.bg_radius * ref_scale))
        draw.rounded_rectangle(
            [(0, 0), (patch_w - 1, patch_h - 1)],
            radius=scaled_radius,
            fill=bg_rgba
        )
        
    text_x = scaled_padding - bbox[0]
    text_y = scaled_padding - bbox[1]
    
    # Shadow
    if layer.shadow_enabled:
        shadow_rgba = hex_to_rgba(layer.shadow_color, 0.7 * layer.opacity)
        scaled_shadow_offset = max(1, int(layer.shadow_offset * ref_scale))
        draw.text(
            (text_x + scaled_shadow_offset, text_y + scaled_shadow_offset),
            text,
            font=font,
            fill=shadow_rgba
        )
        
    # Text fill + optional outline stroke
    fill_rgba = hex_to_rgba(layer.color, layer.opacity)
    stroke_w = max(1, int(getattr(layer, "stroke_width", 2) * ref_scale)) if getattr(layer, "stroke_enabled", False) else 0
    stroke_rgba = hex_to_rgba(getattr(layer, "stroke_color", "#000000"), layer.opacity) if stroke_w > 0 else None
    if stroke_w > 0:
        draw.text((text_x, text_y), text, font=font, fill=fill_rgba, stroke_width=stroke_w, stroke_fill=stroke_rgba)
    else:
        draw.text((text_x, text_y), text, font=font, fill=fill_rgba)
    
    # Rotate patch if angle != 0
    if abs(layer.rotation) > 0.01:
        patch = patch.rotate(layer.rotation, resample=Image.Resampling.BICUBIC, expand=True)
        
    return patch

def render_image_patch(layer: WatermarkLayer, ref_dim: float, uploads_dir: str) -> Optional[Image.Image]:
    """Loads and transforms an image/logo watermark layer into a transparent RGBA patch."""
    if not layer.image_filename:
        return None
        
    img_path = os.path.join(uploads_dir, layer.image_filename)
    if not os.path.exists(img_path):
        return None
        
    try:
        logo = Image.open(img_path).convert("RGBA")
    except Exception:
        return None
        
    # Scale logo proportionally to media reference dimension
    target_width = max(10, int(ref_dim * (layer.scale_percent / 100.0)))
    aspect = logo.height / logo.width
    target_height = max(10, int(target_width * aspect))
    
    logo = logo.resize((target_width, target_height), Image.Resampling.LANCZOS)
    
    # Apply overall opacity
    if layer.opacity < 0.999:
        r, g, b, a = logo.split()
        a = a.point(lambda p: int(p * max(0.0, min(1.0, layer.opacity))))
        logo = Image.merge("RGBA", (r, g, b, a))
        
    # Rotate if angle != 0
    if abs(layer.rotation) > 0.01:
        logo = logo.rotate(layer.rotation, resample=Image.Resampling.BICUBIC, expand=True)
        
    return logo

def compute_single_position(
    pos: PositionType,
    canvas_w: int,
    canvas_h: int,
    patch_w: int,
    patch_h: int,
    margin_x: int,
    margin_y: int,
    custom_x: float,
    custom_y: float
) -> Tuple[int, int]:
    """Calculates top-left (x, y) coordinate for placing a patch on the canvas."""
    if pos == "custom":
        x = int(custom_x * canvas_w - (patch_w / 2.0))
        y = int(custom_y * canvas_h - (patch_h / 2.0))
        return (x, y)
        
    # 9-point grid
    # Horizontal
    if "left" in pos:
        x = margin_x
    elif "right" in pos:
        x = canvas_w - patch_w - margin_x
    else: # center / middle
        x = (canvas_w - patch_w) // 2
        
    # Vertical
    if "top" in pos:
        y = margin_y
    elif "bottom" in pos:
        y = canvas_h - patch_h - margin_y
    else: # middle / center
        y = (canvas_h - patch_h) // 2
        
    return (x, y)

def create_watermark_overlay(
    canvas_size: Tuple[int, int],
    config: WatermarkConfig,
    uploads_dir: str
) -> Image.Image:
    """Creates a transparent RGBA image containing all configured watermark layers,
    proportional to canvas size to ensure 100% WYSIWYG parity between preview and export."""
    canvas_w, canvas_h = canvas_size
    overlay = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    
    # Scale factor relative to BASE_REF_DIM (1920px standard)
    ref_dim = max(canvas_w, canvas_h)
    ref_scale = ref_dim / BASE_REF_DIM
    
    for layer in config.layers:
        if not layer.enabled:
            continue
            
        if layer.layer_type == "text":
            patch = render_text_patch(layer, ref_scale)
        elif layer.layer_type == "image":
            patch = render_image_patch(layer, ref_dim, uploads_dir)
        else:
            continue
            
        if not patch:
            continue
            
        patch_w, patch_h = patch.size
        
        if layer.layout_mode == "tiled":
            # Tiled / repeating grid pattern with proportional spacing
            scaled_spacing_x = max(10, int(layer.tile_spacing_x * ref_scale))
            scaled_spacing_y = max(10, int(layer.tile_spacing_y * ref_scale))
            step_x = max(20, patch_w + scaled_spacing_x)
            step_y = max(20, patch_h + scaled_spacing_y)
            
            # Start off-screen to ensure full edge-to-edge coverage
            start_x = -step_x
            start_y = -step_y
            row_idx = 0
            
            for y in range(start_y, canvas_h + step_y, step_y):
                stagger_offset = (step_x // 2) if (layer.tile_stagger and row_idx % 2 == 1) else 0
                for x in range(start_x + stagger_offset, canvas_w + step_x, step_x):
                    overlay.alpha_composite(patch, dest=(x, y))
                row_idx += 1
        else:
            # Single placement (9-grid or custom drag coordinates)
            scaled_margin_x = int(layer.margin_x * ref_scale)
            scaled_margin_y = int(layer.margin_y * ref_scale)
            x, y = compute_single_position(
                layer.position,
                canvas_w, canvas_h,
                patch_w, patch_h,
                scaled_margin_x, scaled_margin_y,
                layer.custom_x, layer.custom_y
            )
            overlay.alpha_composite(patch, dest=(x, y))
            
    return overlay

def _save_to_target_size(
    img: Image.Image,
    output_path: str,
    fmt: str,
    target_size_mb: float,
    default_quality: int,
    subsampling: Optional[int] = None,
) -> None:
    """Binary-search JPEG/WebP quality (and gently downscale if still over target) to fit <= target_size_mb."""
    import io

    target_bytes = max(8 * 1024, int(float(target_size_mb) * 1024 * 1024))
    save_kwargs = {"optimize": True}
    if fmt == "WEBP":
        save_kwargs["method"] = 6
    elif subsampling is not None:
        save_kwargs["subsampling"] = subsampling

    def encode_bytes(candidate: Image.Image, q: int) -> bytes:
        buf = io.BytesIO()
        candidate.save(buf, fmt, quality=q, **save_kwargs)
        return buf.getvalue()

    working = img
    for _scale_step in range(4):
        lo, hi = 10, min(95, max(20, int(default_quality)))
        best_blob = None
        while lo <= hi:
            mid = (lo + hi) // 2
            blob = encode_bytes(working, mid)
            if len(blob) <= target_bytes:
                best_blob = blob
                lo = mid + 1
            else:
                hi = mid - 1
        if best_blob is not None:
            with open(output_path, "wb") as f:
                f.write(best_blob)
            return
        # If even q=10 exceeded target, downscale by 0.8x once per step
        nw, nh = max(64, int(working.width * 0.8)), max(64, int(working.height * 0.8))
        if (nw, nh) == working.size:
            break
        working = working.resize((nw, nh), Image.Resampling.LANCZOS)

    final_blob = encode_bytes(working, 10)
    with open(output_path, "wb") as f:
        f.write(final_blob)


def apply_watermark_to_image(
    input_path: str,
    output_path: str,
    config: WatermarkConfig,
    uploads_dir: str,
    output_quality: Optional[int] = None
) -> str:
    """Applies watermark overlay and/or compresses an image and saves the result."""
    base = Image.open(input_path)
    base = ImageOps.exif_transpose(base)
    orig_mode = base.mode
    
    settings = getattr(config, "export_settings", None)
    is_compress_only = settings and settings.mode == "compress_only"
    quality = output_quality if output_quality is not None else (settings.image_quality if settings else 90)
    target_mb = getattr(settings, "target_size_mb", None) if settings else None
    
    if is_compress_only:
        composite = base.convert("RGBA") if orig_mode in ["RGBA", "P"] else base.convert("RGB")
    else:
        working_base = base.convert("RGBA")
        overlay = create_watermark_overlay(working_base.size, config, uploads_dir)
        composite = Image.alpha_composite(working_base, overlay)
    
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    ext = os.path.splitext(output_path)[1].lower()
    if ext in [".jpg", ".jpeg"]:
        final_img = composite.convert("RGB")
        subsampling = None if is_compress_only else 0
        if target_mb and float(target_mb) > 0:
            _save_to_target_size(final_img, output_path, "JPEG", float(target_mb), quality, subsampling=subsampling)
        elif is_compress_only:
            # Standard 4:2:0 subsampling actually reduces JPEG size; 4:4:4 inflates q85/q95 exports.
            final_img.save(output_path, "JPEG", quality=quality, optimize=True)
        else:
            final_img.save(output_path, "JPEG", quality=quality, subsampling=0, optimize=True)
    elif ext == ".png":
        composite.save(output_path, "PNG", optimize=True)
    elif ext == ".webp":
        if target_mb and float(target_mb) > 0:
            _save_to_target_size(composite, output_path, "WEBP", float(target_mb), quality)
        else:
            composite.save(output_path, "WEBP", quality=quality, method=6)
    elif ext in [".tif", ".tiff"]:
        composite.convert("RGB").save(output_path, "TIFF", compression="tiff_deflate")
    else:
        if orig_mode == "RGB":
            composite.convert("RGB").save(output_path)
        else:
            composite.save(output_path)
            
    return output_path
