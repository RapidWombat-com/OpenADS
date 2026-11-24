// Meta Ads wizard steps. Meta's App Dashboard cannot be prefilled by URL, so
// each step links to the exact page of the operator's app (by App ID, in a new
// tab) and offers copy buttons for every value to enter there.
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { safeMessage } from "@/client/lib/feedback";
import { KeyRound } from "lucide-react";
import { CopyField } from "@/client/components/CopyField";
import { Alert, AlertDescription, AlertTitle } from "@/client/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/client/components/ui/alert-dialog";
import { Button } from "@/client/components/ui/button";
import { Input } from "@/client/components/ui/input";
import {
  deleteMetaCredentials,
  isMetaAppId,
  isMetaAppSecret,
  META_CREATE_APP_URL,
  META_DASHBOARD,
  metaAppUrl,
  saveMetaCredentials,
  type MetaSetup,
} from "@/client/lib/meta";
import { SourcesError } from "@/client/lib/sources";
import { ExternalButton, Lead, Note } from "./Wizard";

function Strong({ children }: { children: ReactNode }) {
  return <strong className="font-medium text-foreground">{children}</strong>;
}

function SubTask({ index, title, action, children }: {
  index: string; title: string; action?: ReactNode; children: ReactNode;
}) {
  return (
    <li className="space-y-3 rounded-lg border border-border p-3 md:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">
          <span className="mr-1.5 text-muted-foreground tabular-nums">{index}</span>
          {title}
        </h3>
        {action}
      </div>
      {children}
    </li>
  );
}

function FieldError({ id, children }: { id: string; children: string | null }) {
  return children ? <p id={id} role="alert" className="mt-1 text-xs text-destructive">{children}</p> : null;
}

export function AppStep({ setup }: { setup: MetaSetup }) {
  return (
    <>
      <Lead>
        Create a Meta app for OpenADS in Meta for Developers. It stays in <Strong>Development mode</Strong>: only people
        with a role on the app can connect, and no App Review is needed.
      </Lead>
      <ExternalButton href={META_CREATE_APP_URL}>Create an app in Meta</ExternalButton>
      <ol className="list-decimal space-y-2 pl-5 marker:text-muted-foreground">
        <li>
          <Strong>App details</Strong>: app name and contact email.
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            <CopyField label="App name" value={setup.values.appName} />
            <CopyField label="App contact email" value={setup.values.adminEmail} hint="Or any address you read." />
          </div>
        </li>
        <li>
          <Strong>Use cases</Strong>: choose <Strong>Measure ad performance data with Marketing API</Strong> (under Ads and
          monetization). <Strong>Create &amp; manage ads with Marketing API</Strong> works too: both include{" "}
          <code>ads_read</code>. If neither is listed, choose <Strong>Other</Strong>, then app type <Strong>Business</Strong>.
        </li>
        <li>
          <Strong>Business</Strong>: “I don&apos;t want to connect a business portfolio yet” is fine for your own instance.
        </li>
        <li>
          <Strong>Requirements</Strong> and <Strong>Overview</Strong>: Next, then <Strong>Go to dashboard</Strong>.
        </li>
      </ol>
      <Note>
        First time on Meta for Developers? It asks you to register as a developer once (confirm your account, accept the
        terms). Meta adds Facebook Login for Business to the app automatically.
      </Note>
    </>
  );
}

