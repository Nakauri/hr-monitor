# HR Relay

Minimal WebSocket fan-out relay for the HR Monitor app. Built on [PartyServer](https://github.com/cloudflare/partykit/tree/main/packages/partyserver) (Cloudflare Workers + Durable Objects).

## What it does

Each user generates a unique "broadcast key" in the HR Monitor app (stored in their localStorage). The live monitor tab opens a WebSocket to this relay using that key, publishes HR readings on every beat. OBS Browser Source (or anywhere else the user wants to receive the data) opens a WebSocket to the same URL and receives the fan-out.

Different users = different keys = different Durable Object instances. No cross-contamination possible by design.

## Deploy

```bash
cd relay
npm install
npx wrangler login       # once per machine
npx wrangler deploy      # prints https://hr-relay.<subdomain>.workers.dev
```

WebSocket endpoint: `wss://hr-relay.<subdomain>.workers.dev/parties/main/<broadcast-key>`. The `Main` binding in `wrangler.jsonc` sets the `main` path segment.

## Local dev + check

```bash
npx wrangler dev --port 8787
node scripts/probe.mjs                 # local
node scripts/probe.mjs wss://<host>    # deployed
```

The probe checks fan-out, no echo, the 32 KB cap, JSON-only, room isolation and wake after idle.

## Cost

- Cloudflare Workers free tier: 100k requests/day baseline.
- Hibernation (`static options = { hibernate: true }`) means idle connections don't count as requests. Only connect / disconnect and actual active messages bill against the quota.
- Realistic usage for this app: far under 1% of free tier even with dozens of concurrent users.
- No credit card required to deploy.
