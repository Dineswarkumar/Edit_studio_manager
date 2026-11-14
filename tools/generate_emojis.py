import os
import math
from PIL import Image, ImageDraw, ImageFont

ASSETS_DIR = r"T:\Mods\watermarkmaker\static\assets\emojis"
os.makedirs(ASSETS_DIR, exist_ok=True)

def create_cool_sunglasses(size=256):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Face
    d.ellipse([16, 16, size-16, size-16], fill="#FFD034", outline="#D49B00", width=6)
    # Sunglasses frame
    d.polygon([(40, 90), (120, 90), (110, 145), (50, 145)], fill="#1E1E24")
    d.polygon([(136, 90), (216, 90), (206, 145), (146, 145)], fill="#1E1E24")
    d.line([(110, 105), (140, 105)], fill="#1E1E24", width=8)
    # Gloss on lenses
    d.line([(55, 100), (95, 135)], fill="#FFFFFF", width=4)
    d.line([(150, 100), (190, 135)], fill="#FFFFFF", width=4)
    # Smirk
    d.arc([80, 150, 176, 210], start=20, end=160, fill="#7A4B00", width=7)
    img.save(os.path.join(ASSETS_DIR, "sunglasses.png"), "PNG")

def create_smiley(size=256):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Face
    d.ellipse([16, 16, size-16, size-16], fill="#FFD034", outline="#D49B00", width=6)
    # Eyes
    d.ellipse([65, 80, 95, 125], fill="#4A3000")
    d.ellipse([161, 80, 191, 125], fill="#4A3000")
    # Big smile
    d.chord([60, 110, 196, 205], start=0, end=180, fill="#FFFFFF", outline="#7A4B00", width=6)
    d.line([58, 158, 198, 158], fill="#7A4B00", width=6)
    img.save(os.path.join(ASSETS_DIR, "smiley.png"), "PNG")

def create_clown(size=256):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # White face
    d.ellipse([16, 16, size-16, size-16], fill="#F4F4F8", outline="#C0C0D0", width=6)
    # Blue star eyes
    d.ellipse([65, 75, 95, 115], fill="#2B7FFF")
    d.ellipse([161, 75, 191, 115], fill="#2B7FFF")
    # Red bulb nose
    d.ellipse([108, 108, 148, 148], fill="#FF2B2B", outline="#D00000", width=3)
    # Huge smile
    d.chord([50, 130, 206, 215], start=0, end=180, fill="#FF2B2B", outline="#900000", width=5)
    img.save(os.path.join(ASSETS_DIR, "clown.png"), "PNG")

def create_censored_stamp(size=256):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Black tape bar
    d.rectangle([10, 90, size-10, 166], fill="#111111", outline="#E50914", width=4)
    # Text CENSORED
    d.text((size//2, size//2), "CENSORED", fill="#FFFFFF", anchor="mm", font_size=32)
    img.save(os.path.join(ASSETS_DIR, "censored.png"), "PNG")

def create_poop(size=256):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Swirls
    d.ellipse([30, 150, 226, 230], fill="#8B4513", outline="#5C2D0C", width=5)
    d.ellipse([50, 95, 206, 175], fill="#8B4513", outline="#5C2D0C", width=5)
    d.ellipse([75, 45, 181, 120], fill="#8B4513", outline="#5C2D0C", width=5)
    # Big eyes
    d.ellipse([70, 110, 106, 150], fill="#FFFFFF", outline="#000000", width=3)
    d.ellipse([150, 110, 186, 150], fill="#FFFFFF", outline="#000000", width=3)
    d.ellipse([82, 122, 98, 138], fill="#000000")
    d.ellipse([158, 122, 174, 138], fill="#000000")
    # Smile
    d.chord([95, 145, 161, 195], start=0, end=180, fill="#FFFFFF", outline="#000000", width=3)
    img.save(os.path.join(ASSETS_DIR, "poop.png"), "PNG")

def create_extra_stickers(size=256):
    """Draw a few additional transparent face stickers used by the privacy editor."""
    # Heart eyes
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([18, 18, 238, 238], fill="#FFD34D", outline="#D99A12", width=6)
    d.polygon([(58, 83), (74, 65), (91, 65), (103, 82), (116, 65), (134, 65), (150, 83), (104, 128)], fill="#F43F73")
    d.polygon([(138, 83), (154, 65), (171, 65), (183, 82), (196, 65), (214, 65), (230, 83), (184, 128)], fill="#F43F73")
    d.arc([70, 120, 190, 205], start=15, end=165, fill="#704214", width=8)
    img.save(os.path.join(ASSETS_DIR, "heart_eyes.png"), "PNG")

    # Cat face
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.polygon([(35, 95), (42, 22), (103, 62), (153, 62), (214, 22), (221, 95), (228, 151), (202, 211), (128, 238), (54, 211), (28, 151)], fill="#F3A94B", outline="#9D5B20")
    d.ellipse([68, 102, 96, 140], fill="#3B2A1C")
    d.ellipse([160, 102, 188, 140], fill="#3B2A1C")
    d.polygon([(115, 150), (141, 150), (128, 166)], fill="#E66C75")
    d.arc([84, 151, 128, 193], start=5, end=90, fill="#55321E", width=4)
    d.arc([128, 151, 172, 193], start=90, end=175, fill="#55321E", width=4)
    d.line([(37, 155), (94, 164)], fill="#55321E", width=3)
    d.line([(162, 164), (219, 155)], fill="#55321E", width=3)
    img.save(os.path.join(ASSETS_DIR, "cat.png"), "PNG")

    # Alien face
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([30, 16, 226, 240], fill="#79E36A", outline="#279447", width=7)
    d.ellipse([56, 78, 112, 153], fill="#152A3B")
    d.ellipse([144, 78, 200, 153], fill="#152A3B")
    d.ellipse([70, 89, 88, 111], fill="#FFFFFF")
    d.ellipse([158, 89, 176, 111], fill="#FFFFFF")
    d.arc([83, 147, 173, 206], start=15, end=165, fill="#277C42", width=7)
    img.save(os.path.join(ASSETS_DIR, "alien.png"), "PNG")

    # Friendly robot
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.line([(128, 18), (128, 42)], fill="#68758A", width=8)
    d.ellipse([116, 8, 140, 32], fill="#3D8BFF")
    d.rounded_rectangle([26, 42, 230, 220], radius=42, fill="#C9D3E0", outline="#64748B", width=8)
    d.rounded_rectangle([50, 72, 206, 158], radius=25, fill="#152235")
    d.ellipse([76, 98, 104, 130], fill="#67E8F9")
    d.ellipse([152, 98, 180, 130], fill="#67E8F9")
    d.rounded_rectangle([91, 174, 165, 190], radius=8, fill="#3D8BFF")
    d.line([(24, 101), (8, 101)], fill="#64748B", width=8)
    d.line([(232, 101), (248, 101)], fill="#64748B", width=8)
    img.save(os.path.join(ASSETS_DIR, "robot.png"), "PNG")

if __name__ == "__main__":
    create_cool_sunglasses()
    create_smiley()
    create_clown()
    create_censored_stamp()
    create_poop()
    create_extra_stickers()
    print("Emojis generated successfully in", ASSETS_DIR)
