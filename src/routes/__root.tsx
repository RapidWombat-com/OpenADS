/// <reference types="vite/client" />
import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext, HeadContent, Link, Outlet, Scripts, ScriptOnce,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { EmptyState } from '@/client/components/EmptyState';
import { Toaster } from '@/client/components/ui/sonner';
import { Button } from '@/client/components/ui/button';
import { TooltipProvider } from '@/client/components/ui/tooltip';
import { themePreferenceInitScript } from '@/client/lib/theme';
import appCss from '@/client/styles/app.css?url';
import favicon from '@/client/assets/favicon.svg?url';

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { title: 'OpenADS' },
      { name: 'robots', content: 'noindex, nofollow' },
      // Data-dense UI; browser translation rewrites text nodes React owns.
      { name: 'google', content: 'notranslate' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/svg+xml', href: favicon },
    ],
  }),
  shellComponent: RootDocument,
  component: Outlet,
  notFoundComponent: NotFound,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    // The theme script sets data-theme before hydration.
    <html lang="en" translate="no" suppressHydrationWarning>
      <head>
        {/* Inline, so it carries the per-request CSP nonce; runs before first paint. */}
        <ScriptOnce>{themePreferenceInitScript}</ScriptOnce>
        <HeadContent />
      </head>
      <body>
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster />
        <Scripts />
      </body>
    </html>
  );
}

function NotFound() {
  return (
    <main className="flex h-dvh items-center justify-center p-6">
      <div className="w-full max-w-md">
        <EmptyState
          kind="filtered"
          variant="card"
          title="Page not found"
          description="This address does not exist in OpenADS."
          action={<Button nativeButton={false} render={<Link to="/" />}>Go to overview</Button>}
        />
      </div>
    </main>
  );
}
