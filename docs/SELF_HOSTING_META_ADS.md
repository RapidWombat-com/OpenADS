# Self-hosted Meta Ads

_For OpenADS 0.0.1._

Connecting Meta Ads lets OpenADS read live campaign reports (spend, impressions,
clicks, conversions) for the Meta ad accounts you choose, straight from Meta's
Marketing API.

Every OpenADS instance uses **its own** Meta app. There is no shared OpenADS
app in between: Meta issues the access to your app, and the token is stored,
encrypted, in your instance's database.

> **The quickest path is in the app.** Open **Sources → Meta Ads → Set up Meta
> Ads**. The setup wizard walks through the steps below with buttons that open
> the right page of *your* app in the Meta App Dashboard (in a new tab), copy
> buttons for every value Meta asks for, and checks of what you paste. Its
> progress is saved, so you can leave and come back. This page is the same
> guide for reading on GitHub.

## What you'll need

- An OpenADS instance that is running, with `PUBLIC_ORIGIN`,
  `TOKEN_ENCRYPTION_KEY`, a D1 database and your address in
  `OPENADS_ADMIN_EMAILS` (see [Cloudflare self-hosting](./SELF_HOSTING_CLOUDFLARE.md)).
  The wizard tells you exactly what is missing.
- A Facebook account that can see your ad accounts (in Ads Manager, directly or
  through a business portfolio).
