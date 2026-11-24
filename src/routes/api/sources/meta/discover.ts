import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../../lib/api.ts';
import { rediscoverMeta } from '../../../../lib/meta-ads/service.ts';

export const Route = createFileRoute('/api/sources/meta/discover')({
  server: {
    handlers: {
      POST: ({ request, context }) => rediscoverMeta(request, appContext(context)),
      ANY: () => methodNotAllowed('POST'),
    },
  },
});
