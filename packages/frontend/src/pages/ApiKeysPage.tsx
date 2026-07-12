import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { apiFetch } from "../api/client";

interface ApiKeySummary {
  id: string;
  label: string | null;
  ownerType: "USER" | "TEAM";
  ownerTeamId: string | null;
  owningTeam: { name: string } | null;
  status: "ACTIVE" | "EXPIRED" | "REVOKED";
  expiresAt: string | null;
  createdAt: string;
}

interface Team {
  id: string;
  name: string;
}

// LibreChat API keys — entered per-user via the web UI (REQUIREMENTS
// §2/§4), or held by a Team for shared/durable schedules (§2.1). Raw key
// material never comes back from the API after creation — only
// metadata, per REQUIREMENTS §10 ("secrets never... returned in API
// responses beyond what's necessary").
export function ApiKeysPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [rawKey, setRawKey] = useState("");
  const [ownerType, setOwnerType] = useState<"USER" | "TEAM">("USER");
  const [ownerTeamId, setOwnerTeamId] = useState("");

  const keysQuery = useQuery({
    queryKey: ["api-keys"],
    queryFn: () => apiFetch<ApiKeySummary[]>("/api/api-keys"),
  });
  const teamsQuery = useQuery({ queryKey: ["teams"], queryFn: () => apiFetch<Team[]>("/api/teams") });

  const createKey = useMutation({
    mutationFn: () =>
      apiFetch("/api/api-keys", {
        method: "POST",
        body: JSON.stringify({
          label: label || undefined,
          key: rawKey,
          ownerType,
          ownerTeamId: ownerType === "TEAM" ? ownerTeamId : undefined,
        }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      setCreateOpen(false);
      setLabel("");
      setRawKey("");
    },
  });

  const revokeKey = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/api-keys/${id}`, { method: "DELETE" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["api-keys"] }),
  });

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="h4">API Keys</Typography>
        <Button variant="contained" onClick={() => setCreateOpen(true)}>
          New Key
        </Button>
      </Stack>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        LibreChat API keys used to run Jobs. Add your own personal key, or a shared key for a Team
        you belong to so its scheduled Jobs keep working even if you leave.
      </Typography>

      <List>
        {keysQuery.data?.map((key) => (
          <ListItem
            key={key.id}
            divider
            secondaryAction={
              key.status === "ACTIVE" && (
                <Button size="small" color="error" onClick={() => revokeKey.mutate(key.id)}>
                  Revoke
                </Button>
              )
            }
          >
            <ListItemText
              primary={key.label ?? "(unlabeled key)"}
              secondary={`${key.ownerType === "TEAM" ? `Team: ${key.owningTeam?.name}` : "Personal"} · ${key.status}${key.expiresAt ? ` · expires ${new Date(key.expiresAt).toLocaleDateString()}` : ""}`}
            />
          </ListItem>
        ))}
        {keysQuery.data?.length === 0 && (
          <Typography color="text.secondary">No API keys yet.</Typography>
        )}
      </List>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>New API Key</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <FormControl fullWidth>
              <InputLabel id="owner-type-label">Owner</InputLabel>
              <Select
                labelId="owner-type-label"
                label="Owner"
                value={ownerType}
                onChange={(e) => setOwnerType(e.target.value as "USER" | "TEAM")}
              >
                <MenuItem value="USER">Just me</MenuItem>
                <MenuItem value="TEAM">A Team</MenuItem>
              </Select>
            </FormControl>
            {ownerType === "TEAM" && (
              <FormControl fullWidth>
                <InputLabel id="owner-team-label">Team</InputLabel>
                <Select
                  labelId="owner-team-label"
                  label="Team"
                  value={ownerTeamId}
                  onChange={(e) => setOwnerTeamId(e.target.value)}
                >
                  {teamsQuery.data?.map((team) => (
                    <MenuItem key={team.id} value={team.id}>
                      {team.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}
            <TextField label="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} fullWidth />
            <TextField
              label="LibreChat API key"
              value={rawKey}
              onChange={(e) => setRawKey(e.target.value)}
              type="password"
              fullWidth
              autoComplete="off"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!rawKey || (ownerType === "TEAM" && !ownerTeamId) || createKey.isPending}
            onClick={() => createKey.mutate()}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
