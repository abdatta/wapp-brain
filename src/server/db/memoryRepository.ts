import type {
  ArchiveRepository,
  ArchiveRestorePoint
} from "./repository";
import type {
  BrainChatBacklogItem,
  BrainEpisodeInput,
  BrainEpisodeRecord,
  BrainLlmUsageSummary,
  BrainRunSummary,
  BrainStatusSummary,
  BrainTaskInput,
  BrainTaskRecord,
  BrainTaskSummary,
  CapturedLinkPreview,
  ChatListItem,
  ChatListOptions,
  ChatRecord,
  ChatSyncStateRecord,
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
  MediaAssetRecord,
  MediaAvailabilityState,
  MediaDownloadQueueRecord,
  MediaQueueSummary,
  MessageEditRevisionRecord,
  MessageMediaSummary,
  MemoryCitationRecord,
  MemoryEvidenceMessage,
  MemoryEvidencePackRecord,
  MemoryPageRevisionRecord,
  MemoryProviderStatus,
  MemoryRunSummary,
  MemorySourceWindowRecord,
  MemoryStatusSummary,
  MemoryValidationIssue,
  MessageContextWindow,
  MessageListItem,
  MessageRecord,
  MessageSecretRecord,
  ParticipantRecord,
  RecoveryAnchorRecord,
  RetainedPayloadRecord,
  SearchIndexStatus,
  SearchQueryOptions,
  SearchResponse,
  SearchResultItem,
  StatusSummary
} from "../../shared/types";
import { SEARCH_HIGHLIGHT_END, SEARCH_HIGHLIGHT_START } from "../../shared/types";
import { config } from "../config";
import { baselineFromStatus } from "../live/baseline";
import { messageIdFromKey, messageKey } from "../identity/keys";
import { applyMentionLabels, appliedMentionLabels, extractMentionDigits, mentionJidCandidates } from "../identity/mentions";
import { mergeInteractionMetadata } from "./interactions";
import { interpretMessage } from "../interpretation/messageInterpretation";
import { isMaskedNumberLabel, normalizeJid } from "../import/jid";
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
  private messageSecrets = new Map<string, MessageSecretRecord>();
  private retainedPayloads = new Map<number, RetainedPayloadRecord & { id: number }>();
  private nextRetainedPayloadId = 1;
  private mediaQueue = new Map<string, MediaDownloadQueueRecord & { id: number }>();
  private mediaAssets = new Map<number, MediaAssetRecord & { id: number }>();
  private linkPreviews = new Map<string, CapturedLinkPreview>();
  private brainWatermarks = new Map<string, { assimilatedThroughMs: number; assimilatedThroughId: number; lastEpisodeAt: string | null }>();
  private brainTasks = new Map<string, BrainTaskRecord>();
  private nextBrainTaskId = 1;
  private brainRuns = new Map<string, BrainRunSummary>();
  private brainLedger: Array<{
    purpose: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    estimated: boolean;
    atMs: number;
    day: string;
  }> = [];
  private brainEpisodes = new Map<string, BrainEpisodeRecord>();
  private brainLockRunId: string | null = null;
  private editRevisions = new Map<string, MessageEditRevisionRecord[]>();
  private nextMediaQueueId = 1;
  private nextMediaAssetId = 1;
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
  private identityLinks = new Map<string, string>();

  private canonicalJid(jid: string | null | undefined): string | null {
    const normalized = normalizeJid(jid);
    if (!normalized) {
      return null;
    }
    return this.identityLinks.get(normalized) ?? normalized;
  }

  async resolveIdentityJid(jid: string): Promise<string> {
    return this.canonicalJid(jid) ?? jid;
  }

  async getIdentityLidsForJid(jid: string): Promise<string[]> {
    const normalized = normalizeJid(jid);
    if (!normalized) {
      return [];
    }
    if (normalized.endsWith("@lid") || normalized.endsWith("@hosted.lid")) {
      return [normalized];
    }
    return [...this.identityLinks.entries()].filter(([, pn]) => pn === normalized).map(([lid]) => lid);
  }

  async recordIdentityLinks(links: Array<{ lid: string; pn: string; source?: string | null }>): Promise<string[]> {
    const learned: string[] = [];
    for (const link of links) {
      const lid = normalizeJid(link.lid);
      const pn = normalizeJid(link.pn);
      if (!lid || !pn || lid === pn || !(lid.endsWith("@lid") || lid.endsWith("@hosted.lid")) || !pn.endsWith("@s.whatsapp.net") || this.identityLinks.has(lid)) {
        continue;
      }
      this.identityLinks.set(lid, pn);
      learned.push(lid);
    }
    return learned;
  }

  async clearIdentityDerivedChatNames(): Promise<number> {
    let cleared = 0;
    for (const chat of this.chats.values()) {
      if (chat.displayName && isIdentityDerivedName(chat.displayName, chat.jid)) {
        chat.displayName = null;
        cleared += 1;
      }
    }
    return cleared;
  }

  async listUnnamedGroupChats(limit = 20): Promise<string[]> {
    return [...this.chats.values()]
      .filter((chat) => chat.chatType === "group" && (!chat.displayName?.trim() || chat.displayName === chat.jid))
      .slice(0, Math.max(1, limit))
      .map((chat) => chat.sourceChatId);
  }

  async removeProtocolNoiseMessages(): Promise<number> {
    const noiseTypes = new Set(["unknown_senderKeyDistributionMessage", "encrypted_update"]);
    let removed = 0;
    const affected = new Set<string>();
    for (const [key, message] of this.messages) {
      if (message.sourceTable.startsWith("wa-web") && noiseTypes.has(message.messageType)) {
        affected.add(message.chatSourceId);
        this.messages.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) {
      await this.refreshChatStats([...affected]);
      await this.markStaleMemoryForMissingMessages();
    }
    return removed;
  }

  async collapseSupersededMessages(
    pairs: Array<{ chatSourceId: string; staleMessageId: string; canonicalMessageId: string }>
  ): Promise<number> {
    let collapsed = 0;
    for (const pair of pairs) {
      const chatSourceId = this.canonicalJid(pair.chatSourceId) ?? pair.chatSourceId;
      const staleKey = messageKey(chatSourceId, pair.staleMessageId);
      const canonicalKey = messageKey(chatSourceId, pair.canonicalMessageId);
      if (this.messages.has(staleKey) && this.messages.has(canonicalKey)) {
        this.messages.delete(staleKey);
        collapsed += 1;
      }
    }
    if (collapsed > 0) {
      await this.markStaleMemoryForMissingMessages();
    }
    return collapsed;
  }

  async listUnknownTypeCodes(): Promise<Array<{ code: string; count: number; examples: Array<{ chatLabel: string; timestampMs: number | null }> }>> {
    const byCode = new Map<string, Array<MessageRecord & { id: number }>>();
    for (const message of this.messages.values()) {
      if (!message.messageType.startsWith("unknown")) {
        continue;
      }
      const code = String(message.rawTypeCode ?? "").trim() || message.messageType.replace(/^unknown_?/, "");
      byCode.set(code, [...(byCode.get(code) ?? []), message]);
    }
    return [...byCode.entries()]
      .map(([code, messages]) => ({
        code,
        count: messages.length,
        examples: messages
          .sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0))
          .slice(0, 3)
          .map((message) => {
            const chat = this.chats.get(message.chatSourceId);
            // Display rule: name, else phone digits, never a raw identifier.
            return {
              chatLabel:
                chat?.displayName?.trim() ||
                displayPhoneFromJid(message.chatSourceId) ||
                (message.chatSourceId.endsWith("@g.us") ? "Unnamed group" : "Unresolved chat"),
              timestampMs: message.timestampMs ?? null
            };
          })
      }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  }

  async listUnmergedLidIdentities(limit = 20): Promise<Array<{ lid: string; pn: string }>> {
    const unmerged: Array<{ lid: string; pn: string }> = [];
    for (const [lid, pn] of this.identityLinks) {
      const hasChats = this.chats.has(lid);
      const hasContacts = this.contacts.has(lid);
      const hasSenders = [...this.messages.values()].some((message) => message.senderSourceJid === lid);
      if (hasChats || hasContacts || hasSenders) {
        unmerged.push({ lid, pn });
        if (unmerged.length >= limit) {
          break;
        }
      }
    }
    return unmerged;
  }

  async mergeIdentity(lid: string, pn: string): Promise<{ chatsMerged: number; contactsMerged: number; messagesCollapsed: number }> {
    const result = { chatsMerged: 0, contactsMerged: 0, messagesCollapsed: 0 };
    const lidChat = this.chats.get(lid);
    const pnChat = this.chats.get(pn);
    if (lidChat) {
      result.chatsMerged += 1;
      if (!pnChat) {
        this.chats.delete(lid);
        this.chats.set(pn, { ...lidChat, sourceChatId: pn, jid: pn });
      } else {
        pnChat.displayName = pnChat.displayName || lidChat.displayName || null;
        pnChat.platformRecencyMs = Math.max(pnChat.platformRecencyMs ?? 0, lidChat.platformRecencyMs ?? 0) || null;
        this.chats.delete(lid);
      }
      for (const [key, message] of [...this.messages]) {
        if (message.chatSourceId !== lid) {
          continue;
        }
        const rekeyed = { ...message, chatSourceId: pn, sourceMessageKey: messageKey(pn, message.sourceMessageId) };
        const conflict = this.messages.get(rekeyed.sourceMessageKey);
        this.messages.delete(key);
        if (conflict) {
          result.messagesCollapsed += 1;
          // Brain citations anchor on the rowid; follow the survivor before the
          // collapsed row's id disappears.
          this.repointBrainCitations(message.id, conflict.id);
          if ((rekeyed.body ? 1 : 0) + (rekeyed.caption ? 1 : 0) > (conflict.body ? 1 : 0) + (conflict.caption ? 1 : 0)) {
            this.messages.set(rekeyed.sourceMessageKey, { ...rekeyed, id: conflict.id });
          }
        } else {
          this.messages.set(rekeyed.sourceMessageKey, rekeyed);
        }
      }
    }
    const lidContact = this.contacts.get(lid);
    const pnContact = this.contacts.get(pn);
    if (lidContact) {
      result.contactsMerged += 1;
      if (!pnContact) {
        this.contacts.delete(lid);
        this.contacts.set(pn, { ...lidContact, sourceJid: pn });
      } else {
        pnContact.displayName = pnContact.displayName || lidContact.displayName || null;
        pnContact.pushName = pnContact.pushName || lidContact.pushName || null;
        pnContact.phoneNumber = pnContact.phoneNumber || lidContact.phoneNumber || null;
        this.contacts.delete(lid);
      }
    }
    for (const message of this.messages.values()) {
      if (message.senderSourceJid === lid) {
        message.senderSourceJid = pn;
      }
    }
    const rekeyedParticipants: ParticipantRecord[] = [];
    for (const [key, participant] of [...this.participants]) {
      if (participant.sourceJid === lid || participant.chatSourceId === lid) {
        this.participants.delete(key);
        rekeyedParticipants.push({
          ...participant,
          sourceJid: participant.sourceJid === lid ? pn : participant.sourceJid,
          chatSourceId: participant.chatSourceId === lid ? pn : participant.chatSourceId
        });
      }
    }
    if (rekeyedParticipants.length) {
      await this.upsertParticipants(rekeyedParticipants);
    }
    const lidCheckpoint = this.liveCheckpoints.get(lid);
    if (lidCheckpoint) {
      if (!this.liveCheckpoints.has(pn)) {
        this.liveCheckpoints.set(pn, { ...lidCheckpoint, chatSourceId: pn });
      }
      this.liveCheckpoints.delete(lid);
    }
    for (const gap of this.liveGaps.values()) {
      if (gap.chatSourceId === lid) {
        gap.chatSourceId = pn;
      }
    }

    // brain-correctness-debts D2: reconcile derived brain state deterministically
    // (mirror of the SQLite merge) — episodes, citations, watermark cursor, and
    // pending tasks all follow the surviving identity.
    for (const episode of this.brainEpisodes.values()) {
      if (episode.chatSourceId === lid) {
        episode.chatSourceId = pn;
      }
      for (const claim of episode.claims) {
        for (const citation of claim.citations) {
          if (citation.sourceChatId === lid) {
            citation.sourceChatId = pn;
            const msg = citation.messageId != null ? [...this.messages.values()].find((m) => m.id === citation.messageId) : null;
            if (msg) {
              citation.sourceMessageKey = msg.sourceMessageKey;
            }
          }
        }
      }
    }
    const lidWatermark = this.brainWatermarks.get(lid);
    if (lidWatermark) {
      const pnWatermark = this.brainWatermarks.get(pn);
      const keepLid =
        !pnWatermark ||
        lidWatermark.assimilatedThroughMs > pnWatermark.assimilatedThroughMs ||
        (lidWatermark.assimilatedThroughMs === pnWatermark.assimilatedThroughMs &&
          lidWatermark.assimilatedThroughId > pnWatermark.assimilatedThroughId);
      this.brainWatermarks.set(pn, keepLid ? { ...lidWatermark } : { ...pnWatermark! });
      this.brainWatermarks.delete(lid);
    }
    for (const [dedupeKey, task] of [...this.brainTasks]) {
      if (task.chatSourceId === lid) {
        this.brainTasks.delete(dedupeKey);
      }
    }

    await this.refreshChatStats([pn]);
    return result;
  }

  // Repoint brain citations from a collapsed message rowid onto the survivor.
  private repointBrainCitations(fromId: number, toId: number): void {
    for (const episode of this.brainEpisodes.values()) {
      for (const claim of episode.claims) {
        for (const citation of claim.citations) {
          if (citation.messageId === fromId) {
            citation.messageId = toId;
          }
        }
      }
    }
  }

  async createRestorePoint(_label: string): Promise<ArchiveRestorePoint> {
    const snapshot = {
      brainWatermarks: cloneMap(this.brainWatermarks),
      brainTasks: cloneMap(this.brainTasks),
      brainRuns: cloneMap(this.brainRuns),
      brainLedger: structuredClone(this.brainLedger),
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
        this.brainWatermarks = cloneMap(snapshot.brainWatermarks);
        this.brainTasks = cloneMap(snapshot.brainTasks);
        this.brainRuns = cloneMap(snapshot.brainRuns);
        this.brainLedger = structuredClone(snapshot.brainLedger);
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
    // Mirror the SQLite adapter: canonicalize first, then merge field-wise
    // within the batch with first-record-wins, so a LID display-cache name
    // canonicalizing onto the same identity cannot clobber a stronger name
    // that came earlier in source-precedence order.
    const unique = new Map<string, ContactRecord>();
    for (const rawContact of contacts) {
      const sourceJid = this.canonicalJid(rawContact.sourceJid);
      if (!sourceJid) {
        continue;
      }
      const queued = unique.get(sourceJid);
      // A masked-number placeholder is never a name (mirror the SQLite guard):
      // coerce it to null so no writer can store it and shadow the number.
      const mergedDisplayName = queued?.displayName?.trim() || rawContact.displayName || null;
      const mergedPushName = queued?.pushName?.trim() || rawContact.pushName || null;
      unique.set(sourceJid, {
        ...rawContact,
        sourceJid,
        displayName: mergedDisplayName && !isMaskedNumberLabel(mergedDisplayName) ? mergedDisplayName : null,
        pushName: mergedPushName && !isMaskedNumberLabel(mergedPushName) ? mergedPushName : null,
        phoneNumber: queued?.phoneNumber || rawContact.phoneNumber || null
      });
    }
    for (const contact of unique.values()) {
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

  async enrichContactsFromGoogle(contacts: Array<{ phoneNumber: string; displayName: string }>): Promise<{ matchedIdentities: number; improvedNames: number }> {
    let matchedIdentities = 0;
    let improvedNames = 0;
    for (const candidate of contacts) {
      const jid = `${candidate.phoneNumber}@s.whatsapp.net`;
      const contact = this.contacts.get(jid);
      if (!contact) continue;
      matchedIdentities += 1;
      // Mirror the SQLite adapter: a masked-number placeholder counts as
      // no-name, so a learned real name replaces it instead of being shadowed.
      if (!contact.displayName || isMaskedNumberLabel(contact.displayName) || isIdentityDerivedName(contact.displayName, jid)) {
        contact.displayName = candidate.displayName;
        const chat = this.chats.get(jid);
        if (chat && (chat.chatType === "dm" || chat.chatType === "unknown")) chat.displayName = candidate.displayName;
        improvedNames += 1;
      }
    }
    return { matchedIdentities, improvedNames };
  }

  async upsertChats(_runId: string, chats: ChatRecord[]): Promise<Map<string, number>> {
    for (const rawChat of chats) {
      const sourceChatId = this.canonicalJid(rawChat.sourceChatId);
      if (!sourceChatId) {
        continue;
      }
      const displayName =
        rawChat.displayName && !isIdentityDerivedName(rawChat.displayName, sourceChatId) && !isMaskedNumberLabel(rawChat.displayName)
          ? rawChat.displayName
          : null;
      const chat = { ...rawChat, sourceChatId, jid: sourceChatId, displayName };
      const existing = this.chats.get(chat.sourceChatId);
      this.chats.set(chat.sourceChatId, {
        ...existing,
        ...chat,
        displayName: chat.displayName || existing?.displayName || null,
        chatType: chat.chatType === "unknown" && existing ? existing.chatType : chat.chatType,
        platformRecencyMs: maxNullableMs(existing?.platformRecencyMs ?? null, chat.platformRecencyMs ?? null),
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
    for (const rawMessage of messages) {
      const chatSourceId = this.canonicalJid(rawMessage.chatSourceId);
      if (!chatSourceId || !rawMessage.sourceMessageId) {
        continue;
      }
      const senderSourceJid =
        rawMessage.senderSourceJid === "me" ? "me" : this.canonicalJid(rawMessage.senderSourceJid) ?? rawMessage.senderSourceJid ?? null;
      const message = { ...rawMessage, chatSourceId, senderSourceJid, sourceMessageKey: messageKey(chatSourceId, rawMessage.sourceMessageId) };
      const existing = this.messages.get(message.sourceMessageKey);
      // A textless unknown-typed row flagged deleted is the retired inference
      // heuristic, not evidence; a re-import bearing a fresh not-deleted
      // verdict heals it. Real tombstones (typed rows) keep sticky deletion.
      const healsHeuristicDeletion =
        Boolean(existing?.isDeleted) &&
        Boolean(existing?.messageType.startsWith("unknown")) &&
        existing?.body == null &&
        existing?.caption == null &&
        !message.isDeleted;
      const deletionLocked = Boolean(existing?.isDeleted) && !healsHeuristicDeletion;
      // Mirror the SQLite adapter: an incoming system/unknown classification
      // never downgrades an already-known type, and a contentless unknown
      // never erases a system stub's classification.
      const incomingTypeIsWeak = message.messageType === "system" || message.messageType.startsWith("unknown");
      const existingTypeIsStrong =
        existing != null && existing.messageType !== "system" && !existing.messageType.startsWith("unknown");
      const keepExistingType =
        (incomingTypeIsWeak && existingTypeIsStrong) ||
        (message.messageType.startsWith("unknown") && existing?.messageType === "system");
      this.messages.set(message.sourceMessageKey, {
        ...existing,
        ...message,
        messageType: keepExistingType ? existing!.messageType : message.messageType,
        body: deletionLocked ? existing?.body ?? null : message.body ?? existing?.body ?? null,
        caption: deletionLocked ? existing?.caption ?? null : message.caption ?? existing?.caption ?? null,
        isDeleted: deletionLocked || message.isDeleted,
        id: existing?.id ?? this.nextMessageId++
      });
    }
    return messages.length;
  }

  async refreshChatStats(chatSourceIds?: string[]): Promise<void> {
    const scope = chatSourceIds ? new Set(chatSourceIds) : null;
    for (const chat of this.chats.values()) {
      if (scope && !scope.has(chat.sourceChatId)) {
        continue;
      }
      const messages = [...this.messages.values()].filter((message) => message.chatSourceId === chat.sourceChatId);
      chat.messageCount = messages.length;
      chat.participantCount = [...this.participants.values()].filter((participant) => participant.chatSourceId === chat.sourceChatId).length;
      // WhatsApp-style recency: only visible conversation messages move a chat.
      const last = messages
        .filter(isVisibleExchange)
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
    this.identityLinks.clear();
    this.nextContactId = 1;
    this.nextChatId = 1;
    this.nextMessageId = 1;
    this.nextLiveGapId = 1;
    this.messageSecrets.clear();
    this.retainedPayloads.clear();
    this.nextRetainedPayloadId = 1;
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

  async listLiveCheckpoints(chatSourceIds?: string[]): Promise<LiveChatCheckpointRecord[]> {
    const scope = chatSourceIds ? new Set(chatSourceIds) : null;
    return [...this.liveCheckpoints.values()].filter((checkpoint) => !scope || scope.has(checkpoint.chatSourceId));
  }

  async listChatSyncStates(chatSourceIds?: string[]): Promise<ChatSyncStateRecord[]> {
    const scope = chatSourceIds ? new Set(chatSourceIds) : null;
    return [...this.chats.values()]
      .filter((chat) => !scope || scope.has(chat.sourceChatId))
      .map((chat) => {
        const messages = [...this.messages.values()]
          .filter((message) => message.chatSourceId === chat.sourceChatId && message.timestampMs != null)
          .sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));
        const earliest = messages[0] ?? null;
        const latest = messages[messages.length - 1] ?? null;
        return {
          chatSourceId: chat.sourceChatId,
          latestArchivedAtMs: latest?.timestampMs ?? null,
          latestArchivedMessageId: latest?.sourceMessageId ?? null,
          earliestArchivedAtMs: earliest?.timestampMs ?? null,
          earliestArchivedMessageId: earliest?.sourceMessageId ?? null,
          platformRecencyMs: chat.platformRecencyMs ?? null
        };
      });
  }

  async getRecoveryAnchor(chatSourceId: string, afterMs: number | null): Promise<RecoveryAnchorRecord | null> {
    const candidates = [...this.messages.values()]
      .filter((message) => message.chatSourceId === chatSourceId && message.timestampMs != null)
      .filter((message) => afterMs == null || (message.timestampMs ?? 0) > afterMs)
      .sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));
    const anchor = candidates[0];
    if (!anchor) {
      return null;
    }
    return {
      sourceMessageId: anchor.sourceMessageId,
      timestampMs: anchor.timestampMs ?? 0,
      fromMe: anchor.fromMe,
      senderSourceJid: anchor.senderSourceJid ?? null
    };
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

  async applyLiveMessageUpdates(rawUpdates: Array<Omit<LiveMessageUpdateRecord, "applied">>): Promise<LiveMessageUpdateResult> {
    const updates = rawUpdates.map((update) => {
      const chatSourceId = this.canonicalJid(update.chatSourceId) ?? update.chatSourceId;
      const targetId = messageIdFromKey(update.sourceMessageKey);
      return { ...update, chatSourceId, sourceMessageKey: targetId ? messageKey(chatSourceId, targetId) : update.sourceMessageKey };
    });
    let applied = 0;
    let pending = 0;
    const changedKeys: string[] = [];
    for (const update of updates) {
      const message = this.messages.get(update.sourceMessageKey) ?? this.findUpdateTarget(update);
      if (message) {
        if (update.updateType === "delete") {
          // Tombstone only: held content stays (backup-store semantics).
          message.isDeleted = true;
          changedKeys.push(message.sourceMessageKey);
        }
        if (update.updateType === "edit" && typeof update.metadata?.body === "string") {
          if (message.body != null && message.body !== update.metadata.body) {
            const revisions = this.editRevisions.get(message.sourceMessageKey) ?? [];
            revisions.push({
              messageKey: message.sourceMessageKey,
              revisionIndex: revisions.length,
              body: message.body,
              caption: message.caption ?? null,
              editedAtMs: update.occurredAtMs ?? null
            });
            this.editRevisions.set(message.sourceMessageKey, revisions);
          }
          message.body = update.metadata.body;
          message.rawMetadata = { ...(message.rawMetadata ?? {}), edited: 1 };
          changedKeys.push(message.sourceMessageKey);
        }
        if (update.updateType === "poll_vote" || update.updateType === "event_response") {
          const merged = mergeInteractionMetadata(message.rawMetadata ?? {}, update);
          if (merged) {
            message.rawMetadata = merged;
          }
        }
        applied += 1;
      } else {
        pending += 1;
      }
      const existing = this.liveUpdates.get(update.eventKey);
      this.liveUpdates.set(update.eventKey, { ...update, applied: Boolean(message) || Boolean(existing?.applied) });
    }
    // Staleness propagation: edits/deletes of cited messages invalidate episodes.
    await this.markStaleEpisodesForMessages(changedKeys);
    return { applied, pending };
  }

  async listPendingLiveMessageUpdates(limit = 500): Promise<LiveMessageUpdateRecord[]> {
    return [...this.liveUpdates.values()].filter((update) => !update.applied).slice(0, Math.max(1, limit));
  }

  async recordMessageSecrets(secrets: MessageSecretRecord[]): Promise<number> {
    let recorded = 0;
    for (const entry of secrets) {
      const chatSourceId = this.canonicalJid(entry.chatSourceId) ?? entry.chatSourceId;
      if (!chatSourceId || !entry.sourceMessageId || entry.secret.length === 0) {
        continue;
      }
      const key = messageKey(chatSourceId, entry.sourceMessageId);
      if (!this.messageSecrets.has(key)) {
        this.messageSecrets.set(key, { ...entry, chatSourceId });
        recorded += 1;
      }
    }
    return recorded;
  }

  async getMessageSecret(chatSourceId: string, sourceMessageId: string): Promise<Uint8Array | null> {
    const canonical = this.canonicalJid(chatSourceId) ?? chatSourceId;
    return this.messageSecrets.get(messageKey(canonical, sourceMessageId))?.secret ?? null;
  }

  async countMessageSecrets(): Promise<number> {
    return this.messageSecrets.size;
  }

  async retainEncryptedPayloads(payloads: RetainedPayloadRecord[]): Promise<number> {
    let retained = 0;
    for (const payload of payloads) {
      const chatSourceId = this.canonicalJid(payload.chatSourceId) ?? payload.chatSourceId;
      if (!chatSourceId || !payload.targetMessageId || payload.encPayload.length === 0) {
        continue;
      }
      if ([...this.retainedPayloads.values()].some((existing) => existing.eventKey === payload.eventKey)) {
        continue;
      }
      const id = this.nextRetainedPayloadId++;
      this.retainedPayloads.set(id, { ...payload, id, chatSourceId });
      retained += 1;
    }
    return retained;
  }

  async listRetainedEncryptedPayloads(limit = 500): Promise<RetainedPayloadRecord[]> {
    return [...this.retainedPayloads.values()].slice(0, Math.max(1, limit));
  }

  async deleteRetainedEncryptedPayload(id: number): Promise<void> {
    this.retainedPayloads.delete(id);
  }

  async getMessageInterpretationContext(
    chatSourceId: string,
    sourceMessageId: string
  ): Promise<{ senderSourceJid: string | null; fromMe: boolean | null; rawMetadata: Record<string, unknown> | null } | null> {
    const canonical = this.canonicalJid(chatSourceId) ?? chatSourceId;
    const message = this.messages.get(messageKey(canonical, sourceMessageId));
    if (!message) {
      return null;
    }
    return {
      senderSourceJid: message.senderSourceJid ?? null,
      fromMe: message.fromMe ?? null,
      rawMetadata: message.rawMetadata ?? null
    };
  }

  async enqueueMediaDownloads(
    items: Array<Pick<MediaDownloadQueueRecord, "messageKey" | "chatSourceId" | "sourceMessageId" | "descriptor" | "thumbnail" | "isViewOnce" | "priority">>
  ): Promise<number> {
    let enqueued = 0;
    for (const item of items) {
      const chatSourceId = this.canonicalJid(item.chatSourceId) ?? item.chatSourceId;
      if (!chatSourceId || !item.sourceMessageId) {
        continue;
      }
      const key = messageKey(chatSourceId, item.sourceMessageId);
      const existing = this.mediaQueue.get(key);
      if (existing) {
        if (existing.status === "pending" || existing.status === "retry") {
          existing.priority = Math.max(existing.priority, item.priority);
        }
        continue;
      }
      this.mediaQueue.set(key, {
        id: this.nextMediaQueueId++,
        messageKey: key,
        chatSourceId,
        sourceMessageId: item.sourceMessageId,
        descriptor: item.descriptor,
        thumbnail: item.thumbnail ?? null,
        isViewOnce: item.isViewOnce,
        status: "pending",
        attempts: 0,
        reuploadAttempts: 0,
        nextAttemptAtMs: null,
        lastError: null,
        priority: item.priority
      });
      enqueued += 1;
    }
    return enqueued;
  }

  async claimDueMediaDownloads(limit: number, nowMs = Date.now()): Promise<MediaDownloadQueueRecord[]> {
    const due = [...this.mediaQueue.values()]
      .filter((entry) => (entry.status === "pending" || entry.status === "retry") && (entry.nextAttemptAtMs == null || entry.nextAttemptAtMs <= nowMs))
      .sort((a, b) => b.priority - a.priority || a.id - b.id)
      .slice(0, Math.max(1, limit));
    for (const entry of due) {
      entry.status = "downloading";
    }
    return due.map((entry) => ({ ...entry }));
  }

  async completeMediaDownload(queueId: number, asset: MediaAssetRecord): Promise<number> {
    const assetId = await this.linkMediaAsset(asset);
    const entry = [...this.mediaQueue.values()].find((candidate) => candidate.id === queueId);
    if (entry) {
      entry.status = "stored";
      entry.thumbnail = null;
      entry.lastError = null;
      // Media landing upgrades interpretation; episodes citing it go stale.
      await this.markStaleEpisodesForMessages([entry.messageKey]);
    }
    return assetId;
  }

  async markMediaDownloadRetry(queueId: number, error: string, nextAttemptAtMs: number, options: { countReupload?: boolean } = {}): Promise<void> {
    const entry = [...this.mediaQueue.values()].find((candidate) => candidate.id === queueId);
    if (entry) {
      entry.status = "retry";
      entry.attempts += 1;
      entry.reuploadAttempts += options.countReupload ? 1 : 0;
      entry.nextAttemptAtMs = nextAttemptAtMs;
      entry.lastError = error;
    }
  }

  async markMediaDownloadTerminal(queueId: number, status: "expired_unrecoverable" | "failed", error: string | null): Promise<void> {
    const entry = [...this.mediaQueue.values()].find((candidate) => candidate.id === queueId);
    if (entry) {
      entry.status = status;
      entry.lastError = error;
    }
  }

  async linkMediaAsset(asset: MediaAssetRecord): Promise<number> {
    const chatSourceId = this.canonicalJid(asset.chatSourceId) ?? asset.chatSourceId;
    const existing = [...this.mediaAssets.values()].find(
      (candidate) => candidate.messageKey === asset.messageKey && candidate.sha256 === asset.sha256
    );
    if (existing) {
      return existing.id;
    }
    const id = this.nextMediaAssetId++;
    this.mediaAssets.set(id, { ...asset, id, chatSourceId });
    return id;
  }

  async getMediaAsset(assetId: number): Promise<MediaAssetRecord | null> {
    return this.mediaAssets.get(assetId) ?? null;
  }

  async getMediaAssetForMessage(messageId: number): Promise<MediaAssetRecord | null> {
    const message = [...this.messages.values()].find((candidate) => candidate.id === messageId);
    if (!message) {
      return null;
    }
    return [...this.mediaAssets.values()].find((candidate) => candidate.messageKey === message.sourceMessageKey) ?? null;
  }

  async getMediaQueueSummary(): Promise<MediaQueueSummary> {
    const summary: MediaQueueSummary = {
      assets: this.mediaAssets.size,
      pending: 0,
      downloading: 0,
      retry: 0,
      stored: 0,
      failed: 0,
      expiredUnrecoverable: 0
    };
    for (const entry of this.mediaQueue.values()) {
      if (entry.status === "pending") summary.pending += 1;
      else if (entry.status === "downloading") summary.downloading += 1;
      else if (entry.status === "retry") summary.retry += 1;
      else if (entry.status === "stored") summary.stored += 1;
      else if (entry.status === "failed") summary.failed += 1;
      else summary.expiredUnrecoverable += 1;
    }
    return summary;
  }

  async retryStuckMediaDownloads(): Promise<number> {
    let requeued = 0;
    for (const entry of this.mediaQueue.values()) {
      if ((entry.status === "failed" || entry.status === "expired_unrecoverable" || entry.status === "retry") && entry.descriptor) {
        entry.status = "pending";
        entry.attempts = 0;
        entry.reuploadAttempts = 0;
        entry.nextAttemptAtMs = null;
        requeued += 1;
      }
    }
    return requeued;
  }

  async resetInFlightMediaDownloads(): Promise<number> {
    let reset = 0;
    for (const entry of this.mediaQueue.values()) {
      if (entry.status === "downloading") {
        entry.status = "pending";
        reset += 1;
      }
    }
    return reset;
  }

  async recordLinkPreviews(previews: CapturedLinkPreview[]): Promise<number> {
    let recorded = 0;
    for (const preview of previews) {
      const chatSourceId = this.canonicalJid(preview.chatSourceId) ?? preview.chatSourceId;
      if (!chatSourceId || !preview.sourceMessageId) {
        continue;
      }
      const key = messageKey(chatSourceId, preview.sourceMessageId);
      if (!this.linkPreviews.has(key)) {
        this.linkPreviews.set(key, { ...preview, chatSourceId });
        recorded += 1;
      }
    }
    return recorded;
  }

  async getLinkPreviewThumbnail(messageId: number): Promise<Uint8Array | null> {
    const message = [...this.messages.values()].find((candidate) => candidate.id === messageId);
    if (!message) {
      return null;
    }
    return this.linkPreviews.get(message.sourceMessageKey)?.thumbnail ?? null;
  }

  async listMessageEditRevisions(messageId: number): Promise<MessageEditRevisionRecord[]> {
    const message = [...this.messages.values()].find((candidate) => candidate.id === messageId);
    if (!message) {
      return [];
    }
    return [...(this.editRevisions.get(message.sourceMessageKey) ?? [])].sort((a, b) => a.revisionIndex - b.revisionIndex);
  }

  // Mirrors the SQLite availability derivation for parity in tests.
  private deriveMediaState(message: MessageRecord & { id: number }): MessageMediaSummary | null {
    const asset = [...this.mediaAssets.values()].find((candidate) => candidate.messageKey === message.sourceMessageKey) ?? null;
    const isViewOnceType = message.messageType.startsWith("view_once");
    if (asset) {
      return {
        availability: "stored",
        assetId: asset.id,
        mimeType: asset.mimeType,
        byteSize: asset.byteSize,
        width: asset.width,
        height: asset.height,
        durationMs: asset.durationMs,
        hasThumbnail: Boolean(asset.thumbnail?.length),
        isViewOnce: asset.isViewOnce || isViewOnceType
      };
    }
    if (!message.hasMedia) {
      return null;
    }
    const queue = this.mediaQueue.get(message.sourceMessageKey);
    const availability: MediaAvailabilityState =
      queue?.status === "pending"
        ? "pending"
        : queue?.status === "downloading" || queue?.status === "retry"
          ? "downloading"
          : queue?.status === "failed" || queue?.status === "expired_unrecoverable"
            ? "expired_unrecoverable"
            : message.sourceTable.startsWith("wa-web")
              ? "not_captured"
              : "import_missing";
    return {
      availability,
      assetId: null,
      mimeType: null,
      byteSize: null,
      width: null,
      height: null,
      durationMs: null,
      hasThumbnail: false,
      isViewOnce: Boolean(queue?.isViewOnce) || isViewOnceType
    };
  }

  private findUpdateTarget(update: Omit<LiveMessageUpdateRecord, "applied">): (MessageRecord & { id: number }) | undefined {
    const messageId = messageIdFromKey(update.sourceMessageKey);
    if (!messageId) {
      return undefined;
    }
    return [...this.messages.values()].find(
      (message) => message.chatSourceId === update.chatSourceId && message.sourceMessageId === messageId
    );
  }

  async reconcileLiveState(): Promise<{ staleSessions: number; staleRuns: number }> {
    let staleSessions = 0;
    let staleRuns = 0;
    if (this.liveSession && (this.liveSession.status === "connected" || this.liveSession.status === "pairing")) {
      this.liveSession.status = "stopped";
      this.liveSession.lastError = null;
      this.liveSession.updatedAt = new Date().toISOString();
      staleSessions += 1;
    }
    for (const run of this.liveRuns.values()) {
      if (run.status === "running") {
        run.status = "failed";
        run.finishedAt = new Date().toISOString();
        run.errorMessage = "Live sync run was interrupted by a process restart.";
        staleRuns += 1;
      }
    }
    return { staleSessions, staleRuns };
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
      gapGroups: groupGaps(openGaps),
      identityHealth: await this.computeIdentityHealth(),
      media: await this.getMediaQueueSummary(),
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

  private async computeIdentityHealth(): Promise<{ unnamedGroups: number; unresolvedLids: number; samples: string[] }> {
    const unnamed = await this.listUnnamedGroupChats(1000);
    const lidJids = new Set<string>();
    for (const chat of this.chats.values()) {
      if (chat.sourceChatId.endsWith("@lid") || chat.sourceChatId.endsWith("@hosted.lid")) {
        lidJids.add(chat.sourceChatId);
      }
    }
    for (const message of this.messages.values()) {
      const sender = message.senderSourceJid;
      if (sender && (sender.endsWith("@lid") || sender.endsWith("@hosted.lid"))) {
        lidJids.add(sender);
      }
    }
    const unresolved = [...lidJids].filter((jid) => !this.identityLinks.has(jid));
    return { unnamedGroups: unnamed.length, unresolvedLids: unresolved.length, samples: unnamed.slice(0, 5) };
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
    const searchDigits = search ? search.replace(/\D/g, "") : "";
    return [...this.chats.values()]
      .filter(
        (chat) =>
          !search ||
          chat.displayName?.toLowerCase().includes(search) ||
          chat.jid.toLowerCase().includes(search) ||
          (searchDigits.length >= 4 && chat.jid.includes(searchDigits))
      )
      .filter((chat) => !options.type || options.type === "all" || chat.chatType === options.type)
      .filter((chat) => options.includeEventOnly || this.hasVisibleExchange(chat.sourceChatId))
      .sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""))
      .slice(options.offset, options.offset + options.limit)
      .map((chat) => ({
        id: chat.id,
        sourceChatId: chat.sourceChatId,
        jid: chat.jid,
        displayName: chat.displayName?.trim() && chat.displayName !== chat.jid ? chat.displayName : displayPhoneFromJid(chat.jid),
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
        // Legacy rows may carry the group's own JID as the sender; unknown, not "the group".
        const groupSelfSender = chat.chatType === "group" && message.senderSourceJid === chat.sourceChatId;
        const sender = !groupSelfSender && message.senderSourceJid ? this.contacts.get(message.senderSourceJid) : null;
        const mentionLabels = this.resolveMentionLabels([message.body ?? null, message.caption ?? null]);
        const media = this.deriveMediaState(message);
        const hasHeldContent = Boolean(message.body?.trim() || message.caption?.trim() || media?.availability === "stored");
        const preview = this.linkPreviews.get(message.sourceMessageKey) ?? null;
        const revisions = this.editRevisions.get(message.sourceMessageKey) ?? [];
        return {
          id: message.id,
          sourceMessageId: message.sourceMessageId,
          senderDisplayName: groupSelfSender
            ? null
            : sender?.displayName?.trim() || sender?.pushName?.trim() || sender?.phoneNumber || displayPhoneFromJid(message.senderSourceJid),
          senderSourceJid: message.senderSourceJid ?? null,
          timestampMs: message.timestampMs ?? null,
          sentAt: message.timestampMs ? new Date(message.timestampMs).toISOString() : null,
          direction: message.direction,
          messageType: message.messageType,
          interpretation: interpretMessage({
            messageType: message.messageType,
            isDeleted: message.isDeleted,
            hasHeldContent,
            mediaAvailability: media?.availability ?? null
          }),
          body: applyMentionLabels(message.body ?? null, mentionLabels),
          caption: applyMentionLabels(message.caption ?? null, mentionLabels),
          mentions: appliedMentionLabels([message.body ?? null, message.caption ?? null], mentionLabels),
          hasMedia: message.hasMedia,
          mediaMimeType: message.mediaMimeType ?? null,
          mediaName: message.mediaName ?? null,
          media,
          linkPreview: preview
            ? {
                title: preview.title,
                description: preview.description,
                canonicalUrl: preview.canonicalUrl,
                hasThumbnail: Boolean(preview.thumbnail?.length)
              }
            : null,
          isEdited: Boolean(message.rawMetadata?.edited) || revisions.length > 0,
          editRevisionCount: revisions.length,
          isDeleted: message.isDeleted,
          isForwarded: message.isForwarded,
          isStarred: message.isStarred
        };
      });
  }

  async listMessagesAround(chatId: number, messageId: number, radius: number): Promise<MessageContextWindow | null> {
    const chat = [...this.chats.values()].find((candidate) => candidate.id === chatId);
    if (!chat) {
      return null;
    }
    const all = [...this.messages.values()]
      .filter((message) => message.chatSourceId === chat.sourceChatId)
      .sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0) || a.id - b.id);
    const anchorIndex = all.findIndex((message) => message.id === messageId);
    if (anchorIndex < 0) {
      return null;
    }
    const start = Math.max(0, anchorIndex - radius);
    const messages = await this.listMessages(chatId, { limit: radius * 2 + 1, offset: start, order: "asc" });
    return {
      messages,
      newerCount: Math.max(0, all.length - (start + messages.length)),
      anchorMessageId: messageId
    };
  }

  async getSearchIndexStatus(): Promise<SearchIndexStatus> {
    // The in-memory adapter scans live data; there is no separate index to
    // fall out of date, so search is always available.
    return { state: "ready", totalMessages: this.messages.size };
  }

  async rebuildSearchIndex(onProgress?: (processedMessages: number, totalMessages: number) => void): Promise<{ indexedMessages: number }> {
    onProgress?.(this.messages.size, this.messages.size);
    return { indexedMessages: this.messages.size };
  }

  async searchMessages(options: SearchQueryOptions): Promise<SearchResponse> {
    const index = await this.getSearchIndexStatus();
    const tokens = (options.query.match(/"[^"]*"|\S+/g) ?? [])
      .map((token) => token.replace(/^"|"$/g, "").trim().toLowerCase())
      .filter(Boolean);
    if (tokens.length === 0) {
      return { index, totalMatches: 0, results: [] };
    }
    const chatBysourceId = new Map([...this.chats.values()].map((chat) => [chat.sourceChatId, chat]));
    const scored: Array<{ item: SearchResultItem; score: number }> = [];
    const nowMs = Date.now();
    for (const message of this.messages.values()) {
      const chat = chatBysourceId.get(message.chatSourceId);
      if (!chat) {
        continue;
      }
      if (options.chatId != null && chat.id !== options.chatId) {
        continue;
      }
      if (options.afterMs != null && (message.timestampMs ?? 0) < options.afterMs) {
        continue;
      }
      if (options.beforeMs != null && (message.timestampMs ?? Number.MAX_SAFE_INTEGER) > options.beforeMs) {
        continue;
      }
      if (options.direction && message.direction !== options.direction) {
        continue;
      }
      const isMediaLike =
        message.hasMedia || ["image", "video", "audio", "document", "sticker", "view_once", "ptv"].includes(message.messageType);
      if (options.type === "text" && (message.hasMedia || message.messageType === "call")) {
        continue;
      }
      if (options.type === "media" && !isMediaLike) {
        continue;
      }
      if (options.type === "call" && message.messageType !== "call") {
        continue;
      }
      if (!options.includeNoise && !isVisibleExchangeMessage(message)) {
        continue;
      }
      const sender = message.senderSourceJid ? this.contacts.get(message.senderSourceJid) : null;
      const senderLabel =
        sender?.displayName?.trim() || sender?.pushName?.trim() || sender?.phoneNumber || displayPhoneFromJid(message.senderSourceJid) || null;
      if (options.sender) {
        const wanted = options.sender.trim().toLowerCase();
        const senderMatches = wanted.includes("@")
          ? message.senderSourceJid === options.sender.trim()
          : Boolean(senderLabel && senderLabel.toLowerCase().includes(wanted));
        if (!senderMatches) {
          continue;
        }
      }
      const mentionLabels = this.resolveMentionLabels([message.body ?? null, message.caption ?? null]);
      const haystackFields = [
        applyMentionLabels(message.body ?? null, mentionLabels),
        applyMentionLabels(message.caption ?? null, mentionLabels),
        message.body ?? null,
        message.caption ?? null,
        message.mediaName ?? null,
        senderLabel
      ];
      const haystack = haystackFields.filter(Boolean).join("\n").toLowerCase();
      if (!tokens.every((token) => haystack.includes(token))) {
        continue;
      }
      const ageDays = message.timestampMs != null ? Math.max(0, (nowMs - message.timestampMs) / 86_400_000) : 365;
      const recency = 0.2 + 0.8 * Math.pow(0.5, ageDays / 90);
      const score = tokens.length * recency;
      const snippetSource =
        haystackFields.find((field) => field && field.toLowerCase().includes(tokens[0])) ?? haystackFields.find(Boolean) ?? "";
      scored.push({
        score,
        item: {
          layer: "message",
          messageId: message.id,
          sourceMessageKey: message.sourceMessageKey,
          sourceMessageId: message.sourceMessageId,
          chatId: chat.id,
          chatSourceId: chat.sourceChatId,
          chatDisplayName: chat.displayName?.trim() && chat.displayName !== chat.jid ? chat.displayName : displayPhoneFromJid(chat.jid),
          chatType: chat.chatType,
          senderDisplayName: senderLabel,
          senderSourceJid: message.senderSourceJid ?? null,
          timestampMs: message.timestampMs ?? null,
          sentAt: message.timestampMs ? new Date(message.timestampMs).toISOString() : null,
          direction: message.direction,
          messageType: message.messageType,
          interpretation: interpretMessage({
            messageType: message.messageType,
            isDeleted: message.isDeleted,
            hasHeldContent: Boolean(message.body?.trim() || message.caption?.trim() || message.hasMedia),
            mediaAvailability: null
          }),
          snippet: buildMemorySnippet(snippetSource ?? "", tokens[0]),
          score,
          hasMedia: message.hasMedia,
          isDeleted: message.isDeleted
        }
      });
    }
    scored.sort((a, b) => b.score - a.score || (b.item.timestampMs ?? 0) - (a.item.timestampMs ?? 0));
    return {
      index,
      totalMatches: scored.length,
      results: scored.slice(options.offset, options.offset + options.limit).map((entry) => entry.item)
    };
  }

  // --- Brain substrate (mirrors the SQLite adapter's semantics) ---

  // Mirror of the SQLite compound-cursor predicate: a message is covered only
  // when a watermark exists and it sorts at or before (timestamp, rowid).
  private isMessagePending(message: MessageRecord & { id: number }, chatSourceId: string): boolean {
    const cursor = this.brainWatermarks.get(chatSourceId);
    if (!cursor) {
      return true;
    }
    const ts = message.timestampMs ?? 0;
    return ts > cursor.assimilatedThroughMs || (ts === cursor.assimilatedThroughMs && message.id > cursor.assimilatedThroughId);
  }

  // Every message seen at or below `throughMs` in this chat — the rowid half of
  // the cursor. A later same-timestamp message gets a higher id and stays pending.
  private boundaryRowidForChat(chatSourceId: string, throughMs: number): number {
    let maxId = 0;
    for (const message of this.messages.values()) {
      if (message.chatSourceId === chatSourceId && (message.timestampMs ?? 0) <= throughMs && message.id > maxId) {
        maxId = message.id;
      }
    }
    return maxId;
  }

  async getBrainChatBacklog(options: { limit: number; minPending?: number }): Promise<BrainChatBacklogItem[]> {
    const minPending = Math.max(1, options.minPending ?? 1);
    const items: BrainChatBacklogItem[] = [];
    for (const chat of this.chats.values()) {
      const watermark = this.brainWatermarks.get(chat.sourceChatId);
      const pendingMessages = [...this.messages.values()].filter(
        (message) =>
          message.chatSourceId === chat.sourceChatId &&
          isVisibleExchangeMessage(message) &&
          this.isMessagePending(message, chat.sourceChatId)
      );
      if (pendingMessages.length >= minPending) {
        items.push({
          chatSourceId: chat.sourceChatId,
          chatDisplayName: chat.displayName ?? null,
          assimilatedThroughMs: watermark?.assimilatedThroughMs ?? 0,
          assimilatedThroughId: watermark?.assimilatedThroughId ?? 0,
          lastEpisodeAt: watermark?.lastEpisodeAt ?? null,
          pendingVisibleMessages: pendingMessages.length,
          newestVisibleMs: pendingMessages.reduce<number | null>((max, message) => Math.max(max ?? 0, message.timestampMs ?? 0), null)
        });
      }
    }
    return items.sort((a, b) => b.pendingVisibleMessages - a.pendingVisibleMessages).slice(0, options.limit);
  }

  async advanceBrainWatermark(chatSourceId: string, throughMs: number): Promise<void> {
    const existing = this.brainWatermarks.get(chatSourceId);
    const throughId = this.boundaryRowidForChat(chatSourceId, throughMs);
    // Keep the greater (timestamp, rowid) cursor lexicographically.
    const next =
      !existing ||
      throughMs > existing.assimilatedThroughMs ||
      (throughMs === existing.assimilatedThroughMs && throughId > existing.assimilatedThroughId)
        ? { assimilatedThroughMs: throughMs, assimilatedThroughId: throughId }
        : { assimilatedThroughMs: existing.assimilatedThroughMs, assimilatedThroughId: existing.assimilatedThroughId };
    this.brainWatermarks.set(chatSourceId, { ...next, lastEpisodeAt: new Date().toISOString() });
  }

  async enqueueBrainTasks(tasks: BrainTaskInput[]): Promise<number> {
    let enqueued = 0;
    for (const task of tasks) {
      if (this.brainTasks.has(task.dedupeKey)) {
        continue;
      }
      this.brainTasks.set(task.dedupeKey, {
        id: this.nextBrainTaskId++,
        kind: task.kind,
        chatSourceId: task.chatSourceId ?? null,
        payload: task.payload ?? null,
        dedupeKey: task.dedupeKey,
        status: "pending",
        priority: task.priority ?? 0,
        attempts: 0,
        nextAttemptAtMs: null,
        lastError: null
      });
      enqueued += 1;
    }
    return enqueued;
  }

  async claimDueBrainTasks(limit: number, nowMs = Date.now()): Promise<BrainTaskRecord[]> {
    const due = [...this.brainTasks.values()]
      .filter((task) => task.status === "pending" && (task.nextAttemptAtMs == null || task.nextAttemptAtMs <= nowMs))
      .sort((a, b) => b.priority - a.priority || a.id - b.id)
      .slice(0, limit);
    for (const task of due) {
      task.status = "running";
    }
    return structuredClone(due);
  }

  async completeBrainTask(id: number): Promise<void> {
    const task = [...this.brainTasks.values()].find((candidate) => candidate.id === id);
    if (task) {
      task.status = "done";
      task.lastError = null;
    }
  }

  async failBrainTask(id: number, error: string, options?: { retryInMs?: number | null }): Promise<void> {
    const task = [...this.brainTasks.values()].find((candidate) => candidate.id === id);
    if (!task) {
      return;
    }
    task.attempts += 1;
    task.lastError = error;
    if (options?.retryInMs != null) {
      task.status = "pending";
      task.nextAttemptAtMs = Date.now() + options.retryInMs;
    } else {
      task.status = "failed";
    }
  }

  async resetInFlightBrainTasks(_staleClaimMs = 30 * 60_000): Promise<number> {
    let reset = 0;
    for (const task of this.brainTasks.values()) {
      if (task.status === "running") {
        task.status = "pending";
        reset += 1;
      }
    }
    return reset;
  }

  async getBrainTaskSummary(): Promise<BrainTaskSummary> {
    const summary: BrainTaskSummary = { pending: 0, running: 0, failed: 0, done: 0 };
    for (const task of this.brainTasks.values()) {
      summary[task.status] += 1;
    }
    return summary;
  }

  private ownerDisplayName: string | null = null;

  async getArchiveOwnerName(): Promise<string | null> {
    return this.ownerDisplayName;
  }

  async setArchiveOwnerName(displayName: string | null): Promise<void> {
    this.ownerDisplayName = displayName?.trim() || null;
  }

  async reconcileBrainRuns(): Promise<number> {
    let reconciled = 0;
    for (const run of this.brainRuns.values()) {
      if (run.status === "running") {
        run.status = "interrupted";
        run.finishedAt = new Date().toISOString();
        run.errorMessage = "Interrupted by a server restart.";
        reconciled += 1;
      }
    }
    return reconciled;
  }

  async startBrainRun(kind: BrainRunSummary["kind"], timezone?: string | null): Promise<string> {
    const id = crypto.randomUUID();
    this.brainRuns.set(id, {
      id,
      kind,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      timezone: timezone ?? null,
      totals: null,
      errorMessage: null
    });
    return id;
  }

  async completeBrainRun(runId: string, totals: Record<string, number>): Promise<void> {
    const run = this.brainRuns.get(runId);
    if (run) {
      run.status = "completed";
      run.finishedAt = new Date().toISOString();
      run.totals = totals;
    }
  }

  async getBrainRun(runId: string): Promise<BrainRunSummary | null> {
    const run = this.brainRuns.get(runId);
    return run ? structuredClone(run) : null;
  }

  async failBrainRun(
    runId: string,
    status: "failed" | "interrupted" | "budget_exceeded",
    message: string,
    totals?: Record<string, number>
  ): Promise<void> {
    const run = this.brainRuns.get(runId);
    if (run) {
      run.status = status;
      run.finishedAt = new Date().toISOString();
      run.errorMessage = message;
      if (totals) {
        run.totals = totals;
      }
    }
  }

  async tryAcquireBrainLock(runId: string): Promise<boolean> {
    if (this.brainLockRunId && this.brainLockRunId !== runId) {
      return false;
    }
    this.brainLockRunId = runId;
    return true;
  }

  async releaseBrainLock(runId: string): Promise<void> {
    if (this.brainLockRunId === runId) {
      this.brainLockRunId = null;
    }
  }

  async recordBrainLlmUsage(entry: {
    purpose: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    estimated?: boolean;
  }): Promise<void> {
    const now = Date.now();
    this.brainLedger.push({ ...entry, estimated: entry.estimated ?? false, atMs: now, day: new Date(now).toISOString().slice(0, 10) });
  }

  async getBrainLlmUsage(options: { sinceMs?: number; day?: string }): Promise<BrainLlmUsageSummary> {
    const entries = this.brainLedger.filter((entry) =>
      options.day != null ? entry.day === options.day : entry.atMs >= (options.sinceMs ?? 0)
    );
    return {
      calls: entries.length,
      inputTokens: entries.reduce((sum, entry) => sum + entry.inputTokens, 0),
      outputTokens: entries.reduce((sum, entry) => sum + entry.outputTokens, 0)
    };
  }

  async getBrainStatus(): Promise<BrainStatusSummary> {
    const visible = [...this.messages.values()].filter((message) => isVisibleExchangeMessage(message));
    // Assimilated is total − pending from the one shared predicate.
    const assimilated = visible.filter((message) => !this.isMessagePending(message, message.chatSourceId));
    const backlog = await this.getBrainChatBacklog({ limit: 8 });
    const runs = [...this.brainRuns.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return {
      ownerName: this.ownerDisplayName,
      totalVisibleMessages: visible.length,
      assimilatedVisibleMessages: assimilated.length,
      coveragePercent: visible.length > 0 ? Math.round((assimilated.length / visible.length) * 1000) / 10 : 100,
      chatsWithBacklog: backlog.length,
      backlogSample: backlog,
      tasks: await this.getBrainTaskSummary(),
      usageToday: await this.getBrainLlmUsage({ day: new Date().toISOString().slice(0, 10) }),
      latestRun: runs[0] ?? null,
      activeRun: runs.find((run) => run.status === "running") ?? null
    };
  }

  async resetBrainDerivedData(options?: { chatSourceId?: string | null }): Promise<{ episodeIds: string[]; watermarks: number }> {
    const chat = options?.chatSourceId ?? null;
    const episodeIds = [...this.brainEpisodes.values()]
      .filter((episode) => !chat || episode.chatSourceId === chat)
      .map((episode) => episode.id);
    for (const id of episodeIds) {
      this.brainEpisodes.delete(id);
    }
    let watermarks = 0;
    for (const key of [...this.brainWatermarks.keys()]) {
      if (!chat || key === chat) {
        this.brainWatermarks.delete(key);
        watermarks += 1;
      }
    }
    // Clear the work queue too so no stale task resurrects derived data.
    for (const [dedupeKey, task] of [...this.brainTasks.entries()]) {
      if (!chat || task.chatSourceId === chat) {
        this.brainTasks.delete(dedupeKey);
      }
    }
    return { episodeIds, watermarks };
  }

  async commitBrainEpisode(episode: BrainEpisodeInput): Promise<BrainEpisodeRecord> {
    const id = crypto.randomUUID();
    const record: BrainEpisodeRecord = {
      id,
      chatSourceId: episode.chatSourceId,
      chatDisplayName: this.chats.get(episode.chatSourceId)?.displayName ?? null,
      startAtMs: episode.startAtMs,
      endAtMs: episode.endAtMs,
      messageCount: episode.messageCount,
      participants: episode.participants,
      summary: episode.summary,
      markdown: episode.markdown,
      generator: episode.generator,
      model: episode.model,
      status: "current",
      fallbackReason: episode.fallbackReason ?? null,
      createdAt: new Date().toISOString(),
      claims: episode.claims.map((claim) => ({
        id: crypto.randomUUID(),
        kind: claim.kind,
        text: claim.text,
        citations: claim.citations.map((key) => {
          const message = [...this.messages.values()].find((candidate) => candidate.sourceMessageKey === key) ?? null;
          return {
            sourceMessageKey: key,
            sourceChatId: episode.chatSourceId,
            messageId: message?.id ?? null,
            senderSourceJid: message?.senderSourceJid ?? null,
            timestampMs: message?.timestampMs ?? null
          };
        })
      }))
    };
    this.brainEpisodes.set(id, record);
    await this.advanceBrainWatermark(episode.chatSourceId, episode.endAtMs);
    return structuredClone(record);
  }

  async updateBrainEpisodeMarkdown(episodeId: string, markdown: string): Promise<void> {
    const episode = this.brainEpisodes.get(episodeId);
    if (episode) {
      episode.markdown = markdown;
    }
  }

  async listBrainEpisodes(options: { chatSourceId?: string | null; episodeId?: string; limit: number }): Promise<BrainEpisodeRecord[]> {
    return structuredClone(
      [...this.brainEpisodes.values()]
        .filter((episode) => !options.episodeId || episode.id === options.episodeId)
        .filter((episode) => !options.chatSourceId || episode.chatSourceId === options.chatSourceId)
        .sort((a, b) => b.endAtMs - a.endAtMs)
        .slice(0, options.limit)
    );
  }

  async markStaleEpisodesForMessages(sourceMessageKeys: string[]): Promise<number> {
    const keys = new Set(sourceMessageKeys.filter((key) => typeof key === "string" && key.length > 0));
    if (keys.size === 0) {
      return 0;
    }
    const tasks: BrainTaskInput[] = [];
    let marked = 0;
    for (const episode of this.brainEpisodes.values()) {
      if (episode.status !== "current") {
        continue;
      }
      const cited = episode.claims.some((claim) => claim.citations.some((citation) => keys.has(citation.sourceMessageKey)));
      if (!cited) {
        continue;
      }
      episode.status = "stale";
      marked += 1;
      tasks.push({
        kind: "episode",
        chatSourceId: episode.chatSourceId,
        payload: { chatSourceId: episode.chatSourceId, sinceMs: episode.startAtMs, throughMs: episode.endAtMs, regen: true, episodeId: episode.id },
        dedupeKey: `regen:${episode.id}`,
        priority: 1_000
      });
    }
    await this.enqueueBrainTasks(tasks);
    return marked;
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
    const evidence = [...this.messages.values()]
      .filter((message) => message.timestampMs != null)
      .filter((message) => options.startAtMs == null || (message.timestampMs ?? 0) >= options.startAtMs)
      .filter((message) => options.endAtMs == null || (message.timestampMs ?? 0) <= options.endAtMs)
      .filter((message) => !chatSet || chatSet.has(message.chatSourceId))
      .sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0) || a.id - b.id)
      .slice(0, options.limit)
      .map((message, index) => this.toMemoryEvidence(message, index));
    this.attachReactions(evidence);
    return evidence;
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

  private resolveMentionLabels(texts: Array<string | null>): Map<string, string> {
    const digitsSet = extractMentionDigits(texts);
    const labels = new Map<string, string>();
    for (const digits of digitsSet) {
      for (const candidate of mentionJidCandidates(digits)) {
        const canonical = this.canonicalJid(candidate) ?? candidate;
        const contact = this.contacts.get(canonical);
        const label = contact?.displayName?.trim() || contact?.pushName?.trim() || contact?.phoneNumber || null;
        if (label) {
          labels.set(digits, label);
          break;
        }
      }
    }
    return labels;
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
      // Mirror the SQLite evidence query: contact name/push/phone, then a PN
      // fallback, else null so the brain applies its own number label (a raw JID
      // must never leak through as a display name).
      senderDisplayName: sender?.displayName?.trim() || sender?.pushName?.trim() || sender?.phoneNumber || displayPhoneFromJid(message.senderSourceJid),
      timestampMs: message.timestampMs ?? null,
      sentAt: message.timestampMs ? new Date(message.timestampMs).toISOString() : null,
      direction: message.direction,
      messageType: message.messageType,
      interpretation: interpretMessage({ messageType: message.messageType }),
      text: message.body ?? message.caption ?? null,
      isForwarded: Boolean(message.isForwarded),
      quotedSourceMessageId: message.quotedSourceMessageId ?? null,
      reactions: []
    };
  }

  private attachReactions(evidence: MemoryEvidenceMessage[]): void {
    if (evidence.length === 0) {
      return;
    }
    const byKey = new Map<string, MemoryEvidenceMessage>();
    for (const message of evidence) {
      message.reactions = [];
      byKey.set(message.sourceMessageKey, message);
    }
    const reactions = [...this.liveUpdates.values()]
      .filter((update) => update.updateType === "reaction" && update.applied)
      .sort((a, b) => (a.occurredAtMs ?? 0) - (b.occurredAtMs ?? 0));
    for (const update of reactions) {
      const target = byKey.get(update.sourceMessageKey);
      const emoji = typeof update.metadata?.emoji === "string" ? update.metadata.emoji : "";
      if (!target || !emoji) {
        continue;
      }
      const reactorJid = (update.metadata?.reactorJid as string | null | undefined) ?? null;
      const contact = reactorJid ? this.contacts.get(reactorJid) : null;
      target.reactions.push({
        emoji,
        reactorJid,
        reactorDisplayName: contact?.displayName?.trim() || contact?.pushName?.trim() || contact?.phoneNumber || displayPhoneFromJid(reactorJid)
      });
    }
  }

  async resolveQuotedReferents(
    chatSourceId: string,
    quotedSourceMessageIds: string[]
  ): Promise<Map<string, { senderLabel: string; snippet: string }>> {
    const result = new Map<string, { senderLabel: string; snippet: string }>();
    const ids = new Set(quotedSourceMessageIds.filter((id) => id && id.trim()));
    if (ids.size === 0) {
      return result;
    }
    const ownerName = (await this.getArchiveOwnerName()) ?? "the archive owner";
    for (const message of this.messages.values()) {
      if (message.chatSourceId !== chatSourceId || !ids.has(message.sourceMessageId) || result.has(message.sourceMessageId)) {
        continue;
      }
      const isSelf = message.direction === "outgoing" || message.senderSourceJid === "me";
      const contact = message.senderSourceJid ? this.contacts.get(message.senderSourceJid) : null;
      const label = isSelf
        ? ownerName
        : contact?.displayName?.trim() || contact?.pushName?.trim() || contact?.phoneNumber || displayPhoneFromJid(message.senderSourceJid) || "someone";
      result.set(message.sourceMessageId, { senderLabel: label, snippet: (message.body ?? message.caption ?? "").trim().slice(0, 80) });
    }
    return result;
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

function displayPhoneFromJid(jid: string | null | undefined): string | null {
  if (!jid) {
    return null;
  }
  const [user, server] = jid.split("@");
  if (server !== "s.whatsapp.net" && server !== "c.us") {
    return null;
  }
  const digits = user?.split(":")[0]?.replace(/\D/g, "");
  return digits ? `+${digits}` : null;
}

// Mirrors the SQLite visibleExchangePredicate: what a user would recognize as
// conversation, driving the default search noise filter.
function isVisibleExchangeMessage(message: MessageRecord): boolean {
  if (["system", "status", "reaction", "encrypted_update"].includes(message.messageType)) {
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

// Highlighted excerpt around the first occurrence of the leading query token.
function buildMemorySnippet(source: string, token: string): string {
  if (!source) {
    return "";
  }
  const lower = source.toLowerCase();
  const at = lower.indexOf(token);
  if (at < 0) {
    return source.slice(0, 160);
  }
  const start = Math.max(0, at - 60);
  const end = Math.min(source.length, at + token.length + 60);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < source.length ? "…" : "";
  return (
    prefix +
    source.slice(start, at) +
    SEARCH_HIGHLIGHT_START +
    source.slice(at, at + token.length) +
    SEARCH_HIGHLIGHT_END +
    source.slice(at + token.length, end) +
    suffix
  );
}

function maxNullableMs(left: number | null, right: number | null): number | null {
  if (left == null) return right;
  if (right == null) return left;
  return Math.max(left, right);
}

function groupGaps(gaps: LiveGapWindowRecord[]): Array<{ status: LiveGapStatus; reason: LiveGapWindowRecord["reason"]; count: number }> {
  const groups = new Map<string, { status: LiveGapStatus; reason: LiveGapWindowRecord["reason"]; count: number }>();
  for (const gap of gaps) {
    const key = `${gap.status}\u0000${gap.reason}`;
    const group = groups.get(key) ?? { status: gap.status, reason: gap.reason, count: 0 };
    group.count += 1;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function isVisibleExchange(message: MessageRecord): boolean {
  if (
    message.messageType === "system" ||
    message.messageType === "status" ||
    message.messageType === "reaction" ||
    message.messageType === "encrypted_update"
  ) {
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

// True when a "name" is just the identity restated (bare digits of the JID's
// local part, or the JID itself) — permitted as a fill, never as a label.
function isIdentityDerivedName(name: string, jid: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) {
    return true;
  }
  const localPart = localPartFromJid(jid);
  return trimmed === jid || trimmed === localPart || trimmed.replace(/\D/g, "") === localPart;
}

function localPartFromJid(jid: string): string {
  return jid.split("@")[0]?.split(":")[0] ?? jid;
}
