import type {
  ArchiveRepository,
  ArchiveRestorePoint
} from "./repository";
import type {
  ChatListItem,
  ChatListOptions,
  ChatRecord,
  ContactRecord,
  ImportRunSummary,
  ImportTotals,
  ImportWarning,
  LiveChatCheckpointRecord,
  LiveEventReceiptRecord,
  LiveGapStatus,
  LiveGapWindowRecord,
  LiveMaintainerStatusSummary,
  LiveMessageUpdateRecord,
  LiveMessageUpdateResult,
  LiveSessionSummary,
  LiveSyncRunSummary,
  LiveSyncTotals,
  MemoryCitationRecord,
  MemoryEvidenceMessage,
  MemoryEvidencePackRecord,
  MemoryPageRevisionRecord,
  MemoryProviderStatus,
  MemoryRunSummary,
  MemorySourceWindowRecord,
  MemoryStatusSummary,
  MemoryValidationIssue,
  MessageListItem,
  MessageRecord,
  ParticipantRecord,
  StatusSummary
} from "../../shared/types";
import { config } from "../config";
import { baselineFromStatus } from "../live/baseline";
import { getMemoryProviderStatus } from "../memory/provider";

export class MemoryArchiveRepository implements ArchiveRepository {
  private importRuns = new Map<string, ImportRunSummary>();
  private warnings: ImportWarning[] = [];
  private contacts = new Map<string, ContactRecord & { id: number }>();
  private chats = new Map<string, ChatRecord & { id: number; messageCount: number; participantCount: number; lastMessageAt: string | null }>();
  private participants = new Map<string, ParticipantRecord>();
  private messages = new Map<string, MessageRecord & { id: number }>();
  private liveSession: LiveSessionSummary | null = null;
  private liveRuns = new Map<string, LiveSyncRunSummary>();
  private liveCheckpoints = new Map<string, LiveChatCheckpointRecord>();
  private liveGaps = new Map<number, LiveGapWindowRecord & { id: number; createdAt: string; updatedAt: string }>();
  private liveReceipts = new Map<string, LiveEventReceiptRecord>();
  private liveUpdates = new Map<string, LiveMessageUpdateRecord>();
  private memoryRuns = new Map<string, MemoryRunSummary>();
  private memoryWindows = new Map<string, MemorySourceWindowRecord>();
  private memoryPacks = new Map<string, MemoryEvidencePackRecord>();
  private memoryRevisions = new Map<string, MemoryPageRevisionRecord>();
  private memoryPages = new Map<string, { pageId: string; title: string; path: string; status: "current" | "stale"; currentRevisionId: string | null }>();
  private memoryCitations: MemoryCitationRecord[] = [];
  private memoryIssues: MemoryValidationIssue[] = [];
  private memoryLockRunId: string | null = null;
  private nextContactId = 1;
  private nextChatId = 1;
  private nextMessageId = 1;
  private nextLiveGapId = 1;