- About 10 minutes in [Meta for Developers](https://developers.facebook.com/apps/).

You do **not** need App Review, business verification or a privacy policy as
long as the app stays in **Development mode** and everyone who connects has a
role on the app (step 4). That is the intended setup for your own team.

## 1) Create a Meta app

Open [developers.facebook.com/apps/creation](https://developers.facebook.com/apps/creation/).
The first time, Meta asks you to register as a developer (confirm your
account, accept the terms).

1. **App details**: app name `OpenADS` and a contact email.
2. **Use cases**: **Measure ad performance data with Marketing API** (under
   *Ads and monetization*). **Create & manage ads with Marketing API** works
   too; both include `ads_read`. If neither is listed, choose **Other**, then
   app type **Business**.
3. **Business**: "I don't want to connect a business portfolio yet" is fine.
4. **Requirements**, **Overview** → **Go to dashboard**.

Meta adds **Facebook Login for Business** to the app automatically.

## 2) Note the App ID

The App ID is the number at the top of the App Dashboard (also under **App
settings → Basic**). It is not secret. The wizard asks for it once; every link
in the next steps then opens your app's page directly, for example
`https://developers.facebook.com/apps/<APP_ID>/settings/basic/`.

## 3) Facebook Login: redirect URI and domain

**Facebook Login for Business → Settings**
(`https://developers.facebook.com/apps/<APP_ID>/business-login/settings/`):

- Under **Client OAuth settings**, keep **Client OAuth login**, **Web OAuth
  login**, **Enforce HTTPS** and **Use Strict Mode for redirect URIs** on.
- Add your instance's origin plus `/api/oauth/meta/callback` to **Valid OAuth
  Redirect URIs**, then **Save changes**:

  | Instance | Valid OAuth Redirect URI |
  | --- | --- |
  | Deployed | `https://openads.example.com/api/oauth/meta/callback` |
  | Local (`preview:local -- --live`) | `http://127.0.0.1:8788/api/oauth/meta/callback` (Development mode only; if Meta refuses a loopback address, test Meta on your deployed instance) |

  It must be **exactly** `PUBLIC_ORIGIN` + `/api/oauth/meta/callback`: same
  scheme, host and port, no trailing slash. The wizard shows it with a copy
  button.

If your app's menu shows the classic **Facebook Login** product instead, use
its **Settings** page (`…/apps/<APP_ID>/fb-login/settings/`); the fields are the
same.

**App settings → Basic** (`…/apps/<APP_ID>/settings/basic/`):

- **App domains**: your instance's host name, e.g. `openads.example.com`.
- **Privacy policy URL** is required only to switch the app to *Live* mode. In
  Development mode you can leave it empty.
- **Save changes**.

## 4) Permission and people

OpenADS requests one permission: **`ads_read`**. It lists the ad accounts the
connecting person can read (`/me/adaccounts`, including ad accounts reached
through a business portfolio) and reads campaign Insights. It never calls a
write endpoint. `business_management` is not needed.

- **Use cases** (`…/apps/<APP_ID>/use_cases/`) → your Marketing API use case →
  **Customize**: `ads_read` is listed (required by the use case, "Ready for
  testing").
- **App roles → Roles** (`…/apps/<APP_ID>/roles/roles/`): in Development mode
  only people with a role on the app can connect. You are its Administrator.
  Add teammates who will connect as **Developer** (or Administrator); they
  accept at [developers.facebook.com/requests](https://developers.facebook.com/requests/).

Development mode with Meta's default **Limited access** tier (Meta renamed
"Standard Access" to "Limited access" and "Advanced Access" to "Full access")
is enough for your own team. Limited access is heavily rate-limited per ad
account, which is fine for OpenADS (one Insights request per selected ad
account and page, per report). App Review (Full access) is needed only to
connect ad accounts of people who have no role on your app.

## 5) Give OpenADS the App ID and App Secret

**In the app (recommended):** paste the App ID and App Secret (**App settings →
Basic → App secret → Show**; Meta asks for your password) in the wizard's
"Paste App ID and Secret" step. OpenADS checks the format (the App ID is
numeric, the App Secret 32 hexadecimal characters), encrypts the secret with
`TOKEN_ENCRYPTION_KEY` and stores it in D1. It never shows the secret again,
only "Saved • ends with …abcd" with **Replace** and **Remove**. No redeploy.

**Or in the deployment:** when both are set they take precedence, and the
wizard shows "Managed by the deployment".

| Name | Kind | Value |
| --- | --- | --- |
| `META_APP_ID` | var, optional | App ID from step 2. |
| `META_APP_SECRET` | secret, optional | App Secret (32 hex characters). |
| `META_API_VERSION` | var, optional | Graph API version; defaults to the version pinned by this release (`v27.0`). |
| `META_CONVERSION_ACTION_TYPE` | var, optional | Exact action type counted as conversions; otherwise chosen on the Sources page (default `purchase`). |

With `npm run deploy:cloudflare`, put `META_APP_ID` and (optionally)
`META_APP_SECRET` in `deploy/.env.cloudflare`; the secret is uploaded encrypted
with the deploy and never printed.

## 6) Connect

Open **Sources → Meta Ads → Connect Meta Ads** (or the wizard's last step),
continue with the Facebook account that can see your ad accounts and keep
`ads_read` allowed. OpenADS exchanges the code for a **long-lived token**
(about 60 days), checks it was issued to your app and that `ads_read` was
granted, then lists the ad accounts:

- one open ad account: it is selected and the report opens;
- several: pick the ones to report on (up to 25) and choose **Show report**.
  Disabled, closing and closed ad accounts are listed apart and cannot be
  selected.

Change the selection later under **Sources → Meta Ads → Choose ad accounts**.

### Conversions

Meta reports many action types. OpenADS counts **one exact `action_type`** as
"conversions" (never a sum of several): choose it on the Meta Ads card under
**Count as conversions** (Purchases `purchase` by default; Website purchases,
Leads, Registrations, … or any other exact type such as
`offsite_conversion.custom.<id>`). `META_CONVERSION_ACTION_TYPE` overrides it.

### Every ~60 days: reconnect

Meta's long-lived user tokens expire after about 60 days (and data access
after 90 days without a new login). The Sources card shows **Reconnect before
<date>**; from 7 days before, the card and the dashboard show a warning with a
one-click **Reconnect Meta Ads**. Reconnecting the same Facebook account keeps
the selected ad accounts. Signing in as a different Facebook user changes
nothing until an admin confirms it on Sources (within 10 minutes): ad accounts
both users can access keep their selection and project, the others are listed
and removed only on confirm; **Cancel** keeps the current connection. After
expiry, Meta figures show "—" (never zero) until someone reconnects.

## How it works

- Facebook Login (server-side code flow) with your app: a one-time, 10-minute
  state bound to your sign-in, `scope=ads_read`, `response_type=code`.
- Code → short-lived token → `debug_token` on that short-lived token (it must
  belong to your App ID) → long-lived token (`grant_type=fb_exchange_token`;
  both exchanges are POSTs, so the App Secret is never in a URL, and the stored
  long-lived token never appears in any URL), `/me/permissions`
  (`ads_read` must be granted). Every Graph call made with the user token
  carries `appsecret_proof`, so you can turn on **Require App Secret**
  (App settings → Advanced).
- The token is stored in D1 **encrypted at rest** with `TOKEN_ENCRYPTION_KEY`
  (AES-256-GCM, bound to its workspace and connection), with its expiry. The
  App Secret is stored the same way when entered in the wizard. Neither ever
  reaches the browser or the logs.
- Reports are read live from Insights (`/act_<id>/insights`, campaign level),
  one request per selected ad account, in that account's own timezone and
  currency; OpenADS stores no report data.
- Disconnecting asks Meta to remove the app's access (`DELETE /me/permissions`)
  and deletes the stored token.

## Troubleshooting

When OpenADS can tell what went wrong, it opens the wizard step that fixes it.

**"URL blocked: This redirect failed because the redirect URI is not
whitelisted…"** (Facebook's page) — the Valid OAuth Redirect URI does not
match character for character, or Client/Web OAuth login is off. Fix it in
Facebook Login for Business → Settings, save, wait a minute, try again. If the
URI the wizard shows is not where you opened OpenADS, `PUBLIC_ORIGIN` is set to
another address.

**"Can't load URL: The domain of this URL isn't included in the app's
domains"** — add the host name under App settings → Basic → App domains.

**"App not active" / "This app isn't available"** (Facebook's page) — the
Facebook account you used has no role on the app (Development mode), or has
not accepted the invitation yet. Add it under App roles (step 4).

**"Meta rejected the App ID or App Secret"** — the secret does not belong to
the App ID, or was reset. Paste both again (step 5).

**"`ads_read` was not allowed"** — you turned the permission off in
Facebook's dialog. Nothing was stored; the wizard asks again
(`auth_type=rerequest`).

**"No ad accounts to report on"** — the Facebook account has no open ad
account it can read. If your ad accounts belong to a business portfolio, ask
its admin to add you in Meta Business Suite → Settings → Users → People →
Assign assets → Ad accounts (View performance is enough), then **Reload list**.

**"Meta Ads access expired"** — the long-lived token reached its ~60-day
expiry, your Facebook password changed, or the app was removed from your
account (Settings → Business integrations). **Reconnect**.

**"Meta Ads is not set up on this instance"** — no usable Meta app: finish the
wizard, or set both `META_APP_ID` and `META_APP_SECRET`.
