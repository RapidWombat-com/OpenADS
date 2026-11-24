import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSeries, formatTick, formatValue, microsToMinor, niceTicks, summarize, trendStats, xTickIndexes, type DayFigures,
} from '../src/client/lib/trendChart.ts';

/** `spendCents` (USD): stored as integer micros (1 cent = 10,000 micros). */
const day = (date: string, spendCents: number, clicks = 0, impressions = 0, conversions = 0): DayFigures =>
  ({ date, impressions, clicks, spendMicros: Math.round(spendCents * 10_000), conversions });
const micros = (cents: number) => cents * 10_000;

test('niceTicks: rounded steps from zero covering the maximum', () => {
  assert.deepEqual(niceTicks(14_000, 4), { ticks: [0, 5000, 10_000, 15_000], step: 5000 });
  assert.deepEqual(niceTicks(0), { ticks: [0, 1], step: 1 });
  assert.deepEqual(niceTicks(0.0231, 4).ticks.at(-1)! >= 0.0231, true);
  assert.deepEqual(niceTicks(9, 4), { ticks: [0, 5, 10], step: 5 });
});

test('formatTick: compact, in the account currency (spend values are micros)', () => {
  assert.equal(formatTick('spend', micros(120_000), micros(40_000), 'USD'), '$1.2k');
  assert.equal(formatTick('spend', micros(120_000), micros(40_000), 'EUR'), '€1.2k');
  assert.equal(formatTick('spend', 0, micros(5000), 'USD'), '$0');
  assert.equal(formatTick('spend', micros(5000), micros(5000), 'USD'), '$50');
  assert.equal(formatTick('spend', micros(250_000_000), micros(50_000_000), 'USD'), '$2.5M');
  assert.equal(formatTick('spend', 30_000_000_000, 10_000_000_000, 'JPY'), '¥30k');
  assert.equal(formatTick('cpc', micros(150), micros(50), 'USD'), '$1.5');
  assert.equal(formatTick('cpc', micros(5), micros(5), 'USD'), '$0.05');
  assert.equal(formatTick('clicks', 1500, 500, 'USD'), '1.5k');
  assert.equal(formatTick('clicks', 40, 10, 'USD'), '40');
  assert.equal(formatTick('ctr', 0.05, 0.01, 'USD'), '5%');
  assert.equal(formatTick('ctr', 0.0125, 0.0025, 'USD'), '1.3%');
});

test('formatValue: full precision per currency; null is a dash', () => {
  assert.equal(formatValue('spend', micros(287_550), 'USD'), '$2,875.50');
  assert.equal(formatValue('spend', micros(14_000), 'EUR'), '€140.00');
  assert.equal(formatValue('spend', 1_400_000_000, 'JPY'), '¥1,400');
  assert.equal(formatValue('ctr', 0.0231, 'USD'), '2.31%');
  assert.equal(formatValue('clicks', null, 'USD'), '—');
});

