// Local preview of the real Worker with a fake GitHub: sign-in is approved automatically and searches
// are answered from public/data/demo.json, so the dashboard (including Usage) can be tried without a
// GitHub OAuth app or network access.  Usage: node scripts/dev-mock.mjs   then open http://127.0.0.1:8790
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const MOCK_PORT = 9872;
const APP_PORT = 8790;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const demo = JSON.parse(readFileSync(path.join(ROOT, "public/data/demo.json"), "utf8"));
const persist = path.join(ROOT, ".wrangler/dev-mock");
mkdirSync(persist, { recursive: true });

http
  .createServer((req, res) => {
    const url = new URL(req.url, MOCK);
    const send = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (url.pathname === "/login/oauth/authorize") {
        const back = new URL(url.searchParams.get("redirect_uri"));
        back.searchParams.set("code", "good");
        back.searchParams.set("state", url.searchParams.get("state"));
        return res.writeHead(302, { Location: back.toString() }).end();
      }
      if (url.pathname === "/login/oauth/access_token") return send(200, { access_token: "mock-token", token_type: "bearer", scope: "" });
      if (url.pathname === "/user") return send(200, { id: 4242, login: "preview-user", name: "Preview User", avatar_url: null });
      if (url.pathname.endsWith("/grant")) return res.writeHead(204).end();
      if (url.pathname.endsWith("/readme")) return res.writeHead(200, { "content-type": "text/plain" }).end("# Preview README\n\nServed by the local mock.");
      if (url.pathname === "/search/repositories") {
        const q = (url.searchParams.get("q") || "").toLowerCase();
        const words = new Set(q.split(/\s+/));
        const best = demo.searches.reduce((a, s) => (s.input.toLowerCase().split(" ").filter((w) => words.has(w)).length > a.input.toLowerCase().split(" ").filter((w) => words.has(w)).length ? s : a));
        const items = best.items.map((it, i) => ({
          id: i + 1, full_name: it.name, html_url: it.url, stargazers_count: it.stars, language: it.language,
          license: it.license ? { spdx_id: it.license } : null, description: it.description, topics: it.topics, pushed_at: it.pushedAt,
          homepage: null, archived: false, forks_count: 0, open_issues_count: 0, fork: false,
        }));
        res.writeHead(200, { "content-type": "application/json", "x-ratelimit-limit": "30", "x-ratelimit-remaining": "29", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60) });
        return res.end(JSON.stringify({ total_count: items.length, incomplete_results: false, items }));
      }
      send(404, { message: "mock: not found" });
    });
  })
  .listen(MOCK_PORT, "127.0.0.1");

const wrangler = path.join(ROOT, "node_modules/.bin/wrangler");
execFileSync(wrangler, ["d1", "migrations", "apply", "starscout", "--local", "--persist-to", persist], { cwd: ROOT, env: { ...process.env, CI: "1" }, stdio: "inherit" });
const vars = {
  GITHUB_CLIENT_ID: "preview-client",
  GITHUB_CLIENT_SECRET: "preview-secret",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  GITHUB_OAUTH_BASE: MOCK,
  GITHUB_API_BASE: MOCK,
  ADMIN_GITHUB_IDS: "4242", // the preview user, so /admin/ can be tried
  AI_DAILY_NEURONS: "0", // the preview does not spend Workers AI neurons
};
spawn(
  wrangler,
  ["dev", "--port", String(APP_PORT), "--ip", "127.0.0.1", "--local-upstream", `127.0.0.1:${APP_PORT}`, "--persist-to", persist, "--show-interactive-dev-session=false",
    ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])],
  { cwd: ROOT, env: { ...process.env, CI: "1" }, stdio: "inherit" },
);
console.log(`Preview: http://127.0.0.1:${APP_PORT}  (sign-in is automatic)`);
