import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, RefreshCcw } from "lucide-react";
import type {
  ArchiveChangeEvent,
  BrainResolutionDebtIdentity,
  IdentityRecentMessage,
  MessageListItem,
  PersonCompareContext,
  PersonLinkEventRecord,
  PersonLinkSuppressionRecord,
  PersonRecord,
  PersonScanStatus,
  PersonSuggestionKind,
  PersonSuggestionRecord
} from "../../../shared/types";
import {
  acceptPersonSuggestion,
  connectPersonIdentities,
  disconnectPersonIdentity,
  getPersonCompareContext,
  listIdentityRecentMessages,
  listMessages,
  listPersonDebt,
  listPersonEvents,
  listPersons,
  listPersonSuggestions,
  listPersonSuppressions,
  mediaThumbnailUrl,
  personAvatarUrl,
  rejectPersonSuggestion,
  releasePersonSuppression,
  renamePersonIdentity,
  runPersonScan,
  undoPersonDismissal
} from "../../api";
import { useArchiveEvents } from "../../state/StatusContext";
import { useToast } from "../../state/ToastContext";

// Person-management surface for the two-level person model. Suggestions are
// stored per detector signal (that is the rejection-memory granularity) but
// PRESENTED per pair: one card lists every signal as a chip, confidence is
// fused across independent signals (noisy-OR), and accept/dismiss act on the
// whole pair. Cards open an in-place compare dialog (both DM threads side by
// side). Identities stay immutable; everything here is reversible membership
// metadata. The richer explorer (media, profile photos, deeper analysis)
// belongs to the people-management-ui change.

const SOURCE_LABELS: Record<string, string> = {
  google: "Google contact",
  number_change: "Number change",
  user: "You connected"
};

const SOURCE_EXPLAINERS: Record<string, string> = {
  google: "These numbers are saved under one Google contact, so they were connected automatically.",
  number_change:
    "WhatsApp's own “changed their phone number” system message — an authoritative platform fact, connected automatically.",
  user: "You confirmed this connection (directly or by accepting a suggestion)."
};

const KIND_LABELS: Record<string, string> = {
  same_name: "Same name",
  shared_group: "Shared groups",
  co_citation: "Co-mentioned",
  succession: "Number succession",
  shared_vcard: "Shared contact card",
  llm: "Model suggested"
};

const KIND_EXPLAINERS: Record<string, string> = {
  same_name: "Two identities carry the same saved name. Names never connect anything by themselves — this is only a hint for you.",
  succession:
    "Inferred pattern: one number went silent and the other first appeared in the same groups shortly after. Unlike an official “changed their number” message (which connects automatically), this is circumstantial — it could also be a new person taking someone's place — so it needs your confirmation.",
  shared_vcard: "A contact card shared in a chat maps this saved name to this number.",
  co_citation: "The brain's extracted claims mention both identities together across several episodes.",
  shared_group: "Retired signal: co-presence in groups alone proved too noisy to stand on its own.",
  llm: "Model-inferred from chat content (future producer; nothing applies without your confirmation)."
};

type SortMode = "recommended" | "confidence" | "value";

const SORT_EXPLAINERS: Record<SortMode, string> = {
  recommended: "Fused confidence weighted by how much history a merge would actually unify (a 0-message side adds little today).",
  confidence: "Fused confidence across the pair's signals.",
  value: "How much message history the merge unifies (the smaller side's volume), confidence as tiebreak."
};

type ConnectedSortMode = "unified" | "messages" | "recent" | "members";

const CONNECTED_SORT_EXPLAINERS: Record<ConnectedSortMode, string> = {
  unified: "History unified beyond the person's largest identity — what connecting actually brought together.",
  messages: "Total messages across all of the person's numbers.",
  recent: "Most recently connected or changed first.",
  members: "Most numbers first."
};

function personTotalMessages(person: PersonRecord): number {
  return person.members.reduce((sum, member) => sum + member.messageCount, 0);
}

// What the merge consolidated: everything beyond the largest single identity.
function personUnifiedValue(person: PersonRecord): number {
  const counts = person.members.map((member) => member.messageCount);
  return personTotalMessages(person) - Math.max(0, ...counts);
}

// One card per pair: every stored signal for the same two identities, with
// confidence fused as a noisy-OR — independent corroborating signals each
// shrink the remaining doubt, and no inferred combination reaches certainty.
interface SuggestionGroup {
  key: string;
  jidLow: string;
  jidHigh: string;
  lowLabel: string | null;
  highLabel: string | null;
  lowPhone: string | null;
  highPhone: string | null;
  lowChatId: number | null;
  highChatId: number | null;
  lowMessageCount: number;
  highMessageCount: number;
  lowMentionCount: number;
  highMentionCount: number;
  lowGroupCount: number;
  highGroupCount: number;
  signals: PersonSuggestionRecord[];
  combinedScore: number;
}

function groupByPair(suggestions: PersonSuggestionRecord[]): SuggestionGroup[] {
  const groups = new Map<string, SuggestionGroup>();
  for (const suggestion of suggestions) {
    const key = `${suggestion.jidLow}|${suggestion.jidHigh}`;
    const existing = groups.get(key);
    if (existing) {
      existing.signals.push(suggestion);
    } else {
      groups.set(key, {
        key,
        jidLow: suggestion.jidLow,
        jidHigh: suggestion.jidHigh,
        lowLabel: suggestion.lowLabel,
        highLabel: suggestion.highLabel,
        lowPhone: suggestion.lowPhone,
        highPhone: suggestion.highPhone,
        lowChatId: suggestion.lowChatId,
        highChatId: suggestion.highChatId,
        lowMessageCount: suggestion.lowMessageCount ?? 0,
        highMessageCount: suggestion.highMessageCount ?? 0,
        lowMentionCount: suggestion.lowMentionCount ?? 0,
        highMentionCount: suggestion.highMentionCount ?? 0,
        lowGroupCount: suggestion.lowGroupCount ?? 0,
        highGroupCount: suggestion.highGroupCount ?? 0,
        signals: [suggestion],
        combinedScore: 0
      });
    }
  }
  for (const group of groups.values()) {
    group.signals.sort((a, b) => b.score - a.score);
    const doubt = group.signals.reduce((left, signal) => left * (1 - signal.score), 1);
    group.combinedScore = Math.min(0.97, 1 - doubt);
  }
  return [...groups.values()];
}

