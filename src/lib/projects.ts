// Projects (stage 9): named groups of a workspace's connected ad accounts, so
// the dashboard can report on one brand or client at a time. Every member can
// read them; only workspace admins change them, with same-origin POSTs. Ids
// from the browser are only ever matched against the requester's own
// workspace (and D1's composite foreign keys reject anything else).
import { apiError, iso, json, objectBody, readBody, rejectCrossOrigin, session, type AppContext } from './api.ts';
import type { Platform } from './providers/types.ts';
import { isRecordId, ReportInputError, type ReportScope, type ScopeRequest } from './reporting.ts';
import {
  applyProjectChanges, deleteProject, listProjects, listWorkspaceAccounts, renameProject,
  type Membership, type ProjectChange, type ProjectRow, type Provider, type WorkspaceAccountRow,
} from './store.ts';

export const PROJECTS_ADMIN_ONLY = 'Only workspace admins can change projects.';
export const MAX_PROJECT_NAME = 80;
/** Per workspace: far above any real use, and it bounds every list and batch. */
export const MAX_PROJECTS = 100;
/** Accounts or groups in one request (selection allows 25 per provider). */
const MAX_ITEMS = 100;

const PLATFORM: Record<Provider, Platform> = { google_ads: 'google', meta_ads: 'meta' };

/** Trimmed, single-spaced, 1–80 characters, no control or format characters; null when invalid. */
export function projectName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4 * MAX_PROJECT_NAME) return null;
  const name = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (!name || name.length > MAX_PROJECT_NAME || /[\p{Cc}\p{Cf}]/u.test(name)) return null;
  return name;
}

/** Accounts a report can use: selected (and so eligible) for reporting. */
const reportable = (account: WorkspaceAccountRow) => account.selected && account.eligible;

function view(membership: Membership, projects: readonly ProjectRow[], accounts: readonly WorkspaceAccountRow[]) {
  const listed = accounts.filter(reportable);
  return {
    role: membership.role,
    projects: projects.map(project => ({
      id: project.id, name: project.name, createdAt: iso(project.createdAt),
      accountIds: listed.filter(account => account.projectId === project.id).map(account => account.id),
    })),
    // Every selected account of the workspace, whichever project it is in (projectId null: unassigned).
    accounts: listed.map(account => ({
      id: account.id, platform: PLATFORM[account.provider], customerId: account.customerId,
      name: account.name, currency: account.currencyCode, projectId: account.projectId,
    })),
  };
}

async function load(db: D1Database, membership: Membership) {
  const [projects, accounts] = await Promise.all([
    listProjects(db, membership.workspaceId), listWorkspaceAccounts(db, membership.workspaceId),
  ]);
  return { projects, accounts };
}

/** GET /api/projects.json — readable by every member. */
export async function projectsSummary(ctx: AppContext): Promise<Response> {
  const current = await session(ctx);
  if (current instanceof Response) return current;
  const { db, membership } = current;
  if (!membership) return json({ role: null, projects: [], accounts: [] });
  const { projects, accounts } = await load(db, membership);
  return json(view(membership, projects, accounts));
}

/** Same origin + workspace admin, with the request's JSON object body; or the response to send. */
async function adminRequest(request: Request, ctx: AppContext) {
  const rejected = rejectCrossOrigin(request, ctx.env);
  if (rejected) return rejected;
  const current = await session(ctx);
  if (current instanceof Response) return current;
  if (current.membership?.role !== 'admin') return apiError(PROJECTS_ADMIN_ONLY, 403);
  const body = objectBody(await readBody(request, 64 * 1024));
  if (!body) return apiError('Invalid request.', 400);
  return { db: current.db, membership: current.membership, body };
}

const onlyKeys = (body: Record<string, unknown>, keys: readonly string[]) => Object.keys(body).every(key => keys.includes(key));
const INVALID_NAME = () => apiError(`Enter a project name of 1 to ${MAX_PROJECT_NAME} characters.`, 400, { field: 'name' });
const NAME_TAKEN = () => apiError('A project with this name already exists.', 409, { field: 'name' });
const STALE = () => apiError('Projects changed in the meantime. Reload and try again.', 409);
const NOT_FOUND = () => apiError('This project no longer exists.', 404);
const TOO_MANY = () => apiError(`A workspace can have up to ${MAX_PROJECTS} projects.`, 409);

async function respond(db: D1Database, membership: Membership, extra: Record<string, unknown> = {}) {
  const { projects, accounts } = await load(db, membership);
  return json({ ...view(membership, projects, accounts), ...extra });
}

