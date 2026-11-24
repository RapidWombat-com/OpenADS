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
  fetchMetaAccounts,
  groupMetaAccounts,
  metaStatusNote,
  metaUnavailableReason,
  rediscoverMetaAccounts,
  removeStaleMetaAccount,
  saveMetaAccounts,
  type MetaAccount,
} from "@/client/lib/meta";
import { SourcesError } from "@/client/lib/sources";
import { Group } from "./AccountPickerPage";
import { RemoveStaleAccount } from "./RemoveStaleAccount";
import { useMetaConnect } from "./useMetaConnect";

const DEFAULT_MAX = 25;

function AccountRow({ account, checked, disabled, onToggle, action }: {
  account: MetaAccount; checked: boolean; disabled: boolean; onToggle: (checked: boolean) => void; action?: ReactNode;
}) {
  const note = metaStatusNote(account.status);
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
          <span className="block truncate font-medium">{account.name ?? "Unnamed ad account"}</span>
          <span className="block text-xs text-muted-foreground tabular-nums">
            {account.accountId}
            {note ? <span className="text-warning-foreground dark:text-warning"> · {note}</span> : null}
            {account.stale ? " · Not listed on the last refresh" : null}
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

export function MetaAccountPickerPage() {
  const search = useSearch({ from: "/sources/meta/accounts" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accounts = useQuery({ queryKey: ["metaAccounts"], queryFn: fetchMetaAccounts });
  const data = accounts.data;
  const admin = data?.role === "admin";
  const max = data?.maxSelected ?? DEFAULT_MAX;
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const connect = useMetaConnect();

  useEffect(() => {
    if (data && selected === null) {
      setSelected(new Set(data.accounts.filter((account) => account.selected).map((account) => account.accountId)));
    }
  }, [data, selected]);

  const groups = useMemo(() => groupMetaAccounts(data?.accounts ?? [], text), [data, text]);
  const eligible = (data?.accounts ?? []).filter((account) => account.eligible);
  const chosen = selected ?? new Set<string>();

  const save = useMutation({
    mutationFn: () => saveMetaAccounts([...chosen]),
    onSuccess: async (next) => {
      queryClient.setQueryData(["metaAccounts"], next);
      queryClient.removeQueries({ queryKey: ["campaigns"] });
      await queryClient.invalidateQueries({ queryKey: ["sources"] });
      void navigate({ to: "/" });
      toast.success(selectionMessage("Meta Ads", chosen.size));
    },
    onError: (error) => toast.error(safeMessage(error, "The account selection was not saved. Try again.")),
  });
  const rediscover = useMutation({
    mutationFn: rediscoverMetaAccounts,
    onSuccess: (next) => {
      queryClient.setQueryData(["metaAccounts"], next);
      setSelected(null);
      void queryClient.invalidateQueries({ queryKey: ["sources"] });
      void navigate({ to: "/sources/meta/accounts", search: {}, replace: true });
    },
    onError: (error) => {
      toast.error(safeMessage(error, "Ad accounts could not be loaded. Try again."));
      if (error instanceof SourcesError && error.reconnect) void queryClient.invalidateQueries({ queryKey: ["metaAccounts"] });
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
  // Rediscovery keeps a selected or project-assigned ad account it no longer lists (stale); only an admin removes it.
  const removeAction = (account: MetaAccount) => admin && account.stale ? (
    <RemoveStaleAccount
      name={account.name ?? account.accountId}
      disabled={busy}
      remove={() => removeStaleMetaAccount(account.accountId)}
      onRemoved={(next) => {
        queryClient.setQueryData(["metaAccounts"], next);
        setSelected((current) => new Set([...(current ?? [])].filter((id) => id !== account.accountId)));
        queryClient.removeQueries({ queryKey: ["campaigns"] });
        void queryClient.invalidateQueries({ queryKey: ["sources"] });
        void queryClient.invalidateQueries({ queryKey: ["projects"] });
      }}
    />
  ) : null;
  const reconnectButton = (label: string) => (
    <Button pending={connect.isPending || connect.isSuccess} onClick={() => connect.mutate()}>
      {connect.isPending || connect.isSuccess ? null : <ExternalLink aria-hidden />}
      {connect.isPending || connect.isSuccess ? "Opening Facebook…" : label}
    </Button>
  );

  let body: ReactNode;
  if (accounts.isPending) {
    body = (
      <div role="status" aria-label="Loading ad accounts" className="space-y-2 rounded-xl border border-border bg-card p-4">
        {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-10 w-full" />)}
      </div>
    );
  } else if (accounts.isError || !data) {
    body = (
      <ErrorState
        variant="page"
        title="Ad accounts not loaded"
        message={accounts.error instanceof SourcesError ? accounts.error.message : "The ad account list could not be loaded."}
        onRetry={() => void accounts.refetch()}
        isRetrying={accounts.isFetching}
      />
    );
  } else if (!data.connection) {
    body = (
      <EmptyState
        variant="card"
        title="Meta Ads is not connected"
        description="Connect a Facebook account on the Sources page first."
        action={<Button nativeButton={false} render={<Link to="/sources" />}>Go to Sources</Button>}
      />
    );
  } else if (data.connection.status !== "active") {
    body = (
      <EmptyState
        kind="error"
        variant="card"
        title="Meta Ads access expired"
        description={`Meta no longer accepts OpenADS's access for ${data.connection.name ?? "this Facebook account"}. ${admin ? "Reconnect to load ad accounts again." : "Ask a workspace admin to reconnect it."}`}
        action={admin ? reconnectButton("Reconnect Meta Ads") : undefined}
      />
    );
  } else if (data.connection.accountsDiscoveredAt === null) {
    body = (
      <ErrorState
        variant="page"
        title="Ad accounts not loaded from Meta"
        message="Meta did not return the list of ad accounts for this connection. Try again in a moment."
        action={admin ? (
          <Button variant="outline" pending={rediscover.isPending} onClick={() => rediscover.mutate()}>Try again</Button>
        ) : undefined}
      />
    );
  } else if (eligible.length === 0) {
    body = (
      <EmptyState
        variant="card"
        icon={Building2}
        title="No ad accounts to report on"
        description={`${data.connection.name ?? "This Facebook account"} has no open Meta ad account OpenADS can read${data.accounts.length ? " (see below)" : ""}. If your ad accounts belong to a business portfolio, ask its admin to add you in Meta Business Suite → Settings → Users → People → Assign assets → Ad accounts (View performance is enough), then reload the list. Or connect with the Facebook account that runs the ads.`}
        action={admin ? (
          <div className="flex flex-wrap justify-center gap-2">
            {reconnectButton("Use another Facebook account")}
            <Button variant="outline" pending={rediscover.isPending} onClick={() => rediscover.mutate()}>Reload list</Button>
          </div>
        ) : undefined}
      />
    );
  } else {
    const limitReached = chosen.size >= max;
    const row = (account: MetaAccount) => (
      <AccountRow
        key={account.accountId}
        account={account}
        checked={chosen.has(account.accountId)}
        disabled={!admin || busy || (limitReached && !chosen.has(account.accountId))}
        onToggle={(value) => toggle(account.accountId, value)}
        action={removeAction(account)}
      />
    );
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
              aria-label="Search ad accounts"
              placeholder="Search by name, ID or business"
              value={text}
              onChange={(event) => setText(event.target.value)}
              className="h-8 pl-8"
            />
          </div>
        </div>
        {groups.groups.length === 0 ? (
          <div className="p-4">
            <EmptyState
              kind="filtered"
              variant="plain"
              size="sm"
              title="No ad accounts match this search"
              action={<Button variant="outline" size="sm" onClick={() => setText("")}>Clear search</Button>}
            />
          </div>
        ) : (
          <div>
            {groups.groups.map((group) => (
              <Group
                key={group.businessId ?? "personal"}
                title={group.businessId ? `Business: ${group.businessName ?? "business portfolio"}` : "Your ad accounts"}
                detail={group.businessId ?? undefined}
              >
                {group.accounts.map(row)}
              </Group>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/50 px-4 py-3">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {chosen.size === 0 ? "Select at least one ad account" : `${chosen.size} selected`}
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
      title="Meta ad accounts"
      actions={admin && data?.connection?.status === "active" ? (
        <Button variant="outline" size="sm" pending={rediscover.isPending} disabled={busy} onClick={() => rediscover.mutate()}>
          {rediscover.isPending ? null : <RefreshCw aria-hidden />}
          Reload list
        </Button>
      ) : undefined}
    >
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-6">
        <p className="text-sm text-muted-foreground">
          {data?.connection?.name ? <>Ad accounts {data.connection.name} can read. </> : null}
          Choose the ad accounts this workspace reports on, including those you reach through a business portfolio.
        </p>
        {search.discovery === "failed" && data?.connection?.accountsDiscoveredAt ? (
          <Alert variant="warning">
            <TriangleAlert aria-hidden />
            <AlertTitle>The ad account list may be out of date</AlertTitle>
            <AlertDescription>Meta did not return the latest list. Reload it to see recent changes.</AlertDescription>
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
              {others.length} ad account{others.length === 1 ? "" : "s"} not available for reporting
            </summary>
            <ul className="divide-y divide-border border-t border-border">
              {others.map((account) => (
                <li
                  key={account.accountId}
                  className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                >
                  <span className="min-w-0 sm:flex-1">
                    <span className="block truncate">{account.name ?? "Unnamed ad account"}</span>
                    <span className="block text-xs text-muted-foreground tabular-nums">
                      {account.accountId}{account.businessName ? ` · ${account.businessName}` : ""}
                      {account.stale ? " · Not listed on the last refresh" : null}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground sm:max-w-[55%] sm:text-right">{metaUnavailableReason(account)}</span>
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
