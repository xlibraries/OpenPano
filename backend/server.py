#!/usr/bin/env python3
"""OpenPano Backend — REST API for panorama pipeline."""

import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
import uuid

from flask import Flask, Response, jsonify, request, send_file

app = Flask(__name__)

# --- Configuration via environment variables ---
ENGINE_PYTHON = os.environ.get("ENGINE_PYTHON", "python3")
ENGINE_SCRIPT = os.environ.get("ENGINE_SCRIPT")  # Required: path to video2pano.py
_engine_root = os.environ.get("ENGINE_ROOT")  # Optional: --project-root for engine
ENGINE_ROOT = os.path.abspath(_engine_root) if _engine_root else None
JOBS_DIR = os.environ.get(
    "JOBS_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "jobs")
)
DEFAULT_STITCH_BACKEND = os.environ.get("ENGINE_DEFAULT_STITCH_BACKEND", "openpano")
VALID_STITCH_BACKENDS = {"openpano", "hugin"}
ALLOWED_EXTENSIONS = {"mp4", "mov", "avi", "mkv", "webm", "m4v"}
ALLOWED_IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}

app.config["MAX_CONTENT_LENGTH"] = 500 * 1024 * 1024  # 500 MB

# --- Job registry ---
jobs = {}  # job_id -> {status, progress_queue, progress, result, output_dir, video_path}

# Stage mapping: (stderr keyword, UI label, percent)
STAGE_MAP = [
    ("Video:", "Probing video", 5),
    ("Image set:", "Loading still images", 8),
    ("Extracting frames", "Extracting frames", 15),
    ("Extracted", "Frames extracted", 25),
    ("Sharpness", "Scoring quality", 35),
    ("Selected", "Frames selected", 45),
    ("Config:", "Configuring stitcher", 50),
    ("Running stitcher", "Stitching panorama", 55),
    ("mode failed", "Retrying alternate mode", 60),
    ("Hugin project:", "Preparing Hugin project", 50),
    ("Hugin control points:", "Finding control points", 58),
    ("Hugin optimize:", "Optimizing panorama", 66),
    ("Hugin modify:", "Preparing equirect output", 72),
    ("Hugin remap:", "Remapping panorama", 78),
    ("Hugin blend:", "Blending panorama", 86),
    ("Hugin export:", "Exporting panorama", 92),
    ("Hugin stitching complete", "Stitch complete", 95),
    ("Stitching complete", "Stitch complete", 85),
    ("Cylinder FOV", "Computing FOV", 90),
    ("Equirectangular output", "Formatting output", 95),
]


def cleanup_old_jobs(max_age_seconds=7200):
    """Remove job directories older than max_age_seconds."""
    if not os.path.isdir(JOBS_DIR):
        return
    now = time.time()
    for name in os.listdir(JOBS_DIR):
        path = os.path.join(JOBS_DIR, name)
        if os.path.isdir(path):
            try:
                age = now - os.path.getmtime(path)
                if age > max_age_seconds:
                    shutil.rmtree(path, ignore_errors=True)
                    jobs.pop(name, None)
            except OSError:
                pass


def run_pipeline(job_id):
    """Background thread: run video2pano.py and stream progress via queue."""
    job = jobs[job_id]
    q = job["progress_queue"]
    output_dir = job["output_dir"]
    input_path = job["input_path"]
    stitch_backend = job["stitch_backend"]

    cmd = [
        ENGINE_PYTHON, ENGINE_SCRIPT,
        input_path,
        "-o", output_dir,
        "-v",
        "--stitcher-backend", stitch_backend,
    ]
    if job.get("input_mode") == "images":
        cmd.extend(["--input-mode", "images"])
    if ENGINE_ROOT:
        cmd.extend(["--project-root", ENGINE_ROOT])
    if job.get("equirectangular"):
        cmd.append("--equirectangular")
        eq_width = job.get("equirect_width")
        if eq_width:
            cmd.extend(["--equirect-width", str(eq_width)])
    if job.get("max_frames"):
        cmd.extend(["--max-frames", str(job["max_frames"])])
    if job.get("focal_length"):
        cmd.extend(["--focal-length", str(job["focal_length"])])

    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )

        for line in proc.stderr:
            line = line.strip()
            if not line:
                continue
            for keyword, label, pct in STAGE_MAP:
                if keyword in line:
                    progress = {
                        "stage": label, "percent": pct, "detail": line,
                    }
                    job["progress"] = progress
                    q.put({"event": "progress", "data": progress})
                    break

        proc.wait()
        stdout = proc.stdout.read()

        if proc.returncode == 0 and stdout.strip():
            result = json.loads(stdout)
            result["stitch"]["pannellum"]["panorama"] = (
                f"/api/jobs/{job_id}/panorama"
            )
            job["result"] = result
            job["status"] = "complete"
            q.put({"event": "complete", "data": result})
        else:
            try:
                result = json.loads(stdout) if stdout.strip() else {}
            except json.JSONDecodeError:
                result = {}
            error_msg = result.get(
                "error_message",
                f"Pipeline failed (exit code {proc.returncode})",
            )
            result.setdefault("status", "error")
            result.setdefault("error_message", error_msg)
            job["result"] = result
            job["status"] = "error"
            q.put({"event": "error", "data": result})

    except Exception as e:
        job["status"] = "error"
        job["result"] = {"status": "error", "error_message": str(e)}
        q.put({"event": "error", "data": job["result"]})
    finally:
        q.put(None)  # sentinel to close SSE stream


