// Wizard steps done in Google Cloud. Google's forms cannot be prefilled by URL
// (beyond `project`), so each step links to the exact console page and offers
// copy buttons for every value to type there.
import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { CopyField } from "@/client/components/CopyField";
import { Button } from "@/client/components/ui/button";
import { CONSOLE, consoleUrl, type GoogleSetup } from "@/client/lib/sources";

/** Opens a Google Cloud console page in a new tab. */
export function ConsoleButton({
  path,
  setup,
  children,
  primary = true,
}: {
  path: string;
  setup: GoogleSetup;
  children: ReactNode;
  primary?: boolean;
}) {
  return (
    <Button
      variant={primary ? "default" : "outline"}
      size={primary ? "default" : "sm"}
      nativeButton={false}
      render={<a href={consoleUrl(path, setup.projectId)} target="_blank" rel="noopener noreferrer" />}
    >
      {children}
      <ExternalLink aria-hidden />
    </Button>
  );
}

function Lead({ children }: { children: ReactNode }) {
  return <p className="text-[15px] leading-relaxed text-foreground">{children}</p>;
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground">{children}</p>;
}

export function ApiStep({ setup }: { setup: GoogleSetup }) {
  return (
    <>
      <Lead>Enable the Google Ads API in your project. This gives the project Test access.</Lead>
      <ConsoleButton path={CONSOLE.enableApi} setup={setup}>Enable the API in Google Cloud</ConsoleButton>
      <Note>Confirm the project shown at the top is {setup.projectId ? <code>{setup.projectId}</code> : "yours"}, then click Enable.</Note>
    </>
  );
}

export function ExplorerStep({ setup }: { setup: GoogleSetup }) {
  return (
    <>
      <Lead>
        On the Google Ads API Overview page, expand <strong className="font-medium">Upgrade access level</strong> and
        apply for <strong className="font-medium">Explorer</strong> access.
      </Lead>
      <ConsoleButton path={CONSOLE.adsApiOverview} setup={setup}>Open the Google Ads API Overview</ConsoleButton>
      <Note>
        Google approves most projects automatically. Explorer allows 2,880 operations a day on real ad accounts — OpenADS
        uses about one per selected account per report. Test access only reaches test accounts; Basic access (15,000 a
        day) needs Google's brand verification.
      </Note>
    </>
  );
}

function SubTask({ index, title, path, setup, children }: {
  index: string; title: string; path: string; setup: GoogleSetup; children: ReactNode;
}) {
  return (
    <li className="space-y-3 rounded-lg border border-border p-3 md:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">
          <span className="mr-1.5 text-muted-foreground tabular-nums">{index}</span>
          {title}
        </h3>
        <ConsoleButton path={path} setup={setup} primary={false}>Open {title}</ConsoleButton>
      </div>
      {children}
    </li>
  );
}

export function ConsentStep({ setup }: { setup: GoogleSetup }) {
  const v = setup.values;
  return (
    <>
      <Lead>
        Set up the sign-in screen people see when they connect: name it, keep it External, add yourself as a test user,
        add the Google Ads scope, then publish it.
      </Lead>
      <ConsoleButton path={CONSOLE.authOverview} setup={setup}>Open Google Auth Platform</ConsoleButton>
      <Note>If it says “Google Auth platform not configured yet”, click Get started; it asks for the branding values below.</Note>
      <ol className="space-y-3">
        <SubTask index="a" title="Branding" path={CONSOLE.branding} setup={setup}>
          <div className="grid gap-3 md:grid-cols-2">
            <CopyField label="App name" value={v.appName} />
            <CopyField label="User support email" value={v.adminEmail} hint="Or any email your Google account can choose." />
            <CopyField label="Developer contact email" value={v.adminEmail} />
            {v.authorizedDomain ? (
              <CopyField label="Authorized domain" value={v.authorizedDomain} hint="The registrable domain of this instance." />
            ) : null}
          </div>
        </SubTask>
        <SubTask index="b" title="Audience" path={CONSOLE.audience} setup={setup}>
          <Note>
            User type <strong className="font-medium text-foreground">External</strong>. Under Test users, add the Google
            account you will connect with. Then click <strong className="font-medium text-foreground">Publish app</strong> so
            the status is <strong className="font-medium text-foreground">In production</strong>: in Testing, Google expires
            the connection after 7 days. You do not need Google's verification for your own use.
          </Note>
          <CopyField label="Test user" value={v.adminEmail} hint="Use the Google account that can see your ad accounts, if it is a different one." />
        </SubTask>
        <SubTask index="c" title="Data access" path={CONSOLE.scopes} setup={setup}>
          <Note>Click Add or remove scopes, paste the scope under “Manually add scopes”, click Add to table, Update, then Save.</Note>
          <CopyField label="Scope" value={v.scope} />
        </SubTask>
      </ol>
    </>
  );
}

export function ClientStep({ setup }: { setup: GoogleSetup }) {
  const uri = setup.values.redirectUri;
  return (
    <>
      <Lead>
        Create an OAuth client: <strong className="font-medium">Create client → Web application</strong>, name it, add the
        redirect URI below under Authorized redirect URIs, then Create.
      </Lead>
      <ConsoleButton path={CONSOLE.clients} setup={setup}>Open OAuth clients</ConsoleButton>
      <div className="grid gap-3 md:grid-cols-2">
        <CopyField label="Application type" value="Web application" />
        <CopyField label="Name" value={setup.values.appName} />
      </div>
      {uri ? (
        <CopyField
          label="Authorized redirect URI"
          value={uri}
          prominent
          hint="Must match exactly: same scheme, host and port, no trailing slash. No JavaScript origin is needed."
        />
      ) : null}
      <Note>
        Google shows the client secret only once. Keep the dialog open (or download the JSON) and continue to the next
        step.
      </Note>
      {uri ? (
        <details className="group rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 font-medium select-none">I got “redirect_uri_mismatch”</summary>
          <div className="space-y-3 border-t border-border px-3 py-3">
            <Note>
              Google compares the redirect URI character by character with the one OpenADS sends. Edit your OAuth client,
              replace the Authorized redirect URI with this exact value, save, wait a minute, then connect again. If this
              address is not where you opened OpenADS, PUBLIC_ORIGIN is set to a different address.
            </Note>
            <CopyField label="Exact redirect URI" value={uri} prominent />
          </div>
        </details>
      ) : null}
    </>
  );
}
