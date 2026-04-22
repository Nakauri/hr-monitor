// POST /api/auth/refresh
// Web: reads HttpOnly refresh cookie, returns a fresh access token.
// Native: accepts refresh_token in body, returns a fresh access token.
// On invalid_grant (revoked/expired refresh token), clears the cookie
// on web and signals re-sign-in via 401.

import {
  setCors, isAllowedOrigin, requireEnv,
  parseCookies, serializeRefreshCookie, clearRefreshCookie,
  REFRESH_COOKIE_NAME, GOOGLE_TOKEN_URL,
} from '../../lib/oauth-helpers.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!isAllowedOrigin(req.headers.origin)) {
    return res.status(403).json({ error: 'forbidden_origin' });
  }

  const envErr = requireEnv(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
  if (envErr) return res.status(500).json({ error: 'server_misconfigured' });

  const body = req.body || {};
  let refreshToken = body.refresh_token || null;
  const isNative = !!refreshToken;

  if (!refreshToken) {
    const cookies = parseCookies(req.headers.cookie);
    refreshToken = cookies[REFRESH_COOKIE_NAME] || null;
  }

  if (!refreshToken) {
    return res.status(401).json({ error: 'no_refresh_token' });
  }

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  let tokenResp, tokenData;
  try {
    tokenResp = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    tokenData = await tokenResp.json();
  } catch (e) {
    console.error('[refresh] network error hitting google:', e);
    return res.status(502).json({ error: 'upstream_error' });
  }

  if (!tokenResp.ok) {
    const googleErr = tokenData.error || 'unknown';
    console.warn('[refresh] google rejected', tokenResp.status, tokenData);
    if (googleErr === 'invalid_grant') {
      if (!isNative) res.setHeader('Set-Cookie', clearRefreshCookie());
      return res.status(401).json({ error: 'refresh_token_invalid' });
    }
    return res.status(502).json({ error: 'upstream_refused', google_error: googleErr });
  }

  const { access_token, expires_in, scope, refresh_token: rotated } = tokenData;

  // Google usually does NOT rotate refresh tokens, but if one comes back,
  // preserve it. Never overwrite our stored RT with null.
  if (rotated && !isNative) {
    res.setHeader('Set-Cookie', serializeRefreshCookie(rotated));
  }

  const out = { access_token, expires_in, scope };
  if (isNative && rotated) out.refresh_token = rotated;
  return res.status(200).json(out);
}
