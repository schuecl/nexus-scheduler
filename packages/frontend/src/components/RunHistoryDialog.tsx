import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  Typography,
  type ChipProps,
} from "@mui/material";
import { apiFetch } from "../api/client";

interface Run {
  id: string;
  triggerType: "SCHEDULED" | "MANUAL";
  status: "PENDING" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED" | "SKIPPED";
  startedAt: string | null;
  completedAt: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  computedCost: string | null;
  output: string | null;
  errorMessage: string | null;
  createdAt: string;
}

const STATUS_COLOR: Record<Run["status"], ChipProps["color"]> = {
  PENDING: "default",
  RUNNING: "info",
  SUCCESS: "success",
  FAILED: "error",
  CANCELLED: "warning",
  SKIPPED: "warning",
};

// Run history + manual "Run Now" trigger for a Job (REQUIREMENTS §2.1/§8).
export function RunHistoryDialog({
  jobId,
  canRun,
  onClose,
}: {
  jobId: string;
  canRun: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  const runsQuery = useQuery({
    queryKey: ["jobs", jobId, "runs"],
    queryFn: () => apiFetch<Run[]>(`/api/jobs/${jobId}/runs`),
    refetchInterval: 5000, // cheap polling so in-flight runs update without a manual refresh
  });

  const runNow = useMutation({
    mutationFn: () => apiFetch(`/api/jobs/${jobId}/runs`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["jobs", jobId, "runs"] });
    },
  });

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>Run History</DialogTitle>
      <DialogContent>
        {runNow.isError && <Alert severity="error" sx={{ mb: 2 }}>Failed to start a run.</Alert>}
        <List dense>
          {runsQuery.data?.map((run) => (
            <Box key={run.id}>
              <ListItemButton onClick={() => setExpandedRunId(expandedRunId === run.id ? null : run.id)}>
                <ListItemText
                  primary={
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Chip size="small" label={run.status} color={STATUS_COLOR[run.status]} />
                      <Typography variant="body2">{run.triggerType === "MANUAL" ? "Manual" : "Scheduled"}</Typography>
                    </Stack>
                  }
                  secondary={new Date(run.createdAt).toLocaleString()}
                />
                {run.computedCost != null && (
                  <Typography variant="body2" color="text.secondary">
                    ${Number(run.computedCost).toFixed(4)}
                  </Typography>
                )}
              </ListItemButton>
              <Collapse in={expandedRunId === run.id} unmountOnExit>
                <Box sx={{ px: 2, pb: 2 }}>
                  <Typography variant="body2" color="text.secondary">
                    Started: {run.startedAt ? new Date(run.startedAt).toLocaleString() : "—"} · Completed:{" "}
                    {run.completedAt ? new Date(run.completedAt).toLocaleString() : "—"}
                  </Typography>
                  {(run.promptTokens != null || run.completionTokens != null) && (
                    <Typography variant="body2" color="text.secondary">
                      Tokens: {run.promptTokens ?? 0} prompt / {run.completionTokens ?? 0} completion
                    </Typography>
                  )}
                  {run.errorMessage && (
                    <Alert severity="error" sx={{ mt: 1, whiteSpace: "pre-wrap" }}>
                      {run.errorMessage}
                    </Alert>
                  )}
                  {run.output && (
                    <Box
                      component="pre"
                      sx={{
                        mt: 1,
                        p: 1.5,
                        bgcolor: "action.hover",
                        borderRadius: 1,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        maxHeight: 300,
                        overflow: "auto",
                      }}
                    >
                      {run.output}
                    </Box>
                  )}
                </Box>
              </Collapse>
            </Box>
          ))}
          {runsQuery.data?.length === 0 && (
            <Typography color="text.secondary">No runs yet.</Typography>
          )}
        </List>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        {canRun && (
          <Button variant="contained" disabled={runNow.isPending} onClick={() => runNow.mutate()}>
            Run Now
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
