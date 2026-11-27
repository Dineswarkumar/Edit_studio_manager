"""
Color & 3D LUT Engine.
Handles Adobe .cube 3D LUT parsing, vectorized trilinear interpolation,
exposure/contrast/highlights/shadows/saturation/temperature/vignette/grain grading
for images, and FFmpeg lut3d + QSV/x264 hardware-accelerated grading for video.
"""
from __future__ import annotations

import logging
import os
import tempfile
from functools import lru_cache
from typing import Callable, List, Optional, Tuple

import numpy as np
from PIL import Image, ImageOps
from pydantic import BaseModel, Field

from core.state import STATIC_DIR, resolve_safe_path
from engine.hw_accel import build_h264_encode_args, run_ffmpeg_with_fallback
from engine.video_processor import get_video_info

logger = logging.getLogger("framestudio.color")

BUNDLED_LUTS_DIR = os.path.join(STATIC_DIR, "assets", "luts")

LUT_CATALOG = [
    {"id": "teal_orange", "label": "Teal & Orange", "description": "Warm highlights with cool teal shadows", "filename": "teal_orange.cube"},
    {"id": "kodak_2383", "label": "Kodak 2383 Film", "description": "Classic print-film contrast and warm depth", "filename": "kodak_2383.cube"},
    {"id": "crisp_daylight", "label": "Crisp Daylight", "description": "Clean bright tones with subtle vibrance", "filename": "crisp_daylight.cube"},
    {"id": "moody_noir", "label": "Moody Noir", "description": "High-contrast cool silver monochrome", "filename": "moody_noir.cube"},
    {"id": "warm_sunset", "label": "Warm Sunset", "description": "Golden amber warmth and soft roll-off", "filename": "warm_sunset.cube"},
    {"id": "matte_fade", "label": "Matte Fade", "description": "Lifted matte shadows and soft editorial tones", "filename": "matte_fade.cube"},
]


class ColorGradeConfig(BaseModel):
    lut_id: Optional[str] = None
    custom_lut_filename: Optional[str] = None
    lut_strength: float = Field(default=1.0, ge=0.0, le=1.0)
    exposure: float = Field(default=0.0, ge=-2.0, le=2.0)
    contrast: float = Field(default=1.0, ge=0.4, le=1.8)
    highlights: float = Field(default=0.0, ge=-1.0, le=1.0)
    shadows: float = Field(default=0.0, ge=-1.0, le=1.0)
    saturation: float = Field(default=1.0, ge=0.0, le=2.0)
    temperature: float = Field(default=0.0, ge=-1.0, le=1.0)
    vignette: float = Field(default=0.0, ge=0.0, le=1.0)
    grain: float = Field(default=0.0, ge=0.0, le=1.0)
    export_format: str = "original"
    image_quality: int = Field(default=92, ge=30, le=100)
    video_preset: str = "balanced"


@lru_cache(maxsize=16)
def _parse_cube_cached(abs_path: str, _mtime: float) -> Tuple[int, np.ndarray, np.ndarray, np.ndarray]:
    size: Optional[int] = None
    domain_min = np.array([0.0, 0.0, 0.0], dtype=np.float32)
    domain_max = np.array([1.0, 1.0, 1.0], dtype=np.float32)
    rows: List[List[float]] = []

    with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
        for raw_line in f:
            line = raw_line.split("#", 1)[0].strip()
            if not line:
                continue
            upper = line.upper()
            if upper.startswith("TITLE") or upper.startswith("LUT_1D_SIZE"):
                if upper.startswith("LUT_1D_SIZE"):
                    raise ValueError("Only 3D .cube LUTs (LUT_3D_SIZE) are supported.")
                continue
            if upper.startswith("LUT_3D_SIZE"):
                size = int(line.split()[1])
                continue
            if upper.startswith("DOMAIN_MIN"):
                vals = [float(x) for x in line.split()[1:4]]
                if len(vals) == 3:
                    domain_min = np.array(vals, dtype=np.float32)
                continue
            if upper.startswith("DOMAIN_MAX"):
                vals = [float(x) for x in line.split()[1:4]]
                if len(vals) == 3:
                    domain_max = np.array(vals, dtype=np.float32)
                continue

            parts = line.split()
            if len(parts) >= 3:
                rows.append([float(parts[0]), float(parts[1]), float(parts[2])])

    if size is None or size < 2:
        raise ValueError("Invalid .cube file: missing LUT_3D_SIZE")
    expected = size ** 3
    if len(rows) != expected:
        raise ValueError(f"Invalid .cube file: expected {expected} RGB entries, got {len(rows)}")

    # Adobe .cube stores B slowest, G middle, R fastest -> shape (size, size, size, 3) indexed [b, g, r]
    table = np.asarray(rows, dtype=np.float32).reshape((size, size, size, 3))
    return size, table, domain_min, domain_max


