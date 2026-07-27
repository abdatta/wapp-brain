import { Check, EyeOff, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { BrainMuteProgress } from "../../shared/types";
import { MUTE_CHANGED_EVENT, getMuteProgress } from "../api";

// Muting is durable the instant the request returns, but the vault reconcile
// runs behind it. Without a signal that reads as "working", a user who just
// muted a large chat sees nothing happen and assumes the app is stuck — which
// is exactly what it looked like before this existed.
//
// Lives in the shell so it is visible from every page (you can mute and
// navigate away), stays quiet when idle, and holds a brief "done" beat so the
// work does not simply vanish between glances.

const IDLE_POLL_MS = 8000;
const ACTIVE_POLL_MS = 700;
const DONE_VISIBLE_MS = 3500;

export function MuteProgressPill() {
  const [progress, setProgress] = useState<BrainMuteProgress | null>(null);
  // Remembered so the completion beat can name what actually finished — saying
  // "Mute applied" after an unmute is a small lie the user will notice.
  const [justFinished, setJustFinished] = useState<"mute" | "unmute" | null>(null);
  const lastAction = useRef<"mute" | "unmute">("mute");
  const finishedTimer = useRef<number | null>(null);
  const lastFinishedAt = useRef<number | null>(null);
  const primed = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const next = await getMuteProgress();
        if (cancelled) return;
        setProgress(next);
        // Show the completion beat once per drained queue, not on every poll —
        // and not for a queue that had already drained before this mounted.
        // `primed` is separate from the timestamp because the first poll of a
        // session legitimately sees null, and folding those two cases together
        // swallowed the very first completion.
        if (next.active) {
          lastAction.current = next.active.action;
        }
        if (!primed.current) {
          primed.current = true;
          lastFinishedAt.current = next.finishedAtMs;
        } else if (next.finishedAtMs && next.finishedAtMs !== lastFinishedAt.current) {
          lastFinishedAt.current = next.finishedAtMs;
          setJustFinished(lastAction.current);
          if (finishedTimer.current) window.clearTimeout(finishedTimer.current);
          finishedTimer.current = window.setTimeout(() => setJustFinished(null), DONE_VISIBLE_MS);
        }
        // Poll fast only while there is something to watch.
        timer = window.setTimeout(() => void tick(), next.active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
      } catch {
        // A stale or restarting server must not spam errors for a status pill.
        if (!cancelled) timer = window.setTimeout(() => void tick(), IDLE_POLL_MS);
      }
    };

    void tick();

    // Poll on its own cadence, but react immediately to an action: a reconcile
    // that finishes in ~100ms would otherwise slip entirely between polls and
    // the user would see no acknowledgement at all.
    const onMuteChanged = () => {
      if (timer) window.clearTimeout(timer);
      void tick();
    };
    window.addEventListener(MUTE_CHANGED_EVENT, onMuteChanged);

    return () => {
      cancelled = true;
      window.removeEventListener(MUTE_CHANGED_EVENT, onMuteChanged);
      if (timer) window.clearTimeout(timer);
      if (finishedTimer.current) window.clearTimeout(finishedTimer.current);
    };
  }, []);

  const active = progress?.active ?? null;
  if (!active && !justFinished) {
    return null;
  }

  if (!active) {
    return (
      <span className="mutePill isDone" role="status">
        <Check size={14} />
        {justFinished === "unmute" ? "Unmute applied" : "Mute applied"}
      </span>
    );
  }

  const verb = active.action === "mute" ? "Muting" : "Unmuting";
  // Only worth a counter when there is genuinely a queue behind this one.
  const showCount = progress!.total > 1;
  const position = Math.min(progress!.done + 1, progress!.total);

  return (
    <Link
      className="mutePill"
      to="/brain/muted"
      role="status"
      aria-live="polite"
      title={`${verb} ${active.label}. The chat is already muted — this is the vault catching up in the background.`}
    >
      <Loader2 className="spin" size={14} />
      <EyeOff size={13} />
      <span className="mutePillText">
        {verb} {active.label}
      </span>
      {showCount && <span className="mutePillCount">{position}/{progress!.total}</span>}
    </Link>
  );
}
