"""
Hardware acceleration probing and FFmpeg encoder argument helpers.
Targets Intel Quick Sync Video (h264_qsv) on Intel i9/Iris Xe with clean
automatic fallback to libx264 when QSV is unavailable or fails on edge streams.
"""
from __future__ import annotations

import logging
import subprocess
from functools import lru_cache
from typing import Callable, List, Optional, Tuple

logger = logging.getLogger("framestudio.hw_accel")


@lru_cache(maxsize=1)
def detect_best_h264_encoder() -> str:
    """
    Probe FFmpeg with a real 1-frame encode to verify hardware H.264 works.
    Returns 'h264_qsv' when Intel Quick Sync encodes cleanly, else 'libx264'.
    """
    try:
        proc = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=256x256:d=0.1:r=10",
                "-c:v",
                "h264_qsv",
                "-pix_fmt",
                "nv12",
                "-frames:v",
                "2",
                "-f",
                "null",
                "-",
            ],
            capture_output=True,
            text=True,
            timeout=8,
        )
        if proc.returncode == 0:
            logger.info("Hardware acceleration enabled: h264_qsv")
            return "h264_qsv"
        logger.info("h264_qsv probe failed (code=%s): %s", proc.returncode, (proc.stderr or "").strip()[:200])
    except Exception as exc:
        logger.info("h264_qsv probe error (%s); using libx264", exc)
    return "libx264"


def get_encoder_info() -> dict:
    """Return hardware encoder capability summary for diagnostics/UI."""
    best = detect_best_h264_encoder()
    return {
        "h264_encoder": best,
        "hardware_accelerated": best != "libx264",
        "fallback": "libx264",
    }


def build_h264_encode_args(
    encoder: Optional[str] = None,
    *,
    crf: int = 23,
    target_bitrate_kbps: Optional[int] = None,
    preset: str = "fast",
) -> List[str]:
    """
    Build FFmpeg `-c:v ...` encoder arguments for either `h264_qsv` or `libx264`.
    If `target_bitrate_kbps` is provided, emits constrained bitrate args.
    """
    enc = encoder or detect_best_h264_encoder()
    if enc == "h264_qsv":
        qsv_preset = "medium" if preset in ("medium", "slow", "veryslow") else "fast"
        args = ["-c:v", "h264_qsv", "-preset", qsv_preset]
        if target_bitrate_kbps and target_bitrate_kbps > 0:
            br = f"{max(100, int(target_bitrate_kbps))}k"
            maxrate = f"{max(120, int(target_bitrate_kbps * 1.25))}k"
            buf = f"{max(200, int(target_bitrate_kbps * 2))}k"
            args += ["-b:v", br, "-maxrate", maxrate, "-bufsize", buf]
        else:
            qsv_q = max(14, min(42, int(crf) + 2))
            args += ["-global_quality", str(qsv_q)]
        return args

    # Software libx264 fallback
    sw_preset = preset if preset in ("ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow") else "fast"
    args = ["-c:v", "libx264", "-preset", sw_preset, "-pix_fmt", "yuv420p"]
    if target_bitrate_kbps and target_bitrate_kbps > 0:
        br = f"{max(100, int(target_bitrate_kbps))}k"
        maxrate = f"{max(120, int(target_bitrate_kbps * 1.25))}k"
        buf = f"{max(200, int(target_bitrate_kbps * 2))}k"
        args += ["-b:v", br, "-maxrate", maxrate, "-bufsize", buf]
    else:
        args += ["-crf", str(max(14, min(40, int(crf))))]
    return args


def run_ffmpeg_with_fallback(
    build_cmd: Callable[[str], List[str]],
    *,
    preferred_encoder: Optional[str] = None,
    timeout: Optional[int] = None,
) -> Tuple[subprocess.CompletedProcess, str]:
    """
    Run an FFmpeg command built for the best H.264 encoder, falling back
    automatically to `libx264` if the hardware encoder exits non-zero.
    Returns `(completed_process, encoder_used)`.
    """
    enc = preferred_encoder or detect_best_h264_encoder()
    cmd = build_cmd(enc)
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode == 0 or enc == "libx264":
        return proc, enc

    logger.warning(
        "FFmpeg %s failed (code=%s), retrying cleanly with libx264: %s",
        enc,
        proc.returncode,
        (proc.stderr or "")[-300:],
    )
    sw_cmd = build_cmd("libx264")
    sw_proc = subprocess.run(sw_cmd, capture_output=True, text=True, timeout=timeout)
    return sw_proc, "libx264"
