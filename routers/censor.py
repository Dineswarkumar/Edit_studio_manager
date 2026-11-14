"""Privacy / Censor Studio routes (faces, NudeNet body-part privacy, brush/eraser, batch video)."""
from __future__ import annotations

import json
import os
import shutil
import time
import uuid
import zipfile
from typing import List, Literal, Optional, Set

import cv2
from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel, Field, field_validator

from core.state import (
    IMAGE_EXTENSIONS,
    OUTPUTS_DIR,
    STATIC_DIR,
    THUMBS_DIR,
    UPLOADS_DIR,
    VIDEO_EXTENSIONS,
    active_job_paths,
    heavy_task_slot,
    jobs,
    jobs_lock,
    register_session_file,
    release_session_job,
    resolve_safe_path,
    session_active_jobs,
    session_files_lock,
    uploaded_media,
    url_segment,
)
from engine.censor_processor import (
    BoundingBox,
    CensorProcessor,
    MaskConfig,
    apply_masks_to_frame,
    detect_nsfw_candidates,
    safe_imread,
    safe_imwrite,
)

router = APIRouter()

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
    brush_radius: float = Field(default=24.0, ge=1.0, le=2000.0)
    eraser_points: Optional[List[List[float]]] = None
    eraser_radius: float = Field(default=24.0, ge=1.0, le=2000.0)
    mask_type: Optional[Literal["blur", "pixelate", "emoji", "redact"]] = None
    start_sec: Optional[float] = None
    end_sec: Optional[float] = None

    @field_validator("brush_radius", "eraser_radius", mode="before")
    @classmethod
    def _coerce_null_radius(cls, value):
        return 24.0 if value is None else value


class CensorMaskConfigModel(BaseModel):
    mask_type: Literal["blur", "pixelate", "emoji", "redact"] = "blur"
    intensity: int = 60
    feather: int = Field(default=25, ge=0, le=100)
    emoji_name: str = "sunglasses"
    custom_sticker_filename: Optional[str] = None
    redact_text: Optional[str] = "[CENSORED]"
    shape: Literal["oval", "rect", "circle", "triangle", "heart"] = "oval"
    mask_region: Literal["face", "eyes"] = "face"
    face_fit: Literal["exact", "standard", "loose"] = "standard"
    padding_percent: float = Field(default=0.20, ge=-0.10, le=0.35)


class CensorDetectRequest(BaseModel):
    file_id: str
    frame_sec: Optional[float] = 0.0
    sensitivity: float = Field(default=0.5, ge=0.0, le=1.0)
    face_fit: Literal["exact", "standard", "loose"] = "standard"
    padding_percent: Optional[float] = None
    nsfw_classes: Optional[List[str]] = None
    exclude_faces: bool = True


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
    nsfw_classes: Optional[List[str]] = None
    boxes: List[CensorBoxModel] = []
    mask_config: CensorMaskConfigModel = CensorMaskConfigModel()
    session_id: Optional[str] = None


class CensorBatchItemModel(BaseModel):
    file_id: str
    mode: Optional[Literal["faces_all", "face_single", "specific_object", "nsfw"]] = None
    boxes: List[CensorBoxModel] = []
    auto_detect_faces: bool = False
    auto_detect_nsfw: bool = False
    mask_config: Optional[CensorMaskConfigModel] = None


class CensorBatchProcessRequest(BaseModel):
    items: List[CensorBatchItemModel]
    mask_config: CensorMaskConfigModel = CensorMaskConfigModel()
    nsfw_sensitivity: float = Field(default=0.5, ge=0.0, le=1.0)
    nsfw_classes: Optional[List[str]] = None
    session_id: Optional[str] = None


