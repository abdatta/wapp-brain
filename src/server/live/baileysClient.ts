import http from "node:http";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";
import type { MediaDownloadQueueRecord } from "../../shared/types";
import { config } from "../config";
import { configuredTraceRecorder } from "../diagnostics/traceRecorder";
import { downloadQueuedMedia } from "../media/downloader";
import { isStatusChatJid } from "../import/jid";
import { assertLiveDependencySafe } from "./dependency";
import {
  normalizeBaileysChatsWithJidResolver,
  normalizeBaileysContactsWithJidResolver,
  normalizeBaileysGroupParticipantsWithJidResolver,
  normalizeBaileysGroupUpdatesWithJidResolver,
  normalizeBaileysMessageDeletesWithJidResolver,
  normalizeBaileysMessagesWithJidResolver,
  normalizeBaileysMessageUpdatesWithJidResolver,
  normalizeBaileysReactionsWithJidResolver,
  normalizeBaileysReceiptsWithJidResolver,
  type LiveJidResolver
} from "./normalize";
import type {
  LiveConnectionUpdate,
  LiveGroupMetadataResult,
  LiveHistoryRequest,
  LiveHistoryResult,
  LiveMessageEvent,
  LiveProofResult,
  LiveWhatsAppClient,
  MediaDownloadOutcome
} from "./types";

type Handler<T> = (value: T) => void | Promise<void>;

/**
 * WhatsApp Status is not a chat: drop its items out of a platform batch at the
 * event boundary, before media descriptors are captured, and let the rest of the
 * batch through untouched. Keyed on chat identity, never on message type — live
 * status posts arrive as ordinary `image`/`video`/`text` content.
 */
function withoutStatusItems<T extends { key?: { remoteJid?: string | null } | null }>(items: readonly T[]): T[] {
  return items.filter((item) => !isStatusChatJid(item?.key?.remoteJid ?? null));
}

interface BaileysClientOptions {
  authDir: string;
  phoneNumber?: string | null;
  connectTimeoutMs?: number;
  readOnly?: boolean;
}

export class BaileysLiveWhatsAppClient implements LiveWhatsAppClient {
  readonly name = "baileys" as const;
  private socket: any = null;
  private readonly connectionHandlers: Handler<LiveConnectionUpdate>[] = [];
  private readonly eventHandlers: Handler<LiveMessageEvent>[] = [];
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private stopped = false;
  private sawPairingQr = false;

  constructor(private readonly options: BaileysClientOptions) {}

  onConnectionUpdate(handler: Handler<LiveConnectionUpdate>): void {
    this.connectionHandlers.push(handler);
  }

  onEvent(handler: Handler<LiveMessageEvent>): void {
    this.eventHandlers.push(handler);
  }

