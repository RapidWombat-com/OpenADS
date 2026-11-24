import { createFileRoute } from '@tanstack/react-router';
import { GoogleSetupPage } from '@/client/features/setup/GoogleSetupPage';
import { validateSetupSearch } from '@/client/lib/sources';

export const Route = createFileRoute('/sources/google/setup')({
  // `error` names a setup problem reported by the OAuth callback or a report.
  validateSearch: (search: Record<string, unknown>) => validateSetupSearch(search),
  head: () => ({ meta: [{ title: 'Set up Google Ads · OpenADS' }] }),
  component: GoogleSetupPage,
});
