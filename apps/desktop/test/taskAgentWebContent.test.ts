import { describe, expect, it } from "vitest";

import {
  formatSearchResults,
  htmlToReadableText,
  parseDuckDuckGoResults,
} from "../src/main/taskAgent/webContent";

// The pure web-text extraction behind `web_search` / `web_fetch` (M5-02): parsing the
// keyless DuckDuckGo results page, and reducing an arbitrary page to bounded readable text.

describe("parseDuckDuckGoResults", () => {
  const page = `
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x">First <b>Result</b></a>
      <a class="result__snippet">A snippet about the first result.</a>
    </div>
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb">Second Result</a>
      <a class="result__snippet">Second snippet &amp; more.</a>
    </div>`;

  it("extracts title, decoded destination URL, and snippet per result", () => {
    const results = parseDuckDuckGoResults(page);
    expect(results).toEqual([
      { title: "First Result", url: "https://example.com/a", snippet: "A snippet about the first result." },
      { title: "Second Result", url: "https://example.org/b", snippet: "Second snippet & more." },
    ]);
  });

  it("returns an empty array for a page with no results", () => {
    expect(parseDuckDuckGoResults("<html><body>nothing here</body></html>")).toEqual([]);
  });
});

describe("formatSearchResults", () => {
  it("summarises results as numbered lines and honours the limit", () => {
    const summary = formatSearchResults(
      "berlin weather",
      [
        { title: "T1", url: "https://a", snippet: "s1" },
        { title: "T2", url: "https://b", snippet: "" },
        { title: "T3", url: "https://c", snippet: "s3" },
      ],
      2,
    );
    expect(summary).toContain('Web results for "berlin weather"');
    expect(summary).toContain("1. T1");
    expect(summary).toContain("2. T2");
    expect(summary).not.toContain("3. T3");
  });

  it("reports no results plainly", () => {
    expect(formatSearchResults("obscure query", [])).toBe('No web results found for "obscure query".');
  });
});

describe("htmlToReadableText", () => {
  it("strips scripts, styles, and tags, keeping the visible text", () => {
    const html =
      "<html><head><style>.x{}</style></head><body><script>evil()</script>" +
      "<h1>Title</h1><p>Hello &amp; welcome.</p></body></html>";
    const text = htmlToReadableText(html);
    expect(text).toContain("Title");
    expect(text).toContain("Hello & welcome.");
    expect(text).not.toContain("evil");
    expect(text).not.toContain("<");
  });

  it("truncates a very long page with a marker", () => {
    const long = `<p>${"a".repeat(20_000)}</p>`;
    const text = htmlToReadableText(long);
    expect(text.length).toBeLessThan(20_000);
    expect(text).toContain("[truncated");
  });
});