  async createRestorePoint(_label: string): Promise<ArchiveRestorePoint> {
    const snapshot = {
      importRuns: cloneMap(this.importRuns),
      warnings: structuredClone(this.warnings),
      contacts: cloneMap(this.contacts),
      chats: cloneMap(this.chats),
      participants: cloneMap(this.participants),
      messages: cloneMap(this.messages),
      liveSession: structuredClone(this.liveSession),
      liveRuns: cloneMap(this.liveRuns),
      liveCheckpoints: cloneMap(this.liveCheckpoints),
      liveGaps: cloneMap(this.liveGaps),
      liveReceipts: cloneMap(this.liveReceipts),
      liveUpdates: cloneMap(this.liveUpdates),
      memoryRuns: cloneMap(this.memoryRuns),
      memoryWindows: cloneMap(this.memoryWindows),
      memoryPacks: cloneMap(this.memoryPacks),
      memoryRevisions: cloneMap(this.memoryRevisions),
      memoryPages: cloneMap(this.memoryPages),
      memoryCitations: structuredClone(this.memoryCitations),
      memoryIssues: structuredClone(this.memoryIssues),
      memoryLockRunId: this.memoryLockRunId,
      nextContactId: this.nextContactId,
      nextChatId: this.nextChatId,
      nextMessageId: this.nextMessageId,
      nextLiveGapId: this.nextLiveGapId
    };
    return {
      restore: async () => {
        this.importRuns = cloneMap(snapshot.importRuns);
        this.warnings = structuredClone(snapshot.warnings);
        this.contacts = cloneMap(snapshot.contacts);
        this.chats = cloneMap(snapshot.chats);
        this.participants = cloneMap(snapshot.participants);
        this.messages = cloneMap(snapshot.messages);
        this.liveSession = structuredClone(snapshot.liveSession);
        this.liveRuns = cloneMap(snapshot.liveRuns);
        this.liveCheckpoints = cloneMap(snapshot.liveCheckpoints);
        this.liveGaps = cloneMap(snapshot.liveGaps);
        this.liveReceipts = cloneMap(snapshot.liveReceipts);
        this.liveUpdates = cloneMap(snapshot.liveUpdates);
        this.memoryRuns = cloneMap(snapshot.memoryRuns);
        this.memoryWindows = cloneMap(snapshot.memoryWindows);
        this.memoryPacks = cloneMap(snapshot.memoryPacks);
        this.memoryRevisions = cloneMap(snapshot.memoryRevisions);
        this.memoryPages = cloneMap(snapshot.memoryPages);
        this.memoryCitations = structuredClone(snapshot.memoryCitations);
        this.memoryIssues = structuredClone(snapshot.memoryIssues);
        this.memoryLockRunId = snapshot.memoryLockRunId;
        this.nextContactId = snapshot.nextContactId;
        this.nextChatId = snapshot.nextChatId;
        this.nextMessageId = snapshot.nextMessageId;
        this.nextLiveGapId = snapshot.nextLiveGapId;
      },
      dispose: async () => undefined
    };
  }

  async startImportRun(_sourceSummary: Record<string, unknown> = {}): Promise<string> {
    const id = crypto.randomUUID();
    this.importRuns.set(id, {
      id,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      totals: emptyTotals(),
      warningCount: 0
    });
    return id;
  }

  async completeImportRun(runId: string, totals: ImportTotals, warningCount: number): Promise<void> {
    const run = this.importRuns.get(runId);
    if (run) {
      run.status = "completed";
      run.finishedAt = new Date().toISOString();
      run.totals = totals;
      run.warningCount = warningCount;
    }
  }

  async failImportRun(runId: string, _code: string, message: string, totals = emptyTotals(), warningCount = 0): Promise<void> {
    const run = this.importRuns.get(runId);
    if (run) {
      run.status = "failed";
      run.finishedAt = new Date().toISOString();
      run.totals = totals;
      run.warningCount = warningCount;
      run.errorMessage = message;
    }
  }

  async addWarnings(_runId: string, warnings: ImportWarning[]): Promise<void> {
    this.warnings.push(...warnings);
  }

  async upsertContacts(_runId: string, contacts: ContactRecord[]): Promise<Map<string, number>> {
    for (const contact of contacts) {
      const existing = this.contacts.get(contact.sourceJid);
      this.contacts.set(contact.sourceJid, {
        ...existing,
        ...contact,
        displayName: contact.displayName || existing?.displayName || null,
        id: existing?.id ?? this.nextContactId++
      });
      const chat = this.chats.get(contact.sourceJid);
      const displayName = contact.displayName?.trim();
      const pushName = contact.pushName?.trim();
      if (chat && displayName && (chat.chatType === "dm" || chat.chatType === "unknown")) {
        chat.displayName = displayName;
      } else if (chat && pushName && (chat.chatType === "dm" || chat.chatType === "unknown") && isIdentityDisplayName(chat)) {
        chat.displayName = pushName;
      }
    }
    return new Map([...this.contacts].map(([jid, contact]) => [jid, contact.id]));
  }

