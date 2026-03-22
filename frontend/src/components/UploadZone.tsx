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
    [onJobStarted, stitchBackend]
  );

  return (
    <div className="max-w-xl mx-auto">
      <div className="bg-surface rounded-xl p-4 mb-4">
        <label className="block text-sm text-muted mb-2">Stitching Backend</label>
        <select
          value={stitchBackend}
          onChange={(e) => setStitchBackend(e.target.value)}
          className="w-full bg-background border border-border rounded-md px-3 py-2 text-foreground"
        >
          <option value="hugin">Hugin CLI (higher-quality equirect export)</option>
          <option value="openpano">OpenPano engine</option>
        </select>
        <p className="text-detail text-xs mt-2">
          Hugin requires `pto_gen`, `cpfind`, `autooptimiser`, `pano_modify`, `nona`, and `enblend`
          to be installed on the backend machine.
        </p>
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
