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
