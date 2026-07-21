import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Alert,
  List,
  ListItem,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import EditIcon from "@mui/icons-material/Edit";
import DeleteIcon from "@mui/icons-material/Delete";
import SaveIcon from "@mui/icons-material/Save";
import MailOutlineIcon from "@mui/icons-material/MailOutline";
import { apiFetch } from "../api/client";
import { useConfirm } from "../context/ConfirmContext";

interface MailingList {
  id: string;
  name: string;
  emails: string[];
  createdAt: string;
}

const MAX_EMAILS_PER_LIST = 100;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseEmails(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Mirrors the API's createMailingListSchema/updateMailingListSchema — the
// server re-validates all of it; this exists to fail fast with a clear
// message instead of a round trip.
function emailsError(emails: string[]): string | null {
  if (emails.length === 0) return "At least one email address is required.";
  if (emails.length > MAX_EMAILS_PER_LIST) return `No more than ${MAX_EMAILS_PER_LIST} email addresses.`;
  const invalid = emails.filter((e) => !EMAIL_RE.test(e));
  return invalid.length > 0 ? `Not a valid email address: ${invalid.join(", ")}` : null;
}

// A user's own saved, reusable lists of notification-recipient email
// addresses (issue #219) — attach one to a Job from JobNotificationsDialog
// instead of retyping the same addresses into that Job's ccRecipients
// every time. Personal, like API Keys: everyone manages their own lists.
export function MailingListsPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createEmailsText, setCreateEmailsText] = useState("");
  const [editingList, setEditingList] = useState<MailingList | null>(null);
  const [editName, setEditName] = useState("");
  const [editEmailsText, setEditEmailsText] = useState("");

  const listsQuery = useQuery({
    queryKey: ["mailing-lists"],
    queryFn: () => apiFetch<MailingList[]>("/api/mailing-lists"),
  });

  const createEmails = parseEmails(createEmailsText);
  const createEmailsErr = emailsError(createEmails);
  const editEmails = parseEmails(editEmailsText);
  const editEmailsErr = emailsError(editEmails);

  const createList = useMutation({
    mutationFn: () =>
      apiFetch("/api/mailing-lists", {
        method: "POST",
        body: JSON.stringify({ name: createName, emails: createEmails }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["mailing-lists"] });
      setCreateOpen(false);
      setCreateName("");
      setCreateEmailsText("");
    },
  });

  const updateList = useMutation({
    mutationFn: () =>
      apiFetch(`/api/mailing-lists/${editingList!.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: editName, emails: editEmails }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["mailing-lists"] });
      setEditingList(null);
    },
  });

  const deleteList = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/mailing-lists/${id}`, { method: "DELETE" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["mailing-lists"] }),
  });

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="h4" sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <MailOutlineIcon fontSize="large" /> Mailing Lists
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreateOpen(true)}>
          New List
        </Button>
      </Stack>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        Saved lists of email addresses you can attach to any Job's notifications, instead of
        retyping the same recipients every time. Only you can see and manage your own lists.
      </Typography>

      <List>
        {listsQuery.data?.map((list) => (
          <ListItem
            key={list.id}
            divider
            secondaryAction={
              <Stack direction="row" spacing={1}>
                <Button
                  size="small"
                  startIcon={<EditIcon fontSize="small" />}
                  onClick={() => {
                    setEditingList(list);
                    setEditName(list.name);
                    setEditEmailsText(list.emails.join(", "));
                  }}
                >
                  Edit
                </Button>
                <Button
                  size="small"
                  color="error"
                  startIcon={<DeleteIcon fontSize="small" />}
                  disabled={deleteList.isPending}
                  onClick={() => {
                    void (async () => {
                      const ok = await confirm({
                        title: "Delete mailing list?",
                        message: `Delete "${list.name}"? Any Job it's attached to will just stop notifying its addresses. This can't be undone.`,
                        confirmLabel: "Delete",
                        icon: <DeleteIcon />,
                      });
                      if (ok) deleteList.mutate(list.id);
                    })();
                  }}
                >
                  Delete
                </Button>
              </Stack>
            }
          >
            <ListItemText
              primary={list.name}
              secondary={`${list.emails.length} address${list.emails.length === 1 ? "" : "es"}: ${list.emails.join(", ")}`}
            />
          </ListItem>
        ))}
        {listsQuery.data?.length === 0 && (
          <Typography color="text.secondary">
            No mailing lists yet. Create one, then attach it from a Job's "Notify" dialog.
          </Typography>
        )}
      </List>
      {deleteList.isError && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {deleteList.error instanceof Error ? deleteList.error.message : "Could not delete mailing list."}
        </Alert>
      )}

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>New Mailing List</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="Name" value={createName} onChange={(e) => setCreateName(e.target.value)} fullWidth />
            <TextField
              label="Email addresses (comma-separated)"
              value={createEmailsText}
              onChange={(e) => setCreateEmailsText(e.target.value)}
              error={createEmailsText.length > 0 && createEmailsErr !== null}
              helperText={
                (createEmailsText.length > 0 ? createEmailsErr : null) ??
                `Up to ${MAX_EMAILS_PER_LIST} addresses.`
              }
              multiline
              minRows={3}
              fullWidth
            />
            {createList.isError && (
              <Alert severity="error">
                {createList.error instanceof Error ? createList.error.message : "Could not create mailing list."}
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            startIcon={<SaveIcon />}
            disabled={!createName.trim() || createEmailsErr !== null || createList.isPending}
            onClick={() => createList.mutate()}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!editingList} onClose={() => setEditingList(null)} fullWidth maxWidth="sm">
        <DialogTitle>Edit Mailing List</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="Name" value={editName} onChange={(e) => setEditName(e.target.value)} fullWidth />
            <TextField
              label="Email addresses (comma-separated)"
              value={editEmailsText}
              onChange={(e) => setEditEmailsText(e.target.value)}
              error={editEmailsErr !== null}
              helperText={editEmailsErr ?? `Up to ${MAX_EMAILS_PER_LIST} addresses.`}
              multiline
              minRows={3}
              fullWidth
            />
            {updateList.isError && (
              <Alert severity="error">
                {updateList.error instanceof Error ? updateList.error.message : "Could not save mailing list."}
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditingList(null)}>Cancel</Button>
          <Button
            variant="contained"
            startIcon={<SaveIcon />}
            disabled={!editName.trim() || editEmailsErr !== null || updateList.isPending}
            onClick={() => updateList.mutate()}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
