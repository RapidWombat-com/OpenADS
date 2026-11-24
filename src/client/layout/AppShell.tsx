// Ported from OpenSEO (MIT, © Ben Senescu): src/client/layout/AppShell.tsx. The
// mobile top bar and desktop header are one header here.
import type { ReactNode } from "react";
import { AppSidebar } from "@/client/layout/AppSidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/client/components/ui/sidebar";

export function AppShell({
  title,
  context,
  actions,
  children,
}: {
  title: string;
  /** What the page is scoped to (the dashboard's project), shown after the title. */
  context?: string | null;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <SidebarProvider className="h-dvh min-h-0 overflow-hidden">
      <AppSidebar />
      <SidebarInset className="min-h-0 overflow-hidden md:!m-0 md:!mt-2 md:!rounded-none md:!rounded-tl-lg md:border-t md:border-l md:border-sidebar-border md:!shadow-none">
        <header className="flex h-12 min-w-0 shrink-0 items-center gap-2 border-b border-border bg-card px-2 md:px-4">
          <SidebarTrigger className="md:-ml-1.5" />
          <span className="font-semibold md:hidden">OpenADS</span>
          <span aria-hidden className="text-muted-foreground md:hidden">/</span>
          {context ? (
            <h1 className="flex min-w-0 items-baseline gap-2 text-sm font-medium md:text-base md:font-semibold">
              <span className="hidden shrink-0 sm:inline">{title}</span>
              <span aria-hidden className="hidden font-normal text-muted-foreground sm:inline">/</span>
              <span className="truncate" data-testid="page-context">
                <span className="sr-only sm:hidden">{title}: </span>
                {context}
              </span>
            </h1>
          ) : (
            <h1 className="min-w-0 truncate text-sm font-medium md:text-base md:font-semibold">{title}</h1>
          )}
          {actions ? (
            <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
          ) : null}
        </header>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
