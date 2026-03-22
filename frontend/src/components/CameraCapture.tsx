import { useCallback, useEffect, useRef, useState } from "react";

// ── types ────────────────────────────────────────────────────────────────────
type CaptureMode = "video" | "photo";
type Step = "mode-select" | "capture" | "review";

interface Photo {
  blob: Blob;
  angle: number;  // compass heading (0-360) when captured
  url: string;    // object URL for preview
}

interface CameraCaptureProps {
  onJobStarted: (jobId: string) => void;
  onCancel: () => void;
}

// ── constants ────────────────────────────────────────────────────────────────
// 8 evenly-spaced target angles for photo mode
const TARGETS = [0, 45, 90, 135, 180, 225, 270, 315];
const SNAP_RADIUS = 22; // degrees close-enough to a target

// ── helpers ───────────────────────────────────────────────────────────────────
function angleDiff(a: number, b: number) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// SVG arc path (clockwise from `from` to `to`, both in degrees, 0 = top)
function describeArc(
  cx: number, cy: number, r: number, from: number, to: number
): string {
  const rad = (deg: number) => ((deg - 90) * Math.PI) / 180;
  const px = (deg: number) => cx + r * Math.cos(rad(deg));
  const py = (deg: number) => cy + r * Math.sin(rad(deg));
  const large = to - from > 180 ? 1 : 0;
  return `M ${px(from)} ${py(from)} A ${r} ${r} 0 ${large} 1 ${px(to)} ${py(to)}`;
}

