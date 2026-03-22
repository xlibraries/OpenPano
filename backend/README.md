# OpenPano Backend

Flask REST API server for the panorama pipeline.

## Setup

```bash
pip install -r requirements.txt
```

## Configuration

Set via environment variables (or copy `.env.example` to `.env`):

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ENGINE_SCRIPT` | Yes | — | Path to engine's `video2pano.py` |
| `ENGINE_PYTHON` | No | `python3` | Python binary for the engine |
| `ENGINE_ROOT` | No | — | Engine project root (`--project-root`) |
| `PORT` | No | `8080` | Server port |
| `JOBS_DIR` | No | `./jobs` | Job artifact directory |

## Run

```bash
ENGINE_SCRIPT=../engine/video2pano.py ENGINE_ROOT=../engine python3 server.py
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/upload` | Upload video file (multipart form, field: `video`) → `{ job_id }` |
| GET | `/api/jobs/<id>/status` | Poll job progress/result |
| GET | `/api/jobs/<id>/events` | SSE stream of progress events |
| GET | `/api/jobs/<id>/panorama` | Serve the output panorama image |

## Engine Contract

The backend invokes the engine as a subprocess:
```
$ENGINE_PYTHON $ENGINE_SCRIPT <video> -o <output_dir> -v [--project-root $ENGINE_ROOT]
```

Expected: JSON on stdout, progress keywords on stderr, exit code 0 on success.
