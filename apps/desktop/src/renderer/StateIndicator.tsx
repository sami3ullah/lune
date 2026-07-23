import { motion, type Transition, type TargetAndTransition } from "framer-motion";
import type { PillIndicatorState } from "./pillStore";

// The at-a-glance state dot on the pill (user story 15). Each state gets its own
// colour and its own motion so it reads instantly without a label: idle breathes
// slowly, listening ripples outward, thinking shimmers, speaking pulses in time
// with a voice, needs-attention blinks sharply.

interface IndicatorLook {
  /** The core dot colour, also the glow tint. */
  color: string;
  /** Human-readable name, surfaced next to the dot in the expanded menu. */
  label: string;
  /** The animated outer ring's target + timing; expresses the state's "feel". */
  ring: { animate: TargetAndTransition; transition: Transition };
}

const LOOK_BY_STATE: Record<PillIndicatorState, IndicatorLook> = {
  idle: {
    color: "#818cf8",
    label: "Idle",
    ring: {
      animate: { scale: [1, 1.15, 1], opacity: [0.35, 0.15, 0.35] },
      transition: { duration: 3.5, repeat: Infinity, ease: "easeInOut" },
    },
  },
  listening: {
    color: "#34d399",
    label: "Listening",
    ring: {
      animate: { scale: [1, 1.9], opacity: [0.6, 0] },
      transition: { duration: 1.1, repeat: Infinity, ease: "easeOut" },
    },
  },
  thinking: {
    color: "#fbbf24",
    label: "Thinking",
    ring: {
      animate: { scale: [1, 1.3, 1], opacity: [0.5, 0.2, 0.5] },
      transition: { duration: 0.9, repeat: Infinity, ease: "easeInOut" },
    },
  },
  speaking: {
    color: "#38bdf8",
    label: "Speaking",
    ring: {
      animate: { scale: [1, 1.6, 1], opacity: [0.55, 0.1, 0.55] },
      transition: { duration: 0.6, repeat: Infinity, ease: "easeInOut" },
    },
  },
  "needs-attention": {
    color: "#fb7185",
    label: "Needs attention",
    ring: {
      animate: { scale: [1, 1.35, 1], opacity: [0.8, 0.2, 0.8] },
      transition: { duration: 0.7, repeat: Infinity, ease: "easeInOut" },
    },
  },
};

/** The display label for a state, reused by the dev switcher. */
export function labelForState(state: PillIndicatorState): string {
  return LOOK_BY_STATE[state].label;
}

export function StateIndicator({ state }: { state: PillIndicatorState }) {
  const look = LOOK_BY_STATE[state];
  return (
    <span className="relative inline-flex h-3 w-3 items-center justify-center">
      <motion.span
        className="absolute inset-0 rounded-full"
        style={{ backgroundColor: look.color }}
        // Re-keyed on state so switching restarts the animation cleanly rather than
        // interpolating between two states' keyframes.
        key={state}
        animate={look.ring.animate}
        transition={look.ring.transition}
      />
      <span
        className="relative h-2 w-2 rounded-full"
        style={{ backgroundColor: look.color, boxShadow: `0 0 6px ${look.color}` }}
      />
    </span>
  );
}
