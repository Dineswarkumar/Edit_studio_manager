"""Local file conversion routes for common media, documents, and archives."""
from __future__ import annotations

import mimetypes
import os
import re
import shutil
import stat
import subprocess
import tempfile
import time
import uuid
import zipfile
import base64
import binascii
import textwrap
from io import BytesIO
from functools import lru_cache
from pathlib import PurePosixPath
from typing import Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from PIL import Image, ImageOps
from pydantic import BaseModel, Field

from core.state import (
    AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, OUTPUTS_DIR, UPLOADS_DIR, VIDEO_EXTENSIONS,
    active_job_paths, heavy_task_slot, jobs, jobs_lock, register_session_file,
    release_session_job, resolve_safe_path, session_active_jobs, session_files_lock,
    uploaded_media, url_segment,
)

router = APIRouter()

OFFICE_EXTENSIONS = {".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".odt", ".odp", ".ods"}
ARCHIVE_EXTENSIONS = {".zip", ".7z", ".rar"}
IMAGE_TARGETS = {"jpg", "png", "webp", "bmp", "tiff", "gif", "pdf"}
VIDEO_TARGETS = {"mp4", "mov", "mkv", "webm", "avi"}
AUDIO_TARGETS = {"mp3", "wav", "aac", "m4a", "flac", "ogg"}
CODE_EXTENSIONS = {
    ".c", ".h", ".cc", ".hh", ".cpp", ".hpp", ".cxx", ".hxx", ".cs", ".java",
    ".py", ".pyw", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".go", ".rs",
    ".php", ".rb", ".swift", ".kt", ".kts", ".dart", ".scala", ".r", ".rmd",
    ".sql", ".sh", ".bash", ".zsh", ".ps1", ".psm1", ".bat", ".cmd", ".html",
    ".htm", ".css", ".scss", ".sass", ".less", ".json", ".jsonc", ".json5",
    ".xml", ".xsl", ".xslt", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
    ".md", ".markdown", ".tex", ".lua", ".pl", ".pm", ".m", ".mm", ".ex", ".exs",
    ".erl", ".hrl", ".clj", ".cljs", ".cljc", ".elm", ".hs", ".lhs", ".jl",
    ".nim", ".nix", ".vue", ".svelte", ".graphql", ".gql", ".proto", ".makefile",
    ".dockerfile", ".tf", ".hcl", ".cmake", ".gradle", ".groovy", ".plsql", ".psql", ".env",
}
CODE_FILENAMES = {"makefile", "dockerfile", "justfile", "gemfile", "rakefile"}
NOTEBOOK_EXTENSION = ".ipynb"
MAX_ARCHIVE_ENTRIES = 5000
MAX_ARCHIVE_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024
MAX_SOURCE_BYTES = 5 * 1024 * 1024
MAX_NOTEBOOK_OUTPUT_CHARS = 500_000


class ConversionChoice(BaseModel):
    file_id: str
    target: str


class ConverterJobRequest(BaseModel):
    conversions: List[ConversionChoice] = Field(default_factory=list)
    combine_image_ids: List[str] = Field(default_factory=list)
    zip_file_ids: List[str] = Field(default_factory=list)
    session_id: Optional[str] = None


def _tool(*names: str) -> Optional[str]:
    for name in names:
        path = shutil.which(name)
        if path:
            return path
    return None


@lru_cache(maxsize=1)
def _tools() -> Dict[str, object]:
    tools: Dict[str, object] = {
        "ffmpeg": _tool("ffmpeg"),
        "soffice": _tool("soffice", "libreoffice"),
        "seven_zip": _tool("7z", "7za", "7zz"),
        "unrar": _tool("unrar", "rar"),
        "encoders": set(),
    }
    if tools["ffmpeg"]:
        try:
            result = subprocess.run([tools["ffmpeg"], "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=20)
            for line in (result.stdout + "\n" + result.stderr).splitlines():
                parts = line.split()
                if len(parts) >= 2 and len(parts[0]) == 6 and parts[0][0] in "AVS":
                    tools["encoders"].add(parts[1])
        except Exception:
            pass
    return tools


def _category(ext: str, filename: Optional[str] = None) -> Optional[str]:
    if ext in CODE_EXTENSIONS or (filename and os.path.basename(filename).lower() in CODE_FILENAMES):
        return "code"
    if ext == NOTEBOOK_EXTENSION:
        return "notebook"
    if ext in IMAGE_EXTENSIONS:
        return "image"
    if ext in VIDEO_EXTENSIONS:
        return "video"
    if ext in AUDIO_EXTENSIONS:
        return "audio"
    if ext == ".pdf":
        return "pdf"
    if ext in OFFICE_EXTENSIONS:
        return "office"
    if ext in ARCHIVE_EXTENSIONS:
        return "archive"
    return None


def _targets_for(ext: str, tools: Dict[str, object], filename: Optional[str] = None) -> List[str]:
    category = _category(ext, filename)
    norm_ext = {"jpeg": "jpg", "tif": "tiff"}.get(ext.lstrip("."), ext.lstrip("."))
    if category in {"code", "notebook"}:
        return ["pdf", "docx"]
    if category == "image":
        return sorted(IMAGE_TARGETS - {norm_ext})
    encoders = tools.get("encoders", set())
    if category == "video" and tools["ffmpeg"]:
        targets = set(VIDEO_TARGETS)
        if not {"libx264", "aac"}.issubset(encoders):
            targets -= {"mp4", "mov", "mkv", "avi"}
        if not {"libvpx-vp9", "libopus"}.issubset(encoders):
            targets.discard("webm")
        return sorted(targets - {norm_ext})
    if category == "audio" and tools["ffmpeg"]:
        needed = {"mp3": "libmp3lame", "wav": "pcm_s16le", "aac": "aac", "m4a": "aac", "flac": "flac", "ogg": "libvorbis"}
        return sorted(target for target in AUDIO_TARGETS if needed[target] in encoders and target != norm_ext)
    if category == "pdf":
        return ["png", "jpg"]
    if category == "office" and tools["soffice"]:
        return ["pdf"]
    if category == "archive" and (
        ext == ".zip" or (ext == ".7z" and tools["seven_zip"]) or
        (ext == ".rar" and (tools["seven_zip"] or tools["unrar"]))
    ):
        return ["zip"]
    return []


@router.get("/api/converter/capabilities")
def converter_capabilities():
    tools = _tools()
    encoder_set = tools.get("encoders", set())
    media_note = None
    if not tools["ffmpeg"]:
        media_note = "Install FFmpeg to convert video and audio files."
    elif not {"libx264", "aac", "libvpx-vp9", "libopus", "libmp3lame", "libvorbis"}.issubset(encoder_set):
        media_note = "Some video or audio outputs need codecs that are missing from this FFmpeg install; unavailable outputs are hidden."
    archive_note = None
    if not tools["seven_zip"]:
        archive_note = "7z extraction needs 7-Zip. ZIP works without extra tools; RAR also works if UnRAR is installed."
    elif not tools["unrar"]:
        archive_note = "RAR support depends on 7-Zip being able to read the archive; install UnRAR if a RAR file cannot be opened."
    return {
        "tools": {name: bool(tools[name]) for name in ("ffmpeg", "soffice", "seven_zip", "unrar")},
        "formats": {
            "images": sorted({ext.lstrip(".") for ext in IMAGE_EXTENSIONS}),
            "videos": sorted({ext.lstrip(".") for ext in VIDEO_EXTENSIONS}),
            "audio": sorted({ext.lstrip(".") for ext in AUDIO_EXTENSIONS}),
            "documents": sorted({ext.lstrip(".") for ext in OFFICE_EXTENSIONS | {".pdf"}}),
            "archives": sorted(ARCHIVE_EXTENSIONS),
            "code": sorted(CODE_EXTENSIONS | {NOTEBOOK_EXTENSION}),
        },
        "notes": {
            "office": None if tools["soffice"] else "Install LibreOffice to convert Word, PowerPoint, or Excel files to PDF.",
            "archives": archive_note,
            "media": media_note,
        },
    }


@router.post("/api/converter/upload")
def upload_converter_files(files: List[UploadFile] = File(...), session_id: Optional[str] = Form(None)):
    tools = _tools()
    accepted, rejected = [], []
    for file in files:
        filename = os.path.basename((file.filename or "unknown").replace("\\", "/")) or "unknown"
        ext = os.path.splitext(filename)[1].lower()
        category = _category(ext, filename)
        if not category:
            rejected.append({"filename": filename, "error": "This file format is not supported."})
            continue

        file_id = uuid.uuid4().hex[:10]
        saved_name = f"converter_{file_id}{ext}"
        saved_path = os.path.join(UPLOADS_DIR, saved_name)
        try:
            with open(saved_path, "wb") as dest:
                shutil.copyfileobj(file.file, dest)
            size = os.path.getsize(saved_path)
            if size <= 0:
                raise ValueError("The file is empty.")
            if category == "image":
                with Image.open(saved_path) as image:
                    image.verify()
            elif category == "pdf":
                import pymupdf
                with pymupdf.open(saved_path) as document:
                    if document.page_count < 1:
                        raise ValueError("The PDF has no pages.")
            elif category == "archive" and ext == ".zip":
                with zipfile.ZipFile(saved_path) as archive:
                    if archive.testzip() is not None:
                        raise ValueError("The ZIP archive is damaged.")
            elif category == "code":
                if size > MAX_SOURCE_BYTES:
                    raise ValueError("Source files must be 5 MB or smaller.")
                _read_source(saved_path)
            elif category == "notebook":
                if size > MAX_SOURCE_BYTES:
                    raise ValueError("Notebook files must be 5 MB or smaller.")
                _read_notebook(saved_path)
            register_session_file(session_id, saved_path)
            item = {
                "id": file_id,
                "filename": filename,
                "saved_filename": saved_name,
            "media_type": category,
                "format_name": ext.lstrip(".").upper(),
                "size_bytes": size,
                "targets": _targets_for(ext, tools, filename),
                "session_id": session_id,
            }
            uploaded_media[file_id] = item
            accepted.append(item)
        except Exception as exc:
            try:
                os.remove(saved_path)
            except OSError:
                pass
            rejected.append({"filename": filename, "error": str(exc) or "Could not read this file."})
    return {"media": accepted, "rejected": rejected}


def _safe_stem(filename: str) -> str:
    stem = os.path.splitext(os.path.basename(filename))[0]
    stem = re.sub(r"[^\w.-]+", "_", stem, flags=re.UNICODE).strip("._")
    return stem[:100] or "converted"


def _unique_label(label: str, existing: List[dict]) -> str:
    used = {item.get("display_filename", "").lower() for item in existing}
    if label.lower() not in used:
        return label
    stem, ext = os.path.splitext(label)
    suffix = 2
    while f"{stem} ({suffix}){ext}".lower() in used:
        suffix += 1
    return f"{stem} ({suffix}){ext}"


def _zip_member_path(name: str, root: str) -> Optional[str]:
    normalized = name.replace("\\", "/")
    member = PurePosixPath(normalized)
    if member.is_absolute() or not member.parts or any(part in {"", ".", ".."} for part in member.parts):
        raise ValueError("The archive contains an unsafe file path.")
    if ":" in member.parts[0]:
        raise ValueError("The archive contains an unsafe file path.")
    destination = os.path.realpath(os.path.join(root, *member.parts))
    if os.path.commonpath([os.path.realpath(root), destination]) != os.path.realpath(root):
        raise ValueError("The archive contains an unsafe file path.")
    return destination


def _zip_from_paths(paths: List[str], output_path: str, arc_prefix: Optional[str] = None,
                    arc_root: Optional[str] = None) -> None:
    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        used_names = set()
        for path in paths:
            if os.path.isfile(path):
                relative = os.path.relpath(path, arc_root) if arc_root else os.path.basename(path)
                arcname = os.path.join(arc_prefix, relative) if arc_prefix else relative
                base, ext = os.path.splitext(arcname)
                candidate = arcname
                suffix = 2
                while candidate.lower() in used_names:
                    candidate = f"{base} ({suffix}){ext}"
                    suffix += 1
                arcname = candidate
                used_names.add(arcname.lower())
                archive.write(path, arcname=arcname.replace("\\", "/"))


def _zip_extract_to_bundle(input_path: str, output_path: str, temp_root: str, tools: Dict[str, object]) -> None:
    ext = os.path.splitext(input_path)[1].lower()
    extract_dir = os.path.join(temp_root, "extracted")
    os.makedirs(extract_dir, exist_ok=True)
    if ext == ".zip":
        total_size = 0
        with zipfile.ZipFile(input_path) as archive:
            infos = archive.infolist()
            if len(infos) > MAX_ARCHIVE_ENTRIES:
                raise ValueError("The archive has too many entries to unpack safely.")
            for info in infos:
                if info.is_dir():
                    continue
                mode = info.external_attr >> 16
                if stat.S_ISLNK(mode):
                    raise ValueError("Archives containing symbolic links are not supported.")
                destination = _zip_member_path(info.filename, extract_dir)
                total_size += info.file_size
                if total_size > MAX_ARCHIVE_UNPACKED_BYTES:
                    raise ValueError("The unpacked archive would exceed the 2 GB safety limit.")
                os.makedirs(os.path.dirname(destination), exist_ok=True)
                with archive.open(info) as source, open(destination, "wb") as target:
                    shutil.copyfileobj(source, target)
    else:
        seven_zip = tools["seven_zip"]
        unrar = tools["unrar"]
        if seven_zip:
            listing = subprocess.run([seven_zip, "l", "-slt", input_path], capture_output=True, text=True, timeout=120)
            if listing.returncode:
                raise ValueError("Could not read this archive. It may be damaged or password protected.")
            paths, total_size = [], 0
            for line in listing.stdout.splitlines():
                if line.startswith("Path = "):
                    member = line[7:]
                    if os.path.abspath(member) == os.path.abspath(input_path):
                        continue
                    _zip_member_path(member, extract_dir)
                    paths.append(member)
                elif line.startswith("Size = "):
                    try:
                        total_size += int(line[7:])
                    except ValueError:
                        pass
            if len(paths) > MAX_ARCHIVE_ENTRIES or total_size > MAX_ARCHIVE_UNPACKED_BYTES:
                raise ValueError("The archive exceeds the safe unpacking limits.")
            result = subprocess.run([seven_zip, "x", "-y", f"-o{extract_dir}", input_path], capture_output=True, text=True, timeout=1800)
        elif ext == ".rar" and unrar:
            listing = subprocess.run([unrar, "lb", input_path], capture_output=True, text=True, timeout=120)
            if listing.returncode not in (0, 1):
                raise ValueError("Could not read this RAR archive. It may be damaged or password protected.")
            paths = [line for line in listing.stdout.splitlines() if line.strip()]
            if len(paths) > MAX_ARCHIVE_ENTRIES:
                raise ValueError("The archive has too many entries to unpack safely.")
            for member in paths:
                _zip_member_path(member, extract_dir)
            result = subprocess.run([unrar, "x", "-o-", input_path, extract_dir + os.sep], capture_output=True, text=True, timeout=1800)
        else:
            raise ValueError("Install 7-Zip to extract 7z files, or 7-Zip/UnRAR to extract RAR files.")
        if result.returncode:
            detail = (result.stderr or result.stdout or "Archive extraction failed.").strip().splitlines()[-1]
            raise ValueError(detail[:300])
        root_real = os.path.realpath(extract_dir)
        for directory, _dirs, files in os.walk(extract_dir):
            for filename in files:
                actual = os.path.realpath(os.path.join(directory, filename))
                if os.path.commonpath([root_real, actual]) != root_real:
                    raise ValueError("The archive contains an unsafe file path.")
    extracted = [os.path.join(directory, name) for directory, _dirs, files in os.walk(extract_dir) for name in files]
    if not extracted:
        raise ValueError("This archive contains no files.")
    _zip_from_paths(extracted, output_path, arc_prefix=_safe_stem(os.path.basename(input_path)), arc_root=extract_dir)


def _flatten_to_rgb(frame: Image.Image) -> Image.Image:
    """Flatten transparency onto a white background and ensure RGB mode."""
    if frame.mode in ("RGBA", "LA", "PA") or (frame.mode == "P" and "transparency" in frame.info):
        rgba = frame.convert("RGBA")
        background = Image.new("RGB", rgba.size, "white")
        background.paste(rgba, mask=rgba.getchannel("A"))
        return background
    return frame.convert("RGB") if frame.mode != "RGB" else frame


def _image_to_file(input_path: str, output_path: str, target: str) -> None:
    with Image.open(input_path) as source:
        frames = []
        frame_count = getattr(source, "n_frames", 1)
        keep_animation = target in {"gif", "webp"} and frame_count > 1
        durations = []
        for index in range(frame_count if keep_animation else 1):
            source.seek(index)
            durations.append(source.info.get("duration", 100))
            frame = ImageOps.exif_transpose(source.copy())
            if target in {"jpg", "pdf", "bmp"}:
                frame = _flatten_to_rgb(frame)
            elif target == "tiff":
                if frame.mode in ("CMYK", "YCbCr", "I;16", "I", "1", "P", "PA"):
                    frame = frame.convert("RGBA" if "A" in frame.getbands() or "transparency" in frame.info else "RGB")
            elif target == "png":
                if frame.mode in ("CMYK", "YCbCr", "I;16", "I", "1"):
                    frame = frame.convert("RGBA" if "A" in frame.getbands() else "RGB")
            elif target == "gif":
                frame = frame.convert("RGBA").convert("P", palette=Image.Palette.ADAPTIVE)
            elif target == "webp":
                has_alpha = "A" in frame.getbands() or (frame.mode == "P" and "transparency" in frame.info)
                frame = frame.convert("RGBA" if has_alpha else "RGB")
            frames.append(frame)
        first = frames[0]
        if target == "pdf":
            first.save(output_path, "PDF", resolution=150)
        elif target == "jpg":
            first.save(output_path, "JPEG", quality=90, optimize=True)
        elif target == "webp":
            if keep_animation:
                first.save(output_path, "WEBP", save_all=True, append_images=frames[1:], quality=90, method=5,
                           duration=durations, loop=source.info.get("loop", 0))
            else:
                first.save(output_path, "WEBP", quality=90, method=5)
        elif target == "gif":
            first.save(output_path, "GIF", save_all=keep_animation, append_images=frames[1:],
                       duration=durations if keep_animation else durations[0],
                       loop=source.info.get("loop", 0), optimize=True)
        else:
            first.save(output_path, target.upper())


def _pdf_pages_to_bundle(input_path: str, output_path: str, target: str, temp_root: str) -> None:
    import pymupdf
    pages_dir = os.path.join(temp_root, "pages")
    os.makedirs(pages_dir, exist_ok=True)
    with pymupdf.open(input_path) as document:
        if document.page_count > 1000:
            raise ValueError("PDFs with more than 1,000 pages are not supported.")
        for index, page in enumerate(document):
            pix = page.get_pixmap(dpi=150, alpha=False)
            name = f"page-{index + 1:04d}.{target}"
            pix.save(os.path.join(pages_dir, name))
    _zip_from_paths([os.path.join(pages_dir, name) for name in os.listdir(pages_dir)], output_path)


def _office_to_pdf(input_path: str, output_path: str, tools: Dict[str, object], temp_root: str) -> None:
    office = tools["soffice"]
    if not office:
        raise ValueError("Install LibreOffice to convert Office files to PDF.")
    out_dir = os.path.join(temp_root, "office")
    profile = os.path.join(temp_root, "office-profile")
    os.makedirs(out_dir, exist_ok=True)
    result = subprocess.run(
        [office, "--headless", f"-env:UserInstallation={__import__('pathlib').Path(profile).as_uri()}",
         "--convert-to", "pdf", "--outdir", out_dir, input_path],
        capture_output=True, text=True, timeout=300,
    )
    produced = os.path.join(out_dir, os.path.splitext(os.path.basename(input_path))[0] + ".pdf")
    if result.returncode or not os.path.isfile(produced):
        detail = (result.stderr or result.stdout or "Office conversion failed.").strip().splitlines()[-1]
        raise ValueError(detail[:300])
    shutil.copyfile(produced, output_path)


def _read_source(path: str) -> str:
    with open(path, "r", encoding="utf-8-sig") as source:
        return source.read()


def _read_notebook(path: str) -> dict:
    import nbformat
    notebook = nbformat.read(path, as_version=4)
    for cell in notebook.cells:
        if not cell.get("id"):
            cell["id"] = uuid.uuid4().hex[:8]
    nbformat.validate(notebook)
    return notebook


def _source_entries(item: dict, source_path: str) -> List[dict]:
    """Build a passive document outline; notebook code is never evaluated."""
    if item["media_type"] == "code":
        return [{"kind": "code", "text": _read_source(source_path), "lexer": item["filename"]}]

    notebook = _read_notebook(source_path)
    entries: List[dict] = []
    output_chars = 0
    for cell_index, cell in enumerate(notebook.cells, 1):
        if cell.cell_type == "markdown":
            entries.append({"kind": "markdown", "text": str(cell.source)})
            continue
        if cell.cell_type != "code":
            continue
        entries.append({"kind": "heading", "text": f"Code cell {cell_index}"})
        entries.append({"kind": "code", "text": str(cell.source), "lexer": "python"})
        for output in cell.get("outputs", []):
            output_type = output.get("output_type")
            if output_type == "stream":
                value = "".join(output.get("text", [])) if isinstance(output.get("text"), list) else str(output.get("text", ""))
                if value:
                    output_chars += len(value)
                    if output_chars > MAX_NOTEBOOK_OUTPUT_CHARS:
                        raise ValueError("Saved notebook text output is larger than the 500,000 character limit.")
                    entries.append({"kind": "output", "text": value})
            elif output_type == "error":
                value = "\n".join(output.get("traceback", [])) or f"{output.get('ename', 'Error')}: {output.get('evalue', '')}"
                output_chars += len(value)
                if output_chars > MAX_NOTEBOOK_OUTPUT_CHARS:
                    raise ValueError("Saved notebook text output is larger than the 500,000 character limit.")
                entries.append({"kind": "output", "text": value})
            elif output_type in {"display_data", "execute_result"}:
                data = output.get("data", {})
                image = data.get("image/png")
                if image:
                    try:
                        raw = base64.b64decode(image, validate=True)
                        if len(raw) > 10 * 1024 * 1024:
                            raise ValueError("A saved notebook image is larger than the 10 MB limit.")
                        entries.append({"kind": "image", "data": raw})
                    except (binascii.Error, ValueError):
                        entries.append({"kind": "output", "text": "[A saved image output could not be included.]"})
                else:
                    value = data.get("text/plain", "")
                    value = "".join(value) if isinstance(value, list) else str(value)
                    if value:
                        output_chars += len(value)
                        if output_chars > MAX_NOTEBOOK_OUTPUT_CHARS:
                            raise ValueError("Saved notebook text output is larger than the 500,000 character limit.")
                        entries.append({"kind": "output", "text": value})
                    elif data:
                        entries.append({"kind": "output", "text": "[A saved rich output format is not supported and was omitted.]"})
    return entries


def _lexer_for(filename: str):
    from pygments.lexers import TextLexer, get_lexer_for_filename
    try:
        return get_lexer_for_filename(filename, stripnl=False, ensurenl=False)
    except Exception:
        return TextLexer(stripnl=False, ensurenl=False)


def _token_lines(source: str, filename: str) -> List[List[tuple]]:
    from pygments import lex
    from pygments.styles import get_style_by_name
    from pygments.token import Token
    style = get_style_by_name("friendly")
    lines: List[List[tuple]] = [[]]
    lexer = _lexer_for(filename)
    for token_type, value in lex(source, lexer):
        token_style = style.style_for_token(token_type)
        color = tuple(int(token_style["color"][index:index + 2], 16) / 255 for index in (0, 2, 4)) if token_style.get("color") else (0.12, 0.15, 0.20)
        if token_type in Token.Comment:
            color = (0.38, 0.48, 0.40)
        chunks = value.split("\n")
        for index, chunk in enumerate(chunks):
            if chunk:
                lines[-1].append((chunk.expandtabs(4), color))
            if index < len(chunks) - 1:
                lines.append([])
    if len(lines) > 1 and not lines[-1]:
        lines.pop()
    return lines


def _wrap_token_runs(runs: List[tuple], width: int = 96) -> List[List[tuple]]:
    wrapped: List[List[tuple]] = [[]]
    length = 0
    for value, color in runs:
        while value:
            available = width - length
            if available <= 0:
                wrapped.append([])
                wrapped[-1].append(("    ", (0.12, 0.15, 0.20)))
                length = 4
                available = width - length
            piece, value = value[:available], value[available:]
            wrapped[-1].append((piece, color))
            length += len(piece)
            if value:
                wrapped.append([])
                wrapped[-1].append(("    ", (0.12, 0.15, 0.20)))
                length = 4
    return wrapped


def _append_source_docx(document, source: str, filename: str) -> None:
    from docx.shared import RGBColor, Pt
    lines = _token_lines(source, filename)
    for number, runs in enumerate(lines, 1):
        paragraph = document.add_paragraph()
        paragraph.paragraph_format.space_after = Pt(0)
        paragraph.paragraph_format.keep_together = True
        number_run = paragraph.add_run(f"{number:>4}  ")
        number_run.font.name = "Consolas"
        number_run.font.size = Pt(8)
        number_run.font.color.rgb = RGBColor(130, 140, 150)
        expanded_runs = _wrap_token_runs(runs)
        for wrap_index, wrap_runs in enumerate(expanded_runs):
            if wrap_index:
                paragraph.add_run().add_break()
            for value, color in wrap_runs:
                run = paragraph.add_run(value)
                run.font.name = "Consolas"
                run.font.size = Pt(8)
                run.font.color.rgb = RGBColor(*(round(channel * 255) for channel in color))


def _source_to_docx(entries: List[dict], input_name: str, output_path: str) -> None:
    from docx import Document
    from docx.shared import Inches, Pt
    document = Document()
    section = document.sections[0]
    section.page_width = Inches(8.27)
    section.page_height = Inches(11.69)
    section.top_margin = section.bottom_margin = Inches(0.65)
    section.left_margin = section.right_margin = Inches(0.7)
    document.add_heading(input_name, level=0)
    for entry in entries:
        kind, value = entry["kind"], entry.get("text", "")
        if kind == "code":
            _append_source_docx(document, value, entry.get("lexer", input_name))
        elif kind == "heading":
            document.add_heading(value, level=2)
        elif kind in {"markdown", "output"}:
            for line in value.splitlines() or [""]:
                paragraph = document.add_paragraph()
                paragraph.paragraph_format.space_after = Pt(3)
                run = paragraph.add_run(line[:20000])
                run.font.name = "Consolas" if kind == "output" else "Aptos"
                run.font.size = Pt(9)
                if kind == "output":
                    from docx.shared import RGBColor
                    run.font.color.rgb = RGBColor(90, 95, 100)
        elif kind == "image":
            try:
                document.add_picture(BytesIO(entry["data"]), width=Inches(6.0))
            except Exception:
                document.add_paragraph("[A saved notebook image could not be included.]")
    document.save(output_path)


def _source_to_pdf(entries: List[dict], input_name: str, output_path: str) -> None:
    import pymupdf
    page_width, page_height = 595.28, 841.89
    margin, body_size, line_height = 42, 8, 10
    document = pymupdf.open()
    page = document.new_page(width=page_width, height=page_height)
    y = margin
    page_count = 0

    def new_page():
        nonlocal page, y, page_count
        page = document.new_page(width=page_width, height=page_height)
        page_count += 1
        y = margin
        page.insert_text((margin, y), input_name[:120], fontname="helv", fontsize=8, color=(0.42, 0.46, 0.50))
        y += 18

    def ensure_space(height=line_height):
        nonlocal y
        if y + height > page_height - margin:
            new_page()

    def add_text(value: str, size: float = body_size, color=(0.12, 0.15, 0.20), font="helv", gap=0):
        nonlocal y
        for line in value.splitlines() or [""]:
            for wrapped in textwrap.wrap(line, width=100, replace_whitespace=False, drop_whitespace=False) or [""]:
                ensure_space(size + 3)
                page.insert_text((margin, y + size), wrapped[:180], fontname=font, fontsize=size, color=color)
                y += size + 3
        y += gap

    page.insert_text((margin, y + 15), input_name[:120], fontname="hebo", fontsize=15, color=(0.10, 0.17, 0.25))
    y += 32
    for entry in entries:
        kind = entry["kind"]
        if kind == "heading":
            y += 5
            add_text(entry["text"], size=11, color=(0.08, 0.35, 0.55), font="hebo", gap=3)
        elif kind == "markdown":
            add_text(entry.get("text", ""), size=9, gap=4)
        elif kind == "output":
            add_text(entry.get("text", ""), size=8, color=(0.40, 0.43, 0.46), font="cour", gap=4)
        elif kind == "image":
            try:
                pixmap = pymupdf.Pixmap(entry["data"])
                max_width, max_height = page_width - margin * 2, 250
                scale = min(max_width / pixmap.width, max_height / pixmap.height, 1)
                width, height = pixmap.width * scale, pixmap.height * scale
                ensure_space(height + 8)
                page.insert_image(pymupdf.Rect(margin, y, margin + width, y + height), pixmap=pixmap)
                y += height + 8
            except Exception:
                add_text("[A saved notebook image could not be included.]", size=8, gap=3)
        elif kind == "code":
            logical_lines = _token_lines(entry.get("text", ""), entry.get("lexer", input_name))
            for line_number, runs in enumerate(logical_lines, 1):
                wraps = _wrap_token_runs(runs, width=93)
                for wrap_index, wrap_runs in enumerate(wraps):
                    ensure_space(line_height)
                    prefix = f"{line_number:>4}  " if wrap_index == 0 else "      "
                    page.insert_text((margin, y + body_size), prefix, fontname="cour", fontsize=body_size, color=(0.48, 0.52, 0.56))
                    x = margin + pymupdf.get_text_length(prefix, fontname="cour", fontsize=body_size)
                    for value, color in wrap_runs:
                        if x > page_width - margin:
                            break
                        page.insert_text((x, y + body_size), value, fontname="cour", fontsize=body_size, color=color)
                        x += pymupdf.get_text_length(value, fontname="cour", fontsize=body_size)
                    y += line_height
            y += 5
    if page_count == 0:
        page.insert_text((margin, page_height - margin), "Page 1", fontname="helv", fontsize=7, color=(0.6, 0.6, 0.6))
    document.save(output_path, garbage=4, deflate=True)
    document.close()


def _code_to_document(item: dict, input_path: str, output_path: str, target: str) -> None:
    entries = _source_entries(item, input_path)
    if target == "pdf":
        _source_to_pdf(entries, item["filename"], output_path)
    elif target == "docx":
        _source_to_docx(entries, item["filename"], output_path)
    else:
        raise ValueError("Source files can be exported as PDF or Word documents.")


def _run_ffmpeg(input_path: str, output_path: str, target: str, category: str, tools: Dict[str, object]) -> None:
    ffmpeg = tools["ffmpeg"]
    if not ffmpeg:
        raise ValueError("Install FFmpeg to convert video and audio files.")
    cmd = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", input_path]
    if category == "video":
        cmd += ["-map", "0:v:0", "-map", "0:a?", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p"]
        if target == "webm":
            cmd += ["-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0"]
            cmd += ["-c:a", "libopus", "-b:a", "128k"]
        else:
            cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", "23"]
            cmd += ["-c:a", "aac", "-b:a", "160k"]
        if target in {"mp4", "mov"}:
            cmd += ["-movflags", "+faststart"]
    else:
        cmd += ["-vn"]
        audio_codecs = {
            "mp3": ["-c:a", "libmp3lame", "-b:a", "192k"],
            "wav": ["-c:a", "pcm_s16le"],
            "aac": ["-c:a", "aac", "-b:a", "192k", "-f", "adts"],
            "m4a": ["-c:a", "aac", "-b:a", "192k"],
            "flac": ["-c:a", "flac"],
            "ogg": ["-c:a", "libvorbis", "-q:a", "5"],
        }
        cmd += audio_codecs[target]
    cmd.append(output_path)
    with heavy_task_slot():
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=6 * 60 * 60)
    if result.returncode or not os.path.isfile(output_path) or os.path.getsize(output_path) == 0:
        detail = (result.stderr or "FFmpeg conversion failed.").strip().splitlines()[-1]
        raise ValueError(detail[:300])


def _conversion_target(item: dict, target: str, tools: Dict[str, object]) -> str:
    ext = os.path.splitext(item["filename"])[1].lower()
    category = _category(ext, item["filename"])
    allowed = _targets_for(ext, tools, item["filename"])
    if target not in allowed:
        raise ValueError("This output format is not available for the selected file.")
    if category == "archive":
        return "zip"
    return target


def _preview_kind(ext: str) -> str:
    ext = ext.lower().lstrip(".")
    if ext in {"jpg", "jpeg", "png", "webp", "bmp", "tiff", "gif"}:
        return "image"
    if ext in {"mp4", "mov", "mkv", "webm", "avi"}:
        return "video"
    if ext in {"mp3", "wav", "aac", "m4a", "flac", "ogg"}:
        return "audio"
    if ext == "pdf":
        return "pdf"
    if ext == "zip":
        return "zip"
    if ext == "docx":
        return "docx"
    return "other"


def _converter_worker(job_id: str, req: ConverterJobRequest, tools: Dict[str, object]) -> None:
    with jobs_lock:
        job = jobs[job_id]
    actions = []
    for choice in req.conversions:
        item = uploaded_media.get(choice.file_id)
        if item:
            actions.append(("convert", item, choice.target))
    if req.combine_image_ids:
        items = [uploaded_media[fid] for fid in req.combine_image_ids if fid in uploaded_media]
        actions.append(("combine", items, "pdf"))
    if req.zip_file_ids:
        items = [uploaded_media[fid] for fid in req.zip_file_ids if fid in uploaded_media]
        actions.append(("zip", items, "zip"))
    total = max(1, len(actions))
    completed = []
    was_cancelled = False
    protected_inputs = set()
    for kind, value, _ in actions:
        if kind == "convert":
            protected_inputs.add(os.path.join(UPLOADS_DIR, value["saved_filename"]))
        else:
            for it in value:
                protected_inputs.add(os.path.join(UPLOADS_DIR, it["saved_filename"]))
    with jobs_lock:
        active_job_paths[job_id] = set(protected_inputs)
    try:
        for index, (kind, value, target) in enumerate(actions):
            with jobs_lock:
                if job.get("cancelled"):
                    was_cancelled = True
                    break
            output = None
            try:
                with tempfile.TemporaryDirectory(prefix=f"{job_id}_", dir=OUTPUTS_DIR) as temp_root:
                    if kind == "convert":
                        item = value
                        target = _conversion_target(item, target, tools)
                        source = os.path.join(UPLOADS_DIR, item["saved_filename"])
                        root = _safe_stem(item["filename"])
                        out_ext = target
                        if item["media_type"] == "pdf":
                            out_ext = "zip"
                        internal = f"converter_{job_id}_{index + 1}_{root}.{out_ext}"
                        output = os.path.join(OUTPUTS_DIR, internal)
                        with jobs_lock:
                            active_job_paths.setdefault(job_id, set()).add(output)
                        if item["media_type"] == "image":
                            _image_to_file(source, output, target)
                        elif item["media_type"] in {"video", "audio"}:
                            _run_ffmpeg(source, output, target, item["media_type"], tools)
                        elif item["media_type"] == "pdf":
                            _pdf_pages_to_bundle(source, output, target, temp_root)
                        elif item["media_type"] == "office":
                            _office_to_pdf(source, output, tools, temp_root)
                        elif item["media_type"] == "archive":
                            _zip_extract_to_bundle(source, output, temp_root, tools)
                        elif item["media_type"] in {"code", "notebook"}:
                            _code_to_document(item, source, output, target)
                        else:
                            raise ValueError("This file type cannot be converted.")
                        label = _unique_label(f"{root}.{out_ext}", completed)
                        completed_item = {"file_id": item["id"], "filename": item["filename"],
                                          "display_filename": label, "output_filename": internal,
                                          "download_url": f"/api/converter/files/{url_segment(internal)}?name={url_segment(label)}",
                                          "preview_url": f"/api/converter/files/{url_segment(internal)}?inline=1",
                                          "preview_type": _preview_kind(out_ext),
                                          "output_size_bytes": os.path.getsize(output), "status": "completed",
                                          "progress": 1.0, "error": None}
                    else:
                        items = value
                        if not items:
                            raise ValueError("No files selected for this action.")
                        if kind == "combine":
                            if any(item["media_type"] != "image" for item in items):
                                raise ValueError("Only images can be combined into a PDF.")
                            images = []
                            try:
                                for item in items:
                                    with Image.open(os.path.join(UPLOADS_DIR, item["saved_filename"])) as image:
                                        images.append(_flatten_to_rgb(ImageOps.exif_transpose(image.copy())))
                                internal = f"converter_{job_id}_{index + 1}_combined_images.pdf"
                                output = os.path.join(OUTPUTS_DIR, internal)
                                with jobs_lock:
                                    active_job_paths.setdefault(job_id, set()).add(output)
                                images[0].save(output, "PDF", save_all=True, append_images=images[1:], resolution=150)
                            finally:
                                for im in images:
                                    try:
                                        im.close()
                                    except Exception:
                                        pass
                            label = _unique_label("combined-images.pdf", completed)
                            out_ext = "pdf"
                        else:
                            internal = f"converter_{job_id}_{index + 1}_selected_files.zip"
                            output = os.path.join(OUTPUTS_DIR, internal)
                            with jobs_lock:
                                active_job_paths.setdefault(job_id, set()).add(output)
                            with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
                                used_names = set()
                                for item in items:
                                    src = os.path.join(UPLOADS_DIR, item["saved_filename"])
                                    if not os.path.isfile(src):
                                        continue
                                    arcname = os.path.basename(item["filename"]) or item["saved_filename"]
                                    base, ext = os.path.splitext(arcname)
                                    candidate, suffix = arcname, 2
                                    while candidate.lower() in used_names:
                                        candidate = f"{base} ({suffix}){ext}"
                                        suffix += 1
                                    used_names.add(candidate.lower())
                                    archive.write(src, arcname=candidate)
                            label = _unique_label("selected-files.zip", completed)
                            out_ext = "zip"
                        completed_item = {"file_id": None, "filename": label, "display_filename": label,
                                          "output_filename": internal,
                                          "download_url": f"/api/converter/files/{url_segment(internal)}?name={url_segment(label)}",
                                          "preview_url": f"/api/converter/files/{url_segment(internal)}?inline=1",
                                          "preview_type": _preview_kind(out_ext),
                                          "output_size_bytes": os.path.getsize(output), "status": "completed",
                                          "progress": 1.0, "error": None}
                    register_session_file(req.session_id, output)
                    completed.append(completed_item)
                    with jobs_lock:
                        job["items"].append(completed_item)
            except Exception as exc:
                if output and os.path.isfile(output):
                    try:
                        os.remove(output)
                    except OSError:
                        pass
                failed = {"filename": value.get("filename", "Selected files") if kind == "convert" else kind,
                          "display_filename": value.get("filename", "Selected files") if kind == "convert" else kind,
                          "status": "failed", "progress": 1.0, "error": str(exc) or "Conversion failed."}
                with jobs_lock:
                    job["items"].append(failed)
            with jobs_lock:
                job["progress"] = round((index + 1) / total, 2)

        with jobs_lock:
            if job.get("cancelled"):
                was_cancelled = True

        if completed and not was_cancelled:
            bundle_name = f"converter_{job_id}_results.zip"
            bundle_path = os.path.join(OUTPUTS_DIR, bundle_name)
            with zipfile.ZipFile(bundle_path, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
                for item in completed:
                    source = os.path.join(OUTPUTS_DIR, item["output_filename"])
                    if os.path.isfile(source):
                        bundle.write(source, arcname=item["display_filename"])
            register_session_file(req.session_id, bundle_path)
            with jobs_lock:
                job["zip_filename"] = bundle_name
                job["zip_download_url"] = f"/api/converter/jobs/{url_segment(job_id)}/download"
        with jobs_lock:
            if was_cancelled or job.get("cancelled"):
                job["status"] = "cancelled"
            else:
                job["status"] = "completed" if completed else "failed"
                if not completed:
                    job["error"] = "No files could be converted."
    finally:
        with jobs_lock:
            active_job_paths.pop(job_id, None)
        release_session_job(req.session_id)


@router.post("/api/converter/jobs")
def start_converter_job(req: ConverterJobRequest, background_tasks: BackgroundTasks):
    if not req.conversions and not req.combine_image_ids and not req.zip_file_ids:
        raise HTTPException(status_code=400, detail="Choose a conversion or a package action first.")
    all_ids = [choice.file_id for choice in req.conversions] + req.combine_image_ids + req.zip_file_ids
    if any(fid not in uploaded_media for fid in all_ids):
        raise HTTPException(status_code=404, detail="One or more uploaded files are no longer available.")
    tools = _tools()
    try:
        for choice in req.conversions:
            item = uploaded_media[choice.file_id]
            _conversion_target(item, choice.target, tools)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if req.combine_image_ids and any(uploaded_media[fid].get("media_type") != "image" for fid in req.combine_image_ids):
        raise HTTPException(status_code=400, detail="Only images can be combined into a PDF.")
    job_id = f"converter_{uuid.uuid4().hex[:8]}"
    with jobs_lock:
        jobs[job_id] = {"id": job_id, "type": "converter", "status": "processing", "progress": 0.0,
                        "items": [], "zip_filename": None, "cancelled": False,
                        "created_at": time.time(), "session_id": req.session_id}
    if req.session_id:
        with session_files_lock:
            session_active_jobs[req.session_id] = session_active_jobs.get(req.session_id, 0) + 1
    background_tasks.add_task(_converter_worker, job_id, req, tools)
    return {"job_id": job_id, "status": "processing"}


@router.get("/api/converter/jobs/{job_id}")
def converter_job_status(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job or job.get("type") != "converter":
            raise HTTPException(status_code=404, detail="Converter job not found")
        return dict(job)


@router.get("/api/converter/jobs/{job_id}/download")
def download_converter_bundle(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job or job.get("type") != "converter" or not job.get("zip_filename"):
            raise HTTPException(status_code=404, detail="Converter bundle not found")
        filename = job["zip_filename"]
    path = resolve_safe_path(OUTPUTS_DIR, filename, must_exist=True)
    return FileResponse(path, filename="converted-files.zip", media_type="application/zip")


_CONVERTER_MIME_MAP = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".zip": "application/zip",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".avi": "video/x-msvideo",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".aac": "audio/aac",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
}


def _guess_mime(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext in _CONVERTER_MIME_MAP:
        return _CONVERTER_MIME_MAP[ext]
    guessed, _ = mimetypes.guess_type(path)
    return guessed or "application/octet-stream"


@router.get("/api/converter/files/{filename}")
def serve_converter_file(filename: str, inline: bool = Query(False), name: Optional[str] = Query(None)):
    path = resolve_safe_path(OUTPUTS_DIR, filename, must_exist=True)
    ext = os.path.splitext(path)[1].lower()
    media_type = _guess_mime(path)
    clean_name = os.path.basename((name or "").replace("\\", "/")).strip()
    if not clean_name:
        parts = os.path.basename(path).split("_", 1)
        clean_name = parts[1] if len(parts) > 1 else os.path.basename(path)
    if inline:
        if ext in {".tiff", ".tif"}:
            with Image.open(path) as img:
                buf = BytesIO()
                img.convert("RGBA" if "A" in img.getbands() else "RGB").save(buf, format="PNG")
                return Response(content=buf.getvalue(), media_type="image/png", headers={"Content-Disposition": "inline"})
        return FileResponse(path, filename=clean_name, media_type=media_type, content_disposition_type="inline")
    return FileResponse(path, filename=clean_name, media_type=media_type)


@router.get("/api/converter/preview/{filename}")
def preview_converter_metadata(filename: str):
    path = resolve_safe_path(OUTPUTS_DIR, filename, must_exist=True)
    ext = os.path.splitext(path)[1].lower()
    if ext == ".zip":
        entries = []
        with zipfile.ZipFile(path) as archive:
            for info in archive.infolist()[:200]:
                if info.is_dir():
                    continue
                entry_ext = os.path.splitext(info.filename)[1].lower()
                is_image = entry_ext in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
                entries.append({
                    "name": info.filename,
                    "size": info.file_size,
                    "is_image": is_image,
                    "preview_url": (
                        f"/api/converter/zip-entry/{url_segment(filename)}?entry={url_segment(info.filename)}"
                        if is_image else None
                    ),
                })
        return {"type": "zip", "entries": entries}
    if ext == ".docx":
        from docx import Document
        doc = Document(path)
        paragraphs = [p.text for p in doc.paragraphs if p.text.strip()][:300]
        return {"type": "docx", "paragraphs": paragraphs}
    return {"type": _preview_kind(ext)}


@router.get("/api/converter/zip-entry/{filename}")
def preview_zip_entry(filename: str, entry: str = Query(...)):
    path = resolve_safe_path(OUTPUTS_DIR, filename, must_exist=True)
    entry_ext = os.path.splitext(entry)[1].lower()
    if entry_ext not in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}:
        raise HTTPException(status_code=400, detail="Only image entries can be previewed.")
    with zipfile.ZipFile(path) as archive:
        if entry not in archive.namelist():
            raise HTTPException(status_code=404, detail="Archive entry not found.")
        info = archive.getinfo(entry)
        if info.file_size > 25 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Entry too large to preview.")
        data = archive.read(info)
    return Response(content=data, media_type=_CONVERTER_MIME_MAP.get(entry_ext, "image/png"), headers={"Content-Disposition": "inline"})


@router.get("/api/converter/preview-video/{filename}")
def preview_converter_video(filename: str):
    path = resolve_safe_path(OUTPUTS_DIR, filename, must_exist=True)
    tools = _tools()
    ffmpeg = tools.get("ffmpeg")
    if not ffmpeg:
        raise HTTPException(status_code=400, detail="FFmpeg is required for video preview.")
    preview_name = f"preview_{os.path.splitext(os.path.basename(path))[0]}.mp4"
    preview_path = resolve_safe_path(OUTPUTS_DIR, preview_name)
    if not os.path.isfile(preview_path) or os.path.getsize(preview_path) == 0:
        cmd = [
            ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            "-i", path, "-map", "0:v:0", "-map", "0:a?",
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26",
            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
            preview_path,
        ]
        with heavy_task_slot():
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if res.returncode or not os.path.isfile(preview_path) or os.path.getsize(preview_path) == 0:
            raise HTTPException(status_code=500, detail="Could not generate browser video preview.")
    return FileResponse(preview_path, media_type="video/mp4", content_disposition_type="inline")
