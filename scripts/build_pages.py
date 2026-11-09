"""Generate Code Search's static pages (landing, docs, privacy, terms, 404) from shared parts.
Run: python3 build_pages.py   (writes into ~/code-search/public)"""
import html, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from viz import ORBIT, VS_VIZ, SPAM_VIZ, STARS_VIZ, GATES_VIZ, FLOW_VIZ  # noqa: E402

PUB = os.path.expanduser("~/code-search/public")
SITE = "https://codesearch.amplfyd.com"
E = html.escape

ICON_SEARCH = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>'
ICON_ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'
SPARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 0l2.2 9.8L24 12l-9.8 2.2L12 24l-2.2-9.8L0 12l9.8-2.2z"/></svg>'


def gh(cls="mark"):
    return f'<svg class="{cls}" aria-hidden="true"><use href="/img/marks.svg#github"/></svg>'


def mark(agent):
    return f'<svg class="mark" aria-hidden="true"><use href="/img/marks.svg#{agent}"/></svg>'


def head(title, desc, path, extra_js, robots=None, jsonld=None, preload_img=None):
    canonical = SITE + path
    out = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>{E(title)}</title>
  <meta name="description" content="{E(desc)}">
  <link rel="canonical" href="{canonical}">
  <meta name="theme-color" content="#f9f9f9">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Code Search">
  <meta property="og:title" content="{E(title)}">
  <meta property="og:description" content="{E(desc)}">
  <meta property="og:url" content="{canonical}">
  <meta name="twitter:card" content="summary">
"""
    if robots:
        out += f'  <meta name="robots" content="{robots}">\n'
    out += """  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">
  <link rel="preload" href="/fonts/geist-latin-wght.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/fonts/geist-mono-latin-wght.woff2" as="font" type="font/woff2" crossorigin>
"""
    if preload_img:
        out += f'  <link rel="preload" href="{preload_img}" as="image">\n'
    out += '  <link rel="stylesheet" href="/css/site.css">\n  <script src="/js/boot.js"></script>\n  <script src="/lib/lenis.min.js" defer></script>\n'
    for js in extra_js:
        out += f'  <script type="module" src="{js}"></script>\n'
    if jsonld:
        out += '  <script type="application/ld+json">' + json.dumps(jsonld, ensure_ascii=False).replace("</", "<\\/") + "</script>\n"
    out += "</head>\n"
    return out


NAV_LINKS = [("Product", "/#how"), ("Rate limits", "/#limits"), ("Agents", "/#agents"), ("Pricing", "/#pricing"), ("Docs", "/docs/")]


def nav(current=None, announce=True, home=False):
    links = []
    for label, href in NAV_LINKS:
        h = href[1:] if home and href.startswith("/#") else href
        cur = ' aria-current="page"' if label == current else ""
        links.append(f'<a href="{h}"{cur}>{label}</a>')
    menu_links = "\n    ".join(f'<a href="{(h[1:] if home and h.startswith("/#") else h)}">{l}</a>' for l, h in NAV_LINKS)
    top = ""
    if announce:
        top = f"""  <div class="announce"><a href="/#amplfyd"><span>Made for agents on Amplfyd, launching soon. Code Search is free today: sign in with GitHub.</span><span class="pill-arrow" aria-hidden="true">→</span></a></div>
"""
    return f"""{top}  <header class="nav" id="nav">
    <nav class="nav-inner" aria-label="Main">
      <a class="brand" href="/"><img src="/img/logo.svg" alt="" width="34" height="25" draggable="false">Code Search</a>
      <div class="nav-links">
        {"".join(links)}
      </div>
      <div class="nav-end" id="nav-end">
        <a class="btn btn-ghost hide-m" href="/auth/login" data-auth="signin">Sign in</a>
        <a class="btn btn-accent btn-ticket hide-m" href="/auth/login" data-auth="start">{gh()}<span>Start searching</span></a>
        <button class="btn btn-small menu-btn" type="button" id="menu-open" aria-expanded="false" aria-controls="menu">Menu</button>
      </div>
    </nav>
  </header>
  <div class="menu" id="menu" role="dialog" aria-modal="true" aria-label="Menu" data-lenis-prevent hidden>
    <button class="btn btn-small menu-close" type="button" id="menu-close">Close</button>
    {menu_links}
    <a class="btn btn-accent btn-big btn-ticket" href="/auth/login" data-auth="start">{gh()}<span>Sign in with GitHub</span></a>
  </div>
"""


def footer():
    letters = "".join(f"<span>{c}</span>" if c != " " else '<span class="gap"></span>' for c in "CODE SEARCH")
    return f"""  <footer class="footer">
    <div class="foot-top">
      <div class="foot-brand">
        <a class="brand" href="/"><img src="/img/logo.svg" alt="" width="44" height="32" draggable="false">Code Search</a>
        <h2>The easiest way to search GitHub.</h2>
        <pre class="ascii foot-ascii" data-ascii="ground" aria-hidden="true"></pre>
      </div>
      <div class="foot-cells">
        <a class="foot-cell" href="/docs/#rate-limits"><span class="k">GitHub limit</span><b>30 searches a minute, per user</b></a>
        <a class="foot-cell" href="/docs/#mcp"><span class="k">MCP</span><b>2 tools, any MCP client</b></a>
        <a class="foot-cell" href="/openapi.json"><span class="k">REST</span><b>OpenAPI 3.1</b></a>
        <a class="foot-cell" href="/llms.txt"><span class="k">For language models</span><b>llms.txt</b></a>
        <a class="foot-cell" href="/#amplfyd"><span class="k">Made for Amplfyd</span><b>Agents, launching soon</b></a>
        <a class="foot-cell" href="/app/"><span class="k">Dashboard</span><b>Search now <span class="arrow">→</span></b></a>
      </div>
    </div>
    <div class="foot-cols">
      <nav class="foot-col" aria-labelledby="f1"><h2 id="f1">Product</h2><a href="/#how">How it works</a><a href="/#limits">Rate limits</a><a href="/#pricing">Pricing</a><a href="/#faq">Questions</a></nav>
      <nav class="foot-col" aria-labelledby="f2"><h2 id="f2">Developers</h2><a href="/docs/">Docs</a><a href="/docs/#mcp">MCP server</a><a href="/docs/#rest">REST API</a><a href="/docs/#agents">Agent setup</a></nav>
      <nav class="foot-col" aria-labelledby="f3"><h2 id="f3">Account</h2><a href="/auth/login">Sign up</a><a href="/auth/login">Sign in</a><a href="/app/">Dashboard</a><a href="/app/#keys">API keys</a></nav>
      <nav class="foot-col" aria-labelledby="f4"><h2 id="f4">Legal</h2><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a><a href="https://docs.github.com/en/rest/search/search" rel="noopener">GitHub search docs</a></nav>
    </div>
    <div class="wordmark" aria-hidden="true">{letters}</div>
    <div class="foot-last">
      <p>© 2026 Code Search, part of amplfyd.</p>
      <p>Not affiliated with GitHub, Anthropic, OpenAI, Cursor, xAI or Google. Their marks belong to them.</p>
    </div>
  </footer>
