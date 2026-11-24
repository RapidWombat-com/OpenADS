// Links from a campaign row to the ad platform's own UI (opened in a new tab
// with rel="noopener noreferrer"). Only provider IDs from the report go in, and
// only numeric ones; anything else gives no link.
//
// Meta: Ads Manager accepts the ad account (act=<numeric id>) and pre-selects
// campaigns or ad sets with selected_campaign_ids / selected_adset_ids — the
// same URLs Ads Manager itself produces.
//
// Google: the Ads UI identifies the account by an internal ID (ocid) that the
// Google Ads API does not expose, and Google documents no stable link to one
// campaign. The undocumented `__e=<customer ID>` parameter selects the account;
// we link to that account's Campaigns list and say so in the tooltip instead of
// promising a campaign-level link that may land elsewhere.
import type { Platform } from './report.ts';

const NUMERIC = /^[1-9]\d{0,19}$/;

export interface DeepLink {
  href: string;
  /** Button text / accessible name. */
  label: string;
  /** Tooltip: where the link goes. */
  hint: string;
}

export function metaCampaignUrl(accountId: string, campaignId: string): string | null {
  if (!NUMERIC.test(accountId) || !NUMERIC.test(campaignId)) return null;
  const url = new URL('https://adsmanager.facebook.com/adsmanager/manage/campaigns');
  url.searchParams.set('act', accountId);
  url.searchParams.set('selected_campaign_ids', campaignId);
  return url.href;
}

export function metaAdSetUrl(accountId: string, adSetId: string): string | null {
  if (!NUMERIC.test(accountId) || !NUMERIC.test(adSetId)) return null;
  const url = new URL('https://adsmanager.facebook.com/adsmanager/manage/adsets');
  url.searchParams.set('act', accountId);
  url.searchParams.set('selected_adset_ids', adSetId);
  return url.href;
}

/** The Campaigns list of one Google Ads account (customer ID digits, no dashes). */
export function googleAccountCampaignsUrl(customerId: string): string | null {
  const id = customerId.replaceAll('-', '');
  if (!/^\d{10}$/.test(id)) return null;
  const url = new URL('https://ads.google.com/aw/campaigns');
  url.searchParams.set('__e', id);
  return url.href;
}

/** The "Open in …" link of a campaign row, or null when its IDs are not usable. */
export function campaignLink(row: { platform: Platform; id: string; accountId?: string }): DeepLink | null {
  if (!row.accountId) return null;
  if (row.platform === 'meta') {
    const href = metaCampaignUrl(row.accountId, row.id);
    return href ? { href, label: 'Open in Ads Manager', hint: 'Opens this campaign in Meta Ads Manager (new tab).' } : null;
  }
  const href = googleAccountCampaignsUrl(row.accountId);
  return href ? {
    href,
    label: 'Open in Google Ads',
    hint: 'Opens this account’s campaigns in Google Ads (new tab). Google has no reliable link to a single campaign, so find it there by name.',
  } : null;
}
