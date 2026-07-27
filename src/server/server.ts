import express from "express";
import type { Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config";
import { cleanupSensitiveWorkDirs } from "./cleanup";
import { installLiveProcessGuards } from "./diagnostics/processGuards";
import { createArchiveRepository, initializeArchiveDatabase } from "./db/archive";
import { mediaBlobStore } from "./media/blobStore";
import { configuredTraceRecorder, getTraceRecorderSummary } from "./diagnostics/traceRecorder";
import { BaileysLiveWhatsAppClient } from "./live/baileysClient";
import { runImport } from "./import/importer";
import { listWaContacts } from "./import/waContacts";
import {
  cancelImportJob,
  getCurrentImportJob,
  getImportJob,
  startImportJob,
  verifyImportKey
} from "./import/staging";
import { detectBackupFolder } from "./import/detectBackup";
import { isPickerAvailable, pickImportPath } from "./import/nativePicker";
import { closeLegacyWallClockGaps } from "./live/auditor";
import { assertLiveBaselineExists } from "./live/baseline";
import { ensureUsableLiveCreds } from "./live/baileysClient";
import { liveOptionsFromConfig } from "./live/maintainer";
import { LiveMaintainer } from "./live/maintainer";
import { queryMemory, resolveMemoryCitation, runMemoryConsolidation, validateMemoryStore } from "./memory/consolidation";
import { disableRemoteMemoryProvider, enableCodexProvider, getMemoryProviderStatus } from "./memory/provider";
import { isLocalDatabaseError, publicErrorMessage } from "./privacy";
import { isMaskedNumberLabel } from "./import/jid";
import { GoogleContactsService } from "./googleContacts";
import { getSearchReindexProgress, startSearchReindex } from "./search/reindexJob";
import { withGuidedSetup } from "./onboarding";
import type { ArchiveChangeEvent, BrainGraphEdgeKind, BrainLifecycleSort, BrainRunKind, LivePairingSummary, PickKind } from "../shared/types";
import type { LiveMessageEvent } from "./live/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Survive stray network-stream 'error' events from undici/Baileys internals
// instead of dying mid-live-sync; unknown exceptions still crash loudly.
installLiveProcessGuards();

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

const repository = createArchiveRepository();
const googleContacts = new GoogleContactsService(config.googleContacts);
let activeMaintainer: LiveMaintainer | null = null;
let activeClient: BaileysLiveWhatsAppClient | null = null;
let livePairing: LivePairingSummary = idlePairing();
let archiveEventId = 0;
const archiveEventClients = new Set<Response>();

// Demo instances make no external calls: the endpoints that would start one
// (live pairing, Google OAuth, provider enablement) refuse with this stable
// shape, which the client explains instead of ever letting the user hit it.
const demoStatusFields = { demo: config.demo, demoWorkspacePath: config.demo ? path.resolve(config.workDir) : null };
function refuseInDemo(res: Response): boolean {
  if (!config.demo) {
    return false;
  }
  res.status(409).json({ ok: false, demo: true, error: "This is a demo instance with synthetic data — external connections are disabled." });
  return true;
}

app.get("/api/status", async (_req, res) => {
  try {
    res.json({ ...withGuidedSetup(await repository.getStatus()), pickerAvailable: isPickerAvailable(), ...demoStatusFields });
  } catch {
    res.json({
      ...withGuidedSetup({
        database: {
          configured: true,
          initialized: false,
          adapter: config.archive.adapter,
          error: "Local archive database is not initialized or not reachable."
        },
        counts: { chats: 0, contacts: 0, participants: 0, messages: 0, warnings: 0 },
        latestImport: null,
        latestWarnings: []
      }),
      pickerAvailable: isPickerAvailable(),
      ...demoStatusFields
    });
  }
});

app.get("/api/google-contacts/status", async (_req, res) => {
  try { res.json(await googleContacts.status()); }
  catch (error) { res.status(400).json({ error: publicErrorMessage(error) }); }
});

app.get("/api/google-contacts/oauth/start", (_req, res) => {
  if (refuseInDemo(res)) return;
  try { res.redirect(googleContacts.createAuthorizationUrl()); }
  catch (error) { res.redirect(`/?googleContacts=error&message=${encodeURIComponent(publicErrorMessage(error))}`); }
});

app.get("/api/google-contacts/oauth/callback", async (req, res) => {
  if (refuseInDemo(res)) return;
  try {
    await googleContacts.handleCallback(typeof req.query.code === "string" ? req.query.code : "", typeof req.query.state === "string" ? req.query.state : "");
    res.redirect("/?googleContacts=connected");
  } catch (error) {
    res.redirect(`/?googleContacts=error&message=${encodeURIComponent(publicErrorMessage(error))}`);
  }
});

app.post("/api/google-contacts/sync", async (_req, res) => {
  if (refuseInDemo(res)) return;
  try {
    const result = await googleContacts.sync(repository);
    if (result.improvedNames > 0) broadcastArchiveChanged({ source: "manual", chatSourceIds: [], messageCount: 0, contactCount: result.improvedNames });
    res.json({ ok: true, result, status: await googleContacts.status() });
  } catch (error) { res.status(400).json({ ok: false, error: publicErrorMessage(error) }); }
});

app.delete("/api/google-contacts", async (_req, res) => {
  try { res.json({ ok: true, ...(await googleContacts.disconnect()), status: await googleContacts.status() }); }
  catch (error) { res.status(400).json({ ok: false, error: publicErrorMessage(error) }); }
});

// --- Two-level person model: identities stay immutable anchors; persons are
// an editable membership. Every mutation below is metadata-only (episodes,
// claims, and citations are structurally untouched) and audited.

app.get("/api/persons", async (_req, res) => {
  try {
    const { getPersonScanStatus } = await import("./persons/scanStatus");
    res.json({ persons: await repository.listPersons({ limit: 500 }), scan: getPersonScanStatus() });
  } catch (error) { res.status(400).json({ error: publicErrorMessage(error) }); }
});

app.get("/api/persons/suggestions", async (req, res) => {
  try {
    const raw = typeof req.query.status === "string" ? req.query.status : "pending";
    const status = (["pending", "accepted", "rejected", "superseded"] as const).find((value) => value === raw) ?? "pending";
    res.json({ suggestions: await repository.listPersonSuggestions({ status, limit: 200 }) });
  } catch (error) { res.status(400).json({ error: publicErrorMessage(error) }); }
});

app.get("/api/persons/suppressions", async (_req, res) => {
  try { res.json({ suppressions: await repository.listPersonLinkSuppressions(200) }); }
  catch (error) { res.status(400).json({ error: publicErrorMessage(error) }); }
});

// Append-only person-layer audit trail (sources and evidence, never bodies).
// Registered before /api/persons/:id so the literal path wins.
app.get("/api/persons/events", async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    res.json({ events: await repository.listPersonLinkEvents({ limit }) });
  } catch (error) { res.status(400).json({ error: publicErrorMessage(error) }); }
});

// Explorer context for a compared pair in one request: per-side media strips
// (ids + labels, thumbnails served by the existing media route) and the
// shared-group membership timeline.
app.get("/api/persons/compare-context", async (req, res) => {
  try {
    const jidA = typeof req.query.jidA === "string" ? req.query.jidA.trim() : "";
    const jidB = typeof req.query.jidB === "string" ? req.query.jidB.trim() : "";
    if (!jidA || !jidB) {
      res.status(400).json({ error: "Both identities are required." });
      return;
    }
    const [lowMedia, highMedia, periodsA, periodsB] = await Promise.all([
      repository.listRecentMediaBySender(jidA, 8),
      repository.listRecentMediaBySender(jidB, 8),
      repository.listGroupMembershipPeriods({ participantJid: jidA, limit: 200 }),
      repository.listGroupMembershipPeriods({ participantJid: jidB, limit: 200 })
    ]);
    // Collapse a side's periods per group: earliest join; an open period
    // (left == null) means "still in" and outranks any past leave.
    const reduceSide = (periods: typeof periodsA) => {
      const raw = new Map<string, { joins: number[]; lefts: number[]; hasOpen: boolean }>();
      for (const period of periods) {
        const entry = raw.get(period.groupSourceId) ?? { joins: [], lefts: [], hasOpen: false };
        if (period.joinedAtMs != null) entry.joins.push(period.joinedAtMs);
        if (period.leftAtMs == null) entry.hasOpen = true;
        else entry.lefts.push(period.leftAtMs);
        raw.set(period.groupSourceId, entry);
      }
      const byGroup = new Map<string, { joinedAtMs: number | null; leftAtMs: number | null }>();
      for (const [groupId, entry] of raw) {
        byGroup.set(groupId, {
          joinedAtMs: entry.joins.length ? Math.min(...entry.joins) : null,
          leftAtMs: entry.hasOpen ? null : entry.lefts.length ? Math.max(...entry.lefts) : null
        });
      }
      return byGroup;
    };
    const sideA = reduceSide(periodsA);
    const sideB = reduceSide(periodsB);
    const sharedIds = [...sideA.keys()].filter((groupId) => sideB.has(groupId));
    const labels = await repository.getChatLabels(sharedIds);
    const sharedGroups = sharedIds.map((groupSourceId) => ({
      groupSourceId,
      label: labels.get(groupSourceId) ?? null,
      low: sideA.get(groupSourceId) ?? null,
      high: sideB.get(groupSourceId) ?? null
    }));
    res.json({ lowMedia, highMedia, sharedGroups });
  } catch (error) { res.status(400).json({ error: publicErrorMessage(error) }); }
});

// Local avatar cache, live-fetched on demand: cache-first, TTL + negative
// cache, immediate miss when no live session can supply a URL. Bytes stay
// under .wapp-brain/ and are served privately.
app.get("/api/persons/avatar", async (req, res) => {
  try {
    const jid = typeof req.query.jid === "string" ? req.query.jid.trim() : "";
    if (!jid) {
      res.status(400).json({ error: "An identity is required." });
      return;
    }
    const canonical = await repository.resolveIdentityJid(jid);
    const { getCachedAvatar } = await import("./persons/avatarCache");
    const client = activeClient;
    const avatar = await getCachedAvatar(canonical, client ? (target) => client.fetchProfilePictureUrl(target) : undefined);
    if (!avatar) {
      res.status(404).json({ error: "No profile photo is available." });
      return;
    }
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Type", avatar.mime);
    fs.createReadStream(avatar.filePath).pipe(res);
  } catch (error) { res.status(400).json({ error: publicErrorMessage(error) }); }
});

