import { useCallback, useEffect, useRef, useState } from "react";
import type { PipelineResult } from "../types";

const DEMOS = [
  { id: "360-3", file: "/demos/360-3.mp4", label: "Quick Pan", desc: "Short sweep panorama" },
  { id: "360vid-1", file: "/demos/360vid-1.mp4", label: "City View", desc: "Urban landscape capture" },
  { id: "360vid", file: "/demos/360vid.mp4", label: "Full 360\u00B0", desc: "Complete rotation" },
];

interface PastJob {
  job_id: string;
  panorama: string;
  created_at: number;
}

interface LandingPageProps {
  onJobStarted: (jobId: string) => void;
  onCameraCapture?: () => void;
  onViewResult?: (result: PipelineResult) => void;
}

export default function LandingPage({ onJobStarted, onCameraCapture, onViewResult }: LandingPageProps) {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [stitchBackend, setStitchBackend] = useState("openpano");
  const [loadingDemo, setLoadingDemo] = useState<string | null>(null);
  const [equirectangular, setEquirectangular] = useState(false);
  const [equirectWidth, setEquirectWidth] = useState("4096");
  const [maxFrames, setMaxFrames] = useState("80");
  const [focalLength, setFocalLength] = useState("");
  const [pastJobs, setPastJobs] = useState<PastJob[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/past-jobs")
      .then((r) => r.json())
      .then((data: PastJob[]) => setPastJobs(data))
      .catch(() => {});
  }, []);

  const upload = useCallback(
    (file: File) => {
      setError(null);
      if (file.size > 500 * 1024 * 1024) {
        setError("File too large (max 500 MB)");
        return;
      }

      const formData = new FormData();
      formData.append("video", file);
      formData.append("stitch_backend", stitchBackend);
      formData.append("equirectangular", equirectangular ? "1" : "0");
      formData.append("equirect_width", equirectWidth);
      formData.append("max_frames", maxFrames);
      if (focalLength.trim()) formData.append("focal_length", focalLength.trim());
      setUploading(true);
      setUploadPercent(0);

      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          setUploadPercent(Math.round((e.loaded / e.total) * 100));
        }
      });

      xhr.onload = () => {
        setUploading(false);
        setLoadingDemo(null);
        if (xhr.status === 200) {
          const { job_id } = JSON.parse(xhr.responseText);
          onJobStarted(job_id);
        } else {
          let msg = "Upload failed";
          try {
            msg = JSON.parse(xhr.responseText).error || msg;
          } catch {
            /* ignore */
          }
          setError(msg);
        }
      };

      xhr.onerror = () => {
        setUploading(false);
        setLoadingDemo(null);
        setError("Network error during upload");
      };

      xhr.open("POST", "/api/upload");
      xhr.send(formData);
    },
    [onJobStarted, stitchBackend, equirectangular, equirectWidth, maxFrames, focalLength]
  );

  const handleDemoClick = useCallback(
    async (demo: (typeof DEMOS)[0]) => {
      if (uploading) return;
      setLoadingDemo(demo.id);
      setError(null);
      try {
        const res = await fetch(demo.file);
        const blob = await res.blob();
        const file = new File([blob], `${demo.id}.mp4`, { type: "video/mp4" });
        upload(file);
      } catch {
        setError("Failed to load demo video");
        setLoadingDemo(null);
      }
    },
    [upload, uploading]
  );

  return (
    <div className="min-h-screen flex flex-col">
      {/* Hero */}
      <div className="flex flex-col items-center justify-center pt-24 pb-14 px-4">
        <h1
          className="text-7xl sm:text-8xl font-extrabold bg-gradient-to-r from-rose-500 via-pink-500 to-purple-500 bg-clip-text text-transparent pb-2"
          style={{
            backgroundSize: "200% auto",
            animation: "gradient-x 4s ease infinite",
          }}
        >
          PanoCraft
        </h1>
        <p className="text-lg sm:text-xl text-muted mt-5 max-w-md text-center leading-relaxed">
          Transform any video into an interactive, explorable panorama
        </p>
      </div>

      {/* Feature highlights */}
      <div className="flex justify-center gap-10 sm:gap-16 px-4 mb-16">
        {[
          { icon: "\u25B6", title: "Drop a Video", desc: "MP4, MOV, WebM & more" },
          { icon: "\u2728", title: "Smart Stitching", desc: "Auto frame selection" },
          { icon: "\uD83C\uDF10", title: "360\u00B0 Viewer", desc: "Pan, zoom & explore" },
        ].map((f) => (
          <div key={f.title} className="text-center max-w-[160px]">
            <div className="text-2xl mb-2">{f.icon}</div>
            <p className="text-sm font-semibold">{f.title}</p>
            <p className="text-xs text-muted mt-1">{f.desc}</p>
          </div>
        ))}
      </div>

      {/* Demo Section */}
      <div className="max-w-3xl mx-auto w-full px-4 mb-10">
        <p className="text-xs text-detail uppercase tracking-[0.2em] text-center mb-5">
          Try a sample
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {DEMOS.map((demo) => (
            <button
              key={demo.id}
              onClick={() => handleDemoClick(demo)}
              disabled={uploading}
              className="group relative rounded-xl overflow-hidden bg-surface border border-border hover:border-primary/50 transition-all duration-300 text-left disabled:opacity-40"
            >
              <div className="relative aspect-video bg-black">
                <video
                  src={demo.file}
                  className="w-full h-full object-cover"
                  muted
                  playsInline
                  preload="metadata"
                  onMouseOver={(e) => e.currentTarget.play()}
                  onMouseOut={(e) => {
                    e.currentTarget.pause();
                    e.currentTarget.currentTime = 0;
                  }}
                />
                <div className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                  {loadingDemo === demo.id ? (
                    <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  ) : (
                    <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
                      <span className="text-white text-lg ml-0.5">&#9654;</span>
                    </div>
                  )}
                </div>
              </div>
              <div className="p-3">
                <p className="text-sm font-medium">{demo.label}</p>
                <p className="text-xs text-detail mt-0.5">{demo.desc}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Divider */}
      <div className="flex items-center gap-4 max-w-xl mx-auto w-full px-4 my-4">
        <div className="flex-1 h-px bg-border" />
        <span className="text-detail text-sm">or capture your own</span>
        <div className="flex-1 h-px bg-border" />
      </div>

      {/* Camera capture CTA */}
      {onCameraCapture && (
        <div className="max-w-xl mx-auto w-full px-4 mb-4">
          <button
            onClick={onCameraCapture}
            disabled={uploading}
            className="w-full flex items-center justify-center gap-3 py-4 bg-surface border border-border hover:border-primary/50 rounded-xl transition-all disabled:opacity-40 group"
          >
            <span className="text-2xl">📷</span>
            <div className="text-left">
              <p className="text-sm font-semibold group-hover:text-primary transition-colors">Capture with Camera</p>
              <p className="text-xs text-detail">Guided 360° capture — video pan or photo burst</p>
            </div>
            <span className="ml-auto text-detail text-xs bg-background border border-border px-2 py-0.5 rounded-full">New</span>
          </button>
        </div>
      )}

      {/* Divider */}
      <div className="flex items-center gap-4 max-w-xl mx-auto w-full px-4 mb-4">
        <div className="flex-1 h-px bg-border" />
        <span className="text-detail text-sm">or upload a file</span>
        <div className="flex-1 h-px bg-border" />
      </div>

      {/* Upload zone */}
      <div className="max-w-xl mx-auto w-full px-4 mb-6">
        <div
          className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-all duration-200 ${
            dragOver
              ? "border-primary bg-primary/5 scale-[1.01]"
              : "border-border hover:border-primary/40"
          }`}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files.length) upload(e.dataTransfer.files[0]);
          }}
        >
          <div className="text-4xl text-border mb-2">&#128249;</div>
          <p className="text-base mb-1">Drag & drop a video file</p>
          <p className="text-muted text-sm mb-4">or click to browse</p>
          <span className="inline-block px-5 py-2 bg-primary text-white rounded-lg text-sm hover:bg-primary-hover transition-colors">
            Choose Video
          </span>
          <input
            ref={fileRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) upload(e.target.files[0]);
            }}
          />
          <p className="text-detail text-xs mt-4">
            MP4, MOV, AVI, MKV, WebM &mdash; up to 500 MB
          </p>
        </div>
      </div>

      {/* Advanced options */}
      <div className="max-w-xl mx-auto w-full px-4 mb-8">
        <details className="bg-surface rounded-lg">
          <summary className="px-4 py-3 cursor-pointer text-sm text-muted hover:text-foreground transition-colors select-none">
            Advanced options
          </summary>
          <div className="px-4 pb-4 space-y-5">

            {/* Output Format */}
            <div>
              <label className="block text-xs text-detail mb-2">Output Format</label>
              <div className="flex rounded-md overflow-hidden border border-border text-sm">
                <button
                  type="button"
                  onClick={() => setEquirectangular(false)}
                  className={`flex-1 px-3 py-2 transition-colors ${!equirectangular ? "bg-primary text-white" : "bg-background text-muted hover:text-foreground"}`}
                >
                  Cylindrical
                </button>
                <button
                  type="button"
                  onClick={() => setEquirectangular(true)}
                  className={`flex-1 px-3 py-2 transition-colors border-l border-border ${equirectangular ? "bg-primary text-white" : "bg-background text-muted hover:text-foreground"}`}
                >
                  Equirectangular 360°
                </button>
              </div>
              <p className="text-xs text-detail mt-1.5">
                {equirectangular
                  ? "Full 2:1 sphere canvas — ready for 360° viewers like Pannellum."
                  : "Cropped to actual coverage — best for partial sweeps."}
              </p>
            </div>

            {/* Equirect Resolution — only shown when equirectangular */}
            {equirectangular && (
              <div>
                <label className="block text-xs text-detail mb-2">Equirect Resolution</label>
                <div className="flex rounded-md overflow-hidden border border-border text-sm">
                  {[["2048", "2K"], ["4096", "4K"], ["8192", "8K"]].map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setEquirectWidth(val)}
                      className={`flex-1 px-3 py-2 transition-colors border-r border-border last:border-r-0 ${equirectWidth === val ? "bg-primary text-white" : "bg-background text-muted hover:text-foreground"}`}
                    >
                      {label}
                      <span className="block text-[10px] opacity-70">{val}px</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Max Frames */}
            <div>
              <label className="block text-xs text-detail mb-2">Max Frames to Stitch</label>
              <div className="flex rounded-md overflow-hidden border border-border text-sm">
                {[["30", "30"], ["60", "60"], ["80", "80 ✦"], ["120", "120"]].map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setMaxFrames(val)}
                    className={`flex-1 px-3 py-2 transition-colors border-r border-border last:border-r-0 ${maxFrames === val ? "bg-primary text-white" : "bg-background text-muted hover:text-foreground"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-detail mt-1.5">✦ default — more frames = higher quality but slower</p>
            </div>

            {/* Focal Length */}
            <div>
              <label className="block text-xs text-detail mb-2">
                Focal Length Override <span className="text-detail/60">(optional)</span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="5"
                  max="200"
                  step="1"
                  value={focalLength}
                  onChange={(e) => setFocalLength(e.target.value)}
                  placeholder="26"
                  className="w-28 bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder:text-detail"
                />
                <span className="text-sm text-muted">mm (35mm equiv.)</span>
              </div>
              <p className="text-xs text-detail mt-1.5">Leave blank to auto-detect from video metadata.</p>
            </div>

            {/* Stitching Backend */}
            <div>
              <label className="block text-xs text-detail mb-2">Stitching Backend</label>
              <div className="flex rounded-md overflow-hidden border border-border text-sm">
                <button
                  type="button"
                  onClick={() => setStitchBackend("openpano")}
                  className={`flex-1 px-3 py-2 transition-colors ${stitchBackend === "openpano" ? "bg-primary text-white" : "bg-background text-muted hover:text-foreground"}`}
                >
                  OpenPano
                </button>
                <button
                  type="button"
                  onClick={() => setStitchBackend("hugin")}
                  className={`flex-1 px-3 py-2 transition-colors border-l border-border ${stitchBackend === "hugin" ? "bg-primary text-white" : "bg-background text-muted hover:text-foreground"}`}
                >
                  Hugin CLI
                </button>
              </div>
              <p className="text-xs text-detail mt-1.5">
                {stitchBackend === "hugin"
                  ? "Requires pto_gen, cpfind, autooptimiser, nona, enblend on the server."
                  : "Built-in C++ engine — fast, no extra dependencies."}
              </p>
            </div>

          </div>
        </details>
      </div>

      {/* Upload progress */}
      {uploading && !loadingDemo && (
        <div className="max-w-xl mx-auto w-full px-4 mb-8 text-center">
          <div className="w-full h-1.5 bg-border rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-primary to-pink-400 rounded-full transition-all duration-300"
              style={{ width: `${uploadPercent}%` }}
            />
          </div>
          <p className="text-muted text-sm mt-2">
            Uploading... {uploadPercent}%
          </p>
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="text-primary text-center text-sm mb-8">{error}</p>
      )}

      {/* Pricing Section */}
      <div className="max-w-4xl mx-auto w-full px-4 mt-16 mb-12">
        <h2
          className="text-3xl font-bold text-center mb-3 bg-gradient-to-r from-rose-500 to-pink-500 bg-clip-text text-transparent"
        >
          Pricing
        </h2>
        <p className="text-muted text-center text-sm mb-10">
          Start for free. Scale when you need to.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
          {/* Free */}
          <div className="bg-surface border border-border rounded-2xl p-6 flex flex-col">
            <p className="text-xs text-detail uppercase tracking-wider mb-2">Free</p>
            <p className="text-3xl font-bold mb-1">$0</p>
            <p className="text-xs text-muted mb-6">forever</p>
            <ul className="text-sm text-muted space-y-2.5 mb-8 flex-1">
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">&#10003;</span>
                3 panoramas per day
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">&#10003;</span>
                Standard processing speed
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">&#10003;</span>
                720p max export
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">&#10003;</span>
                Community support
              </li>
            </ul>
            <button className="w-full py-2.5 border border-border rounded-lg text-sm text-foreground hover:border-primary/50 transition-colors">
              Get Started
            </button>
          </div>

          {/* Pro */}
          <div className="bg-surface border-2 border-primary rounded-2xl p-6 flex flex-col relative">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-white text-xs font-semibold px-3 py-1 rounded-full">
              Popular
            </div>
            <p className="text-xs text-detail uppercase tracking-wider mb-2">Pro</p>
            <p className="text-3xl font-bold mb-1">
              $2.99<span className="text-base font-normal text-muted">/mo</span>
            </p>
            <p className="text-xs text-muted mb-6">per seat, billed annually</p>
            <ul className="text-sm text-muted space-y-2.5 mb-8 flex-1">
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">&#10003;</span>
                50 panoramas per day
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">&#10003;</span>
                Priority processing
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">&#10003;</span>
                4K export &amp; download
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">&#10003;</span>
                Early access to new features
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">&#10003;</span>
                Team workspace (up to 5)
              </li>
            </ul>
            <button className="w-full py-2.5 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-hover transition-colors">
              Start Free Trial
            </button>
          </div>

          {/* Enterprise */}
          <div className="bg-surface border border-border rounded-2xl p-6 flex flex-col">
            <p className="text-xs text-detail uppercase tracking-wider mb-2">Enterprise</p>
            <p className="text-3xl font-bold mb-1">Custom</p>
            <p className="text-xs text-muted mb-6">tailored to your org</p>
            <ul className="text-sm text-muted space-y-2.5 mb-8 flex-1">
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">&#10003;</span>
                Unlimited panoramas
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">&#10003;</span>
                Fastest processing (dedicated GPU)
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">&#10003;</span>
                8K export &amp; raw output
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">&#10003;</span>
                Early access + beta features
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">&#10003;</span>
                Unlimited team seats
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">&#10003;</span>
                Dedicated support &amp; SLA
              </li>
            </ul>
            <button className="w-full py-2.5 border border-border rounded-lg text-sm text-foreground hover:border-primary/50 transition-colors">
              Contact Sales
            </button>
          </div>
        </div>
      </div>

      {/* Previous panoramas */}
      {pastJobs.length > 0 && (
        <div className="max-w-5xl mx-auto px-6 py-12">
          <h2 className="text-xl font-semibold mb-6">Previous Panoramas</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {pastJobs.map((job) => (
              <button
                key={job.job_id}
                onClick={() => {
                  if (!onViewResult) return;
                  onViewResult({
                    status: "success",
                    stitch: {
                      final_size: [4096, 2048],
                      stitched_size: [4096, 2048],
                      duration_seconds: 0,
                      mode: "metadata",
                      projection: "equirectangular",
                      pannellum: {
                        type: "equirectangular",
                        panorama: job.panorama,
                        autoLoad: true,
                      },
                    },
                  });
                }}
                className="group relative aspect-video rounded-xl overflow-hidden border border-border hover:border-primary/50 transition-all"
              >
                <img
                  src={job.panorama}
                  alt="Panorama"
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                />
                <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <span className="text-white text-sm font-medium">View 360°</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Footer spacer */}
      <div className="flex-1" />
      <footer className="text-center text-detail text-xs py-6">
        Powered by OpenPano Engine
      </footer>
    </div>
  );
}
