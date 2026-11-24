import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../../lib/api.ts';
import { startMetaConnect } from '../../../../lib/meta-ads/service.ts';

// POST only (same-origin fetch): creating OAuth state is a state change. The
// browser then navigates to the returned Facebook URL, so the CSP form-action
// stays 'self'.
export const Route = createFileRoute('/api/oauth/meta/start')({
  server: {
    handlers: {
      POST: ({ request, context }) => startMetaConnect(request, appContext(context)),
      ANY: () => methodNotAllowed('POST'),
    },
  },
});