/** POST /api/projects/create (admin, same origin): `{ name }`. */
export async function createProject(request: Request, ctx: AppContext): Promise<Response> {
  const admin = await adminRequest(request, ctx);
  if (admin instanceof Response) return admin;
  const { db, membership, body } = admin;
  if (!onlyKeys(body, ['name'])) return apiError('Invalid request.', 400);
  const name = projectName(body.name);
  if (!name) return INVALID_NAME();
  if ((await listProjects(db, membership.workspaceId)).length >= MAX_PROJECTS) return TOO_MANY();
  const id = crypto.randomUUID();
  const result = await applyProjectChanges(db, membership.workspaceId, [{ create: { id, name } }], ctx.now());
  if (result === 'name_taken') return NAME_TAKEN();
  if (result === 'stale') return STALE();
  return respond(db, membership, { project: { id, name } });
}

/** POST /api/projects/rename (admin, same origin): `{ projectId, name }`. */
export async function renameProjectRequest(request: Request, ctx: AppContext): Promise<Response> {
  const admin = await adminRequest(request, ctx);
  if (admin instanceof Response) return admin;
  const { db, membership, body } = admin;
  if (!onlyKeys(body, ['projectId', 'name']) || !isRecordId(body.projectId)) return apiError('Invalid request.', 400);
  const name = projectName(body.name);
  if (!name) return INVALID_NAME();
  const result = await renameProject(db, membership.workspaceId, body.projectId, name);
  if (result === 'not_found') return NOT_FOUND();
  if (result === 'conflict') return NAME_TAKEN();
  return respond(db, membership);
}

/** POST /api/projects/delete (admin, same origin): `{ projectId }`. Its accounts become unassigned. */
export async function deleteProjectRequest(request: Request, ctx: AppContext): Promise<Response> {
  const admin = await adminRequest(request, ctx);
  if (admin instanceof Response) return admin;
  const { db, membership, body } = admin;
  if (!onlyKeys(body, ['projectId']) || !isRecordId(body.projectId)) return apiError('Invalid request.', 400);
  if (!await deleteProject(db, membership.workspaceId, body.projectId)) return NOT_FOUND();
  return respond(db, membership);
}

/** A list of distinct workspace record ids (1..max), or null. */
function idList(value: unknown, max = MAX_ITEMS): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > max || !value.every(isRecordId)) return null;
  return new Set(value).size === value.length ? value as string[] : null;
}

/**
 * POST /api/projects/assign (admin, same origin):
 * `{ assignments: [{ accountId, projectId | null }] }` — null unassigns.
 */
export async function assignAccounts(request: Request, ctx: AppContext): Promise<Response> {
  const admin = await adminRequest(request, ctx);
  if (admin instanceof Response) return admin;
  const { db, membership, body } = admin;
  const list = body.assignments;
  if (!onlyKeys(body, ['assignments']) || !Array.isArray(list) || list.length < 1 || list.length > MAX_ITEMS) {
    return apiError('Invalid request.', 400);
  }
  const assignments: { accountId: string; projectId: string | null }[] = [];
  for (const item of list) {
    const entry = objectBody(item);
    if (!entry || !onlyKeys(entry, ['accountId', 'projectId']) || !isRecordId(entry.accountId)
      || (entry.projectId !== null && !isRecordId(entry.projectId))) {
      return apiError('Invalid request.', 400);
    }
    assignments.push({ accountId: entry.accountId, projectId: entry.projectId });
  }
  if (new Set(assignments.map(item => item.accountId)).size !== assignments.length) return apiError('Invalid request.', 400);
  const { projects, accounts } = await load(db, membership);
  const accountIds = new Set(accounts.map(account => account.id));
  const projectIds = new Set(projects.map(project => project.id));
  if (!assignments.every(item => accountIds.has(item.accountId))) {
    return apiError('Assign only ad accounts of this workspace.', 400);
  }
  if (!assignments.every(item => item.projectId === null || projectIds.has(item.projectId))) {
    return apiError('Assign accounts only to projects of this workspace.', 400);
  }
  const result = await applyProjectChanges(db, membership.workspaceId, [{ assignments }], ctx.now());
  if (result !== 'applied') return STALE();
  return respond(db, membership);
}

/**
 * POST /api/projects/apply (admin, same origin): `{ groups: [{ name, accountIds }] }`.
 * Applies suggestions the admin accepted: each group goes into the existing
 * project of that name (ignoring case) or a new one. All or nothing.
 */
