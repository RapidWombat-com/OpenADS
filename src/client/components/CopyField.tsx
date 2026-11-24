import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "cn";
import { toast } from "sonner";
import { Button } from "@/client/components/ui/button";

/**
 * A value the user must type into another site, with a copy button. The value
 * is selectable text, so copying by hand works where the Clipboard API is
 * unavailable.
 */
export function CopyField({
  label,
  value,
  hint,
  prominent = false,
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  /** A highlighted box, for values that must match exactly (redirect URI). */
  prominent?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const valueRef = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Fall back to selecting the text for a manual copy.
      const node = valueRef.current;
      const selection = node ? window.getSelection() : null;
      if (node && selection) {
        const range = document.createRange();
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      toast.error("Copy failed. The text is selected: press Ctrl/Cmd+C.");
      return;
    }
    setCopied(true);
    toast.success(`${label} copied`);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className={cn("min-w-0", className)}>
      <div className="mb-1 text-xs font-medium text-muted-foreground">{label}</div>
      <div
        className={cn(
          "flex min-w-0 items-center gap-1 rounded-lg border border-border bg-muted/60 py-1 pr-1 pl-3",
          prominent && "border-primary/40 bg-primary/5",
        )}
      >
        <code ref={valueRef} className="min-w-0 flex-1 truncate font-mono text-[13px] select-all" title={value}>
          {value}
        </code>
        <Button
          variant="ghost"
          size="sm"
          aria-label={copied ? `${label} copied` : `Copy ${label}`}
          onClick={() => void copy()}
          className={cn("shrink-0", copied && "text-success")}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