def load_cube_lut(path: str) -> Tuple[int, np.ndarray, np.ndarray, np.ndarray]:
    abs_path = os.path.abspath(path)
    return _parse_cube_cached(abs_path, os.path.getmtime(abs_path))


def _resolve_lut_path(config: ColorGradeConfig, lut_search_dirs: Optional[List[str]] = None) -> Optional[str]:
    if config.custom_lut_filename:
        for base_dir in lut_search_dirs or []:
            candidate = resolve_safe_path(base_dir, os.path.basename(config.custom_lut_filename))
            if os.path.isfile(candidate):
                return candidate

    if config.lut_id:
        for entry in LUT_CATALOG:
            if entry["id"] == config.lut_id:
                candidate = os.path.join(BUNDLED_LUTS_DIR, entry["filename"])
                if os.path.isfile(candidate):
                    return candidate
    return None


def apply_trilinear_lut(
    rgb: np.ndarray,
    size: int,
    table: np.ndarray,
    domain_min: np.ndarray,
    domain_max: np.ndarray,
) -> np.ndarray:
    """Chunked, in-place trilinear 3D LUT interpolation (~25 MB peak RAM even on 48 MP photos)."""
    orig_shape = rgb.shape
    flat = rgb.reshape(-1, 3)
    n_pixels = flat.shape[0]
    out = np.empty_like(flat, dtype=np.float32)

    denom = np.maximum(domain_max - domain_min, 1e-6).astype(np.float32)
    scale_max = np.float32(size - 1)
    chunk_size = 262_144  # 256K pixels per chunk (~20 MB scratch)

    for start in range(0, n_pixels, chunk_size):
        end = min(start + chunk_size, n_pixels)
        chunk = flat[start:end]

        norm = (chunk - domain_min) / denom
        np.clip(norm, 0.0, 1.0, out=norm)
        norm *= scale_max

        r_f = norm[:, 0]
        g_f = norm[:, 1]
        b_f = norm[:, 2]

        r0 = np.floor(r_f).astype(np.int32)
        g0 = np.floor(g_f).astype(np.int32)
        b0 = np.floor(b_f).astype(np.int32)

        r1 = np.minimum(r0 + 1, size - 1)
        g1 = np.minimum(g0 + 1, size - 1)
        b1 = np.minimum(b0 + 1, size - 1)

        dr = (r_f - r0)[:, None]
        dg = (g_f - g0)[:, None]
        db = (b_f - b0)[:, None]
        inv_dr = 1.0 - dr
        inv_dg = 1.0 - dg
        inv_db = 1.0 - db

        c00 = table[b0, g0, r0] * inv_dr
        c00 += table[b0, g0, r1] * dr

        c01 = table[b0, g1, r0] * inv_dr
        c01 += table[b0, g1, r1] * dr

        c0 = c00 * inv_dg
        c0 += c01 * dg

        c10 = table[b1, g0, r0] * inv_dr
        c10 += table[b1, g0, r1] * dr

        c11 = table[b1, g1, r0] * inv_dr
        c11 += table[b1, g1, r1] * dr

        c1 = c10 * inv_dg
        c1 += c11 * dg

        c0 *= inv_db
        c0 += c1 * db
        np.clip(c0, 0.0, 1.0, out=c0)
        out[start:end] = c0

    return out.reshape(orig_shape)


