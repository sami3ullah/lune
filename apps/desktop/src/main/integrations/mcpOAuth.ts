import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { IntegrationActionResult } from "../../ipc/integrations";
import type { McpSecretStore } from "./mcpSecretStore";

// The MCP OAuth coordinator (M6-02): the "Connect" flow for OAuth-protected HTTP integrations
// (Google Sheets/Docs/Gmail), delegating the OAuth machinery to the official MCP SDK's
// authorization support rather than hard-coding any provider's endpoints. That is what keeps
// sign-in "dead simple" (a browser window, click Allow) and provider-agnostic: the SDK does
// discovery, dynamic client registration, PKCE, the code exchange, and token refresh; the
// Shell supplies only the three effects the SDK cannot: opening the system browser, catching
// the loopback redirect, and persisting tokens in OS-encrypted storage (never a file).
//
// The same `OAuthClientProvider` this builds is handed to the MCP connector for ordinary
// connections, so a stored token is used (and silently refreshed) on every launch; when it is
// missing or a refresh fails, the connector surfaces `auth-expired` and the user re-connects.
//
// NOTE: the pure pieces (callback parsing, token persistence) are unit-tested; the live
// browser + loopback + code-exchange dance is exercised against a real provider on a real
// machine, not in this headless test environment.

/** The fixed loopback redirect the OAuth flow returns to (must match a registered redirect URI). */
export const OAUTH_REDIRECT_PORT = 33418;
export const OAUTH_REDIRECT_URL = `http://127.0.0.1:${OAUTH_REDIRECT_PORT}/callback`;

/** How long to wait for the user to finish the browser sign-in before giving up. */
const DEFAULT_AUTH_TIMEOUT_MS = 3 * 60 * 1000;

/** The secret-store key one integration's OAuth token bundle lives under. */
export function oauthTokenKey(integrationId: string): string {
  return `${integrationId}::oauth`;
}

/** The secret-store key one integration's dynamically-registered client info lives under. */
export function oauthClientKey(integrationId: string): string {
  return `${integrationId}::oauth-client`;
}

/**
 * The parsed result of the provider's loopback redirect: the `code` to exchange, the `state`
 * to check against the one we sent, or an `error` the authorization server returned.
 */
export interface OAuthCallbackResult {
  code?: string;
  state?: string;
  error?: string;
}

/** Reads the callback query into an {@link OAuthCallbackResult}. Pure, so it is unit tested without a live server. */
export function parseOAuthCallbackUrl(rawUrl: string): OAuthCallbackResult {
  let url: URL;
  try {
    url = new URL(rawUrl, OAUTH_REDIRECT_URL);
  } catch {
    return { error: "Malformed authorization callback." };
  }
  const params = url.searchParams;
  const error = params.get("error");
  if (error !== null) {
    return { error: params.get("error_description") ?? error };
  }
  return {
    code: params.get("code") ?? undefined,
    state: params.get("state") ?? undefined,
  };
}

/** A one-shot catcher for the OAuth redirect: what the coordinator awaits after opening the browser. */
export interface RedirectCatcher {
  /** The loopback URL the authorization server redirects back to. */
  readonly redirectUrl: string;
  /** Resolves with the parsed callback once the browser hits the loopback (or rejects on timeout/abort). */
  waitForRedirect(signal: AbortSignal): Promise<OAuthCallbackResult>;
  /** Tears down the loopback server. */
  close(): void;
}

/** Opens a catcher (injected so a test can supply a fake in place of the real loopback server). */
export type CreateRedirectCatcher = () => Promise<RedirectCatcher>;

/** The service-facing coordinator: register OAuth servers, check/obtain/forget their tokens. */
export interface McpOAuthCoordinator {
  /** Records that one integration is an OAuth server reachable at `serverUrl` (needed to sign in / attach the provider). */
  register(integrationId: string, serverUrl: string): void;
  /** Whether a usable token bundle is stored for this integration. */
  hasTokens(integrationId: string): boolean;
  /** Runs (or renews) the browser sign-in for one integration, storing the resulting tokens. */
  authorize(integrationId: string): Promise<IntegrationActionResult>;
  /** Drops one integration's stored tokens, client registration, and cached provider (full cleanup). */
  forget(integrationId: string): void;
}

