"""
One-command Android 16 (API 36) APK builder for Frame Studio.

Syncs static/ web assets (including offline mobile-engine.js, real 256x256
Noto Color Emoji PNGs, and bundled TrueType fonts) into the pure-SDK Android
project, compiles resources + Java + DEX with Android SDK 36 build-tools,
aligns with 16KB page boundaries (-P 16), and signs FrameStudio-Android.apk.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Optional

from PIL import Image, ImageDraw

ROOT_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT_DIR / "static"
ANDROID_DIR = ROOT_DIR / "android"
APP_DIR = ANDROID_DIR / "app"
MAIN_DIR = APP_DIR / "src" / "main"
ASSETS_STATIC_DIR = MAIN_DIR / "assets" / "static"
RES_DIR = MAIN_DIR / "res"
BUILD_DIR = ANDROID_DIR / "build" / "cli_apk"
OUTPUT_APK = ROOT_DIR / "FrameStudio-Android.apk"


def find_sdk_root() -> Path:
    candidates = [
        os.environ.get("ANDROID_HOME"),
        os.environ.get("ANDROID_SDK_ROOT"),
        str(Path.home() / "AppData" / "Local" / "Android" / "Sdk"),
    ]
    for cand in candidates:
        if cand and Path(cand).is_dir():
            return Path(cand)
    raise RuntimeError("Android SDK not found. Set ANDROID_HOME or install Android SDK 36.")


def find_build_tools_dir(sdk_root: Path) -> Path:
    bt_root = sdk_root / "build-tools"
    if not bt_root.is_dir():
        raise RuntimeError(f"Missing Android build-tools directory: {bt_root}")
    versions = sorted((p for p in bt_root.iterdir() if p.is_dir()), key=lambda p: p.name, reverse=True)
    for ver in versions:
        if (ver / "aapt2.exe").exists() or (ver / "aapt2").exists():
            return ver
    raise RuntimeError(f"No valid build-tools version found in {bt_root}")


def find_platform_jar(sdk_root: Path) -> Path:
    for api in ("android-36", "android-35", "android-37.0"):
        jar = sdk_root / "platforms" / api / "android.jar"
        if jar.exists():
            return jar
    platforms_dir = sdk_root / "platforms"
    for p in sorted(platforms_dir.iterdir(), reverse=True):
        jar = p / "android.jar"
        if jar.exists():
            return jar
    raise RuntimeError(f"No android.jar found under {platforms_dir}")


def find_jdk_bin() -> Path:
    candidates = [
        os.environ.get("JAVA_HOME"),
        str(Path.home() / ".jdks" / "jbr-21.0.11"),
        r"C:\Program Files\Android\Android Studio\jbr",
    ]
    for jd in candidates:
        if jd and (Path(jd) / "bin" / "javac.exe").exists():
            return Path(jd) / "bin"
    which_javac = shutil.which("javac")
    if which_javac:
        return Path(which_javac).parent
    raise RuntimeError("JDK 11+ (javac) not found. Install Android Studio JBR or set JAVA_HOME.")


def tool_path(directory: Path, stem: str) -> str:
    for suffix in (".exe", ".bat", ""):
        candidate = directory / f"{stem}{suffix}"
        if candidate.exists():
            return str(candidate)
    raise FileNotFoundError(f"Tool not found: {directory / stem}")


def run_cmd(cmd: list[str], env: Optional[dict[str, str]] = None, cwd: Optional[Path] = None) -> None:
    print("+", " ".join(str(c) for c in cmd))
    result = subprocess.run(cmd, env=env, cwd=str(cwd) if cwd else None, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Command failed with exit code {result.returncode}: {' '.join(cmd)}")


def generate_launcher_icons() -> None:
    densities = {
        "mipmap-mdpi": 48,
        "mipmap-hdpi": 72,
        "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144,
        "mipmap-xxxhdpi": 192,
    }
    for folder, size in densities.items():
        out_dir = RES_DIR / folder
        out_dir.mkdir(parents=True, exist_ok=True)
        img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        pad = max(2, round(size * 0.06))
        radius = max(8, round(size * 0.24))
        draw.rounded_rectangle(
            [pad, pad, size - pad - 1, size - pad - 1],
            radius=radius,
            fill=(15, 23, 42, 255),
            outline=(99, 102, 241, 255),
            width=max(2, round(size * 0.05)),
        )
        # Inner aperture ring / badge accent
        c_pad = round(size * 0.25)
        draw.rounded_rectangle(
            [c_pad, c_pad, size - c_pad - 1, size - c_pad - 1],
            radius=max(4, round(size * 0.10)),
            fill=(34, 211, 238, 255),
        )
        i_pad = round(size * 0.36)
        draw.ellipse(
            [i_pad, i_pad, size - i_pad - 1, size - i_pad - 1],
            fill=(15, 23, 42, 255),
        )
        img.save(out_dir / "ic_launcher.png", "PNG")


def sync_static_assets() -> None:
    emoji_manifest = STATIC_DIR / "assets" / "emojis" / "manifest.json"
    if not emoji_manifest.exists():
        run_cmd([sys.executable, str(ROOT_DIR / "tools" / "build_emoji_pack.py")], cwd=ROOT_DIR)

    if ASSETS_STATIC_DIR.exists():
        shutil.rmtree(ASSETS_STATIC_DIR)
    shutil.copytree(STATIC_DIR, ASSETS_STATIC_DIR)
    print(f"Synced static assets -> {ASSETS_STATIC_DIR}")


def build_apk() -> Path:
    sdk_root = find_sdk_root()
    bt_dir = find_build_tools_dir(sdk_root)
    android_jar = find_platform_jar(sdk_root)
    jdk_bin = find_jdk_bin()

    env = os.environ.copy()
    env["JAVA_HOME"] = str(jdk_bin.parent)
    env["ANDROID_HOME"] = str(sdk_root)
    env["PATH"] = f"{jdk_bin}{os.pathsep}{bt_dir}{os.pathsep}{env.get('PATH', '')}"

    sync_static_assets()
    generate_launcher_icons()

    if BUILD_DIR.exists():
        shutil.rmtree(BUILD_DIR)
    gen_dir = BUILD_DIR / "gen"
    classes_dir = BUILD_DIR / "classes"
    dex_dir = BUILD_DIR / "dex"
    for d in (gen_dir, classes_dir, dex_dir):
        d.mkdir(parents=True, exist_ok=True)

    res_flat_zip = BUILD_DIR / "res_flat.zip"
    base_res_apk = BUILD_DIR / "base-res.apk"
    unaligned_apk = BUILD_DIR / "app-unaligned.apk"
    aligned_apk = BUILD_DIR / "app-aligned.apk"
    debug_keystore = ANDROID_DIR / "debug.keystore"

    aapt2 = tool_path(bt_dir, "aapt2")
    d8 = tool_path(bt_dir, "d8")
    zipalign = tool_path(bt_dir, "zipalign")
    apksigner = tool_path(bt_dir, "apksigner")
    javac = tool_path(jdk_bin, "javac")
    keytool = tool_path(jdk_bin, "keytool")

    # 1. Compile resources
    run_cmd([aapt2, "compile", "--dir", str(RES_DIR), "-o", str(res_flat_zip)], env=env)

    # 2. Link resources + AndroidManifest into base-res APK (omit -A so Windows backslashes never enter ZIP local headers)
    run_cmd(
        [
            aapt2,
            "link",
            "-I",
            str(android_jar),
            "--manifest",
            str(MAIN_DIR / "AndroidManifest.xml"),
            "--min-sdk-version",
            "26",
            "--target-sdk-version",
            "36",
            "--version-code",
            "1",
            "--version-name",
            "1.0.0",
            "--java",
            str(gen_dir),
            "-o",
            str(base_res_apk),
            "--auto-add-overlay",
            str(res_flat_zip),
        ],
        env=env,
    )

    # 3. Compile Java sources (MainActivity.java + generated R.java)
    java_files = [str(p) for p in (MAIN_DIR / "java").rglob("*.java")] + [
        str(p) for p in gen_dir.rglob("*.java")
    ]
    run_cmd(
        [
            javac,
            "--release",
            "11",
            "-classpath",
            str(android_jar),
            "-d",
            str(classes_dir),
            *java_files,
        ],
        env=env,
    )

    # 4. Compile JVM bytecode to Android DEX via d8
    class_files = [str(p) for p in classes_dir.rglob("*.class")]
    run_cmd(
        [
            d8,
            "--min-api",
            "26",
            "--lib",
            str(android_jar),
            "--output",
            str(dex_dir),
            *class_files,
        ],
        env=env,
    )

    # 5. Assemble clean APK with forward-slash ZIP paths and uncompressed classes.dex / resources.arsc / binary media
    no_compress_exts = {".png", ".jpg", ".jpeg", ".webp", ".ttf", ".woff2"}
    with zipfile.ZipFile(unaligned_apk, "w") as out_zf:
        with zipfile.ZipFile(base_res_apk, "r") as res_zf:
            for item in res_zf.infolist():
                norm_name = item.filename.replace("\\", "/")
                data = res_zf.read(item.filename)
                zi = zipfile.ZipInfo(filename=norm_name, date_time=(2026, 1, 1, 0, 0, 0))
                zi.create_system = 0
                is_raw = norm_name == "resources.arsc" or Path(norm_name).suffix.lower() in no_compress_exts
                zi.compress_type = zipfile.ZIP_STORED if is_raw else zipfile.ZIP_DEFLATED
                out_zf.writestr(zi, data)

        for dex_file in sorted(dex_dir.glob("*.dex")):
            zi = zipfile.ZipInfo(filename=dex_file.name, date_time=(2026, 1, 1, 0, 0, 0))
            zi.create_system = 0
            zi.compress_type = zipfile.ZIP_STORED
            out_zf.writestr(zi, dex_file.read_bytes())

        for asset_file in sorted(STATIC_DIR.rglob("*")):
            if not asset_file.is_file():
                continue
            rel_posix = asset_file.relative_to(STATIC_DIR).as_posix()
            arc_name = f"assets/static/{rel_posix}"
            zi = zipfile.ZipInfo(filename=arc_name, date_time=(2026, 1, 1, 0, 0, 0))
            zi.create_system = 0
            zi.compress_type = (
                zipfile.ZIP_STORED
                if asset_file.suffix.lower() in no_compress_exts
                else zipfile.ZIP_DEFLATED
            )
            out_zf.writestr(zi, asset_file.read_bytes())

    # 6. Align with 16KB page boundaries for Android 16
    run_cmd([zipalign, "-P", "16", "-f", "4", str(unaligned_apk), str(aligned_apk)], env=env)

    # 7. Ensure debug keystore exists
    if not debug_keystore.exists():
        run_cmd(
            [
                keytool,
                "-genkeypair",
                "-v",
                "-keystore",
                str(debug_keystore),
                "-alias",
                "androiddebugkey",
                "-keyalg",
                "RSA",
                "-keysize",
                "2048",
                "-validity",
                "10000",
                "-storepass",
                "android",
                "-keypass",
                "android",
                "-dname",
                "CN=Android Debug,O=Android,C=US",
            ],
            env=env,
        )

    # 8. Sign and verify FrameStudio-Android.apk
    if OUTPUT_APK.exists():
        OUTPUT_APK.unlink()
    run_cmd(
        [
            apksigner,
            "sign",
            "--ks",
            str(debug_keystore),
            "--ks-key-alias",
            "androiddebugkey",
            "--ks-pass",
            "pass:android",
            "--key-pass",
            "pass:android",
            "--out",
            str(OUTPUT_APK),
            str(aligned_apk),
        ],
        env=env,
    )
    run_cmd([apksigner, "verify", "--print-certs", str(OUTPUT_APK)], env=env)

    size_mb = OUTPUT_APK.stat().st_size / (1024 * 1024)
    print(f"Built signed Android 16 APK: {OUTPUT_APK} ({size_mb:.2f} MB)")
    return OUTPUT_APK


if __name__ == "__main__":
    build_apk()
