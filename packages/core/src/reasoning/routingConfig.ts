/**
 * The Core's Reasoning routing configuration: which Vendor answers, and with which
 * Model Slot.
 *
 * This is the "single source of truth" config the Shell writes when the user
 * changes a Setting and the Core reads to route each turn. It holds NO secrets:
 * API keys live in the OS keychain and reach the Core through injected accessors,
 * never this config. Reasoning is cloud-only with three Vendors (ADR), and Gemini
 * is the default so a fresh install with a Gemini key works with no configuration.
 *
 * Carried from v1's Sidecar routing config (`snappyConfig.ts`), narrowed to the
 * Reasoning Capability this Core slice owns - Transcription and Speech routing join
 * this model when those local Capabilities are ported. Parsing stays tolerant: the
 * file is user-facing, so a partial or malformed file still yields a complete,
 * usable config rather than crashing the Core.
 */
import { REASONING_VENDORS, REASONING_VENDOR_IDS, type ReasoningVendorId } from "./cloudReasoningVendors.js";
import { DEFAULT_KOKORO_VOICE } from "../speech/kokoroVoices.js";

/**
 * The Vendor values valid for the Reasoning Capability, derived from the one Vendor
 * table so adding a Vendor there makes it selectable here with no second edit.
 */
const VALID_REASONING_VENDOR_IDS: ReadonlySet<string> = new Set(REASONING_VENDOR_IDS);

/** One Capability's selection: which Vendor serves it and which Model Slot to request. */
export interface ReasoningSelection {
  vendor: ReasoningVendorId;
  modelSlot: string;
}

/**
 * The Speech selection: which Kokoro Voice to synthesize answers with. Speech is
 * local-only in Lune (cloud speech vendors were dropped), so there is no Vendor to
 * choose - just the Voice. The Voice is a plain string here (any of Kokoro's 54);
 * the Speech Capability falls back to the default when it is unknown, so the config
 * stays tolerant of a hand-edited or future Voice.
 */
export interface SpeechSelection {
  voice: string;
}

/**
 * The hotkey selection: which chord holds-to-talk (push-to-talk, ticket 11). The
 * chord is a plain "+"-joined token string (e.g. "control+alt") so it is both
 * hand-editable in the config file and simple for the Settings editor (ticket 13) to
 * write. Parsing the string into actual key matching is Shell plumbing (it depends on
 * the platform key source), so the Core just carries the value tolerantly - default
 * ctrl+option, and any non-empty string kept as-is.
 */
export interface HotkeySelection {
  pushToTalk: string;
}

/** The full routing configuration. */
export interface RoutingConfig {
  reasoning: ReasoningSelection;
  speech: SpeechSelection;
  hotkey: HotkeySelection;
}

/**
 * The default push-to-talk chord: ctrl+option (the v1 default, carried verbatim).
 * Held anywhere in the OS to talk, released to send (ticket 11).
 */
export const DEFAULT_PUSH_TO_TALK_HOTKEY = "control+alt";

/**
 * The defaults used when no config file exists yet: Gemini for Reasoning (the "Gemini
 * as default" rule - the first Vendor a fresh install reaches for), Kokoro's flagship
 * Voice for Speech, and ctrl+option for push-to-talk.
 */
export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  reasoning: { vendor: "google", modelSlot: REASONING_VENDORS.google.defaultModel },
  speech: { voice: DEFAULT_KOKORO_VOICE },
  hotkey: { pushToTalk: DEFAULT_PUSH_TO_TALK_HOTKEY },
};

/** A copy of the defaults so callers never mutate the shared constant. */
function cloneDefaultRoutingConfig(): RoutingConfig {
  return {
    reasoning: { ...DEFAULT_ROUTING_CONFIG.reasoning },
    speech: { ...DEFAULT_ROUTING_CONFIG.speech },
    hotkey: { ...DEFAULT_ROUTING_CONFIG.hotkey },
  };
}

/**
 * Validates and merges the Reasoning selection over its default. The Vendor is
 * validated against the legal set (an unknown Vendor falls back to the default),
 * and the Model Slot is kept when a non-empty string, else defaulted - so a partial
 * or slightly wrong selection still yields a usable one.
 */
