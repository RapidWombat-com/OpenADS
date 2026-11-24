import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { safeMessage } from "@/client/lib/feedback";
import { Link, useNavigate } from "@tanstack/react-router";
import { BookOpen, ExternalLink, ListChecks, RefreshCw, Settings2, Unplug } from "lucide-react";
import { Button } from "@/client/components/ui/button";
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
  disconnectGoogle,
  GOOGLE_ADS_GUIDE_URL,
  SourcesError,
  type SourcesSummary,
} from "@/client/lib/sources";
import { SourceCard } from "./SourceCard";
import { useGoogleConnect } from "./useGoogleConnect";

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function GoogleAdsCard({ summary, loading }: { summary: SourcesSummary | undefined; loading: boolean }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const connect = useGoogleConnect();
  const [confirming, setConfirming] = useState(false);
  const disconnect = useMutation({
    mutationFn: disconnectGoogle,
    onSuccess: async () => {
      setConfirming(false);
      queryClient.removeQueries({ queryKey: ["campaigns"] });
      queryClient.removeQueries({ queryKey: ["googleAccounts"] });
      await queryClient.invalidateQueries({ queryKey: ["sources"] });
      void navigate({ to: "/sources", search: { google: "disconnected" }, replace: true });
      toast.success("Google Ads disconnected");
    },
    onError: (error) => toast.error(safeMessage(error, "Google Ads was not disconnected. Try again.")),
  });

  if (loading || !summary) {
    return (
      <SourceCard platform="google" title="Google Ads" badge={null}>
        <div role="status" aria-label="Loading Google Ads connection" className="space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="mt-4 h-10 w-44" />
        </div>
      </SourceCard>
    );
  }

  const admin = summary.workspace?.role === "admin";
  const connection = summary.google.connection;
  const actionError = connect.error;
  const errorMessage = actionError instanceof SourcesError ? actionError.message : actionError ? "The request did not complete. Try again in a moment." : null;

  const guideLink = (
    <a
      href={GOOGLE_ADS_GUIDE_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
    >
      <BookOpen aria-hidden className="size-3.5" />
      Self-hosting guide
    </a>
  );

  // No usable OAuth client on this instance: never a Connect button that cannot work.
  if (!summary.google.available) {
    return (
      <SourceCard
        platform="google"
        title="Google Ads"
        badge="setup"
        actions={summary.google.canSetUp ? (
          <>
            <Button nativeButton={false} render={<Link to="/sources/google/setup" />}>
              <Settings2 aria-hidden />
              Set up Google Ads
            </Button>
            {guideLink}
          </>
        ) : guideLink}
      >
        <p className="font-medium">Google Ads is not set up on this instance.</p>
        <p className="text-muted-foreground">
          {summary.google.canSetUp
            ? "Connect OpenADS to your own Google Cloud project with a guided setup: about ten minutes, done once. No redeploy needed."
            : "An admin of this OpenADS instance sets it up once with their own Google Cloud project; then you can see its reports here."}
        </p>
      </SourceCard>
    );
  }
  const setupLink = summary.google.canSetUp ? (
    <Link
      to="/sources/google/setup"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
    >
      <Settings2 aria-hidden className="size-3.5" />
      Google Cloud setup
    </Link>
  ) : null;

  const connectButton = (label: string, variant: "default" | "outline" = "default") => (
    <Button variant={variant} pending={connect.isPending || connect.isSuccess} onClick={() => connect.mutate()}>
      {connect.isPending || connect.isSuccess ? null : variant === "default" ? <ExternalLink aria-hidden /> : <RefreshCw aria-hidden />}
      {connect.isPending || connect.isSuccess ? "Opening Google…" : label}
    </Button>
  );

  if (!connection) {
    return (
      <SourceCard
        platform="google"
        title="Google Ads"
        badge="not_connected"
        actions={admin ? <>{connectButton("Connect Google Ads")}{setupLink}</> : undefined}
      >
        <p className="text-muted-foreground">
          Sign in with Google and allow read access to your Google Ads accounts. OpenADS only reads reports; it
          never changes campaigns, budgets or settings.
        </p>
        {!admin ? (
          <p className="text-muted-foreground">Ask a workspace admin to connect Google Ads.</p>
        ) : null}
        {errorMessage ? <p role="alert" className="text-destructive">{errorMessage}</p> : null}
      </SourceCard>
    );
  }

  const expired = connection.status !== "active";
  return (
    <SourceCard
      platform="google"
      title="Google Ads"
      badge={expired ? "expired" : "connected"}
      actions={
        admin ? (
          <>
            {expired ? (
              connectButton("Reconnect Google Ads")
            ) : (
              <>
                <Button variant="outline" nativeButton={false} render={<Link to="/sources/google/accounts" />}>
                  <ListChecks aria-hidden />
                  Choose accounts
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
        <dd className="min-w-0 truncate font-medium">{connection.googleEmail ?? "Google account"}</dd>
        <dt className="text-muted-foreground">Accounts</dt>
        <dd>
          {connection.accountsDiscoveredAt === null
            ? "Not loaded yet"
            : `${connection.selectedAccounts} of ${plural(connection.eligibleAccounts, "account")} selected`}
        </dd>
        <dt className="text-muted-foreground">Since</dt>
        <dd>{dateFormat.format(new Date(connection.connectedAt))}</dd>
      </dl>
      {expired ? (
        <p className="text-muted-foreground">
          Google no longer accepts OpenADS&apos;s access for this account: it was revoked, expired or the password
          changed. {admin ? "Reconnect to resume reporting." : "Ask a workspace admin to reconnect it."} Until then,
          Google Ads figures show — rather than zero.
        </p>
      ) : !admin ? (
        <p className="text-muted-foreground">Only workspace admins can change this connection.</p>
      ) : null}
      {errorMessage ? <p role="alert" className="text-destructive">{errorMessage}</p> : null}

      <AlertDialog open={confirming} onOpenChange={(open) => { if (!disconnect.isPending) setConfirming(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Google Ads?</AlertDialogTitle>
            <AlertDialogDescription>
              OpenADS revokes its access at Google and deletes the stored credentials and account selection for{" "}
              {connection.googleEmail ?? "this Google account"}. Google Ads figures disappear from reports until an
              admin connects again.
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
