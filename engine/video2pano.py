#!/usr/bin/env python3
"""video2pano.py - Convert video to panorama using selectable stitcher backends.

Extracts frames from a video, scores them for quality/sharpness,
selects the best sequential frames, and stitches them into a panorama.

Usage:
    python3 video2pano.py input.mp4
    python3 video2pano.py input.mp4 --output-dir ./results --keep-frames
    python3 video2pano.py input.mp4 --verbose

All structured output goes to stdout as JSON.
Progress/debug info goes to stderr.
"""

import argparse
import configparser
import gc
import json
import logging
import math
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

logger = logging.getLogger("video2pano")

HUGIN_REQUIRED_TOOLS = (
    "pto_gen",
    "cpfind",
    "autooptimiser",
    "pano_modify",
    "nona",
    "enblend",
)
DEFAULT_HUGIN_ENV_PATHS = (
    os.path.expanduser("~/micromamba/envs/hugin-cli/bin"),
    os.path.expanduser("~/mambaforge/envs/hugin-cli/bin"),
    os.path.expanduser("~/miniforge3/envs/hugin-cli/bin"),
)

# --- Exit codes ---
EXIT_SUCCESS = 0
EXIT_QUALITY_TOO_LOW = 1
EXIT_INPUT_ERROR = 2
EXIT_STITCHER_ERROR = 3
EXIT_INTERNAL_ERROR = 4


# --- Config loading ---

def _default_config():
    """Return a dict of all default config values."""
    return {
        "quality": {
            "base_filesize_threshold": 120_000,
            "base_resolution_pixels": 1920 * 1080,
            "laplacian_ratio_threshold": 0.4,
            "min_sharpness_pass_rate": 0.08,
        },
        "frames": {
            "min_frames": 8,
            "max_frames": 80,
        },
        "camera": {
            "default_focal_length_mm": 26,
        },
        "sift": {
            "sift_working_size": 1200,
            "num_octave_high_res": 5,
            "num_octave_low_res": 4,
            "low_res_threshold": 1000,
            "num_scale": 7,
            "scale_factor": 1.4142135623,
            "gauss_sigma": 1.4142135623,
            "gauss_window_factor": 4,
            "contrast_thres_high_res": 1.5e-2,
            "contrast_thres_low_res": 1e-2,
            "judge_extrema_diff_thres": 1e-3,
            "edge_ratio": 12,
            "pre_color_thres": 2e-2,
            "calc_offset_depth": 4,
            "offset_thres": 0.5,
        },
        "matching": {
            "ori_radius": 4.5,
            "ori_hist_smooth_count": 2,
            "desc_hist_scale_factor": 3,
            "desc_int_factor": 512,
            "match_reject_next_ratio": 0.8,
        },
        "ransac": {
            "iterations": 2500,
            "base_inlier_thres": 3.5,
            "base_inlier_resolution": 800,
            "inlier_in_match_ratio": 0.05,
            "inlier_in_points_ratio": 0.02,
        },
        "optimization": {
            "straighten": 1,
            "slope_plain": 8e-3,
            "lm_lambda": 5,
            "multipass_ba": 1,
        },
        "output": {
            "max_output_size": 8000,
            "crop": 1,
            "multiband": 0,
        },
    }


def load_config(config_path=None):
    """Load config from .conf file, falling back to defaults.

    Returns a flat-ish namespace object for easy access: cfg["quality"]["base_filesize_threshold"]
    """
    cfg = _default_config()

    if config_path is None:
        # Look next to this script
        config_path = os.path.join(os.path.dirname(__file__), "video2pano.conf")

    if os.path.isfile(config_path):
        logger.debug("Loading config from %s", config_path)
        parser = configparser.ConfigParser()
        parser.read(config_path)
        for section in parser.sections():
            if section not in cfg:
                cfg[section] = {}
            for key, raw_val in parser.items(section):
                # Strip inline comments (everything after #)
                val_str = raw_val.split("#")[0].strip()
                # Auto-convert to int/float using the default value's type as hint
                default_val = cfg.get(section, {}).get(key)
                if isinstance(default_val, int) and not isinstance(default_val, bool):
                    try:
                        val = int(float(val_str))  # handles "2073600" and "1e6"
                    except ValueError:
                        val = val_str
                elif isinstance(default_val, float):
                    try:
                        val = float(val_str)
                    except ValueError:
                        val = val_str
                else:
                    # No type hint — try float then int
                    try:
                        val = float(val_str)
                        if val == int(val) and "." not in val_str and "e" not in val_str.lower():
                            val = int(val)
                    except (ValueError, OverflowError):
                        val = val_str
                cfg[section][key] = val
    else:
        logger.debug("No config file found at %s, using defaults", config_path)

    return cfg

# --- Stitcher config template ---
# All {placeholders} are substituted at runtime by generate_config() using values from video2pano.conf
VIDEO_CONFIG_TEMPLATE = """\
CYLINDER {mode_cylinder}
ESTIMATE_CAMERA {mode_estimate_camera}
TRANS 0

ORDERED_INPUT 1
CROP {crop}
MAX_OUTPUT_SIZE {max_output_size}
LAZY_READ 1

FOCAL_LENGTH {focal_length}

SIFT_WORKING_SIZE {sift_working_size}
NUM_OCTAVE {num_octave}
NUM_SCALE {num_scale}
SCALE_FACTOR {scale_factor}
GAUSS_SIGMA {gauss_sigma}
GAUSS_WINDOW_FACTOR {gauss_window_factor}

CONTRAST_THRES {contrast_thres}
JUDGE_EXTREMA_DIFF_THRES {judge_extrema_diff_thres}
EDGE_RATIO {edge_ratio}

PRE_COLOR_THRES {pre_color_thres}
CALC_OFFSET_DEPTH {calc_offset_depth}
OFFSET_THRES {offset_thres}

ORI_RADIUS {ori_radius}
ORI_HIST_SMOOTH_COUNT {ori_hist_smooth_count}
DESC_HIST_SCALE_FACTOR {desc_hist_scale_factor}
DESC_INT_FACTOR {desc_int_factor}

MATCH_REJECT_NEXT_RATIO {match_reject_next_ratio}
RANSAC_ITERATIONS {ransac_iterations}
RANSAC_INLIER_THRES {ransac_inlier_thres}

INLIER_IN_MATCH_RATIO {inlier_in_match_ratio}
INLIER_IN_POINTS_RATIO {inlier_in_points_ratio}

STRAIGHTEN {straighten}
SLOPE_PLAIN {slope_plain}
LM_LAMBDA {lm_lambda}
MULTIPASS_BA {multipass_ba}

MULTIBAND {multiband}
"""


