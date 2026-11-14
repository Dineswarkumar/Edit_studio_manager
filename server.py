import os
import uuid
import shutil
import zipfile
import gzip
import io
import threading
import subprocess
import time
import json
import argparse
from urllib.parse import quote
from typing import List, Dict, Any, Optional, Literal, Set
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from engine.models import WatermarkConfig, WatermarkLayer
from engine.image_processor import apply_watermark_to_image, create_watermark_overlay
from engine.video_processor import apply_watermark_to_video, get_video_info, extract_video_frame
from engine.thumbnail_processor import (
    extract_grid_candidates,
    get_grid_candidate_timestamps,
    extract_frames_at_timestamps,
    render_storyboard_sheet,
    render_thumbnail,
    ASPECT_RATIOS
)
from engine.censor_processor import (
    CensorProcessor,
    BoundingBox,
    MaskConfig,
    apply_masks_to_frame,
    VideoFaceTracker,
    detect_nsfw_candidates,
    safe_imread,
    safe_imwrite
)
from PIL import Image, ImageOps

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOADS_DIR = os.path.join(BASE_DIR, "uploads")
OUTPUTS_DIR = os.path.join(BASE_DIR, "outputs")
THUMBS_DIR = os.path.join(BASE_DIR, "thumbnails")
STATIC_DIR = os.path.join(BASE_DIR, "static")

os.makedirs(UPLOADS_DIR, exist_ok=True)
os.makedirs(OUTPUTS_DIR, exist_ok=True)
os.makedirs(THUMBS_DIR, exist_ok=True)
os.makedirs(STATIC_DIR, exist_ok=True)


def url_segment(name: str) -> str:
    """Percent-encode a filename for use as a URL path segment.

    Original upload names may contain '#', '?', '%', spaces or emoji. Inserted
    raw into a URL, a '#' starts a fragment in the browser, so the server only
    ever receives the part before it and the download 404s. Encoding the whole
    segment keeps '#' as '%23' and every other character intact.
    """
    return quote(str(name), safe="")

app = FastAPI(title="Frame Studio API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8000", "http://localhost:8000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory storage for media files, jobs, and tab session file tracking
uploaded_media: Dict[str, dict] = {}
jobs: Dict[str, dict] = {}
jobs_lock = threading.RLock()
active_job_paths: Dict[str, Set[str]] = {}
session_files: Dict[str, Set[str]] = {}
session_files_lock = threading.RLock()
session_active_jobs: Dict[str, int] = {}
session_last_seen: Dict[str, float] = {}
pending_session_cleanup: Set[str] = set()
censor_preview_by_session: Dict[str, str] = {}
censor_preview_revision: Dict[str, int] = {}
censor_preview_lock = threading.RLock()


class _JobCancelledError(Exception):
    """Internal signal raised when an in-flight job is cancelled by the user."""


def resolve_safe_path(base_dir: str, filename: str, must_exist: bool = False) -> str:
    """Resolve a single flat filename inside base_dir without allowing path traversal."""
    if not filename or "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    base_abs = os.path.abspath(base_dir)
    target_abs = os.path.abspath(os.path.join(base_abs, filename))
    if target_abs == base_abs or os.path.commonpath([base_abs, target_abs]) != base_abs:
        raise HTTPException(status_code=400, detail="Invalid file path")
    if must_exist and not os.path.isfile(target_abs):
        raise HTTPException(status_code=404, detail="File not found")
    return target_abs


def register_session_file(session_id: Optional[str], file_path: str):
    """Associates an uploaded or generated file with a specific browser tab session."""
    if session_id and file_path:
        with session_files_lock:
            session_files.setdefault(session_id, set()).add(os.path.abspath(file_path))
            session_last_seen[session_id] = time.time()


def release_session_job(session_id: Optional[str]):
    """Decrement active job count for a session and run deferred cleanup if tab closed."""
    if not session_id:
        return
    should_cleanup = False
    with session_files_lock:
        remaining = session_active_jobs.get(session_id, 0) - 1
        if remaining <= 0:
            session_active_jobs.pop(session_id, None)
            should_cleanup = session_id in pending_session_cleanup
            pending_session_cleanup.discard(session_id)
        else:
            session_active_jobs[session_id] = remaining
    if should_cleanup:
        remove_session_files(session_id)


def remove_session_files(session_id: str) -> int:
    with session_files_lock:
        files_to_remove = session_files.pop(session_id, set())
        session_last_seen.pop(session_id, None)
    cleaned_count = 0
    for fpath in files_to_remove:
        try:
            if os.path.isfile(fpath):
                os.remove(fpath)
                cleaned_count += 1
        except Exception as e:
            print(f"Error removing {fpath}: {e}")
    to_remove_ids = [fid for fid, media in list(uploaded_media.items()) if media.get("session_id") == session_id]
    for fid in to_remove_ids:
        uploaded_media.pop(fid, None)
    with censor_preview_lock:
        censor_preview_by_session.pop(session_id, None)
        censor_preview_revision.pop(session_id, None)
    return cleaned_count


def run_janitor_cleanup(max_age_seconds: int = 7200):
    """Purges orphaned temp files and expired jobs older than max_age_seconds (default 2 hours)."""
    now = time.time()
    protected_paths: Set[str] = set()
    with jobs_lock:
        for job_id, job in list(jobs.items()):
            if job.get("status") == "in_progress":
                protected_paths.update(active_job_paths.get(job_id, set()))
            else:
                created_at = float(job.get("created_at") or 0)
                if created_at and (now - created_at > max_age_seconds):
                    jobs.pop(job_id, None)
                    active_job_paths.pop(job_id, None)

    with session_files_lock:
        for sid, paths in session_files.items():
            last_seen = session_last_seen.get(sid, 0)
            if session_active_jobs.get(sid, 0) > 0 or (now - last_seen <= max_age_seconds):
                protected_paths.update(paths)

    for directory in [UPLOADS_DIR, THUMBS_DIR, OUTPUTS_DIR]:
        if not os.path.exists(directory):
            continue
        for fname in os.listdir(directory):
            fpath = os.path.join(directory, fname)
            if os.path.isfile(fpath):
                try:
                    if os.path.abspath(fpath) in protected_paths:
                        continue
                    if now - os.path.getmtime(fpath) > max_age_seconds:
                        os.remove(fpath)
                except Exception:
                    pass

# Run startup sweep
try:
    run_janitor_cleanup()
except Exception:
    pass

# Run periodic background cleanup thread (every 30 minutes)
def janitor_loop():
    while True:
        time.sleep(1800)
        try:
            run_janitor_cleanup()
        except Exception:
            pass

threading.Thread(target=janitor_loop, daemon=True).start()

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff", ".gif"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"}
OFFICE_PACKAGE_EXTENSIONS = {".docx", ".pptx", ".xlsx", ".odt", ".odp", ".ods", ".epub"}

