import type {
  BrainOverview,
  BrainProviderName,
  BrainProviderStatus,
  ChatListItem,
  ChatListOptions,
  ImportJobSummary,
  ImportMode,
  ImportRequest,
  ImportTotals,
  ImportVerificationSummary,
  LiveGapWindowRecord,
  LiveMaintainerStatusSummary,
  LivePairingSummary,
  LiveSyncProgress,
  MediaQueueSummary,
  MemoryConsolidationResult,
  MemoryCitationResolution,
  MemoryProviderStatus,
  MemoryQueryResult,
  MemoryStatusSummary,
  MessageContextWindow,
  MessageEditRevisionRecord,
  MessageListItem,
  MessageListOrder,
  PickKind,
  SearchIndexStatus,
  SearchReindexProgress,
  SearchResponse,
  SearchTypeFilter,
  StatusSummary,
  BackupDetectionManifest
} from "../shared/types";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {})
    }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error ?? "Local request failed.");
  }
  return payload as T;
}

export function getStatus(): Promise<StatusSummary> {
  return request<StatusSummary>("/api/status");
}

export function initDatabase(): Promise<{ ok: boolean; status: StatusSummary }> {
  return request<{ ok: boolean; status: StatusSummary }>("/api/init-db", { method: "POST", body: "{}" });
}

export function runImport(requestBody: ImportRequest): Promise<{ ok: boolean; totals: ImportTotals }> {
  return request<{ ok: boolean; totals: ImportTotals }>("/api/import", {
    method: "POST",
    body: JSON.stringify(requestBody)
  });
}

export function cleanupTempFiles(): Promise<{ ok: boolean; summary: { removedFiles: number; removedDirectories: number } }> {
  return request<{ ok: boolean; summary: { removedFiles: number; removedDirectories: number } }>("/api/cleanup", {
    method: "POST",
    body: "{}"
  });
}

// Opens a native OS dialog on the local server and returns the absolute path the
// user selects. `cancelled` when dismissed, `unavailable` when the picker can't
// run (the wizard then falls back to a typed path).
export function pickImportPath(
  kind: PickKind,
  startIn?: string | null
): Promise<{ ok: boolean; path?: string; cancelled?: boolean; unavailable?: boolean; reason?: string }> {
  return request("/api/import/pick", {
    method: "POST",
    body: JSON.stringify({ kind, startIn: startIn ?? null })
  });
}

export function detectBackupFolder(root: string): Promise<{ ok: boolean; manifest: BackupDetectionManifest }> {
  return request<{ ok: boolean; manifest: BackupDetectionManifest }>("/api/import/detect", {
    method: "POST",
    body: JSON.stringify({ root })
  });
}

export function verifyImportKey(requestBody: {
  msgstorePath?: string | null;
  waPath?: string | null;
  key?: string | null;
}): Promise<{ ok: boolean; verification: ImportVerificationSummary }> {
  return request<{ ok: boolean; verification: ImportVerificationSummary }>("/api/import/verify-key", {
    method: "POST",
    body: JSON.stringify(requestBody)
  });
}

export function startImportJob(requestBody: {
  mode: ImportMode;
  key?: string | null;
  keepDecrypted?: boolean;
  paths?: Partial<Pick<ImportRequest, "msgstorePath" | "waPath" | "mediaPath">>;
}): Promise<{ ok: boolean; job: ImportJobSummary }> {
  return request<{ ok: boolean; job: ImportJobSummary }>("/api/import/jobs", {
    method: "POST",
    body: JSON.stringify(requestBody)
  });
}

export function getImportJob(jobId: string): Promise<ImportJobSummary> {
  return request<ImportJobSummary>(`/api/import/jobs/${jobId}`);
}

export function getCurrentImportJob(): Promise<{ job: ImportJobSummary | null }> {
  return request<{ job: ImportJobSummary | null }>("/api/import/jobs/current");
}

