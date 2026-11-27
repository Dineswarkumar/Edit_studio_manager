import os
import subprocess
import re
import cv2
from typing import Tuple, Optional, Callable
from PIL import Image
from .models import WatermarkConfig
from .image_processor import create_watermark_overlay

def get_video_info(video_path: str) -> dict:
    """Returns video width, height, fps, duration, and frame count using OpenCV."""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError(f"Could not open video file: {video_path}")
        
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / fps if fps > 0 else 0.0
    cap.release()
    
    return {
        "width": width,
        "height": height,
        "fps": fps,
        "total_frames": total_frames,
        "duration": duration
    }

def extract_video_frame(video_path: str, output_frame_path: str, timestamp_sec: float = 0.5) -> str:
    """Extracts a frame from video to an image file for preview."""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError(f"Could not open video file: {video_path}")
        
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    target_frame = int(timestamp_sec * fps)
    cap.set(cv2.CAP_PROP_POS_FRAMES, target_frame)
    
    success, frame = cap.read()
    if not success:
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        success, frame = cap.read()
        
    cap.release()
    
    if not success or frame is None:
        raise ValueError("Failed to extract preview frame from video")
        
    os.makedirs(os.path.dirname(output_frame_path), exist_ok=True)
    cv2.imwrite(output_frame_path, frame)
    return output_frame_path

def apply_watermark_to_video(
    input_path: str,
    output_path: str,
    config: WatermarkConfig,
    uploads_dir: str,
    progress_callback: Optional[Callable[[float], None]] = None
) -> str:
    """Renders watermark overlay and/or compresses video in a single high-performance FFmpeg pass."""
    info = get_video_info(input_path)
    width, height = info["width"], info["height"]
    duration = info["duration"]
    
    settings = config.export_settings
    is_compress_only = (settings.mode == "compress_only")
    
    # Configure compression presets
    preset_name = settings.video_preset
    if preset_name == "master":
        crf = "18"
        audio_args = ["-c:a", "copy"]
    elif preset_name == "compressed":
        crf = "28"
        audio_args = ["-c:a", "aac", "-b:a", "128k"]
    else: # balanced
        crf = "23"
        audio_args = ["-c:a", "aac", "-b:a", "160k"]
        
    # Orientation-aware resolution scaling: cap the long edge so portrait 4K -> 1080x1920, landscape 4K -> 1920x1080
    res_long_edge_map = {
        "1080p": 1920,
        "720p": 1280,
        "480p": 854,
    }
    max_long_edge = res_long_edge_map.get(settings.video_resolution)
    scale_filter = (
        f"scale='if(gte(iw,ih),min({max_long_edge},iw),-2)':'if(gte(iw,ih),-2,min({max_long_edge},ih))'"
        if max_long_edge
        else None
    )
    
    target_size_mb = getattr(settings, "target_size_mb", None)
    target_video_kbps = None
    if target_size_mb and float(target_size_mb) > 0 and duration > 0:
        audio_kbps = 0 if preset_name == "master" else (96 if preset_name == "compressed" else 128)
        total_kbps = (float(target_size_mb) * 8192.0) / max(1.0, duration)
        target_video_kbps = max(120, int(total_kbps - audio_kbps))

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    overlay_temp_path = None
    out_ext = os.path.splitext(output_path)[1].lower()
    is_webm = out_ext == ".webm"

    from engine.hw_accel import detect_best_h264_encoder, build_h264_encode_args
    encoders_to_try = ["libvpx-vp9"] if is_webm else (
        ["h264_qsv", "libx264"] if detect_best_h264_encoder() == "h264_qsv" else ["libx264"]
    )
    pad_filter = "pad=ceil(iw/2)*2:ceil(ih/2)*2"

    try:
        if not is_compress_only:
            overlay = create_watermark_overlay((width, height), config, uploads_dir)
            overlay_temp_path = output_path + ".overlay.png"
            overlay.save(overlay_temp_path, "PNG")

        last_err = ""
        for chosen_enc in encoders_to_try:
            if is_webm:
                vp9_crf = str(min(63, int(crf) + 6))
                if target_video_kbps:
                    video_codec_args = ["-c:v", "libvpx-vp9", "-b:v", f"{target_video_kbps}k"]
                else:
                    video_codec_args = ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", vp9_crf]
                if preset_name == "master":
                    codec_audio_args = ["-c:a", "copy"]
                elif preset_name == "compressed":
                    codec_audio_args = ["-c:a", "libopus", "-b:a", "96k"]
                else:
                    codec_audio_args = ["-c:a", "libopus", "-b:a", "128k"]
                container_args = []
            else:
                video_codec_args = build_h264_encode_args(
                    chosen_enc,
                    crf=int(crf),
                    target_bitrate_kbps=target_video_kbps,
                    preset="veryfast",
                )
                codec_audio_args = audio_args
                container_args = ["-movflags", "+faststart"] if out_ext in {".mp4", ".mov", ".m4v"} else []

            cmd = ["ffmpeg", "-y", "-i", input_path]
            if is_compress_only:
                vf_chain = f"{scale_filter},{pad_filter}" if scale_filter else pad_filter
                if chosen_enc == "h264_qsv":
                    vf_chain += ",format=nv12"
                cmd.extend(["-vf", vf_chain])
            else:
                cmd.extend(["-i", overlay_temp_path])
                if scale_filter:
                    filter_graph = f"[0:v][1:v]overlay=0:0,{scale_filter},{pad_filter}"
                else:
                    filter_graph = f"[0:v][1:v]overlay=0:0,{pad_filter}"
                if chosen_enc == "h264_qsv":
                    filter_graph += ",format=nv12"
                filter_graph += "[outv]"
                cmd.extend(["-filter_complex", filter_graph, "-map", "[outv]", "-map", "0:a?"])

            cmd.extend(video_codec_args)
            cmd.extend(codec_audio_args)
            cmd.extend([*container_args, output_path])

            process = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                universal_newlines=True,
                encoding="utf-8",
                errors="replace"
            )

            time_pattern = re.compile(r"time=(\d+):(\d+):(\d+\.\d+)")
            stderr_tail = []

            while True:
                line = process.stderr.readline()
                if not line and process.poll() is not None:
                    break

                if line:
                    stderr_tail.append(line.rstrip())
                    if len(stderr_tail) > 30:
                        stderr_tail.pop(0)
                    if duration > 0 and progress_callback:
                        match = time_pattern.search(line)
                        if match:
                            hours, mins, secs = match.groups()
                            current_time = float(hours) * 3600 + float(mins) * 60 + float(secs)
                            progress = min(1.0, current_time / duration)
                            progress_callback(progress)

            return_code = process.poll()
            if return_code == 0:
                if progress_callback:
                    progress_callback(1.0)
                return output_path

            rem = process.stderr.read()
            if rem:
                stderr_tail.append(rem.strip())
            if os.path.exists(output_path):
                try:
                    os.remove(output_path)
                except Exception:
                    pass
            last_err = "\n".join(stderr_tail)[-1200:]
            if chosen_enc != "h264_qsv":
                raise RuntimeError(f"FFmpeg failed with exit code {return_code}: {last_err}")

        raise RuntimeError(f"FFmpeg failed: {last_err}")
    finally:
        if overlay_temp_path and os.path.exists(overlay_temp_path):
            try:
                os.remove(overlay_temp_path)
            except Exception:
                pass
