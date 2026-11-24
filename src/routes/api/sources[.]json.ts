import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../lib/api.ts';
import { sourcesSummary } from '../../lib/sources.ts';

export const Route = createFileRoute('/api/sources.json')({
  server: {
    handlers: {
      GET: ({ context }) => sourcesSummary(appContext(context)),
      ANY: () => methodNotAllowed('GET, HEAD'),
    },
  },
});
