import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../lib/api.ts';
import { renameProjectRequest } from '../../../lib/projects.ts';

export const Route = createFileRoute('/api/projects/rename')({
  server: {
    handlers: {
      POST: ({ request, context }) => renameProjectRequest(request, appContext(context)),
      ANY: () => methodNotAllowed('POST'),
    },
  },
});
