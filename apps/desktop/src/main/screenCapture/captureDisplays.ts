import { desktopCapturer, nativeImage, screen } from "electron";
import { planScreenCaptures, type DisplayForCapture } from "./screenLabeling";
import type { DisplayCaptureGeometry } from "../overlay/overlayGeometry";
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
 * The Vendor-safe ceiling for the screenshot a Reasoning model sees: the largest size
 * no Vendor's API silently resizes (Anthropic resizes above a 1568px long edge or
 * ~1.15 megapixels). Staying under it matters more than raw detail: a silent server-side
 * resize would put the model's coordinates in a space the labels (and the remap) don't
 * know about - a systematic offset on every mark. Within the ceiling, bigger is better:
 * the model estimates Point/Shape Tag pixel coordinates from this image, and a 2560-wide
 * display squeezed to half scale made buttons a few blurry pixels tall - the model's
 * ±10-15px guess in that space landed marks ~30-60px off on the real screen (the
 * "drawing in the wrong place" bug). The capture itself is taken at the display's native
 * resolution and kept for mark refinement + element snapping; only the model's copy is
 * scaled down to this ceiling.
 */
const VENDOR_IMAGE_MAX_LONG_EDGE = 1568;
const VENDOR_IMAGE_MAX_AREA = 1_150_000;

/** JPEG quality (0-100) for both capture and downscale encodes; 80 matches v1. */
const JPEG_QUALITY = 80;

/**
 * The uniform factor the captured screenshots are downscaled by before a Vendor sees
 * them. Set to 1 (no second downscale): the model estimates Point/Shape Tag pixel
 * coordinates from this image, and halving the 1280-cap capture to ~640px wide made
 * buttons a few blurry pixels tall - the model's ±10-15px guess in that space landed
 * marks ~30px off on the real screen (the "drawing in the wrong place" bug). At the
 * full 1280 cap (Anthropic's computer-use sweet spot) elements are legible enough to
 * ground accurately. The remap seam stays: any factor here still round-trips through
 * the Core's coordinate remap, so lowering it later is a one-line change.
 */
const DOWNSCALE_FACTOR = 1;

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
 * One capture: the labeled screenshots the Core attaches to a turn, paired with the
 * per-display geometry the Overlay needs to point (ticket 07). The two travel together
 * because they come from the same capture pass and share the same `screenNumber`ing:
 * the model is told `screenN` via {@link ScreenCaptureInput.label}, and the Overlay
 * maps a Point Tag's `screenN` back to a real monitor via {@link geometry}. The
 * geometry never crosses to the renderer - only the derived global point does.
 */
export interface DisplayCaptureResult {
  screens: ScreenCaptureInput[];
  geometry: DisplayCaptureGeometry[];
  /**
   * The same capture at the display's native pixel resolution, one per screen in the
   * same order as {@link screens}. The model never sees these; they stay in the main
   * process so mark refinement can cut sharp zoomed crops and element snapping can
   * detect edges at full detail. Like the model's screenshots, they live only as
   * in-memory base64 for the turn and are never persisted.
   */
  nativeCaptures: NativeScreenCapture[];
}

/** One display's screenshot at native pixel resolution, for Shell-side mark accuracy work. */
export interface NativeScreenCapture {
  /** The same 1-based screen number the model's label and {@link DisplayCaptureGeometry} carry. */
  screenNumber: number;
  /** Base64-encoded JPEG bytes (no `data:` prefix). */
  base64Data: string;
  widthInPixels: number;
  heightInPixels: number;
}

/**
 * How much a native capture must be scaled down (uniformly, in (0, 1]) for the model's
 * copy to fit the Vendor-safe ceiling - never upscaling a small display.
 */
function vendorSafeScale(width: number, height: number): number {
  if (width <= 0 || height <= 0) {
    return 1;
  }
  const longEdgeScale = VENDOR_IMAGE_MAX_LONG_EDGE / Math.max(width, height);
  const areaScale = Math.sqrt(VENDOR_IMAGE_MAX_AREA / (width * height));
  return Math.min(1, longEdgeScale, areaScale);
}

