import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, RefreshCcw } from "lucide-react";
import type {
  IdentityRecentMessage,
  MessageListItem,
  PersonRecord,
  PersonScanStatus,
  PersonSuggestionKind,
  PersonSuggestionRecord
} from "../../../shared/types";
import {
  acceptPersonSuggestion,
  disconnectPersonIdentity,
  listIdentityRecentMessages,
  listMessages,
  listPersons,
  listPersonSuggestions,
  rejectPersonSuggestion,
  runPersonScan
} from "../../api";
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

function mergeValue(group: SuggestionGroup): number {
  return Math.min(group.lowMessageCount, group.highMessageCount);
}

function recommendedScore(group: SuggestionGroup): number {
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

  const sides: Array<{ key: "low" | "high"; label: string | null; phone: string | null; chatId: number | null }> = [
    { key: "low", label: group.lowLabel, phone: group.lowPhone, chatId: group.lowChatId },
    { key: "high", label: group.highLabel, phone: group.highPhone, chatId: group.highChatId }
  ];

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
        <div className="personCompareColumns">
          {sides.map((side) => {
            const hasDm = side.chatId != null;
            return (
              <div key={side.key} className="personCompareColumn">
                <div className="personCompareColumnHeader">
                  <strong>{side.label ?? "Unresolved"}</strong>
                  {side.phone && side.label !== phoneChip(side.phone) && <span className="muted">{phoneChip(side.phone)}</span>}
                  {hasDm && (
                    <Link className="personChatLink" to={`/chats/${side.chatId}`} target="_blank" rel="noreferrer" title="Open the full chat in a new tab">
                      full chat ↗
                    </Link>
                  )}
                </div>
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
  const [scan, setScan] = useState<PersonScanStatus | null>(null);
  const [tab, setTab] = useState<"suggestions" | "connected" | "dismissed">("suggestions");
  const [kindFilter, setKindFilter] = useState<PersonSuggestionKind | "all">("all");
  const [sortMode, setSortMode] = useState<SortMode>("recommended");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [connectedSort, setConnectedSort] = useState<ConnectedSortMode>("unified");
  const [showIntro, setShowIntro] = useState(false);
  const [compare, setCompare] = useState<SuggestionGroup | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [personsResponse, pendingResponse, rejectedResponse] = await Promise.all([
        listPersons(),
        listPersonSuggestions("pending"),
        listPersonSuggestions("rejected")
      ]);
      setPersons(personsResponse.persons);
      setScan(personsResponse.scan ?? null);
      setSuggestions(pendingResponse.suggestions);
      setDismissed(rejectedResponse.suggestions);
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

  function openCompareFromCard(event: React.MouseEvent, group: SuggestionGroup) {
    if ((event.target as HTMLElement).closest("button, a, details, summary")) return;
    setCompare(group);
  }

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
          Suggestions ({pairGroups.length})
        </button>
        <button type="button" role="tab" aria-selected={tab === "connected"} className={tab === "connected" ? "active" : ""} onClick={() => setTab("connected")}>
          Connected people ({persons.length})
        </button>
        <button type="button" role="tab" aria-selected={tab === "dismissed"} className={tab === "dismissed" ? "active" : ""} onClick={() => setTab("dismissed")}>
          Dismissed ({dismissedGroups.length})
        </button>
      </div>

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
          {visibleGroups.length === 0 && (
            <p className="muted">{loaded ? "No pending suggestions." : loadError ? "Not loaded." : "Loading…"}</p>
          )}
          <ul className="personSuggestionList">
            {visibleGroups.map((group) => (
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
            ))}
          </ul>
        </section>
      )}

      {tab === "connected" && (
        <section className="panel">
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
          <p className="muted">Dismissed pairs are remembered — the dismissed signals never suggest them again.</p>
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
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

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
