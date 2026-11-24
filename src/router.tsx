import { CSPProvider } from '@base-ui/react/csp-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, useRouter } from '@tanstack/react-router';
import { createIsomorphicFn, getGlobalStartContext } from '@tanstack/react-start';
import type { ReactNode } from 'react';
import type { AccessIdentity } from './lib/access.ts';
import { routeTree } from './routeTree.gen';

/**
 * On the server, the nonce created by src/worker.ts after Access succeeds (also
 * used in that response's CSP header). TanStack Router stamps it on every inline
 * script it emits and in a csp-nonce meta tag, from which the client router
 * reads it back; the client never invents one.
 */
const requestNonce = createIsomorphicFn()
  .server(() => {
    const nonce = (getGlobalStartContext() as { nonce?: unknown } | undefined)?.nonce;
    return typeof nonce === 'string' ? nonce : undefined;
  })
  .client(() => undefined);

function Providers({ children, queryClient }: { children: ReactNode; queryClient: QueryClient }) {
  const router = useRouter();
  return (
    <CSPProvider nonce={router.options.ssr?.nonce}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </CSPProvider>
  );
}

export function getRouter() {
  // One client per router: per request on the server, once in the browser.
  const queryClient = new QueryClient({
    defaultOptions: {
      // Every report is a live provider call; do not repeat them implicitly.
      // gcTime stays at React Query's default: Infinity on the server, so SSR never
      // schedules garbage-collection timers in the Worker.
      queries: { staleTime: 5 * 60_000, retry: false, refetchOnWindowFocus: false },
    },
  });
  const nonce = requestNonce();
  return createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    ...(nonce ? { ssr: { nonce } } : {}),
    InnerWrap: ({ children }) => <Providers queryClient={queryClient}>{children}</Providers>,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
    server: {
      requestContext: { cloudflare: { env: Env }; nonce: string; identity: AccessIdentity };
    };
  }
}
