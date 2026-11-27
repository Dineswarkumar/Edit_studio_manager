import os
import math
import subprocess
from typing import List, Tuple, Dict, Any, Optional
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageColor, ImageOps, ImageFilter, ImageEnhance
from .models import WatermarkConfig
from .font_manager import get_font
from .video_processor import get_video_info

ASPECT_RATIOS = {
    "16:9": (1920, 1080),
    "9:16": (1080, 1920),
    "1:1": (1080, 1080),
    "4:5": (1080, 1350),
    "3:4": (1080, 1440),
    "4:3": (1440, 1080),
}

def hex_to_rgba(hex_color: str, opacity: float = 1.0) -> Tuple[int, int, int, int]:
    try:
        rgb = ImageColor.getrgb(hex_color.strip())
        alpha = int(max(0.0, min(1.0, opacity)) * 255)
        if len(rgb) == 4:
            return (rgb[0], rgb[1], rgb[2], int(rgb[3] * opacity))
        return (rgb[0], rgb[1], rgb[2], alpha)
    except Exception:
        return (255, 255, 255, int(opacity * 255))

def extract_frames_at_timestamps(
    video_path: str,
    timestamps: List[float],
    output_dir: str,
    file_prefix: str
) -> List[Dict[str, Any]]:
    """Extracts high-resolution frames at specific timestamps using FFmpeg fast input seeking."""
    os.makedirs(output_dir, exist_ok=True)
    results = []
    
    for idx, ts in enumerate(timestamps):
        out_filename = f"{file_prefix}_f{idx}_{int(ts*1000)}.jpg"
        out_path = os.path.join(output_dir, out_filename)
        
        # Fast input seeking (-ss before -i)
        cmd = [
            "ffmpeg",
            "-y",
            "-ss", f"{ts:.3f}",
            "-i", video_path,
            "-vframes", "1",
            "-q:v", "2",
            out_path
        ]
        
        proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if os.path.exists(out_path):
            with Image.open(out_path) as im:
                w, h = im.size
            results.append({
                "index": idx,
                "timestamp_sec": round(ts, 2),
                "filename": out_filename,
                "file_path": out_path,
                "url": f"/api/thumbnails/{out_filename}",
                "width": w,
                "height": h
            })
            
    return results

def get_grid_candidate_timestamps(
    duration: float,
    count: int = 9,
    start_sec: float = 0.0,
    end_sec: Optional[float] = None,
) -> List[float]:
    """Choose evenly-spaced timestamps from already-audited video metadata."""
    start = max(0.0, min(start_sec, duration))
    end = duration if (end_sec is None or end_sec <= 0 or end_sec > duration) else end_sec
    if end <= start:
        end = duration

    span = end - start
    if count <= 1:
        return [start + span * 0.5]
    # Avoid the very first/last frame if possible.
    step = span / (count + 1)
    return [start + step * (i + 1) for i in range(count)]


def extract_grid_candidates(
    video_path: str,
    output_dir: str,
    file_prefix: str,
    count: int = 9,
    start_sec: float = 0.0,
    end_sec: Optional[float] = None,
    duration: Optional[float] = None,
) -> List[Dict[str, Any]]:
    """Extract evenly-spaced candidates, reusing duration when the video was audited."""
    if duration is None:
        duration = get_video_info(video_path)["duration"]
    timestamps = get_grid_candidate_timestamps(duration, count, start_sec, end_sec)
    return extract_frames_at_timestamps(video_path, timestamps, output_dir, file_prefix)

