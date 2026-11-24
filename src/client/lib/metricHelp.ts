// One place for what every metric means: the `?` next to a KPI card, a table
// header or a campaign-detail figure shows this text. Plain English, with the
// formula and the platform nuance, matching what the adapters actually read
// (src/lib/providers/google.ts, meta.ts): Google `metrics.*`, Meta Insights fields.

export type MetricKey =
  | 'spend' | 'impressions' | 'clicks' | 'ctr' | 'cpc' | 'cpm' | 'conversions' | 'costPerConversion'
  | 'conversionRate' | 'reach' | 'frequency' | 'status' | 'searchImpressionShare' | 'budget';

export interface MetricHelp {
  /** The label shown in the UI. */
  label: string;
  /** The name read out by "What is …?" (expanded abbreviation). */
  name: string;
  /** One or two short sentences; formula and platform nuance included. */
  text: string;
}

export const METRIC_HELP: Record<MetricKey, MetricHelp> = {
  spend: {
    label: 'Spend',
    name: 'Spend',
    text: 'Money the ad platform charged, in the ad account’s currency (Google metrics.cost_micros, Meta spend). Never added up across currencies.',
  },
  impressions: {
    label: 'Impressions',
    name: 'Impressions',
    text: 'How many times your ads were shown, as counted by Google Ads or Meta.',
  },
  clicks: {
    label: 'Clicks',
    name: 'Clicks',
    text: 'Clicks counted by the platform. Google: metrics.clicks. Meta: the Insights “clicks” field, which is all clicks (including reactions and profile clicks), not just link clicks.',
  },
  ctr: {
    label: 'CTR',
    name: 'CTR (click-through rate)',
    text: 'Click-through rate: Clicks ÷ Impressions.',
  },
  cpc: {
    label: 'CPC',
    name: 'CPC (cost per click)',
    text: 'Cost per click: Spend ÷ Clicks, per currency.',
  },
  cpm: {
    label: 'CPM',
    name: 'CPM (cost per mille)',
    text: 'Cost per 1,000 impressions: Spend ÷ Impressions × 1,000, per currency.',
  },
  conversions: {
    label: 'Conversions',
    name: 'Conversions',
    text: 'Platform-reported conversions: Google metrics.conversions; Meta the action type chosen in Sources (default “purchase”). Not deduplicated across platforms and not revenue.',
  },
  costPerConversion: {
    label: 'Cost/conv.',
    name: 'Cost per conversion (CPA)',
    text: 'Cost per conversion (CPA): Spend ÷ Conversions, per currency. Shows — when there were no conversions.',
  },
  conversionRate: {
    label: 'Conv. rate',
    name: 'Conversion rate',
    text: 'Conversion rate: Conversions ÷ Clicks. Shows — without clicks.',
  },
  reach: {
    label: 'Reach',
    name: 'Reach',
    text: 'Meta only: the number of unique people who saw your ads in this date range (estimated by Meta). Google Ads shows —.',
  },
  frequency: {
    label: 'Frequency',
    name: 'Frequency',
    text: 'Meta only: the average number of times each person saw your ads: Impressions ÷ Reach.',
  },
  status: {
    label: 'Status',
    name: 'Status',
    text: 'Delivery status today, as the platform reports it: Active, Paused, Removed (deleted), Archived, In review or With issues. Meta uses the campaign’s effective status.',
  },
  searchImpressionShare: {
    label: 'Search impr. share',
    name: 'Search impression share',
    text: 'Google Search campaigns only: impressions received ÷ impressions you were eligible for (metrics.search_impression_share). Google reports anything under 10% as 9.99%.',
  },
  budget: {
    label: 'Budget',
    name: 'Budget',
    text: 'The campaign’s own budget in the account currency, per day or for its lifetime. Meta campaigns that budget per ad set have none here.',
  },
};

export const metricHelp = (key: MetricKey): MetricHelp => METRIC_HELP[key];
