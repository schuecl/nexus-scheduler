import { Typography } from "@mui/material";

export function DashboardPage() {
  return (
    <>
      <Typography variant="h4" gutterBottom>
        Dashboard
      </Typography>
      <Typography color="text.secondary">
        Run counts, success/failure rates, and upcoming schedules land here (REQUIREMENTS §8).
      </Typography>
    </>
  );
}
