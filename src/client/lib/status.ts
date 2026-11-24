// Campaign / ad set / ad group delivery status, as shown with a colored dot.
import type { CampaignStatus } from './report.ts';

export const STATUS_LABEL: Record<CampaignStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  removed: 'Removed',
  archived: 'Archived',
  issues: 'With issues',
  pending: 'In review',
};

/** Dot colors (literal Tailwind classes, so they are generated). */
export const STATUS_DOT: Record<CampaignStatus, string> = {
  active: 'bg-success',
  paused: 'bg-warning',
  removed: 'bg-destructive',
  archived: 'bg-muted-foreground/50',
  issues: 'bg-destructive',
  pending: 'bg-muted-foreground',
};

export const statusLabel = (status: CampaignStatus | null | undefined) => (status ? STATUS_LABEL[status] : null);