// Unresolved-name debt, ranked by the brain content a name would repair —
// the hygiene queue's second item kind.
app.get("/api/persons/debt", async (_req, res) => {
  try {
    const debt = await repository.getBrainResolutionDebt({ limit: 100 });
    res.json({ episodesWithUnresolved: debt.episodesWithUnresolved, distinctIdentities: debt.distinctIdentities, items: debt.topIdentities });
  } catch (error) { res.status(400).json({ error: publicErrorMessage(error) }); }
});

// In-app rename: the proven set-contact-name path promoted to a route, with
// 'user' provenance (strongest source). Routes through the identity-repair
// entry point — episodes and search update deterministically, no model call.
app.post("/api/persons/rename", async (req, res) => {
  try {
    const { jid, name } = (req.body ?? {}) as { jid?: string; name?: string };
    const trimmedName = name?.trim() ?? "";
    const trimmedJid = jid?.trim() ?? "";
    if (!trimmedJid || !trimmedName) {
      res.status(400).json({ ok: false, error: "An identity and a name are both required." });
      return;
    }
    if (isMaskedNumberLabel(trimmedName)) {
      res.status(400).json({ ok: false, error: "That looks like a masked number placeholder, not a name." });
      return;
    }
    const canonical = await repository.resolveIdentityJid(trimmedJid);
    const localDigits = canonical.split("@")[0]?.split(":")[0] ?? canonical;
    if (trimmedName === canonical || trimmedName === localDigits || trimmedName.replace(/\D/g, "") === localDigits) {
      res.status(400).json({ ok: false, error: "That name just restates the number — enter a real name." });
      return;
    }
    const before = await repository.getBrainResolutionDebt({ limit: 10_000 });
    const willRepair = before.topIdentities.find((identity) => identity.jid === canonical)?.episodeCount ?? 0;
    const phone = canonical.endsWith("@s.whatsapp.net") ? localDigits.replace(/\D/g, "") || null : null;
    await repository.upsertContacts("user-rename", [
      { sourceJid: canonical, displayName: trimmedName, displayNameSource: "user", phoneNumber: phone }
    ]);
    const after = await repository.getBrainResolutionDebt({ limit: 1 });
    broadcastArchiveChanged({ source: "manual", chatSourceIds: [canonical], messageCount: 0, contactCount: 1 });
    res.json({
      ok: true,
      jid: canonical,
      name: trimmedName,
      repairedEpisodes: willRepair,
      debtBefore: before.episodesWithUnresolved,
      debtAfter: after.episodesWithUnresolved
    });
  } catch (error) { res.status(400).json({ ok: false, error: publicErrorMessage(error) }); }
});

// Recent visible activity of one identity across every chat (groups
// included) — the compare dialog's view for identities without a direct chat.
app.get("/api/persons/identity-messages", async (req, res) => {
  try {
    const jid = typeof req.query.jid === "string" ? req.query.jid.trim() : "";
    if (!jid) {
      res.status(400).json({ error: "An identity is required." });
      return;
    }
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    res.json({ messages: await repository.listRecentMessagesBySender(jid, limit) });
  } catch (error) { res.status(400).json({ error: publicErrorMessage(error) }); }
});

app.get("/api/persons/:id", async (req, res) => {
  try {
    const lookup = await repository.getPerson(req.params.id);
    if (!lookup.person && !lookup.redirect) {
      res.status(404).json({ error: "No person with that id." });
      return;
    }
    res.json(lookup);
  } catch (error) { res.status(400).json({ error: publicErrorMessage(error) }); }
});

app.post("/api/persons/connect", async (req, res) => {
  try {
    const { jidA, jidB } = (req.body ?? {}) as { jidA?: string; jidB?: string };
    if (!jidA?.trim() || !jidB?.trim()) {
      res.status(400).json({ ok: false, error: "Both identities are required." });
      return;
    }
    const result = await repository.connectIdentities(jidA.trim(), jidB.trim(), "user");
    if (result.outcome === "invalid" || result.outcome === "self") {
      res.status(400).json({ ok: false, error: "Those identities cannot be connected." });
      return;
    }
    broadcastArchiveChanged({ source: "manual", chatSourceIds: [], messageCount: 0, contactCount: 1 });
    res.json({ ok: true, result, person: result.personId ? (await repository.getPerson(result.personId)).person : null });
  } catch (error) { res.status(400).json({ ok: false, error: publicErrorMessage(error) }); }
});

app.post("/api/persons/disconnect", async (req, res) => {
  try {
    const { jid } = (req.body ?? {}) as { jid?: string };
    if (!jid?.trim()) {
      res.status(400).json({ ok: false, error: "An identity is required." });
      return;
    }
    const result = await repository.disconnectIdentities(jid.trim());
    if (!result.disconnected) {
      res.status(404).json({ ok: false, error: "That identity is not a member of any person." });
      return;
    }
    broadcastArchiveChanged({ source: "manual", chatSourceIds: [], messageCount: 0, contactCount: 1 });
    res.json({ ok: true, result });
  } catch (error) { res.status(400).json({ ok: false, error: publicErrorMessage(error) }); }
});

app.post("/api/persons/suggestions/:id/accept", async (req, res) => {
  try {
    const result = await repository.acceptPersonSuggestion(req.params.id);
    broadcastArchiveChanged({ source: "manual", chatSourceIds: [], messageCount: 0, contactCount: 1 });
    res.json({ ok: true, result, person: result.personId ? (await repository.getPerson(result.personId)).person : null });
  } catch (error) { res.status(400).json({ ok: false, error: publicErrorMessage(error) }); }
});

app.post("/api/persons/suggestions/:id/reject", async (req, res) => {
  try {
    const rejected = await repository.rejectPersonSuggestion(req.params.id);
    if (!rejected) {
      res.status(404).json({ ok: false, error: "The suggestion no longer exists or was already resolved." });
      return;
    }
    res.json({ ok: true });
  } catch (error) { res.status(400).json({ ok: false, error: publicErrorMessage(error) }); }
});

// Release a blocked pair: lifts the suppression so the next sync/detector
// pass may re-evaluate it. Never connects by itself.
app.post("/api/persons/suppressions/release", async (req, res) => {
  try {
    const { jidLow, jidHigh } = (req.body ?? {}) as { jidLow?: string; jidHigh?: string };
    if (!jidLow?.trim() || !jidHigh?.trim()) {
      res.status(400).json({ ok: false, error: "Both identities of the blocked pair are required." });
      return;
    }
    const released = await repository.releasePersonLinkSuppression(jidLow.trim(), jidHigh.trim());
    if (!released) {
      res.status(404).json({ ok: false, error: "No block exists for that pair." });
      return;
    }
    res.json({ ok: true });
  } catch (error) { res.status(400).json({ ok: false, error: publicErrorMessage(error) }); }
});

// Human-only dismissal undo: restores every rejected signal for the pair.
app.post("/api/persons/suggestions/undo", async (req, res) => {
  try {
    const { jidLow, jidHigh } = (req.body ?? {}) as { jidLow?: string; jidHigh?: string };
    if (!jidLow?.trim() || !jidHigh?.trim()) {
      res.status(400).json({ ok: false, error: "Both identities of the dismissed pair are required." });
      return;
    }
    const restored = await repository.unrejectPersonSuggestions(jidLow.trim(), jidHigh.trim());
    if (restored === 0) {
      res.status(404).json({ ok: false, error: "No dismissed suggestions exist for that pair." });
      return;
    }
    res.json({ ok: true, restored });
  } catch (error) { res.status(400).json({ ok: false, error: publicErrorMessage(error) }); }
});

