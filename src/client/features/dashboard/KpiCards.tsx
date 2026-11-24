import type { ReactNode } from "react";
import { cn } from "cn";
import { MetricLabel } from "@/client/components/MetricHelp";
import { PlatformMark } from "@/client/components/PlatformMark";
import { Skeleton } from "@/client/components/ui/skeleton";
import {
  EMPTY,
  formatDecimal,
  formatInteger,
  formatMoney,
  formatPercent,
} from "@/client/lib/format";
import type { MetricKey } from "@/client/lib/metricHelp";
import type { Kpis, Platform } from "@/client/lib/report";

function KpiCard({
  metric,
  loading,
  children,
}: {
  metric: MetricKey;
  loading: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-card p-3 md:p-4">
      <dt className="text-xs font-medium text-muted-foreground"><MetricLabel metric={metric} /></dt>
      <dd className="min-w-0" aria-busy={loading || undefined}>
        {loading ? <Skeleton className="h-7 w-24" /> : children}
      </dd>
    </div>
  );
}

function Value({ children, small = false }: { children: ReactNode; small?: boolean }) {
  return (
    <span
      className={cn(
        "block truncate font-semibold tracking-tight tabular-nums",
        small ? "text-base leading-6" : "text-2xl leading-7",
      )}
    >
      {children}
    </span>
  );
}

/** One line per currency or platform; never summed across them. */
function Lines({ items }: { items: { key: string; prefix?: ReactNode; value: string }[] }) {
  if (!items.length) return <Value>{EMPTY}</Value>;
  const small = items.length > 1;
  return (
    <ul className="space-y-0.5">
      {items.map((item) => (
        <li key={item.key} className="flex min-w-0 items-center gap-1.5">
          {item.prefix}
          <Value small={small}>{item.value}</Value>
        </li>
      ))}
    </ul>
  );
}

export function KpiCards({
  kpis,
  platforms,
  loading,
}: {
  kpis: Kpis | null;
  platforms: Platform[];
  loading: boolean;
}) {
  const conversions = platforms.map((platform) => ({
    platform,
    value: kpis?.conversions.find((item) => item.platform === platform)?.value ?? null,
  }));
  return (
    <dl aria-label="Key figures" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <KpiCard metric="spend" loading={loading}>
        <Lines
          items={(kpis?.spend ?? []).map(({ currency, spendMinor }) => ({
            key: currency,
            value: formatMoney(spendMinor, currency),
          }))}
        />
      </KpiCard>
      <KpiCard metric="impressions" loading={loading}>
        <Value>{formatInteger(kpis?.impressions)}</Value>
      </KpiCard>
      <KpiCard metric="clicks" loading={loading}>
        <Value>{formatInteger(kpis?.clicks)}</Value>
      </KpiCard>
      <KpiCard metric="ctr" loading={loading}>
        <Value>{formatPercent(kpis?.ctr)}</Value>
      </KpiCard>
      <KpiCard metric="cpc" loading={loading}>
        <Lines
          items={(kpis?.cpc ?? []).map(({ currency, minor }) => ({
            key: currency,
            value: formatMoney(minor, currency),
          }))}
        />
      </KpiCard>
      <KpiCard metric="conversions" loading={loading}>
        <Lines
          items={conversions.map(({ platform, value }) => ({
            key: platform,
            prefix: platforms.length > 1 ? <PlatformMark platform={platform} className="size-4 text-[9px]" /> : undefined,
            value: formatDecimal(value),
          }))}
        />
      </KpiCard>
    </dl>
  );
}