// ── CameraCapture ─────────────────────────────────────────────────────────────
export default function CameraCapture({ onJobStarted, onCancel }: CameraCaptureProps) {
  const [step, setStep]               = useState<Step>("mode-select");
  const [mode, setMode]               = useState<CaptureMode>("video");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [photos, setPhotos]           = useState<Photo[]>([]);
  const [videoBlob, setVideoBlob]     = useState<Blob | null>(null);
  const [videoUrl, setVideoUrl]       = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordDuration, setRecordDuration] = useState(0);
  const [heading, setHeading]         = useState(0);
  const [coveredBuckets, setCoveredBuckets] = useState<Set<number>>(new Set());
  const [hasOrientation, setHasOrientation] = useState(false);
  const [uploading, setUploading]     = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [error, setError]             = useState<string | null>(null);
  const [synthesizing, setSynthesizing] = useState(false);

  const videoRef    = useRef<HTMLVideoElement>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef   = useRef<Blob[]>([]);
  const timerRef    = useRef<ReturnType<typeof setInterval> | null>(null);

  // clean up object URL when videoUrl changes
  useEffect(() => {
    return () => { if (videoUrl) URL.revokeObjectURL(videoUrl); };
  }, [videoUrl]);

  // ── camera ────────────────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    setCameraError(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError(
        "Camera access requires a secure connection (HTTPS). " +
        "Please open this page over HTTPS or on localhost."
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
    } catch (e) {
      if (e instanceof Error) {
        if (e.name === "NotAllowedError" || e.name === "PermissionDeniedError") {
          setCameraError(
            "Camera permission was denied. Please allow camera access in your browser settings and try again."
          );
        } else if (e.name === "NotFoundError" || e.name === "DevicesNotFoundError") {
          setCameraError("No camera found on this device.");
        } else if (e.name === "NotReadableError" || e.name === "TrackStartError") {
          setCameraError("Camera is already in use by another app. Close it and try again.");
        } else if (e.name === "OverconstrainedError") {
          // Retry without constraints
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
            streamRef.current = stream;
            if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play(); }
            return;
          } catch {
            setCameraError("Could not start camera with the requested settings.");
          }
        } else {
          setCameraError(`Could not start camera: ${e.message}`);
        }
      } else {
        setCameraError("An unexpected error occurred while accessing the camera.");
      }
    }
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // ── orientation tracking ──────────────────────────────────────────────────
  useEffect(() => {
    if (step !== "capture") return;
    let active = true;
    let fired = false;

    const handler = (e: DeviceOrientationEvent) => {
      if (!active) return;
      if (!fired) { fired = true; setHasOrientation(true); }
      const alpha = e.alpha ?? 0;
      setHeading(Math.round(alpha));
      const bucket = Math.floor(alpha / 10) * 10;
      setCoveredBuckets((prev) => {
        if (prev.has(bucket)) return prev;
        const next = new Set(prev);
        next.add(bucket);
        return next;
      });
    };

    const attach = async () => {
      // iOS 13+ requires permission
      const DOE = DeviceOrientationEvent as typeof DeviceOrientationEvent & {
        requestPermission?: () => Promise<string>;
      };
      if (typeof DOE.requestPermission === "function") {
        try {
          const perm = await DOE.requestPermission();
          if (perm !== "granted") return;
        } catch {
          return;
        }
      }
      window.addEventListener("deviceorientation", handler);
      // If no event fires after 2 s, device has no gyro (desktop)
      setTimeout(() => { if (!fired) setHasOrientation(false); }, 2000);
    };

    attach();
    return () => {
      active = false;
      window.removeEventListener("deviceorientation", handler);
    };
  }, [step]);

  // ── enter / leave capture ─────────────────────────────────────────────────
  const enterCapture = useCallback(
    async (m: CaptureMode) => {
      setMode(m);
      setPhotos([]);
      setVideoBlob(null);
      setVideoUrl(null);
      setCoveredBuckets(new Set());
      setIsRecording(false);
      setRecordDuration(0);
      setHasOrientation(false);
      setError(null);
      setStep("capture");
      await startCamera();
    },
    [startCamera]
  );

  const leaveCapture = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    if (timerRef.current) clearInterval(timerRef.current);
    stopCamera();
  }, [stopCamera]);

  useEffect(() => () => leaveCapture(), [leaveCapture]);

  // ── photo capture ─────────────────────────────────────────────────────────
  const capturePhoto = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement("canvas");
    canvas.width  = video.videoWidth  || 1280;
    canvas.height = video.videoHeight || 720;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        setPhotos((prev) => [...prev, { blob, angle: heading, url }]);
      },
      "image/jpeg",
      0.92
    );
  }, [heading]);

  // ── video recording ────────────────────────────────────────────────────────
  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
      ? "video/webm;codecs=vp8"
      : "video/webm";
    chunksRef.current = [];
    const recorder = new MediaRecorder(stream, { mimeType });
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      const url  = URL.createObjectURL(blob);
      setVideoBlob(blob);
      setVideoUrl(url);
      leaveCapture();
      setStep("review");
    };
    recorder.start(200);
    recorderRef.current = recorder;
    setIsRecording(true);
    setRecordDuration(0);
    timerRef.current = setInterval(() => setRecordDuration((d) => d + 1), 1000);
  }, [leaveCapture]);

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
    if (timerRef.current) clearInterval(timerRef.current);
    setIsRecording(false);
  }, []);

  const donePhotos = useCallback(() => {
    leaveCapture();
    setStep("review");
  }, [leaveCapture]);

  // ── photo → video synthesis ────────────────────────────────────────────────
  const synthesizeVideo = useCallback(async (photoList: Photo[]): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      const sorted = [...photoList].sort((a, b) => a.angle - b.angle);
      const firstImg = new Image();
      firstImg.onload = () => {
        const W = firstImg.naturalWidth  || 1280;
        const H = firstImg.naturalHeight || 720;
        const canvas = document.createElement("canvas");
        canvas.width  = W;
        canvas.height = H;
        const ctx = canvas.getContext("2d")!;

        // captureStream is not in TS lib but is widely supported
        const captureStream = (canvas as HTMLCanvasElement & {
          captureStream(fps?: number): MediaStream;
        }).captureStream(2);

        const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
          ? "video/webm;codecs=vp8"
          : "video/webm";
        const chunks: Blob[] = [];
        const recorder = new MediaRecorder(captureStream, { mimeType });
        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
        recorder.onerror = () => reject(new Error("MediaRecorder error"));
        recorder.start(100);

        let idx = 0;
        const drawNext = () => {
          if (idx >= sorted.length) { setTimeout(() => recorder.stop(), 700); return; }
          const img = new Image();
          img.onload = () => { ctx.drawImage(img, 0, 0, W, H); idx++; setTimeout(drawNext, 700); };
          img.onerror = () => { idx++; setTimeout(drawNext, 100); };
          img.src = sorted[idx].url;
        };
        ctx.drawImage(firstImg, 0, 0, W, H);
        idx = 1;
        setTimeout(drawNext, 700);
      };
      firstImg.onerror = () => reject(new Error("Failed to load photo"));
      firstImg.src = sorted[0].url;
    });
  }, []);

  // ── upload ────────────────────────────────────────────────────────────────
  const handleCreatePanorama = useCallback(async () => {
    setError(null);
    try {
      let file: File;
      if (mode === "video" && videoBlob) {
        file = new File([videoBlob], "capture.webm", { type: videoBlob.type });
      } else {
        setSynthesizing(true);
        const blob = await synthesizeVideo(photos);
        setSynthesizing(false);
        file = new File([blob], "capture.webm", { type: blob.type });
      }

      setUploading(true);
      setUploadPercent(0);
      const formData = new FormData();
      formData.append("video", file);
      formData.append("stitch_backend", "openpano");
      formData.append("equirectangular", "1");
      formData.append("equirect_width", "4096");
      formData.append("max_frames", String(mode === "photo" ? photos.length : 80));

      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) setUploadPercent(Math.round((e.loaded / e.total) * 100));
      });
      xhr.onload = () => {
        setUploading(false);
        if (xhr.status === 200) {
          onJobStarted(JSON.parse(xhr.responseText).job_id);
        } else {
          let msg = "Upload failed";
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* noop */ }
          setError(msg);
        }
      };
      xhr.onerror = () => { setUploading(false); setError("Network error during upload"); };
      xhr.open("POST", "/api/upload");
      xhr.send(formData);
    } catch (e) {
      setSynthesizing(false);
      setUploading(false);
      setError(e instanceof Error ? e.message : "Failed to prepare capture");
    }
  }, [mode, videoBlob, photos, synthesizeVideo, onJobStarted]);

  // ── derived ───────────────────────────────────────────────────────────────
  const coveragePct  = Math.round((coveredBuckets.size / 36) * 100);
  const nextTarget   = TARGETS.find((t) => !photos.some((p) => angleDiff(p.angle, t) < SNAP_RADIUS)) ?? null;
  const atTarget     = nextTarget !== null && angleDiff(heading, nextTarget) < SNAP_RADIUS;
  const canDonePhoto = photos.length >= 4;

  // ────────────────────────────────────────────────────────────────────────────
  // RENDER: MODE SELECT
  // ────────────────────────────────────────────────────────────────────────────
  if (step === "mode-select") {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-4 py-12">
        <button
          onClick={onCancel}
          className="absolute top-5 left-5 text-muted hover:text-foreground text-sm transition-colors"
        >
          ← Back
        </button>

        <h1 className="text-4xl font-extrabold mb-2 bg-gradient-to-r from-rose-500 to-pink-500 bg-clip-text text-transparent">
          Capture 360°
        </h1>
        <p className="text-muted text-center mb-10 max-w-sm leading-relaxed">
          Choose how you'd like to capture your panorama
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 w-full max-w-xl">
          {/* Video Pan */}
          <button
            onClick={() => enterCapture("video")}
            className="bg-surface border border-border hover:border-primary/50 rounded-2xl p-7 text-left transition-all group"
          >
            <div className="text-5xl mb-4">🎥</div>
            <h3 className="text-lg font-semibold mb-1">Video Pan</h3>
            <p className="text-sm text-muted leading-relaxed">
              Record while slowly rotating 360°. Best for smooth, seamless panoramas.
            </p>
            <div className="mt-5 text-xs text-primary font-medium">Recommended →</div>
          </button>

          {/* Photo Burst */}
          <button
            onClick={() => enterCapture("photo")}
            className="bg-surface border border-border hover:border-primary/50 rounded-2xl p-7 text-left transition-all group"
          >
            <div className="text-5xl mb-4">📸</div>
            <h3 className="text-lg font-semibold mb-1">Photo Burst</h3>
            <p className="text-sm text-muted leading-relaxed">
              Snap 8 guided shots at each direction. Best for high-resolution detail.
            </p>
            <div className="mt-5 text-xs text-detail font-medium">8 shots · ~2 min</div>
          </button>
        </div>

        {/* Tips */}
        <div className="mt-12 max-w-xl w-full bg-surface border border-border rounded-xl px-5 py-4">
          <p className="text-xs text-detail uppercase tracking-wider mb-3">Tips for best results</p>
          <ul className="text-sm text-muted space-y-2">
            <li className="flex items-start gap-2"><span className="text-primary mt-0.5">✓</span>Stay in the same spot — rotate, don't walk</li>
            <li className="flex items-start gap-2"><span className="text-primary mt-0.5">✓</span>Keep your phone vertical and level</li>
            <li className="flex items-start gap-2"><span className="text-primary mt-0.5">✓</span>Avoid fast movements or shaky hands</li>
            <li className="flex items-start gap-2"><span className="text-primary mt-0.5">✓</span>Good lighting makes a big difference</li>
          </ul>
        </div>
      </div>
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // RENDER: CAPTURE
  // ────────────────────────────────────────────────────────────────────────────
  if (step === "capture") {
    return (
      <div className="relative min-h-screen bg-black flex flex-col overflow-hidden">
        {/* Live camera preview */}
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="absolute inset-0 w-full h-full object-cover"
        />

        {/* Dark gradient top + bottom for readability */}
        <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-transparent to-black/60 pointer-events-none" />

        {/* Overlay UI */}
        <div className="relative z-10 flex flex-col h-screen">

          {/* ── Top bar ── */}
          <div className="flex items-center justify-between px-4 pt-4">
            <button
              onClick={() => { leaveCapture(); setStep("mode-select"); }}
              className="bg-black/50 backdrop-blur-sm text-white px-3 py-1.5 rounded-full text-sm hover:bg-black/70 transition-colors"
            >
              ← Back
            </button>

            {mode === "video" && isRecording && (
              <div className="bg-black/50 backdrop-blur-sm text-white px-3 py-1.5 rounded-full text-sm flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                {String(Math.floor(recordDuration / 60)).padStart(2, "0")}:
                {String(recordDuration % 60).padStart(2, "0")}
              </div>
            )}
          </div>

          {/* ── Center guide ── */}
          <div className="flex-1 flex flex-col items-center justify-center gap-5">
            {/* Rotation compass (only when gyro available) */}
            {hasOrientation && (
              <RotationGuide
                heading={heading}
                coveredBuckets={coveredBuckets}
                photos={photos}
                mode={mode}
                targets={TARGETS}
                nextTarget={nextTarget}
              />
            )}

            {/* Instruction bubble */}
            <div className={`bg-black/60 backdrop-blur-sm text-white text-sm px-4 py-2 rounded-full text-center max-w-xs transition-colors ${atTarget ? "bg-primary/70" : ""}`}>
              {mode === "video"
                ? isRecording
                  ? hasOrientation
                    ? `Rotate slowly · ${coveragePct}% covered`
                    : "Rotate slowly around you"
                  : "Press record, then rotate 360°"
                : nextTarget !== null
                ? atTarget
                  ? "Perfect! Tap capture 📸"
                  : hasOrientation
                    ? `Aim at ${nextTarget}° · ${photos.length}/${TARGETS.length} shots`
                    : `Shot ${photos.length + 1} of ${TARGETS.length}`
                : "All angles captured! Tap Done ✓"}
            </div>

            {/* Crosshair for photo mode (no gyro) */}
            {mode === "photo" && !hasOrientation && (
              <div className="relative w-20 h-20">
                <div className="absolute inset-0 border-2 border-white/50 rounded-full" />
                <div className="absolute top-1/2 left-0 right-0 h-px bg-white/40" />
                <div className="absolute left-1/2 top-0 bottom-0 w-px bg-white/40" />
              </div>
            )}
          </div>

          {/* ── Bottom controls ── */}
          <div className="pb-10 flex flex-col items-center gap-4">
            {mode === "video" ? (
              <button
                onClick={isRecording ? stopRecording : startRecording}
                className={`w-20 h-20 rounded-full border-4 flex items-center justify-center transition-all ${
                  isRecording
                    ? "border-red-500 bg-red-500/20 scale-110"
                    : "border-white bg-white/10 hover:bg-white/20"
                }`}
              >
                {isRecording
                  ? <span className="w-7 h-7 rounded-sm bg-red-500" />
                  : <span className="w-7 h-7 rounded-full bg-white" />
                }
              </button>
            ) : (
              <div className="flex items-center gap-8">
                <button
                  onClick={capturePhoto}
                  disabled={photos.length >= TARGETS.length}
                  className={`w-20 h-20 rounded-full border-4 flex items-center justify-center transition-all ${
                    atTarget
                      ? "border-primary bg-primary/20 scale-110"
                      : "border-white bg-white/10 hover:bg-white/20"
                  } disabled:opacity-30`}
                >
                  <span className="w-7 h-7 rounded-full bg-white" />
                </button>

                {canDonePhoto && (
                  <button
                    onClick={donePhotos}
                    className="bg-primary text-white px-5 py-2.5 rounded-full text-sm font-medium hover:bg-primary-hover transition-colors"
                  >
                    Done ({photos.length}/{TARGETS.length})
                  </button>
                )}
              </div>
            )}

            {/* Photo strip */}
            {mode === "photo" && photos.length > 0 && (
              <div className="flex gap-2 px-4 overflow-x-auto max-w-full" style={{ scrollbarWidth: "none" }}>
                {photos.map((p, i) => (
                  <div key={i} className="relative shrink-0">
                    <img src={p.url} alt="" className="h-14 w-20 object-cover rounded-lg border-2 border-white/40" />
                    <span className="absolute bottom-0.5 right-1 text-[10px] bg-black/60 text-white px-1 rounded">
                      {Math.round(p.angle)}°
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Camera error overlay */}
        {cameraError && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/80 px-4">
            <div className="bg-surface rounded-2xl p-8 max-w-sm w-full text-center">
              <div className="text-4xl mb-4">📷</div>
              <p className="text-muted mb-6 text-sm leading-relaxed">{cameraError}</p>
              <button
                onClick={() => { leaveCapture(); setStep("mode-select"); }}
                className="px-6 py-2.5 border border-border rounded-lg text-sm hover:border-primary/50 transition-colors"
              >
                Go Back
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // RENDER: REVIEW
  // ────────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col items-center px-4 py-10">
      <div className="w-full max-w-2xl">
        <button
          onClick={() => enterCapture(mode)}
          className="text-muted hover:text-foreground text-sm mb-6 inline-block transition-colors"
        >
          ← Retake
        </button>

        <h2 className="text-2xl font-bold mb-1">Review Capture</h2>
        <p className="text-muted text-sm mb-6">
          {mode === "photo"
            ? `${photos.length} photo${photos.length !== 1 ? "s" : ""} captured · will be stitched as equirectangular 360°`
            : "Video recorded · will be processed as equirectangular 360°"}
        </p>

        {/* Preview */}
        {mode === "photo" ? (
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-3 mb-8">
            {photos.map((p, i) => (
              <div key={i} className="relative aspect-video rounded-xl overflow-hidden bg-surface border border-border">
                <img src={p.url} alt="" className="w-full h-full object-cover" />
                <span className="absolute bottom-1 right-1.5 text-[10px] bg-black/60 text-white px-1.5 py-0.5 rounded">
                  {Math.round(p.angle)}°
                </span>
              </div>
            ))}
          </div>
        ) : videoUrl ? (
          <video
            src={videoUrl}
            controls
            className="w-full rounded-xl mb-8 bg-black border border-border"
            style={{ maxHeight: "50vh" }}
          />
        ) : null}

        {/* Output badge */}
        <div className="flex items-center gap-2 bg-surface border border-border rounded-lg px-4 py-3 mb-6 text-sm">
          <span className="text-primary">🌐</span>
          <span className="text-muted">Output: <strong className="text-foreground">Equirectangular 360° · 4K</strong> — ready for 360° viewers</span>
        </div>

        {/* Error */}
        {error && <p className="text-red-500 text-sm mb-4">{error}</p>}

        {/* CTA */}
        {synthesizing ? (
          <div className="text-center py-4">
            <div className="w-6 h-6 border-2 border-border border-t-primary rounded-full animate-spin mx-auto mb-2" />
            <p className="text-muted text-sm">Preparing photos for stitching...</p>
          </div>
        ) : uploading ? (
          <div className="text-center py-4">
            <div className="w-full h-1.5 bg-border rounded-full overflow-hidden mb-2">
              <div
                className="h-full bg-gradient-to-r from-primary to-pink-400 rounded-full transition-all duration-300"
                style={{ width: `${uploadPercent}%` }}
              />
            </div>
            <p className="text-muted text-sm">
              {uploadPercent < 100 ? `Uploading… ${uploadPercent}%` : "Processing…"}
            </p>
          </div>
        ) : (
          <button
            onClick={handleCreatePanorama}
            className="w-full py-3.5 bg-primary text-white rounded-xl font-semibold text-base hover:bg-primary-hover transition-colors"
          >
            Create Panorama ✨
          </button>
        )}
      </div>
    </div>
  );
}

// ── RotationGuide ─────────────────────────────────────────────────────────────
function RotationGuide({
  heading,
  coveredBuckets,
  photos,
  mode,
  targets,
  nextTarget,
}: {
  heading: number;
  coveredBuckets: Set<number>;
  photos: Photo[];
  mode: CaptureMode;
  targets: number[];
  nextTarget: number | null;
}) {
  const size = 164;
  const cx = size / 2;
  const cy = size / 2;
  const r  = 62;
  const sw = 8;

  // heading needle position
  const rad = (deg: number) => ((deg - 90) * Math.PI) / 180;
  const nx  = cx + r * Math.cos(rad(heading));
  const ny  = cy + r * Math.sin(rad(heading));

  return (
    <svg
      width={size}
      height={size}
      className="drop-shadow-lg filter"
      style={{ filter: "drop-shadow(0 2px 8px rgba(0,0,0,0.6))" }}
    >
      {/* Background ring */}
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth={sw} />

      {/* Covered arcs — video mode */}
      {mode === "video" &&
        Array.from(coveredBuckets).map((b) => (
          <path
            key={b}
            d={describeArc(cx, cy, r, b, b + 10)}
            fill="none"
            stroke="rgba(34,197,94,0.85)"
            strokeWidth={sw}
            strokeLinecap="round"
          />
        ))}

      {/* Target dots — photo mode */}
      {mode === "photo" &&
        targets.map((t) => {
          const captured = photos.some((p) => angleDiff(p.angle, t) < SNAP_RADIUS);
          const isNext   = t === nextTarget;
          const tx = cx + r * Math.cos(rad(t));
          const ty = cy + r * Math.sin(rad(t));
          return (
            <circle
              key={t}
              cx={tx}
              cy={ty}
              r={isNext ? 8 : 5}
              fill={
                captured
                  ? "rgba(34,197,94,0.9)"
                  : isNext
                  ? "rgba(251,191,36,1)"
                  : "rgba(255,255,255,0.3)"
              }
            />
          );
        })}

      {/* Heading needle */}
      <circle cx={nx} cy={ny} r={7} fill="white" />
      <circle cx={cx} cy={cy} r={4} fill="rgba(255,255,255,0.6)" />

      {/* Center label */}
      <text
        x={cx}
        y={cy + 6}
        textAnchor="middle"
        fontSize={15}
        fill="white"
        fontWeight="700"
        fontFamily="system-ui, sans-serif"
      >
        {mode === "video"
          ? `${Math.round((coveredBuckets.size / 36) * 100)}%`
          : `${photos.length}/${targets.length}`}
      </text>
    </svg>
  );
}
