/**
 * English text normalization for scoring transcripts.
 *
 * Without this, word error rate mostly measures FORMATTING, not hearing.
 * Whisper writes "3.1%" where a reference says "three point one percent", and
 * "$49" where it says "forty nine dollars" — four apparent errors each, none
 * of them a mishearing. Early measurements here were roughly half formatting
 * noise, which hid the real errors.
 *
 * Whisper's own paper scores against a normalizer for exactly this reason.
 * This is a compact version of the same idea: collapse both sides to a
 * canonical form (digits, spelled-out symbols, no punctuation) so the score
 * reflects what was actually misheard.
 */

const UNITS: Record<string, number> = {
  zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = {
  hundred: 100, thousand: 1000, million: 1000000, billion: 1000000000,
};
/** Words whose numeric meaning is usually ordinal/qualitative, left alone. */
const ORDINALS: Record<string, string> = {
  first: "1st", second: "2nd", third: "3rd", fourth: "4th", fifth: "5th",
};

/** Convert a run of number words into a numeric string. */
function foldNumberRun(words: string[]): string | null {
  let total = 0;
  let current = 0;
  let sawAny = false;
  let decimals = "";
  let inDecimal = false;

  for (const w of words) {
    if (w === "point" || w === "dot") {
      if (!sawAny) return null;
      inDecimal = true;
      continue;
    }
    if (inDecimal) {
      const d = UNITS[w];
      if (d === undefined || d > 9) return null;
      decimals += String(d);
      continue;
    }
    if (w === "and") continue;
    if (UNITS[w] !== undefined) {
      current += UNITS[w];
      sawAny = true;
    } else if (TENS[w] !== undefined) {
      current += TENS[w];
      sawAny = true;
    } else if (SCALES[w] !== undefined) {
      if (!sawAny) return null;
      const scale = SCALES[w];
      if (scale === 100) {
        current *= 100;
      } else {
        total += (current || 1) * scale;
        current = 0;
      }
    } else {
      return null;
    }
  }
  if (!sawAny) return null;
  const whole = total + current;
  return decimals ? `${whole}.${decimals}` : String(whole);
}

const NUMBER_WORD =
  /^(zero|oh|o|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|point|dot|and)$/;

/**
 * Canonical form: lowercase, symbols spelled out, number words folded to
 * digits, punctuation and filler removed.
 */
export function normalizeForScoring(input: string): string[] {
  let s = input.toLowerCase();

  // Symbols to the words speech uses. Currency moves AFTER the amount, which
  // is how it is spoken ("$49" -> "49 dollars").
  s = s.replace(/\$\s?([\d.,]+)/g, " $1 dollars ");
  s = s.replace(/([\d.,]+)\s?%/g, " $1 percent ");
  s = s.replace(/%/g, " percent ");
  s = s.replace(/&/g, " and ");
  s = s.replace(/\+/g, " plus ");
  // "80-49" and "80.49" are the same digits to the ear; keep decimals, drop
  // hyphens between digits so a hyphenated read-out still matches.
  s = s.replace(/(\d)[-–](\d)/g, "$1 $2");
  s = s.replace(/[^a-z0-9. ]/g, " ");
  // A period that is not between digits is punctuation, not a decimal point.
  s = s.replace(/\.(?!\d)/g, " ").replace(/(?<!\d)\./g, " ");
  s = s.replace(/,/g, " ");

  const raw = s.split(/\s+/).filter(Boolean);

  // Fold consecutive runs of number words into digits.
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const folded = foldNumberRun(run);
    if (folded !== null) out.push(folded);
    else out.push(...run);
    run = [];
  };
  for (const w of raw) {
    if (NUMBER_WORD.test(w)) {
      run.push(w);
    } else {
      flush();
      out.push(ORDINALS[w] ?? w);
    }
  }
  flush();

  // Trailing "and" from a folded run is punctuation-ish; drop stray copulas.
  return out.filter((w) => w !== "and" || out.length < 3);
}

/** Word error rate over normalized text. */
export function normalizedWer(reference: string, hypothesis: string): number {
  const r = normalizeForScoring(reference);
  const h = normalizeForScoring(hypothesis);
  const d: number[][] = Array.from({ length: r.length + 1 }, (_, i) =>
    Array.from({ length: h.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1),
      );
    }
  }
  return d[r.length][h.length] / Math.max(1, r.length);
}
