# Developing OpenADS

_OpenADS 0.0.1 (`package.json` `version`; shown in the sidebar footer, injected at
build time as `__OPENADS_VERSION__` by `vite.config.ts`). Changes are listed in
[`CHANGELOG.md`](../CHANGELOG.md). There is no CI: run the checks below before
every pull request._

This document is for development. To run your own instance, see
[Cloudflare self-hosting](SELF_HOSTING_CLOUDFLARE.md),
[Google Ads](SELF_HOSTING_GOOGLE_ADS.md) and [Meta Ads](SELF_HOSTING_META_ADS.md).

## Stack and checks

TanStack Start 1.169.7 (`@tanstack/react-start`), TanStack Router 1.170.46,
React 19.3.1, Vite 8.3.8, `@cloudflare/vite-plugin` 1.70.1, Wrangler 4.165.0 and
jose 6.2.18 are exact npm pins. The dashboard adds TanStack Query 5.108.4,
Base UI 1.9.0, Tailwind CSS 4.3.5 (`@tailwindcss/vite`), tw-animate-css 1.4.0,
class-variance-authority 0.7.1, `cn` 0.5.2 and lucide-react 1.79.0; Playwright
1.65.0 is a devDependency for local screenshots only. Node 26.13.x; npm 11.20.0;
`package-lock.json`. Install packages only from https://registry.npmjs.org/.

```sh
npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/
npm test
npm run build
npm run test:integration
WRANGLER_SEND_METRICS=false npm run dry-run
```

These commands do not provision accounts, upload secrets or deploy. No dev server
is required. Unit and integration tests run D1 queries against the real
migrations on an in-memory `node:sqlite` database (`tests/helpers/d1.ts`, test
only); the local preview uses a Miniflare D1 (below). Wrangler uses the deployment configuration that the Cloudflare Vite
plugin generates in `dist/server/` during the build. Regenerate binding declarations after changing configuration:
`WRANGLER_SEND_METRICS=false npx --no-install wrangler types src/worker-configuration.d.ts --strict-vars=false --include-main-module=false`.
Provider helpers consume narrow optional configuration views; deployed secrets
are not inferred from local credential files.

The TanStack Worker passes bindings per request with
`start.fetch(request, { context: { cloudflare: { env } } })`; server routes read
`context.cloudflare.env`, not the runtime-only `cloudflare:workers` module.
`npm run test:integration` invokes the built Worker in Node without a server,
checking Access (503/401/403 before any route or asset, for JSON and HTML
requests, GET and POST, including every Sources, OAuth and Projects route), root
JSON/HTML, the Sources and Projects pages, the CSP and nonces, the full Google connect flow
against a fake Google (start → consent → callback → picker → report → revoked →
disconnect), the full Meta connect flow against a fake Meta (start → dialog →
callback → picker → Google + Meta report → project-scoped reports → expired
token → reconnect → disconnect), both setup wizards, member and cross-origin rejections, reporting,
assets, 404s and unsupported methods. The reporting endpoint returns 405 with `Allow: GET, HEAD`
for unsupported methods; POST-only endpoints return 405 with `Allow: POST`.

`protect()` passes the verified Access identity (JWT `email`, ASCII-lowercased,
and `sub`) to the Worker, which forwards it to Start as request context
(`identity`). Routes read identity only from there, never from headers.

## Dashboard UI

`GET /` with `Accept: text/html` server-renders a hydrated dashboard
(`src/client/`, `src/routes/index.tsx`). Its design system is ported from
OpenSEO: Tailwind v4 tokens, shadcn components on Base UI (composed with
`render`, not `asChild`), lucide icons, light/dark/system theme and an
off-canvas sidebar that becomes a sheet below 768px. Ported files name their
origin; see `THIRD_PARTY_NOTICES.md`. Primary actions use the green primary.

- Filters live in the URL: `range=7d|90d` (30 days is the default and is
  omitted), or `start`/`end` for a custom window, `platform=google|meta`,
  `project=<id>|unassigned` and `accounts=<id>,<id>` (connected-account ids).
  `validateSearch` drops invalid values and the router redirects to the
  canonical URL. Presets are requested as `days=N`: the API ends them on the
  last day that is complete in every reported account's time zone, and the
  dashboard then shows the report's dates (a UTC estimate until it arrives).
  Custom windows are at most 93 inclusive days and never in the future; one that
  reaches a day not yet over in some account's time zone shows a muted
  "Includes today (incomplete)" badge next to the dates.
- Data is fetched in the browser with TanStack Query from the same-origin
  `/api/campaigns.json` (the Access cookie travels automatically;
  `redirect: 'manual'` turns an expired-session Access redirect into a
  "reload to sign in" state). Nothing is fetched or embedded during SSR. Live
  provider calls are never retried automatically or refetched on focus.
- KPI cards: spend and CPC per currency (CPC uses clicks bought in that
  currency), impressions, clicks, CTR, and conversions per platform. Nothing is
  summed across currencies or platforms. A value a source did not report shows
  `—`, never 0. In a partial report (a configured source failed) the figures cover only the
  sources marked Live, and a "Partial data" badge explains it; a merely not
  configured source never triggers that badge.
- Projects: the sidebar's project switcher (after OpenSEO's) lists "All
  projects" (the default), each project with its account count, "Unassigned"
  when some selected account is in no project, and "New project"/"Create
  project" (admins) and "Manage projects" (members: "View projects").
  Choosing one opens the dashboard with `?project=`, keeping the other filters
  and dropping `accounts`. The choice is also remembered in `localStorage`
  (`openads:lastProject`, per device, never trusted by the server): `/` without
  `?project=` reopens it, and no report is requested until that is decided.
  An unknown project in the URL (deleted, another workspace) is dropped before
  any request. The header reads "Overview / <project>". A project without
  accounts shows "No ad accounts in <project> yet" with one green "Assign
  accounts" (admins).
- The account filter next to the platform toggle (shown with two or more
  accounts in scope) is a multi-select of the scope's accounts — the project's,
  on the selected platform — with platform mark, name, ID and currency; it is
  searchable above 8 accounts. Changing the platform keeps only the picked
  accounts of that platform. Rows keep their account subline.
