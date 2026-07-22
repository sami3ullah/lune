# Lune - Decision Log (grilling session, 2026-07-22/23)

The raw material for the specs, tickets, and ADRs (which the owner writes). Each entry: the decision, and the why. Items marked **[ADR]** are hard-to-reverse trade-offs worth a full ADR in the new repo.

## Product

1. **Audience: personal tool first, hosted product possible later.** Bring-your-own-keys; no accounts/billing in v1. All vendor calls stay behind one service boundary so a hosted proxy ("users don't need keys") is a wrapper, not a rewrite. **[ADR]**
2. **Name: Lune** (was Snappy, fork of clicky).
3. **Milestones:** M1 parity port (chat + voice + screen context + pointing + onboarding + settings) -> M2 Screen Agent -> M3 teaching/drawing overlay -> M4 Skills -> M5 Task Agents -> M6 MCP integrations -> M7 Windows. Owner's 17-point idea list maps onto these; nothing dropped, only ordered.
4. **Expectation setting:** core M1 loop demoable in 2-3 days with heavy AI use; provisioning edge cases, macOS permissions, packaging/signing, and animation polish are the parts that take longer.

## Architecture

5. **Electron over Swift/Tauri** - owner knows React/TS, needs Windows eventually, Core is already TS; performance is model/network-bound, not UI-bound. Tauri rejected (Rust backend orphans the TS Core). **[ADR]**
6. **Carry the v1 Sidecar code, renamed "Core"** - the tested vendor routing, SSE translation, Point Tag canonicalizer, agent-step handler, provisioning machinery all port module-by-module. Only the Swift Shell is rewritten. clicky is MIT: keep an ACKNOWLEDGMENTS.md crediting clicky (Farza, MIT) for ported portions (Worker-derived cloud handlers, Point Tag concept). **[ADR]**
7. **Core is an in-process, transport-agnostic TypeScript package** (`packages/core`), imported by Electron main, exposed to the renderer via typed IPC. No HTTP inside the Core; no Electron imports inside the Core. A future Swift shell or hosted proxy adds a thin HTTP adapter (v1's `server.ts` shape) without touching Core logic. Kills v1's process-tree/watchdog/port machinery. **[ADR]**
8. **Monorepo (pnpm):** `apps/desktop` (Shell) + `packages/core` + `packages/shared` (zod-typed IPC contract). Stack: electron-vite, electron-builder, React + TS + Tailwind, Zustand, Framer Motion. Testing: vitest (v1 Core test suites port over); Playwright later.
9. **macOS ships first; Windows is one later porting milestone (M7).** All shared code written platform-aware (platform-specific work behind small interfaces); tested/shipped on macOS only until feature-complete. **[ADR]**
10. **Repo strategy: this directory becomes the Lune repo.** Rename dir snappy -> lune; move all v1 code into gitignored `_legacy/`; fresh `git init` + new GitHub repo (clean history); port by reading `_legacy/`, delete it after M1. Old code stays on the existing GitHub fork.

## AI capabilities

11. **Reasoning: cloud-only, three Vendors - Anthropic, Google/Gemini, OpenAI** - all wired for both advising and acting (owner: OpenAI now supports computer use; xAI dropped). Gemini is the default when multiple keys exist. Anthropic + Gemini adapters port from v1; OpenAI computer-use adapter is new work. Keys are mandatory in onboarding, stored in the OS keychain, credentials-gate each Vendor. **[ADR]**
12. **Speech stays local: whisper.cpp (STT, child process of the Core) + Kokoro (TTS, in-process ONNX).** Rationale: zero marginal cost, already working well, owner does not want to pay for speech yet. Knowingly buys back: Provisioning subsystem, per-platform whisper builds, Electron native-addon packaging (onnxruntime-node, espeak wasm). Cloud speech (ElevenLabs etc.) is a later option, not v1. **[ADR]**
13. **Weights are never bundled in the installer** (~2 GB: whisper large-v3-turbo ~1.6 GB, Kokoro ~330 MB + 54 voices). Background first-run download - resumable, checksum-verified, progress-visible - ported from v1 Provisioning. Download starts silently on the onboarding welcome screen.

## Agents

14. **Two agent kinds** (the load-bearing product insight): **[ADR]**
    - **Task Agent** (M5): ordinary LLM + tool calls (open URL, AppleScript/shell, files; later MCP). Never touches input devices/screen -> runs in background, several in parallel, notifies on completion. No computer-use model needed.
    - **Screen Agent** (M2): computer-use model driving the real mouse/keyboard in a screenshot->Action loop. Foreground, exclusive, confirm-gated. The fallback for un-scriptable GUI tasks; also covers quick one-shot focused actions ("type this where my cursor is") as the trivial 1-step case.
    - **Lune picks automatically, tools-first, screen-as-fallback.** The user never selects a mode.
15. **Safety carried from v1:** Confirm Gates (confirm-to-start + per-consequential-action; cancel always beats approve; ambiguous voice never approves) and Consequence Level = max(model tag, escalate-only floor). Task Agents get an analogous gate for dangerous tool calls (non-allowlisted shell commands).
16. **M5 ordered before M6** (Task Agents before integrations) at owner's request; MCP servers are the integration mechanism (Spotify, Obsidian, Google Sheets = more tools for Task Agents).

## UI surfaces

17. **Four surfaces:** **Pill** (thin always-on-top floating bar, top-center under the notch/menu bar, draggable, hover-expands into menus - replaces the menu-bar icon), **Chat Panel** (unified voice+text conversation; text input; dropdown of last 10 chats), **Agent Stack** (Task Agent status cards, fixed top-right, stacking, dismissable when done), **Overlay** (click-through layer: playful cursor, pointing, drawing later, response bubble).
18. **One conversation, two input methods:** voice turns appear as transcribed text in the same history as typed turns.
19. **Persistence: last 10 conversations, text only** - never audio, never screenshots. Oldest auto-deleted. A resumed conversation starts with fresh screen context.
20. **"Show streaming text" setting** controls the Overlay response bubble; the Chat Panel always shows text.

## Interaction

21. **Push-to-talk kept verbatim from v1:** hold ctrl+option to talk, release to send; batch transcription on release; barge-in on hotkey during playback. **All hotkeys configurable in Settings**; no wake word; no toggle-to-talk. Recording indicated on Pill and Overlay.
22. **Onboarding flow:** Welcome (download silently starts) -> Keys (mandatory; at least one Vendor; live-validated; "get a key" links) -> Permissions (mic + screen recording, live-detected; Accessibility deferred to first Screen Agent run in M2) -> Download progress with tutorial cards -> ready moment. Text chat unlocks after the permissions step, before the download finishes.
23. **Backlog delight:** Farza-style intro video that rides along the cursor (small ~400x600 video following the pointer) - post-M1 Overlay ticket.

## First ticket

24. **M1 starts with a walking skeleton:** empty Pill + one typed IPC round-trip + one streamed Gemini reply in a bare panel - proving the whole architecture end-to-end before any surface is built out.
