import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useTransform,
  type MotionValue,
} from "framer-motion";
import { useOverlayStore } from "./overlayStore";
import { CaptionReveal } from "./CaptionReveal";
import type { CaptionData } from "./caption";
import type { OverlayShape } from "../ipc/overlayControl";
import {
  arcControlPoint,
  flightDurationMs,
  flightFrameAt,
  springStep,
  FOLLOW_SPRING_RESPONSE_SECONDS,
  FOLLOW_SPRING_DAMPING_FRACTION,
  type ArcShaping,
  type Point2D,
} from "./overlayCursorFlight";
import {
  buildOutline,
  outlineToPathData,
  penTraceVisibility,
  sampleOutline,
  shapesBounds,
  traceDurationMs,
  type ShapeOutline,
  type TraceableShape,
  type TraceBounds,
} from "./overlayShapeTrace";
import {
  computeIntroCardTarget,
  INTRO_CARD_SPRING_RESPONSE_SECONDS,
  INTRO_CARD_SPRING_DAMPING_FRACTION,
} from "./introVideoPlacement";
import { introVideoUrl } from "./introVideoAsset";

// The Overlay surface (ticket 07 + v1 cursor-follow parity): Lune's playful cursor - the
// following triangle, the listening waveform, and the "working" loading spinner. This
// renders in a full-screen, click-through window - one per display - so it is purely
// presentational (the main process, which owns the display geometry, decides where the
// cursor is and when to point). The answer text itself streams in the Pill, one line at a
// time in step with the voice (see pillStore / useSpeechPlayback), not beside the cursor.
//
// The cursor's home is the *real mouse*: the main process polls the global cursor
// position and streams it to the window on the cursor's display (`cursor-move`), and
// this component glues the playful cursor to it with a springy ease, exactly like v1's
// `followingCursor` mode. When an answer carries a Point Tag the cursor leaves the mouse,
// flies along a bezier arc to the target, holds a beat, then flies back to the mouse and
// resumes following (the arc/easing math is the pure, tested `overlayCursorFlight`
// module; this component just drives a clock). The window stays shown always; the buddy
// itself fades in only while the cursor is on this display or an interaction is running.

/** How far the buddy sits from the true mouse point (its tip hugs the cursor). */
const BUDDY_OFFSET_X = 15;
const BUDDY_OFFSET_Y = 25;
/** The cursor's resting tilt (its tip points up at 0deg; a slight tilt reads as a pointer). */
const REST_ROTATION_DEGREES = -20;
/**
 * The time constant (seconds) of the rotation ease toward its target. Framed as a time
 * constant (not a per-frame fraction) so the turn is as smooth on a 144Hz display as on
 * a 60Hz one; ~0.1s reproduces the old per-frame feel at 60fps.
 */
const ROTATION_EASE_TIME_CONSTANT_SECONDS = 0.1;
/**
 * How long the cursor holds on a pointed target before flying back to the mouse - a
 * random span in this range per point, so the beat isn't metronomic.
 */
const POINT_HOLD_MIN_MS = 800;
const POINT_HOLD_MAX_MS = 1400;
/**
 * The little arc the cursor traces around the target while holding (the "goes around").
 * Kept small and under a full loop so it reads as a gentle settle at the target, not a
 * cursor wandering off on its own.
 */
const ORBIT_MIN_RADIUS_PX = 5;
const ORBIT_MAX_RADIUS_PX = 11;
/** How far around the target it drifts across the hold (< 1 = a partial arc, never a loop). */
const ORBIT_MIN_REVOLUTIONS = 0.35;
const ORBIT_MAX_REVOLUTIONS = 0.7;
/** A gentle size pulse while orbiting, so the hold breathes rather than sitting frozen. */
const ORBIT_SCALE_PULSE = 0.06;
/** How long after an answer ends the bubble lingers before clearing (then plain following). */
const INACTIVITY_CLEAR_MS = 1100;
/**
 * How long teaching drawings linger after the turn goes quiet before they fade (the
 * timeout half of the clear lifecycle). Each caption word bumps `lastActivityRef`, so
 * while the voice is reading (streaming text on) the drawing stays up for the whole
 * explanation and only starts this countdown once the caption clears at speech-end - a
 * touch longer than the bubble's clear, so a shape the voice just described doesn't vanish
 * the instant the words stop. With streaming text off there is no caption, so the drawing
 * instead clears this long after it was drawn. On the display that ran the answer the
 * bubble's `reset` usually clears shapes first; this timer is what clears a drawing on a
 * *second* monitor that got no cursor or bubble of its own to run that reset.
 */
const SHAPE_INACTIVITY_CLEAR_MS = 1600;
/** How quickly the buddy fades in/out as the cursor enters/leaves this display. */
const BUDDY_FADE_S = 0.25;

/**
 * The cursor-riding intro video card (M3-03), the Farza-style welcome touch. ~400x600 as
 * the spec asks (DECISIONS #23); it rides alongside the pointer on the welcome step, kept
 * clear of the onboarding window. Gap is a touch wider than the buddy's so the big card
 * sits companionably beside the cursor rather than under it; margin keeps it off the edges.
 */
const INTRO_CARD_SIZE = { width: 400, height: 600 };
const INTRO_CARD_GAP_PX = 28;
const INTRO_CARD_MARGIN_PX = 24;
/** How quickly the card fades/pops in and out as it appears, dismisses, or changes display. */
const INTRO_CARD_FADE_S = 0.35;

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
  /** An extra twirl layered on top of the tangent-facing rotation, for a playful spin. */
  spinDegrees: number;
}

/**
 * The pointing sub-state layered on top of following:
 *   - `none`: the buddy is following the mouse (or just answering beside it).
 *   - `to-target`: flying from the mouse to the Point Tag target.
 *   - `holding`: landed on the target, holding so the user can see where it points.
 *   - `returning`: flying back to the mouse, after which following resumes.
 */
type PointPhase = "none" | "to-target" | "holding" | "returning";

function makeFlight(
  start: Point2D,
  end: Point2D,
  startTime: number,
  shaping: ArcShaping,
  spinDegrees: number,
): ActiveFlight {
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  return {
    start,
    control: arcControlPoint(start, end, shaping),
    end,
    startTime,
    durationMs: flightDurationMs(distance),
    spinDegrees,
  };
}

/** A random real in `[min, max)`. Randomness lives here (the flight math stays pure). */
function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * How often a pointing flight gets the showy "flourish" - a slightly bolder curve, a small
 * twirl, and a little arc around the target. Kept rare on purpose: the everyday movement
 * should be a calm, pretty arc-and-hold, with the cursor only occasionally showing off, so
 * it feels alive without wandering or doing too much.
 */
const FLOURISH_PROBABILITY = 0.12;

/**
 * A fresh, randomized arc shape for one flight. A `flourish` flight bows a little more (and
 * occasionally the "wrong" way) with a varied crest; a calm flight bows gently upward with
 * only slight variation, so the everyday movement is smooth, moderate, and unshowy.
 */
function randomArcShaping(flourish: boolean): ArcShaping {
  if (!flourish) {
    return {
      perpendicular: -randomBetween(0.45, 0.7),
      lateral: randomBetween(-0.1, 0.1),
    };
  }
  const bowsUp = Math.random() < 0.8;
  return {
    perpendicular: (bowsUp ? -1 : 1) * randomBetween(0.6, 1.1),
    lateral: randomBetween(-0.35, 0.35),
  };
}

/**
 * A small extra twirl (degrees) for a flourish flight; calm flights don't twirl at all.
 * Kept modest - a gentle turn, never a full spin - so it reads as playful, not frantic.
 */
function randomSpinDegrees(flourish: boolean): number {
  if (!flourish) {
    return 0;
  }
  return (Math.random() < 0.5 ? -1 : 1) * randomBetween(30, 90);
}

/** Smoothstep easing on `[0,1]`, so a layered twirl accelerates in and settles out. */
function smoothstep(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped * clamped * (3 - 2 * clamped);
}

// Guided teaching (M3-04): a drawing that groups its marks into steps is walked one step at
// a time - the cursor flies to each step, traces its primary mark as the stroke draws on,
// holds while the voice explains, then moves on, with a soft tinted backdrop lifting the
// active step's area (never dimming the screen). This is layered on top of the pointing
// flight above: it
// reuses the same `flightRef`/`makeFlight` machinery to move the cursor, and only intercepts
// the flight-landing and cursor-position branches while a walk is in progress.

/** The minimum a step is held before the walk advances (the streaming-text-off fallback). */
const STEP_MIN_DWELL_MS = 1500;
/**
 * Once the voice has moved on to the next step's sentence, advance after this beat. The
 * drawing often starts after the voice (mark refinement runs while the answer is already
 * being spoken), so the voice is routinely a step or two ahead - this floor is what keeps
 * the walk deliberate in that case instead of racing every step to catch up.
 */
