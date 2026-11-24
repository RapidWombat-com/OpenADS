import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../../../lib/api.ts';
import { deleteGoogleCredentials } from '../../../../../lib/google-ads/setup.ts';

export const Route = createFileRoute('/api/sources/google/credentials/delete')({
  server: {
    handlers: {
      POST: ({ request, context }) => deleteGoogleCredentials(request, appContext(context)),
      ANY: () => methodNotAllowed('POST'),
    },
  },
});
