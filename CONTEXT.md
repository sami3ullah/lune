# Lune

A cross-platform (macOS + Windows) Electron/React rebuild of Lune, renamed **Lune**: an on-screen AI companion you talk or type to, that sees your screen, answers with voice, points at things, and can act on your computer. Reasoning is cloud-only (Anthropic, Gemini, OpenAI - all three can advise *and* act); Speech and Transcription stay local (Kokoro, whisper) with weights downloaded in the background on first run. Personal tool first (bring-your-own-keys), architected so a hosted proxy (users don't need keys) stays possible later.

## Language

**Core**:
The Node/TypeScript service that owns all intelligence: vendor routing, protocol translation, output sanitizing, the agent loop's server half, and sessions. Carried forward (design and tested logic) from v1's "Sidecar", minus everything local/provisioning. The Shell holds no business logic; the Core calls no OS APIs.
_Avoid_: sidecar, backend, server, engine, brain

**Shell**:
The Electron/React front-end layer: window/overlay management, mic capture, screen capture, audio playback, synthetic input execution, settings UI. Does only OS-and-pixels work; everything else lives in the Core.
_Avoid_: client, app, front-end, UI (when precision matters)

**Capability**:
One of the three AI functions the app needs: **Transcription** (speech-to-text, local whisper), **Reasoning** (the vision model that reads the screen, answers, and acts - cloud Vendors), **Speech** (text-to-speech, local Kokoro). Carried from v1.
_Avoid_: feature, module

**Vendor**:
A cloud company serving the Reasoning Capability: Anthropic, Google/Gemini, or OpenAI. All three support both advising and acting in v2. Credentials-gated: only selectable when its API key is present.
_Avoid_: provider (v1 term), backend

**Pill**:
The app's home: a small, thin, always-on-top floating rectangle top-center under the menu bar (under the notch where present), on every Space, draggable. Hover expands it into the menu (Chat Panel, settings, quit). Replaces v1's menu-bar icon.
_Avoid_: HUD, notch bar, widget

**Chat Panel**:
The conversation surface opened from the Pill: one unified history for voice and text turns (spoken input appears as its transcribed text), a text input box, and a dropdown of the last 10 conversations. Text-only persistence - no audio, no screenshots stored; oldest conversation auto-deleted beyond 10. A resumed conversation starts with fresh screen context.
_Avoid_: chat window, main window

**Agent Stack**:
The fixed surface top-right under the menu bar where each running Task Agent shows as a status card, stacking downward. A finished card notifies, opens its result on click, and can be dismissed.
_Avoid_: notification area, task list

**Overlay**:
The full-screen click-through layer hosting the playful cursor, pointing, drawing, waveform, and the ephemeral response bubble. The "show streaming text" setting controls the bubble's text.
_Avoid_: canvas, HUD

**Task Agent**:
An agent that works through **tools only** (web search, open URL, AppleScript/shell, file writes; later MCP integrations) and never touches the user's input devices or screen. Runs in the background, several in parallel; posts a notification when done. Uses ordinary models with tool calling - never a computer-use model.
_Avoid_: background agent, worker

**Screen Agent**:
An agent that drives the user's real GUI - synthetic mouse/keyboard on the focused screen. Foreground and exclusive (one at a time, computer not usable meanwhile), confirm-gated. Multi-step GUI driving uses a computer-use model in a screenshot→Action loop; a quick one-shot focused action (e.g. "type this where my cursor is") is the trivial 1-step case with an ordinary model. The fallback for tasks with no script/API path - Lune prefers Task Agents.
_Avoid_: agent mode (v1 term), computer use (as a product name), autopilot

**Point Tag**:
An inline marker the Reasoning model emits - `[POINT:x,y:label:screenN]` - telling the Overlay to fly the cursor to a screen coordinate and point. Carried from v1, including the canonicalizer that repairs malformed tags and remaps downscaled coordinates. The planned drawing feature (circles, arrows, highlights) extends this same tag grammar.
_Avoid_: marker, annotation

**Barge-in**:
Interrupting Lune while it is speaking: pressing the push-to-talk hotkey during playback stops the voice, aborts the in-flight Reasoning stream (or cancels a running Screen Agent), and starts recording. Carried from v1.
_Avoid_: interrupt, cut off (as jargon)

**Confirm Gate**:
A point where a Screen Agent must get explicit user go-ahead before proceeding - once before touching the OS at all, and again before any consequential Action. Any cancel signal always beats an approve; an ambiguous voice reply never approves. Carried from v1. Task Agents get an analogous gate for dangerous tool calls (e.g. non-allowlisted shell commands).
_Avoid_: prompt, approval step

**Consequence Level**:
The classification of an agent operation as benign or consequential, computed as max(model tag, hardcoded floor) - the floor can only escalate, never downgrade. Consequential operations trip a Confirm Gate. Carried from v1.
_Avoid_: risk level, severity

**Provisioning**:
The background first-run download of the local model weights (whisper ~1.6 GB, Kokoro ~330 MB + voices) - resumable, checksum-verified, with visible progress. The installer ships no weights; local Capabilities are not ready until Provisioning completes. Carried from v1.
_Avoid_: install, setup
