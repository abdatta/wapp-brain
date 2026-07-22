import type {
  ArchiveRepository,
  ArchiveRestorePoint
} from "./repository";
import type {
  ArchiveSignalBatch,
  ArchiveSignalObservation,
  BrainBackfillDbStats,
  BrainBackfillModelSpend,
  BrainChatBacklogItem,
  BrainClaimGradeRecord,
  BrainClaimGradeValue,
  BrainConflictPair,
  BrainDocCommitResult,
  BrainDocDetail,
  BrainDocDueReason,
  BrainDocKind,
  BrainDocListItem,
  BrainDocRecord,
  BrainDocRevisionRecord,
  BrainDocSection,
  BrainDocSectionView,
  BrainDocStatementView,
  BrainDocsListResponse,
  BrainDocsListView,
  BrainRollupInput,
  BrainRollupInputClaim,
  BrainRollupRevisionInput,
  BrainEpisodeGenerator,
  BrainEpisodeInput,
  BrainEpisodeRecord,
  BrainEvalRunRecord,
  BrainGradingCitation,
  BrainGradingSample,
  BrainGradingSampleClaim,
  BrainCitationRecord,
  BrainGraphEdgeCitation,
  BrainGraphEdgeEvidenceView,
  BrainGraphEdgeKind,
  BrainGraphEdgeView,
  BrainGraphEntityClaim,
  BrainGraphEntityView,
  BrainGraphNeighborhoodEdge,
  BrainGraphNeighborhoodParams,
  BrainGraphNeighborhoodView,
  BrainGraphNodeKind,
  BrainGraphNodeRecord,
  BrainGraphNodeStatus,
  BrainGraphRebuildResult,
  BrainGraphRecomputeResult,
  BrainGraphStats,
  BrainGraphSyncResult,
  BrainGraphUnresolvedEntity,
  BrainGraphNodeSuggestion,
  BrainLifecycleApplyResult,
  BrainLifecycleCandidate,
  BrainLifecycleCiteView,
  BrainLifecycleEventRecord,
  BrainLifecycleItem,
  BrainLifecycleDetailCandidate,
  BrainLifecycleItemDetail,
  BrainLifecycleListResponse,
  BrainLifecycleResolutionView,
  BrainLifecycleSort,
  BrainLifecycleSource,
  BrainLifecycleStatus,
  BrainLifecycleSweepBatch,
  BrainLifecycleSweepNode,
  BrainLifecycleTransitionInput,
  BrainModelQualityAggregate,
  BrainLlmUsageSummary,
  BrainMediaGapImpact,
  BrainMediaGapSummary,
  BrainResolutionDebtIdentity,
  BrainResolutionDebtSummary,
  BrainRunEffectLifecycle,
  BrainRunEffectRevision,
  BrainRunEffects,
  BrainRunKind,
  BrainRunListItem,
  BrainRunSummary,
  BrainStatusSummary,
  BrainTaskInput,
  BrainTaskKind,
  BrainTaskRecord,
  BrainTaskSummary,
  BrainValidationIssueInput,
  BrainValidationIssueRecord,
  BrainValidationIssueSummary,
  CapturedLinkPreview,
  ChatListItem,
  ChatListOptions,
  ChatRecord,
  ChatMetadataHistoryRecord,
  ChatSyncStateRecord,
  ContactRecord,
  EngagementAggregateRecord,
  IdentityRecentMedia,
  IdentityRecentMessage,
  IdentityRepairResult,
  GroupMembershipEventRecord,
  GroupMembershipPeriodRecord,
  IdentityNumberChangeRecord,
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
  MessageDetail,
  MessageLocationObservationRecord,
  MessageStructuredSignals,
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
  OwnerIdentitySuggestion,
  OwnerSelfIdentity,
  QuotedMessageSnapshot,
  QuotedMessageSnapshotSummary,
  ParticipantRecord,
  RecoveryAnchorRecord,
  RetainedPayloadRecord,
  SearchIndexStatus,
  SearchQueryOptions,
  SearchResponse,
  SearchResultItem,
  StatusSummary,
  GoogleContactGroupEntry,
  IdentityActivitySummary,
  IdentityChatActivity,
  IdentityProfile,
  PersonConnectResult,
  PersonDisconnectResult,
  PersonLinkEventRecord,
  PersonLinkSuppressionRecord,
  PersonLookupResult,
  PersonMemberRecord,
  PersonMemberSource,
  PersonRecord,
  PersonRedirectRecord,
  PersonSuggestionInput,
  PersonSuggestionKind,
  PersonSuggestionRecord,
  PersonSuggestionStatus
} from "../../shared/types";
import { createHash, randomUUID } from "node:crypto";
import { SEARCH_HIGHLIGHT_END, SEARCH_HIGHLIGHT_START } from "../../shared/types";
import { config } from "../config";
import { baselineFromStatus } from "../live/baseline";
import { messageIdFromKey, messageKey } from "../identity/keys";
import { applyMentionLabels, appliedMentionLabels, extractMentionDigits, mentionJidCandidates } from "../identity/mentions";
import { mergeInteractionMetadata } from "./interactions";
import { buildMessageEditTimeline, summarizeStructuredSignals, summarizeSystemEvents } from "./signalSummary";
import { interpretMessage } from "../interpretation/messageInterpretation";
import {
  chatNaturalKey,
  computeGraphSalience,
  deriveEpisodeGraph,
  engagementFactorFromAggregates,
  graphDormancyThreshold,
  normalizeGraphName,
  personJidNaturalKey,
  slugForGraphNode,
  type EpisodeGraphContext,
  type GraphEpisodeSource,
  type GraphEvidenceSpec,
  type GraphMutations,
  type GraphNodeSpec
} from "../brain/graph";
import { BRAIN_DOC_REVISION_NONE } from "../../shared/types";
import {
  detectConflictPairs,
  docIdFor,
  renderDocMarkdown,
  rollupDueNewClaims,
  rollupMinClaims,
  rollupStaleDropShare,
  runRollupGuard,
  type ConflictClaimFacts,
  type DocRenderClaimMeta,
  type DocRenderContext,
  type OverviewRenderData
} from "../brain/rollups";
import {
  compareLifecycleItems,
  computeLifecycleFlags,
  foldLifecycleEvents,
  LIFECYCLE_MAX_CANDIDATES_PER_NODE,
  LIFECYCLE_SWEEP_MAX_NODES_PER_CALL,
  lifecycleStaleDays,
  projectLifecyclePayload,
  sortLifecycleItems,
  validateLifecycleTransition,
  type LifecycleFold
} from "../brain/lifecycle";
import { resolveNeighborhoodParams, shapeNeighborhood, type NeighborhoodWalk } from "../brain/graphQuery";
import { episodeFileBase } from "../brain/vaultNames";
import { isMaskedNumberLabel, normalizeJid, phoneFromJid, resolveDisplayLabel } from "../import/jid";
import { normalizeOwnerSelfInput } from "../identity/ownerSelf";
import { disambiguateLabels } from "../persons/disambiguate";
import { personDisplayLabelFromMembers } from "../persons/label";
import { getMemoryProviderStatus } from "../memory/provider";
import { PublicError } from "../privacy";
import { termAliasSeedRows } from "../search/aliasSeed";
import {
  attachAliasVariants,
  buildBasePlans,
  buildDroppedPlans,
  countTermCoverage,
  dfProbesForToken,
  groupMatchesWords,
  normalizeTerm,
  normalizedWords,
  planMatchesWords,
  tokenizeSearchQuery,
  tokenLenientlyMatchesWords,
  type PlanGroup,
  type QueryToken,
  type TierPlan
} from "../search/relaxation";

// Additive rerank lift for transport-authoritative mentions whose resolved
// label matches a query term (mirror of SEARCH_MENTION_BOOST).
const MEMORY_SEARCH_MENTION_BOOST = 1.0;