/** The coordinator plus the connector-facing accessor for one integration's auth provider. */
export interface McpOAuthCoordinatorInternal extends McpOAuthCoordinator {
  /** The OAuth provider for a registered OAuth integration, or `undefined` for a non-OAuth server. */
  getAuthProvider(integrationId: string): OAuthClientProvider | undefined;
}

/** The injected boundaries the coordinator is built from. */
export interface McpOAuthCoordinatorDependencies {
  /** The OS-encrypted store the provider reads/writes tokens and client info through. */
  secretStore: McpSecretStore;
  /** Opens the system browser at the authorization URL (Electron's `shell.openExternal`). */
  openExternal: (url: string) => void | Promise<void>;
  /** Opens the loopback redirect catcher; defaults to a real localhost HTTP server. */
  createRedirectCatcher?: CreateRedirectCatcher;
  /** The client name presented to authorization servers. */
  clientName?: string;
  /** Sign-in timeout; defaults to three minutes. */
  authTimeoutMs?: number;
}

/**
 * Builds the OAuth coordinator. It owns one {@link OAuthClientProvider} per registered OAuth
 * integration, backed by the encrypted secret store, and drives the sign-in flow through the
 * MCP SDK.
 */
export function createMcpOAuthCoordinator(
  dependencies: McpOAuthCoordinatorDependencies,
): McpOAuthCoordinatorInternal {
  const { secretStore, openExternal } = dependencies;
  const clientName = dependencies.clientName ?? "Lune";
  const authTimeoutMs = dependencies.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const createCatcher = dependencies.createRedirectCatcher ?? createLoopbackRedirectCatcher;

  /** Registered OAuth servers: integration id -> server URL. */
  const serverUrls = new Map<string, string>();
  /** One provider per integration, cached so the SDK reuses saved tokens/PKCE within a flow. */
  const providers = new Map<string, EncryptedOAuthClientProvider>();

  function providerFor(integrationId: string): EncryptedOAuthClientProvider {
    let provider = providers.get(integrationId);
    if (provider === undefined) {
      provider = new EncryptedOAuthClientProvider(integrationId, secretStore, openExternal, clientName);
      providers.set(integrationId, provider);
    }
    return provider;
  }

  async function authorize(integrationId: string): Promise<IntegrationActionResult> {
    const serverUrl = serverUrls.get(integrationId);
    if (serverUrl === undefined) {
      return { ok: false, reason: "This integration is not an OAuth app." };
    }
    const provider = providerFor(integrationId);
    const catcher = await createCatcher();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), authTimeoutMs);
    try {
      const transport = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider });
      const client = new Client({ name: clientName, version: "0.0.0" });
      try {
        // With a valid/refreshable stored token the connection just succeeds - already signed in.
        await client.connect(transport);
        await client.close();
        return { ok: true };
      } catch (error) {
        if (!(error instanceof UnauthorizedError)) {
          return { ok: false, reason: errorMessage(error) };
        }
        // The provider has opened the browser; wait for the loopback redirect, then exchange.
        const callback = await provider.awaitRedirect(catcher, abort.signal);
        if (callback.error !== undefined) {
          return { ok: false, reason: callback.error };
        }
        if (callback.code === undefined) {
          return { ok: false, reason: "No authorization code was returned." };
        }
        await transport.finishAuth(callback.code);
        await transport.close();
        return { ok: true };
      }
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    } finally {
      clearTimeout(timer);
      catcher.close();
    }
  }

  return {
    register(integrationId, serverUrl) {
      serverUrls.set(integrationId, serverUrl);
    },
    hasTokens(integrationId) {
      return secretStore.has(oauthTokenKey(integrationId));
    },
    authorize,
    forget(integrationId) {
      providers.delete(integrationId);
      serverUrls.delete(integrationId);
      secretStore.remove(oauthTokenKey(integrationId));
      secretStore.remove(oauthClientKey(integrationId));
    },
    getAuthProvider(integrationId) {
      // A provider is attached only for known OAuth servers; a plain HTTP server gets none, so
      // it is never dragged into an authorization flow it does not speak.
      return serverUrls.has(integrationId) ? providerFor(integrationId) : undefined;
    },
  };
}

