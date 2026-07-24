import { useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { CaptionData } from "./caption";

// The book-style caption reveal shared by the Pill and the Overlay. The spoken sentence
// arrives one word at a time in step with the voice (see useSpeechPlayback); this reveals
// each new word with a per-character animation, laid out along a single fixed-width line.
// When the next word would overrun that line, the whole line clears and the new word
// starts a fresh line from the left - exactly like reading a book: fill a line, return to
// the start, keep going. Purely presentational; the word timing lives upstream.
//
// The container is a fixed max width (not shrink-to-fit) so words fill left-to-right into
// a stable region and the surface never jitters its width as each word lands. Callers key
// this component on `caption.id` so a new sentence remounts it and the line resets to zero.

/** How the reveal is tuned per surface: the line's max width and the text styling. */
export interface CaptionRevealVariant {
  /** The line's fixed width in pixels - the "page width" words fill before it clears. */
  maxWidthPx: number;
  /** Tailwind classes for the text (size/colour), applied to the line container. */
  textClassName: string;
}

/** Per-character entrance: each letter rises and unblurs in, staggered across the word. */
const CHARACTER_STAGGER_SECONDS = 0.025;
const CHARACTER_DURATION_SECONDS = 0.28;

export function CaptionReveal({
  caption,
  variant,
}: {
  caption: CaptionData;
  variant: CaptionRevealVariant;
}) {
  // The absolute index of the first word on the currently visible line. As words fill the
  // line and it overflows, this jumps forward to the newest word, clearing the line.
  const [lineStartIndex, setLineStartIndex] = useState(0);
  const lineRef = useRef<HTMLDivElement>(null);

  // After each word lands, measure the line: if its content has overrun the max width and
  // more than one word is showing, clear the line and let the newest word begin a new one.
  // (A single word wider than the line is left as-is rather than looping forever.)
  useLayoutEffect(() => {
    const line = lineRef.current;
    if (!line) {
      return;
    }
    const wordsOnLine = caption.words.length - lineStartIndex;
    if (line.scrollWidth > line.clientWidth && wordsOnLine > 1) {
      setLineStartIndex(caption.words.length - 1);
    }
  }, [caption.words, lineStartIndex]);

  const visibleWords = caption.words.slice(lineStartIndex);

  return (
    <div
      ref={lineRef}
      className={`overflow-hidden whitespace-nowrap ${variant.textClassName}`}
      style={{ width: variant.maxWidthPx }}
    >
      <AnimatePresence initial={false}>
        {visibleWords.map((word, indexOnLine) => (
          <RevealedWord
            // The absolute word index keys each word: a word keeps its identity as the
            // line grows (so it never re-animates), and the words cleared on a line break
            // unmount (fading out) while the surviving newest word stays put.
            key={lineStartIndex + indexOnLine}
            word={word}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}

/** One word, animated in character by character, with a trailing space to the next word. */
function RevealedWord({ word }: { word: string }) {
  // Render a trailing space so words don't butt together; non-breaking so the nowrap line
  // keeps it. Splitting on characters lets each letter animate with its own small delay.
  const characters = Array.from(`${word} `);
  return (
    <motion.span
      className="inline-block align-baseline"
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
    >
      {characters.map((character, characterIndex) => (
        <motion.span
          key={characterIndex}
          className="inline-block"
          initial={{ opacity: 0, y: "0.35em", filter: "blur(4px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{
            duration: CHARACTER_DURATION_SECONDS,
            delay: characterIndex * CHARACTER_STAGGER_SECONDS,
            ease: "easeOut",
          }}
        >
          {character === " " ? " " : character}
        </motion.span>
      ))}
    </motion.span>
  );
}
