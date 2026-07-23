// Pure multi-monitor labeling for screen capture (ticket 05). Given the connected
// displays and which one the cursor is on, it decides the order the screenshots are
// presented to the Reasoning model and the human-readable label each carries. The
// order and the 1-based screen number are load-bearing: the model emits Point Tags
// as `[POINT:x,y:label:screenN]`, and the Overlay (ticket 07) maps `screenN` back to
// a real display, so this numbering is the contract between the two.
//
// This is deliberately free of any OS or coordinate math - the capture edge resolves
// which display holds the cursor and hands the answer in, so the ordering/labeling
// rule stays a plain, unit-tested function (M1 Shell test plan: pure logic only).

/** One connected display, in the order the OS reported it. */
export interface DisplayForCapture {
  /** The Electron display id, used to match a display to the cursor and to captures. */
  id: number;
}

/** How one display should be captured and described to the model. */
export interface ScreenCapturePlan {
  /** The display this plan captures. */
  displayId: number;
  /**
   * The screen's 1-based number in the presented order. The cursor's screen is
   * number 1 when the cursor is on a connected display, so "primary focus" and
   * `screen1` coincide - matching how the model is told to prioritize it.
   */
  screenNumber: number;
  /** The semantic label handed to the request builder (no dimensions - those are appended there). */
  label: string;
  /** Whether the user's cursor is on this display (the model's primary focus). */
  isCursorScreen: boolean;
}

/**
 * Orders and labels the connected displays for a screen-aware turn.
 *
 * The cursor's display is presented first (so it becomes `screen1`, the model's
 * primary focus); the remaining displays keep the OS's order behind it. Labels match
 * the v1 phrasing so the ported system prompt's "primary focus" instruction lines up:
 *
 *   - a single display:            "user's screen (cursor is here)"
 *   - the cursor's display:        "screen N of M - cursor is on this screen (primary focus)"
 *   - any other display:           "screen N of M - secondary screen"
 *
 * `cursorDisplayId` is `null` when the cursor is not within any connected display's
 * bounds (a rare edge the capture layer reports honestly rather than guessing): the
 * OS order is kept and no display is flagged as primary focus.
 */
export function planScreenCaptures(
  displays: DisplayForCapture[],
  cursorDisplayId: number | null,
): ScreenCapturePlan[] {
  // Cursor display first, the rest in their original (OS-reported) order behind it.
  // A stable move-to-front, so on a single display or when the cursor is off-screen
  // the order is simply the OS order.
  const cursorDisplay = displays.find((display) => display.id === cursorDisplayId) ?? null;
  const orderedDisplays =
    cursorDisplay === null
      ? displays
      : [cursorDisplay, ...displays.filter((display) => display.id !== cursorDisplay.id)];

  const totalDisplays = orderedDisplays.length;

  return orderedDisplays.map((display, orderIndex) => {
    const screenNumber = orderIndex + 1;
    const isCursorScreen = display.id === cursorDisplayId;

    let label: string;
    if (totalDisplays === 1) {
      label = "user's screen (cursor is here)";
    } else if (isCursorScreen) {
      label = `screen ${screenNumber} of ${totalDisplays} - cursor is on this screen (primary focus)`;
    } else {
      label = `screen ${screenNumber} of ${totalDisplays} - secondary screen`;
    }

    return { displayId: display.id, screenNumber, label, isCursorScreen };
  });
}
