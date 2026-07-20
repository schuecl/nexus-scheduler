import { describe, expect, it } from "vitest";
import { KB_ARTICLES, findKbArticle } from "./kbContent";

// These are structural invariants, not content review. Every one of them
// has been violated by a merge in this repo's history: a rebase appended
// a byte-identical second copy of an article, and `tsc` said nothing —
// a duplicate array element is valid TypeScript. findKbArticle would
// return the first match while the index rendered two identical cards.
//
// The compiler cannot see any of this. Keep it checkable in CI instead.
describe("KB content", () => {
  const CATEGORY_ORDER = [
    "Getting Started",
    "Modules",
    "Admin",
    "Architecture",
    "Troubleshooting",
  ] as const;

  it("has no duplicate slugs", () => {
    const slugs = KB_ARTICLES.map((a) => a.slug);
    const duplicates = slugs.filter((s, i) => slugs.indexOf(s) !== i);
    expect(duplicates).toEqual([]);
  });

  it("has no duplicate titles", () => {
    const titles = KB_ARTICLES.map((a) => a.title);
    const duplicates = titles.filter((t, i) => titles.indexOf(t) !== i);
    expect(duplicates).toEqual([]);
  });

  it("gives every article a slug, title, summary and body", () => {
    for (const article of KB_ARTICLES) {
      expect(article.slug, `slug on "${article.title}"`).toMatch(/^[a-z0-9-]+$/);
      expect(article.title.trim(), `title of ${article.slug}`).not.toBe("");
      expect(article.summary.trim(), `summary of ${article.slug}`).not.toBe("");
      expect(article.content.trim().length, `content of ${article.slug}`).toBeGreaterThan(200);
    }
  });

  // A category outside this list silently disappears from the index:
  // KnowledgeBasePage renders by iterating CATEGORY_ORDER, so an article
  // in an unlisted category is unreachable except by direct URL.
  it("only uses categories the index renders", () => {
    for (const article of KB_ARTICLES) {
      expect(CATEGORY_ORDER, `category of ${article.slug}`).toContain(article.category);
    }
  });

  it("resolves every internal /help/ link to a real article", () => {
    const slugs = new Set(KB_ARTICLES.map((a) => a.slug));
    const broken: string[] = [];
    for (const article of KB_ARTICLES) {
      for (const match of article.content.matchAll(/\]\(\/help\/([a-z0-9-]+)\)/g)) {
        const target = match[1]!;
        if (!slugs.has(target)) broken.push(`${article.slug} -> /help/${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("finds every article by its own slug", () => {
    for (const article of KB_ARTICLES) {
      expect(findKbArticle(article.slug)?.title).toBe(article.title);
    }
    expect(findKbArticle("does-not-exist")).toBeUndefined();
  });
});