# --- Routes ---

@app.route("/api/upload", methods=["POST"])
def upload():
    cleanup_old_jobs()

    if "video" not in request.files:
        return jsonify({"error": "No video file provided"}), 400

    f = request.files["video"]
    if not f.filename:
        return jsonify({"error": "No file selected"}), 400

    ext = f.filename.rsplit(".", 1)[-1].lower() if "." in f.filename else ""
    if ext not in ALLOWED_EXTENSIONS:
        return jsonify({
            "error": f"Invalid file type '.{ext}'. Accepted: {', '.join(sorted(ALLOWED_EXTENSIONS))}"
        }), 400

    stitch_backend = request.form.get("stitch_backend", DEFAULT_STITCH_BACKEND).strip().lower()
    if stitch_backend not in VALID_STITCH_BACKENDS:
        return jsonify({
            "error": f"Invalid stitch backend '{stitch_backend}'. Valid options: {', '.join(sorted(VALID_STITCH_BACKENDS))}"
        }), 400

    equirectangular = request.form.get("equirectangular", "0").strip() in ("1", "true", "yes")

    equirect_width = None
    raw_eq_width = request.form.get("equirect_width", "").strip()
    if raw_eq_width:
        try:
            equirect_width = int(raw_eq_width)
            if equirect_width not in (2048, 4096, 8192):
                equirect_width = 4096
        except ValueError:
            equirect_width = 4096

    max_frames = None
    raw_max_frames = request.form.get("max_frames", "").strip()
    if raw_max_frames:
        try:
            max_frames = int(raw_max_frames)
            if not (1 <= max_frames <= 500):
                max_frames = None
        except ValueError:
            max_frames = None

    focal_length = None
    raw_focal = request.form.get("focal_length", "").strip()
    if raw_focal:
        try:
            focal_length = float(raw_focal)
            if not (5.0 <= focal_length <= 200.0):
                focal_length = None
        except ValueError:
            focal_length = None

    job_id = uuid.uuid4().hex[:12]
    job_dir = os.path.join(JOBS_DIR, job_id)
    os.makedirs(job_dir, exist_ok=True)

    video_path = os.path.join(job_dir, f"input.{ext}")
    f.save(video_path)

    jobs[job_id] = {
        "status": "processing",
        "progress_queue": queue.Queue(),
        "progress": {"stage": "Starting pipeline...", "percent": 0, "detail": ""},
        "result": None,
        "output_dir": job_dir,
        "input_mode": "video",
        "input_path": video_path,
        "video_path": video_path,
        "stitch_backend": stitch_backend,
        "equirectangular": equirectangular,
        "equirect_width": equirect_width,
        "max_frames": max_frames,
        "focal_length": focal_length,
    }

    thread = threading.Thread(target=run_pipeline, args=(job_id,), daemon=True)
    thread.start()

    return jsonify({"job_id": job_id})


