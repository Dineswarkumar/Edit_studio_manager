"""Regression, edge-case, and memory/performance tests for Frame Studio fixes."""
from __future__ import annotations

import io
import os
import time
import tracemalloc
import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from core.state import (
    ACTIVE_JOB_STATUSES,
    IMAGE_EXTENSIONS,
    OUTPUTS_DIR,
    THUMBS_DIR,
    dedupe_output_name,
    jobs,
    jobs_lock,
)
from engine.color_processor import ColorGradeConfig, apply_point_adjustments_rgb, apply_trilinear_lut
from engine.font_manager import get_font
from engine.models import ExportSettings, WatermarkConfig
from engine.video_processor import apply_watermark_to_video, get_video_info
from server import app

client = TestClient(app)


def _make_png_bytes(w: int = 120, h: int = 90, color=(40, 120, 220)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color=color).save(buf, "PNG")
    return buf.getvalue()


def test_cancel_job_supports_processing_and_in_progress():
    for status in ("in_progress", "processing"):
        jid = f"test_cancel_{status}"
        with jobs_lock:
            jobs[jid] = {"job_id": jid, "status": status, "cancelled": False, "created_at": time.time()}
        try:
            res = client.post(f"/api/job/{jid}/cancel")
            assert res.status_code == 200
            assert res.json()["status"] == "cancelling"
            assert jobs[jid]["cancelled"] is True
        finally:
            with jobs_lock:
                jobs.pop(jid, None)
    assert "processing" in ACTIVE_JOB_STATUSES
    assert "in_progress" in ACTIVE_JOB_STATUSES


def test_dedupe_output_name_case_insensitive():
    used = set()
    assert dedupe_output_name(used, "watermarked_Photo.jpg") == "watermarked_Photo.jpg"
    assert dedupe_output_name(used, "watermarked_photo.jpg") == "watermarked_photo_2.jpg"
    assert dedupe_output_name(used, "watermarked_Photo.jpg") == "watermarked_Photo_3.jpg"


def test_watermark_same_basename_no_overwrite():
    png1 = _make_png_bytes(100, 80, (255, 0, 0))
    png2 = _make_png_bytes(100, 80, (0, 255, 0))
    r1 = client.post("/api/upload-media", files=[("files", ("dup.png", png1, "image/png"))])
    r2 = client.post("/api/upload-media", files=[("files", ("dup.png", png2, "image/png"))])
    assert r1.status_code == 200 and r2.status_code == 200
    id1 = r1.json()["media"][0]["id"]
    id2 = r2.json()["media"][0]["id"]

    proc = client.post(
        "/api/process",
        json={"file_ids": [id1, id2], "config": {"layers": [], "export_settings": {"mode": "compress_only"}}},
    )
    assert proc.status_code == 200
    jid = proc.json()["job_id"]

    for _ in range(40):
        st = client.get(f"/api/job/{jid}").json()
        if st["status"] in ("completed", "failed"):
            break
        time.sleep(0.1)

    assert st["status"] == "completed"
    out_names = [it["output_filename"] for it in st["items"]]
    assert len(out_names) == 2
    assert len(set(out_names)) == 2
    for name in out_names:
        assert os.path.isfile(os.path.join(OUTPUTS_DIR, f"{jid}_{name}"))

    # Cleanup
    client.delete(f"/api/media/{id1}")
    client.delete(f"/api/media/{id2}")


def test_watermark_missing_files_marks_job_failed():
    proc = client.post(
        "/api/process",
        json={"file_ids": ["nonexistent_id_xyz"], "config": {"layers": []}},
    )
    assert proc.status_code == 200
    jid = proc.json()["job_id"]
    for _ in range(30):
        st = client.get(f"/api/job/{jid}").json()
        if st["status"] in ("completed", "failed"):
            break
        time.sleep(0.05)
    assert st["status"] == "failed"


def test_thumbnail_export_missing_base_returns_404():
    res = client.post(
        "/api/thumbnail/export",
        json={"base_image_filenames": ["definitely_missing_12345.jpg"]},
    )
    assert res.status_code == 404


def test_thumbnail_preview_rolling_path_no_disk_bloat():
    png = _make_png_bytes(160, 90, (80, 140, 200))
    up = client.post("/api/upload-media", files=[("files", ("thumb_roll.png", png, "image/png"))])
    assert up.status_code == 200
    item = up.json()["media"][0]
    base_fn = item["preview_base_filename"]

    p1 = client.post("/api/thumbnail/preview", json={"base_image_filename": base_fn, "resolution_scale": 1})
    p2 = client.post("/api/thumbnail/preview", json={"base_image_filename": base_fn, "resolution_scale": 1})
    assert p1.status_code == 200 and p2.status_code == 200
    path1 = p1.json()["preview_url"].split("?")[0]
    path2 = p2.json()["preview_url"].split("?")[0]
    assert path1 == path2

    client.delete(f"/api/media/{item['id']}")


def test_tif_extension_and_corrupt_upload_rejection():
    assert ".tif" in IMAGE_EXTENSIONS
    bad = client.post("/api/upload-media", files=[("files", ("broken.jpg", b"not-a-valid-jpeg", "image/jpeg"))])
    assert bad.status_code == 400