function mergeReasoningSelection(candidate: unknown): ReasoningSelection {
  const fallback = DEFAULT_ROUTING_CONFIG.reasoning;
  if (candidate === null || typeof candidate !== "object") {
    return { ...fallback };
  }

  const candidateObject = candidate as Record<string, unknown>;

  const vendor =
    typeof candidateObject.vendor === "string" && VALID_REASONING_VENDOR_IDS.has(candidateObject.vendor)
      ? (candidateObject.vendor as ReasoningVendorId)
      : fallback.vendor;

  const modelSlot =
    typeof candidateObject.modelSlot === "string" && candidateObject.modelSlot.trim().length > 0
      ? candidateObject.modelSlot
      : fallback.modelSlot;

  return { vendor, modelSlot };
}

/**
 * Validates and merges the Speech selection over its default. The Voice is kept when
 * it is a non-empty string, else defaulted - so a partial file still yields a usable
 * selection. An unknown-but-present Voice is kept here (not rejected); the Speech
 * Capability applies the known-Voice fallback at synthesis time, matching v1.
 */
function mergeSpeechSelection(candidate: unknown): SpeechSelection {
  const fallback = DEFAULT_ROUTING_CONFIG.speech;
  if (candidate === null || typeof candidate !== "object") {
    return { ...fallback };
  }

  const candidateObject = candidate as Record<string, unknown>;

  const voice =
    typeof candidateObject.voice === "string" && candidateObject.voice.trim().length > 0
      ? candidateObject.voice
      : fallback.voice;

  return { voice };
}

/**
 * Validates and merges the hotkey selection over its default. The push-to-talk chord
 * is kept when it is a non-empty string, else defaulted - so a partial file still
 * yields a usable chord. The chord's exact key tokens are validated at parse time in
 * the Shell (which owns the platform key mapping), matching how the Voice's known-set
 * check happens later at synthesis, not here.
 */
function mergeHotkeySelection(candidate: unknown): HotkeySelection {
  const fallback = DEFAULT_ROUTING_CONFIG.hotkey;
  if (candidate === null || typeof candidate !== "object") {
    return { ...fallback };
  }

  const candidateObject = candidate as Record<string, unknown>;

  const pushToTalk =
    typeof candidateObject.pushToTalk === "string" && candidateObject.pushToTalk.trim().length > 0
      ? candidateObject.pushToTalk
      : fallback.pushToTalk;

  return { pushToTalk };
}

/**
 * Parses the routing config from the file's raw JSON text, merging it over the
 * defaults so a partial or malformed file still yields a complete config. A file
 * that isn't valid JSON, or isn't an object, yields the defaults wholesale.
 */
export function parseRoutingConfig(rawJson: string): RoutingConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return cloneDefaultRoutingConfig();
  }

  if (parsed === null || typeof parsed !== "object") {
    return cloneDefaultRoutingConfig();
  }

  const parsedObject = parsed as Record<string, unknown>;
  return {
    reasoning: mergeReasoningSelection(parsedObject.reasoning),
    speech: mergeSpeechSelection(parsedObject.speech),
    hotkey: mergeHotkeySelection(parsedObject.hotkey),
  };
}

/**
 * Loads the routing config from a file path using an injected file reader, so the
 * load-and-fallback behaviour is testable without a real filesystem. A missing or
 * unreadable file (e.g. before the Shell has written one) yields the defaults.
 */
export function loadRoutingConfig(
  configFilePath: string | undefined,
  readFileText: (path: string) => string,
): RoutingConfig {
  if (configFilePath === undefined || configFilePath.trim().length === 0) {
    return cloneDefaultRoutingConfig();
  }

  let rawJson: string;
  try {
    rawJson = readFileText(configFilePath);
  } catch {
    return cloneDefaultRoutingConfig();
  }

  return parseRoutingConfig(rawJson);
}

/**
 * Holds the live routing config the Capability reads on every turn, and reloads it
 * from the config file on demand. The Electron main process watches the file and
 * calls {@link reload} when it changes, so a Setting the user edits reconciles
 * routing with no restart - the successor of v1's `RoutingConfigStore`.
 */
export class RoutingConfigStore {
  private currentConfig: RoutingConfig;

  constructor(
    private readonly configFilePath: string | undefined,
    private readonly readFileText: (path: string) => string,
  ) {
    this.currentConfig = loadRoutingConfig(configFilePath, readFileText);
  }

  /** The routing config in effect right now. */
  getConfig(): RoutingConfig {
    return this.currentConfig;
  }

  /** Re-reads the config file, adopting the new config (or defaults if it is gone). */
  reload(): RoutingConfig {
    this.currentConfig = loadRoutingConfig(this.configFilePath, this.readFileText);
    return this.currentConfig;
  }
}
