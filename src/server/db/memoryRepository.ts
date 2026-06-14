import type {
  ArchiveRepository
} from "./repository";
import type {
  ChatListItem,
  ChatRecord,
  ContactRecord,
  ImportRunSummary,
  ImportTotals,
  ImportWarning,
  MessageListItem,
  MessageRecord,
  ParticipantRecord,
  StatusSummary
} from "../../shared/types";

export class MemoryArchiveRepository implements ArchiveRepository {
  private importRuns = new Map<string, ImportRunSummary>();
  private warnings: ImportWarning[] = [];
  private contacts = new Map<string, ContactRecord & { id: number }>();
  private chats = new Map<string, ChatRecord & { id: number; messageCount: number; participantCount: number; lastMessageAt: string | null }>();
  private participants = new Map<string, ParticipantRecord>();
  private messages = new Map<string, MessageRecord & { id: number }>();
  private nextContactId = 1;
  private nextChatId = 1;
  private nextMessageId = 1;

  async startImportRun(): Promise<string> {
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
      latestWarnings: this.warnings.slice(-8).reverse()
    };
  }

  async listChats(options: { search?: string; limit: number; offset: number; type?: string }): Promise<ChatListItem[]> {
    const search = options.search?.toLowerCase();
    return [...this.chats.values()]
      .filter((chat) => !search || chat.displayName?.toLowerCase().includes(search) || chat.jid.toLowerCase().includes(search))
      .filter((chat) => !options.type || options.type === "all" || chat.chatType === options.type)
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
}

function emptyTotals(): ImportTotals {
  return { contacts: 0, chats: 0, participants: 0, messages: 0, skipped: 0, warnings: 0 };
}
