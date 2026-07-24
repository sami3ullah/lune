import { describe, expect, it } from "vitest";

import { REASONING_VENDORS, listReasoningModels, type UpstreamFetch } from "../src/index";

/**
 * Unit tests for the live model-catalogue call the Settings picker uses (so a Vendor's
 * models come from the Vendor, not a hardcoded shortlist). They drive it exactly as the
 * main process does, stubbing only the injected `upstreamFetch` boundary - a canned
 * Vendor response, no network, no real key - and assert both the returned catalogue
 * (featured models first, live list truthful) and the specific reasons on failure.
 */

/** A recorded outbound call the lister made to its stubbed Vendor boundary. */
interface RecordedCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
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
    calls.push({ url, method: requestInit?.method, headers, });
    return typeof response === "function" ? response() : response;
  };
  return { upstreamFetch, calls };
}

/** An OpenAI-shaped `{ data: [{ id }] }` list body. */
function modelListBody(ids: string[]): Response {
  return new Response(JSON.stringify({ object: "list", data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("listReasoningModels", () => {
  it("GETs the Vendor's models endpoint with its auth header", async () => {
    const { upstreamFetch, calls } = makeStubFetch(modelListBody(["gpt-4o"]));

    await listReasoningModels({ vendor: REASONING_VENDORS.openai, apiKey: "secret", upstreamFetch });

    const [call] = calls;
    expect(call?.method).toBe("GET");
    expect(call?.url).toBe("https://api.openai.com/v1/models");
    expect(call?.headers["authorization"]).toBe("Bearer secret");
  });

  it("uses Anthropic's native auth headers for its models endpoint", async () => {
    const { upstreamFetch, calls } = makeStubFetch(modelListBody(["claude-sonnet-4-6"]));

    await listReasoningModels({ vendor: REASONING_VENDORS.anthropic, apiKey: "anthropic-key", upstreamFetch });

    const [call] = calls;
    expect(call?.url).toBe("https://api.anthropic.com/v1/models");
    expect(call?.headers["x-api-key"]).toBe("anthropic-key");
    expect(call?.headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("returns the live model ids with the Vendor's featured models first", async () => {
    // The Vendor reports models in an arbitrary order; a curated model and an unknown one.
    const { upstreamFetch } = makeStubFetch(modelListBody(["zeta-model", "gpt-4o-mini", "gpt-4o", "alpha-model"]));

    const result = await listReasoningModels({ vendor: REASONING_VENDORS.openai, apiKey: "k", upstreamFetch });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Featured (shortlist) models present in the live list lead, in shortlist order;
      // the rest follow alphabetically. Featured models the Vendor didn't report are dropped.
      expect(result.models).toEqual(["gpt-4o", "gpt-4o-mini", "alpha-model", "zeta-model"]);
    }
  });

  it("rejects a blank key without any upstream call", async () => {
    const { upstreamFetch, calls } = makeStubFetch(modelListBody(["gpt-4o"]));

    const result = await listReasoningModels({ vendor: REASONING_VENDORS.openai, apiKey: "  ", upstreamFetch });

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("explains a rejected key on 401", async () => {
    const { upstreamFetch } = makeStubFetch(new Response("unauthorized", { status: 401 }));

    const result = await listReasoningModels({ vendor: REASONING_VENDORS.openai, apiKey: "bad", upstreamFetch });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("rejected");
    }
  });

  it("reports an unreachable Vendor as a connection problem", async () => {
    const { upstreamFetch } = makeStubFetch(() => Promise.reject(new Error("network down")));

    const result = await listReasoningModels({ vendor: REASONING_VENDORS.google, apiKey: "k", upstreamFetch });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.toLowerCase()).toContain("couldn't reach");
    }
  });

  it("reports an empty catalogue as a failure the user can act on", async () => {
    const { upstreamFetch } = makeStubFetch(modelListBody([]));

    const result = await listReasoningModels({ vendor: REASONING_VENDORS.google, apiKey: "k", upstreamFetch });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.toLowerCase()).toContain("no models");
    }
  });

  it("rethrows an abort so a cancellation is not mistaken for a failure", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    const { upstreamFetch } = makeStubFetch(() => Promise.reject(abortError));

    await expect(
      listReasoningModels({ vendor: REASONING_VENDORS.openai, apiKey: "k", upstreamFetch }),
    ).rejects.toThrow("aborted");
  });
});
