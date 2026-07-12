import { useQuery } from "@tanstack/react-query";
import { List, ListItem, ListItemText, Typography, CircularProgress, Alert } from "@mui/material";
import { apiFetch } from "../api/client";

interface Job {
  id: string;
  name: string;
  agentId: string;
}

export function JobsPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["jobs"],
    queryFn: () => apiFetch<Job[]>("/api/jobs"),
  });

  return (
    <>
      <Typography variant="h4" gutterBottom>
        Jobs
      </Typography>
      {isLoading && <CircularProgress size={24} />}
      {isError && <Alert severity="error">Failed to load jobs.</Alert>}
      {data && (
        <List>
          {data.map((job) => (
            <ListItem key={job.id} divider>
              <ListItemText primary={job.name} secondary={`Agent: ${job.agentId}`} />
            </ListItem>
          ))}
          {data.length === 0 && <Typography color="text.secondary">No jobs yet.</Typography>}
        </List>
      )}
    </>
  );
}