  async upsertChats(_runId: string, chats: ChatRecord[]): Promise<Map<string, number>> {
    for (const chat of chats) {
      const existing = this.chats.get(chat.sourceChatId);
      this.chats.set(chat.sourceChatId, {
        ...existing,
        ...chat,
        displayName: chat.displayName || existing?.displayName || chat.jid,
        chatType: chat.chatType === "unknown" && existing ? existing.chatType : chat.chatType,
        id: existing?.id ?? this.nextChatId++,
        messageCount: existing?.messageCount ?? 0,
        participantCount: existing?.participantCount ?? 0,
        lastMessageAt: existing?.lastMessageAt ?? null
      });
    }
    return new Map([...this.chats].map(([sourceChatId, chat]) => [sourceChatId, chat.id]));
  }

  async upsertParticipants(participants: ParticipantRecord[]): Promise<number> {
    for (const participant of participants) {
      this.participants.set(`${participant.chatSourceId}\u0000${participant.sourceJid}`, participant);
    }
    return participants.length;
  }

  async upsertMessages(messages: MessageRecord[]): Promise<number> {
    for (const message of messages) {
      const existing = this.messages.get(message.sourceMessageKey);
      this.messages.set(message.sourceMessageKey, {
        ...existing,
        ...message,
        id: existing?.id ?? this.nextMessageId++
      });
    }
    return messages.length;
  }

  async refreshChatStats(): Promise<void> {
    for (const chat of this.chats.values()) {
      const messages = [...this.messages.values()].filter((message) => message.chatSourceId === chat.sourceChatId);
      chat.messageCount = messages.length;
      chat.participantCount = [...this.participants.values()].filter((participant) => participant.chatSourceId === chat.sourceChatId).length;
      const last = messages
        .map((message) => message.timestampMs ?? 0)
        .filter(Boolean)
        .sort((a, b) => b - a)[0];
      chat.lastMessageAt = last ? new Date(last).toISOString() : null;
    }
  }

  async clearArchiveData(): Promise<void> {
    this.importRuns.clear();
    this.warnings = [];
    this.contacts.clear();
    this.chats.clear();
    this.participants.clear();
    this.messages.clear();
    this.liveRuns.clear();
    this.liveCheckpoints.clear();
    this.liveGaps.clear();
    this.liveReceipts.clear();
    this.liveUpdates.clear();
    this.liveSession = null;
    this.nextContactId = 1;
    this.nextChatId = 1;
    this.nextMessageId = 1;
    this.nextLiveGapId = 1;
  }

