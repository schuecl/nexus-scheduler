// Post-hoc degenerate-output detection (issue #165) for the final text
// LibreChat's Agents API returns. The worker only ever calls that API with
// `stream: false` (librechatClient.ts) — the call already ran to completion
// by the time this runs, so this cannot abort a generation mid-flight or
// save tokens. What it *can* do: tell a run apart from one whose agent got
// stuck looping the same section until it hit its output-token ceiling, so
// that failure mode is visible in metrics/logs instead of silently stored
// as a normal-looking SUCCESS.
//
// Deliberately conservative: real code and structured output legitimately
// repeats short tokens (braces, keywords, property names), so only
// non-trivial lines/paragraphs count, and only exact adjacent repeats or a
// high trailing-window repeated-phrase ratio trip a reason. Thresholds are
// engineering defaults (see issue #165's own "must be evaluated per model"
// caveat) — tune against real run output rather than guessing further.

const MIN_REPEAT_UNIT_LENGTH = 20;
const CONSECUTIVE_LINE_LIMIT = 3;
const CONSECUTIVE_PARAGRAPH_LIMIT = 2;
const NGRAM_SIZE_WORDS = 8;
const NGRAM_TRAILING_WINDOW_WORDS = 300;
const NGRAM_REPEAT_RATIO_THRESHOLD = 0.35;

export interface RepetitionDetectionResult {
  detected: boolean;
  reasons: string[];
  repeatedNgramRatio: number;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function longestConsecutiveRepeat(units: string[]): number {
  let longest = 1;
  let run = 1;
  for (let i = 1; i < units.length; i++) {
    const current = units[i];
    const previous = units[i - 1];
    if (current !== undefined && previous !== undefined && normalize(current) === normalize(previous)) {
      run++;
      longest = Math.max(longest, run);
    } else {
      run = 1;
    }
  }
  return units.length > 0 ? longest : 0;
}

export function detectRepetition(text: string): RepetitionDetectionResult {
  const reasons: string[] = [];

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= MIN_REPEAT_UNIT_LENGTH);
  const longestLineRun = longestConsecutiveRepeat(lines);
  if (longestLineRun >= CONSECUTIVE_LINE_LIMIT) {
    reasons.push(`same line repeated ${longestLineRun} times consecutively`);
  }

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length >= MIN_REPEAT_UNIT_LENGTH);
  const longestParagraphRun = longestConsecutiveRepeat(paragraphs);
  if (longestParagraphRun >= CONSECUTIVE_PARAGRAPH_LIMIT) {
    reasons.push(`same paragraph repeated ${longestParagraphRun} times consecutively`);
  }

  const words = text.trim().split(/\s+/).filter(Boolean);
  const windowWords = words.slice(-NGRAM_TRAILING_WINDOW_WORDS);
  let repeatedNgramRatio = 0;
  if (windowWords.length >= NGRAM_SIZE_WORDS * 2) {
    const seen = new Map<string, number>();
    let repeatedNgrams = 0;
    let totalNgrams = 0;
    for (let i = 0; i + NGRAM_SIZE_WORDS <= windowWords.length; i++) {
      const gram = windowWords
        .slice(i, i + NGRAM_SIZE_WORDS)
        .join(" ")
        .toLowerCase();
      totalNgrams++;
      const occurrences = (seen.get(gram) ?? 0) + 1;
      seen.set(gram, occurrences);
      if (occurrences > 1) {
        repeatedNgrams++;
      }
    }
    repeatedNgramRatio = totalNgrams > 0 ? repeatedNgrams / totalNgrams : 0;
    if (repeatedNgramRatio >= NGRAM_REPEAT_RATIO_THRESHOLD) {
      reasons.push(
        `repeated ${NGRAM_SIZE_WORDS}-word phrases across ${Math.round(repeatedNgramRatio * 100)}% of the ` +
          `trailing ${windowWords.length}-word window`,
      );
    }
  }

  return { detected: reasons.length > 0, reasons, repeatedNgramRatio };
}
