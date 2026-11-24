// Client view of the Projects API (contract: docs/dev.md) and the pure helpers
// behind the project switcher, the account filter and "Suggest projects".
// Same-origin calls only, through the Sources API client (fixed messages).
import type { Platform } from './report.ts';
import { call, type Role } from './sources.ts';

export interface ProjectAccount {
  /** connected_account id: what `account=` and assignments refer to. */
  id: string;
  platform: Platform;
  /** Google customer ID / Meta ad account ID. */
  customerId: string;
  name: string | null;
  currency: string | null;
  /** null: unassigned. */
  projectId: string | null;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string | null;
  /** Selected accounts in this project. */
  accountIds: string[];
}

export interface ProjectsSummary {
  /** null: the workspace is not set up yet. */
  role: Role | null;
  projects: Project[];
  /** Every selected account of the workspace. */
  accounts: ProjectAccount[];
}

export interface Assignment { accountId: string; projectId: string | null }
export interface ProjectGroup { name: string; accountIds: string[] }

export const MAX_PROJECT_NAME = 80;

export const fetchProjects = () => call<ProjectsSummary>('/api/projects.json');
const post = <T = ProjectsSummary>(path: string, body: unknown) =>
  call<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const createProject = (name: string) =>
  post<ProjectsSummary & { project: { id: string; name: string } }>('/api/projects/create', { name });
export const renameProject = (projectId: string, name: string) => post('/api/projects/rename', { projectId, name });
export const deleteProject = (projectId: string) => post('/api/projects/delete', { projectId });
export const assignAccounts = (assignments: Assignment[]) => post('/api/projects/assign', { assignments });
export const applyProjectGroups = (groups: ProjectGroup[]) =>
  post<ProjectsSummary & { applied: { created: number; assigned: number } }>('/api/projects/apply', { groups });

/** Mirrors the server's name rule: trimmed, single-spaced, 1–80 characters. */
export function cleanProjectName(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

// ── Active project ─────────────────────────────────────────────────────────

/** The dashboard scope: every account, the unassigned ones, or one project. */
export const UNASSIGNED = 'unassigned';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isRecordId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);
export const isProjectParam = (value: unknown): value is string => value === UNASSIGNED || isRecordId(value);

// Browser-local and per device; the server never trusts it. A remembered
// project that no longer exists is dropped when the projects list loads.
const LAST_PROJECT_KEY = 'openads:lastProject';
const ALL = 'all';

/** The last choice: a project id, `unassigned`, `all` (explicitly every project), or null (never chosen). */
export function getLastProject(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(LAST_PROJECT_KEY);
    return value === ALL || isProjectParam(value) ? value : null;
  } catch {
    return null;
  }
}

export function setLastProject(project: string | undefined): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LAST_PROJECT_KEY, project ?? ALL);
  } catch {
    // Private mode / disabled storage: the URL still carries the choice.
  }
}

/**
 * The summary with one account moved (null: unassigned). Used for the optimistic
 * update and for rolling back a failed one; touches only that account, so
 * other rows saving at the same time keep their state.
 */
export function moveAccount(summary: ProjectsSummary, accountId: string, projectId: string | null): ProjectsSummary {
  return {
    ...summary,
    accounts: summary.accounts.map(account => account.id === accountId ? { ...account, projectId } : account),
    projects: summary.projects.map(project => {
      const rest = project.accountIds.filter(id => id !== accountId);
      return { ...project, accountIds: project.id === projectId ? [...rest, accountId] : rest };
    }),
  };
}

/** The accounts a dashboard scope reports on. */
export function accountsInScope(summary: ProjectsSummary | undefined, project: string | undefined): ProjectAccount[] {
  const accounts = summary?.accounts ?? [];
  if (!project) return accounts;
  return accounts.filter(account => account.projectId === (project === UNASSIGNED ? null : project));
}

/** The label of a scope, or null when the project is unknown (deleted, or not loaded yet). */
export function scopeLabel(summary: ProjectsSummary | undefined, project: string | undefined): string | null {
  if (!project) return 'All projects';
  if (project === UNASSIGNED) return 'Unassigned';
  return summary?.projects.find(item => item.id === project)?.name ?? null;
}

export function accountLabel(account: Pick<ProjectAccount, 'name' | 'customerId'>): string {
  return account.name?.trim() || account.customerId;
}

