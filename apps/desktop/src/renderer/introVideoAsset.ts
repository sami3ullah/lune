// The intro video's source (M3-03). This is the single drop-in seam for the Farza-style
// welcome video: the cursor-riding card mechanism (follow physics, wizard-avoidance, skip,
// auto-dismiss) is complete and shipped; until a real clip exists the card shows a branded
// animated placeholder, and the moment one is added it plays instead - with audio.
//
// To enable the real video:
//   1. Drop the file at `src/renderer/assets/intro.mp4` (Vite bundles it into the renderer,
//      so the emitted URL works in both dev and the packaged app - no main-process staging).
//   2. Replace the line below with:
//        import introVideoMp4 from "./assets/intro.mp4";
//        export const introVideoUrl: string | null = introVideoMp4;
//
// The Overlay window is already configured to autoplay it with sound
// (`autoplayPolicy: "no-user-gesture-required"`), so no further wiring is needed.
export const introVideoUrl: string | null = null;
