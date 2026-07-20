// Bounded neighborhood read — pure shaping (change: graph-explorer).
//
// The repositories do only the WALK (anchor resolution + reachable rows via a
// recursive CTE in SQLite, an equivalent BFS in memory) and hand their raw
// results here. Everything downstream — clamping, hop-ordered capping, dedup,
// same-name disambiguation, DTO assembly — lives in this one pure module, so
// the two backends can only differ in "which rows", never in "how they're
// shaped". That is the mirror-parity guarantee, by construction. Zero DB, zero
// model calls here.

import { disambiguateLabels } from "../persons/disambiguate";
import { GRAPH_EDGE_KINDS } from "./graph";
import type {
  BrainGraphEdgeKind,
  BrainGraphNodeRecord,
  BrainGraphNodeStatus,
  BrainGraphNeighborhoodEdge,
  BrainGraphNeighborhoodFilters,
  BrainGraphNeighborhoodNode,
  BrainGraphNeighborhoodParams,
  BrainGraphNeighborhoodView
} from "../../shared/types";

// Server ceilings — a request may ask for less, never more.
export const NEIGHBORHOOD_LIMITS = {
  minDepth: 1,
  maxDepth: 2,
  defaultDepth: 1,
  defaultMaxNodes: 120,
  ceilMaxNodes: 500,
  defaultMaxEdges: 300,
  ceilMaxEdges: 1200,
  // Absolute discovery ceiling: a wedge-guard so a pathological hub anchor can
  // never materialize an unbounded set. Ordered deterministically before the
  // limit bites, so both backends truncate to the same rows. Kept well below
  // SQLite's bound-variable limit (used twice in the edge IN-set).
  maxDiscover: 2000
} as const;

export interface ResolvedNeighborhoodParams {
  depth: number;
  kinds: BrainGraphEdgeKind[] | null;
  since: number | null;
  until: number | null;
  minSalience: number;
  includeDormant: boolean;
  maxNodes: number;
  maxEdges: number;
  // Neighbor node statuses allowed during traversal (the anchor is exempt).
  statuses: BrainGraphNodeStatus[];
  maxDiscover: number;
}

