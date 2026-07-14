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
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <HistoryIcon /> Run History
      </DialogTitle>
      <DialogContent>
        {runNow.isError && <Alert severity="error" sx={{ mb: 2 }}>Failed to start a run.</Alert>}
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
            <Typography color="text.secondary">No runs yet.</Typography>
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
