import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../lib/api.ts';
import { projectsSummary } from '../../lib/projects.ts';

export const Route = createFileRoute('/api/projects.json')({
  server: {
    handlers: {
      GET: ({ context }) => projectsSummary(appContext(context)),
      ANY: () => methodNotAllowed('GET, HEAD'),
    },
  },
});
