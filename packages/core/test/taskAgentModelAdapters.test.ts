import { describe, expect, it } from "vitest";

import {
  buildAnthropicTaskAgentRequest,
  parseAnthropicTaskAgentResponse,
} from "../src/taskAgent/anthropicTaskAgentModel.js";
import {
  buildOpenAiTaskAgentRequest,
  parseOpenAiTaskAgentResponse,
  type OpenAiTaskAgentVendorConfig,
} from "../src/taskAgent/openAiTaskAgentModel.js";
import { createTaskAgentModelAdapters } from "../src/taskAgent/taskAgentModelVendors.js";
import { TaskAgentModelUpstreamError } from "../src/taskAgent/taskAgentModel.js";
import type { TaskAgentModelRequest } from "../src/taskAgent/taskAgentModel.js";
import type { UpstreamFetch } from "../src/reasoning/upstreamFetch.js";

// The two tool-calling adapters are pure over their inputs (no network, no clock), so the
// two things that need proving are unit-testable in isolation: building the outbound
// request from the canonical conversation, and parsing a Vendor response into a canonical
// turn. The upstream call is exercised through a stubbed `upstreamFetch`.

const OPENAI_VENDOR: OpenAiTaskAgentVendorConfig = {
  chatCompletionsUrl: "https://api.openai.com/v1/chat/completions",
  displayName: "OpenAI",
  tokenLimitField: "max_completion_tokens",
};

/** A canonical request carrying a two-turn tool-calling conversation. */
function sampleRequest(overrides: Partial<TaskAgentModelRequest> = {}): TaskAgentModelRequest {
  return {
    system: "you are lune",
    model: "test-model",
    apiKey: "sk-test",
    upstreamFetch: async () => new Response("{}"),
    tools: [
      { name: "search", description: "web search", parameters: { type: "object", properties: { q: { type: "string" } } } },
    ],
    messages: [
      { role: "user", text: "find the weather" },
      { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "search", input: { q: "weather" } }] },
      { role: "tool", results: [{ toolCallId: "c1", toolName: "search", output: "sunny", isError: false }] },
    ],
    ...overrides,
  };
}

describe("Anthropic Task Agent adapter - request construction", () => {
  it("declares tools with a JSON-Schema input_schema and the system prompt", () => {
    const request = buildAnthropicTaskAgentRequest(sampleRequest());
    expect(request.model).toBe("test-model");
    expect(request.system).toBe("you are lune");
    expect(request.tools).toEqual([
      { name: "search", description: "web search", input_schema: { type: "object", properties: { q: { type: "string" } } } },
    ]);
  });

  it("translates the canonical conversation into tool_use / tool_result blocks", () => {
    const request = buildAnthropicTaskAgentRequest(sampleRequest());
    expect(request.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "find the weather" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "search", input: { q: "weather" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "sunny" }] },
    ]);
  });

  it("marks an error tool result with is_error so the model sees the failure", () => {
    const request = buildAnthropicTaskAgentRequest(
      sampleRequest({
        messages: [
          { role: "user", text: "go" },
          { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "search", input: {} }] },
          { role: "tool", results: [{ toolCallId: "c1", toolName: "search", output: "boom", isError: true }] },
        ],
      }),
    );
    expect(request.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "c1", content: "boom", is_error: true }],
    });
  });
});

describe("Anthropic Task Agent adapter - response parsing", () => {
  it("reads tool_use blocks into canonical tool calls", () => {
    const turn = parseAnthropicTaskAgentResponse(
      JSON.stringify({
        content: [
          { type: "text", text: "let me look that up" },
          { type: "tool_use", id: "toolu_1", name: "search", input: { q: "weather" } },
        ],
        stop_reason: "tool_use",
      }),
    );
    expect(turn).toEqual({
      text: "let me look that up",
      toolCalls: [{ id: "toolu_1", name: "search", input: { q: "weather" } }],
    });
  });

  it("reads a text-only reply (no tool_use) as a finished turn", () => {
    const turn = parseAnthropicTaskAgentResponse(
      JSON.stringify({ content: [{ type: "text", text: "all done!" }], stop_reason: "end_turn" }),
    );
    expect(turn).toEqual({ text: "all done!", toolCalls: [] });
  });

  it("defaults a malformed tool input to an empty argument bag", () => {
    const turn = parseAnthropicTaskAgentResponse(
      JSON.stringify({ content: [{ type: "tool_use", id: "t", name: "search", input: null }] }),
    );
    expect(turn.toolCalls[0]!.input).toEqual({});
  });
});