  async getStatus(): Promise<StatusSummary> {
    const latestImport = [...this.importRuns.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
    return {
      database: { configured: true, initialized: true, adapter: "memory" },
      counts: {
        chats: this.chats.size,
        contacts: this.contacts.size,
        participants: this.participants.size,
        messages: this.messages.size,
        warnings: this.warnings.length
      },
      latestImport,
      latestWarnings: this.warnings.slice(-8).reverse(),
      live: await this.getLiveStatus(),
      memory: await this.getMemoryStatus(await getMemoryProviderStatus())
    };
  }

  async upsertLiveSession(session: Partial<LiveSessionSummary> & { id: string; status: LiveSessionSummary["status"]; clientName: string }): Promise<void> {
    const now = new Date().toISOString();
    this.liveSession = {
      id: session.id,
      status: session.status,
      clientName: session.clientName,
      linkedDeviceJid: session.linkedDeviceJid ?? this.liveSession?.linkedDeviceJid ?? null,
      lastConnectedAt: session.lastConnectedAt ?? this.liveSession?.lastConnectedAt ?? null,
      lastDisconnectedAt: session.lastDisconnectedAt ?? this.liveSession?.lastDisconnectedAt ?? null,
      lastError: session.lastError ?? this.liveSession?.lastError ?? null,
      createdAt: session.createdAt ?? this.liveSession?.createdAt ?? now,
      updatedAt: now
    };
  }

  async startLiveSyncRun(): Promise<string> {
    const id = crypto.randomUUID();
    this.liveRuns.set(id, {
      id,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      totals: emptyLiveTotals(),
      warningCount: 0
    });
    return id;
  }

  async completeLiveSyncRun(runId: string, totals: LiveSyncTotals, warningCount: number): Promise<void> {
    const run = this.liveRuns.get(runId);
    if (run) {
      run.status = "completed";
      run.finishedAt = new Date().toISOString();
      run.totals = totals;
      run.warningCount = warningCount;
    }
  }

  async failLiveSyncRun(runId: string, _code: string, message: string, totals = emptyLiveTotals(), warningCount = 0): Promise<void> {
    const run = this.liveRuns.get(runId);
    if (run) {
      run.status = "failed";
      run.finishedAt = new Date().toISOString();
      run.totals = totals;
      run.warningCount = warningCount;
      run.errorMessage = message;
    }
  }

  async upsertLiveCheckpoint(checkpoint: LiveChatCheckpointRecord): Promise<void> {
    this.liveCheckpoints.set(checkpoint.chatSourceId, { ...checkpoint });
  }

  async listLiveCheckpoints(): Promise<LiveChatCheckpointRecord[]> {
    return [...this.liveCheckpoints.values()];
  }

  async upsertLiveGap(gap: LiveGapWindowRecord): Promise<number> {
    const now = new Date().toISOString();
    const id = gap.id ?? this.nextLiveGapId++;
    this.liveGaps.set(id, {
      ...gap,
      id,
      createdAt: gap.createdAt ?? this.liveGaps.get(id)?.createdAt ?? now,
      updatedAt: now
    });
    return id;
  }

  async updateLiveGapStatus(id: number, status: LiveGapStatus, notes?: string | null): Promise<void> {
    const gap = this.liveGaps.get(id);
    if (gap) {
      gap.status = status;
      gap.notes = notes ?? gap.notes ?? null;
      gap.updatedAt = new Date().toISOString();
    }
  }

  async listLiveGaps(statuses?: LiveGapStatus[]): Promise<LiveGapWindowRecord[]> {
    const allowed = statuses?.length ? new Set(statuses) : null;
    return [...this.liveGaps.values()].filter((gap) => !allowed || allowed.has(gap.status));
  }

  async recordLiveEventReceipt(receipt: LiveEventReceiptRecord): Promise<void> {
    this.liveReceipts.set(receipt.eventKey, { ...receipt, processedAt: receipt.processedAt ?? new Date().toISOString() });
  }

  async hasLiveEventReceipt(eventKey: string): Promise<boolean> {
    return this.liveReceipts.has(eventKey);
  }

  async applyLiveMessageUpdates(updates: Array<Omit<LiveMessageUpdateRecord, "applied">>): Promise<LiveMessageUpdateResult> {
    let applied = 0;
    let pending = 0;
    for (const update of updates) {
      const message = this.messages.get(update.sourceMessageKey);
      if (message) {
        if (update.updateType === "delete") {
          message.isDeleted = true;
          message.body = null;
          message.caption = null;
        }
        if (update.updateType === "edit" && typeof update.metadata?.body === "string") {
          message.body = update.metadata.body;
        }
        applied += 1;
      } else {
        pending += 1;
      }
      this.liveUpdates.set(update.eventKey, { ...update, applied: Boolean(message) });
    }
    return { applied, pending };
  }

  async getLiveStatus(): Promise<LiveMaintainerStatusSummary> {
    const currentRun = [...this.liveRuns.values()].filter((run) => run.status === "running").sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
    const openGaps = await this.listLiveGaps(["open", "retrying", "uncertain", "needs_user_action"]);
    return {
      enabled: Boolean(this.liveSession),
      baseline: baselineFromStatus(await this.getStatusWithoutLive(), this.latestChatMessageAt(), config.live.maxBackfillPerChatDays),
      session: this.liveSession,
      currentRun,
      totals: currentRun?.totals ?? emptyLiveTotals(),
      openGapCount: openGaps.length,
      chatHealth: [...this.liveCheckpoints.values()].map((checkpoint) => {
        const chat = this.chats.get(checkpoint.chatSourceId);
        const chatOpenGaps = openGaps.filter((gap) => gap.chatSourceId === checkpoint.chatSourceId);
        return {
          chatSourceId: checkpoint.chatSourceId,
          chatDisplayName: chat?.displayName ?? null,
          health: checkpoint.health,
          latestArchivedAt: checkpoint.latestArchivedAtMs ? new Date(checkpoint.latestArchivedAtMs).toISOString() : null,
          latestLiveAt: checkpoint.latestLiveAtMs ? new Date(checkpoint.latestLiveAtMs).toISOString() : null,
          oldestVerifiedAt: checkpoint.oldestVerifiedAtMs ? new Date(checkpoint.oldestVerifiedAtMs).toISOString() : null,
          openGapCount: chatOpenGaps.length,
          nextRecoveryAt: checkpoint.nextRecoveryAt ?? null
        };
      })
    };
  }

  private async getStatusWithoutLive(): Promise<StatusSummary> {
    const latestImport = [...this.importRuns.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
    return {
      database: { configured: true, initialized: true, adapter: "memory" },
      counts: {
        chats: this.chats.size,
        contacts: this.contacts.size,
        participants: this.participants.size,
        messages: this.messages.size,
        warnings: this.warnings.length
      },
      latestImport,
      latestWarnings: this.warnings.slice(-8).reverse()
    };
  }

  private latestChatMessageAt(): string | null {
    const latest = [...this.chats.values()]
      .map((chat) => chat.lastMessageAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1);
    return latest ?? null;
  }

  async listChats(options: ChatListOptions): Promise<ChatListItem[]> {
    const search = options.search?.toLowerCase();
    return [...this.chats.values()]
      .filter((chat) => !search || chat.displayName?.toLowerCase().includes(search) || chat.jid.toLowerCase().includes(search))
      .filter((chat) => !options.type || options.type === "all" || chat.chatType === options.type)
      .filter((chat) => options.includeEventOnly || this.hasVisibleExchange(chat.sourceChatId))
      .sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""))
      .slice(options.offset, options.offset + options.limit)
      .map((chat) => ({
        id: chat.id,
        sourceChatId: chat.sourceChatId,
        jid: chat.jid,
        displayName: chat.displayName || chat.jid,
        chatType: chat.chatType,
        messageCount: chat.messageCount,
        participantCount: chat.participantCount,
        lastMessageAt: chat.lastMessageAt
      }));
  }

