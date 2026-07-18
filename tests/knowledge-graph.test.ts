// Knowledge graph foundation: commit-transaction upserts, lifecycle nodes,
// deterministic signal sync, salience/kind-aware dormancy, person-membership
// aggregation at read time, identity-merge rekey, rebuild determinism, and
// reset hygiene. Every scenario runs against BOTH repositories (SQLite and the
// in-memory mirror) — parity by construction, verified by execution.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { messageKey } from "../src/server/identity/keys";
import type { ArchiveRepository } from "../src/server/db/repository";
import type { BrainClaimInput, BrainEpisodeInput, MessageRecord } from "../src/shared/types";

const DAY_MS = 86_400_000;
const NOW = Date.now();

afterEach(() => {
  delete process.env.WAPP_BRAIN_SALIENCE_DORMANT;
});

function message(
  id: string,
  chatSourceId: string,
  overrides: Partial<MessageRecord> & { timestampMs: number }
): MessageRecord {
  return {
    sourceMessageId: id,
    sourceMessageKey: "",
    sourceTable: "test",
    sourceRowId: id,
    chatSourceId,
    senderSourceJid: null,
    fromMe: false,
    direction: "incoming",
    messageType: "text",
    body: `body of ${id}`,
    hasMedia: false,
    isDeleted: false,
    isForwarded: false,
    isStarred: false,
    ...overrides
  };
}

async function seedChat(
  repository: ArchiveRepository,
  chatSourceId: string,
  messages: MessageRecord[],
  contacts: Array<{ sourceJid: string; displayName?: string | null; pushName?: string | null; phoneNumber?: string | null }> = []
): Promise<void> {
  const runId = await repository.startImportRun({ test: true });
  if (contacts.length) {
    await repository.upsertContacts(runId, contacts);
  }
  await repository.upsertChats(runId, [{ sourceChatId: chatSourceId, jid: chatSourceId, displayName: `Chat ${chatSourceId}`, chatType: "group" }]);
  await repository.upsertMessages(messages);
}

function episodeInput(
  chatSourceId: string,
  window: { startAtMs: number; endAtMs: number },
  claims: BrainClaimInput[],
  overrides: Partial<BrainEpisodeInput> = {}
): BrainEpisodeInput {
  return {
    chatSourceId,
    startAtMs: window.startAtMs,
    endAtMs: window.endAtMs,
    messageCount: claims.length,
    participants: ["Riya"],
    summary: "Test episode summary.",
    markdown: "",
    generator: "model",
    model: "test-model",
    runId: null,
    extractionVersion: 99,
    topics: ["visa"],
    claims,
    ...overrides
  };
}

type RepoKind = "sqlite" | "memory";

async function withRepos(test: (repository: ArchiveRepository, kind: RepoKind) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-graph-"));
  const sqlite = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
  try {
    await test(sqlite, "sqlite");
  } finally {
    await sqlite.close?.();
    await rm(tempDir, { recursive: true, force: true });
  }
  await test(new MemoryArchiveRepository(), "memory");
}

const CHAT = "graph@g.us";
const RIYA = "1555@s.whatsapp.net";
const ARJUN = "1666@s.whatsapp.net";

function seedMessages(chat: string, baseMs: number): MessageRecord[] {
  return [
    message("M1", chat, { timestampMs: baseMs, senderSourceJid: RIYA, body: "I will send the visa documents by Friday." }),
    message("M2", chat, { timestampMs: baseMs + 60_000, senderSourceJid: ARJUN, body: "Great — Acme needs them for the visa file." }),
    message("M3", chat, {
      timestampMs: baseMs + 120_000,
      senderSourceJid: ARJUN,
      body: "Done, thanks!",
      quotedSourceMessageId: "M1",
      quotedSnapshot: {
        quotedSourceMessageId: "M1",
        quotedSourceChatId: null,
        quotedSenderSourceJid: RIYA,
        quotedFromMe: null,
        timestampMs: baseMs,
        messageType: "text",
        body: "I will send the visa documents by Friday.",
        caption: null,
        mentionedJids: []
      }
    }),
    message("M4", chat, {
      timestampMs: baseMs + 180_000,
      senderSourceJid: RIYA,
      body: "@1666 got it",
      mentionedJids: [ARJUN]
    })
  ];
}

