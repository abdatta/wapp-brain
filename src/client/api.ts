import type {
  BrainClaimGradeRecord,
  BrainClaimGradeValue,
  BrainDocDetail,
  BrainDocsListResponse,
  BrainDocsListView,
  BrainEvalGateVerdict,
  BrainEvalRunRecord,
  BrainGoldenSetInfo,
  BrainGradingSample,
  BrainBackfillStatus,
  BrainGraphEdgeEvidenceView,
  BrainGraphEntityView,
  BrainGraphNeighborhoodParams,
  BrainGraphNeighborhoodView,
  BrainGraphRebuildResult,
  BrainGraphRecomputeResult,
  BrainGraphStats,
  BrainLifecycleItemDetail,
  BrainLifecycleListResponse,
  BrainLifecycleSort,
  BrainReasoningEffort,
  BrainGraphUnresolvedEntity,
  BrainGraphNodeSuggestion,
  BrainModelQualityAggregate,
  BrainOverview,
  BrainQualitySummary,
  BrainProviderName,
  BrainProviderStatus,
  BrainRunEffects,
  BrainRunListItem,
  BrainRunProgress,
  BrainRunSummary,
  BrainEpisodeRecord,
  BrainMuteProgress,
  BrainMutedListResponse,
  ChatListItem,
  ChatListOptions,
  ChatMuteState,
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
  if (params.muted != null) query.set("muted", String(params.muted));
  if (params.ids?.length) query.set("ids", params.ids.join(","));
  query.set("limit", String(params.limit ?? 60));
  query.set("offset", String(params.offset ?? 0));
  return request<ChatListItem[]>(`/api/chats?${query}`);
}

// Resolve one chat regardless of the browsing filters. The open chat's header
// must not degrade to "Unresolved contact" because a filter stopped including
// it — or because it was deep-linked before any list loaded.
export async function getChatById(chatId: number): Promise<ChatListItem | null> {
  const [chat] = await listChats({ ids: [chatId], limit: 1, offset: 0 });
  return chat ?? null;
}

// --- Chat brain muting (mute-chats-from-brain) ---
// Muting stops BRAIN processing only — the chat keeps archiving every message
// and media blob, and reads identically in the chats UI and search. All
// filtering happens server-side; nothing here decides what is hidden.

// Mute state is durable the moment these return, but the vault reconcile runs
// behind them. This event lets the shell's progress indicator react on the
// action rather than on its next poll, so the user always sees an
// acknowledgement — polling alone would miss jobs that finish in ~100ms.
export const MUTE_CHANGED_EVENT = "wapp:mute-changed";

function announceMuteChange(): void {
  window.dispatchEvent(new CustomEvent(MUTE_CHANGED_EVENT));
}

// The route accepts either the numeric chat id the chat surfaces hold or the
// canonical JID the brain surfaces hold, so neither caller has to translate.
// `fromMs` omitted means "from now"; "epoch" is the entire-history preset.
export async function muteChat(chat: number | string, fromMs?: number | "epoch"): Promise<ChatMuteState> {
  const state = await request<ChatMuteState>(`/api/chats/${encodeURIComponent(String(chat))}/mute`, {
    method: "POST",
    body: JSON.stringify(fromMs == null ? {} : { fromMs })
  });
  announceMuteChange();
  return state;
}

export async function unmuteChat(chat: number | string, fromMs?: number | "epoch"): Promise<ChatMuteState> {
  const state = await request<ChatMuteState>(`/api/chats/${encodeURIComponent(String(chat))}/unmute`, {
    method: "POST",
    body: JSON.stringify(fromMs == null ? {} : { fromMs })
  });
  announceMuteChange();
  return state;
}

export function getChatMuteState(chat: number | string): Promise<ChatMuteState> {
  return request<ChatMuteState>(`/api/chats/${encodeURIComponent(String(chat))}/mute`);
}

// Every muted chat with what muting is saving (piled-up since the frozen
// watermark) and what it hid — all derived server-side, never stored counters.
export function listMutedChats(): Promise<BrainMutedListResponse> {
  return request<BrainMutedListResponse>("/api/brain/muted");
}

// Cheap enough to poll: it reads in-process queue state, touching no tables.
export function getMuteProgress(): Promise<BrainMuteProgress> {
  return request<BrainMuteProgress>("/api/brain/mute/progress");
}

