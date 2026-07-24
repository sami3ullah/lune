import { z } from "zod";

// The Shell's own renderer <-> main IPC for the Settings surface (ticket 13). Like
// pill-control, screen-permission, and overlay, these messages never reach the Core:
// opening a window, writing the config file the Core watches, and reading/writing the
// OS keychain are Shell concerns a future HTTP adapter fronting the Core would never
// carry. They stay out of @lune/shared but are still fully zod-typed so nothing
// untyped crosses the process boundary (developer story 46).
//
// This module is imported by the preload, so it deliberately imports no @lune/core:
// the wire-level Vendor id enum is a small local contract, and the human-facing Vendor
// catalog (display names, curated Model Slot shortlists) is passed *from* the main
// process (which reads the Core Vendor table) in the snapshot, so the Core stays the
// single source of truth for that data without the renderer or preload importing it.

/** Renderer -> main (send): open the Settings window, or hide it if already open. */
export const SETTINGS_TOGGLE_CHANNEL = "lune:settings:toggle";

/** Renderer -> main (invoke): read the full current Settings snapshot (opens fresh). */
export const SETTINGS_GET_CHANNEL = "lune:settings:get";

/** Renderer -> main (invoke): persist edited Vendor/Model/Voice/hotkey/streaming values. */
export const SETTINGS_SAVE_CHANNEL = "lune:settings:save";

/** Renderer -> main (invoke): set or clear one Vendor's API key in OS-encrypted storage. */
export const SETTINGS_SET_KEY_CHANNEL = "lune:settings:set-key";

/**
 * Renderer -> main (invoke): live-validate a candidate Vendor key with a cheap test
 * call and, if it works, store it (routing the Vendor when the currently-routed one has
 * no key). The Settings surface uses this in place of a raw {@link SETTINGS_SET_KEY_CHANNEL}
 * store so adding a key gives the same instant, specific feedback onboarding does; the
 * set-key channel remains for *clearing* a key (an empty value never needs validating).
 */
export const SETTINGS_VALIDATE_KEY_CHANNEL = "lune:settings:validate-key";

/**
 * Renderer -> main (invoke): list a Vendor's live models (using its stored key), so the
 * Settings picker offers the models the Vendor currently serves rather than a hardcoded
 * shortlist that drifts as Vendors add and retire models.
 */
export const SETTINGS_LIST_MODELS_CHANNEL = "lune:settings:list-models";

/** Renderer -> main (invoke): re-run/repair Provisioning (re-download broken weights). */
export const SETTINGS_REPAIR_CHANNEL = "lune:settings:repair";

/** Renderer -> main (invoke): read just the live readiness rows (for polling download %). */
export const SETTINGS_READINESS_CHANNEL = "lune:settings:readiness";

/** The renderer-route hash the main process loads the Settings window with. */
export const SETTINGS_ROUTE_HASH = "settings";

/**
 * The wire-level cloud Reasoning Vendor ids. This mirrors the Core's
 * `REASONING_VENDOR_IDS` but is declared locally so this contract (and the preload
 * that imports it) never pulls in @lune/core. The human-facing catalog below carries
 * the Core's live Vendor data, so the Core stays the source of truth for anything the
 * user sees.
 */
export const SETTINGS_VENDOR_IDS = ["anthropic", "openai", "google"] as const;
export const SettingsVendorIdSchema = z.enum(SETTINGS_VENDOR_IDS);
export type SettingsVendorId = z.infer<typeof SettingsVendorIdSchema>;

/**
 * Where a user gets an API key for each Vendor (the onboarding key step's "get a key"
 * links, ticket 14). This is Shell/UI data, not Core intelligence, so it lives here in
 * the settings contract - dependency-free. The main process's open-external handler is
 * the sole reader: the renderer sends only a Vendor id and the handler resolves the URL
 * from this fixed map, so no arbitrary renderer-supplied string is ever opened.
 */
export const VENDOR_GET_KEY_URLS: Record<SettingsVendorId, string> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  google: "https://aistudio.google.com/app/apikey",
};

/**
 * The editable Settings values the user changes and the Shell persists to the config
 * file (Vendor + Model Slot + Voice + push-to-talk hotkey, which the Core reads, plus
 * the Shell-only streaming-text toggle). Holds no secrets - API keys go through the
 * separate {@link SETTINGS_SET_KEY_CHANNEL} into OS-encrypted storage, never this
 * payload. The hotkey is the "+"-joined token the Core stores (e.g. "control+alt"); the
 * editor validates and canonicalizes it before it lands here.
 */