  async connect(): Promise<void> {
    assertLiveDependencySafe();
    this.stopped = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await mkdir(this.options.authDir, { recursive: true });
    await restoreCredsBackupIfCorrupt(this.options.authDir);
    const baileys = await import("@whiskeysockets/baileys");
    const pino = (await import("pino")).default;
    const { state, saveCreds } = await baileys.useMultiFileAuthState(this.options.authDir);
    const socket = baileys.default({
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      syncFullHistory: true,
      markOnlineOnConnect: false,
      // Identify this linked device as WappBrain in WhatsApp's Linked Devices
      // list. WhatsApp derives the bold primary label from a fixed platform
      // enum (browser[1] -> DESKTOP -> a generic desktop label + computer
      // icon), so it does not print an arbitrary app name; the only free-text
      // field is browser[0] (the companion `os`), shown in parentheses. So this
      // renders as "<desktop> (WappBrain)" — the parenthetical is what honestly
      // attributes the session to this app.
      browser: ["WappBrain", "Desktop", "0.1.0"]
    });
    if (this.options.readOnly !== false) {
      installReadOnlySocketGuards(socket);
    }
    const resolveLiveJid = createLiveJidResolver(socket);
    this.socket = socket;
    // A malformed or unexpected platform payload must never take down the
    // process: normalization errors are traced and the event dropped.
    const on = (name: string, handler: (payload: any) => void | Promise<void>): void => {
      socket.ev.on(name as never, async (payload: any) => {
        try {
          await handler(payload);
        } catch (error) {
          await configuredTraceRecorder?.record("baileys.event_handler_failed", { name, message: safeError(error) });
        }
      });
    };
    on("creds.update", saveCreds);
    on("connection.update", async (update: any) => {
      await configuredTraceRecorder?.record("baileys.raw_event", { name: "connection.update", event: update });
      if (update.qr) {
        this.sawPairingQr = true;
        await this.emitConnection({ state: "pairing", qrDataUrl: await QRCode.toDataURL(update.qr) });
      }
      if (update.connection === "open") {
        this.reconnectAttempts = 0;
        this.sawPairingQr = false;
        await this.emitConnection({ state: "connected", linkedDeviceJid: socket.user?.id ?? null });
        // Baileys writes creds.json non-atomically; a kill mid-write truncates
        // it and forces a full re-pair. Keep a known-good copy from the moment
        // the session provably works.
        await backupCredsIfValid(this.options.authDir);
      }
      if (update.connection === "close") {
        const statusCode = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (statusCode === baileys.DisconnectReason.loggedOut) {
          this.stopped = true;
          await this.emitConnection({
            state: "logged_out",
            lastError: "WhatsApp unlinked this device. Re-pair from Linked devices to resume live sync."
          });
          return;
        }
        if (statusCode === baileys.DisconnectReason.restartRequired) {
          // Expected protocol step: WhatsApp forces a stream restart right
          // after a QR scan completes (and occasionally mid-session). This is
          // not an error — reconnect immediately with the saved credentials.
          await configuredTraceRecorder?.record("baileys.restart_required", { duringPairing: this.sawPairingQr });
          await this.emitConnection(
            this.sawPairingQr
              ? { state: "pairing", lastError: null }
              : { state: "disconnected", lastError: "Reconnecting to WhatsApp…" }
          );
          this.scheduleReconnect(500);
          return;
        }
        await this.emitConnection({ state: "disconnected", lastError: safeError(update.lastDisconnect?.error) });
        this.scheduleReconnect();
      }
    });
    on("messages.upsert", async (event: { type?: string; messages?: unknown[] }) => {
      await configuredTraceRecorder?.record("baileys.raw_event", { name: "messages.upsert", event });
      const normalized = await normalizeBaileysMessagesWithJidResolver(
        withoutStatusItems((event.messages ?? []) as any[]),
        "wa-web:messages.upsert",
        resolveLiveJid
      );
      normalized.mode = event.type === "append" ? "append" : "notify";
      await configuredTraceRecorder?.record("baileys.normalized_event", { name: "messages.upsert", event: normalized });
      await this.emitEvent(normalized);
    });
    on("messaging-history.set", async (event: {
      messages?: unknown[];
      lidPnMappings?: Array<{ lid: string; pn: string }>;
      progress?: number | null;
      syncType?: number | string | null;
    }) => {
      await configuredTraceRecorder?.record("baileys.raw_event", { name: "messaging-history.set", event });
      await storeLidPnMappings(socket, event.lidPnMappings);
      const normalized = await normalizeBaileysMessagesWithJidResolver(
        withoutStatusItems((event.messages ?? []) as any[]),
        "wa-web:history-sync",
        resolveLiveJid
      );
      const contacts = await normalizeBaileysContactsWithJidResolver(((event as { contacts?: unknown[] }).contacts ?? []) as any[], "contacts.upsert", resolveLiveJid);
      const chats = await normalizeBaileysChatsWithJidResolver(((event as { chats?: unknown[] }).chats ?? []) as any[], "chats.upsert", resolveLiveJid);
      normalized.contacts = mergeBySourceJid(normalized.contacts ?? [], contacts.contacts ?? []);
      normalized.chats = mergeBySourceChatId(normalized.chats ?? [], chats.chats ?? []);
      normalized.identityLinks = [
        ...(event.lidPnMappings ?? []).map((mapping) => ({ lid: mapping.lid, pn: mapping.pn })),
        ...(contacts.identityLinks ?? [])
      ];
      // WhatsApp reports overall history-sync progress; surface it for the UI.
      normalized.rawMetadata = { ...(normalized.rawMetadata ?? {}), progress: event.progress ?? null, syncType: event.syncType ?? null };
      await configuredTraceRecorder?.record("baileys.normalized_event", { name: "messaging-history.set", event: normalized });
      await this.emitEvent(normalized);
    });
    on("contacts.upsert", async (contacts: unknown[]) => {
      await configuredTraceRecorder?.record("baileys.raw_event", { name: "contacts.upsert", event: contacts });
      const normalized = await normalizeBaileysContactsWithJidResolver(contacts as any[], "contacts.upsert", resolveLiveJid);
      await configuredTraceRecorder?.record("baileys.normalized_event", { name: "contacts.upsert", event: normalized });
      await this.emitEvent(normalized);
    });
    on("contacts.update", async (contacts: unknown[]) => {
      await configuredTraceRecorder?.record("baileys.raw_event", { name: "contacts.update", event: contacts });
      const normalized = await normalizeBaileysContactsWithJidResolver(contacts as any[], "contacts.update", resolveLiveJid);
      await configuredTraceRecorder?.record("baileys.normalized_event", { name: "contacts.update", event: normalized });
      await this.emitEvent(normalized);
    });
    on("chats.upsert", async (chats: unknown[]) => {
      await configuredTraceRecorder?.record("baileys.raw_event", { name: "chats.upsert", event: chats });
      const normalized = await normalizeBaileysChatsWithJidResolver(chats as any[], "chats.upsert", resolveLiveJid);
      await configuredTraceRecorder?.record("baileys.normalized_event", { name: "chats.upsert", event: normalized });
      await this.emitEvent(normalized);
    });
    on("chats.update", async (chats: unknown[]) => {
      await configuredTraceRecorder?.record("baileys.raw_event", { name: "chats.update", event: chats });
      const normalized = await normalizeBaileysChatsWithJidResolver(chats as any[], "chats.update", resolveLiveJid);
      await configuredTraceRecorder?.record("baileys.normalized_event", { name: "chats.update", event: normalized });
      await this.emitEvent(normalized);
    });
    on("lid-mapping.update", async (mapping: { lid: string; pn: string }) => {
      await configuredTraceRecorder?.record("baileys.raw_event", { name: "lid-mapping.update", event: mapping });
      await storeLidPnMappings(socket, [mapping]);
      if (mapping?.lid && mapping?.pn) {
        await this.emitEvent({
          eventKey: `lid-mapping.update:${mapping.lid}`,
          eventType: "lid-mapping.update",
          mode: "update",
          identityLinks: [{ lid: mapping.lid, pn: mapping.pn }]
        });
      }
    });
    on("messages.update", async (items: unknown[]) => {
      await configuredTraceRecorder?.record("baileys.raw_event", { name: "messages.update", event: items });
      const normalized = await normalizeBaileysMessageUpdatesWithJidResolver((items ?? []) as any[], resolveLiveJid);
      if (normalized.updates?.length) {
        await configuredTraceRecorder?.record("baileys.normalized_event", { name: "messages.update", event: normalized });
        await this.emitEvent(normalized);
      }
    });
    on("messages.delete", async (item: unknown) => {
      await configuredTraceRecorder?.record("baileys.raw_event", { name: "messages.delete", event: item });
      const normalized = await normalizeBaileysMessageDeletesWithJidResolver((item ?? {}) as any, resolveLiveJid);
      if (normalized.updates?.length) {
        await configuredTraceRecorder?.record("baileys.normalized_event", { name: "messages.delete", event: normalized });
        await this.emitEvent(normalized);
      }
    });
    on("messages.reaction", async (reactions: unknown[]) => {
      await configuredTraceRecorder?.record("baileys.raw_event", { name: "messages.reaction", event: reactions });
      const normalized = await normalizeBaileysReactionsWithJidResolver((reactions ?? []) as any[], resolveLiveJid);
      if (normalized.updates?.length) {
        await configuredTraceRecorder?.record("baileys.normalized_event", { name: "messages.reaction", event: normalized });
        await this.emitEvent(normalized);
      }
    });
    on("message-receipt.update", async (receipts: unknown[]) => {
      await configuredTraceRecorder?.record("baileys.raw_event", { name: "message-receipt.update", event: receipts });
      const normalized = await normalizeBaileysReceiptsWithJidResolver((receipts ?? []) as any[], resolveLiveJid);
      if (normalized.updates?.length) {
        await configuredTraceRecorder?.record("baileys.normalized_event", { name: "message-receipt.update", event: normalized });
        await this.emitEvent(normalized);
      }
    });
    on("groups.update", async (groups: unknown[]) => {
      await configuredTraceRecorder?.record("baileys.raw_event", { name: "groups.update", event: groups });
      const normalized = await normalizeBaileysGroupUpdatesWithJidResolver((groups ?? []) as any[], resolveLiveJid);
      if (normalized.chats?.length) {
        await configuredTraceRecorder?.record("baileys.normalized_event", { name: "groups.update", event: normalized });
        await this.emitEvent(normalized);
      }
    });
    on("group-participants.update", async (event: unknown) => {
      await configuredTraceRecorder?.record("baileys.raw_event", { name: "group-participants.update", event });
      const normalized = await normalizeBaileysGroupParticipantsWithJidResolver((event ?? {}) as any, resolveLiveJid, Date.now());
      if (normalized.participants?.length) {
        await configuredTraceRecorder?.record("baileys.normalized_event", { name: "group-participants.update", event: normalized });
        await this.emitEvent(normalized);
      }
    });

    if (this.options.phoneNumber && !socket.authState?.creds?.registered) {
      const code = await socket.requestPairingCode(this.options.phoneNumber);
      await this.emitConnection({ state: "pairing", pairingCode: code });
    }
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.end?.(undefined);
    this.socket = null;
    await this.emitConnection({ state: "stopped" });
  }

