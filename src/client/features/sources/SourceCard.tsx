import type { ReactNode } from "react";
import { cn } from "cn";
import { PlatformMark } from "@/client/components/PlatformMark";
import { Badge } from "@/client/components/ui/badge";
import type { Platform } from "@/client/lib/report";

export type SourceBadge = "connected" | "not_connected" | "expired" | "expiring" | "setup";

const BADGES: Record<SourceBadge, { label: string; variant: "success" | "outline" | "destructive" | "info" | "warning" }> = {
  connected: { label: "Connected", variant: "success" },
  not_connected: { label: "Not connected", variant: "outline" },
  expired: { label: "Access expired", variant: "destructive" },
  expiring: { label: "Expires soon", variant: "warning" },
  setup: { label: "Not set up", variant: "warning" },
};

/** One provider on the Sources page: mark, name, status pill, body and actions. */
export function SourceCard({
  platform,
  title,
  badge,
  children,
  actions,
  className,
}: {
  platform: Platform;
  title: string;
  badge: SourceBadge | null;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const status = badge ? BADGES[badge] : null;
  return (
    <section
      aria-labelledby={`source-${platform}`}
      className={cn("flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-card p-4 shadow-sm md:p-5", className)}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <PlatformMark platform={platform} decorative className="size-8 text-sm" />
          <h2 id={`source-${platform}`} className="truncate text-base font-semibold">
            {title}
          </h2>
        </div>
        {status ? (
          <Badge variant={status.variant} className="mt-1">
            <span aria-hidden className="size-1.5 rounded-full bg-current" />
            {status.label}
          </Badge>
        ) : null}
      </header>
      <div className="flex-1 space-y-3 text-sm">{children}</div>
      {actions ? <footer className="flex flex-wrap items-center gap-2">{actions}</footer> : null}
    </section>
  );
}
