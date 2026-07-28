// The pure text-extraction helpers behind the Task Agent's `web_search` and `web_fetch`
// tools (M5-02). Fetching is the platform's edge (the global `fetch`); turning the bytes
// that come back - a search results page, an arbitrary web page - into readable, bounded,
// model-friendly text is pure string work, so it lives here and is unit-tested without a
// network.
//
// Web search uses DuckDuckGo's keyless HTML endpoint so search works with zero integrations
// and no API key (the epic's "local-only, zero integrations" goal); the parser below reads
// that page's result markup.

/** One parsed web-search result. */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** A hard cap on returned text so a huge page can't blow the model's context or the buffer. */
export const MAX_READABLE_TEXT_CHARS = 8_000;

/** The default number of search results summarised for the model. */
export const DEFAULT_SEARCH_RESULT_COUNT = 6;

/** Decodes the handful of HTML entities that show up in titles/snippets/text. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Strips HTML tags from a fragment and normalises whitespace to single spaces. */
function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/**
 * Resolves DuckDuckGo's `result__a` href to the real destination URL. The HTML endpoint
 * wraps results in a redirect (`//duckduckgo.com/l/?uddg=<encoded-target>&...`); this pulls
 * the `uddg` target out, falling back to the href itself when it isn't wrapped.
 */
function resolveDuckDuckGoHref(href: string): string {
  const match = href.match(/[?&]uddg=([^&]+)/);
  if (match) {
    try {
      return decodeURIComponent(match[1]!);
    } catch {
      return href;
    }
  }
  return href.startsWith("//") ? `https:${href}` : href;
}

/**
 * Parses the DuckDuckGo HTML results page into structured results. Pairs each result link
 * (`result__a`) with the snippet that follows it, in document order; a page with no results
 * yields an empty array (the caller reports "no results" rather than erroring).
 */
export function parseDuckDuckGoResults(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const linkPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetPattern = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  const snippets: string[] = [];
  for (const match of html.matchAll(snippetPattern)) {
    snippets.push(stripTags(match[1]!));
  }

  let index = 0;
  for (const match of html.matchAll(linkPattern)) {
    const title = stripTags(match[2]!);
    if (title.length === 0) {
      continue;
    }
    results.push({
      title,
      url: resolveDuckDuckGoHref(match[1]!),
      snippet: snippets[index] ?? "",
    });
    index += 1;
  }
  return results;
}

/** Formats parsed results into the readable summary the tool hands back to the model. */
export function formatSearchResults(
  query: string,
  results: readonly WebSearchResult[],
  limit = DEFAULT_SEARCH_RESULT_COUNT,
): string {
  if (results.length === 0) {
    return `No web results found for "${query}".`;
  }
  const lines = results.slice(0, limit).map((result, position) => {
    const snippet = result.snippet.length > 0 ? `\n   ${result.snippet}` : "";
    return `${position + 1}. ${result.title}\n   ${result.url}${snippet}`;
  });
  return `Web results for "${query}":\n\n${lines.join("\n\n")}`;
}

/**
 * Turns a fetched HTML page into readable plain text: drops script/style/head noise, strips
 * the remaining tags, decodes entities, collapses whitespace, and truncates to
 * {@link MAX_READABLE_TEXT_CHARS} (with a marker) so a huge page stays bounded. A page that
 * is already plain text passes through (its lack of tags is a no-op).
 */
export function htmlToReadableText(html: string): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  // Turn block-level breaks into newlines before stripping, so paragraphs survive.
  const withBreaks = withoutNoise
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  const text = decodeEntities(withBreaks.replace(/<[^>]*>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .trim();
  if (text.length <= MAX_READABLE_TEXT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_READABLE_TEXT_CHARS)}\n\n[truncated - page was longer than ${MAX_READABLE_TEXT_CHARS} characters]`;
}
