import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";
import { config } from "../config";
import { configuredTraceRecorder } from "../diagnostics/traceRecorder";
import { assertLiveDependencySafe } from "./dependency";
import {
  normalizeBaileysChatsWithJidResolver,
  normalizeBaileysContactsWithJidResolver,
  normalizeBaileysMessagesWithJidResolver,
  type LiveJidResolver
} from "./normalize";
import type { LiveConnectionUpdate, LiveHistoryRequest, LiveHistoryResult, LiveMessageEvent, LiveProofResult, LiveWhatsAppClient } from "./types";

type Handler<T> = (value: T) => void | Promise<void>;

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
    const baileys = await import("@whiskeysockets/baileys");
    const pino = (await import("pino")).default;
    const { state, saveCreds } = await baileys.useMultiFileAuthState(this.options.authDir);
    const socket = baileys.default({
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      syncFullHistory: true,
      markOnlineOnConnect: false
    });
    if (this.options.readOnly !== false) {
      installReadOnlySocketGuards(socket);
    }
    const resolveLiveJid = createLiveJidResolver(socket);
    this.socket = socket;
    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("connection.update", async (update: any) => {
      await configuredTraceRecorder?.record("baileys.raw_event", { name: "connection.update", event: update });
      if (update.qr) {
        await this.emitConnection({ state: "pairing", qrDataUrl: await QRCode.toDataURL(update.qr) });
      }
      if (update.connection === "open") {
        this.reconnectAttempts = 0;
        await this.emitConnection({ state: "connected", linkedDeviceJid: socket.user?.id ?? null });
      }
      if (update.connection === "close") {
        await this.emitConnection({ state: "disconnected", lastError: safeError(update.lastDisconnect?.error) });
        this.scheduleReconnect();
      }
    });
    socket.ev.on("messages.upsert", async (event: { type?: string; messages?: unknown[] }) => {
      await configuredTraceRecorder?.record("baileys.raw_event", { name: "messages.upsert", event });
      const normalized = await normalizeBaileysMessagesWithJidResolver((event.messages ?? []) as any[], "wa-web:messages.upsert", resolveLiveJid);
      normalized.mode = event.type === "append" ? "append" : "notify";
      await configuredTraceRecorder?.record("baileys.normalized_event", { name: "messages.upsert", event: normalized });
      await this.emitEvent(normalized);
    });
    socket.ev.on("messaging-history.set", async (event: { messages?: unknown[]; lidPnMappings?: Array<{ lid: string; pn: string }> }) => {
      await configuredTraceRecorder?.record("baileys.raw_event", { name: "messaging-history.set", event });
      await storeLidPnMappings(socket, event.lidPnMappings);
      const normalized = await normalizeBaileysMessagesWithJidResolver((event.messages ?? []) as any[], "wa-web:history-sync", resolveLiveJid);
      const contacts = await normalizeBaileysContactsWithJidResolver(((event as { contacts?: unknown[] }).contacts ?? []) as any[], "contacts.upsert", resolveLiveJid);
      const chats = await normalizeBaileysChatsWithJidResolver(((event as { chats?: unknown[] }).chats ?? []) as any[], "chats.upsert", resolveLiveJid);
      normalized.contacts = mergeBySourceJid(normalized.contacts ?? [], contacts.contacts ?? []);
      normalized.chats = mergeBySourceChatId(normalized.chats ?? [], chats.chats ?? []);
      await configuredTraceRecorder?.record("baileys.normalized_event", { name: "messaging-history.set", event: normalized });
      await this.emitEvent(normalized);
    });
    socket.ev.on("contacts.upsert", async (contacts: unknown[]) => {
      await configuredTraceRecorder?.record("baileys.raw_event", { name: "contacts.upsert", event: contacts });
      const normalized = await normalizeBaileysContactsWithJidResolver(contacts as any[], "contacts.upsert", resolveLiveJid);
      await configuredTraceRecorder?.record("baileys.normalized_event", { name: "contacts.upsert", event: normalized });
      await this.emitEvent(normalized);
    });
    socket.ev.on("contacts.update", async (contacts: unknown[]) => {
      await configuredTraceRecorder?.record("baileys.raw_event", { name: "contacts.update", event: contacts });
      const normalized = await normalizeBaileysContactsWithJidResolver(contacts as any[], "contacts.update", resolveLiveJid);
      await configuredTraceRecorder?.record("baileys.normalized_event", { name: "contacts.update", event: normalized });
      await this.emitEvent(normalized);
    });
    socket.ev.on("chats.upsert", async (chats: unknown[]) => {
      await configuredTraceRecorder?.record("baileys.raw_event", { name: "chats.upsert", event: chats });
      const normalized = await normalizeBaileysChatsWithJidResolver(chats as any[], "chats.upsert", resolveLiveJid);
      await configuredTraceRecorder?.record("baileys.normalized_event", { name: "chats.upsert", event: normalized });
      await this.emitEvent(normalized);
    });
    socket.ev.on("chats.update", async (chats: unknown[]) => {
      await configuredTraceRecorder?.record("baileys.raw_event", { name: "chats.update", event: chats });
      const normalized = await normalizeBaileysChatsWithJidResolver(chats as any[], "chats.update", resolveLiveJid);
      await configuredTraceRecorder?.record("baileys.normalized_event", { name: "chats.update", event: normalized });
      await this.emitEvent(normalized);
    });
    socket.ev.on("lid-mapping.update", async (mapping: { lid: string; pn: string }) => {
      await configuredTraceRecorder?.record("baileys.raw_event", { name: "lid-mapping.update", event: mapping });
      await storeLidPnMappings(socket, [mapping]);
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

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    this.reconnectAttempts += 1;
    const delayMs = Math.min(60_000, 1000 * 2 ** Math.min(this.reconnectAttempts, 6));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error: unknown) => {
        void this.emitConnection({ state: "error", lastError: safeError(error) });
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  async fetchHistory(request: LiveHistoryRequest): Promise<LiveHistoryResult> {
    if (!this.socket?.fetchMessageHistory || !request.anchorMessageKey || !request.oldestMsgTimestampMs) {
      return { status: "unsupported", events: [], messageCount: 0, errorMessage: "Baileys on-demand history requires a live socket and anchor message." };
    }
    try {
      await this.socket.fetchMessageHistory(request.count, decodeLiveMessageKey(request.anchorMessageKey), Math.floor(request.oldestMsgTimestampMs / 1000));
      return { status: "partial", events: [], messageCount: 0 };
    } catch (error) {
      return { status: "failed", events: [], messageCount: 0, errorMessage: safeError(error) };
    }
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

function installReadOnlySocketGuards(socket: Record<string, unknown>): void {
  const blocked = [
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
  ];
  for (const method of blocked) {
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

function isLidJid(jid: string): boolean {
  return jid.endsWith("@lid") || jid.endsWith("@hosted.lid");
}

function safeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 500);
  }
  return "Unknown live client error.";
}

function decodeLiveMessageKey(sourceMessageKey: string): { remoteJid: string; id: string; participant?: string; fromMe?: boolean } {
  const [, chatSourceId, participant, fromMe, sourceMessageId] = sourceMessageKey.split("|");
  return {
    remoteJid: chatSourceId,
    id: sourceMessageId,
    participant: participant || undefined,
    fromMe: fromMe === "1" ? true : fromMe === "0" ? false : undefined
  };
}
