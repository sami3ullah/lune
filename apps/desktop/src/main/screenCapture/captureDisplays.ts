import { desktopCapturer, nativeImage, screen } from "electron";
import { planScreenCaptures, type DisplayForCapture } from "./screenLabeling";
import type { DownscaleScreenshot, ScreenCaptureInput } from "@lune/core";

// The thin OS-and-pixels edge of screen capture (ticket 05): it turns the connected
// displays into the labeled screenshots the Core attaches to a turn, and downscales
// them before they reach a Vendor. All of it lives in the main process on purpose -
// the screenshots never touch the renderer and are never written to disk (they exist
// only as in-memory base64 handed to the in-process Core), so sensitive pixels have
// the smallest possible blast radius (ticket 05: screenshots are never persisted).
//
// This module is the untested edge; the ordering/labeling decision it delegates to
// (`planScreenCaptures`) and the downscale-remap math in the Core are the tested
// core. It is written platform-neutrally (Electron's cross-platform capture APIs)
// so the M7 Windows port needs no change here.

/**
 * Caps each captured screenshot's larger dimension, in pixels. Matches v1's capture
 * cap: enough detail for the model to read the screen, small enough to keep tokens
 * and latency down. The Core then downscales further (see {@link nativeImageDownscale}).
 */
const CAPTURE_MAX_DIMENSION = 1280;

/** JPEG quality (0-100) for both capture and downscale encodes; 80 matches v1. */
const JPEG_QUALITY = 80;

/** The uniform factor the captured screenshots are downscaled by before a Vendor sees them. */
const DOWNSCALE_FACTOR = 0.5;

/**
 * Which connected display the cursor is on, or `null` if the cursor is outside every
 * display's bounds. Reported honestly (not snapped to the nearest display) so the
 * labeling can decline to flag a primary focus rather than guess wrong.
 */
function resolveCursorDisplayId(displays: Electron.Display[]): number | null {
  const cursorPoint = screen.getCursorScreenPoint();
  for (const display of displays) {
    const { x, y, width, height } = display.bounds;
    const cursorIsInside =
      cursorPoint.x >= x &&
      cursorPoint.x < x + width &&
      cursorPoint.y >= y &&
      cursorPoint.y < y + height;
    if (cursorIsInside) {
      return display.id;
    }
  }
  return null;
}

/**
 * Matches each display to its capture source. Electron tags a screen source with its
 * `display_id`; when that is present we match on it (robust to source ordering), and
 * otherwise fall back to aligning the sources to the displays by position (the two
 * lists are reported in the same order).
 */
function buildSourceResolver(
  displays: Electron.Display[],
  sources: Electron.DesktopCapturerSource[],
): (displayId: number) => Electron.DesktopCapturerSource | undefined {
  const sourceByDisplayId = new Map<number, Electron.DesktopCapturerSource>();
  for (const source of sources) {
    const parsedDisplayId = Number(source.display_id);
    if (source.display_id !== "" && Number.isFinite(parsedDisplayId)) {
      sourceByDisplayId.set(parsedDisplayId, source);
    }
  }

  return (displayId: number) => {
    const matchedByDisplayId = sourceByDisplayId.get(displayId);
    if (matchedByDisplayId) {
      return matchedByDisplayId;
    }
    // Fallback: no usable display_id on the sources - align by position.
    const displayIndex = displays.findIndex((display) => display.id === displayId);
    return displayIndex >= 0 ? sources[displayIndex] : undefined;
  };
}

/**
 * Captures every connected display as a labeled, JPEG-encoded screenshot in the order
 * the model should read them (cursor's display first). Returns an empty array if
 * nothing could be captured - the caller then simply runs a text-only turn. Never
 * writes to disk; the bytes live only in the returned base64.
 */
export async function captureConnectedDisplays(): Promise<ScreenCaptureInput[]> {
  const displays = screen.getAllDisplays();
  if (displays.length === 0) {
    return [];
  }

  const cursorDisplayId = resolveCursorDisplayId(displays);
  const capturePlans = planScreenCaptures(
    displays.map<DisplayForCapture>((display) => ({ id: display.id })),
    cursorDisplayId,
  );

  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: CAPTURE_MAX_DIMENSION, height: CAPTURE_MAX_DIMENSION },
  });
  const resolveSource = buildSourceResolver(displays, sources);

  const captures: ScreenCaptureInput[] = [];
  for (const plan of capturePlans) {
    const source = resolveSource(plan.displayId);
    if (!source || source.thumbnail.isEmpty()) {
      // A missing or empty thumbnail (permission not truly granted for this process,
      // or an unmatched display) is skipped rather than sent as a black image.
      continue;
    }
    const { width, height } = source.thumbnail.getSize();
    captures.push({
      base64Data: source.thumbnail.toJPEG(JPEG_QUALITY).toString("base64"),
      mediaType: "image/jpeg",
      widthInPixels: width,
      heightInPixels: height,
      label: plan.label,
    });
  }

  return captures;
}

/**
 * Probes whether this process can actually capture the screen right now. Used both to
 * trigger the macOS permission prompt on the first attempt and to detect the
 * granted-but-needs-relaunch case (macOS hands a pre-grant process empty frames).
 * A tiny thumbnail keeps the probe cheap enough to poll while the permission UI is open.
 */
export async function screenCaptureProducesContent(): Promise<boolean> {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 32, height: 32 },
  });
  return sources.some((source) => {
    if (source.thumbnail.isEmpty()) {
      return false;
    }
    const { width, height } = source.thumbnail.getSize();
    return width > 0 && height > 0;
  });
}

/**
 * The real screenshot downscale (the Core's injected `DownscaleScreenshot` seam),
 * backed by Electron's `nativeImage`. It shrinks each screenshot by
 * {@link DOWNSCALE_FACTOR} and reports the exact achieved factor, which the Core uses
 * to remap the model's Point Tag coordinates back to captured-pixel space and to
 * rewrite the dimensions stated in each label. Replaces the walking skeleton's
 * passthrough now that real screenshots flow.
 */
export const nativeImageDownscale: DownscaleScreenshot = async (screenshot) => {
  const originalImage = nativeImage.createFromBuffer(Buffer.from(screenshot.base64Data, "base64"));
  const originalWidth = originalImage.getSize().width;
  if (originalWidth <= 0) {
    // An undecodable image can't be resized; pass it through at the identity factor
    // rather than dropping the screenshot.
    return { ...screenshot, scaleFactor: 1 };
  }

  const targetWidth = Math.max(1, Math.round(originalWidth * DOWNSCALE_FACTOR));
  const resizedImage = originalImage.resize({ width: targetWidth });
  // Report the factor actually achieved (rounding can nudge it off exactly 0.5) so
  // the coordinate remap and dimension rewrite track the real image the model sees.
  const scaleFactor = resizedImage.getSize().width / originalWidth;

  return {
    base64Data: resizedImage.toJPEG(JPEG_QUALITY).toString("base64"),
    mediaType: "image/jpeg",
    scaleFactor,
  };
};