function clampInt(value: number | null | undefined, min: number, max: number, fallback: number): number {
  if (value == null || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

// Deterministic, defensive clamping — identical for the route, the CLI, and
// tests, so a neighborhood request means the same thing whoever issues it.
export function resolveNeighborhoodParams(params: BrainGraphNeighborhoodParams): ResolvedNeighborhoodParams {
  const allowed = new Set<BrainGraphEdgeKind>(GRAPH_EDGE_KINDS);
  const kinds = params.kinds?.filter((kind) => allowed.has(kind)) ?? [];
  const dedupedKinds = kinds.length > 0 ? [...new Set(kinds)] : null;
  const since = params.since != null && Number.isFinite(params.since) ? Math.trunc(params.since) : null;
  const until = params.until != null && Number.isFinite(params.until) ? Math.trunc(params.until) : null;
  const minSalience = params.minSalience != null && Number.isFinite(params.minSalience) ? Math.max(0, params.minSalience) : 0;
  const includeDormant = params.includeDormant === true;
  return {
    depth: clampInt(params.depth, NEIGHBORHOOD_LIMITS.minDepth, NEIGHBORHOOD_LIMITS.maxDepth, NEIGHBORHOOD_LIMITS.defaultDepth),
    kinds: dedupedKinds,
    // A reversed window (since > until) is normalized so it never silently
    // matches nothing.
    since: since != null && until != null ? Math.min(since, until) : since,
    until: since != null && until != null ? Math.max(since, until) : until,
    minSalience,
    includeDormant,
    maxNodes: clampInt(params.maxNodes, 1, NEIGHBORHOOD_LIMITS.ceilMaxNodes, NEIGHBORHOOD_LIMITS.defaultMaxNodes),
    maxEdges: clampInt(params.maxEdges, 1, NEIGHBORHOOD_LIMITS.ceilMaxEdges, NEIGHBORHOOD_LIMITS.defaultMaxEdges),
    statuses: includeDormant ? ["active", "dormant"] : ["active"],
    maxDiscover: NEIGHBORHOOD_LIMITS.maxDiscover
  };
}

export interface NeighborhoodWalk {
  anchorId: string;
  redirected: boolean;
  // Reachable nodes with resolved labels and shortest hop (includes the anchor
  // at hop 0). Order-independent — shaping re-sorts deterministically.
  discovered: Array<{ record: BrainGraphNodeRecord; hop: number }>;
  // Qualifying edges among the discovered set (both endpoints discovered).
  edges: BrainGraphNeighborhoodEdge[];
  // The discovery ceiling clipped the reachable set.
  discoveryTruncated: boolean;
  // person_members-backed key per person JID in the discovered set: the person
  // id when the identity is a member, else the JID itself. Injected by the repo
  // so the pure disambiguation stays backend-agnostic.
  personKeyByJid: Map<string, string>;
  // All display names of the person behind each person JID (every linked
  // identity's label, even ones not in this neighborhood) — lets an unresolved
  // written name fold onto a person whose matching name is a linked alias.
  personAliasesByJid: Map<string, string[]>;
  // The archive owner: their display name, the person keys of their self-numbers,
  // and the full set of their own JIDs (self-numbers plus every linked identity).
  // Used to unify the "me" marker, the owner's self-number people, their own DM
  // chats, and exact mentions of the owner's name into one node.
  ownerInfo: { name: string | null; personKeys: string[]; selfJids: string[] } | null;
}

function sortNodesForCap(a: { record: BrainGraphNodeRecord; hop: number }, b: { record: BrainGraphNodeRecord; hop: number }): number {
  // Anchor first, then most-salient, then stable by id.
  if (a.hop === 0 && b.hop !== 0) return -1;
  if (b.hop === 0 && a.hop !== 0) return 1;
  if (b.record.salience !== a.record.salience) return b.record.salience - a.record.salience;
  return a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0;
}

function sortEdges(a: BrainGraphNeighborhoodEdge, b: BrainGraphNeighborhoodEdge): number {
  if (b.evidenceCount !== a.evidenceCount) return b.evidenceCount - a.evidenceCount;
  const bl = b.lastSeenAtMs ?? 0;
  const al = a.lastSeenAtMs ?? 0;
  if (bl !== al) return bl - al;
  return a.id - b.id;
}

const buildFilters = (params: ResolvedNeighborhoodParams): BrainGraphNeighborhoodFilters => ({
  depth: params.depth,
  kinds: params.kinds,
  since: params.since,
  until: params.until,
  minSalience: params.minSalience,
  includeDormant: params.includeDormant,
  maxNodes: params.maxNodes,
  maxEdges: params.maxEdges
});

// Two-level person model applied to the graph: identity nodes that belong to
// the same person (via person_members, surfaced as personKeyByJid) collapse
// into ONE representative node, and every edge rewires onto the representatives.
// Connect/disconnect in People therefore changes what the graph shows with zero
// stored graph changes. The anchor, when it's a person, is always its own
// group's representative so it stays the hub under its own identity.
function collapsePersonIdentities(
  discovered: Array<{ record: BrainGraphNodeRecord; hop: number }>,
  edges: BrainGraphNeighborhoodEdge[],
  personKeyByJid: Map<string, string>,
  personAliasesByJid: Map<string, string[]>,
  ownerInfo: { name: string | null; personKeys: string[]; selfJids: string[] } | null,
  anchorId: string
): { discovered: Array<{ record: BrainGraphNodeRecord; hop: number }>; edges: BrainGraphNeighborhoodEdge[] } {
  const entryById = new Map(discovered.map((entry) => [entry.record.id, entry]));
  const repByNodeId = new Map<string, string>();
  for (const entry of discovered) repByNodeId.set(entry.record.id, entry.record.id);

  // (1) Linked identities (person_members): every identity of one person merges.
  // The anchor is its own group's representative; otherwise the highest-salience
  // identity wins (JID tiebreak — stable across backends, unlike UUIDs).
  const groups = new Map<string, Array<{ record: BrainGraphNodeRecord; hop: number }>>();
  for (const entry of discovered) {
    if (entry.record.kind === "person" && entry.record.jid) {
      const key = personKeyByJid.get(entry.record.jid) ?? entry.record.jid;
      const bucket = groups.get(key);
      if (bucket) bucket.push(entry);
      else groups.set(key, [entry]);
    }
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const rep =
      members.find((member) => member.record.id === anchorId) ??
      [...members].sort((a, b) => b.record.salience - a.record.salience || ((a.record.jid ?? "") < (b.record.jid ?? "") ? -1 : 1))[0];
    for (const member of members) repByNodeId.set(member.record.id, rep.record.id);
  }

  // (2) Unresolved NAME nodes: the model named someone but could not attach a
  // number, so it minted a chat-scoped `person:name` node. Fold one onto the
  // resolved person of the DM it was seen in WHEN the names align — so "Misti"
  // written in Misti's own DM is the same node as the resolved "Misti AI".
  // Conservative on purpose (DM scope + name overlap), so a third party named in
  // someone's DM stays separate; this is deterministic display merging only and
  // never rewrites stored identity.
  const repIdForJid = new Map<string, string>();
  for (const entry of discovered) {
    if (entry.record.kind === "person" && entry.record.jid) {
      repIdForJid.set(entry.record.jid, repByNodeId.get(entry.record.id) ?? entry.record.id);
    }
  }
  const norm = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");
  const namesAlign = (name: string, label: string): boolean => {
    const a = norm(name);
    const b = norm(label);
    return a.length >= 3 && b.length >= 3 && (b.includes(a) || a.includes(b));
  };
  for (const entry of discovered) {
    const record = entry.record;
    const title = record.title;
    if (record.kind === "person" && !record.jid && record.chatScope && title) {
      const repId = repIdForJid.get(record.chatScope);
      // Match the written name against ALL of the DM person's names (every linked
      // identity, even ones off-screen) — "Misti" aligns with the linked "Misti
      // AI", not the number saved as "Me US (Mint)".
      const aliases = personAliasesByJid.get(record.chatScope);
      if (repId && aliases && aliases.some((label) => namesAlign(title, label))) {
        repByNodeId.set(record.id, repId);
      }
    }
  }

  // (3) A 1-on-1 chat IS that person's conversation: fold a DM chat node onto its
  // counterparty person so "X participates in X (their DM)" collapses to a single
  // X. Group chats (@g.us) stay their own nodes; the anchor is never folded away.
  for (const entry of discovered) {
    const record = entry.record;
    if (record.kind === "chat" && record.id !== anchorId && record.chatScope && !record.chatScope.endsWith("@g.us")) {
      const repId = repIdForJid.get(record.chatScope);
      if (repId) repByNodeId.set(record.id, repId);
    }
  }

  // (4) Owner unification: the archive owner is one person however they appear —
  // the "me" marker, the person(s) behind their self-numbers (and everything
  // already merged onto those), and unresolved mentions that EXACTLY match the
  // owner's own name. The "me" marker is preferred as the surviving label.
  if (ownerInfo && (ownerInfo.name || ownerInfo.personKeys.length > 0)) {
    const ownerName = ownerInfo.name ? norm(ownerInfo.name) : null;
    const ownerPersonKeys = new Set(ownerInfo.personKeys);
    const ownerSelfJids = new Set(ownerInfo.selfJids);
    const isOwnerNode = (record: BrainGraphNodeRecord): boolean => {
      if (record.kind === "person") {
        if (record.jid === "me") return true;
        if (record.jid) return ownerSelfJids.has(record.jid) || ownerPersonKeys.has(personKeyByJid.get(record.jid) ?? record.jid);
        return Boolean(ownerName && record.title && norm(record.title) === ownerName);
      }
      // The owner's own DM chats (with any of their numbers) are the owner too.
      if (record.kind === "chat" && record.chatScope && !record.chatScope.endsWith("@g.us")) {
        return ownerSelfJids.has(record.chatScope) || ownerPersonKeys.has(personKeyByJid.get(record.chatScope) ?? "");
      }
      return false;
    };
    const ownerEntries = discovered.filter((entry) => isOwnerNode(entry.record));
    if (ownerEntries.length > 1) {
      const rep =
        ownerEntries.find((entry) => entry.record.id === anchorId) ??
        ownerEntries.find((entry) => entry.record.jid === "me") ??
        [...ownerEntries].sort((a, b) => b.record.salience - a.record.salience)[0];
      const ownerRepId = rep.record.id;
      const absorb = new Set<string>();
      for (const entry of ownerEntries) {
        absorb.add(entry.record.id);
        absorb.add(repByNodeId.get(entry.record.id) ?? entry.record.id);
      }
      for (const [id, currentRep] of repByNodeId) {
        if (absorb.has(id) || absorb.has(currentRep)) repByNodeId.set(id, ownerRepId);
      }
    }
  }

  // Nothing merged → return inputs unchanged (keeps the common path cheap).
  if (![...repByNodeId.entries()].some(([id, rep]) => id !== rep)) {
    return { discovered, edges };
  }

  // Collapse into one entry per representative (hop = min, salience = max).
  const membersByRep = new Map<string, Array<{ record: BrainGraphNodeRecord; hop: number }>>();
  for (const entry of discovered) {
    const repId = repByNodeId.get(entry.record.id) ?? entry.record.id;
    const bucket = membersByRep.get(repId);
    if (bucket) bucket.push(entry);
    else membersByRep.set(repId, [entry]);
  }
  const outNodes: Array<{ record: BrainGraphNodeRecord; hop: number }> = [];
  for (const [repId, members] of membersByRep) {
    const repEntry = entryById.get(repId);
    if (!repEntry) continue;
    outNodes.push({
      record: { ...repEntry.record, salience: Math.max(...members.map((member) => member.record.salience)) },
      hop: Math.min(...members.map((member) => member.hop))
    });
  }

  // Rewire edges onto representatives; drop intra-person self loops; dedup
  // parallel edges (undirected pair + kind) — summing evidence, keeping the
  // most-evidenced edge id for click-through. Merging identities makes the graph
  // read undirected here, which the explorer already renders that way.
  const byPair = new Map<string, BrainGraphNeighborhoodEdge>();
  for (const edge of edges) {
    const src = repByNodeId.get(edge.srcId) ?? edge.srcId;
    const dst = repByNodeId.get(edge.dstId) ?? edge.dstId;
    if (src === dst) continue;
    const key = (src < dst ? `${src}|${dst}` : `${dst}|${src}`) + `|${edge.kind}`;
    const existing = byPair.get(key);
    if (!existing) {
      byPair.set(key, { ...edge, srcId: src, dstId: dst });
    } else {
      const winner = edge.evidenceCount > existing.evidenceCount ? { ...edge, srcId: existing.srcId, dstId: existing.dstId } : existing;
      byPair.set(key, {
        ...winner,
        evidenceCount: existing.evidenceCount + edge.evidenceCount,
        lastSeenAtMs: Math.max(existing.lastSeenAtMs ?? 0, edge.lastSeenAtMs ?? 0) || existing.lastSeenAtMs || edge.lastSeenAtMs,
        firstSeenAtMs:
          existing.firstSeenAtMs != null && edge.firstSeenAtMs != null
            ? Math.min(existing.firstSeenAtMs, edge.firstSeenAtMs)
            : existing.firstSeenAtMs ?? edge.firstSeenAtMs
      });
    }
  }
  return { discovered: outNodes, edges: [...byPair.values()] };
}

// Pure assembly: collapse linked identities, cap by salience (anchor pinned),
// keep only edges among kept nodes, cap edges, disambiguate same-named persons,
// disclose truncation.
export function shapeNeighborhood(walk: NeighborhoodWalk, params: ResolvedNeighborhoodParams): BrainGraphNeighborhoodView {
  // Dedup discovered by id, keeping the shortest hop (a defensive guard; the
  // walk already yields min-hop rows).
  const byId = new Map<string, { record: BrainGraphNodeRecord; hop: number }>();
  for (const entry of walk.discovered) {
    const existing = byId.get(entry.record.id);
    if (!existing || entry.hop < existing.hop) {
      byId.set(entry.record.id, entry);
    }
  }
  // Collapse linked identities into one node per person, rewiring edges, BEFORE
  // the cap so the node budget counts each person once.
  const collapsed = collapsePersonIdentities(
    [...byId.values()],
    walk.edges,
    walk.personKeyByJid,
    walk.personAliasesByJid,
    walk.ownerInfo,
    walk.anchorId
  );
  const discovered = collapsed.discovered;
  const totalNodes = discovered.length;

  const kept = discovered.sort(sortNodesForCap).slice(0, params.maxNodes);
  const keptIds = new Set(kept.map((entry) => entry.record.id));

  const edgeById = new Map<number, BrainGraphNeighborhoodEdge>();
  for (const edge of collapsed.edges) {
    if (keptIds.has(edge.srcId) && keptIds.has(edge.dstId)) {
      edgeById.set(edge.id, edge);
    }
  }
  const edgesAmongKept = [...edgeById.values()].sort(sortEdges);
  const totalEdges = edgesAmongKept.length;
  const keptEdges = edgesAmongKept.slice(0, params.maxEdges);

  const truncated = totalNodes > params.maxNodes || totalEdges > params.maxEdges || walk.discoveryTruncated;

  // Same-name disambiguation across the shown PERSON nodes only: two distinct
  // people that both render as "Amit" must read differently; two nodes of one
  // person never disambiguate against each other. Non-person nodes keep their
  // labels untouched.
  const personIndices: number[] = [];
  kept.forEach((entry, index) => {
    if (entry.record.kind === "person") {
      personIndices.push(index);
    }
  });
  if (personIndices.length > 1) {
    const disambiguated = disambiguateLabels(
      personIndices.map((index) => {
        const record = kept[index].record;
        return {
          label: record.jid ? record.label : null,
          jid: record.jid,
          personKey: record.jid ? walk.personKeyByJid.get(record.jid) ?? record.jid : "no-identity"
        };
      })
    );
    personIndices.forEach((index, position) => {
      const relabelled = disambiguated[position];
      if (relabelled) {
        kept[index] = { ...kept[index], record: { ...kept[index].record, label: relabelled } };
      }
    });
  }

  const nodes: BrainGraphNeighborhoodNode[] = kept.map((entry) => ({ ...entry.record, hop: entry.hop }));

  return {
    anchorId: walk.anchorId,
    redirected: walk.redirected,
    nodes,
    edges: keptEdges,
    truncated,
    totalNodes,
    totalEdges,
    appliedFilters: buildFilters(params)
  };
}
