import { Frame, Loader2, Maximize2, Minimize2, Search, Share2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { Core } from "cytoscape";
import type {
  BrainGraphEdgeEvidenceView,
  BrainGraphEdgeKind,
  BrainGraphNeighborhoodView,
  BrainGraphNodeKind,
  BrainGraphNodeSuggestion,
  BrainGraphUnresolvedEntity
} from "../../../shared/types";
import {
  getBrainGraphEdgeEvidence,
  getBrainGraphNeighborhood,
  listUnresolvedBrainGraphEntities,
  searchBrainGraphNodes
} from "../../api";
import { buildChatDeepLink } from "../../lib/deepLinks";
import { useToast } from "../../state/ToastContext";

// Every edge kind, with a display label and a colour used for both the filter
// chips (which double as the legend) and the rendered edges.
const EDGE_KINDS: { kind: BrainGraphEdgeKind; label: string; color: string }[] = [
  { kind: "participates_in", label: "participates in", color: "#3ecf8e" },
  { kind: "mentions", label: "mentions", color: "#4f9cff" },
  { kind: "about", label: "about", color: "#b18cff" },
  { kind: "involves", label: "involves", color: "#ff5c5c" },
  { kind: "related_to", label: "related to", color: "#ffb454" },
  { kind: "replies_to", label: "replies to", color: "#63e6be" },
  { kind: "derived_from", label: "derived from", color: "#9aa0a6" },
  { kind: "alias_of", label: "alias of", color: "#ff7b9c" },
  { kind: "resolves", label: "resolves", color: "#f5d90a" }
];

const NODE_COLORS: Record<string, string> = {
  person: "#4f9cff",
  chat: "#3ecf8e",
  topic: "#b18cff",
  org: "#ffb454",
  place: "#ff7b9c",
  project: "#f5d90a",
  commitment: "#ff5c5c",
  question: "#ffa94d",
  event: "#63e6be",
  other: "#9aa0a6",
  fact: "#9aa0a6"
};

// Node kinds as filter chips (only the kinds present in the view are shown).
// The claim kinds — commitment/question/event — are individual claims promoted
// to nodes, so they carry long sentence labels and read as clutter for a human
// explorer; they are muted by DEFAULT (the graph reads people-and-things first)
// and can be toggled back on.
const NODE_KINDS: { kind: BrainGraphNodeKind; label: string }[] = [
  { kind: "person", label: "people" },
  { kind: "chat", label: "chats" },
  { kind: "topic", label: "topics" },
  { kind: "org", label: "orgs" },
  { kind: "place", label: "places" },
  { kind: "project", label: "projects" },
  { kind: "other", label: "other" },
  { kind: "commitment", label: "commitments" },
  { kind: "question", label: "questions" },
  { kind: "event", label: "events" },
  { kind: "fact", label: "facts" }
];
const CLAIM_NODE_KINDS: BrainGraphNodeKind[] = ["commitment", "question", "event"];

function relativeTime(ms: number | null | undefined): string | null {
  if (!ms) return null;
  const delta = Date.now() - ms;
  if (delta < 45_000) return "just now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

function dayLabel(ms: number | null): string {
  return ms != null && Number.isFinite(ms) ? new Date(ms).toLocaleDateString() : "—";
}

function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character] as string);
}

// Node radius scales with salience so hubs read as hubs; the anchor is biggest.
function nodeSize(node: { hop: number; salience: number }): number {
  if (node.hop === 0) return 50;
  return Math.max(16, Math.min(42, 15 + Math.sqrt(Math.max(0, node.salience)) * 4.2));
}

// Light background colours for community boxes (compound parents).
const COMMUNITY_COLORS = [
  "#4f9cff",
  "#3ecf8e",
  "#b18cff",
  "#ffb454",
  "#ff7b9c",
  "#63e6be",
  "#f5d90a",
  "#ff5c5c",
  "#9c88ff",
  "#4dd0e1",
  "#ffa94d",
  "#a3e635"
];

