"use client";

import { useCallback, useState } from "react";
import UploadZone from "../components/UploadZone";
import ProcessingView from "../components/ProcessingView";
import PanoViewer from "../components/PanoViewer";
import type { PipelineResult } from "../types";

type AppState =
  | { view: "upload" }
  | { view: "processing"; jobId: string }
  | { view: "viewer"; result: PipelineResult }
  | { view: "error"; message: string };

export default function Home() {
  const [state, setState] = useState<AppState>({ view: "upload" });

  const handleJobStarted = useCallback((jobId: string) => {
    setState({ view: "processing", jobId });
  }, []);

  const handleComplete = useCallback((result: PipelineResult) => {
    setState({ view: "viewer", result });
  }, []);

  const handleError = useCallback((message: string) => {
    setState({ view: "error", message });
  }, []);

  const handleReset = useCallback(() => {
    setState({ view: "upload" });
  }, []);

  return (
    <>
      <header className="text-center py-6 bg-surface border-b-2 border-border">
        <h1 className="text-3xl font-bold text-primary tracking-wide">
          OpenPano
        </h1>
        <p className="text-muted text-sm mt-1">
          Convert video to interactive panorama
        </p>
      </header>

      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-8">
        {state.view === "upload" && (
          <UploadZone onJobStarted={handleJobStarted} />
        )}

        {state.view === "processing" && (
          <ProcessingView
            jobId={state.jobId}
            onComplete={handleComplete}
            onError={handleError}
          />
        )}

        {state.view === "viewer" && (
          <PanoViewer result={state.result} onReset={handleReset} />
        )}

        {state.view === "error" && (
          <div className="max-w-lg mx-auto text-center">
            <div className="bg-surface rounded-xl p-8">
              <h2 className="text-2xl text-primary mb-4">Processing Failed</h2>
              <p className="text-muted mb-6 leading-relaxed">
                {state.message}
              </p>
              <button
                onClick={handleReset}
                className="px-6 py-2.5 bg-border text-foreground rounded-md hover:bg-primary transition-colors"
              >
                Try Again
              </button>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
