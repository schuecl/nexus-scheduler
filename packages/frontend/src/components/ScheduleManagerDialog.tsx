import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
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
  ListItemText,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { apiFetch } from "../api/client";
import type { PromptVariableDraft } from "./VariableEditor";

interface Schedule {
  id: string;
  type: "ONE_TIME" | "RECURRING";
  runAt: string | null;
  intervalConfig: Record<string, unknown> | null;
  timezone: string;
  paused: boolean;
  approvalStatus: "DRAFT" | "PENDING" | "APPROVED" | "REJECTED";
  nextFireAt: string | null;
  versionPinMode: "PINNED" | "LATEST";
  pinnedPromptVersionId: string | null;
  variableValues: Record<string, string>;
}

interface PromptVersion {
  id: string;
  versionNumber: number;
  variables: PromptVariableDraft[];
}

interface PromptDetail {
  versions: PromptVersion[]; // ordered newest first (§2.3)
}

const DEFAULT_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

type IntervalKind = "every_n_minutes" | "every_n_hours" | "daily" | "weekly";

export function ScheduleManagerDialog({
  jobId,
  promptId,
  onClose,
}: {
  jobId: string;
  promptId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null);
  const formOpen = creating || !!editingScheduleId;

  const [type, setType] = useState<"ONE_TIME" | "RECURRING">("RECURRING");
  const [runAt, setRunAt] = useState("");
  const [intervalKind, setIntervalKind] = useState<IntervalKind>("daily");
  const [minutes, setMinutes] = useState(30);
  const [hours, setHours] = useState(1);
  const [atTime, setAtTime] = useState("09:00");
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([1]);
  const [timezone, setTimezone] = useState(DEFAULT_TZ);
  const [versionPinMode, setVersionPinMode] = useState<"PINNED" | "LATEST">("LATEST");
  const [pinnedPromptVersionId, setPinnedPromptVersionId] = useState("");
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});

  const schedulesQuery = useQuery({
    queryKey: ["jobs", jobId, "schedules"],
    queryFn: () => apiFetch<Schedule[]>(`/api/jobs/${jobId}/schedules`),
  });
  // Always fetched (not just when PINNED) — needed to know which
  // {{variable}}s the *latest* version declares too, so the create form
  // can offer value overrides regardless of pin mode (§2.3).
  const promptQuery = useQuery({
    queryKey: ["prompts", promptId],
    queryFn: () => apiFetch<PromptDetail>(`/api/prompts/${promptId}`),
  });

  const effectiveVersion =
    versionPinMode === "PINNED"
      ? promptQuery.data?.versions.find((v) => v.id === pinnedPromptVersionId)
      : promptQuery.data?.versions[0];
  const effectiveVariables = effectiveVersion?.variables ?? [];

  // Reset the value inputs to the newly-effective version's declared
  // defaults whenever which version is "effective" changes — except
  // right after openEdit() populates variableValues from an existing
  // schedule's saved overrides, where this same dependency can also
  // change (pinnedPromptVersionId/versionPinMode are set together with
  // it) and would otherwise immediately clobber those saved overrides
  // with fresh defaults before the user sees them.
  const skipNextVariableResetRef = useRef(false);
  useEffect(() => {
    if (skipNextVariableResetRef.current) {
      skipNextVariableResetRef.current = false;
      return;
    }
    setVariableValues(
      Object.fromEntries(effectiveVariables.map((v) => [v.name, v.defaultValue ?? ""])),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveVersion?.id]);

  const createSchedule = useMutation({
    mutationFn: () => {
      const intervalConfig =
        intervalKind === "every_n_minutes"
          ? { kind: intervalKind, minutes }
          : intervalKind === "every_n_hours"
            ? { kind: intervalKind, hours, atMinute: 0 }
            : intervalKind === "daily"
              ? { kind: intervalKind, atTime }
              : { kind: intervalKind, daysOfWeek, atTime };

      return apiFetch(`/api/jobs/${jobId}/schedules`, {
        method: "POST",
        body: JSON.stringify({
          type,
          runAt: type === "ONE_TIME" ? new Date(runAt).toISOString() : undefined,
          intervalConfig: type === "RECURRING" ? intervalConfig : undefined,
          timezone,
          versionPinMode,
          pinnedPromptVersionId: versionPinMode === "PINNED" ? pinnedPromptVersionId : undefined,
          variableValues,
        }),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["jobs", jobId, "schedules"] });
      setCreating(false);
    },
  });

  // A schedule's ONE_TIME/RECURRING type is fixed after creation
  // (updateScheduleSchema deliberately has no `type` field) — editing
  // reuses the same form as creating, minus the type picker, and
  // resubmits as PATCH instead of POST.
  const openEdit = (schedule: Schedule) => {
    setType(schedule.type);
    if (schedule.type === "ONE_TIME" && schedule.runAt) {
      setRunAt(new Date(schedule.runAt).toISOString().slice(0, 16));
    }
    const cfg = schedule.intervalConfig as
      | { kind: IntervalKind; minutes?: number; hours?: number; atMinute?: number; atTime?: string; daysOfWeek?: number[] }
      | null;
    if (cfg) {
      setIntervalKind(cfg.kind);
      if (cfg.minutes !== undefined) setMinutes(cfg.minutes);
      if (cfg.hours !== undefined) setHours(cfg.hours);
      if (cfg.atTime !== undefined) setAtTime(cfg.atTime);
      if (cfg.daysOfWeek !== undefined) setDaysOfWeek(cfg.daysOfWeek);
    }
    setTimezone(schedule.timezone);
    skipNextVariableResetRef.current = true;
    setVersionPinMode(schedule.versionPinMode);
    setPinnedPromptVersionId(schedule.pinnedPromptVersionId ?? "");
    setVariableValues(schedule.variableValues ?? {});
    setEditingScheduleId(schedule.id);
  };

  const updateSchedule = useMutation({
    mutationFn: () => {
      const intervalConfig =
        intervalKind === "every_n_minutes"
          ? { kind: intervalKind, minutes }
          : intervalKind === "every_n_hours"
            ? { kind: intervalKind, hours, atMinute: 0 }
            : intervalKind === "daily"
              ? { kind: intervalKind, atTime }
              : { kind: intervalKind, daysOfWeek, atTime };

      return apiFetch(`/api/schedules/${editingScheduleId}`, {
        method: "PATCH",
        body: JSON.stringify({
          runAt: type === "ONE_TIME" ? new Date(runAt).toISOString() : undefined,
          intervalConfig: type === "RECURRING" ? intervalConfig : undefined,
          timezone,
          versionPinMode,
          pinnedPromptVersionId: versionPinMode === "PINNED" ? pinnedPromptVersionId : null,
          variableValues,
        }),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["jobs", jobId, "schedules"] });
      setEditingScheduleId(null);
    },
  });

  const closeForm = () => {
    setCreating(false);
    setEditingScheduleId(null);
  };

  const pauseSchedule = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/schedules/${id}/pause`, { method: "POST" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["jobs", jobId, "schedules"] }),
  });
  const resumeSchedule = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/schedules/${id}/resume`, { method: "POST" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["jobs", jobId, "schedules"] }),
  });
  const deleteSchedule = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/schedules/${id}`, { method: "DELETE" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["jobs", jobId, "schedules"] }),
  });

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Schedules</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <List dense>
            {schedulesQuery.data?.map((schedule) => (
              <ListItem
                key={schedule.id}
                divider
                secondaryAction={
                  <Stack direction="row" spacing={1}>
                    {schedule.approvalStatus === "APPROVED" &&
                      (schedule.paused ? (
                        <Button size="small" onClick={() => resumeSchedule.mutate(schedule.id)}>
                          Resume
                        </Button>
                      ) : (
                        <Button size="small" onClick={() => pauseSchedule.mutate(schedule.id)}>
                          Pause
                        </Button>
                      ))}
                    <Button size="small" onClick={() => openEdit(schedule)}>
                      Edit
                    </Button>
                    <Button size="small" color="error" onClick={() => deleteSchedule.mutate(schedule.id)}>
                      Delete
                    </Button>
                  </Stack>
                }
              >
                <ListItemText
                  primary={
                    <Stack direction="row" spacing={1} alignItems="center">
                      <span>{schedule.type === "ONE_TIME" ? "One-time" : "Recurring"}</span>
                      <Chip
                        size="small"
                        label={schedule.approvalStatus}
                        color={
                          schedule.approvalStatus === "APPROVED"
                            ? "success"
                            : schedule.approvalStatus === "PENDING"
                              ? "warning"
                              : schedule.approvalStatus === "REJECTED"
                                ? "error"
                                : "default"
                        }
                      />
                      {schedule.paused && <Chip size="small" label="Paused" />}
                    </Stack>
                  }
                  secondary={
                    schedule.nextFireAt
                      ? `Next run: ${new Date(schedule.nextFireAt).toLocaleString()} (${schedule.timezone})`
                      : `Timezone: ${schedule.timezone}`
                  }
                />
              </ListItem>
            ))}
            {schedulesQuery.data?.length === 0 && (
              <Typography color="text.secondary">No schedules yet for this Job.</Typography>
            )}
          </List>

          <Divider />

          {!formOpen ? (
            <Button onClick={() => setCreating(true)} sx={{ alignSelf: "flex-start" }}>
              New Schedule
            </Button>
          ) : (
            <Stack spacing={2}>
              {editingScheduleId ? (
                <Typography variant="body2" color="text.secondary">
                  {type === "ONE_TIME" ? "One-time" : "Recurring"} schedule — type can't be changed
                  after creation; delete and create a new one for that.
                </Typography>
              ) : (
                <FormControl fullWidth>
                  <InputLabel id="schedule-type-label">Type</InputLabel>
                  <Select
                    labelId="schedule-type-label"
                    label="Type"
                    value={type}
                    onChange={(e) => setType(e.target.value as typeof type)}
                  >
                    <MenuItem value="ONE_TIME">One-time</MenuItem>
                    <MenuItem value="RECURRING">Recurring</MenuItem>
                  </Select>
                </FormControl>
              )}

              {type === "ONE_TIME" ? (
                <TextField
                  label="Run at"
                  type="datetime-local"
                  value={runAt}
                  onChange={(e) => setRunAt(e.target.value)}
                  InputLabelProps={{ shrink: true }}
                  fullWidth
                />
              ) : (
                <>
                  <FormControl fullWidth>
                    <InputLabel id="interval-kind-label">Frequency</InputLabel>
                    <Select
                      labelId="interval-kind-label"
                      label="Frequency"
                      value={intervalKind}
                      onChange={(e) => setIntervalKind(e.target.value as IntervalKind)}
                    >
                      <MenuItem value="every_n_minutes">Every N minutes</MenuItem>
                      <MenuItem value="every_n_hours">Every N hours</MenuItem>
                      <MenuItem value="daily">Daily</MenuItem>
                      <MenuItem value="weekly">Weekly</MenuItem>
                    </Select>
                  </FormControl>

                  {intervalKind === "every_n_minutes" && (
                    <TextField
                      label="Minutes"
                      type="number"
                      value={minutes}
                      onChange={(e) => setMinutes(Number(e.target.value))}
                      fullWidth
                    />
                  )}
                  {intervalKind === "every_n_hours" && (
                    <TextField
                      label="Hours"
                      type="number"
                      value={hours}
                      onChange={(e) => setHours(Number(e.target.value))}
                      fullWidth
                    />
                  )}
                  {(intervalKind === "daily" || intervalKind === "weekly") && (
                    <TextField
                      label="Time of day"
                      type="time"
                      value={atTime}
                      onChange={(e) => setAtTime(e.target.value)}
                      InputLabelProps={{ shrink: true }}
                      fullWidth
                    />
                  )}
                  {intervalKind === "weekly" && (
                    <FormControl fullWidth>
                      <InputLabel id="dow-label">Days of week</InputLabel>
                      <Select
                        labelId="dow-label"
                        label="Days of week"
                        multiple
                        value={daysOfWeek}
                        onChange={(e) =>
                          setDaysOfWeek(
                            typeof e.target.value === "string"
                              ? e.target.value.split(",").map(Number)
                              : e.target.value,
                          )
                        }
                      >
                        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, idx) => (
                          <MenuItem key={idx} value={idx}>
                            {label}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  )}
                </>
              )}

              <TextField
                label="Time zone (IANA)"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                fullWidth
              />

              <FormControl fullWidth>
                <InputLabel id="version-pin-label">Prompt version</InputLabel>
                <Select
                  labelId="version-pin-label"
                  label="Prompt version"
                  value={versionPinMode}
                  onChange={(e) => setVersionPinMode(e.target.value as typeof versionPinMode)}
                >
                  <MenuItem value="LATEST">Always use latest</MenuItem>
                  <MenuItem value="PINNED">Pin to a specific version</MenuItem>
                </Select>
              </FormControl>
              {versionPinMode === "PINNED" && (
                <FormControl fullWidth>
                  <InputLabel id="pinned-version-label">Version</InputLabel>
                  <Select
                    labelId="pinned-version-label"
                    label="Version"
                    value={pinnedPromptVersionId}
                    onChange={(e) => setPinnedPromptVersionId(e.target.value)}
                  >
                    {promptQuery.data?.versions.map((v) => (
                      <MenuItem key={v.id} value={v.id}>
                        v{v.versionNumber}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              )}

              {effectiveVariables.length > 0 && (
                <Stack spacing={1}>
                  <Typography variant="subtitle2">Variable values</Typography>
                  {effectiveVariables.map((variable) => (
                    <TextField
                      key={variable.name}
                      label={variable.name}
                      type={variable.type === "number" ? "number" : variable.type === "date" ? "date" : "text"}
                      value={variableValues[variable.name] ?? ""}
                      onChange={(e) =>
                        setVariableValues((prev) => ({ ...prev, [variable.name]: e.target.value }))
                      }
                      InputLabelProps={variable.type === "date" ? { shrink: true } : undefined}
                      fullWidth
                    />
                  ))}
                </Stack>
              )}

              {(createSchedule.isError || updateSchedule.isError) && (
                <Alert severity="error">Could not save schedule.</Alert>
              )}

              <Stack direction="row" spacing={1}>
                <Button
                  variant="contained"
                  disabled={
                    createSchedule.isPending ||
                    updateSchedule.isPending ||
                    (type === "ONE_TIME" && !runAt) ||
                    (versionPinMode === "PINNED" && !pinnedPromptVersionId)
                  }
                  onClick={() => (editingScheduleId ? updateSchedule.mutate() : createSchedule.mutate())}
                >
                  {editingScheduleId ? "Save" : "Create"}
                </Button>
                <Button onClick={closeForm}>Cancel</Button>
              </Stack>
            </Stack>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