// Single-level Louvain community detection over the neighbourhood's edges, run
// on the graph MINUS the anchor (a hub links everything and blurs communities).
// Deterministic node ordering → stable results. Returns a contiguous community
// index per node id.
function detectCommunities(nodeIds: string[], edges: Array<{ srcId: string; dstId: string }>): Map<string, number> {
  const order = [...nodeIds].sort();
  const index = new Map(order.map((id, i) => [id, i]));
  const n = order.length;
  const result = new Map<string, number>();
  if (n === 0) return result;
  const adj: Array<Map<number, number>> = Array.from({ length: n }, () => new Map());
  const deg = new Array(n).fill(0);
  let m2 = 0;
  for (const edge of edges) {
    const a = index.get(edge.srcId);
    const b = index.get(edge.dstId);
    if (a === undefined || b === undefined || a === b) continue;
    adj[a].set(b, (adj[a].get(b) ?? 0) + 1);
    adj[b].set(a, (adj[b].get(a) ?? 0) + 1);
    deg[a] += 1;
    deg[b] += 1;
    m2 += 2;
  }
  if (m2 === 0) {
    order.forEach((id, i) => result.set(id, i));
    return result;
  }
  const comm = order.map((_, i) => i);
  const commTot = deg.slice();
  let improved = true;
  let passes = 0;
  while (improved && passes < 20) {
    improved = false;
    passes += 1;
    for (let i = 0; i < n; i += 1) {
      const ci = comm[i];
      const ki = deg[i];
      const linksTo = new Map<number, number>();
      for (const [j, w] of adj[i]) {
        const cj = comm[j];
        linksTo.set(cj, (linksTo.get(cj) ?? 0) + w);
      }
      commTot[ci] -= ki;
      let bestC = ci;
      let bestGain = (linksTo.get(ci) ?? 0) - (commTot[ci] * ki) / m2;
      for (const [c, l] of linksTo) {
        if (c === ci) continue;
        const gain = l - (commTot[c] * ki) / m2;
        if (gain > bestGain + 1e-9) {
          bestGain = gain;
          bestC = c;
        }
      }
      comm[i] = bestC;
      commTot[bestC] += ki;
      if (bestC !== ci) improved = true;
    }
  }
  const relabel = new Map<number, number>();
  order.forEach((id, i) => {
    const c = comm[i];
    if (!relabel.has(c)) relabel.set(c, relabel.size);
    result.set(id, relabel.get(c) as number);
  });
  return result;
}

// Runs the fcose layout at a caller-chosen spread (a user-controlled multiplier
// on repulsion/edge-length/separation), then opens zoomed in and centred on the
// anchor so its cluster is spacious and the rest overflows for panning.
function runGraphLayout(cy: Core, spread: number): void {
  cy.layout({
    name: "fcose",
    quality: "proof",
    animate: false,
    randomize: true,
    nodeRepulsion: 220000 * spread,
    idealEdgeLength: 320 * spread,
    nodeSeparation: 850 * spread,
    gravity: 0.02,
    gravityRange: 6,
    gravityCompound: 0.25,
    numIter: 4000,
    packComponents: true,
    fit: false
  } as unknown as Parameters<Core["layout"]>[0]).run();
  const anchor = cy.$('node[hop = 0]');
  cy.fit(undefined, 80);
  if (cy.zoom() < 0.7) {
    cy.zoom(0.7);
    if (anchor.nonempty()) cy.center(anchor);
  }
}

// Anchor typed into the pick box: an all-digits value is a phone number → a
// canonical WhatsApp JID; anything else is treated as an entity name.
// For persons, show the WhatsApp number alongside the name so two contacts with
// the same display name (two "Swati"s) are distinguishable in the dropdown.
function phoneTail(jid: string | null): string | null {
  if (!jid) return null;
  const local = jid.split("@")[0];
  return /^\d{5,}$/.test(local) ? local : null;
}