  private scheduleReconnect(delayOverrideMs?: number): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    this.reconnectAttempts += 1;
    const delayMs = delayOverrideMs ?? Math.min(60_000, 1000 * 2 ** Math.min(this.reconnectAttempts, 6));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error: unknown) => {
        void this.emitConnection({ state: "error", lastError: safeError(error) });
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  async fetchHistory(request: LiveHistoryRequest): Promise<LiveHistoryResult> {
    if (!this.socket?.fetchMessageHistory || !request.anchor || !request.oldestMsgTimestampMs) {
      return { status: "unsupported", events: [], messageCount: 0, errorMessage: "Baileys on-demand history requires a live socket and anchor message." };
    }
    try {
      // Baileys forwards this verbatim into the wire field oldestMsgTimestampMs
      // — it expects MILLISECONDS; dividing by 1000 sends a 1970-era anchor and
      // the phone returns nothing.
      // Bounded await: this asks the PHONE for history and the phone may never
      // answer; an unbounded hang here wedges the whole recovery tick (and with
      // it audits, secrets, and media passes) until the server restarts.
      await Promise.race([
        this.socket.fetchMessageHistory(
          request.count,
          {
            remoteJid: request.chatSourceId,
            id: request.anchor.id,
            fromMe: request.anchor.fromMe ?? undefined,
            participant: request.anchor.participant ?? undefined
          },
          Math.floor(request.oldestMsgTimestampMs)
        ),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("On-demand history request timed out after 30s.")), 30_000).unref?.();
        })
      ]);
      return { status: "partial", events: [], messageCount: 0 };
    } catch (error) {
      return { status: "failed", events: [], messageCount: 0, errorMessage: safeError(error) };
    }
  }

  // Read-only profile-photo URL lookup (People compare view). Low-timeout and
  // null on any failure — avatars are progressive enhancement, never a gate.
  async fetchProfilePictureUrl(jid: string): Promise<string | null> {
    if (!this.socket?.profilePictureUrl) {
      return null;
    }
    try {
      const url = await Promise.race([
        this.socket.profilePictureUrl(jid, "image") as Promise<unknown>,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 4_000))
      ]);
      return typeof url === "string" && url ? url : null;
    } catch {
      return null;
    }
  }

  async fetchGroupMetadata(jid: string): Promise<LiveGroupMetadataResult | null> {
    if (!this.socket?.groupMetadata) {
      return null;
    }
    // groupMetadata is a read query; the read-only socket guards do not block it.
    const metadata = (await this.socket.groupMetadata(jid)) as {
      subject?: string | null;
      participants?: Array<{ id?: string | null; phoneNumber?: string | null; lid?: string | null; admin?: string | null }>;
    };
    const participants: LiveGroupMetadataResult["participants"] = [];
    const identityLinks: LiveGroupMetadataResult["identityLinks"] = [];
    for (const participant of metadata.participants ?? []) {
      const preferred = participant.phoneNumber || participant.id || participant.lid;
      if (typeof preferred === "string" && preferred) {
        participants.push({ jid: preferred, role: participant.admin ?? null });
      }
      const lid = isLidJid(participant.lid) ? participant.lid : isLidJid(participant.id) ? participant.id : null;
      const pn = typeof participant.phoneNumber === "string" && participant.phoneNumber.includes("@") ? participant.phoneNumber : null;
      if (lid && pn) {
        identityLinks.push({ lid, pn });
      }
    }
    return { subject: metadata.subject ?? null, participants, identityLinks };
  }

  // Passive fetch + decrypt of a queued media item. The only outbound this can
  // produce is the scoped media re-upload request (updateMediaMessage) when the
  // CDN link expired and the caller allows it — never a receipt or presence.
  async downloadMedia(task: MediaDownloadQueueRecord, options: { allowReupload: boolean }): Promise<MediaDownloadOutcome> {
    const socket = this.socket;
    if (!socket) {
      return { status: "transient", usedReupload: false, error: "Live socket is not connected." };
    }
    const requestReupload =
      typeof socket.updateMediaMessage === "function"
        ? (message: Record<string, unknown>) => socket.updateMediaMessage(message)
        : null;
    return downloadQueuedMedia(task, options, { requestReupload });
  }

  private async emitConnection(update: LiveConnectionUpdate): Promise<void> {
    for (const handler of this.connectionHandlers) {
      await handler(update);
    }
  }

  private async emitEvent(event: LiveMessageEvent): Promise<void> {
    for (const handler of this.eventHandlers) {
      await handler(event);
    }
  }
}

