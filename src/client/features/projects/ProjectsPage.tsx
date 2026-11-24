// /projects: create, rename and delete projects and assign ad accounts to them
// (workspace admins); members see the same page read-only. "Suggest projects"
// proposes groups from matching account names as a preview that nothing
// applies until the admin accepts it.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Info, Pencil, Plug, Plus, Sparkles, Trash2, X } from "lucide-react";
import { cn } from "cn";
import { EmptyState } from "@/client/components/EmptyState";
import { ErrorState } from "@/client/components/ErrorState";
import { SaveStatus, type SaveState } from "@/client/components/SaveStatus";
import { PlatformMark } from "@/client/components/PlatformMark";
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
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { Checkbox } from "@/client/components/ui/checkbox";
import { Input } from "@/client/components/ui/input";
import { Skeleton } from "@/client/components/ui/skeleton";
import { AppShell } from "@/client/layout/AppShell";
import { applyMessage, assignMessage, deletedMessage, safeMessage } from "@/client/lib/feedback";
import { formatInteger } from "@/client/lib/format";
import {
  accountLabel,
  applyProjectGroups,
  assignAccounts,
  cleanProjectName,
  deleteProject,
  MAX_PROJECT_NAME,
  moveAccount,
  setLastProject,
  suggestProjects,
  type Project,
  type ProjectAccount,
  type ProjectsSummary,
  type ProjectSuggestion,
} from "@/client/lib/projects";
import { PLATFORM_LABEL, type Platform } from "@/client/lib/report";
import { formatCustomerId, SourcesError } from "@/client/lib/sources";
import { ProjectNameDialog } from "./ProjectNameDialog";
import { initials } from "./ProjectSwitcher";
import { PROJECTS_KEY, useProjects, useProjectsUpdated } from "./queries";

type AppliedGroup = { name: string; accountIds: string[]; existing: boolean };
const PLATFORMS: Platform[] = ["google", "meta"];
const accountsText = (count: number) => `${formatInteger(count)} ad account${count === 1 ? "" : "s"}`;
const errorText = (error: unknown, fallback: string) => (error instanceof SourcesError ? error.message : fallback);

