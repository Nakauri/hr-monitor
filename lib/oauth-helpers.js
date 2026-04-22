// Shared helpers for /api/auth/* serverless endpoints.
// CORS allowlist, cookie serialization, origin validation, Google token
// endpoint wrappers. Runs on Vercel Node.js runtime (native fetch, no deps).

export const REFRESH_COOKIE_NAME = '__Host-aorti_rt';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 180; // 180 days

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

const STATIC_ALLOWED_ORIGINS = new Set([
  'https://aorti.ca',
  'https://www.aorti.ca',
  'https://localhost',        // Capacitor Android (androidScheme: https)
  'http://localhost:3000',    // Vercel dev
  'http://localhost:8765',    // local static server (per CLAUDE.md)
]);

export function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (STATIC_ALLOWED_ORIGINS.has(origin)) return true;
  // Preview branch deploys on Vercel get unique *.vercel.app URLs.
  if (process.env.VERCEL_ENV === 'preview' && /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin)) {
    return true;
  }
  return false;
}

export function setCors(req, res) {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

export function serializeRefreshCookie(value) {
  // __Host- prefix requires Secure, Path=/, no Domain attribute.
  return `${REFRESH_COOKIE_NAME}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
}

export function clearRefreshCookie() {
  return `${REFRESH_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  cookieHeader.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  });
  return out;
}

// Extract email from a Google id_token (JWT). No signature verification —
// we trust the token because it came direct from Google over TLS in the
// same response as our access_token. Used for UI display only.
export function emailFromIdToken(idToken) {
  if (!idToken) return null;
  try {
    const parts = idToken.split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.email || null;
  } catch {
    return null;
  }
}

export function requireEnv(names) {
  const missing = names.filter(n => !process.env[n]);
  if (missing.length) {
    const msg = `[oauth] missing env vars: ${missing.join(', ')}`;
    console.error(msg);
    return msg;
  }
  return null;
}