export async function runBaileysProof(options: {
  authDir?: string;
  phoneNumber?: string | null;
  timeoutMs?: number;
  outputPath?: string;
  pairingPagePort?: number;
} = {}): Promise<LiveProofResult> {
  const startedAt = new Date().toISOString();
  const notes: string[] = [];
  let connected = false;
  let receivedMessagesUpsert = false;
  let receivedHistorySync = false;
  const progress: ProofProgress = {
    state: "starting",
    pairingCode: null,
    qrDataUrl: null,
    connected: false,
    receivedMessagesUpsert: false,
    receivedHistorySync: false,
    completed: false,
    notes
  };
  const pairingPage = await startPairingPage(progress, options.pairingPagePort ?? 3611);
  notes.push(`Pairing page: ${pairingPage.url}`);
  const client = new BaileysLiveWhatsAppClient({
    authDir: options.authDir ?? config.live.authDir,
    phoneNumber: options.phoneNumber ?? null,
    readOnly: true
  });
  client.onConnectionUpdate((update) => {
    progress.state = update.state;
    if (update.pairingCode) progress.pairingCode = update.pairingCode;
    if (update.qrDataUrl) progress.qrDataUrl = update.qrDataUrl;
    if (update.state === "connected") connected = true;
    progress.connected = connected;
    if (update.pairingCode) notes.push("Pairing code generated locally.");
    if (update.qrDataUrl) notes.push("QR code generated locally.");
    if (update.lastError) notes.push(update.lastError);
  });
  client.onEvent((event) => {
    if (event.eventType === "messages.upsert") receivedMessagesUpsert = true;
    if (event.eventType === "messaging-history.set") receivedHistorySync = true;
    progress.receivedMessagesUpsert = receivedMessagesUpsert;
    progress.receivedHistorySync = receivedHistorySync;
  });
  const timeoutMs = options.timeoutMs ?? 60_000;
  try {
    await client.connect();
    await waitForProofCompletion(progress, timeoutMs);
  } finally {
    progress.completed = true;
    await client.disconnect();
    await pairingPage.close();
  }
  const result: LiveProofResult = {
    client: "baileys",
    startedAt,
    finishedAt: new Date().toISOString(),
    connected,
    receivedMessagesUpsert,
    receivedHistorySync,
    onDemandHistorySupported: null,
    notes
  };
  const outputPath = options.outputPath ?? config.live.spikePath;
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

interface ProofProgress {
  state: string;
  pairingCode: string | null;
  qrDataUrl: string | null;
  connected: boolean;
  receivedMessagesUpsert: boolean;
  receivedHistorySync: boolean;
  completed: boolean;
  notes: string[];
}

async function startPairingPage(progress: ProofProgress, port: number): Promise<{ url: string; close: () => Promise<void> }> {
  const clients = new Set<http.ServerResponse>();
  const server = http.createServer((request, response) => {
    if (request.url === "/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      clients.add(response);
      response.write(`data: ${JSON.stringify(publicProgress(progress))}\n\n`);
      request.on("close", () => clients.delete(response));
      return;
    }
    if (request.url === "/status") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(publicProgress(progress)));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(pairingPageHtml());
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const interval = setInterval(() => {
    const payload = `data: ${JSON.stringify(publicProgress(progress))}\n\n`;
    for (const client of clients) {
      client.write(payload);
    }
  }, 1000);
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(interval);
        for (const client of clients) {
          client.end();
        }
        server.close(() => resolve());
      })
  };
}

