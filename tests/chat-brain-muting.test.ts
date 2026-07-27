import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import {
  activeMuteIntervals,
  isFullyMuted,
  isMutedAt,
  mergeMuteIntervals,
  spanOverlapsMute,
  truncateMuteIntervals,
  type MuteIntervalValue
} from "../src/server/db/muteIntervals";
import type { ArchiveRepository } from "../src/server/db/repository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { enqueueEpisodeTasksForChats } from "../src/server/brain/scheduler";
import { messageKey } from "../src/server/identity/keys";
import type { BrainEpisodeInput, ChatRecord, MessageRecord } from "../src/shared/types";

const GROUP = "120363000000000001@g.us";
const DM = "15550000002@s.whatsapp.net";
const CHANNEL = "120363111111111111@newsletter";

const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

const tempDirs: string[] = [];
const openRepositories: SqliteArchiveRepository[] = [];

// Windows holds the -shm/-wal files until the handle closes, so the repository
// must be closed BEFORE the directory is removed or cleanup throws EBUSY.
afterEach(async () => {
  while (openRepositories.length > 0) {
    await openRepositories.pop()!.close();
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function sqliteRepository(): Promise<SqliteArchiveRepository> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wapp-mute-"));
  tempDirs.push(dir);
  const repository = new SqliteArchiveRepository(path.join(dir, "archive.sqlite"));
  openRepositories.push(repository);
  return repository;
}

function makeChat(jid: string, chatType: ChatRecord["chatType"]): ChatRecord {
  return { sourceChatId: jid, jid, displayName: `Chat ${jid.slice(0, 6)}`, chatType, platformRecencyMs: T0, rawMetadata: {} };
}

function makeMessage(chatJid: string, id: string, timestampMs: number, hasMedia = false): MessageRecord {
  return {
    sourceMessageKey: messageKey(chatJid, id),
    sourceMessageId: id,
    sourceTable: "wa-web:messages.upsert",
    sourceRowId: id,
    chatSourceId: chatJid,
    senderSourceJid: chatJid,
    timestampMs,
    sentAtIso: new Date(timestampMs).toISOString(),
    fromMe: false,
    direction: "incoming",
    messageType: hasMedia ? "image" : "text",
    rawTypeCode: hasMedia ? "image" : "text",
    body: `body ${id}`,
    hasMedia,
    isDeleted: false,
    isForwarded: false,
    isStarred: false
  };
}

function makeEpisode(chatSourceId: string, startAtMs: number, endAtMs: number, summary: string): BrainEpisodeInput {
  return {
    chatSourceId,
    startAtMs,
    endAtMs,
    messageCount: 2,
    participants: [chatSourceId],
    summary,
    markdown: `# ${summary}\n\nBody.`,
    generator: "model",
    model: "test-model",
    runId: null,
    extractionVersion: 2,
    topics: [`topic for ${summary}`],
    claims: [
      {
        kind: "fact",
        text: `claim from ${summary}`,
        citations: [messageKey(chatSourceId, "M1")],
        confidence: "stated",
        entities: [{ kind: "person", name: "Someone", jid: DM }]
      }
    ]
  };
}

/** Fans one episode's claim out to `count` claims, all citing the same person. */
function withClaims(episode: BrainEpisodeInput, count: number): BrainEpisodeInput {
  const template = episode.claims[0]!;
  return {
    ...episode,
    claims: Array.from({ length: count }, (_unused, index) => ({ ...template, text: `${template.text} #${index + 1}` }))
  };
}

/** A group with history plus an unmuted DM, so hiding can be told from deleting. */
async function seed(repository: ArchiveRepository): Promise<void> {
  await repository.upsertChats("import", [makeChat(GROUP, "group"), makeChat(DM, "dm")]);
  await repository.upsertMessages([
    makeMessage(GROUP, "M1", T0),
    makeMessage(GROUP, "M2", T0 + DAY, true),
    makeMessage(GROUP, "M3", T0 + 5 * DAY),
    makeMessage(DM, "D1", T0 + DAY),
    makeMessage(DM, "D2", T0 + 2 * DAY)
  ]);
  // Chat counts are a derived projection, refreshed by the importer; without
  // this the list surface reports 0 messages for every chat.
  await repository.refreshChatStats();
}

// --- 1. The interval algebra ------------------------------------------------
// These run against the shared module both repositories import, so a passing
// algebra test means neither implementation can be quietly different.

describe("mute interval algebra", () => {
  const at = (intervals: MuteIntervalValue[], ms: number) => isMutedAt(intervals, ms);

  it("evaluates arbitrary mute → unmute → re-mute sequences", () => {
    const A = T0;
    const B = T0 + 10 * DAY;
    const C = T0 + 20 * DAY;
    let intervals = mergeMuteIntervals([], A, "user");
    intervals = truncateMuteIntervals(intervals, B);
    intervals = mergeMuteIntervals(intervals, C, "user");

    expect(at(intervals, A - DAY)).toBe(false);
    expect(at(intervals, A)).toBe(true);
    expect(at(intervals, B - DAY)).toBe(true);
    expect(at(intervals, B)).toBe(false);
    expect(at(intervals, C - DAY)).toBe(false);
    expect(at(intervals, C)).toBe(true);
    expect(at(intervals, C + 100 * DAY)).toBe(true);
  });

  it("erases everything when the unmute predates the mute", () => {
    const intervals = truncateMuteIntervals(mergeMuteIntervals([], T0 + 5 * DAY, "user"), T0);
    expect(intervals).toEqual([]);
    expect(at(intervals, T0 + 100 * DAY)).toBe(false);
  });

  it("merges an earlier mute into one canonical range rather than overlapping ones", () => {
    const first = mergeMuteIntervals([], T0 + 10 * DAY, "user");
    const merged = mergeMuteIntervals(first, T0, "user");
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ startMs: T0, endMs: null });
  });

  it("merges a range that is merely adjacent to the new mute", () => {
    const closed: MuteIntervalValue[] = [{ startMs: T0, endMs: T0 + 5 * DAY, origin: "user" }];
    const merged = mergeMuteIntervals(closed, T0 + 5 * DAY, "user");
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ startMs: T0, endMs: null });
  });

  it("treats a zero-length tombstone as inert in every evaluation", () => {
    const tombstone: MuteIntervalValue[] = [{ startMs: T0, endMs: T0, origin: "user" }];
    expect(activeMuteIntervals(tombstone)).toEqual([]);
    expect(at(tombstone, T0)).toBe(false);
    expect(spanOverlapsMute(tombstone, T0 - DAY, T0 + DAY)).toBe(false);
    expect(isFullyMuted(tombstone)).toBe(false);
  });

  it("hides an episode that merely straddles a mute boundary", () => {
    const intervals = mergeMuteIntervals([], T0 + 5 * DAY, "user");
    // Episode ends one day INTO the muted range: any overlap counts.
    expect(spanOverlapsMute(intervals, T0, T0 + 6 * DAY)).toBe(true);
    // Episode entirely before the mute is untouched.
    expect(spanOverlapsMute(intervals, T0, T0 + 4 * DAY)).toBe(false);
  });
});