const STEP_CATCHUP_MIN_MS = 1000;
/** A hard cap on one teaching walk, so a stalled sync can never leave a walk stuck mid-step. */
const MAX_TEACH_MS = 45000;
/** Padding (px) around a step's marks for the backdrop patch and step-badge placement. */
const STEP_BOUNDS_PADDING = 16;

/** The teaching walk's phase, layered alongside the pointing phase (see PointPhase). */
type TeachPhase = "idle" | "advancing" | "drawing" | "holding" | "handoff";

/** One resolved teaching step: its marks, the outline the cursor traces, and its label. */
interface TeachStep {
  /** The shapes the model grouped into this step (the first is the one the cursor traces). */
  shapes: OverlayShape[];
  /** The outline of the step's primary (first) mark - what the cursor rides as it draws on. */
  primaryOutline: ShapeOutline;
  /** The padded box enclosing the step's marks, for the backdrop patch (null if empty). */
  bounds: TraceBounds | null;
  /** The short instruction shown on this step (the first non-empty mark label). */
  label: string;
  /** The 1-based number shown in the step's badge. */
  stepNumber: number;
}

/** Reduces an Overlay shape to the pure form the tracer/bounds helpers understand. */
function toTraceable(shape: OverlayShape): TraceableShape {
  return {
    kind: shape.kind,
    points: shape.points.map((point) => ({ x: point.localX, y: point.localY })),
    radius: shape.radius,
  };
}

/**
 * Groups a display's shapes into ordered teaching steps by their `step` number. Only shapes
 * carrying a step take part in the grouping; a drawing with no stepped shapes at all becomes
 * a single synthetic step holding every mark, so even a plain one-mark drawing gets the full
 * guided treatment - the cursor flies over and visibly draws it, rather than the mark just
 * blinking on. Steps are ordered by step number and the shapes within each keep the model's
 * emission order (the first is the cursor-traced primary).
 */
function groupTeachingSteps(shapes: OverlayShape[]): TeachStep[] {
  const byStep = new Map<number, OverlayShape[]>();
  for (const shape of shapes) {
    if (shape.step === null) {
      continue;
    }
    const existing = byStep.get(shape.step);
    if (existing === undefined) {
      byStep.set(shape.step, [shape]);
    } else {
      existing.push(shape);
    }
  }
  if (byStep.size === 0 && shapes.length > 0) {
    byStep.set(1, [...shapes]);
  }
  return Array.from(byStep.keys())
    .sort((a, b) => a - b)
    .map((stepNumber, index) => {
      const stepShapes = byStep.get(stepNumber)!;
      const primary = stepShapes[0]!;
      return {
        shapes: stepShapes,
        primaryOutline: buildOutline(toTraceable(primary)),
        bounds: shapesBounds(stepShapes.map(toTraceable), STEP_BOUNDS_PADDING),
        label:
          stepShapes
            .map((shape) => shape.label)
            .find((label) => label.length > 0) ?? "",
        stepNumber: index + 1,
      };
    });
}

/** A calm flight from `from` to the start of `step`'s primary outline (the pen's approach). */
function flightToStepStart(
  from: Point2D,
  step: TeachStep,
  now: number,
): ActiveFlight {
  const start = sampleOutline(step.primaryOutline, 0);
  return makeFlight(
    from,
    { x: start.x, y: start.y },
    now,
    randomArcShaping(false),
    0,
  );
}

