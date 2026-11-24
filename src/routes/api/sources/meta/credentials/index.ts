import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../../../lib/api.ts';
import { saveMetaCredentials } from '../../../../../lib/meta-ads/setup.ts';

export const Route = createFileRoute('/api/sources/meta/credentials/')({
  server: {
    handlers: {
      POST: ({ request, context }) => saveMetaCredentials(request, appContext(context)),
      ANY: () => methodNotAllowed('POST'),
    },
  },
});