  async listMessages(
    chatId: number,
    options: { limit: number; offset: number; sender?: string; query?: string; order?: "asc" | "desc" }
  ): Promise<MessageListItem[]> {
    const chat = [...this.chats.values()].find((candidate) => candidate.id === chatId);
    if (!chat) {
      return [];
    }
    const query = options.query?.toLowerCase();
    return [...this.messages.values()]
      .filter((message) => message.chatSourceId === chat.sourceChatId)
      .filter((message) => !options.sender || message.senderSourceJid === options.sender)
      .filter((message) => !query || message.body?.toLowerCase().includes(query) || message.caption?.toLowerCase().includes(query))
      .sort((a, b) => {
        const ascending = (a.timestampMs ?? 0) - (b.timestampMs ?? 0) || a.id - b.id;
        return options.order === "desc" ? -ascending : ascending;
      })
      .slice(options.offset, options.offset + options.limit)
      .map((message) => {
        const sender = message.senderSourceJid ? this.contacts.get(message.senderSourceJid) : null;
        return {
          id: message.id,
          sourceMessageId: message.sourceMessageId,
          senderDisplayName: sender?.displayName ?? message.senderSourceJid ?? null,
          senderSourceJid: message.senderSourceJid ?? null,
          timestampMs: message.timestampMs ?? null,
          sentAt: message.timestampMs ? new Date(message.timestampMs).toISOString() : null,
          direction: message.direction,
          messageType: message.messageType,
          body: message.body ?? null,
          caption: message.caption ?? null,
          hasMedia: message.hasMedia,
          mediaMimeType: message.mediaMimeType ?? null,
          mediaName: message.mediaName ?? null,
          isDeleted: message.isDeleted,
          isForwarded: message.isForwarded,
          isStarred: message.isStarred
        };
      });
  }