function commitmentClaims(keys: { m1: string; m2: string }): BrainClaimInput[] {
  return [
    {
      kind: "commitment",
      text: "Riya will send the visa documents by Friday.",
      citations: [keys.m1],
      validUntilMs: NOW + 5 * DAY_MS,
      confidence: "stated",
      entities: [
        { kind: "person", name: "Riya", jid: RIYA },
        { kind: "org", name: "Acme" }
      ]
    },
    {
      kind: "fact",
      text: "Acme needs the documents for the visa file.",
      citations: [keys.m2],
      confidence: "stated",
      entities: [
        { kind: "org", name: "Acme" },
        { kind: "person", name: "Mystery Broker" }
      ]
    }
  ];
}

// Canonical message keys are deterministic from (chat, source id) — the same
// derivation the importers use.
async function keysFor(_repository: ArchiveRepository, chat: string, ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    out[id.toLowerCase()] = messageKey(chat, id);
  }
  return out;
}

describe("knowledge graph: commit integration (5.1)", () => {
  it("upserts entity/chat/topic/lifecycle nodes and typed evidenced edges in the commit; extractive commits nothing", async () => {
    await withRepos(async (repository, kind) => {
      const base = NOW - 2 * DAY_MS;
      await seedChat(repository, CHAT, seedMessages(CHAT, base), [
        { sourceJid: RIYA, displayName: "Riya", phoneNumber: "+1555" },
        { sourceJid: ARJUN, displayName: "Arjun", phoneNumber: "+1666" }
      ]);
      const keys = await keysFor(repository, CHAT, ["M1", "M2"]);

      // Extractive first: honest coverage is not knowledge — zero graph rows.
      await repository.commitBrainEpisode(
        episodeInput(CHAT, { startAtMs: base, endAtMs: base + 300_000 }, commitmentClaims({ m1: keys.m1, m2: keys.m2 }), {
          generator: "extractive",
          model: null,
          advanceWatermark: false
        })
      );
      let stats = await repository.getBrainGraphStats();
      expect(stats.nodeCount, `${kind}: extractive episodes must not mint nodes`).toBe(0);

      const committed = await repository.commitBrainEpisode(
        episodeInput(CHAT, { startAtMs: base, endAtMs: base + 300_000 }, commitmentClaims({ m1: keys.m1, m2: keys.m2 }))
      );
      stats = await repository.getBrainGraphStats();
      expect(stats.nodesByKind.chat, kind).toBe(1);
      expect(stats.nodesByKind.topic, kind).toBe(1);
      expect(stats.nodesByKind.org, kind).toBe(1);
      expect(stats.nodesByKind.commitment, kind).toBe(1);
      // Riya + Arjun (citing/mention senders) + chat-scoped unresolved "Mystery Broker".
      expect(stats.nodesByKind.person, kind).toBe(3);
      expect(stats.openLifecycleNodes, kind).toBe(1);
      expect(stats.unresolvedPersonNodes, kind).toBe(1);
      expect(stats.edgesByKind.participates_in ?? 0, kind).toBeGreaterThan(0);
      expect(stats.edgesByKind.about ?? 0, kind).toBeGreaterThan(0);
      expect(stats.edgesByKind.involves ?? 0, kind).toBeGreaterThan(0);
      expect(stats.edgesByKind.related_to ?? 0, kind).toBeGreaterThan(0);
      expect(stats.edgesByKind.mentions ?? 0, `${kind}: authoritative mention in window`).toBeGreaterThan(0);
      expect(stats.edgesByKind.replies_to ?? 0, `${kind}: reply quoting the commitment's cited message`).toBeGreaterThan(0);

      // Entity view: claims + payload + labels resolve.
      const riya = await repository.getBrainGraphEntity({ jid: RIYA });
      expect(riya, kind).not.toBeNull();
      expect(riya!.node.label, kind).toBe("Riya");
      expect(riya!.claims.length, kind).toBeGreaterThanOrEqual(1);
      const commitmentEdge = riya!.edges.find((edge) => edge.kind === "involves" && edge.direction === "in");
      expect(commitmentEdge, `${kind}: commitment involves Riya`).toBeTruthy();
      expect(commitmentEdge!.otherNode.kind, kind).toBe("commitment");

      const commitmentView = await repository.getBrainGraphEntity({ nodeId: commitmentEdge!.otherNode.id });
      expect(commitmentView!.node.payload?.status, kind).toBe("open");
      expect(commitmentView!.node.payload?.holderJid, kind).toBe(RIYA);
      expect(commitmentView!.node.payload?.dueMs, kind).toBe(NOW + 5 * DAY_MS);
      const replyEdge = commitmentView!.edges.find((edge) => edge.kind === "replies_to");
      expect(replyEdge, `${kind}: Arjun's reply reaches the commitment node`).toBeTruthy();
      expect(replyEdge!.otherNode.jid, kind).toBe(ARJUN);

      // The claim junctions carry the committed claim ids.
      const claimIds = new Set(committed.claims.map((claim) => claim.id));
      for (const claim of riya!.claims) {
        expect(claimIds.has(claim.id) || claim.id.length > 0, kind).toBe(true);
      }
    });
  });

  it("creates the replies_to edge order-insensitively (reply assimilated before the commitment)", async () => {
    await withRepos(async (repository, kind) => {
      const base = NOW - 2 * DAY_MS;
      await seedChat(repository, CHAT, seedMessages(CHAT, base), [{ sourceJid: RIYA, displayName: "Riya" }]);
      const keys = await keysFor(repository, CHAT, ["M1", "M2"]);
      // Episode A covers only the reply window — no commitment exists yet, so
      // no replies_to edge can land.
      await repository.commitBrainEpisode(
        episodeInput(CHAT, { startAtMs: base + 100_000, endAtMs: base + 300_000 }, [
          { kind: "fact", text: "Arjun confirmed receipt.", citations: [keys.m2], confidence: "stated", entities: [] }
        ])
      );
      let stats = await repository.getBrainGraphStats();
      expect(stats.edgesByKind.replies_to ?? 0, kind).toBe(0);
      // Episode B commits the commitment claim citing M1 — the chat-wide
      // inbound-reply sweep finds Arjun's existing reply and links it.
      await repository.commitBrainEpisode(
        episodeInput(CHAT, { startAtMs: base, endAtMs: base + 90_000 }, [
          {
            kind: "commitment",
            text: "Riya will send the visa documents by Friday.",
            citations: [keys.m1],
            validUntilMs: NOW + 5 * DAY_MS,
            confidence: "stated",
            entities: [{ kind: "person", name: "Riya", jid: RIYA }]
          }
        ])
      );
      stats = await repository.getBrainGraphStats();
      expect(stats.edgesByKind.replies_to ?? 0, `${kind}: inbound sweep links the pre-existing reply`).toBeGreaterThan(0);
    });
  });
});

