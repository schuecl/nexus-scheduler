import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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

export interface JobNotificationSettings {
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
  attachPdfToEmail: boolean;
}

// Per-job email notification preferences (§2.2) — sent to the Job owner
// on completion/failure, independent of admin-allow-listed webhook
// delivery (JobWebhooksDialog). Seeded from the Job row already loaded
// by the parent list, no extra fetch needed.
export function JobNotificationsDialog({
  jobId,
  initial,
  onClose,
}: {
  jobId: string;
  initial: JobNotificationSettings;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState<JobNotificationSettings>(initial);

  const save = useMutation({
    mutationFn: () =>
      apiFetch(`/api/jobs/${jobId}/notifications`, {
        method: "PUT",
        body: JSON.stringify(settings),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      onClose();
    },
  });

  const notifyEnabled = settings.notifyOnSuccess || settings.notifyOnFailure;

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Email Notifications</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Sent to the Job owner's email address when a run finishes.
        </Typography>
        <Stack spacing={1}>
          <FormControlLabel
            control={
              <Checkbox
                checked={settings.notifyOnSuccess}
                onChange={(e) => setSettings((s) => ({ ...s, notifyOnSuccess: e.target.checked }))}
              />
            }
            label="Email me when a run succeeds"
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={settings.notifyOnFailure}
                onChange={(e) => setSettings((s) => ({ ...s, notifyOnFailure: e.target.checked }))}
              />
            }
            label="Email me when a run fails"
          />
          <FormControlLabel
            control={
              <Checkbox
                disabled={!notifyEnabled}
                checked={settings.attachPdfToEmail}
                onChange={(e) => setSettings((s) => ({ ...s, attachPdfToEmail: e.target.checked }))}
              />
            }
            label="Attach the run's PDF report instead of inline text"
          />
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
