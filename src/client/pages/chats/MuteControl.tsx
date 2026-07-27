import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatListItem, ChatMuteState } from "../../../shared/types";
import { getChatMuteState, muteChat, unmuteChat } from "../../api";
import { useToast } from "../../state/ToastContext";

// Mute/unmute from the thread the user is already reading. Muting stops BRAIN
// processing only — the chat keeps archiving every message and media blob and
// reads identically here and in search — so the control is deliberately quiet
// and must never be mistaken for WhatsApp's notification mute.
//
// The trigger carries the state instead of a separate badge: icon-only while
// unmuted (a header the user reads constantly should stay calm), and an amber
// "Muted" pill once it is, so the state is legible without hovering.

const dayInputValue = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const formatDay = (ms: number | null): string =>
  ms == null || ms <= 0
    ? "its entire history"
    : new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export function MuteControl({ chat, onChanged }: { chat: ChatListItem; onChanged?: (state: ChatMuteState) => void }) {
  const { setError } = useToast();
  const [state, setState] = useState<ChatMuteState | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [customDay, setCustomDay] = useState<string>(dayInputValue(Date.now()));
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    setOpen(false);
    getChatMuteState(chat.id)
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => {
        // A mute-state read failing must not break the thread; the control
        // simply stays unavailable rather than rendering a wrong state.
        if (!cancelled) setState(null);
      });
    return () => {
      cancelled = true;
    };
  }, [chat.id]);

  // A popover that only closes via its own trigger is a trap once the user has
  // moved on: dismiss on outside click and on Escape, like every other menu.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const apply = useCallback(
    async (action: "mute" | "unmute", fromMs?: number | "epoch") => {
      setBusy(true);
      try {
        const next = action === "mute" ? await muteChat(chat.id, fromMs) : await unmuteChat(chat.id, fromMs);
        setState(next);
        setOpen(false);
        onChanged?.(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : `Could not ${action} this chat.`);
      } finally {
        setBusy(false);
      }
    },
    [chat.id, onChanged, setError]
  );

  if (!state) {
    return null;
  }

  const muted = state.muted;
  const sinceLabel = formatDay(state.mutedSinceMs);
  const customMs = Date.parse(`${customDay}T00:00:00Z`);
  const customValid = !Number.isNaN(customMs);

  return (
    <div className="muteControl" ref={rootRef}>
      <button
        type="button"
        className={`muteTrigger${muted ? " isMuted" : ""}`}
        onClick={() => setOpen((current) => !current)}
        disabled={busy}
        aria-expanded={open}
        aria-label={muted ? "Muted from the brain — change" : "Mute this chat from the brain"}
        title={
          muted
            ? `Muted from the brain since ${sinceLabel}. Messages and media are still archived.`
            : "Mute from the brain. Messages and media keep archiving either way."
        }
      >
        {busy ? <Loader2 className="spin" size={15} /> : muted ? <EyeOff size={15} /> : <Eye size={15} />}
        {muted && <span>Muted</span>}
      </button>

      {open && (
        <div className="mutePopover" role="dialog" aria-label="Brain muting">
          <div className="mutePopoverHead">
            <h4>{muted ? "Muted from the brain" : "Mute from the brain"}</h4>
            <p>
              {muted ? (
                <>
                  Since <strong>{sinceLabel}</strong>
                  {state.origin === "channel-default" ? " — channels are muted by default" : ""}. Hidden artifacts are kept,
                  never deleted.
                </>
              ) : (
                <>The brain stops reading this chat. Messages and media keep archiving exactly as now.</>
              )}
            </p>
          </div>

          <div className="muteOptions">
            {muted ? (
              <button type="button" className="muteOption" onClick={() => void apply("unmute", "epoch")} disabled={busy}>
                <span className="muteOptionLabel">Unmute everything</span>
                <span className="muteOptionHint">Hidden artifacts reappear; processing resumes</span>
              </button>
            ) : (
              <>
                <button type="button" className="muteOption" onClick={() => void apply("mute")} disabled={busy}>
                  <span className="muteOptionLabel">Mute from now</span>
                  <span className="muteOptionHint">Existing brain output stays visible</span>
                </button>
                <button type="button" className="muteOption" onClick={() => void apply("mute", "epoch")} disabled={busy}>
                  <span className="muteOptionLabel">Mute entire history</span>
                  <span className="muteOptionHint">Hides everything this chat has produced</span>
                </button>
              </>
            )}
          </div>

          <div className="muteCustom">
            <label htmlFor={`mute-date-${chat.id}`}>{muted ? "Unmute from" : "Mute from"}</label>
            <div className="muteCustomRow">
              <input
                id={`mute-date-${chat.id}`}
                type="date"
                value={customDay}
                onChange={(event) => setCustomDay(event.target.value)}
              />
              <button
                type="button"
                onClick={() => void apply(muted ? "unmute" : "mute", customMs)}
                disabled={busy || !customValid}
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
