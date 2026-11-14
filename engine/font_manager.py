import os
from PIL import ImageFont

FONT_MAP = {
    "arial": "arial.ttf",
    "arial bold": "arialbd.ttf",
    "arial black": "ariblk.ttf",
    "arial black bold": "ariblk.ttf",
    "segoe ui": "segoeui.ttf",
    "segoe ui bold": "segoeuib.ttf",
    "impact": "impact.ttf",
    "times new roman": "times.ttf",
    "times new roman bold": "timesbd.ttf",
    "calibri": "calibri.ttf",
    "calibri bold": "calibrib.ttf",
    "consolas": "consola.ttf",
    "consolas bold": "consolab.ttf",
    "courier new": "cour.ttf",
    "courier new bold": "courbd.ttf",
    "georgia": "georgia.ttf",
    "georgia bold": "georgiab.ttf",
    "verdana": "verdana.ttf",
    "verdana bold": "verdanab.ttf",
    "trebuchet ms": "trebuc.ttf",
    "trebuchet ms bold": "trebucbd.ttf"
}

WINDOWS_FONTS_DIR = os.environ.get("WINDIR", "C:\\Windows") + "\\Fonts"

def get_font(family: str = "Arial", size: int = 36, bold: bool = False) -> ImageFont.FreeTypeFont:
    name = family.strip().lower()
    if bold:
        name = f"{name} bold"
        
    font_file = FONT_MAP.get(name) or FONT_MAP.get(family.strip().lower())
    
    if font_file:
        full_path = os.path.join(WINDOWS_FONTS_DIR, font_file)
        if os.path.exists(full_path):
            try:
                return ImageFont.truetype(full_path, size=size)
            except Exception:
                pass
                
    # Direct try with family as file or fallback to arial
    fallback_arial = os.path.join(WINDOWS_FONTS_DIR, "arial.ttf")
    if os.path.exists(fallback_arial):
        try:
            return ImageFont.truetype(fallback_arial, size=size)
        except Exception:
            pass

    return ImageFont.load_default()
