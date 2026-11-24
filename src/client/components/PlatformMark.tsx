import { cn } from "cn";
import { PLATFORM_LABEL, type Platform } from "@/client/lib/report";

/**
 * A neutral monogram for each ad platform (not the vendors' logos). The label
 * stays available to assistive technology unless `decorative` is set.
 */
export function PlatformMark({
  platform,
  decorative = false,
  className,
}: {
  platform: Platform;
  decorative?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-md text-[11px] leading-none font-semibold",
        platform === "google" ? "bg-google/12 text-google" : "bg-meta/12 text-meta",
        className,
      )}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : PLATFORM_LABEL[platform]}
      title={decorative ? undefined : PLATFORM_LABEL[platform]}
    >
      {platform === "google" ? "G" : "M"}
    </span>
  );
}
