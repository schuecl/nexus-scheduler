import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { useAuth } from "../context/AuthContext";
import { useSettings } from "../context/SettingsContext";
import { apiFetch } from "../api/client";

interface ClassificationLabel {
  id: string;
  text: string;
  abbreviation: string | null;
  badgeBgColor: string;
  badgeTextColor: string;
  sortOrder: number;
  isDefault: boolean;
}

export function AdminPage() {
  const { user } = useAuth();

  if (user?.role !== "ADMIN") {
    return <Typography color="error">Admin role required.</Typography>;
  }

  return (
    <Stack spacing={4}>
      <Typography variant="h4">Admin</Typography>
      <Typography color="text.secondary">
        SMTP configuration (REQUIREMENTS §5) still needs to be built here — everything else in
        §4-§8's admin surface is implemented below.
      </Typography>

      <SystemSettingsPanel />
      <Divider />
      <UserManagementPanel />
      <Divider />
      <ClassificationLabelsPanel />
      <Divider />
      <CostRatesPanel />
      <Divider />
      <WebhookDestinationsPanel />
    </Stack>
  );
}

interface WebhookDestination {
  id: string;
  name: string;
  url: string;
  active: boolean;
  createdAt: string;
}

// This list *is* the allow-list (REQUIREMENTS §2.2/§10) — a Job can only
// ever attach one of these rows, never an arbitrary URL a user typed in,
// which is what keeps outbound delivery from becoming an exfiltration
// path. The signing secret is generated and encrypted server-side; it's
// never entered here and never shown back.
function WebhookDestinationsPanel() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");

  const destinationsQuery = useQuery({
    queryKey: ["webhook-destinations"],
    queryFn: () => apiFetch<WebhookDestination[]>("/api/webhook-destinations"),
  });

  const createDestination = useMutation({
    mutationFn: () =>
      apiFetch("/api/webhook-destinations", { method: "POST", body: JSON.stringify({ name, url }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["webhook-destinations"] });
      setCreateOpen(false);
      setName("");
      setUrl("");
    },
  });

  const setActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      apiFetch(`/api/webhook-destinations/${id}`, { method: "PATCH", body: JSON.stringify({ active }) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["webhook-destinations"] }),
  });

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="h6">Webhook Destinations</Typography>
        <Button variant="contained" size="small" onClick={() => setCreateOpen(true)}>
          New Destination
        </Button>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Internal endpoints a Job's run results can be delivered to. Only destinations added here
        can ever be attached to a Job — there is no way to enter an arbitrary URL when configuring
        a Job's notifications.
      </Typography>

      <List dense>
        {destinationsQuery.data?.map((destination) => (
          <ListItem
            key={destination.id}
            divider
            secondaryAction={
              <Button
                size="small"
                color={destination.active ? "error" : "primary"}
                onClick={() => setActive.mutate({ id: destination.id, active: !destination.active })}
              >
                {destination.active ? "Disable" : "Enable"}
              </Button>
            }
          >
            <ListItemText
              primary={
                <Stack direction="row" spacing={1} alignItems="center">
                  <span>{destination.name}</span>
                  {!destination.active && <Chip size="small" label="Disabled" />}
                </Stack>
              }
              secondary={destination.url}
            />
          </ListItem>
        ))}
        {destinationsQuery.data?.length === 0 && (
          <Typography color="text.secondary">No webhook destinations configured yet.</Typography>
        )}
      </List>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>New Webhook Destination</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus fullWidth />
            <TextField
              label="URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              helperText="Must be an internal endpoint reachable from the Worker"
              fullWidth
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!name || !url || createDestination.isPending}
            onClick={() => createDestination.mutate()}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

