import { Typography } from "@mui/material";

export function SchedulesPage() {
  return (
    <>
      <Typography variant="h4" gutterBottom>
        Schedules
      </Typography>
      <Typography color="text.secondary">
        One-time and recurring schedules, interval pickers, pause/resume, and the approval queue
        (REQUIREMENTS §2.4) land here.
      </Typography>
    </>
  );
}
