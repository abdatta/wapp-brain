import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ArchiveSignalBatch,
  ArchiveSignalKind,
  ArchiveSignalAnchor,
  BrainBackfillDbStats,
  BrainBackfillModelSpend,
  BrainChatBacklogItem,
  BrainClaimEntityRecord,
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
  BrainDocRevisionSummary,
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
  BrainGraphEdgeKind,
  BrainGraphEdgeView,
  BrainGraphEdgeCitation,
  BrainGraphEdgeEvidenceView,
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
  BrainLifecycleDetailCandidate,
  BrainLifecycleEventRecord,
  BrainLifecycleItem,
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
  BrainRunDocEffect,
  BrainRunEffectCounts,
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
  BrainMediaGapImpact,
  BrainMediaGapRecord,
  BrainMediaGapSummary,
  BrainResolutionDebtIdentity,
  BrainResolutionDebtSummary,
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
  GoogleContactCandidate,
  GroupMembershipEventRecord,
  GroupMembershipPeriodRecord,
  IdentityNumberChangeRecord,
  IdentityRecentMedia,
  IdentityRecentMessage,
  IdentityRepairResult,
  ImportRunSummary,
  ImportTotals,
  ImportWarning,
  LinkPreviewSummary,
  LiveChatCheckpointRecord,
  LiveEventReceiptRecord,
  LiveGapReason,
  LiveGapStatus,
  LiveGapWindowRecord,
  LiveHealthState,
  LiveMaintainerStatusSummary,
  LiveMessageUpdateRecord,
  LiveMessageUpdateResult,
  LiveSessionSummary,
  LiveSyncRunSummary,
  LiveSyncTotals,
  MediaAssetRecord,
  MediaAvailabilityState,
  MediaDownloadDescriptor,
  MediaDownloadQueueRecord,
  MediaDownloadStatus,
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
  QuotedReplyAnchor,
  ParticipantRecord,
  RecoveryAnchorRecord,
  RetainedPayloadRecord,
  SearchIndexState,
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
import { SEARCH_HIGHLIGHT_END, SEARCH_HIGHLIGHT_START } from "../../shared/types";
import { config } from "../config";
import { baselineFromStatus } from "../live/baseline";
import { messageIdFromKey, messageKey } from "../identity/keys";
import { applyMentionLabels, appliedMentionLabels, extractMentionDigits, mentionJidCandidates } from "../identity/mentions";
import { mergeInteractionMetadata } from "./interactions";
import { buildMessageEditTimeline, summarizeStructuredSignals, summarizeSystemEvents } from "./signalSummary";
import { interpretMessage } from "../interpretation/messageInterpretation";
import { displayPhoneFromJid, isMaskedNumberLabel, normalizeJid, phoneFromJid, resolveDisplayLabel } from "../import/jid";
import { disambiguateLabels } from "../persons/disambiguate";
import { personDisplayLabelFromMembers } from "../persons/label";
import { getMemoryProviderStatus } from "../memory/provider";
import { normalizeOwnerSelfInput } from "../identity/ownerSelf";
import {
  chatNaturalKey,
  computeGraphSalience,
  deriveEpisodeGraph,
  engagementFactorFromAggregates,
  graphDormancyThreshold,
  normalizeGraphName,
  parseGraphPayload,
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
import { PublicError } from "../privacy";
import { termAliasSeedRows } from "../search/aliasSeed";
import {
  attachAliasVariants,
  buildBasePlans,
  buildDroppedPlans,
  countTermCoverage,
  dfProbesForToken,
  normalizeTerm,
  normalizedWords,
  tokenizeSearchQuery,
  tokenLenientlyMatchesWords,
  type PlanAlternative,
  type QueryToken,
  type TierPlan
} from "../search/relaxation";
import type { ArchiveRepository, ArchiveRestorePoint } from "./repository";

const TOOL_VERSION = "0.1.0";
// Bumped when identity keying changes incompatibly; archives with data written
// under an older scheme are refused (user-approved: re-import instead of migrate).
const IDENTITY_VERSION = "2";
const LEGACY_ARCHIVE_MESSAGE =
  "This archive predates canonical identity keys. Run a Clear-and-replace import of your latest backup (or delete the archive file and run init-db), then re-pair live sync.";
const SQLITE_IN_QUERY_BATCH_SIZE = 500;
const ARCHIVE_TABLES = [
  "import_runs",
  "identity_links",
  "contacts",
  "chats",
  "chat_participants",
  "messages",
  "message_quoted_snapshots",
  "message_mentions",
  "identity_number_changes",
  "group_membership_periods",
  "group_membership_events",
  "chat_metadata_history",
  "message_locations",
  "message_location_observations",
  "message_vcards",
  "message_edit_events",
  "message_deletions",
  "message_media_interpretations",
  "engagement_aggregates",
  "archive_signal_observations",
  "import_warnings",
  "live_sessions",
  "live_sync_runs",
  "live_chat_checkpoints",
  "live_gap_windows",
  "live_event_receipts",
  "live_message_updates",
  "memory_runs",
  "memory_source_windows",
  "memory_evidence_packs",
  "memory_pages",
  "memory_page_revisions",
  "memory_citations",
  "memory_validation_issues",
  "memory_job_locks",
  "brain_chat_watermarks",
  "brain_tasks",
  "brain_runs",
  "brain_llm_ledger",
  "brain_episodes",
  "brain_claims",
  "brain_citations",
  "brain_claim_entities",
  "brain_episode_signal_anchors",
  "brain_topics",
  "brain_episode_topics",
  "brain_validation_issues",
  "brain_media_gaps",
  "persons",
  "person_members",
  "person_link_suppressions",
  "person_suggestions",
  "person_link_events",
  "person_redirects",
  "google_contact_groups"
] as const;
const DELETE_TABLE_ORDER = [
  "identity_links",
  "person_members",
  "persons",
  "person_link_suppressions",
  "person_suggestions",
  "person_link_events",
  "person_redirects",
  "google_contact_groups",
  "brain_media_gaps",
  "brain_validation_issues",
  "brain_episode_topics",
  "brain_topics",
  "brain_claim_entities",
  "brain_citations",
  "brain_claims",
  "brain_episode_signal_anchors",
  "brain_episodes",
  "brain_llm_ledger",
  "brain_runs",
  "brain_tasks",
  "brain_chat_watermarks",
  "memory_job_locks",
  "memory_validation_issues",
  "memory_citations",
  "memory_page_revisions",
  "memory_pages",
  "memory_evidence_packs",
  "memory_source_windows",
  "memory_runs",
  "live_message_updates",
  "live_event_receipts",
  "live_gap_windows",
  "live_chat_checkpoints",
  "live_sync_runs",
  "live_sessions",
  "engagement_aggregates",
  "archive_signal_observations",
  "message_media_interpretations",
  "message_deletions",
  "message_edit_events",
  "message_vcards",
  "message_location_observations",
  "message_locations",
  "chat_metadata_history",
  "group_membership_events",
  "group_membership_periods",
  "identity_number_changes",
  "message_mentions",
  "message_quoted_snapshots",
  "messages",
  "chat_participants",
  "chats",
  "contacts",
  "import_warnings",
  "import_runs"
] as const;

const LIVE_SESSION_STATUSES = ["not_configured", "pairing", "connected", "disconnected", "stopped", "error", "logged_out"] as const;
const MESSAGE_UPDATE_TYPES = ["delete", "edit", "reaction", "poll_vote", "event_response", "receipt", "call", "unknown"] as const;

function stableSignalFactKey(family: string, parts: Array<string | number | null | undefined>): string {
  return `${family}:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

function isSyntheticSystemAnchor(sourceMessageKey: string | null | undefined): boolean {
  return Boolean(sourceMessageKey && sourceMessageKey.includes("live-system-"));
}

// Shared per-message media-state projection: the asset (bytes stored) and the
// download-queue row, from which every read path derives the same honest
// availability. Expects the messages table aliased as `m`.
const MEDIA_STATE_SELECT = `ma.id AS media_asset_id, ma.mime_type AS media_mime, ma.byte_size AS media_byte_size,
                ma.width AS media_width, ma.height AS media_height, ma.duration_ms AS media_duration_ms,
                ma.is_view_once AS media_asset_view_once, (ma.thumbnail IS NOT NULL) AS media_has_thumbnail,
                q.status AS media_queue_status, q.is_view_once AS media_queue_view_once`;
const MEDIA_STATE_JOINS = `LEFT JOIN media_assets ma
           ON ma.id = (SELECT id FROM media_assets pick WHERE pick.message_key = m.source_message_key ORDER BY pick.id ASC LIMIT 1)
         LEFT JOIN media_download_queue q ON q.message_key = m.source_message_key`;
const QUOTED_SNAPSHOT_SELECT = `m.quoted_source_message_id AS reply_quoted_source_message_id,
                qs.quoted_source_message_id, qs.quoted_source_chat_id, qs.quoted_sender_source_jid,
                qs.quoted_from_me, qs.timestamp_ms AS quoted_timestamp_ms, qs.message_type AS quoted_message_type,
                qs.body AS quoted_body, qs.caption AS quoted_caption, qs.media_mime_type AS quoted_media_mime_type,
                qs.media_name AS quoted_media_name, qs.location_json AS quoted_location_json, qs.vcard_json AS quoted_vcard_json,
                qs.mentioned_jids_json AS quoted_mentioned_jids_json, (qs.thumbnail IS NOT NULL) AS quoted_has_thumbnail,
                ${contactLabelSql("qc.")} AS quoted_sender_display_name,
                ${labelIsPushNameSql("qc.")} AS quoted_sender_name_is_push_name,
                (SELECT original.id FROM messages original
                   WHERE original.chat_id = m.chat_id AND original.source_message_id = qs.quoted_source_message_id
                     AND (qs.quoted_source_chat_id IS NULL OR qs.quoted_source_chat_id = (
                       SELECT source_chat_id FROM chats reply_chat WHERE reply_chat.id = m.chat_id
                     ))
                   LIMIT 1) AS quoted_original_message_id,
                (SELECT original.id FROM messages original
                   WHERE original.chat_id = m.chat_id AND original.source_message_id = m.quoted_source_message_id
                   LIMIT 1) AS legacy_quoted_original_message_id,
                (SELECT COALESCE(NULLIF(original.body, ''), NULLIF(original.caption, '')) FROM messages original
                   WHERE original.chat_id = m.chat_id AND original.source_message_id = m.quoted_source_message_id
                   LIMIT 1) AS legacy_quoted_text,
                (SELECT original.sender_source_jid FROM messages original
                   WHERE original.chat_id = m.chat_id AND original.source_message_id = m.quoted_source_message_id
                   LIMIT 1) AS legacy_quoted_sender_source_jid,
                (SELECT ${contactLabelSql("legacy_contact.")} FROM messages original
                   LEFT JOIN contacts legacy_contact ON legacy_contact.source_jid = original.sender_source_jid
                   WHERE original.chat_id = m.chat_id AND original.source_message_id = m.quoted_source_message_id
                   LIMIT 1) AS legacy_quoted_sender_display_name,
                (SELECT ${labelIsPushNameSql("legacy_contact.")} FROM messages original
                   LEFT JOIN contacts legacy_contact ON legacy_contact.source_jid = original.sender_source_jid
                   WHERE original.chat_id = m.chat_id AND original.source_message_id = m.quoted_source_message_id
                   LIMIT 1) AS legacy_quoted_sender_name_is_push_name,
                (SELECT original.from_me FROM messages original
                   WHERE original.chat_id = m.chat_id AND original.source_message_id = m.quoted_source_message_id
                   LIMIT 1) AS legacy_quoted_from_me`;
const QUOTED_SNAPSHOT_JOINS = `LEFT JOIN message_quoted_snapshots qs ON qs.reply_message_key = m.source_message_key
         LEFT JOIN contacts qc ON qc.source_jid = qs.quoted_sender_source_jid`;

// The one contact display-label expression, shared by every identity-resolution
// query so they can never diverge: saved name → push name → the full +E.164
// number formatted from the stored phone record. Masked-number placeholders are
// nulled at ingest and by the demask backfill, so this never emits a mask. When
// only a phone-form JID (no stored number) is known it yields NULL; callers add
// `?? displayPhoneFromJid(jid)`, which renders +E.164 from the JID, and LID-only
// identities fall through to the explicit unresolved state. `alias` prefixes the
// columns (e.g. "c." for a joined contacts row; "" for a bare contacts query).
function contactLabelSql(alias = ""): string {
  const phone = `${alias}phone_number`;
  return `COALESCE(
                NULLIF(TRIM(COALESCE(${alias}display_name, '')), ''),
                NULLIF(TRIM(COALESCE(${alias}push_name, '')), ''),
                CASE WHEN NULLIF(TRIM(COALESCE(${phone}, '')), '') IS NOT NULL
                     THEN '+' || REPLACE(REPLACE(REPLACE(TRIM(${phone}), '+', ''), ' ', ''), '-', '')
                     ELSE NULL END)`;
}

// Label provenance: true when contactLabelSql's result came from the self-set
// push name (no saved display name). The brain marks such labels ~name and
// stamps the JID per episode for later repair (contract v2, D12).
function labelIsPushNameSql(alias = ""): string {
  return `(NULLIF(TRIM(COALESCE(${alias}display_name, '')), '') IS NULL
           AND NULLIF(TRIM(COALESCE(${alias}push_name, '')), '') IS NOT NULL)`;
}

// The full thread-view row projection, shared by offset paging and
// anchor-centered context windows.
function messageListSelectSql(whereClause: string, orderClause: string, limitClause: string): string {
  return `SELECT m.id, m.source_message_key, m.source_message_id,
                ${contactLabelSql("c.")} AS sender_display_name,
                m.sender_source_jid, m.timestamp_ms, m.sent_at, m.direction, m.message_type, m.body, m.caption,
                m.has_media, m.media_mime_type, m.media_name, m.is_deleted, m.is_forwarded, m.is_starred,
                m.source_table,
                COALESCE(json_extract(m.raw_metadata_json, '$.edited'), 0) AS edited_flag,
                (SELECT COUNT(*) FROM message_edit_revisions r WHERE r.message_key = m.source_message_key) AS edit_revision_count,
                ${MEDIA_STATE_SELECT},
                lp.title AS preview_title, lp.description AS preview_description, lp.canonical_url AS preview_url,
                (lp.thumbnail IS NOT NULL) AS preview_has_thumbnail
                ,${QUOTED_SNAPSHOT_SELECT}
         FROM messages m
         LEFT JOIN contacts c ON c.source_jid = m.sender_source_jid
         ${MEDIA_STATE_JOINS}
         LEFT JOIN message_link_previews lp ON lp.message_key = m.source_message_key
         ${QUOTED_SNAPSHOT_JOINS}
         ${whereClause}
         ${orderClause}
         ${limitClause}`;
}

interface SqliteMediaStateColumns {
  has_media: number;
  source_table: string;
  media_asset_id: number | null;
  media_mime?: string | null;
  media_byte_size?: number | null;
  media_width?: number | null;
  media_height?: number | null;
  media_duration_ms?: number | null;
  media_asset_view_once?: number | null;
  media_has_thumbnail?: number | null;
  media_queue_status: string | null;
  media_queue_view_once?: number | null;
}

// One derivation of availability for every consumer: stored beats everything;
// queued work reports its live state; otherwise the absence is explained by
// where the message came from (live → not captured while offline; backup →
// missing from the import folder).
function deriveMediaAvailability(row: SqliteMediaStateColumns): MediaAvailabilityState | null {
  if (row.media_asset_id != null) {
    return "stored";
  }
  if (!row.has_media) {
    return null;
  }
  switch (row.media_queue_status) {
    case "pending":
      return "pending";
    case "downloading":
    case "retry":
      return "downloading";
    case "failed":
    case "expired_unrecoverable":
      return "expired_unrecoverable";
  }
  return row.source_table.startsWith("wa-web") ? "not_captured" : "import_missing";
}

function deriveMediaSummary(row: SqliteMediaStateColumns, messageType: string): MessageMediaSummary | null {
  const availability = deriveMediaAvailability(row);
  if (!availability) {
    return null;
  }
  const isViewOnceType = messageType.startsWith("view_once");
  if (availability === "stored") {
    return {
      availability,
      assetId: Number(row.media_asset_id),
      mimeType: row.media_mime ?? null,
      byteSize: nullableNumber(row.media_byte_size),
      width: nullableNumber(row.media_width),
      height: nullableNumber(row.media_height),
      durationMs: nullableNumber(row.media_duration_ms),
      hasThumbnail: Boolean(row.media_has_thumbnail),
      isViewOnce: Boolean(row.media_asset_view_once) || isViewOnceType
    };
  }
  return {
    availability,
    assetId: null,
    mimeType: null,
    byteSize: null,
    width: null,
    height: null,
    durationMs: null,
    hasThumbnail: false,
    isViewOnce: Boolean(row.media_queue_view_once) || isViewOnceType
  };
}

type QuotedSnapshotRow = {
  reply_quoted_source_message_id?: string | null;
  quoted_source_message_id?: string | null;
  quoted_source_chat_id?: string | null;
  quoted_sender_source_jid?: string | null;
  quoted_sender_display_name?: string | null;
  quoted_sender_name_is_push_name?: number | null;
  quoted_from_me?: number | null;
  quoted_timestamp_ms?: number | null;
  quoted_message_type?: string | null;
  quoted_body?: string | null;
  quoted_caption?: string | null;
  quoted_media_mime_type?: string | null;
  quoted_media_name?: string | null;
  quoted_location_json?: string | null;
  quoted_vcard_json?: string | null;
  quoted_mentioned_jids_json?: string | null;
  quoted_has_thumbnail?: number | null;
  quoted_original_message_id?: number | null;
  legacy_quoted_original_message_id?: number | null;
  legacy_quoted_text?: string | null;
  legacy_quoted_sender_source_jid?: string | null;
  legacy_quoted_sender_display_name?: string | null;
  legacy_quoted_sender_name_is_push_name?: number | null;
  legacy_quoted_from_me?: number | null;
};

function quoteSummaryFromRow(row: QuotedSnapshotRow): QuotedMessageSnapshotSummary | null {
  if (!row.quoted_message_type) {
    if (row.legacy_quoted_original_message_id == null) return null;
    return {
      captured: false,
      quotedSourceMessageId: row.reply_quoted_source_message_id ?? null,
      quotedSourceChatId: null,
      quotedSenderSourceJid: row.legacy_quoted_sender_source_jid ?? null,
      quotedSenderDisplayName: row.legacy_quoted_sender_display_name ?? displayPhoneFromJid(row.legacy_quoted_sender_source_jid),
      quotedSenderNameIsPushName: Boolean(row.legacy_quoted_sender_name_is_push_name) && row.legacy_quoted_sender_display_name != null,
      quotedFromMe: row.legacy_quoted_from_me == null ? null : Boolean(row.legacy_quoted_from_me),
      timestampMs: null,
      messageType: "text",
      body: row.legacy_quoted_text ?? null,
      caption: null,
      mediaMimeType: null,
      mediaName: null,
      location: null,
      vcard: null,
      mentionedJids: [],
      hasThumbnail: false,
      originalMessageId: nullableNumber(row.legacy_quoted_original_message_id)
    };
  }
  return {
    captured: true,
    quotedSourceMessageId: row.quoted_source_message_id ?? null,
    quotedSourceChatId: row.quoted_source_chat_id ?? null,
    quotedSenderSourceJid: row.quoted_sender_source_jid ?? null,
    quotedSenderDisplayName: row.quoted_sender_display_name ?? displayPhoneFromJid(row.quoted_sender_source_jid),
    quotedSenderNameIsPushName: Boolean(row.quoted_sender_name_is_push_name) && row.quoted_sender_display_name != null,
    quotedFromMe: row.quoted_from_me == null ? null : Boolean(row.quoted_from_me),
    timestampMs: nullableNumber(row.quoted_timestamp_ms),
    messageType: row.quoted_message_type,
    body: row.quoted_body ?? null,
    caption: row.quoted_caption ?? null,
    mediaMimeType: row.quoted_media_mime_type ?? null,
    mediaName: row.quoted_media_name ?? null,
    location: quoteLocationSummary(parseJson(row.quoted_location_json ?? null) as QuotedMessageSnapshot["location"]),
    vcard: quoteVcardSummary(parseJson(row.quoted_vcard_json ?? null) as QuotedMessageSnapshot["vcard"]),
    mentionedJids: (parseJson(row.quoted_mentioned_jids_json ?? null) as string[] | null) ?? [],
    hasThumbnail: Boolean(row.quoted_has_thumbnail),
    originalMessageId: nullableNumber(row.quoted_original_message_id)
  };
}

function quoteLocationSummary(location: QuotedMessageSnapshot["location"]): QuotedMessageSnapshotSummary["location"] {
  return location ? { name: location.name, address: location.address } : null;
}

function quoteVcardSummary(vcard: QuotedMessageSnapshot["vcard"]): QuotedMessageSnapshotSummary["vcard"] {
  return vcard ? { name: vcard.name } : null;
}

interface SqliteMediaQueueRow {
  id: number;
  message_key: string;
  chat_source_id: string;
  source_message_id: string;
  descriptor_json: string | null;
  thumbnail: Buffer | null;
  is_view_once: number;
  status: MediaDownloadStatus;
  attempts: number;
  reupload_attempts: number;
  next_attempt_at_ms: number | null;
  last_error: string | null;
  priority: number;
}

function rowToMediaQueueRecord(row: SqliteMediaQueueRow): MediaDownloadQueueRecord | null {
  if (!row.descriptor_json) {
    return null;
  }
  return {
    id: Number(row.id),
    messageKey: row.message_key,
    chatSourceId: row.chat_source_id,
    sourceMessageId: row.source_message_id,
    descriptor: JSON.parse(row.descriptor_json) as MediaDownloadDescriptor,
    thumbnail: row.thumbnail ?? null,
    isViewOnce: Boolean(row.is_view_once),
    status: row.status,
    attempts: Number(row.attempts ?? 0),
    reuploadAttempts: Number(row.reupload_attempts ?? 0),
    nextAttemptAtMs: nullableNumber(row.next_attempt_at_ms),
    lastError: row.last_error,
    priority: Number(row.priority ?? 0)
  };
}

interface SqliteMediaAssetRow {
  id: number;
  message_key: string;
  chat_source_id: string;
  sha256: string;
  storage_path: string;
  mime_type: string | null;
  byte_size: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  thumbnail: Buffer | null;
  source: MediaAssetRecord["source"];
  is_view_once: number;
  created_at: string;
}

function rowToMediaAsset(row: SqliteMediaAssetRow): MediaAssetRecord {
  return {
    id: Number(row.id),
    messageKey: row.message_key,
    chatSourceId: row.chat_source_id,
    sha256: row.sha256,
    storagePath: row.storage_path,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    width: nullableNumber(row.width),
    height: nullableNumber(row.height),
    durationMs: nullableNumber(row.duration_ms),
    thumbnail: row.thumbnail ?? null,
    source: row.source,
    isViewOnce: Boolean(row.is_view_once),
    createdAt: row.created_at
  };
}

// Run kinds mirror BrainRunKind; 'lifecycle' (commitment-lifecycle) is the
// closure sweep; 'rollup' (semantic-rollups) is the semantic consolidation
// run. The CHECK migrates via copy-rename like the other kind CHECKs.
const BRAIN_RUN_KINDS = ["nightly", "catchup", "manual", "backfill", "regenerate", "lifecycle", "rollup"] as const;

// Lifecycle transition statuses; 'dismissed' replaced the former 'cancelled'
// (one "not-done / off-my-list" terminal). The CHECK migrates via copy-rename.
const BRAIN_LIFECYCLE_STATUSES = ["fulfilled", "dismissed", "still_open", "reopened"] as const;

function brainLifecycleEventsTableDdl(tableName: string): string {
  return `CREATE TABLE IF NOT EXISTS ${tableName} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id TEXT NOT NULL,
    to_status TEXT NOT NULL CHECK (to_status IN (${BRAIN_LIFECYCLE_STATUSES.map((status) => `'${status}'`).join(",")})),
    source TEXT NOT NULL CHECK (source IN ('model','user')),
    evidence_at_ms INTEGER NULL,
    note TEXT NULL,
    run_id TEXT NULL,
    model TEXT NULL,
    -- Set when regeneration could not re-key this event onto a replacement
    -- claim: kept for audit, excluded from folds, surfaced as debt.
    orphaned_at_ms INTEGER NULL,
    created_at_ms INTEGER NOT NULL
  )`;
}

function brainRunsTableDdl(tableName: string): string {
  return `CREATE TABLE IF NOT EXISTS ${tableName} (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN (${BRAIN_RUN_KINDS.map((kind) => `'${kind}'`).join(",")})),
    status TEXT NOT NULL CHECK (status IN ('running','completed','failed','interrupted','budget_exceeded')),
    started_at TEXT NOT NULL,
    finished_at TEXT NULL,
    timezone TEXT NULL,
    totals_json TEXT NULL,
    error_message TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`;
}

function liveMessageUpdatesTableDdl(tableName: string): string {
  return `CREATE TABLE IF NOT EXISTS ${tableName} (
    event_key TEXT PRIMARY KEY,
    chat_source_id TEXT NOT NULL,
    source_message_key TEXT NOT NULL,
    update_type TEXT NOT NULL CHECK (update_type IN (${MESSAGE_UPDATE_TYPES.map((type) => `'${type}'`).join(",")})),
    occurred_at_ms INTEGER NULL,
    applied INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`;
}

function liveSessionsTableDdl(tableName: string): string {
  return `CREATE TABLE IF NOT EXISTS ${tableName} (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN (${LIVE_SESSION_STATUSES.map((status) => `'${status}'`).join(",")})),
    client_name TEXT NOT NULL,
    linked_device_jid TEXT NULL,
    last_connected_at TEXT NULL,
    last_disconnected_at TEXT NULL,
    last_error TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`;
}

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS identity_links (
    lid TEXT PRIMARY KEY,
    pn TEXT NOT NULL,
    source TEXT NULL,
    learned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS import_runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
    started_at TEXT NOT NULL,
    finished_at TEXT NULL,
    tool_version TEXT NOT NULL,
    source_summary_json TEXT NULL,
    totals_json TEXT NULL,
    warning_count INTEGER NOT NULL DEFAULT 0,
    error_code TEXT NULL,
    error_message TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS import_warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_run_id TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info','warning','error')),
    code TEXT NOT NULL,
    entity_type TEXT NULL,
    source_table TEXT NULL,
    source_row_id TEXT NULL,
    message TEXT NOT NULL,
    context_json TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (import_run_id) REFERENCES import_runs(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_jid TEXT NOT NULL UNIQUE,
    phone_number TEXT NULL,
    display_name TEXT NULL,
    display_name_source TEXT NULL,
    push_name TEXT NULL,
    raw_metadata_json TEXT NULL,
    first_seen_import_id TEXT NULL,
    last_seen_import_id TEXT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_chat_id TEXT NOT NULL UNIQUE,
    jid TEXT NOT NULL,
    display_name TEXT NULL,
    chat_type TEXT NOT NULL DEFAULT 'unknown' CHECK (chat_type IN ('dm','group','community','broadcast','status','unknown')),
    message_count INTEGER NOT NULL DEFAULT 0,
    participant_count INTEGER NOT NULL DEFAULT 0,
    last_message_at TEXT NULL,
    last_message_at_ms INTEGER NULL,
    platform_recency_ms INTEGER NULL,
    raw_metadata_json TEXT NULL,
    first_seen_import_id TEXT NULL,
    last_seen_import_id TEXT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS chat_participants (
    chat_id INTEGER NOT NULL,
    source_jid TEXT NOT NULL,
    contact_id INTEGER NULL,
    display_name TEXT NULL,
    first_seen_at_ms INTEGER NULL,
    last_seen_at_ms INTEGER NULL,
    membership_source TEXT NOT NULL DEFAULT 'inferred' CHECK (membership_source IN ('source','inferred')),
    raw_metadata_json TEXT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (chat_id, source_jid),
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
  )`,

  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_message_key TEXT NOT NULL UNIQUE,
    source_message_id TEXT NOT NULL,
    source_table TEXT NOT NULL,
    source_row_id TEXT NOT NULL,
    chat_id INTEGER NOT NULL,
    sender_contact_id INTEGER NULL,
    sender_source_jid TEXT NULL,
    timestamp_ms INTEGER NULL,
    sent_at TEXT NULL,
    direction TEXT NOT NULL DEFAULT 'unknown' CHECK (direction IN ('incoming','outgoing','system','unknown')),
    from_me INTEGER NULL,
    message_type TEXT NOT NULL DEFAULT 'unknown',
    raw_type_code TEXT NULL,
    body TEXT NULL,
    caption TEXT NULL,
    has_media INTEGER NOT NULL DEFAULT 0,
    media_mime_type TEXT NULL,
    media_name TEXT NULL,
    quoted_source_message_id TEXT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    is_forwarded INTEGER NOT NULL DEFAULT 0,
    is_starred INTEGER NOT NULL DEFAULT 0,
    raw_metadata_json TEXT NULL,
    -- Derived search text: body/caption with mentions swapped for display
    -- names, plus media file name. Recomputed by write paths and the reindex
    -- job; stored raw content is never touched. The sender label lives in
    -- resolved_sender (its own low-weight FTS column) so sent-by matches are
    -- identifiable; resolved_context carries searchable secondary text
    -- (orphaned quoted-snapshot text, link-preview title/description/URL).
    resolved_text TEXT NULL,
    resolved_sender TEXT NULL,
    resolved_context TEXT NULL,
    imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_contact_id) REFERENCES contacts(id) ON DELETE SET NULL
  )`,

  // Canonicalized mentioned identities per message (identity-aware inference):
  // explicit transport mentions unioned with text-token "@digits" mentions.
  `CREATE TABLE IF NOT EXISTS message_mentions (
    message_id INTEGER NOT NULL,
    mentioned_jid TEXT NOT NULL,
    -- Bit mask: 1 = text token fallback, 2 = authoritative structured source.
    source_mask INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (message_id, mentioned_jid),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  ) WITHOUT ROWID`,

  // Query-time term-alias expansion (retrieval-hardening): spelling variants
  // of the same word (romanized Hindi seeds now; the deep retrieval path
  // may persist model-learned variants later) OR-ed into FTS queries at zero
  // model cost. Tokenizer-normalized text on both sides.
  `CREATE TABLE IF NOT EXISTS brain_term_aliases (
    term TEXT NOT NULL,
    variant TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'seed',
    weight REAL NOT NULL DEFAULT 1.0,
    PRIMARY KEY (term, variant)
  ) WITHOUT ROWID`,

  // Signal capture is additive archive state. Every row has a stable natural
  // key and provenance; none stores raw receipt/device records.
  `CREATE TABLE IF NOT EXISTS identity_number_changes (
    event_key TEXT PRIMARY KEY,
    chat_source_id TEXT NULL,
    source_message_key TEXT NULL,
    old_jid TEXT NOT NULL,
    new_jid TEXT NOT NULL,
    actor_jid TEXT NULL,
    source TEXT NOT NULL CHECK (source IN ('backup','live')),
    source_event_key TEXT NOT NULL DEFAULT '',
    observed_at_ms INTEGER NULL,
    capture_version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS group_membership_periods (
    period_key TEXT PRIMARY KEY,
    group_source_id TEXT NOT NULL,
    participant_jid TEXT NOT NULL,
    joined_at_ms INTEGER NULL,
    left_at_ms INTEGER NULL,
    role TEXT NULL,
    source TEXT NOT NULL CHECK (source IN ('backup','live')),
    source_event_key TEXT NULL,
    observed_at_ms INTEGER NULL,
    capture_version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS group_membership_events (
    event_key TEXT PRIMARY KEY,
    group_source_id TEXT NOT NULL,
    participant_jid TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('add','remove','join','leave','invite','accept','promote','demote')),
    actor_jid TEXT NULL,
    source_message_key TEXT NULL,
    old_role TEXT NULL,
    new_role TEXT NULL,
    raw_type TEXT NULL,
    raw_parameters TEXT NULL,
    source TEXT NOT NULL CHECK (source IN ('backup','live')),
    source_event_key TEXT NULL,
    observed_at_ms INTEGER NULL,
    capture_version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS chat_metadata_history (
    event_key TEXT PRIMARY KEY,
    chat_source_id TEXT NOT NULL,
    field TEXT NOT NULL CHECK (field IN ('subject','description','photo','invite_link','announcement','restriction','member_add','join_approval','disappearing')),
    source_message_key TEXT NULL,
    actor_jid TEXT NULL,
    old_value TEXT NULL,
    new_value TEXT NULL,
    raw_type TEXT NULL,
    raw_parameters TEXT NULL,
    source TEXT NOT NULL CHECK (source IN ('backup','live')),
    source_event_key TEXT NULL,
    observed_at_ms INTEGER NULL,
    capture_version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS message_locations (
    source_message_key TEXT PRIMARY KEY,
    latitude REAL NULL,
    longitude REAL NULL,
    name TEXT NULL,
    address TEXT NULL,
    is_live INTEGER NOT NULL DEFAULT 0,
    accuracy_meters REAL NULL,
    url TEXT NULL,
    comment TEXT NULL,
    caption TEXT NULL,
    speed_mps REAL NULL,
    heading_degrees REAL NULL,
    sequence_number INTEGER NULL,
    time_offset_ms INTEGER NULL,
    live_share_duration_ms INTEGER NULL,
    final_at_ms INTEGER NULL,
    has_thumbnail INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL CHECK (source IN ('backup','live')),
    source_event_key TEXT NULL,
    observed_at_ms INTEGER NULL,
    capture_version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (source_message_key) REFERENCES messages(source_message_key) ON UPDATE CASCADE ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS message_location_observations (
    observation_key TEXT PRIMARY KEY,
    source_message_key TEXT NOT NULL,
    latitude REAL NULL,
    longitude REAL NULL,
    accuracy_meters REAL NULL,
    speed_mps REAL NULL,
    heading_degrees REAL NULL,
    sequence_number INTEGER NULL,
    time_offset_ms INTEGER NULL,
    final_at_ms INTEGER NULL,
    has_thumbnail INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL CHECK (source IN ('backup','live')),
    source_event_key TEXT NULL,
    observed_at_ms INTEGER NULL,
    capture_version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (source_message_key) REFERENCES messages(source_message_key) ON UPDATE CASCADE ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS message_vcards (
    source_message_key TEXT NOT NULL,
    card_index INTEGER NOT NULL,
    display_name TEXT NULL,
    vcard TEXT NULL,
    resolved_jid TEXT NULL,
    properties_json TEXT NULL,
    download_kind TEXT NOT NULL DEFAULT 'unavailable' CHECK (download_kind IN ('source','constructed','unavailable')),
    download_file_name TEXT NULL,
    source TEXT NOT NULL CHECK (source IN ('backup','live')),
    source_event_key TEXT NULL,
    observed_at_ms INTEGER NULL,
    capture_version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (source_message_key, card_index),
    FOREIGN KEY (source_message_key) REFERENCES messages(source_message_key) ON UPDATE CASCADE ON DELETE CASCADE
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS message_edit_events (
    event_key TEXT PRIMARY KEY,
    source_message_key TEXT NOT NULL,
    original_source_message_id TEXT NULL,
    observed_edit_message_id TEXT NULL,
    source TEXT NOT NULL CHECK (source IN ('backup','live')),
    source_event_key TEXT NULL,
    observed_at_ms INTEGER NULL,
    capture_version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (source_message_key) REFERENCES messages(source_message_key) ON UPDATE CASCADE ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS message_deletions (
    source_message_key TEXT PRIMARY KEY,
    revoked_by_jid TEXT NULL,
    revoked_by_admin INTEGER NULL,
    deletion_kind TEXT NULL,
    source TEXT NOT NULL CHECK (source IN ('backup','live')),
    source_event_key TEXT NULL,
    observed_at_ms INTEGER NULL,
    capture_version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (source_message_key) REFERENCES messages(source_message_key) ON UPDATE CASCADE ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS archive_signal_observations (
    fact_key TEXT NOT NULL,
    family TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('backup','live')),
    source_event_key TEXT NOT NULL DEFAULT '',
    source_message_key TEXT NULL,
    observed_at_ms INTEGER NULL,
    capture_version INTEGER NOT NULL,
    detail_json TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (fact_key, family, source, source_event_key)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS message_media_interpretations (
    source_message_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('accessibility_label','transcription','transcription_segment')),
    segment_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    start_ms INTEGER NULL,
    end_ms INTEGER NULL,
    source TEXT NOT NULL CHECK (source IN ('backup','live')),
    source_event_key TEXT NULL,
    observed_at_ms INTEGER NULL,
    capture_version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (source_message_key, kind, segment_index),
    FOREIGN KEY (source_message_key) REFERENCES messages(source_message_key) ON UPDATE CASCADE ON DELETE CASCADE
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS engagement_aggregates (
    aggregate_key TEXT PRIMARY KEY,
    chat_source_id TEXT NOT NULL,
    counterparty_jid TEXT NULL,
    eligible_outgoing_count INTEGER NOT NULL,
    delivered_count INTEGER NOT NULL,
    read_count INTEGER NOT NULL,
    response_latency_sample_count INTEGER NOT NULL,
    median_response_latency_ms INTEGER NULL,
    window_start_at_ms INTEGER NULL,
    window_end_at_ms INTEGER NULL,
    algorithm_version INTEGER NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('backup','live')),
    source_event_key TEXT NULL,
    observed_at_ms INTEGER NULL,
    capture_version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  // Reply-owned WhatsApp quote snapshots. This is intentionally separate from
  // messages: it is embedded context, never independently visible/searchable
  // or citable, and can carry a small embedded thumbnail.
  `CREATE TABLE IF NOT EXISTS message_quoted_snapshots (
    reply_message_key TEXT PRIMARY KEY,
    quoted_source_message_id TEXT NULL,
    quoted_source_chat_id TEXT NULL,
    quoted_sender_source_jid TEXT NULL,
    quoted_from_me INTEGER NULL,
    timestamp_ms INTEGER NULL,
    message_type TEXT NOT NULL DEFAULT 'unknown',
    raw_type_code TEXT NULL,
    body TEXT NULL,
    caption TEXT NULL,
    media_mime_type TEXT NULL,
    media_name TEXT NULL,
    thumbnail BLOB NULL,
    location_json TEXT NULL,
    vcard_json TEXT NULL,
    mentioned_jids_json TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (reply_message_key) REFERENCES messages(source_message_key) ON UPDATE CASCADE ON DELETE CASCADE
  )`,

  liveSessionsTableDdl("live_sessions"),

  `CREATE TABLE IF NOT EXISTS live_sync_runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
    started_at TEXT NOT NULL,
    finished_at TEXT NULL,
    client_name TEXT NOT NULL,
    source_summary_json TEXT NULL,
    totals_json TEXT NULL,
    warning_count INTEGER NOT NULL DEFAULT 0,
    error_code TEXT NULL,
    error_message TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS live_chat_checkpoints (
    chat_source_id TEXT PRIMARY KEY,
    chat_id INTEGER NULL,
    latest_archived_message_key TEXT NULL,
    latest_archived_at_ms INTEGER NULL,
    earliest_archived_message_key TEXT NULL,
    earliest_archived_at_ms INTEGER NULL,
    latest_live_message_key TEXT NULL,
    latest_live_at_ms INTEGER NULL,
    oldest_verified_message_key TEXT NULL,
    oldest_verified_at_ms INTEGER NULL,
    health TEXT NOT NULL CHECK (health IN ('healthy','catching_up','uncertain','disconnected','needs_user_action')),
    retry_count INTEGER NOT NULL DEFAULT 0,
    next_recovery_at TEXT NULL,
    last_audit_at TEXT NULL,
    raw_metadata_json TEXT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE SET NULL
  )`,

  `CREATE TABLE IF NOT EXISTS live_gap_windows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_source_id TEXT NOT NULL,
    chat_id INTEGER NULL,
    reason TEXT NOT NULL CHECK (reason IN ('late_start','disconnect','watermark_mismatch','history_sync_stalled','manual_retry')),
    status TEXT NOT NULL CHECK (status IN ('open','retrying','closed','uncertain','needs_user_action')),
    start_at_ms INTEGER NULL,
    end_at_ms INTEGER NULL,
    required_lower_bound_at_ms INTEGER NULL,
    anchor_message_key TEXT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT NULL,
    confidence TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
    notes TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE SET NULL
  )`,

  `CREATE TABLE IF NOT EXISTS live_event_receipts (
    event_key TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    chat_source_id TEXT NULL,
    message_key TEXT NULL,
    occurred_at_ms INTEGER NULL,
    processed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    metadata_json TEXT NULL
  )`,

  liveMessageUpdatesTableDdl("live_message_updates"),

  `CREATE TABLE IF NOT EXISTS message_secrets (
    message_key TEXT PRIMARY KEY,
    chat_source_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    secret BLOB NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('live','backup')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS retained_encrypted_payloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_key TEXT NOT NULL UNIQUE,
    target_message_key TEXT NOT NULL,
    chat_source_id TEXT NOT NULL,
    target_message_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('poll_vote','event_response','secret_encrypted')),
    actor_jid TEXT NULL,
    enc_payload BLOB NOT NULL,
    enc_iv BLOB NULL,
    occurred_at_ms INTEGER NULL,
    metadata_json TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_retained_payloads_target ON retained_encrypted_payloads (target_message_key)`,

  // Message→asset linkage with provenance. One row per (message, content
  // hash); identical media across messages shares the blob (and may share the
  // hash across rows) — the blob store is the dedupe layer. Retained across
  // deletes/revokes and across clear-and-replace: rows re-attach to re-imported
  // messages through the canonical message key.
  `CREATE TABLE IF NOT EXISTS media_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_key TEXT NOT NULL,
    chat_source_id TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    mime_type TEXT NULL,
    byte_size INTEGER NOT NULL,
    width INTEGER NULL,
    height INTEGER NULL,
    duration_ms INTEGER NULL,
    thumbnail BLOB NULL,
    source TEXT NOT NULL CHECK (source IN ('live-download','media-retry','import-folder')),
    is_view_once INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (message_key, sha256)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_media_assets_message ON media_assets (message_key)`,
  `CREATE INDEX IF NOT EXISTS idx_media_assets_sha ON media_assets (sha256)`,

  // Durable media download work: the captured descriptor lives here (never on
  // the messages table) until the asset is stored, then it is dropped.
  `CREATE TABLE IF NOT EXISTS media_download_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_key TEXT NOT NULL UNIQUE,
    chat_source_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    descriptor_json TEXT NULL,
    thumbnail BLOB NULL,
    is_view_once INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('pending','downloading','stored','retry','expired_unrecoverable','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    reupload_attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at_ms INTEGER NULL,
    last_error TEXT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_media_queue_due ON media_download_queue (status, priority DESC, next_attempt_at_ms)`,

  // Sender-embedded link previews captured with live text messages; thumbnail
  // bytes are embedded message content, never fetched from the link target.
  `CREATE TABLE IF NOT EXISTS message_link_previews (
    message_key TEXT PRIMARY KEY,
    chat_source_id TEXT NOT NULL,
    title TEXT NULL,
    description TEXT NULL,
    canonical_url TEXT NULL,
    thumbnail BLOB NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  // Prior versions of live-edited messages, snapshotted before each edit
  // overwrites content. Backup imports never fabricate rows here.
  `CREATE TABLE IF NOT EXISTS message_edit_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_key TEXT NOT NULL,
    revision_index INTEGER NOT NULL,
    body TEXT NULL,
    caption TEXT NULL,
    edited_at_ms INTEGER NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (message_key, revision_index)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_edit_revisions_message ON message_edit_revisions (message_key, revision_index)`,

  `CREATE TABLE IF NOT EXISTS memory_runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('running','completed','failed','blocked')),
    kind TEXT NOT NULL CHECK (kind IN ('rem','manual','rebuild','validate')),
    started_at TEXT NOT NULL,
    finished_at TEXT NULL,
    source_start_at_ms INTEGER NULL,
    source_end_at_ms INTEGER NULL,
    source_summary_json TEXT NULL,
    page_count INTEGER NOT NULL DEFAULT 0,
    citation_count INTEGER NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0,
    warning_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS memory_source_windows (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open','committed','skipped','stale')),
    start_at_ms INTEGER NULL,
    end_at_ms INTEGER NULL,
    chat_source_ids_json TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    source_hash TEXT NOT NULL UNIQUE,
    committed_at TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (run_id) REFERENCES memory_runs(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS memory_evidence_packs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    window_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('prepared','generated','validated','failed')),
    sequence INTEGER NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    citation_labels_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES memory_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (window_id) REFERENCES memory_source_windows(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS memory_pages (
    page_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    page_path TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('current','stale')),
    current_revision_id TEXT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS memory_page_revisions (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    window_id TEXT NOT NULL,
    title TEXT NOT NULL,
    page_path TEXT NOT NULL,
    summary TEXT NOT NULL,
    markdown TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('current','superseded','stale')),
    source_start_at_ms INTEGER NULL,
    source_end_at_ms INTEGER NULL,
    citation_count INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES memory_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (window_id) REFERENCES memory_source_windows(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS memory_citations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    revision_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    citation_label TEXT NOT NULL,
    message_id INTEGER NULL,
    source_message_key TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    source_chat_id TEXT NOT NULL,
    sender_source_jid TEXT NULL,
    timestamp_ms INTEGER NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (revision_id) REFERENCES memory_page_revisions(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS memory_validation_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    pack_id TEXT NULL,
    page_id TEXT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('warning','error')),
    code TEXT NOT NULL,
    message TEXT NOT NULL,
    context_json TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (run_id) REFERENCES memory_runs(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS memory_job_locks (
    name TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL
  )`,

  // --- Brain substrate (tiered assimilation) ---
  // Coverage truth: per-chat watermark advanced only when an episode commits.
  // Pending work is always DERIVED from messages newer than the watermark —
  // no stored counter that can drift from reality.
  `CREATE TABLE IF NOT EXISTS brain_chat_watermarks (
    chat_source_id TEXT PRIMARY KEY,
    assimilated_through_ms INTEGER NOT NULL DEFAULT 0,
    assimilated_through_id INTEGER NOT NULL DEFAULT 0,
    last_episode_at TEXT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  // Durable work queue (cloned from media_download_queue semantics): unique
  // dedupe keys make enqueues idempotent; claim/backoff/priority make
  // interruption free — the next tick re-claims stale work.
  `CREATE TABLE IF NOT EXISTS brain_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('episode','regenerate','rollup','overview','merge_adjudicate','reindex','project_pages')),
    chat_source_id TEXT NULL,
    payload_json TEXT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
    priority INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at_ms INTEGER NULL,
    claimed_at_ms INTEGER NULL,
    last_error TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  brainRunsTableDdl("brain_runs"),

  // Episodic tier: cited per-chat conversation digests. Generator records how
  // each episode was produced ('extractive' episodes are honest placeholders,
  // regenerable by a model later). Episodes are the citation spine — statuses
  // demote them from read surfaces but never delete them.
  `CREATE TABLE IF NOT EXISTS brain_episodes (
    id TEXT PRIMARY KEY,
    chat_source_id TEXT NOT NULL,
    start_at_ms INTEGER NOT NULL,
    end_at_ms INTEGER NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    participants_json TEXT NULL,
    summary TEXT NOT NULL,
    markdown TEXT NOT NULL,
    generator TEXT NOT NULL CHECK (generator IN ('model','extractive')),
    model TEXT NULL,
    status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current','superseded','stale','compressed')),
    run_id TEXT NULL,
    fallback_reason TEXT NULL,
    attempted_model TEXT NULL,
    extraction_version INTEGER NOT NULL,
    unresolved_participants_json TEXT NULL,
    push_name_participants_json TEXT NULL,
    uninterpreted_media_count INTEGER NOT NULL DEFAULT 0,
    quoted_reply_anchors_json TEXT NULL,
    archive_signal_anchors_json TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS brain_claims (
    id TEXT PRIMARY KEY,
    episode_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('fact','decision','commitment','question','event')),
    text TEXT NOT NULL,
    event_at_ms INTEGER NULL,
    valid_until_ms INTEGER NULL,
    confidence TEXT NOT NULL DEFAULT 'stated' CHECK (confidence IN ('stated','hedged','reported')),
    -- Declared supersession PROJECTION (semantic-rollups): the doc revision is
    -- the durable truth; this column is the cheap retrieval/input predicate.
    -- SET NULL when the superseding claim's episode regenerates away.
    superseded_by_claim_id TEXT NULL REFERENCES brain_claims(id) ON DELETE SET NULL,
    FOREIGN KEY (episode_id) REFERENCES brain_episodes(id) ON DELETE CASCADE
  )`,

  // Claim entities: identity-anchored at commit (jid = canonical JID when the
  // entity name matched a pack participant label; NULL otherwise). The future
  // knowledge graph keys on jid; name is display metadata.
  `CREATE TABLE IF NOT EXISTS brain_claim_entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('person','org','place','project','other')),
    name TEXT NOT NULL,
    jid TEXT NULL,
    role TEXT NULL,
    FOREIGN KEY (claim_id) REFERENCES brain_claims(id) ON DELETE CASCADE
  )`,

  // Structured episode topics: never load-bearing in prose. Case-insensitive
  // uniqueness converges vocabulary ('Visa' reuses 'visa').
  `CREATE TABLE IF NOT EXISTS brain_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL COLLATE NOCASE UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS brain_episode_topics (
    episode_id TEXT NOT NULL,
    topic_id INTEGER NOT NULL,
    PRIMARY KEY (episode_id, topic_id),
    FOREIGN KEY (episode_id) REFERENCES brain_episodes(id) ON DELETE CASCADE,
    FOREIGN KEY (topic_id) REFERENCES brain_topics(id) ON DELETE CASCADE
  )`,

  // Media-gap demand signal (contract v2, D13): the model's text-only record
  // that an unavailable media message's content would have improved the
  // episode. modality is derived at commit from the cited message's type.
  `CREATE TABLE IF NOT EXISTS brain_media_gaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id TEXT NOT NULL,
    source_message_key TEXT NOT NULL,
    modality TEXT NOT NULL CHECK (modality IN ('image','audio','video','document','other')),
    impact TEXT NOT NULL CHECK (impact IN ('blocks','enriches')),
    note TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (episode_id) REFERENCES brain_episodes(id) ON DELETE CASCADE
  )`,

  // Normalized reverse index for source-signal dependency stamps. The episode
  // JSON remains the portable record; this table makes targeted stale marking
  // cheap without copying vCards, transcript text, or coordinates.
  `CREATE TABLE IF NOT EXISTS brain_episode_signal_anchors (
    episode_id TEXT NOT NULL,
    source_message_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('mention','location','vcard','link_preview','edit','deletion','media_interpretation')),
    capture_version INTEGER NOT NULL,
    PRIMARY KEY (episode_id, source_message_key, kind),
    FOREIGN KEY (episode_id) REFERENCES brain_episodes(id) ON DELETE CASCADE
  ) WITHOUT ROWID`,

  // Quality signals and salvage records (contract v2): structural failures that
  // exhausted the retry ('error'), quality lints like the anchoring check
  // ('warning'), informational notes ('info'). Flag rows never block commits.
  `CREATE TABLE IF NOT EXISTS brain_validation_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NULL,
    chat_source_id TEXT NULL,
    episode_id TEXT NULL,
    claim_sequence INTEGER NULL,
    -- semantic-rollups: issues raised by/about a doc revision anchor here.
    doc_id TEXT NULL,
    code TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info','warning','error')),
    detail TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  // Citation labels ARE message keys — stable, globally unique, resolvable.
  `CREATE TABLE IF NOT EXISTS brain_citations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id TEXT NOT NULL,
    source_message_key TEXT NOT NULL,
    source_chat_id TEXT NOT NULL,
    message_id INTEGER NULL,
    sender_source_jid TEXT NULL,
    timestamp_ms INTEGER NULL,
    FOREIGN KEY (claim_id) REFERENCES brain_claims(id) ON DELETE CASCADE
  )`,

  // Every model call's cost, by UTC day and purpose: budgets are enforced
  // from this ledger as hard named blocks, never silent degradation.
  `CREATE TABLE IF NOT EXISTS brain_llm_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day TEXT NOT NULL,
    purpose TEXT NOT NULL,
    provider TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    estimated INTEGER NOT NULL DEFAULT 0,
    at_ms INTEGER NOT NULL
  )`,

  // --- Brain evaluation (eval harness) ---
  // Eval runs and claim grades are user-authored ground truth, NOT derived
  // data: they are deliberately excluded from resetBrainDerivedData and from
  // the contract-shape rebuild guard, and carry no foreign keys into brain
  // tables so they outlive supersession, regeneration, and full wipes.
  `CREATE TABLE IF NOT EXISTS brain_eval_runs (
    id TEXT PRIMARY KEY,
    ran_at_ms INTEGER NOT NULL,
    target TEXT NOT NULL,
    golden_version INTEGER NOT NULL,
    golden_hash TEXT NOT NULL,
    k_values_json TEXT NOT NULL,
    query_count INTEGER NOT NULL,
    skipped_query_ids_json TEXT NOT NULL DEFAULT '[]',
    per_class_json TEXT NOT NULL,
    per_query_json TEXT NOT NULL,
    totals_json TEXT NOT NULL,
    notes TEXT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_brain_eval_runs_hash_time ON brain_eval_runs (golden_hash, ran_at_ms)`,

  // One grade per claim (regrade overwrites). Stamps are denormalized at grade
  // time — server-read from the claim's episode, never client-supplied.
  `CREATE TABLE IF NOT EXISTS brain_claim_grades (
    claim_id TEXT PRIMARY KEY,
    grade TEXT NOT NULL CHECK (grade IN ('supported','partial','unsupported','unclear')),
    graded_at_ms INTEGER NOT NULL,
    episode_id TEXT NOT NULL,
    chat_source_id TEXT NOT NULL,
    generator TEXT NOT NULL,
    model TEXT NULL,
    extraction_version INTEGER NOT NULL,
    claim_kind TEXT NOT NULL,
    claim_confidence TEXT NOT NULL,
    claim_text TEXT NOT NULL,
    citation_keys_json TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_brain_claim_grades_model ON brain_claim_grades (model, extraction_version)`,

  // --- Knowledge graph (knowledge-graph-foundation) ---
  // Derived-of-derived semantic substrate: rebuilt from committed episodes and
  // captured signals with zero model calls. Natural keys make every producer
  // idempotent; slugs are immutable from birth; person nodes key on canonical
  // JID and titles are never load-bearing (labels resolve at read time).
  `CREATE TABLE IF NOT EXISTS brain_nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('person','chat','topic','org','place','project','other','commitment','question','event','fact')),
    natural_key TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NULL,
    jid TEXT NULL,
    chat_scope TEXT NULL,
    payload_json TEXT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dormant','merged')),
    merged_into TEXT NULL,
    salience REAL NOT NULL DEFAULT 0,
    citation_count INTEGER NOT NULL DEFAULT 0,
    evidence_days INTEGER NOT NULL DEFAULT 0,
    engagement_factor REAL NOT NULL DEFAULT 1,
    first_seen_at_ms INTEGER NULL,
    last_seen_at_ms INTEGER NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  // Typed weighted edges, unique per (src, dst, kind). No edge exists without
  // evidence; counts are maintained exactly via the evidence table's insert
  // outcomes and re-derived wholesale on rebuild.
  `CREATE TABLE IF NOT EXISTS brain_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    src_node_id TEXT NOT NULL,
    dst_node_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('participates_in','mentions','about','involves','related_to','replies_to','derived_from','alias_of','resolves')),
    weight REAL NOT NULL DEFAULT 0,
    evidence_count INTEGER NOT NULL DEFAULT 0,
    first_seen_at_ms INTEGER NULL,
    last_seen_at_ms INTEGER NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (src_node_id, dst_node_id, kind),
    FOREIGN KEY (src_node_id) REFERENCES brain_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (dst_node_id) REFERENCES brain_nodes(id) ON DELETE CASCADE
  )`,

  // Per-edge provenance down to claims/messages/signal refs. evidence_key is
  // the dedupe identity (claim id, message key, or signal ref), so replay and
  // regeneration can never double-count.
  `CREATE TABLE IF NOT EXISTS brain_edge_evidence (
    edge_id INTEGER NOT NULL,
    evidence_key TEXT NOT NULL,
    claim_id TEXT NULL,
    source_message_key TEXT NULL,
    source_ref TEXT NULL,
    observed_at_ms INTEGER NULL,
    PRIMARY KEY (edge_id, evidence_key),
    FOREIGN KEY (edge_id) REFERENCES brain_edges(id) ON DELETE CASCADE
  ) WITHOUT ROWID`,

  // Node ↔ claim junction: the entity-view read spine and the salience
  // recompute's citation source. Populated inside the commit transaction.
  `CREATE TABLE IF NOT EXISTS brain_node_claims (
    node_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    PRIMARY KEY (node_id, claim_id),
    FOREIGN KEY (node_id) REFERENCES brain_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (claim_id) REFERENCES brain_claims(id) ON DELETE CASCADE
  ) WITHOUT ROWID`,

  // Observed surface forms (entity-name spellings, number-change aliases):
  // adjudication fuel and search context, never a resolution join.
  `CREATE TABLE IF NOT EXISTS brain_node_aliases (
    node_id TEXT NOT NULL,
    alias TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'entity',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (node_id, alias),
    FOREIGN KEY (node_id) REFERENCES brain_nodes(id) ON DELETE CASCADE
  ) WITHOUT ROWID`,

  // --- Commitment lifecycle (commitment-lifecycle) ---
  // Durable truth for lifecycle transitions, OUTSIDE the wipeable graph
  // tables: append-only events keyed by the lifecycle CLAIM id (stable across
  // graph rebuilds — node ids are not). Node payload status is a projection of
  // the fold over these rows; rebuild re-applies it with zero model calls.
  brainLifecycleEventsTableDdl("brain_lifecycle_events"),

  // Citations behind a transition: the resolving evidence messages, each with
  // the acting identity (reactor / reply sender / citing sender) so `resolves`
  // edges re-derive from these rows alone on rebuild.
  `CREATE TABLE IF NOT EXISTS brain_lifecycle_event_cites (
    event_id INTEGER NOT NULL,
    source_message_key TEXT NOT NULL,
    resolving_claim_id TEXT NULL,
    actor_jid TEXT NULL,
    timestamp_ms INTEGER NULL,
    PRIMARY KEY (event_id, source_message_key),
    FOREIGN KEY (event_id) REFERENCES brain_lifecycle_events(id) ON DELETE CASCADE
  ) WITHOUT ROWID`,

  // --- Semantic consolidation (semantic-rollups) ---
  // Doc identity: one row per entity/topic/chat page, keyed by the doc id
  // ('<kind>:<slug>' — the node's immutable slug is the projection/URL
  // currency). current_revision_id has no FK on purpose (write-order: the
  // revision row lands first, then the pointer flips).
  `CREATE TABLE IF NOT EXISTS brain_docs (
    doc_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('entity','topic','chat')),
    node_id TEXT NULL,
    slug TEXT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged')),
    merged_into TEXT NULL,
    current_revision_id INTEGER NULL,
    last_rollup_at_ms INTEGER NULL,
    created_at_ms INTEGER NOT NULL
  )`,

  // Retained revisions: the durable truth of every consolidation — statements
  // with claim refs, declared drops, the fed-claim audit, applied resolutions,
  // and (for rejected revisions) the refusal's errors. Nothing here is ever
  // silently rewritten; rollback flips the current pointer.
  `CREATE TABLE IF NOT EXISTS brain_doc_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL REFERENCES brain_docs(doc_id),
    revision INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('current','superseded','rejected')),
    sections_json TEXT NOT NULL,
    drops_json TEXT NOT NULL,
    fed_claim_ids_json TEXT NOT NULL,
    input_stats_json TEXT NOT NULL,
    resolutions_json TEXT NOT NULL,
    errors_json TEXT NULL,
    model TEXT NULL,
    effort TEXT NULL,
    run_id TEXT NULL,
    prompt_version INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    UNIQUE (doc_id, revision)
  )`,

  // Referenced (cited-by-statements) claim refs per revision. Deliberately NO
  // claim FK: a dangling ref is the dueness signal that upstream regeneration
  // moved this doc's ground truth — a cascade would erase exactly that
  // evidence. Revision deletion cascades normally.
  `CREATE TABLE IF NOT EXISTS brain_doc_revision_claims (
    revision_id INTEGER NOT NULL REFERENCES brain_doc_revisions(id) ON DELETE CASCADE,
    claim_id TEXT NOT NULL,
    PRIMARY KEY (revision_id, claim_id)
  ) WITHOUT ROWID`,

  // --- Two-level person model ---
  // Identities (canonical JIDs) are the immutable anchors; a person is an
  // editable grouping over them. A person row exists only while it has two or
  // more members, and deliberately has no name column: nothing groups by name.
  `CREATE TABLE IF NOT EXISTS persons (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  // Membership is the whole person model: connect = insert, disconnect =
  // delete. An identity belongs to at most one person. `source` is precise
  // provenance — an accepted suggestion lands as 'user' (the human clicked)
  // with the suggestion in evidence_json; suggestions are never a source.
  `CREATE TABLE IF NOT EXISTS person_members (
    person_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    identity_jid TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL CHECK (source IN ('google','number_change','user')),
    evidence_json TEXT NULL,
    linked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (person_id, identity_jid)
  )`,

  // Pair-level negative memory (pair normalized by lexicographic order):
  // a disconnect or a dismissal must never be silently undone by an auto
  // source. An explicit user connect clears the row.
  `CREATE TABLE IF NOT EXISTS person_link_suppressions (
    jid_low TEXT NOT NULL,
    jid_high TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('suggestion_rejected','disconnected')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (jid_low, jid_high)
  ) WITHOUT ROWID`,

  // Detector output: ranked, evidence-attached, and inert — only an explicit
  // user acceptance turns a suggestion into membership. A 'rejected' row is
  // the rejection memory: the UNIQUE(pair, kind) slot stays occupied so the
  // same pair is never re-suggested for the same detector kind.
  `CREATE TABLE IF NOT EXISTS person_suggestions (
    id TEXT PRIMARY KEY,
    jid_low TEXT NOT NULL,
    jid_high TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('same_name','shared_group','co_citation','succession','shared_vcard','llm')),
    score REAL NOT NULL,
    evidence_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','superseded')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (jid_low, jid_high, kind)
  )`,

  // Append-only audit trail for every person-layer operation.
  `CREATE TABLE IF NOT EXISTS person_link_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL CHECK (action IN ('connect','disconnect','union','dissolve','suggest','accept','reject','unreject','release')),
    person_id TEXT NULL,
    identity_jid TEXT NULL,
    source TEXT NULL,
    evidence_json TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  // Same-contact grouping persisted by the Google sync (resource name +
  // normalized number only — never raw provider payloads). Mirrors the
  // provider's current state on every sync; auto-connect keys on one
  // resource_name matching two or more archived identities. A grouping
  // disappearing here never disconnects identities it previously connected.
  `CREATE TABLE IF NOT EXISTS google_contact_groups (
    resource_name TEXT NOT NULL,
    phone_e164 TEXT NOT NULL,
    display_name TEXT NULL,
    last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (resource_name, phone_e164)
  ) WITHOUT ROWID`,

  // Externally-held person ids stay resolvable across dissolution and union.
  `CREATE TABLE IF NOT EXISTS person_redirects (
    person_id TEXT PRIMARY KEY,
    replaced_by_person_id TEXT NULL,
    surviving_jid TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_import_warnings_run ON import_warnings (import_run_id, severity, code)`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts (phone_number)`,
  `CREATE INDEX IF NOT EXISTS idx_chats_last_message ON chats (last_message_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_chats_type ON chats (chat_type)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_participants_contact ON chat_participants (contact_id, chat_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages (chat_id, timestamp_ms, id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_sender_jid ON messages (sender_source_jid)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_participants_source_jid ON chat_participants (source_jid)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_sender_time ON messages (chat_id, sender_contact_id, timestamp_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_type_time ON messages (message_type, timestamp_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_live_runs_status ON live_sync_runs (status, started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_live_gap_status ON live_gap_windows (status, chat_source_id, end_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_live_receipts_chat ON live_event_receipts (chat_source_id, occurred_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_live_updates_pending ON live_message_updates (applied, chat_source_id, occurred_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_runs_status ON memory_runs (status, started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_windows_hash ON memory_source_windows (source_hash, status)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_windows_end ON memory_source_windows (status, end_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_revisions_page ON memory_page_revisions (page_id, status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_citations_message ON memory_citations (source_message_key, message_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_issues_run ON memory_validation_issues (run_id, severity, code)`,
  `CREATE INDEX IF NOT EXISTS idx_message_mentions_jid ON message_mentions (mentioned_jid, message_id)`,
  `CREATE INDEX IF NOT EXISTS idx_number_changes_old_new ON identity_number_changes (old_jid, new_jid, observed_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_group_periods_group_person ON group_membership_periods (group_source_id, participant_jid, joined_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_group_events_group_person ON group_membership_events (group_source_id, participant_jid, observed_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_metadata_history_chat ON chat_metadata_history (chat_source_id, observed_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_location_observations_message_order ON message_location_observations (source_message_key, sequence_number, observed_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_vcards_resolved_jid ON message_vcards (resolved_jid, source_message_key)`,
  `CREATE INDEX IF NOT EXISTS idx_edit_events_message ON message_edit_events (source_message_key, observed_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_media_interpretations_message ON message_media_interpretations (source_message_key, kind, segment_index)`,
  `CREATE INDEX IF NOT EXISTS idx_signal_observations_fact ON archive_signal_observations (fact_key, family, observed_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_engagement_chat_identity ON engagement_aggregates (chat_source_id, counterparty_jid)`,
  `CREATE INDEX IF NOT EXISTS idx_quoted_snapshots_referent ON message_quoted_snapshots (quoted_source_chat_id, quoted_source_message_id)`,
  // retrieval-hardening: converge late-arriving quoted originals (lookup by
  // source id alone) and point-look-up originals for the orphan-quote check.
  `CREATE INDEX IF NOT EXISTS idx_quoted_snapshots_source ON message_quoted_snapshots (quoted_source_message_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_source_id ON messages (source_message_id)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_tasks_due ON brain_tasks (status, next_attempt_at_ms, priority, id)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_ledger_day ON brain_llm_ledger (day, purpose)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_runs_status ON brain_runs (status, started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_episodes_chat ON brain_episodes (chat_source_id, status, end_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_episodes_status_end ON brain_episodes (status, end_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_episodes_quote_stale ON brain_episodes (status, extraction_version)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_signal_anchors_message ON brain_episode_signal_anchors (source_message_key, episode_id)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_claims_episode ON brain_claims (episode_id, sequence)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_citations_claim ON brain_citations (claim_id)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_citations_key ON brain_citations (source_message_key)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_claim_entities_claim ON brain_claim_entities (claim_id)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_claim_entities_jid ON brain_claim_entities (jid)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_episode_topics_topic ON brain_episode_topics (topic_id)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_issues_episode ON brain_validation_issues (episode_id)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_issues_code ON brain_validation_issues (code, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_media_gaps_episode ON brain_media_gaps (episode_id)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_media_gaps_modality ON brain_media_gaps (modality, impact)`,
  // Graph traversal contract (graph-explorer/retrieval consumers): bounded
  // k-hop with kind/time/salience filters must be an index walk, not a scan.
  `CREATE INDEX IF NOT EXISTS idx_brain_nodes_kind_status_salience ON brain_nodes (kind, status, salience DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_nodes_jid ON brain_nodes (jid)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_nodes_chat_scope ON brain_nodes (chat_scope)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_edges_src ON brain_edges (src_node_id, kind, last_seen_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_edges_dst ON brain_edges (dst_node_id, kind, last_seen_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_edge_evidence_claim ON brain_edge_evidence (claim_id)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_node_claims_claim ON brain_node_claims (claim_id)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_lifecycle_events_claim ON brain_lifecycle_events (claim_id, id)`,
  // Semantic-consolidation indexes: revision walks per doc and "which docs
  // cite claim X" (staleness/dueness). The superseded-claims partial index is
  // created in migrateAdditiveColumns — the column may not exist yet here on a
  // pre-rollups archive (schemaStatements run before the additive ALTERs).
  `CREATE INDEX IF NOT EXISTS idx_brain_doc_revisions_doc ON brain_doc_revisions (doc_id, revision DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_doc_revision_claims_claim ON brain_doc_revision_claims (claim_id)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_docs_node ON brain_docs (node_id)`,
  // Run-audit indexes: the history list reads per-run effect counts for a whole
  // page of runs at once, so every effect table must be reachable BY run — a
  // scan of brain_episodes (9.4k wide markdown rows on the real archive) per
  // listing is exactly the per-row cost this surface must not pay.
  `CREATE INDEX IF NOT EXISTS idx_brain_lifecycle_events_run ON brain_lifecycle_events (run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_doc_revisions_run ON brain_doc_revisions (run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_episodes_run ON brain_episodes (run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_issues_run ON brain_validation_issues (run_id)`,
  // Candidate-producer indexes (commitment-lifecycle): reactions by target
  // message, pointer replies by their quoted id, and NULL-jid entity names —
  // the closure-candidate sweep over thousands of open nodes must be index
  // walks, never table scans (measured: 2m+ without these on the real archive).
  `CREATE INDEX IF NOT EXISTS idx_live_updates_reaction_key ON live_message_updates (source_message_key) WHERE update_type = 'reaction'`,
  // Composite: the single-column form lost to idx_messages_chat_time in the
  // planner (measured 35s vs 76ms on the real archive) — the chat_id column
  // makes this strictly cheapest for the pointer-reply join.
  `DROP INDEX IF EXISTS idx_messages_quoted_source`,
  `CREATE INDEX IF NOT EXISTS idx_messages_quoted_chat ON messages (quoted_source_message_id, chat_id) WHERE quoted_source_message_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_person_members_person ON person_members (person_id)`,
  `CREATE INDEX IF NOT EXISTS idx_person_suggestions_status ON person_suggestions (status, score DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_person_suggestions_pair ON person_suggestions (jid_low, jid_high)`,
  `CREATE INDEX IF NOT EXISTS idx_google_contact_groups_phone ON google_contact_groups (phone_e164)`,
  // Covering index for the person detectors' activity aggregates: first/last
  // message per sender (and per sender+chat) resolve as index-only scans, so
  // the deterministic passes stay cheap at real-archive scale.
  `CREATE INDEX IF NOT EXISTS idx_messages_sender_activity ON messages (sender_source_jid, timestamp_ms, chat_id)`
];

// Full-text search over messages (brain hot tier): a content-storing FTS5
// table kept in sync by rowid-keyed triggers, so every write path — imports,
// live ingest, edits, tombstones, merges, collapses — maintains the index
// without call-site code. Deliberately NOT external-content: external-content
// deletes must replay the exact previously-indexed values, and any mismatch
// (e.g. rows that predate the index) corrupts the FTS shadow tables — observed
// as "database disk image is malformed" on a real archive. Rowid-keyed deletes
// on a content-storing table are no-ops when the row is absent, which makes
// the triggers safe in every index state, at the cost of duplicating message
// text inside the private archive file. Created after additive column
// migration because the triggers reference messages.resolved_text.
const searchSchemaStatements = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    resolved_text, body, caption, sender, context,
    tokenize='unicode61 remove_diacritics 2', prefix='2 3'
  )`,
  `CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = new.id;
    INSERT INTO messages_fts(rowid, resolved_text, body, caption, sender, context)
    VALUES (new.id, new.resolved_text, new.body, new.caption, new.resolved_sender, new.resolved_context);
  END`,
  `CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.id;
  END`,
  `CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF resolved_text, body, caption, resolved_sender, resolved_context ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = new.id;
    INSERT INTO messages_fts(rowid, resolved_text, body, caption, sender, context)
    VALUES (new.id, new.resolved_text, new.body, new.caption, new.resolved_sender, new.resolved_context);
  END`,
  // Zero-maintenance vocabulary view over the FTS index: per-term document
  // frequencies for the relaxation ladder's drop decisions. Never on the
  // strict query path.
  `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_vocab USING fts5vocab('messages_fts', 'row')`
];

export function initializeSqliteArchive(dbPath = config.archive.sqlitePath): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    configureDatabase(db);
    ensureSchema(db);
  } finally {
    db.close();
  }
}

export function isSqliteArchiveInitialized(dbPath = config.archive.sqlitePath): boolean {
  if (!fs.existsSync(dbPath)) {
    return false;
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sqlite_master
         WHERE type = 'table' AND name IN ('import_runs', 'contacts', 'chats', 'messages')`
      )
      .get() as { count: number };
    return Number(rows.count ?? 0) >= 4;
  } finally {
    db.close();
  }
}

export class SqliteArchiveRepository implements ArchiveRepository {
  private readonly db: Database.Database;
  private legacyArchive = false;
  private readonly identityLinks = new Map<string, string>();
  private cachedFtsState: SearchIndexState | null = null;
  // Bidirectional alias-group cache; invalidated whenever the table changes.
  private termAliasCache: Map<string, string[]> | null = null;
  // brain-correctness-debts D7: bound the cost of the coverage scan, which the
  // client refetches on every archive-updated SSE. A short TTL collapses a
  // burst of history-sync refreshes into at most one scan per interval;
  // invalidation on any brain write keeps post-run/post-merge status immediate.
  private brainStatusCache: { at: number; value: BrainStatusSummary } | null = null;
  private static readonly BRAIN_STATUS_TTL_MS = 1000;

  constructor(private readonly dbPath = config.archive.sqlitePath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    configureDatabase(this.db);
    ensureSchema(this.db);
    this.initializeIdentityState();
    this.backfillMaskedContactLabels();
  }

  // One-time, idempotent cleanup of masked-number placeholders (e.g.
  // "+91∙∙∙∙∙∙∙∙86") already stored as display names, so existing archives
  // benefit without a re-import. Only display_name is touched — phone_number,
  // JIDs, and messages are untouched, so the full number stays derivable and no
  // archive data is lost. Runs on every startup but is a no-op once clean (the
  // bounded scan over named rows finds nothing to clear).
  private backfillMaskedContactLabels(): void {
    if (this.legacyArchive) {
      return; // writes are refused on a legacy archive; nothing to migrate yet
    }
    const maskedContacts = (
      this.db
        .prepare(`SELECT id, source_jid, display_name FROM contacts WHERE display_name IS NOT NULL AND TRIM(display_name) <> ''`)
        .all() as Array<{ id: number; source_jid: string; display_name: string }>
    ).filter((row) => isMaskedNumberLabel(row.display_name));
    const maskedChats = (
      this.db
        .prepare(`SELECT id, display_name FROM chats WHERE display_name IS NOT NULL AND TRIM(display_name) <> ''`)
        .all() as Array<{ id: number; display_name: string }>
    ).filter((row) => isMaskedNumberLabel(row.display_name));
    if (maskedContacts.length === 0 && maskedChats.length === 0) {
      return;
    }
    const clearContact = this.db.prepare(`UPDATE contacts SET display_name = NULL, updated_at = ? WHERE id = ?`);
    const clearChat = this.db.prepare(`UPDATE chats SET display_name = NULL, updated_at = ? WHERE id = ?`);
    const now = currentIso();
    // A cleared sender label is embedded in messages.resolved_text (the search
    // index), so those messages must be recomputed or search keeps matching and
    // showing the mask. Bound the recompute to the affected senders, and only
    // when the index is already live — a not-yet-built index recomputes
    // everything on its pending full rebuild.
    const ftsReady = this.getFtsState() === "ready";
    const affectedMessageIds =
      ftsReady && maskedContacts.length > 0
        ? this.messageIdsForSenders(maskedContacts.map((row) => row.source_jid))
        : [];
    const transaction = this.db.transaction(() => {
      for (const row of maskedContacts) {
        clearContact.run(now, row.id);
      }
      for (const row of maskedChats) {
        clearChat.run(now, row.id);
      }
      for (let index = 0; index < affectedMessageIds.length; index += SEARCH_REINDEX_CHUNK) {
        this.syncMessageDerivedState(affectedMessageIds.slice(index, index + SEARCH_REINDEX_CHUNK));
      }
    });
    transaction();
    console.log(
      `[demask] cleared masked display names: ${maskedContacts.length} contact(s), ${maskedChats.length} chat(s)` +
        (affectedMessageIds.length > 0 ? `; recomputed search text for ${affectedMessageIds.length} message(s)` : "")
    );
  }

  // Message ids sent by any of the given sender JIDs, batched under SQLite's
  // bound-variable limit.
  private messageIdsForSenders(jids: string[]): number[] {
    const unique = [...new Set(jids)].filter(Boolean);
    const ids: number[] = [];
    for (let index = 0; index < unique.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = unique.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const rows = this.db
        .prepare(`SELECT id FROM messages WHERE sender_source_jid IN (${batch.map(() => "?").join(",")})`)
        .all(...batch) as Array<{ id: number }>;
      for (const row of rows) {
        ids.push(Number(row.id));
      }
    }
    return ids;
  }

  private initializeIdentityState(): void {
    const stored = (this.db.prepare(`SELECT value FROM schema_meta WHERE key = 'identity_version'`).get() as { value: string } | undefined)?.value;
    if (stored === IDENTITY_VERSION) {
      this.legacyArchive = false;
    } else {
      const messageCount = (this.db.prepare(`SELECT COUNT(*) AS count FROM messages`).get() as { count: number }).count;
      if (messageCount === 0) {
        this.stampIdentityVersion();
      } else {
        this.legacyArchive = true;
      }
    }
    this.identityLinks.clear();
    const rows = this.db.prepare(`SELECT lid, pn FROM identity_links`).all() as Array<{ lid: string; pn: string }>;
    for (const row of rows) {
      this.identityLinks.set(row.lid, row.pn);
    }
  }

  private stampIdentityVersion(): void {
    this.db
      .prepare(
        `INSERT INTO schema_meta (key, value, updated_at) VALUES ('identity_version', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(IDENTITY_VERSION, currentIso());
    this.legacyArchive = false;
  }

  private assertWritableIdentityVersion(): void {
    if (this.legacyArchive) {
      throw new PublicError("ARCHIVE_LEGACY_IDENTITY", LEGACY_ARCHIVE_MESSAGE);
    }
  }

  // Canonical form for any JID: normalized, then LID mapped to its phone form
  // when a persisted link exists. Every write path funnels through this.
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
    if (isLidFormJid(normalized)) {
      return [normalized];
    }
    const rows = this.db.prepare(`SELECT lid FROM identity_links WHERE pn = ?`).all(normalized) as Array<{ lid: string }>;
    return rows.map((row) => row.lid);
  }

  async recordIdentityLinks(links: Array<{ lid: string; pn: string; source?: string | null }>): Promise<string[]> {
    const insert = this.db.prepare(
      `INSERT INTO identity_links (lid, pn, source, learned_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(lid) DO NOTHING`
    );
    const learned: string[] = [];
    for (const link of links) {
      const lid = normalizeJid(link.lid);
      const pn = normalizeJid(link.pn);
      // Links are irrevocable (first write wins) and trigger destructive merges;
      // both sides must be strictly well-formed.
      if (!lid || !pn || lid === pn || !isLidFormJid(lid) || !pn.endsWith("@s.whatsapp.net")) {
        continue;
      }
      const result = insert.run(lid, pn, link.source ?? null, currentIso());
      if (result.changes > 0) {
        this.identityLinks.set(lid, pn);
        learned.push(lid);
      }
    }
    return learned;
  }

  // Identity health scans distinct senders across the whole archive; the UI
  // polls status on every archive change, so cache with a short TTL to keep
  // heavy sync periods responsive (health is advisory, not transactional).
  private identityHealthCache: { atMs: number; value: { unnamedGroups: number; unresolvedLids: number; samples: string[] } } | null = null;

  private async getIdentityHealth(): Promise<{ unnamedGroups: number; unresolvedLids: number; samples: string[] }> {
    const now = Date.now();
    if (this.identityHealthCache && now - this.identityHealthCache.atMs < 15_000) {
      return this.identityHealthCache.value;
    }
    const samples = await this.listUnnamedGroupChats(5);
    const counts = this.db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM chats WHERE chat_type = 'group' AND (display_name IS NULL OR TRIM(display_name) = '' OR display_name = jid)) AS unnamed_groups,
          (SELECT COUNT(*) FROM (
             SELECT source_chat_id AS j FROM chats WHERE source_chat_id LIKE '%@lid' OR source_chat_id LIKE '%@hosted.lid'
             UNION
             SELECT jid AS j FROM (SELECT DISTINCT sender_source_jid AS jid FROM messages WHERE sender_source_jid IS NOT NULL)
             WHERE jid LIKE '%@lid' OR jid LIKE '%@hosted.lid'
           ) WHERE j NOT IN (SELECT lid FROM identity_links)) AS unresolved_lids`
      )
      .get() as { unnamed_groups: number; unresolved_lids: number };
    const value = {
      unnamedGroups: Number(counts.unnamed_groups ?? 0),
      unresolvedLids: Number(counts.unresolved_lids ?? 0),
      samples
    };
    this.identityHealthCache = { atMs: now, value };
    return value;
  }

  // Display-time mention resolution: digits → phone/LID candidates → canonical
  // identity → contact display chain. Unresolved tokens stay unchanged.
  private resolveMentionLabels(texts: Array<string | null>): Map<string, string> {
    const digitsSet = extractMentionDigits(texts);
    if (digitsSet.size === 0) {
      return new Map();
    }
    const digitsByJid = new Map<string, string>();
    for (const digits of digitsSet) {
      for (const candidate of mentionJidCandidates(digits)) {
        const canonical = this.canonicalJid(candidate) ?? candidate;
        if (!digitsByJid.has(canonical)) {
          digitsByJid.set(canonical, digits);
        }
      }
    }
    const jids = [...digitsByJid.keys()];
    const labels = new Map<string, string>();
    for (let index = 0; index < jids.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = jids.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const rows = this.db
        .prepare(
          `SELECT source_jid,
                  ${contactLabelSql()} AS label
           FROM contacts
           WHERE source_jid IN (${batch.map(() => "?").join(",")})`
        )
        .all(...batch) as Array<{ source_jid: string; label: string | null }>;
      for (const row of rows) {
        const digits = digitsByJid.get(row.source_jid);
        if (digits && row.label && !labels.has(digits)) {
          labels.set(digits, row.label);
        }
      }
    }
    return labels;
  }

  // Write-time mention resolution: digits → the canonical identity the mention
  // most plausibly refers to. A candidate that is a known contact wins;
  // otherwise the phone-form candidate stands in until identity links improve.
  private resolveMentionJids(texts: Array<string | null>): Map<string, string> {
    const digitsSet = extractMentionDigits(texts);
    if (digitsSet.size === 0) {
      return new Map();
    }
    const candidatesByDigits = new Map<string, string[]>();
    const allJids = new Set<string>();
    for (const digits of digitsSet) {
      const canonicals = [...new Set(mentionJidCandidates(digits).map((candidate) => this.canonicalJid(candidate) ?? candidate))];
      candidatesByDigits.set(digits, canonicals);
      for (const jid of canonicals) {
        allJids.add(jid);
      }
    }
    const known = new Set<string>();
    const jids = [...allJids];
    for (let index = 0; index < jids.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = jids.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const rows = this.db
        .prepare(`SELECT source_jid FROM contacts WHERE source_jid IN (${batch.map(() => "?").join(",")})`)
        .all(...batch) as Array<{ source_jid: string }>;
      for (const row of rows) {
        known.add(row.source_jid);
      }
    }
    const resolved = new Map<string, string>();
    for (const [digits, canonicals] of candidatesByDigits) {
      const hit = canonicals.find((jid) => known.has(jid));
      resolved.set(digits, hit ?? canonicals[0]);
    }
    return resolved;
  }

  // Contact display chain (saved name → push name → phone) for a JID batch.
  private resolveContactLabels(jids: string[]): Map<string, string> {
    const labels = new Map<string, string>();
    const unique = [...new Set(jids)].filter(Boolean);
    for (let index = 0; index < unique.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = unique.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const rows = this.db
        .prepare(
          `SELECT source_jid,
                  ${contactLabelSql()} AS label
           FROM contacts
           WHERE source_jid IN (${batch.map(() => "?").join(",")})`
        )
        .all(...batch) as Array<{ source_jid: string; label: string | null }>;
      for (const row of rows) {
        if (row.label) {
          labels.set(row.source_jid, row.label);
        }
      }
    }
    return labels;
  }

  // Person keys for a JID batch on the read path (sync): person id when the
  // identity is a member, else the jid itself — a lone identity is its own
  // person.
  private personKeysSync(jids: string[]): Map<string, string> {
    const result = new Map<string, string>();
    const unique = [...new Set(jids.filter(Boolean))];
    for (let index = 0; index < unique.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = unique.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const rows = this.db
        .prepare(`SELECT identity_jid AS jid, person_id AS personId FROM person_members WHERE identity_jid IN (${batch.map(() => "?").join(",")})`)
        .all(...batch) as Array<{ jid: string; personId: string }>;
      for (const row of rows) {
        result.set(row.jid, row.personId);
      }
    }
    for (const jid of unique) {
      if (!result.has(jid)) {
        result.set(jid, jid);
      }
    }
    return result;
  }

  // Render-time person disambiguation over one response's label list
  // (identity-and-naming-integrity): entries sharing a label across DIFFERENT
  // persons gain a deterministic complete-number suffix; two identities of
  // one person never disambiguate against each other. Entries with a null
  // label (or null jid) pass through untouched.
  private disambiguateEntryLabels(entries: Array<{ label: string | null; jid: string | null }>): Array<string | null> {
    const keys = this.personKeysSync(entries.map((entry) => entry.jid ?? "").filter(Boolean));
    return disambiguateLabels(
      entries.map((entry) => ({
        label: entry.jid ? entry.label : null,
        jid: entry.jid,
        personKey: entry.jid ? keys.get(entry.jid) ?? entry.jid : "no-identity"
      }))
    );
  }

  // Display-level unconfirmed hints for DM counterparties: the best pending
  // suggestion at or above the configured score. Read path only.
  private chatHintsSync(jids: string[]): Map<string, string> {
    const hints = new Map<string, string>();
    const unique = [...new Set(jids.filter(Boolean))];
    for (let index = 0; index < unique.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = unique.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT jid_low AS jidLow, jid_high AS jidHigh, score FROM person_suggestions
           WHERE status = 'pending' AND score >= ? AND (jid_low IN (${placeholders}) OR jid_high IN (${placeholders}))
           ORDER BY score DESC`
        )
        .all(config.persons.hintScoreThreshold, ...batch, ...batch) as Array<{ jidLow: string; jidHigh: string; score: number }>;
      for (const row of rows) {
        for (const jid of batch) {
          if ((row.jidLow === jid || row.jidHigh === jid) && !hints.has(jid)) {
            const otherJid = row.jidLow === jid ? row.jidHigh : row.jidLow;
            hints.set(jid, `possibly the same as ${this.labelForJid(otherJid)} — unconfirmed`);
          }
        }
      }
    }
    return hints;
  }

  // The owner's saved name, read synchronously for use inside transactions.
  private readOwnerNameSync(): string | null {
    const row = this.db.prepare(`SELECT value FROM schema_meta WHERE key = 'owner_display_name'`).get() as
      | { value: string }
      | undefined;
    return row?.value?.trim() || null;
  }

  // Recompute derived search state (resolved_text + resolved_sender +
  // resolved_context + message_mentions) for a set of messages from their
  // FINAL stored content. Runs inside the caller's transaction; FTS follows
  // via the update trigger. Rows whose derived state is already correct are
  // left untouched (no index churn).
  private syncMessageDerivedState(messageIds: number[], explicitMentionsById?: Map<number, string[]>): void {
    if (messageIds.length === 0) {
      return;
    }
    const rows: Array<{
      id: number;
      source_message_key: string;
      body: string | null;
      caption: string | null;
      media_name: string | null;
      sender_source_jid: string | null;
      from_me: number | null;
      resolved_text: string | null;
      resolved_sender: string | null;
      resolved_context: string | null;
      chat_source_id: string;
    }> = [];
    const unique = [...new Set(messageIds)];
    for (let index = 0; index < unique.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = unique.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      rows.push(
        ...(this.db
          .prepare(
            `SELECT m.id, m.source_message_key, m.body, m.caption, m.media_name, m.sender_source_jid, m.from_me,
                    m.resolved_text, m.resolved_sender, m.resolved_context, ch.source_chat_id AS chat_source_id
             FROM messages m JOIN chats ch ON ch.id = m.chat_id
             WHERE m.id IN (${batch.map(() => "?").join(",")})`
          )
          .all(...batch) as typeof rows)
      );
    }
    const ownerName = this.readOwnerNameSync();
    const texts = rows.flatMap((row) => [row.body, row.caption]);
    const mentionLabels = this.resolveMentionLabels(texts);
    const mentionJids = this.resolveMentionJids(texts);
    const senderLabels = this.resolveContactLabels(
      rows.map((row) => row.sender_source_jid).filter((jid): jid is string => Boolean(jid))
    );
    // Context inputs: link previews and quoted snapshots for these rows, plus
    // a point probe for each quoted original ("is it archived and live?").
    const keys = rows.map((row) => row.source_message_key);
    const previews = new Map<string, { title: string | null; description: string | null; canonical_url: string | null }>();
    const snapshots = new Map<
      string,
      { quoted_source_message_id: string | null; quoted_source_chat_id: string | null; body: string | null; caption: string | null }
    >();
    for (let index = 0; index < keys.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = keys.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      const previewRows = this.db
        .prepare(`SELECT message_key, title, description, canonical_url FROM message_link_previews WHERE message_key IN (${placeholders})`)
        .all(...batch) as Array<{ message_key: string; title: string | null; description: string | null; canonical_url: string | null }>;
      for (const preview of previewRows) {
        previews.set(preview.message_key, preview);
      }
      const snapshotRows = this.db
        .prepare(
          `SELECT reply_message_key, quoted_source_message_id, quoted_source_chat_id, body, caption
           FROM message_quoted_snapshots WHERE reply_message_key IN (${placeholders})`
        )
        .all(...batch) as Array<{
        reply_message_key: string;
        quoted_source_message_id: string | null;
        quoted_source_chat_id: string | null;
        body: string | null;
        caption: string | null;
      }>;
      for (const snapshot of snapshotRows) {
        snapshots.set(snapshot.reply_message_key, snapshot);
      }
    }
    const originalProbe = this.db.prepare(
      `SELECT m2.is_deleted FROM messages m2 JOIN chats ch2 ON ch2.id = m2.chat_id
       WHERE m2.source_message_id = ? AND ch2.source_chat_id = ? LIMIT 1`
    );
    const updateResolved = this.db.prepare(
      `UPDATE messages SET resolved_text = ?, resolved_sender = ?, resolved_context = ? WHERE id = ?`
    );
    const selectMentions = this.db.prepare(`SELECT mentioned_jid, source_mask FROM message_mentions WHERE message_id = ?`);
    const deleteMentions = this.db.prepare(`DELETE FROM message_mentions WHERE message_id = ?`);
    const insertMention = this.db.prepare(`INSERT OR REPLACE INTO message_mentions (message_id, mentioned_jid, source_mask) VALUES (?, ?, ?)`);
    for (const row of rows) {
      // The owner's messages index under the owner's saved name — never under
      // the importer's "me" sentinel contact (display name "Me").
      const isSelf = row.sender_source_jid === "me" || Boolean(row.from_me);
      const senderLabel = isSelf
        ? ownerName
        : row.sender_source_jid
          ? senderLabels.get(row.sender_source_jid) ?? displayPhoneFromJid(row.sender_source_jid)
          : null;
      const resolved = composeResolvedText(row.body, row.caption, row.media_name, mentionLabels);
      // Sender is indexed only for rows with visible content (same guard as
      // the old co-mingled form): system noise must not match name queries.
      const resolvedSender = resolved != null ? senderLabel?.trim() || null : null;
      const snapshot = snapshots.get(row.source_message_key) ?? null;
      let orphanQuote: { body: string | null; caption: string | null } | null = null;
      if (snapshot && (snapshot.body?.trim() || snapshot.caption?.trim())) {
        const sourceChat = snapshot.quoted_source_chat_id ?? row.chat_source_id;
        const original = snapshot.quoted_source_message_id
          ? (originalProbe.get(snapshot.quoted_source_message_id, sourceChat) as { is_deleted: number } | undefined)
          : undefined;
        if (!original || Boolean(original.is_deleted)) {
          orphanQuote = { body: snapshot.body, caption: snapshot.caption };
        }
      }
      const preview = previews.get(row.source_message_key);
      const resolvedContext = composeResolvedContext(
        orphanQuote,
        preview ? { title: preview.title, description: preview.description, canonicalUrl: preview.canonical_url } : null
      );
      if (
        (resolved ?? null) !== (row.resolved_text ?? null) ||
        (resolvedSender ?? null) !== (row.resolved_sender ?? null) ||
        (resolvedContext ?? null) !== (row.resolved_context ?? null)
      ) {
        updateResolved.run(resolved, resolvedSender, resolvedContext, row.id);
      }
      const desired = new Map<string, number>();
      for (const jid of explicitMentionsById?.get(row.id) ?? []) {
        desired.set(jid, (desired.get(jid) ?? 0) | 2);
      }
      for (const digits of extractMentionDigits([row.body, row.caption])) {
        const jid = mentionJids.get(digits);
        if (jid) {
          desired.set(jid, (desired.get(jid) ?? 0) | 1);
        }
      }
      // Structured observations remain authoritative across a derived-state
      // recompute that does not carry a fresh MessageRecord batch.
      const existing = selectMentions.all(row.id) as Array<{ mentioned_jid: string; source_mask: number }>;
      for (const mention of existing) {
        if ((Number(mention.source_mask) & 2) !== 0 && !desired.has(mention.mentioned_jid)) {
          desired.set(mention.mentioned_jid, 2);
        }
      }
      if (
        existing.length !== desired.size ||
        existing.some((mention) => Number(mention.source_mask) !== (desired.get(mention.mentioned_jid) ?? 0))
      ) {
        deleteMentions.run(row.id);
        for (const [jid, sourceMask] of desired) {
          insertMention.run(row.id, jid, sourceMask);
        }
      }
    }
  }

  private getFtsState(): SearchIndexState {
    if (this.cachedFtsState === null) {
      const row = this.db.prepare(`SELECT value FROM schema_meta WHERE key = 'fts_state'`).get() as { value: string } | undefined;
      this.cachedFtsState = row?.value === "ready" ? "ready" : "needs_rebuild";
    }
    return this.cachedFtsState;
  }

  private setFtsState(state: SearchIndexState): void {
    this.db
      .prepare(
        `INSERT INTO schema_meta (key, value, updated_at) VALUES ('fts_state', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(state, currentIso());
    this.cachedFtsState = state;
  }

  async getSearchIndexStatus(): Promise<SearchIndexStatus> {
    const totals = this.db.prepare(`SELECT COUNT(*) AS count FROM messages`).get() as { count: number };
    return { state: this.getFtsState(), totalMessages: Number(totals.count ?? 0) };
  }

  async searchMessages(options: SearchQueryOptions): Promise<SearchResponse> {
    const index = await this.getSearchIndexStatus();
    if (index.state !== "ready") {
      throw new PublicError(
        "SEARCH_INDEX_NOT_BUILT",
        "The search index has not been built for this archive yet. Run the search reindex to enable global search."
      );
    }
    const tokens = attachAliasVariants(tokenizeSearchQuery(options.query), (norm) => this.lookupTermAliases(norm));
    if (tokens.length === 0) {
      return { index, totalMatches: 0, results: [], matchTier: "exact", relaxation: null };
    }
    // First WHERE clause is the per-plan MATCH placeholder; `params` holds
    // only the filter bindings (the match string is bound per ladder tier).
    const where = ["messages_fts MATCH ?"];
    const params: unknown[] = [];
    if (options.chatId != null) {
      where.push("m.chat_id = ?");
      params.push(options.chatId);
    }
    if (options.sender) {
      const sender = options.sender.trim();
      if (sender.includes("@")) {
        where.push("m.sender_source_jid = ?");
        params.push(this.canonicalJid(sender) ?? sender);
      } else {
        where.push("(c.display_name LIKE ? OR c.push_name LIKE ? OR c.phone_number LIKE ?)");
        params.push(`%${sender}%`, `%${sender}%`, `%${sender.replace(/\D/g, "") || sender}%`);
      }
    }
    if (options.afterMs != null) {
      where.push("m.timestamp_ms >= ?");
      params.push(options.afterMs);
    }
    if (options.beforeMs != null) {
      where.push("m.timestamp_ms <= ?");
      params.push(options.beforeMs);
    }
    if (options.type === "text") {
      where.push("m.has_media = 0 AND m.message_type <> 'call'");
    } else if (options.type === "media") {
      where.push("(m.has_media = 1 OR m.message_type IN ('image','video','audio','document','sticker','view_once','ptv'))");
    } else if (options.type === "call") {
      where.push("m.message_type = 'call'");
    }
    if (options.direction) {
      where.push("m.direction = ?");
      params.push(options.direction);
    }
    if (!options.includeNoise) {
      where.push(visibleExchangePredicate("m"));
    }
    const whereSql = where.join(" AND ");
    // Exact archive-wide match count per attempted tier (same predicate, no
    // ranking work). Counts always describe the tier that produced results.
    const countStmt = this.db.prepare(
      `SELECT COUNT(*) AS count
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       JOIN chats ch ON ch.id = m.chat_id
       LEFT JOIN contacts c ON c.source_jid = m.sender_source_jid
       WHERE ${whereSql}`
    );
    const countForMatch = (match: string): number => Number((countStmt.get(match, ...params) as { count: number }).count ?? 0);
    // Relaxation ladder: strict first; looser tiers run only while results
    // are below the acceptance threshold (default: only on zero hits).
    const minHits = Math.max(1, Math.floor(options.minHits ?? 1));
    let winner: TierPlan | null = null;
    let winnerCount = 0;
    let fallback: { plan: TierPlan; count: number } | null = null;
    const tryPlans = (plans: TierPlan[]): boolean => {
      for (const plan of plans) {
        const count = countForMatch(plan.match);
        if (count >= minHits) {
          winner = plan;
          winnerCount = count;
          return true;
        }
        if (count > 0 && !fallback) {
          fallback = { plan, count };
        }
      }
      return false;
    };
    const basePlans = buildBasePlans(tokens);
    if (!tryPlans(basePlans)) {
      const dfByNorm = new Map<string, number>();
      for (const token of tokens) {
        if (!token.quoted) {
          dfByNorm.set(token.norm, this.effectiveTokenDf(token));
        }
      }
      tryPlans(buildDroppedPlans(tokens, dfByNorm, new Set(basePlans.map((plan) => plan.match))));
    }
    if (!winner && fallback) {
      const best = fallback as { plan: TierPlan; count: number };
      winner = best.plan;
      winnerCount = best.count;
    }
    if (!winner) {
      return { index, totalMatches: 0, results: [], matchTier: "exact", relaxation: null };
    }
    const winningPlan: TierPlan = winner;
    const totalMatches = winnerCount;
    // Dual candidate pool (retrieval-hardening): the top pool by BM25 union
    // the most-recent matches, deduped by rowid — "best-matching AND most-
    // recent are always considered" is an explicit guarantee, not a hope.
    // Reranked in JS with recency decay; deterministic paging inside the
    // union; offsets beyond it return empty.
    const selectSql = `SELECT m.id, m.source_message_key, m.source_message_id, m.chat_id, m.sender_source_jid,
                m.timestamp_ms, m.sent_at, m.direction, m.message_type, m.is_deleted, m.has_media, m.body, m.caption,
                m.resolved_text, m.resolved_sender, m.resolved_context,
                ch.source_chat_id AS chat_source_id, ch.display_name AS chat_display_name, ch.chat_type,
                ${contactLabelSql("c.")} AS sender_display_name,
                bm25(messages_fts, 3.0, 2.0, 1.0, 0.5, 1.0) AS rank,
                snippet(messages_fts, 0, ?, ?, '…', 14) AS snip_resolved,
                snippet(messages_fts, 1, ?, ?, '…', 14) AS snip_body,
                snippet(messages_fts, 2, ?, ?, '…', 14) AS snip_caption,
                snippet(messages_fts, 4, ?, ?, '…', 14) AS snip_context
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         JOIN chats ch ON ch.id = m.chat_id
         LEFT JOIN contacts c ON c.source_jid = m.sender_source_jid
         WHERE ${whereSql}`;
    const snippetParams = [
      SEARCH_HIGHLIGHT_START,
      SEARCH_HIGHLIGHT_END,
      SEARCH_HIGHLIGHT_START,
      SEARCH_HIGHLIGHT_END,
      SEARCH_HIGHLIGHT_START,
      SEARCH_HIGHLIGHT_END,
      SEARCH_HIGHLIGHT_START,
      SEARCH_HIGHLIGHT_END
    ];
    const relevanceRows = this.db
      .prepare(`${selectSql} ORDER BY rank LIMIT ${SEARCH_CANDIDATE_POOL}`)
      .all(...snippetParams, winningPlan.match, ...params) as SqliteSearchRow[];
    // The recency pass is skipped when the relevance pool already saw every
    // match — the union would be a no-op.
    const recencyRows =
      totalMatches > SEARCH_CANDIDATE_POOL
        ? (this.db
            .prepare(`${selectSql} ORDER BY (m.timestamp_ms IS NULL), m.timestamp_ms DESC, m.id DESC LIMIT ${SEARCH_RECENCY_POOL}`)
            .all(...snippetParams, winningPlan.match, ...params) as SqliteSearchRow[])
        : [];
    const byId = new Map<number, SqliteSearchRow>();
    for (const row of [...relevanceRows, ...recencyRows]) {
      if (!byId.has(Number(row.id))) {
        byId.set(Number(row.id), row);
      }
    }
    const rows = [...byId.values()];
    // Entity boost: authoritative structured mentions (source_mask bit 2)
    // whose resolved label matches a query term lift the row at rerank.
    const mentionBoosted = this.mentionBoostedMessageIds(rows.map((row) => Number(row.id)), tokens);
    const nowMs = Date.now();
    const mentionLabels = this.resolveMentionLabels(rows.map((row) => row.body));
    const partialTier = winningPlan.matchTier === "partial";
    const scored = rows.map((row) => {
      // FTS5 bm25() is negative for matches; smaller = better.
      const relevance = Math.max(0, -Number(row.rank));
      const ageDays = row.timestamp_ms != null ? Math.max(0, (nowMs - Number(row.timestamp_ms)) / 86_400_000) : 365;
      const recency = 0.2 + 0.8 * Math.pow(0.5, ageDays / 90);
      const boost = mentionBoosted.has(Number(row.id)) ? SEARCH_MENTION_BOOST : 0;
      const score = relevance * recency + boost;
      const snippetRaw = pickSnippet(row);
      // Display-grade match anatomy: which strata carried highlights, whether
      // the sender label alone matched, and (on partial tiers) how many of
      // the query's terms this row actually covers.
      const contentMatched = [row.snip_resolved, row.snip_body, row.snip_caption, row.snip_context].some((snip) =>
        Boolean(snip && snip.includes(SEARCH_HIGHLIGHT_START))
      );
      const senderWords = normalizedWords(`${row.resolved_sender ?? ""} ${row.sender_display_name ?? ""}`);
      const senderMatched = senderWords.length > 0 && tokens.some((token) => tokenLenientlyMatchesWords(token, senderWords));
      const senderOnlyMatch = senderMatched && !contentMatched ? true : undefined;
      const termCoverage = partialTier
        ? countTermCoverage(
            tokens,
            normalizedWords(
              [row.resolved_text, row.body, row.caption, row.resolved_sender, row.sender_display_name, row.resolved_context]
                .filter(Boolean)
                .join("\n")
            )
          )
        : undefined;
      return {
        item: {
          layer: "message" as const,
          messageId: Number(row.id),
          sourceMessageKey: row.source_message_key,
          sourceMessageId: row.source_message_id,
          chatId: Number(row.chat_id),
          chatSourceId: row.chat_source_id,
          chatDisplayName:
            row.chat_display_name && row.chat_display_name !== row.chat_source_id
              ? row.chat_display_name
              : displayPhoneFromJid(row.chat_source_id),
          chatType: row.chat_type as SearchResultItem["chatType"],
          senderDisplayName: row.sender_display_name ?? displayPhoneFromJid(row.sender_source_jid),
          senderSourceJid: row.sender_source_jid,
          timestampMs: row.timestamp_ms == null ? null : Number(row.timestamp_ms),
          sentAt: row.sent_at,
          direction: row.direction as SearchResultItem["direction"],
          messageType: row.message_type,
          interpretation: interpretMessage({
            messageType: row.message_type,
            isDeleted: Boolean(row.is_deleted),
            hasHeldContent: Boolean(row.body?.trim() || row.has_media),
            mediaAvailability: null
          }),
          snippet: applyMentionLabels(snippetRaw, mentionLabels) ?? snippetRaw,
          score,
          hasMedia: Boolean(row.has_media),
          isDeleted: Boolean(row.is_deleted),
          ...(senderOnlyMatch ? { senderOnlyMatch } : {}),
          ...(termCoverage ? { termCoverage } : {})
        },
        score,
        coverage: termCoverage?.matched ?? 0
      };
    });
    // On the ranked-OR tier, rows covering more of the query's terms outrank
    // any single-term hit regardless of its BM25 rarity spike — the "multi-
    // token rows surface first" guarantee, made explicit.
    if (winningPlan.requireAll) {
      scored.sort((a, b) => b.score - a.score);
    } else {
      scored.sort((a, b) => b.coverage - a.coverage || b.score - a.score);
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
      totalMatches,
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

  // Of the given pool ids, those carrying an authoritative structured mention
  // (source_mask bit 2) whose resolved display label matches a query term.
  private mentionBoostedMessageIds(messageIds: number[], tokens: QueryToken[]): Set<number> {
    const boosted = new Set<number>();
    if (messageIds.length === 0 || tokens.length === 0) {
      return boosted;
    }
    const mentionRows: Array<{ message_id: number; mentioned_jid: string }> = [];
    for (let index = 0; index < messageIds.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = messageIds.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      mentionRows.push(
        ...(this.db
          .prepare(
            `SELECT message_id, mentioned_jid FROM message_mentions
             WHERE (source_mask & 2) != 0 AND message_id IN (${batch.map(() => "?").join(",")})`
          )
          .all(...batch) as Array<{ message_id: number; mentioned_jid: string }>)
      );
    }
    if (mentionRows.length === 0) {
      return boosted;
    }
    const labels = this.resolveContactLabels([...new Set(mentionRows.map((row) => row.mentioned_jid))]);
    const wordsByJid = new Map<string, string[]>();
    for (const [jid, label] of labels) {
      wordsByJid.set(jid, normalizedWords(label));
    }
    for (const mention of mentionRows) {
      const words = wordsByJid.get(mention.mentioned_jid) ?? [];
      if (words.length > 0 && tokens.some((token) => tokenLenientlyMatchesWords(token, words))) {
        boosted.add(Number(mention.message_id));
      }
    }
    return boosted;
  }

  // Effective document frequency for one query token at tier-1 looseness: its
  // starred form plus alias variants, straight from the fts5vocab view. Zero
  // means "cannot match anything" (the typo case). Vocab failures degrade to
  // "assume matchable" so the ladder still works without df smarts.
  private effectiveTokenDf(token: QueryToken): number {
    let total = 0;
    for (const alternative of dfProbesForToken(token)) {
      total += this.searchAlternativeDf(alternative);
      if (total > 0 && total >= Number.MAX_SAFE_INTEGER / 2) {
        break;
      }
    }
    return total;
  }

  private searchAlternativeDf(alternative: PlanAlternative): number {
    try {
      if (alternative.prefix) {
        const row = this.db
          .prepare(`SELECT COALESCE(SUM(doc), 0) AS df FROM messages_fts_vocab WHERE term >= ? AND term < ?`)
          .get(alternative.text, `${alternative.text}\uffff`) as { df: number };
        return Number(row?.df ?? 0);
      }
      const row = this.db.prepare(`SELECT doc AS df FROM messages_fts_vocab WHERE term = ?`).get(alternative.text) as
        | { df: number }
        | undefined;
      return Number(row?.df ?? 0);
    } catch {
      return Number.MAX_SAFE_INTEGER / 4;
    }
  }

  // Bidirectional alias groups, cached until the table changes: every member
  // of a (term ∪ variants) group expands to the other members.
  private lookupTermAliases(norm: string): string[] {
    if (!this.termAliasCache) {
      const cache = new Map<string, string[]>();
      const groups = new Map<string, Set<string>>();
      const rows = this.db
        .prepare(`SELECT term, variant FROM brain_term_aliases ORDER BY weight DESC, term, variant`)
        .all() as Array<{ term: string; variant: string }>;
      for (const row of rows) {
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
    const insert = this.db.prepare(`INSERT OR IGNORE INTO brain_term_aliases (term, variant, source, weight) VALUES (?, ?, ?, ?)`);
    let added = 0;
    const apply = this.db.transaction(() => {
      for (const entry of entries) {
        const term = normalizeTerm(entry.term ?? "").trim();
        const variant = normalizeTerm(entry.variant ?? "").trim();
        if (!term || !variant || term === variant) {
          continue;
        }
        const result = insert.run(term, variant, entry.source?.trim() || "manual", entry.weight ?? 1.0);
        if (result.changes > 0) {
          added += 1;
        }
      }
    });
    apply();
    if (added > 0) {
      this.termAliasCache = null;
    }
    return added;
  }

  async rebuildSearchIndex(onProgress?: (processedMessages: number, totalMessages: number) => void): Promise<{ indexedMessages: number }> {
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM messages`).get() as { count: number }).count;
    onProgress?.(0, total);
    // Honest state while the index is incomplete; searches refuse instead of
    // answering from a half-built index.
    this.setFtsState("needs_rebuild");
    // Start from a fresh table: erases any prior index state wholesale,
    // including shadow-table corruption left by the retired external-content
    // design. Triggers keep rows written during the rebuild indexed (rowid-
    // keyed writes are safe in any state), and the ascending id cursor
    // re-covers them idempotently.
    this.db.exec(
      `DROP TABLE IF EXISTS messages_fts;
       ${searchSchemaStatements[0]}`
    );
    let processed = 0;
    let lastId = 0;
    const pageStmt = this.db.prepare(`SELECT id FROM messages WHERE id > ? ORDER BY id LIMIT ${SEARCH_REINDEX_CHUNK}`);
    for (;;) {
      const ids = (pageStmt.all(lastId) as Array<{ id: number }>).map((row) => Number(row.id));
      if (ids.length === 0) {
        break;
      }
      this.db.transaction(() => {
        this.syncMessageDerivedState(ids);
        for (let index = 0; index < ids.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
          const batch = ids.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
          const placeholders = batch.map(() => "?").join(",");
          this.db.prepare(`DELETE FROM messages_fts WHERE rowid IN (${placeholders})`).run(...batch);
          this.db
            .prepare(
              `INSERT INTO messages_fts(rowid, resolved_text, body, caption, sender, context)
               SELECT id, resolved_text, body, caption, resolved_sender, resolved_context FROM messages WHERE id IN (${placeholders})`
            )
            .run(...batch);
        }
      })();
      processed += ids.length;
      lastId = ids[ids.length - 1];
      onProgress?.(Math.min(processed, total), total);
      // Yield between chunks so live ingestion and HTTP stay responsive.
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.setFtsState("ready");
    onProgress?.(total, total);
    return { indexedMessages: total };
  }

  // --- Brain substrate ---

  async getBrainChatBacklog(options: { limit: number; minPending?: number; chatSourceId?: string | null }): Promise<BrainChatBacklogItem[]> {
    // A chat-scoped read (the drain's per-task lookup) must not pay the full
    // 645-chat aggregation — ~400ms of synchronous scan on the real archive.
    const chat = options.chatSourceId ? this.canonicalJid(options.chatSourceId) ?? options.chatSourceId : null;
    const chatClause = chat ? `AND ch.source_chat_id = ?` : "";
    const params: unknown[] = chat
      ? [chat, Math.max(1, options.minPending ?? 1), options.limit]
      : [Math.max(1, options.minPending ?? 1), options.limit];
    const rows = this.db
      .prepare(
        `SELECT ch.source_chat_id AS chat_source_id,
                COALESCE(NULLIF(TRIM(COALESCE(ch.display_name, '')), ''), NULL) AS chat_display_name,
                COALESCE(w.assimilated_through_ms, 0) AS assimilated_through_ms,
                COALESCE(w.assimilated_through_id, 0) AS assimilated_through_id,
                w.last_episode_at AS last_episode_at,
                COUNT(m.id) AS pending,
                MAX(m.timestamp_ms) AS newest_ms
         FROM chats ch
         LEFT JOIN brain_chat_watermarks w ON w.chat_source_id = ch.source_chat_id
         JOIN messages m ON m.chat_id = ch.id
         WHERE ${watermarkPendingPredicate("m", "w")}
           AND ${visibleExchangePredicate("m")}
           ${chatClause}
         GROUP BY ch.id
         HAVING COUNT(m.id) >= ?
         ORDER BY pending DESC
         LIMIT ?`
      )
      .all(...params) as Array<{
      chat_source_id: string;
      chat_display_name: string | null;
      assimilated_through_ms: number;
      assimilated_through_id: number;
      last_episode_at: string | null;
      pending: number;
      newest_ms: number | null;
    }>;
    return rows.map((row) => ({
      chatSourceId: row.chat_source_id,
      chatDisplayName: row.chat_display_name,
      assimilatedThroughMs: Number(row.assimilated_through_ms ?? 0),
      assimilatedThroughId: Number(row.assimilated_through_id ?? 0),
      lastEpisodeAt: row.last_episode_at,
      pendingVisibleMessages: Number(row.pending),
      newestVisibleMs: row.newest_ms == null ? null : Number(row.newest_ms)
    }));
  }

  // The rowid half of the cursor: every message seen at or below `throughMs`
  // in this chat. A later message sharing `throughMs` gets a higher rowid and
  // stays pending, which is exactly how the tie boundary is disambiguated.
  private boundaryRowidForChat(chatSourceId: string, throughMs: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(m.id), 0) AS id
         FROM messages m JOIN chats ch ON ch.id = m.chat_id
         WHERE ch.source_chat_id = ? AND COALESCE(m.timestamp_ms, 0) <= ?`
      )
      .get(chatSourceId, throughMs) as { id: number } | undefined;
    return Number(row?.id ?? 0);
  }

  // Watermarks never regress: a replayed commit can only move the compound
  // (timestamp, rowid) cursor forward, keeping the greater cursor lexicographically.
  async advanceBrainWatermark(chatSourceId: string, throughMs: number): Promise<void> {
    const canonical = this.canonicalJid(chatSourceId) ?? chatSourceId;
    const throughId = this.boundaryRowidForChat(canonical, throughMs);
    this.db.prepare(WATERMARK_CURSOR_UPSERT).run(canonical, throughMs, throughId, currentIso(), currentIso());
    this.invalidateBrainStatusCache();
  }

  async enqueueBrainTasks(tasks: BrainTaskInput[]): Promise<number> {
    if (tasks.length === 0) {
      return 0;
    }
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO brain_tasks (kind, chat_source_id, payload_json, dedupe_key, priority)
       VALUES (?, ?, ?, ?, ?)`
    );
    let enqueued = 0;
    const transaction = this.db.transaction(() => {
      for (const task of tasks) {
        const result = insert.run(task.kind, task.chatSourceId ?? null, stringifyJson(task.payload ?? null), task.dedupeKey, task.priority ?? 0);
        enqueued += result.changes;
      }
    });
    transaction();
    return enqueued;
  }

  async claimDueBrainTasks(limit: number, nowMs = Date.now(), kind?: BrainTaskKind): Promise<BrainTaskRecord[]> {
    const claimed: BrainTaskRecord[] = [];
    const kindClause = kind ? "AND kind = ?" : "";
    const params: unknown[] = kind ? [nowMs, kind, limit] : [nowMs, limit];
    const transaction = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id, kind, chat_source_id, payload_json, dedupe_key, status, priority, attempts, next_attempt_at_ms, last_error
           FROM brain_tasks
           WHERE status = 'pending' AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?) ${kindClause}
           ORDER BY priority DESC, id ASC
           LIMIT ?`
        )
        .all(...params) as SqliteBrainTaskRow[];
      const claim = this.db.prepare(`UPDATE brain_tasks SET status = 'running', claimed_at_ms = ?, updated_at = ? WHERE id = ?`);
      for (const row of rows) {
        claim.run(nowMs, currentIso(), row.id);
        claimed.push(rowToBrainTask(row));
      }
    });
    transaction();
    return claimed;
  }

  async completeBrainTask(id: number): Promise<void> {
    this.db.prepare(`UPDATE brain_tasks SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?`).run(currentIso(), id);
  }

  async failBrainTask(id: number, error: string, options?: { retryInMs?: number | null }): Promise<void> {
    if (options?.retryInMs != null) {
      this.db
        .prepare(
          `UPDATE brain_tasks
           SET status = 'pending', attempts = attempts + 1, next_attempt_at_ms = ?, last_error = ?, claimed_at_ms = NULL, updated_at = ?
           WHERE id = ?`
        )
        .run(Date.now() + options.retryInMs, error, currentIso(), id);
    } else {
      this.db
        .prepare(`UPDATE brain_tasks SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`)
        .run(error, currentIso(), id);
    }
  }

  async resetInFlightBrainTasks(staleClaimMs = 30 * 60_000): Promise<number> {
    const result = this.db
      .prepare(
        `UPDATE brain_tasks SET status = 'pending', claimed_at_ms = NULL, updated_at = ?
         WHERE status = 'running' AND (claimed_at_ms IS NULL OR claimed_at_ms <= ?)`
      )
      .run(currentIso(), Date.now() - staleClaimMs);
    return result.changes;
  }

  async getBrainTaskSummary(): Promise<BrainTaskSummary> {
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS count FROM brain_tasks GROUP BY status`).all() as Array<{
      status: string;
      count: number;
    }>;
    const summary: BrainTaskSummary = { pending: 0, running: 0, failed: 0, done: 0 };
    for (const row of rows) {
      if (row.status in summary) {
        summary[row.status as keyof BrainTaskSummary] = Number(row.count);
      }
    }
    return summary;
  }

  async getArchiveOwnerName(): Promise<string | null> {
    const row = this.db.prepare(`SELECT value FROM schema_meta WHERE key = 'owner_display_name'`).get() as
      | { value: string }
      | undefined;
    return row?.value?.trim() || null;
  }

  async setArchiveOwnerName(displayName: string | null): Promise<void> {
    const trimmed = displayName?.trim();
    if (!trimmed) {
      this.db.prepare(`DELETE FROM schema_meta WHERE key = 'owner_display_name'`).run();
      return;
    }
    this.db
      .prepare(
        `INSERT INTO schema_meta (key, value, updated_at) VALUES ('owner_display_name', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(trimmed, currentIso());
  }

  // --- Owner self-identities (brain-run-console) --------------------------
  // Canonical identity JIDs the evidence labeler treats as the owner with
  // absolute precedence over saved contact names. Stored beside the owner
  // display name in schema_meta; read canonicalized so identity merges are
  // always already applied.

  private readOwnerSelfJids(): string[] {
    const row = this.db.prepare(`SELECT value FROM schema_meta WHERE key = 'owner_self_jids'`).get() as
      | { value: string }
      | undefined;
    if (!row?.value) {
      return [];
    }
    try {
      const parsed = JSON.parse(row.value) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      const jids: string[] = [];
      for (const entry of parsed) {
        if (typeof entry !== "string") {
          continue;
        }
        const canonical = this.canonicalJid(entry) ?? entry;
        if (!jids.includes(canonical)) {
          jids.push(canonical);
        }
      }
      return jids;
    } catch {
      return [];
    }
  }

  private ownerSelfIdentityRecord(jid: string): OwnerSelfIdentity {
    const contact = this.db
      .prepare(`SELECT display_name AS displayName, push_name AS pushName, phone_number AS phoneNumber FROM contacts WHERE source_jid = ?`)
      .get(jid) as { displayName: string | null; pushName: string | null; phoneNumber: string | null } | undefined;
    const number = displayPhoneFromJid(jid) ?? `+${(jid.split("@")[0] ?? "").replace(/\D/g, "")}`;
    const label = contact
      ? resolveDisplayLabel({ displayName: contact.displayName, pushName: contact.pushName, phoneNumber: contact.phoneNumber, jid })
      : null;
    // currentLabel is the mistake-prevention surface: what the archive would
    // call this number WITHOUT self precedence. A bare-number label carries no
    // warning value, so it reads as null.
    const currentLabel = label && label !== number && !/^\+?\d[\d\s]*$/.test(label) ? label : null;
    const messageCount = Number(
      (this.db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE sender_source_jid = ?`).get(jid) as { count: number }).count
    );
    return { jid, number, currentLabel, messageCount };
  }

  async getArchiveOwnerSelfIdentities(): Promise<OwnerSelfIdentity[]> {
    return this.readOwnerSelfJids().map((jid) => this.ownerSelfIdentityRecord(jid));
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
    if (jids.length === 0) {
      this.db.prepare(`DELETE FROM schema_meta WHERE key = 'owner_self_jids'`).run();
    } else {
      this.db
        .prepare(
          `INSERT INTO schema_meta (key, value, updated_at) VALUES ('owner_self_jids', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        )
        .run(JSON.stringify(jids), currentIso());
    }
    return jids.map((jid) => this.ownerSelfIdentityRecord(jid));
  }

  async listOwnerIdentitySuggestions(query: string, limit = 12): Promise<OwnerIdentitySuggestion[]> {
    const q = query.trim();
    if (q.length < 2) {
      return [];
    }
    // Plain substring matching, deliberately: digits against the JID, text
    // against saved/push names. LIKE wildcards in user input are neutralized.
    const digits = q.replace(/\D/g, "");
    const digitsLike = digits.length >= 2 ? `%${digits}%` : null;
    const nameLike = `%${q.toLowerCase().replace(/[%_]/g, " ").trim()}%`;
    const rows = this.db
      .prepare(
        `SELECT c.source_jid AS jid, c.display_name AS displayName, c.push_name AS pushName, c.phone_number AS phoneNumber,
                (SELECT COUNT(*) FROM messages m WHERE m.sender_source_jid = c.source_jid) AS messageCount
         FROM contacts c
         WHERE (c.source_jid LIKE '%@s.whatsapp.net' OR c.source_jid LIKE '%@lid' OR c.source_jid LIKE '%@hosted.lid')
           AND ((? IS NOT NULL AND c.source_jid LIKE ?) OR lower(COALESCE(c.display_name, '')) LIKE ? OR lower(COALESCE(c.push_name, '')) LIKE ?)
         ORDER BY messageCount DESC, c.source_jid
         LIMIT ?`
      )
      .all(digitsLike, digitsLike ?? "", nameLike, nameLike, Math.max(1, Math.min(25, limit))) as Array<{
      jid: string;
      displayName: string | null;
      pushName: string | null;
      phoneNumber: string | null;
      messageCount: number;
    }>;
    const selfJids = new Set(this.readOwnerSelfJids());
    return rows.map((row) => ({
      jid: row.jid,
      number: displayPhoneFromJid(row.jid) ?? `+${(row.jid.split("@")[0] ?? "").replace(/\D/g, "")}`,
      label: resolveDisplayLabel({ displayName: row.displayName, pushName: row.pushName, phoneNumber: row.phoneNumber, jid: row.jid }),
      messageCount: Number(row.messageCount ?? 0),
      isSelf: selfJids.has(this.canonicalJid(row.jid) ?? row.jid)
    }));
  }

  async reconcileBrainRuns(): Promise<number> {
    const transaction = this.db.transaction(() => {
      // A brain lock held by a run we are about to mark interrupted belongs to
      // a provably dead process (backfill locks are keyed by run id) — release
      // it now so kill-resume never waits out the TTL.
      this.db
        .prepare(
          `DELETE FROM memory_job_locks
           WHERE name = 'brain' AND run_id IN (SELECT id FROM brain_runs WHERE status = 'running')`
        )
        .run();
      return this.db
        .prepare(
          `UPDATE brain_runs SET status = 'interrupted', finished_at = ?, error_message = 'Interrupted by a server restart.'
           WHERE status = 'running'`
        )
        .run(currentIso()).changes;
    });
    return transaction();
  }

  async startBrainRun(kind: BrainRunSummary["kind"], timezone?: string | null): Promise<string> {
    this.assertWritableIdentityVersion();
    const id = crypto.randomUUID();
    this.db
      .prepare(`INSERT INTO brain_runs (id, kind, status, started_at, timezone) VALUES (?, ?, 'running', ?, ?)`)
      .run(id, kind, currentIso(), timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? null);
    this.invalidateBrainStatusCache();
    return id;
  }

  async getBrainRun(runId: string): Promise<BrainRunSummary | null> {
    const row = this.db.prepare(`SELECT * FROM brain_runs WHERE id = ?`).get(runId) as SqliteBrainRunRow | undefined;
    return row ? rowToBrainRun(row) : null;
  }

  async listBrainRuns(options?: { kind?: BrainRunKind; docId?: string; limit?: number }): Promise<BrainRunListItem[]> {
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (options?.kind) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    if (options?.docId) {
      // A run "touched this page" if it wrote a revision of it — including a
      // REFUSED one, which is part of the page's honest history — or raised an
      // issue against it. A run that died before either leaves no trace to
      // scope by, which the surface says out loud rather than implying none ran.
      clauses.push(
        `(id IN (SELECT run_id FROM brain_doc_revisions WHERE doc_id = ? AND run_id IS NOT NULL)
          OR id IN (SELECT run_id FROM brain_validation_issues WHERE doc_id = ? AND run_id IS NOT NULL))`
      );
      params.push(options.docId, options.docId);
    }
    params.push(options?.limit ?? 50);
    const runs = (
      this.db
        .prepare(`SELECT * FROM brain_runs ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY started_at DESC LIMIT ?`)
        .all(...params) as SqliteBrainRunRow[]
    ).map(rowToBrainRun);
    return this.attachBrainRunEffectCounts(runs, options?.docId ?? null);
  }

  // Effect counts for a whole page of runs in four grouped reads (never one
  // query per run — that is the shape that wedges on the real archive).
  private attachBrainRunEffectCounts(runs: BrainRunSummary[], docId: string | null): BrainRunListItem[] {
    if (runs.length === 0) {
      return [];
    }
    const runIds = runs.map((run) => run.id);
    const slots = runIds.map(() => "?").join(",");
    const countBy = (sql: string): Map<string, number> => {
      const counts = new Map<string, number>();
      for (const row of this.db.prepare(sql).all(...runIds) as Array<{ runId: string | null; n: number }>) {
        if (row.runId) {
          counts.set(row.runId, Number(row.n));
        }
      }
      return counts;
    };
    const lifecycleCounts = countBy(
      `SELECT run_id AS runId, COUNT(*) AS n FROM brain_lifecycle_events WHERE run_id IN (${slots}) GROUP BY run_id`
    );
    const episodeCounts = countBy(`SELECT run_id AS runId, COUNT(*) AS n FROM brain_episodes WHERE run_id IN (${slots}) GROUP BY run_id`);
    const issueCounts = countBy(
      `SELECT run_id AS runId, COUNT(*) AS n FROM brain_validation_issues WHERE run_id IN (${slots}) GROUP BY run_id`
    );
    // Revisions carry two effects at once: the page write itself, and the
    // claim supersession it declared (durable, and outside the page).
    const revisionRows = this.db
      .prepare(
        `SELECT run_id AS runId, doc_id AS docId, id, revision, status, drops_json AS dropsJson, errors_json AS errorsJson
         FROM brain_doc_revisions WHERE run_id IN (${slots})`
      )
      .all(...runIds) as Array<{
      runId: string | null;
      docId: string;
      id: number;
      revision: number;
      status: BrainDocRevisionRecord["status"];
      dropsJson: string;
      errorsJson: string | null;
    }>;
    const currentRevisionId = docId ? this.docRowTx(docId)?.current_revision_id ?? null : null;
    // sections_json is the heavy column; parse it only for the scoped doc's own
    // revisions, where the list shows the statement count.
    const statementCountStmt = docId
      ? this.db.prepare(`SELECT sections_json AS sectionsJson FROM brain_doc_revisions WHERE id = ?`)
      : null;
    const effects = new Map<string, BrainRunEffectCounts>();
    const docEffects = new Map<string, BrainRunDocEffect>();
    for (const row of revisionRows) {
      if (!row.runId) {
        continue;
      }
      const bucket = effects.get(row.runId) ?? {
        lifecycleChanges: 0,
        pagesWritten: 0,
        pagesRefused: 0,
        claimsSuperseded: 0,
        episodesCommitted: 0,
        issues: 0
      };
      if (row.status === "rejected") {
        bucket.pagesRefused += 1;
      } else {
        bucket.pagesWritten += 1;
      }
      bucket.claimsSuperseded += (JSON.parse(row.dropsJson) as BrainDocRevisionRecord["drops"]).filter(
        (drop) => drop.reason === "superseded"
      ).length;
      effects.set(row.runId, bucket);
      if (docId && row.docId === docId) {
        const sections = JSON.parse(
          (statementCountStmt?.get(row.id) as { sectionsJson: string } | undefined)?.sectionsJson ?? "[]"
        ) as BrainDocRevisionRecord["sections"];
        docEffects.set(row.runId, {
          revision: row.revision,
          status: row.status,
          isCurrent: currentRevisionId != null && currentRevisionId === row.id,
          statementCount: sections.reduce((sum, section) => sum + section.statements.length, 0),
          errors: row.errorsJson ? (JSON.parse(row.errorsJson) as string[]) : null
        });
      }
    }
    return runs.map((run) => {
      const bucket = effects.get(run.id);
      return {
        run,
        effects: {
          lifecycleChanges: lifecycleCounts.get(run.id) ?? 0,
          pagesWritten: bucket?.pagesWritten ?? 0,
          pagesRefused: bucket?.pagesRefused ?? 0,
          claimsSuperseded: bucket?.claimsSuperseded ?? 0,
          episodesCommitted: episodeCounts.get(run.id) ?? 0,
          issues: issueCounts.get(run.id) ?? 0
        },
        docEffect: docEffects.get(run.id) ?? null
      };
    });
  }

  // The run audit: every durable change attributable to one run. Reads only —
  // each effect table already carries run_id, so nothing new had to be stored.
  async getBrainRunEffects(runId: string): Promise<BrainRunEffects | null> {
    const run = await this.getBrainRun(runId);
    if (!run) {
      return null;
    }
    // Lifecycle transitions this run wrote (the effect most easily missed:
    // a rollup was asked for a page, but may also have closed commitments).
    const eventRows = this.db
      .prepare(`SELECT id FROM brain_lifecycle_events WHERE run_id = ? ORDER BY id ASC`)
      .all(runId) as Array<{ id: number }>;
    const eventIds = new Set(eventRows.map((row) => row.id));
    const lifecycle: BrainRunEffectLifecycle[] = [];
    if (eventIds.size > 0) {
      const claimIds = (
        this.db
          .prepare(`SELECT DISTINCT claim_id AS claimId FROM brain_lifecycle_events WHERE run_id = ?`)
          .all(runId) as Array<{ claimId: string }>
      ).map((row) => row.claimId);
      const eventsByClaim = this.loadLifecycleEventsTx(claimIds);
      const claimTextStmt = this.db.prepare(`SELECT text FROM brain_claims WHERE id = ?`);
      for (const claimId of claimIds) {
        const events = eventsByClaim.get(claimId) ?? [];
        // Status NOW, so the audit never implies a change is still in force.
        const currentStatus = foldLifecycleEvents(events).status;
        const node = this.lifecycleNodeRowForClaimTx(claimId);
        const chatSourceId = node?.chat_scope ?? null;
        const chatDisplayName = chatSourceId
          ? ((this.db.prepare(`SELECT display_name AS name FROM chats WHERE source_chat_id = ?`).get(chatSourceId) as
              | { name: string | null }
              | undefined)?.name ?? null)
          : null;
        const claimRow = claimTextStmt.get(claimId) as { text: string } | undefined;
        for (const event of events) {
          if (!eventIds.has(event.id)) {
            continue;
          }
          lifecycle.push({
            eventId: event.id,
            claimId,
            itemText: claimRow?.text ?? node?.title ?? "(claim no longer exists)",
            itemExists: claimRow != null,
            kind: node?.kind === "commitment" || node?.kind === "question" ? node.kind : null,
            toStatus: event.toStatus,
            source: event.source,
            model: event.model,
            note: event.note,
            atMs: event.createdAtMs,
            chatSourceId,
            chatDisplayName,
            cites: this.lifecycleCiteViewsTx(event),
            currentStatus
          });
        }
      }
      lifecycle.sort((a, b) => a.eventId - b.eventId);
    }
    // Doc revisions committed by this run, with the supersession they declared.
    const revisionRows = this.db
      .prepare(`SELECT * FROM brain_doc_revisions WHERE run_id = ? ORDER BY id ASC`)
      .all(runId) as DocRevisionRow[];
    const revisions: BrainRunEffectRevision[] = [];
    let supersessionCount = 0;
    for (const row of revisionRows) {
      const record = this.mapDocRevisionRow(row);
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
      const docRow = this.docRowTx(record.docId);
      const nodeRow = docRow?.node_id
        ? (this.db.prepare(`SELECT * FROM brain_nodes WHERE id = ?`).get(docRow.node_id) as GraphNodeRow | undefined)
        : undefined;
      revisions.push({
        docId: record.docId,
        title: nodeRow ? this.graphLabelForNodeRow(nodeRow) : docRow?.slug ?? record.docId,
        revision: record.revision,
        status: record.status,
        statementCount: record.sections.reduce((sum, section) => sum + section.statements.length, 0),
        referencedClaimCount: referenced.size,
        supersededClaims,
        errors: record.errors,
        isCurrent: docRow?.current_revision_id === record.id
      });
    }
    const episodesCommitted = Number(
      (this.db.prepare(`SELECT COUNT(*) AS n FROM brain_episodes WHERE run_id = ?`).get(runId) as { n: number }).n
    );
    return {
      run,
      lifecycle,
      revisions,
      supersessionCount,
      episodesCommitted,
      issues: await this.listBrainValidationIssues({ runId, limit: 200 }),
      asOfMs: Date.now()
    };
  }

  async completeBrainRun(runId: string, totals: Record<string, number>): Promise<void> {
    this.db
      .prepare(`UPDATE brain_runs SET status = 'completed', finished_at = ?, totals_json = ? WHERE id = ?`)
      .run(currentIso(), stringifyJson(totals), runId);
    this.invalidateBrainStatusCache();
  }

  // 'brain' job lock over the shared memory_job_locks table (name-keyed): the
  // TTL sweep clears a crashed holder; same-run re-acquire refreshes the lease.
  async tryAcquireBrainLock(runId: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const expiresAt = now + ttlMs;
    const transaction = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM memory_job_locks WHERE name = 'brain' AND expires_at_ms < ?`).run(now);
      const existing = this.db.prepare(`SELECT run_id FROM memory_job_locks WHERE name = 'brain'`).get() as
        | { run_id: string }
        | undefined;
      if (existing && existing.run_id !== runId) {
        return false;
      }
      this.db
        .prepare(
          `INSERT INTO memory_job_locks (name, run_id, acquired_at, expires_at_ms)
           VALUES ('brain', ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET run_id = excluded.run_id, acquired_at = excluded.acquired_at, expires_at_ms = excluded.expires_at_ms`
        )
        .run(runId, currentIso(), expiresAt);
      return true;
    });
    return transaction();
  }

  async releaseBrainLock(runId: string): Promise<void> {
    this.db.prepare(`DELETE FROM memory_job_locks WHERE name = 'brain' AND run_id = ?`).run(runId);
  }

  // A non-completed terminal run persists the totals it accumulated before
  // stopping (interrupted/budget-exceeded runs no longer discard their counts).
  async failBrainRun(
    runId: string,
    status: "failed" | "interrupted" | "budget_exceeded",
    message: string,
    totals?: Record<string, number>
  ): Promise<void> {
    this.db
      .prepare(`UPDATE brain_runs SET status = ?, finished_at = ?, error_message = ?, totals_json = COALESCE(?, totals_json) WHERE id = ?`)
      .run(status, currentIso(), message, totals ? stringifyJson(totals) : null, runId);
    this.invalidateBrainStatusCache();
  }

  async recordBrainLlmUsage(entry: {
    purpose: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    estimated?: boolean;
  }): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(`INSERT INTO brain_llm_ledger (day, purpose, provider, input_tokens, output_tokens, estimated, at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        new Date(now).toISOString().slice(0, 10),
        entry.purpose,
        entry.provider,
        entry.inputTokens,
        entry.outputTokens,
        entry.estimated ? 1 : 0,
        now
      );
  }

  // Daily windows pass `day` (UTC date) to hit the (day, purpose) index; the
  // hourly rate-limit window passes `sinceMs` and scans by timestamp.
  async getBrainLlmUsage(options: { sinceMs?: number; day?: string }): Promise<BrainLlmUsageSummary> {
    const columns = `COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens`;
    const row = (
      options.day != null
        ? this.db.prepare(`SELECT ${columns} FROM brain_llm_ledger WHERE day = ?`).get(options.day)
        : this.db.prepare(`SELECT ${columns} FROM brain_llm_ledger WHERE at_ms >= ?`).get(options.sinceMs ?? 0)
    ) as { calls: number; input_tokens: number; output_tokens: number };
    return { calls: Number(row.calls), inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens) };
  }

  private invalidateBrainStatusCache(): void {
    this.brainStatusCache = null;
  }

  async getBrainStatus(): Promise<BrainStatusSummary> {
    const cached = this.brainStatusCache;
    if (cached && Date.now() - cached.at < SqliteArchiveRepository.BRAIN_STATUS_TTL_MS) {
      return cached.value;
    }
    // Assimilated is DERIVED as total − pending from the one shared predicate,
    // so coverage can never disagree with the backlog at the tie boundary.
    const coverage = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN ${watermarkPendingPredicate("m", "w")} THEN 0 ELSE 1 END), 0) AS assimilated
         FROM messages m
         JOIN chats ch ON ch.id = m.chat_id
         LEFT JOIN brain_chat_watermarks w ON w.chat_source_id = ch.source_chat_id
         WHERE ${visibleExchangePredicate("m")}`
      )
      .get() as { total: number; assimilated: number };
    const chatsWithBacklog = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM (
           SELECT ch.id
           FROM chats ch
           LEFT JOIN brain_chat_watermarks w ON w.chat_source_id = ch.source_chat_id
           JOIN messages m ON m.chat_id = ch.id
           WHERE ${watermarkPendingPredicate("m", "w")}
             AND ${visibleExchangePredicate("m")}
           GROUP BY ch.id
         )`
      )
      .get() as { count: number };
    const runs = this.db.prepare(`SELECT * FROM brain_runs ORDER BY started_at DESC LIMIT 5`).all() as SqliteBrainRunRow[];
    const total = Number(coverage.total ?? 0);
    const assimilated = Number(coverage.assimilated ?? 0);
    const value: BrainStatusSummary = {
      ownerName: await this.getArchiveOwnerName(),
      selfIdentities: await this.getArchiveOwnerSelfIdentities(),
      limits: { maxCallsPerHour: config.brain.maxCallsPerHour, maxCallsPerDay: config.brain.maxCallsPerDay },
      totalVisibleMessages: total,
      assimilatedVisibleMessages: assimilated,
      coveragePercent: total > 0 ? Math.round((assimilated / total) * 1000) / 10 : 100,
      chatsWithBacklog: Number(chatsWithBacklog.count ?? 0),
      backlogSample: await this.getBrainChatBacklog({ limit: 8 }),
      tasks: await this.getBrainTaskSummary(),
      usageToday: await this.getBrainLlmUsage({ day: utcDayString() }),
      latestRun: runs[0] ? rowToBrainRun(runs[0]) : null,
      activeRun: runs.find((run) => run.status === "running") ? rowToBrainRun(runs.find((run) => run.status === "running")!) : null
    };
    this.brainStatusCache = { at: Date.now(), value };
    return value;
  }

  async getBrainBackfillStats(): Promise<BrainBackfillDbStats> {
    // Coverage comes from the TTL-cached status (ONE source of coverage truth,
    // and the two heavy 310k-row scans are never duplicated for a dashboard
    // poll — measured ~700ms cold on the real archive, ~0ms via the cache).
    const status = await this.getBrainStatus();
    const taskRows = this.db
      .prepare(`SELECT status, COUNT(*) AS count FROM brain_tasks WHERE kind = 'episode' GROUP BY status`)
      .all() as Array<{ status: string; count: number }>;
    const episodesLastHour = this.db
      .prepare(`SELECT COUNT(*) AS count FROM brain_episodes WHERE created_at >= ?`)
      .get(new Date(Date.now() - 3600_000).toISOString()) as { count: number };
    const currentEpisodes = this.db
      .prepare(
        `SELECT COUNT(*) AS count,
                AVG(message_count) AS avg_messages,
                COALESCE(SUM(CASE WHEN generator = 'model' OR attempted_model IS NOT NULL THEN 1 ELSE 0 END), 0) AS attempted,
                COALESCE(SUM(CASE WHEN attempted_model IS NOT NULL THEN 1 ELSE 0 END), 0) AS fallbacks,
                COALESCE(SUM(CASE WHEN generator = 'extractive' THEN 1 ELSE 0 END), 0) AS extractive
         FROM brain_episodes
         WHERE status = 'current'`
      )
      .get() as { count: number; avg_messages: number | null; attempted: number; fallbacks: number; extractive: number };
    const today = utcDayString();
    const spendRows = this.db
      .prepare(
        `SELECT provider,
                COUNT(*) AS calls,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(CASE WHEN day = ? THEN 1 ELSE 0 END), 0) AS calls_today,
                COALESCE(SUM(CASE WHEN day = ? THEN input_tokens ELSE 0 END), 0) AS input_today,
                COALESCE(SUM(CASE WHEN day = ? THEN output_tokens ELSE 0 END), 0) AS output_today
         FROM brain_llm_ledger
         GROUP BY provider
         ORDER BY calls DESC`
      )
      .all(today, today, today) as Array<Record<string, unknown>>;
    const spendByModel: BrainBackfillModelSpend[] = spendRows.map((row) => ({
      provider: String(row.provider ?? "unknown"),
      calls: Number(row.calls ?? 0),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      callsToday: Number(row.calls_today ?? 0),
      inputTokensToday: Number(row.input_today ?? 0),
      outputTokensToday: Number(row.output_today ?? 0)
    }));
    const taskCount = (state: string) => Number(taskRows.find((row) => row.status === state)?.count ?? 0);
    return {
      totalVisibleMessages: status.totalVisibleMessages,
      assimilatedVisibleMessages: status.assimilatedVisibleMessages,
      pendingChats: status.chatsWithBacklog,
      queuedEpisodeTasks: taskCount("pending"),
      failedEpisodeTasks: taskCount("failed"),
      episodesLastHour: Number(episodesLastHour.count ?? 0),
      currentEpisodes: Number(currentEpisodes.count ?? 0),
      avgEpisodeMessages: currentEpisodes.avg_messages != null ? Math.round(Number(currentEpisodes.avg_messages) * 10) / 10 : null,
      modelAttemptedEpisodes: Number(currentEpisodes.attempted ?? 0),
      fallbackEpisodes: Number(currentEpisodes.fallbacks ?? 0),
      sweepableExtractive: Number(currentEpisodes.extractive ?? 0),
      spendByModel
    };
  }

  async resetBrainDerivedData(options?: { chatSourceId?: string | null }): Promise<{ episodeIds: string[]; watermarks: number }> {
    const chat = options?.chatSourceId ? this.canonicalJid(options.chatSourceId) ?? options.chatSourceId : null;
    const episodeIds = (
      chat
        ? (this.db.prepare(`SELECT id FROM brain_episodes WHERE chat_source_id = ?`).all(chat) as Array<{ id: string }>)
        : (this.db.prepare(`SELECT id FROM brain_episodes`).all() as Array<{ id: string }>)
    ).map((row) => row.id);
    let watermarks = 0;
    const transaction = this.db.transaction(() => {
      // Graph first (it reads claims that are about to be deleted): a full
      // reset wipes the derived-of-derived tables outright; a scoped reset
      // removes exactly the affected episodes' contributions.
      if (!chat) {
        this.db.prepare(`DELETE FROM brain_edge_evidence`).run();
        this.db.prepare(`DELETE FROM brain_edges`).run();
        this.db.prepare(`DELETE FROM brain_node_claims`).run();
        this.db.prepare(`DELETE FROM brain_node_aliases`).run();
        this.db.prepare(`DELETE FROM brain_nodes`).run();
      } else {
        for (const episodeId of episodeIds) {
          this.removeGraphContributionForEpisodeTx(episodeId);
        }
      }
      for (let index = 0; index < episodeIds.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
        const batch = episodeIds.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
        const placeholders = batch.map(() => "?").join(",");
        // Lifecycle transitions are derived state whose re-derivation costs
        // model spend (same class as episodes): a reset wipes them with their
        // claims — run before the claims are deleted.
        this.db
          .prepare(
            `DELETE FROM brain_lifecycle_event_cites WHERE event_id IN (
               SELECT id FROM brain_lifecycle_events WHERE claim_id IN (SELECT id FROM brain_claims WHERE episode_id IN (${placeholders})))`
          )
          .run(...batch);
        this.db
          .prepare(
            `DELETE FROM brain_lifecycle_events WHERE claim_id IN (SELECT id FROM brain_claims WHERE episode_id IN (${placeholders}))`
          )
          .run(...batch);
        this.db
          .prepare(`DELETE FROM brain_citations WHERE claim_id IN (SELECT id FROM brain_claims WHERE episode_id IN (${placeholders}))`)
          .run(...batch);
        this.db
          .prepare(`DELETE FROM brain_claim_entities WHERE claim_id IN (SELECT id FROM brain_claims WHERE episode_id IN (${placeholders}))`)
          .run(...batch);
        this.db.prepare(`DELETE FROM brain_episode_topics WHERE episode_id IN (${placeholders})`).run(...batch);
        this.db.prepare(`DELETE FROM brain_validation_issues WHERE episode_id IN (${placeholders})`).run(...batch);
        this.db.prepare(`DELETE FROM brain_media_gaps WHERE episode_id IN (${placeholders})`).run(...batch);
        this.db.prepare(`DELETE FROM brain_claims WHERE episode_id IN (${placeholders})`).run(...batch);
        this.db.prepare(`DELETE FROM brain_episodes WHERE id IN (${placeholders})`).run(...batch);
      }
      if (!chat) {
        // Full reset: issue rows without an episode anchor and the topic
        // vocabulary itself go too — the brain starts from a truly clean slate.
        this.db.prepare(`DELETE FROM brain_validation_issues`).run();
        this.db.prepare(`DELETE FROM brain_topics`).run();
        // Belt-and-braces: orphaned lifecycle events reference already-dead
        // claims and are not covered by the per-episode deletes above.
        this.db.prepare(`DELETE FROM brain_lifecycle_event_cites`).run();
        this.db.prepare(`DELETE FROM brain_lifecycle_events`).run();
        // Semantic docs are derived-of-derived whose re-derivation costs model
        // spend (same class as episodes): a FULL reset wipes them. A scoped
        // reset leaves docs standing — their dead refs make them due, honestly.
        this.db.prepare(`DELETE FROM brain_doc_revision_claims`).run();
        this.db.prepare(`DELETE FROM brain_doc_revisions`).run();
        this.db.prepare(`DELETE FROM brain_docs`).run();
      }
      watermarks = Number(
        (chat
          ? this.db.prepare(`DELETE FROM brain_chat_watermarks WHERE chat_source_id = ?`).run(chat)
          : this.db.prepare(`DELETE FROM brain_chat_watermarks`).run()
        ).changes
      );
      // Clear the work queue too, so no stale episode/regen task (a regen task
      // still points at a now-deleted episode id) survives the reset and
      // resurrects derived data on the next drain.
      if (chat) {
        this.db.prepare(`DELETE FROM brain_tasks WHERE chat_source_id = ?`).run(chat);
      } else {
        this.db.prepare(`DELETE FROM brain_tasks`).run();
      }
    });
    transaction();
    this.invalidateBrainStatusCache();
    return { episodeIds, watermarks };
  }

  async commitBrainEpisode(episode: BrainEpisodeInput): Promise<BrainEpisodeRecord> {
    this.assertWritableIdentityVersion();
    const id = crypto.randomUUID();
    const chatSourceId = this.canonicalJid(episode.chatSourceId) ?? episode.chatSourceId;
    const insertEpisode = this.db.prepare(
      `INSERT INTO brain_episodes
       (id, chat_source_id, start_at_ms, end_at_ms, message_count, participants_json, summary, markdown, generator, model, run_id, fallback_reason, attempted_model,
        extraction_version, unresolved_participants_json, push_name_participants_json, uninterpreted_media_count, quoted_reply_anchors_json, archive_signal_anchors_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertClaim = this.db.prepare(
      `INSERT INTO brain_claims (id, episode_id, sequence, kind, text, event_at_ms, valid_until_ms, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertCitation = this.db.prepare(
      `INSERT INTO brain_citations (claim_id, source_message_key, source_chat_id, message_id, sender_source_jid, timestamp_ms)
       SELECT ?, ?, ?, m.id, m.sender_source_jid, m.timestamp_ms
       FROM (SELECT 1) LEFT JOIN messages m ON m.source_message_key = ?`
    );
    const insertEntity = this.db.prepare(
      `INSERT INTO brain_claim_entities (claim_id, kind, name, jid, role) VALUES (?, ?, ?, ?, ?)`
    );
    const insertMediaGap = this.db.prepare(
      `INSERT INTO brain_media_gaps (episode_id, source_message_key, modality, impact, note) VALUES (?, ?, ?, ?, ?)`
    );
    const insertSignalAnchor = this.db.prepare(
      `INSERT OR REPLACE INTO brain_episode_signal_anchors (episode_id, source_message_key, kind, capture_version) VALUES (?, ?, ?, ?)`
    );
    // Case-insensitive topic convergence: the NOCASE unique index makes the
    // upsert reuse 'visa' when the model writes 'Visa'.
    const upsertTopic = this.db.prepare(`INSERT INTO brain_topics (title) VALUES (?) ON CONFLICT (title) DO NOTHING`);
    const selectTopic = this.db.prepare(`SELECT id FROM brain_topics WHERE title = ?`);
    const linkTopic = this.db.prepare(`INSERT OR IGNORE INTO brain_episode_topics (episode_id, topic_id) VALUES (?, ?)`);
    const advance = this.db.prepare(WATERMARK_CURSOR_UPSERT);
    // The rowid half of the cursor: every message seen at or below the pack's
    // end timestamp. A later same-timestamp message gets a higher rowid and
    // stays pending — the tie boundary fix.
    const boundaryId = episode.advanceWatermark === false ? 0 : this.boundaryRowidForChat(chatSourceId, episode.endAtMs);
    const transaction = this.db.transaction(() => {
      insertEpisode.run(
        id,
        chatSourceId,
        episode.startAtMs,
        episode.endAtMs,
        episode.messageCount,
        stringifyJson(episode.participants),
        episode.summary,
        episode.markdown,
        episode.generator,
        episode.model,
        episode.runId,
        episode.fallbackReason ?? null,
        episode.attemptedModel ?? null,
        episode.extractionVersion,
        stringifyJson(episode.unresolvedParticipants ?? []),
        stringifyJson(episode.pushNameParticipants ?? []),
        episode.uninterpretedMediaCount ?? 0,
        stringifyJson(episode.quotedReplyAnchors ?? []),
        stringifyJson(episode.archiveSignalAnchors ?? [])
      );
      episode.claims.forEach((claim, index) => {
        const claimId = crypto.randomUUID();
        insertClaim.run(
          claimId,
          id,
          index + 1,
          claim.kind,
          claim.text,
          claim.eventAtMs ?? null,
          claim.validUntilMs ?? null,
          claim.confidence ?? "stated"
        );
        for (const key of claim.citations) {
          insertCitation.run(claimId, key, chatSourceId, key);
        }
        for (const entity of claim.entities ?? []) {
          const jid = entity.jid ? this.canonicalJid(entity.jid) ?? entity.jid : null;
          insertEntity.run(claimId, entity.kind, entity.name, jid, entity.role ?? null);
        }
      });
      for (const title of episode.topics ?? []) {
        const clean = title.trim();
        if (!clean) {
          continue;
        }
        upsertTopic.run(clean);
        const topic = selectTopic.get(clean) as { id: number } | undefined;
        if (topic) {
          linkTopic.run(id, topic.id);
        }
      }
      for (const gap of episode.mediaGaps ?? []) {
        insertMediaGap.run(id, gap.sourceMessageKey, gap.modality, gap.impact, gap.note ?? null);
      }
      for (const anchor of episode.archiveSignalAnchors ?? []) {
        for (const kind of anchor.kinds) {
          insertSignalAnchor.run(id, anchor.sourceMessageKey, kind, anchor.captureVersion);
        }
      }
      // Regeneration commits leave the watermark alone: the window is already
      // covered and the cursor must never move backwards or churn.
      if (episode.advanceWatermark !== false) {
        advance.run(chatSourceId, episode.endAtMs, boundaryId, currentIso(), currentIso());
      }
      // Supersede-with-replacement is atomic: no crash window where both the
      // old and the new episode read as current.
      let rekeyedLifecycleClaims: string[] = [];
      if (episode.supersedesEpisodeId) {
        this.db.prepare(`UPDATE brain_episodes SET status = 'superseded' WHERE id = ?`).run(episode.supersedesEpisodeId);
        // Lifecycle transitions follow the commitment across regeneration:
        // re-key onto the unique citation-sharing replacement claim (this
        // commit's or an earlier replacement pack's), else orphan honestly.
        rekeyedLifecycleClaims = this.rekeyLifecycleEventsForSupersededEpisodeTx(episode.supersedesEpisodeId);
        // Graph scope rule: the graph derives from CURRENT model episodes
        // only, so the superseded episode's contribution leaves in the same
        // transaction its replacement's arrives.
        this.removeGraphContributionForEpisodeTx(episode.supersedesEpisodeId);
      }
      // Knowledge graph, same transaction — D5's commit shape completed.
      // Extractive placeholders contribute nothing (honest coverage is not
      // knowledge); model episodes upsert nodes/edges/junctions idempotently
      // by natural key.
      if (episode.generator === "model") {
        this.applyEpisodeGraphTx({ episodeId: id, chatSourceId, startAtMs: episode.startAtMs, endAtMs: episode.endAtMs });
      }
      // Re-project re-keyed lifecycle state AFTER the replacement's nodes
      // exist, so the new node folds to its recorded status in the same
      // transaction — no window where a closed commitment reads open.
      for (const claimId of rekeyedLifecycleClaims) {
        this.projectLifecycleClaimTx(claimId);
      }
    });
    transaction();
    this.invalidateBrainStatusCache();
    // Return the committed record directly (single id-filtered fetch) rather
    // than re-listing the top 50 episodes for the chat.
    const committed = await this.listBrainEpisodes({ episodeId: id, limit: 1 });
    return committed[0]!;
  }

  async listBrainEpisodeProjections(options?: {
    limit?: number;
    offset?: number;
  }): Promise<Array<{ id: string; chatSourceId: string; chatDisplayName: string | null; startAtMs: number; markdown: string }>> {
    return (
      this.db
        .prepare(
          `SELECT e.id AS id, e.chat_source_id AS chatSourceId, c.display_name AS chatDisplayName,
                  e.start_at_ms AS startAtMs, e.markdown AS markdown
           FROM brain_episodes e
           LEFT JOIN chats c ON c.source_chat_id = e.chat_source_id
           WHERE e.status = 'current' AND e.markdown <> ''
           ORDER BY e.start_at_ms ASC, e.id ASC LIMIT ? OFFSET ?`
        )
        .all(options?.limit ?? 1000, options?.offset ?? 0) as Array<{
        id: string;
        chatSourceId: string;
        chatDisplayName: string | null;
        startAtMs: number;
        markdown: string;
      }>
    ).map((row) => ({ ...row, startAtMs: Number(row.startAtMs) }));
  }

  async updateBrainEpisodeMarkdown(episodeId: string, markdown: string): Promise<void> {
    this.db.prepare(`UPDATE brain_episodes SET markdown = ? WHERE id = ?`).run(markdown, episodeId);
  }

  async listBrainEpisodes(options: {
    chatSourceId?: string | null;
    episodeId?: string;
    status?: BrainEpisodeRecord["status"];
    generator?: BrainEpisodeGenerator;
    endAtOrBeforeMs?: number;
    limit: number;
  }): Promise<BrainEpisodeRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.episodeId) {
      clauses.push("e.id = ?");
      params.push(options.episodeId);
    }
    if (options.chatSourceId) {
      clauses.push("e.chat_source_id = ?");
      params.push(options.chatSourceId);
    }
    if (options.status) {
      clauses.push("e.status = ?");
      params.push(options.status);
    }
    if (options.generator) {
      clauses.push("e.generator = ?");
      params.push(options.generator);
    }
    if (options.endAtOrBeforeMs != null) {
      clauses.push("e.end_at_ms <= ?");
      params.push(options.endAtOrBeforeMs);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(options.limit);
    const rows = this.db
      .prepare(
        `SELECT e.*, COALESCE(NULLIF(TRIM(COALESCE(ch.display_name, '')), ''), NULL) AS chat_display_name
         FROM brain_episodes e
         LEFT JOIN chats ch ON ch.source_chat_id = e.chat_source_id
         ${where}
         ORDER BY e.end_at_ms DESC
         LIMIT ?`
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToBrainEpisode(row));
  }

  private rowToBrainEpisode(row: Record<string, unknown>): BrainEpisodeRecord {
    const claimsStmt = this.db.prepare(
      `SELECT id, kind, text, event_at_ms, valid_until_ms, confidence FROM brain_claims WHERE episode_id = ? ORDER BY sequence`
    );
    const citationsStmt = this.db.prepare(
      `SELECT source_message_key, source_chat_id, message_id, sender_source_jid, timestamp_ms FROM brain_citations WHERE claim_id = ?`
    );
    const entitiesStmt = this.db.prepare(`SELECT kind, name, jid, role FROM brain_claim_entities WHERE claim_id = ? ORDER BY id`);
    const topicsStmt = this.db.prepare(
      `SELECT t.title FROM brain_episode_topics et JOIN brain_topics t ON t.id = et.topic_id WHERE et.episode_id = ? ORDER BY t.title`
    );
    const mediaGapsStmt = this.db.prepare(
      `SELECT source_message_key, modality, impact, note FROM brain_media_gaps WHERE episode_id = ? ORDER BY id`
    );
    return {
      id: String(row.id),
      chatSourceId: String(row.chat_source_id),
      chatDisplayName: (row.chat_display_name as string | null) ?? null,
      startAtMs: Number(row.start_at_ms),
      endAtMs: Number(row.end_at_ms),
      messageCount: Number(row.message_count),
      participants: (parseJson(row.participants_json as string | null) as string[] | null) ?? [],
      summary: String(row.summary),
      markdown: String(row.markdown),
      generator: row.generator as BrainEpisodeRecord["generator"],
      runId: (row.run_id as string | null) ?? null,
      model: (row.model as string | null) ?? null,
      status: row.status as BrainEpisodeRecord["status"],
      fallbackReason: (row.fallback_reason as string | null) ?? null,
      attemptedModel: (row.attempted_model as string | null) ?? null,
      extractionVersion: Number(row.extraction_version ?? 0),
      topics: (topicsStmt.all(row.id) as Array<{ title: string }>).map((topic) => String(topic.title)),
      unresolvedParticipants: (parseJson(row.unresolved_participants_json as string | null) as string[] | null) ?? [],
      pushNameParticipants: (parseJson(row.push_name_participants_json as string | null) as string[] | null) ?? [],
      uninterpretedMediaCount: Number(row.uninterpreted_media_count ?? 0),
      quotedReplyAnchors: (parseJson(row.quoted_reply_anchors_json as string | null) as QuotedReplyAnchor[] | null) ?? [],
      archiveSignalAnchors: (parseJson(row.archive_signal_anchors_json as string | null) as ArchiveSignalAnchor[] | null) ?? [],
      mediaGaps: (mediaGapsStmt.all(row.id) as Array<Record<string, unknown>>).map((gap) => ({
        sourceMessageKey: String(gap.source_message_key),
        modality: gap.modality as BrainMediaGapRecord["modality"],
        impact: gap.impact as BrainMediaGapRecord["impact"],
        note: (gap.note as string | null) ?? null
      })),
      createdAt: String(row.created_at),
      claims: (
        claimsStmt.all(row.id) as Array<{
          id: string;
          kind: string;
          text: string;
          event_at_ms: number | null;
          valid_until_ms: number | null;
          confidence: string;
        }>
      ).map((claim) => ({
        id: claim.id,
        kind: claim.kind as BrainEpisodeRecord["claims"][number]["kind"],
        text: claim.text,
        eventAtMs: claim.event_at_ms == null ? null : Number(claim.event_at_ms),
        validUntilMs: claim.valid_until_ms == null ? null : Number(claim.valid_until_ms),
        confidence: claim.confidence as BrainEpisodeRecord["claims"][number]["confidence"],
        entities: (entitiesStmt.all(claim.id) as Array<Record<string, unknown>>).map((entity) => ({
          kind: entity.kind as BrainClaimEntityRecord["kind"],
          name: String(entity.name),
          jid: (entity.jid as string | null) ?? null,
          role: (entity.role as string | null) ?? null
        })),
        citations: (citationsStmt.all(claim.id) as Array<Record<string, unknown>>).map((citation) => ({
          sourceMessageKey: String(citation.source_message_key),
          sourceChatId: String(citation.source_chat_id),
          messageId: citation.message_id == null ? null : Number(citation.message_id),
          senderSourceJid: (citation.sender_source_jid as string | null) ?? null,
          timestampMs: citation.timestamp_ms == null ? null : Number(citation.timestamp_ms)
        }))
      }))
    };
  }

  async listRegenerableBrainEpisodes(options: {
    currentVersion: number;
    chatSourceId?: string | null;
    onlyExtractive?: boolean;
    limit: number;
  }): Promise<BrainEpisodeRecord[]> {
    const params: unknown[] = [];
    // onlyExtractive is the backfill "sweep the fallbacks" scope: placeholders
    // alone, not stale-but-model episodes.
    let where = `WHERE e.status = 'current' AND `;
    if (options.onlyExtractive) {
      where += `e.generator = 'extractive'`;
    } else {
      where += `(e.generator = 'extractive' OR e.extraction_version < ?)`;
      params.push(options.currentVersion);
    }
    if (options.chatSourceId) {
      where += ` AND e.chat_source_id = ?`;
      params.push(options.chatSourceId);
    }
    params.push(options.limit);
    const rows = this.db
      .prepare(
        `SELECT e.*, COALESCE(NULLIF(TRIM(COALESCE(ch.display_name, '')), ''), NULL) AS chat_display_name
         FROM brain_episodes e
         LEFT JOIN chats ch ON ch.source_chat_id = e.chat_source_id
         ${where}
         ORDER BY e.end_at_ms DESC
         LIMIT ?`
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToBrainEpisode(row));
  }

  async markBrainEpisodeSuperseded(episodeId: string): Promise<void> {
    // The replacement-less supersede (a window that re-derives to no evidence):
    // the graph scope rule and lifecycle re-key/orphan apply here too.
    this.db.transaction(() => {
      this.db.prepare(`UPDATE brain_episodes SET status = 'superseded' WHERE id = ?`).run(episodeId);
      const rekeyed = this.rekeyLifecycleEventsForSupersededEpisodeTx(episodeId);
      this.removeGraphContributionForEpisodeTx(episodeId);
      for (const claimId of rekeyed) {
        this.projectLifecycleClaimTx(claimId);
      }
    })();
    this.invalidateBrainStatusCache();
  }

  async countRegenerableBrainEpisodes(currentVersion: number): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM brain_episodes WHERE status = 'current' AND (generator = 'extractive' OR extraction_version < ?)`
      )
      .get(currentVersion) as { n: number };
    return Number(row.n);
  }

  // --- Brain evaluation (eval harness) ---
  // Runs and grades are user-authored ground truth: no FK into brain tables,
  // untouched by resetBrainDerivedData and the contract-shape rebuild guard.

  async insertBrainEvalRun(run: BrainEvalRunRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO brain_eval_runs
         (id, ran_at_ms, target, golden_version, golden_hash, k_values_json, query_count, skipped_query_ids_json, per_class_json, per_query_json, totals_json, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.id,
        run.ranAtMs,
        run.target,
        run.goldenVersion,
        run.goldenHash,
        stringifyJson(run.kValues),
        run.queryCount,
        stringifyJson(run.skippedQueryIds),
        stringifyJson(run.perClass),
        stringifyJson(run.perQuery),
        stringifyJson(run.totals),
        run.notes
      );
  }

  async listBrainEvalRuns(options?: { goldenHash?: string; limit?: number }): Promise<BrainEvalRunRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options?.goldenHash) {
      clauses.push("golden_hash = ?");
      params.push(options.goldenHash);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(options?.limit ?? 50);
    const rows = this.db
      .prepare(`SELECT * FROM brain_eval_runs ${where} ORDER BY ran_at_ms DESC, id DESC LIMIT ?`)
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToBrainEvalRun(row));
  }

  async getBrainEvalRun(id: string): Promise<BrainEvalRunRecord | null> {
    const row = this.db.prepare(`SELECT * FROM brain_eval_runs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToBrainEvalRun(row) : null;
  }

  private rowToBrainEvalRun(row: Record<string, unknown>): BrainEvalRunRecord {
    return {
      id: String(row.id),
      ranAtMs: Number(row.ran_at_ms),
      target: String(row.target),
      goldenVersion: Number(row.golden_version),
      goldenHash: String(row.golden_hash),
      kValues: (parseJson(row.k_values_json as string | null) as number[] | null) ?? [],
      queryCount: Number(row.query_count),
      skippedQueryIds: (parseJson(row.skipped_query_ids_json as string | null) as string[] | null) ?? [],
      perClass: (parseJson(row.per_class_json as string | null) as BrainEvalRunRecord["perClass"] | null) ?? [],
      perQuery: (parseJson(row.per_query_json as string | null) as BrainEvalRunRecord["perQuery"] | null) ?? [],
      totals:
        (parseJson(row.totals_json as string | null) as BrainEvalRunRecord["totals"] | null) ??
        ({ queries: 0, recallAtK: {}, zeroHitQueries: 0 } as BrainEvalRunRecord["totals"]),
      notes: (row.notes as string | null) ?? null
    };
  }

  // Which of these source message keys still resolve to archived messages —
  // the eval runner's invalid-expectation quarantine.
  async filterExistingMessageKeys(keys: string[]): Promise<Set<string>> {
    const existing = new Set<string>();
    for (let index = 0; index < keys.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = keys.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT source_message_key FROM messages WHERE source_message_key IN (${placeholders})`)
        .all(...batch) as Array<{ source_message_key: string }>;
      for (const row of rows) {
        existing.add(row.source_message_key);
      }
    }
    return existing;
  }

  // Deterministic stratified grading sample (design E5): current model-episode
  // claims only, per model stamp, ungraded first, claim-UUID order (a stable
  // unbiased shuffle — UUIDs are already uniform-random).
  async listClaimsForGrading(options: { perModel: number; includeGraded?: boolean }): Promise<BrainGradingSample> {
    const perModel = Math.max(1, Math.floor(options.perModel));
    const totals = this.db
      .prepare(
        `SELECT e.model AS model,
                COUNT(*) AS eligible,
                SUM(CASE WHEN g.claim_id IS NULL THEN 0 ELSE 1 END) AS graded
         FROM brain_claims c
         JOIN brain_episodes e ON e.id = c.episode_id AND e.status = 'current' AND e.generator = 'model'
         LEFT JOIN brain_claim_grades g ON g.claim_id = c.id
         GROUP BY e.model
         ORDER BY e.model`
      )
      .all() as Array<{ model: string | null; eligible: number; graded: number }>;
    const rows = this.db
      .prepare(
        `SELECT c.id AS claim_id, c.kind, c.text, c.confidence, c.event_at_ms,
                e.id AS episode_id, e.chat_source_id, e.model, e.extraction_version,
                g.grade AS grade,
                COALESCE(NULLIF(TRIM(COALESCE(ch.display_name, '')), ''), NULL) AS chat_display_name
         FROM brain_claims c
         JOIN brain_episodes e ON e.id = c.episode_id AND e.status = 'current' AND e.generator = 'model'
         LEFT JOIN brain_claim_grades g ON g.claim_id = c.id
         LEFT JOIN chats ch ON ch.source_chat_id = e.chat_source_id
         ORDER BY e.model ASC, CASE WHEN g.claim_id IS NULL THEN 0 ELSE 1 END ASC, c.id ASC`
      )
      .all() as Array<Record<string, unknown>>;
    const byModel = new Map<string, BrainGradingSampleClaim[]>();
    for (const row of rows) {
      const model = String(row.model ?? "unknown");
      const graded = row.grade != null;
      if (graded && !options.includeGraded) {
        continue;
      }
      const bucket = byModel.get(model) ?? [];
      if (bucket.length >= perModel) {
        continue;
      }
      bucket.push({
        claimId: String(row.claim_id),
        episodeId: String(row.episode_id),
        chatSourceId: String(row.chat_source_id),
        chatDisplayName: (row.chat_display_name as string | null) ?? null,
        model: (row.model as string | null) ?? null,
        extractionVersion: Number(row.extraction_version ?? 0),
        kind: row.kind as BrainGradingSampleClaim["kind"],
        confidence: row.confidence as BrainGradingSampleClaim["confidence"],
        text: String(row.text),
        eventAtMs: row.event_at_ms == null ? null : Number(row.event_at_ms),
        grade: (row.grade as BrainClaimGradeValue | null) ?? null,
        citations: []
      });
      byModel.set(model, bucket);
    }
    // Resolve cited message text server-side; deleted or missing originals
    // arrive as tombstones, never silent absences.
    const citationStmt = this.db.prepare(
      `SELECT ct.source_message_key, ct.timestamp_ms, ct.sender_source_jid,
              m.id AS message_row, m.is_deleted,
              COALESCE(NULLIF(m.body, ''), NULLIF(m.caption, ''), CASE WHEN m.id IS NULL THEN NULL ELSE '[' || m.message_type || ']' END) AS text
       FROM brain_citations ct
       LEFT JOIN messages m ON m.source_message_key = ct.source_message_key
       WHERE ct.claim_id = ?
       ORDER BY ct.timestamp_ms ASC, ct.id ASC`
    );
    for (const claims of byModel.values()) {
      for (const claim of claims) {
        claim.citations = (citationStmt.all(claim.claimId) as Array<Record<string, unknown>>).map(
          (citation): BrainGradingCitation => ({
            sourceMessageKey: String(citation.source_message_key),
            timestampMs: citation.timestamp_ms == null ? null : Number(citation.timestamp_ms),
            senderSourceJid: (citation.sender_source_jid as string | null) ?? null,
            text: (citation.text as string | null) ?? null,
            deleted: Boolean(citation.is_deleted),
            present: citation.message_row != null
          })
        );
      }
    }
    return {
      perModel,
      models: totals.map((total) => ({
        model: String(total.model ?? "unknown"),
        eligibleClaims: Number(total.eligible ?? 0),
        gradedClaims: Number(total.graded ?? 0),
        claims: byModel.get(String(total.model ?? "unknown")) ?? []
      }))
    };
  }

  // One grade per claim; regrade overwrites. Stamps are read server-side from
  // the claim's episode at grade time — the client supplies only {claimId, grade}.
  async upsertBrainClaimGrade(claimId: string, grade: BrainClaimGradeValue): Promise<BrainClaimGradeRecord> {
    const row = this.db
      .prepare(
        `SELECT c.id AS claim_id, c.kind, c.confidence, c.text,
                e.id AS episode_id, e.chat_source_id, e.generator, e.model, e.extraction_version
         FROM brain_claims c
         JOIN brain_episodes e ON e.id = c.episode_id
         WHERE c.id = ?`
      )
      .get(claimId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new PublicError("BRAIN_EVAL_CLAIM_MISSING", "No claim with that id — it may have been superseded and wiped; refresh the grading sample.");
    }
    const citationKeys = (
      this.db.prepare(`SELECT source_message_key FROM brain_citations WHERE claim_id = ? ORDER BY id`).all(claimId) as Array<{
        source_message_key: string;
      }>
    ).map((citation) => citation.source_message_key);
    const record: BrainClaimGradeRecord = {
      claimId,
      grade,
      gradedAtMs: Date.now(),
      episodeId: String(row.episode_id),
      chatSourceId: String(row.chat_source_id),
      generator: row.generator as BrainClaimGradeRecord["generator"],
      model: (row.model as string | null) ?? null,
      extractionVersion: Number(row.extraction_version ?? 0),
      claimKind: row.kind as BrainClaimGradeRecord["claimKind"],
      claimConfidence: row.confidence as BrainClaimGradeRecord["claimConfidence"],
      claimText: String(row.text),
      citationKeys
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO brain_claim_grades
         (claim_id, grade, graded_at_ms, episode_id, chat_source_id, generator, model, extraction_version, claim_kind, claim_confidence, claim_text, citation_keys_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.claimId,
        record.grade,
        record.gradedAtMs,
        record.episodeId,
        record.chatSourceId,
        record.generator,
        record.model,
        record.extractionVersion,
        record.claimKind,
        record.claimConfidence,
        record.claimText,
        stringifyJson(record.citationKeys)
      );
    return record;
  }

  // Per-(model, extraction_version) quality: grade distribution + strict
  // precision, fallback rate via attempted_model ('unknown' buckets the
  // historical rows that predate the stamp), and issue rates. All statuses
  // count — superseded episodes still evidence generation quality.
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
    const modelRows = this.db
      .prepare(
        `SELECT model, extraction_version AS v, COUNT(*) AS n FROM brain_episodes
         WHERE generator = 'model' AND model IS NOT NULL GROUP BY model, extraction_version`
      )
      .all() as Array<{ model: string; v: number; n: number }>;
    for (const row of modelRows) {
      bucket(row.model, Number(row.v)).modelEpisodes += Number(row.n);
    }
    const fallbackRows = this.db
      .prepare(
        `SELECT COALESCE(attempted_model, 'unknown') AS model, extraction_version AS v, COUNT(*) AS n FROM brain_episodes
         WHERE generator = 'extractive' AND fallback_reason IS NOT NULL GROUP BY COALESCE(attempted_model, 'unknown'), extraction_version`
      )
      .all() as Array<{ model: string; v: number; n: number }>;
    for (const row of fallbackRows) {
      bucket(row.model, Number(row.v)).fallbackEpisodes += Number(row.n);
    }
    const claimRows = this.db
      .prepare(
        `SELECT e.model AS model, e.extraction_version AS v, COUNT(*) AS n
         FROM brain_claims c JOIN brain_episodes e ON e.id = c.episode_id
         WHERE e.generator = 'model' AND e.model IS NOT NULL GROUP BY e.model, e.extraction_version`
      )
      .all() as Array<{ model: string; v: number; n: number }>;
    for (const row of claimRows) {
      bucket(row.model, Number(row.v)).claims += Number(row.n);
    }
    const issueRows = this.db
      .prepare(
        `SELECT CASE WHEN e.generator = 'model' THEN e.model ELSE COALESCE(e.attempted_model, 'unknown') END AS model,
                e.extraction_version AS v,
                SUM(CASE WHEN i.code = 'unanchored' THEN 1 ELSE 0 END) AS unanchored,
                SUM(CASE WHEN i.severity = 'error' THEN 1 ELSE 0 END) AS errors
         FROM brain_validation_issues i
         JOIN brain_episodes e ON e.id = i.episode_id
         WHERE (e.generator = 'model' AND e.model IS NOT NULL) OR (e.generator = 'extractive' AND e.fallback_reason IS NOT NULL)
         GROUP BY 1, 2`
      )
      .all() as Array<{ model: string; v: number; unanchored: number; errors: number }>;
    for (const row of issueRows) {
      const entry = bucket(row.model, Number(row.v));
      entry.unanchoredWarnings += Number(row.unanchored ?? 0);
      entry.validationErrors += Number(row.errors ?? 0);
    }
    const gradeRows = this.db
      .prepare(
        `SELECT COALESCE(model, 'unknown') AS model, extraction_version AS v, grade, COUNT(*) AS n
         FROM brain_claim_grades GROUP BY COALESCE(model, 'unknown'), extraction_version, grade`
      )
      .all() as Array<{ model: string; v: number; grade: BrainClaimGradeValue; n: number }>;
    for (const row of gradeRows) {
      const entry = bucket(row.model, Number(row.v));
      entry.grades[row.grade] += Number(row.n);
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

  // The D13 demand stat: gap counts by modality and impact over current episodes.
  async getBrainMediaGapSummary(): Promise<BrainMediaGapSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT g.modality, g.impact, COUNT(*) AS n
         FROM brain_media_gaps g
         JOIN brain_episodes e ON e.id = g.episode_id
         WHERE e.status = 'current'
         GROUP BY g.modality, g.impact
         ORDER BY n DESC`
      )
      .all() as Array<{ modality: string; impact: string; n: number }>;
    return rows.map((row) => ({
      modality: row.modality as BrainMediaGapSummary["modality"],
      impact: row.impact as BrainMediaGapSummary["impact"],
      count: Number(row.n)
    }));
  }

  // Materiality-aware regeneration selector (D13): current episodes carrying a
  // gap of the given impact — what a future media-interpretation change
  // regenerates first, instead of every episode containing a sticker.
  async listBrainEpisodesWithMediaGaps(options: { impact: BrainMediaGapImpact; limit: number }): Promise<BrainEpisodeRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT e.*, COALESCE(NULLIF(TRIM(COALESCE(ch.display_name, '')), ''), NULL) AS chat_display_name
         FROM brain_episodes e
         JOIN brain_media_gaps g ON g.episode_id = e.id AND g.impact = ?
         LEFT JOIN chats ch ON ch.source_chat_id = e.chat_source_id
         WHERE e.status = 'current'
         ORDER BY e.end_at_ms DESC
         LIMIT ?`
      )
      .all(options.impact, options.limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToBrainEpisode(row));
  }

  async recordBrainValidationIssues(issues: BrainValidationIssueInput[]): Promise<void> {
    if (issues.length === 0) {
      return;
    }
    const insert = this.db.prepare(
      `INSERT INTO brain_validation_issues (run_id, chat_source_id, episode_id, claim_sequence, doc_id, code, severity, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const transaction = this.db.transaction(() => {
      for (const issue of issues) {
        insert.run(
          issue.runId ?? null,
          issue.chatSourceId ?? null,
          issue.episodeId ?? null,
          issue.claimSequence ?? null,
          issue.docId ?? null,
          issue.code,
          issue.severity,
          issue.detail ?? null
        );
      }
    });
    transaction();
  }

  async listBrainValidationIssues(options?: {
    episodeId?: string | null;
    docId?: string | null;
    runId?: string | null;
    limit?: number;
  }): Promise<BrainValidationIssueRecord[]> {
    const params: unknown[] = [];
    let where = "";
    if (options?.episodeId) {
      where = "WHERE episode_id = ?";
      params.push(options.episodeId);
    } else if (options?.docId) {
      where = "WHERE doc_id = ?";
      params.push(options.docId);
    } else if (options?.runId) {
      where = "WHERE run_id = ?";
      params.push(options.runId);
    }
    params.push(options?.limit ?? 100);
    const rows = this.db
      .prepare(`SELECT * FROM brain_validation_issues ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id),
      runId: (row.run_id as string | null) ?? null,
      chatSourceId: (row.chat_source_id as string | null) ?? null,
      episodeId: (row.episode_id as string | null) ?? null,
      claimSequence: row.claim_sequence == null ? null : Number(row.claim_sequence),
      docId: (row.doc_id as string | null) ?? null,
      code: String(row.code),
      severity: row.severity as BrainValidationIssueRecord["severity"],
      detail: (row.detail as string | null) ?? null,
      createdAt: String(row.created_at)
    }));
  }

  async getBrainValidationIssueSummary(): Promise<BrainValidationIssueSummary> {
    const rows = this.db
      .prepare(`SELECT severity, COUNT(*) AS n FROM brain_validation_issues GROUP BY severity`)
      .all() as Array<{ severity: string; n: number }>;
    const summary: BrainValidationIssueSummary = { error: 0, warning: 0, info: 0 };
    for (const row of rows) {
      if (row.severity === "error" || row.severity === "warning" || row.severity === "info") {
        summary[row.severity] = Number(row.n);
      }
    }
    return summary;
  }

  async listBrainTopicVocabulary(chatSourceId: string, limit: number): Promise<string[]> {
    // This chat's topics by usage first, then global by usage — deterministic,
    // $0 "nearest" until the graph provides a better ranking.
    const chatTopics = this.db
      .prepare(
        `SELECT t.title, COUNT(*) AS n
         FROM brain_episode_topics et
         JOIN brain_topics t ON t.id = et.topic_id
         JOIN brain_episodes e ON e.id = et.episode_id
         WHERE e.chat_source_id = ?
         GROUP BY t.id ORDER BY n DESC, t.title ASC LIMIT ?`
      )
      .all(chatSourceId, limit) as Array<{ title: string }>;
    const globalTopics = this.db
      .prepare(
        `SELECT t.title, COUNT(et.episode_id) AS n
         FROM brain_topics t
         LEFT JOIN brain_episode_topics et ON et.topic_id = t.id
         GROUP BY t.id ORDER BY n DESC, t.title ASC LIMIT ?`
      )
      .all(limit) as Array<{ title: string }>;
    const seen = new Set<string>();
    const titles: string[] = [];
    for (const row of [...chatTopics, ...globalTopics]) {
      const key = row.title.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        titles.push(row.title);
      }
      if (titles.length >= limit) {
        break;
      }
    }
    return titles;
  }

  async markStaleEpisodesForMessages(sourceMessageKeys: string[]): Promise<number> {
    const keys = [...new Set(sourceMessageKeys.filter((key) => typeof key === "string" && key.length > 0))];
    if (keys.length === 0) {
      return 0;
    }
    // Reverse-map changed keys to the current episodes that either cite the
    // message or stamped a structured signal from it. The latter preserves
    // message-owned source annotations even when a model did not cite the line.
    const episodes = new Map<string, { chatSourceId: string; startAtMs: number; endAtMs: number }>();
    for (let index = 0; index < keys.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = keys.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT DISTINCT e.id, e.chat_source_id, e.start_at_ms, e.end_at_ms
           FROM brain_episodes e
           LEFT JOIN brain_claims cl ON cl.episode_id = e.id
           LEFT JOIN brain_citations c ON c.claim_id = cl.id
           LEFT JOIN brain_episode_signal_anchors sa ON sa.episode_id = e.id
           WHERE e.status = 'current'
             AND (c.source_message_key IN (${placeholders}) OR sa.source_message_key IN (${placeholders}))`
        )
        .all(...batch, ...batch) as Array<{ id: string; chat_source_id: string; start_at_ms: number; end_at_ms: number }>;
      for (const row of rows) {
        episodes.set(row.id, {
          chatSourceId: String(row.chat_source_id),
          startAtMs: Number(row.start_at_ms),
          endAtMs: Number(row.end_at_ms)
        });
      }
    }
    if (episodes.size === 0) {
      return 0;
    }
    const markStale = this.db.prepare(`UPDATE brain_episodes SET status = 'stale' WHERE id = ? AND status = 'current'`);
    // Regeneration reuses the 'episode' kind (no schema change): the payload's
    // regen flag tells the executor to rebuild this exact window verbatim
    // rather than the watermark-forward window.
    const enqueue = this.db.prepare(
      `INSERT OR IGNORE INTO brain_tasks (kind, chat_source_id, payload_json, dedupe_key, priority)
       VALUES ('episode', ?, ?, ?, ?)`
    );
    let marked = 0;
    const transaction = this.db.transaction(() => {
      for (const [episodeId, window] of episodes) {
        marked += markStale.run(episodeId).changes;
        enqueue.run(
          window.chatSourceId,
          stringifyJson({ chatSourceId: window.chatSourceId, sinceMs: window.startAtMs, throughMs: window.endAtMs, regen: true, episodeId }),
          `regen:${episodeId}`,
          1_000
        );
      }
    });
    transaction();
    return marked;
  }

  // A reply need not be cited for its quote to have shaped the evidence, so
  // quote enrichment uses the mechanically persisted reply-anchor stamp rather
  // than the citation reverse map above.
  private async markStaleEpisodesForQuotedReplies(replySourceMessageKeys: string[]): Promise<number> {
    const keys = [...new Set(replySourceMessageKeys.filter(Boolean))];
    if (keys.length === 0) {
      return 0;
    }
    const episodes = new Map<string, { chatSourceId: string; startAtMs: number; endAtMs: number }>();
    for (const key of keys) {
      const rows = this.db
        .prepare(
          `SELECT id, chat_source_id, start_at_ms, end_at_ms FROM brain_episodes
           WHERE status = 'current' AND EXISTS (
             SELECT 1 FROM json_each(COALESCE(quoted_reply_anchors_json, '[]')) anchor
             WHERE json_extract(anchor.value, '$.replySourceMessageKey') = ?
           )`
        )
        .all(key) as Array<{ id: string; chat_source_id: string; start_at_ms: number; end_at_ms: number }>;
      for (const row of rows) {
        episodes.set(row.id, { chatSourceId: row.chat_source_id, startAtMs: row.start_at_ms, endAtMs: row.end_at_ms });
      }
    }
    if (episodes.size === 0) {
      return 0;
    }
    const stale = this.db.prepare(`UPDATE brain_episodes SET status = 'stale' WHERE id = ? AND status = 'current'`);
    const enqueue = this.db.prepare(
      `INSERT OR IGNORE INTO brain_tasks (kind, chat_source_id, payload_json, dedupe_key, priority)
       VALUES ('episode', ?, ?, ?, ?)`
    );
    let marked = 0;
    this.db.transaction(() => {
      for (const [episodeId, window] of episodes) {
        marked += stale.run(episodeId).changes;
        enqueue.run(
          window.chatSourceId,
          stringifyJson({ chatSourceId: window.chatSourceId, sinceMs: window.startAtMs, throughMs: window.endAtMs, regen: true, episodeId }),
          `regen:${episodeId}`,
          1_000
        );
      }
    })();
    return marked;
  }

  async collapseSupersededMessages(
    pairs: Array<{ chatSourceId: string; staleMessageId: string; canonicalMessageId: string }>
  ): Promise<number> {
    this.assertWritableIdentityVersion();
    if (pairs.length === 0) {
      return 0;
    }
    // The stale row is a previous import of the same message under its edit
    // key. Collapse through the central pair merger so reply-owned snapshots
    // (and their full monotonic fields) move to the canonical key before the
    // stale row's foreign-key cascade removes it.
    const findPair = this.db.prepare(
      `SELECT stale.id AS stale_id, canonical.id AS canonical_id
       FROM messages stale JOIN messages canonical
         ON canonical.source_message_key = ?
       WHERE stale.source_message_key = ?`
    );
    let collapsed = 0;
    const quoteAffectedKeys: string[] = [];
    const transaction = this.db.transaction(() => {
      for (const pair of pairs) {
        const chatSourceId = this.canonicalJid(pair.chatSourceId) ?? pair.chatSourceId;
        const staleKey = messageKey(chatSourceId, pair.staleMessageId);
        const canonicalKey = messageKey(chatSourceId, pair.canonicalMessageId);
        const match = findPair.get(canonicalKey, staleKey) as { stale_id: number; canonical_id: number } | undefined;
        if (!match) {
          continue;
        }
        this.collapseMessagePair(match.canonical_id, match.stale_id);
        quoteAffectedKeys.push(staleKey, canonicalKey);
        collapsed += 1;
      }
    });
    transaction();
    if (collapsed > 0) {
      await this.markStaleMemoryForMissingMessages();
      await this.markStaleEpisodesForQuotedReplies(quoteAffectedKeys);
    }
    return collapsed;
  }

  async listUnknownTypeCodes(): Promise<Array<{ code: string; count: number; examples: Array<{ chatLabel: string; timestampMs: number | null }> }>> {
    const codes = this.db
      .prepare(
        `SELECT COALESCE(NULLIF(TRIM(COALESCE(raw_type_code, '')), ''), REPLACE(message_type, 'unknown_', '')) AS code, COUNT(*) AS n
         FROM messages
         WHERE message_type LIKE 'unknown%'
         GROUP BY 1
         ORDER BY n DESC, code ASC`
      )
      .all() as Array<{ code: string; n: number }>;
    const exampleStmt = this.db.prepare(
      `SELECT COALESCE(NULLIF(TRIM(COALESCE(c.display_name, '')), ''), '') AS display_name, c.jid AS jid, m.timestamp_ms AS timestamp_ms
       FROM messages m
       JOIN chats c ON c.id = m.chat_id
       WHERE m.message_type LIKE 'unknown%'
         AND COALESCE(NULLIF(TRIM(COALESCE(m.raw_type_code, '')), ''), REPLACE(m.message_type, 'unknown_', '')) = ?
       ORDER BY m.timestamp_ms DESC
       LIMIT 3`
    );
    return codes.map((row) => ({
      code: String(row.code),
      count: Number(row.n),
      examples: (exampleStmt.all(String(row.code)) as Array<{ display_name: string; jid: string; timestamp_ms: number | null }>).map(
        (example) => ({
          // Display rule: name, else phone digits, never a raw identifier.
          chatLabel:
            example.display_name ||
            displayPhoneFromJid(example.jid) ||
            (example.jid.endsWith("@g.us") ? "Unnamed group" : "Unresolved chat"),
          timestampMs: example.timestamp_ms == null ? null : Number(example.timestamp_ms)
        })
      )
    }));
  }

  // One-time hygiene for rows written before identity-derived names were
  // rejected at the write boundary.
  async clearIdentityDerivedChatNames(): Promise<number> {
    const rows = this.db
      .prepare(`SELECT id, display_name, jid FROM chats WHERE display_name IS NOT NULL AND TRIM(display_name) <> ''`)
      .all() as Array<{ id: number; display_name: string; jid: string }>;
    const clear = this.db.prepare(`UPDATE chats SET display_name = NULL, updated_at = ? WHERE id = ?`);
    let cleared = 0;
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        if (isIdentityDerivedName(row.display_name, row.jid)) {
          clear.run(currentIso(), row.id);
          cleared += 1;
        }
      }
    });
    transaction();
    return cleared;
  }

  // Rows created from Signal-protocol transport envelopes before normalization
  // filtered them: no user content by construction, safe to remove as noise.
  async removeProtocolNoiseMessages(): Promise<number> {
    // Live artifacts that were archived as standalone rows before normalization
    // filtered them: Signal-protocol transport envelopes, and secret-encrypted
    // edit envelopes (now applied in place as edits, so their placeholder card
    // is stale). Both are never user messages of their own.
    const noiseTypes = ["unknown_senderKeyDistributionMessage", "encrypted_update"];
    const placeholders = noiseTypes.map(() => "?").join(",");
    const affectedChats = this.db
      .prepare(
        `SELECT DISTINCT c.source_chat_id AS id
         FROM messages m JOIN chats c ON c.id = m.chat_id
         WHERE m.source_table LIKE 'wa-web%' AND m.message_type IN (${placeholders})`
      )
      .all(...noiseTypes) as Array<{ id: string }>;
    if (affectedChats.length === 0) {
      return 0;
    }
    const result = this.db
      .prepare(`DELETE FROM messages WHERE source_table LIKE 'wa-web%' AND message_type IN (${placeholders})`)
      .run(...noiseTypes);
    if (result.changes > 0) {
      await this.refreshChatStats(affectedChats.map((chat) => chat.id));
      await this.markStaleMemoryForMissingMessages();
    }
    return result.changes;
  }

  async listUnnamedGroupChats(limit = 20): Promise<string[]> {
    const rows = this.db
      .prepare(
        `SELECT source_chat_id FROM chats
         WHERE chat_type = 'group' AND (display_name IS NULL OR TRIM(display_name) = '' OR display_name = jid)
         ORDER BY last_message_at_ms IS NULL, last_message_at_ms DESC
         LIMIT ?`
      )
      .all(Math.max(1, limit)) as Array<{ source_chat_id: string }>;
    return rows.map((row) => row.source_chat_id);
  }

  async listUnmergedLidIdentities(limit = 20): Promise<Array<{ lid: string; pn: string }>> {
    return this.db
      .prepare(
        `SELECT l.lid, l.pn FROM identity_links l
         WHERE EXISTS (SELECT 1 FROM chats WHERE chats.source_chat_id = l.lid)
            OR EXISTS (SELECT 1 FROM contacts WHERE contacts.source_jid = l.lid)
            OR EXISTS (SELECT 1 FROM messages WHERE messages.sender_source_jid = l.lid)
            OR EXISTS (SELECT 1 FROM chat_participants WHERE chat_participants.source_jid = l.lid)
         LIMIT ?`
      )
      .all(Math.max(1, limit)) as Array<{ lid: string; pn: string }>;
  }

  async mergeIdentity(lid: string, pn: string): Promise<{ chatsMerged: number; contactsMerged: number; messagesCollapsed: number }> {
    const result = { chatsMerged: 0, contactsMerged: 0, messagesCollapsed: 0 };
    // The vast majority of learned links have nothing archived under the LID
    // form (history sync ships mappings for every contact); skip the merge
    // machinery entirely unless the LID actually appears somewhere.
    const hasPresence = this.db
      .prepare(
        `SELECT EXISTS (SELECT 1 FROM chats WHERE source_chat_id = ?)
             OR EXISTS (SELECT 1 FROM contacts WHERE source_jid = ?)
             OR EXISTS (SELECT 1 FROM messages WHERE sender_source_jid = ?)
             OR EXISTS (SELECT 1 FROM chat_participants WHERE source_jid = ?)
             OR EXISTS (SELECT 1 FROM identity_number_changes WHERE old_jid = ? OR new_jid = ? OR actor_jid = ?)
             OR EXISTS (SELECT 1 FROM group_membership_periods WHERE group_source_id = ? OR participant_jid = ?)
             OR EXISTS (SELECT 1 FROM group_membership_events WHERE group_source_id = ? OR participant_jid = ? OR actor_jid = ?)
             OR EXISTS (SELECT 1 FROM message_vcards WHERE resolved_jid = ?)
             OR EXISTS (SELECT 1 FROM message_deletions WHERE revoked_by_jid = ?)
             OR EXISTS (SELECT 1 FROM engagement_aggregates WHERE chat_source_id = ? OR counterparty_jid = ?)
             OR EXISTS (SELECT 1 FROM live_chat_checkpoints WHERE chat_source_id = ?)
             OR EXISTS (SELECT 1 FROM live_gap_windows WHERE chat_source_id = ?)
             OR EXISTS (SELECT 1 FROM person_members WHERE identity_jid = ?)
             OR EXISTS (SELECT 1 FROM person_suggestions WHERE jid_low = ? OR jid_high = ?)
             OR EXISTS (SELECT 1 FROM person_link_suppressions WHERE jid_low = ? OR jid_high = ?) AS present`
      )
      .get(lid, lid, lid, lid, lid, lid, lid, lid, lid, lid, lid, lid, lid, lid, lid, lid, lid, lid, lid, lid, lid, lid, lid) as { present: number };
    if (!hasPresence.present) {
      return result;
    }
    const transaction = this.db.transaction(() => {
      // Chats: rename when the canonical chat is absent; otherwise move
      // messages across and collapse (chat, id) conflicts onto the richer row.
      const lidChat = this.db.prepare(`SELECT id FROM chats WHERE source_chat_id = ?`).get(lid) as { id: number } | undefined;
      const pnChat = this.db.prepare(`SELECT id FROM chats WHERE source_chat_id = ?`).get(pn) as { id: number } | undefined;
      if (lidChat && !pnChat) {
        this.db.prepare(`UPDATE chats SET source_chat_id = ?, jid = ?, updated_at = ? WHERE id = ?`).run(pn, pn, currentIso(), lidChat.id);
        this.rekeyChatMessages(lidChat.id, pn);
        result.chatsMerged += 1;
      } else if (lidChat && pnChat) {
        const moveTargets = this.db
          .prepare(`SELECT id, source_message_id FROM messages WHERE chat_id = ?`)
          .all(lidChat.id) as Array<{ id: number; source_message_id: string }>;
        const findConflict = this.db.prepare(`SELECT id FROM messages WHERE chat_id = ? AND source_message_id = ?`);
        const moveOne = this.db.prepare(`UPDATE messages SET chat_id = ?, source_message_key = ? WHERE id = ?`);
        for (const message of moveTargets) {
          const conflict = findConflict.get(pnChat.id, message.source_message_id) as { id: number } | undefined;
          if (conflict) {
            this.collapseMessagePair(conflict.id, message.id);
            result.messagesCollapsed += 1;
          } else {
            moveOne.run(pnChat.id, messageKey(pn, message.source_message_id), message.id);
          }
        }
        this.db
          .prepare(
            `UPDATE chats SET
               display_name = COALESCE(NULLIF(chats.display_name, ''), (SELECT NULLIF(display_name, '') FROM chats c2 WHERE c2.id = ?)),
               platform_recency_ms = MAX(COALESCE(chats.platform_recency_ms, 0), COALESCE((SELECT platform_recency_ms FROM chats c2 WHERE c2.id = ?), 0)),
               updated_at = ?
             WHERE id = ?`
          )
          .run(lidChat.id, lidChat.id, currentIso(), pnChat.id);
        this.db.prepare(`DELETE FROM chat_participants WHERE chat_id = ? AND source_jid IN (SELECT source_jid FROM chat_participants WHERE chat_id = ?)`).run(lidChat.id, pnChat.id);
        this.db.prepare(`UPDATE chat_participants SET chat_id = ? WHERE chat_id = ?`).run(pnChat.id, lidChat.id);
        this.db.prepare(`DELETE FROM chats WHERE id = ?`).run(lidChat.id);
        result.chatsMerged += 1;
      }

      // Contacts: keep the canonical row, absorb missing fields, delete the husk.
      const lidContact = this.db.prepare(`SELECT id FROM contacts WHERE source_jid = ?`).get(lid) as { id: number } | undefined;
      const pnContact = this.db.prepare(`SELECT id FROM contacts WHERE source_jid = ?`).get(pn) as { id: number } | undefined;
      if (lidContact && !pnContact) {
        this.db.prepare(`UPDATE contacts SET source_jid = ?, updated_at = ? WHERE id = ?`).run(pn, currentIso(), lidContact.id);
        result.contactsMerged += 1;
      } else if (lidContact && pnContact) {
        this.db
          .prepare(
            `UPDATE contacts SET
               display_name = COALESCE(NULLIF(contacts.display_name, ''), (SELECT NULLIF(display_name, '') FROM contacts c2 WHERE c2.id = ?)),
               push_name = COALESCE(NULLIF(contacts.push_name, ''), (SELECT NULLIF(push_name, '') FROM contacts c2 WHERE c2.id = ?)),
               phone_number = COALESCE(contacts.phone_number, (SELECT phone_number FROM contacts c2 WHERE c2.id = ?)),
               updated_at = ?
             WHERE id = ?`
          )
          .run(lidContact.id, lidContact.id, lidContact.id, currentIso(), pnContact.id);
        this.db.prepare(`UPDATE messages SET sender_contact_id = ? WHERE sender_contact_id = ?`).run(pnContact.id, lidContact.id);
        this.db.prepare(`UPDATE chat_participants SET contact_id = ? WHERE contact_id = ?`).run(pnContact.id, lidContact.id);
        this.db.prepare(`DELETE FROM contacts WHERE id = ?`).run(lidContact.id);
        result.contactsMerged += 1;
      }
      this.db.prepare(`UPDATE messages SET sender_source_jid = ? WHERE sender_source_jid = ?`).run(pn, lid);
      this.db
        .prepare(`DELETE FROM chat_participants WHERE source_jid = ? AND EXISTS (SELECT 1 FROM chat_participants p2 WHERE p2.chat_id = chat_participants.chat_id AND p2.source_jid = ?)`)
        .run(lid, pn);
      this.db.prepare(`UPDATE chat_participants SET source_jid = ? WHERE source_jid = ?`).run(pn, lid);
      // Mentions recorded under the LID collapse onto the canonical identity;
      // rows that would duplicate an existing canonical mention just drop.
      this.db.prepare(`UPDATE OR IGNORE message_mentions SET mentioned_jid = ? WHERE mentioned_jid = ?`).run(pn, lid);
      this.db.prepare(`DELETE FROM message_mentions WHERE mentioned_jid = ?`).run(lid);
      // Every JID-bearing archive signal follows the same canonical identity
      // merge. Signal rows are local evidence, never display-name joins.
      this.db.prepare(`UPDATE identity_number_changes SET old_jid = ? WHERE old_jid = ?`).run(pn, lid);
      this.db.prepare(`UPDATE identity_number_changes SET new_jid = ? WHERE new_jid = ?`).run(pn, lid);
      this.db.prepare(`UPDATE identity_number_changes SET actor_jid = ? WHERE actor_jid = ?`).run(pn, lid);
      this.db.prepare(`UPDATE group_membership_periods SET group_source_id = ? WHERE group_source_id = ?`).run(pn, lid);
      this.db.prepare(`UPDATE group_membership_periods SET participant_jid = ? WHERE participant_jid = ?`).run(pn, lid);
      this.db.prepare(`UPDATE group_membership_events SET group_source_id = ? WHERE group_source_id = ?`).run(pn, lid);
      this.db.prepare(`UPDATE group_membership_events SET participant_jid = ? WHERE participant_jid = ?`).run(pn, lid);
      this.db.prepare(`UPDATE group_membership_events SET actor_jid = ? WHERE actor_jid = ?`).run(pn, lid);
      this.db.prepare(`UPDATE chat_metadata_history SET chat_source_id = ? WHERE chat_source_id = ?`).run(pn, lid);
      this.db.prepare(`UPDATE chat_metadata_history SET actor_jid = ? WHERE actor_jid = ?`).run(pn, lid);
      this.db.prepare(`UPDATE message_vcards SET resolved_jid = ? WHERE resolved_jid = ?`).run(pn, lid);
      this.db.prepare(`UPDATE message_deletions SET revoked_by_jid = ? WHERE revoked_by_jid = ?`).run(pn, lid);
      this.db.prepare(`UPDATE engagement_aggregates SET chat_source_id = ? WHERE chat_source_id = ?`).run(pn, lid);
      this.db.prepare(`UPDATE engagement_aggregates SET counterparty_jid = ? WHERE counterparty_jid = ?`).run(pn, lid);

      // Person layer follows the canonical identity: memberships rewrite,
      // pair rows re-normalize (self-referential pairs vanish), and persons
      // revealed to share an identity union.
      this.rewritePersonLayerForMergeTx(lid, pn);

      // Live bookkeeping follows the merge.
      const pnCheckpoint = this.db.prepare(`SELECT chat_source_id FROM live_chat_checkpoints WHERE chat_source_id = ?`).get(pn);
      if (pnCheckpoint) {
        this.db.prepare(`DELETE FROM live_chat_checkpoints WHERE chat_source_id = ?`).run(lid);
      } else {
        this.db.prepare(`UPDATE live_chat_checkpoints SET chat_source_id = ? WHERE chat_source_id = ?`).run(pn, lid);
      }
      // Anchor keys embed the old chat form; recovery recomputes them anyway.
      this.db.prepare(`UPDATE live_gap_windows SET chat_source_id = ?, anchor_message_key = NULL WHERE chat_source_id = ?`).run(pn, lid);
      this.db.prepare(`UPDATE live_message_updates SET chat_source_id = ? WHERE chat_source_id = ?`).run(pn, lid);

      // brain-correctness-debts D2: reconcile derived brain state so a merge
      // strands no watermark, spawns no duplicate re-assimilation, and leaves
      // no citation pointing at a stale key. Deterministic, no model call. Runs
      // last, after messages are fully rekeyed, so citation keys resolve to the
      // post-merge form via the stable rowid anchor.
      this.db.prepare(`UPDATE brain_episodes SET chat_source_id = ? WHERE chat_source_id = ?`).run(pn, lid);
      this.db
        .prepare(
          `UPDATE brain_citations
             SET source_message_key = COALESCE((SELECT source_message_key FROM messages WHERE id = brain_citations.message_id), source_message_key),
                 source_chat_id = ?
           WHERE source_chat_id = ?`
        )
        .run(pn, lid);
      // Merge the compound watermark cursor onto the survivor (greater cursor
      // wins), then drop the dead-identity row.
      const lidWatermark = this.db
        .prepare(`SELECT assimilated_through_ms, assimilated_through_id, last_episode_at FROM brain_chat_watermarks WHERE chat_source_id = ?`)
        .get(lid) as { assimilated_through_ms: number; assimilated_through_id: number; last_episode_at: string | null } | undefined;
      if (lidWatermark) {
        this.db
          .prepare(WATERMARK_CURSOR_UPSERT)
          .run(pn, lidWatermark.assimilated_through_ms, lidWatermark.assimilated_through_id, lidWatermark.last_episode_at ?? currentIso(), currentIso());
        this.db.prepare(`DELETE FROM brain_chat_watermarks WHERE chat_source_id = ?`).run(lid);
      }
      // Pending tasks embed the pre-merge chat and its watermark in their dedupe
      // key and window; drop them so the drain never re-covers an orphaned
      // window. The next due/audit pass re-enqueues from the merged cursor.
      this.db.prepare(`DELETE FROM brain_tasks WHERE chat_source_id = ?`).run(lid);
      // Graph rekey rides the same transaction: person/chat nodes follow the
      // canonical JID (redirect stubs keep held ids resolvable), chat-scoped
      // natural keys rewrite, duplicate edges merge with evidence intact.
      this.rekeyGraphForIdentityMergeTx(lid, pn);
    });
    transaction();
    this.invalidateBrainStatusCache();
    await this.refreshChatStats([pn]);
    await this.markStaleMemoryForMissingMessages();
    // The merge may have improved name resolution for this identity: refresh
    // derived search text for its messages and the messages that mention it,
    // chunked with yields so a heavy sender never stalls ingestion.
    await this.recomputeFtsForIdentities([pn]);
    // Deterministic brain-prose repair: old episodes still carry the merged
    // identity's `lid:` token in their summary/claims. Substitute it with the
    // now-known number (or a name if the survivor has one). FTS is already
    // recomputed above, so only the prose+projection half runs here. The stamp
    // records the LID form, so both JIDs are candidates.
    await this.repairBrainProseForIdentities(new Set([pn, lid]));
    this.invalidateBrainStatusCache();
    return result;
  }

  // === Knowledge graph engine =============================================
  // Derived-of-derived: every producer below is deterministic (zero model
  // calls), keyed by natural keys so replay/regeneration/merge converge, and
  // rebuildable from committed episodes + captured signals by construction.

  private ensureGraphNodeTx(spec: GraphNodeSpec): string {
    const existing = this.db
      .prepare(
        `SELECT id, title, payload_json AS payloadJson, first_seen_at_ms AS firstSeen, last_seen_at_ms AS lastSeen FROM brain_nodes WHERE natural_key = ?`
      )
      .get(spec.naturalKey) as
      | { id: string; title: string | null; payloadJson: string | null; firstSeen: number | null; lastSeen: number | null }
      | undefined;
    const now = currentIso();
    if (existing) {
      const first = minNullableMs(existing.firstSeen, spec.seenAtMs);
      const last = maxNullableMs(existing.lastSeen, spec.seenAtMs);
      // Titles are display metadata only (identity labels resolve at read
      // time); first non-null wins so re-derivation cannot churn them.
      const title = existing.title ?? spec.title ?? null;
      const payload = existing.payloadJson ?? (spec.payload ? JSON.stringify(spec.payload) : null);
      if (first !== existing.firstSeen || last !== existing.lastSeen || title !== existing.title || payload !== existing.payloadJson) {
        this.db
          .prepare(`UPDATE brain_nodes SET title = ?, payload_json = ?, first_seen_at_ms = ?, last_seen_at_ms = ?, updated_at = ? WHERE id = ?`)
          .run(title, payload, first, last, now, existing.id);
      }
      return existing.id;
    }
    const id = randomUUID();
    const slugTaken = this.db.prepare(`SELECT 1 FROM brain_nodes WHERE slug = ?`);
    const slug = slugForGraphNode(spec.kind, spec.slugSeed, spec.naturalKey, (candidate) => Boolean(slugTaken.get(candidate)));
    this.db
      .prepare(
        `INSERT INTO brain_nodes (id, kind, natural_key, slug, title, jid, chat_scope, payload_json, first_seen_at_ms, last_seen_at_ms, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        spec.kind,
        spec.naturalKey,
        slug,
        spec.title,
        spec.jid,
        spec.chatScope,
        spec.payload ? JSON.stringify(spec.payload) : null,
        spec.seenAtMs,
        spec.seenAtMs,
        now,
        now
      );
    return id;
  }

  // Upsert an edge and attach one evidence row. Counts stay exact under replay
  // because the evidence key is the dedupe identity: only a genuinely new row
  // bumps evidence_count/weight. Returns whether the evidence was new.
  private addGraphEdgeEvidenceTx(
    srcNodeId: string,
    dstNodeId: string,
    kind: BrainGraphEdgeKind,
    evidence: GraphEvidenceSpec,
    bounds?: { firstMs?: number | null; lastMs?: number | null }
  ): boolean {
    const observed = evidence.observedAtMs ?? null;
    const firstCandidate = bounds?.firstMs ?? observed;
    const lastCandidate = bounds?.lastMs ?? observed;
    const now = currentIso();
    const existing = this.db
      .prepare(
        `SELECT id, first_seen_at_ms AS firstSeen, last_seen_at_ms AS lastSeen FROM brain_edges WHERE src_node_id = ? AND dst_node_id = ? AND kind = ?`
      )
      .get(srcNodeId, dstNodeId, kind) as { id: number; firstSeen: number | null; lastSeen: number | null } | undefined;
    const edgeId = existing
      ? existing.id
      : Number(
          this.db
            .prepare(
              `INSERT INTO brain_edges (src_node_id, dst_node_id, kind, weight, evidence_count, first_seen_at_ms, last_seen_at_ms, updated_at)
               VALUES (?, ?, ?, 0, 0, ?, ?, ?)`
            )
            .run(srcNodeId, dstNodeId, kind, firstCandidate, lastCandidate, now).lastInsertRowid
        );
    const inserted =
      this.db
        .prepare(
          `INSERT OR IGNORE INTO brain_edge_evidence (edge_id, evidence_key, claim_id, source_message_key, source_ref, observed_at_ms)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(edgeId, evidence.key, evidence.claimId ?? null, evidence.sourceMessageKey ?? null, evidence.sourceRef ?? null, observed).changes >
      0;
    const first = minNullableMs(existing?.firstSeen ?? firstCandidate, firstCandidate);
    const last = maxNullableMs(existing?.lastSeen ?? lastCandidate, lastCandidate);
    this.db
      .prepare(
        `UPDATE brain_edges SET evidence_count = evidence_count + ?, weight = weight + ?, first_seen_at_ms = ?, last_seen_at_ms = ?, updated_at = ? WHERE id = ?`
      )
      .run(inserted ? 1 : 0, inserted ? 1 : 0, first, last, now, edgeId);
    return inserted;
  }

  private applyGraphMutationsTx(mutations: GraphMutations): void {
    const idByKey = new Map<string, string>();
    for (const spec of mutations.nodes.values()) {
      idByKey.set(spec.naturalKey, this.ensureGraphNodeTx(spec));
    }
    // Edge targets may be existing nodes referenced by natural key only (e.g.
    // lifecycle nodes from earlier episodes); resolve those from the table.
    const resolveKey = (key: string): string | undefined => {
      const known = idByKey.get(key);
      if (known) {
        return known;
      }
      const row = this.db.prepare(`SELECT id FROM brain_nodes WHERE natural_key = ?`).get(key) as { id: string } | undefined;
      if (row) {
        idByKey.set(key, row.id);
      }
      return row?.id;
    };
    const insertClaimLink = this.db.prepare(`INSERT OR IGNORE INTO brain_node_claims (node_id, claim_id) VALUES (?, ?)`);
    for (const link of mutations.claimLinks) {
      const nodeId = resolveKey(link.nodeKey);
      if (nodeId) {
        insertClaimLink.run(nodeId, link.claimId);
      }
    }
    const insertAlias = this.db.prepare(`INSERT OR IGNORE INTO brain_node_aliases (node_id, alias, source, created_at) VALUES (?, ?, ?, ?)`);
    for (const alias of mutations.aliases) {
      const nodeId = resolveKey(alias.nodeKey);
      const clean = alias.alias.trim();
      if (nodeId && clean) {
        insertAlias.run(nodeId, clean, alias.source, currentIso());
      }
    }
    for (const edge of mutations.edges) {
      const srcId = resolveKey(edge.srcKey);
      const dstId = resolveKey(edge.dstKey);
      if (srcId && dstId && srcId !== dstId) {
        this.addGraphEdgeEvidenceTx(srcId, dstId, edge.kind, edge.evidence);
      }
    }
  }

  // Read the committed claims/entities/citations/topics back (visible inside
  // the transaction) so commit-time derivation and rebuild replay share ONE
  // code path over the same committed inputs.
  private buildEpisodeGraphSourceTx(meta: {
    episodeId: string;
    chatSourceId: string;
    startAtMs: number;
    endAtMs: number;
  }): GraphEpisodeSource {
    const claims = (
      this.db
        .prepare(
          `SELECT id, kind, text, event_at_ms AS eventAtMs, valid_until_ms AS validUntilMs FROM brain_claims WHERE episode_id = ? ORDER BY sequence`
        )
        .all(meta.episodeId) as Array<{ id: string; kind: string; text: string; eventAtMs: number | null; validUntilMs: number | null }>
    ).map((claim) => ({
      id: claim.id,
      kind: claim.kind as GraphEpisodeSource["claims"][number]["kind"],
      text: claim.text,
      eventAtMs: claim.eventAtMs,
      validUntilMs: claim.validUntilMs,
      entities: this.db
        .prepare(`SELECT kind, name, jid, role FROM brain_claim_entities WHERE claim_id = ? ORDER BY id`)
        .all(claim.id) as Array<{ kind: "person" | "org" | "place" | "project" | "other"; name: string; jid: string | null; role: string | null }>,
      citations: this.db
        .prepare(
          `SELECT source_message_key AS sourceMessageKey, sender_source_jid AS senderSourceJid, timestamp_ms AS timestampMs FROM brain_citations WHERE claim_id = ?`
        )
        .all(claim.id) as Array<{ sourceMessageKey: string; senderSourceJid: string | null; timestampMs: number | null }>
    }));
    const topics = (
      this.db
        .prepare(`SELECT t.title FROM brain_episode_topics et JOIN brain_topics t ON t.id = et.topic_id WHERE et.episode_id = ?`)
        .all(meta.episodeId) as Array<{ title: string }>
    ).map((row) => row.title);
    return {
      id: meta.episodeId,
      chatSourceId: meta.chatSourceId,
      startAtMs: meta.startAtMs,
      endAtMs: meta.endAtMs,
      generator: "model",
      topics,
      claims
    };
  }

  private buildEpisodeGraphContextTx(source: GraphEpisodeSource): EpisodeGraphContext {
    // Authoritative structured mentions on window messages — derivable from
    // committed archive state, so rebuild sees exactly what commit saw.
    const windowMentions = this.db
      .prepare(
        `SELECT mm.mentioned_jid AS mentionedJid, m.sender_source_jid AS senderJid, m.source_message_key AS sourceMessageKey, m.timestamp_ms AS timestampMs
         FROM messages m
         JOIN chats ch ON ch.id = m.chat_id
         JOIN message_mentions mm ON mm.message_id = m.id
         WHERE ch.source_chat_id = ? AND m.timestamp_ms >= ? AND m.timestamp_ms <= ? AND (mm.source_mask & 2) != 0`
      )
      .all(source.chatSourceId, source.startAtMs, source.endAtMs) as EpisodeGraphContext["windowMentions"];
    const replyRows = this.db
      .prepare(
        `SELECT q.reply_message_key AS replyKey, m.sender_source_jid AS senderJid, m.timestamp_ms AS timestampMs,
                q.quoted_source_message_id AS quotedId, q.quoted_source_chat_id AS quotedChatId
         FROM message_quoted_snapshots q
         JOIN messages m ON m.source_message_key = q.reply_message_key
         JOIN chats ch ON ch.id = m.chat_id
         WHERE ch.source_chat_id = ? AND m.timestamp_ms >= ? AND m.timestamp_ms <= ? AND q.quoted_source_message_id IS NOT NULL`
      )
      .all(source.chatSourceId, source.startAtMs, source.endAtMs) as Array<{
      replyKey: string;
      senderJid: string | null;
      timestampMs: number | null;
      quotedId: string;
      quotedChatId: string | null;
    }>;
    const resolveQuotedKey = this.db.prepare(
      `SELECT m.source_message_key AS key FROM messages m JOIN chats ch ON ch.id = m.chat_id WHERE ch.source_chat_id = ? AND m.source_message_id = ? LIMIT 1`
    );
    const windowReplies: EpisodeGraphContext["windowReplies"] = [];
    for (const row of replyRows) {
      const targetChat = row.quotedChatId ? this.canonicalJid(row.quotedChatId) ?? row.quotedChatId : source.chatSourceId;
      const target = resolveQuotedKey.get(targetChat, row.quotedId) as { key: string } | undefined;
      if (target) {
        windowReplies.push({
          replySourceMessageKey: row.replyKey,
          replySenderJid: row.senderJid,
          quotedSourceMessageKey: target.key,
          timestampMs: row.timestampMs
        });
      }
    }
    const lifecycleTargets = this.db.prepare(
      `SELECT DISTINCT n.natural_key AS naturalKey
       FROM brain_citations c
       JOIN brain_node_claims nc ON nc.claim_id = c.claim_id
       JOIN brain_nodes n ON n.id = nc.node_id
       WHERE c.source_message_key = ? AND n.kind IN ('commitment','question') AND n.status != 'merged'`
    );
    // Chat-wide replies quoting THIS episode's lifecycle claims' citations —
    // makes replies_to independent of assimilation order.
    const inboundStmt = this.db.prepare(
      `SELECT q.reply_message_key AS replyKey, m.sender_source_jid AS senderJid, m.timestamp_ms AS timestampMs
       FROM messages t
       JOIN chats tc ON tc.id = t.chat_id
       JOIN message_quoted_snapshots q ON q.quoted_source_message_id = t.source_message_id
       JOIN messages m ON m.source_message_key = q.reply_message_key
       JOIN chats mc ON mc.id = m.chat_id
       WHERE t.source_message_key = ?
         AND (q.quoted_source_chat_id = tc.source_chat_id OR (q.quoted_source_chat_id IS NULL AND mc.source_chat_id = tc.source_chat_id))`
    );
    const inboundReplies: EpisodeGraphContext["inboundReplies"] = [];
    for (const claim of source.claims) {
      if (claim.kind !== "commitment" && claim.kind !== "question") {
        continue;
      }
      for (const citation of claim.citations) {
        const rows = inboundStmt.all(citation.sourceMessageKey) as Array<{
          replyKey: string;
          senderJid: string | null;
          timestampMs: number | null;
        }>;
        for (const row of rows) {
          inboundReplies.push({
            claimId: claim.id,
            replySourceMessageKey: row.replyKey,
            replySenderJid: row.senderJid,
            timestampMs: row.timestampMs
          });
        }
      }
    }
    return {
      canonicalJid: (jid) => this.canonicalJid(jid),
      windowMentions,
      windowReplies,
      lifecycleTargetsForMessage: (sourceMessageKey) =>
        (lifecycleTargets.all(sourceMessageKey) as Array<{ naturalKey: string }>).map((row) => row.naturalKey),
      inboundReplies
    };
  }

  private applyEpisodeGraphTx(meta: { episodeId: string; chatSourceId: string; startAtMs: number; endAtMs: number }): void {
    const source = this.buildEpisodeGraphSourceTx(meta);
    const context = this.buildEpisodeGraphContextTx(source);
    this.applyGraphMutationsTx(deriveEpisodeGraph(source, context));
  }

  // Remove everything a (superseded or reset) episode contributed: claim-keyed
  // evidence and junctions, the lifecycle/event nodes its claims minted, and
  // the message-keyed evidence derived from its window (participation,
  // mentions, window replies). A regeneration replacement re-derives the same
  // window immediately after, so the state converges either way — and a
  // replacement-less removal (scoped reset) leaves no orphaned provenance a
  // rebuild would not reproduce.
  private removeGraphContributionForEpisodeTx(episodeId: string): void {
    const claimIds = (this.db.prepare(`SELECT id FROM brain_claims WHERE episode_id = ?`).all(episodeId) as Array<{ id: string }>).map(
      (row) => row.id
    );
    if (claimIds.length === 0) {
      return;
    }
    const affectedEdges = new Set<number>();
    const episodeRow = this.db
      .prepare(`SELECT chat_source_id AS chatSourceId, start_at_ms AS startAtMs, end_at_ms AS endAtMs FROM brain_episodes WHERE id = ?`)
      .get(episodeId) as { chatSourceId: string; startAtMs: number; endAtMs: number } | undefined;
    if (episodeRow) {
      const windowEvidence = this.db
        .prepare(
          `SELECT ev.edge_id AS edgeId, ev.evidence_key AS evidenceKey
           FROM brain_edge_evidence ev
           JOIN messages m ON m.source_message_key = ev.source_message_key
           JOIN chats ch ON ch.id = m.chat_id
           WHERE ev.source_message_key IS NOT NULL AND ev.claim_id IS NULL AND ev.source_ref IS NULL
             AND ch.source_chat_id = ? AND m.timestamp_ms >= ? AND m.timestamp_ms <= ?`
        )
        .all(episodeRow.chatSourceId, episodeRow.startAtMs, episodeRow.endAtMs) as Array<{ edgeId: number; evidenceKey: string }>;
      const deleteEvidence = this.db.prepare(`DELETE FROM brain_edge_evidence WHERE edge_id = ? AND evidence_key = ?`);
      for (const row of windowEvidence) {
        deleteEvidence.run(row.edgeId, row.evidenceKey);
        affectedEdges.add(row.edgeId);
      }
    }
    for (let index = 0; index < claimIds.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = claimIds.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      for (const row of this.db
        .prepare(`SELECT DISTINCT edge_id AS edgeId FROM brain_edge_evidence WHERE claim_id IN (${placeholders})`)
        .all(...batch) as Array<{ edgeId: number }>) {
        affectedEdges.add(row.edgeId);
      }
      this.db.prepare(`DELETE FROM brain_edge_evidence WHERE claim_id IN (${placeholders})`).run(...batch);
      this.db.prepare(`DELETE FROM brain_node_claims WHERE claim_id IN (${placeholders})`).run(...batch);
      // Lifecycle/event nodes are claim-anchored; they leave with their claims.
      const nodeKeys = batch.flatMap((claimId) => [`commitment:${claimId}`, `question:${claimId}`, `event:${claimId}`]);
      for (let keyIndex = 0; keyIndex < nodeKeys.length; keyIndex += SQLITE_IN_QUERY_BATCH_SIZE) {
        const keyBatch = nodeKeys.slice(keyIndex, keyIndex + SQLITE_IN_QUERY_BATCH_SIZE);
        const keyPlaceholders = keyBatch.map(() => "?").join(",");
        const nodeIds = (
          this.db.prepare(`SELECT id FROM brain_nodes WHERE natural_key IN (${keyPlaceholders})`).all(...keyBatch) as Array<{ id: string }>
        ).map((row) => row.id);
        for (const nodeId of nodeIds) {
          for (const edgeRow of this.db
            .prepare(`SELECT id FROM brain_edges WHERE src_node_id = ? OR dst_node_id = ?`)
            .all(nodeId, nodeId) as Array<{ id: number }>) {
            this.db.prepare(`DELETE FROM brain_edge_evidence WHERE edge_id = ?`).run(edgeRow.id);
            this.db.prepare(`DELETE FROM brain_edges WHERE id = ?`).run(edgeRow.id);
            affectedEdges.delete(edgeRow.id);
          }
          this.db.prepare(`DELETE FROM brain_node_claims WHERE node_id = ?`).run(nodeId);
          this.db.prepare(`DELETE FROM brain_node_aliases WHERE node_id = ?`).run(nodeId);
          this.db.prepare(`DELETE FROM brain_nodes WHERE id = ?`).run(nodeId);
        }
      }
    }
    for (const edgeId of affectedEdges) {
      this.recountGraphEdgeTx(edgeId);
    }
    this.pruneOrphanGraphNodesTx();
  }

  private recountGraphEdgeTx(edgeId: number): void {
    const stats = this.db
      .prepare(
        `SELECT COUNT(*) AS count, MIN(observed_at_ms) AS first, MAX(observed_at_ms) AS last FROM brain_edge_evidence WHERE edge_id = ?`
      )
      .get(edgeId) as { count: number; first: number | null; last: number | null };
    if (Number(stats.count) === 0) {
      this.db.prepare(`DELETE FROM brain_edges WHERE id = ?`).run(edgeId);
      return;
    }
    this.db
      .prepare(
        `UPDATE brain_edges SET evidence_count = ?, weight = ?, first_seen_at_ms = ?, last_seen_at_ms = ?, updated_at = ? WHERE id = ?`
      )
      .run(Number(stats.count), Number(stats.count), stats.first, stats.last, currentIso(), edgeId);
  }

  // A node with no claims and no evidenced edges is a rumor — delete it.
  // Merged redirect stubs and merge targets are kept so held ids never dangle.
  private pruneOrphanGraphNodesTx(): void {
    const orphans = this.db
      .prepare(
        `SELECT id FROM brain_nodes n
         WHERE n.status != 'merged'
           AND NOT EXISTS (SELECT 1 FROM brain_node_claims nc WHERE nc.node_id = n.id)
           AND NOT EXISTS (SELECT 1 FROM brain_edges e WHERE e.src_node_id = n.id OR e.dst_node_id = n.id)
           AND NOT EXISTS (SELECT 1 FROM brain_nodes s WHERE s.merged_into = n.id)`
      )
      .all() as Array<{ id: string }>;
    for (const orphan of orphans) {
      this.db.prepare(`DELETE FROM brain_node_aliases WHERE node_id = ?`).run(orphan.id);
      this.db.prepare(`DELETE FROM brain_nodes WHERE id = ?`).run(orphan.id);
    }
  }

  // Identity merge rekey: person and chat nodes follow the canonical JID with
  // a 'merged' redirect stub left behind; chat-scoped natural keys rewrite.
  private rekeyGraphForIdentityMergeTx(lid: string, pn: string): void {
    this.rekeyGraphNaturalKeyTx(personJidNaturalKey(lid), personJidNaturalKey(pn), { jid: pn });
    this.rekeyGraphNaturalKeyTx(chatNaturalKey(lid), chatNaturalKey(pn), { chatScope: pn });
    const scoped = this.db
      .prepare(`SELECT id, natural_key AS naturalKey FROM brain_nodes WHERE chat_scope = ? AND status != 'merged'`)
      .all(lid) as Array<{ id: string; naturalKey: string }>;
    for (const node of scoped) {
      const marker = `:${lid}:`;
      if (node.naturalKey.includes(marker)) {
        this.rekeyGraphNaturalKeyTx(node.naturalKey, node.naturalKey.replace(marker, `:${pn}:`), { chatScope: pn });
      } else {
        this.db.prepare(`UPDATE brain_nodes SET chat_scope = ?, updated_at = ? WHERE id = ?`).run(pn, currentIso(), node.id);
      }
    }
  }

  private rekeyGraphNaturalKeyTx(oldKey: string, newKey: string, updates: { jid?: string; chatScope?: string }): void {
    const from = this.db.prepare(`SELECT id FROM brain_nodes WHERE natural_key = ?`).get(oldKey) as { id: string } | undefined;
    if (!from) {
      return;
    }
    const to = this.db.prepare(`SELECT id FROM brain_nodes WHERE natural_key = ?`).get(newKey) as { id: string } | undefined;
    if (!to) {
      // No canonical node yet: the LID node simply becomes it. The slug stays
      // immutable; only the anchor fields move to the canonical form.
      this.db
        .prepare(`UPDATE brain_nodes SET natural_key = ?, jid = COALESCE(?, jid), chat_scope = COALESCE(?, chat_scope), updated_at = ? WHERE id = ?`)
        .run(newKey, updates.jid ?? null, updates.chatScope ?? null, currentIso(), from.id);
      return;
    }
    this.mergeGraphNodesTx(from.id, to.id);
  }

  // Fold one node into another: junctions/aliases/edges re-point (duplicates
  // merge, evidence accumulates), and the source becomes a redirect stub.
  private mergeGraphNodesTx(fromId: string, toId: string): void {
    if (fromId === toId) {
      return;
    }
    this.db.prepare(`UPDATE OR IGNORE brain_node_claims SET node_id = ? WHERE node_id = ?`).run(toId, fromId);
    this.db.prepare(`DELETE FROM brain_node_claims WHERE node_id = ?`).run(fromId);
    this.db.prepare(`UPDATE OR IGNORE brain_node_aliases SET node_id = ? WHERE node_id = ?`).run(toId, fromId);
    this.db.prepare(`DELETE FROM brain_node_aliases WHERE node_id = ?`).run(fromId);
    const edges = this.db
      .prepare(`SELECT id, src_node_id AS src, dst_node_id AS dst, kind FROM brain_edges WHERE src_node_id = ? OR dst_node_id = ?`)
      .all(fromId, fromId) as Array<{ id: number; src: string; dst: string; kind: BrainGraphEdgeKind }>;
    for (const edge of edges) {
      const newSrc = edge.src === fromId ? toId : edge.src;
      const newDst = edge.dst === fromId ? toId : edge.dst;
      if (newSrc === newDst) {
        this.db.prepare(`DELETE FROM brain_edge_evidence WHERE edge_id = ?`).run(edge.id);
        this.db.prepare(`DELETE FROM brain_edges WHERE id = ?`).run(edge.id);
        continue;
      }
      const conflict = this.db
        .prepare(`SELECT id FROM brain_edges WHERE src_node_id = ? AND dst_node_id = ? AND kind = ?`)
        .get(newSrc, newDst, edge.kind) as { id: number } | undefined;
      if (conflict && conflict.id !== edge.id) {
        this.db.prepare(`UPDATE OR IGNORE brain_edge_evidence SET edge_id = ? WHERE edge_id = ?`).run(conflict.id, edge.id);
        this.db.prepare(`DELETE FROM brain_edge_evidence WHERE edge_id = ?`).run(edge.id);
        this.db.prepare(`DELETE FROM brain_edges WHERE id = ?`).run(edge.id);
        this.recountGraphEdgeTx(conflict.id);
      } else {
        this.db
          .prepare(`UPDATE brain_edges SET src_node_id = ?, dst_node_id = ?, updated_at = ? WHERE id = ?`)
          .run(newSrc, newDst, currentIso(), edge.id);
      }
    }
    const fromRow = this.db
      .prepare(`SELECT first_seen_at_ms AS first, last_seen_at_ms AS last, engagement_factor AS factor FROM brain_nodes WHERE id = ?`)
      .get(fromId) as { first: number | null; last: number | null; factor: number } | undefined;
    if (fromRow) {
      const toRow = this.db
        .prepare(`SELECT first_seen_at_ms AS first, last_seen_at_ms AS last, engagement_factor AS factor FROM brain_nodes WHERE id = ?`)
        .get(toId) as { first: number | null; last: number | null; factor: number };
      this.db
        .prepare(`UPDATE brain_nodes SET first_seen_at_ms = ?, last_seen_at_ms = ?, engagement_factor = ?, updated_at = ? WHERE id = ?`)
        .run(
          minNullableMs(toRow.first, fromRow.first),
          maxNullableMs(toRow.last, fromRow.last),
          Math.max(toRow.factor, fromRow.factor),
          currentIso(),
          toId
        );
    }
    this.db
      .prepare(`UPDATE brain_nodes SET status = 'merged', merged_into = ?, salience = 0, updated_at = ? WHERE id = ?`)
      .run(toId, currentIso(), fromId);
  }

  // Idempotent, chunked derivation from captured archive signals — the
  // non-message-scoped half of the graph (membership timeline, vCard subjects,
  // number-change succession, engagement factor). Zero model calls.
  async syncBrainGraphSignals(): Promise<BrainGraphSyncResult> {
    const result: BrainGraphSyncResult = { participationEdges: 0, vcardMentionEdges: 0, numberChangeAliases: 0, engagementFactors: 0 };
    const periods = this.db
      .prepare(
        `SELECT period_key AS periodKey, group_source_id AS groupSourceId, participant_jid AS participantJid,
                joined_at_ms AS joinedAtMs, left_at_ms AS leftAtMs, observed_at_ms AS observedAtMs
         FROM group_membership_periods`
      )
      .all() as Array<{
      periodKey: string;
      groupSourceId: string;
      participantJid: string;
      joinedAtMs: number | null;
      leftAtMs: number | null;
      observedAtMs: number | null;
    }>;
    for (let index = 0; index < periods.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = periods.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      this.db.transaction(() => {
        for (const period of batch) {
          const group = this.canonicalJid(period.groupSourceId) ?? period.groupSourceId;
          const participant = this.canonicalJid(period.participantJid) ?? period.participantJid;
          const chatId = this.ensureGraphNodeTx({
            naturalKey: chatNaturalKey(group),
            kind: "chat",
            title: null,
            jid: null,
            chatScope: group,
            payload: null,
            slugSeed: group.split("@")[0] ?? group,
            seenAtMs: period.joinedAtMs ?? period.observedAtMs
          });
          const personId = this.ensureGraphNodeTx({
            naturalKey: personJidNaturalKey(participant),
            kind: "person",
            title: null,
            jid: participant,
            chatScope: null,
            payload: null,
            slugSeed: participant.split("@")[0] ?? participant,
            seenAtMs: period.joinedAtMs ?? period.observedAtMs
          });
          const inserted = this.addGraphEdgeEvidenceTx(
            personId,
            chatId,
            "participates_in",
            {
              key: `period:${period.periodKey}`,
              sourceRef: period.periodKey,
              observedAtMs: period.joinedAtMs ?? period.observedAtMs ?? null
            },
            { firstMs: period.joinedAtMs, lastMs: period.leftAtMs ?? period.joinedAtMs ?? period.observedAtMs }
          );
          if (inserted) {
            result.participationEdges += 1;
          }
        }
      })();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const vcards = this.db
      .prepare(
        `SELECT v.source_message_key AS messageKey, v.card_index AS cardIndex, v.resolved_jid AS resolvedJid, v.display_name AS displayName,
                m.sender_source_jid AS senderJid, m.timestamp_ms AS timestampMs
         FROM message_vcards v
         JOIN messages m ON m.source_message_key = v.source_message_key
         WHERE v.resolved_jid IS NOT NULL`
      )
      .all() as Array<{
      messageKey: string;
      cardIndex: number;
      resolvedJid: string;
      displayName: string | null;
      senderJid: string | null;
      timestampMs: number | null;
    }>;
    for (let index = 0; index < vcards.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = vcards.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      this.db.transaction(() => {
        for (const vcard of batch) {
          const subject = this.canonicalJid(vcard.resolvedJid) ?? vcard.resolvedJid;
          const subjectId = this.ensureGraphNodeTx({
            naturalKey: personJidNaturalKey(subject),
            kind: "person",
            title: null,
            jid: subject,
            chatScope: null,
            payload: null,
            slugSeed: subject.split("@")[0] ?? subject,
            seenAtMs: vcard.timestampMs
          });
          if (vcard.displayName?.trim()) {
            this.db
              .prepare(`INSERT OR IGNORE INTO brain_node_aliases (node_id, alias, source, created_at) VALUES (?, ?, 'vcard', ?)`)
              .run(subjectId, vcard.displayName.trim(), currentIso());
          }
          if (!vcard.senderJid) {
            continue;
          }
          const sharer = this.canonicalJid(vcard.senderJid) ?? vcard.senderJid;
          if (sharer === subject) {
            continue;
          }
          const sharerId = this.ensureGraphNodeTx({
            naturalKey: personJidNaturalKey(sharer),
            kind: "person",
            title: null,
            jid: sharer,
            chatScope: null,
            payload: null,
            slugSeed: sharer.split("@")[0] ?? sharer,
            seenAtMs: vcard.timestampMs
          });
          const inserted = this.addGraphEdgeEvidenceTx(sharerId, subjectId, "mentions", {
            key: `vcard:${vcard.messageKey}:${vcard.cardIndex}`,
            sourceMessageKey: vcard.messageKey,
            sourceRef: `${vcard.messageKey}#${vcard.cardIndex}`,
            observedAtMs: vcard.timestampMs ?? null
          });
          if (inserted) {
            result.vcardMentionEdges += 1;
          }
        }
      })();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const numberChanges = this.db
      .prepare(`SELECT event_key AS eventKey, old_jid AS oldJid, new_jid AS newJid, observed_at_ms AS observedAtMs FROM identity_number_changes`)
      .all() as Array<{ eventKey: string; oldJid: string; newJid: string; observedAtMs: number | null }>;
    for (let index = 0; index < numberChanges.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = numberChanges.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      this.db.transaction(() => {
        for (const change of batch) {
          const oldJid = this.canonicalJid(change.oldJid) ?? change.oldJid;
          const newJid = this.canonicalJid(change.newJid) ?? change.newJid;
          if (oldJid === newJid) {
            continue;
          }
          const oldId = this.ensureGraphNodeTx({
            naturalKey: personJidNaturalKey(oldJid),
            kind: "person",
            title: null,
            jid: oldJid,
            chatScope: null,
            payload: null,
            slugSeed: oldJid.split("@")[0] ?? oldJid,
            seenAtMs: change.observedAtMs
          });
          const newId = this.ensureGraphNodeTx({
            naturalKey: personJidNaturalKey(newJid),
            kind: "person",
            title: null,
            jid: newJid,
            chatScope: null,
            payload: null,
            slugSeed: newJid.split("@")[0] ?? newJid,
            seenAtMs: change.observedAtMs
          });
          const oldNumber = displayPhoneFromJid(oldJid);
          if (oldNumber) {
            const changes = this.db
              .prepare(`INSERT OR IGNORE INTO brain_node_aliases (node_id, alias, source, created_at) VALUES (?, ?, 'number_change', ?)`)
              .run(newId, oldNumber, currentIso()).changes;
            result.numberChangeAliases += Number(changes);
          }
          this.addGraphEdgeEvidenceTx(oldId, newId, "alias_of", {
            key: `numchange:${change.eventKey}`,
            sourceRef: change.eventKey,
            observedAtMs: change.observedAtMs ?? null
          });
        }
      })();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const engagement = this.db
      .prepare(
        `SELECT counterparty_jid AS jid, SUM(eligible_outgoing_count) AS eligible, SUM(read_count) AS readCount
         FROM engagement_aggregates WHERE counterparty_jid IS NOT NULL GROUP BY counterparty_jid`
      )
      .all() as Array<{ jid: string; eligible: number; readCount: number }>;
    this.db.transaction(() => {
      for (const row of engagement) {
        const canonical = this.canonicalJid(row.jid) ?? row.jid;
        const factor = engagementFactorFromAggregates([
          { eligibleOutgoingCount: Number(row.eligible ?? 0), readCount: Number(row.readCount ?? 0) }
        ]);
        // Never mints a node: engagement is a salience input for people the
        // graph already knows, not a reason to exist in it.
        const changes = this.db
          .prepare(`UPDATE brain_nodes SET engagement_factor = ?, updated_at = ? WHERE natural_key = ? AND engagement_factor != ?`)
          .run(factor, currentIso(), personJidNaturalKey(canonical), factor).changes;
        result.engagementFactors += Number(changes);
      }
    })();
    return result;
  }

  // Wipe + replay every current model episode through the SAME derivation the
  // commit path uses, then sync signals and recompute salience. Deterministic
  // and model-free: this is also how pre-graph episodes gain coverage.
  async rebuildBrainGraph(): Promise<BrainGraphRebuildResult> {
    const startedAt = Date.now();
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM brain_edge_evidence`).run();
      this.db.prepare(`DELETE FROM brain_edges`).run();
      this.db.prepare(`DELETE FROM brain_node_claims`).run();
      this.db.prepare(`DELETE FROM brain_node_aliases`).run();
      this.db.prepare(`DELETE FROM brain_nodes`).run();
    })();
    const episodes = this.db
      .prepare(
        `SELECT id, chat_source_id AS chatSourceId, start_at_ms AS startAtMs, end_at_ms AS endAtMs
         FROM brain_episodes WHERE status = 'current' AND generator = 'model' ORDER BY created_at, id`
      )
      .all() as Array<{ id: string; chatSourceId: string; startAtMs: number; endAtMs: number }>;
    let replayed = 0;
    const CHUNK = 25;
    for (let index = 0; index < episodes.length; index += CHUNK) {
      const batch = episodes.slice(index, index + CHUNK);
      this.db.transaction(() => {
        for (const episode of batch) {
          this.applyEpisodeGraphTx({
            episodeId: episode.id,
            chatSourceId: episode.chatSourceId,
            startAtMs: episode.startAtMs,
            endAtMs: episode.endAtMs
          });
        }
      })();
      replayed += batch.length;
      if (replayed % 100 === 0 || replayed === episodes.length) {
        console.log(`[brain] graph rebuild: ${replayed}/${episodes.length} episode(s) replayed`);
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    await this.syncBrainGraphSignals();
    // Lifecycle projection: closures live OUTSIDE the wiped graph tables, so
    // a rebuild re-applies folded statuses and `resolves` edges from the
    // durable events — a closed commitment never silently reopens.
    const lifecycleProjected = this.db.transaction(() => this.projectLifecycleStateTx())();
    if (lifecycleProjected > 0) {
      console.log(`[brain] graph rebuild: lifecycle state re-projected for ${lifecycleProjected} claim(s)`);
    }
    await this.recomputeBrainGraphSalience();
    const nodes = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM brain_nodes`).get() as { count: number }).count);
    const edges = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM brain_edges`).get() as { count: number }).count);
    const evidence = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM brain_edge_evidence`).get() as { count: number }).count);
    return { episodesReplayed: replayed, nodes, edges, evidence, durationMs: Date.now() - startedAt };
  }

  // Evidence-derived salience (never incremented blindly) with kind-aware
  // dormancy: open commitments/questions are exempt and boost as their due
  // date approaches. Dormancy hides from ranked surfaces; nothing is deleted.
  async recomputeBrainGraphSalience(): Promise<BrainGraphRecomputeResult> {
    const startedAt = Date.now();
    const stats = new Map<string, { citations: number; days: number; lastTs: number | null }>();
    for (const row of this.db
      .prepare(
        `SELECT node_id AS nodeId, COUNT(*) AS citations,
                COUNT(DISTINCT CASE WHEN ts IS NOT NULL THEN date(ts / 1000, 'unixepoch') END) AS days,
                MAX(ts) AS lastTs
         FROM (
           SELECT nc.node_id AS node_id, c.timestamp_ms AS ts
           FROM brain_node_claims nc JOIN brain_citations c ON c.claim_id = nc.claim_id
           UNION ALL
           SELECT e.src_node_id, ev.observed_at_ms FROM brain_edge_evidence ev JOIN brain_edges e ON e.id = ev.edge_id
           UNION ALL
           SELECT e.dst_node_id, ev.observed_at_ms FROM brain_edge_evidence ev JOIN brain_edges e ON e.id = ev.edge_id
         )
         GROUP BY node_id`
      )
      .all() as Array<{ nodeId: string; citations: number; days: number; lastTs: number | null }>) {
      stats.set(row.nodeId, { citations: Number(row.citations), days: Number(row.days), lastTs: row.lastTs });
    }
    const nodes = this.db
      .prepare(
        `SELECT id, kind, status, payload_json AS payloadJson, engagement_factor AS engagementFactor, last_seen_at_ms AS lastSeen
         FROM brain_nodes WHERE status != 'merged'`
      )
      .all() as Array<{
      id: string;
      kind: BrainGraphNodeKind;
      status: BrainGraphNodeStatus;
      payloadJson: string | null;
      engagementFactor: number;
      lastSeen: number | null;
    }>;
    const threshold = graphDormancyThreshold();
    const nowMs = Date.now();
    const result: BrainGraphRecomputeResult = { nodes: nodes.length, dormant: 0, revived: 0, exemptOpenLifecycle: 0, durationMs: 0 };
    const update = this.db.prepare(
      `UPDATE brain_nodes SET salience = ?, status = ?, citation_count = ?, evidence_days = ?, last_seen_at_ms = ?, updated_at = ? WHERE id = ?`
    );
    for (let index = 0; index < nodes.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = nodes.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      this.db.transaction(() => {
        for (const node of batch) {
          const nodeStats = stats.get(node.id) ?? { citations: 0, days: 0, lastTs: null };
          const payload = parseGraphPayload(node.payloadJson);
          const computed = computeGraphSalience({
            kind: node.kind,
            payload,
            citations: nodeStats.citations,
            evidenceDays: nodeStats.days,
            lastEvidenceAtMs: nodeStats.lastTs,
            nowMs,
            engagementFactor: node.engagementFactor,
            dormancyThreshold: threshold
          });
          const lifecycleOpen = (node.kind === "commitment" || node.kind === "question") && (payload?.status ?? "open") === "open";
          if (lifecycleOpen && computed.salience < threshold) {
            result.exemptOpenLifecycle += 1;
          }
          const nextStatus: BrainGraphNodeStatus = computed.dormant ? "dormant" : "active";
          if (nextStatus === "dormant" && node.status === "active") {
            result.dormant += 1;
          } else if (nextStatus === "active" && node.status === "dormant") {
            result.revived += 1;
          }
          update.run(
            computed.salience,
            nextStatus,
            nodeStats.citations,
            nodeStats.days,
            maxNullableMs(node.lastSeen, nodeStats.lastTs),
            currentIso(),
            node.id
          );
        }
      })();
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.db
      .prepare(
        `INSERT INTO schema_meta (key, value, updated_at) VALUES ('brain_graph_last_recompute_at', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(currentIso(), currentIso());
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  async getBrainGraphStats(): Promise<BrainGraphStats> {
    const nodesByKind: Partial<Record<BrainGraphNodeKind, number>> = {};
    for (const row of this.db.prepare(`SELECT kind, COUNT(*) AS count FROM brain_nodes GROUP BY kind`).all() as Array<{
      kind: BrainGraphNodeKind;
      count: number;
    }>) {
      nodesByKind[row.kind] = Number(row.count);
    }
    const nodesByStatus: Partial<Record<BrainGraphNodeStatus, number>> = {};
    for (const row of this.db.prepare(`SELECT status, COUNT(*) AS count FROM brain_nodes GROUP BY status`).all() as Array<{
      status: BrainGraphNodeStatus;
      count: number;
    }>) {
      nodesByStatus[row.status] = Number(row.count);
    }
    const edgesByKind: Partial<Record<BrainGraphEdgeKind, number>> = {};
    for (const row of this.db.prepare(`SELECT kind, COUNT(*) AS count FROM brain_edges GROUP BY kind`).all() as Array<{
      kind: BrainGraphEdgeKind;
      count: number;
    }>) {
      edgesByKind[row.kind] = Number(row.count);
    }
    const meta = this.db.prepare(`SELECT value FROM schema_meta WHERE key = 'brain_graph_last_recompute_at'`).get() as
      | { value: string }
      | undefined;
    return {
      nodeCount: Number((this.db.prepare(`SELECT COUNT(*) AS count FROM brain_nodes`).get() as { count: number }).count),
      edgeCount: Number((this.db.prepare(`SELECT COUNT(*) AS count FROM brain_edges`).get() as { count: number }).count),
      evidenceCount: Number((this.db.prepare(`SELECT COUNT(*) AS count FROM brain_edge_evidence`).get() as { count: number }).count),
      nodesByKind,
      nodesByStatus,
      edgesByKind,
      unresolvedPersonNodes: Number(
        (
          this.db.prepare(`SELECT COUNT(*) AS count FROM brain_nodes WHERE kind = 'person' AND jid IS NULL AND status != 'merged'`).get() as {
            count: number;
          }
        ).count
      ),
      openLifecycleNodes: Number(
        (
          this.db
            .prepare(
              `SELECT COUNT(*) AS count FROM brain_nodes
               WHERE kind IN ('commitment','question') AND status != 'merged' AND json_extract(payload_json, '$.status') = 'open'`
            )
            .get() as { count: number }
        ).count
      ),
      lastRecomputeAt: meta?.value ?? null
    };
  }

  private graphNodeRowToRecord(row: GraphNodeRow): BrainGraphNodeRecord {
    return {
      id: row.id,
      kind: row.kind,
      naturalKey: row.natural_key,
      slug: row.slug,
      label: this.graphLabelForNodeRow(row),
      title: row.title,
      jid: row.jid,
      chatScope: row.chat_scope,
      payload: parseGraphPayload(row.payload_json),
      status: row.status,
      mergedInto: row.merged_into,
      salience: Number(row.salience ?? 0),
      citationCount: Number(row.citation_count ?? 0),
      evidenceDays: Number(row.evidence_days ?? 0),
      firstSeenAtMs: row.first_seen_at_ms,
      lastSeenAtMs: row.last_seen_at_ms
    };
  }

  // Read-time label resolution — store references, render names. Renames and
  // person edits re-label with zero graph writes.
  private graphLabelForNodeRow(row: GraphNodeRow): string {
    if (row.kind === "person" && row.jid) {
      return this.labelForJid(row.jid);
    }
    if (row.kind === "chat" && row.chat_scope) {
      const chat = this.db.prepare(`SELECT display_name AS displayName FROM chats WHERE source_chat_id = ?`).get(row.chat_scope) as
        | { displayName: string | null }
        | undefined;
      return chat?.displayName?.trim() || row.chat_scope;
    }
    return row.title?.trim() || row.slug;
  }

  async getBrainGraphEntity(query: { nodeId?: string; jid?: string; name?: string }): Promise<BrainGraphEntityView | null> {
    const selectById = this.db.prepare(`SELECT * FROM brain_nodes WHERE id = ?`);
    const selectByKey = this.db.prepare(`SELECT * FROM brain_nodes WHERE natural_key = ?`);
    let row: GraphNodeRow | undefined;
    let redirected = false;
    if (query.nodeId) {
      row = selectById.get(query.nodeId) as GraphNodeRow | undefined;
      // Held ids never dangle: follow merged redirect stubs (bounded).
      for (let hop = 0; row && row.status === "merged" && row.merged_into && hop < 5; hop += 1) {
        row = selectById.get(row.merged_into) as GraphNodeRow | undefined;
        redirected = true;
      }
    } else if (query.jid) {
      const canonical = this.canonicalJid(query.jid) ?? query.jid;
      row = selectByKey.get(personJidNaturalKey(canonical)) as GraphNodeRow | undefined;
    } else if (query.name?.trim()) {
      const norm = query.name.trim().toLowerCase();
      row = this.db
        .prepare(
          `SELECT * FROM brain_nodes WHERE status != 'merged' AND lower(COALESCE(title, '')) = ? ORDER BY salience DESC, citation_count DESC LIMIT 1`
        )
        .get(norm) as GraphNodeRow | undefined;
      if (!row) {
        row = this.db
          .prepare(
            `SELECT n.* FROM brain_nodes n JOIN brain_node_aliases a ON a.node_id = n.id
             WHERE n.status != 'merged' AND lower(a.alias) = ? ORDER BY n.salience DESC LIMIT 1`
          )
          .get(norm) as GraphNodeRow | undefined;
      }
    }
    if (!row) {
      return null;
    }
    // Person aggregation resolves membership at READ time: connect/disconnect
    // re-derive this view with zero graph writes.
    let personId: string | null = null;
    let memberJids: string[] = [];
    const memberRows: GraphNodeRow[] = [];
    if (row.kind === "person" && row.jid) {
      const person = await this.resolvePersonForJid(row.jid);
      personId = person?.id ?? null;
      memberJids = person ? person.members.map((member) => member.identityJid) : [row.jid];
      for (const jid of memberJids) {
        const canonical = this.canonicalJid(jid) ?? jid;
        const memberRow = selectByKey.get(personJidNaturalKey(canonical)) as GraphNodeRow | undefined;
        if (memberRow && memberRow.status !== "merged") {
          memberRows.push(memberRow);
        }
      }
      if (!memberRows.some((member) => member.id === row!.id)) {
        memberRows.push(row);
      }
    } else {
      memberJids = row.jid ? [row.jid] : [];
      memberRows.push(row);
    }
    const nodeIds = memberRows.map((member) => member.id);
    const jidByNodeId = new Map(memberRows.map((member) => [member.id, member.jid]));
    const placeholders = nodeIds.map(() => "?").join(",");
    const claimRows = this.db
      .prepare(
        `SELECT nc.node_id AS nodeId, c.id AS id, c.kind AS kind, c.text AS text, c.confidence AS confidence,
                c.event_at_ms AS eventAtMs, c.valid_until_ms AS validUntilMs,
                e.id AS episodeId, e.chat_source_id AS chatSourceId, ch.display_name AS chatDisplayName
         FROM brain_node_claims nc
         JOIN brain_claims c ON c.id = nc.claim_id
         JOIN brain_episodes e ON e.id = c.episode_id
         LEFT JOIN chats ch ON ch.source_chat_id = e.chat_source_id
         WHERE nc.node_id IN (${placeholders}) AND e.status = 'current'`
      )
      .all(...nodeIds) as Array<{
      nodeId: string;
      id: string;
      kind: BrainGraphEntityClaim["kind"];
      text: string;
      confidence: BrainGraphEntityClaim["confidence"];
      eventAtMs: number | null;
      validUntilMs: number | null;
      episodeId: string;
      chatSourceId: string;
      chatDisplayName: string | null;
    }>;
    const citationsStmt = this.db.prepare(
      `SELECT source_message_key, source_chat_id, message_id, sender_source_jid, timestamp_ms FROM brain_citations WHERE claim_id = ?`
    );
    const claims: BrainGraphEntityClaim[] = [];
    const seenClaims = new Set<string>();
    for (const claim of claimRows) {
      if (seenClaims.has(claim.id)) {
        continue;
      }
      seenClaims.add(claim.id);
      claims.push({
        id: claim.id,
        kind: claim.kind,
        text: claim.text,
        confidence: claim.confidence,
        eventAtMs: claim.eventAtMs,
        validUntilMs: claim.validUntilMs,
        episodeId: claim.episodeId,
        chatSourceId: claim.chatSourceId,
        chatDisplayName: claim.chatDisplayName,
        viaJid: jidByNodeId.get(claim.nodeId) ?? null,
        citations: (citationsStmt.all(claim.id) as Array<Record<string, unknown>>).map((citation) => ({
          sourceMessageKey: String(citation.source_message_key),
          sourceChatId: String(citation.source_chat_id),
          messageId: (citation.message_id as number | null) ?? null,
          senderSourceJid: (citation.sender_source_jid as string | null) ?? null,
          timestampMs: (citation.timestamp_ms as number | null) ?? null
        }))
      });
    }
    claims.sort((a, b) => {
      const aTs = Math.max(...a.citations.map((citation) => citation.timestampMs ?? 0), 0);
      const bTs = Math.max(...b.citations.map((citation) => citation.timestampMs ?? 0), 0);
      return bTs - aTs;
    });
    const edgeRows = this.db
      .prepare(
        `SELECT * FROM brain_edges WHERE src_node_id IN (${placeholders}) OR dst_node_id IN (${placeholders})
         ORDER BY evidence_count DESC, last_seen_at_ms DESC LIMIT 200`
      )
      .all(...nodeIds, ...nodeIds) as Array<{
      id: number;
      src_node_id: string;
      dst_node_id: string;
      kind: BrainGraphEdgeKind;
      weight: number;
      evidence_count: number;
      first_seen_at_ms: number | null;
      last_seen_at_ms: number | null;
    }>;
    const nodeIdSet = new Set(nodeIds);
    const edges: BrainGraphEdgeView[] = [];
    for (const edge of edgeRows) {
      const outbound = nodeIdSet.has(edge.src_node_id);
      const otherId = outbound ? edge.dst_node_id : edge.src_node_id;
      if (nodeIdSet.has(otherId)) {
        continue;
      }
      const otherRow = selectById.get(otherId) as GraphNodeRow | undefined;
      if (!otherRow) {
        continue;
      }
      edges.push({
        id: edge.id,
        kind: edge.kind,
        direction: outbound ? "out" : "in",
        otherNode: {
          id: otherRow.id,
          kind: otherRow.kind,
          label: this.graphLabelForNodeRow(otherRow),
          slug: otherRow.slug,
          status: otherRow.status,
          salience: Number(otherRow.salience ?? 0),
          jid: otherRow.jid
        },
        weight: Number(edge.weight ?? 0),
        evidenceCount: Number(edge.evidence_count ?? 0),
        firstSeenAtMs: edge.first_seen_at_ms,
        lastSeenAtMs: edge.last_seen_at_ms
      });
    }
    const aliasRows = this.db
      .prepare(`SELECT DISTINCT alias FROM brain_node_aliases WHERE node_id IN (${placeholders}) ORDER BY alias`)
      .all(...nodeIds) as Array<{ alias: string }>;
    return {
      node: this.graphNodeRowToRecord(row),
      personId,
      memberJids,
      memberNodes: memberRows.map((member) => this.graphNodeRowToRecord(member)),
      claims: claims.slice(0, 200),
      edges,
      aliases: aliasRows.map((alias) => alias.alias),
      redirected
    };
  }

  // Anchor resolution shared by the graph reads: node id (following merged
  // redirect stubs, bounded), canonical JID, or exact title/alias. Returns null
  // for an unresolved or still-merged anchor.
  private resolveGraphAnchor(query: { nodeId?: string; jid?: string; name?: string; chat?: string }): { row: GraphNodeRow; redirected: boolean } | null {
    const selectById = this.db.prepare(`SELECT * FROM brain_nodes WHERE id = ?`);
    let row: GraphNodeRow | undefined;
    let redirected = false;
    if (query.chat?.trim()) {
      row = this.db.prepare(`SELECT * FROM brain_nodes WHERE natural_key = ?`).get(chatNaturalKey(query.chat.trim())) as GraphNodeRow | undefined;
    } else if (query.nodeId) {
      row = selectById.get(query.nodeId) as GraphNodeRow | undefined;
      for (let hop = 0; row && row.status === "merged" && row.merged_into && hop < 5; hop += 1) {
        row = selectById.get(row.merged_into) as GraphNodeRow | undefined;
        redirected = true;
      }
    } else if (query.jid) {
      const canonical = this.canonicalJid(query.jid) ?? query.jid;
      row = this.db.prepare(`SELECT * FROM brain_nodes WHERE natural_key = ?`).get(personJidNaturalKey(canonical)) as GraphNodeRow | undefined;
    } else if (query.name?.trim()) {
      const norm = query.name.trim().toLowerCase();
      // Prefer a RESOLVED person whose read-time label matches the name: people
      // carry no stored title (their name resolves from contacts), so a title
      // match alone skips them and lands on an unresolved same-name mention.
      row = this.db
        .prepare(
          `SELECT n.* FROM brain_nodes n JOIN contacts c ON c.source_jid = n.jid
           WHERE n.kind = 'person' AND n.status != 'merged' AND lower(c.display_name) = ?
           ORDER BY n.salience DESC LIMIT 1`
        )
        .get(norm) as GraphNodeRow | undefined;
      if (!row) {
        row = this.db
          .prepare(`SELECT * FROM brain_nodes WHERE status != 'merged' AND lower(COALESCE(title, '')) = ? ORDER BY salience DESC, citation_count DESC LIMIT 1`)
          .get(norm) as GraphNodeRow | undefined;
      }
      if (!row) {
        row = this.db
          .prepare(
            `SELECT n.* FROM brain_nodes n JOIN brain_node_aliases a ON a.node_id = n.id
             WHERE n.status != 'merged' AND lower(a.alias) = ? ORDER BY n.salience DESC LIMIT 1`
          )
          .get(norm) as GraphNodeRow | undefined;
      }
    }
    if (!row || row.status === "merged") {
      return null;
    }
    return { row, redirected };
  }

  async searchBrainGraphNodes(query: string, limit = 10): Promise<BrainGraphNodeSuggestion[]> {
    const q = query.trim().toLowerCase();
    if (!q) {
      return [];
    }
    // Substring match on the read-time label sources — contact name for
    // persons, chat name for chats, title for everything else — so the dropdown
    // matches what the user sees. Leading-wildcard LIKE scans brain_nodes, which
    // is fine for a debounced, limit-capped typeahead. Escape LIKE wildcards so
    // a literal "%" in the query can't match everything.
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const cap = Math.max(1, Math.min(limit, 25));
    // Match each kind against ITS OWN label source only — persons on the contact
    // name (falling back to the title so unresolved name-nodes still surface),
    // chats on the chat name, everything else on the title. A blanket match
    // would leak nodes merely SCOPED to a matching chat (e.g. a topic in a chat
    // named "Swati" surfacing for the query "swati"). DM chats (chat_scope not a
    // group @g.us) are excluded: the neighborhood folds a 1:1 chat onto its
    // counterparty person, so offering both "Swati (person)" and "Swati (chat)"
    // would be a duplicate — only the person (reachable by the same name) stays.
    const rows = this.db
      .prepare(
        `SELECT n.* FROM brain_nodes n
         LEFT JOIN contacts c ON c.source_jid = n.jid
         LEFT JOIN chats ch ON ch.source_chat_id = n.chat_scope
         WHERE n.status != 'merged'
           AND n.kind NOT IN ('commitment', 'question', 'event', 'fact')
           AND (
             (n.kind = 'person'
               AND (lower(COALESCE(c.display_name, '')) LIKE ? ESCAPE '\\'
                    OR lower(COALESCE(n.title, '')) LIKE ? ESCAPE '\\'))
             OR (n.kind = 'chat' AND n.chat_scope LIKE '%@g.us'
                 AND lower(COALESCE(ch.display_name, '')) LIKE ? ESCAPE '\\')
             OR (n.kind NOT IN ('person', 'chat') AND lower(COALESCE(n.title, '')) LIKE ? ESCAPE '\\')
           )
         ORDER BY n.salience DESC, n.citation_count DESC
         LIMIT ?`
      )
      .all(like, like, like, like, cap) as GraphNodeRow[];
    return rows.map((row) => {
      const record = this.graphNodeRowToRecord(row);
      return { id: record.id, label: record.label, kind: record.kind, jid: record.jid };
    });
  }

  async getBrainGraphNeighborhood(params: BrainGraphNeighborhoodParams): Promise<BrainGraphNeighborhoodView | null> {
    const resolved = resolveNeighborhoodParams(params);
    const anchor = this.resolveGraphAnchor(params);
    if (!anchor) {
      return null;
    }
    const anchorId = anchor.row.id;
    const statusPlaceholders = resolved.statuses.map(() => "?").join(",");
    const kindClause = resolved.kinds ? ` AND e.kind IN (${resolved.kinds.map(() => "?").join(",")})` : "";
    const sinceClause = resolved.since != null ? " AND e.last_seen_at_ms >= ?" : "";
    const untilClause = resolved.until != null ? " AND e.last_seen_at_ms <= ?" : "";
    // Recursive discovery: expand BOTH directions (edges are stored directional
    // but most kinds are logically undirected; `related_to` is normalized
    // src<dst), push kind/time/salience/status filters into the walk (index-
    // served via idx_brain_edges_src/dst), and deterministically keep the
    // closest, most-salient rows under the discovery ceiling. The anchor
    // (hop 0) is exempt from the neighbor filters — it was explicitly asked for.
    const discoverySql = `
      WITH RECURSIVE reach(node_id, hop) AS (
        SELECT ?, 0
        UNION
        SELECT CASE WHEN e.src_node_id = r.node_id THEN e.dst_node_id ELSE e.src_node_id END, r.hop + 1
        FROM reach r
        JOIN brain_edges e ON (e.src_node_id = r.node_id OR e.dst_node_id = r.node_id)
        JOIN brain_nodes n ON n.id = (CASE WHEN e.src_node_id = r.node_id THEN e.dst_node_id ELSE e.src_node_id END)
        WHERE r.hop < ?
          AND n.status IN (${statusPlaceholders})
          AND n.salience >= ?${kindClause}${sinceClause}${untilClause}
      )
      SELECT n2.*, MIN(r.hop) AS __hop
      FROM reach r JOIN brain_nodes n2 ON n2.id = r.node_id
      GROUP BY r.node_id
      ORDER BY __hop ASC, n2.salience DESC, r.node_id ASC
      LIMIT ?`;
    const discoverArgs: unknown[] = [anchorId, resolved.depth, ...resolved.statuses, resolved.minSalience];
    if (resolved.kinds) discoverArgs.push(...resolved.kinds);
    if (resolved.since != null) discoverArgs.push(resolved.since);
    if (resolved.until != null) discoverArgs.push(resolved.until);
    discoverArgs.push(resolved.maxDiscover + 1);
    const discoveredRows = this.db.prepare(discoverySql).all(...discoverArgs) as Array<GraphNodeRow & { __hop: number }>;
    const discoveryTruncated = discoveredRows.length > resolved.maxDiscover;
    const nodeRows = discoveryTruncated ? discoveredRows.slice(0, resolved.maxDiscover) : discoveredRows;

    const ids = nodeRows.map((row) => row.id);
    const edges: BrainGraphNeighborhoodEdge[] = [];
    if (ids.length > 0) {
      const idPlaceholders = ids.map(() => "?").join(",");
      const edgeKindClause = resolved.kinds ? ` AND kind IN (${resolved.kinds.map(() => "?").join(",")})` : "";
      const edgeSinceClause = resolved.since != null ? " AND last_seen_at_ms >= ?" : "";
      const edgeUntilClause = resolved.until != null ? " AND last_seen_at_ms <= ?" : "";
      const edgeArgs: unknown[] = [...ids, ...ids];
      if (resolved.kinds) edgeArgs.push(...resolved.kinds);
      if (resolved.since != null) edgeArgs.push(resolved.since);
      if (resolved.until != null) edgeArgs.push(resolved.until);
      const edgeRows = this.db
        .prepare(
          `SELECT id, src_node_id, dst_node_id, kind, evidence_count, first_seen_at_ms, last_seen_at_ms
           FROM brain_edges
           WHERE src_node_id IN (${idPlaceholders}) AND dst_node_id IN (${idPlaceholders})${edgeKindClause}${edgeSinceClause}${edgeUntilClause}`
        )
        .all(...edgeArgs) as Array<{
        id: number;
        src_node_id: string;
        dst_node_id: string;
        kind: BrainGraphEdgeKind;
        evidence_count: number;
        first_seen_at_ms: number | null;
        last_seen_at_ms: number | null;
      }>;
      for (const edge of edgeRows) {
        edges.push({
          id: edge.id,
          srcId: edge.src_node_id,
          dstId: edge.dst_node_id,
          kind: edge.kind,
          evidenceCount: Number(edge.evidence_count ?? 0),
          firstSeenAtMs: edge.first_seen_at_ms,
          lastSeenAtMs: edge.last_seen_at_ms
        });
      }
    }
    const personJids = nodeRows.filter((row) => row.kind === "person" && row.jid).map((row) => row.jid as string);
    const personKeyByJid = this.personKeysSync(personJids);
    // Every display name of the person behind each JID (all linked identities,
    // even off-screen) — so an unresolved written name can fold onto a person
    // whose matching name is a linked alias.
    const personAliasesByJid = new Map<string, string[]>();
    const membersByPerson = new Map<string, string[]>();
    for (const personId of new Set([...personKeyByJid.values()].filter((key) => !key.includes("@")))) {
      membersByPerson.set(
        personId,
        (this.db.prepare(`SELECT identity_jid FROM person_members WHERE person_id = ?`).all(personId) as Array<{ identity_jid: string }>).map(
          (row) => row.identity_jid
        )
      );
    }
    for (const jid of personJids) {
      const key = personKeyByJid.get(jid) ?? jid;
      const memberJids = !key.includes("@") ? membersByPerson.get(key) ?? [jid] : [jid];
      personAliasesByJid.set(jid, [...new Set(memberJids.map((memberJid) => this.labelForJid(memberJid)))]);
    }
    const ownerName = this.readOwnerNameSync();
    const ownerSelfJids = this.readOwnerSelfJids();
    const ownerPersonKeys = ownerSelfJids.length > 0 ? [...new Set(this.personKeysSync(ownerSelfJids).values())] : [];
    const ownerAllJids = new Set(ownerSelfJids);
    for (const personKey of ownerPersonKeys) {
      if (!personKey.includes("@")) {
        for (const row of this.db.prepare(`SELECT identity_jid FROM person_members WHERE person_id = ?`).all(personKey) as Array<{ identity_jid: string }>) {
          ownerAllJids.add(row.identity_jid);
        }
      }
    }
    const ownerInfo =
      ownerName || ownerAllJids.size > 0 ? { name: ownerName ?? null, personKeys: ownerPersonKeys, selfJids: [...ownerAllJids] } : null;
    const walk: NeighborhoodWalk = {
      anchorId,
      redirected: anchor.redirected,
      discovered: nodeRows.map((row) => ({ record: this.graphNodeRowToRecord(row), hop: Number(row.__hop) })),
      edges,
      discoveryTruncated,
      personKeyByJid,
      personAliasesByJid,
      ownerInfo
    };
    return shapeNeighborhood(walk, resolved);
  }

  async getBrainGraphEdgeEvidence(edgeId: number): Promise<BrainGraphEdgeEvidenceView | null> {
    const edge = this.db.prepare(`SELECT * FROM brain_edges WHERE id = ?`).get(edgeId) as
      | { id: number; src_node_id: string; dst_node_id: string; kind: BrainGraphEdgeKind; evidence_count: number; first_seen_at_ms: number | null; last_seen_at_ms: number | null }
      | undefined;
    if (!edge) {
      return null;
    }
    const selectById = this.db.prepare(`SELECT * FROM brain_nodes WHERE id = ?`);
    const endpoint = (nodeId: string): BrainGraphEdgeEvidenceView["src"] => {
      const row = selectById.get(nodeId) as GraphNodeRow | undefined;
      return row
        ? { id: row.id, kind: row.kind, label: this.graphLabelForNodeRow(row), jid: row.jid }
        : { id: nodeId, kind: "other", label: nodeId, jid: null };
    };
    const evidenceRows = this.db
      .prepare(`SELECT claim_id, source_message_key, source_ref, observed_at_ms FROM brain_edge_evidence WHERE edge_id = ? ORDER BY observed_at_ms DESC, evidence_key ASC`)
      .all(edge.id) as Array<{ claim_id: string | null; source_message_key: string | null; source_ref: string | null; observed_at_ms: number | null }>;
    const claimStmt = this.db.prepare(`SELECT kind, text FROM brain_claims WHERE id = ?`);
    const claimCitesStmt = this.db.prepare(
      `SELECT bc.source_message_key, bc.source_chat_id, bc.message_id, bc.sender_source_jid, bc.timestamp_ms, ch.id AS chat_numeric_id
       FROM brain_citations bc LEFT JOIN chats ch ON ch.source_chat_id = bc.source_chat_id
       WHERE bc.claim_id = ? ORDER BY bc.timestamp_ms DESC, bc.id ASC`
    );
    const msgStmt = this.db.prepare(
      `SELECT m.id AS messageId, c.id AS chatNumericId, c.source_chat_id AS sourceChatId, m.sender_source_jid AS senderSourceJid, m.timestamp_ms AS timestampMs
       FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.source_message_key = ?`
    );
    const citations: BrainGraphEdgeCitation[] = [];
    const seen = new Set<string>();
    const LIMIT = 100;
    for (const ev of evidenceRows) {
      if (citations.length >= LIMIT) break;
      if (ev.claim_id) {
        const claim = claimStmt.get(ev.claim_id) as { kind: BrainGraphEntityClaim["kind"]; text: string } | undefined;
        const cites = claimCitesStmt.all(ev.claim_id) as Array<{ source_message_key: string; source_chat_id: string | null; message_id: number | null; sender_source_jid: string | null; timestamp_ms: number | null; chat_numeric_id: number | null }>;
        for (const cite of cites) {
          if (citations.length >= LIMIT) break;
          const key = `${ev.claim_id}:${cite.source_message_key}`;
          if (seen.has(key)) continue;
          seen.add(key);
          citations.push({
            sourceMessageKey: cite.source_message_key,
            sourceChatId: cite.source_chat_id ?? null,
            chatId: cite.chat_numeric_id ?? null,
            messageId: cite.message_id ?? null,
            senderSourceJid: cite.sender_source_jid ?? null,
            timestampMs: cite.timestamp_ms ?? null,
            claimId: ev.claim_id,
            claimKind: claim?.kind ?? null,
            claimText: claim?.text ?? null
          });
        }
      } else if (ev.source_message_key) {
        const key = `msg:${ev.source_message_key}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const message = msgStmt.get(ev.source_message_key) as
          | { messageId: number | null; chatNumericId: number | null; sourceChatId: string | null; senderSourceJid: string | null; timestampMs: number | null }
          | undefined;
        citations.push({
          sourceMessageKey: ev.source_message_key,
          sourceChatId: message?.sourceChatId ?? null,
          chatId: message?.chatNumericId ?? null,
          messageId: message?.messageId ?? null,
          senderSourceJid: message?.senderSourceJid ?? null,
          timestampMs: message?.timestampMs ?? ev.observed_at_ms ?? null,
          claimId: null,
          claimKind: null,
          claimText: null
        });
      }
      // Pure-signal evidence (source_ref only, e.g. a vCard sync) counts toward
      // evidenceCount but is not thread-linkable, so it is not listed here.
    }
    return {
      edgeId: edge.id,
      kind: edge.kind,
      src: endpoint(edge.src_node_id),
      dst: endpoint(edge.dst_node_id),
      evidenceCount: Number(edge.evidence_count ?? 0),
      firstSeenAtMs: edge.first_seen_at_ms,
      lastSeenAtMs: edge.last_seen_at_ms,
      citations
    };
  }

  async listUnresolvedBrainGraphEntities(options: { limit?: number } = {}): Promise<BrainGraphUnresolvedEntity[]> {
    const limit = Math.max(1, Math.min(200, options.limit ?? 50));
    const rows = this.db
      .prepare(
        `SELECT n.*, ch.display_name AS chatDisplayName,
                (SELECT COUNT(*) FROM brain_node_claims nc WHERE nc.node_id = n.id) AS claimCount
         FROM brain_nodes n
         LEFT JOIN chats ch ON ch.source_chat_id = n.chat_scope
         WHERE n.kind = 'person' AND n.jid IS NULL AND n.status != 'merged'
         ORDER BY n.salience DESC, claimCount DESC, n.last_seen_at_ms DESC
         LIMIT ?`
      )
      .all(limit) as Array<GraphNodeRow & { chatDisplayName: string | null; claimCount: number }>;
    return rows.map((row) => ({
      node: this.graphNodeRowToRecord(row),
      chatSourceId: row.chat_scope,
      chatDisplayName: row.chatDisplayName,
      claimCount: Number(row.claimCount ?? 0)
    }));
  }

  // === Commitment lifecycle ===============================================
  // Durable truth is brain_lifecycle_events (append-only, keyed by CLAIM id —
  // stable across graph wipes); node payload status and `resolves` edges are
  // projections re-derived by projectLifecycleClaimTx. One writer serves the
  // sweep, user controls, and future rollup calls. Zero model calls here.

  private lifecycleNodeRowForClaimTx(claimId: string): GraphNodeRow | undefined {
    return this.db
      .prepare(`SELECT * FROM brain_nodes WHERE natural_key IN (?, ?) AND status != 'merged'`)
      .get(`commitment:${claimId}`, `question:${claimId}`) as GraphNodeRow | undefined;
  }

  private loadLifecycleEventsTx(claimIds: string[]): Map<string, BrainLifecycleEventRecord[]> {
    const byClaim = new Map<string, BrainLifecycleEventRecord[]>();
    if (claimIds.length === 0) {
      return byClaim;
    }
    const citesStmt = this.db.prepare(
      `SELECT source_message_key AS sourceMessageKey, resolving_claim_id AS resolvingClaimId, actor_jid AS actorJid, timestamp_ms AS timestampMs
       FROM brain_lifecycle_event_cites WHERE event_id = ? ORDER BY timestamp_ms ASC, source_message_key ASC`
    );
    for (let index = 0; index < claimIds.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = claimIds.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT id, claim_id AS claimId, to_status AS toStatus, source, evidence_at_ms AS evidenceAtMs, note, run_id AS runId, model,
                  orphaned_at_ms AS orphanedAtMs, created_at_ms AS createdAtMs
           FROM brain_lifecycle_events WHERE claim_id IN (${placeholders}) ORDER BY claim_id, id`
        )
        .all(...batch) as Array<Omit<BrainLifecycleEventRecord, "cites">>;
      for (const row of rows) {
        const record: BrainLifecycleEventRecord = {
          ...row,
          cites: citesStmt.all(row.id) as BrainLifecycleEventRecord["cites"]
        };
        const list = byClaim.get(row.claimId) ?? [];
        list.push(record);
        byClaim.set(row.claimId, list);
      }
    }
    return byClaim;
  }

  // Bulk anchors for the list/sweep surfaces: one grouped query per id-chunk.
  private bulkLifecycleAnchorsTx(claimIds: string[]): Map<string, number> {
    const anchors = new Map<string, number>();
    for (let index = 0; index < claimIds.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = claimIds.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      for (const row of this.db
        .prepare(`SELECT claim_id AS claimId, MAX(timestamp_ms) AS anchorMs FROM brain_citations WHERE claim_id IN (${placeholders}) GROUP BY claim_id`)
        .all(...batch) as Array<{ claimId: string; anchorMs: number | null }>) {
        if (row.anchorMs != null) {
          anchors.set(row.claimId, row.anchorMs);
        }
      }
    }
    return anchors;
  }

  // The postdating anchor: the lifecycle claim's own last evidence. Cited
  // resolutions must be strictly later. Null when the claim's citations carry
  // no timestamps (postdating is then unverifiable and not enforced).
  private lifecycleAnchorTx(claimId: string): { anchorMs: number | null; anchorKeys: string[] } {
    const rows = this.db
      .prepare(`SELECT source_message_key AS key, timestamp_ms AS ts FROM brain_citations WHERE claim_id = ?`)
      .all(claimId) as Array<{ key: string; ts: number | null }>;
    let anchorMs: number | null = null;
    for (const row of rows) {
      if (row.ts != null) {
        anchorMs = anchorMs == null ? row.ts : Math.max(anchorMs, row.ts);
      }
    }
    return { anchorMs, anchorKeys: rows.map((row) => row.key) };
  }

  // The owner's evidence lines must never read "Me" (the importer sentinel):
  // resolve the configured owner name at read time, like episode packs do.
  private lifecycleOwnerLabelTx(): string {
    const row = this.db.prepare(`SELECT value FROM schema_meta WHERE key = 'owner_display_name'`).get() as { value: string } | undefined;
    return row?.value?.trim() || "the archive owner";
  }

  private lifecycleActorLabelTx(jid: string): string {
    return jid === "me" ? this.lifecycleOwnerLabelTx() : this.labelForJid(jid);
  }

  // Read-time labels for many actors at once: one contacts query per chunk
  // instead of a per-row lookup (the per-row path was a measured hot spot).
  private bulkLifecycleLabelsTx(jids: Iterable<string>): Map<string, string> {
    const labels = new Map<string, string>();
    const distinct = [...new Set(jids)].filter((jid) => jid && jid !== "me");
    for (let index = 0; index < distinct.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = distinct.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT source_jid AS jid, display_name AS displayName, push_name AS pushName, phone_number AS phoneNumber
           FROM contacts WHERE source_jid IN (${placeholders})`
        )
        .all(...batch) as Array<{ jid: string; displayName: string | null; pushName: string | null; phoneNumber: string | null }>;
      for (const row of rows) {
        labels.set(
          row.jid,
          resolveDisplayLabel({ displayName: row.displayName, pushName: row.pushName, phoneNumber: row.phoneNumber, jid: row.jid }) ?? row.jid
        );
      }
    }
    for (const jid of distinct) {
      if (!labels.has(jid)) {
        labels.set(jid, jid);
      }
    }
    labels.set("me", this.lifecycleOwnerLabelTx());
    return labels;
  }

  // Deterministic closure candidates for MANY open lifecycle nodes at once —
  // the three producers pinned by the spec (postdating reactions on cited
  // messages, replies quoting them incl. cross-chat snapshots, later
  // entity-overlapping model claims), each ONE indexed set query per id-chunk
  // rather than three queries per node. Measured on the real archive (2.2k
  // open nodes, 43k reactions, 326k messages): the per-node form took minutes
  // and blocked the event loop; this form answers in well under a second.
  private bulkLifecycleCandidatesTx(
    inputs: Array<{ claimId: string; chatSourceId: string; sinceMs: number }>
  ): Map<string, BrainLifecycleCandidate[]> {
    const result = new Map<string, BrainLifecycleCandidate[]>();
    if (inputs.length === 0) {
      return result;
    }
    const sinceByClaim = new Map(inputs.map((input) => [input.claimId, input.sinceMs]));
    type RawCandidate = Omit<BrainLifecycleCandidate, "senderLabel">;
    const rawByClaim = new Map<string, RawCandidate[]>();
    const seenByClaim = new Map<string, Set<string>>();
    const push = (claimId: string, candidate: RawCandidate) => {
      const since = sinceByClaim.get(claimId);
      if (since == null || candidate.timestampMs == null || candidate.timestampMs <= since) {
        return;
      }
      const dedupeKey = `${candidate.kind}:${candidate.claimId ?? candidate.sourceMessageKey}`;
      const seen = seenByClaim.get(claimId) ?? new Set<string>();
      if (seen.has(dedupeKey)) {
        return;
      }
      seen.add(dedupeKey);
      seenByClaim.set(claimId, seen);
      const list = rawByClaim.get(claimId) ?? [];
      list.push(candidate);
      rawByClaim.set(claimId, list);
    };
    const claimIds = inputs.map((input) => input.claimId);
    const messageText = (alias: string) =>
      `COALESCE(NULLIF(TRIM(COALESCE(${alias}.body, '')), ''), NULLIF(TRIM(COALESCE(${alias}.caption, '')), ''), '[' || ${alias}.message_type || ' message]')`;
    for (let index = 0; index < claimIds.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = claimIds.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      // (a) Reactions on the claims' cited messages — the WhatsApp-native ack.
      for (const row of this.db
        .prepare(
          `SELECT c.claim_id AS claimId, lmu.source_message_key AS key,
                  json_extract(lmu.metadata_json, '$.emoji') AS emoji,
                  json_extract(lmu.metadata_json, '$.reactorJid') AS reactorJid,
                  lmu.occurred_at_ms AS ts
           FROM brain_citations c
           JOIN live_message_updates lmu ON lmu.source_message_key = c.source_message_key AND lmu.update_type = 'reaction'
           WHERE c.claim_id IN (${placeholders})
             AND lmu.applied = 1 AND lmu.occurred_at_ms IS NOT NULL
             AND json_extract(lmu.metadata_json, '$.emoji') IS NOT NULL
             AND json_extract(lmu.metadata_json, '$.emoji') <> ''`
        )
        .all(...batch) as Array<{ claimId: string; key: string; emoji: string; reactorJid: string | null; ts: number }>) {
        const reactor = row.reactorJid ? this.canonicalJid(row.reactorJid) ?? row.reactorJid : null;
        push(row.claimId, { kind: "reaction", sourceMessageKey: row.key, timestampMs: row.ts, senderJid: reactor, text: row.emoji, claimId: null });
      }
      // (b) Replies quoting a cited message: snapshot-keyed (incl. cross-chat
      // Reply Privately) plus the legacy same-chat pointer.
      for (const row of this.db
        .prepare(
          `SELECT c.claim_id AS claimId, r.source_message_key AS key, r.sender_source_jid AS senderJid, r.timestamp_ms AS ts,
                  ${messageText("r")} AS text
           FROM brain_citations c
           JOIN messages t ON t.source_message_key = c.source_message_key
           JOIN chats tc ON tc.id = t.chat_id
           JOIN message_quoted_snapshots q ON q.quoted_source_message_id = t.source_message_id
           JOIN messages r ON r.source_message_key = q.reply_message_key
           JOIN chats rc ON rc.id = r.chat_id
           WHERE c.claim_id IN (${placeholders})
             AND (q.quoted_source_chat_id = tc.source_chat_id OR (q.quoted_source_chat_id IS NULL AND rc.source_chat_id = tc.source_chat_id))
             AND r.timestamp_ms IS NOT NULL`
        )
        .all(...batch) as Array<{ claimId: string; key: string; senderJid: string | null; ts: number; text: string }>) {
        const sender = row.senderJid ? this.canonicalJid(row.senderJid) ?? row.senderJid : null;
        push(row.claimId, { kind: "reply", sourceMessageKey: row.key, timestampMs: row.ts, senderJid: sender, text: row.text, claimId: null });
      }
      for (const row of this.db
        .prepare(
          `SELECT c.claim_id AS claimId, r.source_message_key AS key, r.sender_source_jid AS senderJid, r.timestamp_ms AS ts,
                  ${messageText("r")} AS text
           FROM brain_citations c
           JOIN messages t ON t.source_message_key = c.source_message_key
           JOIN messages r ON r.quoted_source_message_id = t.source_message_id AND r.chat_id = t.chat_id
           WHERE c.claim_id IN (${placeholders}) AND r.timestamp_ms IS NOT NULL`
        )
        .all(...batch) as Array<{ claimId: string; key: string; senderJid: string | null; ts: number; text: string }>) {
        const sender = row.senderJid ? this.canonicalJid(row.senderJid) ?? row.senderJid : null;
        push(row.claimId, { kind: "reply", sourceMessageKey: row.key, timestampMs: row.ts, senderJid: sender, text: row.text, claimId: null });
      }
    }
    // (c) Later model claims in the same chat sharing an entity (JID match;
    // normalized-name match when both sides lack a JID). NOT a SQL self-join:
    // popular JIDs (the owner) make entity×entity quadratic — measured 600k+
    // pairs / 50s on the real archive. Instead: per-chat recent postdating
    // claims + their entities in bulk, matched per node in JS with the same
    // recency-cap semantics.
    const ownEntitiesByClaim = new Map<string, { jids: Set<string>; names: Set<string> }>();
    for (let index = 0; index < claimIds.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = claimIds.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      for (const row of this.db
        .prepare(`SELECT claim_id AS claimId, jid, LOWER(TRIM(name)) AS name FROM brain_claim_entities WHERE claim_id IN (${placeholders})`)
        .all(...batch) as Array<{ claimId: string; jid: string | null; name: string }>) {
        const own = ownEntitiesByClaim.get(row.claimId) ?? { jids: new Set<string>(), names: new Set<string>() };
        if (row.jid) {
          own.jids.add(row.jid);
        } else if (row.name) {
          own.names.add(row.name);
        }
        ownEntitiesByClaim.set(row.claimId, own);
      }
    }
    const minSinceByChat = new Map<string, number>();
    const inputsByChat = new Map<string, Array<{ claimId: string; sinceMs: number }>>();
    for (const input of inputs) {
      if (!input.chatSourceId) {
        continue;
      }
      const own = ownEntitiesByClaim.get(input.claimId);
      if (!own || (own.jids.size === 0 && own.names.size === 0)) {
        continue;
      }
      minSinceByChat.set(input.chatSourceId, Math.min(minSinceByChat.get(input.chatSourceId) ?? Number.POSITIVE_INFINITY, input.sinceMs));
      const list = inputsByChat.get(input.chatSourceId) ?? [];
      list.push({ claimId: input.claimId, sinceMs: input.sinceMs });
      inputsByChat.set(input.chatSourceId, list);
    }
    const chats = [...inputsByChat.keys()];
    type RecentClaim = { claimId: string; text: string; ts: number; chat: string };
    const recentByChat = new Map<string, RecentClaim[]>();
    const RECENT_PER_CHAT = 300;
    for (let index = 0; index < chats.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = chats.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      for (const row of this.db
        .prepare(
          `SELECT c.id AS claimId, c.text AS text, MAX(ct.timestamp_ms) AS ts, e.chat_source_id AS chat
           FROM brain_claims c
           JOIN brain_episodes e ON e.id = c.episode_id
           JOIN brain_citations ct ON ct.claim_id = c.id
           WHERE e.status = 'current' AND e.generator = 'model' AND e.chat_source_id IN (${placeholders})
           GROUP BY c.id
           HAVING MAX(ct.timestamp_ms) IS NOT NULL`
        )
        .all(...batch) as RecentClaim[]) {
        if (row.ts <= (minSinceByChat.get(row.chat) ?? 0)) {
          continue;
        }
        const list = recentByChat.get(row.chat) ?? [];
        list.push(row);
        recentByChat.set(row.chat, list);
      }
    }
    // Entities of the recent claims (bulk), then match per lifecycle node.
    const recentClaimIds: string[] = [];
    for (const [chat, list] of recentByChat) {
      list.sort((a, b) => b.ts - a.ts);
      recentByChat.set(chat, list.slice(0, RECENT_PER_CHAT));
      for (const row of recentByChat.get(chat)!) {
        recentClaimIds.push(row.claimId);
      }
    }
    const recentEntities = new Map<string, { jids: Set<string>; names: Set<string> }>();
    for (let index = 0; index < recentClaimIds.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = recentClaimIds.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      for (const row of this.db
        .prepare(`SELECT claim_id AS claimId, jid, LOWER(TRIM(name)) AS name FROM brain_claim_entities WHERE claim_id IN (${placeholders})`)
        .all(...batch) as Array<{ claimId: string; jid: string | null; name: string }>) {
        const entry = recentEntities.get(row.claimId) ?? { jids: new Set<string>(), names: new Set<string>() };
        if (row.jid) {
          entry.jids.add(row.jid);
        } else if (row.name) {
          entry.names.add(row.name);
        }
        recentEntities.set(row.claimId, entry);
      }
    }
    const matched: Array<{ lifecycleClaimId: string; other: RecentClaim }> = [];
    const matchedOtherIds = new Set<string>();
    for (const [chat, group] of inputsByChat) {
      const recent = recentByChat.get(chat) ?? [];
      for (const lifecycle of group) {
        const own = ownEntitiesByClaim.get(lifecycle.claimId)!;
        let taken = 0;
        for (const other of recent) {
          if (other.claimId === lifecycle.claimId || other.ts <= lifecycle.sinceMs) {
            continue;
          }
          const theirs = recentEntities.get(other.claimId);
          if (!theirs) {
            continue;
          }
          let overlap = false;
          for (const jid of own.jids) {
            if (theirs.jids.has(jid)) {
              overlap = true;
              break;
            }
          }
          if (!overlap) {
            for (const name of own.names) {
              if (theirs.names.has(name)) {
                overlap = true;
                break;
              }
            }
          }
          if (!overlap) {
            continue;
          }
          matched.push({ lifecycleClaimId: lifecycle.claimId, other });
          matchedOtherIds.add(other.claimId);
          taken += 1;
          if (taken >= 6) {
            break;
          }
        }
      }
    }
    // Latest citation (key + sender) for exactly the matched claims.
    const latestCite = new Map<string, { key: string; senderJid: string | null; ts: number }>();
    const matchedIds = [...matchedOtherIds];
    for (let index = 0; index < matchedIds.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = matchedIds.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      for (const row of this.db
        .prepare(
          `SELECT claim_id AS claimId, source_message_key AS key, sender_source_jid AS senderJid, timestamp_ms AS ts
           FROM brain_citations WHERE claim_id IN (${placeholders}) AND timestamp_ms IS NOT NULL`
        )
        .all(...batch) as Array<{ claimId: string; key: string; senderJid: string | null; ts: number }>) {
        const existing = latestCite.get(row.claimId);
        if (!existing || row.ts > existing.ts) {
          latestCite.set(row.claimId, { key: row.key, senderJid: row.senderJid, ts: row.ts });
        }
      }
    }
    for (const entry of matched) {
      const cite = latestCite.get(entry.other.claimId);
      if (!cite) {
        continue;
      }
      const sender = cite.senderJid ? this.canonicalJid(cite.senderJid) ?? cite.senderJid : null;
      push(entry.lifecycleClaimId, {
        kind: "claim",
        sourceMessageKey: cite.key,
        timestampMs: entry.other.ts,
        senderJid: sender,
        text: entry.other.text,
        claimId: entry.other.claimId
      });
    }
    // Rank, cap, then resolve labels for exactly the kept candidates.
    const priority: Record<BrainLifecycleCandidate["kind"], number> = { reaction: 0, reply: 1, claim: 2 };
    const keptByClaim = new Map<string, RawCandidate[]>();
    const actorJids = new Set<string>();
    for (const [claimId, list] of rawByClaim) {
      list.sort((a, b) => priority[a.kind] - priority[b.kind] || (b.timestampMs ?? 0) - (a.timestampMs ?? 0));
      const kept = list.slice(0, LIFECYCLE_MAX_CANDIDATES_PER_NODE);
      keptByClaim.set(claimId, kept);
      for (const candidate of kept) {
        if (candidate.senderJid) {
          actorJids.add(candidate.senderJid);
        }
      }
    }
    const labels = this.bulkLifecycleLabelsTx(actorJids);
    for (const [claimId, kept] of keptByClaim) {
      result.set(
        claimId,
        kept.map((candidate) => ({ ...candidate, senderLabel: candidate.senderJid ? labels.get(candidate.senderJid) ?? candidate.senderJid : null }))
      );
    }
    return result;
  }

  // Re-project one claim's lifecycle state onto its graph node: payload status
  // from the fold, `resolves` edges re-derived from the current resolving
  // event's cites (actor person → lifecycle node), scoped salience refresh.
  private projectLifecycleClaimTx(claimId: string, fold?: LifecycleFold): void {
    const node = this.lifecycleNodeRowForClaimTx(claimId);
    if (!node) {
      return;
    }
    const resolved = fold ?? foldLifecycleEvents(this.loadLifecycleEventsTx([claimId]).get(claimId) ?? []);
    const payload = projectLifecyclePayload(parseGraphPayload(node.payload_json), resolved);
    this.db.prepare(`UPDATE brain_nodes SET payload_json = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(payload), currentIso(), node.id);
    // resolves edges are a projection of the CURRENT fold: a reopen removes
    // them (the judgment was disputed), a re-close re-derives them.
    for (const edge of this.db
      .prepare(`SELECT id FROM brain_edges WHERE dst_node_id = ? AND kind = 'resolves'`)
      .all(node.id) as Array<{ id: number }>) {
      this.db.prepare(`DELETE FROM brain_edge_evidence WHERE edge_id = ?`).run(edge.id);
      this.db.prepare(`DELETE FROM brain_edges WHERE id = ?`).run(edge.id);
    }
    const resolvingEvent = resolved.resolvingEvent;
    if (resolvingEvent && resolvingEvent.source === "model") {
      for (const cite of resolvingEvent.cites) {
        if (!cite.actorJid) {
          continue;
        }
        const canonical = this.canonicalJid(cite.actorJid) ?? cite.actorJid;
        const actorNodeId = this.ensureGraphNodeTx({
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
          this.addGraphEdgeEvidenceTx(actorNodeId, node.id, "resolves", {
            key: `msg:${cite.sourceMessageKey}`,
            sourceMessageKey: cite.sourceMessageKey,
            observedAtMs: cite.timestampMs
          });
        }
      }
    }
    this.recomputeSalienceForNodeTx(node.id);
  }

  // Scoped single-node salience refresh (same math as the global recompute) so
  // a transition's dormancy/boost effect lands in the same transaction.
  private recomputeSalienceForNodeTx(nodeId: string): void {
    const node = this.db
      .prepare(
        `SELECT id, kind, status, payload_json AS payloadJson, engagement_factor AS engagementFactor, last_seen_at_ms AS lastSeen
         FROM brain_nodes WHERE id = ? AND status != 'merged'`
      )
      .get(nodeId) as
      | { id: string; kind: BrainGraphNodeKind; status: BrainGraphNodeStatus; payloadJson: string | null; engagementFactor: number; lastSeen: number | null }
      | undefined;
    if (!node) {
      return;
    }
    const stats = this.db
      .prepare(
        `SELECT COUNT(*) AS citations,
                COUNT(DISTINCT CASE WHEN ts IS NOT NULL THEN date(ts / 1000, 'unixepoch') END) AS days,
                MAX(ts) AS lastTs
         FROM (
           SELECT c.timestamp_ms AS ts FROM brain_node_claims nc JOIN brain_citations c ON c.claim_id = nc.claim_id WHERE nc.node_id = ?
           UNION ALL
           SELECT ev.observed_at_ms FROM brain_edge_evidence ev JOIN brain_edges e ON e.id = ev.edge_id WHERE e.src_node_id = ? OR e.dst_node_id = ?
         )`
      )
      .get(nodeId, nodeId, nodeId) as { citations: number; days: number; lastTs: number | null };
    const computed = computeGraphSalience({
      kind: node.kind,
      payload: parseGraphPayload(node.payloadJson),
      citations: Number(stats.citations ?? 0),
      evidenceDays: Number(stats.days ?? 0),
      lastEvidenceAtMs: stats.lastTs,
      nowMs: Date.now(),
      engagementFactor: node.engagementFactor,
      dormancyThreshold: graphDormancyThreshold()
    });
    this.db
      .prepare(`UPDATE brain_nodes SET salience = ?, status = ?, citation_count = ?, evidence_days = ?, last_seen_at_ms = ?, updated_at = ? WHERE id = ?`)
      .run(
        computed.salience,
        computed.dormant ? "dormant" : "active",
        Number(stats.citations ?? 0),
        Number(stats.days ?? 0),
        maxNullableMs(node.lastSeen, stats.lastTs),
        currentIso(),
        nodeId
      );
  }

  // Rebuild step: re-apply every recorded (non-orphaned) claim's lifecycle
  // state onto the freshly replayed graph. Pure SQL — closures survive wipes.
  private projectLifecycleStateTx(): number {
    const claimIds = (
      this.db.prepare(`SELECT DISTINCT claim_id AS claimId FROM brain_lifecycle_events WHERE orphaned_at_ms IS NULL`).all() as Array<{
        claimId: string;
      }>
    ).map((row) => row.claimId);
    for (const claimId of claimIds) {
      this.projectLifecycleClaimTx(claimId);
    }
    return claimIds.length;
  }

  // Supersede re-key: transitions follow the commitment across regeneration.
  // The replacement is any CURRENT same-kind lifecycle claim citing one of the
  // old claim's messages (replacement packs may commit before the supersede,
  // so the search spans current claims, not just the superseding episode);
  // exactly one match re-keys, anything else orphans honestly.
  private rekeyLifecycleEventsForSupersededEpisodeTx(oldEpisodeId: string): string[] {
    const rekeyedClaims: string[] = [];
    const oldClaims = this.db
      .prepare(`SELECT id, kind FROM brain_claims WHERE episode_id = ? AND kind IN ('commitment','question')`)
      .all(oldEpisodeId) as Array<{ id: string; kind: string }>;
    for (const oldClaim of oldClaims) {
      const hasEvents = this.db.prepare(`SELECT 1 FROM brain_lifecycle_events WHERE claim_id = ? LIMIT 1`).get(oldClaim.id);
      if (!hasEvents) {
        continue;
      }
      const keys = (
        this.db.prepare(`SELECT source_message_key AS key FROM brain_citations WHERE claim_id = ?`).all(oldClaim.id) as Array<{ key: string }>
      ).map((row) => row.key);
      let replacementId: string | null = null;
      if (keys.length > 0) {
        const placeholders = keys.map(() => "?").join(",");
        const matches = this.db
          .prepare(
            `SELECT DISTINCT c.id AS id
             FROM brain_claims c
             JOIN brain_episodes e ON e.id = c.episode_id
             JOIN brain_citations ct ON ct.claim_id = c.id
             WHERE e.status = 'current' AND e.generator = 'model'
               AND c.kind = ? AND c.id != ?
               AND ct.source_message_key IN (${placeholders})
             LIMIT 2`
          )
          .all(oldClaim.kind, oldClaim.id, ...keys) as Array<{ id: string }>;
        replacementId = matches.length === 1 ? matches[0]!.id : null;
      }
      if (replacementId) {
        this.db.prepare(`UPDATE brain_lifecycle_events SET claim_id = ? WHERE claim_id = ?`).run(replacementId, oldClaim.id);
        rekeyedClaims.push(replacementId);
      } else {
        this.db
          .prepare(`UPDATE brain_lifecycle_events SET orphaned_at_ms = ? WHERE claim_id = ? AND orphaned_at_ms IS NULL`)
          .run(Date.now(), oldClaim.id);
      }
    }
    return rekeyedClaims;
  }

  // The sync transaction core of the ONE lifecycle writer. Extracted so
  // semantic-rollups' revision commit can apply resolutions INSIDE its own
  // transaction (better-sqlite3 transaction callbacks are sync); the public
  // method below wraps it for standalone callers. One validation path, one
  // write path — no second writer exists (design §L8).
  private applyBrainLifecycleTransitionsCoreTx(
    transitions: BrainLifecycleTransitionInput[],
    context: {
      source: BrainLifecycleSource;
      runId?: string | null;
      model?: string | null;
      allowedCitesByClaim?: Map<string, BrainLifecycleCandidate[]>;
    }
  ): number[] {
    const eventIds: number[] = [];
    // Validate EVERYTHING first (collect-all), apply nothing on any error.
    const errors: string[] = [];
    const prepared: Array<{
      input: BrainLifecycleTransitionInput;
      cites: Array<{ sourceMessageKey: string; timestampMs: number | null; resolvingClaimId: string | null; actorJid: string | null }>;
    }> = [];
    for (const input of transitions) {
      const node = this.lifecycleNodeRowForClaimTx(input.claimId);
      if (!node) {
        errors.push(`claim ${input.claimId} has no open commitment/question node`);
        continue;
      }
      const fold = foldLifecycleEvents(this.loadLifecycleEventsTx([input.claimId]).get(input.claimId) ?? []);
      const { anchorMs } = this.lifecycleAnchorTx(input.claimId);
      const allowed = context.allowedCitesByClaim?.get(input.claimId) ?? null;
      const allowedByKey = allowed ? new Map(allowed.map((candidate) => [candidate.sourceMessageKey, candidate])) : null;
      const cites: Array<{ sourceMessageKey: string; timestampMs: number | null; resolvingClaimId: string | null; actorJid: string | null }> = [];
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
          // No offered-candidate metadata (user cites): resolve what the
          // archive knows; closed-world validation below rejects model cites.
          const message = this.db
            .prepare(`SELECT timestamp_ms AS ts, sender_source_jid AS senderJid FROM messages WHERE source_message_key = ?`)
            .get(key) as { ts: number | null; senderJid: string | null } | undefined;
          cites.push({ sourceMessageKey: key, timestampMs: message?.ts ?? null, resolvingClaimId: null, actorJid: message?.senderJid ?? null });
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
    const insertEvent = this.db.prepare(
      `INSERT INTO brain_lifecycle_events (claim_id, to_status, source, evidence_at_ms, note, run_id, model, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertCite = this.db.prepare(
      `INSERT OR IGNORE INTO brain_lifecycle_event_cites (event_id, source_message_key, resolving_claim_id, actor_jid, timestamp_ms)
       VALUES (?, ?, ?, ?, ?)`
    );
    const now = Date.now();
    for (const entry of prepared) {
      const citeTimestamps = entry.cites.map((cite) => cite.timestampMs).filter((ts): ts is number => ts != null);
      const evidenceAtMs = citeTimestamps.length > 0 ? Math.max(...citeTimestamps) : null;
      const eventId = Number(
        insertEvent.run(
          entry.input.claimId,
          entry.input.toStatus,
          context.source,
          evidenceAtMs,
          entry.input.note?.trim() || null,
          context.runId ?? null,
          context.model ?? null,
          now
        ).lastInsertRowid
      );
      eventIds.push(eventId);
      for (const cite of entry.cites) {
        insertCite.run(eventId, cite.sourceMessageKey, cite.resolvingClaimId, cite.actorJid, cite.timestampMs);
      }
    }
    for (const entry of prepared) {
      this.projectLifecycleClaimTx(entry.input.claimId);
    }
    return eventIds;
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
    let eventIds: number[] = [];
    const transaction = this.db.transaction(() => {
      eventIds = this.applyBrainLifecycleTransitionsCoreTx(transitions, context);
    });
    transaction();
    this.invalidateBrainStatusCache();
    const events: BrainLifecycleEventRecord[] = [];
    const byClaim = this.loadLifecycleEventsTx([...new Set(transitions.map((transition) => transition.claimId))]);
    for (const list of byClaim.values()) {
      for (const event of list) {
        if (eventIds.includes(event.id)) {
          events.push(event);
        }
      }
    }
    return { applied: events.length, events };
  }

  private lifecycleCiteViewsTx(event: BrainLifecycleEventRecord): BrainLifecycleCiteView[] {
    const messageStmt = this.db.prepare(
      `SELECT m.id AS messageId, ch.id AS chatId, m.timestamp_ms AS ts,
              COALESCE(NULLIF(TRIM(COALESCE(m.body, '')), ''), NULLIF(TRIM(COALESCE(m.caption, '')), '')) AS text
       FROM messages m JOIN chats ch ON ch.id = m.chat_id WHERE m.source_message_key = ?`
    );
    return event.cites.map((cite) => {
      const message = messageStmt.get(cite.sourceMessageKey) as
        | { messageId: number; chatId: number; ts: number | null; text: string | null }
        | undefined;
      const snippet = message?.text ? (message.text.length > 160 ? `${message.text.slice(0, 159)}…` : message.text) : null;
      return {
        sourceMessageKey: cite.sourceMessageKey,
        chatId: message?.chatId ?? null,
        messageId: message?.messageId ?? null,
        timestampMs: cite.timestampMs ?? message?.ts ?? null,
        senderLabel: cite.actorJid
          ? this.lifecycleActorLabelTx(cite.actorJid === "me" ? "me" : this.canonicalJid(cite.actorJid) ?? cite.actorJid)
          : null,
        snippet
      };
    });
  }

  async listBrainLifecycleItems(
    options: {
      status?: BrainLifecycleStatus | "all" | "closed";
      // Narrows OPEN items to those carrying the flag (overdue/stale/sweep_due).
      flag?: "overdue" | "stale" | "sweep_due";
      // Exclusions layered on the current view (e.g. future-due only = hide
      // overdue). Counts stay the full totals; only the shown list narrows.
      hideOverdue?: boolean;
      hideStale?: boolean;
      hideFulfilled?: boolean;
      hideDismissed?: boolean;
      // The "upcoming deadlines" filter: keep only open items with a due date
      // still in the future (excludes overdue AND undated). Counts stay full.
      dueUpcoming?: boolean;
      kind?: "commitment" | "question";
      chatSourceId?: string | null;
      // Group filter: show only these source chats, or hide these. Empty/absent
      // means no restriction. Canonicalized against identity merges.
      includeChats?: string[];
      excludeChats?: string[];
      sort?: BrainLifecycleSort;
      limit?: number;
    } = {}
  ): Promise<BrainLifecycleListResponse> {
    const asOfMs = Date.now();
    const staleDays = lifecycleStaleDays();
    // A flag filter is inherently an open-set view, whatever status was passed.
    const statusFilter = options.flag ? "open" : options.status ?? "open";
    const limit = Math.max(1, Math.min(500, options.limit ?? 200));
    const includeChats =
      options.includeChats && options.includeChats.length > 0
        ? new Set(options.includeChats.map((chat) => this.canonicalJid(chat) ?? chat))
        : null;
    const excludeChats =
      options.excludeChats && options.excludeChats.length > 0
        ? new Set(options.excludeChats.map((chat) => this.canonicalJid(chat) ?? chat))
        : null;
    const clauses = [`n.kind IN ('commitment','question')`, `n.status != 'merged'`];
    const params: unknown[] = [];
    if (options.kind) {
      clauses.push(`n.kind = ?`);
      params.push(options.kind);
    }
    if (options.chatSourceId) {
      clauses.push(`n.chat_scope = ?`);
      params.push(this.canonicalJid(options.chatSourceId) ?? options.chatSourceId);
    }
    const rows = this.db
      .prepare(
        `SELECT n.*, ch.display_name AS chatDisplayName FROM brain_nodes n
         LEFT JOIN chats ch ON ch.source_chat_id = n.chat_scope
         WHERE ${clauses.join(" AND ")}`
      )
      .all(...params) as Array<GraphNodeRow & { chatDisplayName: string | null }>;
    const claimIds = rows.map((row) => row.natural_key.slice(row.natural_key.indexOf(":") + 1));
    const eventsByClaim = this.loadLifecycleEventsTx(claimIds);
    const anchorByClaim = this.bulkLifecycleAnchorsTx(claimIds);
    // One bulk candidate pass for every OPEN node (set queries, not per-node).
    const candidateInputs: Array<{ claimId: string; chatSourceId: string; sinceMs: number }> = [];
    const foldByClaim = new Map<string, LifecycleFold>();
    for (let index = 0; index < claimIds.length; index += 1) {
      const claimId = claimIds[index]!;
      const fold = foldLifecycleEvents(eventsByClaim.get(claimId) ?? []);
      foldByClaim.set(claimId, fold);
      if (fold.status === "open") {
        candidateInputs.push({
          claimId,
          chatSourceId: rows[index]!.chat_scope ?? "",
          sinceMs: Math.max(anchorByClaim.get(claimId) ?? 0, fold.lastReviewedAtMs ?? 0)
        });
      }
    }
    const candidatesByClaim = this.bulkLifecycleCandidatesTx(candidateInputs);
    const holderLabels = this.bulkLifecycleLabelsTx(
      rows
        .map((row) => parseGraphPayload(row.payload_json)?.holderJid)
        .filter((jid): jid is string => typeof jid === "string")
    );
    const claimTextStmt = this.db.prepare(`SELECT text FROM brain_claims WHERE id = ?`);
    const counts = { open: 0, overdue: 0, stale: 0, fulfilled: 0, dismissed: 0, sweepDue: 0, orphanedEvents: 0 };
    // Group facets: item counts per source chat within the status+kind scope,
    // BEFORE flag/hide/include/exclude — a stable picker for the group filter.
    const facetCount = new Map<string, number>();
    const facetLabel = new Map<string, string | null>();
    const items: BrainLifecycleItem[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const claimId = claimIds[index]!;
      const fold = foldByClaim.get(claimId)!;
      const payload = parseGraphPayload(row.payload_json);
      const anchorMs = anchorByClaim.get(claimId) ?? null;
      const dueMs = typeof payload?.dueMs === "number" ? (payload.dueMs as number) : null;
      const flags = computeLifecycleFlags({
        status: fold.status,
        dueMs,
        lastEvidenceAtMs: row.last_seen_at_ms,
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
        candidateCount = candidatesByClaim.get(claimId)?.length ?? 0;
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
      // In the status+kind scope: count this group toward the facet picker
      // (before the narrowing filters, so a group never vanishes from its own
      // picker just because it's currently excluded).
      const chatKey = row.chat_scope ?? "";
      facetCount.set(chatKey, (facetCount.get(chatKey) ?? 0) + 1);
      if (!facetLabel.has(chatKey)) {
        facetLabel.set(chatKey, row.chatDisplayName?.trim() || null);
      }
      // Flag filter (open views only): keep just the items carrying the flag —
      // counts above are already the full totals, so the chips stay honest.
      if (options.flag === "overdue" && !flags.overdue) continue;
      if (options.flag === "stale" && !flags.stale) continue;
      if (options.flag === "sweep_due" && !sweepDue) continue;
      // Exclusions: hide a category from the shown list (counts stay full).
      if (options.hideOverdue && flags.overdue) continue;
      if (options.hideStale && flags.stale) continue;
      if (options.hideFulfilled && fold.status === "fulfilled") continue;
      if (options.hideDismissed && fold.status === "dismissed") continue;
      // Upcoming deadlines only: open, dated, and due in the future.
      if (options.dueUpcoming && (fold.status !== "open" || dueMs == null || dueMs < asOfMs)) continue;
      // Group include/exclude.
      if (includeChats && !includeChats.has(chatKey)) continue;
      if (excludeChats && excludeChats.has(chatKey)) continue;
      const holderJid = typeof payload?.holderJid === "string" ? (payload.holderJid as string) : null;
      const claimRow = claimTextStmt.get(claimId) as { text: string } | undefined;
      let resolution: BrainLifecycleResolutionView | null = null;
      if (fold.resolvingEvent) {
        resolution = {
          status: fold.resolvingEvent.toStatus,
          source: fold.resolvingEvent.source,
          atMs: fold.resolvedAtMs ?? fold.resolvingEvent.createdAtMs,
          note: fold.resolvingEvent.note,
          model: fold.resolvingEvent.model,
          cites: this.lifecycleCiteViewsTx(fold.resolvingEvent)
        };
      }
      items.push({
        nodeId: row.id,
        slug: row.slug,
        kind: row.kind as "commitment" | "question",
        claimId,
        text: claimRow?.text ?? row.title ?? "",
        chatSourceId: row.chat_scope ?? "",
        chatDisplayName: row.chatDisplayName?.trim() || null,
        holderJid,
        holderLabel: holderJid ? holderLabels.get(holderJid) ?? holderJid : null,
        openedAtMs: anchorMs,
        dueMs,
        lastEvidenceAtMs: row.last_seen_at_ms,
        lastReviewedAtMs: fold.lastReviewedAtMs,
        status: fold.status,
        overdue: flags.overdue,
        stale: flags.stale,
        candidateCount,
        salience: Number(row.salience ?? 0),
        dormant: row.status === "dormant",
        resolution
      });
    }
    counts.orphanedEvents = Number(
      (
        this.db.prepare(`SELECT COUNT(DISTINCT claim_id) AS count FROM brain_lifecycle_events WHERE orphaned_at_ms IS NOT NULL`).get() as {
          count: number;
        }
      ).count
    );
    sortLifecycleItems(items, options.sort ?? "smart", statusFilter);
    const chatFacets = [...facetCount.entries()]
      .map(([chatSourceId, count]) => ({ chatSourceId, chatDisplayName: facetLabel.get(chatSourceId) ?? null, count }))
      .sort((a, b) => b.count - a.count || (a.chatDisplayName ?? a.chatSourceId).localeCompare(b.chatDisplayName ?? b.chatSourceId))
      .slice(0, 300);
    return { items: items.slice(0, limit), counts, chatFacets, asOfMs, staleDays };
  }

  // Full context for one lifecycle item (the detail modal): the item, the
  // messages it was extracted FROM (origin), all postdating candidate evidence
  // with thread coordinates, and the transition history. Zero model calls.
  async getBrainLifecycleItemDetail(claimId: string): Promise<BrainLifecycleItemDetail | null> {
    const row = this.lifecycleNodeRowForClaimTx(claimId) as (GraphNodeRow & { chatDisplayName?: string | null }) | undefined;
    if (!row) {
      return null;
    }
    const chatDisplayName =
      (this.db.prepare(`SELECT display_name AS name FROM chats WHERE source_chat_id = ?`).get(row.chat_scope) as { name: string | null } | undefined)
        ?.name?.trim() || null;
    const events = this.loadLifecycleEventsTx([claimId]).get(claimId) ?? [];
    const fold = foldLifecycleEvents(events);
    const payload = parseGraphPayload(row.payload_json);
    const { anchorMs } = this.lifecycleAnchorTx(claimId);
    const dueMs = typeof payload?.dueMs === "number" ? (payload.dueMs as number) : null;
    const flags = computeLifecycleFlags({
      status: fold.status,
      dueMs,
      lastEvidenceAtMs: row.last_seen_at_ms,
      lastReviewedAtMs: fold.lastReviewedAtMs,
      openedAtMs: anchorMs,
      asOfMs: Date.now(),
      staleDays: lifecycleStaleDays()
    });
    // All postdating candidates (since the anchor, not just since last review)
    // so the modal shows the complete evidence picture.
    const candidates = this.bulkLifecycleCandidatesTx([{ claimId, chatSourceId: row.chat_scope ?? "", sinceMs: anchorMs ?? 0 }]).get(claimId) ?? [];
    const holderJid = typeof payload?.holderJid === "string" ? (payload.holderJid as string) : null;
    const claimRow = this.db.prepare(`SELECT text FROM brain_claims WHERE id = ?`).get(claimId) as { text: string } | undefined;
    const item: BrainLifecycleItem = {
      nodeId: row.id,
      slug: row.slug,
      kind: row.kind as "commitment" | "question",
      claimId,
      text: claimRow?.text ?? row.title ?? "",
      chatSourceId: row.chat_scope ?? "",
      chatDisplayName,
      holderJid,
      holderLabel: holderJid ? this.lifecycleActorLabelTx(holderJid === "me" ? "me" : this.canonicalJid(holderJid) ?? holderJid) : null,
      openedAtMs: anchorMs,
      dueMs,
      lastEvidenceAtMs: row.last_seen_at_ms,
      lastReviewedAtMs: fold.lastReviewedAtMs,
      status: fold.status,
      overdue: flags.overdue,
      stale: flags.stale,
      candidateCount: candidates.length,
      salience: Number(row.salience ?? 0),
      dormant: row.status === "dormant",
      resolution: fold.resolvingEvent
        ? {
            status: fold.resolvingEvent.toStatus,
            source: fold.resolvingEvent.source,
            atMs: fold.resolvedAtMs ?? fold.resolvingEvent.createdAtMs,
            note: fold.resolvingEvent.note,
            model: fold.resolvingEvent.model,
            cites: this.lifecycleCiteViewsTx(fold.resolvingEvent)
          }
        : null
    };
    // Origin: the claim's own citations — the conversation where it was made.
    const originRows = this.db
      .prepare(
        `SELECT bc.source_message_key AS key, bc.sender_source_jid AS senderJid, bc.message_id AS messageId, ch.id AS chatId, bc.timestamp_ms AS ts,
                COALESCE(NULLIF(TRIM(COALESCE(m.body, '')), ''), NULLIF(TRIM(COALESCE(m.caption, '')), '')) AS text
         FROM brain_citations bc
         LEFT JOIN messages m ON m.source_message_key = bc.source_message_key
         LEFT JOIN chats ch ON ch.source_chat_id = bc.source_chat_id
         WHERE bc.claim_id = ? ORDER BY bc.timestamp_ms ASC, bc.id ASC`
      )
      .all(claimId) as Array<{ key: string; senderJid: string | null; messageId: number | null; chatId: number | null; ts: number | null; text: string | null }>;
    const origin: BrainLifecycleCiteView[] = originRows.map((cite) => ({
      sourceMessageKey: cite.key,
      chatId: cite.chatId ?? null,
      messageId: cite.messageId ?? null,
      timestampMs: cite.ts ?? null,
      senderLabel: cite.senderJid ? this.lifecycleActorLabelTx(cite.senderJid === "me" ? "me" : this.canonicalJid(cite.senderJid) ?? cite.senderJid) : null,
      snippet: cite.text ? (cite.text.length > 200 ? `${cite.text.slice(0, 199)}…` : cite.text) : null
    }));
    // Thread coordinates for each candidate's message, for click-through.
    const coordStmt = this.db.prepare(
      `SELECT m.id AS messageId, ch.id AS chatId FROM messages m JOIN chats ch ON ch.id = m.chat_id WHERE m.source_message_key = ?`
    );
    const detailCandidates: BrainLifecycleDetailCandidate[] = candidates.map((candidate) => {
      const coords = coordStmt.get(candidate.sourceMessageKey) as { messageId: number; chatId: number } | undefined;
      return { ...candidate, chatId: coords?.chatId ?? null, messageId: coords?.messageId ?? null };
    });
    return { item, origin, candidates: detailCandidates, events };
  }

  async listBrainLifecycleSweepBatches(
    options: { chatSourceId?: string | null; claimIds?: string[]; maxNodesPerBatch?: number } = {}
  ): Promise<BrainLifecycleSweepBatch[]> {
    const asOfMs = Date.now();
    const maxNodes = Math.max(1, Math.min(LIFECYCLE_SWEEP_MAX_NODES_PER_CALL, options.maxNodesPerBatch ?? LIFECYCLE_SWEEP_MAX_NODES_PER_CALL));
    // Explicit selection: sweep exactly these claims, overriding the sweep-due
    // heuristic (the user asked for them, so a no-evidence node still gets an
    // honest review). Empty set means "no explicit selection" (whole scope).
    const selected = options.claimIds && options.claimIds.length > 0 ? new Set(options.claimIds) : null;
    const clauses = [`n.kind IN ('commitment','question')`, `n.status != 'merged'`];
    const params: unknown[] = [];
    if (options.chatSourceId) {
      clauses.push(`n.chat_scope = ?`);
      params.push(this.canonicalJid(options.chatSourceId) ?? options.chatSourceId);
    }
    const rows = this.db
      .prepare(
        `SELECT n.*, ch.display_name AS chatDisplayName FROM brain_nodes n
         LEFT JOIN chats ch ON ch.source_chat_id = n.chat_scope
         WHERE ${clauses.join(" AND ")}`
      )
      .all(...params) as Array<GraphNodeRow & { chatDisplayName: string | null }>;
    const claimIds = rows.map((row) => row.natural_key.slice(row.natural_key.indexOf(":") + 1));
    const eventsByClaim = this.loadLifecycleEventsTx(claimIds);
    const anchorByClaim = this.bulkLifecycleAnchorsTx(claimIds);
    const foldByClaim = new Map<string, LifecycleFold>();
    const candidateInputs: Array<{ claimId: string; chatSourceId: string; sinceMs: number }> = [];
    for (let index = 0; index < claimIds.length; index += 1) {
      const claimId = claimIds[index]!;
      const fold = foldLifecycleEvents(eventsByClaim.get(claimId) ?? []);
      foldByClaim.set(claimId, fold);
      if (fold.status === "open") {
        candidateInputs.push({
          claimId,
          chatSourceId: rows[index]!.chat_scope ?? "",
          sinceMs: Math.max(anchorByClaim.get(claimId) ?? 0, fold.lastReviewedAtMs ?? 0)
        });
      }
    }
    const candidatesByClaim = this.bulkLifecycleCandidatesTx(candidateInputs);
    const holderLabels = this.bulkLifecycleLabelsTx(
      rows
        .map((row) => parseGraphPayload(row.payload_json)?.holderJid)
        .filter((jid): jid is string => typeof jid === "string")
    );
    const claimTextStmt = this.db.prepare(`SELECT text FROM brain_claims WHERE id = ?`);
    const dueByChat = new Map<string, { chatDisplayName: string | null; nodes: Array<BrainLifecycleSweepNode & { overdue: boolean; lastEvidenceAtMs: number | null }> }>();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const claimId = claimIds[index]!;
      const fold = foldByClaim.get(claimId)!;
      if (fold.status !== "open" || !row.chat_scope) {
        continue;
      }
      if (selected && !selected.has(claimId)) {
        continue;
      }
      const payload = parseGraphPayload(row.payload_json);
      const dueMs = typeof payload?.dueMs === "number" ? (payload.dueMs as number) : null;
      const anchorMs = anchorByClaim.get(claimId) ?? null;
      const candidates = candidatesByClaim.get(claimId) ?? [];
      const duePassedSinceReview = dueMs != null && dueMs < asOfMs && (fold.lastReviewedAtMs == null || fold.lastReviewedAtMs < dueMs);
      // Sweep-due rule: no new evidence and no newly passed due date → no model
      // call for this node — UNLESS it was explicitly selected, which overrides.
      if (!selected && candidates.length === 0 && !duePassedSinceReview) {
        continue;
      }
      const holderJid = typeof payload?.holderJid === "string" ? (payload.holderJid as string) : null;
      const claimRow = claimTextStmt.get(claimId) as { text: string } | undefined;
      const bucket = dueByChat.get(row.chat_scope) ?? { chatDisplayName: row.chatDisplayName?.trim() || null, nodes: [] };
      bucket.nodes.push({
        nodeId: row.id,
        claimId,
        kind: row.kind as "commitment" | "question",
        text: claimRow?.text ?? row.title ?? "",
        holderLabel: holderJid ? holderLabels.get(holderJid) ?? holderJid : null,
        openedAtMs: anchorMs,
        dueMs,
        candidates,
        overdue: dueMs != null && dueMs < asOfMs,
        lastEvidenceAtMs: row.last_seen_at_ms
      });
      dueByChat.set(row.chat_scope, bucket);
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

  // === Semantic consolidation (semantic-rollups) ===========================
  // Docs are derived-of-derived: consolidated from current model-generated
  // claims by a strong-tier call that returns structured statements. The
  // repository owns data assembly and the transactional commit; ALL contract
  // semantics (selection, guard, conflict pairing, rendering) live in the
  // shared pure module brain/rollups.ts so both backends agree by construction.

  // Which doc kind a node can anchor; claim-ish kinds never get pages.
  private docKindForNodeRow(row: GraphNodeRow): BrainDocKind | null {
    if (row.kind === "person" || row.kind === "org" || row.kind === "place" || row.kind === "project" || row.kind === "other") {
      return "entity";
    }
    if (row.kind === "topic") {
      return "topic";
    }
    if (row.kind === "chat") {
      return "chat";
    }
    return null;
  }

  // Resolve a rollup/doc target to its node row, following merged redirects.
  private resolveDocTargetNodeTx(target: { docId?: string | null; nodeId?: string | null }): { row: GraphNodeRow; redirected: boolean } | null {
    let row: GraphNodeRow | undefined;
    if (target.nodeId) {
      row = this.db.prepare(`SELECT * FROM brain_nodes WHERE id = ?`).get(target.nodeId) as GraphNodeRow | undefined;
    } else if (target.docId) {
      const separator = target.docId.indexOf(":");
      const slug = separator >= 0 ? target.docId.slice(separator + 1) : target.docId;
      row = this.db.prepare(`SELECT * FROM brain_nodes WHERE slug = ?`).get(slug) as GraphNodeRow | undefined;
    }
    let redirected = false;
    for (let hop = 0; row && row.status === "merged" && row.merged_into && hop < 5; hop += 1) {
      row = this.db.prepare(`SELECT * FROM brain_nodes WHERE id = ?`).get(row.merged_into) as GraphNodeRow | undefined;
      redirected = true;
    }
    if (!row || !this.docKindForNodeRow(row)) {
      return null;
    }
    return { row, redirected };
  }

  // Person docs aggregate via membership at read time (sync form of the
  // entity view's join): the doc's scope nodes are the person's member nodes.
  private docScopeNodeIdsTx(row: GraphNodeRow): string[] {
    if (row.kind !== "person" || !row.jid) {
      return [row.id];
    }
    const membership = this.personMembershipTx(row.jid);
    if (!membership) {
      return [row.id];
    }
    const members = this.db
      .prepare(`SELECT identity_jid AS jid FROM person_members WHERE person_id = ?`)
      .all(membership.personId) as Array<{ jid: string }>;
    const ids = new Set<string>([row.id]);
    for (const member of members) {
      const canonical = this.canonicalJid(member.jid) ?? member.jid;
      const memberRow = this.db.prepare(`SELECT id, status FROM brain_nodes WHERE natural_key = ?`).get(personJidNaturalKey(canonical)) as
        | { id: string; status: string }
        | undefined;
      if (memberRow && memberRow.status !== "merged") {
        ids.add(memberRow.id);
      }
    }
    return [...ids];
  }

  // The doc's eligible claim-id universe. Entity docs read brain_node_claims
  // (membership-aggregated); topic docs read `about`-edge evidence (topic
  // nodes carry no claim links); chat docs read the chat's episodes directly.
  // Filters (current episode, model generator, not superseded) apply in the
  // hydration join — this method only resolves SCOPE.
  private docScopeClaimIdsTx(kind: BrainDocKind, row: GraphNodeRow): string[] {
    if (kind === "entity") {
      const nodeIds = this.docScopeNodeIdsTx(row);
      const placeholders = nodeIds.map(() => "?").join(",");
      return (
        this.db
          .prepare(`SELECT DISTINCT claim_id AS claimId FROM brain_node_claims WHERE node_id IN (${placeholders})`)
          .all(...nodeIds) as Array<{ claimId: string }>
      ).map((entry) => entry.claimId);
    }
    if (kind === "topic") {
      return (
        this.db
          .prepare(
            `SELECT DISTINCT ev.claim_id AS claimId
             FROM brain_edges e
             JOIN brain_edge_evidence ev ON ev.edge_id = e.id AND ev.claim_id IS NOT NULL
             WHERE e.kind = 'about' AND (e.dst_node_id = ? OR e.src_node_id = ?)`
          )
          .all(row.id, row.id) as Array<{ claimId: string }>
      ).map((entry) => entry.claimId);
    }
    const chatSourceId = row.chat_scope ?? (row.natural_key.startsWith("chat:") ? row.natural_key.slice(5) : null);
    if (!chatSourceId) {
      return [];
    }
    return (
      this.db
        .prepare(
          `SELECT c.id AS claimId FROM brain_claims c JOIN brain_episodes e ON e.id = c.episode_id WHERE e.chat_source_id = ?`
        )
        .all(chatSourceId) as Array<{ claimId: string }>
    ).map((entry) => entry.claimId);
  }

  // Hydrate scope claim ids into rollup input claims: eligibility filters
  // (current episode, model generator, not superseded), episode windows,
  // citations, and the lifecycle fold for commitment/question claims.
  private hydrateRollupClaimsTx(claimIds: string[]): BrainRollupInputClaim[] {
    const claims: BrainRollupInputClaim[] = [];
    if (claimIds.length === 0) {
      return claims;
    }
    const rows: Array<{
      id: string;
      kind: BrainRollupInputClaim["kind"];
      text: string;
      confidence: BrainRollupInputClaim["confidence"];
      eventAtMs: number | null;
      validUntilMs: number | null;
      episodeId: string;
      episodeStartAtMs: number;
      episodeEndAtMs: number;
      chatSourceId: string;
      chatDisplayName: string | null;
    }> = [];
    for (let index = 0; index < claimIds.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = claimIds.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      rows.push(
        ...(this.db
          .prepare(
            `SELECT c.id AS id, c.kind AS kind, c.text AS text, c.confidence AS confidence,
                    c.event_at_ms AS eventAtMs, c.valid_until_ms AS validUntilMs,
                    e.id AS episodeId, e.start_at_ms AS episodeStartAtMs, e.end_at_ms AS episodeEndAtMs,
                    e.chat_source_id AS chatSourceId, ch.display_name AS chatDisplayName
             FROM brain_claims c
             JOIN brain_episodes e ON e.id = c.episode_id AND e.status = 'current' AND e.generator = 'model'
             LEFT JOIN chats ch ON ch.source_chat_id = e.chat_source_id
             WHERE c.id IN (${placeholders}) AND c.superseded_by_claim_id IS NULL`
          )
          .all(...batch) as typeof rows)
      );
    }
    const eligibleIds = rows.map((row) => row.id);
    const citationsByClaim = new Map<string, BrainRollupInputClaim["citations"]>();
    for (let index = 0; index < eligibleIds.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = eligibleIds.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      const citationRows = this.db
        .prepare(
          `SELECT claim_id AS claimId, source_message_key AS sourceMessageKey, timestamp_ms AS timestampMs, sender_source_jid AS senderJid
           FROM brain_citations WHERE claim_id IN (${placeholders})`
        )
        .all(...batch) as Array<{ claimId: string; sourceMessageKey: string; timestampMs: number | null; senderJid: string | null }>;
      for (const citation of citationRows) {
        const list = citationsByClaim.get(citation.claimId) ?? [];
        list.push({ sourceMessageKey: citation.sourceMessageKey, timestampMs: citation.timestampMs, senderJid: citation.senderJid });
        citationsByClaim.set(citation.claimId, list);
      }
    }
    const lifecycleIds = rows.filter((row) => row.kind === "commitment" || row.kind === "question").map((row) => row.id);
    const eventsByClaim = this.loadLifecycleEventsTx(lifecycleIds);
    for (const row of rows) {
      let lifecycleStatus: BrainLifecycleStatus | null = null;
      let lifecycleDueMs: number | null = null;
      if (row.kind === "commitment" || row.kind === "question") {
        lifecycleStatus = foldLifecycleEvents(eventsByClaim.get(row.id) ?? []).status;
        lifecycleDueMs = row.validUntilMs ?? row.eventAtMs;
      }
      claims.push({
        claimId: row.id,
        kind: row.kind,
        text: row.text,
        confidence: row.confidence,
        eventAtMs: row.eventAtMs,
        validUntilMs: row.validUntilMs,
        episodeId: row.episodeId,
        episodeStartAtMs: Number(row.episodeStartAtMs),
        episodeEndAtMs: Number(row.episodeEndAtMs),
        chatSourceId: row.chatSourceId,
        chatDisplayName: row.chatDisplayName,
        citations: citationsByClaim.get(row.id) ?? [],
        lifecycleStatus,
        lifecycleDueMs
      });
    }
    return claims;
  }

  // Conflict facts for the shared detector: entity anchors per claim (JID
  // where resolved, else normalized name), bulk.
  private conflictFactsTx(claims: BrainRollupInputClaim[]): ConflictClaimFacts[] {
    const byId = new Map(claims.map((claim) => [claim.claimId, claim]));
    const entityKeysByClaim = new Map<string, string[]>();
    const ids = [...byId.keys()];
    for (let index = 0; index < ids.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = ids.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT claim_id AS claimId, name, jid FROM brain_claim_entities WHERE claim_id IN (${placeholders})`)
        .all(...batch) as Array<{ claimId: string; name: string; jid: string | null }>;
      for (const row of rows) {
        const key = row.jid ?? normalizeGraphName(row.name);
        const list = entityKeysByClaim.get(row.claimId) ?? [];
        if (!list.includes(key)) {
          list.push(key);
        }
        entityKeysByClaim.set(row.claimId, list);
      }
    }
    return [...byId.values()].map((claim) => ({
      claimId: claim.claimId,
      kind: claim.kind,
      episodeId: claim.episodeId,
      episodeEndAtMs: claim.episodeEndAtMs,
      entityKeys: entityKeysByClaim.get(claim.claimId) ?? [],
      supersededBy: null
    }));
  }

  private docRowTx(docId: string): BrainDocRow | undefined {
    return this.db.prepare(`SELECT * FROM brain_docs WHERE doc_id = ?`).get(docId) as BrainDocRow | undefined;
  }

  private currentRevisionRefsTx(doc: BrainDocRow | undefined): { revisionId: number; revision: number; referencedClaimIds: string[] } | null {
    if (!doc?.current_revision_id) {
      return null;
    }
    const revision = this.db
      .prepare(`SELECT id, revision FROM brain_doc_revisions WHERE id = ?`)
      .get(doc.current_revision_id) as { id: number; revision: number } | undefined;
    if (!revision) {
      return null;
    }
    const refs = (
      this.db.prepare(`SELECT claim_id AS claimId FROM brain_doc_revision_claims WHERE revision_id = ?`).all(revision.id) as Array<{
        claimId: string;
      }>
    ).map((entry) => entry.claimId);
    return { revisionId: revision.id, revision: revision.revision, referencedClaimIds: refs };
  }

  async getBrainRollupInput(target: { docId?: string | null; nodeId?: string | null }): Promise<BrainRollupInput | null> {
    const resolved = this.resolveDocTargetNodeTx(target);
    if (!resolved) {
      return null;
    }
    const { row } = resolved;
    const kind = this.docKindForNodeRow(row)!;
    const docId = docIdFor(kind, row.slug);
    const scopeIds = this.docScopeClaimIdsTx(kind, row);
    const claims = this.hydrateRollupClaimsTx(scopeIds);
    const conflictPairs = detectConflictPairs(this.conflictFactsTx(claims));
    const prior = this.currentRevisionRefsTx(this.docRowTx(docId));
    return {
      docId,
      kind,
      nodeId: row.id,
      slug: row.slug,
      title: this.graphLabelForNodeRow(row),
      prior,
      claims,
      conflictPairs,
      stats: { eligibleClaims: claims.length, fedClaims: 0, tokenEstimate: 0, overflow: false, tiersEngaged: [] }
    };
  }

  private mapDocRow(row: BrainDocRow): BrainDocRecord {
    return {
      docId: row.doc_id,
      kind: row.kind,
      nodeId: row.node_id,
      slug: row.slug,
      status: row.status,
      mergedInto: row.merged_into,
      currentRevisionId: row.current_revision_id,
      lastRollupAtMs: row.last_rollup_at_ms,
      createdAtMs: row.created_at_ms
    };
  }

  private mapDocRevisionRow(row: DocRevisionRow): BrainDocRevisionRecord {
    const resolutions = JSON.parse(row.resolutions_json ?? "{}") as { eventIds?: number[] };
    return {
      id: row.id,
      docId: row.doc_id,
      revision: row.revision,
      status: row.status,
      sections: JSON.parse(row.sections_json) as BrainDocRevisionRecord["sections"],
      drops: JSON.parse(row.drops_json) as BrainDocRevisionRecord["drops"],
      fedClaimIds: JSON.parse(row.fed_claim_ids_json) as string[],
      inputStats: JSON.parse(row.input_stats_json) as BrainDocRevisionRecord["inputStats"],
      resolutionEventIds: resolutions.eventIds ?? [],
      errors: row.errors_json ? (JSON.parse(row.errors_json) as string[]) : null,
      model: row.model,
      effort: row.effort,
      runId: row.run_id,
      promptVersion: row.prompt_version,
      createdAtMs: row.created_at_ms
    };
  }

  // Transactional revision commit — the ONE write path for successful rollups:
  // guard re-check, lifecycle resolutions through the shared writer core,
  // revision + junction insert, prior flip, supersession projection, doc
  // pointer update, stale-share/contradiction issues. Everything or nothing.
  async commitBrainDocRevision(input: BrainRollupRevisionInput): Promise<BrainDocCommitResult> {
    let committed: BrainDocRevisionRecord | null = null;
    let contradictions: BrainConflictPair[] = [];
    const transaction = this.db.transaction(() => {
      const now = Date.now();
      let doc = this.docRowTx(input.docId);
      if (!doc) {
        this.db
          .prepare(
            `INSERT INTO brain_docs (doc_id, kind, node_id, slug, status, current_revision_id, last_rollup_at_ms, created_at_ms)
             VALUES (?, ?, ?, ?, 'active', NULL, NULL, ?)`
          )
          .run(input.docId, input.kind, input.nodeId, input.slug, now);
        doc = this.docRowTx(input.docId)!;
      }
      const prior = this.currentRevisionRefsTx(doc);
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
      // The guard's current-claims universe: prior refs still alive as claims
      // of CURRENT episodes (supersession projection does not "kill" a claim).
      const priorRefs = prior?.referencedClaimIds ?? [];
      const currentClaimIds = new Set<string>();
      for (let index = 0; index < priorRefs.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
        const batch = priorRefs.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
        const placeholders = batch.map(() => "?").join(",");
        const liveRows = this.db
          .prepare(
            `SELECT c.id AS id FROM brain_claims c JOIN brain_episodes e ON e.id = c.episode_id AND e.status = 'current' WHERE c.id IN (${placeholders})`
          )
          .all(...batch) as Array<{ id: string }>;
        for (const live of liveRows) {
          currentClaimIds.add(live.id);
        }
      }
      const guard = runRollupGuard({
        priorReferencedClaimIds: priorRefs,
        newReferencedClaimIds: [...newReferenced],
        currentClaimIds,
        declaredDrops: input.drops,
        fedClaimIds: fedSet
      });
      if (guard.errors.length > 0) {
        throw new PublicError("BRAIN_ROLLUP_GUARD", `Regression guard refused the revision: ${guard.errors.join("; ")}`);
      }
      // Lifecycle resolutions apply INSIDE this transaction through the one
      // writer core — its independent re-validation is the §L8 guarantee.
      const eventIds =
        input.resolutions.length > 0
          ? this.applyBrainLifecycleTransitionsCoreTx(input.resolutions, {
              source: "model",
              runId: input.runId,
              model: input.model,
              allowedCitesByClaim: input.allowedCitesByClaim
            })
          : [];
      // Number PAST every retained revision — rejected attempts occupy numbers
      // too (found live: a rejected rev 1 collided with the next commit's
      // UNIQUE(doc_id, revision)). The guard baseline stays the CURRENT
      // revision; only numbering counts the whole retained history.
      const maxRevisionRow = this.db
        .prepare(`SELECT MAX(revision) AS maxRevision FROM brain_doc_revisions WHERE doc_id = ?`)
        .get(input.docId) as { maxRevision: number | null };
      const revisionNumber = Math.max(maxRevisionRow.maxRevision ?? 0, prior?.revision ?? 0) + 1;
      const revisionId = Number(
        this.db
          .prepare(
            `INSERT INTO brain_doc_revisions
             (doc_id, revision, status, sections_json, drops_json, fed_claim_ids_json, input_stats_json, resolutions_json, errors_json, model, effort, run_id, prompt_version, created_at_ms)
             VALUES (?, ?, 'current', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
          )
          .run(
            input.docId,
            revisionNumber,
            JSON.stringify(input.sections),
            JSON.stringify(guard.effectiveDrops),
            JSON.stringify(input.fedClaimIds),
            JSON.stringify(input.inputStats),
            JSON.stringify({ resolutions: input.resolutions.map((entry) => ({ claimId: entry.claimId, toStatus: entry.toStatus })), eventIds }),
            input.model,
            input.effort,
            input.runId,
            input.promptVersion,
            now
          ).lastInsertRowid
      );
      const insertRef = this.db.prepare(`INSERT OR IGNORE INTO brain_doc_revision_claims (revision_id, claim_id) VALUES (?, ?)`);
      for (const claimId of newReferenced) {
        insertRef.run(revisionId, claimId);
      }
      if (prior) {
        this.db.prepare(`UPDATE brain_doc_revisions SET status = 'superseded' WHERE id = ?`).run(prior.revisionId);
      }
      // Supersession PROJECTION (revisions are the durable truth).
      const project = this.db.prepare(`UPDATE brain_claims SET superseded_by_claim_id = ? WHERE id = ?`);
      for (const drop of guard.effectiveDrops) {
        if (drop.reason === "superseded" && drop.byClaimId) {
          project.run(drop.byClaimId, drop.claimId);
        }
      }
      this.db
        .prepare(`UPDATE brain_docs SET current_revision_id = ?, last_rollup_at_ms = ?, status = 'active', merged_into = NULL WHERE doc_id = ?`)
        .run(revisionId, now, input.docId);
      // Post-write verification (recall+verify, never suggest): residual
      // same-kind contradictions among the REFERENCED claims — flag only.
      const referencedClaims = this.hydrateRollupClaimsTx([...newReferenced]);
      contradictions = detectConflictPairs(this.conflictFactsTx(referencedClaims)).filter(
        (pair) => newReferenced.has(pair.claimIdA) && newReferenced.has(pair.claimIdB)
      );
      const insertIssue = this.db.prepare(
        `INSERT INTO brain_validation_issues (run_id, chat_source_id, episode_id, claim_sequence, doc_id, code, severity, detail)
         VALUES (?, NULL, NULL, NULL, ?, ?, ?, ?)`
      );
      for (const pair of contradictions) {
        insertIssue.run(
          input.runId,
          input.docId,
          "rollup_contradiction",
          "warning",
          `Revision ${revisionNumber} keeps likely-conflicting ${pair.claimKind} claims ${pair.claimIdA} and ${pair.claimIdB} (via ${pair.via}) with neither superseding the other.`
        );
      }
      if ((prior?.referencedClaimIds.length ?? 0) > 0 && guard.staleShare > rollupStaleDropShare()) {
        insertIssue.run(
          input.runId,
          input.docId,
          "rollup_stale_shed",
          "info",
          `Revision ${revisionNumber} dropped ${Math.round(guard.staleShare * 100)}% of the prior revision's claims as stale/out-of-scope — allowed, recorded, never invisible.`
        );
      }
      committed = this.mapDocRevisionRow(
        this.db.prepare(`SELECT * FROM brain_doc_revisions WHERE id = ?`).get(revisionId) as DocRevisionRow
      );
    });
    transaction();
    this.invalidateBrainStatusCache();
    return { record: committed!, contradictions };
  }

  // A twice-failed call's rejected revision: retained with its errors for
  // audit, prior revision untouched, error-severity issue recorded. No
  // extractive fallback exists for pages, by design.
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
    const transaction = this.db.transaction(() => {
      const now = Date.now();
      let doc = this.docRowTx(input.docId);
      if (!doc) {
        this.db
          .prepare(
            `INSERT INTO brain_docs (doc_id, kind, node_id, slug, status, current_revision_id, last_rollup_at_ms, created_at_ms)
             VALUES (?, ?, ?, ?, 'active', NULL, NULL, ?)`
          )
          .run(input.docId, input.kind, input.nodeId, input.slug, now);
        doc = this.docRowTx(input.docId)!;
      }
      const maxRevision = this.db
        .prepare(`SELECT MAX(revision) AS maxRevision FROM brain_doc_revisions WHERE doc_id = ?`)
        .get(input.docId) as { maxRevision: number | null };
      this.db
        .prepare(
          `INSERT INTO brain_doc_revisions
           (doc_id, revision, status, sections_json, drops_json, fed_claim_ids_json, input_stats_json, resolutions_json, errors_json, model, effort, run_id, prompt_version, created_at_ms)
           VALUES (?, ?, 'rejected', '[]', '[]', ?, ?, '{}', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.docId,
          (maxRevision.maxRevision ?? 0) + 1,
          JSON.stringify(input.fedClaimIds),
          JSON.stringify(input.inputStats),
          JSON.stringify(input.errors),
          input.model,
          input.effort,
          input.runId,
          input.promptVersion,
          now
        );
      this.db
        .prepare(
          `INSERT INTO brain_validation_issues (run_id, chat_source_id, episode_id, claim_sequence, doc_id, code, severity, detail)
           VALUES (?, NULL, NULL, NULL, ?, 'rollup_rejected', 'error', ?)`
        )
        .run(input.runId, input.docId, `Rollup response failed validation twice; prior revision stays current. Errors: ${input.errors.join("; ")}`);
    });
    transaction();
  }

  // Mechanical rollback: flip the current pointer to a prior revision and
  // re-derive this doc's supersession projections from the surviving revision
  // chain. Zero model calls; the action is recorded visibly.
  async rollbackBrainDoc(docId: string, toRevision?: number | null): Promise<BrainDocDetail | null> {
    const transaction = this.db.transaction(() => {
      const doc = this.docRowTx(docId);
      if (!doc) {
        throw new PublicError("BRAIN_DOC_NO_REVISION", `Doc ${docId} does not exist.`);
      }
      // An UNROLLED doc has no current revision — and must still be restorable
      // by explicit revision number, or "nothing is ever lost" would be false.
      const current = doc.current_revision_id
        ? (this.db.prepare(`SELECT id, revision FROM brain_doc_revisions WHERE id = ?`).get(doc.current_revision_id) as {
            id: number;
            revision: number;
          })
        : null;
      // Revision 0 is the state BEFORE any page existed: unroll. The doc keeps
      // every revision (restorable) but goes back to "eligible, never rolled",
      // so the next rollup generates from scratch instead of revising. This is
      // why no hard delete exists — nothing is ever destroyed, only un-currented.
      const unroll = toRevision === BRAIN_DOC_REVISION_NONE;
      if (!current && !unroll && toRevision == null) {
        throw new PublicError("BRAIN_DOC_NO_REVISION", `Doc ${docId} has no current revision to roll back; name a revision to restore.`);
      }
      if (!current && unroll) {
        throw new PublicError("BRAIN_DOC_NO_REVISION", `Doc ${docId} is already unrolled.`);
      }
      const target = unroll
        ? null
        : toRevision
          ? (this.db
              .prepare(`SELECT id, revision, status FROM brain_doc_revisions WHERE doc_id = ? AND revision = ?`)
              .get(docId, toRevision) as { id: number; revision: number; status: string } | undefined)
          : (this.db
              .prepare(
                `SELECT id, revision, status FROM brain_doc_revisions WHERE doc_id = ? AND revision < ? AND status = 'superseded' ORDER BY revision DESC LIMIT 1`
              )
              .get(docId, current!.revision) as { id: number; revision: number; status: string } | undefined);
      if (!unroll && (!target || target.id === current?.id)) {
        throw new PublicError("BRAIN_DOC_NO_TARGET", `Doc ${docId} has no prior revision${toRevision ? ` numbered ${toRevision}` : ""} to restore.`);
      }
      if (target?.status === "rejected") {
        throw new PublicError("BRAIN_DOC_BAD_TARGET", `Revision ${target.revision} was rejected and cannot become current.`);
      }
      if (current) {
        this.db.prepare(`UPDATE brain_doc_revisions SET status = 'superseded' WHERE id = ?`).run(current.id);
      }
      if (target) {
        this.db.prepare(`UPDATE brain_doc_revisions SET status = 'current' WHERE id = ?`).run(target.id);
        // Restoring onto an unrolled doc must also restore its rollup stamp,
        // or dueness would keep reading 'never_rolled' with a page present.
        this.db
          .prepare(
            `UPDATE brain_docs SET current_revision_id = ?, last_rollup_at_ms = COALESCE(last_rollup_at_ms, (SELECT created_at_ms FROM brain_doc_revisions WHERE id = ?)) WHERE doc_id = ?`
          )
          .run(target.id, target.id, docId);
      } else {
        // last_rollup_at_ms clears with the pointer so dueness reads
        // 'never_rolled' and the row lists as an eligible candidate again.
        this.db.prepare(`UPDATE brain_docs SET current_revision_id = NULL, last_rollup_at_ms = NULL WHERE doc_id = ?`).run(docId);
      }
      // Re-derive supersession projections from this doc's surviving chain:
      // clear everything any of its revisions ever declared, then re-apply
      // declarations from revisions ≤ target in order. (A claim superseded by
      // ANOTHER doc's declaration is re-projected by that doc's own next
      // rollup; cross-doc supersession of one claim is a rare, benign race.)
      const revisionRows = this.db
        .prepare(`SELECT id, revision, drops_json FROM brain_doc_revisions WHERE doc_id = ? AND status != 'rejected' ORDER BY revision ASC`)
        .all(docId) as Array<{ id: number; revision: number; drops_json: string }>;
      const clear = this.db.prepare(`UPDATE brain_claims SET superseded_by_claim_id = NULL WHERE id = ?`);
      const project = this.db.prepare(`UPDATE brain_claims SET superseded_by_claim_id = ? WHERE id = ?`);
      for (const revisionRow of revisionRows) {
        for (const drop of JSON.parse(revisionRow.drops_json) as BrainDocRevisionRecord["drops"]) {
          if (drop.reason === "superseded") {
            clear.run(drop.claimId);
          }
        }
      }
      for (const revisionRow of revisionRows) {
        // Unroll keeps no declarations at all (target revision 0).
        if (revisionRow.revision > (target?.revision ?? 0)) {
          continue;
        }
        for (const drop of JSON.parse(revisionRow.drops_json) as BrainDocRevisionRecord["drops"]) {
          if (drop.reason === "superseded" && drop.byClaimId) {
            project.run(drop.byClaimId, drop.claimId);
          }
        }
      }
      this.db
        .prepare(
          `INSERT INTO brain_validation_issues (run_id, chat_source_id, episode_id, claim_sequence, doc_id, code, severity, detail)
           VALUES (NULL, NULL, NULL, NULL, ?, 'rollup_rollback', 'info', ?)`
        )
        .run(
          docId,
          target
            ? `Rolled back from revision ${current?.revision ?? "none"} to revision ${target.revision}.`
            : `Unrolled from revision ${current?.revision ?? "none"}: the page returns to eligible-but-never-rolled. Every revision is retained and restorable; the next rollup generates from scratch.`
        );
    });
    transaction();
    this.invalidateBrainStatusCache();
    return this.getBrainDoc(docId);
  }

  // Per-doc dueness: deterministic conditions only, each recomputable. The
  // scope claim work reuses the same resolvers as input assembly.
  private docDuenessTx(
    doc: BrainDocRow,
    row: GraphNodeRow | undefined
  ): { due: boolean; dueReasons: BrainDocDueReason[]; eligibleClaims: number; newClaims: number; openItems: number } {
    const reasons: BrainDocDueReason[] = [];
    if (!row) {
      return { due: false, dueReasons: reasons, eligibleClaims: 0, newClaims: 0, openItems: 0 };
    }
    if (row.status === "merged" || doc.status === "merged") {
      reasons.push("merged_scope");
    }
    const kind = doc.kind;
    const scopeIds = this.docScopeClaimIdsTx(kind, row);
    const claims = this.hydrateRollupClaimsTx(scopeIds);
    const eligibleClaims = claims.length;
    const lastRollup = doc.last_rollup_at_ms;
    let newClaims = 0;
    if (lastRollup == null) {
      if (eligibleClaims >= rollupMinClaims()) {
        reasons.push("never_rolled");
      }
      newClaims = eligibleClaims;
    } else {
      const lastRollupIso = new Date(lastRollup).toISOString();
      const episodeIds = [...new Set(claims.map((claim) => claim.episodeId))];
      const newEpisodes = new Set<string>();
      for (let index = 0; index < episodeIds.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
        const batch = episodeIds.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
        const placeholders = batch.map(() => "?").join(",");
        const rows = this.db
          .prepare(`SELECT id FROM brain_episodes WHERE id IN (${placeholders}) AND created_at > ?`)
          .all(...batch, lastRollupIso) as Array<{ id: string }>;
        for (const entry of rows) {
          newEpisodes.add(entry.id);
        }
      }
      newClaims = claims.filter((claim) => newEpisodes.has(claim.episodeId)).length;
      if (newClaims >= rollupDueNewClaims()) {
        reasons.push("new_claims");
      }
      const refs = this.currentRevisionRefsTx(doc)?.referencedClaimIds ?? [];
      if (refs.length > 0) {
        const aliveRefs = new Set<string>();
        for (let index = 0; index < refs.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
          const batch = refs.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
          const placeholders = batch.map(() => "?").join(",");
          const rows = this.db
            .prepare(
              `SELECT c.id AS id FROM brain_claims c JOIN brain_episodes e ON e.id = c.episode_id AND e.status = 'current' WHERE c.id IN (${placeholders})`
            )
            .all(...batch) as Array<{ id: string }>;
          for (const entry of rows) {
            aliveRefs.add(entry.id);
          }
        }
        if (aliveRefs.size < refs.length) {
          reasons.push("claims_deleted");
        }
        // Lifecycle churn since the last rollup on the page's own claims —
        // excluding the events the CURRENT revision itself applied (they land
        // milliseconds after the rollup stamp and must not self-trigger).
        const ownEvents = doc.current_revision_id
          ? new Set(
              this.mapDocRevisionRow(
                this.db.prepare(`SELECT * FROM brain_doc_revisions WHERE id = ?`).get(doc.current_revision_id) as DocRevisionRow
              ).resolutionEventIds
            )
          : new Set<number>();
        let lifecycleChanged = false;
        for (let index = 0; index < refs.length && !lifecycleChanged; index += SQLITE_IN_QUERY_BATCH_SIZE) {
          const batch = refs.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
          const placeholders = batch.map(() => "?").join(",");
          const hits = this.db
            .prepare(
              `SELECT id FROM brain_lifecycle_events WHERE claim_id IN (${placeholders}) AND created_at_ms > ? AND orphaned_at_ms IS NULL LIMIT 8`
            )
            .all(...batch, lastRollup) as Array<{ id: number }>;
          if (hits.some((hit) => !ownEvents.has(hit.id))) {
            lifecycleChanged = true;
          }
        }
        if (lifecycleChanged) {
          reasons.push("lifecycle_changed");
        }
      }
    }
    const openItems = claims.filter((claim) => claim.lifecycleStatus === "open").length;
    return { due: reasons.length > 0, dueReasons: reasons, eligibleClaims, newClaims, openItems };
  }

  // Page-eligible nodes WITHOUT a doc yet, per kind, in three bulk queries —
  // never a per-node probe (the wedge lesson). Person candidates dedupe by
  // membership so one human never lists twice.
  private docCandidateRowsTx(): Array<{ nodeId: string; claimCount: number }> {
    const floor = rollupMinClaims();
    const results = new Map<string, number>();
    const entityRows = this.db
      .prepare(
        `SELECT nc.node_id AS nodeId, COUNT(DISTINCT nc.claim_id) AS claimCount
         FROM brain_node_claims nc
         JOIN brain_nodes n ON n.id = nc.node_id AND n.status = 'active' AND n.kind IN ('person','org','place','project','other')
         JOIN brain_claims c ON c.id = nc.claim_id AND c.superseded_by_claim_id IS NULL
         JOIN brain_episodes e ON e.id = c.episode_id AND e.status = 'current' AND e.generator = 'model'
         LEFT JOIN brain_docs d ON d.node_id = nc.node_id
         WHERE d.doc_id IS NULL
         GROUP BY nc.node_id HAVING COUNT(DISTINCT nc.claim_id) >= ?`
      )
      .all(floor) as Array<{ nodeId: string; claimCount: number }>;
    const topicRows = this.db
      .prepare(
        `SELECT eg.dst_node_id AS nodeId, COUNT(DISTINCT ev.claim_id) AS claimCount
         FROM brain_edges eg
         JOIN brain_nodes n ON n.id = eg.dst_node_id AND n.status = 'active' AND n.kind = 'topic'
         JOIN brain_edge_evidence ev ON ev.edge_id = eg.id AND ev.claim_id IS NOT NULL
         JOIN brain_claims c ON c.id = ev.claim_id AND c.superseded_by_claim_id IS NULL
         JOIN brain_episodes e ON e.id = c.episode_id AND e.status = 'current' AND e.generator = 'model'
         LEFT JOIN brain_docs d ON d.node_id = eg.dst_node_id
         WHERE eg.kind = 'about' AND d.doc_id IS NULL
         GROUP BY eg.dst_node_id HAVING COUNT(DISTINCT ev.claim_id) >= ?`
      )
      .all(floor) as Array<{ nodeId: string; claimCount: number }>;
    const chatRows = this.db
      .prepare(
        `SELECT n.id AS nodeId, COUNT(c.id) AS claimCount
         FROM brain_nodes n
         JOIN brain_episodes e ON e.chat_source_id = n.chat_scope AND e.status = 'current' AND e.generator = 'model'
         JOIN brain_claims c ON c.episode_id = e.id AND c.superseded_by_claim_id IS NULL
         LEFT JOIN brain_docs d ON d.node_id = n.id
         WHERE n.kind = 'chat' AND n.status = 'active' AND d.doc_id IS NULL
         GROUP BY n.id HAVING COUNT(c.id) >= ?`
      )
      .all(floor) as Array<{ nodeId: string; claimCount: number }>;
    for (const entry of [...entityRows, ...topicRows, ...chatRows]) {
      results.set(entry.nodeId, Math.max(results.get(entry.nodeId) ?? 0, Number(entry.claimCount)));
    }
    // Person dedupe: among member nodes of one person, keep the highest count.
    const nodeIds = [...results.keys()];
    const jidByNode = new Map<string, string>();
    for (let index = 0; index < nodeIds.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = nodeIds.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT id, jid FROM brain_nodes WHERE id IN (${placeholders}) AND kind = 'person' AND jid IS NOT NULL`)
        .all(...batch) as Array<{ id: string; jid: string }>;
      for (const entry of rows) {
        jidByNode.set(entry.id, entry.jid);
      }
    }
    const byPerson = new Map<string, { nodeId: string; claimCount: number }>();
    const out: Array<{ nodeId: string; claimCount: number }> = [];
    for (const [nodeId, claimCount] of results) {
      const jid = jidByNode.get(nodeId);
      if (!jid) {
        out.push({ nodeId, claimCount });
        continue;
      }
      const personKey = this.personMembershipTx(jid)?.personId ?? jid;
      const existing = byPerson.get(personKey);
      if (!existing || claimCount > existing.claimCount) {
        byPerson.set(personKey, { nodeId, claimCount });
      }
    }
    out.push(...byPerson.values());
    return out;
  }

  async listBrainDocs(options?: { kind?: BrainDocKind; view?: BrainDocsListView; limit?: number }): Promise<BrainDocsListResponse> {
    const asOfMs = Date.now();
    const items: BrainDocListItem[] = [];
    const issueCounts = new Map<string, number>(
      (
        this.db
          .prepare(`SELECT doc_id AS docId, COUNT(*) AS n FROM brain_validation_issues WHERE doc_id IS NOT NULL GROUP BY doc_id`)
          .all() as Array<{ docId: string; n: number }>
      ).map((row) => [row.docId, Number(row.n)])
    );
    const docRows = this.db.prepare(`SELECT * FROM brain_docs`).all() as BrainDocRow[];
    for (const docRow of docRows) {
      const nodeRow = docRow.node_id
        ? (this.db.prepare(`SELECT * FROM brain_nodes WHERE id = ?`).get(docRow.node_id) as GraphNodeRow | undefined)
        : undefined;
      const dueness = this.docDuenessTx(docRow, nodeRow);
      const currentRevision = docRow.current_revision_id
        ? (this.db.prepare(`SELECT revision FROM brain_doc_revisions WHERE id = ?`).get(docRow.current_revision_id) as
            | { revision: number }
            | undefined)
        : undefined;
      items.push({
        docId: docRow.doc_id,
        kind: docRow.kind,
        nodeId: docRow.node_id ?? "",
        slug: docRow.slug ?? "",
        title: nodeRow ? this.graphLabelForNodeRow(nodeRow) : docRow.slug ?? docRow.doc_id,
        status: nodeRow?.status === "merged" ? "merged" : docRow.status,
        mergedInto: docRow.merged_into,
        revision: currentRevision?.revision ?? null,
        lastRollupAtMs: docRow.last_rollup_at_ms,
        eligibleClaims: dueness.eligibleClaims,
        newClaimsSinceRollup: dueness.newClaims,
        due: dueness.due,
        dueReasons: dueness.dueReasons,
        salience: Number(nodeRow?.salience ?? 0),
        openLifecycleItems: dueness.openItems,
        issueCount: issueCounts.get(docRow.doc_id) ?? 0
      });
    }
    const candidates = this.docCandidateRowsTx();
    let candidateCount = 0;
    for (const candidate of candidates) {
      const nodeRow = this.db.prepare(`SELECT * FROM brain_nodes WHERE id = ?`).get(candidate.nodeId) as GraphNodeRow | undefined;
      if (!nodeRow) {
        continue;
      }
      const kind = this.docKindForNodeRow(nodeRow);
      if (!kind) {
        continue;
      }
      candidateCount += 1;
      items.push({
        docId: docIdFor(kind, nodeRow.slug),
        kind,
        nodeId: nodeRow.id,
        slug: nodeRow.slug,
        title: this.graphLabelForNodeRow(nodeRow),
        status: "active",
        mergedInto: null,
        revision: null,
        lastRollupAtMs: null,
        eligibleClaims: candidate.claimCount,
        newClaimsSinceRollup: candidate.claimCount,
        due: true,
        dueReasons: ["never_rolled"],
        salience: Number(nodeRow.salience ?? 0),
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
    const limited = filtered.slice(0, options?.limit ?? 200);
    return {
      items: limited,
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

  // Render-context assembly for one doc revision: claim metadata (episode
  // files + anchors + citation keys), aliases, member labels, Related links.
  private docRenderContextTx(doc: BrainDocRow, nodeRow: GraphNodeRow, revision: BrainDocRevisionRecord): DocRenderContext {
    const referenced = new Set<string>();
    for (const section of revision.sections) {
      for (const statement of section.statements) {
        for (const claimId of statement.claimIds) {
          referenced.add(claimId);
        }
      }
    }
    const claimMeta = new Map<string, DocRenderClaimMeta>();
    const ids = [...referenced];
    for (let index = 0; index < ids.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = ids.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT c.id AS id, c.sequence AS sequence, e.id AS episodeId, e.status AS episodeStatus,
                  e.start_at_ms AS startAtMs, e.chat_source_id AS chatSourceId, ch.display_name AS chatDisplayName
           FROM brain_claims c
           JOIN brain_episodes e ON e.id = c.episode_id
           LEFT JOIN chats ch ON ch.source_chat_id = e.chat_source_id
           WHERE c.id IN (${placeholders})`
        )
        .all(...batch) as Array<{
        id: string;
        sequence: number;
        episodeId: string;
        episodeStatus: string;
        startAtMs: number;
        chatSourceId: string;
        chatDisplayName: string | null;
      }>;
      for (const row of rows) {
        // Must match the projected file name exactly or the wikilink dangles —
        // hence the one shared definition.
        const fileSlug = episodeFileBase({
          id: row.episodeId,
          startAtMs: Number(row.startAtMs),
          chatSourceId: row.chatSourceId,
          chatDisplayName: row.chatDisplayName
        });
        claimMeta.set(row.id, {
          exists: row.episodeStatus === "current",
          episodeId: row.episodeId,
          episodeFile: fileSlug,
          // sequence is 1-based at commit (index + 1) and the episode markdown
          // anchors are ^claim-<1-based position> — they line up exactly.
          episodeClaimIndex: Number(row.sequence),
          citationKeys: []
        });
      }
      const citationRows = this.db
        .prepare(`SELECT claim_id AS claimId, source_message_key AS key FROM brain_citations WHERE claim_id IN (${placeholders})`)
        .all(...batch) as Array<{ claimId: string; key: string }>;
      for (const citation of citationRows) {
        claimMeta.get(citation.claimId)?.citationKeys.push(citation.key);
      }
    }
    for (const claimId of referenced) {
      if (!claimMeta.has(claimId)) {
        claimMeta.set(claimId, { exists: false, episodeId: null, episodeFile: null, episodeClaimIndex: null, citationKeys: [] });
      }
    }
    const aliases = (
      this.db.prepare(`SELECT alias FROM brain_node_aliases WHERE node_id = ? ORDER BY alias LIMIT 12`).all(nodeRow.id) as Array<{
        alias: string;
      }>
    ).map((row) => row.alias);
    const memberLabels: string[] = [];
    if (nodeRow.kind === "person" && nodeRow.jid) {
      for (const scopeNodeId of this.docScopeNodeIdsTx(nodeRow)) {
        const member = this.db.prepare(`SELECT * FROM brain_nodes WHERE id = ?`).get(scopeNodeId) as GraphNodeRow | undefined;
        if (member) {
          const label = this.graphLabelForNodeRow(member);
          if (!memberLabels.includes(label)) {
            memberLabels.push(label);
          }
        }
      }
    }
    // Related: strongest edges whose other endpoint has a doc — deterministic
    // structural links only, prose is never parsed.
    const relatedRows = this.db
      .prepare(
        `SELECT n.kind AS kind, n.slug AS slug, n.id AS id
         FROM brain_edges eg
         JOIN brain_nodes n ON n.id = CASE WHEN eg.src_node_id = ? THEN eg.dst_node_id ELSE eg.src_node_id END
         JOIN brain_docs d ON d.node_id = n.id
         WHERE (eg.src_node_id = ? OR eg.dst_node_id = ?) AND n.status = 'active'
         ORDER BY eg.weight DESC LIMIT 8`
      )
      .all(nodeRow.id, nodeRow.id, nodeRow.id) as Array<{ kind: GraphNodeRow["kind"]; slug: string; id: string }>;
    const related: DocRenderContext["related"] = [];
    for (const entry of relatedRows) {
      const relatedRow = this.db.prepare(`SELECT * FROM brain_nodes WHERE id = ?`).get(entry.id) as GraphNodeRow | undefined;
      const relatedKind = relatedRow ? this.docKindForNodeRow(relatedRow) : null;
      if (relatedRow && relatedKind && !related.some((existing) => existing.slug === relatedRow.slug)) {
        related.push({ kind: relatedKind, slug: relatedRow.slug, title: this.graphLabelForNodeRow(relatedRow) });
      }
    }
    return {
      docId: doc.doc_id,
      kind: doc.kind,
      slug: doc.slug ?? nodeRow.slug,
      nodeId: nodeRow.id,
      title: this.graphLabelForNodeRow(nodeRow),
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
    let docRow = this.docRowTx(docId);
    let redirected = false;
    // A doc whose node merged resolves through the survivor's doc (and the
    // doc row lazily records the merge so the projection can render a stub).
    if (docRow?.node_id) {
      const nodeRow = this.db.prepare(`SELECT * FROM brain_nodes WHERE id = ?`).get(docRow.node_id) as GraphNodeRow | undefined;
      if (nodeRow?.status === "merged" && nodeRow.merged_into) {
        const survivor = this.resolveDocTargetNodeTx({ nodeId: nodeRow.merged_into });
        if (survivor) {
          const survivorKind = this.docKindForNodeRow(survivor.row)!;
          const survivorDocId = docIdFor(survivorKind, survivor.row.slug);
          if (survivorDocId !== docId) {
            this.db.prepare(`UPDATE brain_docs SET status = 'merged', merged_into = ? WHERE doc_id = ?`).run(survivorDocId, docId);
            const survivorDoc = await this.getBrainDoc(survivorDocId);
            if (survivorDoc) {
              return { ...survivorDoc, redirected: true };
            }
          }
        }
      }
    }
    if (!docRow) {
      // Candidate docs (no revision yet) still answer: resolve via the node.
      const resolved = this.resolveDocTargetNodeTx({ docId });
      if (!resolved) {
        return null;
      }
      redirected = resolved.redirected;
      const kind = this.docKindForNodeRow(resolved.row)!;
      const resolvedDocId = docIdFor(kind, resolved.row.slug);
      docRow = this.docRowTx(resolvedDocId);
      if (!docRow) {
        const dueness = this.docDuenessTx(
          {
            doc_id: resolvedDocId,
            kind,
            node_id: resolved.row.id,
            slug: resolved.row.slug,
            status: "active",
            merged_into: null,
            current_revision_id: null,
            last_rollup_at_ms: null,
            created_at_ms: Date.now()
          },
          resolved.row
        );
        return {
          doc: {
            docId: resolvedDocId,
            kind,
            nodeId: resolved.row.id,
            slug: resolved.row.slug,
            status: "active",
            mergedInto: null,
            currentRevisionId: null,
            lastRollupAtMs: null,
            createdAtMs: Date.now()
          },
          title: this.graphLabelForNodeRow(resolved.row),
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
    const nodeRow = docRow.node_id
      ? (this.db.prepare(`SELECT * FROM brain_nodes WHERE id = ?`).get(docRow.node_id) as GraphNodeRow | undefined)
      : undefined;
    const current = docRow.current_revision_id
      ? this.mapDocRevisionRow(this.db.prepare(`SELECT * FROM brain_doc_revisions WHERE id = ?`).get(docRow.current_revision_id) as DocRevisionRow)
      : null;
    const sections: BrainDocSectionView[] = [];
    let markdown: string | null = null;
    if (current && nodeRow) {
      const context = this.docRenderContextTx(docRow, nodeRow, current);
      markdown = renderDocMarkdown(context, current.sections);
      const messageStmt = this.db.prepare(
        `SELECT m.id AS messageId, ch.id AS chatId, m.timestamp_ms AS ts FROM messages m JOIN chats ch ON ch.id = m.chat_id WHERE m.source_message_key = ?`
      );
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
                  const message = messageStmt.get(key) as { messageId: number; chatId: number; ts: number | null } | undefined;
                  return {
                    sourceMessageKey: key,
                    chatId: message?.chatId ?? null,
                    messageId: message?.messageId ?? null,
                    timestampMs: message?.ts ?? null
                  };
                })
              };
            })
          });
        }
        sections.push({ title: section.title, statements });
      }
    }
    const historyRows = this.db
      .prepare(`SELECT * FROM brain_doc_revisions WHERE doc_id = ? ORDER BY revision DESC LIMIT 50`)
      .all(docRow.doc_id) as DocRevisionRow[];
    const history: BrainDocRevisionSummary[] = historyRows.map((row) => {
      const record = this.mapDocRevisionRow(row);
      const referenced = new Set<string>();
      for (const section of record.sections) {
        for (const statement of section.statements) {
          for (const claimId of statement.claimIds) {
            referenced.add(claimId);
          }
        }
      }
      return {
        id: record.id,
        revision: record.revision,
        status: record.status,
        statementCount: record.sections.reduce((sum, section) => sum + section.statements.length, 0),
        referencedClaimCount: referenced.size,
        fedClaimCount: record.fedClaimIds.length,
        dropCount: record.drops.length,
        drops: record.drops,
        resolutionCount: record.resolutionEventIds.length,
        errors: record.errors,
        model: record.model,
        effort: record.effort,
        runId: record.runId,
        promptVersion: record.promptVersion,
        createdAtMs: record.createdAtMs
      };
    });
    const dueness = nodeRow
      ? this.docDuenessTx(docRow, nodeRow)
      : { due: false, dueReasons: [] as BrainDocDueReason[], eligibleClaims: 0, newClaims: 0, openItems: 0 };
    return {
      doc: this.mapDocRow(docRow),
      title: nodeRow ? this.graphLabelForNodeRow(nodeRow) : docRow.slug ?? docRow.doc_id,
      redirected,
      current,
      sections,
      markdown,
      history,
      issues: await this.listBrainValidationIssues({ docId: docRow.doc_id, limit: 50 }),
      due: dueness.due,
      dueReasons: dueness.dueReasons,
      asOfMs: Date.now()
    };
  }

  // Everything the deterministic projector needs, for every projectable doc.
  async listBrainDocsForProjection(): Promise<Array<{ context: DocRenderContext; sections: BrainDocSection[] }>> {
    const out: Array<{ context: DocRenderContext; sections: BrainDocSection[] }> = [];
    const docRows = this.db.prepare(`SELECT * FROM brain_docs`).all() as BrainDocRow[];
    for (const docRow of docRows) {
      const nodeRow = docRow.node_id
        ? (this.db.prepare(`SELECT * FROM brain_nodes WHERE id = ?`).get(docRow.node_id) as GraphNodeRow | undefined)
        : undefined;
      if (!nodeRow) {
        continue;
      }
      const merged = nodeRow.status === "merged" || docRow.status === "merged";
      if (merged) {
        let mergedIntoDoc: DocRenderContext["mergedIntoDoc"] = null;
        const survivor = nodeRow.merged_into ? this.resolveDocTargetNodeTx({ nodeId: nodeRow.merged_into }) : null;
        if (survivor) {
          const survivorKind = this.docKindForNodeRow(survivor.row)!;
          mergedIntoDoc = { slug: survivor.row.slug, kind: survivorKind, title: this.graphLabelForNodeRow(survivor.row) };
        }
        out.push({
          context: {
            docId: docRow.doc_id,
            kind: docRow.kind,
            slug: docRow.slug ?? nodeRow.slug,
            nodeId: nodeRow.id,
            title: this.graphLabelForNodeRow(nodeRow),
            revision: 0,
            updatedAtMs: docRow.last_rollup_at_ms ?? docRow.created_at_ms,
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
      if (!docRow.current_revision_id) {
        continue;
      }
      const revision = this.mapDocRevisionRow(
        this.db.prepare(`SELECT * FROM brain_doc_revisions WHERE id = ?`).get(docRow.current_revision_id) as DocRevisionRow
      );
      out.push({ context: this.docRenderContextTx(docRow, nodeRow, revision), sections: revision.sections });
    }
    return out;
  }

  // Deterministic overview data — every field derivable, zero model calls.
  async getBrainOverviewData(): Promise<OverviewRenderData> {
    const backfill = await this.getBrainBackfillStats();
    const pending = Math.max(0, backfill.totalVisibleMessages - backfill.assimilatedVisibleMessages);
    const coveragePercent =
      backfill.totalVisibleMessages > 0
        ? Math.round(((backfill.totalVisibleMessages - pending) / backfill.totalVisibleMessages) * 1000) / 10
        : 100;
    const docs = await this.listBrainDocs({ limit: 10_000 });
    const lifecycle = await this.listBrainLifecycleItems({ status: "open", sort: "smart", limit: 6 });
    const topRows = this.db
      .prepare(
        `SELECT n.*, d.doc_id AS docId FROM brain_nodes n
         LEFT JOIN brain_docs d ON d.node_id = n.id
         WHERE n.status = 'active' AND n.kind IN ('person','topic','org','chat','project')
         ORDER BY n.salience DESC LIMIT 10`
      )
      .all() as Array<GraphNodeRow & { docId: string | null }>;
    const issues = await this.getBrainValidationIssueSummary();
    const latestRunRow = this.db
      .prepare(`SELECT kind, status, finished_at FROM brain_runs ORDER BY started_at DESC LIMIT 1`)
      .get() as { kind: string; status: string; finished_at: string | null } | undefined;
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
      soonestDue: lifecycle.items
        .slice(0, 6)
        .map((item) => ({ text: item.text, dueMs: item.dueMs, chatLabel: item.chatDisplayName })),
      topEntities: topRows.map((row) => {
        const kind = this.docKindForNodeRow(row) ?? "entity";
        return {
          title: this.graphLabelForNodeRow(row),
          kind,
          slug: row.slug,
          salience: Number(row.salience ?? 0),
          hasDoc: Boolean(row.docId)
        };
      }),
      issueCount: issues.error + issues.warning + issues.info,
      orphanedResolutions: Number(
        (this.db.prepare(`SELECT COUNT(*) AS n FROM brain_lifecycle_events WHERE orphaned_at_ms IS NOT NULL`).get() as { n: number }).n
      ),
      lastRunLine: latestRunRow ? `${latestRunRow.kind} ${latestRunRow.status}${latestRunRow.finished_at ? ` at ${latestRunRow.finished_at}` : ""}` : null,
      providerLine: null
    };
  }

  // === Two-level person model =============================================
  // Identities (canonical JIDs) are immutable anchors; a person is an editable
  // membership over them. Every method here touches only the person tables —
  // episodes, claims, citations, and archive rows are structurally out of
  // reach, which is what makes connect/disconnect metadata-only forever.

  private personPair(jidA: string, jidB: string): [string, string] {
    return jidA < jidB ? [jidA, jidB] : [jidB, jidA];
  }

  private recordPersonEventTx(
    action: PersonLinkEventRecord["action"],
    fields: { personId?: string | null; identityJid?: string | null; source?: string | null; evidence?: Record<string, unknown> | null }
  ): void {
    this.db
      .prepare(`INSERT INTO person_link_events (action, person_id, identity_jid, source, evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(action, fields.personId ?? null, fields.identityJid ?? null, fields.source ?? null, fields.evidence ? JSON.stringify(fields.evidence) : null, currentIso());
  }

  private personMembershipTx(jid: string): { personId: string } | undefined {
    return this.db.prepare(`SELECT person_id AS personId FROM person_members WHERE identity_jid = ?`).get(jid) as { personId: string } | undefined;
  }

  private supersedePendingSuggestionsTx(jidLow: string, jidHigh: string): void {
    this.db
      .prepare(`UPDATE person_suggestions SET status = 'superseded', updated_at = ? WHERE jid_low = ? AND jid_high = ? AND status = 'pending'`)
      .run(currentIso(), jidLow, jidHigh);
  }

  // Union two persons revealed to share an identity. Deterministic survivor:
  // more members, then older created_at, then smaller id. Memberships keep
  // their original provenance; the dissolved id stays resolvable via redirect.
  private unionPersonsTx(personIdA: string, personIdB: string, evidence: Record<string, unknown>): string {
    const stats = this.db
      .prepare(
        `SELECT p.id AS id, p.created_at AS createdAt, COUNT(m.identity_jid) AS members
         FROM persons p LEFT JOIN person_members m ON m.person_id = p.id
         WHERE p.id IN (?, ?) GROUP BY p.id`
      )
      .all(personIdA, personIdB) as Array<{ id: string; createdAt: string; members: number }>;
    const [survivor, dissolved] = [...stats].sort(
      (a, b) => b.members - a.members || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
    );
    this.db.prepare(`UPDATE person_members SET person_id = ? WHERE person_id = ?`).run(survivor.id, dissolved.id);
    this.db.prepare(`DELETE FROM persons WHERE id = ?`).run(dissolved.id);
    this.db
      .prepare(`INSERT OR REPLACE INTO person_redirects (person_id, replaced_by_person_id, surviving_jid, created_at) VALUES (?, ?, NULL, ?)`)
      .run(dissolved.id, survivor.id, currentIso());
    this.db.prepare(`UPDATE persons SET updated_at = ? WHERE id = ?`).run(currentIso(), survivor.id);
    this.recordPersonEventTx("union", { personId: survivor.id, evidence: { ...evidence, dissolvedPersonId: dissolved.id } });
    return survivor.id;
  }

  // Synchronous core shared by the public method, suggestion acceptance, and
  // the merge-path union. Runs inside the caller's transaction.
  private connectIdentitiesTx(
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
    const suppressed = this.db
      .prepare(`SELECT reason FROM person_link_suppressions WHERE jid_low = ? AND jid_high = ?`)
      .get(low, high) as { reason: string } | undefined;
    if (suppressed) {
      if (source !== "user") {
        return { outcome: "suppressed", personId: null };
      }
      // An explicit human connect outranks past dismissals.
      this.db.prepare(`DELETE FROM person_link_suppressions WHERE jid_low = ? AND jid_high = ?`).run(low, high);
    }
    const memberA = this.personMembershipTx(a);
    const memberB = this.personMembershipTx(b);
    const now = currentIso();
    const insertMember = this.db.prepare(
      `INSERT INTO person_members (person_id, identity_jid, source, evidence_json, linked_at) VALUES (?, ?, ?, ?, ?)`
    );
    const evidenceJson = evidence ? JSON.stringify(evidence) : null;
    if (memberA && memberB) {
      if (memberA.personId === memberB.personId) {
        return { outcome: "already_connected", personId: memberA.personId };
      }
      const survivorId = this.unionPersonsTx(memberA.personId, memberB.personId, { viaJids: [a, b], source, ...(evidence ?? {}) });
      this.supersedePendingSuggestionsTx(low, high);
      return { outcome: "union", personId: survivorId };
    }
    if (memberA || memberB) {
      const personId = (memberA ?? memberB)!.personId;
      const newJid = memberA ? b : a;
      insertMember.run(personId, newJid, source, evidenceJson, now);
      this.db.prepare(`UPDATE persons SET updated_at = ? WHERE id = ?`).run(now, personId);
      this.recordPersonEventTx("connect", { personId, identityJid: newJid, source, evidence });
      this.supersedePendingSuggestionsTx(low, high);
      return { outcome: "connected", personId };
    }
    const personId = `person_${randomUUID()}`;
    this.db.prepare(`INSERT INTO persons (id, created_at, updated_at) VALUES (?, ?, ?)`).run(personId, now, now);
    insertMember.run(personId, a, source, evidenceJson, now);
    insertMember.run(personId, b, source, evidenceJson, now);
    this.recordPersonEventTx("connect", { personId, identityJid: a, source, evidence });
    this.recordPersonEventTx("connect", { personId, identityJid: b, source, evidence });
    this.supersedePendingSuggestionsTx(low, high);
    return { outcome: "connected", personId };
  }

  async connectIdentities(
    jidA: string,
    jidB: string,
    source: PersonMemberSource,
    evidence: Record<string, unknown> | null = null
  ): Promise<PersonConnectResult> {
    this.assertWritableIdentityVersion();
    return this.db.transaction(() => this.connectIdentitiesTx(jidA, jidB, source, evidence))();
  }

  async disconnectIdentities(identityJid: string): Promise<PersonDisconnectResult> {
    this.assertWritableIdentityVersion();
    return this.db.transaction((): PersonDisconnectResult => {
      const jid = this.canonicalJid(identityJid) ?? identityJid;
      const membership = this.personMembershipTx(jid);
      if (!membership) {
        return { disconnected: false, personId: null, dissolved: false };
      }
      const personId = membership.personId;
      const others = (
        this.db.prepare(`SELECT identity_jid AS jid FROM person_members WHERE person_id = ? AND identity_jid != ?`).all(personId, jid) as Array<{ jid: string }>
      ).map((row) => row.jid);
      const now = currentIso();
      this.db.prepare(`DELETE FROM person_members WHERE identity_jid = ?`).run(jid);
      // A severed pair must never be silently re-applied by an auto source.
      const insertSuppression = this.db.prepare(
        `INSERT OR REPLACE INTO person_link_suppressions (jid_low, jid_high, reason, created_at) VALUES (?, ?, 'disconnected', ?)`
      );
      for (const other of others) {
        const [low, high] = this.personPair(jid, other);
        insertSuppression.run(low, high, now);
      }
      this.recordPersonEventTx("disconnect", { personId, identityJid: jid });
      if (others.length < 2) {
        this.db.prepare(`DELETE FROM person_members WHERE person_id = ?`).run(personId);
        this.db.prepare(`DELETE FROM persons WHERE id = ?`).run(personId);
        this.db
          .prepare(`INSERT OR REPLACE INTO person_redirects (person_id, replaced_by_person_id, surviving_jid, created_at) VALUES (?, NULL, ?, ?)`)
          .run(personId, others[0] ?? null, now);
        this.recordPersonEventTx("dissolve", { personId, identityJid: others[0] ?? null });
        return { disconnected: true, personId, dissolved: true };
      }
      this.db.prepare(`UPDATE persons SET updated_at = ? WHERE id = ?`).run(now, personId);
      return { disconnected: true, personId, dissolved: false };
    })();
  }

  // Person-layer reconciliation for the archive-layer LID→PN collapse: rewrite
  // memberships, re-normalize pair rows (dropping self-referential ones), and
  // union persons the collapse reveals to share an identity. Runs inside the
  // mergeIdentity transaction.
  private rewritePersonLayerForMergeTx(lid: string, pn: string): void {
    const lidMember = this.personMembershipTx(lid);
    const pnMember = this.personMembershipTx(pn);
    if (lidMember && pnMember) {
      if (lidMember.personId !== pnMember.personId) {
        this.unionPersonsTx(lidMember.personId, pnMember.personId, { viaJids: [lid, pn], source: "identity_merge" });
      }
      // Same WhatsApp identity: the LID membership row is now redundant.
      this.db.prepare(`DELETE FROM person_members WHERE identity_jid = ?`).run(lid);
    } else if (lidMember) {
      this.db.prepare(`UPDATE person_members SET identity_jid = ? WHERE identity_jid = ?`).run(pn, lid);
    }
    // Suggestions: substitute the JID, re-normalize pair order, drop rows that
    // become self-referential, and collapse duplicates onto the strongest
    // status (a rejection is memory and must survive the merge).
    const statusRank: Record<string, number> = { rejected: 3, accepted: 2, superseded: 1, pending: 0 };
    const suggestionRows = this.db
      .prepare(`SELECT id, jid_low, jid_high, kind, score, status FROM person_suggestions WHERE jid_low = ? OR jid_high = ?`)
      .all(lid, lid) as Array<{ id: string; jid_low: string; jid_high: string; kind: string; score: number; status: string }>;
    for (const row of suggestionRows) {
      const nextA = row.jid_low === lid ? pn : row.jid_low;
      const nextB = row.jid_high === lid ? pn : row.jid_high;
      if (nextA === nextB) {
        this.db.prepare(`DELETE FROM person_suggestions WHERE id = ?`).run(row.id);
        continue;
      }
      const [low, high] = this.personPair(nextA, nextB);
      const existing = this.db
        .prepare(`SELECT id, score, status FROM person_suggestions WHERE jid_low = ? AND jid_high = ? AND kind = ? AND id != ?`)
        .get(low, high, row.kind, row.id) as { id: string; score: number; status: string } | undefined;
      if (existing) {
        const keepExisting = (statusRank[existing.status] ?? 0) >= (statusRank[row.status] ?? 0);
        const survivorId = keepExisting ? existing.id : row.id;
        const loserId = keepExisting ? row.id : existing.id;
        this.db.prepare(`DELETE FROM person_suggestions WHERE id = ?`).run(loserId);
        this.db
          .prepare(`UPDATE person_suggestions SET jid_low = ?, jid_high = ?, score = MAX(score, ?), updated_at = ? WHERE id = ?`)
          .run(low, high, Math.max(existing.score, row.score), currentIso(), survivorId);
      } else {
        this.db.prepare(`UPDATE person_suggestions SET jid_low = ?, jid_high = ?, updated_at = ? WHERE id = ?`).run(low, high, currentIso(), row.id);
      }
    }
    // Suppressions: same re-normalization; INSERT OR IGNORE collapses duplicates.
    const suppressionRows = this.db
      .prepare(`SELECT jid_low, jid_high, reason, created_at FROM person_link_suppressions WHERE jid_low = ? OR jid_high = ?`)
      .all(lid, lid) as Array<{ jid_low: string; jid_high: string; reason: string; created_at: string }>;
    for (const row of suppressionRows) {
      this.db.prepare(`DELETE FROM person_link_suppressions WHERE jid_low = ? AND jid_high = ?`).run(row.jid_low, row.jid_high);
      const nextA = row.jid_low === lid ? pn : row.jid_low;
      const nextB = row.jid_high === lid ? pn : row.jid_high;
      if (nextA === nextB) {
        continue;
      }
      const [low, high] = this.personPair(nextA, nextB);
      this.db
        .prepare(`INSERT OR IGNORE INTO person_link_suppressions (jid_low, jid_high, reason, created_at) VALUES (?, ?, ?, ?)`)
        .run(low, high, row.reason, row.created_at);
    }
    this.db.prepare(`UPDATE person_link_events SET identity_jid = ? WHERE identity_jid = ?`).run(pn, lid);
  }

  private buildPersonRecords(personIds: string[]): PersonRecord[] {
    if (personIds.length === 0) {
      return [];
    }
    const placeholders = personIds.map(() => "?").join(",");
    const personRows = this.db
      .prepare(`SELECT id, created_at AS createdAt, updated_at AS updatedAt FROM persons WHERE id IN (${placeholders})`)
      .all(...personIds) as Array<{ id: string; createdAt: string; updatedAt: string }>;
    const memberRows = this.db
      .prepare(
        `SELECT m.person_id AS personId, m.identity_jid AS jid, m.source AS source, m.evidence_json AS evidenceJson, m.linked_at AS linkedAt,
                c.display_name AS displayName, c.push_name AS pushName, c.phone_number AS phoneNumber,
                (SELECT COUNT(*) FROM messages msg WHERE msg.sender_source_jid = m.identity_jid) AS messageCount
         FROM person_members m
         LEFT JOIN contacts c ON c.source_jid = m.identity_jid
         WHERE m.person_id IN (${placeholders})
         ORDER BY m.linked_at, m.identity_jid`
      )
      .all(...personIds) as Array<{
      personId: string;
      jid: string;
      source: PersonMemberSource;
      evidenceJson: string | null;
      linkedAt: string;
      displayName: string | null;
      pushName: string | null;
      phoneNumber: string | null;
      messageCount: number;
    }>;
    const membersByPerson = new Map<string, PersonMemberRecord[]>();
    for (const row of memberRows) {
      const hasSavedName = Boolean(
        row.displayName?.trim() && !isMaskedNumberLabel(row.displayName) && !isIdentityDerivedName(row.displayName, row.jid)
      );
      const record: PersonMemberRecord = {
        identityJid: row.jid,
        source: row.source,
        evidence: row.evidenceJson ? (JSON.parse(row.evidenceJson) as Record<string, unknown>) : null,
        linkedAt: row.linkedAt,
        displayLabel: resolveDisplayLabel({ displayName: row.displayName, pushName: row.pushName, phoneNumber: row.phoneNumber, jid: row.jid }),
        phoneNumber: row.phoneNumber ?? phoneFromJid(row.jid),
        messageCount: Number(row.messageCount ?? 0),
        hasSavedName
      };
      membersByPerson.set(row.personId, [...(membersByPerson.get(row.personId) ?? []), record]);
    }
    return personRows.map((person) => {
      const members = membersByPerson.get(person.id) ?? [];
      return {
        id: person.id,
        displayLabel: personDisplayLabelFromMembers(members),
        members,
        unconfirmedHint: this.personUnconfirmedHint(members),
        createdAt: person.createdAt,
        updatedAt: person.updatedAt
      };
    });
  }

  // Display-level only: a high-confidence pending suggestion involving any
  // member surfaces as an annotation. Structurally invisible to evidence
  // packs, prompts, and search — those paths never read the suggestion table.
  private personUnconfirmedHint(members: PersonMemberRecord[]): string | null {
    if (members.length === 0) {
      return null;
    }
    const memberJids = new Set(members.map((member) => member.identityJid));
    const placeholders = members.map(() => "?").join(",");
    const row = this.db
      .prepare(
        `SELECT jid_low AS jidLow, jid_high AS jidHigh, score FROM person_suggestions
         WHERE status = 'pending' AND score >= ? AND (jid_low IN (${placeholders}) OR jid_high IN (${placeholders}))
         ORDER BY score DESC LIMIT 1`
      )
      .get(config.persons.hintScoreThreshold, ...members.map((m) => m.identityJid), ...members.map((m) => m.identityJid)) as
      | { jidLow: string; jidHigh: string; score: number }
      | undefined;
    if (!row) {
      return null;
    }
    const otherJid = memberJids.has(row.jidLow) ? row.jidHigh : row.jidLow;
    return `possibly the same as ${this.labelForJid(otherJid)} — unconfirmed`;
  }

  private labelForJid(jid: string): string {
    const contact = this.db
      .prepare(`SELECT display_name AS displayName, push_name AS pushName, phone_number AS phoneNumber FROM contacts WHERE source_jid = ?`)
      .get(jid) as { displayName: string | null; pushName: string | null; phoneNumber: string | null } | undefined;
    return (
      resolveDisplayLabel({
        displayName: contact?.displayName ?? null,
        pushName: contact?.pushName ?? null,
        phoneNumber: contact?.phoneNumber ?? null,
        jid
      }) ?? jid
    );
  }

  async resolvePersonForJid(jid: string): Promise<PersonRecord | null> {
    const canonical = this.canonicalJid(jid) ?? jid;
    const membership = this.personMembershipTx(canonical);
    if (!membership) {
      return null;
    }
    return this.buildPersonRecords([membership.personId])[0] ?? null;
  }

  async listPersons(options: { limit?: number } = {}): Promise<PersonRecord[]> {
    const limit = Math.max(1, options.limit ?? 200);
    const ids = (
      this.db.prepare(`SELECT id FROM persons ORDER BY updated_at DESC, id LIMIT ?`).all(limit) as Array<{ id: string }>
    ).map((row) => row.id);
    return this.buildPersonRecords(ids);
  }

  async getPerson(personId: string): Promise<PersonLookupResult> {
    const person = this.buildPersonRecords([personId])[0] ?? null;
    if (person) {
      return { person, redirect: null };
    }
    // Follow redirect chains (union of a union) to the terminal record.
    let redirect: PersonRedirectRecord | null = null;
    let cursor = personId;
    for (let hops = 0; hops < 10; hops += 1) {
      const row = this.db
        .prepare(
          `SELECT person_id AS personId, replaced_by_person_id AS replacedByPersonId, surviving_jid AS survivingJid, created_at AS createdAt
           FROM person_redirects WHERE person_id = ?`
        )
        .get(cursor) as PersonRedirectRecord | undefined;
      if (!row) {
        break;
      }
      redirect = row;
      if (!row.replacedByPersonId) {
        break;
      }
      const target = this.buildPersonRecords([row.replacedByPersonId])[0] ?? null;
      if (target) {
        return { person: target, redirect: row };
      }
      cursor = row.replacedByPersonId;
    }
    return { person: null, redirect };
  }

  async personKeyForJids(jids: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const canonicalByInput = new Map<string, string>();
    for (const jid of jids) {
      if (!jid) {
        continue;
      }
      canonicalByInput.set(jid, this.canonicalJid(jid) ?? jid);
      result.set(jid, canonicalByInput.get(jid)!);
    }
    const canonical = [...new Set(canonicalByInput.values())];
    for (let index = 0; index < canonical.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = canonical.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT identity_jid AS jid, person_id AS personId FROM person_members WHERE identity_jid IN (${placeholders})`)
        .all(...batch) as Array<{ jid: string; personId: string }>;
      const byJid = new Map(rows.map((row) => [row.jid, row.personId]));
      for (const [input, canonicalJid] of canonicalByInput) {
        const personId = byJid.get(canonicalJid);
        if (personId) {
          result.set(input, personId);
        }
      }
    }
    return result;
  }

  async upsertPersonSuggestions(suggestions: PersonSuggestionInput[]): Promise<{ created: number; updated: number }> {
    this.assertWritableIdentityVersion();
    let created = 0;
    let updated = 0;
    this.db.transaction(() => {
      for (const suggestion of suggestions) {
        const a = this.canonicalJid(suggestion.jidA);
        const b = this.canonicalJid(suggestion.jidB);
        if (!a || !b || a === b) {
          continue;
        }
        const [low, high] = this.personPair(a, b);
        const suppressed = this.db.prepare(`SELECT 1 FROM person_link_suppressions WHERE jid_low = ? AND jid_high = ?`).get(low, high);
        if (suppressed) {
          continue;
        }
        const memberA = this.personMembershipTx(a);
        const memberB = this.personMembershipTx(b);
        if (memberA && memberB && memberA.personId === memberB.personId) {
          continue;
        }
        const existing = this.db
          .prepare(`SELECT id, score, evidence_json AS evidenceJson, status FROM person_suggestions WHERE jid_low = ? AND jid_high = ? AND kind = ?`)
          .get(low, high, suggestion.kind) as { id: string; score: number; evidenceJson: string; status: string } | undefined;
        const evidenceJson = JSON.stringify(suggestion.evidence ?? {});
        if (existing) {
          // Rejected is memory and accepted is history: never resurrected by a
          // detector re-run. Superseded means "no longer applicable at the
          // time" (pruned low-value pair, a connect's cleanup, a retired
          // detector) — when a detector produces the pair afresh, the evidence
          // is current again, so it returns to pending.
          if (existing.status === "rejected" || existing.status === "accepted") {
            continue;
          }
          if (existing.status === "superseded") {
            this.db
              .prepare(`UPDATE person_suggestions SET status = 'pending', score = ?, evidence_json = ?, updated_at = ? WHERE id = ?`)
              .run(suggestion.score, evidenceJson, currentIso(), existing.id);
            created += 1;
            continue;
          }
          if (existing.score !== suggestion.score || existing.evidenceJson !== evidenceJson) {
            this.db
              .prepare(`UPDATE person_suggestions SET score = ?, evidence_json = ?, updated_at = ? WHERE id = ?`)
              .run(suggestion.score, evidenceJson, currentIso(), existing.id);
            updated += 1;
          }
          continue;
        }
        const id = `psg_${randomUUID()}`;
        this.db
          .prepare(
            `INSERT INTO person_suggestions (id, jid_low, jid_high, kind, score, evidence_json, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
          )
          .run(id, low, high, suggestion.kind, suggestion.score, evidenceJson, currentIso(), currentIso());
        this.recordPersonEventTx("suggest", { evidence: { suggestionId: id, jidLow: low, jidHigh: high, kind: suggestion.kind, score: suggestion.score } });
        created += 1;
      }
    })();
    return { created, updated };
  }

  async listPersonSuggestions(
    options: { status?: PersonSuggestionStatus; jid?: string; minScore?: number; limit?: number } = {}
  ): Promise<PersonSuggestionRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.status) {
      clauses.push(`status = ?`);
      params.push(options.status);
    }
    if (options.jid) {
      const canonical = this.canonicalJid(options.jid) ?? options.jid;
      clauses.push(`(jid_low = ? OR jid_high = ?)`);
      params.push(canonical, canonical);
    }
    if (options.minScore != null) {
      clauses.push(`score >= ?`);
      params.push(options.minScore);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT id, jid_low AS jidLow, jid_high AS jidHigh, kind, score, evidence_json AS evidenceJson, status,
                created_at AS createdAt, updated_at AS updatedAt
         FROM person_suggestions ${where}
         ORDER BY score DESC, updated_at DESC LIMIT ?`
      )
      .all(...params, Math.max(1, options.limit ?? 100)) as Array<{
      id: string;
      jidLow: string;
      jidHigh: string;
      kind: PersonSuggestionKind;
      score: number;
      evidenceJson: string;
      status: PersonSuggestionStatus;
      createdAt: string;
      updatedAt: string;
    }>;
    // Decision context, resolved at read time: complete numbers, each
    // identity's DM chat id (one click to eyeball the conversation), and
    // display labels for chat/group ids the evidence references.
    const findPhone = this.db.prepare(`SELECT phone_number AS phone FROM contacts WHERE source_jid = ?`);
    const findDmChat = this.db.prepare(`SELECT id FROM chats WHERE source_chat_id = ?`);
    const findChatLabel = this.db.prepare(`SELECT NULLIF(TRIM(COALESCE(display_name, '')), '') AS label FROM chats WHERE source_chat_id = ?`);
    const countMessages = this.db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE sender_source_jid = ?`);
    const countMentions = this.db.prepare(`SELECT COUNT(*) AS count FROM message_mentions WHERE mentioned_jid = ?`);
    const countGroups = this.db.prepare(
      `SELECT COUNT(*) AS count FROM chat_participants cp JOIN chats c ON c.id = cp.chat_id WHERE cp.source_jid = ? AND c.chat_type = 'group'`
    );
    const phoneFor = (jid: string): string | null =>
      ((findPhone.get(jid) as { phone: string | null } | undefined)?.phone ?? phoneFromJid(jid)) || null;
    const dmChatIdFor = (jid: string): number | null => {
      const chat = findDmChat.get(jid) as { id: number } | undefined;
      return chat ? Number(chat.id) : null;
    };
    const cached = (statement: import("better-sqlite3").Statement) => {
      const cache = new Map<string, number>();
      return (jid: string): number => {
        const hit = cache.get(jid);
        if (hit != null) return hit;
        const count = Number((statement.get(jid) as { count: number }).count);
        cache.set(jid, count);
        return count;
      };
    };
    const messagesFor = cached(countMessages);
    const mentionsFor = cached(countMentions);
    const groupsFor = cached(countGroups);
    return rows.map((row) => {
      const evidence = JSON.parse(row.evidenceJson) as Record<string, unknown>;
      const chatLabels: Record<string, string> = {};
      for (const key of ["sharedChats", "sharedGroups", "membershipHandoffGroups"]) {
        const ids = evidence[key];
        if (!Array.isArray(ids)) continue;
        for (const id of ids) {
          if (typeof id === "string" && !(id in chatLabels)) {
            const label = (findChatLabel.get(id) as { label: string | null } | undefined)?.label;
            if (label) {
              chatLabels[id] = label;
            }
          }
        }
      }
      return {
        id: row.id,
        jidLow: row.jidLow,
        jidHigh: row.jidHigh,
        kind: row.kind,
        score: row.score,
        evidence,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        lowLabel: this.labelForJid(row.jidLow),
        highLabel: this.labelForJid(row.jidHigh),
        lowPhone: phoneFor(row.jidLow),
        highPhone: phoneFor(row.jidHigh),
        lowChatId: dmChatIdFor(row.jidLow),
        highChatId: dmChatIdFor(row.jidHigh),
        lowMessageCount: messagesFor(row.jidLow),
        highMessageCount: messagesFor(row.jidHigh),
        lowMentionCount: mentionsFor(row.jidLow),
        highMentionCount: mentionsFor(row.jidHigh),
        lowGroupCount: groupsFor(row.jidLow),
        highGroupCount: groupsFor(row.jidHigh),
        chatLabels
      };
    });
  }

  // A sender's recent visible messages across every chat (groups included):
  // the compare dialog's activity view for identities without a direct chat.
  async listRecentMessagesBySender(jid: string, limit = 20): Promise<IdentityRecentMessage[]> {
    const canonical = this.canonicalJid(jid) ?? jid;
    const rows = this.db
      .prepare(
        `SELECT m.timestamp_ms AS timestampMs, m.direction, m.message_type AS messageType, m.body, m.caption,
                c.id AS chatId, c.source_chat_id AS chatSourceId, c.chat_type AS chatType,
                NULLIF(TRIM(COALESCE(c.display_name, '')), '') AS chatLabel
         FROM messages m JOIN chats c ON c.id = m.chat_id
         WHERE m.sender_source_jid = ? AND ${visibleExchangePredicate("m")}
         ORDER BY m.timestamp_ms DESC, m.id DESC LIMIT ?`
      )
      .all(canonical, Math.max(1, limit)) as Array<{
      timestampMs: number | null;
      direction: string;
      messageType: string;
      body: string | null;
      caption: string | null;
      chatId: number;
      chatSourceId: string;
      chatType: string;
      chatLabel: string | null;
    }>;
    return rows.map((row) => ({
      chatId: Number(row.chatId),
      chatSourceId: row.chatSourceId,
      chatLabel: row.chatLabel && row.chatLabel !== row.chatSourceId ? row.chatLabel : displayPhoneFromJid(row.chatSourceId),
      chatType: row.chatType as IdentityRecentMessage["chatType"],
      timestampMs: row.timestampMs == null ? null : Number(row.timestampMs),
      direction: row.direction as IdentityRecentMessage["direction"],
      messageType: row.messageType,
      text: row.body?.trim() || row.caption?.trim() || null
    }));
  }

  // Display labels for chat source ids (null when unresolved).
  async getChatLabels(sourceChatIds: string[]): Promise<Map<string, string | null>> {
    const labels = new Map<string, string | null>();
    const unique = [...new Set(sourceChatIds.filter(Boolean))];
    for (let index = 0; index < unique.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = unique.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const rows = this.db
        .prepare(
          `SELECT source_chat_id AS id, NULLIF(TRIM(COALESCE(display_name, '')), '') AS label FROM chats WHERE source_chat_id IN (${batch.map(() => "?").join(",")})`
        )
        .all(...batch) as Array<{ id: string; label: string | null }>;
      for (const row of rows) {
        labels.set(row.id, row.label && row.label !== row.id ? row.label : displayPhoneFromJid(row.id));
      }
    }
    for (const id of unique) {
      if (!labels.has(id)) labels.set(id, null);
    }
    return labels;
  }

  // A sender's recent already-stored media for the compare dialog's strips —
  // ids and labels only, never bytes.
  async listRecentMediaBySender(jid: string, limit = 8): Promise<IdentityRecentMedia[]> {
    const canonical = this.canonicalJid(jid) ?? jid;
    const rows = this.db
      .prepare(
        `SELECT m.id AS messageId, a.id AS assetId, a.mime_type AS mimeType,
                (a.thumbnail IS NOT NULL) AS hasThumbnail, m.timestamp_ms AS timestampMs,
                NULLIF(TRIM(COALESCE(c.display_name, '')), '') AS chatLabel, c.source_chat_id AS chatSourceId
         FROM media_assets a
         JOIN messages m ON m.source_message_key = a.message_key
         JOIN chats c ON c.id = m.chat_id
         WHERE m.sender_source_jid = ?
         ORDER BY m.timestamp_ms DESC, m.id DESC LIMIT ?`
      )
      .all(canonical, Math.max(1, limit)) as Array<{
      messageId: number;
      assetId: number;
      mimeType: string | null;
      hasThumbnail: number;
      timestampMs: number | null;
      chatLabel: string | null;
      chatSourceId: string;
    }>;
    return rows.map((row) => ({
      messageId: Number(row.messageId),
      assetId: Number(row.assetId),
      mimeType: row.mimeType,
      hasThumbnail: Boolean(row.hasThumbnail),
      timestampMs: row.timestampMs == null ? null : Number(row.timestampMs),
      chatLabel: row.chatLabel && row.chatLabel !== row.chatSourceId ? row.chatLabel : displayPhoneFromJid(row.chatSourceId)
    }));
  }

  // Retire a detector kind's pending queue (rejected/accepted history stays).
  async supersedePersonSuggestionsByKind(kind: PersonSuggestionKind): Promise<number> {
    const result = this.db
      .prepare(`UPDATE person_suggestions SET status = 'superseded', updated_at = ? WHERE kind = ? AND status = 'pending'`)
      .run(currentIso(), kind);
    return result.changes;
  }

  // Human-only dismissal undo: every rejected row for the pair returns to
  // pending (score/evidence kept) and the undo is audited. Detectors continue
  // to never resurrect rejections themselves — this route is the only way back.
  async unrejectPersonSuggestions(jidLowInput: string, jidHighInput: string): Promise<number> {
    this.assertWritableIdentityVersion();
    const a = this.canonicalJid(jidLowInput) ?? jidLowInput;
    const b = this.canonicalJid(jidHighInput) ?? jidHighInput;
    const [low, high] = this.personPair(a, b);
    let restored = 0;
    this.db.transaction(() => {
      restored = this.db
        .prepare(`UPDATE person_suggestions SET status = 'pending', updated_at = ? WHERE jid_low = ? AND jid_high = ? AND status = 'rejected'`)
        .run(currentIso(), low, high).changes;
      if (restored > 0) {
        this.recordPersonEventTx("unreject", { evidence: { jidLow: low, jidHigh: high, restored } });
      }
    })();
    return restored;
  }

  // Prune specific pending rows (e.g. pairs whose merge value dropped to
  // nothing). Superseded rows return to pending if a detector later produces
  // the pair afresh.
  async supersedePersonSuggestionsByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    let changed = 0;
    const update = this.db.prepare(`UPDATE person_suggestions SET status = 'superseded', updated_at = ? WHERE id = ? AND status = 'pending'`);
    this.db.transaction(() => {
      for (const id of ids) {
        changed += update.run(currentIso(), id).changes;
      }
    })();
    return changed;
  }

  async acceptPersonSuggestion(suggestionId: string): Promise<PersonConnectResult> {
    this.assertWritableIdentityVersion();
    return this.db.transaction((): PersonConnectResult => {
      const suggestion = this.db
        .prepare(`SELECT id, jid_low AS jidLow, jid_high AS jidHigh, kind, status FROM person_suggestions WHERE id = ?`)
        .get(suggestionId) as { id: string; jidLow: string; jidHigh: string; kind: PersonSuggestionKind; status: string } | undefined;
      if (!suggestion || suggestion.status !== "pending") {
        throw new PublicError("PERSON_SUGGESTION_STATE", "The suggestion no longer exists or was already resolved.");
      }
      // Mark accepted before connecting so the connect's supersede pass (which
      // only touches pending rows) leaves the acceptance record intact.
      this.db.prepare(`UPDATE person_suggestions SET status = 'accepted', updated_at = ? WHERE id = ?`).run(currentIso(), suggestion.id);
      this.recordPersonEventTx("accept", { evidence: { suggestionId: suggestion.id, kind: suggestion.kind } });
      // The human clicked: membership provenance is 'user', with the accepted
      // suggestion carried as evidence.
      return this.connectIdentitiesTx(suggestion.jidLow, suggestion.jidHigh, "user", { suggestionId: suggestion.id, kind: suggestion.kind });
    })();
  }

  async rejectPersonSuggestion(suggestionId: string): Promise<boolean> {
    this.assertWritableIdentityVersion();
    return this.db.transaction((): boolean => {
      const suggestion = this.db
        .prepare(`SELECT id, kind, status FROM person_suggestions WHERE id = ?`)
        .get(suggestionId) as { id: string; kind: string; status: string } | undefined;
      if (!suggestion || suggestion.status !== "pending") {
        return false;
      }
      // The rejected row itself is the rejection memory: the UNIQUE(pair, kind)
      // slot stays occupied, so the detector's upsert can never resurrect it.
      this.db.prepare(`UPDATE person_suggestions SET status = 'rejected', updated_at = ? WHERE id = ?`).run(currentIso(), suggestion.id);
      this.recordPersonEventTx("reject", { evidence: { suggestionId: suggestion.id, kind: suggestion.kind } });
      return true;
    })();
  }

  async listPersonLinkSuppressions(limit = 200): Promise<PersonLinkSuppressionRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT jid_low AS jidLow, jid_high AS jidHigh, reason, created_at AS createdAt
         FROM person_link_suppressions ORDER BY created_at DESC LIMIT ?`
      )
      .all(Math.max(1, limit)) as PersonLinkSuppressionRecord[];
    const findPhone = this.db.prepare(`SELECT phone_number AS phone FROM contacts WHERE source_jid = ?`);
    const phoneFor = (jid: string): string | null =>
      ((findPhone.get(jid) as { phone: string | null } | undefined)?.phone ?? phoneFromJid(jid)) || null;
    return rows.map((row) => ({
      ...row,
      lowLabel: this.labelForJid(row.jidLow),
      highLabel: this.labelForJid(row.jidHigh),
      lowPhone: phoneFor(row.jidLow),
      highPhone: phoneFor(row.jidHigh)
    }));
  }

  // Release a block: delete the suppression row only, so auto-connect and the
  // detectors may re-evaluate the pair on their next pass. Nothing connects
  // here — release is "let the system consider it again", not a connect.
  async releasePersonLinkSuppression(jidA: string, jidB: string): Promise<boolean> {
    this.assertWritableIdentityVersion();
    const a = this.canonicalJid(jidA) ?? jidA;
    const b = this.canonicalJid(jidB) ?? jidB;
    const [low, high] = this.personPair(a, b);
    let released = false;
    this.db.transaction(() => {
      released = this.db.prepare(`DELETE FROM person_link_suppressions WHERE jid_low = ? AND jid_high = ?`).run(low, high).changes > 0;
      if (released) {
        this.recordPersonEventTx("release", { evidence: { jidLow: low, jidHigh: high } });
      }
    })();
    return released;
  }

  async listPersonLinkEvents(options: { limit?: number } = {}): Promise<PersonLinkEventRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT id, action, person_id AS personId, identity_jid AS identityJid, source, evidence_json AS evidenceJson, created_at AS createdAt
         FROM person_link_events ORDER BY id DESC LIMIT ?`
      )
      .all(Math.max(1, options.limit ?? 200)) as Array<{
      id: number;
      action: PersonLinkEventRecord["action"];
      personId: string | null;
      identityJid: string | null;
      source: string | null;
      evidenceJson: string | null;
      createdAt: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      personId: row.personId,
      identityJid: row.identityJid,
      source: row.source,
      evidence: row.evidenceJson ? (JSON.parse(row.evidenceJson) as Record<string, unknown>) : null,
      createdAt: row.createdAt
    }));
  }

  async replaceGoogleContactGroups(groups: GoogleContactGroupEntry[]): Promise<{ groups: number; numbers: number }> {
    this.assertWritableIdentityVersion();
    const resources = new Set<string>();
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM google_contact_groups`).run();
      const insert = this.db.prepare(
        `INSERT OR REPLACE INTO google_contact_groups (resource_name, phone_e164, display_name, last_seen_at) VALUES (?, ?, ?, ?)`
      );
      const now = currentIso();
      for (const group of groups) {
        if (!group.resourceName || !group.phoneE164) {
          continue;
        }
        insert.run(group.resourceName, group.phoneE164, group.displayName ?? null, now);
        resources.add(group.resourceName);
      }
    })();
    return { groups: resources.size, numbers: groups.length };
  }

  async listGoogleContactGroups(): Promise<GoogleContactGroupEntry[]> {
    return this.db
      .prepare(`SELECT resource_name AS resourceName, phone_e164 AS phoneE164, display_name AS displayName FROM google_contact_groups ORDER BY resource_name, phone_e164`)
      .all() as GoogleContactGroupEntry[];
  }

  async resolveArchivedJidsForPhones(phones: string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    const unique = [...new Set(phones.filter(Boolean))];
    const find = this.db.prepare(`SELECT source_jid AS jid FROM contacts WHERE phone_number = ? OR source_jid = ?`);
    for (const phone of unique) {
      const rows = find.all(phone, `${phone}@s.whatsapp.net`) as Array<{ jid: string }>;
      if (rows.length > 0) {
        result.set(phone, [...new Set(rows.map((row) => row.jid))]);
      }
    }
    return result;
  }

  async listIdentityProfiles(options: { limit?: number } = {}): Promise<IdentityProfile[]> {
    return this.db
      .prepare(
        `SELECT c.source_jid AS jid, c.display_name AS displayName, c.push_name AS pushName, c.phone_number AS phoneNumber,
                (SELECT COUNT(*) FROM messages m WHERE m.sender_source_jid = c.source_jid) AS messageCount
         FROM contacts c
         WHERE c.source_jid LIKE '%@s.whatsapp.net' OR c.source_jid LIKE '%@lid' OR c.source_jid LIKE '%@hosted.lid'
         ORDER BY c.id LIMIT ?`
      )
      .all(Math.max(1, options.limit ?? 10_000)) as IdentityProfile[];
  }

  async listIdentityActivitySummaries(options: { minMessages?: number; limit?: number } = {}): Promise<IdentityActivitySummary[]> {
    return this.db
      .prepare(
        `SELECT sender_source_jid AS jid, COUNT(*) AS messages, MIN(timestamp_ms) AS firstMs, MAX(timestamp_ms) AS lastMs
         FROM messages
         WHERE sender_source_jid IS NOT NULL AND timestamp_ms IS NOT NULL
           AND (sender_source_jid LIKE '%@s.whatsapp.net' OR sender_source_jid LIKE '%@lid' OR sender_source_jid LIKE '%@hosted.lid')
         GROUP BY sender_source_jid
         HAVING COUNT(*) >= ?
         ORDER BY MAX(timestamp_ms) DESC
         LIMIT ?`
      )
      .all(Math.max(1, options.minMessages ?? 3), Math.max(1, options.limit ?? 2_000)) as IdentityActivitySummary[];
  }

  async listIdentityChatActivity(jids: string[]): Promise<IdentityChatActivity[]> {
    const result: IdentityChatActivity[] = [];
    const unique = [...new Set(jids.filter(Boolean))];
    for (let index = 0; index < unique.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = unique.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT m.sender_source_jid AS jid, c.source_chat_id AS chatSourceId, COUNT(*) AS messages,
                  MIN(m.timestamp_ms) AS firstMs, MAX(m.timestamp_ms) AS lastMs
           FROM messages m JOIN chats c ON c.id = m.chat_id
           WHERE m.sender_source_jid IN (${placeholders}) AND m.timestamp_ms IS NOT NULL
           GROUP BY m.sender_source_jid, c.source_chat_id`
        )
        .all(...batch) as IdentityChatActivity[];
      result.push(...rows);
    }
    return result;
  }

  async listGroupParticipantSets(
    options: { maxGroupSize?: number; limit?: number } = {}
  ): Promise<Array<{ groupSourceId: string; participantJids: string[] }>> {
    const maxGroupSize = Math.max(2, options.maxGroupSize ?? 64);
    const limit = Math.max(1, options.limit ?? 500);
    const rows = this.db
      .prepare(
        `SELECT c.source_chat_id AS groupSourceId, cp.source_jid AS jid
         FROM chats c JOIN chat_participants cp ON cp.chat_id = c.id
         WHERE c.chat_type = 'group'
         ORDER BY c.id`
      )
      .all() as Array<{ groupSourceId: string; jid: string }>;
    const byGroup = new Map<string, string[]>();
    for (const row of rows) {
      byGroup.set(row.groupSourceId, [...(byGroup.get(row.groupSourceId) ?? []), row.jid]);
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
    return this.db
      .prepare(
        `SELECT a.jid AS jidA, b.jid AS jidB, COUNT(DISTINCT cl.episode_id) AS episodes
         FROM brain_claim_entities a
         JOIN brain_claim_entities b ON b.claim_id = a.claim_id AND b.jid > a.jid
         JOIN brain_claims cl ON cl.id = a.claim_id
         WHERE a.jid IS NOT NULL AND b.jid IS NOT NULL AND a.kind = 'person' AND b.kind = 'person'
         GROUP BY a.jid, b.jid
         HAVING COUNT(DISTINCT cl.episode_id) >= ?
         ORDER BY episodes DESC
         LIMIT ?`
      )
      .all(Math.max(1, options.minEpisodes ?? 2), Math.max(1, options.limit ?? 200)) as Array<{ jidA: string; jidB: string; episodes: number }>;
  }

  async listResolvedVcardNames(options: { limit?: number } = {}): Promise<Array<{ resolvedJid: string; displayName: string | null }>> {
    return this.db
      .prepare(
        `SELECT DISTINCT resolved_jid AS resolvedJid, display_name AS displayName
         FROM message_vcards WHERE resolved_jid IS NOT NULL LIMIT ?`
      )
      .all(Math.max(1, options.limit ?? 1_000)) as Array<{ resolvedJid: string; displayName: string | null }>;
  }

  // Refresh derived search text (`resolved_text` + mentions) for the given
  // identities' messages and the messages that mention them — chunked with
  // event-loop yields so a heavy sender never stalls ingestion. Shared by the
  // merge path, the name-gained path, and the one-time backfill. Returns the
  // number of messages recomputed.
  private async recomputeFtsForIdentities(jids: string[]): Promise<number> {
    const unique = [...new Set(jids.filter(Boolean))];
    if (unique.length === 0 || this.getFtsState() !== "ready") {
      return 0;
    }
    const affected = new Set<number>();
    for (let index = 0; index < unique.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = unique.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT id FROM messages WHERE sender_source_jid IN (${placeholders})
           UNION
           SELECT message_id AS id FROM message_mentions WHERE mentioned_jid IN (${placeholders})`
        )
        .all(...batch, ...batch) as Array<{ id: number }>;
      for (const row of rows) {
        affected.add(Number(row.id));
      }
    }
    const ids = [...affected];
    for (let index = 0; index < ids.length; index += SEARCH_REINDEX_CHUNK) {
      const chunk = ids.slice(index, index + SEARCH_REINDEX_CHUNK);
      this.db.transaction(() => this.syncMessageDerivedState(chunk))();
      if (index + SEARCH_REINDEX_CHUNK < ids.length) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    return ids.length;
  }

  // === Identity late-resolution repair ===================================
  // "Store references, render names" is free everywhere except LLM-generated
  // prose, where an unresolved participant's number is baked into episode
  // summaries and claim text at commit. These methods are the one entry point
  // every resolution source routes through to repair that prose (and derived
  // search text) deterministically, with no model call, once a name is known.

  // Normalize/canonicalize the improved JIDs and include any LIDs that link to
  // them — so a repair invoked with a phone identity also matches merge-era
  // episode stamps, which record the pre-merge LID form.
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
      const lids = this.db.prepare(`SELECT lid FROM identity_links WHERE pn = ?`).all(canonical) as Array<{ lid: string }>;
      for (const row of lids) {
        set.add(row.lid);
      }
    }
    return set;
  }

  // The current best display label for a JID — resolved exactly as the evidence
  // pack labels senders (saved name → push name → +E.164) and following identity
  // links so a merged LID resolves through its phone identity. Null when nothing
  // is known.
  private resolveCurrentLabelForJid(jid: string): string | null {
    const canonical = this.canonicalJid(jid) ?? jid;
    const row = this.db
      .prepare(`SELECT display_name, push_name, phone_number FROM contacts WHERE source_jid = ?`)
      .get(canonical) as { display_name: string | null; push_name: string | null; phone_number: string | null } | undefined;
    const name = row?.display_name?.trim();
    if (name && !isMaskedNumberLabel(name)) {
      return name;
    }
    const push = row?.push_name?.trim();
    if (push && !isMaskedNumberLabel(push)) {
      return push;
    }
    const phone = row?.phone_number?.trim();
    if (phone) {
      return `+${phone.replace(/[+\s-]/g, "")}`;
    }
    return displayPhoneFromJid(canonical);
  }

  // Of the given JIDs, those that currently resolve to a genuine saved/push
  // name (not a masked placeholder, and not an identity-derived restatement of
  // the number), mapped to that name. Used to detect name transitions worth
  // repairing after a contact write — both unnamed→named and genuine renames
  // (name → different name) — so bulk imports that merely restate existing
  // names don't churn.
  private genuinelyNamedLabels(jids: string[]): Map<string, string> {
    const result = new Map<string, string>();
    const unique = [...new Set(jids.map((jid) => this.canonicalJid(jid) ?? jid).filter(Boolean))];
    for (let index = 0; index < unique.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = unique.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT source_jid, display_name, push_name FROM contacts WHERE source_jid IN (${placeholders})`)
        .all(...batch) as Array<{ source_jid: string; display_name: string | null; push_name: string | null }>;
      for (const row of rows) {
        const name = row.display_name?.trim() || row.push_name?.trim() || "";
        if (name && !isMaskedNumberLabel(name) && !isIdentityDerivedName(name, row.source_jid)) {
          result.set(row.source_jid, name);
        }
      }
    }
    return result;
  }

  async repairIdentityResolution(jids: string | string[]): Promise<IdentityRepairResult> {
    const inputs = (Array.isArray(jids) ? jids : [jids]).filter(Boolean);
    const candidates = this.expandIdentityCandidates(inputs);
    if (candidates.size === 0) {
      return { episodesRepaired: 0, tokensSubstituted: 0, messagesRecomputed: 0 };
    }
    const messagesRecomputed = await this.recomputeFtsForIdentities([...candidates]);
    const { episodesRepaired, tokensSubstituted } = await this.repairBrainProseForIdentities(candidates, {
      enqueueRegeneration: config.brain.regenerateAfterResolution === true
    });
    if (episodesRepaired > 0 || messagesRecomputed > 0) {
      this.invalidateBrainStatusCache();
    }
    return { episodesRepaired, tokensSubstituted, messagesRecomputed };
  }

  // Deterministic brain-prose repair for a set of improved identities: for every
  // current episode whose unresolved-participants stamp names one of them,
  // substitute the baked number/LID token in the summary, claims, and participant
  // list with the resolved label; drop the stamp entry when a genuine name
  // arrived (keep it when only a number did); re-project the Markdown. No model
  // call. Bounded by the debt set (episodes with a non-empty stamp), yielding.
  private async repairBrainProseForIdentities(
    candidates: Set<string>,
    options?: { enqueueRegeneration?: boolean }
  ): Promise<{ episodesRepaired: number; tokensSubstituted: number }> {
    if (candidates.size === 0) {
      return { episodesRepaired: 0, tokensSubstituted: 0 };
    }
    const { episodeMarkdown, projectEpisodeFile, numberLabelFromJid, substituteParticipantToken, labelIsResolvedName } =
      await import("../brain/episodes");
    const debt = this.db
      .prepare(
        `SELECT id, unresolved_participants_json FROM brain_episodes
         WHERE status = 'current'
           AND unresolved_participants_json IS NOT NULL
           AND unresolved_participants_json <> '[]'`
      )
      .all() as Array<{ id: string; unresolved_participants_json: string }>;
    let episodesRepaired = 0;
    let tokensSubstituted = 0;
    const repairedIds: string[] = [];
    let processed = 0;
    for (const entry of debt) {
      const stamp = (parseJson(entry.unresolved_participants_json) as string[] | null) ?? [];
      const hits = stamp.filter((jid) => candidates.has(jid));
      if (hits.length === 0) {
        continue;
      }
      // (oldToken → newLabel) per hit that has actually improved. The token is
      // regenerated from the JID by the same function that baked it.
      const subs: Array<{ jid: string; token: string; label: string; isName: boolean }> = [];
      for (const jid of hits) {
        const token = numberLabelFromJid(jid);
        if (!token.startsWith("+") && !token.startsWith("lid:")) {
          continue; // participant-unknown / hash — nothing findable to substitute
        }
        const label = this.resolveCurrentLabelForJid(jid);
        if (!label || label === token) {
          continue; // no improvement yet
        }
        subs.push({ jid, token, label, isName: labelIsResolvedName(label) });
      }
      if (subs.length === 0) {
        continue;
      }
      const applied = this.db.transaction(() => {
        const epRow = this.db.prepare(`SELECT summary, participants_json FROM brain_episodes WHERE id = ?`).get(entry.id) as
          | { summary: string; participants_json: string | null }
          | undefined;
        if (!epRow) {
          return 0;
        }
        let count = 0;
        let summary = epRow.summary;
        let participants = (parseJson(epRow.participants_json) as string[] | null) ?? [];
        for (const sub of subs) {
          const before = summary;
          summary = substituteParticipantToken(summary, sub.token, sub.label);
          if (summary !== before) {
            count += 1;
          }
          participants = participants.map((participant) => substituteParticipantToken(participant, sub.token, sub.label));
        }
        const claims = this.db.prepare(`SELECT id, text FROM brain_claims WHERE episode_id = ?`).all(entry.id) as Array<{
          id: string;
          text: string;
        }>;
        const updateClaim = this.db.prepare(`UPDATE brain_claims SET text = ? WHERE id = ?`);
        for (const claim of claims) {
          let text = claim.text;
          for (const sub of subs) {
            const before = text;
            text = substituteParticipantToken(text, sub.token, sub.label);
            if (text !== before) {
              count += 1;
            }
          }
          if (text !== claim.text) {
            updateClaim.run(text, claim.id);
          }
        }
        // Drop only the JIDs that resolved to a genuine name; a number-only
        // improvement keeps its stamp so it stays counted and repairable.
        const resolvedNameJids = new Set(subs.filter((sub) => sub.isName).map((sub) => sub.jid));
        const newStamp = stamp.filter((jid) => !resolvedNameJids.has(jid));
        this.db
          .prepare(`UPDATE brain_episodes SET summary = ?, participants_json = ?, unresolved_participants_json = ? WHERE id = ?`)
          .run(summary, stringifyJson(participants), stringifyJson(newStamp), entry.id);
        return count;
      })();
      if (applied > 0) {
        tokensSubstituted += applied;
        episodesRepaired += 1;
        repairedIds.push(entry.id);
      }
      processed += 1;
      if (processed % 25 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    // Re-project repaired episodes deterministically from fresh DB state.
    for (const id of repairedIds) {
      const [record] = await this.listBrainEpisodes({ episodeId: id, limit: 1 });
      if (!record) {
        continue;
      }
      const markdown = episodeMarkdown(record);
      this.db.prepare(`UPDATE brain_episodes SET markdown = ? WHERE id = ?`).run(markdown, id);
      try {
        projectEpisodeFile({ ...record, markdown });
      } catch {
        // Projection to the vault is best-effort; the database is the source of truth.
      }
    }
    // Semantic-rollups: statement prose inherits the same substitutable-label
    // discipline as claims — sweep CURRENT doc revisions with the same
    // token→label substitutions and re-render affected files. Zero model
    // calls; superseded revisions keep their as-written labels (history).
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
      const revisionRows = this.db
        .prepare(`SELECT id, doc_id, sections_json FROM brain_doc_revisions WHERE status = 'current'`)
        .all() as Array<{ id: number; doc_id: string; sections_json: string }>;
      const updateRevision = this.db.prepare(`UPDATE brain_doc_revisions SET sections_json = ? WHERE id = ?`);
      const repairedDocIds: string[] = [];
      for (const revisionRow of revisionRows) {
        const sections = parseJson(revisionRow.sections_json) as Array<{ title: string; statements: Array<{ text: string; claimIds: string[] }> }> | null;
        if (!sections) {
          continue;
        }
        let changed = false;
        for (const section of sections) {
          for (const statement of section.statements) {
            let text = statement.text;
            for (const sub of docSubs) {
              const before = text;
              text = substituteParticipantToken(text, sub.token, sub.label);
              if (text !== before) {
                tokensSubstituted += 1;
                changed = true;
              }
            }
            statement.text = text;
          }
        }
        if (changed) {
          updateRevision.run(stringifyJson(sections), revisionRow.id);
          repairedDocIds.push(revisionRow.doc_id);
        }
      }
      if (repairedDocIds.length > 0) {
        try {
          const { projectBrainDocs } = await import("../brain/projection");
          await projectBrainDocs(this, { docIds: repairedDocIds });
        } catch {
          // Vault projection is best-effort; the database is the source of truth.
        }
      }
    }
    if (options?.enqueueRegeneration === true && repairedIds.length > 0) {
      this.enqueueRegenerationForEpisodes(repairedIds);
    }
    return { episodesRepaired, tokensSubstituted };
  }

  // Optional quality upgrade (repair-first): enqueue low-priority regeneration
  // for repaired episodes so the model can weave the now-named person into
  // context. Never marks the episode stale (it is repaired and current) and
  // never clears the debt — the deterministic pass already did. Off by default.
  private enqueueRegenerationForEpisodes(episodeIds: string[]): void {
    const enqueue = this.db.prepare(
      `INSERT OR IGNORE INTO brain_tasks (kind, chat_source_id, payload_json, dedupe_key, priority)
       VALUES ('episode', ?, ?, ?, ?)`
    );
    const transaction = this.db.transaction(() => {
      for (const id of episodeIds) {
        const row = this.db
          .prepare(`SELECT chat_source_id, start_at_ms, end_at_ms FROM brain_episodes WHERE id = ?`)
          .get(id) as { chat_source_id: string; start_at_ms: number; end_at_ms: number } | undefined;
        if (!row) {
          continue;
        }
        enqueue.run(
          row.chat_source_id,
          stringifyJson({ chatSourceId: row.chat_source_id, sinceMs: row.start_at_ms, throughMs: row.end_at_ms, regen: true, episodeId: id }),
          `regen:${id}`,
          2_000
        );
      }
    });
    transaction();
  }

  async backfillIdentityResolution(): Promise<IdentityRepairResult> {
    const empty: IdentityRepairResult = { episodesRepaired: 0, tokensSubstituted: 0, messagesRecomputed: 0 };
    if (this.legacyArchive) {
      return empty;
    }
    const debt = this.db
      .prepare(
        `SELECT unresolved_participants_json FROM brain_episodes
         WHERE status = 'current' AND unresolved_participants_json IS NOT NULL AND unresolved_participants_json <> '[]'`
      )
      .all() as Array<{ unresolved_participants_json: string }>;
    const stampedJids = new Set<string>();
    for (const row of debt) {
      for (const jid of (parseJson(row.unresolved_participants_json) as string[] | null) ?? []) {
        stampedJids.add(jid);
      }
    }
    if (stampedJids.size === 0) {
      return empty;
    }
    const { numberLabelFromJid } = await import("../brain/episodes");
    const improved: string[] = [];
    for (const jid of stampedJids) {
      const token = numberLabelFromJid(jid);
      if (!token.startsWith("+") && !token.startsWith("lid:")) {
        continue;
      }
      const label = this.resolveCurrentLabelForJid(jid);
      if (label && label !== token) {
        improved.push(jid);
      }
    }
    if (improved.length === 0) {
      return empty;
    }
    const result = await this.repairIdentityResolution(improved);
    if (result.episodesRepaired > 0) {
      console.log(
        `[identity-repair] backfill repaired ${result.episodesRepaired} episode(s), ` +
          `${result.tokensSubstituted} token substitution(s)` +
          (result.messagesRecomputed > 0 ? `; recomputed search text for ${result.messagesRecomputed} message(s)` : "")
      );
    }
    return result;
  }

  async getBrainResolutionDebt(options?: { limit?: number }): Promise<BrainResolutionDebtSummary> {
    const limit = options?.limit ?? 8;
    const debt = this.db
      .prepare(
        `SELECT unresolved_participants_json FROM brain_episodes
         WHERE status = 'current' AND unresolved_participants_json IS NOT NULL AND unresolved_participants_json <> '[]'`
      )
      .all() as Array<{ unresolved_participants_json: string }>;
    const episodeCountByJid = new Map<string, number>();
    let episodesWithUnresolved = 0;
    for (const row of debt) {
      const stamp = (parseJson(row.unresolved_participants_json) as string[] | null) ?? [];
      if (stamp.length === 0) {
        continue;
      }
      episodesWithUnresolved += 1;
      for (const jid of new Set(stamp)) {
        episodeCountByJid.set(jid, (episodeCountByJid.get(jid) ?? 0) + 1);
      }
    }
    const { numberLabelFromJid } = await import("../brain/episodes");
    const identities: BrainResolutionDebtIdentity[] = [...episodeCountByJid.keys()].map((jid) => {
      const canonical = this.canonicalJid(jid) ?? jid;
      const messages = this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE sender_source_jid = ?`).get(canonical) as {
        n: number;
      };
      return {
        jid,
        label: this.resolveCurrentLabelForJid(jid) ?? numberLabelFromJid(jid),
        messageCount: Number(messages.n ?? 0),
        episodeCount: episodeCountByJid.get(jid) ?? 0
      };
    });
    identities.sort((a, b) => b.messageCount - a.messageCount || b.episodeCount - a.episodeCount);
    return {
      episodesWithUnresolved,
      distinctIdentities: episodeCountByJid.size,
      topIdentities: identities.slice(0, limit)
    };
  }

  // Re-derive message keys after their chat's canonical JID changed.
  private rekeyChatMessages(chatId: number, canonicalChatJid: string): void {
    const rows = this.db.prepare(`SELECT id, source_message_id FROM messages WHERE chat_id = ?`).all(chatId) as Array<{
      id: number;
      source_message_id: string;
    }>;
    const update = this.db.prepare(`UPDATE messages SET source_message_key = ? WHERE id = ?`);
    for (const row of rows) {
      update.run(messageKey(canonicalChatJid, row.source_message_id), row.id);
    }
  }

  // Merge two rows representing the same WhatsApp message: tombstones stick,
  // richer content wins, and the dropped row's unique metadata is absorbed.
  private collapseMessagePair(keepId: number, dropId: number): void {
    const richness = this.db.prepare(
      `SELECT id, (NULLIF(TRIM(COALESCE(body, '')), '') IS NOT NULL) + (NULLIF(TRIM(COALESCE(caption, '')), '') IS NOT NULL) + has_media AS score
       FROM messages WHERE id IN (?, ?)`
    );
    const scores = new Map((richness.all(keepId, dropId) as Array<{ id: number; score: number }>).map((row) => [row.id, row.score]));
    const contentSource = (scores.get(dropId) ?? 0) > (scores.get(keepId) ?? 0) ? dropId : keepId;
    this.db
      .prepare(
        `UPDATE messages SET
           is_deleted = MAX(is_deleted, (SELECT is_deleted FROM messages m2 WHERE m2.id = ?)),
           is_starred = MAX(is_starred, (SELECT is_starred FROM messages m2 WHERE m2.id = ?)),
           is_forwarded = MAX(is_forwarded, (SELECT is_forwarded FROM messages m2 WHERE m2.id = ?)),
           timestamp_ms = COALESCE(timestamp_ms, (SELECT timestamp_ms FROM messages m2 WHERE m2.id = ?)),
           sent_at = COALESCE(sent_at, (SELECT sent_at FROM messages m2 WHERE m2.id = ?)),
           sender_source_jid = COALESCE(sender_source_jid, (SELECT sender_source_jid FROM messages m2 WHERE m2.id = ?)),
           quoted_source_message_id = COALESCE(quoted_source_message_id, (SELECT quoted_source_message_id FROM messages m2 WHERE m2.id = ?)),
           raw_metadata_json = COALESCE(raw_metadata_json, (SELECT raw_metadata_json FROM messages m2 WHERE m2.id = ?)),
           body = (SELECT body FROM messages m2 WHERE m2.id = ?),
           caption = (SELECT caption FROM messages m2 WHERE m2.id = ?),
           has_media = MAX(has_media, (SELECT has_media FROM messages m2 WHERE m2.id = ?)),
           media_mime_type = COALESCE(media_mime_type, (SELECT media_mime_type FROM messages m2 WHERE m2.id = ?)),
           media_name = COALESCE(media_name, (SELECT media_name FROM messages m2 WHERE m2.id = ?)),
           message_type = (SELECT message_type FROM messages m2 WHERE m2.id = ?)
         WHERE id = ?`
      )
      .run(dropId, dropId, dropId, dropId, dropId, dropId, dropId, dropId, contentSource, contentSource, dropId, dropId, dropId, contentSource, keepId);
    // Brain citations anchor on the message rowid; repoint them onto the
    // survivor before the dropped row (and its rowid) disappears.
    this.db.prepare(`UPDATE brain_citations SET message_id = ? WHERE message_id = ?`).run(keepId, dropId);
    // Preserve a reply-owned snapshot while collapsing duplicate message rows.
    // The newer/more complete snapshot only fills gaps on the survivor.
    this.db
      .prepare(
        `INSERT INTO message_quoted_snapshots
         (reply_message_key, quoted_source_message_id, quoted_source_chat_id, quoted_sender_source_jid, quoted_from_me, timestamp_ms,
          message_type, raw_type_code, body, caption, media_mime_type, media_name, thumbnail, location_json, vcard_json, mentioned_jids_json, updated_at)
         SELECT keep.source_message_key, qs.quoted_source_message_id, qs.quoted_source_chat_id, qs.quoted_sender_source_jid, qs.quoted_from_me, qs.timestamp_ms,
                qs.message_type, qs.raw_type_code, qs.body, qs.caption, qs.media_mime_type, qs.media_name, qs.thumbnail, qs.location_json, qs.vcard_json, qs.mentioned_jids_json, ?
         FROM message_quoted_snapshots qs JOIN messages keep ON keep.id = ?
         WHERE qs.reply_message_key = (SELECT source_message_key FROM messages WHERE id = ?)
         ON CONFLICT(reply_message_key) DO UPDATE SET
           quoted_source_message_id = COALESCE(excluded.quoted_source_message_id, message_quoted_snapshots.quoted_source_message_id),
           quoted_source_chat_id = COALESCE(excluded.quoted_source_chat_id, message_quoted_snapshots.quoted_source_chat_id),
           quoted_sender_source_jid = COALESCE(excluded.quoted_sender_source_jid, message_quoted_snapshots.quoted_sender_source_jid),
           quoted_from_me = COALESCE(excluded.quoted_from_me, message_quoted_snapshots.quoted_from_me),
           timestamp_ms = COALESCE(excluded.timestamp_ms, message_quoted_snapshots.timestamp_ms),
           message_type = CASE
             WHEN message_quoted_snapshots.message_type LIKE 'unknown%' AND excluded.message_type NOT LIKE 'unknown%'
             THEN excluded.message_type ELSE message_quoted_snapshots.message_type
           END,
           raw_type_code = COALESCE(excluded.raw_type_code, message_quoted_snapshots.raw_type_code),
           body = COALESCE(NULLIF(excluded.body, ''), message_quoted_snapshots.body),
           caption = COALESCE(NULLIF(excluded.caption, ''), message_quoted_snapshots.caption),
           media_mime_type = COALESCE(excluded.media_mime_type, message_quoted_snapshots.media_mime_type),
           media_name = COALESCE(excluded.media_name, message_quoted_snapshots.media_name),
           thumbnail = COALESCE(excluded.thumbnail, message_quoted_snapshots.thumbnail),
           location_json = COALESCE(excluded.location_json, message_quoted_snapshots.location_json),
           vcard_json = COALESCE(excluded.vcard_json, message_quoted_snapshots.vcard_json),
           mentioned_jids_json = COALESCE(excluded.mentioned_jids_json, message_quoted_snapshots.mentioned_jids_json),
           updated_at = excluded.updated_at`
      )
      .run(currentIso(), keepId, dropId);
    // Merged tombstones keep their held content: deletion is a state marker,
    // never a content eraser (backup-store semantics).
    this.db.prepare(`DELETE FROM messages WHERE id = ?`).run(dropId);
  }

  async createRestorePoint(label: string): Promise<ArchiveRestorePoint> {
    const safeLabel = label.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 60) || "archive";
    const snapshotPath = path.resolve(config.workDir, "import-staging", `${safeLabel}-${crypto.randomUUID()}.sqlite`);
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    await this.db.backup(snapshotPath);
    let disposed = false;
    return {
      restore: async () => {
        if (disposed || !fs.existsSync(snapshotPath)) {
          return;
        }
        this.restoreFromSnapshot(snapshotPath);
      },
      dispose: async () => {
        disposed = true;
        await fs.promises.rm(snapshotPath, { force: true });
      }
    };
  }

  async startImportRun(sourceSummary: Record<string, unknown>): Promise<string> {
    this.assertWritableIdentityVersion();
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO import_runs (id, status, started_at, tool_version, source_summary_json, totals_json)
         VALUES (?, 'running', ?, ?, ?, ?)`
      )
      .run(id, currentIso(), TOOL_VERSION, stringifyJson(sourceSummary), stringifyJson(totalsOrEmpty(null)));
    return id;
  }

  async completeImportRun(runId: string, totals: ImportTotals, warningCount: number): Promise<void> {
    this.db
      .prepare(
        `UPDATE import_runs
         SET status = 'completed', finished_at = ?, totals_json = ?, warning_count = ?
         WHERE id = ?`
      )
      .run(currentIso(), stringifyJson(totals), warningCount, runId);
  }

  async failImportRun(
    runId: string,
    code: string,
    message: string,
    totals: ImportTotals = totalsOrEmpty(null),
    warningCount = 0
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE import_runs
         SET status = 'failed', finished_at = ?, totals_json = ?, warning_count = ?, error_code = ?, error_message = ?
         WHERE id = ?`
      )
      .run(currentIso(), stringifyJson(totals), warningCount, code, message.slice(0, 500), runId);
  }

  async addWarnings(runId: string, warnings: ImportWarning[]): Promise<void> {
    if (warnings.length === 0) {
      return;
    }
    const insert = this.db.prepare(
      `INSERT INTO import_warnings
       (import_run_id, severity, code, entity_type, source_table, source_row_id, message, context_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const transaction = this.db.transaction(() => {
      for (const warning of warnings) {
        insert.run(
          runId,
          warning.severity,
          warning.code,
          warning.entityType ?? null,
          warning.sourceTable ?? null,
          warning.sourceRowId ?? null,
          warning.message.slice(0, 500),
          stringifyJson(warning.context ?? null)
        );
      }
    });
    transaction();
  }

  async upsertContacts(runId: string, contacts: ContactRecord[]): Promise<Map<string, number>> {
    this.assertWritableIdentityVersion();
    const unique = new Map<string, ContactRecord>();
    for (const contact of contacts) {
      const sourceJid = this.canonicalJid(contact.sourceJid);
      if (!sourceJid) {
        continue;
      }
      // Two records can canonicalize onto one identity within a batch (LID stub
      // + real contact); merge field-wise so a stub cannot clobber a name.
      const existing = unique.get(sourceJid);
      // A masked-number placeholder is never a name: coerce it to null here so
      // no writer — import, live sync, or Google enrichment — can store it and
      // shadow the full number resolution would otherwise yield.
      const mergedDisplayName = existing?.displayName?.trim() || contact.displayName || null;
      const mergedPushName = existing?.pushName?.trim() || contact.pushName || null;
      unique.set(sourceJid, {
        ...contact,
        sourceJid,
        displayName: mergedDisplayName && !isMaskedNumberLabel(mergedDisplayName) ? mergedDisplayName : null,
        pushName: mergedPushName && !isMaskedNumberLabel(mergedPushName) ? mergedPushName : null,
        phoneNumber: existing?.phoneNumber || contact.phoneNumber || null
      });
    }
    if (unique.size === 0) {
      return new Map();
    }

    // Snapshot the genuine labels identities already resolved to, so after the
    // write we can repair episodes only for those whose resolution actually
    // changed — a gained name or a rename — not every contact in a bulk import.
    const batchJids = [...unique.keys()];
    const labelsBefore = this.genuinelyNamedLabels(batchJids);

    const upsert = this.db.prepare(
      `INSERT INTO contacts
       (source_jid, phone_number, display_name, display_name_source, push_name, raw_metadata_json, first_seen_import_id, last_seen_import_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_jid) DO UPDATE SET
         phone_number = COALESCE(excluded.phone_number, contacts.phone_number),
         -- A user-set name is the strongest source: only another user write
         -- may replace it. Every other incoming name defers to it.
         display_name = CASE
           WHEN contacts.display_name_source = 'user' AND excluded.display_name_source IS NOT 'user' THEN contacts.display_name
           ELSE COALESCE(NULLIF(excluded.display_name, ''), contacts.display_name)
         END,
         display_name_source = CASE
           WHEN contacts.display_name_source = 'user' AND excluded.display_name_source IS NOT 'user' THEN contacts.display_name_source
           WHEN NULLIF(excluded.display_name, '') IS NOT NULL THEN excluded.display_name_source
           ELSE contacts.display_name_source
         END,
         push_name = COALESCE(NULLIF(excluded.push_name, ''), contacts.push_name),
         raw_metadata_json = COALESCE(excluded.raw_metadata_json, contacts.raw_metadata_json),
         last_seen_import_id = excluded.last_seen_import_id,
         updated_at = excluded.updated_at`
    );
    const transaction = this.db.transaction(() => {
      for (const contact of unique.values()) {
        upsert.run(
          contact.sourceJid,
          contact.phoneNumber ?? null,
          contact.displayName ?? null,
          contact.displayName?.trim()
            ? contact.displayNameSource === "user"
              ? "user"
              : contact.rawMetadata?.source === "lid_display_name"
                ? "display_cache"
                : "whatsapp_saved"
            : null,
          contact.pushName ?? null,
          stringifyJson(contact.rawMetadata ?? null),
          runId,
          runId,
          currentIso()
        );
      }
    });
    transaction();
    // Propagate the STORED winners to DM chat titles, not the incoming batch
    // values — an import name blocked by a user-set name must not leak into
    // the chat list through propagation.
    const storedNames = new Map<string, string | null>();
    for (let index = 0; index < batchJids.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = batchJids.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const rows = this.db
        .prepare(`SELECT source_jid AS jid, display_name AS name FROM contacts WHERE source_jid IN (${batch.map(() => "?").join(",")})`)
        .all(...batch) as Array<{ jid: string; name: string | null }>;
      for (const row of rows) {
        storedNames.set(row.jid, row.name);
      }
    }
    this.propagateContactNamesToDmChats(
      [...unique.values()].map((contact) => ({ ...contact, displayName: storedNames.get(contact.sourceJid) ?? contact.displayName ?? null }))
    );

    // Identity late-resolution: any identity whose genuine resolution changed —
    // gained a name (unnamed→named) or was renamed to a DIFFERENT genuine name
    // — routes through the one repair entry point (search text + brain prose),
    // so contact saves and renames retroactively improve old messages and
    // episodes with no model call. Restated names change nothing and fire
    // nothing (bulk-import safe).
    const labelsAfter = this.genuinelyNamedLabels(batchJids);
    const transitioned = [...labelsAfter].filter(([jid, name]) => labelsBefore.get(jid) !== name).map(([jid]) => jid);
    if (transitioned.length > 0) {
      await this.repairIdentityResolution(transitioned);
    }

    return this.getContactIds([...unique.keys()]);
  }

  async enrichContactsFromGoogle(contacts: GoogleContactCandidate[]): Promise<{ matchedIdentities: number; improvedNames: number }> {
    this.assertWritableIdentityVersion();
    const find = this.db.prepare(
      `SELECT id, source_jid, display_name, display_name_source FROM contacts
       WHERE phone_number = ? OR source_jid = ?`
    );
    const updateContact = this.db.prepare(
      `UPDATE contacts SET display_name = ?, display_name_source = 'google_contacts', updated_at = ? WHERE id = ?`
    );
    const updateChat = this.db.prepare(
      `UPDATE chats SET display_name = ?, updated_at = ?
       WHERE source_chat_id = ? AND chat_type IN ('dm','unknown')`
    );
    let matchedIdentities = 0;
    let improvedNames = 0;
    const improvedJids: string[] = [];
    this.db.transaction(() => {
      for (const contact of contacts) {
        const jid = `${contact.phoneNumber}@s.whatsapp.net`;
        const rows = find.all(contact.phoneNumber, jid) as Array<{ id: number; source_jid: string; display_name: string | null; display_name_source: string | null }>;
        matchedIdentities += rows.length;
        for (const row of rows) {
          // A real saved name is preserved; Google only fills or improves a
          // *weak* label: empty, a prior Google/display-cache fill, an
          // identity-derived restatement of the number, or a masked-number
          // placeholder. The mask must count as no-name here or a stored
          // "+91∙∙∙∙∙∙∙∙86" would shadow a learned real name and block the
          // self-heal — the exact gap that left phone-form contacts nameless
          // after their mask was cleared but before any name reached them.
          const weak =
            !row.display_name?.trim() ||
            row.display_name_source === "google_contacts" ||
            row.display_name_source === "display_cache" ||
            isMaskedNumberLabel(row.display_name) ||
            isIdentityDerivedName(row.display_name, row.source_jid);
          if (!weak) continue;
          updateContact.run(contact.displayName, currentIso(), row.id);
          updateChat.run(contact.displayName, currentIso(), row.source_jid);
          improvedNames += 1;
          improvedJids.push(row.source_jid);
        }
      }
    })();
    // Retroactive enrichment reaches the brain: repair episodes and search text
    // for every identity Google just named, deterministically and model-free.
    if (improvedJids.length > 0) {
      await this.repairIdentityResolution(improvedJids);
    }
    return { matchedIdentities, improvedNames };
  }

  async upsertChats(runId: string, chats: ChatRecord[]): Promise<Map<string, number>> {
    this.assertWritableIdentityVersion();
    const unique = new Map<string, ChatRecord>();
    for (const chat of chats) {
      const sourceChatId = this.canonicalJid(chat.sourceChatId);
      if (!sourceChatId) {
        continue;
      }
      // Platform chat metadata sometimes carries the bare number/LID digits as
      // the "name"; identity-derived names must never become display labels.
      const displayName =
        chat.displayName && !isIdentityDerivedName(chat.displayName, sourceChatId) && !isMaskedNumberLabel(chat.displayName)
          ? chat.displayName
          : null;
      unique.set(sourceChatId, { ...chat, sourceChatId, jid: sourceChatId, displayName });
    }
    if (unique.size === 0) {
      return new Map();
    }

    const upsert = this.db.prepare(
      `INSERT INTO chats
       (source_chat_id, jid, display_name, chat_type, platform_recency_ms, raw_metadata_json, first_seen_import_id, last_seen_import_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_chat_id) DO UPDATE SET
         jid = excluded.jid,
         display_name = CASE
           WHEN excluded.chat_type = 'unknown' AND chats.display_name IS NOT NULL THEN chats.display_name
           ELSE COALESCE(NULLIF(excluded.display_name, ''), chats.display_name)
         END,
         chat_type = CASE
           WHEN excluded.chat_type = 'unknown' THEN chats.chat_type
           ELSE excluded.chat_type
         END,
         platform_recency_ms = CASE
           WHEN excluded.platform_recency_ms IS NULL THEN chats.platform_recency_ms
           WHEN chats.platform_recency_ms IS NULL THEN excluded.platform_recency_ms
           ELSE MAX(chats.platform_recency_ms, excluded.platform_recency_ms)
         END,
         raw_metadata_json = COALESCE(excluded.raw_metadata_json, chats.raw_metadata_json),
         last_seen_import_id = excluded.last_seen_import_id,
         updated_at = excluded.updated_at`
    );
    const transaction = this.db.transaction(() => {
      for (const chat of unique.values()) {
        upsert.run(
          chat.sourceChatId,
          chat.jid,
          chat.displayName ?? null,
          chat.chatType,
          chat.platformRecencyMs ?? null,
          stringifyJson(chat.rawMetadata ?? null),
          runId,
          runId,
          currentIso()
        );
      }
    });
    transaction();

    return this.getChatIds([...unique.keys()]);
  }

  async upsertParticipants(participants: ParticipantRecord[]): Promise<number> {
    this.assertWritableIdentityVersion();
    const unique = new Map<string, ParticipantRecord>();
    for (const participant of participants) {
      const chatSourceId = this.canonicalJid(participant.chatSourceId);
      const sourceJid = this.canonicalJid(participant.sourceJid);
      if (!chatSourceId || !sourceJid) {
        continue;
      }
      unique.set(`${chatSourceId}\u0000${sourceJid}`, { ...participant, chatSourceId, sourceJid });
    }
    if (unique.size === 0) {
      return 0;
    }

    const chats = this.getChatIds([...new Set([...unique.values()].map((p) => p.chatSourceId))]);
    const contacts = this.getContactIds([...new Set([...unique.values()].map((p) => p.sourceJid))]);
    const rows = [...unique.values()]
      .map((participant) => {
        const chatId = chats.get(participant.chatSourceId);
        if (!chatId) {
          return null;
        }
        return {
          chatId,
          sourceJid: participant.sourceJid,
          contactId: contacts.get(participant.sourceJid) ?? null,
          displayName: participant.displayName ?? null,
          firstSeenAtMs: participant.firstSeenAtMs ?? null,
          lastSeenAtMs: participant.lastSeenAtMs ?? null,
          membershipSource: participant.membershipSource,
          rawMetadata: stringifyJson(participant.rawMetadata ?? null)
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    if (rows.length === 0) {
      return 0;
    }

    const upsert = this.db.prepare(
      `INSERT INTO chat_participants
       (chat_id, source_jid, contact_id, display_name, first_seen_at_ms, last_seen_at_ms, membership_source, raw_metadata_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, source_jid) DO UPDATE SET
         contact_id = COALESCE(excluded.contact_id, chat_participants.contact_id),
         display_name = COALESCE(NULLIF(excluded.display_name, ''), chat_participants.display_name),
         first_seen_at_ms = CASE
           WHEN chat_participants.first_seen_at_ms IS NULL THEN excluded.first_seen_at_ms
           WHEN excluded.first_seen_at_ms IS NULL THEN chat_participants.first_seen_at_ms
           ELSE MIN(chat_participants.first_seen_at_ms, excluded.first_seen_at_ms)
         END,
         last_seen_at_ms = CASE
           WHEN chat_participants.last_seen_at_ms IS NULL THEN excluded.last_seen_at_ms
           WHEN excluded.last_seen_at_ms IS NULL THEN chat_participants.last_seen_at_ms
           ELSE MAX(chat_participants.last_seen_at_ms, excluded.last_seen_at_ms)
         END,
         membership_source = CASE
           WHEN chat_participants.membership_source = 'source' THEN chat_participants.membership_source
           ELSE excluded.membership_source
         END,
         raw_metadata_json = COALESCE(excluded.raw_metadata_json, chat_participants.raw_metadata_json),
         updated_at = excluded.updated_at`
    );
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        upsert.run(
          row.chatId,
          row.sourceJid,
          row.contactId,
          row.displayName,
          row.firstSeenAtMs,
          row.lastSeenAtMs,
          row.membershipSource,
          row.rawMetadata,
          currentIso()
        );
      }
    });
    transaction();
    return rows.length;
  }

  async upsertMessages(messages: MessageRecord[]): Promise<number> {
    this.assertWritableIdentityVersion();
    if (messages.length === 0) {
      return 0;
    }

    // Canonicalize identities and re-derive the message key so every source
    // converges on (canonical chat, key_id) no matter what the producer built.
    const canonical = messages
      .map((message) => {
        const chatSourceId = this.canonicalJid(message.chatSourceId);
        if (!chatSourceId || !message.sourceMessageId) {
          return null;
        }
        const senderSourceJid =
          message.senderSourceJid === "me" ? "me" : this.canonicalJid(message.senderSourceJid) ?? message.senderSourceJid ?? null;
        const quotedSnapshot = message.quotedSnapshot
          ? {
              ...message.quotedSnapshot,
              quotedSourceChatId:
                this.canonicalJid(message.quotedSnapshot.quotedSourceChatId) ?? message.quotedSnapshot.quotedSourceChatId ?? null,
              quotedSenderSourceJid:
                this.canonicalJid(message.quotedSnapshot.quotedSenderSourceJid) ?? message.quotedSnapshot.quotedSenderSourceJid ?? null,
              mentionedJids: (message.quotedSnapshot.mentionedJids ?? [])
                .map((jid) => this.canonicalJid(jid) ?? jid)
                .filter((jid): jid is string => Boolean(jid))
            }
          : null;
        return { ...message, quotedSnapshot, chatSourceId, senderSourceJid, sourceMessageKey: messageKey(chatSourceId, message.sourceMessageId) } as MessageRecord;
      })
      .filter((message): message is MessageRecord => message !== null);

    const chatIds = this.getChatIds([...new Set(canonical.map((message) => message.chatSourceId))]);
    const senderIds = this.getContactIds([
      ...new Set(canonical.map((message) => message.senderSourceJid).filter((jid): jid is string => Boolean(jid)))
    ]);
    // Derived search text for the insert path, computed from the incoming
    // values; conflict-merged rows are recomputed from final state below —
    // that same in-transaction recompute also fills resolved_sender and
    // resolved_context, so the insert only carries the content stratum.
    const incomingMentionLabels = this.resolveMentionLabels(canonical.flatMap((message) => [message.body ?? null, message.caption ?? null]));
    const rows = canonical
      .map((message) => {
        const chatId = chatIds.get(message.chatSourceId);
        if (!chatId) {
          return null;
        }
        return {
          sourceMessageKey: message.sourceMessageKey,
          sourceMessageId: message.sourceMessageId,
          sourceTable: message.sourceTable,
          sourceRowId: message.sourceRowId,
          chatId,
          senderContactId: message.senderSourceJid ? senderIds.get(message.senderSourceJid) ?? null : null,
          senderSourceJid: message.senderSourceJid ?? null,
          timestampMs: message.timestampMs ?? null,
          sentAt: isoFromMs(message.timestampMs),
          direction: message.direction,
          fromMe: message.fromMe == null ? null : Number(message.fromMe),
          messageType: message.messageType,
          rawTypeCode: message.rawTypeCode == null ? null : String(message.rawTypeCode),
          body: message.body ?? null,
          caption: message.caption ?? null,
          hasMedia: Number(message.hasMedia),
          mediaMimeType: message.mediaMimeType ?? null,
          mediaName: message.mediaName ?? null,
          quotedSourceMessageId: message.quotedSourceMessageId ?? null,
          isDeleted: Number(message.isDeleted),
          isForwarded: Number(message.isForwarded),
          isStarred: Number(message.isStarred),
          rawMetadata: stringifyJson(message.rawMetadata ?? null),
          resolvedText: composeResolvedText(message.body ?? null, message.caption ?? null, message.mediaName ?? null, incomingMentionLabels),
          mentionedJids: [
            ...new Set((message.mentionedJids ?? []).map((jid) => this.canonicalJid(jid)).filter((jid): jid is string => Boolean(jid)))
          ],
          quotedSnapshot: message.quotedSnapshot ?? null
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    if (rows.length === 0) {
      return 0;
    }

    const upsert = this.db.prepare(
      `INSERT INTO messages
       (source_message_key, source_message_id, source_table, source_row_id, chat_id, sender_contact_id, sender_source_jid,
        timestamp_ms, sent_at, direction, from_me, message_type, raw_type_code, body, caption, has_media, media_mime_type,
        media_name, quoted_source_message_id, is_deleted, is_forwarded, is_starred, raw_metadata_json, resolved_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_message_key) DO UPDATE SET
         chat_id = excluded.chat_id,
         sender_contact_id = COALESCE(excluded.sender_contact_id, messages.sender_contact_id),
         sender_source_jid = COALESCE(excluded.sender_source_jid, messages.sender_source_jid),
         timestamp_ms = COALESCE(excluded.timestamp_ms, messages.timestamp_ms),
         sent_at = COALESCE(excluded.sent_at, messages.sent_at),
         direction = excluded.direction,
         from_me = COALESCE(excluded.from_me, messages.from_me),
         message_type = CASE
           WHEN (excluded.message_type = 'system' OR excluded.message_type LIKE 'unknown%')
                AND messages.message_type <> 'system' AND messages.message_type NOT LIKE 'unknown%' THEN messages.message_type
           -- A contentless unknown re-delivery (e.g. an empty placeholder
           -- response) must not erase a system stub's classification either.
           WHEN excluded.message_type LIKE 'unknown%' AND messages.message_type = 'system' THEN messages.message_type
           ELSE excluded.message_type
         END,
         raw_type_code = COALESCE(excluded.raw_type_code, messages.raw_type_code),
         body = CASE
           WHEN messages.is_deleted = 1
                AND NOT (messages.message_type LIKE 'unknown%' AND messages.body IS NULL AND messages.caption IS NULL
                         AND excluded.is_deleted = 0)
           THEN messages.body
           ELSE COALESCE(NULLIF(excluded.body, ''), messages.body)
         END,
         caption = CASE
           WHEN messages.is_deleted = 1
                AND NOT (messages.message_type LIKE 'unknown%' AND messages.body IS NULL AND messages.caption IS NULL
                         AND excluded.is_deleted = 0)
           THEN messages.caption
           ELSE COALESCE(NULLIF(excluded.caption, ''), messages.caption)
         END,
         has_media = MAX(messages.has_media, excluded.has_media),
         media_mime_type = COALESCE(excluded.media_mime_type, messages.media_mime_type),
         media_name = COALESCE(excluded.media_name, messages.media_name),
         quoted_source_message_id = COALESCE(excluded.quoted_source_message_id, messages.quoted_source_message_id),
         -- A textless unknown-typed row flagged deleted is the retired
         -- inference heuristic, not evidence; a re-import bearing a fresh
         -- not-deleted verdict heals it. Real tombstones (typed rows) keep
         -- their sticky deletion.
         is_deleted = CASE
           WHEN messages.message_type LIKE 'unknown%' AND messages.body IS NULL AND messages.caption IS NULL
                AND excluded.is_deleted = 0
           THEN 0
           ELSE MAX(messages.is_deleted, excluded.is_deleted)
         END,
         is_forwarded = MAX(messages.is_forwarded, excluded.is_forwarded),
         is_starred = MAX(messages.is_starred, excluded.is_starred),
         raw_metadata_json = COALESCE(excluded.raw_metadata_json, messages.raw_metadata_json)`
    );
    const readSnapshot = this.db.prepare(`SELECT * FROM message_quoted_snapshots WHERE reply_message_key = ?`);
    const upsertSnapshot = this.db.prepare(
      `INSERT INTO message_quoted_snapshots
       (reply_message_key, quoted_source_message_id, quoted_source_chat_id, quoted_sender_source_jid, quoted_from_me, timestamp_ms,
        message_type, raw_type_code, body, caption, media_mime_type, media_name, thumbnail, location_json, vcard_json, mentioned_jids_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(reply_message_key) DO UPDATE SET
         quoted_source_message_id = COALESCE(excluded.quoted_source_message_id, message_quoted_snapshots.quoted_source_message_id),
         quoted_source_chat_id = COALESCE(excluded.quoted_source_chat_id, message_quoted_snapshots.quoted_source_chat_id),
         quoted_sender_source_jid = COALESCE(excluded.quoted_sender_source_jid, message_quoted_snapshots.quoted_sender_source_jid),
         quoted_from_me = COALESCE(excluded.quoted_from_me, message_quoted_snapshots.quoted_from_me),
         timestamp_ms = COALESCE(excluded.timestamp_ms, message_quoted_snapshots.timestamp_ms),
         message_type = CASE WHEN message_quoted_snapshots.message_type LIKE 'unknown%' AND excluded.message_type NOT LIKE 'unknown%' THEN excluded.message_type ELSE message_quoted_snapshots.message_type END,
         raw_type_code = COALESCE(excluded.raw_type_code, message_quoted_snapshots.raw_type_code),
         body = COALESCE(NULLIF(excluded.body, ''), message_quoted_snapshots.body),
         caption = COALESCE(NULLIF(excluded.caption, ''), message_quoted_snapshots.caption),
         media_mime_type = COALESCE(excluded.media_mime_type, message_quoted_snapshots.media_mime_type),
         media_name = COALESCE(excluded.media_name, message_quoted_snapshots.media_name),
         thumbnail = COALESCE(excluded.thumbnail, message_quoted_snapshots.thumbnail),
         location_json = COALESCE(excluded.location_json, message_quoted_snapshots.location_json),
         vcard_json = COALESCE(excluded.vcard_json, message_quoted_snapshots.vcard_json),
         mentioned_jids_json = COALESCE(excluded.mentioned_jids_json, message_quoted_snapshots.mentioned_jids_json),
         updated_at = excluded.updated_at`
    );
    const enrichedQuoteKeys: string[] = [];
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        upsert.run(
          row.sourceMessageKey,
          row.sourceMessageId,
          row.sourceTable,
          row.sourceRowId,
          row.chatId,
          row.senderContactId,
          row.senderSourceJid,
          row.timestampMs,
          row.sentAt,
          row.direction,
          row.fromMe,
          row.messageType,
          row.rawTypeCode,
          row.body,
          row.caption,
          row.hasMedia,
          row.mediaMimeType,
          row.mediaName,
          row.quotedSourceMessageId,
          row.isDeleted,
          row.isForwarded,
          row.isStarred,
          row.rawMetadata,
          row.resolvedText
        );
        if (row.quotedSnapshot) {
          const before = readSnapshot.get(row.sourceMessageKey) as Record<string, unknown> | undefined;
          const snapshot = row.quotedSnapshot;
          upsertSnapshot.run(
            row.sourceMessageKey,
            snapshot.quotedSourceMessageId,
            snapshot.quotedSourceChatId,
            snapshot.quotedSenderSourceJid,
            snapshot.quotedFromMe == null ? null : Number(snapshot.quotedFromMe),
            snapshot.timestampMs,
            snapshot.messageType,
            snapshot.rawTypeCode == null ? null : String(snapshot.rawTypeCode),
            snapshot.body,
            snapshot.caption,
            snapshot.mediaMimeType ?? null,
            snapshot.mediaName ?? null,
            snapshot.thumbnail ?? null,
            stringifyJson(snapshot.location ?? null),
            stringifyJson(snapshot.vcard ?? null),
            stringifyJson(snapshot.mentionedJids ?? []),
            currentIso()
          );
          const after = readSnapshot.get(row.sourceMessageKey) as Record<string, unknown> | undefined;
          // `updated_at` is observation metadata, not quote context. A
          // byte-for-byte re-import updates that clock but must not enqueue a
          // brain regeneration; only a new or semantically enriched snapshot
          // changes what an episode could have understood.
          if (!quotedSnapshotRowsEqual(before, after)) {
            enrichedQuoteKeys.push(row.sourceMessageKey);
          }
        }
      }
      // Conflict-merged rows may have kept older body/caption (tombstones,
      // contentless re-deliveries); recompute derived search state from the
      // FINAL stored content so the index never diverges from the row.
      const keys = rows.map((row) => row.sourceMessageKey);
      const explicitMentionsById = new Map<number, string[]>();
      const idsByKey = new Map<string, number>();
      for (let index = 0; index < keys.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
        const batch = keys.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
        const found = this.db
          .prepare(`SELECT id, source_message_key FROM messages WHERE source_message_key IN (${batch.map(() => "?").join(",")})`)
          .all(...batch) as Array<{ id: number; source_message_key: string }>;
        for (const row of found) {
          idsByKey.set(row.source_message_key, Number(row.id));
        }
      }
      for (const row of rows) {
        const id = idsByKey.get(row.sourceMessageKey);
        if (id != null && row.mentionedJids.length > 0) {
          explicitMentionsById.set(id, row.mentionedJids);
        }
      }
      this.syncMessageDerivedState([...idsByKey.values()], explicitMentionsById);
      // Convergence for late-arriving quoted originals (retrieval-hardening):
      // replies indexed while one of these messages was absent carry its
      // snapshot text in resolved_context; re-derive them now so the
      // duplicate context converges away (and tombstoned originals re-orphan).
      const replyIds = this.findReplyIdsQuotingMessages(
        canonical.map((message) => ({ chatSourceId: message.chatSourceId, sourceMessageId: message.sourceMessageId })),
        new Set(idsByKey.values())
      );
      if (replyIds.length > 0) {
        this.syncMessageDerivedState(replyIds);
      }
    });
    transaction();
    if (enrichedQuoteKeys.length > 0) {
      await this.markStaleEpisodesForQuotedReplies(enrichedQuoteKeys);
    }
    return rows.length;
  }

  // Replies (anywhere in the archive) whose quoted snapshot points at one of
  // the given messages. Scoping mirrors the orphan probe: an explicit
  // quoted_source_chat_id must equal the message's chat; a snapshot without
  // one is same-chat by construction, so the reply's own chat must match.
  private findReplyIdsQuotingMessages(
    messages: Array<{ chatSourceId: string; sourceMessageId: string | null | undefined }>,
    excludeIds: Set<number>
  ): number[] {
    const wanted = new Map<string, Set<string>>();
    for (const message of messages) {
      const sourceId = message.sourceMessageId?.trim();
      if (!sourceId) {
        continue;
      }
      const chats = wanted.get(sourceId) ?? new Set<string>();
      chats.add(message.chatSourceId);
      wanted.set(sourceId, chats);
    }
    if (wanted.size === 0) {
      return [];
    }
    const replyIds = new Set<number>();
    const sourceIds = [...wanted.keys()];
    for (let index = 0; index < sourceIds.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = sourceIds.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const rows = this.db
        .prepare(
          `SELECT m.id, q.quoted_source_message_id AS source_id, q.quoted_source_chat_id AS quoted_chat, ch.source_chat_id AS reply_chat
           FROM message_quoted_snapshots q
           JOIN messages m ON m.source_message_key = q.reply_message_key
           JOIN chats ch ON ch.id = m.chat_id
           WHERE q.quoted_source_message_id IN (${batch.map(() => "?").join(",")})`
        )
        .all(...batch) as Array<{ id: number; source_id: string; quoted_chat: string | null; reply_chat: string }>;
      for (const row of rows) {
        const chats = wanted.get(row.source_id);
        if (!chats) {
          continue;
        }
        const sourceChat = row.quoted_chat ?? row.reply_chat;
        if (chats.has(sourceChat) && !excludeIds.has(Number(row.id))) {
          replyIds.add(Number(row.id));
        }
      }
    }
    return [...replyIds];
  }

  async upsertArchiveSignals(batch: ArchiveSignalBatch): Promise<{ changedMessageKeys: string[]; skippedUnanchoredRecords: number }> {
    this.assertWritableIdentityVersion();
    const changedMessageKeys = new Set<string>();
    // Companion tables can contain retained rows for source messages that the
    // defensive message importer skipped. Filter only the FK-bound companion
    // families in bounded key batches so one orphan cannot abort the whole
    // archive run (or manufacture a standalone evidence anchor).
    const companionMessageKeys = [...new Set([
      ...(batch.locations ?? []).map((row) => row.sourceMessageKey),
      ...(batch.locationObservations ?? []).map((row) => row.sourceMessageKey),
      ...(batch.vcards ?? []).map((row) => row.sourceMessageKey),
      ...(batch.editEvents ?? []).map((row) => row.sourceMessageKey),
      ...(batch.deletions ?? []).map((row) => row.sourceMessageKey),
      ...(batch.mediaInterpretations ?? []).map((row) => row.sourceMessageKey)
    ])];
    const anchoredMessageKeys = new Set<string>();
    for (let offset = 0; offset < companionMessageKeys.length; offset += 500) {
      const keys = companionMessageKeys.slice(offset, offset + 500);
      const placeholders = keys.map(() => "?").join(", ");
      const rows = this.db.prepare(`SELECT source_message_key FROM messages WHERE source_message_key IN (${placeholders})`).all(...keys) as Array<{ source_message_key: string }>;
      for (const row of rows) anchoredMessageKeys.add(row.source_message_key);
    }
    const retainAnchored = <T extends { sourceMessageKey: string }>(rows: T[] | undefined): T[] =>
      (rows ?? []).filter((row) => anchoredMessageKeys.has(row.sourceMessageKey));
    const locations = retainAnchored(batch.locations);
    const locationObservations = retainAnchored(batch.locationObservations);
    const vcards = retainAnchored(batch.vcards);
    const deletions = retainAnchored(batch.deletions);
    const mediaInterpretations = retainAnchored(batch.mediaInterpretations);
    // Source row ids differ between backup and live sync. These conservative
    // semantic keys use the shared message identity where available and exact
    // verified role/value/timestamp tuples otherwise; they never dedupe by a
    // broad time window.
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
    const canonical = (jid: string | null | undefined): string | null => (jid === "me" ? "me" : this.canonicalJid(jid) ?? jid ?? null);
    // Canonical scalar provenance must not depend on which source arrived
    // first. Newer observation time wins; an exact live/backup tie prefers
    // live, while the per-source observation table retains both originals.
    const incomingWins = `(existing.observed_at_ms IS NULL AND excluded.observed_at_ms IS NOT NULL)
      OR (existing.observed_at_ms IS NOT NULL AND excluded.observed_at_ms IS NOT NULL AND excluded.observed_at_ms > existing.observed_at_ms)
      OR (existing.observed_at_ms = excluded.observed_at_ms AND excluded.source = 'live' AND existing.source = 'backup')
      OR (existing.observed_at_ms IS NULL AND excluded.observed_at_ms IS NULL AND excluded.source = 'live' AND existing.source = 'backup')`;
    // SQLite's scalar MAX returns NULL when either operand is NULL. Observation
    // time is nullable by contract, so use an explicit monotonic merge rather
    // than accidentally erasing the one timestamp a source did provide.
    const newestObservedAt = `CASE WHEN existing.observed_at_ms IS NULL THEN excluded.observed_at_ms WHEN excluded.observed_at_ms IS NULL THEN existing.observed_at_ms ELSE MAX(existing.observed_at_ms, excluded.observed_at_ms) END`;
    const transaction = this.db.transaction(() => {
      const numberChange = this.db.prepare(
        `INSERT INTO identity_number_changes AS existing
         (event_key, chat_source_id, source_message_key, old_jid, new_jid, actor_jid, source, source_event_key, observed_at_ms, capture_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_key) DO UPDATE SET
           chat_source_id = COALESCE(existing.chat_source_id, excluded.chat_source_id),
           source_message_key = CASE
             WHEN existing.source_message_key IS NULL THEN excluded.source_message_key
             WHEN INSTR(existing.source_message_key, 'live-system-') > 0 AND excluded.source_message_key IS NOT NULL AND INSTR(excluded.source_message_key, 'live-system-') = 0 THEN excluded.source_message_key
             ELSE existing.source_message_key END,
           old_jid = excluded.old_jid, new_jid = excluded.new_jid,
           actor_jid = COALESCE(existing.actor_jid, excluded.actor_jid),
           source = CASE WHEN ${incomingWins} THEN excluded.source ELSE existing.source END,
           source_event_key = CASE WHEN ${incomingWins} THEN COALESCE(excluded.source_event_key, existing.source_event_key) ELSE COALESCE(existing.source_event_key, excluded.source_event_key) END,
           observed_at_ms = ${newestObservedAt},
           capture_version = MAX(existing.capture_version, excluded.capture_version), updated_at = excluded.updated_at`
      );
      const period = this.db.prepare(
        `INSERT INTO group_membership_periods AS existing
         (period_key, group_source_id, participant_jid, joined_at_ms, left_at_ms, role, source, source_event_key, observed_at_ms, capture_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(period_key) DO UPDATE SET
           joined_at_ms = COALESCE(existing.joined_at_ms, excluded.joined_at_ms),
           left_at_ms = COALESCE(existing.left_at_ms, excluded.left_at_ms), role = COALESCE(existing.role, excluded.role),
           source = CASE WHEN ${incomingWins} THEN excluded.source ELSE existing.source END,
           source_event_key = CASE WHEN ${incomingWins} THEN COALESCE(excluded.source_event_key, existing.source_event_key) ELSE COALESCE(existing.source_event_key, excluded.source_event_key) END,
           observed_at_ms = ${newestObservedAt},
           capture_version = MAX(existing.capture_version, excluded.capture_version), updated_at = excluded.updated_at`
      );
      const membershipEvent = this.db.prepare(
        `INSERT INTO group_membership_events AS existing
         (event_key, group_source_id, participant_jid, action, actor_jid, source_message_key, old_role, new_role, raw_type, raw_parameters, source, source_event_key, observed_at_ms, capture_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_key) DO UPDATE SET
           actor_jid = COALESCE(existing.actor_jid, excluded.actor_jid), source_message_key = CASE
             WHEN existing.source_message_key IS NULL THEN excluded.source_message_key
             WHEN INSTR(existing.source_message_key, 'live-system-') > 0 AND excluded.source_message_key IS NOT NULL AND INSTR(excluded.source_message_key, 'live-system-') = 0 THEN excluded.source_message_key
             ELSE existing.source_message_key END,
           old_role = COALESCE(existing.old_role, excluded.old_role), new_role = COALESCE(existing.new_role, excluded.new_role),
           raw_type = COALESCE(existing.raw_type, excluded.raw_type), raw_parameters = COALESCE(existing.raw_parameters, excluded.raw_parameters),
           source = CASE WHEN ${incomingWins} THEN excluded.source ELSE existing.source END,
           source_event_key = CASE WHEN ${incomingWins} THEN COALESCE(excluded.source_event_key, existing.source_event_key) ELSE COALESCE(existing.source_event_key, excluded.source_event_key) END, observed_at_ms = ${newestObservedAt},
           capture_version = MAX(existing.capture_version, excluded.capture_version), updated_at = excluded.updated_at`
      );
      const metadata = this.db.prepare(
        `INSERT INTO chat_metadata_history AS existing
         (event_key, chat_source_id, field, source_message_key, actor_jid, old_value, new_value, raw_type, raw_parameters, source, source_event_key, observed_at_ms, capture_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_key) DO UPDATE SET
           source_message_key = CASE
             WHEN existing.source_message_key IS NULL THEN excluded.source_message_key
             WHEN INSTR(existing.source_message_key, 'live-system-') > 0 AND excluded.source_message_key IS NOT NULL AND INSTR(excluded.source_message_key, 'live-system-') = 0 THEN excluded.source_message_key
             ELSE existing.source_message_key END, actor_jid = COALESCE(existing.actor_jid, excluded.actor_jid),
           old_value = COALESCE(existing.old_value, excluded.old_value), new_value = COALESCE(existing.new_value, excluded.new_value),
           raw_type = COALESCE(existing.raw_type, excluded.raw_type), raw_parameters = COALESCE(existing.raw_parameters, excluded.raw_parameters),
           source = CASE WHEN ${incomingWins} THEN excluded.source ELSE existing.source END,
           source_event_key = CASE WHEN ${incomingWins} THEN COALESCE(excluded.source_event_key, existing.source_event_key) ELSE COALESCE(existing.source_event_key, excluded.source_event_key) END, observed_at_ms = ${newestObservedAt},
           capture_version = MAX(existing.capture_version, excluded.capture_version), updated_at = excluded.updated_at`
      );
      const location = this.db.prepare(
        `INSERT INTO message_locations AS existing
         (source_message_key, latitude, longitude, name, address, is_live, accuracy_meters, url, comment, caption, speed_mps, heading_degrees, sequence_number, time_offset_ms, live_share_duration_ms, final_at_ms, has_thumbnail, source, source_event_key, observed_at_ms, capture_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_message_key) DO UPDATE SET
           latitude = COALESCE(existing.latitude, excluded.latitude), longitude = COALESCE(existing.longitude, excluded.longitude),
           name = COALESCE(existing.name, excluded.name), address = COALESCE(existing.address, excluded.address),
           is_live = CASE
             WHEN existing.live_share_duration_ms = 0 AND existing.sequence_number = 0 AND existing.final_at_ms IS NULL
              AND excluded.live_share_duration_ms IS NULL AND excluded.sequence_number IS NULL AND excluded.final_at_ms IS NULL
              AND excluded.is_live = 0
             THEN 0
             ELSE MAX(existing.is_live, excluded.is_live)
           END,
           accuracy_meters = COALESCE(existing.accuracy_meters, excluded.accuracy_meters),
           url = COALESCE(existing.url, excluded.url), comment = COALESCE(existing.comment, excluded.comment), caption = COALESCE(existing.caption, excluded.caption),
           speed_mps = COALESCE(existing.speed_mps, excluded.speed_mps), heading_degrees = COALESCE(existing.heading_degrees, excluded.heading_degrees),
           sequence_number = CASE
             WHEN existing.live_share_duration_ms = 0 AND existing.sequence_number = 0 AND existing.final_at_ms IS NULL
              AND excluded.live_share_duration_ms IS NULL AND excluded.sequence_number IS NULL AND excluded.final_at_ms IS NULL
              AND excluded.is_live = 0
             THEN NULL
             ELSE COALESCE(existing.sequence_number, excluded.sequence_number)
           END,
           time_offset_ms = COALESCE(existing.time_offset_ms, excluded.time_offset_ms),
           live_share_duration_ms = CASE
             WHEN existing.live_share_duration_ms = 0 AND existing.sequence_number = 0 AND existing.final_at_ms IS NULL
              AND excluded.live_share_duration_ms IS NULL AND excluded.sequence_number IS NULL AND excluded.final_at_ms IS NULL
              AND excluded.is_live = 0
             THEN NULL
             WHEN existing.live_share_duration_ms IS NOT NULL
              AND excluded.live_share_duration_ms = existing.live_share_duration_ms * 1000
             THEN excluded.live_share_duration_ms
             ELSE COALESCE(existing.live_share_duration_ms, excluded.live_share_duration_ms)
           END,
           final_at_ms = COALESCE(existing.final_at_ms, excluded.final_at_ms),
           has_thumbnail = MAX(existing.has_thumbnail, excluded.has_thumbnail),
           source = CASE WHEN ${incomingWins} THEN excluded.source ELSE existing.source END,
           source_event_key = CASE WHEN ${incomingWins} THEN COALESCE(excluded.source_event_key, existing.source_event_key) ELSE COALESCE(existing.source_event_key, excluded.source_event_key) END, observed_at_ms = ${newestObservedAt},
           capture_version = MAX(existing.capture_version, excluded.capture_version), updated_at = excluded.updated_at
         WHERE existing.latitude IS NULL AND excluded.latitude IS NOT NULL
            OR existing.longitude IS NULL AND excluded.longitude IS NOT NULL
            OR existing.name IS NULL AND excluded.name IS NOT NULL
            OR existing.address IS NULL AND excluded.address IS NOT NULL
            OR existing.accuracy_meters IS NULL AND excluded.accuracy_meters IS NOT NULL
            OR existing.url IS NULL AND excluded.url IS NOT NULL
            OR existing.comment IS NULL AND excluded.comment IS NOT NULL
            OR existing.caption IS NULL AND excluded.caption IS NOT NULL
            OR existing.speed_mps IS NULL AND excluded.speed_mps IS NOT NULL
            OR existing.heading_degrees IS NULL AND excluded.heading_degrees IS NOT NULL
            OR existing.sequence_number IS NULL AND excluded.sequence_number IS NOT NULL
            OR existing.time_offset_ms IS NULL AND excluded.time_offset_ms IS NOT NULL
            OR existing.live_share_duration_ms IS NULL AND excluded.live_share_duration_ms IS NOT NULL
            OR existing.live_share_duration_ms IS NOT NULL AND excluded.live_share_duration_ms = existing.live_share_duration_ms * 1000
            OR existing.live_share_duration_ms = 0 AND existing.sequence_number = 0 AND existing.final_at_ms IS NULL AND excluded.live_share_duration_ms IS NULL AND excluded.sequence_number IS NULL AND excluded.final_at_ms IS NULL AND excluded.is_live = 0
            OR existing.final_at_ms IS NULL AND excluded.final_at_ms IS NOT NULL
            OR existing.has_thumbnail <> MAX(existing.has_thumbnail, excluded.has_thumbnail)
            OR existing.is_live <> MAX(existing.is_live, excluded.is_live)
            OR existing.capture_version < excluded.capture_version`
      );
      const vcard = this.db.prepare(
        `INSERT INTO message_vcards AS existing
         (source_message_key, card_index, display_name, vcard, resolved_jid, properties_json, download_kind, download_file_name, source, source_event_key, observed_at_ms, capture_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_message_key, card_index) DO UPDATE SET
           display_name = COALESCE(existing.display_name, excluded.display_name), vcard = COALESCE(existing.vcard, excluded.vcard),
           resolved_jid = COALESCE(existing.resolved_jid, excluded.resolved_jid), properties_json = COALESCE(existing.properties_json, excluded.properties_json),
           download_kind = CASE WHEN existing.download_kind = 'unavailable' THEN excluded.download_kind ELSE existing.download_kind END,
           download_file_name = COALESCE(existing.download_file_name, excluded.download_file_name), source = CASE WHEN ${incomingWins} THEN excluded.source ELSE existing.source END,
           source_event_key = CASE WHEN ${incomingWins} THEN COALESCE(excluded.source_event_key, existing.source_event_key) ELSE COALESCE(existing.source_event_key, excluded.source_event_key) END, observed_at_ms = ${newestObservedAt},
           capture_version = MAX(existing.capture_version, excluded.capture_version), updated_at = excluded.updated_at
         WHERE existing.display_name IS NULL AND excluded.display_name IS NOT NULL
            OR existing.vcard IS NULL AND excluded.vcard IS NOT NULL
            OR existing.resolved_jid IS NULL AND excluded.resolved_jid IS NOT NULL
            OR existing.properties_json IS NULL AND excluded.properties_json IS NOT NULL
            OR existing.download_kind = 'unavailable' AND excluded.download_kind <> 'unavailable'
            OR existing.capture_version < excluded.capture_version`
      );
      const locationObservation = this.db.prepare(
        `INSERT INTO message_location_observations AS existing
         (observation_key, source_message_key, latitude, longitude, accuracy_meters, speed_mps, heading_degrees, sequence_number, time_offset_ms, final_at_ms, has_thumbnail, source, source_event_key, observed_at_ms, capture_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(observation_key) DO UPDATE SET
           latitude = COALESCE(existing.latitude, excluded.latitude), longitude = COALESCE(existing.longitude, excluded.longitude),
           accuracy_meters = COALESCE(existing.accuracy_meters, excluded.accuracy_meters), speed_mps = COALESCE(existing.speed_mps, excluded.speed_mps),
           heading_degrees = COALESCE(existing.heading_degrees, excluded.heading_degrees), sequence_number = COALESCE(existing.sequence_number, excluded.sequence_number),
           time_offset_ms = COALESCE(existing.time_offset_ms, excluded.time_offset_ms), final_at_ms = COALESCE(existing.final_at_ms, excluded.final_at_ms),
           has_thumbnail = MAX(existing.has_thumbnail, excluded.has_thumbnail), source = CASE WHEN ${incomingWins} THEN excluded.source ELSE existing.source END,
           source_event_key = CASE WHEN ${incomingWins} THEN COALESCE(excluded.source_event_key, existing.source_event_key) ELSE COALESCE(existing.source_event_key, excluded.source_event_key) END, observed_at_ms = ${newestObservedAt}, capture_version = MAX(existing.capture_version, excluded.capture_version), updated_at = excluded.updated_at`
      );
      const edit = this.db.prepare(
        `INSERT INTO message_edit_events AS existing
         (event_key, source_message_key, original_source_message_id, observed_edit_message_id, source, source_event_key, observed_at_ms, capture_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_key) DO UPDATE SET
           original_source_message_id = COALESCE(existing.original_source_message_id, excluded.original_source_message_id),
           observed_edit_message_id = COALESCE(existing.observed_edit_message_id, excluded.observed_edit_message_id),
           source = CASE WHEN ${incomingWins} THEN excluded.source ELSE existing.source END,
           source_event_key = CASE WHEN ${incomingWins} THEN COALESCE(excluded.source_event_key, existing.source_event_key) ELSE COALESCE(existing.source_event_key, excluded.source_event_key) END, observed_at_ms = ${newestObservedAt},
           capture_version = MAX(existing.capture_version, excluded.capture_version), updated_at = excluded.updated_at`
      );
      const deletion = this.db.prepare(
        `INSERT INTO message_deletions AS existing
         (source_message_key, revoked_by_jid, revoked_by_admin, deletion_kind, source, source_event_key, observed_at_ms, capture_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_message_key) DO UPDATE SET
           revoked_by_jid = COALESCE(existing.revoked_by_jid, excluded.revoked_by_jid),
           revoked_by_admin = COALESCE(existing.revoked_by_admin, excluded.revoked_by_admin), deletion_kind = COALESCE(existing.deletion_kind, excluded.deletion_kind),
           source = CASE WHEN ${incomingWins} THEN excluded.source ELSE existing.source END,
           source_event_key = CASE WHEN ${incomingWins} THEN COALESCE(excluded.source_event_key, existing.source_event_key) ELSE COALESCE(existing.source_event_key, excluded.source_event_key) END, observed_at_ms = ${newestObservedAt},
           capture_version = MAX(existing.capture_version, excluded.capture_version), updated_at = excluded.updated_at
         WHERE existing.revoked_by_jid IS NULL AND excluded.revoked_by_jid IS NOT NULL
            OR existing.revoked_by_admin IS NULL AND excluded.revoked_by_admin IS NOT NULL
            OR existing.deletion_kind IS NULL AND excluded.deletion_kind IS NOT NULL
            OR existing.observed_at_ms IS NULL AND excluded.observed_at_ms IS NOT NULL
            OR existing.capture_version < excluded.capture_version`
      );
      const interpretation = this.db.prepare(
        `INSERT INTO message_media_interpretations AS existing
         (source_message_key, kind, segment_index, text, start_ms, end_ms, source, source_event_key, observed_at_ms, capture_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_message_key, kind, segment_index) DO UPDATE SET
           text = CASE WHEN LENGTH(existing.text) >= LENGTH(excluded.text) THEN existing.text ELSE excluded.text END,
           start_ms = COALESCE(existing.start_ms, excluded.start_ms),
           end_ms = CASE
             WHEN existing.kind = 'transcription_segment'
              AND excluded.end_ms IS NULL
              AND existing.start_ms IS NOT NULL
              AND existing.end_ms = existing.start_ms
             THEN NULL
             ELSE COALESCE(existing.end_ms, excluded.end_ms)
           END,
           source = CASE WHEN ${incomingWins} THEN excluded.source ELSE existing.source END,
           source_event_key = CASE WHEN ${incomingWins} THEN COALESCE(excluded.source_event_key, existing.source_event_key) ELSE COALESCE(existing.source_event_key, excluded.source_event_key) END, observed_at_ms = ${newestObservedAt},
           capture_version = MAX(existing.capture_version, excluded.capture_version), updated_at = excluded.updated_at
         WHERE LENGTH(excluded.text) > LENGTH(existing.text)
            OR existing.capture_version < excluded.capture_version
            OR existing.kind = 'transcription_segment' AND excluded.end_ms IS NULL AND existing.start_ms IS NOT NULL AND existing.end_ms = existing.start_ms`
      );
      const aggregate = this.db.prepare(
        `INSERT INTO engagement_aggregates AS existing
         (aggregate_key, chat_source_id, counterparty_jid, eligible_outgoing_count, delivered_count, read_count, response_latency_sample_count,
          median_response_latency_ms, window_start_at_ms, window_end_at_ms, algorithm_version, source, source_event_key, observed_at_ms, capture_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(aggregate_key) DO UPDATE SET
           eligible_outgoing_count = CASE WHEN excluded.eligible_outgoing_count >= existing.eligible_outgoing_count THEN excluded.eligible_outgoing_count ELSE existing.eligible_outgoing_count END,
           delivered_count = CASE WHEN excluded.delivered_count >= existing.delivered_count THEN excluded.delivered_count ELSE existing.delivered_count END,
           read_count = CASE WHEN excluded.read_count >= existing.read_count THEN excluded.read_count ELSE existing.read_count END,
           response_latency_sample_count = CASE WHEN excluded.response_latency_sample_count >= existing.response_latency_sample_count THEN excluded.response_latency_sample_count ELSE existing.response_latency_sample_count END,
           median_response_latency_ms = COALESCE(excluded.median_response_latency_ms, existing.median_response_latency_ms),
           window_start_at_ms = COALESCE(existing.window_start_at_ms, excluded.window_start_at_ms),
           window_end_at_ms = CASE WHEN existing.window_end_at_ms IS NULL THEN excluded.window_end_at_ms WHEN excluded.window_end_at_ms IS NULL THEN existing.window_end_at_ms ELSE MAX(existing.window_end_at_ms, excluded.window_end_at_ms) END,
           algorithm_version = MAX(existing.algorithm_version, excluded.algorithm_version), source = CASE WHEN ${incomingWins} THEN excluded.source ELSE existing.source END,
           source_event_key = CASE WHEN ${incomingWins} THEN COALESCE(excluded.source_event_key, existing.source_event_key) ELSE COALESCE(existing.source_event_key, excluded.source_event_key) END, observed_at_ms = ${newestObservedAt}, capture_version = MAX(existing.capture_version, excluded.capture_version), updated_at = excluded.updated_at`
      );
      const observation = this.db.prepare(
        `INSERT INTO archive_signal_observations AS existing
         (fact_key, family, source, source_event_key, source_message_key, observed_at_ms, capture_version, detail_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(fact_key, family, source, source_event_key) DO UPDATE SET
           source_message_key = COALESCE(existing.source_message_key, excluded.source_message_key),
           observed_at_ms = ${newestObservedAt}, capture_version = MAX(existing.capture_version, excluded.capture_version),
           detail_json = COALESCE(existing.detail_json, excluded.detail_json), updated_at = excluded.updated_at`
      );
      const priorEditBySourceObservation = this.db.prepare(
        `SELECT event_key FROM message_edit_events
         WHERE source_message_key = ? AND source = ? AND source_event_key = ? AND event_key <> ?`
      );
      const legacyEnvelopeTimeEdits = this.db.prepare(
        `SELECT e.event_key
         FROM message_edit_events e
         JOIN messages m ON m.source_message_key = e.source_message_key
         WHERE e.source_message_key = ?
           AND e.source = 'live'
           AND e.source_event_key LIKE 'wa-web:edit:%'
           AND e.observed_at_ms = m.timestamp_ms
           AND ? > m.timestamp_ms
           AND e.event_key <> ?`
      );
      const moveEditObservations = this.db.prepare(
        `INSERT OR IGNORE INTO archive_signal_observations
         (fact_key, family, source, source_event_key, source_message_key, observed_at_ms, capture_version, detail_json, updated_at)
         SELECT ?, family, source, source_event_key, source_message_key, observed_at_ms, capture_version, detail_json, ?
         FROM archive_signal_observations WHERE fact_key = ? AND family = 'edit'`
      );
      const deleteEditObservations = this.db.prepare(
        `DELETE FROM archive_signal_observations WHERE fact_key = ? AND family = 'edit'`
      );
      const deleteEditFact = this.db.prepare(`DELETE FROM message_edit_events WHERE event_key = ?`);
      const now = currentIso();
      const observe = (factKey: string, family: string, row: { source: string; sourceEventKey: string | null; observedAtMs: number | null; captureVersion: number; sourceMessageKey?: string | null }, detail: unknown = null) =>
        observation.run(factKey, family, row.source, row.sourceEventKey ?? "", row.sourceMessageKey ?? null, row.observedAtMs, row.captureVersion, detail == null ? null : JSON.stringify(detail), now);
      for (const row of numberChanges) {
        numberChange.run(row.eventKey, canonical(row.chatSourceId), row.sourceMessageKey, canonical(row.oldJid), canonical(row.newJid), canonical(row.actorJid), row.source, row.sourceEventKey, row.observedAtMs, row.captureVersion, now);
        observe(row.eventKey, "number_change", row);
      }
      for (const row of membershipPeriods) period.run(row.periodKey, canonical(row.groupSourceId), canonical(row.participantJid), row.joinedAtMs, row.leftAtMs, row.role, row.source, row.sourceEventKey, row.observedAtMs, row.captureVersion, now);
      for (const row of membershipPeriods) observe(row.periodKey, "membership_period", row);
      for (const row of membershipEvents) {
        membershipEvent.run(row.eventKey, canonical(row.groupSourceId), canonical(row.participantJid), row.action, canonical(row.actorJid), row.sourceMessageKey, row.oldRole ?? null, row.newRole ?? null, row.rawType ?? null, row.rawParameters ?? null, row.source, row.sourceEventKey, row.observedAtMs, row.captureVersion, now);
        observe(row.eventKey, "membership_event", row, { rawType: row.rawType ?? null, rawParameters: row.rawParameters ?? null });
      }
      for (const row of chatMetadataHistory) {
        metadata.run(row.eventKey, canonical(row.chatSourceId), row.field, row.sourceMessageKey, canonical(row.actorJid), row.oldValue, row.newValue, row.rawType ?? null, row.rawParameters ?? null, row.source, row.sourceEventKey, row.observedAtMs, row.captureVersion, now);
        observe(row.eventKey, "chat_metadata", row, { rawType: row.rawType ?? null, rawParameters: row.rawParameters ?? null });
      }
      for (const row of locations) {
        if (location.run(row.sourceMessageKey, row.latitude, row.longitude, row.name, row.address, Number(row.isLive), row.accuracyMeters, row.url ?? null, row.comment ?? null, row.caption ?? null, row.speedMps ?? null, row.headingDegrees ?? null, row.sequenceNumber ?? null, row.timeOffsetMs ?? null, row.liveShareDurationMs ?? null, row.finalAtMs ?? null, Number(row.hasThumbnail ?? false), row.source, row.sourceEventKey, row.observedAtMs, row.captureVersion, now).changes) changedMessageKeys.add(row.sourceMessageKey);
        observe(row.sourceMessageKey, "location", row);
      }
      for (const row of locationObservations) {
        if (locationObservation.run(row.observationKey, row.sourceMessageKey, row.latitude, row.longitude, row.accuracyMeters, row.speedMps, row.headingDegrees, row.sequenceNumber, row.timeOffsetMs, row.finalAtMs, Number(row.hasThumbnail), row.source, row.sourceEventKey, row.observedAtMs, row.captureVersion, now).changes) changedMessageKeys.add(row.sourceMessageKey);
        observe(row.observationKey, "location_observation", row);
      }
      for (const row of vcards) {
        if (vcard.run(row.sourceMessageKey, row.cardIndex, row.displayName, row.vcard, canonical(row.resolvedJid), row.properties ? JSON.stringify(row.properties) : null, row.downloadKind ?? (row.vcard ? "source" : "unavailable"), row.downloadFileName ?? null, row.source, row.sourceEventKey, row.observedAtMs, row.captureVersion, now).changes) changedMessageKeys.add(row.sourceMessageKey);
        observe(`${row.sourceMessageKey}:${row.cardIndex}`, "vcard", row);
      }
      for (const row of editEvents) {
        const legacyKeys = new Set<string>();
        if (row.sourceEventKey) {
          for (const prior of priorEditBySourceObservation.all(row.sourceMessageKey, row.source, row.sourceEventKey, row.eventKey) as Array<{ event_key: string }>) legacyKeys.add(prior.event_key);
        }
        if (row.observedAtMs != null) {
          for (const prior of legacyEnvelopeTimeEdits.all(row.sourceMessageKey, row.observedAtMs, row.eventKey) as Array<{ event_key: string }>) legacyKeys.add(prior.event_key);
        }
        for (const oldKey of legacyKeys) {
          moveEditObservations.run(row.eventKey, now, oldKey);
          deleteEditObservations.run(oldKey);
          deleteEditFact.run(oldKey);
        }
        if (edit.run(row.eventKey, row.sourceMessageKey, row.originalSourceMessageId, row.observedEditMessageId, row.source, row.sourceEventKey, row.observedAtMs, row.captureVersion, now).changes) changedMessageKeys.add(row.sourceMessageKey);
        observe(row.eventKey, "edit", row);
      }
      for (const row of deletions) {
        if (deletion.run(row.sourceMessageKey, canonical(row.revokedByJid), row.revokedByAdmin == null ? null : Number(row.revokedByAdmin), row.deletionKind ?? null, row.source, row.sourceEventKey, row.observedAtMs, row.captureVersion, now).changes) changedMessageKeys.add(row.sourceMessageKey);
        observe(row.sourceMessageKey, "deletion", row);
      }
      for (const row of mediaInterpretations) {
        if (interpretation.run(row.sourceMessageKey, row.kind, row.segmentIndex, row.text, row.startMs, row.endMs, row.source, row.sourceEventKey, row.observedAtMs, row.captureVersion, now).changes) changedMessageKeys.add(row.sourceMessageKey);
        observe(`${row.sourceMessageKey}:${row.kind}:${row.segmentIndex}`, "media_interpretation", row);
      }
      for (const row of batch.engagementAggregates ?? []) aggregate.run(row.aggregateKey, canonical(row.chatSourceId), canonical(row.counterpartyJid), row.eligibleOutgoingCount, row.deliveredCount, row.readCount, row.responseLatencySampleCount, row.medianResponseLatencyMs, row.windowStartAtMs, row.windowEndAtMs, row.algorithmVersion, row.source, row.sourceEventKey, row.observedAtMs, row.captureVersion, now);
    });
    transaction();
    const changed = [...changedMessageKeys];
    if (changed.length > 0) {
      await this.markStaleEpisodesForMessages(changed);
    }
    return { changedMessageKeys: changed, skippedUnanchoredRecords };
  }

  async repairAmbiguousSelfMembershipFacts(): Promise<number> {
    const rows = this.db.prepare(
      `SELECT event_key FROM group_membership_events
       WHERE participant_jid = 'me' AND source = 'backup' AND source_event_key LIKE 'backup:message_system_group:%'`
    ).all() as Array<{ event_key: string }>;
    if (rows.length === 0) return 0;
    // This is the only destructive repair in this change. Snapshot first; the
    // source system messages stay in place as generic rows, so no timeline
    // content is lost if the repair is later rolled back.
    await this.createRestorePoint("before-role-correct-system-event-repair");
    this.db.transaction(() => {
      const removeObservation = this.db.prepare(`DELETE FROM archive_signal_observations WHERE family = 'membership_event' AND fact_key = ?`);
      const removeEvent = this.db.prepare(`DELETE FROM group_membership_events WHERE event_key = ?`);
      for (const row of rows) {
        removeObservation.run(row.event_key);
        removeEvent.run(row.event_key);
      }
    })();
    return rows.length;
  }

  async listIdentityNumberChanges(options: { oldJid?: string; newJid?: string; limit?: number } = {}): Promise<IdentityNumberChangeRecord[]> {
    const values: unknown[] = [];
    const clauses: string[] = [];
    if (options.oldJid) { clauses.push("old_jid = ?"); values.push(this.canonicalJid(options.oldJid) ?? options.oldJid); }
    if (options.newJid) { clauses.push("new_jid = ?"); values.push(this.canonicalJid(options.newJid) ?? options.newJid); }
    values.push(options.limit ?? 500);
    const rows = this.db.prepare(`SELECT * FROM identity_number_changes ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY observed_at_ms DESC LIMIT ?`).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => numberChangeFromRow(row));
  }

  async listGroupMembershipPeriods(options: { groupSourceId?: string; participantJid?: string; limit?: number } = {}): Promise<GroupMembershipPeriodRecord[]> {
    const values: unknown[] = [];
    const clauses: string[] = [];
    if (options.groupSourceId) { clauses.push("group_source_id = ?"); values.push(this.canonicalJid(options.groupSourceId) ?? options.groupSourceId); }
    if (options.participantJid) { clauses.push("participant_jid = ?"); values.push(this.canonicalJid(options.participantJid) ?? options.participantJid); }
    values.push(options.limit ?? 500);
    const rows = this.db.prepare(`SELECT * FROM group_membership_periods ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY joined_at_ms DESC LIMIT ?`).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => membershipPeriodFromRow(row));
  }

  async listGroupMembershipEvents(options: { groupSourceId?: string; participantJid?: string; limit?: number } = {}): Promise<GroupMembershipEventRecord[]> {
    const values: unknown[] = [];
    const clauses: string[] = [];
    if (options.groupSourceId) { clauses.push("group_source_id = ?"); values.push(this.canonicalJid(options.groupSourceId) ?? options.groupSourceId); }
    if (options.participantJid) { clauses.push("participant_jid = ?"); values.push(this.canonicalJid(options.participantJid) ?? options.participantJid); }
    values.push(options.limit ?? 500);
    const rows = this.db.prepare(`SELECT * FROM group_membership_events ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY observed_at_ms DESC LIMIT ?`).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => membershipEventFromRow(row));
  }

  async listChatMetadataHistory(options: { chatSourceId?: string; limit?: number } = {}): Promise<ChatMetadataHistoryRecord[]> {
    const values: unknown[] = [];
    const where = options.chatSourceId ? "WHERE chat_source_id = ?" : "";
    if (options.chatSourceId) values.push(this.canonicalJid(options.chatSourceId) ?? options.chatSourceId);
    values.push(options.limit ?? 500);
    const rows = this.db.prepare(`SELECT * FROM chat_metadata_history ${where} ORDER BY observed_at_ms DESC LIMIT ?`).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => chatMetadataFromRow(row));
  }

  async listEngagementAggregates(options: { chatSourceId?: string; counterpartyJid?: string; limit?: number } = {}): Promise<EngagementAggregateRecord[]> {
    const values: unknown[] = [];
    const clauses: string[] = [];
    if (options.chatSourceId) { clauses.push("chat_source_id = ?"); values.push(this.canonicalJid(options.chatSourceId) ?? options.chatSourceId); }
    if (options.counterpartyJid) { clauses.push("counterparty_jid = ?"); values.push(this.canonicalJid(options.counterpartyJid) ?? options.counterpartyJid); }
    values.push(options.limit ?? 500);
    const rows = this.db.prepare(`SELECT * FROM engagement_aggregates ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY window_end_at_ms DESC LIMIT ?`).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => engagementFromRow(row));
  }

  async refreshChatStats(chatSourceIds?: string[]): Promise<void> {
    // Chat recency mirrors WhatsApp: only user-visible conversation messages
    // advance a chat's position/date; system, status, and reaction events do not.
    const statsSql = `UPDATE chats
       SET message_count = (SELECT COUNT(*) FROM messages WHERE messages.chat_id = chats.id),
           participant_count = (SELECT COUNT(*) FROM chat_participants WHERE chat_participants.chat_id = chats.id),
           last_message_at_ms = (
             SELECT MAX(timestamp_ms) FROM messages
             WHERE messages.chat_id = chats.id AND ${visibleExchangePredicate("messages")}
           ),
           last_message_at = (
             SELECT sent_at FROM messages
             WHERE messages.chat_id = chats.id AND ${visibleExchangePredicate("messages")}
             ORDER BY timestamp_ms DESC, id DESC
             LIMIT 1
           )`;
    if (!chatSourceIds) {
      this.db.exec(statsSql);
      return;
    }
    const unique = [...new Set(chatSourceIds)].filter(Boolean);
    if (unique.length === 0) {
      return;
    }
    const scoped = this.db.prepare(`${statsSql} WHERE chats.source_chat_id IN (${unique.map(() => "?").join(",")})`);
    for (let index = 0; index < unique.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      scoped.run(...unique.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE));
    }
  }

  async clearArchiveData(): Promise<void> {
    this.db.transaction(() => {
      for (const table of DELETE_TABLE_ORDER) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
      this.clearSqliteSequence();
    })();
    // A cleared archive is a valid fresh start under the current identity scheme.
    this.stampIdentityVersion();
    // Deleting messages emptied the FTS index through its triggers, so a
    // cleared archive is consistent and searchable from the start.
    this.setFtsState("ready");
    this.identityLinks.clear();
  }

  async getStatus(): Promise<StatusSummary> {
    if (!this.isInitialized()) {
      return emptyStatus(false);
    }
    const counts = this.db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM chats) AS chats,
          (SELECT COUNT(*) FROM contacts) AS contacts,
          (SELECT COUNT(*) FROM chat_participants) AS participants,
          (SELECT COUNT(*) FROM messages) AS messages,
          (SELECT COUNT(*) FROM import_warnings) AS warnings`
      )
      .get() as Record<string, number>;
    const latestRun = this.db
      .prepare(
        `SELECT id, status, started_at, finished_at, totals_json, warning_count, error_message
         FROM import_runs
         ORDER BY started_at DESC
         LIMIT 1`
      )
      .get() as SqliteImportRunRow | undefined;
    const latestImport = latestRun ? rowToImportSummary(latestRun) : null;
    const latestWarnings = latestImport ? this.getLatestWarnings(latestImport.id) : [];

    return {
      database: {
        configured: true,
        initialized: true,
        adapter: "sqlite",
        location: path.basename(this.dbPath),
        ...(this.legacyArchive ? { error: LEGACY_ARCHIVE_MESSAGE } : {})
      },
      counts: {
        chats: Number(counts.chats ?? 0),
        contacts: Number(counts.contacts ?? 0),
        participants: Number(counts.participants ?? 0),
        messages: Number(counts.messages ?? 0),
        warnings: Number(counts.warnings ?? 0)
      },
      latestImport,
      latestWarnings,
      live: await this.getLiveStatus(),
      memory: await this.getMemoryStatus(await getMemoryProviderStatus())
    };
  }

  async upsertLiveSession(session: Partial<LiveSessionSummary> & { id: string; status: LiveSessionSummary["status"]; clientName: string }): Promise<void> {
    const existing = this.db
      .prepare(`SELECT created_at FROM live_sessions WHERE id = ?`)
      .get(session.id) as { created_at: string } | undefined;
    const now = currentIso();
    this.db
      .prepare(
        `INSERT INTO live_sessions
         (id, status, client_name, linked_device_jid, last_connected_at, last_disconnected_at, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           client_name = excluded.client_name,
           linked_device_jid = COALESCE(excluded.linked_device_jid, live_sessions.linked_device_jid),
           last_connected_at = COALESCE(excluded.last_connected_at, live_sessions.last_connected_at),
           last_disconnected_at = COALESCE(excluded.last_disconnected_at, live_sessions.last_disconnected_at),
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`
      )
      .run(
        session.id,
        session.status,
        session.clientName,
        session.linkedDeviceJid ?? null,
        session.lastConnectedAt ?? null,
        session.lastDisconnectedAt ?? null,
        session.lastError ?? null,
        existing?.created_at ?? session.createdAt ?? now,
        now
      );
  }

  async startLiveSyncRun(sourceSummary: Record<string, unknown>): Promise<string> {
    this.assertWritableIdentityVersion();
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO live_sync_runs (id, status, started_at, client_name, source_summary_json, totals_json)
         VALUES (?, 'running', ?, ?, ?, ?)`
      )
      .run(id, currentIso(), String(sourceSummary.client ?? "baileys"), stringifyJson(sourceSummary), stringifyJson(emptyLiveTotals()));
    return id;
  }

  async completeLiveSyncRun(runId: string, totals: LiveSyncTotals, warningCount: number): Promise<void> {
    this.db
      .prepare(
        `UPDATE live_sync_runs
         SET status = 'completed', finished_at = ?, totals_json = ?, warning_count = ?
         WHERE id = ?`
      )
      .run(currentIso(), stringifyJson(totals), warningCount, runId);
  }

  async failLiveSyncRun(
    runId: string,
    code: string,
    message: string,
    totals: LiveSyncTotals = emptyLiveTotals(),
    warningCount = 0
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE live_sync_runs
         SET status = 'failed', finished_at = ?, totals_json = ?, warning_count = ?, error_code = ?, error_message = ?
         WHERE id = ?`
      )
      .run(currentIso(), stringifyJson(totals), warningCount, code, message.slice(0, 500), runId);
  }

  async upsertLiveCheckpoint(checkpoint: LiveChatCheckpointRecord): Promise<void> {
    const chatId = checkpoint.chatId ?? this.getChatIds([checkpoint.chatSourceId]).get(checkpoint.chatSourceId) ?? null;
    this.db
      .prepare(
        `INSERT INTO live_chat_checkpoints
         (chat_source_id, chat_id, latest_archived_message_key, latest_archived_at_ms, earliest_archived_message_key,
          earliest_archived_at_ms, latest_live_message_key, latest_live_at_ms, oldest_verified_message_key,
          oldest_verified_at_ms, health, retry_count, next_recovery_at, last_audit_at, raw_metadata_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_source_id) DO UPDATE SET
           chat_id = COALESCE(excluded.chat_id, live_chat_checkpoints.chat_id),
           latest_archived_message_key = excluded.latest_archived_message_key,
           latest_archived_at_ms = excluded.latest_archived_at_ms,
           earliest_archived_message_key = excluded.earliest_archived_message_key,
           earliest_archived_at_ms = excluded.earliest_archived_at_ms,
           latest_live_message_key = excluded.latest_live_message_key,
           latest_live_at_ms = excluded.latest_live_at_ms,
           oldest_verified_message_key = excluded.oldest_verified_message_key,
           oldest_verified_at_ms = excluded.oldest_verified_at_ms,
           health = excluded.health,
           retry_count = excluded.retry_count,
           next_recovery_at = excluded.next_recovery_at,
           last_audit_at = excluded.last_audit_at,
           raw_metadata_json = excluded.raw_metadata_json,
           updated_at = excluded.updated_at`
      )
      .run(
        checkpoint.chatSourceId,
        chatId,
        checkpoint.latestArchivedMessageKey ?? null,
        checkpoint.latestArchivedAtMs ?? null,
        checkpoint.earliestArchivedMessageKey ?? null,
        checkpoint.earliestArchivedAtMs ?? null,
        checkpoint.latestLiveMessageKey ?? null,
        checkpoint.latestLiveAtMs ?? null,
        checkpoint.oldestVerifiedMessageKey ?? null,
        checkpoint.oldestVerifiedAtMs ?? null,
        checkpoint.health,
        checkpoint.retryCount,
        checkpoint.nextRecoveryAt ?? null,
        checkpoint.lastAuditAt ?? null,
        stringifyJson(checkpoint.rawMetadata ?? null),
        currentIso()
      );
  }

  async listLiveCheckpoints(chatSourceIds?: string[]): Promise<LiveChatCheckpointRecord[]> {
    const unique = chatSourceIds ? [...new Set(chatSourceIds)].filter(Boolean) : null;
    if (unique && unique.length === 0) {
      return [];
    }
    const where = unique ? `WHERE chat_source_id IN (${unique.map(() => "?").join(",")})` : "";
    const rows = this.db
      .prepare(`SELECT * FROM live_chat_checkpoints ${where} ORDER BY updated_at DESC`)
      .all(...(unique ?? [])) as SqliteLiveCheckpointRow[];
    return rows.map(rowToLiveCheckpoint);
  }

  async listChatSyncStates(chatSourceIds?: string[]): Promise<ChatSyncStateRecord[]> {
    const unique = chatSourceIds ? [...new Set(chatSourceIds)].filter(Boolean) : null;
    if (unique && unique.length === 0) {
      return [];
    }
    const where = unique ? `WHERE chats.source_chat_id IN (${unique.map(() => "?").join(",")})` : "";
    const rows = this.db
      .prepare(
        `SELECT chats.source_chat_id,
                chats.platform_recency_ms,
                latest.timestamp_ms AS latest_at_ms,
                latest.source_message_id AS latest_message_id,
                earliest.timestamp_ms AS earliest_at_ms,
                earliest.source_message_id AS earliest_message_id
         FROM chats
         LEFT JOIN (
           SELECT chat_id, timestamp_ms, source_message_id,
                  ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY timestamp_ms DESC, id DESC) AS rn
           FROM messages
         ) latest ON latest.chat_id = chats.id AND latest.rn = 1
         LEFT JOIN (
           SELECT chat_id, timestamp_ms, source_message_id,
                  ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY timestamp_ms ASC, id ASC) AS rn
           FROM messages
         ) earliest ON earliest.chat_id = chats.id AND earliest.rn = 1
         ${where}`
      )
      .all(...(unique ?? [])) as Array<{
      source_chat_id: string;
      platform_recency_ms: number | null;
      latest_at_ms: number | null;
      latest_message_id: string | null;
      earliest_at_ms: number | null;
      earliest_message_id: string | null;
    }>;
    return rows.map((row) => ({
      chatSourceId: row.source_chat_id,
      latestArchivedAtMs: row.latest_at_ms == null ? null : Number(row.latest_at_ms),
      latestArchivedMessageId: row.latest_message_id ?? null,
      earliestArchivedAtMs: row.earliest_at_ms == null ? null : Number(row.earliest_at_ms),
      earliestArchivedMessageId: row.earliest_message_id ?? null,
      platformRecencyMs: row.platform_recency_ms == null ? null : Number(row.platform_recency_ms)
    }));
  }

  async getRecoveryAnchor(chatSourceId: string, afterMs: number | null): Promise<RecoveryAnchorRecord | null> {
    const row = this.db
      .prepare(
        `SELECT m.source_message_id, m.timestamp_ms, m.from_me, m.sender_source_jid
         FROM messages m
         JOIN chats c ON c.id = m.chat_id
         WHERE c.source_chat_id = ?
           AND m.timestamp_ms IS NOT NULL
           AND (? IS NULL OR m.timestamp_ms > ?)
         ORDER BY m.timestamp_ms ASC, m.id ASC
         LIMIT 1`
      )
      .get(chatSourceId, afterMs ?? null, afterMs ?? null) as
      | { source_message_id: string; timestamp_ms: number; from_me: number | null; sender_source_jid: string | null }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      sourceMessageId: row.source_message_id,
      timestampMs: Number(row.timestamp_ms),
      fromMe: row.from_me == null ? null : Boolean(row.from_me),
      senderSourceJid: row.sender_source_jid ?? null
    };
  }

  async upsertLiveGap(gap: LiveGapWindowRecord): Promise<number> {
    const chatId = gap.chatId ?? this.getChatIds([gap.chatSourceId]).get(gap.chatSourceId) ?? null;
    if (gap.id) {
      this.db
        .prepare(
          `UPDATE live_gap_windows
           SET chat_source_id = ?, chat_id = ?, reason = ?, status = ?, start_at_ms = ?, end_at_ms = ?,
               required_lower_bound_at_ms = ?, anchor_message_key = ?, request_count = ?, last_attempt_at = ?,
               confidence = ?, notes = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          gap.chatSourceId,
          chatId,
          gap.reason,
          gap.status,
          gap.startAtMs ?? null,
          gap.endAtMs ?? null,
          gap.requiredLowerBoundAtMs ?? null,
          gap.anchorMessageKey ?? null,
          gap.requestCount,
          gap.lastAttemptAt ?? null,
          gap.confidence,
          gap.notes ?? null,
          currentIso(),
          gap.id
        );
      return gap.id;
    }
    const result = this.db
      .prepare(
        `INSERT INTO live_gap_windows
         (chat_source_id, chat_id, reason, status, start_at_ms, end_at_ms, required_lower_bound_at_ms,
          anchor_message_key, request_count, last_attempt_at, confidence, notes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        gap.chatSourceId,
        chatId,
        gap.reason,
        gap.status,
        gap.startAtMs ?? null,
        gap.endAtMs ?? null,
        gap.requiredLowerBoundAtMs ?? null,
        gap.anchorMessageKey ?? null,
        gap.requestCount,
        gap.lastAttemptAt ?? null,
        gap.confidence,
        gap.notes ?? null,
        currentIso()
      );
    return Number(result.lastInsertRowid);
  }

  async updateLiveGapStatus(id: number, status: LiveGapStatus, notes?: string | null): Promise<void> {
    this.db
      .prepare(`UPDATE live_gap_windows SET status = ?, notes = COALESCE(?, notes), updated_at = ? WHERE id = ?`)
      .run(status, notes ?? null, currentIso(), id);
  }

  async listLiveGaps(statuses?: LiveGapStatus[]): Promise<LiveGapWindowRecord[]> {
    const where = statuses?.length ? `WHERE status IN (${statuses.map(() => "?").join(",")})` : "";
    const rows = this.db
      .prepare(`SELECT * FROM live_gap_windows ${where} ORDER BY updated_at DESC`)
      .all(...(statuses ?? [])) as SqliteLiveGapRow[];
    return rows.map(rowToLiveGap);
  }

  async recordLiveEventReceipt(receipt: LiveEventReceiptRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO live_event_receipts
         (event_key, event_type, chat_source_id, message_key, occurred_at_ms, processed_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_key) DO UPDATE SET processed_at = excluded.processed_at`
      )
      .run(
        receipt.eventKey,
        receipt.eventType,
        receipt.chatSourceId ?? null,
        receipt.messageKey ?? null,
        receipt.occurredAtMs ?? null,
        receipt.processedAt ?? currentIso(),
        stringifyJson(receipt.metadata ?? null)
      );
  }

  async hasLiveEventReceipt(eventKey: string): Promise<boolean> {
    const row = this.db.prepare(`SELECT 1 AS found FROM live_event_receipts WHERE event_key = ?`).get(eventKey) as { found: number } | undefined;
    return Boolean(row);
  }

  async applyLiveMessageUpdates(rawUpdates: Array<Omit<LiveMessageUpdateRecord, "applied">>): Promise<LiveMessageUpdateResult> {
    this.assertWritableIdentityVersion();
    // Updates may target a LID-form chat; canonicalize and re-derive the key.
    const updates = rawUpdates.map((update) => {
      const chatSourceId = this.canonicalJid(update.chatSourceId) ?? update.chatSourceId;
      const targetId = messageIdFromKey(update.sourceMessageKey);
      return {
        ...update,
        chatSourceId,
        sourceMessageKey: targetId ? messageKey(chatSourceId, targetId) : update.sourceMessageKey
      };
    });
    let applied = 0;
    let pending = 0;
    const insert = this.db.prepare(
      `INSERT INTO live_message_updates
       (event_key, chat_source_id, source_message_key, update_type, occurred_at_ms, applied, metadata_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_key) DO UPDATE SET
         applied = MAX(live_message_updates.applied, excluded.applied),
         metadata_json = COALESCE(excluded.metadata_json, live_message_updates.metadata_json),
         updated_at = excluded.updated_at`
    );
    // Deletion tombstones only: held body/caption (and stored media) stay —
    // the archive is a backup store, and blanking captured content would
    // silently destroy it. The "Deleted message" placeholder appears only when
    // nothing was ever captured.
    const markDeleted = this.db.prepare(
      `UPDATE messages
       SET is_deleted = 1,
           raw_metadata_json = COALESCE(raw_metadata_json, ?)
       WHERE source_message_key = ?`
    );
    const applyEdit = this.db.prepare(
      `UPDATE messages
       SET body = ?,
           raw_metadata_json = json_set(COALESCE(raw_metadata_json, '{}'), '$.edited', 1)
       WHERE source_message_key = ?`
    );
    // Edit history: snapshot the current content as a retained revision before
    // the edit overwrites it, so pre-edit text is never lost.
    const readCurrentContent = this.db.prepare(`SELECT body, caption FROM messages WHERE source_message_key = ?`);
    const nextRevisionIndex = this.db.prepare(
      `SELECT COALESCE(MAX(revision_index), -1) + 1 AS next FROM message_edit_revisions WHERE message_key = ?`
    );
    const insertRevision = this.db.prepare(
      `INSERT INTO message_edit_revisions (message_key, revision_index, body, caption, edited_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(message_key, revision_index) DO NOTHING`
    );
    const readMetadata = this.db.prepare(`SELECT raw_metadata_json FROM messages WHERE source_message_key = ?`);
    const writeMetadata = this.db.prepare(`UPDATE messages SET raw_metadata_json = ? WHERE source_message_key = ?`);
    const exists = this.db.prepare(`SELECT 1 AS found FROM messages WHERE source_message_key = ?`);
    // Update targets may have been archived from backup (different key format) or
    // with a different participant/fromMe composition; fall back to matching by
    // chat + WhatsApp message id, which is stable across sources.
    const fallbackKey = this.db.prepare(
      `SELECT m.source_message_key AS key
       FROM messages m
       JOIN chats c ON c.id = m.chat_id
       WHERE c.source_chat_id = ? AND m.source_message_id = ?
       LIMIT 1`
    );
    const editedKeys: string[] = [];
    const deletedKeys: string[] = [];
    const transaction = this.db.transaction(() => {
      for (const update of updates) {
        let targetKey: string | null = update.sourceMessageKey;
        if (!exists.get(targetKey)) {
          const messageId = messageIdFromKey(update.sourceMessageKey);
          const fallback = messageId ? (fallbackKey.get(update.chatSourceId, messageId) as { key: string } | undefined) : undefined;
          targetKey = fallback?.key ?? null;
        }
        const hasBase = Boolean(targetKey);
        if (targetKey) {
          if (update.updateType === "delete") {
            markDeleted.run(stringifyJson({ liveUpdate: "delete" }), targetKey);
            deletedKeys.push(targetKey);
          }
          if (update.updateType === "edit" && typeof update.metadata?.body === "string") {
            const current = readCurrentContent.get(targetKey) as { body: string | null; caption: string | null } | undefined;
            // Snapshot only real content changes; replayed identical edits and
            // empty originals produce no fabricated revision.
            if (current && current.body != null && current.body !== update.metadata.body) {
              const next = (nextRevisionIndex.get(targetKey) as { next: number }).next;
              insertRevision.run(targetKey, Number(next), current.body, current.caption, update.occurredAtMs ?? null);
            }
            applyEdit.run(update.metadata.body, targetKey);
            editedKeys.push(targetKey);
          }
          if (update.updateType === "poll_vote" || update.updateType === "event_response") {
            const row = readMetadata.get(targetKey) as { raw_metadata_json: string | null } | undefined;
            const metadata = (parseJson(row?.raw_metadata_json ?? null) as Record<string, unknown> | null) ?? {};
            const merged = mergeInteractionMetadata(metadata, update);
            if (merged) {
              writeMetadata.run(stringifyJson(merged), targetKey);
            }
          }
          applied += 1;
        } else {
          pending += 1;
        }
        insert.run(
          update.eventKey,
          update.chatSourceId,
          update.sourceMessageKey,
          update.updateType,
          update.occurredAtMs ?? null,
          Number(hasBase),
          stringifyJson(update.metadata ?? null),
          currentIso()
        );
      }
      // Edits changed stored body: bring derived search text and mentions back
      // in line with the final content inside the same transaction.
      if (editedKeys.length > 0) {
        const editedIds: number[] = [];
        const lookup = this.db.prepare(`SELECT id FROM messages WHERE source_message_key = ?`);
        for (const key of new Set(editedKeys)) {
          const row = lookup.get(key) as { id: number } | undefined;
          if (row) {
            editedIds.push(Number(row.id));
          }
        }
        this.syncMessageDerivedState(editedIds);
      }
    });
    transaction();
    // Staleness propagation (outside the transaction above — the episode
    // stale-mark + regen enqueue runs its own): a live edit or delete of a
    // cited message invalidates the episodes that quote it.
    await this.markStaleEpisodesForMessages([...editedKeys, ...deletedKeys]);
    return { applied, pending };
  }

  async recordMessageSecrets(secrets: MessageSecretRecord[]): Promise<number> {
    this.assertWritableIdentityVersion();
    if (secrets.length === 0) {
      return 0;
    }
    const insert = this.db.prepare(
      `INSERT INTO message_secrets (message_key, chat_source_id, source_message_id, secret, source)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(message_key) DO NOTHING`
    );
    let recorded = 0;
    const transaction = this.db.transaction(() => {
      for (const entry of secrets) {
        const chatSourceId = this.canonicalJid(entry.chatSourceId) ?? entry.chatSourceId;
        if (!chatSourceId || !entry.sourceMessageId || entry.secret.length === 0) {
          continue;
        }
        const result = insert.run(
          messageKey(chatSourceId, entry.sourceMessageId),
          chatSourceId,
          entry.sourceMessageId,
          Buffer.from(entry.secret),
          entry.source
        );
        recorded += result.changes;
      }
    });
    transaction();
    return recorded;
  }

  async getMessageSecret(chatSourceId: string, sourceMessageId: string): Promise<Uint8Array | null> {
    const canonical = this.canonicalJid(chatSourceId) ?? chatSourceId;
    const row = this.db
      .prepare(`SELECT secret FROM message_secrets WHERE message_key = ?`)
      .get(messageKey(canonical, sourceMessageId)) as { secret: Buffer } | undefined;
    return row?.secret ?? null;
  }

  async countMessageSecrets(): Promise<number> {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM message_secrets`).get() as { n: number };
    return Number(row.n ?? 0);
  }

  async retainEncryptedPayloads(payloads: RetainedPayloadRecord[]): Promise<number> {
    this.assertWritableIdentityVersion();
    if (payloads.length === 0) {
      return 0;
    }
    const insert = this.db.prepare(
      `INSERT INTO retained_encrypted_payloads
       (event_key, target_message_key, chat_source_id, target_message_id, kind, actor_jid, enc_payload, enc_iv, occurred_at_ms, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_key) DO NOTHING`
    );
    let retained = 0;
    const transaction = this.db.transaction(() => {
      for (const payload of payloads) {
        const chatSourceId = this.canonicalJid(payload.chatSourceId) ?? payload.chatSourceId;
        if (!chatSourceId || !payload.targetMessageId || payload.encPayload.length === 0) {
          continue;
        }
        const result = insert.run(
          payload.eventKey,
          messageKey(chatSourceId, payload.targetMessageId),
          chatSourceId,
          payload.targetMessageId,
          payload.kind,
          payload.actorJid ?? null,
          Buffer.from(payload.encPayload),
          payload.encIv ? Buffer.from(payload.encIv) : null,
          payload.occurredAtMs ?? null,
          stringifyJson(payload.metadata ?? null)
        );
        retained += result.changes;
      }
    });
    transaction();
    return retained;
  }

  async listRetainedEncryptedPayloads(limit = 500): Promise<RetainedPayloadRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT id, event_key, chat_source_id, target_message_id, kind, actor_jid, enc_payload, enc_iv, occurred_at_ms, metadata_json
         FROM retained_encrypted_payloads
         ORDER BY id ASC
         LIMIT ?`
      )
      .all(Math.max(1, limit)) as Array<{
      id: number;
      event_key: string;
      chat_source_id: string;
      target_message_id: string;
      kind: RetainedPayloadRecord["kind"];
      actor_jid: string | null;
      enc_payload: Buffer;
      enc_iv: Buffer | null;
      occurred_at_ms: number | null;
      metadata_json: string | null;
    }>;
    return rows.map((row) => ({
      id: Number(row.id),
      eventKey: row.event_key,
      chatSourceId: row.chat_source_id,
      targetMessageId: row.target_message_id,
      kind: row.kind,
      actorJid: row.actor_jid,
      encPayload: row.enc_payload,
      encIv: row.enc_iv,
      occurredAtMs: row.occurred_at_ms == null ? null : Number(row.occurred_at_ms),
      metadata: (parseJson(row.metadata_json) as Record<string, unknown> | null) ?? null
    }));
  }

  async deleteRetainedEncryptedPayload(id: number): Promise<void> {
    this.db.prepare(`DELETE FROM retained_encrypted_payloads WHERE id = ?`).run(id);
  }

  async getMessageInterpretationContext(
    chatSourceId: string,
    sourceMessageId: string
  ): Promise<{ senderSourceJid: string | null; fromMe: boolean | null; rawMetadata: Record<string, unknown> | null } | null> {
    const canonical = this.canonicalJid(chatSourceId) ?? chatSourceId;
    const row = this.db
      .prepare(
        `SELECT m.sender_source_jid, m.from_me, m.raw_metadata_json
         FROM messages m
         JOIN chats c ON c.id = m.chat_id
         WHERE c.source_chat_id = ? AND m.source_message_id = ?
         LIMIT 1`
      )
      .get(canonical, sourceMessageId) as
      | { sender_source_jid: string | null; from_me: number | null; raw_metadata_json: string | null }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      senderSourceJid: row.sender_source_jid,
      fromMe: row.from_me == null ? null : Boolean(row.from_me),
      rawMetadata: (parseJson(row.raw_metadata_json) as Record<string, unknown> | null) ?? null
    };
  }

  async enqueueMediaDownloads(
    items: Array<Pick<MediaDownloadQueueRecord, "messageKey" | "chatSourceId" | "sourceMessageId" | "descriptor" | "thumbnail" | "isViewOnce" | "priority">>
  ): Promise<number> {
    this.assertWritableIdentityVersion();
    if (items.length === 0) {
      return 0;
    }
    // First capture wins; a re-delivered message must not restart a stored or
    // terminal download, but may raise priority of a still-pending one.
    const insert = this.db.prepare(
      `INSERT INTO media_download_queue
       (message_key, chat_source_id, source_message_id, descriptor_json, thumbnail, is_view_once, status, priority, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
       ON CONFLICT(message_key) DO UPDATE SET
         priority = MAX(media_download_queue.priority, excluded.priority),
         updated_at = excluded.updated_at
       WHERE media_download_queue.status IN ('pending','retry')`
    );
    let enqueued = 0;
    const transaction = this.db.transaction(() => {
      for (const item of items) {
        const chatSourceId = this.canonicalJid(item.chatSourceId) ?? item.chatSourceId;
        if (!chatSourceId || !item.sourceMessageId) {
          continue;
        }
        const result = insert.run(
          messageKey(chatSourceId, item.sourceMessageId),
          chatSourceId,
          item.sourceMessageId,
          JSON.stringify(item.descriptor),
          item.thumbnail?.length ? Buffer.from(item.thumbnail) : null,
          Number(item.isViewOnce),
          item.priority,
          currentIso()
        );
        enqueued += result.changes;
      }
    });
    transaction();
    return enqueued;
  }

  async claimDueMediaDownloads(limit: number, nowMs = Date.now()): Promise<MediaDownloadQueueRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT id, message_key, chat_source_id, source_message_id, descriptor_json, thumbnail, is_view_once,
                status, attempts, reupload_attempts, next_attempt_at_ms, last_error, priority
         FROM media_download_queue
         WHERE status IN ('pending','retry') AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)
         ORDER BY priority DESC, id ASC
         LIMIT ?`
      )
      .all(nowMs, Math.max(1, limit)) as SqliteMediaQueueRow[];
    if (rows.length === 0) {
      return [];
    }
    const claim = this.db.prepare(`UPDATE media_download_queue SET status = 'downloading', updated_at = ? WHERE id = ?`);
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        claim.run(currentIso(), row.id);
      }
    });
    transaction();
    return rows.map(rowToMediaQueueRecord).filter((record): record is MediaDownloadQueueRecord => record !== null);
  }

  async completeMediaDownload(queueId: number, asset: MediaAssetRecord): Promise<number> {
    const queued = this.db.prepare(`SELECT message_key FROM media_download_queue WHERE id = ?`).get(queueId) as
      | { message_key: string }
      | undefined;
    let assetId = 0;
    const transaction = this.db.transaction(() => {
      assetId = this.upsertMediaAssetRow(asset);
      // Stored is terminal: the descriptor (and its copy of the media key) has
      // served its purpose and is dropped from the row.
      this.db
        .prepare(
          `UPDATE media_download_queue
           SET status = 'stored', descriptor_json = NULL, thumbnail = NULL, last_error = NULL, updated_at = ?
           WHERE id = ?`
        )
        .run(currentIso(), queueId);
    });
    transaction();
    // Media landing upgrades the message's interpretation (e.g. "Photo (not
    // downloaded)" → "Photo"); episodes that cite it go stale for regeneration.
    if (queued?.message_key) {
      await this.markStaleEpisodesForMessages([queued.message_key]);
    }
    return assetId;
  }

  async markMediaDownloadRetry(queueId: number, error: string, nextAttemptAtMs: number, options: { countReupload?: boolean } = {}): Promise<void> {
    this.db
      .prepare(
        `UPDATE media_download_queue
         SET status = 'retry', attempts = attempts + 1, reupload_attempts = reupload_attempts + ?,
             next_attempt_at_ms = ?, last_error = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(options.countReupload ? 1 : 0, nextAttemptAtMs, error.slice(0, 300), currentIso(), queueId);
  }

  async markMediaDownloadTerminal(queueId: number, status: "expired_unrecoverable" | "failed", error: string | null): Promise<void> {
    this.db
      .prepare(
        `UPDATE media_download_queue
         SET status = ?, descriptor_json = NULL, thumbnail = NULL, last_error = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(status, error ? error.slice(0, 300) : null, currentIso(), queueId);
  }

  async linkMediaAsset(asset: MediaAssetRecord): Promise<number> {
    this.assertWritableIdentityVersion();
    return this.upsertMediaAssetRow(asset);
  }

  private upsertMediaAssetRow(asset: MediaAssetRecord): number {
    const chatSourceId = this.canonicalJid(asset.chatSourceId) ?? asset.chatSourceId;
    this.db
      .prepare(
        `INSERT INTO media_assets
         (message_key, chat_source_id, sha256, storage_path, mime_type, byte_size, width, height, duration_ms, thumbnail, source, is_view_once)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_key, sha256) DO UPDATE SET
           mime_type = COALESCE(media_assets.mime_type, excluded.mime_type),
           width = COALESCE(media_assets.width, excluded.width),
           height = COALESCE(media_assets.height, excluded.height),
           duration_ms = COALESCE(media_assets.duration_ms, excluded.duration_ms),
           thumbnail = COALESCE(media_assets.thumbnail, excluded.thumbnail),
           is_view_once = MAX(media_assets.is_view_once, excluded.is_view_once)`
      )
      .run(
        asset.messageKey,
        chatSourceId,
        asset.sha256,
        asset.storagePath,
        asset.mimeType ?? null,
        asset.byteSize,
        asset.width ?? null,
        asset.height ?? null,
        asset.durationMs ?? null,
        asset.thumbnail?.length ? Buffer.from(asset.thumbnail) : null,
        asset.source,
        Number(asset.isViewOnce)
      );
    const row = this.db
      .prepare(`SELECT id FROM media_assets WHERE message_key = ? AND sha256 = ?`)
      .get(asset.messageKey, asset.sha256) as { id: number };
    return Number(row.id);
  }

  async getMediaAsset(assetId: number): Promise<MediaAssetRecord | null> {
    const row = this.db.prepare(`SELECT * FROM media_assets WHERE id = ?`).get(assetId) as SqliteMediaAssetRow | undefined;
    return row ? rowToMediaAsset(row) : null;
  }

  async getMediaAssetForMessage(messageId: number): Promise<MediaAssetRecord | null> {
    const row = this.db
      .prepare(
        `SELECT a.* FROM media_assets a
         JOIN messages m ON m.source_message_key = a.message_key
         WHERE m.id = ?
         ORDER BY a.id ASC
         LIMIT 1`
      )
      .get(messageId) as SqliteMediaAssetRow | undefined;
    return row ? rowToMediaAsset(row) : null;
  }

  async getMediaQueueSummary(): Promise<MediaQueueSummary> {
    const counts = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM media_download_queue GROUP BY status`)
      .all() as Array<{ status: MediaDownloadStatus; n: number }>;
    const byStatus = new Map(counts.map((row) => [row.status, Number(row.n)]));
    const assets = this.db.prepare(`SELECT COUNT(*) AS n FROM media_assets`).get() as { n: number };
    return {
      assets: Number(assets.n ?? 0),
      pending: byStatus.get("pending") ?? 0,
      downloading: byStatus.get("downloading") ?? 0,
      retry: byStatus.get("retry") ?? 0,
      stored: byStatus.get("stored") ?? 0,
      failed: byStatus.get("failed") ?? 0,
      expiredUnrecoverable: byStatus.get("expired_unrecoverable") ?? 0
    };
  }

  async retryStuckMediaDownloads(): Promise<number> {
    // Terminal rows whose descriptor was already dropped cannot be retried —
    // only rows still holding a descriptor go back to pending.
    const result = this.db
      .prepare(
        `UPDATE media_download_queue
         SET status = 'pending', attempts = 0, reupload_attempts = 0, next_attempt_at_ms = NULL, updated_at = ?
         WHERE status IN ('failed','expired_unrecoverable','retry') AND descriptor_json IS NOT NULL`
      )
      .run(currentIso());
    return result.changes;
  }

  async resetInFlightMediaDownloads(): Promise<number> {
    const result = this.db
      .prepare(`UPDATE media_download_queue SET status = 'pending', updated_at = ? WHERE status = 'downloading'`)
      .run(currentIso());
    return result.changes;
  }

  async recordLinkPreviews(previews: CapturedLinkPreview[]): Promise<number> {
    this.assertWritableIdentityVersion();
    if (previews.length === 0) {
      return 0;
    }
    const insert = this.db.prepare(
      `INSERT INTO message_link_previews (message_key, chat_source_id, title, description, canonical_url, thumbnail)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_key) DO UPDATE SET
         title = COALESCE(message_link_previews.title, excluded.title),
         description = COALESCE(message_link_previews.description, excluded.description),
         canonical_url = COALESCE(message_link_previews.canonical_url, excluded.canonical_url),
         thumbnail = COALESCE(message_link_previews.thumbnail, excluded.thumbnail)
       WHERE (message_link_previews.title IS NULL AND excluded.title IS NOT NULL)
          OR (message_link_previews.description IS NULL AND excluded.description IS NOT NULL)
          OR (message_link_previews.canonical_url IS NULL AND excluded.canonical_url IS NOT NULL)
          OR (message_link_previews.thumbnail IS NULL AND excluded.thumbnail IS NOT NULL)`
    );
    let recorded = 0;
    const changedMessageKeys = new Set<string>();
    const transaction = this.db.transaction(() => {
      for (const preview of previews) {
        const chatSourceId = this.canonicalJid(preview.chatSourceId) ?? preview.chatSourceId;
        if (!chatSourceId || !preview.sourceMessageId) {
          continue;
        }
        const sourceMessageKey = messageKey(chatSourceId, preview.sourceMessageId);
        const result = insert.run(
          sourceMessageKey,
          chatSourceId,
          preview.title ?? null,
          preview.description ?? null,
          preview.canonicalUrl ?? null,
          preview.thumbnail?.length ? Buffer.from(preview.thumbnail) : null
        );
        recorded += result.changes;
        if (result.changes) {
          changedMessageKeys.add(sourceMessageKey);
        }
      }
    });
    transaction();
    if (changedMessageKeys.size > 0) {
      // Preview text feeds the low-weight context FTS column; previews can
      // arrive after their message was indexed, so re-derive those rows now.
      const keys = [...changedMessageKeys];
      const ids: number[] = [];
      for (let index = 0; index < keys.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
        const batch = keys.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
        const rows = this.db
          .prepare(`SELECT id FROM messages WHERE source_message_key IN (${batch.map(() => "?").join(",")})`)
          .all(...batch) as Array<{ id: number }>;
        ids.push(...rows.map((row) => Number(row.id)));
      }
      if (ids.length > 0) {
        this.db.transaction(() => this.syncMessageDerivedState(ids))();
      }
      await this.markStaleEpisodesForMessages([...changedMessageKeys]);
    }
    return recorded;
  }

  async getLinkPreviewThumbnail(messageId: number): Promise<Uint8Array | null> {
    const row = this.db
      .prepare(
        `SELECT p.thumbnail FROM message_link_previews p
         JOIN messages m ON m.source_message_key = p.message_key
         WHERE m.id = ?`
      )
      .get(messageId) as { thumbnail: Buffer | null } | undefined;
    return row?.thumbnail ?? null;
  }

  async getQuotedSnapshotThumbnail(messageId: number): Promise<Uint8Array | null> {
    const row = this.db
      .prepare(
        `SELECT qs.thumbnail FROM message_quoted_snapshots qs
         JOIN messages m ON m.source_message_key = qs.reply_message_key
         WHERE m.id = ?`
      )
      .get(messageId) as { thumbnail: Buffer | null } | undefined;
    return row?.thumbnail ?? null;
  }

  async listMessageEditRevisions(messageId: number): Promise<MessageEditRevisionRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.message_key, r.revision_index, r.body, r.caption, r.edited_at_ms, r.created_at
         FROM message_edit_revisions r
         JOIN messages m ON m.source_message_key = r.message_key
         WHERE m.id = ?
         ORDER BY r.revision_index ASC`
      )
      .all(messageId) as Array<{
      id: number;
      message_key: string;
      revision_index: number;
      body: string | null;
      caption: string | null;
      edited_at_ms: number | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: Number(row.id),
      messageKey: row.message_key,
      revisionIndex: Number(row.revision_index),
      body: row.body,
      caption: row.caption,
      editedAtMs: nullableNumber(row.edited_at_ms),
      createdAt: row.created_at
    }));
  }

  async getMessageDetail(messageId: number): Promise<MessageDetail | null> {
    const message = this.db.prepare(
      `SELECT id, source_message_key, timestamp_ms, body, caption, is_deleted, message_type, raw_type_code, raw_metadata_json
       FROM messages WHERE id = ?`
    ).get(messageId) as { id: number; source_message_key: string; timestamp_ms: number | null; body: string | null; caption: string | null; is_deleted: number; message_type: string; raw_type_code: string | null; raw_metadata_json: string | null } | undefined;
    if (!message) return null;
    const sourceMessageKey = message.source_message_key;
    const observationRows = (factKey: string, family: string) =>
      (this.db.prepare(`SELECT * FROM archive_signal_observations WHERE fact_key = ? AND family = ? ORDER BY observed_at_ms, source`).all(factKey, family) as Array<Record<string, unknown>>)
        .map(archiveSignalObservationFromRow);
    const locationRow = this.db.prepare(`SELECT * FROM message_locations WHERE source_message_key = ?`).get(sourceMessageKey) as Record<string, unknown> | undefined;
    const locationObservations = (this.db.prepare(`SELECT * FROM message_location_observations WHERE source_message_key = ? ORDER BY sequence_number, observed_at_ms, observation_key`).all(sourceMessageKey) as Array<Record<string, unknown>>)
      .map(locationObservationFromRow);
    const locations = locationRow
      ? [{ ...locationFromRow(locationRow), observations: locationObservations, provenance: observationRows(sourceMessageKey, "location") }]
      : [];
    const vcards = (this.db.prepare(`SELECT * FROM message_vcards WHERE source_message_key = ? ORDER BY card_index`).all(sourceMessageKey) as Array<Record<string, unknown>>)
      .map((row) => {
        const parsed = vcardFromRow(row);
        const card = !parsed.vcard && parsed.displayName && phoneFromJid(parsed.resolvedJid)
          ? { ...parsed, downloadKind: "constructed" as const }
          : parsed;
        return { ...card, provenance: observationRows(`${sourceMessageKey}:${card.cardIndex}`, "vcard") };
      });
    const mentionedJids = (this.db.prepare(
      `SELECT mentioned_jid FROM message_mentions mm JOIN messages m ON m.id = mm.message_id WHERE m.id = ? ORDER BY mentioned_jid`
    ).all(messageId) as Array<{ mentioned_jid: string }>).map((row) => row.mentioned_jid);
    const editRows = (this.db.prepare(`SELECT * FROM message_edit_events WHERE source_message_key = ? ORDER BY observed_at_ms, event_key`).all(sourceMessageKey) as Array<Record<string, unknown>>)
      .map((row) => ({
        eventKey: String(row.event_key), timestampMs: nullableNumber(row.observed_at_ms as number | null), source: String(row.source) as "backup" | "live",
        sourceEventKey: (row.source_event_key as string | null) ?? null
      }));
    const revisions = await this.listMessageEditRevisions(messageId);
    const editTimeline = buildMessageEditTimeline({
      sentAtMs: nullableNumber(message.timestamp_ms),
      currentText: message.body ?? message.caption ?? null,
      revisions,
      events: editRows
    });
    const deletionRow = this.db.prepare(`SELECT * FROM message_deletions WHERE source_message_key = ?`).get(sourceMessageKey) as Record<string, unknown> | undefined;
    const deletion = deletionRow
      ? {
          revokedByJid: (deletionRow.revoked_by_jid as string | null) ?? null,
          revokedByAdmin: deletionRow.revoked_by_admin == null ? null : Boolean(deletionRow.revoked_by_admin),
          deletionKind: (deletionRow.deletion_kind as string | null) ?? null,
          deletedAtMs: nullableNumber(deletionRow.observed_at_ms as number | null),
          sentAtMs: nullableNumber(message.timestamp_ms),
          contentState: message.body || message.caption || locations.length || vcards.length ? "retained" as const : "never_captured" as const,
          observations: observationRows(sourceMessageKey, "deletion")
        }
      : null;
    const mediaInterpretations = (this.db.prepare(`SELECT * FROM message_media_interpretations WHERE source_message_key = ? ORDER BY kind, segment_index`).all(sourceMessageKey) as Array<Record<string, unknown>>)
      .map((row) => ({
        sourceMessageKey, kind: String(row.kind) as MessageDetail["mediaInterpretations"][number]["kind"], segmentIndex: Number(row.segment_index), text: String(row.text),
        startMs: nullableNumber(row.start_ms as number | null), endMs: nullableNumber(row.end_ms as number | null), ...signalProvenanceFromRow(row)
      }));
    const preview = this.db.prepare(`SELECT title, description, canonical_url, thumbnail FROM message_link_previews WHERE message_key = ?`).get(sourceMessageKey) as { title: string | null; description: string | null; canonical_url: string | null; thumbnail: Buffer | null } | undefined;
    const systemEvents = this.systemEventDetailsForMessage(sourceMessageKey, observationRows);
    if (message.message_type === "system" && systemEvents.length === 0) {
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
        occurredAtMs: nullableNumber(message.timestamp_ms),
        rawType: message.raw_type_code ?? null,
        rawParameters: message.raw_metadata_json ?? null,
        observations: []
      });
    }
    return {
      id: Number(message.id),
      sourceMessageKey,
      sentAtMs: nullableNumber(message.timestamp_ms),
      availability: {
        hasLocation: locations.length > 0,
        vcardCount: vcards.length,
        hasDeletion: Boolean(deletion),
        hasEditHistory: editRows.length > 0 || revisions.length > 0,
        hasSourceInterpretation: mediaInterpretations.length > 0,
        hasSystemEventDetail: systemEvents.length > 0
      },
      locations,
      vcards,
      mentionedJids,
      editTimeline,
      deletion,
      mediaInterpretations,
      linkPreview: preview ? { title: preview.title, description: preview.description, canonicalUrl: preview.canonical_url, hasThumbnail: Boolean(preview.thumbnail?.length) } : null,
      systemEvents
    };
  }

  async getMessageVcardDownload(messageId: number, cardIndex: number): Promise<{ content: string; fileName: string; constructed: boolean } | null> {
    const row = this.db.prepare(
      `SELECT v.* FROM message_vcards v JOIN messages m ON m.source_message_key = v.source_message_key
       WHERE m.id = ? AND v.card_index = ?`
    ).get(messageId, cardIndex) as Record<string, unknown> | undefined;
    if (!row) return null;
    const card = vcardFromRow(row);
    if (card.vcard?.trim()) return { content: card.vcard, fileName: safeVcardFileName(card.downloadFileName ?? card.displayName, card.cardIndex), constructed: false };
    const phone = phoneFromJid(card.resolvedJid);
    if (!card.displayName?.trim() || !phone) return null;
    return { content: constructMinimalVcard(card.displayName, phone), fileName: safeVcardFileName(card.downloadFileName ?? card.displayName, card.cardIndex), constructed: true };
  }

  async listPendingLiveMessageUpdates(limit = 500): Promise<LiveMessageUpdateRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT event_key, chat_source_id, source_message_key, update_type, occurred_at_ms, applied, metadata_json
         FROM live_message_updates
         WHERE applied = 0
         ORDER BY updated_at ASC
         LIMIT ?`
      )
      .all(Math.max(1, limit)) as Array<{
      event_key: string;
      chat_source_id: string;
      source_message_key: string;
      update_type: LiveMessageUpdateRecord["updateType"];
      occurred_at_ms: number | null;
      applied: number;
      metadata_json: string | null;
    }>;
    return rows.map((row) => ({
      eventKey: row.event_key,
      chatSourceId: row.chat_source_id,
      sourceMessageKey: row.source_message_key,
      updateType: row.update_type,
      occurredAtMs: row.occurred_at_ms == null ? null : Number(row.occurred_at_ms),
      applied: Boolean(row.applied),
      metadata: (parseJson(row.metadata_json) as Record<string, unknown> | null) ?? null
    }));
  }

  async reconcileLiveState(): Promise<{ staleSessions: number; staleRuns: number }> {
    const now = currentIso();
    // Media downloads claimed by a previous process resume from pending; the
    // atomic blob write guarantees no partial file registered as stored.
    await this.resetInFlightMediaDownloads();
    const sessions = this.db
      .prepare(
        `UPDATE live_sessions
         SET status = 'stopped', last_error = NULL, updated_at = ?
         WHERE status IN ('connected','pairing')`
      )
      .run(now);
    const runs = this.db
      .prepare(
        `UPDATE live_sync_runs
         SET status = 'failed', finished_at = ?, error_code = 'INTERRUPTED_BY_RESTART',
             error_message = 'Live sync run was interrupted by a process restart.'
         WHERE status = 'running'`
      )
      .run(now);
    return { staleSessions: sessions.changes, staleRuns: runs.changes };
  }

  async getLiveStatus(): Promise<LiveMaintainerStatusSummary> {
    const sessionRow = this.db
      .prepare(`SELECT * FROM live_sessions ORDER BY updated_at DESC LIMIT 1`)
      .get() as SqliteLiveSessionRow | undefined;
    const currentRunRow = this.db
      .prepare(`SELECT * FROM live_sync_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`)
      .get() as SqliteLiveRunRow | undefined;
    const openGaps = await this.listLiveGaps(["open", "retrying", "uncertain", "needs_user_action"]);
    const gapGroupRows = this.db
      .prepare(
        `SELECT status, reason, COUNT(*) AS count
         FROM live_gap_windows
         WHERE status IN ('open','retrying','uncertain','needs_user_action')
         GROUP BY status, reason
         ORDER BY count DESC`
      )
      .all() as Array<{ status: LiveGapStatus; reason: LiveGapReason; count: number }>;
    const identityHealth = await this.getIdentityHealth();
    const healthRows = this.db
      .prepare(
        `SELECT c.chat_source_id, chats.display_name, c.health, c.latest_archived_at_ms, c.latest_live_at_ms,
                c.oldest_verified_at_ms, c.next_recovery_at,
                (SELECT COUNT(*) FROM live_gap_windows g
                 WHERE g.chat_source_id = c.chat_source_id
                   AND g.status IN ('open','retrying','uncertain','needs_user_action')) AS open_gap_count
         FROM live_chat_checkpoints c
         LEFT JOIN chats ON chats.source_chat_id = c.chat_source_id
         ORDER BY open_gap_count DESC, c.updated_at DESC
         LIMIT 20`
      )
      .all() as SqliteLiveHealthRow[];
    return {
      enabled: Boolean(sessionRow),
      baseline: baselineFromStatus(await this.getStatusWithoutLive(), this.getLatestArchiveMessageAt(), config.live.maxBackfillPerChatDays),
      session: sessionRow ? rowToLiveSession(sessionRow) : null,
      currentRun: currentRunRow ? rowToLiveRun(currentRunRow) : null,
      totals: currentRunRow ? totalsOrEmptyLive(parseJson(currentRunRow.totals_json) as LiveSyncTotals | null) : emptyLiveTotals(),
      openGapCount: openGaps.length,
      gapGroups: gapGroupRows.map((row) => ({ status: row.status, reason: row.reason, count: Number(row.count) })),
      identityHealth,
      chatHealth: healthRows.map((row) => ({
        chatSourceId: row.chat_source_id,
        chatDisplayName: row.display_name ?? null,
        health: row.health as LiveHealthState,
        latestArchivedAt: isoFromMs(row.latest_archived_at_ms),
        latestLiveAt: isoFromMs(row.latest_live_at_ms),
        oldestVerifiedAt: isoFromMs(row.oldest_verified_at_ms),
        openGapCount: Number(row.open_gap_count ?? 0),
        nextRecoveryAt: row.next_recovery_at ?? null
      })),
      media: await this.getMediaQueueSummary()
    };
  }

  private async getStatusWithoutLive(): Promise<StatusSummary> {
    if (!this.isInitialized()) {
      return emptyStatus(false);
    }
    const counts = this.db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM chats) AS chats,
          (SELECT COUNT(*) FROM contacts) AS contacts,
          (SELECT COUNT(*) FROM chat_participants) AS participants,
          (SELECT COUNT(*) FROM messages) AS messages,
          (SELECT COUNT(*) FROM import_warnings) AS warnings`
      )
      .get() as Record<string, number>;
    const latestRun = this.db
      .prepare(
        `SELECT id, status, started_at, finished_at, totals_json, warning_count, error_message
         FROM import_runs
         ORDER BY started_at DESC
         LIMIT 1`
      )
      .get() as SqliteImportRunRow | undefined;
    const latestImport = latestRun ? rowToImportSummary(latestRun) : null;
    const latestWarnings = latestImport ? this.getLatestWarnings(latestImport.id) : [];
    return {
      database: {
        configured: true,
        initialized: true,
        adapter: "sqlite",
        location: path.basename(this.dbPath),
        ...(this.legacyArchive ? { error: LEGACY_ARCHIVE_MESSAGE } : {})
      },
      counts: {
        chats: Number(counts.chats ?? 0),
        contacts: Number(counts.contacts ?? 0),
        participants: Number(counts.participants ?? 0),
        messages: Number(counts.messages ?? 0),
        warnings: Number(counts.warnings ?? 0)
      },
      latestImport,
      latestWarnings
    };
  }

  private getLatestArchiveMessageAt(): string | null {
    const row = this.db
      .prepare(
        `SELECT sent_at
         FROM messages
         WHERE timestamp_ms IS NOT NULL
         ORDER BY timestamp_ms DESC, id DESC
         LIMIT 1`
      )
      .get() as { sent_at: string | null } | undefined;
    return row?.sent_at ?? null;
  }

  async listChats(options: ChatListOptions): Promise<ChatListItem[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.search) {
      // Users search what they see: phone-fallback labels ("+1555...") must
      // match jids by their digits.
      const digits = options.search.replace(/\D/g, "");
      if (digits.length >= 4) {
        where.push("(display_name LIKE ? OR jid LIKE ? OR jid LIKE ?)");
        params.push(`%${options.search}%`, `%${options.search}%`, `%${digits}%`);
      } else {
        where.push("(display_name LIKE ? OR jid LIKE ?)");
        params.push(`%${options.search}%`, `%${options.search}%`);
      }
    }
    if (options.type && options.type !== "all") {
      where.push("chat_type = ?");
      params.push(options.type);
    }
    if (!options.includeEventOnly) {
      where.push(`EXISTS (
        SELECT 1
        FROM messages visible_messages
        WHERE visible_messages.chat_id = chats.id
          AND ${visibleExchangePredicate("visible_messages")}
      )`);
    }
    params.push(options.limit, options.offset);
    const rows = this.db
      .prepare(
        `SELECT id, source_chat_id, jid, NULLIF(TRIM(COALESCE(display_name, '')), '') AS display_name, chat_type,
                message_count, participant_count, last_message_at
         FROM chats
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY last_message_at_ms IS NULL, last_message_at_ms DESC, display_name ASC
         LIMIT ? OFFSET ?`
      )
      .all(...params) as SqliteChatRow[];
    const items: ChatListItem[] = rows.map((row) => ({
      id: Number(row.id),
      sourceChatId: row.source_chat_id,
      jid: row.jid,
      // Name, else phone number, never a raw identifier; NULL means unresolved
      // and the client renders an explicit state.
      displayName: row.display_name && row.display_name !== row.jid ? row.display_name : displayPhoneFromJid(row.jid),
      chatType: row.chat_type as ChatListItem["chatType"],
      messageCount: Number(row.message_count ?? 0),
      participantCount: Number(row.participant_count ?? 0),
      lastMessageAt: row.last_message_at ?? null
    }));
    // Same-name persons must be visually distinct wherever they co-occur:
    // disambiguate DM titles across the page (group subjects are not person
    // labels) and attach display-level unconfirmed hints.
    const isIdentityChat = (item: ChatListItem): boolean => item.chatType === "dm" || item.chatType === "unknown";
    const adjusted = this.disambiguateEntryLabels(
      items.map((item) => (isIdentityChat(item) ? { label: item.displayName, jid: item.sourceChatId } : { label: null, jid: null }))
    );
    const hints = this.chatHintsSync(items.filter(isIdentityChat).map((item) => item.sourceChatId));
    items.forEach((item, index) => {
      if (isIdentityChat(item)) {
        if (adjusted[index] != null) {
          item.displayName = adjusted[index];
        }
        const hint = hints.get(item.sourceChatId);
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
    const where = ["m.chat_id = ?"];
    const params: unknown[] = [chatId];
    if (options.sender) {
      where.push("(m.sender_source_jid = ? OR c.display_name LIKE ?)");
      params.push(options.sender, `%${options.sender}%`);
    }
    if (options.query) {
      where.push("(m.body LIKE ? OR m.caption LIKE ?)");
      params.push(`%${options.query}%`, `%${options.query}%`);
    }
    params.push(options.limit, options.offset);
    const orderDirection = options.order === "desc" ? "DESC" : "ASC";
    // Legacy rows may carry the group's own JID as the sender (pre-fix history
    // sync); those senders are unknown, never "the group".
    const chat = this.db.prepare(`SELECT source_chat_id, chat_type FROM chats WHERE id = ?`).get(chatId) as
      | { source_chat_id: string; chat_type: string }
      | undefined;
    const rows = this.db
      .prepare(
        messageListSelectSql(
          `WHERE ${where.join(" AND ")}`,
          `ORDER BY m.timestamp_ms ${orderDirection}, m.id ${orderDirection}`,
          `LIMIT ? OFFSET ?`
        )
      )
      .all(...params) as SqliteMessageRow[];
    return this.mapMessageRows(rows, chat);
  }

  async listMessagesAround(chatId: number, messageId: number, radius: number): Promise<MessageContextWindow | null> {
    const anchor = this.db
      .prepare(`SELECT id, timestamp_ms FROM messages WHERE id = ? AND chat_id = ?`)
      .get(messageId, chatId) as { id: number; timestamp_ms: number | null } | undefined;
    if (!anchor) {
      return null;
    }
    const chat = this.db.prepare(`SELECT source_chat_id, chat_type FROM chats WHERE id = ?`).get(chatId) as
      | { source_chat_id: string; chat_type: string }
      | undefined;
    const anchorTs = anchor.timestamp_ms ?? 0;
    const newerPredicate = `m.chat_id = ? AND (COALESCE(m.timestamp_ms, 0) > ? OR (COALESCE(m.timestamp_ms, 0) = ? AND m.id > ?))`;
    const olderEqPredicate = `m.chat_id = ? AND (COALESCE(m.timestamp_ms, 0) < ? OR (COALESCE(m.timestamp_ms, 0) = ? AND m.id <= ?))`;
    const predicateParams = [chatId, anchorTs, anchorTs, messageId];
    // Anchor + up to `radius` older rows, and up to `radius` newer rows.
    const olderRows = this.db
      .prepare(messageListSelectSql(`WHERE ${olderEqPredicate}`, `ORDER BY m.timestamp_ms DESC, m.id DESC`, `LIMIT ?`))
      .all(...predicateParams, radius + 1) as SqliteMessageRow[];
    const newerRows = this.db
      .prepare(messageListSelectSql(`WHERE ${newerPredicate}`, `ORDER BY m.timestamp_ms ASC, m.id ASC`, `LIMIT ?`))
      .all(...predicateParams, radius) as SqliteMessageRow[];
    const newerTotal = (
      this.db.prepare(`SELECT COUNT(*) AS count FROM messages m WHERE ${newerPredicate}`).get(...predicateParams) as { count: number }
    ).count;
    // Chronological ascending window: reversed older block, then newer block.
    const rows = [...olderRows.reverse(), ...newerRows];
    return {
      messages: this.mapMessageRows(rows, chat),
      newerCount: Math.max(0, Number(newerTotal) - newerRows.length),
      anchorMessageId: messageId
    };
  }

  // Shared MessageListItem projection for thread pages and context windows.
  private mapMessageRows(
    rows: SqliteMessageRow[],
    chat: { source_chat_id: string; chat_type: string } | undefined
  ): MessageListItem[] {
    const groupSelfSender = chat?.chat_type === "group" ? chat.source_chat_id : null;
    const mentionLabels = this.resolveMentionLabels(rows.flatMap((row) => [row.body, row.caption]));
    const items = rows.map((row) => {
      const media = deriveMediaSummary(row, row.message_type);
      const hasHeldContent = Boolean(row.body?.trim() || row.caption?.trim() || media?.availability === "stored");
      return {
        id: Number(row.id),
        sourceMessageId: row.source_message_id,
        // Saved name, else push name, else phone number; a raw identifier is
        // never surfaced as the sender label (NULL = unresolved).
        senderDisplayName:
          groupSelfSender && row.sender_source_jid === groupSelfSender
            ? null
            : row.sender_display_name ?? displayPhoneFromJid(row.sender_source_jid),
        senderSourceJid: row.sender_source_jid,
        timestampMs: row.timestamp_ms == null ? null : Number(row.timestamp_ms),
        sentAt: row.sent_at,
        direction: row.direction as MessageListItem["direction"],
        messageType: row.message_type,
        interpretation: interpretMessage({
          messageType: row.message_type,
          isDeleted: Boolean(row.is_deleted),
          hasHeldContent,
          mediaAvailability: media?.availability ?? null
        }),
        body: applyMentionLabels(row.body, mentionLabels),
        caption: applyMentionLabels(row.caption, mentionLabels),
        mentions: appliedMentionLabels([row.body, row.caption], mentionLabels),
        hasMedia: Boolean(row.has_media),
        mediaMimeType: row.media_mime_type,
        mediaName: row.media_name,
        media,
        linkPreview:
          row.preview_title || row.preview_description || row.preview_url || row.preview_has_thumbnail
            ? {
                title: row.preview_title ?? null,
                description: row.preview_description ?? null,
                canonicalUrl: row.preview_url ?? null,
                hasThumbnail: Boolean(row.preview_has_thumbnail)
              }
            : null,
        structuredSignals: summarizeStructuredSignals(this.structuredSignalsForMessage(row.id, row.source_message_key)),
        systemEvents: this.systemEventsForMessage(row.source_message_key),
        quotedSnapshot: quoteSummaryFromRow(row),
        isEdited: Boolean(row.edited_flag) || Number(row.edit_revision_count ?? 0) > 0,
        editRevisionCount: Number(row.edit_revision_count ?? 0),
        isDeleted: Boolean(row.is_deleted),
        isForwarded: Boolean(row.is_forwarded),
        isStarred: Boolean(row.is_starred)
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

  private structuredSignalsForMessage(messageId: number, sourceMessageKey: string): MessageStructuredSignals | null {
    const mentions = (this.db.prepare(`SELECT mentioned_jid FROM message_mentions WHERE message_id = ? ORDER BY mentioned_jid`).all(messageId) as Array<{ mentioned_jid: string }>).map((row) => row.mentioned_jid);
    const location = this.db.prepare(`SELECT latitude, longitude, name, address, is_live, capture_version FROM message_locations WHERE source_message_key = ?`).get(sourceMessageKey) as Record<string, unknown> | undefined;
    const vcards = this.db.prepare(`SELECT display_name, resolved_jid, capture_version FROM message_vcards WHERE source_message_key = ? ORDER BY card_index`).all(sourceMessageKey) as Array<Record<string, unknown>>;
    const deletion = this.db.prepare(`SELECT revoked_by_jid, observed_at_ms, capture_version FROM message_deletions WHERE source_message_key = ?`).get(sourceMessageKey) as Record<string, unknown> | undefined;
    const edit = this.db.prepare(`SELECT MAX(observed_at_ms) AS observed_at_ms, MAX(capture_version) AS capture_version FROM message_edit_events WHERE source_message_key = ?`).get(sourceMessageKey) as Record<string, unknown>;
    const revisionCount = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM message_edit_revisions WHERE message_key = ?`).get(sourceMessageKey) as { count: number }).count);
    const interpretations = this.db.prepare(`SELECT kind, text, segment_index, capture_version FROM message_media_interpretations WHERE source_message_key = ? ORDER BY kind, segment_index`).all(sourceMessageKey) as Array<Record<string, unknown>>;
    const preview = this.db.prepare(`SELECT 1 AS found FROM message_link_previews WHERE message_key = ?`).get(sourceMessageKey) as { found: number } | undefined;
    const versions = [
      location?.capture_version, deletion?.capture_version, edit.capture_version, ...vcards.map((row) => row.capture_version), ...interpretations.map((row) => row.capture_version),
      preview || mentions.length ? 1 : 0
    ].map((value) => Number(value ?? 0));
    if (!location && vcards.length === 0 && !deletion && !edit.observed_at_ms && interpretations.length === 0 && !preview && mentions.length === 0) return null;
    return {
      mentionedJids: mentions,
      location: location ? { latitude: nullableNumber(location.latitude as number | null), longitude: nullableNumber(location.longitude as number | null), name: (location.name as string | null) ?? null, address: (location.address as string | null) ?? null, isLive: Boolean(location.is_live) } : null,
      vcards: vcards.map((row) => ({ displayName: (row.display_name as string | null) ?? null, resolvedJid: (row.resolved_jid as string | null) ?? null })),
      deletion: deletion ? { revokedByJid: (deletion.revoked_by_jid as string | null) ?? null, revokedAtMs: nullableNumber(deletion.observed_at_ms as number | null) } : null,
      edit: edit.observed_at_ms ? { observedAtMs: nullableNumber(edit.observed_at_ms as number | null), hasHeldRevision: revisionCount > 0 } : null,
      mediaInterpretations: interpretations.map((row) => ({ kind: row.kind as MessageStructuredSignals["mediaInterpretations"][number]["kind"], text: String(row.text), segmentIndex: Number(row.segment_index) })),
      captureVersion: Math.max(...versions) || null
    };
  }

  private systemEventDetailsForMessage(
    sourceMessageKey: string,
    observationsFor: (factKey: string, family: string) => import("../../shared/types").ArchiveSignalObservation[]
  ): MessageDetail["systemEvents"] {
    const numberChanges = (this.db.prepare(`SELECT * FROM identity_number_changes WHERE source_message_key = ? ORDER BY event_key`).all(sourceMessageKey) as Array<Record<string, unknown>>).map(numberChangeFromRow);
    const membershipEvents = (this.db.prepare(`SELECT * FROM group_membership_events WHERE source_message_key = ? ORDER BY event_key`).all(sourceMessageKey) as Array<Record<string, unknown>>).map(membershipEventFromRow);
    const chatMetadataHistory = (this.db.prepare(`SELECT * FROM chat_metadata_history WHERE source_message_key = ? ORDER BY event_key`).all(sourceMessageKey) as Array<Record<string, unknown>>).map(chatMetadataFromRow);
    const labels = new Map<string, string | null>();
    const displayNameForJid = (jid: string | null) => {
      if (jid === "me") return "You";
      if (!jid) return null;
      if (labels.has(jid)) return labels.get(jid) ?? null;
      const contact = this.db.prepare(`SELECT display_name, push_name, phone_number FROM contacts WHERE source_jid = ?`).get(jid) as { display_name?: string | null; push_name?: string | null; phone_number?: string | null } | undefined;
      const label = resolveDisplayLabel({ displayName: contact?.display_name, pushName: contact?.push_name, phoneNumber: contact?.phone_number, jid });
      labels.set(jid, label);
      return label;
    };
    const detailLabelForJid = (jid: string | null) => displayNameForJid(jid) ?? "Unknown";
    const detail: MessageDetail["systemEvents"] = [];
    for (const record of numberChanges) {
      const summary = summarizeSystemEvents({ numberChanges: [record], membershipEvents: [], chatMetadataHistory: [], displayNameForJid })[0];
      if (!summary) continue;
      detail.push({ kind: "number_change", eventKey: record.eventKey, summary: summary.summary, actorJid: record.actorJid, actorLabel: detailLabelForJid(record.actorJid), participantJid: null, participantLabel: null, oldJid: record.oldJid, oldIdentityLabel: detailLabelForJid(record.oldJid), newJid: record.newJid, newIdentityLabel: detailLabelForJid(record.newJid), oldValue: null, newValue: null, action: null, field: null, occurredAtMs: record.observedAtMs, rawType: null, rawParameters: null, observations: observationsFor(record.eventKey, "number_change") });
    }
    for (const record of membershipEvents) {
      const summary = summarizeSystemEvents({ numberChanges: [], membershipEvents: [record], chatMetadataHistory: [], displayNameForJid })[0];
      if (!summary) continue;
      detail.push({ kind: "membership", eventKey: record.eventKey, summary: summary.summary, actorJid: record.actorJid, actorLabel: detailLabelForJid(record.actorJid), participantJid: record.participantJid, participantLabel: detailLabelForJid(record.participantJid), oldJid: null, oldIdentityLabel: null, newJid: null, newIdentityLabel: null, oldValue: record.oldRole ?? null, newValue: record.newRole ?? null, action: record.action, field: null, occurredAtMs: record.observedAtMs, rawType: record.rawType ?? null, rawParameters: record.rawParameters ?? null, observations: observationsFor(record.eventKey, "membership_event") });
    }
    for (const record of chatMetadataHistory) {
      const summary = summarizeSystemEvents({ numberChanges: [], membershipEvents: [], chatMetadataHistory: [record], displayNameForJid })[0];
      if (!summary) continue;
      detail.push({ kind: "chat_metadata", eventKey: record.eventKey, summary: summary.summary, actorJid: record.actorJid, actorLabel: detailLabelForJid(record.actorJid), participantJid: null, participantLabel: null, oldJid: null, oldIdentityLabel: null, newJid: null, newIdentityLabel: null, oldValue: record.oldValue, newValue: record.newValue, action: null, field: record.field, occurredAtMs: record.observedAtMs, rawType: record.rawType ?? null, rawParameters: record.rawParameters ?? null, observations: observationsFor(record.eventKey, "chat_metadata") });
    }
    return detail.sort((left, right) => (left.occurredAtMs ?? 0) - (right.occurredAtMs ?? 0));
  }

  private systemEventsForMessage(sourceMessageKey: string) {
    const numberChanges = (
      this.db.prepare(`SELECT * FROM identity_number_changes WHERE source_message_key = ? ORDER BY event_key`).all(sourceMessageKey) as Array<Record<string, unknown>>
    ).map(numberChangeFromRow);
    const membershipEvents = (
      this.db.prepare(`SELECT * FROM group_membership_events WHERE source_message_key = ? ORDER BY event_key`).all(sourceMessageKey) as Array<Record<string, unknown>>
    ).map(membershipEventFromRow);
    const chatMetadataHistory = (
      this.db.prepare(`SELECT * FROM chat_metadata_history WHERE source_message_key = ? ORDER BY event_key`).all(sourceMessageKey) as Array<Record<string, unknown>>
    ).map(chatMetadataFromRow);
    const labels = new Map<string, string | null>();
    return summarizeSystemEvents({
      numberChanges,
      membershipEvents,
      chatMetadataHistory,
      displayNameForJid: (jid) => {
        if (jid === "me") {
          return "You";
        }
        if (!jid) {
          return null;
        }
        if (labels.has(jid)) {
          return labels.get(jid) ?? null;
        }
        const contact = this.db
          .prepare(`SELECT display_name, push_name, phone_number FROM contacts WHERE source_jid = ?`)
          .get(jid) as { display_name?: string | null; push_name?: string | null; phone_number?: string | null } | undefined;
        const label = resolveDisplayLabel({ displayName: contact?.display_name, pushName: contact?.push_name, phoneNumber: contact?.phone_number, jid });
        labels.set(jid, label);
        return label;
      }
    });
  }

  async getMemoryStatus(provider: MemoryProviderStatus): Promise<MemoryStatusSummary> {
    const counts = this.db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM memory_pages WHERE status = 'current') AS pages,
          (SELECT COUNT(*) FROM memory_pages WHERE status = 'stale') AS stale_pages,
          (SELECT COUNT(*) FROM memory_citations) AS citations`
      )
      .get() as Record<string, number>;
    const latestRun = this.db
      .prepare(`SELECT * FROM memory_runs ORDER BY started_at DESC LIMIT 1`)
      .get() as SqliteMemoryRunRow | undefined;
    const activeRun = this.db
      .prepare(`SELECT * FROM memory_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`)
      .get() as SqliteMemoryRunRow | undefined;
    return {
      enabled: true,
      rootDir: config.memory.rootDir,
      pageCount: Number(counts.pages ?? 0),
      citationCount: Number(counts.citations ?? 0),
      stalePageCount: Number(counts.stale_pages ?? 0),
      latestRun: latestRun ? rowToMemoryRun(latestRun) : null,
      activeRun: activeRun ? rowToMemoryRun(activeRun) : null,
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
    this.assertWritableIdentityVersion();
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO memory_runs
         (id, status, kind, started_at, source_start_at_ms, source_end_at_ms, source_summary_json)
         VALUES (?, 'running', ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.kind,
        currentIso(),
        input.sourceStartAtMs ?? null,
        input.sourceEndAtMs ?? null,
        stringifyJson(input.sourceSummary ?? null)
      );
    return id;
  }

  async completeMemoryRun(runId: string, totals: { pages: number; citations: number; messages: number; warnings: number }): Promise<void> {
    this.db
      .prepare(
        `UPDATE memory_runs
         SET status = 'completed', finished_at = ?, page_count = ?, citation_count = ?, message_count = ?, warning_count = ?
         WHERE id = ?`
      )
      .run(currentIso(), totals.pages, totals.citations, totals.messages, totals.warnings, runId);
  }

  async failMemoryRun(runId: string, status: "failed" | "blocked", message: string, warningCount = 0): Promise<void> {
    this.db
      .prepare(
        `UPDATE memory_runs
         SET status = ?, finished_at = ?, error_message = ?, warning_count = ?
         WHERE id = ?`
      )
      .run(status, currentIso(), message, warningCount, runId);
  }

  async getMemoryRun(runId: string): Promise<MemoryRunSummary | null> {
    const row = this.db.prepare(`SELECT * FROM memory_runs WHERE id = ?`).get(runId) as SqliteMemoryRunRow | undefined;
    return row ? rowToMemoryRun(row) : null;
  }

  async listMemoryRuns(limit: number): Promise<MemoryRunSummary[]> {
    const rows = this.db.prepare(`SELECT * FROM memory_runs ORDER BY started_at DESC LIMIT ?`).all(limit) as SqliteMemoryRunRow[];
    return rows.map(rowToMemoryRun);
  }

  async tryAcquireMemoryLock(runId: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const expiresAt = now + ttlMs;
    const transaction = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM memory_job_locks WHERE name = 'memory' AND expires_at_ms < ?`).run(now);
      const existing = this.db.prepare(`SELECT run_id FROM memory_job_locks WHERE name = 'memory'`).get() as { run_id: string } | undefined;
      if (existing && existing.run_id !== runId) {
        return false;
      }
      this.db
        .prepare(
          `INSERT INTO memory_job_locks (name, run_id, acquired_at, expires_at_ms)
           VALUES ('memory', ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET run_id = excluded.run_id, acquired_at = excluded.acquired_at, expires_at_ms = excluded.expires_at_ms`
        )
        .run(runId, currentIso(), expiresAt);
      return true;
    });
    return transaction();
  }

  async releaseMemoryLock(runId: string): Promise<void> {
    this.db.prepare(`DELETE FROM memory_job_locks WHERE name = 'memory' AND run_id = ?`).run(runId);
  }

  async createMemorySourceWindow(input: Omit<MemorySourceWindowRecord, "id" | "createdAt">): Promise<MemorySourceWindowRecord> {
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_source_windows
         (id, run_id, status, start_at_ms, end_at_ms, chat_source_ids_json, message_count, source_hash, committed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.runId,
        input.status,
        input.startAtMs ?? null,
        input.endAtMs ?? null,
        stringifyJson(input.chatSourceIds) ?? "[]",
        input.messageCount,
        input.sourceHash,
        input.committedAt ?? null
      );
    const row = this.db.prepare(`SELECT * FROM memory_source_windows WHERE source_hash = ?`).get(input.sourceHash) as SqliteMemoryWindowRow;
    return rowToMemoryWindow(row);
  }

  async getCommittedMemoryWindow(sourceHash: string): Promise<MemorySourceWindowRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM memory_source_windows WHERE source_hash = ? AND status = 'committed' LIMIT 1`)
      .get(sourceHash) as SqliteMemoryWindowRow | undefined;
    return row ? rowToMemoryWindow(row) : null;
  }

  async commitMemorySourceWindow(windowId: string): Promise<void> {
    this.db
      .prepare(`UPDATE memory_source_windows SET status = 'committed', committed_at = ? WHERE id = ?`)
      .run(currentIso(), windowId);
  }

  async listMemoryEvidenceMessages(options: {
    startAtMs?: number | null;
    endAtMs?: number | null;
    chatSourceIds?: string[];
    limit: number;
  }): Promise<MemoryEvidenceMessage[]> {
    const where = ["m.timestamp_ms IS NOT NULL"];
    const params: unknown[] = [];
    if (options.startAtMs != null) {
      where.push("m.timestamp_ms >= ?");
      params.push(options.startAtMs);
    }
    if (options.endAtMs != null) {
      where.push("m.timestamp_ms <= ?");
      params.push(options.endAtMs);
    }
    if (options.chatSourceIds?.length) {
      const placeholders = options.chatSourceIds.map(() => "?").join(", ");
      where.push(`chats.source_chat_id IN (${placeholders})`);
      params.push(...options.chatSourceIds);
    }
    params.push(options.limit);
    const rows = this.db
      .prepare(
        `SELECT m.id, m.source_message_key, m.source_message_id, chats.source_chat_id, m.chat_id,
                NULLIF(TRIM(COALESCE(chats.display_name, '')), '') AS chat_display_name, chats.jid AS chat_jid,
                m.sender_source_jid,
                ${contactLabelSql("c.")} AS sender_display_name,
                ${labelIsPushNameSql("c.")} AS sender_name_is_push_name,
                m.timestamp_ms, m.sent_at, m.direction, m.message_type, m.is_deleted, m.is_forwarded, m.quoted_source_message_id, m.has_media, m.source_table,
                COALESCE(NULLIF(m.body, ''), NULLIF(m.caption, '')) AS text,
                lp.title AS preview_title, lp.description AS preview_description, lp.canonical_url AS preview_url,
                (lp.thumbnail IS NOT NULL) AS preview_has_thumbnail,
                ${MEDIA_STATE_SELECT}, ${QUOTED_SNAPSHOT_SELECT}
         FROM messages m
         JOIN chats ON chats.id = m.chat_id
         LEFT JOIN contacts c ON c.source_jid = m.sender_source_jid
         ${MEDIA_STATE_JOINS}
         LEFT JOIN message_link_previews lp ON lp.message_key = m.source_message_key
         ${QUOTED_SNAPSHOT_JOINS}
         WHERE ${where.join(" AND ")}
         ORDER BY m.timestamp_ms ASC, m.id ASC
         LIMIT ?`
      )
      .all(...params) as SqliteMemoryEvidenceRow[];
    const evidence = rows.map((row, index) => rowToMemoryEvidence(row, index));
    for (const message of evidence) {
      message.structuredSignals = this.structuredSignalsForMessage(message.messageId, message.sourceMessageKey);
    }
    this.attachReactions(evidence);
    return evidence;
  }

  // Reactions live only in live_message_updates (update_type='reaction'), keyed
  // by target source_message_key with metadata {emoji, reactorJid}. They are
  // attached to their target evidence message as non-citable annotations; the
  // reactor is contact-resolved here but the final owner/number label is applied
  // by the brain so one labelling policy governs senders and reactors alike.
  private attachReactions(evidence: MemoryEvidenceMessage[]): void {
    if (evidence.length === 0) {
      return;
    }
    const byKey = new Map<string, MemoryEvidenceMessage>();
    for (const message of evidence) {
      message.reactions = [];
      byKey.set(message.sourceMessageKey, message);
    }
    const keys = [...byKey.keys()];
    const CHUNK = 400;
    for (let start = 0; start < keys.length; start += CHUNK) {
      const slice = keys.slice(start, start + CHUNK);
      const placeholders = slice.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT lmu.source_message_key AS target_key,
                  json_extract(lmu.metadata_json, '$.emoji') AS emoji,
                  json_extract(lmu.metadata_json, '$.reactorJid') AS reactor_jid,
                  ${contactLabelSql("c.")} AS reactor_display_name,
                  ${labelIsPushNameSql("c.")} AS reactor_name_is_push_name
           FROM live_message_updates lmu
           LEFT JOIN contacts c ON c.source_jid = json_extract(lmu.metadata_json, '$.reactorJid')
           WHERE lmu.update_type = 'reaction'
             AND lmu.applied = 1
             AND lmu.source_message_key IN (${placeholders})
             AND json_extract(lmu.metadata_json, '$.emoji') IS NOT NULL
             AND json_extract(lmu.metadata_json, '$.emoji') <> ''
           ORDER BY lmu.occurred_at_ms ASC`
        )
        .all(...slice) as Array<{
        target_key: string;
        emoji: string;
        reactor_jid: string | null;
        reactor_display_name: string | null;
        reactor_name_is_push_name: number;
      }>;
      for (const row of rows) {
        const target = byKey.get(row.target_key);
        if (!target) {
          continue;
        }
        target.reactions.push({
          emoji: row.emoji,
          reactorJid: row.reactor_jid,
          reactorDisplayName: row.reactor_display_name ?? displayPhoneFromJid(row.reactor_jid),
          reactorNameIsPushName: Boolean(row.reactor_name_is_push_name) && row.reactor_display_name != null
        });
      }
    }
  }

  // Resolve quoted-reply referents that are NOT in the current pack. A message's
  // quoted_source_message_id holds a surrogate source_message_id; it resolves by
  // matching another message's source_message_id within the same chat. Returns a
  // ready-to-render {senderLabel, snippet} per resolvable id (owner-aware); ids
  // that point at an unarchived message are simply absent from the map.
  async resolveQuotedReferents(
    chatSourceId: string,
    quotedSourceMessageIds: string[]
  ): Promise<Map<string, { senderLabel: string; snippet: string }>> {
    const result = new Map<string, { senderLabel: string; snippet: string }>();
    const ids = [...new Set(quotedSourceMessageIds.filter((id) => id && id.trim()))];
    if (ids.length === 0) {
      return result;
    }
    const ownerName = (await this.getArchiveOwnerName()) ?? "the archive owner";
    const CHUNK = 400;
    for (let start = 0; start < ids.length; start += CHUNK) {
      const slice = ids.slice(start, start + CHUNK);
      const placeholders = slice.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT m.source_message_id AS quoted_id, m.direction, m.sender_source_jid,
                  ${contactLabelSql("c.")} AS sender_display_name,
                  COALESCE(NULLIF(m.body, ''), NULLIF(m.caption, '')) AS text
           FROM messages m
           JOIN chats ON chats.id = m.chat_id
           LEFT JOIN contacts c ON c.source_jid = m.sender_source_jid
           WHERE chats.source_chat_id = ? AND m.source_message_id IN (${placeholders})`
        )
        .all(chatSourceId, ...slice) as Array<{
        quoted_id: string;
        direction: string;
        sender_source_jid: string | null;
        sender_display_name: string | null;
        text: string | null;
      }>;
      for (const row of rows) {
        if (result.has(row.quoted_id)) {
          continue;
        }
        const isSelf = row.direction === "outgoing" || row.sender_source_jid === "me";
        const label = isSelf
          ? ownerName
          : row.sender_display_name?.trim() || displayPhoneFromJid(row.sender_source_jid) || "someone";
        const snippet = (row.text ?? "").trim().slice(0, 80);
        result.set(row.quoted_id, { senderLabel: label, snippet });
      }
    }
    return result;
  }

  async getLatestCommittedMemoryEndAtMs(chatSourceId?: string | null): Promise<number | null> {
    const row = chatSourceId
      ? (this.db
          .prepare(
            `SELECT MAX(end_at_ms) AS end_at_ms
             FROM memory_source_windows
             WHERE status = 'committed'
               AND (chat_source_ids_json = '[]' OR chat_source_ids_json LIKE ?)`
          )
          .get(`%"${chatSourceId.replace(/"/g, '\\"')}"%`) as { end_at_ms: number | null })
      : (this.db
          .prepare(`SELECT MAX(end_at_ms) AS end_at_ms FROM memory_source_windows WHERE status = 'committed'`)
          .get() as { end_at_ms: number | null });
    return nullableNumber(row?.end_at_ms);
  }

  async recordMemoryEvidencePack(pack: MemoryEvidencePackRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO memory_evidence_packs
         (id, run_id, window_id, status, sequence, message_count, citation_labels_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, message_count = excluded.message_count, citation_labels_json = excluded.citation_labels_json`
      )
      .run(pack.id, pack.runId, pack.windowId, pack.status, pack.sequence, pack.messageCount, stringifyJson(pack.citationLabels) ?? "[]", pack.createdAt);
  }

  async commitMemoryPageRevision(revision: MemoryPageRevisionRecord, citations: MemoryCitationRecord[]): Promise<void> {
    const transaction = this.db.transaction(() => {
      this.db.prepare(`UPDATE memory_page_revisions SET status = 'superseded' WHERE page_id = ? AND status = 'current'`).run(revision.pageId);
      this.db
        .prepare(
          `INSERT INTO memory_page_revisions
           (id, page_id, run_id, window_id, title, page_path, summary, markdown, status, source_start_at_ms, source_end_at_ms, citation_count, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          revision.id,
          revision.pageId,
          revision.runId,
          revision.windowId,
          revision.title,
          revision.path,
          revision.summary,
          revision.markdown,
          revision.status,
          revision.sourceStartAtMs ?? null,
          revision.sourceEndAtMs ?? null,
          citations.length,
          stringifyJson(revision.metadata ?? null),
          revision.createdAt
        );
      this.db
        .prepare(
          `INSERT INTO memory_pages (page_id, title, page_path, status, current_revision_id, updated_at)
           VALUES (?, ?, ?, 'current', ?, ?)
           ON CONFLICT(page_id) DO UPDATE SET
             title = excluded.title,
             page_path = excluded.page_path,
             status = 'current',
             current_revision_id = excluded.current_revision_id,
             updated_at = excluded.updated_at`
        )
        .run(revision.pageId, revision.title, revision.path, revision.id, revision.createdAt);
      const insertCitation = this.db.prepare(
        `INSERT INTO memory_citations
         (revision_id, claim_id, citation_label, message_id, source_message_key, source_message_id, source_chat_id, sender_source_jid, timestamp_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const citation of citations) {
        insertCitation.run(
          revision.id,
          citation.claimId,
          citation.citationLabel,
          citation.messageId ?? null,
          citation.sourceMessageKey,
          citation.sourceMessageId,
          citation.sourceChatId,
          citation.senderSourceJid ?? null,
          citation.timestampMs ?? null
        );
      }
    });
    transaction();
  }

  async listMemoryPageRevisions(options: { query?: string; limit?: number } = {}): Promise<MemoryPageRevisionRecord[]> {
    const params: unknown[] = [];
    const where = ["r.status = 'current'"];
    if (options.query) {
      where.push("(r.title LIKE ? OR r.summary LIKE ? OR r.markdown LIKE ?)");
      params.push(`%${options.query}%`, `%${options.query}%`, `%${options.query}%`);
    }
    params.push(options.limit ?? 50);
    const rows = this.db
      .prepare(
        `SELECT r.*
         FROM memory_page_revisions r
         WHERE ${where.join(" AND ")}
         ORDER BY r.created_at DESC
         LIMIT ?`
      )
      .all(...params) as SqliteMemoryRevisionRow[];
    return rows.map(rowToMemoryRevision);
  }

  async listMemoryCitations(revisionId?: string): Promise<MemoryCitationRecord[]> {
    const rows = revisionId
      ? (this.db.prepare(`SELECT * FROM memory_citations WHERE revision_id = ? ORDER BY id ASC`).all(revisionId) as SqliteMemoryCitationRow[])
      : (this.db.prepare(`SELECT * FROM memory_citations ORDER BY id ASC`).all() as SqliteMemoryCitationRow[]);
    return rows.map(rowToMemoryCitation);
  }

  async recordMemoryValidationIssues(issues: MemoryValidationIssue[]): Promise<void> {
    if (!issues.length) {
      return;
    }
    const insert = this.db.prepare(
      `INSERT INTO memory_validation_issues (run_id, pack_id, page_id, severity, code, message, context_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const transaction = this.db.transaction(() => {
      for (const issue of issues) {
        insert.run(
          issue.runId,
          issue.packId ?? null,
          issue.pageId ?? null,
          issue.severity,
          issue.code,
          issue.message,
          stringifyJson(issue.context ?? null)
        );
      }
    });
    transaction();
  }

  async listMemoryValidationIssues(runId?: string): Promise<MemoryValidationIssue[]> {
    const rows = runId
      ? (this.db.prepare(`SELECT * FROM memory_validation_issues WHERE run_id = ? ORDER BY id ASC`).all(runId) as SqliteMemoryIssueRow[])
      : (this.db.prepare(`SELECT * FROM memory_validation_issues ORDER BY id ASC`).all() as SqliteMemoryIssueRow[]);
    return rows.map(rowToMemoryIssue);
  }

  async markStaleMemoryForMissingMessages(): Promise<number> {
    const missing = this.db
      .prepare(
        `SELECT DISTINCT r.page_id
         FROM memory_page_revisions r
         JOIN memory_citations c ON c.revision_id = r.id
         LEFT JOIN messages m ON m.source_message_key = c.source_message_key
         WHERE r.status = 'current' AND m.id IS NULL`
      )
      .all() as Array<{ page_id: string }>;
    if (!missing.length) {
      return 0;
    }
    const updatePages = this.db.prepare(`UPDATE memory_pages SET status = 'stale', updated_at = ? WHERE page_id = ?`);
    const updateRevisions = this.db.prepare(`UPDATE memory_page_revisions SET status = 'stale' WHERE page_id = ? AND status = 'current'`);
    const now = currentIso();
    const transaction = this.db.transaction(() => {
      for (const row of missing) {
        updatePages.run(now, row.page_id);
        updateRevisions.run(row.page_id);
      }
    });
    transaction();
    return missing.length;
  }

  async resolveMemoryCitation(citationLabelOrMessageKey: string): Promise<MemoryCitationRecord | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM memory_citations
         WHERE citation_label = ? OR source_message_key = ?
         ORDER BY id DESC
         LIMIT 1`
      )
      .get(citationLabelOrMessageKey, citationLabelOrMessageKey) as SqliteMemoryCitationRow | undefined;
    return row ? rowToMemoryCitation(row) : null;
  }

  async listNearbyMemoryMessages(messageId: number, radius: number): Promise<MemoryEvidenceMessage[]> {
    const base = this.db.prepare(`SELECT chat_id FROM messages WHERE id = ?`).get(messageId) as { chat_id: number } | undefined;
    if (!base) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT m.id, m.source_message_key, m.source_message_id, chats.source_chat_id, m.chat_id,
                NULLIF(TRIM(COALESCE(chats.display_name, '')), '') AS chat_display_name, chats.jid AS chat_jid,
                m.sender_source_jid,
                ${contactLabelSql("c.")} AS sender_display_name,
                m.timestamp_ms, m.sent_at, m.direction, m.message_type, m.is_deleted, m.has_media, m.source_table,
                COALESCE(NULLIF(m.body, ''), NULLIF(m.caption, '')) AS text,
                ${MEDIA_STATE_SELECT}, ${QUOTED_SNAPSHOT_SELECT}
         FROM messages m
         JOIN chats ON chats.id = m.chat_id
         LEFT JOIN contacts c ON c.source_jid = m.sender_source_jid
         ${MEDIA_STATE_JOINS}
         ${QUOTED_SNAPSHOT_JOINS}
         WHERE m.chat_id = ? AND m.id BETWEEN ? AND ?
         ORDER BY m.timestamp_ms ASC, m.id ASC`
      )
      .all(base.chat_id, messageId - radius, messageId + radius) as SqliteMemoryEvidenceRow[];
    return rows.map((row, index) => {
      const evidence = rowToMemoryEvidence(row, index);
      evidence.structuredSignals = this.structuredSignalsForMessage(evidence.messageId, evidence.sourceMessageKey);
      return evidence;
    });
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private getContactIds(jids: string[]): Map<string, number> {
    return getIds(this.db, "contacts", "source_jid", jids);
  }

  private propagateContactNamesToDmChats(contacts: ContactRecord[]): void {
    const updateDisplayName = this.db.prepare(
      `UPDATE chats
       SET display_name = ?, updated_at = ?
       WHERE source_chat_id = ?
         AND chat_type IN ('dm', 'unknown')`
    );
    const updatePushNameFallback = this.db.prepare(
      `UPDATE chats
       SET display_name = ?, updated_at = ?
       WHERE source_chat_id = ?
         AND chat_type IN ('dm', 'unknown')
         AND (
           display_name IS NULL
           OR TRIM(display_name) = ''
           OR display_name = jid
           OR display_name = source_chat_id
           OR display_name = ?
         )`
    );
    const transaction = this.db.transaction(() => {
      for (const contact of contacts) {
        const displayName = contact.displayName?.trim();
        const pushName = contact.pushName?.trim();
        if (!contact.sourceJid) {
          continue;
        }
        // Identity-derived "names" (bare digits of the JID) may fill an empty
        // slot but must never replace a real name.
        if (displayName && !isIdentityDerivedName(displayName, contact.sourceJid)) {
          updateDisplayName.run(displayName, currentIso(), contact.sourceJid);
        } else if (pushName && !isIdentityDerivedName(pushName, contact.sourceJid)) {
          updatePushNameFallback.run(pushName, currentIso(), contact.sourceJid, localPartFromJid(contact.sourceJid));
        }
      }
    });
    transaction();
  }

  private getChatIds(sourceChatIds: string[]): Map<string, number> {
    return getIds(this.db, "chats", "source_chat_id", sourceChatIds);
  }

  private getLatestWarnings(importRunId: string): ImportWarning[] {
    const rows = this.db
      .prepare(
        `SELECT id, severity, code, entity_type, source_table, source_row_id, message, context_json
         FROM import_warnings
         WHERE import_run_id = ?
         ORDER BY id DESC
         LIMIT 8`
      )
      .all(importRunId) as SqliteWarningRow[];
    return rows.map((row) => ({
      id: Number(row.id),
      severity: row.severity as ImportWarning["severity"],
      code: row.code,
      entityType: row.entity_type,
      sourceTable: row.source_table,
      sourceRowId: row.source_row_id,
      message: row.message,
      context: parseJson(row.context_json)
    }));
  }

  private isInitialized(): boolean {
    return isSchemaPresent(this.db);
  }

  private restoreFromSnapshot(snapshotPath: string): void {
    const snapshotName = "import_restore_snapshot";
    this.db.pragma("foreign_keys = OFF");
    try {
      this.db.prepare(`ATTACH DATABASE ? AS ${snapshotName}`).run(snapshotPath);
      try {
        this.db.transaction(() => {
          for (const table of DELETE_TABLE_ORDER) {
            this.db.prepare(`DELETE FROM ${table}`).run();
          }
          for (const table of ARCHIVE_TABLES) {
            const columns = tableColumns(this.db, table);
            const columnList = columns.map(quoteIdentifier).join(", ");
            this.db.prepare(`INSERT INTO ${table} (${columnList}) SELECT ${columnList} FROM ${snapshotName}.${table}`).run();
          }
          // schema_meta must roll back too, or a failed clear-and-replace over a
          // legacy archive would leave the new identity stamp on legacy data.
          this.db.prepare(`DELETE FROM schema_meta`).run();
          this.db.prepare(`INSERT INTO schema_meta (key, value, updated_at) SELECT key, value, updated_at FROM ${snapshotName}.schema_meta`).run();
          this.clearSqliteSequence();
          this.db.prepare("INSERT INTO sqlite_sequence (name, seq) SELECT name, seq FROM import_restore_snapshot.sqlite_sequence").run();
        })();
      } finally {
        this.db.prepare(`DETACH DATABASE ${snapshotName}`).run();
      }
    } finally {
      this.db.pragma("foreign_keys = ON");
    }
    // Recompute the legacy gate and rebuild the identity-link cache from the
    // restored tables, discarding anything learned during the aborted run.
    this.initializeIdentityState();
    // Re-read the restored fts_state stamp; if the index was invalid before the
    // restore, its garbage survived the replay and the stamp must stay honest.
    const stateBefore = this.cachedFtsState;
    this.cachedFtsState = null;
    if (stateBefore === "needs_rebuild") {
      this.setFtsState("needs_rebuild");
    }
  }

  private clearSqliteSequence(): void {
    const row = this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`).get();
    if (row) {
      this.db.prepare("DELETE FROM sqlite_sequence").run();
    }
  }
}

function configureDatabase(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
}

function ensureSchema(db: Database.Database): void {
  migrateLiveSessionStatuses(db);
  migrateLiveMessageUpdateTypes(db);
  migratePersonLinkEventActions(db);
  migrateBrainRunKinds(db);
  migrateLifecycleDismissed(db);
  rebuildBrainDerivedTablesIfStale(db);
  db.exec(schemaStatements.join(";\n"));
  migrateAdditiveColumns(db);
  migrateArchiveSignalTables(db);
  backfillBrainEpisodeSignalAnchors(db);
  ensureSearchSchema(db);
  // Drop the removed view-once recovery queue if a prior build created it. It
  // only ever held transient request state (message keys, no content), so this
  // is safe cleanup, not a data migration.
  db.exec(`DROP TABLE IF EXISTS view_once_recovery`);
}

// Contract-v2 shape guard: the episode schema is wiped-and-rebuilt, never
// migrated (roadmap standing sanction — all brain data is derived and
// regenerable). An old-shape brain_episodes (no extraction_version column)
// means every derived brain table predates the final contract: drop the whole
// derived set (episodes/claims/citations + v2 tables, plus brain_runs and
// brain_tasks whose kind CHECKs changed), wipe the watermarks with them so
// coverage never outlives the episodes that justify it, and clear the
// projected files (a pure one-way projection of the dropped rows).
function rebuildBrainDerivedTablesIfStale(db: Database.Database): void {
  const existing = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'brain_episodes'`)
    .get() as { sql: string } | undefined;
  if (!existing?.sql || existing.sql.includes("extraction_version")) {
    return;
  }
  const dropped = [
    "brain_media_gaps",
    "brain_episode_signal_anchors",
    "brain_validation_issues",
    "brain_episode_topics",
    "brain_topics",
    "brain_claim_entities",
    "brain_citations",
    "brain_claims",
    "brain_episodes",
    "brain_runs",
    "brain_tasks"
  ];
  const episodeCount = Number((db.prepare(`SELECT COUNT(*) AS n FROM brain_episodes`).get() as { n: number }).n);
  db.transaction(() => {
    for (const table of dropped) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    db.exec(`DELETE FROM brain_chat_watermarks`);
  })();
  let filesRemoved = 0;
  try {
    const episodesDir = path.join(config.brain.rootDir, "episodes");
    if (fs.existsSync(episodesDir)) {
      for (const file of fs.readdirSync(episodesDir)) {
        if (file.endsWith(".md")) {
          fs.rmSync(path.join(episodesDir, file), { force: true });
          filesRemoved += 1;
        }
      }
    }
  } catch {
    // Projection cleanup is best-effort; the DB rebuild is what matters.
  }
  console.warn(
    `[brain] contract-v2 schema rebuild: dropped pre-v2 derived tables (${episodeCount} episode(s) discarded — all regenerable), ` +
      `wiped watermarks and the task queue, removed ${filesRemoved} projected file(s). The next run re-assimilates from scratch.`
  );
}

// SQLite cannot alter CHECK constraints in place; rebuild brain_runs when an
// older archive lacks a run kind the app now uses ('lifecycle'). The table is
// a small run-history log — copy-rename preserves it whole.
function migrateBrainRunKinds(db: Database.Database): void {
  const existing = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'brain_runs'`).get() as
    | { sql: string }
    | undefined;
  if (!existing?.sql || BRAIN_RUN_KINDS.every((kind) => existing.sql.includes(`'${kind}'`))) {
    return;
  }
  db.transaction(() => {
    db.exec(brainRunsTableDdl("brain_runs_migrated"));
    db.exec(
      `INSERT INTO brain_runs_migrated (id, kind, status, started_at, finished_at, timezone, totals_json, error_message, created_at)
       SELECT id, kind, status, started_at, finished_at, timezone, totals_json, error_message, created_at FROM brain_runs`
    );
    db.exec(`DROP TABLE brain_runs`);
    db.exec(`ALTER TABLE brain_runs_migrated RENAME TO brain_runs`);
  })();
}

// The former 'cancelled' lifecycle status was renamed 'dismissed' (one
// "not-done / off-my-list" terminal). Rebuild brain_lifecycle_events with the
// new CHECK, mapping any existing cancelled rows to dismissed so no audited
// user/model transition is lost. Copy-rename (SQLite can't alter a CHECK).
function migrateLifecycleDismissed(db: Database.Database): void {
  const existing = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'brain_lifecycle_events'`).get() as
    | { sql: string }
    | undefined;
  if (!existing?.sql || !existing.sql.includes("'cancelled'")) {
    return;
  }
  db.transaction(() => {
    db.exec(brainLifecycleEventsTableDdl("brain_lifecycle_events_migrated"));
    db.exec(
      `INSERT INTO brain_lifecycle_events_migrated (id, claim_id, to_status, source, evidence_at_ms, note, run_id, model, orphaned_at_ms, created_at_ms)
       SELECT id, claim_id, CASE to_status WHEN 'cancelled' THEN 'dismissed' ELSE to_status END, source, evidence_at_ms, note, run_id, model, orphaned_at_ms, created_at_ms
       FROM brain_lifecycle_events`
    );
    db.exec(`DROP TABLE brain_lifecycle_events`);
    db.exec(`ALTER TABLE brain_lifecycle_events_migrated RENAME TO brain_lifecycle_events`);
  })();
}

// SQLite cannot alter CHECK constraints in place; rebuild live_message_updates
// when an older archive lacks an update type the app now uses (poll_vote,
// event_response).
function migrateLiveMessageUpdateTypes(db: Database.Database): void {
  const existing = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'live_message_updates'`)
    .get() as { sql: string } | undefined;
  if (!existing?.sql || MESSAGE_UPDATE_TYPES.every((type) => existing.sql.includes(`'${type}'`))) {
    return;
  }
  db.transaction(() => {
    db.exec(liveMessageUpdatesTableDdl("live_message_updates_migrated"));
    db.exec(
      `INSERT INTO live_message_updates_migrated
       (event_key, chat_source_id, source_message_key, update_type, occurred_at_ms, applied, metadata_json, created_at, updated_at)
       SELECT event_key, chat_source_id, source_message_key, update_type, occurred_at_ms, applied, metadata_json, created_at, updated_at
       FROM live_message_updates`
    );
    db.exec(`DROP TABLE live_message_updates`);
    db.exec(`ALTER TABLE live_message_updates_migrated RENAME TO live_message_updates`);
  })();
}

// SQLite cannot alter CHECK constraints in place; rebuild person_link_events
// when an older archive lacks the newest audit action ('release'; 'unreject'
// arrived the same way). The table is a small append-only audit trail —
// copy-rename preserves it whole.
function migratePersonLinkEventActions(db: Database.Database): void {
  const existing = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'person_link_events'`)
    .get() as { sql: string } | undefined;
  if (!existing?.sql || existing.sql.includes("'release'")) {
    return;
  }
  db.transaction(() => {
    db.exec(`CREATE TABLE person_link_events_migrated (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL CHECK (action IN ('connect','disconnect','union','dissolve','suggest','accept','reject','unreject','release')),
      person_id TEXT NULL,
      identity_jid TEXT NULL,
      source TEXT NULL,
      evidence_json TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`);
    db.exec(
      `INSERT INTO person_link_events_migrated (id, action, person_id, identity_jid, source, evidence_json, created_at)
       SELECT id, action, person_id, identity_jid, source, evidence_json, created_at FROM person_link_events`
    );
    db.exec(`DROP TABLE person_link_events`);
    db.exec(`ALTER TABLE person_link_events_migrated RENAME TO person_link_events`);
  })();
}

function migrateAdditiveColumns(db: Database.Database): void {
  const additions: Array<{ table: string; column: string; ddl: string }> = [
    { table: "chats", column: "platform_recency_ms", ddl: "ALTER TABLE chats ADD COLUMN platform_recency_ms INTEGER NULL" },
    { table: "messages", column: "resolved_text", ddl: "ALTER TABLE messages ADD COLUMN resolved_text TEXT NULL" },
    { table: "contacts", column: "display_name_source", ddl: "ALTER TABLE contacts ADD COLUMN display_name_source TEXT NULL" },
    // brain-correctness-debts: compound watermark cursor, per-episode fallback
    // reason, and the ledger's estimated-usage flag — all additive.
    { table: "brain_chat_watermarks", column: "assimilated_through_id", ddl: "ALTER TABLE brain_chat_watermarks ADD COLUMN assimilated_through_id INTEGER NOT NULL DEFAULT 0" },
    { table: "brain_episodes", column: "fallback_reason", ddl: "ALTER TABLE brain_episodes ADD COLUMN fallback_reason TEXT NULL" },
    { table: "brain_llm_ledger", column: "estimated", ddl: "ALTER TABLE brain_llm_ledger ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0" },
    { table: "brain_episodes", column: "quoted_reply_anchors_json", ddl: "ALTER TABLE brain_episodes ADD COLUMN quoted_reply_anchors_json TEXT NULL" },
    { table: "brain_episodes", column: "archive_signal_anchors_json", ddl: "ALTER TABLE brain_episodes ADD COLUMN archive_signal_anchors_json TEXT NULL" },
    // Eval harness: the model a fallback episode *attempted* — the truthful
    // join for per-model fallback rates (the fallback commit nulls `model`).
    { table: "brain_episodes", column: "attempted_model", ddl: "ALTER TABLE brain_episodes ADD COLUMN attempted_model TEXT NULL" },
    { table: "message_mentions", column: "source_mask", ddl: "ALTER TABLE message_mentions ADD COLUMN source_mask INTEGER NOT NULL DEFAULT 0" },
    // retrieval-hardening: sender label split out of resolved_text, plus the
    // low-weight context stratum (orphaned quote snapshots, link previews).
    { table: "messages", column: "resolved_sender", ddl: "ALTER TABLE messages ADD COLUMN resolved_sender TEXT NULL" },
    { table: "messages", column: "resolved_context", ddl: "ALTER TABLE messages ADD COLUMN resolved_context TEXT NULL" },
    // semantic-rollups: supersession projection on claims (revisions are the
    // durable truth) and the doc anchor for rollup validation issues.
    {
      table: "brain_claims",
      column: "superseded_by_claim_id",
      ddl: "ALTER TABLE brain_claims ADD COLUMN superseded_by_claim_id TEXT NULL REFERENCES brain_claims(id) ON DELETE SET NULL"
    },
    { table: "brain_validation_issues", column: "doc_id", ddl: "ALTER TABLE brain_validation_issues ADD COLUMN doc_id TEXT NULL" }
  ];
  for (const addition of additions) {
    const columns = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(addition.table) as Array<{ name: string }>;
    if (!columns.some((column) => column.name === addition.column)) {
      db.exec(addition.ddl);
    }
  }
  // Created here (not in schemaStatements) because on a pre-rollups archive the
  // column above lands only after the base DDL already ran.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_brain_claims_superseded ON brain_claims (superseded_by_claim_id) WHERE superseded_by_claim_id IS NOT NULL`
  );
  // Same reason: doc_id lands by ALTER above, so its index cannot live in
  // schemaStatements. Scoping run history to one page reads issues by doc.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_brain_issues_doc ON brain_validation_issues (doc_id) WHERE doc_id IS NOT NULL`);
}

// Signal capture originally stored one winning source on each canonical row.
// These migrations are additive for payload tables and rebuild only the two
// narrow CHECK-constrained history tables so newer verified actions can be
// represented without weakening any existing rows.
function migrateArchiveSignalTables(db: Database.Database): void {
  const additions: Array<{ table: string; column: string; ddl: string }> = [
    { table: "group_membership_events", column: "old_role", ddl: "ALTER TABLE group_membership_events ADD COLUMN old_role TEXT NULL" },
    { table: "group_membership_events", column: "new_role", ddl: "ALTER TABLE group_membership_events ADD COLUMN new_role TEXT NULL" },
    { table: "group_membership_events", column: "raw_type", ddl: "ALTER TABLE group_membership_events ADD COLUMN raw_type TEXT NULL" },
    { table: "group_membership_events", column: "raw_parameters", ddl: "ALTER TABLE group_membership_events ADD COLUMN raw_parameters TEXT NULL" },
    { table: "chat_metadata_history", column: "raw_type", ddl: "ALTER TABLE chat_metadata_history ADD COLUMN raw_type TEXT NULL" },
    { table: "chat_metadata_history", column: "raw_parameters", ddl: "ALTER TABLE chat_metadata_history ADD COLUMN raw_parameters TEXT NULL" },
    { table: "message_locations", column: "url", ddl: "ALTER TABLE message_locations ADD COLUMN url TEXT NULL" },
    { table: "message_locations", column: "comment", ddl: "ALTER TABLE message_locations ADD COLUMN comment TEXT NULL" },
    { table: "message_locations", column: "caption", ddl: "ALTER TABLE message_locations ADD COLUMN caption TEXT NULL" },
    { table: "message_locations", column: "speed_mps", ddl: "ALTER TABLE message_locations ADD COLUMN speed_mps REAL NULL" },
    { table: "message_locations", column: "heading_degrees", ddl: "ALTER TABLE message_locations ADD COLUMN heading_degrees REAL NULL" },
    { table: "message_locations", column: "sequence_number", ddl: "ALTER TABLE message_locations ADD COLUMN sequence_number INTEGER NULL" },
    { table: "message_locations", column: "time_offset_ms", ddl: "ALTER TABLE message_locations ADD COLUMN time_offset_ms INTEGER NULL" },
    { table: "message_locations", column: "live_share_duration_ms", ddl: "ALTER TABLE message_locations ADD COLUMN live_share_duration_ms INTEGER NULL" },
    { table: "message_locations", column: "final_at_ms", ddl: "ALTER TABLE message_locations ADD COLUMN final_at_ms INTEGER NULL" },
    { table: "message_locations", column: "has_thumbnail", ddl: "ALTER TABLE message_locations ADD COLUMN has_thumbnail INTEGER NOT NULL DEFAULT 0" },
    { table: "message_vcards", column: "properties_json", ddl: "ALTER TABLE message_vcards ADD COLUMN properties_json TEXT NULL" },
    { table: "message_vcards", column: "download_kind", ddl: "ALTER TABLE message_vcards ADD COLUMN download_kind TEXT NOT NULL DEFAULT 'unavailable'" },
    { table: "message_vcards", column: "download_file_name", ddl: "ALTER TABLE message_vcards ADD COLUMN download_file_name TEXT NULL" },
    { table: "message_deletions", column: "revoked_by_admin", ddl: "ALTER TABLE message_deletions ADD COLUMN revoked_by_admin INTEGER NULL" },
    { table: "message_deletions", column: "deletion_kind", ddl: "ALTER TABLE message_deletions ADD COLUMN deletion_kind TEXT NULL" }
  ];
  for (const addition of additions) {
    const columns = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(addition.table) as Array<{ name: string }>;
    if (!columns.some((column) => column.name === addition.column)) db.exec(addition.ddl);
  }
  rebuildSignalHistoryChecks(db);
  backfillArchiveSignalObservations(db);
  backfillRetainedVcardDetails(db);
}

function rebuildSignalHistoryChecks(db: Database.Database): void {
  const membershipSql = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'group_membership_events'`).get() as { sql?: string } | undefined)?.sql ?? "";
  const metadataSql = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_metadata_history'`).get() as { sql?: string } | undefined)?.sql ?? "";
  if (!membershipSql.includes("'promote'")) {
    db.transaction(() => {
      db.exec(`CREATE TABLE group_membership_events_migrated (
        event_key TEXT PRIMARY KEY, group_source_id TEXT NOT NULL, participant_jid TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('add','remove','join','leave','invite','accept','promote','demote')),
        actor_jid TEXT NULL, source_message_key TEXT NULL, old_role TEXT NULL, new_role TEXT NULL, raw_type TEXT NULL, raw_parameters TEXT NULL,
        source TEXT NOT NULL CHECK (source IN ('backup','live')), source_event_key TEXT NULL, observed_at_ms INTEGER NULL, capture_version INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`);
      db.exec(`INSERT INTO group_membership_events_migrated
        (event_key, group_source_id, participant_jid, action, actor_jid, source_message_key, old_role, new_role, raw_type, raw_parameters, source, source_event_key, observed_at_ms, capture_version, created_at, updated_at)
        SELECT event_key, group_source_id, participant_jid, action, actor_jid, source_message_key, old_role, new_role, raw_type, raw_parameters, source, source_event_key, observed_at_ms, capture_version, created_at, updated_at FROM group_membership_events`);
      db.exec(`DROP TABLE group_membership_events`);
      db.exec(`ALTER TABLE group_membership_events_migrated RENAME TO group_membership_events`);
    })();
  }
  if (!metadataSql.includes("'invite_link'")) {
    db.transaction(() => {
      db.exec(`CREATE TABLE chat_metadata_history_migrated (
        event_key TEXT PRIMARY KEY, chat_source_id TEXT NOT NULL,
        field TEXT NOT NULL CHECK (field IN ('subject','description','photo','invite_link','announcement','restriction','member_add','join_approval','disappearing')),
        source_message_key TEXT NULL, actor_jid TEXT NULL, old_value TEXT NULL, new_value TEXT NULL, raw_type TEXT NULL, raw_parameters TEXT NULL,
        source TEXT NOT NULL CHECK (source IN ('backup','live')), source_event_key TEXT NULL, observed_at_ms INTEGER NULL, capture_version INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`);
      db.exec(`INSERT INTO chat_metadata_history_migrated
        (event_key, chat_source_id, field, source_message_key, actor_jid, old_value, new_value, raw_type, raw_parameters, source, source_event_key, observed_at_ms, capture_version, created_at, updated_at)
        SELECT event_key, chat_source_id, field, source_message_key, actor_jid, old_value, new_value, raw_type, raw_parameters, source, source_event_key, observed_at_ms, capture_version, created_at, updated_at FROM chat_metadata_history`);
      db.exec(`DROP TABLE chat_metadata_history`);
      db.exec(`ALTER TABLE chat_metadata_history_migrated RENAME TO chat_metadata_history`);
    })();
  }
}

function backfillArchiveSignalObservations(db: Database.Database): void {
  const statements = [
    `INSERT OR IGNORE INTO archive_signal_observations (fact_key, family, source, source_event_key, source_message_key, observed_at_ms, capture_version, detail_json)
     SELECT event_key, 'number_change', source, COALESCE(source_event_key, ''), source_message_key, observed_at_ms, capture_version, NULL FROM identity_number_changes`,
    `INSERT OR IGNORE INTO archive_signal_observations (fact_key, family, source, source_event_key, source_message_key, observed_at_ms, capture_version, detail_json)
     SELECT period_key, 'membership_period', source, COALESCE(source_event_key, ''), NULL, observed_at_ms, capture_version, NULL FROM group_membership_periods`,
    `INSERT OR IGNORE INTO archive_signal_observations (fact_key, family, source, source_event_key, source_message_key, observed_at_ms, capture_version, detail_json)
     SELECT event_key, 'membership_event', source, COALESCE(source_event_key, ''), source_message_key, observed_at_ms, capture_version, NULL FROM group_membership_events`,
    `INSERT OR IGNORE INTO archive_signal_observations (fact_key, family, source, source_event_key, source_message_key, observed_at_ms, capture_version, detail_json)
     SELECT event_key, 'chat_metadata', source, COALESCE(source_event_key, ''), source_message_key, observed_at_ms, capture_version, NULL FROM chat_metadata_history`,
    `INSERT OR IGNORE INTO archive_signal_observations (fact_key, family, source, source_event_key, source_message_key, observed_at_ms, capture_version, detail_json)
     SELECT source_message_key, 'location', source, COALESCE(source_event_key, ''), source_message_key, observed_at_ms, capture_version, NULL FROM message_locations`,
    `INSERT OR IGNORE INTO archive_signal_observations (fact_key, family, source, source_event_key, source_message_key, observed_at_ms, capture_version, detail_json)
     SELECT source_message_key || ':' || card_index, 'vcard', source, COALESCE(source_event_key, ''), source_message_key, observed_at_ms, capture_version, NULL FROM message_vcards`,
    `INSERT OR IGNORE INTO archive_signal_observations (fact_key, family, source, source_event_key, source_message_key, observed_at_ms, capture_version, detail_json)
     SELECT event_key, 'edit', source, COALESCE(source_event_key, ''), source_message_key, observed_at_ms, capture_version, NULL FROM message_edit_events`,
    `INSERT OR IGNORE INTO archive_signal_observations (fact_key, family, source, source_event_key, source_message_key, observed_at_ms, capture_version, detail_json)
     SELECT source_message_key, 'deletion', source, COALESCE(source_event_key, ''), source_message_key, observed_at_ms, capture_version, NULL FROM message_deletions`,
    `INSERT OR IGNORE INTO archive_signal_observations (fact_key, family, source, source_event_key, source_message_key, observed_at_ms, capture_version, detail_json)
     SELECT source_message_key || ':' || kind || ':' || segment_index, 'media_interpretation', source, COALESCE(source_event_key, ''), source_message_key, observed_at_ms, capture_version, NULL FROM message_media_interpretations`
  ];
  db.transaction(() => statements.forEach((statement) => db.exec(statement)))();
}

// Existing archives already retain source vCards. Populate the presentation
// metadata in place so opening a detail card after upgrade never requires a
// re-import and does not discard an unknown property or folded source line.
function backfillRetainedVcardDetails(db: Database.Database): void {
  const rows = db.prepare(
    `SELECT source_message_key, card_index, display_name, vcard, properties_json, download_kind, download_file_name
     FROM message_vcards WHERE vcard IS NOT NULL AND TRIM(vcard) <> ''`
  ).all() as Array<{
    source_message_key: string;
    card_index: number;
    display_name: string | null;
    vcard: string;
    properties_json: string | null;
    download_kind: string | null;
    download_file_name: string | null;
  }>;
  const update = db.prepare(
    `UPDATE message_vcards
     SET properties_json = ?, download_kind = ?, download_file_name = ?
     WHERE source_message_key = ? AND card_index = ?`
  );
  db.transaction(() => {
    for (const row of rows) {
      const hasProperties = Array.isArray(parseJson(row.properties_json));
      const properties = hasProperties ? row.properties_json : JSON.stringify(parseVcardPropertiesForStorage(row.vcard));
      const downloadKind = row.download_kind === "source" ? row.download_kind : "source";
      const fileName = row.download_file_name ?? safeVcardFileName(row.display_name, Number(row.card_index));
      if (!hasProperties || row.download_kind !== downloadKind || row.download_file_name == null) {
        update.run(properties, downloadKind, fileName, row.source_message_key, row.card_index);
      }
    }
  })();
}

function backfillBrainEpisodeSignalAnchors(db: Database.Database): void {
  const hasTable = db
    .prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'brain_episode_signal_anchors'`)
    .get() as { found: number } | undefined;
  if (!hasTable) return;
  const rows = db
    .prepare(`SELECT id, archive_signal_anchors_json FROM brain_episodes WHERE archive_signal_anchors_json IS NOT NULL`)
    .all() as Array<{ id: string; archive_signal_anchors_json: string | null }>;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO brain_episode_signal_anchors (episode_id, source_message_key, kind, capture_version) VALUES (?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (const row of rows) {
      const anchors = parseJson(row.archive_signal_anchors_json) as Array<ArchiveSignalAnchor> | null;
      for (const anchor of anchors ?? []) {
        if (!anchor?.sourceMessageKey || !Array.isArray(anchor.kinds)) continue;
        for (const kind of anchor.kinds) {
          if (["mention", "location", "vcard", "link_preview", "edit", "deletion", "media_interpretation"].includes(kind)) {
            insert.run(row.id, anchor.sourceMessageKey, kind, Math.max(1, Number(anchor.captureVersion ?? 1)));
          }
        }
      }
    }
  })();
}

// FTS + triggers land after column migration (they reference resolved_text).
// The state stamp is written once: an archive that already held messages when
// the index appeared must run a reindex before search answers — the empty
// index would otherwise silently pretend those messages do not exist.
function ensureSearchSchema(db: Database.Database): void {
  // Migration from the retired external-content design: drop it (including
  // any shadow-table corruption its delete-by-value triggers accumulated) and
  // force a rebuild under the rowid-keyed scheme.
  const existingFts = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'`)
    .get() as { sql: string } | undefined;
  const legacyExternalContent = Boolean(existingFts?.sql && existingFts.sql.includes("content="));
  // Structural column-set migration (retrieval-hardening): an index without
  // the sender/context columns predates the 5-column design. The trigger DDL
  // changed with it, so triggers are recreated alongside the table.
  const legacyColumnSet = Boolean(existingFts?.sql && !legacyExternalContent && !existingFts.sql.includes("sender"));
  if (legacyExternalContent || legacyColumnSet) {
    db.exec(
      `DROP TRIGGER IF EXISTS messages_fts_ai;
       DROP TRIGGER IF EXISTS messages_fts_ad;
       DROP TRIGGER IF EXISTS messages_fts_au;
       DROP TABLE IF EXISTS messages_fts;`
    );
  }
  db.exec(searchSchemaStatements.join(";\n"));
  const stamped = db.prepare(`SELECT value FROM schema_meta WHERE key = 'fts_state'`).get() as { value: string } | undefined;
  if (!stamped || legacyExternalContent || legacyColumnSet) {
    const messageCount = (db.prepare(`SELECT COUNT(*) AS count FROM messages`).get() as { count: number }).count;
    db.prepare(
      `INSERT INTO schema_meta (key, value, updated_at) VALUES ('fts_state', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(messageCount > 0 ? "needs_rebuild" : "ready", new Date().toISOString());
  }
  seedTermAliases(db);
}

// Idempotent alias seeding: INSERT OR IGNORE never overwrites rows learned or
// tuned later (same primary key), so re-boots are free and the seed acts as a
// floor, not an owner, of the alias table.
function seedTermAliases(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO brain_term_aliases (term, variant, source, weight) VALUES (?, ?, 'seed', 1.0)`
  );
  const apply = db.transaction(() => {
    for (const row of termAliasSeedRows()) {
      insert.run(normalizeTerm(row.term), normalizeTerm(row.variant));
    }
  });
  apply();
}

// SQLite cannot alter CHECK constraints in place; rebuild live_sessions when an
// older archive lacks a status value the app now uses.
function migrateLiveSessionStatuses(db: Database.Database): void {
  const existing = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'live_sessions'`)
    .get() as { sql: string } | undefined;
  if (!existing?.sql || LIVE_SESSION_STATUSES.every((status) => existing.sql.includes(`'${status}'`))) {
    return;
  }
  db.transaction(() => {
    db.exec(liveSessionsTableDdl("live_sessions_migrated"));
    db.exec(
      `INSERT INTO live_sessions_migrated
       (id, status, client_name, linked_device_jid, last_connected_at, last_disconnected_at, last_error, created_at, updated_at)
       SELECT id, status, client_name, linked_device_jid, last_connected_at, last_disconnected_at, last_error, created_at, updated_at
       FROM live_sessions`
    );
    db.exec(`DROP TABLE live_sessions`);
    db.exec(`ALTER TABLE live_sessions_migrated RENAME TO live_sessions`);
  })();
}

function isSchemaPresent(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE type = 'table' AND name IN ('import_runs', 'contacts', 'chats', 'messages')`
    )
    .get() as { count: number };
  return Number(row.count ?? 0) >= 4;
}

function getIds(db: Database.Database, table: string, column: string, values: string[]): Map<string, number> {
  const uniqueValues = [...new Set(values)].filter(Boolean);
  const ids = new Map<string, number>();
  if (uniqueValues.length === 0) {
    return ids;
  }
  for (let index = 0; index < uniqueValues.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
    const batch = uniqueValues.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db.prepare(`SELECT id, ${column} AS source_key FROM ${table} WHERE ${column} IN (${placeholders})`).all(...batch) as Array<{
      id: number;
      source_key: string;
    }>;
    for (const row of rows) {
      ids.set(row.source_key, Number(row.id));
    }
  }
  return ids;
}

function tableColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function stringifyJson(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return JSON.stringify(value);
}

const QUOTED_SNAPSHOT_SEMANTIC_COLUMNS = [
  "reply_message_key",
  "quoted_source_message_id",
  "quoted_source_chat_id",
  "quoted_sender_source_jid",
  "quoted_from_me",
  "timestamp_ms",
  "message_type",
  "raw_type_code",
  "body",
  "caption",
  "media_mime_type",
  "media_name",
  "thumbnail",
  "location_json",
  "vcard_json",
  "mentioned_jids_json"
] as const;

const QUOTED_SNAPSHOT_JSON_COLUMNS = new Set<string>(["location_json", "vcard_json", "mentioned_jids_json"]);

function quotedSnapshotRowsEqual(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined): boolean {
  if (!before || !after) {
    return before === after;
  }
  return QUOTED_SNAPSHOT_SEMANTIC_COLUMNS.every((column) => quotedSnapshotValueEqual(before[column], after[column], column));
}

function quotedSnapshotValueEqual(left: unknown, right: unknown, column: string): boolean {
  if (Buffer.isBuffer(left) || Buffer.isBuffer(right)) {
    return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right);
  }
  if (QUOTED_SNAPSHOT_JSON_COLUMNS.has(column)) {
    return canonicalJsonForComparison(left) === canonicalJsonForComparison(right);
  }
  return left === right;
}

function canonicalJsonForComparison(value: unknown): string | null {
  if (typeof value !== "string") {
    return value == null ? null : String(value);
  }
  try {
    return JSON.stringify(sortJsonValue(JSON.parse(value)));
  } catch {
    return value;
  }
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJsonValue(nested)])
    );
  }
  return value;
}

function parseJson(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  return JSON.parse(value) as Record<string, unknown>;
}

function parseArray(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function totalsOrEmpty(totals: ImportTotals | null | undefined): ImportTotals {
  return totals ?? { contacts: 0, chats: 0, participants: 0, messages: 0, skipped: 0, warnings: 0 };
}

function emptyLiveTotals(): LiveSyncTotals {
  return { contacts: 0, chats: 0, participants: 0, messages: 0, updates: 0, gapsOpened: 0, gapsClosed: 0, warnings: 0 };
}

function totalsOrEmptyLive(totals: LiveSyncTotals | null | undefined): LiveSyncTotals {
  return totals ?? emptyLiveTotals();
}

function rowToImportSummary(row: SqliteImportRunRow): ImportRunSummary {
  return {
    id: row.id,
    status: row.status as ImportRunSummary["status"],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    totals: totalsOrEmpty(parseJson(row.totals_json) as ImportTotals | null),
    warningCount: Number(row.warning_count ?? 0),
    errorMessage: row.error_message ?? null
  };
}

function rowToLiveSession(row: SqliteLiveSessionRow): LiveSessionSummary {
  return {
    id: row.id,
    status: row.status as LiveSessionSummary["status"],
    clientName: row.client_name,
    linkedDeviceJid: row.linked_device_jid,
    lastConnectedAt: row.last_connected_at,
    lastDisconnectedAt: row.last_disconnected_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToLiveRun(row: SqliteLiveRunRow): LiveSyncRunSummary {
  return {
    id: row.id,
    status: row.status as LiveSyncRunSummary["status"],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    totals: totalsOrEmptyLive(parseJson(row.totals_json) as LiveSyncTotals | null),
    warningCount: Number(row.warning_count ?? 0),
    errorMessage: row.error_message
  };
}

function rowToLiveCheckpoint(row: SqliteLiveCheckpointRow): LiveChatCheckpointRecord {
  return {
    chatSourceId: row.chat_source_id,
    chatId: row.chat_id,
    latestArchivedMessageKey: row.latest_archived_message_key,
    latestArchivedAtMs: nullableNumber(row.latest_archived_at_ms),
    earliestArchivedMessageKey: row.earliest_archived_message_key,
    earliestArchivedAtMs: nullableNumber(row.earliest_archived_at_ms),
    latestLiveMessageKey: row.latest_live_message_key,
    latestLiveAtMs: nullableNumber(row.latest_live_at_ms),
    oldestVerifiedMessageKey: row.oldest_verified_message_key,
    oldestVerifiedAtMs: nullableNumber(row.oldest_verified_at_ms),
    health: row.health as LiveHealthState,
    retryCount: Number(row.retry_count ?? 0),
    nextRecoveryAt: row.next_recovery_at,
    lastAuditAt: row.last_audit_at,
    rawMetadata: parseJson(row.raw_metadata_json)
  };
}

function rowToLiveGap(row: SqliteLiveGapRow): LiveGapWindowRecord {
  return {
    id: Number(row.id),
    chatSourceId: row.chat_source_id,
    chatId: row.chat_id,
    reason: row.reason as LiveGapReason,
    status: row.status as LiveGapStatus,
    startAtMs: nullableNumber(row.start_at_ms),
    endAtMs: nullableNumber(row.end_at_ms),
    requiredLowerBoundAtMs: nullableNumber(row.required_lower_bound_at_ms),
    anchorMessageKey: row.anchor_message_key,
    requestCount: Number(row.request_count ?? 0),
    lastAttemptAt: row.last_attempt_at,
    confidence: row.confidence as LiveGapWindowRecord["confidence"],
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToMemoryRun(row: SqliteMemoryRunRow): MemoryRunSummary {
  return {
    id: row.id,
    status: row.status as MemoryRunSummary["status"],
    kind: row.kind as MemoryRunSummary["kind"],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    sourceStartAtMs: nullableNumber(row.source_start_at_ms),
    sourceEndAtMs: nullableNumber(row.source_end_at_ms),
    pageCount: Number(row.page_count ?? 0),
    citationCount: Number(row.citation_count ?? 0),
    messageCount: Number(row.message_count ?? 0),
    warningCount: Number(row.warning_count ?? 0),
    errorMessage: row.error_message
  };
}

function rowToMemoryWindow(row: SqliteMemoryWindowRow): MemorySourceWindowRecord {
  return {
    id: row.id,
    runId: row.run_id,
    status: row.status as MemorySourceWindowRecord["status"],
    startAtMs: nullableNumber(row.start_at_ms),
    endAtMs: nullableNumber(row.end_at_ms),
    chatSourceIds: parseArray(row.chat_source_ids_json),
    messageCount: Number(row.message_count ?? 0),
    sourceHash: row.source_hash,
    committedAt: row.committed_at,
    createdAt: row.created_at
  };
}

function rowToMemoryEvidence(row: SqliteMemoryEvidenceRow, index: number): MemoryEvidenceMessage {
  const availability = deriveMediaAvailability(row);
  return {
    citationLabel: `m${index + 1}`,
    messageId: Number(row.id),
    sourceMessageKey: row.source_message_key,
    sourceMessageId: row.source_message_id,
    sourceChatId: row.source_chat_id,
    chatId: Number(row.chat_id),
    chatDisplayName: row.chat_display_name ?? displayPhoneFromJid(row.chat_jid),
    senderSourceJid: row.sender_source_jid,
    senderDisplayName: row.sender_display_name ?? displayPhoneFromJid(row.sender_source_jid),
    timestampMs: nullableNumber(row.timestamp_ms),
    sentAt: row.sent_at,
    direction: row.direction as MemoryEvidenceMessage["direction"],
    messageType: row.message_type,
    interpretation: interpretMessage({
      messageType: row.message_type,
      isDeleted: Boolean(row.is_deleted),
      hasHeldContent: Boolean(row.text) || availability === "stored",
      mediaAvailability: availability
    }),
    text: row.text,
    linkPreview:
      row.preview_title || row.preview_description || row.preview_url || row.preview_has_thumbnail
        ? {
            title: row.preview_title ?? null,
            description: row.preview_description ?? null,
            canonicalUrl: row.preview_url ?? null,
            hasThumbnail: Boolean(row.preview_has_thumbnail)
          }
        : null,
    // Tolerant of callers whose SELECT omits these columns (e.g. nearby-context
    // lookup); reactions are attached by listMemoryEvidenceMessages after the map.
    isForwarded: Boolean(row.is_forwarded),
    quotedSourceMessageId: row.quoted_source_message_id ?? null,
    quotedSnapshot: quoteSummaryFromRow(row),
    reactions: [],
    // Provenance only applies when the label actually resolved from the contact
    // row; a displayPhoneFromJid fallback is a number, not a push name.
    senderNameIsPushName: Boolean(row.sender_name_is_push_name) && row.sender_display_name != null
  };
}

function rowToMemoryRevision(row: SqliteMemoryRevisionRow): MemoryPageRevisionRecord {
  return {
    id: row.id,
    pageId: row.page_id,
    runId: row.run_id,
    windowId: row.window_id,
    title: row.title,
    path: row.page_path,
    summary: row.summary,
    markdown: row.markdown,
    status: row.status as MemoryPageRevisionRecord["status"],
    sourceStartAtMs: nullableNumber(row.source_start_at_ms),
    sourceEndAtMs: nullableNumber(row.source_end_at_ms),
    citationCount: Number(row.citation_count ?? 0),
    createdAt: row.created_at,
    metadata: parseJson(row.metadata_json)
  };
}

function rowToMemoryCitation(row: SqliteMemoryCitationRow): MemoryCitationRecord {
  return {
    id: Number(row.id),
    revisionId: row.revision_id,
    claimId: row.claim_id,
    citationLabel: row.citation_label,
    messageId: row.message_id == null ? null : Number(row.message_id),
    sourceMessageKey: row.source_message_key,
    sourceMessageId: row.source_message_id,
    sourceChatId: row.source_chat_id,
    senderSourceJid: row.sender_source_jid,
    timestampMs: nullableNumber(row.timestamp_ms)
  };
}

function rowToMemoryIssue(row: SqliteMemoryIssueRow): MemoryValidationIssue {
  return {
    id: Number(row.id),
    runId: row.run_id,
    packId: row.pack_id,
    pageId: row.page_id,
    severity: row.severity as MemoryValidationIssue["severity"],
    code: row.code,
    message: row.message,
    context: parseJson(row.context_json),
    createdAt: row.created_at
  };
}

function emptyStatus(initialized: boolean, error?: string): StatusSummary {
  return {
    database: {
      configured: true,
      initialized,
      adapter: "sqlite",
      location: path.basename(config.archive.sqlitePath),
      error
    },
    counts: { chats: 0, contacts: 0, participants: 0, messages: 0, warnings: 0 },
    latestImport: null,
    latestWarnings: []
  };
}

// Search tuning: dual candidate pool reranked in JS (BM25 × recency decay,
// plus the additive mention boost) and the reindex chunk size (rows recomputed
// per transaction between event-loop yields).
const SEARCH_CANDIDATE_POOL = 240;
const SEARCH_RECENCY_POOL = 120;
const SEARCH_MENTION_BOOST = 1.0;
const SEARCH_REINDEX_CHUNK = 2000;

interface SqliteSearchRow {
  id: number;
  source_message_key: string;
  source_message_id: string;
  chat_id: number;
  sender_source_jid: string | null;
  timestamp_ms: number | null;
  sent_at: string | null;
  direction: string;
  message_type: string;
  is_deleted: number;
  has_media: number;
  body: string | null;
  caption: string | null;
  resolved_text: string | null;
  resolved_sender: string | null;
  resolved_context: string | null;
  chat_source_id: string;
  chat_display_name: string | null;
  chat_type: string;
  sender_display_name: string | null;
  rank: number;
  snip_resolved: string | null;
  snip_body: string | null;
  snip_caption: string | null;
  snip_context: string | null;
}

// Prefer the snippet closest to what the user sees (body, then caption), then
// the resolved-text snippet (which may have matched a name or file name),
// then the context snippet (quoted-orphan or link-preview text). Sender-only
// matches fall through to a plain body excerpt — no fabricated highlight.
function pickSnippet(row: SqliteSearchRow): string {
  for (const candidate of [row.snip_body, row.snip_caption, row.snip_resolved, row.snip_context]) {
    if (candidate && candidate.includes(SEARCH_HIGHLIGHT_START)) {
      return candidate;
    }
  }
  return row.snip_body?.trim() || row.snip_caption?.trim() || row.snip_resolved?.trim() || (row.body ?? "").slice(0, 160);
}

// Derived search text for one message: resolved body/caption (mentions as
// names) and the media file name. Content-less rows stay null so system noise
// never matches content queries. The sender label lives in resolved_sender
// (its own low-weight FTS column, retrieval-hardening) — not co-mingled here.
function composeResolvedText(
  body: string | null,
  caption: string | null,
  mediaName: string | null,
  mentionLabels: Map<string, string>
): string | null {
  const parts: string[] = [];
  const resolvedBody = applyMentionLabels(body, mentionLabels)?.trim();
  const resolvedCaption = applyMentionLabels(caption, mentionLabels)?.trim();
  if (resolvedBody) {
    parts.push(resolvedBody);
  }
  if (resolvedCaption) {
    parts.push(resolvedCaption);
  }
  if (mediaName?.trim()) {
    parts.push(mediaName.trim());
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

// Secondary searchable text (the low-weight `context` FTS column): link
// preview title/description/URL (content that exists nowhere else), and a
// reply's quoted-snapshot text ONLY when the original is absent from the
// archive — in-chat quotes of live originals would double-hit otherwise.
function composeResolvedContext(
  orphanQuote: { body: string | null; caption: string | null } | null,
  preview: { title: string | null; description: string | null; canonicalUrl: string | null } | null
): string | null {
  const parts: string[] = [];
  if (orphanQuote?.body?.trim()) {
    parts.push(orphanQuote.body.trim());
  }
  if (orphanQuote?.caption?.trim()) {
    parts.push(orphanQuote.caption.trim());
  }
  if (preview?.title?.trim()) {
    parts.push(preview.title.trim());
  }
  if (preview?.description?.trim()) {
    parts.push(preview.description.trim());
  }
  if (preview?.canonicalUrl?.trim()) {
    parts.push(preview.canonicalUrl.trim());
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

// A "visible exchange" is a message a user would recognize as conversation:
// used both to hide event-only chats and to compute WhatsApp-style recency.
// brain-correctness-debts D1: the ONE predicate for "not yet assimilated".
// The watermark is a compound (timestamp, rowid) cursor; a visible message is
// covered only when a watermark row exists and it sorts at or before the
// cursor. Everything else — including a genuinely-new message sharing the
// watermark's exact timestamp (higher rowid) and every message in a chat with
// no watermark row — is pending. Backlog, coverage, and pack selection all
// share this so they can never disagree at the tie boundary.
function watermarkPendingPredicate(messageAlias: string, watermarkAlias: string): string {
  const m = messageAlias;
  const w = watermarkAlias;
  return `(${w}.assimilated_through_ms IS NULL
           OR COALESCE(${m}.timestamp_ms, 0) > ${w}.assimilated_through_ms
           OR (COALESCE(${m}.timestamp_ms, 0) = ${w}.assimilated_through_ms AND ${m}.id > ${w}.assimilated_through_id))`;
}

// Advance the compound watermark cursor, keeping the greater (timestamp, rowid)
// lexicographically so coverage never regresses. The id CASE reads the OLD row
// (SQLite evaluates every SET right-hand side against the pre-update row).
const WATERMARK_CURSOR_UPSERT = `INSERT INTO brain_chat_watermarks (chat_source_id, assimilated_through_ms, assimilated_through_id, last_episode_at, updated_at)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(chat_source_id) DO UPDATE SET
     assimilated_through_id = CASE
       WHEN excluded.assimilated_through_ms > brain_chat_watermarks.assimilated_through_ms THEN excluded.assimilated_through_id
       WHEN excluded.assimilated_through_ms < brain_chat_watermarks.assimilated_through_ms THEN brain_chat_watermarks.assimilated_through_id
       ELSE MAX(brain_chat_watermarks.assimilated_through_id, excluded.assimilated_through_id) END,
     assimilated_through_ms = MAX(brain_chat_watermarks.assimilated_through_ms, excluded.assimilated_through_ms),
     last_episode_at = excluded.last_episode_at,
     updated_at = excluded.updated_at`;

function visibleExchangePredicate(alias: string): string {
  return `${alias}.message_type NOT IN ('system', 'status', 'reaction', 'encrypted_update')
          AND (
            ${alias}.direction IN ('incoming', 'outgoing')
            OR NULLIF(TRIM(COALESCE(${alias}.body, '')), '') IS NOT NULL
            OR NULLIF(TRIM(COALESCE(${alias}.caption, '')), '') IS NOT NULL
            OR ${alias}.has_media = 1
            OR ${alias}.is_deleted = 1
            OR ${alias}.message_type = 'call'
          )`;
}

// UTC date (YYYY-MM-DD) matching how the ledger writes its `day` column, so
// daily budget/usage queries can hit the (day, purpose) index.
function utcDayString(ms: number = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function currentIso(): string {
  return new Date().toISOString();
}

// Nullable millisecond folds for graph seen-window maintenance: null means
// "no observation", never zero.
function minNullableMs(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null) {
    return b ?? null;
  }
  if (b == null) {
    return a;
  }
  return Math.min(a, b);
}

function maxNullableMs(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null) {
    return b ?? null;
  }
  if (b == null) {
    return a;
  }
  return Math.max(a, b);
}

// Raw brain_nodes row shape shared by the graph read paths.
interface GraphNodeRow {
  id: string;
  kind: BrainGraphNodeKind;
  natural_key: string;
  slug: string;
  title: string | null;
  jid: string | null;
  chat_scope: string | null;
  payload_json: string | null;
  status: BrainGraphNodeStatus;
  merged_into: string | null;
  salience: number;
  citation_count: number;
  evidence_days: number;
  engagement_factor: number;
  first_seen_at_ms: number | null;
  last_seen_at_ms: number | null;
}

// Semantic-consolidation row shapes (semantic-rollups).
interface BrainDocRow {
  doc_id: string;
  kind: BrainDocKind;
  node_id: string | null;
  slug: string | null;
  status: "active" | "merged";
  merged_into: string | null;
  current_revision_id: number | null;
  last_rollup_at_ms: number | null;
  created_at_ms: number;
}

interface DocRevisionRow {
  id: number;
  doc_id: string;
  revision: number;
  status: "current" | "superseded" | "rejected";
  sections_json: string;
  drops_json: string;
  fed_claim_ids_json: string;
  input_stats_json: string;
  resolutions_json: string;
  errors_json: string | null;
  model: string | null;
  effort: string | null;
  run_id: string | null;
  prompt_version: number;
  created_at_ms: number;
}

function isLidFormJid(jid: string): boolean {
  return jid.endsWith("@lid") || jid.endsWith("@hosted.lid");
}

// True when a "name" is just the identity restated (bare digits of the JID's
// local part, or the JID itself) — permitted as a fill, never as an overwrite.
function isIdentityDerivedName(name: string, jid: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) {
    return true;
  }
  const localPart = localPartFromJid(jid);
  return trimmed === jid || trimmed === localPart || trimmed.replace(/\D/g, "") === localPart;
}


function isoFromMs(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function nullableNumber(value: number | null | undefined): number | null {
  return value == null ? null : Number(value);
}

function signalProvenanceFromRow(row: Record<string, unknown>) {
  return {
    source: String(row.source) as "backup" | "live",
    sourceEventKey: (row.source_event_key as string | null) ?? null,
    observedAtMs: nullableNumber(row.observed_at_ms as number | null),
    captureVersion: Number(row.capture_version ?? 1)
  };
}

function numberChangeFromRow(row: Record<string, unknown>): IdentityNumberChangeRecord {
  return {
    ...signalProvenanceFromRow(row), eventKey: String(row.event_key), chatSourceId: (row.chat_source_id as string | null) ?? null,
    sourceMessageKey: (row.source_message_key as string | null) ?? null, oldJid: String(row.old_jid), newJid: String(row.new_jid), actorJid: (row.actor_jid as string | null) ?? null
  };
}

function membershipPeriodFromRow(row: Record<string, unknown>): GroupMembershipPeriodRecord {
  return {
    ...signalProvenanceFromRow(row), periodKey: String(row.period_key), groupSourceId: String(row.group_source_id), participantJid: String(row.participant_jid),
    joinedAtMs: nullableNumber(row.joined_at_ms as number | null), leftAtMs: nullableNumber(row.left_at_ms as number | null), role: (row.role as string | null) ?? null
  };
}

function membershipEventFromRow(row: Record<string, unknown>): GroupMembershipEventRecord {
  return {
    ...signalProvenanceFromRow(row), eventKey: String(row.event_key), groupSourceId: String(row.group_source_id), participantJid: String(row.participant_jid),
    action: String(row.action) as GroupMembershipEventRecord["action"], actorJid: (row.actor_jid as string | null) ?? null, sourceMessageKey: (row.source_message_key as string | null) ?? null,
    oldRole: (row.old_role as string | null) ?? null, newRole: (row.new_role as string | null) ?? null,
    rawType: (row.raw_type as string | null) ?? null, rawParameters: (row.raw_parameters as string | null) ?? null
  };
}

function chatMetadataFromRow(row: Record<string, unknown>): ChatMetadataHistoryRecord {
  return {
    ...signalProvenanceFromRow(row), eventKey: String(row.event_key), chatSourceId: String(row.chat_source_id), field: String(row.field) as ChatMetadataHistoryRecord["field"],
    sourceMessageKey: (row.source_message_key as string | null) ?? null, actorJid: (row.actor_jid as string | null) ?? null,
    oldValue: (row.old_value as string | null) ?? null, newValue: (row.new_value as string | null) ?? null,
    rawType: (row.raw_type as string | null) ?? null, rawParameters: (row.raw_parameters as string | null) ?? null
  };
}

function locationFromRow(row: Record<string, unknown>): import("../../shared/types").MessageLocationRecord {
  return {
    ...signalProvenanceFromRow(row), sourceMessageKey: String(row.source_message_key), latitude: nullableNumber(row.latitude as number | null), longitude: nullableNumber(row.longitude as number | null),
    name: (row.name as string | null) ?? null, address: (row.address as string | null) ?? null, isLive: Boolean(row.is_live), accuracyMeters: nullableNumber(row.accuracy_meters as number | null),
    url: (row.url as string | null) ?? null, comment: (row.comment as string | null) ?? null, caption: (row.caption as string | null) ?? null,
    speedMps: nullableNumber(row.speed_mps as number | null), headingDegrees: nullableNumber(row.heading_degrees as number | null), sequenceNumber: nullableNumber(row.sequence_number as number | null),
    timeOffsetMs: nullableNumber(row.time_offset_ms as number | null), liveShareDurationMs: nullableNumber(row.live_share_duration_ms as number | null), finalAtMs: nullableNumber(row.final_at_ms as number | null), hasThumbnail: Boolean(row.has_thumbnail)
  };
}

function locationObservationFromRow(row: Record<string, unknown>): MessageLocationObservationRecord {
  return {
    ...signalProvenanceFromRow(row), observationKey: String(row.observation_key), sourceMessageKey: String(row.source_message_key), latitude: nullableNumber(row.latitude as number | null), longitude: nullableNumber(row.longitude as number | null),
    accuracyMeters: nullableNumber(row.accuracy_meters as number | null), speedMps: nullableNumber(row.speed_mps as number | null), headingDegrees: nullableNumber(row.heading_degrees as number | null),
    sequenceNumber: nullableNumber(row.sequence_number as number | null), timeOffsetMs: nullableNumber(row.time_offset_ms as number | null), finalAtMs: nullableNumber(row.final_at_ms as number | null), hasThumbnail: Boolean(row.has_thumbnail)
  };
}

function vcardFromRow(row: Record<string, unknown>): import("../../shared/types").MessageVCardRecord {
  const properties = parseJson(row.properties_json as string | null);
  return {
    ...signalProvenanceFromRow(row), sourceMessageKey: String(row.source_message_key), cardIndex: Number(row.card_index), displayName: (row.display_name as string | null) ?? null,
    vcard: (row.vcard as string | null) ?? null, resolvedJid: (row.resolved_jid as string | null) ?? null,
    properties: Array.isArray(properties) ? properties as import("../../shared/types").VCardProperty[] : [],
    downloadKind: (row.download_kind as import("../../shared/types").VCardDownloadKind | null) ?? ((row.vcard as string | null) ? "source" : "unavailable"),
    downloadFileName: (row.download_file_name as string | null) ?? null
  };
}

function archiveSignalObservationFromRow(row: Record<string, unknown>): import("../../shared/types").ArchiveSignalObservation {
  return {
    ...signalProvenanceFromRow(row), factKey: String(row.fact_key), family: String(row.family) as import("../../shared/types").ArchiveSignalFamily,
    sourceMessageKey: (row.source_message_key as string | null) ?? null, sourceEventKey: (row.source_event_key as string | null) || null,
    detailJson: (row.detail_json as string | null) ?? null
  };
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

function parseVcardPropertiesForStorage(vcard: string): import("../../shared/types").VCardProperty[] {
  const unfolded = vcard.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const properties: import("../../shared/types").VCardProperty[] = [];
  for (const line of unfolded) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const [head, ...parameters] = line.slice(0, separator).split(";");
    const groupSeparator = head.lastIndexOf(".");
    const group = groupSeparator > 0 ? head.slice(0, groupSeparator) : null;
    const name = (groupSeparator > 0 ? head.slice(groupSeparator + 1) : head).trim().toUpperCase();
    if (!name) continue;
    properties.push({
      name,
      group,
      parameters: parameters.map((parameter) => {
        const equals = parameter.indexOf("=");
        const rawValues = equals >= 0 ? parameter.slice(equals + 1) : parameter;
        return { name: (equals >= 0 ? parameter.slice(0, equals) : "TYPE").trim().toUpperCase() || "TYPE", values: rawValues.split(",").map((value) => value.trim()).filter(Boolean) };
      }),
      value: line.slice(separator + 1)
    });
  }
  return properties;
}

function engagementFromRow(row: Record<string, unknown>): EngagementAggregateRecord {
  return {
    ...signalProvenanceFromRow(row), aggregateKey: String(row.aggregate_key), chatSourceId: String(row.chat_source_id), counterpartyJid: (row.counterparty_jid as string | null) ?? null,
    eligibleOutgoingCount: Number(row.eligible_outgoing_count), deliveredCount: Number(row.delivered_count), readCount: Number(row.read_count),
    responseLatencySampleCount: Number(row.response_latency_sample_count), medianResponseLatencyMs: nullableNumber(row.median_response_latency_ms as number | null),
    windowStartAtMs: nullableNumber(row.window_start_at_ms as number | null), windowEndAtMs: nullableNumber(row.window_end_at_ms as number | null), algorithmVersion: Number(row.algorithm_version)
  };
}

function localPartFromJid(jid: string): string {
  return jid.split("@")[0]?.split(":")[0] ?? jid;
}

interface SqliteImportRunRow {
  id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  totals_json: string | null;
  warning_count: number;
  error_message: string | null;
}

interface SqliteWarningRow {
  id: number;
  severity: string;
  code: string;
  entity_type: string | null;
  source_table: string | null;
  source_row_id: string | null;
  message: string;
  context_json: string | null;
}

interface SqliteChatRow {
  id: number;
  source_chat_id: string;
  jid: string;
  display_name: string;
  chat_type: string;
  message_count: number;
  participant_count: number;
  last_message_at: string | null;
}

interface SqliteBrainTaskRow {
  id: number;
  kind: string;
  chat_source_id: string | null;
  payload_json: string | null;
  dedupe_key: string;
  status: string;
  priority: number;
  attempts: number;
  next_attempt_at_ms: number | null;
  last_error: string | null;
}

interface SqliteBrainRunRow {
  id: string;
  kind: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  timezone: string | null;
  totals_json: string | null;
  error_message: string | null;
}

function rowToBrainTask(row: SqliteBrainTaskRow): BrainTaskRecord {
  return {
    id: Number(row.id),
    kind: row.kind as BrainTaskRecord["kind"],
    chatSourceId: row.chat_source_id,
    payload: parseJson(row.payload_json) as Record<string, unknown> | null,
    dedupeKey: row.dedupe_key,
    status: row.status as BrainTaskRecord["status"],
    priority: Number(row.priority),
    attempts: Number(row.attempts),
    nextAttemptAtMs: row.next_attempt_at_ms == null ? null : Number(row.next_attempt_at_ms),
    lastError: row.last_error
  };
}

function rowToBrainRun(row: SqliteBrainRunRow): BrainRunSummary {
  return {
    id: row.id,
    kind: row.kind as BrainRunSummary["kind"],
    status: row.status as BrainRunSummary["status"],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    timezone: row.timezone,
    totals: parseJson(row.totals_json) as Record<string, number> | null,
    errorMessage: row.error_message
  };
}

interface SqliteMessageRow extends SqliteMediaStateColumns, QuotedSnapshotRow {
  id: number;
  source_message_key: string;
  source_message_id: string;
  sender_display_name: string | null;
  sender_source_jid: string | null;
  timestamp_ms: number | null;
  sent_at: string | null;
  direction: string;
  message_type: string;
  body: string | null;
  caption: string | null;
  has_media: number;
  media_mime_type: string | null;
  media_name: string | null;
  is_deleted: number;
  is_forwarded: number;
  is_starred: number;
  source_table: string;
  edited_flag: number;
  edit_revision_count: number;
  preview_title: string | null;
  preview_description: string | null;
  preview_url: string | null;
  preview_has_thumbnail: number;
}

interface SqliteLiveSessionRow {
  id: string;
  status: string;
  client_name: string;
  linked_device_jid: string | null;
  last_connected_at: string | null;
  last_disconnected_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface SqliteLiveRunRow {
  id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  totals_json: string | null;
  warning_count: number;
  error_message: string | null;
}

interface SqliteLiveCheckpointRow {
  chat_source_id: string;
  chat_id: number | null;
  latest_archived_message_key: string | null;
  latest_archived_at_ms: number | null;
  earliest_archived_message_key: string | null;
  earliest_archived_at_ms: number | null;
  latest_live_message_key: string | null;
  latest_live_at_ms: number | null;
  oldest_verified_message_key: string | null;
  oldest_verified_at_ms: number | null;
  health: string;
  retry_count: number;
  next_recovery_at: string | null;
  last_audit_at: string | null;
  raw_metadata_json: string | null;
}

interface SqliteLiveGapRow {
  id: number;
  chat_source_id: string;
  chat_id: number | null;
  reason: string;
  status: string;
  start_at_ms: number | null;
  end_at_ms: number | null;
  required_lower_bound_at_ms: number | null;
  anchor_message_key: string | null;
  request_count: number;
  last_attempt_at: string | null;
  confidence: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface SqliteLiveHealthRow {
  chat_source_id: string;
  display_name: string | null;
  health: string;
  latest_archived_at_ms: number | null;
  latest_live_at_ms: number | null;
  oldest_verified_at_ms: number | null;
  next_recovery_at: string | null;
  open_gap_count: number;
}

interface SqliteMemoryRunRow {
  id: string;
  status: string;
  kind: string;
  started_at: string;
  finished_at: string | null;
  source_start_at_ms: number | null;
  source_end_at_ms: number | null;
  page_count: number;
  citation_count: number;
  message_count: number;
  warning_count: number;
  error_message: string | null;
}

interface SqliteMemoryWindowRow {
  id: string;
  run_id: string;
  status: string;
  start_at_ms: number | null;
  end_at_ms: number | null;
  chat_source_ids_json: string | null;
  message_count: number;
  source_hash: string;
  committed_at: string | null;
  created_at: string;
}

interface SqliteMemoryEvidenceRow extends SqliteMediaStateColumns, QuotedSnapshotRow {
  id: number;
  source_message_key: string;
  source_message_id: string;
  source_chat_id: string;
  chat_id: number;
  chat_display_name: string | null;
  chat_jid: string | null;
  sender_source_jid: string | null;
  sender_display_name: string | null;
  sender_name_is_push_name?: number;
  timestamp_ms: number | null;
  sent_at: string | null;
  direction: string;
  message_type: string;
  is_deleted: number;
  is_forwarded?: number;
  quoted_source_message_id?: string | null;
  text: string | null;
  preview_title?: string | null;
  preview_description?: string | null;
  preview_url?: string | null;
  preview_has_thumbnail?: number | null;
}

interface SqliteMemoryRevisionRow {
  id: string;
  page_id: string;
  run_id: string;
  window_id: string;
  title: string;
  page_path: string;
  summary: string;
  markdown: string;
  status: string;
  source_start_at_ms: number | null;
  source_end_at_ms: number | null;
  citation_count: number;
  metadata_json: string | null;
  created_at: string;
}

interface SqliteMemoryCitationRow {
  id: number;
  revision_id: string;
  claim_id: string;
  citation_label: string;
  message_id: number | null;
  source_message_key: string;
  source_message_id: string;
  source_chat_id: string;
  sender_source_jid: string | null;
  timestamp_ms: number | null;
}

interface SqliteMemoryIssueRow {
  id: number;
  run_id: string;
  pack_id: string | null;
  page_id: string | null;
  severity: string;
  code: string;
  message: string;
  context_json: string | null;
  created_at: string;
}
