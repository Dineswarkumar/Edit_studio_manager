"""
Fetch curated Microsoft Fluent UI 3D PNG emojis (MIT License) into static/assets/emojis/
and mirror into android/app/src/main/assets/static/assets/emojis/ for offline parity.

Usage:
    python tools/build_emoji_pack.py
"""
from __future__ import annotations

import json
import shutil
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from io import BytesIO
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import requests
from PIL import Image

ROOT_DIR = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT_DIR / "static" / "assets" / "emojis"
ANDROID_OUT_DIR = ROOT_DIR / "android" / "app" / "src" / "main" / "assets" / "static" / "assets" / "emojis"
TARGET_SIZE = 256

FLUENT_TREE_API = "https://api.github.com/repos/microsoft/fluentui-emoji/git/trees/main?recursive=1"
FLUENT_RAW_BASE = "https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/"
FLUENT_LICENSE_URL = f"{FLUENT_RAW_BASE}LICENSE"
NOTO_FALLBACK = "https://fonts.gstatic.com/s/e/notoemoji/latest/{cp}/512.png"

# (id, label, category, unicode_char, fluent_folder_name)
EMOJI_PACK: List[Tuple[str, str, str, str, str]] = [
    # --- Core Faces (existing IDs preserved) ---
    ("sunglasses", "Cool Sunglasses", "faces", "😎", "Smiling face with sunglasses"),
    ("smiley", "Grinning Face", "faces", "😀", "Grinning face"),
    ("clown", "Clown Face", "faces", "🤡", "Clown face"),
    ("heart_eyes", "Heart Eyes", "faces", "😍", "Smiling face with heart-eyes"),
    ("cat", "Grinning Cat", "faces", "😺", "Grinning cat"),
    ("alien", "Alien", "faces", "👽", "Alien"),
    ("robot", "Robot", "faces", "🤖", "Robot"),
    ("joy", "Tears of Joy", "faces", "😂", "Face with tears of joy"),
    ("rofl", "Rolling Laugh", "faces", "🤣", "Rolling on the floor laughing"),
    ("wink", "Winking Face", "faces", "😉", "Winking face"),
    ("blush", "Smiling Blush", "faces", "😊", "Smiling face with smiling eyes"),
    ("smirk", "Smirking Face", "faces", "😏", "Smirking face"),
    ("kissing_heart", "Blowing Kiss", "faces", "😘", "Face blowing a kiss"),
    ("partying", "Partying Face", "faces", "🥳", "Partying face"),
    ("mind_blown", "Mind Blown", "faces", "🤯", "Exploding head"),
    ("thinking", "Thinking Face", "faces", "🤔", "Thinking face"),
    ("shushing", "Shushing Face", "faces", "🤫", "Shushing face"),
    ("zany", "Zany Face", "faces", "🤪", "Zany face"),
    ("star_struck", "Star Struck", "faces", "🤩", "Star-struck"),
    ("pleading", "Pleading Face", "faces", "🥺", "Pleading face"),
    ("sob", "Loudly Crying", "faces", "😭", "Loudly crying face"),
    ("scream", "Screaming Fear", "faces", "😱", "Face screaming in fear"),
    ("rage", "Enraged Face", "faces", "😡", "Pouting face"),
    ("skull", "Skull", "faces", "💀", "Skull"),
    ("ghost", "Ghost", "faces", "👻", "Ghost"),
    ("devil", "Smiling Devil", "faces", "😈", "Smiling face with horns"),
    # --- Modern Expressions ---
    ("melting_face", "Melting Face", "faces", "🫠", "Melting face"),
    ("saluting_face", "Saluting Face", "faces", "🫡", "Saluting face"),
    ("peeking_eye", "Peeking Eye", "faces", "🫣", "Face with peeking eye"),
    ("holding_tears", "Holding Back Tears", "faces", "🥹", "Face holding back tears"),
    ("smiling_hearts", "Smiling With Hearts", "faces", "🥰", "Smiling face with hearts"),
    ("nerd", "Nerd Face", "faces", "🤓", "Nerd face"),
    ("cowboy", "Cowboy Hat", "faces", "🤠", "Cowboy hat face"),
    ("cold_face", "Cold Face", "faces", "🥶", "Cold face"),
    ("hot_face", "Hot Face", "faces", "🥵", "Hot face"),
    ("money_mouth", "Money Mouth", "faces", "🤑", "Money-mouth face"),
    # --- Privacy & Identity Masking ---
    ("dotted_face", "Anonymous / Dotted", "privacy", "🫥", "Dotted line face"),
    ("disguised", "Disguised Face", "privacy", "🥸", "Disguised face"),
    ("zipper_mouth", "Zipper Mouth", "privacy", "🤐", "Zipper-mouth face"),
    ("see_no_evil", "See No Evil", "privacy", "🙈", "See-no-evil monkey"),
    ("hear_no_evil", "Hear No Evil", "privacy", "🙉", "Hear-no-evil monkey"),
    ("speak_no_evil", "Speak No Evil", "privacy", "🙊", "Speak-no-evil monkey"),
    ("locked", "Locked Privacy", "privacy", "🔒", "Locked"),
    ("shield", "Privacy Shield", "privacy", "🛡️", "Shield"),
    ("censored", "No Entry / Prohibited", "badges", "🚫", "Prohibited"),
    ("no_under_18", "18+ Badge", "badges", "🔞", "No one under eighteen"),
    ("check_mark", "Verified Check", "badges", "✅", "Check mark button"),
    # --- Hearts ---
    ("red_heart", "Red Heart", "hearts", "❤️", "Red heart"),
    ("pink_heart", "Pink Heart", "hearts", "🩷", "Pink heart"),
    ("sparkling_heart", "Sparkling Heart", "hearts", "💖", "Sparkling heart"),
    ("purple_heart", "Purple Heart", "hearts", "💜", "Purple heart"),
    ("black_heart", "Black Heart", "hearts", "🖤", "Black heart"),
    ("heart_on_fire", "Heart on Fire", "hearts", "❤️‍🔥", "Heart on fire"),
    # --- Effects & Stickers ---
    ("fire", "Fire", "effects", "🔥", "Fire"),
    ("sparkles", "Sparkles", "effects", "✨", "Sparkles"),
    ("lightning", "High Voltage", "effects", "⚡", "High voltage"),
    ("hundred", "100 Score", "effects", "💯", "Hundred points"),
    ("eyes", "Eyes", "stickers", "👀", "Eyes"),
    ("lips", "Mouth / Lips", "stickers", "👄", "Mouth"),
    ("poop", "Pile of Poo", "stickers", "💩", "Pile of poo"),
    ("crown", "Crown", "stickers", "👑", "Crown"),
    ("gem", "Gem Stone", "stickers", "💎", "Gem stone"),
    ("camera_flash", "Camera Flash", "stickers", "📸", "Camera with flash"),
    # --- Gestures ---
    ("thumbs_up", "Thumbs Up", "gestures", "👍", "Thumbs up"),
    ("peace", "Victory / Peace", "gestures", "✌️", "Victory hand"),
    ("wave", "Waving Hand", "gestures", "👋", "Waving hand"),
    ("heart_hands", "Heart Hands", "gestures", "🫶", "Heart hands"),
]


