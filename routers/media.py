"""Shared upload, download, job status, session cleanup, capabilities, and LAN auth routes."""
from __future__ import annotations

import json
import os
import shutil
import uuid
import zipfile
from typing import List, Optional

from fastapi import APIRouter, Cookie, File, Form, Header, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, ImageOps
from pydantic import BaseModel

from core.state import (
    ACTIVE_JOB_STATUSES,
    ANDROID_OUTPUT_DIR,
    AUDIO_EXTENSIONS,
    IMAGE_EXTENSIONS,
    LAN_AUTH_COOKIE,
    OUTPUTS_DIR,
    THUMBS_DIR,
    UPLOADS_DIR,
    VIDEO_EXTENSIONS,
    jobs,
    jobs_lock,
    lan_auth_state,
    pending_session_cleanup,
    register_session_file,
    remove_session_files,
    resolve_safe_path,
    session_active_jobs,
    session_files_lock,
    uploaded_media,
    url_segment,
    verify_lan_pin,
)
from engine.hw_accel import get_encoder_info
from engine.video_processor import extract_video_frame, get_video_info

router = APIRouter()


class LanPinRequest(BaseModel):
    pin: str


@router.get("/api/auth/lan-status")
def get_lan_auth_status(
    request: Request,
    fs_lan_token: Optional[str] = Cookie(default=None),
    authorization: Optional[str] = Header(default=None),
    x_lan_token: Optional[str] = Header(default=None),
):
    from core.state import is_lan_token_valid, is_loopback_client

    client_host = request.client.host if request.client else ""
    token = x_lan_token or fs_lan_token
    if not token and authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()

    enabled = bool(lan_auth_state["enabled"])
    authenticated = (not enabled) or is_loopback_client(client_host) or is_lan_token_valid(token)
    return {"lan_protected": enabled, "authenticated": authenticated}


@router.post("/api/auth/lan-verify")
def post_lan_verify(req: LanPinRequest, response: Response):
    if not lan_auth_state["enabled"]:
        return {"authenticated": True, "lan_protected": False, "token": None}

    token = verify_lan_pin(req.pin)
    if not token:
        raise HTTPException(status_code=401, detail="Invalid LAN pairing PIN")

    response.set_cookie(
        key=LAN_AUTH_COOKIE,
        value=token,
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 12,
    )
    return {"authenticated": True, "lan_protected": True, "token": token}


@router.get("/api/system/capabilities")
def system_capabilities():
    from engine.censor_processor import NudeNetDetector

    return {
        "hw_accel": get_encoder_info(),
        "nudenet_available": NudeNetDetector.is_available(),
        "lan_protected": bool(lan_auth_state["enabled"]),
    }


@router.post("/api/upload-media")
def upload_media(files: List[UploadFile] = File(...), session_id: Optional[str] = Form(None)):
    """Upload one or multiple images, videos, audio clips, or documents."""
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

        if ext in IMAGE_EXTENSIONS:
            media_type = "image"
        elif ext in VIDEO_EXTENSIONS:
            media_type = "video"
        elif ext in AUDIO_EXTENSIONS:
            media_type = "audio"
        else:
            media_type = "unknown"

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

                    # Downscale in-place for preview, then derive small thumb from preview (3x less peak RAM)
                    preview_img = img.copy()
                    if img is not raw_img:
                        img.close()
                    preview_img.thumbnail((1440, 1440), Image.Resampling.LANCZOS)
                    preview_img.convert("RGB").save(preview_base_path, "JPEG", quality=92)
                    register_session_file(session_id, preview_base_path)

                    thumb_img = preview_img.copy()
                    preview_img.close()
                    thumb_img.thumbnail((240, 240), Image.Resampling.LANCZOS)
                    thumb_img.convert("RGB").save(thumb_path, "JPEG", quality=85)
                    thumb_img.close()
                    register_session_file(session_id, thumb_path)
            elif media_type == "video":
                info = get_video_info(save_path)
                width, height = info["width"], info["height"]
                duration = info["duration"]
                if width <= 0 or height <= 0:
                    raise ValueError("Video has empty dimensions")

                raw_frame_path = os.path.join(THUMBS_DIR, f"raw_frame_{file_id}.jpg")
                try:
                    extract_video_frame(
                        save_path,
                        raw_frame_path,
                        timestamp_sec=min(0.5, duration / 2 if duration else 0.5),
                    )
                    with Image.open(raw_frame_path) as raw_frame:
                        frame = ImageOps.exif_transpose(raw_frame)
                        preview_img = frame.copy()
                        if frame is not raw_frame:
                            frame.close()
                        preview_img.thumbnail((1440, 1440), Image.Resampling.LANCZOS)
                        preview_img.convert("RGB").save(preview_base_path, "JPEG", quality=92)
                        register_session_file(session_id, preview_base_path)

                        thumb_img = preview_img.copy()
                        preview_img.close()
                        thumb_img.thumbnail((240, 240), Image.Resampling.LANCZOS)
                        thumb_img.convert("RGB").save(thumb_path, "JPEG", quality=85)
                        thumb_img.close()
                        register_session_file(session_id, thumb_path)
                finally:
                    if os.path.exists(raw_frame_path):
                        try:
                            os.remove(raw_frame_path)
                        except Exception:
                            pass
            elif media_type == "audio":
                try:
                    info = get_video_info(save_path)
                    duration = float(info.get("duration") or 0.0)
                except Exception:
                    duration = 0.0
        except Exception as e:
            for p in (save_path, preview_base_path, thumb_path):
                try:
                    if os.path.isfile(p):
                        os.remove(p)
                except OSError:
                    pass
            if media_type in ("image", "video"):
                raise HTTPException(status_code=400, detail=f"Invalid or unreadable {media_type} file '{orig_name}': {e}")

        media_item = {
            "id": file_id,
            "filename": orig_name,
            "saved_filename": save_filename,
            "media_type": media_type,
            "thumb_url": f"/api/thumbnails/{url_segment(thumb_filename)}" if media_type in ("image", "video") else None,
            "preview_base_filename": preview_base_filename if media_type in ("image", "video") else None,
            "width": width,
            "height": height,
            "duration": round(duration, 2),
            "size_bytes": os.path.getsize(save_path),
            "session_id": session_id,
        }
        uploaded_media[file_id] = media_item
        results.append(media_item)

    return {"media": results}


