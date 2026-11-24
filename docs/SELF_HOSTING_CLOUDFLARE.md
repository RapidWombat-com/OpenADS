# Cloudflare self-hosting

_For OpenADS 0.0.1. Deployment is manual, from your machine: the repository has
no CI/CD._

Run your own OpenADS on Cloudflare Workers with one command. OpenADS has no
login of its own: **Cloudflare Access** signs people in and checks every request
(pages, API and static files) before it reaches OpenADS, and OpenADS verifies
Access's signed token again on every request. Data lives in a D1 database in
your account. The Workers free plan and Zero Trust's free tier (up to 50 users)
are enough.

The instance is yours: your Cloudflare account, your Access policy and your own
Google Cloud project ([Google Ads guide](./SELF_HOSTING_GOOGLE_ADS.md)). Nothing
in OpenADS is tied to another deployment.

## What you need

- **Node 26.13 or newer** and npm.
- **A Cloudflare account with your domain** (for example `example.com`) as a zone
  on that account. OpenADS gets a host name in it, such as `openads.example.com`.
- **A Zero Trust organization** (Zero Trust in the dashboard → get started; you
  choose a team name, which gives you `your-team.cloudflareaccess.com`).
- **A Cloudflare Access application** for that host name (step 2). The deploy
  does not create it.

## 1) Get the code and log in

```sh
git clone https://github.com/RapidWombat-com/OpenADS.git
cd OpenADS
npm ci --ignore-scripts
npx wrangler login
```

(Or set `CLOUDFLARE_API_TOKEN`: a token from the "Edit Cloudflare Workers"
template, with **D1: Edit** added, for that account and zone.)

## 2) Create the Cloudflare Access application

In **Zero Trust → Access → Applications → Add an application → Self-hosted**:

1. **Application domain**: your host name, e.g. `openads.example.com`, with **no
   path**, so the whole host name is covered: pages, `/api/*`, `/assets/*` and
   unknown paths.
2. **Policy**: **Allow**, Include **Emails** (exact addresses) and/or **Emails
   ending in** (`@example.com`). Do not add Bypass or Everyone policies.
3. **Login methods**: One-time PIN works out of the box; add Google or another
   identity provider if you like.
4. Save, then copy the application's **Audience (AUD) tag** from its overview.

You can create it before the host name exists; the deploy attaches the host name
to the Worker.

## 3) Fill in the deploy settings

```sh
cp deploy/.env.cloudflare.example deploy/.env.cloudflare
```

Edit `deploy/.env.cloudflare` (ignored by git) and make it readable only by you
(the deploy warns otherwise; it can hold secrets such as `META_APP_SECRET`):

```sh
chmod 600 deploy/.env.cloudflare
```

| Setting | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Your account ID (32 hex characters; dashboard → Account home → ⋮ → Copy account ID). |
| `OPENADS_HOSTNAME` | The host name from step 2, e.g. `openads.example.com`. Must be in a zone of that account. OpenADS's address becomes `https://<host name>`. |
| `ACCESS_TEAM_HOSTNAME` | Your team domain, bare: `your-team.cloudflareaccess.com`. |
| `ACCESS_AUDIENCE` | The AUD tag from step 2. |
| `ACCESS_ALLOWED_EMAILS` | Who may use OpenADS, the same people as the Access policy: comma-separated exact addresses (`you@example.com`) and/or whole domains (`@example.com`). |
| `OPENADS_ADMIN_EMAILS` | Exact addresses of the admins, who set up Google Ads and connect sources. Each must be allowed above. Everyone else can view reports. |
| `OPENADS_WORKER_NAME`, `OPENADS_D1_NAME` | Optional; both default to `openads`. |
| `GOOGLE_API_VERSION` | Optional; defaults to the Google Ads API version pinned by this release. |
| `META_APP_ID`, `META_APP_SECRET` | Optional: your Meta app from the deployment instead of the in-app wizard ([Meta Ads](SELF_HOSTING_META_ADS.md)); the secret is uploaded as an encrypted secret, never printed. |
| `META_API_VERSION`, `META_CONVERSION_ACTION_TYPE` | Optional: Graph API version (default pinned by this release) and the exact action type counted as conversions (otherwise chosen on Sources). |

