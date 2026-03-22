#!/usr/bin/env python3
"""
stitch_metadata.py — Direct spherical projection stitcher for PanoCraft captures.

Instead of feature matching, this uses the IMU-tracked 3D vectors stored in
capture_metadata.json to place each photo directly onto an equirectangular canvas.

How it works
------------
For every pixel (x, y) in the output equirectangular image we compute the
corresponding 3D ray direction (longitude, latitude → unit vector in world
space).  For each captured photo we know the exact camera forward vector
(capturedVector) from the IMU.  We rotate the world ray into camera-local
space, check whether it falls inside the camera's field-of-view, and if so
sample the source image with bilinear interpolation.  Contributions from
overlapping shots are blended with a cosine-squared weight (higher weight near
the image centre, fading toward the edges) so seams are invisible.

Works well for featureless scenes (plain ceilings, white walls) where
feature-matching stitchers (cpfind / SIFT) fail completely.
"""

import json
import logging
import math
import os

import numpy as np
from PIL import Image

logger = logging.getLogger("stitch_metadata")

# ---------------------------------------------------------------------------
# FOV estimation
# ---------------------------------------------------------------------------

# EXIF tag IDs
_TAG_FOCAL_LENGTH_35MM = 41989   # FocalLengthIn35mmFilm
_TAG_FOCAL_LENGTH      = 37386   # FocalLength (actual, in mm)
_TAG_EXIF_OFFSET       = 34665

# 35 mm full-frame sensor half-width (mm)
_SENSOR_HALF_WIDTH_35MM = 18.0


def _estimate_fov_h(img_path: str, img_w: int, img_h: int,
                    default_deg: float = 65.0) -> float:
    """Return estimated horizontal FOV in radians.

    Tries EXIF FocalLengthIn35mmFilm first, then falls back to default_deg.
    """
    try:
        img = Image.open(img_path)
        exif_raw = img.getexif()
        if exif_raw:
            fl_35 = exif_raw.get(_TAG_FOCAL_LENGTH_35MM)
            if fl_35 and fl_35 > 0:
                fov = 2.0 * math.atan(_SENSOR_HALF_WIDTH_35MM / float(fl_35))
                logger.info("EXIF 35 mm focal=%d mm → hFOV=%.1f°", fl_35,
                            math.degrees(fov))
                return fov
    except Exception:
        pass
    logger.info("Using default hFOV=%.1f°", default_deg)
    return math.radians(default_deg)


# ---------------------------------------------------------------------------
# Camera basis
# ---------------------------------------------------------------------------

_WORLD_UP  = np.array([0.0, 1.0, 0.0])
_WORLD_FWD = np.array([0.0, 0.0, 1.0])


def _camera_basis(fwd_vec):
    """Compute orthonormal (forward, right, up) camera basis.

    Assumes zero roll — camera up is aligned with world up projected
    perpendicular to the forward direction.  Handles near-vertical shots
    (zenith / nadir) by switching the reference to world-forward.

    Coordinate convention (same as CameraCapture.tsx):
        +X = right,  +Y = up,  +Z = forward (initial "front" direction)
    """
    fwd = np.asarray(fwd_vec, dtype=np.float64)
    norm = np.linalg.norm(fwd)
    if norm < 1e-9:
        raise ValueError(f"Zero-length forward vector: {fwd_vec}")
    fwd /= norm

    # Choose a reference vector not parallel to fwd
    ref = _WORLD_FWD if abs(float(np.dot(fwd, _WORLD_UP))) > 0.95 else _WORLD_UP

    # right = cross(ref, fwd)  →  when fwd=(0,0,1), ref=(0,1,0): right=(1,0,0) ✓
    right = np.cross(ref, fwd)
    right /= np.linalg.norm(right)

    # up = cross(fwd, right)  →  when fwd=(0,0,1), right=(1,0,0): up=(0,1,0) ✓
    up = np.cross(fwd, right)
    up /= np.linalg.norm(up)

    return fwd, right, up


# ---------------------------------------------------------------------------
# Core stitcher
# ---------------------------------------------------------------------------

