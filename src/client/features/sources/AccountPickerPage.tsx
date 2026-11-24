import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { safeMessage, selectionMessage } from "@/client/lib/feedback";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowRight, Building2, ExternalLink, RefreshCw, Search, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { EmptyState } from "@/client/components/EmptyState";
import { ErrorState } from "@/client/components/ErrorState";
import { Alert, AlertDescription, AlertTitle } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import { Checkbox } from "@/client/components/ui/checkbox";
import { Input } from "@/client/components/ui/input";
import { Skeleton } from "@/client/components/ui/skeleton";
import { AppShell } from "@/client/layout/AppShell";
import {
  fetchGoogleAccounts,
  formatCustomerId,
  groupAccounts,
  rediscoverGoogleAccounts,
  removeStaleGoogleAccount,
  saveGoogleAccounts,
  SourcesError,
  unavailableReason,
  type GoogleAccount,
} from "@/client/lib/sources";
import { RemoveStaleAccount } from "./RemoveStaleAccount";
import { useGoogleConnect } from "./useGoogleConnect";

const DEFAULT_MAX = 25;

function AccountRow({
  account,
  checked,
  disabled,
  onToggle,
  action,
}: {
  account: GoogleAccount;
  checked: boolean;
  disabled: boolean;
  onToggle: (checked: boolean) => void;
  action?: ReactNode;
}) {
  return (
    <li className="flex items-center">
      <label
        className={cn(
          "flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-foreground/[0.03]",
          checked && "bg-primary/5 hover:bg-primary/[0.07]",
          disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
        )}
      >
        <Checkbox checked={checked} disabled={disabled} onCheckedChange={(value) => onToggle(value === true)} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{account.name ?? "Unnamed account"}</span>
          <span className="block text-xs text-muted-foreground tabular-nums">
            {formatCustomerId(account.customerId)}
            {account.stale ? " · Not confirmed on the last refresh" : null}
          </span>
        </span>
        <span className="hidden shrink-0 text-right text-xs text-muted-foreground sm:block">
          <span className="block font-medium text-foreground">{account.currency}</span>
          <span className="block">{account.timeZone}</span>
        </span>
      </label>
      {action ? <span className="shrink-0 pr-4">{action}</span> : null}
    </li>
  );
}

export function Group({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex items-baseline gap-2 bg-muted/60 px-4 py-2 text-xs">
        <span className="font-semibold tracking-wide text-muted-foreground uppercase">{title}</span>
        {detail ? <span className="text-muted-foreground tabular-nums">{detail}</span> : null}
      </div>
      <ul className="divide-y divide-border">{children}</ul>
    </div>
  );
}