"""


def photo(src, alt, w, h, caption=None, cls="", eager=False):
    lazy = "" if eager else ' loading="lazy" decoding="async"'
    cap = f"<figcaption>{caption}</figcaption>" if caption else ""
    c = f"photo {cls}".strip()
    return f'<figure class="{c}" data-scan><img src="{src}" alt="{E(alt)}" width="{w}" height="{h}"{lazy} draggable="false">{cap}</figure>'


def strip(n, label, end=""):
    end_html = f'<span class="strip-end">{end}</span>' if end else ""
    return f'<div class="strip"><span>[ {n:02d} / 07 ] · <b>{label}</b></span>{end_html}</div>'


def stub(n):
    return f'<div class="ticket-stub" aria-hidden="true"><span class="ticket-no">NO. {n:02d}</span><span class="admit">Admit one</span><span class="barcode"></span></div>'


# ---------------------------------------------------------------- FAQ (one list for HTML and JSON-LD)

FAQ = [
    ("Do I need to install or set up anything?",
     "No. Sign in with GitHub in your browser and search from the dashboard straight away. You only touch a config file if you want an AI agent to use Code Search too, and that is one line."),
    ("Is Code Search really free?",
     "Yes. All three plans cost $0. Every search runs on your own GitHub account's search quota, so there is no shared bill to pass on to you."),
    ("What are GitHub's search API rate limits?",
     "GitHub allows 30 search requests a minute for a signed-in user (10 a minute for the code search endpoint) and 10 a minute for anonymous requests, counted per IP address. Any one search returns at most 1,000 results."),
    ("Do all Code Search users share one GitHub limit?",
     "No. Each person signs in with their own GitHub account and searches on their own token, so your 30 searches a minute belong to you alone."),
    ("What happens when I hit the limit?",
     "Code Search answers with status 429 and a Retry-After header that says exactly how long to wait, and the MCP tools pass that wait on to your agent. Repeated searches come from a ten-minute cache and do not use your quota."),
    ("Can it see my private repositories?",
     "No. Code Search asks GitHub for no permissions beyond public data, so the token it holds can only read public repositories."),
    ("What does Code Search store about me?",
     "Your GitHub login, name and avatar, your GitHub token encrypted with AES-256-GCM, and only SHA-256 hashes of your sessions and API keys."),
    ("Which agents work with it?",
     "Any MCP client that speaks HTTP: Claude Code, Codex, Cursor, Grok, GitHub Copilot, Windsurf, Gemini CLI, Cline and Amp. Anything else can call the REST API."),
    ("How is this different from GitHub's own search?",
     "GitHub wants exact keywords and ranks by its own relevance. Code Search takes a plain sentence, sets aside phrases about you such as 'for my business' or 'for free', removes keyword spam and low-star projects, and puts the projects that are what you asked for first, then the most-starred."),
    ("What is the link with Amplfyd?",
     "Code Search is part of amplfyd and is made for smooth use with agents on Amplfyd, which launches soon. You don't have to wait for it: Code Search works today in the browser and with any MCP client."),
    ("How do I leave?",
     "Delete your account from the dashboard. Code Search removes your keys, sessions and token, and revokes its access to your GitHub account in the same step."),
]

FAQ_LD = {"@context": "https://schema.org", "@graph": [
    {"@type": "WebSite", "name": "Code Search", "url": SITE + "/"},
    {"@type": "SoftwareApplication", "name": "Code Search", "applicationCategory": "DeveloperApplication", "operatingSystem": "Web",
     "url": SITE + "/", "description": "Search GitHub in plain words. Sign in with GitHub, no setup. Best matches first, then by stars, spam removed.",
     "offers": [{"@type": "Offer", "name": n, "price": "0", "priceCurrency": "USD"} for n in ("Search pass", "Agent pass", "Builder pass")]},
    {"@type": "FAQPage", "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in FAQ]},
]}

MARQUEE = [("claude", "Claude Code"), ("codex", "Codex"), ("cursor", "Cursor"), ("grok", "Grok"), ("copilot", "GitHub Copilot"),
           ("windsurf", "Windsurf"), ("gemini", "Gemini CLI"), ("cline", "Cline"), ("amp", "Amp")]


def landing():
    group = "".join(f'<span class="marquee-item">{mark(a)}{n}</span>' for a, n in MARQUEE)
    faq_items = "\n".join(
        f'<details><summary><span class="qn">Q.{i:02d}</span><span>{E(q)}</span><span class="plus" aria-hidden="true"></span></summary><div class="answer"><p>{E(a)}</p></div></details>'
        for i, (q, a) in enumerate(FAQ, 1))
    presets = ["Notion alternative", "Rust file manager", "PDF tables to Excel", "Forecasting, 1,000+ stars", "Markdown kanban"]
    preset_html = "".join(
        f'<button class="preset" type="button" data-preset="{i}" aria-pressed="{"true" if i == 0 else "false"}">{p}</button>' for i, p in enumerate(presets))

    body = f"""<body class="home">
  <a class="skip" href="#main">Skip to content</a>
{nav(home=True)}
  <div class="frame">
  <main id="main">
    <!-- Hero -->
    <section class="hero" id="top" aria-labelledby="hero-h">
      <div class="hero-grid" aria-hidden="true"></div>
      <div class="hero-tags" aria-hidden="true">
        <span class="bracket b1">[ 30 / MIN ]</span>
        <span class="bracket b2 is-hot">[ ★ 100+ ]</span>
        <span class="spark s1">{SPARK}</span>
        <span class="spark s2">{SPARK}</span>
        <span class="bracket b3">[ MCP ]</span>
        <span class="bracket b4">[ $0 ]</span>
      </div>
      <a class="hero-pill rise" href="#pricing">Three plans. <b>All of them $0.</b><span class="pill-arrow" aria-hidden="true">→</span></a>
      <h1 id="hero-h"><span class="line"><span data-i="0">Search GitHub</span></span><span class="line"><span class="accent" data-i="1">in plain words</span></span></h1>
      <p class="hero-sub rise" data-i="2">Sign in with GitHub and start searching. Nothing to install, no keys to set up, nothing to pay. Code Search turns your sentence into the right GitHub query, skips spam and low-star projects, and puts the best matches first, then the most-starred.</p>
      <div class="hero-cta rise" data-i="3">
        <a class="btn btn-accent btn-big btn-ticket" href="/auth/login" data-auth="start">{gh()}<span>Sign in with GitHub</span></a>
        <a class="btn btn-big" href="#agents">Connect an agent</a>
      </div>

      <form class="finder rise" id="finder" data-i="4" role="search" autocomplete="off">
        <div class="finder-top">
          {ICON_SEARCH}
          <label class="sr-only" for="demo-q">Describe the project you need</label>
          <input id="demo-q" type="text" maxlength="500" spellcheck="false" value="I need an open source alternative to notion that I can self host">
        </div>
        <div class="finder-bar">
          <div class="presets" role="group" aria-label="Example searches">{preset_html}</div>
          <button class="go" type="submit"><span id="go-label">Search</span>{ICON_ARROW}</button>
        </div>
        <dl class="parse" aria-live="polite">
          <dt>Key terms</dt><dd id="parse-key"></dd>
          <dt>Descriptive</dt><dd id="parse-soft"></dd>
          <dt>Dropped</dt><dd id="parse-drop"></dd>
          <dt>Asks GitHub</dt><dd><pre class="parse-query" id="parse-query"></pre></dd>
        </dl>
        <p class="parse-top" id="parse-top"></p>
      </form>

      <div class="window hero-window rise" id="results">
        <div class="window-bar"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><p class="window-title"><b>code search</b> / results</p><span class="window-end">recorded run</span></div>
        <p class="board-caption" id="board-caption"></p>
        <div class="departures" id="departures" role="list"></div>
      </div>
      <pre class="ascii hero-ascii" data-ascii="ground" aria-hidden="true"></pre>
    </section>

    <!-- Works with -->
    <section class="sec logos" aria-label="Works with these agents">
      <p class="logos-lead"><span>Works with <b>any MCP client</b>, or plain REST</span></p>
      <div class="marquee"><div class="marquee-track"><div class="marquee-group">{group}</div><div class="marquee-group" aria-hidden="true">{group}</div></div></div>
    </section>

    <!-- Showcase (goated framed panel) -->
    <section class="sec showcase-sec" aria-labelledby="show-h">
      <div class="showcase rise">
        <div class="showcase-stage">
          <pre class="ascii is-white stage-ascii" data-ascii="cloud" aria-hidden="true"></pre>
          <div class="showcase-copy">
            <p class="ticket-kicker">GitHub × every agent</p>
            <h2 id="show-h">Find the project,<br>not the keyword.</h2>
            <p>One GitHub search for you in the browser and for nine agents over MCP. Ranked by the stars real developers gave it.</p>
          </div>
          {ORBIT}
        </div>
        <div class="showcase-bar" aria-hidden="true">
          <div class="showcase-tabs" id="show-tabs"><span class="is-on">Describe</span><span>Search</span><span>Rank</span><span>Read</span></div>
          <span class="showcase-time">≈ 1 GitHub call</span>
        </div>
      </div>
    </section>

    <!-- 01 The old way -->
    <section class="sec" id="why" aria-labelledby="why-h">
      {strip(1, "The old way", "why it exists")}
      <div class="pad story">
        <div>
          <p class="story-label"><span class="num-badge">01</span>GitHub search, as it is</p>
          <h2 id="why-h" class="sr-only">Why Code Search exists</h2>
          <p class="reading" data-read>GitHub's repository search wants keywords and qualifiers, not sentences. Type what you actually need and you get nothing back, or a pile of forks, tutorials and abandoned demos.</p>
          <p class="reading" data-read>Some repositories stuff their description with thousands of keywords so they show up in every search. While testing we found one that was 64,765 characters long.</p>
          <p class="reading" data-read>Code Search reads your sentence the way you meant it and hands back <span class="underline-hand" data-draw>the projects people star<svg viewBox="0 0 200 12" preserveAspectRatio="none" aria-hidden="true"><path d="M2 8 C 40 3, 90 3, 130 6 S 185 10, 198 4" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg></span>.</p>
        </div>
        <div class="story-media rise">
          <span class="corner-note" aria-hidden="true">the needle, not the haystack</span>
          {VS_VIZ}
        </div>
      </div>
    </section>

    <!-- 02 No setup -->
    <section class="sec" id="start" aria-labelledby="start-h">
      {strip(2, "No setup", "about a minute")}
      <div class="pad">
        <div class="head">
          <span class="tag">No setup</span>
          <h2 id="start-h" class="rise">Sign in. Type. <span class="accent">Done.</span></h2>
          <p class="rise" data-i="1">No install, no config file, no token to copy. Your GitHub account is the only thing you need.</p>
        </div>
        <ol class="tickets" id="tickets">
          <li class="ticket">
            <div class="ticket-main">
              <div>
                <p class="ticket-kicker">Step 1 · ten seconds</p>
                <h3>Sign in with GitHub</h3>
                <p>One click on GitHub's own sign-in page. Code Search asks for no permissions, so the token it gets can only read public data.</p>
              </div>
              <div class="ticket-visual" aria-hidden="true">
                <div class="mini-gh tilt">{gh()}Authorize Code Search</div>
                <div class="mini">
                  <div class="mini-row"><span>Permissions requested</span><span class="mono">none</span></div>
                  <div class="mini-row"><span>Private repositories</span><span class="mono">no access</span></div>
                  <div class="mini-row"><span>Your search quota</span><span class="mono">30 / min</span></div>
                </div>
                <span class="ok-chip">✓ Public data only</span>
              </div>
            </div>
            {stub(1)}
          </li>
          <li class="ticket ticket-orange">
            <div class="ticket-main">
              <div>
                <p class="ticket-kicker">Step 2 · plain words</p>
                <h3>Describe the project</h3>
                <p>Write it the way you would say it. “A terminal file manager written in Rust” works. GitHub qualifiers such as license:mit work too.</p>
              </div>
              <div class="ticket-visual" aria-hidden="true">
                <div class="mini"><span class="typing" id="typing">terminal file manager written in rust</span></div>
                <div class="mini tilt-r">
                  <div class="mini-row"><span>Key terms</span><span class="mono">terminal · file · manager</span></div>
                  <div class="mini-row"><span>Descriptive</span><span class="mono">rust</span></div>
                  <div class="mini-row"><span>Dropped</span><span class="mono">written · in</span></div>
                </div>
              </div>
            </div>
            {stub(2)}
          </li>
          <li class="ticket ticket-pale">
            <div class="ticket-main">
              <div>
                <p class="ticket-kicker">Step 3 · ranked</p>
                <h3>Get the best matches first</h3>
                <p>Low-star projects and keyword spam are already gone. Open any result for its description, topics, licence and links.</p>
              </div>
              <div class="ticket-visual" aria-hidden="true">
                <div class="mini">
                  <div class="mini-row"><span>sxyazi/yazi</span><span class="star">★ 43,212</span></div>
                  <div class="mini-row"><span>kamiyaa/joshuto</span><span class="star">★ 3,745</span></div>
                  <div class="mini-row"><span>timhartmann7/omnyssh</span><span class="star">★ 1,264</span></div>
                </div>
                <span class="ok-chip">✓ 1 GitHub call</span>
              </div>
            </div>
            {stub(3)}
          </li>
          <li class="ticket ticket-white">
            <div class="ticket-main">
              <div>
                <p class="ticket-kicker">Step 4 · optional</p>
                <h3>Hand it to your agent</h3>
                <p>Create an API key and paste one line into Claude Code, Codex, Cursor or any MCP client. Same search, inside your agent.</p>
              </div>
              <div class="ticket-visual" aria-hidden="true">
                <div class="mini"><span class="mono">claude mcp add --transport http code-search …/mcp</span></div>
                <div class="mini">
                  <div class="mini-row"><span>search_repositories</span><span class="mono">tool</span></div>
                  <div class="mini-row"><span>get_repository_readme</span><span class="mono">tool</span></div>
                </div>
              </div>
            </div>
            {stub(4)}
          </li>
        </ol>
      </div>
    </section>

    <!-- 03 How it reads -->
    <section class="sec" id="how" aria-labelledby="how-h">
      {strip(3, "How it works", "six steps")}
      <div class="pad">
        <div class="head">
          <span class="tag">Zero configuration</span>
          <h2 id="how-h" class="rise">From a sentence to the <span class="accent">right repository</span></h2>
          <p class="rise" data-i="1">People and agents write the way they talk. GitHub wants exact words. Code Search sits in between and does the translating.</p>
        </div>
        <div class="bento rise">
          <article class="cell c-3">
            <p class="cell-eyebrow"><span class="sq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>Step 1</p>
            <h3><b>Drop the filler.</b> “I need an open source alternative to Notion that I can self host” loses the words that describe you, not the project.</h3>
            <div class="figure"><p><span class="chip chip-drop">I need an open source</span> alternative <span class="chip chip-drop">to</span> notion <span class="chip chip-drop">that I can</span> self host</p></div>
          </article>
          <article class="cell c-3 no-r">
            <p class="cell-eyebrow"><span class="sq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>Step 2</p>
            <h3><b>Split the words.</b> Phrases about you (for my business, for free) are set aside. Key terms must match. Descriptive words such as alternative, self-hosted and language names lift the results that have them.</h3>
            <div class="figure"><p>Key terms <span class="chip chip-key">notion</span></p><p>Descriptive <span class="chip chip-soft">alternative</span> <span class="chip chip-soft">self-hosted</span></p></div>
          </article>
          <article class="cell c-2">
            <p class="cell-eyebrow"><span class="sq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>Step 3</p>
            <h3><b>Ask for every word.</b> At least 100 stars, archived repos out, sorted by stars.</h3>
            <div class="figure"><pre>alternative notion self-hosted
