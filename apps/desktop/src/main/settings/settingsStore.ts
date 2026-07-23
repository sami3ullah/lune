import {
  parseRoutingConfig,
  type ReasoningSelection,
  type SpeechSelection,
} from "@lune/core";
import { canonicalHotkeyToken } from "../../ipc/hotkey";

// The Settings persistence seam (ticket 13): the one config file the Shell writes when
// the user changes a Setting and the Core reads to route each turn. The Core owns the
// reasoning/speech/hotkey slice (via its `RoutingConfigStore`, which watches this same
// file and reloads with no restart); the Shell owns the streaming-text toggle, which
// the Core never reads (and its tolerant parse simply ignores). Both parse the file
// tolerantly, so a partial or hand-edited file always yields a complete, usable
// settings object. The Shell canonicalizes the hotkey token with the editor's rules on
// top of the Core's tolerant parse; the config stores it in the Core's `{ pushToTalk }`
// shape so the Core reads it back on the next turn.
//
// Keeping one file with two owners (Core reads its slice, Shell reads the rest) means
// the user has a single settings document, and the Shell is the sole writer - it reads
// the current values, applies the edit, and writes the whole file back, so it can
// never drop the Core's slice. The filesystem is injected so this is testable without
// a real disk. Secrets never appear here - API keys live in the CredentialStore.

/**
 * The full settings document the Shell owns: the Core-read routing slice
 * (reasoning + speech) plus the two Shell-only Settings - the Overlay streaming-text
 * toggle and the push-to-talk hotkey.
 */
export interface AppSettings {
  reasoning: ReasoningSelection;
  speech: SpeechSelection;
  /** Whether the Overlay response bubble shows the streamed answer (off = voice-only). */
  streamingText: boolean;
  /** The push-to-talk hotkey token (e.g. "control+alt"), stored in the Core config. */
  hotkey: string;
}

/** Reads the config file's raw contents, or throws if it is absent. */
export type ReadSettingsFile = (filePath: string) => string;
/** Writes the config file's contents. */
export type WriteSettingsFile = (filePath: string, contents: string) => void;

/** The streaming-text toggle defaults on (the answer bubble shows unless hidden). */
const DEFAULT_STREAMING_TEXT = true;

/**
 * Reads and writes the settings document. Reads always re-parse from disk so a live
 * value (e.g. the streaming-text toggle the Overlay consults per turn) reflects the
 * latest save with no cache to invalidate; the file is tiny, so re-reading is cheap.
 */
export class SettingsStore {
  constructor(
    private readonly filePath: string,
    private readonly readFile: ReadSettingsFile,
    private readonly writeFile: WriteSettingsFile,
  ) {}

  /**
   * The current settings, merged tolerantly over the defaults. A missing or malformed
   * file yields the complete default settings (Gemini reasoning, flagship Voice,
   * streaming on, ctrl+option hotkey) rather than a partial object.
   */
  read(): AppSettings {
    const rawJson = this.readRawJson();
    const routing = parseRoutingConfig(rawJson ?? "");

    let parsedObject: Record<string, unknown> = {};
    if (rawJson !== undefined) {
      try {
        const parsed: unknown = JSON.parse(rawJson);
        if (parsed !== null && typeof parsed === "object") {
          parsedObject = parsed as Record<string, unknown>;
        }
      } catch {
        // Not JSON - the routing slice already fell back to defaults above; the
        // Shell-only fields fall back below.
      }
    }

    return {
      reasoning: routing.reasoning,
      speech: routing.speech,
      streamingText:
        typeof parsedObject.streamingText === "boolean" ? parsedObject.streamingText : DEFAULT_STREAMING_TEXT,
      // The Core parses + defaults the push-to-talk token tolerantly; the Shell then
      // canonicalizes it with the editor's rules (falling back to ctrl+option when the
      // stored token is invalid) so the editor always shows a clean value.
      hotkey: canonicalHotkeyToken(routing.hotkey.pushToTalk),
    };
  }

  /**
   * Persists the whole settings document, pretty-printed for stable diffs. The Shell
   * is the sole writer and always writes the full document, so the Core's routing
   * slice is never dropped by a Shell-only edit. The hotkey is written in the Core's
   * `{ pushToTalk }` shape so the Core reads it back on the next turn.
   */
  write(settings: AppSettings): void {
    const document = {
      reasoning: settings.reasoning,
      speech: settings.speech,
      hotkey: { pushToTalk: settings.hotkey },
      streamingText: settings.streamingText,
    };
    this.writeFile(this.filePath, JSON.stringify(document, null, 2));
  }

  /** The live streaming-text toggle (re-read from disk), for the Overlay bubble gate. */
  getStreamingText(): boolean {
    return this.read().streamingText;
  }

  /** Reads the raw file contents, or `undefined` when it is absent/unreadable. */
  private readRawJson(): string | undefined {
    try {
      return this.readFile(this.filePath);
    } catch {
      return undefined;
    }
  }
}
