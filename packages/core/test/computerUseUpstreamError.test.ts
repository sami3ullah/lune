import { describe, expect, it } from "vitest";

import {
  ComputerUseUpstreamError,
  throwIfStepResponseNotOk,
} from "../src/agent/computerUseAdapter";

/**
 * The typed upstream error the Shell classifies into a plain-language spoken line (quota
 * 429, auth 401/403, model-access 404, vendor 5xx). These tests pin that a not-OK Vendor
 * response becomes a {@link ComputerUseUpstreamError} carrying the status + body the Shell
 * reads, and that an OK response passes through untouched.
 */
describe("throwIfStepResponseNotOk", () => {
  it("resolves without throwing for an OK response", async () => {
    await expect(
      throwIfStepResponseNotOk(new Response("{}", { status: 200 }), "Gemini"),
    ).resolves.toBeUndefined();
  });

  it("throws a ComputerUseUpstreamError carrying the status, vendor, and body", async () => {
    const body = JSON.stringify({ error: { code: 429, message: "quota exceeded" } });
    const response = new Response(body, { status: 429 });

    await expect(throwIfStepResponseNotOk(response, "Gemini")).rejects.toMatchObject({
      name: "ComputerUseUpstreamError",
      status: 429,
      vendorDisplayName: "Gemini",
      body,
    });
  });

  it("keeps the full body in the message for logs", async () => {
    const response = new Response("nope", { status: 404 });
    let thrown: unknown;
    try {
      await throwIfStepResponseNotOk(response, "OpenAI");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ComputerUseUpstreamError);
    expect((thrown as ComputerUseUpstreamError).message).toBe(
      "OpenAI agent step failed: HTTP 404 - nope",
    );
  });
});
