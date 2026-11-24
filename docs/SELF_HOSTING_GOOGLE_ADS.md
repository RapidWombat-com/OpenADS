# Self-hosted Google Ads

_For OpenADS 0.0.1._

Connecting Google Ads lets OpenADS read live campaign reports (spend, impressions,
clicks, conversions) for the ad accounts you choose, straight from Google.

Every OpenADS instance uses **its own** Google Cloud project and OAuth client.
There is no shared OpenADS app in between: Google issues the access to your
project, and the grant is stored, encrypted, in your instance's database.

> **The quickest path is in the app.** Open **Sources → Google Ads → Set up
> Google Ads**. The setup wizard walks through the steps below with links that
> open the right Google Cloud page for your project, copy buttons for every
> value Google asks for, and checks of what you paste. Its progress is saved,
> so you can leave and come back. This page is the same guide for reading on
> GitHub.

## What you'll need

- An OpenADS instance that is running, with `PUBLIC_ORIGIN`,
  `TOKEN_ENCRYPTION_KEY`, a D1 database and your address in
  `OPENADS_ADMIN_EMAILS` (see [Cloudflare self-hosting](./SELF_HOSTING_CLOUDFLARE.md)
  or [Run it locally](#run-it-locally)). The wizard tells you exactly what is
  missing.
- A Google account that can see your Google Ads accounts (directly or through
  a manager account).
- About 10 minutes in the [Google Cloud console](https://console.cloud.google.com/).

## 1) Create a Google Cloud project, enable the Google Ads API and apply for Explorer access

1. [Create a project](https://console.cloud.google.com/projectcreate) for
   OpenADS (or pick an existing one) and note its **project ID** (for example
   `openads-123456`, not its display name). The wizard asks for it once, then
   opens every Google Cloud link in that project (`?project=<id>`).
2. [Enable the Google Ads API](https://console.cloud.google.com/flows/enableapi?apiid=googleads.googleapis.com).
   Enabling it gives the project **Test** access, which only reaches test
   accounts.
3. Open the [Google Ads API Overview](https://console.cloud.google.com/google/ads-apis/overview),
   expand **Upgrade access level** and apply for **Explorer** access. Google
   reviews it automatically and approves most projects right away.

| Access level | Reaches | Daily operations |
| --- | --- | --- |
| Test | test accounts only | 15,000 |
| **Explorer** | test and production accounts | **2,880 on production accounts** |
| Basic | test and production accounts | 15,000 (needs Google's brand verification) |

Explorer is enough for OpenADS: a report uses about one operation per selected
account (plus one per result page), and connecting uses a few more to list
accounts. Explorer only restricts account management, billing and planning
features, which OpenADS does not use. Google sunset developer tokens on
September 9, 2026: access levels now belong to the Cloud project, and OpenADS
needs no developer token.

## 2) Set up the Google Auth Platform (consent screen)

Open the [Google Auth Platform](https://console.cloud.google.com/auth/overview).
If it says "Google Auth platform not configured yet", click **Get started**.

- **[Branding](https://console.cloud.google.com/auth/branding)**: app name
  `OpenADS`, a user support email and a developer contact email. For a deployed
  instance, add its registrable domain (for example `example.com` for
  `https://openads.example.com`) under **Authorized domains**.
- **[Audience](https://console.cloud.google.com/auth/audience)**: user type
  **External** (unless everyone who connects is in your Google Workspace
  organization). While the app is in **Testing**, add every Google account that
  will connect under **Test users**; otherwise Google blocks sign-in with
  `access_denied`.
- **[Data access](https://console.cloud.google.com/auth/scopes)**: **Add or
  remove scopes**, paste `https://www.googleapis.com/auth/adwords` under
  "Manually add scopes", **Add to table**, **Update**, **Save**. (OpenADS also
  asks for `openid` and `email` to show which Google account is connected.)

Then, back on **Audience**, click **Publish app** so the status is **In
production**. Google expires refresh tokens of External apps in Testing after
**7 days**, so a Testing app disconnects Google Ads every week.

You don't need Google's verification for your own or internal use: until the
app is verified, Google's sign-in shows "Google hasn't verified this app";
choose **Advanced → Go to OpenADS** to continue. Verification (the Ads scope
requires it) matters only if you open the instance to people outside your team.

Google Ads has no read-only OAuth scope: what OpenADS can do is limited by the
connected Google user's role in each ad account. OpenADS itself only ever
reads reports.

## 3) Create an OAuth client

Open [**Clients**](https://console.cloud.google.com/auth/clients) → **Create
client**:

1. Application type: **Web application**. Name: `OpenADS`.
2. Under **Authorized redirect URIs**, add your instance's origin plus
   `/api/oauth/google/callback`:

   | Instance | Redirect URI |
   | --- | --- |
   | Deployed | `https://openads.example.com/api/oauth/google/callback` |
   | Local | `http://localhost:8788/api/oauth/google/callback` |

   It must be **exactly** `PUBLIC_ORIGIN` + `/api/oauth/google/callback`: same
   scheme (`https`; plain `http` only for `localhost`), host and port, no
   trailing slash. Google rejects raw IP addresses (except loopback). No
   authorized JavaScript origin is needed. The wizard shows the exact URI with
   a copy button.
3. **Create**, then copy the **Client ID** and **Client secret**. Google shows
   the secret only once (later only its last four characters); if you lose it,
   add a new secret to the client.

## 4) Give OpenADS the client and its keys

**In the app (recommended):** paste the Client ID and secret in the wizard's
"Paste Client ID and secret" step. OpenADS checks the format (the ID ends with
`.apps.googleusercontent.com`), encrypts the secret with
`TOKEN_ENCRYPTION_KEY` and stores it in D1. It never shows the secret again,
only "Saved • ends with …abcd" with **Replace** and **Remove**. No redeploy is
needed.

**Or in the deployment:** set the client as environment settings. When both are
set they take precedence, and the wizard shows "Managed by the deployment".

| Name | Kind | Value |
| --- | --- | --- |
| `PUBLIC_ORIGIN` | var, required | Your instance's exact origin, e.g. `https://openads.example.com` (local: `http://localhost:8788`). |
| `OPENADS_ADMIN_EMAILS` | var, required | Comma-separated exact addresses of the instance admins (who may set up and connect sources). |
| `TOKEN_ENCRYPTION_KEY` | secret, required | Base64 of exactly 32 random bytes: `openssl rand -base64 32` (the Cloudflare deploy command generates it). Encrypts the client secret and Google grants. Keep it: a new key means reconnecting. |
| `GOOGLE_OAUTH_CLIENT_ID` | var, optional | Client ID from step 3 (instead of the wizard). |
| `GOOGLE_OAUTH_CLIENT_SECRET` | secret, optional | Client secret from step 3 (instead of the wizard). |
| `GOOGLE_API_VERSION` | var, optional | Google Ads API version; defaults to the version pinned by this OpenADS release (`v26`). |
| `GOOGLE_DEVELOPER_TOKEN` | secret, optional | Leave unset. Only for projects that still use a developer token. |

Generate the key with:

```sh
openssl rand -base64 32
```

On Cloudflare you don't need to: `npm run deploy:cloudflare` generates it on the
first deploy and never replaces it ([Cloudflare self-hosting](./SELF_HOSTING_CLOUDFLARE.md)).

## 5) Connect

Open **Sources → Google Ads → Connect Google Ads** (or the wizard's last step),
sign in with the Google account that can see your ad accounts and allow access.
OpenADS lists the accounts it can read, including the client accounts under a
manager account:

- one account: it is selected and the report opens;
- several: pick the ones to report on (up to 25) and choose **Show report**.

Change the selection later under **Sources → Google Ads → Choose accounts**.

## Run it locally

Use the local harness, which signs you in the way Cloudflare Access would (a
locally signed Access token for your address; there is no sign-in bypass in the
app) and, with `--live`, keeps a local D1 database and its generated key in
`.wrangler/preview-live/` (owner-only, separate from the fixture runs' `.wrangler/preview/`):

```sh
npm ci --ignore-scripts
npm run preview:local -- --live --email you@example.com
```

It listens on `127.0.0.1` only and prints a **one-time sign-in link**,
`http://127.0.0.1:8788/?preview_token=…`: open it (it sets an HttpOnly,
SameSite=Strict cookie, `openads_preview_8788`, for this run and port; any request without it gets 401, so other
local users, processes and web pages cannot use your grants). Then **Sources →
Set up Google Ads**, and register `http://127.0.0.1:8788/api/oauth/google/callback`
on your OAuth client (you can add it next to your deployed instance's URI on the
same client). `--live` lets the Worker reach Google's OAuth and Google Ads API
hosts and Meta's Graph API host only (for Meta, add
`http://127.0.0.1:8788/api/oauth/meta/callback` to your Meta app; see
[Meta Ads](./SELF_HOSTING_META_ADS.md)). Restart the harness for a new link. The harness
generates a `TOKEN_ENCRYPTION_KEY` on first run and keeps it next to the local
database; set `TOKEN_ENCRYPTION_KEY` (and optionally `GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET`) in your shell to use your own. Use `--port` to
change the port (and the redirect URI with it).

## How it works

- OpenADS runs the OAuth web-server flow with your client: a one-time,
  10-minute state bound to your sign-in, PKCE, offline access and a consent
  prompt so Google returns a refresh token.
- The refresh token is stored in D1, **encrypted at rest** with
  `TOKEN_ENCRYPTION_KEY` (AES-256-GCM, bound to its workspace and connection).
  The client secret is stored the same way when entered in the wizard. Neither
  ever reaches the browser or the logs.
- Reports are read live from the Google Ads API (`googleAds:search`, read-only)
  in each account's own timezone; OpenADS stores no report data.
- Disconnecting revokes the grant at Google and deletes it.

## Troubleshooting

When OpenADS can tell what went wrong, it opens the wizard step that fixes it.

**`redirect_uri_mismatch` on Google's page** — the redirect URI on your OAuth
client must equal `PUBLIC_ORIGIN` + `/api/oauth/google/callback` exactly.
Re-check `http` vs `https`, host, port and that there is no trailing slash. If
the URI the wizard shows is not where you opened OpenADS, `PUBLIC_ORIGIN` is set
to another address. Changes on Google's side can take a minute.

**`access_denied` after signing in** — you cancelled, or the app is in Testing
and that Google account is not a test user. Add it under **Audience → Test
users**, or publish the app.

**"Google rejected the OAuth client" (`invalid_client`)** — the Client ID and
secret don't match a client in your project, or the secret was rotated. Paste
both again (wizard step "Paste Client ID and secret").

**"Your project only has Test access"
(`CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION`)** — the project can only reach
test accounts. Apply for Explorer access on the
[Google Ads API Overview](https://console.cloud.google.com/google/ads-apis/overview),
then **Load accounts** in the wizard's last step. (API versions up to v24
report this as `ACTION_NOT_PERMITTED`.)

**Explorer is shown, but requests still fail with an authorization error** —
there have been reports of projects whose Overview page already shows
Explorer while API calls keep returning an `AuthorizationError` for a while.
OpenADS cannot fix this side: wait and retry **Load accounts**; if it persists,
contact Google Ads API support from the Overview page with the time of the
failure.

**"The Google Ads API is not enabled" (`SERVICE_DISABLED`)** — enable the API
in the project that owns your OAuth client, wait a minute, then **Load
accounts** again.

**"Google Ads access expired" / Reconnect (`invalid_grant`)** — the grant was
revoked, the Google password changed, or the app is still in Testing (7-day
expiry). Publish the app if needed, then **Reconnect**.

**Google Ads disconnects every week** — the app is still in Testing. Publish it
under **Audience → Publish app**, then reconnect once.

**"No ad accounts to report on"** — the Google account you connected has no
enabled client account it can read. Connect with another Google account, or ask
to be added to an ad account in Google Ads.

**"You signed in with another Google account"** — Reconnect used a different
Google account than the current connection. Nothing was replaced: Sources
lists what switching keeps (accounts both Google accounts can access keep their
selection and project) and removes (the others). Choose **Switch to …** within
10 minutes, or **Cancel** to keep the current connection.

**"Google Ads is not set up on this instance"** — no usable OAuth client:
finish the wizard, or set both `GOOGLE_OAUTH_CLIENT_ID` and
`GOOGLE_OAUTH_CLIENT_SECRET`. The wizard also flags a missing `PUBLIC_ORIGIN`,
`TOKEN_ENCRYPTION_KEY` or database with the command that fixes it.
