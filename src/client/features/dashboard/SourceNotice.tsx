import { Link } from "@tanstack/react-router";
import { ExternalLink, Info, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import { useGoogleConnect } from "@/client/features/sources/useGoogleConnect";
import { useMetaConnect } from "@/client/features/sources/useMetaConnect";
import { formatExpiry } from "@/client/lib/meta";
import { PLATFORM_LABEL, type Platform, type Report, type Source } from "@/client/lib/report";
import { SourcesError } from "@/client/lib/sources";

const PATHS = {
  google: { accounts: "/sources/google/accounts", setup: "/sources/google/setup" },
  meta: { accounts: "/sources/meta/accounts", setup: "/sources/meta/setup" },
} as const;

/**
 * One actionable notice per source that could not report for a reason the
 * workspace can fix (expired access, not connected, no accounts, setup), plus a
 * warning when Meta's access ends within 7 days. Shown alongside other sources'
 * figures; the empty dashboard has its own call to action.
 */
export function SourceNotice({ report }: { report: Report }) {
  return (
    <>
      {report.sources.map((source) => <PlatformNotice key={source.platform} source={source} />)}
    </>
  );
}

function PlatformNotice({ source }: { source: Source }) {
  const platform = source.platform;
  const name = PLATFORM_LABEL[platform];
  if (source.reconnectBy && source.status === "available") return <ReconnectNotice platform={platform} expiresAt={source.reconnectBy} />;
  if (!source.detail) return null;
  if (source.detail === "reconnect_required") return <ReconnectNotice platform={platform} />;
  if (source.detail === "setup_required") {
    return (
      <Alert variant="warning">
        <TriangleAlert aria-hidden />
        <AlertTitle>{name} setup needs attention</AlertTitle>
        <AlertDescription>
          {platform === "google"
            ? "Google refused this instance's Google Cloud setup (OAuth client, API or access level),"
            : "This instance's Meta app (App ID and App Secret) is missing or not usable,"}{" "}
          so {name} figures show — instead of zero. A workspace admin fixes it in the setup.
        </AlertDescription>
        <div className="col-start-2 mt-2">
          <Button
            size="sm"
            nativeButton={false}
            render={<Link to={PATHS[platform].setup} search={source.setupIssue ? { error: source.setupIssue } : {}} />}
          >
            Open {name} setup
          </Button>
        </div>
      </Alert>
    );
  }
  const choose = source.detail === "no_accounts_selected";
  return (
    <Alert variant="info">
      <Info aria-hidden />
      <AlertTitle>{choose ? `No ${name} account selected` : `${name} is not connected`}</AlertTitle>
      <AlertDescription>
        {choose ? `Choose the ${name} accounts this workspace reports on.` : `Connect ${name} to add its campaigns to this report.`}
      </AlertDescription>
      <div className="col-start-2 mt-2">
        <Button size="sm" variant="outline" nativeButton={false} render={<Link to={choose ? PATHS[platform].accounts : "/sources"} />}>
          {choose ? "Choose accounts" : "Go to Sources"}
        </Button>
      </div>
    </Alert>
  );
}

/**
 * Reconnect starts the provider's consent directly; the server refuses
 * non-admins with a fixed message. With `expiresAt`, a warning before Meta's
 * long-lived token ends; without it, access already ended.
 */
function ReconnectNotice({ platform, expiresAt }: { platform: Platform; expiresAt?: string }) {
  const google = useGoogleConnect();
  const meta = useMetaConnect();
  const connect = platform === "google" ? google : meta;
  const opening = connect.isPending || connect.isSuccess;
  const name = PLATFORM_LABEL[platform];
  const provider = platform === "google" ? "Google" : "Facebook";
  return (
    <Alert variant={expiresAt ? "warning" : "destructive"}>
      <TriangleAlert aria-hidden />
      <AlertTitle>{expiresAt ? `${name} access ends on ${formatExpiry(expiresAt)}` : `${name} access expired`}</AlertTitle>
      <AlertDescription>
        {expiresAt
          ? `Meta's long-lived access lasts about 60 days. A workspace admin reconnects once to keep ${name} in this report.`
          : `${platform === "google" ? "Google" : "Meta"} no longer accepts OpenADS's access (it was revoked or expired). ${name} figures show — instead of zero until a workspace admin reconnects it.`}
      </AlertDescription>
      <div className="col-start-2 mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button size="sm" pending={opening} onClick={() => (platform === "google" ? google.mutate() : meta.mutate())}>
          {opening ? null : <ExternalLink aria-hidden />}
          {opening ? `Opening ${provider}…` : `Reconnect ${name}`}
        </Button>
        {connect.isError ? (
          <span role="status" className="text-sm text-destructive">
            {connect.error instanceof SourcesError ? connect.error.message : "Reconnect did not start. Try again."}
          </span>
        ) : null}
      </div>
    </Alert>
  );
}
