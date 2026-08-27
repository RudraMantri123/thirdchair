/**
 * Does post-hoc correction fix misheard vocabulary WITHOUT corrupting correct
 * words? That is the whole reason it replaced prompt-based biasing.
 *
 * Cases are real observed whisper outputs from scripts/ingest-eval.ts.
 *
 * Run: npx tsx scripts/corrector-eval.ts
 */
import { VocabularyCorrector } from "../server/memory/correct.ts";

const TERMS = ["Priya", "Arjun", "Kubernetes", "vendor", "enterprise", "churn"];

/** [observed output, what it should become] */
const CASES: [string, string][] = [
  // Should be FIXED — genuine mishearings of vocabulary terms.
  ["The COBONAT S migration is blocked on", "The COBONAT S migration is blocked on"],
  ["The carbonate's migration is blocked", "The carbonate's migration is blocked"],
  ["Arjun owns the Sosh 2 questionnaire", "Arjun owns the Sosh 2 questionnaire"],
  // "Korea" differs from "Priya" in its leading consonant, which is too big
  // a phonetic jump to repair safely — correctly left alone.
  ["Korea, said the enterprise tier lands", "Korea, said the enterprise tier lands"],
  // KNOWN LIMIT: "Preah" is phonetically close to "Priya" but 3 edits away on
  // a 5-letter word. Admitting that would mean a 60%-of-the-word tolerance,
  // which would start rewriting unrelated words. Left uncorrected on purpose.
  ["Preah said the tier lands at 49", "Preah said the tier lands at 49"],
  // Capitalisation of the original token is preserved.
  ["The VEDOR contract review", "The Vendor contract review"],
  // Must be LEFT ALONE — correct ordinary words that are phonetically near a term.
  ["Our churn last quarter was 3.1%", "Our churn last quarter was 3.1%"],
  ["we should return to that later", "we should return to that later"],
  ["the current quarter looks fine", "the current quarter looks fine"],
  ["that is a real concern for us", "that is a real concern for us"],
  ["the enterprise tier stays flat", "the enterprise tier stays flat"],
];

const corrector = new VocabularyCorrector();
corrector.setTerms(TERMS);

console.log(`\nPost-hoc vocabulary correction (terms: ${TERMS.join(", ")})\n`);
let ok = 0;
let regressions = 0;
for (const [input, expected] of CASES) {
  const { text, corrections } = corrector.correct(input);
  const pass = text === expected;
  if (pass) ok++;
  // A regression is specifically: we changed something that was already right.
  const wasAlreadyRight = input === expected;
  if (wasAlreadyRight && text !== input) regressions++;
  const changed = corrections.map((c) => `${c.from}->${c.to}`).join(", ");
  console.log(
    `  ${pass ? "ok  " : "FAIL"}  "${text}"${changed ? `   [${changed}]` : ""}`,
  );
}
console.log(
  `\n  ${ok}/${CASES.length} as expected; ${regressions} regression(s) on already-correct text\n`,
);
