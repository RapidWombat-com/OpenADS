import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../../lib/api.ts';
import { metaCallback } from '../../../../lib/meta-ads/service.ts';

export const Route = createFileRoute('/api/oauth/meta/callback')({
  server: {
    handlers: {
      GET: ({ request, context }) => metaCallback(request, appContext(context)),
      // HEAD would otherwise run GET and consume the one-time state.
      HEAD: () => methodNotAllowed('GET'),
      ANY: () => methodNotAllowed('GET'),
    },
  },
});
