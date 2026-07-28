import { z } from "zod";

// The Shell's own renderer <-> main IPC for the Integrations surface (M6-02). Like Settings
// and Skills, these messages never reach the Core over the wire: opening the window, storing
// OAuth tokens in the OS keychain, and reading/writing the integrations config file under
// userData are all Shell concerns. The Core owns the *mechanism* - the MCP client that
// connects servers, discovers tools, and gates consequential calls (M6-01) - while this
// contract carries only the tab's browse/add/remove/enable/authorize plumbing. It stays out
// of @lune/shared but is fully zod-typed so nothing untyped crosses the process boundary.
//
// This module is imported by the preload, so it deliberately imports no @lune/core: the few
// Core enums it needs (the server status, the transport kind) are mirrored here as tiny local
// contracts - the same way the Skills contract mirrors `SkillSource` - keeping the Core the
// single source of truth for the model while leaving the wire codec dependency-free.

/** Renderer -> main (send): open the Integrations window, or hide it if already open. */
export const INTEGRATIONS_TOGGLE_CHANNEL = "lune:integrations:toggle";

/** Renderer -> main (invoke): read every preset and configured integration for the tab. */
export const INTEGRATIONS_LIST_CHANNEL = "lune:integrations:list";

/** Renderer -> main (invoke): add an integration (from a preset, or a custom server). */
export const INTEGRATIONS_ADD_CHANNEL = "lune:integrations:add";

/** Renderer -> main (invoke): remove an integration entirely (config + stored secrets). */
export const INTEGRATIONS_REMOVE_CHANNEL = "lune:integrations:remove";

/** Renderer -> main (invoke): turn one integration on or off (connect / disconnect). */
export const INTEGRATIONS_SET_ENABLED_CHANNEL = "lune:integrations:set-enabled";

/** Renderer -> main (invoke): re-attempt one integration's connection (the retry after an error). */
export const INTEGRATIONS_REFRESH_CHANNEL = "lune:integrations:refresh";

/** Renderer -> main (invoke): save (or clear) one integration's guided credential values. */
export const INTEGRATIONS_SET_CREDENTIALS_CHANNEL = "lune:integrations:set-credentials";

/** Renderer -> main (invoke): begin (or renew) an OAuth integration's sign-in flow. */
export const INTEGRATIONS_START_AUTH_CHANNEL = "lune:integrations:start-auth";

/** Renderer -> main (send): open an integration's help page (a docs URL) in the system browser. */
export const INTEGRATIONS_OPEN_DOCS_CHANNEL = "lune:integrations:open-docs";

/** The payload for {@link INTEGRATIONS_OPEN_DOCS_CHANNEL}: an http(s) help URL to open externally. */
export const OpenDocsRequestSchema = z.object({
  url: z.string().url().refine((value) => /^https?:\/\//i.test(value), "Only http(s) links can be opened."),
});
export type OpenDocsRequest = z.infer<typeof OpenDocsRequestSchema>;

/** Main -> renderer (send): a live integrations snapshot, pushed whenever any server's state changes. */
export const INTEGRATIONS_EVENT_CHANNEL = "lune:integrations:event";

/** The renderer-route hash the main process loads the Integrations window with. */
export const INTEGRATIONS_ROUTE_HASH = "integrations";

/**
 * One configured server's health, mirroring the Core's `McpServerStatus` (declared locally so
 * this contract and the preload never pull in @lune/core). `auth-expired` is the sign-in
 * state an OAuth server lands in with no/expired token; `error` is any other failure.
 */
export const IntegrationStatusSchema = z.enum([
  "disabled",
  "connecting",
  "ready",
  "auth-expired",
  "error",
]);
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;

/**
 * How an integration authenticates: `none` (nothing to provide - a local or public server),
 * `credentials` (the user pastes one or more values, guided by the fields below), or `oauth`
 * (a one-click browser sign-in whose tokens land in encrypted OS storage).
 */
export const IntegrationAuthKindSchema = z.enum(["none", "credentials", "oauth"]);
export type IntegrationAuthKind = z.infer<typeof IntegrationAuthKindSchema>;

/** A loose grouping for the catalog, so related apps sit together in the "Add" list. */
export const IntegrationCategorySchema = z.enum([
  "music",
  "notes",
  "productivity",
  "email",
  "developer",
  "other",
]);
export type IntegrationCategory = z.infer<typeof IntegrationCategorySchema>;

/**
 * One value a `credentials` (or `oauth`, for its client details) integration needs, described
 * for guided entry: a stable `key`, a short `label`, `help` text that walks a non-technical
 * user through obtaining it, an optional `docsUrl` to the provider's page, whether it is a
 * `secret` (masked in the field and stored encrypted), and whether it is `required`.
 */
export const CredentialFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  help: z.string().min(1),
  placeholder: z.string().optional(),
  docsUrl: z.string().url().optional(),
  secret: z.boolean(),
  required: z.boolean(),
});
export type CredentialField = z.infer<typeof CredentialFieldSchema>;