// Typeahead for anchoring the explorer. You can only anchor by PICKING a real
// node — there is no free-text submit — so the chosen anchor is always an exact
// node id, never an ambiguous name that could match several same-named nodes.
function AnchorSearch({
  onSelect,
  placeholder = "Search for a node to anchor…",
  autoFocus = false,
  variant = "header"
}: {
  onSelect: (nodeId: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  variant?: "header" | "empty";
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<BrainGraphNodeSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const reqRef = useRef(0);
  const blurTimer = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // The menu is positioned `fixed` from the input's rect so it is never clipped
  // by an ancestor's `overflow: hidden` (the graph canvas wrapper clips it).
  const [menuBox, setMenuBox] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const token = ++reqRef.current;
    // Debounced so we search on a pause, not on every keystroke; a stale
    // response (slower request that resolves after a newer one) is discarded
    // via the monotonic request token.
    const handle = window.setTimeout(() => {
      void searchBrainGraphNodes(q, 10)
        .then((rows) => {
          if (reqRef.current !== token) return;
          setItems(rows);
          setActive(0);
          setOpen(true);
        })
        .catch(() => {
          if (reqRef.current === token) setItems([]);
        })
        .finally(() => {
          if (reqRef.current === token) setLoading(false);
        });
    }, 180);
    return () => window.clearTimeout(handle);
  }, [query]);

  useEffect(() => () => {
    if (blurTimer.current != null) window.clearTimeout(blurTimer.current);
  }, []);

  // Track the input's viewport rect while the menu is open so the fixed-position
  // menu stays glued to it (and escapes the canvas wrapper's overflow clip).
  useLayoutEffect(() => {
    const visible = open && query.trim().length > 0;
    if (!visible) {
      setMenuBox(null);
      return;
    }
    const update = () => {
      const el = inputRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // Cap to the space below the input so the menu never spills past the
      // viewport — it scrolls within instead of being cut off.
      const maxHeight = Math.max(140, Math.min(360, Math.round(window.innerHeight - r.bottom - 12)));
      setMenuBox({ top: Math.round(r.bottom + 4), left: Math.round(r.left), width: Math.round(r.width), maxHeight });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, query]);

  const choose = (item: BrainGraphNodeSuggestion | undefined) => {
    if (!item) return;
    onSelect(item.id);
    setQuery("");
    setItems([]);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((index) => Math.min(index + 1, items.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(items[active]);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  const showMenu = open && query.trim().length > 0;

  return (
    <div className={`graphAnchorSearch ${variant === "empty" ? "graphAnchorSearchWide" : ""}`}>
      <Search size={14} className="graphAnchorSearchIcon" aria-hidden />
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={showMenu}
        aria-autocomplete="list"
        aria-controls="graphAnchorMenu"
        aria-label="Search for a node to anchor"
        placeholder={placeholder}
        value={query}
        autoFocus={autoFocus}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          if (items.length > 0) setOpen(true);
        }}
        onBlur={() => {
          // Delay so a click on an option lands before the menu unmounts.
          blurTimer.current = window.setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={onKeyDown}
      />
      {showMenu && (
        <ul
          id="graphAnchorMenu"
          className="graphAnchorMenu"
          role="listbox"
          style={menuBox ? { position: "fixed", top: menuBox.top, left: menuBox.left, width: menuBox.width, maxHeight: menuBox.maxHeight } : undefined}
          onMouseDown={(event) => event.preventDefault()}
        >
          {loading && items.length === 0 && <li className="graphAnchorHint muted">Searching…</li>}
          {!loading && items.length === 0 && <li className="graphAnchorHint muted">No matching nodes</li>}
          {items.map((item, index) => {
            const tail = item.kind === "person" ? phoneTail(item.jid) : null;
            return (
              <li
                key={item.id}
                role="option"
                aria-selected={index === active}
                className={`graphAnchorOption ${index === active ? "active" : ""}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(item)}
              >
                <span className="graphAnchorDot" style={{ background: NODE_COLORS[item.kind] ?? "#9aa0a6" }} aria-hidden />
                <span className="graphAnchorOptionLabel">{item.label}</span>
                <span className="graphAnchorOptionMeta muted">{tail ? `${item.kind} · ${tail}` : item.kind}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// The graph explorer (`/graph`). An anchored ego-graph — never the whole graph —
// with edge-kind filters, a time-window scrub, a dormancy toggle, expand-on-
// click (re-anchor), and an evidence side panel whose citations deep-link into
// the thread. Cytoscape is dynamically imported so it lands only in this chunk.
export function GraphPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { setError } = useToast();

  const anchorNodeId = searchParams.get("node");
  const anchorJid = searchParams.get("jid");
  const anchorName = searchParams.get("name");
  const anchorKey = `${anchorNodeId ?? ""}|${anchorJid ?? ""}|${anchorName ?? ""}`;
  const hasAnchor = Boolean(anchorNodeId || anchorJid || anchorName);

  const [depth, setDepth] = useState(1);
  const [mutedKinds, setMutedKinds] = useState<Set<BrainGraphEdgeKind>>(new Set());
  const [includeDormant, setIncludeDormant] = useState(false);
  const mutedKindsKey = [...mutedKinds].sort().join(",");
  // Node-kind visibility (client-side): claim nodes AND topics hidden by default
  // — a hub like "Me" links to dozens of topics, which crowd the centre; the
  // graph reads as people/places/orgs first. Toggle any kind back on via "Show".
  const [hiddenNodeKinds, setHiddenNodeKinds] = useState<Set<BrainGraphNodeKind>>(new Set([...CLAIM_NODE_KINDS, "topic"]));
  const hiddenNodeKindsKey = [...hiddenNodeKinds].sort().join(",");
  const [isFullscreen, setIsFullscreen] = useState(false);
  // User-controlled layout spread (multiplier on repulsion/edge-length).
  const [spread, setSpread] = useState(1);
  const spreadRef = useRef(spread);
  spreadRef.current = spread;
  // Community grouping is on by default (nodes tinted by community); the boxes
  // around them are opt-in.
  const [groupByCommunity, setGroupByCommunity] = useState(true);
  const [showBoxes, setShowBoxes] = useState(false);

  const [view, setView] = useState<BrainGraphNeighborhoodView | null>(null);
  const [loading, setLoading] = useState(false);

  const [edgeEvidence, setEdgeEvidence] = useState<BrainGraphEdgeEvidenceView | null>(null);
  const [edgeLoading, setEdgeLoading] = useState(false);

  const [timeCutoff, setTimeCutoff] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<BrainGraphUnresolvedEntity[]>([]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const [cytoscapeLib, setCytoscapeLib] = useState<((options: object) => Core) | null>(null);

  // The active edge kinds sent to the server: all kinds except the muted ones.
  // Empty muted set → omit the filter entirely (server returns all).
  const activeKinds = useMemo(() => EDGE_KINDS.map((entry) => entry.kind).filter((kind) => !mutedKinds.has(kind)), [mutedKindsKey]);

  // Lazy-load Cytoscape + fcose once, only on this route.
  useEffect(() => {
    let alive = true;
    void Promise.all([import("cytoscape"), import("cytoscape-fcose")])
      .then(([cy, fcose]) => {
        if (!alive) return;
        cy.default.use(fcose.default);
        setCytoscapeLib(() => cy.default as unknown as (options: object) => Core);
      })
      .catch((err) => {
        console.error("[graph] failed to load the renderer", err);
        setError("Could not load the graph renderer.");
      });
    return () => {
      alive = false;
    };
  }, [setError]);

  // Suggested anchors for the empty state (real nodes the user can explore).
  useEffect(() => {
    if (hasAnchor) return;
    let cancelled = false;
    void listUnresolvedBrainGraphEntities(6)
      .then((rows) => {
        if (!cancelled) setSuggestions(rows);
      })
      .catch(() => {
        /* suggestions are a nicety; never block the empty state on them */
      });
    return () => {
      cancelled = true;
    };
  }, [hasAnchor]);

  // Fetch the neighborhood whenever the anchor or a server-side filter changes.
  useEffect(() => {
    if (!hasAnchor) {
      setView(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getBrainGraphNeighborhood({
      nodeId: anchorNodeId ?? undefined,
      jid: anchorJid ?? undefined,
      name: anchorName ?? undefined,
      depth,
      kinds: activeKinds.length === EDGE_KINDS.length ? undefined : activeKinds,
      includeDormant
    })
      .then((next) => {
        if (cancelled) return;
        setView(next);
        setEdgeEvidence(null);
        setTimeCutoff(null);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[graph] neighborhood fetch failed", err);
        setError(err instanceof Error ? err.message : "Could not load that neighborhood.");
        setView(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [anchorKey, depth, mutedKindsKey, includeDormant, setError]);

  // Time-scrub bounds derived from the current view's edge evidence times.
  const timeBounds = useMemo(() => {
    const times = (view?.edges ?? []).map((edge) => edge.lastSeenAtMs).filter((ms): ms is number => ms != null);
    if (times.length === 0) return null;
    return { min: Math.min(...times), max: Math.max(...times) };
  }, [view]);

  const reanchor = useCallback(
    (nodeId: string) => {
      setSearchParams({ node: nodeId });
    },
    [setSearchParams]
  );

  const openEdge = useCallback(
    (edgeId: number) => {
      setEdgeLoading(true);
      setEdgeEvidence(null);
      void getBrainGraphEdgeEvidence(edgeId)
        .then((evidence) => setEdgeEvidence(evidence))
        .catch((err) => {
          console.error("[graph] edge evidence fetch failed", err);
          setError(err instanceof Error ? err.message : "Could not load the edge's evidence.");
        })
        .finally(() => setEdgeLoading(false));
    },
    [setError]
  );

  // Client-side node-kind filter: the anchor (hop 0) is always kept; claim
  // nodes are hidden by default. Edges to a hidden node drop with it. (Pushing
  // this filter server-side — so the node cap is spent only on shown kinds — is
  // the follow-up that lands after the run.)
  const rendered = useMemo(() => {
    if (!view) return { nodes: [] as BrainGraphNeighborhoodView["nodes"], edges: [] as BrainGraphNeighborhoodView["edges"] };
    const nodes = view.nodes.filter((node) => node.hop === 0 || !hiddenNodeKinds.has(node.kind));
    const ids = new Set(nodes.map((node) => node.id));
    const edges = view.edges.filter((edge) => ids.has(edge.srcId) && ids.has(edge.dstId));
    // Keep only what's still connected to the anchor: hiding a kind (e.g. topics)
    // can orphan nodes that were linked ONLY through it, which would otherwise
    // float as disconnected islands. They reappear when their link kind is shown.
    const anchor = nodes.find((node) => node.hop === 0);
    if (!anchor) return { nodes, edges };
    const adj = new Map<string, string[]>();
    for (const edge of edges) {
      (adj.get(edge.srcId) ?? adj.set(edge.srcId, []).get(edge.srcId))?.push(edge.dstId);
      (adj.get(edge.dstId) ?? adj.set(edge.dstId, []).get(edge.dstId))?.push(edge.srcId);
    }
    const reachable = new Set<string>([anchor.id]);
    const queue = [anchor.id];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const neighbor of adj.get(current) ?? []) {
        if (!reachable.has(neighbor)) {
          reachable.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    const keptNodes = nodes.filter((node) => reachable.has(node.id));
    const keptIds = new Set(keptNodes.map((node) => node.id));
    return { nodes: keptNodes, edges: edges.filter((edge) => keptIds.has(edge.srcId) && keptIds.has(edge.dstId)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, hiddenNodeKindsKey]);

  // Node kinds present in the current view, for the filter chips.
  const presentNodeKinds = useMemo(() => {
    const present = new Set(view?.nodes.map((node) => node.kind));
    return NODE_KINDS.filter((entry) => present.has(entry.kind));
  }, [view]);

  // Community assignment (only when grouping is on) — computed on the shown
  // nodes minus the anchor, so the hub doesn't blur the communities. Only real
  // communities (3+ members) get a box; nodes tied only to the hub stay loose.
  const communities = useMemo(() => {
    if (!groupByCommunity) return null;
    // Communities are SOCIAL groups: exclude the anchor (a hub blurs them) and
    // topics (conceptual, not actors — they'd otherwise pull unrelated people
    // together and belong to no single group).
    const ids = rendered.nodes.filter((node) => node.hop !== 0 && node.kind !== "topic").map((node) => node.id);
    const raw = detectCommunities(ids, rendered.edges);
    const counts = new Map<number, number>();
    for (const community of raw.values()) counts.set(community, (counts.get(community) ?? 0) + 1);
    const grouped = new Map<string, number>();
    for (const [id, community] of raw) {
      if ((counts.get(community) ?? 0) >= 3) grouped.set(id, community);
    }
    return grouped;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendered, groupByCommunity]);

  // Build (or rebuild) the Cytoscape instance when the library or shown set changes.
  useEffect(() => {
    if (!cytoscapeLib || !containerRef.current || !view) return;
    const nodeIds = new Set(rendered.nodes.map((node) => node.id));
    const parentElements = communities
      ? [...new Set(communities.values())].map((communityId) => ({
          data: { id: `community-${communityId}`, isParent: true, color: COMMUNITY_COLORS[communityId % COMMUNITY_COLORS.length] }
        }))
      : [];
    const elements = [
      ...parentElements,
      ...rendered.nodes.map((node) => ({
        data: {
          id: node.id,
          label: node.label,
          kind: node.kind,
          hop: node.hop,
          status: node.status,
          salience: node.salience,
          size: nodeSize(node),
          // Nodes are ALWAYS coloured by type (kind). Community grouping only
          // clusters members together spatially (and optionally boxes them); it
          // no longer tints nodes, so the colour always reads as the entity type.
          color: NODE_COLORS[node.kind] ?? NODE_COLORS.other,
          parent: communities?.has(node.id) ? `community-${communities.get(node.id)}` : undefined
        }
      })),
      ...rendered.edges
        .filter((edge) => nodeIds.has(edge.srcId) && nodeIds.has(edge.dstId))
        .map((edge) => ({
          data: {
            id: `e${edge.id}`,
            edgeId: edge.id,
            source: edge.srcId,
            target: edge.dstId,
            kind: edge.kind,
            lastSeenAtMs: edge.lastSeenAtMs,
            evidenceCount: edge.evidenceCount,
            color: EDGE_KINDS.find((entry) => entry.kind === edge.kind)?.color ?? "#9aa0a6"
          }
        }))
    ];
    const cy = cytoscapeLib({
      container: containerRef.current,
      elements,
      style: [
        {
          // Compound parents keep the community together spatially but are
          // invisible by default (the node TINT shows the grouping). The optional
          // box is revealed via the .showBox class. Non-interactive so taps/hovers
          // reach the member nodes.
          selector: "node[?isParent]",
          style: {
            "background-color": "data(color)",
            "background-opacity": 0,
            "border-width": 0,
            shape: "round-rectangle",
            padding: "18px",
            label: "",
            "z-index": 0,
            events: "no"
          }
        },
        {
          selector: "node.showBox",
          style: { "background-opacity": 0.1, "border-width": 1.5, "border-color": "data(color)", "border-opacity": 0.5 }
        },
        {
          selector: "node[!isParent]",
          style: {
            "background-color": "data(color)",
            label: "data(label)",
            color: "#e6e6e6",
            "font-size": "11px",
            // Labels vanish when zoomed out so the whole graph reads as coloured
            // clusters; zoom in (or hover) to read them.
            "min-zoomed-font-size": 10,
            "text-wrap": "wrap",
            "text-max-width": "110px",
            "text-valign": "bottom",
            "text-margin-y": 3,
            width: "data(size)",
            height: "data(size)"
          }
        },
        { selector: 'node[hop = 0]', style: { "border-width": 4, "border-color": "#ffffff", "font-size": "14px", "font-weight": "bold", "min-zoomed-font-size": 0, "z-index": 30 } },
        { selector: 'node[status = "dormant"]', style: { "background-opacity": 0.4, "border-width": 1, "border-style": "dashed", "border-color": "#9aa0a6" } },
        { selector: "node.hovered", style: { "border-width": 3, "border-color": "#ffffff", "min-zoomed-font-size": 0, "z-index": 40 } },
        { selector: "node.dim", style: { opacity: 0.15 } },
        { selector: "edge", style: { width: 1.2, "line-color": "data(color)", "curve-style": "haystack", opacity: 0.5 } },
        { selector: "edge.faded", style: { opacity: 0.04 } },
        { selector: "edge.hovered", style: { width: 3, opacity: 0.95, "z-index": 40 } },
        { selector: "edge.selected", style: { width: 4, opacity: 1, "line-color": "#ffffff", "z-index": 50 } }
      ],
      minZoom: 0.04,
      maxZoom: 4,
      wheelSensitivity: 0.25
    });
    runGraphLayout(cy, spreadRef.current);

    // Hover tooltip (item: hints on hover) — direct DOM, no React churn on move.
    const tip = tooltipRef.current;
    const showTip = (html: string, at?: { x: number; y: number }) => {
      if (!tip) return;
      tip.innerHTML = html;
      tip.style.display = "block";
      if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) {
        tip.style.left = `${at.x + 14}px`;
        tip.style.top = `${at.y + 14}px`;
      }
    };
    const hideTip = () => {
      if (tip) tip.style.display = "none";
    };
    cy.on("mouseover", "node", (evt) => {
      const node = evt.target;
      const salience = Number(node.data("salience")) || 0;
      const status = node.data("status");
      showTip(
        `<strong>${escapeHtml(node.data("label"))}</strong><br><span class="graphTipMeta">${node.data("kind")}${
          status !== "active" ? ` · ${status}` : ""
        } · salience ${salience.toFixed(1)} · ${node.degree(false)} link${node.degree(false) === 1 ? "" : "s"}</span>`,
        evt.renderedPosition ?? node.renderedPosition()
      );
      node.addClass("hovered");
    });
    cy.on("mouseover", "edge", (evt) => {
      const edge = evt.target;
      showTip(
        `<strong>${escapeHtml(edge.source().data("label"))}</strong> <span class="graphTipMeta">${String(edge.data("kind")).replace(/_/g, " ")}</span> <strong>${escapeHtml(
          edge.target().data("label")
        )}</strong><br><span class="graphTipMeta">${edge.data("evidenceCount")} evidence · click to see it</span>`,
        evt.renderedPosition ?? edge.renderedMidpoint()
      );
      edge.addClass("hovered");
    });
    cy.on("mouseout", "node, edge", () => {
      hideTip();
      cy.elements().removeClass("hovered");
    });
    cy.on("pan zoom drag", () => {
      hideTip();
      cy.elements().removeClass("hovered");
    });
    cy.on("tap", "node", (evt) => reanchor(evt.target.id()));
    cy.on("tap", "edge", (evt) => {
      cy.edges().removeClass("selected");
      evt.target.addClass("selected");
      openEdge(Number(evt.target.data("edgeId")));
    });
    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [cytoscapeLib, rendered, communities, reanchor, openEdge]);

  // Show/hide the community boxes without a rebuild.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const parents = cy.nodes().filter((node) => node.isParent());
    if (showBoxes) parents.addClass("showBox");
    else parents.removeClass("showBox");
  }, [showBoxes, communities, rendered]);

  // Time-scrub: fade edges whose last evidence predates the cutoff (client-side,
  // no refetch) — the visible edge set changes as the window moves.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.edges().forEach((edge) => {
        const last = edge.data("lastSeenAtMs") as number | null;
        edge.toggleClass("faded", timeCutoff != null && last != null && last < timeCutoff);
      });
    });
  }, [timeCutoff, rendered]);

  // Fullscreen: the canvas wrapper expands to the viewport; Cytoscape needs a
  // resize + refit when the viewport changes.
  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
      const cy = cyRef.current;
      if (cy) {
        window.setTimeout(() => {
          cy.resize();
          cy.fit(undefined, 40);
        }, 120);
      }
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
    } else {
      void el.requestFullscreen?.();
    }
  }, []);

  const fitView = useCallback(() => {
    cyRef.current?.fit(undefined, 40);
  }, []);

  const adjustSpread = useCallback((delta: number) => {
    setSpread((current) => Math.max(0.6, Math.min(3.4, Number((current + delta).toFixed(1)))));
  }, []);

  // Re-run the layout when the user changes the spread (the build effect already
  // laid out at the current spread on first render / rebuild).
  const spreadInitialized = useRef(false);
  useEffect(() => {
    if (!spreadInitialized.current) {
      spreadInitialized.current = true;
      return;
    }
    const cy = cyRef.current;
    if (cy) runGraphLayout(cy, spread);
  }, [spread]);

  const toggleKind = (kind: BrainGraphEdgeKind) => {
    setMutedKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const toggleNodeKind = (kind: BrainGraphNodeKind) => {
    setHiddenNodeKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const anchorNode = view?.nodes.find((node) => node.hop === 0) ?? null;

  return (
    <div className="graphPage">
      <header className="graphHeader">
        <div className="graphTitle">
          <Share2 size={18} />
          <h2>Graph</h2>
          {anchorNode && (
            <span className="graphAnchorLabel" title={`${anchorNode.kind} · salience ${anchorNode.salience.toFixed(2)}`}>
              anchored on <strong>{anchorNode.label}</strong>
              {view?.redirected && <span className="badge tipChip" data-tip="This id was merged into another; you're seeing the survivor."> redirected</span>}
            </span>
          )}
        </div>
        <AnchorSearch onSelect={reanchor} />
      </header>

      {hasAnchor && (
        <div className="graphControls">
          <div className="graphControlGroup" role="group" aria-label="Depth">
            <span className="graphControlLabel">Depth</span>
            {[1, 2].map((value) => (
              <button key={value} type="button" className={`chip ${depth === value ? "active" : ""}`} onClick={() => setDepth(value)}>
                {value} hop{value > 1 ? "s" : ""}
              </button>
            ))}
          </div>
          <div className="graphControlGroup" role="group" aria-label="Spread">
            <span className="graphControlLabel">Spread</span>
            <button type="button" className="chip" onClick={() => adjustSpread(-0.4)} disabled={spread <= 0.6} title="Less spacing" aria-label="Less spacing">
              −
            </button>
            <span className="graphSpreadValue">{spread.toFixed(1)}×</span>
            <button type="button" className="chip" onClick={() => adjustSpread(0.4)} disabled={spread >= 3.4} title="More spacing" aria-label="More spacing">
              +
            </button>
          </div>
          <button
            type="button"
            className={`chip ${groupByCommunity ? "active" : ""}`}
            onClick={() => setGroupByCommunity((value) => !value)}
            title="Cluster densely-connected communities together (colour stays by type; add boxes to outline them)"
          >
            Communities
          </button>
          {groupByCommunity && (
            <button
              type="button"
              className={`chip ${showBoxes ? "active" : ""}`}
              onClick={() => setShowBoxes((value) => !value)}
              title="Draw a box around each community"
            >
              Boxes
            </button>
          )}
          <label className="graphDormantToggle">
            <input type="checkbox" checked={includeDormant} onChange={(event) => setIncludeDormant(event.target.checked)} />
            <span className="badge tipChip" data-tip="Dormant nodes are low-salience and hidden by default; dormancy never deletes.">
              show dormant
            </span>
          </label>
          <div className="graphKindChips" role="group" aria-label="Edge kinds">
            {EDGE_KINDS.map((entry) => (
              <button
                key={entry.kind}
                type="button"
                className={`kindChip ${mutedKinds.has(entry.kind) ? "muted" : "active"}`}
                style={{ ["--kind-color" as string]: entry.color }}
                onClick={() => toggleKind(entry.kind)}
                title={mutedKinds.has(entry.kind) ? `Show ${entry.label} edges` : `Hide ${entry.label} edges`}
              >
                <span className="kindSwatch" />
                {entry.label}
              </button>
            ))}
          </div>
          {presentNodeKinds.length > 1 && (
            <div className="graphKindChips" role="group" aria-label="Node types">
              <span className="graphControlLabel">Show</span>
              {presentNodeKinds.map((entry) => (
                <button
                  key={entry.kind}
                  type="button"
                  className={`kindChip ${hiddenNodeKinds.has(entry.kind) ? "muted" : "active"}`}
                  style={{ ["--kind-color" as string]: NODE_COLORS[entry.kind] ?? NODE_COLORS.other }}
                  onClick={() => toggleNodeKind(entry.kind)}
                  title={hiddenNodeKinds.has(entry.kind) ? `Show ${entry.label}` : `Hide ${entry.label}`}
                >
                  <span className="kindSwatch" />
                  {entry.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {hasAnchor && timeBounds && timeBounds.min < timeBounds.max && (
        <div className="graphScrub">
          <span className="graphControlLabel">Since</span>
          <input
            type="range"
            min={timeBounds.min}
            max={timeBounds.max}
            step={Math.max(1, Math.floor((timeBounds.max - timeBounds.min) / 200))}
            value={timeCutoff ?? timeBounds.min}
            onChange={(event) => setTimeCutoff(Number(event.target.value))}
            aria-label="Fade edges with last evidence before this date"
          />
          <span className="muted graphScrubValue">{dayLabel(timeCutoff ?? timeBounds.min)}</span>
          {timeCutoff != null && timeCutoff > timeBounds.min && (
            <button type="button" className="linkButton" onClick={() => setTimeCutoff(null)}>
              reset
            </button>
          )}
        </div>
      )}

      <div className="graphBody">
        <div className="graphCanvasWrap" ref={wrapRef}>
          <div ref={tooltipRef} className="graphTooltip" style={{ display: "none" }} />
          {hasAnchor && (
            <button type="button" className="graphFitBtn iconButton" onClick={fitView} title="Fit whole graph to view" aria-label="Fit whole graph to view">
              <Frame size={16} />
            </button>
          )}
          {hasAnchor && (
            <button
              type="button"
              className="graphFullscreenBtn iconButton"
              onClick={toggleFullscreen}
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
          )}
          {loading && (
            <div className="graphOverlay">
              <Loader2 className="spin" size={20} /> Loading neighborhood…
            </div>
          )}
          {!hasAnchor && (
            <div className="graphEmpty">
              <Share2 size={28} />
              <h3>Explore the knowledge graph</h3>
              <p className="muted">
                Search for a person, chat, or topic to see its neighborhood — people, relations, events and places, two hops out.
                You usually arrive here via “View in graph” from People, Brain, or an episode.
              </p>
              <AnchorSearch onSelect={reanchor} autoFocus variant="empty" placeholder="Search people, chats, topics…" />
              {suggestions.length > 0 && (
                <div className="graphSuggestions">
                  <span className="muted">Some nodes to try:</span>
                  {suggestions.map((row) => (
                    <button key={row.node.id} type="button" className="chip" onClick={() => reanchor(row.node.id)}>
                      {row.node.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div ref={containerRef} className="graphCanvas" style={{ visibility: hasAnchor && view ? "visible" : "hidden" }} />
          {view && (
            <div className="graphStatus">
              <span>
                {rendered.nodes.length}
                {rendered.nodes.length < view.totalNodes ? `/${view.totalNodes}` : ""} nodes · {rendered.edges.length}
                {rendered.edges.length < view.totalEdges ? `/${view.totalEdges}` : ""} edges
              </span>
              {view.truncated && (
                <span className="badge tipChip warning" data-tip="Only the most salient nodes and most-evidenced edges are shown; narrow the filters to see more.">
                  truncated
                </span>
              )}
            </div>
          )}
        </div>

        {(edgeEvidence || edgeLoading) && (
          <aside className="graphEvidence">
            <div className="graphEvidenceHead">
              <h3>Edge evidence</h3>
              <button type="button" className="iconButton" aria-label="Close" onClick={() => setEdgeEvidence(null)}>
                <X size={16} />
              </button>
            </div>
            {edgeLoading && (
              <p className="muted">
                <Loader2 className="spin" size={14} /> Loading evidence…
              </p>
            )}
            {edgeEvidence && (
              <>
                <p className="graphEvidenceEdge">
                  <strong>{edgeEvidence.src.label}</strong>
                  <span className="muted"> — {edgeEvidence.kind.replaceAll("_", " ")} → </span>
                  <strong>{edgeEvidence.dst.label}</strong>
                </p>
                <p className="muted graphEvidenceMeta">
                  {edgeEvidence.evidenceCount} evidence · last {relativeTime(edgeEvidence.lastSeenAtMs) ?? "—"}
                </p>
                {edgeEvidence.citations.length === 0 ? (
                  <p className="muted">This edge's evidence isn't message-linkable (e.g. a contact-card sync).</p>
                ) : (
                  <ul className="graphCitationList">
                    {edgeEvidence.citations.map((citation, index) => {
                      const linkable = citation.chatId != null && citation.messageId != null;
                      return (
                        <li key={`${citation.sourceMessageKey}-${index}`} className="graphCitation">
                          {citation.claimText && <p className="graphClaimText">{citation.claimText}</p>}
                          <div className="graphCitationMeta">
                            <span className="muted">{relativeTime(citation.timestampMs) ?? dayLabel(citation.timestampMs)}</span>
                            {linkable ? (
                              <button
                                type="button"
                                className="linkButton"
                                onClick={() => navigate(buildChatDeepLink(citation.chatId!, citation.messageId))}
                              >
                                open in thread
                              </button>
                            ) : (
                              <span className="muted">no linkable message</span>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
