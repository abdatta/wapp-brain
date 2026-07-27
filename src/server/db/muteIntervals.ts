import type { BrainMuteOrigin } from "../../shared/types";

// The mute-interval algebra, shared verbatim by the SQLite and in-memory
// repositories. Both stores keep the same canonical form and answer
// "was this muted?" through these functions, so the two implementations cannot
// drift apart on the semantics — only on storage.
//
// A range is half-open `[startMs, endMs)`; `endMs === null` means still muted.
// Canonical means sorted, non-overlapping, and merged where adjacent, with at
// most one open range (always last).
//
// A zero-length range (start === end) is a TOMBSTONE. It matches no timestamp
// under half-open semantics, so it is inert in every evaluation for free; its
// only job is to record that a chat's mute state was deliberately chosen, which
// is what stops the channel default from resurrecting after an explicit unmute.
export interface MuteIntervalValue {
  startMs: number;
  endMs: number | null;
  origin: BrainMuteOrigin;
}

// Muting `[fromMs, ∞)`: every range that reaches fromMs — overlapping OR merely
// adjacent — folds into a single open range; ranges closing strictly before it
// are left alone.
export function mergeMuteIntervals(existing: MuteIntervalValue[], fromMs: number, origin: BrainMuteOrigin): MuteIntervalValue[] {
  const untouched = existing.filter((interval) => interval.endMs != null && interval.endMs < fromMs);
  const absorbed = existing.filter((interval) => interval.endMs == null || interval.endMs >= fromMs);
  const startMs = absorbed.reduce((min, interval) => Math.min(min, interval.startMs), fromMs);
  return [...untouched, { startMs, endMs: null, origin }].sort((a, b) => a.startMs - b.startMs);
}

// Unmuting from `fromMs`: ranges wholly before it survive, ranges wholly at or
// after it are erased, and a range straddling it is truncated to close there.
// Erasure is why callers must write a tombstone when the result is empty.
export function truncateMuteIntervals(existing: MuteIntervalValue[], fromMs: number): MuteIntervalValue[] {
  const kept: MuteIntervalValue[] = [];
  for (const interval of existing) {
    if (interval.endMs != null && interval.endMs <= fromMs) {
      kept.push(interval);
      continue;
    }
    if (interval.startMs >= fromMs) continue;
    kept.push({ startMs: interval.startMs, endMs: fromMs, origin: interval.origin });
  }
  return kept.sort((a, b) => a.startMs - b.startMs);
}

// Drops tombstones: they carry no mute semantics, only the record of a choice.
export function activeMuteIntervals(intervals: MuteIntervalValue[]): MuteIntervalValue[] {
  return intervals.filter((interval) => interval.endMs == null || interval.endMs > interval.startMs);
}

export function isMutedAt(intervals: MuteIntervalValue[], atMs: number): boolean {
  return activeMuteIntervals(intervals).some((interval) => atMs >= interval.startMs && (interval.endMs == null || atMs < interval.endMs));
}

// ANY overlap hides: a boundary-straddling episode is treated as muted rather
// than re-sliced, which is what keeps muting instantly reversible. The episode
// span is inclusive on both ends, so `[s,e]` overlaps `[a,b)` iff s < b && e >= a.
export function spanOverlapsMute(intervals: MuteIntervalValue[], startAtMs: number, endAtMs: number): boolean {
  return activeMuteIntervals(intervals).some(
    (interval) => endAtMs >= interval.startMs && (interval.endMs == null || startAtMs < interval.endMs)
  );
}

// A chat muted open-ended from the beginning of time — the shape every channel
// default and "entire history" mute takes, and the case that collapses to a
// pure chat-identity check with no timestamp arithmetic.
export function isFullyMuted(intervals: MuteIntervalValue[]): boolean {
  return activeMuteIntervals(intervals).some((interval) => interval.endMs == null && interval.startMs <= 0);
}
