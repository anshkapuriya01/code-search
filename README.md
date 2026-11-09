# Code Search

GitHub search built for AI agents. An agent describes a project in plain words; Code Search returns the public
repositories that match, drops low-star projects and keyword-stuffed spam, and puts the best matches first, then the most-starred.

- **MCP server** at `/mcp` (Streamable HTTP) with two tools: `search_repositories` and `get_repository_readme`.
- **REST API** at `/v1/search` and `/v1/repos/{owner}/{repo}/readme`, described in `/openapi.json` and `/llms.txt`.
- **Landing page** at `/`, **dashboard** at `/app/` (live search, agent setup, API keys, usage analytics, account), **docs** at `/docs/`.
- **AI query understanding** with Cloudflare Workers AI, and an **admin console** at `/admin/`.
- **A guide for AI agents** at `/code-search.md`, also served as the MCP resource `code-search://guide`. MCP clients get its key points when they connect.
- **Sign in with GitHub** is the only login. Each user's searches run on their own GitHub quota (30/min), so the
  service scales with its users and stays free to run.
- Runs on **Cloudflare Workers + D1 + static assets**.

## Agent setup

The landing page, `/docs/#agents` and the dashboard's Connect page show the exact snippet for Claude Code, Codex,
Cursor, Grok (xAI Responses API), GitHub Copilot in VS Code, Windsurf and Gemini CLI. For example:

```sh
claude mcp add --transport http --scope user code-search https://codesearch.amplfyd.com/mcp \
  --header "Authorization: Bearer codesearch_..."
```

## How search works

