import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, Chip, Grid, List, ListItem, ListItemText, Stack, Typography } from "@mui/material";
import { apiFetch } from "../api/client";

interface RunSummary {
  id: string;
  status: "PENDING" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED" | "SKIPPED";
  triggerType: "SCHEDULED" | "MANUAL";
  createdAt: string;
  job: { id: string; name: string; projectId: string };
}

interface ScheduleSummary {
  id: string;
  nextFireAt: string | null;
  job: { id: string; name: string; projectId: string };
}

interface DashboardData {
  runCounts: Partial<Record<RunSummary["status"], number>>;
  recentRuns: RunSummary[];
  upcomingSchedules: ScheduleSummary[];
}

const STATUS_COLOR: Record<RunSummary["status"], "default" | "info" | "success" | "error" | "warning"> = {
  PENDING: "default",
  RUNNING: "info",
  SUCCESS: "success",
  FAILED: "error",
  CANCELLED: "warning",
  SKIPPED: "warning",
};

// Run counts, success/failure rates, and upcoming schedules (REQUIREMENTS
// §8), scoped to the Projects the current user can see.
export function DashboardPage() {
  const dashboardQuery = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => apiFetch<DashboardData>("/api/dashboard"),
  });

  const counts = dashboardQuery.data?.runCounts ?? {};
  const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
  const successRate = total > 0 ? Math.round(((counts.SUCCESS ?? 0) / total) * 100) : null;

  return (
    <Stack spacing={3}>
      <Typography variant="h4">Dashboard</Typography>

      <Grid container spacing={2}>
        {(["SUCCESS", "FAILED", "RUNNING", "PENDING"] as const).map((status) => (
          <Grid item xs={6} sm={3} key={status}>
            <Card variant="outlined">
              <CardContent>
                <Typography variant="overline" color="text.secondary">
                  {status}
                </Typography>
                <Typography variant="h4">{counts[status] ?? 0}</Typography>
              </CardContent>
            </Card>
          </Grid>
        ))}
        <Grid item xs={6} sm={3}>
          <Card variant="outlined">
            <CardContent>
              <Typography variant="overline" color="text.secondary">
                Success rate
              </Typography>
              <Typography variant="h4">{successRate === null ? "—" : `${successRate}%`}</Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <Grid container spacing={2}>
        <Grid item xs={12} md={6}>
          <Typography variant="h6" gutterBottom>
            Recent Runs
          </Typography>
          <List dense>
            {dashboardQuery.data?.recentRuns.map((run) => (
              <ListItem key={run.id}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mr: 1 }}>
                  <Chip size="small" label={run.status} color={STATUS_COLOR[run.status]} />
                </Stack>
                <ListItemText
                  primary={run.job.name}
                  secondary={`${run.triggerType === "MANUAL" ? "Manual" : "Scheduled"} · ${new Date(
                    run.createdAt,
                  ).toLocaleString()}`}
                />
              </ListItem>
            ))}
            {dashboardQuery.data?.recentRuns.length === 0 && (
              <Typography color="text.secondary">No runs yet.</Typography>
            )}
          </List>
        </Grid>

        <Grid item xs={12} md={6}>
          <Typography variant="h6" gutterBottom>
            Upcoming Schedules
          </Typography>
          <List dense>
            {dashboardQuery.data?.upcomingSchedules.map((schedule) => (
              <ListItem key={schedule.id}>
                <ListItemText
                  primary={schedule.job.name}
                  secondary={schedule.nextFireAt ? new Date(schedule.nextFireAt).toLocaleString() : "—"}
                />
              </ListItem>
            ))}
            {dashboardQuery.data?.upcomingSchedules.length === 0 && (
              <Typography color="text.secondary">No upcoming schedules.</Typography>
            )}
          </List>
        </Grid>
      </Grid>
    </Stack>
  );
}
