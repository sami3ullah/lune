import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useOverlayStore } from "./overlayStore";
import { CaptionReveal } from "./CaptionReveal";
import type { CaptionData } from "./caption";
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
const BUDDY_OFFSET_X = 20;
const BUDDY_OFFSET_Y = -4;
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
const POINT_HOLD_MIN_MS = 1200;
const POINT_HOLD_MAX_MS = 2100;
/** The little orbit the cursor traces around the target while holding (the "goes around"). */
const ORBIT_MIN_RADIUS_PX = 8;
const ORBIT_MAX_RADIUS_PX = 22;
/** How many loops it makes around the target across the hold (randomized direction). */
const ORBIT_MIN_REVOLUTIONS = 0.75;
const ORBIT_MAX_REVOLUTIONS = 1.6;
/** A gentle size pulse while orbiting, so the hold breathes rather than sitting frozen. */
const ORBIT_SCALE_PULSE = 0.08;
/** How long after an answer ends the bubble lingers before clearing (then plain following). */
const INACTIVITY_CLEAR_MS = 1100;
/** How quickly the buddy fades in/out as the cursor enters/leaves this display. */
const BUDDY_FADE_S = 0.25;

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
 * How often a pointing flight gets the showy "flourish" - a pronounced curve, a twirl,
 * and a little orbit around the target. The rest of the time it's a calm arc-and-hold, so
 * the cursor mostly moves gently and only occasionally shows off (kept unpredictable).
 */
const FLOURISH_PROBABILITY = 0.35;

/**
 * A fresh, randomized arc shape for one flight. A `flourish` flight bows boldly (sometimes
 * the "wrong" way) with a varied crest; a calm flight bows gently upward with only slight
 * variation, so the everyday movement is smooth and unshowy.
 */
function randomArcShaping(flourish: boolean): ArcShaping {
  if (!flourish) {
    return { perpendicular: -randomBetween(0.7, 1.1), lateral: randomBetween(-0.2, 0.2) };
  }
  const bowsUp = Math.random() < 0.7;
  return {
    perpendicular: (bowsUp ? -1 : 1) * randomBetween(0.7, 1.7),
    lateral: randomBetween(-0.6, 0.6),
  };
}

/** A random extra twirl (degrees) for a flourish flight; calm flights don't twirl at all. */
function randomSpinDegrees(flourish: boolean): number {
  if (!flourish) {
    return 0;
  }
  return (Math.random() < 0.5 ? -1 : 1) * randomBetween(90, 240);
}