No other secrets go in this file: the deploy generates `TOKEN_ENCRYPTION_KEY`
itself, and Google Ads and Meta Ads are set up in the app. (`TOKEN_ENCRYPTION_KEY`
is accepted only to restore a lost key: see [The encryption key](#the-encryption-key).) The settings of the
former operator-configured Meta account (`META_ACCOUNT_ID`, `META_ACCESS_TOKEN`)
are refused with a pointer to Sources → Set up Meta Ads.

## 4) Deploy

Check first; this makes no changes:

```sh
npm run deploy:cloudflare -- --plan
```

Then deploy:

```sh
npm run deploy:cloudflare
```

It:

1. **Checks** Node, your Cloudflare login (`wrangler whoami`), that the account is
   one you can use, and every setting with OpenADS's own validation (so a value the
   app would refuse fails here, in seconds).
2. **Finds or creates** the D1 database (`wrangler d1 list` / `d1 create`).
3. **Writes a private deployment config**, `.openads/wrangler.deploy.jsonc` (mode
   0600 in a 0700 directory, not tracked by git), from `wrangler.jsonc` and your settings: account, Worker name,
   the D1 binding with its real ID, the vars, a custom domain for your host name,
   and the protective defaults `workers_dev: false`, `preview_urls: false`, assets
   served through the Worker.
4. **Builds** with that config (`OPENADS_WRANGLER_CONFIG`), which produces
   `dist/server/wrangler.json` (a copy of your settings, like everything in
   `.openads/`: both are then made private, mode 0600 (`.openads/` itself 0700);
   `dist/` is not tracked by git).
5. **Applies database migrations** remotely (`wrangler d1 migrations apply DB
   --remote`), only the ones not applied yet.
6. **Checks secrets** (`wrangler secret list`). If the Worker has no
   `TOKEN_ENCRYPTION_KEY` (first deploy), it first checks the existing D1 database
   read-only for data encrypted with an earlier key (and stops if there is any; see
   [The encryption key](#the-encryption-key)), then generates 32 random bytes and
   uploads them **with** the deploy through a private temporary file (mode 0600,
   deleted right after; never in arguments or output). Right before the upload it
   lists the secrets again and stops, without overwriting anything, if a key
   appeared meanwhile, and **claims the key's id in D1** (first deploy wins, see
   below); if another deploy already claimed a different key, it stops before
   deploying anything. A copy goes to a new
   `.openads/TOKEN_ENCRYPTION_KEY.<worker>.<UTC timestamp>.backup` (mode 0600, not
   tracked by git; an existing backup is never overwritten) for you to back up. If
   the key exists, it is left untouched. If the secrets cannot be listed, it stops
   rather than risk replacing the key.
7. **Deploys** (`wrangler deploy -c dist/server/wrangler.json`) and attaches the
   custom domain.
8. **Verifies** that `https://<host name>/` and `/api/campaigns.json` do not answer
   without signing in: a redirect to `*.cloudflareaccess.com` is the expected
   result. If OpenADS itself answers 401/403, the Access application does not cover
   the host name yet (nothing is exposed, but nobody can sign in). A 200 fails the
   deploy.

Run it again after changing settings or pulling a new version: it reuses the
database and the key and only updates code, vars and migrations. Vars set in the
Cloudflare dashboard are replaced by the ones from your settings file.

**Do not run two deploys at once** (from two terminals, two checkouts or two
machines): on a first deploy each could generate a different key. Two guards stop
that:

- **Same checkout:** a deploy holds `.openads/deploy.lock` (pid, host and start
  time) while it runs, so a second one stops at once. A lock whose process is
  still running on this machine is never taken over, however long the deploy
  takes. A lock left by an interrupted deploy is replaced once its process is
  gone (a lock from another machine, whose process cannot be checked, after 30
  minutes); you can also delete it yourself when no deploy is running.
- **Other checkouts or machines:** right before uploading a new
  `TOKEN_ENCRYPTION_KEY`, a deploy records the key's id (not the key) in the D1
  table `instance_meta` with `INSERT … WHERE NOT EXISTS` and reads it back. Only
  the first deploy's id is stored; any other deploy sees a different id and
  stops before deploying code or uploading its key, with the winning key id. Use
  the winning key: it is in the `.openads/TOKEN_ENCRYPTION_KEY.<worker>.*.backup`
  file of the checkout that claimed it; add it to your settings file as
  `TOKEN_ENCRYPTION_KEY` and run again (its id must match), then remove it from
  the file. The same happens if an earlier deploy stopped after claiming its key
  (for example, the custom domain failed): put that deploy's backed-up key in the
  settings file. Only if no deploy is running and nobody has the claimed key any
  more, clear the claim with `npx wrangler d1 execute <database> --remote --command
  "DELETE FROM instance_meta WHERE key = 'token_key_id'"` (`--reset-encrypted-data`
  clears it too).

Wrangler runs with `WRANGLER_LOG_SANITIZE=true`, `WRANGLER_WRITE_LOGS=false` and
`WRANGLER_LOG=log` (its default level), whatever your shell sets: debug logging can
include the uploaded secrets, and quieter levels hide the JSON output the deploy
reads.

Flags: `--plan` (show everything it would do, change nothing; it still reads your
login, databases and secret names), `--plan --offline` (do not contact Cloudflare
at all), `--env-file <path>` (another settings file), `--reset-encrypted-data`
and `--yes` (see below).

### The encryption key

`TOKEN_ENCRYPTION_KEY` encrypts everything secret that OpenADS stores in D1: the
Google OAuth client secret, the Meta App Secret and the Google/Meta grants. Never
change or delete it: a new key means entering the secrets again and reconnecting.

**Back it up.** Cloudflare never shows a secret again. After the first deploy, store
the copy in `.openads/TOKEN_ENCRYPTION_KEY.<worker>.<timestamp>.backup` in your
password manager and delete the file; do not keep the key in the env file or
anywhere unencrypted. (Or generate the key yourself before the first
deploy, `openssl rand -base64 32`, keep it in the password manager and put it in
the env file as `TOKEN_ENCRYPTION_KEY` for that one deploy.)

If the Worker is deleted or recreated (or its secret removed) while the D1 database
still holds encrypted data, the deploy refuses to generate a new key, which could
not read that data, and stops with the details. Then either:

- **restore the key**: add `TOKEN_ENCRYPTION_KEY=<the old key>` to
  `deploy/.env.cloudflare` and deploy again. It is uploaded through the same
  private temporary file, only if the Worker has no key and only if it is the key
  the stored data was encrypted with (key ids are compared). Keep the file
  `chmod 600` while it holds the key, and remove the key from it afterwards (it
  belongs in your password manager). A Worker that has a key never gets another one from the file; or
- **start over**: `npm run deploy:cloudflare -- --reset-encrypted-data`. After you
  type `yes` (or with `--yes`), it deletes the stored Google/Meta connections (and
  so their accounts' project assignments) and the stored Google OAuth client secret
  and Meta App Secret, then generates a new key. Projects, members and setup
  progress stay; set up the secrets and reconnect in the app.

## 5) Set up Google Ads

Open `https://openads.example.com`, sign in through Access, then **Sources →
Google Ads → Set up Google Ads**. The wizard walks you through your own Google
Cloud project and OAuth client (redirect URI
`https://openads.example.com/api/oauth/google/callback`) and ends with **Connect
Google Ads**. The same steps are in [the Google Ads guide](./SELF_HOSTING_GOOGLE_ADS.md).

## Verification checklist

- [ ] The deploy's last step shows "protected by Cloudflare Access" for `/` and
      `/api/campaigns.json`.
- [ ] `curl -sI https://openads.example.com/assets/anything.js` → a redirect to
      `your-team.cloudflareaccess.com`, not the file.
- [ ] An allowed address signs in and sees **Overview**; an address outside the
      policy is refused by Access.
- [ ] Workers → your Worker → Settings → Domains & Routes lists only your custom
      domain: no `workers.dev` and no preview URLs.
- [ ] The setup wizard shows no "instance settings" warnings.
- [ ] After connecting, a 7-day report matches the Google Ads UI for the same
      dates (each account's timezone).

## Adding people

Add them to the Access policy **and** to `ACCESS_ALLOWED_EMAILS`, then run
`npm run deploy:cloudflare` again. They join as members on their first visit. To
make someone an admin, also add them to `OPENADS_ADMIN_EMAILS`.

## Updating

Read [`CHANGELOG.md`](../CHANGELOG.md) for the new version, then:

```sh
git pull
npm ci --ignore-scripts
npm run deploy:cloudflare
```

## Troubleshooting

- **"Wrangler is not logged in"** — run `npx wrangler login`, or set
  `CLOUDFLARE_API_TOKEN`.
- **"… is not one of the accounts this login can use"** — `CLOUDFLARE_ACCOUNT_ID`
  is wrong or your login has no access to that account; the error lists the
  accounts it can use.
- **The deploy fails on the custom domain** — `OPENADS_HOSTNAME` must be in a zone
  of that account, and no other Worker or DNS record may already own it.
- **"not reachable yet"** after deploying — a new custom domain can take a few
  minutes for DNS and its certificate; open it again shortly.
- **"refused by OpenADS itself (401/403)"** — Access is not in front of the host
  name: check the application domain (whole host name, no path).
- In the app: **"Access is not configured."** (503) — an `ACCESS_*` value is wrong;
  **"Unauthorized."** (401) after signing in — `ACCESS_AUDIENCE` is not this
  application's AUD tag; **"Forbidden."** (403) — the email is not in
  `ACCESS_ALLOWED_EMAILS` (domain entries match that exact domain only).
- Google Ads problems: see [the Google Ads guide](./SELF_HOSTING_GOOGLE_ADS.md#troubleshooting).

## Deploying by hand

The command only wraps Wrangler. To do the same yourself: create the D1 database,
write a private config like the one in step 4 (or let `--plan` print it), build
with `OPENADS_WRANGLER_CONFIG=<config> npm run build`, run
`npx wrangler d1 migrations apply DB --remote -c <config>`, set the key once with
`openssl rand -base64 32 | npx wrangler secret put TOKEN_ENCRYPTION_KEY --name <worker>`
(after the first deploy; keep a copy of the key, see above), and deploy with
`npx wrangler deploy -c dist/server/wrangler.json`. Keep `WRANGLER_LOG` below
`debug` when secrets are involved.
