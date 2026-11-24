import { createFileRoute } from '@tanstack/react-router';
import { MetaAccountPickerPage } from '@/client/features/sources/MetaAccountPickerPage';
import { validatePickerSearch } from '@/client/lib/sources';

export const Route = createFileRoute('/sources/meta/accounts')({
  validateSearch: (search: Record<string, unknown>) => validatePickerSearch(search),
  head: () => ({ meta: [{ title: 'Meta ad accounts · OpenADS' }] }),
  component: MetaAccountPickerPage,
});
