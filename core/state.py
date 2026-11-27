"""
Core shared state, safe path resolution, session/janitor tracking,
concurrency semaphore for heavy FFmpeg/ONNX jobs, and --lan PIN security.
"""
from __future__ import annotations

import hmac
import os
import secrets
import threading
import time
import urllib.parse
from contextlib import contextmanager
from typing import Dict, Optional, Set

from fastapi import HTTPException

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPLOADS_DIR = os.path.join(BASE_DIR, "uploads")
OUTPUTS_DIR = os.path.join(BASE_DIR, "outputs")
THUMBS_DIR = os.path.join(BASE_DIR, "thumbs")
STATIC_DIR = os.path.join(BASE_DIR, "static")
ANDROID_OUTPUT_DIR = os.path.join(BASE_DIR, "android", "app", "build", "outputs", "apk", "release")

for directory in (UPLOADS_DIR, OUTPUTS_DIR, THUMBS_DIR, STATIC_DIR):
    os.makedirs(directory, exist_ok=True)

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".gif"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"}
AUDIO_EXTENSIONS = {".mp3", ".wav", ".aac", ".m4a", ".flac", ".ogg", ".opus"}
OFFICE_PACKAGE_EXTENSIONS = {".docx", ".pptx", ".xlsx", ".odt", ".odp", ".ods", ".epub"}
ALLOWED_LOGO_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}
ACTIVE_JOB_STATUSES = {"in_progress", "processing"}

# Shared state registries
uploaded_media: Dict[str, dict] = {}
jobs: Dict[str, dict] = {}
jobs_lock = threading.Lock()
active_job_paths: Dict[str, Set[str]] = {}

session_files: Dict[str, Set[str]] = {}
session_active_jobs: Dict[str, int] = {}
pending_session_cleanup: Set[str] = set()
session_files_lock = threading.Lock()

# Concurrency cap for heavy FFmpeg / ONNX pipelines so 16GB RAM doesn't OOM
HEAVY_TASK_SEMAPHORE = threading.Semaphore(2)


@contextmanager
def heavy_task_slot():
    """Acquire a heavy-processing slot before running FFmpeg or batch ONNX video work."""
    HEAVY_TASK_SEMAPHORE.acquire()
    try:
        yield
    finally:
        HEAVY_TASK_SEMAPHORE.release()


# LAN PIN pairing state (only enforced when server is started with --lan)
LAN_AUTH_COOKIE = "fs_lan_token"
_lan_lock = threading.Lock()
lan_auth_state: dict = {
    "enabled": False,
    "pin": None,
    "tokens": set(),
    "failed_attempts": 0,
    "locked_until": 0.0,
}


def enable_lan_pin(pin: Optional[str] = None) -> str:
    """Enable LAN pairing PIN authentication and return the active 6-digit PIN."""
    generated = pin or f"{secrets.randbelow(1_000_000):06d}"
    with _lan_lock:
        lan_auth_state["enabled"] = True
        lan_auth_state["pin"] = generated
        lan_auth_state["tokens"] = set()
        lan_auth_state["failed_attempts"] = 0
        lan_auth_state["locked_until"] = 0.0
    return generated


def disable_lan_pin() -> None:
    """Disable LAN PIN enforcement (used for localhost-only mode or tests)."""
    with _lan_lock:
        lan_auth_state["enabled"] = False
        lan_auth_state["pin"] = None
        lan_auth_state["tokens"] = set()


def verify_lan_pin(pin_attempt: str) -> Optional[str]:
    """Validate PIN in constant time with basic brute-force backoff; return session token or None."""
    now = time.time()
    with _lan_lock:
        if not lan_auth_state["enabled"] or not lan_auth_state["pin"]:
            return None
        if now < lan_auth_state["locked_until"]:
            raise HTTPException(status_code=429, detail="Too many incorrect PIN attempts. Wait 30 seconds.")
        expected = lan_auth_state["pin"]
        provided = (pin_attempt or "").strip()
        if hmac.compare_digest(provided, expected):
            token = secrets.token_urlsafe(32)
            lan_auth_state["tokens"].add(token)
            lan_auth_state["failed_attempts"] = 0
            return token
        lan_auth_state["failed_attempts"] += 1
        if lan_auth_state["failed_attempts"] >= 5:
            lan_auth_state["locked_until"] = now + 30.0
            lan_auth_state["failed_attempts"] = 0
        return None


