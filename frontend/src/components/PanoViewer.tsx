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
  const [rotateSpeed, setRotateSpeed] = useState(2);
  const [hfov, setHfov] = useState(100);

  const fov = result.stitch?.fov;
  const quality = result.quality;
  const timing = result.timing;
  const stitch = result.stitch;
  const warnings = result.warnings || [];

  const initialHfov = fov ? Math.min(100, fov.haov * 0.8) : 100;
  const maxHfov = fov ? Math.min(fov.haov, 120) : 120;

  useEffect(() => {
    if (!containerRef.current || !stitch?.pannellum) return;

    const config: Record<string, unknown> = {
      ...stitch.pannellum,
      autoLoad: true,
      showControls: true,
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

  const handleAutoRotate = useCallback(
    (checked: boolean) => {
      setAutoRotate(checked);
      if (checked) {
        viewerRef.current?.startAutoRotate(rotateSpeed);
      } else {
        viewerRef.current?.stopAutoRotate();
      }
    },
    [rotateSpeed]
  );

  const handleSpeedChange = useCallback(
    (speed: number) => {
      setRotateSpeed(speed);
      if (autoRotate) {
        viewerRef.current?.startAutoRotate(speed);
      }
    },
    [autoRotate]
  );

  const handleHfovChange = useCallback((val: number) => {
    setHfov(val);
    viewerRef.current?.setHfov(val);
  }, []);

  const handleReset = useCallback(() => {
    const v = viewerRef.current;
    if (!v) return;
    v.setHfov(initialHfov);
    v.setYaw(fov?.center_yaw ?? 0);
    v.setPitch(fov?.center_pitch ?? 0);
    setHfov(initialHfov);
  }, [initialHfov, fov]);

  return (
    <div>
      {/* Panorama viewer */}
      <div
        ref={containerRef}
        className="w-full rounded-xl overflow-hidden bg-black"
        style={{ height: "70vh" }}
      />

      {/* Controls + Metadata */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        {/* Controls */}
        <div className="bg-surface rounded-lg p-4">
          <h3 className="text-sm font-semibold text-primary mb-3">Controls</h3>

          <div className="flex items-center gap-3 mb-3 text-sm">
            <label className="flex items-center gap-1.5 whitespace-nowrap">
              <input
                type="checkbox"
                checked={autoRotate}
                onChange={(e) => handleAutoRotate(e.target.checked)}
                className="accent-primary"
              />
              Auto-Rotate
            </label>
            <input
              type="range"
              min={-10}
              max={10}
              step={0.5}
              value={rotateSpeed}
              disabled={!autoRotate}
              onChange={(e) => handleSpeedChange(parseFloat(e.target.value))}
              className="flex-1 accent-primary"
            />
            <span className="text-muted w-8 text-right">
              {rotateSpeed.toFixed(1)}
            </span>
          </div>

          <div className="flex items-center gap-3 mb-3 text-sm">
            <label className="whitespace-nowrap">Field of View</label>
            <input
              type="range"
              min={30}
              max={maxHfov}
              value={hfov}
              onChange={(e) => handleHfovChange(parseInt(e.target.value))}
              className="flex-1 accent-primary"
            />
            <span className="text-muted w-10 text-right">
              {Math.round(hfov)}&deg;
            </span>
          </div>

          <div className="flex gap-2 mt-4">
            <button
              onClick={() => viewerRef.current?.toggleFullscreen()}
              className="px-4 py-2 bg-border text-foreground rounded-md text-sm hover:bg-primary transition-colors"
            >
              Fullscreen
            </button>
            <button
              onClick={handleReset}
              className="px-4 py-2 bg-border text-foreground rounded-md text-sm hover:bg-primary transition-colors"
            >
              Reset View
            </button>
          </div>
        </div>

        {/* Metadata */}
        <div className="bg-surface rounded-lg p-4">
          <h3 className="text-sm font-semibold text-primary mb-3">
            Panorama Info
          </h3>
          <div className="text-sm leading-relaxed text-muted space-y-1">
            {fov && (
              <div>
                <strong className="text-foreground">FOV:</strong>{" "}
                {fov.haov.toFixed(1)}&deg; &times; {fov.vaov.toFixed(1)}&deg;
              </div>
            )}
            {stitch?.mode && (
              <div>
                <strong className="text-foreground">Mode:</strong>{" "}
                {stitch.mode}
              </div>
            )}
            {stitch?.final_size && (
              <div>
                <strong className="text-foreground">Size:</strong>{" "}
                {stitch.final_size[0]} &times; {stitch.final_size[1]}
              </div>
            )}
            {quality?.frames_stitched && (
              <div>
                <strong className="text-foreground">Frames:</strong>{" "}
                {quality.frames_stitched} stitched
              </div>
            )}
            {quality?.focal_length_35mm && (
              <div>
                <strong className="text-foreground">Focal:</strong>{" "}
                {quality.focal_length_35mm}mm ({quality.focal_source})
              </div>
            )}
            {timing?.total_seconds && (
              <div>
                <strong className="text-foreground">Time:</strong>{" "}
                {timing.total_seconds.toFixed(1)}s total
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="bg-primary/10 border border-primary rounded-lg p-3 mt-4 text-sm text-pink-300">
          {warnings.map((w, i) => (
            <div key={i}>&#9888; {w}</div>
          ))}
        </div>
      )}

      {/* New panorama button */}
      <div className="text-center mt-6">
        <button
          onClick={onReset}
          className="px-8 py-3 bg-border text-foreground rounded-md hover:bg-primary transition-colors"
        >
          Create Another Panorama
        </button>
      </div>
    </div>
  );
}
