import { Check, Loader2 } from "lucide-react";

export type SaveState = "idle" | "saving" | "saved";

/**
 * Inline feedback next to a control that saves on change: a spinner while
 * saving, then a check that the caller clears after ~2s. The live region is
 * always mounted so screen readers announce the text when it appears.
 */
export function SaveStatus({ state }: { state: SaveState }) {
  return (
    <span aria-live="polite" role="status" className="inline-flex size-4 shrink-0 items-center justify-center">
      {state === "saving" ? (
        <>
          <Loader2 aria-hidden className="size-4 animate-spin text-muted-foreground" />
          <span className="sr-only">Saving</span>
        </>
      ) : state === "saved" ? (
        <>
          <Check aria-hidden className="size-4 animate-in fade-in text-success" />
          <span className="sr-only">Saved</span>
        </>
      ) : null}
    </span>
  );
}