// Episodes for a chat. `onlyMuted` inverts the hiding so the muted-items view
// can show exactly what muting hid.
export function listBrainEpisodes(
  params: { chatSourceId?: string | null; onlyMuted?: boolean; limit?: number } = {}
): Promise<BrainEpisodeRecord[]> {
  const query = new URLSearchParams();
  if (params.chatSourceId) query.set("chatSourceId", params.chatSourceId);
  if (params.onlyMuted) query.set("onlyMuted", "true");
  if (params.limit != null) query.set("limit", String(params.limit));
  const suffix = query.toString();
  return request<BrainEpisodeRecord[]>(`/api/brain/episodes${suffix ? `?${suffix}` : ""}`);
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

// The hot poll: what the shell renders, refreshed on every archive change.
export function getBrainOverview(): Promise<BrainOverview> {
  return request<BrainOverview>("/api/brain/status");
}

// The cold dashboard: full-population quality aggregates, fetched only by the
// surface that displays them so navigating elsewhere never pays for them.
export function getBrainQuality(): Promise<BrainQualitySummary> {
  return request<BrainQualitySummary>("/api/brain/quality");
}

export function startBrainRun(body: {
  mode: "model" | "extractive";
  model?: string | null;
  chatSourceId?: string | null;
  maxChats?: number;
  maxModelCalls?: number;
  maxTokens?: number | null;
  // Historical backfill: drain the full uncovered queue with optional turbo
  // pacing overrides, strict mode, and the sliding worker pool width.
  backfill?: boolean;
  callsPerHour?: number | null;
  callsPerDay?: number | null;
  strict?: boolean;
  concurrency?: number | null;
}): Promise<{ ok: boolean; progress: BrainRunProgress }> {
  return request<{ ok: boolean; progress: BrainRunProgress }>("/api/brain/runs", { method: "POST", body: JSON.stringify(body) });
}

// Run history and the per-run audit (what a run durably changed, including
// effects outside the artifact it was asked to produce).
export function listBrainRuns(params: { kind?: string; docId?: string; limit?: number } = {}): Promise<{ runs: BrainRunListItem[] }> {
  const query = new URLSearchParams();
  if (params.kind) query.set("kind", params.kind);
  if (params.docId) query.set("doc", params.docId);
  if (params.limit != null) query.set("limit", String(params.limit));
  const suffix = query.toString();
  return request<{ runs: BrainRunListItem[] }>(`/api/brain/runs${suffix ? `?${suffix}` : ""}`);
}

export function getBrainRunEffects(runId: string): Promise<BrainRunEffects> {
  return request<BrainRunEffects>(`/api/brain/runs/${encodeURIComponent(runId)}/effects`);
}

export function getBrainRunProgress(): Promise<BrainRunProgress> {
  return request<BrainRunProgress>("/api/brain/runs/current");
}

// Cooperative stop: the run loop checks a flag between packs and ends as
// 'interrupted' — committed episodes and advanced coverage are kept.
export function cancelBrainRun(): Promise<{ ok: boolean; cancelling: boolean; progress: BrainRunProgress }> {
  return request<{ ok: boolean; cancelling: boolean; progress: BrainRunProgress }>("/api/brain/runs/cancel", {
    method: "POST",
    body: "{}"
  });
}

export function startBrainRegenerate(body: {
  model?: string | null;
  chatSourceId?: string | null;
  // The backfill dashboard's "sweep the fallbacks": extractive episodes only.
  onlyExtractive?: boolean;
  // Pack-size scope: regenerate only episodes of at most this many messages —
  // targeted re-derivation instead of the whole stale archive.
  maxMessages?: number | null;
  // Turbo pacing (the sweep can be thousands of episodes): sliding worker pool
  // width and per-run ledger overrides, mirroring backfill.
  concurrency?: number | null;
  callsPerHour?: number | null;
  callsPerDay?: number | null;
}): Promise<{ ok: boolean; progress: BrainRunProgress }> {
  return request<{ ok: boolean; progress: BrainRunProgress }>("/api/brain/regenerate", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

// Scoped-count preview: same selection the run would use, spending nothing.
export function dryRunBrainRegenerate(body: {
  chatSourceId?: string | null;
  onlyExtractive?: boolean;
  maxMessages?: number | null;
}): Promise<{ ok: boolean; dryRun: true; episodes: number }> {
  return request<{ ok: boolean; dryRun: true; episodes: number }>("/api/brain/regenerate", {
    method: "POST",
    body: JSON.stringify({ ...body, dryRun: true })
  });
}

// Backfill dashboard DTO (historical-backfill): server-computed coverage,
// queue, drain rate, ETA, spend, and the fallback canary.
export function getBrainBackfillStatus(): Promise<BrainBackfillStatus> {
  return request<BrainBackfillStatus>("/api/brain/backfill/status");
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

// --- Commitment lifecycle (commitment-lifecycle) ---

// The L0 open-items surface: status-driven, salience-independent, flagged and
// ordered server-side. `flag` narrows the open set to overdue/stale/sweep-due;
// `sort` picks the ordering (default 'smart' = the pinned overdue-first order).
export function listBrainLifecycleItems(params: {
  status?: "open" | "fulfilled" | "dismissed" | "all" | "closed";
  flag?: "overdue" | "stale" | "sweep_due";
  hideOverdue?: boolean;
  hideStale?: boolean;
  hideFulfilled?: boolean;
  hideDismissed?: boolean;
  dueUpcoming?: boolean;
  kind?: "commitment" | "question";
  includeChats?: string[];
  excludeChats?: string[];
  sort?: BrainLifecycleSort;
  chatSourceId?: string | null;
  onlyMuted?: boolean;
  limit?: number;
} = {}): Promise<BrainLifecycleListResponse> {
  const query = new URLSearchParams();
  if (params.status) query.set("status", params.status);
  if (params.flag) query.set("flag", params.flag);
  if (params.hideOverdue) query.set("hideOverdue", "true");
  if (params.hideStale) query.set("hideStale", "true");
  if (params.hideFulfilled) query.set("hideFulfilled", "true");
  if (params.hideDismissed) query.set("hideDismissed", "true");
  if (params.dueUpcoming) query.set("dueUpcoming", "true");
  if (params.onlyMuted) query.set("onlyMuted", "true");
  if (params.kind) query.set("kind", params.kind);
  if (params.includeChats && params.includeChats.length > 0) query.set("includeChats", params.includeChats.join(","));
  if (params.excludeChats && params.excludeChats.length > 0) query.set("excludeChats", params.excludeChats.join(","));
  if (params.sort) query.set("sort", params.sort);
  if (params.chatSourceId) query.set("chatSourceId", params.chatSourceId);
  if (params.limit != null) query.set("limit", String(params.limit));
  const suffix = query.toString();
  return request<BrainLifecycleListResponse>(`/api/brain/lifecycle${suffix ? `?${suffix}` : ""}`);
}

// Full context for one item (the detail modal).
export function getBrainLifecycleItemDetail(claimId: string): Promise<BrainLifecycleItemDetail> {
  return request<BrainLifecycleItemDetail>(`/api/brain/lifecycle/item?claimId=${encodeURIComponent(claimId)}`);
}

// User transition (certainty-grade): close/cancel/reopen with an optional note.
export function applyBrainLifecycleTransition(body: {
  claimId: string;
  action: "fulfilled" | "dismissed" | "reopened";
  note?: string | null;
}): Promise<{ ok: boolean; applied: number }> {
  return request<{ ok: boolean; applied: number }>("/api/brain/lifecycle/transition", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

// Manual-first model closure sweep over sweep-due open items, or exactly the
// `claimIds` selected (a specific item or a subset).
export function startBrainLifecycleSweep(body: {
  chatSourceId?: string | null;
  claimIds?: string[] | null;
  model?: string | null;
  effort?: BrainReasoningEffort | null;
  maxModelCalls?: number | null;
  maxTokens?: number | null;
}): Promise<{ ok: boolean; progress: BrainRunProgress }> {
  return request<{ ok: boolean; progress: BrainRunProgress }>("/api/brain/lifecycle/sweep", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

// --- Semantic docs (semantic-rollups) ---

// Docs list: existing docs AND page-eligible nodes without a doc yet, with
// deterministic dueness and counts computed server-side.
export function listBrainDocs(
  params: { kind?: "entity" | "topic" | "chat"; view?: BrainDocsListView; onlyMuted?: boolean; limit?: number } = {}
): Promise<BrainDocsListResponse> {
  const query = new URLSearchParams();
  if (params.kind) query.set("kind", params.kind);
  if (params.view && params.view !== "all") query.set("view", params.view);
  if (params.onlyMuted) query.set("onlyMuted", "true");
  if (params.limit != null) query.set("limit", String(params.limit));
  const suffix = query.toString();
  return request<BrainDocsListResponse>(`/api/brain/docs${suffix ? `?${suffix}` : ""}`);
}

// One doc resolved for display (rendered markdown + structured sections with
// thread coordinates + history + issues). Follows merged redirects.
export function getBrainDoc(docId: string): Promise<BrainDocDetail> {
  return request<BrainDocDetail>(`/api/brain/docs/${encodeURIComponent(docId)}`);
}

// Mechanical rollback to a prior revision; the page file re-renders.
export function rollbackBrainDoc(docId: string, toRevision?: number | null): Promise<BrainDocDetail> {
  return request<BrainDocDetail>(`/api/brain/docs/${encodeURIComponent(docId)}/rollback`, {
    method: "POST",
    body: JSON.stringify(toRevision != null ? { toRevision } : {})
  });
}

// Manual-first semantic rollup run: one doc, a list, or the top-K due docs.
export function startBrainRollupRun(body: {
  docId?: string | null;
  nodeId?: string | null;
  docIds?: string[] | null;
  maxDocs?: number | null;
  model?: string | null;
  effort?: BrainReasoningEffort | null;
  maxModelCalls?: number | null;
  maxTokens?: number | null;
}): Promise<{ ok: boolean; progress: BrainRunProgress }> {
  return request<{ ok: boolean; progress: BrainRunProgress }>("/api/brain/rollups/run", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

// Rebuild the deterministic vault projection (pages + overview) — zero model calls.
export function rebuildBrainProjection(): Promise<{ written: number; unchanged: number; removed: number }> {
  return request<{ written: number; unchanged: number; removed: number }>("/api/brain/project", { method: "POST" });
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

// --- Graph explorer (graph-explorer) ---

// Bounded anchored neighborhood — the explorer's product primitive.
export function getBrainGraphNeighborhood(params: BrainGraphNeighborhoodParams): Promise<BrainGraphNeighborhoodView> {
  const query = new URLSearchParams();
  if (params.nodeId) query.set("nodeId", params.nodeId);
  if (params.jid) query.set("jid", params.jid);
  if (params.name) query.set("name", params.name);
  if (params.chat) query.set("chat", params.chat);
  if (params.depth != null) query.set("depth", String(params.depth));
  if (params.kinds && params.kinds.length > 0) query.set("kinds", params.kinds.join(","));
  if (params.since != null) query.set("since", String(params.since));
  if (params.until != null) query.set("until", String(params.until));
  if (params.minSalience != null) query.set("minSalience", String(params.minSalience));
  if (params.includeDormant) query.set("includeDormant", "true");
  if (params.maxNodes != null) query.set("maxNodes", String(params.maxNodes));
  if (params.maxEdges != null) query.set("maxEdges", String(params.maxEdges));
  return request<BrainGraphNeighborhoodView>(`/api/brain/graph/neighborhood?${query.toString()}`);
}

// Lazy per-edge evidence: claims + citations with thread-anchor coordinates.
export function getBrainGraphEdgeEvidence(edgeId: number): Promise<BrainGraphEdgeEvidenceView> {
  return request<BrainGraphEdgeEvidenceView>(`/api/brain/graph/edge?id=${encodeURIComponent(String(edgeId))}`);
}

export function getBrainGraphEntity(query: { nodeId?: string; jid?: string; name?: string }): Promise<BrainGraphEntityView> {
  const params = new URLSearchParams();
  if (query.nodeId) params.set("nodeId", query.nodeId);
  if (query.jid) params.set("jid", query.jid);
  if (query.name) params.set("name", query.name);
  return request<BrainGraphEntityView>(`/api/brain/graph/entity?${params.toString()}`);
}

export function listUnresolvedBrainGraphEntities(limit = 50): Promise<BrainGraphUnresolvedEntity[]> {
  return request<BrainGraphUnresolvedEntity[]>(`/api/brain/graph/unresolved?limit=${limit}`);
}

// Typeahead for anchoring the explorer — resolves to real node ids so a picked
// anchor is never an ambiguous free-text name.
export function searchBrainGraphNodes(query: string, limit = 10): Promise<BrainGraphNodeSuggestion[]> {
  const trimmed = query.trim();
  if (!trimmed) return Promise.resolve([]);
  return request<BrainGraphNodeSuggestion[]>(
    `/api/brain/graph/search?q=${encodeURIComponent(trimmed)}&limit=${limit}`
  );
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