stars:&gt;=100 archived:false
sort=stars order=desc</pre></div>
          </article>
          <article class="cell c-2">
            <p class="cell-eyebrow"><span class="sq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>Step 4</p>
            <h3><b>Loosen with care.</b> Fewer than ten matches? It widens one rule at a time and tells you which.</h3>
            <ul class="ladder figure">
              <li><span>Every word</span><code>all_keywords</code></li>
              <li><span>Key terms +</span><code>key_terms_plus</code></li>
              <li><span>Key terms</span><code>key_terms</code></li>
              <li><span>Most terms</span><code>most_key_terms</code></li>
            </ul>
          </article>
          <article class="cell c-2 no-r">
            <p class="cell-eyebrow"><span class="sq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>Cost</p>
            <p class="big-num"><span data-count="1">1</span></p>
            <h3><b>GitHub call for most searches.</b> Never more than four, even when the search has to widen.</h3>
          </article>
          <article class="cell c-3 no-b">
            <p class="cell-eyebrow"><span class="sq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>Step 5</p>
            <h3><b>Throw out spam.</b> Descriptions over 1,000 characters are keyword stuffing, so they go.</h3>
            {SPAM_VIZ}
          </article>
          <article class="cell c-3 no-r no-b">
            <p class="cell-eyebrow"><span class="sq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>Step 6</p>
            <h3><b>Best match first, then stars.</b> Returned with licence, language, topics and last push, compact enough for an agent's context.</h3>
            {STARS_VIZ}
          </article>
        </div>
      </div>
    </section>

    <!-- 04 Rate limits -->
    <section class="sec" id="limits" aria-labelledby="limits-h">
      {strip(4, "Rate limits", "source: docs.github.com")}
      <div class="pad">
        <div class="head">
          <span class="tag">GitHub API limits</span>
          <h2 id="limits-h" class="rise">GitHub's search limits, <span class="accent">handled for you</span></h2>
          <p class="rise" data-i="1">GitHub caps how often anyone can call its search API. Here are the real numbers, and what Code Search does so you rarely notice them.</p>
        </div>
        <div class="limits">
          <div class="table-card rise">
            <table>
              <caption class="sr-only">GitHub REST API limits that affect search</caption>
              <thead><tr><th scope="col">Limit</th><th scope="col">GitHub's number</th></tr></thead>
              <tbody>
                <tr><th scope="row">Search API, signed in<small>repositories, issues, users, topics, commits</small></th><td class="v"><b>30</b> requests / min</td></tr>
                <tr><th scope="row">Search API, anonymous<small>counted per IP address</small></th><td class="v">10 requests / min</td></tr>
                <tr><th scope="row">Code search endpoint<small>search/code, sign-in required</small></th><td class="v">10 requests / min</td></tr>
                <tr><th scope="row">Results per search<small>later pages are not served</small></th><td class="v">1,000 max</td></tr>
                <tr><th scope="row">Query length<small>not counting qualifiers</small></th><td class="v">256 chars · 5 AND/OR/NOT</td></tr>
                <tr><th scope="row">Other REST calls<small>for example, reading a README</small></th><td class="v">5,000 / hour signed in<br>60 / hour anonymous</td></tr>
                <tr><th scope="row">Secondary limits<small>abuse protection, can change without notice</small></th><td class="v">100 concurrent<br>900 points / min per endpoint</td></tr>
              </tbody>
            </table>
            <p class="table-foot">From GitHub's REST API documentation, checked 4 November 2026. Over the limit, GitHub answers 403 or 429 with x-ratelimit-remaining at 0.</p>
          </div>
          <div class="meter-card rise" data-i="1" id="meter">
            <div class="meter-head"><h3>Your search quota, minute by minute</h3><span class="meter-sim">Simulation</span></div>
            <p>Each square is one GitHub search call this minute. Repeats come from the shared cache and cost nothing.</p>
            <div class="meter" id="meter-cells" aria-hidden="true"></div>
            <div class="meter-stats" aria-live="polite"><span><b id="m-left">30</b> of 30 left</span><span>resets in <b id="m-reset">60</b>s</span><span>cache hits <b id="m-hits">0</b></span></div>
            <div class="meter-actions">
              <button class="btn btn-accent btn-ticket" type="button" id="m-new">Run a new search</button>
              <button class="btn" type="button" id="m-repeat">Repeat a search</button>
              <button class="btn" type="button" id="m-burst">Run 10 at once</button>
            </div>
            <ul class="meter-log" id="m-log"></ul>
          </div>
        </div>
        <div class="stats">
          <div class="stat rise"><p class="big-num"><span data-count="30">30</span><small>/min</small></p><b>Yours alone</b><p>Everyone searches on their own GitHub token, so one heavy user never slows anyone else down.</p></div>
          <div class="stat rise" data-i="1"><p class="big-num"><span data-count="1">1</span><small>call</small></p><b>For most searches</b><p>Ten or more strong matches take one GitHub call. Harder searches take up to four.</p></div>
          <div class="stat rise" data-i="2"><p class="big-num"><span data-count="10">10</span><small>min</small></p><b>Shared cache</b><p>Identical searches are answered from cache, and identical searches arriving together share one call.</p></div>
          <div class="stat rise" data-i="3"><p class="big-num"><span data-count="429">429</span></p><b>Clear back-off</b><p>At the limit you get Retry-After with the exact wait, and MCP tools tell your agent how long to pause.</p></div>
        </div>
        <div class="band rise">
          {GATES_VIZ}
          <div class="band-copy">
            <h3>Every user gets their own gate.</h3>
            <p>Send everyone through one shared token and the whole service gets 30 searches a minute between all its users. Code Search signs each person in with their own GitHub account instead, so your 30 a minute are yours.</p>
            <p>On top of GitHub's limit, Code Search allows 120 requests a minute per account across REST and MCP, so a runaway script can't burn through your quota in a loop.</p>
            <p><a class="link" href="/docs/#rate-limits">Read the full rate-limit guide</a></p>
          </div>
        </div>
        <p class="source">Sources: <a class="link" href="https://docs.github.com/en/rest/search/search#rate-limit" rel="noopener">GitHub REST API, search rate limit</a> · <a class="link" href="https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api" rel="noopener">Rate limits for the REST API</a></p>
      </div>
    </section>

    <!-- 05 Agents -->
    <section class="sec" id="agents" aria-labelledby="agents-h">
      {strip(5, "Agents", "MCP + REST")}
      <div class="pad">
        <div class="head">
          <span class="tag">Agent ready</span>
          <h2 id="agents-h" class="rise">Easily connect with your <span class="accent">AI agents</span></h2>
          <p class="rise" data-i="1">One MCP endpoint with two tools, search_repositories and get_repository_readme. Pick your agent, copy, paste.</p>
        </div>
        <div class="connect">
          <div class="connect-list rise">
            <p class="endpoint">MCP endpoint for every agent:<br><code id="mcp-url">{SITE}/mcp</code></p>
            <div class="agent-tabs" role="tablist" aria-label="Agents" id="agent-tabs"></div>
          </div>
          <div class="window connect-code rise" data-i="1" role="tabpanel" id="agent-panel">
            <div class="code-head"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><p class="code-file" id="code-file"></p><button class="btn btn-small copy-btn" type="button" id="copy-code">Copy</button></div>
            <pre class="code-block"><code id="code-block"></code></pre>
            <p class="code-note" id="code-note"></p>
          </div>
        </div>
      </div>
    </section>

    <!-- Amplfyd -->
    <section class="sec" id="amplfyd" aria-labelledby="amp-h">
      <div class="pad">
        <article class="amp rise">
          <div class="amp-main">
            <p class="ticket-kicker">Made for Amplfyd · launching soon</p>
            <h2 id="amp-h">Built for agents on <span class="amp-name">Amplfyd</span></h2>
            <p>Code Search is made so agents on Amplfyd can search GitHub smoothly: one API key, two read-only tools, compact results that fit in context, and rate-limit answers that say exactly how long to wait. Amplfyd launches soon. Until then, Code Search works with every MCP client today.</p>
            <div class="hero-cta amp-cta">
              <a class="btn btn-big btn-ticket" href="/app/#keys">Get your API key ready</a>
              <a class="btn btn-big btn-ghost amp-ghost" href="/docs/#agents">Agent setup docs <span class="arrow">→</span></a>
            </div>
          </div>
          <div class="amp-side" aria-hidden="true">
            <span class="amp-stamp">launching soon</span>
            <div class="mini"><div class="mini-row"><span>search_repositories</span><span class="mono">ready</span></div><div class="mini-row"><span>get_repository_readme</span><span class="mono">ready</span></div><div class="mini-row"><span>Amplfyd agents</span><span class="mono">soon</span></div></div>
          </div>
          <div class="ticket-stub" aria-hidden="true"><span class="ticket-no">NO. 05</span><span class="admit">Amplfyd</span><span class="barcode"></span></div>
        </article>
      </div>
    </section>

    <!-- 06 Pricing -->
    <section class="sec" id="pricing" aria-labelledby="pricing-h">
      {strip(6, "Pricing", "no card needed")}
      <div class="pad">
        <div class="head">
          <span class="tag">Pricing</span>
          <h2 id="pricing-h" class="rise">Three plans. <span class="accent">All free.</span></h2>
          <p class="rise" data-i="1">Pick the one that matches how you search. You can use all three at once. They cost the same, which is nothing.</p>
        </div>
        <div class="bill-wrap">
          <div class="bill" role="group" aria-label="Billing period"><span class="bill-thumb" id="bill-thumb" aria-hidden="true"></span><button type="button" aria-pressed="true" data-bill="month">Monthly</button><button type="button" aria-pressed="false" data-bill="year">Yearly</button></div>
          <p class="bill-note" id="bill-note" aria-live="polite">no card, no trial</p>
        </div>
        <div class="plans">
          <article class="plan plan-white rise">
            <div class="plan-top">
              <p class="plan-kicker"><span>No. 01</span><span>Admit one</span></p>
              <h3>Search pass</h3>
              <p class="plan-for">For people who want the right repository without learning GitHub's query syntax.</p>
              <p class="price"><span class="price-num">$0</span><span class="price-per" data-per>/ month</span></p>
            </div>
            <div class="perf" aria-hidden="true"></div>
            <div class="plan-body">
              <ul class="feats">
                <li>Sign in with GitHub, nothing to install</li>
                <li>Live search in the dashboard</li>
                <li>Plain-English queries, GitHub qualifiers welcome</li>
                <li>Filters for language, minimum stars and archived repos</li>
                <li>Best matches first, keyword spam removed</li>
                <li>Your own GitHub quota of 30 searches a minute</li>
              </ul>
              <a class="btn btn-dark btn-big btn-wide btn-ticket" href="/auth/login" data-auth="start">Start searching</a>
            </div>
          </article>
          <article class="plan plan-orange rise" data-i="1">
            <span class="plan-stamp" aria-hidden="true">made for agents</span>
            <div class="plan-top">
              <p class="plan-kicker"><span>No. 02</span><span>Admit one</span></p>
              <h3>Agent pass</h3>
              <p class="plan-for">For Claude Code, Codex, Cursor and every other agent that needs to find real projects.</p>
              <p class="price"><span class="price-num">$0</span><span class="price-per" data-per>/ month</span></p>
            </div>
            <div class="perf" aria-hidden="true"></div>
            <div class="plan-body">
              <ul class="feats">
                <li class="incl">Everything in Search pass</li>
                <li>API keys, one per agent, revoke any time</li>
                <li>Hosted MCP server with two read-only tools</li>
                <li>README reading in one tool call</li>
                <li>Setup snippets for seven agents</li>
                <li>Rate-limit errors that tell the agent how long to wait</li>
              </ul>
              <a class="btn btn-big btn-wide btn-ticket" href="/app/#keys">Create an API key</a>
            </div>
          </article>
          <article class="plan plan-dark rise" data-i="2">
            <div class="plan-top">
              <p class="plan-kicker"><span>No. 03</span><span>Admit one</span></p>
              <h3>Builder pass</h3>
              <p class="plan-for">For scripts, apps and tools that call GitHub search over plain HTTP.</p>
              <p class="price"><span class="price-num">$0</span><span class="price-per" data-per>/ month</span></p>
            </div>
            <div class="perf" aria-hidden="true"></div>
            <div class="plan-body">
              <ul class="feats">
                <li class="incl">Everything in Agent pass</li>
                <li>REST API for search and READMEs</li>
                <li>OpenAPI 3.1 description and llms.txt</li>
                <li>120 requests a minute per account</li>
                <li>Shared ten-minute cache and request coalescing</li>
                <li>X-Request-Id and Server-Timing on every response</li>
              </ul>
              <a class="btn btn-big btn-wide btn-ticket" href="/docs/#rest">Read the API docs</a>
            </div>
          </article>
        </div>
        <p class="plans-foot">No card, no trial, no seat limits. Searches run on your own GitHub quota.</p>
      </div>
    </section>

    <!-- 07 FAQ -->
    <section class="sec" id="faq" aria-labelledby="faq-h">
      {strip(7, "FAQ", f"{len(FAQ)} questions")}
      <div class="pad faq">
        <div class="faq-side">
          <h2 id="faq-h" class="rise">Frequently asked questions</h2>
          <p class="rise" data-i="1">Limits, privacy and setup. Everything else is in the docs.</p>
          <a class="btn rise" data-i="2" href="/docs/">Read the docs <span class="arrow">→</span></a>
        </div>
        <div class="qa rise" id="qa">
{faq_items}
        </div>
      </div>
    </section>

    <!-- Final note -->
    <section class="sec note pad" aria-labelledby="note-h">
      <pre class="ascii note-ascii is-grey" data-ascii="cloud" aria-hidden="true"></pre>
      <div class="note-labels" aria-hidden="true"><span>(Final note)</span><span>(From the Code Search team)</span><span>(codesearch.amplfyd.com)</span></div>
      <h2 id="note-h" class="rise">Thanks for reading <span class="hand">this far.</span></h2>
      <div class="note-body rise" data-i="1">
        <p>Here is the whole thing in one breath: <strong>sign in with GitHub, describe what you need, get the repositories people actually star.</strong> No setup, no bill, and GitHub's rate limits handled for you.</p>
        <p>If you build with an AI agent, give it the same search with one line of config. Code Search is made for agents on <strong>Amplfyd</strong>, which launches soon.</p>
      </div>
      <div class="hero-cta rise" data-i="2">
        <a class="btn btn-accent btn-big btn-ticket" href="/auth/login" data-auth="start">{gh()}<span>Sign in with GitHub</span></a>
        <a class="btn btn-big" href="/docs/">Read the docs</a>
      </div>
      <p class="note-sign rise" data-i="3">happy searching</p>
    </section>
  </main>
{footer()}
  </div>
