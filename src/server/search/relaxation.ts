// Pure query planning for archive search (retrieval-hardening): tokenization,
// alias expansion, and the zero-hit relaxation ladder. No database access —
// both repository implementations (the FTS5 SQL path and the in-memory scan)
// consume the same plans, so query semantics cannot drift between them. This
// is the shared query layer the future brain fast path inherits.

export type SearchMatchTier = "exact" | "relaxed" | "partial";

export const ALIAS_VARIANT_CAP = 3;

export interface QueryToken {
  // Cleaned token text as typed (inner quotes stripped); used for display.
  text: string;
  // Tokenizer-normalized form (lowercase, diacritics folded) — what the
  // unicode61 index and the vocab table actually contain.
  norm: string;
  // Explicitly "quoted" by the user: never starred and never dropped before
  // the final ranked-OR tier.
  quoted: boolean;
  // Alias co-variants (normalized), attached by attachAliasVariants.
  variants: string[];
}

export interface PlanAlternative {
  // Normalized term text (safe to embed as an FTS phrase; unicode61 folds
  // user case anyway, so matching is unchanged).
  text: string;
  prefix: boolean;
}

export interface PlanGroup {
  // First alternative is the token itself; the rest are alias variants.
  alternatives: PlanAlternative[];
  sourceText: string;
  quoted: boolean;
}

export interface TierPlan {
  tier: 0 | 1 | 2 | 3 | 4;
  matchTier: SearchMatchTier;
  // FTS5 MATCH expression for this tier.
  match: string;
  groups: PlanGroup[];
  // False only for the ranked-OR tier: any group may satisfy the plan.
  requireAll: boolean;
  droppedTerms: string[];
  totalTerms: number;
  requiredTerms: number;
}

