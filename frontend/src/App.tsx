import { useCallback, useState } from "react";
import UploadZone from "./components/UploadZone";
import ProcessingView from "./components/ProcessingView";
import PanoViewer from "./components/PanoViewer";
import type { PipelineResult } from "./types";

type View = "upload" | "processing" | "viewer" | "error";

export default function App() {
  const [view, setView] = useState<View>("upload");
  const [jobId, setJobId] = useState("");
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  const handleJobStarted = useCallback((id: string) => {
    setJobId(id);
    setView("processing");
  }, []);

  const handleComplete = useCallback((data: PipelineResult) => {
    setResult(data);
    setView("viewer");
  }, []);

  const handleError = useCallback((msg: string) => {
    setErrorMsg(msg);
    setView("error");
  }, []);

  const handleReset = useCallback(() => {
    setView("upload");
    setJobId("");
    setResult(null);
    setErrorMsg("");
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="text-center py-8">
        <h1 className="text-4xl font-bold text-primary">OpenPano</h1>
        <p className="text-muted mt-2">Video to Interactive Panorama</p>
      </header>

      <main className="max-w-5xl mx-auto px-4 pb-12">
        {view === "upload" && <UploadZone onJobStarted={handleJobStarted} />}

        {view === "processing" && (
          <ProcessingView
            jobId={jobId}
            onComplete={handleComplete}
            onError={handleError}
          />
        )}

        {view === "viewer" && result && (
          <PanoViewer result={result} onReset={handleReset} />
        )}

        {view === "error" && (
          <div className="max-w-lg mx-auto text-center">
            <h2 className="text-2xl text-primary mb-4">Processing Failed</h2>
            <p className="text-muted mb-6">{errorMsg}</p>
            <button
              onClick={handleReset}
              className="px-8 py-3 bg-primary text-white rounded-md hover:bg-primary-hover transition-colors"
            >
              Try Again
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
