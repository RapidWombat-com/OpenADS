# Changelog

All notable changes to OpenADS are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.1] - 2026-11-24

First public release.

### Added

- Self-hosted dashboard on Cloudflare Workers (TanStack Start, React, Tailwind,
  Base UI), gated by Cloudflare Access: every request is checked by Access and
  the Access token is verified again by the Worker, with an email allowlist,
  admins and members, and a strict nonce-based Content Security Policy.
- Google Ads in-app setup wizard for your own Google Cloud project and OAuth
  client (project ID, API, Explorer access, consent screen, client, connect),
  with progress saved server-side.
- Meta Ads in-app setup wizard for your own Meta app in Development mode
  (Facebook Login redirect URI, `ads_read`, app roles, App ID and App Secret).
- Credentials encrypted at rest in D1 (AES-256-GCM with `TOKEN_ENCRYPTION_KEY`):
  OAuth client secrets, Google grants and Meta tokens never reach the browser.
- Account pickers for Google Ads (direct and via manager accounts) and Meta Ads
  (grouped by business portfolio), searchable, up to 25 accounts per platform.
  Refreshing the list never deletes a selected or project-assigned account: one
  the provider no longer lists is kept, marked "not confirmed", until an admin
  removes it.
- Sources page with connection status, reconnect and disconnect, Meta token
  expiry warnings and the Meta action type counted as conversions. Reconnecting
  as a different Google account or Facebook user is not applied until an admin
  confirms it on Sources (the new sign-in waits encrypted for up to 10 minutes):
  accounts both logins can access keep their selection and project, the others
  are listed and removed only on confirm; cancel keeps the current connection.
- Projects that group ad accounts by brand or client, a project switcher in the
  sidebar, a Projects page with per-account assignment, and project suggestions
  from matching account names.
- Live campaign reporting across Google Ads and Meta Ads: spend and CPC per
  currency, impressions, clicks, CTR and conversions per platform; nothing is
  converted or summed across currencies or platforms, and unreported values show
  `—`.
- Filters kept in the URL: 7, 30 and 90 days or a custom window, platform,
  project and accounts. Presets end on the last day that is complete in every
  account's time zone; a custom window that reaches an unfinished day is marked
  "Includes today (incomplete)".
- Campaign table with sorting, search, optional columns (CPM, conversion rate,
  reach, frequency) and CSV export.
- Campaign drill-down: budget, schedule, daily spend and click sparklines, all
  metrics and the top ad sets / ad groups by spend; deep links to Meta Ads
  Manager and Google Ads.
- Source status per platform (live, not configured, unavailable, partial) with
  one fixing action each, metric help tooltips and toast notifications.
- One-command Cloudflare deploy (`npm run deploy:cloudflare`): creates the D1
  database, applies migrations, generates the encryption key (with a local
  backup copy to move to a password manager), deploys to a custom domain and
  verifies that Access protects it. It never generates a key over data an
  earlier key encrypted (restore the old key, or `--reset-encrypted-data`), holds a
  local lock so two deploys from one checkout cannot race, claims the key id in
  D1 (first deploy wins) so deploys from separate checkouts cannot either, never
  overwrites a key or a key backup, makes its generated config files private
  (0600), and runs Wrangler with sanitized, non-debug logs.
- Local preview harness with fixture Google and Meta APIs (its `--live` mode
  listens on 127.0.0.1 only behind a one-time sign-in link with a per-port
  cookie, and keeps its database and key in its own owner-only
  `.wrangler/preview-live/`), and self-hosting guides for Cloudflare, Google Ads
  and Meta Ads.

### Known limitations

- Reports are read live from the provider APIs on every load; there is no
  sync, history storage or caching.
- Cloudflare is the only supported hosting target, and Cloudflare Access is
  required for sign-in (OpenADS has no login of its own).
- One workspace per instance.
- Meta apps in Development mode only reach people with a role on the app; Meta
  tokens last about 60 days and must be reconnected.
- Google Ads Explorer access allows 2,880 API operations per day on production
  accounts.
- Google Ads links open the account's campaign list, not the campaign itself
  (Google documents no campaign deep link).
- Custom date windows are limited to 93 days.
- `npm run deploy:cloudflare` makes the generated `dist/server/wrangler.json`
  private (0600) only after Vite has finished writing it, so it is readable with
  the default umask for a brief window during the build.
- Validated against live Google Ads and Meta Ads accounts; please report any
  differences from the Google Ads UI or Ads Manager.

[Unreleased]: https://github.com/RapidWombat-com/OpenADS/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/RapidWombat-com/OpenADS/releases/tag/v0.0.1