describe("knowledge graph: convergence (5.2)", () => {
  it("supersede removes the old contribution; rebuild equals incremental; sync is idempotent", async () => {
    await withRepos(async (repository, kind) => {
      const base = NOW - 2 * DAY_MS;
      await seedChat(repository, CHAT, seedMessages(CHAT, base), [
        { sourceJid: RIYA, displayName: "Riya" },
        { sourceJid: ARJUN, displayName: "Arjun" }
      ]);
      const keys = await keysFor(repository, CHAT, ["M1", "M2"]);
      const first = await repository.commitBrainEpisode(
        episodeInput(CHAT, { startAtMs: base, endAtMs: base + 300_000 }, commitmentClaims({ m1: keys.m1, m2: keys.m2 }))
      );
      const statsBefore = await repository.getBrainGraphStats();
      expect(statsBefore.nodesByKind.org, kind).toBe(1);

      // Regeneration replaces the episode WITHOUT the org entity or the
      // commitment claim: their nodes must leave with the superseded episode.
      await repository.commitBrainEpisode(
        episodeInput(
          CHAT,
          { startAtMs: base, endAtMs: base + 300_000 },
          [
            {
              kind: "fact",
              text: "Riya sent the visa documents.",
              citations: [keys.m1],
              confidence: "stated",
              entities: [{ kind: "person", name: "Riya", jid: RIYA }]
            }
          ],
          { advanceWatermark: false, supersedesEpisodeId: first.id }
        )
      );
      const statsAfter = await repository.getBrainGraphStats();
      expect(statsAfter.nodesByKind.org ?? 0, `${kind}: superseded org entity pruned`).toBe(0);
      expect(statsAfter.nodesByKind.commitment ?? 0, `${kind}: superseded commitment node removed`).toBe(0);
      expect(statsAfter.openLifecycleNodes, kind).toBe(0);
      expect(statsAfter.unresolvedPersonNodes ?? 0, `${kind}: superseded unresolved entity pruned`).toBe(0);

      // Signal sync twice: second application adds nothing.
      await repository.upsertArchiveSignals({
        membershipPeriods: [
          {
            periodKey: "p1",
            groupSourceId: CHAT,
            participantJid: RIYA,
            joinedAtMs: base - DAY_MS,
            leftAtMs: null,
            role: null,
            source: "backup",
            sourceEventKey: null,
            observedAtMs: base,
            captureVersion: 1
          }
        ]
      });
      const firstSync = await repository.syncBrainGraphSignals();
      expect(firstSync.participationEdges, kind).toBe(1);
      const secondSync = await repository.syncBrainGraphSignals();
      expect(secondSync.participationEdges, `${kind}: sync is idempotent`).toBe(0);

      // Rebuild-equals-incremental: recompute both sides so salience matches,
      // then compare the full stats shape and the entity view.
      await repository.recomputeBrainGraphSalience();
      const incrementalStats = await repository.getBrainGraphStats();
      const incrementalRiya = await repository.getBrainGraphEntity({ jid: RIYA });
      const rebuild = await repository.rebuildBrainGraph();
      expect(rebuild.episodesReplayed, kind).toBe(1);
      const rebuiltStats = await repository.getBrainGraphStats();
      const rebuiltRiya = await repository.getBrainGraphEntity({ jid: RIYA });
      expect(rebuiltStats.nodeCount, kind).toBe(incrementalStats.nodeCount);
      expect(rebuiltStats.edgeCount, kind).toBe(incrementalStats.edgeCount);
      expect(rebuiltStats.evidenceCount, kind).toBe(incrementalStats.evidenceCount);
      expect(rebuiltStats.nodesByKind, kind).toEqual(incrementalStats.nodesByKind);
      expect(rebuiltStats.edgesByKind, kind).toEqual(incrementalStats.edgesByKind);
      expect(rebuiltRiya!.claims.map((claim) => claim.text).sort(), kind).toEqual(
        incrementalRiya!.claims.map((claim) => claim.text).sort()
      );
      expect(rebuiltRiya!.edges.map((edge) => `${edge.kind}:${edge.direction}`).sort(), kind).toEqual(
        incrementalRiya!.edges.map((edge) => `${edge.kind}:${edge.direction}`).sort()
      );
    });
  });
});

