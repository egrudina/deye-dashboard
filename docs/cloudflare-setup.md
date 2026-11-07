# Cloudflare setup (done manually by the user)

Wrangler on this Mac is logged into a **different** CF account. Don't run `wrangler login`/`logout` without asking.
Recommended: use an **API token** for the target account, so the existing login stays untouched.

## What to ask the user for

1. **Account ID** of the target account (dashboard → Workers & Pages → right sidebar, or any zone's overview page).
2. **API token** for that account: My Profile → API Tokens → Create Token → template **"Edit Cloudflare Workers"**,
   then add the permission **Account › D1 › Edit** and limit it to the target account.
   The user keeps it locally (never in git), e.g. in `cloud/.env.local` (gitignored), and exports it:
   ```sh
   export CLOUDFLARE_API_TOKEN=...   CLOUDFLARE_ACCOUNT_ID=...
   ```
   With these set, `wrangler deploy`, `wrangler d1 …` and `wrangler secret put` use the target account.
3. **Domain:** is there a domain on this account? (Decides the Access layout, see architecture.md.)
4. **D1 database:** the user can create it in the dashboard (Storage & Databases → D1 → Create → name `deye`),
   or let wrangler create it with the token. We need the `database_id` for `wrangler.jsonc`.
5. **PUSH_KEY:** generate with `openssl rand -hex 32`. Store it as a Worker secret (`wrangler secret put PUSH_KEY`, or
   dashboard → Worker → Settings → Variables and Secrets) and in the Pi's `pusher/push.env`. Never commit it.
6. **Cloudflare Access (Zero Trust):** dashboard → Zero Trust. On first use: choose a team name, Free plan
   (asks for a payment method, but it's free for up to 50 users). Then Access → Applications → Self-hosted:
   - custom domain: app `deye.<domain>`, policy Allow → user's email; second app/path `deye.<domain>/api/ingest` → **Bypass**.
   - workers.dev: enable Access on the `deye-app` Worker (Settings → Domains & Routes → workers.dev → Enable Cloudflare Access),
     keep `deye-ingest` public (key-protected).
   Login method: one-time PIN to email (default) is fine.
   Then copy the app's **Application Audience (AUD) tag** and the team domain (`https://<team>.cloudflareaccess.com`)
   into `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` in `cloud/wrangler.jsonc`. The Worker checks the Access JWT itself and
   answers 503 to everything except `/api/ingest` until both are set (fail closed).

## Free plan limits to keep in mind

- Workers Free: 100k requests/day. We use ~2,880 ingest/day at 30 s, or fewer with batching. Fine.
- D1 Free: 500 MB per database, 5 GB total, 5 M rows read/day. Read endpoints must aggregate in SQL
  (e.g. bucket by minute or hour) instead of returning raw rows for long ranges.