# --- Exceptions ---

class Video2PanoError(Exception):
    def __init__(self, message, error_code, details=None):
        super().__init__(message)
        self.error_code = error_code
        self.details = details or {}


class InputError(Video2PanoError):
    pass


class QualityError(Video2PanoError):
    pass


class StitcherError(Video2PanoError):
    pass


def _run_checked(cmd, error_code, step_name, cwd=None):
    """Run a subprocess command and raise StitcherError on failure."""
    logger.debug("%s command: %s", step_name, " ".join(shlex.quote(part) for part in cmd))
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd)
    combined_output = (result.stdout or "") + (result.stderr or "")
    if result.returncode != 0:
        raise StitcherError(
            f"{step_name} failed",
            error_code,
            {
                "exit_code": result.returncode,
                "command": cmd,
                "output": combined_output[-4000:],
            },
        )
    return result


def _require_tools(tools, error_code, install_hint):
    """Ensure required external tools exist on PATH."""
    missing = [tool for tool in tools if not _resolve_tool(tool)]
    if missing:
        raise StitcherError(
            f"Missing required tools: {', '.join(missing)}. {install_hint}",
            error_code,
            {"missing_tools": missing},
        )


def _candidate_hugin_bin_dirs():
    """Return candidate directories containing Hugin CLI tools."""
    candidates = []
    env_dir = os.environ.get("HUGIN_BIN_DIR")
    if env_dir:
        candidates.append(env_dir)
    for path in DEFAULT_HUGIN_ENV_PATHS:
        if path not in candidates:
            candidates.append(path)
    return candidates


def _resolve_tool(tool):
    """Resolve a tool from PATH or known Hugin env locations."""
    resolved = shutil.which(tool)
    if resolved:
        return resolved
    for bin_dir in _candidate_hugin_bin_dirs():
        candidate = os.path.join(bin_dir, tool)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def _focal_mm_to_hfov_deg(focal_length_mm):
    """Convert 35mm-equivalent focal length to horizontal field of view."""
    if not focal_length_mm or focal_length_mm <= 0:
        return None
    return math.degrees(2.0 * math.atan(36.0 / (2.0 * focal_length_mm)))


# --- Video probing ---