export function mergeValue(group: Pick<SuggestionGroup, "lowMessageCount" | "highMessageCount">): number {
  return Math.min(group.lowMessageCount, group.highMessageCount);
}

export function recommendedScore(group: Pick<SuggestionGroup, "combinedScore" | "lowMessageCount" | "highMessageCount">): number {
  const valueNorm = Math.min(1, Math.log10(1 + mergeValue(group)) / 3.5);
  return 0.65 * group.combinedScore + 0.35 * valueNorm;
}


function relativeTime(ms: number | null | undefined): string | null {
  if (!ms) return null;
  const delta = Date.now() - ms;
  if (delta < 45_000) return "just now";
  if (delta < 90_000) return "a minute ago";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatDay(ms: unknown): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toLocaleDateString() : null;
}

function phoneChip(phone: string | null): string | null {
  return phone ? `+${phone.replace(/^\+/, "")}` : null;
}

// Audit-line identity formatting: complete number for phone-form JIDs, an
// honest generic for anything else — never a raw internal identifier.
function auditIdentity(jid: string | null): string | null {
  if (!jid) return null;
  if (jid.endsWith("@s.whatsapp.net")) return `+${jid.split("@")[0]}`;
  if (jid.endsWith("@lid") || jid.endsWith("@hosted.lid")) return "an unresolved identity";
  return jid;
}

const EVENT_VERBS: Record<PersonLinkEventRecord["action"], string> = {
  connect: "Connected",
  disconnect: "Disconnected",
  union: "Merged two persons",
  dissolve: "Dissolved a person",
  suggest: "Suggested",
  accept: "Accepted a suggestion",
  reject: "Dismissed a suggestion",
  unreject: "Undid a dismissal",
  release: "Released a block"
};

const SUPPRESSION_REASONS: Record<PersonLinkSuppressionRecord["reason"], string> = {
  disconnected: "you disconnected them",
  suggestion_rejected: "you dismissed a suggestion"
};

// Accept a full JID or a human-typed number ("+91 90081 11144") and produce
// the canonical phone-form JID.
function jidFromInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.includes("@")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  return digits.length >= 8 ? `${digits}@s.whatsapp.net` : null;
}

function auditLine(event: PersonLinkEventRecord): string {
  const identity = auditIdentity(event.identityJid);
  const evidence = event.evidence ?? {};
  const pair =
    typeof evidence.jidLow === "string" && typeof evidence.jidHigh === "string"
      ? `${auditIdentity(evidence.jidLow as string)} ↔ ${auditIdentity(evidence.jidHigh as string)}`
      : null;
  const parts = [EVENT_VERBS[event.action] ?? event.action];
  if (identity) parts.push(identity);
  else if (pair) parts.push(pair);
  if (event.source) parts.push(`via ${SOURCE_LABELS[event.source]?.toLowerCase() ?? event.source}`);
  const when = relativeTime(Date.parse(event.createdAt));
  if (when) parts.push(`· ${when}`);
  return parts.join(" ");
}

// Human-readable one-liners per signal; the raw payloads stay collapsed.
function friendlyEvidence(suggestion: PersonSuggestionRecord): string[] {
  const evidence = suggestion.evidence;
  const lines: string[] = [];
  const chatLabel = (id: unknown): string =>
    typeof id === "string" ? suggestion.chatLabels[id] ?? "an unnamed group" : "an unnamed group";
  if (suggestion.kind === "same_name") {
    lines.push(`Both are saved as “${String(evidence.name ?? suggestion.lowLabel)}” in your contacts.`);
    lines.push(
      `Message history: ${(suggestion.lowMessageCount ?? 0).toLocaleString()} vs ${(suggestion.highMessageCount ?? 0).toLocaleString()} messages.`
    );
  } else if (suggestion.kind === "succession") {
    const enderIsLow = evidence.enderJid ? evidence.enderJid === suggestion.jidLow : null;
    const enderLabel = enderIsLow == null ? "One number" : enderIsLow ? suggestion.lowLabel : suggestion.highLabel;
    const starterLabel = enderIsLow == null ? "the other" : enderIsLow ? suggestion.highLabel : suggestion.lowLabel;
    const lastSeen = formatDay(evidence.enderLastMs);
    const firstSeen = formatDay(evidence.starterFirstMs);
    const gapDays = typeof evidence.gapMs === "number" ? Math.max(0, Math.round(evidence.gapMs / 86_400_000)) : null;
    lines.push(
      `${enderLabel ?? "One number"} went silent${lastSeen ? ` around ${lastSeen}` : ""}, and ${starterLabel ?? "the other"} first appeared${firstSeen ? ` on ${firstSeen}` : ""}${gapDays != null ? ` (~${gapDays} day gap)` : ""} — in the same groups.`
    );
    if (Array.isArray(evidence.sharedChats) && evidence.sharedChats.length > 0) {
      lines.push(`Shared groups: ${evidence.sharedChats.map(chatLabel).join(", ")}.`);
    }
    if (Array.isArray(evidence.membershipHandoffGroups) && evidence.membershipHandoffGroups.length > 0) {
      lines.push(`Group history shows an explicit leave→join handoff in ${evidence.membershipHandoffGroups.map(chatLabel).join(", ")}.`);
    }
  } else if (suggestion.kind === "shared_vcard") {
    lines.push(`A contact card named “${String(evidence.vcardName ?? "")}” was shared in a chat and resolves to the other number.`);
  } else if (suggestion.kind === "co_citation") {
    const episodes = evidence.coCitedEpisodes;
    lines.push(`Mentioned together in ${typeof episodes === "number" ? episodes : "several"} brain episode(s).`);
  } else if (suggestion.kind === "shared_group") {
    const count = evidence.sharedGroupCount;
    lines.push(`Together in ${typeof count === "number" ? count : "several"} groups (retired signal).`);
  }
  return lines;
}

