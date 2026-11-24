// Wizard steps with input: the Google Cloud project ID and the OAuth client.
import { useId, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { safeMessage } from "@/client/lib/feedback";
import { ExternalLink, KeyRound } from "lucide-react";
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
  CONSOLE,
  consoleUrl,
  deleteGoogleCredentials,
  isClientId,
  isClientSecret,
  isProjectId,
  saveGoogleCredentials,
  SourcesError,
  type GoogleSetup,
} from "@/client/lib/sources";

function FieldError({ id, children }: { id: string; children: string | null }) {
  return children ? <p id={id} role="alert" className="mt-1 text-xs text-destructive">{children}</p> : null;
}

export function ProjectStep({ setup, saving, onSave }: {
  setup: GoogleSetup; saving: boolean; onSave: (projectId: string) => void;
}) {
  const id = useId();
  const [value, setValue] = useState(setup.projectId ?? "");
  const [touched, setTouched] = useState(false);
  const normalized = value.trim().toLowerCase();
  const error = touched && !isProjectId(normalized)
    ? "6–30 lowercase letters, digits or hyphens, starting with a letter (the project ID, not its name)."
    : null;
  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (isProjectId(normalized)) onSave(normalized);
  }
  return (
    <>
      <p className="text-[15px] leading-relaxed">
        Use a Google Cloud project just for OpenADS. Create one, or pick an existing one, and paste its project ID: every
        link in the next steps then opens in that project.
      </p>
      <form onSubmit={submit} noValidate className="space-y-3">
        <div className="max-w-md">
          <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted-foreground">Project ID</label>
          <Input
            id={id}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="openads-123456"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : `${id}-hint`}
            className="font-mono"
          />
          {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : (
            <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">
              Shown in the project picker at the top of Google Cloud and on the project's dashboard.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" pending={saving} disabled={normalized === setup.projectId}>
            {setup.projectId ? "Save project" : "Continue"}
          </Button>
          <Button
            variant="outline"
            nativeButton={false}
            render={<a href={consoleUrl(CONSOLE.createProject, null)} target="_blank" rel="noopener noreferrer" />}
          >
            Create a project
            <ExternalLink aria-hidden />
          </Button>
        </div>
      </form>
    </>
  );
}

export function CredentialsStep({ setup, attention = false, onSaved }: {
  setup: GoogleSetup;
  /** Google rejected the saved client: replacing it is this screen's main action. */
  attention?: boolean;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const idField = useId();
  const secretField = useId();
  const [replacing, setReplacing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [touched, setTouched] = useState(false);
  const save = useMutation({
    mutationFn: () => saveGoogleCredentials(clientId.trim(), clientSecret.trim()),
    onSuccess: (next) => {
      queryClient.setQueryData(["googleSetup"], next);
      void queryClient.invalidateQueries({ queryKey: ["sources"] });
      setClientSecret("");
      setReplacing(false);
      toast.success("Google OAuth client saved");
      if (next.ready) onSaved();
    },
    onError: (error) => toast.error(safeMessage(error, "Google OAuth client was not saved. Try again.")),
  });
  const remove = useMutation({
    mutationFn: deleteGoogleCredentials,
    onSuccess: (next) => {
      queryClient.setQueryData(["googleSetup"], next);
      void queryClient.invalidateQueries({ queryKey: ["sources"] });
      setRemoving(false);
      toast.success("Google OAuth client removed");
    },
    onError: (error) => toast.error(safeMessage(error, "Google OAuth client was not removed. Try again.")),
  });

  const client = setup.client;
  if (client?.source === "deployment") {
    return (
      <Alert variant={client.valid ? "info" : "destructive"}>
        <KeyRound aria-hidden />
        <AlertTitle>Managed by the deployment</AlertTitle>
        <AlertDescription className="min-w-0 space-y-2">
          <p>
            This instance reads its OAuth client from GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET. To change it,
            update those settings and deploy again.
          </p>
          {client.clientId ? <code className="block text-xs break-all">{client.clientId}</code> : null}
        </AlertDescription>
      </Alert>
    );
  }
  if (setup.prerequisites.encryptionKey !== "ok") {
    return (
      <p className="text-muted-foreground">
        Set TOKEN_ENCRYPTION_KEY first (see above): OpenADS stores the client secret only encrypted with it.
      </p>
    );
  }

  const serverError = save.error instanceof SourcesError ? save.error : null;
  const idError = touched && !isClientId(clientId.trim())
    ? "Paste the Client ID: it ends with .apps.googleusercontent.com."
    : serverError?.field === "clientId" ? serverError.message : null;
  const secretError = touched && !isClientSecret(clientSecret.trim())
    ? "Paste the client secret shown when the client was created."
    : serverError?.field === "clientSecret" ? serverError.message : null;
  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (isClientId(clientId.trim()) && isClientSecret(clientSecret.trim())) save.mutate();
  }

  if (client && !replacing) {
    return (
      <>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
          <dt className="text-muted-foreground">Client ID</dt>
          <dd className="min-w-0 truncate font-mono text-[13px]" title={client.clientId ?? undefined}>{client.clientId}</dd>
          <dt className="text-muted-foreground">Client secret</dt>
          <dd>Saved • ends with <span className="font-mono">…{client.secretLast4}</span></dd>
        </dl>
        <p className="text-muted-foreground">
          The secret is stored encrypted and never shown again. Replace it after rotating the secret in Google Cloud.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant={attention ? "default" : "outline"} onClick={() => { setReplacing(true); setClientId(client.clientId ?? ""); }}>
            Replace
          </Button>
          <Button variant="ghost" className="text-destructive" onClick={() => setRemoving(true)}>Remove</Button>
        </div>
        <AlertDialog open={removing} onOpenChange={(open) => { if (!remove.isPending) setRemoving(open); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove the OAuth client?</AlertDialogTitle>
              <AlertDialogDescription>
                OpenADS deletes the stored Client ID and secret. Google Ads reports stop until a client is saved again;
                connected accounts are kept.
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
        Copy the Client ID and Client secret from the dialog Google showed after creating the client.
      </p>
      <form onSubmit={submit} noValidate className="max-w-xl space-y-3">
        <div>
          <label htmlFor={idField} className="mb-1 block text-xs font-medium text-muted-foreground">Client ID</label>
          <Input
            id={idField}
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            placeholder="1234567890-abc123.apps.googleusercontent.com"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={idError ? true : undefined}
            aria-describedby={idError ? `${idField}-error` : undefined}
            className="font-mono"
          />
          <FieldError id={`${idField}-error`}>{idError}</FieldError>
        </div>
        <div>
          <label htmlFor={secretField} className="mb-1 block text-xs font-medium text-muted-foreground">Client secret</label>
          <Input
            id={secretField}
            type="password"
            value={clientSecret}
            onChange={(event) => setClientSecret(event.target.value)}
            placeholder="GOCSPX-…"
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
