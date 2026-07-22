import { CheckCircle2, CircleDot, HelpCircle, MessageSquare, Play, RotateCcw, Smile, X, XCircle } from "lucide-react";
import { useEffect } from "react";
import { Link } from "react-router-dom";
import type { BrainLifecycleItemDetail } from "../../../shared/types";

// The canonical surface for ONE lifecycle item: why it exists, the evidence a
// sweep would judge, its full history, and every action on it. Extracted from
// the commitments page so the run audit can open the same modal in place —
// reviewing what a run changed and undoing it should not require leaving the
// audit, and two divergent item UIs would drift.
//
// It renders entirely from `detail` (fetched by claim id), so it works on any
// host page regardless of what that page happens to have in a list.

const formatDay = (ms: number | null): string =>
  ms == null ? "—" : new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const formatDateTime = (ms: number | null): string =>
  ms == null ? "—" : new Date(ms).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

const CANDIDATE_LABEL: Record<"reaction" | "reply" | "claim", string> = {
  reaction: "Reaction on the promise",
  reply: "Reply quoting it",
  claim: "Later statement"
};

export function LifecycleDetailModal({
  detail,
  loading,
  busyClaim,
  canSweep,
  onClose,
  onTransition,
  onSweep,
  onStartNote
}: {
  detail: BrainLifecycleItemDetail | null;
  loading: boolean;
  busyClaim: string | null;
  canSweep: boolean;
  onClose: () => void;
  onTransition: (claimId: string, action: "fulfilled" | "dismissed" | "reopened") => void;
  onSweep?: (claimId: string) => void;
  // Closing an OPEN item takes an optional note, and the commitments page owns
  // that editor. A host without one (the run audit) points at the page that
  // does rather than growing a second copy of the flow.
  onStartNote?: (claimId: string, action: "fulfilled" | "dismissed") => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const item = detail?.item ?? null;
  return (
    <div className="lifecycleModalOverlay" onClick={onClose}>
      <div className="lifecycleModal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <header className="lifecycleModalHead">
          <div className="lifecycleModalTitle">
            {item ? (item.kind === "commitment" ? <CircleDot size={16} /> : <HelpCircle size={16} />) : null}
            <span>{item?.text ?? (loading ? "Loading…" : "Item")}</span>
          </div>
          <button type="button" className="lifecycleModalClose" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </header>

        {!detail ? (
          <div className="lifecycleModalBody">
            {loading ? (
              <div className="lifecycleModalSection">
                <div className="lifecycleSkel lifecycleSkelText" style={{ marginBottom: 10 }} />
                <div className="lifecycleSkel lifecycleSkelMeta" style={{ marginBottom: 10 }} />
                <div className="lifecycleSkel lifecycleSkelText short" />
              </div>
            ) : (
              <p className="brainHint">Not found.</p>
            )}
          </div>
        ) : (
          <div className="lifecycleModalBody">
            <div className="lifecycleMeta">
              <span className={`chip lifecycleStatus-${item!.status}`}>
                {item!.status === "fulfilled" && item!.kind === "question" ? "answered" : item!.status}
              </span>
              {item!.overdue && <span className="chip lifecycleOverdue">overdue</span>}
              {item!.stale && <span className="chip">stale</span>}
              {item!.chatDisplayName && <span>{item!.chatDisplayName}</span>}
              {item!.holderLabel && <span>holder: {item!.holderLabel}</span>}
              <span>opened {formatDay(item!.openedAtMs)}</span>
              {item!.dueMs != null && <span>due {formatDay(item!.dueMs)}</span>}
            </div>

            <section className="lifecycleModalSection">
              <h4>Why this exists</h4>
              <p className="lifecycleModalNote">The messages this {item!.kind} was extracted from:</p>
              {detail.origin.length === 0 ? (
                <p className="brainHint">No origin messages resolved.</p>
              ) : (
                <ul className="lifecycleEvidenceList">
                  {detail.origin.map((cite) => (
                    <li key={cite.sourceMessageKey}>
                      <span className="lifecycleEvidenceWhen">{formatDateTime(cite.timestampMs)}</span>
                      {cite.chatId != null && cite.messageId != null ? (
                        <Link className="lifecycleCite" to={`/chats/${cite.chatId}?at=${cite.messageId}`}>
                          {cite.senderLabel ? `${cite.senderLabel}: ` : ""}
                          {cite.snippet ?? "view message"}
                        </Link>
                      ) : (
                        <span className="lifecycleCite">
                          {cite.senderLabel ? `${cite.senderLabel}: ` : ""}
                          {cite.snippet ?? cite.sourceMessageKey}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="lifecycleModalSection">
              <h4>Later evidence ({detail.candidates.length})</h4>
              <p className="lifecycleModalNote">Signals gathered deterministically that a closure sweep would judge:</p>
              {detail.candidates.length === 0 ? (
                <p className="brainHint">No later evidence yet — nothing has referenced this since it was made.</p>
              ) : (
                <ul className="lifecycleEvidenceList">
                  {detail.candidates.map((candidate) => (
                    <li key={`${candidate.kind}:${candidate.sourceMessageKey}`}>
                      <span className="lifecycleEvidenceKind">
                        {candidate.kind === "reaction" ? <Smile size={12} /> : <MessageSquare size={12} />} {CANDIDATE_LABEL[candidate.kind]}
                      </span>
                      <span className="lifecycleEvidenceWhen">{formatDateTime(candidate.timestampMs)}</span>
                      {candidate.chatId != null && candidate.messageId != null ? (
                        <Link className="lifecycleCite" to={`/chats/${candidate.chatId}?at=${candidate.messageId}`}>
                          {candidate.senderLabel ? `${candidate.senderLabel}: ` : ""}
                          {candidate.text}
                        </Link>
                      ) : (
                        <span className="lifecycleCite">
                          {candidate.senderLabel ? `${candidate.senderLabel}: ` : ""}
                          {candidate.text}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {(detail.events.length > 0 || item!.resolution) && (
              <section className="lifecycleModalSection">
                <h4>History</h4>
                <ul className="lifecycleHistory">
                  <li>
                    <span className="lifecycleEvidenceWhen">{formatDay(item!.openedAtMs)}</span> opened
                  </li>
                  {detail.events.map((event) => (
                    <li key={event.id}>
                      <span className="lifecycleEvidenceWhen">{formatDay(event.evidenceAtMs ?? event.createdAtMs)}</span>{" "}
                      {event.toStatus === "still_open" ? "reviewed — still open" : event.toStatus} by {event.source === "user" ? "you" : event.model ?? "model"}
                      {event.orphanedAtMs != null ? " (orphaned)" : ""}
                      {event.note ? ` — ${event.note}` : ""}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}

        {item && (
          <footer className="lifecycleModalFooter">
            {item.status === "open" ? (
              onStartNote ? (
                <>
                  <button type="button" className="evalButton" disabled={busyClaim === item.claimId} onClick={() => onStartNote(item.claimId, "fulfilled")}>
                    <CheckCircle2 size={13} /> {item.kind === "question" ? "Answered" : "Done"}
                  </button>
                  <button type="button" className="evalButton" disabled={busyClaim === item.claimId} onClick={() => onStartNote(item.claimId, "dismissed")} title="Not relevant, withdrawn, or a bad extraction — hide it (reversible via Reopen).">
                    <XCircle size={13} /> Dismiss
                  </button>
                  {onSweep && (
                    <button
                      type="button"
                      className="evalButton"
                      disabled={busyClaim === item.claimId || !canSweep}
                      title={canSweep ? "Judge just this item against its evidence (one model call)." : "Provider not ready for a model sweep."}
                      onClick={() => onSweep(item.claimId)}
                    >
                      <Play size={13} /> Sweep this item
                    </button>
                  )}
                </>
              ) : (
                <Link className="evalButton" to="/brain/commitments" title="Closing an item takes an optional note — that lives on the commitments surface.">
                  Manage on Commitments
                </Link>
              )
            ) : (
              <button type="button" className="evalButton" disabled={busyClaim === item.claimId} onClick={() => onTransition(item.claimId, "reopened")}>
                <RotateCcw size={13} /> {item.status === "dismissed" ? "Restore" : "Reopen"}
              </button>
            )}
            <button type="button" className="evalButton" onClick={onClose}>
              Close
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
