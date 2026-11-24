import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../../lib/api.ts';
import { campaignDetailResponse } from '../../../../lib/campaign-detail.ts';

export const Route = createFileRoute('/api/campaigns/$platform/{$campaignId}.json')({
  server: {
    handlers: {
      // One campaign of one selected account of the requester's workspace (docs/dev.md).
      GET: ({ request, context, params }) =>
        campaignDetailResponse(appContext(context), new URL(request.url), params.platform, params.campaignId),
      ANY: () => methodNotAllowed('GET, HEAD'),
    },
  },
});
