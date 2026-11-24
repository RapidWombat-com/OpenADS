import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../../lib/api.ts';
import { googleSetup, saveGoogleSetup } from '../../../../lib/google-ads/setup.ts';

export const Route = createFileRoute('/api/sources/google/setup')({
  server: {
    handlers: {
      GET: ({ context }) => googleSetup(appContext(context)),
      POST: ({ request, context }) => saveGoogleSetup(request, appContext(context)),
      ANY: () => methodNotAllowed('GET, HEAD, POST'),
    },
  },
});
