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

  return (
    <div className="max-w-lg mx-auto text-center">
      <h2 className="text-2xl text-primary mb-6">Processing Video</h2>
      <div className="bg-surface rounded-xl p-8">
        <p className="text-lg mb-4">{stage}</p>
        <div className="w-full h-2 bg-border rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-primary to-pink-400 rounded-full transition-all duration-400"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="text-detail text-xs mt-3 break-all">{detail}</p>
        <p className="text-muted mt-3">Elapsed: {elapsed}s</p>
      </div>
    </div>
  );
}
