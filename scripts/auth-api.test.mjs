#!/usr/bin/env node
// The /api/auth endpoints (exchange, refresh, revoke) and lib/oauth-helpers.js, run in node with a fake
// Google and fake req/res. Guards: a foreign origin must be refused before Google is contacted; the web
// refresh token lives only in a __Host- HttpOnly Secure SameSite=Strict cookie and never in a web
// response body; a revoked grant clears the cookie; dev origins are refused in production. Nothing
// tested these until 2026-10-24 (report card, Verification). Runtime: under 1 s.
// Then each mutant below must make a check FAIL.
// Run: node scripts/auth-api.test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['lib/oauth-helpers.js', 'api/auth/exchange.js', 'api/auth/refresh.js', 'api/auth/revoke.js'];

function fakeRes() {
  const r = { code: null, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  return r;
}
const req = (over) => ({ method: 'POST', headers: { origin: 'https://www.aorti.ca' }, body: {}, ...over });

async function suite(dir) {
  const load = async (f) => import(pathToFileURL(path.join(dir, f)).href + '?v=' + Math.random());
  const H = await load('lib/oauth-helpers.js');
  const ex = (await load('api/auth/exchange.js')).default;
  const rf = (await load('api/auth/refresh.js')).default;
  const rv = (await load('api/auth/revoke.js')).default;
  const out = [];
  const check = (name, ok, detail) => out.push([name, !!ok, detail || '']);
  let calls = 0, google = { ok: true, status: 200, json: {} };
  globalThis.fetch = async () => { calls++; return { ok: google.ok, status: google.status, json: async () => google.json }; };
  process.env.GOOGLE_CLIENT_ID = 'cid'; process.env.GOOGLE_CLIENT_SECRET = 'secret';

  // 1. Origins.
  process.env.VERCEL_ENV = 'production';
  for (const [name, h, body] of [['exchange', ex, { code: 'c', redirect_uri: 'https://www.aorti.ca/' }], ['refresh', rf, { refresh_token: 't' }], ['revoke', rv, { refresh_token: 't' }]]) {
    calls = 0;
    const res = fakeRes();
    await h(req({ headers: { origin: 'https://evil.example' }, body }), res);
    check(`${name}: a foreign origin is refused before Google is contacted`, res.code === 403 && calls === 0, `status ${res.code}, google calls ${calls}`);
    check(`${name}: a foreign origin gets no CORS allow header`, !res.headers['access-control-allow-origin']);
  }
  check('production refuses the plain-http dev origins', !H.isAllowedOrigin('http://localhost:3000') && !H.isAllowedOrigin('http://localhost:8765'));
  check('production refuses a vercel.app preview origin', !H.isAllowedOrigin('https://x-y.vercel.app'));
  check('the site and the app origin are allowed', H.isAllowedOrigin('https://aorti.ca') && H.isAllowedOrigin('https://www.aorti.ca') && H.isAllowedOrigin('https://localhost'));
  check('no origin is not an allowed origin', !H.isAllowedOrigin(undefined) && !H.isAllowedOrigin(''));
  process.env.VERCEL_ENV = 'preview';
  check('a preview deploy allows its own vercel.app origin, not a look-alike', H.isAllowedOrigin('https://x-y.vercel.app') && !H.isAllowedOrigin('https://x.vercel.app.evil.example'));
  process.env.VERCEL_ENV = 'production';

  // 2. The refresh cookie.
  const c = H.serializeRefreshCookie('tok');
  check('refresh cookie is __Host-, HttpOnly, Secure, SameSite=Strict, Path=/ and has no Domain',
    /^__Host-/.test(c) && /; HttpOnly/.test(c) && /; Secure/.test(c) && /; SameSite=Strict/.test(c) && /; Path=\//.test(c) && !/Domain=/i.test(c), c);
  check('clearing the cookie keeps the same name and expires it', /^__Host-aorti_rt=;/.test(H.clearRefreshCookie()) && /Max-Age=0/.test(H.clearRefreshCookie()));
  check('a malformed cookie value does not throw', H.parseCookies('__Host-aorti_rt=%E0%A4%A')['__Host-aorti_rt'] === '%E0%A4%A');

  // 3. Web exchange: the refresh token goes only into the cookie.
  google = { ok: true, status: 200, json: { access_token: 'at', refresh_token: 'rt-secret', expires_in: 3600, scope: 's' } };
  let res = fakeRes();
  await ex(req({ body: { code: 'c', redirect_uri: 'https://www.aorti.ca/' } }), res);
  check('web exchange sets the refresh token as the cookie', res.code === 200 && /^__Host-aorti_rt=rt-secret;/.test(res.headers['set-cookie'] || ''), String(res.headers['set-cookie']));
  check('web exchange never puts the refresh token in the response body', !JSON.stringify(res.body).includes('rt-secret'), JSON.stringify(res.body));
  res = fakeRes();
  await ex(req({ body: { server_auth_code: 'n' } }), res);
  check('native exchange returns the refresh token and sets no cookie', res.body.refresh_token === 'rt-secret' && !res.headers['set-cookie']);
  calls = 0; res = fakeRes();
  await ex(req({ body: {} }), res);
  check('exchange with no code is a 400 and never contacts Google', res.code === 400 && calls === 0);

  // 4. Refresh.
  google = { ok: false, status: 400, json: { error: 'invalid_grant' } };
  res = fakeRes();
  await rf(req({ headers: { origin: 'https://www.aorti.ca', cookie: '__Host-aorti_rt=old' } }), res);
  check('a revoked grant (invalid_grant) clears the web cookie', res.code === 401 && /Max-Age=0/.test(res.headers['set-cookie'] || ''));
  res = fakeRes();
  await rf(req({ body: { refresh_token: 'native' } }), res);
  check('a native invalid_grant sets no cookie', res.code === 401 && !res.headers['set-cookie']);
  calls = 0; res = fakeRes();
  await rf(req({}), res);
  check('refresh with no token is a 401 and never contacts Google', res.code === 401 && calls === 0);
  google = { ok: true, status: 200, json: { access_token: 'at2', refresh_token: 'rt-rotated', expires_in: 3600 } };
  res = fakeRes();
  await rf(req({ headers: { origin: 'https://www.aorti.ca', cookie: '__Host-aorti_rt=old' } }), res);
  check('a rotated refresh token goes into the cookie, not the web body', /rt-rotated/.test(res.headers['set-cookie'] || '') && !JSON.stringify(res.body).includes('rt-rotated'));
  delete process.env.GOOGLE_CLIENT_SECRET; calls = 0; res = fakeRes();
  await rf(req({ body: { refresh_token: 't' } }), res);
  check('missing server secrets is a 500 and never contacts Google', res.code === 500 && calls === 0);
  process.env.GOOGLE_CLIENT_SECRET = 'secret';

  // 5. Revoke always clears the cookie, even when Google is unreachable.
  globalThis.fetch = async () => { throw new Error('offline'); };
  res = fakeRes();
  await rv(req({ headers: { origin: 'https://www.aorti.ca', cookie: '__Host-aorti_rt=old' } }), res);
  check('revoke clears the cookie even when Google is unreachable', /Max-Age=0/.test(res.headers['set-cookie'] || ''));
  return out;
}

function copyTo(dir, edit) {
  for (const f of FILES) {
    let s = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
    if (edit && edit[0] === f) {
      if (!s.includes(edit[1])) throw new Error(`mutant anchor missing in ${f}: ${edit[1]}`);
      s = s.replace(edit[1], edit[2]);
    }
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), s);
  }
}

