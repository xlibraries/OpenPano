import { useCallback, useRef, useState } from "react";

interface UploadZoneProps {
  onJobStarted: (jobId: string) => void;
}

export default function UploadZone({ onJobStarted }: UploadZoneProps) {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [stitchBackend, setStitchBackend] = useState("openpano");
  const [equirectangular, setEquirectangular] = useState(false);
  const [equirectWidth, setEquirectWidth] = useState("4096");
  const [maxFrames, setMaxFrames] = useState("80");
  const [focalLength, setFocalLength] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

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
        setError("Network error during upload");
      };

      xhr.open("POST", "/api/upload");
      xhr.send(formData);
    },
    [onJobStarted, stitchBackend, equirectangular, equirectWidth, maxFrames, focalLength]
  );

  return (
    <div className="max-w-xl mx-auto">
      <div className="bg-surface rounded-xl p-4 mb-4 space-y-5">

        {/* Output Format */}
        <div>
          <label className="block text-sm text-muted mb-2">Output Format</label>
          <div className="flex rounded-md overflow-hidden border border-border text-sm">
            <button type="button" onClick={() => setEquirectangular(false)}
              className={`flex-1 px-3 py-2 transition-colors ${!equirectangular ? "bg-primary text-white" : "bg-background text-muted hover:text-foreground"}`}>
              Cylindrical
            </button>
            <button type="button" onClick={() => setEquirectangular(true)}
              className={`flex-1 px-3 py-2 transition-colors border-l border-border ${equirectangular ? "bg-primary text-white" : "bg-background text-muted hover:text-foreground"}`}>
              Equirectangular 360°
            </button>
          </div>
          <p className="text-detail text-xs mt-1.5">
            {equirectangular ? "Full 2:1 sphere canvas — ready for 360° viewers." : "Cropped to actual coverage."}
          </p>
        </div>

        {/* Equirect Resolution */}
        {equirectangular && (
          <div>
            <label className="block text-sm text-muted mb-2">Equirect Resolution</label>
            <div className="flex rounded-md overflow-hidden border border-border text-sm">
              {[["2048", "2K"], ["4096", "4K"], ["8192", "8K"]].map(([val, label]) => (
                <button key={val} type="button" onClick={() => setEquirectWidth(val)}
                  className={`flex-1 px-3 py-2 transition-colors border-r border-border last:border-r-0 ${equirectWidth === val ? "bg-primary text-white" : "bg-background text-muted hover:text-foreground"}`}>
                  {label}<span className="block text-[10px] opacity-70">{val}px</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Max Frames */}
        <div>
          <label className="block text-sm text-muted mb-2">Max Frames</label>
          <div className="flex rounded-md overflow-hidden border border-border text-sm">
            {[["30", "30"], ["60", "60"], ["80", "80 ✦"], ["120", "120"]].map(([val, label]) => (
              <button key={val} type="button" onClick={() => setMaxFrames(val)}
                className={`flex-1 px-3 py-2 transition-colors border-r border-border last:border-r-0 ${maxFrames === val ? "bg-primary text-white" : "bg-background text-muted hover:text-foreground"}`}>
                {label}
              </button>
            ))}
          </div>
          <p className="text-detail text-xs mt-1">✦ default</p>
        </div>

        {/* Focal Length */}
        <div>
          <label className="block text-sm text-muted mb-2">Focal Length <span className="text-detail text-xs">(optional override)</span></label>
          <div className="flex items-center gap-2">
            <input type="number" min="5" max="200" step="1" value={focalLength}
              onChange={(e) => setFocalLength(e.target.value)} placeholder="26"
              className="w-24 bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder:text-detail" />
            <span className="text-sm text-muted">mm (35mm equiv.)</span>
          </div>
        </div>

        {/* Stitching Backend */}
        <div>
          <label className="block text-sm text-muted mb-2">Stitching Backend</label>
          <div className="flex rounded-md overflow-hidden border border-border text-sm">
            <button type="button" onClick={() => setStitchBackend("openpano")}
              className={`flex-1 px-3 py-2 transition-colors ${stitchBackend === "openpano" ? "bg-primary text-white" : "bg-background text-muted hover:text-foreground"}`}>
              OpenPano
            </button>
            <button type="button" onClick={() => setStitchBackend("hugin")}
              className={`flex-1 px-3 py-2 transition-colors border-l border-border ${stitchBackend === "hugin" ? "bg-primary text-white" : "bg-background text-muted hover:text-foreground"}`}>
              Hugin CLI
            </button>
          </div>
          <p className="text-detail text-xs mt-1.5">
            {stitchBackend === "hugin" ? "Requires pto_gen, cpfind, autooptimiser, nona, enblend on the server." : "Built-in C++ engine — fast, no extra dependencies."}
          </p>
        </div>

      </div>

      <div
        className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors ${
          dragOver
            ? "border-primary bg-primary/5"
            : "border-border hover:border-primary"
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
        <div className="text-5xl text-border mb-3">&#9655;</div>
        <p className="text-lg mb-2">Drag & drop a video file here</p>
        <p className="text-muted mb-4">or</p>
        <span className="inline-block px-6 py-2.5 bg-primary text-white rounded-md cursor-pointer hover:bg-primary-hover transition-colors">
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
        <p className="text-detail text-sm mt-4">
          Supported: MP4, MOV, AVI, MKV, WebM (max 500 MB)
        </p>
      </div>

      {uploading && (
        <div className="mt-6 text-center">
          <div className="w-full h-2 bg-border rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-primary to-pink-400 rounded-full transition-all duration-300"
              style={{ width: `${uploadPercent}%` }}
            />
          </div>
          <p className="text-muted mt-2">Uploading... {uploadPercent}%</p>
        </div>
      )}

      {error && (
        <p className="text-primary text-center mt-4 text-sm">{error}</p>
      )}
    </div>
  );
}
