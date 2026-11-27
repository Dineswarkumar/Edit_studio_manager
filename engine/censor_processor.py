"""
Censor & Privacy Studio Pro - Diversified Engine
Supports:
1. Multi-Face Tracking (All people) & Single Face Focus (Specific person).
2. NSFW / Sensitive Content Region Detector.
3. Specific Object Detection & Motion Tracking (TrackerMIL for license plates, logos, documents).
4. Safe I/O for Windows (safe_imread, safe_imwrite) and resilient video export.
"""

import os
import math
import shutil
import subprocess
from dataclasses import dataclass, field
from typing import List, Tuple, Dict, Optional, Literal, Callable, Set
import numpy as np
import cv2
import threading

# Path to local YuNet & NudeNet ONNX models
MODEL_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models")
YUNET_PATH = os.path.join(MODEL_DIR, "face_detection_yunet_2023mar.onnx")
NUDENET_PATH = os.path.join(MODEL_DIR, "320n.onnx")
EMOJI_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "assets", "emojis")

NUDENET_LABELS: Tuple[str, ...] = (
    "FEMALE_GENITALIA_COVERED",
    "FACE_FEMALE",
    "BUTTOCKS_EXPOSED",
    "FEMALE_BREAST_EXPOSED",
    "FEMALE_GENITALIA_EXPOSED",
    "MALE_BREAST_EXPOSED",
    "ANUS_EXPOSED",
    "FEET_EXPOSED",
    "BELLY_COVERED",
    "FEET_COVERED",
    "ARMPITS_COVERED",
    "ARMPITS_EXPOSED",
    "FACE_MALE",
    "BELLY_EXPOSED",
    "MALE_GENITALIA_EXPOSED",
    "ANUS_COVERED",
    "FEMALE_BREAST_COVERED",
    "BUTTOCKS_COVERED",
)

DEFAULT_NSFW_CLASSES: Tuple[str, ...] = (
    "FEMALE_GENITALIA_EXPOSED",
    "MALE_GENITALIA_EXPOSED",
    "FEMALE_BREAST_EXPOSED",
    "BUTTOCKS_EXPOSED",
    "ANUS_EXPOSED",
)

NUDENET_FACE_CLASSES: Set[str] = {"FACE_FEMALE", "FACE_MALE"}


def safe_imread(path: str) -> Optional[np.ndarray]:
    """Reads image safely on Windows even with Unicode or special characters in path."""
    if not os.path.exists(path):
        return None
    try:
        with open(path, "rb") as f:
            bytes_data = np.frombuffer(f.read(), dtype=np.uint8)
        img = cv2.imdecode(bytes_data, cv2.IMREAD_COLOR)
        if img is not None:
            return img
    except Exception:
        pass
    return cv2.imread(path)