const MUTANTS = [
  ['any origin allowed', 'lib/oauth-helpers.js', "if (!origin) return false;", 'return true;'],
  ['refresh cookie loses HttpOnly', 'lib/oauth-helpers.js', '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}', '; Secure; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}'],
  ['dev origins allowed in production', 'lib/oauth-helpers.js', "process.env.VERCEL_ENV !== 'production' && DEV_ALLOWED_ORIGINS.has(origin)", 'DEV_ALLOWED_ORIGINS.has(origin)'],
  ['refresh checks the origin after Google', 'api/auth/refresh.js', "  if (!isAllowedOrigin(req.headers.origin)) {\n    return res.status(403).json({ error: 'forbidden_origin' });\n  }\n", ''],
  ['web exchange echoes the refresh token', 'api/auth/exchange.js', '    has_refresh: !!refresh_token,', '    has_refresh: !!refresh_token, refresh_token,'],
  ['invalid_grant keeps the cookie', 'api/auth/refresh.js', 'if (!isNative) res.setHeader(\'Set-Cookie\', clearRefreshCookie());', ''],
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-api-'));
let fails = 0;
// The endpoints log Google's refusals and network errors; the expected ones would bury the results.
console.error = () => {};
console.warn = () => {};
try {
  const real = path.join(tmp, 'real');
  copyTo(real);
  // A copy keeps the import graph inside the temp dir and reads the files exactly as committed.
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  for (const [name, ok, detail] of await suite(real)) {
    console.log((ok ? 'OK    ' : 'FAIL  ') + name + (ok || !detail ? '' : '  ' + detail));
    if (!ok) fails++;
  }
  console.log('\nNegative controls (each must FAIL a check):');
  for (const [i, [name, ...edit]] of MUTANTS.entries()) {
    const dir = path.join(tmp, 'm' + i);
    copyTo(dir, edit);
    const caught = (await suite(dir)).filter(([, ok]) => !ok).map(([n]) => n);
    console.log((caught.length ? 'MUTANT ' : 'MISSED ') + name + (caught.length ? ': FAILED as required  (' + caught[0] + ')' : ': passed every check'));
    if (!caught.length) fails++;
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(fails ? `\nauth-api: ${fails} fail` : '\nauth-api: all pass');
process.exit(fails ? 1 : 0);
