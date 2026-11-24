import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { Button } from "@/client/components/ui/button";
import { useGoogleConnect } from "@/client/features/sources/useGoogleConnect";
import { useMetaConnect } from "@/client/features/sources/useMetaConnect";
import { formatExpiry } from "@/client/lib/meta";
import { planSource, type Action, type Viewer } from "@/client/lib/sourceAction";
import { fetchSources, SourcesError } from "@/client/lib/sources";
import { PlatformMark } from "@/client/components/PlatformMark";
import { Skeleton } from "@/client/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@/client/components/ui/popover";
import {
  PLATFORM_LABEL,
  type Platform,
  type Report,
  type Source,
  type SourceStatus,
} from "@/client/lib/report";

const STATUS_LABEL: Record<SourceStatus, string> = {
  available: "Live",
  not_configured: "Not configured",
  unavailable: "Unavailable",
};

const DOT: Record<SourceStatus | "partial", string> = {
  available: "bg-success",
  not_configured: "bg-muted-foreground/50",
  unavailable: "bg-destructive",
  partial: "bg-warning",
};

function statusLabel(source: Source): string {
  if (source.detail === "not_connected") return "Not connected";
  if (source.detail === "no_accounts_selected") return "No accounts selected";
  if (source.detail === "reconnect_required") return "Reconnect";
  if (source.detail === "setup_required") return "Setup needed";
  return STATUS_LABEL[source.status];
}

const pillClass =
  "inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-card px-2 pr-2.5 text-xs font-medium text-foreground outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:bg-foreground/5";

const PATHS = {
  google: { accounts: "/sources/google/accounts", setup: "/sources/google/setup" },
  meta: { accounts: "/sources/meta/accounts", setup: "/sources/meta/setup" },
} as const;

function StatusPopover({
  trigger,
  title,
  description,
  children,
}: {
  trigger: ReactNode;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <Popover>
      {/* A generous close delay lets the pointer cross the gap to the popup's button. */}
      <PopoverTrigger openOnHover delay={150} closeDelay={300} className={pillClass}>
        {trigger}
      </PopoverTrigger>
      <PopoverContent>
        <PopoverTitle>{title}</PopoverTitle>
        <PopoverDescription>{description}</PopoverDescription>
        {children}
      </PopoverContent>
    </Popover>
  );
}

const quietLink = "text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50 outline-none";

/** Renders an Action with the routes and connect mutations the Sources cards use. */
function ActionControl({
  action,
  primary,
  onRetry,
  retrying,
}: {
  action: Action;
  primary: boolean;
  onRetry: () => void;
  retrying: boolean;
}) {
  const google = useGoogleConnect();
  const meta = useMetaConnect();
  if (action.kind === "retry") {
    return (
      <Button size="sm" variant="outline" pending={retrying} onClick={onRetry} className="self-start">
        {action.label}
      </Button>
    );
  }
  if (action.kind === "connect") {
    const connect = action.platform === "google" ? google : meta;
    const opening = connect.isPending || connect.isSuccess;
    const provider = action.platform === "google" ? "Google" : "Facebook";
    return (
      <>
        <Button
          size="sm"
          pending={opening}
          className="self-start"
          onClick={() => (action.platform === "google" ? google.mutate() : meta.mutate())}
        >
          {opening ? `Opening ${provider}…` : action.label}
        </Button>
        {connect.isError ? (
          <p role="status" className="text-xs text-destructive">
            {connect.error instanceof SourcesError ? connect.error.message : "That did not start. Try again."}
          </p>
        ) : null}
      </>
    );
  }
  const link =
    action.kind === "sources" ? (
      <Link to="/sources" />
    ) : action.kind === "accounts" ? (
      <Link to={PATHS[action.platform].accounts} />
    ) : (
      <Link to={PATHS[action.platform].setup} search={action.issue ? { error: action.issue } : {}} />
    );
  return primary ? (
    <Button size="sm" nativeButton={false} render={link} className="self-start">
      {action.label}
    </Button>
  ) : (
    <Link
      to="/sources"
      className={quietLink}
    >
      {action.label}
    </Link>
  );
}

export function SourceStatusStrip({
  report,
  platforms,
  loading,
  onRetry,
  retrying = false,
}: {
  report: Report | undefined;
  /** The scope's platforms; null while the scope is not known yet. */
  platforms: Platform[] | null;
  loading: boolean;
  onRetry: () => void;
  retrying?: boolean;
}) {
  // Role and setup rights decide which action is offered; the server still enforces them.
  const sources = useQuery({ queryKey: ["sources"], queryFn: fetchSources });
  const summary = sources.data;
  const viewerFor = (platform: Platform): Viewer | null =>
    summary ? { admin: summary.workspace?.role === "admin", canSetUp: summary[platform].canSetUp } : null;
  // Until the scope, the report and the viewer's rights are known: neutral
  // placeholders only, so no platform is named before it is known to be in scope.
  if (loading || platforms === null || !report || sources.isPending) {
    return (
      <section aria-label="Source status" aria-busy className="flex flex-wrap items-center gap-2" data-testid="source-strip-loading">
        {Array.from({ length: Math.max(platforms?.length ?? 1, 1) }, (_, index) => (
          <span key={index} className={cn(pillClass, "pointer-events-none")}>
            <Skeleton className="size-4 rounded-full" />
            <Skeleton className="h-3 w-24" />
          </span>
        ))}
      </section>
    );
  }
  return (
    <section aria-label="Source status" className="flex flex-wrap items-center gap-2">
      {platforms.map((platform) => {
        const source = report.sources.find((item) => item.platform === platform);
        if (!source) return null;
        const plan = planSource(source, viewerFor(platform), formatExpiry);
        return (
          <StatusPopover
            key={platform}
            title={`${PLATFORM_LABEL[platform]}: ${statusLabel(source)}`}
            description={plan.message}
            trigger={
              <>
                <PlatformMark platform={platform} decorative className="size-4 text-[9px]" />
                {PLATFORM_LABEL[platform]}
                <span aria-hidden className={cn("size-1.5 rounded-full", DOT[source.status])} />
                <span className="text-muted-foreground">{statusLabel(source)}</span>
              </>
            }
          >
            {plan.primary ? <ActionControl action={plan.primary} primary onRetry={onRetry} retrying={retrying} /> : null}
            {plan.secondary ? <ActionControl action={plan.secondary} primary={false} onRetry={onRetry} retrying={retrying} /> : null}
          </StatusPopover>
        );
      })}
      {report.status === "partial" ? (
        <StatusPopover
          title="Partial report"
          description="At least one selected source did not report. Totals, spend and cost per click cover only the sources marked Live, and their campaigns are the only rows listed."
          trigger={
            <>
              <span aria-hidden className={cn("size-1.5 rounded-full", DOT.partial)} />
              Partial data
            </>
          }
        />
      ) : null}
    </section>
  );
}