def apply_point_adjustments_rgb(
    rgb01: np.ndarray,
    config: ColorGradeConfig,
    lut_search_dirs: Optional[List[str]] = None,
) -> np.ndarray:
    """Apply LUT + exposure, contrast, highlights, shadows, saturation, temperature in float32 [0..1]."""
    out = rgb01.astype(np.float32, copy=True)

    # 1. Exposure (EV multiplier)
    if abs(config.exposure) > 1e-4:
        out *= np.float32(2.0 ** config.exposure)
        np.clip(out, 0.0, 1.0, out=out)

    # 2. Temperature (warm/cool balance)
    if abs(config.temperature) > 1e-4:
        t = float(config.temperature)
        out[..., 0] *= np.float32(1.0 + 0.14 * t)
        out[..., 1] *= np.float32(1.0 + 0.02 * t)
        out[..., 2] *= np.float32(1.0 - 0.14 * t)
        np.clip(out, 0.0, 1.0, out=out)

    # 3. Contrast (pivot around mid-gray 0.5)
    if abs(config.contrast - 1.0) > 1e-4:
        out -= 0.5
        out *= np.float32(config.contrast)
        out += 0.5
        np.clip(out, 0.0, 1.0, out=out)

    # 4. Shadows & Highlights tonal masks
    if abs(config.shadows) > 1e-4 or abs(config.highlights) > 1e-4:
        luma = (0.2126 * out[..., 0] + 0.7152 * out[..., 1] + 0.0722 * out[..., 2])[..., None]
        if abs(config.shadows) > 1e-4:
            shad_mask = np.clip((0.55 - luma) / 0.55, 0.0, 1.0) ** 1.5
            out += np.float32(config.shadows * 0.28) * shad_mask * (1.0 - out)
            np.clip(out, 0.0, 1.0, out=out)
        if abs(config.highlights) > 1e-4:
            high_mask = np.clip((luma - 0.45) / 0.55, 0.0, 1.0) ** 1.5
            out += np.float32(config.highlights * 0.28) * high_mask * out
            np.clip(out, 0.0, 1.0, out=out)

    # 5. Saturation
    if abs(config.saturation - 1.0) > 1e-4:
        luma = (0.2126 * out[..., 0] + 0.7152 * out[..., 1] + 0.0722 * out[..., 2])[..., None]
        out -= luma
        out *= np.float32(config.saturation)
        out += luma
        np.clip(out, 0.0, 1.0, out=out)

    # 6. 3D LUT with strength blend
    lut_path = _resolve_lut_path(config, lut_search_dirs)
    if lut_path and config.lut_strength > 1e-4:
        size, table, d_min, d_max = load_cube_lut(lut_path)
        lut_rgb = apply_trilinear_lut(out, size, table, d_min, d_max)
        alpha = np.float32(config.lut_strength)
        out *= np.float32(1.0 - alpha)
        out += lut_rgb * alpha
        np.clip(out, 0.0, 1.0, out=out)

    return out


def apply_spatial_effects_rgb(rgb01: np.ndarray, config: ColorGradeConfig) -> np.ndarray:
    out = rgb01
    h, w = out.shape[:2]

    if config.vignette > 1e-4 and h > 0 and w > 0:
        yy, xx = np.ogrid[:h, :w]
        ny = (yy - (h - 1) * 0.5) / max(1.0, h * 0.5)
        nx = (xx - (w - 1) * 0.5) / max(1.0, w * 0.5)
        dist = np.sqrt(nx * nx + ny * ny).astype(np.float32)
        t = np.clip((dist - 0.48) / 0.85, 0.0, 1.0)
        falloff = 1.0 - float(config.vignette) * 0.72 * (t * t * (3.0 - 2.0 * t))
        out = np.clip(out * falloff[..., None], 0.0, 1.0)

    if config.grain > 1e-4:
        rng = np.random.default_rng(1337)
        noise = rng.normal(0.0, float(config.grain) * 0.055, size=(h, w, 1)).astype(np.float32)
        out = np.clip(out + noise, 0.0, 1.0)

    return out


def apply_color_grade_to_image(
    src_path: str,
    out_path: str,
    config: ColorGradeConfig,
    lut_search_dirs: Optional[List[str]] = None,
    *,
    max_dim: Optional[int] = None,
) -> str:
    with Image.open(src_path) as raw_img:
        img = ImageOps.exif_transpose(raw_img)
        has_alpha = "A" in img.getbands()
        alpha_band = img.getchannel("A") if has_alpha else None
        rgb_img = img.convert("RGB")
        if max_dim and max(rgb_img.size) > max_dim:
            rgb_img.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)
            if alpha_band is not None:
                alpha_band = alpha_band.resize(rgb_img.size, Image.Resampling.LANCZOS)

        arr = np.asarray(rgb_img, dtype=np.float32) / 255.0
        graded = apply_point_adjustments_rgb(arr, config, lut_search_dirs)
        graded = apply_spatial_effects_rgb(graded, config)
        u8 = np.clip(np.round(graded * 255.0), 0, 255).astype(np.uint8)
        out_img = Image.fromarray(u8, mode="RGB")

        ext = os.path.splitext(out_path)[1].lower()
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        q = int(config.image_quality)
        if ext in (".jpg", ".jpeg"):
            out_img.save(out_path, "JPEG", quality=q, optimize=True)
        elif ext == ".webp":
            if alpha_band is not None:
                out_img.putalpha(alpha_band)
            out_img.save(out_path, "WEBP", quality=q, method=4)
        else:
            if alpha_band is not None:
                out_img = out_img.convert("RGBA")
                out_img.putalpha(alpha_band)
            out_img.save(out_path, "PNG", optimize=True)
    return out_path


