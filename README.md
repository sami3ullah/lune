# Lune

An on-screen AI companion you talk or type to: it sees your screen, answers with
voice, points at what it references, and (in later milestones) can act on your
computer. Reasoning is cloud-only (Anthropic, Google/Gemini, OpenAI); Speech and
Transcription run locally (Kokoro, whisper) with weights downloaded on first run.

This is the Electron/React rebuild of the app formerly known as Snappy/clicky.
See [`CONTEXT.md`](./CONTEXT.md) for the vocabulary, [`DECISIONS.md`](./DECISIONS.md)
for the rationale, and [`ACKNOWLEDGMENTS.md`](./ACKNOWLEDGMENTS.md) for attribution.

## Layout

A pnpm monorepo:

- `apps/desktop` - the **Shell**: the Electron/React front-end (window/overlay,
  capture, playback, settings UI). Does only OS-and-pixels work.
- `packages/core` - the **Core**: a pure, transport-agnostic TypeScript package
  that owns all intelligence (vendor routing, protocol translation, sessions).
  No Electron imports, no HTTP.
- `packages/shared` - the zod-typed Shell<->Core IPC contract, the single source
  of truth for every message crossing the boundary.

## Develop

```bash
pnpm install
pnpm dev        # opens the Electron window with React HMR
pnpm test       # runs the Core vitest suite
pnpm typecheck  # typechecks every package
pnpm build      # builds every package
```

Requires Node >= 20 and pnpm 10.

## Package (macOS)

Lune ships as a signed, hardened-runtime, notarized DMG (ticket 15). One command runs
the whole chain - build the whisper-server binary, compile the app, deep-sign the native
addons, notarize, and staple:

```bash
scripts/package-dmg.sh          # full signed + notarized DMG → apps/desktop/release/
scripts/package-dmg.sh --dir    # unpacked .app only, no signing/notarization (fast check)
```

The installer bundles the whisper-server binary and the native addons (onnxruntime-node,
uiohook-napi, phonemizer/espeak) but **never the model weights** - Provisioning downloads
those (~2 GB) on first run. The build machine needs the Xcode Command Line Tools, `cmake`,
and `git` (for the whisper-server build).

A full release also needs signing + notarization credentials in the environment:

- A **Developer ID Application** certificate in the login keychain (auto-discovered), or
  `CSC_LINK` + `CSC_KEY_PASSWORD` pointing at a `.p12`.
- Notarization, either `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or an
  App Store Connect API key via `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`.

Packaging config lives in `apps/desktop/electron-builder.yml`; hardened-runtime
entitlements in `apps/desktop/build/`.
