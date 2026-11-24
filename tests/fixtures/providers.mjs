// TEST/PREVIEW FIXTURES ONLY. Fictional providers in their wire formats, used by
// scripts/preview.mjs --fixtures. Never imported by src/.
// Google Ads (OAuth, discovery, reports) is answered by the fake Google in
// ./google.ts; Meta Ads (Facebook Login, Graph API) by the fake Meta in ./meta.ts.
import { FIXTURE_CLIENT_ID, FIXTURE_CLIENT_SECRET, fakeGoogle } from './google.ts';
import { FIXTURE_META_APP_ID, FIXTURE_META_APP_SECRET, fakeMeta, META_ACCOUNTS } from './meta.ts';

/** The fake Google's OAuth client: paste it in the setup wizard, or use --google-env. */
export const fixtureGoogleClient = Object.freeze({
  GOOGLE_OAUTH_CLIENT_ID: FIXTURE_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET: FIXTURE_CLIENT_SECRET,
});

/** The fake Meta's app: paste it in the Meta setup wizard, or use --meta-env. */
export const fixtureMetaApp = Object.freeze({
  META_APP_ID: FIXTURE_META_APP_ID,
  META_APP_SECRET: FIXTURE_META_APP_SECRET,
});

export const SCENARIOS = [
  'live', 'partial', 'unavailable', 'empty', 'revoked', 'api-disabled', 'not-approved',
  'meta-expired', 'meta-expiring', 'meta-invalid-secret',
];
export const ACCOUNT_SCENARIOS = ['multi', 'single', 'none'];

/**
 * scenario: 'live' (all available), 'partial' (one Meta ad account fails),
 * 'unavailable' (every report fails), 'empty' (no campaigns anywhere), 'revoked'
 * (Google rejects the stored grant with invalid_grant), 'api-disabled' /
 * 'not-approved' (Google Cloud project problems), 'meta-expired' (Graph answers
 * 190 for the stored token), 'meta-expiring' (long-lived tokens last 5 days, so
 * Sources and the dashboard warn) or 'meta-invalid-secret' (Meta refuses the
 * App Secret on the code exchange). accounts / metaAccounts: what the Google
 * account / Facebook user can see.
 */
export function fixtureProviders(scenario = 'live', accounts = 'multi', metaAccounts = 'multi') {
  const google = fakeGoogle({
    accounts,
    persistentGrants: true,
    revoked: scenario === 'revoked',
    emptyReports: scenario === 'empty',
    failReports: scenario === 'unavailable' ? ['4445556666', '7778889999'] : [],
    ...(scenario === 'api-disabled' ? { adsError: 'service_disabled' } : {}),
    ...(scenario === 'not-approved' ? { adsError: 'not_approved' } : {}),
  });
  const meta = fakeMeta({
    accounts: metaAccounts,
    persistentTokens: true,
    expired: scenario === 'meta-expired',
    emptyInsights: scenario === 'empty',
    failInsights: scenario === 'unavailable' ? Object.values(META_ACCOUNTS).map(account => account.id)
      : scenario === 'partial' ? [META_ACCOUNTS.brand.id] : [],
    ...(scenario === 'meta-expiring' ? { tokenLifetime: 5 * 86_400 } : {}),
    ...(scenario === 'meta-invalid-secret' ? { appSecret: 'ffffffffffffffffffffffffffffffff' } : {}),
  });
  const fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === 'oauth2.googleapis.com' || url.hostname === 'googleads.googleapis.com') return google.fetch(input, init);
    if (url.hostname === 'graph.facebook.com') return meta.fetch(input, init);
    throw new Error('Unexpected fixture request');
  };
  return { fetch, google, meta };
}
