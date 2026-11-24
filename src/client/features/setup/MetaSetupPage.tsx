import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { safeMessage } from "@/client/lib/feedback";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { BookOpen, CircleAlert, ExternalLink, Lock, RefreshCw } from "lucide-react";
import { cn } from "cn";
import { CopyField } from "@/client/components/CopyField";
import { EmptyState } from "@/client/components/EmptyState";
import { ErrorState } from "@/client/components/ErrorState";
import { Alert, AlertDescription, AlertTitle } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import { Checkbox } from "@/client/components/ui/checkbox";
import { Skeleton } from "@/client/components/ui/skeleton";
import { useMetaConnect } from "@/client/features/sources/useMetaConnect";
import { AppShell } from "@/client/layout/AppShell";
import {
  completedMetaSteps,
  fetchMetaSetup,
  formatExpiry,
  initialMetaStep,
  META_ADS_GUIDE_URL,
  META_SETUP_ERROR_STEP,
  META_SETUP_STEPS,
  rediscoverMetaAccounts,
  saveMetaSetup,
  type MetaManualStep,
  type MetaSetup,
  type MetaSetupError,
  type MetaSetupStepKey,
} from "@/client/lib/meta";
import { SourcesError } from "@/client/lib/sources";
import { AccessStep, AppIdStep, AppStep, LoginStep, MetaCredentialsStep } from "./MetaSteps";
import { Prerequisite, Stepper } from "./Wizard";

export const META_STEP_TITLES: Record<MetaSetupStepKey, string> = {
  app: "Create a Meta app",
  appId: "Enter the App ID",
  login: "Set up Facebook Login",
  access: "Permission and people",
  credentials: "Paste App ID and Secret",
  connect: "Connect Meta Ads",
};

const MANUAL: readonly MetaManualStep[] = ["app", "login", "access"];

// Fixed copy for each problem OpenADS can detect, shown on the step that fixes it.
const ERROR_COPY: Record<MetaSetupError, { title: string; body: string; retry?: string }> = {
  invalid_app: {
    title: "Meta rejected the App ID or App Secret",
    body: "The App Secret does not belong to this App ID, or it was reset in Meta. Copy both again from App settings → Basic (App secret → Show), save them, then connect again.",
  },
  client_missing: {
    title: "No App Secret is saved",
    body: "Meta Ads stays connected, but OpenADS needs the App Secret to read reports. Paste it again.",
  },
  redirect_mismatch: {
    title: "Meta refused the redirect URI",
    body: "The redirect URI no longer matches the one Facebook's dialog used. Check Valid OAuth Redirect URIs below, and that PUBLIC_ORIGIN is the address you open OpenADS at, then connect again.",
    retry: "Connect again",
  },
  access_denied: {
    title: "Facebook did not complete the sign-in",
    body: "If you chose Cancel, just connect again. If Facebook said the app is not available, the Facebook account you used has no role on the app yet: add it below, accept the invitation, then connect again.",
    retry: "Connect again",
  },
  permission_declined: {
    title: "“ads_read” was not allowed",
    body: "OpenADS needs this one permission to list your ad accounts and read reports; it never changes ads. Nothing was stored. Try again and keep it turned on.",
  },
};

