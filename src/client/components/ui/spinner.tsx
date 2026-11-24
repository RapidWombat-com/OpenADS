// Ported from OpenSEO (MIT, © Ben Senescu): src/client/components/ui/spinner.tsx. See THIRD_PARTY_NOTICES.md.
import { cn } from "cn";
import { Loader2Icon } from "lucide-react";

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
