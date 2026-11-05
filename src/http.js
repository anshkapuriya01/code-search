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
