import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { FolderOpen, Plug, RefreshCw } from "lucide-react";
import { EmptyState } from "@/client/components/EmptyState";
import { ErrorState } from "@/client/components/ErrorState";
import { Button } from "@/client/components/ui/button";
import { useLastProject, useProjects } from "@/client/features/projects/queries";
import { AppShell } from "@/client/layout/AppShell";
import {
  accountsInScope,
  scopeLabel,
  setLastProject,
  UNASSIGNED,
  type ProjectsSummary,
} from "@/client/lib/projects";
import { formatDateRange } from "@/client/lib/format";
import { platformScope } from "@/client/lib/platforms";
import {
  deriveKpis,
  fetchReport,
  PLATFORM_LABEL,
  ReportError,
  type Report,
} from "@/client/lib/report";
import {
  accountFilter,
  apiQuery,
  inclusiveDays,
  isCalendarDate,
  resolveWindow,
  utcToday,
  type DashboardSearch,
} from "@/client/lib/search";
import { AccountFilter } from "./AccountFilter";
import { CampaignTable, type CampaignTableState } from "./CampaignTable";
import { DashboardFilters } from "./DashboardFilters";
import { KpiCards } from "./KpiCards";
import { SourceNotice } from "./SourceNotice";
import { SourceStatusStrip } from "./SourceStatusStrip";

const timeFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