function Prerequisites({ setup, onRecheck, rechecking }: { setup: MetaSetup; onRecheck: () => void; rechecking: boolean }) {
  const p = setup.prerequisites;
  const browserOrigin = typeof window === "undefined" ? "https://openads.example.com" : window.location.origin;
  const items: ReactNode[] = [];
  if (p.publicOrigin !== "ok") {
    items.push(
      <Prerequisite key="origin" title={p.publicOrigin === "missing" ? "PUBLIC_ORIGIN is not set" : "PUBLIC_ORIGIN is not valid"}>
        <p>
          OpenADS builds Meta&apos;s redirect URI from it. Set it to this instance&apos;s address (https, or
          http://localhost:&lt;port&gt; locally) in your deployment&apos;s vars, then deploy or restart.
        </p>
        <CopyField label="Value" value={`PUBLIC_ORIGIN=${browserOrigin}`} />
      </Prerequisite>,
    );
  }
  if (!p.database) {
    items.push(
      <Prerequisite key="db" title="No database is bound">
        <p>Create a D1 database, bind it as DB in your deployment config, apply the migrations and deploy again.</p>
        <CopyField label="Apply migrations" value="npx wrangler d1 migrations apply DB --remote" />
      </Prerequisite>,
    );
  }
  if (p.encryptionKey !== "ok") {
    items.push(
      <Prerequisite key="key" title={p.encryptionKey === "missing" ? "TOKEN_ENCRYPTION_KEY is not set" : "TOKEN_ENCRYPTION_KEY is not valid"}>
        <p>
          OpenADS encrypts the App Secret and Meta tokens with it. On Cloudflare, run the deploy again from your OpenADS
          checkout: it generates the key when the Worker has none. Then click Check again.
        </p>
        <CopyField label="Command" value="npm run deploy:cloudflare" />
      </Prerequisite>,
    );
  }
  if (p.deploymentApp === "invalid") {
    items.push(
      <Prerequisite key="app" title="Deployment Meta app is incomplete">
        <p>
          META_APP_ID (digits) and META_APP_SECRET (32 hexadecimal characters) must both be set and valid, or both removed
          so the app can be entered here.
        </p>
      </Prerequisite>,
    );
  }
  if (p.apiVersion !== "ok" || p.conversionActionType === "invalid") {
    items.push(
      <Prerequisite key="version" title="Optional Meta settings are malformed">
        <p>
          META_API_VERSION must look like <code>v27.0</code> and META_CONVERSION_ACTION_TYPE must be an exact action type
          such as <code>purchase</code>. Remove them to use the defaults.
        </p>
      </Prerequisite>,
    );
  }
  if (!items.length) return null;
  return (
    <section aria-label="Instance settings" className="space-y-2">
      {items}
      <Button variant="outline" size="sm" pending={rechecking} onClick={onRecheck}>
        {rechecking ? null : <RefreshCw aria-hidden />}
        Check again
      </Button>
    </section>
  );
}

function ConnectStep({ setup, go, rerequest }: { setup: MetaSetup; go: (step: MetaSetupStepKey) => void; rerequest: boolean }) {
  const connect = useMetaConnect();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const load = useMutation({
    mutationFn: rediscoverMetaAccounts,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["metaSetup"] });
      queryClient.removeQueries({ queryKey: ["metaAccounts"] });
      void navigate({ to: "/sources/meta/accounts" });
    },
    onError: (error) => toast.error(safeMessage(error, "Ad accounts could not be loaded. Try again.")),
  });
  const opening = connect.isPending || connect.isSuccess;
  const connection = setup.connection;
  const firstOpen = META_SETUP_STEPS.find((step) => step !== "connect" && !completedMetaSteps(setup)[step]);
  const errorText = (error: unknown) =>
    error instanceof SourcesError ? error.message : error ? "The request did not complete. Try again." : null;

  if (!setup.ready) {
    return (
      <div className="space-y-3">
        <p className="text-muted-foreground">Save the App ID and App Secret first; then connecting takes one click.</p>
        {firstOpen ? (
          <Button variant="outline" onClick={() => go(firstOpen)}>Go to “{META_STEP_TITLES[firstOpen]}”</Button>
        ) : null}
      </div>
    );
  }
  const connectButton = (label: string) => (
    <Button pending={opening} onClick={() => connect.mutate({ rerequest })}>
      {opening ? null : <ExternalLink aria-hidden />}
      {opening ? "Opening Facebook…" : label}
    </Button>
  );
  const failure = connect.isError ? <p role="alert" className="text-sm text-destructive">{errorText(connect.error)}</p> : null;
  if (!connection || rerequest) {
    return (
      <div className="space-y-4">
        <p>
          Continue with the Facebook account that can see your ad accounts and allow OpenADS to read ads data
          (<code>ads_read</code>). OpenADS never changes ads.
        </p>
        <p className="text-sm text-muted-foreground">
          Facebook shows your app&apos;s name and may say it is in development: that is expected for your own instance.
        </p>
        {connectButton(rerequest ? "Allow ads_read and connect" : "Connect Meta Ads")}
        {failure}
      </div>
    );
  }
  if (connection.status !== "active") {
    return (
      <div className="space-y-4">
        <p>Meta no longer accepts OpenADS&apos;s access for {connection.name ?? "this Facebook account"}: the token expired or was removed. Reconnect once to resume reporting.</p>
        {connectButton("Reconnect Meta Ads")}
        {failure}
      </div>
    );
  }
  if (!connection.accountsDiscoveredAt) {
    return (
      <div className="space-y-4">
        <p>
          Connected as <strong className="font-medium">{connection.name ?? "your Facebook account"}</strong>, but Meta has
          not returned the ad accounts yet. Load them again.
        </p>
        <Button pending={load.isPending} onClick={() => load.mutate()}>Load ad accounts</Button>
        {load.isError ? <p role="alert" className="text-sm text-destructive">{errorText(load.error)}</p> : null}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <p>
        Connected as <strong className="font-medium">{connection.name ?? "your Facebook account"}</strong>.{" "}
        {connection.selectedAccounts} of {connection.eligibleAccounts} ad account{connection.eligibleAccounts === 1 ? "" : "s"} selected.
        {connection.expiresAt ? <> Meta&apos;s access lasts until {formatExpiry(connection.expiresAt)}; reconnect before then.</> : null}
      </p>
      <div className="flex flex-wrap gap-2">
        {connection.selectedAccounts > 0 ? (
          <>
            <Button nativeButton={false} render={<Link to="/" />}>Open the report</Button>
            <Button variant="outline" nativeButton={false} render={<Link to="/sources/meta/accounts" />}>Choose ad accounts</Button>
          </>
        ) : (
          <Button nativeButton={false} render={<Link to="/sources/meta/accounts" />}>Choose ad accounts</Button>
        )}
      </div>
    </div>
  );
}