function groupEvidence(group: SuggestionGroup): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const signal of group.signals) {
    for (const line of friendlyEvidence(signal)) {
      if (!seen.has(line)) {
        seen.add(line);
        lines.push(line);
      }
    }
  }
  return lines;
}

function IdentitySide({ label, phone }: { label: string | null; phone: string | null }) {
  return (
    <span className="personIdentity">
      <strong>{label ?? "Unresolved"}</strong>
      {phone && label !== phoneChip(phone) && <span className="muted personPhone">{phoneChip(phone)}</span>}
    </span>
  );
}

// Progressive-enhancement avatar: the cached/live-fetched photo when the
// server has one, an initial-letter placeholder otherwise — never a gate.
function Avatar({ jid, label }: { jid: string; label: string | null }) {
  const [failed, setFailed] = useState(false);
  const initial = (label ?? "").replace(/[^\p{L}]/gu, "").charAt(0).toUpperCase() || "#";
  if (failed) {
    return <span className="personAvatar personAvatarFallback">{initial}</span>;
  }
  // Deliberately not loading="lazy": a couple of tiny modal images gain
  // nothing from it, and lazy images never load in zero-viewport embeds.
  return <img className="personAvatar" src={personAvatarUrl(jid)} alt="" onError={() => setFailed(true)} />;
}

// A debt item: an identity the brain still refers to by bare number, fixable
// in place — naming it repairs episodes and search deterministically.
function DebtCard({ item, busy, onRename }: { item: BrainResolutionDebtIdentity; busy: boolean; onRename: (jid: string, name: string, label: string) => void }) {
  const [name, setName] = useState("");
  return (
    <li className="personSuggestion personDebt">
      <div className="personPair">
        <span className="personIdentity">
          <strong>{item.label}</strong>
        </span>
        <span
          className="badge tipChip"
          tabIndex={0}
          data-tip="The brain's episodes still refer to this person by their bare number. Naming them repairs that prose and the search index deterministically — no model calls."
        >
          Needs a name
        </span>
      </div>
      <ul className="personEvidenceLines">
        <li className="muted">
          Referred to by number in {item.episodeCount.toLocaleString()} episode(s) · {item.messageCount.toLocaleString()} messages behind them.
        </li>
      </ul>
      <form
        className="personRenameForm"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) onRename(item.jid, name.trim(), item.label);
        }}
      >
        <input
          type="text"
          value={name}
          placeholder="Who is this?"
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
        />
        <button type="submit" disabled={busy || !name.trim()}>
          Name contact
        </button>
      </form>
    </li>
  );
}

// The merge's concrete value proposition, identical on every card regardless
// of which detector produced it: what a connect would unify.
function ValueLine({ group }: { group: SuggestionGroup }) {
  const parts = [
    `${group.lowMessageCount.toLocaleString()} + ${group.highMessageCount.toLocaleString()} messages`,
    `${group.lowMentionCount.toLocaleString()} + ${group.highMentionCount.toLocaleString()} mentions`,
    `in ${group.lowGroupCount.toLocaleString()} + ${group.highGroupCount.toLocaleString()} groups`
  ];
  return (
    <p
      className="personValueLine tipChip"
      tabIndex={0}
      data-tip="What connecting would unify under one person: each side's sent messages, times they were @mentioned, and group memberships."
    >
      Unifies {parts.join(" · ")}
    </p>
  );
}

function SignalChips({ group }: { group: SuggestionGroup }) {
  return (
    <>
      {group.signals.length > 1 && (
        <span
          className="badge tipChip personCombined"
          tabIndex={0}
          data-tip="Independent signals corroborate each other: each one shrinks the remaining doubt (never reaching certainty without a platform fact)."
        >
          {(group.combinedScore * 100).toFixed(0)}% · {group.signals.length} signals
        </span>
      )}
      {group.signals.map((signal) => (
        <span key={signal.id} className="badge tipChip" tabIndex={0} data-tip={KIND_EXPLAINERS[signal.kind] ?? ""}>
          {KIND_LABELS[signal.kind] ?? signal.kind} · {(signal.score * 100).toFixed(0)}%
        </span>
      ))}
    </>
  );
}

