import { test } from "node:test";
import assert from "node:assert/strict";
import { TtlCache, WindowLimiter } from "../../src/memo.js";
import { formatSearchText, formatReadmeText } from "../../src/service.js";
import { parseRepo, parseMaxChars } from "../../src/readme.js";

test("TtlCache expires entries and evicts the oldest", async () => {
  const c = new TtlCache(2);
  c.set("a", 1, 1000);
  c.set("b", null, 1000);
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("b"), null, "null is a cached value (negative cache), not a miss");
  c.set("c", 3, 1000);
  assert.equal(c.get("a"), undefined, "oldest evicted at capacity");
  c.set("d", 4, 5);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(c.get("d"), undefined, "expired");
  c.set("e", { user: { id: 7 } }, 1000);
  c.deleteWhere((v) => v?.user?.id === 7);
  assert.equal(c.get("e"), undefined);
});

test("WindowLimiter allows the limit then reports retryAfter", () => {
  const l = new WindowLimiter(3, 60_000);
  assert.ok(l.take("k").ok && l.take("k").ok && l.take("k").ok);
  const r = l.take("k");
  assert.equal(r.ok, false);
  assert.ok(r.retryAfter >= 1 && r.retryAfter <= 60);
  assert.ok(l.take("other").ok, "keys are independent");
});

const result = {
  query: { input: "rust file manager", keyTerms: ["file", "manager"], descriptiveWords: ["rust"], minStars: 100, language: null, includeArchived: false, ignored: ["stars:>5"], notes: [] },
  matchLevel: "key_terms_plus", total: 12, page: 1, perPage: 2, hasMore: true,
  items: [
    { name: "sxyazi/yazi", url: "https://github.com/sxyazi/yazi", stars: 43212, language: "Rust", license: "MIT", archived: false, pushedAt: "2026-11-03T10:00:00Z", description: "Blazing   fast\nterminal file manager", topics: ["cli", "tui"] },
    { name: "a/b", url: "https://github.com/a/b", stars: 150, language: null, license: null, archived: true, pushedAt: null, description: null, topics: [] },
  ],
};

test("formatSearchText is compact, ranked and tells the agent how to continue", () => {
  const t = formatSearchText(result);
  assert.match(t, /^12 repositories for "rust file manager" \(100\+ stars, not archived\); all key terms and some descriptive words matched\. Ranked by stars\. Showing 1-2\./);
  assert.match(t, /\n1\. sxyazi\/yazi \(★43212 · Rust · MIT · pushed 2026-11-03\) — Blazing fast terminal file manager\n/);
  assert.match(t, /\n2\. a\/b \(★150 · archived\)\n/);
  assert.match(t, /call again with page=2/);
  assert.match(t, /Ignored: stars:>5\./);
  assert.match(formatSearchText({ ...result, items: [], total: 0, hasMore: false }), /No repositories found/);
});

test("README helpers parse repos and limits", () => {
  assert.deepEqual(parseRepo("sxyazi/yazi"), { owner: "sxyazi", name: "yazi" });
  assert.deepEqual(parseRepo("https://github.com/sxyazi/yazi.git"), { owner: "sxyazi", name: "yazi" });
  assert.deepEqual(parseRepo("https://github.com/sxyazi/yazi/tree/main"), { owner: "sxyazi", name: "yazi" });
  for (const bad of ["", "nope", "a/b/c", "../x", "a/..", "-bad/x"]) assert.equal(parseRepo(bad), null, bad);
  assert.equal(parseMaxChars(undefined), 6000);
  assert.equal(parseMaxChars("500"), 500);
  assert.equal(parseMaxChars("100"), null);
  assert.equal(parseMaxChars("20001"), null);
  assert.equal(parseMaxChars("1.5"), null);
  assert.match(formatReadmeText({ repo: "a/b", url: "u", text: "hi", truncated: true, totalChars: 900 }), /first 2 of 900 characters[\s\S]*truncated/);
});
