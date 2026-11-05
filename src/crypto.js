// Small crypto helpers built on WebCrypto (available in Workers and Node 20+).

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ConfigError extends Error {}

export function bytesToBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64ToBytes(input) {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Cryptographically random URL-safe string with `bytes` bytes of entropy. */
export function randomToken(bytes = 32) {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison. */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const keyCache = new Map();

function getAesKey(secret) {
  if (!secret) throw new ConfigError("TOKEN_ENCRYPTION_KEY is not set");
  let promise = keyCache.get(secret);
  if (!promise) {
    let raw;
    try {
      raw = base64ToBytes(secret.trim());
    } catch {
      throw new ConfigError("TOKEN_ENCRYPTION_KEY must be base64");
    }
    if (raw.length !== 32) throw new ConfigError("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
    promise = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    keyCache.set(secret, promise);
  }
  return promise;
}

/** Encrypts text with AES-256-GCM. Output format: "v1.<iv>.<ciphertext>" (base64url). */
export async function encryptText(plaintext, secret) {
  const key = await getAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext));
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ct))}`;
}

/** Decrypts output of encryptText. Throws if the data was tampered with or the key is wrong. */
export async function decryptText(payload, secret) {
  const key = await getAesKey(secret);
  const parts = String(payload).split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("Unsupported ciphertext format");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(parts[1]) },
    key,
    base64ToBytes(parts[2]),
  );
  return decoder.decode(pt);
}
