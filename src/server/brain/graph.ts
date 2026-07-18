// Knowledge-graph derivation core (change: knowledge-graph-foundation).
//
// Everything here is PURE: natural keys, slugs, payloads, the salience
// formula, and the episode→mutations derivation. Both repositories (SQLite
// and the in-memory test mirror) apply the same mutations, so the graph can
// never fork between them — parity by construction, and a from-scratch
// rebuild replaying committed episodes converges to the incremental state.
// Zero model calls anywhere in this module, by design.

import crypto from "node:crypto";
import type { BrainGraphEdgeKind, BrainGraphNodeKind } from "../../shared/types";

export const GRAPH_NODE_KINDS: readonly BrainGraphNodeKind[] = [
  "person",
  "chat",
  "topic",
  "org",
  "place",
  "project",
  "other",
  "commitment",
  "question",
  "event",
  "fact"
];

export const GRAPH_EDGE_KINDS: readonly BrainGraphEdgeKind[] = [
  "participates_in",
  "mentions",
  "about",
  "involves",
  "related_to",
  "replies_to",
  "derived_from",
  "alias_of",
  "resolves"
];

// --- Natural keys -----------------------------------------------------------
// The idempotency spine: every producer (commit, sync, rebuild) upserts by
// natural key, so re-application is a no-op and merges are mechanical.

export function normalizeGraphName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function personJidNaturalKey(jid: string): string {
  return `person:jid:${jid}`;
}

// Unresolved person entities are CHAT-scoped, never global: a bare "amit" in
// two chats stays two nodes (under-merge beats over-merge; consolidation is
// the person layer's job, with certainty-graded sources).
export function personNameNaturalKey(chatSourceId: string, name: string): string {
  return `person:name:${chatSourceId}:${normalizeGraphName(name)}`;
}

export function chatNaturalKey(chatSourceId: string): string {
  return `chat:${chatSourceId}`;
}

// Topics are NOCASE-unique by title in brain_topics; the normalized title is
// the stable identity (no id lookup needed at derivation time).
export function topicNaturalKey(title: string): string {
  return `topic:${normalizeGraphName(title)}`;
}

// org/place/project names ARE their identity (global); `other` is too vague to
// merge globally and stays chat-scoped.
export function entityNaturalKey(kind: "org" | "place" | "project" | "other", name: string, chatSourceId: string): string {
  return kind === "other" ? `other:${chatSourceId}:${normalizeGraphName(name)}` : `${kind}:${normalizeGraphName(name)}`;
}

export function claimNodeNaturalKey(kind: "commitment" | "question" | "event", claimId: string): string {
  return `${kind}:${claimId}`;
}

// --- Slugs ------------------------------------------------------------------
// Immutable human-readable ids assigned once at node creation (wikilink and
// projection currency for semantic-rollups later). Renames never touch them;
// collisions get a short natural-key hash suffix.

export function slugForGraphNode(kind: BrainGraphNodeKind, seed: string, naturalKey: string, isTaken: (slug: string) => boolean): string {
  const cleaned = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  const base = cleaned ? `${kind}-${cleaned}` : `${kind}-${shortHash(naturalKey)}`;
  if (!isTaken(base)) {
    return base;
  }
  return `${base}-${shortHash(naturalKey)}`;
}

function shortHash(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 6);
}

// --- Payloads ---------------------------------------------------------------

export interface CommitmentNodePayload {
  status: "open" | "closed";
  holderJid: string | null;
  dueMs: number | null;
}

