import { marked } from "marked";
import DOMPurify from "dompurify";
import { JSDOM } from "jsdom";

// Same threat model as escapeHtml.ts: this converts LibreChat agent output
// (untrusted) to HTML that gets embedded in a real Chromium page via
// Playwright. marked will happily pass through raw HTML found in the
// source markdown, so the sanitize step below — not marked's own
// escaping — is what actually keeps this safe. No images: the agent
// output has no legitimate use for them in a report, and the renderer
// has no network egress anyway, so a stray `<img src="...">` would only
// ever render as a broken icon.
const purify = DOMPurify(new JSDOM("").window);

const ALLOWED_TAGS = [
  "p", "br", "hr",
  "strong", "em", "del", "s",
  "ul", "ol", "li",
  "blockquote",
  "pre", "code",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tr", "th", "td",
  "a",
];

export function renderMarkdownToSafeHtml(markdown: string): string {
  const rawHtml = marked.parse(markdown, { gfm: true, breaks: true, async: false });
  return purify.sanitize(rawHtml, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href"],
  });
}
