// How to connect each agent to Code Search's MCP server. Shared by the landing page, docs and dashboard.
// `key` is the user's API key, or a placeholder when it is not known.

export const PLACEHOLDER_KEY = "YOUR_CODE_SEARCH_KEY";

export function mcpUrl(origin = location.origin) {
  return `${origin}/mcp`;
}

export const AGENTS = [
  {
    id: "claude",
    name: "Claude Code",
    file: "Terminal",
    lang: "shell",
    note: "Adds Code Search for your user. Run /mcp inside Claude Code to check it is connected.",
    snippet: (url, key) => `claude mcp add --transport http --scope user code-search ${url} \\\n  --header "Authorization: Bearer ${key}"`,
  },
  {
    id: "codex",
    name: "Codex",
    file: "~/.codex/config.toml",
    lang: "toml",
    note: "Codex reads the key from an environment variable. Add the export to your shell profile.",
    snippet: (url, key) => `[mcp_servers.code-search]\nurl = "${url}"\nbearer_token_env_var = "CODE_SEARCH_API_KEY"\n\n# in your shell profile:\n# export CODE_SEARCH_API_KEY="${key}"`,
  },
  {
    id: "cursor",
    name: "Cursor",
    file: "~/.cursor/mcp.json",
    lang: "json",
    note: "Restart Cursor, then enable Code Search under Settings, MCP.",
    snippet: (url, key) =>
      JSON.stringify({ mcpServers: { "code-search": { url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
  },
  {
    id: "grok",
    name: "Grok",
    file: "xAI Responses API",
    lang: "shell",
    note: "Grok calls Code Search as a remote MCP tool. Your xAI key authenticates to xAI; the Code Search key goes in authorization.",
    snippet: (url, key) =>
      `curl https://api.x.ai/v1/responses \\\n  -H "Authorization: Bearer $XAI_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(
        {
          model: "grok-4.7",
          input: [{ role: "user", content: "Find a self-hosted kanban board with markdown support" }],
          tools: [{ type: "mcp", server_url: url, server_label: "code-search", authorization: key }],
        },
        null,
        2,
      ).replace(/\n/g, "\n  ")}'`,
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    file: ".vscode/mcp.json",
    lang: "json",
    note: "VS Code asks for the key once and stores it securely.",
    snippet: (url) =>
      JSON.stringify(
        {
          servers: { "code-search": { type: "http", url, headers: { Authorization: "Bearer ${input:code-search-key}" } } },
          inputs: [{ type: "promptString", id: "code-search-key", description: "Code Search API key", password: true }],
        },
        null,
        2,
      ),
  },
  {
    id: "windsurf",
    name: "Windsurf",
    file: "~/.codeium/windsurf/mcp_config.json",
    lang: "json",
    note: "Restart Windsurf after saving.",
    snippet: (url, key) =>
      JSON.stringify({ mcpServers: { "code-search": { serverUrl: url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    file: "~/.gemini/settings.json",
    lang: "json",
    note: "Run /mcp in Gemini CLI to see Code Search's two tools.",
    snippet: (url, key) =>
      JSON.stringify({ mcpServers: { "code-search": { httpUrl: url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
  },
];

/** Inline SVG that references the brand mark sprite. */
export function markSvg(id, className = "mark") {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS(ns, "use");
  use.setAttribute("href", `/img/marks.svg#${id}`);
  svg.append(use);
  return svg;
}

/** Copies text, falling back to selecting it. Returns true when copied. */
export async function copyText(text, fallbackNode) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (fallbackNode) {
      const range = document.createRange();
      range.selectNodeContents(fallbackNode);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    return false;
  }
}