export function parseGraphPayload(json: string | null | undefined): Record<string, unknown> | null {
  if (!json) {
    return null;
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// --- Salience ---------------------------------------------------------------
// D6 formula recomputed from evidence (never incremented blindly), with the
// review's amendment: open commitments/questions are exempt from dormancy and
// get a due-proximity boost; dormancy hides, never deletes.

export const GRAPH_DORMANCY_DEFAULT = 0.25;
const DUE_BOOST_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const EVIDENCE_HALF_LIFE_DAYS = 90;

export function graphDormancyThreshold(): number {
  // Number("") is 0 — an unset env var must fall through to the default, so
  // only a non-empty, finite, non-negative value overrides it.
  const raw = process.env.WAPP_BRAIN_SALIENCE_DORMANT;
  if (raw != null && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return GRAPH_DORMANCY_DEFAULT;
}

export interface GraphSalienceInput {
  kind: BrainGraphNodeKind;
  payload: Record<string, unknown> | null;
  citations: number;
  evidenceDays: number;
  lastEvidenceAtMs: number | null;
  nowMs: number;
  // Bounded person-node relationship-strength input from engagement
  // aggregates; 1.0 when absent. Display-rank input, never a truth signal.
  engagementFactor: number;
  dormancyThreshold: number;
}

export function computeGraphSalience(input: GraphSalienceInput): { salience: number; dormant: boolean } {
  const lifecycleOpen =
    (input.kind === "commitment" || input.kind === "question") && (input.payload?.status ?? "open") === "open";
  if (input.citations <= 0 || input.lastEvidenceAtMs == null) {
    return { salience: 0, dormant: !lifecycleOpen };
  }
  const daysSince = Math.max(0, (input.nowMs - input.lastEvidenceAtMs) / (24 * 60 * 60 * 1000));
  const engagement = Math.min(1.25, Math.max(1, input.engagementFactor || 1));
  let salience =
    Math.log(1 + input.citations) *
    Math.log(1 + Math.max(1, input.evidenceDays)) *
    Math.exp(-daysSince / EVIDENCE_HALF_LIFE_DAYS) *
    engagement;
  if (lifecycleOpen) {
    const dueMs = typeof input.payload?.dueMs === "number" ? (input.payload.dueMs as number) : null;
    if (dueMs != null) {
      // Approaching due date ramps toward 2×; overdue stays at the full boost
      // (an overdue open commitment is the last thing that should fade).
      salience *= dueMs <= input.nowMs ? 2 : 1 + Math.max(0, 1 - (dueMs - input.nowMs) / DUE_BOOST_WINDOW_MS);
    }
    return { salience, dormant: false };
  }
  return { salience, dormant: salience < input.dormancyThreshold };
}

// --- Episode → graph derivation --------------------------------------------

export interface GraphNodeSpec {
  naturalKey: string;
  kind: BrainGraphNodeKind;
  title: string | null;
  jid: string | null;
  chatScope: string | null;
  payload: Record<string, unknown> | null;
  slugSeed: string;
  seenAtMs: number | null;
}

export interface GraphEvidenceSpec {
  key: string;
  claimId?: string | null;
  sourceMessageKey?: string | null;
  sourceRef?: string | null;
  observedAtMs?: number | null;
}

export interface GraphEdgeMutation {
  srcKey: string;
  dstKey: string;
  kind: BrainGraphEdgeKind;
  evidence: GraphEvidenceSpec;
}

export interface GraphMutations {
  nodes: Map<string, GraphNodeSpec>;
  claimLinks: Array<{ nodeKey: string; claimId: string }>;
  edges: GraphEdgeMutation[];
  aliases: Array<{ nodeKey: string; alias: string; source: string }>;
}

export interface GraphEpisodeSource {
  id: string;
  chatSourceId: string;
  startAtMs: number;
  endAtMs: number;
  generator: "model" | "extractive";
  topics: string[];
  claims: Array<{
    id: string;
    kind: "fact" | "decision" | "commitment" | "question" | "event";
    text: string;
    eventAtMs: number | null;
    validUntilMs: number | null;
    entities: Array<{ kind: "person" | "org" | "place" | "project" | "other"; name: string; jid: string | null; role: string | null }>;
    citations: Array<{ sourceMessageKey: string; senderSourceJid: string | null; timestampMs: number | null }>;
  }>;
}

export interface EpisodeGraphContext {
  canonicalJid: (jid: string) => string | null;
  // Authoritative structured mentions (source_mask & 2) on messages inside the
  // episode window — derivable from committed archive state, so rebuild sees
  // exactly what commit saw.
  windowMentions: Array<{
    mentionedJid: string;
    senderJid: string | null;
    sourceMessageKey: string;
    timestampMs: number | null;
  }>;
  // Window replies whose captured quoted snapshot resolved to an archived
  // message key.
  windowReplies: Array<{
    replySourceMessageKey: string;
    replySenderJid: string | null;
    quotedSourceMessageKey: string;
    timestampMs: number | null;
  }>;
  // Natural keys of EXISTING lifecycle nodes (commitment/question) whose
  // claims cite the given message — the deferred reply-quote edge target.
  lifecycleTargetsForMessage: (sourceMessageKey: string) => string[];
  // Chat-wide replies (any window, either direction in time) quoting a message
  // cited by one of THIS episode's lifecycle claims — makes replies_to
  // order-insensitive between the reply's episode and the commitment's.
  inboundReplies: Array<{
    claimId: string;
    replySourceMessageKey: string;
    replySenderJid: string | null;
    timestampMs: number | null;
  }>;
}

const LIFECYCLE_CLAIM_KINDS = new Set(["commitment", "question"]);

// Derive the full graph contribution of one committed model episode. Pure and
// deterministic: same episode + same context → same mutations, which is what
// makes wipe-and-rebuild a real operation instead of a prayer.
export function deriveEpisodeGraph(episode: GraphEpisodeSource, ctx: EpisodeGraphContext): GraphMutations {
  const mutations: GraphMutations = { nodes: new Map(), claimLinks: [], edges: [], aliases: [] };
  // Extractive placeholders never consolidate: honest coverage, not knowledge.
  if (episode.generator !== "model") {
    return mutations;
  }
  const chatKey = chatNaturalKey(episode.chatSourceId);
  ensureNode(mutations, {
    naturalKey: chatKey,
    kind: "chat",
    title: null,
    jid: null,
    chatScope: episode.chatSourceId,
    payload: null,
    slugSeed: episode.chatSourceId.split("@")[0] ?? episode.chatSourceId,
    seenAtMs: episode.endAtMs
  });
  const topicKeys: string[] = [];
  for (const title of episode.topics) {
    const clean = title.trim();
    if (!clean) {
      continue;
    }
    const key = topicNaturalKey(clean);
    topicKeys.push(key);
    ensureNode(mutations, {
      naturalKey: key,
      kind: "topic",
      title: clean,
      jid: null,
      chatScope: null,
      payload: null,
      slugSeed: clean,
      seenAtMs: episode.endAtMs
    });
  }

  const lifecycleKeyByClaimId = new Map<string, string>();
  for (const claim of episode.claims) {
    const claimTimestamps = claim.citations.map((citation) => citation.timestampMs).filter((ts): ts is number => ts != null);
    const seenAtMs = claimTimestamps.length ? Math.max(...claimTimestamps) : episode.endAtMs;
    const claimEvidence: GraphEvidenceSpec = { key: `claim:${claim.id}`, claimId: claim.id, observedAtMs: seenAtMs };

    // Entity nodes + junctions + chat participation for anchored persons.
    const entityKeys: string[] = [];
    for (const entity of claim.entities) {
      const name = entity.name.trim();
      if (!name) {
        continue;
      }
      let nodeKey: string;
      if (entity.kind === "person") {
        const canonical = entity.jid ? ctx.canonicalJid(entity.jid) ?? entity.jid : null;
        if (canonical) {
          nodeKey = personJidNaturalKey(canonical);
          ensureNode(mutations, {
            naturalKey: nodeKey,
            kind: "person",
            title: null,
            jid: canonical,
            chatScope: null,
            payload: null,
            slugSeed: canonical.split("@")[0] ?? canonical,
            seenAtMs
          });
          // Surface forms collect as aliases (adjudication fuel, never joins).
          mutations.aliases.push({ nodeKey, alias: name, source: "entity" });
          mutations.edges.push({ srcKey: nodeKey, dstKey: chatKey, kind: "participates_in", evidence: claimEvidence });
        } else {
          nodeKey = personNameNaturalKey(episode.chatSourceId, name);
          ensureNode(mutations, {
            naturalKey: nodeKey,
            kind: "person",
            title: name,
            jid: null,
            chatScope: episode.chatSourceId,
            payload: null,
            slugSeed: name,
            seenAtMs
          });
        }
      } else {
        nodeKey = entityNaturalKey(entity.kind, name, episode.chatSourceId);
        ensureNode(mutations, {
          naturalKey: nodeKey,
          kind: entity.kind,
          title: name,
          jid: null,
          chatScope: entity.kind === "other" ? episode.chatSourceId : null,
          payload: null,
          slugSeed: name,
          seenAtMs
        });
      }
      entityKeys.push(nodeKey);
      mutations.claimLinks.push({ nodeKey, claimId: claim.id });
      // Entity ↔ topic co-occurrence, claim-scoped.
      for (const topicKey of topicKeys) {
        mutations.edges.push({ srcKey: nodeKey, dstKey: topicKey, kind: "about", evidence: claimEvidence });
      }
    }

    // Entity co-occurrence inside one claim (normalized src<dst so the pair is
    // direction-stable).
    for (let a = 0; a < entityKeys.length; a += 1) {
      for (let b = a + 1; b < entityKeys.length; b += 1) {
        const [src, dst] = entityKeys[a]! < entityKeys[b]! ? [entityKeys[a]!, entityKeys[b]!] : [entityKeys[b]!, entityKeys[a]!];
        if (src !== dst) {
          mutations.edges.push({ srcKey: src, dstKey: dst, kind: "related_to", evidence: claimEvidence });
        }
      }
    }

    // Lifecycle nodes: one per commitment/question claim (born open; the
    // commitment-lifecycle change owns transitions) and per dated event claim.
    if (LIFECYCLE_CLAIM_KINDS.has(claim.kind)) {
      const nodeKey = claimNodeNaturalKey(claim.kind as "commitment" | "question", claim.id);
      const holder = claim.entities.find((entity) => entity.kind === "person" && entity.jid);
      const payload: CommitmentNodePayload = {
        status: "open",
        holderJid: holder?.jid ? ctx.canonicalJid(holder.jid) ?? holder.jid : null,
        dueMs: claim.validUntilMs ?? claim.eventAtMs ?? null
      };
      ensureNode(mutations, {
        naturalKey: nodeKey,
        kind: claim.kind as BrainGraphNodeKind,
        title: truncateTitle(claim.text),
        jid: null,
        chatScope: episode.chatSourceId,
        payload: payload as unknown as Record<string, unknown>,
        slugSeed: claim.text,
        seenAtMs
      });
      lifecycleKeyByClaimId.set(claim.id, nodeKey);
      mutations.claimLinks.push({ nodeKey, claimId: claim.id });
      for (const entityKey of entityKeys) {
        mutations.edges.push({ srcKey: nodeKey, dstKey: entityKey, kind: "involves", evidence: claimEvidence });
      }
    } else if (claim.kind === "event" && claim.eventAtMs != null) {
      const nodeKey = claimNodeNaturalKey("event", claim.id);
      ensureNode(mutations, {
        naturalKey: nodeKey,
        kind: "event",
        title: truncateTitle(claim.text),
        jid: null,
        chatScope: episode.chatSourceId,
        payload: { eventAtMs: claim.eventAtMs },
        slugSeed: claim.text,
        seenAtMs
      });
      mutations.claimLinks.push({ nodeKey, claimId: claim.id });
      for (const entityKey of entityKeys) {
        mutations.edges.push({ srcKey: nodeKey, dstKey: entityKey, kind: "involves", evidence: claimEvidence });
      }
    }

    // Citing senders participate in the chat, evidenced by their exact
    // messages (derivable from committed citations — rebuild-safe).
    for (const citation of claim.citations) {
      if (!citation.senderSourceJid) {
        continue;
      }
      const canonical = ctx.canonicalJid(citation.senderSourceJid) ?? citation.senderSourceJid;
      const senderKey = personJidNaturalKey(canonical);
      ensureNode(mutations, {
        naturalKey: senderKey,
        kind: "person",
        title: null,
        jid: canonical,
        chatScope: null,
        payload: null,
        slugSeed: canonical.split("@")[0] ?? canonical,
        seenAtMs: citation.timestampMs ?? seenAtMs
      });
      mutations.edges.push({
        srcKey: senderKey,
        dstKey: chatKey,
        kind: "participates_in",
        evidence: {
          key: `msg:${citation.sourceMessageKey}`,
          sourceMessageKey: citation.sourceMessageKey,
          observedAtMs: citation.timestampMs ?? null
        }
      });
    }
  }

  // Authoritative structured mentions inside the window: sender → mentioned.
  for (const mention of ctx.windowMentions) {
    const mentionedCanonical = ctx.canonicalJid(mention.mentionedJid) ?? mention.mentionedJid;
    const mentionedKey = personJidNaturalKey(mentionedCanonical);
    ensureNode(mutations, {
      naturalKey: mentionedKey,
      kind: "person",
      title: null,
      jid: mentionedCanonical,
      chatScope: null,
      payload: null,
      slugSeed: mentionedCanonical.split("@")[0] ?? mentionedCanonical,
      seenAtMs: mention.timestampMs
    });
    if (!mention.senderJid) {
      continue;
    }
    const senderCanonical = ctx.canonicalJid(mention.senderJid) ?? mention.senderJid;
    if (senderCanonical === mentionedCanonical) {
      continue;
    }
    const senderKey = personJidNaturalKey(senderCanonical);
    ensureNode(mutations, {
      naturalKey: senderKey,
      kind: "person",
      title: null,
      jid: senderCanonical,
      chatScope: null,
      payload: null,
      slugSeed: senderCanonical.split("@")[0] ?? senderCanonical,
      seenAtMs: mention.timestampMs
    });
    mutations.edges.push({
      srcKey: senderKey,
      dstKey: mentionedKey,
      kind: "mentions",
      evidence: {
        key: `msg:${mention.sourceMessageKey}`,
        sourceMessageKey: mention.sourceMessageKey,
        observedAtMs: mention.timestampMs ?? null
      }
    });
  }

  // The deferred reply-quote edge (reply-quote-recovery → here): a reply whose
  // quoted target is cited by a lifecycle node links replier → node. Both
  // directions are derived (window replies against existing nodes, existing
  // replies against this episode's new nodes) so assimilation order cannot
  // drop the edge.
  const citedByLifecycleClaim = new Map<string, string[]>();
  for (const claim of episode.claims) {
    const lifecycleKey = lifecycleKeyByClaimId.get(claim.id);
    if (!lifecycleKey) {
      continue;
    }
    for (const citation of claim.citations) {
      const existing = citedByLifecycleClaim.get(citation.sourceMessageKey) ?? [];
      existing.push(lifecycleKey);
      citedByLifecycleClaim.set(citation.sourceMessageKey, existing);
    }
  }
  for (const reply of ctx.windowReplies) {
    const targets = new Set<string>([
      ...ctx.lifecycleTargetsForMessage(reply.quotedSourceMessageKey),
      ...(citedByLifecycleClaim.get(reply.quotedSourceMessageKey) ?? [])
    ]);
    if (!targets.size || !reply.replySenderJid) {
      continue;
    }
    addReplyEdges(mutations, ctx, reply.replySenderJid, [...targets], reply.replySourceMessageKey, reply.timestampMs);
  }
  for (const inbound of ctx.inboundReplies) {
    const lifecycleKey = lifecycleKeyByClaimId.get(inbound.claimId);
    if (!lifecycleKey || !inbound.replySenderJid) {
      continue;
    }
    addReplyEdges(mutations, ctx, inbound.replySenderJid, [lifecycleKey], inbound.replySourceMessageKey, inbound.timestampMs);
  }
  return mutations;
}

function addReplyEdges(
  mutations: GraphMutations,
  ctx: EpisodeGraphContext,
  senderJid: string,
  targetKeys: string[],
  replyMessageKey: string,
  timestampMs: number | null
): void {
  const canonical = ctx.canonicalJid(senderJid) ?? senderJid;
  const senderKey = personJidNaturalKey(canonical);
  ensureNode(mutations, {
    naturalKey: senderKey,
    kind: "person",
    title: null,
    jid: canonical,
    chatScope: null,
    payload: null,
    slugSeed: canonical.split("@")[0] ?? canonical,
    seenAtMs: timestampMs
  });
  for (const targetKey of targetKeys) {
    mutations.edges.push({
      srcKey: senderKey,
      dstKey: targetKey,
      kind: "replies_to",
      evidence: { key: `msg:${replyMessageKey}`, sourceMessageKey: replyMessageKey, observedAtMs: timestampMs ?? null }
    });
  }
}

function ensureNode(mutations: GraphMutations, spec: GraphNodeSpec): void {
  const existing = mutations.nodes.get(spec.naturalKey);
  if (!existing) {
    mutations.nodes.set(spec.naturalKey, spec);
    return;
  }
  // Widen the seen window; first non-null title/payload wins (titles are
  // display metadata only — read paths resolve live labels for identities).
  if (spec.seenAtMs != null && (existing.seenAtMs == null || spec.seenAtMs > existing.seenAtMs)) {
    existing.seenAtMs = spec.seenAtMs;
  }
  if (!existing.title && spec.title) {
    existing.title = spec.title;
  }
  if (!existing.payload && spec.payload) {
    existing.payload = spec.payload;
  }
}

function truncateTitle(text: string): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length > 140 ? `${clean.slice(0, 139)}…` : clean;
}

// Bounded engagement factor from read-rate: 1.0 (no data) to 1.25 (fully read
// conversations). Latency deliberately unused in v1 — calibrate with real
// dashboard data before weighting it.
export function engagementFactorFromAggregates(rows: Array<{ eligibleOutgoingCount: number; readCount: number }>): number {
  let eligible = 0;
  let read = 0;
  for (const row of rows) {
    eligible += Math.max(0, row.eligibleOutgoingCount);
    read += Math.max(0, Math.min(row.readCount, row.eligibleOutgoingCount));
  }
  if (eligible <= 0) {
    return 1;
  }
  return 1 + 0.25 * Math.min(1, read / eligible);
}
