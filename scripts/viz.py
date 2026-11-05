"""Technical visuals built from the real brand marks in public/img/marks.svg (GitHub, Claude, Codex, Cursor,
Grok, Copilot, Windsurf, Gemini, Cline, Amp) and the Code Search logo. Shared by build_pages.py and the dashboard."""

AGENTS = [("claude", "Claude Code"), ("codex", "Codex"), ("cursor", "Cursor"), ("grok", "Grok"), ("copilot", "GitHub Copilot"),
          ("windsurf", "Windsurf"), ("gemini", "Gemini CLI"), ("cline", "Cline"), ("amp", "Amp")]


def m(agent, cls="mark"):
    return f'<svg class="{cls}" aria-hidden="true"><use href="/img/marks.svg#{agent}"/></svg>'


def _tile(agent, name):
    return f'<span class="t b-{agent}" title="{name}"><span>{m(agent)}</span></span>'


ORBIT = (
    '<div class="orbit" role="img" aria-label="The GitHub mark at the centre, circled by Claude Code, Codex, Cursor, Grok, GitHub Copilot, Windsurf, Gemini CLI, Cline and Amp">'
    '<div class="orbit-core">' + m("github", "mark core-gh") + '<img class="core-cs" src="/img/logo.svg" alt="" width="34" height="25" draggable="false"></div>'
    '<div class="ring ring-1">' + "".join(_tile(a, n) for a, n in AGENTS[:4]) + "</div>"
    '<div class="ring ring-2">' + "".join(_tile(a, n) for a, n in AGENTS[4:]) + "</div>"
    "</div>"
)

_SENTENCE = "I need an open source alternative to notion that I can self host".split()
VS_VIZ = (
    '<div class="viz-vs" role="img" aria-label="GitHub search requires every word of the sentence; Code Search keeps the key term and returns AppFlowy, AFFiNE and Huly ranked by stars">'
    '<div class="window vs-gh"><div class="window-bar"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>'
    '<p class="window-title"><b>github.com</b>/search?type=repositories</p></div>'
    '<div class="vs-body"><p class="vs-q">' + m("github") + '<span>GitHub requires every word</span></p><p class="vs-words">'
    + "".join(f'<span class="chip chip-soft">{w}</span>' for w in _SENTENCE) +
    '</p><p class="vs-note">Ranked by GitHub\'s own relevance, spam included</p></div></div>'
    '<div class="window vs-cs"><div class="window-bar"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>'
    '<p class="window-title"><b>code search</b> / same sentence</p></div>'
    '<div class="vs-body"><p class="vs-words"><span class="chip chip-key">notion</span><span class="chip chip-soft">alternative</span><span class="chip chip-soft">self</span><span class="chip chip-soft">host</span></p>'
    '<ol class="vs-list">'
    '<li>' + m("github") + '<span>AppFlowy-IO/AppFlowy</span><b>★ 78,162</b></li>'
    '<li>' + m("github") + '<span>toeverything/AFFiNE</span><b>★ 74,190</b></li>'
    '<li>' + m("github") + '<span>hcengineering/platform</span><b>★ 28,042</b></li>'
    "</ol></div></div></div>"
)

_STUFF = ("ai chatgpt gpt-4 llm agent react vue angular svelte nextjs python rust go java kotlin swift flutter docker kubernetes "
          "aws azure gcp crypto web3 nft blockchain bitcoin ") * 4
SPAM_VIZ = (
    '<div class="figure viz-spam" role="img" aria-label="A repository whose description is 64,765 characters of keywords is removed; normal descriptions stay">'
    '<div class="spam-row is-out"><p class="spam-head">' + m("github") + '<span>keyword-stuffed repository</span><b>64,765 chars</b></p>'
    f'<p class="spam-text">{_STUFF}</p><span class="stamp">removed</span></div>'
    '<div class="spam-row"><p class="spam-head">' + m("github") + '<span>honest description</span><b>304 chars, the longest we saw</b></p></div>'
    "</div>"
)

STARS_VIZ = (
    '<ol class="figure viz-stars" role="img" aria-label="Results ranked by stars: AppFlowy 78,162, AFFiNE 74,190, Huly 28,042, Focalboard 26,540">'
    '<li class="w100">' + m("github") + '<span>AppFlowy-IO/AppFlowy</span><b>78,162</b><i></i></li>'
    '<li class="w95">' + m("github") + '<span>toeverything/AFFiNE</span><b>74,190</b><i></i></li>'
    '<li class="w36">' + m("github") + '<span>hcengineering/platform</span><b>28,042</b><i></i></li>'
    '<li class="w34">' + m("github") + '<span>mattermost-community/focalboard</span><b>26,540</b><i></i></li>'
    "</ol>"
)

GATES_VIZ = (
    '<div class="viz-gates" role="img" aria-label="With one shared token everyone shares 30 searches a minute; with Code Search you, a teammate and your agents each search on their own GitHub quota">'
    '<div class="gate is-bad"><span class="who">Everyone</span><span class="via">' + m("github") + 'one shared token</span><span class="q">30 / min for all</span></div>'
    '<div class="gate"><span class="who"><img src="/img/logo.svg" alt="" width="20" height="15" draggable="false">You</span><span class="via">' + m("github") + 'your token</span><span class="q">30 / min</span></div>'
    '<div class="gate"><span class="who"><img src="/img/logo.svg" alt="" width="20" height="15" draggable="false">A teammate</span><span class="via">' + m("github") + 'their token</span><span class="q">30 / min</span></div>'
    '<div class="gate"><span class="who">' + m("claude") + m("cursor") + 'Your agents</span><span class="via">' + m("github") + 'your token, via API key</span><span class="q">your 30 / min</span></div>'
    "</div>"
)

FLOW_VIZ = (
    '<div class="flow" role="img" aria-label="You or your agent send a plain sentence to Code Search, which asks GitHub and returns repositories ranked by stars">'
    '<div class="flow-node"><span class="flow-ico">' + m("claude") + m("cursor") + m("codex") + '</span><b>You or your agent</b><small>a plain sentence</small></div>'
    '<span class="flow-line" aria-hidden="true"></span>'
    '<div class="flow-node is-hot"><span class="flow-ico"><img src="/img/logo.svg" alt="" width="30" height="22" draggable="false"></span><b>Code Search</b><small>parse · filter · rank</small></div>'
    '<span class="flow-line" aria-hidden="true"></span>'
    '<div class="flow-node"><span class="flow-ico">' + m("github") + '</span><b>GitHub</b><small>your 30 searches / min</small></div>'
    '<span class="flow-line" aria-hidden="true"></span>'
    '<div class="flow-node"><span class="flow-ico star">★</span><b>Ranked repos</b><small>spam removed</small></div>'
    "</div>"
)
