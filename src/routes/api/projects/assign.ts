import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../lib/api.ts';
import { assignAccounts } from '../../../lib/projects.ts';

export const Route = createFileRoute('/api/projects/assign')({
  server: {
    handlers: {
      POST: ({ request, context }) => assignAccounts(request, appContext(context)),
      ANY: () => methodNotAllowed('POST'),
    },
  },
});
