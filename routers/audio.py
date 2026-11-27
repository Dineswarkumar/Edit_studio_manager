"""Audio Booster & EBU R128 Normalizer routes."""
from __future__ import annotations

import os
import time
import uuid
import zipfile
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
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
from engine.audio_processor import (
    AudioBoostConfig,
    analyze_audio_stats,
    process_audio_file,
    render_audio_preview_snippet,
    resolve_audio_output_ext,
)

router = APIRouter()


class AudioInspectRequest(BaseModel):
    file_id: str


class AudioPreviewRequest(BaseModel):
    file_id: str
    config: AudioBoostConfig
    start_sec: float = 0.0
    session_id: Optional[str] = None


class AudioProcessRequest(BaseModel):
    file_ids: List[str]
    config: AudioBoostConfig
    session_id: Optional[str] = None


@router.post("/api/audio/analyze")
def analyze_uploaded_audio(req: AudioInspectRequest):
    media_item = uploaded_media.get(req.file_id)
    if not media_item:
        raise HTTPException(status_code=404, detail="Media item not found")
    in_path = os.path.join(UPLOADS_DIR, media_item["saved_filename"])
    if not os.path.exists(in_path):
        raise HTTPException(status_code=404, detail="Media file missing")
    stats = analyze_audio_stats(in_path)
    return {"file_id": req.file_id, "filename": media_item["filename"], "stats": stats}


@router.post("/api/audio/preview")
def preview_boosted_audio(req: AudioPreviewRequest):
    media_item = uploaded_media.get(req.file_id)
    if not media_item:
        raise HTTPException(status_code=404, detail="Media item not found")
    in_path = os.path.join(UPLOADS_DIR, media_item["saved_filename"])
    if not os.path.exists(in_path):
        raise HTTPException(status_code=404, detail="Media file missing")

    prev_name = f"audio_prev_{media_item['id']}.m4a"
    prev_path = os.path.join(THUMBS_DIR, prev_name)
    try:
        res = render_audio_preview_snippet(in_path, prev_path, req.config, start_sec=req.start_sec, duration_sec=15.0)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Preview failed: {exc}")

    register_session_file(req.session_id, prev_path)
    return {
        "preview_url": f"/api/thumbnails/{url_segment(prev_name)}?v={uuid.uuid4().hex[:6]}",
        "input_stats": res["input_stats"],
        "output_stats": res["output_stats"],
    }


def _audio_batch_worker(job_id: str, file_ids: List[str], config: AudioBoostConfig, session_id: Optional[str] = None):
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
            name_root, _ = os.path.splitext(orig_name)
            has_video = media_item.get("media_type") == "video"
            out_ext = resolve_audio_output_ext(in_path, config.output_format, has_video)
            out_name = dedupe_output_name(used_output_names, f"boosted_{name_root}{out_ext}")
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
                "input_lufs": None,
                "output_lufs": None,
                "true_peak_db": None,
                "error": None,
            }
            with jobs_lock:
                job["items"].append(item_status)

            try:
                with heavy_task_slot():
                    result = process_audio_file(in_path, out_path, config)
                register_session_file(session_id, out_path)
                item_status["progress"] = 1.0
                item_status["status"] = "completed"
                item_status["output_size_bytes"] = os.path.getsize(out_path) if os.path.exists(out_path) else 0
                item_status["download_url"] = f"/api/download/{url_segment(f'{job_id}_{out_name}')}"
                item_status["input_lufs"] = result["input_stats"].get("integrated_lufs")
                item_status["output_lufs"] = result["output_stats"].get("integrated_lufs")
                item_status["true_peak_db"] = result["output_stats"].get("true_peak_db")
            except Exception as exc:
                item_status["status"] = "failed"
                item_status["error"] = str(exc)

            with jobs_lock:
                job["progress"] = round((idx + 1) / total_files, 2)

        completed = [it for it in job["items"] if it["status"] == "completed"]
        if completed and not was_cancelled:
            zip_name = f"{job_id}_audio_batch.zip"
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
                job["error"] = job["items"][0]["error"] if job["items"] else "Audio processing failed."
    finally:
        with jobs_lock:
            active_job_paths.pop(job_id, None)
        release_session_job(session_id)


@router.post("/api/audio/process")
def start_audio_batch(req: AudioProcessRequest, bg: BackgroundTasks):
    if not req.file_ids:
        raise HTTPException(status_code=400, detail="No files selected")
    valid_ids = list(dict.fromkeys(fid for fid in req.file_ids if fid in uploaded_media))
    if not valid_ids:
        raise HTTPException(status_code=404, detail="Uploaded media items not found")

    job_id = f"audio_{uuid.uuid4().hex[:8]}"
    with jobs_lock:
        jobs[job_id] = {
            "id": job_id,
            "type": "audio",
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

    bg.add_task(_audio_batch_worker, job_id, valid_ids, req.config, req.session_id)
    return {"job_id": job_id, "status": "processing"}
