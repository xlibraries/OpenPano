#!/usr/bin/env bash
#
# generate.sh - Build OpenPano and run the video-to-panorama pipeline.
#
# Usage:
#   ./generate.sh build                        # Build the C++ stitcher
#   ./generate.sh stitch <video> [options]      # Video to panorama
#   ./generate.sh stitch-images <img1> <img2>.. # Stitch images directly
#
# Examples:
#   ./generate.sh build
#   ./generate.sh stitch video.mp4
#   ./generate.sh stitch video.mp4 -o ./output --focal-length 28 --verbose
#   ./generate.sh stitch-images img1.jpg img2.jpg img3.jpg
#
# Environment:
#   PYTHON          Python binary (default: python3)
#   OPENPANO_ROOT   Project root (default: directory containing this script)
#   JOBS            Parallel build jobs (default: nproc)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENPANO_ROOT="${OPENPANO_ROOT:-$SCRIPT_DIR}"
PYTHON="${PYTHON:-python3}"
JOBS="${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)}"

BUILD_DIR="$OPENPANO_ROOT/build"
STITCHER_BIN="$BUILD_DIR/src/image-stitching"
VIDEO2PANO="$OPENPANO_ROOT/video2pano.py"

# Colors (disabled if not a terminal)
if [ -t 1 ]; then
    GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; NC='\033[0m'
else
    GREEN=''; RED=''; YELLOW=''; NC=''
fi

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*" >&2; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ---- Commands ----

cmd_build() {
    info "Building OpenPano..."

    if ! command -v cmake &>/dev/null; then
        error "cmake not found. Install it with: brew install cmake (macOS) or apt install cmake (Linux)"
    fi

    cmake -B "$BUILD_DIR" "$OPENPANO_ROOT" 2>&1 | tail -5
    make -C "$BUILD_DIR" -j"$JOBS" 2>&1 | tail -10

    if [ -f "$STITCHER_BIN" ]; then
        info "Build successful: $STITCHER_BIN"
    else
        error "Build failed: binary not found at $STITCHER_BIN"
    fi
}

cmd_stitch() {
    if [ $# -lt 1 ]; then
        error "Usage: $0 stitch <video_path> [options]\nRun '$0 stitch --help' for all options."
    fi

    # Ensure stitcher is built
    if [ ! -f "$STITCHER_BIN" ]; then
        warn "Stitcher binary not found. Building first..."
        cmd_build
    fi

    # Check python + dependencies
    if ! "$PYTHON" -c "import sys; assert sys.version_info >= (3, 7)" 2>/dev/null; then
        error "Python 3.7+ required. Set PYTHON env var to your python binary."
    fi

    if ! command -v ffmpeg &>/dev/null; then
        error "ffmpeg not found. Install it with: brew install ffmpeg (macOS) or apt install ffmpeg (Linux)"
    fi

    info "Running video2pano pipeline..."
    "$PYTHON" "$VIDEO2PANO" --project-root "$OPENPANO_ROOT" "$@"
}

cmd_stitch_images() {
    if [ $# -lt 2 ]; then
        error "Usage: $0 stitch-images <image1> <image2> [image3 ...]"
    fi

    # Ensure stitcher is built
    if [ ! -f "$STITCHER_BIN" ]; then
        warn "Stitcher binary not found. Building first..."
        cmd_build
    fi

    info "Stitching ${#} images..."
    "$STITCHER_BIN" "$@"

    if [ -f out.jpg ]; then
        info "Output: out.jpg"
    fi
}

cmd_help() {
    cat <<'HELP'
generate.sh - Build and run OpenPano panorama stitcher

Commands:
  build                         Build the C++ stitcher binary
  stitch <video> [options]      Convert video to panorama
  stitch-images <img> <img>..   Stitch images directly (uses config.cfg in cwd)
  help                          Show this help

Stitch options (passed to video2pano.py):
  -o, --output-dir DIR          Output directory (default: auto temp dir)
  -c, --config FILE             Config file (default: video2pano.conf)
  --focal-length MM             Override focal length in 35mm equivalent
  --min-frames N                Minimum sharp frames required (default: 8)
  --max-frames N                Maximum frames to stitch (default: 80)
  --keep-frames                 Keep extracted frames after stitching
  -v, --verbose                 Verbose logging

Environment variables:
  PYTHON          Python binary (default: python3)
  OPENPANO_ROOT   Project root (default: script directory)
  JOBS            Parallel build jobs (default: auto)

Examples:
  ./generate.sh build
  ./generate.sh stitch my_video.mp4 -o ./output -v
  ./generate.sh stitch my_video.mp4 --focal-length 28
  ./generate.sh stitch-images photo1.jpg photo2.jpg photo3.jpg
HELP
}

# ---- Main ----

case "${1:-help}" in
    build)          shift; cmd_build "$@" ;;
    stitch)         shift; cmd_stitch "$@" ;;
    stitch-images)  shift; cmd_stitch_images "$@" ;;
    help|--help|-h) cmd_help ;;
    *)              error "Unknown command: $1\nRun '$0 help' for usage." ;;
esac
