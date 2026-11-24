// Ported from OpenSEO (MIT, © Ben Senescu): src/client/components/SegmentedToggle.tsx. See THIRD_PARTY_NOTICES.md.
import type { ReactNode } from "react";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/client/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/client/components/ui/tooltip";

interface SegmentedToggleItem<T extends string> {
  value: T;
  icon: ReactNode;
  label: string;
  /** Not selectable; `hint` (a tooltip) says why. */
  disabled?: boolean;
  hint?: string | null;
}

/** A single-choice segmented control. Each item is a toggle with `aria-pressed`. */
export function SegmentedToggle<T extends string>({
  items,
  value,
  onChange,
  showLabels = false,
}: {
  items: SegmentedToggleItem<T>[];
  value: T;
  onChange: (value: T) => void;
  showLabels?: boolean;
}) {
  return (
    <ToggleGroup
      size="sm"
      spacing={0.5}
      value={[value]}
      onValueChange={(next) => {
        // A press on the active item empties the group. Keep one item on.
        const picked = items.find((item) => item.value === next[0]);
        if (picked) onChange(picked.value);
      }}
      // A border (not an inset ring) keeps the padding clear, and the larger outer
      // radius keeps the pressed pill concentric with the track.
      className="rounded-lg border border-border bg-muted p-0.5 data-[size=sm]:rounded-lg"
    >
      {items.map((item) => {
        const toggle = (
          <ToggleGroupItem
            key={item.value}
            value={item.value}
            disabled={item.disabled}
            aria-label={showLabels ? undefined : item.label}
            title={item.hint ? undefined : item.label}
            className="h-[22px] text-muted-foreground aria-pressed:bg-primary/15 aria-pressed:text-primary"
          >
            {item.icon}
            {showLabels && (
              // Trim the line box to cap height so the text centers optically
              // with the icon instead of riding high on the font's ascender.
              <span className="[text-box:trim-both_cap_alphabetic]">
                {item.label}
              </span>
            )}
          </ToggleGroupItem>
        );
        if (!item.hint) return toggle;
        // A disabled button gets no pointer events: the tooltip sits on a focusable wrapper.
        return (
          <Tooltip key={item.value}>
            <TooltipTrigger
              render={<span tabIndex={0} aria-label={`${item.label}: ${item.hint}`} />}
              className="inline-flex cursor-not-allowed rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {toggle}
            </TooltipTrigger>
            <TooltipContent>{item.hint}</TooltipContent>
          </Tooltip>
        );
      })}
    </ToggleGroup>
  );
}
