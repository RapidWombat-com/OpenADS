// GET /api/campaigns/<platform>/<campaignId>.json — one campaign of one selected
// ad account, loaded when a dashboard row is expanded. The account is a
// connected_account id that must be a selected account of the requester's
// workspace on that platform (else 404) and, with `project=`, in that project
// (else 400) — all checked in D1 before any provider request. Provider failures
// become fixed messages; provider text never reaches the response.
import { apiError, json, session, type AppContext } from './api.ts';
import { googleCampaignDetail } from './google-ads/service.ts';
import { metaCampaignDetail } from './meta-ads/service.ts';
import { CampaignDetailError, type Platform } from './providers/types.ts';
import { includesUnfinishedDay, isRecordId, parseWindow, ReportInputError } from './reporting.ts';
import { listProjects, listWorkspaceAccounts, type Provider } from './store.ts';

const KEYS = new Set(['account', 'start', 'end', 'project']);
const PROVIDER: Record<Platform, Provider> = { google: 'google_ads', meta: 'meta_ads' };
const LABEL: Record<Platform, string> = { google: 'Google Ads', meta: 'Meta Ads' };
const NOT_FOUND = () => apiError('Campaign not found.', 404);

export interface DetailRequest {
  readonly platform: Platform;
  readonly campaignId: string;
  readonly account: string;
  readonly project: string | null;
  readonly start: string;
  readonly end: string;
}

/** Validates the path and query; null for a path that names no campaign (404). Throws ReportInputError (400). */
export function parseDetailRequest(platform: string, campaignId: string, params: URLSearchParams, now: Date): DetailRequest | null {
  if ((platform !== 'google' && platform !== 'meta') || !/^[1-9]\d{0,19}$/.test(campaignId)) return null;
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!KEYS.has(key)) throw new ReportInputError('Only account, start, end and project query parameters are supported.');
    if (seen.has(key)) throw new ReportInputError(`${key} must be supplied at most once.`);
    seen.add(key);
  }
  const account = params.get('account');
  if (!isRecordId(account)) throw new ReportInputError('account must be an account ID.');
  const project = params.get('project');
  if (project !== null && project !== 'unassigned' && !isRecordId(project)) {
    throw new ReportInputError('project must be a project ID or unassigned.');
  }
  const window = parseWindow(params.get('start'), params.get('end'), now);
  return { platform, campaignId, account, project, ...window };
}

export async function campaignDetailResponse(
  ctx: AppContext, url: URL, platform: string, campaignId: string,
): Promise<Response> {
  let request: DetailRequest | null;
  try {
    request = parseDetailRequest(platform, campaignId, url.searchParams, new Date(ctx.now()));
  } catch (error) {
    return apiError(error instanceof ReportInputError ? error.message : 'Invalid request.', 400);
  }
  if (!request) return NOT_FOUND();
  try {
    const current = await session(ctx);
    if (current instanceof Response) return current;
    if (!current.membership) return NOT_FOUND();
    const workspaceId = current.membership.workspaceId;
    const [projects, accounts] = await Promise.all([listProjects(current.db, workspaceId), listWorkspaceAccounts(current.db, workspaceId)]);
    const account = accounts.find(item => item.id === request.account);
    // Not this workspace's, not selected for reporting, or another platform: nothing to show.
    if (!account || !account.selected || !account.eligible || account.provider !== PROVIDER[request.platform]) return NOT_FOUND();
    if (request.project !== null) {
      if (request.project !== 'unassigned' && !projects.some(project => project.id === request.project)) {
        return apiError('project must be a project of this workspace.', 400);
      }
      if (account.projectId !== (request.project === 'unassigned' ? null : request.project)) {
        return apiError('account must belong to the selected project.', 400);
      }
    }
    // Without dates, the default window ends on the account's last complete day.
    const window = url.searchParams.has('start') || url.searchParams.has('end') || !account.timeZone
      ? { start: request.start, end: request.end }
      : parseWindow(null, null, new Date(ctx.now()), [account.timeZone]);
    const load = request.platform === 'google' ? googleCampaignDetail : metaCampaignDetail;
    const { detail, account: row } = await load(ctx, current.db, workspaceId, account.id, request.campaignId, window);
    return json({
      source: 'live', platform: request.platform, window,
      includesToday: includesUnfinishedDay(window, new Date(ctx.now()), row.timeZone ? [row.timeZone] : []),
      account: { id: row.id, providerId: row.customerId, name: row.name, currency: row.currencyCode, timeZone: row.timeZone },
      campaign: detail,
    });
  } catch (error) {
    const name = LABEL[request.platform];
    const kind = error instanceof CampaignDetailError ? error.kind : 'unavailable';
    if (kind === 'not_found') return NOT_FOUND();
    if (kind === 'reconnect_required') return apiError(`${name} access expired. Reconnect to continue.`, 409, { reconnect: true });
    if (kind === 'setup_required') return apiError(`${name} setup needs attention before campaign details can load.`, 409, { setupRequired: true });
    return apiError(`${name} did not return this campaign. Try again in a moment.`, 502);
  }
}
