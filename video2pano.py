#!/usr/bin/env python3
"""video2pano.py - Convert video to panorama using OpenPano.

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
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

logger = logging.getLogger("video2pano")

# --- Exit codes ---
EXIT_SUCCESS = 0
EXIT_QUALITY_TOO_LOW = 1
EXIT_INPUT_ERROR = 2
EXIT_STITCHER_ERROR = 3
EXIT_INTERNAL_ERROR = 4

# --- Quality thresholds ---
# At 1080p with JPEG quality 2, frames below this are too blurry for SIFT
BASE_FILESIZE_THRESHOLD = 120_000  # bytes at 1920x1080
BASE_RESOLUTION = 1920 * 1080
# Laplacian variance: frames below this fraction of the median are rejected
LAPLACIAN_RATIO_THRESHOLD = 0.4
# Minimum fraction of frames that must pass sharpness check
MIN_SHARPNESS_PASS_RATE = 0.08

# --- Stitcher config template (tuned for video input) ---
VIDEO_CONFIG_TEMPLATE = """\
CYLINDER 0
ESTIMATE_CAMERA 1
TRANS 0

ORDERED_INPUT 1
CROP 1
MAX_OUTPUT_SIZE 8000
LAZY_READ 1

FOCAL_LENGTH 28

SIFT_WORKING_SIZE 1200
NUM_OCTAVE 5
NUM_SCALE 7
SCALE_FACTOR 1.4142135623
GAUSS_SIGMA 1.4142135623
GAUSS_WINDOW_FACTOR 4

CONTRAST_THRES 1.5e-2
JUDGE_EXTREMA_DIFF_THRES 1e-3
EDGE_RATIO 12

PRE_COLOR_THRES 2e-2
CALC_OFFSET_DEPTH 4
OFFSET_THRES 0.5

ORI_RADIUS 4.5
ORI_HIST_SMOOTH_COUNT 2
DESC_HIST_SCALE_FACTOR 3
DESC_INT_FACTOR 512

MATCH_REJECT_NEXT_RATIO 0.8
RANSAC_ITERATIONS 2500
RANSAC_INLIER_THRES 4.5

INLIER_IN_MATCH_RATIO 0.05
INLIER_IN_POINTS_RATIO 0.02

STRAIGHTEN 1
SLOPE_PLAIN 8e-3
LM_LAMBDA 5
MULTIPASS_BA 1

MULTIBAND 0
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

    info = {
        "path": os.path.abspath(video_path),
        "width": width, "height": height,
        "fps": round(fps, 2),
        "duration": round(duration, 2),
        "total_frames": total_frames,
        "rotation": rotation,
        "codec": codec,
    }
    logger.info("Video: %dx%d, %.1ffps, %.1fs, %d frames, rotation=%d",
                width, height, fps, duration, total_frames, rotation)
    return info


# --- Frame extraction ---

def extract_frames(video_path, output_dir, jpeg_quality=2):
    """Extract all frames from video at native fps using ffmpeg.

    Returns sorted list of paths to extracted JPEG files.
    """
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise InputError("ffmpeg not found in PATH", "FFMPEG_MISSING")

    os.makedirs(output_dir, exist_ok=True)
    pattern = os.path.join(output_dir, "frame_%05d.jpg")

    cmd = [
        ffmpeg, "-i", video_path,
        "-qscale:v", str(jpeg_quality),
        pattern, "-y"
    ]
    logger.info("Extracting frames...")
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
        return cv2.Laplacian(img, cv2.CV_64F).var()
    except ImportError:
        return None