def test_chunked_trilinear_lut_parity_and_bounded_memory():
    size = 9
    grid = np.linspace(0.0, 1.0, size, dtype=np.float32)
    # Build an exact linear 3D LUT (no clipping kink between knots) so trilinear is exact to float32 precision
    bb, gg, rr = np.meshgrid(grid, grid, grid, indexing="ij")
    table = np.stack([rr * 0.95 + 0.02, gg * 0.90 + 0.05, bb * 0.85 + 0.03], axis=-1).astype(np.float32)
    d_min = np.array([0.0, 0.0, 0.0], dtype=np.float32)
    d_max = np.array([1.0, 1.0, 1.0], dtype=np.float32)

    rng = np.random.default_rng(42)
    img = rng.random((512, 640, 3), dtype=np.float32)  # > 262,144 pixels to exercise multi-chunk path
    got = apply_trilinear_lut(img, size, table, d_min, d_max)

    expected = np.stack(
        [img[..., 0] * 0.95 + 0.02, img[..., 1] * 0.90 + 0.05, img[..., 2] * 0.85 + 0.03],
        axis=-1,
    )
    assert got.shape == img.shape
    assert np.allclose(got, expected, atol=1e-5)

    # Memory bound check on 2M pixels (~24 MB float32 input -> peak overhead well below 180 MB)
    big = rng.random((1024, 2048, 3), dtype=np.float32)
    tracemalloc.start()
    _ = apply_trilinear_lut(big, size, table, d_min, d_max)
    _curr, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert peak < 180 * 1024 * 1024, f"Peak memory too high: {peak / (1024*1024):.1f} MB"


def test_font_manager_lru_cache():
    get_font.cache_clear()
    f1 = get_font("Arial", 32, False)
    f2 = get_font("Arial", 32, False)
    assert f1 is f2
    assert get_font.cache_info().hits >= 1


def test_portrait_video_resolution_scaling(tmp_path):
    # Generate a tiny portrait video (540x960) and compress with 480p preset -> should cap long edge to 854 (480x854)
    import subprocess

    in_vid = str(tmp_path / "portrait.mp4")
    out_vid = str(tmp_path / "portrait_480p.mp4")
    subprocess.run(
        [
            "ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=blue:s=540x960:d=0.4",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", in_vid,
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    cfg = WatermarkConfig(
        layers=[],
        export_settings=ExportSettings(mode="compress_only", video_preset="balanced", video_resolution="480p"),
    )
    apply_watermark_to_video(in_vid, out_vid, cfg, str(tmp_path))
    info = get_video_info(out_vid)
    assert info["height"] <= 854
    assert info["width"] <= 480


def test_converter_worker_honors_cancellation_and_cleans_active_paths():
    from core.state import active_job_paths, uploaded_media
    from routers.converter import ConverterJobRequest, ConversionChoice, _converter_worker, _tools

    img1 = _make_png_bytes(color=(20, 40, 60))
    up = client.post("/api/converter/upload", files=[("files", ("a.png", img1, "image/png"))])
    assert up.status_code == 200
    fid = up.json()["media"][0]["id"]

    job_id = "converter_cancel_test"
    with jobs_lock:
        jobs[job_id] = {
            "id": job_id,
            "type": "converter",
            "status": "processing",
            "progress": 0.0,
            "items": [],
            "zip_filename": None,
            "cancelled": True,
            "created_at": 0.0,
            "session_id": None,
        }
    req = ConverterJobRequest(conversions=[ConversionChoice(file_id=fid, target="webp")])
    try:
        _converter_worker(job_id, req, _tools())
        with jobs_lock:
            assert jobs[job_id]["status"] == "cancelled"
            assert jobs[job_id]["items"] == []
            assert jobs[job_id]["zip_filename"] is None
    finally:
        with jobs_lock:
            jobs.pop(job_id, None)
        uploaded_media.pop(fid, None)


def test_converter_same_basename_and_jpeg_tif_targets():
    from routers.converter import _targets_for, _tools

    tools = _tools()
    assert "jpg" not in _targets_for(".jpeg", tools)
    assert "tiff" not in _targets_for(".tif", tools)

    p1 = _make_png_bytes(color=(100, 10, 10))
    p2 = _make_png_bytes(color=(10, 100, 10))
    up = client.post(
        "/api/converter/upload",
        files=[
            ("files", ("dup.png", p1, "image/png")),
            ("files", ("dup.png", p2, "image/png")),
        ],
    )
    assert up.status_code == 200
    media = up.json()["media"]
    assert len(media) == 2

    res = client.post(
        "/api/converter/jobs",
        json={"conversions": [{"file_id": m["id"], "target": "webp"} for m in media]},
    )
    assert res.status_code == 200
    job_id = res.json()["job_id"]
    status = client.get(f"/api/converter/jobs/{job_id}").json()
    assert status["status"] == "completed"
    labels = [it["display_filename"] for it in status["items"]]
    assert len(labels) == 2
    assert len(set(l.lower() for l in labels)) == 2


def test_favicon_route_returns_svg():
    res = client.get("/favicon.ico")
    assert res.status_code == 200
    assert "image/svg+xml" in res.headers.get("content-type", "")
    assert "<svg" in res.text
