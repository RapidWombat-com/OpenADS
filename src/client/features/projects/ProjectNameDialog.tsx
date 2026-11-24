import { useId, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { createdMessage, safeMessage, renamedMessage } from "@/client/lib/feedback";
import { Button } from "@/client/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";
import { Input } from "@/client/components/ui/input";
import {
  cleanProjectName,
  createProject,
  MAX_PROJECT_NAME,
  renameProject,
  type ProjectsSummary,
} from "@/client/lib/projects";
import { SourcesError } from "@/client/lib/sources";
import { useProjectsUpdated } from "./queries";

/**
 * Create a project, or rename one (`project` given). The server re-checks the
 * name and answers 409 when another project already uses it.
 */
export function ProjectNameDialog({
  open,
  onOpenChange,
  project,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project?: { id: string; name: string };
  onSaved?: (saved: { id: string; name: string }) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* Remounted on every open, so the field starts from the current name. */}
        {open ? <NameForm project={project} onDone={() => onOpenChange(false)} onSaved={onSaved} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function NameForm({
  project,
  onDone,
  onSaved,
}: {
  project?: { id: string; name: string };
  onDone: () => void;
  onSaved?: (saved: { id: string; name: string }) => void;
}) {
  const id = useId();
  const updated = useProjectsUpdated();
  const [value, setValue] = useState(project?.name ?? "");
  const [touched, setTouched] = useState(false);
  const name = cleanProjectName(value);
  const invalid = name.length === 0 || name.length > MAX_PROJECT_NAME;
  const save = useMutation({
    mutationFn: async (): Promise<{ summary: ProjectsSummary; saved: { id: string; name: string } }> => {
      if (project) return { summary: await renameProject(project.id, name), saved: { id: project.id, name } };
      const summary = await createProject(name);
      return { summary, saved: summary.project };
    },
    onSuccess: ({ summary, saved }) => {
      updated(summary, { reports: false });
      onDone();
      toast.success(project ? renamedMessage(project.name, saved.name) : createdMessage(saved.name));
      onSaved?.(saved);
    },
    onError: (error) => toast.error(safeMessage(error, "The project was not saved. Try again in a moment.")),
  });
  const error = save.error instanceof SourcesError
    ? save.error.message
    : save.error
      ? "The project was not saved. Try again in a moment."
      : touched && invalid
        ? `Enter a name of 1 to ${MAX_PROJECT_NAME} characters.`
        : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!invalid && !save.isPending) save.mutate();
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{project ? "Rename project" : "New project"}</DialogTitle>
        <DialogDescription>
          {project
            ? "Everyone in this workspace sees the new name."
            : "A project groups the ad accounts of one brand or client, so the dashboard can report on them together."}
        </DialogDescription>
      </DialogHeader>
      <div>
        <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted-foreground">
          Project name
        </label>
        <Input
          id={id}
          value={value}
          autoFocus
          maxLength={MAX_PROJECT_NAME * 2}
          autoComplete="off"
          placeholder="e.g. RapidWombat"
          onChange={(event) => {
            setValue(event.target.value);
            if (save.isError) save.reset();
          }}
          onBlur={() => setTouched(true)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
        />
        {error ? (
          <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" pending={save.isPending} disabled={project ? name === project.name : false}>
          {project ? "Save name" : "Create project"}
        </Button>
      </DialogFooter>
    </form>
  );
}
