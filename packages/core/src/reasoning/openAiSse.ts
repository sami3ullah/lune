/**
 * Reads an OpenAI-compatible chat-completions SSE stream and yields the answer
 * text of each delta.
 *
 * This is the minimal slice of v1's Seam-2 adapter (`qwenSseAdapter.ts`) the
 * walking skeleton needs: the line-buffering byte reader and the content-delta
 * extraction, without the Point Tag repair/remap and the canonical Anthropic
 * re-serialization (those are ported when screen-aware pointing arrives). The Core
 * hands these deltas straight to its own canonical chat-event stream.
 *
 * Input, per OpenAI's chat-completion streaming shape:
 *   data: {"choices":[{"delta":{"content":"..."}}]}
 *   data: [DONE]
 */

/**
 * Reads a byte stream as an async iterable of complete text lines, buffering any
 * partial trailing line across chunk boundaries so an SSE event split mid-line is
 * never mis-parsed.
 */
async function* iterateLines(
  byteStream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
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
    // Runs on normal completion AND when the consumer ends early (e.g. a future
    // Barge-in cancelling the turn, which calls the generator's `return`).
    // Cancelling the reader tears down the upstream Vendor stream rather than
    // leaving it running, and also releases the lock.
    await reader.cancel().catch(() => {});
  }
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
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith("data:")) {
      continue;
    }
    const payload = trimmedLine.slice("data:".length).trim();
    if (payload.length === 0 || payload === "[DONE]") {
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
