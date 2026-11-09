// Runtime configuration helpers.

export const USER_AGENT = "CodeSearch"; // GitHub requires a User-Agent on API requests

export function githubApiBase(env) {
  return (env.GITHUB_API_BASE || "https://api.github.com").replace(/\/+$/, "");
}

export function githubOAuthBase(env) {
  return (env.GITHUB_OAUTH_BASE || "https://github.com").replace(/\/+$/, "");
}

const GITHUB_TIMEOUT_MS = 10_000;

/** Stops a GitHub call that has not finished in time, so a stalled GitHub cannot stall our users. */
export const githubTimeout = () => AbortSignal.timeout(GITHUB_TIMEOUT_MS);

/**
 * True only for the one admin account: ADMIN_GITHUB_ID, a numeric GitHub id, which unlike a login or an email
 * can never be taken over by renaming. Anything but a single number (a list, for example) means no admin at all.
 */
export function isAdmin(env, user) {
  const id = String(env.ADMIN_GITHUB_ID ?? "").trim();
  return Boolean(user) && /^\d+$/.test(id) && String(user.id) === id;
}

const REQUIRED = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY"];

/** Names of required settings that are missing (never their values). */
export function missingConfig(env) {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (!env.DB) missing.push("DB (D1 binding)");
  return missing;
}