def score_frames(frame_paths, video_info):
    """Score all frames for sharpness.

    Uses file size (fast) and Laplacian variance (precise, if cv2 available).
    Returns list of dicts with: path, file_size, laplacian, is_sharp.
    """
    resolution = video_info["width"] * video_info["height"]
    # Account for rotation: if rotated, effective resolution uses swapped dims
    if abs(video_info["rotation"]) in (90, 270):
        resolution = video_info["height"] * video_info["width"]  # same, but explicit
    filesize_threshold = int(BASE_FILESIZE_THRESHOLD * resolution / BASE_RESOLUTION)

    logger.info("Sharpness threshold: %d bytes (scaled for %dx%d)",
                filesize_threshold, video_info["width"], video_info["height"])

    # First pass: file sizes (fast)
    scores = []
    for path in frame_paths:
        sz = os.path.getsize(path)
        scores.append({
            "path": path,
            "file_size": sz,
            "laplacian": None,
            "is_sharp": sz >= filesize_threshold,
        })

    # Second pass: Laplacian variance on frames that passed file size check
    has_cv2 = True
    sharp_scores = [s for s in scores if s["is_sharp"]]
    if sharp_scores:
        first_lap = _laplacian_variance(sharp_scores[0]["path"])
        if first_lap is None:
            has_cv2 = False
            logger.warning("OpenCV not available, using file-size-only scoring")

    if has_cv2 and sharp_scores:
        logger.info("Computing Laplacian variance for %d candidate frames...", len(sharp_scores))
        laplacian_values = []
        for s in sharp_scores:
            s["laplacian"] = _laplacian_variance(s["path"])
            laplacian_values.append(s["laplacian"])

        # Adaptive threshold: fraction of median
        median_lap = sorted(laplacian_values)[len(laplacian_values) // 2]
        lap_threshold = median_lap * LAPLACIAN_RATIO_THRESHOLD
        logger.info("Laplacian threshold: %.1f (median=%.1f)", lap_threshold, median_lap)

        for s in sharp_scores:
            if s["laplacian"] < lap_threshold:
                s["is_sharp"] = False

    total_sharp = sum(1 for s in scores if s["is_sharp"])
    pass_rate = total_sharp / len(scores) if scores else 0
    logger.info("Sharpness: %d/%d frames pass (%.0f%%)",
                total_sharp, len(scores), pass_rate * 100)

    return scores, filesize_threshold


# --- Frame selection ---

def select_frames(scored_frames, min_frames=8, max_frames=80):
    """Select best frames while maintaining sequential coverage.

    Divides sharp frames into temporal windows, picks the sharpest per window.
    Returns (selected_paths, selection_metadata).
    """
    sharp = [s for s in scored_frames if s["is_sharp"]]

    if len(sharp) < min_frames:
        raise QualityError(
            f"Only {len(sharp)} sharp frames found (minimum {min_frames} required). "
            "Video has excessive motion blur — try recording with slower camera movement.",
            "QUALITY_TOO_LOW",
            {"sharp_count": len(sharp), "min_required": min_frames}
        )

    pass_rate = len(sharp) / len(scored_frames) if scored_frames else 0
    if pass_rate < MIN_SHARPNESS_PASS_RATE:
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

def generate_config(working_dir):
    """Write config.cfg for the stitcher in working_dir."""
    config_path = os.path.join(working_dir, "config.cfg")
    with open(config_path, "w") as f:
        f.write(VIDEO_CONFIG_TEMPLATE)
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

    # Parse final image size from output
    final_size = None
    for line in combined_output.split("\n"):
        if "Final Image Size:" in line:
            import re
            m = re.search(r"Final Image Size:\s*\((\d+),\s*(\d+)\)", line)
            if m:
                final_size = [int(m.group(1)), int(m.group(2))]
        if "Crop from" in line:
            import re
            m = re.search(r"Crop from \d+x\d+ to (\d+)x(\d+)", line)
            if m:
                final_size = [int(m.group(1)), int(m.group(2))]

    if result.returncode != 0 or not os.path.isfile(output_file):
        # Extract error message from stitcher output
        error_lines = [l for l in combined_output.split("\n") if "error" in l.lower()]
        error_msg = error_lines[-1].strip() if error_lines else "Unknown stitcher error"
        import re
        error_msg = re.sub(r'\x1b\[[0-9;]*m', '', error_msg)

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
        "duration_seconds": round(duration, 2),
        "frames_used": len(frame_paths),
    }


# --- Main pipeline ---

def process_video(video_path, output_dir=None, project_root=None,
                  min_frames=8, max_frames=80, keep_frames=False):
    """Main pipeline: video -> frames -> score -> select -> stitch -> panorama.

    Returns a complete result dict suitable for JSON serialization.
    """
    if project_root is None:
        project_root = str(Path(__file__).parent)
    stitcher_binary = os.path.join(project_root, "build", "src", "image-stitching")

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
        frame_paths = extract_frames(video_path, frames_dir)
        timings["extract_seconds"] = round(time.time() - t0, 2)

        # 3. Score frames
        t0 = time.time()
        scored, filesize_threshold = score_frames(frame_paths, video_info)
        timings["score_seconds"] = round(time.time() - t0, 2)

        # 4. Select best frames
        t0 = time.time()
        selected_paths, selected_meta = select_frames(scored, min_frames, max_frames)
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

        # 5. Generate config
        generate_config(output_dir)

        # 6. Run stitcher
        t0 = time.time()
        stitch_result = run_stitcher(stitcher_binary, selected_paths, output_dir,
                                     min_connected=min_frames)
        timings["stitch_seconds"] = round(time.time() - t0, 2)

        # 7. Move output to final location
        final_path = os.path.join(output_dir, "panorama.jpg")
        shutil.move(stitch_result["output_path"], final_path)

        # Collect warnings
        warnings = []
        frames_used = stitch_result.get("frames_used", len(selected_paths))
        if frames_used < len(selected_paths):
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

        return {
            "status": "success",
            "output_path": os.path.abspath(final_path),
            "video": video_info,
            "quality": quality,
            "stitch": {
                "final_size": stitch_result["final_size"],
                "duration_seconds": stitch_result["duration_seconds"],
            },
            "warnings": warnings,
            "timing": timings,
        }

    finally:
        # Cleanup extracted frames unless asked to keep them
        if not keep_frames and os.path.isdir(frames_dir):
            shutil.rmtree(frames_dir, ignore_errors=True)
        if cleanup_dir and os.path.isdir(output_dir):
            # Don't remove if we wrote output there
            pass


def main():
    parser = argparse.ArgumentParser(
        description="Convert video to panorama using OpenPano",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Output: JSON result on stdout. Progress on stderr.\n"
               "Exit codes: 0=success, 1=quality too low, 2=input error, "
               "3=stitcher error, 4=internal error"
    )
    parser.add_argument("video_path", help="Path to input video file")
    parser.add_argument("--output-dir", "-o", help="Output directory (default: auto temp dir)")
    parser.add_argument("--project-root", help="OpenPano project root (default: script directory)")
    parser.add_argument("--min-frames", type=int, default=8, help="Minimum sharp frames required (default: 8)")
    parser.add_argument("--max-frames", type=int, default=80, help="Maximum frames to stitch (default: 80)")
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
