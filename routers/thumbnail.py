"""Thumbnail Studio routes."""
from __future__ import annotations

import json
import os
import subprocess
import uuid
import zipfile
from typing import List, Literal, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from core.state import (
    OUTPUTS_DIR,
    THUMBS_DIR,
    UPLOADS_DIR,
    register_session_file,
    resolve_safe_path,
    uploaded_media,
    url_segment,
)
from engine.thumbnail_processor import (
    extract_frames_at_timestamps,
    extract_grid_candidates,
    get_grid_candidate_timestamps,
    render_storyboard_sheet,
    render_thumbnail,
)
from engine.video_processor import get_video_info

router = APIRouter()


class CandidatesRequest(BaseModel):
    file_id: str
    count: int = Field(default=9, ge=1, le=100)
    start_sec: float = 0.0
    end_sec: Optional[float] = None
    session_id: Optional[str] = None


def _resolve_thumb_or_upload_path(filename: str) -> Optional[str]:
    thumb_candidate = resolve_safe_path(THUMBS_DIR, filename)
    if os.path.isfile(thumb_candidate):
        return thumb_candidate
    upload_candidate = resolve_safe_path(UPLOADS_DIR, filename)
    if os.path.isfile(upload_candidate):
        return upload_candidate
    return None


@router.post("/api/thumbnail/extract-candidates")
def get_thumbnail_candidates(req: CandidatesRequest):
    """Extract N candidate frames evenly spaced in the given interval."""
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


@router.post("/api/thumbnail/extract-candidates-stream")
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
        timestamps = get_grid_candidate_timestamps(duration, req.count, req.start_sec, req.end_sec)
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


@router.post("/api/thumbnail/extract-single-frame")
def get_single_frame(req: SingleFrameRequest):
    """Extract a frame at an exact timestamp."""
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
            "ffmpeg",
            "-y",
            "-ss",
            f"{candidate_ts:.3f}",
            "-i",
            video_path,
            "-vframes",
            "1",
            "-q:v",
            "2",
            out_path,
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
        "timestamp_sec": round(used_ts, 3),
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


@router.post("/api/thumbnail/generate-storyboard")
def get_storyboard(req: StoryboardRequest):
    """Render a multi-frame NxN contact sheet collage."""
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
        "url": f"/api/thumbnails/{url_segment(out_filename)}",
    }


class ThumbnailDesignRequest(BaseModel):
    base_image_filename: str
    aspect_ratio: str = "16:9"
    fit_mode: str = "fill"
    resolution_scale: int = Field(default=2, ge=1, le=2)
    adjustments: dict = {}
    text_items: List[dict] = []
    stickers: List[dict] = []
    session_id: Optional[str] = None


@router.post("/api/thumbnail/preview")
def preview_thumbnail_design(req: ThumbnailDesignRequest):
    """Render instant live preview of the designed thumbnail."""
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
        uploads_dir=UPLOADS_DIR,
    )
    register_session_file(req.session_id, out_path)

    return {
        "preview_url": f"/api/thumbnails/{url_segment(out_filename)}?t={uuid.uuid4().hex[:6]}"
    }


class ThumbnailExportRequest(BaseModel):
    base_image_filenames: List[str]
    aspect_ratio: str = "16:9"
    fit_mode: str = "fill"
    resolution_scale: int = Field(default=2, ge=1, le=2)
    adjustments: dict = {}
    text_items: List[dict] = []
    stickers: List[dict] = []
    format: Literal["jpg", "png"] = "jpg"
    include_main_thumbnail: bool = False
    session_id: Optional[str] = None


@router.post("/api/thumbnail/export")
def export_thumbnails(req: ThumbnailExportRequest):
    """Export single or multiple thumbnails with optional ZIP."""
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
            uploads_dir=UPLOADS_DIR,
        )
        register_session_file(req.session_id, out_path)

        outputs.append({
            "filename": out_name,
            "label": item_label,
            "download_url": f"/api/download/{url_segment(out_name)}",
            "size_bytes": os.path.getsize(out_path),
        })

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
        "zip_url": zip_url,
    }