/** One tool a ready integration contributes, as the tab lists it. */
export const IntegrationToolSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
});
export type IntegrationTool = z.infer<typeof IntegrationToolSchema>;

/**
 * One catalog entry in the "Add an app" list: everything the tab needs to present a preset
 * and start adding it. `added` is set when the user already has this preset configured, so the
 * catalog can show it as done rather than offering a duplicate.
 */
export const IntegrationPresetSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
  category: IntegrationCategorySchema,
  authKind: IntegrationAuthKindSchema,
  credentialFields: z.array(CredentialFieldSchema),
  /** A friendly one-line summary of what signing in / providing details will involve. */
  setupHint: z.string().optional(),
  added: z.boolean(),
});
export type IntegrationPreset = z.infer<typeof IntegrationPresetSchema>;

/**
 * One configured integration as the tab renders it: its identity and description, whether it
 * is turned on, its live connection status + tools (M6-01's manager is the source of truth),
 * and its auth picture - the kind, whether it is currently authorized (a token/credentials are
 * present), and the guided fields to collect when it is not.
 */
export const IntegrationSchema = z.object({
  id: z.string().min(1),
  /** The preset this was added from, if any (absent for a custom server). */
  presetId: z.string().optional(),
  displayName: z.string().min(1),
  description: z.string(),
  category: IntegrationCategorySchema,
  enabled: z.boolean(),
  status: IntegrationStatusSchema,
  toolCount: z.number().int().nonnegative(),
  tools: z.array(IntegrationToolSchema),
  error: z.string().optional(),
  authKind: IntegrationAuthKindSchema,
  /** Whether the integration currently has what it needs to authenticate (token / required creds). */
  authorized: z.boolean(),
  credentialFields: z.array(CredentialFieldSchema),
  /** Which credential keys currently have a stored value (never the values themselves). */
  providedCredentialKeys: z.array(z.string()),
});
export type Integration = z.infer<typeof IntegrationSchema>;

/** The tab's whole state: the addable catalog and the user's configured integrations. */
export const IntegrationsSnapshotSchema = z.object({
  presets: z.array(IntegrationPresetSchema),
  integrations: z.array(IntegrationSchema),
});
export type IntegrationsSnapshot = z.infer<typeof IntegrationsSnapshotSchema>;

/** A custom (non-preset) server's transport, mirroring the Core's `McpTransportConfig` shape. */
export const CustomTransportSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("http"),
    url: z.string().url(),
  }),
]);
export type CustomTransport = z.infer<typeof CustomTransportSchema>;

/**
 * Renderer -> main: add an integration. Either instantiate a preset by id, or register a
 * custom server the user describes by hand (no secrets - a custom server that needs auth is a
 * preset's job, so the guided fields exist).
 */
export const AddIntegrationRequestSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("preset"), presetId: z.string().min(1) }),
  z.object({
    source: z.literal("custom"),
    displayName: z.string().min(1),
    transport: CustomTransportSchema,
  }),
]);
export type AddIntegrationRequest = z.infer<typeof AddIntegrationRequestSchema>;

/** Renderer -> main payload naming one configured integration by id. */
export const IntegrationIdRequestSchema = z.object({ id: z.string().min(1) });
export type IntegrationIdRequest = z.infer<typeof IntegrationIdRequestSchema>;

/** Renderer -> main payload to turn one integration on or off. */
export const SetIntegrationEnabledRequestSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
});
export type SetIntegrationEnabledRequest = z.infer<typeof SetIntegrationEnabledRequestSchema>;

/**
 * Renderer -> main payload to save one integration's guided credential values. A key mapped to
 * an empty string clears that value; omitted keys are left unchanged. Values are handed
 * straight to encrypted OS storage and never persisted in the config file.
 */
export const SetIntegrationCredentialsRequestSchema = z.object({
  id: z.string().min(1),
  values: z.record(z.string()),
});
export type SetIntegrationCredentialsRequest = z.infer<typeof SetIntegrationCredentialsRequestSchema>;

/** The verdict of a credential save or an OAuth sign-in: whether it worked, with a reason when not. */
export const IntegrationActionResultSchema = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
});
export type IntegrationActionResult = z.infer<typeof IntegrationActionResultSchema>;

/**
 * The reply to an action that both reports its own verdict and refreshes the tab: the
 * `result` (did the sign-in / save succeed?) alongside the new full `snapshot`, so the store
 * applies one consistent view without a second round-trip (mirrors Settings' validate-key).
 */
export const IntegrationActionResponseSchema = z.object({
  result: IntegrationActionResultSchema,
  snapshot: IntegrationsSnapshotSchema,
});
export type IntegrationActionResponse = z.infer<typeof IntegrationActionResponseSchema>;