describe("OpenAI-compatible Task Agent adapter - request construction", () => {
  it("declares function tools, leads with the system prompt, and sets tool_choice auto", () => {
    const request = buildOpenAiTaskAgentRequest(sampleRequest(), OPENAI_VENDOR);
    expect(request.tools).toEqual([
      {
        type: "function",
        function: { name: "search", description: "web search", parameters: { type: "object", properties: { q: { type: "string" } } } },
      },
    ]);
    expect(request.tool_choice).toBe("auto");
    expect(request.messages[0]).toEqual({ role: "system", content: "you are lune" });
  });

  it("translates tool calls into tool_calls with JSON-string arguments, and results into tool messages", () => {
    const request = buildOpenAiTaskAgentRequest(sampleRequest(), OPENAI_VENDOR);
    expect(request.messages.slice(1)).toEqual([
      { role: "user", content: "find the weather" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "search", arguments: JSON.stringify({ q: "weather" }) } }],
      },
      { role: "tool", tool_call_id: "c1", content: "sunny" },
    ]);
  });

  it("carries the completion limit under the Vendor's field name", () => {
    const openAi = buildOpenAiTaskAgentRequest(sampleRequest({ maxTokens: 256 }), OPENAI_VENDOR);
    expect(openAi.max_completion_tokens).toBe(256);
    expect(openAi.max_tokens).toBeUndefined();

    const gemini = buildOpenAiTaskAgentRequest(sampleRequest({ maxTokens: 256 }), {
      ...OPENAI_VENDOR,
      tokenLimitField: "max_tokens",
    });
    expect(gemini.max_tokens).toBe(256);
    expect(gemini.max_completion_tokens).toBeUndefined();
  });
});

describe("OpenAI-compatible Task Agent adapter - response parsing", () => {
  it("reads tool_calls with JSON-string arguments into canonical tool calls", () => {
    const turn = parseOpenAiTaskAgentResponse(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"weather"}' } }],
            },
          },
        ],
      }),
    );
    expect(turn).toEqual({ text: "", toolCalls: [{ id: "call_1", name: "search", input: { q: "weather" } }] });
  });

  it("reads a content-only reply as a finished turn", () => {
    const turn = parseOpenAiTaskAgentResponse(
      JSON.stringify({ choices: [{ message: { content: "here you go" } }] }),
    );
    expect(turn).toEqual({ text: "here you go", toolCalls: [] });
  });

  it("defaults malformed tool-call arguments to an empty bag rather than throwing", () => {
    const turn = parseOpenAiTaskAgentResponse(
      JSON.stringify({
        choices: [{ message: { tool_calls: [{ id: "c", type: "function", function: { name: "x", arguments: "not json" } }] } }],
      }),
    );
    expect(turn.toolCalls[0]).toEqual({ id: "c", name: "x", input: {} });
  });
});

describe("Task Agent adapters - upstream integration", () => {
  it("throws a typed upstream error carrying the status and body on a not-OK response", async () => {
    const failing: UpstreamFetch = async () => new Response("quota exceeded", { status: 429 });
    const anthropic = createTaskAgentModelAdapters().anthropic;
    await expect(anthropic.generate(sampleRequest({ upstreamFetch: failing }))).rejects.toMatchObject({
      name: "TaskAgentModelUpstreamError",
      status: 429,
      body: "quota exceeded",
    });
  });

  it("routes an Anthropic request to the Messages endpoint and parses its reply", async () => {
    let calledUrl = "";
    const upstreamFetch: UpstreamFetch = async (url) => {
      calledUrl = String(url);
      return new Response(JSON.stringify({ content: [{ type: "text", text: "done" }] }), { status: 200 });
    };
    const turn = await createTaskAgentModelAdapters().anthropic.generate(sampleRequest({ upstreamFetch }));
    expect(calledUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(turn).toEqual({ text: "done", toolCalls: [] });
  });

  it("routes a Gemini request to the OpenAI-compatible endpoint", async () => {
    let calledUrl = "";
    const upstreamFetch: UpstreamFetch = async (url) => {
      calledUrl = String(url);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    };
    await createTaskAgentModelAdapters().google.generate(sampleRequest({ upstreamFetch }));
    expect(calledUrl).toContain("generativelanguage.googleapis.com");
  });

  it("exposes the upstream error type for the Shell to classify", () => {
    const error = new TaskAgentModelUpstreamError("OpenAI", 401, "bad key");
    expect(error.status).toBe(401);
    expect(error.message).toContain("HTTP 401");
  });
});
