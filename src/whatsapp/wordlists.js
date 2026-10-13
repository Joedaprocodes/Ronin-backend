/**
 * Tiered bad-language wordlists for the guards engine. No external API, no
 * network calls: detecting offensive language is a pure keyed lookup over the
 * normalized message text.
 *
 * Three tiers, least to most aggressive, mapped from the per-group
 * `sensitivity` setting:
 *
 *   low     -> SEVERE_WORDS  (strong slurs only)
 *   medium  -> SEVERE + MODERATE (default)
 *   strict  -> SEVERE + MODERATE + MILD (any insult)
 *
 * The lists use *normalized* forms (lowercase plain ASCII) — `normalizeText`
 * turns leetspeak ("f u c k", "sh1t", "4$$", accents) into those forms before
 * matching, so each entry here is whatever the normalized token looks like.
 */

/** Strongest slurs/invective. `low` already blocks these. */
export const SEVERE_WORDS = [
  "nigger",
  "nigga",
  "niggas",
  "cunt",
  "faggot",
  "faggots",
  "fag",
  "retard",
  "retards",
  "retarded",
  "whore",
  "whores",
  "slut",
  "sluts",
  "tranny",
  "dyke",
  "spic",
  "chink",
  "kike",
  "gook",
  "wetback",
  "beaner",
];

/** Common profanity. Added on top of severe for `medium`. */
export const MODERATE_WORDS = [
  "fuck",
  "fucking",
  "fucked",
  "fucker",
  "fuckers",
  "motherfucker",
  "motherfuckers",
  "motherfucking",
  "shit",
  "shits",
  "shitty",
  "bullshit",
  "horseshit",
  "bitch",
  "bitches",
  "bitchy",
  "sonofabitch",
  "ass",
  "asshole",
  "assholes",
  "asshat",
  "dumbass",
  "bastard",
  "bastards",
  "dick",
  "dicks",
  "dickhead",
  "cock",
  "cocksucker",
  "pussy",
  "pussies",
  "twat",
  "wanker",
  "bollocks",
  "arsehole",
  "damn",
  "piss",
  "pissed",
  "crap",
  "douche",
  "douchebag",
  "jackass",
];

/** Milder insults. Only `strict` blocks these. */
export const MILD_WORDS = [
  "idiot",
  "idiots",
  "stupid",
  "moron",
  "morons",
  "imbecile",
  "imbeciles",
  "dumb",
  "dumber",
  "dummy",
  "jerk",
  "jerks",
  "loser",
  "losers",
  "brat",
  "brats",
  "fool",
  "fools",
  "foolish",
  "ignorant",
  "pathetic",
  "worthless",
  "useless",
  "weirdo",
  "scum",
];

/**
 * Sensitivity -> words. The exact token set each tier keys against.
 */
export const SENSITIVITY_TIERS = {
  low: [...SEVERE_WORDS],
  medium: [...SEVERE_WORDS, ...MODERATE_WORDS],
  strict: [...SEVERE_WORDS, ...MODERATE_WORDS, ...MILD_WORDS],
};

/** Common leetspeak digit/symbol substitutions applied after lowercasing. */
const LEET = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "6": "g",
  "7": "t",
  "8": "b",
  "9": "g",
  "2": "z",
  "@": "a",
  "$": "s",
  "!": "i",
};

/** Joins runs of single-character words: "f u c k" -> "fuck". */
export function collapseSpacedLetters(text) {
  const tokens = String(text).split(/\s+/).filter(Boolean);
  const out = [];
  let run = "";
  for (let i = 0; i < tokens.length; i++) {
    const single = tokens[i].length === 1;
    const singleNext = i + 1 < tokens.length && tokens[i + 1].length === 1;
    if (single && singleNext) {
      run += tokens[i];
    } else if (single && run) {
      out.push(run + tokens[i]);
      run = "";
    } else {
      if (run) {
        out.push(run);
        run = "";
      }
      out.push(tokens[i]);
    }
  }
  if (run) out.push(run);
  return out.join(" ");
}

/**
 * Normalizes message text for wordlist matching: lowercase, NFKD-decomposed
 * (accents stripped), punctuation/emoji -> spaces, spaced-out letters joined,
 * common leetspeak substitutions applied.
 */
export function normalizeText(text) {
  let s = String(text ?? "").toLowerCase().normalize("NFKD");
  s = s.replace(/[\u200b-\u200d\ufeff\u00ad]/g, ""); // zero-width + soft hyphen
  s = s.replace(/[\u0300-\u036f]/g, ""); // combining marks
  s = s.replace(/[^a-z0-9]/g, " "); // punctuation/emoji -> space
  s = s.replace(/\s+/g, " ").trim();
  s = collapseSpacedLetters(s);
  // Leetspeak substitutions are per token, and deliberately skip all-digit
  // tokens so ordinary numbers ("call 123") aren't mangled into letters.
  s = s
    .split(" ")
    .map((token) => (/^[0-9]+$/.test(token) ? token : [...token].map((c) => LEET[c] ?? c).join("")))
    .join(" ");
  return s.trim();
}

/**
 * True word-value suffixes that make a longer token count as an inflection of
 * a shorter banned word ("fucking" ends in "fuck" + "ing"). Without this, a
 * plain prefix check would misfire on harmless words like "cockroach"
 * ("cock" + "roach") or "assassin".
 */
const INFLECTIONS = new Set([
  "s",
  "es",
  "ed",
  "ing",
  "er",
  "ers",
  "ier",
  "iest",
  "y",
  "ly",
  "ily",
  "a",
  "o",
]);

/**
 * The first banned word found in `text`, or null. A token matches when it
 * equals a banned word exactly, or starts with one (length >= 4) followed by a
 * real inflection suffix.
 */
export function matchesToxicity(text, words) {
  const tokens = normalizeText(text).split(/\s+/).filter(Boolean);
  for (const word of words ?? []) {
    if (!word || word.length < 3) continue;
    for (const token of tokens) {
      if (token === word) return word;
      if (
        word.length >= 4 &&
        token.length > word.length &&
        token.startsWith(word) &&
        INFLECTIONS.has(token.slice(word.length))
      ) {
        return word;
      }
    }
  }
  return null;
}