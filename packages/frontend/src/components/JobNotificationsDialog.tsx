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
  TextField,
  Typography,
} from "@mui/material";
import SaveIcon from "@mui/icons-material/Save";
import NotificationsIcon from "@mui/icons-material/Notifications";
import { apiFetch } from "../api/client";

export interface JobNotificationSettings {
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
  attachPdfToEmail: boolean;
  ccRecipients: string[];
  emailSubjectTemplate: string | null;
  emailBodyTemplate: string | null;
}

const MAX_CC_RECIPIENTS = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_LENGTH = 5000;
const TEMPLATE_PLACEHOLDERS =
  "{{job_name}}, {{status}}, {{run_id}}, {{started_at}}, {{completed_at}}, {{output}}, " +
  "{{error_message}}, {{owner_email}}, {{owner_full_name}}, {{date}}, {{datetime}}";

function parseCcRecipients(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
  const [ccRecipientsText, setCcRecipientsText] = useState(initial.ccRecipients.join(", "));
  const [subjectText, setSubjectText] = useState(initial.emailSubjectTemplate ?? "");
  const [bodyText, setBodyText] = useState(initial.emailBodyTemplate ?? "");

  const ccRecipients = parseCcRecipients(ccRecipientsText);
  const invalidCcRecipients = ccRecipients.filter((r) => !EMAIL_RE.test(r));
  const tooManyCcRecipients = ccRecipients.length > MAX_CC_RECIPIENTS;
  const ccRecipientsError = tooManyCcRecipients
    ? `No more than ${MAX_CC_RECIPIENTS} additional recipients are allowed.`
    : invalidCcRecipients.length > 0
      ? `Not a valid email address: ${invalidCcRecipients.join(", ")}`
      : null;

  const subjectError =
    subjectText.length > MAX_SUBJECT_LENGTH
      ? `Subject must be ${MAX_SUBJECT_LENGTH} characters or fewer.`
      : /[\r\n]/.test(subjectText)
        ? "Subject cannot contain line breaks."
        : null;
  const bodyError =
    bodyText.length > MAX_BODY_LENGTH ? `Body must be ${MAX_BODY_LENGTH} characters or fewer.` : null;

  const hasError = ccRecipientsError !== null || subjectError !== null || bodyError !== null;

  const save = useMutation({
    mutationFn: () =>
      apiFetch(`/api/jobs/${jobId}/notifications`, {
        method: "PUT",
        body: JSON.stringify({
          ...settings,
          ccRecipients,
          emailSubjectTemplate: subjectText.trim() || null,
          emailBodyTemplate: bodyText.trim() || null,
        }),
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
          Sent to the Job owner's email address when a run finishes, plus any additional
          recipients below.
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
          <TextField
            label="Additional recipients (comma-separated emails)"
            value={ccRecipientsText}
            onChange={(e) => setCcRecipientsText(e.target.value)}
            error={ccRecipientsError !== null}
            helperText={ccRecipientsError ?? `Up to ${MAX_CC_RECIPIENTS} additional recipients.`}
            fullWidth
          />
          <Typography variant="subtitle2" sx={{ mt: 1 }}>
            Custom message (optional)
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Leave blank to use the default subject/body. Available placeholders: {TEMPLATE_PLACEHOLDERS}.
          </Typography>
          <TextField
            label="Custom subject"
            value={subjectText}
            onChange={(e) => setSubjectText(e.target.value)}
            error={subjectError !== null}
            helperText={subjectError ?? `${subjectText.length}/${MAX_SUBJECT_LENGTH}`}
            fullWidth
          />
          <TextField
            label="Custom body (Markdown supported)"
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
            error={bodyError !== null}
            helperText={bodyError ?? `${bodyText.length}/${MAX_BODY_LENGTH}`}
            multiline
            minRows={4}
            fullWidth
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
        <Button
          variant="contained"
          startIcon={<SaveIcon />}
          disabled={save.isPending || hasError}
          onClick={() => save.mutate()}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
