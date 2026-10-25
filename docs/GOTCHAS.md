# Gotchas

Trip-wires that cost real time. One rule each, with where it bites. Add new ones at the end of their section.
The checks that guard a rule are named in brackets.

## Pages and scripts

- **A parse error kills the whole page silently.** A duplicate `const` or a stray bracket stops every handler in
  that `<script>` block while the page still looks fine. [`scripts/parse-check.cjs`, every page and every
  shipped script, including `mobile/src`]
- **Never write regexes or backslashes through a shell or a Python string.** Escapes get eaten: a relay URL test
  became `//parties/main//`, which parses as a comment, and the native relay shim shipped dead. Use the editor.
- **Every shim is an IIFE with local helpers.** Top-level functions named `init` or `mark` in two shims
  overwrite each other and the first shim fails silently.
- **Capacitor plugins are reached as `Capacitor.Plugins.<Name>`.** `registerPlugin` exists only in ES modules,
  and the shims are plain scripts.
- **A UI drawn from stored or async state must not show a wrong default while it loads.** The viewer drew Drive
  as signed out until its cache paint finished, and tapping it started a needless fresh sign-in. The cloud is
  slashed only with no saved sign-in at all. [`viewer-nav` S62 cold open]
- **A signed-in page refreshes an expired access token by itself.** Only a refresh that fails may ask for a tap.
  [`monitor-sync` expired token]

## Numbers shown to the user

- **RMSSD, SDNN, raw RR conversion and stage colours exist twice, in JS and Java, and must match.** Both carry a
  `PARITY CRITICAL` comment naming the other. [`scripts/rmssd-parity.test.js` reads both from source]
- **Every average or extreme over a live series skips gap markers (`{ v: null }`).** Counting them as zero read
  Avg HRV low after every dropout. [`seriesStats`, `scripts/avg-stats.test.cjs`]
- **A day is a local calendar date.** Never take a day key from `toISOString().slice(0, 10)`; west of UTC it is
  tomorrow every evening. [`scripts/day-boundary.test.cjs`]

## Android

- **Run `npm run copy-web` and `npx cap sync android` before every build**, or the APK carries stale web code.
- **`adb install -r` keeps app data; it may not restart a running foreground service.** Force-stop to load new
  code. Install only through `scripts/install-gated.sh`, which refuses over a live recording.
- **The public APK is a release build (not debuggable); local test builds are debug builds.** Same keystore, so
  either installs over the other and keeps sign-in and data.
- **The relay host is baked into the APK.** A host outage means "connecting" until a new APK ships; check the
  host and `relay/scripts/probe.mjs` first.

## Relay

- **Size caps count bytes (`TextEncoder`) and are sized against a real tick (about 11 KB).** A 4 KB cap
  dropped every tick for weeks with both ends looking healthy. [`scripts/relay-server.test.mjs`]

## Web

- **Every pinned CDN script carries an integrity hash and `crossorigin="anonymous"`.** Test harnesses that serve
  a local copy must serve the identical file. [`scripts/parse-check.cjs`]
- **The Content-Security-Policy lives in `vercel.json` and is tested against every page.** Adding a new outside
  host means adding it in `scripts/csp-hashes.mjs`. [`scripts/csp.mjs`]
- **Inline scripts run only by hash.** An edit to a page's inline script blocks it on the live site until
  `node scripts/csp-hashes.mjs --write` regenerates `vercel.json`. [`scripts/csp.mjs` fails while it is stale]
- **`vercel.json` uses clean URLs: `/hrv_viewer.html` redirects to `/hrv_viewer`.** Check deploys on the clean
  path.

## Checks

- **A check nobody saw fail proves nothing.** Every check runs its mutants or was run against the code before the
  fix. Checks run by hand drift red unnoticed, so `./check` runs from the pre-push hook and CI.
