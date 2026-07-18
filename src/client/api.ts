import type {
  BrainClaimGradeRecord,
  BrainClaimGradeValue,
  BrainEvalGateVerdict,
  BrainEvalRunRecord,
  BrainGoldenSetInfo,
  BrainGradingSample,
  BrainGraphRebuildResult,
  BrainGraphRecomputeResult,
  BrainGraphStats,
  BrainModelQualityAggregate,
  BrainOverview,
  BrainProviderName,
  BrainProviderStatus,
  BrainRunProgress,
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
  MessageDetail,
  MessageListItem,
  MessageListOrder,
  OwnerIdentitySuggestion,
  OwnerSelfIdentity,
  PickKind,
  SearchIndexStatus,
  SearchReindexProgress,
  SearchResponse,
  SearchTypeFilter,
  StatusSummary,
  BackupDetectionManifest,
  WaContactsSummary,
  GoogleContactsStatus,
  GoogleContactsSyncResult,
  BrainResolutionDebtIdentity,
  IdentityRecentMessage,
  PersonAutoConnectSummary,
  PersonCompareContext,
  PersonConnectResult,
  PersonDisconnectResult,
  PersonLinkEventRecord,
  PersonLinkSuppressionRecord,
  PersonLookupResult,
  PersonRecord,
  PersonScanStatus,
  PersonSuggestionRecord,
  PersonSuggestionStatus
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
  // A 200 with a non-JSON body is the SPA fallback answering for an API route
  // the running server doesn't know — a stale server behind a newer client.
  if (payload === null) {
    throw new Error("The local server doesn't recognize this endpoint — it's likely running an older build. Restart the server and retry.");
  }
  return payload as T;
}

export function getStatus(): Promise<StatusSummary> {
  return request<StatusSummary>("/api/status");
}

export function getMessageDetail(messageId: number): Promise<MessageDetail> {
  return request<MessageDetail>(`/api/messages/${messageId}/detail`);
}

export function messageVcardDownloadUrl(messageId: number, cardIndex: number): string {
  return `/api/messages/${messageId}/vcards/${cardIndex}/download`;
}

export function getGoogleContactsStatus(): Promise<GoogleContactsStatus> {
  return request<GoogleContactsStatus>("/api/google-contacts/status");
}

export function syncGoogleContacts(): Promise<{ ok: boolean; result: GoogleContactsSyncResult; status: GoogleContactsStatus }> {
  return request("/api/google-contacts/sync", { method: "POST", body: "{}" });
}

export function disconnectGoogleContacts(): Promise<{ ok: boolean; revoked: boolean; status: GoogleContactsStatus }> {
  return request("/api/google-contacts", { method: "DELETE", body: "{}" });
}

// --- Two-level person model ---

export function listPersons(): Promise<{ persons: PersonRecord[]; scan?: PersonScanStatus | null }> {
  return request("/api/persons");
}

export function getPerson(personId: string): Promise<PersonLookupResult> {
  return request(`/api/persons/${encodeURIComponent(personId)}`);
}

export function listPersonSuggestions(status: PersonSuggestionStatus = "pending"): Promise<{ suggestions: PersonSuggestionRecord[] }> {
  return request(`/api/persons/suggestions?status=${encodeURIComponent(status)}`);
}

export function connectPersonIdentities(jidA: string, jidB: string): Promise<{ ok: boolean; result: PersonConnectResult; person: PersonRecord | null }> {
  return request("/api/persons/connect", { method: "POST", body: JSON.stringify({ jidA, jidB }) });
}

export function disconnectPersonIdentity(jid: string): Promise<{ ok: boolean; result: PersonDisconnectResult }> {
  return request("/api/persons/disconnect", { method: "POST", body: JSON.stringify({ jid }) });
}

export function acceptPersonSuggestion(id: string): Promise<{ ok: boolean; result: PersonConnectResult; person: PersonRecord | null }> {
  return request(`/api/persons/suggestions/${encodeURIComponent(id)}/accept`, { method: "POST", body: "{}" });
}

