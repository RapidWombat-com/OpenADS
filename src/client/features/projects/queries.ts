import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { fetchProjects, getLastProject, type ProjectsSummary } from "@/client/lib/projects";

export const PROJECTS_KEY = ["projects"] as const;

/** Every member reads the same list; changes come from this browser, so it can stay fresh for a while. */
export function useProjects() {
  return useQuery({ queryKey: PROJECTS_KEY, queryFn: fetchProjects, staleTime: 60_000 });
}

/**
 * After a change: the new list and, when accounts moved (`reports`), every
 * report, since a project's scope changed. Creating or renaming a project
 * changes no scope, so no live report is requested again for it.
 */
export function useProjectsUpdated() {
  const client = useQueryClient();
  return (summary: ProjectsSummary, options: { reports?: boolean } = {}) => projectsUpdated(client, summary, options);
}

export function projectsUpdated(client: QueryClient, summary: ProjectsSummary, { reports = true }: { reports?: boolean } = {}) {
  const { role, projects, accounts } = summary;
  client.setQueryData(PROJECTS_KEY, { role, projects, accounts });
  if (reports) void client.invalidateQueries({ queryKey: ["campaigns"] });
}

/** The remembered project, read after mount so SSR and the first render agree. */
export function useLastProject(): string | null | undefined {
  const [value, setValue] = useState<string | null | undefined>(undefined);
  useEffect(() => setValue(getLastProject()), []);
  return value;
}