</body>
</html>
"""
    return head("Code Search: search GitHub in plain words, free",
                "Search GitHub in plain words with no setup. Sign in with GitHub and use it free. Best matches first, then by stars, spam and low-star repos removed, GitHub's rate limits handled. MCP and REST for AI agents.",
                "/", ["/js/landing.js"], jsonld=FAQ_LD) + body


# ---------------------------------------------------------------- Docs

DOC_NAV = [
    ("Get started", [("introduction", "Introduction"), ("quickstart", "Quickstart"), ("dashboard", "Search in the dashboard"), ("queries", "Writing good queries"), ("results", "Reading the results")]),
    ("Agents", [("keys", "API keys"), ("mcp", "MCP server"), ("agents", "Agent setup")]),
    ("API reference", [("rest", "REST API"), ("params", "Search parameters"), ("response", "Response"), ("readme", "README endpoint"), ("errors", "Errors")]),
    ("Limits", [("rate-limits", "GitHub rate limits"), ("limits", "Code Search limits"), ("caching", "Caching")]),
    ("Account", [("usage", "Usage analytics"), ("security", "Security and privacy"), ("delete", "Delete your account"), ("machine", "For machines")]),
]


def docs():
    nav_html = "".join(
        f'<div class="docs-group"><h2>{g}</h2>' + "".join(f'<a href="#{i}" data-spy="{i}">{t}</a>' for i, t in items) + "</div>"
        for g, items in DOC_NAV)
    options = "".join(f'<optgroup label="{g}">' + "".join(f'<option value="{i}">{t}</option>' for i, t in items) + "</optgroup>" for g, items in DOC_NAV)

    def sec(i, title, inner, kicker=None):
        k = f'<p class="doc-kicker">{kicker}</p>' if kicker else ""
        return f'<section class="doc-sec" id="{i}" aria-labelledby="{i}-h">{k}<h2 id="{i}-h"><a href="#{i}">{title}</a></h2>\n{inner}\n</section>\n'

    def code(text, dark=True, cid=None):
        idattr = f' id="{cid}"' if cid else ""
        return f'<div class="code-wrap"><pre class="dark-code"><code{idattr}>{E(text)}</code></pre><button class="copy-inline" type="button" data-copy>Copy</button></div>'

    def table(head_cells, rows):
        th = "".join(f'<th scope="col">{h}</th>' for h in head_cells) if head_cells else ""
        thead = f"<thead><tr>{th}</tr></thead>" if head_cells else ""
        tb = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
        return f'<div class="doc-table-wrap"><table class="doc-table">{thead}<tbody>{tb}</tbody></table></div>'

    main = ""
    main += f"""<div class="doc-hero" id="introduction">
        <p class="doc-kicker">Documentation</p>
        <h1 class="doc-title">Code Search docs</h1>
        <p class="doc-lead">Code Search turns a plain-English description into the best-starred GitHub repositories that match. Use it in the browser with nothing to set up, or give it to an AI agent over MCP or REST. Every plan is free.</p>
        {FLOW_VIZ}
        <p class="callout is-tip">Code Search is made for smooth use with agents on Amplfyd, which launches soon. It already works with any MCP client and over REST.</p>
      </div>
