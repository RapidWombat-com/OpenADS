import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../../lib/api.ts';
import { startGoogleConnect } from '../../../../lib/google-ads/service.ts';

// POST only (same-origin fetch): creating OAuth state is a state change. The
// browser then navigates to the returned Google URL, so the CSP form-action
// stays 'self' (a form POST answered with a cross-origin redirect would need it widened).
export const Route = createFileRoute('/api/oauth/google/start')({
  server: {
    handlers: {
      POST: ({ request, context }) => startGoogleConnect(request, appContext(context)),
      ANY: () => methodNotAllowed('POST'),
    },
  },
});
