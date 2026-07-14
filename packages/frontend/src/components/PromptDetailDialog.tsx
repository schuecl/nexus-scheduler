import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
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
import EditIcon from "@mui/icons-material/Edit";
import DeleteIcon from "@mui/icons-material/Delete";
import SaveIcon from "@mui/icons-material/Save";
import PostAddIcon from "@mui/icons-material/PostAdd";
import { apiFetch } from "../api/client";
import { useConfirm } from "../context/ConfirmContext";
import { VariableEditor, type PromptVariableDraft } from "./VariableEditor";

interface PromptVersion {
  id: string;
  versionNumber: number;
  content: string;
  variables: PromptVariableDraft[];
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
// Invalidates every cached prompt list regardless of which page/filter
// combination produced it (PromptLibraryPage's ["prompts", {search,
// favoritesOnly}] and ProjectPromptsPanel's ["projects", id, "prompts"]
// both contain "prompts" as a key segment) — simpler than threading a
// specific query key back through both very different call sites.
function invalidateAllPromptLists(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ predicate: (query) => query.queryKey.includes("prompts") });
}

export function PromptDetailDialog({ promptId, onClose }: { promptId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [newVersionContent, setNewVersionContent] = useState("");
  const [newVersionVariables, setNewVersionVariables] = useState<PromptVariableDraft[]>([]);
  const [addingVersion, setAddingVersion] = useState(false);
  const [editingMeta, setEditingMeta] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editTags, setEditTags] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const promptQuery = useQuery({
    queryKey: ["prompts", promptId],
    queryFn: () => apiFetch<PromptDetail>(`/api/prompts/${promptId}`),
  });

  useEffect(() => {
    if (promptQuery.data) {
      setEditName(promptQuery.data.name);
      setEditDescription(promptQuery.data.description ?? "");
      setEditTags(promptQuery.data.tags.join(", "));
    }
  }, [promptQuery.data]);

  const updateMeta = useMutation({
    mutationFn: () =>
      apiFetch(`/api/prompts/${promptId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editName,
          description: editDescription || undefined,
          tags: editTags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["prompts", promptId] });
      invalidateAllPromptLists(queryClient);
      setEditingMeta(false);
    },
  });

  const deletePrompt = useMutation({
    mutationFn: () => apiFetch(`/api/prompts/${promptId}`, { method: "DELETE" }),
    onSuccess: () => {
      invalidateAllPromptLists(queryClient);
      onClose();
    },
    onError: (err: unknown) => setDeleteError(err instanceof Error ? err.message : "delete failed"),
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
        body: JSON.stringify({
          content: newVersionContent,
          variables: newVersionVariables
            .filter((v) => v.name)
            .map((v) => ({ name: v.name, type: v.type, defaultValue: v.defaultValue || undefined })),
        }),
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
            <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
              <Stack direction="row" spacing={1} alignItems="center">
                <IconButton size="small" onClick={() => toggleFavorite.mutate()}>
                  {prompt.isFavorite ? <StarIcon color="warning" /> : <StarBorderIcon />}
                </IconButton>
                <span>{prompt.name}</span>
              </Stack>
              {canEdit && (
                <Stack direction="row" spacing={1}>
                  <Button size="small" startIcon={<EditIcon fontSize="small" />} onClick={() => setEditingMeta(true)}>
                    Edit
                  </Button>
                  <Button
                    size="small"
                    color="error"
                    startIcon={<DeleteIcon fontSize="small" />}
                    disabled={deletePrompt.isPending}
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Delete prompt?",
                        message: `Delete "${prompt.name}" and all its saved versions? This can't be undone.`,
                      });
                      if (ok) deletePrompt.mutate();
                    }}
                  >
                    Delete
                  </Button>
                </Stack>
              )}
            </Stack>
          </DialogTitle>
          <DialogContent>
            <Stack spacing={2}>
              {deleteError && (
                <Alert severity="error" onClose={() => setDeleteError(null)}>
                  {deleteError}
                </Alert>
              )}
              {editingMeta ? (
                <Stack spacing={2}>
                  <TextField label="Name" value={editName} onChange={(e) => setEditName(e.target.value)} fullWidth autoFocus />
                  <TextField
                    label="Description"
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    fullWidth
                  />
                  <TextField
                    label="Tags (comma-separated)"
                    value={editTags}
                    onChange={(e) => setEditTags(e.target.value)}
                    fullWidth
                  />
                  {updateMeta.isError && (
                    <Alert severity="error">
                      {updateMeta.error instanceof Error ? updateMeta.error.message : "Could not save prompt."}
                    </Alert>
                  )}
                  <Stack direction="row" spacing={1}>
                    <Button
                      variant="contained"
                      startIcon={<SaveIcon />}
                      disabled={!editName || updateMeta.isPending}
                      onClick={() => updateMeta.mutate()}
                    >
                      Save
                    </Button>
                    <Button onClick={() => setEditingMeta(false)}>Cancel</Button>
                  </Stack>
                </Stack>
              ) : (
                <>
                  {prompt.description && <Typography color="text.secondary">{prompt.description}</Typography>}
                  {prompt.tags.length > 0 && (
                    <Typography variant="body2" color="text.secondary">
                      Tags: {prompt.tags.join(", ")}
                    </Typography>
                  )}
                </>
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
                <Button
                  startIcon={<PostAddIcon fontSize="small" />}
                  onClick={() => {
                    setNewVersionContent(latest?.content ?? "");
                    setNewVersionVariables(latest?.variables ?? []);
                    setAddingVersion(true);
                  }}
                  sx={{ alignSelf: "flex-start" }}
                >
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
                  <VariableEditor variables={newVersionVariables} onChange={setNewVersionVariables} />
                  {addVersion.isError && (
                    <Alert severity="error">
                      {addVersion.error instanceof Error ? addVersion.error.message : "Could not save version."}
                    </Alert>
                  )}
                  <Stack direction="row" spacing={1}>
                    <Button
                      variant="contained"
                      startIcon={<SaveIcon />}
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