  async getMemoryStatus(provider: MemoryProviderStatus): Promise<MemoryStatusSummary> {
    const currentPages = [...this.memoryPages.values()].filter((page) => page.status === "current");
    const stalePages = [...this.memoryPages.values()].filter((page) => page.status === "stale");
    const runs = [...this.memoryRuns.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return {
      enabled: true,
      rootDir: config.memory.rootDir,
      pageCount: currentPages.length,
      citationCount: this.memoryCitations.length,
      stalePageCount: stalePages.length,
      latestRun: runs[0] ?? null,
      activeRun: runs.find((run) => run.status === "running") ?? null,
      latestCommittedAtMs: await this.getLatestCommittedMemoryEndAtMs(),
      provider
    };
  }

  async startMemoryRun(input: {
    kind: MemoryRunSummary["kind"];
    sourceStartAtMs?: number | null;
    sourceEndAtMs?: number | null;
    sourceSummary?: Record<string, unknown> | null;
  }): Promise<string> {
    const id = crypto.randomUUID();
    this.memoryRuns.set(id, {
      id,
      status: "running",
      kind: input.kind,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      sourceStartAtMs: input.sourceStartAtMs ?? null,
      sourceEndAtMs: input.sourceEndAtMs ?? null,
      pageCount: 0,
      citationCount: 0,
      messageCount: 0,
      warningCount: 0,
      errorMessage: null
    });
    return id;
  }

  async completeMemoryRun(runId: string, totals: { pages: number; citations: number; messages: number; warnings: number }): Promise<void> {
    const run = this.memoryRuns.get(runId);
    if (run) {
      run.status = "completed";
      run.finishedAt = new Date().toISOString();
      run.pageCount = totals.pages;
      run.citationCount = totals.citations;
      run.messageCount = totals.messages;
      run.warningCount = totals.warnings;
    }
  }

  async failMemoryRun(runId: string, status: "failed" | "blocked", message: string, warningCount = 0): Promise<void> {
    const run = this.memoryRuns.get(runId);
    if (run) {
      run.status = status;
      run.finishedAt = new Date().toISOString();
      run.errorMessage = message;
      run.warningCount = warningCount;
    }
  }

  async getMemoryRun(runId: string): Promise<MemoryRunSummary | null> {
    return this.memoryRuns.get(runId) ?? null;
  }

  async listMemoryRuns(limit: number): Promise<MemoryRunSummary[]> {
    return [...this.memoryRuns.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  async tryAcquireMemoryLock(runId: string): Promise<boolean> {
    if (this.memoryLockRunId && this.memoryLockRunId !== runId) {
      return false;
    }
    this.memoryLockRunId = runId;
    return true;
  }

  async releaseMemoryLock(runId: string): Promise<void> {
    if (this.memoryLockRunId === runId) {
      this.memoryLockRunId = null;
    }
  }

  async createMemorySourceWindow(input: Omit<MemorySourceWindowRecord, "id" | "createdAt">): Promise<MemorySourceWindowRecord> {
    const existing = [...this.memoryWindows.values()].find((window) => window.sourceHash === input.sourceHash);
    if (existing) {
      return existing;
    }
    const window: MemorySourceWindowRecord = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString()
    };
    this.memoryWindows.set(window.id, window);
    return window;
  }

  async getCommittedMemoryWindow(sourceHash: string): Promise<MemorySourceWindowRecord | null> {
    return [...this.memoryWindows.values()].find((window) => window.sourceHash === sourceHash && window.status === "committed") ?? null;
  }

  async commitMemorySourceWindow(windowId: string): Promise<void> {
    const window = this.memoryWindows.get(windowId);
    if (window) {
      window.status = "committed";
      window.committedAt = new Date().toISOString();
    }
  }

  async listMemoryEvidenceMessages(options: {
    startAtMs?: number | null;
    endAtMs?: number | null;
    chatSourceIds?: string[];
    limit: number;
  }): Promise<MemoryEvidenceMessage[]> {
    const chatSet = options.chatSourceIds?.length ? new Set(options.chatSourceIds) : null;
    return [...this.messages.values()]
      .filter((message) => message.timestampMs != null)
      .filter((message) => options.startAtMs == null || (message.timestampMs ?? 0) >= options.startAtMs)
      .filter((message) => options.endAtMs == null || (message.timestampMs ?? 0) <= options.endAtMs)
      .filter((message) => !chatSet || chatSet.has(message.chatSourceId))
      .sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0) || a.id - b.id)
      .slice(0, options.limit)
      .map((message, index) => this.toMemoryEvidence(message, index));
  }

