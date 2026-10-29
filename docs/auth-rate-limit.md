# Auth endpoints: input cap and rate limiting

Status: input cap BUILT (`lib/oauth-helpers.js` `MAX_INPUT`, tested by `scripts/auth-api.test.mjs` section 6). No
in-function rate limiter, by decision. A Vercel Firewall rule is optional and not set up.

## Input cap

- Every value `/api/auth/*` forwards to Google is at most 2,048 characters. Google's codes, verifiers, redirect
  addresses and refresh tokens are far shorter.
- exchange: an oversized `code`, `code_verifier`, `redirect_uri` or `server_auth_code` is a 400 `input_too_long`.
- refresh: an oversized refresh token is a 401 `refresh_token_invalid`; on web the cookie is cleared. A 401, not a
  400, because `auth.js` drops its sign-in only on a 401, so a bad cookie cannot stick.
- revoke: the cookie is cleared first, then an oversized token is a 400 `input_too_long`.
- Each check runs after the origin check and before any request to Google.

## Why no limiter in the function

- Vercel serverless memory is per instance: a counter in the function resets on a cold start and is not shared
  between instances, so it limits nothing.
- A shared counter needs a store (KV or Redis), which is a new service with its own keys and bill.
- The endpoints refuse foreign origins before Google is contacted, and Google rate-limits its own token endpoint.

## Optional: Vercel Firewall rule (the owner's call; it changes the live project)

- Rule: path starts with `/api/auth/`, rate limit by IP, for example 30 requests a minute, action deny.
- Set in the Vercel dashboard under Firewall. No code change; nothing in this repo depends on it.