test('xTickIndexes: daily for a week, weekly for 30/90 days, never more than fit', () => {
  assert.deepEqual(xTickIndexes(7, 10), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(xTickIndexes(30, 12), [0, 7, 14, 21, 28]);
  assert.deepEqual(xTickIndexes(90, 20), Array.from({ length: 13 }, (_, i) => i * 7));
  assert.deepEqual(xTickIndexes(90, 6), [0, 21, 42, 63, 84]);
  assert.deepEqual(xTickIndexes(7, 3), [0, 3, 6]);
  assert.deepEqual(xTickIndexes(0, 5), []);
});

test('buildSeries: zero days stay zero, days missing from the data are gaps', () => {
  const series = buildSeries([day('2026-03-01', 500, 5), day('2026-03-02', 0), day('2026-03-04', 900, 9)], 'spend');
  assert.deepEqual(series, [
    { date: '2026-03-01', value: micros(500) }, { date: '2026-03-02', value: 0 },
    { date: '2026-03-03', value: null }, { date: '2026-03-04', value: micros(900) },
  ]);
  assert.deepEqual(buildSeries([], 'spend'), []);
});

test('buildSeries: a rate without a denominator is a gap, not zero', () => {
  const daily = [day('2026-03-01', 500, 5, 100), day('2026-03-02', 0, 0, 0), day('2026-03-03', 300, 0, 50)];
  assert.deepEqual(buildSeries(daily, 'ctr').map(point => point.value), [0.05, null, 0]);
  assert.deepEqual(buildSeries(daily, 'cpc').map(point => point.value), [micros(100), null, null]);
});

test('trendStats: total, average over days with data, peak', () => {
  const daily = [day('2026-03-01', 500), day('2026-03-02', 0), day('2026-03-04', 1300)];
  const points = buildSeries(daily, 'spend');
  const stats = trendStats(points, 'spend', daily);
  assert.equal(stats.total, micros(1800));
  assert.equal(stats.average, micros(600), 'the gap day is not averaged in as zero');
  assert.deepEqual(stats.peak, { date: '2026-03-04', value: micros(1300) });
  assert.equal(stats.days, 3);
});

test('trendStats: rates are overall (weighted), not a mean of daily rates', () => {
  const daily = [day('2026-03-01', 100, 1, 10), day('2026-03-02', 900, 9, 990)];
  const stats = trendStats(buildSeries(daily, 'ctr'), 'ctr', daily);
  assert.equal(stats.total, 10 / 1000);
  assert.equal(stats.average, 10 / 1000);
  assert.deepEqual(stats.peak, { date: '2026-03-01', value: 0.1 });
  assert.deepEqual(trendStats([], 'spend', []), { total: null, average: null, peak: null, days: 0 });
});

test('summarize: range, total, peak and gaps in one sentence', () => {
  const daily = [day('2026-11-02', 100_000), day('2026-11-03', 140_000), day('2026-11-05', 47_500)];
  const points = buildSeries(daily, 'spend');
  const text = summarize('spend', 'Spend', points, trendStats(points, 'spend', daily), 'USD');
  assert.equal(text, 'Spend from Nov 2 to Nov 5, total $2,875.00, peak $1,400.00 on Nov 3, 1 day without data');
  assert.equal(summarize('spend', 'Spend', [], trendStats([], 'spend', []), 'USD'), 'Spend: no data.');
});

test('daily spend is summed as integer micros and rounded once, for display: the chart total is the campaign spend', () => {
  // Two days of 4,900 micros (USD): 0.49 cents each, $0.01 in total (not 2 × $0.00).
  const daily = [day('2026-11-01', 0.49), day('2026-11-02', 0.49)];
  const stats = trendStats(buildSeries(daily, 'spend'), 'spend', daily);
  assert.equal(stats.total, 9_800);
  assert.equal(microsToMinor(stats.total!, 'USD'), 1);
  assert.equal(formatValue('spend', stats.total, 'USD'), '$0.01');
  assert.match(summarize('spend', 'Spend', buildSeries(daily, 'spend'), stats, 'USD'), /total \$0\.01/);
  // Half a minor unit rounds up, in integer arithmetic, per currency.
  assert.equal(microsToMinor(5_000, 'USD'), 1);
  assert.equal(microsToMinor(4_999, 'USD'), 0);
  assert.equal(microsToMinor(1_234_565_000, 'USD'), 123_457);
  assert.equal(microsToMinor(1_500_000, 'JPY'), 2);
  assert.equal(microsToMinor(1_234_500, 'KWD'), 1_235);
  assert.equal(microsToMinor(Number.MAX_SAFE_INTEGER, 'USD'), 900_719_925_474);
});

test('93 days of large fractional-cent spend: the integer sum matches the server where float cents drifted', () => {
  // Deterministic days of about $100k with fractional cents (Google cost_micros),
  // the last day making the total land exactly on half a cent.
  let seed = 46;
  const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
  const days: number[] = [];
  for (let i = 0; i < 92; i++) days.push(100_000_000_000 + (next() % 1_000_000_000) * 7 + (next() % 9_999));
  const partial = days.reduce((all, value) => all + BigInt(value), 0n) + 100_000_000_000n;
  days.push(100_000_000_000 + Number((5_000n - (partial % 10_000n) + 10_000n) % 10_000n));
  const summed = days.reduce((all, value) => all + BigInt(value), 0n);
  assert.equal(summed % 10_000n, 5_000n, 'exactly half a cent');
  const server = Number((summed + 5_000n) / 10_000n); // google.ts microsToMinor of the summed micros
  // The old client path (fractional cents as floats, summed, snapped to 6 decimals) is off by a cent here.
  const floatCents = days.reduce((all, value) => all + value / 10_000, 0);
  assert.equal(Math.round(Number(floatCents.toFixed(6))), server - 1, 'float summing drifted');

  const start = Date.UTC(2026, 0, 1);
  const daily = days.map((value, index) => ({
    date: new Date(start + index * 86_400_000).toISOString().slice(0, 10), impressions: 0, clicks: 0, spendMicros: value, conversions: 0,
  }));
  const points = buildSeries(daily, 'spend');
  assert.equal(points.length, 93);
  const stats = trendStats(points, 'spend', daily);
  assert.ok(Number.isSafeInteger(stats.total));
  assert.equal(BigInt(stats.total!), summed);
  assert.equal(microsToMinor(stats.total!, 'USD'), server);
  assert.equal(formatValue('spend', stats.total, 'USD'), `$${(server / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
});
