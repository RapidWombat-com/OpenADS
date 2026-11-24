import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "cn";
import {
  TREND_METRICS,
  buildSeries,
  formatAxisDate,
  formatTick,
  formatValue,
  formatWeekdayDate,
  isRate,
  niceTicks,
  summarize,
  trendStats,
  xTickIndexes,
  type DayFigures,
  type TrendMetric,
} from "@/client/lib/trendChart";

/**
 * Daily trend of one campaign: a metric switcher over a single series (bars for
 * spend-like metrics, a line for rates). Hand-rolled SVG with no inline styles
 * or injected <style> elements, so the nonce CSP holds. Loaded lazily.
 *
 * One series at a time (rather than spend bars + clicks line on two axes) because
 * two y-axes invite false correlations and cannot be read on a phone.
 */
export default function TrendChart({ daily, currency }: { daily: DayFigures[]; currency: string }) {
  const [metric, setMetric] = useState<TrendMetric>("spend");
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const label = TREND_METRICS.find((item) => item.key === metric)!.label;
  const points = useMemo(() => buildSeries(daily, metric), [daily, metric]);
  const stats = useMemo(() => trendStats(points, metric, daily), [points, metric, daily]);
  const summary = summarize(metric, label, points, stats, currency);

  function onTabKey(event: KeyboardEvent, index: number) {
    const move = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : event.key === "Home" ? -index : event.key === "End" ? TREND_METRICS.length : 0;
    if (!move) return;
    event.preventDefault();
    const next = Math.min(TREND_METRICS.length - 1, Math.max(0, index + move));
    setMetric(TREND_METRICS[next]!.key);
    tabs.current[next]?.focus();
  }

  return (
    <figure className="min-w-0 space-y-2 rounded-lg border border-border bg-card px-3 py-3 md:px-4" data-testid="trend-chart">
      <figcaption className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div role="tablist" aria-label="Chart metric" className="no-scrollbar -mx-1 flex gap-0.5 overflow-x-auto px-1 sm:gap-1">
          {TREND_METRICS.map((item, index) => (
            <button
              key={item.key}
              ref={(node) => { tabs.current[index] = node; }}
              type="button"
              role="tab"
              id={`${id}-${item.key}`}
              aria-selected={item.key === metric}
              aria-controls={`${id}-panel`}
              tabIndex={item.key === metric ? 0 : -1}
              onClick={() => setMetric(item.key)}
              onKeyDown={(event) => onTabKey(event, index)}
              className={cn(
                "shrink-0 rounded-md px-2 py-1 text-xs sm:px-2.5 font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                item.key === metric ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <p className="flex items-baseline gap-3 text-xs text-muted-foreground tabular-nums">
          <span>
            {isRate(metric) ? "Overall " : "Total "}
            <strong className="text-sm font-semibold text-foreground">{formatValue(metric, stats.total, currency)}</strong>
          </span>
          {!isRate(metric) && stats.average !== null ? <span>avg {formatValue(metric, stats.average, currency)}/day</span> : null}
        </p>
      </figcaption>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${metric}`}>
        <Plot key={metric} metric={metric} points={points} currency={currency} summary={summary} average={stats.average} />
      </div>
    </figure>
  );
}

const MARGIN = { top: 10, bottom: 22, right: 10 };

function Plot({
  metric,
  points,
  currency,
  summary,
  average,
}: {
  metric: TrendMetric;
  points: ReturnType<typeof buildSeries>;
  currency: string;
  summary: string;
  average: number | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [active, setActive] = useState<number | null>(null);
  const bars = !isRate(metric);

  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const measure = () => setSize({ width: Math.round(node.clientWidth), height: Math.round(node.clientHeight) });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const known = points.filter((point) => point.value !== null);
  const peakValue = Math.max(0, ...known.map((point) => point.value!), average ?? 0);
  const { ticks, step } = niceTicks(peakValue);
  const top = ticks[ticks.length - 1]!;
  const tickLabels = ticks.map((tick) => formatTick(metric, tick, step, currency));
  const left = Math.max(...tickLabels.map((text) => text.length)) * 6.4 + 12;
  const { width, height } = size;
  const plotW = Math.max(0, width - left - MARGIN.right);
  const plotH = Math.max(0, height - MARGIN.top - MARGIN.bottom);
  const count = points.length;
  const band = count ? plotW / count : 0;
  const x = (index: number) => left + (bars ? band * (index + 0.5) : count > 1 ? (plotW * index) / (count - 1) : plotW / 2);
  const y = (value: number) => MARGIN.top + plotH - (value / top) * plotH;
  const labelIndexes = xTickIndexes(count, Math.max(2, Math.floor(plotW / 64)));
  const barWidth = Math.max(2, Math.min(22, band * 0.68));

  function nearest(clientX: number, rect: DOMRect) {
    if (!count || !rect.width) return null;
    const px = clientX - rect.left;
    if (bars) return Math.min(count - 1, Math.max(0, Math.floor((px - left) / band)));
    return Math.min(count - 1, Math.max(0, Math.round(((px - left) / plotW) * (count - 1))));
  }
  function pointer(event: PointerEvent<HTMLDivElement>) {
    const index = nearest(event.clientX, event.currentTarget.getBoundingClientRect());
    if (index !== null) setActive(index);
  }
  function key(event: KeyboardEvent<HTMLDivElement>) {
    if (!count) return;
    const moves: Record<string, number> = {
      ArrowRight: (active ?? -1) + 1, ArrowLeft: (active ?? count) - 1, Home: 0, End: count - 1,
    };
    if (event.key === "Escape") { setActive(null); return; }
    if (!(event.key in moves)) return;
    event.preventDefault();
    setActive(Math.min(count - 1, Math.max(0, moves[event.key]!)));
  }

  // Line segments, broken at gaps.
  const segments: { x: number; y: number; index: number }[][] = [];
  if (!bars) {
    let run: { x: number; y: number; index: number }[] = [];
    points.forEach((point, index) => {
      if (point.value === null) {
        if (run.length) segments.push(run);
        run = [];
      } else {
        run.push({ x: x(index), y: y(point.value), index });
      }
    });
    if (run.length) segments.push(run);
  }

  const current = active === null ? null : points[active] ?? null;
  const tipLines = current ? [formatWeekdayDate(current.date), current.value === null ? "No data" : formatValue(metric, current.value, currency)] : [];
  const tipW = Math.max(...tipLines.map((line) => line.length), 0) * 6.6 + 18;
  const tipX = active === null ? 0 : Math.min(Math.max(x(active) - tipW / 2, left), left + plotW - tipW);

  return (
    <div
      ref={box}
      tabIndex={0}
      role="group"
      aria-roledescription="chart"
      aria-label={`${summary}. Use the arrow keys to read individual days.`}
      className="relative h-[140px] w-full cursor-crosshair touch-pan-y rounded-md text-xs outline-none select-none focus-visible:ring-2 focus-visible:ring-ring md:h-[180px]"
      onPointerMove={pointer}
      onPointerDown={pointer}
      onPointerLeave={() => setActive(null)}
      onBlur={() => setActive(null)}
      onKeyDown={key}
    >
      <span className="sr-only" aria-live="polite">
        {current ? `${formatWeekdayDate(current.date)}: ${current.value === null ? "no data" : formatValue(metric, current.value, currency)}` : ""}
      </span>
      {width > 0 && height > 0 ? (
        <svg width={width} height={height} aria-hidden className="block overflow-visible">
          {ticks.map((tick, index) => (
            <g key={tick}>
              <line x1={left} x2={left + plotW} y1={y(tick)} y2={y(tick)} className={index === 0 ? "stroke-border" : "stroke-border/60"} strokeWidth={1} />
              <text x={left - 8} y={y(tick)} textAnchor="end" dominantBaseline="central" className="fill-muted-foreground">{tickLabels[index]}</text>
            </g>
          ))}
          {labelIndexes.map((index) => (
            <text key={index} x={x(index)} y={height - 5} textAnchor={index === 0 && !bars ? "start" : "middle"} className="fill-muted-foreground">
              {formatAxisDate(points[index]!.date)}
            </text>
          ))}

          {active !== null && current ? (
            <line x1={x(active)} x2={x(active)} y1={MARGIN.top} y2={MARGIN.top + plotH} className="stroke-foreground/30" strokeDasharray="3 3" />
          ) : null}

          {bars
            ? points.map((point, index) => {
                if (point.value === null) return null;
                const h = Math.max(point.value > 0 ? 1.5 : 1, (point.value / top) * plotH);
                return (
                  <rect
                    key={point.date}
                    x={x(index) - barWidth / 2}
                    y={MARGIN.top + plotH - h}
                    width={barWidth}
                    height={h}
                    rx={Math.min(2, barWidth / 2)}
                    className={cn(point.value === 0 ? "fill-muted-foreground/40" : "fill-primary", active === index ? "opacity-100" : active !== null ? "opacity-60" : "opacity-90")}
                  />
                );
              })
            : segments.map((run) => (
                <g key={run[0]!.index}>
                  {run.length > 1 ? (
                    <polyline points={run.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")} fill="none" className="stroke-chart-2" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  ) : (
                    <circle cx={run[0]!.x} cy={run[0]!.y} r={2.5} className="fill-chart-2" />
                  )}
                </g>
              ))}

          {average !== null && average > 0 ? (
            <g>
              <line x1={left} x2={left + plotW} y1={y(average)} y2={y(average)} className="stroke-foreground/50" strokeWidth={1} strokeDasharray="4 4" />
              <text x={left + plotW - 2} y={y(average) - 5} textAnchor="end" paintOrder="stroke" strokeWidth={3} className="fill-muted-foreground stroke-card" strokeLinejoin="round">
                {`avg ${isRate(metric) ? formatValue(metric, average, currency) : formatTick(metric, average, step, currency)}`}
              </text>
            </g>
          ) : null}

          {!bars && active !== null && current?.value != null ? (
            <circle cx={x(active)} cy={y(current.value)} r={4} className="fill-chart-2 stroke-card" strokeWidth={2} />
          ) : null}

          {current ? (
            <g>
              <rect x={tipX} y={MARGIN.top} width={tipW} height={38} rx={6} className="fill-popover stroke-border" />
              <text x={tipX + 9} y={MARGIN.top + 14} className="fill-muted-foreground">{tipLines[0]}</text>
              <text x={tipX + 9} y={MARGIN.top + 30} className="fill-popover-foreground text-[13px] font-semibold">{tipLines[1]}</text>
            </g>
          ) : null}
        </svg>
      ) : null}
    </div>
  );
}
