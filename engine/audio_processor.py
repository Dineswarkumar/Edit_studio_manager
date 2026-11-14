"""
Audio Booster & EBU R128 Normalizer Engine.
Supports ffprobe inspection, EBU R128 loudness measurement & 2-pass normalization,
manual gain boost, voice clarity EQ, high-pass rumble cut, FFT denoise,
true-peak limiting, and lossless `-c:v copy` audio replacement on video files.
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
import subprocess
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

logger = logging.getLogger("framestudio.audio")


class AudioBoostConfig(BaseModel):
    gain_db: float = Field(default=0.0, ge=-24.0, le=30.0)
    normalize_target_lufs: Optional[float] = Field(default=-14.0, ge=-32.0, le=-5.0)
    true_peak_db: float = Field(default=-1.5, ge=-6.0, le=-0.1)
    highpass_hz: int = Field(default=0, ge=0, le=300)
    voice_clarity: bool = False
    noise_reduce: bool = False
    limiter_enabled: bool = True
    output_format: str = "original"  # original, mp3, wav, m4a, flac
    bitrate_kbps: int = Field(default=192, ge=64, le=320)


def _extract_loudnorm_json(stderr_text: str) -> Optional[Dict[str, Any]]:
    # FFmpeg loudnorm prints a JSON block at the tail of stderr
    matches = re.findall(r"\{[^{}]*\"input_i\"[^{}]*\}", stderr_text, flags=re.DOTALL)
    if not matches:
        return None
    try:
        return json.loads(matches[-1])
    except json.JSONDecodeError:
        return None


def _parse_float(val: Any, default: Optional[float] = None) -> Optional[float]:
    try:
        f = float(val)
        if math.isfinite(f):
            return f
    except (TypeError, ValueError):
        pass
    return default


def analyze_audio_stats(src_path: str, *, pre_filter: Optional[str] = None) -> Dict[str, Any]:
    """
    Inspect stream metadata with ffprobe and measure EBU R128 integrated LUFS & true peak.
    """
    stats: Dict[str, Any] = {
        "has_audio": False,
        "has_video": False,
        "codec": None,
        "sample_rate": None,
        "channels": None,
        "duration": 0.0,
        "bitrate_kbps": None,
        "integrated_lufs": None,
        "true_peak_db": None,
        "lra": None,
        "loudnorm_raw": None,
    }

    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            src_path,
        ],
        capture_output=True,
        text=True,
        timeout=20,
    )
    if probe.returncode == 0 and probe.stdout.strip():
        try:
            meta = json.loads(probe.stdout)
            fmt = meta.get("format") or {}
            stats["duration"] = round(float(fmt.get("duration") or 0.0), 3)
            for stream in meta.get("streams") or []:
                ctype = stream.get("codec_type")
                if ctype == "video" and not stats["has_video"]:
                    stats["has_video"] = True
                elif ctype == "audio" and not stats["has_audio"]:
                    stats["has_audio"] = True
                    stats["codec"] = stream.get("codec_name")
                    stats["sample_rate"] = int(stream.get("sample_rate") or 0) or None
                    stats["channels"] = int(stream.get("channels") or 0) or None
                    br = stream.get("bit_rate") or fmt.get("bit_rate")
                    if br:
                        stats["bitrate_kbps"] = max(1, int(round(int(br) / 1000.0)))
        except Exception as exc:
            logger.warning("ffprobe JSON parse warning for %s: %s", src_path, exc)

    if not stats["has_audio"]:
        return stats

    af_chain = "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json"
    if pre_filter:
        af_chain = f"{pre_filter},{af_chain}"

    proc = subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-i", src_path, "-vn", "-af", af_chain, "-f", "null", "-"],
        capture_output=True,
        text=True,
        timeout=90,
    )
    ln = _extract_loudnorm_json(proc.stderr or "")
    if ln:
        stats["loudnorm_raw"] = ln
        lufs = _parse_float(ln.get("input_i"))
        tp = _parse_float(ln.get("input_tp"))
        lra = _parse_float(ln.get("input_lra"))
        if lufs is not None and lufs > -68.0:
            stats["integrated_lufs"] = round(lufs, 2)
        if tp is not None and tp > -80.0:
            stats["true_peak_db"] = round(tp, 2)
        if lra is not None:
            stats["lra"] = round(lra, 2)

    return stats


def _build_pre_filters(config: AudioBoostConfig) -> List[str]:
    filters: List[str] = []
    if config.highpass_hz > 0:
        filters.append(f"highpass=f={int(config.highpass_hz)}")
    if config.noise_reduce:
        filters.append("afftdn=nf=-25")
    if config.voice_clarity:
        filters.append("equalizer=f=180:width_type=q:width=1.0:g=1.5")
        filters.append("equalizer=f=3200:width_type=q:width=1.2:g=3.2")
    if abs(config.gain_db) > 0.05:
        filters.append(f"volume={config.gain_db:.2f}dB")
    return filters


def _audio_codec_args_for_ext(ext: str, bitrate_kbps: int) -> List[str]:
    ext = ext.lower()
    br = f"{max(64, min(320, int(bitrate_kbps)))}k"
    if ext == ".mp3":
        return ["-c:a", "libmp3lame", "-b:a", br]
    if ext == ".wav":
        return ["-c:a", "pcm_s16le"]
    if ext == ".flac":
        return ["-c:a", "flac"]
    if ext in (".ogg", ".oga"):
        return ["-c:a", "libvorbis", "-b:a", br]
    return ["-c:a", "aac", "-b:a", br]


def resolve_audio_output_ext(src_path: str, requested_format: str, has_video: bool) -> str:
    fmt = (requested_format or "original").strip().lower().lstrip(".")
    if fmt and fmt != "original":
        return f".{fmt}"
    src_ext = os.path.splitext(src_path)[1].lower()
    if has_video:
        return src_ext if src_ext in (".mp4", ".mov", ".mkv", ".webm") else ".mp4"
    return src_ext if src_ext in (".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg") else ".mp3"


def process_audio_file(src_path: str, out_path: str, config: AudioBoostConfig) -> Dict[str, Any]:
    """
    Process an audio or video file with EQ, noise reduction, gain, EBU R128 loudnorm,
    and true-peak safety limiting. Video streams are preserved via `-c:v copy` unless
    an audio-only output format is requested.
    """
    input_stats = analyze_audio_stats(src_path)
    if not input_stats["has_audio"]:
        raise ValueError("Selected media file has no audio stream to process.")

    pre_filters = _build_pre_filters(config)
    pre_chain = ",".join(pre_filters) if pre_filters else None

    filter_parts: List[str] = list(pre_filters)

    if config.normalize_target_lufs is not None:
        target_i = float(config.normalize_target_lufs)
        target_tp = float(config.true_peak_db)
        # Re-measure after pre_filters so 2-pass linear normalization accounts for EQ/gain
        measured = input_stats if not pre_chain else analyze_audio_stats(src_path, pre_filter=pre_chain)
        ln = measured.get("loudnorm_raw") or {}
        m_i = _parse_float(ln.get("input_i"))
        m_tp = _parse_float(ln.get("input_tp"))
        m_lra = _parse_float(ln.get("input_lra"))
        m_thresh = _parse_float(ln.get("input_thresh"))
        m_off = _parse_float(ln.get("target_offset"))

        if m_i is not None and m_i > -68.0 and m_tp is not None and m_lra is not None and m_thresh is not None and m_off is not None:
            filter_parts.append(
                f"loudnorm=I={target_i:.1f}:TP={target_tp:.1f}:LRA=11:"
                f"measured_I={m_i:.2f}:measured_TP={m_tp:.2f}:measured_LRA={m_lra:.2f}:"
                f"measured_thresh={m_thresh:.2f}:offset={m_off:.2f}:linear=true"
            )
        elif input_stats.get("integrated_lufs") is not None:
            filter_parts.append(f"loudnorm=I={target_i:.1f}:TP={target_tp:.1f}:LRA=11")

    if config.limiter_enabled:
        limit_lin = max(0.25, min(0.99, 10.0 ** (float(config.true_peak_db) / 20.0)))
        filter_parts.append(f"alimiter=limit={limit_lin:.4f}:attack=5:release=50")

    out_ext = os.path.splitext(out_path)[1].lower()
    audio_only_ext = out_ext in (".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg")
    keep_video = bool(input_stats["has_video"]) and not audio_only_ext

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    cmd = ["ffmpeg", "-y", "-v", "error", "-i", src_path]
    if keep_video:
        cmd += ["-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy"]
    else:
        cmd += ["-vn"]

    if filter_parts:
        cmd += ["-af", ",".join(filter_parts)]

    cmd += _audio_codec_args_for_ext(out_ext, config.bitrate_kbps)
    if keep_video and out_ext in (".mp4", ".mov", ".m4a"):
        cmd += ["-movflags", "+faststart"]
    elif not keep_video and out_ext == ".m4a":
        cmd += ["-movflags", "+faststart"]
    cmd.append(out_path)

    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if proc.returncode != 0:
        raise RuntimeError(f"FFmpeg audio processing failed: {(proc.stderr or '').strip()[-400:]}")

    output_stats = analyze_audio_stats(out_path)
    return {
        "output_path": out_path,
        "input_stats": input_stats,
        "output_stats": output_stats,
        "video_preserved": keep_video,
    }