export function cancelImportJob(jobId: string): Promise<{ ok: boolean; job: ImportJobSummary }> {
  return request<{ ok: boolean; job: ImportJobSummary }>(`/api/import/jobs/${jobId}`, { method: "DELETE", body: "{}" });
}

export function getLiveStatus(): Promise<LiveMaintainerStatusSummary> {
  return request<LiveMaintainerStatusSummary>("/api/live/status");
}

export function listLiveGaps(): Promise<LiveGapWindowRecord[]> {
  return request<LiveGapWindowRecord[]>("/api/live/gaps");
}

export function retryLiveGap(id: number): Promise<{ ok: boolean; live: LiveMaintainerStatusSummary }> {
  return request<{ ok: boolean; live: LiveMaintainerStatusSummary }>(`/api/live/gaps/${id}/retry`, { method: "POST", body: "{}" });
}

export function unlinkLiveSession(): Promise<{ ok: boolean; live: LiveMaintainerStatusSummary }> {
  return request<{ ok: boolean; live: LiveMaintainerStatusSummary }>("/api/live/unlink", { method: "POST", body: "{}" });
}

export function stopLiveSession(): Promise<{ ok: boolean; live: LiveMaintainerStatusSummary }> {
  return request<{ ok: boolean; live: LiveMaintainerStatusSummary }>("/api/live/stop", { method: "POST", body: "{}" });
}

export function linkLiveSession(phoneNumber?: string | null): Promise<{ ok: boolean; live: LiveMaintainerStatusSummary; pairing: LivePairingSummary }> {
  return request<{ ok: boolean; live: LiveMaintainerStatusSummary; pairing: LivePairingSummary }>("/api/live/link", {
    method: "POST",
    body: JSON.stringify({ phoneNumber: phoneNumber ?? null })
  });
}

export function resumeLiveSession(): Promise<{ ok: boolean; live: LiveMaintainerStatusSummary; pairing: LivePairingSummary }> {
  return request<{ ok: boolean; live: LiveMaintainerStatusSummary; pairing: LivePairingSummary }>("/api/live/resume", { method: "POST", body: "{}" });
}

export function getLivePairing(): Promise<LivePairingSummary> {
  return request<LivePairingSummary>("/api/live/pairing");
}

export function getLiveProgress(): Promise<LiveSyncProgress> {
  return request<LiveSyncProgress>("/api/live/progress");
}

export function getMemoryStatus(): Promise<MemoryStatusSummary> {
  return request<MemoryStatusSummary>("/api/memory/status");
}

export function startMemoryRun(requestBody: {
  kind?: "rem" | "manual" | "rebuild";
  dryRun?: boolean;
  force?: boolean;
  provider?: "local" | "codex";
}): Promise<{ ok: boolean; result: MemoryConsolidationResult }> {
  return request<{ ok: boolean; result: MemoryConsolidationResult }>("/api/memory/runs", {
    method: "POST",
    body: JSON.stringify(requestBody)
  });
}

export function queryMemory(query: string): Promise<MemoryQueryResult> {
  return request<MemoryQueryResult>("/api/memory/query", {
    method: "POST",
    body: JSON.stringify({ query })
  });
}

export function resolveMemoryCitation(citation: string): Promise<MemoryCitationResolution> {
  return request<MemoryCitationResolution>(`/api/memory/citations/${encodeURIComponent(citation)}`);
}

export function enableCodexMemoryProvider(): Promise<MemoryProviderStatus> {
  return request<MemoryProviderStatus>("/api/memory/provider/enable-codex", { method: "POST", body: "{}" });
}

export function disableMemoryProvider(): Promise<MemoryProviderStatus> {
  return request<MemoryProviderStatus>("/api/memory/provider/disable", { method: "POST", body: "{}" });
}