export function rejectPersonSuggestion(id: string): Promise<{ ok: boolean }> {
  return request(`/api/persons/suggestions/${encodeURIComponent(id)}/reject`, { method: "POST", body: "{}" });
}

export function runPersonScan(): Promise<{ ok: boolean; autoConnect: PersonAutoConnectSummary; detectors: { created: number; updated: number } }> {
  return request("/api/persons/scan", { method: "POST", body: "{}" });
}

export function listIdentityRecentMessages(jid: string, limit = 20): Promise<{ messages: IdentityRecentMessage[] }> {
  return request(`/api/persons/identity-messages?jid=${encodeURIComponent(jid)}&limit=${limit}`);
}

export function undoPersonDismissal(jidLow: string, jidHigh: string): Promise<{ ok: boolean; restored: number }> {
  return request("/api/persons/suggestions/undo", { method: "POST", body: JSON.stringify({ jidLow, jidHigh }) });
}

export function listPersonSuppressions(): Promise<{ suppressions: PersonLinkSuppressionRecord[] }> {
  return request("/api/persons/suppressions");
}

export function releasePersonSuppression(jidLow: string, jidHigh: string): Promise<{ ok: boolean }> {
  return request("/api/persons/suppressions/release", { method: "POST", body: JSON.stringify({ jidLow, jidHigh }) });
}

export function listPersonDebt(): Promise<{ episodesWithUnresolved: number; distinctIdentities: number; items: BrainResolutionDebtIdentity[] }> {
  return request("/api/persons/debt");
}

export function getPersonCompareContext(jidA: string, jidB: string): Promise<PersonCompareContext> {
  return request(`/api/persons/compare-context?jidA=${encodeURIComponent(jidA)}&jidB=${encodeURIComponent(jidB)}`);
}

export function personAvatarUrl(jid: string): string {
  return `/api/persons/avatar?jid=${encodeURIComponent(jid)}`;
}

export function renamePersonIdentity(
  jid: string,
  name: string
): Promise<{ ok: boolean; jid: string; name: string; repairedEpisodes: number; debtBefore: number; debtAfter: number }> {
  return request("/api/persons/rename", { method: "POST", body: JSON.stringify({ jid, name }) });
}

