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
  Divider,
  FormControl,
  InputLabel,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { apiFetch } from "../api/client";
import { useConfirm } from "../context/ConfirmContext";
import { PromptDetailDialog } from "../components/PromptDetailDialog";
import { ScheduleManagerDialog } from "../components/ScheduleManagerDialog";
import { JobWebhooksDialog } from "../components/JobWebhooksDialog";
import { RunHistoryDialog } from "../components/RunHistoryDialog";
import { JobNotificationsDialog } from "../components/JobNotificationsDialog";
import { VariableEditor, type PromptVariableDraft } from "../components/VariableEditor";

interface ClassificationLabel {
  id: string;
  text: string;
  badgeBgColor: string;
  badgeTextColor: string;
}

interface Project {
  id: string;
  name: string;
  description: string | null;
  visibility: "PRIVATE" | "SHARED";
  classificationLabel: ClassificationLabel | null;
  owner: { id: string; email: string; displayName: string | null };
}

interface ProjectDetail extends Project {
  effectiveAccess: "OWNER" | "EDIT" | "READ";
}

interface Team {
  id: string;
  name: string;
}

interface UserSummary {
  id: string;
  email: string;
  displayName: string | null;
}

interface ProjectAcl {
  id: string;
  granteeType: "USER" | "TEAM" | "ORG";
  granteeUserId: string | null;
  granteeTeamId: string | null;
  accessLevel: "READ" | "EDIT";
}

function ClassificationBadge({ label }: { label: ClassificationLabel | null }) {
  if (!label) return null;
  return (
    <Chip
      size="small"
      label={label.text}
      sx={{ backgroundColor: label.badgeBgColor, color: label.badgeTextColor, fontWeight: 700 }}
    />
  );
}