export function AccountPickerPage() {
  const search = useSearch({ from: "/sources/google/accounts" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accounts = useQuery({ queryKey: ["googleAccounts"], queryFn: fetchGoogleAccounts });
  const data = accounts.data;
  const admin = data?.role === "admin";
  const max = data?.maxSelected ?? DEFAULT_MAX;
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const connect = useGoogleConnect();

  // Start from the stored selection once it has loaded.
  useEffect(() => {
    if (data && selected === null) {
      setSelected(new Set(data.accounts.filter((account) => account.selected).map((account) => account.customerId)));
    }
  }, [data, selected]);

  const groups = useMemo(() => groupAccounts(data?.accounts ?? [], text), [data, text]);
  const eligible = (data?.accounts ?? []).filter((account) => account.eligible);
  const chosen = selected ?? new Set<string>();

  const save = useMutation({
    mutationFn: () => saveGoogleAccounts([...chosen]),
    onSuccess: async (next) => {
      queryClient.setQueryData(["googleAccounts"], next);
      queryClient.removeQueries({ queryKey: ["campaigns"] });
      await queryClient.invalidateQueries({ queryKey: ["sources"] });
      void navigate({ to: "/" });
      toast.success(selectionMessage("Google Ads", chosen.size));
    },
    onError: (error) => toast.error(safeMessage(error, "The account selection was not saved. Try again.")),
  });
  const rediscover = useMutation({
    mutationFn: rediscoverGoogleAccounts,
    onSuccess: (next) => {
      queryClient.setQueryData(["googleAccounts"], next);
      setSelected(null);
      void queryClient.invalidateQueries({ queryKey: ["sources"] });
      void navigate({ to: "/sources/google/accounts", search: {}, replace: true });
    },
    onError: (error) => {
      toast.error(safeMessage(error, "Ad accounts could not be loaded. Try again."));
      if (error instanceof SourcesError && error.reconnect) void queryClient.invalidateQueries({ queryKey: ["googleAccounts"] });
      // A Cloud project problem: open the setup step that fixes it.
      if (error instanceof SourcesError && error.setupIssue) {
        void navigate({ to: "/sources/google/setup", search: { error: error.setupIssue } });
      }
    },
  });

  function toggle(id: string, value: boolean) {
    setSelected((current) => {
      const next = new Set(current ?? []);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const busy = save.isPending || rediscover.isPending;
  // Rediscovery keeps a selected or project-assigned account it no longer lists (stale); only an admin removes it.
  const removeAction = (account: GoogleAccount) => admin && account.stale ? (
    <RemoveStaleAccount
      name={account.name ?? formatCustomerId(account.customerId)}
      disabled={busy}
      remove={() => removeStaleGoogleAccount(account.customerId)}
      onRemoved={(next) => {
        queryClient.setQueryData(["googleAccounts"], next);
        setSelected((current) => new Set([...(current ?? [])].filter((id) => id !== account.customerId)));
        queryClient.removeQueries({ queryKey: ["campaigns"] });
        void queryClient.invalidateQueries({ queryKey: ["sources"] });
        void queryClient.invalidateQueries({ queryKey: ["projects"] });
      }}
    />
  ) : null;
  const reconnectButton = (label: string) => (
    <Button pending={connect.isPending || connect.isSuccess} onClick={() => connect.mutate()}>
      {connect.isPending || connect.isSuccess ? null : <ExternalLink aria-hidden />}
      {connect.isPending || connect.isSuccess ? "Opening Google…" : label}
    </Button>
  );

  let body: ReactNode;
  if (accounts.isPending) {
    body = (
      <div role="status" aria-label="Loading accounts" className="space-y-2 rounded-xl border border-border bg-card p-4">
        {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-10 w-full" />)}
      </div>
    );
  } else if (accounts.isError || !data) {
    body = (
      <ErrorState
        variant="page"
        title="Accounts not loaded"
        message={accounts.error instanceof SourcesError ? accounts.error.message : "The account list could not be loaded."}
        onRetry={() => void accounts.refetch()}
        isRetrying={accounts.isFetching}
      />
    );
  } else if (!data.connection) {
    body = (
      <EmptyState
        variant="card"
        title="Google Ads is not connected"
        description="Connect a Google account on the Sources page first."
        action={<Button nativeButton={false} render={<Link to="/sources" />}>Go to Sources</Button>}
      />
    );
  } else if (data.connection.status !== "active") {
    body = (
      <EmptyState
        kind="error"
        variant="card"
        title="Google Ads access expired"
        description={`Google no longer accepts OpenADS's access for ${data.connection.googleEmail ?? "this Google account"}. ${admin ? "Reconnect to load accounts again." : "Ask a workspace admin to reconnect it."}`}
        action={admin ? reconnectButton("Reconnect Google Ads") : undefined}
      />
    );
  } else if (data.connection.accountsDiscoveredAt === null) {
    body = (
      <ErrorState
        variant="page"
        title="Accounts not loaded from Google"
        message="Google did not return the list of ad accounts for this connection. Try again in a moment."
        action={admin ? (
          <Button variant="outline" pending={rediscover.isPending} onClick={() => rediscover.mutate()}>
            Try again
          </Button>
        ) : undefined}
      />
    );
  } else if (eligible.length === 0) {
    body = (
      <EmptyState
        variant="card"
        icon={Building2}
        title="No ad accounts to report on"
        description={`${data.connection.googleEmail ?? "This Google account"} has no active Google Ads client accounts OpenADS can read${data.accounts.length ? " (see below)" : ""}. Sign in with another Google account, or ask to be added to an ad account.`}
        action={admin ? reconnectButton("Use another Google account") : undefined}
      />
    );
  } else {
    const limitReached = chosen.size >= max;
    const row = (account: GoogleAccount) => (
      <AccountRow
        key={account.customerId}
        account={account}
        checked={chosen.has(account.customerId)}
        disabled={!admin || busy || (limitReached && !chosen.has(account.customerId))}
        onToggle={(value) => toggle(account.customerId, value)}
        action={removeAction(account)}
      />
    );
    const nothingMatches = groups.direct.length === 0 && groups.managers.length === 0;
    body = (
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="flex items-baseline gap-2 text-sm font-semibold">
            Ad accounts
            <span className="text-xs font-normal text-muted-foreground tabular-nums">{eligible.length}</span>
          </h2>
          <div className="relative w-full sm:w-72">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              aria-label="Search accounts"
              placeholder="Search by name or ID"
              value={text}
              onChange={(event) => setText(event.target.value)}
              className="h-8 pl-8"
            />
          </div>
        </div>
        {nothingMatches ? (
          <div className="p-4">
            <EmptyState
              kind="filtered"
              variant="plain"
              size="sm"
              title="No accounts match this search"
              action={<Button variant="outline" size="sm" onClick={() => setText("")}>Clear search</Button>}
            />
          </div>
        ) : (
          <div>
            {groups.direct.length ? <Group title="Direct access">{groups.direct.map(row)}</Group> : null}
            {groups.managers.map((group) => (
              <Group
                key={group.managerId}
                title={`Via ${group.manager?.name ?? "manager account"}`}
                detail={formatCustomerId(group.managerId)}
              >
                {group.accounts.map(row)}
              </Group>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/50 px-4 py-3">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {chosen.size === 0 ? "Select at least one account" : `${chosen.size} selected`}
            {limitReached ? ` · up to ${max}` : ""}
          </p>
          {admin ? (
            <div className="flex items-center gap-2">
              <Button variant="ghost" nativeButton={false} render={<Link to="/sources" />}>Cancel</Button>
              <Button disabled={chosen.size === 0 || busy} pending={save.isPending} onClick={() => save.mutate()}>
                Show report
                {save.isPending ? null : <ArrowRight aria-hidden />}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Only workspace admins can change the selection.</p>
          )}
        </div>
      </div>
    );
  }

  const others = data?.connection?.status === "active" && data.connection.accountsDiscoveredAt ? groups.unavailable : [];
  const mutationError = save.error ?? rediscover.error;

  return (
    <AppShell
      title="Google Ads accounts"
      actions={admin && data?.connection?.status === "active" ? (
        <Button variant="outline" size="sm" pending={rediscover.isPending} disabled={busy} onClick={() => rediscover.mutate()}>
          {rediscover.isPending ? null : <RefreshCw aria-hidden />}
          Reload list
        </Button>
      ) : undefined}
    >
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-6">
        <p className="text-sm text-muted-foreground">
          {data?.connection?.googleEmail ? <>Accounts {data.connection.googleEmail} can read. </> : null}
          Choose the accounts this workspace reports on. Manager accounts are expanded one level into their client
          accounts.
        </p>
        {search.discovery === "failed" && data?.connection?.accountsDiscoveredAt ? (
          <Alert variant="warning">
            <TriangleAlert aria-hidden />
            <AlertTitle>The account list may be out of date</AlertTitle>
            <AlertDescription>Google did not return the latest list. Reload it to see recent changes.</AlertDescription>
          </Alert>
        ) : null}
        {mutationError ? (
          <ErrorState
            variant="inline"
            message={mutationError instanceof SourcesError ? mutationError.message : "The request did not complete. Try again."}
          />
        ) : null}
        {body}
        {others.length ? (
          <details className="group rounded-xl border border-border bg-card text-sm">
            <summary className="cursor-pointer px-4 py-3 font-medium text-muted-foreground select-none">
              {others.length} account{others.length === 1 ? "" : "s"} not available for reporting
            </summary>
            <ul className="divide-y divide-border border-t border-border">
              {others.map((account) => (
                <li
                  key={account.customerId}
                  className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                >
                  <span className="min-w-0 sm:flex-1">
                    <span className="block truncate">{account.name ?? "Unnamed account"}</span>
                    <span className="block text-xs text-muted-foreground tabular-nums">
                      {formatCustomerId(account.customerId)}
                      {account.stale ? " · Not confirmed on the last refresh" : null}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground sm:max-w-[55%] sm:text-right">{unavailableReason(account)}</span>
                  {removeAction(account)}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </AppShell>
  );
}