/**
 * An {@link OAuthClientProvider} whose tokens and dynamic client registration persist in the
 * OS-encrypted secret store, and whose "redirect" opens the system browser. The PKCE code
 * verifier and CSRF state are per-flow and kept in memory. One instance per integration.
 */
class EncryptedOAuthClientProvider implements OAuthClientProvider {
  private codeVerifierValue: string | undefined;
  private stateValue: string | undefined;

  constructor(
    private readonly integrationId: string,
    private readonly secretStore: McpSecretStore,
    private readonly openExternal: (url: string) => void | Promise<void>,
    private readonly clientName: string,
  ) {}

  get redirectUrl(): string {
    return OAUTH_REDIRECT_URL;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.clientName,
      redirect_uris: [OAUTH_REDIRECT_URL],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // A public native client: no client secret, security carried by PKCE.
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    if (this.stateValue === undefined) {
      this.stateValue = randomBytes(16).toString("hex");
    }
    return this.stateValue;
  }

  clientInformation(): OAuthClientInformationFull | undefined {
    const raw = this.secretStore.get(oauthClientKey(this.integrationId));
    if (raw === undefined) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as OAuthClientInformationFull;
    } catch {
      return undefined;
    }
  }

  saveClientInformation(clientInformation: OAuthClientInformationFull): void {
    this.secretStore.set(oauthClientKey(this.integrationId), JSON.stringify(clientInformation));
  }

  tokens(): OAuthTokens | undefined {
    const raw = this.secretStore.get(oauthTokenKey(this.integrationId));
    if (raw === undefined) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as OAuthTokens;
    } catch {
      return undefined;
    }
  }

  saveTokens(tokens: OAuthTokens): void {
    this.secretStore.set(oauthTokenKey(this.integrationId), JSON.stringify(tokens));
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.openExternal(authorizationUrl.toString());
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.codeVerifierValue = codeVerifier;
  }

  codeVerifier(): string {
    if (this.codeVerifierValue === undefined) {
      throw new Error("No PKCE code verifier is in progress.");
    }
    return this.codeVerifierValue;
  }

  /** Waits for the loopback redirect and checks the CSRF state against the one we issued. */
  async awaitRedirect(catcher: RedirectCatcher, signal: AbortSignal): Promise<OAuthCallbackResult> {
    const result = await catcher.waitForRedirect(signal);
    if (result.error === undefined && this.stateValue !== undefined && result.state !== this.stateValue) {
      return { error: "The sign-in response did not match this request (state mismatch)." };
    }
    return result;
  }
}

/**
 * The real loopback redirect catcher: a one-shot localhost HTTP server on the fixed redirect
 * port. It resolves with the first callback it receives and shows the user a "you can close
 * this" page. Not exercised in the headless test suite (it binds a real port + awaits a real
 * browser); the coordinator injects a fake in tests.
 */
async function createLoopbackRedirectCatcher(): Promise<RedirectCatcher> {
  let resolve: ((value: OAuthCallbackResult) => void) | undefined;
  const received = new Promise<OAuthCallbackResult>((r) => {
    resolve = r;
  });

  const server: Server = createServer((request, response) => {
    const parsed = parseOAuthCallbackUrl(request.url ?? "");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><meta charset=utf-8><title>Lune</title>" +
        "<body style=\"font-family:system-ui;background:#171717;color:#e5e5e5;display:grid;place-items:center;height:100vh;margin:0\">" +
        "<div style=\"text-align:center\"><h2>You're all set.</h2><p>You can close this window and return to Lune.</p></div>",
    );
    resolve?.(parsed);
  });

  await new Promise<void>((ready, reject) => {
    server.once("error", reject);
    server.listen(OAUTH_REDIRECT_PORT, "127.0.0.1", ready);
  });

  return {
    redirectUrl: OAUTH_REDIRECT_URL,
    waitForRedirect(signal: AbortSignal) {
      if (signal.aborted) {
        return Promise.reject(new Error("The sign-in timed out."));
      }
      return Promise.race([
        received,
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("The sign-in timed out.")), { once: true });
        }),
      ]);
    },
    close() {
      server.close();
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
