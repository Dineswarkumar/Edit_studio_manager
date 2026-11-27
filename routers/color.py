"""Color & 3D LUT Studio routes."""
from __future__ import annotations

import os
import shutil
import time
import uuid
import zipfile
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from core.state import (
    OUTPUTS_DIR,
    THUMBS_DIR,
    UPLOADS_DIR,
    active_job_paths,
    dedupe_output_name,
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
from engine.color_processor import (
    LUT_CATALOG,
    ColorGradeConfig,
    apply_color_grade_to_image,
    apply_color_grade_to_video,
    load_cube_lut,
)
from engine.video_processor import extract_video_frame

router = APIRouter()


class ColorPreviewRequest(BaseModel):
    file_id: str
    config: ColorGradeConfig
    frame_sec: Optional[float] = None
    session_id: Optional[str] = None


class ColorBatchRequest(BaseModel):
    file_ids: List[str]
    config: ColorGradeConfig
    session_id: Optional[str] = None


@router.get("/api/color/luts")
def list_luts():
    return {"luts": LUT_CATALOG}


@router.post("/api/color/upload-lut")
def upload_custom_lut(file: UploadFile = File(...), session_id: Optional[str] = Form(None)):
    orig_name = os.path.basename((file.filename or "custom.cube").replace("\\", "/")) or "custom.cube"
    ext = os.path.splitext(orig_name)[1].lower()
    if ext != ".cube":
        raise HTTPException(status_code=400, detail="Only Adobe .cube 3D LUT files are supported.")

    saved_name = f"lut_{uuid.uuid4().hex[:8]}_{orig_name}"
    saved_path = os.path.join(UPLOADS_DIR, saved_name)
    with open(saved_path, "wb") as f:
        shutil.copyfileobj(file.file, f)
    register_session_file(session_id, saved_path)

    try:
        size, _table, _dmin, _dmax = load_cube_lut(saved_path)
    except Exception as exc:
        if os.path.exists(saved_path):
            try:
                os.remove(saved_path)
            except OSError:
                pass
        raise HTTPException(status_code=400, detail=f"Invalid .cube file: {exc}")

    return {"filename": saved_name, "label": os.path.splitext(orig_name)[0], "lut_size": size}


@router.post("/api/color/preview")
def preview_color_grade(req: ColorPreviewRequest):
    media_item = uploaded_media.get(req.file_id)
    if not media_item:
        raise HTTPException(status_code=404, detail="Media item not found")

    mtype = media_item.get("media_type")
    src_path = None
    frame_key = "base"

    if mtype == "video" and req.frame_sec is not None:
        sec = round(max(0.0, float(req.frame_sec)), 2)
        frame_key = f"f{int(round(sec * 100))}"
        scrub_frame_path = os.path.join(THUMBS_DIR, f"color_src_{media_item['id']}.jpg")
        video_path = os.path.join(UPLOADS_DIR, media_item["saved_filename"])
        extract_video_frame(video_path, scrub_frame_path, timestamp_sec=sec)
        register_session_file(req.session_id, scrub_frame_path)
        src_path = scrub_frame_path

    if not src_path:
        preview_base = media_item.get("preview_base_filename") or f"preview_base_{media_item['id']}.jpg"
        candidate_base = os.path.join(THUMBS_DIR, preview_base)
        if os.path.isfile(candidate_base):
            src_path = candidate_base
        elif mtype == "video":
            fallback_src = os.path.join(THUMBS_DIR, f"color_src_{media_item['id']}.jpg")
            video_path = os.path.join(UPLOADS_DIR, media_item["saved_filename"])
            extract_video_frame(video_path, fallback_src, timestamp_sec=0.5)
            register_session_file(req.session_id, fallback_src)
            src_path = fallback_src
        else:
            src_path = os.path.join(UPLOADS_DIR, media_item["saved_filename"])

    if not os.path.exists(src_path):
        raise HTTPException(status_code=404, detail="Preview source missing")

    # Overwrite deterministic rolling preview paths to prevent orphan JPEG bloat during slider scrubbing
    before_name = f"color_before_{media_item['id']}.jpg"
    before_path = os.path.join(THUMBS_DIR, before_name)
    if req.frame_sec is not None or not os.path.exists(before_path):
        apply_color_grade_to_image(src_path, before_path, ColorGradeConfig(), [UPLOADS_DIR], max_dim=1280)
        register_session_file(req.session_id, before_path)

    after_name = f"color_after_{media_item['id']}.jpg"
    after_path = os.path.join(THUMBS_DIR, after_name)
    apply_color_grade_to_image(src_path, after_path, req.config, [UPLOADS_DIR], max_dim=1280)
    register_session_file(req.session_id, after_path)

    bust = f"{frame_key}_{uuid.uuid4().hex[:6]}"
    return {
        "before_url": f"/api/thumbnails/{url_segment(before_name)}?v={bust}",
        "after_url": f"/api/thumbnails/{url_segment(after_name)}?v={bust}",
    }


def _resolve_color_image_ext(orig_ext: str, requested_fmt: str) -> str:
    fmt = (requested_fmt or "original").strip().lower().lstrip(".")
    if fmt in ("jpg", "jpeg"):
        return ".jpg"
    if fmt == "png":
        return ".png"
    if fmt == "webp":
        return ".webp"
    return orig_ext if orig_ext.lower() in (".jpg", ".jpeg", ".png", ".webp") else ".jpg"


def _color_batch_worker(job_id: str, file_ids: List[str], config: ColorGradeConfig, session_id: Optional[str] = None):
    with jobs_lock:
        job = jobs[job_id]
    total_files = max(1, len(file_ids))
    was_cancelled = False
    used_output_names = set()

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
            name_root, orig_ext = os.path.splitext(orig_name)
            mtype = media_item.get("media_type")
            out_ext = ".mp4" if mtype == "video" else _resolve_color_image_ext(orig_ext, config.export_format)
            out_name = dedupe_output_name(used_output_names, f"graded_{name_root}{out_ext}")
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
                "error": None,
            }
            with jobs_lock:
                job["items"].append(item_status)

            try:
                if mtype == "image":
                    apply_color_grade_to_image(in_path, out_path, config, [UPLOADS_DIR])
                elif mtype == "video":
                    def on_vid(p: float):
                        with jobs_lock:
                            item_status["progress"] = p
                            job["progress"] = round((idx + p) / total_files, 2)

                    with heavy_task_slot():
                        apply_color_grade_to_video(in_path, out_path, config, [UPLOADS_DIR], progress_cb=on_vid)
                else:
                    raise ValueError(f"Unsupported media type for Color Studio: {mtype}")

                register_session_file(session_id, out_path)
                item_status["progress"] = 1.0
                item_status["status"] = "completed"
                item_status["output_size_bytes"] = os.path.getsize(out_path) if os.path.exists(out_path) else 0
                item_status["download_url"] = f"/api/download/{url_segment(f'{job_id}_{out_name}')}"
            except Exception as exc:
                item_status["status"] = "failed"
                item_status["error"] = str(exc)

            with jobs_lock:
                job["progress"] = round((idx + 1) / total_files, 2)

        completed = [it for it in job["items"] if it["status"] == "completed"]
        if completed and not was_cancelled:
            zip_name = f"{job_id}_graded_batch.zip"
            zip_path = os.path.join(OUTPUTS_DIR, zip_name)
            with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                for it in completed:
                    full_p = os.path.join(OUTPUTS_DIR, f"{job_id}_{it['output_filename']}")
                    if os.path.exists(full_p):
                        zf.write(full_p, arcname=it["output_filename"])
            register_session_file(session_id, zip_path)
            with jobs_lock:
                job["zip_filename"] = zip_name

        with jobs_lock:
            if was_cancelled:
                job["status"] = "cancelled"
            elif completed:
                job["status"] = "completed"
                job["progress"] = 1.0
                if len(completed) == 1:
                    job["filename"] = completed[0]["output_filename"]
                    job["download_url"] = completed[0]["download_url"]
            else:
                job["status"] = "failed"
                job["error"] = job["items"][0]["error"] if job["items"] else "Color grading failed."
    finally:
        with jobs_lock:
            active_job_paths.pop(job_id, None)
        release_session_job(session_id)


@router.post("/api/color/process")
def start_color_batch(req: ColorBatchRequest, bg: BackgroundTasks):
    if not req.file_ids:
        raise HTTPException(status_code=400, detail="No files selected")
    valid_ids = list(dict.fromkeys(fid for fid in req.file_ids if fid in uploaded_media))
    if not valid_ids:
        raise HTTPException(status_code=404, detail="Uploaded media items not found")

    job_id = f"color_{uuid.uuid4().hex[:8]}"
    with jobs_lock:
        jobs[job_id] = {
            "id": job_id,
            "type": "color",
            "status": "processing",
            "progress": 0.0,
            "items": [],
            "zip_filename": None,
            "cancelled": False,
            "created_at": time.time(),
        }
    if req.session_id:
        with session_files_lock:
            session_active_jobs[req.session_id] = session_active_jobs.get(req.session_id, 0) + 1

    bg.add_task(_color_batch_worker, job_id, valid_ids, req.config, req.session_id)
    return {"job_id": job_id, "status": "processing"}
