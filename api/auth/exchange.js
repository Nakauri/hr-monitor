// POST /api/auth/exchange
// Swaps an authorization code (web PKCE) or serverAuthCode (Capacitor
// native) for access + refresh tokens. Refresh token lands in an HttpOnly
// cookie for web; returned in the JSON body for native (stored in
// Android Keystore by the caller).

import {
  setCors, isAllowedOrigin, requireEnv,
  serializeRefreshCookie, emailFromIdToken, GOOGLE_TOKEN_URL,
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
  const { code, code_verifier, redirect_uri, server_auth_code } = body;

  let params;
  let isNative = false;

  if (server_auth_code) {
    isNative = true;
    params = new URLSearchParams({
      code: String(server_auth_code),
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: '',
      grant_type: 'authorization_code',
    });
  } else if (code && redirect_uri) {
    // Web popup flow: no PKCE (client_secret protects the exchange). Optional
    // code_verifier is forwarded if the client did supply one — covers any
    // future flow that needs PKCE.
    const fields = {
      code: String(code),
      redirect_uri: String(redirect_uri),
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'authorization_code',
    };
    if (code_verifier) fields.code_verifier = String(code_verifier);
    params = new URLSearchParams(fields);
  } else {
    return res.status(400).json({
      error: 'bad_request',
      message: 'need code+redirect_uri or server_auth_code',
    });
  }

  let tokenResp, tokenData;
  try {
    tokenResp = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    tokenData = await tokenResp.json();
  } catch (e) {
    console.error('[exchange] network error hitting google:', e);
    return res.status(502).json({ error: 'upstream_error' });
  }

  if (!tokenResp.ok) {
    console.warn('[exchange] google rejected', tokenResp.status, tokenData);
    return res.status(400).json({
      error: 'exchange_failed',
      google_error: tokenData.error || 'unknown',
      google_description: tokenData.error_description || null,
    });
  }

  const { access_token, refresh_token, expires_in, scope, id_token } = tokenData;
  const email = emailFromIdToken(id_token);

  if (isNative) {
    // Native stores refresh_token in Android Keystore itself.
    return res.status(200).json({
      access_token,
      refresh_token: refresh_token || null,
      expires_in,
      scope,
      email,
    });
  }

  // Web: refresh_token into HttpOnly cookie. Access_token returned to JS.
  if (refresh_token) {
    res.setHeader('Set-Cookie', serializeRefreshCookie(refresh_token));
  }
  return res.status(200).json({
    access_token,
    expires_in,
    scope,
    email,
    has_refresh: !!refresh_token,
  });
}
