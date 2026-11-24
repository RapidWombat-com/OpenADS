import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { Layers } from "lucide-react";
import { PlatformMark } from "@/client/components/PlatformMark";
import { SegmentedToggle } from "@/client/components/SegmentedToggle";
import { Button } from "@/client/components/ui/button";
import { Input } from "@/client/components/ui/input";
import { formatDateRange } from "@/client/lib/format";
import {
  addDays,
  customRangeError,
  MAX_DAYS,
  type PlatformFilter,
  type Preset,
  type ResolvedWindow,
} from "@/client/lib/search";

type RangeChoice = Preset | "custom";
type PlatformChoice = PlatformFilter | "all";

const RANGE_ITEMS: { value: RangeChoice; label: string; icon: null }[] = [
  { value: "7d", label: "7 days", icon: null },
  { value: "30d", label: "30 days", icon: null },
  { value: "90d", label: "90 days", icon: null },
  { value: "custom", label: "Custom", icon: null },
];

const PLATFORM_ITEMS: { value: PlatformChoice; label: string; icon: ReactNode; disabled?: boolean; hint?: string | null }[] = [
  { value: "all", label: "All", icon: <Layers /> },
  { value: "google", label: "Google Ads", icon: <PlatformMark platform="google" decorative className="size-4 text-[9px]" /> },
  { value: "meta", label: "Meta Ads", icon: <PlatformMark platform="meta" decorative className="size-4 text-[9px]" /> },
];

export function DashboardFilters({
  range,
  includesToday = false,
  platform,
  today,
  onPreset,
  onCustom,
  onPlatform,
  platformOptions,
  accountFilter,
}: {
  range: ResolvedWindow;
  /** The report's window reaches a day that is not over yet in some account's time zone. */
  includesToday?: boolean;
  platform: PlatformFilter | undefined;
  today: string;
  onPreset: (preset: Preset) => void;
  onCustom: (start: string, end: string) => void;
  onPlatform: (platform: PlatformFilter | undefined) => void;
  /** Per platform: selectable in this scope, or disabled with a reason (none while the scope loads). */
  platformOptions: Record<PlatformFilter, { enabled: boolean; hint: string | null }>;
  /** The account multi-select, shown next to the platform toggle. */
  accountFilter?: ReactNode;
}) {
  const [editingCustom, setEditingCustom] = useState(range.preset === "custom");
  useEffect(() => {
    if (range.preset === "custom") setEditingCustom(true);
  }, [range.preset]);
  const rangeValue: RangeChoice = editingCustom ? "custom" : range.preset;

  return (
    <section aria-label="Filters" className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div role="group" aria-label="Date range">
            <SegmentedToggle
              items={RANGE_ITEMS}
              value={rangeValue}
              showLabels
              onChange={(value) => {
                if (value === "custom") {
                  setEditingCustom(true);
                  return;
                }
                setEditingCustom(false);
                onPreset(value);
              }}
            />
          </div>
          <p className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
            {formatDateRange(range.start, range.end)}
            <span className="sr-only">, {range.days} days</span>
          </p>
          {includesToday ? (
            <span
              className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
              title="The last day of this range is not over yet in at least one account's time zone, so its figures are still changing."
            >
              Includes today (incomplete)
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <div role="group" aria-label="Platform">
            <SegmentedToggle
              items={PLATFORM_ITEMS.map((item) =>
                item.value === "all" ? item : {
                  ...item,
                  disabled: !platformOptions[item.value].enabled && platform !== item.value,
                  hint: platformOptions[item.value].hint,
                })}
              value={platform ?? "all"}
              showLabels
              onChange={(value) => onPlatform(value === "all" ? undefined : value)}
            />
          </div>
          {accountFilter}
        </div>
      </div>
      {editingCustom ? (
        <CustomRangeForm key={`${range.start}:${range.end}`} range={range} today={today} onApply={onCustom} />
      ) : null}
    </section>
  );
}

function CustomRangeForm({
  range,
  today,
  onApply,
}: {
  range: ResolvedWindow;
  today: string;
  onApply: (start: string, end: string) => void;
}) {
  const id = useId();
  const [start, setStart] = useState(range.start);
  const [end, setEnd] = useState(range.end);
  const error = customRangeError(start, end, today);
  const unchanged = start === range.start && end === range.end && range.preset === "custom";

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!error && !unchanged) onApply(start, end);
  }

  return (
    <form
      onSubmit={submit}
      aria-label="Custom date range"
      className="flex flex-wrap items-end gap-x-3 gap-y-2 rounded-lg border border-border bg-card p-3"
    >
      <label className="grid gap-1 text-xs font-medium text-muted-foreground" htmlFor={`${id}-start`}>
        Start
        <Input
          id={`${id}-start`}
          type="date"
          required
          value={start}
          max={end && end <= today ? end : today}
          min={end ? addDays(end, -(MAX_DAYS - 1)) : undefined}
          onChange={(event) => setStart(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-hint`}
          className="h-8 w-40"
        />
      </label>
      <label className="grid gap-1 text-xs font-medium text-muted-foreground" htmlFor={`${id}-end`}>
        End
        <Input
          id={`${id}-end`}
          type="date"
          required
          value={end}
          min={start || undefined}
          max={today}
          onChange={(event) => setEnd(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-hint`}
          className="h-8 w-40"
        />
      </label>
      <Button type="submit" size="sm" className="h-8 px-3" disabled={Boolean(error) || unchanged}>
        Apply
      </Button>
      <p
        id={`${id}-hint`}
        role={error ? "alert" : undefined}
        className={error ? "basis-full text-xs text-destructive" : "basis-full text-xs text-muted-foreground"}
      >
        {error ?? `Up to ${MAX_DAYS} days, ending today at the latest.`}
      </p>
    </form>
  );
}
