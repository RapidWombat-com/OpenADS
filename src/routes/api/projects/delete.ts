import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../lib/api.ts';
import { deleteProjectRequest } from '../../../lib/projects.ts';

export const Route = createFileRoute('/api/projects/delete')({
  server: {
    handlers: {
      POST: ({ request, context }) => deleteProjectRequest(request, appContext(context)),
      ANY: () => methodNotAllowed('POST'),
    },
  },
});
