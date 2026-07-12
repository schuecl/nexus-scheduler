import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
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
          <ProjectDetailPanel projectId={selectedProjectId} />
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

function ProjectDetailPanel({ projectId }: { projectId: string }) {
  const detailQuery = useQuery({
    queryKey: ["projects", projectId],
    queryFn: () => apiFetch<ProjectDetail>(`/api/projects/${projectId}`),
  });

  if (!detailQuery.data) {
    return null;
  }
  const project = detailQuery.data;

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="h5">{project.name}</Typography>
        <ClassificationBadge label={project.classificationLabel} />
      </Stack>
      {project.description && <Typography color="text.secondary">{project.description}</Typography>}
      <Typography variant="body2">Your access: {project.effectiveAccess}</Typography>

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
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
  attachPdfToEmail: boolean;
}

interface ApiKeyOption {
  id: string;
  label: string | null;
  ownerType: "USER" | "TEAM";
}

// Jobs live inside a Project the same way Prompts do — one call to
// create a LibreChat agent invocation, ready to be attached to one or
// more Schedules (REQUIREMENTS §2.1).
function ProjectJobsPanel({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [scheduleJob, setScheduleJob] = useState<Job | null>(null);
  const [webhooksJobId, setWebhooksJobId] = useState<string | null>(null);
  const [runsJobId, setRunsJobId] = useState<string | null>(null);
  const [notificationsJob, setNotificationsJob] = useState<Job | null>(null);
  const [name, setName] = useState("");
  const [promptId, setPromptId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [apiKeyId, setApiKeyId] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(600);
  const [maxRetries, setMaxRetries] = useState(2);

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

  const createJob = useMutation({
    mutationFn: () =>
      apiFetch(`/api/projects/${projectId}/jobs`, {
        method: "POST",
        body: JSON.stringify({ name, promptId, agentId, apiKeyId, timeoutSeconds, maxRetries }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects", projectId, "jobs"] });
      setCreateOpen(false);
      setName("");
      setPromptId("");
      setAgentId("");
      setApiKeyId("");
    },
  });

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
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus fullWidth />
            <FormControl fullWidth>
              <InputLabel id="job-prompt-label">Prompt</InputLabel>
              <Select
                labelId="job-prompt-label"
                label="Prompt"
                value={promptId}
                onChange={(e) => setPromptId(e.target.value)}
              >
                {promptsQuery.data?.map((p) => (
                  <MenuItem key={p.id} value={p.id}>
                    {p.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField
              label="LibreChat Agent ID"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              fullWidth
            />
            <FormControl fullWidth>
              <InputLabel id="job-apikey-label">API Key</InputLabel>
              <Select
                labelId="job-apikey-label"
                label="API Key"
                value={apiKeyId}
                onChange={(e) => setApiKeyId(e.target.value)}
              >
                {apiKeysQuery.data?.map((k) => (
                  <MenuItem key={k.id} value={k.id}>
                    {k.label ?? "(unlabeled)"} {k.ownerType === "TEAM" ? "(Team)" : "(Personal)"}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Stack direction="row" spacing={2}>
              <TextField
                label="Timeout (seconds)"
                type="number"
                value={timeoutSeconds}
                onChange={(e) => setTimeoutSeconds(Number(e.target.value))}
                fullWidth
              />
              <TextField
                label="Max retries"
                type="number"
                value={maxRetries}
                onChange={(e) => setMaxRetries(Number(e.target.value))}
                fullWidth
              />
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!name || !promptId || !agentId || !apiKeyId || createJob.isPending}
            onClick={() => createJob.mutate()}
          >
            Create
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
              <Button size="small" color="error" onClick={() => revoke.mutate(acl.id)}>
                Revoke
              </Button>
            }
          >
            <ListItemText
              primary={`${acl.granteeType}${acl.granteeType === "ORG" ? " (everyone)" : ""} — ${acl.accessLevel}`}
            />
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
