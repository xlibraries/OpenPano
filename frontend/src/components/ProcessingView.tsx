import { useEffect, useRef, useState } from "react";
import type { PipelineResult, ProgressData } from "../types";

interface ProcessingViewProps {
  jobId: string;
  onComplete: (result: PipelineResult) => void;
  onError: (message: string) => void;
}

export default function ProcessingView({
  jobId,
  onComplete,
  onError,
}: ProcessingViewProps) {
  const [stage, setStage] = useState("Starting pipeline...");
  const [percent, setPercent] = useState(0);
  const [detail, setDetail] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const startTime = useRef(Date.now());
  const stopped = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed(Math.round((Date.now() - startTime.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    stopped.current = false;

    const poll = () => {
      if (stopped.current) return;

      fetch(`/api/jobs/${jobId}/status`)
        .then((r) => r.json())
        .then((data) => {
          if (stopped.current) return;

          if (data.status === "processing") {
            const p: ProgressData = data.progress;
            if (p) {
              setStage(p.stage);
              setPercent(p.percent);
              setDetail(p.detail);
            }
            setTimeout(poll, 1500);
          } else if (data.status === "success") {
            onComplete(data);
          } else if (data.status === "error") {
            onError(data.error_message || "Processing failed");
          } else {
            setTimeout(poll, 1500);
          }
        })
        .catch(() => {
          if (!stopped.current) {
            setTimeout(poll, 3000);
          }
        });
    };

    poll();

    return () => {
      stopped.current = true;
    };
  }, [jobId, onComplete, onError]);

  const formatTime = (s: number) => {
    const min = Math.floor(s / 60);
    const sec = s % 60;
    return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
  };

  return (
    <div className="flex items-center justify-center min-h-[70vh] px-4">
      <div
        className="max-w-md w-full text-center"
        style={{ animation: "fade-in 0.3s ease" }}
      >
        {/* Spinning indicator */}
        <div className="relative w-16 h-16 mx-auto mb-8">
          <div className="absolute inset-0 rounded-full border-2 border-border" />
          <div
            className="absolute inset-0 rounded-full border-2 border-transparent border-t-primary animate-spin"
            style={{ animationDuration: "1.2s" }}
          />
          <div className="absolute inset-0 flex items-center justify-center text-lg">
            &#10024;
          </div>
        </div>

        <h2 className="text-xl font-semibold mb-1">Processing Video</h2>
        <p className="text-muted mb-8 text-sm">{stage}</p>

        {/* Progress bar */}
        <div className="bg-surface rounded-xl p-5">
          <div className="w-full h-2 bg-border rounded-full overflow-hidden mb-3">
            <div
              className="h-full bg-gradient-to-r from-primary to-pink-400 rounded-full transition-all duration-500"
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-detail">
            <span>{percent}%</span>
            <span>{formatTime(elapsed)}</span>
          </div>
        </div>

        {detail && (
          <p className="text-detail text-xs mt-4 break-all leading-relaxed">
            {detail}
          </p>
        )}
      </div>
    </div>
  );
}