// Branding (§5) and the system-wide classification banner (§6) — one
// settings surface, two independent concerns. The banner is never
// derived from anything else here; it's just admin-set text/colors.
function SystemSettingsPanel() {
  const { settings, refetch } = useSettings();
  const [productName, setProductName] = useState(settings.productName);
  const [logoUrl, setLogoUrl] = useState(settings.logoUrl ?? "");
  const [primaryColor, setPrimaryColor] = useState(settings.primaryColor);
  const [bannerText, setBannerText] = useState(settings.classificationBannerText);
  const [bannerBg, setBannerBg] = useState(settings.classificationBannerBgColor);
  const [bannerFg, setBannerFg] = useState(settings.classificationBannerTextColor);

  // Settings arrive asynchronously (see SettingsContext) — seed the form
  // once they load rather than leaving fields stuck on the placeholder.
  useEffect(() => {
    setProductName(settings.productName);
    setLogoUrl(settings.logoUrl ?? "");
    setPrimaryColor(settings.primaryColor);
    setBannerText(settings.classificationBannerText);
    setBannerBg(settings.classificationBannerBgColor);
    setBannerFg(settings.classificationBannerTextColor);
  }, [settings]);

  const save = useMutation({
    mutationFn: () =>
      apiFetch("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          productName,
          logoUrl: logoUrl || null,
          primaryColor,
          classificationBannerText: bannerText,
          classificationBannerBgColor: bannerBg,
          classificationBannerTextColor: bannerFg,
        }),
      }),
    onSuccess: () => refetch(),
  });

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        Branding &amp; Classification Banner
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        The banner below is the single, static banner shown at the top and bottom of every page —
        independent of the per-Project/Prompt classification labels further down this page.
      </Typography>

      <Stack spacing={2} sx={{ maxWidth: 480 }}>
        <TextField label="Product name" value={productName} onChange={(e) => setProductName(e.target.value)} />
        <TextField
          label="Logo URL (optional)"
          value={logoUrl}
          onChange={(e) => setLogoUrl(e.target.value)}
        />
        <TextField
          label="Primary color"
          type="color"
          value={primaryColor}
          onChange={(e) => setPrimaryColor(e.target.value)}
        />
        <Divider />
        <TextField label="Classification banner text" value={bannerText} onChange={(e) => setBannerText(e.target.value)} />
        <Stack direction="row" spacing={2}>
          <TextField
            label="Banner background color"
            type="color"
            value={bannerBg}
            onChange={(e) => setBannerBg(e.target.value)}
            fullWidth
          />
          <TextField
            label="Banner text color"
            type="color"
            value={bannerFg}
            onChange={(e) => setBannerFg(e.target.value)}
            fullWidth
          />
        </Stack>
        {save.isSuccess && <Alert severity="success">Saved.</Alert>}
        <Button variant="contained" disabled={save.isPending} onClick={() => save.mutate()} sx={{ alignSelf: "flex-start" }}>
          Save
        </Button>
      </Stack>
    </Box>
  );
}

interface AdminUser {
  id: string;
  email: string;
  displayName: string | null;
  role: "ADMIN" | "EDITOR" | "VIEW";
  active: boolean;
  authSource: "OIDC" | "LOCAL";
}

// Role/active-status management (§4). Name/email come from OIDC and
// aren't editable here — a user's own account can't be demoted or
// deactivated from this screen, enforced both here and server-side.
function UserManagementPanel() {
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();

  const usersQuery = useQuery({
    queryKey: ["users", "admin-list"],
    queryFn: () => apiFetch<AdminUser[]>("/api/users"),
  });

  const updateUser = useMutation({
    mutationFn: ({ id, ...patch }: { id: string; role?: AdminUser["role"]; active?: boolean }) =>
      apiFetch(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["users", "admin-list"] }),
  });

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        Users
      </Typography>
      <List dense>
        {usersQuery.data?.map((u) => {
          const isSelf = u.id === currentUser?.id;
          return (
            <ListItem key={u.id} divider>
              <ListItemText
                primary={
                  <Stack direction="row" spacing={1} alignItems="center">
                    <span>{u.displayName ?? u.email}</span>
                    <Chip size="small" label={u.authSource} variant="outlined" />
                    {!u.active && <Chip size="small" label="Inactive" color="error" />}
                  </Stack>
                }
                secondary={u.email}
              />
              <FormControl size="small" sx={{ minWidth: 110, mr: 2 }}>
                <Select
                  value={u.role}
                  disabled={isSelf || updateUser.isPending}
                  onChange={(e) => updateUser.mutate({ id: u.id, role: e.target.value as AdminUser["role"] })}
                >
                  <MenuItem value="ADMIN">Admin</MenuItem>
                  <MenuItem value="EDITOR">Editor</MenuItem>
                  <MenuItem value="VIEW">View</MenuItem>
                </Select>
              </FormControl>
              <FormControlLabel
                control={
                  <Switch
                    checked={u.active}
                    disabled={isSelf || updateUser.isPending}
                    onChange={(e) => updateUser.mutate({ id: u.id, active: e.target.checked })}
                  />
                }
                label="Active"
              />
            </ListItem>
          );
        })}
        {usersQuery.data?.length === 0 && <Typography color="text.secondary">No users yet.</Typography>}
      </List>
    </Box>
  );
}

interface CostRate {
  id: string;
  agentId: string | null;
  promptRatePerMillion: string;
  completionRatePerMillion: string;
  effectiveFrom: string;
}

