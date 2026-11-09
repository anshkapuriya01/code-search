// Pure search logic: understand a plain-English request, turn it into GitHub queries, decide which
// results match and rank them by how well they match, then by stars. No network or Worker APIs here.

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
   repository repositories github open source opensource open-source please help let lets using use
   used uses based built written made make makes so than too not no yes all each every other another
   while both either etc free support supports supported supporting feature features functionality
   allow allows allowing able ability capability capabilities way ways thing things stuff kind
   self own myself ourselves yourself recommend recommendation recommendations suggest suggestion
   suggestions tell know provide provides offer offers try trying cheap cheaper affordable paid
   cost costs everything someone anyone m s d t ll re ve im`.split(/\s+/),
);

// Descriptive words: they describe the kind of project, not the subject. They are optional when
// matching, so "lightweight python library for pdf tables" is about "pdf tables" first.
const SOFT_WORDS = new Set(
  `lightweight light simple minimal minimalist minimalistic fast faster quick small tiny easy easily
   modern beautiful powerful clean awesome robust efficient scalable flexible secure
   library libraries lib libs framework frameworks tool tools toolkit utility utilities util utils
   app apps application applications software program programs platform system solution service
   package module plugin plugins extension extensions alternative alternatives replacement clone
   hosted self-hosted selfhosted self-host cross-platform
   python javascript js typescript ts golang rust java kotlin swift ruby php c++ cpp c# csharp dart
   scala elixir haskell lua node node.js nodejs`.split(/\s+/),
);

// ---------- Understanding the request ----------

export const SELF_HOSTED = "self-hosted";
const OWN_INFRA = String.raw`(?:servers?|vps|hardware|machines?|infrastructure|infra|domain|cloud|homelab|box)`;

// Phrases rewritten to one canonical term before the words are split, so "self hosted",
// "host it myself" and "on my own server" all become the single requirement "self-hosted".
const REWRITES = [
  [/\be[\s-]mails?\b/g, "email"],
  [/\bself[\s-]*host(?:ed|ing|able|s)?\b/g, SELF_HOSTED],
  [/\bon[\s-]?prem(?:ise|ises)?\b/g, SELF_HOSTED],
  [
    new RegExp(
      String.raw`\b(?:host|run|deploy|install)(?:ed|ing|s)?\s+(?:it\s+|them\s+|this\s+)?(?:myself|ourselves|yourself|on\s+(?:my|our|your)\s+own(?:\s+${OWN_INFRA})?)\b`,
      "g",
    ),
    SELF_HOSTED,
  ],
  [new RegExp(String.raw`\b(?:on|in)\s+(?:my|our|your)\s+own\s+${OWN_INFRA}\b`, "g"), SELF_HOSTED],
  [/\bvideo\s+(?:calls?|calling|meetings?)\b/g, "video conferencing"],
];

// Fixed compounds that contain a filler word. Without this, "project management" is searched as just
// "management" and "search engine" as just "engine". Each becomes one hyphenated, singular term.
const COMPOUNDS = [
  /\b(?:full[\s-]?text|code|vector|semantic|fuzzy|image|web|site|enterprise)[\s-]+search(?:[\s-]+engines?)?\b/g,
  /\bsearch[\s-]+engines?\b/g,
  /\bproject[\s-]+management\b/g,
  /\bhelp[\s-]*desks?\b/g,
  /\bfeature[\s-]+(?:flags?|toggles?)\b/g,
  /\b(?:no|low)[\s-]+code\b/g,
  /\bsource[\s-]+maps?\b/g,
  /\bopen[\s-]+banking\b/g,
];

const joinCompound = (m) =>
  ` ${m
    .trim()
    .replace(/[\s-]+/g, "-")
    .replace(/-search-engines?$/, "-search")
    .replace(/s$/, "")} `;

/** Lower-cases text and rewrites known phrases to their one canonical term. */
export function canonicalize(raw) {
  let text = ` ${String(raw ?? "").toLowerCase()} `;
  for (const [re, rep] of REWRITES) text = text.replace(re, ` ${rep} `);
  for (const re of COMPOUNDS) text = text.replace(re, joinCompound);
  return text;
}

// Who it is for and what it costs describe the user, not the project: "email for my business"
// is about email. These phrases are removed and reported back as context.
const AUDIENCE = String.raw`(?:business(?:es)?|compan(?:y|ies)|startups?|start-ups?|teams?|organi[sz]ations?|orgs?|agenc(?:y|ies)|firms?|offices?|famil(?:y|ies)|household|clients?|customers?|employees?|staff|colleagues|friends|users?|use|usage|needs?|purposes?|work|workplace|side\s+projects?|projects?|enterprises?|ngos?|non-?profits?|schools?|students?|myself|me|us)`;
const AUDIENCE_MOD = String.raw`(?:my|our|your|his|her|their|a|an|the|this|that|small|smaller|little|local|growing|own|new|whole|entire|tiny|medium|mid-sized|large|big|personal|internal|commercial|private|family|online|everyday|daily|non-commercial)`;
const CONTEXT_PATTERNS = [
  new RegExp(String.raw`\b(?:for|in|at|within|across|by)\s+(?:${AUDIENCE_MOD}\s+){0,3}${AUDIENCE}\b`, "g"),
  // "for my blog" describes the user; "comment system for blog" names what it plugs into.
  /\b(?:for|on|in)\s+(?:my|our|your)\s+(?:own\s+|personal\s+|small\s+|new\s+)*(?:websites?|site|blog)\b/g,
  /\b(?:my|our|your)\s+(?:own\s+)?(?:small\s+)?(?:business|company|startup|team|organi[sz]ation|agency|firm)\b/g,
  /\bsmall\s+business(?:es)?\b/g,
  /\b(?:for|at)\s+(?:free|no\s+cost|zero\s+cost)\b|\bfree\s+of\s+(?:charge|cost)\b|\b(?:with\s+)?no\s+(?:cost|charges?|fees?|subscriptions?)\b|\bwithout\s+(?:paying|payment|any\s+cost|cost|fees?|a\s+subscription|subscriptions?)\b|\bcosts?\s+nothing\b|\bfree\s+(?:to\s+use|forever|tier|plan)\b|\b(?:totally|completely|100%)\s+free\b/g,
];

// "like slack", "alternative to google analytics": the named product is a reference point.
const REF_RE = /\b(?:like|similar\s+to|alternatives?\s+(?:to|for)|replacements?\s+(?:to|for|of)|instead\s+of|clones?\s+of|substitutes?\s+(?:to|for)|competitors?\s+(?:to|of))\s+([\p{L}\p{N}][\p{L}\p{N}+#.-]*)/gu;
const NEXT_WORD_RE = /^\s+([\p{L}\p{N}][\p{L}\p{N}+#.-]*)/u;
// Vendors whose products are usually named with two words ("google analytics", "microsoft teams").
const BRAND_PREFIXES = new Set("google microsoft ms adobe apple amazon aws zoho atlassian visual power new sublime".split(" "));

// Related words that mean the same thing in a project description. `hosted` is what a
// self-hosted version of the thing is usually called, used to fetch extra candidates; `hints` are
// words that show a project is the self-hosted kind (a "mail server" is self-hosted email even if
// its description never says "self-hosted").
const MAIL_HINTS = ["mailserver", "smtp", "imap", "postfix", "dovecot", "webmail", "mta"];
const HOSTED_HINTS = ["server", "docker", "homelab"];
const CONCEPTS = Object.assign(Object.create(null), {
  email: { alts: ["mail", "mailserver", "smtp", "imap", "webmail"], hosted: "mail server", hints: MAIL_HINTS },
  mail: { alts: ["email", "mailserver", "smtp", "imap"], hosted: "mail server", hints: MAIL_HINTS },
  chat: { alts: ["messaging", "messenger", "team chat"], hosted: "chat server", hints: ["matrix", "xmpp"] },
  messaging: { alts: ["chat", "messenger"] },
  vpn: { alts: ["wireguard", "openvpn"], hosted: "vpn server", hints: ["wireguard"] },
  notes: { alts: ["note taking", "notetaking", "notebook"] },
  note: { alts: ["note taking", "notetaking", "notebook"] },
  todo: { alts: ["to do", "task manager", "tasks"] },
  kubernetes: { alts: ["k8s"] },
  k8s: { alts: ["kubernetes"] },
  database: { alts: ["db"] },
  db: { alts: ["database"] },
  ai: { alts: ["llm", "gpt", "machine learning", "artificial intelligence"] },
  llm: { alts: ["ai", "gpt", "language model"] },
  tts: { alts: ["text to speech", "speech synthesis"] },
  stt: { alts: ["speech to text", "speech recognition", "transcription", "asr"] },
  transcription: { alts: ["speech to text", "speech recognition", "transcribe"] },
  ocr: { alts: ["text recognition"] },
  scraper: { alts: ["scraping", "scrape", "crawler", "crawling", "spider"] },
  scraping: { alts: ["scraper", "scrape", "crawler", "crawling", "spider"] },
  crawler: { alts: ["scraper", "scraping", "crawling", "spider"] },
  photo: { alts: ["image", "picture", "gallery"] },
  photos: { alts: ["image", "picture", "gallery"] },
  image: { alts: ["photo", "picture"] },
  images: { alts: ["photo", "picture"] },
  crm: { alts: ["customer relationship"] },
  invoice: { alts: ["invoicing", "billing"] },
  invoicing: { alts: ["invoice", "billing"] },
  monitoring: { alts: ["observability", "uptime"] },
  calendar: { alts: ["caldav", "scheduling"] },
  conferencing: { alts: ["conference", "meeting", "meetings", "webrtc", "video call"] },
  tables: { alts: ["table", "tabular"] },
  table: { alts: ["tables", "tabular"] },
  excel: { alts: ["xlsx", "xls", "spreadsheet"] },
  spreadsheet: { alts: ["excel", "xlsx", "sheets"] },
  convert: { alts: ["converter", "conversion", "extract", "export"] },
  alternative: { alts: ["alternatives", "replacement", "replace", "clone", "instead of"] },
  [SELF_HOSTED]: { alts: ["self host", "selfhost", "on premise", "on prem", "homelab"] },
  selfhosted: { alts: ["self host", "selfhost", "on premise", "homelab"] },
  "project-management": { alts: ["task management", "project manager"] },
  "help-desk": { alts: ["helpdesk", "ticketing", "support ticket"] },
  "feature-flag": { alts: ["feature toggle", "feature management"] },
  "feature-toggle": { alts: ["feature flag", "feature management"] },
  "no-code": { alts: ["nocode", "low-code"] },
  "low-code": { alts: ["lowcode", "no-code"] },
  "search-engine": { alts: ["full text search", "fulltext"] },
  "full-text-search": { alts: ["search engine", "fulltext"] },
  "vector-search": { alts: ["vector database", "similarity search"] },
});

/** The term plus the words that mean the same thing in a project description. */
export function alternativesFor(term, synonyms) {
  return [term, ...(CONCEPTS[term]?.alts ?? []), ...(synonyms?.[term] ?? [])];
}

export const isFillerWord = (t) => STOPWORDS.has(t);
export const isDescriptiveWord = (t) => SOFT_WORDS.has(t);

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

function cleanWord(w) {
  return w.toLowerCase().replace(/[._-]+$/, "").slice(0, 50);
}

function pushWords(token, terms) {
  for (const m of token.toLowerCase().matchAll(WORD_RE)) {
    const word = cleanWord(m[0]);
    if (word) terms.push(word);
  }
}

/** Plain text (no qualifiers or quotes): canonical phrases, context removal, reference products. */
function understandText(raw, out) {
  let text = canonicalize(raw);
  for (const re of CONTEXT_PATTERNS) {
    text = text.replace(re, (m) => {
      out.context.push(m.trim().replace(/\s+/g, " "));
      return " ";
    });
  }

  let last = 0;
  for (const m of text.matchAll(REF_RE)) {
    if (m.index < last) continue;
    const first = cleanWord(m[1]);
    if (!first || STOPWORDS.has(first) || SOFT_WORDS.has(first)) continue;
    let end = m.index + m[0].length;
    let ref = first;
    const next = NEXT_WORD_RE.exec(text.slice(end));
    if (next && BRAND_PREFIXES.has(first)) {
      const second = cleanWord(next[1]);
      if (second && !STOPWORDS.has(second) && !SOFT_WORDS.has(second)) {
        ref = `${first} ${second}`;
        end += next[0].length;
      }
    }
    pushWords(text.slice(last, m.index), out.terms);
    out.terms.push("alternative", ref);
    out.refs.add(ref);
    last = end;
  }
  pushWords(text.slice(last), out.terms);
}

/**
 * Splits free text into keywords and GitHub qualifiers.
 * Returns {
 *   keywords: string[]   all search words, in order
 *   core: string[]       key terms (must match); all keywords if every word is descriptive
 *   soft: string[]       descriptive words (optional, used for ranking)
 *   refs: string[]       products named as a reference ("like slack")
 *   context: string[]    phrases about the user, not the project ("for my business", "for free")
 *   altTerms: string[]|null  key terms rephrased with a related concept, for one extra GitHub query
 *   altSearches: string[][]  every rephrasing to fetch extra candidates with
 *   quoted: string[]     phrases the user put in quotes; always required
 *   qualifiers: {key, value, negated}[], ignored: string[]
 * }
 */
export function parseQuery(input) {
  const text = String(input ?? "").slice(0, MAX_INPUT_LENGTH);
  const out = { terms: [], context: [], refs: new Set() };
  const quoted = [];
  const qualifiers = [];
  const ignored = [];
  let plain = [];
  const flush = () => {
    if (plain.length) understandText(plain.join(" "), out);
    plain = [];
  };

  for (const m of text.matchAll(TOKEN_RE)) {
    const [whole, neg, key, value, phrase, word] = m;
    if (key !== undefined) {
      const k = key.toLowerCase();
      if (ALLOWED_QUALIFIERS.has(k) && value.replace(/"/g, "").trim()) {
        flush();
        qualifiers.push({ key: k, value, negated: neg === "-" });
      } else if (MANAGED_QUALIFIERS.has(k)) {
        flush();
        ignored.push(whole);
      } else {
        plain.push(whole); // e.g. "http://..." or "note:" is just text
      }
    } else if (phrase !== undefined) {
      flush();
      const p = phrase.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 50);
      if (p) {
        out.terms.push(p);
        quoted.push(p);
      }
    } else if (word.length > 1 && word.startsWith("-")) {
      ignored.push(word); // excluding plain words is not supported
    } else {
      plain.push(word);
    }
  }
  flush();

  // "notion alternative", "trello clone": the word before is the reference product.
  out.terms.forEach((t, i) => {
    if (i && /^(?:alternatives?|replacements?|clones?)$/.test(t)) {
      const prev = out.terms[i - 1];
      if (!STOPWORDS.has(prev) && !SOFT_WORDS.has(prev)) out.refs.add(prev);
    }
  });

  const unique = [...new Set(out.terms)];
  const meaningful = unique.filter((t) => t.includes(" ") || !STOPWORDS.has(t));
  const candidates = meaningful.length ? meaningful : unique;

  // A named product is the subject only when nothing else is ("notion alternative"); next to other
  // key terms ("chat app like slack") it is a hint for ranking.
  const isRef = (t) => out.refs.has(t);
  const hasOtherCore = candidates.some((t) => !SOFT_WORDS.has(t) && !isRef(t));
  const isSoft = (t) => SOFT_WORDS.has(t) || (hasOtherCore && isRef(t));

  // Over the limit: keep key terms before descriptive words, preserving the original order.
  const keep = new Set();
  for (const t of candidates) if (!isSoft(t) && keep.size < MAX_KEYWORDS) keep.add(t);
  for (const t of candidates) if (isSoft(t) && keep.size < MAX_KEYWORDS) keep.add(t);
  const keywords = candidates.filter((t) => keep.has(t));
  ignored.push(...candidates.filter((t) => !keep.has(t)));

  const coreOnly = keywords.filter((t) => !isSoft(t));
  const core = coreOnly.length ? coreOnly : keywords;
  const soft = coreOnly.length ? keywords.filter(isSoft) : [];
  const altTerms = alternateTerms(core, soft);
  return {
    keywords,
    core,
    soft,
    refs: keywords.filter(isRef),
    context: [...new Set(out.context)],
    altTerms,
    altSearches: altTerms ? [altTerms] : [],
    quoted,
    qualifiers,
    ignored,
  };
}

/** The request without GitHub qualifiers or excluded words: only the words that describe the project. */
export function plainQueryText(input) {
  const kept = [];
  for (const m of String(input ?? "").slice(0, MAX_INPUT_LENGTH).matchAll(TOKEN_RE)) {
    const [whole, , key, , phrase, word] = m;
    if (key !== undefined) {
      const k = key.toLowerCase();
      if (!ALLOWED_QUALIFIERS.has(k) && !MANAGED_QUALIFIERS.has(k)) kept.push(whole);
    } else if (phrase !== undefined) {
      kept.push(phrase);
    } else if (!(word.length > 1 && word.startsWith("-"))) {
      kept.push(word);
    }
  }
  return kept.join(" ").replace(/\s+/g, " ").trim();
}

/** Key terms with the first one that has a known related concept swapped for it. */
export function alternateTerms(core, soft) {
  const wantsHosting = soft.includes(SELF_HOSTED) || soft.includes("selfhosted") || soft.includes("self-host");
  const i = core.findIndex((t) => CONCEPTS[t] && t !== SELF_HOSTED);
  if (i === -1) return null;
  const c = CONCEPTS[core[i]];
  const swap = (wantsHosting && c.hosted) || c.alts[0];
  const terms = [...core];
  terms.splice(i, 1, ...swap.split(" "));
  return [...new Set(terms)];
}

function formatTerm(term) {
  return /\s/.test(term) ? `"${term}"` : term;
}

/**
 * Builds a GitHub repository search query.
 *   "strict": every keyword must match
 *   "core":   every key term must match (descriptive words left out)
 *   "alt":    key terms with one swapped for a related concept (parsed.altTerms)
 *   "any":    any key term may match (up to MAX_OR_TERMS)
 */
export function buildQuery(parsed, { minStars, language, includeArchived }, mode = "strict") {
  const parts = [];
  const terms =
    mode === "core"
      ? parsed.core
      : mode === "alt"
        ? (parsed.altTerms ?? parsed.core)
        : mode === "any"
          ? parsed.core.slice(0, MAX_OR_TERMS)
          : parsed.keywords;
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

// Light stemming so "converter" finds "converting", "hosting" finds "hosted" and "tables" finds "table".
export function stem(term) {
  if (term.length <= 3 || term.includes(" ")) return term;
  if (term.endsWith("ing") && term.length > 6) return term.slice(0, -3);
  if (term.endsWith("ies") && term.length > 5) return term.slice(0, -3);
  if (term.endsWith("ed") && term.length > 5 && !term.endsWith("eed")) return term.slice(0, -2);
  if (term.endsWith("er") && term.length > 7) return term.slice(0, -2);
  if (term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
  return term;
}

// Keywords must start at a word boundary ("todo" matches "todolist" but not "mytodo").
// Short keywords (3 chars or fewer, e.g. "go", "cli") must match a whole word.
function containsTerm(haystack, keyword) {
  const normalized = normalizeForMatch(keyword);
  const wholeWord = normalized.length <= 3;
  const term = wholeWord ? normalized : stem(normalized);
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

const splitCamel = (s) => String(s ?? "").replace(/([a-z\d])([A-Z])/g, "$1 $2");

// Where a project says what it *is*: its name, its topics and the opening of its description.
// A word buried later in the description ("...extracts business emails") counts for much less.
const WEIGHT = { name: 1, topics: 0.85, lead: 0.85, owner: 0.35, rest: 0.35, language: 0.6 };
const TOPIC_STUFFING = 12; // repos tagging every buzzword get less credit per topic

function leadLength(desc) {
  const re = /[.!?;|](?:\s|$)|\s[-–—|]\s/g;
  let m;
  while ((m = re.exec(desc))) if (m.index >= 60) return Math.min(m.index, 160);
  return Math.min(desc.length, 160);
}

function fieldsOf(repo) {
  const [owner = "", name = ""] = String(repo.full_name ?? "").split("/");
  const desc = String(repo.description ?? "");
  const cut = leadLength(desc);
  const topics = Array.isArray(repo.topics) ? repo.topics : [];
  return {
    name: normalizeForMatch(splitCamel(name)),
    topics: normalizeForMatch(topics.join(" ")),
    lead: normalizeForMatch(desc.slice(0, cut)),
    rest: normalizeForMatch(desc.slice(cut)),
    owner: normalizeForMatch(splitCamel(owner)),
    language: normalizeForMatch(repo.language),
    topicWeight: topics.length > TOPIC_STUFFING ? 0.55 : WEIGHT.topics,
  };
}

function bestHit(fields, alts) {
  let best = 0;
  for (const alt of alts) {
    for (const f of ["name", "topics", "lead", "language", "owner", "rest"]) {
      const w = f === "topics" ? fields.topicWeight : WEIGHT[f];
      if (w > best && containsTerm(fields[f], alt)) best = w;
    }
  }
  return best;
}

// A word the model suggested counts for less than the user's own words, so a repository merely named
// "issue-tracker" does not outrank one that says "project management".
const MODEL_SYNONYM_WEIGHT = 0.75;

function keyTermHit(fields, term, synonyms) {
  const direct = bestHit(fields, alternativesFor(term));
  return synonyms?.[term] ? Math.max(direct, MODEL_SYNONYM_WEIGHT * bestHit(fields, synonyms[term])) : direct;
}

const isSelfHostedTerm = (t) => t === SELF_HOSTED || t === "selfhosted" || t === "self-host";

// Explicit requirements ("self-hosted", "like slack") count for more than flavour words ("simple").
function softWeight(term, parsed) {
  if (isSelfHostedTerm(term) || (parsed.refs ?? []).includes(term)) return 0.3;
  return term === "alternative" && wantsAlternative(parsed) ? 0.3 : 0.1;
}

// A soft word's hit; for "self-hosted", words that merely suggest a deployable service ("mail
// server", "docker") count at 60% of the project saying "self-hosted" outright.
function softHit(fields, term, parsed) {
  const literal = bestHit(fields, alternativesFor(term));
  if (!isSelfHostedTerm(term)) return literal;
  const hints = [...HOSTED_HINTS, ...parsed.core.flatMap((t) => CONCEPTS[t]?.hints ?? [])];
  return Math.max(literal, 0.6 * bestHit(fields, hints));
}

// Someone asking for a self-hosted service wants something to run, not code to build one with.
const BUILDING_BLOCK_RE = /\b(?:library|libraries|sdk|bindings?|wrapper|boilerplate|starter|template|templates|tutorial|example|examples|learn|testing|fake|mock)\b/;
const BUILDING_BLOCK_WORDS = new Set(["library", "libraries", "lib", "libs", "sdk", "framework", "frameworks", "package", "module", "template", "templates", "boilerplate", "testing", "test", "mock"]);

function wantsAlternative(parsed) {
  return (parsed.refs ?? []).some((r) => parsed.core.includes(r));
}

function wantsService(parsed) {
  return parsed.soft.some(isSelfHostedTerm) && !parsed.keywords.some((k) => BUILDING_BLOCK_WORDS.has(k));
}

const LIST_WORDS = new Set(["awesome", "list", "lists", "curated", "collection", "resources"]);

function isCuratedList(repo) {
  const name = String(repo.full_name ?? "").split("/")[1] ?? "";
  const topics = Array.isArray(repo.topics) ? repo.topics : [];
  return /^awesome[-_.]|[-_.]awesome$|^awesome$/i.test(name) || topics.includes("awesome") || topics.includes("awesome-list");
}

/**
 * How well one repository fits the request.
 *   coreHits   key terms (or a related word) found anywhere
 *   softHits   descriptive words found anywhere
 *   relevance  0..~1.3: key terms weighted by where they appear, plus a bonus per descriptive word
 *   score      relevance plus a popularity term (each 10x in stars adds 0.12)
 */
export function scoreRepo(repo, parsed) {
  const fields = fieldsOf(repo);
  const core = parsed.core.map((t) => keyTermHit(fields, t, parsed.synonyms));
  const soft = parsed.soft.map((t) => softHit(fields, t, parsed));
  let relevance = core.length ? core.reduce((a, b) => a + b, 0) / core.length : 0;
  const bonus = soft.reduce((sum, hit, i) => sum + softWeight(parsed.soft[i], parsed) * Math.min(hit, WEIGHT.lead), 0);
  relevance += Math.min(0.45, bonus);
  if (isCuratedList(repo) && !parsed.keywords.some((k) => LIST_WORDS.has(k))) relevance *= 0.5;
  // "alternative to google analytics" wants a replacement, not a Google Analytics plugin.
  if (wantsAlternative(parsed) && bestHit(fields, alternativesFor("alternative")) === 0) relevance *= 0.7;
  if (wantsService(parsed) && BUILDING_BLOCK_RE.test(`${fields.name} ${fields.lead} ${fields.topics}`)) relevance *= 0.8;
  const stars = Math.max(0, Number(repo.stargazers_count) || 0);
  return {
    repo,
    coreHits: core.filter((h) => h > 0).length,
    softHits: soft.filter((h) => h > 0).length,
    relevance,
    score: relevance + 0.12 * Math.log10(stars + 1),
  };
}

export const RELAXED_MIN_RESULTS = 10;

/**
 * Picks and orders the results.
 * `trusted` holds ids GitHub matched on every word; they are always eligible. Other candidates must
 * contain every key term (or a related word); if that leaves fewer than RELAXED_MIN_RESULTS and there
 * are 3+ key terms, 60% of them is enough. Output is ordered by score (match quality, then stars).
 * matchLevel describes the loosest result: all_keywords, key_terms_plus, key_terms or most_key_terms.
 */
export function rankResults(candidates, parsed, { trusted = new Set() } = {}) {
  const n = parsed.core.length;
  const scored = dedupeById(candidates).map((repo) => ({ ...scoreRepo(repo, parsed), trusted: trusted.has(repo.id) }));

  let level = "key_terms";
  let chosen = scored.filter((x) => x.trusted || x.coreHits === n);
  if (chosen.length < RELAXED_MIN_RESULTS && n >= 3) {
    const loose = scored.filter((x) => x.trusted || x.coreHits >= requiredMatches(n));
    if (loose.length > chosen.length) {
      chosen = loose;
      level = "most_key_terms";
    }
  }
  if (level === "key_terms" && chosen.length) {
    const full = (x) => x.trusted || (x.coreHits === n && x.softHits === parsed.soft.length);
    if (chosen.every(full)) level = "all_keywords";
    else if (parsed.soft.length && chosen.every((x) => full(x) || x.softHits > 0)) level = "key_terms_plus";
  }

  chosen.sort(
    (a, b) =>
      b.score - a.score ||
      (b.repo.stargazers_count ?? 0) - (a.repo.stargazers_count ?? 0) ||
      String(a.repo.full_name).localeCompare(String(b.repo.full_name)),
  );
  return { level, items: chosen.map((x) => x.repo) };
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