def safe_imwrite(path: str, img: np.ndarray) -> bool:
    """Writes image safely on Windows without path encoding errors."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    ext = os.path.splitext(path)[1] or ".jpg"
    try:
        is_success, buffer = cv2.imencode(ext, img)
        if is_success:
            with open(path, "wb") as f:
                f.write(buffer)
            return True
    except Exception:
        pass
    return bool(cv2.imwrite(path, img))


@dataclass
class BoundingBox:
    x: int
    y: int
    w: int
    h: int
    confidence: float = 1.0
    landmarks: Optional[List[Tuple[float, float]]] = None
    track_id: Optional[int] = None
    label: str = "Face"
    kind: str = "box"
    brush_points: Optional[List[Tuple[float, float]]] = None
    brush_radius: float = 24.0
    eraser_points: Optional[List[Tuple[float, float]]] = None
    eraser_radius: float = 24.0
    mask_type: Optional[str] = None
    start_sec: Optional[float] = None
    end_sec: Optional[float] = None

    @property
    def x2(self) -> int:
        return self.x + self.w

    @property
    def y2(self) -> int:
        return self.y + self.h

    @property
    def center(self) -> Tuple[float, float]:
        return (self.x + self.w / 2.0, self.y + self.h / 2.0)

    @property
    def area(self) -> float:
        return float(self.w * self.h)

    def to_dict(self) -> dict:
        data = {
            "x": int(self.x),
            "y": int(self.y),
            "w": int(self.w),
            "h": int(self.h),
            "confidence": round(float(self.confidence), 3),
            "track_id": self.track_id,
            "label": self.label,
            "landmarks": [[round(float(x), 2), round(float(y), 2)] for x, y in (self.landmarks or [])],
        }
        if self.kind != "box":
            data["kind"] = self.kind
        if self.brush_points:
            data["brush_points"] = [[round(float(px), 2), round(float(py), 2)] for px, py in self.brush_points]
            data["brush_radius"] = round(float(self.brush_radius), 2)
        if self.eraser_points:
            data["eraser_points"] = [[round(float(px), 2), round(float(py), 2)] for px, py in self.eraser_points]
            data["eraser_radius"] = round(float(self.eraser_radius), 2)
        if self.mask_type:
            data["mask_type"] = self.mask_type
        if self.start_sec is not None:
            data["start_sec"] = round(float(self.start_sec), 3)
        if self.end_sec is not None:
            data["end_sec"] = round(float(self.end_sec), 3)
        return data


@dataclass
class MaskConfig:
    mask_type: Literal["blur", "pixelate", "emoji", "redact"] = "blur"
    intensity: int = 50                 # 1 to 100
    feather: int = 25                   # 0 to 100
    emoji_name: str = "sunglasses"
    custom_sticker_path: Optional[str] = None
    redact_text: Optional[str] = "[CENSORED]"
    shape: Literal["oval", "rect", "circle", "triangle", "heart"] = "oval"
    mask_region: Literal["face", "eyes"] = "face"
    face_fit: Literal["exact", "standard", "loose"] = "standard"
    padding_percent: float = 0.20       # -0.10 to +0.35


def compute_iou(box1: BoundingBox, box2: BoundingBox) -> float:
    """Calculates Intersection-over-Union (IoU) between two bounding boxes."""
    x_left = max(box1.x, box2.x)
    y_top = max(box1.y, box2.y)
    x_right = min(box1.x2, box2.x2)
    y_bottom = min(box1.y2, box2.y2)

    if x_right <= x_left or y_bottom <= y_top:
        return 0.0

    intersection = (x_right - x_left) * (y_bottom - y_top)
    union = box1.area + box2.area - intersection
    if union <= 0:
        return 0.0
    return intersection / union


def compute_center_dist(box1: BoundingBox, box2: BoundingBox) -> float:
    """Calculates Euclidean distance between centers of two boxes."""
    c1 = box1.center
    c2 = box2.center
    return math.hypot(c1[0] - c2[0], c1[1] - c2[1])


_SHARED_DETECTOR_LOCK = threading.Lock()
_SHARED_FACE_DETECTOR: Optional["FaceDetector"] = None


def _get_shared_face_detector() -> "FaceDetector":
    """Returns a cached FaceDetector instance safe for reuse across calls."""
    global _SHARED_FACE_DETECTOR
    with _SHARED_DETECTOR_LOCK:
        if _SHARED_FACE_DETECTOR is None:
            _SHARED_FACE_DETECTOR = FaceDetector()
        return _SHARED_FACE_DETECTOR


def _skin_mask_for_face_filter(img_bgr: np.ndarray) -> np.ndarray:
    """Fast skin mask used solely to reject bare-torso false-positive face detections."""
    ycrcb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2YCrCb)
    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
    mask_ycrcb = cv2.inRange(ycrcb, (40, 134, 78), (250, 172, 126))
    mask_hsv = cv2.inRange(hsv, (0, 38, 60), (23, 195, 255))
    return cv2.bitwise_and(mask_ycrcb, mask_hsv)


class FaceDetector:
    """OpenCV YuNet DNN Face Detector."""

    def __init__(self, model_path: str = YUNET_PATH, score_threshold: float = 0.55):
        self.model_path = model_path
        self.score_threshold = score_threshold
        self._detector: Optional[cv2.FaceDetectorYN] = None
        self._current_size: Optional[Tuple[int, int]] = None
        self._lock = threading.RLock()
        self._load_model()

    def _load_model(self):
        if not os.path.exists(self.model_path):
            raise FileNotFoundError(f"YuNet model not found at {self.model_path}")
        self._detector = cv2.FaceDetectorYN.create(
            self.model_path,
            "",
            (320, 320),
            self.score_threshold,
            0.3,
            5000
        )

    def detect(
        self,
        img_bgr: np.ndarray,
        padding_percent: float = 0.0,
        face_fit: str = "standard",
        check_orientations: bool = True,
    ) -> List[BoundingBox]:
        """
        Detects faces in a BGR image using OpenCV YuNet, automatically checking rotated
        orientations (90/270/180 and oblique tilts) when upright detection finds nothing.
        """
        boxes, _ = self.detect_with_orientation(
            img_bgr,
            padding_percent=padding_percent,
            face_fit=face_fit,
            check_orientations=check_orientations,
        )
        return boxes

    def detect_with_orientation(
        self,
        img_bgr: np.ndarray,
        padding_percent: float = 0.0,
        face_fit: str = "standard",
        check_orientations: bool = True,
        preferred_angle: float = 0.0,
    ) -> Tuple[List[BoundingBox], float]:
        """
        Runs upright detection first and optionally probes rotated/tilted orientations,
        returning (boxes_in_original_coords, matched_angle_deg).
        """
        if img_bgr is None or self._detector is None:
            return [], 0.0

        h_orig, w_orig = img_bgr.shape[:2]
        if w_orig < 10 or h_orig < 10:
            return [], 0.0

        upright = self._detect_single_orientation(img_bgr, padding_percent=padding_percent, face_fit=face_fit)
        if upright:
            return upright, 0.0

        candidate_angles: List[float] = []
        if preferred_angle:
            candidate_angles.append(float(preferred_angle))
        if check_orientations:
            for ang in (*_CARDINAL_ANGLES, *_OBLIQUE_ANGLES):
                if ang not in candidate_angles:
                    candidate_angles.append(ang)

        for angle in candidate_angles:
            rot_img, m_inv = _rotate_image_for_angle(img_bgr, angle)
            probe_limit = 640 if (angle % 90.0) != 0.0 else 960
            rot_boxes = self._detect_single_orientation(
                rot_img,
                padding_percent=padding_percent,
                face_fit=face_fit,
                max_infer_dim=probe_limit,
            )
            if not rot_boxes:
                continue
            mapped_boxes: List[BoundingBox] = []
            for rb in rot_boxes:
                mapped_xywh = _map_box_from_rotation(
                    float(rb.x),
                    float(rb.y),
                    float(rb.w),
                    float(rb.h),
                    angle,
                    w_orig,
                    h_orig,
                    m_inv=m_inv,
                    oblique_shrink=0.88,
                )
                if mapped_xywh is None:
                    continue
                mx, my, mw, mh = mapped_xywh
                mapped_lms = (
                    _map_points_from_rotation(rb.landmarks, angle, w_orig, h_orig, m_inv=m_inv)
                    if rb.landmarks
                    else None
                )
                mapped_boxes.append(
                    BoundingBox(
                        x=max(0, int(round(mx))),
                        y=max(0, int(round(my))),
                        w=max(4, int(round(mw))),
                        h=max(4, int(round(mh))),
                        confidence=rb.confidence,
                        landmarks=mapped_lms,
                        label=rb.label,
                    )
                )
            if mapped_boxes:
                return mapped_boxes, float(angle)

        return [], 0.0

    def _detect_single_orientation(
        self,
        img_bgr: np.ndarray,
        padding_percent: float = 0.0,
        face_fit: str = "standard",
        max_infer_dim: int = 1080,
    ) -> List[BoundingBox]:
        """
        Detects upright faces in a BGR image using OpenCV YuNet, filtering out body/torso
        false positives via geometry, landmark anatomy, and skin-continuity checks.
        `face_fit="exact"` tightens onto only the visible facial area inside frame bounds.
        """
        if img_bgr is None or self._detector is None:
            return []

        h, w = img_bgr.shape[:2]
        if w < 10 or h < 10:
            return []

        max_dim = max(w, h)
        scale = 1.0
        if max_dim > max_infer_dim:
            target_dim = min(960, max_infer_dim)
            scale = float(target_dim) / float(max_dim)
            infer_w = max(16, int(w * scale))
            infer_h = max(16, int(h * scale))
            infer_img = cv2.resize(img_bgr, (infer_w, infer_h), interpolation=cv2.INTER_LINEAR)
        else:
            infer_w, infer_h = w, h
            infer_img = img_bgr

        # FaceDetectorYN keeps mutable input-size state; serialize inference across threads.
        with self._lock:
            if self._current_size != (infer_w, infer_h):
                self._detector.setInputSize((infer_w, infer_h))
                self._current_size = (infer_w, infer_h)
            _, raw_faces = self._detector.detect(infer_img)

        if raw_faces is None or len(raw_faces) == 0:
            return []

        inv_scale = 1.0 / scale
        min_face_dim = max(20, int(min(w, h) * 0.035))
        total_area = float(max(1, w * h))
        skin_mask: Optional[np.ndarray] = None
        boxes: List[BoundingBox] = []

        for face in raw_faces:
            conf = float(face[14])
            if conf < self.score_threshold:
                continue

            bx = float(face[0]) * inv_scale
            by = float(face[1]) * inv_scale
            bw = float(face[2]) * inv_scale
            bh = float(face[3]) * inv_scale

            if bw < min_face_dim or bh < min_face_dim:
                continue

            aspect = bw / float(max(1.0, bh))
            min_aspect = 0.45 if conf >= 0.72 else 0.55
            max_aspect = 1.48 if conf >= 0.72 else 1.38
            if aspect < min_aspect or aspect > max_aspect:
                continue

            area_ratio = (bw * bh) / total_area
            if (area_ratio > 0.35 and conf < 0.88) or (area_ratio > 0.14 and conf < 0.82):
                continue
            if conf < 0.62 and area_ratio > 0.05:
                continue

            landmarks = [
                (float(face[4]) * inv_scale, float(face[5]) * inv_scale),
                (float(face[6]) * inv_scale, float(face[7]) * inv_scale),
                (float(face[8]) * inv_scale, float(face[9]) * inv_scale),
                (float(face[10]) * inv_scale, float(face[11]) * inv_scale),
                (float(face[12]) * inv_scale, float(face[13]) * inv_scale)
            ]

            # Validate 5-point facial landmark geometry in normalized box coordinates
            norm_pts = [((lx - bx) / max(1.0, bw), (ly - by) / max(1.0, bh)) for lx, ly in landmarks]
            if any(px < -0.12 or px > 1.12 or py < -0.12 or py > 1.12 for px, py in norm_pts):
                continue

            (rx, ry), (lx, ly), (nx, ny), (rmx, rmy), (lmx, lmy) = norm_pts
            eye_cy = 0.5 * (ry + ly)
            mouth_cy = 0.5 * (rmy + lmy)
            eye_span = math.hypot(lx - rx, ly - ry)
            mouth_span = math.hypot(lmx - rmx, lmy - rmy)
            eye_tilt = abs(ly - ry) / max(0.05, abs(lx - rx))

            if not (0.12 <= eye_cy <= 0.60):
                continue
            if (mouth_cy - eye_cy) < 0.16:
                continue
            if not (eye_cy - 0.04 <= ny <= mouth_cy + 0.04):
                continue
            if conf < 0.78 and (eye_span < 0.16 or mouth_span < 0.10 or eye_tilt > 0.65):
                continue

            # Reject bare-torso patches where continuous skin fills the box and continues below it
            if conf < 0.74:
                if skin_mask is None:
                    skin_mask = _skin_mask_for_face_filter(img_bgr)
                ix1 = max(0, int(bx))
                iy1 = max(0, int(by))
                ix2 = min(w, int(bx + bw))
                iy2 = min(h, int(by + bh))
                box_roi = skin_mask[iy1:iy2, ix1:ix2]
                if box_roi.size > 0:
                    skin_in = float(np.count_nonzero(box_roi)) / float(box_roi.size)
                    below_y2 = min(h, int(iy2 + bh * 0.60))
                    if below_y2 - iy2 >= 12 and ix2 > ix1:
                        below_roi = skin_mask[iy2:below_y2, ix1:ix2]
                        skin_below = float(np.count_nonzero(below_roi)) / float(below_roi.size)
                        if skin_in >= 0.72 and skin_below >= 0.88:
                            continue

            if face_fit == "exact":
                # Fit tightly around visible face contour using YuNet eye/nose/mouth landmarks
                lm_xs = [pt[0] for pt in landmarks]
                lm_ys = [pt[1] for pt in landmarks]
                lm_cx = 0.5 * (landmarks[0][0] + landmarks[1][0])
                face_top = min(by + bh * 0.04, min(lm_ys) - bh * 0.24)
                face_bot = max(by + bh * 0.92, max(lm_ys) + bh * 0.16)
                half_w = max(bw * 0.44, abs(landmarks[1][0] - landmarks[0][0]) * 1.15)
                tx1 = max(bx, lm_cx - half_w)
                tx2 = min(bx + bw, lm_cx + half_w)
                ty1 = max(by, face_top)
                ty2 = min(by + bh, face_bot)
                # Apply fine user adjustment if padding_percent != 0
                adj = float(padding_percent) * 0.5
                x1 = max(0, int(round(tx1 - bw * adj)))
                y1 = max(0, int(round(ty1 - bh * adj)))
                x2 = min(w, int(round(tx2 + bw * adj)))
                y2 = min(h, int(round(ty2 + bh * adj)))
            elif padding_percent != 0.0:
                pad_w = int(bw * padding_percent)
                pad_h = int(bh * padding_percent)
                top_mult = 1.1 if pad_h >= 0 else 0.75
                bot_mult = 0.5 if pad_h >= 0 else 0.75
                x1 = max(0, int(bx - pad_w))
                y1 = max(0, int(by - pad_h * top_mult))
                x2 = min(w, int(bx + bw + pad_w))
                y2 = min(h, int(by + bh + pad_h * bot_mult))
            else:
                x1 = max(0, int(bx))
                y1 = max(0, int(by))
                x2 = min(w, int(bx + bw))
                y2 = min(h, int(by + bh))

            # Ensure valid positive box inside frame bounds
            if x2 - x1 < 8 or y2 - y1 < 8:
                x1 = max(0, int(bx))
                y1 = max(0, int(by))
                x2 = min(w, int(bx + bw))
                y2 = min(h, int(by + bh))

            boxes.append(BoundingBox(
                x=x1,
                y=y1,
                w=max(4, x2 - x1),
                h=max(4, y2 - y1),
                confidence=round(conf, 3),
                landmarks=landmarks,
                label="Face"
            ))

        # YuNet sometimes returns a second, smaller face box nested inside the
        # main face (commonly around the jaw/phone area). Keep the stronger box
        # when one detection is mostly contained by another.
        kept: List[BoundingBox] = []
        for candidate in sorted(boxes, key=lambda box: box.confidence, reverse=True):
            is_nested_duplicate = False
            for stronger in kept:
                ix1, iy1 = max(candidate.x, stronger.x), max(candidate.y, stronger.y)
                ix2, iy2 = min(candidate.x2, stronger.x2), min(candidate.y2, stronger.y2)
                intersection = max(0, ix2 - ix1) * max(0, iy2 - iy1)
                smaller_area = min(candidate.area, stronger.area)
                if smaller_area > 0 and intersection / smaller_area >= 0.68:
                    is_nested_duplicate = True
                    break
            if not is_nested_duplicate:
                kept.append(candidate)
        return kept


def _extract_band_box(
    skin_mask: np.ndarray,
    x1: int,
    y1: int,
    x2: int,
    y2: int,
    trim_frac: float,
    min_pixels: float,
    label: str,
    confidence: float,
) -> Optional[BoundingBox]:
    """Refines a horizontal torso band to the central active skin core."""
    if y2 - y1 < 14 or x2 - x1 < 14:
        return None
    band = skin_mask[y1:y2, x1:x2]
    col_active = np.flatnonzero(band.sum(axis=0) > 0)
    if len(col_active) < 8:
        return None
    c_min, c_max = int(col_active[0]), int(col_active[-1])
    span_w = c_max - c_min + 1
    trim_px = int(span_w * trim_frac)
    if span_w - 2 * trim_px >= 16:
        c_min += trim_px
        c_max -= trim_px
    sub = band[:, c_min:c_max + 1]
    row_active = np.flatnonzero(sub.sum(axis=1) > 0)
    if len(row_active) < 8:
        return None
    active_pixels = float(np.count_nonzero(sub))
    if active_pixels < min_pixels:
        return None
    r_min, r_max = int(row_active[0]), int(row_active[-1])
    bx1 = x1 + c_min
    by1 = y1 + r_min
    bw = max(12, c_max - c_min + 1)
    bh = max(12, r_max - r_min + 1)
    # Skin segmentation tends to stop at shadows, clothing edges and compression
    # artifacts. Give the actual mask a safety margin so those edges do not expose
    # the sensitive area when it moves between frames.
    pad_x = max(4, int(bw * 0.12))
    pad_y = max(4, int(bh * 0.16))
    bx1 = max(0, bx1 - pad_x)
    by1 = max(0, by1 - pad_y)
    bx2 = min(skin_mask.shape[1], x1 + c_max + 1 + pad_x)
    by2 = min(skin_mask.shape[0], y1 + r_max + 1 + pad_y)
    return BoundingBox(x=bx1, y=by1, w=bx2 - bx1, h=by2 - by1, confidence=confidence, label=label)


_CARDINAL_ANGLES: Tuple[float, ...] = (90.0, 270.0, 180.0)
_OBLIQUE_ANGLES: Tuple[float, ...] = (45.0, -45.0, 35.0, -35.0)


def _rotate_image_for_angle(
    img_bgr: np.ndarray,
    angle_deg: float,
) -> Tuple[np.ndarray, Optional[np.ndarray]]:
    """
    Rotates `img_bgr` by `angle_deg` (cardinal 90/180/270 or arbitrary oblique tilt with
    expanded bounds) and returns `(rotated_bgr, inverse_affine_2x3_or_None)`.
    """
    norm = round(float(angle_deg), 2) % 360.0
    if norm == 0.0:
        return img_bgr, None
    if norm == 90.0:
        return cv2.rotate(img_bgr, cv2.ROTATE_90_CLOCKWISE), None
    if norm == 180.0:
        return cv2.rotate(img_bgr, cv2.ROTATE_180), None
    if norm == 270.0:
        return cv2.rotate(img_bgr, cv2.ROTATE_90_COUNTERCLOCKWISE), None

    h, w = img_bgr.shape[:2]
    center = (w * 0.5, h * 0.5)
    m = cv2.getRotationMatrix2D(center, float(angle_deg), 1.0)
    cos_a = abs(float(m[0, 0]))
    sin_a = abs(float(m[0, 1]))
    new_w = max(8, int(round(h * sin_a + w * cos_a)))
    new_h = max(8, int(round(h * cos_a + w * sin_a)))
    m[0, 2] += (new_w * 0.5) - center[0]
    m[1, 2] += (new_h * 0.5) - center[1]
    rotated = cv2.warpAffine(
        img_bgr,
        m,
        (new_w, new_h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(114, 114, 114),
    )
    m_inv = cv2.invertAffineTransform(m)
    return rotated, m_inv


def _map_points_from_rotation(
    points: List[Tuple[float, float]],
    angle_deg: float,
    orig_w: int,
    orig_h: int,
    m_inv: Optional[np.ndarray] = None,
) -> List[Tuple[float, float]]:
    """Maps 2D points from rotated coordinates back to the original image space."""
    norm = round(float(angle_deg), 2) % 360.0
    if norm == 0.0:
        return list(points)
    fw, fh = float(orig_w), float(orig_h)
    mapped: List[Tuple[float, float]] = []
    if norm == 90.0:
        for rx, ry in points:
            mapped.append((ry, fh - rx))
    elif norm == 180.0:
        for rx, ry in points:
            mapped.append((fw - rx, fh - ry))
    elif norm == 270.0:
        for rx, ry in points:
            mapped.append((fw - ry, rx))
    elif m_inv is not None:
        a00, a01, a02 = float(m_inv[0, 0]), float(m_inv[0, 1]), float(m_inv[0, 2])
        a10, a11, a12 = float(m_inv[1, 0]), float(m_inv[1, 1]), float(m_inv[1, 2])
        for rx, ry in points:
            mapped.append((a00 * rx + a01 * ry + a02, a10 * rx + a11 * ry + a12))
    else:
        return list(points)
    return [(max(0.0, min(fw, ox)), max(0.0, min(fh, oy))) for ox, oy in mapped]


def _map_box_from_rotation(
    rx: float,
    ry: float,
    rw: float,
    rh: float,
    angle_deg: float,
    orig_w: int,
    orig_h: int,
    m_inv: Optional[np.ndarray] = None,
    oblique_shrink: float = 0.85,
) -> Optional[Tuple[float, float, float, float]]:
    """Maps an axis-aligned `[x, y, w, h]` box from rotated space back into original bounds."""
    norm = round(float(angle_deg), 2) % 360.0
    fw, fh = float(orig_w), float(orig_h)
    if norm == 0.0:
        ox, oy, ow, oh = rx, ry, rw, rh
    elif norm == 90.0:
        ox = ry
        oy = fh - (rx + rw)
        ow = rh
        oh = rw
    elif norm == 180.0:
        ox = fw - (rx + rw)
        oy = fh - (ry + rh)
        ow = rw
        oh = rh
    elif norm == 270.0:
        ox = fw - (ry + rh)
        oy = rx
        ow = rh
        oh = rw
    elif m_inv is not None:
        corners = _map_points_from_rotation(
            [(rx, ry), (rx + rw, ry), (rx + rw, ry + rh), (rx, ry + rh)],
            angle_deg,
            orig_w,
            orig_h,
            m_inv=m_inv,
        )
        xs = [pt[0] for pt in corners]
        ys = [pt[1] for pt in corners]
        ax1, ax2 = min(xs), max(xs)
        ay1, ay2 = min(ys), max(ys)
        cx = 0.5 * (ax1 + ax2)
        cy = 0.5 * (ay1 + ay2)
        ow = (ax2 - ax1) * oblique_shrink
        oh = (ay2 - ay1) * oblique_shrink
        ox = cx - ow * 0.5
        oy = cy - oh * 0.5
    else:
        return None

    cx1 = max(0.0, min(fw, ox))
    cy1 = max(0.0, min(fh, oy))
    cx2 = max(0.0, min(fw, ox + ow))
    cy2 = max(0.0, min(fh, oy + oh))
    bw = cx2 - cx1
    bh = cy2 - cy1
    if bw < 8.0 or bh < 8.0:
        return None
    return (cx1, cy1, bw, bh)


def _clip_box_away_from_faces(box: BoundingBox, face_boxes: List[BoundingBox]) -> Optional[BoundingBox]:
    """
    Ensures an NSFW box never overlaps any detected face region by trimming
    along whichever edge preserves the largest valid remainder (handles upright,
    sideways, and upside-down subjects).
    """
    x1, y1, x2, y2 = box.x, box.y, box.x2, box.y2
    for fb in face_boxes:
        horiz_overlap = min(x2, fb.x2) - max(x1, fb.x)
        vert_overlap = min(y2, fb.y2) - max(y1, fb.y)
        if horiz_overlap > 0 and vert_overlap > 0:
            candidates = [
                (x1, max(y1, fb.y2 + 4), x2, y2),   # keep below face
                (x1, y1, x2, min(y2, fb.y - 4)),    # keep above face (upside-down)
                (max(x1, fb.x2 + 4), y1, x2, y2),   # keep right of face (lying)
                (x1, y1, min(x2, fb.x - 4), y2),    # keep left of face (lying)
            ]
            best_cand: Optional[Tuple[int, int, int, int]] = None
            best_area = 0
            for cx1, cy1, cx2, cy2 in candidates:
                cw = cx2 - cx1
                ch = cy2 - cy1
                if cw >= 12 and ch >= 16:
                    area = cw * ch
                    if area > best_area:
                        best_area = area
                        best_cand = (cx1, cy1, cx2, cy2)
            if best_cand is None:
                return None
            x1, y1, x2, y2 = best_cand
    if y2 - y1 < 16 or x2 - x1 < 12:
        return None
    return BoundingBox(
        x=x1,
        y=y1,
        w=x2 - x1,
        h=y2 - y1,
        confidence=box.confidence,
        label=box.label,
    )


def detect_nsfw_candidates(
    img_bgr: np.ndarray,
    sensitivity: float = 0.5,
    face_boxes: Optional[List[BoundingBox]] = None,
) -> List[BoundingBox]:
    """
    Detects candidate sensitive / explicit anatomical zones while strictly
    excluding faces, head/neck regions, and full-frame wall/bedding noise.
    """
    if img_bgr is None:
        return []

    h, w = img_bgr.shape[:2]
    total_area = float(max(1, w * h))

    if face_boxes is None:
        try:
            face_boxes = _get_shared_face_detector().detect(img_bgr, padding_percent=0.10)
        except Exception:
            face_boxes = []

    ycrcb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2YCrCb)
    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)

    skin_mask_ycrcb = cv2.inRange(ycrcb, (40, 134, 78), (250, 172, 126))
    skin_mask_hsv = cv2.inRange(hsv, (0, 38, 60), (23, 195, 255))
    skin_mask = cv2.bitwise_and(skin_mask_ycrcb, skin_mask_hsv)

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    skin_mask = cv2.morphologyEx(skin_mask, cv2.MORPH_OPEN, kernel, iterations=2)
    skin_mask = cv2.morphologyEx(skin_mask, cv2.MORPH_CLOSE, kernel, iterations=1)

    # Strictly carve out head, face, and neck so NSFW censorship never covers faces.
    for fb in face_boxes:
        fx1 = max(0, int(fb.x - fb.w * 0.35))
        fx2 = min(w, int(fb.x2 + fb.w * 0.35))
        fy2 = min(h, int(fb.y + fb.h * 1.25))
        if fx2 > fx1 and fy2 > 0:
            skin_mask[0:fy2, fx1:fx2] = 0

    contours, _ = cv2.findContours(skin_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates: List[BoundingBox] = []

    sensitivity = max(0.0, min(1.0, float(sensitivity)))
    min_area = total_area * max(0.008, 0.055 - sensitivity * 0.042)
    band_min_pixels = total_area * max(0.006, 0.022 - sensitivity * 0.014)

    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < min_area:
            continue

        x, y, bw, bh = cv2.boundingRect(cnt)
        is_large_body = bh >= int(0.40 * h) or (bw * bh) >= int(0.28 * total_area)

        if is_large_body:
            chest_y1 = y + int(0.08 * bh)
            chest_y2 = y + int(0.40 * bh)
            for fb in face_boxes:
                if min(x + bw, fb.x2) > max(x, fb.x):
                    chest_y1 = max(chest_y1, int(fb.y + fb.h * 1.25))
            chest_box = _extract_band_box(
                skin_mask, x, chest_y1, x + bw, chest_y2,
                trim_frac=0.16, min_pixels=band_min_pixels,
                label="NSFW / Chest", confidence=0.88,
            )
            if chest_box:
                clipped = _clip_box_away_from_faces(chest_box, face_boxes)
                if clipped:
                    candidates.append(clipped)

            pelvic_y1 = y + int(0.46 * bh)
            pelvic_y2 = y + int(0.76 * bh)
            pelvic_box = _extract_band_box(
                skin_mask, x, pelvic_y1, x + bw, pelvic_y2,
                trim_frac=0.22, min_pixels=band_min_pixels,
                label="NSFW / Pelvic", confidence=0.90,
            )
            if pelvic_box:
                clipped = _clip_box_away_from_faces(pelvic_box, face_boxes)
                if clipped:
                    candidates.append(clipped)
        else:
            aspect = bw / float(max(1, bh))
            if aspect < 0.30 or aspect > 3.2 or y > int(0.82 * h):
                continue

            skin_ratio = area / max(1.0, float(bw * bh))
            if skin_ratio < 0.42:
                continue

            pad = max(4, int(min(bw, bh) * 0.16))
            x1 = max(0, x - pad)
            y1 = max(0, y - pad)
            x2 = min(w, x + bw + pad)
            y2 = min(h, y + bh + pad)
            conf = min(0.95, round(skin_ratio, 2))
            box = BoundingBox(
                x=x1, y=y1, w=x2 - x1, h=y2 - y1,
                confidence=conf, label="NSFW / Sensitive",
            )
            clipped = _clip_box_away_from_faces(box, face_boxes)
            if clipped:
                candidates.append(clipped)

    return candidates


_SHARED_NUDENET_DETECTOR: Optional["NudeNetDetector"] = None
_SHARED_NUDENET_LOCK = threading.Lock()


def _format_nudenet_label(raw_label: str) -> str:
    pretty = {
        "FEMALE_GENITALIA_EXPOSED": "Genitalia (Exposed)",
        "MALE_GENITALIA_EXPOSED": "Male Genitalia (Exposed)",
        "FEMALE_GENITALIA_COVERED": "Genitalia (Covered)",
        "FEMALE_BREAST_EXPOSED": "Chest / Breast (Exposed)",
        "MALE_BREAST_EXPOSED": "Male Chest (Exposed)",
        "FEMALE_BREAST_COVERED": "Chest (Covered)",
        "BUTTOCKS_EXPOSED": "Buttocks (Exposed)",
        "BUTTOCKS_COVERED": "Buttocks (Covered)",
        "ANUS_EXPOSED": "Anus (Exposed)",
        "ANUS_COVERED": "Anus (Covered)",
        "BELLY_EXPOSED": "Belly (Exposed)",
        "BELLY_COVERED": "Belly (Covered)",
        "ARMPITS_EXPOSED": "Armpits (Exposed)",
        "ARMPITS_COVERED": "Armpits (Covered)",
        "FEET_EXPOSED": "Feet (Exposed)",
        "FEET_COVERED": "Feet (Covered)",
    }
    return f"NudeNet: {pretty.get(raw_label, raw_label.replace('_', ' ').title())}"


class NudeNetDetector:
    """
    Accurate 18-class body-part privacy detector backed by NudeNet v3 ONNX (320n.onnx).
    Always ignores FACE_FEMALE / FACE_MALE so body-part privacy does not duplicate face boxes.
    """

    def __init__(self, model_path: str = NUDENET_PATH, input_size: int = 320):
        self.model_path = model_path
        self.input_size = int(input_size)
        self._session = None
        self._input_name: Optional[str] = None
        self._lock = threading.Lock()
        self._load_attempted = False

    @classmethod
    def is_available(cls, model_path: str = NUDENET_PATH) -> bool:
        if not os.path.isfile(model_path):
            return False
        try:
            import onnxruntime  # noqa: F401
            return True
        except Exception:
            return False

    def _ensure_loaded(self) -> bool:
        if self._session is not None:
            return True
        if self._load_attempted:
            return False
        with self._lock:
            if self._session is not None:
                return True
            if self._load_attempted:
                return False
            self._load_attempted = True
            if not os.path.isfile(self.model_path):
                return False
            try:
                import onnxruntime as ort
                self._session = ort.InferenceSession(self.model_path, providers=["CPUExecutionProvider"])
                self._input_name = self._session.get_inputs()[0].name
                return True
            except Exception as exc:
                print(f"WARNING: Could not load NudeNet ONNX ({self.model_path}): {exc}")
                self._session = None
                return False

    def _infer_single_orientation(
        self,
        img_bgr: np.ndarray,
        conf_threshold: float,
        active_classes: Set[str],
    ) -> Tuple[List[List[float]], List[float], List[str]]:
        h_orig, w_orig = img_bgr.shape[:2]
        max_size = max(w_orig, h_orig)
        x_pad = max_size - w_orig
        y_pad = max_size - h_orig
        mat_pad = cv2.copyMakeBorder(img_bgr, 0, y_pad, 0, x_pad, cv2.BORDER_CONSTANT, value=(0, 0, 0))
        blob = cv2.dnn.blobFromImage(
            mat_pad,
            1.0 / 255.0,
            (self.input_size, self.input_size),
            (0, 0, 0),
            swapRB=True,
            crop=False,
        )

        with self._lock:
            outputs = self._session.run(None, {self._input_name: blob})

        preds = np.transpose(np.squeeze(outputs[0]))
        scores_mat = preds[:, 4:]
        class_ids = np.argmax(scores_mat, axis=1)
        max_scores = scores_mat[np.arange(preds.shape[0]), class_ids]
        keep_mask = max_scores >= conf_threshold
        if not np.any(keep_mask):
            return [], [], []

        scale_x = (w_orig + x_pad) / float(self.input_size)
        scale_y = (h_orig + y_pad) / float(self.input_size)
        boxes_xywh: List[List[float]] = []
        scores: List[float] = []
        kept_labels: List[str] = []

        for row, cid, score in zip(preds[keep_mask], class_ids[keep_mask], max_scores[keep_mask]):
            cls_name = NUDENET_LABELS[int(cid)]
            if cls_name not in active_classes:
                continue
            cx, cy, bw, bh = float(row[0]), float(row[1]), float(row[2]), float(row[3])
            x = max(0.0, min((cx - bw * 0.5) * scale_x, float(w_orig)))
            y = max(0.0, min((cy - bh * 0.5) * scale_y, float(h_orig)))
            bw_scaled = min(bw * scale_x, float(w_orig) - x)
            bh_scaled = min(bh * scale_y, float(h_orig) - y)
            if bw_scaled < 8 or bh_scaled < 8:
                continue
            boxes_xywh.append([x, y, bw_scaled, bh_scaled])
            scores.append(float(score))
            kept_labels.append(cls_name)
        return boxes_xywh, scores, kept_labels

    def _run_angle_into(
        self,
        img_bgr: np.ndarray,
        angle_deg: float,
        conf_threshold: float,
        active_classes: Set[str],
        boxes_xywh: List[List[float]],
        scores: List[float],
        kept_labels: List[str],
    ) -> Tuple[int, float]:
        """Runs single-pass inference at `angle_deg`, remapping hits into original image coords."""
        h_orig, w_orig = img_bgr.shape[:2]
        rot_img, m_inv = _rotate_image_for_angle(img_bgr, angle_deg)
        raw_boxes, raw_scores, raw_labels = self._infer_single_orientation(rot_img, conf_threshold, active_classes)
        added = 0
        score_sum = 0.0
        for (rx, ry, rw, rh), sc, lbl in zip(raw_boxes, raw_scores, raw_labels):
            mapped = _map_box_from_rotation(
                rx, ry, rw, rh, angle_deg, w_orig, h_orig, m_inv=m_inv, oblique_shrink=0.85
            )
            if mapped is None:
                continue
            boxes_xywh.append(list(mapped))
            scores.append(sc)
            kept_labels.append(lbl)
            added += 1
            score_sum += sc
        return added, score_sum

    def detect_with_orientation(
        self,
        img_bgr: np.ndarray,
        sensitivity: float = 0.5,
        allowed_classes: Optional[List[str]] = None,
        face_boxes: Optional[List[BoundingBox]] = None,
        check_orientations: bool = False,
        preferred_angle: float = 0.0,
    ) -> Tuple[List[BoundingBox], float]:
        """
        Detects requested NudeNet body classes, probing preferred, cardinal (90/270/180),
        and oblique tilt angles when needed, returning `(boxes, best_angle_deg)`.
        """
        if img_bgr is None or not self._ensure_loaded() or self._session is None:
            return [], 0.0

        h_orig, w_orig = img_bgr.shape[:2]
        if h_orig < 8 or w_orig < 8:
            return [], 0.0

        active_classes = set(allowed_classes) if allowed_classes is not None else set(DEFAULT_NSFW_CLASSES)
        active_classes -= NUDENET_FACE_CLASSES
        if not active_classes:
            return [], 0.0

        # Sensitivity 0..1 maps inversely to confidence threshold (higher sensitivity = lower threshold)
        sens = max(0.0, min(1.0, float(sensitivity)))
        conf_threshold = max(0.16, min(0.62, 0.54 - sens * 0.34))

        boxes_xywh, scores, kept_labels = self._infer_single_orientation(img_bgr, conf_threshold, active_classes)
        tried: Set[float] = {0.0}
        best_angle = 0.0
        best_score_sum = sum(scores) if boxes_xywh else 0.0

        pref = round(float(preferred_angle), 2)
        if pref and (pref % 360.0) != 0.0 and (not boxes_xywh or (check_orientations and sens >= 0.60 and len(boxes_xywh) < 2)):
            tried.add(pref % 360.0)
            added, sc_sum = self._run_angle_into(
                img_bgr, pref, conf_threshold, active_classes, boxes_xywh, scores, kept_labels
            )
            if added > 0 and sc_sum > best_score_sum:
                best_angle = pref
                best_score_sum = sc_sum

        # Recover lying-down, upside-down, and tilted poses when upright detection misses or yields few hits
        if check_orientations:
            need_cardinal = (not boxes_xywh) or (sens >= 0.60 and len(boxes_xywh) < 2)
            if need_cardinal:
                for ang in _CARDINAL_ANGLES:
                    if (ang % 360.0) in tried:
                        continue
                    tried.add(ang % 360.0)
                    added, sc_sum = self._run_angle_into(
                        img_bgr, ang, conf_threshold, active_classes, boxes_xywh, scores, kept_labels
                    )
                    if added > 0 and sc_sum > best_score_sum:
                        best_angle = ang
                        best_score_sum = sc_sum

            if not boxes_xywh:
                for ang in _OBLIQUE_ANGLES:
                    if (ang % 360.0) in tried:
                        continue
                    tried.add(ang % 360.0)
                    added, sc_sum = self._run_angle_into(
                        img_bgr, ang, conf_threshold, active_classes, boxes_xywh, scores, kept_labels
                    )
                    if added > 0:
                        if sc_sum > best_score_sum:
                            best_angle = ang
                            best_score_sum = sc_sum
                        break

        if not boxes_xywh:
            return [], best_angle

        indices = cv2.dnn.NMSBoxes(boxes_xywh, scores, conf_threshold, 0.45)
        if len(indices) == 0:
            return [], best_angle

        results: List[BoundingBox] = []
        faces = face_boxes or []
        for idx in np.array(indices).flatten():
            x, y, bw_s, bh_s = boxes_xywh[int(idx)]
            pad = max(3, int(min(bw_s, bh_s) * 0.08))
            bx1 = max(0, int(x) - pad)
            by1 = max(0, int(y) - pad)
            bx2 = min(w_orig, int(x + bw_s) + pad)
            by2 = min(h_orig, int(y + bh_s) + pad)
            box = BoundingBox(
                x=bx1,
                y=by1,
                w=max(4, bx2 - bx1),
                h=max(4, by2 - by1),
                confidence=round(scores[int(idx)], 3),
                label=_format_nudenet_label(kept_labels[int(idx)]),
            )
            clipped = _clip_box_away_from_faces(box, faces) if faces else box
            if clipped is not None:
                results.append(clipped)
        return results, best_angle

    def detect(
        self,
        img_bgr: np.ndarray,
        sensitivity: float = 0.5,
        allowed_classes: Optional[List[str]] = None,
        face_boxes: Optional[List[BoundingBox]] = None,
        check_orientations: bool = False,
    ) -> List[BoundingBox]:
        boxes, _ = self.detect_with_orientation(
            img_bgr,
            sensitivity=sensitivity,
            allowed_classes=allowed_classes,
            face_boxes=face_boxes,
            check_orientations=check_orientations,
        )
        return boxes


def _get_shared_nudenet_detector() -> NudeNetDetector:
    global _SHARED_NUDENET_DETECTOR
    with _SHARED_NUDENET_LOCK:
        if _SHARED_NUDENET_DETECTOR is None:
            _SHARED_NUDENET_DETECTOR = NudeNetDetector()
        return _SHARED_NUDENET_DETECTOR


class VideoFaceTracker:
    """Robust track-by-detection associator with confirmation hysteresis."""

    def __init__(
        self,
        detector: FaceDetector,
        max_lost_frames: int = 8,
        padding_percent: float = 0.20,
        face_fit: str = "standard",
    ):
        self.detector = detector
        self.max_lost_frames = max_lost_frames
        self.padding_percent = padding_percent
        self.face_fit = face_fit
        self.next_track_id = 1
        self.active_tracks: Dict[int, dict] = {}
        # Detect every frame. Reusing an unchanged box for two frames caused
        # visible gaps whenever a subject moved quickly or turned their head.
        self.detection_interval = 1
        self.last_detection_frame = -self.detection_interval
        self.preferred_angle: float = 0.0

    def update(self, frame_bgr: np.ndarray, frame_idx: int) -> List[BoundingBox]:
        if self.active_tracks and frame_idx - self.last_detection_frame < self.detection_interval:
            return [
                tinfo["smoothed_box"]
                for tinfo in self.active_tracks.values()
                if tinfo.get("confirmed", True)
            ]

        is_keyframe = (
            (frame_idx == 0)
            or (frame_idx % 8 == 0)
            or (not self.active_tracks and frame_idx % 4 == 0)
        )
        if hasattr(self.detector, "detect_with_orientation"):
            detected_boxes, matched_angle = self.detector.detect_with_orientation(
                frame_bgr,
                padding_percent=self.padding_percent,
                face_fit=self.face_fit,
                check_orientations=is_keyframe,
                preferred_angle=self.preferred_angle,
            )
            if detected_boxes:
                self.preferred_angle = matched_angle
        else:
            detected_boxes = self.detector.detect(
                frame_bgr,
                padding_percent=self.padding_percent,
                face_fit=self.face_fit,
            )
        self.last_detection_frame = frame_idx
        h, w = frame_bgr.shape[:2]
        diag = math.hypot(w, h)

        matched_tracks = set()
        unmatched_detections = []

        for d_box in detected_boxes:
            best_track_id = None
            best_score = -1.0

            for tid, tinfo in self.active_tracks.items():
                if tid in matched_tracks:
                    continue
                last_box: BoundingBox = tinfo["last_box"]
                iou = compute_iou(d_box, last_box)
                dist = compute_center_dist(d_box, last_box) / diag

                if iou > 0.10 or dist < 0.22:
                    score = iou * 0.6 + (1.0 - min(1.0, dist / 0.22)) * 0.4
                    if score > best_score:
                        best_score = score
                        best_track_id = tid

            if best_track_id is not None and best_score > 0.12:
                matched_tracks.add(best_track_id)
                tinfo = self.active_tracks[best_track_id]
                tinfo["lost_count"] = 0
                tinfo["hits"] = tinfo.get("hits", 1) + 1
                if d_box.confidence >= 0.62 and tinfo["hits"] >= 2:
                    tinfo["confirmed"] = True

                prev_s: BoundingBox = tinfo["smoothed_box"]
                alpha = 0.70
                sx = int(alpha * d_box.x + (1 - alpha) * prev_s.x)
                sy = int(alpha * d_box.y + (1 - alpha) * prev_s.y)
                sw = int(alpha * d_box.w + (1 - alpha) * prev_s.w)
                sh = int(alpha * d_box.h + (1 - alpha) * prev_s.h)

                smoothed = BoundingBox(
                    x=max(0, min(w - 4, sx)),
                    y=max(0, min(h - 4, sy)),
                    w=max(4, min(w - sx, sw)),
                    h=max(4, min(h - sy, sh)),
                    confidence=d_box.confidence,
                    landmarks=d_box.landmarks,
                    track_id=best_track_id,
                    label="Face"
                )
                tinfo["last_box"] = d_box
                tinfo["smoothed_box"] = smoothed
            else:
                unmatched_detections.append(d_box)

        for u_box in unmatched_detections:
            new_id = self.next_track_id
            self.next_track_id += 1
            u_box.track_id = new_id
            is_high_conf = u_box.confidence >= 0.70
            self.active_tracks[new_id] = {
                "last_box": u_box,
                "smoothed_box": u_box,
                "lost_count": 0,
                "hits": 2 if is_high_conf else 1,
                "confirmed": is_high_conf,
            }

        stale_tracks = []
        output_boxes: List[BoundingBox] = []
        new_track_ids = {u.track_id for u in unmatched_detections}

        for tid, tinfo in self.active_tracks.items():
            if tid not in matched_tracks and tid not in new_track_ids:
                if not tinfo.get("confirmed", True):
                    stale_tracks.append(tid)
                    continue
                tinfo["lost_count"] += self.detection_interval
                if tinfo["lost_count"] > self.max_lost_frames:
                    stale_tracks.append(tid)
                else:
                    output_boxes.append(tinfo["smoothed_box"])
            elif tinfo.get("confirmed", True):
                output_boxes.append(tinfo["smoothed_box"])

        for tid in stale_tracks:
            del self.active_tracks[tid]

        return output_boxes


# --- Mask Application Engine ---

def _build_shape_mask(
    w_roi: int,
    h_roi: int,
    shape: str = "oval",
    feather: int = 25,
) -> np.ndarray:
    """
    Create an alpha mask in [0, 1] for any supported censor shape:
    'oval', 'rect', 'circle', 'triangle', or 'heart', with configurable edge feather.
    """
    mask_w, mask_h = max(32, min(192, w_roi)), max(24, min(192, h_roi))
    mask = np.zeros((mask_h, mask_w), dtype=np.float32)

    if shape == "rect":
        pad_x = max(1, int(mask_w * 0.04)) if feather > 0 else 0
        pad_y = max(1, int(mask_h * 0.04)) if feather > 0 else 0
        cv2.rectangle(mask, (pad_x, pad_y), (max(pad_x + 2, mask_w - 1 - pad_x), max(pad_y + 2, mask_h - 1 - pad_y)), 1.0, -1)
    elif shape == "circle":
        radius = max(4, int(min(mask_w, mask_h) * 0.47))
        cv2.circle(mask, (mask_w // 2, mask_h // 2), radius, 1.0, -1, lineType=cv2.LINE_AA)
    elif shape == "triangle":
        pts = np.array(
            [
                [mask_w // 2, max(2, int(mask_h * 0.04))],
                [max(3, int(mask_w * 0.96)), max(3, int(mask_h * 0.95))],
                [max(1, int(mask_w * 0.04)), max(3, int(mask_h * 0.95))],
            ],
            dtype=np.int32,
        )
        cv2.fillPoly(mask, [pts], 1.0, lineType=cv2.LINE_AA)
    elif shape == "heart":
        ts = np.linspace(0.0, 2.0 * math.pi, 120, endpoint=False)
        xs = 16.0 * np.sin(ts) ** 3
        ys = -(13.0 * np.cos(ts) - 5.0 * np.cos(2.0 * ts) - 2.0 * np.cos(3.0 * ts) - np.cos(4.0 * ts))
        # Normalize parametric heart cleanly into (0..1) box
        nx = (xs - xs.min()) / max(1e-6, xs.max() - xs.min())
        ny = (ys - ys.min()) / max(1e-6, ys.max() - ys.min())
        px = np.clip((0.05 + nx * 0.90) * (mask_w - 1), 0, mask_w - 1)
        py = np.clip((0.06 + ny * 0.88) * (mask_h - 1), 0, mask_h - 1)
        poly = np.stack([px, py], axis=1).astype(np.int32)
        cv2.fillPoly(mask, [poly], 1.0, lineType=cv2.LINE_AA)
    else:
        axes = (max(4, int(mask_w * 0.47)), max(4, int(mask_h * 0.47)))
        cv2.ellipse(mask, (mask_w // 2, mask_h // 2), axes, 0, 0, 360, 1.0, -1, lineType=cv2.LINE_AA)

    f_norm = max(0.0, min(100.0, float(feather))) / 100.0
    if f_norm > 0.02:
        k_ratio = 0.04 + f_norm * 0.24
        ksize = max(3, int(min(mask_w, mask_h) * k_ratio) | 1)
        mask = cv2.GaussianBlur(mask, (ksize, ksize), 0)

    mask = cv2.resize(mask, (w_roi, h_roi), interpolation=cv2.INTER_LINEAR)
    return np.clip(mask, 0.0, 1.0)[:, :, np.newaxis]


def _build_feathered_oval_mask(w_roi: int, h_roi: int) -> np.ndarray:
    """Backwards-compatible alias for _build_shape_mask('oval', feather=25)."""
    return _build_shape_mask(w_roi, h_roi, shape="oval", feather=25)


def _compute_smooth_gaussian_blur(roi: np.ndarray, intensity: int) -> np.ndarray:
    """True smooth separable Gaussian blur without blocky downscale/nearest-neighbor artifacts."""
    h_roi, w_roi = roi.shape[:2]
    strength = max(1, min(100, int(intensity))) / 100.0
    min_side = min(w_roi, h_roi)
    sigma = max(1.2, (0.04 + (strength ** 1.35) * 0.22) * min_side)

    # For large ROIs, bilinear 0.5x + Gaussian + bilinear restore stays silky smooth AND 3-4x faster
    if max(w_roi, h_roi) > 260 and sigma > 6.0:
        half = cv2.resize(roi, (max(4, w_roi // 2), max(4, h_roi // 2)), interpolation=cv2.INTER_LINEAR)
        k_half = max(3, int(round(sigma * 1.5)) | 1)
        blurred_half = cv2.GaussianBlur(half, (k_half, k_half), sigmaX=sigma * 0.5, sigmaY=sigma * 0.5)
        blurred = cv2.resize(blurred_half, (w_roi, h_roi), interpolation=cv2.INTER_LINEAR)
        return cv2.GaussianBlur(blurred, (5, 5), sigmaX=1.2)

    k = max(3, min(199, int(round(sigma * 3.0)) | 1))
    return cv2.GaussianBlur(roi, (k, k), sigmaX=sigma, sigmaY=sigma)


def _resolve_shape_roi(
    w_img: int,
    h_img: int,
    box: BoundingBox,
    shape: str,
) -> Tuple[int, int, int, int]:
    """
    Compute ROI bounds so geometric shapes ('circle', 'triangle', 'heart') enclose
    narrow portrait faces cleanly without exposing forehead/chin edges.
    """
    pad_x = int(box.w * 0.06)
    pad_y = int(box.h * 0.06)
    x1, y1 = max(0, box.x - pad_x), max(0, box.y - pad_y)
    x2, y2 = min(w_img, box.x2 + pad_x), min(h_img, box.y2 + pad_y)

    if shape == "circle":
        # Expand shorter axis symmetrically toward a 1:1 enclosing square around face center
        cur_w = x2 - x1
        cur_h = y2 - y1
        target_side = min(max(cur_w, cur_h), max(16, min(w_img, h_img)))
        cx = int(round((x1 + x2) * 0.5))
        cy = int(round((y1 + y2) * 0.5))
        half = target_side // 2
        x1 = max(0, cx - half)
        x2 = min(w_img, x1 + target_side)
        x1 = max(0, x2 - target_side)
        y1 = max(0, cy - half)
        y2 = min(h_img, y1 + target_side)
        y1 = max(0, y2 - target_side)
    elif shape in ("triangle", "heart"):
        # Give slightly wider lateral margin so brow/temple corners fit inside tapered top shapes
        extra_x = int(box.w * 0.08)
        x1 = max(0, x1 - extra_x)
        x2 = min(w_img, x2 + extra_x)

    return x1, y1, x2, y2


def apply_gaussian_blur(
    img: np.ndarray,
    box: BoundingBox,
    intensity: int,
    shape: str = "oval",
    feather: int = 25,
) -> np.ndarray:
    h_img, w_img = img.shape[:2]
    x1, y1, x2, y2 = _resolve_shape_roi(w_img, h_img, box, shape)
    w_roi, h_roi = x2 - x1, y2 - y1

    if w_roi < 4 or h_roi < 4:
        return img

    roi = img[y1:y2, x1:x2]
    blurred = _compute_smooth_gaussian_blur(roi, intensity)

    if shape == "rect" and feather <= 0:
        img[y1:y2, x1:x2] = blurred
    else:
        mask_3d = _build_shape_mask(w_roi, h_roi, shape=shape, feather=feather)
        composite = (blurred * mask_3d + roi * (1.0 - mask_3d)).astype(np.uint8)
        img[y1:y2, x1:x2] = composite

    return img


def apply_pixelate(
    img: np.ndarray,
    box: BoundingBox,
    intensity: int,
    shape: str = "oval",
    feather: int = 25,
) -> np.ndarray:
    h_img, w_img = img.shape[:2]
    x1, y1, x2, y2 = _resolve_shape_roi(w_img, h_img, box, shape)
    w_roi, h_roi = x2 - x1, y2 - y1

    if w_roi < 4 or h_roi < 4:
        return img

    strength = max(1, min(100, int(intensity))) / 100.0
    blocks_across = max(4, int(round(20 - strength * 14)))
    block_size = max(4, min(w_roi, h_roi) // blocks_across)
    small_w = max(2, round(w_roi / block_size))
    small_h = max(2, round(h_roi / block_size))

    roi = img[y1:y2, x1:x2]
    small = cv2.resize(roi, (small_w, small_h), interpolation=cv2.INTER_AREA)
    pixelated = cv2.resize(small, (w_roi, h_roi), interpolation=cv2.INTER_NEAREST)

    if shape == "rect" and feather <= 0:
        img[y1:y2, x1:x2] = pixelated
    else:
        mask_3d = _build_shape_mask(w_roi, h_roi, shape=shape, feather=max(0, min(35, feather)))
        img[y1:y2, x1:x2] = (pixelated * mask_3d + roi * (1.0 - mask_3d)).astype(np.uint8)

    return img


def apply_emoji_overlay(
    img: np.ndarray,
    box: BoundingBox,
    emoji_name: str = "sunglasses",
    custom_path: Optional[str] = None
) -> np.ndarray:
    sticker_path = custom_path
    if not sticker_path or not os.path.exists(sticker_path):
        sticker_path = os.path.join(EMOJI_DIR, f"{emoji_name}.png")

    if not os.path.exists(sticker_path):
        sticker_path = os.path.join(EMOJI_DIR, "sunglasses.png")
        if not os.path.exists(sticker_path):
            return apply_pixelate(img, box, 60, "oval")

    sticker = cv2.imread(sticker_path, cv2.IMREAD_UNCHANGED)
    if sticker is None:
        return img
    if sticker.ndim == 2:
        sticker = cv2.cvtColor(sticker, cv2.COLOR_GRAY2BGRA)
    elif sticker.shape[2] == 3:
        alpha_chan = np.full((sticker.shape[0], sticker.shape[1], 1), 255, dtype=np.uint8)
        sticker = np.concatenate([sticker, alpha_chan], axis=2)
    elif sticker.shape[2] < 4:
        return img

    sh, sw = sticker.shape[:2]
    if sw < 2 or sh < 2 or box.w < 4 or box.h < 4:
        return img

    # Preserve sticker aspect ratio instead of stretching square icons into tall/wide boxes.
    is_wide_eye_band = (box.w / float(box.h)) >= 2.0
    if is_wide_eye_band:
        fit_scale = min((box.w * 1.1) / sw, (box.h * 1.4) / sh)
    else:
        min_fit = min((box.w * 1.1) / sw, (box.h * 1.1) / sh)
        max_fit = max((box.w * 1.05) / sw, (box.h * 1.05) / sh)
        fit_scale = min(max_fit, min_fit * 1.5)

    target_w = max(4, int(round(sw * fit_scale)))
    target_h = max(4, int(round(sh * fit_scale)))
    interp = cv2.INTER_CUBIC if (target_w > sw or target_h > sh) else cv2.INTER_AREA
    resized_sticker = cv2.resize(sticker, (target_w, target_h), interpolation=interp)

    cx, cy = box.center
    x1 = int(cx - target_w / 2.0)
    y1 = int(cy - target_h / 2.0)
    x2 = x1 + target_w
    y2 = y1 + target_h

    h_img, w_img = img.shape[:2]

    src_x1 = max(0, -x1)
    src_y1 = max(0, -y1)
    src_x2 = target_w - max(0, x2 - w_img)
    src_y2 = target_h - max(0, y2 - h_img)

    dst_x1 = max(0, x1)
    dst_y1 = max(0, y1)
    dst_x2 = min(w_img, x2)
    dst_y2 = min(h_img, y2)

    if dst_x2 <= dst_x1 or dst_y2 <= dst_y1 or src_x2 <= src_x1 or src_y2 <= src_y1:
        return img

    sticker_crop = resized_sticker[src_y1:src_y2, src_x1:src_x2]
    alpha = (sticker_crop[:, :, 3] / 255.0)[:, :, np.newaxis]
    sticker_bgr = sticker_crop[:, :, :3]

    roi = img[dst_y1:dst_y2, dst_x1:dst_x2]
    blended = (sticker_bgr * alpha + roi * (1.0 - alpha)).astype(np.uint8)
    img[dst_y1:dst_y2, dst_x1:dst_x2] = blended

    return img


def apply_redact_bar(
    img: np.ndarray,
    box: BoundingBox,
    text: Optional[str] = "[CENSORED]",
    shape: str = "rect",
) -> np.ndarray:
    h_img, w_img = img.shape[:2]
    x1, y1 = max(0, box.x), max(0, box.y)
    x2, y2 = min(w_img, box.x2), min(h_img, box.y2)

    if x2 <= x1 or y2 <= y1:
        return img

    w_roi, h_roi = x2 - x1, y2 - y1
    roi = img[y1:y2, x1:x2]
    patch = np.full_like(roi, (18, 18, 18))

    if shape == "rect":
        cv2.rectangle(patch, (0, 0), (w_roi - 1, h_roi - 1), (220, 20, 60), 2)

    if text:
        text_str = str(text).strip()
        font = cv2.FONT_HERSHEY_DUPLEX
        base_scale = min(w_roi / 160.0, h_roi / 40.0)
        font_scale = max(0.4, min(1.2, base_scale))
        thickness = 1 if font_scale < 0.7 else 2

        (tw, th), _ = cv2.getTextSize(text_str, font, font_scale, thickness)
        tx = (w_roi - tw) // 2
        ty = (h_roi + th) // 2

        if tw < w_roi and th < h_roi:
            cv2.putText(patch, text_str, (tx, ty), font, font_scale, (255, 255, 255), thickness, cv2.LINE_AA)

    if shape == "rect":
        img[y1:y2, x1:x2] = patch
    else:
        mask_3d = _build_shape_mask(w_roi, h_roi, shape=shape, feather=4)
        img[y1:y2, x1:x2] = (patch * mask_3d + roi * (1.0 - mask_3d)).astype(np.uint8)

    return img


def _paint_polyline_on_mask(
    mask: np.ndarray,
    points: List[Tuple[float, float]],
    radius: float,
    origin_x: int,
    origin_y: int,
    value: float,
) -> None:
    thickness = max(2, int(round(radius * 2.0)))
    r_int = max(2, int(round(radius)))
    segments: List[List[Tuple[int, int]]] = []
    current: List[Tuple[int, int]] = []
    for px, py in points:
        if px < 0 or py < 0:
            if current:
                segments.append(current)
                current = []
        else:
            current.append((int(round(px - origin_x)), int(round(py - origin_y))))
    if current:
        segments.append(current)

    for seg in segments:
        if len(seg) == 1:
            cv2.circle(mask, seg[0], r_int, value, -1, lineType=cv2.LINE_AA)
        else:
            for i in range(len(seg) - 1):
                cv2.line(mask, seg[i], seg[i + 1], value, thickness=thickness, lineType=cv2.LINE_AA)
            cv2.circle(mask, seg[-1], r_int, value, -1, lineType=cv2.LINE_AA)


def _apply_brush_stroke_mask(
    img: np.ndarray,
    box: BoundingBox,
    config: MaskConfig,
    effect_type: str,
) -> np.ndarray:
    """Apply soft-feathered blur, pixelate, or solid redaction along a freehand stroke (with optional eraser subtract)."""
    points = box.brush_points or []
    valid_pts = [(float(p[0]), float(p[1])) for p in points if len(p) >= 2 and p[0] >= 0 and p[1] >= 0]
    if not valid_pts:
        return img

    h_img, w_img = img.shape[:2]
    radius = max(4.0, float(box.brush_radius or 24.0))
    feather_val = max(0, min(100, int(getattr(config, "feather", 25))))
    feather_pad = max(2, int(round(radius * (0.1 + 0.55 * (feather_val / 100.0)))))
    margin = int(math.ceil(radius)) + feather_pad

    xs = [p[0] for p in valid_pts]
    ys = [p[1] for p in valid_pts]
    x1 = max(0, int(math.floor(min(xs) - margin)))
    y1 = max(0, int(math.floor(min(ys) - margin)))
    x2 = min(w_img, int(math.ceil(max(xs) + margin)))
    y2 = min(h_img, int(math.ceil(max(ys) + margin)))
    w_roi, h_roi = x2 - x1, y2 - y1
    if w_roi < 4 or h_roi < 4:
        return img

    mask = np.zeros((h_roi, w_roi), dtype=np.float32)
    _paint_polyline_on_mask(mask, points, radius, x1, y1, 1.0)
    if box.eraser_points:
        e_rad = max(4.0, float(getattr(box, "eraser_radius", 24.0) or 24.0))
        _paint_polyline_on_mask(mask, box.eraser_points, e_rad, x1, y1, 0.0)

    if feather_val > 0:
        k_ratio = 0.08 + (feather_val / 100.0) * 0.65
        ksize = max(3, int(round(radius * k_ratio)) | 1)
        mask = cv2.GaussianBlur(mask, (ksize, ksize), 0)
    alpha_3d = np.clip(mask, 0.0, 1.0)[:, :, np.newaxis]

    roi = img[y1:y2, x1:x2]
    strength = max(1, min(100, int(config.intensity))) / 100.0
    if effect_type == "pixelate" or effect_type == "emoji":
        blocks_across = max(4, int(round(20 - strength * 14)))
        block_size = max(4, min(w_roi, h_roi) // blocks_across)
        small_w = max(2, round(w_roi / block_size))
        small_h = max(2, round(h_roi / block_size))
        small = cv2.resize(roi, (small_w, small_h), interpolation=cv2.INTER_AREA)
        filtered = cv2.resize(small, (w_roi, h_roi), interpolation=cv2.INTER_NEAREST)
    elif effect_type == "redact":
        filtered = np.full_like(roi, (18, 18, 18))
    else:
        filtered = _compute_smooth_gaussian_blur(roi, config.intensity)

    img[y1:y2, x1:x2] = (filtered * alpha_3d + roi * (1.0 - alpha_3d)).astype(np.uint8)
    return img


def _is_face_box_for_eyes(box: BoundingBox) -> bool:
    """Return True only when `box` represents a face target eligible for Eyes-Only band shrinking."""
    lbl = (box.label or "").strip()
    if lbl.startswith(("NudeNet:", "NSFW", "Skin Region")):
        return False
    if lbl.startswith("Face #") or lbl in ("Face", "Custom Face"):
        return True
    return bool(
        box.landmarks
        and len(box.landmarks) >= 2
        and not lbl.startswith(("License", "Document", "Logo", "Custom", "Manual", "Object"))
    )


def _force_full_region_config(config: MaskConfig) -> MaskConfig:
    """Return a copy of `config` with mask_region forced to 'face' for non-face modes."""
    if config.mask_region != "eyes":
        return config
    return MaskConfig(
        mask_type=config.mask_type,
        intensity=config.intensity,
        feather=config.feather,
        emoji_name=config.emoji_name,
        custom_sticker_path=config.custom_sticker_path,
        redact_text=config.redact_text,
        shape=config.shape,
        mask_region="face",
        face_fit=config.face_fit,
        padding_percent=config.padding_percent,
    )


def apply_masks_to_frame(
    img_bgr: np.ndarray,
    boxes: List[BoundingBox],
    config: MaskConfig
) -> np.ndarray:
    output = img_bgr.copy()
    for box in boxes:
        effect_type = box.mask_type or config.mask_type
        if box.kind == "brush" and box.brush_points:
            output = _apply_brush_stroke_mask(output, box, config, effect_type)
            continue

        mask_box = box
        if config.mask_region == "eyes" and _is_face_box_for_eyes(box):
            # YuNet landmark order: left eye, right eye, nose, left mouth, right mouth.
            # Keep a small brow/bridge margin so the eyes stay covered while the rest
            # of the face remains visible. The proportional fallback supports manual
            # boxes and older saved edits that do not contain landmarks.
            if box.landmarks and len(box.landmarks) >= 2:
                eye_a, eye_b = box.landmarks[0], box.landmarks[1]
                dx = abs(eye_b[0] - eye_a[0])
                dy = abs(eye_b[1] - eye_a[1])
                eye_distance = math.hypot(dx, dy)
                center_x = (eye_a[0] + eye_b[0]) / 2.0
                center_y = (eye_a[1] + eye_b[1]) / 2.0
                # YuNet's eye landmarks rotate with the face; orient the band
                # vertically when the face is sideways (90/270 deg) so both eyes stay covered.
                if dy > dx:
                    eye_w = max(8, int(eye_distance * 0.90))
                    eye_h = max(8, int(eye_distance * 1.55))
                else:
                    eye_w = max(8, int(eye_distance * 1.55))
                    eye_h = max(8, int(eye_distance * 0.90))
                eye_x = int(center_x - eye_w / 2)
                eye_y = int(center_y - eye_h / 2)
            else:
                eye_w = max(8, int(box.w * 0.70))
                eye_h = max(8, int(box.h * 0.24))
                eye_x = int(box.x + (box.w - eye_w) / 2)
                eye_y = int(box.y + box.h * 0.25)
            mask_box = BoundingBox(
                x=eye_x, y=eye_y, w=eye_w, h=eye_h,
                confidence=box.confidence, track_id=box.track_id,
                label=box.label
            )
        feather_val = int(getattr(config, "feather", 25))
        if effect_type == "blur":
            output = apply_gaussian_blur(output, mask_box, config.intensity, config.shape, feather=feather_val)
        elif effect_type == "pixelate":
            output = apply_pixelate(output, mask_box, config.intensity, config.shape, feather=feather_val)
        elif effect_type == "emoji":
            output = apply_emoji_overlay(output, mask_box, config.emoji_name, config.custom_sticker_path)
        elif effect_type == "redact":
            output = apply_redact_bar(output, mask_box, config.redact_text, shape=config.shape)
        else:
            output = apply_gaussian_blur(output, mask_box, config.intensity, config.shape, feather=feather_val)
    return output


# --- Main Processor Facade ---

class CensorProcessor:
    """Main facade for diversified photo and video privacy and censorship tasks."""

    def __init__(self, model_path: str = YUNET_PATH):
        self.detector = FaceDetector(model_path=model_path)
        self.nudenet = _get_shared_nudenet_detector()

    def detect_image_faces(
        self,
        image_path: str,
        padding_percent: float = 0.20,
        face_fit: str = "standard",
    ) -> List[BoundingBox]:
        """Detects faces in a static image file."""
        img = safe_imread(image_path)
        if img is None:
            raise ValueError(f"Could not read image file: {image_path}")
        return self.detector.detect(img, padding_percent=padding_percent, face_fit=face_fit)

    def detect_nsfw_frame(
        self,
        frame_bgr: np.ndarray,
        sensitivity: float = 0.5,
        face_boxes: Optional[List[BoundingBox]] = None,
        allowed_classes: Optional[List[str]] = None,
        check_orientations: bool = False,
    ) -> Tuple[List[BoundingBox], str, str]:
        """
        Detect sensitive body parts using NudeNet v3 ONNX when loaded,
        falling back to skin-region heuristics if the ONNX model is absent.
        """
        if self.nudenet._ensure_loaded():
            boxes = self.nudenet.detect(
                frame_bgr,
                sensitivity=sensitivity,
                allowed_classes=allowed_classes,
                face_boxes=face_boxes,
                check_orientations=check_orientations,
            )
            return (
                boxes,
                "NudeNet v3 ONNX (18-class)",
                "Local NudeNet ONNX detection complete. Review masks before export.",
            )
        boxes = detect_nsfw_candidates(frame_bgr, sensitivity=sensitivity, face_boxes=face_boxes)
        return (
            boxes,
            "skin-region heuristic",
            "Candidate regions only; review every result before export.",
        )

    def detect_image_nsfw(
        self,
        image_path: str,
        sensitivity: float = 0.5,
        allowed_classes: Optional[List[str]] = None,
    ) -> List[BoundingBox]:
        """Detects sensitive body-part regions in an image."""
        img = safe_imread(image_path)
        if img is None:
            raise ValueError(f"Could not read image file: {image_path}")
        faces = self.detector.detect(img, padding_percent=0.05)
        boxes, _, _ = self.detect_nsfw_frame(
            img,
            sensitivity=sensitivity,
            face_boxes=faces,
            allowed_classes=allowed_classes,
            check_orientations=True,
        )
        return boxes

    def process_image(
        self,
        image_path: str,
        output_path: str,
        mask_config: MaskConfig,
        custom_boxes: Optional[List[BoundingBox]] = None,
        auto_detect_all: bool = False,
        auto_detect_nsfw: bool = False,
        nsfw_sensitivity: float = 0.5,
        nsfw_classes: Optional[List[str]] = None,
    ) -> str:
        """
        Applies privacy masking to an image safely.
        If custom_boxes is provided, strictly masks ONLY those targets.
        """
        img = safe_imread(image_path)
        if img is None:
            raise ValueError(f"Could not read image file at: {image_path}")

        boxes: List[BoundingBox] = []
        if custom_boxes is not None and len(custom_boxes) > 0:
            boxes.extend(custom_boxes)
        if auto_detect_all:
            boxes.extend(
                self.detector.detect(
                    img,
                    padding_percent=mask_config.padding_percent,
                    face_fit=getattr(mask_config, "face_fit", "standard"),
                )
            )
        if auto_detect_nsfw:
            faces = self.detector.detect(img, padding_percent=0.05)
            nsfw_boxes, _, _ = self.detect_nsfw_frame(
                img,
                sensitivity=nsfw_sensitivity,
                face_boxes=faces,
                allowed_classes=nsfw_classes,
                check_orientations=True,
            )
            boxes.extend(nsfw_boxes)

        if not boxes:
            raise ValueError("No targets were detected or selected to mask.")

        effective_config = _force_full_region_config(mask_config) if (auto_detect_nsfw and not auto_detect_all) else mask_config
        result_bgr = apply_masks_to_frame(img, boxes, effective_config)
        if not safe_imwrite(output_path, result_bgr):
            raise ValueError(f"Could not write protected image: {output_path}")
        return output_path

    @staticmethod
    def _match_track_id(
        ref_box: BoundingBox,
        candidates: List[BoundingBox],
        diag: float,
        max_dist_ratio: float = 0.28,
    ) -> Optional[int]:
        if not candidates:
            return None
        best_id: Optional[int] = None
        best_iou = -1.0
        for fb in candidates:
            iou = compute_iou(ref_box, fb)
            if iou > best_iou:
                best_iou = iou
                best_id = fb.track_id
        if best_iou >= 0.05:
            return best_id
        best_dist = float("inf")
        best_id = None
        for fb in candidates:
            d = compute_center_dist(ref_box, fb)
            if d < best_dist:
                best_dist = d
                best_id = fb.track_id
        if diag > 0 and best_dist <= diag * max_dist_ratio:
            return best_id
        return None

    def process_video(
        self,
        input_video_path: str,
        output_video_path: str,
        mask_config: MaskConfig,
        mode: str = "faces_all", # "faces_all", "face_single", "specific_object", "nsfw"
        selected_track_id: Optional[int] = None,
        selected_face_box: Optional[BoundingBox] = None,
        custom_boxes: Optional[List[BoundingBox]] = None,
        excluded_face_boxes: Optional[List[BoundingBox]] = None,
        track_custom_objects: bool = True,
        nsfw_sensitivity: float = 0.5,
        nsfw_classes: Optional[List[str]] = None,
        progress_callback: Optional[Callable[[float], None]] = None
    ) -> str:
        """
        Diversified video censor with continuous face tracking, single-face focus,
        MIL object tracking, NudeNet ONNX body-part tracking, and time-ranged brush masks.
        """
        from engine.hw_accel import detect_best_h264_encoder, build_h264_encode_args

        cap = cv2.VideoCapture(input_video_path)
        if not cap.isOpened():
            raise ValueError(f"Could not open video file: {input_video_path}")

        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        diag = math.hypot(width, height)

        if total_frames <= 0:
            total_frames = 100

        os.makedirs(os.path.dirname(os.path.abspath(output_video_path)), exist_ok=True)
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            cap.release()
            raise ValueError("FFmpeg is required to export protected videos. Install FFmpeg and restart the app.")

        preferred_enc = detect_best_h264_encoder()
        vf_filter = "pad=ceil(iw/2)*2:ceil(ih/2)*2" + (",format=nv12" if preferred_enc == "h264_qsv" else "")
        codec_args = build_h264_encode_args(preferred_enc, crf=20, preset="ultrafast")
        ffmpeg_cmd = [
            ffmpeg, "-y", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "bgr24",
            "-video_size", f"{width}x{height}", "-framerate", str(fps), "-i", "pipe:0",
            "-i", input_video_path,
            "-map", "0:v:0", "-map", "1:a?", "-map_metadata", "0",
            "-vf", vf_filter,
            *codec_args,
            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
            output_video_path
        ]
        encoder = subprocess.Popen(ffmpeg_cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if encoder.stdin is None:
            cap.release()
            raise ValueError("Could not start the video encoder.")

        if progress_callback:
            progress_callback(2.0)

        all_custom = list(custom_boxes or [])
        custom_box_items = [b for b in all_custom if b.kind != "brush"]
        custom_brush_items = [b for b in all_custom if b.kind == "brush"]

        def _is_box_active_at(box: BoundingBox, sec: float) -> bool:
            if box.start_sec is not None and sec < box.start_sec:
                return False
            if box.end_sec is not None and sec > box.end_sec:
                return False
            return True

        # Initialize object trackers only for rectangular/shape box targets when requested
        object_trackers: List[Tuple[cv2.Tracker, BoundingBox]] = []
        if mode == "specific_object" and track_custom_objects and custom_box_items:
            ret, first_frame = cap.read()
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            if ret and first_frame is not None:
                for c_box in custom_box_items:
                    tr = self._create_object_tracker()
                    if tr is None:
                        break
                    if tr.init(first_frame, (c_box.x, c_box.y, c_box.w, c_box.h)) is False:
                        continue
                    object_trackers.append((tr, c_box))

        face_tracker = VideoFaceTracker(
            self.detector,
            max_lost_frames=8,
            padding_percent=mask_config.padding_percent,
            face_fit=getattr(mask_config, "face_fit", "standard"),
        )
        nsfw_face_tracker = VideoFaceTracker(self.detector, max_lost_frames=8, padding_percent=0.10) if mode == "nsfw" else None
        nsfw_tracks: Dict[int, dict] = {}
        nsfw_next_id = 1
        nsfw_preferred_angle: float = 0.0
        resolved_single_id: Optional[int] = selected_track_id if (mode == "face_single" and selected_face_box is None) else None
        last_focused_box: Optional[BoundingBox] = selected_face_box
        excluded_track_ids: Set[int] = set()
        pending_excluded_boxes: List[BoundingBox] = list(excluded_face_boxes or [])
        frame_idx = 0
        masked_frame_count = 0
        effective_mask_config = _force_full_region_config(mask_config) if mode in ("nsfw", "specific_object") else mask_config

        try:
            while True:
                ret, frame = cap.read()
                if not ret:
                    break

                current_sec = frame_idx / float(max(1.0, fps))
                active_frame_boxes: List[BoundingBox] = []

                if mode in ["faces_all", "face_single"]:
                    tracked_faces = face_tracker.update(frame, frame_idx)
                    if mode == "face_single":
                        matched = [f for f in tracked_faces if resolved_single_id is not None and f.track_id == resolved_single_id]
                        if not matched and tracked_faces:
                            if last_focused_box is not None:
                                re_id = self._match_track_id(last_focused_box, tracked_faces, diag, max_dist_ratio=0.35)
                                if re_id is not None:
                                    resolved_single_id = re_id
                                    matched = [f for f in tracked_faces if f.track_id == resolved_single_id]
                            elif resolved_single_id is None:
                                resolved_single_id = tracked_faces[0].track_id
                                matched = [tracked_faces[0]]
                        if matched:
                            last_focused_box = matched[0]
                        active_frame_boxes = matched
                    else:
                        if pending_excluded_boxes and tracked_faces:
                            still_pending: List[BoundingBox] = []
                            for ex_box in pending_excluded_boxes:
                                ex_id = self._match_track_id(ex_box, tracked_faces, diag, max_dist_ratio=0.25)
                                if ex_id is not None:
                                    excluded_track_ids.add(ex_id)
                                else:
                                    still_pending.append(ex_box)
                            pending_excluded_boxes = still_pending
                        active_frame_boxes = [f for f in tracked_faces if f.track_id not in excluded_track_ids]

                elif mode == "specific_object":
                    if object_trackers:
                        for tr, src_box in object_trackers:
                            ok, bbox = tr.update(frame)
                            if ok and _is_box_active_at(src_box, current_sec):
                                bx, by, bw, bh = [int(v) for v in bbox]
                                active_frame_boxes.append(BoundingBox(
                                    x=max(0, bx),
                                    y=max(0, by),
                                    w=min(width - bx, bw),
                                    h=min(height - by, bh),
                                    label=src_box.label or "Object",
                                    mask_type=src_box.mask_type,
                                ))
                    elif custom_box_items:
                        active_frame_boxes.extend([b for b in custom_box_items if _is_box_active_at(b, current_sec)])

                elif mode == "nsfw":
                    tracked_faces = nsfw_face_tracker.update(frame, frame_idx) if nsfw_face_tracker is not None else []
                    nsfw_is_keyframe = (
                        (frame_idx == 0)
                        or (frame_idx % 8 == 0)
                        or (not nsfw_tracks and frame_idx % 4 == 0)
                    )
                    if self.nudenet._ensure_loaded() and hasattr(self.nudenet, "detect_with_orientation"):
                        raw_nsfw, matched_nsfw_angle = self.nudenet.detect_with_orientation(
                            frame,
                            sensitivity=nsfw_sensitivity,
                            allowed_classes=nsfw_classes,
                            face_boxes=tracked_faces,
                            check_orientations=nsfw_is_keyframe,
                            preferred_angle=nsfw_preferred_angle,
                        )
                        if raw_nsfw:
                            nsfw_preferred_angle = matched_nsfw_angle
                    else:
                        raw_nsfw, _, _ = self.detect_nsfw_frame(
                            frame,
                            sensitivity=nsfw_sensitivity,
                            face_boxes=tracked_faces,
                            allowed_classes=nsfw_classes,
                            check_orientations=nsfw_is_keyframe,
                        )
                    matched_nsfw = set()
                    unmatched_nsfw = []
                    for d_box in raw_nsfw:
                        best_tid = None
                        best_score = -1.0
                        for tid, tinfo in nsfw_tracks.items():
                            if tid in matched_nsfw:
                                continue
                            prev_box: BoundingBox = tinfo["box"]
                            if prev_box.label != d_box.label:
                                continue
                            iou = compute_iou(d_box, prev_box)
                            dist = compute_center_dist(d_box, prev_box) / diag
                            if iou > 0.15 or dist < 0.18:
                                score = iou * 0.6 + (1.0 - min(1.0, dist / 0.18)) * 0.4
                                if score > best_score:
                                    best_score = score
                                    best_tid = tid
                        if best_tid is not None:
                            matched_nsfw.add(best_tid)
                            prev_box = nsfw_tracks[best_tid]["box"]
                            alpha = 0.65
                            sx = int(alpha * d_box.x + (1 - alpha) * prev_box.x)
                            sy = int(alpha * d_box.y + (1 - alpha) * prev_box.y)
                            sw = int(alpha * d_box.w + (1 - alpha) * prev_box.w)
                            sh = int(alpha * d_box.h + (1 - alpha) * prev_box.h)
                            smoothed = BoundingBox(
                                x=max(0, min(width - 4, sx)),
                                y=max(0, min(height - 4, sy)),
                                w=max(4, min(width - sx, sw)),
                                h=max(4, min(height - sy, sh)),
                                confidence=d_box.confidence,
                                label=d_box.label,
                            )
                            clipped = _clip_box_away_from_faces(smoothed, tracked_faces)
                            if clipped is not None:
                                nsfw_tracks[best_tid] = {"box": clipped, "lost": 0}
                        else:
                            unmatched_nsfw.append(d_box)

                    for d_box in unmatched_nsfw:
                        nsfw_tracks[nsfw_next_id] = {"box": d_box, "lost": 0}
                        matched_nsfw.add(nsfw_next_id)
                        nsfw_next_id += 1

                    stale_nsfw = []
                    for tid in list(nsfw_tracks.keys()):
                        if tid not in matched_nsfw:
                            nsfw_tracks[tid]["lost"] += 1
                            if nsfw_tracks[tid]["lost"] > 8:
                                stale_nsfw.append(tid)
                            else:
                                clipped = _clip_box_away_from_faces(nsfw_tracks[tid]["box"], tracked_faces)
                                if clipped is not None:
                                    active_frame_boxes.append(clipped)
                        else:
                            active_frame_boxes.append(nsfw_tracks[tid]["box"])
                    for tid in stale_nsfw:
                        del nsfw_tracks[tid]

                if custom_box_items and mode != "specific_object":
                    active_frame_boxes.extend([b for b in custom_box_items if _is_box_active_at(b, current_sec)])
                if custom_brush_items:
                    active_frame_boxes.extend([b for b in custom_brush_items if _is_box_active_at(b, current_sec)])

                masked_frame = apply_masks_to_frame(frame, active_frame_boxes, effective_mask_config)
                if encoder.poll() is not None:
                    error = encoder.stderr.read().decode("utf-8", errors="replace") if encoder.stderr else ""
                    raise ValueError(f"Video encoding stopped early: {error[-1200:]}")
                encoder.stdin.write(np.ascontiguousarray(masked_frame).tobytes())
                if active_frame_boxes:
                    masked_frame_count += 1

                frame_idx += 1
                if progress_callback and total_frames > 0:
                    if frame_idx == 1 or frame_idx % 3 == 0:
                        pct = min(96.0, max(2.0, (frame_idx / float(total_frames)) * 96.0))
                        progress_callback(pct)

        finally:
            cap.release()
            try:
                encoder.stdin.close()
            except Exception:
                pass

        encode_error = encoder.stderr.read().decode("utf-8", errors="replace") if encoder.stderr else ""
        encode_code = encoder.wait()
        if encode_code != 0:
            if os.path.exists(output_video_path):
                os.remove(output_video_path)
            raise ValueError(f"Could not finish video encoding: {encode_error[-1200:]}")

        if masked_frame_count == 0:
            if os.path.exists(output_video_path):
                os.remove(output_video_path)
            raise ValueError("No matching targets were masked in the video. Detect or draw at least one target and try again.")

        if progress_callback:
            progress_callback(97.0)

        if progress_callback:
            progress_callback(100.0)

        return output_video_path

    @staticmethod
    def _create_object_tracker():
        """Create a MIL tracker across OpenCV's contrib and legacy API layouts."""
        candidates = [
            getattr(getattr(cv2, "TrackerMIL", None), "create", None),
            getattr(cv2, "TrackerMIL_create", None),
            getattr(getattr(getattr(cv2, "legacy", None), "TrackerMIL", None), "create", None),
            getattr(getattr(cv2, "legacy", None), "TrackerMIL_create", None),
        ]
        for create_tracker in candidates:
            if callable(create_tracker):
                try:
                    return create_tracker()
                except Exception:
                    continue
        return None
