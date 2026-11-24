import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../../lib/api.ts';
import { metaAccounts } from '../../../../lib/meta-ads/service.ts';
import { removeStaleAccountRequest } from '../../../../lib/sources.ts';

export const Route = createFileRoute('/api/sources/meta/remove-account')({
  server: {
    handlers: {
      POST: ({ request, context }) => removeStaleAccountRequest(request, appContext(context), 'meta_ads', metaAccounts),
      ANY: () => methodNotAllowed('POST'),
    },
  },
});
