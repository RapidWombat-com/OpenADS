import { Fragment, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronRight,
  Columns3,
  Download,
  ExternalLink,
  MoreHorizontal,
  Search,
} from "lucide-react";
import { cn } from "cn";
import { EmptyState } from "@/client/components/EmptyState";
import { MetricHelpButton } from "@/client/components/MetricHelp";
import { PlatformMark } from "@/client/components/PlatformMark";
import { StatusDot } from "@/client/components/StatusDot";
import { Button, buttonVariants } from "@/client/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/client/components/ui/dropdown-menu";
import { Input } from "@/client/components/ui/input";
import { Skeleton } from "@/client/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCard,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/client/components/ui/tooltip";
import {
  campaignsCsv,
  columnLabel,
  COLUMNS,
  DEFAULT_COLUMNS,
  formatCell,
  loadColumns,
  saveColumns,
  type Column,
  type ColumnKey,
} from "@/client/lib/columns";
import { downloadCsv, toCsv } from "@/client/lib/csv";
import { campaignLink } from "@/client/lib/deepLinks";
import { formatInteger } from "@/client/lib/format";
import {
  filterCampaigns,
  sortCampaigns,
  type Campaign,
  type SortDirection,
  type SortKey,
} from "@/client/lib/report";
import { CampaignDetailPanel } from "./CampaignDetailPanel";

export type CampaignTableState =
  | { kind: "loading" }
  | { kind: "rows"; rows: Campaign[] }
  /** Nothing to list; the caller explains why. */
  | { kind: "message"; message: ReactNode };

/** The row key used in `expanded=<platform:campaignId>`. */
export const rowKey = (row: Pick<Campaign, "platform" | "id">) => `${row.platform}:${row.id}`;

const SKELETON_ROWS = 6;

/** Interactive elements inside a row handle their own clicks; the rest of the row toggles details. */
function fromControl(event: MouseEvent) {
  return (event.target as HTMLElement).closest("a, button, input, [role=menuitem], [data-no-toggle]") !== null;
}

