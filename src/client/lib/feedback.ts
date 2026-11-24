// Pure builders for the save-feedback toasts (tested without a browser), and
// the rule for what an error may say: only the application-authored message of
// a SourcesError, never a raw Error, a stack or a provider response.
import { SourcesError } from './sources.ts';

const MAX_TOAST_TEXT = 140;

/** A short, sanitized message for `toast.error`. */
export function safeMessage(error: unknown, fallback: string): string {
  const text = error instanceof SourcesError ? error.message : fallback;
  const oneLine = text.replace(/\s+/gu, ' ').trim();
  return oneLine.length > MAX_TOAST_TEXT ? `${oneLine.slice(0, MAX_TOAST_TEXT - 1)}…` : oneLine;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export const accountsCount = (count: number) => plural(count, 'ad account');

/** "Northwind Ad Account → Contoso" / "Northwind Ad Account moved to Unassigned". */
export function assignMessage(accountName: string, projectName: string | null): string {
  return projectName === null ? `${accountName} moved to Unassigned` : `${accountName} → ${projectName}`;
}

/** "Created Contoso with 2 accounts" / "Created 2 projects" / "Updated 3 projects". */
export function applyMessage(groups: readonly { name: string; accountIds: readonly string[]; existing: boolean }[]): string {
  const created = groups.filter(group => !group.existing);
  const accounts = groups.reduce((sum, group) => sum + group.accountIds.length, 0);
  if (groups.length === 1) {
    const [group] = groups;
    return group.existing
      ? `Added ${plural(accounts, 'account')} to ${group.name}`
      : `Created ${group.name} with ${plural(accounts, 'account')}`;
  }
  const parts = [];
  if (created.length) parts.push(`Created ${plural(created.length, 'project')}`);
  if (groups.length > created.length) parts.push(`updated ${plural(groups.length - created.length, 'project')}`);
  const text = `${parts.join(', ')} with ${plural(accounts, 'account')}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const createdMessage = (name: string) => `Created ${name}`;
export const renamedMessage = (from: string, to: string) => `Renamed ${from} → ${to}`;
export const deletedMessage = (name: string) => `Deleted ${name}`;
export const selectionMessage = (platform: string, count: number) =>
  count === 0 ? `${platform}: no ad accounts selected` : `${platform}: ${plural(count, 'ad account')} selected`;
