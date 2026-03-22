import { useCallback, useEffect, useRef, useState } from "react";
import type { PipelineResult } from "../types";

declare global {
  interface Window {
    pannellum: {
      viewer: (
        container: string | HTMLElement,
        config: Record<string, unknown>
      ) => PannellumViewer;
    };
  }
}

interface PannellumViewer {
  destroy: () => void;
  getHfov: () => number;
  setHfov: (hfov: number) => void;
  getYaw: () => number;
  setYaw: (yaw: number) => void;
  getPitch: () => number;
  setPitch: (pitch: number) => void;
  startAutoRotate: (speed: number) => void;
  stopAutoRotate: () => void;
  toggleFullscreen: () => void;
  on: (event: string, callback: () => void) => void;
}

interface PanoViewerProps {
  result: PipelineResult;
  onReset: () => void;
}

export default function PanoViewer({ result, onReset }: PanoViewerProps) {
  const viewerRef = useRef<PannellumViewer | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoRotate, setAutoRotate] = useState(false);
  const [hfov, setHfov] = useState(100);
  const [showInfo, setShowInfo] = useState(false);

  const fov = result.stitch?.fov;
  const quality = result.quality;
  const timing = result.timing;
  const stitch = result.stitch;
  const warnings = result.warnings || [];

  const initialHfov = fov ? Math.min(100, fov.haov * 0.8) : 100;
  const maxHfov = fov ? Math.min(fov.haov, 120) : 120;

  useEffect(() => {
    if (!containerRef.current || !stitch?.pannellum) return;

    const panoConfig = { ...stitch.pannellum };
    delete panoConfig.avoidShowingBackground;

    const config: Record<string, unknown> = {
      ...panoConfig,
      autoLoad: true,
      showControls: false,
      mouseZoom: true,
      keyboardZoom: true,
      draggable: true,
      friction: 0.15,
      showFullscreenCtrl: false,
      compass: false,
      hfov: initialHfov,
    };

    if (fov) {
      if (fov.center_yaw !== undefined) config.yaw = fov.center_yaw;
      if (fov.center_pitch !== undefined) config.pitch = fov.center_pitch;
    }

    setHfov(initialHfov);

    const viewer = window.pannellum.viewer(containerRef.current, config);
    viewerRef.current = viewer;

    return () => {
      viewer.destroy();
      viewerRef.current = null;
    };
  }, [stitch, fov, initialHfov]);

  const handleAutoRotate = useCallback((checked: boolean) => {
    setAutoRotate(checked);
    if (checked) {
      viewerRef.current?.startAutoRotate(2);
    } else {
      viewerRef.current?.stopAutoRotate();
    }
  }, []);

  const handleHfovChange = useCallback((val: number) => {
    setHfov(val);
    viewerRef.current?.setHfov(val);
  }, []);

  const handleResetView = useCallback(() => {
    const v = viewerRef.current;
    if (!v) return;
    v.setHfov(initialHfov);
    v.setYaw(fov?.center_yaw ?? 0);
    v.setPitch(fov?.center_pitch ?? 0);
    setHfov(initialHfov);
  }, [initialHfov, fov]);

  const handleDownload = useCallback(() => {
    const panoUrl = result.stitch?.pannellum?.panorama;
    if (!panoUrl) return;
    const a = document.createElement("a");
    a.href = panoUrl as string;
    a.download = "panorama.jpg";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [result]);

  const ToolbarButton = ({
    onClick,
    title,
    active,
    children,
  }: {
    onClick: () => void;
    title: string;
    active?: boolean;
    children: React.ReactNode;
  }) => (
    <button
      onClick={onClick}
      title={title}
      className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
        active
          ? "bg-primary text-white"
          : "bg-white/10 hover:bg-white/20 text-white/80 hover:text-white"
      }`}
    >
      {children}
    </button>
  );

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      {/* Viewer with floating toolbar */}
      <div
        className="relative rounded-2xl overflow-hidden bg-black"
        style={{ height: "78vh" }}
      >
        <div ref={containerRef} className="w-full h-full" />

        {/* Floating toolbar */}
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 glass rounded-xl px-3 py-2 flex items-center gap-2">
          {/* FOV slider */}
          <button
            onClick={() => handleHfovChange(Math.min(maxHfov, hfov + 10))}
            title="Zoom out"
            className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center text-white/80 text-lg transition-colors"
          >
            &minus;
          </button>
          <input
            type="range"
            min={30}
            max={maxHfov}
            value={hfov}
            onChange={(e) => handleHfovChange(parseInt(e.target.value))}
            className="w-20 sm:w-28 accent-primary"
          />
          <button
            onClick={() => handleHfovChange(Math.max(30, hfov - 10))}
            title="Zoom in"
            className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center text-white/80 text-lg transition-colors"
          >
            +
          </button>
          <span className="text-xs text-white/50 w-8 text-center tabular-nums">
            {Math.round(hfov)}&deg;
          </span>

          <div className="w-px h-6 bg-white/10 mx-1" />

          {/* Auto-rotate */}
          <ToolbarButton
            onClick={() => handleAutoRotate(!autoRotate)}
            title="Auto-rotate"
            active={autoRotate}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
          </ToolbarButton>

          {/* Fullscreen */}
          <ToolbarButton
            onClick={() => viewerRef.current?.toggleFullscreen()}
            title="Fullscreen"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
            </svg>
          </ToolbarButton>

          {/* Reset view */}
          <ToolbarButton onClick={handleResetView} title="Reset view">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </ToolbarButton>

          {/* Download */}
          <ToolbarButton onClick={handleDownload} title="Download panorama">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </ToolbarButton>

          {/* Info toggle */}
          <ToolbarButton
            onClick={() => setShowInfo(!showInfo)}
            title="Panorama info"
            active={showInfo}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
          </ToolbarButton>
        </div>
      </div>

      {/* Info panel */}
      {showInfo && (
        <div
          className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4"
          style={{ animation: "fade-in 0.2s ease" }}
        >
          {fov && (
            <StatCard
              label="Field of View"
              value={`${fov.haov.toFixed(0)}\u00B0 \u00D7 ${fov.vaov.toFixed(0)}\u00B0`}
            />
          )}
          {stitch?.mode && (
            <StatCard label="Stitch Mode" value={stitch.mode} />
          )}
          {stitch?.backend && (
            <StatCard label="Backend" value={stitch.backend} capitalize />
          )}
          {stitch?.final_size && (
            <StatCard
              label="Resolution"
              value={`${stitch.final_size[0]}\u00D7${stitch.final_size[1]}`}
            />
          )}
          {quality?.frames_stitched && (
            <StatCard
              label="Frames"
              value={`${quality.frames_stitched} stitched`}
            />
          )}
          {quality?.focal_length_35mm && (
            <StatCard
              label="Focal Length"
              value={`${quality.focal_length_35mm}mm`}
            />
          )}
          {timing?.total_seconds && (
            <StatCard
              label="Processing"
              value={`${timing.total_seconds.toFixed(1)}s`}
            />
          )}
        </div>
      )}

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="bg-primary/10 border border-primary/30 rounded-lg p-3 mt-4 text-sm text-rose-300">
          {warnings.map((w, i) => (
            <div key={i}>&#9888; {w}</div>
          ))}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex justify-center gap-3 mt-6">
        <button
          onClick={handleDownload}
          className="px-6 py-2.5 bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors text-sm font-medium"
        >
          Download Panorama
        </button>
        <button
          onClick={onReset}
          className="px-6 py-2.5 bg-surface border border-border text-foreground rounded-lg hover:border-primary/50 transition-colors text-sm"
        >
          Create Another
        </button>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  capitalize,
}: {
  label: string;
  value: string;
  capitalize?: boolean;
}) {
  return (
    <div className="bg-surface rounded-lg p-3">
      <p className="text-xs text-detail">{label}</p>
      <p className={`text-sm font-medium mt-1 ${capitalize ? "capitalize" : ""}`}>
        {value}
      </p>
    </div>
  );
}
