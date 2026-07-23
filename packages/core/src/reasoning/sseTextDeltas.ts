/**
 * Reads a Vendor's Server-Sent-Events response body and yields the answer text of
 * each delta. Two Vendor SSE shapes are supported:
 *
 *   - OpenAI-compatible (OpenAI, Gemini):
 *       data: {"choices":[{"delta":{"content":"..."}}]}
 *       data: [DONE]
 *   - Anthropic Messages API:
 *       event: content_block_delta
 *       data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
 *
 * Both are reduced to the same thing the Core cares about - a stream of raw answer
 * text - so the shared canonical-stream adapter and Point Tag guard are Vendor-
 * agnostic. Carried from v1's Sidecar SSE adapters, with the byte reader shared.
 */

/**
 * Reads a byte stream as an async iterable of complete text lines, buffering any
 * partial trailing line across chunk boundaries so an SSE event split mid-line is
 * never mis-parsed. Cancels the reader on early exit (e.g. a Barge-in aborting the
 * turn), tearing down the upstream Vendor stream rather than leaving it running.
 */
async function* iterateLines(byteStream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = byteStream.getReader();
  const decoder = new TextDecoder();
  let pendingLine = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      pendingLine += decoder.decode(value, { stream: true });
      let newlineIndex = pendingLine.indexOf("\n");
      while (newlineIndex !== -1) {
        yield pendingLine.slice(0, newlineIndex);
        pendingLine = pendingLine.slice(newlineIndex + 1);
        newlineIndex = pendingLine.indexOf("\n");
      }
    }
    // Flush any final line without a trailing newline.
    if (pendingLine.length > 0) {
      yield pendingLine;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** The `data:` payload of an SSE line, or `undefined` for a non-data line. */
function dataPayloadOf(line: string): string | undefined {
  const trimmedLine = line.trim();
  if (!trimmedLine.startsWith("data:")) {
    return undefined;
  }
  return trimmedLine.slice("data:".length).trim();
}

/**
 * Yields the text content of each OpenAI streaming delta, skipping the role-only
 * first delta, the `[DONE]` sentinel, and any keep-alive/non-data lines. A
 * malformed data line is skipped rather than aborting the whole answer.
 */
export async function* iterateOpenAiContentDeltas(
  openAiSse: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  for await (const line of iterateLines(openAiSse)) {
    const payload = dataPayloadOf(line);
    if (payload === undefined || payload.length === 0 || payload === "[DONE]") {
      continue;
    }

    let parsed: { choices?: Array<{ delta?: { content?: unknown } }> };
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }

    const content = parsed.choices?.[0]?.delta?.content;
    if (typeof content === "string" && content.length > 0) {
      yield content;
    }
  }
}

/**
 * Yields the text of each Anthropic `content_block_delta` / `text_delta`, skipping
 * the lifecycle events (`message_start`, `message_stop`, ...) and any non-data
 * lines. A malformed data line is skipped rather than aborting the whole answer.
 */
export async function* iterateAnthropicTextDeltas(
  anthropicSse: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  for await (const line of iterateLines(anthropicSse)) {
    const payload = dataPayloadOf(line);
    if (payload === undefined || payload.length === 0) {
      continue;
    }

    let parsed: { type?: unknown; delta?: { type?: unknown; text?: unknown } };
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }

    if (
      parsed.type === "content_block_delta" &&
      parsed.delta?.type === "text_delta" &&
      typeof parsed.delta.text === "string" &&
      parsed.delta.text.length > 0
    ) {
      yield parsed.delta.text;
    }
  }
}