export function DashboardPage() {
  const search = useSearch({ from: "/" });
  const navigate = useNavigate({ from: "/" });
  const today = utcToday();
  const range = resolveWindow(search);
  const projects = useProjects();
  const summary = projects.data;
  const remembered = useLastProject();
  const queryClient = useQueryClient();

  // Arriving without ?project= reopens the remembered project (once). Until that
  // is decided no report is requested, so no provider is asked twice.
  const [restore, setRestore] = useState<"pending" | "done">("pending");
  useEffect(() => {
    if (restore === "done" || remembered === undefined) return;
    if (!search.project && remembered && remembered !== "all") {
      void navigate({ search: (previous) => ({ ...previous, project: remembered }), replace: true })
        .finally(() => setRestore("done"));
    } else {
      setRestore("done");
    }
  }, [navigate, remembered, restore, search.project]);
  // A project opened by link becomes the remembered one.
  useEffect(() => {
    if (restore === "done" && search.project) setLastProject(search.project);
  }, [restore, search.project]);

  const scope = useScope(summary, search, projects.isError);
  // A project that no longer exists (deleted, or another workspace's link) and
  // accounts outside the scope are dropped from the URL instead of reaching the API.
  useEffect(() => {
    if (!summary) return;
    if (!scope.projectKnown) {
      setLastProject(undefined);
      void navigate({ search: (previous) => ({ ...previous, project: undefined, accounts: undefined }), replace: true });
    } else if (scope.accountIds.length !== scope.requested.length) {
      void navigate({
        search: (previous) => ({ ...previous, accounts: scope.accountIds.join(",") || undefined }),
        replace: true,
      });
    }
  }, [navigate, scope.accountIds, scope.projectKnown, scope.requested.length, summary]);

  const query = apiQuery(range, search.platform, { project: search.project, accounts: scope.accountIds });
  const ready = restore === "done" && scope.ready && !scope.empty;
  const report = useQuery({
    queryKey: ["campaigns", query],
    queryFn: ({ signal }) => fetchReport(query, signal),
    enabled: ready,
  });
  const data = ready ? report.data : undefined;
  // Presets are resolved by the server (last complete day in the accounts' time zones):
  // once the report is in, its dates are the ones shown and used for campaign details.
  const shown = data && isCalendarDate(data.filters.start) && isCalendarDate(data.filters.end)
    ? { ...range, start: data.filters.start, end: data.filters.end, days: inclusiveDays(data.filters.start, data.filters.end) }
    : range;
  const kpis = useMemo(() => (data ? deriveKpis(data) : null), [data]);
  const loading = !ready || report.isPending;
  // Platforms come from the resolved scope (projects loaded, remembered project
  // restored) and then from the report; never from a default list.
  const platforms = useMemo(() => platformScope({
    resolved: restore === "done" && (Boolean(summary) || projects.isError),
    scoped: scope.scoped,
    projectsFailed: projects.isError,
    accounts: scope.effective,
    projectAccounts: scope.projectAccounts,
    filter: search.platform,
    reported: data ? data.sources.map((source) => source.platform) : null,
    scopeName: search.project === UNASSIGNED ? "the unassigned accounts" : "this project",
  }), [restore, summary, projects.isError, scope.scoped, scope.effective, scope.projectAccounts, search.platform, search.project, data]);

  function update(next: DashboardSearch) {
    void navigate({ search: next, replace: true });
  }
  const keep = { project: search.project, accounts: search.accounts };

  return (
    <AppShell
      title="Overview"
      context={scope.label}
      actions={
        <>
          {report.dataUpdatedAt && ready ? (
            <span className="hidden text-xs text-muted-foreground sm:inline">
              Updated {timeFormat.format(report.dataUpdatedAt)}
            </span>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            pending={ready && report.isFetching}
            disabled={!ready}
            onClick={() => {
              void report.refetch();
              // An open campaign detail is a live provider call too: refresh it with the report.
              void queryClient.invalidateQueries({ queryKey: ["campaign-detail"] });
            }}
          >
            {ready && report.isFetching ? null : <RefreshCw aria-hidden />}
            Refresh
          </Button>
        </>
      }
    >
      <div className="mx-auto w-full max-w-8xl space-y-4 p-4 md:p-6">
        <DashboardFilters
          range={shown}
          includesToday={data?.includesToday === true}
          platform={search.platform}
          today={today}
          onPreset={(preset) =>
            update({ ...keep, platform: search.platform, ...(preset === "30d" ? {} : { range: preset }) })
          }
          onCustom={(start, end) => update({ ...keep, platform: search.platform, start, end })}
          platformOptions={platforms.toggle}
          onPlatform={(platform) => {
            const { platform: _previous, accounts: _accounts, ...rest } = search;
            // Keep only the picked accounts that exist on the new platform.
            const accounts = scope.accountIds.filter((id) =>
              !platform || scope.projectAccounts.find((account) => account.id === id)?.platform === platform);
            update({ ...rest, ...(platform ? { platform } : {}), ...(accounts.length ? { accounts: accounts.join(",") } : {}) });
          }}
          accountFilter={
            summary && (scope.filterable.length > 1 || scope.accountIds.length > 0) ? (
              <AccountFilter
                accounts={scope.filterable}
                selected={scope.accountIds}
                onChange={(ids) => update({ ...search, accounts: ids.length ? ids.join(",") : undefined })}
              />
            ) : null
          }
        />

        {scope.empty && summary ? (
          <EmptyScope
            summary={summary}
            project={search.project}
            platformFiltered={Boolean(search.platform)}
            onShowAllPlatforms={() => update({ ...search, platform: undefined })}
          />
        ) : (
          <>
            {report.isError && ready ? null : (
              <SourceStatusStrip
                report={data}
                platforms={platforms.visible}
                loading={loading}
                onRetry={() => void report.refetch()}
                retrying={report.isFetching}
              />
            )}

            {data && data.status !== "not_configured" ? <SourceNotice report={data} /> : null}

            <KpiCards kpis={kpis} platforms={platforms.visible ?? []} loading={loading || platforms.visible === null} />

            <CampaignTable
              state={tableState({ ...report, isPending: loading, isError: ready && report.isError }, data, shown.start, shown.end)}
              expanded={search.expanded}
              onExpandedChange={(expanded) => update({ ...search, expanded })}
              detailScope={{ start: shown.start, end: shown.end, project: search.project }}
            />

            {data && kpis?.included.length ? (
              <p className="text-xs text-muted-foreground">{data.conversionNote}</p>
            ) : null}
          </>
        )}
      </div>
    </AppShell>
  );
}

interface Scope {
  /** null for every project when the workspace has none; otherwise the header context. */
  label: string | null;
  projectKnown: boolean;
  /** Account ids in the URL. */
  requested: string[];
  /** The URL's account ids that are in the current scope (all of them until projects load). */
  accountIds: string[];
  /** Accounts of the project (any platform). */
  projectAccounts: ProjectsSummary["accounts"];
  /** Accounts the account filter offers: the project's, on the selected platform. */
  filterable: ProjectsSummary["accounts"];
  /** A project or account filter applies. */
  scoped: boolean;
  /** The accounts the report covers (project × platform × account filter). */
  effective: ProjectsSummary["accounts"];
  /** A scoped report can be requested (projects are known, or no scope is set). */
  ready: boolean;
  /** The scope holds no selected account: nothing to report. */
  empty: boolean;
}

function useScope(summary: ProjectsSummary | undefined, search: DashboardSearch, projectsFailed: boolean): Scope {
  return useMemo(() => {
    const requested = accountFilter(search);
    const scoped = Boolean(search.project) || requested.length > 0;
    if (!summary) {
      // Projects not loaded yet: a scoped report waits for them (unless they failed; the API validates anyway).
      return {
        label: null, projectKnown: true, requested, accountIds: requested,
        projectAccounts: [], filterable: [], scoped, effective: [], ready: !scoped || projectsFailed, empty: false,
      };
    }
    const projectKnown = !search.project || search.project === UNASSIGNED
      || summary.projects.some((project) => project.id === search.project);
    const projectAccounts = accountsInScope(summary, projectKnown ? search.project : undefined);
    const filterable = projectAccounts.filter((account) => !search.platform || account.platform === search.platform);
    const accountIds = requested.filter((id) => filterable.some((account) => account.id === id));
    const effective = accountIds.length ? filterable.filter((account) => accountIds.includes(account.id)) : filterable;
    return {
      label: search.project ? scopeLabel(summary, search.project) : summary.projects.length ? "All projects" : null,
      projectKnown, requested, accountIds, projectAccounts, filterable, scoped, effective,
      ready: projectKnown && accountIds.length === requested.length,
      empty: scoped && projectKnown && effective.length === 0,
    };
  }, [summary, search, projectsFailed]);
}

/** A project (or the unassigned bucket) without accounts on the chosen platform(s). */
function EmptyScope({
  summary,
  project,
  platformFiltered,
  onShowAllPlatforms,
}: {
  summary: ProjectsSummary;
  project: string | undefined;
  platformFiltered: boolean;
  onShowAllPlatforms: () => void;
}) {
  const name = scopeLabel(summary, project) ?? "This project";
  const admin = summary.role === "admin";
  if (platformFiltered && accountsInScope(summary, project).length > 0) {
    return (
      <EmptyState
        kind="filtered"
        variant="card"
        title="No ad accounts on this platform"
        description={`${name} has ad accounts only on the other platform.`}
        action={<Button variant="outline" onClick={onShowAllPlatforms}>Show all platforms</Button>}
      />
    );
  }
  if (project === UNASSIGNED) {
    return (
      <EmptyState
        icon={FolderOpen}
        variant="card"
        title="Every ad account is in a project"
        description="No selected ad account is left unassigned. Pick a project in the sidebar to see its report."
      />
    );
  }
  return (
    <EmptyState
      icon={FolderOpen}
      variant="card"
      title={`No ad accounts in ${name} yet`}
      description={admin
        ? "Assign the Google Ads and Meta Ads accounts of this brand or client to the project; the report then covers only them."
        : "A workspace admin assigns ad accounts to projects. Until then this project has no report."}
      action={admin ? (
        <Button nativeButton={false} render={<Link to="/projects" />}>Assign accounts</Button>
      ) : (
        <Button variant="outline" nativeButton={false} render={<Link to="/projects" />}>View projects</Button>
      )}
    />
  );
}

function tableState(
  report: { isPending: boolean; isError: boolean; error: unknown; isFetching: boolean; refetch: () => unknown },
  data: Report | undefined,
  start: string,
  end: string,
): CampaignTableState {
  if (report.isPending) return { kind: "loading" };
  if (report.isError || !data) {
    const error = report.error;
    const session = error instanceof ReportError && error.kind === "session";
    return {
      kind: "message",
      message: (
        <ErrorState
          variant="page"
          title={session ? "Session ended" : "Report not loaded"}
          message={error instanceof ReportError ? error.message : "The report could not be loaded. Try again in a moment."}
          action={
            session ? (
              <Button variant="outline" onClick={() => window.location.reload()}>
                Reload page
              </Button>
            ) : undefined
          }
          onRetry={session ? undefined : () => void report.refetch()}
          isRetrying={report.isFetching}
        />
      ),
    };
  }
  if (data.status === "not_configured") {
    // Every selected source is not configured: one call to action, the most specific one.
    const chooser = data.sources.find((source) => source.detail === "no_accounts_selected");
    const label = chooser ? PLATFORM_LABEL[chooser.platform] : null;
    return {
      kind: "message",
      message: (
        <EmptyState
          variant="plain"
          icon={Plug}
          title={chooser ? `Choose the ${label} accounts to report on` : "Connect an ad platform"}
          description={chooser
            ? `${label} is connected, but no ad account is selected for this workspace yet, so no report was requested.`
            : "No ad platform is connected to this workspace yet, so no report was requested. Connect Google Ads or Meta Ads to see live campaign figures."}
          action={
            <Button
              nativeButton={false}
              render={<Link to={chooser ? (chooser.platform === "google" ? "/sources/google/accounts" : "/sources/meta/accounts") : "/sources"} />}
            >
              {chooser ? "Choose accounts" : "Go to Sources"}
            </Button>
          }
        />
      ),
    };
  }
  if (data.status === "unavailable") {
    return {
      kind: "message",
      message: (
        <ErrorState
          variant="page"
          title="No source returned a report"
          message="The selected ad platforms did not return complete reports for this date range. No figures are shown rather than incomplete ones."
          onRetry={() => void report.refetch()}
          isRetrying={report.isFetching}
        />
      ),
    };
  }
  const rows = data.campaigns ?? [];
  if (rows.length === 0) {
    return {
      kind: "message",
      message: (
        <EmptyState
          variant="plain"
          title="No campaign activity"
          description={`The connected sources reported no campaigns for ${formatDateRange(start, end)}.`}
        />
      ),
    };
  }
  return { kind: "rows", rows };
}
