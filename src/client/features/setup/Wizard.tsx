// Shared pieces of the provider setup wizards (Google Ads, Meta Ads): the step
// list, deploy-time prerequisite notices and the "open in a new tab" button.
import type { ReactNode } from "react";
import { Check, ExternalLink, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { Alert, AlertDescription, AlertTitle } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";

export function Stepper<K extends string>({
  steps,
  titles,
  active,
  done,
  attention,
  disabled,
  onSelect,
}: {
  steps: readonly K[];
  titles: Record<K, string>;
  active: K;
  done: Record<K, boolean>;
  /** The step a reported problem points at. */
  attention: K | null;
  disabled: boolean;
  onSelect: (step: K) => void;
}) {
  return (
    <nav aria-label="Setup steps" className="min-w-0">
      <ol className="flex gap-1.5 overflow-x-auto pb-1 no-scrollbar lg:flex-col lg:gap-0.5 lg:overflow-visible lg:pb-0">
        {steps.map((step, index) => {
          const current = step === active;
          const warn = step === attention;
          return (
            <li key={step} className="shrink-0 lg:shrink">
              <button
                type="button"
                disabled={disabled}
                onClick={() => onSelect(step)}
                aria-current={current ? "step" : undefined}
                aria-label={`Step ${index + 1}: ${titles[step]}${warn ? " (needs attention)" : done[step] ? " (done)" : ""}`}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg p-1 text-left text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 lg:px-2.5 lg:py-2",
                  current ? "lg:bg-card lg:shadow-xs lg:ring-1 lg:ring-border" : "hover:bg-foreground/5",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums",
                    warn
                      ? "border-destructive bg-destructive/10 text-destructive"
                      : done[step]
                        ? "border-primary bg-primary text-primary-foreground"
                        : current
                          ? "border-primary text-primary"
                          : "border-border bg-card text-muted-foreground",
                    current && (warn ? "ring-3 ring-destructive/20" : "ring-3 ring-primary/25"),
                  )}
                >
                  {warn ? "!" : done[step] ? <Check className="size-3.5" /> : index + 1}
                </span>
                <span className={cn("hidden min-w-0 lg:block", current ? "font-medium" : "text-muted-foreground")}>
                  {titles[step]}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** One instance-level prerequisite (deploy-time setting) that blocks some steps. */
export function Prerequisite({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Alert variant="warning">
      <TriangleAlert aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="space-y-2">{children}</AlertDescription>
    </Alert>
  );
}

/** Opens a provider console page in a new tab (never this one, never with a referrer). */
export function ExternalButton({
  href,
  children,
  primary = true,
}: {
  href: string;
  children: ReactNode;
  primary?: boolean;
}) {
  return (
    <Button
      variant={primary ? "default" : "outline"}
      size={primary ? "default" : "sm"}
      nativeButton={false}
      render={<a href={href} target="_blank" rel="noopener noreferrer" />}
    >
      {children}
      <ExternalLink aria-hidden />
    </Button>
  );
}

export function Lead({ children }: { children: ReactNode }) {
  return <p className="text-[15px] leading-relaxed text-foreground">{children}</p>;
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground">{children}</p>;
}
