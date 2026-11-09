// Site-wide settings stored in D1. Only "registration" exists today: whether new users may create an account.

import { TtlCache } from "./memo.js";
import { withAppTables } from "./schema.js";

const REGISTRATION = "registration";
const CACHE_TTL_MS = 15_000;
const cache = new TtlCache(1);

async function readRegistration(env) {
  const row = await withAppTables(env, () =>
    env.DB.prepare("SELECT value, updated_at, updated_by FROM app_settings WHERE key = ?1").bind(REGISTRATION).first(),
  );
  const value = { open: row?.value !== "closed", updatedAt: row?.updated_at ?? null, updatedBy: row?.updated_by ?? null };
  cache.set(REGISTRATION, value, CACHE_TTL_MS);
  return value;
}

/** The current state, read from the database. Use this wherever the answer decides who gets in. */
export const registrationState = (env) => readRegistration(env);

/** For showing or hiding sign-up buttons: cached for 15 seconds, and treated as open if the database fails. */
export async function registrationOpenForDisplay(env) {
  const cached = cache.get(REGISTRATION);
  if (cached) return cached.open;
  try {
    return (await readRegistration(env)).open;
  } catch (err) {
    console.error("Could not read the registration setting", String(err));
    return true;
  }
}

export async function setRegistrationOpen(env, open, login) {
  const now = Date.now();
  await withAppTables(env, () =>
    env.DB.prepare(
      `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
      .bind(REGISTRATION, open ? "open" : "closed", now, login)
      .run(),
  );
  const value = { open, updatedAt: now, updatedBy: login };
  cache.set(REGISTRATION, value, CACHE_TTL_MS);
  return value;
}
