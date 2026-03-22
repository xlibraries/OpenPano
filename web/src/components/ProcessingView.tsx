"use client";

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

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed(Math.round((Date.now() - startTime.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const es = new EventSource(`/api/jobs/${jobId}/events`);

    es.addEventListener("progress", (e) => {
      const data: ProgressData = JSON.parse(e.data);
      setStage(data.stage);
      setPercent(data.percent);
      setDetail(data.detail);
    });

    es.addEventListener("complete", (e) => {
      es.close();
      const result: PipelineResult = JSON.parse(e.data);
      onComplete(result);
    });

    es.addEventListener("error", () => {
      es.close();
      // Fallback: poll result endpoint
      const poll = () => {
        fetch(`/api/jobs/${jobId}/result`)
          .then((r) => r.json())
          .then((data) => {
            if (data.status === "processing") {
              setTimeout(poll, 2000);
            } else if (data.status === "success") {
              onComplete(data);
            } else {
              onError(data.error_message || "Processing failed");
            }
          })
          .catch(() => onError("Lost connection to server"));
      };
      poll();
    });

    return () => es.close();
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
