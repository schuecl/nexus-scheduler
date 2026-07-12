import { useState } from "react";
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

interface Schedule {
  id: string;
  type: "ONE_TIME" | "RECURRING";
  runAt: string | null;
  timezone: string;
  paused: boolean;
  approvalStatus: "DRAFT" | "PENDING" | "APPROVED" | "REJECTED";
  nextFireAt: string | null;
  versionPinMode: "PINNED" | "LATEST";
}

interface PromptVersion {
  id: string;
  versionNumber: number;
}

interface PromptDetail {
  versions: PromptVersion[];
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

  const schedulesQuery = useQuery({
    queryKey: ["jobs", jobId, "schedules"],
    queryFn: () => apiFetch<Schedule[]>(`/api/jobs/${jobId}/schedules`),
  });
  const promptQuery = useQuery({
    queryKey: ["prompts", promptId],
    queryFn: () => apiFetch<PromptDetail>(`/api/prompts/${promptId}`),
    enabled: versionPinMode === "PINNED",
  });

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
        }),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["jobs", jobId, "schedules"] });
      setCreating(false);
    },
  });

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

          {!creating ? (
            <Button onClick={() => setCreating(true)} sx={{ alignSelf: "flex-start" }}>
              New Schedule
            </Button>
          ) : (
            <Stack spacing={2}>
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

              {createSchedule.isError && <Alert severity="error">Could not create schedule.</Alert>}

              <Stack direction="row" spacing={1}>
                <Button
                  variant="contained"
                  disabled={
                    createSchedule.isPending ||
                    (type === "ONE_TIME" && !runAt) ||
                    (versionPinMode === "PINNED" && !pinnedPromptVersionId)
                  }
                  onClick={() => createSchedule.mutate()}
                >
                  Create
                </Button>
                <Button onClick={() => setCreating(false)}>Cancel</Button>
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
