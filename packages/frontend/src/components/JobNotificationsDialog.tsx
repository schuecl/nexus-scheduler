import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
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
import SaveIcon from "@mui/icons-material/Save";
import NotificationsIcon from "@mui/icons-material/Notifications";
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
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <NotificationsIcon /> Email Notifications
      </DialogTitle>
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
        {save.isError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {save.error instanceof Error ? save.error.message : "Could not save notification settings."}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" startIcon={<SaveIcon />} disabled={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