export function ProjectsPage() {
  const projects = useProjects();
  const summary = projects.data;
  const admin = summary?.role === "admin";
  const [creating, setCreating] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const hasProjects = Boolean(summary?.projects.length);
  const hasAccounts = Boolean(summary?.accounts.length);

  return (
    <AppShell
      title="Projects"
      actions={
        admin ? (
          <>
            {hasAccounts ? (
              <Button variant="outline" size="sm" onClick={() => setSuggesting(true)} disabled={suggesting} aria-label="Suggest projects">
                <Sparkles aria-hidden />
                <span className="hidden sm:inline">Suggest projects</span>
              </Button>
            ) : null}
            {/* The one create action, and the one green one unless the suggestions carry it. */}
            <Button size="sm" variant={suggesting ? "outline" : "default"} onClick={() => setCreating(true)} aria-label="New project">
              <Plus aria-hidden />
              <span className="hidden sm:inline">New project</span>
            </Button>
          </>
        ) : null
      }
    >
      <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6">
        <p className="max-w-2xl text-sm text-muted-foreground">
          A project groups the Google Ads and Meta Ads accounts of one brand or client. Pick a project in the sidebar
          and the overview reports on its accounts only. Each ad account belongs to at most one project.
        </p>

        {projects.isError ? (
          <ErrorState
            title="Projects not loaded"
            message={errorText(projects.error, "Projects could not be loaded. Try again in a moment.")}
            onRetry={() => void projects.refetch()}
            isRetrying={projects.isFetching}
          />
        ) : projects.isPending ? (
          <PageSkeleton />
        ) : !summary?.role ? (
          <Alert variant="info">
            <Info aria-hidden />
            <AlertTitle>This workspace is not set up yet</AlertTitle>
            <AlertDescription>
              A workspace admin creates it on their first visit. Reload this page after an admin has signed in.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {!admin ? (
              <Alert variant="info">
                <Info aria-hidden />
                <AlertTitle>You can view projects</AlertTitle>
                <AlertDescription>Only workspace admins can create projects or assign ad accounts to them.</AlertDescription>
              </Alert>
            ) : null}
            {suggesting && admin ? <Suggestions summary={summary} onClose={() => setSuggesting(false)} /> : null}
            <ProjectList summary={summary} admin={admin} />
            <AccountAssignments summary={summary} admin={admin} />
          </>
        )}
      </div>
      <ProjectNameDialog open={creating} onOpenChange={setCreating} />
    </AppShell>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-3" aria-busy>
      <Skeleton className="h-5 w-32" />
      <div className="divide-y divide-border rounded-xl border border-border bg-card">
        {[0, 1, 2].map((index) => (
          <div key={index} className="flex items-center gap-3 p-4">
            <Skeleton className="size-9" />
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SectionHeader({ id, title, count, children }: { id: string; title: string; count?: number; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2">
      <h2 id={id} className="flex items-baseline gap-2 text-sm font-semibold">
        {title}
        {count !== undefined ? <span className="text-xs font-normal text-muted-foreground tabular-nums">{formatInteger(count)}</span> : null}
      </h2>
      {children}
    </div>
  );
}

function PlatformMarks({ accounts }: { accounts: ProjectAccount[] }) {
  const platforms = PLATFORMS.filter((platform) => accounts.some((account) => account.platform === platform));
  return (
    <span className="flex items-center gap-1">
      {platforms.map((platform) => <PlatformMark key={platform} platform={platform} className="size-4 text-[9px]" />)}
    </span>
  );
}

// ── Projects ───────────────────────────────────────────────────────────────

function ProjectList({
  summary,
  admin,
}: {
  summary: ProjectsSummary;
  admin: boolean;
}) {
  const [renaming, setRenaming] = useState<Project | null>(null);
  const [removing, setRemoving] = useState<Project | null>(null);
  const byId = useMemo(() => new Map(summary.accounts.map((account) => [account.id, account])), [summary.accounts]);

  return (
    <section aria-labelledby="projects-heading" className="space-y-3">
      <SectionHeader id="projects-heading" title="Projects" count={summary.projects.length} />
      {summary.projects.length === 0 ? (
        <EmptyState
          icon={Plus}
          title="No projects yet"
          description={admin
            ? "Use New project for each brand or client, then assign its ad accounts below, or let OpenADS suggest projects from the account names."
            : "A workspace admin creates projects and assigns ad accounts to them."}
        />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          {summary.projects.map((project) => {
            const accounts = project.accountIds.map((id) => byId.get(id)).filter((account) => account !== undefined);
            return (
              <li key={project.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                <span aria-hidden className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-sm font-semibold text-primary">
                  {initials(project.name)}
                </span>
                {/* Below ~22rem the actions wrap under the name instead of squeezing it. */}
                <span className="flex min-w-[min(100%,12rem)] flex-1 basis-48 flex-col">
                  <span className="truncate font-medium">{project.name}</span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {accounts.length ? <PlatformMarks accounts={accounts} /> : null}
                    <span className="truncate">
                      {accounts.length ? accounts.map((account) => accountLabel(account)).join(", ") : "No ad accounts yet"}
                    </span>
                  </span>
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  {admin ? (
                    <>
                      <Button variant="ghost" size="icon-sm" aria-label={`Rename ${project.name}`} title="Rename" onClick={() => setRenaming(project)}>
                        <Pencil aria-hidden />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Delete ${project.name}`} title="Delete" onClick={() => setRemoving(project)}
                        className="text-muted-foreground hover:text-destructive">
                        <Trash2 aria-hidden />
                      </Button>
                    </>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    nativeButton={false}
                    render={<Link to="/" search={{ project: project.id }} onClick={() => setLastProject(project.id)} />}
                  >
                    Open report
                    <ArrowRight aria-hidden />
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <ProjectNameDialog open={renaming !== null} onOpenChange={(open) => { if (!open) setRenaming(null); }} project={renaming ?? undefined} />
      <DeleteProjectDialog project={removing} onClose={() => setRemoving(null)} />
    </section>
  );
}

function DeleteProjectDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const updated = useProjectsUpdated();
  const remove = useMutation({
    mutationFn: ({ id }: { id: string; name: string }) => deleteProject(id),
    onSuccess: (summary, { name }) => {
      updated(summary);
      onClose();
      toast.success(deletedMessage(name));
    },
    onError: (error) => toast.error(safeMessage(error, "The project was not deleted. Try again.")),
  });
  const count = project?.accountIds.length ?? 0;
  return (
    <AlertDialog
      open={project !== null}
      onOpenChange={(open) => {
        if (!open && !remove.isPending) {
          remove.reset();
          onClose();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {project?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {count
              ? `Its ${accountsText(count)} become unassigned. The ad accounts, their connections and their reports stay as they are.`
              : "The project has no ad accounts. Nothing else changes."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {remove.isError ? (
          <p role="alert" className="text-sm text-destructive">{errorText(remove.error, "The project was not deleted. Try again.")}</p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" pending={remove.isPending} onClick={() => project && remove.mutate({ id: project.id, name: project.name })}>
            Delete project
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Account assignments ────────────────────────────────────────────────────

function AccountAssignments({ summary, admin }: { summary: ProjectsSummary; admin: boolean }) {
  const client = useQueryClient();
  const updated = useProjectsUpdated();
  const [rows, setRows] = useState<Record<string, SaveState>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => clearTimeout(timer));
  }, []);
  const setRow = (accountId: string, state: SaveState) => {
    clearTimeout(timers.current.get(accountId));
    setRows((current) => ({ ...current, [accountId]: state }));
    // The "Saved" check fades after about two seconds.
    if (state === "saved") timers.current.set(accountId, setTimeout(() => setRow(accountId, "idle"), 2000));
  };
  const assign = useMutation({
    mutationFn: ({ accountId, projectId }: { accountId: string; projectId: string | null; label: string; projectName: string | null; previous: string | null }) =>
      assignAccounts([{ accountId, projectId }]),
    // Optimistic: the select shows the new project while the request runs.
    onMutate: async ({ accountId, projectId }) => {
      await client.cancelQueries({ queryKey: PROJECTS_KEY });
      setRow(accountId, "saving");
      client.setQueryData<ProjectsSummary>(PROJECTS_KEY, (current) => current && moveAccount(current, accountId, projectId));
    },
    onSuccess: (next, { accountId, label, projectName }) => {
      updated(next);
      setRow(accountId, "saved");
      toast.success(assignMessage(label, projectName));
    },
    // Rollback touches only this account, so other rows in flight keep their state.
    onError: (error, { accountId, previous, label }) => {
      client.setQueryData<ProjectsSummary>(PROJECTS_KEY, (current) => current && moveAccount(current, accountId, previous));
      setRow(accountId, "idle");
      toast.error(`${label} was not moved. ${safeMessage(error, "Try again in a moment.")}`);
    },
  });
  const names = new Map(summary.projects.map((project) => [project.id, project.name]));

  return (
    <section aria-labelledby="accounts-heading" className="space-y-3">
      <SectionHeader id="accounts-heading" title="Ad accounts" count={summary.accounts.length}>
        <p className="text-xs text-muted-foreground">
          The accounts selected on <Link to="/sources" className="underline underline-offset-2 hover:text-foreground">Sources</Link>.
        </p>
      </SectionHeader>
      {summary.accounts.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="No ad accounts to group"
          description="Connect Google Ads or Meta Ads and select the accounts to report on; they appear here to assign."
          action={<Button variant="outline" nativeButton={false} render={<Link to="/sources" />}>Go to Sources</Button>}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {PLATFORMS.map((platform) => {
            const accounts = summary.accounts.filter((account) => account.platform === platform);
            if (!accounts.length) return null;
            return (
              <div key={platform} className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
                <h3 className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-semibold">
                  <PlatformMark platform={platform} decorative />
                  {PLATFORM_LABEL[platform]}
                  <span className="text-xs font-normal text-muted-foreground tabular-nums">{formatInteger(accounts.length)}</span>
                </h3>
                <ul className="divide-y divide-border">
                  {accounts.map((account) => {
                    const selectId = `assign-${account.id}`;
                    return (
                      <li key={account.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-2.5">
                        <span className="flex min-w-0 flex-col">
                          <label htmlFor={admin ? selectId : undefined} className="truncate text-sm font-medium">{accountLabel(account)}</label>
                          <span className="truncate text-xs text-muted-foreground tabular-nums">
                            {platform === "google" ? formatCustomerId(account.customerId) : `act_${account.customerId}`}
                            {account.currency ? ` · ${account.currency}` : ""}
                          </span>
                        </span>
                        {admin ? (
                          <span className="flex items-center gap-2">
                          <SaveStatus state={rows[account.id] ?? "idle"} />
                          <select
                            id={selectId}
                            data-slot="native-select"
                            value={account.projectId ?? ""}
                            disabled={rows[account.id] === "saving"}
                            aria-busy={rows[account.id] === "saving" || undefined}
                            onChange={(event) => {
                              const projectId = event.target.value || null;
                              assign.mutate({
                                accountId: account.id,
                                projectId,
                                label: accountLabel(account),
                                projectName: projectId ? names.get(projectId) ?? null : null,
                                previous: account.projectId,
                              });
                            }}
                            className={cn(
                              "h-9 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none md:h-8 md:text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60 sm:w-48 dark:bg-input/30",
                              !account.projectId && "text-muted-foreground",
                            )}
                          >
                            <option value="">Unassigned</option>
                            {summary.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                          </select>
                          </span>
                        ) : (
                          <Badge variant={account.projectId ? "secondary" : "outline"}>
                            {account.projectId ? names.get(account.projectId) : "Unassigned"}
                          </Badge>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── Suggestions ────────────────────────────────────────────────────────────

function Suggestions({ summary, onClose }: { summary: ProjectsSummary; onClose: () => void }) {
  const updated = useProjectsUpdated();
  // Computed once when opened: the preview does not shift while the admin edits it.
  const [suggestions] = useState(() => suggestProjects(summary.accounts, summary.projects));
  const [chosen, setChosen] = useState(() => new Set(suggestions.filter((item) => item.confident).map((item) => item.key)));
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries(suggestions.map((item) => [item.key, item.name])));
  const byId = useMemo(() => new Map(summary.accounts.map((account) => [account.id, account])), [summary.accounts]);
  const accepted = suggestions.filter((item) => chosen.has(item.key));
  const invalid = accepted.some((item) => !cleanProjectName(names[item.key] ?? "") || cleanProjectName(names[item.key] ?? "").length > MAX_PROJECT_NAME);
  const apply = useMutation({
    mutationFn: (groups: AppliedGroup[]) => applyProjectGroups(groups.map(({ name, accountIds }) => ({ name, accountIds }))),
    onSuccess: (summary, groups) => {
      updated(summary);
      onClose();
      toast.success(applyMessage(groups));
    },
    onError: (error) => toast.error(safeMessage(error, "The suggestions were not applied. Try again.")),
  });

  return (
    <section aria-labelledby="suggestions-heading" className="rounded-xl border border-primary/30 bg-card shadow-sm" data-testid="suggestions">
      <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 gap-3">
          <span aria-hidden className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
            <Sparkles className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 id="suggestions-heading" className="text-sm font-semibold">Suggested projects</h2>
            <p className="text-xs text-muted-foreground">
              Unassigned accounts grouped by matching names (“Acme Ad Account” and “Acme” go together).
              Nothing changes until you accept.
            </p>
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close suggestions" onClick={onClose} disabled={apply.isPending}>
          <X aria-hidden />
        </Button>
      </header>
      {suggestions.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          No suggestions: every selected account is already in a project, or no account names match a brand.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {suggestions.map((item) => (
            <SuggestionRow
              key={item.key}
              item={item}
              accounts={item.accountIds.map((id) => byId.get(id)).filter((account) => account !== undefined)}
              checked={chosen.has(item.key)}
              name={names[item.key] ?? item.name}
              disabled={apply.isPending}
              onCheckedChange={(checked) => setChosen((current) => {
                const next = new Set(current);
                if (checked) next.add(item.key);
                else next.delete(item.key);
                return next;
              })}
              onNameChange={(name) => setNames((current) => ({ ...current, [item.key]: name }))}
            />
          ))}
        </ul>
      )}
      {apply.isError ? (
        <p role="alert" className="border-t border-border px-4 py-2 text-sm text-destructive">
          {errorText(apply.error, "The suggestions were not applied. Try again.")}
        </p>
      ) : null}
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/40 px-4 py-3">
        <p className="text-xs text-muted-foreground">
          {accepted.length
            ? `${accepted.length} of ${suggestions.length} selected · ${accountsText(accepted.reduce((sum, item) => sum + item.accountIds.length, 0))}`
            : "Select the suggestions to apply."}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={apply.isPending}>Dismiss</Button>
          <Button size="sm" pending={apply.isPending} disabled={!accepted.length || invalid} onClick={() => apply.mutate(accepted.map((item) => ({
            name: item.projectId ? item.name : cleanProjectName(names[item.key] ?? item.name),
            accountIds: item.accountIds,
            existing: item.projectId !== null,
          })))}>
            Accept {accepted.length > 1 ? `${accepted.length} suggestions` : "suggestion"}
          </Button>
        </div>
      </footer>
    </section>
  );
}

function SuggestionRow({
  item,
  accounts,
  checked,
  name,
  disabled,
  onCheckedChange,
  onNameChange,
}: {
  item: ProjectSuggestion;
  accounts: ProjectAccount[];
  checked: boolean;
  name: string;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
  onNameChange: (name: string) => void;
}) {
  const checkboxId = `suggestion-${item.key}`;
  return (
    <li className={cn("flex flex-wrap items-start gap-3 px-4 py-3", !checked && "opacity-70")}>
      <Checkbox
        id={checkboxId}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        aria-label={`Apply ${name}`}
        className="mt-2"
      />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {item.projectId ? (
            <span className="text-sm font-medium">{item.name}</span>
          ) : (
            <Input
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
              disabled={disabled || !checked}
              aria-label="Project name"
              maxLength={MAX_PROJECT_NAME * 2}
              className="h-8 w-56 text-sm font-medium"
            />
          )}
          <Badge variant={item.projectId ? "info" : "soft"} size="sm">
            {item.projectId ? "Existing project" : "New project"}
          </Badge>
          {!item.confident ? <span className="text-xs text-muted-foreground">One account only</span> : null}
        </div>
        <ul className="flex flex-wrap gap-1.5">
          {accounts.map((account) => (
            <li key={account.id} className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs">
              <PlatformMark platform={account.platform} className="size-4 text-[9px]" />
              <span className="truncate">{accountLabel(account)}</span>
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
}
