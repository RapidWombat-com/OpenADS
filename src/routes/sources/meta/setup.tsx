import { createFileRoute } from '@tanstack/react-router';
import { MetaSetupPage } from '@/client/features/setup/MetaSetupPage';
import { validateMetaSetupSearch } from '@/client/lib/meta';

export const Route = createFileRoute('/sources/meta/setup')({
  // `error` names a setup problem reported by the OAuth callback or a report.
  validateSearch: (search: Record<string, unknown>) => validateMetaSetupSearch(search),
  head: () => ({ meta: [{ title: 'Set up Meta Ads · OpenADS' }] }),
  component: MetaSetupPage,
});
