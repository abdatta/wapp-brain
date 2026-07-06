import type {
  ChatListItem,
  ChatListOptions,
  ImportJobSummary,
  ImportMode,
  ImportRequest,
  ImportStagingFileKind,
  ImportStagingSessionSummary,
  ImportTotals,
  ImportVerificationSummary,
  LiveGapWindowRecord,
  LiveMaintainerStatusSummary,
  LivePairingSummary,
  MemoryConsolidationResult,
  MemoryCitationResolution,
  MemoryProviderStatus,
  MemoryQueryResult,
  MemoryStatusSummary,
  MessageListItem,
  MessageListOrder,
  StatusSummary
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

export function createImportSession(): Promise<{ ok: boolean; session: ImportStagingSessionSummary }> {
  return request<{ ok: boolean; session: ImportStagingSessionSummary }>("/api/import/staging", { method: "POST", body: "{}" });
}

export async function uploadImportFile(
  sessionId: string,
  kind: ImportStagingFileKind,
  file: File,
  relativePath?: string
): Promise<{ ok: boolean; session: ImportStagingSessionSummary }> {
  const query = new URLSearchParams({ name: file.name });
  if (relativePath) query.set("relativePath", relativePath);
  const response = await fetch(`/api/import/staging/${sessionId}/${kind}?${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error ?? "Could not stage selected file.");
  }
  return payload as { ok: boolean; session: ImportStagingSessionSummary };
}

export function cancelImportSession(sessionId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/import/staging/${sessionId}`, { method: "DELETE", body: "{}" });
}

export function verifyImportKey(requestBody: {
  sessionId?: string | null;
  msgstorePath?: string | null;
  waPath?: string | null;
  key?: string | null;
  keyPath?: string | null;
  useStagedKey?: boolean;
}): Promise<{ ok: boolean; verification: ImportVerificationSummary }> {
  return request<{ ok: boolean; verification: ImportVerificationSummary }>("/api/import/verify-key", {
    method: "POST",
    body: JSON.stringify(requestBody)
  });
}

export function startImportJob(requestBody: {
  sessionId?: string | null;
  mode: ImportMode;
  key?: string | null;
  keepDecrypted?: boolean;
  paths?: Partial<Pick<ImportRequest, "msgstorePath" | "waPath" | "mediaPath" | "keyPath">>;
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
