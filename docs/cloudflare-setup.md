# Cloudflare setup (reference)

The step-by-step install for a new user is in the README (Ukrainian), section "Cloudflare". This page is the
reference behind it.

## Per-installation config stays out of git

- `cloud/wrangler.jsonc` holds the account ID, the hostname, the D1 `database_id` and the Access AUD/team domain.
  It is **gitignored**. Start from `cloud/wrangler.example.jsonc`.
- `cloud/worker-configuration.d.ts` is generated from it (`npm run types`, also run by `npm run check`) and is gitignored.
- Secrets are Worker secrets (`npx wrangler secret put <NAME>`), never files in git:

| Secret | Needed for |
|---|---|
| `PUSH_KEY` | required: the Pi's bearer key for `/api/ingest` (`openssl rand -hex 32`); the same value goes into the Pi's `push.env` |
| `SOLCAST_API_KEY`, `SOLCAST_RESOURCE_ID` | optional: solar forecast. Without them the forecast parts stay empty |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | optional: push notifications (`node test/gen-vapid.mjs`; new keys mean devices must re-subscribe) |

- Vars in `wrangler.jsonc`: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` (required, fail closed), `YASNO_REGION`, `YASNO_DSO`
  (optional, default 25/902 = Kyiv).
- Shared app settings (addresses, phase names, battery) live in D1 `config` and are edited in the app's System tab.

## Account and wrangler

- `npx wrangler login`, or, when the machine is logged into another account, an **API token** for the target
  account: My Profile → API Tokens → template **"Edit Cloudflare Workers"**, plus **Account › D1 › Edit**, limited to
  that account. Export `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (or keep them in `cloud/.env.local`,
  gitignored, and `set -a && . ./.env.local && set +a` before wrangler commands).
- D1: `npx wrangler d1 create deye` (or the dashboard: Storage & Databases → D1 → Create), then
  `npm run migrate:remote`.

## Access (Zero Trust)

The Worker serves the app, the read API and the ingest endpoint on one hostname. Access protects all of it except
`/api/ingest`, which the Pi calls with `PUSH_KEY`.

1. Zero Trust → on first use pick a team name and the Free plan (up to 50 users; asks for a payment method).
2. Access → Applications → Self-hosted, hostname `deye.<domain>`, empty path:
   policy **Allow** → the users' emails. Session duration about **1 month**, so the installed PWA does not bounce to the
   login page. Login method: one-time PIN to email is fine.
3. A second Self-hosted application for `deye.<domain>/api/ingest` with a **Bypass** policy (Include: Everyone).
4. Copy the first app's **Application Audience (AUD) tag** and the team domain (`https://<team>.cloudflareaccess.com`)
   into `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` and deploy. The Worker checks the Access JWT itself and answers 503 to
   everything except `/api/ingest` until both are set.
5. Optional: a service token for Home Assistant, see `docs/home-assistant.md`.

Without a custom domain, Access on `workers.dev` protects the whole Worker, so ingest would need a second Worker
without Access sharing the same D1. That layout is not set up in this repo.

## Free plan limits

- Workers Free: 100k requests/day. Ingest at 30 s is ~2,880/day, HA polling ~1,400/day. Fine.
- D1 Free: 500 MB per database, 5 GB total, 5 M rows read/day. `samples` grows ~100 MB/year at 30 s; read endpoints
  aggregate in SQL and history reads the hourly rollups.
- Solcast free: 10 calls per UTC day. The Worker plans 8 and counts them in D1.
