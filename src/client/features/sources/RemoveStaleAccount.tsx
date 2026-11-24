import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { safeMessage } from "@/client/lib/feedback";
import { Button } from "@/client/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/client/components/ui/alert-dialog";

/**
 * Explicit removal of an account the last refresh did not list. Rediscovery
 * never deletes a selected or project-assigned account on its own; an admin
 * lets it go here (confirm, then a same-origin POST to `/api/sources/…/remove-account`).
 */
export function RemoveStaleAccount<T>({
  name,
  disabled,
  remove,
  onRemoved,
}: {
  name: string;
  disabled?: boolean;
  remove: () => Promise<T>;
  onRemoved: (next: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const mutation = useMutation({
    mutationFn: remove,
    onSuccess: (next) => {
      onRemoved(next);
      setOpen(false);
      toast.success(`Removed ${name}`);
    },
    onError: (error) => toast.error(safeMessage(error, "The account was not removed. Try again.")),
  });
  return (
    <>
      <Button variant="outline" size="xs" disabled={disabled} onClick={() => setOpen(true)}>
        Remove
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => { if (!mutation.isPending) setOpen(next); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The last refresh did not list this account. Removing it deletes it from this workspace, together with its
              selection and project assignment. If it shows up again in a later refresh, it comes back unselected and
              unassigned.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" pending={mutation.isPending} onClick={() => mutation.mutate()}>
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
