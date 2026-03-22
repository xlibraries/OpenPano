import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

type CaptureMode = "video" | "photo";
type Step = "mode-select" | "capture" | "review";

type Vec3 = {
  x: number;
  y: number;
  z: number;
};

type TargetRing = "upper" | "horizon" | "lower" | "pole";

interface CaptureTarget {
  id: string;
  yaw: number;
  pitch: number;
  label: string;
  shortLabel: string;
  ring: TargetRing;
  vector: Vec3;
}

interface Photo {
  blob: Blob;
  angle: number;
  pitch: number;
  targetId: string;
  targetYaw: number;
  targetPitch: number;
  targetLabel: string;
  targetVector: Vec3;
  capturedVector: Vec3;
  angularErrorDeg: number;
  rollErrorDeg: number;
  capturedAt: string;
  url: string;
}

interface PoseBasis {
  forward: Vec3;
  right: Vec3;
  up: Vec3;
}

interface PhotoPose {
  aimVector: Vec3;
  screenUp: Vec3;
  yaw: number;
  pitch: number;
  angularErrorDeg: number;
  rollErrorDeg: number;
}

interface CameraCaptureProps {
  onJobStarted: (jobId: string) => void;
  onCancel: () => void;
}

interface SensorRequestResult {
  denied: boolean;
  promptable: boolean;
}

const WORLD_UP: Vec3 = { x: 0, y: 0, z: 1 };
const LOCAL_UP: Vec3 = { x: 0, y: 1, z: 0 };
const YAW_STEPS = [0, 45, 90, 135, 180, 225, 270, 315];
const PHOTO_RING_PITCH = 44;
const POLE_PITCH = 80;
const AUTO_HOLD_MS = 900;
const AIM_SNAP_DEG = 8;
const POLE_AIM_SNAP_DEG = 11;
const ROLL_SNAP_DEG = 13;
const CALIBRATION_MIN_FLAT = 0.45;
const TILT_WARN = 10;
const TILT_BAD = 20;
const SPEED_LOW = 5;
const SPEED_HIGH = 28;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function degToRad(deg: number) {
  return (deg * Math.PI) / 180;
}

function radToDeg(rad: number) {
  return (rad * 180) / Math.PI;
}

function normalizeAngle(deg: number) {
  return ((deg % 360) + 360) % 360;
}

