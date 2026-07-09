// Search reindex as a background job: chunked derived-text recompute with
// event-loop yields (inside the repository), then the atomic FTS rebuild.
// One job at a time; progress is served from memory so polling never touches
// the database mid-run.

import type { SearchReindexProgress } from "../../shared/types";
import type { ArchiveRepository } from "../db/repository";
import { publicErrorMessage } from "../privacy";

const progress: SearchReindexProgress = {
  state: "idle",
  processedMessages: 0,
  totalMessages: 0,
  startedAt: null,
  finishedAt: null,
  error: null
};

export function getSearchReindexProgress(): SearchReindexProgress {
  return { ...progress };
}

export function startSearchReindex(
  repository: ArchiveRepository,
  onDone?: (result: { ok: boolean }) => void
): SearchReindexProgress {
  if (progress.state === "running" || progress.state === "finalizing") {
    return getSearchReindexProgress();
  }
  progress.state = "running";
  progress.processedMessages = 0;
  progress.totalMessages = 0;
  progress.startedAt = new Date().toISOString();
  progress.finishedAt = null;
  progress.error = null;
  // Progress and outcome are mirrored to the server console so the job stays
  // auditable even when no UI is watching. Counts and durations only — never
  // message content.
  const startedAtMs = Date.now();
  let nextMilestonePercent = 25;
  console.log("[search] index build started");
  void repository
    .rebuildSearchIndex((processed, total) => {
      progress.processedMessages = processed;
      progress.totalMessages = total;
      if (total > 0 && processed > 0) {
        const percent = Math.floor((processed / total) * 100);
        if (percent >= nextMilestonePercent) {
          console.log(`[search] indexing ${processed.toLocaleString()} / ${total.toLocaleString()} (${percent}%)`);
          nextMilestonePercent = Math.floor(percent / 25) * 25 + 25;
        }
      }
      if (processed >= total) {
        progress.state = "finalizing";
      }
    })
    .then((result) => {
      progress.state = "completed";
      progress.finishedAt = new Date().toISOString();
      console.log(
        `[search] index build completed: ${result.indexedMessages.toLocaleString()} messages in ${((Date.now() - startedAtMs) / 1000).toFixed(1)}s`
      );
      onDone?.({ ok: true });
    })
    .catch((error) => {
      progress.state = "failed";
      progress.error = publicErrorMessage(error);
      progress.finishedAt = new Date().toISOString();
      console.error(`[search] index build FAILED after ${((Date.now() - startedAtMs) / 1000).toFixed(1)}s: ${progress.error}`);
      onDone?.({ ok: false });
    });
  return getSearchReindexProgress();
}
