import { createFileRoute } from '@tanstack/react-router';
import { ProjectsPage } from '@/client/features/projects/ProjectsPage';

export const Route = createFileRoute('/projects')({
  head: () => ({ meta: [{ title: 'Projects · OpenADS' }] }),
  component: ProjectsPage,
});
