import { useId, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { safeMessage } from "@/client/lib/feedback";
import { Link, useNavigate } from "@tanstack/react-router";
import { BookOpen, ExternalLink, ListChecks, RefreshCw, Settings2, TriangleAlert, Unplug } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import { Input } from "@/client/components/ui/input";
import { Skeleton } from "@/client/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/client/components/ui/alert-dialog";
import {
  COMMON_ACTION_TYPES,
  disconnectMeta,
  formatExpiry,
  isActionType,
  META_ADS_GUIDE_URL,
  saveConversionActionType,
} from "@/client/lib/meta";
import { SourcesError, type SourcesSummary } from "@/client/lib/sources";
import { SourceCard } from "./SourceCard";
import { useMetaConnect } from "./useMetaConnect";

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const OTHER = "__other__";

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

const linkClass =
  "inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline";

/** The exact Meta action type counted as conversions (admins edit; env-managed values are read-only). */
function ConversionSetting({ summary, admin }: { summary: SourcesSummary; admin: boolean }) {
  const queryClient = useQueryClient();
  const selectId = useId();
  const otherId = useId();
  const conversion = summary.meta.conversion;
  const current = conversion?.value ?? "purchase";
  const known = COMMON_ACTION_TYPES.some((item) => item.value === current);
  const [choice, setChoice] = useState(known ? current : OTHER);
  const [other, setOther] = useState(known ? "" : current);
  const value = choice === OTHER ? other.trim() : choice;
  const invalid = choice === OTHER && other.trim() !== "" && !isActionType(other.trim());
  const save = useMutation({
    mutationFn: () => saveConversionActionType(value),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: ["campaigns"] });
      await queryClient.invalidateQueries({ queryKey: ["sources"] });
      toast.success("Conversion action type saved");
    },
    onError: (error) => toast.error(safeMessage(error, "The conversion action type was not saved. Try again.")),
  });
  if (!conversion) {
    return <p className="text-destructive">META_CONVERSION_ACTION_TYPE is malformed, so Meta reports are paused. Fix or remove it in the deployment.</p>;
  }
  const label = COMMON_ACTION_TYPES.find((item) => item.value === current)?.label ?? current;
  if (!admin || conversion.source === "deployment") {
    return (
      <p className="text-muted-foreground">
        Conversions count <span className="font-medium text-foreground">{label}</span>
        {conversion.source === "deployment" ? " (set by the deployment: META_CONVERSION_ACTION_TYPE)." : "."}
      </p>
    );
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (value && isActionType(value) && value !== current) save.mutate();
  }
  return (
    <form onSubmit={submit} noValidate className="space-y-2 border-t border-border pt-3">
      <label htmlFor={selectId} className="block text-xs font-medium text-muted-foreground">Count as conversions</label>
      <div className="flex flex-wrap items-start gap-2">
        <select
          id={selectId}
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
          className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 sm:max-w-72"
        >
          {COMMON_ACTION_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          <option value={OTHER}>Other action type…</option>
        </select>
        <Button type="submit" variant="outline" size="sm" pending={save.isPending} disabled={!value || invalid || value === current}>
          Save
        </Button>
      </div>
      {choice === OTHER ? (
        <div>
          <label htmlFor={otherId} className="sr-only">Exact action type</label>
          <Input
            id={otherId}
            value={other}
            onChange={(event) => setOther(event.target.value)}
            placeholder="offsite_conversion.custom.123456789"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={invalid ? true : undefined}
            className="h-8 font-mono sm:max-w-96"
          />
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        One exact Meta <code>action_type</code>, as in Ads Manager&apos;s results columns; it is never summed with others.
      </p>
      {invalid ? <p role="alert" className="text-xs text-destructive">Lowercase letters, digits, underscores and dots, such as offsite_conversion.fb_pixel_lead.</p> : null}
      {save.isError ? (
        <p role="alert" className="text-xs text-destructive">
          {save.error instanceof SourcesError ? save.error.message : "The setting was not saved. Try again."}
        </p>
      ) : null}
    </form>
  );
}

export function MetaAdsCard({ summary, loading }: { summary: SourcesSummary | undefined; loading: boolean }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const connect = useMetaConnect();
  const [confirming, setConfirming] = useState(false);
  const disconnect = useMutation({
    mutationFn: disconnectMeta,
    onSuccess: async () => {
      setConfirming(false);
      queryClient.removeQueries({ queryKey: ["campaigns"] });
      queryClient.removeQueries({ queryKey: ["metaAccounts"] });
      await queryClient.invalidateQueries({ queryKey: ["sources"] });
      void navigate({ to: "/sources", search: { meta: "disconnected" }, replace: true });
      toast.success("Meta Ads disconnected");
    },
    onError: (error) => toast.error(safeMessage(error, "Meta Ads was not disconnected. Try again.")),
  });

  if (loading || !summary) {
    return (
      <SourceCard platform="meta" title="Meta Ads" badge={null}>
        <div role="status" aria-label="Loading Meta Ads connection" className="space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="mt-4 h-10 w-44" />
        </div>
      </SourceCard>
    );
  }

  const admin = summary.workspace?.role === "admin";
  const meta = summary.meta;
  const connection = meta.connection;
  const errorMessage = connect.error instanceof SourcesError ? connect.error.message
    : connect.error ? "The request did not complete. Try again in a moment." : null;
  const guideLink = (
    <a href={META_ADS_GUIDE_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>
      <BookOpen aria-hidden className="size-3.5" />
      Self-hosting guide
    </a>
  );

  if (!meta.available) {
    return (
      <SourceCard
        platform="meta"
        title="Meta Ads"
        badge="setup"
        actions={meta.canSetUp ? (
          <>
            <Button nativeButton={false} render={<Link to="/sources/meta/setup" />}>
              <Settings2 aria-hidden />
              Set up Meta Ads
            </Button>
            {guideLink}
          </>
        ) : guideLink}
      >
        <p className="font-medium">Meta Ads is not set up on this instance.</p>
        <p className="text-muted-foreground">
          {meta.canSetUp
            ? "Connect OpenADS to your own Meta app with a guided setup: about ten minutes, done once. No App Review and no redeploy needed."
            : "An admin of this OpenADS instance sets it up once with their own Meta app; then you can see its reports here."}
        </p>
      </SourceCard>
    );
  }
  const setupLink = meta.canSetUp ? (
    <Link to="/sources/meta/setup" className={linkClass}>
      <Settings2 aria-hidden className="size-3.5" />
      Meta app setup
    </Link>
  ) : null;
  const opening = connect.isPending || connect.isSuccess;
  const connectButton = (label: string, variant: "default" | "outline" = "default") => (
    <Button variant={variant} pending={opening} onClick={() => connect.mutate()}>
      {opening ? null : variant === "default" ? <ExternalLink aria-hidden /> : <RefreshCw aria-hidden />}
      {opening ? "Opening Facebook…" : label}
    </Button>
  );

  if (!connection) {
    return (
      <SourceCard
        platform="meta"
        title="Meta Ads"
        badge="not_connected"
        actions={admin ? <>{connectButton("Connect Meta Ads")}{setupLink}</> : undefined}
      >
        <p className="text-muted-foreground">
          Continue with Facebook and allow OpenADS to read your ad accounts&apos; reports (<code>ads_read</code>). It never
          changes campaigns, budgets or settings.
        </p>
        {!admin ? <p className="text-muted-foreground">Ask a workspace admin to connect Meta Ads.</p> : null}
        <ConversionSetting summary={summary} admin={admin} />
        {errorMessage ? <p role="alert" className="text-destructive">{errorMessage}</p> : null}
      </SourceCard>
    );
  }

  const expired = connection.status !== "active";
  const soon = !expired && connection.expiresSoon;
  return (
    <SourceCard
      platform="meta"
      title="Meta Ads"
      badge={expired ? "expired" : soon ? "expiring" : "connected"}
      actions={
        admin ? (
          <>
            {expired || soon ? (
              connectButton("Reconnect Meta Ads")
            ) : (
              <>
                <Button variant="outline" nativeButton={false} render={<Link to="/sources/meta/accounts" />}>
                  <ListChecks aria-hidden />
                  Choose ad accounts
                </Button>
                {connectButton("Reconnect", "outline")}
              </>
            )}
            <Button variant="ghost" className="text-destructive" onClick={() => setConfirming(true)}>
              <Unplug aria-hidden />
              Disconnect
            </Button>
            {setupLink}
          </>
        ) : undefined
      }
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        <dt className="text-muted-foreground">Connected as</dt>
        <dd className="min-w-0 truncate font-medium">{connection.name ?? "Facebook account"}</dd>
        <dt className="text-muted-foreground">Ad accounts</dt>
        <dd>
          {connection.accountsDiscoveredAt === null
            ? "Not loaded yet"
            : `${connection.selectedAccounts} of ${plural(connection.eligibleAccounts, "account")} selected`}
        </dd>
        <dt className="text-muted-foreground">Since</dt>
        <dd>{dateFormat.format(new Date(connection.connectedAt))}</dd>
        {connection.expiresAt && !expired ? (
          <>
            <dt className="text-muted-foreground">Access</dt>
            <dd className={soon ? "font-medium text-warning-foreground dark:text-warning" : undefined}>
              Reconnect before {formatExpiry(connection.expiresAt)}
            </dd>
          </>
        ) : null}
      </dl>
      {soon ? (
        <Alert variant="warning">
          <TriangleAlert aria-hidden />
          <AlertTitle>Meta access ends on {formatExpiry(connection.expiresAt!)}</AlertTitle>
          <AlertDescription>
            Meta&apos;s long-lived tokens last about 60 days. {admin ? "Reconnect now (one click) to keep reporting." : "Ask a workspace admin to reconnect."}
          </AlertDescription>
        </Alert>
      ) : null}
      {expired ? (
        <p className="text-muted-foreground">
          Meta no longer accepts OpenADS&apos;s access for this Facebook account: the token expired (about 60 days), the
          password changed, or the app was removed. {admin ? "Reconnect to resume reporting." : "Ask a workspace admin to reconnect it."}{" "}
          Until then, Meta Ads figures show — rather than zero.
        </p>
      ) : !admin ? (
        <p className="text-muted-foreground">Only workspace admins can change this connection.</p>
      ) : null}
      <ConversionSetting summary={summary} admin={admin} />
      {errorMessage ? <p role="alert" className="text-destructive">{errorMessage}</p> : null}

      <AlertDialog open={confirming} onOpenChange={(open) => { if (!disconnect.isPending) setConfirming(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Meta Ads?</AlertDialogTitle>
            <AlertDialogDescription>
              OpenADS asks Meta to remove its access for {connection.name ?? "this Facebook account"} and deletes the stored
              token and ad account selection. Meta Ads figures disappear from reports until an admin connects again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {disconnect.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {disconnect.error instanceof SourcesError ? disconnect.error.message : "Disconnect did not complete. Try again."}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnect.isPending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" pending={disconnect.isPending} onClick={() => disconnect.mutate()}>
              Disconnect
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SourceCard>
  );
}
