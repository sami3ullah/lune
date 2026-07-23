import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useOverlayStore } from "./overlayStore";
import {
  arcControlPoint,
  flightDurationMs,
  flightFrameAt,
  type Point2D,
} from "./overlayCursorFlight";

// The Overlay surface (ticket 07): Lune's playful cursor and the response bubble that
// streams the answer beside it. This renders in a full-screen, click-through window -
// one per display - so it is purely presentational (the main process, which owns the
// display geometry, decides when to show it and where to point).
//
// The cursor rests near the top of the screen with a gentle idle float ("alive, not a
// tooltip"), and when the answer carries a Point Tag it flies along a bezier arc to the
// target and points at it (the arc/easing math is the pure, tested `overlayCursorFlight`
// module; this component just drives a clock). The whole surface fades in for an
// interaction and, after ~1s of inactivity, fades out - then tells main it is idle so
// the window is hidden until next time.

/** Where the cursor rests when idle: horizontally centred, a little below the notch. */
const IDLE_TOP_OFFSET = 140;
/** The idle float: a slow vertical bob so the cursor reads as alive at rest. */
const IDLE_BOB_AMPLITUDE = 4;
const IDLE_BOB_PERIOD_MS = 1300;
/** The cursor's resting tilt (its tip points up at 0deg; a slight tilt reads as a pointer). */
const REST_ROTATION_DEGREES = -20;
/** How sharply rotation eases back toward rest between frames (0..1 per frame). */
const ROTATION_EASE = 0.15;
/** How long after the last activity the overlay waits before fading out (~1s). */
const INACTIVITY_FADE_DELAY_MS = 1100;
/** The fade in/out duration, in seconds (framer-motion). */
const FADE_DURATION_S = 0.4;

interface CursorFrame {
  x: number;
  y: number;
  rotationDegrees: number;
  scale: number;
}

/** An in-progress flight along a bezier arc from `start` to `end`. */
interface ActiveFlight {
  start: Point2D;
  control: Point2D;
  end: Point2D;
  startTime: number;
  durationMs: number;
}