"""
    main += sec("quickstart", "Quickstart", """<p>You can run your first search in about a minute. There is nothing to install.</p>
<ol class="doc-steps">
  <li><div><strong>Sign in with GitHub.</strong> Click <a class="link" href="/auth/login">Sign in with GitHub</a> and approve Code Search on GitHub's page. It asks for no permissions beyond public data.</div></li>
  <li><div><strong>Describe the project.</strong> You land on the dashboard's search page. Type what you need, for example <code>self-hosted kanban board with markdown support</code>, and press Search.</div></li>
  <li><div><strong>Open a result.</strong> Projects whose name, topics or opening description fit your words come first, then the most-starred. Click a row for the description, topics, licence and links to GitHub and the project's website.</div></li>
  <li><div><strong>Optional: connect an agent.</strong> Create an API key under <a class="link" href="/app/#keys">API keys</a> and paste the snippet for your agent from <a class="link" href="#agents">Agent setup</a>.</div></li>
</ol>
<p class="callout is-tip">Typed a search on the home page before signing in? Code Search keeps it and runs it as soon as you land on the dashboard.</p>""", "Get started")
    main += sec("dashboard", "Search in the dashboard", f"""<p>The dashboard at <a class="link" href="/app/">/app/</a> is the no-setup way to use Code Search. It calls the same search as the API, with your own GitHub quota.</p>
{table(["Control", "What it does"], [
    ["Search box", "Up to 500 characters of plain English. GitHub qualifiers are allowed."],
    ["Language", "Keeps repositories whose main language matches, for example Python or Rust."],
    ["Minimum stars", "Skips repositories with fewer stars. Default 100, lowest 10."],
    ["Include archived", "Off by default, because archived projects no longer take changes."],
    ["Previous / Next", "Pages through results, 20 at a time. GitHub serves only the first 1,000 results of a search."],
])}
<p>Below the box, Code Search says how many projects matched, which rule matched them, which words it treated as key terms, and how many GitHub searches you have left this minute.</p>""")
    main += sec("queries", "Writing good queries", f"""<p>Describe the project, not yourself. Words like <em>I need</em>, <em>open source</em> or <em>that I can</em> are dropped anyway.</p>
