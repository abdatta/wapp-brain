import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { ImportJobSummary } from "../../../shared/types";
import { getCurrentImportJob } from "../../api";
import { ImportWizard, type ImportStep } from "../../panels";
import { useStatus } from "../../state/StatusContext";
import { useToast } from "../../state/ToastContext";

const STEP_PATHS: Record<ImportStep, string> = {
  folder: "/import",
  key: "/import/key",
  mode: "/import/mode",
  import: "/import/run"
};

function stepFromPath(pathname: string): ImportStep {
  if (pathname.endsWith("/key")) return "key";
  if (pathname.endsWith("/mode")) return "mode";
  if (pathname.endsWith("/run")) return "import";
  return "folder";
}

// The import surface. Wizard steps are URL sub-routes (`/import`, `/import/key`,
// `/import/mode`, `/import/run`) so the current step is addressable and
// back/forward move between steps. An in-progress import is reload-safe: the run
// step reattaches to the active server job, and an active job redirects the
// entry route to the run step.
export function ImportPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { status, refreshStatus } = useStatus();
  const { setNotice } = useToast();
  const [activeJob, setActiveJob] = useState<ImportJobSummary | null>(null);
  const step = stepFromPath(location.pathname);

  // Reattach an already-running import so a reload (or arriving from elsewhere)
  // lands on live progress rather than a fresh wizard.
  useEffect(() => {
    getCurrentImportJob()
      .then((result) => {
        if (result.job && (result.job.status === "queued" || result.job.status === "running" || result.job.status === "cancelling")) {
          setActiveJob(result.job);
          if (stepFromPath(window.location.pathname) !== "import") {
            navigate("/import/run", { replace: true });
          }
        }
      })
      .catch(() => {
        // Browsing the archive still works if no resumable import job is available.
      });
  }, [navigate]);

  async function handleComplete(job: ImportJobSummary) {
    setNotice(job.totals ? `Import complete: ${job.totals.messages.toLocaleString()} messages.` : "Import complete.");
    await refreshStatus();
  }

  async function handleStopped(job: ImportJobSummary) {
    setActiveJob(null);
    setNotice(job.error ?? "Import stopped and rolled back.");
    await refreshStatus();
  }

  return (
    <div className="importPage">
      <ImportWizard
        status={status}
        initialJob={activeJob}
        step={step}
        onStepChange={(next) => navigate(STEP_PATHS[next])}
        onClose={() => navigate("/chats")}
        onComplete={(job) => void handleComplete(job)}
        onStopped={(job) => void handleStopped(job)}
      />
    </div>
  );
}
