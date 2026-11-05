// Pure search logic: turn a plain-English request into GitHub queries,
// decide which results match, and rank them by stars. No network or Worker APIs here.

export const DEFAULT_MIN_STARS = 100;
export const MIN_STARS_FLOOR = 10;
export const MAX_MIN_STARS = 1_000_000;
export const MAX_KEYWORDS = 8;
export const MAX_OR_TERMS = 6; // GitHub allows at most 5 AND/OR/NOT operators per query
export const MAX_INPUT_LENGTH = 500;
export const MAX_GITHUB_QUERY_LENGTH = 256; // GitHub rejects longer search queries
export const DEFAULT_PER_PAGE = 20;
export const MAX_PER_PAGE = 50;
export const MAX_REACHABLE_RESULTS = 1000; // GitHub only serves the first 1000 results of a search

export class QueryError extends Error {}

// Filler words that describe the request rather than the project.
const STOPWORDS = new Set(
  `a an the and or but if then else of for to in on at by with without from into onto about as
   is are was were be been being it its this that these those there here which who whom what where
   when why how i me my mine we us our you your he she they them their can could should would will
   shall may might must do does did done have has had want wants wanted need needs needed looking
   look find finding search searching show give get some any something anything like similar such
   also very really just only more most best good great top popular project projects repo repos
   repository repositories github open source opensource please help let lets using use used uses
   based built written made make makes so than too not no yes all each every other another while
   both either etc free support supports supported supporting feature features functionality
   allow allows allowing able ability capability capabilities way ways thing things stuff kind`.split(/\s+/),
);

// Descriptive words: they describe the kind of project, not the subject. They are optional when
// matching, so "lightweight python library for pdf tables" is about "pdf tables" first.
const SOFT_WORDS = new Set(
  `lightweight light simple minimal minimalist minimalistic fast faster quick small tiny easy easily
   modern beautiful powerful clean awesome robust efficient scalable flexible secure
   library libraries lib libs framework frameworks tool tools toolkit utility utilities util utils
   app apps application applications software program programs platform system solution service
   package module plugin plugins extension extensions alternative alternatives replacement clone
   self host hosted hosting self-hosted selfhosted self-host cross-platform
   python javascript js typescript ts golang rust java kotlin swift ruby php c++ cpp c# csharp dart
   scala elixir haskell lua node node.js nodejs`.split(/\s+/),
);

// GitHub qualifiers users may type directly, e.g. "license:mit" or "topic:cli".
const ALLOWED_QUALIFIERS = new Set([
  "language", "license", "topic", "topics", "user", "org", "repo", "created", "pushed",
  "forks", "size", "archived", "mirror", "template", "is", "good-first-issues",
  "help-wanted-issues", "followers",
]);

// Qualifiers this service controls itself; typed versions are dropped.
const MANAGED_QUALIFIERS = new Set(["stars", "sort", "order", "in"]);

