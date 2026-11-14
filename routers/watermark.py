"""Watermark studio & file compressor routes."""
from __future__ import annotations

import gzip
import io
import os
import shutil
import time
import uuid
import zipfile
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, UploadFile
from PIL import Image
from pydantic import BaseModel

from core.state import (
    ALLOWED_LOGO_EXTENSIONS,
    OFFICE_PACKAGE_EXTENSIONS,
    OUTPUTS_DIR,
    THUMBS_DIR,
    UPLOADS_DIR,
    active_job_paths,
    heavy_task_slot,
    jobs,
    jobs_lock,
    register_session_file,
    release_session_job,
    session_active_jobs,
    session_files_lock,
    uploaded_media,
    url_segment,
)
from engine.image_processor import apply_watermark_to_image, create_watermark_overlay
from engine.models import WatermarkConfig
from engine.video_processor import apply_watermark_to_video

router = APIRouter()


class ProcessRequest(BaseModel):
    file_ids: List[str]
    config: WatermarkConfig
    session_id: Optional[str] = None


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

    with open(input_path, "rb") as source, open(output_path, "wb") as raw_output:
        with gzip.GzipFile(fileobj=raw_output, mode="wb", compresslevel=compression_level, mtime=0) as target:
            shutil.copyfileobj(source, target)
    return output_path


@router.post("/api/upload-watermark-logo")
async def upload_watermark_logo(file: UploadFile = File(...), session_id: Optional[str] = Form(None)):
    """Upload a raster logo/watermark image for use in image layers."""
    orig_name = os.path.basename((file.filename or "logo.png").replace("\\", "/")) or "logo.png"
    ext = os.path.splitext(orig_name)[1].lower()
    if ext not in ALLOWED_LOGO_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Unsupported logo format. Please upload PNG, JPG, WEBP, BMP, or GIF.",
        )
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
        "preview_url": f"/api/uploads/{url_segment(saved_name)}",
    }


@router.post("/api/preview")
def generate_preview(req: ProcessRequest):
    """Render a live watermark preview."""
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

    apply_watermark_to_image(
        preview_base_path,
        preview_output_path,
        req.config,
        UPLOADS_DIR,
        output_quality=92,
    )

    return {
        "preview_url": f"/api/thumbnails/{url_segment(preview_output_name)}?t={uuid.uuid4()}",
        "width": media_item["width"],
        "height": media_item["height"],
    }


@router.post("/api/watermark-overlay")
def get_watermark_overlay(req: ProcessRequest):
    """Return a transparent RGBA PNG overlay sized to the media for real-time video preview."""
    if not req.file_ids:
        raise HTTPException(status_code=400, detail="No file selected")

    file_id = req.file_ids[0]
    media_item = uploaded_media.get(file_id)
    if not media_item:
        raise HTTPException(status_code=404, detail="Media not found")

    width = media_item.get("width") or 1280
    height = media_item.get("height") or 720
    aspect = width / height if height > 0 else 16 / 9
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
        "height": height,
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
                active_job_paths.setdefault(job_id, set()).update(
                    {os.path.abspath(in_path), os.path.abspath(out_path)}
                )

            item_status = {
                "file_id": fid,
                "filename": orig_name,
                "output_filename": out_name,
                "orig_size_bytes": media_item.get("size_bytes", 0),
                "output_size_bytes": 0,
                "status": "processing",
                "progress": 0.0,
                "download_url": None,
                "error": None,
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

                    with heavy_task_slot():
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


@router.post("/api/process")
def start_processing(req: ProcessRequest, background_tasks: BackgroundTasks):
    """Start batch or single media watermarking / compression."""
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
