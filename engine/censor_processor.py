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

# Path to local YuNet ONNX model
MODEL_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models")
YUNET_PATH = os.path.join(MODEL_DIR, "face_detection_yunet_2023mar.onnx")
EMOJI_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "assets", "emojis")


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
    mask_type: Optional[str] = None

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
            "landmarks": [[round(float(x), 2), round(float(y), 2)] for x, y in (self.landmarks or [])]
        }
        if self.kind != "box":
            data["kind"] = self.kind
        if self.brush_points:
            data["brush_points"] = [[round(float(px), 2), round(float(py), 2)] for px, py in self.brush_points]
            data["brush_radius"] = round(float(self.brush_radius), 2)
        if self.mask_type:
            data["mask_type"] = self.mask_type
        return data


@dataclass
class MaskConfig:
    mask_type: Literal["blur", "pixelate", "emoji", "redact"] = "blur"
    intensity: int = 50                 # 1 to 100
    emoji_name: str = "sunglasses"      # sunglasses, smiley, clown, censored, poop
    custom_sticker_path: Optional[str] = None
    redact_text: Optional[str] = "[CENSORED]"
    shape: Literal["oval", "rect"] = "oval"
    mask_region: Literal["face", "eyes"] = "face"
    padding_percent: float = 0.20       # 20% extra padding around detected face


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

    def detect(self, img_bgr: np.ndarray, padding_percent: float = 0.0) -> List[BoundingBox]:
        """
        Detects faces in a BGR image using OpenCV YuNet, filtering out body/torso
        false positives via geometry, landmark anatomy, and skin-continuity checks.
        """
        if img_bgr is None or self._detector is None:
            return []

        h, w = img_bgr.shape[:2]
        if w < 10 or h < 10:
            return []

        max_dim = max(w, h)
        scale = 1.0
        if max_dim > 1080:
            scale = 960.0 / float(max_dim)
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
            if aspect < 0.55 or aspect > 1.38:
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

            if padding_percent > 0.0:
                pad_w = int(bw * padding_percent)
                pad_h = int(bh * padding_percent)
                x1 = max(0, int(bx - pad_w))
                y1 = max(0, int(by - pad_h * 1.1))
                x2 = min(w, int(bx + bw + pad_w))
                y2 = min(h, int(by + bh + pad_h * 0.5))
            else:
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


def _clip_box_away_from_faces(box: BoundingBox, face_boxes: List[BoundingBox]) -> Optional[BoundingBox]:
    """Ensures an NSFW box never overlaps any detected face region."""
    x1, y1, x2, y2 = box.x, box.y, box.x2, box.y2
    for fb in face_boxes:
        horiz_overlap = min(x2, fb.x2) - max(x1, fb.x)
        vert_overlap = min(y2, fb.y2) - max(y1, fb.y)
        if horiz_overlap > 0 and vert_overlap > 0:
            y1 = max(y1, fb.y2 + 4)
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


class VideoFaceTracker:
    """Robust track-by-detection associator with confirmation hysteresis."""

    def __init__(self, detector: FaceDetector, max_lost_frames: int = 8, padding_percent: float = 0.20):
        self.detector = detector
        self.max_lost_frames = max_lost_frames
        self.padding_percent = padding_percent
        self.next_track_id = 1
        self.active_tracks: Dict[int, dict] = {}
        # Detect every frame. Reusing an unchanged box for two frames caused
        # visible gaps whenever a subject moved quickly or turned their head.
        self.detection_interval = 1
        self.last_detection_frame = -self.detection_interval

    def update(self, frame_bgr: np.ndarray, frame_idx: int) -> List[BoundingBox]:
        if self.active_tracks and frame_idx - self.last_detection_frame < self.detection_interval:
            return [
                tinfo["smoothed_box"]
                for tinfo in self.active_tracks.values()
                if tinfo.get("confirmed", True)
            ]

        detected_boxes = self.detector.detect(frame_bgr, padding_percent=self.padding_percent)
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