def is_lan_token_valid(token: Optional[str]) -> bool:
    if not token:
        return False
    with _lan_lock:
        if not lan_auth_state["enabled"]:
            return True
        return token in lan_auth_state["tokens"]


def is_loopback_client(client_host: Optional[str]) -> bool:
    return (client_host or "") in {"127.0.0.1", "::1", "localhost", "testclient", ""}


def url_segment(value: str) -> str:
    """Percent-encode a path segment for API URLs."""
    return urllib.parse.quote(value, safe="")


def dedupe_output_name(used_names: Set[str], out_name: str) -> str:
    """Ensure every item in a batch gets a unique output filename (avoids overwrites & duplicate ZIP entries)."""
    key = out_name.lower()
    if key not in used_names:
        used_names.add(key)
        return out_name
    root, ext = os.path.splitext(out_name)
    counter = 2
    while True:
        candidate = f"{root}_{counter}{ext}"
        ckey = candidate.lower()
        if ckey not in used_names:
            used_names.add(ckey)
            return candidate
        counter += 1


def resolve_safe_path(base_dir: str, filename: str, must_exist: bool = False) -> str:
    """Resolve user-supplied filename strictly inside base_dir without traversal or symlink escape."""
    cleaned = urllib.parse.unquote(filename or "").strip()
    if not cleaned or cleaned in (".", "..") or "/" in cleaned or "\\" in cleaned or "\x00" in cleaned:
        raise HTTPException(status_code=400, detail="Invalid filename")

    base_real = os.path.realpath(base_dir)
    candidate_real = os.path.realpath(os.path.join(base_real, cleaned))
    if os.path.commonpath([base_real, candidate_real]) != base_real:
        raise HTTPException(status_code=403, detail="Access denied")
    if must_exist and not os.path.isfile(candidate_real):
        raise HTTPException(status_code=404, detail="File not found")
    return candidate_real


def register_session_file(session_id: Optional[str], filepath: str) -> None:
    if not session_id or not filepath:
        return
    with session_files_lock:
        if session_id not in session_files:
            session_files[session_id] = set()
        session_files[session_id].add(os.path.abspath(filepath))


def remove_session_files(session_id: str) -> int:
    with session_files_lock:
        paths = list(session_files.pop(session_id, set()))
        pending_session_cleanup.discard(session_id)

    cleaned = 0
    for fpath in paths:
        try:
            if os.path.exists(fpath):
                os.remove(fpath)
                cleaned += 1
        except Exception:
            pass

    for fid in [k for k, v in list(uploaded_media.items()) if v.get("session_id") == session_id]:
        uploaded_media.pop(fid, None)

    return cleaned


def release_session_job(session_id: Optional[str]) -> None:
    if not session_id:
        return
    should_cleanup = False
    with session_files_lock:
        active = max(0, session_active_jobs.get(session_id, 0) - 1)
        if active == 0:
            session_active_jobs.pop(session_id, None)
            should_cleanup = session_id in pending_session_cleanup
        else:
            session_active_jobs[session_id] = active

    if should_cleanup:
        remove_session_files(session_id)


def janitor_loop() -> None:
    """Purge temp uploads, thumbs, and outputs older than 1 hour unless referenced by an active job."""
    while True:
        time.sleep(300)
        now = time.time()
        max_age = 3600

        with jobs_lock:
            protected_paths: Set[str] = set()
            for jid, job in jobs.items():
                if job.get("status") in ACTIVE_JOB_STATUSES:
                    protected_paths.update(active_job_paths.get(jid, set()))

        for directory in (UPLOADS_DIR, OUTPUTS_DIR, THUMBS_DIR):
            if not os.path.exists(directory):
                continue
            for fn in os.listdir(directory):
                fp = os.path.abspath(os.path.join(directory, fn))
                if fp in protected_paths:
                    continue
                if os.path.isfile(fp) and (now - os.path.getmtime(fp)) > max_age:
                    try:
                        os.remove(fp)
                    except Exception:
                        pass

        with jobs_lock:
            expired_jobs = [
                jid for jid, job in jobs.items()
                if job.get("status") not in ACTIVE_JOB_STATUSES and (now - job.get("created_at", now)) > max_age
            ]
            for jid in expired_jobs:
                jobs.pop(jid, None)
                active_job_paths.pop(jid, None)
