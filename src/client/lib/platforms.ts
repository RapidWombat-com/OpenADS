// Which ad platforms the dashboard may show for the current scope. A platform
// is rendered (source pill, conversions line, platform toggle) only once the
// scope is known: until the projects list and the remembered project are
// resolved, callers render neutral skeletons, so a Meta-only project never
// flashes a Google Ads pill on reload.
import { PLATFORM_LABEL, type Platform } from './report.ts';

export const ALL_PLATFORMS: readonly Platform[] = ['google', 'meta'];

export interface PlatformScopeInput {
  /** Projects loaded (or failed) and the remembered project restored. */
  resolved: boolean;
  /** A project or account filter applies. */
  scoped: boolean;
  /** Projects could not be loaded: a scoped view learns its platforms from the report. */
  projectsFailed?: boolean;
  /** Accounts the report covers (project × platform filter × account filter). */
  accounts: readonly { platform: Platform }[];
  /** Accounts of the project, any platform: what the platform toggle offers. */
  projectAccounts: readonly { platform: Platform }[];
  /** The platform filter in the URL. */
  filter: Platform | undefined;
  /** Platforms listed by the loaded report, or null before it arrives. */
  reported: readonly Platform[] | null;
  /** "this project" / "Unassigned", for the toggle hint. */
  scopeName?: string;
}

export interface PlatformScope {
  /** Platforms to render, in order; null while unknown (render skeletons without names). */
  visible: Platform[] | null;
  /** Platform toggle: whether each platform can be chosen, and why not. */
  toggle: Record<Platform, { enabled: boolean; hint: string | null }>;
}

export function platformScope(input: PlatformScopeInput): PlatformScope {
  const pending = { enabled: false, hint: null };
  if (!input.resolved) return { visible: null, toggle: { google: pending, meta: pending } };
  const has = (accounts: readonly { platform: Platform }[], platform: Platform) => !input.scoped || input.projectsFailed
    || accounts.some(account => account.platform === platform);
  const wanted = ALL_PLATFORMS.filter(platform => (!input.filter || input.filter === platform) && has(input.accounts, platform));
  const where = input.scopeName ?? 'this project';
  const toggle = {} as PlatformScope['toggle'];
  for (const platform of ALL_PLATFORMS) {
    const enabled = has(input.projectAccounts, platform);
    toggle[platform] = { enabled, hint: enabled ? null : `No ${PLATFORM_LABEL[platform]} accounts in ${where}` };
  }
  if (input.reported) return { visible: wanted.filter(platform => input.reported!.includes(platform)), toggle };
  // Before the report: the scope's platforms are known, unless projects failed for a scoped view.
  return { visible: input.scoped && input.projectsFailed ? null : wanted, toggle };
}
