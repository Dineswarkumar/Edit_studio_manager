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
        
    # Resolution scaling expression
    res_map = {
        "1080p": "min(1920,iw)",
        "720p": "min(1280,iw)",
        "480p": "min(854,iw)"
    }
    scale_limit = res_map.get(settings.video_resolution)
    
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    overlay_temp_path = None
    out_ext = os.path.splitext(output_path)[1].lower()
    is_webm = out_ext == ".webm"

    if is_webm:
        vp9_crf = str(min(63, int(crf) + 6))
        video_codec_args = ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", vp9_crf]
        if preset_name == "master":
            codec_audio_args = ["-c:a", "copy"]
        elif preset_name == "compressed":
            codec_audio_args = ["-c:a", "libopus", "-b:a", "96k"]
        else:
            codec_audio_args = ["-c:a", "libopus", "-b:a", "128k"]
        container_args = []
    else:
        video_codec_args = ["-c:v", "libx264", "-preset", "veryfast", "-crf", crf, "-pix_fmt", "yuv420p"]
        codec_audio_args = audio_args
        container_args = ["-movflags", "+faststart"]

    pad_filter = "pad=ceil(iw/2)*2:ceil(ih/2)*2"

    try:
        cmd = ["ffmpeg", "-y", "-i", input_path]

        if is_compress_only:
            vf_chain = f"scale='{scale_limit}:-2',{pad_filter}" if scale_limit else pad_filter
            cmd.extend(["-vf", vf_chain])
            cmd.extend(video_codec_args)
            cmd.extend(codec_audio_args)
            cmd.extend([*container_args, output_path])
        else:
            # Watermark + Compression in a single pass
            overlay = create_watermark_overlay((width, height), config, uploads_dir)
            overlay_temp_path = output_path + ".overlay.png"
            overlay.save(overlay_temp_path, "PNG")

            cmd.extend(["-i", overlay_temp_path])

            if scale_limit:
                filter_graph = f"[0:v][1:v]overlay=0:0,scale='{scale_limit}:-2',{pad_filter}[outv]"
            else:
                filter_graph = f"[0:v][1:v]overlay=0:0,{pad_filter}[outv]"

            cmd.extend([
                "-filter_complex", filter_graph,
                "-map", "[outv]",
                "-map", "0:a?",
            ])
            cmd.extend(video_codec_args)
            cmd.extend(codec_audio_args)
            cmd.extend([*container_args, output_path])

        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
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
        if return_code != 0:
            rem = process.stderr.read()
            if rem:
                stderr_tail.append(rem.strip())
            if os.path.exists(output_path):
                try:
                    os.remove(output_path)
                except Exception:
                    pass
            err_msg = "\n".join(stderr_tail)[-1200:]
            raise RuntimeError(f"FFmpeg failed with exit code {return_code}: {err_msg}")
            
        if progress_callback:
            progress_callback(1.0)
            
        return output_path
    finally:
        if overlay_temp_path and os.path.exists(overlay_temp_path):
            try:
                os.remove(overlay_temp_path)
            except Exception:
                pass
