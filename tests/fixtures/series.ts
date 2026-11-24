// TEST/PREVIEW FIXTURES ONLY. Deterministic splits of fixture totals across days
// and breakdown rows, so a fixture campaign's daily series and ad sets/ad groups
// add up to the same totals its campaign row reports. Never imported by src/.

const DAY = 86_400_000;

/** Every date of an inclusive window. */
export function datesOf(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let time = Date.parse(`${start}T00:00:00Z`); time <= Date.parse(`${end}T00:00:00Z`); time += DAY) {
    dates.push(new Date(time).toISOString().slice(0, 10));
  }
  return dates;
}

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Daily weights shaped like a real campaign: quieter weekends, a slow drift,
 * seeded noise, for some seeds a launch ramp over the first days and, for
 * others, a short paused gap (weight 0). `salt` varies only the per-metric
 * jitter, so impressions, clicks and spend share one shape (same zero days)
 * without being proportional.
 */
export function weights(dates: string[], seed: number, salt = 0): number[] {
  const shape = random(seed * 7919 + 101);
  const jitter = random(seed * 7919 + salt * 104_729 + 3);
  const ramp = seed % 3 !== 0;
  const pausedFrom = seed % 4 === 1 && dates.length >= 21 ? 10 + (seed % 5) : -1;
  return dates.map((date, index) => {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const noise = 1 + (shape() - 0.5) * 0.4;
    const metricJitter = 1 + (jitter() - 0.5) * 0.24;
    if (index >= pausedFrom && index < pausedFrom + 4 && pausedFrom >= 0) return 0;
    const weekend = weekday === 0 || weekday === 6 ? 0.7 : 1;
    const launch = ramp && index < 5 ? 0.25 + index * 0.17 : 1;
    const drift = 1 + 0.12 * Math.sin(index / 6 + seed);
    return Math.max(0.05, weekend * launch * drift * noise * metricJitter);
  });
}

/** Splits a non-negative integer total in proportion to `parts` (sums exactly to `total`). */
export function splitInteger(total: bigint, parts: number[]): bigint[] {
  const sum = parts.reduce((a, b) => a + b, 0);
  const shares = parts.map(part => BigInt(Math.floor((Number(total) * part) / sum)));
  const used = shares.reduce((a, b) => a + b, 0n);
  if (shares.length) shares[shares.length - 1] = shares[shares.length - 1]! + (total - used);
  return shares;
}