def _to_bounding_box(b: CensorBoxModel) -> BoundingBox:
    brush_pts = None
    if b.brush_points:
        brush_pts = [(float(pt[0]), float(pt[1])) for pt in b.brush_points if len(pt) >= 2]
    kwargs = dict(
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
    # Extra optional fields added dynamically as CensorProcessor evolves in Phase B1
    if hasattr(BoundingBox, "eraser_points"):
        eraser_pts = [(float(pt[0]), float(pt[1])) for pt in (b.eraser_points or []) if len(pt) >= 2] if b.eraser_points else None
        kwargs["eraser_points"] = eraser_pts
        kwargs["eraser_radius"] = float(b.eraser_radius)
    if hasattr(BoundingBox, "start_sec"):
        kwargs["start_sec"] = b.start_sec
        kwargs["end_sec"] = b.end_sec
    return BoundingBox(**kwargs)


def _build_censor_mask_config(mask_cfg_model: CensorMaskConfigModel) -> MaskConfig:
    custom_sticker_path = None
    if mask_cfg_model.custom_sticker_filename:
        c_path = resolve_safe_path(UPLOADS_DIR, mask_cfg_model.custom_sticker_filename)
        if os.path.isfile(c_path):
            custom_sticker_path = c_path

    kwargs = dict(
        mask_type=mask_cfg_model.mask_type,
        intensity=mask_cfg_model.intensity,
        emoji_name=mask_cfg_model.emoji_name,
        custom_sticker_path=custom_sticker_path,
        redact_text=mask_cfg_model.redact_text,
        shape=mask_cfg_model.shape if mask_cfg_model.shape in ("oval", "rect") or "feather" in MaskConfig.__dataclass_fields__ else "oval",
        mask_region=mask_cfg_model.mask_region,
        padding_percent=float(mask_cfg_model.padding_percent),
    )
    if "feather" in MaskConfig.__dataclass_fields__:
        kwargs["feather"] = int(mask_cfg_model.feather)
    if "face_fit" in MaskConfig.__dataclass_fields__:
        kwargs["face_fit"] = mask_cfg_model.face_fit
    return MaskConfig(**kwargs)


def _read_censor_frame(media: dict, frame_sec: float):
    """Read the requested source frame without substituting a mismatched thumbnail."""
    media_path = os.path.join(UPLOADS_DIR, media["saved_filename"])
    if media["media_type"] == "image":
        frame = safe_imread(media_path)
        if frame is None:
            raise HTTPException(status_code=400, detail="Could not read image from media")
        return frame

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


@router.post("/api/censor/detect-nsfw")
def api_censor_detect_nsfw(req: CensorDetectRequest):
    if req.file_id not in uploaded_media:
        raise HTTPException(status_code=404, detail="Media file not found")

    media = uploaded_media[req.file_id]
    frame = _read_censor_frame(media, req.frame_sec or 0.0)
    processor = get_censor_processor()
    face_boxes = processor.detector.detect(frame, padding_percent=0.05) if req.exclude_faces else []

    detect_fn = getattr(processor, "detect_nsfw_frame", None)
    if callable(detect_fn):
        detect_kwargs = dict(
            sensitivity=req.sensitivity,
            face_boxes=face_boxes,
            allowed_classes=req.nsfw_classes,
        )
        if "check_orientations" in detect_fn.__code__.co_varnames:
            detect_kwargs["check_orientations"] = True
        candidates, detector_name, warning_msg = detect_fn(frame, **detect_kwargs)
    else:
        candidates = detect_nsfw_candidates(frame, sensitivity=req.sensitivity, face_boxes=face_boxes)
        detector_name = "skin-region heuristic"
        warning_msg = "Candidate regions only; review every result before export."

    return {
        "file_id": req.file_id,
        "width": int(frame.shape[1]),
        "height": int(frame.shape[0]),
        "candidates": [c.to_dict() for c in candidates],
        "detector": detector_name,
        "warning": warning_msg,
    }


@router.post("/api/censor/detect-faces")
def api_censor_detect_faces(req: CensorDetectRequest):
    if req.file_id not in uploaded_media:
        raise HTTPException(status_code=404, detail="Media file not found")

    media = uploaded_media[req.file_id]
    processor = get_censor_processor()
    frame = _read_censor_frame(media, req.frame_sec or 0.0)

    pad = req.padding_percent
    if pad is None:
        pad = 0.0 if req.face_fit == "exact" else (0.28 if req.face_fit == "loose" else 0.20)

    detect_kwargs = {"padding_percent": float(pad)}
    if "face_fit" in processor.detector.detect.__code__.co_varnames:
        detect_kwargs["face_fit"] = req.face_fit
    faces = processor.detector.detect(frame, **detect_kwargs)
    for idx, f in enumerate(faces):
        f.track_id = idx + 1
    return {
        "file_id": req.file_id,
        "width": int(frame.shape[1]),
        "height": int(frame.shape[0]),
        "faces": [f.to_dict() for f in faces],
    }


@router.post("/api/censor/preview")
def api_censor_preview(req: CensorPreviewRequest):
    if req.file_id not in uploaded_media:
        raise HTTPException(status_code=404, detail="Media file not found")

    media = uploaded_media[req.file_id]
    frame = _read_censor_frame(media, req.frame_sec or 0.0)

    h, w = frame.shape[:2]
    max_preview_dim = 1280
    scale = 1.0
    if max(h, w) > max_preview_dim:
        scale = max_preview_dim / float(max(h, w))
        frame = cv2.resize(frame, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)

    boxes = []
    for b in req.boxes:
        bx = int(b.x * scale)
        by = int(b.y * scale)
        bw = max(4, int(b.w * scale))
        bh = max(4, int(b.h * scale))
        lm = [[pt[0] * scale, pt[1] * scale] for pt in b.landmarks] if b.landmarks else None
        bp = [[pt[0] * scale, pt[1] * scale] for pt in b.brush_points] if b.brush_points else None
        ep = [[pt[0] * scale, pt[1] * scale] for pt in b.eraser_points] if b.eraser_points else None
        br = max(1.0, b.brush_radius * scale)
        er = max(1.0, b.eraser_radius * scale)
        boxes.append(
            _to_bounding_box(
                CensorBoxModel(
                    x=bx,
                    y=by,
                    w=bw,
                    h=bh,
                    confidence=b.confidence,
                    label=b.label,
                    track_id=b.track_id,
                    landmarks=lm,
                    kind=b.kind,
                    brush_points=bp,
                    brush_radius=br,
                    eraser_points=ep,
                    eraser_radius=er,
                    mask_type=b.mask_type,
                    start_sec=b.start_sec,
                    end_sec=b.end_sec,
                )
            )
        )

    mask_cfg = _build_censor_mask_config(req.mask_config)
    masked = apply_masks_to_frame(frame, boxes, mask_cfg)
    prefix = "censor_raw" if (not boxes and req.preview_revision == 0) else "censor_prev"
    preview_name = f"{prefix}_{req.file_id}.jpg"
    preview_path = os.path.join(THUMBS_DIR, preview_name)
    if not safe_imwrite(preview_path, masked):
        raise HTTPException(status_code=500, detail="Failed to encode censor preview")
    register_session_file(req.session_id, preview_path)

    return {
        "preview_url": f"/api/thumbnails/{url_segment(preview_name)}?v={uuid.uuid4().hex[:6]}",
        "revision": req.preview_revision,
        "width": int(masked.shape[1]),
        "height": int(masked.shape[0]),
    }


class _JobCancelledError(Exception):
    pass


def video_censor_worker(
    job_id: str,
    media: dict,
    out_path: str,
    out_name: str,
    req: CensorProcessRequest,
):
    processor = get_censor_processor()
    mask_cfg = _build_censor_mask_config(req.mask_config)
    if req.mode in ("nsfw", "specific_object"):
        mask_cfg.mask_region = "face"
    media_path = os.path.join(UPLOADS_DIR, media["saved_filename"])

    try:
        def on_prog(pct):
            with jobs_lock:
                job = jobs.get(job_id)
                if not job:
                    return
                if pct >= 5.0 and job.get("cancelled"):
                    raise _JobCancelledError("Export cancelled by user")
                job["progress"] = round(float(pct), 1)
                if job["items"]:
                    job["items"][0]["progress"] = round(float(pct) / 100.0, 2)

        with heavy_task_slot():
            kwargs = dict(
                input_video_path=media_path,
                output_video_path=out_path,
                mask_config=mask_cfg,
                mode=req.mode,
                selected_track_id=req.selected_track_id,
                selected_face_box=_to_bounding_box(req.selected_face_box) if req.selected_face_box else None,
                custom_boxes=[_to_bounding_box(b) for b in req.boxes],
                excluded_face_boxes=[_to_bounding_box(b) for b in req.excluded_face_boxes],
                track_custom_objects=req.track_custom_objects,
                nsfw_sensitivity=req.nsfw_sensitivity,
                progress_callback=on_prog,
            )
            if "nsfw_classes" in processor.process_video.__code__.co_varnames:
                kwargs["nsfw_classes"] = req.nsfw_classes
            processor.process_video(**kwargs)

        register_session_file(req.session_id, out_path)
        actual_out_name = os.path.basename(out_path)
        size_bytes = os.path.getsize(out_path) if os.path.exists(out_path) else 0
        dl_url = f"/api/download/{url_segment(actual_out_name)}"
        with jobs_lock:
            if job_id in jobs:
                jobs[job_id]["progress"] = 100.0
                jobs[job_id]["status"] = "completed"
                jobs[job_id]["filename"] = actual_out_name
                jobs[job_id]["size_bytes"] = size_bytes
                jobs[job_id]["download_url"] = dl_url
                if jobs[job_id]["items"]:
                    jobs[job_id]["items"][0].update({
                        "status": "completed",
                        "progress": 1.0,
                        "output_size_bytes": size_bytes,
                        "download_url": dl_url,
                    })
    except _JobCancelledError:
        try:
            if os.path.isfile(out_path):
                os.remove(out_path)
        except OSError:
            pass
        with jobs_lock:
            if job_id in jobs:
                jobs[job_id]["status"] = "cancelled"
    except Exception as e:
        with jobs_lock:
            if job_id in jobs:
                jobs[job_id]["status"] = "failed"
                jobs[job_id]["error"] = str(e)
                if jobs[job_id]["items"]:
                    jobs[job_id]["items"][0].update({"status": "failed", "error": str(e)})
    finally:
        release_session_job(req.session_id)


@router.post("/api/censor/process")
def api_censor_process(req: CensorProcessRequest, background_tasks: BackgroundTasks):
    if req.file_id not in uploaded_media:
        raise HTTPException(status_code=404, detail="Media file not found")

    media = uploaded_media[req.file_id]
    media_path = os.path.join(UPLOADS_DIR, media["saved_filename"])
    orig_name = media["filename"]
    name_root, ext = os.path.splitext(orig_name)

    if media["media_type"] == "image":
        mask_cfg = _build_censor_mask_config(req.mask_config)
        if req.mode in ("nsfw", "specific_object"):
            mask_cfg.mask_region = "face"
        processor = get_censor_processor()
        file_uid = uuid.uuid4().hex[:8]
        img_ext = ext if ext.lower() in IMAGE_EXTENSIONS else ".jpg"
        out_name = f"{file_uid}_censored_{name_root}{img_ext}"
        out_path = os.path.join(OUTPUTS_DIR, out_name)

        try:
            custom_bboxes = [_to_bounding_box(b) for b in req.boxes]
            img_kwargs = dict(
                custom_boxes=custom_bboxes,
                auto_detect_all=(req.mode == "faces_all" and len(custom_bboxes) == 0),
                auto_detect_nsfw=(req.mode == "nsfw" and len(custom_bboxes) == 0),
                nsfw_sensitivity=req.nsfw_sensitivity,
            )
            if "nsfw_classes" in processor.process_image.__code__.co_varnames:
                img_kwargs["nsfw_classes"] = req.nsfw_classes
            processor.process_image(media_path, out_path, mask_cfg, **img_kwargs)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to censor image: {str(e)}")

        register_session_file(req.session_id, out_path)
        return {
            "type": "image",
            "filename": out_name,
            "display_name": f"censored_{name_root}{img_ext}",
            "download_url": f"/api/download/{url_segment(out_name)}",
            "size_bytes": os.path.getsize(out_path),
        }

    job_id = str(uuid.uuid4())[:8]
    vid_ext = ext.lower() if ext.lower() in {".mp4", ".mov", ".mkv"} else ".mp4"
    out_name = f"censored_{name_root}{vid_ext}"
    full_out_name = f"{job_id}_{out_name}"
    out_path = os.path.join(OUTPUTS_DIR, full_out_name)

    with jobs_lock:
        jobs[job_id] = {
            "job_id": job_id,
            "status": "in_progress",
            "progress": 0.0,
            "filename": full_out_name,
            "display_name": out_name,
            "items": [{
                "file_id": req.file_id,
                "filename": orig_name,
                "output_filename": out_name,
                "orig_size_bytes": media.get("size_bytes", 0),
                "output_size_bytes": 0,
                "status": "processing",
                "progress": 0.0,
                "download_url": None,
                "error": None,
            }],
            "created_at": time.time(),
            "cancelled": False,
            "session_id": req.session_id,
        }
        active_job_paths.setdefault(job_id, set()).update({os.path.abspath(media_path), os.path.abspath(out_path)})

    if req.session_id:
        with session_files_lock:
            session_active_jobs[req.session_id] = session_active_jobs.get(req.session_id, 0) + 1

    background_tasks.add_task(video_censor_worker, job_id, media, out_path, out_name, req)
    return {"type": "video", "job_id": job_id}


@router.post("/api/censor/process-batch")
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
                if item.mode in ("nsfw", "specific_object") or (item.auto_detect_nsfw and not item.auto_detect_faces):
                    item_cfg.mask_region = "face"
                img_boxes = [_to_bounding_box(b) for b in item.boxes]
                if item.auto_detect_faces:
                    pad = getattr(item_cfg, "padding_percent", 0.20)
                    img_boxes.extend(processor.detect_image_faces(media_path, padding_percent=pad))
                if item.auto_detect_nsfw:
                    detect_fn = getattr(processor, "detect_nsfw_frame", None)
                    if callable(detect_fn):
                        batch_faces = [b for b in img_boxes if getattr(b, "label", "") == "Face"]
                        if not batch_faces:
                            batch_faces = processor.detector.detect(frame, padding_percent=0.05)
                        detect_kwargs = dict(
                            sensitivity=req.nsfw_sensitivity,
                            face_boxes=batch_faces,
                            allowed_classes=req.nsfw_classes,
                        )
                        if "check_orientations" in detect_fn.__code__.co_varnames:
                            detect_kwargs["check_orientations"] = True
                        nsfw_boxes, _, _ = detect_fn(frame, **detect_kwargs)
                        img_boxes.extend(nsfw_boxes)
                    else:
                        img_boxes.extend(
                            processor.detect_image_nsfw(
                                media_path,
                                sensitivity=req.nsfw_sensitivity,
                                allowed_classes=req.nsfw_classes,
                            )
                        )

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
        raise HTTPException(status_code=500, detail=f"Failed to process batch images: {str(e)}")


def batch_video_censor_worker(job_id: str, req: CensorBatchProcessRequest):
    """Sequentially process multiple videos; isolate hardware/decode failures per video without aborting remaining items."""
    processor = get_censor_processor()
    total = len(req.items)
    completed_paths: List[tuple[str, str]] = []
    was_cancelled = False

    try:
        for idx, item in enumerate(req.items):
            with jobs_lock:
                if jobs[job_id].get("cancelled"):
                    was_cancelled = True
                    break

            media = uploaded_media.get(item.file_id)
            if not media or media.get("media_type") != "video":
                with jobs_lock:
                    jobs[job_id]["items"].append({
                        "file_id": item.file_id,
                        "filename": media.get("filename", item.file_id) if media else item.file_id,
                        "status": "failed",
                        "progress": 0.0,
                        "error": "Media missing or not a video",
                    })
                continue

            orig_name = media["filename"]
            name_root, ext = os.path.splitext(orig_name)
            out_ext = ext if ext.lower() in VIDEO_EXTENSIONS else ".mp4"
            out_name = f"censored_{name_root}{out_ext}"
            out_path = os.path.join(OUTPUTS_DIR, f"{job_id}_{idx + 1:02d}_{out_name}")
            media_path = os.path.join(UPLOADS_DIR, media["saved_filename"])

            with jobs_lock:
                active_job_paths.setdefault(job_id, set()).update({os.path.abspath(media_path), os.path.abspath(out_path)})
                item_rec = {
                    "file_id": item.file_id,
                    "filename": orig_name,
                    "output_filename": f"{idx + 1:02d}_{out_name}",
                    "orig_size_bytes": media.get("size_bytes", 0),
                    "output_size_bytes": 0,
                    "status": "processing",
                    "progress": 0.0,
                    "download_url": None,
                    "error": None,
                }
                jobs[job_id]["items"].append(item_rec)

            item_cfg = _build_censor_mask_config(item.mask_config or req.mask_config)
            mode = item.mode or (
                "nsfw"
                if item.auto_detect_nsfw
                else ("faces_all" if item.auto_detect_faces else "specific_object")
            )
            if mode in ("nsfw", "specific_object"):
                item_cfg.mask_region = "face"

            try:
                def on_prog(pct, i=idx, rec=item_rec):
                    p = round(pct / 100.0, 3)
                    with jobs_lock:
                        rec["progress"] = p
                        jobs[job_id]["progress"] = round((i + p) / total, 3)

                with heavy_task_slot():
                    kwargs = dict(
                        input_video_path=media_path,
                        output_video_path=out_path,
                        mask_config=item_cfg,
                        mode=mode,
                        custom_boxes=[_to_bounding_box(b) for b in item.boxes],
                        nsfw_sensitivity=req.nsfw_sensitivity,
                        progress_callback=on_prog,
                    )
                    if "nsfw_classes" in processor.process_video.__code__.co_varnames:
                        kwargs["nsfw_classes"] = req.nsfw_classes
                    processor.process_video(**kwargs)

                register_session_file(req.session_id, out_path)
                completed_paths.append((out_path, f"{idx + 1:02d}_{out_name}"))
                with jobs_lock:
                    item_rec.update({
                        "status": "completed",
                        "progress": 1.0,
                        "output_size_bytes": os.path.getsize(out_path) if os.path.exists(out_path) else 0,
                        "download_url": f"/api/download/{url_segment(os.path.basename(out_path))}",
                    })
            except Exception as exc:
                # Per-clip isolation: record failure on this video and move cleanly to the next clip
                with jobs_lock:
                    item_rec.update({
                        "status": "failed",
                        "progress": 0.0,
                        "error": str(exc),
                    })

            with jobs_lock:
                jobs[job_id]["progress"] = round(((idx + 1) / total) * 100.0, 1)

        zip_url = None
        zip_name = None
        if completed_paths:
            zip_name = f"censored_videos_{job_id}.zip"
            zip_path = os.path.join(OUTPUTS_DIR, zip_name)
            with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_STORED) as zf:
                for p, arc in completed_paths:
                    if os.path.isfile(p):
                        zf.write(p, arcname=arc)
            register_session_file(req.session_id, zip_path)
            zip_url = f"/api/download/{url_segment(zip_name)}"

        with jobs_lock:
            if was_cancelled or jobs[job_id].get("cancelled"):
                jobs[job_id]["status"] = "cancelled"
            elif jobs[job_id]["items"] and all(it.get("status") == "failed" for it in jobs[job_id]["items"]):
                jobs[job_id]["status"] = "failed"
            else:
                jobs[job_id]["status"] = "completed"
                jobs[job_id]["progress"] = 100.0
            jobs[job_id]["filename"] = zip_name
            jobs[job_id]["download_url"] = zip_url
            jobs[job_id]["zip_download_url"] = zip_url
    finally:
        release_session_job(req.session_id)