export function CampaignTable({
  state,
  expanded,
  onExpandedChange,
  detailScope,
}: {
  state: CampaignTableState;
  /** `platform:campaignId` of the open row, if any. */
  expanded?: string;
  onExpandedChange: (key: string | undefined) => void;
  /** The report's window and project, sent with the detail request. */
  detailScope: { start: string; end: string; project?: string };
}) {
  const [text, setText] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({ key: "spend", direction: "desc" });
  // Defaults on the server and first render; the stored choice after mount (no hydration mismatch).
  const [visibleKeys, setVisibleKeys] = useState<ColumnKey[]>(DEFAULT_COLUMNS);
  useEffect(() => setVisibleKeys(loadColumns()), []);
  const columns = useMemo(() => COLUMNS.filter((column) => visibleKeys.includes(column.key)), [visibleKeys]);
  const rows = state.kind === "rows" ? state.rows : null;
  // With several connected accounts, each row names the account it came from.
  const multiAccount = useMemo(
    () => new Set((rows ?? []).filter((row) => row.accountId).map((row) => row.accountId)).size > 1,
    [rows],
  );
  const visible = useMemo(
    () => (rows ? sortCampaigns(filterCampaigns(rows, text), sort.key, sort.direction) : []),
    [rows, text, sort],
  );
  const span = columns.length + 3;

  function toggleSort(key: SortKey) {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: key === "name" || key === "status" ? "asc" : "desc" },
    );
  }

  function toggleColumn(key: ColumnKey, on: boolean) {
    const next = COLUMNS.filter((column) => (column.key === key ? on : visibleKeys.includes(column.key))).map((column) => column.key);
    setVisibleKeys(next);
    saveColumns(next);
    if (!on && sort.key === key) setSort({ key: "spend", direction: "desc" });
  }

  function exportCsv() {
    const csv = campaignsCsv(visible, visibleKeys);
    downloadCsv(`openads-campaigns-${detailScope.start}_${detailScope.end}.csv`, toCsv(csv.header, csv.rows));
  }

  const count = rows
    ? text.trim()
      ? `${formatInteger(visible.length)} of ${formatInteger(rows.length)}`
      : formatInteger(rows.length)
    : null;

  return (
    <TableCard>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="flex items-baseline gap-2 text-sm font-semibold">
          Campaigns
          {count !== null ? <span className="text-xs font-normal text-muted-foreground tabular-nums">{count}</span> : null}
        </h2>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <div className="relative min-w-0 basis-full sm:w-64 sm:basis-auto">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              aria-label="Search campaigns"
              placeholder="Search campaigns"
              value={text}
              onChange={(event) => setText(event.target.value)}
              disabled={!rows || rows.length === 0}
              className="h-8 pl-8"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="h-8" />}>
              <Columns3 aria-hidden />
              Columns
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Show columns</DropdownMenuLabel>
                {COLUMNS.map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.key}
                    checked={visibleKeys.includes(column.key)}
                    onCheckedChange={(checked) => toggleColumn(column.key, checked)}
                    closeOnClick={false}
                  >
                    {columnLabel(column)}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={visibleKeys.join() === DEFAULT_COLUMNS.join()}
                onClick={() => {
                  setVisibleKeys(DEFAULT_COLUMNS);
                  saveColumns(DEFAULT_COLUMNS);
                }}
              >
                Reset to default
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" size="sm" className="h-8" disabled={visible.length === 0} onClick={exportCsv}>
            <Download aria-hidden />
            Export CSV
          </Button>
        </div>
      </div>

      {state.kind === "message" ? (
        <div className="p-4">{state.message}</div>
      ) : rows && rows.length > 0 && visible.length === 0 ? (
        <div className="p-4">
          <EmptyState
            kind="filtered"
            variant="plain"
            size="sm"
            title="No campaigns match this search"
            description={`Nothing in this date range is named like “${text.trim()}”.`}
            action={<Button variant="outline" size="sm" onClick={() => setText("")}>Clear search</Button>}
          />
        </div>
      ) : (
        // The scroll container is a size container, so an open row's details stay in view (100cqw) while the table scrolls sideways.
        <Table containerClassName="@container" aria-busy={state.kind === "loading" || undefined}>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8 pr-0"><span className="sr-only">Details</span></TableHead>
              <SortHead label="Campaign" sortKey="name" sort={sort} onSort={toggleSort} disabled={!rows?.length} className="pl-1" />
              {columns.map((column) => (
                <SortHead key={column.key} column={column} sortKey={column.key} sort={sort} onSort={toggleSort} disabled={!rows?.length} className="px-2" />
              ))}
              <TableHead className="hidden w-12 md:table-cell"><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.kind === "loading"
              ? Array.from({ length: SKELETON_ROWS }, (_, index) => (
                  <TableRow key={index} className="hover:bg-transparent">
                    <TableCell className="pr-0"><Skeleton className="size-4" /></TableCell>
                    <TableCell className="pl-1">
                      <div className="flex min-w-44 items-center gap-2 sm:min-w-52">
                        <Skeleton className="size-5" />
                        <Skeleton className="h-4 w-32" />
                      </div>
                    </TableCell>
                    {columns.map((column) => (
                      <TableCell key={column.key} className={cn("px-2", column.numeric && "text-right")}>
                        <Skeleton className={cn("h-4 w-14", column.numeric && "ml-auto")} />
                      </TableCell>
                    ))}
                    <TableCell className="hidden md:table-cell" />
                  </TableRow>
                ))
              : visible.map((row) => {
                  const key = rowKey(row);
                  const open = expanded === key;
                  const panelId = `campaign-detail-${row.platform}-${row.id}`;
                  const canExpand = Boolean(row.connectedAccountId);
                  const toggle = () => onExpandedChange(open ? undefined : key);
                  return (
                    <Fragment key={`${row.platform}:${row.accountId ?? ""}:${row.id}`}>
                      <TableRow
                        data-state={open ? "selected" : undefined}
                        className={cn("group/row", canExpand && "cursor-pointer", open && "border-b-0")}
                        onClick={(event) => {
                          if (canExpand && !fromControl(event)) toggle();
                        }}
                      >
                        <TableCell className="pr-0">
                          {canExpand ? (
                            <button
                              type="button"
                              aria-expanded={open}
                              aria-controls={open ? panelId : undefined}
                              aria-label={`${open ? "Hide" : "Show"} details for ${row.name}`}
                              onClick={toggle}
                              className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                            >
                              <ChevronRight aria-hidden className={cn("size-4 transition-transform", open && "rotate-90")} />
                            </button>
                          ) : null}
                        </TableCell>
                        <TableCell className="pl-1">
                          <div className="flex min-w-44 max-w-md items-center gap-2 sm:min-w-52">
                            <PlatformMark platform={row.platform} />
                            <span className="min-w-0 flex-1">
                              <span className="line-clamp-2 font-medium break-words" title={row.name}>{row.name}</span>
                              {multiAccount && row.accountId ? (
                                <span className="block truncate text-xs text-muted-foreground">{row.accountName ?? row.accountId}</span>
                              ) : null}
                            </span>
                            <RowMenu row={row} open={open} canExpand={canExpand} onToggle={toggle} />
                          </div>
                        </TableCell>
                        {columns.map((column) => (
                          <TableCell key={column.key} className={cn("px-2 tabular-nums", column.numeric && "text-right whitespace-nowrap")}>
                            {column.kind === "status" ? <StatusDot status={row.status} /> : formatCell(row, column)}
                          </TableCell>
                        ))}
                        <TableCell className="hidden text-right md:table-cell">
                          <OpenAction row={row} open={open} />
                        </TableCell>
                      </TableRow>
                      {open && canExpand ? (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={span} className="p-0 first:pl-0 last:pr-0" id={panelId}>
                            <div className="sticky left-0 w-[100cqw]">
                              <CampaignDetailPanel
                              row={row}
                              query={{
                                platform: row.platform, campaignId: row.id, account: row.connectedAccountId!,
                                  start: detailScope.start, end: detailScope.end, project: detailScope.project,
                                }}
                              />
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                })}
          </TableBody>
        </Table>
      )}
    </TableCard>
  );
}