def stitch_from_metadata(
    metadata_path: str,
    stills_dir: str,
    output_path: str,
    width: int = 4096,
    default_fov_deg: float = 77.0.0,
    chunk_rows: int = 256,
) -> dict:
    """Stitch a PanoCraft photo-sphere capture into an equirectangular panorama.

    Parameters
    ----------
    metadata_path : str
        Path to capture_metadata.json written by CameraCapture.tsx.
    stills_dir : str
        Directory containing shot_001.jpg … shot_N.jpg.
    output_path : str
        Destination JPEG path for the equirectangular output.
    width : int
        Output width in pixels; height = width // 2.
    default_fov_deg : float
        Horizontal FOV used when EXIF data is unavailable.
    chunk_rows : int
        Process this many equirectangular rows at a time to limit peak RAM.

    Returns
    -------
    dict with keys: output_path, width, height, shots_used
    """
    with open(metadata_path, encoding="utf-8") as f:
        metadata = json.load(f)

    shots = metadata.get("shots", [])
    if not shots:
        raise ValueError("No shots found in capture_metadata.json")

    height = width // 2
    logger.info("Metadata stitch: %d shots → %d×%d equirectangular",
                len(shots), width, height)

    # ------------------------------------------------------------------
    # Pre-load all images and compute per-shot camera parameters
    #
    # Camera placement strategy: use targetVector (the mathematically
    # perfect 45°-spaced grid) for projection, not capturedVector.
    # Reason: capturedVector has ±3–5° IMU noise which causes blurring
    # in the blend zone between adjacent shots.  The targetVector grid
    # is exact, so adjacent shots meet at the correct boundary with no
    # content mismatch.  The 3–5° capture error is absorbed inside each
    # shot's "own" 80% central zone where there is no blending.
    # ------------------------------------------------------------------
    shot_data = []
    fov_h = None
    brightness_sum = 0.0
    brightness_count = 0

    for shot in shots:
        idx = shot["index"]

        # Use capturedVector — actual capture direction, so content in the
        # blend zone of adjacent shots shows the same physical area from the
        # same actual angle, giving clean cross-fades without ghosting.
        cv = shot.get("targetVector") or shot.get("capturedVector", {})
        fwd_vec = [cv.get("x", 0.0), cv.get("y", 0.0), cv.get("z", 1.0)]

        # Find image
        img_path = None
        for ext in ("jpg", "jpeg", "png", "webp"):
            candidate = os.path.join(stills_dir, f"shot_{idx:03d}.{ext}")
            if os.path.isfile(candidate):
                img_path = candidate
                break
        if img_path is None:
            logger.warning("Shot %d: file not found in %s — skipping", idx, stills_dir)
            continue

        img = Image.open(img_path).convert("RGB")
        img_w, img_h = img.size
        img_arr = np.array(img, dtype=np.float32)

        # Per-shot mean brightness for exposure normalisation
        mean_brightness = float(img_arr.mean())
        brightness_sum += mean_brightness
        brightness_count += 1

        # FOV — determined once from the first image
        if fov_h is None:
            fov_h = _estimate_fov_h(img_path, img_w, img_h, default_fov_deg)

        fov_v = 2.0 * math.atan(math.tan(fov_h / 2.0) * img_h / img_w)
        tan_h = math.tan(fov_h / 2.0)
        tan_v = math.tan(fov_v / 2.0)

        try:
            fwd, right, up = _camera_basis(fwd_vec)
        except ValueError as e:
            logger.warning("Shot %d: bad vector (%s) — skipping", idx, e)
            continue

        shot_data.append(dict(
            index=idx,
            fwd=fwd, right=right, up=up,
            tan_h=tan_h, tan_v=tan_v,
            img_arr=img_arr, img_w=img_w, img_h=img_h,
            mean_brightness=mean_brightness,
        ))

    if not shot_data:
        raise ValueError("No usable shots found")

    global_mean = brightness_sum / brightness_count
    logger.info("Loaded %d / %d shots  (global brightness=%.1f)",
                len(shot_data), len(shots), global_mean)

    # ------------------------------------------------------------------
    # Per-shot exposure normalisation.
    # Sample a 32×32 pixel patch at the centre of each shot's image and
    # compute the mean luminance.  Derive a per-shot gain so all centre
    # patches match the global mean.  Centre pixels are deepest inside the
    # FOV, so they're free of edge vignetting and reliably represent the
    # shot's exposure level.
    # ------------------------------------------------------------------
    for sd in shot_data:
        arr = sd["img_arr"]
        iw, ih = sd["img_w"], sd["img_h"]
        cx, cy = iw // 2, ih // 2
        patch = arr[cy - 16:cy + 16, cx - 16:cx + 16]
        patch_mean = float(patch.mean()) if patch.size > 0 else sd["mean_brightness"]
        raw_gain = (global_mean / patch_mean) if patch_mean > 1.0 else 1.0
        # Cap gain to a plausible range — shots with very dark/bright centres
        # (e.g. nadir/zenith or window-facing) would otherwise get extreme
        # corrections that look worse than leaving the exposure as-is.
        sd["gain"] = float(np.clip(raw_gain, 0.5, 2.0))
        if abs(sd["gain"] - 1.0) > 0.05:
            logger.info("Shot %d  centre=%.1f  raw_gain=%.3f  clamped=%.3f",
                        sd["index"], patch_mean, raw_gain, sd["gain"])

    # ------------------------------------------------------------------
    # Build equirectangular canvas row-by-row to keep RAM manageable.
    #
    # Blending strategy (hybrid):
    #   Inner zone (d < INNER_ZONE): winner-takes-all — clean, no parallax
    #     ghosting in the sharp centre content of each shot.
    #   Blend zone (d >= INNER_ZONE, inside FOV): weighted average —
    #     smoothly cross-fades between overlapping shots so exposure
    #     differences don't create hard seam lines.
    #
    # With 45° shot spacing and 65° hFOV, adjacent shots overlap in a
    # ~12.5° strip around each seam.  Setting INNER_ZONE=0.60 means the
    # blend zone starts 19.5° from each shot centre, which fully covers
    # that overlap strip and produces seamless transitions.
    # ------------------------------------------------------------------
    # Accumulator arrays for weighted-average blending
    weight_acc = np.zeros((height, width),    dtype=np.float32)
    canvas_acc = np.zeros((height, width, 3), dtype=np.float32)
    # Best-weight map for winner-takes-all in the inner zone
    best_wta   = np.zeros((height, width),    dtype=np.float32)
    canvas_wta = np.zeros((height, width, 3), dtype=np.float32)

    px_idx  = np.arange(width, dtype=np.float64)
    lon_row = (px_idx / width) * 2.0 * math.pi - math.pi   # (W,)

    INNER_ZONE = 0.60   # d < this → winner-takes-all (no ghosting)
    # Cosine ramp from INNER_ZONE (weight=1) to 1.0 (weight=0 at FOV edge)

    for row_start in range(0, height, chunk_rows):
        row_end  = min(row_start + chunk_rows, height)
        py_chunk = np.arange(row_start, row_end, dtype=np.float64)

        lat_chunk = math.pi / 2.0 - (py_chunk / height) * math.pi   # (R,)

        lat2d = lat_chunk[:, np.newaxis]
        lon2d = lon_row[np.newaxis, :]

        cos_lat = np.cos(lat2d)
        ray_x = cos_lat * np.sin(lon2d)
        ray_y = np.sin(lat2d) * np.ones_like(lon2d)
        ray_z = cos_lat * np.cos(lon2d)
        rays  = np.stack([ray_x, ray_y, ray_z], axis=-1)   # (R, W, 3)

        # Views into global arrays for this chunk
        chunk_wta_best   = best_wta[row_start:row_end]
        chunk_wta_canvas = canvas_wta[row_start:row_end]
        chunk_w_acc      = weight_acc[row_start:row_end]
        chunk_c_acc      = canvas_acc[row_start:row_end]

        for sd in shot_data:
            fwd, right, up = sd["fwd"], sd["right"], sd["up"]
            tan_h, tan_v   = sd["tan_h"], sd["tan_v"]
            img_arr        = sd["img_arr"]
            img_w, img_h   = sd["img_w"], sd["img_h"]
            gain           = sd["gain"]

            local_z = rays @ fwd
            local_x = rays @ right
            local_y = rays @ up

            in_front = local_z > 0.0

            with np.errstate(divide="ignore", invalid="ignore"):
                u = np.where(in_front, local_x / (local_z * tan_h), 2.0)
                v = np.where(in_front, local_y / (local_z * tan_v), 2.0)

            in_fov = in_front & (u > -1.0) & (u < 1.0) & (v > -1.0) & (v < 1.0)
            if not in_fov.any():
                continue

            d = np.maximum(np.abs(u), np.abs(v))

            # Cosine-ramp blend weight (1.0 at centre, 0.0 at FOV edge)
            t = np.clip((d - INNER_ZONE) / (1.0 - INNER_ZONE), 0.0, 1.0)
            weight = np.where(in_fov,
                              (0.5 * (1.0 + np.cos(math.pi * t))).astype(np.float32),
                              0.0).astype(np.float32)

            px_coord = np.clip((u + 1.0) / 2.0 * (img_w - 1), 0.0, img_w - 1.0)
            py_coord = np.clip((1.0 - v) / 2.0 * (img_h - 1), 0.0, img_h - 1.0)

            px0 = px_coord.astype(np.int32)
            py0 = py_coord.astype(np.int32)
            px1 = np.minimum(px0 + 1, img_w - 1)
            py1 = np.minimum(py0 + 1, img_h - 1)
            fx  = (px_coord - px0)[..., np.newaxis].astype(np.float32)
            fy  = (py_coord - py0)[..., np.newaxis].astype(np.float32)

            color = (img_arr[py0, px0] * (1.0 - fx) * (1.0 - fy)
                   + img_arr[py0, px1] * fx          * (1.0 - fy)
                   + img_arr[py1, px0] * (1.0 - fx) * fy
                   + img_arr[py1, px1] * fx          * fy)

            # Apply clamped exposure gain
            if abs(gain - 1.0) > 0.01:
                color = np.clip(color * gain, 0.0, 255.0)

            # --- Inner zone: winner-takes-all ---
            inner = in_fov & (d < INNER_ZONE)  # weight=1.0 in here
            improve = inner & (weight > chunk_wta_best)
            if improve.any():
                chunk_wta_canvas[improve] = color[improve]
                chunk_wta_best[improve]   = weight[improve]

            # --- Blend zone: weighted accumulation ---
            blend = in_fov & (d >= INNER_ZONE)
            if blend.any():
                w3 = weight[..., np.newaxis]
                chunk_c_acc[blend]  += (color * w3)[blend]
                chunk_w_acc[blend]  += weight[blend]

        logger.debug("Rows %d–%d complete", row_start, row_end - 1)

    # ------------------------------------------------------------------
    # Merge WTA inner zone and weighted-average blend zone into final canvas
    # ------------------------------------------------------------------
    inner_mask = best_wta > 0.0           # pixels covered by inner zone
    blend_mask = weight_acc > 0.0         # pixels covered by blend zone
    covered    = inner_mask | blend_mask

    canvas = np.zeros((height, width, 3), dtype=np.float32)
    # Fill blend zone first (lower priority)
    if blend_mask.any():
        safe_w = np.where(blend_mask, weight_acc, 1.0)[..., np.newaxis]
        canvas[blend_mask] = (canvas_acc / safe_w)[blend_mask]
    # Overwrite with WTA inner zone (higher priority, no ghosting)
    if inner_mask.any():
        canvas[inner_mask] = canvas_wta[inner_mask]

    # ------------------------------------------------------------------
    # Coverage check
    # ------------------------------------------------------------------
    out = canvas
    uncovered = int((~covered).sum())
    if uncovered:
        coverage_pct = 100.0 * (1.0 - uncovered / (height * width))
        logger.warning("%d pixels uncovered — sphere coverage %.1f%%",
                       uncovered, coverage_pct)
    else:
        logger.info("Full sphere coverage ✓")

    result_img = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))
    result_img.save(output_path, quality=92, optimize=True)
    out_w, out_h = result_img.size
    logger.info("Metadata stitch saved: %s (%d×%d)", output_path, out_w, out_h)

    return {
        "output_path":  output_path,
        "final_size":   (out_w, out_h),
        "shots_used":   len(shot_data),
        # Full equirectangular projection range
        "proj_range": {
            "min_lon": -math.pi,
            "max_lon":  math.pi,
            "min_lat": -math.pi / 2.0,
            "max_lat":  math.pi / 2.0,
        },
    }


# ---------------------------------------------------------------------------
# CLI entry point for standalone testing
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse, sys

    logging.basicConfig(level=logging.INFO,
                        format="%(levelname)s %(name)s: %(message)s")

    ap = argparse.ArgumentParser(description="Metadata-based sphere stitcher")
    ap.add_argument("metadata",  help="Path to capture_metadata.json")
    ap.add_argument("stills",    help="Directory containing shot_NNN.jpg files")
    ap.add_argument("output",    help="Output JPEG path")
    ap.add_argument("--width",   type=int, default=4096)
    ap.add_argument("--fov",     type=float, default=65.0,
                    help="Default horizontal FOV in degrees (used if EXIF unavailable)")
    args = ap.parse_args()

    result = stitch_from_metadata(
        args.metadata, args.stills, args.output,
        width=args.width, default_fov_deg=args.fov,
    )
    print(json.dumps(result, indent=2))