1. **Understand the request.** Cloudflare Workers AI reads the request and proposes key terms, descriptive words,
   synonyms and context (`src/ai.js`). Its answer is checked against the request, so it cannot drop a needed word, invent a
   requirement or add a GitHub qualifier. Llama 3.3 70B is used for the first 60% of the daily budget, then Llama 3.1 8B.
   Plans are remembered for 24 hours. If AI is unavailable, slow, wrong or over budget, the rules below take over, and
   `query.interpretedBy` says which one ran. The rules: phrases are normalised ("self hosted", "host it on my own server", "on-prem" all
   become `self-hosted`; "e-mail" becomes `email`). Phrases about the user rather than the project ("for my
   business", "for my team", "for free") are set aside and returned in `query.context`. A product named as a
   reference ("like slack", "alternative to google analytics") becomes a ranking hint, or the subject when nothing
   else is. Filler words are dropped; the rest split into **key terms** (must match) and **descriptive words**
   (alternative, library, lightweight, self-hosted, language names), which lift the results that have them.
2. **Fetch candidates** (each up to 100, sorted by stars, `stars:>=min_stars`, archived repos excluded): every
   word; the key terms alone when there are descriptive words; for known subjects a related phrase ("self-hosted
   email" also asks for `mail server`); and, if fewer than ten fit, GitHub's best matches for any key term.
3. **Filter.** A project must contain every key term or a close synonym (`email` ≈ mail, smtp, imap) in its name,
   topics or description; with three or more key terms and fewer than ten full matches, 60% is enough. Descriptions
   over 1,000 characters (keyword-stuffed spam) are dropped.
4. **Rank.** A term in the name, topics or opening of the description counts far more than one buried later
   ("...extracts business emails"), descriptive words add a bonus, awesome-lists and (for self-hosted requests)
   libraries and test tools are pushed down, and stars break the rest (each 10x adds a little). Up to 100 ranked
   results are cached and paged. `matchLevel` names the loosest rule a result needed.

The parser (`public/lib/query.js`) is shared: the Worker imports it and the landing page runs the same file in the
browser for its live demo.

## Built for load

| Concern | How it is handled |
|---|---|
| GitHub rate limits | Every user searches with their own token. 429s carry `Retry-After`; MCP tools tell the agent how long to wait. |
| Repeated searches | 10-minute cache private to each account (per-isolate memory, then Cloudflare's edge cache on the custom domain). Nothing cached or in flight is shared between accounts. |
| READMEs | Cached 1 h per account. At most 128 KB is read from GitHub and 20,000 characters kept, so one huge file cannot exhaust the Worker's memory. |
| Database reads | API keys and sessions are cached in memory for 60 s (invalid keys 30 s). Revocation clears the local entry at once; other isolates follow within 60 s. Key "last used" is written at most once an hour. |
| Runaway clients | Per account: 60 requests/min, 1,500 requests/day, 500 AI neurons/day. Whole site: 15,000 requests/day, which keeps database writes free for sign-ins. Anonymous: 60 failed calls/min per IP. The numbers are in `wrangler.toml`; the admin account is exempt. Add a Cloudflare WAF rate-limit rule too: a Worker cannot stop requests from counting toward Cloudflare's daily request quota. |
| CPU | The heaviest search measured about 1.5 ms of CPU. |
| Debugging | Every API response has `X-Request-Id` and `Server-Timing`. |
| AI cost | At most `AI_DAILY_NEURONS` (9,000 of the 10,000 free) a day, counted from each response's token usage. A plan costs about 21 neurons on the larger model and 4 on the smaller. |
| Log size | The API call log keeps at most 30,000 calls for 90 days, so it cannot fill D1's 500 MB. Each call adds two background row writes. |

Cloudflare's free plan allows 100,000 Worker requests a day; static pages do not count. Past that, the Workers paid
plan ($5/month) covers 10 million requests.

## Admin console

`/admin/` is for the single GitHub account whose numeric id is `ADMIN_GITHUB_ID` (`wrangler.toml`); it does not exist for anyone else. That account has no usage limits.

- **Close new registrations** blocks accounts that do not exist yet and hides sign-up buttons site-wide. Existing users and admins can still sign in.
- **Users** shows each account, when it joined, its last call and its totals.
- **API calls** lists every call by a signed-in user (REST, MCP, dashboard, sign-ins, key changes) with what was searched, how it was understood and what was returned. Only two background checks are left out: `GET /api/me` and `GET /api/usage`. Calls without a valid account cannot be attributed and are not stored. API keys, tokens and IP addresses are never logged. Deleting an account deletes its log.

## Deploy

Already deployed once? Then this is all:

```sh
npm run db:migrate:remote
npm run deploy
```

Migrations add `key_usage` and the admin, log, AI and daily-limit tables. If you forget them, the Worker creates the tables itself on first use (and logs a warning), so tracking still works. If Cloudflare rejects the `[[ratelimits]]` block on your plan,
delete it from `wrangler.toml`; the Worker falls back to its in-memory limiter.

First deploy from scratch: `npx wrangler login`, `npx wrangler d1 create starscout` (put the id in `wrangler.toml`),
`npm run db:migrate:remote`, `npm run deploy`, then set the secrets `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and
`TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`) with `npx wrangler secret put <NAME>`. The GitHub OAuth app needs
the redirect URIs `https://codesearch.amplfyd.com/auth/callback` and `http://localhost:8787/auth/callback`, with
"Expire user access tokens" unchecked.

The internal Cloudflare names (`starscout` Worker and database) are not shown to users and are kept so the existing
deployment, secrets and data carry over.

## Run locally

```sh
cp .dev.vars.example .dev.vars        # OAuth app id/secret and an encryption key
npm run db:migrate:local
npm run dev                           # http://localhost:8787
```

To try the whole dashboard (sign-in, search, keys, Usage) without a GitHub OAuth app, run `node scripts/dev-mock.mjs` and open http://127.0.0.1:8790. It runs the real Worker and local D1 against a fake GitHub that answers from `public/data/demo.json`.

## Tests

```sh
npm test            # unit tests: parsing, AI plan checks and budget, matching, ranking, search flow, audit log, crypto
npm run test:e2e    # the real Worker + local D1 with a mock GitHub login: OAuth, keys, REST v1, MCP, admin console,
                    # closed registration, call log; searches hit the real GitHub API. AI is off by default;
                    # E2E_REAL_AI=1 also runs one search through real Workers AI (uses a few neurons).
```

## Security

- The OAuth app requests no scopes, so tokens read public data only. Tokens are stored AES-256-GCM encrypted;
  sessions and API keys only as SHA-256 hashes.
- OAuth `state` check; `HttpOnly`, `SameSite=Lax`, `__Host-` cookies; same-origin checks on every state-changing call.
- `/mcp` accepts only API keys (no cookies) and rejects foreign `Origin` headers.
- Strict Content-Security-Policy (`public/_headers`); pages never render data as HTML.

## Credits

Photographs in `public/img/*.webp` were generated for Code Search with the OpenAI Image API. Logo from the Code Search brand file, traced to SVG with potrace. Fonts: Geist and Geist Mono, Caveat, Anton (SIL Open Font License). Smooth scrolling: Lenis (MIT), vendored in `public/lib/lenis.min.js`. The landing, docs, privacy, terms and 404 pages are generated by `python3 scripts/build_pages.py`; edit that script, not the HTML. Agent marks from
`@lobehub/icons-static-svg` (MIT) and `simple-icons` (CC0); the marks belong to their owners and Code Search is not
affiliated with them.

## License

Code Search is licensed under [Creative Commons Attribution-NonCommercial-ShareAlike 4.0](LICENSE)
(CC BY-NC-SA 4.0). You may use, study, modify and share the code, as long as you:

- **give credit** to the original project,
- **do not use it commercially** (no selling it, no charging users for it or for a service built on it), and
- **release your changes under the same license**, so every copy stays open.

Third-party files keep their own licenses (see Credits above).
