import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import { diffLines } from "diff";
import StarIcon from "@mui/icons-material/Star";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import EditIcon from "@mui/icons-material/Edit";
import DeleteIcon from "@mui/icons-material/Delete";
import SaveIcon from "@mui/icons-material/Save";
import PostAddIcon from "@mui/icons-material/PostAdd";
import RestoreIcon from "@mui/icons-material/Restore";
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

interface VariableDiffEntry {
  name: string;
  status: "added" | "removed" | "changed";
  before?: PromptVariableDraft;
  after?: PromptVariableDraft;
}

// Structural diff over the variable list between two versions — no diff
// library needed here, variables are small structured records rather
// than free text. Unchanged variables are dropped so the compare view
// only shows what actually moved between the two versions.
function diffVariables(before: PromptVariableDraft[], after: PromptVariableDraft[]): VariableDiffEntry[] {
  const names = Array.from(new Set([...before.map((v) => v.name), ...after.map((v) => v.name)])).sort();
  const entries: VariableDiffEntry[] = [];
  for (const name of names) {
    const b = before.find((v) => v.name === name);
    const a = after.find((v) => v.name === name);
    if (!b && a) entries.push({ name, status: "added", after: a });
    else if (b && !a) entries.push({ name, status: "removed", before: b });
    else if (b && a && (b.type !== a.type || b.defaultValue !== a.defaultValue)) {
      entries.push({ name, status: "changed", before: b, after: a });
    }
  }
  return entries;
}

