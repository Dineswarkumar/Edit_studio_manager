"""
Frame Studio FastAPI entry point.
Modularized routes live in routers/, shared state & LAN security live in core/state.py.
"""
from __future__ import annotations

import os
import socket
import threading
import webbrowser
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from core.state import (
    LAN_AUTH_COOKIE,
    STATIC_DIR,
    enable_lan_pin,
    is_lan_token_valid,
    is_loopback_client,
    janitor_loop,
    jobs,
    lan_auth_state,
    resolve_safe_path,
    uploaded_media,
)
from routers import audio, censor, color, media, thumbnail, watermark


@asynccontextmanager
async def lifespan(app: FastAPI):
    threading.Thread(target=janitor_loop, daemon=True).start()
    yield


app = FastAPI(title="Frame Studio Pro API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(https?://(localhost|127\.0\.0\.1)(:\d+)?|https://localhost|http://192\.168\.\d+\.\d+(:\d+)?|http://10\.\d+\.\d+\.\d+(:\d+)?|app://localhost)$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def lan_pin_guard(request: Request, call_next):
    """Enforce 6-digit PIN auth on remote LAN API calls when --lan is enabled."""
    if lan_auth_state["enabled"]:
        path = request.url.path or ""
        if path.startswith("/api/") and not path.startswith("/api/auth/"):
            client_host = request.client.host if request.client else ""
            if not is_loopback_client(client_host):
                token = request.headers.get("x-lan-token") or request.cookies.get(LAN_AUTH_COOKIE)
                auth_header = request.headers.get("authorization") or ""
                if not token and auth_header.lower().startswith("bearer "):
                    token = auth_header[7:].strip()
                if not is_lan_token_valid(token):
                    return JSONResponse(
                        status_code=401,
                        content={"detail": "LAN pairing PIN required. Authenticate via POST /api/auth/lan-verify."},
                    )
    return await call_next(request)


# Include API routers BEFORE mounting StaticFiles at "/"
app.include_router(media.router)
app.include_router(watermark.router)
app.include_router(thumbnail.router)
app.include_router(censor.router)
app.include_router(color.router)
app.include_router(audio.router)

# Static frontend at root
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


def _get_local_lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="Frame Studio Pro Server")
    parser.add_argument("--port", type=int, default=8000, help="Port to listen on (default: 8000)")
    parser.add_argument("--lan", action="store_true", help="Bind to 0.0.0.0 for mobile/LAN access (PIN protected)")
    parser.add_argument("--pin", type=str, default=None, help="Optional custom pairing PIN when using --lan")
    parser.add_argument("--open", action="store_true", help="Open browser automatically on startup")
    args = parser.parse_args()

    host = "0.0.0.0" if args.lan else "127.0.0.1"
    if args.lan:
        pin = enable_lan_pin(args.pin)
        lan_ip = _get_local_lan_ip()
        print("\n" + "=" * 54)
        print("  Frame Studio Pro (LAN Mode - PIN Protected)")
        print(f"  Local URL : http://127.0.0.1:{args.port}")
        print(f"  LAN URL   : http://{lan_ip}:{args.port}")
        print(f"  LAN PIN   : {pin}")
        print("=" * 54 + "\n")
    else:
        print(f"\n  Frame Studio Pro running on http://127.0.0.1:{args.port}\n")

    if args.open:
        threading.Timer(1.2, lambda: webbrowser.open(f"http://127.0.0.1:{args.port}")).start()

    uvicorn.run(app, host=host, port=args.port, log_level="warning")
