import { lazy, Suspense, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { EmptyState } from "@/client/components/EmptyState";
import { ErrorState } from "@/client/components/ErrorState";
import { MetricLabel } from "@/client/components/MetricHelp";
import { StatusDot } from "@/client/components/StatusDot";
import { Button, buttonVariants } from "@/client/components/ui/button";
import { Skeleton } from "@/client/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/client/components/ui/tooltip";
import {
  DetailError,
  fetchCampaignDetail,
  humanizeEnum,
  type CampaignDetail,
  type DetailQuery,
} from "@/client/lib/campaignDetail";
import { campaignLink, metaAdSetUrl } from "@/client/lib/deepLinks";
import {
  EMPTY,
  formatDate,
  formatDecimal,
  formatInteger,
  formatMoney,
  formatPercent,
} from "@/client/lib/format";
import type { MetricKey } from "@/client/lib/metricHelp";
import {
  conversionRateOf,
  costPerConversionOf,
  cpcOf,
  cpmOf,
  ctrOf,
  frequencyOf,
  type Campaign,
} from "@/client/lib/report";
// The chart code loads on first expand, keeping it out of the main bundle.
const TrendChart = lazy(() => import("./TrendChart"));

const BREAKDOWN_LABEL = { ad_set: "Ad sets", ad_group: "Ad groups" } as const;

/** The expanded row: loaded only when opened (one live provider call per open). */
export function CampaignDetailPanel({ row, query }: { row: Campaign; query: DetailQuery }) {
  const detail = useQuery({
    queryKey: ["campaign-detail", query],
    queryFn: ({ signal }) => fetchCampaignDetail(query, signal),
  });
  const link = campaignLink(row);
  return (
    <div className="space-y-4 border-t border-border bg-foreground/[0.02] px-4 py-4 md:px-5" data-testid="campaign-detail">
      {detail.isPending ? (
        <DetailSkeleton />
      ) : detail.isError ? (
        <DetailFailure error={detail.error} retrying={detail.isFetching} onRetry={() => void detail.refetch()} />
      ) : (
        <DetailBody detail={detail.data.campaign} accountId={detail.data.account.providerId} link={link} />
      )}
    </div>
  );
}

function DetailFailure({ error, retrying, onRetry }: { error: unknown; retrying: boolean; onRetry: () => void }) {
  const kind = error instanceof DetailError ? error.kind : "unavailable";
  const message = error instanceof DetailError ? error.message : "The ad platform did not return this campaign. Try again in a moment.";
  if (kind === "session") {
    return (
      <ErrorState
        variant="inline"
        message={message}
        action={<Button variant="outline" size="sm" onClick={() => window.location.reload()}>Reload page</Button>}
      />
    );
  }
  if (kind === "reconnect" || kind === "setup") {
    return (
      <ErrorState
        variant="inline"
        message={message}
        action={<Button variant="outline" size="sm" nativeButton={false} render={<Link to="/sources" />}>Go to Sources</Button>}
      />
    );
  }
  return <ErrorState variant="inline" message={message} onRetry={onRetry} isRetrying={retrying} />;
}

function DetailSkeleton() {
  return (
    <div aria-busy className="space-y-4" aria-label="Loading campaign details">
      <div className="flex flex-wrap gap-x-8 gap-y-3">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="space-y-1.5">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </div>
      <Skeleton className="h-[220px] w-full" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-12 w-full" />)}
      </div>
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium break-words">{children}</dd>
    </div>
  );
}

function schedule(detail: CampaignDetail): string {
  if (!detail.startDate && !detail.endDate) return EMPTY;
  const start = detail.startDate ? formatDate(detail.startDate) : "—";
  return detail.endDate ? `${start} – ${formatDate(detail.endDate)}` : `${start} – no end date`;
}

function OpenLink({ href, label, hint, size = "sm" }: { href: string; label: string; hint: string; size?: "sm" | "icon-xs" }) {
  return (
    <Tooltip>
      {/* A real link (not role=button), styled as a button. */}
      <TooltipTrigger
        render={<a href={href} target="_blank" rel="noopener noreferrer" aria-label={size === "sm" ? undefined : label} />}
        className={buttonVariants({ variant: size === "sm" ? "outline" : "ghost", size })}
      >
        <ExternalLink aria-hidden />
        {size === "sm" ? label : null}
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{hint}</TooltipContent>
    </Tooltip>
  );
}

function DetailBody({
  detail,
  accountId,
  link,
}: {
  detail: CampaignDetail;
  accountId: string;
  link: ReturnType<typeof campaignLink>;
}) {
  const { totals, currency } = detail;
  const figures = { ...totals };
  const money = (minor: number | null) => formatMoney(minor, currency);
  const metrics: { key: MetricKey; value: string }[] = [
    { key: "spend", value: money(totals.spendMinor) },
    { key: "impressions", value: formatInteger(totals.impressions) },
    { key: "clicks", value: formatInteger(totals.clicks) },
    { key: "ctr", value: formatPercent(ctrOf(figures)) },
    { key: "cpc", value: money(cpcOf(figures)) },
    { key: "cpm", value: money(cpmOf(figures)) },
    { key: "conversions", value: formatDecimal(totals.conversions) },
    { key: "costPerConversion", value: money(costPerConversionOf(figures)) },
    { key: "conversionRate", value: formatPercent(conversionRateOf(figures)) },
    ...(detail.platform === "meta"
      ? [
          { key: "reach" as const, value: formatInteger(totals.reach) },
          { key: "frequency" as const, value: formatDecimal(frequencyOf(figures)) },
        ]
      : []),
    ...(detail.platform === "google" && detail.channelType === "SEARCH"
      ? [{ key: "searchImpressionShare" as const, value: formatPercent(totals.searchImpressionShare) }]
      : []),
  ];
  const active = detail.daily.some((point) => point.impressions > 0 || point.spendMicros > 0 || point.clicks > 0);
  const level = BREAKDOWN_LABEL[detail.breakdown.level];
  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <dl className="grid min-w-0 flex-1 grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:flex lg:flex-wrap lg:gap-x-8">
          <Fact label={<MetricLabel metric="status" />}><StatusDot status={detail.status} /></Fact>
          {detail.platform === "meta" ? (
            <Fact label="Objective">{humanizeEnum(detail.objective) ?? EMPTY}</Fact>
          ) : (
            <Fact label="Channel">{humanizeEnum(detail.channelType) ?? EMPTY}</Fact>
          )}
          <Fact label="Bidding">
            {humanizeEnum(detail.biddingStrategy) ?? (detail.platform === "meta" && !detail.budget ? "Set per ad set" : EMPTY)}
          </Fact>
          <Fact label={<MetricLabel metric="budget" />}>
            {detail.budget
              ? `${money(detail.budget.amountMinor)} ${detail.budget.period === "daily" ? "/ day" : "lifetime"}`
              : detail.platform === "meta" ? "Set per ad set" : EMPTY}
          </Fact>
          <Fact label="Schedule">{schedule(detail)}</Fact>
        </dl>
        {link ? <div className="shrink-0 self-start"><OpenLink href={link.href} label={link.label} hint={link.hint} /></div> : null}
      </div>

      {active ? (
        <Suspense fallback={<Skeleton className="h-[220px] w-full" />}>
          <TrendChart daily={detail.daily} currency={currency} />
        </Suspense>
      ) : (
        <EmptyState variant="plain" size="sm" title="No delivery in this date range" description="The platform reported no impressions, clicks or spend for this campaign on any day of the range." />
      )}

      <dl aria-label="Campaign figures" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {metrics.map((metric) => (
          <div key={metric.key} className="min-w-0 rounded-lg border border-border bg-card px-3 py-2">
            <dt className="text-xs font-medium text-muted-foreground"><MetricLabel metric={metric.key} /></dt>
            <dd className="mt-0.5 truncate text-sm font-semibold tabular-nums">{metric.value}</dd>
          </div>
        ))}
      </dl>

      <section aria-label={level} className="space-y-2">
        <h3 className="flex items-baseline gap-2 text-sm font-semibold">
          {level}
          <span className="text-xs font-normal text-muted-foreground">
            {detail.breakdown.total > detail.breakdown.rows.length
              ? `Top ${detail.breakdown.rows.length} of ${detail.breakdown.total} by spend`
              : detail.breakdown.total ? "By spend" : null}
          </span>
        </h3>
        {detail.breakdown.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {detail.platform === "google" && detail.channelType === "PERFORMANCE_MAX"
              ? "Performance Max campaigns use asset groups, not ad groups."
              : `No ${level.toLowerCase()} with delivery in this date range.`}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full min-w-[30rem] text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th scope="col" className="w-[40%] px-3 py-2 text-left font-medium">Name</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium"><MetricLabel metric="status" /></th>
                  <th scope="col" className="px-3 py-2 text-right font-medium"><MetricLabel metric="spend" className="justify-end" /></th>
                  <th scope="col" className="px-3 py-2 text-right font-medium"><MetricLabel metric="conversions" className="justify-end" /></th>
                  <th scope="col" className="px-3 py-2 text-right font-medium"><MetricLabel metric="costPerConversion" className="justify-end" /></th>
                  {detail.platform === "meta" ? <th scope="col" className="w-10 px-2 py-2"><span className="sr-only">Open</span></th> : null}
                </tr>
              </thead>
              <tbody>
                {detail.breakdown.rows.map((item) => {
                  const href = detail.platform === "meta" ? metaAdSetUrl(accountId, item.id) : null;
                  return (
                    <tr key={item.id} className="border-b border-border last:border-0">
                      <td className="max-w-0 px-3 py-2"><span className="block truncate" title={item.name}>{item.name}</span></td>
                      <td className="px-3 py-2"><StatusDot status={item.status} /></td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(item.spendMinor)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatDecimal(item.conversions)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(costPerConversionOf(item))}</td>
                      {detail.platform === "meta" ? (
                        <td className="px-2 py-1 text-right">
                          {href ? (
                            <OpenLink href={href} size="icon-xs" label={`Open ${item.name} in Ads Manager`} hint="Opens this ad set in Meta Ads Manager (new tab)." />
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {detail.platform === "google" && detail.breakdown.rows.length > 0 ? (
          <p className="text-xs text-muted-foreground">Google Ads has no reliable link to a single ad group; open the campaign’s account in Google Ads to find it.</p>
        ) : null}
      </section>
    </>
  );
}