@router.post("/api/compress/upload")
def upload_compress_files(files: List[UploadFile] = File(...), session_id: Optional[str] = Form(None)):
    """Accept any file for compression, keeping image/video preview handling shared."""
    result = upload_media(files, session_id)
    for item in result["media"]:
        if item["media_type"] == "unknown":
            item["media_type"] = "document"
            item["format_name"] = os.path.splitext(item["filename"])[1].lstrip(".").upper() or "FILE"
            uploaded_media[item["id"]]["media_type"] = "document"
            uploaded_media[item["id"]]["format_name"] = item["format_name"]
    return result


@router.get("/api/media")
def list_media():
    return {"media": list(uploaded_media.values())}


@router.delete("/api/media/{file_id}")
def delete_media(file_id: str):
    if file_id in uploaded_media:
        item = uploaded_media.pop(file_id)
        fn = item.get("saved_filename")
        if fn:
            fpath = os.path.join(UPLOADS_DIR, fn)
            if os.path.exists(fpath):
                try:
                    os.remove(fpath)
                except Exception:
                    pass
        for prefix in ("thumb_", "preview_base_"):
            p = os.path.join(THUMBS_DIR, f"{prefix}{file_id}.jpg")
            if os.path.exists(p):
                try:
                    os.remove(p)
                except Exception:
                    pass
        return {"success": True}
    raise HTTPException(status_code=404, detail="Media not found")


@router.post("/api/session/cleanup")
async def cleanup_tab_session(request: Request):
    """Called on pagehide/beforeunload via navigator.sendBeacon to purge files for this tab."""
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


@router.get("/api/job/{job_id}")
@router.get("/api/job-status/{job_id}")
def get_job_status(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        return dict(job)


@router.post("/api/job/{job_id}/cancel")
def cancel_job(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        if job.get("status") in ACTIVE_JOB_STATUSES:
            job["cancelled"] = True
            return {"job_id": job_id, "status": "cancelling"}
        return {"job_id": job_id, "status": job.get("status")}


@router.get("/api/download/{filename}")
def download_file(filename: str):
    filepath = resolve_safe_path(OUTPUTS_DIR, filename, must_exist=True)
    parts = os.path.basename(filepath).split("_", 1)
    display_name = parts[1] if len(parts) > 1 else os.path.basename(filepath)
    return FileResponse(filepath, filename=display_name)


@router.get("/api/download-zip/{job_id}")
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


@router.get("/api/thumbnails/{filename}")
def get_thumbnail(filename: str):
    path = resolve_safe_path(THUMBS_DIR, filename, must_exist=True)
    return FileResponse(
        path,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma": "no-cache",
        },
    )


@router.get("/api/uploads/{filename}")
def get_upload_file(filename: str):
    path = resolve_safe_path(UPLOADS_DIR, filename, must_exist=True)
    ext = os.path.splitext(path)[1].lower()
    if ext not in (IMAGE_EXTENSIONS | VIDEO_EXTENSIONS | AUDIO_EXTENSIONS):
        return FileResponse(path, media_type="application/octet-stream", filename=os.path.basename(path))
    return FileResponse(path)


@router.get("/apk")
def download_apk():
    """Download the latest built Android APK."""
    apk_path = os.path.join(ANDROID_OUTPUT_DIR, "FrameStudio-Android.apk")
    if not os.path.isfile(apk_path):
        raise HTTPException(status_code=404, detail="APK not built yet. Run: python tools/build_apk.py")
    return FileResponse(
        apk_path,
        media_type="application/vnd.android.package-archive",
        filename="FrameStudio-Android.apk",
    )