<ul class="doc-list">
  <li><span><strong>Name the job.</strong> “convert pdf tables to excel” beats “pdf tool”.</span></li>
  <li><span><strong>Add a language or style as a descriptive word.</strong> “terminal file manager in rust” keeps Rust as a tie-breaker instead of a hard filter. Use the Language filter for a hard filter.</span></li>
  <li><span><strong>Use qualifiers when you know them.</strong> <code>license:mit</code>, <code>topic:cli</code>, <code>user:NAME</code> and <code>pushed:&gt;2025-01-01</code> pass straight to GitHub.</span></li>
  <li><span><strong>Raise the star floor for crowded topics.</strong> “machine learning time series forecasting” with 1,000+ stars returns established libraries only.</span></li>
</ul>
<p><code>stars:</code>, <code>sort:</code> and <code>in:</code> qualifiers are ignored, because Code Search sets them itself.</p>""")
    main += sec("results", "Reading the results", f"""<p>Each result shows the repository, stars, main language, licence and an activity label based on the last push.</p>
{table(["Label", "Meaning"], [["Active", "Pushed in the last 30 days."], ["Recent", "Pushed in the last year."], ["Quiet", "No push for more than a year."], ["Archived", "Read-only on GitHub. Only shown when you include archived repositories."]])}
<p>The match rule tells you how strict the search had to be. See <a class="link" href="#response">Response</a> for the four rules.</p>""")
    main += sec("keys", "API keys", """<p>Agents and scripts authenticate with an API key. Create keys in the dashboard under <a class="link" href="/app/#keys">API keys</a>.</p>
<ul class="doc-list">
  <li><span>Give each agent or script its own key, so you can revoke one without touching the rest.</span></li>
  <li><span>A key is shown once, when you create it. Code Search stores only its SHA-256 hash and cannot show it again.</span></li>
  <li><span>Every key searches on your GitHub quota of 30 searches a minute.</span></li>
  <li><span>Revoked keys stop working within a minute.</span></li>
</ul>
<p>Send the key on every request as <code>Authorization: Bearer &lt;key&gt;</code>.</p>""", "Agents")
    main += sec("mcp", "MCP server", f"""<p>One Streamable HTTP endpoint for every MCP client:</p>
{code(SITE + "/mcp", cid="doc-mcp-url")}
<p>It speaks MCP <code>2026-07-28</code> (stateless, <code>server/discover</code>) and the earlier <code>2025-11-25</code>, <code>2025-06-18</code>, <code>2025-03-26</code> and <code>2024-11-05</code> revisions with the <code>initialize</code> handshake, so current and older clients both work. The endpoint accepts API keys only, not browser cookies.</p>
{table(["Tool", "What it does", "Arguments"], [
    ["<code>search_repositories</code>", "Finds public repositories matching a plain-English description, skips low-star projects and returns the best matches first, then by stars.", "<code>query</code> (required), <code>language</code>, <code>min_stars</code>, <code>include_archived</code>, <code>page</code>, <code>per_page</code> (default 10, max 50)"],
    ["<code>get_repository_readme</code>", "Returns a repository's README as Markdown so the agent can check a result before recommending it.", "<code>repo</code> as owner/name or a GitHub URL (required), <code>max_chars</code> (200 to 20,000, default 6,000)"],
])}
<p>Both tools are read-only. Results come back as compact text for the model plus <code>structuredContent</code> with the full JSON. Errors such as a rate limit come back with <code>isError: true</code> and say how long to wait. Suggested use: search first, then read the README of the best two or three results before recommending one.</p>""")
    main += sec("agents", "Agent setup", """<p>Pick your agent. Replace the placeholder with a key from the <a class="link" href="/app/#keys">dashboard</a>; the dashboard's Connect page fills it in for you.</p>
<div class="connect doc-connect">
  <div class="connect-list"><div class="agent-tabs" role="tablist" aria-label="Agents" id="agent-tabs"></div></div>
  <div class="window connect-code" role="tabpanel" id="agent-panel">
    <div class="code-head"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><p class="code-file" id="code-file"></p><button class="btn btn-small copy-btn" type="button" id="copy-code">Copy</button></div>
    <pre class="code-block"><code id="code-block"></code></pre>
    <p class="code-note" id="code-note"></p>
  </div>
</div>
<h3>Example prompts</h3>
<p>Once connected, ask in plain words and mention the tool so the agent uses it:</p>
<ul class="doc-list">
  <li><span>“Use code-search to find a well-maintained Rust crate for parsing TOML, read the READMEs of the top three and recommend one.”</span></li>
  <li><span>“Before you write a date picker, check with code-search whether a popular React component already does it.”</span></li>
  <li><span>“Find self-hosted alternatives to Notion with at least 1,000 stars and compare their licences.”</span></li>
  <li><span>“Search GitHub for an MIT-licensed Python package that turns PDF tables into Excel and show how to install it.”</span></li>
