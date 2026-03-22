# OpenPano Engine

Panorama stitcher engine — converts video or images into panoramic images.

## Build

```bash
./generate.sh build
```

Requires: CMake 3.20+, C++11 compiler, make.

## Usage

### Video to Panorama
```bash
./generate.sh stitch video.mp4 -o ./output -v
# Or directly:
python3 video2pano.py video.mp4 --output-dir ./output --verbose
```

### Image Stitching
```bash
./generate.sh stitch-images img1.jpg img2.jpg img3.jpg
```

## CLI Flags

| Flag | Description |
|------|-------------|
| `-o, --output-dir` | Output directory (default: auto temp) |
| `--focal-length` | Override 35mm-equiv focal length (mm) |
| `-e, --equirectangular` | Output full 2:1 equirectangular |
| `--equirect-width` | Equirectangular width (default: 4096) |
| `--min-frames` | Min sharp frames required |
| `--max-frames` | Max frames to stitch |
| `-c, --config` | Path to video2pano.conf |
| `--project-root` | Engine root (default: script directory) |
| `--keep-frames` | Keep extracted frames |
| `-v, --verbose` | Verbose stderr output |

## Output Contract

**stdout**: JSON result
```json
{
  "status": "success",
  "output_path": "/path/to/panorama.jpg",
  "video": { "width", "height", "fps", "duration", ... },
  "quality": { "frames_stitched", "focal_length_35mm", ... },
  "stitch": {
    "final_size": [w, h],
    "mode": "estimate_camera|cylinder",
    "fov": { "haov", "vaov", "center_yaw", "center_pitch" },
    "pannellum": { "type", "panorama", "haov", "vaov", ... }
  },
  "warnings": [],
  "timing": { "total_seconds", ... }
}
```

**stderr**: Progress lines with keywords (for progress tracking):
`Video:`, `Extracting frames`, `Extracted`, `Sharpness`, `Selected`, `Config:`, `Running stitcher`, `Stitching complete`, `Cylinder FOV`, `Equirectangular output`

**Exit codes**: 0=success, 1=quality too low, 2=input error, 3=stitcher error, 4=internal error

## Dependencies

- Python 3.7+ (stdlib only)
- ffmpeg + ffprobe on PATH
- Optional: `opencv-python-headless` for better sharpness scoring