const TOKEN_RE = /(-?)([a-z][a-z-]*):("[^"]*"|\S+)|"([^"]*)"|(\S+)/gi;
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}+#._-]*/gu;
const LANGUAGE_RE = /^[\p{L}\p{N} .+#'-]{1,40}$/u;

function pushWords(token, terms) {
  for (const m of token.toLowerCase().matchAll(WORD_RE)) {
    const word = m[0].replace(/[._-]+$/, "");
    if (word) terms.push(word.slice(0, 50));
  }
}

/**
 * Splits free text into keywords and GitHub qualifiers.
 * Returns {
 *   keywords: string[]   all search words, in order
 *   core: string[]       key terms (must match); all keywords if every word is descriptive
 *   soft: string[]       descriptive words (optional)
 *   qualifiers: {key, value, negated}[], ignored: string[]
 * }
 */
export function parseQuery(input) {
  const text = String(input ?? "").slice(0, MAX_INPUT_LENGTH);
  const terms = [];
  const qualifiers = [];
  const ignored = [];

  for (const m of text.matchAll(TOKEN_RE)) {
    const [whole, neg, key, value, phrase, word] = m;
    if (key !== undefined) {
      const k = key.toLowerCase();
      if (ALLOWED_QUALIFIERS.has(k) && value.replace(/"/g, "").trim()) {
        qualifiers.push({ key: k, value, negated: neg === "-" });
      } else if (MANAGED_QUALIFIERS.has(k)) {
        ignored.push(whole);
      } else {
        pushWords(whole, terms); // e.g. "http://..." or "note:" is just text
      }
    } else if (phrase !== undefined) {
      const p = phrase.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 50);
      if (p) terms.push(p);
    } else if (word.length > 1 && word.startsWith("-")) {
      ignored.push(word); // excluding plain words is not supported
    } else {
      pushWords(word, terms);
    }
  }

  const unique = [...new Set(terms)];
  const meaningful = unique.filter((t) => t.includes(" ") || !STOPWORDS.has(t));
  const candidates = meaningful.length ? meaningful : unique;

  // Over the limit: keep key terms before descriptive words, preserving the original order.
  const isSoft = (t) => SOFT_WORDS.has(t);
  const keep = new Set();
  for (const t of candidates) if (!isSoft(t) && keep.size < MAX_KEYWORDS) keep.add(t);
  for (const t of candidates) if (isSoft(t) && keep.size < MAX_KEYWORDS) keep.add(t);
  const keywords = candidates.filter((t) => keep.has(t));
  ignored.push(...candidates.filter((t) => !keep.has(t)));

  const core = keywords.filter((t) => !isSoft(t));
  return {
    keywords,
    core: core.length ? core : keywords,
    soft: core.length ? keywords.filter(isSoft) : [],
    qualifiers,
    ignored,
  };
}

function formatTerm(term) {
  return /\s/.test(term) ? `"${term}"` : term;
}

/**
 * Builds a GitHub repository search query.
 *   "strict": every keyword must match
 *   "core":   every key term must match (descriptive words left out)
 *   "any":    any key term may match (up to MAX_OR_TERMS)
 */
export function buildQuery(parsed, { minStars, language, includeArchived }, mode = "strict") {
  const parts = [];
  const terms =
    mode === "core" ? parsed.core : mode === "any" ? parsed.core.slice(0, MAX_OR_TERMS) : parsed.keywords;
  if (terms.length) parts.push(terms.map(formatTerm).join(mode === "any" ? " OR " : " "));
  for (const q of parsed.qualifiers) {
    if (language && q.key === "language" && !q.negated) continue; // the language filter wins
    parts.push(`${q.negated ? "-" : ""}${q.key}:${q.value}`);
  }
  if (language) parts.push(`language:${formatTerm(language)}`);
  parts.push(`stars:>=${minStars}`);
  if (!includeArchived && !parsed.qualifiers.some((q) => q.key === "archived")) parts.push("archived:false");

  const q = parts.join(" ");
  if (q.length > MAX_GITHUB_QUERY_LENGTH) throw new QueryError("Your search is too long. Please shorten it.");
  return q;
}

/** Validates request parameters. Returns { ok: true, value } or { ok: false, error }. */
export function parseSearchParams(searchParams) {
  const notes = [];
  const input = (searchParams.get("q") ?? "").trim();
  if (input.length > MAX_INPUT_LENGTH) {
    return { ok: false, error: `q must be at most ${MAX_INPUT_LENGTH} characters.` };
  }

  const languageRaw = (searchParams.get("language") ?? "").trim();
  if (languageRaw && !LANGUAGE_RE.test(languageRaw)) return { ok: false, error: "language is not valid." };
  const language = languageRaw || null;

  let minStars = DEFAULT_MIN_STARS;
  const minStarsRaw = searchParams.get("min_stars");
  if (minStarsRaw !== null && minStarsRaw !== "") {
    if (!/^\d{1,9}$/.test(minStarsRaw)) return { ok: false, error: "min_stars must be a whole number." };
    minStars = Number(minStarsRaw);
    if (minStars < MIN_STARS_FLOOR) {
      notes.push(`min_stars raised to ${MIN_STARS_FLOOR}, the lowest allowed value.`);
      minStars = MIN_STARS_FLOOR;
    }
    if (minStars > MAX_MIN_STARS) minStars = MAX_MIN_STARS;
  }

  const includeArchived = ["1", "true", "yes"].includes((searchParams.get("include_archived") ?? "").toLowerCase());

  const page = parsePositiveInt(searchParams.get("page"), 1);
  const perPage = parsePositiveInt(searchParams.get("per_page"), DEFAULT_PER_PAGE);
  if (page === null) return { ok: false, error: "page must be a whole number of at least 1." };
  if (perPage === null || perPage > MAX_PER_PAGE) {
    return { ok: false, error: `per_page must be between 1 and ${MAX_PER_PAGE}.` };
  }
  if (page * perPage > MAX_REACHABLE_RESULTS) {
    return { ok: false, error: `GitHub only returns the first ${MAX_REACHABLE_RESULTS} results of a search.` };
  }

  const parsed = parseQuery(input);
  if (!parsed.keywords.length && !parsed.qualifiers.length && !language) {
    return { ok: false, error: "Describe what you are looking for in q." };
  }

  return { ok: true, value: { input, parsed, minStars, language, includeArchived, page, perPage, notes } };
}

function parsePositiveInt(raw, fallback) {
  if (raw === null || raw === "") return fallback;
  if (!/^\d{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}

// ---------- Matching and ranking ----------

function normalizeForMatch(text) {
  return String(text ?? "").toLowerCase().replace(/[\s_-]+/g, " ");
}

function isWordChar(ch) {
  return !!ch && /[\p{L}\p{N}]/u.test(ch);
}

// Keywords must start at a word boundary ("todo" matches "todolist" but not "mytodo").
// Short keywords (3 chars or fewer, e.g. "go", "cli") must match a whole word.
// A plural "s" is dropped so "tables" also matches "table".
function containsTerm(haystack, keyword) {
  const normalized = normalizeForMatch(keyword);
  const wholeWord = normalized.length <= 3;
  const term =
    !wholeWord && normalized.endsWith("s") && !normalized.endsWith("ss") ? normalized.slice(0, -1) : normalized;
  let i = haystack.indexOf(term);
  while (i !== -1) {
    const before = i === 0 ? "" : haystack[i - 1];
    const after = haystack[i + term.length] ?? "";
    if (!isWordChar(before) && (!wholeWord || !isWordChar(after))) return true;
    i = haystack.indexOf(term, i + 1);
  }
  return false;
}

/** Which keywords appear in the repo's name, owner, description, topics or language. */
export function matchedKeywords(repo, keywords) {
  const haystack = normalizeForMatch(
    [repo.full_name, repo.description, ...(repo.topics ?? []), repo.language].join(" "),
  );
  return keywords.filter((k) => containsTerm(haystack, k));
}

/** How many key terms a partial match must contain: all of 1-2, otherwise 60% rounded up. */
export function requiredMatches(keywordCount) {
  return keywordCount <= 2 ? keywordCount : Math.ceil(keywordCount * 0.6);
}

export const RELAXED_MIN_RESULTS = 5;

/**
 * Chooses results when too few projects match every keyword. Tries progressively looser rules and
 * uses the strictest one that yields at least RELAXED_MIN_RESULTS projects:
 *   key_terms_plus  every key term + at least a third of the descriptive words
 *   key_terms       every key term
 *   most_key_terms  60% of key terms (only when there are 3+ key terms)
 * Exact matches (strictItems) are always included. Output is ranked by stars.
 */
export function selectRelaxed(strictItems, candidates, parsed) {
  const { core, soft } = parsed;
  const scored = dedupeById(candidates).map((repo) => ({
    repo,
    coreHits: matchedKeywords(repo, core).length,
    softHits: matchedKeywords(repo, soft).length,
  }));

  const levels = [];
  if (soft.length) {
    const needSoft = Math.ceil(soft.length / 3);
    levels.push(["key_terms_plus", (x) => x.coreHits === core.length && x.softHits >= needSoft]);
  }
  levels.push(["key_terms", (x) => x.coreHits === core.length]);
  if (core.length >= 3) levels.push(["most_key_terms", (x) => x.coreHits >= requiredMatches(core.length)]);

  for (let i = 0; i < levels.length; i++) {
    const [level, test] = levels[i];
    const items = sortByStars(dedupeById([...strictItems, ...scored.filter(test).map((x) => x.repo)]));
    if (items.length >= RELAXED_MIN_RESULTS || i === levels.length - 1) return { level, items };
  }
}

/** Highest stars first; ties broken by name so ordering is stable. */
export function sortByStars(repos) {
  return [...repos].sort(
    (a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0) || String(a.full_name).localeCompare(String(b.full_name)),
  );
}

// GitHub's UI caps descriptions at 350 characters, but the API lets spam repos store tens of
// thousands of keywords there to match every search. Legitimate descriptions are far shorter.
export const MAX_DESCRIPTION_LENGTH = 1000;

export function isLikelySpam(repo) {
  return typeof repo.description === "string" && repo.description.length > MAX_DESCRIPTION_LENGTH;
}

export function dedupeById(repos) {
  const seen = new Set();
  return repos.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

export function safeHttpUrl(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Keep only the fields clients need. */
export function simplifyRepo(r) {
  const spdx = r.license?.spdx_id;
  return {
    name: r.full_name,
    url: safeHttpUrl(r.html_url),
    description: r.description ?? null,
    stars: r.stargazers_count ?? 0,
    forks: r.forks_count ?? 0,
    language: r.language ?? null,
    topics: Array.isArray(r.topics) ? r.topics : [],
    license: spdx && spdx !== "NOASSERTION" ? spdx : null,
    homepage: safeHttpUrl(r.homepage),
    archived: Boolean(r.archived),
    openIssues: r.open_issues_count ?? 0,
    pushedAt: r.pushed_at ?? null,
  };
}

export function describeQualifiers(parsed, language) {
  return parsed.qualifiers
    .filter((q) => !(language && q.key === "language" && !q.negated))
    .map((q) => `${q.negated ? "-" : ""}${q.key}:${q.value}`);
}
