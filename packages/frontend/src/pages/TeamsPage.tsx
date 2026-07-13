import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { apiFetch } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useConfirm } from "../context/ConfirmContext";

interface Team {
  id: string;
  name: string;
  parentTeamId: string | null;
  _count: { memberships: number; subTeams: number };
  // Whether the current viewer can rename/reparent/delete this Team and
  // manage its membership — an owner of this specific Team, or an admin
  // (who has full control over every Team regardless of membership).
  viewerIsOwner: boolean;
}

interface TeamDetail extends Team {
  memberships: Array<{ isOwner: boolean; user: { id: string; email: string; displayName: string | null } }>;
  subTeams: Array<{ id: string; name: string }>;
  parentTeam: { id: string; name: string } | null;
}

interface UserSummary {
  id: string;
  email: string;
  displayName: string | null;
}

export function TeamsPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");
  const [newTeamParentId, setNewTeamParentId] = useState<string | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);

  // Distinct query key from the plain ["teams"] used elsewhere (Project
  // sharing's Team picker, API Key creation's Team-owner picker) since
  // this fetches a different, narrower set — the same cache key with
  // different underlying data would let one page's cached result bleed
  // into the other.
  const teamsQuery = useQuery({
    queryKey: ["teams", "mine"],
    queryFn: () => apiFetch<Team[]>("/api/teams?mine=true"),
  });

  const detailQuery = useQuery({
    queryKey: ["teams", selectedTeamId],
    queryFn: () => apiFetch<TeamDetail>(`/api/teams/${selectedTeamId}`),
    enabled: !!selectedTeamId,
  });

  const createTeam = useMutation({
    mutationFn: () =>
      apiFetch<Team>("/api/teams", {
        method: "POST",
        body: JSON.stringify({ name: newTeamName, parentTeamId: newTeamParentId ?? undefined }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["teams"] });
      setCreateOpen(false);
      setNewTeamName("");
      setNewTeamParentId(null);
    },
  });

  return (
    <Box sx={{ display: "flex", gap: 4 }}>
      <Box sx={{ minWidth: 320 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="h4">Teams</Typography>
          <Button variant="contained" onClick={() => setCreateOpen(true)}>
            New Team
          </Button>
        </Stack>
        <List>
          {teamsQuery.data?.map((team) => (
            <ListItem key={team.id} disablePadding>
              <ListItemButton
                selected={team.id === selectedTeamId}
                onClick={() => setSelectedTeamId(team.id)}
              >
                <ListItemText
                  primary={team.name}
                  secondary={`${team._count.memberships} member(s), ${team._count.subTeams} sub-team(s)`}
                />
              </ListItemButton>
            </ListItem>
          ))}
          {teamsQuery.data?.length === 0 && (
            <Typography color="text.secondary">
              {user?.role === "ADMIN" ? "No Teams exist yet." : "You don't belong to any Teams yet."}
            </Typography>
          )}
        </List>
      </Box>

      <Box sx={{ flex: 1 }}>
        {detailQuery.data ? (
          <TeamDetailPanel team={detailQuery.data} onDeleted={() => setSelectedTeamId(null)} />
        ) : (
          <Typography color="text.secondary">Select a Team to view members.</Typography>
        )}
      </Box>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>New Team</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              label="Name"
              value={newTeamName}
              onChange={(e) => setNewTeamName(e.target.value)}
              autoFocus
              fullWidth
            />
            <Autocomplete
              options={teamsQuery.data ?? []}
              getOptionLabel={(t) => t.name}
              onChange={(_e, value) => setNewTeamParentId(value?.id ?? null)}
              renderInput={(params) => (
                <TextField {...params} label="Parent Team (optional — enables nesting)" />
              )}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!newTeamName || createTeam.isPending}
            onClick={() => createTeam.mutate()}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

function TeamDetailPanel({ team, onDeleted }: { team: TeamDetail; onDeleted: () => void }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [userSearch, setUserSearch] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState(team.name);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  useEffect(() => setEditName(team.name), [team.id, team.name]);

  const usersQuery = useQuery({
    queryKey: ["users", userSearch],
    queryFn: () => apiFetch<UserSummary[]>(`/api/users?search=${encodeURIComponent(userSearch)}`),
    enabled: userSearch.length > 1,
  });

  const addMember = useMutation({
    mutationFn: (userId: string) =>
      apiFetch(`/api/teams/${team.id}/members`, {
        method: "POST",
        body: JSON.stringify({ userId }),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["teams", team.id] }),
    onError: (err: unknown) => setMembershipError(err instanceof Error ? err.message : "action failed"),
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) =>
      apiFetch(`/api/teams/${team.id}/members/${userId}`, { method: "DELETE" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["teams", team.id] }),
    onError: (err: unknown) => setMembershipError(err instanceof Error ? err.message : "action failed"),
  });

  const setOwner = useMutation({
    mutationFn: ({ userId, isOwner }: { userId: string; isOwner: boolean }) =>
      apiFetch(`/api/teams/${team.id}/members/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ isOwner }),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["teams", team.id] }),
    onError: (err: unknown) => setMembershipError(err instanceof Error ? err.message : "action failed"),
  });

  const updateTeam = useMutation({
    mutationFn: () =>
      apiFetch(`/api/teams/${team.id}`, { method: "PATCH", body: JSON.stringify({ name: editName }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["teams"] });
      void queryClient.invalidateQueries({ queryKey: ["teams", team.id] });
      setEditOpen(false);
    },
  });

  const deleteTeam = useMutation({
    mutationFn: () => apiFetch(`/api/teams/${team.id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["teams"] });
      onDeleted();
    },
    onError: (err: unknown) => setDeleteError(err instanceof Error ? err.message : "delete failed"),
  });

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="h5">{team.name}</Typography>
          {!team.viewerIsOwner && <Chip size="small" label="Member" variant="outlined" />}
        </Stack>
        {team.viewerIsOwner && (
          <Stack direction="row" spacing={1}>
            <Button size="small" onClick={() => setEditOpen(true)}>
              Rename
            </Button>
            <Button
              size="small"
              color="error"
              disabled={deleteTeam.isPending}
              onClick={async () => {
                const ok = await confirm({
                  title: "Delete team?",
                  message: `Delete "${team.name}"? This can't be undone.`,
                });
                if (ok) deleteTeam.mutate();
              }}
            >
              Delete
            </Button>
          </Stack>
        )}
      </Stack>
      {deleteError && (
        <Alert severity="error" onClose={() => setDeleteError(null)}>
          {deleteError}
        </Alert>
      )}
      {membershipError && (
        <Alert severity="error" onClose={() => setMembershipError(null)}>
          {membershipError}
        </Alert>
      )}
      {team.parentTeam && (
        <Typography color="text.secondary">Parent: {team.parentTeam.name}</Typography>
      )}
      {team.subTeams.length > 0 && (
        <Box>
          <Typography variant="subtitle2">Sub-teams</Typography>
          {team.subTeams.map((sub) => (
            <Chip key={sub.id} label={sub.name} sx={{ mr: 1 }} />
          ))}
        </Box>
      )}

      <Typography variant="subtitle2">Members</Typography>
      <List dense>
        {team.memberships.map((m) => (
          <ListItem
            key={m.user.id}
            secondaryAction={
              team.viewerIsOwner && (
                <Stack direction="row" spacing={1}>
                  <Button
                    size="small"
                    disabled={setOwner.isPending}
                    onClick={() => setOwner.mutate({ userId: m.user.id, isOwner: !m.isOwner })}
                  >
                    {m.isOwner ? "Remove Owner" : "Make Owner"}
                  </Button>
                  <Button
                    size="small"
                    color="error"
                    disabled={removeMember.isPending}
                    onClick={() => removeMember.mutate(m.user.id)}
                  >
                    Remove
                  </Button>
                </Stack>
              )
            }
          >
            <ListItemText
              primary={
                <Stack direction="row" spacing={1} alignItems="center">
                  <span>{m.user.displayName ?? m.user.email}</span>
                  {m.isOwner && <Chip size="small" label="Owner" color="primary" />}
                </Stack>
              }
              secondary={m.user.email}
            />
          </ListItem>
        ))}
        {team.memberships.length === 0 && (
          <Typography color="text.secondary">No direct members yet.</Typography>
        )}
      </List>

      {team.viewerIsOwner && (
        <Autocomplete
          options={usersQuery.data ?? []}
          getOptionLabel={(u) => `${u.displayName ?? u.email} (${u.email})`}
          onInputChange={(_e, value) => setUserSearch(value)}
          onChange={(_e, value) => value && addMember.mutate(value.id)}
          renderInput={(params) => <TextField {...params} label="Add member by email" />}
        />
      )}

      <Dialog open={editOpen} onClose={() => setEditOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Rename Team</DialogTitle>
        <DialogContent>
          <TextField
            label="Name"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            autoFocus
            fullWidth
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!editName || updateTeam.isPending}
            onClick={() => updateTeam.mutate()}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