export function listChats(params: Partial<ChatListOptions>): Promise<ChatListItem[]> {
  const query = new URLSearchParams();
  if (params.search) query.set("search", params.search);
  if (params.type) query.set("type", params.type);
  if (params.includeEventOnly) query.set("includeEventOnly", "true");
  query.set("limit", String(params.limit ?? 60));
  query.set("offset", String(params.offset ?? 0));
  return request<ChatListItem[]>(`/api/chats?${query}`);
}

// Local loopback media URLs (used directly as img/video/audio sources).
export function mediaAssetUrl(assetId: number): string {
  return `/api/media/assets/${assetId}`;
}

export function mediaThumbnailUrl(assetId: number): string {
  return `/api/media/assets/${assetId}/thumbnail`;
}

export function linkPreviewThumbnailUrl(messageId: number): string {
  return `/api/messages/${messageId}/link-preview-thumbnail`;
}

export function listMessageRevisions(messageId: number): Promise<MessageEditRevisionRecord[]> {
  return request<MessageEditRevisionRecord[]>(`/api/messages/${messageId}/revisions`);
}

export function retryStuckMedia(): Promise<{ ok: boolean; requeued: number; media: MediaQueueSummary }> {
  return request<{ ok: boolean; requeued: number; media: MediaQueueSummary }>("/api/media/retry", { method: "POST", body: "{}" });
}

export function listMessages(
  chatId: number,
  params: { limit?: number; offset?: number; sender?: string; query?: string; order?: MessageListOrder }
): Promise<MessageListItem[]> {
  const query = new URLSearchParams();
  query.set("limit", String(params.limit ?? 150));
  query.set("offset", String(params.offset ?? 0));
  if (params.sender) query.set("sender", params.sender);
  if (params.query) query.set("query", params.query);
  if (params.order) query.set("order", params.order);
  return request<MessageListItem[]>(`/api/chats/${chatId}/messages?${query}`);
}

// Thread window centered on a message (search deep links).
export function getMessageContext(chatId: number, anchorId: number, radius = 75): Promise<MessageContextWindow> {
  return request<MessageContextWindow>(`/api/chats/${chatId}/messages/context?anchorId=${anchorId}&radius=${radius}`);
}

export function searchArchive(params: {
  query: string;
  sender?: string | null;
  afterMs?: number | null;
  beforeMs?: number | null;
  type?: SearchTypeFilter | null;
  direction?: "incoming" | "outgoing" | null;
  limit?: number;
  offset?: number;
}): Promise<SearchResponse> {
  const query = new URLSearchParams();
  query.set("query", params.query);
  if (params.sender) query.set("sender", params.sender);
  if (params.afterMs != null) query.set("afterMs", String(params.afterMs));
  if (params.beforeMs != null) query.set("beforeMs", String(params.beforeMs));
  if (params.type) query.set("type", params.type);
  if (params.direction) query.set("direction", params.direction);
  query.set("limit", String(params.limit ?? 25));
  query.set("offset", String(params.offset ?? 0));
  return request<SearchResponse>(`/api/search?${query}`);
}

export function getSearchStatus(): Promise<{ index: SearchIndexStatus; reindex: SearchReindexProgress }> {
  return request<{ index: SearchIndexStatus; reindex: SearchReindexProgress }>("/api/search/status");
}

export function startSearchReindex(): Promise<{ ok: boolean; reindex: SearchReindexProgress }> {
  return request<{ ok: boolean; reindex: SearchReindexProgress }>("/api/search/reindex", { method: "POST", body: "{}" });
}

export function getBrainOverview(): Promise<BrainOverview> {
  return request<BrainOverview>("/api/brain/status");
}

export function brainProviderAction(body: {
  action: "enable" | "disable" | "probe" | "set-model" | "status";
  provider?: Exclude<BrainProviderName, "extractive">;
  model?: string;
}): Promise<{ ok: boolean; provider: BrainProviderStatus }> {
  return request<{ ok: boolean; provider: BrainProviderStatus }>("/api/brain/provider", {
    method: "POST",
    body: JSON.stringify(body)
  });
}
