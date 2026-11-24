import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../../lib/api.ts';
import { googleCallback } from '../../../../lib/google-ads/service.ts';

export const Route = createFileRoute('/api/oauth/google/callback')({
  server: {
    handlers: {
      GET: ({ request, context }) => googleCallback(request, appContext(context)),
      // HEAD would otherwise run GET and consume the one-time state.
      HEAD: () => methodNotAllowed('GET'),
      ANY: () => methodNotAllowed('GET'),
    },
  },
});