</ul>""")
    main += sec("rest", "REST API", f"""<p>Every endpoint takes <code>Authorization: Bearer &lt;key&gt;</code>, answers JSON and allows cross-origin calls. Each response carries an <code>X-Request-Id</code>; include it when reporting a problem.</p>
{code('curl -s -H "Authorization: Bearer $CODE_SEARCH_KEY" \\\n  "' + SITE + '/v1/search?q=terminal+file+manager+in+rust&min_stars=500"', cid="doc-curl")}
{table(["Method and path", "Returns"], [["<code>GET /v1/search</code>", "Repositories matching <code>q</code>, best matches first, then by stars."], ["<code>GET /v1/repos/{owner}/{repo}/readme</code>", "The README as text, cut to <code>max_chars</code>."]])}""", "API reference")
    main += sec("params", "Search parameters", table(["Parameter", "Meaning"], [
        ["<code>q</code>", "What the project should do, up to 500 characters. GitHub qualifiers work too: <code>license:mit</code>, <code>topic:cli</code>, <code>user:NAME</code>, <code>pushed:&gt;2025-01-01</code>. <code>stars:</code>, <code>sort:</code> and <code>in:</code> are ignored because Code Search sets them."],
        ["<code>language</code>", "Primary language, for example <code>Python</code>. Overrides a <code>language:</code> typed in <code>q</code>."],
        ["<code>min_stars</code>", "Skip repositories with fewer stars. Default 100, lowest 10."],
        ["<code>include_archived</code>", "<code>true</code> to include archived repositories. Default false."],
        ["<code>page</code>, <code>per_page</code>", "<code>per_page</code> from 1 to 50, default 20. Each search ranks up to 100 repositories."],
    ]))
    main += sec("response", "Response", f"""<p>Code Search asks GitHub for every word, then for the key terms alone and, for some subjects, a related phrase (self-hosted email also looks for mail servers). Each project must contain every key term or a close synonym; only when fewer than ten do, it accepts most key terms. Results are ordered by how well the name, topics and opening of the description match, then by stars. Phrases about you rather than the project are listed in <code>query.context</code>. <code>matchLevel</code> describes the loosest result.</p>
{table(["matchLevel", "Meaning"], [["<code>all_keywords</code>", "Every word matched."], ["<code>key_terms_plus</code>", "Every key term matched, and each result also has at least one descriptive word (alternative, library, self-hosted, language names)."], ["<code>key_terms</code>", "Every key term matched."], ["<code>most_key_terms</code>", "Most key terms matched (only with three or more key terms)."]])}
{code('''{
  "query": { "input": "terminal file manager in rust", "keyTerms": ["terminal", "file", "manager"],
             "descriptiveWords": ["rust"], "context": [], "minStars": 500, "ignored": [], "notes": [] },
  "mode": "broad", "matchLevel": "key_terms_plus",
  "total": 3, "page": 1, "perPage": 20, "hasMore": false, "cached": false,
  "rateLimit": { "limit": 30, "remaining": 27, "reset": 1793766986 },
  "items": [
    { "name": "sxyazi/yazi", "url": "https://github.com/sxyazi/yazi", "stars": 43212,
      "language": "Rust", "license": "MIT", "topics": ["cli", "file-explorer"],
      "description": "Blazing fast terminal file manager written in Rust, based on async I/O.",
      "homepage": "https://yazi-rs.github.io", "archived": false, "forks": 1100,
      "openIssues": 50, "pushedAt": "2026-11-03T10:00:00Z" }
  ],
  "requestId": "8f2c…"
}''')}
<p><code>rateLimit</code> mirrors GitHub's <code>x-ratelimit-*</code> headers for your token. It is <code>null</code> when the answer came from cache, because no GitHub call was made.</p>""")
    main += sec("readme", "README endpoint", code('''GET /v1/repos/sxyazi/yazi/readme?max_chars=6000

{ "repo": "sxyazi/yazi", "url": "https://github.com/sxyazi/yazi#readme",
  "text": "## Yazi …", "truncated": true, "totalChars": 14820, "requestId": "…" }''') +
                "\n<p>READMEs are cached for an hour. A missing README answers 404 with <code>not_found</code>. README reads use GitHub's general REST quota (5,000 an hour), not the search quota.</p>")
    main += sec("errors", "Errors", f"""<p>Errors are JSON: <code>{{ "error": "…", "code": "…", "requestId": "…" }}</code>, with <code>Retry-After</code> when waiting helps.</p>
{table(["Status", "code", "What to do"], [
    ["400", "<code>invalid_params</code>, <code>invalid_query</code>", "Fix the parameter named in <code>error</code>."],
    ["401", "<code>invalid_api_key</code>, <code>signin_required</code>", "Send a valid key. Revoked keys stop working within a minute."],
    ["401", "<code>github_reauth</code>", "The owner revoked GitHub access; they must sign in to Code Search again."],
    ["404", "<code>not_found</code>", "No such repository or README."],
    ["429", "<code>rate_limited</code>", "Your GitHub search limit was reached. Wait for <code>Retry-After</code> seconds."],
    ["429", "<code>too_many_requests</code>", "More than 120 requests a minute on one account. Slow down."],
    ["502", "<code>github_error</code>, <code>github_unreachable</code>", "GitHub failed; retry with backoff."],
])}""")
    main += sec("rate-limits", "GitHub rate limits", f"""<p>Code Search runs on GitHub's REST API, so GitHub's limits apply. These are GitHub's published numbers, checked on 4 November 2026.</p>
{table(["What", "GitHub's limit"], [
    ["Search endpoints, authenticated", "30 requests a minute (all search endpoints except code search)"],
    ["Code search endpoint (<code>search/code</code>)", "10 requests a minute, authentication required"],
    ["Search endpoints, unauthenticated", "10 requests a minute, counted per IP address"],
    ["Results per search", "Up to 1,000 results; later pages are not served"],
    ["Query length", "256 characters, not counting qualifiers; at most five AND, OR or NOT operators"],
    ["Search scope", "GitHub looks through up to 4,000 matching repositories per query and may return <code>incomplete_results: true</code> when a query times out"],
    ["Primary REST limit, authenticated", "5,000 requests an hour per user (15,000 for some GitHub Enterprise Cloud apps)"],
    ["Primary REST limit, unauthenticated", "60 requests an hour per IP address"],
    ["Secondary limits", "No more than 100 concurrent requests; 900 points a minute per REST endpoint (GET counts 1, writes 5); about 90 seconds of CPU time per minute. GitHub may change these without notice."],
])}
<h3>How GitHub reports it</h3>
<p>Every GitHub response carries <code>x-ratelimit-limit</code>, <code>x-ratelimit-remaining</code>, <code>x-ratelimit-used</code>, <code>x-ratelimit-reset</code> (UTC epoch seconds) and <code>x-ratelimit-resource</code> (for searches, <code>search</code>). Over a limit, GitHub answers <code>403</code> or <code>429</code>. GitHub asks clients to wait until <code>x-ratelimit-reset</code>, or for <code>retry-after</code> seconds when that header is present, and warns that integrations which keep calling while limited can be banned.</p>
<h3>What Code Search does about it</h3>
<ul class="doc-list">
  <li><span><strong>Your own quota.</strong> Each user signs in with their own GitHub account, so searches use that user's 30 a minute. Users never share a limit.</span></li>
  <li><span><strong>Few calls per search.</strong> A search costs one GitHub call when ten or more projects match every word, and at most four when it has to widen.</span></li>
  <li><span><strong>Cache and coalescing.</strong> Identical searches within ten minutes are answered from cache without touching your quota, and identical searches arriving at the same moment share one GitHub call.</span></li>
  <li><span><strong>Honest back-off.</strong> When GitHub says stop, Code Search answers <code>429 rate_limited</code> with <code>Retry-After</code> set from GitHub's reset time. It never retries in a loop on your behalf.</span></li>
  <li><span><strong>Graceful widening.</strong> If the strict pass found results but a widening call hits the limit, you get the strict results instead of an error.</span></li>
</ul>
<p class="callout">In practice that means roughly 7 to 30 fresh searches a minute per user, depending on how many need widening, plus unlimited repeats from cache.</p>
<p>Sources: <a class="link" href="https://docs.github.com/en/rest/search/search#rate-limit" rel="noopener">REST API endpoints for search</a>, <a class="link" href="https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api" rel="noopener">Rate limits for the REST API</a>.</p>""", "Limits")
    main += sec("limits", "Code Search limits", """<ul class="doc-list">
  <li><span>120 requests a minute per account, across REST and MCP together. Over that you get <code>429 too_many_requests</code>.</span></li>
  <li><span>Queries up to 500 characters; <code>per_page</code> up to 50.</span></li>
  <li><span>README text from 200 to 20,000 characters per call.</span></li>
  <li><span>Keyword-stuffed spam (descriptions over 1,000 characters) is removed from every result.</span></li>
</ul>""")
    main += sec("caching", "Caching", """<p>Searches are cached for ten minutes and READMEs for an hour, shared across users, first in the Worker's memory and then in Cloudflare's edge cache. Cached answers say <code>"cached": true</code> and cost no GitHub quota. Responses carry <code>Server-Timing</code> so you can see where time went.</p>""")
    main += sec("usage", "Usage analytics", f"""<p>The dashboard's <a class="link" href="/app/#usage">Usage</a> tab shows when and how many times your keys called Code Search, so you can see which agent is busy, spot failures and check how close you run to GitHub's limit.</p>
{table(["View", "What it shows"], [
    ["Totals", "API calls, success rate, rate-limited calls (429), share answered from cache, the busiest hour or day and the last call."],
    ["Calls over time", "One bar per hour for the last 24 hours, or per day for 7, 30 or 90 days, split into OK, errors and rate-limited."],
    ["By key", "Each key's share of calls, its failures and its last call. Searches made in the dashboard appear as Dashboard (browser)."],
    ["By endpoint", "MCP search_repositories and get_repository_readme, and the REST search and README routes."],
    ["When your agents call", "A weekday-by-hour heatmap in your local time."],
])}
<p>Filter by key from the menu, or open a key's usage from its 7-day spark on the API keys tab. Counts are stored per key and hour and kept for 90 days.</p>""", "Account")
    main += sec("security", "Security and privacy", """<ul class="doc-list">
  <li><span>The GitHub app requests no scopes, so tokens can read public data only.</span></li>
  <li><span>GitHub tokens are stored encrypted with AES-256-GCM. Sessions and API keys are stored only as SHA-256 hashes.</span></li>
  <li><span>Sign-in is protected by an OAuth <code>state</code> check; cookies are <code>HttpOnly</code>, <code>SameSite=Lax</code> and <code>__Host-</code> prefixed.</span></li>
  <li><span>The MCP endpoint accepts API keys only and rejects foreign <code>Origin</code> headers.</span></li>
  <li><span>Pages run under a strict Content-Security-Policy and never render API data as HTML.</span></li>
</ul>
<p>More in the <a class="link" href="/privacy/">privacy notice</a>.</p>""")
    main += sec("delete", "Delete your account", """<p>Open <a class="link" href="/app/#account">Account</a> in the dashboard and choose Delete account. Code Search removes your keys, sessions and stored token and revokes its access to your GitHub account in the same step. Agents using your keys stop working at once.</p>
<p>To pause access without deleting anything, revoke Code Search in your GitHub settings under Applications.</p>""")
    main += sec("machine", "For machines", """<p><a class="link" href="/openapi.json">/openapi.json</a> describes the REST API in OpenAPI 3.1, and <a class="link" href="/llms.txt">/llms.txt</a> explains Code Search to a language model in plain text.</p>""")
    main += '<nav class="doc-pager" aria-label="Next steps"><a class="btn" href="/">← Back to home</a><a class="btn btn-accent btn-ticket" href="/auth/login" data-auth="start">' + gh() + '<span>Sign in with GitHub</span></a></nav>'

    body = f"""<body class="docs">
  <a class="skip" href="#main">Skip to content</a>
{nav(current="Docs", announce=False)}
  <div class="docs-mobile-nav"><label class="sr-only" for="docs-jump">Jump to section</label><select id="docs-jump">{options}</select></div>
  <div class="docs-layout">
    <nav class="docs-nav" aria-label="Docs" data-lenis-prevent>{nav_html}</nav>
    <main id="main" class="docs-main">
{main}
    </main>
    <aside class="docs-aside" aria-label="Rate limits at a glance">
      <div class="aside-card">
        <h2>Limits at a glance</h2>
        <dl>
          <dt>GitHub search</dt><dd>30 / min</dd>
          <dt>Code search API</dt><dd>10 / min</dd>
          <dt>Anonymous</dt><dd>10 / min</dd>
          <dt>Results cap</dt><dd>1,000</dd>
          <dt>Code Search</dt><dd>120 / min</dd>
          <dt>Cache</dt><dd>10 min</dd>
        </dl>
        <a class="link" href="#rate-limits">Full details</a>
      </div>
      <div class="aside-card">
        <h2>No setup needed</h2>
        <p>Sign in with GitHub and search in the browser. Keys are only for agents.</p>
        <a class="btn btn-accent btn-wide btn-ticket" href="/auth/login" data-auth="start">Start searching</a>
      </div>
    </aside>
  </div>
  <div class="frame">
{footer()}
  </div>
</body>
</html>
"""
    return head("Docs: Code Search", "How to use Code Search: search GitHub with no setup, connect Claude Code, Codex, Cursor and other agents over MCP or REST, API reference, errors and GitHub's search rate limits.",
                "/docs/", ["/js/docs.js"]) + body


