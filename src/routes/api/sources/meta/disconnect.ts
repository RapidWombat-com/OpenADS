import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../../lib/api.ts';
import { disconnectMeta } from '../../../../lib/meta-ads/service.ts';

export const Route = createFileRoute('/api/sources/meta/disconnect')({
  server: {
    handlers: {
      POST: ({ request, context }) => disconnectMeta(request, appContext(context)),
      ANY: () => methodNotAllowed('POST'),
    },
  },
});
