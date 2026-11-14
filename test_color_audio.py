import math
import os
import subprocess
import tempfile
import time
import wave

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from engine.audio_processor import AudioBoostConfig, analyze_audio_stats, process_audio_file
from engine.color_processor import (
    BUNDLED_LUTS_DIR,
    LUT_CATALOG,
    ColorGradeConfig,
    apply_color_grade_to_image,
    apply_color_grade_to_video,
    load_cube_lut,
)
from server import app


def _write_sine_wav(path: str, *, duration_sec: float = 1.6, amplitude: float = 0.04, freq: float = 440.0, sample_rate: int = 44100) -> None:
    t = np.linspace(0.0, duration_sec, int(sample_rate * duration_sec), endpoint=False)
    samples = (amplitude * np.sin(2.0 * math.pi * freq * t)).astype(np.float32)
    pcm = np.clip(np.round(samples * 32767.0), -32768, 32767).astype("<i2")
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm.tobytes())


def test_bundled_luts_valid_and_image_grade():
    for entry in LUT_CATALOG:
        lut_path = os.path.join(BUNDLED_LUTS_DIR, entry["filename"])
        assert os.path.isfile(lut_path), f"Missing LUT: {lut_path}"
        size, table, d_min, d_max = load_cube_lut(lut_path)
        assert size == 17
        assert table.shape == (17, 17, 17, 3)
        assert np.all(np.isfinite(table))

    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "img.png")
        out = os.path.join(tmp, "graded.jpg")
        grad = np.tile(np.linspace(20, 235, 160, dtype=np.uint8), (120, 1))
        rgb = np.stack([grad, grad, grad], axis=-1)
        Image.fromarray(rgb, mode="RGB").save(src)

        cfg = ColorGradeConfig(lut_id="teal_orange", lut_strength=1.0, exposure=0.25, contrast=1.15, vignette=0.4, grain=0.2)
        apply_color_grade_to_image(src, out, cfg, [])
        assert os.path.isfile(out)
        with Image.open(out) as graded_img:
            arr = np.asarray(graded_img.convert("RGB"))
            assert arr.shape == (120, 160, 3)
            # Teal shadows / orange highlights should introduce chroma differences between R and B
            assert float(np.abs(arr[..., 0].astype(float) - arr[..., 2].astype(float)).mean()) > 3.0


def test_video_color_grade_ffmpeg():
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "in.mp4")
        out = os.path.join(tmp, "out.mp4")
        subprocess.run(
            [
                "ffmpeg", "-y", "-v", "error",
                "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=1",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", src,
            ],
            check=True,
        )
        cfg = ColorGradeConfig(lut_id="kodak_2383", lut_strength=0.9, saturation=1.2, vignette=0.35)
        out_path, used_enc = apply_color_grade_to_video(src, out, cfg, [])
        assert os.path.isfile(out_path)
        assert os.path.getsize(out_path) > 1000
        assert used_enc in ("h264_qsv", "libx264")


def test_audio_analyze_and_loudnorm_boost():
    with tempfile.TemporaryDirectory() as tmp:
        quiet_wav = os.path.join(tmp, "quiet.wav")
        boosted_wav = os.path.join(tmp, "boosted.wav")
        _write_sine_wav(quiet_wav, duration_sec=2.0, amplitude=0.04)

        in_stats = analyze_audio_stats(quiet_wav)
        assert in_stats["has_audio"] is True
        assert in_stats["integrated_lufs"] is not None
        assert in_stats["integrated_lufs"] < -24.0

        cfg = AudioBoostConfig(
            gain_db=3.0,
            normalize_target_lufs=-14.0,
            highpass_hz=80,
            voice_clarity=True,
            limiter_enabled=True,
            output_format="wav",
        )
        res = process_audio_file(quiet_wav, boosted_wav, cfg)
        out_stats = res["output_stats"]
        assert os.path.isfile(boosted_wav)
        assert out_stats["integrated_lufs"] is not None
        assert abs(out_stats["integrated_lufs"] - (-14.0)) <= 2.0
        assert out_stats["true_peak_db"] is None or out_stats["true_peak_db"] <= -0.5


def test_color_and_audio_api_endpoints():
    client = TestClient(app)
    r_luts = client.get("/api/color/luts")
    assert r_luts.status_code == 200
    assert len(r_luts.json()["luts"]) == 6

    with tempfile.TemporaryDirectory() as tmp:
        img_path = os.path.join(tmp, "photo.jpg")
        Image.new("RGB", (200, 150), (100, 120, 140)).save(img_path)

        with open(img_path, "rb") as f:
            up = client.post("/api/upload-media", files={"files": ("photo.jpg", f, "image/jpeg")})
        assert up.status_code == 200
        fid = up.json()["media"][0]["id"]

        prev = client.post("/api/color/preview", json={"file_id": fid, "config": {"lut_id": "warm_sunset", "exposure": 0.2}})
        assert prev.status_code == 200
        assert "before_url" in prev.json() and "after_url" in prev.json()

        proc = client.post("/api/color/process", json={"file_ids": [fid], "config": {"lut_id": "crisp_daylight"}})
        assert proc.status_code == 200
        job_id = proc.json()["job_id"]
        for _ in range(30):
            st = client.get(f"/api/job/{job_id}").json()
            if st["status"] in ("completed", "failed"):
                break
            time.sleep(0.1)
        assert st["status"] == "completed"
        assert st["items"][0]["status"] == "completed"

        wav_path = os.path.join(tmp, "clip.wav")
        _write_sine_wav(wav_path, duration_sec=1.5, amplitude=0.05)
        with open(wav_path, "rb") as f:
            up_a = client.post("/api/upload-media", files={"files": ("clip.wav", f, "audio/wav")})
        assert up_a.status_code == 200
        afid = up_a.json()["media"][0]["id"]

        an = client.post("/api/audio/analyze", json={"file_id": afid})
        assert an.status_code == 200
        assert an.json()["stats"]["has_audio"] is True

        aproc = client.post("/api/audio/process", json={"file_ids": [afid], "config": {"normalize_target_lufs": -14.0, "output_format": "mp3"}})
        assert aproc.status_code == 200
        ajob_id = aproc.json()["job_id"]
        for _ in range(40):
            ast = client.get(f"/api/job/{ajob_id}").json()
            if ast["status"] in ("completed", "failed"):
                break
            time.sleep(0.1)
        assert ast["status"] == "completed"
        assert ast["items"][0]["output_filename"].endswith(".mp3")
