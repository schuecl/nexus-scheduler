import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  Typography,
} from "@mui/material";
import { apiFetch } from "../api/client";

interface WebhookDestination {
  id: string;
  name: string;
  url: string;
  active: boolean;
}

// Which admin-allow-listed destinations (§2.2) get this Job's run
// results. The available options come entirely from the allow-list — a
// user can pick which of *those* to use, never type in a URL.
export function JobWebhooksDialog({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const allDestinationsQuery = useQuery({
    queryKey: ["webhook-destinations"],
    queryFn: () => apiFetch<WebhookDestination[]>("/api/webhook-destinations"),
  });
  const attachedQuery = useQuery({
    queryKey: ["jobs", jobId, "webhooks"],
    queryFn: () => apiFetch<WebhookDestination[]>(`/api/jobs/${jobId}/webhooks`),
  });

  useEffect(() => {
    if (attachedQuery.data) {
      setSelected(new Set(attachedQuery.data.map((d) => d.id)));
    }
  }, [attachedQuery.data]);

  const save = useMutation({
    mutationFn: () =>
      apiFetch(`/api/jobs/${jobId}/webhooks`, {
        method: "PUT",
        body: JSON.stringify({ webhookDestinationIds: [...selected] }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["jobs", jobId, "webhooks"] });
      onClose();
    },
  });

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Webhook Notifications</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Every run of this Job (success or failure) will POST its result to the checked
          destinations, signed so the receiver can verify it came from Nexus Scheduler.
        </Typography>
        <Stack spacing={1}>
          {allDestinationsQuery.data?.map((destination) => (
            <FormControlLabel
              key={destination.id}
              control={
                <Checkbox checked={selected.has(destination.id)} onChange={() => toggle(destination.id)} />
              }
              label={`${destination.name} (${destination.url})`}
            />
          ))}
          {allDestinationsQuery.data?.length === 0 && (
            <Typography color="text.secondary">
              No webhook destinations exist yet — an admin needs to add one first.
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
