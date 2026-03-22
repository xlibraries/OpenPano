// --- DOM refs ---
const uploadSection = document.getElementById("upload-section");
const processingSection = document.getElementById("processing-section");
const viewerSection = document.getElementById("viewer-section");
const errorSection = document.getElementById("error-section");

const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const uploadProgress = document.getElementById("upload-progress");
const uploadFill = document.getElementById("upload-fill");
const uploadPercent = document.getElementById("upload-percent");
const uploadError = document.getElementById("upload-error");

const stageLabel = document.getElementById("stage-label");
const processingFill = document.getElementById("processing-fill");
const processingDetail = document.getElementById("processing-detail");
const elapsedTime = document.getElementById("elapsed-time");

const ctrlAutorotate = document.getElementById("ctrl-autorotate");
const ctrlAutorotateSpeed = document.getElementById("ctrl-autorotate-speed");
const ctrlSpeedLabel = document.getElementById("ctrl-speed-label");
const ctrlHfov = document.getElementById("ctrl-hfov");
const ctrlHfovLabel = document.getElementById("ctrl-hfov-label");
const ctrlFullscreen = document.getElementById("ctrl-fullscreen");
const ctrlReset = document.getElementById("ctrl-reset");
const metaContent = document.getElementById("meta-content");
const warningsPanel = document.getElementById("warnings-panel");

let viewer = null;
let initialConfig = {};

// --- Section visibility ---
function showSection(section) {
    [uploadSection, processingSection, viewerSection, errorSection].forEach(
        (s) => (s.hidden = s !== section)
    );
}

// --- Drag & drop ---
dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => {
    if (fileInput.files.length) handleFile(fileInput.files[0]);
});

function handleFile(file) {
    uploadError.hidden = true;
    if (file.size > 500 * 1024 * 1024) {
        showError("File too large (max 500 MB)", true);
        return;
    }
    uploadFile(file);
}

function showError(msg, isUploadError) {
    if (isUploadError) {
        uploadError.textContent = msg;
        uploadError.hidden = false;
    } else {
        document.getElementById("error-message").textContent = msg;
        showSection(errorSection);
    }
}

// --- Upload ---
function uploadFile(file) {
    const formData = new FormData();
    formData.append("video", file);

    uploadProgress.hidden = false;
    uploadFill.style.width = "0%";
    uploadPercent.textContent = "Uploading... 0%";

    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            uploadFill.style.width = pct + "%";
            uploadPercent.textContent = `Uploading... ${pct}%`;
        }
    });

    xhr.onload = () => {
        if (xhr.status === 200) {
            const { job_id } = JSON.parse(xhr.responseText);
            showSection(processingSection);
            connectSSE(job_id);
        } else {
            let msg = "Upload failed";
            try {
                msg = JSON.parse(xhr.responseText).error || msg;
            } catch {}
            uploadProgress.hidden = true;
            showError(msg, true);
        }
    };

    xhr.onerror = () => {
        uploadProgress.hidden = true;
        showError("Network error during upload", true);
    };

    xhr.open("POST", "/api/upload");
    xhr.send(formData);
}

// --- SSE progress ---
function connectSSE(jobId) {
    const startTime = Date.now();
    const timer = setInterval(() => {
        const s = Math.round((Date.now() - startTime) / 1000);
        elapsedTime.textContent = `Elapsed: ${s}s`;
    }, 1000);

    const es = new EventSource(`/api/jobs/${jobId}/events`);

    es.addEventListener("progress", (e) => {
        const data = JSON.parse(e.data);
        processingFill.style.width = data.percent + "%";
        stageLabel.textContent = data.stage;
        processingDetail.textContent = data.detail;
    });

    es.addEventListener("complete", (e) => {
        clearInterval(timer);
        es.close();
        const result = JSON.parse(e.data);
        showViewer(result, jobId);
    });

    es.addEventListener("error", (e) => {
        clearInterval(timer);
        es.close();
        // Fallback: poll result endpoint
        pollResult(jobId);
    });
}

function pollResult(jobId) {
    fetch(`/api/jobs/${jobId}/result`)
        .then((r) => r.json())
        .then((data) => {
            if (data.status === "processing") {
                setTimeout(() => pollResult(jobId), 2000);
            } else if (data.status === "success") {
                showViewer(data, jobId);
            } else {
                showError(data.error_message || "Processing failed");
            }
        })
        .catch(() => showError("Lost connection to server"));
}

