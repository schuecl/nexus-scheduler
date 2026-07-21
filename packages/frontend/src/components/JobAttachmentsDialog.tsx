import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Stack,
  Typography,
} from "@mui/material";
import AttachFileIcon from "@mui/icons-material/AttachFile";
import DeleteIcon from "@mui/icons-material/Delete";
import DownloadIcon from "@mui/icons-material/Download";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import VisibilityIcon from "@mui/icons-material/Visibility";
import { apiFetch } from "../api/client";

interface JobAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

// Mirrors the API's schema constants (attachment.ts in shared) — the
// server re-validates all of it; these exist to fail fast with a clear
// message instead of a round trip.
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/tiff",
  "image/bmp",
  "image/webp",
]);
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const ACCEPT = ".pdf,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.webp";

// Some browsers/OSes leave File.type empty for perfectly valid files
// (TIFF and BMP are the usual victims). Since the picker advertises
// extensions, fall back to the extension when the browser gives us no
// MIME type — otherwise a file the dialog itself offered gets rejected.
const EXTENSION_MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  tif: "image/tiff",
  tiff: "image/tiff",
  bmp: "image/bmp",
  webp: "image/webp",
};

function effectiveMimeType(file: File): string {
  if (file.type) return file.type;
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  return EXTENSION_MIME[extension] ?? "";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Of ALLOWED_MIME above, everything except TIFF renders natively in an
// <img>/<iframe> — no browser (Chrome, Firefox, or Safari) decodes TIFF
// inline, regardless of Content-Type, so that one gets a "can't preview"
// message and a download link instead of a broken image icon (#229).
const INLINE_PREVIEWABLE_MIME = new Set(["application/pdf", "image/png", "image/jpeg", "image/bmp", "image/webp"]);

function attachmentContentUrl(jobId: string, attachmentId: string): string {
  return `/api/jobs/${jobId}/attachments/${attachmentId}/content`;
}

// Preview reads the same authenticated, inline-disposition endpoint an
// <img>/<iframe> `src` can hit directly (session cookie, same as the
// run-artifact download links) — no separate blob-fetch plumbing needed.
function AttachmentPreviewDialog({
  jobId,
  attachment,
  onClose,
}: {
  jobId: string;
  attachment: JobAttachment;
  onClose: () => void;
}) {
  const url = attachmentContentUrl(jobId, attachment.id);
  const canPreviewInline = INLINE_PREVIEWABLE_MIME.has(attachment.mimeType);
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <VisibilityIcon /> {attachment.filename}
      </DialogTitle>
      <DialogContent>
        {canPreviewInline && attachment.mimeType === "application/pdf" && (
          <Box component="iframe" src={url} title={attachment.filename} sx={{ width: "100%", height: "70vh", border: "none" }} />
        )}
        {canPreviewInline && attachment.mimeType !== "application/pdf" && (
          <Box
            component="img"
            src={url}
            alt={attachment.filename}
            sx={{ display: "block", maxWidth: "100%", maxHeight: "70vh", mx: "auto" }}
          />
        )}
        {!canPreviewInline && (
          <Alert severity="info">
            Browsers can&apos;t render {attachment.mimeType} inline — download it to view.
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button component="a" href={url} download={attachment.filename} startIcon={<DownloadIcon />} sx={{ mr: "auto" }}>
          Download
        </Button>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

// Files attached to a Job are OCR'd by the worker before every run
// (#109): the agent receives the extracted text appended to the prompt,
// and each run keeps a searchable-PDF artifact per attachment.
export function JobAttachmentsDialog({
  jobId,
  canEdit,
  onClose,
}: {
  jobId: string;
  canEdit: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<JobAttachment | null>(null);

  const attachmentsQuery = useQuery({
    queryKey: ["jobs", jobId, "attachments"],
    queryFn: () => apiFetch<JobAttachment[]>(`/api/jobs/${jobId}/attachments`),
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const mimeType = effectiveMimeType(file);
      if (!ALLOWED_MIME.has(mimeType)) {
        throw new Error(`unsupported type ${mimeType || "(unknown)"} — PDF, PNG, JPEG, TIFF, BMP or WebP`);
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`"${file.name}" is ${formatBytes(file.size)} — the limit is 15 MB per file`);
      }
      // FileReader's data URL is the least-ceremony path to base64 in a
      // browser; strip the "data:<mime>;base64," prefix the API doesn't want.
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
        reader.onerror = () => reject(new Error(`could not read "${file.name}"`));
        reader.readAsDataURL(file);
      });
      return apiFetch<JobAttachment>(`/api/jobs/${jobId}/attachments`, {
        method: "POST",
        body: JSON.stringify({ filename: file.name, mimeType, dataBase64 }),
      });
    },
    onSuccess: () => {
      setUploadError(null);
      void queryClient.invalidateQueries({ queryKey: ["jobs", jobId, "attachments"] });
    },
    onError: (err) => {
      setUploadError(err instanceof Error ? err.message : "Upload failed.");
    },
  });

  const remove = useMutation({
    mutationFn: (attachmentId: string) =>
      apiFetch(`/api/jobs/${jobId}/attachments/${attachmentId}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["jobs", jobId, "attachments"] });
    },
  });

  const attachments = attachmentsQuery.data ?? [];

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <AttachFileIcon /> Attachments
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Documents attached here are OCR&apos;d before every run of this Job: the agent receives the
          extracted text along with the prompt, and each run keeps a searchable PDF of every
          attachment. PDF, PNG, JPEG, TIFF, BMP or WebP — 15&nbsp;MB per file, 10 files / 50&nbsp;MB
          per Job.
        </Typography>
        {attachmentsQuery.isPending && <CircularProgress size={20} />}
        {attachmentsQuery.isError && (
          <Alert severity="error" sx={{ mb: 1 }}>
            {attachmentsQuery.error instanceof Error
              ? attachmentsQuery.error.message
              : "Could not load attachments."}
          </Alert>
        )}
        <List dense>
          {attachments.map((attachment) => (
            <ListItem
              key={attachment.id}
              secondaryAction={
                <Stack direction="row" spacing={0.5}>
                  <IconButton
                    edge={canEdit ? undefined : "end"}
                    aria-label={`preview ${attachment.filename}`}
                    onClick={() => setPreviewAttachment(attachment)}
                  >
                    <VisibilityIcon fontSize="small" />
                  </IconButton>
                  {canEdit && (
                    <IconButton
                      edge="end"
                      aria-label={`delete ${attachment.filename}`}
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(attachment.id)}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  )}
                </Stack>
              }
            >
              <ListItemText
                primary={attachment.filename}
                secondary={`${attachment.mimeType} · ${formatBytes(attachment.sizeBytes)} · ${new Date(attachment.createdAt).toLocaleString()}`}
              />
            </ListItem>
          ))}
          {attachmentsQuery.isSuccess && attachments.length === 0 && (
            <ListItem>
              <ListItemText
                primary="No attachments yet."
                primaryTypographyProps={{ color: "text.secondary", variant: "body2" }}
              />
            </ListItem>
          )}
        </List>
        {uploadError && (
          <Alert severity="error" onClose={() => setUploadError(null)} sx={{ mt: 1 }}>
            {uploadError}
          </Alert>
        )}
        {remove.isError && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {remove.error instanceof Error ? remove.error.message : "Could not delete the attachment."}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        {canEdit && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT}
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Reset so picking the same file again re-fires onChange.
                event.target.value = "";
                if (file) upload.mutate(file);
              }}
            />
            <Button
              startIcon={upload.isPending ? <CircularProgress size={16} /> : <UploadFileIcon />}
              disabled={upload.isPending}
              onClick={() => fileInputRef.current?.click()}
            >
              {upload.isPending ? "Uploading…" : "Upload file"}
            </Button>
          </>
        )}
        <Stack direction="row" sx={{ flexGrow: 1 }} />
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
      {previewAttachment && (
        <AttachmentPreviewDialog
          jobId={jobId}
          attachment={previewAttachment}
          onClose={() => setPreviewAttachment(null)}
        />
      )}
    </Dialog>
  );
}