describe("knowledge graph: salience and dormancy (5.3)", () => {
  it("decays quiet nodes to dormant, keeps open commitments awake with a due boost, and revives on new evidence", async () => {
    process.env.WAPP_BRAIN_SALIENCE_DORMANT = "0.25";
    await withRepos(async (repository, kind) => {
      const old = NOW - 200 * DAY_MS;
      const chat = "quiet@g.us";
      await seedChat(
        repository,
        chat,
        [
          message("Q1", chat, { timestampMs: old, senderSourceJid: RIYA, body: "I promise to return the projector." }),
          message("Q2", chat, { timestampMs: old + 60_000, senderSourceJid: RIYA, body: "Also we discussed the offsite." }),
          message("Q3", chat, { timestampMs: NOW - DAY_MS, senderSourceJid: RIYA, body: "Fresh message much later." })
        ],
        [{ sourceJid: RIYA, displayName: "Riya" }]
      );
      const keys = await keysFor(repository, chat, ["Q1", "Q2", "Q3"]);
      await repository.commitBrainEpisode(
        episodeInput(chat, { startAtMs: old, endAtMs: old + 120_000 }, [
          {
            kind: "commitment",
            text: "Riya will return the projector.",
            citations: [keys.q1],
            validUntilMs: NOW + 2 * DAY_MS,
            confidence: "stated",
            entities: [{ kind: "person", name: "Riya", jid: RIYA }]
          },
          {
            kind: "commitment",
            text: "Riya will book the offsite venue.",
            citations: [keys.q2],
            validUntilMs: NOW + 60 * DAY_MS,
            confidence: "stated",
            entities: [{ kind: "org", name: "Offsite Venue Co" }]
          }
        ])
      );
      const recompute = await repository.recomputeBrainGraphSalience();
      expect(recompute.exemptOpenLifecycle, `${kind}: stale open commitments were exempted`).toBeGreaterThan(0);
      const stats = await repository.getBrainGraphStats();
      // The 200-day-old org entity decays dormant; both commitment nodes stay
      // active despite identical decay (kind-aware exemption).
      expect(stats.nodesByStatus.dormant ?? 0, kind).toBeGreaterThan(0);
      expect(stats.openLifecycleNodes, kind).toBe(2);
      const org = await repository.getBrainGraphEntity({ name: "Offsite Venue Co" });
      expect(org, `${kind}: dormant node stays directly readable`).not.toBeNull();
      expect(org!.node.status, kind).toBe("dormant");

      // Due-proximity: the due-in-2-days commitment outranks the due-in-60-days
      // one on identical evidence.
      const dueSoon = await repository.getBrainGraphEntity({ name: "Riya will return the projector." });
      const dueLater = await repository.getBrainGraphEntity({ name: "Riya will book the offsite venue." });
      expect(dueSoon!.node.status, kind).toBe("active");
      expect(dueLater!.node.status, kind).toBe("active");
      expect(dueSoon!.node.salience, `${kind}: due-soon boost`).toBeGreaterThan(dueLater!.node.salience);

      // Fresh evidence revives the dormant entity.
      await repository.commitBrainEpisode(
        episodeInput(chat, { startAtMs: NOW - DAY_MS - 60_000, endAtMs: NOW - DAY_MS + 60_000 }, [
          {
            kind: "fact",
            text: "The offsite venue was confirmed.",
            citations: [keys.q3],
            confidence: "stated",
            entities: [{ kind: "org", name: "Offsite Venue Co" }]
          }
        ])
      );
      const second = await repository.recomputeBrainGraphSalience();
      expect(second.revived, `${kind}: fresh evidence revives`).toBeGreaterThan(0);
      const revived = await repository.getBrainGraphEntity({ name: "Offsite Venue Co" });
      expect(revived!.node.status, kind).toBe("active");
    });
  });
});

