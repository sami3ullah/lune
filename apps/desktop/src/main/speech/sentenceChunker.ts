/**
 * Splits the Reasoning model's streaming output into complete sentences so each can
 * be synthesized and played while the next is still being generated
 * (sentence-streaming, ticket 09). This is the pure logic behind that pipeline: feed
 * it the accumulated response text as it grows, and it returns each newly-completed
 * sentence exactly once.
 *
 * The `[POINT:...]` tag the model appends at the very end of a response is not
 * speech, so anything from the first "[" onward is held back and never spoken;
 * `flushRemaining` drops it entirely. Carried from v1's `SpeechSentenceChunker.swift`
 * with its behaviour (decimal guard, trailing-tag holdback) intact.
 *
 * It lives in the Shell (not the Core) because it is Shell playback plumbing: the
 * Core streams answer text; the Shell decides how to chunk it for the audio player.
 */
export class SpeechSentenceChunker {
  /**
   * How many leading characters of the accumulated text have already been returned
   * as sentences, so each sentence is emitted exactly once as the text grows.
   */
  private emittedCharacterCount = 0;

  /**
   * Given the full accumulated response text so far, returns any sentences that have
   * become complete since the last call. The accumulated text only ever grows, so
   * callers can pass the latest snapshot each time.
   */
  ingest(accumulatedText: string): string[] {
    const characters = Array.from(accumulatedText);
    const speakableEnd = speakableEndIndex(characters);
    if (this.emittedCharacterCount >= speakableEnd) {
      return [];
    }

    const sentences: string[] = [];
    let sentenceStart = this.emittedCharacterCount;
    let scanIndex = this.emittedCharacterCount;

    while (scanIndex < speakableEnd) {
      const character = characters[scanIndex]!;
      if (
        isSentenceEndingPunctuation(character) &&
        !isDecimalPoint(character, scanIndex, characters)
      ) {
        // Absorb any closing quotes/brackets that belong to this sentence.
        let sentenceEnd = scanIndex + 1;
        while (sentenceEnd < speakableEnd && isTrailingPunctuation(characters[sentenceEnd]!)) {
          sentenceEnd += 1;
        }
        // A sentence is complete only if what follows is whitespace or the end of the
        // speakable region - otherwise the punctuation is mid-word.
        const followedByBoundary =
          sentenceEnd >= speakableEnd || isWhitespace(characters[sentenceEnd]!);
        if (followedByBoundary) {
          const sentence = characters.slice(sentenceStart, sentenceEnd).join("").trim();
          if (sentence.length > 0) {
            sentences.push(sentence);
          }
          sentenceStart = sentenceEnd;
          scanIndex = sentenceEnd;
          continue;
        }
      }
      scanIndex += 1;
    }

    this.emittedCharacterCount = sentenceStart;
    return sentences;
  }

  /**
   * Returns whatever speakable text remains after the last complete sentence (a final
   * sentence with no trailing punctuation, e.g. "See that button"), dropping the point
   * tag. Call once when the stream is finished.
   */
  flushRemaining(accumulatedText: string): string | undefined {
    const characters = Array.from(accumulatedText);
    const speakableEnd = speakableEndIndex(characters);

    if (this.emittedCharacterCount >= speakableEnd) {
      this.emittedCharacterCount = characters.length;
      return undefined;
    }

    const remaining = characters.slice(this.emittedCharacterCount, speakableEnd).join("").trim();
    this.emittedCharacterCount = characters.length;
    return remaining.length > 0 ? remaining : undefined;
  }
}

/**
 * The end of the speakable region: everything before the first "[", since that may
 * open the trailing "[POINT:...]" tag, which is never spoken. Returns the full length
 * when there is no bracket.
 */
function speakableEndIndex(characters: string[]): number {
  const firstBracketIndex = characters.indexOf("[");
  return firstBracketIndex === -1 ? characters.length : firstBracketIndex;
}

function isSentenceEndingPunctuation(character: string): boolean {
  return character === "." || character === "!" || character === "?";
}

function isTrailingPunctuation(character: string): boolean {
  return (
    character === '"' ||
    character === "'" ||
    character === ")" ||
    character === "]" ||
    character === "”" ||
    character === "’" ||
    character === "…"
  );
}

/** True for whitespace (space, tab, newline), matching Swift's `Character.isWhitespace`. */
function isWhitespace(character: string): boolean {
  return /\s/.test(character);
}

/** True for a decimal digit, matching the decimal-guard intent of Swift's `isNumber`. */
function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

/**
 * True when a "." sits between two digits (e.g. "3.14"), so it isn't a sentence
 * boundary. Numbers like this are rare given the spoken-style prompt, but guarding
 * keeps a decimal from being split mid-number.
 */
function isDecimalPoint(character: string, index: number, characters: string[]): boolean {
  if (character !== "." || index <= 0 || index + 1 >= characters.length) {
    return false;
  }
  return isDigit(characters[index - 1]!) && isDigit(characters[index + 1]!);
}