def compress_embedded_image(filename: str, data: bytes, quality: int) -> bytes:
    """Re-encode supported embedded images in Office packages at the selected quality."""
    ext = os.path.splitext(filename)[1].lower()
    if ext not in {".jpg", ".jpeg", ".webp", ".png"}:
        return data
    try:
        with Image.open(io.BytesIO(data)) as source:
            image = source.copy()
            output = io.BytesIO()
            if ext in {".jpg", ".jpeg"}:
                if image.mode not in {"RGB", "L", "CMYK"}:
                    image = image.convert("RGB")
                image.save(output, "JPEG", quality=quality, optimize=True)
            elif ext == ".webp":
                image.save(output, "WEBP", quality=quality, method=6)
            else:
                image.save(output, "PNG", optimize=True)
            return output.getvalue()
    except Exception:
        return data

def compress_document_file(input_path: str, output_path: str, original_name: str, quality: int) -> str:
    """Compress PDFs and package documents; wrap otherwise opaque files in a lossless .gz."""
    ext = os.path.splitext(original_name)[1].lower()
    quality = max(50, min(98, int(quality)))
    compression_level = max(1, min(9, 1 + round((98 - quality) * 8 / 48)))

    if ext == ".pdf":
        import pymupdf as fitz
        target_dpi = int(120 + ((quality - 50) / 48) * 120)
        with fitz.open(input_path) as document:
            document.rewrite_images(dpi_threshold=300, dpi_target=target_dpi, quality=quality)
            document.save(
                output_path,
                garbage=4,
                clean=True,
                deflate=True,
                deflate_images=True,
                deflate_fonts=True,
                compression_effort=quality,
            )
        return output_path

    if ext in OFFICE_PACKAGE_EXTENSIONS or ext == ".zip":
        with zipfile.ZipFile(input_path, "r") as source, zipfile.ZipFile(
            output_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=compression_level
        ) as target:
            target.comment = source.comment
            for item in source.infolist():
                data = source.read(item.filename)
                media_path = item.filename.lower()
                if ext in OFFICE_PACKAGE_EXTENSIONS and item.filename == "mimetype":
                    target.writestr(item, data, compress_type=zipfile.ZIP_STORED)
                    continue
                if ext in OFFICE_PACKAGE_EXTENSIONS and (
                    media_path.startswith(("media/", "pictures/", "images/"))
                    or any(part in media_path for part in ("/media/", "/pictures/", "/images/"))
                ):
                    data = compress_embedded_image(item.filename, data, quality)
                target.writestr(item, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=compression_level)
        return output_path

    # For formats without a safe quality-aware encoder, provide a lossless .gz archive.
    with open(input_path, "rb") as source, open(output_path, "wb") as raw_output:
        with gzip.GzipFile(fileobj=raw_output, mode="wb", compresslevel=compression_level, mtime=0) as target:
            shutil.copyfileobj(source, target)
    return output_path

@app.post("/api/compress/upload")
async def upload_compress_files(files: List[UploadFile] = File(...), session_id: Optional[str] = Form(None)):
    """Accept any file for compression, keeping image/video preview handling shared."""
    result = await upload_media(files, session_id)
    for item in result["media"]:
        if item["media_type"] == "unknown":
            item["media_type"] = "document"
            item["format_name"] = os.path.splitext(item["filename"])[1].lstrip(".").upper() or "FILE"
            uploaded_media[item["id"]]["media_type"] = "document"
            uploaded_media[item["id"]]["format_name"] = item["format_name"]
    return result

class ProcessRequest(BaseModel):
    file_ids: List[str]
    config: WatermarkConfig
    session_id: Optional[str] = None

@app.post("/api/upload-media")
async def upload_media(files: List[UploadFile] = File(...), session_id: Optional[str] = Form(None)):
    """Uploads one or multiple pictures/videos and extracts preview frames."""
    results = []
    
    for file in files:
        file_id = str(uuid.uuid4())[:8]
        orig_name = os.path.basename((file.filename or "unknown").replace("\\", "/")) or "unknown"
        ext = os.path.splitext(orig_name)[1].lower()
        
        save_filename = f"{file_id}_{orig_name}"
        save_path = os.path.join(UPLOADS_DIR, save_filename)
        
        with open(save_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        register_session_file(session_id, save_path)
            
        media_type = "image" if ext in IMAGE_EXTENSIONS else ("video" if ext in VIDEO_EXTENSIONS else "unknown")
        
        thumb_filename = f"thumb_{file_id}.jpg"
        thumb_path = os.path.join(THUMBS_DIR, thumb_filename)
        
        preview_base_filename = f"preview_base_{file_id}.jpg"
        preview_base_path = os.path.join(THUMBS_DIR, preview_base_filename)
        
        width, height, duration = 0, 0, 0.0
        
        try:
            if media_type == "image":
                with Image.open(save_path) as raw_img:
                    img = ImageOps.exif_transpose(raw_img)
                    width, height = img.size
                    if width <= 0 or height <= 0:
                        raise ValueError("Image has empty dimensions")

                    # 1. High-resolution preview base (up to 1440px for super sharp live preview)
                    preview_img = img.copy()
                    preview_img.thumbnail((1440, 1440), Image.Resampling.LANCZOS)
                    preview_img.convert("RGB").save(preview_base_path, "JPEG", quality=92)
                    register_session_file(session_id, preview_base_path)

                    # 2. Small thumbnail for queue sidebar (240px)
                    thumb_img = img.copy()
                    thumb_img.thumbnail((240, 240), Image.Resampling.LANCZOS)
                    thumb_img.convert("RGB").save(thumb_path, "JPEG", quality=85)
                    register_session_file(session_id, thumb_path)
            elif media_type == "video":
                info = get_video_info(save_path)
                width, height = info["width"], info["height"]
                duration = info["duration"]
                if width <= 0 or height <= 0:
                    raise ValueError("Video has empty dimensions")

                # Extract first frame
                raw_frame_path = os.path.join(THUMBS_DIR, f"raw_frame_{file_id}.jpg")
                try:
                    extract_video_frame(save_path, raw_frame_path, timestamp_sec=min(0.5, duration / 2 if duration else 0.5))
                    with Image.open(raw_frame_path) as raw_frame:
                        frame = ImageOps.exif_transpose(raw_frame)
                        # High-res preview base
                        preview_img = frame.copy()
                        preview_img.thumbnail((1440, 1440), Image.Resampling.LANCZOS)
                        preview_img.convert("RGB").save(preview_base_path, "JPEG", quality=92)
                        register_session_file(session_id, preview_base_path)

                        # Small sidebar thumbnail
                        thumb_img = frame.copy()
                        thumb_img.thumbnail((240, 240), Image.Resampling.LANCZOS)
                        thumb_img.convert("RGB").save(thumb_path, "JPEG", quality=85)
                        register_session_file(session_id, thumb_path)
                finally:
                    if os.path.exists(raw_frame_path):
                        try:
                            os.remove(raw_frame_path)
                        except Exception:
                            pass
        except Exception as e:
            for p in (save_path, preview_base_path, thumb_path):
                try:
                    if os.path.isfile(p):
                        os.remove(p)
                except OSError:
                    pass
            if media_type in ("image", "video"):
                raise HTTPException(status_code=400, detail=f"Invalid or unreadable {media_type} file '{orig_name}': {e}")
            print(f"Error processing upload {orig_name}: {e}")
            
        media_item = {
            "id": file_id,
            "filename": orig_name,
            "saved_filename": save_filename,
            "media_type": media_type,
            "thumb_url": f"/api/thumbnails/{url_segment(thumb_filename)}",
            "width": width,
            "height": height,
            "duration": round(duration, 2),
            "size_bytes": os.path.getsize(save_path),
            "session_id": session_id
        }
        
        uploaded_media[file_id] = media_item
        results.append(media_item)
        
    return {"media": results}

@app.get("/api/media")
def list_media():
    return {"media": list(uploaded_media.values())}

@app.delete("/api/media/{file_id}")
def delete_media(file_id: str):
    if file_id in uploaded_media:
        item = uploaded_media.pop(file_id)
        # Physically remove from disk immediately
        fn = item.get("saved_filename")
        if fn:
            fpath = os.path.join(UPLOADS_DIR, fn)
            if os.path.exists(fpath):
                try: os.remove(fpath)
                except Exception: pass
        thumb_name = f"thumb_{file_id}.jpg"
        tpath = os.path.join(THUMBS_DIR, thumb_name)
        if os.path.exists(tpath):
            try: os.remove(tpath)
            except Exception: pass
        prev_name = f"preview_base_{file_id}.jpg"
        ppath = os.path.join(THUMBS_DIR, prev_name)
        if os.path.exists(ppath):
            try: os.remove(ppath)
            except Exception: pass
        return {"success": True}
    raise HTTPException(status_code=404, detail="Media not found")

@app.post("/api/session/cleanup")
async def cleanup_tab_session(request: Request):
    """Called on pagehide/beforeunload via navigator.sendBeacon to immediately purge files for this tab."""
    session_id = None
    try:
        data = await request.json()
        session_id = data.get("session_id")
    except Exception:
        try:
            raw = await request.body()
            data = json.loads(raw.decode("utf-8"))
            session_id = data.get("session_id")
        except Exception:
            pass

    if not session_id:
        return {"status": "ignored", "cleaned": 0}

    with session_files_lock:
        if session_active_jobs.get(session_id, 0) > 0:
            pending_session_cleanup.add(session_id)
            return {"status": "cleanup_deferred_until_export_finishes", "cleaned": 0}
    cleaned_count = remove_session_files(session_id)
    return {"status": "cleaned", "cleaned": cleaned_count}

ALLOWED_LOGO_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}


