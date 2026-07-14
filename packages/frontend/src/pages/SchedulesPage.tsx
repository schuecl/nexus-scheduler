import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, List, ListItem, ListItemText, Stack, Typography } from "@mui/material";
import FactCheckOutlinedIcon from "@mui/icons-material/FactCheckOutlined";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import HighlightOffIcon from "@mui/icons-material/HighlightOff";
import { apiFetch } from "../api/client";

interface PendingSchedule {
  id: string;
  type: "ONE_TIME" | "RECURRING";
  createdAt: string;
  job: { id: string; name: string; projectId: string };
}

// Schedules themselves are created and managed from within a Job (see
// ProjectsPage's Jobs panel) — this page is the cross-Project view of
// what's actually waiting on *you*: the maker-checker approval queue for
// schedules attached to Team-shared or org-shared Projects
// (REQUIREMENTS §2.4). Private-Project schedules never show up here —
// they're auto-approved on creation.
export function SchedulesPage() {
  const queryClient = useQueryClient();

  const pendingQuery = useQuery({
    queryKey: ["schedules", "pending-approval"],
    queryFn: () => apiFetch<PendingSchedule[]>("/api/schedules/pending-approval"),
  });

  const approve = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/schedules/${id}/approve`, { method: "POST" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["schedules", "pending-approval"] }),
  });
  const reject = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/schedules/${id}/reject`, { method: "POST" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["schedules", "pending-approval"] }),
  });

  return (
    <Stack spacing={2}>
      <Typography variant="h4" sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <FactCheckOutlinedIcon fontSize="large" /> Schedule Approvals
      </Typography>
      <Typography color="text.secondary">
        Schedules attached to a shared Project need a second set of eyes before they run
        unattended. This is everything currently waiting on your approval (or an admin's).
      </Typography>

      {(approve.isError || reject.isError) && (
        <Alert severity="error">
          Action failed — you may not be an eligible approver for this schedule (its author can't
          self-approve unless there's no one else who can).
        </Alert>
      )}

      <List>
        {pendingQuery.data?.map((schedule) => (
          <ListItem
            key={schedule.id}
            divider
            secondaryAction={
              <Stack direction="row" spacing={1}>
                <Button
                  size="small"
                  variant="contained"
                  startIcon={<CheckCircleOutlineIcon fontSize="small" />}
                  disabled={approve.isPending || reject.isPending}
                  onClick={() => approve.mutate(schedule.id)}
                >
                  Approve
                </Button>
                <Button
                  size="small"
                  color="error"
                  startIcon={<HighlightOffIcon fontSize="small" />}
                  disabled={approve.isPending || reject.isPending}
                  onClick={() => reject.mutate(schedule.id)}
                >
                  Reject
                </Button>
              </Stack>
            }
          >
            <ListItemText
              primary={`${schedule.job.name} — ${schedule.type === "ONE_TIME" ? "one-time" : "recurring"}`}
              secondary={`Requested ${new Date(schedule.createdAt).toLocaleString()}`}
            />
          </ListItem>
        ))}
        {pendingQuery.data?.length === 0 && (
          <Typography color="text.secondary">Nothing pending approval right now.</Typography>
        )}
      </List>
    </Stack>
  );
}
