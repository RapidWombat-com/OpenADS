import { createFileRoute } from '@tanstack/react-router';
import { AccountPickerPage } from '@/client/features/sources/AccountPickerPage';
import { validatePickerSearch } from '@/client/lib/sources';

export const Route = createFileRoute('/sources/google/accounts')({
  validateSearch: (search: Record<string, unknown>) => validatePickerSearch(search),
  head: () => ({ meta: [{ title: 'Google Ads accounts · OpenADS' }] }),
  component: AccountPickerPage,
});