/**
 * Captures the one display the user is actually looking at - the display under the
 * cursor - as a single labeled, JPEG-encoded screenshot, plus the geometry mapping its
 * screen number back to its bounds + captured pixel size. Lune answers about the screen
 * the mouse is on, never narrating every connected monitor at once; on a multi-monitor
 * setup that means a question about a selection on screen 2 is answered from screen 2,
 * not screen 1. If the cursor is outside every display, the display nearest it is used.
 * Returns empty arrays if nothing could be captured - the caller then simply runs a
 * text-only turn with no pointing. Never writes to disk; the bytes live only in base64.
 */
export async function captureConnectedDisplays(): Promise<DisplayCaptureResult> {
  const displays = screen.getAllDisplays();
  if (displays.length === 0) {
    return { screens: [], geometry: [], nativeCaptures: [] };
  }

  const displayById = new Map(displays.map((display) => [display.id, display]));
  // Only the display under the cursor is captured. When the cursor is off every display
  // (a rare edge), fall back to the display nearest it so the turn still has one screen.
  const focusDisplayId =
    resolveCursorDisplayId(displays) ??
    screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
  const capturePlans = planScreenCaptures(
    [{ id: focusDisplayId } satisfies DisplayForCapture],
    focusDisplayId,
  );

  // Ask for the focus display's native pixel size (logical bounds x its backing scale).
  // Electron fits each source's thumbnail within this box preserving aspect, never
  // upscaling, so the focus display comes back at true native resolution - full detail
  // for the mark-accuracy work; the model's copy is derived below at the Vendor ceiling.
  const focusDisplay = displayById.get(focusDisplayId);
  const nativeThumbnailSize = focusDisplay
    ? {
        width: Math.max(1, Math.round(focusDisplay.bounds.width * focusDisplay.scaleFactor)),
        height: Math.max(1, Math.round(focusDisplay.bounds.height * focusDisplay.scaleFactor)),
      }
    : { width: VENDOR_IMAGE_MAX_LONG_EDGE, height: VENDOR_IMAGE_MAX_LONG_EDGE };

  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: nativeThumbnailSize,
  });
  const resolveSource = buildSourceResolver(displays, sources);

  const screens: ScreenCaptureInput[] = [];
  const geometry: DisplayCaptureGeometry[] = [];
  const nativeCaptures: NativeScreenCapture[] = [];
  for (const plan of capturePlans) {
    const source = resolveSource(plan.displayId);
    if (!source || source.thumbnail.isEmpty()) {
      // A missing or empty thumbnail (permission not truly granted for this process,
      // or an unmatched display) is skipped rather than sent as a black image. It gets
      // no geometry either, so the model never sees a screenN the Overlay can't map.
      continue;
    }
    const nativeSize = source.thumbnail.getSize();
    const scale = vendorSafeScale(nativeSize.width, nativeSize.height);
    const modelImage =
      scale < 1
        ? source.thumbnail.resize({ width: Math.max(1, Math.round(nativeSize.width * scale)) })
        : source.thumbnail;
    const { width, height } = modelImage.getSize();
    screens.push({
      base64Data: modelImage.toJPEG(JPEG_QUALITY).toString("base64"),
      mediaType: "image/jpeg",
      widthInPixels: width,
      heightInPixels: height,
      label: plan.label,
    });
    nativeCaptures.push({
      screenNumber: plan.screenNumber,
      base64Data: source.thumbnail.toJPEG(JPEG_QUALITY).toString("base64"),
      widthInPixels: nativeSize.width,
      heightInPixels: nativeSize.height,
    });

    // The same screen number the label carried to the model, paired with the display's
    // logical bounds and this capture's pixel size, so the Overlay can scale a Point
    // Tag coordinate back onto the real monitor.
    const display = displayById.get(plan.displayId);
    if (display) {
      geometry.push({
        screenNumber: plan.screenNumber,
        displayId: plan.displayId,
        bounds: {
          x: display.bounds.x,
          y: display.bounds.y,
          width: display.bounds.width,
          height: display.bounds.height,
        },
        capturedWidth: width,
        capturedHeight: height,
      });
    }
  }

  return { screens, geometry, nativeCaptures };
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
  if (DOWNSCALE_FACTOR === 1) {
    // Passthrough: no resize, and crucially no decode + JPEG re-encode round trip,
    // which would only soften the text the model reads coordinates from.
    return { ...screenshot, scaleFactor: 1 };
  }
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