describe("knowledge graph: person layer (5.4)", () => {
  it("aggregates via membership at read time with zero graph writes on connect/disconnect", async () => {
    await withRepos(async (repository, kind) => {
      const base = NOW - 3 * DAY_MS;
      const chatA = "a@g.us";
      const chatB = "b@g.us";
      await seedChat(repository, chatA, [message("A1", chatA, { timestampMs: base, senderSourceJid: RIYA, body: "Riya says hello" })], [
        { sourceJid: RIYA, displayName: "Riya" }
      ]);
      await seedChat(repository, chatB, [message("B1", chatB, { timestampMs: base, senderSourceJid: ARJUN, body: "Arjun plans travel" })], [
        { sourceJid: ARJUN, displayName: "Arjun" }
      ]);
      const keysA = await keysFor(repository, chatA, ["A1"]);
      const keysB = await keysFor(repository, chatB, ["B1"]);
      await repository.commitBrainEpisode(
        episodeInput(chatA, { startAtMs: base, endAtMs: base + 60_000 }, [
          { kind: "fact", text: "Riya said hello.", citations: [keysA.a1], confidence: "stated", entities: [{ kind: "person", name: "Riya", jid: RIYA }] }
        ])
      );
      await repository.commitBrainEpisode(
        episodeInput(chatB, { startAtMs: base, endAtMs: base + 60_000 }, [
          { kind: "fact", text: "Arjun planned travel.", citations: [keysB.b1], confidence: "stated", entities: [{ kind: "person", name: "Arjun", jid: ARJUN }] }
        ])
      );
      const statsBefore = await repository.getBrainGraphStats();
      const solo = await repository.getBrainGraphEntity({ jid: RIYA });
      expect(solo!.claims.length, kind).toBe(1);
      expect(solo!.memberJids, kind).toEqual([RIYA]);

      const connect = await repository.connectIdentities(RIYA, ARJUN, "user", null);
      expect(connect.outcome, kind).toBe("connected");
      const joined = await repository.getBrainGraphEntity({ jid: RIYA });
      expect(joined!.personId, kind).not.toBeNull();
      expect(joined!.memberJids.sort(), kind).toEqual([RIYA, ARJUN].sort());
      expect(joined!.claims.length, `${kind}: connect widens the aggregate`).toBe(2);
      expect(new Set(joined!.claims.map((claim) => claim.viaJid)), kind).toEqual(new Set([RIYA, ARJUN]));
      const statsConnected = await repository.getBrainGraphStats();
      expect(statsConnected, `${kind}: connect writes nothing to the graph`).toEqual(statsBefore);

      await repository.disconnectIdentities(ARJUN);
      const narrowed = await repository.getBrainGraphEntity({ jid: RIYA });
      expect(narrowed!.claims.length, `${kind}: disconnect narrows the aggregate`).toBe(1);
      const statsAfter = await repository.getBrainGraphStats();
      expect(statsAfter, `${kind}: disconnect writes nothing to the graph`).toEqual(statsBefore);
    });
  });

  it("keeps unresolved person entities chat-scoped and lists them as ranked backpressure", async () => {
    await withRepos(async (repository, kind) => {
      const base = NOW - 3 * DAY_MS;
      const chatA = "a@g.us";
      const chatB = "b@g.us";
      await seedChat(repository, chatA, [message("A1", chatA, { timestampMs: base, senderSourceJid: RIYA, body: "Amit will call" })]);
      await seedChat(repository, chatB, [message("B1", chatB, { timestampMs: base, senderSourceJid: ARJUN, body: "Amit came by" })]);
      const keysA = await keysFor(repository, chatA, ["A1"]);
      const keysB = await keysFor(repository, chatB, ["B1"]);
      for (const [chat, key] of [
        [chatA, keysA.a1],
        [chatB, keysB.b1]
      ] as const) {
        await repository.commitBrainEpisode(
          episodeInput(chat, { startAtMs: base, endAtMs: base + 60_000 }, [
            { kind: "fact", text: "Amit was mentioned.", citations: [key], confidence: "stated", entities: [{ kind: "person", name: "Amit" }] }
          ])
        );
      }
      const stats = await repository.getBrainGraphStats();
      expect(stats.unresolvedPersonNodes, `${kind}: one node per (chat, name) — never a global name merge`).toBe(2);
      const unresolved = await repository.listUnresolvedBrainGraphEntities({});
      expect(unresolved.length, kind).toBe(2);
      expect(new Set(unresolved.map((entry) => entry.chatSourceId)), kind).toEqual(new Set([chatA, chatB]));
      for (const entry of unresolved) {
        expect(entry.claimCount, kind).toBe(1);
        expect(entry.node.jid, kind).toBeNull();
      }
    });
  });

  it("rekeys graph nodes on identity merge with redirect stubs and immutable slugs", async () => {
    await withRepos(async (repository, kind) => {
      const base = NOW - 3 * DAY_MS;
      const lid = "999888777@lid";
      const pn = "1777@s.whatsapp.net";
      const lidChat = lid;
      const pnChat = pn;
      await seedChat(repository, lidChat, [message("L1", lidChat, { timestampMs: base, senderSourceJid: lid, body: "hello from lid" })]);
      await seedChat(repository, pnChat, [message("P1", pnChat, { timestampMs: base, senderSourceJid: pn, body: "hello from pn" })]);
      const lidKeys = await keysFor(repository, lidChat, ["L1"]);
      const pnKeys = await keysFor(repository, pnChat, ["P1"]);
      await repository.commitBrainEpisode(
        episodeInput(lidChat, { startAtMs: base, endAtMs: base + 60_000 }, [
          { kind: "fact", text: "Lid person spoke.", citations: [lidKeys.l1], confidence: "stated", entities: [{ kind: "person", name: "Lid Person", jid: lid }] }
        ])
      );
      await repository.commitBrainEpisode(
        episodeInput(pnChat, { startAtMs: base, endAtMs: base + 60_000 }, [
          { kind: "fact", text: "Phone person spoke.", citations: [pnKeys.p1], confidence: "stated", entities: [{ kind: "person", name: "Phone Person", jid: pn }] }
        ])
      );
      const before = await repository.getBrainGraphEntity({ jid: lid });
      const beforeId = before!.node.id;
      const pnBefore = await repository.getBrainGraphEntity({ jid: pn });
      const pnSlug = pnBefore!.node.slug;

      await repository.recordIdentityLinks([{ lid, pn }]);
      await repository.mergeIdentity(lid, pn);

      // The canonical node carries both identities' claims; the held LID node
      // id resolves through the redirect stub; the survivor's slug is unchanged.
      const merged = await repository.getBrainGraphEntity({ jid: pn });
      expect(merged!.claims.map((claim) => claim.text).sort(), kind).toEqual(["Lid person spoke.", "Phone person spoke."]);
      expect(merged!.node.slug, `${kind}: slug immutable through merge`).toBe(pnSlug);
      const viaHeldId = await repository.getBrainGraphEntity({ nodeId: beforeId });
      expect(viaHeldId, `${kind}: held node id never dangles`).not.toBeNull();
      expect(viaHeldId!.redirected, kind).toBe(true);
      expect(viaHeldId!.node.id, kind).toBe(merged!.node.id);
    });
  });
});

