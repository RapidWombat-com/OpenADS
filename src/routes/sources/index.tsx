import { createFileRoute } from '@tanstack/react-router';
import { SourcesPage } from '@/client/features/sources/SourcesPage';
import { validateSourcesSearch } from '@/client/lib/sources';

export const Route = createFileRoute('/sources/')({
  // `google` carries a fixed OAuth callback outcome; anything else is dropped.
  validateSearch: (search: Record<string, unknown>) => validateSourcesSearch(search),
  head: () => ({ meta: [{ title: 'Sources · OpenADS' }] }),
  component: SourcesPage,
});
