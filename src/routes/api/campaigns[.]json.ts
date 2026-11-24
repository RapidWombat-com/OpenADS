import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../lib/api.ts';
import { googleReportSource } from '../../lib/google-ads/service.ts';
import { metaReportSource } from '../../lib/meta-ads/service.ts';
import { reportTimeZones, resolveReportScope } from '../../lib/projects.ts';
import { campaignsResponse } from '../../lib/reporting.ts';

export const Route = createFileRoute('/api/campaigns.json')({
  server: {
    handlers: {
      GET: ({ request, context }) => {
        const ctx = appContext(context);
        // Each source: the requester's workspace grant and selected accounts (D1),
        // narrowed to the project/account filter when one is given.
        return campaignsResponse(new URL(request.url), {
          google: (window, scope) => googleReportSource(ctx, window, scope),
          meta: (window, scope) => metaReportSource(ctx, window, scope),
          scope: filter => resolveReportScope(ctx, filter),
          timeZones: (scope, platforms) => reportTimeZones(ctx, scope, platforms),
        });
      },
      ANY: () => methodNotAllowed('GET, HEAD'),
    },
  },
});