def _char_to_cp(char: str) -> str:
    cps = [f"{ord(c):x}" for c in char if ord(c) != 0xFE0F]
    return "_".join(cps)


def _fetch_fluent_tree_map() -> Dict[str, str]:
    """Return mapping of lowercased Fluent folder name -> repo path to its 3D PNG."""
    resp = requests.get(FLUENT_TREE_API, timeout=25)
    resp.raise_for_status()
    tree = resp.json().get("tree", [])
    mapping: Dict[str, str] = {}
    for item in tree:
        p = item.get("path", "")
        if not p.endswith(".png") or "/3D/" not in p:
            continue
        parts = p.split("/")
        if len(parts) == 4 and parts[0] == "assets" and parts[2] == "3D":
            mapping[parts[1].lower()] = p
        elif len(parts) == 5 and parts[0] == "assets" and parts[2] == "Default" and parts[3] == "3D":
            mapping.setdefault(parts[1].lower(), p)
    return mapping


def _download_one(
    entry: Tuple[str, str, str, str, str],
    tree_map: Dict[str, str],
    out_dir: Path,
) -> Optional[Dict[str, str]]:
    emoji_id, label, category, char, folder_name = entry
    dest = out_dir / f"{emoji_id}.png"
    repo_path = tree_map.get(folder_name.lower())

    urls: List[str] = []
    if repo_path:
        encoded = "/".join(urllib.parse.quote(seg) for seg in repo_path.split("/"))
        urls.append(f"{FLUENT_RAW_BASE}{encoded}")
    urls.append(NOTO_FALLBACK.format(cp=_char_to_cp(char)))

    for url in urls:
        try:
            r = requests.get(url, timeout=15)
            if r.status_code == 200 and len(r.content) > 256:
                img = Image.open(BytesIO(r.content)).convert("RGBA")
                if img.size != (TARGET_SIZE, TARGET_SIZE):
                    img = img.resize((TARGET_SIZE, TARGET_SIZE), Image.Resampling.LANCZOS)
                img.save(dest, format="PNG", optimize=True)
                return {
                    "id": emoji_id,
                    "label": label,
                    "category": category,
                    "char": char,
                    "url": f"/assets/emojis/{emoji_id}.png",
                }
        except Exception:
            continue
    return None


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ANDROID_OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Fetch Fluent UI Emoji tree + license
    try:
        tree_map = _fetch_fluent_tree_map()
    except Exception as exc:
        print(f"WARNING: Could not fetch Fluent UI Emoji tree ({exc})")
        tree_map = {}

    if tree_map:
        try:
            lic_resp = requests.get(FLUENT_LICENSE_URL, timeout=15)
            if lic_resp.status_code == 200:
                (OUT_DIR / "LICENSE-FLUENT-EMOJI.txt").write_text(lic_resp.text, encoding="utf-8")
        except Exception as exc:
            print(f"WARNING: Could not download Fluent LICENSE: {exc}")

    # Download concurrently preserving EMOJI_PACK order
    results_by_id: Dict[str, Dict[str, str]] = {}
    with ThreadPoolExecutor(max_workers=12) as pool:
        futures = {pool.submit(_download_one, entry, tree_map, OUT_DIR): entry[0] for entry in EMOJI_PACK}
        for fut in as_completed(futures):
            eid = futures[fut]
            res = fut.result()
            if res:
                results_by_id[eid] = res
                print(f"  [OK] {eid}")
            else:
                print(f"  [FAIL] {eid}")

    downloaded = [results_by_id[e[0]] for e in EMOJI_PACK if e[0] in results_by_id]
    manifest = {
        "pack": "Microsoft Fluent UI Emoji 3D (MIT)",
        "size": TARGET_SIZE,
        "emojis": downloaded,
    }
    (OUT_DIR / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    # Sync cleanly to Android APK assets
    for fname in ("manifest.json", "LICENSE-FLUENT-EMOJI.txt"):
        src = OUT_DIR / fname
        if src.exists():
            shutil.copy2(src, ANDROID_OUT_DIR / fname)
    for item in downloaded:
        src = OUT_DIR / f"{item['id']}.png"
        if src.exists():
            shutil.copy2(src, ANDROID_OUT_DIR / f"{item['id']}.png")

    print(f"\nBuilt {len(downloaded)}/{len(EMOJI_PACK)} 3D Fluent UI emoji PNGs into {OUT_DIR} and {ANDROID_OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
