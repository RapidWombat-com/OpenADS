import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../../lib/api.ts';
import { googleAccounts, selectGoogleAccounts } from '../../../../lib/google-ads/service.ts';

export const Route = createFileRoute('/api/sources/google/accounts')({
  server: {
    handlers: {
      GET: ({ context }) => googleAccounts(appContext(context)),
      POST: ({ request, context }) => selectGoogleAccounts(request, appContext(context)),
      ANY: () => methodNotAllowed('GET, HEAD, POST'),
    },
  },
});
