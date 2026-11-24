import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../lib/api.ts';
import { createProject } from '../../../lib/projects.ts';

export const Route = createFileRoute('/api/projects/create')({
  server: {
    handlers: {
      POST: ({ request, context }) => createProject(request, appContext(context)),
      ANY: () => methodNotAllowed('POST'),
    },
  },
});
