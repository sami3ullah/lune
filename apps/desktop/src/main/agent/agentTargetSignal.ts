import type { AgentTargetSignal, TargetElement } from "@lune/core";
import type { AgentDisplayGeometry } from "./agentCoordinateRemap";

// The pure half of M2-05's AX target signal. v1's Sidecar sent the Core only the focused
// element (`elements` empty), so the Consequence floor's click-hit-test escalation - the
// rule that turns a click on a "Send" button or a hyperlink into a `consequential` Action -
// was inert. This closes that gap: the Shell now reads the on-screen accessibility elements
// (the untested OS edge in `axSignalProvider`) and this module turns that raw read into the
// Core's {@link AgentTargetSignal}.
//
// The one job here is a coordinate-space change. The raw read is in the display's
// global-logical space (macOS AX uses a top-left origin in points, matching Electron's
// `screen` bounds); the Core hit-tests element frames against an Action's coordinate, which
// is in the *captured-pixel* space of the screenshot the Vendor reasoned about. So each
// element frame is remapped global-logical -> captured-pixel with the same capture geometry
// the coordinate remap uses (the inverse of `remapScreenshotPointToGlobal`), clipped to the
// captured frame, and any element with no on-screen area dropped. Keeping it a pure function
// of the geometry (rather than reaching into `screen`) is what lets the remap, the clipping,
// and the graceful-degradation contract be unit-tested without a real accessibility tree.

/**
 * One accessibility element as the OS reported it: its frame in the display's global-logical
 * coordinate space (top-left origin, logical points), plus its label/role. This is what the
 * platform {@link import("./axSignalProvider").AxSignalProvider} yields; {@link buildAgentTargetSignal}
 * maps it into the Core's captured-pixel {@link TargetElement}.
 */
export interface RawAxElement {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The element's accessibility label / title, if any. */
  label?: string;
  /** The element's accessibility role (e.g. `AXButton`, `AXLink`), if any. */
  role?: string;
}

/**
 * The raw accessibility read for one captured scene, in global-logical coordinates. All
 * fields are optional; a `null` read (no accessibility available) or an empty one degrades
 * to no target signal, so the floor simply applies no escalation.
 */
export interface RawAxSignal {
  /** The accessibility label of the currently focused element (context for a `key` press). */
  focusedLabel?: string;
  /** The accessibility role of the currently focused element. */
  focusedRole?: string;
  /** The interactive elements on screen, in global-logical coordinates. */
  elements?: RawAxElement[];
}

/** Clamps `value` into `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Remaps one raw element's global-logical frame into the captured-pixel frame, clipped to
 * the capture so its on-screen part still hit-tests, or `undefined` when it has no on-screen
 * area (fully off this display, or degenerate). The frame is expressed relative to the
 * display origin and scaled by the capture's pixel-to-logical ratio - the inverse of the
 * Action coordinate remap - so element frames and Action coordinates share one space.
 */
function remapElement(
  element: RawAxElement,
  geometry: AgentDisplayGeometry,
): TargetElement | undefined {
  const { bounds, capturedWidth, capturedHeight } = geometry;
  if (capturedWidth <= 0 || capturedHeight <= 0 || bounds.width <= 0 || bounds.height <= 0) {
    return undefined;
  }
  const scaleX = capturedWidth / bounds.width;
  const scaleY = capturedHeight / bounds.height;

  // Map both edges into captured-pixel space, then clip to the captured frame so a frame
  // straddling an edge keeps only its visible part (and a fully-offscreen one collapses).
  const left = clamp((element.x - bounds.x) * scaleX, 0, capturedWidth);
  const right = clamp((element.x + element.width - bounds.x) * scaleX, 0, capturedWidth);
  const top = clamp((element.y - bounds.y) * scaleY, 0, capturedHeight);
  const bottom = clamp((element.y + element.height - bounds.y) * scaleY, 0, capturedHeight);

  const width = Math.round(right - left);
  const height = Math.round(bottom - top);
  if (width <= 0 || height <= 0) {
    return undefined;
  }

  const mapped: TargetElement = { x: Math.round(left), y: Math.round(top), width, height };
  if (element.label !== undefined) {
    mapped.label = element.label;
  }
  if (element.role !== undefined) {
    mapped.role = element.role;
  }
  return mapped;
}

/**
 * Turns the raw accessibility read into the Core's {@link AgentTargetSignal}, remapping each
 * element frame into the captured-pixel space the Consequence floor hit-tests against.
 * Returns `undefined` - so the floor applies no escalation - when there is nothing useful to
 * supply: a `null` read, or a read with no focused element and no on-screen elements. This
 * is the "degrade gracefully in apps with poor accessibility trees" contract (acceptance #3):
 * a thin or missing tree simply means no floor escalation, never a crash.
 */
export function buildAgentTargetSignal(
  raw: RawAxSignal | null,
  geometry: AgentDisplayGeometry,
): AgentTargetSignal | undefined {
  if (raw === null) {
    return undefined;
  }

  const elements = (raw.elements ?? [])
    .map((element) => remapElement(element, geometry))
    .filter((element): element is TargetElement => element !== undefined);

  const hasFocused = raw.focusedLabel !== undefined || raw.focusedRole !== undefined;
  if (!hasFocused && elements.length === 0) {
    return undefined;
  }

  const signal: AgentTargetSignal = {};
  if (raw.focusedLabel !== undefined) {
    signal.focusedLabel = raw.focusedLabel;
  }
  if (raw.focusedRole !== undefined) {
    signal.focusedRole = raw.focusedRole;
  }
  if (elements.length > 0) {
    signal.elements = elements;
  }
  return signal;
}
