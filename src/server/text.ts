// Unicode-safe text helpers for anything that reaches a model prompt.
//
// The hazard these exist to remove: `String.prototype.slice` counts UTF-16 code
// units, so bounding archive text by character count can cut an astral character
// in half and leave an unpaired surrogate. `JSON.stringify` then emits a bare
// `\ud83d`, and a provider that validates UTF-8 strictly rejects the whole
// request — observed as a deterministic `400 {"detail":"Bad Request"}` from the
// codex backend, which halted fallback sweeps. The claude-cli path hid the same
// defect instead of reporting it: stdin encoding silently substitutes U+FFFD.

// One segmenter for the process; construction is the expensive part, and the
// instance is stateless across segment() calls.
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// How far past the budget to segment. A grapheme cluster that straddles the cut
// starts at or before the budget, so we only need enough tail to contain the
// longest realistic cluster (flag sequences and multi-person ZWJ emoji with skin
// tones run into the teens of code units). Segmenting a bounded head instead of
// the whole string keeps cost independent of input length — these bounds are
// ~80-320 characters against inputs that can be thousands.
const CLUSTER_MARGIN = 32;

/**
 * Truncate to at most `limit` UTF-16 code units INCLUDING `marker`, cutting only
 * on grapheme-cluster boundaries.
 *
 * A character bound is treated as a maximum, so a cut that would split a cluster
 * yields a shorter result rather than a broken one: emoji stay whole (including
 * ZWJ sequences and skin-tone modifiers), and an Indic base consonant never
 * loses its combining matra — which matters here, where the archive is largely
 * Bengali/Hindi/Hinglish.
 *
 * Text at or under the bound is returned verbatim, with no marker appended.
 */
export function truncateOnGraphemeBoundary(value: string, limit: number, marker = ""): string {
  if (limit <= 0) {
    return "";
  }
  if (value.length <= limit) {
    return value;
  }
  const budget = limit - marker.length;
  if (budget <= 0) {
    // Degenerate bound (marker alone does not fit); keep the contract that the
    // result never exceeds the limit rather than emitting an oversized marker.
    return marker.slice(0, limit);
  }
  const head = value.slice(0, budget + CLUSTER_MARGIN);
  let out = "";
  for (const { segment } of GRAPHEME_SEGMENTER.segment(head)) {
    if (out.length + segment.length > budget) {
      break;
    }
    out += segment;
  }
  // `out` is built only from whole clusters taken from the head, so it can never
  // end mid-pair. If slicing `head` split a pair, that fragment sits at index
  // >= budget and is discarded by the loop bound above.
  return out + marker;
}

/**
 * Replace every unpaired UTF-16 surrogate with U+FFFD, matching the semantics of
 * the ES2024 `String.prototype.toWellFormed()`.
 *
 * Implemented directly rather than delegating to the native method: this
 * project's TypeScript `lib` is ES2022, so the native method is not in the type
 * surface, and a runtime-detected dual path would leave one branch untested on
 * the machines that matter. The inputs here are prompt-sized (kilobytes), so a
 * single pass costs nothing measurable.
 */
export function toWellFormedText(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[index] + value[index + 1];
        index += 1;
      } else {
        out += "�"; // high surrogate with no low partner
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += "�"; // low surrogate with no high partner
      continue;
    }
    out += value[index];
  }
  return out;
}

/** True when the string contains at least one unpaired surrogate. */
export function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