export function AppIdStep({ setup, saving, error, onSave }: {
  setup: MetaSetup; saving: boolean; error: string | null; onSave: (appId: string) => void;
}) {
  const id = useId();
  const [value, setValue] = useState(setup.appId ?? "");
  const [touched, setTouched] = useState(false);
  const normalized = value.trim();
  const managed = setup.app?.source === "deployment";
  const invalid = touched && !isMetaAppId(normalized) ? "Digits only: the App ID shown at the top of the App Dashboard." : null;
  const fieldError = invalid ?? error;
  const replacing = Boolean(setup.appId && setup.app?.source === "instance" && normalized !== setup.appId && isMetaAppId(normalized));
  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (isMetaAppId(normalized)) onSave(normalized);
  }
  if (managed) {
    return (
      <Alert variant="info">
        <KeyRound aria-hidden />
        <AlertTitle>Managed by the deployment</AlertTitle>
        <AlertDescription>
          This instance reads its Meta app from META_APP_ID and META_APP_SECRET; links below open App ID{" "}
          <code>{setup.appId ?? "—"}</code>.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <>
      <Lead>
        Paste your app&apos;s <Strong>App ID</Strong>. Every link in the next steps then opens your app&apos;s pages
        directly.
      </Lead>
      <form onSubmit={submit} noValidate className="space-y-3">
        <div className="max-w-md">
          <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted-foreground">App ID</label>
          <Input
            id={id}
            value={value}
            inputMode="numeric"
            onChange={(event) => setValue(event.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="1234567890123456"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? `${id}-error` : `${id}-hint`}
            className="font-mono"
          />
          {fieldError ? <FieldError id={`${id}-error`}>{fieldError}</FieldError> : (
            <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">
              At the top of the App Dashboard, and under App settings → Basic. It is not secret.
            </p>
          )}
        </div>
        {replacing ? (
          <p role="status" className="text-sm text-warning-foreground dark:text-warning">
            Saving another App ID removes the saved App Secret and asks you to reconnect Meta Ads.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" pending={saving} disabled={normalized === setup.appId}>
            {setup.appId ? "Save App ID" : "Continue"}
          </Button>
          <Button variant="outline" nativeButton={false} render={<a href="https://developers.facebook.com/apps/" target="_blank" rel="noopener noreferrer" />}>
            Find it in My Apps
          </Button>
        </div>
      </form>
    </>
  );
}

export function LoginStep({ setup }: { setup: MetaSetup }) {
  const v = setup.values;
  return (
    <>
      <Lead>
        Tell Meta where to send people back after they connect: the redirect URI and this instance&apos;s domain.
      </Lead>
      <ExternalButton href={metaAppUrl(setup.appId, META_DASHBOARD.businessLogin)}>
        Open Facebook Login for Business settings
      </ExternalButton>
      <ol className="space-y-3">
        <SubTask index="a" title="Facebook Login for Business → Settings">
          {v.redirectUri ? (
            <CopyField
              label="Valid OAuth Redirect URIs"
              value={v.redirectUri}
              prominent
              hint="Must match exactly: same scheme, host and port, no trailing slash."
            />
          ) : null}
          <Note>
            Under <Strong>Client OAuth settings</Strong>, keep <Strong>Client OAuth login</Strong>,{" "}
            <Strong>Web OAuth login</Strong>, <Strong>Enforce HTTPS</Strong> and <Strong>Use Strict Mode for redirect
            URIs</Strong> on, paste the URI, then <Strong>Save changes</Strong>.
          </Note>
          {v.localhost ? (
            <Note>
              This instance runs on localhost. Meta accepts <code>http://localhost</code> redirects only while the app is in
              Development mode.
            </Note>
          ) : null}
          <Note>
            Is the left menu showing <Strong>Facebook Login</Strong> instead? Use{" "}
            <a className="underline underline-offset-4" href={metaAppUrl(setup.appId, META_DASHBOARD.facebookLogin)} target="_blank" rel="noopener noreferrer">
              its Settings page
            </a>
            ; the fields are the same.
          </Note>
        </SubTask>
        <SubTask
          index="b"
          title="App settings → Basic"
          action={<ExternalButton href={metaAppUrl(setup.appId, META_DASHBOARD.basicSettings)} primary={false}>Open App settings</ExternalButton>}
        >
          {v.appDomain ? <CopyField label="App domains" value={v.appDomain} hint="This instance's host name." /> : null}
          <Note>
            <Strong>Privacy policy URL</Strong> is needed only to switch the app to Live mode. In Development mode you can
            leave it empty; if Meta asks for it, any public page with your privacy policy works. Then{" "}
            <Strong>Save changes</Strong>.
          </Note>
        </SubTask>
      </ol>
      {v.redirectUri ? (
        <details className="group rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 font-medium select-none">I got “URL blocked” or “Can&apos;t load URL”</summary>
          <div className="space-y-3 border-t border-border px-3 py-3">
            <Note>
              Facebook shows “URL blocked: This redirect failed because the redirect URI is not whitelisted in the app&apos;s
              Client OAuth Settings” when the URI below is not in <Strong>Valid OAuth Redirect URIs</Strong> character for
              character, or Client/Web OAuth login is off. “Can&apos;t load URL: The domain of this URL isn&apos;t included in
              the app&apos;s domains” means the domain is missing under App settings → Basic → App domains. Fix it, save,
              wait a minute, then connect again. If this address is not where you opened OpenADS, PUBLIC_ORIGIN is set to
              another address.
            </Note>
            <CopyField label="Exact redirect URI" value={v.redirectUri} prominent />
          </div>
        </details>
      ) : null}
    </>
  );
}

export function AccessStep({ setup }: { setup: MetaSetup }) {
  return (
    <>
      <Lead>
        OpenADS asks only for <code>ads_read</code>: it lists your ad accounts and reads reports, and never changes ads.
        Check the permission, then give everyone who will connect a role on the app.
      </Lead>
      <ExternalButton href={metaAppUrl(setup.appId, META_DASHBOARD.roles)}>Open App roles</ExternalButton>
      <ol className="space-y-3">
        <SubTask
          index="a"
          title="Permission: ads_read"
          action={<ExternalButton href={metaAppUrl(setup.appId, META_DASHBOARD.useCases)} primary={false}>Open Use cases</ExternalButton>}
        >
          <Note>
            Open your Marketing API use case → <Strong>Customize</Strong>. <code>ads_read</code> is listed among its
            permissions (required by the use case, “Ready for testing”). OpenADS needs no other permission, not even{" "}
            <code>business_management</code>: <code>/me/adaccounts</code> also lists ad accounts you reach through a business
            portfolio.
          </Note>
          <CopyField label="Permission" value={setup.values.scope} />
        </SubTask>
        <SubTask index="b" title="App roles">
          <Note>
            In Development mode only people with a role on the app can connect. You created the app, so you are its
            Administrator. To let a teammate connect, add them under <Strong>App roles → Roles → Add People</Strong> as{" "}
            <Strong>Developer</Strong> (or Administrator); they accept the invitation at{" "}
            <a className="underline underline-offset-4" href="https://developers.facebook.com/requests/" target="_blank" rel="noopener noreferrer">developers.facebook.com/requests</a>.
            Whoever connects also needs access to the ad accounts themselves, in Ads Manager or Business settings.
          </Note>
        </SubTask>
      </ol>
      <Note>
        Development mode with Meta&apos;s default <Strong>Limited access</Strong> (formerly “Standard Access”) is enough for
        your own team: no App Review and no business verification. App Review (Full access) is needed only to connect ad
        accounts of people who have no role on your app.
      </Note>
      <details className="group rounded-lg border border-border">
        <summary className="cursor-pointer px-3 py-2 font-medium select-none">Facebook said “App not active” or “This app isn&apos;t available”</summary>
        <div className="border-t border-border px-3 py-3">
          <Note>
            The Facebook account you signed in with has no role on the app yet (or has not accepted the invitation). Add it
            under App roles, accept the invitation, then connect again. Signed in to the wrong Facebook account? Log out of
            Facebook in this browser and connect again.
          </Note>
        </div>
      </details>
    </>
  );
}

export function MetaCredentialsStep({ setup, attention = false, onSaved }: {
  setup: MetaSetup;
  /** Meta rejected the saved app: replacing it is this screen's main action. */
  attention?: boolean;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const idField = useId();
  const secretField = useId();
  const [replacing, setReplacing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [appId, setAppId] = useState(setup.appId ?? "");
  const [appSecret, setAppSecret] = useState("");
  const [touched, setTouched] = useState(false);
  const save = useMutation({
    mutationFn: () => saveMetaCredentials(appId.trim(), appSecret.trim()),
    onSuccess: (next) => {
      queryClient.setQueryData(["metaSetup"], next);
      void queryClient.invalidateQueries({ queryKey: ["sources"] });
      setAppSecret("");
      setReplacing(false);
      toast.success("Meta app credentials saved");
      if (next.ready) onSaved();
    },
    onError: (error) => toast.error(safeMessage(error, "Meta app credentials were not saved. Try again.")),
  });
  const remove = useMutation({
    mutationFn: deleteMetaCredentials,
    onSuccess: (next) => {
      queryClient.setQueryData(["metaSetup"], next);
      void queryClient.invalidateQueries({ queryKey: ["sources"] });
      setRemoving(false);
      toast.success("Meta app credentials removed");
    },
    onError: (error) => toast.error(safeMessage(error, "Meta app credentials were not removed. Try again.")),
  });

  const app = setup.app;
  if (app?.source === "deployment") {
    return (
      <Alert variant={app.valid ? "info" : "destructive"}>
        <KeyRound aria-hidden />
        <AlertTitle>Managed by the deployment</AlertTitle>
        <AlertDescription className="min-w-0 space-y-2">
          <p>
            This instance reads its Meta app from META_APP_ID and META_APP_SECRET. To change it, update those settings and
            deploy again.
          </p>
          {app.appId ? <code className="block text-xs break-all">{app.appId}</code> : null}
        </AlertDescription>
      </Alert>
    );
  }
  if (setup.prerequisites.encryptionKey !== "ok") {
    return (
      <p className="text-muted-foreground">
        Set TOKEN_ENCRYPTION_KEY first (see above): OpenADS stores the App Secret only encrypted with it.
      </p>
    );
  }

  const serverError = save.error instanceof SourcesError ? save.error : null;
  const idError = touched && !isMetaAppId(appId.trim())
    ? "Digits only: the App ID shown at the top of the App Dashboard."
    : serverError?.field === "appId" ? serverError.message : null;
  const secretError = touched && !isMetaAppSecret(appSecret.trim())
    ? "32 characters (letters a–f and digits): App settings → Basic → App secret → Show."
    : serverError?.field === "appSecret" ? serverError.message : null;
  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (isMetaAppId(appId.trim()) && isMetaAppSecret(appSecret.trim())) save.mutate();
  }

  if (app && !replacing) {
    return (
      <>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
          <dt className="text-muted-foreground">App ID</dt>
          <dd className="min-w-0 truncate font-mono text-[13px]">{app.appId}</dd>
          <dt className="text-muted-foreground">App Secret</dt>
          <dd>Saved • ends with <span className="font-mono">…{app.secretLast4}</span></dd>
        </dl>
        <p className="text-muted-foreground">
          The secret is stored encrypted and never shown again. Replace it after resetting the App Secret in Meta.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant={attention ? "default" : "outline"} onClick={() => { setReplacing(true); setAppId(app.appId ?? ""); }}>
            Replace
          </Button>
          <Button variant="ghost" className="text-destructive" onClick={() => setRemoving(true)}>Remove</Button>
        </div>
        <AlertDialog open={removing} onOpenChange={(open) => { if (!remove.isPending) setRemoving(open); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove the App Secret?</AlertDialogTitle>
              <AlertDialogDescription>
                OpenADS deletes the stored App Secret. Meta Ads reports stop until it is saved again; the connection and
                selected ad accounts are kept.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {remove.isError ? <p role="alert" className="text-sm text-destructive">Removal did not complete. Try again.</p> : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
              <Button variant="destructive" pending={remove.isPending} onClick={() => remove.mutate()}>Remove</Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  }

  return (
    <>
      <p className="text-[15px] leading-relaxed">
        Copy the App ID and App Secret from <Strong>App settings → Basic</Strong> (click <Strong>Show</Strong> next to App
        secret; Meta asks for your Facebook password).
      </p>
      <ExternalButton href={metaAppUrl(setup.appId, META_DASHBOARD.basicSettings)} primary={false}>Open App settings → Basic</ExternalButton>
      <form onSubmit={submit} noValidate className="max-w-xl space-y-3">
        <div>
          <label htmlFor={idField} className="mb-1 block text-xs font-medium text-muted-foreground">App ID</label>
          <Input
            id={idField}
            value={appId}
            inputMode="numeric"
            onChange={(event) => setAppId(event.target.value)}
            placeholder="1234567890123456"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={idError ? true : undefined}
            aria-describedby={idError ? `${idField}-error` : undefined}
            className="font-mono"
          />
          <FieldError id={`${idField}-error`}>{idError}</FieldError>
        </div>
        <div>
          <label htmlFor={secretField} className="mb-1 block text-xs font-medium text-muted-foreground">App Secret</label>
          <Input
            id={secretField}
            type="password"
            value={appSecret}
            onChange={(event) => setAppSecret(event.target.value)}
            placeholder="32 characters"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={secretError ? true : undefined}
            aria-describedby={secretError ? `${secretField}-error` : `${secretField}-hint`}
            className="font-mono"
          />
          {secretError ? <FieldError id={`${secretField}-error`}>{secretError}</FieldError> : (
            <p id={`${secretField}-hint`} className="mt-1 text-xs text-muted-foreground">
              Stored encrypted on the server; never shown again.
            </p>
          )}
        </div>
        {save.isError && !serverError?.field ? (
          <p role="alert" className="text-sm text-destructive">
            {serverError ? serverError.message : "The credentials were not saved. Try again."}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" pending={save.isPending}>Save credentials</Button>
          {replacing ? <Button variant="ghost" onClick={() => setReplacing(false)}>Cancel</Button> : null}
        </div>
      </form>
    </>
  );
}
