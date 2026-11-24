import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../../../lib/api.ts';
import { deleteMetaCredentials } from '../../../../../lib/meta-ads/setup.ts';

export const Route = createFileRoute('/api/sources/meta/credentials/delete')({
  server: {
    handlers: {
      POST: ({ request, context }) => deleteMetaCredentials(request, appContext(context)),
      ANY: () => methodNotAllowed('POST'),
    },
  },
});
