import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../../lib/api.ts';
import { googleAccounts } from '../../../../lib/google-ads/service.ts';
import { removeStaleAccountRequest } from '../../../../lib/sources.ts';

export const Route = createFileRoute('/api/sources/google/remove-account')({
  server: {
    handlers: {
      POST: ({ request, context }) => removeStaleAccountRequest(request, appContext(context), 'google_ads', googleAccounts),
      ANY: () => methodNotAllowed('POST'),
    },
  },
});
