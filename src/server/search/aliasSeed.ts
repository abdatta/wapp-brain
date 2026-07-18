// Static seed for brain_term_aliases: conservative romanized-Hindi (and
// chat-shorthand) spelling variants of the SAME word. Deliberately excludes
// near-words with distinct meanings ("bhai" vs "bhi", "baat" vs English
// "bat") — a false alias pollutes strict results invisibly. The deep
// retrieval path may later persist model-learned rows (source='model');
// this list is the source='seed' floor that makes "nhi" find "nahi" today.
export const TERM_ALIAS_SEEDS: Array<{ term: string; variants: string[] }> = [
  { term: "nahi", variants: ["nhi", "nai", "nahin"] },
  { term: "hai", variants: ["h"] },
  { term: "haan", variants: ["han", "haa"] },
  { term: "kya", variants: ["kia", "kyaa"] },
  { term: "kyun", variants: ["kyu", "kyon"] },
  { term: "kar", variants: ["kr"] },
  { term: "karna", variants: ["krna"] },
  { term: "raha", variants: ["rha"] },
  { term: "rahi", variants: ["rhi"] },
  { term: "rahe", variants: ["rhe"] },
  { term: "gaya", variants: ["gya"] },
  { term: "gayi", variants: ["gyi"] },
  { term: "mujhe", variants: ["muje", "mje"] },
  { term: "tujhe", variants: ["tuje"] },
  { term: "yaar", variants: ["yar"] },
  { term: "accha", variants: ["acha", "achha", "acchha"] },
  { term: "theek", variants: ["thik"] },
  { term: "kuch", variants: ["kuchh", "kch"] },
  { term: "aaj", variants: ["aj"] },
  { term: "matlab", variants: ["mtlb"] },
  { term: "ghar", variants: ["ghr"] },
  { term: "samajh", variants: ["samjh"] },
  { term: "please", variants: ["pls", "plz"] },
  { term: "thanks", variants: ["thx", "thnx"] },
  { term: "okay", variants: ["ok"] },
  { term: "message", variants: ["msg"] },
  { term: "tomorrow", variants: ["tmrw", "tmr"] }
];

export function termAliasSeedRows(): Array<{ term: string; variant: string }> {
  const rows: Array<{ term: string; variant: string }> = [];
  for (const seed of TERM_ALIAS_SEEDS) {
    for (const variant of seed.variants) {
      rows.push({ term: seed.term, variant });
    }
  }
  return rows;
}