@app.route("/api/upload-photosphere", methods=["POST"])
def upload_photosphere():
    cleanup_old_jobs()

    photos = request.files.getlist("photos")
    if not photos:
        return jsonify({"error": "No still photos provided"}), 400

    stitch_backend = request.form.get("stitch_backend", "hugin").strip().lower()
    if stitch_backend not in VALID_STITCH_BACKENDS:
        return jsonify({
            "error": f"Invalid stitch backend '{stitch_backend}'. Valid options: {', '.join(sorted(VALID_STITCH_BACKENDS))}"
        }), 400

    equirectangular = request.form.get("equirectangular", "1").strip() in ("1", "true", "yes")

    equirect_width = None
    raw_eq_width = request.form.get("equirect_width", "").strip()
    if raw_eq_width:
        try:
            equirect_width = int(raw_eq_width)
            if equirect_width not in (2048, 4096, 8192):
                equirect_width = 4096
        except ValueError:
            equirect_width = 4096

    max_frames = None
    raw_max_frames = request.form.get("max_frames", "").strip()
    if raw_max_frames:
        try:
            max_frames = int(raw_max_frames)
            if not (1 <= max_frames <= 500):
                max_frames = None
        except ValueError:
            max_frames = None

    focal_length = None
    raw_focal = request.form.get("focal_length", "").strip()
    if raw_focal:
        try:
            focal_length = float(raw_focal)
            if not (5.0 <= focal_length <= 200.0):
                focal_length = None
        except ValueError:
            focal_length = None

    job_id = uuid.uuid4().hex[:12]
    job_dir = os.path.join(JOBS_DIR, job_id)
    os.makedirs(job_dir, exist_ok=True)
    stills_dir = os.path.join(job_dir, "stills")
    os.makedirs(stills_dir, exist_ok=True)

    for idx, photo in enumerate(photos, start=1):
        filename = photo.filename or f"photo_{idx}.jpg"
        ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
        if ext not in ALLOWED_IMAGE_EXTENSIONS:
            return jsonify({
                "error": f"Invalid image type '.{ext}'. Accepted: {', '.join(sorted(ALLOWED_IMAGE_EXTENSIONS))}"
            }), 400
        out_path = os.path.join(stills_dir, f"shot_{idx:03d}.{ext}")
        photo.save(out_path)

    capture_metadata = request.form.get("capture_metadata", "").strip()
    metadata_path = None
    if capture_metadata:
        metadata_path = os.path.join(job_dir, "capture_metadata.json")
        with open(metadata_path, "w", encoding="utf-8") as fh:
            fh.write(capture_metadata)

    jobs[job_id] = {
        "status": "processing",
        "progress_queue": queue.Queue(),
        "progress": {"stage": "Starting pipeline...", "percent": 0, "detail": ""},
        "result": None,
        "output_dir": job_dir,
        "input_mode": "images",
        "input_path": stills_dir,
        "stitch_backend": stitch_backend,
        "equirectangular": equirectangular,
        "equirect_width": equirect_width,
        "max_frames": max_frames,
        "focal_length": focal_length,
        "capture_metadata_path": metadata_path,
    }

    thread = threading.Thread(target=run_pipeline, args=(job_id,), daemon=True)
    thread.start()

    return jsonify({"job_id": job_id})


@app.route("/api/jobs/<job_id>/events")
def job_events(job_id):
    if job_id not in jobs:
        return jsonify({"error": "Job not found"}), 404

    def generate():
        q = jobs[job_id]["progress_queue"]
        while True:
            try:
                msg = q.get(timeout=60)
            except queue.Empty:
                yield ": keepalive\n\n"
                continue
            if msg is None:
                break
            yield f"event: {msg['event']}\ndata: {json.dumps(msg['data'])}\n\n"

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/api/jobs/<job_id>/status")
def job_status(job_id):
    if job_id not in jobs:
        return jsonify({"error": "Job not found"}), 404
    job = jobs[job_id]
    if job["result"] is None:
        return jsonify({"status": "processing", "progress": job["progress"]})
    return jsonify(job["result"])


@app.route("/api/jobs/<job_id>/panorama")
def serve_panorama(job_id):
    if job_id not in jobs:
        return jsonify({"error": "Job not found"}), 404
    pano_path = os.path.join(jobs[job_id]["output_dir"], "panorama.jpg")
    if not os.path.isfile(pano_path):
        return jsonify({"error": "Panorama not ready"}), 404
    return send_file(pano_path, mimetype="image/jpeg")


if __name__ == "__main__":
    if not ENGINE_SCRIPT:
        print("ERROR: ENGINE_SCRIPT env var must be set (path to video2pano.py)")
        sys.exit(1)
    if not os.path.isfile(ENGINE_SCRIPT):
        print(f"ERROR: ENGINE_SCRIPT not found: {ENGINE_SCRIPT}")
        sys.exit(1)
    os.makedirs(JOBS_DIR, exist_ok=True)
    port = int(os.environ.get("PORT", 8080))
    print(f"OpenPano Backend starting on http://localhost:{port}")
    print(f"Engine: {ENGINE_PYTHON} {ENGINE_SCRIPT}")
    if ENGINE_ROOT:
        print(f"Engine root: {ENGINE_ROOT}")
    app.run(host="0.0.0.0", port=port, debug=True, threaded=True)