async function waitForProofCompletion(progress: ProofProgress, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (progress.connected && (progress.receivedMessagesUpsert || progress.receivedHistorySync)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function publicProgress(progress: ProofProgress): ProofProgress {
  return {
    ...progress,
    notes: [...new Set(progress.notes)]
  };
}

function pairingPageHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Wapp Brain Live Pairing</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #101418; color: #eef4f1; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    main { width: min(680px, 100%); border: 1px solid #2b3533; border-radius: 8px; padding: 24px; background: #171c21; }
    h1 { margin: 0 0 10px; font-size: 24px; }
    p { color: #aeb9b4; line-height: 1.5; }
    code, .code { font: 700 28px ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: 2px; }
    .qr { width: min(320px, 100%); background: white; padding: 12px; border-radius: 8px; display: none; }
    .status { margin-top: 16px; padding: 12px; border-radius: 8px; background: #202830; }
    .done { color: #76dfa9; }
  </style>
</head>
<body>
  <main>
    <h1>Wapp Brain Live Pairing</h1>
    <p>Open WhatsApp on your phone, go to Linked devices, and use the pairing code or QR shown here. This proof run is read-only at the app layer and does not call send/read-receipt/delete/update APIs.</p>
    <p id="codeWrap">Waiting for pairing code...</p>
    <img id="qr" class="qr" alt="WhatsApp pairing QR" />
    <div class="status" id="status">Starting...</div>
  </main>
  <script>
    const codeWrap = document.getElementById('codeWrap');
    const qr = document.getElementById('qr');
    const status = document.getElementById('status');
    const events = new EventSource('/events');
    events.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.pairingCode) codeWrap.innerHTML = 'Pairing code: <span class="code">' + data.pairingCode + '</span>';
      if (data.qrDataUrl) { qr.src = data.qrDataUrl; qr.style.display = 'block'; }
      const complete = data.connected && (data.receivedMessagesUpsert || data.receivedHistorySync);
      status.className = complete ? 'status done' : 'status';
      status.textContent = complete
        ? 'Linked and live event detected. You can return to Codex.'
        : 'State: ' + data.state + ' | connected=' + data.connected + ' | messages=' + data.receivedMessagesUpsert + ' | history=' + data.receivedHistorySync;
    };
  </script>
</body>
</html>`;
}

// Every receipt-, presence-, send-, delete-, group-, and profile-related
// socket method stays blocked: the linked device is a silent observer, and —
// critically — never sending a read/played receipt is what keeps archived
// view-once media unopened on the phone.
export const READ_ONLY_BLOCKED_METHODS = [
  "sendMessage",
  "relayMessage",
  "readMessages",
  "sendReceipt",
  "sendReceipts",
  "sendPresenceUpdate",
  "presenceSubscribe",
  "chatModify",
  "groupUpdateSubject",
  "groupUpdateDescription",
  "groupParticipantsUpdate",
  "groupLeave",
  "updateProfileName",
  "updateProfileStatus",
  "updateProfilePicture",
  "removeProfilePicture",
  "rejectCall"
] as const;

// The single, deliberate exception to the read-only posture (user-approved):
// `updateMediaMessage` sends a media re-upload request so expired media can be
// recovered. It transmits no message content and is NOT a read/played receipt
// — it must never appear in the blocklist above, and nothing else is allowed.
export const MEDIA_RETRY_ALLOWED_METHODS = ["updateMediaMessage"] as const;

export function installReadOnlySocketGuards(socket: Record<string, unknown>): void {
  for (const method of READ_ONLY_BLOCKED_METHODS) {
    if ((MEDIA_RETRY_ALLOWED_METHODS as readonly string[]).includes(method)) {
      throw new Error(`Read-only guard misconfiguration: ${method} cannot be both blocked and allowed.`);
    }
    if (typeof socket[method] === "function") {
      socket[method] = () => {
        throw new Error(`Read-only live maintainer blocked WhatsApp write method: ${method}`);
      };
    }
  }
}

function mergeBySourceJid<T extends { sourceJid: string }>(left: T[], right: T[]): T[] {
  return [...new Map([...left, ...right].map((item) => [item.sourceJid, item])).values()];
}

function mergeBySourceChatId<T extends { sourceChatId: string }>(left: T[], right: T[]): T[] {
  return [...new Map([...left, ...right].map((item) => [item.sourceChatId, item])).values()];
}

function createLiveJidResolver(socket: any): LiveJidResolver {
  const resolved = new Map<string, string>();
  return async (jid: string) => {
    if (typeof jid !== "string") {
      await configuredTraceRecorder?.record("baileys.jid_resolved", { input: String(jid), output: null, source: "non-string" });
      return null;
    }
    if (!isLidJid(jid)) {
      await configuredTraceRecorder?.record("baileys.jid_resolved", { input: jid, output: jid, source: "non-lid" });
      return jid;
    }
    const cached = resolved.get(jid);
    if (cached) {
      await configuredTraceRecorder?.record("baileys.jid_resolved", { input: jid, output: cached, source: "cache" });
      return cached;
    }
    const store = socket.signalRepository?.lidMapping;
    if (typeof store?.getPNForLID !== "function") {
      await configuredTraceRecorder?.record("baileys.jid_resolved", { input: jid, output: jid, source: "missing-store" });
      return jid;
    }
    const phoneJid = await store.getPNForLID(jid);
    if (phoneJid) {
      resolved.set(jid, phoneJid);
      await configuredTraceRecorder?.record("baileys.jid_resolved", { input: jid, output: phoneJid, source: "signal-repository" });
      return phoneJid;
    }
    await configuredTraceRecorder?.record("baileys.jid_resolved", { input: jid, output: jid, source: "unmapped" });
    return jid;
  };
}

async function storeLidPnMappings(socket: any, mappings: Array<{ lid: string; pn: string }> | null | undefined): Promise<void> {
  if (!mappings?.length) {
    return;
  }
  const store = socket.signalRepository?.lidMapping;
  if (typeof store?.storeLIDPNMappings === "function") {
    await store.storeLIDPNMappings(mappings);
    await configuredTraceRecorder?.record("baileys.lid_mappings_stored", { mappings });
  } else {
    await configuredTraceRecorder?.record("baileys.lid_mappings_store_missing", { mappings });
  }
}

function isLidJid(jid: unknown): jid is string {
  return typeof jid === "string" && (jid.endsWith("@lid") || jid.endsWith("@hosted.lid"));
}

// Returns true when creds.json parses and belongs to a paired session. Attempts
// a restore from the known-good backup first, so a truncated creds.json (killed
// mid-write) does not force a re-pair when the backup is intact.
export async function ensureUsableLiveCreds(authDir: string): Promise<boolean> {
  await restoreCredsBackupIfCorrupt(authDir);
  return Boolean(await readParsedCreds(path.join(authDir, "creds.json")));
}

async function restoreCredsBackupIfCorrupt(authDir: string): Promise<void> {
  const credsPath = path.join(authDir, "creds.json");
  const backupPath = path.join(authDir, "creds.json.bak");
  if (await readParsedCreds(credsPath)) {
    return;
  }
  const backup = await readParsedCreds(backupPath);
  if (backup) {
    await copyFile(backupPath, credsPath);
    await configuredTraceRecorder?.record("baileys.creds_restored_from_backup", { authDir: path.basename(authDir) });
  }
}

async function backupCredsIfValid(authDir: string): Promise<void> {
  const credsPath = path.join(authDir, "creds.json");
  if (await readParsedCreds(credsPath)) {
    await copyFile(credsPath, path.join(authDir, "creds.json.bak")).catch(() => undefined);
  }
}

async function readParsedCreds(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    return parsed && typeof parsed === "object" && parsed.me ? parsed : null;
  } catch {
    return null;
  }
}

function safeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 500);
  }
  return "Unknown live client error.";
}