function formatVariable(v: PromptVariableDraft | undefined): string {
  if (!v) return "—";
  return `${v.type}${v.defaultValue ? ` · default: ${v.defaultValue}` : ""}`;
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
  const [expandedVersionId, setExpandedVersionId] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [restoreError, setRestoreError] = useState<string | null>(null);

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

  // Restoring a past version never edits or deletes anything — it just
  // calls the same "add version" endpoint with that version's content,
  // so it lands as a brand-new version on top. History stays intact and
  // immutable, same as every other version.
  const restoreVersion = useMutation({
    mutationFn: (version: PromptVersion) =>
      apiFetch(`/api/prompts/${promptId}/versions`, {
        method: "POST",
        body: JSON.stringify({
          content: version.content,
          variables: version.variables
            .filter((v) => v.name)
            .map((v) => ({ name: v.name, type: v.type, defaultValue: v.defaultValue || undefined })),
        }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["prompts", promptId] });
      setExpandedVersionId(null);
      setRestoreError(null);
    },
    onError: (err: unknown) => setRestoreError(err instanceof Error ? err.message : "Could not restore version."),
  });

  const toggleCompare = (id: string) => {
    setCompareIds((prevIds) => {
      if (prevIds.includes(id)) return prevIds.filter((x) => x !== id);
      if (prevIds.length >= 2) return [...prevIds.slice(1), id];
      return [...prevIds, id];
    });
  };

  const prompt = promptQuery.data;
  const latest = prompt?.versions[0];
  const canEdit = prompt?.projectAccess === "OWNER" || prompt?.projectAccess === "EDIT";

  const handleRestore = (version: PromptVersion) => {
    void (async () => {
      const ok = await confirm({
        title: "Restore this version?",
        message: `This creates a new version (v${(latest?.versionNumber ?? version.versionNumber) + 1}) using v${version.versionNumber}'s content. The current version stays in history too.`,
      });
      if (ok) restoreVersion.mutate(version);
    })();
  };

  // Sorted oldest-first so the diff always reads as "what changed going
  // forward," regardless of which of the two checkboxes was clicked first.
  const compareA = compareIds.length === 2 ? prompt?.versions.find((v) => v.id === compareIds[0]) : undefined;
  const compareB = compareIds.length === 2 ? prompt?.versions.find((v) => v.id === compareIds[1]) : undefined;
  const compareVersions: [PromptVersion, PromptVersion] | null =
    compareA && compareB
      ? compareA.versionNumber <= compareB.versionNumber
        ? [compareA, compareB]
        : [compareB, compareA]
      : null;
  const contentDiff = compareVersions ? diffLines(compareVersions[0].content, compareVersions[1].content) : null;
  const variableDiff = compareVersions ? diffVariables(compareVersions[0].variables, compareVersions[1].variables) : null;

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
                    onClick={() => {
                      void (async () => {
                        const ok = await confirm({
                          title: "Delete prompt?",
                          message: `Delete "${prompt.name}" and all its saved versions? This can't be undone.`,
                        });
                        if (ok) deletePrompt.mutate();
                      })();
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
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography variant="subtitle2">Version history</Typography>
                {compareIds.length > 0 && (
                  <Button size="small" onClick={() => setCompareIds([])}>
                    Clear compare ({compareIds.length}/2)
                  </Button>
                )}
              </Stack>
              <Typography variant="caption" color="text.secondary">
                Click a version to view it. Check two to compare them.
              </Typography>
              {restoreError && (
                <Alert severity="error" onClose={() => setRestoreError(null)}>
                  {restoreError}
                </Alert>
              )}
              <List dense disablePadding>
                {prompt.versions.map((v) => {
                  const isLatest = v.id === latest?.id;
                  const expanded = expandedVersionId === v.id;
                  return (
                    <Box key={v.id}>
                      <ListItem
                        disablePadding
                        secondaryAction={
                          <Checkbox
                            size="small"
                            checked={compareIds.includes(v.id)}
                            onChange={() => toggleCompare(v.id)}
                            inputProps={{ "aria-label": `Select v${v.versionNumber} to compare` }}
                          />
                        }
                      >
                        <ListItemButton onClick={() => setExpandedVersionId(expanded ? null : v.id)}>
                          <ListItemText
                            primary={`v${v.versionNumber}${isLatest ? " (current)" : ""}`}
                            secondary={`${v.createdBy.displayName ?? v.createdBy.email} · ${new Date(v.createdAt).toLocaleString()}`}
                          />
                        </ListItemButton>
                      </ListItem>
                      <Collapse in={expanded} unmountOnExit>
                        <Box sx={{ pl: 2, pr: 6, pb: 2 }}>
                          <Box
                            sx={{
                              p: 2,
                              bgcolor: "action.hover",
                              borderRadius: 1,
                              whiteSpace: "pre-wrap",
                              fontFamily: "monospace",
                              fontSize: 13,
                            }}
                          >
                            {v.content}
                          </Box>
                          {!isLatest && canEdit && (
                            <Button
                              size="small"
                              startIcon={<RestoreIcon fontSize="small" />}
                              sx={{ mt: 1 }}
                              disabled={restoreVersion.isPending}
                              onClick={() => handleRestore(v)}
                            >
                              Restore this version
                            </Button>
                          )}
                        </Box>
                      </Collapse>
                    </Box>
                  );
                })}
              </List>

              {compareVersions && contentDiff && variableDiff && (
                <>
                  <Divider />
                  <Typography variant="subtitle2">
                    Comparing v{compareVersions[0].versionNumber} → v{compareVersions[1].versionNumber}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Content
                  </Typography>
                  <Box
                    sx={{
                      p: 2,
                      bgcolor: "action.hover",
                      borderRadius: 1,
                      whiteSpace: "pre-wrap",
                      fontFamily: "monospace",
                      fontSize: 13,
                      maxHeight: 320,
                      overflow: "auto",
                    }}
                  >
                    {contentDiff.map((part, i) => (
                      <Box
                        key={i}
                        component="span"
                        sx={{
                          display: "block",
                          bgcolor: part.added
                            ? (theme) => alpha(theme.palette.success.main, 0.18)
                            : part.removed
                              ? (theme) => alpha(theme.palette.error.main, 0.18)
                              : undefined,
                          textDecoration: part.removed ? "line-through" : undefined,
                        }}
                      >
                        {part.value}
                      </Box>
                    ))}
                  </Box>
                  <Typography variant="body2" color="text.secondary">
                    Variables
                  </Typography>
                  {variableDiff.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      No variable changes.
                    </Typography>
                  ) : (
                    <List dense disablePadding>
                      {variableDiff.map((d) => (
                        <ListItem key={d.name} disablePadding sx={{ py: 0.5 }}>
                          <ListItemText
                            primary={
                              <Stack direction="row" spacing={1} alignItems="center">
                                <Chip
                                  size="small"
                                  label={d.status}
                                  color={d.status === "added" ? "success" : d.status === "removed" ? "error" : "warning"}
                                />
                                <Typography variant="body2" component="span">
                                  {d.name}
                                </Typography>
                              </Stack>
                            }
                            secondary={
                              d.status === "changed"
                                ? `${formatVariable(d.before)} → ${formatVariable(d.after)}`
                                : formatVariable(d.status === "added" ? d.after : d.before)
                            }
                          />
                        </ListItem>
                      ))}
                    </List>
                  )}
                </>
              )}
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