// Mirrors `unicode61 remove_diacritics 2` closely enough for planning and
// display-grade matching: case-fold and strip combining marks.
export function normalizeTerm(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function wordChars(text: string): string {
  return text.replace(/[^\p{L}\p{N}]+/gu, "");
}

// User text → tokens. Same quoting semantics as the original FTS query
// builder: whitespace-delimited, "double quotes" group a phrase and mark it
// exempt from starring/dropping.
export function tokenizeSearchQuery(raw: string): QueryToken[] {
  const pieces = raw.match(/"[^"]*"|\S+/g) ?? [];
  const tokens: QueryToken[] = [];
  for (const piece of pieces) {
    let phrase = piece;
    let quoted = false;
    if (phrase.length >= 2 && phrase.startsWith('"') && phrase.endsWith('"')) {
      quoted = true;
      phrase = phrase.slice(1, -1);
    }
    const cleaned = phrase.replace(/"/g, " ").trim();
    if (!cleaned) {
      continue;
    }
    tokens.push({ text: cleaned, norm: normalizeTerm(cleaned), quoted, variants: [] });
  }
  return tokens;
}

// Attach alias co-variants from a lookup (bidirectional groups built by the
// caller). Quoted phrases are taken literally and never expanded.
export function attachAliasVariants(tokens: QueryToken[], lookup: (norm: string) => string[]): QueryToken[] {
  return tokens.map((token) => {
    if (token.quoted) {
      return token;
    }
    const variants: string[] = [];
    for (const raw of lookup(token.norm) ?? []) {
      const variant = normalizeTerm(raw).replace(/"/g, " ").trim();
      if (variant && variant !== token.norm && !variants.includes(variant)) {
        variants.push(variant);
      }
      if (variants.length >= ALIAS_VARIANT_CAP) {
        break;
      }
    }
    return { ...token, variants };
  });
}

// Star policies. Tier 0 keeps today's behavior (final unquoted token only);
// tiers 1+ star every unquoted token with enough word characters that the
// prefix stays selective. Each alternative qualifies on its own length so a
// short alias ("h") is never turned into a match-everything prefix.
function starEligibleT0(token: QueryToken, index: number, count: number): boolean {
  return !token.quoted && index === count - 1 && /[\p{L}\p{N}]{2,}$/u.test(token.text);
}

const T1_MIN_PREFIX_CHARS = 3;

function buildGroup(token: QueryToken, starred: boolean, minChars: number): PlanGroup {
  const alternatives: PlanAlternative[] = [];
  const texts = [token.norm, ...token.variants];
  for (const text of texts) {
    alternatives.push({ text, prefix: starred && wordChars(text).length >= minChars });
  }
  return { alternatives, sourceText: token.text, quoted: token.quoted };
}

function renderGroup(group: PlanGroup): string {
  const parts = group.alternatives.map((alt) => `"${alt.text.replace(/"/g, " ")}"${alt.prefix ? "*" : ""}`);
  return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
}

function renderMatch(groups: PlanGroup[], requireAll: boolean): string {
  return groups.map(renderGroup).join(requireAll ? " AND " : " OR ");
}

function makePlan(
  tier: TierPlan["tier"],
  matchTier: SearchMatchTier,
  groups: PlanGroup[],
  requireAll: boolean,
  droppedTerms: string[],
  totalTerms: number,
  requiredTerms: number
): TierPlan {
  return { tier, matchTier, match: renderMatch(groups, requireAll), groups, requireAll, droppedTerms, totalTerms, requiredTerms };
}

// Tiers 0 (strict, today's semantics) and 1 (prefix-star everything eligible).
// Returned in escalation order; tier 1 is omitted when starring changes
// nothing (e.g. a single short token).
export function buildBasePlans(tokens: QueryToken[]): TierPlan[] {
  const total = tokens.length;
  const t0 = makePlan(
    0,
    "exact",
    tokens.map((token, index) => buildGroup(token, starEligibleT0(token, index, total), 2)),
    true,
    [],
    total,
    total
  );
  const t1 = makePlan(
    1,
    "relaxed",
    tokens.map((token) => buildGroup(token, !token.quoted, T1_MIN_PREFIX_CHARS)),
    true,
    [],
    total,
    total
  );
  return t1.match === t0.match ? [t0] : [t0, t1];
}

// Document-frequency-guided tiers, built only after the base tiers found
// nothing. `dfByNorm` is the caller-measured EFFECTIVE frequency per token
// (its starred form plus alias variants), so df = 0 means "cannot match
// anything at tier-1 looseness".
export function buildDroppedPlans(
  tokens: QueryToken[],
  dfByNorm: Map<string, number>,
  alreadyPlanned: Set<string>
): TierPlan[] {
  const total = tokens.length;
  if (total < 2) {
    return [];
  }
  const plans: TierPlan[] = [];
  const seen = new Set(alreadyPlanned);
  const push = (plan: TierPlan) => {
    if (!seen.has(plan.match)) {
      seen.add(plan.match);
      plans.push(plan);
    }
  };
  const df = (token: QueryToken): number => (token.quoted ? Number.POSITIVE_INFINITY : dfByNorm.get(token.norm) ?? Number.POSITIVE_INFINITY);
  const starredGroups = (subset: QueryToken[]): PlanGroup[] => subset.map((token) => buildGroup(token, !token.quoted, T1_MIN_PREFIX_CHARS));
  const droppedFrom = (subset: QueryToken[]): string[] => tokens.filter((token) => !subset.includes(token)).map((token) => token.text);

  // Tier 2a: drop unmatchable tokens first (the typo case) — they cannot
  // match anything, so removing them preserves AND precision on the rest.
  let current = tokens.filter((token) => token.quoted || df(token) > 0);
  if (current.length > 0 && current.length < total) {
    push(makePlan(2, "partial", starredGroups(current), true, droppedFrom(current), total, current.length));
  }
  if (current.length === 0) {
    current = [...tokens];
  }
  // Tier 2b: shed the least-discriminative (highest-df) unquoted tokens one
  // at a time, floor of two surviving tokens.
  let working = [...current];
  while (working.length > 2) {
    let dropIndex = -1;
    let dropDf = -1;
    working.forEach((token, index) => {
      if (token.quoted) {
        return;
      }
      const frequency = dfByNorm.get(token.norm) ?? 0;
      if (frequency > dropDf) {
        dropDf = frequency;
        dropIndex = index;
      }
    });
    if (dropIndex < 0) {
      break;
    }
    working = working.filter((_, index) => index !== dropIndex);
    push(makePlan(2, "partial", starredGroups(working), true, droppedFrom(working), total, working.length));
  }
  // Tier 3: require only the best ⌈n/2⌉ tokens by rarity (IDF), quoted
  // phrases always kept, unmatchable tokens never kept (they would pin the
  // tier at zero).
  const keepCount = Math.ceil(total / 2);
  const keep: QueryToken[] = tokens.filter((token) => token.quoted);
  const candidates = tokens
    .filter((token) => !token.quoted && (dfByNorm.get(token.norm) ?? 0) > 0)
    .sort((a, b) => (dfByNorm.get(a.norm) ?? 0) - (dfByNorm.get(b.norm) ?? 0));
  for (const token of candidates) {
    if (keep.length >= keepCount) {
      break;
    }
    keep.push(token);
  }
  if (keep.length > 0 && keep.length < total) {
    const ordered = tokens.filter((token) => keep.includes(token));
    push(makePlan(3, "partial", starredGroups(ordered), true, droppedFrom(ordered), total, ordered.length));
  }
  // Tier 4: ranked OR of everything — the last-resort recall floor.
  push(makePlan(4, "partial", starredGroups(tokens), false, [], total, 1));
  return plans;
}

// The tier-1-loose alternatives for one token (itself + variants, starred per
// policy) — the shapes a df measurement should probe so "df = 0" genuinely
// means the token cannot match at any AND tier.
export function dfProbesForToken(token: QueryToken): PlanAlternative[] {
  return buildGroup(token, !token.quoted, T1_MIN_PREFIX_CHARS).alternatives;
}

// --- Display-grade matching helpers (shared by rerank + the memory scan) ---

// Split a haystack into normalized words the way the tokenizer roughly would.
export function normalizedWords(text: string | null | undefined): string[] {
  if (!text) {
    return [];
  }
  return normalizeTerm(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function alternativeMatchesWord(alternative: PlanAlternative, word: string): boolean {
  return alternative.prefix ? word.startsWith(alternative.text) : word === alternative.text;
}

export function groupMatchesWords(group: PlanGroup, words: string[]): boolean {
  return group.alternatives.some((alternative) => words.some((word) => alternativeMatchesWord(alternative, word)));
}

export function planMatchesWords(plan: TierPlan, words: string[]): boolean {
  return plan.requireAll ? plan.groups.every((group) => groupMatchesWords(group, words)) : plan.groups.some((group) => groupMatchesWords(group, words));
}

// Prefix-lenient per-token test for display-grade signals (term coverage,
// sender-only detection, mention boosts): a token counts as present when it
// or any alias variant is a word or word-prefix of the haystack.
export function tokenLenientlyMatchesWords(token: QueryToken, words: string[]): boolean {
  const texts = [token.norm, ...token.variants];
  return texts.some((text) => text.length > 0 && words.some((word) => word === text || word.startsWith(text)));
}

export function countTermCoverage(tokens: QueryToken[], words: string[]): { matched: number; total: number } {
  let matched = 0;
  for (const token of tokens) {
    if (tokenLenientlyMatchesWords(token, words)) {
      matched += 1;
    }
  }
  return { matched, total: tokens.length };
}