export function Overlay() {
  const phase = useOverlayStore((state) => state.phase);
  const pointTarget = useOverlayStore((state) => state.pointTarget);
  const listening = useOverlayStore((state) => state.listening);
  const listeningLevel = useOverlayStore((state) => state.listeningLevel);
  const thinking = useOverlayStore((state) => state.thinking);
  const caption = useOverlayStore((state) => state.caption);
  const setCaption = useOverlayStore((state) => state.setCaption);
  const beginInteraction = useOverlayStore((state) => state.beginInteraction);
  const appendAnswer = useOverlayStore((state) => state.appendAnswer);
  const setPointTarget = useOverlayStore((state) => state.setPointTarget);
  const endInteraction = useOverlayStore((state) => state.endInteraction);
  const reset = useOverlayStore((state) => state.reset);
  const beginListening = useOverlayStore((state) => state.beginListening);
  const setListeningLevel = useOverlayStore((state) => state.setListeningLevel);
  const endListening = useOverlayStore((state) => state.endListening);
  const beginThinking = useOverlayStore((state) => state.beginThinking);
  const endThinking = useOverlayStore((state) => state.endThinking);
  const shapes = useOverlayStore((state) => state.shapes);
  const setShapes = useOverlayStore((state) => state.setShapes);
  const clearShapes = useOverlayStore((state) => state.clearShapes);
  const activeStepIndex = useOverlayStore((state) => state.activeStepIndex);
  const setActiveStep = useOverlayStore((state) => state.setActiveStep);
  const teachingActive = useOverlayStore((state) => state.teachingActive);
  const setTeachingActive = useOverlayStore((state) => state.setTeachingActive);
  const introVideoActive = useOverlayStore((state) => state.introVideoActive);
  const introVideoAvoidRect = useOverlayStore(
    (state) => state.introVideoAvoidRect,
  );
  const startIntroVideo = useOverlayStore((state) => state.startIntroVideo);
  const endIntroVideo = useOverlayStore((state) => state.endIntroVideo);

  const [showBuddy, setShowBuddy] = useState(false);
  // Whether the intro card is drawn on this display this frame (active AND the cursor is
  // here), and where its top-left rests - both driven by the one RAF loop below.
  const [showIntroCard, setShowIntroCard] = useState(false);
  const [introCardPosition, setIntroCardPosition] = useState<Point2D>({
    x: 0,
    y: 0,
  });
  // A key that changes each time a fresh drawing arrives, so React remounts the shape
  // marks and re-runs their draw-on animation rather than reconciling them in place.
  const [shapesGeneration, setShapesGeneration] = useState(0);
  const [cursorFrame, setCursorFrame] = useState<CursorFrame>(() => ({
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
    rotationDegrees: REST_ROTATION_DEGREES,
    scale: 1,
  }));

  // Mutable animation state kept in refs so the single RAF loop reads/writes it without
  // re-subscribing every frame. `cursorLocalRef` is the latest real mouse position on
  // this display (from the main process's follow poll); `positionRef` is where the buddy
  // is actually rendered (eased toward the mouse, or along a flight arc).
  const cursorLocalRef = useRef<Point2D>({
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
  });
  const cursorPresentRef = useRef<boolean>(false);
  const positionRef = useRef<Point2D>({
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
  });
  // The follow spring's per-axis velocity (v1's springy chase). Reset to zero whenever the
  // buddy is snapped or handed back from a flight so it settles rather than lurching.
  const velocityRef = useRef<Point2D>({ x: 0, y: 0 });
  const rotationRef = useRef<number>(REST_ROTATION_DEGREES);
  // The timestamp of the previous rendered frame, so each frame advances the spring/rotation
  // by real elapsed time (frame-rate independent) rather than a fixed per-frame fraction.
  const lastFrameTimeRef = useRef<number>(0);
  const flightRef = useRef<ActiveFlight | null>(null);
  const pointPhaseRef = useRef<PointPhase>("none");
  const pointLandedAtRef = useRef<number>(0);
  const lastActivityRef = useRef<number>(0);
  // The little orbit the cursor traces around a landed target while it holds. The centre
  // is offset from the landing point so the orbit starts exactly where it landed (no jump);
  // radius, direction, revolutions, and hold length are randomized per point so the flourish
  // never repeats. Written when a flight lands in `holding`, read by the hold branch.
  const orbitCenterRef = useRef<Point2D>({ x: 0, y: 0 });
  const orbitRadiusRef = useRef<number>(0);
  const orbitStartAngleRef = useRef<number>(0);
  const orbitAngularSpanRef = useRef<number>(0);
  const holdDurationRef = useRef<number>(POINT_HOLD_MIN_MS);
  // Whether the current point gets the showy flourish (twirl + orbit) or a calm hold.
  // Decided once when the flight starts and read again when it lands.
  const pointFlourishRef = useRef<boolean>(false);

  // Guided teaching (M3-04) walk state, all RAF-owned so the loop stays the single writer of
  // the cursor's position. `teachPhaseRef` layers on top of the pointing phase; the walk only
  // intercepts the flight-landing and position branches while it is non-idle.
  const teachPhaseRef = useRef<TeachPhase>("idle");
  const teachStepsRef = useRef<TeachStep[]>([]);
  const activeStepIndexRef = useRef<number>(0);
  const stepDrawStartRef = useRef<number>(0);
  const stepDrawDurationRef = useRef<number>(0);
  const stepHoldStartRef = useRef<number>(0);
  // The step the voice has reached (distinct caption sentences seen), consumed at each hold.
  const pendingStepRef = useRef<number>(0);
  const teachSeenCaptionIdsRef = useRef<Set<string>>(new Set());
  const teachStartRef = useRef<number>(0);
  // The shared draw-on clock: the active step's primary mark binds its SVG pathLength to this
  // exact value, so the stroke appears in lockstep with the cursor riding its outline.
  const drawProgress = useMotionValue(0);

  // Mirror the store's phase/listening into refs so the always-on RAF loop reads their
  // current values without being torn down and rebuilt on every change.
  const phaseRef = useRef(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  const listeningRef = useRef(listening);
  useEffect(() => {
    listeningRef.current = listening;
  }, [listening]);
  const thinkingRef = useRef(thinking);
  useEffect(() => {
    thinkingRef.current = thinking;
  }, [thinking]);
  // The caption (spoken reply) outlives the turn's `activity-end` - Kokoro keeps speaking
  // after the stream ends - so the RAF loop reads it to keep the buddy shown and defer the
  // inactivity clear until the voice (and its caption) has actually finished.
  const captionRef = useRef(caption);
  useEffect(() => {
    captionRef.current = caption;
  }, [caption]);
  // Whether any teaching drawing is currently up, read by the always-on RAF loop so it can
  // clear the drawing once the turn goes quiet without re-subscribing each frame.
  const shapesPresentRef = useRef(shapes.length > 0);
  useEffect(() => {
    shapesPresentRef.current = shapes.length > 0;
  }, [shapes]);

  // The intro card's follow state, read/written only by the RAF loop (the single writer of
  // its rendered position, exactly like the buddy's `positionRef`). `seeded` snaps the card
  // onto its placement on activation and on cursor re-entry so it appears in place rather
  // than gliding in from a stale spot; the store's active flag + avoid rect are mirrored
  // into refs so the always-on loop reads them without re-subscribing each frame.
  const introCardPositionRef = useRef<Point2D>({ x: 0, y: 0 });
  const introCardVelocityRef = useRef<Point2D>({ x: 0, y: 0 });
  const introCardSeededRef = useRef<boolean>(false);
  const introVideoActiveRef = useRef(introVideoActive);
  useEffect(() => {
    introVideoActiveRef.current = introVideoActive;
  }, [introVideoActive]);
  const introVideoAvoidRectRef = useRef(introVideoAvoidRect);
  useEffect(() => {
    introVideoAvoidRectRef.current = introVideoAvoidRect;
  }, [introVideoAvoidRect]);

  // Translate the main process's Overlay events into follow-state + store updates. Only
  // the Overlay surface subscribes; the Pill window never calls this.
  useEffect(() => {
    return window.lune.overlay.onOverlayEvent((event) => {
      switch (event.type) {
        case "cursor-move":
          // The real mouse moved on this display: track it (the RAF loop eases toward it).
          // On re-entry from another display (the buddy was faded out) snap straight to
          // the mouse so it appears at the cursor rather than sliding in from a stale spot -
          // but never mid-flight/pointing, which owns the position until it returns.
          if (
            !cursorPresentRef.current &&
            flightRef.current === null &&
            pointPhaseRef.current === "none"
          ) {
            positionRef.current = {
              x: event.position.localX + BUDDY_OFFSET_X,
              y: event.position.localY + BUDDY_OFFSET_Y,
            };
            // Snapped straight onto the mouse: clear the spring's momentum so it starts
            // its chase from rest rather than flinging past the cursor.
            velocityRef.current = { x: 0, y: 0 };
          }
          cursorLocalRef.current = {
            x: event.position.localX,
            y: event.position.localY,
          };
          cursorPresentRef.current = true;
          break;
        case "cursor-leave":
          // The mouse moved to another display: stop drawing the following buddy here
          // (an in-flight pointing episode still finishes and returns).
          cursorPresentRef.current = false;
          break;
        case "listen-start":
          // Push-to-talk held: show the waveform at the cursor (ticket 11).
          lastActivityRef.current = performance.now();
          beginListening();
          break;
        case "listen-level":
          setListeningLevel(event.level);
          break;
        case "listen-end":
          // Hotkey released: stop the waveform. If an answer follows it takes over.
          endListening();
          break;
        case "thinking-start":
          // Transcribing + reasoning: show the loading spinner at the cursor so the user
          // knows work is happening (v1 processing parity). The answer supersedes it.
          lastActivityRef.current = performance.now();
          beginThinking();
          break;
        case "thinking-end":
          // Safety-net close: the answer normally supersedes the spinner, but a turn that
          // ends (or fails) before any answer streams still clears it here.
          endThinking();
          break;
        case "activity-start":
          // A fresh turn: clear any prior answer/target and start from wherever the buddy
          // currently is (following the mouse), so pointing this turn flies from here.
          lastActivityRef.current = performance.now();
          flightRef.current = null;
          pointPhaseRef.current = "none";
          // A new turn ends any teaching walk in progress (its drawing is cleared by the
          // main process's `clear-shapes`); reset the refs so a stale walk can't hijack this
          // turn's pointing flight when it lands.
          teachPhaseRef.current = "idle";
          teachStepsRef.current = [];
          beginInteraction();
          break;
        case "answer-delta":
          lastActivityRef.current = performance.now();
          appendAnswer(event.text);
          break;
        case "caption":
          // The words Lune is speaking now (empty clears it). Mark it as activity so the
          // buddy stays shown while the voice reads, past the turn's `activity-end`. The
          // first spoken word means synthesis is done and the voice has started, so the
          // loading spinner has served its purpose - end it here and reveal the caption.
          lastActivityRef.current = performance.now();
          if (event.words.length > 0) {
            endThinking();
            setCaption({ id: event.id, words: event.words });
            // Pace the teaching walk to the voice: each new spoken sentence advances the step
            // the walk is allowed to reach (one sentence per step, in order), clamped to the
            // last step. The holding branch consumes this once the current step has drawn.
            if (
              teachPhaseRef.current !== "idle" &&
              !teachSeenCaptionIdsRef.current.has(event.id)
            ) {
              teachSeenCaptionIdsRef.current.add(event.id);
              pendingStepRef.current = Math.min(
                teachSeenCaptionIdsRef.current.size - 1,
                Math.max(0, teachStepsRef.current.length - 1),
              );
            }
          } else {
            setCaption(null);
          }
          break;
        case "point":
          // A pointing flight is about to start - the cursor itself becomes the indicator,
          // so end the loading spinner if it is still up (e.g. an answer that points before
          // it speaks) rather than flying the spinner instead of the triangle.
          lastActivityRef.current = performance.now();
          endThinking();
          // Pointing and a teaching walk don't co-occur; if a point arrives, let it take over
          // cleanly so the landing routes to the point hold, not a stale teach step.
          teachPhaseRef.current = "idle";
          setTeachingActive(false);
          setPointTarget({
            x: event.point.localX,
            y: event.point.localY,
            label: event.point.label,
          });
          break;
        case "draw-shapes": {
          // A teaching drawing for this display: render it (animating on) and count it as
          // activity so it isn't cleared until the explanation goes quiet. A fresh
          // generation forces the marks to remount and replay their draw-on animation.
          const drawnAt = performance.now();
          lastActivityRef.current = drawnAt;
          setShapes(event.shapes);
          setShapesGeneration((generation) => generation + 1);
          const steps = groupTeachingSteps(event.shapes);
          teachStepsRef.current = steps;
          if (steps.length > 0) {
            // Begin a guided walk: reveal step 0 and fly the cursor to its primary mark, from
            // wherever it currently rests. The RAF loop drives it from here (advancing ->
            // drawing -> holding -> next / handoff).
            activeStepIndexRef.current = 0;
            pendingStepRef.current = 0;
            teachSeenCaptionIdsRef.current = new Set();
            teachStartRef.current = drawnAt;
            drawProgress.set(0);
            setActiveStep(0);
            setTeachingActive(true);
            flightRef.current = flightToStepStart(
              { ...positionRef.current },
              steps[0]!,
              drawnAt,
            );
            teachPhaseRef.current = "advancing";
          } else {
            // An empty drawing (unstepped shapes become a single synthetic step above,
            // so only a shapeless event lands here): nothing to walk.
            teachPhaseRef.current = "idle";
            setTeachingActive(false);
            setActiveStep(0);
          }
          break;
        }
        case "clear-shapes":
          // The next turn began, or a Barge-in interrupted: remove the drawing at once and
          // end any teaching walk, dropping the flight so the follow spring pulls the cursor
          // back to the mouse.
          teachPhaseRef.current = "idle";
          teachStepsRef.current = [];
          if (pointPhaseRef.current === "none") {
            flightRef.current = null;
          }
          clearShapes();
          break;
        case "intro-video-start":
          // The onboarding welcome step opened: ride the intro video beside the cursor,
          // kept clear of the wizard (`avoidRect`, this display's local rect, or null).
          startIntroVideo(event.avoidRect);
          break;
        case "intro-video-end":
          // The welcome step advanced or was skipped: dismiss the card (it fades out).
          endIntroVideo();
          break;
        case "activity-end":
          lastActivityRef.current = performance.now();
          endInteraction();
          break;
      }
    });
  }, [
    beginInteraction,
    appendAnswer,
    setPointTarget,
    endInteraction,
    beginListening,
    setListeningLevel,
    endListening,
    beginThinking,
    endThinking,
    setCaption,
    setShapes,
    clearShapes,
    setActiveStep,
    setTeachingActive,
    drawProgress,
    startIntroVideo,
    endIntroVideo,
  ]);

  // Start a flight whenever a (new) pointing target arrives, from wherever the buddy
  // currently rests. Recording the flight in a ref (not state) keeps the RAF loop the
  // single writer of position.
  useEffect(() => {
    if (pointTarget === null) {
      return;
    }
    const flourish = Math.random() < FLOURISH_PROBABILITY;
    pointFlourishRef.current = flourish;
    flightRef.current = makeFlight(
      { ...positionRef.current },
      { x: pointTarget.x, y: pointTarget.y },
      performance.now(),
      randomArcShaping(flourish),
      randomSpinDegrees(flourish),
    );
    pointPhaseRef.current = "to-target";
  }, [pointTarget]);

  // The one animation loop, always running (the window is shown always so the cursor can
  // follow the mouse). Each frame it advances a flight or eases the buddy toward the real
  // mouse, eases rotation toward its target, drives the pointing hold/return sequence,
  // and clears a finished answer's bubble after a beat (returning to plain following).
  useEffect(() => {
    let rafId = 0;

    const renderFrame = (now: number) => {
      // Real elapsed time since the previous frame, so the spring + rotation advance by
      // wall-clock time and feel identical at any refresh rate. Seed the first frame with a
      // nominal 60fps step so it doesn't lurch from a zero (or huge) initial delta.
      const previousFrameTime = lastFrameTimeRef.current;
      const elapsedSeconds =
        previousFrameTime === 0 ? 1 / 60 : (now - previousFrameTime) / 1000;
      lastFrameTimeRef.current = now;

      const mouseTarget: Point2D = {
        x: cursorLocalRef.current.x + BUDDY_OFFSET_X,
        y: cursorLocalRef.current.y + BUDDY_OFFSET_Y,
      };

      // Hard cap: if a teaching walk overruns (sync stalled, a step never advanced), force it
      // to hand back to the mouse so a walk can never hold a monitor hostage. Setting the flight here
      // lets the flight branch below fly it home and land it into `handoff` -> `idle`.
      if (
        teachPhaseRef.current !== "idle" &&
        teachPhaseRef.current !== "handoff" &&
        now - teachStartRef.current > MAX_TEACH_MS
      ) {
        teachPhaseRef.current = "handoff";
        flightRef.current = makeFlight(
          { ...positionRef.current },
          mouseTarget,
          now,
          randomArcShaping(false),
          0,
        );
      }

      const flight = flightRef.current;
      let x: number;
      let y: number;
      let scale: number;
      let targetRotation: number;

      if (flight) {
        const progress = (now - flight.startTime) / flight.durationMs;
        const frame = flightFrameAt(
          flight.start,
          flight.control,
          flight.end,
          progress,
        );
        x = frame.x;
        y = frame.y;
        scale = frame.scale;
        // Layer the flight's twirl on top of the tangent-facing rotation, eased so it
        // winds up out of the start and unwinds as it lands - a playful spin, not a snap.
        targetRotation =
          frame.rotationDegrees + flight.spinDegrees * smoothstep(progress);
        if (progress >= 1) {
          positionRef.current = { x: flight.end.x, y: flight.end.y };
          // Hand back to the follow spring from rest so it eases onto the mouse cleanly.
          velocityRef.current = { x: 0, y: 0 };
          flightRef.current = null;
          if (teachPhaseRef.current !== "idle") {
            // A teaching flight landed: route it BEFORE the pointing cases so a walk never
            // falls into the point-orbit setup.
            if (teachPhaseRef.current === "advancing") {
              // Arrived at the step's mark: start drawing it, the cursor riding the outline as
              // the stroke draws on (both driven by the shared `drawProgress` clock).
              const step = teachStepsRef.current[activeStepIndexRef.current];
              teachPhaseRef.current = "drawing";
              stepDrawStartRef.current = now;
              stepDrawDurationRef.current = traceDurationMs(
                step?.primaryOutline.totalLength ?? 0,
              );
              drawProgress.set(0);
            } else if (teachPhaseRef.current === "handoff") {
              // Flew back to the mouse after the last step: the walk is over. Show every step
              // at rest (full presence, backdrop faded) and resume plain following; the quiet-timeout clears the
              // drawing once the voice finishes.
              teachPhaseRef.current = "idle";
              setTeachingActive(false);
              setActiveStep(teachStepsRef.current.length);
            }
          } else if (pointPhaseRef.current === "to-target") {
            // Landed on the target and holding so the user can see where it points. A
            // flourish point traces a little randomized orbit around it (centre offset so
            // the loop starts exactly at the landing point); a calm point just rests still
            // (radius 0 = no orbit), which is most of the time.
            pointPhaseRef.current = "holding";
            pointLandedAtRef.current = now;
            holdDurationRef.current = randomBetween(
              POINT_HOLD_MIN_MS,
              POINT_HOLD_MAX_MS,
            );
            if (pointFlourishRef.current) {
              const radius = randomBetween(
                ORBIT_MIN_RADIUS_PX,
                ORBIT_MAX_RADIUS_PX,
              );
              const startAngle = randomBetween(0, Math.PI * 2);
              const direction = Math.random() < 0.5 ? -1 : 1;
              const revolutions = randomBetween(
                ORBIT_MIN_REVOLUTIONS,
                ORBIT_MAX_REVOLUTIONS,
              );
              orbitRadiusRef.current = radius;
              orbitStartAngleRef.current = startAngle;
              orbitAngularSpanRef.current =
                direction * revolutions * Math.PI * 2;
              orbitCenterRef.current = {
                x: flight.end.x - radius * Math.cos(startAngle),
                y: flight.end.y - radius * Math.sin(startAngle),
              };
            } else {
              // Calm hold: sit exactly on the target, no orbit, no spin.
              orbitRadiusRef.current = 0;
              orbitStartAngleRef.current = 0;
              orbitAngularSpanRef.current = 0;
              orbitCenterRef.current = { x: flight.end.x, y: flight.end.y };
            }
          } else if (pointPhaseRef.current === "returning") {
            // Back at the mouse: resume plain following.
            pointPhaseRef.current = "none";
          }
        }
      } else if (teachPhaseRef.current === "drawing") {
        // Tracing the active step's primary mark: the cursor rides the outline while the
        // stroke draws on to the same progress, so it reads as if the cursor drew it.
        const step = teachStepsRef.current[activeStepIndexRef.current];
        const progress =
          stepDrawDurationRef.current > 0
            ? Math.min(
                1,
                (now - stepDrawStartRef.current) / stepDrawDurationRef.current,
              )
            : 1;
        const sample = step
          ? sampleOutline(step.primaryOutline, progress)
          : null;
        x = sample ? sample.x : positionRef.current.x;
        y = sample ? sample.y : positionRef.current.y;
        scale = 1;
        targetRotation = sample
          ? sample.rotationDegrees
          : REST_ROTATION_DEGREES;
        positionRef.current = { x, y };
        drawProgress.set(progress);
        if (progress >= 1) {
          teachPhaseRef.current = "holding";
          stepHoldStartRef.current = now;
        }
      } else if (teachPhaseRef.current === "holding") {
        // The step is drawn; rest the cursor on the mark's end while the voice explains it,
        // then advance when the voice reaches the next step (or after a dwell fallback) -
        // walking to the next mark, or handing back to the mouse after the last step.
        const step = teachStepsRef.current[activeStepIndexRef.current];
        const sample = step ? sampleOutline(step.primaryOutline, 1) : null;
        x = sample ? sample.x : positionRef.current.x;
        y = sample ? sample.y : positionRef.current.y;
        scale = 1;
        targetRotation = sample
          ? sample.rotationDegrees
          : REST_ROTATION_DEGREES;
        positionRef.current = { x, y };
        const held = now - stepHoldStartRef.current;
        const captionAhead =
          pendingStepRef.current > activeStepIndexRef.current;
        const shouldAdvance =
          held > STEP_MIN_DWELL_MS ||
          (captionAhead && held > STEP_CATCHUP_MIN_MS);
        if (shouldAdvance) {
          const nextIndex = activeStepIndexRef.current + 1;
          if (nextIndex < teachStepsRef.current.length) {
            activeStepIndexRef.current = nextIndex;
            setActiveStep(nextIndex);
            drawProgress.set(0);
            flightRef.current = flightToStepStart(
              { ...positionRef.current },
              teachStepsRef.current[nextIndex]!,
              now,
            );
            teachPhaseRef.current = "advancing";
          } else {
            // Last step done: fly back to the mouse, then hand off to plain following.
            teachPhaseRef.current = "handoff";
            flightRef.current = makeFlight(
              { ...positionRef.current },
              mouseTarget,
              now,
              randomArcShaping(false),
              0,
            );
          }
        }
      } else if (pointPhaseRef.current === "holding") {
        // Resting on the pointed target. A flourish point traces a small orbit around it
        // (rotating to face the way it circles) so the hold feels alive; a calm point just
        // sits still, tip at rest. Once the answer has ended and the hold has elapsed, fly
        // back to the mouse and resume following.
        const holdProgress = Math.min(
          1,
          (now - pointLandedAtRef.current) / holdDurationRef.current,
        );
        if (orbitRadiusRef.current > 0) {
          const angle =
            orbitStartAngleRef.current +
            orbitAngularSpanRef.current * holdProgress;
          x =
            orbitCenterRef.current.x + orbitRadiusRef.current * Math.cos(angle);
          y =
            orbitCenterRef.current.y + orbitRadiusRef.current * Math.sin(angle);
          scale = 1 + ORBIT_SCALE_PULSE * Math.sin(holdProgress * Math.PI);
          // Face the direction of travel around the circle (tangent = angle + 90deg for the
          // spin direction), with the triangle's +90deg tip offset - so it visibly rotates.
          const orbitDirection = Math.sign(orbitAngularSpanRef.current) || 1;
          targetRotation =
            ((angle + (orbitDirection * Math.PI) / 2) * 180) / Math.PI + 90;
        } else {
          // Calm hold: sit exactly on the target at rest.
          x = orbitCenterRef.current.x;
          y = orbitCenterRef.current.y;
          scale = 1;
          targetRotation = REST_ROTATION_DEGREES;
        }
        positionRef.current = { x, y };
        if (
          phaseRef.current === "ending" &&
          now - pointLandedAtRef.current > holdDurationRef.current
        ) {
          const returnFlourish = pointFlourishRef.current;
          flightRef.current = makeFlight(
            positionRef.current,
            mouseTarget,
            now,
            randomArcShaping(returnFlourish),
            randomSpinDegrees(returnFlourish),
          );
          pointPhaseRef.current = "returning";
        }
      } else {
        // Plain following: chase the real mouse with a damped spring (v1's lively,
        // slightly-overshooting `.spring(response: 0.2, dampingFraction: 0.6)` feel)
        // rather than a flat lerp, so the buddy has momentum and settles naturally.
        const horizontal = springStep(
          { position: positionRef.current.x, velocity: velocityRef.current.x },
          mouseTarget.x,
          FOLLOW_SPRING_RESPONSE_SECONDS,
          FOLLOW_SPRING_DAMPING_FRACTION,
          elapsedSeconds,
        );
        const vertical = springStep(
          { position: positionRef.current.y, velocity: velocityRef.current.y },
          mouseTarget.y,
          FOLLOW_SPRING_RESPONSE_SECONDS,
          FOLLOW_SPRING_DAMPING_FRACTION,
          elapsedSeconds,
        );
        positionRef.current = { x: horizontal.position, y: vertical.position };
        velocityRef.current = { x: horizontal.velocity, y: vertical.velocity };
        x = horizontal.position;
        y = vertical.position;
        scale = 1;
        targetRotation = REST_ROTATION_DEGREES;
      }

      // Ease rotation toward its target so the tip turns smoothly rather than snapping,
      // by a fraction derived from elapsed time so the ease is frame-rate independent.
      const rotationEaseFraction =
        1 - Math.exp(-elapsedSeconds / ROTATION_EASE_TIME_CONSTANT_SECONDS);
      rotationRef.current +=
        (targetRotation - rotationRef.current) * rotationEaseFraction;
      setCursorFrame({ x, y, rotationDegrees: rotationRef.current, scale });

      // Draw the buddy when the cursor is on this display, or an interaction / pointing
      // flight is running on it; otherwise this display shows nothing. The caption is
      // deliberately NOT a trigger here: it is broadcast to every display, so keying
      // visibility on it would light the buddy on all monitors at once. Instead the
      // caption keeps the *active* window alive by blocking its inactivity clear below
      // (so its phase stays non-idle through the spoken reply), and the container's
      // opacity gates it to the one display that already has the cursor / interaction.
      const interactionActive =
        phaseRef.current !== "idle" ||
        listeningRef.current ||
        thinkingRef.current ||
        flightRef.current !== null ||
        pointPhaseRef.current !== "none" ||
        // A teaching walk draws its cursor even on a second monitor with no mouse of its own.
        teachPhaseRef.current !== "idle";
      setShowBuddy(cursorPresentRef.current || interactionActive);

      // Once an answer has ended, any pointing has returned, AND the voice has finished
      // (no caption left), clear the bubble after a beat so it doesn't linger beside the
      // following cursor - then it is plain following again (the window itself stays shown).
      if (
        phaseRef.current === "ending" &&
        pointPhaseRef.current === "none" &&
        flightRef.current === null &&
        captionRef.current === null &&
        now - lastActivityRef.current > INACTIVITY_CLEAR_MS
      ) {
        // Guard against re-entry before the store's phase change propagates back to the ref.
        phaseRef.current = "idle";
        reset();
      }

      // Clear a teaching drawing once the turn has gone quiet. This is deliberately
      // independent of the buddy's phase above: a drawing on a second monitor runs no
      // answer or pointing of its own, so that window never enters "ending" and its
      // `reset` never fires - but it still received the broadcast caption, so gating on the
      // caption (plus a linger) clears it in step with the spoken explanation everywhere. A
      // next turn or Barge-in clears it sooner via the `clear-shapes` event.
      if (
        shapesPresentRef.current &&
        // A teaching walk owns its drawing's lifecycle; never clear mid-walk (the walk hands
        // off explicitly, and the hard cap above guarantees it eventually does).
        teachPhaseRef.current === "idle" &&
        captionRef.current === null &&
        now - lastActivityRef.current > SHAPE_INACTIVITY_CLEAR_MS
      ) {
        // Guard against re-entry until the store update propagates back to the ref.
        shapesPresentRef.current = false;
        clearShapes();
      }

      // The cursor-riding intro video (M3-03): while the welcome step is up and the cursor
      // is on this display, glide the card toward its placement beside the pointer (clear of
      // the wizard) with the calm, heavier card spring. It rides only the display the cursor
      // is on - exactly like the buddy - so the card follows across monitors. Seeded onto its
      // target on activation and on cursor re-entry so it appears in place, not sliding in.
      if (introVideoActiveRef.current && cursorPresentRef.current) {
        const target = computeIntroCardTarget({
          cursor: cursorLocalRef.current,
          cardSize: INTRO_CARD_SIZE,
          displaySize: { width: window.innerWidth, height: window.innerHeight },
          avoidRect: introVideoAvoidRectRef.current,
          gap: INTRO_CARD_GAP_PX,
          margin: INTRO_CARD_MARGIN_PX,
        });
        if (!introCardSeededRef.current) {
          introCardPositionRef.current = target;
          introCardVelocityRef.current = { x: 0, y: 0 };
          introCardSeededRef.current = true;
        } else {
          const horizontal = springStep(
            {
              position: introCardPositionRef.current.x,
              velocity: introCardVelocityRef.current.x,
            },
            target.x,
            INTRO_CARD_SPRING_RESPONSE_SECONDS,
            INTRO_CARD_SPRING_DAMPING_FRACTION,
            elapsedSeconds,
          );
          const vertical = springStep(
            {
              position: introCardPositionRef.current.y,
              velocity: introCardVelocityRef.current.y,
            },
            target.y,
            INTRO_CARD_SPRING_RESPONSE_SECONDS,
            INTRO_CARD_SPRING_DAMPING_FRACTION,
            elapsedSeconds,
          );
          introCardPositionRef.current = {
            x: horizontal.position,
            y: vertical.position,
          };
          introCardVelocityRef.current = {
            x: horizontal.velocity,
            y: vertical.velocity,
          };
        }
        setIntroCardPosition({
          x: introCardPositionRef.current.x,
          y: introCardPositionRef.current.y,
        });
        setShowIntroCard(true);
      } else {
        // Inactive, or the cursor left for another display: hide here and re-seed so the
        // card snaps back into place if the cursor returns (this window's card unmounts and
        // the display the cursor moved to shows it instead).
        introCardSeededRef.current = false;
        setShowIntroCard(false);
      }

      rafId = requestAnimationFrame(renderFrame);
    };

    rafId = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(rafId);
  }, [reset, clearShapes]);

  // The listening waveform and thinking spinner sit right at the real mouse point, not at
  // the buddy's offset spot beside it (the triangle sits offset so its tip hugs the cursor;
  // a centred ring/waveform there would read as floating far from the cursor). Undo the
  // buddy offset so they centre exactly where the mouse is.
  const cursorAtMouse: CursorFrame = {
    ...cursorFrame,
    x: cursorFrame.x - BUDDY_OFFSET_X,
    y: cursorFrame.y - BUDDY_OFFSET_Y,
  };

  // The teaching steps this drawing groups into (empty for a plain, unstepped drawing). The
  // RAF loop drives the walk via `teachStepsRef`; this is the render-time copy the shape
  // layer, backdrop, and step badges read - both derive from the same pure grouping.
  const steps = useMemo(() => groupTeachingSteps(shapes), [shapes]);

  return (
    <>
      {/* The teaching drawings sit in their own click-through layer, beneath the buddy, so
          they coexist with the cursor and the response bubble and follow their own draw /
          clear lifecycle rather than the buddy's fade. Always mounted; renders nothing when
          there is no drawing. A stepped drawing renders as a guided walk (soft backdrop +
          one step at a time); a plain drawing renders all its marks at once. */}
      <ShapeLayer
        shapes={shapes}
        generation={shapesGeneration}
        steps={steps}
        activeStepIndex={activeStepIndex}
        teachingActive={teachingActive}
        drawProgress={drawProgress}
      />
      {/* The step guide (M3-04): a numbered instruction chip above the active step's marks
          while a guided walk runs. Click-through, above the drawing layer, below the buddy. */}
      <StepGuide
        steps={steps}
        activeStepIndex={activeStepIndex}
        teachingActive={teachingActive}
      />
      {/* The cursor-riding intro video (M3-03) sits in its own click-through layer, mounted
          only while it is drawn on this display so its clip (and audio) plays on the one
          window the cursor is on, never on every monitor at once. */}
      <AnimatePresence>
        {showIntroCard && (
          <IntroVideoCard key="intro-video" position={introCardPosition} />
        )}
      </AnimatePresence>
      <motion.div
        className="pointer-events-none fixed inset-0 overflow-hidden"
        animate={{ opacity: showBuddy ? 1 : 0 }}
        transition={{ duration: BUDDY_FADE_S, ease: "easeOut" }}
      >
        {listening ? (
          <ListeningWaveform level={listeningLevel} anchor={cursorAtMouse} />
        ) : thinking ? (
          // Transcribing + reasoning: the spinner replaces the triangle right at the mouse
          // (like v1's processing state) so the user sees Lune is working, not stalled.
          <ProcessingSpinner anchor={cursorAtMouse} />
        ) : (
          <>
            <PlayfulCursor frame={cursorFrame} />
            {/* The spoken reply, revealed word by word in step with the voice - the same
                reveal the Pill shows, mirrored here beside the mouse (mirrors pillStore). */}
            {caption !== null && (
              <CaptionBubble caption={caption} anchor={cursorFrame} />
            )}
          </>
        )}
      </motion.div>
    </>
  );
}

/** The fixed line width (px) the cursor caption fills before it clears (see CaptionReveal). */
const OVERLAY_CAPTION_WIDTH_PX = 260;

/** The gap between the cursor and the caption chip, in pixels. */
const CAPTION_GAP_PX = 14;
/** The chip's full width (text line + horizontal padding), used to decide which side fits. */
const CAPTION_BUBBLE_WIDTH_PX = OVERLAY_CAPTION_WIDTH_PX + 24;
/** A rough chip height used only to decide whether to flip above the cursor near the bottom. */
const CAPTION_EST_HEIGHT_PX = 40;

/**
 * The spoken reply shown just beside the following cursor, revealed word by word in step
 * with the voice (this is now the only place the reply text appears - the Pill just shows
 * the waveform). A compact chip that fills one fixed-width line book-style, sitting close
 * to the cursor. It is screen-aware: it flips to whichever side has room - left of the
 * cursor near the right edge, above it near the bottom - so it never runs off-screen or
 * covers the cursor. Anchoring by the near edge (right/bottom when flipped) keeps it placed
 * correctly whatever the wrapped text height. Keyed on the sentence id so a new sentence
 * restarts the reveal.
 */
function CaptionBubble({
  caption,
  anchor,
}: {
  caption: CaptionData;
  anchor: CursorFrame;
}) {
  // Flip to the side with room: left when the chip would overflow the right edge, above
  // when it would overflow the bottom. The everyday case (cursor mid-screen) stays
  // down-and-right of the cursor, as before.
  const placeLeft =
    anchor.x + CAPTION_GAP_PX + CAPTION_BUBBLE_WIDTH_PX > window.innerWidth;
  const placeAbove =
    anchor.y + CAPTION_GAP_PX + CAPTION_EST_HEIGHT_PX > window.innerHeight;

  // Anchor by the near edge on the flipped axis so the chip grows away from the cursor and
  // stays on-screen regardless of its rendered size; a final max() keeps it off the edge.
  const horizontal = placeLeft
    ? { right: Math.max(6, window.innerWidth - (anchor.x - CAPTION_GAP_PX)) }
    : { left: Math.max(6, anchor.x + CAPTION_GAP_PX) };
  const vertical = placeAbove
    ? { bottom: Math.max(6, window.innerHeight - (anchor.y - CAPTION_GAP_PX)) }
    : { top: Math.max(6, anchor.y + CAPTION_GAP_PX) };

  return (
    <motion.div
      className="absolute rounded-full bg-neutral-950/95 px-2.5 py-1 shadow-lg shadow-black/50"
      style={{ ...horizontal, ...vertical }}
      // Slide in from the cursor's side (toward where the chip sits) for a natural feel.
      initial={{ opacity: 0, x: placeLeft ? 6 : -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
    >
      <CaptionReveal
        key={caption.id}
        caption={caption}
        variant={{
          maxWidthPx: OVERLAY_CAPTION_WIDTH_PX,
          textClassName: "text-[13px] leading-none text-neutral-100",
        }}
      />
    </motion.div>
  );
}

/** The number of bars in the listening waveform. */
const WAVEFORM_BAR_COUNT = 5;

/**
 * The live recording waveform shown at the cursor while push-to-talk is held (ticket 11,
 * user story 18). A small row of bars whose heights ride the mic level, with a gentle
 * per-bar phase offset so it reads as alive rather than a flat meter. Purely presentational
 * - the level arrives from the Pill's mic capture over IPC via the store, and it rides the
 * following cursor's position so it appears right where the mouse is.
 */
function ListeningWaveform({
  level,
  anchor,
}: {
  level: number;
  anchor: CursorFrame;
}) {
  return (
    <div
      className="absolute flex items-center gap-1"
      style={{
        left: anchor.x,
        top: anchor.y,
        transform: "translate(-50%, -50%)",
      }}
    >
      {Array.from({ length: WAVEFORM_BAR_COUNT }, (_, barIndex) => {
        // Center bars react a touch more than the edges, so the shape feels voice-like.
        const distanceFromCenter = Math.abs(
          barIndex - (WAVEFORM_BAR_COUNT - 1) / 2,
        );
        const emphasis = 1 - distanceFromCenter / WAVEFORM_BAR_COUNT;
        const height = 4 + level * 22 * (0.5 + emphasis);
        return (
          <motion.span
            key={barIndex}
            className="w-1 rounded-full bg-emerald-400"
            style={{ boxShadow: "0 0 6px rgba(52, 211, 153, 0.9)" }}
            animate={{ height }}
            transition={{ type: "spring", stiffness: 500, damping: 24 }}
          />
        );
      })}
    </div>
  );
}

/**
 * The loading spinner shown at the cursor while Lune transcribes + reasons, before any
 * answer streams (v1's `BlueCursorSpinnerView` processing state). A ~70% ring arc rotating
 * steadily, popped in with a small scale so it reads as "working" rather than "stalled".
 */
function ProcessingSpinner({ anchor }: { anchor: CursorFrame }) {
  const radius = 6.5;
  const circumference = 2 * Math.PI * radius;
  return (
    <motion.div
      className="absolute"
      style={{
        left: anchor.x,
        top: anchor.y,
        transform: "translate(-50%, -50%)",
        filter: "drop-shadow(0 0 6px rgba(129, 140, 248, 0.9))",
      }}
      initial={{ opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      <motion.svg
        width="18"
        height="18"
        viewBox="0 0 18 18"
        aria-hidden
        animate={{ rotate: 360 }}
        transition={{ duration: 0.8, ease: "linear", repeat: Infinity }}
      >
        <defs>
          {/* A fade from transparent to solid around the arc, so it reads as spinning. */}
          <linearGradient
            id="lune-spinner-gradient"
            x1="0"
            y1="0"
            x2="1"
            y2="1"
          >
            <stop offset="0%" stopColor="#a5b4fc" stopOpacity="0" />
            <stop offset="100%" stopColor="#a5b4fc" stopOpacity="1" />
          </linearGradient>
        </defs>
        <circle
          cx="9"
          cy="9"
          r={radius}
          fill="none"
          stroke="url(#lune-spinner-gradient)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${circumference * 0.7} ${circumference}`}
        />
      </motion.svg>
    </motion.div>
  );
}

/**
 * The teaching palette default - the same emerald green as the listening waveform, so a
 * drawing reads as clearly "Lune's" and pops against most app UIs. The model can override
 * it per shape.
 */
const DEFAULT_SHAPE_COLOR = "#34d399";
/** A clean, confident stroke: bold enough to read as a hand-drawn highlight, not a hairline. */
const SHAPE_STROKE_WIDTH = 2.5;
/** The default focus dash - a medium dashed line, like a hand-drawn box around a thing. */
const FOCUS_DASH = "9 7";
/** Explicit model stroke patterns (a finer dotted, or the same dashed as the default). */
const DOTTED_DASH = "2 7";
const DASHED_DASH = "9 7";
/** How much a focus box/circle is inflated past the element's bounds so it frames, not clips. */
const RECT_CORNER_RADIUS = 10;
/** Earlier, already-walked steps fade back to this opacity so the active step stands out. */
const DONE_STEP_OPACITY = 0.4;
/** A finished walk shows every step at rest, clearly but a touch under full. */
const RESTING_STEP_OPACITY = 0.9;
/**
 * The step backdrop's tint strength: a light wash of the drawing's own color behind the
 * marks, so the area being explained lifts gently off the page. Deliberately subtle -
 * the screen underneath must stay fully readable (no full-screen dimming, ever).
 */
const BACKDROP_FILL_OPACITY = 0.14;
/** The backdrop patch's corner rounding and edge feather (a soft glow, not a hard card). */
const BACKDROP_RX = 16;
const BACKDROP_FEATHER_STD = 10;
/**
 * A plain (unstepped) drawing also gets the soft backdrop behind its marks, but only when
 * the drawing is compact - a patch behind a screen-spanning arrow would tint half the
 * display, which is exactly the heavy-handedness the backdrop replaced.
 */
const BACKDROP_MAX_AREA_FRACTION = 0.25;

/** The dash pattern for a stroke style, or undefined for a solid stroke. */
function strokeDashArray(
  stroke: OverlayShape["style"]["stroke"],
): string | undefined {
  if (stroke === "dotted") {
    return DOTTED_DASH;
  }
  if (stroke === "dashed") {
    return DASHED_DASH;
  }
  return undefined;
}

/** A soft glow so a stroke reads as a glowing highlight without a heavy halo. */
function shapeGlow(color: string): string {
  return `drop-shadow(0 0 3px ${color})`;
}

/** The axis-aligned box (window-local px) between a two-point shape's corners. */
function rectFromPoints(
  a: OverlayShape["points"][number],
  b: OverlayShape["points"][number],
) {
  return {
    x: Math.min(a.localX, b.localX),
    y: Math.min(a.localY, b.localY),
    width: Math.abs(b.localX - a.localX),
    height: Math.abs(b.localY - a.localY),
  };
}

/** The SVG path `d` for a shape's outline (circle ring, corner-bracket rect, polygon, ...). */
function markPathData(shape: OverlayShape): string {
  return outlineToPathData(buildOutline(toTraceable(shape)));
}

/**
 * The teaching-drawing layer: a full-window, click-through SVG (M3-04). Every non-empty
 * drawing renders as a guided walk (an unstepped drawing becomes one synthetic step in
 * `groupTeachingSteps`) - a soft, lightly-tinted backdrop patch sits behind the active
 * step's marks (the rest of the screen is never dimmed), and each step's marks reveal in
 * order (earlier ones faded back, the active step's primary drawn on under the cursor via
 * the shared `drawProgress` clock). The unstepped branch below remains only as a defensive
 * fallback should a drawing ever arrive without steps. Keyed by generation so a fresh
 * drawing remounts and replays its animation.
 */
function ShapeLayer({
  shapes,
  generation,
  steps,
  activeStepIndex,
  teachingActive,
  drawProgress,
}: {
  shapes: OverlayShape[];
  generation: number;
  steps: TeachStep[];
  activeStepIndex: number;
  teachingActive: boolean;
  drawProgress: MotionValue<number>;
}) {
  const isTeaching = steps.length > 0;
  const activeStep = teachingActive ? steps[activeStepIndex] : undefined;

  // The soft backdrop patch: behind the active step's marks during a walk, or behind a
  // compact plain drawing's marks - tinted with the drawing's own color. `null` means no
  // patch (nothing drawn, a finished walk, or a drawing too large to tastefully back).
  let backdropBounds: TraceBounds | null = null;
  let backdropColor = DEFAULT_SHAPE_COLOR;
  if (isTeaching) {
    if (activeStep !== undefined) {
      backdropBounds = activeStep.bounds;
      backdropColor = activeStep.shapes[0]?.style.color ?? DEFAULT_SHAPE_COLOR;
    }
  } else if (shapes.length > 0) {
    const wholeDrawingBounds = shapesBounds(
      shapes.map(toTraceable),
      STEP_BOUNDS_PADDING,
    );
    if (wholeDrawingBounds !== null) {
      const areaFraction =
        (wholeDrawingBounds.width * wholeDrawingBounds.height) /
        (window.innerWidth * window.innerHeight);
      if (areaFraction <= BACKDROP_MAX_AREA_FRACTION) {
        backdropBounds = wholeDrawingBounds;
        backdropColor = shapes[0]?.style.color ?? DEFAULT_SHAPE_COLOR;
      }
    }
  }

  // The teaching marks: the active step's primary is drawn by a single, stable-keyed pen that
  // glides between steps (so resetting the shared `drawProgress` clock never briefly rebinds a
  // stale step); every other visible mark is a resting focus ring. A pending step (not yet
  // walked) shows nothing; earlier steps fade back.
  const teachingMarks: ReactElement[] = [];
  if (isTeaching) {
    if (activeStep !== undefined) {
      teachingMarks.push(
        <PenTrace
          key={`${generation}-pen`}
          shape={activeStep.shapes[0]!}
          outline={activeStep.primaryOutline}
          drawProgress={drawProgress}
        />,
      );
    }
    steps.forEach((step, stepIndex) => {
      if (teachingActive && stepIndex > activeStepIndex) {
        return;
      }
      const isActive = teachingActive && stepIndex === activeStepIndex;
      const opacity = isActive
        ? 1
        : teachingActive
          ? DONE_STEP_OPACITY
          : RESTING_STEP_OPACITY;
      step.shapes.forEach((shape, shapeIndex) => {
        // The active step's primary is drawn by the shared pen above; skip its resting ring.
        if (isActive && shapeIndex === 0) {
          return;
        }
        teachingMarks.push(
          <StaticMark
            key={`${generation}-mark-${stepIndex}-${shapeIndex}`}
            shape={shape}
            opacity={opacity}
          />,
        );
      });
    });
  }

  return (
    <svg
      className="pointer-events-none fixed inset-0 h-full w-full overflow-visible"
      aria-hidden
    >
      <ShapeBackdrop
        key={`backdrop-${generation}`}
        bounds={backdropBounds}
        color={backdropColor}
        generation={generation}
      />
      <AnimatePresence>
        {isTeaching
          ? teachingMarks
          : shapes.map((shape, index) => (
              <StaticMark
                key={`${generation}-${index}`}
                shape={shape}
                opacity={1}
              />
            ))}
      </AnimatePresence>
    </svg>
  );
}

/**
 * The active step's primary mark, drawn on under the cursor: a solid path whose `pathLength`
 * is bound to the shared `drawProgress` clock, so the stroke appears exactly as fast as the
 * cursor rides its outline. One stable-keyed instance glides between steps (its `d` swaps to
 * the new step's outline as `drawProgress` restarts), and it exit-fades when the walk ends.
 */
function PenTrace({
  shape,
  outline,
  drawProgress,
}: {
  shape: OverlayShape;
  outline: ShapeOutline;
  drawProgress: MotionValue<number>;
}) {
  const color = shape.style.color ?? DEFAULT_SHAPE_COLOR;
  // The pen mounts while the cursor is still flying toward the mark, and a round-capped
  // path at pathLength 0 still paints a dot at the outline's start - so the stroke stays
  // hidden until the pen touches down (see penTraceVisibility).
  const visibility = useTransform(drawProgress, penTraceVisibility);
  return (
    <motion.path
      d={outlineToPathData(outline)}
      fill="none"
      stroke={color}
      strokeWidth={SHAPE_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ pathLength: drawProgress, visibility, filter: shapeGlow(color) }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ opacity: { duration: 0.2 } }}
    />
  );
}

/**
 * A resting mark: the full outline shown at once as a thin, precise focus ring (dotted by
 * default for the closed focus shapes, so it reads as "look here" rather than a heavy box).
 * Used for a plain drawing's marks, a step's supporting marks, and every mark once its step
 * has been walked. Fades/pops in and fades out when cleared.
 */
function StaticMark({
  shape,
  opacity,
}: {
  shape: OverlayShape;
  opacity: number;
}) {
  const color = shape.style.color ?? DEFAULT_SHAPE_COLOR;
  const isHighlight = shape.kind === "highlight";
  const filled = shape.style.filled || isHighlight;
  const isFocusRing =
    shape.kind === "circle" ||
    shape.kind === "rect" ||
    shape.kind === "polygon";
  // Closed focus shapes default to a dashed box/ring (the reference-diagram look); lines and
  // arrows stay solid unless the model asked otherwise, so an arrow isn't turned into dots.
  const dash =
    strokeDashArray(shape.style.stroke) ??
    (isFocusRing ? FOCUS_DASH : undefined);

  // Shared stroke/fill + a quick pop-in that all the primitives below use.
  const common = {
    fill: filled ? color : "none",
    fillOpacity: filled ? (isHighlight ? 0.18 : 0.12) : undefined,
    stroke: isHighlight ? "none" : color,
    strokeWidth: SHAPE_STROKE_WIDTH,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeDasharray: dash,
    initial: { opacity: 0, scale: 0.92 },
    animate: { opacity, scale: 1 },
    exit: { opacity: 0 },
    transition: {
      scale: { type: "spring" as const, stiffness: 300, damping: 24 },
      opacity: { duration: 0.25 },
    },
    style: {
      filter: shapeGlow(color),
      transformBox: "fill-box" as const,
      transformOrigin: "center" as const,
    },
  };

  if (shape.kind === "circle") {
    const center = shape.points[0];
    if (center === undefined) {
      return null;
    }
    return (
      <motion.circle
        {...common}
        cx={center.localX}
        cy={center.localY}
        r={shape.radius ?? 0}
      />
    );
  }

  if (shape.kind === "polygon") {
    if (shape.points.length < 3) {
      return null;
    }
    const points = shape.points
      .map((point) => `${point.localX},${point.localY}`)
      .join(" ");
    return <motion.polygon {...common} points={points} />;
  }

  const [start, end] = shape.points;
  if (start === undefined || end === undefined) {
    return null;
  }

  if (shape.kind === "rect" || isHighlight) {
    const box = rectFromPoints(start, end);
    return (
      <motion.rect
        {...common}
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        rx={RECT_CORNER_RADIUS}
      />
    );
  }

  if (shape.kind === "arrow") {
    // The arrow's shaft + head as a path (reuses the tracer's arrow geometry).
    return <motion.path {...common} d={markPathData(shape)} />;
  }

  // line
  return (
    <motion.line
      {...common}
      x1={start.localX}
      y1={start.localY}
      x2={end.localX}
      y2={end.localY}
    />
  );
}

/**
 * The soft backdrop behind the marks (the successor of the full-screen spotlight dim,
 * which darkened everything but the active step and made the whole screen feel heavy).
 * Instead, a feathered patch lightly tinted with the drawing's own color sits just under
 * the marks - the area being explained glows gently, and the rest of the screen is left
 * exactly as it is. It springs (position + size) between steps like the marks do, fades
 * out in place when there is nothing left to back, and is remounted per drawing
 * (generation-keyed by the caller) so a fresh drawing fades in at its spot rather than
 * flying in from the previous drawing's.
 */
function ShapeBackdrop({
  bounds,
  color,
  generation,
}: {
  bounds: TraceBounds | null;
  color: string;
  generation: number;
}) {
  const blurId = `lune-backdrop-blur-${generation}`;
  // When the bounds clear (walk finished, drawing cleared), keep the last patch in place
  // and only fade - springing the rect off-screen mid-fade would read as it flying away.
  const lastBoundsRef = useRef<TraceBounds | null>(bounds);
  if (bounds !== null) {
    lastBoundsRef.current = bounds;
  }
  const patch = bounds ?? lastBoundsRef.current;
  if (patch === null) {
    return null;
  }
  return (
    <>
      <defs>
        <filter id={blurId} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={BACKDROP_FEATHER_STD} />
        </filter>
      </defs>
      <motion.rect
        fill={color}
        filter={`url(#${blurId})`}
        rx={BACKDROP_RX}
        initial={{ opacity: 0 }}
        animate={{
          x: patch.x,
          y: patch.y,
          width: patch.width,
          height: patch.height,
          opacity: bounds !== null ? BACKDROP_FILL_OPACITY : 0,
        }}
        transition={{
          type: "spring",
          stiffness: 210,
          damping: 30,
          opacity: { duration: 0.3 },
        }}
      />
    </>
  );
}

/**
 * The step guide (M3-04): a small numbered chip with the step's short instruction, shown just
 * above the active step's marks while a guided walk is in progress. Purely presentational and
 * click-through; it re-keys per step so it slides in fresh as the walk advances.
 */
function StepGuide({
  steps,
  activeStepIndex,
  teachingActive,
}: {
  steps: TeachStep[];
  activeStepIndex: number;
  teachingActive: boolean;
}) {
  if (!teachingActive) {
    return null;
  }
  const step = steps[activeStepIndex];
  if (step === undefined || step.bounds === null) {
    return null;
  }
  // A single-step walk (a plain drawing given the guided treatment) isn't a numbered
  // sequence: show just the label, and nothing at all when there's no label to show.
  const isSequence = steps.length > 1;
  if (!isSequence && step.label.length === 0) {
    return null;
  }
  const top = Math.max(8, step.bounds.y - 44);
  const left = Math.max(8, Math.min(step.bounds.x, window.innerWidth - 280));
  return (
    <div className="pointer-events-none fixed inset-0">
      <motion.div
        key={`step-${activeStepIndex}`}
        className={`absolute flex items-center gap-2 rounded-full bg-neutral-950/90 py-1 ${isSequence ? "pl-1" : "pl-3"} pr-3 shadow-lg shadow-black/50 ring-1 ring-white/10`}
        style={{ left, top }}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: "easeOut" }}
      >
        {isSequence && (
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-400 text-xs font-semibold text-neutral-950">
            {step.stepNumber}
          </span>
        )}
        <span className="text-[13px] font-medium text-neutral-100">
          {step.label.length > 0 ? step.label : `Step ${step.stepNumber}`}
        </span>
        {isSequence && (
          <span className="ml-1 text-[11px] text-neutral-500">
            {step.stepNumber} / {steps.length}
          </span>
        )}
      </motion.div>
    </div>
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

/**
 * The cursor-riding intro video card (M3-03): a ~400x600 card that rides alongside the
 * pointer through the onboarding welcome step, introducing Lune. It is positioned by the
 * RAF loop's spring (so it trails the cursor smoothly) and lives in the click-through
 * Overlay window, so it can never block the wizard's controls; the placement math keeps it
 * from covering the wizard either. It fades/pops in when it appears and out when the step
 * advances, is skipped, or the cursor crosses to another display. The real clip drops in at
 * {@link introVideoUrl}; until then a branded animated placeholder stands in.
 */
function IntroVideoCard({ position }: { position: Point2D }) {
  return (
    <motion.div
      className="pointer-events-none fixed"
      style={{
        left: position.x,
        top: position.y,
        width: INTRO_CARD_SIZE.width,
        height: INTRO_CARD_SIZE.height,
      }}
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: INTRO_CARD_FADE_S, ease: "easeOut" }}
    >
      <div className="h-full w-full overflow-hidden rounded-3xl border border-white/10 bg-neutral-950/90 shadow-2xl shadow-black/60 backdrop-blur-md">
        {introVideoUrl !== null ? (
          // The Overlay window sets `autoplayPolicy: no-user-gesture-required`, so the clip
          // plays with sound the moment it mounts (the card mounts only on the cursor's
          // display, so audio never doubles across monitors).
          <video
            src={introVideoUrl}
            autoPlay
            playsInline
            className="h-full w-full object-cover"
          />
        ) : (
          <IntroVideoPlaceholder />
        )}
      </div>
    </motion.div>
  );
}

/**
 * The branded stand-in shown until a real intro clip is dropped in at {@link introVideoUrl}.
 * A dark card with a softly pulsing aurora behind a floating moon, a one-line welcome, and a
 * gentle equalizer so it reads as "Lune, speaking" - the same sky/violet language as the
 * onboarding welcome step, so the card feels of a piece with the wizard beside it.
 */
function IntroVideoPlaceholder() {
  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center gap-6 bg-gradient-to-b from-neutral-900 to-neutral-950 px-8 text-center">
      <motion.div
        aria-hidden
        className="absolute left-1/2 top-[36%] h-56 w-56 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-br from-sky-400/30 to-violet-500/30 blur-3xl"
        animate={{ opacity: [0.5, 0.85, 0.5], scale: [1, 1.08, 1] }}
        transition={{ duration: 4.5, ease: "easeInOut", repeat: Infinity }}
      />
      <motion.div
        className="flex h-24 w-24 items-center justify-center rounded-[2rem] bg-gradient-to-br from-sky-400/30 to-violet-500/30 text-5xl"
        animate={{ y: [0, -6, 0] }}
        transition={{ duration: 5, ease: "easeInOut", repeat: Infinity }}
      >
        🌙
      </motion.div>
      <div className="relative">
        <h2 className="text-lg font-semibold text-neutral-50">Meet Lune</h2>
        <p className="mt-2 max-w-[15rem] text-xs leading-relaxed text-neutral-400">
          Your on-screen companion. I'll follow along, answer out loud, and
          point at what I mean.
        </p>
      </div>
      <div className="relative flex items-end gap-1">
        {[0, 1, 2, 3, 4].map((bar) => (
          <motion.span
            key={bar}
            className="w-1 rounded-full bg-gradient-to-t from-sky-400 to-violet-400"
            animate={{ height: [6, 18, 6] }}
            transition={{
              duration: 1.1,
              ease: "easeInOut",
              repeat: Infinity,
              delay: bar * 0.12,
            }}
          />
        ))}
      </div>
    </div>
  );
}