export const SettingsValuesSchema = z.object({
  reasoning: z.object({
    vendor: SettingsVendorIdSchema,
    modelSlot: z.string().min(1),
  }),
  speech: z.object({
    voice: z.string().min(1),
  }),
  /** Whether the Overlay response bubble streams the answer text (voice-only when off). */
  streamingText: z.boolean(),
  /** The push-to-talk hotkey token, e.g. "control+alt". */
  hotkey: z.string().min(1),
});
export type SettingsValues = z.infer<typeof SettingsValuesSchema>;

/** One per-Capability readiness row, mirroring the Core status the Settings rows show. */
export const ReadinessRowSchema = z.object({
  capability: z.enum(["reasoning", "transcription", "speech"]),
  label: z.string(),
  ready: z.boolean(),
  /** "ready", "downloading" (a run in flight), or "not-ready" (needs a key / repair). */
  state: z.enum(["ready", "downloading", "not-ready"]),
  /** A short human-readable explanation, e.g. "No API key" / "Downloading 40%" / "Ready". */
  detail: z.string(),
});
export type ReadinessRow = z.infer<typeof ReadinessRowSchema>;

/** One Vendor as the picker renders it: id + display name + curated Model Slot shortlist. */
export const SettingsVendorSchema = z.object({
  id: SettingsVendorIdSchema,
  displayName: z.string(),
  defaultModel: z.string(),
  modelShortlist: z.array(z.string()),
});
export type SettingsVendor = z.infer<typeof SettingsVendorSchema>;

/** The static catalog the pickers render from (from the Core Vendor table + Voice list). */
export const SettingsCatalogSchema = z.object({
  vendors: z.array(SettingsVendorSchema),
  voices: z.array(z.string()),
});
export type SettingsCatalog = z.infer<typeof SettingsCatalogSchema>;

/**
 * The dynamic Settings state that changes as the user edits: the persisted values,
 * which Vendors currently have a key (drives selectability - a keyed Vendor is
 * selectable, an unkeyed one is disabled), and the live readiness rows. Returned by
 * every mutating call so the UI always re-renders from one consistent view.
 */
export const SettingsStateSchema = z.object({
  values: SettingsValuesSchema,
  keyedVendors: z.array(SettingsVendorIdSchema),
  readiness: z.array(ReadinessRowSchema),
});
export type SettingsState = z.infer<typeof SettingsStateSchema>;

/** The full snapshot the Settings window reads on open: the static catalog + live state. */
export const SettingsSnapshotSchema = SettingsStateSchema.extend({
  catalog: SettingsCatalogSchema,
});
export type SettingsSnapshot = z.infer<typeof SettingsSnapshotSchema>;

/** Renderer -> main payload to set (non-empty) or clear (empty) one Vendor's API key. */
export const SetApiKeyRequestSchema = z.object({
  vendor: SettingsVendorIdSchema,
  /** The raw key to store; an empty/blank string clears the stored key for this Vendor. */
  key: z.string(),
});
export type SetApiKeyRequest = z.infer<typeof SetApiKeyRequestSchema>;

/**
 * The verdict of a cheap key-validation call: usable, or an explained rejection. This is
 * the wire codec mirroring the Core's `KeyValidationResult` (which the Core owns as a
 * plain type, since @lune/core carries no zod). It lives here in the settings contract -
 * the shared home for key management - and the onboarding contract re-exports it, so both
 * surfaces validate keys through one shape.
 */
export const KeyValidationResultSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.string().min(1) }),
]);
export type KeyValidationResultValue = z.infer<typeof KeyValidationResultSchema>;

/** Renderer -> main payload to validate (and, on success, store) one Vendor's key. */
export const ValidateKeyRequestSchema = z.object({
  vendor: SettingsVendorIdSchema,
  key: z.string(),
});
export type ValidateKeyRequest = z.infer<typeof ValidateKeyRequestSchema>;

/**
 * The reply to a validate-key call: the verdict plus the resulting Settings state (so a
 * successful save immediately reflects the newly-keyed - and possibly newly-routed -
 * Vendor without a second round-trip).
 */
export const ValidateKeyResponseSchema = z.object({
  result: KeyValidationResultSchema,
  state: SettingsStateSchema,
});
export type ValidateKeyResponse = z.infer<typeof ValidateKeyResponseSchema>;

/** Renderer -> main payload to list one Vendor's live models (uses its stored key). */
export const ListModelsRequestSchema = z.object({
  vendor: SettingsVendorIdSchema,
});
export type ListModelsRequest = z.infer<typeof ListModelsRequestSchema>;

/**
 * The reply to a list-models call: the live model ids (featured first), or an explained
 * failure the picker shows in place of the dropdown. Mirrors the Core's `ModelListResult`.
 */
export const ListModelsResponseSchema = z.union([
  z.object({ ok: z.literal(true), models: z.array(z.string()) }),
  z.object({ ok: z.literal(false), reason: z.string().min(1) }),
]);
export type ListModelsResponse = z.infer<typeof ListModelsResponseSchema>;
