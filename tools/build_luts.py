"""
Generate 6 clean, studio-grade 17x17x17 Adobe .cube 3D LUT files in static/assets/luts/.
Adobe .cube triplet order: Red varies fastest, then Green, then Blue (matching FFmpeg lut3d).
"""
from __future__ import annotations

import os
import numpy as np

LUTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "assets", "luts")

LUT_METADATA = [
    ("teal_orange", "Teal & Orange", "Warm skin/highlights with cinematic cyan shadows"),
    ("kodak_2383", "Kodak 2383 Film", "Punchy print-film contrast and rich warm depth"),
    ("crisp_daylight", "Crisp Daylight", "Clean balanced contrast with subtle vibrance"),
    ("moody_noir", "Moody Noir", "High-contrast cool silver monochrome look"),
    ("warm_sunset", "Warm Sunset", "Golden-hour amber glow with gentle highlights"),
    ("matte_fade", "Matte Fade", "Lifted slate blacks and editorial pastel tones"),
]


def _smoothstep(x: np.ndarray, edge0: float, edge1: float) -> np.ndarray:
    t = np.clip((x - edge0) / max(1e-6, edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _s_curve(x: np.ndarray, strength: float) -> np.ndarray:
    c = x - 0.5
    return np.clip(x + strength * c * (1.0 - 4.0 * c * c), 0.0, 1.0)


def _apply_lut_style(name: str, rgb: np.ndarray) -> np.ndarray:
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    luma = 0.2126 * r + 0.7152 * g + 0.0722 * b

    if name == "teal_orange":
        shad = 1.0 - _smoothstep(luma, 0.12, 0.65)
        high = _smoothstep(luma, 0.38, 0.90)
        r2 = r - 0.11 * shad + 0.13 * high
        g2 = g + 0.02 * shad + 0.03 * high
        b2 = b + 0.14 * shad - 0.14 * high
        out = np.stack([r2, g2, b2], axis=-1)
        out = _s_curve(out, 0.30)
        return np.clip(luma[..., None] + (out - luma[..., None]) * 1.12, 0.0, 1.0)

    if name == "kodak_2383":
        out = _s_curve(rgb, 0.45)
        # Warm highlights, subtle deep green/blue shadow richness + lifted floor
        high = _smoothstep(luma, 0.45, 0.95)
        out[..., 0] += 0.05 * high
        out[..., 2] -= 0.04 * high
        out = np.clip(out * 0.96 + 0.02, 0.0, 1.0)
        l2 = (0.2126 * out[..., 0] + 0.7152 * out[..., 1] + 0.0722 * out[..., 2])[..., None]
        return np.clip(l2 + (out - l2) * 1.16, 0.0, 1.0)

    if name == "crisp_daylight":
        out = _s_curve(rgb, 0.22)
        out[..., 0] *= 0.99
        out[..., 2] = np.clip(out[..., 2] * 1.03, 0.0, 1.0)
        l2 = (0.2126 * out[..., 0] + 0.7152 * out[..., 1] + 0.0722 * out[..., 2])[..., None]
        return np.clip(l2 + (out - l2) * 1.15, 0.0, 1.0)

    if name == "moody_noir":
        mono = 0.28 * r + 0.59 * g + 0.13 * b
        mono = _s_curve(mono, 0.52)
        # Keep 12% cool slate tint
        tinted = np.stack([mono * 0.94, mono * 0.98, mono * 1.05], axis=-1)
        return np.clip(tinted * 0.88 + rgb * 0.12, 0.0, 1.0)

    if name == "warm_sunset":
        mid = _smoothstep(luma, 0.15, 0.85)
        r2 = r + 0.12 * mid
        g2 = g + 0.03 * mid
        b2 = b - 0.10 * mid
        out = np.stack([r2, g2, b2], axis=-1)
        out = _s_curve(out, 0.20)
        return np.clip(out * 0.98 + 0.015, 0.0, 1.0)

    if name == "matte_fade":
        out = _s_curve(rgb, 0.15)
        l2 = (0.2126 * out[..., 0] + 0.7152 * out[..., 1] + 0.0722 * out[..., 2])[..., None]
        out = l2 + (out - l2) * 0.78
        # Lift blacks smoothly to 0.065 and tame pure whites slightly
        out = out * 0.89 + 0.065
        out[..., 0] += 0.012
        out[..., 2] += 0.018
        return np.clip(out, 0.0, 1.0)

    return rgb


def write_cube_file(path: str, title: str, table: np.ndarray) -> None:
    size = table.shape[0]
    lines = [
        f'TITLE "{title}"',
        f"LUT_3D_SIZE {size}",
        "DOMAIN_MIN 0.0 0.0 0.0",
        "DOMAIN_MAX 1.0 1.0 1.0",
    ]
    flat = table.reshape(-1, 3)
    for r, g, b in flat:
        lines.append(f"{r:.6f} {g:.6f} {b:.6f}")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")


def main() -> None:
    os.makedirs(LUTS_DIR, exist_ok=True)
    n = 17
    axis = np.linspace(0.0, 1.0, n, dtype=np.float32)
    # Adobe .cube ordering: b slowest, g middle, r fastest -> meshgrid with indexing='ij' on (b, g, r)
    bb, gg, rr = np.meshgrid(axis, axis, axis, indexing="ij")
    identity = np.stack([rr, gg, bb], axis=-1)

    for lut_id, title, _desc in LUT_METADATA:
        graded = _apply_lut_style(lut_id, identity)
        out_path = os.path.join(LUTS_DIR, f"{lut_id}.cube")
        write_cube_file(out_path, title, graded)
        print(f"Generated {out_path} ({os.path.getsize(out_path)} bytes)")


if __name__ == "__main__":
    main()