export async function applyProjectGroups(request: Request, ctx: AppContext): Promise<Response> {
  const admin = await adminRequest(request, ctx);
  if (admin instanceof Response) return admin;
  const { db, membership, body } = admin;
  const list = body.groups;
  if (!onlyKeys(body, ['groups']) || !Array.isArray(list) || list.length < 1 || list.length > MAX_ITEMS) {
    return apiError('Invalid request.', 400);
  }
  const groups: { name: string; accountIds: string[] }[] = [];
  for (const item of list) {
    const entry = objectBody(item);
    const accountIds = entry ? idList(entry.accountIds) : null;
    if (!entry || !onlyKeys(entry, ['name', 'accountIds']) || !accountIds) return apiError('Invalid request.', 400);
    const name = projectName(entry.name);
    if (!name) return INVALID_NAME();
    groups.push({ name, accountIds });
  }
  const key = (name: string) => name.toLowerCase();
  const allAccounts = groups.flatMap(group => group.accountIds);
  if (new Set(groups.map(group => key(group.name))).size !== groups.length
    || new Set(allAccounts).size !== allAccounts.length || allAccounts.length > MAX_ITEMS) {
    return apiError('Each project and each account may appear in one group only.', 400);
  }
  const { projects, accounts } = await load(db, membership);
  const accountIds = new Set(accounts.map(account => account.id));
  if (!allAccounts.every(id => accountIds.has(id))) return apiError('Assign only ad accounts of this workspace.', 400);
  const existing = new Map(projects.map(project => [key(project.name), project.id]));
  const created = groups.filter(group => !existing.has(key(group.name))).length;
  if (projects.length + created > MAX_PROJECTS) return TOO_MANY();
  const changes: ProjectChange[] = groups.map(group => {
    const current = existing.get(key(group.name));
    const id = current ?? crypto.randomUUID();
    return {
      ...(current ? {} : { create: { id, name: group.name } }),
      assignments: group.accountIds.map(accountId => ({ accountId, projectId: id })),
    };
  });
  const result = await applyProjectChanges(db, membership.workspaceId, changes, ctx.now());
  if (result === 'name_taken' || result === 'stale') return STALE();
  return respond(db, membership, { applied: { created, assigned: allAccounts.length } });
}

/**
 * Resolves the project/account filter of /api/campaigns.json against the
 * requester's workspace. Unknown ids are a 400 (ReportInputError); the scope
 * holds only selected accounts, so nothing outside it is ever queried.
 */
export async function resolveReportScope(ctx: AppContext, request: ScopeRequest): Promise<ReportScope> {
  const current = await session(ctx);
  if (current instanceof Response) throw new Error('Reporting unavailable.');
  const membership = current.membership;
  const { projects, accounts } = membership ? await load(current.db, membership) : { projects: [], accounts: [] };
  const project = request.project;
  if (project !== null && project !== 'unassigned' && !projects.some(item => item.id === project)) {
    throw new ReportInputError('project must be a project of this workspace.');
  }
  const inProject = (account: WorkspaceAccountRow) => project === null
    || account.projectId === (project === 'unassigned' ? null : project);
  const byId = new Map(accounts.map(account => [account.id, account]));
  for (const id of request.accounts) {
    const account = byId.get(id);
    if (!account) throw new ReportInputError('account must be an ad account of this workspace.');
    if (!inProject(account)) throw new ReportInputError('account must belong to the selected project.');
  }
  const wanted = request.accounts.length ? new Set(request.accounts) : null;
  const scoped = accounts.filter(account => reportable(account) && inProject(account) && (!wanted || wanted.has(account.id)));
  return {
    accountIds: new Set(scoped.map(account => account.id)),
    platforms: new Set(scoped.map(account => PLATFORM[account.provider])),
  };
}

/**
 * Reporting time zones of the accounts a report covers: the scope's accounts, or
 * every selected account of `platforms` (src/lib/reporting.ts picks the
 * westernmost for the default window), with null for an account whose zone is
 * unknown (reporting then assumes UTC−12). Empty without a workspace.
 */
export async function reportTimeZones(
  ctx: AppContext, scope: ReportScope | null, platforms: readonly Platform[],
): Promise<(string | null)[]> {
  const current = await session(ctx);
  if (current instanceof Response || !current.membership) return [];
  const accounts = await listWorkspaceAccounts(current.db, current.membership.workspaceId);
  const wanted = new Set(platforms);
  return [...new Set(accounts
    .filter(account => reportable(account) && wanted.has(PLATFORM[account.provider])
      && (!scope || scope.accountIds.has(account.id)))
    .map(account => account.timeZone))];
}
