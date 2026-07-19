import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, Chip, Grid, List, ListItem, ListItemText, Stack, Typography } from "@mui/material";
import HistoryIcon from "@mui/icons-material/History";
import UpcomingIcon from "@mui/icons-material/Upcoming";
import TrendingUpIcon from "@mui/icons-material/TrendingUp";
import DashboardOutlinedIcon from "@mui/icons-material/DashboardOutlined";
import { apiFetch } from "../api/client";
import { RunStatusIcon, RUN_STATUS_COLOR, type RunStatus } from "../components/RunStatusIcon";

interface RunSummary {
  id: string;
  status: RunStatus;
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

// Run counts, success/failure rates, and upcoming schedules (REQUIREMENTS
// §8), scoped to the Projects the current user can see.
export function DashboardPage() {
  const dashboardQuery = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => apiFetch<DashboardData>("/api/dashboard"),
  });

  const counts = dashboardQuery.data?.runCounts ?? {};
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const successRate = total > 0 ? Math.round(((counts.SUCCESS ?? 0) / total) * 100) : null;

  return (
    <Stack spacing={3}>
      <Typography variant="h4" sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <DashboardOutlinedIcon fontSize="large" /> Dashboard
      </Typography>

      <Grid container spacing={2}>
        {(["SUCCESS", "FAILED", "RUNNING", "PENDING"] as const).map((status) => (
          <Grid item xs={6} sm={3} key={status}>
            <Card variant="outlined">
              <CardContent>
                <Stack direction="row" spacing={1} alignItems="center">
                  <RunStatusIcon status={status} />
                  <Typography variant="overline" color="text.secondary">
                    {status}
                  </Typography>
                </Stack>
                <Typography variant="h4">{counts[status] ?? 0}</Typography>
              </CardContent>
            </Card>
          </Grid>
        ))}
        <Grid item xs={6} sm={3}>
          <Card variant="outlined">
            <CardContent>
              <Stack direction="row" spacing={1} alignItems="center">
                <TrendingUpIcon fontSize="small" color="primary" />
                <Typography variant="overline" color="text.secondary">
                  Success rate
                </Typography>
              </Stack>
              <Typography variant="h4">{successRate === null ? "—" : `${successRate}%`}</Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <Grid container spacing={2}>
        <Grid item xs={12} md={6}>
          <Typography variant="h6" gutterBottom sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <HistoryIcon fontSize="small" /> Recent Runs
          </Typography>
          <List dense>
            {dashboardQuery.data?.recentRuns.map((run) => (
              <ListItem key={run.id}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mr: 1 }}>
                  <Chip
                    size="small"
                    icon={<RunStatusIcon status={run.status} />}
                    label={run.status}
                    color={RUN_STATUS_COLOR[run.status]}
                  />
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
          <Typography variant="h6" gutterBottom sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <UpcomingIcon fontSize="small" /> Upcoming Schedules
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
