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
  rankResults,
  scoreRepo,
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

test("parseQuery: context about the user is dropped, self hosted becomes one requirement", () => {
  const p = parseQuery("give me self hosted email for my business for free");
  assert.deepEqual(p.keywords, ["self-hosted", "email"]);
  assert.deepEqual(p.core, ["email"]);
  assert.deepEqual(p.soft, ["self-hosted"]);
  assert.deepEqual(p.context, ["for my business", "for free"]);
  assert.deepEqual(p.altTerms, ["mail", "server"], "self-hosted email is usually called a mail server");
  assert.equal(buildQuery(p, filters, "strict"), "self-hosted email stars:>=100 archived:false");
  assert.equal(buildQuery(p, filters, "alt"), "mail server stars:>=100 archived:false");
});

test("parseQuery: ways of saying self-hosted", () => {
  for (const q of ["password manager I can host on my own server", "selfhosted password manager", "password manager to run on our own vps", "on-prem password manager", "self-hosting password manager"]) {
    const p = parseQuery(q);
    assert.deepEqual(p.core, ["password", "manager"], q);
    assert.deepEqual(p.soft, ["self-hosted"], q);
  }
});

test("parseQuery: a named product is a reference point, not the subject, next to other key terms", () => {
  const p = parseQuery("chat app like slack that I can self host for my team");
  assert.deepEqual(p.core, ["chat"]);
  assert.deepEqual(p.refs, ["slack"]);
  assert.ok(p.soft.includes("slack") && p.soft.includes("self-hosted") && p.soft.includes("alternative"));
  assert.deepEqual(p.context, ["for my team"]);

  const ga = parseQuery("open source alternative to google analytics for my website");
  assert.deepEqual(ga.core, ["google analytics"]);
  assert.deepEqual(ga.soft, ["alternative"]);
  assert.equal(buildQuery(ga, filters, "strict"), 'alternative "google analytics" stars:>=100 archived:false');

  assert.deepEqual(parseQuery("open source notion alternative").refs, ["notion"]);
  assert.deepEqual(parseQuery("I'd like a kanban board").core, ["kanban", "board"], "'like a' is not a reference");
});

test("parseQuery keeps subject words that only look like context", () => {
  assert.deepEqual(parseQuery("business intelligence dashboard").core, ["business", "intelligence", "dashboard"]);
  assert.deepEqual(parseQuery("web hosting control panel").core, ["web", "hosting", "control", "panel"]);
  assert.deepEqual(parseQuery("free crm for my small business").core, ["crm"]);
  assert.deepEqual(parseQuery("e-mail client").core, ["email", "client"]);
  assert.deepEqual(parseQuery("I'm looking for a markdown editor").core, ["markdown", "editor"]);
  assert.deepEqual(parseQuery('"for my business" crm').core, ["for my business", "crm"], "quoted phrases are left alone");
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

test("rankResults: a project that is the thing beats a bigger one that mentions it in passing", () => {
  const parsed = parseQuery("give me self hosted email for my business for free");
  const scraper = repo({
    id: 1,
    full_name: "acme/google-maps-scraper",
    description: "Google Maps Scraper & Lead Generation Tool. Extract 50+ data points including business emails and phones",
    stargazers_count: 40000,
  });
  const mailServer = repo({
    id: 2,
    full_name: "acme/docker-mailserver",
    description: "Production-ready fullstack but simple mail server (SMTP, IMAP, LDAP, Antispam, Antivirus, etc.)",
    topics: ["mail", "smtp", "imap"],
    stargazers_count: 15000,
  });
  const selfHosted = repo({ id: 3, full_name: "acme/inbox", description: "Self-hosted email for teams", stargazers_count: 900 });
  const r = rankResults([scraper, mailServer, selfHosted], parsed);
  assert.deepEqual(r.items.map((x) => x.id), [2, 3, 1]);
});

test("rankResults: libraries and test tools rank below services when a self-hosted service is asked for", () => {
  const parsed = parseQuery("self-hosted email");
  const lib = repo({ id: 1, full_name: "acme/react-email", description: "Build and send emails using React. A library for email templates", stargazers_count: 20000 });
  const server = repo({ id: 2, full_name: "acme/mailu", description: "Insular email distribution - mail server as Docker images", topics: ["email", "mailserver"], stargazers_count: 7000 });
  assert.deepEqual(rankResults([lib, server], parsed).items.map((x) => x.id), [2, 1]);
});

test("rankResults: 'alternative to X' prefers replacements over X plugins", () => {
  const parsed = parseQuery("alternative to google analytics");
  const plugin = repo({ id: 1, full_name: "acme/angular-google-analytics", description: "Google Analytics tracking for your AngularJS apps", stargazers_count: 5000 });
  const alt = repo({ id: 2, full_name: "acme/vince", description: "Self Hosted Alternative To Google Analytics", stargazers_count: 2000 });
  assert.deepEqual(rankResults([plugin, alt], parsed).items.map((x) => x.id), [2, 1]);
});

test("rankResults: awesome lists are pushed down unless a list was asked for", () => {
  const list = repo({ id: 1, full_name: "acme/awesome-kanban", description: "A curated list of kanban boards", stargazers_count: 90000 });
  const app = repo({ id: 2, full_name: "acme/kanban", description: "Kanban board", stargazers_count: 3000 });
  assert.deepEqual(rankResults([list, app], parseQuery("kanban board")).items.map((x) => x.id), [2, 1]);
  assert.equal(rankResults([list, app], parseQuery("awesome list kanban")).items[0].id, 1);
});

test("rankResults: candidates must contain every key term (or a related word); trusted ones always count", () => {
  const parsed = parseQuery("notion alternative self host");
  assert.deepEqual(parsed.core, ["notion"]);
  const exact = repo({ id: 1, full_name: "a/exact", description: "notion alternative", stargazers_count: 10 });
  const unrelated = repo({ id: 9, full_name: "a/sdk", description: "Kanban app", stargazers_count: 99999 });
  const odd = repo({ id: 7, full_name: "a/odd", description: "Something GitHub matched", stargazers_count: 50 });
  const r = rankResults([exact, unrelated, odd], parsed, { trusted: new Set([7]) });
  assert.deepEqual(r.items.map((x) => x.id).sort(), [1, 7]);
  assert.equal(r.level, "key_terms_plus", "the untrusted pick has every key term and a descriptive word");
  const full = repo({ id: 2, full_name: "a/full", description: "self-hosted notion alternative" });
  assert.equal(rankResults([full], parsed).level, "all_keywords");
});

test("rankResults falls back to most key terms when there are 3+ and too few full matches", () => {
  const parsed = parseQuery("alpha beta gamma");
  const cands = [
    repo({ id: 1, full_name: "a/1", description: "alpha beta", stargazers_count: 5 }),
    repo({ id: 2, full_name: "a/2", description: "alpha", stargazers_count: 500 }),
  ];
  const r = rankResults(cands, parsed);
  assert.equal(r.level, "most_key_terms");
  assert.deepEqual(r.items.map((x) => x.id), [1]);
});

test("scoreRepo weighs where a term appears: name and topics over a mention late in the description", () => {
  const parsed = parseQuery("kanban");
  const late = scoreRepo(repo({ description: "A planning tool with many views that you can use for anything at all. Also kanban." }), parsed);
  const named = scoreRepo(repo({ full_name: "a/kanban-board" }), parsed);
  const topic = scoreRepo(repo({ topics: ["kanban"] }), parsed);
  assert.ok(named.relevance > topic.relevance && topic.relevance > late.relevance);
  assert.ok(late.relevance > 0);
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
