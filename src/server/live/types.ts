import type {
  ChatRecord,
  ContactRecord,
  LiveConnectionState,
  LiveGapWindowRecord,
  LiveMessageUpdateRecord,
  LiveSyncTotals,
  MessageRecord,
  MessageSecretRecord,
  ParticipantRecord,
  RetainedPayloadRecord
} from "../../shared/types";

export const LIVE_CLIENT_NAME = "baileys";

export interface LiveMaintainerOptions {
  clientName: "baileys";
  authDir: string;
  readOnly: true;
  maxBackfillPerChatMessages: number;
  maxBackfillPerChatDays: number;
  maxConcurrentChatBackfills: number;
  minBackfillDelayMs: number;
  maxGapRetries: number;
  recoveryIntervalMs?: number;
  auditSettleMs?: number;
}

export interface LiveConnectionUpdate {
  state: LiveConnectionState;
  linkedDeviceJid?: string | null;
  pairingCode?: string | null;
  qrDataUrl?: string | null;
  lastError?: string | null;
}

export interface LiveMessageEvent {
  eventKey: string;
  eventType:
    | "messages.upsert"
    | "messaging-history.set"
    | "contacts.upsert"
    | "contacts.update"
    | "chats.upsert"
    | "chats.update"
    | "messages.update"
    | "messages.delete"
    | "messages.reaction"
    | "message-receipt.update"
    | "groups.update"
    | "group-participants.update"
    | "lid-mapping.update"
    | "call";
  mode: "notify" | "append" | "history" | "update";
  occurredAtMs?: number | null;
  contacts?: ContactRecord[];
  chats?: ChatRecord[];
  participants?: ParticipantRecord[];
  messages?: MessageRecord[];
  updates?: LiveMessageStateUpdate[];
  identityLinks?: Array<{ lid: string; pn: string }>;
  // Per-message secrets captured from envelopes, and secret-encrypted payloads
  // (poll votes, event responses, secret edits) retained for decryption.
  secrets?: MessageSecretRecord[];
  retainedPayloads?: RetainedPayloadRecord[];
  rawMetadata?: Record<string, unknown> | null;
}

export type LiveMessageStateUpdate = Omit<LiveMessageUpdateRecord, "applied">;

export interface LiveHistoryRequest {
  chatSourceId: string;
  anchor?: { id: string; fromMe?: boolean | null; participant?: string | null } | null;
  oldestMsgTimestampMs?: number | null;
  count: number;
}

export interface LiveHistoryResult {
  status: "closed" | "partial" | "unsupported" | "empty" | "failed";
  events: LiveMessageEvent[];
  oldestReturnedAtMs?: number | null;
  messageCount: number;
  errorMessage?: string | null;
}

export interface LiveGroupMetadataResult {
  subject: string | null;
  participants: Array<{ jid: string; role?: string | null }>;
  identityLinks: Array<{ lid: string; pn: string }>;
}

export interface LiveWhatsAppClient {
  readonly name: "baileys";
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onConnectionUpdate(handler: (update: LiveConnectionUpdate) => void | Promise<void>): void;
  onEvent(handler: (event: LiveMessageEvent) => void | Promise<void>): void;
  fetchHistory?(request: LiveHistoryRequest): Promise<LiveHistoryResult>;
  fetchGroupMetadata?(jid: string): Promise<LiveGroupMetadataResult | null>;
}

export interface LiveProofResult {
  client: "baileys";
  startedAt: string;
  finishedAt: string;
  connected: boolean;
  receivedMessagesUpsert: boolean;
  receivedHistorySync: boolean;
  onDemandHistorySupported: boolean | null;
  notes: string[];
}

export function emptyLiveTotals(): LiveSyncTotals {
  return { contacts: 0, chats: 0, participants: 0, messages: 0, updates: 0, gapsOpened: 0, gapsClosed: 0, warnings: 0 };
}

export function addEventToTotals(totals: LiveSyncTotals, event: LiveMessageEvent): LiveSyncTotals {
  return {
    ...totals,
    contacts: totals.contacts + (event.contacts?.length ?? 0),
    chats: totals.chats + (event.chats?.length ?? 0),
    participants: totals.participants + (event.participants?.length ?? 0),
    messages: totals.messages + (event.messages?.length ?? 0),
    updates: totals.updates + (event.updates?.length ?? 0)
  };
}

export function gapWithinLimits(gap: LiveGapWindowRecord, options: Pick<LiveMaintainerOptions, "maxBackfillPerChatDays" | "maxGapRetries">): boolean {
  if (gap.requestCount >= options.maxGapRetries) {
    return false;
  }
  if (gap.startAtMs != null && gap.endAtMs != null) {
    const days = Math.abs(gap.endAtMs - gap.startAtMs) / 86_400_000;
    if (days > options.maxBackfillPerChatDays) {
      return false;
    }
  }
  return true;
}