// In-place decision dialog: both DM threads side by side, all evidence, and
// pair-level confirm/deny — no navigation away from the queue.
function CompareDialog({
  group,
  busy,
  onAccept,
  onReject,
  onClose
}: {
  group: SuggestionGroup;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
  onClose: () => void;
}) {
  const [threads, setThreads] = useState<Record<"low" | "high", MessageListItem[] | null | "loading">>({
    low: "loading",
    high: "loading"
  });
  const [activity, setActivity] = useState<Record<"low" | "high", IdentityRecentMessage[] | null | "loading">>({
    low: "loading",
    high: "loading"
  });
  const [context, setContext] = useState<PersonCompareContext | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadThread = async (side: "low" | "high", chatId: number | null) => {
      if (chatId == null) {
        if (!cancelled) setThreads((current) => ({ ...current, [side]: null }));
        return;
      }
      try {
        const messages = await listMessages(chatId, { limit: 20, order: "desc" });
        if (!cancelled) setThreads((current) => ({ ...current, [side]: [...messages].reverse() }));
      } catch {
        if (!cancelled) setThreads((current) => ({ ...current, [side]: null }));
      }
    };
    // Activity across every chat — groups included — so a group-only
    // identity is never a dead end here.
    const loadActivity = async (side: "low" | "high", jid: string) => {
      try {
        const response = await listIdentityRecentMessages(jid, 15);
        if (!cancelled) setActivity((current) => ({ ...current, [side]: response.messages }));
      } catch {
        if (!cancelled) setActivity((current) => ({ ...current, [side]: null }));
      }
    };
    void loadThread("low", group.lowChatId);
    void loadThread("high", group.highChatId);
    void loadActivity("low", group.jidLow);
    void loadActivity("high", group.jidHigh);
    // Media strips + shared-group timeline arrive in one request; missing
    // context degrades to text-only evidence, never a gate.
    getPersonCompareContext(group.jidLow, group.jidHigh)
      .then((response) => {
        if (!cancelled) setContext(response);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [group]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sides: Array<{ key: "low" | "high"; jid: string; label: string | null; phone: string | null; chatId: number | null }> = [
    { key: "low", jid: group.jidLow, label: group.lowLabel, phone: group.lowPhone, chatId: group.lowChatId },
    { key: "high", jid: group.jidHigh, label: group.highLabel, phone: group.highPhone, chatId: group.highChatId }
  ];

  const membershipWindow = (side: { joinedAtMs: number | null; leftAtMs: number | null } | null): string => {
    if (!side) return "not a member";
    const joined = side.joinedAtMs ? `joined ${formatDay(side.joinedAtMs)}` : "member";
    return side.leftAtMs ? `${joined} · left ${formatDay(side.leftAtMs)}` : `${joined} · still in`;
  };

  const renderActivity = (side: "low" | "high", hasDm: boolean) => {
    const rows = activity[side];
    if (rows === "loading") return <p className="muted">Loading activity…</p>;
    if (rows === null) return <p className="muted">Couldn't load cross-chat activity.</p>;
    // The DM thread above already shows direct-chat content in full context.
    const visible = hasDm ? rows.filter((row) => row.chatType !== "dm" && row.chatType !== "unknown") : rows;
    if (visible.length === 0) {
      return (
        <p className="muted">
          {hasDm ? "No messages from this number in any group." : "No visible messages from this number anywhere — a silent group member."}
        </p>
      );
    }
    return visible.map((row, index) => (
      <div key={index} className="personCompareMessage">
        <span className="muted personCompareWhen">
          <Link className="personChatLink" to={`/chats/${row.chatId}`} target="_blank" rel="noreferrer" title="Open this chat in a new tab">
            {row.chatLabel ?? "Unnamed chat"}
          </Link>
          {" · "}
          {row.timestampMs ? new Date(row.timestampMs).toLocaleDateString() : ""}
        </span>
        <span>{row.text ?? `(${row.messageType})`}</span>
      </div>
    ));
  };

  return (
    <div className="modalBackdrop personCompareBackdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="personCompareDialog" role="dialog" aria-modal="true" aria-label="Compare identities">
        <div className="personCompareHeader">
          <div className="personPair">
            <IdentitySide label={group.lowLabel} phone={group.lowPhone} />
            <span className="muted">↔</span>
            <IdentitySide label={group.highLabel} phone={group.highPhone} />
            <SignalChips group={group} />
          </div>
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </div>
        <ValueLine group={group} />
        <ul className="personEvidenceLines">
          {groupEvidence(group).map((line, index) => (
            <li key={index} className="muted">
              {line}
            </li>
          ))}
        </ul>
        {context && context.sharedGroups.length > 0 && (
          <div className="personTimeline">
            <span className="muted personCompareSection">Shared groups</span>
            {context.sharedGroups.map((entry) => (
              <p key={entry.groupSourceId} className="muted personTimelineRow">
                <strong>{entry.label ?? "Unnamed group"}</strong>: {group.lowLabel ?? "A"} {membershipWindow(entry.low)} / {group.highLabel ?? "B"}{" "}
                {membershipWindow(entry.high)}
              </p>
            ))}
          </div>
        )}
        <div className="personCompareColumns">
          {sides.map((side) => {
            const hasDm = side.chatId != null;
            const media = (side.key === "low" ? context?.lowMedia : context?.highMedia)?.filter((item) => item.hasThumbnail) ?? [];
            return (
              <div key={side.key} className="personCompareColumn">
                <div className="personCompareColumnHeader">
                  <Avatar jid={side.jid} label={side.label} />
                  <strong>{side.label ?? "Unresolved"}</strong>
                  {side.phone && side.label !== phoneChip(side.phone) && <span className="muted">{phoneChip(side.phone)}</span>}
                  {hasDm && (
                    <Link className="personChatLink" to={`/chats/${side.chatId}`} target="_blank" rel="noreferrer" title="Open the full chat in a new tab">
                      full chat ↗
                    </Link>
                  )}
                </div>
                {media.length > 0 && (
                  <div className="personMediaStrip">
                    {media.map((item) => (
                      <img
                        key={item.assetId}
                        src={mediaThumbnailUrl(item.assetId)}
                        alt=""
                        title={`${item.chatLabel ?? ""}${item.timestampMs ? ` · ${new Date(item.timestampMs).toLocaleDateString()}` : ""}`}
                      />
                    ))}
                  </div>
                )}
                <div className="personCompareThread">
                  {hasDm && (
                    <>
                      <span className="muted personCompareSection">Direct chat</span>
                      {threads[side.key] === "loading" && <p className="muted">Loading recent messages…</p>}
                      {Array.isArray(threads[side.key]) && (threads[side.key] as MessageListItem[]).length === 0 && (
                        <p className="muted">The direct chat has no visible messages.</p>
                      )}
                      {Array.isArray(threads[side.key]) &&
                        (threads[side.key] as MessageListItem[]).map((message) => (
                          <div key={message.id} className={`personCompareMessage ${message.direction === "outgoing" ? "outgoing" : ""}`}>
                            <span className="muted personCompareWhen">
                              {message.timestampMs ? new Date(message.timestampMs).toLocaleDateString() : ""}
                              {message.direction === "outgoing" ? " · you" : ""}
                            </span>
                            <span>{message.body?.trim() || message.caption?.trim() || message.interpretation?.label || "…"}</span>
                          </div>
                        ))}
                    </>
                  )}
                  <span className="muted personCompareSection">{hasDm ? "Around the groups" : "Recent activity (no direct chat)"}</span>
                  {renderActivity(side.key, hasDm)}
                </div>
              </div>
            );
          })}
        </div>
        <div className="personActions personCompareActions">
          <button type="button" onClick={onAccept} disabled={busy}>
            Same person
          </button>
          <button type="button" className="secondary" onClick={onReject} disabled={busy}>
            Different people
          </button>
        </div>
      </div>
    </div>
  );
}

export function PeoplePage() {
  const { setNotice, setError } = useToast();
  const [persons, setPersons] = useState<PersonRecord[]>([]);
  const [suggestions, setSuggestions] = useState<PersonSuggestionRecord[]>([]);
  const [dismissed, setDismissed] = useState<PersonSuggestionRecord[]>([]);
  const [suppressions, setSuppressions] = useState<PersonLinkSuppressionRecord[]>([]);
  const [debt, setDebt] = useState<BrainResolutionDebtIdentity[]>([]);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectA, setConnectA] = useState("");
  const [connectB, setConnectB] = useState("");
  const [scan, setScan] = useState<PersonScanStatus | null>(null);
  const [tab, setTab] = useState<"suggestions" | "debt" | "connected" | "dismissed">("suggestions");
  const [kindFilter, setKindFilter] = useState<PersonSuggestionKind | "all">("all");
  const [sortMode, setSortMode] = useState<SortMode>("recommended");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [connectedSort, setConnectedSort] = useState<ConnectedSortMode>("unified");
  const [showIntro, setShowIntro] = useState(false);
  const [compare, setCompare] = useState<SuggestionGroup | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [undoNote, setUndoNote] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<PersonLinkEventRecord[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [personsResponse, pendingResponse, rejectedResponse, debtResponse, suppressionsResponse] = await Promise.all([
        listPersons(),
        listPersonSuggestions("pending"),
        listPersonSuggestions("rejected"),
        listPersonDebt(),
        listPersonSuppressions()
      ]);
      setPersons(personsResponse.persons);
      setScan(personsResponse.scan ?? null);
      setSuggestions(pendingResponse.suggestions);
      setDismissed(rejectedResponse.suggestions);
      setDebt(debtResponse.items);
      setSuppressions(suppressionsResponse.suppressions);
      setLoaded(true);
      setLoadError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not load people.";
      setLoadError(message);
      setError(message);
    }
  }, [setError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Background auto-connects, detector runs, and syncs surface without a
  // reload: debounce-refresh on the archive-events stream.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onArchiveEvent = useCallback(
    (_change: ArchiveChangeEvent) => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        void refresh();
        if (historyOpen) {
          listPersonEvents(100).then((response) => setHistory(response.events)).catch(() => undefined);
        }
      }, 1_500);
    },
    [refresh, historyOpen]
  );
  useArchiveEvents(onArchiveEvent);
  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);

  useEffect(() => {
    if (historyOpen && history === null) {
      listPersonEvents(100)
        .then((response) => setHistory(response.events))
        .catch((err) => setError(err instanceof Error ? err.message : "Could not load the history."));
    }
  }, [historyOpen, history, setError]);

  const pairGroups = useMemo(() => groupByPair(suggestions), [suggestions]);
  const dismissedGroups = useMemo(() => groupByPair(dismissed), [dismissed]);

  const kinds = useMemo(() => {
    const counts = new Map<PersonSuggestionKind, number>();
    for (const group of pairGroups) {
      for (const kind of new Set(group.signals.map((signal) => signal.kind))) {
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [pairGroups]);

  const visibleGroups = useMemo(() => {
    const filtered =
      kindFilter === "all" ? pairGroups : pairGroups.filter((group) => group.signals.some((signal) => signal.kind === kindFilter));
    const sorted = [...filtered];
    if (sortMode === "confidence") {
      sorted.sort((a, b) => b.combinedScore - a.combinedScore || mergeValue(b) - mergeValue(a));
    } else if (sortMode === "value") {
      sorted.sort((a, b) => mergeValue(b) - mergeValue(a) || b.combinedScore - a.combinedScore);
    } else {
      sorted.sort((a, b) => recommendedScore(b) - recommendedScore(a));
    }
    return sorted;
  }, [pairGroups, kindFilter, sortMode]);

  const sourceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const person of persons) {
      for (const source of new Set(person.members.map((member) => member.source))) {
        counts.set(source, (counts.get(source) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [persons]);

  const visiblePersons = useMemo(() => {
    const filtered =
      sourceFilter === "all" ? persons : persons.filter((person) => person.members.some((member) => member.source === sourceFilter));
    const sorted = [...filtered];
    if (connectedSort === "messages") {
      sorted.sort((a, b) => personTotalMessages(b) - personTotalMessages(a) || personUnifiedValue(b) - personUnifiedValue(a));
    } else if (connectedSort === "recent") {
      sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } else if (connectedSort === "members") {
      sorted.sort((a, b) => b.members.length - a.members.length || personTotalMessages(b) - personTotalMessages(a));
    } else {
      sorted.sort((a, b) => personUnifiedValue(b) - personUnifiedValue(a) || personTotalMessages(b) - personTotalMessages(a));
    }
    return sorted;
  }, [persons, sourceFilter, connectedSort]);

  const lastScanMs = scan ? Math.max(scan.lastAutoConnectAtMs ?? 0, scan.lastDetectorAtMs ?? 0) || null : null;
  const scanFreshness = lastScanMs
    ? `Last scan ${relativeTime(lastScanMs)}.`
    : loaded
      ? "No scan yet in this server session."
      : "";

  async function handleScan() {
    setBusy(true);
    setError(null);
    try {
      const result = await runPersonScan();
      const connected = result.autoConnect.googleConnected + result.autoConnect.numberChangeConnected;
      setNotice(
        `Scan complete: ${connected} auto-connected (${result.autoConnect.googleConnected} Google, ${result.autoConnect.numberChangeConnected} number change), ` +
          `${result.detectors.created} new suggestion(s).`
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Person scan failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect(jid: string, label: string | null) {
    if (!window.confirm(`Disconnect ${label ?? jid} from this person? Auto-connect will not silently redo it.`)) return;
    setBusy(true);
    setError(null);
    try {
      await disconnectPersonIdentity(jid);
      setNotice(`Disconnected ${label ?? jid}. Nothing in the brain changed — this is membership metadata only.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Disconnect failed.");
    } finally {
      setBusy(false);
    }
  }

  // Accepting any one signal connects the pair; the connect supersedes the
  // pair's other pending signals in the same transaction.
  async function handleAccept(group: SuggestionGroup) {
    setBusy(true);
    setError(null);
    try {
      await acceptPersonSuggestion(group.signals[0].id);
      setNotice(`Connected ${group.lowLabel ?? group.jidLow} and ${group.highLabel ?? group.jidHigh}.`);
      setCompare(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not accept the suggestion.");
    } finally {
      setBusy(false);
    }
  }

  // "Different people" is a judgment about the PAIR: every signal's row is
  // rejected so none of them can ever re-suggest it.
  async function handleReject(group: SuggestionGroup) {
    setBusy(true);
    setError(null);
    try {
      for (const signal of group.signals) {
        await rejectPersonSuggestion(signal.id);
      }
      setNotice(
        group.signals.length > 1
          ? `Dismissed. None of the ${group.signals.length} signals will suggest this pair again.`
          : "Dismissed. This pair will not be suggested again for that signal."
      );
      setCompare(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reject the suggestion.");
    } finally {
      setBusy(false);
    }
  }

  // Release only lifts the block — the pair becomes eligible for auto-connect
  // and suggestions again; nothing connects here.
  async function handleRelease(suppression: PersonLinkSuppressionRecord) {
    setBusy(true);
    setError(null);
    try {
      await releasePersonSuppression(suppression.jidLow, suppression.jidHigh);
      setNotice("Block released — the next sync or scan may reconnect or re-suggest this pair.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not release the block.");
    } finally {
      setBusy(false);
    }
  }

  // Manual connect: works for any two numbers, suggested or not; a user
  // connect also clears any block on the pair.
  async function handleManualConnect() {
    const jidA = jidFromInput(connectA);
    const jidB = jidFromInput(connectB);
    if (!jidA || !jidB) {
      setError("Enter two phone numbers (with country code) or identity ids.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await connectPersonIdentities(jidA, jidB);
      if (result.result.outcome === "already_connected") {
        setNotice("Those two are already the same person.");
      } else if (result.result.outcome === "union") {
        setNotice("Connected — two existing persons merged into one.");
      } else {
        setNotice(`Connected. ${result.person?.displayLabel ? `They now appear as ${result.person.displayLabel}.` : ""}`);
      }
      setConnectA("");
      setConnectB("");
      setConnectOpen(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect those identities.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRename(jid: string, name: string, label: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await renamePersonIdentity(jid, name);
      setNotice(
        result.repairedEpisodes > 0
          ? `Named ${label} as “${result.name}” — repaired ${result.repairedEpisodes.toLocaleString()} episode(s), no model calls.`
          : `Named ${label} as “${result.name}”.`
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the name.");
    } finally {
      setBusy(false);
    }
  }

  // Undo is pair-level and honest about the race with hygiene pruning: after
  // the restore, re-check whether the pair survived the refresh; a zero-value
  // pair legitimately gets re-pruned by the next pass.
  async function handleUndo(group: SuggestionGroup) {
    setBusy(true);
    setError(null);
    setUndoNote(null);
    try {
      const result = await undoPersonDismissal(group.jidLow, group.jidHigh);
      await refresh();
      const nowPending = await listPersonSuggestions("pending");
      const restoredVisible = nowPending.suggestions.some(
        (suggestion) => suggestion.jidLow === group.jidLow && suggestion.jidHigh === group.jidHigh
      );
      if (restoredVisible) {
        setNotice(`Restored ${result.restored} signal(s) — the pair is back in the queue.`);
      } else {
        setUndoNote(
          `${group.lowLabel ?? group.jidLow} ↔ ${group.highLabel ?? group.jidHigh}: restored, then re-pruned by hygiene (no unifiable history yet — it returns when either number speaks).`
        );
        setNotice(`Restored ${result.restored} signal(s).`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not undo the dismissal.");
    } finally {
      setBusy(false);
    }
  }

  function openCompareFromCard(event: React.MouseEvent, group: SuggestionGroup) {
    if ((event.target as HTMLElement).closest("button, a, details, summary, input, form")) return;
    setCompare(group);
  }

  const renderPairCard = (group: SuggestionGroup) => (
    <li key={group.key} className="personSuggestion clickable" onClick={(event) => openCompareFromCard(event, group)} title="Click to compare both chats side by side">
      <div className="personPair">
        <IdentitySide label={group.lowLabel} phone={group.lowPhone} />
        <span className="muted">↔</span>
        <IdentitySide label={group.highLabel} phone={group.highPhone} />
        <SignalChips group={group} />
      </div>
      <ValueLine group={group} />
      <ul className="personEvidenceLines">
        {groupEvidence(group).map((line, index) => (
          <li key={index} className="muted">
            {line}
          </li>
        ))}
      </ul>
      <details className="personRawEvidence">
        <summary className="muted">Raw evidence</summary>
        <pre>{JSON.stringify(Object.fromEntries(group.signals.map((signal) => [signal.kind, signal.evidence])), null, 1)}</pre>
      </details>
      <div className="personActions">
        <button type="button" className="secondary" onClick={() => setCompare(group)}>
          Compare chats
        </button>
        <button type="button" onClick={() => void handleAccept(group)} disabled={busy}>
          Same person
        </button>
        <button type="button" className="secondary" onClick={() => void handleReject(group)} disabled={busy}>
          Different people
        </button>
      </div>
    </li>
  );

  return (
    <div className="peoplePage">
      <div className="toolHeader">
        <span className="eyebrow">People</span>
        <p>
          One person, many numbers — connect and disconnect without touching the archive or the brain.{" "}
          <button type="button" className="personLinkButton" onClick={() => setShowIntro((current) => !current)}>
            {showIntro ? "Less" : "How does this work?"}
          </button>
        </p>
        {showIntro && (
          <div className="muted personIntro">
            <p>
              Certainty-grade signals connect automatically: numbers saved under one Google contact, and WhatsApp's own
              “changed their phone number” messages. Everything else — matching names, succession patterns, shared contact
              cards — only ever becomes a suggestion for you to confirm or dismiss. When several independent signals point at
              the same pair they appear as one card with a combined confidence, and dismissing it silences all of them.
              Dismissals are remembered forever.
            </p>
            <p>
              Scans run automatically while the server is on (auto-connect with every sync tick, detectors every few minutes);
              rescan manually right after a big import or a Google sync. Connecting never edits messages, episodes, or claims —
              it's reversible metadata, and provenance is shown on every link.
            </p>
          </div>
        )}
        <div className="personScanRow">
          <button type="button" className="primaryButton" onClick={() => void handleScan()} disabled={busy}>
            {busy ? <Loader2 className="spin" size={16} /> : <RefreshCcw size={16} />} Rescan
          </button>
          <span className="muted">{scanFreshness}</span>
        </div>
      </div>

      {loadError && !loaded && (
        <section className="panel">
          <p className="muted">Couldn't load people: {loadError}</p>
          <button type="button" onClick={() => void refresh()} disabled={busy}>
            Retry
          </button>
        </section>
      )}

      <div className="personTabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "suggestions"} className={tab === "suggestions" ? "active" : ""} onClick={() => setTab("suggestions")}>
          Suggested connections ({pairGroups.length})
        </button>
        <button type="button" role="tab" aria-selected={tab === "debt"} className={tab === "debt" ? "active" : ""} onClick={() => setTab("debt")}>
          Needs names ({debt.length})
        </button>
        <button type="button" role="tab" aria-selected={tab === "connected"} className={tab === "connected" ? "active" : ""} onClick={() => setTab("connected")}>
          Connected people ({persons.length})
        </button>
        <button type="button" role="tab" aria-selected={tab === "dismissed"} className={tab === "dismissed" ? "active" : ""} onClick={() => setTab("dismissed")}>
          Dismissed & blocked ({dismissedGroups.length + suppressions.length})
        </button>
      </div>

      {tab === "debt" && (
        <section className="panel">
          <p className="muted">
            People the brain's episodes still refer to by bare number, ranked by how much content a name would repair. Naming
            them fixes episodes and search instantly — no model calls.
          </p>
          {debt.length === 0 && (
            <p className="muted">{loaded ? "No naming needs — everyone in the brain's episodes has a name." : loadError ? "Not loaded." : "Loading…"}</p>
          )}
          <ul className="personSuggestionList">
            {debt.map((item) => (
              <DebtCard key={item.jid} item={item} busy={busy} onRename={(jid, name, label) => void handleRename(jid, name, label)} />
            ))}
          </ul>
        </section>
      )}

      {tab === "suggestions" && (
        <section className="panel">
          <div className="personListControls">
            {kinds.length > 1 && (
              <div className="personFilters">
                <button type="button" className={kindFilter === "all" ? "active" : ""} onClick={() => setKindFilter("all")}>
                  All ({pairGroups.length})
                </button>
                {kinds.map(([kind, count]) => (
                  <button type="button" key={kind} className={kindFilter === kind ? "active" : ""} onClick={() => setKindFilter(kind)}>
                    {KIND_LABELS[kind] ?? kind} ({count})
                  </button>
                ))}
              </div>
            )}
            <label className="personSort">
              <span className="muted">Sort</span>
              <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)} title={SORT_EXPLAINERS[sortMode]}>
                <option value="recommended">Recommended</option>
                <option value="confidence">Confidence</option>
                <option value="value">Potential value</option>
              </select>
            </label>
          </div>
          <p className="muted">
            Pairs of numbers the detectors believe may be the same person — you decide. Confirming connects them; dismissing is
            remembered.
          </p>
          {visibleGroups.length === 0 && (
            <p className="muted">{loaded ? "No suggested connections right now." : loadError ? "Not loaded." : "Loading…"}</p>
          )}
          <ul className="personSuggestionList">{visibleGroups.map(renderPairCard)}</ul>
        </section>
      )}

      {tab === "connected" && (
        <section className="panel">
          <div className="personConnectManual">
            <button type="button" className="personLinkButton" onClick={() => setConnectOpen((current) => !current)}>
              {connectOpen ? "Cancel" : "Connect two numbers manually"}
            </button>
            {connectOpen && (
              <form
                className="personRenameForm"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleManualConnect();
                }}
              >
                <input type="text" value={connectA} placeholder="+91 98765 43210" onChange={(event) => setConnectA(event.target.value)} disabled={busy} />
                <span className="muted">↔</span>
                <input type="text" value={connectB} placeholder="+1 415 555 0100" onChange={(event) => setConnectB(event.target.value)} disabled={busy} />
                <button type="submit" disabled={busy || !connectA.trim() || !connectB.trim()}>
                  Connect
                </button>
              </form>
            )}
          </div>
          <div className="personListControls">
            {sourceCounts.length > 1 && (
              <div className="personFilters">
                <button type="button" className={sourceFilter === "all" ? "active" : ""} onClick={() => setSourceFilter("all")}>
                  All ({persons.length})
                </button>
                {sourceCounts.map(([source, count]) => (
                  <button type="button" key={source} className={sourceFilter === source ? "active" : ""} onClick={() => setSourceFilter(source)}>
                    {SOURCE_LABELS[source] ?? source} ({count})
                  </button>
                ))}
              </div>
            )}
            <label className="personSort">
              <span className="muted">Sort</span>
              <select
                value={connectedSort}
                onChange={(event) => setConnectedSort(event.target.value as ConnectedSortMode)}
                title={CONNECTED_SORT_EXPLAINERS[connectedSort]}
              >
                <option value="unified">History unified</option>
                <option value="messages">Total messages</option>
                <option value="recent">Recently connected</option>
                <option value="members">Number count</option>
              </select>
            </label>
          </div>
          {visiblePersons.length === 0 && (
            <p className="muted">
              {loaded
                ? "No connected identities yet. Link numbers under one Google contact, or accept a suggestion."
                : loadError
                  ? "Not loaded."
                  : "Loading…"}
            </p>
          )}
          <ul className="personList">
            {visiblePersons.map((person) => (
              <li key={person.id} className="personCard">
                <div className="personCardHeader">
                  <strong>{person.displayLabel ?? "Unnamed person"}</strong>
                  <span className="muted personCardStats">
                    {person.members.length} numbers · {personTotalMessages(person).toLocaleString()} msgs
                    {personUnifiedValue(person) > 0 ? ` · ${personUnifiedValue(person).toLocaleString()} unified` : ""}
                  </span>
                  {person.unconfirmedHint && <span className="muted personHint">{person.unconfirmedHint}</span>}
                </div>
                <ul className="personMembers">
                  {person.members.map((member) => (
                    <li key={member.identityJid} className="personMember">
                      <span>{member.displayLabel ?? member.identityJid}</span>
                      {member.phoneNumber && <span className="muted">{phoneChip(member.phoneNumber)}</span>}
                      <span className="badge tipChip" tabIndex={0} data-tip={SOURCE_EXPLAINERS[member.source] ?? ""}>
                        {SOURCE_LABELS[member.source] ?? member.source}
                      </span>
                      <span className="muted">{member.messageCount.toLocaleString()} msgs</span>
                      <button
                        type="button"
                        className="secondary personRenameButton"
                        onClick={() => {
                          const name = window.prompt(`Name for ${member.displayLabel ?? member.identityJid}:`, member.displayLabel ?? "");
                          if (name?.trim()) void handleRename(member.identityJid, name.trim(), member.displayLabel ?? member.identityJid);
                        }}
                        disabled={busy}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => void handleDisconnect(member.identityJid, member.displayLabel)}
                        disabled={busy}
                      >
                        Disconnect
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === "dismissed" && (
        <section className="panel">
          <p className="muted">Dismissed pairs are remembered — the dismissed signals never suggest them again unless you undo.</p>
          {undoNote && <p className="muted personUndoNote">{undoNote}</p>}
          {dismissedGroups.length === 0 && <p className="muted">{loaded ? "Nothing dismissed yet." : "Loading…"}</p>}
          <ul className="personSuggestionList">
            {dismissedGroups.map((group) => (
              <li key={group.key} className="personSuggestion dismissed">
                <div className="personPair">
                  <IdentitySide label={group.lowLabel} phone={group.lowPhone} />
                  <span className="muted">↔</span>
                  <IdentitySide label={group.highLabel} phone={group.highPhone} />
                  {group.signals.map((signal) => (
                    <span key={signal.id} className="badge">
                      {KIND_LABELS[signal.kind] ?? signal.kind}
                    </span>
                  ))}
                  <button type="button" className="secondary personUndoButton" onClick={() => void handleUndo(group)} disabled={busy}>
                    Undo
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <h3 className="personBlockedHeading">Blocked pairs {suppressions.length > 0 ? `(${suppressions.length})` : ""}</h3>
          <p className="muted">
            Pairs auto-connect will never silently redo. Releasing a block doesn't connect anything — it just lets the next
            Google sync or scan consider the pair again.
          </p>
          {suppressions.length === 0 && <p className="muted">{loaded ? "No blocked pairs." : "Loading…"}</p>}
          <ul className="personSuggestionList">
            {suppressions.map((suppression) => (
              <li key={`${suppression.jidLow}|${suppression.jidHigh}`} className="personSuggestion dismissed">
                <div className="personPair">
                  <IdentitySide label={suppression.lowLabel ?? suppression.jidLow} phone={suppression.lowPhone ?? null} />
                  <span className="muted">↔</span>
                  <IdentitySide label={suppression.highLabel ?? suppression.jidHigh} phone={suppression.highPhone ?? null} />
                  <span className="badge tipChip" tabIndex={0} data-tip={`Blocked because ${SUPPRESSION_REASONS[suppression.reason]}. Auto-connect and detectors skip this pair until released.`}>
                    Blocked · {SUPPRESSION_REASONS[suppression.reason]}
                  </span>
                  <button type="button" className="secondary personUndoButton" onClick={() => void handleRelease(suppression)} disabled={busy}>
                    Release
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel personHistory">
        <button type="button" className="personLinkButton" onClick={() => setHistoryOpen((current) => !current)}>
          {historyOpen ? "Hide history" : "History"}
        </button>
        {historyOpen && (
          <ul className="personEventList">
            {history === null && <li className="muted">Loading…</li>}
            {history?.length === 0 && <li className="muted">No person-layer actions recorded yet.</li>}
            {history?.map((event) => (
              <li key={event.id} className="personEvent">
                <span>{auditLine(event)}</span>
                {event.evidence && Object.keys(event.evidence).length > 0 && (
                  <details className="personRawEvidence">
                    <summary className="muted">Evidence</summary>
                    <pre>{JSON.stringify(event.evidence, null, 1)}</pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {compare && (
        <CompareDialog
          group={compare}
          busy={busy}
          onAccept={() => void handleAccept(compare)}
          onReject={() => void handleReject(compare)}
          onClose={() => setCompare(null)}
        />
      )}
    </div>
  );
}
