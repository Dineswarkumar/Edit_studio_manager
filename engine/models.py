from typing import List, Optional, Literal
from pydantic import BaseModel, Field

PositionType = Literal[
    "top-left", "top-center", "top-right",
    "middle-left", "center", "middle-right",
    "bottom-left", "bottom-center", "bottom-right",
    "custom"
]

class WatermarkLayer(BaseModel):
    id: str = "layer_1"
    layer_type: Literal["text", "image"] = "text"
    enabled: bool = True
    
    # Common layout
    layout_mode: Literal["single", "tiled"] = "single"
    position: PositionType = "bottom-right"
    custom_x: float = 0.5  # Normalized 0.0 - 1.0
    custom_y: float = 0.5  # Normalized 0.0 - 1.0
    margin_x: int = 24     # Margins for 9-grid positions
    margin_y: int = 24
    rotation: float = 0.0  # Degrees
    opacity: float = 0.8   # 0.0 - 1.0
    
    # Tiled mode settings
    tile_spacing_x: int = 160
    tile_spacing_y: int = 120
    tile_stagger: bool = True
    
    # Text specific settings
    text: str = "Watermark Studio"
    font_family: str = "Arial"
    font_size: int = 36
    font_bold: bool = False
    color: str = "#ffffff"
    shadow_enabled: bool = True
    shadow_color: str = "#000000"
    shadow_offset: int = 2
    
    bg_enabled: bool = False
    bg_color: str = "#000000"
    bg_opacity: float = 0.5
    bg_padding: int = 8
    bg_radius: int = 6
    
    # Image specific settings
    image_filename: Optional[str] = None
    scale_percent: float = 15.0 # percentage of base media width

class ExportSettings(BaseModel):
    # Mode: Apply watermark + compress, or standalone compress only (no watermark)
    mode: Literal["watermark_and_compress", "compress_only"] = "watermark_and_compress"
    
    # Video compression
    video_preset: Literal["master", "balanced", "compressed"] = "balanced" # master (CRF 18), balanced (CRF 23), compressed (CRF 28)
    video_resolution: Literal["original", "1080p", "720p", "480p"] = "original"
    
    # Image compression
    image_quality: int = 85 # 60 - 95

class WatermarkConfig(BaseModel):
    layers: List[WatermarkLayer] = Field(default_factory=list)
    export_settings: ExportSettings = Field(default_factory=ExportSettings)
