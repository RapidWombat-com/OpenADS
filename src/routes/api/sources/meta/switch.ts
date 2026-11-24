import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../../lib/api.ts';
import { resolveMetaSwitch } from '../../../../lib/meta-ads/service.ts';

export const Route = createFileRoute('/api/sources/meta/switch')({
  server: {
    handlers: {
      POST: ({ request, context }) => resolveMetaSwitch(request, appContext(context)),
      ANY: () => methodNotAllowed('POST'),
    },
  },
});