// --- Viewer ---
function showViewer(result, jobId) {
    showSection(viewerSection);

    const panoConfig = result.stitch.pannellum;
    const fov = result.stitch.fov || {};

    const config = {
        ...panoConfig,
        autoLoad: true,
        showControls: true,
        mouseZoom: true,
        keyboardZoom: true,
        draggable: true,
        friction: 0.15,
        showFullscreenCtrl: false, // we have our own button
        compass: false,
    };

    // Comfortable initial FOV
    if (fov.haov) {
        config.hfov = Math.min(100, fov.haov * 0.8);
    }
    if (fov.center_yaw !== undefined) config.yaw = fov.center_yaw;
    if (fov.center_pitch !== undefined) config.pitch = fov.center_pitch;

    // Update hfov slider range
    const maxFov = fov.haov || 360;
    ctrlHfov.max = Math.min(maxFov, 120);
    ctrlHfov.value = config.hfov || 100;
    ctrlHfovLabel.innerHTML = Math.round(ctrlHfov.value) + "&deg;";

    initialConfig = {
        hfov: config.hfov || 100,
        yaw: config.yaw || 0,
        pitch: config.pitch || 0,
    };

    // Destroy previous viewer if any
    if (viewer) {
        viewer.destroy();
        viewer = null;
    }

    viewer = window.pannellum.viewer("panorama-viewer", config);

    populateMetadata(result);
    setupControls();
}

function populateMetadata(result) {
    const fov = result.stitch.fov || {};
    const q = result.quality || {};
    const t = result.timing || {};
    const st = result.stitch || {};

    let html = "";
    if (fov.haov) html += `<div><strong>FOV:</strong> ${fov.haov.toFixed(1)}&deg; x ${fov.vaov.toFixed(1)}&deg;</div>`;
    if (st.mode) html += `<div><strong>Mode:</strong> ${st.mode}</div>`;
    if (st.final_size) html += `<div><strong>Size:</strong> ${st.final_size[0]} x ${st.final_size[1]}</div>`;
    if (q.frames_stitched) html += `<div><strong>Frames:</strong> ${q.frames_stitched} stitched</div>`;
    if (q.focal_length_35mm) html += `<div><strong>Focal:</strong> ${q.focal_length_35mm}mm (${q.focal_source || "default"})</div>`;
    if (t.total_seconds) html += `<div><strong>Time:</strong> ${t.total_seconds.toFixed(1)}s total</div>`;

    metaContent.innerHTML = html;

    // Warnings
    const warnings = result.warnings || [];
    if (warnings.length) {
        warningsPanel.hidden = false;
        warningsPanel.innerHTML = warnings.map((w) => `<div>&#9888; ${w}</div>`).join("");
    } else {
        warningsPanel.hidden = true;
    }
}

function setupControls() {
    ctrlAutorotate.checked = false;
    ctrlAutorotateSpeed.disabled = true;

    ctrlAutorotate.onchange = () => {
        ctrlAutorotateSpeed.disabled = !ctrlAutorotate.checked;
        if (ctrlAutorotate.checked) {
            viewer.startAutoRotate(parseFloat(ctrlAutorotateSpeed.value));
        } else {
            viewer.stopAutoRotate();
        }
    };

    ctrlAutorotateSpeed.oninput = () => {
        ctrlSpeedLabel.textContent = parseFloat(ctrlAutorotateSpeed.value).toFixed(1);
        if (ctrlAutorotate.checked) {
            viewer.startAutoRotate(parseFloat(ctrlAutorotateSpeed.value));
        }
    };

    ctrlHfov.oninput = () => {
        const val = parseInt(ctrlHfov.value);
        ctrlHfovLabel.innerHTML = val + "&deg;";
        viewer.setHfov(val);
    };

    ctrlFullscreen.onclick = () => viewer.toggleFullscreen();
    ctrlReset.onclick = () => {
        viewer.setHfov(initialConfig.hfov);
        viewer.setYaw(initialConfig.yaw);
        viewer.setPitch(initialConfig.pitch);
        ctrlHfov.value = initialConfig.hfov;
        ctrlHfovLabel.innerHTML = Math.round(initialConfig.hfov) + "&deg;";
    };
}

// --- Reset / retry ---
document.getElementById("new-pano-btn").addEventListener("click", resetToUpload);
document.getElementById("error-retry-btn").addEventListener("click", resetToUpload);

function resetToUpload() {
    if (viewer) {
        viewer.destroy();
        viewer = null;
    }
    fileInput.value = "";
    uploadProgress.hidden = true;
    uploadError.hidden = true;
    processingFill.style.width = "0%";
    stageLabel.textContent = "Starting pipeline...";
    processingDetail.textContent = "";
    elapsedTime.textContent = "Elapsed: 0s";
    showSection(uploadSection);
}
