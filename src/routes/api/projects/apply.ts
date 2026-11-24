import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../lib/api.ts';
import { applyProjectGroups } from '../../../lib/projects.ts';

export const Route = createFileRoute('/api/projects/apply')({
  server: {
    handlers: {
      POST: ({ request, context }) => applyProjectGroups(request, appContext(context)),
      ANY: () => methodNotAllowed('POST'),
    },
  },
});