function SortHead({
  label,
  column,
  sortKey,
  sort,
  onSort,
  disabled,
  className,
}: {
  label?: string;
  column?: Column;
  sortKey: SortKey;
  sort: { key: SortKey; direction: SortDirection };
  onSort: (key: SortKey) => void;
  disabled: boolean;
  className?: string;
}) {
  const active = sort.key === sortKey;
  const Icon = !active ? ArrowUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown;
  const numeric = column?.numeric ?? false;
  return (
    <TableHead
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}
      className={cn(numeric && "text-right", className)}
    >
      <span className={cn("inline-flex items-center gap-1", numeric && "flex-row-reverse")}>
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          disabled={disabled}
          className={cn(
            "inline-flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none",
            active && "text-foreground",
          )}
        >
          {column ? columnLabel(column) : label}
          <Icon aria-hidden className={cn("size-3", !active && "opacity-40")} />
        </button>
        {column ? <MetricHelpButton metric={column.metric} /> : null}
      </span>
    </TableHead>
  );
}

/** "Open in …" from md up: an icon shown on row hover or keyboard focus (always on the open row). */
function OpenAction({ row, open }: { row: Campaign; open: boolean }) {
  const link = campaignLink(row);
  if (!link) return null;
  return (
    <Tooltip>
      {/* A real link (not role=button), styled as an icon button. */}
      <TooltipTrigger
        render={<a href={link.href} target="_blank" rel="noopener noreferrer" aria-label={`${link.label}: ${row.name}`} />}
        className={cn(
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100",
          open && "opacity-100",
        )}
      >
        <ExternalLink aria-hidden />
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-64">{link.hint}</TooltipContent>
    </Tooltip>
  );
}

/** Below md: the same actions in an overflow menu next to the campaign name (no horizontal scrolling to reach it). */
function RowMenu({ row, open, canExpand, onToggle }: { row: Campaign; open: boolean; canExpand: boolean; onToggle: () => void }) {
  const link = campaignLink(row);
  if (!link && !canExpand) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.name}`} className="-my-1 shrink-0 md:hidden" />}
      >
        <MoreHorizontal aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {link ? (
          <DropdownMenuLinkItem href={link.href} target="_blank" rel="noopener noreferrer">
            <ExternalLink aria-hidden />
            {link.label}
          </DropdownMenuLinkItem>
        ) : null}
        {canExpand ? (
          <DropdownMenuItem onClick={onToggle}>
            <ChevronRight aria-hidden className={cn(open && "rotate-90")} />
            {open ? "Hide details" : "Show details"}
          </DropdownMenuItem>
        ) : null}
        {link && link.label === "Open in Google Ads" ? (
          <p className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">Opens the account’s campaign list; find this campaign there.</p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
