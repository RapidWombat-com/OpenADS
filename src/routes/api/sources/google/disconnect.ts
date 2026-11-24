import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../../lib/api.ts';
import { disconnectGoogle } from '../../../../lib/google-ads/service.ts';

export const Route = createFileRoute('/api/sources/google/disconnect')({
  server: {
    handlers: {
      POST: ({ request, context }) => disconnectGoogle(request, appContext(context)),
      ANY: () => methodNotAllowed('POST'),
    },
  },
});