export function Overlay() {
  const phase = useOverlayStore((state) => state.phase);
  const answerText = useOverlayStore((state) => state.answerText);
  const pointTarget = useOverlayStore((state) => state.pointTarget);
  const showStreamingText = useOverlayStore((state) => state.showStreamingText);
  const beginInteraction = useOverlayStore((state) => state.beginInteraction);
  const appendAnswer = useOverlayStore((state) => state.appendAnswer);
  const setPointTarget = useOverlayStore((state) => state.setPointTarget);
  const endInteraction = useOverlayStore((state) => state.endInteraction);
  const reset = useOverlayStore((state) => state.reset);

  const [visible, setVisible] = useState(false);
  const [cursorFrame, setCursorFrame] = useState<CursorFrame>(() => ({
    x: window.innerWidth / 2,
    y: IDLE_TOP_OFFSET,
    rotationDegrees: REST_ROTATION_DEGREES,
    scale: 1,
  }));

  // Mutable animation state kept in refs so the single RAF loop reads/writes it without
  // re-subscribing every frame. `restingPosition` is where the cursor sits when not
  // flying (its idle home, or wherever a flight last landed).
  const restingPositionRef = useRef<Point2D>({ x: window.innerWidth / 2, y: IDLE_TOP_OFFSET });
  const rotationRef = useRef<number>(REST_ROTATION_DEGREES);
  const flightRef = useRef<ActiveFlight | null>(null);
  const lastActivityRef = useRef<number>(0);

  // Translate the main process's Overlay events into store updates + visibility. Only
  // the Overlay surface subscribes; the Pill window never calls this.
  useEffect(() => {
    return window.lune.overlay.onOverlayEvent((event) => {
      lastActivityRef.current = performance.now();
      switch (event.type) {
        case "activity-start":
          beginInteraction();
          setVisible(true);
          break;
        case "answer-delta":
          appendAnswer(event.text);
          break;
        case "point":
          setPointTarget({ x: event.point.localX, y: event.point.localY, label: event.point.label });
          break;
        case "activity-end":
          endInteraction();
          break;
      }
    });
  }, [beginInteraction, appendAnswer, setPointTarget, endInteraction]);

  // Start a flight whenever a (new) pointing target arrives, from wherever the cursor
  // currently rests. Recording the flight in a ref (not state) keeps the RAF loop the
  // single writer of position.
  useEffect(() => {
    if (pointTarget === null) {
      return;
    }
    const start = { ...restingPositionRef.current };
    const end = { x: pointTarget.x, y: pointTarget.y };
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    flightRef.current = {
      start,
      control: arcControlPoint(start, end),
      end,
      startTime: performance.now(),
      durationMs: flightDurationMs(distance),
    };
    lastActivityRef.current = performance.now();
  }, [pointTarget]);

  // The one animation loop, running only while the overlay is visible. Each frame it
  // advances a flight (or bobs the cursor at rest), eases rotation toward its target,
  // and - once the answer is done and nothing has happened for a beat - triggers the
  // fade-out.
  useEffect(() => {
    if (!visible) {
      return;
    }
    let rafId = 0;

    const renderFrame = (now: number) => {
      const flight = flightRef.current;
      let x: number;
      let y: number;
      let scale: number;
      let targetRotation: number;

      if (flight) {
        const progress = (now - flight.startTime) / flight.durationMs;
        const frame = flightFrameAt(flight.start, flight.control, flight.end, progress);
        x = frame.x;
        y = frame.y;
        scale = frame.scale;
        targetRotation = frame.rotationDegrees;
        if (progress >= 1) {
          // Landed: rest here, and count the landing as fresh activity so the cursor
          // holds a moment at the target before the overlay fades.
          restingPositionRef.current = { x: flight.end.x, y: flight.end.y };
          flightRef.current = null;
          lastActivityRef.current = now;
        }
      } else {
        const rest = restingPositionRef.current;
        x = rest.x;
        y = rest.y + Math.sin((now / IDLE_BOB_PERIOD_MS) * Math.PI * 2) * IDLE_BOB_AMPLITUDE;
        scale = 1;
        targetRotation = REST_ROTATION_DEGREES;
      }

      // Ease rotation toward its target so the tip turns smoothly rather than snapping.
      rotationRef.current += (targetRotation - rotationRef.current) * ROTATION_EASE;
      setCursorFrame({ x, y, rotationDegrees: rotationRef.current, scale });

      // Fade out once the answer is finished and the cursor has been still for a beat.
      const isIdleLongEnough = now - lastActivityRef.current > INACTIVITY_FADE_DELAY_MS;
      if (phase === "ending" && flightRef.current === null && isIdleLongEnough) {
        setVisible(false);
        return;
      }

      rafId = requestAnimationFrame(renderFrame);
    };

    rafId = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(rafId);
  }, [visible, phase]);

  // When a new interaction begins, seed the resting position back at the idle home so
  // the cursor doesn't start a fresh answer wherever the last one happened to point.
  useEffect(() => {
    if (phase === "active" && flightRef.current === null) {
      restingPositionRef.current = { x: window.innerWidth / 2, y: IDLE_TOP_OFFSET };
    }
  }, [phase]);

  // The bubble shows only the streamed answer text, and only when the streaming-text
  // flag is on (spec: "hidden when the streaming-text flag is off"). A window that is
  // only pointing (the answer streamed on another display) shows no bubble - just the
  // cursor flying to the target.
  const bubbleText = showStreamingText && answerText.length > 0 ? answerText : null;

  return (
    <motion.div
      className="pointer-events-none fixed inset-0 overflow-hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: visible ? 1 : 0 }}
      transition={{ duration: FADE_DURATION_S, ease: "easeOut" }}
      onAnimationComplete={() => {
        // Once fully faded out, tell main to hide this window and clear our state so the
        // next interaction starts clean.
        if (!visible) {
          reset();
          window.lune.overlay.signalIdle();
        }
      }}
    >
      <PlayfulCursor frame={cursorFrame} />
      {bubbleText !== null && <ResponseBubble text={bubbleText} anchor={cursorFrame} />}
    </motion.div>
  );
}

/** The cursor triangle: a glowing pointer that rotates and swells as it flies. */
function PlayfulCursor({ frame }: { frame: CursorFrame }) {
  return (
    <div
      className="absolute"
      style={{
        left: frame.x,
        top: frame.y,
        transform: `translate(-50%, -50%) rotate(${frame.rotationDegrees}deg) scale(${frame.scale})`,
        // The glow scales with the cursor so the swoop reads energetically.
        filter: `drop-shadow(0 0 ${6 * frame.scale}px rgba(129, 140, 248, 0.9))`,
      }}
    >
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
        {/* An equilateral-ish triangle with its tip up at 0deg rotation. */}
        <path d="M10 1 L18 17 L10 13 L2 17 Z" fill="#a5b4fc" />
      </svg>
    </div>
  );
}

/** The response bubble beside the cursor, holding the streamed answer (or a pointer label). */
function ResponseBubble({ text, anchor }: { text: string; anchor: CursorFrame }) {
  // Sit to the right and just below the cursor, clamped so it never runs off-screen.
  const left = Math.min(Math.max(anchor.x + 16, 8), window.innerWidth - 320);
  const top = Math.min(Math.max(anchor.y + 14, 8), window.innerHeight - 80);
  return (
    <motion.div
      className="absolute max-w-[300px] rounded-xl border border-white/10 bg-neutral-900/90 px-3.5 py-2.5 text-[13px] leading-snug text-neutral-100 shadow-xl shadow-black/50 backdrop-blur-md"
      style={{ left, top }}
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "spring", stiffness: 400, damping: 28 }}
    >
      {text}
    </motion.div>
  );
}
