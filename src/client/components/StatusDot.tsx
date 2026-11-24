import { cn } from "cn";
import type { CampaignStatus } from "@/client/lib/report";
import { STATUS_DOT, STATUS_LABEL } from "@/client/lib/status";

/** A colored dot and the status label; — when the platform did not report one. */
export function StatusDot({ status, className }: { status: CampaignStatus | null | undefined; className?: string }) {
  if (!status) return <span className={cn("text-muted-foreground", className)}>—</span>;
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", className)}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[status])} />
      {STATUS_LABEL[status]}
    </span>
  );
}
