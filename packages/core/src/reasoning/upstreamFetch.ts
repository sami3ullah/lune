/**
 * The one injected seam of the Reasoning path: how the Core reaches a Vendor's
 * upstream API.
 *
 * For a cloud Reasoning Vendor the "Runtime" is the remote API (here, Gemini's
 * OpenAI-compatible endpoint) and this is just a `fetch`. Modelling it as an
 * injectable function is what keeps the Core transport-agnostic and lets the
 * Core-API tests stub the Vendor boundary - feeding a canned SSE stream with no
 * network and no real key (Testing Decisions). In production the Electron main
 * process injects the platform's global `fetch`.
 *
 * This is the direct successor of v1's `UpstreamFetch` seam, carried across the
 * port unchanged.
 */
export type UpstreamFetch = (url: string, requestInit?: RequestInit) => Promise<Response>;