def fit_image_to_aspect(
    image: Image.Image,
    target_aspect: str = "16:9",
    fit_mode: str = "fill", # "fill" (crop to center), "fit" (letterbox with blur), "stretch"
    resolution_scale: int = 1,
) -> Image.Image:
    """Scales and crops/letterboxes image to exact target aspect ratio with high quality."""
    if target_aspect not in ASPECT_RATIOS:
        return image
        
    resolution_scale = max(1, min(2, int(resolution_scale)))
    base_w, base_h = ASPECT_RATIOS[target_aspect]
    target_w, target_h = base_w * resolution_scale, base_h * resolution_scale
    target_ratio = target_w / target_h
    orig_w, orig_h = image.size
    orig_ratio = orig_w / orig_h
    
    if fit_mode == "stretch":
        return image.resize((target_w, target_h), Image.Resampling.LANCZOS)
        
    if fit_mode == "fill":
        # Zoom & center-crop to fill canvas without black bars
        if orig_ratio > target_ratio:
            # Original is wider than target: fit height, crop width
            new_h = target_h
            new_w = int(orig_w * (target_h / orig_h))
            resized = image.resize((new_w, new_h), Image.Resampling.LANCZOS)
            left = (new_w - target_w) // 2
            return resized.crop((left, 0, left + target_w, target_h))
        else:
            # Original is taller than target: fit width, crop height
            new_w = target_w
            new_h = int(orig_h * (target_w / orig_w))
            resized = image.resize((new_w, new_h), Image.Resampling.LANCZOS)
            top = (new_h - target_h) // 2
            return resized.crop((0, top, target_w, top + target_h))
            
    # fit_mode == "fit" (letterbox with blurred background of the same image)
    bg = image.resize((target_w, target_h), Image.Resampling.LANCZOS).filter(ImageFilter.GaussianBlur(radius=25))
    # Dim background slightly
    dimmer = Image.new("RGBA", (target_w, target_h), (0, 0, 0, 90))
    bg.paste(dimmer, (0, 0), dimmer)
    
    # Scale original image to fit within bounds
    scale = min(target_w / orig_w, target_h / orig_h)
    fw, fh = int(orig_w * scale), int(orig_h * scale)
    fg = image.resize((fw, fh), Image.Resampling.LANCZOS)
    
    dest_x = (target_w - fw) // 2
    dest_y = (target_h - fh) // 2
    bg.paste(fg, (dest_x, dest_y))
    return bg

def apply_image_enhancements(
    image: Image.Image,
    brightness: float = 1.0, # 0.5 to 1.5
    contrast: float = 1.0,   # 0.5 to 1.5
    saturation: float = 1.0, # 0.0 to 2.0 (color pop!)
    vignette_amount: float = 0.0 # 0.0 to 1.0
) -> Image.Image:
    """Applies visual color/contrast grading and optional edge vignette."""
    working = image.convert("RGB")
    
    if abs(brightness - 1.0) > 0.01:
        working = ImageEnhance.Brightness(working).enhance(brightness)
    if abs(contrast - 1.0) > 0.01:
        working = ImageEnhance.Contrast(working).enhance(contrast)
    if abs(saturation - 1.0) > 0.01:
        working = ImageEnhance.Color(working).enhance(saturation)
        
    if vignette_amount > 0.01:
        amt = vignette_amount / 100.0 if vignette_amount > 1.0 else vignette_amount
        amt = max(0.0, min(1.0, amt))
        w, h = working.size
        y = np.linspace(-1.0, 1.0, h, dtype=np.float32)[:, None]
        x = np.linspace(-1.0, 1.0, w, dtype=np.float32)[None, :]
        dist = np.sqrt(x * x + y * y) / math.sqrt(2.0)
        falloff = np.clip((dist - 0.35) / 0.65, 0.0, 1.0) ** 1.8
        gain = 1.0 - (amt * 0.85) * falloff
        arr = np.asarray(working, dtype=np.float32) * gain[:, :, None]
        working = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")
        
    return working

