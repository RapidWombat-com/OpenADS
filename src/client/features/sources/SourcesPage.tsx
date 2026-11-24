import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { ErrorState } from "@/client/components/ErrorState";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import { AppShell } from "@/client/layout/AppShell";
import { fetchSources, SourcesError, type ConnectResult, type MetaConnectResult } from "@/client/lib/sources";
import { GoogleAdsCard } from "./GoogleAdsCard";
import { MetaAdsCard } from "./MetaAdsCard";
import { PendingSwitchCard } from "./PendingSwitchCard";

// Fixed copy for each callback outcome; provider messages never reach the browser.
const RESULTS: Record<ConnectResult, { variant: "success" | "warning" | "destructive"; title: string; body: string }> = {
  connected: {
    variant: "success",
    title: "Google Ads connected",
    body: "Reports use the accounts selected for this workspace.",
  },
  disconnected: {
    variant: "success",
    title: "Google Ads disconnected",
    body: "OpenADS asked Google to revoke its access and deleted the stored credentials.",
  },
  expired: {
    variant: "warning",
    title: "That Google sign-in expired",
    body: "A Google sign-in works once, for up to 10 minutes. Start again from this page.",
  },
  invalid: {
    variant: "destructive",
    title: "The Google sign-in could not be verified",
    body: "It was started by another user or workspace, or the address was changed. Start again from this page.",
  },
  no_refresh_token: {
    variant: "warning",
    title: "Google did not grant ongoing access",
    body: "OpenADS needs offline read access. Remove OpenADS under Third-party access in your Google Account, then connect again.",
  },
  error: {
    variant: "destructive",
    title: "Google Ads could not be connected",
    body: "Google did not complete the connection. Try again in a moment.",
  },
  unavailable: {
    variant: "destructive",
    title: "Google Ads is not set up on this instance",
    body: "This instance has no working Google OAuth client yet. An admin sets it up below.",
  },
  confirm_switch: {
    variant: "warning",
    title: "You signed in with another Google account",
    body: "Nothing was replaced yet. Review the change below, then confirm or cancel it.",
  },
  switch_failed: {
    variant: "destructive",
    title: "The other Google account's ad accounts could not be listed",
    body: "The current connection was kept and the new sign-in discarded. Try again in a moment.",
  },
};

const META_RESULTS: Record<MetaConnectResult, { variant: "success" | "warning" | "destructive"; title: string; body: string }> = {
  connected: {
    variant: "success",
    title: "Meta Ads connected",
    body: "Reports use the ad accounts selected for this workspace.",
  },
  disconnected: {
    variant: "success",
    title: "Meta Ads disconnected",
    body: "OpenADS asked Meta to remove its access and deleted the stored token.",
  },
  expired: {
    variant: "warning",
    title: "That Facebook sign-in expired",
    body: "A Facebook sign-in works once, for up to 10 minutes. Start again from this page.",
  },
  invalid: {
    variant: "destructive",
    title: "The Facebook sign-in could not be verified",
    body: "It was started by another user or workspace, or the address was changed. Start again from this page.",
  },
  error: {
    variant: "destructive",
    title: "Meta Ads could not be connected",
    body: "Meta did not complete the connection. Try again in a moment.",
  },
  unavailable: {
    variant: "destructive",
    title: "Meta Ads is not set up on this instance",
    body: "This instance has no working Meta app yet. An admin sets it up below.",
  },
  confirm_switch: {
    variant: "warning",
    title: "You signed in as another Facebook user",
    body: "Nothing was replaced yet. Review the change below, then confirm or cancel it.",
  },
  switch_failed: {
    variant: "destructive",
    title: "The other Facebook user's ad accounts could not be listed",
    body: "The current connection was kept and the new sign-in discarded. Try again in a moment.",
  },
};

const ICONS = { success: CircleCheck, warning: TriangleAlert, destructive: CircleAlert } as const;

export function SourcesPage() {
  const search = useSearch({ from: "/sources/" });
  const navigate = useNavigate({ from: "/sources/" });
  const sources = useQuery({ queryKey: ["sources"], queryFn: fetchSources });
  const data = sources.data;
  // "Review the change below" only while there is one (it expires, or was handled in another tab).
  const switchGone = data !== undefined
    && ((search.google === "confirm_switch" && !data.google.pendingSwitch)
      || (!search.google && search.meta === "confirm_switch" && !data.meta.pendingSwitch));
  const result = switchGone ? null
    : search.google ? RESULTS[search.google] : search.meta ? META_RESULTS[search.meta] : null;
  const ResultIcon = result ? ICONS[result.variant] : null;

  return (
    <AppShell title="Sources">
      <div className="mx-auto w-full max-w-5xl space-y-4 p-4 md:p-6">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Connect the ad platforms this workspace reports on. OpenADS reads campaign reports only and keeps provider
          credentials encrypted on the server; they never reach your browser.
        </p>

        {result && ResultIcon ? (
          <Alert variant={result.variant} className="pr-12">
            <ResultIcon aria-hidden />
            <AlertTitle>{result.title}</AlertTitle>
            <AlertDescription>{result.body}</AlertDescription>
            <AlertAction>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Dismiss"
                onClick={() => void navigate({ search: {}, replace: true })}
              >
                <X aria-hidden />
              </Button>
            </AlertAction>
          </Alert>
        ) : null}

        {sources.isError ? (
          <ErrorState
            title="Sources not loaded"
            message={sources.error instanceof SourcesError ? sources.error.message : "Sources could not be loaded. Try again in a moment."}
            onRetry={() => void sources.refetch()}
            isRetrying={sources.isFetching}
          />
        ) : null}

        {data && (data.google.available || data.meta.available) && !data.workspace ? (
          <Alert variant="info">
            <Info aria-hidden />
            <AlertTitle>This workspace is not set up yet</AlertTitle>
            <AlertDescription>
              A workspace admin creates it on their first visit. Reload this page after an admin has signed in.
            </AlertDescription>
          </Alert>
        ) : data?.workspace?.role === "member" ? (
          <Alert variant="info">
            <Info aria-hidden />
            <AlertTitle>You can view sources</AlertTitle>
            <AlertDescription>
              You are a member of {data.workspace.name}. Only workspace admins can connect, reconnect or disconnect
              sources.
            </AlertDescription>
          </Alert>
        ) : null}

        {data?.workspace?.role === "admin" && data.google.pendingSwitch ? (
          <PendingSwitchCard key={data.google.pendingSwitch.id} platform="google" pending={data.google.pendingSwitch} />
        ) : null}
        {data?.workspace?.role === "admin" && data.meta.pendingSwitch ? (
          <PendingSwitchCard key={data.meta.pendingSwitch.id} platform="meta" pending={data.meta.pendingSwitch} />
        ) : null}

        {sources.isError ? null : (
          <div className="grid gap-4 lg:grid-cols-2">
            <GoogleAdsCard summary={data} loading={sources.isPending} />
            <MetaAdsCard summary={data} loading={sources.isPending} />
          </div>
        )}
      </div>
    </AppShell>
  );
}