def _bake_combined_cube(config: ColorGradeConfig, lut_search_dirs: Optional[List[str]], out_cube_path: str) -> None:
    size = 33
    axis = np.linspace(0.0, 1.0, size, dtype=np.float32)
    bb, gg, rr = np.meshgrid(axis, axis, axis, indexing="ij")
    identity = np.stack([rr, gg, bb], axis=-1)
    graded = apply_point_adjustments_rgb(identity, config, lut_search_dirs)
    flat = graded.reshape(-1, 3)

    lines = [
        'TITLE "Frame Studio Baked Color Grade"',
        f"LUT_3D_SIZE {size}",
        "DOMAIN_MIN 0.0 0.0 0.0",
        "DOMAIN_MAX 1.0 1.0 1.0",
    ]
    for r, g, b in flat:
        lines.append(f"{r:.6f} {g:.6f} {b:.6f}")
    with open(out_cube_path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")


def _escape_ffmpeg_filter_path(path: str) -> str:
    return os.path.abspath(path).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")


def apply_color_grade_to_video(
    src_path: str,
    out_path: str,
    config: ColorGradeConfig,
    lut_search_dirs: Optional[List[str]] = None,
    progress_cb: Optional[Callable[[float], None]] = None,
) -> Tuple[str, str]:
    """
    Grade a video natively in FFmpeg by baking point-wise color adjustments into a temporary 33^3 .cube LUT
    + optional vignette/grain filters + H.264 QSV/x264 encode.
    Returns (out_path, encoder_used).
    """
    info = get_video_info(src_path)
    has_audio = bool(info.get("has_audio", True))
    crf = 18 if config.video_preset == "master" else (28 if config.video_preset == "compressed" else 22)

    fd, temp_cube = tempfile.mkstemp(prefix="fs_baked_", suffix=".cube")
    os.close(fd)
    try:
        _bake_combined_cube(config, lut_search_dirs, temp_cube)
        escaped_cube = _escape_ffmpeg_filter_path(temp_cube)

        vf_parts = [f"lut3d=file='{escaped_cube}':interp=trilinear"]
        if config.vignette > 1e-4:
            angle = 0.25 + float(config.vignette) * 0.95
            vf_parts.append(f"vignette=angle={angle:.3f}")
        if config.grain > 1e-4:
            strength = max(1, min(35, int(round(config.grain * 24))))
            vf_parts.append(f"noise=alls={strength}:allf=t+u")
        vf_parts.append("scale=trunc(iw/2)*2:trunc(ih/2)*2")
        vf_chain = ",".join(vf_parts)

        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        if progress_cb:
            progress_cb(0.15)

        def build_cmd(enc: str) -> List[str]:
            chain = vf_chain + (",format=nv12" if enc == "h264_qsv" else "")
            cmd = ["ffmpeg", "-y", "-v", "error", "-i", src_path, "-vf", chain]
            cmd += build_h264_encode_args(enc, crf=crf, preset="fast")
            if has_audio:
                cmd += ["-c:a", "copy"]
            else:
                cmd += ["-an"]
            cmd += ["-movflags", "+faststart", out_path]
            return cmd

        proc, used_enc = run_ffmpeg_with_fallback(build_cmd)
        if proc.returncode != 0:
            raise RuntimeError(f"FFmpeg video color grading failed: {(proc.stderr or '').strip()[-400:]}")
        if progress_cb:
            progress_cb(1.0)
        return out_path, used_enc
    finally:
        if os.path.exists(temp_cube):
            try:
                os.remove(temp_cube)
            except OSError:
                pass
