#!/usr/bin/env python3
"""OpenPano Web — Upload video, get interactive panorama viewer."""

import json
import os
import queue
import shutil
import subprocess
import threading
import time
import uuid

from flask import Flask, Response, jsonify, render_template, request, send_file

app = Flask(__name__)

# --- Configuration ---
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PYTHON_BIN = os.environ.get(
    "PYTHON", "/Users/xlib/micromamba/envs/pano/bin/python"
)
VIDEO2PANO = os.path.join(PROJECT_ROOT, "video2pano.py")
JOBS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "jobs")
ALLOWED_EXTENSIONS = {"mp4", "mov", "avi", "mkv", "webm", "m4v"}

app.config["MAX_CONTENT_LENGTH"] = 500 * 1024 * 1024  # 500 MB

# --- Job registry ---
jobs = {}  # job_id -> {status, progress_queue, result, output_dir, video_path}

# Stage mapping: (stderr keyword, UI label, percent)
STAGE_MAP = [
    ("Video:", "Probing video", 5),
    ("Extracting frames", "Extracting frames", 15),
    ("Extracted", "Frames extracted", 25),
    ("Sharpness", "Scoring quality", 35),
    ("Selected", "Frames selected", 45),
    ("Config:", "Configuring stitcher", 50),
    ("Running stitcher", "Stitching panorama", 55),
    ("mode failed", "Retrying alternate mode", 60),
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
    video_path = job["video_path"]

    cmd = [
        PYTHON_BIN, VIDEO2PANO,
        video_path,
        "-o", output_dir,
        "-e",
        "-v",
        "--project-root", PROJECT_ROOT,
    ]

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
                    q.put({"event": "progress", "data": {
                        "stage": label, "percent": pct, "detail": line,
                    }})
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

@app.route("/")
def index():
    return render_template("index.html")


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

    job_id = uuid.uuid4().hex[:12]
    job_dir = os.path.join(JOBS_DIR, job_id)
    os.makedirs(job_dir, exist_ok=True)

    video_path = os.path.join(job_dir, f"input.{ext}")
    f.save(video_path)

    jobs[job_id] = {
        "status": "processing",
        "progress_queue": queue.Queue(),
        "result": None,
        "output_dir": job_dir,
        "video_path": video_path,
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
                # Send keepalive comment to prevent timeout
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


@app.route("/api/jobs/<job_id>/result")
def job_result(job_id):
    if job_id not in jobs:
        return jsonify({"error": "Job not found"}), 404
    job = jobs[job_id]
    if job["result"] is None:
        return jsonify({"status": "processing"}), 202
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
    os.makedirs(JOBS_DIR, exist_ok=True)
    port = int(os.environ.get("PORT", 8080))
    print(f"OpenPano Web starting on http://localhost:{port}")
    print(f"Project root: {PROJECT_ROOT}")
    print(f"Python: {PYTHON_BIN}")
    app.run(host="0.0.0.0", port=port, debug=True, threaded=True)