- `/projects` (sidebar → Projects): projects with their accounts (rename;
  delete with a confirmation dialog — its accounts become unassigned; "Open
  report"), and every selected account grouped by platform with a project
  select per account (saved immediately). "Suggest projects" previews groups
  of unassigned accounts with matching normalized names: case, accents,
  punctuation, the account's currency, long numbers and words such as "Ad
  Account", "Ads", "Google", "Meta" are ignored, so "Acme Ad Account"
  and the Google account "Acme" form "Acme"; a name that extends
  another one ("Acme Search") joins it, and an existing project of the same
  name receives the accounts. Groups of two or more accounts (or for an
  existing project) are pre-checked, single accounts are not; names of new
  projects are editable. Nothing is applied until "Accept". Members see the
  page read-only.
- Source badges open a hover card (hover, focus or tap) with fixed explanatory
  copy for live, not configured and unavailable; provider errors never reach
  the browser.
- The campaign table sorts and searches client-side. Money columns (Spend,
  CPC, CPM, Cost/conv.) sort by currency first because amounts in different
  currencies are not comparable; values shown as `—` sort last. With more than
  one ad account, each row names its account. Columns: Campaign, Status (colored
  dot), Spend, Impressions, Clicks, CTR, CPC, Conversions and Cost/conv. by
  default; CPM, Conv. rate, Reach and Frequency (Meta only, `—` for Google) can
  be shown from the "Columns" menu (browser-local, `openads:campaignColumns`).
  Cost/conv. is `—` with 0 conversions. "Export CSV" (outline) downloads the
  searched and sorted rows with the visible columns plus platform, account,
  IDs and currency (UTF-8 with BOM, CRLF, raw numbers: money in major units,
  percentages ×100; text cells starting with `=`, `+`, `-`, `@`, tab or CR get
  a leading `'`). Nothing is converted between currencies.
- Row actions: from 768px an "Open in Ads Manager" / "Open in Google Ads" icon
  link appears on row hover or keyboard focus (always on the open row), with a
  tooltip; below 768px the same actions sit in an overflow menu next to the
  campaign name (plus Show/Hide details). Links open in a new tab with
  `rel="noopener noreferrer"`. Meta links go to
  `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=<ad account id>&selected_campaign_ids=<campaign id>`
  (ad sets: `…/manage/adsets?act=…&selected_adset_ids=…`). Google identifies
  accounts in its UI by an internal `ocid` the API does not expose and
  documents no campaign deep link, so the Google link opens the account's
  Campaigns list, `https://ads.google.com/aw/campaigns?__e=<customer id>`
  (`__e` is undocumented but widely used), and the tooltip says to find the
  campaign there by name. No ad group links for Google.
- Expandable rows: the chevron (Enter/Space) or a click anywhere else on the row
  opens one campaign's details; one row is open at a time and the URL keeps
  `expanded=google:<id>|meta:<id>`. The panel is loaded on open from
  `/api/campaigns/<platform>/<campaignId>.json` (one live provider call;
  "Refresh" refetches it too): status, objective (Meta) or channel and bidding
  (Google), campaign budget per day or lifetime in the account currency ("Set
  per ad set" for Meta ad-set budgets), schedule; a lazy-loaded daily trend chart
  (Spend and Clicks as bars, Conversions as bars, CTR and CPC as lines; metric tabs,
  compact axes, dashed average, hover or arrow keys read out a day, days the API
  did not return are gaps, not zeros; hand-rolled SVG, no inline styles or injected
  `<style>`, so the nonce CSP holds);
  Spend, Impressions, Clicks, CTR, CPC, CPM, Conversions, Cost/conv., Conv.
  rate, plus Reach and Frequency (Meta) or Search impression share (Google
  Search); and the top 10 ad sets / ad groups by spend (status, spend,
  conversions, cost/conv.; Meta rows link to Ads Manager). Loading skeleton,
  inline error with "Try again" (or "Go to Sources" for expired access/setup),
  and empty states (no delivery, no ad groups, Performance Max asset groups).
  The panel stays in view while a wide table scrolls sideways (the scroll
  container is a CSS size container; the panel is `sticky` and `100cqw` wide).
- Metric help: every metric label (KPI cards, table headers, detail figures and
  breakdown headers) has a `?` (lucide `CircleHelp`) — a keyboard-focusable
  button named "What is CTR (click-through rate)?" whose tooltip opens on hover
  or focus and on tap for touch. Definitions live in one module,
  `src/client/lib/metricHelp.ts`, with the formula and the platform field
  (e.g. Meta clicks are the Insights `clicks` field: all clicks, not just link
  clicks). The `?` never triggers the header's sort button.
- Platforms in view come from the resolved scope, never from a default list:
  until the projects list and the remembered project are resolved, and until
  the report and `/api/sources.json` have loaded, the source strip shows unnamed
  skeleton pills and the KPI cards skeletons, so a Meta-only project never
  flashes a Google Ads pill on reload. In a project, the platform toggle
  disables platforms with no accounts there ("No Google Ads accounts in this
  project" tooltip); it is disabled while the scope loads.
- `/sources/google/setup`: the Google Ads setup wizard (instance admins). Seven
  steps — project ID, enable the API, Explorer access, Google Auth Platform
  (branding, audience/test users/publish, data access), OAuth client, paste
  Client ID/secret, connect — with "Open in Google Cloud" links carrying
  `?project=<id>`, copy buttons for every value Google asks for, "Done"
  checkboxes saved server-side, deploy-time prerequisites with the exact fix
  (e.g. `npm run deploy:cloudflare`, which generates a missing `TOKEN_ENCRYPTION_KEY`),
  and `?error=` outcomes opening the step that fixes them.
- `/sources/meta/setup`: the Meta Ads setup wizard (instance admins), same
  layout. Six steps — create a Meta app (use case "Measure ad performance data
  with Marketing API"), App ID, Facebook Login for Business settings (Valid
  OAuth Redirect URI, App domains, privacy-policy note, "URL blocked" helper),
  permission `ads_read` and app roles (Development mode, Limited access, "App
  not active" helper), App ID + App Secret, connect — with "Open in Meta"
  buttons to `https://developers.facebook.com/apps/<APP_ID>/…` (new tab,
  `rel="noopener noreferrer"`), copy buttons, saved "Done" checkboxes and
  `?error=invalid_app|redirect_mismatch|access_denied|permission_declined|client_missing`
  opening the step that fixes it (`permission_declined` re-requests with
  `auth_type=rerequest`).
- `/sources/meta/accounts`: the Meta ad account picker, grouped by business
  portfolio ("Your ad accounts" / "Business: …"), searchable by name, ID or
  business, up to 25; disabled, closing and closed accounts listed apart; open
  accounts needing attention (unsettled, under review, grace period) are
  selectable with a note. Empty state explains business-portfolio access.
- `/sources` (sidebar → Sources): a Google Ads card ("Google Ads is not set up
  on this instance" with "Set up Google Ads" and the guide link when there is no
  usable OAuth client / Connect / connected as
  <Google email>, N of M accounts selected / Choose accounts / Reconnect /
  Disconnect with a confirmation dialog; "Access expired" with a green
  Reconnect) and a Meta Ads card mirroring it ("Set up Meta Ads" / Connect /
  connected as <Facebook name>, N of M ad accounts selected, "Reconnect before
  <date>"; within 7 days of expiry an "Expires soon" badge, a warning and a
  green Reconnect; "Access expired" after) plus the **Count as conversions**
  select (common action types + "Other action type…" free text; read-only for
  members or when `META_CONVERSION_ACTION_TYPE` is set). OAuth outcomes come
  back as `/sources?google=connected|expired|invalid|no_refresh_token|error|
  unavailable|disconnected|confirm_switch|switch_failed` and
  `/sources?meta=connected|expired|invalid|error|unavailable|disconnected|
  confirm_switch|switch_failed` and render fixed copy; setup problems go to the
  wizards instead. A reconnect as another Google account / Facebook user shows
  admins a confirmation card above the source cards (both identities, how many
  accounts keep their selection and project, which ones would be removed;
  "Switch to …" / "Cancel"). Members see the page read-only.
- `/sources/google/accounts`: the account picker. Accounts are grouped by
  access path (direct, or "via <manager>"), searchable by name or ID, with
  multi-select (up to 25) and one green "Show report". Managers, cancelled,
  suspended, closed and unreadable accounts are listed apart and cannot be
  selected. Explicit states: not connected, access expired (Reconnect), list
  not loaded (Try again), and no reportable accounts (use another Google account).
- The dashboard shows one action for each fixable source state (Google and
  Meta alike): when nothing is connected, the empty table offers one green "Go
  to Sources" (or "Choose accounts" when none is selected); alongside other
  data, an inline notice per source; when access expired, a red notice whose
  green "Reconnect …" starts the provider's consent directly (non-admins get the
  fixed 403 message); when Meta's token expires within 7 days (`reconnectBy`),
  a warning with the same Reconnect. Figures of a source that did not report
  stay `—`.

## Content Security Policy

`protect()` creates a fresh 144-bit nonce only after Access succeeds and passes
it to the handler; `src/worker.ts` forwards it to Start as request context
(`nonce`). `src/router.tsx` reads it on the server
(`getGlobalStartContext()`) into `createRouter({ ssr: { nonce } })`, so
TanStack Router and React stamp it on every inline script (dehydration,
streaming, the theme bootstrap) and emit `<meta property="csp-nonce">`, which
the client router reads back. Base UI receives it through `CSPProvider`.
Authenticated responses (HTML, JSON and assets) carry:

```
default-src 'none'; script-src 'self' 'nonce-…'; style-src 'self' 'nonce-…';
img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self';
frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'
```

The policy is unchanged by the Google and Meta connections. Connect/Reconnect
is a same-origin `fetch` POST to `/api/oauth/google/start` or
`/api/oauth/meta/start`, which returns the provider's authorization URL; the
page then navigates with `location.assign()` (only to
`https://accounts.google.com` / `https://www.facebook.com` or its own origin). A form POST answered with a
cross-origin redirect would need `form-action` widened to Google (Chromium
checks `form-action` on redirects), so no form is used and `form-action` stays
`'self'`. Google's callback is a top-level navigation, not governed by the CSP.

There is no `'unsafe-inline'`, `'unsafe-eval'`, `'strict-dynamic'` or `data:`
source; `build.assetsInlineLimit` is 0 so Vite never inlines assets. Server-
rendered markup must not contain `style="…"` attributes (they cannot carry a
nonce): ported components use Tailwind arbitrary properties instead, and the
integration test fails on any `style=` attribute or un-nonced `<script>`/`<style>`.
Denials and sanitized failures (401/403/503) keep the locked policy
`default-src 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'`.
Every response keeps `Cache-Control: private, no-store`, `Vary: Accept,
Cf-Access-Jwt-Assertion`, `X-Content-Type-Options: nosniff` and
`Referrer-Policy: no-referrer`.

## Local harness (`scripts/preview.mjs`) — never deployed

`npm run preview:local` builds, then serves the built production Worker
(`dist/server/index.js`) on `http://localhost:8788/` (listening on 127.0.0.1 and
::1 only; with `--live`, on `http://127.0.0.1:8788/` and 127.0.0.1 only, behind
a one-time sign-in link, see below). It is outside `src/`, nothing in the Worker imports it, and
`wrangler deploy` never bundles it. It does **not** bypass Access: it plays the
Access edge by signing a real RS256 Access JWT (key pair generated at startup,
local-only team hostname/audience; the identity is `--email`, default
`admin@openads.localhost`, which is also `OPENADS_ADMIN_EMAILS`, or a member with
`--as member`) and setting `Cf-Access-Jwt-Assertion` on each request,
overwriting any incoming value. The Worker verifies it with the production code
path; only the JWKS download is answered in-process.

D1 is a local Miniflare database in `.wrangler/preview/` (gitignored): on start
the harness runs `wrangler d1 migrations apply DB --local --persist-to
.wrangler/preview` and binds it through wrangler's `getPlatformProxy()`. It
persists between runs; `--reset` deletes it first. `PUBLIC_ORIGIN` is
`http://localhost:<port>` (`--live`: `http://127.0.0.1:<port>`). `TOKEN_ENCRYPTION_KEY` comes from the environment or
is generated once into `.wrangler/preview/token-encryption-key` (mode 600);
`--without-key` leaves it unset to show that wizard state. `--live` keeps
its state apart, in `.wrangler/preview-live/` (directory mode 700, its own
database and its own generated key; `--reset` with `--live` deletes only that
one), so a later default or `--fixtures` run — which is not behind the sign-in
gate — can never read or change live grants and accounts
(`scripts/lib/preview-state.ts`).

```sh
npm run preview:local                                        # no provider network at all
npm run preview:local -- --live --email you@example.com      # real Google (local self-hosting)
npm run preview:local -- --fixtures                          # setup wizard + fake Google
npm run preview:local -- --fixtures --google-env             # fixture OAuth client from env ("managed by deployment")
npm run preview:local -- --fixtures --accounts single|none
npm run preview:local -- --fixtures --scenario revoked       # also: partial, unavailable, empty, api-disabled, not-approved
npm run preview:local -- --fixtures --scenario meta-expiring # also: meta-expired, meta-invalid-secret
npm run preview:local -- --fixtures --meta-env --meta-accounts single|none   # Meta app from env ("managed by deployment")
npm run preview:local -- --as member | --reset | --without-key | --port 8790
```

`--live` lets the Worker reach only `oauth2.googleapis.com`,
`googleads.googleapis.com` and `graph.facebook.com` and passes only the
documented settings from the shell (`GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_API_VERSION`, `GOOGLE_DEVELOPER_TOKEN`,
`META_APP_ID`, `META_APP_SECRET`, `META_API_VERSION`,
`META_CONVERSION_ACTION_TYPE`); both redirect URIs to register are printed at start.
Because `--live` holds real grants, it is not open to every local process:
it listens on 127.0.0.1 only, refuses any other `Host` (421, against DNS
rebinding), and requires a per-run cookie. At start it prints a one-time URL
`http://127.0.0.1:<port>/?preview_token=<32 random bytes>`; the first GET with it
answers 303 to `/` with `Set-Cookie: openads_preview_<port>=<another random value>;
HttpOnly; SameSite=Strict; Path=/` and the token is then spent. Browsers do not
scope cookies by port, so the name carries the port: runs on other ports never
accept or overwrite it. Every request without that cookie gets 401 (any
`openads_preview*` cookie is removed before the request reaches the Worker). Google's and Meta's redirect back to `/api/oauth/*/callback` is a
cross-site navigation, which does not carry a Strict cookie: that GET (and only
when `Sec-Fetch-Site: cross-site`) gets a tiny page that reloads the same URL
from the local origin, which then carries the cookie (or ends in 401). Logic and
tests: `scripts/lib/preview-gate.ts`, `tests/preview-gate.test.ts`. The default
and `--fixtures` modes stay open on loopback (no real grants).

With `--fixtures`, provider HTTP is answered by `tests/fixtures/` (a fake Google
OAuth token/revoke endpoint and Google Ads API in their wire formats, including
`SERVICE_DISABLED` and `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` errors, and a
fake Meta: Graph `oauth/access_token` (code and `fb_exchange_token`, with
codes 1/101/36008/36009), `debug_token`, `/me`, `/me/permissions` (GET and
DELETE), paginated `/me/adaccounts` (active, unsettled, disabled and closed
accounts, a business portfolio) and campaign Insights; it checks every
`appsecret_proof` and answers 190 when a token is expired; names start with "Fixture"). The fake checks client
credentials, the redirect URI and the PKCE verifier, and rejects reports sent
without the right `login-customer-id`. Its OAuth client ID/secret are printed at
start for pasting into the wizard. Google's consent screen is replaced by a
harness page at `/__preview/google/consent` (Allow / Cancel; an unknown client ID
gets Google's `invalid_client` error page), Facebook's Login dialog by
`/__preview/meta/dialog/…` (Continue / Continue without `ads_read` / Cancel; an
unknown App ID gets an error page); the harness rewrites only the authorization
URLs returned by the two start endpoints to point there. The fixture Meta app
(App ID/App Secret) is printed at start for the wizard. Every
other outbound request is refused. Stop it with Ctrl+C.

## Access gate (security model)

The tracked `wrangler.jsonc` is a template: `workers_dev: false`,
`preview_urls: false`, `routes: []` and empty vars. `npm run deploy:cloudflare`
(`scripts/deploy-cloudflare.mjs`, logic in `scripts/lib/cloudflare-deploy.ts`)
generates a private config at `.openads/wrangler.deploy.jsonc` (gitignored) from
it and `deploy/.env.cloudflare`, builds with `OPENADS_WRANGLER_CONFIG`, and keeps
`workers_dev`/`preview_urls` off; see [Cloudflare self-hosting](SELF_HOSTING_CLOUDFLARE.md).
Never enable workers.dev or preview URLs.

The deploy script validates the env file with the app's own parsers
(`parseAllowlist`, `parseExactAddresses`, `validTeamHostname`, `validAudience`,
`publicOrigin`, `googleApiVersion`), runs only `npx --no-install wrangler` /
`npx --no-install vite` with argument arrays (no shell, stdin closed so Wrangler
never prompts), and passes secrets only through a 0600 `--secrets-file` deleted
after the deploy, with the same names removed from the child environment
(Wrangler lets process env values override file values). Children always get
`WRANGLER_LOG=log` (quieter levels hide `--json` output), sanitized logs and no
log files. A real deploy holds `.openads/deploy.lock` (O_EXCL; replaced when its
process on this host is gone, never while it is alive however old; a lock from
another host expires after 30 minutes), re-lists the Worker secrets right before
uploading a new key, then claims the key id in D1 (`instance_meta`, migration
`0006`: `INSERT … WHERE NOT EXISTS`, read back; first deploy wins, a different
winner stops the deploy before any code or key is uploaded: the cross-checkout
guard), and writes the config and timestamped key backups 0600 (backups
exclusively; a backup is written before the claim). After the build,
`dist/server/wrangler.json` and everything in `.openads/` are chmod 0600
(`.openads/` 0700); `dist/` is gitignored. `--plan` refuses every
mutating command by construction and `--plan --offline` runs none;
`tests/deploy.test.ts` checks both with an injected runner. Run it as
`node -- scripts/deploy-cloudflare.mjs` (as the npm script does): Node otherwise
inspects an `--env-file` argument after the script path itself.

The outer `src/worker.ts` gate executes **before** TanStack Start and the `ASSETS`
binding, including `/assets/*` (Start middleware alone is insufficient). `assets.run_worker_first`
must remain true. All application routes use server rendering; there are no
prerendered reports, public status routes or development bypasses.

jose verifies RS256 signatures against
`https://<team-hostname>/cdn-cgi/access/certs`, the exact HTTPS issuer, and configured
OpenADS audience. Expiration, issued-at, subject and email are mandatory. Expired,
future-issued, malformed, unsigned, unverifiable or non-allowlisted identities
fail closed.

Allowlist matching (`parseAllowlist`/`isAllowedEmail` in `src/lib/access.ts`)
compares ASCII-lowercased values (A–Z only; no Unicode case folding or IDN
normalization). An exact entry matches only the whole address. A domain entry
matches only a verified JWT `email` with exactly one `@`, a non-empty local part
without whitespace, and a domain part identical to the entry's domain: no
suffix, subdomain or superdomain matching (`@example.com` does not allow
`x@evil-example.com`, `x@sub.example.com` or `x@example.com.evil.test`). Entries are
trimmed around commas; an empty entry, whitespace inside an entry, a bare `@`,
more than one `@`, an empty local part, or a domain without a dot or with an
empty label makes the whole configuration invalid (sanitized 503), so a typo
fails closed instead of widening access. A domain entry trusts everyone whom
the identity provider behind Access issues an address at that domain.
An email assertion header or cookie alone is never authentication.
Missing/invalid Access configuration gives sanitized HTTP 503; invalid identity
401; an authenticated but disallowed email 403. JWKS failure denies access.
Responses are private/no-store. No provider bodies, tokens or exception details
are logged or returned; Workers observability is disabled in this template.

## Workspaces, connections and Google Ads OAuth

Schema: `migrations/0001_connections.sql`, `0002_google_setup.sql`,
`0003_meta_ads.sql`, `0004_projects.sql`, `0005_account_freshness.sql` and
`0006_deploy_key_claim.sql` (`instance_meta`: the deploy's key-id claim, written
only by the deploy script) and `0007_pending_connection.sql` (`pending_connection`:
a reconnect as another provider identity awaiting confirmation) (D1 binding `DB`). Tables are normalized; every tenant row
carries `workspace_id`, and child rows use composite foreign keys so they
cannot point into another workspace. Applied migrations are never edited:
`0003` rebuilds `connection`, `connected_account` and `oauth_state` (SQLite
cannot alter a CHECK) to accept the `meta_ads` provider, copying every row
first and dropping the old child table before its parent so nothing cascades
(`tests/meta-setup.test.ts` and a local Miniflare D1 run verify existing Google
rows survive).

| Table | Purpose |
| --- | --- |
| `workspace` | `id`, `name`, `is_default` (at most one default, unique partial index) |
| `membership` | (`workspace_id`, `email`) → `role` `admin`/`member`; email is the verified, ASCII-lowercased Access email |
| `connection` | one grant per (`workspace_id`, `provider` `google_ads`/`meta_ads`); `provider_subject` (Google OIDC `sub` / Meta app-scoped user ID), `provider_email` (Google), `provider_name` (Meta user name), `refresh_token_ciphertext` (Google refresh token / Meta long-lived token), `token_key_id`, `token_expires_at` (Meta: min of token and data-access expiry), `status` `active`/`revoked`/`error`/`expired`, `accounts_discovered_at`, timestamps |
| `connected_account` | per connection: `customer_id` (Google customer ID / Meta ad account ID without `act_`), `descriptive_name`, `currency_code`, `time_zone`, `is_manager`, `account_status` (Google statuses plus Meta's `DISABLED`, `UNSETTLED`, `PENDING_RISK_REVIEW`, `PENDING_SETTLEMENT`, `IN_GRACE_PERIOD`, `PENDING_CLOSURE`; Meta ACTIVE is stored as `ENABLED`), `login_customer_id`, `manager_customer_id`, `business_id`/`business_name` (Meta portfolio), `eligible`, `selected` (a CHECK forbids selecting an ineligible account), `stale_since` (`0005`: when discoveries stopped confirming the account, see below; NULL when confirmed) |
| `project` | (`workspace_id`, `id`), `name` (1–80 characters, unique per workspace ignoring ASCII case), `created_at` |
| `project_account` | `connected_account_id` (primary key: an account is in at most one project), `workspace_id`, `project_id`, `created_at`; composite foreign keys to `project (workspace_id, id)` and `connected_account (workspace_id, id)`, both `ON DELETE CASCADE`. Accounts without a row are "Unassigned" |
| `pending_connection` | at most one per (`workspace_id`, `provider`): `id`, `replaces_connection_id` (composite FK to `connection`, `ON DELETE CASCADE`), `replaces_subject`, the new `provider_subject`/`provider_email`/`provider_name`, `token_ciphertext` + `token_key_id` (AAD bound to the pending id, not a connection), `token_expires_at`, `discovery` (JSON of the new login's accounts), `created_by_email`, `created_at`, `expires_at` (CHECK: ≤ 10 minutes) |
| `oauth_state` | `state_hash` (SHA-256 of the state; the state itself is never stored), `workspace_id`, `email`, `provider`, `code_verifier` (Google PKCE; NULL for Meta), `created_at`, `expires_at` (CHECK: ≤ 10 minutes) |
| `google_setup` | singleton (`id = 1`): Google Cloud project ID, wizard step times, OAuth client ID, sealed client secret + last four |
| `meta_setup` | singleton (`id = 1`): Meta `app_id`, wizard step times (`app_created_at`, `login_configured_at`, `access_confirmed_at`), sealed `app_secret_ciphertext` + `app_secret_key_id` + `app_secret_last4` (a CHECK requires the App ID with a secret), `conversion_action_type` (NULL = `purchase`) |

**Projects (`0004`).** A project groups a workspace's connected ad accounts
(any provider) so the dashboard can report on one brand or client. The
composite foreign keys make cross-workspace rows impossible in D1 itself, not
only in queries. Rediscovery now upserts accounts by
(`connection_id`, `customer_id`), so accounts that are still listed keep their
`connected_account.id` (and project). Rediscovery never deletes an account that
is selected or assigned to a project (see "Account discovery" below); an
explicit admin Remove of a stale account, a confirmed switch to another
provider identity (only for the accounts the new login does not list) and Disconnect delete the account rows and, by cascade, their assignments. Deleting a project only unassigns its accounts.
`0004` only adds tables and a unique index on `connected_account
(workspace_id, id)`; no existing row changes.

**Workspace bootstrap.** First version: one default workspace. The first visit
by an address in `OPENADS_ADMIN_EMAILS` creates it; any other Access-authenticated
user becomes a `member` on first visit once it exists (before that they see
"not set up yet" and nothing is created). For the default workspace the admin
list is authoritative: roles follow it on every visit (removing an address
demotes it to member). `OPENADS_ADMIN_EMAILS` uses the allowlist's exact-entry
rules (comma-separated exact addresses, no `@domain` entries); a malformed value
fails closed (Sources answer a sanitized 503, nobody is admin). Every query takes
a workspace id from the server-side membership, never from the browser.

**OAuth (Google web-server flow).**

1. `POST /api/oauth/google/start` — admin only, same origin. Purges expired
   states, replaces this admin's pending state, stores a new one (32 random
   bytes, hashed; 10-minute TTL; bound to workspace, Access email, provider and
   a 48-byte PKCE verifier) and returns `{ authorizationUrl }`:
   `https://accounts.google.com/o/oauth2/v2/auth` with `response_type=code`,
   `scope=https://www.googleapis.com/auth/adwords openid email`,
   `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`,
   `code_challenge_method=S256`, and `redirect_uri=${PUBLIC_ORIGIN}/api/oauth/google/callback`
   (never derived from the Host header). `GET` → 405 (`Allow: POST`).
2. `GET /api/oauth/google/callback` — deletes the state row atomically
   (`DELETE … RETURNING`) before anything else, so it can never be replayed;
   then requires it unexpired, for `google_ads`, created by the same Access email,
   in the caller's current workspace, and the caller still admin. `error=access_denied`
   → setup wizard (`/sources/google/setup?error=access_denied`); other provider
   errors → `/sources?google=error`. The code is exchanged with the verifier;
   Google's `invalid_client`/`unauthorized_client` → wizard (`error=invalid_client`);
   the response must include a refresh token (`no_refresh_token` otherwise), the
   Ads scope (wizard, `error=scope_denied`, otherwise) and an ID token for this client
   (issuer, audience, expiry checked; it comes straight from Google's token
   endpoint over TLS). The refresh token is encrypted and stored, accounts are
   discovered with the fresh access token, then: exactly one reportable account
   → selected automatically, redirect to `/`; several → `/sources/google/accounts`
   (or `/sources?google=connected` when a reconnect kept earlier selections);
   discovery refused for a Cloud project reason → wizard (`error=api_disabled`
   for `SERVICE_DISABLED`/`accessNotConfigured`, `error=access_level` for
   `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION`/`ACTION_NOT_PERMITTED`/
   `DEVELOPER_TOKEN_NOT_APPROVED`; the grant is kept so only "Load accounts" is
   needed after the fix); other discovery failures →
   `/sources/google/accounts?discovery=failed`. `HEAD` → 405
   so nothing but a real navigation consumes a state.
3. Reconnecting the same Google identity keeps the connection and its selected
   accounts (its previous token is not revoked: Google revokes per grant, which
   would revoke the new token too). A different Google identity is **not**
   applied: see "Reconnecting as another identity" below.

**Reconnecting as another identity** (`src/lib/connection-switch.ts`,
`migrations/0007_pending_connection.sql`, Google and Meta alike). When the
callback's identity (Google OIDC `sub` / Meta app-scoped user ID) differs from
the stored connection's, the callback discovers the new login's accounts with the
fresh token and stores the grant in `pending_connection` (sealed with the
separate AAD `openads:pending-grant:v1:<workspace>:<pending id>`, 10-minute TTL,
one per workspace and provider, cascade-deleted with the connection it would
replace) together with that discovery, then redirects to
`/sources?{google,meta}=confirm_switch`. Nothing else changes. If that discovery
fails, nothing is stored, the new grant is revoked and the result is
`switch_failed` (or the Google setup wizard for a Cloud project issue). Sources
shows admins: "You signed in as <new>; the current connection is <old>.
Accounts both can access keep their selection and project; N accounts the new
login can't see will be removed", listing them. **Switch** (`POST
/api/sources/{google,meta}/switch`, `{ id, action: "confirm" }`, admin, same
origin) takes the pending row atomically, re-seals the grant for the existing
connection id, updates the connection row **in place** (guarded on the old
subject), deletes only the accounts whose provider account id the new login does
not list (with their project assignments), refreshes the rest from the stored
discovery (their row id, selection and project are kept), and revokes the old
identity's grant best effort (another user, so the new grant is unaffected).
**Cancel** (`action: "cancel"`) deletes the pending row and revokes the new grant.
A second confirm/cancel, an unknown id, or one after expiry gets 409 and
changes nothing. Reconnecting as the current identity drops any pending change.

**Instance OAuth client and setup wizard.** The Google OAuth client belongs to
the instance (the operator's own Google Cloud project), not to a workspace.
`GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` from the deployment take
precedence ("managed by deployment"; one without the other, or a malformed
value, is refused rather than falling back). Otherwise an instance admin
(`OPENADS_ADMIN_EMAILS`) enters it in the wizard (`/sources/google/setup`): it is
stored in `migrations/0002_google_setup.sql`'s singleton `google_setup` row with
the secret sealed under `TOKEN_ENCRYPTION_KEY` (AAD
`openads:instance:google-oauth-client-secret:v1`) and its last four characters
for display; the secret is never returned. Saving a different Client ID marks
existing Google connections `error` (their grants belong to the old client); the
same ID (rotated secret) keeps them; removing the client keeps grants but
reports `setup_required`/`client_missing`. The row also keeps the wizard's
progress: the Google Cloud project ID (validated `^[a-z][a-z0-9-]{4,28}[a-z0-9]$`,
used only for `?project=` console links) and the time each manual step was
marked done. The Google Ads API version defaults to `GOOGLE_ADS_API_VERSION` in
`src/lib/config.ts` (`v26`), overridable by `GOOGLE_API_VERSION`. Google sunset
developer tokens on 2026-09-09; `GOOGLE_DEVELOPER_TOKEN` is sent only if set.

`PUBLIC_ORIGIN` must be `https://<DNS host>[:port]` (no IP hosts, path, query,
credentials or trailing slash) or, for local runs, `http://localhost:<port>` /
`http://127.0.0.1:<port>`; the redirect URI is `PUBLIC_ORIGIN` +
`/api/oauth/google/callback`.

**Token encryption.** AES-256-GCM (Web Crypto), 96-bit random IV, stored as
`v1.<iv>.<ciphertext>` (base64url) with `token_key_id`, a domain-separated
SHA-256 fingerprint of the key (`k1-…`). The AAD binds each ciphertext to its
workspace and connection id, so a row copied elsewhere does not decrypt. A
different/rotated key, tampering or a malformed value fails closed: the
connection becomes `error`, the report shows "reconnect", no provider call is made.
Key rotation therefore currently means reconnecting (see open issues).

**Account discovery.** `GET customers:listAccessibleCustomers`, then for each
accessible customer (≤ 100, 4 at a time, 25 s total) one read-only GAQL query
`… FROM customer_client WHERE customer_client.level <= 1` with
`login-customer-id` = that customer. Direct access wins over access through a
manager; children of a manager are reported with the manager as
`login-customer-id`. Reportable ("eligible") = not a manager, `ENABLED`, valid
currency and IANA timezone. Managers, cancelled/suspended/closed accounts and
customers that cannot be queried (`UNREADABLE`) are kept but not selectable.
Sub-managers are not expanded further (level ≤ 1). Rediscovery keeps selections
that are still eligible.

**Invariant: automatic rediscovery never deletes a user decision.** A stored
account that is selected or assigned to a project is never deleted by
rediscovery (Google or Meta), whatever the provider returned: when it is not
listed it is kept unchanged (row id, selection, project assignment) and marked
`stale_since`; the picker shows "Not confirmed on the last refresh" and, for
admins, a **Remove** button (confirm dialog, then `POST
/api/sources/{google,meta}/remove-account`), the only way such an account goes
besides Disconnect or a grant of another identity. The check is part of the
`DELETE` statement itself (`selected = 0 AND NOT EXISTS (project_account …)`),
so a concurrent selection or assignment is never lost. Accounts with no
decision that are no longer listed are pruned, except those reached through a
Google root whose hierarchy query failed or did not return the root's own row
(`incompleteLogins`): those are kept and marked stale too, and a known account
is never overwritten by an `UNREADABLE` placeholder. The next refresh that lists
an account clears the mark. Meta discovery is all-or-nothing (any failed page
fails the whole refresh, nothing changes).

**Reporting.** For the requester's workspace: no grant → Google
`not_configured` with `detail: "not_connected"`; nothing selected →
`detail: "no_accounts_selected"`; grant not active → `unavailable` with
`detail: "reconnect_required"` and no provider call; grant present but no
usable OAuth client → `unavailable`, `detail: "setup_required"`,
`setupIssue: "client_missing"`. Otherwise one token refresh
per report, then one GAQL campaign report per selected account (≤ 25, 4 at a
time, 20 s total, 10 pages and 50,000 rows overall), with `login-customer-id`
only when reached through a manager. Google evaluates `segments.date` in each
account's own timezone. The Google source is `available` only when every
selected account reported; otherwise it is `unavailable`, all its rows are
discarded and `accounts[].status` says which account failed. `invalid_grant`
from the token endpoint marks the connection `revoked` and yields
`reconnect_required`; `invalid_client` yields `setup_required`/`invalid_client`;
an account refused for a Cloud project reason yields `setup_required` with
`api_disabled` or `access_level` — never zeros.

**Disconnect.** `POST /api/sources/google/disconnect` (admin, same origin)
decrypts the grant, POSTs it to `https://oauth2.googleapis.com/revoke`
(best-effort, 5 s), then deletes the connection row (ciphertext included) and,
by cascade, its accounts — also when revocation fails.

**Security.** Every state-changing endpoint is a POST whose `Origin` must equal
`PUBLIC_ORIGIN` exactly (and `Sec-Fetch-Site`, when present, `same-origin`);
admin rights are checked server-side from D1. Tokens, ciphertext, verifiers and
provider bodies never appear in responses, URLs we generate, or logs; the only
provider body ever read on an error is the token endpoint's 400/401 JSON, for
its `error` code. Google Ads calls are read-only: `listAccessibleCustomers` and
`googleAds:search`; no mutate method is called. Google has no read-only Ads
scope: effective permissions are the Google user's account roles.

## Operating an instance

Deployment, Access, D1, secrets, the Google Cloud setup and the Meta app are
documented for operators in [Cloudflare self-hosting](SELF_HOSTING_CLOUDFLARE.md),
[Google Ads](SELF_HOSTING_GOOGLE_ADS.md) and [Meta Ads](SELF_HOSTING_META_ADS.md). Instance settings: `PUBLIC_ORIGIN`,
`OPENADS_ADMIN_EMAILS`, `ACCESS_TEAM_HOSTNAME`, `ACCESS_AUDIENCE`,
`ACCESS_ALLOWED_EMAILS` (vars), `TOKEN_ENCRYPTION_KEY` (secret), D1 binding
`DB`; optional `GOOGLE_OAUTH_CLIENT_ID` (var) + `GOOGLE_OAUTH_CLIENT_SECRET`
(secret), `GOOGLE_API_VERSION`, `GOOGLE_DEVELOPER_TOKEN`, `META_APP_ID` (var) +
`META_APP_SECRET` (secret), `META_API_VERSION`, `META_CONVERSION_ACTION_TYPE`. Nothing in the code is specific to one deployment.

## Meta Ads (self-serve, operator's own Meta app)

Code: `src/lib/meta-ads/` (`config.ts`, `graph.ts`, `oauth.ts`, `discovery.ts`,
`service.ts`, `setup.ts`) and `src/lib/providers/meta.ts` (Insights). The
former operator-configured single account (`META_ACCESS_TOKEN`,
`META_ACCOUNT_ID`) is removed, the same way Google's was: only the app
credentials may come from the deployment.

**Instance Meta app.** `META_APP_ID` (var) + `META_APP_SECRET` (secret) take
precedence ("managed by deployment"; one without the other, or a malformed
value — App ID numeric, App Secret 32 hex characters — is refused rather than
falling back). Otherwise an instance admin enters them in the wizard; the App
Secret is sealed under `TOKEN_ENCRYPTION_KEY` (AAD
`openads:instance:meta-app-secret:v1`) in `meta_setup` and never returned (last
four shown). Saving another App ID clears a stored secret and marks Meta
connections `error` (tokens belong to the app that issued them); a rotated
secret for the same App ID keeps them; removing the secret keeps grants but
reports `setup_required`/`client_missing`. Graph API version: `META_GRAPH_API_VERSION`
in `src/lib/meta-ads/config.ts` (`v27.0`, released 2026-11-04), overridable by
`META_API_VERSION` (`v` + major.minor). Conversion action type:
`META_CONVERSION_ACTION_TYPE` when set, else the value saved on Sources, else
`purchase`; validated as an exact `action_type`
(`^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$`), never a sum of several.

**OAuth (Facebook Login, server-side code flow).**

1. `POST /api/oauth/meta/start` — admin only, same origin, optional JSON
   `{ "rerequest": true }`. Stores a hashed one-time state (10-minute TTL,
   bound to workspace, Access email and provider; no PKCE verifier) and
   returns `{ authorizationUrl }`: `https://www.facebook.com/<v>/dialog/oauth`
   with `client_id`, `redirect_uri=${PUBLIC_ORIGIN}/api/oauth/meta/callback`,
   `state`, `scope=ads_read`, `response_type=code` (+ `auth_type=rerequest`).
   `GET` → 405 (`Allow: POST`): creating state is a state change, so it stays a
   same-origin POST like Google's.
2. `GET /api/oauth/meta/callback` — consumes the state first (`DELETE …
   RETURNING`), then requires it unexpired, for `meta_ads`, same Access email,
   same workspace, still admin. `error=access_denied` → wizard
   (`error=access_denied`, roles step); other errors → `/sources?meta=error`.
   Then `POST /oauth/access_token` (code → short-lived token); `GET
   /debug_token?input_token=<short-lived token>` with the app token as
   `Authorization: Bearer` (must be valid, type USER, `app_id` = this App ID);
   `POST /oauth/access_token` with `grant_type=fb_exchange_token` (→ long-lived
   token, `expires_in`); `/me/permissions` and `/me` (Bearer header; `/me`'s id
   must equal the inspected user). Both exchanges use form bodies so the App
   Secret, code and tokens are never in a URL. Meta documents `debug_token` as
   GET-only, so only the short-lived token (about an hour, never stored) is ever
   inspected there: the long-lived token is never in any URL. The Graph transport refuses a URL
   carrying `access_token`, `client_secret`, `fb_exchange_token` or `code`, and
   its errors never include a URL, header or body. Graph code 101,
   or 1 on the OAuth endpoint → `error=invalid_app` (credentials step); code
   100/36008 → `error=redirect_mismatch` (Facebook Login step); 100/36009
   (used code) → `/sources?meta=expired`. `ads_read` not granted → nothing is
   stored, the login is removed (`DELETE /me/permissions`) and the wizard opens
   `error=permission_declined`, whose Connect re-requests. The long-lived token
   is sealed (AAD workspace + connection) with `token_expires_at` = min(now +
   the long-lived exchange's `expires_in`, `data_access_expires_at` from
   `debug_token`). Ad accounts
   are discovered: one eligible → selected, redirect `/`; several →
   `/sources/meta/accounts` (or `/sources?meta=connected` when a reconnect kept
   selections); failure → `/sources/meta/accounts?discovery=failed`. Same
   Facebook user → same connection id (selections kept; the new token replaces
   the old); another user is staged for confirmation, see "Reconnecting as
   another identity" above. `HEAD` → 405.

**Graph transport** (`graph.ts`). Fixed host `https://graph.facebook.com`,
`redirect: 'manual'`, bounded bodies; user tokens go in an `Authorization:
Bearer` header (never the URL) with `appsecret_proof` = hex HMAC-SHA256(token,
key = App Secret) on every call. Only a direct 4xx JSON error body is read, and
only for numeric `code`/`error_subcode`: 190/102 → token (expired), 101 (or 1 on
OAuth) → app, 100/36008 → redirect URI, 100/36007/36009 → code, 10/200–299 →
permission, 4/17/32/613/80000–80014 → rate limit. Opaque `after` cursors are
reused on our own URL; provider `next` URLs are never requested.

**Account discovery.** `GET /me/adaccounts?fields=id,account_id,name,currency,
timezone_name,account_status,business{id,name}&limit=100`, ≤ 50 pages / 5,000
accounts, 25 s; if Meta refuses the `business` field (permission error or #100)
the list is loaded again without it. Eligible = account_status 1 (active), 3
(unsettled), 7 (risk review), 8 (pending settlement) or 9 (grace period), with
a valid ISO currency and IANA timezone; 2 (disabled), 100 (pending closure) and
101 (closed) are listed but not selectable. Rediscovery keeps selections that
are still eligible, and never deletes a selected or assigned ad account it no
longer lists (kept as stale until an admin removes it; same invariant as Google).

**Reporting.** For the requester's workspace: no grant → `not_configured`
`not_connected` (plain `not_configured`, without a dashboard nudge, when the
instance has no Meta app at all); nothing selected → `no_accounts_selected`; no usable Meta app
(or malformed `META_CONVERSION_ACTION_TYPE`) → `unavailable` `setup_required`
`client_missing`; grant not active or past `token_expires_at` → marked
`expired`, `unavailable` `reconnect_required`, no Graph call. Otherwise one
`GET /act_<id>/insights?level=campaign&fields=account_currency,campaign_id,
campaign_name,impressions,clicks,spend,actions&time_range={since,until}`
(paginated) per selected ad account (≤ 25, 4 at a time, 20 s total, 25 pages
and 10,000 rows overall); Meta applies each account's timezone, and each row
must be in the account's currency. Available only when every account reported;
otherwise all Meta rows are discarded and `accounts[].status` says which
failed. Graph 190 → connection `expired`, `reconnect_required`; never zeros.
Within 7 days of expiry the source carries `reconnectBy`.

**Disconnect.** `POST /api/sources/meta/disconnect` (admin, same origin):
`DELETE /me/permissions` with the stored token (best effort, 5 s), then the
connection row (ciphertext included) and its accounts are deleted.

Meta needs only `ads_read` with Meta's default Limited access tier while the
app is in Development mode and every connecting person has an app role
(Administrator/Developer). App Review (Full access) is needed only for people
without a role. Facebook Login for Business recommends a `config_id`; the
manual flow still accepts `scope`, which OpenADS uses so no configuration has
to be created.

Both adapters paginate, reject malformed metrics/currencies, block redirects and
discard all partial rows on failure. Workers `fetch` does not implement
`redirect: 'error'`, so adapters request `redirect: 'manual'` and accept only a
direct 2xx response with a body: any 3xx (returned unfollowed), opaque redirect,
followed redirect or other non-2xx makes the source unavailable without parsing
its body (`src/lib/providers/http.ts`). Meta reuses opaque cursors on its fixed host;
it never follows provider-supplied next URLs. Google limits: 20 seconds total,
10 pages per account, 50,000 rows, 8 MiB/page (64 KiB OAuth). Meta limits: 20
seconds total, 25 pages per account, 10,000 rows, 2 MiB/page (64 KiB OAuth). Hitting a limit is
unavailable, not truncated success. Provider permission, rate-limit and HTTP
errors are sanitized alike.

## API contract

- `GET /` returns the dashboard HTML when `Accept` includes `text/html`, and
  otherwise an authenticated JSON entry describing the reporting endpoint.
- `GET /api/campaigns.json` accepts only `platform=google|meta`,
  `start=YYYY-MM-DD`, `end=YYYY-MM-DD`, `days=1…93` (without start/end),
  `project=<id>|unassigned` and
  `account=<connected_account id>` (repeatable, at most 50, no repeats);
  omitted platform selects both, omitted project/account every selected
  account (unchanged behaviour).
- Project and account filters (additive): ids are lowercase UUIDs, checked
  against the requester's workspace before any provider call — a project that
  is not one of its projects, an account that is not one of its connected
  accounts, or an account outside the given project is a 400. The report then
  covers only the selected accounts in scope (`unassigned`: in no project);
  accounts outside the scope are never sent to a provider, and a platform with
  no account in scope is not contacted and not listed in `sources` (like
  `platform=`). A scope without accounts gives `sources: []` and
  `status: "not_configured"` (503). Scoped responses add `filters.project`
  (id, `unassigned` or null) and `filters.accounts` (the account ids, or `[]`);
  unscoped responses are unchanged.
- Inclusive calendar dates, at most 93 days, no future dates (UTC). Defaults:
  the last 30 days (or `days`) through the last complete day, i.e. yesterday in
  the westernmost reporting time zone of the accounts the report queries, so no
  account's current, unfinished day is included. When any of those zones is
  unknown (an account without one, or the lookup failed), UTC−12
  (`Etc/GMT+12`) stands in for it, never UTC; `includesToday` uses the same rule.
  End alone selects its preceding 30 inclusive days; start alone selects up to
  30 days capped at today. Additive `includesToday: true` when the window
  reaches a day that is not over yet in at least one of those time zones (its
  figures are still growing).
  Explicit dates are interpreted in each provider account's reporting timezone;
  cross-platform windows may therefore not align to identical UTC instants.
- Unknown/duplicate parameters, invalid calendar dates, empty values, reversed
  or oversized windows return HTTP 400, before provider calls.
- `source: "live"`; `status`: `available`, `partial`, `not_configured` or
  `unavailable`. `sources` provides independent platform status and totals.
  All unavailable sources have `totals: null`, never manufactured zeros.
  Sources that are `not_configured` are not failures: completeness is judged
  over configured selected sources only. When all configured sources are
  available the report is `available` with `complete: true` and combined
  `totals` over those platforms (conversions of not-configured platforms are
  null). `partial` means a configured source is unavailable; totals are then null.
  `campaigns` contains only available-source rows, or null when none is available.
  Partial results return 200 with `complete: false`; no available source gives
  503 (`not_configured` when every selected source is not configured). Successful genuinely empty provider results give empty rows and zero
  totals. An entirely empty environment is safely not configured, never a demo.
- Campaign identity is `(platform, id)`. `spendMinor` uses the ISO currency's
  minor unit (not universally cents); Google micros round once per campaign.
  Currency validation uses ICU's named ISO codes, including units of account such
  as CLF that `Intl.supportedValuesOf('currency')` omits; unknown and lowercase
  codes are rejected.
  `spendByCurrency` keeps currencies separate, with no FX or combined money sum.
  `platformConversions` preserves Google/Meta separately; unselected platforms
  are null. Counts may be fractional and are not subscriptions, revenue, unique
  customers or cross-platform deduplicated conversions.
- Additive fields: a source may carry `detail` (`not_connected`,
  `no_accounts_selected`, `reconnect_required`, `setup_required`), `accounts`
  (`id`, `name`, `currency`, `timeZone`, `status` `available`/`unavailable`) and,
  for Meta within 7 days of token expiry, `reconnectBy` (ISO). Campaign rows
  carry `accountId` and `accountName`; campaign identity is
  `(platform, accountId, id)`.
- Additive campaign row fields: `status` (`active`, `paused`, `removed`,
  `archived`, `issues`, `pending`, or null when unknown — Google
  `campaign.status` in the same GAQL query; Meta `effective_status` looked up
  read-only with `GET /?ids=<≤50 ids>&fields=effective_status`, at most 10
  batches per account, and null rather than a failed report when that lookup
  fails), `connectedAccountId` (the `account=` of the detail endpoint) and, for
  Meta, `reach` (Insights `reach`, null when absent; never summed across
  campaigns). `accountId` stays the provider ID used for deep links.
- `GET /api/campaigns/<google|meta>/<campaignId>.json?account=<connected_account id>&start&end[&project]`
  (campaign detail, any member): only those four parameters, each at most
  once; `account` is required; dates follow the report rules (≤ 93 days, not in
  the future, default last 30 days). Checked in D1 before any provider call:
  an unknown platform or malformed campaign ID, or an account that is not a
  selected account of the requester's workspace on that platform, is 404
  `{ "error": "Campaign not found." }`; with `project`, an unknown project or an
  account outside it is 400. Response (200, `Cache-Control: private, no-store`):
  `{ source: "live", platform, window: {start, end}, account: { id, providerId,
  name, currency, timeZone }, includesToday, campaign: { platform, id, name, currency, status,
  objective, channelType, biddingStrategy, budget: { period: daily|lifetime,
  amountMinor } | null, startDate, endDate, totals: { impressions, clicks,
  spendMinor, conversions, reach, searchImpressionShare }, daily: [{ date,
  impressions, clicks, spendMicros, conversions }] (every day of the window,
  zero on days the platform reported nothing), breakdown: { level:
  ad_set|ad_group, total, rows: [≤ 10 by spend: { id, name, status,
  impressions, clicks, spendMinor, conversions }] } } }`. Money is in the
  account currency, never converted: `spendMinor`/`amountMinor` in its minor
  unit; daily `spendMicros` is an exact integer in millionths of the major unit
  (Google's cost_micros; Meta's minor units scaled up), so clients sum the days
  as integers and round half up once, for display, matching `totals.spendMinor`
  (rounded once from the summed micros). Without dates
  the window ends on the account's last complete day. Google: four read-only GAQL
  searches against the account's customer ID (facts with
  `campaign.start_date_time`/`end_date_time` and `campaign_budget`; daily
  `segments.date`; `FROM ad_group`; `metrics.search_impression_share` for
  Search campaigns only); a campaign the customer does not have is 404.
  Meta: `GET /<campaign id>` (must report the selected `account_id`, else 404),
  `/<campaign id>/insights` for totals (with `reach`), `time_increment=1` and
  `level=adset`, then the top ad sets' `effective_status`; budgets are
  converted from Meta's currency offset (1 for CLP, COP, CRC, HUF, ISK, IDR,
  JPY, KRW, PYG, TWD, VND; 100 otherwise). Failures are fixed messages: 409
  `{ reconnect: true }` for expired access (the grant is marked revoked/expired),
  409 `{ setupRequired: true }` for setup problems, 502 otherwise.
- No synthetic data exists in runtime code. Test fixtures exist only in tests.

Sources API (JSON, `Cache-Control: private, no-store`, behind Access):

| Endpoint | Who | Notes |
| --- | --- | --- |
| `GET /api/sources.json` | any member | `{ workspace: {name, role} \| null, google: { available, clientSource, canSetUp, connection \| null, pendingSwitch \| null }, meta: { available, appSource, canSetUp, conversion: { value, source: deployment\|instance\|default } \| null, connection \| null, pendingSwitch \| null } }` (`pendingSwitch` only with a workspace; null for members) — `id`, `next`/`current` `{ email, name }`, `keptAccounts`, `removedAccounts`, `removed[]` (first 20: `customerId`, `name`, `selected`), `newAccounts`, `expiresAt`; Google `connection` = `status`, `googleEmail`, `connectedAt`, `updatedAt`, `accountsDiscoveredAt`, `eligibleAccounts`, `selectedAccounts`; Meta `connection` = `status` (`expired` once past expiry), `name`, the same counts and dates, `expiresAt`, `expiresSoon` (≤ 7 days) |
| `GET /api/sources/google/accounts` | any member | `{ role, connection, accounts[], maxSelected }`; account = `customerId`, `name`, `currency`, `timeZone`, `manager`, `status`, `managerCustomerId`, `eligible`, `selected`, `stale` |
| `POST /api/sources/google/accounts` | admin, same origin | JSON `{ "customerIds": [...] }`, 1–25 unique eligible accounts of this workspace's connection, else 400; 409 `{reconnect: true}` when access expired |
| `POST /api/sources/google/discover` | admin, same origin | reloads the account list; 409 `{reconnect: true}` on `invalid_grant`, 502 on other failures |
| `POST /api/sources/google/disconnect` | admin, same origin | `{ disconnected, revoked }` (also discards a pending switch) |
| `POST /api/sources/{google,meta}/switch` | admin, same origin | `{ "id": "<pendingSwitch.id>", "action": "confirm" \| "cancel" }` → `{ switched: true, revoked, eligibleAccounts, selectedAccounts }` / `{ cancelled: true, revoked }`; 409 when expired, already handled or the connection changed; 400 otherwise malformed |
| `POST /api/oauth/google/start` | admin, same origin | `{ authorizationUrl }` |
| `GET /api/oauth/google/callback` | Google redirect | always a 303 into the app |

| `GET /api/sources/google/setup` | instance admin | wizard state: `prerequisites` (`publicOrigin`, `encryptionKey`, `database`, `apiVersion`, `deploymentClient`, `developerToken`), `values` to copy (`redirectUri`, `appName`, `scope`, `adminEmail`, `authorizedDomain`), `projectId`, `steps`, `client` (`source`, `clientId`, `secretLast4`, `valid`; never the secret), `ready`, `connection` |
| `POST /api/sources/google/setup` | instance admin, same origin | `{ projectId?, steps?: { api|explorer|consent|client: boolean } }` |
| `POST /api/sources/google/credentials` | instance admin, same origin | `{ clientId, clientSecret }` (trimmed; ID ends `.apps.googleusercontent.com`); 409 when managed by the deployment; 503 `{prerequisite: "encryptionKey"}` without `TOKEN_ENCRYPTION_KEY` |
| `POST /api/sources/google/credentials/delete` | instance admin, same origin | removes the stored client |
| `GET /api/sources/meta/accounts` | any member | `{ role, connection, accounts[], maxSelected }`; account = `accountId`, `name`, `currency`, `timeZone`, `status`, `businessId`, `businessName`, `eligible`, `selected`, `stale` |
| `POST /api/sources/{google,meta}/remove-account` | admin, same origin | `{ "customerId": "…" }` (Google customer ID / Meta ad account ID): deletes that account of this workspace's connection only if it is stale (not listed by the last refresh), with its selection and project assignment; else 409. Returns the provider's account list |
| `POST /api/sources/meta/accounts` | admin, same origin | `{ "accountIds": [...] }`, 1–25 unique eligible ad accounts of this workspace's connection; 409 `{reconnect: true}` when expired |
| `POST /api/sources/meta/discover` | admin, same origin | reloads the ad account list; 409 `{reconnect: true}` on Graph 190, 502 otherwise |
| `POST /api/sources/meta/disconnect` | admin, same origin | `{ disconnected, revoked }` |
| `POST /api/sources/meta/conversion` | admin, same origin | `{ actionType: string \| null }` (null = default `purchase`); 409 when `META_CONVERSION_ACTION_TYPE` is set; → `{ conversion }` |
| `POST /api/oauth/meta/start` | admin, same origin | optional `{ rerequest: true }` → `{ authorizationUrl }` |
| `GET /api/oauth/meta/callback` | Facebook redirect | always a 303 into the app |
| `GET /api/sources/meta/setup` | instance admin | `prerequisites` (`publicOrigin`, `encryptionKey`, `database`, `apiVersion`, `deploymentApp`, `conversionActionType`), `values` (`redirectUri`, `appDomain`, `authorizedDomain`, `appName`, `scope`, `adminEmail`, `apiVersion`, `localhost`), `appId`, `steps` (`app`, `login`, `access`), `app` (`source`, `appId`, `secretLast4`, `valid`; never the secret), `ready`, `connection` |
| `POST /api/sources/meta/setup` | instance admin, same origin | `{ appId?, steps?: { app\|login\|access: boolean } }`; App ID 409 when managed by the deployment |
| `POST /api/sources/meta/credentials` | instance admin, same origin | `{ appId, appSecret }` (trimmed; numeric / 32 hex); 409 when managed by the deployment; 503 `{prerequisite: "encryptionKey"}` without `TOKEN_ENCRYPTION_KEY` |
| `POST /api/sources/meta/credentials/delete` | instance admin, same origin | removes the stored App Secret (App ID kept) |

`/api/sources.json` `google` also has `clientSource` (`deployment`/`instance`/null)
and `canSetUp` (the viewer is an instance admin). Rediscovery answers 409 with
`setupIssue` (`invalid_client`, `api_disabled`, `access_level`) for setup
problems. A report source with `detail: "setup_required"` carries `setupIssue`
(also `client_missing`).

Projects API (same headers, behind Access):

| Endpoint | Who | Notes |
| --- | --- | --- |
| `GET /api/projects.json` | any member | `{ role \| null, projects: [{ id, name, createdAt, accountIds }], accounts: [{ id, platform, customerId, name, currency, projectId \| null }] }`; `accounts` are the workspace's selected accounts (both providers), `accountIds` those in each project |
| `POST /api/projects/create` | admin, same origin | `{ name }` → the list plus `project: { id, name }`; 400 `{field: "name"}` for an invalid name, 409 `{field: "name"}` when taken, 409 above 100 projects |
| `POST /api/projects/rename` | admin, same origin | `{ projectId, name }`; 404 unknown project, 409 name taken |
| `POST /api/projects/delete` | admin, same origin | `{ projectId }`; its accounts become unassigned; 404 unknown project |
| `POST /api/projects/assign` | admin, same origin | `{ assignments: [{ accountId, projectId \| null }] }` (1–100, unique accounts; null unassigns); 400 for an account or project that is not this workspace's |
| `POST /api/projects/apply` | admin, same origin | accepted suggestions: `{ groups: [{ name, accountIds }] }` (1–100 groups, each account and name once); each group goes into the existing project of that name (ignoring case) or a new one, all in one transaction → the list plus `applied: { created, assigned }` |

Names are trimmed, internal whitespace collapsed, 1–80 characters, without
control or format characters. Members get 403 `Only workspace admins can
change projects.` on every projects POST. Every write is one D1 batch.

Members get 403 `Only workspace admins can change sources.` on every POST;
a missing or foreign `Origin` gets 403 `Cross-origin request rejected.`;
missing D1/admin configuration gets 503 `Sources are not configured.`

## Validation limits

Unit tests use generated signing keys and inline HTTP fixtures, never provider
credentials. `tests/oauth.test.ts`, `discovery.test.ts`, `workspace.test.ts`,
`google-report.test.ts`, `sources.test.ts` and `crypto.test.ts` cover OAuth
state (valid, replayed, expired, other email, other workspace, malformed),
PKCE, missing refresh token/scope, access_denied, encryption (round trip, wrong
key, wrong row, tampering), discovery (single, manager with children, several,
none, failures), two-workspace isolation, revoked grants, member 403s,
cross-origin POSTs and disconnect/revocation. `tests/setup.test.ts` covers
`PUBLIC_ORIGIN` validation, the not-set-up state, the wizard API (admin-only,
progress, credential validation, sealed secret, deployment precedence, client
replacement/removal, missing key), error-aware returns (`invalid_client`,
`SERVICE_DISABLED`, `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION`), Ads error code
extraction and the client-side step mapping. `tests/meta-oauth.test.ts`,
`meta-sources.test.ts`, `meta-setup.test.ts` and `meta.test.ts` cover Meta:
state (valid, replayed, expired, other email, other workspace, Google state,
malformed), code and long-lived exchanges, `debug_token` app check,
`appsecret_proof` correctness on every user-token call, `ads_read` declined and
re-request, invalid App Secret/App ID, redirect mismatch, discovery paging
(cursors only) with disabled/closed accounts and the `business` fallback,
auto-selection, empty accounts, per-account reports and action types, one
account failing, Graph 190 → `expired` with null totals, expiry warning
computation and past-expiry without Graph calls, reconnect keeping selections,
disconnect (`DELETE /me/permissions`, also when it fails), member 403s,
cross-origin POSTs, no secrets in responses, conversion setting, two-workspace
isolation, the wizard API, deployment precedence and migration `0003`
preserving Google rows. `tests/projects.test.ts` covers migration `0004` over existing rows and its
D1-level isolation (composite foreign keys, one project per account, unique
names, cascades), create/rename/assign/delete/apply, member 403s and
cross-origin/non-POST rejections with no rows changed, ids of another
workspace rejected and never listed, rediscovery keeping ids and assignments,
filter validation (format, unknown and foreign ids, account outside the project)
before any provider call, and that only in-scope accounts reach the fake
Google/Meta (a Meta-only scope never contacts Google).
`tests/project-suggestions.test.ts` covers name normalization, suggestion
grouping (existing projects, extensions, assigned accounts untouched), scope
helpers and the dashboard's `project`/`accounts` URL state.
`tests/dashboard.test.ts` covers URL filters, date windows,
formatting (null as `—`), KPI derivation and table sorting/search. `tests/campaign-detail.test.ts`
covers the detail endpoint: request validation, the exact read-only GAQL and
Graph requests (customer, login customer, campaign and window scoping;
`appsecret_proof`, no token in URLs), parsing (budgets, dates, impression
share, reach, daily series, top 10 of 12 ad groups, Performance Max without ad
groups), a Meta campaign of another account and an unknown Google campaign as
404, other-workspace / unselected / other-platform accounts as 404 and
out-of-project as 400 with no provider call, sanitized 502/409 failures, and
Meta budget offsets. `tests/drilldown.test.ts` covers deep-link builders,
derived metrics (cost per conversion null at 0 conversions, shown `—`), sorting
with nulls, CSV escaping and formula guard, the column setting, that every
metric shown in `src/client` has a definition in `metricHelp.ts`, the
scope-derived platforms (a Meta-only project never names Google), and the
detail client's fixed error messages. They cover Access signature/claims/allowlist failures, pagination,
currency handling, missing provider configuration and unavailable/partial source
semantics. Local build and Wrangler `deploy --dry-run` validate packaging only:
they do not prove live OAuth grants, Ads permissions, current provider API
availability, Access policy coverage, DNS or account-level deployment permissions.
Those require separate parent-authorized live validation, including a real
consent with the production OAuth client and a seven-day report checked
against the Google Ads UI in the account timezone. No commit, push or
deployment is performed by this conversion.