app.post("/api/persons/scan", async (_req, res) => {
  try {
    const { runPersonAutoConnectPass } = await import("./persons/autoConnect");
    const { runPersonSuggestionDetectors } = await import("./persons/suggestions");
    const autoConnect = await runPersonAutoConnectPass(repository);
    const detectors = await runPersonSuggestionDetectors(repository);
    if (autoConnect.googleConnected + autoConnect.numberChangeConnected > 0) {
      broadcastArchiveChanged({ source: "manual", chatSourceIds: [], messageCount: 0, contactCount: autoConnect.googleConnected + autoConnect.numberChangeConnected });
    }
    res.json({ ok: true, autoConnect, detectors });
  } catch (error) {
    console.error(`[persons] scan failed: ${publicErrorMessage(error)}`);
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.get("/api/live/status", async (_req, res) => {
  try {
    res.json(await repository.getLiveStatus());
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/live/gaps", async (_req, res) => {
  try {
    res.json(await repository.listLiveGaps(["open", "retrying", "uncertain", "needs_user_action"]));
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.post("/api/live/gaps/:id/retry", async (req, res) => {
  if (refuseInDemo(res)) return;
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ ok: false, error: "Invalid gap id." });
      return;
    }
    await repository.updateLiveGapStatus(id, "open", "User requested retry from local API.");
    res.json({ ok: true, live: await repository.getLiveStatus() });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.post("/api/live/unlink", async (_req, res) => {
  if (refuseInDemo(res)) return;
  try {
    await stopActiveMaintainer();
    const options = liveOptionsFromConfig();
    await fs.promises.rm(options.authDir, { recursive: true, force: true });
    await repository.upsertLiveSession({ id: "default", status: "not_configured", clientName: options.clientName, lastError: null });
    livePairing = idlePairing();
    res.json({ ok: true, live: await repository.getLiveStatus() });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.post("/api/live/stop", async (_req, res) => {
  if (refuseInDemo(res)) return;
  try {
    await stopActiveMaintainer();
    const options = liveOptionsFromConfig();
    await repository.upsertLiveSession({ id: "default", status: "stopped", clientName: options.clientName, lastError: null });
    res.json({ ok: true, live: await repository.getLiveStatus() });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.post("/api/live/link", async (req, res) => {
  if (refuseInDemo(res)) return;
  try {
    await assertLiveBaselineExists(repository, config.live.maxBackfillPerChatDays);
    const phoneNumber = typeof req.body?.phoneNumber === "string" && req.body.phoneNumber.trim() ? req.body.phoneNumber.trim() : null;
    // WhatsApp only issues a pairing QR for UNREGISTERED credentials. After a
    // remote unlink (logged_out) the stored creds still exist but are dead —
    // reconnecting with them just yields another 401 and no QR, forever.
    // Re-pairing therefore needs a clean slate: stop any maintainer holding
    // the dead session and remove the auth state (including its backup).
    const options = liveOptionsFromConfig();
    const live = await repository.getLiveStatus();
    if (live.session?.status === "logged_out" || !(await ensureUsableLiveCreds(options.authDir))) {
      await stopActiveMaintainer();
      await fs.promises.rm(options.authDir, { recursive: true, force: true });
      await repository.upsertLiveSession({ id: "default", status: "not_configured", clientName: options.clientName, lastError: null });
      livePairing = idlePairing();
    }
    await startLiveMaintainer(phoneNumber);
    res.json({ ok: true, pairing: livePairing, live: await repository.getLiveStatus() });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.post("/api/live/resume", async (_req, res) => {
  if (refuseInDemo(res)) return;
  try {
    // Resume never requires a fresh baseline: long downtime is represented as
    // honest gaps/uncertainty by the evidence-based audit instead of a refusal.
    await startLiveMaintainer(null);
    res.json({ ok: true, pairing: livePairing, live: await repository.getLiveStatus() });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.get("/api/live/pairing", (_req, res) => {
  res.json(livePairing);
});

// In-memory counters only — no database access, so it answers instantly even
// while heavy history-sync ingestion is running.
app.get("/api/live/progress", (_req, res) => {
  res.json(
    activeMaintainer?.getSyncProgress() ?? {
      active: false,
      connected: false,
      processedMessages: 0,
      processedEvents: 0,
      queuedMessages: 0,
      historySyncPercent: null,
      auditPending: false,
      gapsOpened: 0,
      gapsClosed: 0,
      lastEventAt: null
    }
  );
});

app.get("/api/archive/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  archiveEventClients.add(res);
  req.on("close", () => {
    archiveEventClients.delete(res);
  });
});

app.get("/api/diagnostics/trace", (_req, res) => {
  res.json(getTraceRecorderSummary());
});

app.get("/api/memory/status", async (_req, res) => {
  try {
    res.json(await repository.getMemoryStatus(await getMemoryProviderStatus()));
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.post("/api/memory/runs", async (req, res) => {
  try {
    res.json({
      ok: true,
      result: await runMemoryConsolidation(repository, {
        kind: req.body?.kind === "manual" || req.body?.kind === "rebuild" ? req.body.kind : "rem",
        startAtMs: numberBody(req.body?.startAtMs),
        endAtMs: numberBody(req.body?.endAtMs),
        chatSourceIds: Array.isArray(req.body?.chatSourceIds) ? req.body.chatSourceIds.filter((item: unknown): item is string => typeof item === "string") : undefined,
        dryRun: Boolean(req.body?.dryRun),
        force: Boolean(req.body?.force)
      })
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.post("/api/memory/query", async (req, res) => {
  try {
    const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
    if (!query) {
      res.status(400).json({ error: "Missing memory query." });
      return;
    }
    res.json(await queryMemory(repository, query));
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/memory/citations/:citation", async (req, res) => {
  try {
    res.json(await resolveMemoryCitation(repository, req.params.citation));
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.post("/api/memory/validate", async (_req, res) => {
  try {
    res.json(await validateMemoryStore(repository));
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.post("/api/memory/provider/enable-codex", async (_req, res) => {
  if (refuseInDemo(res)) return;
  try {
    res.json(await enableCodexProvider());
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.post("/api/memory/provider/disable", async (_req, res) => {
  try {
    res.json(await disableRemoteMemoryProvider());
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.post("/api/init-db", async (_req, res) => {
  try {
    await initializeArchiveDatabase();
    res.json({ ok: true, status: await repository.getStatus() });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.post("/api/import", async (req, res) => {
  try {
    if (req.body?.mode === "replace") {
      await repository.clearArchiveData();
    }
    const totals = await runImport(repository, {
      msgstorePath: String(req.body?.msgstorePath ?? ""),
      waPath: req.body?.waPath ? String(req.body.waPath) : null,
      mediaPath: req.body?.mediaPath ? String(req.body.mediaPath) : null,
      key: req.body?.key ? String(req.body.key) : null,
      keepDecrypted: Boolean(req.body?.keepDecrypted),
      mode: req.body?.mode === "replace" ? "replace" : "merge"
    });
    await configuredTraceRecorder?.snapshotArchive("after-api-import", config.archive.sqlitePath);
    broadcastArchiveChanged({
      source: "import",
      chatSourceIds: [],
      messageCount: totals.messages,
      contactCount: totals.contacts
    });
    res.json({ ok: true, totals });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

// Opens a native OS file/folder dialog on the machine running the server and
// returns the absolute path the user selects — nothing is uploaded. Request
// abort (client closed the wizard) cancels the pending dialog.
app.post("/api/import/pick", async (req, res) => {
  try {
    const kind = pickKind(req.body?.kind);
    const controller = new AbortController();
    // Abort only on a real client disconnect. The request's own "close" fires as
    // soon as its (already-consumed) body ends, which would kill the dialog
    // instantly — the response only closes early when the client goes away.
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const result = await pickImportPath(kind, {
      startIn: req.body?.startIn ? String(req.body.startIn) : null,
      signal: controller.signal
    });
    if ("path" in result) {
      res.json({ ok: true, path: result.path });
    } else if ("cancelled" in result) {
      res.json({ ok: true, cancelled: true });
    } else {
      res.json({ ok: false, unavailable: true, reason: result.reason });
    }
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

// Scans a selected backup folder and returns a manifest of the detected inputs
// plus recognized (reserved) auxiliary files. Works for native-picked and typed
// paths alike.
app.post("/api/import/detect", async (req, res) => {
  try {
    const root = req.body?.root ? String(req.body.root) : "";
    if (!root || /^https?:\/\//i.test(root)) {
      res.status(400).json({ ok: false, error: "Provide a local backup folder path." });
      return;
    }
    const manifest = await detectBackupFolder(root);
    res.json({ ok: true, manifest });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.post("/api/import/verify-key", async (req, res) => {
  try {
    res.json({
      ok: true,
      verification: await verifyImportKey({
        msgstorePath: req.body?.msgstorePath ? String(req.body.msgstorePath) : null,
        waPath: req.body?.waPath ? String(req.body.waPath) : null,
        key: req.body?.key ? String(req.body.key) : null
      })
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

// Decrypts (if needed) and lists just the wa.db contacts sidecar, independent
// of a full msgstore import — a quick "what's in this backup" check.
app.post("/api/wa-contacts", async (req, res) => {
  try {
    const waPath = req.body?.waPath ? String(req.body.waPath) : "";
    if (!waPath) {
      res.status(400).json({ ok: false, error: "Provide a local wa.db or wa.db.crypt15 path." });
      return;
    }
    const summary = await listWaContacts({
      waPath,
      key: req.body?.key ? String(req.body.key) : null,
      keyPath: req.body?.keyPath ? String(req.body.keyPath) : null
    });
    res.json({ ok: true, summary });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.post("/api/import/jobs", async (req, res) => {
  try {
    res.json({
      ok: true,
      job: startImportJob(repository, {
        mode: req.body?.mode === "replace" ? "replace" : "merge",
        key: req.body?.key ? String(req.body.key) : null,
        keepDecrypted: Boolean(req.body?.keepDecrypted),
        paths: {
          msgstorePath: req.body?.paths?.msgstorePath ? String(req.body.paths.msgstorePath) : undefined,
          waPath: req.body?.paths?.waPath ? String(req.body.paths.waPath) : undefined,
          mediaPath: req.body?.paths?.mediaPath ? String(req.body.paths.mediaPath) : undefined
        }
      }, {
        onArchiveChanged: (summary) => {
          broadcastArchiveChanged({
            source: summary.source,
            chatSourceIds: [],
            messageCount: summary.messageCount,
            contactCount: summary.contactCount
          });
        }
      })
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.get("/api/import/jobs/current", (_req, res) => {
  try {
    res.json({ job: getCurrentImportJob() });
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/import/jobs/:jobId", (req, res) => {
  try {
    res.json(getImportJob(req.params.jobId));
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.delete("/api/import/jobs/:jobId", (req, res) => {
  try {
    res.json({ ok: true, job: cancelImportJob(req.params.jobId) });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.post("/api/cleanup", async (_req, res) => {
  try {
    res.json({ ok: true, summary: await cleanupSensitiveWorkDirs() });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.get("/api/chats", async (req, res) => {
  try {
    const limit = clampNumber(req.query.limit, 25, 200, 60);
    const offset = clampNumber(req.query.offset, 0, 1_000_000, 0);
    res.json(
      await repository.listChats({
        search: stringQuery(req.query.search),
        type: stringQuery(req.query.type),
        includeEventOnly: booleanQuery(req.query.includeEventOnly),
        limit,
        offset
      })
    );
  } catch (error) {
    if (error instanceof Error && isLocalDatabaseError(error.message)) {
      res.json([]);
      return;
    }
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/chats/:id/messages", async (req, res) => {
  try {
    const chatId = Number(req.params.id);
    const limit = clampNumber(req.query.limit, 25, 300, 150);
    const offset = clampNumber(req.query.offset, 0, 5_000_000, 0);
    res.json(
      await repository.listMessages(chatId, {
        limit,
        offset,
        sender: stringQuery(req.query.sender),
        query: stringQuery(req.query.query),
        order: req.query.order === "desc" ? "desc" : "asc"
      })
    );
  } catch (error) {
    if (error instanceof Error && isLocalDatabaseError(error.message)) {
      res.json([]);
      return;
    }
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Thread window centered on one message — search deep links land here so the
// viewer opens positioned at the hit instead of paging from the newest row.
app.get("/api/chats/:id/messages/context", async (req, res) => {
  try {
    const chatId = Number(req.params.id);
    const anchorId = Number(req.query.anchorId);
    if (!Number.isInteger(chatId) || !Number.isInteger(anchorId)) {
      res.status(400).json({ error: "A chat id and anchor message id are required." });
      return;
    }
    const radius = clampNumber(req.query.radius, 5, 150, 75);
    const window = await repository.listMessagesAround(chatId, anchorId, radius);
    if (!window) {
      res.status(404).json({ error: "The anchor message was not found in this chat." });
      return;
    }
    res.json(window);
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const query = stringQuery(req.query.query);
    if (!query) {
      res.json({ index: await repository.getSearchIndexStatus(), totalMatches: 0, results: [] });
      return;
    }
    const type = req.query.type === "text" || req.query.type === "media" || req.query.type === "call" ? req.query.type : null;
    const direction = req.query.direction === "incoming" || req.query.direction === "outgoing" ? req.query.direction : null;
    res.json(
      await repository.searchMessages({
        query,
        chatId: optionalNumberQuery(req.query.chatId),
        sender: stringQuery(req.query.sender) ?? null,
        afterMs: optionalNumberQuery(req.query.afterMs),
        beforeMs: optionalNumberQuery(req.query.beforeMs),
        type,
        direction,
        includeNoise: booleanQuery(req.query.includeNoise),
        limit: clampNumber(req.query.limit, 1, 100, 25),
        offset: clampNumber(req.query.offset, 0, 200, 0)
      })
    );
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/search/status", async (_req, res) => {
  try {
    res.json({ index: await repository.getSearchIndexStatus(), reindex: getSearchReindexProgress() });
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Brain substrate status: watermark coverage, task queue, budget ledger,
// provider health, and run-dueness in one call — the operator dashboard for
// "is the brain keeping itself updated" under manual-first control.
app.get("/api/brain/status", async (_req, res) => {
  try {
    const { getBrainProviderStatus } = await import("./brain/provider");
    const { schedulerStatusFromSummary } = await import("./brain/scheduler");
    const { EXTRACTION_VERSION } = await import("./brain/episodes");
    const status = await repository.getBrainStatus();
    res.json({
      ...status,
      provider: getBrainProviderStatus(),
      // Dueness derived from the status we already computed — no extra scan, so
      // this stays a fast, UI-pollable endpoint.
      scheduler: schedulerStatusFromSummary(status),
      // Contract v2 quality surfaces: all cheap indexed counts.
      extractionVersion: EXTRACTION_VERSION,
      regenerableEpisodes: await repository.countRegenerableBrainEpisodes(EXTRACTION_VERSION),
      validationIssues: await repository.getBrainValidationIssueSummary(),
      // D13 media-demand stat: where unavailable media hurt inferences.
      mediaGaps: await repository.getBrainMediaGapSummary(),
      // Identity late-resolution debt: episodes still referring to people by
      // number, ranked so the highest-value contact saves surface first.
      resolutionDebt: await repository.getBrainResolutionDebt({ limit: 8 }),
      // Eval harness free interim signal: per-model fallback/precision rollup
      // (cheap GROUP BYs over small brain tables).
      modelQuality: await repository.getBrainModelQualityAggregates()
    });
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Backfill dashboard (historical-backfill H4): one server-computed DTO —
// coverage, queue depth, trailing drain rate, honest ETA, per-model spend,
// and the extractive-fallback canary. Meaning lives here; UI/CLI render it.
app.get("/api/brain/backfill/status", async (_req, res) => {
  try {
    const { getBrainBackfillStatus } = await import("./brain/runJob");
    res.json(await getBrainBackfillStatus(repository));
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Regeneration (contract v2): re-derive stale-version/extractive episodes from
// their stored windows under the current contract, superseding the old rows.
// dryRun reports the queue size without spending anything. onlyExtractive is
// the backfill dashboard's "sweep the fallbacks" scope.
app.post("/api/brain/regenerate", async (req, res) => {
  try {
    if (!req.body?.dryRun && !(await repository.getArchiveOwnerName())) {
      res.status(400).json({ error: "Set your name first — episodes label your messages with it (Run console → Identity)." });
      return;
    }
    const { EXTRACTION_VERSION } = await import("./brain/episodes");
    const chatSourceId = typeof req.body?.chatSourceId === "string" ? req.body.chatSourceId : null;
    const onlyExtractive = req.body?.onlyExtractive === true;
    // Pack-size scope: targeted re-derivation of small episodes only.
    // Explicit null/omitted = unscoped (Number(null) is 0, so guard first).
    const maxMessages = req.body?.maxMessages != null ? clampNumber(req.body.maxMessages, 1, 10_000, 0) || null : null;
    if (req.body?.dryRun) {
      const stale = await repository.listRegenerableBrainEpisodes({
        currentVersion: EXTRACTION_VERSION,
        chatSourceId,
        onlyExtractive,
        maxMessageCount: maxMessages,
        limit: 10_000
      });
      res.json({ ok: true, dryRun: true, episodes: stale.length });
      return;
    }
    const { startBrainRun } = await import("./brain/runJob");
    // Turbo overrides (the fallback sweep is a bulk re-derivation): the sliding
    // pool + no-hourly-cap machinery mirrors backfill. 0 = unset.
    const callsPerHour = clampNumber(req.body?.callsPerHour, 1, 1000, 0);
    const callsPerDay = clampNumber(req.body?.callsPerDay, 1, 10_000, 0);
    const result = startBrainRun(
      repository,
      {
        mode: "model",
        model: typeof req.body?.model === "string" ? req.body.model : null,
        chatSourceId,
        regenerate: true,
        regenerateOnlyExtractive: onlyExtractive,
        regenerateMaxMessages: maxMessages,
        concurrency: req.body?.concurrency != null ? clampNumber(req.body?.concurrency, 1, 6, 5) : null,
        callsPerHour: callsPerHour > 0 ? callsPerHour : null,
        callsPerDay: callsPerDay > 0 ? callsPerDay : null
      },
      () => {
        broadcastArchiveChanged({ source: "manual", chatSourceIds: [], messageCount: 0, contactCount: 0 });
      }
    );
    if (!result.started) {
      res.status(409).json({ error: result.refusal ?? "The regeneration run could not start.", progress: result.progress });
      return;
    }
    res.json({ ok: true, progress: result.progress });
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Manual brain runs: start with an explicit generator/model, poll progress.
// User-triggered runs REQUIRE an owner name (episodes label the user's own
// messages with it); the automatic scheduler keeps its fallback and is exempt.
app.post("/api/brain/runs", async (req, res) => {
  try {
    if (!(await repository.getArchiveOwnerName())) {
      res.status(400).json({ error: "Set your name first — episodes label your messages with it (Run console → Identity)." });
      return;
    }
    const { startBrainRun } = await import("./brain/runJob");
    const mode = req.body?.mode === "model" || req.body?.mode === "extractive" ? req.body.mode : "model";
    const backfill = req.body?.backfill === true;
    const maxTokens = clampNumber(req.body?.maxTokens, 1000, 100_000_000, 0);
    // Backfill turbo pacing overrides (H2): 0 = not set (clampNumber default).
    const callsPerHour = clampNumber(req.body?.callsPerHour, 1, 1000, 0);
    const callsPerDay = clampNumber(req.body?.callsPerDay, 1, 10_000, 0);
    const result = startBrainRun(
      repository,
      {
        mode,
        model: typeof req.body?.model === "string" ? req.body.model : null,
        chatSourceId: typeof req.body?.chatSourceId === "string" ? req.body.chatSourceId : null,
        // Backfill drains the whole queue unless capped; manual keeps its 10.
        maxChats: backfill
          ? req.body?.maxChats != null
            ? clampNumber(req.body?.maxChats, 1, 100_000, 0) || undefined
            : undefined
          : clampNumber(req.body?.maxChats, 1, 5000, 10),
        maxModelCalls: backfill
          ? req.body?.maxModelCalls != null
            ? clampNumber(req.body?.maxModelCalls, 1, 100_000, 0) || undefined
            : undefined
          : clampNumber(req.body?.maxModelCalls, 1, 1000, config.brain.maxCallsPerHour),
        // 0 = no token budget (clampNumber's default when the field is absent).
        maxTokens: mode === "model" && maxTokens > 0 ? maxTokens : null,
        backfill,
        callsPerHour: backfill && callsPerHour > 0 ? callsPerHour : null,
        callsPerDay: backfill && callsPerDay > 0 ? callsPerDay : null,
        strict: backfill && req.body?.strict === true,
        concurrency: backfill ? clampNumber(req.body?.concurrency, 1, 6, 5) : null
      },
      () => {
        broadcastArchiveChanged({ source: "manual", chatSourceIds: [], messageCount: 0, contactCount: 0 });
      },
      async () => {
        const contactStatus = await googleContacts.status();
        if (!contactStatus.connected) return;
        const sync = await googleContacts.sync(repository);
        if (sync.improvedNames > 0) {
          broadcastArchiveChanged({ source: "manual", chatSourceIds: [], messageCount: 0, contactCount: sync.improvedNames });
        }
      }
    );
    if (!result.started) {
      res.status(409).json({ error: result.refusal ?? "The brain run could not start.", progress: result.progress });
      return;
    }
    res.json({ ok: true, progress: result.progress });
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/brain/runs/current", async (_req, res) => {
  try {
    const { getBrainRunProgress } = await import("./brain/runJob");
    res.json(getBrainRunProgress());
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// A specific run object (manual or scheduled) by id — the durable record with
// its final status and totals, for polling a run after the in-memory progress
// has rolled over to the next one.
// Run history + the per-run audit. `effects` answers "what did this run
// durably change?" — especially outside the artifact it was asked to produce.
// `doc` scopes the history to one page: the runs that wrote (or were refused
// writing) a revision of it, or raised an issue against it.
app.get("/api/brain/runs", async (req, res) => {
  try {
    const kindRaw = stringQuery(req.query.kind);
    const kinds = ["nightly", "catchup", "manual", "backfill", "regenerate", "lifecycle", "rollup"];
    res.json({
      runs: await repository.listBrainRuns({
        kind: kindRaw && kinds.includes(kindRaw) ? (kindRaw as BrainRunKind) : undefined,
        docId: stringQuery(req.query.doc) || undefined,
        limit: clampNumber(req.query.limit, 1, 500, 50)
      })
    });
  } catch (error) {
    res.status(500).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/brain/runs/:id/effects", async (req, res) => {
  try {
    const effects = await repository.getBrainRunEffects(String(req.params.id));
    if (!effects) {
      res.status(404).json({ error: "No such run." });
      return;
    }
    res.json(effects);
  } catch (error) {
    res.status(500).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/brain/runs/:id", async (req, res) => {
  try {
    const run = await repository.getBrainRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: "No brain run with that id." });
      return;
    }
    res.json(run);
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Cancel the in-progress manual run: sets a cooperative stop flag the run loop
// checks between chats, ending it as 'interrupted' (watermarks make the partial
// coverage honest; nothing needs undoing).
app.post("/api/brain/runs/cancel", async (_req, res) => {
  try {
    const { requestBrainRunCancel, getBrainRunProgress } = await import("./brain/runJob");
    const cancelled = requestBrainRunCancel();
    res.json({ ok: true, cancelling: cancelled, progress: getBrainRunProgress() });
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/brain/episodes", async (req, res) => {
  try {
    res.json(
      await repository.listBrainEpisodes({
        chatSourceId: stringQuery(req.query.chatSourceId) ?? null,
        limit: clampNumber(req.query.limit, 1, 100, 20)
      })
    );
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Reset derived brain data (episodes/claims/citations/watermarks + projected
// files) — raw messages untouched; the next run re-assimilates from scratch.
app.post("/api/brain/reset", async (req, res) => {
  try {
    const { getBrainRunProgress } = await import("./brain/runJob");
    if (getBrainRunProgress().state === "running") {
      res.status(409).json({ error: "A brain run is in progress; wait for it to finish before resetting." });
      return;
    }
    const chatSourceId = typeof req.body?.chatSourceId === "string" ? req.body.chatSourceId : null;
    const result = await repository.resetBrainDerivedData({ chatSourceId });
    const { clearAllProjectedEpisodeFiles, deleteProjectedEpisodeFiles } = await import("./brain/episodes");
    // A full reset empties the whole projection dir (orphan-proof); a scoped
    // reset only removes the affected chat's episode files.
    const filesRemoved = chatSourceId ? deleteProjectedEpisodeFiles(result.episodeIds) : clearAllProjectedEpisodeFiles();
    console.log(
      `[brain] reset${chatSourceId ? ` (one chat)` : ""}: ${result.episodeIds.length} episode(s), ${result.watermarks} watermark(s), ${filesRemoved} file(s) removed`
    );
    broadcastArchiveChanged({ source: "manual", chatSourceIds: chatSourceId ? [chatSourceId] : [], messageCount: 0, contactCount: 0 });
    res.json({ ok: true, episodesRemoved: result.episodeIds.length, watermarksReset: result.watermarks, filesRemoved });
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// --- Knowledge graph (knowledge-graph-foundation) ---
// Read surfaces + the two deterministic maintenance jobs. Zero model calls on
// every path here; rebuild/recompute are chunked and yield, so the server
// stays responsive while they run.
app.get("/api/brain/graph/stats", async (_req, res) => {
  try {
    res.json(await repository.getBrainGraphStats());
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Entity view: person-aggregated at read time through person membership, so a
// connect/disconnect changes the NEXT read with zero graph writes.
app.get("/api/brain/graph/entity", async (req, res) => {
  try {
    const nodeId = stringQuery(req.query.nodeId);
    const jid = stringQuery(req.query.jid);
    const name = stringQuery(req.query.name);
    if (!nodeId && !jid && !name) {
      res.status(400).json({ error: "Provide nodeId, jid, or name." });
      return;
    }
    const view = await repository.getBrainGraphEntity({
      nodeId: nodeId ?? undefined,
      jid: jid ?? undefined,
      name: name ?? undefined
    });
    if (!view) {
      res.status(404).json({ error: "No graph node matches that query." });
      return;
    }
    res.json(view);
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Chat-scoped unresolved person entities ranked by salience — deterministic
// backpressure for the person layer, never a resolution join.
app.get("/api/brain/graph/unresolved", async (req, res) => {
  try {
    res.json(await repository.listUnresolvedBrainGraphEntities({ limit: clampNumber(req.query.limit, 1, 200, 50) }));
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Typeahead for anchoring the explorer: match nodes by their read-time label so
// the client anchors by a real node id, never by an ambiguous free-text name.
app.get("/api/brain/graph/search", async (req, res) => {
  try {
    const q = stringQuery(req.query.q);
    if (!q) {
      res.json([]);
      return;
    }
    res.json(await repository.searchBrainGraphNodes(q, clampNumber(req.query.limit, 1, 25, 10)));
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Bounded anchored neighborhood (graph-explorer): the product primitive. A
// depth-≤2 ego-graph with kind/time/salience filters and hard caps — never the
// whole graph. Read-time labels, same-name disambiguation, truncation
// disclosed. Zero model calls. All clamping lives in resolveNeighborhoodParams.
app.get("/api/brain/graph/neighborhood", async (req, res) => {
  try {
    const nodeId = stringQuery(req.query.nodeId);
    const jid = stringQuery(req.query.jid);
    const name = stringQuery(req.query.name);
    const chat = stringQuery(req.query.chat);
    if (!nodeId && !jid && !name && !chat) {
      res.status(400).json({ error: "Provide an anchor: nodeId, jid, name, or chat." });
      return;
    }
    const kindsRaw = stringQuery(req.query.kinds);
    const view = await repository.getBrainGraphNeighborhood({
      nodeId: nodeId ?? undefined,
      jid: jid ?? undefined,
      name: name ?? undefined,
      chat: chat ?? undefined,
      depth: optionalNumberQuery(req.query.depth) ?? undefined,
      kinds: kindsRaw
        ? (kindsRaw
            .split(",")
            .map((kind) => kind.trim())
            .filter(Boolean) as BrainGraphEdgeKind[])
        : undefined,
      since: optionalNumberQuery(req.query.since),
      until: optionalNumberQuery(req.query.until),
      minSalience: optionalNumberQuery(req.query.minSalience) ?? undefined,
      includeDormant: booleanQuery(req.query.includeDormant),
      maxNodes: optionalNumberQuery(req.query.maxNodes) ?? undefined,
      maxEdges: optionalNumberQuery(req.query.maxEdges) ?? undefined
    });
    if (!view) {
      res.status(404).json({ error: "No graph node matches that anchor." });
      return;
    }
    res.json(view);
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Lazy per-edge evidence for the explorer's trust loop: the edge's claims and
// citations, each carrying the coordinates to open the thread at the exact
// cited message.
app.get("/api/brain/graph/edge", async (req, res) => {
  try {
    const edgeId = optionalNumberQuery(req.query.id);
    if (edgeId == null || !Number.isInteger(edgeId)) {
      res.status(400).json({ error: "Provide a numeric edge id." });
      return;
    }
    const view = await repository.getBrainGraphEdgeEvidence(edgeId);
    if (!view) {
      res.status(404).json({ error: "No graph edge matches that id." });
      return;
    }
    res.json(view);
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Wipe + deterministic replay over current model episodes + signal sync +
// salience recompute. This is also how episodes committed before the graph
// existed gain coverage — no model spend, no episode writes.
app.post("/api/brain/graph/rebuild", async (_req, res) => {
  try {
    const { getBrainRunProgress } = await import("./brain/runJob");
    if (getBrainRunProgress().state === "running") {
      res.status(409).json({ error: "A brain run is in progress; wait for it to finish before rebuilding the graph." });
      return;
    }
    const result = await repository.rebuildBrainGraph();
    console.log(
      `[brain] graph rebuilt: ${result.nodes} node(s), ${result.edges} edge(s), ${result.evidence} evidence row(s) from ${result.episodesReplayed} episode(s) in ${result.durationMs}ms`
    );
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.post("/api/brain/graph/recompute", async (_req, res) => {
  try {
    const result = await repository.recomputeBrainGraphSalience();
    console.log(
      `[brain] graph salience recomputed: ${result.nodes} node(s), ${result.dormant} newly dormant, ${result.revived} revived, ${result.exemptOpenLifecycle} open lifecycle exempt (${result.durationMs}ms)`
    );
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// --- Commitment lifecycle (commitment-lifecycle) ---
// The L0 open-items surface: status-driven (independent of salience and
// dormancy), overdue/stale flagged, as-of stamped. Meaning lives server-side.
app.get("/api/brain/lifecycle", async (req, res) => {
  try {
    const statusRaw = stringQuery(req.query.status);
    const kindRaw = stringQuery(req.query.kind);
    const flagRaw = stringQuery(req.query.flag);
    const sortRaw = stringQuery(req.query.sort);
    const sorts = ["smart", "due_asc", "due_desc", "opened_asc", "opened_desc", "evidence_desc", "recent_activity"];
    res.json(
      await repository.listBrainLifecycleItems({
        status:
          statusRaw === "open" || statusRaw === "fulfilled" || statusRaw === "dismissed" || statusRaw === "all" || statusRaw === "closed"
            ? statusRaw
            : undefined,
        flag: flagRaw === "overdue" || flagRaw === "stale" || flagRaw === "sweep_due" ? flagRaw : undefined,
        hideOverdue: req.query.hideOverdue === "true",
        hideStale: req.query.hideStale === "true",
        hideFulfilled: req.query.hideFulfilled === "true",
        hideDismissed: req.query.hideDismissed === "true",
        dueUpcoming: req.query.dueUpcoming === "true",
        kind: kindRaw === "commitment" || kindRaw === "question" ? kindRaw : undefined,
        includeChats: csvQuery(req.query.includeChats),
        excludeChats: csvQuery(req.query.excludeChats),
        sort: sortRaw && sorts.includes(sortRaw) ? (sortRaw as BrainLifecycleSort) : undefined,
        chatSourceId: stringQuery(req.query.chatSourceId) ?? null,
        limit: clampNumber(req.query.limit, 1, 500, 200)
      })
    );
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Full context for one item (the detail modal): origin, all candidate
// evidence with thread coordinates, and event history.
app.get("/api/brain/lifecycle/item", async (req, res) => {
  try {
    const claimId = stringQuery(req.query.claimId);
    if (!claimId) {
      res.status(400).json({ error: "Provide claimId." });
      return;
    }
    const detail = await repository.getBrainLifecycleItemDetail(claimId);
    if (!detail) {
      res.status(404).json({ error: "No lifecycle item with that claim id." });
      return;
    }
    res.json(detail);
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// User transitions (certainty-grade source): close, cancel, or reopen an item
// with an optional note and no citation requirement. Applied through the same
// transactional writer as model resolutions — no second write path.
app.post("/api/brain/lifecycle/transition", async (req, res) => {
  try {
    const claimId = typeof req.body?.claimId === "string" ? req.body.claimId.trim() : "";
    const action = req.body?.action;
    if (!claimId || (action !== "fulfilled" && action !== "dismissed" && action !== "reopened")) {
      res.status(400).json({ error: "Provide claimId and an action of fulfilled, dismissed, or reopened." });
      return;
    }
    const note = typeof req.body?.note === "string" && req.body.note.trim() ? req.body.note.trim().slice(0, 500) : null;
    const result = await repository.applyBrainLifecycleTransitions([{ claimId, toStatus: action, note }], { source: "user" });
    broadcastArchiveChanged({ source: "manual", chatSourceIds: [], messageCount: 0, contactCount: 0 });
    res.json({ ok: true, applied: result.applied });
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Manual-first model closure sweep: judge sweep-due open items (or an explicit
// selection) against their deterministic candidate evidence. Rollup-class call
// — fixed high effort.
app.post("/api/brain/lifecycle/sweep", async (req, res) => {
  try {
    const { startBrainLifecycleSweep } = await import("./brain/runJob");
    const effortRaw = typeof req.body?.effort === "string" ? req.body.effort : null;
    const effort =
      effortRaw === "none" || effortRaw === "low" || effortRaw === "medium" || effortRaw === "high" || effortRaw === "xhigh" || effortRaw === "max"
        ? effortRaw
        : null;
    const maxModelCalls = clampNumber(req.body?.maxModelCalls, 1, 1000, 0);
    const maxTokens = clampNumber(req.body?.maxTokens, 1000, 100_000_000, 0);
    const claimIds = Array.isArray(req.body?.claimIds)
      ? (req.body.claimIds as unknown[]).filter((id): id is string => typeof id === "string").slice(0, 500)
      : null;
    const result = startBrainLifecycleSweep(
      repository,
      {
        chatSourceId: typeof req.body?.chatSourceId === "string" ? req.body.chatSourceId : null,
        claimIds: claimIds && claimIds.length > 0 ? claimIds : null,
        model: typeof req.body?.model === "string" ? req.body.model : null,
        effort,
        maxModelCalls: maxModelCalls > 0 ? maxModelCalls : null,
        maxTokens: maxTokens > 0 ? maxTokens : null
      },
      () => {
        broadcastArchiveChanged({ source: "manual", chatSourceIds: [], messageCount: 0, contactCount: 0 });
      }
    );
    if (!result.started) {
      res.status(409).json({ error: result.refusal ?? "The closure sweep could not start.", progress: result.progress });
      return;
    }
    res.json({ ok: true, progress: result.progress });
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// --- Semantic docs (semantic-rollups): list, detail, rollback, rollup run.
// Meaning lives server-side — the UI/CLI/MCP render the same DTOs.

app.get("/api/brain/docs", async (req, res) => {
  try {
    const kindRaw = stringQuery(req.query.kind);
    const kind = kindRaw === "entity" || kindRaw === "topic" || kindRaw === "chat" ? kindRaw : undefined;
    const viewRaw = stringQuery(req.query.view);
    const view =
      viewRaw === "pages" || viewRaw === "due" || viewRaw === "candidates" || viewRaw === "issues" || viewRaw === "all"
        ? viewRaw
        : undefined;
    const response = await repository.listBrainDocs({
      kind,
      view,
      limit: clampNumber(req.query.limit, 1, 2000, 200)
    });
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: publicErrorMessage(error) });
  }
});

// Doc ids contain a colon (entity:<slug>) — they travel as one path segment.
app.get("/api/brain/docs/:docId", async (req, res) => {
  try {
    const detail = await repository.getBrainDoc(String(req.params.docId));
    if (!detail) {
      res.status(404).json({ error: "No such doc (and no page-eligible node under that id)." });
      return;
    }
    res.json(detail);
  } catch (error) {
    res.status(500).json({ error: publicErrorMessage(error) });
  }
});

app.post("/api/brain/docs/:docId/rollback", async (req, res) => {
  try {
    // 0 is a MEANINGFUL target here (unroll to no page), so it cannot share a
    // sentinel with "absent" — parse it explicitly rather than via clampNumber.
    const raw = req.body?.toRevision;
    const parsed = typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 1_000_000 ? raw : null;
    const detail = await repository.rollbackBrainDoc(String(req.params.docId), parsed);
    // Re-render the restored page + overview deterministically.
    const { projectBrainDocs, projectBrainOverview } = await import("./brain/projection");
    await projectBrainDocs(repository, { docIds: [String(req.params.docId)] }).catch(() => undefined);
    await projectBrainOverview(repository).catch(() => undefined);
    broadcastArchiveChanged({ source: "manual", chatSourceIds: [], messageCount: 0, contactCount: 0 });
    res.json(detail);
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Manual-first semantic rollup run: consolidate one doc, a list, or the top-K
// due docs. Strong-tier judgment — fixed high effort unless overridden.
app.post("/api/brain/rollups/run", async (req, res) => {
  try {
    const { startBrainRollupRun } = await import("./brain/runJob");
    const effortRaw = typeof req.body?.effort === "string" ? req.body.effort : null;
    const effort =
      effortRaw === "none" || effortRaw === "low" || effortRaw === "medium" || effortRaw === "high" || effortRaw === "xhigh" || effortRaw === "max"
        ? effortRaw
        : null;
    const maxModelCalls = clampNumber(req.body?.maxModelCalls, 1, 1000, 0);
    const maxTokens = clampNumber(req.body?.maxTokens, 1000, 100_000_000, 0);
    const maxDocs = clampNumber(req.body?.maxDocs, 1, 200, 0);
    const docIds = Array.isArray(req.body?.docIds)
      ? (req.body.docIds as unknown[]).filter((id): id is string => typeof id === "string").slice(0, 200)
      : null;
    const result = startBrainRollupRun(
      repository,
      {
        docId: typeof req.body?.docId === "string" ? req.body.docId : null,
        nodeId: typeof req.body?.nodeId === "string" ? req.body.nodeId : null,
        docIds: docIds && docIds.length > 0 ? docIds : null,
        maxDocs: maxDocs > 0 ? maxDocs : null,
        model: typeof req.body?.model === "string" ? req.body.model : null,
        effort,
        maxModelCalls: maxModelCalls > 0 ? maxModelCalls : null,
        maxTokens: maxTokens > 0 ? maxTokens : null
      },
      () => {
        broadcastArchiveChanged({ source: "manual", chatSourceIds: [], messageCount: 0, contactCount: 0 });
      }
    );
    if (!result.started) {
      res.status(409).json({ error: result.refusal ?? "The rollup run could not start.", progress: result.progress });
      return;
    }
    res.json({ ok: true, progress: result.progress });
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Rebuild the deterministic vault projection (pages + overview). Zero model
// calls; idempotent; sweeps orphaned page files.
app.post("/api/brain/project", async (_req, res) => {
  try {
    const { rebuildBrainProjection } = await import("./brain/projection");
    res.json(await rebuildBrainProjection(repository));
  } catch (error) {
    res.status(500).json({ error: publicErrorMessage(error) });
  }
});

// Who "me" is: evidence, episodes, and new search indexing label the owner's
// messages with this name. Historical search rows update on the next reindex.
// `selfJids` (run console): additional numbers labelled as the owner with
// absolute precedence — omitted = unchanged, [] = cleared.
app.post("/api/brain/owner", async (req, res) => {
  try {
    const displayName = typeof req.body?.displayName === "string" ? req.body.displayName : null;
    await repository.setArchiveOwnerName(displayName);
    let selfIdentities = await repository.getArchiveOwnerSelfIdentities();
    if (Array.isArray(req.body?.selfJids)) {
      const inputs = (req.body.selfJids as unknown[]).filter((entry): entry is string => typeof entry === "string");
      selfIdentities = await repository.setArchiveOwnerSelfJids(inputs);
    }
    res.json({ ok: true, ownerName: await repository.getArchiveOwnerName(), selfIdentities });
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Self-number autocomplete (run console): plain substring matching over
// archived identities — every row carries the number's CURRENT resolved name
// so picking the wrong person is visible before saving. No inference.
app.get("/api/brain/owner/identity-suggestions", async (req, res) => {
  try {
    const query = stringQuery(req.query.q) ?? "";
    res.json(await repository.listOwnerIdentitySuggestions(query, clampNumber(req.query.limit, 1, 25, 12)));
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Provider control from the UI: opt-in/out, model selection, health probe.
app.post("/api/brain/provider", async (req, res) => {
  try {
    const { disableBrainProvider, enableBrainProvider, getBrainProviderStatus, probeBrainProvider, setBrainProviderModel } =
      await import("./brain/provider");
    const action = typeof req.body?.action === "string" ? req.body.action : "";
    const provider = req.body?.provider === "claude-cli" || req.body?.provider === "codex" ? req.body.provider : null;
    if ((action === "enable" || action === "set-model") && refuseInDemo(res)) {
      return;
    }
    if (action === "enable" && provider) {
      res.json({ ok: true, provider: enableBrainProvider(provider) });
    } else if (action === "disable") {
      res.json({ ok: true, provider: disableBrainProvider() });
    } else if (action === "set-model" && provider && typeof req.body?.model === "string") {
      res.json({ ok: true, provider: setBrainProviderModel(provider, req.body.model) });
    } else if (action === "probe") {
      const probe = await probeBrainProvider();
      res.json({ ok: probe.ok, provider: probe.status });
    } else if (action === "status" || action === "") {
      res.json({ ok: true, provider: getBrainProviderStatus() });
    } else {
      res.status(400).json({ error: "Unknown provider action." });
    }
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// --- Brain eval harness (design E3): eval executes inside the server process
// so the single-writer constraint is honored by construction; the CLI
// delegates here whenever the server is up. Zero model calls throughout. ---

// Golden set identity (or its absence, with the scaffold hint).
app.get("/api/brain/eval/golden", async (_req, res) => {
  try {
    const { goldenSetExists, goldenSetPath, loadGoldenSetInfo } = await import("./brain/eval");
    const filePath = goldenSetPath();
    try {
      res.json({ ok: true, path: filePath, exists: goldenSetExists(), info: loadGoldenSetInfo() });
    } catch (error) {
      // The file exists but doesn't validate — surface why instead of a 500.
      res.json({ ok: false, path: filePath, exists: goldenSetExists(), info: null, error: publicErrorMessage(error) });
    }
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.post("/api/brain/eval/golden/scaffold", async (_req, res) => {
  try {
    const { scaffoldGoldenSet } = await import("./brain/eval");
    res.json({ ok: true, info: scaffoldGoldenSet() });
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Run the golden set synchronously (~pure-SQL queries; the UI shows a busy
// state) and answer with the run, its resolved baseline, and the gate verdict.
app.post("/api/brain/eval/runs", async (req, res) => {
  try {
    const { computeEvalGate, resolveEvalBaseline, runBrainEval } = await import("./brain/eval");
    const notes = typeof req.body?.notes === "string" && req.body.notes.trim() ? req.body.notes.trim() : null;
    const baselineId = typeof req.body?.baselineId === "string" && req.body.baselineId.trim() ? req.body.baselineId.trim() : null;
    const run = await runBrainEval(repository, { notes });
    const baseline = await resolveEvalBaseline(repository, run, baselineId);
    res.json({ ok: true, run, baseline, gate: computeEvalGate(run, baseline) });
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/brain/eval/runs", async (req, res) => {
  try {
    res.json(
      await repository.listBrainEvalRuns({
        goldenHash: stringQuery(req.query.goldenHash) ?? undefined,
        limit: clampNumber(req.query.limit, 1, 100, 20)
      })
    );
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/brain/eval/runs/:id", async (req, res) => {
  try {
    const run = await repository.getBrainEvalRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: "No eval run with that id." });
      return;
    }
    res.json(run);
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Gate verdict for an existing run (default: the latest) vs a baseline
// (default: the most recent prior run with the same golden hash).
app.get("/api/brain/eval/gate", async (req, res) => {
  try {
    const { computeEvalGate, resolveEvalBaseline } = await import("./brain/eval");
    const runId = stringQuery(req.query.runId);
    const run = runId ? await repository.getBrainEvalRun(runId) : (await repository.listBrainEvalRuns({ limit: 1 }))[0] ?? null;
    if (!run) {
      res.status(404).json({ error: runId ? "No eval run with that id." : "No eval runs yet." });
      return;
    }
    const baseline = await resolveEvalBaseline(repository, run, stringQuery(req.query.baselineId));
    res.json({ ok: true, run, baseline, gate: computeEvalGate(run, baseline) });
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Deterministic stratified grading sample with cited message text resolved
// server-side (tombstones for deleted originals).
app.get("/api/brain/eval/grading-sample", async (req, res) => {
  try {
    res.json(
      await repository.listClaimsForGrading({
        perModel: clampNumber(req.query.perModel, 1, 200, 20),
        includeGraded: booleanQuery(req.query.includeGraded)
      })
    );
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// One-click grade; the client sends only {claimId, grade} — every stamp is
// denormalized server-side from the claim's episode.
app.post("/api/brain/eval/grades", async (req, res) => {
  try {
    const claimId = typeof req.body?.claimId === "string" ? req.body.claimId.trim() : "";
    const grade = req.body?.grade;
    if (!claimId || (grade !== "supported" && grade !== "partial" && grade !== "unsupported" && grade !== "unclear")) {
      res.status(400).json({ error: "A claimId and a grade of supported|partial|unsupported|unclear are required." });
      return;
    }
    res.json({ ok: true, grade: await repository.upsertBrainClaimGrade(claimId, grade) });
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/brain/eval/aggregates", async (_req, res) => {
  try {
    res.json(await repository.getBrainModelQualityAggregates());
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.post("/api/search/reindex", async (_req, res) => {
  try {
    const reindex = startSearchReindex(repository, () => {
      broadcastArchiveChanged({ source: "manual", chatSourceIds: [], messageCount: 0, contactCount: 0 });
    });
    res.json({ ok: true, reindex });
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Local-only media serving (the whole app binds to loopback). Streams original
// blobs with HTTP range support for audio/video scrubbing. Content-addressed
// blobs are immutable, so aggressive private caching is safe. No media paths
// or bytes are logged.
app.get("/api/media/assets/:id", async (req, res) => {
  try {
    const asset = await repository.getMediaAsset(Number(req.params.id));
    if (!asset) {
      res.status(404).json({ error: "Media asset was not found." });
      return;
    }
    const stat = await mediaBlobStore.stat(asset.storagePath);
    if (!stat) {
      res.status(404).json({ error: "Media bytes are not present in the local store." });
      return;
    }
    const totalSize = stat.byteSize;
    res.setHeader("Content-Type", asset.mimeType ?? "application/octet-stream");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.setHeader("ETag", `"${asset.sha256}"`);
    const range = parseRangeHeader(req.headers.range, totalSize);
    if (range) {
      res.status(206);
      res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${totalSize}`);
      res.setHeader("Content-Length", String(range.end - range.start + 1));
      mediaBlobStore.openStream(asset.storagePath, range).pipe(res);
      return;
    }
    res.setHeader("Content-Length", String(totalSize));
    mediaBlobStore.openStream(asset.storagePath).pipe(res);
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/media/assets/:id/thumbnail", async (req, res) => {
  try {
    const asset = await repository.getMediaAsset(Number(req.params.id));
    if (!asset?.thumbnail?.length) {
      res.status(404).json({ error: "No thumbnail is stored for this asset." });
      return;
    }
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.end(Buffer.from(asset.thumbnail));
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/messages/:id/link-preview-thumbnail", async (req, res) => {
  try {
    const thumbnail = await repository.getLinkPreviewThumbnail(Number(req.params.id));
    if (!thumbnail?.length) {
      res.status(404).json({ error: "No link preview thumbnail is stored for this message." });
      return;
    }
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.end(Buffer.from(thumbnail));
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/messages/:id/quoted-thumbnail", async (req, res) => {
  try {
    const thumbnail = await repository.getQuotedSnapshotThumbnail(Number(req.params.id));
    if (!thumbnail?.length) {
      res.status(404).json({ error: "No quoted-message thumbnail is stored for this message." });
      return;
    }
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.end(Buffer.from(thumbnail));
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/messages/:id/revisions", async (req, res) => {
  try {
    res.json(await repository.listMessageEditRevisions(Number(req.params.id)));
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Exact structured payloads are intentionally available only from this
// focused local-message route. Thread pagination, status, warnings, and
// diagnostics stay separately allowlisted and never receive this response.
app.get("/api/messages/:id/detail", async (req, res) => {
  try {
    const detail = await repository.getMessageDetail(Number(req.params.id));
    if (!detail) {
      res.status(404).json({ error: "Message was not found." });
      return;
    }
    res.json(detail);
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/messages/:id/vcards/:cardIndex/download", async (req, res) => {
  try {
    const download = await repository.getMessageVcardDownload(Number(req.params.id), Number(req.params.cardIndex));
    if (!download) {
      res.status(404).json({ error: "A downloadable contact card is not available." });
      return;
    }
    res.setHeader("Content-Type", "text/vcard; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${download.fileName.replace(/[\r\n"]/g, "")}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.end(download.content);
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Retry control for stuck media downloads (failed/expired with a descriptor
// still held); counts only in the response, never content.
app.post("/api/media/retry", async (_req, res) => {
  try {
    const requeued = await repository.retryStuckMediaDownloads();
    res.json({ ok: true, requeued, media: await repository.getMediaQueueSummary() });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

const distDir = path.resolve(__dirname, "../../dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  // SPA history fallback: any non-API path serves the app so client routes are
  // reload-safe. Use the `root` option (not an absolute path) so `send` only
  // dotfile-checks "index.html" — an absolute path whose directories include a
  // dot-segment (e.g. a checkout under `.claude/worktrees/…`) would otherwise be
  // rejected by send's default `dotfiles: "ignore"`.
  app.get(/.*/, (_req, res) => {
    res.sendFile("index.html", { root: distDir });
  });
}

// Correct stale connected/running state from a previous process before any
// client can read live status, and clear pre-rewrite wall-clock gap noise even
// when no live session can connect.
try {
  const reconciled = await repository.reconcileLiveState();
  if (reconciled.staleSessions || reconciled.staleRuns) {
    console.log(`Reconciled stale live state: ${reconciled.staleSessions} session(s), ${reconciled.staleRuns} run(s).`);
  }
  const orphanedBrainRuns = await repository.reconcileBrainRuns();
  if (orphanedBrainRuns > 0) {
    console.log(`[brain] marked ${orphanedBrainRuns} orphaned run(s) interrupted (watermarks make interruption safe).`);
  }
  // Startup catch-up audit: assimilation correctness must not depend on
  // schedules firing. Only auto mode enqueues (and drains) uncovered windows —
  // in manual mode dueness is derived live from watermarks, so nothing needs a
  // durable queue that would otherwise linger as stale pending work.
  if (config.brain.scheduler === "auto") {
    const { auditCatchup } = await import("./brain/scheduler");
    // After a restart every claimed-but-unfinished task is orphaned; reclaim
    // them all so a killed run resumes immediately, not after the stale window.
    const reclaimed = await repository.resetInFlightBrainTasks(0);
    if (reclaimed > 0) {
      console.log(`[brain] returned ${reclaimed} in-flight task(s) to pending after restart.`);
    }
    const catchup = await auditCatchup(repository);
    if (catchup.enqueued > 0) {
      console.log(`[brain] catch-up audit enqueued ${catchup.enqueued} episode task(s) across ${catchup.chats} chat(s) with a coverage gap.`);
    }
  }
  const legacyClosed = await closeLegacyWallClockGaps(repository);
  if (legacyClosed) {
    console.log(`Closed ${legacyClosed} legacy wall-clock live gap(s) superseded by evidence-based auditing.`);
  }
  // Recompute chat recency under the current visibility rules (fast, and keeps
  // archives created before rule changes correctly ordered).
  await repository.refreshChatStats();
  const clearedNames = await repository.clearIdentityDerivedChatNames();
  if (clearedNames) {
    console.log(`Cleared ${clearedNames} identity-derived chat name(s); they will resolve via contacts or the group-naming pass.`);
  }
  const noiseRemoved = await repository.removeProtocolNoiseMessages();
  if (noiseRemoved) {
    console.log(`Removed ${noiseRemoved} Signal-protocol transport envelope(s) archived as messages before normalization filtered them.`);
  }
} catch (error) {
  console.warn(`Live state reconciliation skipped: ${publicErrorMessage(error)}`);
}

app.listen(config.app.port, config.app.host, () => {
  console.log(`Wapp Brain listening on http://${config.app.host}:${config.app.port}`);
  void autoResumeLiveSync();
  void probeBrainProviderOnStartup();
  void backfillIdentityResolutionOnStartup();
  void autoStartSearchReindexOnStartup();
});

// A schema migration (or an interrupted build) can leave the search index
// marked needs_rebuild on an archive that already holds messages. Kick off the
// existing background reindex job automatically — same progress surface,
// console mirror, and failure reporting as the manual button — so search
// comes back without waiting for a user action. No-op on healthy archives.
async function autoStartSearchReindexOnStartup(): Promise<void> {
  try {
    const status = await repository.getSearchIndexStatus();
    if (status.state !== "needs_rebuild" || status.totalMessages === 0) {
      return;
    }
    console.log(
      `[search] index needs a rebuild (${status.totalMessages.toLocaleString()} messages) — starting the background build automatically`
    );
    startSearchReindex(repository, () => {
      broadcastArchiveChanged({ source: "manual", chatSourceIds: [], messageCount: 0, contactCount: 0 });
    });
  } catch (error) {
    console.warn(`Automatic search reindex start failed: ${publicErrorMessage(error)}`);
  }
}

// Episodes written before the identity-repair machinery existed may still refer
// to participants by number even though their contacts were saved since. Run the
// idempotent, bounded, model-free repair once at boot (non-blocking) so history
// catches up; a clean archive finds nothing and returns immediately.
async function backfillIdentityResolutionOnStartup(): Promise<void> {
  try {
    const result = await repository.backfillIdentityResolution();
    if (result.episodesRepaired > 0) {
      console.log(
        `[identity-repair] startup backfill repaired ${result.episodesRepaired} episode(s) ` +
          `(${result.tokensSubstituted} substitution(s), ${result.messagesRecomputed} message(s) reindexed)`
      );
    }
  } catch (error) {
    console.warn(`Identity-resolution backfill error: ${publicErrorMessage(error)}`);
  }
}

// A remote provider's health is only known once it has answered end-to-end.
// Fire the configured probe (non-blocking) at boot when a model provider is
// enabled with a session present, so a broken WSL bridge is a visible degraded
// state before the first run — not a surprise when a run is refused.
async function probeBrainProviderOnStartup(): Promise<void> {
  try {
    const { getBrainProviderStatus, probeBrainProvider } = await import("./brain/provider");
    const status = getBrainProviderStatus();
    if (!status.modelBacked || !status.enabled || status.sessionMissing) {
      return;
    }
    const probe = await probeBrainProvider();
    if (!probe.ok) {
      console.warn(`Brain provider startup probe failed: ${probe.status.health.lastError ?? probe.status.message}`);
    }
  } catch (error) {
    console.warn(`Brain provider startup probe error: ${publicErrorMessage(error)}`);
  }
}

async function autoResumeLiveSync(): Promise<void> {
  if (!config.live.autoResume) {
    return;
  }
  try {
    const options = liveOptionsFromConfig();
    if (!fs.existsSync(path.join(options.authDir, "creds.json"))) {
      return;
    }
    const live = await repository.getLiveStatus();
    const sessionStatus = live.session?.status ?? "not_configured";
    if (sessionStatus === "not_configured" || sessionStatus === "logged_out") {
      return;
    }
    // Never QR-churn in the background: if the stored credentials are corrupt
    // or unpaired (and the backup cannot restore them), surface a re-link
    // action instead of silently pretending to resume.
    if (!(await ensureUsableLiveCreds(options.authDir))) {
      await repository.upsertLiveSession({
        id: "default",
        status: "logged_out",
        clientName: options.clientName,
        lastError: "Stored linked-device credentials are missing or corrupted. Re-link WhatsApp to resume live sync."
      });
      console.warn("Live auto-resume skipped: stored credentials are unusable; re-link WhatsApp from the app.");
      return;
    }
    console.log("Auto-resuming live WhatsApp sync from existing linked-device credentials.");
    await startLiveMaintainer(null);
  } catch (error) {
    console.warn(`Live auto-resume failed: ${publicErrorMessage(error)}`);
  }
}

function stringQuery(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// Comma-separated list query param → trimmed non-empty strings (undefined when
// absent/empty), used by the lifecycle group include/exclude filters.
function csvQuery(value: unknown): string[] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : undefined;
}

function booleanQuery(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function optionalNumberQuery(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Single-range parser for media scrubbing ("bytes=start-end", open ends
// supported). Malformed or unsatisfiable ranges fall back to a full response.
function parseRangeHeader(header: string | undefined, totalSize: number): { start: number; end: number } | null {
  if (!header || totalSize <= 0) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) {
    return null;
  }
  let start: number;
  let end: number;
  if (match[1] === "") {
    // Suffix range: last N bytes.
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return null;
    }
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? totalSize - 1 : Number(match[2]);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= totalSize) {
    return null;
  }
  return { start, end: Math.min(end, totalSize - 1) };
}

function pickKind(value: unknown): PickKind {
  if (value === "backup-root" || value === "media" || value === "msgstore" || value === "wa") {
    return value;
  }
  throw new Error("Unsupported picker kind.");
}

async function startLiveMaintainer(phoneNumber: string | null): Promise<void> {
  if (activeMaintainer) {
    return;
  }
  const options = liveOptionsFromConfig();
  livePairing = {
    state: "starting",
    qrDataUrl: null,
    pairingCode: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    lastError: null
  };
  activeClient = new BaileysLiveWhatsAppClient({
    authDir: options.authDir,
    phoneNumber,
    readOnly: true
  });
  activeClient.onConnectionUpdate((update) => {
    livePairing = {
      ...livePairing,
      state:
        update.state === "pairing" ||
        update.state === "connected" ||
        update.state === "disconnected" ||
        update.state === "stopped" ||
        update.state === "error" ||
        update.state === "logged_out"
          ? update.state
          : "pairing",
      qrDataUrl: update.qrDataUrl ?? livePairing.qrDataUrl,
      pairingCode: update.pairingCode ?? livePairing.pairingCode,
      updatedAt: new Date().toISOString(),
      expiresAt: update.state === "pairing" ? new Date(Date.now() + 60_000).toISOString() : livePairing.expiresAt,
      lastError: update.lastError ?? null
    };
  });
  activeMaintainer = new LiveMaintainer(repository, activeClient, options, {
    onArchiveChanged: (event) => {
      broadcastArchiveChanged({
        source: "live",
        chatSourceIds: chatSourceIdsFromLiveEvent(event),
        messageCount: event.messages?.length ?? 0,
        contactCount: event.contacts?.length ?? 0
      });
    },
    onMediaChanged: (chatSourceIds) => {
      broadcastArchiveChanged({ source: "live", chatSourceIds, messageCount: 0, contactCount: 0 });
    },
    // Last recovery-tick pass: no-ops unless WAPP_BRAIN_SCHEDULER=auto. A
    // committed episode nudges open panels to refetch brain status live.
    runBrainPass: async () => {
      const { runBrainMaintenancePass } = await import("./brain/scheduler");
      await runBrainMaintenancePass(repository, {
        onEpisodesCommitted: () => broadcastArchiveChanged({ source: "live", chatSourceIds: [], messageCount: 0, contactCount: 0 })
      });
    }
  });
  void activeMaintainer.start().catch(async (error: unknown) => {
    livePairing = {
      ...livePairing,
      state: "error",
      updatedAt: new Date().toISOString(),
      lastError: publicErrorMessage(error)
    };
    await activeMaintainer?.fail(error);
    activeMaintainer = null;
    activeClient = null;
  });
}

async function stopActiveMaintainer(): Promise<void> {
  if (!activeMaintainer) {
    activeClient = null;
    return;
  }
  const maintainer = activeMaintainer;
  activeMaintainer = null;
  activeClient = null;
  await maintainer.stop();
  livePairing = {
    ...livePairing,
    state: "stopped",
    updatedAt: new Date().toISOString()
  };
}

function numberBody(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function broadcastArchiveChanged(input: Omit<ArchiveChangeEvent, "id" | "type" | "updatedAt">): void {
  const event: ArchiveChangeEvent = {
    id: ++archiveEventId,
    type: "archive-updated",
    updatedAt: new Date().toISOString(),
    ...input,
    chatSourceIds: [...new Set(input.chatSourceIds)]
  };
  const payload = `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of archiveEventClients) {
    client.write(payload);
  }
}

function chatSourceIdsFromLiveEvent(event: LiveMessageEvent): string[] {
  return [
    ...(event.chats ?? []).map((chat) => chat.sourceChatId),
    ...(event.messages ?? []).map((message) => message.chatSourceId),
    ...(event.updates ?? []).map((update) => update.chatSourceId),
    ...(event.contacts ?? []).map((contact) => contact.sourceJid)
  ].filter(Boolean);
}

function idlePairing(): LivePairingSummary {
  return {
    state: "idle",
    qrDataUrl: null,
    pairingCode: null,
    startedAt: null,
    updatedAt: null,
    expiresAt: null,
    lastError: null
  };
}