export function listPersonEvents(limit = 100): Promise<{ events: PersonLinkEventRecord[] }> {
  return request(`/api/persons/events?limit=${limit}`);
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

export function fetchWaContacts(requestBody: {
  waPath: string;
  key?: string | null;
  keyPath?: string | null;
}): Promise<{ ok: boolean; summary: WaContactsSummary }> {
  return request<{ ok: boolean; summary: WaContactsSummary }>("/api/wa-contacts", {
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

export function quotedSnapshotThumbnailUrl(messageId: number): string {
  return `/api/messages/${messageId}/quoted-thumbnail`;
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

export function startBrainRun(body: {
  mode: "model" | "extractive";
  model?: string | null;
  chatSourceId?: string | null;
  maxChats?: number;
  maxModelCalls?: number;
  maxTokens?: number | null;
}): Promise<{ ok: boolean; progress: BrainRunProgress }> {
  return request<{ ok: boolean; progress: BrainRunProgress }>("/api/brain/runs", { method: "POST", body: JSON.stringify(body) });
}

export function getBrainRunProgress(): Promise<BrainRunProgress> {
  return request<BrainRunProgress>("/api/brain/runs/current");
}

export function startBrainRegenerate(body: {
  model?: string | null;
  chatSourceId?: string | null;
}): Promise<{ ok: boolean; progress: BrainRunProgress }> {
  return request<{ ok: boolean; progress: BrainRunProgress }>("/api/brain/regenerate", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export function resetBrainData(): Promise<{ ok: boolean; episodesRemoved: number; watermarksReset: number; filesRemoved: number }> {
  return request<{ ok: boolean; episodesRemoved: number; watermarksReset: number; filesRemoved: number }>("/api/brain/reset", {
    method: "POST",
    body: "{}"
  });
}

// Self-number autocomplete (run console): plain substring matching over
// archived identities, each row carrying the number's CURRENT resolved name.
export function getOwnerIdentitySuggestions(query: string): Promise<OwnerIdentitySuggestion[]> {
  return request<OwnerIdentitySuggestion[]>(`/api/brain/owner/identity-suggestions?q=${encodeURIComponent(query)}`);
}

// --- Knowledge graph (knowledge-graph-foundation) ---

export function getBrainGraphStats(): Promise<BrainGraphStats> {
  return request<BrainGraphStats>("/api/brain/graph/stats");
}

export function rebuildBrainGraph(): Promise<{ ok: boolean } & BrainGraphRebuildResult> {
  return request<{ ok: boolean } & BrainGraphRebuildResult>("/api/brain/graph/rebuild", { method: "POST", body: "{}" });
}

export function recomputeBrainGraph(): Promise<{ ok: boolean } & BrainGraphRecomputeResult> {
  return request<{ ok: boolean } & BrainGraphRecomputeResult>("/api/brain/graph/recompute", { method: "POST", body: "{}" });
}

export function setBrainOwner(
  displayName: string | null,
  selfJids?: string[]
): Promise<{ ok: boolean; ownerName: string | null; selfIdentities: OwnerSelfIdentity[] }> {
  return request<{ ok: boolean; ownerName: string | null; selfIdentities: OwnerSelfIdentity[] }>("/api/brain/owner", {
    method: "POST",
    body: JSON.stringify(selfJids ? { displayName, selfJids } : { displayName })
  });
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

// --- Brain eval harness ---

export function getBrainEvalGolden(): Promise<{
  ok: boolean;
  path: string;
  exists: boolean;
  info: BrainGoldenSetInfo | null;
  error?: string;
}> {
  return request("/api/brain/eval/golden");
}

export function scaffoldBrainEvalGolden(): Promise<{ ok: boolean; info: BrainGoldenSetInfo }> {
  return request("/api/brain/eval/golden/scaffold", { method: "POST", body: "{}" });
}

export function runBrainEval(body?: { notes?: string | null; baselineId?: string | null }): Promise<{
  ok: boolean;
  run: BrainEvalRunRecord;
  baseline: BrainEvalRunRecord | null;
  gate: BrainEvalGateVerdict;
}> {
  return request("/api/brain/eval/runs", { method: "POST", body: JSON.stringify(body ?? {}) });
}

export function listBrainEvalRuns(options?: { goldenHash?: string; limit?: number }): Promise<BrainEvalRunRecord[]> {
  const params = new URLSearchParams();
  if (options?.goldenHash) params.set("goldenHash", options.goldenHash);
  if (options?.limit) params.set("limit", String(options.limit));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return request(`/api/brain/eval/runs${suffix}`);
}

export function getBrainEvalGate(options?: { runId?: string; baselineId?: string }): Promise<{
  ok: boolean;
  run: BrainEvalRunRecord;
  baseline: BrainEvalRunRecord | null;
  gate: BrainEvalGateVerdict;
}> {
  const params = new URLSearchParams();
  if (options?.runId) params.set("runId", options.runId);
  if (options?.baselineId) params.set("baselineId", options.baselineId);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return request(`/api/brain/eval/gate${suffix}`);
}

export function getBrainGradingSample(options?: { perModel?: number; includeGraded?: boolean }): Promise<BrainGradingSample> {
  const params = new URLSearchParams();
  if (options?.perModel) params.set("perModel", String(options.perModel));
  if (options?.includeGraded) params.set("includeGraded", "1");
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return request(`/api/brain/eval/grading-sample${suffix}`);
}

export function gradeBrainClaim(claimId: string, grade: BrainClaimGradeValue): Promise<{ ok: boolean; grade: BrainClaimGradeRecord }> {
  return request("/api/brain/eval/grades", { method: "POST", body: JSON.stringify({ claimId, grade }) });
}

export function getBrainModelQuality(): Promise<BrainModelQualityAggregate[]> {
  return request("/api/brain/eval/aggregates");
}
