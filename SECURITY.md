# Security policy

## Supported versions

OpenADS is early software. Security fixes are made on the latest release
(currently 0.0.1) and `main`. Please update your instance with `git pull` and
`npm run deploy:cloudflare`.

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub Security Advisories:
open the repository's **Security** tab → **Report a vulnerability**
(<https://github.com/RapidWombat-com/OpenADS/security/advisories/new>).

Do not open a public issue, pull request or discussion for a vulnerability.

Include what you can:

- the affected version or commit,
- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- any suggested fix.

Never include real access tokens, secrets or data from ad accounts. We will
acknowledge the report, keep you updated while we investigate, and credit you in
the advisory if you wish once a fix is available.

## Scope

In scope: the code in this repository — the Access gate and its verification
in the Worker, the OAuth flows, credential encryption and storage, the
Content Security Policy, workspace and project isolation, and the deploy
script.

Out of scope: weaknesses of Cloudflare, Google or Meta themselves, and
misconfigured deployments (for example an Access application that does not
cover the whole host name; see
[the self-hosting guide](docs/SELF_HOSTING_CLOUDFLARE.md#verification-checklist)).