  async getLatestCommittedMemoryEndAtMs(chatSourceId?: string | null): Promise<number | null> {
    const windows = [...this.memoryWindows.values()].filter(
      (window) => window.status === "committed" && (chatSourceId ? window.chatSourceIds.length === 0 || window.chatSourceIds.includes(chatSourceId) : true)
    );
    const latest = windows.map((window) => window.endAtMs ?? 0).sort((a, b) => b - a)[0];
    return latest || null;
  }

  async recordMemoryEvidencePack(pack: MemoryEvidencePackRecord): Promise<void> {
    this.memoryPacks.set(pack.id, structuredClone(pack));
  }

  async commitMemoryPageRevision(revision: MemoryPageRevisionRecord, citations: MemoryCitationRecord[]): Promise<void> {
    for (const existing of this.memoryRevisions.values()) {
      if (existing.pageId === revision.pageId && existing.status === "current") {
        existing.status = "superseded";
      }
    }
    this.memoryRevisions.set(revision.id, { ...revision, citationCount: citations.length });
    this.memoryPages.set(revision.pageId, {
      pageId: revision.pageId,
      title: revision.title,
      path: revision.path,
      status: "current",
      currentRevisionId: revision.id
    });
    this.memoryCitations.push(...citations.map((citation, index) => ({ ...citation, id: this.memoryCitations.length + index + 1 })));
  }

