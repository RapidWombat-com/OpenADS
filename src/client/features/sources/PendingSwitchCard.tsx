import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRightLeft } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import { safeMessage } from "@/client/lib/feedback";
import { formatCustomerId, resolveSwitch, type PendingSwitch } from "@/client/lib/sources";

const timeFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * An admin reconnected as another Google account / Facebook user. Nothing was
 * replaced: confirm switches the connection (accounts both logins list keep
 * their selection and project; the others are removed), cancel keeps the
 * current connection and discards the new sign-in. Same-origin POSTs.
 */
export function PendingSwitchCard({ platform, pending }: { platform: "google" | "meta"; pending: PendingSwitch }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const product = platform === "google" ? "Google Ads" : "Meta Ads";
  const who = (identity: PendingSwitch["next"]) =>
    (platform === "google" ? identity.email : identity.name)
    ?? (platform === "google" ? "another Google account" : "another Facebook user");
  const accountWord = platform === "google" ? "account" : "ad account";

  const mutation = useMutation({
    mutationFn: (action: "confirm" | "cancel") => resolveSwitch(platform, pending.id, action),
    onSuccess: async (result, action) => {
      queryClient.removeQueries({ queryKey: ["campaigns"] });
      queryClient.removeQueries({ queryKey: [platform === "google" ? "googleAccounts" : "metaAccounts"] });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["sources"] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
      if (action === "cancel") {
        toast.success(`Kept the current ${product} connection`);
        void navigate({ to: "/sources", search: {}, replace: true });
        return;
      }
      toast.success(`${product} now uses ${who(pending.next)}`);
      if ("switched" in result && result.selectedAccounts === 0 && result.eligibleAccounts > 0) {
        void navigate({ to: platform === "google" ? "/sources/google/accounts" : "/sources/meta/accounts" });
      } else {
        void navigate({ to: "/sources", search: {}, replace: true });
      }
    },
    onError: async (error) => {
      toast.error(safeMessage(error, "The change was not applied. Try again."));
      await queryClient.invalidateQueries({ queryKey: ["sources"] });
    },
  });

  const more = pending.removedAccounts - pending.removed.length;
  return (
    <Alert variant="warning">
      <ArrowRightLeft aria-hidden />
      <AlertTitle>Confirm the {product} sign-in change</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>
          You signed in as <strong className="text-foreground">{who(pending.next)}</strong>; the current connection is{" "}
          <strong className="text-foreground">{who(pending.current)}</strong>.
        </p>
        <p>
          Accounts both can access keep their selection and project ({plural(pending.keptAccounts, accountWord)});{" "}
          {pending.removedAccounts === 0
            ? `no ${accountWord}s will be removed.`
            : `${plural(pending.removedAccounts, accountWord)} the new login can't see will be removed, with their selection and project.`}
          {pending.newAccounts > 0 ? ` ${plural(pending.newAccounts, `new ${accountWord}`)} will be listed, not selected.` : null}
        </p>
        {pending.removed.length ? (
          <ul className="list-disc space-y-0.5 pl-5" aria-label={`${accountWord}s that will be removed`}>
            {pending.removed.map((account) => (
              <li key={account.customerId}>
                {account.name ?? "Unnamed"}{" "}
                <span className="tabular-nums text-muted-foreground">
                  ({platform === "google" ? formatCustomerId(account.customerId) : account.customerId}
                  {account.selected ? ", selected" : ""})
                </span>
              </li>
            ))}
            {more > 0 ? <li>and {plural(more, `more ${accountWord}`)}</li> : null}
          </ul>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            pending={mutation.isPending && mutation.variables === "confirm"}
            disabled={mutation.isPending}
            onClick={() => mutation.mutate("confirm")}
          >
            Switch to {who(pending.next)}
          </Button>
          <Button
            variant="outline"
            pending={mutation.isPending && mutation.variables === "cancel"}
            disabled={mutation.isPending}
            onClick={() => mutation.mutate("cancel")}
          >
            Cancel
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Nothing changes until you confirm. This sign-in can be confirmed until{" "}
          {timeFormat.format(new Date(pending.expiresAt))}; after that, reconnect to try again.
        </p>
      </AlertDescription>
    </Alert>
  );
}
