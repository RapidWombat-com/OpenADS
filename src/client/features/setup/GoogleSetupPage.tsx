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
import { useGoogleConnect } from "@/client/features/sources/useGoogleConnect";
import { AppShell } from "@/client/layout/AppShell";
import {
  completedSteps,
  fetchGoogleSetup,
  GOOGLE_ADS_GUIDE_URL,
  initialStep,
  rediscoverGoogleAccounts,
  saveGoogleSetup,
  SETUP_ERROR_STEP,
  SETUP_STEPS,
  SourcesError,
  type GoogleSetup,
  type ManualStep,
  type SetupError,
  type SetupStepKey,
} from "@/client/lib/sources";
import { CredentialsStep, ProjectStep } from "./FormSteps";
import { ApiStep, ClientStep, ConsentStep, ExplorerStep } from "./GuideSteps";
import { Prerequisite, Stepper } from "./Wizard";

export const STEP_TITLES: Record<SetupStepKey, string> = {
  project: "Google Cloud project",
  api: "Enable the Google Ads API",
  explorer: "Apply for Explorer access",
  consent: "Set up Google sign-in",
  client: "Create an OAuth client",
  credentials: "Paste Client ID and secret",
  connect: "Connect Google Ads",
};

// Fixed copy for each problem OpenADS can detect, shown on the step that fixes it.
const ERROR_COPY: Record<SetupError, { title: string; body: string; retry?: string }> = {
  access_denied: {
    title: "Google returned access_denied",
    body: "If you cancelled on Google's screen, just connect again. Otherwise your Google account is not a test user while the app is in Testing: add it under Audience → Test users, or publish the app (In production).",
    retry: "Connect again",
  },
  scope_denied: {
    title: "Google Ads permission was not granted",
    body: "On Google's consent screen keep “See, edit, create and delete your Google Ads accounts and data” selected, and check that the Google Ads scope is added under Data access.",
    retry: "Connect again",
  },
  invalid_client: {
    title: "Google rejected the OAuth client",
    body: "The Client ID or secret does not match a client in your project. Paste both again from the OAuth client; if you no longer have the secret, add a new one in Google Cloud.",
  },
  client_missing: {
    title: "No OAuth client is saved",
    body: "Google Ads stays connected, but OpenADS needs the OAuth client to read reports. Paste the Client ID and secret again.",
  },
  api_disabled: {
    title: "The Google Ads API is not enabled",
    body: "Google refused the request because the API is off in the project that owns your OAuth client. Enable it, wait a minute, then load accounts again.",
    retry: "Load accounts again",
  },
  access_level: {
    title: "Your project only has Test access",
    body: "Test access works with test accounts only. Apply for Explorer access, then load accounts again. If the Overview page already shows Explorer, Google may still be applying it: wait a few minutes and retry.",
    retry: "Load accounts again",
  },
};

