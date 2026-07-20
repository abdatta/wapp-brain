// Graph explorer: the bounded neighborhood read contract + per-edge evidence.
// Every scenario runs against BOTH repositories (SQLite recursive CTE and the
// in-memory BFS mirror) — the query-layer mirror parity the change requires,
// verified by execution. Zero model calls anywhere here.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { messageKey } from "../src/server/identity/keys";
import type { ArchiveRepository } from "../src/server/db/repository";
import type { BrainGraphNeighborhoodView, BrainGraphNodeSuggestion, MessageRecord } from "../src/shared/types";

const DAY_MS = 86_400_000;
const NOW = Date.now();

const CHAT = "team@g.us";
const RIYA = "1555@s.whatsapp.net";
const ARJUN = "1666@s.whatsapp.net";
const SAM1 = "1777@s.whatsapp.net";
const SAM2 = "1888@s.whatsapp.net";

afterEach(() => {
  delete process.env.WAPP_BRAIN_SALIENCE_DORMANT;
});

function message(id: string, chatSourceId: string, overrides: Partial<MessageRecord> & { timestampMs: number }): MessageRecord {
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

type RepoKind = "sqlite" | "memory";

async function withRepos(test: (repository: ArchiveRepository, kind: RepoKind) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-graph-explorer-"));
  const sqlite = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
  try {
    await test(sqlite, "sqlite");
  } finally {
    await sqlite.close?.();
    await rm(tempDir, { recursive: true, force: true });
  }
  await test(new MemoryArchiveRepository(), "memory");
}

function key(id: string): string {
  return messageKey(CHAT, id);
}

// A small, fully-understood 2-hop structure anchored on Riya:
//   Riya —participates_in→ CHAT ; Riya ←involves— commitment ;
//   Riya ↔related_to↔ Acme ; Riya —about→ visa ; Riya —mentions→ Arjun  (hop 1)
//   Acme ↔related_to↔ Globex ; CHAT —participates_in← Sam1/Sam2/Arjun     (hop 2)
async function seedNeighborhood(repository: ArchiveRepository): Promise<void> {
  const runId = await repository.startImportRun({ test: true });
  await repository.upsertContacts(runId, [
    { sourceJid: RIYA, displayName: "Riya", phoneNumber: "+1555" },
    { sourceJid: ARJUN, displayName: "Arjun", phoneNumber: "+1666" },
    { sourceJid: SAM1, displayName: "Sam", phoneNumber: "+1777" },
    { sourceJid: SAM2, displayName: "Sam", phoneNumber: "+1888" }
  ]);
  await repository.upsertChats(runId, [{ sourceChatId: CHAT, jid: CHAT, displayName: "Team", chatType: "group" }]);
  const base = NOW - 2 * DAY_MS;
  await repository.upsertMessages([
    message("M1", CHAT, { timestampMs: base, senderSourceJid: RIYA, body: "I will send the visa documents by Friday." }),
    message("M2", CHAT, { timestampMs: base + 60_000, senderSourceJid: ARJUN, body: "Acme partners with Globex on it." }),
    message("M4", CHAT, { timestampMs: base + 120_000, senderSourceJid: RIYA, body: "@1666 got it", mentionedJids: [ARJUN] }),
    message("M5", CHAT, { timestampMs: base + 180_000, senderSourceJid: SAM1, body: "Sam one here." }),
    message("M6", CHAT, { timestampMs: base + 240_000, senderSourceJid: SAM2, body: "Sam two here." })
  ]);
  await repository.commitBrainEpisode({
    chatSourceId: CHAT,
    startAtMs: base,
    endAtMs: base + 300_000,
    messageCount: 5,
    participants: ["Riya", "Arjun"],
    summary: "Visa coordination.",
    markdown: "",
    generator: "model",
    model: "test-model",
    runId: null,
    extractionVersion: 99,
    topics: ["visa"],
    claims: [
      {
        kind: "commitment",
        text: "Riya will send the visa documents by Friday.",
        citations: [key("M1")],
        validUntilMs: NOW + 5 * DAY_MS,
        confidence: "stated",
        entities: [
          { kind: "person", name: "Riya", jid: RIYA },
          { kind: "org", name: "Acme" }
        ]
      },
      {
        kind: "fact",
        text: "Acme partnered with Globex.",
        citations: [key("M2")],
        confidence: "stated",
        entities: [
          { kind: "org", name: "Acme" },
          { kind: "org", name: "Globex" }
        ]
      },
      {
        kind: "fact",
        text: "Sam and Sam both checked in.",
        citations: [key("M5"), key("M6")],
        confidence: "stated",
        entities: [
          { kind: "person", name: "Sam", jid: SAM1 },
          { kind: "person", name: "Sam", jid: SAM2 }
        ]
      }
    ]
  });
}

const labels = (view: BrainGraphNeighborhoodView): string[] => view.nodes.map((node) => node.label);
const find = (view: BrainGraphNeighborhoodView, label: string) => view.nodes.find((node) => node.label === label);

describe("graph explorer: bounds & shape (3.2)", () => {
  it("anchors at hop 0 and reaches both directions within depth", async () => {
    await withRepos(async (repository, kind) => {
      await seedNeighborhood(repository);
      const view = await repository.getBrainGraphNeighborhood({ jid: RIYA, depth: 1 });
      expect(view, kind).not.toBeNull();
      const anchor = view!.nodes.find((node) => node.hop === 0);
      expect(anchor, `${kind}: anchor present at hop 0`).toBeTruthy();
      expect(anchor!.jid, kind).toBe(RIYA);
      expect(view!.nodes.every((node) => node.hop <= 1), `${kind}: depth-1 stays within one hop`).toBe(true);
      // Inbound involves edge (commitment → Riya) must still surface the commitment.
      const commitment = view!.nodes.find((node) => node.kind === "commitment");
      expect(commitment, `${kind}: reached the inbound-edge neighbor`).toBeTruthy();
    });
  });

  it("anchors on a chat node by source chat id (the episode → graph entry)", async () => {
    await withRepos(async (repository, kind) => {
      await seedNeighborhood(repository);
      const view = await repository.getBrainGraphNeighborhood({ chat: CHAT, depth: 1 });
      expect(view, kind).not.toBeNull();
      const anchor = view!.nodes.find((node) => node.hop === 0)!;
      expect(anchor.kind, `${kind}: the chat is the anchor`).toBe("chat");
      expect(anchor.label, kind).toBe("Team");
      // Its participants are one hop out via participates_in.
      expect(view!.nodes.some((node) => node.jid === RIYA), `${kind}: participant reached from the chat`).toBe(true);
    });
  });

  it("depth 2 reaches strictly further than depth 1", async () => {
    await withRepos(async (repository, kind) => {
      await seedNeighborhood(repository);
      const d1 = await repository.getBrainGraphNeighborhood({ jid: RIYA, depth: 1 });
      const d2 = await repository.getBrainGraphNeighborhood({ jid: RIYA, depth: 2 });
      expect(find(d1!, "Globex"), `${kind}: Globex is two hops away — absent at depth 1`).toBeUndefined();
      const globex = find(d2!, "Globex");
      expect(globex, `${kind}: Globex reached at depth 2`).toBeTruthy();
      expect(globex!.hop, kind).toBe(2);
      expect(d2!.nodes.length, kind).toBeGreaterThan(d1!.nodes.length);
      // Every edge references only nodes that are present in the view.
      const ids = new Set(d2!.nodes.map((node) => node.id));
      expect(d2!.edges.every((edge) => ids.has(edge.srcId) && ids.has(edge.dstId)), `${kind}: no dangling edges`).toBe(true);
    });
  });
});

describe("graph explorer: filters (3.3)", () => {
  it("restricts by edge kind", async () => {
    await withRepos(async (repository, kind) => {
      await seedNeighborhood(repository);
      const view = await repository.getBrainGraphNeighborhood({ jid: RIYA, depth: 1, kinds: ["participates_in"] });
      expect(view!.edges.every((edge) => edge.kind === "participates_in"), kind).toBe(true);
      expect(find(view!, "Team"), `${kind}: the chat is reached via participates_in`).toBeTruthy();
      expect(view!.nodes.find((node) => node.kind === "commitment"), `${kind}: involves neighbor filtered out`).toBeUndefined();
    });
  });

  it("honors a minimum salience (anchor always exempt)", async () => {
    await withRepos(async (repository, kind) => {
      await seedNeighborhood(repository);
      const view = await repository.getBrainGraphNeighborhood({ jid: RIYA, depth: 2, minSalience: 1_000_000 });
      expect(view!.nodes.length, `${kind}: only the anchor survives an impossible salience floor`).toBe(1);
      expect(view!.nodes[0].jid, kind).toBe(RIYA);
      expect(view!.edges.length, kind).toBe(0);
    });
  });

  it("hides dormant neighbors by default and reveals them on toggle", async () => {
    process.env.WAPP_BRAIN_SALIENCE_DORMANT = "999";
    await withRepos(async (repository, kind) => {
      await seedNeighborhood(repository);
      await repository.recomputeBrainGraphSalience();
      const hidden = await repository.getBrainGraphNeighborhood({ jid: RIYA, depth: 2 });
      const shown = await repository.getBrainGraphNeighborhood({ jid: RIYA, depth: 2, includeDormant: true });
      expect(find(hidden!, "Acme"), `${kind}: dormant Acme hidden by default`).toBeUndefined();
      expect(find(shown!, "Acme"), `${kind}: dormant Acme visible when toggled`).toBeTruthy();
      expect(shown!.nodes.length, kind).toBeGreaterThan(hidden!.nodes.length);
      // The open commitment is dormancy-exempt, so it is present either way.
      expect(hidden!.nodes.some((node) => node.kind === "commitment"), `${kind}: open commitment stays visible`).toBe(true);
    });
  });
});

describe("graph explorer: caps & truncation (3.4)", () => {
  it("enforces the node cap, pins the anchor, and discloses truncation", async () => {
    await withRepos(async (repository, kind) => {
      await seedNeighborhood(repository);
      const view = await repository.getBrainGraphNeighborhood({ jid: RIYA, depth: 2, maxNodes: 1 });
      expect(view!.nodes.length, kind).toBe(1);
      expect(view!.nodes[0].jid, `${kind}: the anchor is the pinned survivor`).toBe(RIYA);
      expect(view!.truncated, kind).toBe(true);
      expect(view!.totalNodes, `${kind}: pre-cap total is disclosed`).toBeGreaterThan(1);
      expect(view!.edges.length, `${kind}: no edges survive a single-node cap`).toBe(0);
    });
  });

  it("enforces the edge cap", async () => {
    await withRepos(async (repository, kind) => {
      await seedNeighborhood(repository);
      const view = await repository.getBrainGraphNeighborhood({ jid: RIYA, depth: 2, maxEdges: 1 });
      expect(view!.edges.length, kind).toBeLessThanOrEqual(1);
      expect(view!.truncated, kind).toBe(true);
      expect(view!.totalEdges, kind).toBeGreaterThan(1);
    });
  });
});

describe("graph explorer: labels & identity (3.5)", () => {
  it("re-labels a renamed contact with zero graph writes", async () => {
    await withRepos(async (repository, kind) => {
      await seedNeighborhood(repository);
      const before = await repository.getBrainGraphStats();
      expect(find((await repository.getBrainGraphNeighborhood({ jid: RIYA, depth: 1 }))!, "Riya")).toBeTruthy();
      const runId = await repository.startImportRun({ test: true });
      await repository.upsertContacts(runId, [{ sourceJid: RIYA, displayName: "Riya Sharma", displayNameSource: "user" }]);
      const after = await repository.getBrainGraphNeighborhood({ jid: RIYA, depth: 1 });
      expect(after!.nodes.find((node) => node.hop === 0)!.label, `${kind}: read-time relabel`).toBe("Riya Sharma");
      const stats = await repository.getBrainGraphStats();
      expect(stats.nodeCount, `${kind}: rename writes no graph nodes`).toBe(before.nodeCount);
      expect(stats.edgeCount, `${kind}: rename writes no graph edges`).toBe(before.edgeCount);
    });
  });

  it("disambiguates two distinct same-named people in one neighborhood", async () => {
    await withRepos(async (repository, kind) => {
      await seedNeighborhood(repository);
      const view = await repository.getBrainGraphNeighborhood({ jid: RIYA, depth: 2, maxNodes: 200 });
      const sams = view!.nodes.filter((node) => node.jid === SAM1 || node.jid === SAM2);
      expect(sams.length, `${kind}: both Sams reached at hop 2`).toBe(2);
      const samLabels = sams.map((node) => node.label);
      expect(new Set(samLabels).size, `${kind}: distinct persons get distinct labels`).toBe(2);
      expect(samLabels.every((label) => label.startsWith("Sam")), kind).toBe(true);
    });
  });

  it("redirects a merged anchor and never renders the merged stub", async () => {
    await withRepos(async (repository, kind) => {
      const base = NOW - 3 * DAY_MS;
      const lid = "999888777@lid";
      const pn = "1999@s.whatsapp.net";
      for (const [chat, jid, id, name] of [
        [lid, lid, "L1", "Lid Person"],
        [pn, pn, "P1", "Phone Person"]
      ] as const) {
        const runId = await repository.startImportRun({ test: true });
        await repository.upsertChats(runId, [{ sourceChatId: chat, jid: chat, displayName: chat, chatType: "dm" }]);
        await repository.upsertMessages([message(id, chat, { timestampMs: base, senderSourceJid: jid, body: "hello" })]);
        await repository.commitBrainEpisode({
          chatSourceId: chat,
          startAtMs: base,
          endAtMs: base + 60_000,
          messageCount: 1,
          participants: [name],
          summary: "s",
          markdown: "",
          generator: "model",
          model: "test-model",
          runId: null,
          extractionVersion: 99,
          topics: ["visa"],
          claims: [{ kind: "fact", text: `${name} spoke.`, citations: [messageKey(chat, id)], confidence: "stated", entities: [{ kind: "person", name, jid }] }]
        });
      }
      const held = (await repository.getBrainGraphEntity({ jid: lid }))!.node.id;
      await repository.recordIdentityLinks([{ lid, pn }]);
      await repository.mergeIdentity(lid, pn);
      const survivor = (await repository.getBrainGraphEntity({ jid: pn }))!.node.id;
      const view = await repository.getBrainGraphNeighborhood({ nodeId: held, depth: 2 });
      expect(view, kind).not.toBeNull();
      expect(view!.redirected, `${kind}: held id redirects`).toBe(true);
      expect(view!.anchorId, `${kind}: anchor resolves to the survivor`).toBe(survivor);
      expect(view!.nodes.every((node) => node.status !== "merged"), `${kind}: merged stub never appears`).toBe(true);
    });
  });
});

describe("graph explorer: edge evidence (3.6)", () => {
  it("returns claim-derived citations with thread-anchor coordinates", async () => {
    await withRepos(async (repository, kind) => {
      await seedNeighborhood(repository);
      const view = await repository.getBrainGraphNeighborhood({ jid: RIYA, depth: 1 });
      const commitment = view!.nodes.find((node) => node.kind === "commitment")!;
      const edge = view!.edges.find(
        (candidate) => candidate.kind === "involves" && (candidate.srcId === commitment.id || candidate.dstId === commitment.id)
      )!;
      expect(edge, `${kind}: found the commitment↔Riya involves edge`).toBeTruthy();
      const evidence = await repository.getBrainGraphEdgeEvidence(edge.id);
      expect(evidence, kind).not.toBeNull();
      expect(evidence!.citations.length, `${kind}: the edge carries evidence`).toBeGreaterThan(0);
      const cite = evidence!.citations[0];
      expect(cite.sourceChatId, `${kind}: citation carries the source chat id`).toBe(CHAT);
      expect(typeof cite.chatId, `${kind}: citation carries the numeric chat id for deep-linking`).toBe("number");
      expect(cite.messageId, `${kind}: citation carries a message id`).not.toBeNull();
      expect(cite.claimText, `${kind}: claim-derived evidence surfaces the claim text`).toContain("visa documents");
    });
  });

  it("returns null for an unknown edge", async () => {
    await withRepos(async (repository, kind) => {
      await seedNeighborhood(repository);
      expect(await repository.getBrainGraphEdgeEvidence(9_999_999), kind).toBeNull();
    });
  });
});

describe("graph explorer: identity collapse (two-level person model)", () => {
  it("collapses connected identities into one node, with zero graph writes", async () => {
    await withRepos(async (repository, kind) => {
      await seedNeighborhood(repository);
      const before = await repository.getBrainGraphStats();
      const twoSams = (await repository.getBrainGraphNeighborhood({ jid: RIYA, depth: 2, maxNodes: 200 }))!.nodes.filter(
        (node) => node.jid === SAM1 || node.jid === SAM2
      );
      expect(twoSams.length, `${kind}: two distinct Sam identities before connect`).toBe(2);

      const connect = await repository.connectIdentities(SAM1, SAM2, "user", null);
      expect(connect.outcome, kind).toBe("connected");

      const after = await repository.getBrainGraphNeighborhood({ jid: RIYA, depth: 2, maxNodes: 200 });
      const collapsedSams = after!.nodes.filter((node) => node.jid === SAM1 || node.jid === SAM2);
      expect(collapsedSams.length, `${kind}: connected identities collapse to one node`).toBe(1);

      // Read-time aggregation: the stored graph is untouched by the connect.
      const stats = await repository.getBrainGraphStats();
      expect(stats.nodeCount, `${kind}: collapse writes no graph nodes`).toBe(before.nodeCount);

      // Disconnect re-derives: the two identities separate again, zero writes.
      await repository.disconnectIdentities(SAM2);
      const reSeparated = (await repository.getBrainGraphNeighborhood({ jid: RIYA, depth: 2, maxNodes: 200 }))!.nodes.filter(
        (node) => node.jid === SAM1 || node.jid === SAM2
      );
      expect(reSeparated.length, `${kind}: disconnect re-separates the identities`).toBe(2);
    });
  });

  it("keeps the anchored identity as the representative", async () => {
    await withRepos(async (repository, kind) => {
      await seedNeighborhood(repository);
      await repository.connectIdentities(SAM1, SAM2, "user", null);
      const view = await repository.getBrainGraphNeighborhood({ jid: SAM2, depth: 1 });
      const anchor = view!.nodes.find((node) => node.hop === 0)!;
      expect(anchor.jid, `${kind}: the anchored identity stays the representative`).toBe(SAM2);
      // The other identity folded in — it is not a separate neighbor.
      expect(view!.nodes.filter((node) => node.jid === SAM1).length, `${kind}: sibling identity is folded in`).toBe(0);
    });
  });

  it("folds an unresolved name onto the resolved person of its DM", async () => {
    await withRepos(async (repository, kind) => {
      const base = NOW - 2 * DAY_MS;
      const dmJid = "1999@s.whatsapp.net";
      const runId = await repository.startImportRun({ test: true });
      await repository.upsertContacts(runId, [{ sourceJid: dmJid, displayName: "Nadia Khan" }]);
      await repository.upsertChats(runId, [{ sourceChatId: dmJid, jid: dmJid, displayName: "Nadia Khan", chatType: "dm" }]);
      await repository.upsertMessages([
        message("D1", dmJid, { timestampMs: base, senderSourceJid: dmJid, body: "Nadia works with Acme." }),
        message("D2", dmJid, { timestampMs: base + 1000, senderSourceJid: dmJid, body: "Nadia mentioned Acme again." })
      ]);
      await repository.commitBrainEpisode({
        chatSourceId: dmJid,
        startAtMs: base,
        endAtMs: base + 60_000,
        messageCount: 2,
        participants: ["Nadia"],
        summary: "s",
        markdown: "",
        generator: "model",
        model: "test-model",
        runId: null,
        extractionVersion: 99,
        topics: ["visa"],
        claims: [
          {
            kind: "fact",
            text: "Nadia works with Acme.",
            citations: [messageKey(dmJid, "D1")],
            confidence: "stated",
            entities: [
              { kind: "person", name: "Nadia", jid: dmJid },
              { kind: "org", name: "Acme" }
            ]
          },
          {
            // Unresolved "Nadia" — no jid → a chat-scoped name node in Nadia's DM.
            kind: "fact",
            text: "Nadia mentioned Acme again.",
            citations: [messageKey(dmJid, "D2")],
            confidence: "stated",
            entities: [
              { kind: "person", name: "Nadia" },
              { kind: "org", name: "Acme" }
            ]
          }
        ]
      });
      const view = await repository.getBrainGraphNeighborhood({ jid: dmJid, depth: 2, maxNodes: 200 });
      const nadias = view!.nodes.filter((node) => node.kind === "person" && (node.label ?? "").toLowerCase().includes("nadia"));
      expect(nadias.length, `${kind}: unresolved name folds onto the resolved DM person`).toBe(1);
    });
  });

  it("folds a 1-on-1 chat node onto its counterparty person", async () => {
    await withRepos(async (repository, kind) => {
      const base = NOW - 2 * DAY_MS;
      const personJid = "1999@s.whatsapp.net";
      const runId = await repository.startImportRun({ test: true });
      await repository.upsertContacts(runId, [{ sourceJid: personJid, displayName: "Priya" }]);
      // A DM's source_chat_id is the counterparty JID; its name is the person's.
      await repository.upsertChats(runId, [{ sourceChatId: personJid, jid: personJid, displayName: "Priya", chatType: "dm" }]);
      await repository.upsertMessages([message("D1", personJid, { timestampMs: base, senderSourceJid: personJid, body: "Priya and Acme." })]);
      await repository.commitBrainEpisode({
        chatSourceId: personJid,
        startAtMs: base,
        endAtMs: base + 60_000,
        messageCount: 1,
        participants: ["Priya"],
        summary: "s",
        markdown: "",
        generator: "model",
        model: "test-model",
        runId: null,
        extractionVersion: 99,
        topics: ["visa"],
        claims: [
          {
            kind: "fact",
            text: "Priya works with Acme.",
            citations: [messageKey(personJid, "D1")],
            confidence: "stated",
            entities: [
              { kind: "person", name: "Priya", jid: personJid },
              { kind: "org", name: "Acme" }
            ]
          }
        ]
      });
      // Anchor on Acme so both Priya and her DM chat are neighbors; the DM chat
      // (named "Priya", scoped to her JID) folds into the person — no "Priya
      // participates in Priya".
      const view = await repository.getBrainGraphNeighborhood({ name: "Acme", depth: 2, maxNodes: 200 });
      expect(view!.nodes.filter((node) => node.kind === "chat").length, `${kind}: the DM chat folds into its person`).toBe(0);
      expect(view!.nodes.filter((node) => node.kind === "person").length, `${kind}: a single person node remains`).toBe(1);
    });
  });

  it("unifies the archive owner (self-number + own-name mentions) into one node", async () => {
    await withRepos(async (repository, kind) => {
      const base = NOW - 2 * DAY_MS;
      const grp = "ownergrp@g.us";
      const runId = await repository.startImportRun({ test: true });
      await repository.upsertContacts(runId, [{ sourceJid: RIYA, displayName: "Riya" }]);
      await repository.upsertChats(runId, [{ sourceChatId: grp, jid: grp, displayName: "Grp", chatType: "group" }]);
      await repository.upsertMessages([
        message("G1", grp, { timestampMs: base, senderSourceJid: RIYA, body: "Riya and Acme." }),
        message("G2", grp, { timestampMs: base + 1000, senderSourceJid: ARJUN, body: "Riya again with Acme." })
      ]);
      await repository.commitBrainEpisode({
        chatSourceId: grp,
        startAtMs: base,
        endAtMs: base + 60_000,
        messageCount: 2,
        participants: ["Riya"],
        summary: "s",
        markdown: "",
        generator: "model",
        model: "test-model",
        runId: null,
        extractionVersion: 99,
        topics: ["visa"],
        claims: [
          {
            kind: "fact",
            text: "Riya works with Acme.",
            citations: [messageKey(grp, "G1")],
            confidence: "stated",
            entities: [
              { kind: "person", name: "Riya", jid: RIYA },
              { kind: "org", name: "Acme" }
            ]
          },
          {
            // Unresolved "Riya" mention (no jid) in a GROUP chat — only the owner
            // rule (not the DM-name rule) can unify it.
            kind: "fact",
            text: "Riya mentioned Acme.",
            citations: [messageKey(grp, "G2")],
            confidence: "stated",
            entities: [
              { kind: "person", name: "Riya" },
              { kind: "org", name: "Acme" }
            ]
          }
        ]
      });
      // The archive owner is "Riya", and RIYA is their self-number.
      await repository.setArchiveOwnerName("Riya");
      await repository.setArchiveOwnerSelfJids([RIYA]);

      const view = await repository.getBrainGraphNeighborhood({ name: "Acme", depth: 2, maxNodes: 200 });
      const riyaNodes = view!.nodes.filter((node) => node.kind === "person" && (node.label ?? "").toLowerCase().includes("riya"));
      expect(riyaNodes.length, `${kind}: owner self-number + own-name mention unify into one node`).toBe(1);
    });
  });
});

describe("graph explorer: anchor-by-name resolution", () => {
  it("anchors by name on the resolved person, not an unresolved same-name mention", async () => {
    await withRepos(async (repository, kind) => {
      const base = NOW - 2 * DAY_MS;
      const chat = "namechat@g.us";
      const person = "1500@s.whatsapp.net";
      const runId = await repository.startImportRun({ test: true });
      await repository.upsertContacts(runId, [{ sourceJid: person, displayName: "Tara" }]);
      await repository.upsertChats(runId, [{ sourceChatId: chat, jid: chat, displayName: "Chat", chatType: "group" }]);
      await repository.upsertMessages([
        message("N1", chat, { timestampMs: base, senderSourceJid: person, body: "Tara here." }),
        message("N2", chat, { timestampMs: base + 1000, senderSourceJid: "1600@s.whatsapp.net", body: "Tara was mentioned." })
      ]);
      await repository.commitBrainEpisode({
        chatSourceId: chat,
        startAtMs: base,
        endAtMs: base + 60_000,
        messageCount: 2,
        participants: ["Tara"],
        summary: "s",
        markdown: "",
        generator: "model",
        model: "test-model",
        runId: null,
        extractionVersion: 99,
        topics: ["visa"],
        claims: [
          { kind: "fact", text: "Tara spoke.", citations: [messageKey(chat, "N1")], confidence: "stated", entities: [{ kind: "person", name: "Tara", jid: person }] },
          // An unresolved "Tara" (no jid) — a same-name mention that carries a title.
          { kind: "fact", text: "Tara was mentioned.", citations: [messageKey(chat, "N2")], confidence: "stated", entities: [{ kind: "person", name: "Tara" }] }
        ]
      });
      const view = await repository.getBrainGraphNeighborhood({ name: "Tara", depth: 1 });
      const anchor = view!.nodes.find((node) => node.hop === 0);
      expect(anchor?.jid, `${kind}: name resolves to the resolved person, not the unresolved mention`).toBe(person);
    });
  });
});

describe("graph explorer: mirror parity (3.7)", () => {
  it("SQLite and memory return identical neighborhoods for the same seed", async () => {
    // Node UUIDs, edge ids, and claim-derived natural keys (commitment:<uuid>)
    // are all per-backend random ids — legitimately different, not a parity
    // break. `related_to` also normalizes its direction by UUID order. So parity
    // is asserted over the STABLE semantic identity `kind:label` (unique per node
    // in this seed), with edges as unordered endpoint-key pairs + kind.
    const stableKey = (node: BrainGraphNeighborhoodView["nodes"][number]): string => `${node.kind}::${node.label}`;
    const normalize = (view: BrainGraphNeighborhoodView) => {
      const keyById = new Map(view.nodes.map((node) => [node.id, stableKey(node)]));
      return {
        anchorKey: keyById.get(view.anchorId) ?? view.anchorId,
        redirected: view.redirected,
        truncated: view.truncated,
        totalNodes: view.totalNodes,
        totalEdges: view.totalEdges,
        nodes: [...view.nodes].map((node) => ({ key: stableKey(node), hop: node.hop, status: node.status })).sort((a, b) => (a.key < b.key ? -1 : 1)),
        edges: [...view.edges]
          .map((edge) => {
            const pair = [keyById.get(edge.srcId) ?? edge.srcId, keyById.get(edge.dstId) ?? edge.dstId].sort();
            return `${pair[0]}|${pair[1]}|${edge.kind}`;
          })
          .sort()
      };
    };

    const runOne = async (repository: ArchiveRepository): Promise<BrainGraphNeighborhoodView> => {
      await seedNeighborhood(repository);
      return (await repository.getBrainGraphNeighborhood({ jid: RIYA, depth: 2, maxNodes: 200 }))!;
    };

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-graph-parity-"));
    const sqlite = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
    let sqliteView: BrainGraphNeighborhoodView;
    try {
      sqliteView = await runOne(sqlite);
    } finally {
      await sqlite.close?.();
      await rm(tempDir, { recursive: true, force: true });
    }
    const memoryView = await runOne(new MemoryArchiveRepository());
    expect(normalize(memoryView)).toEqual(normalize(sqliteView));
  });
});

describe("graph explorer: anchor search typeahead (14)", () => {
  it("matches persons by contact name, orgs by title, chats by name — each carrying a node id", async () => {
    await withRepos(async (repository, kind) => {
      await seedNeighborhood(repository);

      const riya = await repository.searchBrainGraphNodes("riy");
      expect(riya.some((s) => s.kind === "person" && s.label === "Riya" && s.jid === RIYA), `${kind}: finds Riya by name`).toBe(true);
      expect(riya.every((s) => s.id.length > 0), `${kind}: every suggestion carries a node id`).toBe(true);

      const acme = await repository.searchBrainGraphNodes("acme");
      expect(acme.some((s) => s.kind === "org" && s.label === "Acme"), `${kind}: finds the org by title`).toBe(true);

      const team = await repository.searchBrainGraphNodes("tea");
      expect(team.some((s) => s.kind === "chat" && s.label === "Team"), `${kind}: finds the chat by display name`).toBe(true);
    });
  });

  it("returns every same-named person as a distinct, id-bearing option (disambiguation)", async () => {
    await withRepos(async (repository, kind) => {
      await seedNeighborhood(repository);
      const sams = await repository.searchBrainGraphNodes("sam");
      const samPeople = sams.filter((s) => s.kind === "person" && s.label === "Sam");
      expect(samPeople.length, `${kind}: both Sams surface`).toBe(2);
      expect(new Set(samPeople.map((s) => s.jid)), `${kind}: distinct jids`).toEqual(new Set([SAM1, SAM2]));
      expect(new Set(samPeople.map((s) => s.id)).size, `${kind}: distinct node ids`).toBe(2);
    });
  });

  it("excludes DM chats — a 1:1 chat folds onto its person, so only the person is offered", async () => {
    await withRepos(async (repository, kind) => {
      const runId = await repository.startImportRun({ test: true });
      const NADIA = "1999@s.whatsapp.net";
      await repository.upsertContacts(runId, [{ sourceJid: NADIA, displayName: "Nadia", phoneNumber: "+1999" }]);
      await repository.upsertChats(runId, [{ sourceChatId: NADIA, jid: NADIA, displayName: "Nadia", chatType: "dm" }]);
      const base = NOW - DAY_MS;
      await repository.upsertMessages([message("N1", NADIA, { timestampMs: base, senderSourceJid: NADIA, body: "Hi from Nadia." })]);
      await repository.commitBrainEpisode({
        chatSourceId: NADIA,
        startAtMs: base,
        endAtMs: base + 1000,
        messageCount: 1,
        participants: ["Nadia"],
        summary: "DM with Nadia.",
        markdown: "",
        generator: "model",
        model: "test-model",
        runId: null,
        extractionVersion: 99,
        topics: [],
        claims: [
          {
            kind: "fact",
            text: "Nadia said hi.",
            citations: [messageKey(NADIA, "N1")],
            confidence: "stated",
            entities: [{ kind: "person", name: "Nadia", jid: NADIA }]
          }
        ]
      });
      const hits = await repository.searchBrainGraphNodes("nadia");
      expect(hits.some((s) => s.kind === "person" && s.jid === NADIA), `${kind}: the person is offered`).toBe(true);
      expect(hits.some((s) => s.kind === "chat"), `${kind}: the DM chat is not offered`).toBe(false);
    });
  });

  it("excludes claim-ish kinds — text that lives only in a commitment/fact is not anchorable", async () => {
    await withRepos(async (repository, kind) => {
      await seedNeighborhood(repository);
      // "visa" is both a topic node AND a word in the commitment's text. Only the
      // topic (an entity) may be anchored; the commitment must never appear.
      const hits = await repository.searchBrainGraphNodes("visa");
      expect(hits.some((s) => s.kind === "topic"), `${kind}: the visa topic is offered`).toBe(true);
      expect(
        hits.every((s) => !["commitment", "question", "event", "fact"].includes(s.kind)),
        `${kind}: no claim nodes in suggestions`
      ).toBe(true);
      // "Friday" lives only inside the commitment text — nothing anchorable has it.
      expect(await repository.searchBrainGraphNodes("friday"), `${kind}: claim-only text yields nothing`).toEqual([]);
    });
  });

  it("a picked suggestion's id anchors the neighborhood on that exact node", async () => {
    await withRepos(async (repository, kind) => {
      await seedNeighborhood(repository);
      const results = await repository.searchBrainGraphNodes("riya");
      expect(results.length, `${kind}: at least one match`).toBeGreaterThan(0);
      const picked = results[0]!;
      const view = await repository.getBrainGraphNeighborhood({ nodeId: picked.id, depth: 1 });
      const anchor = view!.nodes.find((node) => node.hop === 0)!;
      expect(anchor.id, `${kind}: anchors on the picked id`).toBe(picked.id);
      expect(anchor.jid, kind).toBe(RIYA);
    });
  });

  it("blank query returns nothing; both backends agree on the match set", async () => {
    await withRepos(async (repository, kind) => {
      await seedNeighborhood(repository);
      expect(await repository.searchBrainGraphNodes("   "), `${kind}: blank query`).toEqual([]);
    });

    // Parity: identical match set for the same query, compared on stable identity
    // (kind|label|jid) since node ids are per-backend random.
    const identities = (rows: BrainGraphNodeSuggestion[]) =>
      rows.map((row) => `${row.kind}|${row.label}|${row.jid ?? ""}`).sort();
    const run = async (repository: ArchiveRepository) => {
      await seedNeighborhood(repository);
      return identities(await repository.searchBrainGraphNodes("a"));
    };
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-graph-search-"));
    const sqlite = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
    let sqliteIds: string[];
    try {
      sqliteIds = await run(sqlite);
    } finally {
      await sqlite.close?.();
      await rm(tempDir, { recursive: true, force: true });
    }
    const memoryIds = await run(new MemoryArchiveRepository());
    expect(memoryIds).toEqual(sqliteIds);
  });
});