export function ProjectsPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newLabelId, setNewLabelId] = useState("");

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: () => apiFetch<Project[]>("/api/projects"),
  });
  const labelsQuery = useQuery({
    queryKey: ["classification-labels"],
    queryFn: () => apiFetch<ClassificationLabel[]>("/api/classification-labels"),
  });

  const createProject = useMutation({
    mutationFn: () =>
      apiFetch<Project>("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          name: newName,
          description: newDescription || undefined,
          classificationLabelId: newLabelId || undefined,
        }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      setCreateOpen(false);
      setNewName("");
      setNewDescription("");
      setNewLabelId("");
    },
  });

  return (
    <Box sx={{ display: "flex", gap: 4 }}>
      <Box sx={{ minWidth: 360 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="h4">Projects</Typography>
          <Button variant="contained" onClick={() => setCreateOpen(true)}>
            New Project
          </Button>
        </Stack>
        <List>
          {projectsQuery.data?.map((project) => (
            <ListItem key={project.id} disablePadding>
              <ListItemButton
                selected={project.id === selectedProjectId}
                onClick={() => setSelectedProjectId(project.id)}
              >
                <ListItemText
                  primary={
                    <Stack direction="row" spacing={1} alignItems="center">
                      <span>{project.name}</span>
                      <ClassificationBadge label={project.classificationLabel} />
                    </Stack>
                  }
                  secondary={`Owner: ${project.owner.displayName ?? project.owner.email} · ${project.visibility}`}
                />
              </ListItemButton>
            </ListItem>
          ))}
          {projectsQuery.data?.length === 0 && (
            <Typography color="text.secondary">No Projects you can see yet.</Typography>
          )}
        </List>
      </Box>

      <Box sx={{ flex: 1 }}>
        {selectedProjectId ? (
          <ProjectDetailPanel
            key={selectedProjectId}
            projectId={selectedProjectId}
            onDeleted={() => setSelectedProjectId(null)}
          />
        ) : (
          <Typography color="text.secondary">Select a Project to view details.</Typography>
        )}
      </Box>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>New Project</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="Name" value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus fullWidth />
            <TextField
              label="Description"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              multiline
              minRows={2}
              fullWidth
            />
            <FormControl fullWidth>
              <InputLabel id="new-project-label">Classification</InputLabel>
              <Select
                labelId="new-project-label"
                label="Classification"
                value={newLabelId}
                onChange={(e) => setNewLabelId(e.target.value)}
              >
                <MenuItem value="">
                  <em>Deployment default</em>
                </MenuItem>
                {labelsQuery.data?.map((label) => (
                  <MenuItem key={label.id} value={label.id}>
                    {label.text}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button variant="contained" disabled={!newName || createProject.isPending} onClick={() => createProject.mutate()}>
            Create
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

function ProjectDetailPanel({ projectId, onDeleted }: { projectId: string; onDeleted: () => void }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editLabelId, setEditLabelId] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferUserId, setTransferUserId] = useState<string | null>(null);
  const [transferUserSearch, setTransferUserSearch] = useState("");
  const [transferError, setTransferError] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: ["projects", projectId],
    queryFn: () => apiFetch<ProjectDetail>(`/api/projects/${projectId}`),
  });
  const labelsQuery = useQuery({
    queryKey: ["classification-labels"],
    queryFn: () => apiFetch<ClassificationLabel[]>("/api/classification-labels"),
  });

  useEffect(() => {
    if (detailQuery.data) {
      setEditName(detailQuery.data.name);
      setEditDescription(detailQuery.data.description ?? "");
      setEditLabelId(detailQuery.data.classificationLabel?.id ?? "");
    }
  }, [detailQuery.data]);

  const updateProject = useMutation({
    mutationFn: () =>
      apiFetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editName,
          description: editDescription || undefined,
          classificationLabelId: editLabelId || null,
        }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["projects", projectId] });
      setEditOpen(false);
    },
  });

  const deleteProject = useMutation({
    mutationFn: () => apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      onDeleted();
    },
    onError: (err: unknown) => setDeleteError(err instanceof Error ? err.message : "delete failed"),
  });

  const usersQuery = useQuery({
    queryKey: ["users", transferUserSearch],
    queryFn: () => apiFetch<UserSummary[]>(`/api/users?search=${encodeURIComponent(transferUserSearch)}`),
    enabled: transferOpen && transferUserSearch.length > 1,
  });

  const transferOwnership = useMutation({
    mutationFn: () =>
      apiFetch(`/api/projects/${projectId}/transfer-ownership`, {
        method: "POST",
        body: JSON.stringify({ newOwnerId: transferUserId }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["projects", projectId] });
      setTransferOpen(false);
      setTransferUserId(null);
    },
    onError: (err: unknown) => setTransferError(err instanceof Error ? err.message : "transfer failed"),
  });

  if (!detailQuery.data) {
    return null;
  }
  const project = detailQuery.data;
  const canEdit = project.effectiveAccess !== "READ";

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="h5">{project.name}</Typography>
          <ClassificationBadge label={project.classificationLabel} />
        </Stack>
        <Stack direction="row" spacing={1}>
          {canEdit && (
            <Button size="small" onClick={() => setEditOpen(true)}>
              Edit
            </Button>
          )}
          {project.effectiveAccess === "OWNER" && (
            <Button size="small" onClick={() => setTransferOpen(true)}>
              Transfer Ownership
            </Button>
          )}
          {project.effectiveAccess === "OWNER" && (
            <Button
              size="small"
              color="error"
              disabled={deleteProject.isPending}
              onClick={async () => {
                const ok = await confirm({
                  title: "Delete project?",
                  message: `Delete "${project.name}" and everything in it — its prompts, jobs, and schedules? This can't be undone.`,
                });
                if (ok) deleteProject.mutate();
              }}
            >
              Delete
            </Button>
          )}
        </Stack>
      </Stack>
      {deleteError && (
        <Alert severity="error" onClose={() => setDeleteError(null)}>
          {deleteError}
        </Alert>
      )}
      {project.description && <Typography color="text.secondary">{project.description}</Typography>}
      <Typography variant="body2">
        Owner: {project.owner.displayName ?? project.owner.email} · Your access: {project.effectiveAccess}
      </Typography>

      <Divider />
      <ProjectPromptsPanel projectId={project.id} canEdit={project.effectiveAccess !== "READ"} />

      <Divider />
      <ProjectJobsPanel projectId={project.id} canEdit={project.effectiveAccess !== "READ"} />

      {project.effectiveAccess === "OWNER" && (
        <>
          <Divider />
          <ProjectSharingPanel projectId={project.id} />
        </>
      )}

      <Dialog open={editOpen} onClose={() => setEditOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Edit Project</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="Name" value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus fullWidth />
            <TextField
              label="Description"
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              multiline
              minRows={2}
              fullWidth
            />
            <FormControl fullWidth>
              <InputLabel id="edit-project-label">Classification</InputLabel>
              <Select
                labelId="edit-project-label"
                label="Classification"
                value={editLabelId}
                onChange={(e) => setEditLabelId(e.target.value)}
              >
                <MenuItem value="">
                  <em>Deployment default</em>
                </MenuItem>
                {labelsQuery.data?.map((label) => (
                  <MenuItem key={label.id} value={label.id}>
                    {label.text}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!editName || updateProject.isPending}
            onClick={() => updateProject.mutate()}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={transferOpen}
        onClose={() => {
          setTransferOpen(false);
          setTransferError(null);
        }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Transfer Ownership</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              The new owner gets full control (sharing, deletion, and all EDIT/READ decisions). You keep
              whatever access, if any, you already have via a sharing grant — this doesn't add one.
            </Typography>
            {transferError && (
              <Alert severity="error" onClose={() => setTransferError(null)}>
                {transferError}
              </Alert>
            )}
            <Autocomplete
              options={usersQuery.data ?? []}
              getOptionLabel={(u) => `${u.displayName ?? u.email} (${u.email})`}
              onInputChange={(_e, value) => setTransferUserSearch(value)}
              onChange={(_e, value) => setTransferUserId(value?.id ?? null)}
              renderInput={(params) => <TextField {...params} label="New owner" autoFocus />}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setTransferOpen(false);
              setTransferError(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            color="warning"
            disabled={!transferUserId || transferOwnership.isPending}
            onClick={() => transferOwnership.mutate()}
          >
            Transfer
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

interface Prompt {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
}

function ProjectPromptsPanel({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [openPromptId, setOpenPromptId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [content, setContent] = useState("");
  const [variables, setVariables] = useState<PromptVariableDraft[]>([]);

  const promptsQuery = useQuery({
    queryKey: ["projects", projectId, "prompts"],
    queryFn: () => apiFetch<Prompt[]>(`/api/projects/${projectId}/prompts`),
  });

  const createPrompt = useMutation({
    mutationFn: () =>
      apiFetch(`/api/projects/${projectId}/prompts`, {
        method: "POST",
        body: JSON.stringify({
          name,
          description: description || undefined,
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          content,
          variables: variables
            .filter((v) => v.name)
            .map((v) => ({ name: v.name, type: v.type, defaultValue: v.defaultValue || undefined })),
        }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects", projectId, "prompts"] });
      setCreateOpen(false);
      setName("");
      setDescription("");
      setTags("");
      setContent("");
      setVariables([]);
    },
  });

  return (
    <Stack spacing={1}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="subtitle1">Prompts</Typography>
        {canEdit && (
          <Button size="small" onClick={() => setCreateOpen(true)}>
            New Prompt
          </Button>
        )}
      </Stack>

      <List dense>
        {promptsQuery.data?.map((prompt) => (
          <ListItem key={prompt.id} disablePadding>
            <ListItemButton onClick={() => setOpenPromptId(prompt.id)}>
              <ListItemText
                primary={prompt.name}
                secondary={prompt.tags.join(", ") || prompt.description}
              />
            </ListItemButton>
          </ListItem>
        ))}
        {promptsQuery.data?.length === 0 && (
          <Typography color="text.secondary">No prompts in this Project yet.</Typography>
        )}
      </List>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>New Prompt</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus fullWidth />
            <TextField
              label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              fullWidth
            />
            <TextField
              label="Tags (comma-separated)"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              fullWidth
            />
            <TextField
              label="Prompt content"
              helperText="Use {{variable}} placeholders — built-ins: date, datetime, schedule_name, run_id"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              multiline
              minRows={4}
              fullWidth
            />
            <VariableEditor variables={variables} onChange={setVariables} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!name || !content || createPrompt.isPending}
            onClick={() => createPrompt.mutate()}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>

      {openPromptId && <PromptDetailDialog promptId={openPromptId} onClose={() => setOpenPromptId(null)} />}
    </Stack>
  );
}

interface Job {
  id: string;
  name: string;
  agentId: string;
  promptId: string;
  apiKeyId: string;
  timeoutSeconds: number;
  maxRetries: number;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
  attachPdfToEmail: boolean;
}

interface ApiKeyOption {
  id: string;
  label: string | null;
  ownerType: "USER" | "TEAM";
}

interface JobFormValues {
  name: string;
  promptId: string;
  agentId: string;
  apiKeyId: string;
  timeoutSeconds: number;
  maxRetries: number;
}

interface DiscoveredAgent {
  id: string;
  name: string | null;
}

// Shared between the New Job and Edit Job dialogs so the agent-discovery
// picker (REQUIREMENTS §2.1: offer a picker built from whichever Agents
// the selected key can see, falling back to manual entry) only exists
// in one place.
function JobFormFields({
  values,
  onChange,
  prompts,
  apiKeys,
  discoveredAgents,
  agentsQuery,
}: {
  values: JobFormValues;
  onChange: (next: JobFormValues) => void;
  prompts: Prompt[] | undefined;
  apiKeys: ApiKeyOption[] | undefined;
  discoveredAgents: DiscoveredAgent[];
  agentsQuery: { isError: boolean; isLoading: boolean };
}) {
  return (
    <Stack spacing={2} sx={{ mt: 1 }}>
      <TextField
        label="Name"
        value={values.name}
        onChange={(e) => onChange({ ...values, name: e.target.value })}
        autoFocus
        fullWidth
      />
      <FormControl fullWidth>
        <InputLabel id="job-prompt-label">Prompt</InputLabel>
        <Select
          labelId="job-prompt-label"
          label="Prompt"
          value={values.promptId}
          onChange={(e) => onChange({ ...values, promptId: e.target.value })}
        >
          {prompts?.map((p) => (
            <MenuItem key={p.id} value={p.id}>
              {p.name}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <FormControl fullWidth>
        <InputLabel id="job-apikey-label">API Key</InputLabel>
        <Select
          labelId="job-apikey-label"
          label="API Key"
          value={values.apiKeyId}
          onChange={(e) => onChange({ ...values, apiKeyId: e.target.value, agentId: "" })}
        >
          {apiKeys?.map((k) => (
            <MenuItem key={k.id} value={k.id}>
              {k.label ?? "(unlabeled)"} {k.ownerType === "TEAM" ? "(Team)" : "(Personal)"}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      {discoveredAgents.length > 0 ? (
        <FormControl fullWidth>
          <InputLabel id="job-agent-label">Agent</InputLabel>
          <Select
            labelId="job-agent-label"
            label="Agent"
            value={values.agentId}
            onChange={(e) => onChange({ ...values, agentId: e.target.value })}
          >
            {discoveredAgents.map((agent) => (
              <MenuItem key={agent.id} value={agent.id}>
                {agent.name ? `${agent.name} (${agent.id})` : agent.id}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      ) : (
        <TextField
          label="LibreChat Agent ID"
          value={values.agentId}
          onChange={(e) => onChange({ ...values, agentId: e.target.value })}
          fullWidth
          helperText={
            values.apiKeyId && agentsQuery.isError
              ? "Couldn't auto-discover Agents for this key — enter the ID manually."
              : values.apiKeyId && agentsQuery.isLoading
                ? "Looking up available Agents…"
                : undefined
          }
        />
      )}
      <Stack direction="row" spacing={2}>
        <TextField
          label="Timeout (seconds)"
          type="number"
          value={values.timeoutSeconds}
          onChange={(e) => onChange({ ...values, timeoutSeconds: Number(e.target.value) })}
          fullWidth
        />
        <TextField
          label="Max retries"
          type="number"
          value={values.maxRetries}
          onChange={(e) => onChange({ ...values, maxRetries: Number(e.target.value) })}
          fullWidth
        />
      </Stack>
    </Stack>
  );
}

// Jobs live inside a Project the same way Prompts do — one call to
// create a LibreChat agent invocation, ready to be attached to one or
// more Schedules (REQUIREMENTS §2.1).
const BLANK_JOB_FORM: JobFormValues = {
  name: "",
  promptId: "",
  agentId: "",
  apiKeyId: "",
  timeoutSeconds: 600,
  maxRetries: 2,
};

function ProjectJobsPanel({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<JobFormValues>(BLANK_JOB_FORM);
  const [editingJob, setEditingJob] = useState<Job | null>(null);
  const [editForm, setEditForm] = useState<JobFormValues>(BLANK_JOB_FORM);
  const [scheduleJob, setScheduleJob] = useState<Job | null>(null);
  const [webhooksJobId, setWebhooksJobId] = useState<string | null>(null);
  const [runsJobId, setRunsJobId] = useState<string | null>(null);
  const [notificationsJob, setNotificationsJob] = useState<Job | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const jobsQuery = useQuery({
    queryKey: ["projects", projectId, "jobs"],
    queryFn: () => apiFetch<Job[]>(`/api/projects/${projectId}/jobs`),
  });
  const promptsQuery = useQuery({
    queryKey: ["projects", projectId, "prompts"],
    queryFn: () => apiFetch<Prompt[]>(`/api/projects/${projectId}/prompts`),
  });
  const apiKeysQuery = useQuery({
    queryKey: ["api-keys"],
    queryFn: () => apiFetch<ApiKeyOption[]>("/api/api-keys"),
  });
  // Agent discovery (REQUIREMENTS §2.1): offer a picker built from
  // whichever Agents the selected key can see, falling back to a plain
  // text field below if this fails — LibreChat not reachable, this
  // deployment's version doesn't expose the discovery endpoint, no key
  // selected yet, etc. Never blocks Job creation/editing either way.
  // Shared across both the create and edit forms since only one of the
  // two dialogs is ever open at a time.
  const activeApiKeyId = createOpen ? createForm.apiKeyId : editForm.apiKeyId;
  const agentsQuery = useQuery({
    queryKey: ["api-keys", activeApiKeyId, "agents"],
    queryFn: () => apiFetch<DiscoveredAgent[]>(`/api/api-keys/${activeApiKeyId}/agents`),
    enabled: !!activeApiKeyId,
    retry: false,
  });
  const discoveredAgents = activeApiKeyId ? agentsQuery.data ?? [] : [];

  const createJob = useMutation({
    mutationFn: () =>
      apiFetch(`/api/projects/${projectId}/jobs`, {
        method: "POST",
        body: JSON.stringify(createForm),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects", projectId, "jobs"] });
      setCreateOpen(false);
      setCreateForm(BLANK_JOB_FORM);
    },
  });

  const updateJob = useMutation({
    mutationFn: () => apiFetch(`/api/jobs/${editingJob!.id}`, { method: "PATCH", body: JSON.stringify(editForm) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects", projectId, "jobs"] });
      setEditingJob(null);
    },
  });

  const deleteJob = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/jobs/${id}`, { method: "DELETE" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["projects", projectId, "jobs"] }),
    onError: (err: unknown) => setDeleteError(err instanceof Error ? err.message : "delete failed"),
  });

  const openEdit = (job: Job) => {
    setEditingJob(job);
    setEditForm({
      name: job.name,
      promptId: job.promptId,
      agentId: job.agentId,
      apiKeyId: job.apiKeyId,
      timeoutSeconds: job.timeoutSeconds,
      maxRetries: job.maxRetries,
    });
  };

  return (
    <Stack spacing={1}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="subtitle1">Jobs</Typography>
        {canEdit && (
          <Button
            size="small"
            onClick={() => setCreateOpen(true)}
            disabled={promptsQuery.data?.length === 0}
          >
            New Job
          </Button>
        )}
      </Stack>
      {canEdit && promptsQuery.data?.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          Add a Prompt to this Project before creating a Job.
        </Typography>
      )}
      {deleteError && (
        <Alert severity="error" onClose={() => setDeleteError(null)}>
          {deleteError}
        </Alert>
      )}

      <List dense>
        {jobsQuery.data?.map((job) => (
          <ListItem
            key={job.id}
            secondaryAction={
              <Stack direction="row" spacing={1}>
                <Button size="small" onClick={() => setRunsJobId(job.id)}>
                  Runs
                </Button>
                <Button size="small" onClick={() => setWebhooksJobId(job.id)}>
                  Webhooks
                </Button>
                <Button size="small" onClick={() => setNotificationsJob(job)}>
                  Notify
                </Button>
                <Button size="small" onClick={() => setScheduleJob(job)}>
                  Schedules
                </Button>
                {canEdit && (
                  <>
                    <Button size="small" onClick={() => openEdit(job)}>
                      Edit
                    </Button>
                    <Button
                      size="small"
                      color="error"
                      disabled={deleteJob.isPending}
                      onClick={async () => {
                        const ok = await confirm({
                          title: "Delete job?",
                          message: `Delete "${job.name}" and its schedules? This can't be undone.`,
                        });
                        if (ok) deleteJob.mutate(job.id);
                      }}
                    >
                      Delete
                    </Button>
                  </>
                )}
              </Stack>
            }
          >
            <ListItemText primary={job.name} secondary={`Agent: ${job.agentId}`} />
          </ListItem>
        ))}
        {jobsQuery.data?.length === 0 && (
          <Typography color="text.secondary">No Jobs in this Project yet.</Typography>
        )}
      </List>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>New Job</DialogTitle>
        <DialogContent>
          <JobFormFields
            values={createForm}
            onChange={setCreateForm}
            prompts={promptsQuery.data}
            apiKeys={apiKeysQuery.data}
            discoveredAgents={discoveredAgents}
            agentsQuery={agentsQuery}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!createForm.name || !createForm.promptId || !createForm.agentId || !createForm.apiKeyId || createJob.isPending}
            onClick={() => createJob.mutate()}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!editingJob} onClose={() => setEditingJob(null)} fullWidth maxWidth="sm">
        <DialogTitle>Edit Job</DialogTitle>
        <DialogContent>
          <JobFormFields
            values={editForm}
            onChange={setEditForm}
            prompts={promptsQuery.data}
            apiKeys={apiKeysQuery.data}
            discoveredAgents={discoveredAgents}
            agentsQuery={agentsQuery}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditingJob(null)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!editForm.name || !editForm.promptId || !editForm.agentId || !editForm.apiKeyId || updateJob.isPending}
            onClick={() => updateJob.mutate()}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>

      {scheduleJob && (
        <ScheduleManagerDialog
          jobId={scheduleJob.id}
          promptId={scheduleJob.promptId}
          onClose={() => setScheduleJob(null)}
        />
      )}
      {webhooksJobId && (
        <JobWebhooksDialog jobId={webhooksJobId} onClose={() => setWebhooksJobId(null)} />
      )}
      {runsJobId && (
        <RunHistoryDialog jobId={runsJobId} canRun={canEdit} onClose={() => setRunsJobId(null)} />
      )}
      {notificationsJob && (
        <JobNotificationsDialog
          jobId={notificationsJob.id}
          initial={{
            notifyOnSuccess: notificationsJob.notifyOnSuccess,
            notifyOnFailure: notificationsJob.notifyOnFailure,
            attachPdfToEmail: notificationsJob.attachPdfToEmail,
          }}
          onClose={() => setNotificationsJob(null)}
        />
      )}
    </Stack>
  );
}

// Sharing config is owner-only to view/edit (REQUIREMENTS §2.3 — "a
// Project owner can share a Project"), matching the API's OWNER-gated
// /acl endpoints.
function ProjectSharingPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [granteeType, setGranteeType] = useState<"USER" | "TEAM" | "ORG">("USER");
  const [granteeUserId, setGranteeUserId] = useState<string | null>(null);
  const [granteeTeamId, setGranteeTeamId] = useState<string | null>(null);
  const [accessLevel, setAccessLevel] = useState<"READ" | "EDIT">("READ");
  const [userSearch, setUserSearch] = useState("");

  const aclQuery = useQuery({
    queryKey: ["projects", projectId, "acl"],
    queryFn: () => apiFetch<ProjectAcl[]>(`/api/projects/${projectId}/acl`),
  });
  const teamsQuery = useQuery({ queryKey: ["teams"], queryFn: () => apiFetch<Team[]>("/api/teams") });
  const usersQuery = useQuery({
    queryKey: ["users", userSearch],
    queryFn: () => apiFetch<UserSummary[]>(`/api/users?search=${encodeURIComponent(userSearch)}`),
    enabled: granteeType === "USER" && userSearch.length > 1,
  });

  const grant = useMutation({
    mutationFn: () =>
      apiFetch(`/api/projects/${projectId}/acl`, {
        method: "POST",
        body: JSON.stringify({
          granteeType,
          granteeUserId: granteeType === "USER" ? granteeUserId ?? undefined : undefined,
          granteeTeamId: granteeType === "TEAM" ? granteeTeamId ?? undefined : undefined,
          accessLevel,
        }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects", projectId, "acl"] });
      setGranteeUserId(null);
      setGranteeTeamId(null);
    },
  });

  const revoke = useMutation({
    mutationFn: (aclId: string) => apiFetch(`/api/projects/${projectId}/acl/${aclId}`, { method: "DELETE" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["projects", projectId, "acl"] }),
  });

  const updateAccessLevel = useMutation({
    mutationFn: ({ aclId, accessLevel: level }: { aclId: string; accessLevel: "READ" | "EDIT" }) =>
      apiFetch(`/api/projects/${projectId}/acl/${aclId}`, {
        method: "PATCH",
        body: JSON.stringify({ accessLevel: level }),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["projects", projectId, "acl"] }),
  });

  const canGrant =
    granteeType === "ORG" || (granteeType === "USER" && granteeUserId) || (granteeType === "TEAM" && granteeTeamId);

  return (
    <Stack spacing={2}>
      <Typography variant="subtitle1">Sharing</Typography>

      <List dense>
        {aclQuery.data?.map((acl) => (
          <ListItem
            key={acl.id}
            secondaryAction={
              <Stack direction="row" spacing={1} alignItems="center">
                <FormControl size="small" sx={{ minWidth: 90 }}>
                  <Select
                    value={acl.accessLevel}
                    disabled={updateAccessLevel.isPending}
                    onChange={(e) =>
                      updateAccessLevel.mutate({ aclId: acl.id, accessLevel: e.target.value as "READ" | "EDIT" })
                    }
                  >
                    <MenuItem value="READ">Read</MenuItem>
                    <MenuItem value="EDIT">Edit</MenuItem>
                  </Select>
                </FormControl>
                <Button
                  size="small"
                  color="error"
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Revoke access?",
                      message: `Revoke ${acl.accessLevel} access for this ${acl.granteeType.toLowerCase()}${acl.granteeType === "ORG" ? " (everyone)" : ""}?`,
                      confirmLabel: "Revoke",
                    });
                    if (ok) revoke.mutate(acl.id);
                  }}
                >
                  Revoke
                </Button>
              </Stack>
            }
          >
            <ListItemText primary={`${acl.granteeType}${acl.granteeType === "ORG" ? " (everyone)" : ""}`} />
          </ListItem>
        ))}
        {aclQuery.data?.length === 0 && (
          <Typography color="text.secondary">Private — not shared with anyone yet.</Typography>
        )}
      </List>

      <Divider />

      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
        <FormControl size="small" sx={{ minWidth: 120 }}>
          <InputLabel id="grantee-type-label">Share with</InputLabel>
          <Select
            labelId="grantee-type-label"
            label="Share with"
            value={granteeType}
            onChange={(e) => setGranteeType(e.target.value as typeof granteeType)}
          >
            <MenuItem value="USER">A user</MenuItem>
            <MenuItem value="TEAM">A Team</MenuItem>
            <MenuItem value="ORG">Everyone (org-wide)</MenuItem>
          </Select>
        </FormControl>

        {granteeType === "USER" && (
          <Autocomplete
            size="small"
            sx={{ minWidth: 240 }}
            options={usersQuery.data ?? []}
            getOptionLabel={(u) => `${u.displayName ?? u.email} (${u.email})`}
            onInputChange={(_e, value) => setUserSearch(value)}
            onChange={(_e, value) => setGranteeUserId(value?.id ?? null)}
            renderInput={(params) => <TextField {...params} label="User" />}
          />
        )}
        {granteeType === "TEAM" && (
          <Autocomplete
            size="small"
            sx={{ minWidth: 240 }}
            options={teamsQuery.data ?? []}
            getOptionLabel={(t) => t.name}
            onChange={(_e, value) => setGranteeTeamId(value?.id ?? null)}
            renderInput={(params) => <TextField {...params} label="Team" />}
          />
        )}

        <FormControl size="small" sx={{ minWidth: 100 }}>
          <InputLabel id="access-level-label">Access</InputLabel>
          <Select
            labelId="access-level-label"
            label="Access"
            value={accessLevel}
            onChange={(e) => setAccessLevel(e.target.value as typeof accessLevel)}
          >
            <MenuItem value="READ">Read</MenuItem>
            <MenuItem value="EDIT">Edit</MenuItem>
          </Select>
        </FormControl>

        <Button variant="contained" disabled={!canGrant || grant.isPending} onClick={() => grant.mutate()}>
          Share
        </Button>
      </Stack>
    </Stack>
  );
}