/** Smoothstep easing on `[0,1]`, so a layered twirl accelerates in and settles out. */
function smoothstep(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped * clamped * (3 - 2 * clamped);
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

  const [showBuddy, setShowBuddy] = useState(false);
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
          setPointTarget({
            x: event.point.localX,
            y: event.point.localY,
            label: event.point.label,
          });
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
        targetRotation = frame.rotationDegrees + flight.spinDegrees * smoothstep(progress);
        if (progress >= 1) {
          positionRef.current = { x: flight.end.x, y: flight.end.y };
          // Hand back to the follow spring from rest so it eases onto the mouse cleanly.
          velocityRef.current = { x: 0, y: 0 };
          flightRef.current = null;
          if (pointPhaseRef.current === "to-target") {
            // Landed on the target and holding so the user can see where it points. A
            // flourish point traces a little randomized orbit around it (centre offset so
            // the loop starts exactly at the landing point); a calm point just rests still
            // (radius 0 = no orbit), which is most of the time.
            pointPhaseRef.current = "holding";
            pointLandedAtRef.current = now;
            holdDurationRef.current = randomBetween(POINT_HOLD_MIN_MS, POINT_HOLD_MAX_MS);
            if (pointFlourishRef.current) {
              const radius = randomBetween(ORBIT_MIN_RADIUS_PX, ORBIT_MAX_RADIUS_PX);
              const startAngle = randomBetween(0, Math.PI * 2);
              const direction = Math.random() < 0.5 ? -1 : 1;
              const revolutions = randomBetween(ORBIT_MIN_REVOLUTIONS, ORBIT_MAX_REVOLUTIONS);
              orbitRadiusRef.current = radius;
              orbitStartAngleRef.current = startAngle;
              orbitAngularSpanRef.current = direction * revolutions * Math.PI * 2;
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
      } else if (pointPhaseRef.current === "holding") {
        // Resting on the pointed target. A flourish point traces a small orbit around it
        // (rotating to face the way it circles) so the hold feels alive; a calm point just
        // sits still, tip at rest. Once the answer has ended and the hold has elapsed, fly
        // back to the mouse and resume following.
        const holdProgress = Math.min(1, (now - pointLandedAtRef.current) / holdDurationRef.current);
        if (orbitRadiusRef.current > 0) {
          const angle = orbitStartAngleRef.current + orbitAngularSpanRef.current * holdProgress;
          x = orbitCenterRef.current.x + orbitRadiusRef.current * Math.cos(angle);
          y = orbitCenterRef.current.y + orbitRadiusRef.current * Math.sin(angle);
          scale = 1 + ORBIT_SCALE_PULSE * Math.sin(holdProgress * Math.PI);
          // Face the direction of travel around the circle (tangent = angle + 90deg for the
          // spin direction), with the triangle's +90deg tip offset - so it visibly rotates.
          const orbitDirection = Math.sign(orbitAngularSpanRef.current) || 1;
          targetRotation = ((angle + (orbitDirection * Math.PI) / 2) * 180) / Math.PI + 90;
        } else {
          // Calm hold: sit exactly on the target at rest.
          x = orbitCenterRef.current.x;
          y = orbitCenterRef.current.y;
          scale = 1;
          targetRotation = REST_ROTATION_DEGREES;
        }
        positionRef.current = { x, y };
        if (phaseRef.current === "ending" && now - pointLandedAtRef.current > holdDurationRef.current) {
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
        pointPhaseRef.current !== "none";
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

      rafId = requestAnimationFrame(renderFrame);
    };

    rafId = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(rafId);
  }, [reset]);

  // The listening waveform and thinking spinner sit right at the real mouse point, not at
  // the buddy's offset spot beside it (the triangle sits offset so its tip hugs the cursor;
  // a centred ring/waveform there would read as floating far from the cursor). Undo the
  // buddy offset so they centre exactly where the mouse is.
  const cursorAtMouse: CursorFrame = {
    ...cursorFrame,
    x: cursorFrame.x - BUDDY_OFFSET_X,
    y: cursorFrame.y - BUDDY_OFFSET_Y,
  };

  return (
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
          {caption !== null && <CaptionBubble caption={caption} anchor={cursorFrame} />}
        </>
      )}
    </motion.div>
  );
}

/** The fixed line width (px) the cursor caption fills before it clears (see CaptionReveal). */
const OVERLAY_CAPTION_WIDTH_PX = 260;

/**
 * The spoken reply shown just beside the following cursor, revealed word by word in step
 * with the voice (this is now the only place the reply text appears - the Pill just shows
 * the waveform). A compact chip that fills one fixed-width line book-style, sitting close
 * to the cursor and clamped so it never runs off-screen. Keyed on the sentence id so a new
 * sentence restarts the reveal.
 */
function CaptionBubble({ caption, anchor }: { caption: CaptionData; anchor: CursorFrame }) {
  // Sit close to the right-and-below of the cursor, clamped so it never runs off-screen.
  const left = Math.min(Math.max(anchor.x + 12, 6), window.innerWidth - (OVERLAY_CAPTION_WIDTH_PX + 24));
  const top = Math.min(Math.max(anchor.y + 10, 6), window.innerHeight - 40);
  return (
    <motion.div
      className="absolute rounded-full bg-neutral-950/95 px-2.5 py-1 shadow-lg shadow-black/50"
      style={{ left, top }}
      initial={{ opacity: 0, x: -6 }}
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