def simple_page(path, title, desc, inner, js="/js/page.js", robots=None, cls="page"):
    body = f"""<body>
  <a class="skip" href="#main">Skip to content</a>
{nav(announce=False)}
  <main id="main" class="{cls}">
{inner}
  </main>
  <div class="frame">
{footer()}
  </div>
</body>
</html>
"""
    return head(title, desc, path, [js], robots=robots) + body


PRIVACY = """<article class="prose">
  <p class="doc-kicker">Legal</p>
  <h1>Privacy</h1>
  <p>Last updated 9 November 2026. This notice explains what Code Search (codesearch.amplfyd.com, part of amplfyd) stores when you use it, and why.</p>
  <h2>What we store</h2>
  <ul>
    <li>Your GitHub user id, login, display name and avatar URL, so the dashboard can show who is signed in.</li>
    <li>The GitHub access token GitHub gives us when you sign in, encrypted with AES-256-GCM. It has no scopes, so it can only read public data. We use it only to run your searches and README reads on your own GitHub quota.</li>
    <li>SHA-256 hashes of your session cookie and your API keys, plus each key's name, first characters, creation date and when it was last used.</li>
    <li>Hourly counts of your API calls per key and endpoint (how many, and whether they succeeded, were rate-limited or came from cache), kept for 90 days for the Usage tab.</li>
    <li>A log of each call made with your account: when it happened, which key or the dashboard made it, what you searched for or which README you asked for, the results returned (repository names, stars, language, licence and a short description, or the first 1,000 characters of a README), whether it worked, your browser or agent's User-Agent and your country. We also record sign-ins and API key changes. The log is kept for up to 90 days and is visible to the people who run Code Search, so they can operate the service and stop abuse. It never contains your API keys, tokens or IP address.</li>
  </ul>
  <h2>What we do not store</h2>
  <ul>
    <li>Your password. Sign-in happens on GitHub's own page.</li>
    <li>Your private repositories. The token cannot see them.</li>
  </ul>
  <h2>Who else is involved</h2>
  <ul>
    <li>GitHub, which handles sign-in and answers every search.</li>
    <li>Cloudflare, which hosts the site, the database and the cache, and whose Workers AI service reads the text of your search to work out what to look for. Your account is not sent with it.</li>
  </ul>
  <h2>Cookies</h2>
  <p>One sign-in cookie (HttpOnly, SameSite=Lax) and a short-lived cookie that protects the sign-in step. No advertising or analytics cookies.</p>
  <h2>Deleting your data</h2>
  <p>Delete your account from the dashboard under Account. Your keys, sessions, token, usage counts and call log are removed and Code Search's access to your GitHub account is revoked in the same step.</p>
</article>"""

TERMS = """<article class="prose">
  <p class="doc-kicker">Legal</p>
  <h1>Terms</h1>
  <p>Last updated 4 November 2026. By using Code Search (codesearch.amplfyd.com, part of amplfyd) you agree to these terms.</p>
  <h2>The service</h2>
  <p>Code Search is free. It searches public GitHub repositories on your behalf, using your own GitHub account's quota, and returns the results through the dashboard, the REST API and the MCP server.</p>
  <h2>Fair use</h2>
  <ul>
    <li>Keep to the published limits: GitHub's search limit of 30 requests a minute and Code Search's 120 requests a minute per account.</li>
    <li>Do not try to get around rate limits, for example by creating many GitHub accounts.</li>
    <li>Follow <a class="link" href="https://docs.github.com/en/site-policy/github-terms/github-terms-of-service" rel="noopener">GitHub's Terms of Service</a>, which also apply to every search.</li>
    <li>Keep your API keys secret. You are responsible for what is done with them; revoke a key the moment you think it leaked.</li>
  </ul>
  <h2>Results</h2>
  <p>Results come from GitHub and belong to their owners. Code Search ranks them but does not review them. Check a project's licence, security and maintenance before you depend on it.</p>
  <h2>No warranty</h2>
  <p>Code Search is provided as is, without any warranty. It can be slow, limited or unavailable, for example when GitHub is. We may change or stop the service, and we may suspend accounts that abuse it.</p>
  <h2>Contact</h2>
  <p>Questions about these terms go to the team behind amplfyd.</p>
</article>"""

LOST = f"""<section class="lost">
  <pre class="ascii note-ascii is-grey" data-ascii="cloud" aria-hidden="true"></pre>
  <p class="lost-code" aria-hidden="true">404</p>
  <h1>No repository here. Or page.</h1>
  <p>This address doesn't match anything on Code Search. Try a search instead; that part works.</p>
  <div class="hero-cta">
    <a class="btn btn-accent btn-big btn-ticket" href="/auth/login" data-auth="start">{gh()}<span>Start searching</span></a>
    <a class="btn btn-big" href="/">Back to home</a>
  </div>
</section>"""


def write(rel, content):
    p = os.path.join(PUB, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w").write(content)
    print("wrote", rel, len(content))


write("index.html", landing())
write("docs/index.html", docs())
write("privacy/index.html", simple_page("/privacy/", "Privacy: Code Search", "What Code Search stores when you sign in with GitHub, and how to delete it.", PRIVACY))
write("terms/index.html", simple_page("/terms/", "Terms: Code Search", "The terms for using Code Search, a free GitHub search for people and AI agents.", TERMS))
write("404.html", simple_page("/404.html", "Page not found: Code Search", "This page does not exist.", LOST, robots="noindex", cls="page"))
