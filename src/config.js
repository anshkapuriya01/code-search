// Runtime configuration helpers.

export const USER_AGENT = "CodeSearch"; // GitHub requires a User-Agent on API requests

export function githubApiBase(env) {
  return (env.GITHUB_API_BASE || "https://api.github.com").replace(/\/+$/, "");
}

export function githubOAuthBase(env) {
  return (env.GITHUB_OAUTH_BASE || "https://github.com").replace(/\/+$/, "");
}

const REQUIRED = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY"];

/** Names of required settings that are missing (never their values). */
export function missingConfig(env) {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (!env.DB) missing.push("DB (D1 binding)");
  return missing;
}