def probe_video(video_path):
    """Extract video metadata using ffprobe.

    Returns dict with: width, height, fps, duration, total_frames, rotation, codec.
    """
    if not os.path.isfile(video_path):
        raise InputError(f"Video file not found: {video_path}", "INPUT_NOT_FOUND")

    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise InputError("ffprobe not found in PATH. Install ffmpeg.", "FFMPEG_MISSING")

    cmd = [
        ffprobe, "-v", "quiet", "-print_format", "json",
        "-show_streams", "-show_format", video_path
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise InputError(f"ffprobe failed: {result.stderr.strip()}", "INVALID_VIDEO")

    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        raise InputError("ffprobe returned invalid JSON", "INVALID_VIDEO")

    video_stream = None
    for stream in data.get("streams", []):
        if stream.get("codec_type") == "video":
            video_stream = stream
            break
    if not video_stream:
        raise InputError(f"No video stream found in: {video_path}", "INVALID_VIDEO")

    width = int(video_stream["width"])
    height = int(video_stream["height"])

    # Parse fps from r_frame_rate (e.g., "30000/1001")
    fps_str = video_stream.get("r_frame_rate", "30/1")
    num, den = map(int, fps_str.split("/"))
    fps = num / den if den else 30.0

    duration = float(video_stream.get("duration",
                     data.get("format", {}).get("duration", 0)))
    total_frames = int(video_stream.get("nb_frames", int(duration * fps)))

    # Parse rotation from side_data or tags
    rotation = 0
    for sd in video_stream.get("side_data_list", []):
        if "rotation" in sd:
            rotation = int(sd["rotation"])
            break
    if rotation == 0:
        rotation = int(video_stream.get("tags", {}).get("rotate", 0))

    codec = video_stream.get("codec_name", "unknown")

    # Try to extract focal length from metadata (35mm equivalent)
    focal_length_35mm = _extract_focal_length(video_path)

    info = {
        "path": os.path.abspath(video_path),
        "width": width, "height": height,
        "fps": round(fps, 2),
        "duration": round(duration, 2),
        "total_frames": total_frames,
        "rotation": rotation,
        "codec": codec,
        "focal_length_35mm": focal_length_35mm,
    }
    logger.info("Video: %dx%d, %.1ffps, %.1fs, %d frames, rotation=%d, focal=%.1fmm (35mm equiv)",
                width, height, fps, duration, total_frames, rotation,
                focal_length_35mm or 0)
    return info


def _extract_focal_length(video_path):
    """Try to extract 35mm-equivalent focal length from video metadata.

    Returns focal length in mm, or None if not found.
    Uses ffprobe to check for common EXIF/QuickTime metadata tags.
    """
    try:
        cmd = [
            shutil.which("ffprobe"), "-v", "quiet", "-print_format", "json",
            "-show_entries", "format_tags", video_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            data = json.loads(result.stdout)
            tags = data.get("format", {}).get("tags", {})
            # Check common metadata keys for focal length
            for key in ("com.apple.quicktime.focal-length-35mm-equivalent",
                        "focal_length_35mm", "FocalLengthIn35mmFormat"):
                if key in tags:
                    val = float(tags[key])
                    if 10 < val < 200:  # sanity check
                        logger.info("Found focal length from metadata: %.1fmm", val)
                        return val
    except Exception:
        pass
    return None


# --- Frame extraction ---

def extract_frames(video_path, output_dir, video_fps=30.0, jpeg_quality=2):
    """Extract frames from video at an appropriate rate using ffmpeg.

    For panorama stitching, consecutive frames need meaningful displacement (~70% overlap).
    High-fps videos (60/120/240fps) are decimated to ~5fps to avoid near-identical frames
    that cause degenerate homography estimation.

    Returns sorted list of paths to extracted JPEG files.
    """
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise InputError("ffmpeg not found in PATH", "FFMPEG_MISSING")

    os.makedirs(output_dir, exist_ok=True)
    pattern = os.path.join(output_dir, "frame_%05d.jpg")

    # Cap extraction rate: at >10fps, consecutive panorama frames are too similar.
    # 5fps is a good target for handheld panning videos (~70% overlap between frames).
    max_extraction_fps = 5.0
    extraction_fps = min(video_fps, max_extraction_fps)

    cmd = [ffmpeg, "-i", video_path]
    if extraction_fps < video_fps:
        cmd += ["-vf", f"fps={extraction_fps}"]
        logger.info("Extracting frames at %.1ffps (decimated from %.1ffps)...",
                    extraction_fps, video_fps)
    else:
        logger.info("Extracting frames at native %.1ffps...", video_fps)
    cmd += ["-qscale:v", str(jpeg_quality), pattern, "-y"]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise InputError(f"ffmpeg extraction failed: {result.stderr[-500:]}", "EXTRACTION_FAILED")

    frames = sorted(Path(output_dir).resolve().glob("frame_*.jpg"))
    if not frames:
        raise InputError("No frames were extracted from video", "EXTRACTION_FAILED")

    logger.info("Extracted %d frames", len(frames))
    return [str(f) for f in frames]


# --- Quality scoring ---

def _laplacian_variance(image_path):
    """Compute Laplacian variance of an image (higher = sharper)."""
    try:
        import cv2
        img = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
        if img is None:
            return 0.0
        lap = cv2.Laplacian(img, cv2.CV_64F)
        val = float(lap.var())
        del img, lap
        return val
    except ImportError:
        return None


def score_frames(frame_paths, video_info, cfg):
    """Score all frames for sharpness.

    Uses Laplacian variance when OpenCV is available, falling back to file size otherwise.
    The file size threshold adapts to scene brightness by using both a resolution-scaled
    minimum and a fraction of the median file size — whichever is lower.
    Returns list of dicts with: path, file_size, laplacian, is_sharp.
    """
    qcfg = cfg["quality"]
    resolution = video_info["width"] * video_info["height"]
    if abs(video_info["rotation"]) in (90, 270):
        resolution = video_info["height"] * video_info["width"]
    fixed_threshold = int(qcfg["base_filesize_threshold"] * resolution / qcfg["base_resolution_pixels"])

    # First pass: collect file sizes
    scores = []
    all_sizes = []
    for path in frame_paths:
        sz = os.path.getsize(path)
        scores.append({
            "path": path,
            "file_size": sz,
            "laplacian": None,
            "is_sharp": False,
        })
        all_sizes.append(sz)

    # Adaptive threshold: use min(fixed_threshold, 50% of median file size).
    # This handles dark/low-contrast scenes where all frames compress small.
    median_size = sorted(all_sizes)[len(all_sizes) // 2] if all_sizes else 0
    adaptive_threshold = int(median_size * 0.5)
    filesize_threshold = min(fixed_threshold, max(adaptive_threshold, 1024))

    logger.info("Sharpness threshold: %d bytes (fixed=%d, adaptive=%d, median=%d)",
                filesize_threshold, fixed_threshold, adaptive_threshold, median_size)

    has_cv2 = bool(scores)
    if scores:
        first_lap = _laplacian_variance(scores[0]["path"])
        if first_lap is None:
            has_cv2 = False
            logger.warning("OpenCV not available, using file-size-only scoring")

    if has_cv2 and scores:
        logger.info("Computing Laplacian variance for %d frames...", len(scores))
        laplacian_values = []
        for s in scores:
            s["laplacian"] = _laplacian_variance(s["path"])
            laplacian_values.append(s["laplacian"])

        # Adaptive threshold: fraction of median
        median_lap = sorted(laplacian_values)[len(laplacian_values) // 2]
        lap_threshold = median_lap * qcfg["laplacian_ratio_threshold"]
        logger.info("Laplacian threshold: %.1f (median=%.1f)", lap_threshold, median_lap)

        for s in scores:
            s["is_sharp"] = s["laplacian"] >= lap_threshold
    else:
        for s in scores:
            s["is_sharp"] = s["file_size"] >= filesize_threshold

    total_sharp = sum(1 for s in scores if s["is_sharp"])
    pass_rate = total_sharp / len(scores) if scores else 0
    logger.info("Sharpness: %d/%d frames pass (%.0f%%)",
                total_sharp, len(scores), pass_rate * 100)

    # Release OpenCV memory before stitcher runs (Python allocator holds freed blocks)
    gc.collect()

    return scores, filesize_threshold


# --- Frame selection ---

def select_frames(scored_frames, cfg, min_frames=8, max_frames=80):
    """Select best frames while maintaining sequential coverage.

    Divides sharp frames into temporal windows, picks the sharpest per window.
    Returns (selected_paths, selection_metadata).
    """
    qcfg = cfg["quality"]
    sharp = [s for s in scored_frames if s["is_sharp"]]

    if len(sharp) < min_frames:
        raise QualityError(
            f"Only {len(sharp)} sharp frames found (minimum {min_frames} required). "
            "Video has excessive motion blur — try recording with slower camera movement.",
            "QUALITY_TOO_LOW",
            {"sharp_count": len(sharp), "min_required": min_frames}
        )

    pass_rate = len(sharp) / len(scored_frames) if scored_frames else 0
    if pass_rate < qcfg["min_sharpness_pass_rate"]:
        raise QualityError(
            f"Extreme motion blur: only {pass_rate:.0%} of frames are sharp enough. "
            "Try recording with slower, steadier camera movement.",
            "QUALITY_TOO_LOW",
            {"pass_rate": pass_rate}
        )

    # Take every Nth sharp frame to stay within max_frames while preserving overlap.
    # Sequential overlap is critical — the stitcher matches consecutive frames.
    step = max(1, len(sharp) // max_frames)
    selected = sharp[::step]
    if len(selected) > max_frames:
        selected = selected[:max_frames]

    paths = [s["path"] for s in selected]
    logger.info("Selected %d frames for stitching (from %d sharp)", len(paths), len(sharp))
    return paths, selected


# --- Config generation ---

def generate_config(working_dir, cfg, focal_length_mm=26,
                    use_cylinder=False, video_width=1920, video_height=1080,
                    num_frames=None):
    """Write config.cfg for the stitcher in working_dir.

    Adapts SIFT and RANSAC parameters based on video resolution,
    using values from the loaded config.
    """
    sift = cfg["sift"]
    ransac = cfg["ransac"]
    matching = cfg["matching"]
    opt = cfg["optimization"]
    out = cfg["output"]

    # SIFT_WORKING_SIZE must not exceed actual resolution (upscaling hurts feature detection)
    max_dim = max(video_width, video_height)
    sift_working_size = min(sift["sift_working_size"], max_dim)

    # Scale RANSAC inlier threshold relative to working size
    ransac_inlier_thres = round(
        ransac["base_inlier_thres"] * sift_working_size / ransac["base_inlier_resolution"], 1)

    # Adapt for low-res video
    if max_dim < sift["low_res_threshold"]:
        contrast_thres = sift["contrast_thres_low_res"]
        num_octave = sift["num_octave_low_res"]
    else:
        contrast_thres = sift["contrast_thres_high_res"]
        num_octave = sift["num_octave_high_res"]

    # Adaptive multiband: disable for large stitching jobs to prevent OOM.
    # Multiband blending builds Laplacian pyramids for all images simultaneously,
    # which can consume several GB for many large frames.
    multiband = out["multiband"]
    if multiband > 0 and num_frames and num_frames > 0:
        total_mpx = num_frames * video_width * video_height / 1e6
        if total_mpx > 150:  # >150 megapixels total input
            logger.warning("Disabling multiband blending (%.0f MP total, OOM risk)", total_mpx)
            multiband = 0

    config_path = os.path.join(working_dir, "config.cfg")
    content = VIDEO_CONFIG_TEMPLATE.format(
        mode_cylinder=1 if use_cylinder else 0,
        mode_estimate_camera=0 if use_cylinder else 1,
        focal_length=focal_length_mm,
        sift_working_size=sift_working_size,
        num_octave=num_octave,
        num_scale=sift["num_scale"],
        scale_factor=sift["scale_factor"],
        gauss_sigma=sift["gauss_sigma"],
        gauss_window_factor=sift["gauss_window_factor"],
        contrast_thres=contrast_thres,
        judge_extrema_diff_thres=sift["judge_extrema_diff_thres"],
        edge_ratio=sift["edge_ratio"],
        pre_color_thres=sift["pre_color_thres"],
        calc_offset_depth=sift["calc_offset_depth"],
        offset_thres=sift["offset_thres"],
        ori_radius=matching["ori_radius"],
        ori_hist_smooth_count=matching["ori_hist_smooth_count"],
        desc_hist_scale_factor=matching["desc_hist_scale_factor"],
        desc_int_factor=matching["desc_int_factor"],
        match_reject_next_ratio=matching["match_reject_next_ratio"],
        ransac_iterations=ransac["iterations"],
        ransac_inlier_thres=ransac_inlier_thres,
        inlier_in_match_ratio=ransac["inlier_in_match_ratio"],
        inlier_in_points_ratio=ransac["inlier_in_points_ratio"],
        straighten=opt["straighten"],
        slope_plain=opt["slope_plain"],
        lm_lambda=opt["lm_lambda"],
        multipass_ba=opt["multipass_ba"],
        crop=out["crop"],
        max_output_size=out["max_output_size"],
        multiband=multiband,
    )
    with open(config_path, "w") as f:
        f.write(content)
    logger.info("Config: %s mode, focal=%.1fmm, sift_size=%d, ransac_thres=%.1f",
                "CYLINDER" if use_cylinder else "ESTIMATE_CAMERA",
                focal_length_mm, sift_working_size, ransac_inlier_thres)
    return config_path


# --- Stitcher execution ---

def run_stitcher(stitcher_binary, frame_paths, working_dir, min_connected=8):
    """Run the OpenPano image-stitching binary.

    If the sequential chain breaks, retries with the connected subset
    (as long as it has at least min_connected frames).

    Returns dict with: success, output_path, final_size, duration_seconds, frames_used.
    """
    if not os.path.isfile(stitcher_binary):
        raise StitcherError(
            f"Stitcher binary not found at {stitcher_binary}. Run: cmake -B build && make -C build",
            "STITCHER_NOT_FOUND"
        )

    output_file = os.path.join(working_dir, "out.jpg")
    cmd = [stitcher_binary] + frame_paths

    logger.info("Running stitcher on %d frames...", len(frame_paths))
    t0 = time.time()
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=working_dir)
    duration = time.time() - t0

    combined_output = result.stdout + result.stderr
    logger.debug("Stitcher output:\n%s", combined_output[-2000:])

    # Strip ANSI escape codes for parsing
    clean_output = re.sub(r'\x1b\[[0-9;]*m', '', combined_output)

    # Parse final image size and projection range from output
    final_size = None
    proj_range = None
    for line in clean_output.split("\n"):
        if "Final Image Size:" in line:
            m = re.search(r"Final Image Size:\s*\((\d+),\s*(\d+)\)", line)
            if m:
                final_size = [int(m.group(1)), int(m.group(2))]
        if "Crop from" in line:
            m = re.search(r"Crop from \d+x\d+ to (\d+)x(\d+)", line)
            if m:
                final_size = [int(m.group(1)), int(m.group(2))]
        # Parse "projmin: -3.1 -0.8, projmax: 3.1 0.8"
        if "projmin:" in line:
            m = re.search(r"projmin:\s*([-\d.]+)\s+([-\d.]+),\s*projmax:\s*([-\d.]+)\s+([-\d.]+)", line)
            if m:
                proj_range = {
                    "min_lon": float(m.group(1)), "min_lat": float(m.group(2)),
                    "max_lon": float(m.group(3)), "max_lat": float(m.group(4)),
                }

    if result.returncode != 0 or not os.path.isfile(output_file):
        # Extract error message from stitcher output
        error_lines = [l for l in clean_output.split("\n") if "error" in l.lower()]
        error_msg = error_lines[-1].strip() if error_lines else "Unknown stitcher error"

        # Check if chain broke at a specific image — we can retry with the connected subset
        m = re.search(r"Image (\d+) and (\d+) don't match", error_msg)
        if m:
            break_at = int(m.group(1))
            if break_at >= min_connected:
                logger.warning("Chain broke at frame %d. Retrying with frames 0-%d...",
                               break_at, break_at - 1)
                return run_stitcher(stitcher_binary, frame_paths[:break_at],
                                   working_dir, min_connected=min_connected)

        raise StitcherError(
            f"Stitcher failed: {error_msg}",
            "STITCH_FAILED",
            {"exit_code": result.returncode, "output": combined_output[-1000:]}
        )

    logger.info("Stitching complete in %.1fs, output: %s", duration, output_file)
    return {
        "success": True,
        "output_path": output_file,
        "final_size": final_size,
        "proj_range": proj_range,
        "duration_seconds": round(duration, 2),
        "frames_used": len(frame_paths),
    }


def _parse_hugin_panorama(project_path):
    """Extract panorama width / height / HFOV from a .pto project."""
    try:
        with open(project_path, "r", encoding="utf-8", errors="ignore") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line.startswith("p "):
                    continue
                width_match = re.search(r"\bw(\d+)\b", line)
                height_match = re.search(r"\bh(\d+)\b", line)
                hfov_match = re.search(r"\bv([-\d.]+)\b", line)
                if width_match and height_match and hfov_match:
                    return {
                        "width": int(width_match.group(1)),
                        "height": int(height_match.group(1)),
                        "hfov_deg": float(hfov_match.group(1)),
                    }
    except OSError:
        return None
    return None


def _proj_range_from_hugin_project(project_path):
    """Approximate equirectangular projection range from a Hugin project."""
    pano = _parse_hugin_panorama(project_path)
    if not pano or pano["width"] <= 0 or pano["height"] <= 0:
        return None

    haov_rad = math.radians(max(0.0, min(360.0, pano["hfov_deg"])))
    vaov_rad = min(math.pi, haov_rad * pano["height"] / pano["width"])
    return {
        "min_lon": -haov_rad / 2,
        "max_lon": haov_rad / 2,
        "min_lat": -vaov_rad / 2,
        "max_lat": vaov_rad / 2,
    }


def run_hugin_stitcher(frame_paths, working_dir, focal_length_mm=None):
    """Run a Hugin CLI pipeline on the selected frames.

    Uses the documented command-line flow:
    pto_gen -> cpfind -> autooptimiser -> pano_modify -> nona -> enblend.
    Returns the same shape as run_stitcher().
    """
    _require_tools(
        HUGIN_REQUIRED_TOOLS,
        "HUGIN_NOT_INSTALLED",
        "Install Hugin command-line tools and ensure they are on PATH.",
    )
    _require_tools(("ffmpeg",), "FFMPEG_MISSING", "Install ffmpeg and ensure it is on PATH.")
    hugin_tools = {tool: _resolve_tool(tool) for tool in HUGIN_REQUIRED_TOOLS}
    ffmpeg = _resolve_tool("ffmpeg")

    project_0 = os.path.join(working_dir, "hugin_00_initial.pto")
    project_1 = os.path.join(working_dir, "hugin_10_cpfind.pto")
    project_2 = os.path.join(working_dir, "hugin_20_optimized.pto")
    project_3 = os.path.join(working_dir, "hugin_30_equirect.pto")
    remap_prefix = os.path.join(working_dir, "hugin_remap")
    blended_tif = os.path.join(working_dir, "hugin_blended.tif")
    output_file = os.path.join(working_dir, "hugin_out.jpg")

    t0 = time.time()

    logger.info("Hugin project: generating project for %d frames...", len(frame_paths))
    pto_cmd = [hugin_tools["pto_gen"], "-o", project_0]
    input_hfov = _focal_mm_to_hfov_deg(focal_length_mm)
    if input_hfov:
        pto_cmd += ["-f", f"{input_hfov:.3f}"]
    pto_cmd += frame_paths
    _run_checked(pto_cmd, "HUGIN_PROJECT_FAILED", "Hugin project generation", cwd=working_dir)

    logger.info("Hugin control points: running cpfind...")
    _run_checked(
        [hugin_tools["cpfind"], "--multirow", "-o", project_1, project_0],
        "HUGIN_CPFIND_FAILED",
        "Hugin control point search",
        cwd=working_dir,
    )

    logger.info("Hugin optimize: running autooptimiser...")
    _run_checked(
        [hugin_tools["autooptimiser"], "-a", "-l", "-s", "-m", "-o", project_2, project_1],
        "HUGIN_OPTIMIZE_FAILED",
        "Hugin optimization",
        cwd=working_dir,
    )

    logger.info("Hugin modify: forcing equirectangular projection with auto canvas/crop...")
    _run_checked(
        [
            hugin_tools["pano_modify"],
            "--projection=2",
            "--center",
            "--straighten",
            "--canvas=AUTO",
            "--crop=AUTO",
            "-o",
            project_3,
            project_2,
        ],
        "HUGIN_MODIFY_FAILED",
        "Hugin panorama modification",
        cwd=working_dir,
    )

    logger.info("Hugin remap: rendering panorama layers with nona...")
    _run_checked(
        [hugin_tools["nona"], "-m", "TIFF_m", "-o", remap_prefix, project_3],
        "HUGIN_NONA_FAILED",
        "Hugin remap",
        cwd=working_dir,
    )

    remap_files = sorted(str(path) for path in Path(working_dir).glob("hugin_remap*.tif"))
    if not remap_files:
        raise StitcherError(
            "Hugin remap produced no TIFF layers",
            "HUGIN_NONA_FAILED",
        )

    remaps_used = len(remap_files)
    blend_stdout = ""
    blend_stderr = ""
    for step in (1, 2, 3, 4):
        subset = remap_files[::step]
        remaps_used = len(subset)
        logger.info(
            "Hugin blend: blending %d remapped layers with enblend%s...",
            remaps_used,
            "" if step == 1 else f" (retry every {step}th layer)",
        )
        result = subprocess.run(
            [hugin_tools["enblend"], "-o", blended_tif, *subset],
            capture_output=True,
            text=True,
            cwd=working_dir,
        )
        blend_stdout = result.stdout or ""
        blend_stderr = result.stderr or ""
        if result.returncode == 0:
            break
        combined = blend_stdout + blend_stderr
        if "excessive image overlap detected" in combined and step < 4:
            logger.warning(
                "Hugin blend reported excessive overlap with %d layers; retrying with sparser subset...",
                remaps_used,
            )
            continue
        raise StitcherError(
            "Hugin blending failed",
            "HUGIN_ENBLEND_FAILED",
            {
                "exit_code": result.returncode,
                "command": [hugin_tools["enblend"], "-o", blended_tif, *subset],
                "output": combined[-4000:],
            },
        )

    logger.info("Hugin export: converting stitched TIFF to JPEG...")
    _run_checked(
        [ffmpeg, "-y", "-i", blended_tif, "-qscale:v", "2", output_file],
        "HUGIN_EXPORT_FAILED",
        "Hugin export conversion",
        cwd=working_dir,
    )

    pano = _parse_hugin_panorama(project_3)
    proj_range = _proj_range_from_hugin_project(project_3)

    for path in remap_files:
        try:
            os.remove(path)
        except OSError:
            pass
    try:
        os.remove(blended_tif)
    except OSError:
        pass

    duration = time.time() - t0
    logger.info("Hugin stitching complete in %.1fs, output: %s", duration, output_file)
    return {
        "success": True,
        "output_path": output_file,
        "final_size": [pano["width"], pano["height"]] if pano else None,
        "proj_range": proj_range,
        "duration_seconds": round(duration, 2),
        "frames_used": remaps_used,
        "blend_output": (blend_stdout + blend_stderr)[-4000:],
    }


# --- Equirectangular formatting ---

def compute_fov(proj_range):
    """Compute horizontal/vertical angle of view from projection range (radians).

    Returns dict with haov, vaov (degrees), and center yaw/pitch.
    """
    if not proj_range:
        return None
    haov = (proj_range["max_lon"] - proj_range["min_lon"]) * 180.0 / math.pi
    vaov = (proj_range["max_lat"] - proj_range["min_lat"]) * 180.0 / math.pi
    # Center of the panorama in degrees (yaw=0 is forward, pitch=0 is horizon)
    center_yaw = (proj_range["min_lon"] + proj_range["max_lon"]) / 2 * 180.0 / math.pi
    center_pitch = (proj_range["min_lat"] + proj_range["max_lat"]) / 2 * 180.0 / math.pi
    return {
        "haov": round(haov, 1),
        "vaov": round(vaov, 1),
        "center_yaw": round(center_yaw, 1),
        "center_pitch": round(center_pitch, 1),
    }


def compute_cylinder_proj_range(pano_size, frame_w, frame_h, focal_mm):
    """Compute projection range (in radians) from cylinder mode output.

    In CylinderWarper: r = hypot(w,h) * (focal/43.266), and x_out = r * atan(X/r).
    So 1 output pixel = 1/r radians horizontally.
    Vertically: y_out = r * Y/hypot(X, r), so vaov ≈ 2*atan(h/(2r)).
    """
    if not pano_size or not focal_mm or focal_mm <= 0:
        return None
    pano_w, pano_h = pano_size
    f_px = math.hypot(frame_w, frame_h) * (focal_mm / 43.266)
    if f_px <= 0:
        return None

    haov_rad = pano_w / f_px
    vaov_rad = 2 * math.atan(pano_h / (2 * f_px))

    return {
        "min_lon": -haov_rad / 2,
        "max_lon": haov_rad / 2,
        "min_lat": -vaov_rad / 2,
        "max_lat": vaov_rad / 2,
    }


def format_equirectangular(input_path, output_path, proj_range, equirect_width=4096):
    """Embed a partial panorama into a full 2:1 equirectangular canvas.

    The input image is placed at its correct angular position in a full
    360x180 degree equirectangular image. Uncovered areas are black.

    Args:
        input_path: path to the partial panorama (already equirectangular projection)
        output_path: path for the full equirectangular output
        proj_range: dict with min_lon, max_lon, min_lat, max_lat (radians)
        equirect_width: width of the full equirectangular output (height = width/2)

    Returns:
        (output_width, output_height) of the full equirectangular image.
    """
    try:
        import cv2
        import numpy as np
    except ImportError:
        logger.warning("OpenCV required for equirectangular formatting. Skipping.")
        shutil.copy2(input_path, output_path)
        return None

    pano = cv2.imread(input_path)
    if pano is None:
        logger.error("Failed to read panorama: %s", input_path)
        return None

    min_lon, max_lon = proj_range["min_lon"], proj_range["max_lon"]
    min_lat, max_lat = proj_range["min_lat"], proj_range["max_lat"]
    pano_h, pano_w = pano.shape[:2]

    # Avoid shrinking the stitched panorama when embedding it into a full 2:1 canvas.
    # The input is already in spherical/equirectangular space, so an unnecessary resize
    # here discards detail that the stitcher already recovered.
    haov = max(1e-6, max_lon - min_lon)
    vaov = max(1e-6, max_lat - min_lat)
    min_full_width = max(
        int(equirect_width),
        math.ceil(pano_w * (2 * math.pi) / haov),
        math.ceil(pano_h * (2 * math.pi) / vaov),
    )
    if min_full_width % 2:
        min_full_width += 1
    if min_full_width > equirect_width:
        logger.info(
            "Increasing full equirect width from %d to %d to preserve stitched resolution",
            equirect_width,
            min_full_width,
        )
        equirect_width = min_full_width

    equirect_h = equirect_width // 2  # 2:1 aspect

    # Full equirectangular: longitude [-pi, pi] → x [0, equirect_width]
    #                       latitude  [pi/2, -pi/2] → y [0, equirect_h]  (top=north)
    # Map projection range to pixel coordinates in the full canvas

    # Longitude to x: x = (lon + pi) / (2*pi) * width
    x_start = int((min_lon + math.pi) / (2 * math.pi) * equirect_width)
    x_end = int((max_lon + math.pi) / (2 * math.pi) * equirect_width)

    # Latitude to y: y = (pi/2 - lat) / pi * height  (north up)
    y_start = int((math.pi / 2 - max_lat) / math.pi * equirect_h)
    y_end = int((math.pi / 2 - min_lat) / math.pi * equirect_h)

    # Ensure valid bounds
    place_w = max(1, x_end - x_start)
    place_h = max(1, y_end - y_start)

    # Create full black canvas
    canvas = np.zeros((equirect_h, equirect_width, 3), dtype=np.uint8)

    # Resize partial pano to fit its angular slot in the full canvas
    resized = cv2.resize(pano, (place_w, place_h), interpolation=cv2.INTER_LANCZOS4)

    # Handle wrapping (panorama crossing the -pi/+pi boundary)
    if x_start >= 0 and x_end <= equirect_width:
        # No wrapping
        canvas[y_start:y_start + place_h, x_start:x_start + place_w] = resized
    else:
        # Wrapping around the seam
        if x_start < 0:
            left_part = -x_start
            canvas[y_start:y_start + place_h, 0:place_w - left_part] = resized[:, left_part:]
            canvas[y_start:y_start + place_h, equirect_width - left_part:] = resized[:, :left_part]
        elif x_end > equirect_width:
            right_overflow = x_end - equirect_width
            canvas[y_start:y_start + place_h, x_start:equirect_width] = resized[:, :place_w - right_overflow]
            canvas[y_start:y_start + place_h, 0:right_overflow] = resized[:, place_w - right_overflow:]

    cv2.imwrite(output_path, canvas, [cv2.IMWRITE_JPEG_QUALITY, 95])
    logger.info("Equirectangular output: %dx%d, placed at (%d,%d)-(%d,%d)",
                equirect_width, equirect_h, x_start, y_start, x_end, y_end)
    return [equirect_width, equirect_h]


# --- Main pipeline ---

def process_video(video_path, output_dir=None, project_root=None,
                  min_frames=None, max_frames=None, keep_frames=False,
                  focal_length=None, config_path=None,
                  equirectangular=False, equirect_width=4096,
                  stitcher_backend="openpano"):
    """Main pipeline: video -> frames -> score -> select -> stitch -> panorama.

    Returns a complete result dict suitable for JSON serialization.
    """
    if project_root is None:
        project_root = str(Path(__file__).parent)
    stitcher_binary = os.path.join(project_root, "build", "src", "image-stitching")

    cfg = load_config(config_path)
    if min_frames is None:
        min_frames = cfg["frames"]["min_frames"]
    if max_frames is None:
        max_frames = cfg["frames"]["max_frames"]

    # Setup working directory
    cleanup_dir = False
    if output_dir is None:
        output_dir = tempfile.mkdtemp(prefix="video2pano_")
        cleanup_dir = not keep_frames
    else:
        os.makedirs(output_dir, exist_ok=True)

    frames_dir = os.path.join(output_dir, "frames")
    timings = {}

    try:
        # 1. Probe video
        t0 = time.time()
        video_info = probe_video(video_path)
        timings["probe_seconds"] = round(time.time() - t0, 2)

        # 2. Extract frames
        t0 = time.time()
        frame_paths = extract_frames(video_path, frames_dir, video_fps=video_info["fps"])
        timings["extract_seconds"] = round(time.time() - t0, 2)

        # 3. Score frames
        t0 = time.time()
        scored, filesize_threshold = score_frames(frame_paths, video_info, cfg)
        timings["score_seconds"] = round(time.time() - t0, 2)

        # 4. Select best frames
        t0 = time.time()
        selected_paths, selected_meta = select_frames(scored, cfg, min_frames, max_frames)
        timings["select_seconds"] = round(time.time() - t0, 2)

        # Build quality metrics
        sharp_count = sum(1 for s in scored if s["is_sharp"])
        laplacian_values = [s["laplacian"] for s in selected_meta if s["laplacian"] is not None]
        quality = {
            "total_frames_extracted": len(frame_paths),
            "frames_passing_sharpness": sharp_count,
            "frames_selected": len(selected_paths),
            "sharpness_pass_rate": round(sharp_count / len(frame_paths), 3) if frame_paths else 0,
            "filesize_threshold_bytes": filesize_threshold,
        }
        if laplacian_values:
            quality["mean_laplacian"] = round(sum(laplacian_values) / len(laplacian_values), 1)
            quality["min_laplacian_selected"] = round(min(laplacian_values), 1)

        # 5. Determine focal length (CLI override > metadata > default)
        default_focal = cfg["camera"]["default_focal_length_mm"]
        focal_mm = focal_length or video_info.get("focal_length_35mm") or default_focal
        quality["focal_length_35mm"] = focal_mm
        quality["focal_source"] = ("metadata" if video_info.get("focal_length_35mm")
                                   else "default")

        # 6. Stitch using the selected backend.
        t0 = time.time()
        stitch_result = None
        stitch_mode = None
        vw, vh = video_info["width"], video_info["height"]
        # If video is rotated, effective dims are swapped
        if abs(video_info["rotation"]) in (90, 270):
            vw, vh = vh, vw

        if stitcher_backend == "hugin":
            stitch_result = run_hugin_stitcher(
                selected_paths,
                output_dir,
                focal_length_mm=focal_mm,
            )
            stitch_mode = "hugin"
        else:
            # OpenPano strategy depends on whether we know the focal length.
            # Known focal: try CYLINDER first (flat projection, needs accurate focal),
            # Unknown focal: try ESTIMATE_CAMERA first (can estimate focal internally).
            focal_known = quality["focal_source"] == "metadata" or focal_length is not None
            config_kwargs = dict(
                cfg=cfg,
                focal_length_mm=focal_mm,
                video_width=vw,
                video_height=vh,
                num_frames=len(selected_paths),
            )

            if focal_known:
                modes_to_try = [("cylinder", True), ("estimate_camera", False)]
            else:
                modes_to_try = [("estimate_camera", False), ("cylinder", True)]

            for mode_name, use_cyl in modes_to_try:
                generate_config(output_dir, use_cylinder=use_cyl, **config_kwargs)
                try:
                    stitch_result = run_stitcher(
                        stitcher_binary,
                        selected_paths,
                        output_dir,
                        min_connected=min_frames,
                    )
                    stitch_mode = mode_name
                    break
                except StitcherError as e:
                    logger.warning("%s mode failed (%s), trying next mode...",
                                  mode_name.upper(), e.error_code)
                    out_file = os.path.join(output_dir, "out.jpg")
                    if os.path.exists(out_file):
                        os.remove(out_file)

        if stitch_result is None:
            raise StitcherError("All stitching modes failed", "STITCH_FAILED")

        timings["stitch_seconds"] = round(time.time() - t0, 2)

        # 7. Compute FOV from projection range
        proj_range = stitch_result.get("proj_range")
        # For CYLINDER mode, compute proj_range from focal length and output dimensions
        if not proj_range and stitch_mode == "cylinder" and stitch_result["final_size"]:
            proj_range = compute_cylinder_proj_range(
                stitch_result["final_size"], vw, vh, focal_mm)
            if proj_range:
                logger.info("Cylinder FOV: haov=%.1f°, vaov=%.1f°",
                    (proj_range["max_lon"] - proj_range["min_lon"]) * 180 / math.pi,
                    (proj_range["max_lat"] - proj_range["min_lat"]) * 180 / math.pi)
        fov = compute_fov(proj_range)

        # 8. Format output
        final_path = os.path.join(output_dir, "panorama.jpg")
        equirect_size = None

        # Only embed in full 2:1 canvas if panorama covers >270° horizontally.
        # For partial panoramas, the output is already equirectangular projection —
        # just provide FOV metadata and let Pannellum handle partial view.
        haov_deg = (proj_range["max_lon"] - proj_range["min_lon"]) * 180 / math.pi if proj_range else 0
        do_full_equirect = equirectangular and proj_range and haov_deg > 270

        if do_full_equirect:
            # Embed partial panorama in full 2:1 equirectangular canvas
            equirect_path = os.path.join(output_dir, "panorama_equirect.jpg")
            equirect_size = format_equirectangular(
                stitch_result["output_path"], equirect_path, proj_range, equirect_width)
            if equirect_size:
                shutil.move(equirect_path, final_path)
                # Also keep the cropped version
                shutil.move(stitch_result["output_path"],
                            os.path.join(output_dir, "panorama_cropped.jpg"))
            else:
                shutil.move(stitch_result["output_path"], final_path)
        else:
            shutil.move(stitch_result["output_path"], final_path)

        # Collect warnings
        warnings = []
        frames_used = stitch_result.get("frames_used", len(selected_paths))
        if frames_used < len(selected_paths):
            if stitcher_backend == "hugin":
                warnings.append(
                    f"Hugin reduced blend input to {frames_used}/{len(selected_paths)} layers "
                    "to avoid excessive overlap"
                )
            else:
                warnings.append(
                    f"Only {frames_used}/{len(selected_paths)} frames were stitchable "
                    "(chain broke at a blurry transition)"
                )
        quality["frames_stitched"] = frames_used
        if quality["sharpness_pass_rate"] < 0.3:
            warnings.append(
                f"{100 - quality['sharpness_pass_rate'] * 100:.0f}% of frames failed sharpness check"
            )
        if frames_used < 15:
            warnings.append("Few frames stitched — panorama may have limited field of view")

        timings["total_seconds"] = round(sum(timings.values()), 2)

        # Build stitch result
        stitch_info = {
            "final_size": equirect_size or stitch_result["final_size"],
            "stitched_size": stitch_result["final_size"],
            "duration_seconds": stitch_result["duration_seconds"],
            "backend": stitcher_backend,
            "mode": stitch_mode,
            "projection": "equirectangular",
        }
        if fov:
            stitch_info["fov"] = fov

        # Pannellum viewer config
        pannellum = {"type": "equirectangular", "panorama": "panorama.jpg", "autoLoad": True}
        if fov:
            if equirect_size:
                # Full 2:1 canvas — Pannellum defaults work (haov=360, vaov=180)
                pass
            else:
                # Partial panorama — tell Pannellum the actual FOV
                pannellum["haov"] = fov["haov"]
                pannellum["vaov"] = fov["vaov"]
                pannellum["vOffset"] = fov["center_pitch"]
                pannellum["avoidShowingBackground"] = True
                if fov["haov"] < 360:
                    pannellum["minHfov"] = min(50, fov["haov"])
                    pannellum["maxHfov"] = fov["haov"]
        stitch_info["pannellum"] = pannellum

        result = {
            "status": "success",
            "output_path": os.path.abspath(final_path),
            "video": video_info,
            "quality": quality,
            "stitch": stitch_info,
            "warnings": warnings,
            "timing": timings,
        }
        return result

    finally:
        # Cleanup extracted frames unless asked to keep them
        if not keep_frames and os.path.isdir(frames_dir):
            shutil.rmtree(frames_dir, ignore_errors=True)
        if cleanup_dir and os.path.isdir(output_dir):
            # Don't remove if we wrote output there
            pass


def main():
    parser = argparse.ArgumentParser(
        description="Convert video to panorama using selectable stitcher backends",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Output: JSON result on stdout. Progress on stderr.\n"
               "Exit codes: 0=success, 1=quality too low, 2=input error, "
               "3=stitcher error, 4=internal error"
    )
    parser.add_argument("video_path", help="Path to input video file")
    parser.add_argument("--output-dir", "-o", help="Output directory (default: auto temp dir)")
    parser.add_argument("--project-root", help="OpenPano project root (default: script directory)")
    parser.add_argument("--min-frames", type=int, default=None,
                        help="Minimum sharp frames required (default: from config, usually 8)")
    parser.add_argument("--max-frames", type=int, default=None,
                        help="Maximum frames to stitch (default: from config, usually 80)")
    parser.add_argument("--focal-length", type=float, default=None,
                        help="Override 35mm-equivalent focal length in mm (default: auto-detect or 26)")
    parser.add_argument("--config", "-c", default=None,
                        help="Path to video2pano.conf (default: video2pano.conf next to this script)")
    parser.add_argument("--equirectangular", "-e", action="store_true",
                        help="Output as full 2:1 equirectangular image (best for true 360 export workflows)")
    parser.add_argument("--equirect-width", type=int, default=4096,
                        help="Width of full equirectangular output (default: 4096, height=width/2)")
    parser.add_argument("--stitcher-backend", choices=("openpano", "hugin"), default="openpano",
                        help="Stitching backend to use (default: openpano)")
    parser.add_argument("--keep-frames", action="store_true", help="Keep extracted frames after stitching")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output on stderr")
    args = parser.parse_args()

    # Setup logging to stderr
    level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(levelname)s: %(message)s",
        stream=sys.stderr,
    )

    exit_code = EXIT_INTERNAL_ERROR
    result = None

    try:
        result = process_video(
            video_path=args.video_path,
            output_dir=args.output_dir,
            project_root=args.project_root,
            min_frames=args.min_frames,
            max_frames=args.max_frames,
            keep_frames=args.keep_frames,
            focal_length=args.focal_length,
            config_path=args.config,
            equirectangular=args.equirectangular,
            equirect_width=args.equirect_width,
            stitcher_backend=args.stitcher_backend,
        )
        exit_code = EXIT_SUCCESS

    except QualityError as e:
        result = {
            "status": "error",
            "error_code": e.error_code,
            "error_message": str(e),
            **e.details,
        }
        exit_code = EXIT_QUALITY_TOO_LOW

    except InputError as e:
        result = {
            "status": "error",
            "error_code": e.error_code,
            "error_message": str(e),
            **e.details,
        }
        exit_code = EXIT_INPUT_ERROR

    except StitcherError as e:
        result = {
            "status": "error",
            "error_code": e.error_code,
            "error_message": str(e),
            **e.details,
        }
        exit_code = EXIT_STITCHER_ERROR

    except Exception as e:
        logger.exception("Unexpected error")
        result = {
            "status": "error",
            "error_code": "INTERNAL_ERROR",
            "error_message": str(e),
        }
        exit_code = EXIT_INTERNAL_ERROR

    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
