import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../../../lib/api.ts';
import { saveGoogleCredentials } from '../../../../../lib/google-ads/setup.ts';

export const Route = createFileRoute('/api/sources/google/credentials/')({
  server: {
    handlers: {
      POST: ({ request, context }) => saveGoogleCredentials(request, appContext(context)),
      ANY: () => methodNotAllowed('POST'),
    },
  },
});
