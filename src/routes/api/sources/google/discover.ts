import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../../lib/api.ts';
import { rediscoverGoogle } from '../../../../lib/google-ads/service.ts';

export const Route = createFileRoute('/api/sources/google/discover')({
  server: {
    handlers: {
      POST: ({ request, context }) => rediscoverGoogle(request, appContext(context)),
      ANY: () => methodNotAllowed('POST'),
    },
  },
});