export function MetaSetupPage() {
  const search = useSearch({ from: "/sources/meta/setup" });
  const queryClient = useQueryClient();
  const setupQuery = useQuery({ queryKey: ["metaSetup"], queryFn: fetchMetaSetup });
  const setup = setupQuery.data;
  const [active, setActive] = useState<MetaSetupStepKey | null>(null);

  useEffect(() => {
    if (setup && active === null) setActive(initialMetaStep(setup, search.error));
  }, [setup, active, search.error]);
  useEffect(() => {
    if (search.error) setActive(META_SETUP_ERROR_STEP[search.error]);
  }, [search.error]);

  const progress = useMutation({
    mutationFn: saveMetaSetup,
    onSuccess: (next, variables) => {
      queryClient.setQueryData(["metaSetup"], next);
      void queryClient.invalidateQueries({ queryKey: ["sources"] });
      const finished = variables.steps && Object.values(variables.steps).some(Boolean);
      if (finished || variables.appId) {
        const done = completedMetaSteps(next);
        const index = META_SETUP_STEPS.indexOf(active ?? "app");
        const following = META_SETUP_STEPS.slice(index + 1).find((step) => !done[step]);
        if (following) setActive(following);
      }
      toast.success(variables.appId ? "Meta App ID saved" : finished ? "Step marked done" : "Step reopened");
    },
    onError: (error) => toast.error(safeMessage(error, "The setup step was not saved. Try again.")),
  });

  const forbidden = setupQuery.error instanceof SourcesError && setupQuery.error.status === 403;
  const guide = (
    <Button variant="ghost" size="sm" nativeButton={false} render={<a href={META_ADS_GUIDE_URL} target="_blank" rel="noopener noreferrer" />}>
      <BookOpen aria-hidden />
      <span className="hidden sm:inline">Setup guide</span>
    </Button>
  );

  let body: ReactNode;
  if (setupQuery.isPending) {
    body = (
      <div role="status" aria-label="Loading setup" className="grid gap-4 lg:grid-cols-[16rem_1fr]">
        <Skeleton className="h-10 lg:h-80" />
        <Skeleton className="h-80" />
      </div>
    );
  } else if (forbidden) {
    body = (
      <EmptyState
        variant="card"
        icon={Lock}
        title="Only workspace admins can set up Meta Ads"
        description="An admin of this OpenADS instance (OPENADS_ADMIN_EMAILS) connects it to their own Meta app once; then everyone sees the reports."
        action={<Button variant="outline" nativeButton={false} render={<Link to="/sources" />}>Back to Sources</Button>}
      />
    );
  } else if (setupQuery.isError || !setup) {
    body = (
      <ErrorState
        variant="page"
        title="Setup not loaded"
        message={setupQuery.error instanceof SourcesError ? setupQuery.error.message : "The setup could not be loaded. Try again."}
        onRetry={() => void setupQuery.refetch()}
        isRetrying={setupQuery.isFetching}
      />
    );
  } else {
    const attention = search.error ? META_SETUP_ERROR_STEP[search.error] : null;
    const done = completedMetaSteps(setup);
    if (attention) done[attention] = false;
    const step = active ?? initialMetaStep(setup, search.error);
    const index = META_SETUP_STEPS.indexOf(step);
    const blocked = setup.prerequisites.publicOrigin !== "ok" || !setup.prerequisites.database;
    const count = META_SETUP_STEPS.filter((key) => done[key]).length;
    const stepError = search.error && META_SETUP_ERROR_STEP[search.error] === step ? ERROR_COPY[search.error] : null;
    const manual = (MANUAL as readonly string[]).includes(step) ? (step as MetaManualStep) : null;
    const go = (next: MetaSetupStepKey) => setActive(next);
    const appIdError = progress.error instanceof SourcesError && progress.error.field === "appId" ? progress.error.message : null;
    const panels: Record<MetaSetupStepKey, ReactNode> = {
      app: <AppStep setup={setup} />,
      appId: <AppIdStep setup={setup} saving={progress.isPending} error={appIdError} onSave={(appId) => progress.mutate({ appId })} />,
      login: <LoginStep setup={setup} />,
      access: <AccessStep setup={setup} />,
      credentials: <MetaCredentialsStep setup={setup} attention={attention === "credentials"} onSaved={() => go("connect")} />,
      connect: <ConnectStep setup={setup} go={go} rerequest={search.error === "permission_declined"} />,
    };
    body = (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <p className="max-w-2xl text-sm text-muted-foreground">
            Connect OpenADS to your own Meta app — about ten minutes, once per instance. Progress is saved, so you can leave
            and come back.
          </p>
          <span className="text-xs font-medium text-muted-foreground tabular-nums" aria-live="polite">
            {count} of {META_SETUP_STEPS.length} done
          </span>
        </div>
        <Prerequisites setup={setup} onRecheck={() => void setupQuery.refetch()} rechecking={setupQuery.isFetching} />
        <div className="grid gap-3 lg:grid-cols-[16rem_minmax(0,1fr)] lg:gap-6">
          <Stepper steps={META_SETUP_STEPS} titles={META_STEP_TITLES} active={step} done={done} attention={attention} disabled={blocked} onSelect={go} />
          <section
            aria-labelledby="setup-step-title"
            className={cn("min-w-0 rounded-xl border border-border bg-card shadow-sm", blocked && "opacity-60")}
          >
            <header className="border-b border-border px-4 py-3 md:px-5">
              <p className="text-xs font-medium text-muted-foreground">Step {index + 1} of {META_SETUP_STEPS.length}</p>
              <h2 id="setup-step-title" className="text-base font-semibold">{META_STEP_TITLES[step]}</h2>
            </header>
            <div className="space-y-4 px-4 py-4 text-sm md:px-5">
              {stepError ? (
                <Alert variant="destructive">
                  <CircleAlert aria-hidden />
                  <AlertTitle>{stepError.title}</AlertTitle>
                  <AlertDescription>{stepError.body}</AlertDescription>
                  {stepError.retry ? (
                    <div className="col-start-2 mt-2">
                      <Button variant="outline" size="sm" onClick={() => go("connect")}>{stepError.retry}</Button>
                    </div>
                  ) : null}
                </Alert>
              ) : null}
              {blocked ? <p className="text-muted-foreground">Fix the instance settings above first.</p> : panels[step]}
            </div>
            <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/40 px-4 py-2.5 md:px-5">
              {manual && !blocked ? (
                <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                  <Checkbox
                    checked={Boolean(setup.steps[manual])}
                    disabled={progress.isPending}
                    onCheckedChange={(checked) => progress.mutate({ steps: { [manual]: checked === true } })}
                  />
                  Done
                </label>
              ) : <span />}
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" disabled={index === 0} onClick={() => go(META_SETUP_STEPS[index - 1]!)}>Back</Button>
                {index < META_SETUP_STEPS.length - 1 ? (
                  <Button variant="ghost" size="sm" onClick={() => go(META_SETUP_STEPS[index + 1]!)}>Next</Button>
                ) : null}
              </div>
            </footer>
            {progress.isError && !appIdError ? (
              <p role="alert" className="px-4 pb-3 text-sm text-destructive md:px-5">
                {progress.error instanceof SourcesError ? progress.error.message : "Progress was not saved. Try again."}
              </p>
            ) : null}
          </section>
        </div>
      </div>
    );
  }

  return (
    <AppShell title="Set up Meta Ads" actions={guide}>
      <div className="mx-auto w-full max-w-6xl p-4 md:p-6">{body}</div>
    </AppShell>
  );
}