def render_storyboard_sheet(
    frame_paths: List[str],
    rows: int = 3,
    cols: int = 3,
    target_aspect: str = "16:9",
    border_px: int = 8,
    border_color: str = "#000000",
    resolution_scale: int = 1,
) -> Image.Image:
    """Creates a multi-frame collage / contact sheet thumbnail (e.g. 2x2, 3x3, 4x4)."""
    rows = max(1, min(10, int(rows)))
    cols = max(1, min(10, int(cols)))
    border_px = max(0, min(100, int(border_px)))
    resolution_scale = max(1, min(2, int(resolution_scale)))
    base_w, base_h = ASPECT_RATIOS.get(target_aspect, (1920, 1080))
    target_w, target_h = base_w * resolution_scale, base_h * resolution_scale
    border_px = max(0, int(border_px)) * resolution_scale
    if (rows + 1) * border_px >= target_h or (cols + 1) * border_px >= target_w:
        border_px = min((target_w - 1) // (cols + 1), (target_h - 1) // (rows + 1), border_px)
    canvas = Image.new("RGB", (target_w, target_h), color=hex_to_rgba(border_color)[:3])
    
    total_slots = rows * cols
    avail_w = max(cols, target_w - (cols + 1) * border_px)
    avail_h = max(rows, target_h - (rows + 1) * border_px)
    
    for idx in range(total_slots):
        r = idx // cols
        c = idx % cols
        x1 = border_px + round(c * avail_w / cols) + c * border_px
        x2 = border_px + round((c + 1) * avail_w / cols) + c * border_px
        y1 = border_px + round(r * avail_h / rows) + r * border_px
        y2 = border_px + round((r + 1) * avail_h / rows) + r * border_px
        cw = max(1, x2 - x1)
        ch = max(1, y2 - y1)
        
        if idx < len(frame_paths) and os.path.exists(frame_paths[idx]):
            try:
                with Image.open(frame_paths[idx]) as img:
                    # Fit each source to the actual cell shape. Cropping every frame to
                    # 16:9 first and then stretching it into a square/portrait cell
                    # distorted the contact sheet badly.
                    cell_img = ImageOps.fit(
                        ImageOps.exif_transpose(img).convert("RGB"),
                        (cw, ch),
                        method=Image.Resampling.LANCZOS,
                        centering=(0.5, 0.5),
                    )
                    canvas.paste(cell_img, (x1, y1))
            except Exception:
                pass
                
    return canvas

def render_thumbnail_patch_text(text_item: dict, canvas_w: int, canvas_h: int) -> Image.Image:
    """Renders high-impact YouTube-style bold title text with stroke outline and drop shadow."""
    ref_scale = max(canvas_w, canvas_h) / 1920.0
    font_family = text_item.get("font_family", "Impact")
    font_size = max(16, int(text_item.get("font_size", 72) * ref_scale))
    bold = text_item.get("font_bold", True)
    font = get_font(font_family, font_size, bold)
    
    text = text_item.get("text", "MUST WATCH!")
    stroke_width = int(text_item.get("stroke_width", 6) * ref_scale)
    stroke_color = hex_to_rgba(text_item.get("stroke_color", "#000000"))
    text_color = hex_to_rgba(text_item.get("color", "#ffee00"))
    
    # Measure text bounding box and auto-fit within 92% of canvas width
    dummy = Image.new("RGBA", (1, 1), (0, 0, 0, 0))
    draw = ImageDraw.Draw(dummy)
    max_text_w = max(64, int(canvas_w * 0.92) - stroke_width * 2)
    bbox = draw.textbbox((0, 0), text, font=font, stroke_width=stroke_width)
    text_w = max(1, bbox[2] - bbox[0])
    if text_w > max_text_w and font_size > 16:
        scaled_size = max(16, int(font_size * (max_text_w / float(text_w))))
        font_size = scaled_size
        font = get_font(font_family, font_size, bold)
        stroke_width = max(1, int(stroke_width * (scaled_size / max(1, int(text_item.get("font_size", 72) * ref_scale)))))
        bbox = draw.textbbox((0, 0), text, font=font, stroke_width=stroke_width)
        text_w = max(1, bbox[2] - bbox[0])
    text_h = max(1, bbox[3] - bbox[1])
    
    pad = int(text_item.get("bg_padding", 16) * ref_scale) if text_item.get("bg_enabled", False) else stroke_width + 8
    patch_w = text_w + pad * 2
    patch_h = text_h + pad * 2
    
    patch = Image.new("RGBA", (patch_w, patch_h), (0, 0, 0, 0))
    draw_patch = ImageDraw.Draw(patch)
    
    # Background Badge Box
    if text_item.get("bg_enabled", False):
        bg_rgba = hex_to_rgba(text_item.get("bg_color", "#000000"), text_item.get("bg_opacity", 0.85))
        radius = int(text_item.get("bg_radius", 12) * ref_scale)
        draw_patch.rounded_rectangle(
            [(0, 0), (patch_w - 1, patch_h - 1)],
            radius=radius,
            fill=bg_rgba
        )
        
    text_x = pad - bbox[0]
    text_y = pad - bbox[1]
    
    # Drop Shadow
    if text_item.get("shadow_enabled", True):
        shadow_offset = max(2, int(text_item.get("shadow_offset", 4) * ref_scale))
        shadow_rgba = hex_to_rgba(text_item.get("shadow_color", "#000000"), 0.8)
        draw_patch.text(
            (text_x + shadow_offset, text_y + shadow_offset),
            text,
            font=font,
            fill=shadow_rgba,
            stroke_width=stroke_width,
            stroke_fill=shadow_rgba
        )
        
    # Text with Stroke
    draw_patch.text(
        (text_x, text_y),
        text,
        font=font,
        fill=text_color,
        stroke_width=stroke_width,
        stroke_fill=stroke_color
    )
    
    # Rotation
    rot = float(text_item.get("rotation", 0.0))
    if abs(rot) > 0.01:
        patch = patch.rotate(rot, resample=Image.Resampling.BICUBIC, expand=True)
        
    return patch

def render_thumbnail(
    base_image_path: str,
    output_path: str,
    aspect_ratio: str = "16:9",
    fit_mode: str = "fill",
    adjustments: Optional[dict] = None,
    text_items: Optional[List[dict]] = None,
    stickers: Optional[List[dict]] = None,
    uploads_dir: str = "",
    resolution_scale: int = 1,
) -> str:
    """Full-featured thumbnail compositing pipeline with high resolution, 0 quality loss."""
    with Image.open(base_image_path) as raw_base:
        base = ImageOps.exif_transpose(raw_base)
        
    # 1. Fit to target aspect ratio
    fitted = fit_image_to_aspect(
        base,
        target_aspect=aspect_ratio,
        fit_mode=fit_mode,
        resolution_scale=resolution_scale,
    )
    canvas_w, canvas_h = fitted.size
    
    # 2. Apply adjustments (Brightness, Contrast, Saturation, Vignette)
    adj = adjustments or {}
    enhanced = apply_image_enhancements(
        fitted,
        brightness=float(adj.get("brightness", 1.0)),
        contrast=float(adj.get("contrast", 1.0)),
        saturation=float(adj.get("saturation", 1.0)),
        vignette_amount=float(adj.get("vignette", 0.0))
    )
    
    canvas = enhanced.convert("RGBA")
    
    # 3. Secondary Stickers / Cutout Overlays
    if stickers:
        for st in stickers:
            fn = st.get("image_filename")
            if not fn:
                continue
            st_path = os.path.join(uploads_dir, fn)
            if not os.path.exists(st_path):
                continue
            try:
                with Image.open(st_path) as raw_st:
                    st_img = raw_st.convert("RGBA")
                scale_pct = float(st.get("scale_percent", 25.0))
                target_w = max(20, int(canvas_w * (scale_pct / 100.0)))
                aspect = st_img.height / st_img.width
                target_h = max(20, int(target_w * aspect))
                st_img = st_img.resize((target_w, target_h), Image.Resampling.LANCZOS)
                
                # Opacity & Rotation
                rot = float(st.get("rotation", 0.0))
                if abs(rot) > 0.01:
                    st_img = st_img.rotate(rot, resample=Image.Resampling.BICUBIC, expand=True)
                op = float(st.get("opacity", 1.0))
                if op < 0.999:
                    r, g, b, a = st_img.split()
                    a = a.point(lambda p: int(p * op))
                    st_img = Image.merge("RGBA", (r, g, b, a))
                    
                cx = float(st.get("custom_x", 0.5))
                cy = float(st.get("custom_y", 0.5))
                dest_x = int(cx * canvas_w - (st_img.width / 2.0))
                dest_y = int(cy * canvas_h - (st_img.height / 2.0))
                canvas.alpha_composite(st_img, dest=(dest_x, dest_y))
            except Exception as e:
                print(f"Error rendering sticker {fn}: {e}")
                
    # 4. Text Title Elements
    if text_items:
        for ti in text_items:
            patch = render_thumbnail_patch_text(ti, canvas_w, canvas_h)
            cx = float(ti.get("custom_x", 0.5))
            cy = float(ti.get("custom_y", 0.8))
            dest_x = int(cx * canvas_w - (patch.width / 2.0))
            dest_y = int(cy * canvas_h - (patch.height / 2.0))
            canvas.alpha_composite(patch, dest=(dest_x, dest_y))
            
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    ext = os.path.splitext(output_path)[1].lower()
    if ext == ".png":
        canvas.save(output_path, "PNG", optimize=True)
    else:
        canvas.convert("RGB").save(output_path, "JPEG", quality=98, subsampling=0)
        
    return output_path