@app.post("/api/upload-watermark-logo")
async def upload_watermark_logo(file: UploadFile = File(...), session_id: Optional[str] = Form(None)):
    """Uploads a raster logo/watermark image (PNG/JPG/WEBP/BMP/GIF) for use in image layers."""
    orig_name = os.path.basename((file.filename or "logo.png").replace("\\", "/")) or "logo.png"
    ext = os.path.splitext(orig_name)[1].lower()
    if ext not in ALLOWED_LOGO_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Unsupported logo format. Please upload PNG, JPG, WEBP, BMP, or GIF.")
    logo_id = str(uuid.uuid4())[:8]
    saved_name = f"logo_{logo_id}{ext}"
    saved_path = os.path.join(UPLOADS_DIR, saved_name)

    with open(saved_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    try:
        with Image.open(saved_path) as logo_img:
            logo_img.verify()
    except Exception:
        try:
            os.remove(saved_path)
        except OSError:
            pass
        raise HTTPException(status_code=400, detail="Uploaded logo file is corrupted or not a valid image.")

    register_session_file(session_id, saved_path)

    return {
        "filename": saved_name,
        "preview_url": f"/api/uploads/{url_segment(saved_name)}"
    }

@app.post("/api/preview")
def generate_preview(req: ProcessRequest):
    """Renders a live preview with 100% WYSIWYG parity to the export."""
    if not req.file_ids:
        raise HTTPException(status_code=400, detail="No file selected for preview")
        
    file_id = req.file_ids[0]
    media_item = uploaded_media.get(file_id)
    if not media_item:
        raise HTTPException(status_code=404, detail="Media not found")
        
    preview_base_path = os.path.join(THUMBS_DIR, f"preview_base_{file_id}.jpg")
    if not os.path.exists(preview_base_path):
        preview_base_path = os.path.join(THUMBS_DIR, f"thumb_{file_id}.jpg")
        
    if not os.path.exists(preview_base_path):
        raise HTTPException(status_code=404, detail="Preview frame missing")
        
    preview_output_name = f"preview_{file_id}.jpg"
    preview_output_path = os.path.join(THUMBS_DIR, preview_output_name)
    
    # Apply watermark to the high-res preview base
    apply_watermark_to_image(
        preview_base_path,
        preview_output_path,
        req.config,
        UPLOADS_DIR,
        output_quality=92
    )
    
    return {
        "preview_url": f"/api/thumbnails/{url_segment(preview_output_name)}?t={uuid.uuid4()}",
        "width": media_item["width"],
        "height": media_item["height"]
    }

@app.post("/api/watermark-overlay")
def get_watermark_overlay(req: ProcessRequest):
    """Returns a transparent RGBA PNG overlay sized to the media for live real-time video playback."""
    if not req.file_ids:
        raise HTTPException(status_code=400, detail="No file selected")
        
    file_id = req.file_ids[0]
    media_item = uploaded_media.get(file_id)
    if not media_item:
        raise HTTPException(status_code=404, detail="Media not found")
        
    width = media_item.get("width") or 1280
    height = media_item.get("height") or 720
    
    # Cap max dimensions for lightning fast overlay transfer if needed (e.g. 1920)
    aspect = width / height if height > 0 else 16/9
    if width > 1920:
        width = 1920
        height = int(1920 / aspect)
        
    overlay = create_watermark_overlay((width, height), req.config, UPLOADS_DIR)
    
    overlay_filename = f"overlay_{file_id}.png"
    overlay_path = os.path.join(THUMBS_DIR, overlay_filename)
    overlay.save(overlay_path, "PNG")
    
    return {
        "overlay_url": f"/api/thumbnails/{url_segment(overlay_filename)}?t={uuid.uuid4()}",
        "width": width,
        "height": height
    }

def process_batch_worker(job_id: str, file_ids: List[str], config: WatermarkConfig, session_id: Optional[str] = None):
    with jobs_lock:
        job = jobs[job_id]
    total_files = len(file_ids)
    was_cancelled = False

    try:
        for idx, fid in enumerate(file_ids):
            with jobs_lock:
                if job.get("cancelled"):
                    was_cancelled = True
                    break

            media_item = uploaded_media.get(fid)
            if not media_item:
                continue

            orig_name = media_item["filename"]
            in_path = os.path.join(UPLOADS_DIR, media_item["saved_filename"])

            name_root, ext = os.path.splitext(orig_name)
            prefix = "compressed" if config.export_settings.mode == "compress_only" else "watermarked"
            output_ext = ext
            if media_item.get("media_type") == "document":
                safe_formats = OFFICE_PACKAGE_EXTENSIONS | {".pdf", ".zip"}
                if ext.lower() not in safe_formats:
                    output_ext = f"{ext or '.file'}.gz"
            out_name = f"{prefix}_{name_root}{output_ext}"
            out_path = os.path.join(OUTPUTS_DIR, f"{job_id}_{out_name}")

            with jobs_lock:
                active_job_paths.setdefault(job_id, set()).update({os.path.abspath(in_path), os.path.abspath(out_path)})

            item_status = {
                "file_id": fid,
                "filename": orig_name,
                "output_filename": out_name,
                "orig_size_bytes": media_item.get("size_bytes", 0),
                "output_size_bytes": 0,
                "status": "processing",
                "progress": 0.0,
                "download_url": None,
                "error": None
            }
            with jobs_lock:
                job["items"].append(item_status)

            try:
                if media_item["media_type"] == "image":
                    apply_watermark_to_image(in_path, out_path, config, UPLOADS_DIR)
                    register_session_file(session_id, out_path)
                    item_status["progress"] = 1.0
                    item_status["status"] = "completed"
                    item_status["output_size_bytes"] = os.path.getsize(out_path) if os.path.exists(out_path) else 0
                    item_status["download_url"] = f"/api/download/{url_segment(f'{job_id}_{out_name}')}"
                elif media_item["media_type"] == "video":
                    def on_video_progress(p):
                        with jobs_lock:
                            item_status["progress"] = p
                            overall = (idx + p) / total_files
                            job["progress"] = round(overall, 2)

                    apply_watermark_to_video(in_path, out_path, config, UPLOADS_DIR, progress_callback=on_video_progress)
                    register_session_file(session_id, out_path)
                    item_status["progress"] = 1.0
                    item_status["status"] = "completed"
                    item_status["output_size_bytes"] = os.path.getsize(out_path) if os.path.exists(out_path) else 0
                    item_status["download_url"] = f"/api/download/{url_segment(f'{job_id}_{out_name}')}"
                elif media_item["media_type"] == "document" and config.export_settings.mode == "compress_only":
                    compress_document_file(in_path, out_path, orig_name, config.export_settings.image_quality)
                    register_session_file(session_id, out_path)
                    item_status["progress"] = 1.0
                    item_status["status"] = "completed"
                    item_status["output_size_bytes"] = os.path.getsize(out_path) if os.path.exists(out_path) else 0
                    item_status["download_url"] = f"/api/download/{url_segment(f'{job_id}_{out_name}')}"
                else:
                    item_status["status"] = "failed"
                    item_status["error"] = "Unsupported media type"
            except Exception as e:
                item_status["status"] = "failed"
                item_status["error"] = str(e)

            overall_progress = (idx + 1) / total_files
            with jobs_lock:
                job["progress"] = round(overall_progress, 2)

        with jobs_lock:
            if was_cancelled or job.get("cancelled"):
                job["status"] = "cancelled"
            elif job["items"] and all(it.get("status") == "failed" for it in job["items"]):
                job["status"] = "failed"
            else:
                job["status"] = "completed"
    finally:
        release_session_job(session_id)


@app.post("/api/process")
def start_processing(req: ProcessRequest, background_tasks: BackgroundTasks):
    """Starts batch or single media watermarking."""
    unique_file_ids = list(dict.fromkeys(fid for fid in req.file_ids if fid))
    if not unique_file_ids:
        raise HTTPException(status_code=400, detail="No files provided for processing")

    job_id = str(uuid.uuid4())[:8]
    with jobs_lock:
        jobs[job_id] = {
            "job_id": job_id,
            "status": "in_progress",
            "progress": 0.0,
            "items": [],
            "created_at": time.time(),
            "cancelled": False,
            "session_id": req.session_id,
        }

    if req.session_id:
        with session_files_lock:
            session_active_jobs[req.session_id] = session_active_jobs.get(req.session_id, 0) + 1

    background_tasks.add_task(process_batch_worker, job_id, unique_file_ids, req.config, req.session_id)
    return {"job_id": job_id}


@app.get("/api/job/{job_id}")
@app.get("/api/job-status/{job_id}")
def get_job_status(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        return dict(job)


@app.post("/api/job/{job_id}/cancel")
def cancel_job(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        if job.get("status") == "in_progress":
            job["cancelled"] = True
            return {"job_id": job_id, "status": "cancelling"}
        return {"job_id": job_id, "status": job.get("status")}


@app.get("/api/download/{filename}")
def download_file(filename: str):
    filepath = resolve_safe_path(OUTPUTS_DIR, filename, must_exist=True)
    parts = os.path.basename(filepath).split("_", 1)
    display_name = parts[1] if len(parts) > 1 else os.path.basename(filepath)
    return FileResponse(filepath, filename=display_name)


@app.get("/api/download-zip/{job_id}")
def download_zip(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        items = list(job.get("items", []))
        session_id = job.get("session_id")

    safe_job_id = os.path.basename(job_id)
    zip_filename = f"watermarked_bundle_{safe_job_id}.zip"
    zip_path = resolve_safe_path(OUTPUTS_DIR, zip_filename)

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zipf:
        for item in items:
            if item.get("status") == "completed":
                actual_file = resolve_safe_path(OUTPUTS_DIR, f"{safe_job_id}_{item['output_filename']}")
                if os.path.isfile(actual_file):
                    zipf.write(actual_file, arcname=os.path.basename(item["output_filename"]))

    register_session_file(session_id, zip_path)
    return FileResponse(zip_path, filename=zip_filename)


@app.get("/api/thumbnails/{filename}")
def get_thumbnail(filename: str):
    path = resolve_safe_path(THUMBS_DIR, filename, must_exist=True)
    return FileResponse(path)


@app.get("/api/uploads/{filename}")
def get_upload_file(filename: str):
    path = resolve_safe_path(UPLOADS_DIR, filename, must_exist=True)
    ext = os.path.splitext(path)[1].lower()
    if ext not in (IMAGE_EXTENSIONS | VIDEO_EXTENSIONS):
        return FileResponse(path, media_type="application/octet-stream", filename=os.path.basename(path))
    return FileResponse(path)

# ==========================================
# THUMBNAIL STUDIO API ENDPOINTS
# ==========================================

class CandidatesRequest(BaseModel):
    file_id: str
    count: int = Field(default=9, ge=1, le=100)
    start_sec: float = 0.0
    end_sec: Optional[float] = None
    session_id: Optional[str] = None

@app.post("/api/thumbnail/extract-candidates")
def get_thumbnail_candidates(req: CandidatesRequest):
    """Extracts N candidate frames evenly spaced in the given interval."""
    media = uploaded_media.get(req.file_id)
    if not media:
        raise HTTPException(status_code=404, detail="Video media not found")
        
    video_path = os.path.join(UPLOADS_DIR, media["saved_filename"])
    if not os.path.exists(video_path):
        raise HTTPException(status_code=404, detail="Video file missing on disk")
        
    candidates = extract_grid_candidates(
        video_path=video_path,
        output_dir=THUMBS_DIR,
        file_prefix=f"cand_{req.file_id}",
        count=req.count,
        start_sec=req.start_sec,
        end_sec=req.end_sec,
        duration=media.get("duration") or None,
    )
    for c in candidates:
        register_session_file(req.session_id, os.path.join(THUMBS_DIR, c["filename"]))
        
    return {"candidates": candidates, "duration": media.get("duration", 0)}

@app.post("/api/thumbnail/extract-candidates-stream")
def stream_thumbnail_candidates(req: CandidatesRequest):
    """Extract frames one by one so the browser can show real scan progress."""
    media = uploaded_media.get(req.file_id)
    if not media:
        raise HTTPException(status_code=404, detail="Video media not found")

    video_path = os.path.join(UPLOADS_DIR, media["saved_filename"])
    if not os.path.exists(video_path):
        raise HTTPException(status_code=404, detail="Video file missing on disk")

    def events():
        duration = float(media.get("duration") or get_video_info(video_path)["duration"])
        scan_prefix = f"cand_{req.file_id}_{uuid.uuid4().hex[:8]}"
        timestamps = get_grid_candidate_timestamps(
            duration, req.count, req.start_sec, req.end_sec
        )
        total = len(timestamps)
        yield json.dumps({"type": "start", "total": total, "duration": duration}) + "\n"

        for index, timestamp in enumerate(timestamps):
            frame_results = extract_frames_at_timestamps(
                video_path=video_path,
                timestamps=[timestamp],
                output_dir=THUMBS_DIR,
                file_prefix=f"{scan_prefix}_{index}",
            )
            frame = frame_results[0] if frame_results else None
            if frame:
                frame["index"] = index
                register_session_file(req.session_id, os.path.join(THUMBS_DIR, frame["filename"]))
            yield json.dumps({
                "type": "frame",
                "frame": frame,
                "completed": index + 1,
                "total": total,
            }) + "\n"

        yield json.dumps({"type": "done", "total": total}) + "\n"

    return StreamingResponse(
        events(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

class SingleFrameRequest(BaseModel):
    file_id: str
    timestamp_sec: float
    session_id: Optional[str] = None

def _resolve_thumb_or_upload_path(filename: str) -> Optional[str]:
    thumb_candidate = resolve_safe_path(THUMBS_DIR, filename)
    if os.path.isfile(thumb_candidate):
        return thumb_candidate
    upload_candidate = resolve_safe_path(UPLOADS_DIR, filename)
    if os.path.isfile(upload_candidate):
        return upload_candidate
    return None


@app.post("/api/thumbnail/extract-single-frame")
def get_single_frame(req: SingleFrameRequest):
    """Extracts a frame at an exact timestamp."""
    media = uploaded_media.get(req.file_id)
    if not media:
        raise HTTPException(status_code=404, detail="Media not found")
    video_path = os.path.join(UPLOADS_DIR, media["saved_filename"])

    duration = float(media.get("duration") or 0.0)
    requested_ts = max(0.0, float(req.timestamp_sec or 0.0))
    clamped_ts = min(requested_ts, max(0.0, duration - 0.05)) if duration > 0 else requested_ts

    out_filename = f"exact_{req.file_id}_{int(clamped_ts * 1000)}.jpg"
    out_path = resolve_safe_path(THUMBS_DIR, out_filename)

    used_ts = clamped_ts
    candidates = [clamped_ts]
    if clamped_ts > 0.25:
        candidates.append(max(0.0, clamped_ts - 0.25))

    for candidate_ts in candidates:
        cmd = [
            "ffmpeg", "-y",
            "-ss", f"{candidate_ts:.3f}",
            "-i", video_path,
            "-vframes", "1",
            "-q:v", "2",
            out_path
        ]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if os.path.isfile(out_path) and os.path.getsize(out_path) > 0:
            used_ts = candidate_ts
            break

    if not os.path.isfile(out_path) or os.path.getsize(out_path) == 0:
        raise HTTPException(status_code=500, detail="Failed to capture frame")

    register_session_file(req.session_id, out_path)

    return {
        "filename": out_filename,
        "url": f"/api/thumbnails/{url_segment(out_filename)}",
        "timestamp_sec": round(used_ts, 3)
    }

class StoryboardRequest(BaseModel):
    frame_filenames: List[str]
    rows: int = Field(default=3, ge=1, le=10)
    cols: int = Field(default=3, ge=1, le=10)
    aspect_ratio: str = "16:9"
    border_px: int = Field(default=0, ge=0, le=40)
    border_color: str = "#000000"
    resolution_scale: int = Field(default=2, ge=1, le=2)
    session_id: Optional[str] = None

@app.post("/api/thumbnail/generate-storyboard")
def get_storyboard(req: StoryboardRequest):
    """Renders a multi-frame NxN contact sheet collage."""
    paths = [resolve_safe_path(THUMBS_DIR, fn, must_exist=True) for fn in req.frame_filenames]
    out_filename = f"sheet_{uuid.uuid4().hex[:8]}.jpg"
    out_path = os.path.join(THUMBS_DIR, out_filename)
    
    sheet = render_storyboard_sheet(
        frame_paths=paths,
        rows=req.rows,
        cols=req.cols,
        target_aspect=req.aspect_ratio,
        border_px=req.border_px,
        border_color=req.border_color,
        resolution_scale=req.resolution_scale,
    )
    sheet.save(out_path, "JPEG", quality=96)
    register_session_file(req.session_id, out_path)
    
    return {
        "filename": out_filename,
        "url": f"/api/thumbnails/{url_segment(out_filename)}"
    }

class ThumbnailDesignRequest(BaseModel):
    base_image_filename: str # in THUMBS_DIR or UPLOADS_DIR
    aspect_ratio: str = "16:9"
    fit_mode: str = "fill"
    resolution_scale: int = Field(default=2, ge=1, le=2)
    adjustments: dict = {}
    text_items: List[dict] = []
    stickers: List[dict] = []
    session_id: Optional[str] = None

@app.post("/api/thumbnail/preview")
def preview_thumbnail_design(req: ThumbnailDesignRequest):
    """Renders instant live preview of the designed thumbnail."""
    base_path = _resolve_thumb_or_upload_path(req.base_image_filename)
    if not base_path:
        raise HTTPException(status_code=404, detail="Base image not found")
        
    out_filename = f"thumb_prev_{uuid.uuid4().hex[:8]}.jpg"
    out_path = os.path.join(THUMBS_DIR, out_filename)
    
    render_thumbnail(
        base_image_path=base_path,
        output_path=out_path,
        aspect_ratio=req.aspect_ratio,
        fit_mode=req.fit_mode,
        resolution_scale=req.resolution_scale,
        adjustments=req.adjustments,
        text_items=req.text_items,
        stickers=req.stickers,
        uploads_dir=UPLOADS_DIR
    )
    register_session_file(req.session_id, out_path)
    
    return {
        "preview_url": f"/api/thumbnails/{url_segment(out_filename)}?t={uuid.uuid4().hex[:6]}"
    }

class ThumbnailExportRequest(BaseModel):
    base_image_filenames: List[str] # Multiple thumbnails from multiple frames!
    aspect_ratio: str = "16:9"
    fit_mode: str = "fill"
    resolution_scale: int = Field(default=2, ge=1, le=2)
    adjustments: dict = {}
    text_items: List[dict] = []
    stickers: List[dict] = []
    format: Literal["jpg", "png"] = "jpg"
    include_main_thumbnail: bool = False
    session_id: Optional[str] = None

@app.post("/api/thumbnail/export")
def export_thumbnails(req: ThumbnailExportRequest):
    """Exports single or multiple thumbnails with zero quality loss and optional ZIP."""
    if not req.base_image_filenames:
        raise HTTPException(status_code=400, detail="No base images provided")
        
    batch_id = uuid.uuid4().hex[:8]
    outputs = []
    include_main = bool(req.include_main_thumbnail and len(req.base_image_filenames) > 1)
    
    for idx, fn in enumerate(req.base_image_filenames):
        base_path = _resolve_thumb_or_upload_path(fn)
        if not base_path:
            continue
            
        ext = req.format
        if include_main:
            if idx == 0:
                out_name = f"thumbnail_{batch_id}_main.{ext}"
                item_label = "Generated Thumbnail"
            else:
                out_name = f"thumbnail_{batch_id}_variation_{idx}.{ext}"
                item_label = f"Variation {idx}"
        else:
            out_name = f"thumbnail_{batch_id}_{idx + 1}.{ext}"
            item_label = "Generated Thumbnail" if len(req.base_image_filenames) == 1 else f"Variation {idx + 1}"
        out_path = os.path.join(OUTPUTS_DIR, out_name)
        
        render_thumbnail(
            base_image_path=base_path,
            output_path=out_path,
            aspect_ratio=req.aspect_ratio,
            fit_mode=req.fit_mode,
            resolution_scale=req.resolution_scale,
            adjustments=req.adjustments,
            text_items=req.text_items,
            stickers=req.stickers,
            uploads_dir=UPLOADS_DIR
        )
        register_session_file(req.session_id, out_path)
        
        outputs.append({
            "filename": out_name,
            "label": item_label,
            "download_url": f"/api/download/{url_segment(out_name)}",
            "size_bytes": os.path.getsize(out_path)
        })
        
    # If multiple, create a zip bundle
    zip_url = None
    if len(outputs) > 1:
        zip_name = f"thumbnails_bundle_{batch_id}.zip"
        zip_path = os.path.join(OUTPUTS_DIR, zip_name)
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
            for item in outputs:
                fpath = os.path.join(OUTPUTS_DIR, item["filename"])
                z.write(fpath, arcname=item["filename"])
        register_session_file(req.session_id, zip_path)
        zip_url = f"/api/download/{url_segment(zip_name)}"
        
    return {
        "batch_id": batch_id,
        "items": outputs,
        "zip_url": zip_url
    }

# --- Censor & Privacy Studio Pro Endpoints ---

_censor_processor: Optional[CensorProcessor] = None

def get_censor_processor() -> CensorProcessor:
    global _censor_processor
    if _censor_processor is None:
        _censor_processor = CensorProcessor()
    return _censor_processor

class CensorBoxModel(BaseModel):
    x: int
    y: int
    w: int
    h: int
    confidence: float = 1.0
    label: str = "Face"
    track_id: Optional[int] = None
    landmarks: Optional[List[List[float]]] = None
    kind: Literal["box", "brush"] = "box"
    brush_points: Optional[List[List[float]]] = None
    brush_radius: float = Field(default=24.0, ge=1.0, le=300.0)
    mask_type: Optional[Literal["blur", "pixelate", "emoji", "redact"]] = None

class CensorMaskConfigModel(BaseModel):
    mask_type: Literal["blur", "pixelate", "emoji", "redact"] = "blur"
    intensity: int = 60
    emoji_name: str = "sunglasses"
    custom_sticker_filename: Optional[str] = None
    redact_text: Optional[str] = "[CENSORED]"
    shape: Literal["oval", "rect"] = "oval"
    mask_region: Literal["face", "eyes"] = "face"


def _to_bounding_box(b: CensorBoxModel) -> BoundingBox:
    brush_pts = None
    if b.brush_points:
        brush_pts = [(float(pt[0]), float(pt[1])) for pt in b.brush_points if len(pt) >= 2]
    return BoundingBox(
        x=b.x,
        y=b.y,
        w=b.w,
        h=b.h,
        confidence=b.confidence,
        track_id=b.track_id,
        label=b.label,
        landmarks=[(point[0], point[1]) for point in (b.landmarks or [])],
        kind=b.kind,
        brush_points=brush_pts,
        brush_radius=float(b.brush_radius),
        mask_type=b.mask_type,
    )


def _build_censor_mask_config(mask_cfg_model: CensorMaskConfigModel) -> MaskConfig:
    custom_sticker_path = None
    if mask_cfg_model.custom_sticker_filename:
        c_path = resolve_safe_path(UPLOADS_DIR, mask_cfg_model.custom_sticker_filename)
        if os.path.isfile(c_path):
            custom_sticker_path = c_path

    return MaskConfig(
        mask_type=mask_cfg_model.mask_type,
        intensity=mask_cfg_model.intensity,
        emoji_name=mask_cfg_model.emoji_name,
        custom_sticker_path=custom_sticker_path,
        redact_text=mask_cfg_model.redact_text,
        shape=mask_cfg_model.shape,
        mask_region=mask_cfg_model.mask_region,
    )

class CensorDetectRequest(BaseModel):
    file_id: str
    frame_sec: Optional[float] = 0.0
    sensitivity: float = Field(default=0.5, ge=0.0, le=1.0)

def _read_censor_frame(media: dict, frame_sec: float):
    """Read the requested source frame; never substitute a differently sized thumbnail."""
    media_path = os.path.join(UPLOADS_DIR, media["saved_filename"])
    if media["media_type"] == "image":
        frame = safe_imread(media_path)
        if frame is None:
            raise HTTPException(status_code=400, detail="Could not read image from media")
        return frame

    import cv2
    cap = cv2.VideoCapture(media_path)
    if not cap.isOpened():
        raise HTTPException(status_code=400, detail="Could not open video")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    duration = max(0.0, float(media.get("duration") or 0.0))
    timestamp = min(max(0.0, float(frame_sec or 0.0)), duration) if duration else max(0.0, float(frame_sec or 0.0))
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    frame_idx = max(0, int(timestamp * fps))
    if frame_count > 0:
        frame_idx = min(frame_idx, frame_count - 1)
    cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
    ret, frame = cap.read()
    cap.release()
    if not ret or frame is None:
        raise HTTPException(status_code=400, detail="Could not decode the selected video frame")
    return frame

class CensorPreviewRequest(BaseModel):
    file_id: str
    frame_sec: Optional[float] = 0.0
    boxes: List[CensorBoxModel] = []
    mask_config: CensorMaskConfigModel = CensorMaskConfigModel()
    session_id: Optional[str] = None
    preview_revision: int = 0

class CensorProcessRequest(BaseModel):
    file_id: str
    mode: Literal["faces_all", "face_single", "specific_object", "nsfw"] = "faces_all"
    selected_track_id: Optional[int] = None
    selected_face_box: Optional[CensorBoxModel] = None
    excluded_face_boxes: List[CensorBoxModel] = []
    track_custom_objects: bool = True
    nsfw_sensitivity: float = Field(default=0.5, ge=0.0, le=1.0)
    boxes: List[CensorBoxModel] = []
    mask_config: CensorMaskConfigModel = CensorMaskConfigModel()
    session_id: Optional[str] = None


class CensorBatchItemModel(BaseModel):
    file_id: str
    boxes: List[CensorBoxModel] = []
    auto_detect_faces: bool = False
    auto_detect_nsfw: bool = False
    mask_config: Optional[CensorMaskConfigModel] = None


class CensorBatchProcessRequest(BaseModel):
    items: List[CensorBatchItemModel]
    mask_config: CensorMaskConfigModel = CensorMaskConfigModel()
    nsfw_sensitivity: float = Field(default=0.5, ge=0.0, le=1.0)
    session_id: Optional[str] = None

@app.post("/api/censor/detect-nsfw")
def api_censor_detect_nsfw(req: CensorDetectRequest):
    if req.file_id not in uploaded_media:
        raise HTTPException(status_code=404, detail="Media file not found")
    
    media = uploaded_media[req.file_id]
    frame = _read_censor_frame(media, req.frame_sec or 0.0)
    candidates = detect_nsfw_candidates(frame, sensitivity=req.sensitivity)
    return {
        "file_id": req.file_id,
        "width": int(frame.shape[1]),
        "height": int(frame.shape[0]),
        "candidates": [c.to_dict() for c in candidates],
        "detector": "skin-region heuristic",
        "warning": "Candidate regions only; this is not a trained NSFW classifier. Review every result before export."
    }

@app.post("/api/censor/detect-faces")
def api_censor_detect_faces(req: CensorDetectRequest):
    if req.file_id not in uploaded_media:
        raise HTTPException(status_code=404, detail="Media file not found")
    
    media = uploaded_media[req.file_id]
    processor = get_censor_processor()
    if media["media_type"] == "video":
        # Seek directly to the target frame and detect — do NOT scan every
        # frame sequentially.  Full-sequence tracking is only needed during
        # export; the preview just needs detections on the visible frame.
        frame = _read_censor_frame(media, req.frame_sec or 0.0)
        faces = processor.detector.detect(frame, padding_percent=0.20)
        for idx, f in enumerate(faces):
            f.track_id = idx + 1
    else:
        frame = _read_censor_frame(media, req.frame_sec or 0.0)
        faces = processor.detector.detect(frame, padding_percent=0.20)
        for idx, f in enumerate(faces):
            f.track_id = idx + 1
    return {
        "file_id": req.file_id,
        "width": int(frame.shape[1]),
        "height": int(frame.shape[0]),
        "faces": [f.to_dict() for f in faces]
    }

@app.post("/api/censor/preview")
def api_censor_preview(req: CensorPreviewRequest):
    if req.file_id not in uploaded_media:
        raise HTTPException(status_code=404, detail="Media file not found")
        
    media = uploaded_media[req.file_id]
    frame = _read_censor_frame(media, req.frame_sec or 0.0)

    mask_cfg = _build_censor_mask_config(req.mask_config)
    boxes = [_to_bounding_box(b) for b in req.boxes]

    masked = apply_masks_to_frame(frame, boxes, mask_cfg)
    
    prev_id = f"censor_prev_{uuid.uuid4().hex[:8]}.jpg"
    prev_path = os.path.join(THUMBS_DIR, prev_id)
    if not safe_imwrite(prev_path, masked):
        raise HTTPException(status_code=500, detail="Could not save preview image")
    if req.session_id:
        accepted = False
        old_preview = None
        with censor_preview_lock:
            current_revision = censor_preview_revision.get(req.session_id, -1)
            if req.preview_revision >= current_revision:
                old_preview = censor_preview_by_session.get(req.session_id)
                censor_preview_by_session[req.session_id] = os.path.abspath(prev_path)
                censor_preview_revision[req.session_id] = req.preview_revision
                accepted = True
        if accepted:
            register_session_file(req.session_id, prev_path)
        else:
            try:
                os.remove(prev_path)
            except OSError:
                pass
        if accepted and old_preview and old_preview != os.path.abspath(prev_path):
            try:
                if os.path.isfile(old_preview):
                    os.remove(old_preview)
            except OSError:
                pass
            with session_files_lock:
                session_files.get(req.session_id, set()).discard(old_preview)
    else:
        register_session_file(None, prev_path)

    return {
        "preview_url": f"/api/thumbnails/{url_segment(prev_id)}?t={uuid.uuid4().hex[:6]}"
    }

def video_censor_worker(
    job_id: str,
    video_path: str,
    output_path: str,
    mask_cfg: MaskConfig,
    mode: str,
    selected_track_id: Optional[int],
    selected_face_box: Optional[BoundingBox],
    custom_boxes: List[BoundingBox],
    excluded_face_boxes: List[BoundingBox],
    track_custom_objects: bool,
    session_id: Optional[str],
    nsfw_sensitivity: float
):
    try:
        processor = get_censor_processor()

        def update_progress(pct: float):
            with jobs_lock:
                job = jobs.get(job_id)
                if not job:
                    return
                if pct >= 5.0 and job.get("cancelled"):
                    raise _JobCancelledError("Export cancelled by user")
                job["progress"] = round(pct, 1)

        processor.process_video(
            video_path,
            output_path,
            mask_cfg,
            mode=mode,
            selected_track_id=selected_track_id,
            selected_face_box=selected_face_box,
            custom_boxes=custom_boxes,
            excluded_face_boxes=excluded_face_boxes,
            track_custom_objects=track_custom_objects,
            nsfw_sensitivity=nsfw_sensitivity,
            progress_callback=update_progress
        )

        register_session_file(session_id, output_path)
        out_name = os.path.basename(output_path)

        with jobs_lock:
            if job_id in jobs:
                jobs[job_id]["status"] = "completed"
                jobs[job_id]["progress"] = 100.0
                jobs[job_id]["download_url"] = f"/api/download/{url_segment(out_name)}"
                jobs[job_id]["filename"] = out_name
                jobs[job_id]["size_bytes"] = os.path.getsize(output_path) if os.path.exists(output_path) else 0
    except _JobCancelledError:
        try:
            if os.path.isfile(output_path):
                os.remove(output_path)
        except OSError:
            pass
        with jobs_lock:
            if job_id in jobs:
                jobs[job_id]["status"] = "cancelled"
    except Exception as e:
        import traceback
        print(f"Error in video_censor_worker: {traceback.format_exc()}")
        with jobs_lock:
            if job_id in jobs:
                jobs[job_id]["status"] = "failed"
                jobs[job_id]["error"] = str(e)
    finally:
        release_session_job(session_id)

@app.post("/api/censor/process")
def api_censor_process(req: CensorProcessRequest, background_tasks: BackgroundTasks):
    if req.file_id not in uploaded_media:
        raise HTTPException(status_code=404, detail="Media file not found")
        
    media = uploaded_media[req.file_id]
    processor = get_censor_processor()
    
    mask_cfg = _build_censor_mask_config(req.mask_config)
    boxes = [_to_bounding_box(b) for b in req.boxes]
    excluded_boxes = [_to_bounding_box(b) for b in req.excluded_face_boxes]
    selected_face_box = _to_bounding_box(req.selected_face_box) if req.selected_face_box is not None else None

    media_path = os.path.join(UPLOADS_DIR, media["saved_filename"])
    orig_name = media.get("filename") or "media"
    name_root, ext = os.path.splitext(orig_name)

    try:
        if media["media_type"] == "image":
            file_uid = uuid.uuid4().hex[:8]
            img_ext = ext if ext.lower() in IMAGE_EXTENSIONS else ".jpg"
            out_name = f"{file_uid}_censored_{name_root}{img_ext}"
            out_path = os.path.join(OUTPUTS_DIR, out_name)
            processor.process_image(
                media_path,
                out_path,
                mask_cfg,
                custom_boxes=boxes,
                auto_detect_all=(req.mode == "faces_all" and len(boxes) == 0),
                auto_detect_nsfw=(req.mode == "nsfw"),
                nsfw_sensitivity=req.nsfw_sensitivity
            )
            register_session_file(req.session_id, out_path)
            return {
                "type": "image",
                "filename": out_name,
                "display_name": f"censored_{name_root}{img_ext}",
                "download_url": f"/api/download/{url_segment(out_name)}",
                "size_bytes": os.path.getsize(out_path)
            }
        else:
            job_id = str(uuid.uuid4())[:8]
            vid_ext = ext.lower() if ext.lower() in {".mp4", ".mov", ".mkv"} else ".mp4"
            out_name = f"{job_id}_censored_{name_root}{vid_ext}"
            out_path = os.path.join(OUTPUTS_DIR, out_name)

            with jobs_lock:
                jobs[job_id] = {
                    "job_id": job_id,
                    "status": "in_progress",
                    "progress": 0.0,
                    "filename": out_name,
                    "display_name": f"censored_{name_root}{vid_ext}",
                    "created_at": time.time(),
                    "cancelled": False,
                    "session_id": req.session_id,
                }
                active_job_paths[job_id] = {os.path.abspath(media_path), os.path.abspath(out_path)}

            if req.session_id:
                with session_files_lock:
                    session_active_jobs[req.session_id] = session_active_jobs.get(req.session_id, 0) + 1

            thread = threading.Thread(
                target=video_censor_worker,
                args=(
                    job_id,
                    media_path,
                    out_path,
                    mask_cfg,
                    req.mode,
                    req.selected_track_id,
                    selected_face_box,
                    boxes,
                    excluded_boxes,
                    req.track_custom_objects,
                    req.session_id,
                    req.nsfw_sensitivity
                ),
                daemon=True
            )
            thread.start()

            return {
                "type": "video",
                "job_id": job_id
            }
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        print(f"Error processing censor export: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Failed to process media: {str(e)}")


@app.post("/api/censor/process-batch")
def api_censor_process_batch(req: CensorBatchProcessRequest):
    if not req.items:
        raise HTTPException(status_code=400, detail="No batch images selected")

    processor = get_censor_processor()
    batch_id = uuid.uuid4().hex[:8]
    zip_name = f"censored_batch_{batch_id}.zip"
    zip_path = os.path.join(OUTPUTS_DIR, zip_name)

    results = []
    used_arcnames: Set[str] = set()

    try:
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for idx, item in enumerate(req.items):
                if item.file_id not in uploaded_media:
                    raise HTTPException(status_code=404, detail=f"Media file not found: {item.file_id}")
                media = uploaded_media[item.file_id]
                if media.get("media_type") != "image":
                    raise HTTPException(status_code=400, detail="Batch image censor only supports image files")

                media_path = os.path.join(UPLOADS_DIR, media["saved_filename"])
                frame = safe_imread(media_path)
                if frame is None:
                    raise HTTPException(status_code=400, detail=f"Could not decode image: {media.get('filename')}")

                item_cfg = _build_censor_mask_config(item.mask_config or req.mask_config)
                img_boxes = [_to_bounding_box(b) for b in item.boxes]
                if item.auto_detect_faces:
                    img_boxes.extend(processor.detect_image_faces(media_path, padding_percent=0.20))
                if item.auto_detect_nsfw:
                    img_boxes.extend(processor.detect_image_nsfw(media_path, sensitivity=req.nsfw_sensitivity))

                masked = apply_masks_to_frame(frame, img_boxes, item_cfg) if img_boxes else frame.copy()

                orig_name = media.get("filename") or f"image_{idx + 1}.jpg"
                name_root, ext = os.path.splitext(orig_name)
                img_ext = ext if ext.lower() in IMAGE_EXTENSIONS else ".jpg"
                display_name = f"censored_{name_root}{img_ext}"
                arcname = display_name
                if arcname in used_arcnames:
                    arcname = f"{idx + 1:02d}_{display_name}"
                used_arcnames.add(arcname)

                out_name = f"{batch_id}_{idx + 1:02d}_{display_name}"
                out_path = os.path.join(OUTPUTS_DIR, out_name)
                if not safe_imwrite(out_path, masked):
                    raise HTTPException(status_code=500, detail=f"Failed to write censored image: {orig_name}")
                register_session_file(req.session_id, out_path)
                zf.write(out_path, arcname=arcname)

                results.append({
                    "file_id": item.file_id,
                    "filename": out_name,
                    "display_name": arcname,
                    "target_count": len(img_boxes),
                    "download_url": f"/api/download/{url_segment(out_name)}",
                    "size_bytes": os.path.getsize(out_path),
                })

        register_session_file(req.session_id, zip_path)
        return {
            "type": "batch",
            "batch_id": batch_id,
            "zip_filename": zip_name,
            "zip_download_url": f"/api/download/{url_segment(zip_name)}",
            "zip_size_bytes": os.path.getsize(zip_path),
            "processed_count": len(results),
            "items": results,
        }
    except HTTPException:
        if os.path.isfile(zip_path):
            try:
                os.remove(zip_path)
            except OSError:
                pass
        raise
    except Exception as e:
        if os.path.isfile(zip_path):
            try:
                os.remove(zip_path)
            except OSError:
                pass
        import traceback
        print(f"Error processing censor batch export: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Failed to process batch images: {str(e)}")

# Serve Frontend static assets
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

def get_local_ip():
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

if __name__ == "__main__":
    import uvicorn
    parser = argparse.ArgumentParser(description="Frame Studio local server")
    parser.add_argument("--lan", action="store_true", help="Bind to 0.0.0.0 so devices on your local network can connect")
    parser.add_argument("--port", type=int, default=8000, help="Port to listen on (default: 8000)")
    args = parser.parse_args()

    bind_host = "0.0.0.0" if args.lan else "127.0.0.1"
    print("\n" + "="*55)
    print("  Frame Studio is LIVE!")
    print(f"  Local Access:  http://127.0.0.1:{args.port}")
    if args.lan:
        lan_ip = get_local_ip()
        print(f"  LAN Access:    http://{lan_ip}:{args.port}  (Same Wi-Fi / LAN)")
    print("="*55 + "\n")
    uvicorn.run("server:app", host=bind_host, port=args.port, reload=False)