function angleDiff(a: number, b: number) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function signedDiff(to: number, from: number) {
  let d = to - from;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

function dotVec(a: Vec3, b: Vec3) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function crossVec(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function scaleVec(v: Vec3, scalar: number): Vec3 {
  return { x: v.x * scalar, y: v.y * scalar, z: v.z * scalar };
}

function addVec(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function subtractVec(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function lengthVec(v: Vec3) {
  return Math.hypot(v.x, v.y, v.z);
}

function normalizeVec(v: Vec3): Vec3 {
  const length = lengthVec(v);
  if (!length) return { x: 0, y: 0, z: 0 };
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

function projectOnPlane(v: Vec3, normal: Vec3): Vec3 {
  return subtractVec(v, scaleVec(normal, dotVec(v, normal)));
}

function smoothUnitVector(previous: Vec3 | null, next: Vec3, factor = 0.22): Vec3 {
  if (!previous) return normalizeVec(next);
  return normalizeVec(addVec(scaleVec(previous, 1 - factor), scaleVec(next, factor)));
}

function vectorFromYawPitch(yaw: number, pitch: number): Vec3 {
  const yawRad = degToRad(yaw);
  const pitchRad = degToRad(pitch);
  return normalizeVec({
    x: Math.sin(yawRad) * Math.cos(pitchRad),
    y: Math.sin(pitchRad),
    z: Math.cos(yawRad) * Math.cos(pitchRad),
  });
}

function yawPitchFromVector(v: Vec3) {
  const normalized = normalizeVec(v);
  return {
    yaw: normalizeAngle(radToDeg(Math.atan2(normalized.x, normalized.z))),
    pitch: radToDeg(Math.asin(clamp(normalized.y, -1, 1))),
  };
}

function vectorAngleDeg(a: Vec3, b: Vec3) {
  return radToDeg(Math.acos(clamp(dotVec(normalizeVec(a), normalizeVec(b)), -1, 1)));
}

function orientationRollErrorDeg(screenUp: Vec3, targetVector: Vec3) {
  const desiredUp = projectOnPlane(LOCAL_UP, targetVector);
  const currentUp = projectOnPlane(screenUp, targetVector);
  if (lengthVec(desiredUp) < 0.05 || lengthVec(currentUp) < 0.05) return 0;
  return vectorAngleDeg(desiredUp, currentUp);
}

function directionLabel(yaw: number) {
  switch (normalizeAngle(yaw)) {
    case 0:
      return "Front";
    case 45:
      return "Front-right";
    case 90:
      return "Right";
    case 135:
      return "Back-right";
    case 180:
      return "Back";
    case 225:
      return "Back-left";
    case 270:
      return "Left";
    case 315:
      return "Front-left";
    default:
      return `${Math.round(yaw)}°`;
  }
}

function buildPhotoTargets() {
  const upper = YAW_STEPS.map((yaw) => ({
    id: `up-${yaw}`,
    yaw,
    pitch: PHOTO_RING_PITCH,
    label: `Upper ${directionLabel(yaw).toLowerCase()}`,
    shortLabel: `U${yaw}`,
    ring: "upper" as const,
    vector: vectorFromYawPitch(yaw, PHOTO_RING_PITCH),
  }));
  const horizon = YAW_STEPS.map((yaw) => ({
    id: `mid-${yaw}`,
    yaw,
    pitch: 0,
    label: directionLabel(yaw),
    shortLabel: `${yaw}`,
    ring: "horizon" as const,
    vector: vectorFromYawPitch(yaw, 0),
  }));
  const lower = YAW_STEPS.map((yaw) => ({
    id: `low-${yaw}`,
    yaw,
    pitch: -PHOTO_RING_PITCH,
    label: `Lower ${directionLabel(yaw).toLowerCase()}`,
    shortLabel: `L${yaw}`,
    ring: "lower" as const,
    vector: vectorFromYawPitch(yaw, -PHOTO_RING_PITCH),
  }));

  return [
    ...horizon,
    ...upper,
    ...lower,
    {
      id: "zenith",
      yaw: 0,
      pitch: POLE_PITCH,
      label: "Zenith",
      shortLabel: "Z",
      ring: "pole" as const,
      vector: vectorFromYawPitch(0, POLE_PITCH),
    },
    {
      id: "nadir",
      yaw: 180,
      pitch: -POLE_PITCH,
      label: "Nadir",
      shortLabel: "N",
      ring: "pole" as const,
      vector: vectorFromYawPitch(180, -POLE_PITCH),
    },
  ];
}

const PHOTO_TARGETS = buildPhotoTargets();

function targetAimLimit(target: CaptureTarget) {
  return target.ring === "pole" ? POLE_AIM_SNAP_DEG : AIM_SNAP_DEG;
}

function targetRollLimit(target: CaptureTarget) {
  return target.ring === "pole" ? 180 : ROLL_SNAP_DEG;
}

function pitchInstruction(deltaPitch: number) {
  if (Math.abs(deltaPitch) < 3) return "Pitch locked";
  return deltaPitch > 0 ? `Tilt up ${Math.round(Math.abs(deltaPitch))}°` : `Tilt down ${Math.round(Math.abs(deltaPitch))}°`;
}

function yawInstruction(deltaYaw: number) {
  if (Math.abs(deltaYaw) < 3) return "Yaw locked";
  return deltaYaw > 0 ? `Rotate right ${Math.round(Math.abs(deltaYaw))}°` : `Rotate left ${Math.round(Math.abs(deltaYaw))}°`;
}

function orientationVectors(alpha: number, beta: number, gamma: number) {
  const a = degToRad(alpha);
  const b = degToRad(beta);
  const g = degToRad(gamma);
  const cA = Math.cos(a);
  const sA = Math.sin(a);
  const cB = Math.cos(b);
  const sB = Math.sin(b);
  const cG = Math.cos(g);
  const sG = Math.sin(g);

  const m12 = -cB * sA;
  const m13 = cA * sG + cG * sA * sB;
  const m22 = cA * cB;
  const m23 = sA * sG - cA * cG * sB;
  const m32 = sB;
  const m33 = cB * cG;

  return {
    forwardWorld: normalizeVec({ x: -m13, y: -m23, z: -m33 }),
    screenUpWorld: normalizeVec({ x: m12, y: m22, z: m32 }),
  };
}

function toLocalVector(worldVector: Vec3, basis: PoseBasis): Vec3 {
  return {
    x: dotVec(worldVector, basis.right),
    y: dotVec(worldVector, basis.up),
    z: dotVec(worldVector, basis.forward),
  };
}

function getSensorPermissionApiSupport() {
  const DOE = typeof DeviceOrientationEvent !== "undefined"
    ? (DeviceOrientationEvent as typeof DeviceOrientationEvent & { requestPermission?: () => Promise<PermissionState> })
    : null;
  const DME = typeof DeviceMotionEvent !== "undefined"
    ? (DeviceMotionEvent as typeof DeviceMotionEvent & { requestPermission?: () => Promise<PermissionState> })
    : null;

  return Boolean(
    (DOE && typeof DOE.requestPermission === "function")
    || (DME && typeof DME.requestPermission === "function"),
  );
}

export default function CameraCapture({ onJobStarted, onCancel }: CameraCaptureProps) {
  const [step, setStep] = useState<Step>("mode-select");
  const [mode, setMode] = useState<CaptureMode>("video");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordDuration, setRecordDuration] = useState(0);
  const [heading, setHeading] = useState(0);
  const [tiltDev, setTiltDev] = useState(0);
  const [pitchDev, setPitchDev] = useState(0);
  const [rotationSpeed, setRotationSpeed] = useState(0);
  const [coveredBuckets, setCoveredBuckets] = useState<Set<number>>(new Set());
  const [hasOrientation, setHasOrientation] = useState(false);
  const [orientDenied, setOrientDenied] = useState(false);
  const [sensorRetryKey, setSensorRetryKey] = useState(0);
  const [photoPose, setPhotoPose] = useState<PhotoPose | null>(null);
  const [poseCalibrated, setPoseCalibrated] = useState(false);
  const [autoProgress, setAutoProgress] = useState(0);
  const [isAutoCapturing, setIsAutoCapturing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevAlphaRef = useRef(0);
  const prevTimeRef = useRef(0);
  const headingRef = useRef(0);
  const headingZeroRef = useRef<number | null>(null);
  const photosRef = useRef<Photo[]>([]);
  const poseBasisRef = useRef<PoseBasis | null>(null);
  const smoothedForwardRef = useRef<Vec3 | null>(null);
  const smoothedUpRef = useRef<Vec3 | null>(null);
  const photoPoseRef = useRef<PhotoPose | null>(null);
  const sensorPromptSupported = getSensorPermissionApiSupport();
  const isAndroidBrowser = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
  const isSecureContextPage = typeof window === "undefined" ? true : window.isSecureContext;

  const releasePhotoUrls = useCallback((items: Photo[]) => {
    items.forEach((photo) => URL.revokeObjectURL(photo.url));
  }, []);

  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);

  useEffect(() => () => {
    releasePhotoUrls(photosRef.current);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
  }, [releasePhotoUrls, videoUrl]);

  const startCamera = useCallback(async () => {
    setCameraError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Camera requires HTTPS. Open this page over https:// or on localhost.");
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
          setCameraError("Camera permission denied. Allow it in browser settings and try again.");
        } else if (e.name === "NotFoundError" || e.name === "DevicesNotFoundError") {
          setCameraError("No camera found on this device.");
        } else if (e.name === "NotReadableError" || e.name === "TrackStartError") {
          setCameraError("Camera is in use by another app. Close it and retry.");
        } else if (e.name === "OverconstrainedError") {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
            streamRef.current = stream;
            if (videoRef.current) {
              videoRef.current.srcObject = stream;
              videoRef.current.play();
            }
          } catch {
            setCameraError("Could not start camera.");
          }
        } else {
          setCameraError(`Could not start camera: ${e.message}`);
        }
      } else {
        setCameraError("Unexpected error accessing camera.");
      }
    }
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const nextPhotoTarget = PHOTO_TARGETS.find((target) => !photos.some((photo) => photo.targetId === target.id)) ?? null;
  const yawDelta = nextPhotoTarget && photoPose ? signedDiff(nextPhotoTarget.yaw, photoPose.yaw) : 0;
  const pitchDelta = nextPhotoTarget && photoPose ? nextPhotoTarget.pitch - photoPose.pitch : 0;
  const photoReady = Boolean(
    mode === "photo" &&
    nextPhotoTarget &&
    photoPose &&
    poseCalibrated &&
    photoPose.angularErrorDeg <= targetAimLimit(nextPhotoTarget) &&
    photoPose.rollErrorDeg <= targetRollLimit(nextPhotoTarget),
  );

  useEffect(() => {
    if (step !== "capture") return;
    let active = true;
    let fired = false;

    const handler = (e: DeviceOrientationEvent) => {
      if (!active) return;

      const iosHeading = (e as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading;
      const rawHeading = typeof iosHeading === "number" ? iosHeading : e.alpha;
      if (rawHeading == null) return;

      const beta = e.beta ?? 90;
      const gamma = e.gamma ?? 0;

      if (!fired) {
        fired = true;
        setHasOrientation(true);
      }

      if (headingZeroRef.current === null) {
        headingZeroRef.current = rawHeading;
        prevAlphaRef.current = 0;
        prevTimeRef.current = performance.now();
      }

      const relativeHeading = normalizeAngle(rawHeading - headingZeroRef.current);
      headingRef.current = relativeHeading;
      setHeading(Math.round(relativeHeading));
      setTiltDev(Math.round(gamma));
      setPitchDev(Math.round(beta - 90));

      const bucket = Math.floor(relativeHeading / 10) * 10;
      setCoveredBuckets((prev) => {
        if (prev.has(bucket)) return prev;
        const next = new Set(prev);
        next.add(bucket);
        return next;
      });

      const now = performance.now();
      const dt = now - prevTimeRef.current;
      if (dt > 80) {
        const delta = Math.abs(signedDiff(relativeHeading, prevAlphaRef.current));
        setRotationSpeed(Math.round((delta / dt) * 1000));
        prevAlphaRef.current = relativeHeading;
        prevTimeRef.current = now;
      }

      if (mode !== "photo") return;

      const { forwardWorld, screenUpWorld } = orientationVectors(rawHeading, beta, gamma);
      smoothedForwardRef.current = smoothUnitVector(smoothedForwardRef.current, forwardWorld);
      smoothedUpRef.current = smoothUnitVector(smoothedUpRef.current, screenUpWorld);

      const smoothForward = smoothedForwardRef.current;
      const smoothUp = smoothedUpRef.current;
      if (!smoothForward || !smoothUp) return;

      if (!poseBasisRef.current) {
        const flatForward = projectOnPlane(smoothForward, WORLD_UP);
        if (lengthVec(flatForward) < CALIBRATION_MIN_FLAT) {
          setPoseCalibrated(false);
          setPhotoPose(null);
          photoPoseRef.current = null;
          return;
        }
        const basisForward = normalizeVec(flatForward);
        const basisRight = normalizeVec(crossVec(basisForward, WORLD_UP));
        poseBasisRef.current = { forward: basisForward, right: basisRight, up: WORLD_UP };
        setPoseCalibrated(true);
      }

      const basis = poseBasisRef.current;
      if (!basis) return;

      const aimVector = normalizeVec(toLocalVector(smoothForward, basis));
      const screenUp = normalizeVec(toLocalVector(smoothUp, basis));
      const aimAngles = yawPitchFromVector(aimVector);
      const activeTarget = PHOTO_TARGETS.find((target) => !photosRef.current.some((photo) => photo.targetId === target.id)) ?? null;
      const angularErrorDeg = activeTarget ? vectorAngleDeg(aimVector, activeTarget.vector) : 0;
      const rollErrorDeg = activeTarget ? orientationRollErrorDeg(screenUp, activeTarget.vector) : 0;

      const pose: PhotoPose = {
        aimVector,
        screenUp,
        yaw: aimAngles.yaw,
        pitch: aimAngles.pitch,
        angularErrorDeg,
        rollErrorDeg,
      };

      photoPoseRef.current = pose;
      setPhotoPose(pose);
    };

    // Prefer deviceorientationabsolute (Android Chrome — gives real compass alpha).
    // Fall back to deviceorientation (iOS, desktop). If absolute fires first,
    // ignore subsequent relative events so we don't mix two sources.
    let absoluteFired = false;

    const absoluteHandler = (e: Event) => {
      absoluteFired = true;
      handler(e as DeviceOrientationEvent);
    };
    const relativeHandler = (e: Event) => {
      if (absoluteFired) return;          // already have absolute readings
      handler(e as DeviceOrientationEvent);
    };

    window.addEventListener("deviceorientationabsolute", absoluteHandler);
    window.addEventListener("deviceorientation", relativeHandler);

    const timeout = window.setTimeout(() => {
      if (!fired) setHasOrientation(false);
    }, 2000);

    return () => {
      active = false;
      window.clearTimeout(timeout);
      window.removeEventListener("deviceorientationabsolute", absoluteHandler);
      window.removeEventListener("deviceorientation", relativeHandler);
    };
  }, [mode, step, sensorRetryKey]);

  const doCapture = useCallback(() => {
    const video = videoRef.current;
    const target = nextPhotoTarget;
    const pose = photoPoseRef.current;
    if (!video || !target || !pose) return;
    if (pose.angularErrorDeg > targetAimLimit(target) || pose.rollErrorDeg > targetRollLimit(target)) return;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    canvas.getContext("2d")?.drawImage(video, 0, 0);

    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      setPhotos((prev) => {
        if (prev.some((photo) => photo.targetId === target.id)) {
          URL.revokeObjectURL(url);
          return prev;
        }
        return [
          ...prev,
          {
            blob,
            angle: Math.round(pose.yaw),
            pitch: Math.round(pose.pitch),
            targetId: target.id,
            targetYaw: target.yaw,
            targetPitch: target.pitch,
            targetLabel: target.label,
            targetVector: target.vector,
            capturedVector: pose.aimVector,
            angularErrorDeg: Number(pose.angularErrorDeg.toFixed(2)),
            rollErrorDeg: Number(pose.rollErrorDeg.toFixed(2)),
            capturedAt: new Date().toISOString(),
            url,
          },
        ];
      });
    }, "image/jpeg", 0.92);
  }, [nextPhotoTarget]);

  useEffect(() => {
    if (step !== "capture" || mode !== "photo" || !nextPhotoTarget || !photoReady) {
      if (autoTimerRef.current) {
        clearInterval(autoTimerRef.current);
        autoTimerRef.current = null;
      }
      setIsAutoCapturing(false);
      setAutoProgress(0);
      return;
    }

    if (autoTimerRef.current) return;

    setIsAutoCapturing(true);
    setAutoProgress(0);
    const tickMs = 50;
    let elapsed = 0;

    autoTimerRef.current = setInterval(() => {
      elapsed += tickMs;
      setAutoProgress(Math.min(100, Math.round((elapsed / AUTO_HOLD_MS) * 100)));
      if (elapsed >= AUTO_HOLD_MS) {
        clearInterval(autoTimerRef.current!);
        autoTimerRef.current = null;
        setIsAutoCapturing(false);
        setAutoProgress(0);
        doCapture();
      }
    }, tickMs);

    return () => {
      if (autoTimerRef.current) {
        clearInterval(autoTimerRef.current);
        autoTimerRef.current = null;
      }
    };
  }, [doCapture, mode, nextPhotoTarget, photoReady, step]);

  const leaveCapture = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    if (autoTimerRef.current) clearInterval(autoTimerRef.current);
    stopCamera();
  }, [stopCamera]);

  useEffect(() => () => leaveCapture(), [leaveCapture]);

  useEffect(() => {
    if (step !== "capture" || mode !== "photo" || photos.length !== PHOTO_TARGETS.length) return;
    const doneTimer = window.setTimeout(() => {
      leaveCapture();
      setStep("review");
    }, 500);
    return () => window.clearTimeout(doneTimer);
  }, [leaveCapture, mode, photos.length, step]);

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;

    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp8") ? "video/webm;codecs=vp8" : "video/webm";
    chunksRef.current = [];
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mime });
      setVideoBlob(blob);
      setVideoUrl(URL.createObjectURL(blob));
      leaveCapture();
      setStep("review");
    };
    recorder.start(200);
    recorderRef.current = recorder;
    setIsRecording(true);
    setRecordDuration(0);
    recordTimerRef.current = setInterval(() => setRecordDuration((duration) => duration + 1), 1000);
  }, [leaveCapture]);

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
    if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    setIsRecording(false);
  }, []);

  const requestSensorAccess = useCallback(async (): Promise<SensorRequestResult> => {
    const DOE = typeof DeviceOrientationEvent !== "undefined"
      ? (DeviceOrientationEvent as typeof DeviceOrientationEvent & { requestPermission?: () => Promise<PermissionState> })
      : null;
    const DME = typeof DeviceMotionEvent !== "undefined"
      ? (DeviceMotionEvent as typeof DeviceMotionEvent & { requestPermission?: () => Promise<PermissionState> })
      : null;

    let denied = false;
    let promptable = false;

    for (const sensor of [DOE, DME]) {
      if (!sensor || typeof sensor.requestPermission !== "function") continue;
      promptable = true;
      try {
        const result = await sensor.requestPermission();
        if (result !== "granted") denied = true;
      } catch {
        denied = true;
      }
    }

    return { denied, promptable };
  }, []);

  const enterCapture = useCallback(async (nextMode: CaptureMode) => {
    const sensorAccess = await requestSensorAccess();

    releasePhotoUrls(photosRef.current);
    if (videoUrl) URL.revokeObjectURL(videoUrl);

    setMode(nextMode);
    setPhotos([]);
    photosRef.current = [];
    setVideoBlob(null);
    setVideoUrl(null);
    setCoveredBuckets(new Set());
    setIsRecording(false);
    setRecordDuration(0);
    setHasOrientation(false);
    setOrientDenied(sensorAccess.promptable && sensorAccess.denied);
    setRotationSpeed(0);
    setError(null);
    setAutoProgress(0);
    setIsAutoCapturing(false);
    setHeading(0);
    setTiltDev(0);
    setPitchDev(0);
    setPhotoPose(null);
    setPoseCalibrated(false);
    headingRef.current = 0;
    headingZeroRef.current = null;
    prevAlphaRef.current = 0;
    prevTimeRef.current = performance.now();
    poseBasisRef.current = null;
    smoothedForwardRef.current = null;
    smoothedUpRef.current = null;
    photoPoseRef.current = null;

    setStep("capture");
    await startCamera();
  }, [releasePhotoUrls, requestSensorAccess, startCamera, videoUrl]);

  const handleCreatePanorama = useCallback(async () => {
    setError(null);
    try {
      setUploading(true);
      setUploadPercent(0);
      const formData = new FormData();
      let endpoint = "/api/upload";

      if (mode === "video") {
        if (!videoBlob) throw new Error("No video capture is ready to upload.");
        const file = new File([videoBlob], "capture.webm", { type: videoBlob.type });
        formData.append("video", file);
        formData.append("stitch_backend", "openpano");
        formData.append("max_frames", "80");
      } else {
        if (photos.length !== PHOTO_TARGETS.length) {
          throw new Error(`Capture all ${PHOTO_TARGETS.length} sphere targets before stitching.`);
        }
        endpoint = "/api/upload-photosphere";
        photos.forEach((photo, index) => {
          const ext = photo.blob.type === "image/png" ? "png" : "jpg";
          formData.append("photos", new File([photo.blob], `shot_${index + 1}.${ext}`, { type: photo.blob.type || "image/jpeg" }));
        });
        formData.append("stitch_backend", "hugin");
        formData.append(
          "capture_metadata",
          JSON.stringify({
            captureMode: "photo-sphere",
            captureGrid: "full-sphere-26",
            createdAt: new Date().toISOString(),
            targetCount: PHOTO_TARGETS.length,
            shots: photos.map((photo, index) => ({
              index: index + 1,
              capturedYaw: photo.angle,
              capturedPitch: photo.pitch,
              angularErrorDeg: photo.angularErrorDeg,
              rollErrorDeg: photo.rollErrorDeg,
              targetId: photo.targetId,
              targetYaw: photo.targetYaw,
              targetPitch: photo.targetPitch,
              targetLabel: photo.targetLabel,
              targetVector: photo.targetVector,
              capturedVector: photo.capturedVector,
              capturedAt: photo.capturedAt,
            })),
          }),
        );
        formData.append("max_frames", String(photos.length));
      }

      formData.append("equirectangular", "1");
      formData.append("equirect_width", "4096");

      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) {
          setUploadPercent(Math.round((event.loaded / event.total) * 100));
        }
      });
      xhr.onload = () => {
        setUploading(false);
        if (xhr.status === 200) {
          onJobStarted(JSON.parse(xhr.responseText).job_id);
          return;
        }
        try {
          setError(JSON.parse(xhr.responseText).error || "Upload failed");
        } catch {
          setError("Upload failed");
        }
      };
      xhr.onerror = () => {
        setUploading(false);
        setError("Network error");
      };
      xhr.open("POST", endpoint);
      xhr.send(formData);
    } catch (e) {
      setUploading(false);
      setError(e instanceof Error ? e.message : "Failed to prepare capture");
    }
  }, [mode, onJobStarted, photos, videoBlob]);

  const coveragePct = Math.round((coveredBuckets.size / 36) * 100);
  const isVideoTilted = Math.abs(tiltDev) >= TILT_WARN || Math.abs(pitchDev) >= TILT_WARN;
  const isVideoBadTilt = Math.abs(tiltDev) >= TILT_BAD || Math.abs(pitchDev) >= TILT_BAD;
  const photoRollError = nextPhotoTarget && photoPose ? photoPose.rollErrorDeg : 0;
  const photoRollWarn = photoRollError >= ROLL_SNAP_DEG;
  const photoRollBad = photoRollError >= ROLL_SNAP_DEG * 1.8;

  if (step === "mode-select") {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-4 py-12">
        <button onClick={onCancel} className="absolute top-5 left-5 text-muted hover:text-foreground text-sm">← Back</button>
        <h1 className="text-4xl font-extrabold mb-2 bg-gradient-to-r from-rose-500 to-pink-500 bg-clip-text text-transparent">Capture 360°</h1>
        <p className="text-muted text-center mb-10 max-w-sm leading-relaxed">
          Tapping a mode below will request camera + motion sensor permission.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 w-full max-w-xl">
          <button
            onClick={() => enterCapture("video")}
            className="bg-surface border border-border hover:border-primary/50 rounded-2xl p-7 text-left transition-all"
          >
            <div className="text-5xl mb-4">🎥</div>
            <h3 className="text-lg font-semibold mb-1">Video Pan</h3>
            <p className="text-sm text-muted leading-relaxed">Record while slowly rotating 360°. Speed + tilt guidance stay on screen.</p>
            <div className="mt-5 text-xs text-primary font-medium">Recommended →</div>
          </button>
          <button
            onClick={() => enterCapture("photo")}
            className="bg-surface border border-border hover:border-primary/50 rounded-2xl p-7 text-left transition-all"
          >
            <div className="text-5xl mb-4">📸</div>
            <h3 className="text-lg font-semibold mb-1">Photo Sphere</h3>
            <p className="text-sm text-muted leading-relaxed">IMU-verified full-sphere capture with auto shutter only when the camera is truly aligned.</p>
            <div className="mt-5 text-xs text-detail font-medium">{PHOTO_TARGETS.length} shots · full sphere · no manual shutter</div>
          </button>
        </div>
        <div className="mt-10 max-w-xl w-full bg-surface border border-border rounded-xl px-5 py-4">
          <p className="text-xs text-detail uppercase tracking-wider mb-3">Tips for best results</p>
          <ul className="text-sm text-muted space-y-2">
            <li className="flex items-start gap-2"><span className="text-primary mt-0.5">✓</span>Stay in one spot and rotate around yourself instead of walking.</li>
            <li className="flex items-start gap-2"><span className="text-primary mt-0.5">✓</span>Start by aiming straight ahead to calibrate the sphere.</li>
            <li className="flex items-start gap-2"><span className="text-primary mt-0.5">✓</span>Let the amber target come to the centre and hold steady for auto capture.</li>
            <li className="flex items-start gap-2"><span className="text-primary mt-0.5">✓</span>Use HTTPS on a real phone so the browser can expose motion sensors.</li>
          </ul>
        </div>
      </div>
    );
  }

  if (step === "capture") {
    return (
      <div className="relative min-h-screen bg-black flex flex-col overflow-hidden">
        <video ref={videoRef} playsInline muted autoPlay className="absolute inset-0 w-full h-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-transparent via-40% to-black/75 pointer-events-none" />

        <div className="relative z-10 flex flex-col h-screen">
          <div className="flex items-center justify-between px-4 pt-4 pb-2">
            <button
              onClick={() => {
                leaveCapture();
                setStep("mode-select");
              }}
              className="bg-black/50 backdrop-blur-sm text-white px-3 py-1.5 rounded-full text-sm"
            >
              ← Back
            </button>

            <span className="text-white/80 text-sm font-medium">{mode === "video" ? "Video Pan" : "Photo Sphere"}</span>

            {mode === "video" ? (
              isRecording ? (
                <div className="bg-black/50 backdrop-blur-sm text-white px-3 py-1.5 rounded-full text-sm flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  {String(Math.floor(recordDuration / 60)).padStart(2, "0")}:{String(recordDuration % 60).padStart(2, "0")}
                </div>
              ) : (
                <div className="w-20" />
              )
            ) : (
              <div className="bg-black/50 backdrop-blur-sm text-white px-3 py-1.5 rounded-full text-sm">
                {photos.length} / {PHOTO_TARGETS.length}
              </div>
            )}
          </div>

          <div className="flex-1 relative">
            {(["top-3 left-3", "top-3 right-3 rotate-90", "bottom-3 left-3 -rotate-90", "bottom-3 right-3 rotate-180"] as const).map((cls) => (
              <div key={cls} className={`absolute ${cls} w-7 h-7 pointer-events-none`}>
                <div className="absolute top-0 left-0 w-full h-0.5 bg-white/50" />
                <div className="absolute top-0 left-0 h-full w-0.5 bg-white/50" />
              </div>
            ))}

            {mode === "video" && hasOrientation && (
              <div
                className="absolute left-0 right-0 flex justify-center pointer-events-none"
                style={{ top: `calc(50% + ${Math.max(-60, Math.min(60, pitchDev * 2.5))}px)` }}
              >
                <div style={{ transform: `rotate(${-tiltDev}deg)` }} className="flex items-center gap-1">
                  <div className={`w-16 h-px opacity-80 ${isVideoBadTilt ? "bg-red-400" : isVideoTilted ? "bg-yellow-300" : "bg-green-400"}`} />
                  <div className={`w-3 h-3 rounded-full border-2 opacity-80 ${isVideoBadTilt ? "border-red-400" : isVideoTilted ? "border-yellow-300" : "border-green-400"}`} />
                  <div className={`w-16 h-px opacity-80 ${isVideoBadTilt ? "bg-red-400" : isVideoTilted ? "bg-yellow-300" : "bg-green-400"}`} />
                </div>
              </div>
            )}

            {hasOrientation && mode === "video" && (
              <div className="absolute top-2 right-3 flex flex-col items-center gap-1">
                <BubbleLevel tiltDev={tiltDev} pitchDev={pitchDev} />
                {isVideoBadTilt && <span className="text-red-400 text-[10px] font-bold bg-black/60 px-1.5 rounded">LEVEL PHONE</span>}
              </div>
            )}

            {mode === "photo" && hasOrientation && photoPose && nextPhotoTarget && poseCalibrated && (
              <AimAssistOverlay nextTarget={nextPhotoTarget} yawDelta={yawDelta} pitchDelta={pitchDelta} isLocked={photoReady} autoProgress={autoProgress} />
            )}

            {mode === "photo" && hasOrientation && (
              <div className="absolute top-2 right-3 flex flex-col items-end gap-2">
                {nextPhotoTarget && nextPhotoTarget.ring !== "pole" && photoPose && (
                  <div className={`bg-black/60 backdrop-blur-sm rounded-full px-3 py-1 text-[11px] font-semibold ${photoRollBad ? "text-red-400" : photoRollWarn ? "text-yellow-300" : "text-green-400"}`}>
                    Roll {Math.round(photoRollError)}°
                  </div>
                )}
                {photoPose && (
                  <div className="bg-black/60 backdrop-blur-sm rounded-full px-3 py-1 text-[11px] font-semibold text-white/80">
                    Aim {Math.round(photoPose.angularErrorDeg)}°
                  </div>
                )}
              </div>
            )}

            {mode === "photo" && hasOrientation && poseCalibrated && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <SpherePoseGuide
                  aimVector={photoPose?.aimVector ?? null}
                  autoProgress={autoProgress}
                  capturedIds={new Set(photos.map((photo) => photo.targetId))}
                  isAutoCapturing={isAutoCapturing}
                  nextTarget={nextPhotoTarget}
                  progress={photos.length / PHOTO_TARGETS.length}
                  targets={PHOTO_TARGETS}
                />
              </div>
            )}

            {mode === "photo" && (
              <div className="absolute left-1/2 bottom-4 -translate-x-1/2 w-[min(92vw,360px)]">
                <PhotoStatusCard
                  hasOrientation={hasOrientation}
                  orientDenied={orientDenied}
                  poseCalibrated={poseCalibrated}
                  isAndroidBrowser={isAndroidBrowser}
                  isSecureContextPage={isSecureContextPage}
                  nextTarget={nextPhotoTarget}
                  yawDelta={yawDelta}
                  pitchDelta={pitchDelta}
                  photoPose={photoPose}
                  photoReady={photoReady}
                  sensorPromptSupported={sensorPromptSupported}
                  onRequestPermission={async () => {
                    const sensorAccess = await requestSensorAccess();
                    setOrientDenied(sensorAccess.promptable && sensorAccess.denied);
                    if (!sensorAccess.denied || !sensorAccess.promptable) {
                      setHasOrientation(false);
                      setSensorRetryKey((key) => key + 1);
                    }
                  }}
                />
              </div>
            )}
          </div>

          <div className="flex flex-col items-center gap-3 pb-3">
            {mode === "video" && isRecording && hasOrientation && (
              <SpeedMeter speed={rotationSpeed} />
            )}

            {mode === "video" && hasOrientation && (
              <StripCompass heading={heading} coveredBuckets={coveredBuckets} />
            )}

            {mode === "photo" && photos.length > 0 && (
              <div className="flex gap-2 px-4 overflow-x-auto max-w-full" style={{ scrollbarWidth: "none" }}>
                {photos.map((photo, index) => (
                  <div key={index} className="relative shrink-0">
                    <img src={photo.url} alt="" className="h-12 w-16 object-cover rounded-lg border-2 border-white/40" />
                    <span className="absolute bottom-0.5 right-1 text-[9px] bg-black/60 text-white px-1 rounded">{photo.targetLabel}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-8 pb-4">
              {mode === "video" ? (
                <button
                  onClick={isRecording ? stopRecording : startRecording}
                  className={`w-20 h-20 rounded-full border-4 flex items-center justify-center transition-all ${
                    isRecording ? "border-red-500 bg-red-500/20 scale-110" : "border-white bg-white/10 hover:bg-white/20"
                  }`}
                >
                  {isRecording ? <span className="w-7 h-7 rounded-sm bg-red-500" /> : <span className="w-7 h-7 rounded-full bg-white" />}
                </button>
              ) : (
                <AutoCaptureDial
                  autoProgress={autoProgress}
                  isAutoCapturing={isAutoCapturing}
                  isLocked={photoReady}
                  remaining={PHOTO_TARGETS.length - photos.length}
                />
              )}
            </div>
          </div>
        </div>

        {mode === "video" && isRecording && hasOrientation && (
          <div className="absolute top-16 left-1/2 -translate-x-1/2 bg-black/50 backdrop-blur-sm text-white text-sm px-3 py-1 rounded-full pointer-events-none">
            {coveragePct}% covered
          </div>
        )}

        {cameraError && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/80 px-4">
            <div className="bg-surface rounded-2xl p-8 max-w-sm w-full text-center">
              <div className="text-4xl mb-4">📷</div>
              <p className="text-muted mb-6 text-sm leading-relaxed">{cameraError}</p>
              <button
                onClick={() => {
                  leaveCapture();
                  setStep("mode-select");
                }}
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

  return (
    <div className="min-h-screen flex flex-col items-center px-4 py-10">
      <div className="w-full max-w-2xl">
        <button onClick={() => enterCapture(mode)} className="text-muted hover:text-foreground text-sm mb-6 inline-block">← Retake</button>
        <h2 className="text-2xl font-bold mb-1">Review Capture</h2>
        <p className="text-muted text-sm mb-6">
          {mode === "photo" ? `${photos.length} IMU-verified stills captured around a full sphere` : "Video recorded · processing as equirectangular 360°"}
        </p>
        {mode === "photo" ? (
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-3 mb-8">
            {photos.map((photo, index) => (
              <div key={index} className="relative aspect-video rounded-xl overflow-hidden bg-surface border border-border">
                <img src={photo.url} alt="" className="w-full h-full object-cover" />
                <span className="absolute bottom-1 right-1.5 text-[10px] bg-black/60 text-white px-1.5 py-0.5 rounded">{photo.targetLabel}</span>
              </div>
            ))}
          </div>
        ) : videoUrl ? (
          <video src={videoUrl} controls className="w-full rounded-xl mb-8 bg-black border border-border" style={{ maxHeight: "50vh" }} />
        ) : null}
        <div className="flex items-center gap-2 bg-surface border border-border rounded-lg px-4 py-3 mb-6 text-sm">
          <span className="text-primary">🌐</span>
          <span className="text-muted">Output: <strong className="text-foreground">Equirectangular 360° · 4K</strong></span>
        </div>
        {error && <p className="text-red-500 text-sm mb-4">{error}</p>}
        {uploading ? (
          <div className="py-4">
            <div className="w-full h-1.5 bg-border rounded-full overflow-hidden mb-2">
              <div className="h-full bg-gradient-to-r from-primary to-pink-400 rounded-full transition-all duration-300" style={{ width: `${uploadPercent}%` }} />
            </div>
            <p className="text-muted text-sm text-center">{uploadPercent < 100 ? `Uploading… ${uploadPercent}%` : "Processing…"}</p>
          </div>
        ) : (
          <button onClick={handleCreatePanorama} className="w-full py-3.5 bg-primary text-white rounded-xl font-semibold hover:bg-primary-hover transition-colors">
            Create Panorama ✨
          </button>
        )}
      </div>
    </div>
  );
}

function PhotoStatusCard({
  hasOrientation,
  orientDenied,
  poseCalibrated,
  isAndroidBrowser,
  isSecureContextPage,
  nextTarget,
  yawDelta,
  pitchDelta,
  photoPose,
  photoReady,
  sensorPromptSupported,
  onRequestPermission,
}: {
  hasOrientation: boolean;
  orientDenied: boolean;
  poseCalibrated: boolean;
  isAndroidBrowser: boolean;
  isSecureContextPage: boolean;
  nextTarget: CaptureTarget | null;
  yawDelta: number;
  pitchDelta: number;
  photoPose: PhotoPose | null;
  photoReady: boolean;
  sensorPromptSupported: boolean;
  onRequestPermission: () => void;
}) {
  if (orientDenied) {
    return (
      <div className="bg-yellow-500/90 text-black rounded-2xl px-4 py-3 text-sm font-semibold shadow-xl">
        <p>Motion sensor access is blocked for this page.</p>
        <p className="mt-1 text-xs font-medium text-black/75">
          {isAndroidBrowser
            ? "Android browsers often do not show a popup here. Re-enable motion sensors in the browser's site settings, then retry."
            : "Re-enable motion access in the browser's site settings, then retry."}
        </p>
        <button
          onClick={onRequestPermission}
          className="mt-3 text-xs font-semibold px-4 py-1.5 bg-black/15 hover:bg-black/25 active:bg-black/35 rounded-full transition-colors"
        >
          {sensorPromptSupported ? "Try Again" : "Retry Sensor Detection"}
        </button>
      </div>
    );
  }

  if (!hasOrientation) {
    return (
      <div className="bg-black/65 backdrop-blur-sm rounded-2xl px-4 py-3 text-center shadow-xl flex flex-col items-center gap-2">
        <p className="text-sm text-white/85">
          {!isSecureContextPage
            ? "Motion sensors need HTTPS. Open this page over https:// first."
            : "Waiting for motion sensors…"}
        </p>
        <p className="text-[11px] leading-relaxed text-white/55">
          {!isSecureContextPage
            ? "This browser will not expose IMU events on an insecure page."
            : sensorPromptSupported
              ? "This browser can show a permission prompt when you tap below."
              : isAndroidBrowser
                ? "On Android, many browsers do not show a motion popup here. This button only retries sensor detection after you allow sensors in browser site settings."
                : "This browser may not show a permission popup. The button below will retry sensor detection."}
        </p>
        <button
          onClick={onRequestPermission}
          className="text-xs font-semibold px-4 py-1.5 bg-white/15 hover:bg-white/25 active:bg-white/35 rounded-full text-white transition-colors"
        >
          {sensorPromptSupported ? "Enable Motion Sensors" : "Retry Sensor Detection"}
        </button>
      </div>
    );
  }

  if (!poseCalibrated) {
    return (
      <div className="bg-black/65 backdrop-blur-sm rounded-2xl px-4 py-3 text-center text-sm text-white/85 shadow-xl">
        Aim straight ahead at the horizon for a second so we can lock the front of the sphere.
      </div>
    );
  }

  if (!nextTarget || !photoPose) {
    return (
      <div className="bg-green-500/20 border border-green-400/40 backdrop-blur-sm rounded-2xl px-4 py-3 text-center text-sm text-green-200 shadow-xl">
        Full sphere captured. Preparing the review screen…
      </div>
    );
  }

  return (
    <div className="bg-black/65 backdrop-blur-sm rounded-2xl px-4 py-3 text-white shadow-xl">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div>
          <p className="text-[11px] uppercase tracking-[0.22em] text-white/45">Active Target</p>
          <p className="text-base font-semibold">{nextTarget.label}</p>
        </div>
        <div className={`text-xs font-semibold px-2.5 py-1 rounded-full ${photoReady ? "bg-green-500/20 text-green-300" : "bg-amber-400/20 text-amber-200"}`}>
          {photoReady ? "Locked" : "Move To Target"}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs text-white/70">
        <div className="bg-white/5 rounded-xl px-3 py-2">{yawInstruction(yawDelta)}</div>
        <div className="bg-white/5 rounded-xl px-3 py-2">{pitchInstruction(pitchDelta)}</div>
        <div className="bg-white/5 rounded-xl px-3 py-2">Aim error {Math.round(photoPose.angularErrorDeg)}°</div>
        <div className="bg-white/5 rounded-xl px-3 py-2">Roll error {Math.round(photoPose.rollErrorDeg)}°</div>
      </div>
      <p className="text-[11px] text-white/45 mt-2">
        The shutter fires automatically only when aim and roll both fall inside the capture tolerance.
      </p>
    </div>
  );
}

function AimAssistOverlay({
  nextTarget,
  yawDelta,
  pitchDelta,
  isLocked,
  autoProgress,
}: {
  nextTarget: CaptureTarget;
  yawDelta: number;
  pitchDelta: number;
  isLocked: boolean;
  autoProgress: number;
}) {
  const x = clamp(yawDelta, -40, 40) * 3;
  const y = clamp(pitchDelta, -35, 35) * -3;

  return (
    <div className="absolute inset-0 pointer-events-none">
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="relative w-[220px] h-[220px]">
          <div className="absolute left-1/2 top-1/2 w-20 h-20 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/45" />
          <div className="absolute left-1/2 top-1/2 w-1 h-10 -translate-x-1/2 -translate-y-1/2 bg-white/45 rounded-full" />
          <div className="absolute left-1/2 top-1/2 h-1 w-10 -translate-x-1/2 -translate-y-1/2 bg-white/45 rounded-full" />
          <div
            className="absolute left-1/2 top-1/2 transition-all duration-150 ease-out"
            style={{ transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))` }}
          >
            <div className={`relative w-16 h-16 rounded-full border-2 ${isLocked ? "border-green-400 bg-green-400/10" : "border-amber-300 bg-amber-300/10"}`}>
              <div className="absolute inset-2 rounded-full border border-current opacity-80" />
              {isLocked && (
                <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 64 64">
                  <circle cx="32" cy="32" r="28" fill="none" stroke="rgba(74,222,128,0.25)" strokeWidth="4" />
                  <circle
                    cx="32"
                    cy="32"
                    r="28"
                    fill="none"
                    stroke="rgba(74,222,128,0.95)"
                    strokeWidth="4"
                    strokeDasharray={`${2 * Math.PI * 28}`}
                    strokeDashoffset={`${2 * Math.PI * 28 * (1 - autoProgress / 100)}`}
                    strokeLinecap="round"
                    style={{ transition: "stroke-dashoffset 50ms linear" }}
                  />
                </svg>
              )}
            </div>
            <div className="mt-2 text-center text-[10px] font-semibold text-white/75 bg-black/45 rounded-full px-2 py-1">
              {nextTarget.shortLabel}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SpherePoseGuide({
  targets,
  capturedIds,
  nextTarget,
  aimVector,
  progress,
  autoProgress,
  isAutoCapturing,
}: {
  targets: CaptureTarget[];
  capturedIds: Set<string>;
  nextTarget: CaptureTarget | null;
  aimVector: Vec3 | null;
  progress: number;
  autoProgress: number;
  isAutoCapturing: boolean;
}) {
  const size = 220;
  const radius = 92;
  const center = size / 2;

  return (
    <div className="flex flex-col items-center gap-3">
      <svg width={size} height={size} style={{ filter: "drop-shadow(0 2px 14px rgba(0,0,0,0.85))" }}>
        <defs>
          <radialGradient id="sphereFill" cx="35%" cy="30%" r="70%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.18)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0.03)" />
          </radialGradient>
        </defs>

        <circle cx={center} cy={center} r={radius} fill="url(#sphereFill)" stroke="rgba(255,255,255,0.2)" strokeWidth={1.5} />
        <ellipse cx={center} cy={center} rx={radius} ry={radius * 0.36} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
        <ellipse cx={center} cy={center} rx={radius * 0.74} ry={radius} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
        <ellipse cx={center} cy={center} rx={radius * 0.36} ry={radius} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={1} />

        {targets.map((target) => {
          const x = center + target.vector.x * radius;
          const y = center - target.vector.y * radius;
          const isCaptured = capturedIds.has(target.id);
          const isActive = target.id === nextTarget?.id;
          const visible = target.vector.z >= 0;
          const opacity = isCaptured ? 1 : isActive ? 1 : visible ? 0.65 : 0.22;
          const fill = isCaptured ? "#4ade80" : isActive ? "#fbbf24" : "rgba(255,255,255,0.7)";
          const dotRadius = isActive ? 7 : visible ? 5 : 4;

          return (
            <g key={target.id} opacity={opacity}>
              {isActive && !isCaptured && (
                <circle cx={x} cy={y} r={11} fill="none" stroke="#fbbf24" strokeOpacity={0.45} strokeWidth={1.5}>
                  <animate attributeName="r" values="10;14;10" dur="1.3s" repeatCount="indefinite" />
                  <animate attributeName="stroke-opacity" values="0.55;0.1;0.55" dur="1.3s" repeatCount="indefinite" />
                </circle>
              )}
              {isActive && isAutoCapturing && (
                <circle
                  cx={x}
                  cy={y}
                  r={14}
                  fill="none"
                  stroke="#4ade80"
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeDasharray={`${2 * Math.PI * 14}`}
                  strokeDashoffset={`${2 * Math.PI * 14 * (1 - autoProgress / 100)}`}
                  style={{ transform: `rotate(-90deg)`, transformOrigin: `${x}px ${y}px`, transition: "stroke-dashoffset 50ms linear" }}
                />
              )}
              <circle cx={x} cy={y} r={dotRadius} fill={fill} />
              <text x={x} y={y - 11} textAnchor="middle" fontSize={9} fill={fill} fontFamily="system-ui, sans-serif">
                {target.shortLabel}
              </text>
            </g>
          );
        })}

        {aimVector && (
          <g>
            <line x1={center} y1={center} x2={center + aimVector.x * (radius - 12)} y2={center - aimVector.y * (radius - 12)} stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} />
            <circle cx={center + aimVector.x * radius} cy={center - aimVector.y * radius} r={8} fill="rgba(255,255,255,0.14)" stroke="white" strokeWidth={2} />
            <circle cx={center + aimVector.x * radius} cy={center - aimVector.y * radius} r={2.5} fill="white" />
          </g>
        )}

        <text x={center} y={23} textAnchor="middle" fontSize={10} fill="rgba(255,255,255,0.5)" fontFamily="system-ui, sans-serif">UP</text>
        <text x={center} y={size - 10} textAnchor="middle" fontSize={10} fill="rgba(255,255,255,0.5)" fontFamily="system-ui, sans-serif">DOWN</text>
      </svg>

      <div className="bg-black/60 backdrop-blur-sm rounded-full px-3 py-2 text-[11px] text-white/75">
        White marker = camera aim · amber = next shot · green = captured
      </div>

      <div className="flex items-center gap-2">
        <svg width={140} height={6}>
          <rect x={0} y={0} width={140} height={6} rx={3} fill="rgba(255,255,255,0.15)" />
          <rect x={0} y={0} width={Math.round(progress * 140)} height={6} rx={3} fill="#4ade80" />
        </svg>
        <span className="text-white/55 text-[10px]">{Math.round(progress * 100)}%</span>
      </div>
    </div>
  );
}

function AutoCaptureDial({
  isLocked,
  isAutoCapturing,
  autoProgress,
  remaining,
}: {
  isLocked: boolean;
  isAutoCapturing: boolean;
  autoProgress: number;
  remaining: number;
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className={`relative w-24 h-24 rounded-full border-4 flex items-center justify-center ${isLocked ? "border-green-400 bg-green-400/10" : "border-white/35 bg-white/5"}`}>
        {isAutoCapturing && (
          <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 96 96">
            <circle cx="48" cy="48" r="42" fill="none" stroke="rgba(74,222,128,0.25)" strokeWidth="4" />
            <circle
              cx="48"
              cy="48"
              r="42"
              fill="none"
              stroke="rgba(74,222,128,0.95)"
              strokeWidth="4"
              strokeDasharray={`${2 * Math.PI * 42}`}
              strokeDashoffset={`${2 * Math.PI * 42 * (1 - autoProgress / 100)}`}
              strokeLinecap="round"
              style={{ transition: "stroke-dashoffset 50ms linear" }}
            />
          </svg>
        )}
        <div className={`w-8 h-8 rounded-full ${isLocked ? "bg-green-400" : "bg-white/70"}`} />
      </div>
      <div className="text-center">
        <p className="text-white/85 text-sm font-medium">{isLocked ? "Hold steady for auto capture" : "Move until the target reaches centre"}</p>
        <p className="text-white/45 text-[11px]">{remaining} shots remaining</p>
      </div>
    </div>
  );
}

function BubbleLevel({ tiltDev, pitchDev }: { tiltDev: number; pitchDev: number }) {
  const size = 48;
  const cx = 24;
  const cy = 24;
  const radius = 21;
  const bubbleRadius = 7;
  const bubbleX = cx + Math.max(-1, Math.min(1, tiltDev / 25)) * (radius - bubbleRadius - 2);
  const bubbleY = cy + Math.max(-1, Math.min(1, pitchDev / 25)) * (radius - bubbleRadius - 2);
  const isBad = Math.abs(tiltDev) >= TILT_BAD || Math.abs(pitchDev) >= TILT_BAD;
  const isWarn = !isBad && (Math.abs(tiltDev) >= TILT_WARN || Math.abs(pitchDev) >= TILT_WARN);
  const color = isBad ? "#f87171" : isWarn ? "#fbbf24" : "#4ade80";

  return (
    <svg width={size} height={size} style={{ filter: "drop-shadow(0 1px 4px rgba(0,0,0,0.7))" }}>
      <circle cx={cx} cy={cy} r={radius} fill="rgba(0,0,0,0.45)" stroke={color} strokeWidth={1.5} strokeOpacity={0.5} />
      <circle cx={cx} cy={cy} r={7} fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth={1} strokeDasharray="2 2" />
      <line x1={cx - radius + 4} y1={cy} x2={cx + radius - 4} y2={cy} stroke="rgba(255,255,255,0.1)" strokeWidth={0.5} />
      <line x1={cx} y1={cy - radius + 4} x2={cx} y2={cy + radius - 4} stroke="rgba(255,255,255,0.1)" strokeWidth={0.5} />
      <circle cx={bubbleX} cy={bubbleY} r={bubbleRadius} fill={color} fillOpacity={0.9} />
      <circle cx={cx} cy={cy} r={2} fill="rgba(255,255,255,0.4)" />
    </svg>
  );
}

function SpeedMeter({ speed }: { speed: number }) {
  const max = 40;
  const pct = Math.min(speed / max, 1) * 100;
  const tooSlow = speed < SPEED_LOW;
  const tooFast = speed > SPEED_HIGH;
  const label = tooSlow ? "Rotate faster →" : tooFast ? "← Slow down" : "Good pace ✓";
  const barColor = tooSlow ? "#fb923c" : tooFast ? "#f87171" : "#4ade80";

  return (
    <div className="flex flex-col items-center gap-1 bg-black/50 backdrop-blur-sm rounded-xl px-4 py-2.5 mx-4">
      <div className="flex items-center justify-between w-full mb-0.5">
        <span className="text-white/50 text-[10px]">SLOW</span>
        <span className="text-white/90 text-xs font-semibold">{label}</span>
        <span className="text-white/50 text-[10px]">FAST</span>
      </div>
      <div className="relative h-2 bg-white/20 rounded-full overflow-hidden" style={{ minWidth: 180 }}>
        <div className="absolute top-0 h-full bg-green-400/20 rounded-full" style={{ left: `${(SPEED_LOW / max) * 100}%`, width: `${((SPEED_HIGH - SPEED_LOW) / max) * 100}%` }} />
        <div className="absolute left-0 top-0 h-full rounded-full transition-all duration-150" style={{ width: `${pct}%`, background: barColor }} />
        <div className="absolute top-0 h-full w-px bg-white/30" style={{ left: `${(SPEED_LOW / max) * 100}%` }} />
        <div className="absolute top-0 h-full w-px bg-white/30" style={{ left: `${(SPEED_HIGH / max) * 100}%` }} />
      </div>
      <span className="text-white/40 text-[9px]">{Math.round(speed)}°/s</span>
    </div>
  );
}

function StripCompass({ heading, coveredBuckets }: { heading: number; coveredBuckets: Set<number> }) {
  const width = 320;
  const height = 58;
  const center = width / 2;
  const range = 160;
  const scale = width / range;
  const elements: ReactNode[] = [];

  for (const bucket of coveredBuckets) {
    const diff = signedDiff(bucket + 5, heading);
    if (Math.abs(diff) > range / 2 + 15) continue;
    elements.push(
      <rect key={`cov-${bucket}`} x={center + (diff - 5) * scale} y={0} width={scale * 10} height={24} fill="rgba(74,222,128,0.25)" rx={2} />,
    );
  }

  const tickStart = Math.floor((heading - range / 2) / 10) * 10;
  for (let degree = tickStart; degree <= heading + range / 2 + 10; degree += 10) {
    const normalized = normalizeAngle(degree);
    const diff = degree - heading;
    if (Math.abs(diff) > range / 2 + 5) continue;
    const x = center + diff * scale;
    const major = normalized % 90 === 0;
    const medium = normalized % 45 === 0;
    const tickHeight = major ? 22 : medium ? 14 : 8;
    const isCovered = coveredBuckets.has(normalized);
    const stroke = isCovered ? "rgba(74,222,128,0.9)" : major ? "rgba(255,255,255,0.8)" : "rgba(255,255,255,0.35)";
    elements.push(<line key={`tick-${degree}`} x1={x} y1={0} x2={x} y2={tickHeight} stroke={stroke} strokeWidth={major ? 2 : 1} />);
    if (medium) {
      elements.push(<text key={`label-${degree}`} x={x} y={36} textAnchor="middle" fontSize={10} fill="rgba(255,255,255,0.6)" fontFamily="system-ui">{normalized}°</text>);
    }
  }

  return (
    <div className="flex flex-col items-center">
      <svg width={width} height={height} style={{ filter: "drop-shadow(0 1px 6px rgba(0,0,0,0.7))" }}>
        {elements}
        <line x1={center} y1={0} x2={center} y2={height - 8} stroke="white" strokeWidth={2} />
        <polygon points={`${center - 5},${height - 8} ${center + 5},${height - 8} ${center},${height}`} fill="white" />
      </svg>
      <span className="text-white/50 text-[10px] -mt-1">{Math.round((coveredBuckets.size / 36) * 100)}% covered</span>
    </div>
  );
}
