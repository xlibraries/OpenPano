import { useCallback, useState } from "react";
import LandingPage from "./components/LandingPage";
import ProcessingView from "./components/ProcessingView";
import PanoViewer from "./components/PanoViewer";
import type { PipelineResult } from "./types";

type View = "landing" | "processing" | "viewer" | "error";

export default function App() {
  const [view, setView] = useState<View>("landing");
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
    setView("landing");
    setJobId("");
    setResult(null);
    setErrorMsg("");
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header — hidden on landing since it has its own hero */}
      {view !== "landing" && (
        <header className="px-6 py-4 border-b border-border/50">
          <button
            onClick={handleReset}
            className="text-xl font-bold bg-gradient-to-r from-rose-500 to-pink-600 bg-clip-text text-transparent hover:opacity-80 transition-opacity"
          >
            PanoCraft
          </button>
        </header>
      )}

      <main>
        {view === "landing" && (
          <LandingPage onJobStarted={handleJobStarted} />
        )}

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
          <div className="flex items-center justify-center min-h-[70vh] px-4">
            <div className="max-w-md w-full text-center">
              <div className="bg-surface rounded-2xl p-10">
                <div className="text-5xl mb-4">&#9888;</div>
                <h2 className="text-2xl font-semibold mb-3">
                  Processing Failed
                </h2>
                <p className="text-muted mb-8">{errorMsg}</p>
                <button
                  onClick={handleReset}
                  className="px-8 py-3 bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors"
                >
                  Try Again
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
