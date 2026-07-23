import { describe, expect, it } from "vitest";

import {
  REASONING_VENDORS,
  validateReasoningKey,
  type UpstreamFetch,
} from "../src/index";

/**
 * Unit tests for the cheap key-validation call the onboarding key step uses (ticket 14:
 * "invalid key gives instant, specific feedback"). They drive it exactly as the main
 * process does, stubbing only the injected `upstreamFetch` boundary - a canned Vendor
 * response, no network, no real key - and assert both the verdict and that the call it
 * makes is genuinely cheap (the routed Vendor's endpoint, its auth header, a tiny body).
 */

/** A recorded outbound call the validator made to its stubbed Vendor boundary. */
interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

/** A stub Vendor boundary that records the call and returns the given canned response. */
function makeStubFetch(response: Response | (() => Promise<Response>)): {
  upstreamFetch: UpstreamFetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const upstreamFetch: UpstreamFetch = async (url, requestInit) => {
    const headers: Record<string, string> = {};
    new Headers(requestInit?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({ url, headers, body: typeof requestInit?.body === "string" ? requestInit.body : null });
    return typeof response === "function" ? response() : response;
  };
  return { upstreamFetch, calls };
}

describe("validateReasoningKey", () => {
  it("accepts a key when the Vendor responds OK", async () => {
    const { upstreamFetch, calls } = makeStubFetch(new Response("ok", { status: 200 }));

    const result = await validateReasoningKey({
      vendor: REASONING_VENDORS.google,
      apiKey: "test-key",
      upstreamFetch,
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it("makes a cheap call to the routed Vendor's endpoint with its auth and default model", async () => {
    const { upstreamFetch, calls } = makeStubFetch(new Response("ok", { status: 200 }));

    await validateReasoningKey({
      vendor: REASONING_VENDORS.anthropic,
      apiKey: "secret-anthropic",
      upstreamFetch,
    });

    const [call] = calls;
    expect(call.url).toContain("api.anthropic.com");
    expect(call.headers["x-api-key"]).toBe("secret-anthropic");
    const body = JSON.parse(call.body ?? "{}");
    expect(body.model).toBe(REASONING_VENDORS.anthropic.defaultModel);
    // Cheap: a single-token cap so the probe costs almost nothing.
    expect(body.max_tokens).toBe(1);
  });

  it("uses a provided Model Slot over the Vendor default", async () => {
    const { upstreamFetch, calls } = makeStubFetch(new Response("ok", { status: 200 }));

    await validateReasoningKey({
      vendor: REASONING_VENDORS.openai,
      apiKey: "k",
      modelSlot: "gpt-4o-mini",
      upstreamFetch,
    });

    expect(JSON.parse(calls[0]?.body ?? "{}").model).toBe("gpt-4o-mini");
  });

  it("rejects a blank key without any upstream call", async () => {
    const { upstreamFetch, calls } = makeStubFetch(new Response("ok", { status: 200 }));

    const result = await validateReasoningKey({
      vendor: REASONING_VENDORS.google,
      apiKey: "   ",
      upstreamFetch,
    });

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("explains a rejected key on 401", async () => {
    const { upstreamFetch } = makeStubFetch(new Response("unauthorized", { status: 401 }));

    const result = await validateReasoningKey({
      vendor: REASONING_VENDORS.openai,
      apiKey: "bad",
      upstreamFetch,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("rejected");
      expect(result.reason).toContain("OpenAI");
    }
  });

  it("explains a rate limit on 429", async () => {
    const { upstreamFetch } = makeStubFetch(new Response("slow down", { status: 429 }));

    const result = await validateReasoningKey({
      vendor: REASONING_VENDORS.google,
      apiKey: "k",
      upstreamFetch,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.toLowerCase()).toContain("rate-limit");
    }
  });

  it("includes the Vendor error body for other failures", async () => {
    const { upstreamFetch } = makeStubFetch(
      new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 }),
    );

    const result = await validateReasoningKey({
      vendor: REASONING_VENDORS.openai,
      apiKey: "k",
      upstreamFetch,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("404");
      expect(result.reason).toContain("model not found");
    }
  });

  it("reports an unreachable Vendor as a connection problem", async () => {
    const { upstreamFetch } = makeStubFetch(() => Promise.reject(new Error("network down")));

    const result = await validateReasoningKey({
      vendor: REASONING_VENDORS.anthropic,
      apiKey: "k",
      upstreamFetch,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.toLowerCase()).toContain("couldn't reach");
    }
  });

  it("rethrows an abort so a cancellation is not mistaken for a rejection", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    const { upstreamFetch } = makeStubFetch(() => Promise.reject(abortError));

    await expect(
      validateReasoningKey({ vendor: REASONING_VENDORS.google, apiKey: "k", upstreamFetch }),
    ).rejects.toThrow("aborted");
  });
});
