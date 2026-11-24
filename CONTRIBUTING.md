# Contributing to OpenADS

Thanks for helping. Clear issues and small, focused pull requests are the best
way to contribute.

## Issues

- **Bugs**: what you did, what you expected, what happened, and your setup
  (OpenADS version from the sidebar footer, browser, Google Ads and/or Meta Ads).
  Never paste tokens, secrets, account IDs or report data from real accounts.
- **Report differences**: if a figure does not match Google Ads or Ads Manager,
  say which metric, date range and account timezone, and how far off it is.
- **Security problems**: do not open a public issue; see [SECURITY.md](SECURITY.md).

## Pull requests

1. Open an issue first for anything bigger than a small fix, so we can agree on
   the approach.
2. Use Node 26.13+ and install with `npm ci --ignore-scripts`.
3. Keep changes focused and follow the existing style. Add or update tests for
   behavior changes; tests use fixtures only (no real accounts, names or IDs).
4. Run the checks locally — there is no CI, so this is the gate:

   ```sh
   npm test
   npm run build
   npm run test:integration
   WRANGLER_SEND_METRICS=false npm run dry-run
   ```

5. Update the docs (`README.md`, `docs/`) and add a line under `[Unreleased]`
   in `CHANGELOG.md` when users would notice the change.

Architecture, security model, CSP and API contract are described in
[`docs/dev.md`](docs/dev.md). `npm run preview:local -- --fixtures` runs the
built app locally against fake Google and Meta APIs.

## Ground rules

- OpenADS stays **read-only**: no calls that change anything in ad accounts.
- Secrets and provider tokens never reach the browser, responses or logs.
- No telemetry, analytics or third-party scripts.
- No CI/CD or deploy hooks in this repository. Each operator deploys their own
  instance manually with `npm run deploy:cloudflare`.

## License

By contributing, you agree that your contributions are licensed under the
[AGPL-3.0](LICENSE), the license of this project. Code adapted from other
projects must have a compatible license and be listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
