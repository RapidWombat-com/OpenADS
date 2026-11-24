import { createFileRoute } from '@tanstack/react-router';
import { DashboardPage } from '@/client/features/dashboard/DashboardPage';
import { validateDashboardSearch } from '@/client/lib/search';

export const Route = createFileRoute('/')({
  // Unknown or invalid filters are dropped; the API is only ever called with valid ones.
  validateSearch: (search: Record<string, unknown>) => validateDashboardSearch(search),
  server: {
    handlers: {
      GET: ({ request, next }) => {
        if (request.headers.get('Accept')?.includes('text/html')) return next();
        return Response.json({
          service: 'OpenADS',
          reporting: '/api/campaigns.json',
          filters: ['platform=google|meta', 'start=YYYY-MM-DD', 'end=YYYY-MM-DD', 'project=<id>|unassigned', 'account=<id> (repeatable)'],
          projects: '/api/projects.json',
          note: 'Live read-only reporting. Provider availability is reported independently; unavailable sources have no totals.',
        });
      },
    },
  },
  component: DashboardPage,
});
