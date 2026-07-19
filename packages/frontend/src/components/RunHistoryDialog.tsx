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
} from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PictureAsPdfIcon from "@mui/icons-material/PictureAsPdf";
import HistoryIcon from "@mui/icons-material/History";
import CancelOutlinedIcon from "@mui/icons-material/CancelOutlined";
import AttachFileIcon from "@mui/icons-material/AttachFile";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link as RouterLink } from "react-router-dom";
import { apiFetch } from "../api/client";
import { RunStatusIcon, RUN_STATUS_COLOR, type RunStatus } from "./RunStatusIcon";

interface Run {
  id: string;
  triggerType: "SCHEDULED" | "MANUAL";
  status: RunStatus;
  startedAt: string | null;
  completedAt: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  computedCost: string | null;
  output: string | null;
  errorMessage: string | null;
  createdAt: string;
}

interface RunArtifact {
  id: string;
  kind: string;
  filename: string;
  mimeType: string;
  createdAt: string;
}

// Artifacts exist only for runs of jobs with attachments (#109), so the
// query lives in its own component mounted per-expansion — no fetch at
// all for the common artifact-less run.
function RunArtifactsList({ runId, runStatus }: { runId: string; runStatus: RunStatus }) {
  // The worker writes artifacts only when the run reaches a terminal
  // state. If the row is expanded while still PENDING/RUNNING, the empty
  // list must not be cached forever — keying on terminal-ness makes the
  // 5s run poll's status flip refetch this query, so the searchable-PDF
  // links appear the moment the run finishes without collapse/reopen.
  const terminal =
    runStatus === "SUCCESS" || runStatus === "FAILED" || runStatus === "CANCELLED" || runStatus === "SKIPPED";
  const artifactsQuery = useQuery({
    queryKey: ["runs", runId, "artifacts", terminal],
    queryFn: () => apiFetch<RunArtifact[]>(`/api/runs/${runId}/artifacts`),
  });
  if (!artifactsQuery.data?.length) {
    return null;
  }
  return (
    <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
      {artifactsQuery.data.map((artifact) => (
        <Button
          key={artifact.id}
          size="small"
          variant="outlined"
          startIcon={<AttachFileIcon fontSize="small" />}
          component="a"
          href={`/api/runs/${runId}/artifacts/${artifact.id}`}
          target="_blank"
          rel="noopener"
        >
          {artifact.filename}
        </Button>
      ))}
    </Stack>
  );
}

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

  // Cancellation (issue #111) only ever *requests* — the Worker is the
  // one that actually marks a Run CANCELLED, on its own timing (either
  // right away if it's still queued, or once an in-flight agent call
  // aborts) — so this just re-polls; the 5s refetchInterval above picks
  // up the eventual status change same as any other in-flight Run.
  const cancelRun = useMutation({
    mutationFn: (runId: string) => apiFetch(`/api/runs/${runId}/cancel`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["jobs", jobId, "runs"] });
    },
  });

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <HistoryIcon /> Run History
      </DialogTitle>
      <DialogContent>
        {runNow.isError && <Alert severity="error" sx={{ mb: 2 }}>Failed to start a run.</Alert>}
        {cancelRun.isError && <Alert severity="error" sx={{ mb: 2 }}>Failed to cancel the run.</Alert>}
        <List dense>
          {runsQuery.data?.map((run) => (
            <Box key={run.id}>
              <ListItemButton onClick={() => setExpandedRunId(expandedRunId === run.id ? null : run.id)}>
                <ListItemText
                  primary={
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Chip
                        size="small"
                        icon={<RunStatusIcon status={run.status} />}
                        label={run.status}
                        color={RUN_STATUS_COLOR[run.status]}
                      />
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
                  <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.5 }}>
                    <Typography variant="body2" color="text.secondary">
                      Started: {run.startedAt ? new Date(run.startedAt).toLocaleString() : "—"} · Completed:{" "}
                      {run.completedAt ? new Date(run.completedAt).toLocaleString() : "—"}
                    </Typography>
                    <Stack direction="row" spacing={1}>
                      {canRun && (run.status === "PENDING" || run.status === "RUNNING") && (
                        <Button
                          size="small"
                          color="error"
                          startIcon={<CancelOutlinedIcon fontSize="small" />}
                          disabled={cancelRun.isPending}
                          onClick={() => cancelRun.mutate(run.id)}
                        >
                          Cancel
                        </Button>
                      )}
                      <Button
                        size="small"
                        startIcon={<PictureAsPdfIcon fontSize="small" />}
                        component="a"
                        href={`/api/runs/${run.id}/pdf`}
                        target="_blank"
                        rel="noopener"
                      >
                        Download PDF
                      </Button>
                    </Stack>
                  </Stack>
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
                  <RunArtifactsList runId={run.id} runStatus={run.status} />
                  {run.output && (
                    <Box
                      sx={{
                        mt: 1,
                        p: 1.5,
                        bgcolor: "action.hover",
                        borderRadius: 1,
                        maxHeight: 300,
                        overflow: "auto",
                        fontSize: "0.875rem",
                        "& > :first-of-type": { mt: 0 },
                        "& > :last-child": { mb: 0 },
                        "& p": { my: 1 },
                        "& pre": {
                          bgcolor: "background.paper",
                          borderRadius: 1,
                          p: 1,
                          overflow: "auto",
                        },
                        "& code": {
                          fontFamily: "monospace",
                          bgcolor: "background.paper",
                          borderRadius: 0.5,
                          px: 0.5,
                        },
                        "& pre code": { bgcolor: "transparent", p: 0 },
                        "& table": { borderCollapse: "collapse" },
                        "& th, & td": {
                          border: "1px solid",
                          borderColor: "divider",
                          px: 1,
                          py: 0.5,
                        },
                        "& blockquote": {
                          borderLeft: "3px solid",
                          borderColor: "divider",
                          m: 0,
                          pl: 1.5,
                          color: "text.secondary",
                        },
                      }}
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{run.output}</ReactMarkdown>
                    </Box>
                  )}
                </Box>
              </Collapse>
            </Box>
          ))}
          {runsQuery.data?.length === 0 && (
            <Typography color="text.secondary">
              No runs yet. Runs appear here after this Job executes —{" "}
              {canRun ? 'use "Run Now" below, or attach a schedule to run it automatically.' : "it runs on-demand or on a schedule."}{" "}
              See <RouterLink to="/help/runs">Runs, output & PDF reports</RouterLink>.
            </Typography>
          )}
        </List>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        {canRun && (
          <Button
            variant="contained"
            startIcon={<PlayArrowIcon />}
            disabled={runNow.isPending}
            onClick={() => runNow.mutate()}
          >
            Run Now
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