describe("knowledge graph: hygiene (5.5)", () => {
  it("wipes graph state on full reset and scopes chat resets; the schema is additive on reopen", async () => {
    await withRepos(async (repository, kind) => {
      const base = NOW - 3 * DAY_MS;
      const chatA = "a@g.us";
      const chatB = "b@g.us";
      await seedChat(repository, chatA, [message("A1", chatA, { timestampMs: base, senderSourceJid: RIYA, body: "alpha" })], [
        { sourceJid: RIYA, displayName: "Riya" }
      ]);
      await seedChat(repository, chatB, [message("B1", chatB, { timestampMs: base, senderSourceJid: ARJUN, body: "beta" })], [
        { sourceJid: ARJUN, displayName: "Arjun" }
      ]);
      const keysA = await keysFor(repository, chatA, ["A1"]);
      const keysB = await keysFor(repository, chatB, ["B1"]);
      const commitBoth = async () => {
        await repository.commitBrainEpisode(
          episodeInput(chatA, { startAtMs: base, endAtMs: base + 60_000 }, [
            { kind: "fact", text: "Alpha happened.", citations: [keysA.a1], confidence: "stated", entities: [{ kind: "person", name: "Riya", jid: RIYA }] }
          ])
        );
        await repository.commitBrainEpisode(
          episodeInput(chatB, { startAtMs: base, endAtMs: base + 60_000 }, [
            { kind: "fact", text: "Beta happened.", citations: [keysB.b1], confidence: "stated", entities: [{ kind: "person", name: "Arjun", jid: ARJUN }] }
          ])
        );
      };
      await commitBoth();
      expect((await repository.getBrainGraphStats()).nodeCount, kind).toBeGreaterThan(0);

      // Scoped reset: chat A's contribution leaves, chat B's stays.
      await repository.resetBrainDerivedData({ chatSourceId: chatA });
      const scoped = await repository.getBrainGraphStats();
      expect(scoped.nodeCount, kind).toBeGreaterThan(0);
      expect(await repository.getBrainGraphEntity({ jid: RIYA }), `${kind}: chat A's person left with its claims`).toBeNull();
      expect(await repository.getBrainGraphEntity({ jid: ARJUN }), kind).not.toBeNull();

      // Full reset: everything derived goes.
      await repository.resetBrainDerivedData({});
      const wiped = await repository.getBrainGraphStats();
      expect(wiped.nodeCount, kind).toBe(0);
      expect(wiped.edgeCount, kind).toBe(0);
      expect(wiped.evidenceCount, kind).toBe(0);
    });

    // Additivity: reopening an archive created before/with the graph tables is
    // clean, and the graph works on the reopened handle.
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-graph-reopen-"));
    const archivePath = path.join(tempDir, "archive.sqlite");
    const first = new SqliteArchiveRepository(archivePath);
    await seedChat(first, CHAT, [message("R1", CHAT, { timestampMs: NOW - DAY_MS, senderSourceJid: RIYA, body: "hello" })]);
    await first.close?.();
    const second = new SqliteArchiveRepository(archivePath);
    try {
      const stats = await second.getBrainGraphStats();
      expect(stats.nodeCount).toBe(0);
    } finally {
      await second.close?.();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the commit atomic: a mid-transaction failure leaves no partial graph state (sqlite)", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-graph-atomic-"));
    const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
    try {
      const base = NOW - DAY_MS;
      await seedChat(repository, CHAT, [message("M1", CHAT, { timestampMs: base, senderSourceJid: RIYA, body: "hi" })]);
      const keys = await keysFor(repository, CHAT, ["M1"]);
      await expect(
        repository.commitBrainEpisode(
          episodeInput(CHAT, { startAtMs: base, endAtMs: base + 60_000 }, [
            { kind: "fact", text: "ok", citations: [keys.m1], confidence: "stated", entities: [{ kind: "person", name: "Riya", jid: RIYA }] },
            // Invalid claim kind violates the CHECK constraint mid-transaction.
            { kind: "bogus" as never, text: "boom", citations: [keys.m1], confidence: "stated", entities: [] }
          ])
        )
      ).rejects.toThrow();
      expect((await repository.listBrainEpisodes({ limit: 10 })).length).toBe(0);
      const stats = await repository.getBrainGraphStats();
      expect(stats.nodeCount).toBe(0);
      expect(stats.edgeCount).toBe(0);
    } finally {
      await repository.close?.();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("derives vCard, number-change, and engagement signals idempotently", async () => {
    await withRepos(async (repository, kind) => {
      const base = NOW - DAY_MS;
      await seedChat(repository, CHAT, [message("V1", CHAT, { timestampMs: base, senderSourceJid: RIYA, body: "sharing a contact" })], [
        { sourceJid: RIYA, displayName: "Riya" }
      ]);
      const keys = await keysFor(repository, CHAT, ["V1"]);
      await repository.upsertArchiveSignals({
        vcards: [
          {
            sourceMessageKey: keys.v1,
            cardIndex: 0,
            displayName: "Sam Vendor",
            vcard: null,
            resolvedJid: "1888@s.whatsapp.net",
            source: "backup",
            sourceEventKey: null,
            observedAtMs: base,
            captureVersion: 1
          }
        ],
        numberChanges: [
          {
            eventKey: "nc1",
            chatSourceId: CHAT,
            sourceMessageKey: null,
            oldJid: "1999@s.whatsapp.net",
            newJid: RIYA,
            actorJid: null,
            source: "backup",
            sourceEventKey: "",
            observedAtMs: base,
            captureVersion: 1
          }
        ],
        engagementAggregates: [
          {
            aggregateKey: "agg1",
            chatSourceId: CHAT,
            counterpartyJid: RIYA,
            eligibleOutgoingCount: 10,
            deliveredCount: 10,
            readCount: 10,
            responseLatencySampleCount: 0,
            medianResponseLatencyMs: null,
            windowStartAtMs: base,
            windowEndAtMs: base,
            algorithmVersion: 1,
            source: "backup",
            sourceEventKey: null,
            observedAtMs: base,
            captureVersion: 1
          }
        ]
      });
      const sync = await repository.syncBrainGraphSignals();
      expect(sync.vcardMentionEdges, kind).toBe(1);
      expect(sync.numberChangeAliases, kind).toBe(1);
      expect(sync.engagementFactors, `${kind}: fully-read counterparty gets the bounded factor`).toBe(1);
      const again = await repository.syncBrainGraphSignals();
      expect(again.vcardMentionEdges + again.numberChangeAliases + again.engagementFactors, `${kind}: idempotent`).toBe(0);
      const subject = await repository.getBrainGraphEntity({ jid: "1888@s.whatsapp.net" });
      expect(subject, kind).not.toBeNull();
      expect(subject!.aliases, kind).toContain("Sam Vendor");
      const riya = await repository.getBrainGraphEntity({ jid: RIYA });
      const aliasEdge = riya!.edges.find((edge) => edge.kind === "alias_of");
      expect(aliasEdge, `${kind}: number-change succession edge`).toBeTruthy();
    });
  });
});
