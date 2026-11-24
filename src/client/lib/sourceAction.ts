// Which single action a dashboard source popover offers, and its one-sentence
// explanation. Pure: the UI maps `Action` onto the same routes and connect
// mutations the Sources cards use.
import { PLATFORM_LABEL, type Platform, type SetupIssue, type Source } from './report.ts';

/** What the viewer may do; null while the Sources summary is still loading. */
export interface Viewer {
  /** Workspace admin: may connect, reconnect and choose accounts. */
  admin: boolean;
  /** Instance admin for this platform: may open the setup wizard. */
  canSetUp: boolean;
}

export type Action =
  | { kind: 'setup'; label: string; platform: Platform; issue?: SetupIssue }
  | { kind: 'accounts'; label: string; platform: Platform }
  | { kind: 'connect'; label: string; platform: Platform; expiresAt?: string }
  | { kind: 'retry'; label: string }
  | { kind: 'sources'; label: string };

export interface PopoverPlan {
  /** One sentence, plain copy. */
  message: string;
  /** At most one primary (green) action. */
  primary: Action | null;
  /** A quiet link or button; never a duplicate of the primary. */
  secondary: Action | null;
}

const isoDay = (iso: string) => iso.slice(0, 10);

export function planSource(source: Source, viewer: Viewer | null, formatDate: (iso: string) => string = isoDay): PopoverPlan {
  const platform = source.platform;
  const name = PLATFORM_LABEL[platform];
  const viewSources: Action = { kind: 'sources', label: 'View Sources' };
  // Members (and viewers whose role is not known yet) get a pointer, never a button.
  const adminOnly = (message: string, memberMessage: string, allowed: boolean, action: Action): PopoverPlan =>
    allowed ? { message, primary: action, secondary: null } : { message: memberMessage, primary: null, secondary: viewSources };

  switch (source.detail) {
    case 'not_connected':
      return adminOnly(`${name} isn't connected yet, so its figures show —.`,
        `${name} isn't connected yet. Ask an admin to connect ${name}.`,
        !!viewer?.admin, { kind: 'connect', label: `Connect ${name}`, platform });
    case 'no_accounts_selected':
      return adminOnly(`${name} is connected, but no ad account is chosen, so its figures show —.`,
        `No ${name} ad account is chosen yet. Ask an admin to choose one.`,
        !!viewer?.admin, { kind: 'accounts', label: 'Choose accounts', platform });
    case 'reconnect_required':
      return adminOnly(`${name} access was revoked or expired, so its figures show —.`,
        `${name} access was revoked or expired. Ask an admin to reconnect ${name}.`,
        !!viewer?.admin, { kind: 'connect', label: `Reconnect ${name}`, platform });
    case 'setup_required':
      return adminOnly(`${name} setup needs attention, so its figures show —.`,
        `${name} setup needs attention. Ask an admin to fix the ${name} setup.`,
        !!viewer?.canSetUp, { kind: 'setup', label: 'Fix setup', platform, ...(source.setupIssue ? { issue: source.setupIssue } : {}) });
  }
  switch (source.status) {
    case 'available':
      if (source.reconnectBy) {
        const date = formatDate(source.reconnectBy);
        return viewer?.admin
          ? { message: `${name} access ends on ${date}.`, primary: { kind: 'connect', label: `Reconnect before ${date}`, platform, expiresAt: source.reconnectBy }, secondary: null }
          : { message: `${name} access ends on ${date}. Ask an admin to reconnect it.`, primary: null, secondary: { kind: 'sources', label: 'Manage in Sources' } };
      }
      return { message: `${name} returned a complete report for this date range.`, primary: null, secondary: { kind: 'sources', label: 'Manage in Sources' } };
    case 'not_configured':
      return adminOnly(`${name} isn't set up on this instance yet, so its figures show —.`,
        `${name} isn't set up on this instance yet. Ask an admin to set up ${name}.`,
        !!viewer?.canSetUp, { kind: 'setup', label: `Set up ${name}`, platform });
    case 'unavailable':
      return { message: `${name} didn't return a complete report, so its figures show —.`, primary: null, secondary: { kind: 'retry', label: 'Retry' } };
  }
}
