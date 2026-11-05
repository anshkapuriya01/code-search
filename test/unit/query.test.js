import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseQuery,
  buildQuery,
  parseSearchParams,
  matchedKeywords,
  requiredMatches,
  sortByStars,
  dedupeById,
  simplifyRepo,
  safeHttpUrl,
  selectRelaxed,
  isLikelySpam,
  QueryError,
  DEFAULT_MIN_STARS,
  MIN_STARS_FLOOR,
} from "../../public/lib/query.js";

const filters = { minStars: 100, language: null, includeArchived: false };

test("parseQuery removes filler words and keeps meaningful keywords in order", () => {
  const p = parseQuery("I want a self-hosted kanban board with markdown support");
  assert.deepEqual(p.keywords, ["self-hosted", "kanban", "board", "markdown"]);
  assert.deepEqual(p.qualifiers, []);
  assert.deepEqual(p.ignored, []);
});

test("parseQuery keeps allowed GitHub qualifiers and drops ones the service controls", () => {
  const p = parseQuery("cli tool license:mit -language:java stars:>5 sort:updated in:readme");
  assert.deepEqual(p.keywords, ["cli", "tool"]);
  assert.deepEqual(p.qualifiers, [
    { key: "license", value: "mit", negated: false },
    { key: "language", value: "java", negated: true },
  ]);
  assert.deepEqual(p.ignored, ["stars:>5", "sort:updated", "in:readme"]);
});

test("parseQuery handles quoted phrases, quoted qualifier values, and symbols in names", () => {
  const p = parseQuery('"static site generator" for c++ and node.js, language:"Jupyter Notebook"');
  assert.deepEqual(p.keywords, ["static site generator", "c++", "node.js"]);
  assert.deepEqual(p.qualifiers, [{ key: "language", value: '"Jupyter Notebook"', negated: false }]);
});

test("parseQuery treats unknown key:value tokens and URLs as text", () => {
  const p = parseQuery("note:taking https://example.com");
  assert.deepEqual(p.keywords, ["note", "taking", "https", "example.com"]);
  assert.deepEqual(p.qualifiers, []);
});

test("parseQuery ignores negated plain words", () => {
  const p = parseQuery("chat app -electron");
  assert.deepEqual(p.keywords, ["chat", "app"]);
  assert.deepEqual(p.ignored, ["-electron"]);
});

