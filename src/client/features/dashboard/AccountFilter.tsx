import { useMemo, useState } from "react";
import { ChevronDown, WalletCards, X } from "lucide-react";
import { cn } from "cn";
import { PlatformMark } from "@/client/components/PlatformMark";
import { Button } from "@/client/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/client/components/ui/combobox";
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { Separator } from "@/client/components/ui/separator";
import { accountLabel, type ProjectAccount } from "@/client/lib/projects";
import { formatCustomerId } from "@/client/lib/sources";

const SEARCH_THRESHOLD = 8;

const matches = (account: ProjectAccount, query: string) => {
  const needle = query.trim().toLocaleLowerCase("en").replaceAll("-", "");
  return !needle || accountLabel(account).toLocaleLowerCase("en").includes(needle) || account.customerId.includes(needle);
};

/**
 * A multi-select of the accounts in the current scope (project × platform).
 * Nothing selected means every account in the scope.
 */
export function AccountFilter({
  accounts,
  selected,
  onChange,
}: {
  accounts: ProjectAccount[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => accounts.filter((account) => selected.includes(account.id)), [accounts, selected]);
  const searchable = accounts.length > SEARCH_THRESHOLD;
  const label = value.length === 0
    ? "All accounts"
    : value.length === 1
      ? accountLabel(value[0]!)
      : `${value.length} of ${accounts.length} accounts`;

  return (
    <div className="flex items-center">
      <Combobox
        multiple
        items={accounts}
        value={value}
        itemToStringLabel={(account: ProjectAccount) => accountLabel(account)}
        isItemEqualToValue={(item: ProjectAccount, other: ProjectAccount) => item.id === other.id}
        filter={searchable ? matches : null}
        open={open}
        onOpenChange={setOpen}
        onValueChange={(next: ProjectAccount[]) => {
          const ids = new Set(next.map((account) => account.id));
          // In list order, so the URL does not depend on the click order.
          onChange(accounts.filter((account) => ids.has(account.id)).map((account) => account.id));
        }}
      >
        <ComboboxPrimitive.Trigger
          aria-label={`Ad accounts: ${label}`}
          data-testid="account-filter"
          className={cn(
            "inline-flex h-[28px] max-w-64 min-w-0 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[0.8rem] font-medium outline-none hover:bg-foreground/5 focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-foreground/5",
            value.length > 0 && "rounded-r-none border-primary/40 bg-primary/10 text-primary hover:bg-primary/15",
          )}
        >
          {value.length === 1 ? (
            <PlatformMark platform={value[0]!.platform} decorative className="size-4 text-[9px]" />
          ) : (
            <WalletCards aria-hidden className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{label}</span>
          <ChevronDown aria-hidden className="size-3.5 shrink-0 opacity-60" />
        </ComboboxPrimitive.Trigger>
        <ComboboxContent align="end" className="w-80 min-w-0">
          {searchable ? (
            <ComboboxInput className="w-auto" placeholder="Find account…" aria-label="Filter ad accounts" showTrigger={false} />
          ) : null}
          <ComboboxEmpty>No accounts match.</ComboboxEmpty>
          <ComboboxList className="max-h-[min(60vh,21rem)]">
            {(account: ProjectAccount) => (
              <ComboboxItem key={account.id} value={account}>
                <PlatformMark platform={account.platform} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{accountLabel(account)}</span>
                  <span className="truncate text-xs text-muted-foreground tabular-nums">
                    {account.platform === "google" ? formatCustomerId(account.customerId) : `act_${account.customerId}`}
                    {account.currency ? ` · ${account.currency}` : ""}
                  </span>
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
          <Separator />
          <div className="flex items-center justify-between gap-2 p-1 pl-3">
            <span className="text-xs text-muted-foreground">
              {value.length ? `${value.length} selected` : "Showing every account"}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={value.length === 0}
              onClick={() => {
                onChange([]);
                setOpen(false);
              }}
            >
              Show all
            </Button>
          </div>
        </ComboboxContent>
      </Combobox>
      {value.length > 0 ? (
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Clear account filter"
          title="Clear account filter"
          onClick={() => onChange([])}
          className="h-[28px] rounded-l-none border-l-0 border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 dark:border-primary/40 dark:bg-primary/10"
        >
          <X aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}
