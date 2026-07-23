import {
  DEFAULT_HOTKEY_TOKEN,
  parseHotkeyToken,
  type ParsedHotkey,
} from "../../ipc/hotkey";
import type { GlobalKeyEventSource } from "./globalKeyEventSource";
import { PushToTalkTracker } from "./pushToTalkTracker";

// Wires the platform key source to the pure transition tracker (ticket 11) and surfaces
// just the two moments the voice loop cares about: the push-to-talk chord became held
// ("pressed" - start listening) and stopped being held ("released" - send the clip).
// The configured chord is read live from the routing config on every event (via
// `getHotkeyToken`), so a hotkey change in Settings takes effect immediately - the
// config store reloads on the file write, and the very next key event matches the new
// chord (acceptance: "hotkey is read from config").

export interface PushToTalkMonitorCallbacks {
  /** The chord became fully held: begin recording. */
  onPressed(): void;
  /** The chord stopped being fully held: finalize the recording. */
  onReleased(): void;
}

export interface PushToTalkMonitorDependencies {
  /** The system-wide key event source (production: `uiohook`; the untested edge). */
  keySource: GlobalKeyEventSource;
  /** The live push-to-talk token from the routing config (e.g. "control+alt"). */
  getHotkeyToken: () => string;
}

/** The default chord, parsed once as the fallback when a configured token is unparseable. */
const DEFAULT_PARSED_HOTKEY: ParsedHotkey = parseHotkeyToken(DEFAULT_HOTKEY_TOKEN) ?? {
  modifiers: ["control", "alt"],
  key: null,
};

export class PushToTalkMonitor {
  private readonly tracker: PushToTalkTracker;

  constructor(private readonly dependencies: PushToTalkMonitorDependencies) {
    // The tracker reads the chord live: parse the configured token each evaluation,
    // falling back to the default when it is unparseable, so the hook always matches
    // *some* valid chord rather than going dead on a corrupt config value.
    this.tracker = new PushToTalkTracker(() => this.resolveBinding());
  }

  /** Starts listening for the global hotkey, invoking the callbacks on each edge. */
  start(callbacks: PushToTalkMonitorCallbacks): void {
    this.tracker.reset();
    this.dependencies.keySource.start((event) => {
      const transition = this.tracker.handle(event);
      if (transition === "pressed") {
        callbacks.onPressed();
      } else if (transition === "released") {
        callbacks.onReleased();
      }
    });
  }

  /** Stops the global hook and clears held state. */
  stop(): void {
    this.dependencies.keySource.stop();
    this.tracker.reset();
  }

  private resolveBinding(): ParsedHotkey {
    return parseHotkeyToken(this.dependencies.getHotkeyToken()) ?? DEFAULT_PARSED_HOTKEY;
  }
}