test("parseQuery dedupes, caps at 8 keywords, and reports the rest", () => {
  const p = parseQuery("alpha beta gamma delta alpha epsilon zeta eta theta iota kappa");
  assert.deepEqual(p.keywords, ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"]);
  assert.deepEqual(p.ignored, ["iota", "kappa"]);
});

test("parseQuery separates key terms from descriptive words", () => {
  const p = parseQuery("lightweight python library to convert pdf tables to excel");
  assert.deepEqual(p.keywords, ["lightweight", "python", "library", "convert", "pdf", "tables", "excel"]);
  assert.deepEqual(p.core, ["convert", "pdf", "tables", "excel"]);
  assert.deepEqual(p.soft, ["lightweight", "python", "library"]);
});

test("parseQuery: if every word is descriptive, all of them are key terms", () => {
  const p = parseQuery("lightweight python library");
  assert.deepEqual(p.core, ["lightweight", "python", "library"]);
  assert.deepEqual(p.soft, []);
});

test("parseQuery: over the limit, key terms are kept before descriptive words", () => {
  const p = parseQuery("simple fast modern lightweight tool for pdf tables excel csv json xml yaml");
  assert.deepEqual(p.keywords, ["simple", "pdf", "tables", "excel", "csv", "json", "xml", "yaml"]);
  assert.deepEqual(p.core, ["pdf", "tables", "excel", "csv", "json", "xml", "yaml"]);
  assert.deepEqual(p.soft, ["simple"]);
  assert.deepEqual(p.ignored, ["fast", "modern", "lightweight", "tool"]);
});

test("parseQuery falls back to stopwords if nothing else is left", () => {
  assert.deepEqual(parseQuery("the who").keywords, ["the", "who"]);
  assert.deepEqual(parseQuery("").keywords, []);
});

test("buildQuery strict requires every keyword and adds star and archive filters", () => {
  const q = buildQuery(parseQuery("kanban markdown"), filters, "strict");
  assert.equal(q, "kanban markdown stars:>=100 archived:false");
});

test("buildQuery any-mode joins key terms with OR and quotes phrases", () => {
  const q = buildQuery(parseQuery('kanban "self hosted" markdown'), filters, "any");
  assert.equal(q, 'kanban OR "self hosted" OR markdown stars:>=100 archived:false');
});

test("buildQuery core-mode leaves out descriptive words; any-mode uses at most 6 terms", () => {
  const parsed = parseQuery("lightweight python library to convert pdf tables to excel");
  assert.equal(buildQuery(parsed, filters, "core"), "convert pdf tables excel stars:>=100 archived:false");
  const many = parseQuery("a1 b2 c3 d4 e5 f6 g7 h8");
  assert.equal(buildQuery(many, filters, "any"), "a1 OR b2 OR c3 OR d4 OR e5 OR f6 stars:>=100 archived:false");
});

test("buildQuery: language filter overrides a typed language, and quotes multi-word languages", () => {
  const parsed = parseQuery("notebook language:python -language:r");
  const q = buildQuery(parsed, { ...filters, language: "Jupyter Notebook" }, "strict");
  assert.equal(q, 'notebook -language:r language:"Jupyter Notebook" stars:>=100 archived:false');
});

test("buildQuery: include archived, or respect a typed archived qualifier", () => {
  assert.equal(buildQuery(parseQuery("x11"), { ...filters, includeArchived: true }), "x11 stars:>=100");
  assert.equal(buildQuery(parseQuery("x11 archived:true"), filters), "x11 archived:true stars:>=100");
});

test("buildQuery works with qualifiers only", () => {
  assert.equal(buildQuery(parseQuery("topic:cli"), filters), "topic:cli stars:>=100 archived:false");
});

test("buildQuery rejects queries longer than GitHub allows", () => {
  const long = Array.from({ length: 6 }, (_, i) => `"${String(i).repeat(45)} word"`).join(" ");
  assert.throws(() => buildQuery(parseQuery(long), filters, "any"), QueryError);
});

test("parseSearchParams applies defaults", () => {
  const r = parseSearchParams(new URLSearchParams("q=kanban"));
  assert.equal(r.ok, true);
  assert.equal(r.value.minStars, DEFAULT_MIN_STARS);
  assert.equal(r.value.page, 1);
  assert.equal(r.value.perPage, 20);
  assert.equal(r.value.includeArchived, false);
  assert.equal(r.value.language, null);
});

test("parseSearchParams raises min_stars to the floor and notes it", () => {
  const r = parseSearchParams(new URLSearchParams("q=kanban&min_stars=0"));
  assert.equal(r.value.minStars, MIN_STARS_FLOOR);
  assert.equal(r.value.notes.length, 1);
});

test("parseSearchParams rejects invalid input", () => {
  const bad = [
    "q=",
    "q=x&min_stars=-5",
    "q=x&min_stars=abc",
    "q=x&per_page=51",
    "q=x&per_page=0",
    "q=x&page=0",
    "q=x&page=21&per_page=50",
    "q=x&language=%3Cscript%3E",
    `q=${"a".repeat(501)}`,
  ];
  for (const qs of bad) assert.equal(parseSearchParams(new URLSearchParams(qs)).ok, false, qs);
});

test("parseSearchParams accepts language alone and include_archived", () => {
  const r = parseSearchParams(new URLSearchParams("language=C%2B%2B&include_archived=true&page=50&per_page=20"));
  assert.equal(r.ok, true);
  assert.equal(r.value.language, "C++");
  assert.equal(r.value.includeArchived, true);
});

const repo = (over) => ({
  id: 1,
  full_name: "acme/tasks",
  description: "",
  topics: [],
  stargazers_count: 0,
  ...over,
});

test("matchedKeywords checks name, description and topics, ignoring case and dashes", () => {
  const r = repo({ full_name: "acme/Kanban-Board", description: "A Markdown-first planner", topics: ["self-hosted"] });
  assert.deepEqual(matchedKeywords(r, ["kanban", "markdown", "self-hosted", "notion"]), ["kanban", "markdown", "self-hosted"]);
});

test("matchedKeywords: prefix matches for long words, whole words for short ones", () => {
  const r = repo({ description: "A todolist for google users written in golang" });
  assert.deepEqual(matchedKeywords(r, ["todo", "go", "list"]), ["todo"]);
  assert.deepEqual(matchedKeywords(repo({ description: "Fast c++ parser in go" }), ["c++", "go"]), ["c++", "go"]);
});

test("matchedKeywords handles plurals and the repo language", () => {
  const r = repo({ description: "Extract table data from a PDF", language: "Python" });
  assert.deepEqual(matchedKeywords(r, ["tables", "pdfs", "python", "class"]), ["tables", "pdfs", "python"]);
  assert.deepEqual(matchedKeywords(repo({ description: "glass ui" }), ["glasses"]), [], "-ss words are not stemmed");
});

test("selectRelaxed uses the strictest rule that still gives enough results", () => {
  const parsed = parseQuery("notion alternative self host");
  assert.deepEqual(parsed.core, ["notion"]);
  const exact = [repo({ id: 1, full_name: "a/exact", description: "notion alternative self hosted", stargazers_count: 10 })];
  const plus = [2, 3, 4, 5].map((id) =>
    repo({ id, full_name: `a/plus${id}`, description: "open source Notion alternative", stargazers_count: id * 100 }),
  );
  const coreOnly = repo({ id: 9, full_name: "a/sdk", description: "Notion API client", stargazers_count: 99999 });

  let r = selectRelaxed(exact, [...plus, coreOnly], parsed);
  assert.equal(r.level, "key_terms_plus");
  assert.deepEqual(r.items.map((x) => x.id), [5, 4, 3, 2, 1], "the SDK is left out and results are ranked by stars");

  r = selectRelaxed(exact, [plus[0], coreOnly], parsed);
  assert.equal(r.level, "key_terms", "too few, so the rule is loosened");
  assert.deepEqual(r.items.map((x) => x.id), [9, 2, 1]);
});

test("selectRelaxed falls back to most key terms when there are 3+", () => {
  const parsed = parseQuery("alpha beta gamma");
  const cands = [
    repo({ id: 1, full_name: "a/1", description: "alpha beta", stargazers_count: 5 }),
    repo({ id: 2, full_name: "a/2", description: "alpha", stargazers_count: 500 }),
  ];
  const r = selectRelaxed([], cands, parsed);
  assert.equal(r.level, "most_key_terms");
  assert.deepEqual(r.items.map((x) => x.id), [1]);
});

test("isLikelySpam flags keyword-stuffed descriptions only", () => {
  assert.equal(isLikelySpam({ description: "x".repeat(1001) }), true);
  assert.equal(isLikelySpam({ description: "x".repeat(350) }), false);
  assert.equal(isLikelySpam({ description: null }), false);
});

test("requiredMatches", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(requiredMatches), [1, 2, 2, 3, 3, 4]);
});

test("sortByStars ranks highest first with a stable tie-break", () => {
  const sorted = sortByStars([
    repo({ id: 1, full_name: "b/b", stargazers_count: 10 }),
    repo({ id: 2, full_name: "a/a", stargazers_count: 10 }),
    repo({ id: 3, full_name: "c/c", stargazers_count: 500 }),
  ]);
  assert.deepEqual(sorted.map((r) => r.id), [3, 2, 1]);
});

test("dedupeById keeps the first occurrence", () => {
  assert.deepEqual(dedupeById([{ id: 1, n: "a" }, { id: 1, n: "b" }, { id: 2 }]), [{ id: 1, n: "a" }, { id: 2 }]);
});

test("simplifyRepo strips unsafe homepage URLs and NOASSERTION licenses", () => {
  const s = simplifyRepo({
    full_name: "a/b",
    html_url: "https://github.com/a/b",
    homepage: "javascript:alert(1)",
    license: { spdx_id: "NOASSERTION" },
    stargazers_count: 5,
  });
  assert.equal(s.homepage, null);
  assert.equal(s.license, null);
  assert.equal(s.url, "https://github.com/a/b");
  assert.equal(safeHttpUrl("http://example.com"), "http://example.com/");
});