// --- 2. Storage, defaults, and the mirror -----------------------------------

describe.each([
  ["sqlite", async () => sqliteRepository()],
  ["memory", async () => new MemoryArchiveRepository()]
] as const)("mute state (%s)", (_name, make) => {
  it("round-trips mute, unmute, and re-mute", async () => {
    const repository = await make();
    await seed(repository);

    expect((await repository.getChatMuteState(GROUP)).muted).toBe(false);

    const muted = await repository.muteChat(GROUP, { fromMs: T0 + 2 * DAY });
    expect(muted.muted).toBe(true);
    expect(muted.mutedSinceMs).toBe(T0 + 2 * DAY);

    const unmuted = await repository.unmuteChat(GROUP, { fromMs: T0 + 4 * DAY });
    expect(unmuted.muted).toBe(false);
    expect(unmuted.intervals).toEqual([{ startMs: T0 + 2 * DAY, endMs: T0 + 4 * DAY, origin: "user" }]);

    const remuted = await repository.muteChat(GROUP, { fromMs: T0 + 6 * DAY });
    expect(remuted.muted).toBe(true);
    expect(remuted.intervals).toHaveLength(2);
  });

  it("reports a fully muted chat, and only a fully muted one", async () => {
    const repository = await make();
    await seed(repository);
    await repository.muteChat(GROUP, { fromMs: 0 });
    await repository.muteChat(DM, { fromMs: T0 + DAY });
    expect(await repository.listFullyMutedChatSourceIds()).toEqual([GROUP]);
  });

  it("is born muted for a channel, and never resurrects the default after an unmute", async () => {
    const repository = await make();
    await repository.upsertChats("import", [makeChat(CHANNEL, "community")]);
    await repository.upsertMessages([makeMessage(CHANNEL, "C1", T0)]);

    const born = await repository.getChatMuteState(CHANNEL);
    expect(born.muted).toBe(true);
    expect(born.origin).toBe("channel-default");
    expect(born.mutedSinceMs).toBe(0);

    await repository.unmuteChat(CHANNEL, { fromMs: 0 });
    expect((await repository.getChatMuteState(CHANNEL)).muted).toBe(false);

    // Seeing the channel again (a later sync) must NOT re-apply the default.
    await repository.upsertChats("import", [makeChat(CHANNEL, "community")]);
    expect((await repository.getChatMuteState(CHANNEL)).muted).toBe(false);
  });
});

