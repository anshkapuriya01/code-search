// Response and cookie helpers.

const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...BASE_HEADERS,
      ...headers,
    },
  });
}

export function errorJson(status, message, extra = {}, headers = {}) {
  return json({ error: message, ...extra }, status, headers);
}

/** 302 redirect that can set several cookies. */
export function redirect(location, cookies = []) {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", ...BASE_HEADERS });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

/**
 * Reads at most maxBytes of a stream, then stops, so a huge body can never be held in memory.
 * Returns { text, cut }, where cut means there was more than maxBytes.
 */
export async function readStream(stream, maxBytes) {
  if (!stream) return { text: "", cut: false };
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - total;
    if (value.length > room) {
      if (room > 0) chunks.push(value.subarray(0, room));
      total = maxBytes;
      cut = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  const text = new TextDecoder().decode(bytes);
  return { text: cut ? text.replace(/�$/, "") : text, cut }; // a cut can land inside a multi-byte character
}

/** A request body as text, or null when it is larger than maxBytes. */
export async function readBody(request, maxBytes) {
  if (Number(request.headers.get("Content-Length")) > maxBytes) return null;
  const { text, cut } = await readStream(request.body, maxBytes);
  return cut ? null : text;
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name && !(name in out)) {
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        out[name] = value;
      }
    }
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, path = "/", secure = true, httpOnly = true, sameSite = "Lax" } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  if (httpOnly) c += "; HttpOnly";
  if (secure) c += "; Secure";
  return c;
}