// ── Suggestions ────────────────────────────────────────────────────────────

/**
 * Words that describe the ad account rather than the brand: "Acme Ad
 * Account" and the Google account "Acme" are the same project.
 */
const NOISE = new Set([
  'ad', 'ads', 'account', 'accounts', 'acct', 'advertising', 'adwords', 'google', 'meta', 'facebook', 'fb',
  'instagram', 'ig', 'campaign', 'campaigns', 'manager', 'mcc', 'business', 'portfolio', 'inc', 'llc', 'ltd',
  'limited', 'pty', 'gmbh', 'corp', 'co', 'company', 'the',
]);

const fold = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/** The brand words of an account name, in their original spelling. */
export function nameTokens(name: string | null, currency: string | null = null): string[] {
  const words = (name ?? '').normalize('NFC').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.filter(word => {
    const folded = fold(word);
    if (NOISE.has(folded)) return false;
    // The account's own currency ("Shop AUD") and long numbers (account IDs) are not part of the brand.
    if (currency && folded === currency.toLowerCase()) return false;
    return !/^\d{6,}$/.test(word);
  });
}

/** The normalized name two accounts must share to be suggested together ("" when nothing is left). */
export const projectKey = (name: string | null, currency: string | null = null) =>
  nameTokens(name, currency).map(fold).join('');

export interface ProjectSuggestion {
  /** Normalized name shared by the group. */
  key: string;
  /** Proposed project name: the existing project's, or the shortest account spelling. */
  name: string;
  /** An existing project with this name, which receives the accounts instead of a new one. */
  projectId: string | null;
  accountIds: string[];
  /** Two or more accounts, or an existing project: worth accepting by default. */
  confident: boolean;
}

interface Draft { tokens: string[]; key: string; name: string; projectId: string | null; accounts: ProjectAccount[] }

/** `key` is a whole-word prefix of `tokens` ("northwind" of north|wind|au and of northwind|au). */
const extendsKey = (tokens: string[], key: string) =>
  tokens.some((_, index) => tokens.slice(0, index + 1).join('') === key) && tokens.join('') !== key;

/**
 * Proposes projects for the unassigned accounts by matching normalized names
 * (case, accents, punctuation and words such as "Ad Account" ignored). A name
 * that extends another one ("Northwind Search" after "Northwind") joins it.
 * Accounts already in a project are never moved. Nothing is applied here.
 */
export function suggestProjects(accounts: readonly ProjectAccount[], projects: readonly Pick<Project, 'id' | 'name'>[]): ProjectSuggestion[] {
  const drafts = new Map<string, Draft>();
  for (const project of projects) {
    const tokens = nameTokens(project.name).map(fold);
    const key = tokens.join('');
    if (key && !drafts.has(key)) drafts.set(key, { tokens, key, name: project.name, projectId: project.id, accounts: [] });
  }
  for (const account of accounts) {
    if (account.projectId !== null) continue;
    const words = nameTokens(account.name, account.currency);
    const tokens = words.map(fold);
    const key = tokens.join('');
    if (!key) continue;
    const draft = drafts.get(key) ?? { tokens, key, name: words.join(' '), projectId: null, accounts: [] };
    if (draft.projectId === null && words.join(' ').length < draft.name.length) draft.name = words.join(' ');
    draft.accounts.push(account);
    drafts.set(key, draft);
  }
  // Longer names join the shortest name they extend (at least 4 letters, so "the"/"my" never absorb anything).
  const ordered = [...drafts.values()].sort((a, b) => a.key.length - b.key.length || a.key.localeCompare(b.key));
  const merged: Draft[] = [];
  for (const draft of ordered) {
    const base = draft.projectId === null
      ? merged.find(candidate => candidate.key.length >= 4 && extendsKey(draft.tokens, candidate.key)) : undefined;
    if (base) base.accounts.push(...draft.accounts);
    else merged.push(draft);
  }
  const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
  return merged
    .filter(draft => draft.accounts.length > 0)
    .map(draft => ({
      key: draft.key,
      name: draft.name.slice(0, MAX_PROJECT_NAME),
      projectId: draft.projectId,
      accountIds: draft.accounts.map(account => account.id),
      confident: draft.projectId !== null || draft.accounts.length > 1,
    }))
    .sort((a, b) => Number(b.confident) - Number(a.confident) || collator.compare(a.name, b.name));
}
