import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../../lib/api.ts';
import { metaSetup, saveMetaSetup } from '../../../../lib/meta-ads/setup.ts';

export const Route = createFileRoute('/api/sources/meta/setup')({
  server: {
    handlers: {
      GET: ({ context }) => metaSetup(appContext(context)),
      POST: ({ request, context }) => saveMetaSetup(request, appContext(context)),
      ANY: () => methodNotAllowed('GET, HEAD, POST'),
    },
  },
});
