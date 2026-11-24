import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../../lib/api.ts';
import { metaAccounts, selectMetaAccounts } from '../../../../lib/meta-ads/service.ts';

export const Route = createFileRoute('/api/sources/meta/accounts')({
  server: {
    handlers: {
      GET: ({ context }) => metaAccounts(appContext(context)),
      POST: ({ request, context }) => selectMetaAccounts(request, appContext(context)),
      ANY: () => methodNotAllowed('GET, HEAD, POST'),
    },
  },
});
