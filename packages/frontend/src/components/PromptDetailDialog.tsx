import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import StarIcon from "@mui/icons-material/Star";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import { apiFetch } from "../api/client";

interface PromptVersion {
  id: string;
  versionNumber: number;
  content: string;
  createdAt: string;
  createdBy: { displayName: string | null; email: string };
}

interface PromptDetail {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  isFavorite: boolean;
  projectAccess: "OWNER" | "EDIT" | "READ";
  versions: PromptVersion[];
}

// Shared between the library-wide search page and a Project's own
// Prompts list — a prompt looks the same regardless of how you got to
// it (REQUIREMENTS §2.3: sharing is about *finding* a prompt, not a
// different view of it once found).
export function PromptDetailDialog({ promptId, onClose }: { promptId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [newVersionContent, setNewVersionContent] = useState("");
  const [addingVersion, setAddingVersion] = useState(false);

  const promptQuery = useQuery({
    queryKey: ["prompts", promptId],
    queryFn: () => apiFetch<PromptDetail>(`/api/prompts/${promptId}`),
  });

  const toggleFavorite = useMutation({
    mutationFn: () =>
      apiFetch(`/api/prompts/${promptId}/favorite`, {
        method: promptQuery.data?.isFavorite ? "DELETE" : "POST",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["prompts", promptId] });
      void queryClient.invalidateQueries({ queryKey: ["prompts"] });
    },
  });

  const addVersion = useMutation({
    mutationFn: () =>
      apiFetch(`/api/prompts/${promptId}/versions`, {
        method: "POST",
        body: JSON.stringify({ content: newVersionContent, variables: [] }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["prompts", promptId] });
      setAddingVersion(false);
      setNewVersionContent("");
    },
  });

  const prompt = promptQuery.data;
  const latest = prompt?.versions[0];
  const canEdit = prompt?.projectAccess === "OWNER" || prompt?.projectAccess === "EDIT";

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md">
      {prompt && (
        <>
          <DialogTitle>
            <Stack direction="row" spacing={1} alignItems="center">
              <IconButton size="small" onClick={() => toggleFavorite.mutate()}>
                {prompt.isFavorite ? <StarIcon color="warning" /> : <StarBorderIcon />}
              </IconButton>
              <span>{prompt.name}</span>
            </Stack>
          </DialogTitle>
          <DialogContent>
            <Stack spacing={2}>
              {prompt.description && <Typography color="text.secondary">{prompt.description}</Typography>}
              {prompt.tags.length > 0 && (
                <Typography variant="body2" color="text.secondary">
                  Tags: {prompt.tags.join(", ")}
                </Typography>
              )}

              <Divider />
              <Typography variant="subtitle2">
                Current content (v{latest?.versionNumber})
              </Typography>
              <Box
                sx={{
                  p: 2,
                  bgcolor: "action.hover",
                  borderRadius: 1,
                  whiteSpace: "pre-wrap",
                  fontFamily: "monospace",
                  fontSize: 14,
                }}
              >
                {latest?.content}
              </Box>

              {canEdit && !addingVersion && (
                <Button onClick={() => setAddingVersion(true)} sx={{ alignSelf: "flex-start" }}>
                  Save as new version
                </Button>
              )}
              {canEdit && addingVersion && (
                <Stack spacing={1}>
                  <TextField
                    label="New version content"
                    multiline
                    minRows={4}
                    value={newVersionContent}
                    onChange={(e) => setNewVersionContent(e.target.value)}
                    fullWidth
                  />
                  <Stack direction="row" spacing={1}>
                    <Button
                      variant="contained"
                      disabled={!newVersionContent || addVersion.isPending}
                      onClick={() => addVersion.mutate()}
                    >
                      Save version
                    </Button>
                    <Button onClick={() => setAddingVersion(false)}>Cancel</Button>
                  </Stack>
                </Stack>
              )}

              <Divider />
              <Typography variant="subtitle2">Version history</Typography>
              <List dense>
                {prompt.versions.map((v) => (
                  <ListItem key={v.id}>
                    <ListItemText
                      primary={`v${v.versionNumber}`}
                      secondary={`${v.createdBy.displayName ?? v.createdBy.email} · ${new Date(v.createdAt).toLocaleString()}`}
                    />
                  </ListItem>
                ))}
              </List>
            </Stack>
          </DialogContent>
        </>
      )}
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
