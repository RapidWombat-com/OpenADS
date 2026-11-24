// Follows OpenSEO's ProjectSwitcher (MIT, © Ben Senescu): a combobox in the
// sidebar header, searchable from 8 entries, with project actions underneath.
// OpenADS projects scope the dashboard, so choosing one opens the dashboard
// with `?project=` (keeping its other filters) and remembers the choice.
import { useState } from "react";
import { Link, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { FolderCog, FolderOpen, Layers, Plus } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/client/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/client/components/ui/combobox";
import { Separator } from "@/client/components/ui/separator";
import { Skeleton } from "@/client/components/ui/skeleton";
import { formatInteger } from "@/client/lib/format";
import {
  accountsInScope,
  setLastProject,
  UNASSIGNED,
  type ProjectsSummary,
} from "@/client/lib/projects";
import { ProjectNameDialog } from "./ProjectNameDialog";
import { useLastProject, useProjects } from "./queries";

const SEARCH_THRESHOLD = 8;
const ALL = "all";

interface ScopeItem {
  /** `all`, `unassigned` or a project id. */
  value: string;
  label: string;
  accounts: number;
}

const accountCount = (count: number) => `${formatInteger(count)} ad account${count === 1 ? "" : "s"}`;

function scopeItems(summary: ProjectsSummary, active: string | undefined): ScopeItem[] {
  const unassigned = accountsInScope(summary, UNASSIGNED).length;
  return [
    { value: ALL, label: "All projects", accounts: summary.accounts.length },
    ...summary.projects.map((project) => ({ value: project.id, label: project.name, accounts: project.accountIds.length })),
    // Only when it holds something (or is open), so a tidy workspace has no empty bucket.
    ...(unassigned > 0 || active === UNASSIGNED
      ? [{ value: UNASSIGNED, label: "Unassigned", accounts: unassigned }]
      : []),
  ];
}

export function ProjectSwitcher({ onCloseDrawer }: { onCloseDrawer?: () => void }) {
  const projects = useProjects();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const search = useSearch({ strict: false }) as { project?: string };
  const remembered = useLastProject();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const onDashboard = pathname === "/";
  // On the dashboard the URL is the truth; elsewhere, the remembered choice.
  const active = onDashboard ? search.project : remembered && remembered !== ALL ? remembered : undefined;

  if (projects.isPending) {
    return (
      <div className="flex h-12 flex-col justify-center gap-1.5 rounded-lg border border-sidebar-border bg-card px-3" aria-busy>
        <Skeleton className="h-3.5 w-28" />
        <Skeleton className="h-3 w-20" />
      </div>
    );
  }
  const summary = projects.data;
  // Not set up yet (or not loaded): nothing to switch between.
  if (!summary?.role) return null;
  const admin = summary.role === "admin";
  const items = scopeItems(summary, active);
  const current = items.find((item) => item.value === (active ?? ALL)) ?? items[0]!;
  const searchable = items.length >= SEARCH_THRESHOLD;

  function choose(item: ScopeItem) {
    setOpen(false);
    onCloseDrawer?.();
    const project = item.value === ALL ? undefined : item.value;
    setLastProject(project);
    if (onDashboard && project === active) return;
    void navigate({
      to: "/",
      // The account filter belongs to the previous scope.
      search: (previous) => ({ ...(onDashboard ? previous : {}), project, accounts: undefined }),
    });
  }

  function close() {
    setOpen(false);
    onCloseDrawer?.();
  }

  return (
    <>
      <Combobox
        items={items}
        value={current}
        itemToStringLabel={(item: ScopeItem) => item.label}
        isItemEqualToValue={(item: ScopeItem, value: ScopeItem) => item.value === value.value}
        filter={searchable ? (item: ScopeItem, query: string) => item.label.toLowerCase().includes(query.trim().toLowerCase()) : null}
        autoHighlight
        open={open}
        onOpenChange={setOpen}
        onValueChange={(item: ScopeItem | null) => {
          if (item) choose(item);
        }}
      >
        <ComboboxTrigger
          aria-label={`Project: ${current.label}. Switch project`}
          className="flex w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-sidebar-border bg-card px-3 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <span
              aria-hidden
              className={cn(
                "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold",
                current.value === ALL || current.value === UNASSIGNED
                  ? "bg-muted text-muted-foreground"
                  : "bg-primary/12 text-primary",
              )}
            >
              {current.value === ALL ? <Layers className="size-3.5" /> : current.value === UNASSIGNED ? <FolderOpen className="size-3.5" /> : initials(current.label)}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium" data-testid="project-switcher-label">{current.label}</span>
              <span className="truncate text-xs text-muted-foreground">{accountCount(current.accounts)}</span>
            </span>
          </span>
        </ComboboxTrigger>
        <ComboboxContent className="w-(--anchor-width) min-w-64">
          {searchable ? (
            <ComboboxInput className="w-auto" placeholder="Find project…" aria-label="Filter projects" showTrigger={false} />
          ) : null}
          <ComboboxEmpty>No projects match.</ComboboxEmpty>
          <ComboboxList className="max-h-[min(60vh,21rem)]">
            {(item: ScopeItem) => (
              <ComboboxItem key={item.value} value={item}>
                <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                  <span className={cn("truncate", item.value === UNASSIGNED && "text-muted-foreground")}>{item.label}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatInteger(item.accounts)}</span>
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
          {summary.projects.length === 0 ? (
            <p className="px-3 pb-2 text-xs text-muted-foreground">
              No projects yet. Group ad accounts by brand or client to report on them together.
            </p>
          ) : null}
          <Separator />
          <div className="grid gap-0.5 p-1">
            {admin ? (
              <Button
                variant="ghost"
                className="h-8 justify-start"
                onClick={() => {
                  setOpen(false);
                  setCreating(true);
                }}
              >
                <Plus className="size-4" />
                {summary.projects.length === 0 ? "Create project" : "New project"}
              </Button>
            ) : null}
            <Button
              nativeButton={false}
              render={<Link to="/projects" onClick={close} />}
              variant="ghost"
              className="h-8 justify-start"
            >
              <FolderCog className="size-4" />
              {admin ? "Manage projects" : "View projects"}
            </Button>
          </div>
        </ComboboxContent>
      </Combobox>
      <ProjectNameDialog
        open={creating}
        onOpenChange={setCreating}
        onSaved={(project) => {
          onCloseDrawer?.();
          setLastProject(project.id);
          void navigate({ to: "/", search: (previous) => ({ ...(onDashboard ? previous : {}), project: project.id, accounts: undefined }) });
        }}
      />
    </>
  );
}

/** Up to two letters for the project's tile: "AdWorks" → "AW", "north wind" → "NW". */
export function initials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const capitals = (words[0] ?? "").match(/\p{Lu}/gu) ?? [];
  const letters = words.length > 1
    ? [words[0]![0], words[1]![0]]
    : capitals.length > 1 ? capitals.slice(0, 2) : [(words[0] ?? "?")[0]];
  return letters.join("").toUpperCase();
}
