import { useId, useRef, useState, type ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { cn } from "cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/client/components/ui/tooltip";
import { METRIC_HELP, type MetricKey } from "@/client/lib/metricHelp";

/**
 * The `?` next to a metric label: hover or keyboard focus shows the definition
 * from metricHelp.ts, a tap toggles it on touch screens. Clicks never reach
 * the surrounding control (a sortable header keeps sorting on its own button).
 */
export function MetricHelpButton({ metric, className }: { metric: MetricKey; className?: string }) {
  const help = METRIC_HELP[metric];
  const [open, setOpen] = useState(false);
  const touch = useRef(false);
  const id = useId();
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        closeOnClick={false}
        aria-label={`What is ${help.name}?`}
        aria-describedby={id}
        data-metric-help={metric}
        onPointerDown={(event) => {
          touch.current = event.pointerType === "touch";
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (touch.current) setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          // Enter/Space act on the help button only, not on a surrounding row or header.
          if (event.key === "Enter" || event.key === " ") event.stopPropagation();
          if (event.key === "Escape" && open) {
            event.stopPropagation();
            setOpen(false);
          }
        }}
        className={cn(
          "inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground/70 outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-popup-open:text-foreground",
          className,
        )}
      >
        <CircleHelp aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <span id={id} className="sr-only">{help.text}</span>
      <TooltipContent className="block max-w-64 text-left leading-snug font-normal normal-case tracking-normal">
        {help.text}
      </TooltipContent>
    </Tooltip>
  );
}

/** A metric's label with its `?` help button. */
export function MetricLabel({
  metric,
  children,
  className,
}: {
  metric: MetricKey;
  /** Defaults to the shared label. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {children ?? METRIC_HELP[metric].label}
      <MetricHelpButton metric={metric} />
    </span>
  );
}
