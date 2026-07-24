import { desktopCapturer, screen } from "electron";
import type { AgentDisplay, AgentScreenshot } from "@lune/core";
import type { AgentDisplayGeometry } from "./agentCoordinateRemap";
import type { SceneCapture } from "./screenAgentLoop";
import type { AxSignalProvider } from "./axSignalProvider";
import { buildAgentTargetSignal } from "./agentTargetSignal";

// The Screen Agent's scene capture (M2-03): the overlay-excluded, single-active-display
// screenshot the loop reasons about each Step. It is the agent sibling of the chat turn's
// `captureDisplays` - same OS-and-pixels edge, same "hide Lune's own windows so they never
// leak into the capture" discipline - but shaped for the agent loop: it returns one
// {@link SceneCapture} (the screenshot the Core steps on, the geometry the executor remaps
// Action coordinates with, and the display that sizes the computer tool) rather than the
// multi-monitor labeled set a chat answer points over.
//
// A Session is bound to one display for its whole life (the Core keeps the coordinate
// space stable), so the display is resolved once at session start via
// {@link resolveActiveDisplayId} and every capture re-photographs that same display - the
// agent's own synthetic clicks must never drift the capture onto another monitor mid-run.
//
// This is the untested OS edge (like `captureDisplays`); the coordinate math it feeds
// (`agentCoordinateRemap`) and the loop that drives it (`screenAgentLoop`) are the tested
// core. It is written platform-neutrally (Electron's cross-platform capture APIs) so the
// M7 Windows port needs no change here.

/**
 * Caps the captured screenshot's larger dimension, in pixels. Matches the chat capture cap
 * (`captureDisplays`): enough detail for the computer-use model to read the screen, small
 * enough to keep tokens and latency down. The stated display the Core sizes its tool with
 * is this captured pixel size, so the model reasons - and returns coordinates - in exactly
 * the space the executor remaps from.
 */
const CAPTURE_MAX_DIMENSION = 1280;

/** JPEG quality (0-100) for the capture encode; matches the chat capture. */
const JPEG_QUALITY = 80;

/** Thrown when the active display could not be captured, so the loop stops the run cleanly. */
export class AgentSceneCaptureError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "AgentSceneCaptureError";
  }
}

/**
 * Resolves the display the Session binds to for its life: the one under the cursor at
 * session start (where the user is looking, and where a "type where my cursor is" one-shot
 * belongs), falling back to the display nearest the cursor if it sits outside every
 * display's bounds. Returns the primary display's id if - impossibly - there are none.
 */
export function resolveActiveDisplayId(): number {
  const cursorPoint = screen.getCursorScreenPoint();
  for (const display of screen.getAllDisplays()) {
    const { x, y, width, height } = display.bounds;
    if (
      cursorPoint.x >= x &&
      cursorPoint.x < x + width &&
      cursorPoint.y >= y &&
      cursorPoint.y < y + height
    ) {
      return display.id;
    }
  }
  return screen.getDisplayNearestPoint(cursorPoint).id;
}

/**
 * Matches a display id to its capture source. Electron tags a screen source with its
 * `display_id`; when present we match on it (robust to source ordering), otherwise fall
 * back to aligning by position (the two lists are reported in the same order). Mirrors the
 * chat capture's resolver so both paths pick the same source for a given display.
 */
function resolveSourceForDisplay(
  displayId: number,
  displays: Electron.Display[],
  sources: Electron.DesktopCapturerSource[],
): Electron.DesktopCapturerSource | undefined {
  for (const source of sources) {
    const parsedDisplayId = Number(source.display_id);
    if (source.display_id !== "" && Number.isFinite(parsedDisplayId) && parsedDisplayId === displayId) {
      return source;
    }
  }
  const displayIndex = displays.findIndex((display) => display.id === displayId);
  return displayIndex >= 0 ? sources[displayIndex] : undefined;
}

/** The overlay-suspend seam so the capture never photographs Lune's own cursor/bubble/chip. */
export interface OverlaySuspender {
  /** Hides every Lune overlay window and pauses the follow poll (before a capture). */
  suspendFollowing: () => void;
  /** Shows the overlay windows again and resumes following (after a capture). */
  resumeFollowing: () => void;
}

/**
 * Captures the Session's bound display as one overlay-excluded {@link SceneCapture}. Lune's
 * own windows are suspended around the capture (not merely hidden) so the follow poll can
 * never re-show the cursor mid-capture and leak it into the model's view; they are resumed
 * in a `finally` so a capture failure never leaves the overlay frozen. Throws
 * {@link AgentSceneCaptureError} when the display yields no usable frame (permission not
 * truly granted for this process, or the display vanished), so the loop ends the run rather
 * than stepping on a black image.
 *
 * The returned `display` and `geometry.captured*` are the captured pixel size: the Core
 * sizes the computer tool to it, the Vendor returns coordinates in it, and the executor
 * remaps them back to the display's global logical bounds - one consistent coordinate space
 * end to end.
 *
 * The accessibility target signal (M2-05) is read *after* the screenshot and outside the
 * overlay-suspend bracket - the AX read doesn't photograph the screen, so there is no reason
 * to keep Lune's cursor hidden through its (bounded) latency, and the overlay never takes
 * focus so it can't shift the frontmost app the read walks. The read is best-effort: a `null`
 * or empty signal (no `axProvider`, no accessibility, a timeout) simply yields no floor
 * escalation, so a poor accessibility tree degrades gracefully (acceptance #3).
 */
export async function captureAgentScene(
  displayId: number,
  overlay: OverlaySuspender,
  axProvider?: AxSignalProvider,
): Promise<SceneCapture> {
  const displays = screen.getAllDisplays();
  const boundDisplay = displays.find((display) => display.id === displayId);
  if (boundDisplay === undefined) {
    throw new AgentSceneCaptureError("The Screen Agent's active display is no longer connected");
  }

  let scene: SceneCapture;
  overlay.suspendFollowing();
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: CAPTURE_MAX_DIMENSION, height: CAPTURE_MAX_DIMENSION },
    });
    const source = resolveSourceForDisplay(displayId, displays, sources);
    if (source === undefined || source.thumbnail.isEmpty()) {
      throw new AgentSceneCaptureError(
        "The Screen Agent could not capture the screen (screen recording permission may be missing)",
      );
    }

    const { width, height } = source.thumbnail.getSize();
    const screenshot: AgentScreenshot = {
      base64Data: source.thumbnail.toJPEG(JPEG_QUALITY).toString("base64"),
      mediaType: "image/jpeg",
    };
    const geometry: AgentDisplayGeometry = {
      bounds: {
        x: boundDisplay.bounds.x,
        y: boundDisplay.bounds.y,
        width: boundDisplay.bounds.width,
        height: boundDisplay.bounds.height,
      },
      capturedWidth: width,
      capturedHeight: height,
    };
    const display: AgentDisplay = { width, height };

    scene = { screenshot, geometry, display };
  } finally {
    overlay.resumeFollowing();
  }

  // Read the AX target signal for the Consequence floor. `capture()` never rejects, but guard
  // anyway so a reader bug can never turn a good screenshot into a failed scene - the run
  // continues with no signal (no escalation) rather than stopping.
  if (axProvider !== undefined) {
    try {
      const raw = await axProvider.capture();
      scene.targetSignal = buildAgentTargetSignal(raw, scene.geometry);
    } catch {
      scene.targetSignal = undefined;
    }
  }

  return scene;
}
