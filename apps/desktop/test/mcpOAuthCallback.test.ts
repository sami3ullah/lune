import { describe, expect, it } from "vitest";

import { parseOAuthCallbackUrl } from "../src/main/integrations/mcpOAuth";

/**
 * Unit tests for the pure half of the OAuth flow: reading the loopback redirect. The rest of
 * the sign-in (browser, code exchange, refresh) is the MCP SDK's and is exercised on a real
 * machine; this pins the one piece of parsing the Shell owns.
 */
describe("parseOAuthCallbackUrl", () => {
  it("extracts the code and state from a success callback", () => {
    expect(parseOAuthCallbackUrl("/callback?code=abc123&state=xyz")).toEqual({
      code: "abc123",
      state: "xyz",
    });
  });

  it("surfaces an OAuth error (preferring the human description)", () => {
    expect(parseOAuthCallbackUrl("/callback?error=access_denied&error_description=User+said+no")).toEqual({
      error: "User said no",
    });
    expect(parseOAuthCallbackUrl("/callback?error=access_denied")).toEqual({ error: "access_denied" });
  });

  it("accepts an absolute loopback URL as well as a bare path", () => {
    expect(parseOAuthCallbackUrl("http://127.0.0.1:33418/callback?code=ok")).toMatchObject({ code: "ok" });
  });

  it("returns no code when none is present", () => {
    expect(parseOAuthCallbackUrl("/callback")).toEqual({ code: undefined, state: undefined });
  });
});
