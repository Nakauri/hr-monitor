// POST /api/auth/revoke
// Hits Google's /revoke endpoint with the user's refresh token and clears
// the HttpOnly cookie on web. Best-effort: the cookie is always cleared,
// even if Google's revoke call fails, so the app state goes clean.

import {
  setCors, isAllowedOrigin,
  parseCookies, clearRefreshCookie,
  REFRESH_COOKIE_NAME, GOOGLE_REVOKE_URL,
} from '../../lib/oauth-helpers.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!isAllowedOrigin(req.headers.origin)) {
    return res.status(403).json({ error: 'forbidden_origin' });
  }

  const body = req.body || {};
  let token = body.refresh_token || null;

  if (!token) {
    const cookies = parseCookies(req.headers.cookie);
    token = cookies[REFRESH_COOKIE_NAME] || null;
  }

  // Always clear the cookie so local state ends up clean.
  res.setHeader('Set-Cookie', clearRefreshCookie());

  if (!token) {
    return res.status(200).json({ ok: true, note: 'no_token_to_revoke' });
  }

  try {
    const revokeResp = await fetch(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    // Google returns 200 on success, 400 if token is already invalid. Both
    // are fine from our perspective.
    return res.status(200).json({ ok: revokeResp.ok, google_status: revokeResp.status });
  } catch (e) {
    console.error('[revoke] network error hitting google:', e);
    return res.status(200).json({ ok: false, error: 'upstream_error' });
  }
}