// Internal cost computation rates (§8) — no external billing API exists
// in an air-gapped deployment, so cost is derived from these + tracked
// token counts (packages/worker/src/costCalculator.ts).
function CostRatesPanel() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [promptRate, setPromptRate] = useState("");
  const [completionRate, setCompletionRate] = useState("");

  const ratesQuery = useQuery({
    queryKey: ["cost-rates"],
    queryFn: () => apiFetch<CostRate[]>("/api/cost-rates"),
  });

  const createRate = useMutation({
    mutationFn: () =>
      apiFetch("/api/cost-rates", {
        method: "POST",
        body: JSON.stringify({
          agentId: agentId || undefined,
          promptRatePerMillion: Number(promptRate),
          completionRatePerMillion: Number(completionRate),
        }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["cost-rates"] });
      setCreateOpen(false);
      setAgentId("");
      setPromptRate("");
      setCompletionRate("");
    },
  });

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="h6">Cost Rates</Typography>
        <Button variant="contained" size="small" onClick={() => setCreateOpen(true)}>
          New Rate
        </Button>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        $ per million tokens, used to compute a run's cost from its tracked token usage. Rates
        apply from their effective date forward — past runs keep the cost computed at the time
        they ran.
      </Typography>

      <List dense>
        {ratesQuery.data?.map((rate) => (
          <ListItem key={rate.id} divider>
            <ListItemText
              primary={rate.agentId ?? "(global default)"}
              secondary={`Prompt: $${rate.promptRatePerMillion}/M · Completion: $${rate.completionRatePerMillion}/M · effective ${new Date(rate.effectiveFrom).toLocaleDateString()}`}
            />
          </ListItem>
        ))}
        {ratesQuery.data?.length === 0 && (
          <Typography color="text.secondary">
            No cost rates configured yet — runs will show token counts with cost "not costed."
          </Typography>
        )}
      </List>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>New Cost Rate</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              label="Agent ID (optional — blank applies as the global default)"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              fullWidth
            />
            <TextField
              label="Prompt rate ($ per million tokens)"
              type="number"
              value={promptRate}
              onChange={(e) => setPromptRate(e.target.value)}
              fullWidth
            />
            <TextField
              label="Completion rate ($ per million tokens)"
              type="number"
              value={completionRate}
              onChange={(e) => setCompletionRate(e.target.value)}
              fullWidth
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!promptRate || !completionRate || createRate.isPending}
            onClick={() => createRate.mutate()}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

// Object-level classification taxonomy (REQUIREMENTS §6) — deliberately
// separate from, and with no effect on, the system-wide classification
// banner, which isn't app-managed data at all (it's set once as part of
// deployment configuration, not edited here).
function ClassificationLabelsPanel() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [text, setText] = useState("");
  const [abbreviation, setAbbreviation] = useState("");
  const [badgeBgColor, setBadgeBgColor] = useState("#b71c1c");
  const [badgeTextColor, setBadgeTextColor] = useState("#ffffff");
  const [sortOrder, setSortOrder] = useState(0);
  const [isDefault, setIsDefault] = useState(false);

  const labelsQuery = useQuery({
    queryKey: ["classification-labels"],
    queryFn: () => apiFetch<ClassificationLabel[]>("/api/classification-labels"),
  });

  const createLabel = useMutation({
    mutationFn: () =>
      apiFetch("/api/classification-labels", {
        method: "POST",
        body: JSON.stringify({
          text,
          abbreviation: abbreviation || undefined,
          badgeBgColor,
          badgeTextColor,
          sortOrder,
          isDefault,
        }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["classification-labels"] });
      setCreateOpen(false);
      setText("");
      setAbbreviation("");
      setSortOrder(0);
      setIsDefault(false);
    },
  });

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="h6">Classification Taxonomy</Typography>
        <Button variant="contained" size="small" onClick={() => setCreateOpen(true)}>
          New Label
        </Button>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Applied per-Project/Prompt as a badge. Independent of the system-wide classification
        banner shown on every page.
      </Typography>

      <List dense>
        {labelsQuery.data?.map((label) => (
          <ListItem key={label.id} divider>
            <ListItemText
              primary={
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip
                    size="small"
                    label={label.abbreviation || label.text}
                    sx={{ backgroundColor: label.badgeBgColor, color: label.badgeTextColor, fontWeight: 700 }}
                  />
                  <span>{label.text}</span>
                  {label.isDefault && <Chip size="small" label="Default" variant="outlined" />}
                </Stack>
              }
              secondary={`Sort order: ${label.sortOrder}`}
            />
          </ListItem>
        ))}
        {labelsQuery.data?.length === 0 && (
          <Typography color="text.secondary">
            No classification labels defined yet — Projects will show no classification badge
            until at least one exists.
          </Typography>
        )}
      </List>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>New Classification Label</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="Text" value={text} onChange={(e) => setText(e.target.value)} autoFocus fullWidth />
            <TextField
              label="Abbreviation (optional, shown on badge)"
              value={abbreviation}
              onChange={(e) => setAbbreviation(e.target.value)}
              fullWidth
            />
            <Stack direction="row" spacing={2}>
              <TextField
                label="Badge background color"
                type="color"
                value={badgeBgColor}
                onChange={(e) => setBadgeBgColor(e.target.value)}
                fullWidth
              />
              <TextField
                label="Badge text color"
                type="color"
                value={badgeTextColor}
                onChange={(e) => setBadgeTextColor(e.target.value)}
                fullWidth
              />
            </Stack>
            <TextField
              label="Sort order"
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(Number(e.target.value))}
              fullWidth
            />
            <FormControlLabel
              control={<Checkbox checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />}
              label="Default for new Projects"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button variant="contained" disabled={!text || createLabel.isPending} onClick={() => createLabel.mutate()}>
            Create
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