function Prerequisites({ setup, onRecheck, rechecking }: { setup: GoogleSetup; onRecheck: () => void; rechecking: boolean }) {
  const p = setup.prerequisites;
  const browserOrigin = typeof window === "undefined" ? "https://openads.example.com" : window.location.origin;
  const items: ReactNode[] = [];
  if (p.publicOrigin !== "ok") {
    items.push(
      <Prerequisite key="origin" title={p.publicOrigin === "missing" ? "PUBLIC_ORIGIN is not set" : "PUBLIC_ORIGIN is not valid"}>
        <p>
          OpenADS builds Google's redirect URI from it. Set it to this instance's address (https, or
          http://localhost:&lt;port&gt; locally) in your deployment's vars, then deploy or restart.
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
          OpenADS encrypts the client secret and Google grants with it. On Cloudflare, run the deploy again from your
          OpenADS checkout: it generates the key when the Worker has none. Then click Check again.
        </p>
        <CopyField label="Command" value="npm run deploy:cloudflare" />
        <p className="text-xs">
          Elsewhere, set TOKEN_ENCRYPTION_KEY to the output of <code>openssl rand -base64 32</code> (base64 of exactly
          32 bytes) and restart. Keep it: changing it later means reconnecting Google Ads.
        </p>
      </Prerequisite>,
    );
  }
  if (p.deploymentClient === "invalid") {
    items.push(
      <Prerequisite key="client" title="Deployment OAuth client is incomplete">
        <p>
          GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must both be set and valid, or both removed so the
          client can be entered here.
        </p>
      </Prerequisite>,
    );
  }
  if (p.apiVersion !== "ok" || p.developerToken === "invalid") {
    items.push(
      <Prerequisite key="version" title="Optional Google settings are malformed">
        <p>
          GOOGLE_API_VERSION must look like <code>v26</code> and GOOGLE_DEVELOPER_TOKEN must be a single token. Remove
          them to use the defaults (developer tokens are no longer required by Google).
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

function ConnectStep({ setup, go }: { setup: GoogleSetup; go: (step: SetupStepKey) => void }) {
  const connect = useGoogleConnect();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const load = useMutation({
    mutationFn: rediscoverGoogleAccounts,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["googleSetup"] });
      queryClient.removeQueries({ queryKey: ["googleAccounts"] });
      void navigate({ to: "/sources/google/accounts" });
    },
    onError: (error) => {
      toast.error(safeMessage(error, "Ad accounts could not be loaded. Try again."));
      if (error instanceof SourcesError && error.setupIssue) {
        void navigate({ to: "/sources/google/setup", search: { error: error.setupIssue }, replace: true });
      }
    },
  });
  const opening = connect.isPending || connect.isSuccess;
  const connection = setup.connection;
  const firstOpen = SETUP_STEPS.find((step) => step !== "connect" && !completedSteps(setup)[step]);
  const errorText = (error: unknown) =>
    error instanceof SourcesError ? error.message : error ? "The request did not complete. Try again." : null;

  if (!setup.ready) {
    return (
      <div className="space-y-3">
        <p className="text-muted-foreground">Save a working OAuth client first; then connecting takes one click.</p>
        {firstOpen ? (
          <Button variant="outline" onClick={() => go(firstOpen)}>Go to “{STEP_TITLES[firstOpen]}”</Button>
        ) : null}
      </div>
    );
  }
  const connectButton = (label: string) => (
    <Button pending={opening} onClick={() => connect.mutate()}>
      {opening ? null : <ExternalLink aria-hidden />}
      {opening ? "Opening Google…" : label}
    </Button>
  );
  if (!connection) {
    return (
      <div className="space-y-4">
        <p>
          Sign in with the Google account that can see your ad accounts and allow OpenADS to read Google Ads data. OpenADS
          never changes campaigns.
        </p>
        <p className="text-sm text-muted-foreground">
          While the app is not verified by Google, its sign-in shows “Google hasn't verified this app”. That is expected for
          your own instance: choose <strong className="font-medium text-foreground">Advanced → Go to OpenADS</strong>.
        </p>
        {connectButton("Connect Google Ads")}
        {connect.isError ? <p role="alert" className="text-sm text-destructive">{errorText(connect.error)}</p> : null}
      </div>
    );
  }
  if (connection.status !== "active") {
    return (
      <div className="space-y-4">
        <p>Google no longer accepts OpenADS's access for {connection.googleEmail ?? "this Google account"}. Reconnect once to resume reporting.</p>
        {connectButton("Reconnect Google Ads")}
        {connect.isError ? <p role="alert" className="text-sm text-destructive">{errorText(connect.error)}</p> : null}
      </div>
    );
  }
  if (!connection.accountsDiscoveredAt) {
    return (
      <div className="space-y-4">
        <p>
          Connected as <strong className="font-medium">{connection.googleEmail ?? "your Google account"}</strong>, but Google
          has not returned the ad accounts yet. After fixing a setup step, load them again.
        </p>
        <Button pending={load.isPending} onClick={() => load.mutate()}>Load accounts</Button>
        {load.isError ? <p role="alert" className="text-sm text-destructive">{errorText(load.error)}</p> : null}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <p>
        Connected as <strong className="font-medium">{connection.googleEmail ?? "your Google account"}</strong>.{" "}
        {connection.selectedAccounts} of {connection.eligibleAccounts} ad account{connection.eligibleAccounts === 1 ? "" : "s"} selected.
      </p>
      <div className="flex flex-wrap gap-2">
        {connection.selectedAccounts > 0 ? (
          <>
            <Button nativeButton={false} render={<Link to="/" />}>Open the report</Button>
            <Button variant="outline" nativeButton={false} render={<Link to="/sources/google/accounts" />}>Choose accounts</Button>
          </>
        ) : (
          <Button nativeButton={false} render={<Link to="/sources/google/accounts" />}>Choose accounts</Button>
        )}
      </div>
    </div>
  );
}

export function GoogleSetupPage() {
  const search = useSearch({ from: "/sources/google/setup" });
  const queryClient = useQueryClient();
  const setupQuery = useQuery({ queryKey: ["googleSetup"], queryFn: fetchGoogleSetup });
  const setup = setupQuery.data;
  const [active, setActive] = useState<SetupStepKey | null>(null);

  // Open the step that fixes the reported problem, else the first unfinished one.
  useEffect(() => {
    if (setup && active === null) setActive(initialStep(setup, search.error));
  }, [setup, active, search.error]);
  useEffect(() => {
    if (search.error) setActive(SETUP_ERROR_STEP[search.error]);
  }, [search.error]);

  const progress = useMutation({
    mutationFn: saveGoogleSetup,
    onSuccess: (next, variables) => {
      queryClient.setQueryData(["googleSetup"], next);
      const finished = variables.steps && Object.values(variables.steps).some(Boolean);
      if (finished || variables.projectId) {
        const done = completedSteps(next);
        const index = SETUP_STEPS.indexOf(active ?? "project");
        const following = SETUP_STEPS.slice(index + 1).find((step) => !done[step]);
        if (following) setActive(following);
      }
      toast.success(variables.projectId ? "Google Cloud project saved" : finished ? "Step marked done" : "Step reopened");
    },
    onError: (error) => toast.error(safeMessage(error, "The setup step was not saved. Try again.")),
  });

  const forbidden = setupQuery.error instanceof SourcesError && setupQuery.error.status === 403;
  const guide = (
    <Button
      variant="ghost"
      size="sm"
      nativeButton={false}
      render={<a href={GOOGLE_ADS_GUIDE_URL} target="_blank" rel="noopener noreferrer" />}
    >
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
        title="Only workspace admins can set up Google Ads"
        description="An admin of this OpenADS instance (OPENADS_ADMIN_EMAILS) connects it to their Google Cloud project once; then everyone sees the reports."
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
    const attention = search.error ? SETUP_ERROR_STEP[search.error] : null;
    const done = completedSteps(setup);
    if (attention) done[attention] = false;
    const step = active ?? initialStep(setup, search.error);
    const index = SETUP_STEPS.indexOf(step);
    const blocked = setup.prerequisites.publicOrigin !== "ok" || !setup.prerequisites.database;
    const count = SETUP_STEPS.filter((key) => done[key]).length;
    const stepError = search.error && SETUP_ERROR_STEP[search.error] === step ? ERROR_COPY[search.error] : null;
    const manual = (["api", "explorer", "consent", "client"] as const).includes(step as ManualStep) ? (step as ManualStep) : null;
    const go = (next: SetupStepKey) => setActive(next);
    const panels: Record<SetupStepKey, ReactNode> = {
      project: <ProjectStep setup={setup} saving={progress.isPending} onSave={(projectId) => progress.mutate({ projectId })} />,
      api: <ApiStep setup={setup} />,
      explorer: <ExplorerStep setup={setup} />,
      consent: <ConsentStep setup={setup} />,
      client: <ClientStep setup={setup} />,
      credentials: <CredentialsStep setup={setup} attention={attention === "credentials"} onSaved={() => go("connect")} />,
      connect: <ConnectStep setup={setup} go={go} />,
    };
    body = (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <p className="max-w-2xl text-sm text-muted-foreground">
            Connect OpenADS to your own Google Cloud project — about ten minutes, once per instance. Progress is saved, so
            you can leave and come back.
          </p>
          <span className="text-xs font-medium text-muted-foreground tabular-nums" aria-live="polite">
            {count} of {SETUP_STEPS.length} done
          </span>
        </div>
        <Prerequisites setup={setup} onRecheck={() => void setupQuery.refetch()} rechecking={setupQuery.isFetching} />
        <div className="grid gap-3 lg:grid-cols-[16rem_minmax(0,1fr)] lg:gap-6">
          <Stepper steps={SETUP_STEPS} titles={STEP_TITLES} active={step} done={done} attention={attention} disabled={blocked} onSelect={go} />
          <section
            aria-labelledby="setup-step-title"
            className={cn("min-w-0 rounded-xl border border-border bg-card shadow-sm", blocked && "opacity-60")}
          >
            <header className="border-b border-border px-4 py-3 md:px-5">
              <p className="text-xs font-medium text-muted-foreground">Step {index + 1} of {SETUP_STEPS.length}</p>
              <h2 id="setup-step-title" className="text-base font-semibold">{STEP_TITLES[step]}</h2>
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
                <Button variant="ghost" size="sm" disabled={index === 0} onClick={() => go(SETUP_STEPS[index - 1]!)}>Back</Button>
                {index < SETUP_STEPS.length - 1 ? (
                  <Button variant="ghost" size="sm" onClick={() => go(SETUP_STEPS[index + 1]!)}>Next</Button>
                ) : null}
              </div>
            </footer>
            {progress.isError ? (
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
    <AppShell title="Set up Google Ads" actions={guide}>
      <div className="mx-auto w-full max-w-6xl p-4 md:p-6">{body}</div>
    </AppShell>
  );
}
