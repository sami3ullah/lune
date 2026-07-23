import { z } from "zod";
import { SettingsStateSchema, SettingsVendorIdSchema } from "./settings";

// The Shell's own renderer <-> main IPC for the onboarding surface (ticket 14). Like the
// settings and permission channels, these never reach the Core: opening the onboarding
// window, live-validating + storing a key, driving the background download, and
// remembering completion are Shell concerns a future HTTP adapter fronting the Core
// would never carry. They stay out of @lune/shared but are still fully zod-typed so
// nothing untyped crosses the process boundary (developer story 46). The static picker
// catalog, keyed Vendors, and per-Capability readiness reuse the settings contract
// (`SETTINGS_GET_CHANNEL`) rather than being duplicated here.

/** The renderer-route hash the main process loads the onboarding window with. */
export const ONBOARDING_ROUTE_HASH = "onboarding";

/**
 * Renderer -> main (invoke): live-validate a candidate Vendor key with a cheap test
 * call and, if it works, store it in OS-encrypted storage (routing the Vendor if the
 * currently-routed one has no key). The key step cannot be skipped, so this is the only
 * way past it.
 */
export const ONBOARDING_VALIDATE_KEY_CHANNEL = "lune:onboarding:validate-key";

/**
 * Renderer -> main (send): start (or resume) the background model download. Called when
 * the welcome screen appears so the ~2 GB arrives while the user completes the other
 * steps; idempotent, so a resumed onboarding picks up partial downloads rather than
 * restarting them.
 */
export const ONBOARDING_START_DOWNLOAD_CHANNEL = "lune:onboarding:start-download";

/** Renderer -> main (invoke): read the download step's live progress / preflight state. */
export const ONBOARDING_DOWNLOAD_STATUS_CHANNEL = "lune:onboarding:download-status";

/** Renderer -> main (send): mark onboarding complete and close the window. */
export const ONBOARDING_COMPLETE_CHANNEL = "lune:onboarding:complete";

/** Renderer -> main (send): open one Vendor's "get a key" page in the default browser. */
export const ONBOARDING_OPEN_GET_KEY_CHANNEL = "lune:onboarding:open-get-key";

/**
 * The verdict of a cheap key-validation call: usable, or an explained rejection. This is
 * the wire codec mirroring the Core's `KeyValidationResult` (which the Core owns as a
 * plain type, since @lune/core carries no zod); the two are kept in the same shape so the
 * Core verdict crosses this boundary unchanged.
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

/** The onboarding download step's view of the one Provisioning run. */
export const OnboardingDownloadStatusSchema = z.object({
  percent: z.number(),
  phase: z.enum(["idle", "running", "succeeded", "failed", "cancelled"]),
  complete: z.boolean(),
  preflightFailure: z.object({ reason: z.string(), detail: z.string() }).optional(),
});
export type OnboardingDownloadStatusValue = z.infer<typeof OnboardingDownloadStatusSchema>;