// --- 3. Write-side suppression ----------------------------------------------

describe.each([
  ["sqlite", async () => sqliteRepository()],
  ["memory", async () => new MemoryArchiveRepository()]
] as const)("write-side suppression (%s)", (_name, make) => {
  it("removes muted messages from backlog and from the coverage universe", async () => {
    const repository = await make();
    await seed(repository);

    const before = await repository.getBrainStatus();
    expect(before.totalVisibleMessages).toBe(5);
    expect((await repository.getBrainChatBacklog({ limit: 10 })).map((row) => row.chatSourceId).sort()).toEqual([GROUP, DM]);

    await repository.muteChat(GROUP, { fromMs: 0 });

    const after = await repository.getBrainStatus();
    // The group's three messages leave the universe entirely — neither pending
    // nor assimilated — so coverage can still reach 100%.
    expect(after.totalVisibleMessages).toBe(2);
    expect(after.chatsWithBacklog).toBe(1);
    expect((await repository.getBrainChatBacklog({ limit: 10 })).map((row) => row.chatSourceId)).toEqual([DM]);
  });

  it("keeps pre-mute history selectable when only part of a history is muted", async () => {
    const repository = await make();
    await seed(repository);
    await repository.muteChat(GROUP, { fromMs: T0 + 2 * DAY });

    const backlog = await repository.getBrainChatBacklog({ limit: 10, chatSourceId: GROUP });
    // M1 (T0) and M2 (T0+1d) are before the mute; M3 (T0+5d) is inside it.
    expect(backlog[0]?.pendingVisibleMessages).toBe(2);
  });

  it("makes muted messages unreachable as evidence", async () => {
    const repository = await make();
    await seed(repository);
    await repository.muteChat(GROUP, { fromMs: 0 });

    const evidence = await repository.listMemoryEvidenceMessages({ limit: 100 });
    expect(evidence.every((message) => message.sourceChatId !== GROUP)).toBe(true);
    expect(evidence.some((message) => message.sourceChatId === DM)).toBe(true);
  });

  it("drops queued tasks for a chat when it is muted, and refuses to enqueue new ones", async () => {
    const repository = await make();
    await seed(repository);
    await repository.enqueueBrainTasks([
      { kind: "episode", chatSourceId: GROUP, dedupeKey: `episode:${GROUP}:0`, payload: {}, priority: 1 }
    ]);
    expect((await repository.getBrainTaskSummary()).pending).toBe(1);

    await repository.muteChat(GROUP, { fromMs: 0 });
    expect((await repository.getBrainTaskSummary()).pending).toBe(0);

    // Even handed the chat directly, the scheduler refuses it.
    const enqueued = await enqueueEpisodeTasksForChats(repository, [
      {
        chatSourceId: GROUP,
        chatDisplayName: null,
        assimilatedThroughMs: 0,
        assimilatedThroughId: 0,
        lastEpisodeAt: null,
        pendingVisibleMessages: 3,
        newestVisibleMs: T0 + 5 * DAY
      }
    ]);
    expect(enqueued).toBe(0);
  });

  it("freezes the watermark and resumes past the hole after a later unmute", async () => {
    const repository = await make();
    await seed(repository);

    await repository.muteChat(GROUP, { fromMs: T0 });
    // Nothing selectable while fully muted from the first message onward.
    expect(await repository.getBrainChatBacklog({ limit: 10, chatSourceId: GROUP })).toEqual([]);

    // Unmute from after M2: the [T0, T0+2d) hole must never be selected again.
    await repository.unmuteChat(GROUP, { fromMs: T0 + 2 * DAY });
    const backlog = await repository.getBrainChatBacklog({ limit: 10, chatSourceId: GROUP });
    expect(backlog[0]?.pendingVisibleMessages).toBe(1);

    await repository.advanceBrainWatermark(GROUP, T0 + 5 * DAY);
    // Watermark advanced past the hole without ever claiming its messages.
    expect(await repository.getBrainChatBacklog({ limit: 10, chatSourceId: GROUP })).toEqual([]);
    await repository.muteChat(GROUP, { fromMs: 0 });
    await repository.unmuteChat(GROUP, { fromMs: 0 });
    const status = await repository.getBrainStatus();
    expect(status.assimilatedVisibleMessages).toBeLessThanOrEqual(status.totalVisibleMessages);
  });
});