  async listMemoryPageRevisions(options: { query?: string; limit?: number } = {}): Promise<MemoryPageRevisionRecord[]> {
    const query = options.query?.toLowerCase();
    return [...this.memoryRevisions.values()]
      .filter((revision) => revision.status === "current")
      .filter((revision) => !query || revision.title.toLowerCase().includes(query) || revision.summary.toLowerCase().includes(query) || revision.markdown.toLowerCase().includes(query))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, options.limit ?? 50);
  }

  async listMemoryCitations(revisionId?: string): Promise<MemoryCitationRecord[]> {
    return this.memoryCitations.filter((citation) => !revisionId || citation.revisionId === revisionId);
  }

  async recordMemoryValidationIssues(issues: MemoryValidationIssue[]): Promise<void> {
    this.memoryIssues.push(...issues.map((issue, index) => ({ ...issue, id: this.memoryIssues.length + index + 1, createdAt: new Date().toISOString() })));
  }

  async listMemoryValidationIssues(runId?: string): Promise<MemoryValidationIssue[]> {
    return this.memoryIssues.filter((issue) => !runId || issue.runId === runId);
  }

  async markStaleMemoryForMissingMessages(): Promise<number> {
    const missingPageIds = new Set<string>();
    for (const citation of this.memoryCitations) {
      if (!this.messages.has(citation.sourceMessageKey)) {
        const revision = this.memoryRevisions.get(citation.revisionId);
        if (revision?.status === "current") {
          missingPageIds.add(revision.pageId);
        }
      }
    }
    for (const pageId of missingPageIds) {
      const page = this.memoryPages.get(pageId);
      if (page) page.status = "stale";
      for (const revision of this.memoryRevisions.values()) {
        if (revision.pageId === pageId && revision.status === "current") {
          revision.status = "stale";
        }
      }
    }
    return missingPageIds.size;
  }

  async resolveMemoryCitation(citationLabelOrMessageKey: string): Promise<MemoryCitationRecord | null> {
    return [...this.memoryCitations].reverse().find(
      (citation) => citation.citationLabel === citationLabelOrMessageKey || citation.sourceMessageKey === citationLabelOrMessageKey
    ) ?? null;
  }

  async listNearbyMemoryMessages(messageId: number, radius: number): Promise<MemoryEvidenceMessage[]> {
    const base = [...this.messages.values()].find((message) => message.id === messageId);
    if (!base) {
      return [];
    }
    return [...this.messages.values()]
      .filter((message) => message.chatSourceId === base.chatSourceId && message.id >= messageId - radius && message.id <= messageId + radius)
      .sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0) || a.id - b.id)
      .map((message, index) => this.toMemoryEvidence(message, index));
  }

  private hasVisibleExchange(chatSourceId: string): boolean {
    return [...this.messages.values()].some((message) => message.chatSourceId === chatSourceId && isVisibleExchange(message));
  }

  private toMemoryEvidence(message: MessageRecord & { id: number }, index: number): MemoryEvidenceMessage {
    const chat = this.chats.get(message.chatSourceId);
    const sender = message.senderSourceJid ? this.contacts.get(message.senderSourceJid) : null;
    return {
      citationLabel: `m${index + 1}`,
      messageId: message.id,
      sourceMessageKey: message.sourceMessageKey,
      sourceMessageId: message.sourceMessageId,
      sourceChatId: message.chatSourceId,
      chatId: chat?.id ?? 0,
      chatDisplayName: chat?.displayName ?? null,
      senderSourceJid: message.senderSourceJid ?? null,
      senderDisplayName: sender?.displayName ?? message.senderSourceJid ?? null,
      timestampMs: message.timestampMs ?? null,
      sentAt: message.timestampMs ? new Date(message.timestampMs).toISOString() : null,
      direction: message.direction,
      messageType: message.messageType,
      text: message.body ?? message.caption ?? null
    };
  }
}

function emptyTotals(): ImportTotals {
  return { contacts: 0, chats: 0, participants: 0, messages: 0, skipped: 0, warnings: 0 };
}

function emptyLiveTotals(): LiveSyncTotals {
  return { contacts: 0, chats: 0, participants: 0, messages: 0, updates: 0, gapsOpened: 0, gapsClosed: 0, warnings: 0 };
}

function cloneMap<K, V>(map: Map<K, V>): Map<K, V> {
  return new Map(structuredClone([...map]));
}

function isVisibleExchange(message: MessageRecord): boolean {
  if (message.messageType === "system" || message.messageType === "status") {
    return false;
  }
  return (
    message.direction === "incoming" ||
    message.direction === "outgoing" ||
    Boolean(message.body?.trim()) ||
    Boolean(message.caption?.trim()) ||
    message.hasMedia ||
    message.isDeleted ||
    message.messageType === "call"
  );
}

function isIdentityDisplayName(chat: ChatRecord & { displayName?: string | null }): boolean {
  const displayName = chat.displayName?.trim();
  if (!displayName) {
    return true;
  }
  return displayName === chat.jid || displayName === chat.sourceChatId || displayName === localPartFromJid(chat.sourceChatId);
}

function localPartFromJid(jid: string): string {
  return jid.split("@")[0]?.split(":")[0] ?? jid;
}