def _build_feathered_oval_mask(w_roi: int, h_roi: int) -> np.ndarray:
    """Create a smooth elliptical alpha mask that decays to zero inside the ROI bounds."""
    mask_w, mask_h = max(32, min(160, w_roi)), max(24, min(160, h_roi))
    mask = np.zeros((mask_h, mask_w), dtype=np.float32)
    # Keep the feather inside a narrow edge band. The old 0.38 radii left a
    # large unmasked rim inside the detected target, which was especially
    # visible on moving faces and the widened eyes-only region.
    axes = (max(4, int(mask_w * 0.47)), max(4, int(mask_h * 0.47)))
    cv2.ellipse(mask, (mask_w // 2, mask_h // 2), axes, 0, 0, 360, 1.0, -1)
    ksize = max(5, (min(mask_w, mask_h) // 6) | 1)
    mask = cv2.GaussianBlur(mask, (ksize, ksize), 0)
    mask = cv2.resize(mask, (w_roi, h_roi), interpolation=cv2.INTER_LINEAR)
    return np.clip(mask, 0.0, 1.0)[:, :, np.newaxis]


def apply_gaussian_blur(img: np.ndarray, box: BoundingBox, intensity: int, shape: str = "oval") -> np.ndarray:
    h_img, w_img = img.shape[:2]
    pad_x = int(box.w * 0.06)
    pad_y = int(box.h * 0.06)
    x1, y1 = max(0, box.x - pad_x), max(0, box.y - pad_y)
    x2, y2 = min(w_img, box.x2 + pad_x), min(h_img, box.y2 + pad_y)
    w_roi, h_roi = x2 - x1, y2 - y1

    if w_roi < 4 or h_roi < 4:
        return img

    strength = max(1, min(100, int(intensity))) / 100.0
    roi = img[y1:y2, x1:x2]
    keep_ratio = 0.015 + ((1.0 - strength) ** 1.6) * 0.14
    small_w = max(4, int(w_roi * keep_ratio))
    small_h = max(4, int(h_roi * keep_ratio))
    small = cv2.resize(roi, (small_w, small_h), interpolation=cv2.INTER_AREA)
    small = cv2.GaussianBlur(small, (5, 5), 0)
    blurred = cv2.resize(small, (w_roi, h_roi), interpolation=cv2.INTER_CUBIC)

    if shape == "oval":
        mask_3d = _build_feathered_oval_mask(w_roi, h_roi)
        composite = (blurred * mask_3d + roi * (1.0 - mask_3d)).astype(np.uint8)
        img[y1:y2, x1:x2] = composite
    else:
        img[y1:y2, x1:x2] = blurred

    return img


def apply_pixelate(img: np.ndarray, box: BoundingBox, intensity: int, shape: str = "oval") -> np.ndarray:
    h_img, w_img = img.shape[:2]
    pad_x = int(box.w * 0.06)
    pad_y = int(box.h * 0.06)
    x1, y1 = max(0, box.x - pad_x), max(0, box.y - pad_y)
    x2, y2 = min(w_img, box.x2 + pad_x), min(h_img, box.y2 + pad_y)
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

    if shape == "oval":
        mask_3d = _build_feathered_oval_mask(w_roi, h_roi)
        img[y1:y2, x1:x2] = (pixelated * mask_3d + roi * (1.0 - mask_3d)).astype(np.uint8)
    else:
        img[y1:y2, x1:x2] = pixelated

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
    text: Optional[str] = "[CENSORED]"
) -> np.ndarray:
    h_img, w_img = img.shape[:2]
    x1, y1 = max(0, box.x), max(0, box.y)
    x2, y2 = min(w_img, box.x2), min(h_img, box.y2)

    if x2 <= x1 or y2 <= y1:
        return img

    cv2.rectangle(img, (x1, y1), (x2, y2), (18, 18, 18), -1)
    cv2.rectangle(img, (x1, y1), (x2, y2), (220, 20, 60), 2)

    if text:
        text_str = str(text).strip()
        font = cv2.FONT_HERSHEY_DUPLEX
        bw = x2 - x1
        bh = y2 - y1
        base_scale = min(bw / 160.0, bh / 40.0)
        font_scale = max(0.4, min(1.2, base_scale))
        thickness = 1 if font_scale < 0.7 else 2

        (tw, th), _ = cv2.getTextSize(text_str, font, font_scale, thickness)
        tx = x1 + (bw - tw) // 2
        ty = y1 + (bh + th) // 2

        if tw < bw and th < bh:
            cv2.putText(img, text_str, (tx, ty), font, font_scale, (255, 255, 255), thickness, cv2.LINE_AA)

    return img


def _apply_brush_stroke_mask(
    img: np.ndarray,
    box: BoundingBox,
    config: MaskConfig,
    effect_type: str,
) -> np.ndarray:
    """Apply soft-feathered blur, pixelate, or solid redaction along a freehand polyline stroke."""
    points = box.brush_points or []
    if not points:
        return img

    h_img, w_img = img.shape[:2]
    radius = max(4.0, float(box.brush_radius or 24.0))
    feather_pad = max(4, int(round(radius * 0.35))) if config.shape == "oval" else 2
    margin = int(math.ceil(radius)) + feather_pad

    xs = [float(p[0]) for p in points]
    ys = [float(p[1]) for p in points]
    x1 = max(0, int(math.floor(min(xs) - margin)))
    y1 = max(0, int(math.floor(min(ys) - margin)))
    x2 = min(w_img, int(math.ceil(max(xs) + margin)))
    y2 = min(h_img, int(math.ceil(max(ys) + margin)))
    w_roi, h_roi = x2 - x1, y2 - y1
    if w_roi < 4 or h_roi < 4:
        return img

    mask = np.zeros((h_roi, w_roi), dtype=np.float32)
    thickness = max(2, int(round(radius * 2.0)))
    rel_pts = [(int(round(px - x1)), int(round(py - y1))) for px, py in points]
    if len(rel_pts) == 1:
        cv2.circle(mask, rel_pts[0], max(2, int(round(radius))), 1.0, -1, lineType=cv2.LINE_AA)
    else:
        for i in range(len(rel_pts) - 1):
            cv2.line(mask, rel_pts[i], rel_pts[i + 1], 1.0, thickness=thickness, lineType=cv2.LINE_AA)
        cv2.circle(mask, rel_pts[-1], max(2, int(round(radius))), 1.0, -1, lineType=cv2.LINE_AA)

    if config.shape == "oval":
        ksize = max(5, int(round(radius * 0.45)) | 1)
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
        keep_ratio = 0.015 + ((1.0 - strength) ** 1.6) * 0.14
        small_w = max(4, int(w_roi * keep_ratio))
        small_h = max(4, int(h_roi * keep_ratio))
        small = cv2.resize(roi, (small_w, small_h), interpolation=cv2.INTER_AREA)
        small = cv2.GaussianBlur(small, (5, 5), 0)
        filtered = cv2.resize(small, (w_roi, h_roi), interpolation=cv2.INTER_CUBIC)

    img[y1:y2, x1:x2] = (filtered * alpha_3d + roi * (1.0 - alpha_3d)).astype(np.uint8)
    return img


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
        if config.mask_region == "eyes" and (box.landmarks or box.label.startswith("Face #") or box.label == "Face"):
            # YuNet landmark order: left eye, right eye, nose, left mouth, right mouth.
            # Keep a small brow/bridge margin so the eyes stay covered while the rest
            # of the face remains visible. The proportional fallback supports manual
            # boxes and older saved edits that do not contain landmarks.
            if box.landmarks and len(box.landmarks) >= 2:
                eye_a, eye_b = box.landmarks[0], box.landmarks[1]
                eye_distance = math.hypot(eye_b[0] - eye_a[0], eye_b[1] - eye_a[1])
                center_x = (eye_a[0] + eye_b[0]) / 2.0
                center_y = (eye_a[1] + eye_b[1]) / 2.0
                # YuNet's eye landmarks rotate with the face. Build an axis
                # aligned safety band around both eye points instead of a narrow
                # horizontal strip centered on their average; the latter leaks
                # at the corners on tilted faces.
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
        if effect_type == "blur":
            output = apply_gaussian_blur(output, mask_box, config.intensity, config.shape)
        elif effect_type == "pixelate":
            output = apply_pixelate(output, mask_box, config.intensity, config.shape)
        elif effect_type == "emoji":
            output = apply_emoji_overlay(output, mask_box, config.emoji_name, config.custom_sticker_path)
        elif effect_type == "redact":
            output = apply_redact_bar(output, mask_box, config.redact_text)
        else:
            output = apply_gaussian_blur(output, mask_box, config.intensity, config.shape)
    return output


# --- Main Processor Facade ---

class CensorProcessor:
    """Main facade for diversified photo and video privacy and censorship tasks."""

    def __init__(self, model_path: str = YUNET_PATH):
        self.detector = FaceDetector(model_path=model_path)

    def detect_image_faces(self, image_path: str, padding_percent: float = 0.20) -> List[BoundingBox]:
        """Detects faces in a static image file."""
        img = safe_imread(image_path)
        if img is None:
            raise ValueError(f"Could not read image file: {image_path}")
        return self.detector.detect(img, padding_percent=padding_percent)

    def detect_image_nsfw(self, image_path: str, sensitivity: float = 0.5) -> List[BoundingBox]:
        """Detects candidate NSFW/sensitive regions in an image."""
        img = safe_imread(image_path)
        if img is None:
            raise ValueError(f"Could not read image file: {image_path}")
        return detect_nsfw_candidates(img, sensitivity=sensitivity)

    def process_image(
        self,
        image_path: str,
        output_path: str,
        mask_config: MaskConfig,
        custom_boxes: Optional[List[BoundingBox]] = None,
        auto_detect_all: bool = False,
        auto_detect_nsfw: bool = False,
        nsfw_sensitivity: float = 0.5
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
            boxes.extend(self.detector.detect(img, padding_percent=mask_config.padding_percent))
        if auto_detect_nsfw:
            boxes.extend(detect_nsfw_candidates(img, sensitivity=nsfw_sensitivity))

        if not boxes:
            raise ValueError("No targets were detected or selected to mask.")

        result_bgr = apply_masks_to_frame(img, boxes, mask_config)
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
        progress_callback: Optional[Callable[[float], None]] = None
    ) -> str:
        """
        Diversified video censor with continuous face tracking, single-face focus,
        or MIL object tracking for specific objects (license plates, custom boxes).
        """
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

        # Encode masked frames once. The old path wrote every frame to an MP4V
        # intermediate, then decoded and re-encoded the whole file with FFmpeg.
        ffmpeg_cmd = [
            ffmpeg, "-y", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "bgr24",
            "-video_size", f"{width}x{height}", "-framerate", str(fps), "-i", "pipe:0",
            "-i", input_video_path,
            "-map", "0:v:0", "-map", "1:a?", "-map_metadata", "0",
            "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
            output_video_path
        ]
        encoder = subprocess.Popen(ffmpeg_cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if encoder.stdin is None:
            cap.release()
            raise ValueError("Could not start the video encoder.")

        if progress_callback:
            progress_callback(2.0)

        # Initialize object trackers if in specific_object mode
        object_trackers: List[cv2.Tracker] = []
        if mode == "specific_object" and track_custom_objects and custom_boxes:
            ret, first_frame = cap.read()
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            if ret and first_frame is not None:
                for c_box in custom_boxes:
                    tr = self._create_object_tracker()
                    if tr is None:
                        break
                    if tr.init(first_frame, (c_box.x, c_box.y, c_box.w, c_box.h)) is False:
                        continue
                    object_trackers.append(tr)

        face_tracker = VideoFaceTracker(self.detector, max_lost_frames=8, padding_percent=mask_config.padding_percent)
        nsfw_face_tracker = VideoFaceTracker(self.detector, max_lost_frames=8, padding_percent=0.10) if mode == "nsfw" else None
        nsfw_tracks: Dict[int, dict] = {}
        nsfw_next_id = 1
        resolved_single_id: Optional[int] = selected_track_id if (mode == "face_single" and selected_face_box is None) else None
        last_focused_box: Optional[BoundingBox] = selected_face_box
        excluded_track_ids: Set[int] = set()
        pending_excluded_boxes: List[BoundingBox] = list(excluded_face_boxes or [])
        frame_idx = 0
        masked_frame_count = 0

        try:
            while True:
                ret, frame = cap.read()
                if not ret:
                    break

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
                        for tr in object_trackers:
                            ok, bbox = tr.update(frame)
                            if ok:
                                bx, by, bw, bh = [int(v) for v in bbox]
                                active_frame_boxes.append(BoundingBox(
                                    x=max(0, bx),
                                    y=max(0, by),
                                    w=min(width - bx, bw),
                                    h=min(height - by, bh),
                                    label="Object"
                                ))
                    elif custom_boxes:
                        active_frame_boxes.extend(custom_boxes)

                elif mode == "nsfw":
                    tracked_faces = nsfw_face_tracker.update(frame, frame_idx) if nsfw_face_tracker is not None else []
                    raw_nsfw = detect_nsfw_candidates(
                        frame,
                        sensitivity=nsfw_sensitivity,
                        face_boxes=tracked_faces,
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
                            if nsfw_tracks[tid]["lost"] > 4:
                                stale_nsfw.append(tid)
                            else:
                                clipped = _clip_box_away_from_faces(nsfw_tracks[tid]["box"], tracked_faces)
                                if clipped is not None:
                                    active_frame_boxes.append(clipped)
                        else:
                            active_frame_boxes.append(nsfw_tracks[tid]["box"])
                    for tid in stale_nsfw:
                        del nsfw_tracks[tid]

                if custom_boxes and mode != "specific_object":
                    active_frame_boxes.extend(custom_boxes)

                masked_frame = apply_masks_to_frame(frame, active_frame_boxes, mask_config)
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