function stableSignalFactKey(family: string, parts: Array<string | number | null | undefined>): string {
  return `${family}:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

function isSyntheticSystemAnchor(sourceMessageKey: string | null | undefined): boolean {
  return Boolean(sourceMessageKey && sourceMessageKey.includes("live-system-"));
}

// Person-model detectors only reason over identity-addressed JIDs (phone or
// LID servers) — groups, broadcasts, and synthetic senders are never people.
function isIdentityServerJid(jid: string): boolean {
  return jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid") || jid.endsWith("@hosted.lid");
}

function safeVcardFileName(candidate: string | null, cardIndex: number): string {
  const base = (candidate ?? `contact-${cardIndex + 1}`).replace(/[\\/:*?"<>|\u0000-\u001F]+/g, " ").replace(/\s+/g, " ").trim();
  const withoutExtension = base.replace(/\.vcf$/i, "").slice(0, 120).trim();
  return `${withoutExtension || `contact-${cardIndex + 1}`}.vcf`;
}

function constructMinimalVcard(displayName: string, phone: string): string {
  const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
  return `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${escape(displayName)}\r\nTEL;TYPE=CELL:+${phone}\r\nEND:VCARD\r\n`;
}

// In-memory knowledge-graph rows (mirror of the SQLite tables).
interface MemGraphNode {
  id: string;
  kind: BrainGraphNodeKind;
  naturalKey: string;
  slug: string;
  title: string | null;
  jid: string | null;
  chatScope: string | null;
  payload: Record<string, unknown> | null;
  status: BrainGraphNodeStatus;
  mergedInto: string | null;
  salience: number;
  citationCount: number;
  evidenceDays: number;
  engagementFactor: number;
  firstSeenAtMs: number | null;
  lastSeenAtMs: number | null;
}

interface MemGraphEdge {
  id: number;
  srcNodeId: string;
  dstNodeId: string;
  kind: BrainGraphEdgeKind;
  firstSeenAtMs: number | null;
  lastSeenAtMs: number | null;
  evidence: Map<
    string,
    { claimId: string | null; sourceMessageKey: string | null; sourceRef: string | null; observedAtMs: number | null }
  >;
}

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
  // Term-alias layer (mirror of brain_term_aliases), pre-seeded statically.
  private termAliasRows: Array<{ term: string; variant: string }> = termAliasSeedRows();
  private termAliasCache: Map<string, string[]> | null = null;
  private numberChanges = new Map<string, IdentityNumberChangeRecord>();
  private membershipPeriods = new Map<string, GroupMembershipPeriodRecord>();
  private membershipEvents = new Map<string, GroupMembershipEventRecord>();
  private chatMetadataHistory = new Map<string, ChatMetadataHistoryRecord>();
  private locations = new Map<string, import("../../shared/types").MessageLocationRecord>();
  private locationObservations = new Map<string, MessageLocationObservationRecord>();
  private vcards = new Map<string, import("../../shared/types").MessageVCardRecord>();
  private editEvents = new Map<string, import("../../shared/types").MessageEditEventRecord>();
  private deletions = new Map<string, import("../../shared/types").MessageDeletionRecord>();
  private mediaInterpretations = new Map<string, import("../../shared/types").MessageMediaInterpretationRecord>();
  private engagementAggregates = new Map<string, EngagementAggregateRecord>();
  private signalObservations = new Map<string, ArchiveSignalObservation>();
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
  // Eval harness ground truth: deliberately NOT cleared by
  // resetBrainDerivedData — runs and grades outlive every brain wipe.
  private brainEvalRuns = new Map<string, BrainEvalRunRecord>();
  private brainClaimGrades = new Map<string, BrainClaimGradeRecord>();
  private brainLockRunId: string | null = null;
  // Contract v2: validation issues and the case-insensitive topic vocabulary
  // (lowercased key → first-seen canonical title), mirroring the SQLite tables.
  private brainIssues: BrainValidationIssueRecord[] = [];
  private brainTopics = new Map<string, string>();
  // Knowledge graph (mirror): keyed exactly like the SQLite tables so the
  // shared derivation in brain/graph.ts produces identical state.
  private graphNodes = new Map<string, MemGraphNode>();
  private graphNodeIdByKey = new Map<string, string>();
  private graphSlugs = new Set<string>();
  private graphEdges = new Map<string, MemGraphEdge>();
  private graphEdgesById = new Map<number, MemGraphEdge>();
  private graphEdgeSeq = 1;
  private graphNodeClaims = new Map<string, Set<string>>();
  private graphAliases = new Map<string, Map<string, { alias: string; source: string }>>();
  private graphLastRecomputeAt: string | null = null;
  // Commitment lifecycle (mirror): the durable append-only event log keyed by
  // claim id, exactly like brain_lifecycle_events + cites in SQLite.
  private lifecycleEvents: BrainLifecycleEventRecord[] = [];
  private lifecycleEventSeq = 1;
  // Semantic consolidation (mirror of brain_docs / brain_doc_revisions /
  // brain_doc_revision_claims + the claims supersession projection column).
  private brainDocs = new Map<string, BrainDocRecord>();
  private brainDocRevisions = new Map<number, BrainDocRevisionRecord>();
  private brainDocRevisionRefs = new Map<number, Set<string>>();
  private brainDocRevisionSeq = 1;
  private claimSupersededBy = new Map<string, string>();
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
  // Two-level person model (mirror of the SQLite tables).
  private persons = new Map<string, { id: string; createdAt: string; updatedAt: string }>();
  private personMembers = new Map<string, { personId: string; source: PersonMemberSource; evidence: Record<string, unknown> | null; linkedAt: string }>();
  private personSuppressions = new Map<string, PersonLinkSuppressionRecord>();
  private personSuggestions = new Map<
    string,
    { id: string; jidLow: string; jidHigh: string; kind: PersonSuggestionKind; score: number; evidence: Record<string, unknown>; status: PersonSuggestionStatus; createdAt: string; updatedAt: string }
  >();
  private personEvents: PersonLinkEventRecord[] = [];
  private personRedirects = new Map<string, PersonRedirectRecord>();
  private googleContactGroups = new Map<string, GoogleContactGroupEntry & { lastSeenAt: string }>();
  private nextPersonEventId = 1;

  private canonicalJid(jid: string | null | undefined): string | null {
    const normalized = normalizeJid(jid);
    if (!normalized) {
      return null;
    }
    return this.identityLinks.get(normalized) ?? normalized;
  }

  private mergeQuotedSnapshot(existing: QuotedMessageSnapshot | null | undefined, incoming: QuotedMessageSnapshot | null | undefined): QuotedMessageSnapshot | null {
    if (!existing) return incoming ? structuredClone(incoming) : null;
    if (!incoming) return structuredClone(existing);
    return {
      ...existing,
      quotedSourceMessageId: incoming.quotedSourceMessageId ?? existing.quotedSourceMessageId,
      quotedSourceChatId: incoming.quotedSourceChatId ?? existing.quotedSourceChatId,
      quotedSenderSourceJid: incoming.quotedSenderSourceJid ?? existing.quotedSenderSourceJid,
      quotedFromMe: incoming.quotedFromMe ?? existing.quotedFromMe,
      timestampMs: incoming.timestampMs ?? existing.timestampMs,
      messageType: existing.messageType.startsWith("unknown") && !incoming.messageType.startsWith("unknown") ? incoming.messageType : existing.messageType,
      rawTypeCode: incoming.rawTypeCode ?? existing.rawTypeCode ?? null,
      body: incoming.body?.trim() ? incoming.body : existing.body,
      caption: incoming.caption?.trim() ? incoming.caption : existing.caption,
      mediaMimeType: incoming.mediaMimeType ?? existing.mediaMimeType ?? null,
      mediaName: incoming.mediaName ?? existing.mediaName ?? null,
      thumbnail: incoming.thumbnail ?? existing.thumbnail ?? null,
      location: incoming.location ?? existing.location ?? null,
      vcard: incoming.vcard ?? existing.vcard ?? null,
      mentionedJids: incoming.mentionedJids?.length ? incoming.mentionedJids : existing.mentionedJids ?? []
    };
  }

  private quoteSummary(message: MessageRecord & { id: number }): QuotedMessageSnapshotSummary | null {
    const snapshot = message.quotedSnapshot;
    // Pointer-only imports and live messages retain the legacy same-chat
    // lookup. It is deliberately bounded to the reply's chat: a matching ID
    // in another chat is never evidence that it is the quoted original.
    if (!snapshot) {
      const original = message.quotedSourceMessageId
        ? [...this.messages.values()].find(
            (candidate) => candidate.chatSourceId === message.chatSourceId && candidate.sourceMessageId === message.quotedSourceMessageId
          )
        : null;
      if (!original) return null;
      const sender = original.senderSourceJid ? this.contacts.get(original.senderSourceJid) : null;
      return {
        captured: false,
        quotedSourceMessageId: original.sourceMessageId,
        quotedSourceChatId: null,
        quotedSenderSourceJid: original.senderSourceJid ?? null,
        quotedSenderDisplayName:
          sender?.displayName?.trim() || sender?.pushName?.trim() || sender?.phoneNumber || displayPhoneFromJid(original.senderSourceJid),
        quotedSenderNameIsPushName: Boolean(!sender?.displayName?.trim() && sender?.pushName?.trim()),
        quotedFromMe:
          original.fromMe === true || original.senderSourceJid === "me"
            ? true
            : original.fromMe === false
              ? false
              : null,
        timestampMs: original.timestampMs ?? null,
        messageType: original.messageType,
        body: original.body ?? null,
        caption: original.caption ?? null,
        mediaMimeType: original.mediaMimeType ?? null,
        mediaName: original.mediaName ?? null,
        location: null,
        vcard: null,
        mentionedJids: [],
        hasThumbnail: false,
        originalMessageId: original.id
      };
    }
    const sender = snapshot.quotedSenderSourceJid ? this.contacts.get(snapshot.quotedSenderSourceJid) : null;
    const original = snapshot.quotedSourceMessageId && (!snapshot.quotedSourceChatId || snapshot.quotedSourceChatId === message.chatSourceId)
      ? [...this.messages.values()].find((candidate) => candidate.chatSourceId === message.chatSourceId && candidate.sourceMessageId === snapshot.quotedSourceMessageId)
      : null;
    return {
      captured: true,
      quotedSourceMessageId: snapshot.quotedSourceMessageId,
      quotedSourceChatId: snapshot.quotedSourceChatId,
      quotedSenderSourceJid: snapshot.quotedSenderSourceJid,
      quotedSenderDisplayName: sender?.displayName?.trim() || sender?.pushName?.trim() || sender?.phoneNumber || displayPhoneFromJid(snapshot.quotedSenderSourceJid),
      quotedSenderNameIsPushName: Boolean(!sender?.displayName?.trim() && sender?.pushName?.trim()),
      quotedFromMe: snapshot.quotedFromMe,
      timestampMs: snapshot.timestampMs,
      messageType: snapshot.messageType,
      body: snapshot.body,
      caption: snapshot.caption,
      mediaMimeType: snapshot.mediaMimeType ?? null,
      mediaName: snapshot.mediaName ?? null,
      location: snapshot.location ? { name: snapshot.location.name, address: snapshot.location.address } : null,
      vcard: snapshot.vcard ? { name: snapshot.vcard.name } : null,
      mentionedJids: snapshot.mentionedJids ?? [],
      hasThumbnail: Boolean(snapshot.thumbnail?.length),
      originalMessageId: original?.id ?? null
    };
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
    const quoteAffectedKeys: string[] = [];
    for (const pair of pairs) {
      const chatSourceId = this.canonicalJid(pair.chatSourceId) ?? pair.chatSourceId;
      const staleKey = messageKey(chatSourceId, pair.staleMessageId);
      const canonicalKey = messageKey(chatSourceId, pair.canonicalMessageId);
      if (this.messages.has(staleKey) && this.messages.has(canonicalKey)) {
        const stale = this.messages.get(staleKey)!;
        const canonical = this.messages.get(canonicalKey)!;
        const mergedSnapshot = this.mergeQuotedSnapshot(canonical.quotedSnapshot, stale.quotedSnapshot);
        if (JSON.stringify(canonical.quotedSnapshot ?? null) !== JSON.stringify(mergedSnapshot)) {
          quoteAffectedKeys.push(staleKey, canonicalKey);
        }
        canonical.quotedSnapshot = mergedSnapshot;
        this.messages.delete(staleKey);
        collapsed += 1;
      }
    }
    if (collapsed > 0) {
      await this.markStaleMemoryForMissingMessages();
      await this.markStaleEpisodesForQuotedReplies(quoteAffectedKeys);
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
      if (message.mentionedJids?.length) {
        message.mentionedJids = [...new Set(message.mentionedJids.map((jid) => (jid === lid ? pn : jid)))];
      }
      if (message.quotedSnapshot?.mentionedJids?.length) {
        message.quotedSnapshot.mentionedJids = [...new Set(message.quotedSnapshot.mentionedJids.map((jid) => (jid === lid ? pn : jid)))];
      }
    }
    for (const row of this.numberChanges.values()) {
      if (row.oldJid === lid) row.oldJid = pn;
      if (row.newJid === lid) row.newJid = pn;
      if (row.actorJid === lid) row.actorJid = pn;
      if (row.chatSourceId === lid) row.chatSourceId = pn;
    }
    for (const row of this.membershipPeriods.values()) {
      if (row.groupSourceId === lid) row.groupSourceId = pn;
      if (row.participantJid === lid) row.participantJid = pn;
    }
    for (const row of this.membershipEvents.values()) {
      if (row.groupSourceId === lid) row.groupSourceId = pn;
      if (row.participantJid === lid) row.participantJid = pn;
      if (row.actorJid === lid) row.actorJid = pn;
    }
    for (const row of this.chatMetadataHistory.values()) {
      if (row.chatSourceId === lid) row.chatSourceId = pn;
      if (row.actorJid === lid) row.actorJid = pn;
    }
    for (const row of this.vcards.values()) if (row.resolvedJid === lid) row.resolvedJid = pn;
    for (const row of this.deletions.values()) if (row.revokedByJid === lid) row.revokedByJid = pn;
    for (const row of this.engagementAggregates.values()) {
      if (row.chatSourceId === lid) row.chatSourceId = pn;
      if (row.counterpartyJid === lid) row.counterpartyJid = pn;
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

    // Person layer follows the canonical identity (memberships, suggestions,
    // suppressions, audit), unioning persons revealed to share an identity.
    this.rewritePersonLayerForMerge(lid, pn);

    // Graph rekey mirror: person/chat nodes follow the canonical JID with a
    // 'merged' redirect stub; chat-scoped natural keys rewrite.
    this.memRekeyGraphForIdentityMerge(lid, pn);

    await this.refreshChatStats([pn]);
    // Deterministic brain-prose repair: substitute the merged identity's baked
    // `lid:` token in old episodes with the now-known number or name. The stamp
    // records the LID form, so both JIDs are candidates.
    await this.repairBrainProseForIdentities(new Set([pn, lid]));
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

  // === Identity late-resolution repair (mirror of the SQLite adapter) ======
  // The in-memory search resolves labels live (contacts are read at query time),
  // so there is no derived search text to recompute — repair here is purely the
  // brain-prose half. Episodes are stored as hydrated records, mutated in place.

  private expandIdentityCandidates(jids: string[]): Set<string> {
    const set = new Set<string>();
    for (const raw of jids) {
      const normalized = normalizeJid(raw);
      if (!normalized) {
        continue;
      }
      set.add(normalized);
      const canonical = this.canonicalJid(normalized) ?? normalized;
      set.add(canonical);
      for (const [lid, pn] of this.identityLinks) {
        if (pn === canonical) {
          set.add(lid);
        }
      }
    }
    return set;
  }

  private resolveCurrentLabelForJid(jid: string): string | null {
    const canonical = this.canonicalJid(jid) ?? jid;
    const contact = this.contacts.get(canonical);
    const name = contact?.displayName?.trim();
    if (name && !isMaskedNumberLabel(name)) {
      return name;
    }
    const push = contact?.pushName?.trim();
    if (push && !isMaskedNumberLabel(push)) {
      return push;
    }
    const phone = contact?.phoneNumber?.trim();
    if (phone) {
      return `+${phone.replace(/[+\s-]/g, "")}`;
    }
    return displayPhoneFromJid(canonical);
  }

  // Mirror of the SQLite adapter: genuine labels keyed by canonical JID, so
  // the post-write diff catches both unnamed→named and genuine renames.
  private genuinelyNamedLabels(jids: string[]): Map<string, string> {
    const result = new Map<string, string>();
    for (const jid of jids) {
      const canonical = this.canonicalJid(jid) ?? jid;
      const contact = this.contacts.get(canonical);
      const name = contact?.displayName?.trim() || contact?.pushName?.trim() || "";
      if (name && !isMaskedNumberLabel(name) && !isIdentityDerivedName(name, canonical)) {
        result.set(canonical, name);
      }
    }
    return result;
  }

  async repairIdentityResolution(jids: string | string[]): Promise<IdentityRepairResult> {
    const inputs = (Array.isArray(jids) ? jids : [jids]).filter(Boolean);
    const candidates = this.expandIdentityCandidates(inputs);
    const { episodesRepaired, tokensSubstituted } = await this.repairBrainProseForIdentities(candidates);
    return { episodesRepaired, tokensSubstituted, messagesRecomputed: 0 };
  }

  private async repairBrainProseForIdentities(candidates: Set<string>): Promise<{ episodesRepaired: number; tokensSubstituted: number }> {
    if (candidates.size === 0) {
      return { episodesRepaired: 0, tokensSubstituted: 0 };
    }
    const { episodeMarkdown, numberLabelFromJid, substituteParticipantToken, labelIsResolvedName } = await import("../brain/episodes");
    let episodesRepaired = 0;
    let tokensSubstituted = 0;
    for (const episode of this.brainEpisodes.values()) {
      if (episode.status !== "current" || episode.unresolvedParticipants.length === 0) {
        continue;
      }
      const hits = episode.unresolvedParticipants.filter((jid) => candidates.has(jid));
      if (hits.length === 0) {
        continue;
      }
      const subs: Array<{ jid: string; token: string; label: string; isName: boolean }> = [];
      for (const jid of hits) {
        const token = numberLabelFromJid(jid);
        if (!token.startsWith("+") && !token.startsWith("lid:")) {
          continue;
        }
        const label = this.resolveCurrentLabelForJid(jid);
        if (!label || label === token) {
          continue;
        }
        subs.push({ jid, token, label, isName: labelIsResolvedName(label) });
      }
      if (subs.length === 0) {
        continue;
      }
      let count = 0;
      for (const sub of subs) {
        const before = episode.summary;
        episode.summary = substituteParticipantToken(episode.summary, sub.token, sub.label);
        if (episode.summary !== before) {
          count += 1;
        }
        episode.participants = episode.participants.map((participant) => substituteParticipantToken(participant, sub.token, sub.label));
        for (const claim of episode.claims) {
          const claimBefore = claim.text;
          claim.text = substituteParticipantToken(claim.text, sub.token, sub.label);
          if (claim.text !== claimBefore) {
            count += 1;
          }
        }
      }
      const resolvedNameJids = new Set(subs.filter((sub) => sub.isName).map((sub) => sub.jid));
      episode.unresolvedParticipants = episode.unresolvedParticipants.filter((jid) => !resolvedNameJids.has(jid));
      if (count > 0) {
        episode.markdown = episodeMarkdown(episode);
        episodesRepaired += 1;
        tokensSubstituted += count;
      }
    }
    // Semantic-rollups: sweep CURRENT doc revisions' statement text with the
    // same token→label substitutions (mirror of the SQLite sweep). Superseded
    // revisions keep their as-written labels (history).
    const docSubs: Array<{ token: string; label: string }> = [];
    for (const jid of candidates) {
      const token = numberLabelFromJid(jid);
      if (!token.startsWith("+") && !token.startsWith("lid:")) {
        continue;
      }
      const label = this.resolveCurrentLabelForJid(jid);
      if (label && label !== token) {
        docSubs.push({ token, label });
      }
    }
    if (docSubs.length > 0) {
      for (const revision of this.brainDocRevisions.values()) {
        if (revision.status !== "current") {
          continue;
        }
        for (const section of revision.sections) {
          for (const statement of section.statements) {
            for (const sub of docSubs) {
              const before = statement.text;
              statement.text = substituteParticipantToken(statement.text, sub.token, sub.label);
              if (statement.text !== before) {
                tokensSubstituted += 1;
              }
            }
          }
        }
      }
    }
    return { episodesRepaired, tokensSubstituted };
  }

  async backfillIdentityResolution(): Promise<IdentityRepairResult> {
    const stamped = new Set<string>();
    for (const episode of this.brainEpisodes.values()) {
      if (episode.status === "current") {
        for (const jid of episode.unresolvedParticipants) {
          stamped.add(jid);
        }
      }
    }
    const empty: IdentityRepairResult = { episodesRepaired: 0, tokensSubstituted: 0, messagesRecomputed: 0 };
    if (stamped.size === 0) {
      return empty;
    }
    const { numberLabelFromJid } = await import("../brain/episodes");
    const improved = [...stamped].filter((jid) => {
      const token = numberLabelFromJid(jid);
      if (!token.startsWith("+") && !token.startsWith("lid:")) {
        return false;
      }
      const label = this.resolveCurrentLabelForJid(jid);
      return !!label && label !== token;
    });
    if (improved.length === 0) {
      return empty;
    }
    return this.repairIdentityResolution(improved);
  }

  async getBrainResolutionDebt(options?: { limit?: number }): Promise<BrainResolutionDebtSummary> {
    const limit = options?.limit ?? 8;
    const episodeCountByJid = new Map<string, number>();
    let episodesWithUnresolved = 0;
    for (const episode of this.brainEpisodes.values()) {
      if (episode.status !== "current" || episode.unresolvedParticipants.length === 0) {
        continue;
      }
      episodesWithUnresolved += 1;
      for (const jid of new Set(episode.unresolvedParticipants)) {
        episodeCountByJid.set(jid, (episodeCountByJid.get(jid) ?? 0) + 1);
      }
    }
    const { numberLabelFromJid } = await import("../brain/episodes");
    const identities: BrainResolutionDebtIdentity[] = [...episodeCountByJid.keys()].map((jid) => {
      const canonical = this.canonicalJid(jid) ?? jid;
      let messageCount = 0;
      for (const message of this.messages.values()) {
        if (message.senderSourceJid === canonical) {
          messageCount += 1;
        }
      }
      return {
        jid,
        label: this.resolveCurrentLabelForJid(jid) ?? numberLabelFromJid(jid),
        messageCount,
        episodeCount: episodeCountByJid.get(jid) ?? 0
      };
    });
    identities.sort((a, b) => b.messageCount - a.messageCount || b.episodeCount - a.episodeCount);
    return { episodesWithUnresolved, distinctIdentities: episodeCountByJid.size, topIdentities: identities.slice(0, limit) };
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
    const batchJids = [...unique.keys()];
    const labelsBefore = this.genuinelyNamedLabels(batchJids);
    for (const contact of unique.values()) {
      const existing = this.contacts.get(contact.sourceJid);
      // A user-set name is the strongest source: only another user write may
      // replace it (mirror of the SQLite conflict-clause guard).
      const userNameHolds = existing?.displayNameSource === "user" && contact.displayNameSource !== "user";
      const winningName = userNameHolds ? existing?.displayName ?? null : contact.displayName || existing?.displayName || null;
      const winningSource = userNameHolds
        ? existing?.displayNameSource ?? null
        : contact.displayName?.trim()
          ? contact.displayNameSource ?? existing?.displayNameSource ?? null
          : existing?.displayNameSource ?? null;
      this.contacts.set(contact.sourceJid, {
        ...existing,
        ...contact,
        displayName: winningName,
        displayNameSource: winningSource,
        id: existing?.id ?? this.nextContactId++
      });
      const chat = this.chats.get(contact.sourceJid);
      // Propagate the STORED winner to the chat title, never a blocked name.
      const displayName = winningName?.trim();
      const pushName = contact.pushName?.trim();
      if (chat && displayName && (chat.chatType === "dm" || chat.chatType === "unknown")) {
        chat.displayName = displayName;
      } else if (chat && pushName && (chat.chatType === "dm" || chat.chatType === "unknown") && isIdentityDisplayName(chat)) {
        chat.displayName = pushName;
      }
    }
    // Identity late-resolution: repair episodes for identities whose genuine
    // resolution changed — gained OR renamed (mirror of the SQLite path).
    const labelsAfter = this.genuinelyNamedLabels(batchJids);
    const transitioned = [...labelsAfter].filter(([jid, name]) => labelsBefore.get(jid) !== name).map(([jid]) => jid);
    if (transitioned.length > 0) {
      await this.repairIdentityResolution(transitioned);
    }
    return new Map([...this.contacts].map(([jid, contact]) => [jid, contact.id]));
  }

  async enrichContactsFromGoogle(contacts: Array<{ phoneNumber: string; displayName: string }>): Promise<{ matchedIdentities: number; improvedNames: number }> {
    let matchedIdentities = 0;
    let improvedNames = 0;
    const improvedJids: string[] = [];
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
        improvedJids.push(jid);
      }
    }
    if (improvedJids.length > 0) {
      await this.repairIdentityResolution(improvedJids);
    }
    return { matchedIdentities, improvedNames };
  }

  // === Two-level person model (mirror of the SQLite adapter) ===============

  private personPair(jidA: string, jidB: string): [string, string] {
    return jidA < jidB ? [jidA, jidB] : [jidB, jidA];
  }

  private personPairKey(jidA: string, jidB: string): string {
    const [low, high] = this.personPair(jidA, jidB);
    return `${low}\u0000${high}`;
  }

  private recordPersonEvent(
    action: PersonLinkEventRecord["action"],
    fields: { personId?: string | null; identityJid?: string | null; source?: string | null; evidence?: Record<string, unknown> | null }
  ): void {
    this.personEvents.push({
      id: this.nextPersonEventId++,
      action,
      personId: fields.personId ?? null,
      identityJid: fields.identityJid ?? null,
      source: fields.source ?? null,
      evidence: fields.evidence ?? null,
      createdAt: new Date().toISOString()
    });
  }

  private supersedePendingSuggestions(jidLow: string, jidHigh: string): void {
    for (const suggestion of this.personSuggestions.values()) {
      if (suggestion.jidLow === jidLow && suggestion.jidHigh === jidHigh && suggestion.status === "pending") {
        suggestion.status = "superseded";
        suggestion.updatedAt = new Date().toISOString();
      }
    }
  }

  private personMemberJids(personId: string): string[] {
    return [...this.personMembers.entries()].filter(([, member]) => member.personId === personId).map(([jid]) => jid);
  }

  private unionPersons(personIdA: string, personIdB: string, evidence: Record<string, unknown>): string {
    const stats = [personIdA, personIdB].map((id) => ({
      id,
      createdAt: this.persons.get(id)?.createdAt ?? "",
      members: this.personMemberJids(id).length
    }));
    const [survivor, dissolved] = stats.sort(
      (a, b) => b.members - a.members || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
    );
    for (const jid of this.personMemberJids(dissolved.id)) {
      this.personMembers.get(jid)!.personId = survivor.id;
    }
    this.persons.delete(dissolved.id);
    this.personRedirects.set(dissolved.id, {
      personId: dissolved.id,
      replacedByPersonId: survivor.id,
      survivingJid: null,
      createdAt: new Date().toISOString()
    });
    const survivorRow = this.persons.get(survivor.id);
    if (survivorRow) {
      survivorRow.updatedAt = new Date().toISOString();
    }
    this.recordPersonEvent("union", { personId: survivor.id, evidence: { ...evidence, dissolvedPersonId: dissolved.id } });
    return survivor.id;
  }

  private connectIdentitiesInternal(
    jidA: string,
    jidB: string,
    source: PersonMemberSource,
    evidence: Record<string, unknown> | null
  ): PersonConnectResult {
    const a = this.canonicalJid(jidA);
    const b = this.canonicalJid(jidB);
    if (!a || !b) {
      return { outcome: "invalid", personId: null };
    }
    if (a === b) {
      return { outcome: "self", personId: null };
    }
    const [low, high] = this.personPair(a, b);
    const pairKey = this.personPairKey(a, b);
    if (this.personSuppressions.has(pairKey)) {
      if (source !== "user") {
        return { outcome: "suppressed", personId: null };
      }
      this.personSuppressions.delete(pairKey);
    }
    const memberA = this.personMembers.get(a);
    const memberB = this.personMembers.get(b);
    const now = new Date().toISOString();
    if (memberA && memberB) {
      if (memberA.personId === memberB.personId) {
        return { outcome: "already_connected", personId: memberA.personId };
      }
      const survivorId = this.unionPersons(memberA.personId, memberB.personId, { viaJids: [a, b], source, ...(evidence ?? {}) });
      this.supersedePendingSuggestions(low, high);
      return { outcome: "union", personId: survivorId };
    }
    if (memberA || memberB) {
      const personId = (memberA ?? memberB)!.personId;
      const newJid = memberA ? b : a;
      this.personMembers.set(newJid, { personId, source, evidence, linkedAt: now });
      const person = this.persons.get(personId);
      if (person) {
        person.updatedAt = now;
      }
      this.recordPersonEvent("connect", { personId, identityJid: newJid, source, evidence });
      this.supersedePendingSuggestions(low, high);
      return { outcome: "connected", personId };
    }
    const personId = `person_${randomUUID()}`;
    this.persons.set(personId, { id: personId, createdAt: now, updatedAt: now });
    this.personMembers.set(a, { personId, source, evidence, linkedAt: now });
    this.personMembers.set(b, { personId, source, evidence, linkedAt: now });
    this.recordPersonEvent("connect", { personId, identityJid: a, source, evidence });
    this.recordPersonEvent("connect", { personId, identityJid: b, source, evidence });
    this.supersedePendingSuggestions(low, high);
    return { outcome: "connected", personId };
  }

  async connectIdentities(
    jidA: string,
    jidB: string,
    source: PersonMemberSource,
    evidence: Record<string, unknown> | null = null
  ): Promise<PersonConnectResult> {
    return this.connectIdentitiesInternal(jidA, jidB, source, evidence);
  }

  async disconnectIdentities(identityJid: string): Promise<PersonDisconnectResult> {
    const jid = this.canonicalJid(identityJid) ?? identityJid;
    const membership = this.personMembers.get(jid);
    if (!membership) {
      return { disconnected: false, personId: null, dissolved: false };
    }
    const personId = membership.personId;
    const others = this.personMemberJids(personId).filter((member) => member !== jid);
    const now = new Date().toISOString();
    this.personMembers.delete(jid);
    for (const other of others) {
      const [low, high] = this.personPair(jid, other);
      this.personSuppressions.set(this.personPairKey(jid, other), { jidLow: low, jidHigh: high, reason: "disconnected", createdAt: now });
    }
    this.recordPersonEvent("disconnect", { personId, identityJid: jid });
    if (others.length < 2) {
      for (const other of others) {
        this.personMembers.delete(other);
      }
      this.persons.delete(personId);
      this.personRedirects.set(personId, { personId, replacedByPersonId: null, survivingJid: others[0] ?? null, createdAt: now });
      this.recordPersonEvent("dissolve", { personId, identityJid: others[0] ?? null });
      return { disconnected: true, personId, dissolved: true };
    }
    const person = this.persons.get(personId);
    if (person) {
      person.updatedAt = now;
    }
    return { disconnected: true, personId, dissolved: false };
  }

  private buildPersonRecord(personId: string): PersonRecord | null {
    const person = this.persons.get(personId);
    if (!person) {
      return null;
    }
    const members: PersonMemberRecord[] = this.personMemberJids(personId).map((jid) => {
      const membership = this.personMembers.get(jid)!;
      const contact = this.contacts.get(jid);
      const displayName = contact?.displayName ?? null;
      const hasSavedName = Boolean(displayName?.trim() && !isMaskedNumberLabel(displayName) && !isIdentityDerivedName(displayName, jid));
      let messageCount = 0;
      for (const message of this.messages.values()) {
        if (message.senderSourceJid === jid) {
          messageCount += 1;
        }
      }
      return {
        identityJid: jid,
        source: membership.source,
        evidence: membership.evidence,
        linkedAt: membership.linkedAt,
        displayLabel: resolveDisplayLabel({
          displayName,
          pushName: contact?.pushName ?? null,
          phoneNumber: contact?.phoneNumber ?? null,
          jid
        }),
        phoneNumber: contact?.phoneNumber ?? phoneFromJid(jid),
        messageCount,
        hasSavedName
      };
    });
    members.sort((a, b) => a.linkedAt.localeCompare(b.linkedAt) || a.identityJid.localeCompare(b.identityJid));
    return {
      id: person.id,
      displayLabel: personDisplayLabelFromMembers(members),
      members,
      unconfirmedHint: this.personUnconfirmedHint(members),
      createdAt: person.createdAt,
      updatedAt: person.updatedAt
    };
  }

  private personUnconfirmedHint(members: PersonMemberRecord[]): string | null {
    const memberJids = new Set(members.map((member) => member.identityJid));
    let best: { otherJid: string; score: number } | null = null;
    for (const suggestion of this.personSuggestions.values()) {
      if (suggestion.status !== "pending" || suggestion.score < config.persons.hintScoreThreshold) {
        continue;
      }
      const lowIn = memberJids.has(suggestion.jidLow);
      const highIn = memberJids.has(suggestion.jidHigh);
      if (lowIn === highIn) {
        continue;
      }
      const otherJid = lowIn ? suggestion.jidHigh : suggestion.jidLow;
      if (!best || suggestion.score > best.score) {
        best = { otherJid, score: suggestion.score };
      }
    }
    if (!best) {
      return null;
    }
    return `possibly the same as ${this.resolveCurrentLabelForJid(best.otherJid) ?? best.otherJid} — unconfirmed`;
  }

  async resolvePersonForJid(jid: string): Promise<PersonRecord | null> {
    const canonical = this.canonicalJid(jid) ?? jid;
    const membership = this.personMembers.get(canonical);
    return membership ? this.buildPersonRecord(membership.personId) : null;
  }

  async listPersons(options: { limit?: number } = {}): Promise<PersonRecord[]> {
    const limit = Math.max(1, options.limit ?? 200);
    return [...this.persons.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((person) => this.buildPersonRecord(person.id)!)
      .filter(Boolean);
  }

  async getPerson(personId: string): Promise<PersonLookupResult> {
    const person = this.buildPersonRecord(personId);
    if (person) {
      return { person, redirect: null };
    }
    let redirect: PersonRedirectRecord | null = null;
    let cursor = personId;
    for (let hops = 0; hops < 10; hops += 1) {
      const row = this.personRedirects.get(cursor);
      if (!row) {
        break;
      }
      redirect = row;
      if (!row.replacedByPersonId) {
        break;
      }
      const target = this.buildPersonRecord(row.replacedByPersonId);
      if (target) {
        return { person: target, redirect: row };
      }
      cursor = row.replacedByPersonId;
    }
    return { person: null, redirect };
  }

  async personKeyForJids(jids: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const jid of jids) {
      if (!jid) {
        continue;
      }
      const canonical = this.canonicalJid(jid) ?? jid;
      result.set(jid, this.personMembers.get(canonical)?.personId ?? canonical);
    }
    return result;
  }

  async upsertPersonSuggestions(suggestions: PersonSuggestionInput[]): Promise<{ created: number; updated: number }> {
    let created = 0;
    let updated = 0;
    for (const suggestion of suggestions) {
      const a = this.canonicalJid(suggestion.jidA);
      const b = this.canonicalJid(suggestion.jidB);
      if (!a || !b || a === b) {
        continue;
      }
      const [low, high] = this.personPair(a, b);
      if (this.personSuppressions.has(this.personPairKey(a, b))) {
        continue;
      }
      const memberA = this.personMembers.get(a);
      const memberB = this.personMembers.get(b);
      if (memberA && memberB && memberA.personId === memberB.personId) {
        continue;
      }
      const key = `${low}\u0000${high}\u0000${suggestion.kind}`;
      const existing = this.personSuggestions.get(key);
      const now = new Date().toISOString();
      if (existing) {
        // Rejected is memory, accepted is history — never resurrected.
        // Superseded returns to pending when a detector produces it afresh.
        if (existing.status === "rejected" || existing.status === "accepted") {
          continue;
        }
        if (existing.status === "superseded") {
          existing.status = "pending";
          existing.score = suggestion.score;
          existing.evidence = suggestion.evidence ?? {};
          existing.updatedAt = now;
          created += 1;
          continue;
        }
        const evidenceJson = JSON.stringify(suggestion.evidence ?? {});
        if (existing.score !== suggestion.score || JSON.stringify(existing.evidence) !== evidenceJson) {
          existing.score = suggestion.score;
          existing.evidence = suggestion.evidence ?? {};
          existing.updatedAt = now;
          updated += 1;
        }
        continue;
      }
      const id = `psg_${randomUUID()}`;
      this.personSuggestions.set(key, {
        id,
        jidLow: low,
        jidHigh: high,
        kind: suggestion.kind,
        score: suggestion.score,
        evidence: suggestion.evidence ?? {},
        status: "pending",
        createdAt: now,
        updatedAt: now
      });
      this.recordPersonEvent("suggest", { evidence: { suggestionId: id, jidLow: low, jidHigh: high, kind: suggestion.kind, score: suggestion.score } });
      created += 1;
    }
    return { created, updated };
  }

  async listPersonSuggestions(
    options: { status?: PersonSuggestionStatus; jid?: string; minScore?: number; limit?: number } = {}
  ): Promise<PersonSuggestionRecord[]> {
    const canonical = options.jid ? this.canonicalJid(options.jid) ?? options.jid : null;
    const phoneFor = (jid: string): string | null => (this.contacts.get(jid)?.phoneNumber ?? phoneFromJid(jid)) || null;
    const dmChatIdFor = (jid: string): number | null => this.chats.get(jid)?.id ?? null;
    const cachedCount = (compute: (jid: string) => number) => {
      const cache = new Map<string, number>();
      return (jid: string): number => {
        const hit = cache.get(jid);
        if (hit != null) return hit;
        const count = compute(jid);
        cache.set(jid, count);
        return count;
      };
    };
    const messagesFor = cachedCount((jid) => {
      let count = 0;
      for (const message of this.messages.values()) {
        if (message.senderSourceJid === jid) count += 1;
      }
      return count;
    });
    const mentionsFor = cachedCount((jid) => {
      let count = 0;
      for (const message of this.messages.values()) {
        if (message.mentionedJids?.includes(jid)) count += 1;
      }
      return count;
    });
    const groupsFor = cachedCount((jid) => {
      let count = 0;
      for (const participant of this.participants.values()) {
        if (participant.sourceJid === jid && this.chats.get(participant.chatSourceId)?.chatType === "group") count += 1;
      }
      return count;
    });
    return [...this.personSuggestions.values()]
      .filter((suggestion) => !options.status || suggestion.status === options.status)
      .filter((suggestion) => !canonical || suggestion.jidLow === canonical || suggestion.jidHigh === canonical)
      .filter((suggestion) => options.minScore == null || suggestion.score >= options.minScore)
      .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(1, options.limit ?? 100))
      .map((suggestion) => {
        const chatLabels: Record<string, string> = {};
        for (const key of ["sharedChats", "sharedGroups", "membershipHandoffGroups"]) {
          const ids = suggestion.evidence[key];
          if (!Array.isArray(ids)) continue;
          for (const id of ids) {
            if (typeof id === "string" && !(id in chatLabels)) {
              const label = this.chats.get(id)?.displayName?.trim();
              if (label) {
                chatLabels[id] = label;
              }
            }
          }
        }
        return {
          ...suggestion,
          evidence: { ...suggestion.evidence },
          lowLabel: this.resolveCurrentLabelForJid(suggestion.jidLow) ?? suggestion.jidLow,
          highLabel: this.resolveCurrentLabelForJid(suggestion.jidHigh) ?? suggestion.jidHigh,
          lowPhone: phoneFor(suggestion.jidLow),
          highPhone: phoneFor(suggestion.jidHigh),
          lowChatId: dmChatIdFor(suggestion.jidLow),
          highChatId: dmChatIdFor(suggestion.jidHigh),
          lowMessageCount: messagesFor(suggestion.jidLow),
          highMessageCount: messagesFor(suggestion.jidHigh),
          lowMentionCount: mentionsFor(suggestion.jidLow),
          highMentionCount: mentionsFor(suggestion.jidHigh),
          lowGroupCount: groupsFor(suggestion.jidLow),
          highGroupCount: groupsFor(suggestion.jidHigh),
          chatLabels
        };
      });
  }

  // Display labels for chat source ids (mirror of SQLite).
  async getChatLabels(sourceChatIds: string[]): Promise<Map<string, string | null>> {
    const labels = new Map<string, string | null>();
    for (const id of new Set(sourceChatIds.filter(Boolean))) {
      const chat = this.chats.get(id);
      const label = chat?.displayName?.trim();
      labels.set(id, label && label !== id ? label : chat ? displayPhoneFromJid(id) : null);
    }
    return labels;
  }

  // A sender's recent already-stored media (mirror of SQLite): ids and labels
  // only, never bytes.
  async listRecentMediaBySender(jid: string, limit = 8): Promise<IdentityRecentMedia[]> {
    const canonical = this.canonicalJid(jid) ?? jid;
    const byKey = new Map<string, MessageRecord & { id: number }>();
    for (const message of this.messages.values()) {
      if (message.senderSourceJid === canonical) {
        byKey.set(message.sourceMessageKey, message);
      }
    }
    const rows: IdentityRecentMedia[] = [];
    for (const asset of this.mediaAssets.values()) {
      const message = byKey.get(asset.messageKey);
      if (!message) continue;
      const chat = this.chats.get(message.chatSourceId);
      const label = chat?.displayName?.trim();
      rows.push({
        messageId: message.id,
        assetId: asset.id,
        mimeType: asset.mimeType ?? null,
        hasThumbnail: Boolean(asset.thumbnail?.length),
        timestampMs: message.timestampMs ?? null,
        chatLabel: label && label !== message.chatSourceId ? label : displayPhoneFromJid(message.chatSourceId)
      });
    }
    return rows.sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0) || b.messageId - a.messageId).slice(0, Math.max(1, limit));
  }

  // A sender's recent visible messages across every chat (mirror of SQLite).
  async listRecentMessagesBySender(jid: string, limit = 20): Promise<IdentityRecentMessage[]> {
    const canonical = this.canonicalJid(jid) ?? jid;
    return [...this.messages.values()]
      .filter((message) => message.senderSourceJid === canonical && isVisibleExchangeMessage(message))
      .sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0) || b.id - a.id)
      .slice(0, Math.max(1, limit))
      .map((message) => {
        const chat = this.chats.get(message.chatSourceId);
        const label = chat?.displayName?.trim();
        return {
          chatId: chat?.id ?? 0,
          chatSourceId: message.chatSourceId,
          chatLabel: label && label !== message.chatSourceId ? label : displayPhoneFromJid(message.chatSourceId),
          chatType: chat?.chatType ?? "unknown",
          timestampMs: message.timestampMs ?? null,
          direction: message.direction,
          messageType: message.messageType,
          text: message.body?.trim() || message.caption?.trim() || null
        };
      });
  }

  // Retire a detector kind's pending queue (rejected/accepted history stays).
  async supersedePersonSuggestionsByKind(kind: PersonSuggestionKind): Promise<number> {
    let changed = 0;
    for (const suggestion of this.personSuggestions.values()) {
      if (suggestion.kind === kind && suggestion.status === "pending") {
        suggestion.status = "superseded";
        suggestion.updatedAt = new Date().toISOString();
        changed += 1;
      }
    }
    return changed;
  }

  // Human-only dismissal undo (mirror of SQLite): rejected rows for the pair
  // return to pending and the undo is audited.
  async unrejectPersonSuggestions(jidLowInput: string, jidHighInput: string): Promise<number> {
    const a = this.canonicalJid(jidLowInput) ?? jidLowInput;
    const b = this.canonicalJid(jidHighInput) ?? jidHighInput;
    const [low, high] = this.personPair(a, b);
    let restored = 0;
    for (const suggestion of this.personSuggestions.values()) {
      if (suggestion.jidLow === low && suggestion.jidHigh === high && suggestion.status === "rejected") {
        suggestion.status = "pending";
        suggestion.updatedAt = new Date().toISOString();
        restored += 1;
      }
    }
    if (restored > 0) {
      this.recordPersonEvent("unreject", { evidence: { jidLow: low, jidHigh: high, restored } });
    }
    return restored;
  }

  // Prune specific pending rows (e.g. pairs whose merge value dropped to
  // nothing); they return to pending if a detector produces them afresh.
  async supersedePersonSuggestionsByIds(ids: string[]): Promise<number> {
    const wanted = new Set(ids);
    let changed = 0;
    for (const suggestion of this.personSuggestions.values()) {
      if (wanted.has(suggestion.id) && suggestion.status === "pending") {
        suggestion.status = "superseded";
        suggestion.updatedAt = new Date().toISOString();
        changed += 1;
      }
    }
    return changed;
  }

  async acceptPersonSuggestion(suggestionId: string): Promise<PersonConnectResult> {
    const suggestion = [...this.personSuggestions.values()].find((row) => row.id === suggestionId);
    if (!suggestion || suggestion.status !== "pending") {
      throw new PublicError("PERSON_SUGGESTION_STATE", "The suggestion no longer exists or was already resolved.");
    }
    suggestion.status = "accepted";
    suggestion.updatedAt = new Date().toISOString();
    this.recordPersonEvent("accept", { evidence: { suggestionId: suggestion.id, kind: suggestion.kind } });
    return this.connectIdentitiesInternal(suggestion.jidLow, suggestion.jidHigh, "user", { suggestionId: suggestion.id, kind: suggestion.kind });
  }

  async rejectPersonSuggestion(suggestionId: string): Promise<boolean> {
    const suggestion = [...this.personSuggestions.values()].find((row) => row.id === suggestionId);
    if (!suggestion || suggestion.status !== "pending") {
      return false;
    }
    suggestion.status = "rejected";
    suggestion.updatedAt = new Date().toISOString();
    this.recordPersonEvent("reject", { evidence: { suggestionId: suggestion.id, kind: suggestion.kind } });
    return true;
  }

  async listPersonLinkSuppressions(limit = 200): Promise<PersonLinkSuppressionRecord[]> {
    const phoneFor = (jid: string): string | null => (this.contacts.get(jid)?.phoneNumber ?? phoneFromJid(jid)) || null;
    return [...this.personSuppressions.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, limit))
      .map((row) => ({
        ...row,
        lowLabel: this.resolveCurrentLabelForJid(row.jidLow) ?? row.jidLow,
        highLabel: this.resolveCurrentLabelForJid(row.jidHigh) ?? row.jidHigh,
        lowPhone: phoneFor(row.jidLow),
        highPhone: phoneFor(row.jidHigh)
      }));
  }

  // Release a block (mirror of SQLite): delete the suppression so passes may
  // re-evaluate the pair; nothing connects here.
  async releasePersonLinkSuppression(jidA: string, jidB: string): Promise<boolean> {
    const a = this.canonicalJid(jidA) ?? jidA;
    const b = this.canonicalJid(jidB) ?? jidB;
    const released = this.personSuppressions.delete(this.personPairKey(a, b));
    if (released) {
      const [low, high] = this.personPair(a, b);
      this.recordPersonEvent("release", { evidence: { jidLow: low, jidHigh: high } });
    }
    return released;
  }

  async listPersonLinkEvents(options: { limit?: number } = {}): Promise<PersonLinkEventRecord[]> {
    return [...this.personEvents]
      .sort((a, b) => b.id - a.id)
      .slice(0, Math.max(1, options.limit ?? 200))
      .map((row) => ({ ...row, evidence: row.evidence ? { ...row.evidence } : null }));
  }

  async replaceGoogleContactGroups(groups: GoogleContactGroupEntry[]): Promise<{ groups: number; numbers: number }> {
    this.googleContactGroups.clear();
    const now = new Date().toISOString();
    const resources = new Set<string>();
    let numbers = 0;
    for (const group of groups) {
      if (!group.resourceName || !group.phoneE164) {
        continue;
      }
      this.googleContactGroups.set(`${group.resourceName}\u0000${group.phoneE164}`, { ...group, lastSeenAt: now });
      resources.add(group.resourceName);
      numbers += 1;
    }
    return { groups: resources.size, numbers };
  }

  async listGoogleContactGroups(): Promise<GoogleContactGroupEntry[]> {
    return [...this.googleContactGroups.values()]
      .map(({ resourceName, phoneE164, displayName }) => ({ resourceName, phoneE164, displayName }))
      .sort((a, b) => a.resourceName.localeCompare(b.resourceName) || a.phoneE164.localeCompare(b.phoneE164));
  }

  async resolveArchivedJidsForPhones(phones: string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    for (const phone of new Set(phones.filter(Boolean))) {
      const jids = new Set<string>();
      const direct = this.contacts.get(`${phone}@s.whatsapp.net`);
      if (direct) {
        jids.add(direct.sourceJid);
      }
      for (const contact of this.contacts.values()) {
        if (contact.phoneNumber === phone) {
          jids.add(contact.sourceJid);
        }
      }
      if (jids.size > 0) {
        result.set(phone, [...jids]);
      }
    }
    return result;
  }

  async listIdentityProfiles(options: { limit?: number } = {}): Promise<IdentityProfile[]> {
    const profiles: IdentityProfile[] = [];
    const counts = new Map<string, number>();
    for (const message of this.messages.values()) {
      if (message.senderSourceJid) {
        counts.set(message.senderSourceJid, (counts.get(message.senderSourceJid) ?? 0) + 1);
      }
    }
    for (const contact of this.contacts.values()) {
      if (!isIdentityServerJid(contact.sourceJid)) {
        continue;
      }
      profiles.push({
        jid: contact.sourceJid,
        displayName: contact.displayName ?? null,
        pushName: contact.pushName ?? null,
        phoneNumber: contact.phoneNumber ?? null,
        messageCount: counts.get(contact.sourceJid) ?? 0
      });
      if (profiles.length >= Math.max(1, options.limit ?? 10_000)) {
        break;
      }
    }
    return profiles;
  }

  async listIdentityActivitySummaries(options: { minMessages?: number; limit?: number } = {}): Promise<IdentityActivitySummary[]> {
    const byJid = new Map<string, { messages: number; firstMs: number | null; lastMs: number | null }>();
    for (const message of this.messages.values()) {
      const jid = message.senderSourceJid;
      if (!jid || !isIdentityServerJid(jid) || message.timestampMs == null) {
        continue;
      }
      const entry = byJid.get(jid) ?? { messages: 0, firstMs: null, lastMs: null };
      entry.messages += 1;
      entry.firstMs = entry.firstMs == null ? message.timestampMs : Math.min(entry.firstMs, message.timestampMs);
      entry.lastMs = entry.lastMs == null ? message.timestampMs : Math.max(entry.lastMs, message.timestampMs);
      byJid.set(jid, entry);
    }
    return [...byJid.entries()]
      .filter(([, entry]) => entry.messages >= Math.max(1, options.minMessages ?? 3))
      .map(([jid, entry]) => ({ jid, ...entry }))
      .sort((a, b) => (b.lastMs ?? 0) - (a.lastMs ?? 0))
      .slice(0, Math.max(1, options.limit ?? 2_000));
  }

  async listIdentityChatActivity(jids: string[]): Promise<IdentityChatActivity[]> {
    const wanted = new Set(jids.filter(Boolean));
    const byKey = new Map<string, IdentityChatActivity>();
    for (const message of this.messages.values()) {
      const jid = message.senderSourceJid;
      if (!jid || !wanted.has(jid) || message.timestampMs == null) {
        continue;
      }
      const key = `${jid}\u0000${message.chatSourceId}`;
      const entry = byKey.get(key) ?? { jid, chatSourceId: message.chatSourceId, messages: 0, firstMs: null, lastMs: null };
      entry.messages += 1;
      entry.firstMs = entry.firstMs == null ? message.timestampMs : Math.min(entry.firstMs, message.timestampMs);
      entry.lastMs = entry.lastMs == null ? message.timestampMs : Math.max(entry.lastMs, message.timestampMs);
      byKey.set(key, entry);
    }
    return [...byKey.values()];
  }

  async listGroupParticipantSets(
    options: { maxGroupSize?: number; limit?: number } = {}
  ): Promise<Array<{ groupSourceId: string; participantJids: string[] }>> {
    const maxGroupSize = Math.max(2, options.maxGroupSize ?? 64);
    const limit = Math.max(1, options.limit ?? 500);
    const byGroup = new Map<string, string[]>();
    for (const participant of this.participants.values()) {
      const chat = this.chats.get(participant.chatSourceId);
      if (chat?.chatType !== "group") {
        continue;
      }
      byGroup.set(participant.chatSourceId, [...(byGroup.get(participant.chatSourceId) ?? []), participant.sourceJid]);
    }
    const sets: Array<{ groupSourceId: string; participantJids: string[] }> = [];
    for (const [groupSourceId, participantJids] of byGroup) {
      if (participantJids.length >= 2 && participantJids.length <= maxGroupSize) {
        sets.push({ groupSourceId, participantJids });
        if (sets.length >= limit) {
          break;
        }
      }
    }
    return sets;
  }

  async listCoCitedIdentityPairs(
    options: { minEpisodes?: number; limit?: number } = {}
  ): Promise<Array<{ jidA: string; jidB: string; episodes: number }>> {
    const episodesByPair = new Map<string, Set<string>>();
    for (const episode of this.brainEpisodes.values()) {
      for (const claim of episode.claims) {
        const jids = [...new Set(claim.entities.filter((entity) => entity.kind === "person" && entity.jid).map((entity) => entity.jid!))].sort();
        for (let i = 0; i < jids.length; i += 1) {
          for (let j = i + 1; j < jids.length; j += 1) {
            const key = `${jids[i]}\u0000${jids[j]}`;
            episodesByPair.set(key, (episodesByPair.get(key) ?? new Set()).add(episode.id));
          }
        }
      }
    }
    return [...episodesByPair.entries()]
      .map(([key, episodes]) => {
        const [jidA, jidB] = key.split("\u0000");
        return { jidA, jidB, episodes: episodes.size };
      })
      .filter((pair) => pair.episodes >= Math.max(1, options.minEpisodes ?? 2))
      .sort((a, b) => b.episodes - a.episodes)
      .slice(0, Math.max(1, options.limit ?? 200));
  }

  async listResolvedVcardNames(options: { limit?: number } = {}): Promise<Array<{ resolvedJid: string; displayName: string | null }>> {
    const seen = new Map<string, string | null>();
    for (const vcard of this.vcards.values()) {
      if (vcard.resolvedJid && !seen.has(`${vcard.resolvedJid}\u0000${vcard.displayName ?? ""}`)) {
        seen.set(`${vcard.resolvedJid}\u0000${vcard.displayName ?? ""}`, vcard.displayName ?? null);
      }
    }
    return [...seen.entries()]
      .map(([key, displayName]) => ({ resolvedJid: key.split("\u0000")[0], displayName }))
      .slice(0, Math.max(1, options.limit ?? 1_000));
  }

  // Person-layer reconciliation for the archive-layer LID→PN collapse (mirror
  // of the SQLite rewrite): memberships follow the canonical JID, pair rows
  // re-normalize, self-referential pairs vanish, and persons revealed to share
  // an identity union.
  private rewritePersonLayerForMerge(lid: string, pn: string): void {
    const lidMember = this.personMembers.get(lid);
    const pnMember = this.personMembers.get(pn);
    if (lidMember && pnMember) {
      if (lidMember.personId !== pnMember.personId) {
        this.unionPersons(lidMember.personId, pnMember.personId, { viaJids: [lid, pn], source: "identity_merge" });
      }
      this.personMembers.delete(lid);
    } else if (lidMember) {
      this.personMembers.delete(lid);
      this.personMembers.set(pn, lidMember);
    }
    const statusRank: Record<PersonSuggestionStatus, number> = { rejected: 3, accepted: 2, superseded: 1, pending: 0 };
    for (const [key, suggestion] of [...this.personSuggestions]) {
      if (suggestion.jidLow !== lid && suggestion.jidHigh !== lid) {
        continue;
      }
      this.personSuggestions.delete(key);
      const nextA = suggestion.jidLow === lid ? pn : suggestion.jidLow;
      const nextB = suggestion.jidHigh === lid ? pn : suggestion.jidHigh;
      if (nextA === nextB) {
        continue;
      }
      const [low, high] = this.personPair(nextA, nextB);
      const nextKey = `${low}\u0000${high}\u0000${suggestion.kind}`;
      const existing = this.personSuggestions.get(nextKey);
      if (existing) {
        const keepExisting = statusRank[existing.status] >= statusRank[suggestion.status];
        const survivor = keepExisting ? existing : suggestion;
        survivor.jidLow = low;
        survivor.jidHigh = high;
        survivor.score = Math.max(existing.score, suggestion.score);
        survivor.updatedAt = new Date().toISOString();
        this.personSuggestions.set(nextKey, survivor);
      } else {
        suggestion.jidLow = low;
        suggestion.jidHigh = high;
        suggestion.updatedAt = new Date().toISOString();
        this.personSuggestions.set(nextKey, suggestion);
      }
    }
    for (const [key, suppression] of [...this.personSuppressions]) {
      if (suppression.jidLow !== lid && suppression.jidHigh !== lid) {
        continue;
      }
      this.personSuppressions.delete(key);
      const nextA = suppression.jidLow === lid ? pn : suppression.jidLow;
      const nextB = suppression.jidHigh === lid ? pn : suppression.jidHigh;
      if (nextA === nextB) {
        continue;
      }
      const [low, high] = this.personPair(nextA, nextB);
      const nextKey = this.personPairKey(nextA, nextB);
      if (!this.personSuppressions.has(nextKey)) {
        this.personSuppressions.set(nextKey, { ...suppression, jidLow: low, jidHigh: high });
      }
    }
    for (const event of this.personEvents) {
      if (event.identityJid === lid) {
        event.identityJid = pn;
      }
    }
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
    const enrichedQuoteKeys: string[] = [];
    for (const rawMessage of messages) {
      const chatSourceId = this.canonicalJid(rawMessage.chatSourceId);
      if (!chatSourceId || !rawMessage.sourceMessageId) {
        continue;
      }
      const senderSourceJid =
        rawMessage.senderSourceJid === "me" ? "me" : this.canonicalJid(rawMessage.senderSourceJid) ?? rawMessage.senderSourceJid ?? null;
      const rawSnapshot = rawMessage.quotedSnapshot;
      const quotedSnapshot = rawSnapshot
        ? {
            ...rawSnapshot,
            quotedSourceChatId: this.canonicalJid(rawSnapshot.quotedSourceChatId) ?? rawSnapshot.quotedSourceChatId,
            quotedSenderSourceJid: this.canonicalJid(rawSnapshot.quotedSenderSourceJid) ?? rawSnapshot.quotedSenderSourceJid,
            mentionedJids: (rawSnapshot.mentionedJids ?? []).map((jid) => this.canonicalJid(jid) ?? jid)
          }
        : null;
      const message = { ...rawMessage, quotedSnapshot, chatSourceId, senderSourceJid, sourceMessageKey: messageKey(chatSourceId, rawMessage.sourceMessageId) };
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
      const mergedSnapshot = this.mergeQuotedSnapshot(existing?.quotedSnapshot, message.quotedSnapshot);
      if (JSON.stringify(existing?.quotedSnapshot ?? null) !== JSON.stringify(mergedSnapshot)) {
        enrichedQuoteKeys.push(message.sourceMessageKey);
      }
      this.messages.set(message.sourceMessageKey, {
        ...existing,
        ...message,
        messageType: keepExistingType ? existing!.messageType : message.messageType,
        body: deletionLocked ? existing?.body ?? null : message.body ?? existing?.body ?? null,
        caption: deletionLocked ? existing?.caption ?? null : message.caption ?? existing?.caption ?? null,
        isDeleted: deletionLocked || message.isDeleted,
        quotedSnapshot: mergedSnapshot,
        id: existing?.id ?? this.nextMessageId++
      });
    }
    await this.markStaleEpisodesForQuotedReplies(enrichedQuoteKeys);
    return messages.length;
  }

  async upsertArchiveSignals(batch: ArchiveSignalBatch): Promise<{ changedMessageKeys: string[]; skippedUnanchoredRecords: number }> {
    const changed = new Set<string>();
    // Keep the in-memory implementation aligned with SQLite's foreign-key
    // contract. Some WhatsApp companion tables can retain rows for messages
    // the defensive importer cannot archive, so those companions are not
    // meaningful evidence anchors on their own.
    const retainAnchored = <T extends { sourceMessageKey: string }>(rows: T[] | undefined): T[] =>
      (rows ?? []).filter((row) => this.messages.has(row.sourceMessageKey));
    const locations = retainAnchored(batch.locations);
    const locationObservations = retainAnchored(batch.locationObservations);
    const vcards = retainAnchored(batch.vcards);
    const deletions = retainAnchored(batch.deletions);
    const mediaInterpretations = retainAnchored(batch.mediaInterpretations);
    const numberChanges = (batch.numberChanges ?? []).map((row) => ({
      ...row,
      eventKey: stableSignalFactKey("number_change", [row.sourceMessageKey, row.chatSourceId, row.oldJid, row.newJid, row.observedAtMs])
    }));
    const membershipPeriods = (batch.membershipPeriods ?? []).map((row) => ({
      ...row,
      periodKey: stableSignalFactKey("membership_period", [row.groupSourceId, row.participantJid, row.joinedAtMs, row.leftAtMs, row.role])
    }));
    const membershipEvents = (batch.membershipEvents ?? []).map((row) => ({
      ...row,
      eventKey: stableSignalFactKey("membership_event", [row.groupSourceId, row.participantJid, row.action, row.observedAtMs, row.oldRole, row.newRole])
    }));
    const chatMetadataHistory = (batch.chatMetadataHistory ?? []).map((row) => ({
      ...row,
      eventKey: stableSignalFactKey("chat_metadata", [row.chatSourceId, row.field, row.oldValue, row.newValue, row.observedAtMs])
    }));
    const editEvents = retainAnchored(batch.editEvents).map((row) => ({
      ...row,
      eventKey: stableSignalFactKey("edit", row.observedAtMs == null
        ? [row.sourceMessageKey, null, row.originalSourceMessageId, row.observedEditMessageId, row.sourceEventKey]
        : [row.sourceMessageKey, row.observedAtMs])
    }));
    const skippedUnanchoredRecords =
      (batch.locations?.length ?? 0) - locations.length +
      (batch.locationObservations?.length ?? 0) - locationObservations.length +
      (batch.vcards?.length ?? 0) - vcards.length +
      (batch.editEvents?.length ?? 0) - editEvents.length +
      (batch.deletions?.length ?? 0) - deletions.length +
      (batch.mediaInterpretations?.length ?? 0) - mediaInterpretations.length;
    const aggregateMaxFields = new Set([
      "eligibleOutgoingCount",
      "deliveredCount",
      "readCount",
      "responseLatencySampleCount",
      "algorithmVersion"
    ]);
    const merge = <T extends { captureVersion: number; observedAtMs: number | null }>(map: Map<string, T>, key: string, incoming: T, messageKey: string | null = null): void => {
      const existing = map.get(key);
      if (!existing) {
        map.set(key, structuredClone(incoming));
        if (messageKey) changed.add(messageKey);
        return;
      }
      const next: Record<string, unknown> = { ...existing };
      let enriched = false;
      const existingRecord = existing as T & { kind?: unknown; startMs?: unknown; endMs?: unknown };
      const incomingRecord = incoming as T & { kind?: unknown; endMs?: unknown; isLive?: unknown; liveShareDurationMs?: unknown; sequenceNumber?: unknown; finalAtMs?: unknown };
      if (
        existingRecord.kind === "transcription_segment" &&
        incomingRecord.endMs == null &&
        typeof existingRecord.startMs === "number" &&
        existingRecord.endMs === existingRecord.startMs
      ) {
        // A capture-v1 importer represented an unavailable segment duration as
        // a zero-length range. A same-segment replay can safely restore the
        // source's honest "timestamp only" state.
        next.endMs = null;
        enriched = true;
      }
      const existingLocation = existing as T & { isLive?: unknown; liveShareDurationMs?: unknown; sequenceNumber?: unknown; finalAtMs?: unknown };
      if (
        existingLocation.liveShareDurationMs === 0 &&
        existingLocation.sequenceNumber === 0 &&
        existingLocation.finalAtMs == null &&
        incomingRecord.liveShareDurationMs == null &&
        incomingRecord.sequenceNumber == null &&
        incomingRecord.finalAtMs == null &&
        incomingRecord.isLive === false
      ) {
        // SQL NULL was once coerced to zero for these two Android columns,
        // making a static location look live. Only clear the exact legacy
        // signature when the replayed source has no live-location fields.
        next.liveShareDurationMs = null;
        next.sequenceNumber = null;
        next.isLive = false;
        enriched = true;
      }
      for (const [field, value] of Object.entries(incoming) as Array<[string, unknown]>) {
        if (field === "source" || field === "sourceEventKey" || field === "observedAtMs" || field === "captureVersion") continue;
        const current = next[field];
        if (value != null && current == null) {
          next[field] = value;
          enriched = true;
        } else if (aggregateMaxFields.has(field) && typeof value === "number" && typeof current === "number" && value > current) {
          next[field] = value;
          enriched = true;
        } else if (field === "windowEndAtMs" && typeof value === "number" && typeof current === "number" && value > current) {
          next[field] = value;
          enriched = true;
        } else if (field === "medianResponseLatencyMs" && typeof value === "number" && value !== current) {
          // An aggregate recomputation may retain the same count while
          // improving its exact median; SQLite accepts any non-null result.
          next[field] = value;
          enriched = true;
        } else if (field === "liveShareDurationMs" && typeof value === "number" && typeof current === "number" && value === current * 1000) {
          // Capture v1 briefly persisted Android's seconds value under the
          // millisecond archive field. Recognize only that exact legacy unit
          // relationship so a replay can repair it without weakening the
          // normal non-destructive merge contract.
          next[field] = value;
          enriched = true;
        } else if (field === "text" && typeof value === "string" && value.length > String(current ?? "").length) {
          // Source interpretations have one natural lossless tie-breaker:
          // retain the longer non-empty source-provided text.
          next[field] = value;
          enriched = true;
        } else if (typeof value === "boolean" && value && current !== true) {
          // The only boolean source signal today is live-location state; like
          // SQLite's MAX(existing.is_live, excluded.is_live), a positive
          // observation enriches a prior false/unknown value but never drops it.
          next[field] = true;
          enriched = true;
        }
      }
      const nextCaptureVersion = Math.max(Number(existing.captureVersion ?? 1), Number(incoming.captureVersion ?? 1));
      next.captureVersion = nextCaptureVersion;
      const incomingIsNewer =
        (existing.observedAtMs == null && incoming.observedAtMs != null) ||
        (existing.observedAtMs != null && incoming.observedAtMs != null && incoming.observedAtMs > existing.observedAtMs) ||
        (existing.observedAtMs === incoming.observedAtMs && (incoming as T & { source?: unknown }).source === "live" && (existing as T & { source?: unknown }).source === "backup");
      next.observedAtMs = Math.max(Number(existing.observedAtMs ?? 0), Number(incoming.observedAtMs ?? 0)) || null;
      const incomingSource = incoming as T & { source?: unknown; sourceEventKey?: unknown };
      const existingSource = existing as T & { source?: unknown; sourceEventKey?: unknown };
      const nextSource = incomingIsNewer ? incomingSource.source : existingSource.source;
      const nextSourceEventKey = incomingIsNewer
        ? incomingSource.sourceEventKey ?? existingSource.sourceEventKey
        : existingSource.sourceEventKey ?? incomingSource.sourceEventKey;
      const provenanceChanged = nextSource !== existingSource.source || nextSourceEventKey !== existingSource.sourceEventKey;
      if (enriched || nextCaptureVersion !== existing.captureVersion || provenanceChanged) {
        next.source = nextSource;
        next.sourceEventKey = nextSourceEventKey;
        map.set(key, next as T);
        if (messageKey && (enriched || nextCaptureVersion !== existing.captureVersion)) changed.add(messageKey);
      }
    };
    const canonical = (jid: string | null | undefined): string | null => this.canonicalJid(jid);
    const allowRealAnchorToReplaceSynthetic = <T extends { sourceMessageKey?: string | null }>(map: Map<string, T>, key: string, incoming: T) => {
      const existing = map.get(key);
      if (existing && isSyntheticSystemAnchor(existing.sourceMessageKey) && incoming.sourceMessageKey && !isSyntheticSystemAnchor(incoming.sourceMessageKey)) {
        map.set(key, { ...existing, sourceMessageKey: null });
      }
    };
    for (const row of numberChanges) {
      allowRealAnchorToReplaceSynthetic(this.numberChanges, row.eventKey, row);
      merge(this.numberChanges, row.eventKey, { ...row, chatSourceId: canonical(row.chatSourceId), oldJid: canonical(row.oldJid) ?? row.oldJid, newJid: canonical(row.newJid) ?? row.newJid, actorJid: canonical(row.actorJid) });
    }
    for (const row of membershipPeriods) merge(this.membershipPeriods, row.periodKey, { ...row, groupSourceId: canonical(row.groupSourceId) ?? row.groupSourceId, participantJid: canonical(row.participantJid) ?? row.participantJid });
    for (const row of membershipEvents) {
      allowRealAnchorToReplaceSynthetic(this.membershipEvents, row.eventKey, row);
      merge(this.membershipEvents, row.eventKey, { ...row, groupSourceId: canonical(row.groupSourceId) ?? row.groupSourceId, participantJid: canonical(row.participantJid) ?? row.participantJid, actorJid: canonical(row.actorJid) });
    }
    for (const row of chatMetadataHistory) {
      allowRealAnchorToReplaceSynthetic(this.chatMetadataHistory, row.eventKey, row);
      merge(this.chatMetadataHistory, row.eventKey, { ...row, chatSourceId: canonical(row.chatSourceId) ?? row.chatSourceId, actorJid: canonical(row.actorJid) });
    }
    for (const row of locations) merge(this.locations, row.sourceMessageKey, row, row.sourceMessageKey);
    for (const row of locationObservations) merge(this.locationObservations, row.observationKey, row, row.sourceMessageKey);
    for (const row of vcards) merge(this.vcards, `${row.sourceMessageKey}:${row.cardIndex}`, { ...row, resolvedJid: canonical(row.resolvedJid) }, row.sourceMessageKey);
    const rekeyEditObservations = (oldFactKey: string, newFactKey: string) => {
      if (oldFactKey === newFactKey) return;
      for (const [key, observation] of [...this.signalObservations]) {
        if (observation.family !== "edit" || observation.factKey !== oldFactKey) continue;
        this.signalObservations.delete(key);
        const next = { ...observation, factKey: newFactKey };
        this.signalObservations.set(`${newFactKey}:edit:${next.source}:${next.sourceEventKey ?? ""}`, next);
      }
    };
    for (const row of editEvents) {
      for (const [existingKey, existing] of [...this.editEvents]) {
        const sameSourceObservation = row.sourceEventKey != null
          && existing.source === row.source
          && existing.sourceEventKey === row.sourceEventKey;
        const message = this.messages.get(row.sourceMessageKey);
        const legacyEnvelopeTime = row.observedAtMs != null
          && message?.timestampMs != null
          && row.observedAtMs > message.timestampMs
          && existing.source === "live"
          && existing.sourceEventKey?.startsWith("wa-web:edit:")
          && existing.observedAtMs === message.timestampMs;
        if (existingKey === row.eventKey || (!sameSourceObservation && !legacyEnvelopeTime)) continue;
        rekeyEditObservations(existingKey, row.eventKey);
        this.editEvents.delete(existingKey);
      }
      merge(this.editEvents, row.eventKey, row, row.sourceMessageKey);
    }
    for (const row of deletions) merge(this.deletions, row.sourceMessageKey, { ...row, revokedByJid: canonical(row.revokedByJid) }, row.sourceMessageKey);
    for (const row of mediaInterpretations) merge(this.mediaInterpretations, `${row.sourceMessageKey}:${row.kind}:${row.segmentIndex}`, row, row.sourceMessageKey);
    for (const row of batch.engagementAggregates ?? []) merge(this.engagementAggregates, row.aggregateKey, { ...row, chatSourceId: canonical(row.chatSourceId) ?? row.chatSourceId, counterpartyJid: canonical(row.counterpartyJid) });
    const observe = (
      factKey: string,
      family: ArchiveSignalObservation["family"],
      row: { source: ArchiveSignalObservation["source"]; sourceEventKey: string | null; observedAtMs: number | null; captureVersion: number; sourceMessageKey?: string | null },
      detailJson: string | null = null
    ) => {
      const key = `${factKey}:${family}:${row.source}:${row.sourceEventKey ?? ""}`;
      merge(this.signalObservations, key, { factKey, family, source: row.source, sourceEventKey: row.sourceEventKey, sourceMessageKey: row.sourceMessageKey ?? null, observedAtMs: row.observedAtMs, captureVersion: row.captureVersion, detailJson }, row.sourceMessageKey ?? null);
    };
    for (const row of numberChanges) observe(row.eventKey, "number_change", row);
    for (const row of membershipPeriods) observe(row.periodKey, "membership_period", row);
    for (const row of membershipEvents) observe(row.eventKey, "membership_event", row, row.rawType || row.rawParameters ? JSON.stringify({ rawType: row.rawType ?? null, rawParameters: row.rawParameters ?? null }) : null);
    for (const row of chatMetadataHistory) observe(row.eventKey, "chat_metadata", row, row.rawType || row.rawParameters ? JSON.stringify({ rawType: row.rawType ?? null, rawParameters: row.rawParameters ?? null }) : null);
    for (const row of locations) observe(row.sourceMessageKey, "location", row);
    for (const row of locationObservations) observe(row.observationKey, "location_observation", row);
    for (const row of vcards) observe(`${row.sourceMessageKey}:${row.cardIndex}`, "vcard", row);
    for (const row of editEvents) observe(row.eventKey, "edit", row);
    for (const row of deletions) observe(row.sourceMessageKey, "deletion", row);
    for (const row of mediaInterpretations) observe(`${row.sourceMessageKey}:${row.kind}:${row.segmentIndex}`, "media_interpretation", row);
    const keys = [...changed];
    if (keys.length) await this.markStaleEpisodesForMessages(keys);
    return { changedMessageKeys: keys, skippedUnanchoredRecords };
  }

  async repairAmbiguousSelfMembershipFacts(): Promise<number> {
    const keys = [...this.membershipEvents.values()]
      .filter((row) => row.participantJid === "me" && row.source === "backup" && row.sourceEventKey?.startsWith("backup:message_system_group:"))
      .map((row) => row.eventKey);
    for (const key of keys) {
      this.membershipEvents.delete(key);
      for (const [observationKey, observation] of this.signalObservations) {
        if (observation.family === "membership_event" && observation.factKey === key) this.signalObservations.delete(observationKey);
      }
    }
    return keys.length;
  }

  async listIdentityNumberChanges(options: { oldJid?: string; newJid?: string; limit?: number } = {}): Promise<IdentityNumberChangeRecord[]> {
    const oldJid = options.oldJid ? this.canonicalJid(options.oldJid) ?? options.oldJid : null;
    const newJid = options.newJid ? this.canonicalJid(options.newJid) ?? options.newJid : null;
    return [...this.numberChanges.values()].filter((row) => (!oldJid || row.oldJid === oldJid) && (!newJid || row.newJid === newJid)).sort((a, b) => (b.observedAtMs ?? 0) - (a.observedAtMs ?? 0)).slice(0, options.limit ?? 500).map((row) => structuredClone(row));
  }

  async listGroupMembershipPeriods(options: { groupSourceId?: string; participantJid?: string; limit?: number } = {}): Promise<GroupMembershipPeriodRecord[]> {
    const group = options.groupSourceId ? this.canonicalJid(options.groupSourceId) ?? options.groupSourceId : null;
    const participant = options.participantJid ? this.canonicalJid(options.participantJid) ?? options.participantJid : null;
    return [...this.membershipPeriods.values()].filter((row) => (!group || row.groupSourceId === group) && (!participant || row.participantJid === participant)).sort((a, b) => (b.joinedAtMs ?? 0) - (a.joinedAtMs ?? 0)).slice(0, options.limit ?? 500).map((row) => structuredClone(row));
  }

  async listGroupMembershipEvents(options: { groupSourceId?: string; participantJid?: string; limit?: number } = {}): Promise<GroupMembershipEventRecord[]> {
    const group = options.groupSourceId ? this.canonicalJid(options.groupSourceId) ?? options.groupSourceId : null;
    const participant = options.participantJid ? this.canonicalJid(options.participantJid) ?? options.participantJid : null;
    return [...this.membershipEvents.values()].filter((row) => (!group || row.groupSourceId === group) && (!participant || row.participantJid === participant)).sort((a, b) => (b.observedAtMs ?? 0) - (a.observedAtMs ?? 0)).slice(0, options.limit ?? 500).map((row) => structuredClone(row));
  }

  async listChatMetadataHistory(options: { chatSourceId?: string; limit?: number } = {}): Promise<ChatMetadataHistoryRecord[]> {
    const chat = options.chatSourceId ? this.canonicalJid(options.chatSourceId) ?? options.chatSourceId : null;
    return [...this.chatMetadataHistory.values()].filter((row) => !chat || row.chatSourceId === chat).sort((a, b) => (b.observedAtMs ?? 0) - (a.observedAtMs ?? 0)).slice(0, options.limit ?? 500).map((row) => structuredClone(row));
  }

  async listEngagementAggregates(options: { chatSourceId?: string; counterpartyJid?: string; limit?: number } = {}): Promise<EngagementAggregateRecord[]> {
    const chat = options.chatSourceId ? this.canonicalJid(options.chatSourceId) ?? options.chatSourceId : null;
    const person = options.counterpartyJid ? this.canonicalJid(options.counterpartyJid) ?? options.counterpartyJid : null;
    return [...this.engagementAggregates.values()].filter((row) => (!chat || row.chatSourceId === chat) && (!person || row.counterpartyJid === person)).sort((a, b) => (b.windowEndAtMs ?? 0) - (a.windowEndAtMs ?? 0)).slice(0, options.limit ?? 500).map((row) => structuredClone(row));
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
    this.numberChanges.clear();
    this.membershipPeriods.clear();
    this.membershipEvents.clear();
    this.chatMetadataHistory.clear();
    this.locations.clear();
    this.locationObservations.clear();
    this.vcards.clear();
    this.editEvents.clear();
    this.deletions.clear();
    this.mediaInterpretations.clear();
    this.engagementAggregates.clear();
    this.signalObservations.clear();
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
    // Person layer references identities, so it clears with the archive
    // (mirror of DELETE_TABLE_ORDER in the SQLite adapter).
    this.persons.clear();
    this.personMembers.clear();
    this.personSuppressions.clear();
    this.personSuggestions.clear();
    this.personEvents = [];
    this.personRedirects.clear();
    this.googleContactGroups.clear();
    this.nextPersonEventId = 1;
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
    const changedMessageKeys: string[] = [];
    for (const preview of previews) {
      const chatSourceId = this.canonicalJid(preview.chatSourceId) ?? preview.chatSourceId;
      if (!chatSourceId || !preview.sourceMessageId) {
        continue;
      }
      const key = messageKey(chatSourceId, preview.sourceMessageId);
      const existing = this.linkPreviews.get(key);
      if (!existing) {
        this.linkPreviews.set(key, { ...preview, chatSourceId });
        recorded += 1;
        changedMessageKeys.push(key);
        continue;
      }
      const enriched = {
        ...existing,
        title: existing.title ?? preview.title ?? null,
        description: existing.description ?? preview.description ?? null,
        canonicalUrl: existing.canonicalUrl ?? preview.canonicalUrl ?? null,
        thumbnail: existing.thumbnail ?? preview.thumbnail ?? null
      };
      if (JSON.stringify(existing) !== JSON.stringify(enriched)) {
        this.linkPreviews.set(key, enriched);
        recorded += 1;
        changedMessageKeys.push(key);
      }
    }
    if (changedMessageKeys.length > 0) {
      await this.markStaleEpisodesForMessages(changedMessageKeys);
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

  async getQuotedSnapshotThumbnail(messageId: number): Promise<Uint8Array | null> {
    const message = [...this.messages.values()].find((candidate) => candidate.id === messageId);
    return message?.quotedSnapshot?.thumbnail ?? null;
  }

  async listMessageEditRevisions(messageId: number): Promise<MessageEditRevisionRecord[]> {
    const message = [...this.messages.values()].find((candidate) => candidate.id === messageId);
    if (!message) {
      return [];
    }
    return [...(this.editRevisions.get(message.sourceMessageKey) ?? [])].sort((a, b) => a.revisionIndex - b.revisionIndex);
  }

  async getMessageDetail(messageId: number): Promise<MessageDetail | null> {
    const message = [...this.messages.values()].find((candidate) => candidate.id === messageId);
    if (!message) return null;
    const sourceMessageKey = message.sourceMessageKey;
    const observationsFor = (factKey: string, family: import("../../shared/types").ArchiveSignalObservation["family"]) =>
      [...this.signalObservations.values()].filter((row) => row.factKey === factKey && row.family === family).sort((a, b) => (a.observedAtMs ?? 0) - (b.observedAtMs ?? 0)).map((row) => structuredClone(row));
    const location = this.locations.get(sourceMessageKey);
    const locationObservations = [...this.locationObservations.values()].filter((row) => row.sourceMessageKey === sourceMessageKey).sort((a, b) => (a.sequenceNumber ?? Number.MAX_SAFE_INTEGER) - (b.sequenceNumber ?? Number.MAX_SAFE_INTEGER) || (a.observedAtMs ?? 0) - (b.observedAtMs ?? 0));
    const locations = location ? [{ ...structuredClone(location), observations: structuredClone(locationObservations), provenance: observationsFor(sourceMessageKey, "location") }] : [];
    const vcards = [...this.vcards.values()].filter((row) => row.sourceMessageKey === sourceMessageKey).sort((a, b) => a.cardIndex - b.cardIndex).map((row) => {
      const card = structuredClone(row);
      return { ...(!card.vcard && card.displayName && phoneFromJid(card.resolvedJid) ? { ...card, downloadKind: "constructed" as const } : card), provenance: observationsFor(`${sourceMessageKey}:${row.cardIndex}`, "vcard") };
    });
    const revisions = await this.listMessageEditRevisions(messageId);
    const edits = [...this.editEvents.values()].filter((row) => row.sourceMessageKey === sourceMessageKey).sort((a, b) => (a.observedAtMs ?? 0) - (b.observedAtMs ?? 0));
    const editTimeline = buildMessageEditTimeline({
      sentAtMs: message.timestampMs ?? null,
      currentText: message.body ?? message.caption ?? null,
      revisions,
      events: edits.map((edit) => ({ timestampMs: edit.observedAtMs, source: edit.source, sourceEventKey: edit.sourceEventKey }))
    });
    const deletionRecord = this.deletions.get(sourceMessageKey) ?? null;
    const deletion = deletionRecord ? {
      revokedByJid: deletionRecord.revokedByJid,
      revokedByAdmin: deletionRecord.revokedByAdmin ?? null,
      deletionKind: deletionRecord.deletionKind ?? null,
      deletedAtMs: deletionRecord.observedAtMs,
      sentAtMs: message.timestampMs ?? null,
      contentState: message.body || message.caption || locations.length || vcards.length ? "retained" as const : "never_captured" as const,
      observations: observationsFor(sourceMessageKey, "deletion")
    } : null;
    const mediaInterpretations = [...this.mediaInterpretations.values()].filter((row) => row.sourceMessageKey === sourceMessageKey).sort((a, b) => a.kind.localeCompare(b.kind) || a.segmentIndex - b.segmentIndex).map((row) => structuredClone(row));
    const preview = this.linkPreviews.get(sourceMessageKey);
    const systemEvents = this.systemEventDetails(message, observationsFor);
    if (message.messageType === "system" && systemEvents.length === 0) {
      systemEvents.push({
        kind: "generic",
        eventKey: `generic:${sourceMessageKey}`,
        summary: "System event",
        actorJid: null,
        actorLabel: null,
        participantJid: null,
        participantLabel: null,
        oldJid: null,
        oldIdentityLabel: null,
        newJid: null,
        newIdentityLabel: null,
        oldValue: null,
        newValue: null,
        action: null,
        field: null,
        occurredAtMs: message.timestampMs ?? null,
        rawType: message.rawTypeCode == null ? null : String(message.rawTypeCode),
        rawParameters: message.rawMetadata == null ? null : JSON.stringify(message.rawMetadata),
        observations: []
      });
    }
    return {
      id: message.id,
      sourceMessageKey,
      sentAtMs: message.timestampMs ?? null,
      availability: { hasLocation: locations.length > 0, vcardCount: vcards.length, hasDeletion: Boolean(deletion), hasEditHistory: edits.length > 0 || revisions.length > 0, hasSourceInterpretation: mediaInterpretations.length > 0, hasSystemEventDetail: systemEvents.length > 0 },
      locations,
      vcards,
      mentionedJids: [...(message.mentionedJids ?? [])],
      editTimeline,
      deletion,
      mediaInterpretations,
      linkPreview: preview ? { title: preview.title, description: preview.description, canonicalUrl: preview.canonicalUrl, hasThumbnail: Boolean(preview.thumbnail?.length) } : null,
      systemEvents
    };
  }

  async getMessageVcardDownload(messageId: number, cardIndex: number): Promise<{ content: string; fileName: string; constructed: boolean } | null> {
    const message = [...this.messages.values()].find((candidate) => candidate.id === messageId);
    const card = message ? this.vcards.get(`${message.sourceMessageKey}:${cardIndex}`) : null;
    if (!card) return null;
    if (card.vcard?.trim()) return { content: card.vcard, fileName: safeVcardFileName(card.downloadFileName ?? card.displayName, card.cardIndex), constructed: false };
    const phone = phoneFromJid(card.resolvedJid);
    if (!card.displayName?.trim() || !phone) return null;
    return { content: constructMinimalVcard(card.displayName, phone), fileName: safeVcardFileName(card.downloadFileName ?? card.displayName, card.cardIndex), constructed: true };
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

  // Render-time person disambiguation over one response's label list (mirror
  // of the SQLite adapter): same label across DIFFERENT persons gains a
  // deterministic complete-number suffix; one person's identities never
  // disambiguate against each other.
  private disambiguateEntryLabels(entries: Array<{ label: string | null; jid: string | null }>): Array<string | null> {
    return disambiguateLabels(
      entries.map((entry) => ({
        label: entry.jid ? entry.label : null,
        jid: entry.jid,
        personKey: entry.jid ? this.personMembers.get(entry.jid)?.personId ?? entry.jid : "no-identity"
      }))
    );
  }

  // Display-level unconfirmed hints for DM counterparties (mirror of SQLite).
  private chatHintFor(jid: string): string | null {
    let best: { otherJid: string; score: number } | null = null;
    for (const suggestion of this.personSuggestions.values()) {
      if (suggestion.status !== "pending" || suggestion.score < config.persons.hintScoreThreshold) {
        continue;
      }
      if (suggestion.jidLow !== jid && suggestion.jidHigh !== jid) {
        continue;
      }
      const otherJid = suggestion.jidLow === jid ? suggestion.jidHigh : suggestion.jidLow;
      if (!best || suggestion.score > best.score) {
        best = { otherJid, score: suggestion.score };
      }
    }
    return best ? `possibly the same as ${this.resolveCurrentLabelForJid(best.otherJid) ?? best.otherJid} — unconfirmed` : null;
  }

  async listChats(options: ChatListOptions): Promise<ChatListItem[]> {
    const search = options.search?.toLowerCase();
    const searchDigits = search ? search.replace(/\D/g, "") : "";
    const items: ChatListItem[] = [...this.chats.values()]
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
    const isIdentityChat = (item: ChatListItem): boolean => item.chatType === "dm" || item.chatType === "unknown";
    const adjusted = this.disambiguateEntryLabels(
      items.map((item) => (isIdentityChat(item) ? { label: item.displayName, jid: item.sourceChatId } : { label: null, jid: null }))
    );
    items.forEach((item, index) => {
      if (isIdentityChat(item)) {
        if (adjusted[index] != null) {
          item.displayName = adjusted[index];
        }
        const hint = this.chatHintFor(item.sourceChatId);
        if (hint) {
          item.unconfirmedHint = hint;
        }
      }
    });
    return items;
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
    const items = [...this.messages.values()]
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
          structuredSignals: summarizeStructuredSignals(this.structuredSignals(message)),
          systemEvents: this.systemEventsForMessage(message),
          quotedSnapshot: this.quoteSummary(message),
          isEdited: Boolean(message.rawMetadata?.edited) || revisions.length > 0,
          editRevisionCount: revisions.length,
          isDeleted: message.isDeleted,
          isForwarded: message.isForwarded,
          isStarred: message.isStarred
        };
      });
    // Same-name persons stay visually distinct within the thread page.
    const adjustedSenders = this.disambiguateEntryLabels(
      items.map((item) => ({ label: item.senderDisplayName, jid: item.senderSourceJid }))
    );
    items.forEach((item, index) => {
      if (adjustedSenders[index] != null) {
        item.senderDisplayName = adjustedSenders[index];
      }
    });
    return items;
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

  // Search strata for one message, mirroring the SQLite derived columns:
  // content (mention-resolved body/caption, raw body/caption, media name),
  // sender label, and context (orphan-quote + link-preview text). The scan
  // recomputes these live, so quote-orphan convergence is automatic here.
  private searchStrataForMessage(message: MessageRecord & { id: number }): {
    haystackFields: Array<string | null>;
    contextText: string | null;
    contentWords: string[];
    contextWords: string[];
  } {
    const mentionLabels = this.resolveMentionLabels([message.body ?? null, message.caption ?? null]);
    const haystackFields = [
      applyMentionLabels(message.body ?? null, mentionLabels),
      applyMentionLabels(message.caption ?? null, mentionLabels),
      message.body ?? null,
      message.caption ?? null,
      message.mediaName ?? null
    ];
    const parts: string[] = [];
    const snapshot = message.quotedSnapshot;
    if (snapshot && (snapshot.body?.trim() || snapshot.caption?.trim())) {
      const sourceChat = snapshot.quotedSourceChatId ?? message.chatSourceId;
      const original = snapshot.quotedSourceMessageId ? this.messages.get(messageKey(sourceChat, snapshot.quotedSourceMessageId)) : undefined;
      if (!original || original.isDeleted) {
        if (snapshot.body?.trim()) {
          parts.push(snapshot.body.trim());
        }
        if (snapshot.caption?.trim()) {
          parts.push(snapshot.caption.trim());
        }
      }
    }
    const preview = this.linkPreviews.get(message.sourceMessageKey);
    if (preview?.title?.trim()) {
      parts.push(preview.title.trim());
    }
    if (preview?.description?.trim()) {
      parts.push(preview.description.trim());
    }
    if (preview?.canonicalUrl?.trim()) {
      parts.push(preview.canonicalUrl.trim());
    }
    const contextText = parts.length > 0 ? parts.join("\n") : null;
    return {
      haystackFields,
      contextText,
      contentWords: normalizedWords(haystackFields.filter(Boolean).join("\n")),
      contextWords: normalizedWords(contextText)
    };
  }

  // Corpus-wide effective document frequency for a token at tier-1 looseness
  // (mirror of the fts5vocab measurement — unscoped by query filters).
  private memoryTokenDf(token: QueryToken): number {
    const probeGroup: PlanGroup = { alternatives: dfProbesForToken(token), sourceText: token.text, quoted: token.quoted };
    let df = 0;
    for (const message of this.messages.values()) {
      const strata = this.searchStrataForMessage(message);
      const sender = message.senderSourceJid ? this.contacts.get(message.senderSourceJid) : null;
      const senderLabel =
        sender?.displayName?.trim() || sender?.pushName?.trim() || sender?.phoneNumber || displayPhoneFromJid(message.senderSourceJid) || null;
      const words = [...strata.contentWords, ...normalizedWords(senderLabel), ...strata.contextWords];
      if (groupMatchesWords(probeGroup, words)) {
        df += 1;
      }
    }
    return df;
  }

  async searchMessages(options: SearchQueryOptions): Promise<SearchResponse> {
    const index = await this.getSearchIndexStatus();
    const tokens = attachAliasVariants(tokenizeSearchQuery(options.query), (norm) => this.lookupTermAliases(norm));
    if (tokens.length === 0) {
      return { index, totalMatches: 0, results: [], matchTier: "exact", relaxation: null };
    }
    const chatBysourceId = new Map([...this.chats.values()].map((chat) => [chat.sourceChatId, chat]));
    const nowMs = Date.now();
    const evaluatePlan = (plan: TierPlan): Array<{ item: SearchResultItem; score: number }> => {
      const scored: Array<{ item: SearchResultItem; score: number }> = [];
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
        const strata = this.searchStrataForMessage(message);
        const senderWords = normalizedWords(senderLabel);
        const allWords = [...strata.contentWords, ...senderWords, ...strata.contextWords];
        if (!planMatchesWords(plan, allWords)) {
          continue;
        }
        const matchedGroups = plan.groups.filter((group) => groupMatchesWords(group, allWords)).length;
        const ageDays = message.timestampMs != null ? Math.max(0, (nowMs - message.timestampMs) / 86_400_000) : 365;
        const recency = 0.2 + 0.8 * Math.pow(0.5, ageDays / 90);
        // Entity boost mirror: transport-authoritative mentions whose resolved
        // label matches a query term.
        const mentionWords = (message.mentionedJids ?? []).map((jid) => normalizedWords(this.resolveCurrentLabelForJid(jid)));
        const boosted = mentionWords.some(
          (words) => words.length > 0 && tokens.some((token) => tokenLenientlyMatchesWords(token, words))
        );
        const score = matchedGroups * recency + (boosted ? MEMORY_SEARCH_MENTION_BOOST : 0);
        const contentAndContextWords = [...strata.contentWords, ...strata.contextWords];
        const contentMatched = plan.groups.some((group) => groupMatchesWords(group, contentAndContextWords));
        const senderMatched = senderWords.length > 0 && tokens.some((token) => tokenLenientlyMatchesWords(token, senderWords));
        const senderOnlyMatch = senderMatched && !contentMatched ? true : undefined;
        const termCoverage = plan.matchTier === "partial" ? countTermCoverage(tokens, allWords) : undefined;
        const snippetFields = [...strata.haystackFields, strata.contextText];
        const snippetSource =
          snippetFields.find((field) => field && plan.groups.some((group) => groupMatchesWords(group, normalizedWords(field)))) ??
          snippetFields.find(Boolean) ??
          "";
        const normalizedSource = normalizeTerm(snippetSource ?? "");
        const snippetToken =
          tokens
            .flatMap((token) => [token.norm, ...token.variants])
            .find((text) => text && normalizedSource.includes(text)) ??
          tokens[0]?.norm ??
          "";
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
            snippet: buildMemorySnippet(snippetSource ?? "", snippetToken),
            score,
            hasMedia: message.hasMedia,
            isDeleted: message.isDeleted,
            ...(senderOnlyMatch ? { senderOnlyMatch } : {}),
            ...(termCoverage ? { termCoverage } : {})
          }
        });
      }
      return scored;
    };
    // Relaxation ladder (mirror of the SQLite executor): strict first, looser
    // tiers only while below the acceptance threshold.
    const minHits = Math.max(1, Math.floor(options.minHits ?? 1));
    let winner: TierPlan | null = null;
    let winnerScored: Array<{ item: SearchResultItem; score: number }> = [];
    let fallback: { plan: TierPlan; scored: Array<{ item: SearchResultItem; score: number }> } | null = null;
    const tryPlans = (plans: TierPlan[]): boolean => {
      for (const plan of plans) {
        const scored = evaluatePlan(plan);
        if (scored.length >= minHits) {
          winner = plan;
          winnerScored = scored;
          return true;
        }
        if (scored.length > 0 && !fallback) {
          fallback = { plan, scored };
        }
      }
      return false;
    };
    const basePlans = buildBasePlans(tokens);
    if (!tryPlans(basePlans)) {
      const dfByNorm = new Map<string, number>();
      for (const token of tokens) {
        if (!token.quoted) {
          dfByNorm.set(token.norm, this.memoryTokenDf(token));
        }
      }
      tryPlans(buildDroppedPlans(tokens, dfByNorm, new Set(basePlans.map((plan) => plan.match))));
    }
    if (!winner && fallback) {
      const best = fallback as { plan: TierPlan; scored: Array<{ item: SearchResultItem; score: number }> };
      winner = best.plan;
      winnerScored = best.scored;
    }
    if (!winner) {
      return { index, totalMatches: 0, results: [], matchTier: "exact", relaxation: null };
    }
    const winningPlan: TierPlan = winner;
    const scored = winnerScored;
    // Ranked-OR mirror: term coverage outranks any single-term score spike.
    if (winningPlan.requireAll) {
      scored.sort((a, b) => b.score - a.score || (b.item.timestampMs ?? 0) - (a.item.timestampMs ?? 0));
    } else {
      scored.sort(
        (a, b) =>
          (b.item.termCoverage?.matched ?? 0) - (a.item.termCoverage?.matched ?? 0) ||
          b.score - a.score ||
          (b.item.timestampMs ?? 0) - (a.item.timestampMs ?? 0)
      );
    }
    const results = scored.slice(options.offset, options.offset + options.limit).map((entry) => entry.item);
    // Same-name persons stay visually distinct within the result page: sender
    // labels always; chat titles only for identity-addressed (DM) chats.
    const adjustedSenders = this.disambiguateEntryLabels(results.map((item) => ({ label: item.senderDisplayName, jid: item.senderSourceJid })));
    const adjustedChats = this.disambiguateEntryLabels(
      results.map((item) =>
        item.chatType === "dm" || item.chatType === "unknown" ? { label: item.chatDisplayName, jid: item.chatSourceId } : { label: null, jid: null }
      )
    );
    results.forEach((item, index) => {
      if (adjustedSenders[index] != null) {
        item.senderDisplayName = adjustedSenders[index];
      }
      if (adjustedChats[index] != null) {
        item.chatDisplayName = adjustedChats[index];
      }
    });
    return {
      index,
      totalMatches: scored.length,
      results,
      matchTier: winningPlan.matchTier,
      relaxation:
        winningPlan.tier === 0
          ? null
          : {
              tier: winningPlan.tier as 1 | 2 | 3 | 4,
              droppedTerms: winningPlan.droppedTerms,
              totalTerms: winningPlan.totalTerms,
              requiredTerms: winningPlan.requiredTerms
            }
    };
  }

  // Bidirectional alias groups (mirror of the SQLite cache), seeded from the
  // same static list so "nhi" finds "nahi" identically in both adapters.
  private lookupTermAliases(norm: string): string[] {
    if (!this.termAliasCache) {
      const cache = new Map<string, string[]>();
      const groups = new Map<string, Set<string>>();
      for (const row of this.termAliasRows) {
        const term = normalizeTerm(row.term);
        const variant = normalizeTerm(row.variant);
        if (!term || !variant || term === variant) {
          continue;
        }
        const group = groups.get(term) ?? new Set<string>();
        group.add(variant);
        groups.set(term, group);
      }
      for (const [term, variants] of groups) {
        const members = [term, ...variants];
        for (const member of members) {
          const others = members.filter((candidate) => candidate !== member);
          const existing = cache.get(member);
          if (existing) {
            for (const other of others) {
              if (!existing.includes(other)) {
                existing.push(other);
              }
            }
          } else {
            cache.set(member, [...others]);
          }
        }
      }
      this.termAliasCache = cache;
    }
    return this.termAliasCache.get(norm) ?? [];
  }

  async addTermAliases(entries: Array<{ term: string; variant: string; source?: string; weight?: number }>): Promise<number> {
    let added = 0;
    for (const entry of entries) {
      const term = normalizeTerm(entry.term ?? "").trim();
      const variant = normalizeTerm(entry.variant ?? "").trim();
      if (!term || !variant || term === variant) {
        continue;
      }
      const exists = this.termAliasRows.some((row) => normalizeTerm(row.term) === term && normalizeTerm(row.variant) === variant);
      if (!exists) {
        this.termAliasRows.push({ term, variant });
        added += 1;
      }
    }
    if (added > 0) {
      this.termAliasCache = null;
    }
    return added;
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

  async getBrainChatBacklog(options: { limit: number; minPending?: number; chatSourceId?: string | null }): Promise<BrainChatBacklogItem[]> {
    const minPending = Math.max(1, options.minPending ?? 1);
    const scope = options.chatSourceId ? this.canonicalJid(options.chatSourceId) ?? options.chatSourceId : null;
    const items: BrainChatBacklogItem[] = [];
    for (const chat of this.chats.values()) {
      if (scope && chat.sourceChatId !== scope) {
        continue;
      }
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

  async claimDueBrainTasks(limit: number, nowMs = Date.now(), kind?: BrainTaskKind): Promise<BrainTaskRecord[]> {
    const due = [...this.brainTasks.values()]
      .filter((task) => task.status === "pending" && (task.nextAttemptAtMs == null || task.nextAttemptAtMs <= nowMs))
      .filter((task) => !kind || task.kind === kind)
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

  // --- Owner self-identities (mirror of the SQLite semantics) --------------

  private ownerSelfJids: string[] = [];

  private memOwnerSelfIdentityRecord(jid: string): OwnerSelfIdentity {
    const canonical = this.canonicalJid(jid) ?? jid;
    const contact = this.contacts.get(canonical);
    const number = `+${(canonical.split("@")[0] ?? "").replace(/\D/g, "")}`;
    const label = contact
      ? resolveDisplayLabel({
          displayName: contact.displayName,
          pushName: contact.pushName,
          phoneNumber: contact.phoneNumber,
          jid: canonical
        })
      : null;
    const currentLabel = label && label !== number && !/^\+?\d[\d\s]*$/.test(label) ? label : null;
    let messageCount = 0;
    for (const message of this.messages.values()) {
      if (message.senderSourceJid === canonical) {
        messageCount += 1;
      }
    }
    return { jid: canonical, number, currentLabel, messageCount };
  }

  async getArchiveOwnerSelfIdentities(): Promise<OwnerSelfIdentity[]> {
    const seen = new Set<string>();
    const out: OwnerSelfIdentity[] = [];
    for (const jid of this.ownerSelfJids) {
      const canonical = this.canonicalJid(jid) ?? jid;
      if (seen.has(canonical)) {
        continue;
      }
      seen.add(canonical);
      out.push(this.memOwnerSelfIdentityRecord(canonical));
    }
    return out;
  }

  async setArchiveOwnerSelfJids(inputs: string[]): Promise<OwnerSelfIdentity[]> {
    const jids: string[] = [];
    for (const raw of inputs) {
      const normalized = normalizeOwnerSelfInput(raw);
      if ("error" in normalized) {
        throw new PublicError("invalid_self_number", normalized.error);
      }
      const canonical = this.canonicalJid(normalized.jid) ?? normalized.jid;
      if (!jids.includes(canonical)) {
        jids.push(canonical);
      }
    }
    this.ownerSelfJids = jids;
    return jids.map((jid) => this.memOwnerSelfIdentityRecord(jid));
  }

  async listOwnerIdentitySuggestions(query: string, limit = 12): Promise<OwnerIdentitySuggestion[]> {
    const q = query.trim();
    if (q.length < 2) {
      return [];
    }
    const digits = q.replace(/\D/g, "");
    const lower = q.toLowerCase();
    const selfJids = new Set((await this.getArchiveOwnerSelfIdentities()).map((identity) => identity.jid));
    const matches: OwnerIdentitySuggestion[] = [];
    for (const contact of this.contacts.values()) {
      const jid = contact.sourceJid;
      if (!isIdentityServerJid(jid)) {
        continue;
      }
      const jidDigits = (jid.split("@")[0] ?? "").replace(/\D/g, "");
      const nameMatch =
        (contact.displayName ?? "").toLowerCase().includes(lower) || (contact.pushName ?? "").toLowerCase().includes(lower);
      const digitMatch = digits.length >= 2 && jidDigits.includes(digits);
      if (!nameMatch && !digitMatch) {
        continue;
      }
      let messageCount = 0;
      for (const message of this.messages.values()) {
        if (message.senderSourceJid === jid) {
          messageCount += 1;
        }
      }
      matches.push({
        jid,
        number: `+${jidDigits}`,
        label: resolveDisplayLabel({
          displayName: contact.displayName,
          pushName: contact.pushName,
          phoneNumber: contact.phoneNumber,
          jid
        }),
        messageCount,
        isSelf: selfJids.has(this.canonicalJid(jid) ?? jid)
      });
    }
    return matches.sort((a, b) => b.messageCount - a.messageCount || a.jid.localeCompare(b.jid)).slice(0, Math.max(1, Math.min(25, limit)));
  }

  async reconcileBrainRuns(): Promise<number> {
    let reconciled = 0;
    for (const run of this.brainRuns.values()) {
      if (run.status === "running") {
        // Mirror of the SQLite semantics: a lock keyed by a dead run releases
        // with the reconcile, so kill-resume never waits out the TTL.
        if (this.brainLockRunId === run.id) {
          this.brainLockRunId = null;
        }
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

  async listBrainRuns(options?: { kind?: BrainRunKind; docId?: string; limit?: number }): Promise<BrainRunListItem[]> {
    // Mirror of the SQLite scope: a run touched this page if it wrote a
    // revision of it (refusals included) or raised an issue against it.
    const scoped = options?.docId
      ? new Set<string>([
          ...[...this.brainDocRevisions.values()].filter((revision) => revision.docId === options.docId && revision.runId).map((revision) => revision.runId!),
          ...this.brainIssues.filter((issue) => issue.docId === options.docId && issue.runId).map((issue) => issue.runId!)
        ])
      : null;
    const runs = structuredClone(
      [...this.brainRuns.values()]
        .filter((run) => (!options?.kind || run.kind === options.kind) && (!scoped || scoped.has(run.id)))
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
        .slice(0, options?.limit ?? 50)
    );
    return runs.map((run) => {
      const revisions = [...this.brainDocRevisions.values()].filter((revision) => revision.runId === run.id);
      const own = options?.docId ? revisions.find((revision) => revision.docId === options.docId) : undefined;
      const doc = own ? this.brainDocs.get(own.docId) : undefined;
      return {
        run,
        effects: {
          lifecycleChanges: this.lifecycleEvents.filter((event) => event.runId === run.id).length,
          pagesWritten: revisions.filter((revision) => revision.status !== "rejected").length,
          pagesRefused: revisions.filter((revision) => revision.status === "rejected").length,
          claimsSuperseded: revisions.reduce(
            (sum, revision) => sum + revision.drops.filter((drop) => drop.reason === "superseded").length,
            0
          ),
          episodesCommitted: [...this.brainEpisodes.values()].filter((episode) => episode.runId === run.id).length,
          issues: this.brainIssues.filter((issue) => issue.runId === run.id).length
        },
        docEffect: own
          ? {
              revision: own.revision,
              status: own.status,
              isCurrent: doc?.currentRevisionId === own.id,
              statementCount: own.sections.reduce((sum, section) => sum + section.statements.length, 0),
              errors: own.errors ? [...own.errors] : null
            }
          : null
      };
    });
  }

  // Mirror of the SQLite run audit: every durable change attributable to one
  // run, read back through the same run_id stamps.
  async getBrainRunEffects(runId: string): Promise<BrainRunEffects | null> {
    const run = await this.getBrainRun(runId);
    if (!run) {
      return null;
    }
    const runEvents = this.lifecycleEvents.filter((event) => event.runId === runId);
    const lifecycle: BrainRunEffectLifecycle[] = [];
    for (const event of runEvents) {
      const node = this.memLifecycleNodeForClaim(event.claimId);
      const found = this.memLifecycleClaim(event.claimId);
      const chatSourceId = node?.chatScope ?? null;
      lifecycle.push({
        eventId: event.id,
        claimId: event.claimId,
        itemText: found?.claim.text ?? node?.title ?? "(claim no longer exists)",
        itemExists: found != null,
        kind: node?.kind === "commitment" || node?.kind === "question" ? node.kind : null,
        toStatus: event.toStatus,
        source: event.source,
        model: event.model,
        note: event.note,
        atMs: event.createdAtMs,
        chatSourceId,
        chatDisplayName: chatSourceId ? this.chats.get(chatSourceId)?.displayName ?? null : null,
        cites: this.memLifecycleCiteViews(event),
        currentStatus: foldLifecycleEvents(this.memLifecycleEventsForClaim(event.claimId)).status
      });
    }
    lifecycle.sort((a, b) => a.eventId - b.eventId);
    const revisions: BrainRunEffectRevision[] = [];
    let supersessionCount = 0;
    for (const record of [...this.brainDocRevisions.values()].filter((revision) => revision.runId === runId).sort((a, b) => a.id - b.id)) {
      const referenced = new Set<string>();
      for (const section of record.sections) {
        for (const statement of section.statements) {
          for (const claimId of statement.claimIds) {
            referenced.add(claimId);
          }
        }
      }
      const supersededClaims = record.drops
        .filter((drop) => drop.reason === "superseded")
        .map((drop) => ({ claimId: drop.claimId, byClaimId: drop.byClaimId }));
      supersessionCount += supersededClaims.length;
      const doc = this.brainDocs.get(record.docId);
      const node = doc?.nodeId ? this.graphNodes.get(doc.nodeId) : undefined;
      revisions.push({
        docId: record.docId,
        title: node ? this.memDocNodeLabel(node) : doc?.slug ?? record.docId,
        revision: record.revision,
        status: record.status,
        statementCount: record.sections.reduce((sum, section) => sum + section.statements.length, 0),
        referencedClaimCount: referenced.size,
        supersededClaims,
        errors: record.errors ? [...record.errors] : null,
        isCurrent: doc?.currentRevisionId === record.id
      });
    }
    return {
      run,
      lifecycle,
      revisions,
      supersessionCount,
      episodesCommitted: [...this.brainEpisodes.values()].filter((episode) => episode.runId === runId).length,
      issues: await this.listBrainValidationIssues({ runId, limit: 200 }),
      asOfMs: Date.now()
    };
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
      selfIdentities: await this.getArchiveOwnerSelfIdentities(),
      limits: { maxCallsPerHour: config.brain.maxCallsPerHour, maxCallsPerDay: config.brain.maxCallsPerDay },
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

  async getBrainBackfillStats(): Promise<BrainBackfillDbStats> {
    const visible = [...this.messages.values()].filter((message) => isVisibleExchangeMessage(message));
    const pending = visible.filter((message) => this.isMessagePending(message, message.chatSourceId));
    const episodeTasks = [...this.brainTasks.values()].filter((task) => task.kind === "episode");
    const current = [...this.brainEpisodes.values()].filter((episode) => episode.status === "current");
    const hourAgoIso = new Date(Date.now() - 3600_000).toISOString();
    const today = new Date().toISOString().slice(0, 10);
    const spend = new Map<string, BrainBackfillModelSpend>();
    for (const entry of this.brainLedger) {
      const row = spend.get(entry.provider) ?? {
        provider: entry.provider,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        callsToday: 0,
        inputTokensToday: 0,
        outputTokensToday: 0
      };
      row.calls += 1;
      row.inputTokens += entry.inputTokens;
      row.outputTokens += entry.outputTokens;
      if (entry.day === today) {
        row.callsToday += 1;
        row.inputTokensToday += entry.inputTokens;
        row.outputTokensToday += entry.outputTokens;
      }
      spend.set(entry.provider, row);
    }
    const avgMessages =
      current.length > 0 ? Math.round((current.reduce((sum, episode) => sum + episode.messageCount, 0) / current.length) * 10) / 10 : null;
    return {
      totalVisibleMessages: visible.length,
      assimilatedVisibleMessages: visible.length - pending.length,
      pendingChats: new Set(pending.map((message) => message.chatSourceId)).size,
      queuedEpisodeTasks: episodeTasks.filter((task) => task.status === "pending").length,
      failedEpisodeTasks: episodeTasks.filter((task) => task.status === "failed").length,
      episodesLastHour: [...this.brainEpisodes.values()].filter((episode) => episode.createdAt >= hourAgoIso).length,
      currentEpisodes: current.length,
      avgEpisodeMessages: avgMessages,
      modelAttemptedEpisodes: current.filter((episode) => episode.generator === "model" || episode.attemptedModel != null).length,
      fallbackEpisodes: current.filter((episode) => episode.attemptedModel != null).length,
      sweepableExtractive: current.filter((episode) => episode.generator === "extractive").length,
      spendByModel: [...spend.values()].sort((a, b) => b.calls - a.calls)
    };
  }

  async resetBrainDerivedData(options?: { chatSourceId?: string | null }): Promise<{ episodeIds: string[]; watermarks: number }> {
    const chat = options?.chatSourceId ?? null;
    const episodeIds = [...this.brainEpisodes.values()]
      .filter((episode) => !chat || episode.chatSourceId === chat)
      .map((episode) => episode.id);
    // Graph first (it reads claims that are about to be deleted): full reset
    // wipes the derived-of-derived state outright; a scoped reset removes
    // exactly the affected episodes' contributions.
    if (!chat) {
      this.graphNodes.clear();
      this.graphNodeIdByKey.clear();
      this.graphSlugs.clear();
      this.graphEdges.clear();
      this.graphEdgesById.clear();
      this.graphNodeClaims.clear();
      this.graphAliases.clear();
    } else {
      for (const id of episodeIds) {
        this.memRemoveGraphContributionForEpisode(id);
      }
    }
    // Lifecycle transitions are derived state (model spend to re-derive): a
    // reset wipes them with their claims, mirroring the SQLite deletes.
    if (!chat) {
      this.lifecycleEvents = [];
    } else {
      const claimIds = new Set(
        episodeIds.flatMap((id) => this.brainEpisodes.get(id)?.claims.map((claim) => claim.id) ?? [])
      );
      this.lifecycleEvents = this.lifecycleEvents.filter((event) => !claimIds.has(event.claimId));
    }
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
    if (chat) {
      this.brainIssues = this.brainIssues.filter((issue) => issue.chatSourceId !== chat && !episodeIds.includes(issue.episodeId ?? ""));
    } else {
      // Full reset: issues and the topic vocabulary go too — a clean slate.
      this.brainIssues = [];
      this.brainTopics.clear();
      // Semantic docs are derived-of-derived (model spend to re-derive): a
      // FULL reset wipes them; a scoped reset leaves docs standing — their
      // dead refs make them due, honestly. Mirrors the SQLite deletes.
      this.brainDocs.clear();
      this.brainDocRevisions.clear();
      this.brainDocRevisionRefs.clear();
      this.claimSupersededBy.clear();
    }
    return { episodeIds, watermarks };
  }

  async commitBrainEpisode(episode: BrainEpisodeInput): Promise<BrainEpisodeRecord> {
    const id = crypto.randomUUID();
    // Case-insensitive topic convergence: reuse the first-seen canonical title.
    const topics: string[] = [];
    for (const title of episode.topics ?? []) {
      const clean = title.trim();
      if (!clean) {
        continue;
      }
      const key = clean.toLowerCase();
      if (!this.brainTopics.has(key)) {
        this.brainTopics.set(key, clean);
      }
      const canonical = this.brainTopics.get(key)!;
      if (!topics.includes(canonical)) {
        topics.push(canonical);
      }
    }
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
      runId: episode.runId ?? null,
      status: "current",
      fallbackReason: episode.fallbackReason ?? null,
      attemptedModel: episode.attemptedModel ?? null,
      extractionVersion: episode.extractionVersion,
      topics,
      unresolvedParticipants: episode.unresolvedParticipants ?? [],
      pushNameParticipants: episode.pushNameParticipants ?? [],
      uninterpretedMediaCount: episode.uninterpretedMediaCount ?? 0,
      quotedReplyAnchors: structuredClone(episode.quotedReplyAnchors ?? []),
      archiveSignalAnchors: structuredClone(episode.archiveSignalAnchors ?? []),
      mediaGaps: structuredClone(episode.mediaGaps ?? []),
      createdAt: new Date().toISOString(),
      claims: episode.claims.map((claim) => ({
        id: crypto.randomUUID(),
        kind: claim.kind,
        text: claim.text,
        eventAtMs: claim.eventAtMs ?? null,
        validUntilMs: claim.validUntilMs ?? null,
        confidence: claim.confidence ?? "stated",
        entities: (claim.entities ?? []).map((entity) => ({
          kind: entity.kind,
          name: entity.name,
          jid: entity.jid ? this.canonicalJid(entity.jid) ?? entity.jid : null,
          role: entity.role ?? null
        })),
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
    // Regeneration commits leave the watermark alone (the window is covered).
    if (episode.advanceWatermark !== false) {
      await this.advanceBrainWatermark(episode.chatSourceId, episode.endAtMs);
    }
    // Supersede-with-replacement mirrors the SQLite transaction semantics.
    let rekeyedLifecycleClaims: string[] = [];
    if (episode.supersedesEpisodeId) {
      const superseded = this.brainEpisodes.get(episode.supersedesEpisodeId);
      if (superseded) {
        superseded.status = "superseded";
      }
      // Lifecycle transitions follow the commitment across regeneration:
      // re-key onto the unique citation-sharing replacement, else orphan.
      rekeyedLifecycleClaims = this.memRekeyLifecycleEventsForSupersededEpisode(episode.supersedesEpisodeId);
      // Graph scope rule mirror: the superseded episode's contribution leaves
      // before the replacement's arrives.
      this.memRemoveGraphContributionForEpisode(episode.supersedesEpisodeId);
    }
    // Knowledge graph mirror of the SQLite commit transaction: model episodes
    // contribute nodes/edges/junctions; extractive placeholders contribute none.
    this.memApplyEpisodeGraph(record);
    for (const claimId of rekeyedLifecycleClaims) {
      this.memProjectLifecycleClaim(claimId);
    }
    return structuredClone(record);
  }

  async listRegenerableBrainEpisodes(options: {
    currentVersion: number;
    chatSourceId?: string | null;
    onlyExtractive?: boolean;
    limit: number;
  }): Promise<BrainEpisodeRecord[]> {
    return structuredClone(
      [...this.brainEpisodes.values()]
        .filter((episode) => episode.status === "current")
        .filter((episode) =>
          options.onlyExtractive
            ? episode.generator === "extractive"
            : episode.generator === "extractive" || episode.extractionVersion < options.currentVersion
        )
        .filter((episode) => !options.chatSourceId || episode.chatSourceId === options.chatSourceId)
        .sort((a, b) => b.endAtMs - a.endAtMs)
        .slice(0, options.limit)
    );
  }

  async markBrainEpisodeSuperseded(episodeId: string): Promise<void> {
    const episode = this.brainEpisodes.get(episodeId);
    if (episode) {
      episode.status = "superseded";
      // The replacement-less supersede mirrors SQLite: graph scope rule plus
      // lifecycle re-key/orphan apply here too.
      const rekeyed = this.memRekeyLifecycleEventsForSupersededEpisode(episodeId);
      this.memRemoveGraphContributionForEpisode(episodeId);
      for (const claimId of rekeyed) {
        this.memProjectLifecycleClaim(claimId);
      }
    }
  }

  async countRegenerableBrainEpisodes(currentVersion: number): Promise<number> {
    return [...this.brainEpisodes.values()].filter(
      (episode) => episode.status === "current" && (episode.generator === "extractive" || episode.extractionVersion < currentVersion)
    ).length;
  }

  // === Commitment lifecycle (mirror of the SQLite implementation) ==========
  // Durable events keyed by claim id, folded via the shared pure module; node
  // payload status and `resolves` edges are projections — parity by module.

  private memLifecycleEventsForClaim(claimId: string): BrainLifecycleEventRecord[] {
    return this.lifecycleEvents.filter((event) => event.claimId === claimId).sort((a, b) => a.id - b.id);
  }

  private memLifecycleNodeForClaim(claimId: string): MemGraphNode | undefined {
    const nodeId = this.graphNodeIdByKey.get(`commitment:${claimId}`) ?? this.graphNodeIdByKey.get(`question:${claimId}`);
    const node = nodeId ? this.graphNodes.get(nodeId) : undefined;
    return node && node.status !== "merged" ? node : undefined;
  }

  private memLifecycleClaim(claimId: string): { claim: BrainEpisodeRecord["claims"][number]; episode: BrainEpisodeRecord } | undefined {
    for (const episode of this.brainEpisodes.values()) {
      const claim = episode.claims.find((candidate) => candidate.id === claimId);
      if (claim) {
        return { claim, episode };
      }
    }
    return undefined;
  }

  private memLifecycleAnchor(claimId: string): { anchorMs: number | null; anchorKeys: string[] } {
    const found = this.memLifecycleClaim(claimId);
    if (!found) {
      return { anchorMs: null, anchorKeys: [] };
    }
    let anchorMs: number | null = null;
    for (const citation of found.claim.citations) {
      if (citation.timestampMs != null) {
        anchorMs = anchorMs == null ? citation.timestampMs : Math.max(anchorMs, citation.timestampMs);
      }
    }
    return { anchorMs, anchorKeys: found.claim.citations.map((citation) => citation.sourceMessageKey) };
  }

  private memLifecycleLabelForJid(jid: string): string {
    if (jid === "me") {
      return this.ownerDisplayName?.trim() || "the archive owner";
    }
    const canonical = this.canonicalJid(jid) ?? jid;
    const contact = this.contacts.get(canonical);
    return (
      resolveDisplayLabel({
        displayName: contact?.displayName ?? null,
        pushName: contact?.pushName ?? null,
        phoneNumber: contact?.phoneNumber ?? null,
        jid: canonical
      }) ?? canonical
    );
  }

  private memLifecycleCandidates(input: {
    claimId: string;
    chatSourceId: string;
    sinceMs: number;
    anchorKeys: string[];
  }): BrainLifecycleCandidate[] {
    const candidates: BrainLifecycleCandidate[] = [];
    if (input.anchorKeys.length === 0) {
      return candidates;
    }
    const anchorKeySet = new Set(input.anchorKeys);
    // (a) Reactions on the claim's cited messages.
    for (const update of this.liveUpdates.values()) {
      if (update.updateType !== "reaction" || !update.applied || !anchorKeySet.has(update.sourceMessageKey)) {
        continue;
      }
      const emoji = typeof update.metadata?.emoji === "string" ? update.metadata.emoji : "";
      if (!emoji || update.occurredAtMs == null || update.occurredAtMs <= input.sinceMs) {
        continue;
      }
      const reactorRaw = (update.metadata?.reactorJid as string | null | undefined) ?? null;
      const reactor = reactorRaw ? this.canonicalJid(reactorRaw) ?? reactorRaw : null;
      candidates.push({
        kind: "reaction",
        sourceMessageKey: update.sourceMessageKey,
        timestampMs: update.occurredAtMs,
        senderJid: reactor,
        senderLabel: reactor ? this.memLifecycleLabelForJid(reactor) : null,
        text: emoji,
        claimId: null
      });
    }
    // (b) Replies quoting a cited message (snapshot incl. cross-chat, or the
    // legacy same-chat pointer).
    const anchorMessages = [...this.messages.values()].filter((message) => anchorKeySet.has(message.sourceMessageKey));
    const seenReplies = new Set<string>();
    for (const anchor of anchorMessages) {
      for (const message of this.messages.values()) {
        if (message.timestampMs == null || message.timestampMs <= input.sinceMs || seenReplies.has(message.sourceMessageKey)) {
          continue;
        }
        const snapshotId = message.quotedSnapshot?.quotedSourceMessageId ?? null;
        const pointerId = message.quotedSourceMessageId ?? null;
        let matches = false;
        if (snapshotId === anchor.sourceMessageId) {
          const quotedChat = message.quotedSnapshot?.quotedSourceChatId
            ? this.canonicalJid(message.quotedSnapshot.quotedSourceChatId) ?? message.quotedSnapshot.quotedSourceChatId
            : message.chatSourceId;
          matches = quotedChat === anchor.chatSourceId;
        } else if (pointerId === anchor.sourceMessageId) {
          matches = message.chatSourceId === anchor.chatSourceId;
        }
        if (!matches) {
          continue;
        }
        seenReplies.add(message.sourceMessageKey);
        const sender = message.senderSourceJid ? this.canonicalJid(message.senderSourceJid) ?? message.senderSourceJid : null;
        const text = message.body?.trim() || message.caption?.trim() || `[${message.messageType} message]`;
        candidates.push({
          kind: "reply",
          sourceMessageKey: message.sourceMessageKey,
          timestampMs: message.timestampMs,
          senderJid: sender,
          senderLabel: sender ? this.memLifecycleLabelForJid(sender) : null,
          text,
          claimId: null
        });
      }
    }
    // (c) Later model claims in the same chat sharing an entity.
    const found = this.memLifecycleClaim(input.claimId);
    if (found) {
      const entityJids = new Set(found.claim.entities.filter((entity) => entity.jid).map((entity) => entity.jid!));
      const entityNames = new Set(
        found.claim.entities.filter((entity) => !entity.jid && entity.name.trim()).map((entity) => entity.name.trim().toLowerCase())
      );
      if (entityJids.size > 0 || entityNames.size > 0) {
        const claimRows: Array<{ claimId: string; text: string; ts: number; key: string; senderJid: string | null }> = [];
        for (const episode of this.brainEpisodes.values()) {
          if (episode.status !== "current" || episode.generator !== "model" || episode.chatSourceId !== input.chatSourceId) {
            continue;
          }
          for (const claim of episode.claims) {
            if (claim.id === input.claimId) {
              continue;
            }
            const overlap = claim.entities.some(
              (entity) =>
                (entity.jid && entityJids.has(entity.jid)) ||
                (!entity.jid && entityNames.has(entity.name.trim().toLowerCase()))
            );
            if (!overlap) {
              continue;
            }
            const dated = claim.citations.filter((citation) => citation.timestampMs != null);
            if (dated.length === 0) {
              continue;
            }
            const latest = dated.reduce((best, citation) => (citation.timestampMs! > best.timestampMs! ? citation : best));
            if (latest.timestampMs! <= input.sinceMs) {
              continue;
            }
            claimRows.push({
              claimId: claim.id,
              text: claim.text,
              ts: latest.timestampMs!,
              key: latest.sourceMessageKey,
              senderJid: latest.senderSourceJid ? this.canonicalJid(latest.senderSourceJid) ?? latest.senderSourceJid : null
            });
          }
        }
        claimRows.sort((a, b) => b.ts - a.ts);
        for (const row of claimRows.slice(0, 6)) {
          candidates.push({
            kind: "claim",
            sourceMessageKey: row.key,
            timestampMs: row.ts,
            senderJid: row.senderJid,
            senderLabel: row.senderJid ? this.memLifecycleLabelForJid(row.senderJid) : null,
            text: row.text,
            claimId: row.claimId
          });
        }
      }
    }
    const priority: Record<BrainLifecycleCandidate["kind"], number> = { reaction: 0, reply: 1, claim: 2 };
    candidates.sort((a, b) => priority[a.kind] - priority[b.kind] || (b.timestampMs ?? 0) - (a.timestampMs ?? 0));
    return candidates.slice(0, LIFECYCLE_MAX_CANDIDATES_PER_NODE);
  }

  private memRecomputeSalienceForNode(nodeId: string): void {
    const node = this.graphNodes.get(nodeId);
    if (!node || node.status === "merged") {
      return;
    }
    const claimById = new Map<string, BrainEpisodeRecord["claims"][number]>();
    for (const episode of this.brainEpisodes.values()) {
      for (const claim of episode.claims) {
        claimById.set(claim.id, claim);
      }
    }
    let citations = 0;
    const days = new Set<string>();
    let lastTs: number | null = null;
    const record = (ts: number | null) => {
      citations += 1;
      if (ts != null) {
        days.add(new Date(ts).toISOString().slice(0, 10));
        lastTs = lastTs == null ? ts : Math.max(lastTs, ts);
      }
    };
    for (const claimId of this.graphNodeClaims.get(nodeId) ?? []) {
      for (const citation of claimById.get(claimId)?.citations ?? []) {
        record(citation.timestampMs);
      }
    }
    for (const edge of this.graphEdges.values()) {
      if (edge.srcNodeId !== nodeId && edge.dstNodeId !== nodeId) {
        continue;
      }
      for (const evidence of edge.evidence.values()) {
        record(evidence.observedAtMs);
      }
    }
    const computed = computeGraphSalience({
      kind: node.kind,
      payload: node.payload,
      citations,
      evidenceDays: days.size,
      lastEvidenceAtMs: lastTs,
      nowMs: Date.now(),
      engagementFactor: node.engagementFactor,
      dormancyThreshold: graphDormancyThreshold()
    });
    node.salience = computed.salience;
    node.status = computed.dormant ? "dormant" : "active";
    node.citationCount = citations;
    node.evidenceDays = days.size;
    if (lastTs != null) {
      node.lastSeenAtMs = node.lastSeenAtMs == null ? lastTs : Math.max(node.lastSeenAtMs, lastTs);
    }
  }

  private memProjectLifecycleClaim(claimId: string, fold?: LifecycleFold): void {
    const node = this.memLifecycleNodeForClaim(claimId);
    if (!node) {
      return;
    }
    const resolved = fold ?? foldLifecycleEvents(this.memLifecycleEventsForClaim(claimId));
    node.payload = projectLifecyclePayload(node.payload, resolved);
    for (const [key, edge] of [...this.graphEdges]) {
      if (edge.dstNodeId === node.id && edge.kind === "resolves") {
        this.graphEdges.delete(key);
        this.graphEdgesById.delete(edge.id);
      }
    }
    const resolvingEvent = resolved.resolvingEvent;
    if (resolvingEvent && resolvingEvent.source === "model") {
      for (const cite of resolvingEvent.cites) {
        if (!cite.actorJid) {
          continue;
        }
        const canonical = this.canonicalJid(cite.actorJid) ?? cite.actorJid;
        const actorNodeId = this.memEnsureGraphNode({
          naturalKey: personJidNaturalKey(canonical),
          kind: "person",
          title: null,
          jid: canonical,
          chatScope: null,
          payload: null,
          slugSeed: canonical.split("@")[0] ?? canonical,
          seenAtMs: cite.timestampMs
        });
        if (actorNodeId !== node.id) {
          this.memAddGraphEdgeEvidence(actorNodeId, node.id, "resolves", {
            key: `msg:${cite.sourceMessageKey}`,
            sourceMessageKey: cite.sourceMessageKey,
            observedAtMs: cite.timestampMs
          });
        }
      }
    }
    this.memRecomputeSalienceForNode(node.id);
  }

  private memProjectLifecycleState(): number {
    const claimIds = [...new Set(this.lifecycleEvents.filter((event) => event.orphanedAtMs == null).map((event) => event.claimId))];
    for (const claimId of claimIds) {
      this.memProjectLifecycleClaim(claimId);
    }
    return claimIds.length;
  }

  private memRekeyLifecycleEventsForSupersededEpisode(oldEpisodeId: string): string[] {
    const rekeyed: string[] = [];
    const oldEpisode = this.brainEpisodes.get(oldEpisodeId);
    if (!oldEpisode) {
      return rekeyed;
    }
    for (const oldClaim of oldEpisode.claims) {
      if (oldClaim.kind !== "commitment" && oldClaim.kind !== "question") {
        continue;
      }
      const events = this.lifecycleEvents.filter((event) => event.claimId === oldClaim.id);
      if (events.length === 0) {
        continue;
      }
      const oldKeys = new Set(oldClaim.citations.map((citation) => citation.sourceMessageKey));
      const matches: string[] = [];
      for (const episode of this.brainEpisodes.values()) {
        if (episode.status !== "current" || episode.generator !== "model") {
          continue;
        }
        for (const claim of episode.claims) {
          if (claim.kind !== oldClaim.kind || claim.id === oldClaim.id) {
            continue;
          }
          if (claim.citations.some((citation) => oldKeys.has(citation.sourceMessageKey))) {
            matches.push(claim.id);
          }
        }
      }
      const unique = [...new Set(matches)];
      if (unique.length === 1) {
        for (const event of events) {
          event.claimId = unique[0]!;
        }
        rekeyed.push(unique[0]!);
      } else {
        const now = Date.now();
        for (const event of events) {
          if (event.orphanedAtMs == null) {
            event.orphanedAtMs = now;
          }
        }
      }
    }
    return rekeyed;
  }

  // The sync core of the ONE lifecycle writer (mirror of the SQLite Tx core):
  // semantic-rollups' revision commit applies resolutions through this exact
  // path so the two write callers can never diverge.
  private memApplyLifecycleTransitionsCore(
    transitions: BrainLifecycleTransitionInput[],
    context: {
      source: BrainLifecycleSource;
      runId?: string | null;
      model?: string | null;
      allowedCitesByClaim?: Map<string, BrainLifecycleCandidate[]>;
    }
  ): BrainLifecycleEventRecord[] {
    const errors: string[] = [];
    const prepared: Array<{
      input: BrainLifecycleTransitionInput;
      cites: BrainLifecycleEventRecord["cites"];
    }> = [];
    for (const input of transitions) {
      const node = this.memLifecycleNodeForClaim(input.claimId);
      if (!node) {
        errors.push(`claim ${input.claimId} has no open commitment/question node`);
        continue;
      }
      const fold = foldLifecycleEvents(this.memLifecycleEventsForClaim(input.claimId));
      const { anchorMs } = this.memLifecycleAnchor(input.claimId);
      const allowed = context.allowedCitesByClaim?.get(input.claimId) ?? null;
      const allowedByKey = allowed ? new Map(allowed.map((candidate) => [candidate.sourceMessageKey, candidate])) : null;
      const cites: BrainLifecycleEventRecord["cites"] = [];
      for (const key of input.cites ?? []) {
        const candidate = allowedByKey?.get(key);
        if (candidate) {
          cites.push({
            sourceMessageKey: key,
            timestampMs: candidate.timestampMs,
            resolvingClaimId: candidate.claimId,
            actorJid: candidate.senderJid
          });
        } else {
          const message = [...this.messages.values()].find((entry) => entry.sourceMessageKey === key);
          cites.push({
            sourceMessageKey: key,
            timestampMs: message?.timestampMs ?? null,
            resolvingClaimId: null,
            actorJid: message?.senderSourceJid ?? null
          });
        }
      }
      const violations = validateLifecycleTransition({
        toStatus: input.toStatus,
        source: context.source,
        currentStatus: fold.status,
        cites,
        anchorMs,
        allowedKeys: context.source === "model" ? new Set(allowedByKey?.keys() ?? []) : null
      });
      for (const violation of violations) {
        errors.push(`claim ${input.claimId}: ${violation}`);
      }
      prepared.push({ input, cites });
    }
    if (errors.length > 0) {
      throw new PublicError("BRAIN_LIFECYCLE_INVALID", `Lifecycle transition rejected: ${errors.join("; ")}`);
    }
    const now = Date.now();
    const created: BrainLifecycleEventRecord[] = [];
    for (const entry of prepared) {
      const citeTimestamps = entry.cites.map((cite) => cite.timestampMs).filter((ts): ts is number => ts != null);
      const event: BrainLifecycleEventRecord = {
        id: this.lifecycleEventSeq++,
        claimId: entry.input.claimId,
        toStatus: entry.input.toStatus,
        source: context.source,
        evidenceAtMs: citeTimestamps.length > 0 ? Math.max(...citeTimestamps) : null,
        note: entry.input.note?.trim() || null,
        runId: context.runId ?? null,
        model: context.model ?? null,
        orphanedAtMs: null,
        createdAtMs: now,
        cites: entry.cites
      };
      this.lifecycleEvents.push(event);
      created.push(event);
    }
    for (const entry of prepared) {
      this.memProjectLifecycleClaim(entry.input.claimId);
    }
    return created;
  }

  async applyBrainLifecycleTransitions(
    transitions: BrainLifecycleTransitionInput[],
    context: {
      source: BrainLifecycleSource;
      runId?: string | null;
      model?: string | null;
      allowedCitesByClaim?: Map<string, BrainLifecycleCandidate[]>;
    }
  ): Promise<BrainLifecycleApplyResult> {
    if (transitions.length === 0) {
      return { applied: 0, events: [] };
    }
    const created = this.memApplyLifecycleTransitionsCore(transitions, context);
    return { applied: created.length, events: structuredClone(created) };
  }

  private memLifecycleCiteViews(event: BrainLifecycleEventRecord): BrainLifecycleCiteView[] {
    return event.cites.map((cite) => {
      const message = [...this.messages.values()].find((entry) => entry.sourceMessageKey === cite.sourceMessageKey);
      const chat = message ? this.chats.get(message.chatSourceId) : undefined;
      const text = message?.body?.trim() || message?.caption?.trim() || null;
      return {
        sourceMessageKey: cite.sourceMessageKey,
        chatId: chat?.id ?? null,
        messageId: message?.id ?? null,
        timestampMs: cite.timestampMs ?? message?.timestampMs ?? null,
        senderLabel: cite.actorJid ? this.memLifecycleLabelForJid(cite.actorJid) : null,
        snippet: text ? (text.length > 160 ? `${text.slice(0, 159)}…` : text) : null
      };
    });
  }

  async getBrainLifecycleItemDetail(claimId: string): Promise<BrainLifecycleItemDetail | null> {
    const node = this.memLifecycleNodeForClaim(claimId);
    if (!node) {
      return null;
    }
    const events = this.memLifecycleEventsForClaim(claimId);
    const fold = foldLifecycleEvents(events);
    const { anchorMs, anchorKeys } = this.memLifecycleAnchor(claimId);
    const dueMs = typeof node.payload?.dueMs === "number" ? (node.payload.dueMs as number) : null;
    const flags = computeLifecycleFlags({
      status: fold.status,
      dueMs,
      lastEvidenceAtMs: node.lastSeenAtMs,
      lastReviewedAtMs: fold.lastReviewedAtMs,
      openedAtMs: anchorMs,
      asOfMs: Date.now(),
      staleDays: lifecycleStaleDays()
    });
    const candidates = this.memLifecycleCandidates({ claimId, chatSourceId: node.chatScope ?? "", sinceMs: anchorMs ?? 0, anchorKeys });
    const holderJid = typeof node.payload?.holderJid === "string" ? (node.payload.holderJid as string) : null;
    const found = this.memLifecycleClaim(claimId);
    const item: BrainLifecycleItem = {
      nodeId: node.id,
      slug: node.slug,
      kind: node.kind as "commitment" | "question",
      claimId,
      text: found?.claim.text ?? node.title ?? "",
      chatSourceId: node.chatScope ?? "",
      chatDisplayName: node.chatScope ? this.chats.get(node.chatScope)?.displayName ?? null : null,
      holderJid,
      holderLabel: holderJid ? this.memLifecycleLabelForJid(holderJid) : null,
      openedAtMs: anchorMs,
      dueMs,
      lastEvidenceAtMs: node.lastSeenAtMs,
      lastReviewedAtMs: fold.lastReviewedAtMs,
      status: fold.status,
      overdue: flags.overdue,
      stale: flags.stale,
      candidateCount: candidates.length,
      salience: node.salience,
      dormant: node.status === "dormant",
      resolution: fold.resolvingEvent
        ? {
            status: fold.resolvingEvent.toStatus,
            source: fold.resolvingEvent.source,
            atMs: fold.resolvedAtMs ?? fold.resolvingEvent.createdAtMs,
            note: fold.resolvingEvent.note,
            model: fold.resolvingEvent.model,
            cites: this.memLifecycleCiteViews(fold.resolvingEvent)
          }
        : null
    };
    const origin: BrainLifecycleCiteView[] = (found?.claim.citations ?? []).map((cite) => {
      const message = [...this.messages.values()].find((entry) => entry.sourceMessageKey === cite.sourceMessageKey);
      const chat = message ? this.chats.get(message.chatSourceId) : undefined;
      const text = message?.body?.trim() || message?.caption?.trim() || null;
      return {
        sourceMessageKey: cite.sourceMessageKey,
        chatId: chat?.id ?? null,
        messageId: message?.id ?? null,
        timestampMs: cite.timestampMs ?? message?.timestampMs ?? null,
        senderLabel: cite.senderSourceJid ? this.memLifecycleLabelForJid(cite.senderSourceJid) : null,
        snippet: text ? (text.length > 200 ? `${text.slice(0, 199)}…` : text) : null
      };
    });
    const detailCandidates: BrainLifecycleDetailCandidate[] = candidates.map((candidate) => {
      const message = this.messages.get(candidate.sourceMessageKey);
      const chat = message ? this.chats.get(message.chatSourceId) : undefined;
      return { ...candidate, chatId: chat?.id ?? null, messageId: message?.id ?? null };
    });
    return { item, origin, candidates: detailCandidates, events: structuredClone(events) };
  }

  async listBrainLifecycleItems(
    options: {
      status?: BrainLifecycleStatus | "all" | "closed";
      flag?: "overdue" | "stale" | "sweep_due";
      hideOverdue?: boolean;
      hideStale?: boolean;
      hideFulfilled?: boolean;
      hideDismissed?: boolean;
      dueUpcoming?: boolean;
      kind?: "commitment" | "question";
      chatSourceId?: string | null;
      includeChats?: string[];
      excludeChats?: string[];
      sort?: BrainLifecycleSort;
      limit?: number;
    } = {}
  ): Promise<BrainLifecycleListResponse> {
    const asOfMs = Date.now();
    const staleDays = lifecycleStaleDays();
    const statusFilter = options.flag ? "open" : options.status ?? "open";
    const limit = Math.max(1, Math.min(500, options.limit ?? 200));
    const chatFilter = options.chatSourceId ? this.canonicalJid(options.chatSourceId) ?? options.chatSourceId : null;
    const includeChats =
      options.includeChats && options.includeChats.length > 0
        ? new Set(options.includeChats.map((chat) => this.canonicalJid(chat) ?? chat))
        : null;
    const excludeChats =
      options.excludeChats && options.excludeChats.length > 0
        ? new Set(options.excludeChats.map((chat) => this.canonicalJid(chat) ?? chat))
        : null;
    const counts = { open: 0, overdue: 0, stale: 0, fulfilled: 0, dismissed: 0, sweepDue: 0, orphanedEvents: 0 };
    const facetCount = new Map<string, number>();
    const facetLabel = new Map<string, string | null>();
    const items: BrainLifecycleItem[] = [];
    for (const node of this.graphNodes.values()) {
      if ((node.kind !== "commitment" && node.kind !== "question") || node.status === "merged") {
        continue;
      }
      if (options.kind && node.kind !== options.kind) {
        continue;
      }
      if (chatFilter && node.chatScope !== chatFilter) {
        continue;
      }
      const claimId = node.naturalKey.slice(node.naturalKey.indexOf(":") + 1);
      const fold = foldLifecycleEvents(this.memLifecycleEventsForClaim(claimId));
      const { anchorMs, anchorKeys } = this.memLifecycleAnchor(claimId);
      const dueMs = typeof node.payload?.dueMs === "number" ? (node.payload.dueMs as number) : null;
      const flags = computeLifecycleFlags({
        status: fold.status,
        dueMs,
        lastEvidenceAtMs: node.lastSeenAtMs,
        lastReviewedAtMs: fold.lastReviewedAtMs,
        openedAtMs: anchorMs,
        asOfMs,
        staleDays
      });
      let candidateCount = 0;
      let sweepDue = false;
      if (fold.status === "open") {
        counts.open += 1;
        if (flags.overdue) counts.overdue += 1;
        if (flags.stale) counts.stale += 1;
        const sinceMs = Math.max(anchorMs ?? 0, fold.lastReviewedAtMs ?? 0);
        candidateCount = this.memLifecycleCandidates({ claimId, chatSourceId: node.chatScope ?? "", sinceMs, anchorKeys }).length;
        const duePassedSinceReview = dueMs != null && dueMs < asOfMs && (fold.lastReviewedAtMs == null || fold.lastReviewedAtMs < dueMs);
        sweepDue = candidateCount > 0 || duePassedSinceReview;
        if (sweepDue) {
          counts.sweepDue += 1;
        }
      } else if (fold.status === "fulfilled") {
        counts.fulfilled += 1;
      } else {
        counts.dismissed += 1;
      }
      if (statusFilter === "closed" ? fold.status === "open" : statusFilter !== "all" && fold.status !== statusFilter) {
        continue;
      }
      const chatKey = node.chatScope ?? "";
      facetCount.set(chatKey, (facetCount.get(chatKey) ?? 0) + 1);
      if (!facetLabel.has(chatKey)) {
        facetLabel.set(chatKey, (node.chatScope ? this.chats.get(node.chatScope)?.displayName ?? null : null));
      }
      if (options.flag === "overdue" && !flags.overdue) continue;
      if (options.flag === "stale" && !flags.stale) continue;
      if (options.flag === "sweep_due" && !sweepDue) continue;
      if (options.hideOverdue && flags.overdue) continue;
      if (options.hideStale && flags.stale) continue;
      if (options.hideFulfilled && fold.status === "fulfilled") continue;
      if (options.hideDismissed && fold.status === "dismissed") continue;
      if (options.dueUpcoming && (fold.status !== "open" || dueMs == null || dueMs < asOfMs)) continue;
      if (includeChats && !includeChats.has(chatKey)) continue;
      if (excludeChats && excludeChats.has(chatKey)) continue;
      const holderJid = typeof node.payload?.holderJid === "string" ? (node.payload.holderJid as string) : null;
      const found = this.memLifecycleClaim(claimId);
      let resolution: BrainLifecycleResolutionView | null = null;
      if (fold.resolvingEvent) {
        resolution = {
          status: fold.resolvingEvent.toStatus,
          source: fold.resolvingEvent.source,
          atMs: fold.resolvedAtMs ?? fold.resolvingEvent.createdAtMs,
          note: fold.resolvingEvent.note,
          model: fold.resolvingEvent.model,
          cites: this.memLifecycleCiteViews(fold.resolvingEvent)
        };
      }
      items.push({
        nodeId: node.id,
        slug: node.slug,
        kind: node.kind as "commitment" | "question",
        claimId,
        text: found?.claim.text ?? node.title ?? "",
        chatSourceId: node.chatScope ?? "",
        chatDisplayName: node.chatScope ? this.chats.get(node.chatScope)?.displayName ?? null : null,
        holderJid,
        holderLabel: holderJid ? this.memLifecycleLabelForJid(holderJid) : null,
        openedAtMs: anchorMs,
        dueMs,
        lastEvidenceAtMs: node.lastSeenAtMs,
        lastReviewedAtMs: fold.lastReviewedAtMs,
        status: fold.status,
        overdue: flags.overdue,
        stale: flags.stale,
        candidateCount,
        salience: node.salience,
        dormant: node.status === "dormant",
        resolution
      });
    }
    counts.orphanedEvents = new Set(this.lifecycleEvents.filter((event) => event.orphanedAtMs != null).map((event) => event.claimId)).size;
    sortLifecycleItems(items, options.sort ?? "smart", statusFilter);
    const chatFacets = [...facetCount.entries()]
      .map(([chatSourceId, count]) => ({ chatSourceId, chatDisplayName: facetLabel.get(chatSourceId) ?? null, count }))
      .sort((a, b) => b.count - a.count || (a.chatDisplayName ?? a.chatSourceId).localeCompare(b.chatDisplayName ?? b.chatSourceId))
      .slice(0, 300);
    return { items: items.slice(0, limit), counts, chatFacets, asOfMs, staleDays };
  }

  async listBrainLifecycleSweepBatches(
    options: { chatSourceId?: string | null; claimIds?: string[]; maxNodesPerBatch?: number } = {}
  ): Promise<BrainLifecycleSweepBatch[]> {
    const asOfMs = Date.now();
    const maxNodes = Math.max(1, Math.min(LIFECYCLE_SWEEP_MAX_NODES_PER_CALL, options.maxNodesPerBatch ?? LIFECYCLE_SWEEP_MAX_NODES_PER_CALL));
    const chatFilter = options.chatSourceId ? this.canonicalJid(options.chatSourceId) ?? options.chatSourceId : null;
    const selected = options.claimIds && options.claimIds.length > 0 ? new Set(options.claimIds) : null;
    const dueByChat = new Map<
      string,
      { chatDisplayName: string | null; nodes: Array<BrainLifecycleSweepNode & { overdue: boolean; lastEvidenceAtMs: number | null }> }
    >();
    for (const node of this.graphNodes.values()) {
      if ((node.kind !== "commitment" && node.kind !== "question") || node.status === "merged" || !node.chatScope) {
        continue;
      }
      if (chatFilter && node.chatScope !== chatFilter) {
        continue;
      }
      const claimId = node.naturalKey.slice(node.naturalKey.indexOf(":") + 1);
      const fold = foldLifecycleEvents(this.memLifecycleEventsForClaim(claimId));
      if (fold.status !== "open") {
        continue;
      }
      if (selected && !selected.has(claimId)) {
        continue;
      }
      const dueMs = typeof node.payload?.dueMs === "number" ? (node.payload.dueMs as number) : null;
      const { anchorMs, anchorKeys } = this.memLifecycleAnchor(claimId);
      const sinceMs = Math.max(anchorMs ?? 0, fold.lastReviewedAtMs ?? 0);
      const candidates = this.memLifecycleCandidates({ claimId, chatSourceId: node.chatScope, sinceMs, anchorKeys });
      const duePassedSinceReview = dueMs != null && dueMs < asOfMs && (fold.lastReviewedAtMs == null || fold.lastReviewedAtMs < dueMs);
      // Explicit selection overrides the sweep-due skip.
      if (!selected && candidates.length === 0 && !duePassedSinceReview) {
        continue;
      }
      const holderJid = typeof node.payload?.holderJid === "string" ? (node.payload.holderJid as string) : null;
      const found = this.memLifecycleClaim(claimId);
      const bucket = dueByChat.get(node.chatScope) ?? {
        chatDisplayName: this.chats.get(node.chatScope)?.displayName ?? null,
        nodes: []
      };
      bucket.nodes.push({
        nodeId: node.id,
        claimId,
        kind: node.kind as "commitment" | "question",
        text: found?.claim.text ?? node.title ?? "",
        holderLabel: holderJid ? this.memLifecycleLabelForJid(holderJid) : null,
        openedAtMs: anchorMs,
        dueMs,
        candidates,
        overdue: dueMs != null && dueMs < asOfMs,
        lastEvidenceAtMs: node.lastSeenAtMs
      });
      dueByChat.set(node.chatScope, bucket);
    }
    const batches: BrainLifecycleSweepBatch[] = [];
    for (const [chatSourceId, bucket] of [...dueByChat.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      bucket.nodes.sort(compareLifecycleItems);
      for (let start = 0; start < bucket.nodes.length; start += maxNodes) {
        batches.push({
          chatSourceId,
          chatDisplayName: bucket.chatDisplayName,
          nodes: bucket.nodes.slice(start, start + maxNodes).map(({ overdue: _overdue, lastEvidenceAtMs: _last, ...node }) => node)
        });
      }
    }
    return batches;
  }

  // === Semantic consolidation (mirror of the SQLite implementation) ========
  // Same contract semantics via the shared pure module (brain/rollups.ts);
  // only the data access differs. Doc-comment parity with sqliteRepository.

  private memDocKindForNode(node: MemGraphNode): BrainDocKind | null {
    if (node.kind === "person" || node.kind === "org" || node.kind === "place" || node.kind === "project" || node.kind === "other") {
      return "entity";
    }
    if (node.kind === "topic") {
      return "topic";
    }
    if (node.kind === "chat") {
      return "chat";
    }
    return null;
  }

  private memResolveDocTargetNode(target: { docId?: string | null; nodeId?: string | null }): { node: MemGraphNode; redirected: boolean } | null {
    let node: MemGraphNode | undefined;
    if (target.nodeId) {
      node = this.graphNodes.get(target.nodeId);
    } else if (target.docId) {
      const separator = target.docId.indexOf(":");
      const slug = separator >= 0 ? target.docId.slice(separator + 1) : target.docId;
      node = [...this.graphNodes.values()].find((candidate) => candidate.slug === slug);
    }
    let redirected = false;
    for (let hop = 0; node && node.status === "merged" && node.mergedInto && hop < 5; hop += 1) {
      node = this.graphNodes.get(node.mergedInto);
      redirected = true;
    }
    if (!node || !this.memDocKindForNode(node)) {
      return null;
    }
    return { node, redirected };
  }

  private memDocNodeLabel(node: MemGraphNode): string {
    if (node.kind === "person" && node.jid) {
      return this.memLifecycleLabelForJid(node.jid);
    }
    if (node.kind === "chat" && node.chatScope) {
      return this.chats.get(node.chatScope)?.displayName?.trim() || node.chatScope;
    }
    return node.title?.trim() || node.slug;
  }

  private memDocScopeNodeIds(node: MemGraphNode): string[] {
    if (node.kind !== "person" || !node.jid) {
      return [node.id];
    }
    const membership = this.personMembers.get(this.canonicalJid(node.jid) ?? node.jid);
    if (!membership) {
      return [node.id];
    }
    const ids = new Set<string>([node.id]);
    for (const [jid, member] of this.personMembers) {
      if (member.personId !== membership.personId) {
        continue;
      }
      const canonical = this.canonicalJid(jid) ?? jid;
      const memberNodeId = this.graphNodeIdByKey.get(personJidNaturalKey(canonical));
      const memberNode = memberNodeId ? this.graphNodes.get(memberNodeId) : undefined;
      if (memberNode && memberNode.status !== "merged") {
        ids.add(memberNode.id);
      }
    }
    return [...ids];
  }

  private memDocScopeClaimIds(kind: BrainDocKind, node: MemGraphNode): string[] {
    if (kind === "entity") {
      const ids = new Set<string>();
      for (const nodeId of this.memDocScopeNodeIds(node)) {
        for (const claimId of this.graphNodeClaims.get(nodeId) ?? []) {
          ids.add(claimId);
        }
      }
      return [...ids];
    }
    if (kind === "topic") {
      const ids = new Set<string>();
      for (const edge of this.graphEdges.values()) {
        if (edge.kind !== "about" || (edge.dstNodeId !== node.id && edge.srcNodeId !== node.id)) {
          continue;
        }
        for (const evidence of edge.evidence.values()) {
          if (evidence.claimId) {
            ids.add(evidence.claimId);
          }
        }
      }
      return [...ids];
    }
    const chatSourceId = node.chatScope ?? (node.naturalKey.startsWith("chat:") ? node.naturalKey.slice(5) : null);
    if (!chatSourceId) {
      return [];
    }
    const ids: string[] = [];
    for (const episode of this.brainEpisodes.values()) {
      if (episode.chatSourceId !== chatSourceId) {
        continue;
      }
      for (const claim of episode.claims) {
        ids.push(claim.id);
      }
    }
    return ids;
  }

  private memHydrateRollupClaims(claimIds: string[]): BrainRollupInputClaim[] {
    const wanted = new Set(claimIds);
    const claims: BrainRollupInputClaim[] = [];
    for (const episode of this.brainEpisodes.values()) {
      if (episode.status !== "current" || episode.generator !== "model") {
        continue;
      }
      for (const claim of episode.claims) {
        if (!wanted.has(claim.id) || this.claimSupersededBy.has(claim.id)) {
          continue;
        }
        let lifecycleStatus: BrainLifecycleStatus | null = null;
        let lifecycleDueMs: number | null = null;
        if (claim.kind === "commitment" || claim.kind === "question") {
          lifecycleStatus = foldLifecycleEvents(this.memLifecycleEventsForClaim(claim.id)).status;
          lifecycleDueMs = claim.validUntilMs ?? claim.eventAtMs;
        }
        claims.push({
          claimId: claim.id,
          kind: claim.kind,
          text: claim.text,
          confidence: claim.confidence,
          eventAtMs: claim.eventAtMs,
          validUntilMs: claim.validUntilMs,
          episodeId: episode.id,
          episodeStartAtMs: episode.startAtMs,
          episodeEndAtMs: episode.endAtMs,
          chatSourceId: episode.chatSourceId,
          chatDisplayName: this.chats.get(episode.chatSourceId)?.displayName ?? null,
          citations: claim.citations.map((citation) => ({
            sourceMessageKey: citation.sourceMessageKey,
            timestampMs: citation.timestampMs ?? null,
            senderJid: citation.senderSourceJid ?? null
          })),
          lifecycleStatus,
          lifecycleDueMs
        });
      }
    }
    return claims;
  }

  private memConflictFacts(claims: BrainRollupInputClaim[]): ConflictClaimFacts[] {
    return claims.map((claim) => {
      const found = this.memLifecycleClaim(claim.claimId);
      const keys: string[] = [];
      for (const entity of found?.claim.entities ?? []) {
        const key = entity.jid ?? normalizeGraphName(entity.name);
        if (!keys.includes(key)) {
          keys.push(key);
        }
      }
      return {
        claimId: claim.claimId,
        kind: claim.kind,
        episodeId: claim.episodeId,
        episodeEndAtMs: claim.episodeEndAtMs,
        entityKeys: keys,
        supersededBy: null
      };
    });
  }

  private memCurrentRevisionRefs(doc: BrainDocRecord | undefined): { revisionId: number; revision: number; referencedClaimIds: string[] } | null {
    if (!doc?.currentRevisionId) {
      return null;
    }
    const revision = this.brainDocRevisions.get(doc.currentRevisionId);
    if (!revision) {
      return null;
    }
    return {
      revisionId: revision.id,
      revision: revision.revision,
      referencedClaimIds: [...(this.brainDocRevisionRefs.get(revision.id) ?? [])]
    };
  }

  async getBrainRollupInput(target: { docId?: string | null; nodeId?: string | null }): Promise<BrainRollupInput | null> {
    const resolved = this.memResolveDocTargetNode(target);
    if (!resolved) {
      return null;
    }
    const { node } = resolved;
    const kind = this.memDocKindForNode(node)!;
    const docId = docIdFor(kind, node.slug);
    const claims = this.memHydrateRollupClaims(this.memDocScopeClaimIds(kind, node));
    return {
      docId,
      kind,
      nodeId: node.id,
      slug: node.slug,
      title: this.memDocNodeLabel(node),
      prior: this.memCurrentRevisionRefs(this.brainDocs.get(docId)),
      claims,
      conflictPairs: detectConflictPairs(this.memConflictFacts(claims)),
      stats: { eligibleClaims: claims.length, fedClaims: 0, tokenEstimate: 0, overflow: false, tiersEngaged: [] }
    };
  }

  async commitBrainDocRevision(input: BrainRollupRevisionInput): Promise<BrainDocCommitResult> {
    const now = Date.now();
    let doc = this.brainDocs.get(input.docId);
    if (!doc) {
      doc = {
        docId: input.docId,
        kind: input.kind,
        nodeId: input.nodeId,
        slug: input.slug,
        status: "active",
        mergedInto: null,
        currentRevisionId: null,
        lastRollupAtMs: null,
        createdAtMs: now
      };
      this.brainDocs.set(input.docId, doc);
    }
    const prior = this.memCurrentRevisionRefs(doc);
    const newReferenced = new Set<string>();
    for (const section of input.sections) {
      for (const statement of section.statements) {
        for (const claimId of statement.claimIds) {
          newReferenced.add(claimId);
        }
      }
    }
    const fedSet = new Set(input.fedClaimIds);
    for (const claimId of newReferenced) {
      if (!fedSet.has(claimId)) {
        throw new PublicError("BRAIN_ROLLUP_INVALID", `Revision references claim ${claimId} that was not fed to the call.`);
      }
    }
    const currentClaimIds = new Set<string>();
    for (const claimId of prior?.referencedClaimIds ?? []) {
      const found = this.memLifecycleClaim(claimId);
      if (found && found.episode.status === "current") {
        currentClaimIds.add(claimId);
      }
    }
    const guard = runRollupGuard({
      priorReferencedClaimIds: prior?.referencedClaimIds ?? [],
      newReferencedClaimIds: [...newReferenced],
      currentClaimIds,
      declaredDrops: input.drops,
      fedClaimIds: fedSet
    });
    if (guard.errors.length > 0) {
      throw new PublicError("BRAIN_ROLLUP_GUARD", `Regression guard refused the revision: ${guard.errors.join("; ")}`);
    }
    const eventIds =
      input.resolutions.length > 0
        ? this.memApplyLifecycleTransitionsCore(input.resolutions, {
            source: "model",
            runId: input.runId,
            model: input.model,
            allowedCitesByClaim: input.allowedCitesByClaim
          }).map((event) => event.id)
        : [];
    // Number PAST every retained revision — rejected attempts occupy numbers
    // too (mirror of the SQLite fix; UNIQUE(doc_id, revision) semantics).
    const maxRevision = Math.max(
      0,
      ...[...this.brainDocRevisions.values()].filter((revision) => revision.docId === input.docId).map((revision) => revision.revision)
    );
    const revisionNumber = Math.max(maxRevision, prior?.revision ?? 0) + 1;
    const record: BrainDocRevisionRecord = {
      id: this.brainDocRevisionSeq++,
      docId: input.docId,
      revision: revisionNumber,
      status: "current",
      sections: structuredClone(input.sections),
      drops: structuredClone(guard.effectiveDrops),
      fedClaimIds: [...input.fedClaimIds],
      inputStats: { ...input.inputStats },
      resolutionEventIds: eventIds,
      errors: null,
      model: input.model,
      effort: input.effort,
      runId: input.runId,
      promptVersion: input.promptVersion,
      createdAtMs: now
    };
    this.brainDocRevisions.set(record.id, record);
    this.brainDocRevisionRefs.set(record.id, new Set(newReferenced));
    if (prior) {
      const priorRecord = this.brainDocRevisions.get(prior.revisionId);
      if (priorRecord) {
        priorRecord.status = "superseded";
      }
    }
    for (const drop of guard.effectiveDrops) {
      if (drop.reason === "superseded" && drop.byClaimId) {
        this.claimSupersededBy.set(drop.claimId, drop.byClaimId);
      }
    }
    doc.currentRevisionId = record.id;
    doc.lastRollupAtMs = now;
    doc.status = "active";
    doc.mergedInto = null;
    const referencedClaims = this.memHydrateRollupClaims([...newReferenced]);
    const contradictions = detectConflictPairs(this.memConflictFacts(referencedClaims)).filter(
      (pair) => newReferenced.has(pair.claimIdA) && newReferenced.has(pair.claimIdB)
    );
    for (const pair of contradictions) {
      await this.recordBrainValidationIssues([
        {
          runId: input.runId,
          docId: input.docId,
          code: "rollup_contradiction",
          severity: "warning",
          detail: `Revision ${revisionNumber} keeps likely-conflicting ${pair.claimKind} claims ${pair.claimIdA} and ${pair.claimIdB} (via ${pair.via}) with neither superseding the other.`
        }
      ]);
    }
    if ((prior?.referencedClaimIds.length ?? 0) > 0 && guard.staleShare > rollupStaleDropShare()) {
      await this.recordBrainValidationIssues([
        {
          runId: input.runId,
          docId: input.docId,
          code: "rollup_stale_shed",
          severity: "info",
          detail: `Revision ${revisionNumber} dropped ${Math.round(guard.staleShare * 100)}% of the prior revision's claims as stale/out-of-scope — allowed, recorded, never invisible.`
        }
      ]);
    }
    return { record: structuredClone(record), contradictions };
  }

  async rejectBrainDocRevision(input: {
    docId: string;
    kind: BrainDocKind;
    nodeId: string;
    slug: string;
    errors: string[];
    fedClaimIds: string[];
    inputStats: BrainDocRevisionRecord["inputStats"];
    model: string | null;
    effort: string | null;
    runId: string | null;
    promptVersion: number;
  }): Promise<void> {
    const now = Date.now();
    if (!this.brainDocs.has(input.docId)) {
      this.brainDocs.set(input.docId, {
        docId: input.docId,
        kind: input.kind,
        nodeId: input.nodeId,
        slug: input.slug,
        status: "active",
        mergedInto: null,
        currentRevisionId: null,
        lastRollupAtMs: null,
        createdAtMs: now
      });
    }
    const maxRevision = Math.max(
      0,
      ...[...this.brainDocRevisions.values()].filter((revision) => revision.docId === input.docId).map((revision) => revision.revision)
    );
    const record: BrainDocRevisionRecord = {
      id: this.brainDocRevisionSeq++,
      docId: input.docId,
      revision: maxRevision + 1,
      status: "rejected",
      sections: [],
      drops: [],
      fedClaimIds: [...input.fedClaimIds],
      inputStats: { ...input.inputStats },
      resolutionEventIds: [],
      errors: [...input.errors],
      model: input.model,
      effort: input.effort,
      runId: input.runId,
      promptVersion: input.promptVersion,
      createdAtMs: now
    };
    this.brainDocRevisions.set(record.id, record);
    await this.recordBrainValidationIssues([
      {
        runId: input.runId,
        docId: input.docId,
        code: "rollup_rejected",
        severity: "error",
        detail: `Rollup response failed validation twice; prior revision stays current. Errors: ${input.errors.join("; ")}`
      }
    ]);
  }

  async rollbackBrainDoc(docId: string, toRevision?: number | null): Promise<BrainDocDetail | null> {
    const doc = this.brainDocs.get(docId);
    if (!doc) {
      throw new PublicError("BRAIN_DOC_NO_REVISION", `Doc ${docId} does not exist.`);
    }
    // An UNROLLED doc has no current revision — and must still be restorable
    // by explicit revision number (mirror of the SQLite note).
    const current = doc.currentRevisionId ? this.brainDocRevisions.get(doc.currentRevisionId) ?? null : null;
    const docRevisions = [...this.brainDocRevisions.values()].filter((revision) => revision.docId === docId);
    // Revision 0 = unroll to the state before any page existed (see the SQLite
    // implementation's note: retention is why no hard delete exists).
    const unroll = toRevision === BRAIN_DOC_REVISION_NONE;
    if (!current && !unroll && toRevision == null) {
      throw new PublicError("BRAIN_DOC_NO_REVISION", `Doc ${docId} has no current revision to roll back; name a revision to restore.`);
    }
    if (!current && unroll) {
      throw new PublicError("BRAIN_DOC_NO_REVISION", `Doc ${docId} is already unrolled.`);
    }
    const target = unroll
      ? undefined
      : toRevision
        ? docRevisions.find((revision) => revision.revision === toRevision)
        : docRevisions
            .filter((revision) => revision.revision < current!.revision && revision.status === "superseded")
            .sort((a, b) => b.revision - a.revision)[0];
    if (!unroll && (!target || target.id === current?.id)) {
      throw new PublicError("BRAIN_DOC_NO_TARGET", `Doc ${docId} has no prior revision${toRevision ? ` numbered ${toRevision}` : ""} to restore.`);
    }
    if (target?.status === "rejected") {
      throw new PublicError("BRAIN_DOC_BAD_TARGET", `Revision ${target.revision} was rejected and cannot become current.`);
    }
    if (current) {
      current.status = "superseded";
    }
    if (target) {
      target.status = "current";
      doc.currentRevisionId = target.id;
      // Restoring onto an unrolled doc restores its rollup stamp too.
      doc.lastRollupAtMs = doc.lastRollupAtMs ?? target.createdAtMs;
    } else {
      doc.currentRevisionId = null;
      doc.lastRollupAtMs = null;
    }
    // Re-derive this doc's supersession projections from the surviving chain.
    for (const revision of docRevisions) {
      if (revision.status === "rejected") {
        continue;
      }
      for (const drop of revision.drops) {
        if (drop.reason === "superseded") {
          this.claimSupersededBy.delete(drop.claimId);
        }
      }
    }
    for (const revision of [...docRevisions].sort((a, b) => a.revision - b.revision)) {
      if (revision.status === "rejected" || revision.revision > (target?.revision ?? 0)) {
        continue;
      }
      for (const drop of revision.drops) {
        if (drop.reason === "superseded" && drop.byClaimId) {
          this.claimSupersededBy.set(drop.claimId, drop.byClaimId);
        }
      }
    }
    await this.recordBrainValidationIssues([
      {
        docId,
        code: "rollup_rollback",
        severity: "info",
        detail: target
          ? `Rolled back from revision ${current?.revision ?? "none"} to revision ${target.revision}.`
          : `Unrolled from revision ${current?.revision ?? "none"}: the page returns to eligible-but-never-rolled. Every revision is retained and restorable; the next rollup generates from scratch.`
      }
    ]);
    return this.getBrainDoc(docId);
  }

  private memDocDueness(
    doc: BrainDocRecord,
    node: MemGraphNode | undefined
  ): { due: boolean; dueReasons: BrainDocDueReason[]; eligibleClaims: number; newClaims: number; openItems: number } {
    const reasons: BrainDocDueReason[] = [];
    if (!node) {
      return { due: false, dueReasons: reasons, eligibleClaims: 0, newClaims: 0, openItems: 0 };
    }
    if (node.status === "merged" || doc.status === "merged") {
      reasons.push("merged_scope");
    }
    const claims = this.memHydrateRollupClaims(this.memDocScopeClaimIds(doc.kind, node));
    const eligibleClaims = claims.length;
    let newClaims = 0;
    if (doc.lastRollupAtMs == null) {
      if (eligibleClaims >= rollupMinClaims()) {
        reasons.push("never_rolled");
      }
      newClaims = eligibleClaims;
    } else {
      const lastRollupIso = new Date(doc.lastRollupAtMs).toISOString();
      newClaims = claims.filter((claim) => {
        const episode = this.brainEpisodes.get(claim.episodeId);
        return episode != null && episode.createdAt > lastRollupIso;
      }).length;
      if (newClaims >= rollupDueNewClaims()) {
        reasons.push("new_claims");
      }
      const refs = this.memCurrentRevisionRefs(doc)?.referencedClaimIds ?? [];
      if (refs.length > 0) {
        const alive = refs.filter((claimId) => {
          const found = this.memLifecycleClaim(claimId);
          return found != null && found.episode.status === "current";
        });
        if (alive.length < refs.length) {
          reasons.push("claims_deleted");
        }
        const refSet = new Set(refs);
        // Exclude the events the CURRENT revision itself applied — they land
        // milliseconds after the rollup stamp and must not self-trigger.
        const ownEvents = new Set(
          doc.currentRevisionId ? this.brainDocRevisions.get(doc.currentRevisionId)?.resolutionEventIds ?? [] : []
        );
        if (
          this.lifecycleEvents.some(
            (event) =>
              refSet.has(event.claimId) &&
              event.orphanedAtMs == null &&
              event.createdAtMs > (doc.lastRollupAtMs ?? 0) &&
              !ownEvents.has(event.id)
          )
        ) {
          reasons.push("lifecycle_changed");
        }
      }
    }
    const openItems = claims.filter((claim) => claim.lifecycleStatus === "open").length;
    return { due: reasons.length > 0, dueReasons: reasons, eligibleClaims, newClaims, openItems };
  }

  async listBrainDocs(options?: { kind?: BrainDocKind; view?: BrainDocsListView; limit?: number }): Promise<BrainDocsListResponse> {
    const asOfMs = Date.now();
    const items: BrainDocListItem[] = [];
    const issueCounts = new Map<string, number>();
    for (const issue of this.brainIssues) {
      if (issue.docId) {
        issueCounts.set(issue.docId, (issueCounts.get(issue.docId) ?? 0) + 1);
      }
    }
    for (const doc of this.brainDocs.values()) {
      const node = doc.nodeId ? this.graphNodes.get(doc.nodeId) : undefined;
      const dueness = this.memDocDueness(doc, node);
      const currentRevision = doc.currentRevisionId ? this.brainDocRevisions.get(doc.currentRevisionId) : undefined;
      items.push({
        docId: doc.docId,
        kind: doc.kind,
        nodeId: doc.nodeId ?? "",
        slug: doc.slug ?? "",
        title: node ? this.memDocNodeLabel(node) : doc.slug ?? doc.docId,
        status: node?.status === "merged" ? "merged" : doc.status,
        mergedInto: doc.mergedInto,
        revision: currentRevision?.revision ?? null,
        lastRollupAtMs: doc.lastRollupAtMs,
        eligibleClaims: dueness.eligibleClaims,
        newClaimsSinceRollup: dueness.newClaims,
        due: dueness.due,
        dueReasons: dueness.dueReasons,
        salience: node?.salience ?? 0,
        openLifecycleItems: dueness.openItems,
        issueCount: issueCounts.get(doc.docId) ?? 0
      });
    }
    // Candidates: page-eligible nodes without a doc, person-deduped.
    const floor = rollupMinClaims();
    const candidateByPerson = new Map<string, { node: MemGraphNode; claimCount: number }>();
    const candidates: Array<{ node: MemGraphNode; claimCount: number }> = [];
    for (const node of this.graphNodes.values()) {
      const kind = this.memDocKindForNode(node);
      if (!kind || node.status !== "active") {
        continue;
      }
      if ([...this.brainDocs.values()].some((doc) => doc.nodeId === node.id)) {
        continue;
      }
      const claimCount = this.memHydrateRollupClaims(this.memDocScopeClaimIds(kind, node)).length;
      if (claimCount < floor) {
        continue;
      }
      if (node.kind === "person" && node.jid) {
        const personKey = this.personMembers.get(this.canonicalJid(node.jid) ?? node.jid)?.personId ?? node.jid;
        const existing = candidateByPerson.get(personKey);
        if (!existing || claimCount > existing.claimCount) {
          candidateByPerson.set(personKey, { node, claimCount });
        }
        continue;
      }
      candidates.push({ node, claimCount });
    }
    candidates.push(...candidateByPerson.values());
    let candidateCount = 0;
    for (const candidate of candidates) {
      const kind = this.memDocKindForNode(candidate.node)!;
      candidateCount += 1;
      items.push({
        docId: docIdFor(kind, candidate.node.slug),
        kind,
        nodeId: candidate.node.id,
        slug: candidate.node.slug,
        title: this.memDocNodeLabel(candidate.node),
        status: "active",
        mergedInto: null,
        revision: null,
        lastRollupAtMs: null,
        eligibleClaims: candidate.claimCount,
        newClaimsSinceRollup: candidate.claimCount,
        due: true,
        dueReasons: ["never_rolled"],
        salience: candidate.node.salience,
        openLifecycleItems: 0,
        issueCount: 0
      });
    }
    let filtered = items;
    if (options?.kind) {
      filtered = filtered.filter((item) => item.kind === options.kind);
    }
    // Each count chip is a view: pages you have, work that is due, nodes
    // eligible without a page yet, and docs carrying validation issues.
    switch (options?.view) {
      case 'pages':
        filtered = filtered.filter((item) => item.revision != null);
        break;
      case 'due':
        filtered = filtered.filter((item) => item.due);
        break;
      case 'candidates':
        filtered = filtered.filter((item) => item.revision == null);
        break;
      case 'issues':
        filtered = filtered.filter((item) => item.issueCount > 0);
        break;
      default:
        break;
    }
    filtered.sort((a, b) => {
      if (a.due !== b.due) return a.due ? -1 : 1;
      if (a.salience !== b.salience) return b.salience - a.salience;
      return a.docId < b.docId ? -1 : 1;
    });
    return {
      items: filtered.slice(0, options?.limit ?? 200),
      counts: {
        // A doc row with no current revision (unrolled) is not a page.
        docs: items.filter((item) => item.revision != null).length,
        due: items.filter((item) => item.due).length,
        candidates: candidateCount,
        issues: [...issueCounts.values()].reduce((sum, count) => sum + count, 0)
      },
      asOfMs
    };
  }

  private memDocRenderContext(doc: BrainDocRecord, node: MemGraphNode, revision: BrainDocRevisionRecord): DocRenderContext {
    const referenced = new Set<string>();
    for (const section of revision.sections) {
      for (const statement of section.statements) {
        for (const claimId of statement.claimIds) {
          referenced.add(claimId);
        }
      }
    }
    const claimMeta = new Map<string, DocRenderClaimMeta>();
    for (const claimId of referenced) {
      const found = this.memLifecycleClaim(claimId);
      if (!found) {
        claimMeta.set(claimId, { exists: false, episodeId: null, episodeFile: null, episodeClaimIndex: null, citationKeys: [] });
        continue;
      }
      // Must match the projected file name exactly or the wikilink dangles.
      const fileSlug = episodeFileBase({
        id: found.episode.id,
        startAtMs: found.episode.startAtMs,
        chatSourceId: found.episode.chatSourceId,
        chatDisplayName: this.chats.get(found.episode.chatSourceId)?.displayName ?? null
      });
      claimMeta.set(claimId, {
        exists: found.episode.status === "current",
        episodeId: found.episode.id,
        episodeFile: fileSlug,
        episodeClaimIndex: found.episode.claims.findIndex((claim) => claim.id === claimId) + 1,
        citationKeys: found.claim.citations.map((citation) => citation.sourceMessageKey)
      });
    }
    const aliases = [...(this.graphAliases.get(node.id)?.values() ?? [])].map((entry) => entry.alias).sort().slice(0, 12);
    const memberLabels: string[] = [];
    if (node.kind === "person" && node.jid) {
      for (const scopeNodeId of this.memDocScopeNodeIds(node)) {
        const member = this.graphNodes.get(scopeNodeId);
        if (member) {
          const label = this.memDocNodeLabel(member);
          if (!memberLabels.includes(label)) {
            memberLabels.push(label);
          }
        }
      }
    }
    const related: DocRenderContext["related"] = [];
    const adjacent = [...this.graphEdges.values()]
      .filter((edge) => edge.srcNodeId === node.id || edge.dstNodeId === node.id)
      .sort((a, b) => b.evidence.size - a.evidence.size);
    for (const edge of adjacent) {
      const otherId = edge.srcNodeId === node.id ? edge.dstNodeId : edge.srcNodeId;
      const other = this.graphNodes.get(otherId);
      const otherKind = other ? this.memDocKindForNode(other) : null;
      if (!other || !otherKind || other.status !== "active") {
        continue;
      }
      if (![...this.brainDocs.values()].some((candidate) => candidate.nodeId === other.id)) {
        continue;
      }
      if (!related.some((entry) => entry.slug === other.slug)) {
        related.push({ kind: otherKind, slug: other.slug, title: this.memDocNodeLabel(other) });
      }
      if (related.length >= 8) {
        break;
      }
    }
    return {
      docId: doc.docId,
      kind: doc.kind,
      slug: doc.slug ?? node.slug,
      nodeId: node.id,
      title: this.memDocNodeLabel(node),
      revision: revision.revision,
      updatedAtMs: revision.createdAtMs,
      aliases,
      memberLabels,
      claimMeta,
      related,
      mergedIntoDoc: null
    };
  }

  async getBrainDoc(docId: string): Promise<BrainDocDetail | null> {
    let doc = this.brainDocs.get(docId);
    let redirected = false;
    if (doc?.nodeId) {
      const node = this.graphNodes.get(doc.nodeId);
      if (node?.status === "merged" && node.mergedInto) {
        const survivor = this.memResolveDocTargetNode({ nodeId: node.mergedInto });
        if (survivor) {
          const survivorDocId = docIdFor(this.memDocKindForNode(survivor.node)!, survivor.node.slug);
          if (survivorDocId !== docId) {
            doc.status = "merged";
            doc.mergedInto = survivorDocId;
            const survivorDoc = await this.getBrainDoc(survivorDocId);
            if (survivorDoc) {
              return { ...survivorDoc, redirected: true };
            }
          }
        }
      }
    }
    if (!doc) {
      const resolved = this.memResolveDocTargetNode({ docId });
      if (!resolved) {
        return null;
      }
      redirected = resolved.redirected;
      const kind = this.memDocKindForNode(resolved.node)!;
      const resolvedDocId = docIdFor(kind, resolved.node.slug);
      doc = this.brainDocs.get(resolvedDocId);
      if (!doc) {
        const synthetic: BrainDocRecord = {
          docId: resolvedDocId,
          kind,
          nodeId: resolved.node.id,
          slug: resolved.node.slug,
          status: "active",
          mergedInto: null,
          currentRevisionId: null,
          lastRollupAtMs: null,
          createdAtMs: Date.now()
        };
        const dueness = this.memDocDueness(synthetic, resolved.node);
        return {
          doc: synthetic,
          title: this.memDocNodeLabel(resolved.node),
          redirected,
          current: null,
          sections: [],
          markdown: null,
          history: [],
          issues: await this.listBrainValidationIssues({ docId: resolvedDocId, limit: 50 }),
          due: dueness.due,
          dueReasons: dueness.dueReasons,
          asOfMs: Date.now()
        };
      }
    }
    const node = doc.nodeId ? this.graphNodes.get(doc.nodeId) : undefined;
    const current = doc.currentRevisionId ? this.brainDocRevisions.get(doc.currentRevisionId) ?? null : null;
    const sections: BrainDocSectionView[] = [];
    let markdown: string | null = null;
    if (current && node) {
      const context = this.memDocRenderContext(doc, node, current);
      markdown = renderDocMarkdown(context, current.sections);
      for (const section of current.sections) {
        const statements: BrainDocStatementView[] = [];
        for (const statement of section.statements) {
          statements.push({
            text: statement.text,
            claims: statement.claimIds.map((claimId) => {
              const meta = context.claimMeta.get(claimId);
              return {
                claimId,
                exists: meta?.exists ?? false,
                episodeId: meta?.episodeId ?? null,
                citations: (meta?.citationKeys ?? []).map((key) => {
                  const message = [...this.messages.values()].find((entry) => entry.sourceMessageKey === key);
                  const chat = message ? this.chats.get(message.chatSourceId) : undefined;
                  return {
                    sourceMessageKey: key,
                    chatId: chat?.id ?? null,
                    messageId: message?.id ?? null,
                    timestampMs: message?.timestampMs ?? null
                  };
                })
              };
            })
          });
        }
        sections.push({ title: section.title, statements });
      }
    }
    const history = [...this.brainDocRevisions.values()]
      .filter((revision) => revision.docId === doc!.docId)
      .sort((a, b) => b.revision - a.revision)
      .slice(0, 50)
      .map((revision) => {
        const referenced = new Set<string>();
        for (const section of revision.sections) {
          for (const statement of section.statements) {
            for (const claimId of statement.claimIds) {
              referenced.add(claimId);
            }
          }
        }
        return {
          id: revision.id,
          revision: revision.revision,
          status: revision.status,
          statementCount: revision.sections.reduce((sum, section) => sum + section.statements.length, 0),
          referencedClaimCount: referenced.size,
          fedClaimCount: revision.fedClaimIds.length,
          dropCount: revision.drops.length,
          drops: structuredClone(revision.drops),
          resolutionCount: revision.resolutionEventIds.length,
          errors: revision.errors ? [...revision.errors] : null,
          model: revision.model,
          effort: revision.effort,
          runId: revision.runId,
          promptVersion: revision.promptVersion,
          createdAtMs: revision.createdAtMs
        };
      });
    const dueness = node
      ? this.memDocDueness(doc, node)
      : { due: false, dueReasons: [] as BrainDocDueReason[], eligibleClaims: 0, newClaims: 0, openItems: 0 };
    return {
      doc: structuredClone(doc),
      title: node ? this.memDocNodeLabel(node) : doc.slug ?? doc.docId,
      redirected,
      current: current ? structuredClone(current) : null,
      sections,
      markdown,
      history,
      issues: await this.listBrainValidationIssues({ docId: doc.docId, limit: 50 }),
      due: dueness.due,
      dueReasons: dueness.dueReasons,
      asOfMs: Date.now()
    };
  }

  async listBrainDocsForProjection(): Promise<Array<{ context: DocRenderContext; sections: BrainDocSection[] }>> {
    const out: Array<{ context: DocRenderContext; sections: BrainDocSection[] }> = [];
    for (const doc of this.brainDocs.values()) {
      const node = doc.nodeId ? this.graphNodes.get(doc.nodeId) : undefined;
      if (!node) {
        continue;
      }
      const merged = node.status === "merged" || doc.status === "merged";
      if (merged) {
        let mergedIntoDoc: DocRenderContext["mergedIntoDoc"] = null;
        const survivor = node.mergedInto ? this.memResolveDocTargetNode({ nodeId: node.mergedInto }) : null;
        if (survivor) {
          mergedIntoDoc = {
            slug: survivor.node.slug,
            kind: this.memDocKindForNode(survivor.node)!,
            title: this.memDocNodeLabel(survivor.node)
          };
        }
        out.push({
          context: {
            docId: doc.docId,
            kind: doc.kind,
            slug: doc.slug ?? node.slug,
            nodeId: node.id,
            title: this.memDocNodeLabel(node),
            revision: 0,
            updatedAtMs: doc.lastRollupAtMs ?? doc.createdAtMs,
            aliases: [],
            memberLabels: [],
            claimMeta: new Map(),
            related: [],
            mergedIntoDoc
          },
          sections: []
        });
        continue;
      }
      if (!doc.currentRevisionId) {
        continue;
      }
      const revision = this.brainDocRevisions.get(doc.currentRevisionId);
      if (revision) {
        out.push({ context: this.memDocRenderContext(doc, node, revision), sections: structuredClone(revision.sections) });
      }
    }
    return out;
  }

  async getBrainOverviewData(): Promise<OverviewRenderData> {
    const backfill = await this.getBrainBackfillStats();
    const pending = Math.max(0, backfill.totalVisibleMessages - backfill.assimilatedVisibleMessages);
    const coveragePercent =
      backfill.totalVisibleMessages > 0
        ? Math.round(((backfill.totalVisibleMessages - pending) / backfill.totalVisibleMessages) * 1000) / 10
        : 100;
    const docs = await this.listBrainDocs({ limit: 10_000 });
    const lifecycle = await this.listBrainLifecycleItems({ status: "open", sort: "smart", limit: 6 });
    const summary = await this.getBrainValidationIssueSummary();
    const top = [...this.graphNodes.values()]
      .filter((node) => node.status === "active" && ["person", "topic", "org", "chat", "project"].includes(node.kind))
      .sort((a, b) => b.salience - a.salience)
      .slice(0, 10);
    const latestRun = [...this.brainRuns.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0] ?? null;
    return {
      generatedAtMs: Date.now(),
      coveragePercent,
      totalVisibleMessages: backfill.totalVisibleMessages,
      assimilatedVisibleMessages: backfill.assimilatedVisibleMessages,
      docsTotal: docs.counts.docs,
      docsDue: docs.counts.due,
      docCandidates: docs.counts.candidates,
      openItems: lifecycle.counts.open,
      overdueItems: lifecycle.counts.overdue,
      staleItems: lifecycle.counts.stale,
      soonestDue: lifecycle.items.slice(0, 6).map((item) => ({ text: item.text, dueMs: item.dueMs, chatLabel: item.chatDisplayName })),
      topEntities: top.map((node) => ({
        title: this.memDocNodeLabel(node),
        kind: this.memDocKindForNode(node) ?? "entity",
        slug: node.slug,
        salience: node.salience,
        hasDoc: [...this.brainDocs.values()].some((doc) => doc.nodeId === node.id)
      })),
      issueCount: summary.error + summary.warning + summary.info,
      orphanedResolutions: this.lifecycleEvents.filter((event) => event.orphanedAtMs != null).length,
      lastRunLine: latestRun ? `${latestRun.kind} ${latestRun.status}${latestRun.finishedAt ? ` at ${latestRun.finishedAt}` : ""}` : null,
      providerLine: null
    };
  }

  // === Knowledge graph engine (mirror of the SQLite implementation) ========
  // Same derivation module, same natural-key semantics, same outputs — parity
  // by construction so the test suite exercises identical behavior.

  private memEnsureGraphNode(spec: GraphNodeSpec): string {
    const existingId = this.graphNodeIdByKey.get(spec.naturalKey);
    if (existingId) {
      const node = this.graphNodes.get(existingId)!;
      if (spec.seenAtMs != null) {
        node.firstSeenAtMs = node.firstSeenAtMs == null ? spec.seenAtMs : Math.min(node.firstSeenAtMs, spec.seenAtMs);
        node.lastSeenAtMs = node.lastSeenAtMs == null ? spec.seenAtMs : Math.max(node.lastSeenAtMs, spec.seenAtMs);
      }
      node.title = node.title ?? spec.title ?? null;
      node.payload = node.payload ?? (spec.payload ? structuredClone(spec.payload) : null);
      return existingId;
    }
    const id = randomUUID();
    const slug = slugForGraphNode(spec.kind, spec.slugSeed, spec.naturalKey, (candidate) => this.graphSlugs.has(candidate));
    this.graphSlugs.add(slug);
    this.graphNodes.set(id, {
      id,
      kind: spec.kind,
      naturalKey: spec.naturalKey,
      slug,
      title: spec.title,
      jid: spec.jid,
      chatScope: spec.chatScope,
      payload: spec.payload ? structuredClone(spec.payload) : null,
      status: "active",
      mergedInto: null,
      salience: 0,
      citationCount: 0,
      evidenceDays: 0,
      engagementFactor: 1,
      firstSeenAtMs: spec.seenAtMs,
      lastSeenAtMs: spec.seenAtMs
    });
    this.graphNodeIdByKey.set(spec.naturalKey, id);
    return id;
  }

  private memAddGraphEdgeEvidence(
    srcNodeId: string,
    dstNodeId: string,
    kind: BrainGraphEdgeKind,
    evidence: GraphEvidenceSpec,
    bounds?: { firstMs?: number | null; lastMs?: number | null }
  ): boolean {
    const key = `${srcNodeId}|${dstNodeId}|${kind}`;
    let edge = this.graphEdges.get(key);
    const observed = evidence.observedAtMs ?? null;
    const firstCandidate = bounds?.firstMs ?? observed;
    const lastCandidate = bounds?.lastMs ?? observed;
    if (!edge) {
      edge = {
        id: this.graphEdgeSeq++,
        srcNodeId,
        dstNodeId,
        kind,
        firstSeenAtMs: firstCandidate ?? null,
        lastSeenAtMs: lastCandidate ?? null,
        evidence: new Map()
      };
      this.graphEdges.set(key, edge);
      this.graphEdgesById.set(edge.id, edge);
    } else {
      if (firstCandidate != null) {
        edge.firstSeenAtMs = edge.firstSeenAtMs == null ? firstCandidate : Math.min(edge.firstSeenAtMs, firstCandidate);
      }
      if (lastCandidate != null) {
        edge.lastSeenAtMs = edge.lastSeenAtMs == null ? lastCandidate : Math.max(edge.lastSeenAtMs, lastCandidate);
      }
    }
    if (edge.evidence.has(evidence.key)) {
      return false;
    }
    edge.evidence.set(evidence.key, {
      claimId: evidence.claimId ?? null,
      sourceMessageKey: evidence.sourceMessageKey ?? null,
      sourceRef: evidence.sourceRef ?? null,
      observedAtMs: observed
    });
    return true;
  }

  private memApplyGraphMutations(mutations: GraphMutations): void {
    const idByKey = new Map<string, string>();
    for (const spec of mutations.nodes.values()) {
      idByKey.set(spec.naturalKey, this.memEnsureGraphNode(spec));
    }
    const resolveKey = (key: string): string | undefined => idByKey.get(key) ?? this.graphNodeIdByKey.get(key);
    for (const link of mutations.claimLinks) {
      const nodeId = resolveKey(link.nodeKey);
      if (!nodeId) {
        continue;
      }
      const set = this.graphNodeClaims.get(nodeId) ?? new Set<string>();
      set.add(link.claimId);
      this.graphNodeClaims.set(nodeId, set);
    }
    for (const alias of mutations.aliases) {
      const nodeId = resolveKey(alias.nodeKey);
      const clean = alias.alias.trim();
      if (!nodeId || !clean) {
        continue;
      }
      const aliases = this.graphAliases.get(nodeId) ?? new Map<string, { alias: string; source: string }>();
      if (!aliases.has(clean)) {
        aliases.set(clean, { alias: clean, source: alias.source });
      }
      this.graphAliases.set(nodeId, aliases);
    }
    for (const edge of mutations.edges) {
      const srcId = resolveKey(edge.srcKey);
      const dstId = resolveKey(edge.dstKey);
      if (srcId && dstId && srcId !== dstId) {
        this.memAddGraphEdgeEvidence(srcId, dstId, edge.kind, edge.evidence);
      }
    }
  }

  private memBuildEpisodeGraphSource(record: BrainEpisodeRecord): GraphEpisodeSource {
    return {
      id: record.id,
      chatSourceId: record.chatSourceId,
      startAtMs: record.startAtMs,
      endAtMs: record.endAtMs,
      generator: record.generator,
      topics: record.topics,
      claims: record.claims.map((claim) => ({
        id: claim.id,
        kind: claim.kind,
        text: claim.text,
        eventAtMs: claim.eventAtMs,
        validUntilMs: claim.validUntilMs,
        entities: claim.entities.map((entity) => ({ kind: entity.kind, name: entity.name, jid: entity.jid, role: entity.role })),
        citations: claim.citations.map((citation) => ({
          sourceMessageKey: citation.sourceMessageKey,
          senderSourceJid: citation.senderSourceJid,
          timestampMs: citation.timestampMs
        }))
      }))
    };
  }

  private memBuildEpisodeGraphContext(source: GraphEpisodeSource): EpisodeGraphContext {
    const windowMentions: EpisodeGraphContext["windowMentions"] = [];
    const windowReplies: EpisodeGraphContext["windowReplies"] = [];
    for (const message of this.messages.values()) {
      if (message.chatSourceId !== source.chatSourceId) {
        continue;
      }
      const ts = message.timestampMs ?? null;
      if (ts == null || ts < source.startAtMs || ts > source.endAtMs) {
        continue;
      }
      for (const mentioned of message.mentionedJids ?? []) {
        windowMentions.push({
          mentionedJid: mentioned,
          senderJid: message.senderSourceJid ?? null,
          sourceMessageKey: message.sourceMessageKey,
          timestampMs: ts
        });
      }
      const quotedId = message.quotedSnapshot?.quotedSourceMessageId ?? null;
      if (quotedId) {
        const targetChat = message.quotedSnapshot?.quotedSourceChatId
          ? this.canonicalJid(message.quotedSnapshot.quotedSourceChatId) ?? message.quotedSnapshot.quotedSourceChatId
          : source.chatSourceId;
        const target = [...this.messages.values()].find(
          (candidate) => candidate.chatSourceId === targetChat && candidate.sourceMessageId === quotedId
        );
        if (target) {
          windowReplies.push({
            replySourceMessageKey: message.sourceMessageKey,
            replySenderJid: message.senderSourceJid ?? null,
            quotedSourceMessageKey: target.sourceMessageKey,
            timestampMs: ts
          });
        }
      }
    }
    const inboundReplies: EpisodeGraphContext["inboundReplies"] = [];
    for (const claim of source.claims) {
      if (claim.kind !== "commitment" && claim.kind !== "question") {
        continue;
      }
      for (const citation of claim.citations) {
        const target = this.messages.get(citation.sourceMessageKey);
        if (!target) {
          continue;
        }
        for (const message of this.messages.values()) {
          if (message.quotedSnapshot?.quotedSourceMessageId !== target.sourceMessageId) {
            continue;
          }
          const quotedChat = message.quotedSnapshot?.quotedSourceChatId
            ? this.canonicalJid(message.quotedSnapshot.quotedSourceChatId) ?? message.quotedSnapshot.quotedSourceChatId
            : message.chatSourceId;
          if (quotedChat !== target.chatSourceId) {
            continue;
          }
          inboundReplies.push({
            claimId: claim.id,
            replySourceMessageKey: message.sourceMessageKey,
            replySenderJid: message.senderSourceJid ?? null,
            timestampMs: message.timestampMs ?? null
          });
        }
      }
    }
    return {
      canonicalJid: (jid) => this.canonicalJid(jid),
      windowMentions,
      windowReplies,
      lifecycleTargetsForMessage: (sourceMessageKey) => {
        const keys: string[] = [];
        for (const episode of this.brainEpisodes.values()) {
          if (episode.status !== "current" || episode.generator !== "model") {
            continue;
          }
          for (const claim of episode.claims) {
            if (claim.kind !== "commitment" && claim.kind !== "question") {
              continue;
            }
            if (!claim.citations.some((citation) => citation.sourceMessageKey === sourceMessageKey)) {
              continue;
            }
            const naturalKey = `${claim.kind}:${claim.id}`;
            if (this.graphNodeIdByKey.has(naturalKey)) {
              keys.push(naturalKey);
            }
          }
        }
        return keys;
      },
      inboundReplies
    };
  }

  private memApplyEpisodeGraph(record: BrainEpisodeRecord): void {
    if (record.generator !== "model") {
      return;
    }
    const source = this.memBuildEpisodeGraphSource(record);
    this.memApplyGraphMutations(deriveEpisodeGraph(source, this.memBuildEpisodeGraphContext(source)));
  }

  private memRemoveGraphContributionForEpisode(episodeId: string): void {
    const episode = this.brainEpisodes.get(episodeId);
    if (!episode) {
      return;
    }
    const claimIds = new Set(episode.claims.map((claim) => claim.id));
    if (claimIds.size === 0) {
      return;
    }
    // Message keys inside the removed episode's window: their derivation-time
    // evidence (participation, mentions, window replies) leaves with it —
    // mirror of the SQLite window cleanup.
    const windowKeys = new Set<string>();
    for (const message of this.messages.values()) {
      if (
        message.chatSourceId === episode.chatSourceId &&
        message.timestampMs != null &&
        message.timestampMs >= episode.startAtMs &&
        message.timestampMs <= episode.endAtMs
      ) {
        windowKeys.add(message.sourceMessageKey);
      }
    }
    const affected = new Set<MemGraphEdge>();
    for (const edge of this.graphEdges.values()) {
      for (const [key, evidence] of [...edge.evidence]) {
        if (
          (evidence.claimId && claimIds.has(evidence.claimId)) ||
          (evidence.sourceMessageKey && !evidence.claimId && !evidence.sourceRef && windowKeys.has(evidence.sourceMessageKey))
        ) {
          edge.evidence.delete(key);
          affected.add(edge);
        }
      }
    }
    for (const [nodeId, claims] of this.graphNodeClaims) {
      for (const claimId of [...claims]) {
        if (claimIds.has(claimId)) {
          claims.delete(claimId);
        }
      }
      if (claims.size === 0) {
        this.graphNodeClaims.delete(nodeId);
      }
    }
    for (const claimId of claimIds) {
      for (const kind of ["commitment", "question", "event"] as const) {
        const nodeId = this.graphNodeIdByKey.get(`${kind}:${claimId}`);
        if (!nodeId) {
          continue;
        }
        for (const [key, edge] of [...this.graphEdges]) {
          if (edge.srcNodeId === nodeId || edge.dstNodeId === nodeId) {
            this.graphEdges.delete(key);
            this.graphEdgesById.delete(edge.id);
            affected.delete(edge);
          }
        }
        this.memDeleteGraphNode(nodeId);
      }
    }
    for (const edge of affected) {
      if (edge.evidence.size === 0) {
        this.graphEdges.delete(`${edge.srcNodeId}|${edge.dstNodeId}|${edge.kind}`);
        this.graphEdgesById.delete(edge.id);
      } else {
        const observed = [...edge.evidence.values()].map((evidence) => evidence.observedAtMs).filter((ts): ts is number => ts != null);
        edge.firstSeenAtMs = observed.length ? Math.min(...observed) : null;
        edge.lastSeenAtMs = observed.length ? Math.max(...observed) : null;
      }
    }
    this.memPruneOrphanGraphNodes();
  }

  private memDeleteGraphNode(nodeId: string): void {
    const node = this.graphNodes.get(nodeId);
    if (!node) {
      return;
    }
    this.graphNodes.delete(nodeId);
    this.graphNodeIdByKey.delete(node.naturalKey);
    this.graphSlugs.delete(node.slug);
    this.graphNodeClaims.delete(nodeId);
    this.graphAliases.delete(nodeId);
  }

  private memPruneOrphanGraphNodes(): void {
    const referenced = new Set<string>();
    for (const edge of this.graphEdges.values()) {
      referenced.add(edge.srcNodeId);
      referenced.add(edge.dstNodeId);
    }
    const mergeTargets = new Set<string>();
    for (const node of this.graphNodes.values()) {
      if (node.mergedInto) {
        mergeTargets.add(node.mergedInto);
      }
    }
    for (const node of [...this.graphNodes.values()]) {
      if (node.status === "merged" || referenced.has(node.id) || mergeTargets.has(node.id)) {
        continue;
      }
      if ((this.graphNodeClaims.get(node.id)?.size ?? 0) > 0) {
        continue;
      }
      this.memDeleteGraphNode(node.id);
    }
  }

  private memMergeGraphNodes(fromId: string, toId: string): void {
    if (fromId === toId) {
      return;
    }
    const from = this.graphNodes.get(fromId);
    const to = this.graphNodes.get(toId);
    if (!from || !to) {
      return;
    }
    const fromClaims = this.graphNodeClaims.get(fromId);
    if (fromClaims) {
      const toClaims = this.graphNodeClaims.get(toId) ?? new Set<string>();
      for (const claimId of fromClaims) {
        toClaims.add(claimId);
      }
      this.graphNodeClaims.set(toId, toClaims);
      this.graphNodeClaims.delete(fromId);
    }
    const fromAliases = this.graphAliases.get(fromId);
    if (fromAliases) {
      const toAliases = this.graphAliases.get(toId) ?? new Map<string, { alias: string; source: string }>();
      for (const [key, value] of fromAliases) {
        if (!toAliases.has(key)) {
          toAliases.set(key, value);
        }
      }
      this.graphAliases.set(toId, toAliases);
      this.graphAliases.delete(fromId);
    }
    for (const [key, edge] of [...this.graphEdges]) {
      if (edge.srcNodeId !== fromId && edge.dstNodeId !== fromId) {
        continue;
      }
      const newSrc = edge.srcNodeId === fromId ? toId : edge.srcNodeId;
      const newDst = edge.dstNodeId === fromId ? toId : edge.dstNodeId;
      this.graphEdges.delete(key);
      if (newSrc === newDst) {
        this.graphEdgesById.delete(edge.id);
        continue;
      }
      const newKey = `${newSrc}|${newDst}|${edge.kind}`;
      const conflict = this.graphEdges.get(newKey);
      if (conflict) {
        for (const [evidenceKey, evidence] of edge.evidence) {
          if (!conflict.evidence.has(evidenceKey)) {
            conflict.evidence.set(evidenceKey, evidence);
          }
        }
        const observed = [...conflict.evidence.values()].map((evidence) => evidence.observedAtMs).filter((ts): ts is number => ts != null);
        conflict.firstSeenAtMs = observed.length ? Math.min(...observed) : conflict.firstSeenAtMs;
        conflict.lastSeenAtMs = observed.length ? Math.max(...observed) : conflict.lastSeenAtMs;
        this.graphEdgesById.delete(edge.id);
      } else {
        edge.srcNodeId = newSrc;
        edge.dstNodeId = newDst;
        this.graphEdges.set(newKey, edge);
      }
    }
    to.firstSeenAtMs = from.firstSeenAtMs == null ? to.firstSeenAtMs : to.firstSeenAtMs == null ? from.firstSeenAtMs : Math.min(to.firstSeenAtMs, from.firstSeenAtMs);
    to.lastSeenAtMs = from.lastSeenAtMs == null ? to.lastSeenAtMs : to.lastSeenAtMs == null ? from.lastSeenAtMs : Math.max(to.lastSeenAtMs, from.lastSeenAtMs);
    to.engagementFactor = Math.max(to.engagementFactor, from.engagementFactor);
    from.status = "merged";
    from.mergedInto = toId;
    from.salience = 0;
  }

  private memRekeyGraphNaturalKey(oldKey: string, newKey: string, updates: { jid?: string; chatScope?: string }): void {
    const fromId = this.graphNodeIdByKey.get(oldKey);
    if (!fromId) {
      return;
    }
    const toId = this.graphNodeIdByKey.get(newKey);
    if (!toId) {
      const node = this.graphNodes.get(fromId)!;
      this.graphNodeIdByKey.delete(oldKey);
      node.naturalKey = newKey;
      if (updates.jid) {
        node.jid = updates.jid;
      }
      if (updates.chatScope) {
        node.chatScope = updates.chatScope;
      }
      this.graphNodeIdByKey.set(newKey, fromId);
      return;
    }
    this.memMergeGraphNodes(fromId, toId);
  }

  private memRekeyGraphForIdentityMerge(lid: string, pn: string): void {
    this.memRekeyGraphNaturalKey(personJidNaturalKey(lid), personJidNaturalKey(pn), { jid: pn });
    this.memRekeyGraphNaturalKey(chatNaturalKey(lid), chatNaturalKey(pn), { chatScope: pn });
    for (const node of [...this.graphNodes.values()]) {
      if (node.status === "merged" || node.chatScope !== lid) {
        continue;
      }
      const marker = `:${lid}:`;
      if (node.naturalKey.includes(marker)) {
        this.memRekeyGraphNaturalKey(node.naturalKey, node.naturalKey.replace(marker, `:${pn}:`), { chatScope: pn });
      } else {
        node.chatScope = pn;
      }
    }
  }

  async syncBrainGraphSignals(): Promise<BrainGraphSyncResult> {
    const result: BrainGraphSyncResult = { participationEdges: 0, vcardMentionEdges: 0, numberChangeAliases: 0, engagementFactors: 0 };
    for (const period of this.membershipPeriods.values()) {
      const group = this.canonicalJid(period.groupSourceId) ?? period.groupSourceId;
      const participant = this.canonicalJid(period.participantJid) ?? period.participantJid;
      const chatId = this.memEnsureGraphNode({
        naturalKey: chatNaturalKey(group),
        kind: "chat",
        title: null,
        jid: null,
        chatScope: group,
        payload: null,
        slugSeed: group.split("@")[0] ?? group,
        seenAtMs: period.joinedAtMs ?? period.observedAtMs ?? null
      });
      const personId = this.memEnsureGraphNode({
        naturalKey: personJidNaturalKey(participant),
        kind: "person",
        title: null,
        jid: participant,
        chatScope: null,
        payload: null,
        slugSeed: participant.split("@")[0] ?? participant,
        seenAtMs: period.joinedAtMs ?? period.observedAtMs ?? null
      });
      const inserted = this.memAddGraphEdgeEvidence(
        personId,
        chatId,
        "participates_in",
        { key: `period:${period.periodKey}`, sourceRef: period.periodKey, observedAtMs: period.joinedAtMs ?? period.observedAtMs ?? null },
        { firstMs: period.joinedAtMs ?? null, lastMs: period.leftAtMs ?? period.joinedAtMs ?? period.observedAtMs ?? null }
      );
      if (inserted) {
        result.participationEdges += 1;
      }
    }
    for (const vcard of this.vcards.values()) {
      if (!vcard.resolvedJid) {
        continue;
      }
      const message = this.messages.get(vcard.sourceMessageKey);
      const subject = this.canonicalJid(vcard.resolvedJid) ?? vcard.resolvedJid;
      const subjectId = this.memEnsureGraphNode({
        naturalKey: personJidNaturalKey(subject),
        kind: "person",
        title: null,
        jid: subject,
        chatScope: null,
        payload: null,
        slugSeed: subject.split("@")[0] ?? subject,
        seenAtMs: message?.timestampMs ?? null
      });
      if (vcard.displayName?.trim()) {
        const aliases = this.graphAliases.get(subjectId) ?? new Map<string, { alias: string; source: string }>();
        const clean = vcard.displayName.trim();
        if (!aliases.has(clean)) {
          aliases.set(clean, { alias: clean, source: "vcard" });
        }
        this.graphAliases.set(subjectId, aliases);
      }
      const senderJid = message?.senderSourceJid ?? null;
      if (!senderJid) {
        continue;
      }
      const sharer = this.canonicalJid(senderJid) ?? senderJid;
      if (sharer === subject) {
        continue;
      }
      const sharerId = this.memEnsureGraphNode({
        naturalKey: personJidNaturalKey(sharer),
        kind: "person",
        title: null,
        jid: sharer,
        chatScope: null,
        payload: null,
        slugSeed: sharer.split("@")[0] ?? sharer,
        seenAtMs: message?.timestampMs ?? null
      });
      const inserted = this.memAddGraphEdgeEvidence(sharerId, subjectId, "mentions", {
        key: `vcard:${vcard.sourceMessageKey}:${vcard.cardIndex}`,
        sourceMessageKey: vcard.sourceMessageKey,
        sourceRef: `${vcard.sourceMessageKey}#${vcard.cardIndex}`,
        observedAtMs: message?.timestampMs ?? null
      });
      if (inserted) {
        result.vcardMentionEdges += 1;
      }
    }
    for (const change of this.numberChanges.values()) {
      const oldJid = this.canonicalJid(change.oldJid) ?? change.oldJid;
      const newJid = this.canonicalJid(change.newJid) ?? change.newJid;
      if (oldJid === newJid) {
        continue;
      }
      const oldId = this.memEnsureGraphNode({
        naturalKey: personJidNaturalKey(oldJid),
        kind: "person",
        title: null,
        jid: oldJid,
        chatScope: null,
        payload: null,
        slugSeed: oldJid.split("@")[0] ?? oldJid,
        seenAtMs: change.observedAtMs ?? null
      });
      const newId = this.memEnsureGraphNode({
        naturalKey: personJidNaturalKey(newJid),
        kind: "person",
        title: null,
        jid: newJid,
        chatScope: null,
        payload: null,
        slugSeed: newJid.split("@")[0] ?? newJid,
        seenAtMs: change.observedAtMs ?? null
      });
      const oldNumber = displayPhoneFromJid(oldJid);
      if (oldNumber) {
        const aliases = this.graphAliases.get(newId) ?? new Map<string, { alias: string; source: string }>();
        if (!aliases.has(oldNumber)) {
          aliases.set(oldNumber, { alias: oldNumber, source: "number_change" });
          result.numberChangeAliases += 1;
        }
        this.graphAliases.set(newId, aliases);
      }
      this.memAddGraphEdgeEvidence(oldId, newId, "alias_of", {
        key: `numchange:${change.eventKey}`,
        sourceRef: change.eventKey,
        observedAtMs: change.observedAtMs ?? null
      });
    }
    const engagementByJid = new Map<string, { eligibleOutgoingCount: number; readCount: number }>();
    for (const aggregate of this.engagementAggregates.values()) {
      if (!aggregate.counterpartyJid) {
        continue;
      }
      const canonical = this.canonicalJid(aggregate.counterpartyJid) ?? aggregate.counterpartyJid;
      const entry = engagementByJid.get(canonical) ?? { eligibleOutgoingCount: 0, readCount: 0 };
      entry.eligibleOutgoingCount += aggregate.eligibleOutgoingCount ?? 0;
      entry.readCount += aggregate.readCount ?? 0;
      engagementByJid.set(canonical, entry);
    }
    for (const [jid, entry] of engagementByJid) {
      const nodeId = this.graphNodeIdByKey.get(personJidNaturalKey(jid));
      if (!nodeId) {
        continue;
      }
      const factor = engagementFactorFromAggregates([entry]);
      const node = this.graphNodes.get(nodeId)!;
      if (node.engagementFactor !== factor) {
        node.engagementFactor = factor;
        result.engagementFactors += 1;
      }
    }
    return result;
  }

  async rebuildBrainGraph(): Promise<BrainGraphRebuildResult> {
    const startedAt = Date.now();
    this.graphNodes.clear();
    this.graphNodeIdByKey.clear();
    this.graphSlugs.clear();
    this.graphEdges.clear();
    this.graphEdgesById.clear();
    this.graphNodeClaims.clear();
    this.graphAliases.clear();
    const episodes = [...this.brainEpisodes.values()]
      .filter((episode) => episode.status === "current" && episode.generator === "model")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    for (const episode of episodes) {
      this.memApplyEpisodeGraph(episode);
    }
    await this.syncBrainGraphSignals();
    // Lifecycle projection: closures live outside the wiped graph state, so a
    // rebuild re-applies folded statuses and `resolves` edges from the events.
    this.memProjectLifecycleState();
    await this.recomputeBrainGraphSalience();
    let evidence = 0;
    for (const edge of this.graphEdges.values()) {
      evidence += edge.evidence.size;
    }
    return {
      episodesReplayed: episodes.length,
      nodes: this.graphNodes.size,
      edges: this.graphEdges.size,
      evidence,
      durationMs: Date.now() - startedAt
    };
  }

  async recomputeBrainGraphSalience(): Promise<BrainGraphRecomputeResult> {
    const startedAt = Date.now();
    const claimById = new Map<string, BrainEpisodeRecord["claims"][number]>();
    for (const episode of this.brainEpisodes.values()) {
      for (const claim of episode.claims) {
        claimById.set(claim.id, claim);
      }
    }
    const stats = new Map<string, { citations: number; days: Set<string>; lastTs: number | null }>();
    const record = (nodeId: string, ts: number | null) => {
      const entry = stats.get(nodeId) ?? { citations: 0, days: new Set<string>(), lastTs: null };
      entry.citations += 1;
      if (ts != null) {
        entry.days.add(new Date(ts).toISOString().slice(0, 10));
        entry.lastTs = entry.lastTs == null ? ts : Math.max(entry.lastTs, ts);
      }
      stats.set(nodeId, entry);
    };
    for (const [nodeId, claimIds] of this.graphNodeClaims) {
      for (const claimId of claimIds) {
        for (const citation of claimById.get(claimId)?.citations ?? []) {
          record(nodeId, citation.timestampMs);
        }
      }
    }
    for (const edge of this.graphEdges.values()) {
      for (const evidence of edge.evidence.values()) {
        record(edge.srcNodeId, evidence.observedAtMs);
        record(edge.dstNodeId, evidence.observedAtMs);
      }
    }
    const threshold = graphDormancyThreshold();
    const nowMs = Date.now();
    const result: BrainGraphRecomputeResult = { nodes: 0, dormant: 0, revived: 0, exemptOpenLifecycle: 0, durationMs: 0 };
    for (const node of this.graphNodes.values()) {
      if (node.status === "merged") {
        continue;
      }
      result.nodes += 1;
      const nodeStats = stats.get(node.id) ?? { citations: 0, days: new Set<string>(), lastTs: null };
      const computed = computeGraphSalience({
        kind: node.kind,
        payload: node.payload,
        citations: nodeStats.citations,
        evidenceDays: nodeStats.days.size,
        lastEvidenceAtMs: nodeStats.lastTs,
        nowMs,
        engagementFactor: node.engagementFactor,
        dormancyThreshold: threshold
      });
      const lifecycleOpen = (node.kind === "commitment" || node.kind === "question") && (node.payload?.status ?? "open") === "open";
      if (lifecycleOpen && computed.salience < threshold) {
        result.exemptOpenLifecycle += 1;
      }
      const nextStatus: BrainGraphNodeStatus = computed.dormant ? "dormant" : "active";
      if (nextStatus === "dormant" && node.status === "active") {
        result.dormant += 1;
      } else if (nextStatus === "active" && node.status === "dormant") {
        result.revived += 1;
      }
      node.salience = computed.salience;
      node.status = nextStatus;
      node.citationCount = nodeStats.citations;
      node.evidenceDays = nodeStats.days.size;
      if (nodeStats.lastTs != null) {
        node.lastSeenAtMs = node.lastSeenAtMs == null ? nodeStats.lastTs : Math.max(node.lastSeenAtMs, nodeStats.lastTs);
      }
    }
    this.graphLastRecomputeAt = new Date().toISOString();
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  async getBrainGraphStats(): Promise<BrainGraphStats> {
    const nodesByKind: Partial<Record<BrainGraphNodeKind, number>> = {};
    const nodesByStatus: Partial<Record<BrainGraphNodeStatus, number>> = {};
    let unresolved = 0;
    let openLifecycle = 0;
    for (const node of this.graphNodes.values()) {
      nodesByKind[node.kind] = (nodesByKind[node.kind] ?? 0) + 1;
      nodesByStatus[node.status] = (nodesByStatus[node.status] ?? 0) + 1;
      if (node.kind === "person" && !node.jid && node.status !== "merged") {
        unresolved += 1;
      }
      if (
        (node.kind === "commitment" || node.kind === "question") &&
        node.status !== "merged" &&
        (node.payload?.status ?? null) === "open"
      ) {
        openLifecycle += 1;
      }
    }
    const edgesByKind: Partial<Record<BrainGraphEdgeKind, number>> = {};
    let evidence = 0;
    for (const edge of this.graphEdges.values()) {
      edgesByKind[edge.kind] = (edgesByKind[edge.kind] ?? 0) + 1;
      evidence += edge.evidence.size;
    }
    return {
      nodeCount: this.graphNodes.size,
      edgeCount: this.graphEdges.size,
      evidenceCount: evidence,
      nodesByKind,
      nodesByStatus,
      edgesByKind,
      unresolvedPersonNodes: unresolved,
      openLifecycleNodes: openLifecycle,
      lastRecomputeAt: this.graphLastRecomputeAt
    };
  }

  private memGraphLabel(node: MemGraphNode): string {
    if (node.kind === "person" && node.jid) {
      return this.systemEventDisplayName(node.jid) ?? node.jid;
    }
    if (node.kind === "chat" && node.chatScope) {
      return this.chats.get(node.chatScope)?.displayName?.trim() || node.chatScope;
    }
    return node.title?.trim() || node.slug;
  }

  private memGraphNodeRecord(node: MemGraphNode): BrainGraphNodeRecord {
    return {
      id: node.id,
      kind: node.kind,
      naturalKey: node.naturalKey,
      slug: node.slug,
      label: this.memGraphLabel(node),
      title: node.title,
      jid: node.jid,
      chatScope: node.chatScope,
      payload: node.payload ? structuredClone(node.payload) : null,
      status: node.status,
      mergedInto: node.mergedInto,
      salience: node.salience,
      citationCount: node.citationCount,
      evidenceDays: node.evidenceDays,
      firstSeenAtMs: node.firstSeenAtMs,
      lastSeenAtMs: node.lastSeenAtMs
    };
  }

  async getBrainGraphEntity(query: { nodeId?: string; jid?: string; name?: string }): Promise<BrainGraphEntityView | null> {
    let node: MemGraphNode | undefined;
    let redirected = false;
    if (query.nodeId) {
      node = this.graphNodes.get(query.nodeId);
      for (let hop = 0; node && node.status === "merged" && node.mergedInto && hop < 5; hop += 1) {
        node = this.graphNodes.get(node.mergedInto);
        redirected = true;
      }
    } else if (query.jid) {
      const canonical = this.canonicalJid(query.jid) ?? query.jid;
      const nodeId = this.graphNodeIdByKey.get(personJidNaturalKey(canonical));
      node = nodeId ? this.graphNodes.get(nodeId) : undefined;
    } else if (query.name?.trim()) {
      const norm = query.name.trim().toLowerCase();
      const candidates = [...this.graphNodes.values()]
        .filter((candidate) => candidate.status !== "merged")
        .filter(
          (candidate) =>
            (candidate.title ?? "").toLowerCase() === norm ||
            [...(this.graphAliases.get(candidate.id)?.values() ?? [])].some((alias) => alias.alias.toLowerCase() === norm)
        )
        .sort((a, b) => b.salience - a.salience || b.citationCount - a.citationCount);
      node = candidates[0];
    }
    if (!node) {
      return null;
    }
    let personId: string | null = null;
    let memberJids: string[] = [];
    const memberNodes: MemGraphNode[] = [];
    if (node.kind === "person" && node.jid) {
      const person = await this.resolvePersonForJid(node.jid);
      personId = person?.id ?? null;
      memberJids = person ? person.members.map((member) => member.identityJid) : [node.jid];
      for (const jid of memberJids) {
        const canonical = this.canonicalJid(jid) ?? jid;
        const memberId = this.graphNodeIdByKey.get(personJidNaturalKey(canonical));
        const memberNode = memberId ? this.graphNodes.get(memberId) : undefined;
        if (memberNode && memberNode.status !== "merged") {
          memberNodes.push(memberNode);
        }
      }
      if (!memberNodes.some((member) => member.id === node!.id)) {
        memberNodes.push(node);
      }
    } else {
      memberJids = node.jid ? [node.jid] : [];
      memberNodes.push(node);
    }
    const nodeIds = new Set(memberNodes.map((member) => member.id));
    const jidByNodeId = new Map(memberNodes.map((member) => [member.id, member.jid]));
    const claimMeta = new Map<string, { episode: BrainEpisodeRecord; claim: BrainEpisodeRecord["claims"][number] }>();
    for (const episode of this.brainEpisodes.values()) {
      if (episode.status !== "current") {
        continue;
      }
      for (const claim of episode.claims) {
        claimMeta.set(claim.id, { episode, claim });
      }
    }
    const claims: BrainGraphEntityClaim[] = [];
    const seenClaims = new Set<string>();
    for (const nodeId of nodeIds) {
      for (const claimId of this.graphNodeClaims.get(nodeId) ?? []) {
        if (seenClaims.has(claimId)) {
          continue;
        }
        const meta = claimMeta.get(claimId);
        if (!meta) {
          continue;
        }
        seenClaims.add(claimId);
        claims.push({
          id: claimId,
          kind: meta.claim.kind,
          text: meta.claim.text,
          confidence: meta.claim.confidence,
          eventAtMs: meta.claim.eventAtMs,
          validUntilMs: meta.claim.validUntilMs,
          episodeId: meta.episode.id,
          chatSourceId: meta.episode.chatSourceId,
          chatDisplayName: meta.episode.chatDisplayName ?? this.chats.get(meta.episode.chatSourceId)?.displayName ?? null,
          viaJid: jidByNodeId.get(nodeId) ?? null,
          citations: structuredClone(meta.claim.citations)
        });
      }
    }
    claims.sort((a, b) => {
      const aTs = Math.max(...a.citations.map((citation) => citation.timestampMs ?? 0), 0);
      const bTs = Math.max(...b.citations.map((citation) => citation.timestampMs ?? 0), 0);
      return bTs - aTs;
    });
    const edges: BrainGraphEdgeView[] = [];
    for (const edge of this.graphEdges.values()) {
      const outbound = nodeIds.has(edge.srcNodeId);
      const inbound = nodeIds.has(edge.dstNodeId);
      if (!outbound && !inbound) {
        continue;
      }
      const otherId = outbound ? edge.dstNodeId : edge.srcNodeId;
      if (nodeIds.has(otherId)) {
        continue;
      }
      const other = this.graphNodes.get(otherId);
      if (!other) {
        continue;
      }
      edges.push({
        id: edge.id,
        kind: edge.kind,
        direction: outbound ? "out" : "in",
        otherNode: {
          id: other.id,
          kind: other.kind,
          label: this.memGraphLabel(other),
          slug: other.slug,
          status: other.status,
          salience: other.salience,
          jid: other.jid
        },
        weight: edge.evidence.size,
        evidenceCount: edge.evidence.size,
        firstSeenAtMs: edge.firstSeenAtMs,
        lastSeenAtMs: edge.lastSeenAtMs
      });
    }
    edges.sort((a, b) => b.evidenceCount - a.evidenceCount || (b.lastSeenAtMs ?? 0) - (a.lastSeenAtMs ?? 0));
    const aliases = new Set<string>();
    for (const nodeId of nodeIds) {
      for (const alias of this.graphAliases.get(nodeId)?.values() ?? []) {
        aliases.add(alias.alias);
      }
    }
    return {
      node: this.memGraphNodeRecord(node),
      personId,
      memberJids,
      memberNodes: memberNodes.map((member) => this.memGraphNodeRecord(member)),
      claims: claims.slice(0, 200),
      edges: edges.slice(0, 200),
      aliases: [...aliases].sort(),
      redirected
    };
  }

  private resolveMemGraphAnchor(query: { nodeId?: string; jid?: string; name?: string; chat?: string }): { node: MemGraphNode; redirected: boolean } | null {
    let node: MemGraphNode | undefined;
    let redirected = false;
    if (query.chat?.trim()) {
      const nodeId = this.graphNodeIdByKey.get(chatNaturalKey(query.chat.trim()));
      node = nodeId ? this.graphNodes.get(nodeId) : undefined;
    } else if (query.nodeId) {
      node = this.graphNodes.get(query.nodeId);
      for (let hop = 0; node && node.status === "merged" && node.mergedInto && hop < 5; hop += 1) {
        node = this.graphNodes.get(node.mergedInto);
        redirected = true;
      }
    } else if (query.jid) {
      const canonical = this.canonicalJid(query.jid) ?? query.jid;
      const nodeId = this.graphNodeIdByKey.get(personJidNaturalKey(canonical));
      node = nodeId ? this.graphNodes.get(nodeId) : undefined;
    } else if (query.name?.trim()) {
      const norm = query.name.trim().toLowerCase();
      // Prefer a resolved person whose read-time label (contact display name)
      // matches — people carry no stored title (mirror of the SQLite resolver).
      node = [...this.graphNodes.values()]
        .filter((candidate) => candidate.kind === "person" && candidate.jid && candidate.status !== "merged")
        .filter((candidate) => (this.contacts.get(candidate.jid as string)?.displayName ?? "").toLowerCase() === norm)
        .sort((a, b) => b.salience - a.salience)[0];
      if (!node) {
        node = [...this.graphNodes.values()]
          .filter((candidate) => candidate.status !== "merged")
          .filter(
            (candidate) =>
              (candidate.title ?? "").toLowerCase() === norm ||
              [...(this.graphAliases.get(candidate.id)?.values() ?? [])].some((alias) => alias.alias.toLowerCase() === norm)
          )
          .sort((a, b) => b.salience - a.salience || b.citationCount - a.citationCount)[0];
      }
    }
    if (!node || node.status === "merged") {
      return null;
    }
    return { node, redirected };
  }

  async searchBrainGraphNodes(query: string, limit = 10): Promise<BrainGraphNodeSuggestion[]> {
    const q = query.trim().toLowerCase();
    if (!q) {
      return [];
    }
    // Mirror of the SQLite typeahead: substring match on the read-time label
    // sources, claim-ish kinds excluded, salience-ranked, id-carrying.
    const cap = Math.max(1, Math.min(limit, 25));
    const claimKinds = new Set(["commitment", "question", "event", "fact"]);
    return [...this.graphNodes.values()]
      .filter((node) => node.status !== "merged" && !claimKinds.has(node.kind))
      .filter((node) => {
        // Match each kind against its own label source (mirror of the SQLite
        // resolver): persons on contact name + title fallback, chats on chat
        // name, everything else on title.
        const title = (node.title ?? "").toLowerCase();
        if (node.kind === "person") {
          const contactName = (node.jid ? this.contacts.get(node.jid)?.displayName ?? "" : "").toLowerCase();
          return contactName.includes(q) || title.includes(q);
        }
        if (node.kind === "chat") {
          // Only group chats — a DM chat folds onto its counterparty person in
          // the neighborhood, so it would duplicate the person in suggestions.
          if (!node.chatScope || !node.chatScope.endsWith("@g.us")) return false;
          const chatName = (this.chats.get(node.chatScope)?.displayName ?? "").toLowerCase();
          return chatName.includes(q);
        }
        return title.includes(q);
      })
      .sort((a, b) => b.salience - a.salience || b.citationCount - a.citationCount)
      .slice(0, cap)
      .map((node) => ({ id: node.id, label: this.memGraphLabel(node), kind: node.kind, jid: node.jid }));
  }

  async getBrainGraphNeighborhood(params: BrainGraphNeighborhoodParams): Promise<BrainGraphNeighborhoodView | null> {
    const resolved = resolveNeighborhoodParams(params);
    const anchor = this.resolveMemGraphAnchor(params);
    if (!anchor) {
      return null;
    }
    const kindSet = resolved.kinds ? new Set(resolved.kinds) : null;
    const statusSet = new Set(resolved.statuses);
    const edgeMatches = (edge: MemGraphEdge): boolean => {
      if (kindSet && !kindSet.has(edge.kind)) return false;
      if (resolved.since != null && (edge.lastSeenAtMs ?? 0) < resolved.since) return false;
      if (resolved.until != null && (edge.lastSeenAtMs ?? 0) > resolved.until) return false;
      return true;
    };
    // BFS mirror of the recursive CTE: shortest-hop reachability under the same
    // kind/time/salience/status filters, both directions, anchor exempt.
    const visited = new Map<string, { node: MemGraphNode; hop: number }>();
    visited.set(anchor.node.id, { node: anchor.node, hop: 0 });
    let frontier = [anchor.node.id];
    for (let hop = 0; hop < resolved.depth; hop += 1) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        for (const edge of this.graphEdges.values()) {
          const isSrc = edge.srcNodeId === nodeId;
          const isDst = edge.dstNodeId === nodeId;
          if (!isSrc && !isDst) continue;
          if (!edgeMatches(edge)) continue;
          const otherId = isSrc ? edge.dstNodeId : edge.srcNodeId;
          if (visited.has(otherId)) continue;
          const other = this.graphNodes.get(otherId);
          if (!other || !statusSet.has(other.status) || other.status === "merged" || other.salience < resolved.minSalience) {
            continue;
          }
          visited.set(otherId, { node: other, hop: hop + 1 });
          next.push(otherId);
        }
      }
      frontier = next;
    }
    // Deterministic discovery order + ceiling, matching the SQLite ORDER/LIMIT.
    const ordered = [...visited.values()].sort(
      (a, b) => a.hop - b.hop || b.node.salience - a.node.salience || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0)
    );
    const discoveryTruncated = ordered.length > resolved.maxDiscover;
    const nodeEntries = discoveryTruncated ? ordered.slice(0, resolved.maxDiscover) : ordered;
    const idSet = new Set(nodeEntries.map((entry) => entry.node.id));

    const edges: BrainGraphNeighborhoodEdge[] = [];
    for (const edge of this.graphEdges.values()) {
      if (!idSet.has(edge.srcNodeId) || !idSet.has(edge.dstNodeId) || !edgeMatches(edge)) {
        continue;
      }
      edges.push({
        id: edge.id,
        srcId: edge.srcNodeId,
        dstId: edge.dstNodeId,
        kind: edge.kind,
        evidenceCount: edge.evidence.size,
        firstSeenAtMs: edge.firstSeenAtMs,
        lastSeenAtMs: edge.lastSeenAtMs
      });
    }
    const personKeyByJid = new Map<string, string>();
    for (const entry of nodeEntries) {
      if (entry.node.kind === "person" && entry.node.jid) {
        personKeyByJid.set(entry.node.jid, this.personMembers.get(entry.node.jid)?.personId ?? entry.node.jid);
      }
    }
    // All display names of the person behind each JID (every linked identity,
    // even off-screen) — parity mirror of the SQLite alias map.
    const membersByPerson = new Map<string, string[]>();
    for (const [memberJid, member] of this.personMembers) {
      const bucket = membersByPerson.get(member.personId);
      if (bucket) bucket.push(memberJid);
      else membersByPerson.set(member.personId, [memberJid]);
    }
    const personAliasesByJid = new Map<string, string[]>();
    for (const jid of personKeyByJid.keys()) {
      const key = personKeyByJid.get(jid) ?? jid;
      const memberJids = !key.includes("@") ? membersByPerson.get(key) ?? [jid] : [jid];
      personAliasesByJid.set(jid, [...new Set(memberJids.map((memberJid) => this.systemEventDisplayName(memberJid) ?? memberJid))]);
    }
    const ownerPersonKeys = [
      ...new Set(this.ownerSelfJids.map((jid) => this.personMembers.get(this.canonicalJid(jid) ?? jid)?.personId ?? (this.canonicalJid(jid) ?? jid)))
    ];
    const ownerAllJids = new Set(this.ownerSelfJids.map((jid) => this.canonicalJid(jid) ?? jid));
    const ownerPersonKeySet = new Set(ownerPersonKeys);
    for (const [memberJid, member] of this.personMembers) {
      if (ownerPersonKeySet.has(member.personId)) ownerAllJids.add(memberJid);
    }
    const ownerInfo =
      this.ownerDisplayName || ownerAllJids.size > 0
        ? { name: this.ownerDisplayName ?? null, personKeys: ownerPersonKeys, selfJids: [...ownerAllJids] }
        : null;
    const walk: NeighborhoodWalk = {
      anchorId: anchor.node.id,
      redirected: anchor.redirected,
      discovered: nodeEntries.map((entry) => ({ record: this.memGraphNodeRecord(entry.node), hop: entry.hop })),
      edges,
      discoveryTruncated,
      personKeyByJid,
      personAliasesByJid,
      ownerInfo
    };
    return shapeNeighborhood(walk, resolved);
  }

  async getBrainGraphEdgeEvidence(edgeId: number): Promise<BrainGraphEdgeEvidenceView | null> {
    const edge = this.graphEdgesById.get(edgeId);
    if (!edge) {
      return null;
    }
    const endpoint = (nodeId: string): BrainGraphEdgeEvidenceView["src"] => {
      const node = this.graphNodes.get(nodeId);
      return node
        ? { id: node.id, kind: node.kind, label: this.memGraphLabel(node), jid: node.jid }
        : { id: nodeId, kind: "other", label: nodeId, jid: null };
    };
    const claimIndex = new Map<string, { kind: BrainGraphEntityClaim["kind"]; text: string; citations: BrainCitationRecord[] }>();
    for (const episode of this.brainEpisodes.values()) {
      for (const claim of episode.claims) {
        claimIndex.set(claim.id, { kind: claim.kind, text: claim.text, citations: claim.citations });
      }
    }
    const orderedEvidence = [...edge.evidence.entries()].sort(
      (a, b) => (b[1].observedAtMs ?? 0) - (a[1].observedAtMs ?? 0) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    );
    const citations: BrainGraphEdgeCitation[] = [];
    const seen = new Set<string>();
    const LIMIT = 100;
    for (const [, ev] of orderedEvidence) {
      if (citations.length >= LIMIT) break;
      if (ev.claimId) {
        const claim = claimIndex.get(ev.claimId);
        const cites = claim ? [...claim.citations].sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0)) : [];
        for (const cite of cites) {
          if (citations.length >= LIMIT) break;
          const key = `${ev.claimId}:${cite.sourceMessageKey}`;
          if (seen.has(key)) continue;
          seen.add(key);
          citations.push({
            sourceMessageKey: cite.sourceMessageKey,
            sourceChatId: cite.sourceChatId ?? null,
            chatId: cite.sourceChatId ? this.chats.get(cite.sourceChatId)?.id ?? null : null,
            messageId: cite.messageId ?? null,
            senderSourceJid: cite.senderSourceJid ?? null,
            timestampMs: cite.timestampMs ?? null,
            claimId: ev.claimId,
            claimKind: claim?.kind ?? null,
            claimText: claim?.text ?? null
          });
        }
      } else if (ev.sourceMessageKey) {
        const key = `msg:${ev.sourceMessageKey}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const message = this.messages.get(ev.sourceMessageKey);
        citations.push({
          sourceMessageKey: ev.sourceMessageKey,
          sourceChatId: message?.chatSourceId ?? null,
          chatId: message?.chatSourceId ? this.chats.get(message.chatSourceId)?.id ?? null : null,
          messageId: message?.id ?? null,
          senderSourceJid: message?.senderSourceJid ?? null,
          timestampMs: message?.timestampMs ?? ev.observedAtMs ?? null,
          claimId: null,
          claimKind: null,
          claimText: null
        });
      }
    }
    return {
      edgeId: edge.id,
      kind: edge.kind,
      src: endpoint(edge.srcNodeId),
      dst: endpoint(edge.dstNodeId),
      evidenceCount: edge.evidence.size,
      firstSeenAtMs: edge.firstSeenAtMs,
      lastSeenAtMs: edge.lastSeenAtMs,
      citations
    };
  }

  async listUnresolvedBrainGraphEntities(options: { limit?: number } = {}): Promise<BrainGraphUnresolvedEntity[]> {
    const limit = Math.max(1, Math.min(200, options.limit ?? 50));
    return [...this.graphNodes.values()]
      .filter((node) => node.kind === "person" && !node.jid && node.status !== "merged")
      .sort(
        (a, b) =>
          b.salience - a.salience ||
          (this.graphNodeClaims.get(b.id)?.size ?? 0) - (this.graphNodeClaims.get(a.id)?.size ?? 0) ||
          (b.lastSeenAtMs ?? 0) - (a.lastSeenAtMs ?? 0)
      )
      .slice(0, limit)
      .map((node) => ({
        node: this.memGraphNodeRecord(node),
        chatSourceId: node.chatScope,
        chatDisplayName: node.chatScope ? this.chats.get(node.chatScope)?.displayName ?? null : null,
        claimCount: this.graphNodeClaims.get(node.id)?.size ?? 0
      }));
  }

  // --- Brain evaluation (eval harness) — mirrors the SQLite semantics ---

  async insertBrainEvalRun(run: BrainEvalRunRecord): Promise<void> {
    this.brainEvalRuns.set(run.id, structuredClone(run));
  }

  async listBrainEvalRuns(options?: { goldenHash?: string; limit?: number }): Promise<BrainEvalRunRecord[]> {
    return structuredClone(
      [...this.brainEvalRuns.values()]
        .filter((run) => !options?.goldenHash || run.goldenHash === options.goldenHash)
        .sort((a, b) => b.ranAtMs - a.ranAtMs || b.id.localeCompare(a.id))
        .slice(0, options?.limit ?? 50)
    );
  }

  async getBrainEvalRun(id: string): Promise<BrainEvalRunRecord | null> {
    const run = this.brainEvalRuns.get(id);
    return run ? structuredClone(run) : null;
  }

  async filterExistingMessageKeys(keys: string[]): Promise<Set<string>> {
    const wanted = new Set(keys);
    const existing = new Set<string>();
    for (const message of this.messages.values()) {
      if (wanted.has(message.sourceMessageKey)) {
        existing.add(message.sourceMessageKey);
      }
    }
    return existing;
  }

  async listClaimsForGrading(options: { perModel: number; includeGraded?: boolean }): Promise<BrainGradingSample> {
    const perModel = Math.max(1, Math.floor(options.perModel));
    type Eligible = { episode: BrainEpisodeRecord; claim: BrainEpisodeRecord["claims"][number] };
    const eligible: Eligible[] = [];
    for (const episode of this.brainEpisodes.values()) {
      if (episode.status !== "current" || episode.generator !== "model") {
        continue;
      }
      for (const claim of episode.claims) {
        eligible.push({ episode, claim });
      }
    }
    // Ungraded first, then claim-UUID order — same stable shuffle as SQLite.
    eligible.sort((a, b) => {
      const modelOrder = (a.episode.model ?? "unknown").localeCompare(b.episode.model ?? "unknown");
      if (modelOrder !== 0) return modelOrder;
      const aGraded = this.brainClaimGrades.has(a.claim.id) ? 1 : 0;
      const bGraded = this.brainClaimGrades.has(b.claim.id) ? 1 : 0;
      if (aGraded !== bGraded) return aGraded - bGraded;
      return a.claim.id.localeCompare(b.claim.id);
    });
    const totals = new Map<string, { eligible: number; graded: number }>();
    for (const entry of eligible) {
      const model = entry.episode.model ?? "unknown";
      const total = totals.get(model) ?? { eligible: 0, graded: 0 };
      total.eligible += 1;
      if (this.brainClaimGrades.has(entry.claim.id)) {
        total.graded += 1;
      }
      totals.set(model, total);
    }
    const byModel = new Map<string, BrainGradingSampleClaim[]>();
    for (const entry of eligible) {
      const model = entry.episode.model ?? "unknown";
      const graded = this.brainClaimGrades.has(entry.claim.id);
      if (graded && !options.includeGraded) {
        continue;
      }
      const bucket = byModel.get(model) ?? [];
      if (bucket.length >= perModel) {
        continue;
      }
      bucket.push({
        claimId: entry.claim.id,
        episodeId: entry.episode.id,
        chatSourceId: entry.episode.chatSourceId,
        chatDisplayName: entry.episode.chatDisplayName ?? null,
        model: entry.episode.model,
        extractionVersion: entry.episode.extractionVersion,
        kind: entry.claim.kind,
        confidence: entry.claim.confidence,
        text: entry.claim.text,
        eventAtMs: entry.claim.eventAtMs,
        grade: this.brainClaimGrades.get(entry.claim.id)?.grade ?? null,
        citations: entry.claim.citations.map((citation): BrainGradingCitation => {
          const message = [...this.messages.values()].find((candidate) => candidate.sourceMessageKey === citation.sourceMessageKey);
          const text = message ? message.body?.trim() || message.caption?.trim() || `[${message.messageType}]` : null;
          return {
            sourceMessageKey: citation.sourceMessageKey,
            timestampMs: citation.timestampMs,
            senderSourceJid: citation.senderSourceJid,
            text,
            deleted: Boolean(message?.isDeleted),
            present: Boolean(message)
          };
        })
      });
      byModel.set(model, bucket);
    }
    return {
      perModel,
      models: [...totals.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([model, total]) => ({
          model,
          eligibleClaims: total.eligible,
          gradedClaims: total.graded,
          claims: byModel.get(model) ?? []
        }))
    };
  }

  async upsertBrainClaimGrade(claimId: string, grade: BrainClaimGradeValue): Promise<BrainClaimGradeRecord> {
    for (const episode of this.brainEpisodes.values()) {
      const claim = episode.claims.find((candidate) => candidate.id === claimId);
      if (!claim) {
        continue;
      }
      const record: BrainClaimGradeRecord = {
        claimId,
        grade,
        gradedAtMs: Date.now(),
        episodeId: episode.id,
        chatSourceId: episode.chatSourceId,
        generator: episode.generator,
        model: episode.model,
        extractionVersion: episode.extractionVersion,
        claimKind: claim.kind,
        claimConfidence: claim.confidence,
        claimText: claim.text,
        citationKeys: claim.citations.map((citation) => citation.sourceMessageKey)
      };
      this.brainClaimGrades.set(claimId, record);
      return structuredClone(record);
    }
    throw new Error("No claim with that id — it may have been superseded and wiped; refresh the grading sample.");
  }

  async getBrainModelQualityAggregates(): Promise<BrainModelQualityAggregate[]> {
    const buckets = new Map<string, BrainModelQualityAggregate>();
    const bucket = (model: string, extractionVersion: number): BrainModelQualityAggregate => {
      const key = `${model}|${extractionVersion}`;
      let entry = buckets.get(key);
      if (!entry) {
        entry = {
          model,
          extractionVersion,
          modelEpisodes: 0,
          fallbackEpisodes: 0,
          attempted: 0,
          fallbackRate: null,
          claims: 0,
          unanchoredWarnings: 0,
          validationErrors: 0,
          grades: { supported: 0, partial: 0, unsupported: 0, unclear: 0 },
          gradedTotal: 0,
          strictPrecision: null
        };
        buckets.set(key, entry);
      }
      return entry;
    };
    const episodeBucket = (episode: BrainEpisodeRecord): BrainModelQualityAggregate | null => {
      if (episode.generator === "model" && episode.model) {
        return bucket(episode.model, episode.extractionVersion);
      }
      if (episode.generator === "extractive" && episode.fallbackReason != null) {
        return bucket(episode.attemptedModel ?? "unknown", episode.extractionVersion);
      }
      return null;
    };
    for (const episode of this.brainEpisodes.values()) {
      const entry = episodeBucket(episode);
      if (!entry) {
        continue;
      }
      if (episode.generator === "model") {
        entry.modelEpisodes += 1;
        entry.claims += episode.claims.length;
      } else {
        entry.fallbackEpisodes += 1;
      }
    }
    for (const issue of this.brainIssues) {
      const episode = issue.episodeId ? this.brainEpisodes.get(issue.episodeId) : undefined;
      if (!episode) {
        continue;
      }
      const entry = episodeBucket(episode);
      if (!entry) {
        continue;
      }
      if (issue.code === "unanchored") {
        entry.unanchoredWarnings += 1;
      }
      if (issue.severity === "error") {
        entry.validationErrors += 1;
      }
    }
    for (const grade of this.brainClaimGrades.values()) {
      bucket(grade.model ?? "unknown", grade.extractionVersion).grades[grade.grade] += 1;
    }
    for (const entry of buckets.values()) {
      entry.attempted = entry.modelEpisodes + entry.fallbackEpisodes;
      entry.fallbackRate = entry.attempted > 0 ? entry.fallbackEpisodes / entry.attempted : null;
      entry.gradedTotal = entry.grades.supported + entry.grades.partial + entry.grades.unsupported + entry.grades.unclear;
      const gradable = entry.grades.supported + entry.grades.partial + entry.grades.unsupported;
      entry.strictPrecision = gradable > 0 ? entry.grades.supported / gradable : null;
    }
    return [...buckets.values()].sort(
      (a, b) => b.extractionVersion - a.extractionVersion || b.attempted - a.attempted || a.model.localeCompare(b.model)
    );
  }

  async getBrainMediaGapSummary(): Promise<BrainMediaGapSummary[]> {
    const counts = new Map<string, BrainMediaGapSummary>();
    for (const episode of this.brainEpisodes.values()) {
      if (episode.status !== "current") {
        continue;
      }
      for (const gap of episode.mediaGaps) {
        const key = `${gap.modality}:${gap.impact}`;
        const entry = counts.get(key) ?? { modality: gap.modality, impact: gap.impact, count: 0 };
        entry.count += 1;
        counts.set(key, entry);
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  }

  async listBrainEpisodesWithMediaGaps(options: { impact: BrainMediaGapImpact; limit: number }): Promise<BrainEpisodeRecord[]> {
    return structuredClone(
      [...this.brainEpisodes.values()]
        .filter((episode) => episode.status === "current" && episode.mediaGaps.some((gap) => gap.impact === options.impact))
        .sort((a, b) => b.endAtMs - a.endAtMs)
        .slice(0, options.limit)
    );
  }

  async recordBrainValidationIssues(issues: BrainValidationIssueInput[]): Promise<void> {
    for (const issue of issues) {
      this.brainIssues.push({
        id: this.brainIssues.length + 1,
        runId: issue.runId ?? null,
        chatSourceId: issue.chatSourceId ?? null,
        episodeId: issue.episodeId ?? null,
        claimSequence: issue.claimSequence ?? null,
        docId: issue.docId ?? null,
        code: issue.code,
        severity: issue.severity,
        detail: issue.detail ?? null,
        createdAt: new Date().toISOString()
      });
    }
  }

  async listBrainValidationIssues(options?: {
    episodeId?: string | null;
    docId?: string | null;
    runId?: string | null;
    limit?: number;
  }): Promise<BrainValidationIssueRecord[]> {
    return structuredClone(
      [...this.brainIssues]
        .filter((issue) => !options?.episodeId || issue.episodeId === options.episodeId)
        .filter((issue) => !options?.docId || issue.docId === options.docId)
        .filter((issue) => !options?.runId || issue.runId === options.runId)
        .reverse()
        .slice(0, options?.limit ?? 100)
    );
  }

  async getBrainValidationIssueSummary(): Promise<BrainValidationIssueSummary> {
    const summary: BrainValidationIssueSummary = { error: 0, warning: 0, info: 0 };
    for (const issue of this.brainIssues) {
      summary[issue.severity] += 1;
    }
    return summary;
  }

  async listBrainTopicVocabulary(chatSourceId: string, limit: number): Promise<string[]> {
    const chatCounts = new Map<string, number>();
    const globalCounts = new Map<string, number>();
    for (const episode of this.brainEpisodes.values()) {
      for (const topic of episode.topics) {
        globalCounts.set(topic, (globalCounts.get(topic) ?? 0) + 1);
        if (episode.chatSourceId === chatSourceId) {
          chatCounts.set(topic, (chatCounts.get(topic) ?? 0) + 1);
        }
      }
    }
    const byUsage = (counts: Map<string, number>) =>
      [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([title]) => title);
    const seen = new Set<string>();
    const titles: string[] = [];
    for (const title of [...byUsage(chatCounts), ...byUsage(globalCounts), ...this.brainTopics.values()]) {
      const key = title.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        titles.push(title);
      }
      if (titles.length >= limit) {
        break;
      }
    }
    return titles;
  }

  async listBrainEpisodeProjections(options?: {
    limit?: number;
    offset?: number;
  }): Promise<Array<{ id: string; chatSourceId: string; chatDisplayName: string | null; startAtMs: number; markdown: string }>> {
    return [...this.brainEpisodes.values()]
      .filter((episode) => episode.status === "current" && episode.markdown !== "")
      .sort((a, b) => a.startAtMs - b.startAtMs || (a.id < b.id ? -1 : 1))
      .slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? 1000))
      .map((episode) => ({
        id: episode.id,
        chatSourceId: episode.chatSourceId,
        // Read-time, so a chat renamed since commit projects under its new name.
        chatDisplayName: this.chats.get(episode.chatSourceId)?.displayName ?? null,
        startAtMs: episode.startAtMs,
        markdown: episode.markdown
      }));
  }

  async updateBrainEpisodeMarkdown(episodeId: string, markdown: string): Promise<void> {
    const episode = this.brainEpisodes.get(episodeId);
    if (episode) {
      episode.markdown = markdown;
    }
  }

  async listBrainEpisodes(options: {
    chatSourceId?: string | null;
    episodeId?: string;
    status?: BrainEpisodeRecord["status"];
    generator?: BrainEpisodeGenerator;
    endAtOrBeforeMs?: number;
    limit: number;
  }): Promise<BrainEpisodeRecord[]> {
    return structuredClone(
      [...this.brainEpisodes.values()]
        .filter((episode) => !options.episodeId || episode.id === options.episodeId)
        .filter((episode) => !options.chatSourceId || episode.chatSourceId === options.chatSourceId)
        .filter((episode) => !options.status || episode.status === options.status)
        .filter((episode) => !options.generator || episode.generator === options.generator)
        .filter((episode) => options.endAtOrBeforeMs == null || episode.endAtMs <= options.endAtOrBeforeMs)
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
      const signalAnchored = episode.archiveSignalAnchors?.some((anchor) => keys.has(anchor.sourceMessageKey));
      if (!cited && !signalAnchored) {
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

  private async markStaleEpisodesForQuotedReplies(sourceMessageKeys: string[]): Promise<number> {
    const keys = new Set(sourceMessageKeys.filter(Boolean));
    if (keys.size === 0) return 0;
    const tasks: BrainTaskInput[] = [];
    let marked = 0;
    for (const episode of this.brainEpisodes.values()) {
      if (episode.status !== "current" || !episode.quotedReplyAnchors.some((anchor) => keys.has(anchor.replySourceMessageKey))) {
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
      linkPreview: (() => {
        const preview = this.linkPreviews.get(message.sourceMessageKey);
        return preview
          ? {
              title: preview.title,
              description: preview.description,
              canonicalUrl: preview.canonicalUrl,
              hasThumbnail: Boolean(preview.thumbnail?.length)
            }
          : null;
      })(),
      isForwarded: Boolean(message.isForwarded),
      quotedSourceMessageId: message.quotedSourceMessageId ?? null,
      quotedSnapshot: this.quoteSummary(message),
      structuredSignals: this.structuredSignals(message),
      reactions: [],
      // Label provenance (contract v2): the label above resolved from the
      // self-set push name because no saved display name exists.
      senderNameIsPushName: Boolean(!sender?.displayName?.trim() && sender?.pushName?.trim())
    };
  }

  private structuredSignals(message: MessageRecord & { id: number }): MessageStructuredSignals | null {
    const location = this.locations.get(message.sourceMessageKey) ?? null;
    const vcards = [...this.vcards.values()]
      .filter((row) => row.sourceMessageKey === message.sourceMessageKey)
      .sort((a, b) => a.cardIndex - b.cardIndex)
      .map((row) => ({ displayName: row.displayName, resolvedJid: row.resolvedJid }));
    const deletion = this.deletions.get(message.sourceMessageKey) ?? null;
    const edits = [...this.editEvents.values()].filter((row) => row.sourceMessageKey === message.sourceMessageKey);
    const interpretations = [...this.mediaInterpretations.values()]
      .filter((row) => row.sourceMessageKey === message.sourceMessageKey)
      .sort((a, b) => a.segmentIndex - b.segmentIndex)
      .map((row) => ({ kind: row.kind, text: row.text, segmentIndex: row.segmentIndex }));
    const revisions = this.editRevisions.get(message.sourceMessageKey) ?? [];
    const preview = this.linkPreviews.has(message.sourceMessageKey);
    const mentionedJids = message.mentionedJids ?? [];
    const captureVersion = Math.max(
      location?.captureVersion ?? 0,
      ...[...this.vcards.values()].filter((row) => row.sourceMessageKey === message.sourceMessageKey).map((row) => row.captureVersion),
      deletion?.captureVersion ?? 0,
      ...edits.map((row) => row.captureVersion),
      ...[...this.mediaInterpretations.values()].filter((row) => row.sourceMessageKey === message.sourceMessageKey).map((row) => row.captureVersion),
      preview || mentionedJids.length ? 1 : 0
    );
    if (!location && vcards.length === 0 && !deletion && edits.length === 0 && interpretations.length === 0 && !preview && mentionedJids.length === 0) return null;
    return {
      mentionedJids: [...mentionedJids],
      location: location ? { latitude: location.latitude, longitude: location.longitude, name: location.name, address: location.address, isLive: location.isLive } : null,
      vcards,
      deletion: deletion ? { revokedByJid: deletion.revokedByJid, revokedAtMs: deletion.observedAtMs } : null,
      edit: edits.length ? { observedAtMs: edits.reduce<number | null>((latest, row) => Math.max(latest ?? 0, row.observedAtMs ?? 0) || null, null), hasHeldRevision: revisions.length > 0 } : null,
      mediaInterpretations: interpretations,
      captureVersion: captureVersion || null
    };
  }

  private systemEventsForMessage(message: MessageRecord & { id: number }) {
    const sourceMessageKey = message.sourceMessageKey;
    return summarizeSystemEvents({
      numberChanges: [...this.numberChanges.values()].filter((record) => record.sourceMessageKey === sourceMessageKey),
      membershipEvents: [...this.membershipEvents.values()].filter((record) => record.sourceMessageKey === sourceMessageKey),
      chatMetadataHistory: [...this.chatMetadataHistory.values()].filter((record) => record.sourceMessageKey === sourceMessageKey),
      displayNameForJid: (jid) => this.systemEventDisplayName(jid)
    });
  }

  private systemEventDetails(
    message: MessageRecord & { id: number },
    observationsFor: (factKey: string, family: import("../../shared/types").ArchiveSignalObservation["family"]) => import("../../shared/types").ArchiveSignalObservation[]
  ): MessageDetail["systemEvents"] {
    const numberChanges = [...this.numberChanges.values()].filter((record) => record.sourceMessageKey === message.sourceMessageKey);
    const membershipEvents = [...this.membershipEvents.values()].filter((record) => record.sourceMessageKey === message.sourceMessageKey);
    const chatMetadataHistory = [...this.chatMetadataHistory.values()].filter((record) => record.sourceMessageKey === message.sourceMessageKey);
    const details: MessageDetail["systemEvents"] = [];
    const detailLabelForJid = (jid: string | null) => this.systemEventDisplayName(jid) ?? "Unknown";
    for (const record of numberChanges) {
      const summary = summarizeSystemEvents({ numberChanges: [record], membershipEvents: [], chatMetadataHistory: [], displayNameForJid: (jid) => this.systemEventDisplayName(jid) })[0];
      if (summary) details.push({ kind: "number_change", eventKey: record.eventKey, summary: summary.summary, actorJid: record.actorJid, actorLabel: detailLabelForJid(record.actorJid), participantJid: null, participantLabel: null, oldJid: record.oldJid, oldIdentityLabel: detailLabelForJid(record.oldJid), newJid: record.newJid, newIdentityLabel: detailLabelForJid(record.newJid), oldValue: null, newValue: null, action: null, field: null, occurredAtMs: record.observedAtMs, rawType: null, rawParameters: null, observations: observationsFor(record.eventKey, "number_change") });
    }
    for (const record of membershipEvents) {
      const summary = summarizeSystemEvents({ numberChanges: [], membershipEvents: [record], chatMetadataHistory: [], displayNameForJid: (jid) => this.systemEventDisplayName(jid) })[0];
      if (summary) details.push({ kind: "membership", eventKey: record.eventKey, summary: summary.summary, actorJid: record.actorJid, actorLabel: detailLabelForJid(record.actorJid), participantJid: record.participantJid, participantLabel: detailLabelForJid(record.participantJid), oldJid: null, oldIdentityLabel: null, newJid: null, newIdentityLabel: null, oldValue: record.oldRole ?? null, newValue: record.newRole ?? null, action: record.action, field: null, occurredAtMs: record.observedAtMs, rawType: record.rawType ?? null, rawParameters: record.rawParameters ?? null, observations: observationsFor(record.eventKey, "membership_event") });
    }
    for (const record of chatMetadataHistory) {
      const summary = summarizeSystemEvents({ numberChanges: [], membershipEvents: [], chatMetadataHistory: [record], displayNameForJid: (jid) => this.systemEventDisplayName(jid) })[0];
      if (summary) details.push({ kind: "chat_metadata", eventKey: record.eventKey, summary: summary.summary, actorJid: record.actorJid, actorLabel: detailLabelForJid(record.actorJid), participantJid: null, participantLabel: null, oldJid: null, oldIdentityLabel: null, newJid: null, newIdentityLabel: null, oldValue: record.oldValue, newValue: record.newValue, action: null, field: record.field, occurredAtMs: record.observedAtMs, rawType: record.rawType ?? null, rawParameters: record.rawParameters ?? null, observations: observationsFor(record.eventKey, "chat_metadata") });
    }
    return details.sort((a, b) => (a.occurredAtMs ?? 0) - (b.occurredAtMs ?? 0));
  }

  private systemEventDisplayName(jid: string | null): string | null {
    if (jid === "me") {
      return "You";
    }
    const canonical = jid ? this.canonicalJid(jid) ?? jid : null;
    const contact = canonical ? this.contacts.get(canonical) : null;
    return resolveDisplayLabel({ displayName: contact?.displayName, pushName: contact?.pushName, phoneNumber: contact?.phoneNumber, jid: canonical });
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
        reactorDisplayName: contact?.displayName?.trim() || contact?.pushName?.trim() || contact?.phoneNumber || displayPhoneFromJid(reactorJid),
        reactorNameIsPushName: Boolean(!contact?.displayName?.trim() && contact?.pushName?.trim())
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
