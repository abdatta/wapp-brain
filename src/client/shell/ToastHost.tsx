import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { useStatus } from "../state/StatusContext";
import { useToast } from "../state/ToastContext";

// The single toast host for the whole app. Renders the notice/error line from
// the toast context plus the reindex-in-progress line from the status context,
// so a background job's state is visible on every surface. Lives in the shell.
export function ToastHost() {
  const { notice, error } = useToast();
  const { reindexProgress } = useStatus();
  const reindexing = reindexProgress && (reindexProgress.state === "running" || reindexProgress.state === "finalizing");

  if (!notice && !error && !reindexing) {
    return null;
  }
  return (
    <div className="toastHost">
      {(notice || error) && (
        <div className={`toastLine ${error ? "error" : "notice"}`}>
          {error ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
          <span>{error ?? notice}</span>
        </div>
      )}
      {reindexing && (
        <div className="toastLine notice">
          <Loader2 className="spin" size={16} />
          <span>
            Building search index —{" "}
            {reindexProgress.totalMessages > 0
              ? `${reindexProgress.processedMessages.toLocaleString()} / ${reindexProgress.totalMessages.toLocaleString()} messages`
              : "preparing…"}
          </span>
        </div>
      )}
    </div>
  );
}
