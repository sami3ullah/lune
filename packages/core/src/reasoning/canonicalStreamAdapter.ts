/**
 * Adapts a Vendor's raw answer-text delta stream into the Core's canonical
 * Vendor-independent chat-event stream (`text-delta`* then one `done`), applying
 * the Point Tag stream guard on the way out so the trailing `[POINT:...]` tag is
 * held back, repaired, and remapped before it is emitted.
 *
 * This is the successor of v1's Seam-2 SSE adapter (`qwenSseAdapter.ts`): v1
 * re-serialized the deltas into canonical Anthropic SSE bytes because the Shell
 * spoke HTTP; the Core is transport-agnostic, so it yields canonical *events* and
 * the Electron main process maps them onto the typed IPC contract. `remap` inverts
 * the screenshot downscale so a trailing tag's coordinates (a Point Tag or a teaching
 * Shape Tag) come out in real screenshot-pixel space; pass the identity remap when no
 * downscaling was applied.
 */
import type { RemapCoordinate } from "./coordinateRemap.js";
import { TrailingTagStreamGuard } from "./trailingTagCanonicalizer.js";
import type { CoreChatStreamEvent } from "./chatTypes.js";

export async function* adaptTextDeltasToCanonicalStream(
  textDeltas: AsyncGenerator<string>,
  remap: RemapCoordinate,
): AsyncGenerator<CoreChatStreamEvent> {
  const trailingTagGuard = new TrailingTagStreamGuard(remap);

  for await (const delta of textDeltas) {
    const emittableText = trailingTagGuard.push(delta);
    if (emittableText.length > 0) {
      yield { type: "text-delta", text: emittableText };
    }
  }

  // Emit the held-back tail (the repaired, remapped trailing tags live here).
  const finalizedTail = trailingTagGuard.finalize();
  if (finalizedTail.length > 0) {
    yield { type: "text-delta", text: finalizedTail };
  }

  yield { type: "done" };
}