// --- 4. Read-side hiding, bypass producers, and the doc tier ----------------
// SQLite only: these exercise the SQL predicates and the graph/doc machinery.

describe("read-side hiding (sqlite)", () => {
  async function seedWithEpisodes(): Promise<SqliteArchiveRepository> {
    const repository = await sqliteRepository();
    await seed(repository);
    await repository.commitBrainEpisode(makeEpisode(GROUP, T0, T0 + DAY, "group episode"));
    await repository.commitBrainEpisode(makeEpisode(DM, T0 + DAY, T0 + 2 * DAY, "dm episode"));
    await repository.syncBrainGraphSignals();
    return repository;
  }

  it("hides muted episodes from listings while keeping them stored and fetchable by id", async () => {
    const repository = await seedWithEpisodes();
    const before = await repository.listBrainEpisodes({ limit: 50 });
    expect(before).toHaveLength(2);
    const groupEpisodeId = before.find((episode) => episode.chatSourceId === GROUP)!.id;

    await repository.muteChat(GROUP, { fromMs: 0 });

    const after = await repository.listBrainEpisodes({ limit: 50 });
    expect(after.map((episode) => episode.chatSourceId)).toEqual([DM]);
    expect(after).toHaveLength(1);
    // Hidden, never deleted: still there by id, and back in the muted view.
    expect(await repository.listBrainEpisodes({ episodeId: groupEpisodeId, limit: 1 })).toHaveLength(1);
    const hidden = await repository.listBrainEpisodes({ onlyMuted: true, limit: 50 });
    expect(hidden.map((episode) => episode.id)).toEqual([groupEpisodeId]);

    // Unmute restores it with no regeneration.
    await repository.unmuteChat(GROUP, { fromMs: 0 });
    expect((await repository.listBrainEpisodes({ limit: 50 })).map((episode) => episode.chatSourceId).sort()).toEqual([GROUP, DM]);
  });

  it("hides an episode that only straddles the mute boundary", async () => {
    const repository = await sqliteRepository();
    await seed(repository);
    await repository.commitBrainEpisode(makeEpisode(GROUP, T0, T0 + 6 * DAY, "straddler"));
    await repository.muteChat(GROUP, { fromMs: T0 + 5 * DAY });
    expect(await repository.listBrainEpisodes({ limit: 50 })).toHaveLength(0);
  });

  it("hides muted commitments from lifecycle counts entirely, not just from the list", async () => {
    const repository = await sqliteRepository();
    await seed(repository);
    const episode = makeEpisode(GROUP, T0, T0 + DAY, "promise");
    episode.claims = [
      { kind: "commitment", text: "I will send the deck", citations: [messageKey(GROUP, "M1")], confidence: "stated" }
    ];
    await repository.commitBrainEpisode(episode);

    const before = await repository.listBrainLifecycleItems({ status: "all" });
    expect(before.items).toHaveLength(1);
    expect(before.counts.open).toBe(1);

    await repository.muteChat(GROUP, { fromMs: 0 });
    const after = await repository.listBrainLifecycleItems({ status: "all" });
    expect(after.items).toHaveLength(0);
    // A hidden item must not inflate a count it can never be clicked from.
    expect(after.counts.open).toBe(0);
    expect((await repository.listBrainLifecycleItems({ status: "all", onlyMuted: true })).items).toHaveLength(1);
  });

  it("keeps no muted-derived node, suggestion, or vocabulary in the bypass producers", async () => {
    const repository = await seedWithEpisodes();
    expect(await repository.listBrainTopicVocabulary(DM, 20)).toContain("topic for group episode");

    await repository.muteChat(GROUP, { fromMs: 0 });
    await repository.syncBrainGraphSignals();

    // Topic vocabulary: a topic whose only support is muted is not offered.
    expect(await repository.listBrainTopicVocabulary(DM, 20)).not.toContain("topic for group episode");
    // Person co-citation: no pair may be evidenced by a muted episode.
    const pairs = await repository.listCoCitedIdentityPairs({ minEpisodes: 1, limit: 50 });
    expect(pairs.every((pair) => pair.jidA !== GROUP && pair.jidB !== GROUP)).toBe(true);
    // Graph: the muted chat's own node is gone from stats and search.
    expect((await repository.searchBrainGraphNodes("Chat", 20)).every((node) => node.jid !== GROUP)).toBe(true);
  });

  it("keeps a person visible when only some of their evidence is muted", async () => {
    const repository = await seedWithEpisodes();
    const before = await repository.getBrainGraphEntity({ jid: DM });
    expect(before).not.toBeNull();
    // DM is cited by BOTH episodes; muting the group must not hide the person.
    await repository.muteChat(GROUP, { fromMs: 0 });
    const after = await repository.getBrainGraphEntity({ jid: DM });
    expect(after).not.toBeNull();
    // But their muted evidence is gone from the page.
    expect(after!.claims.every((claim) => claim.chatSourceId !== GROUP)).toBe(true);
  });

  it("scopes the projection read to one chat so a mute reconciles only its files", async () => {
    const repository = await seedWithEpisodes();
    // The whole point of the scoped read: a mute must not have to walk every
    // episode in the archive to reconcile one chat's files.
    expect((await repository.listBrainEpisodeProjections({ limit: 50 })).length).toBe(2);
    expect((await repository.listBrainEpisodeProjections({ chatSourceId: GROUP, limit: 50 })).map((row) => row.chatSourceId)).toEqual([
      GROUP
    ]);

    await repository.muteChat(GROUP, { fromMs: 0 });
    // Visible for that chat: none. And `onlyMuted` names exactly the files the
    // reconcile has to delete — the same rows, inverted.
    expect(await repository.listBrainEpisodeProjections({ chatSourceId: GROUP, limit: 50 })).toHaveLength(0);
    const hidden = await repository.listBrainEpisodeProjections({ chatSourceId: GROUP, onlyMuted: true, limit: 50 });
    expect(hidden.map((row) => row.chatSourceId)).toEqual([GROUP]);
    // The unmuted chat is untouched by either read.
    expect(await repository.listBrainEpisodeProjections({ chatSourceId: DM, onlyMuted: true, limit: 50 })).toHaveLength(0);
    expect(await repository.listBrainEpisodeProjections({ chatSourceId: DM, limit: 50 })).toHaveLength(1);
  });

  it("excludes muted episodes from the vault projection so unmute restores the files", async () => {
    const repository = await seedWithEpisodes();
    expect(await repository.listBrainEpisodeProjections({ limit: 50 })).toHaveLength(2);
    await repository.muteChat(GROUP, { fromMs: 0 });
    expect((await repository.listBrainEpisodeProjections({ limit: 50 })).map((row) => row.chatSourceId)).toEqual([DM]);
    await repository.unmuteChat(GROUP, { fromMs: 0 });
    expect(await repository.listBrainEpisodeProjections({ limit: 50 })).toHaveLength(2);
  });

  // These are the paths that SPEND: regeneration re-runs episodes through a
  // model, and the closure sweep reviews candidates. Muting must stop both.
  it("never offers a muted episode for regeneration", async () => {
    const repository = await sqliteRepository();
    await seed(repository);
    const extractive = makeEpisode(GROUP, T0, T0 + DAY, "placeholder");
    extractive.generator = "extractive";
    extractive.model = null;
    await repository.commitBrainEpisode(extractive);
    const dm = makeEpisode(DM, T0 + DAY, T0 + 2 * DAY, "dm placeholder");
    dm.generator = "extractive";
    dm.model = null;
    await repository.commitBrainEpisode(dm);

    expect(await repository.countRegenerableBrainEpisodes(2)).toBe(2);
    await repository.muteChat(GROUP, { fromMs: 0 });
    // The count the UI offers must match what regeneration would select.
    expect(await repository.countRegenerableBrainEpisodes(2)).toBe(1);
    const selectable = await repository.listRegenerableBrainEpisodes({ currentVersion: 2, onlyExtractive: true, limit: 50 });
    expect(selectable.every((episode) => episode.chatSourceId !== GROUP)).toBe(true);
  });

  it("keeps muted episodes out of resolution debt and validation issues", async () => {
    const repository = await sqliteRepository();
    await seed(repository);
    const episode = makeEpisode(GROUP, T0, T0 + DAY, "unresolved");
    episode.unresolvedParticipants = ["919999999999@s.whatsapp.net"];
    const committed = await repository.commitBrainEpisode(episode);
    await repository.recordBrainValidationIssues([
      { runId: null, chatSourceId: GROUP, episodeId: committed.id, claimSequence: null, code: "test_issue", severity: "warning", detail: "x" }
    ]);

    expect((await repository.getBrainResolutionDebt({ limit: 5 })).episodesWithUnresolved).toBe(1);
    expect((await repository.getBrainValidationIssueSummary()).warning).toBe(1);

    await repository.muteChat(GROUP, { fromMs: 0 });
    // Saving a contact to repair prose nobody can open is busywork, and a
    // quality complaint about a hidden episode is a dead end.
    expect((await repository.getBrainResolutionDebt({ limit: 5 })).episodesWithUnresolved).toBe(0);
    expect((await repository.getBrainValidationIssueSummary()).warning ?? 0).toBe(0);
    // Still stored, and still reachable by direct episode reference.
    expect(await repository.listBrainValidationIssues({ episodeId: committed.id })).toHaveLength(1);
  });

  it("keeps muted episodes out of the media-gap demand signal", async () => {
    const repository = await sqliteRepository();
    await seed(repository);
    const episode = makeEpisode(GROUP, T0, T0 + DAY, "with a gap");
    episode.mediaGaps = [
      { sourceMessageKey: messageKey(GROUP, "M2"), modality: "image", impact: "blocks", note: null }
    ];
    await repository.commitBrainEpisode(episode);
    expect((await repository.getBrainMediaGapSummary()).some((row) => row.count > 0)).toBe(true);
    expect(await repository.listBrainEpisodesWithMediaGaps({ impact: "blocks", limit: 10 })).toHaveLength(1);

    await repository.muteChat(GROUP, { fromMs: 0 });
    // A muted episode must not keep asking for media it will never interpret.
    expect((await repository.getBrainMediaGapSummary()).every((row) => row.count === 0)).toBe(true);
    expect(await repository.listBrainEpisodesWithMediaGaps({ impact: "blocks", limit: 10 })).toHaveLength(0);
  });

  it("reports what a muted chat has archived, distinct from what piled up", async () => {
    const repository = await sqliteRepository();
    await seed(repository);
    await repository.muteChat(GROUP, { fromMs: 0 });
    const row = (await repository.listMutedChats()).items.find((item) => item.chatSourceId === GROUP)!;
    // Archived is everything ever stored; piled-up is only what the brain never
    // got to. An empty subscription stub must be distinguishable from a chat
    // holding back real volume.
    expect(row.archivedMessages).toBe(3);
    expect(row.piledUpMessages).toBe(3);
    await repository.advanceBrainWatermark(GROUP, T0 + 10 * DAY);
    const after = (await repository.listMutedChats()).items.find((item) => item.chatSourceId === GROUP)!;
    expect(after.archivedMessages).toBe(3);
    expect(after.piledUpMessages).toBe(0);
  });

  it("stops offering muted claims to the grading sampler while keeping existing grades", async () => {
    const repository = await seedWithEpisodes();
    const sample = await repository.listClaimsForGrading({ perModel: 10 });
    const groupClaim = sample.models.flatMap((entry) => entry.claims).find((claim) => claim.chatSourceId === GROUP);
    expect(groupClaim).toBeDefined();
    const graded = await repository.upsertBrainClaimGrade(groupClaim!.claimId, "supported");

    await repository.muteChat(GROUP, { fromMs: 0 });
    const after = await repository.listClaimsForGrading({ perModel: 10, includeGraded: true });
    expect(after.models.flatMap((entry) => entry.claims).every((claim) => claim.chatSourceId !== GROUP)).toBe(true);
    // The grade itself is user-authored ground truth: muting is not a
    // retraction, so it still counts in the quality aggregates.
    expect(graded.grade).toBe("supported");
    const aggregates = await repository.getBrainModelQualityAggregates();
    expect(aggregates.some((row) => row.gradedTotal > 0)).toBe(true);
  });

  it("leaves mute intervals standing through a full brain reset", async () => {
    const repository = await seedWithEpisodes();
    await repository.muteChat(GROUP, { fromMs: 0 });
    await repository.resetBrainDerivedData();
    // Mute is user INTENT, not derived data: a wipe must not silently unmute.
    expect((await repository.getChatMuteState(GROUP)).muted).toBe(true);
  });
});

