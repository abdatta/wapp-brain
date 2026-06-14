export type ChatType = "dm" | "group" | "community" | "broadcast" | "status" | "unknown";

export type ImportRunStatus = "running" | "completed" | "failed";

export interface StatusSummary {
  database: {
    configured: boolean;
    initialized: boolean;
    adapter?: "sqlite" | "postgres" | "memory";
    location?: string;
    error?: string;
  };
  counts: {
    chats: number;
    contacts: number;
    participants: number;
    messages: number;
    warnings: number;
  };
  latestImport: ImportRunSummary | null;
  latestWarnings: ImportWarning[];
}

export interface ImportRunSummary {
  id: string;
  status: ImportRunStatus;
  startedAt: string;
  finishedAt: string | null;
  totals: ImportTotals;
  warningCount: number;
  errorMessage?: string | null;
}

export interface ImportTotals {
  contacts: number;
  chats: number;
  participants: number;
  messages: number;
  skipped: number;
  warnings: number;
}

export interface ImportWarning {
  id?: number;
  severity: "info" | "warning" | "error";
  code: string;
  entityType?: string | null;
  sourceTable?: string | null;
  sourceRowId?: string | null;
  message: string;
  context?: Record<string, unknown> | null;
}

export interface ContactRecord {
  sourceJid: string;
  displayName?: string | null;
  phoneNumber?: string | null;
  pushName?: string | null;
  rawMetadata?: Record<string, unknown> | null;
}

export interface ChatRecord {
  sourceChatId: string;
  jid: string;
  displayName?: string | null;
  chatType: ChatType;
  rawMetadata?: Record<string, unknown> | null;
}

export interface ParticipantRecord {
  chatSourceId: string;
  sourceJid: string;
  displayName?: string | null;
  firstSeenAtMs?: number | null;
  lastSeenAtMs?: number | null;
  membershipSource: "source" | "inferred";
  rawMetadata?: Record<string, unknown> | null;
}

export interface MessageRecord {
  sourceMessageId: string;
  sourceMessageKey: string;
  sourceTable: string;
  sourceRowId: string;
  chatSourceId: string;
  senderSourceJid?: string | null;
  timestampMs?: number | null;
  sentAtIso?: string | null;
  fromMe: boolean | null;
  direction: "incoming" | "outgoing" | "system" | "unknown";
  messageType: string;
  rawTypeCode?: string | number | null;
  body?: string | null;
  caption?: string | null;
  hasMedia: boolean;
  mediaMimeType?: string | null;
  mediaName?: string | null;
  quotedSourceMessageId?: string | null;
  isDeleted: boolean;
  isForwarded: boolean;
  isStarred: boolean;
  rawMetadata?: Record<string, unknown> | null;
}

export interface ChatListItem {
  id: number;
  sourceChatId: string;
  jid: string;
  displayName: string;
  chatType: ChatType;
  messageCount: number;
  participantCount: number;
  lastMessageAt: string | null;
}

export interface ChatListOptions {
  search?: string;
  limit: number;
  offset: number;
  type?: string;
  includeEventOnly?: boolean;
}

export interface MessageListItem {
  id: number;
  sourceMessageId: string;
  senderDisplayName: string | null;
  senderSourceJid: string | null;
  timestampMs: number | null;
  sentAt: string | null;
  direction: "incoming" | "outgoing" | "system" | "unknown";
  messageType: string;
  body: string | null;
  caption: string | null;
  hasMedia: boolean;
  mediaMimeType: string | null;
  mediaName: string | null;
  isDeleted: boolean;
  isForwarded: boolean;
  isStarred: boolean;
}

export type MessageListOrder = "asc" | "desc";

export interface ImportRequest {
  msgstorePath: string;
  waPath?: string | null;
  mediaPath?: string | null;
  key?: string | null;
  keyPath?: string | null;
  keepDecrypted?: boolean;
}
