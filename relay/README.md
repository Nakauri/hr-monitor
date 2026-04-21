# HR Relay

Minimal WebSocket fan-out relay for the HR Monitor app. Built on [PartyKit](https://partykit.io) (Cloudflare Workers + Durable Objects under the hood).

## What it does

Each user generates a unique "broadcast key" in the HR Monitor app (stored in their localStorage). The live monitor tab opens a WebSocket to this relay using that key, publishes HR readings on every beat. OBS Browser Source (or anywhere else the user wants to receive the data) opens a WebSocket to the same URL and receives the fan-out.

Different users = different keys = different Durable Object instances. No cross-contamination possible by design.

## First-time deploy

```bash
cd relay
npm install
npx partykit login       # opens a browser, sign in with your Cloudflare account
npx partykit deploy      # deploys; prints your wss URL
```

After the first deploy you'll get a URL like `https://hr-relay.<your-cloudflare-name>.partykit.dev`. Convert `https://` to `wss://` and append `/parties/main/<broadcast-key>` for the WebSocket endpoint.

## Local dev

```bash
npx partykit dev
```

Relay runs on `http://127.0.0.1:1999`. The HR Monitor client honours a `?relay=ws://127.0.0.1:1999` URL param to target it for local testing.

## Cost

- Cloudflare Workers free tier: 100k requests/day baseline.
- WebSocket hibernation means idle connections don't count as requests. Only connect / disconnect and actual active messages bill against the quota.
- Realistic usage for this app: far under 1% of free tier even with dozens of concurrent users.
- No credit card required to deploy.