// --- 5. The doc tier: clean / hybrid / muted --------------------------------

describe("doc muted classification (sqlite)", () => {
  // Commits a real page fed by the given claims, so the classifier is exercised
  // over an actual current revision rather than an empty doc table.
  async function rollUpPage(
    repository: SqliteArchiveRepository,
    fedClaimIds: string[]
  ): Promise<{ docId: string }> {
    // Both episodes cite this person, so their node is the page fed by both.
    const entity = await repository.getBrainGraphEntity({ jid: DM });
    expect(entity).toBeDefined();
    const node = entity!.node;
    const docId = `entity:${node.slug}`;
    await repository.commitBrainDocRevision({
      docId,
      kind: "entity",
      nodeId: node.id,
      slug: node.slug,
      sections: [
        {
          title: "What we know",
          statements: fedClaimIds.map((claimId) => ({ text: `statement for ${claimId}`, claimIds: [claimId] }))
        }
      ],
      drops: [],
      resolutions: [],
      allowedCitesByClaim: new Map(),
      fedClaimIds,
      inputStats: { claimCount: fedClaimIds.length, tokenEstimate: 100, overflow: false, tiersEngaged: ["claims"] },
      model: "test-model",
      effort: null,
      runId: null,
      promptVersion: 1
    });
    return { docId };
  }

  // Dueness has a pre-existing floor (rollupMinClaims, default 5): a page with
  // too little left to say is not worth a model call. The fixture therefore
  // gives the DM enough claims to clear the floor on its own, so "muting marks
  // the page due" is tested against real policy rather than around it.
  async function seedTwoChatPage(): Promise<{ repository: SqliteArchiveRepository; groupClaims: string[]; dmClaims: string[] }> {
    const repository = await sqliteRepository();
    await seed(repository);
    // Both chats cite the same person, so one entity page can be fed by both.
    const groupEpisode = await repository.commitBrainEpisode(withClaims(makeEpisode(GROUP, T0, T0 + DAY, "group episode"), 3));
    const dmEpisode = await repository.commitBrainEpisode(withClaims(makeEpisode(DM, T0 + DAY, T0 + 2 * DAY, "dm episode"), 6));
    return {
      repository,
      groupClaims: groupEpisode.claims.map((claim) => claim.id),
      dmClaims: dmEpisode.claims.map((claim) => claim.id)
    };
  }

  it("keeps a hybrid page on normal surfaces and hides an exclusively muted one", async () => {
    const { repository, groupClaims, dmClaims } = await seedTwoChatPage();
    const { docId } = await rollUpPage(repository, [...groupClaims, ...dmClaims]);

    expect((await repository.listBrainDocs({ limit: 100 })).items.find((item) => item.docId === docId)?.mutedState).toBe("clean");

    // Half its sources muted → hybrid: still listed, still projected, flagged.
    await repository.muteChat(GROUP, { fromMs: 0 });
    const hybrid = (await repository.listBrainDocs({ limit: 100 })).items.find((item) => item.docId === docId);
    expect(hybrid?.mutedState).toBe("hybrid");
    expect((await repository.listBrainDocsForProjection()).some((entry) => entry.context.docId === docId)).toBe(true);

    // Every source muted → hidden from normal surfaces and from the vault,
    // but present in the muted view and never deleted.
    await repository.muteChat(DM, { fromMs: 0 });
    expect((await repository.listBrainDocs({ limit: 100 })).items.some((item) => item.docId === docId)).toBe(false);
    expect((await repository.listBrainDocs({ limit: 100, onlyMuted: true })).items.some((item) => item.docId === docId)).toBe(true);
    expect((await repository.listBrainDocsForProjection()).some((entry) => entry.context.docId === docId)).toBe(false);

    // Unmuting restores it exactly, with no regeneration.
    await repository.unmuteChat(GROUP, { fromMs: 0 });
    await repository.unmuteChat(DM, { fromMs: 0 });
    expect((await repository.listBrainDocs({ limit: 100 })).items.find((item) => item.docId === docId)?.mutedState).toBe("clean");
    expect((await repository.listBrainDocsForProjection()).some((entry) => entry.context.docId === docId)).toBe(true);
  });

  it("marks an affected page due and drops muted claims from its next rollup scope", async () => {
    const { repository, groupClaims, dmClaims } = await seedTwoChatPage();
    const { docId } = await rollUpPage(repository, [...groupClaims, ...dmClaims]);
    const rowOf = async () => (await repository.listBrainDocs({ limit: 100 })).items.find((item) => item.docId === docId);

    const before = await rowOf();
    expect(before?.due).toBe(false);
    expect(before?.eligibleClaims).toBe(9);

    await repository.muteChat(GROUP, { fromMs: 0 });
    const after = await rowOf();
    // Due, so the NORMAL cadence will drain it — but not re-rolled: muting
    // forces no model call, and the existing revision stands untouched.
    expect(after?.due).toBe(true);
    expect(after?.revision).toBe(1);
    // The muted chat's 3 claims left the rollup scope, so the next roll cannot
    // put muted material back into the prose.
    expect(after?.eligibleClaims).toBe(6);
  });

  it("is idempotent and repairable through a full recompute", async () => {
    const { repository, groupClaims, dmClaims } = await seedTwoChatPage();
    await rollUpPage(repository, [...groupClaims, ...dmClaims]);
    await repository.muteChat(GROUP, { fromMs: 0 });
    const before = (await repository.listBrainDocs({ limit: 100 })).items;
    // A repair pass over already-correct state changes nothing. (The response
    // carries an as-of clock, so the comparison is over the rows themselves.)
    expect((await repository.recomputeDocMutedStates()).docsUpdated).toBe(0);
    expect((await repository.listBrainDocs({ limit: 100 })).items).toEqual(before);
  });

  it("keeps mute state out of the chats surface entirely", async () => {
    const repository = await sqliteRepository();
    await seed(repository);
    await repository.muteChat(GROUP, { fromMs: 0 });

    // Ingestion untouched: the chat still lists, still carries every message.
    const chats = await repository.listChats({ limit: 50, offset: 0 });
    const group = chats.find((chat) => chat.sourceChatId === GROUP);
    expect(group).toBeDefined();
    expect(group!.muted).toBe(true);
    expect(group!.messageCount).toBe(3);
    // And the filter is available without changing the default view.
    expect((await repository.listChats({ limit: 50, offset: 0, muted: true })).map((chat) => chat.sourceChatId)).toEqual([GROUP]);
    expect((await repository.listChats({ limit: 50, offset: 0, muted: false })).map((chat) => chat.sourceChatId)).toEqual([DM]);
  });
});
