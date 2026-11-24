import { createFileRoute } from '@tanstack/react-router';
import { appContext, methodNotAllowed } from '../../../../lib/api.ts';
import { saveConversionSetting } from '../../../../lib/meta-ads/setup.ts';

export const Route = createFileRoute('/api/sources/meta/conversion')({
  server: {
    handlers: {
      POST: ({ request, context }) => saveConversionSetting(request, appContext(context)),
      ANY: () => methodNotAllowed('POST'),
    },
  },
});