@router.post("/api/censor/process-video-batch")
def api_censor_process_video_batch(req: CensorBatchProcessRequest, background_tasks: BackgroundTasks):
    if not req.items:
        raise HTTPException(status_code=400, detail="No batch videos selected")

    job_id = str(uuid.uuid4())[:8]
    with jobs_lock:
        jobs[job_id] = {
            "job_id": job_id,
            "type": "video_batch",
            "status": "in_progress",
            "progress": 0.0,
            "items": [],
            "filename": None,
            "download_url": None,
            "zip_download_url": None,
            "created_at": time.time(),
            "cancelled": False,
            "session_id": req.session_id,
        }

    if req.session_id:
        with session_files_lock:
            session_active_jobs[req.session_id] = session_active_jobs.get(req.session_id, 0) + 1

    background_tasks.add_task(batch_video_censor_worker, job_id, req)
    return {"type": "video_batch", "job_id": job_id}


@router.get("/api/emojis")
def get_censor_emojis():
    """Return available privacy mask emojis from manifest.json + custom PNGs in static/assets/emojis."""
    emojis_dir = os.path.join(STATIC_DIR, "assets", "emojis")
    manifest_path = os.path.join(emojis_dir, "manifest.json")
    manifest_entries = []
    seen_ids = set()

    if os.path.isfile(manifest_path):
        try:
            with open(manifest_path, "r", encoding="utf-8") as mf:
                data = json.load(mf)
            for item in data.get("emojis", []):
                eid = item.get("id")
                if eid and os.path.isfile(os.path.join(emojis_dir, f"{eid}.png")):
                    manifest_entries.append(item)
                    seen_ids.add(eid)
        except Exception:
            pass

    if os.path.exists(emojis_dir):
        for fn in sorted(os.listdir(emojis_dir)):
            if fn.lower().endswith(".png"):
                name = os.path.splitext(fn)[0]
                if name not in seen_ids:
                    manifest_entries.append({
                        "id": name,
                        "label": name.replace("_", " ").title(),
                        "category": "custom",
                        "char": "",
                        "url": f"/assets/emojis/{url_segment(fn)}",
                    })

    if not manifest_entries:
        for fallback in ("sunglasses", "smiley", "clown", "poop", "censored"):
            manifest_entries.append({
                "id": fallback,
                "label": fallback.title(),
                "category": "faces",
                "char": "",
                "url": f"/assets/emojis/{fallback}.png",
            })

    return {"emojis": manifest_entries}
