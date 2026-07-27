// The pure placement math behind the cursor-riding intro video (M3-03): where the
// welcome-step video card should sit so it rides *alongside* the pointer without ever
// covering the onboarding window. The Overlay component springs the card toward this
// target each frame (reusing the same `springStep` the cursor buddy follows with), so
// keeping the geometry a pure function of the inputs is what makes "never obscures the
// onboarding UI" a tested guarantee rather than an animation nobody can assert on.
//
// Coordinates are the Overlay window's local space (top-left origin), the same space the
// cursor-follow poll streams the mouse in - the card lives in the full-screen click-
// through Overlay window, so "local" is "this display". The onboarding window's rectangle
// arrives already converted into this display's local space (the main process owns display
// geometry), or null when onboarding is on another display and there is nothing to avoid.

/** A width/height pair in local logical pixels. */
export interface Size {
  width: number;
  height: number;
}

/** A rectangle in the Overlay window's local (top-left origin) coordinate space. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Everything {@link computeIntroCardTarget} needs to place the card for one frame. */
export interface IntroCardPlacementInput {
  /** The real mouse position on this display, in window-local pixels. */
  cursor: { x: number; y: number };
  /** The card's fixed rendered size. */
  cardSize: Size;
  /** This display's size (the Overlay window covers it exactly). */
  displaySize: Size;
  /**
   * The onboarding window's rectangle in this display's local space, or null when it is
   * not on this display. The card is kept clear of it so it never obscures the wizard.
   */
  avoidRect: Rect | null;
  /** The preferred gap between the cursor (or the wizard edge) and the near edge of the card. */
  gap: number;
  /** The minimum gap the card keeps from every display edge. */
  margin: number;
}

/** Clamps `value` into `[min, max]` (returns `max` when the range is inverted). */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The card's target top-left for this frame: vertically centred on the cursor and set to
 * whichever side of the onboarding window keeps it fully clear, always clamped on-screen.
 *
 * Vertical follows the cursor (clamped to the display) so the card tracks the pointer up
 * and down while staying beside it. Horizontal is chosen so the card never overlaps the
 * onboarding window: the display splits into a gutter left of the wizard and a gutter to
 * its right, and the card sits in one of them, riding the cursor's X but never crossing
 * into the wizard's span. It takes the gutter on the cursor's side of the wizard when both
 * have room, the only one with room otherwise. With nothing to avoid it simply rides the
 * side of the cursor with more room, trailing alongside the pointer.
 *
 * On a display too narrow for either gutter to hold the card, clearance is impossible; it
 * then pins to the display edge on the roomier side - the least-obscuring spot - rather
 * than sitting centred over the wizard.
 */
export function computeIntroCardTarget(input: IntroCardPlacementInput): { x: number; y: number } {
  const { cursor, cardSize, displaySize, avoidRect, gap, margin } = input;

  const minX = margin;
  const maxX = displaySize.width - cardSize.width - margin;
  const minY = margin;
  const maxY = displaySize.height - cardSize.height - margin;

  const y = clamp(cursor.y - cardSize.height / 2, minY, maxY);

  if (avoidRect === null) {
    // Nothing to dodge: ride on the side of the cursor with more room, so the card trails
    // beside the pointer instead of always favouring one edge.
    const roomOnRight = displaySize.width - cursor.x;
    const x =
      roomOnRight >= cursor.x
        ? clamp(cursor.x + gap, minX, maxX)
        : clamp(cursor.x - gap - cardSize.width, minX, maxX);
    return { x, y };
  }

  const avoidRight = avoidRect.x + avoidRect.width;
  const avoidCenterX = avoidRect.x + avoidRect.width / 2;
  const needed = cardSize.width + gap + margin;
  const rightFits = displaySize.width - avoidRight >= needed;
  const leftFits = avoidRect.x >= needed;

  // Ride the cursor's X within a gutter, clamped so the card stays clear of the wizard on
  // that side (and on-screen). In the right gutter the card's left edge never crosses the
  // wizard's right edge; in the left gutter its right edge never crosses the wizard's left.
  const rightGutterX = clamp(cursor.x + gap, avoidRight + gap, maxX);
  const leftGutterX = clamp(cursor.x - gap - cardSize.width, minX, avoidRect.x - gap - cardSize.width);

  let x: number;
  if (rightFits && leftFits) {
    x = cursor.x >= avoidCenterX ? rightGutterX : leftGutterX;
  } else if (rightFits) {
    x = rightGutterX;
  } else if (leftFits) {
    x = leftGutterX;
  } else {
    // Neither gutter can hold the card: pin to the roomier edge to minimise the overlap.
    x = cursor.x >= avoidCenterX ? maxX : minX;
  }
  return { x, y };
}

// The card's follow spring (M3-03). Heavier and calmer than the cursor buddy's lively
// `.spring(response: 0.2, dampingFraction: 0.6)`: a 400x600 card whipping around reads as
// frantic, so it trails the pointer with a longer response and near-critical damping - it
// glides after the mouse and settles without overshoot. Fed to the shared `springStep`.
export const INTRO_CARD_SPRING_RESPONSE_SECONDS = 0.45;
export const INTRO_CARD_SPRING_DAMPING_FRACTION = 0.85;
