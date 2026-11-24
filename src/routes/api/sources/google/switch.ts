import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../../lib/api.ts';
import { resolveGoogleSwitch } from '../../../../lib/google-ads/service.ts';

export const Route = createFileRoute('/api/sources/google/switch')({
  server: {
    handlers: {
      POST: ({ request, context }) => resolveGoogleSwitch(request, appContext(context)),
      ANY: () => methodNotAllowed('POST'),
    },
  },
});
