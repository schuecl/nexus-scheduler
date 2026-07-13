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
import { useConfirm } from "../context/ConfirmContext";
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

      <SystemSettingsPanel />
      <Divider />
      <UsageReportPanel />
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
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [editingDestination, setEditingDestination] = useState<WebhookDestination | null>(null);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  const updateDestination = useMutation({
    mutationFn: () =>
      apiFetch(`/api/webhook-destinations/${editingDestination!.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: editName, url: editUrl }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["webhook-destinations"] });
      setEditingDestination(null);
    },
  });

  const deleteDestination = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/webhook-destinations/${id}`, { method: "DELETE" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["webhook-destinations"] }),
    onError: (err: unknown) => setDeleteError(err instanceof Error ? err.message : "delete failed"),
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

      {deleteError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setDeleteError(null)}>
          {deleteError}
        </Alert>
      )}

      <List dense>
        {destinationsQuery.data?.map((destination) => (
          <ListItem
            key={destination.id}
            divider
            secondaryAction={
              <Stack direction="row" spacing={1}>
                <Button
                  size="small"
                  onClick={() => {
                    setEditingDestination(destination);
                    setEditName(destination.name);
                    setEditUrl(destination.url);
                  }}
                >
                  Edit
                </Button>
                <Button
                  size="small"
                  color={destination.active ? "error" : "primary"}
                  onClick={() => setActive.mutate({ id: destination.id, active: !destination.active })}
                >
                  {destination.active ? "Disable" : "Enable"}
                </Button>
                <Button
                  size="small"
                  color="error"
                  disabled={deleteDestination.isPending}
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Delete webhook destination?",
                      message: `Delete "${destination.name}"? Any Job currently sending results to it will stop. This can't be undone.`,
                    });
                    if (ok) deleteDestination.mutate(destination.id);
                  }}
                >
                  Delete
                </Button>
              </Stack>
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

      <Dialog open={!!editingDestination} onClose={() => setEditingDestination(null)} fullWidth maxWidth="sm">
        <DialogTitle>Edit Webhook Destination</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="Name" value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus fullWidth />
            <TextField label="URL" value={editUrl} onChange={(e) => setEditUrl(e.target.value)} fullWidth />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditingDestination(null)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!editName || !editUrl || updateDestination.isPending}
            onClick={() => updateDestination.mutate()}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

interface AdminSettings {
  productName: string;
  logoUrl: string | null;
  primaryColor: string;
  classificationBannerText: string;
  classificationBannerBgColor: string;
  classificationBannerTextColor: string;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  smtpUsername: string | null;
  smtpFromAddress: string | null;
  smtpPasswordSet: boolean;
  syslogEnabled: boolean;
  syslogHost: string | null;
  syslogPort: number | null;
  syslogTransport: "TCP" | "UDP";
  syslogTls: boolean;
  syslogTlsCaCert: string | null;
  usageReportEnabled: boolean;
  usageReportRecipients: string[];
  usageReportFrequency: "WEEKLY" | "MONTHLY";
}

// Branding (§5) and the system-wide classification banner (§6) — one
// settings surface, two independent concerns. The banner is never
// derived from anything else here; it's just admin-set text/colors.
// SMTP (§5) lives in the same singleton row, so it's edited here too.
function SystemSettingsPanel() {
  const { refetch: refetchPublicSettings } = useSettings();
  const queryClient = useQueryClient();
  const adminSettingsQuery = useQuery({
    queryKey: ["settings", "admin"],
    queryFn: () => apiFetch<AdminSettings>("/api/settings/admin"),
  });

  const [productName, setProductName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [primaryColor, setPrimaryColor] = useState("#1565c0");
  const [bannerText, setBannerText] = useState("");
  const [bannerBg, setBannerBg] = useState("");
  const [bannerFg, setBannerFg] = useState("");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("");
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpUsername, setSmtpUsername] = useState("");
  const [smtpPassword, setSmtpPassword] = useState(""); // blank = leave unchanged
  const [smtpFromAddress, setSmtpFromAddress] = useState("");
  const [syslogEnabled, setSyslogEnabled] = useState(false);
  const [syslogHost, setSyslogHost] = useState("");
  const [syslogPort, setSyslogPort] = useState("");
  const [syslogTransport, setSyslogTransport] = useState<"TCP" | "UDP">("TCP");
  const [syslogTls, setSyslogTls] = useState(false);
  // PEM contents of an uploaded CA cert. "" is a deliberate "clear it",
  // distinct from the loaded value; the filename is kept only for display.
  const [syslogTlsCaCert, setSyslogTlsCaCert] = useState("");
  const [syslogTlsCaCertName, setSyslogTlsCaCertName] = useState("");
  const [usageReportEnabled, setUsageReportEnabled] = useState(false);
  const [usageReportRecipients, setUsageReportRecipients] = useState(""); // comma-separated in the UI
  const [usageReportFrequency, setUsageReportFrequency] = useState<"WEEKLY" | "MONTHLY">("WEEKLY");

  // Settings arrive asynchronously — seed the form once they load rather
  // than leaving fields stuck empty.
  useEffect(() => {
    const s = adminSettingsQuery.data;
    if (!s) return;
    setProductName(s.productName);
    setLogoUrl(s.logoUrl ?? "");
    setPrimaryColor(s.primaryColor);
    setBannerText(s.classificationBannerText);
    setBannerBg(s.classificationBannerBgColor);
    setBannerFg(s.classificationBannerTextColor);
    setSmtpHost(s.smtpHost ?? "");
    setSmtpPort(s.smtpPort ? String(s.smtpPort) : "");
    setSmtpSecure(s.smtpSecure);
    setSmtpUsername(s.smtpUsername ?? "");
    setSmtpFromAddress(s.smtpFromAddress ?? "");
    setSyslogEnabled(s.syslogEnabled);
    setSyslogHost(s.syslogHost ?? "");
    setSyslogPort(s.syslogPort ? String(s.syslogPort) : "");
    setSyslogTransport(s.syslogTransport);
    setSyslogTls(s.syslogTls);
    setSyslogTlsCaCert(s.syslogTlsCaCert ?? "");
    setSyslogTlsCaCertName(s.syslogTlsCaCert ? "current certificate on file" : "");
    setUsageReportEnabled(s.usageReportEnabled);
    setUsageReportRecipients(s.usageReportRecipients.join(", "));
    setUsageReportFrequency(s.usageReportFrequency);
  }, [adminSettingsQuery.data]);

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
          smtpHost: smtpHost || null,
          smtpPort: smtpPort ? Number(smtpPort) : null,
          smtpSecure,
          smtpUsername: smtpUsername || null,
          ...(smtpPassword ? { smtpPassword } : {}),
          smtpFromAddress: smtpFromAddress || null,
          syslogEnabled,
          syslogHost: syslogHost || null,
          syslogPort: syslogPort ? Number(syslogPort) : null,
          syslogTransport,
          syslogTls,
          // Seeded from the DB on load, so re-sending preserves an existing
          // cert; "" (uploaded-then-cleared, or TLS off) clears it.
          syslogTlsCaCert: syslogTls ? syslogTlsCaCert || null : null,
          usageReportEnabled,
          usageReportRecipients: usageReportRecipients
            .split(",")
            .map((r) => r.trim())
            .filter(Boolean),
          usageReportFrequency,
        }),
      }),
    onSuccess: () => {
      refetchPublicSettings();
      void queryClient.invalidateQueries({ queryKey: ["settings", "admin"] });
      setSmtpPassword("");
    },
  });

  const testEmail = useMutation({
    mutationFn: () => apiFetch("/api/settings/smtp/test", { method: "POST" }),
  });

  // Sends the current (possibly unsaved) form values rather than no body
  // at all — otherwise "Test" would silently test whatever was last
  // saved instead of what's actually in the form, including a just-
  // uploaded CA cert the admin hasn't hit Save on yet.
  const testSyslog = useMutation({
    mutationFn: () =>
      apiFetch("/api/settings/syslog/test", {
        method: "POST",
        body: JSON.stringify({
          host: syslogHost || undefined,
          port: syslogPort ? Number(syslogPort) : undefined,
          transport: syslogTransport,
          tls: syslogTls,
          caCert: syslogTls ? syslogTlsCaCert || null : null,
        }),
      }),
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
        <TextField label="Logo URL (optional)" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} />
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

        <Divider />
        <Typography variant="subtitle1">SMTP</Typography>
        <Typography variant="body2" color="text.secondary">
          Used for account emails (password set/reset) and, eventually, job completion/failure
          notifications.
        </Typography>
        <Stack direction="row" spacing={2}>
          <TextField label="Host" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} fullWidth />
          <TextField
            label="Port"
            type="number"
            value={smtpPort}
            onChange={(e) => setSmtpPort(e.target.value)}
            sx={{ width: 120 }}
          />
        </Stack>
        <FormControlLabel
          control={<Switch checked={smtpSecure} onChange={(e) => setSmtpSecure(e.target.checked)} />}
          label="Use TLS"
        />
        <TextField label="Username" value={smtpUsername} onChange={(e) => setSmtpUsername(e.target.value)} />
        <TextField
          label="Password"
          type="password"
          value={smtpPassword}
          onChange={(e) => setSmtpPassword(e.target.value)}
          placeholder={adminSettingsQuery.data?.smtpPasswordSet ? "•••••••• (set — leave blank to keep)" : ""}
        />
        <TextField
          label="From address"
          value={smtpFromAddress}
          onChange={(e) => setSmtpFromAddress(e.target.value)}
        />

        <Divider />
        <Typography variant="subtitle1">Syslog</Typography>
        <Typography variant="body2" color="text.secondary">
          Mirrors every audit event (REQUIREMENTS §7.1) as an RFC 5424 message to an external
          log pipeline/SIEM, independent of the 14-day local audit retention.
        </Typography>
        <FormControlLabel
          control={<Switch checked={syslogEnabled} onChange={(e) => setSyslogEnabled(e.target.checked)} />}
          label="Enabled"
        />
        <Stack direction="row" spacing={2}>
          <TextField label="Host" value={syslogHost} onChange={(e) => setSyslogHost(e.target.value)} fullWidth />
          <TextField
            label="Port"
            type="number"
            value={syslogPort}
            onChange={(e) => setSyslogPort(e.target.value)}
            sx={{ width: 120 }}
          />
        </Stack>
        <FormControl fullWidth>
          <InputLabel id="syslog-transport-label">Transport</InputLabel>
          <Select
            labelId="syslog-transport-label"
            label="Transport"
            value={syslogTransport}
            onChange={(e) => setSyslogTransport(e.target.value as "TCP" | "UDP")}
          >
            <MenuItem value="TCP">TCP</MenuItem>
            <MenuItem value="UDP">UDP</MenuItem>
          </Select>
        </FormControl>
        <FormControlLabel
          control={<Switch checked={syslogTls} onChange={(e) => setSyslogTls(e.target.checked)} />}
          label="Use TLS (TCP only, RFC 5425)"
          disabled={syslogTransport !== "TCP"}
        />
        {syslogTls && (
          <Stack spacing={1}>
            <Typography variant="body2" color="text.secondary">
              CA certificate (PEM) — upload only if your syslog receiver uses a private/self-signed CA
              not in the system trust store. Leave empty to use the default trust roots.
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center">
              <Button variant="outlined" component="label" size="small">
                Upload CA certificate
                <input
                  type="file"
                  hidden
                  accept=".pem,.crt,.cer,.ca,application/x-pem-file,application/x-x509-ca-cert,text/plain"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    // Reset the input so re-selecting the same file still fires onChange.
                    e.target.value = "";
                    if (!file) return;
                    const text = await file.text();
                    setSyslogTlsCaCert(text);
                    setSyslogTlsCaCertName(file.name);
                  }}
                />
              </Button>
              {syslogTlsCaCert && (
                <Button
                  variant="text"
                  size="small"
                  color="error"
                  onClick={() => {
                    setSyslogTlsCaCert("");
                    setSyslogTlsCaCertName("");
                  }}
                >
                  Remove
                </Button>
              )}
              <Typography variant="body2" color="text.secondary">
                {syslogTlsCaCertName || "no certificate uploaded"}
              </Typography>
            </Stack>
          </Stack>
        )}

        <Divider />
        <Typography variant="subtitle1">Recurring Usage Report</Typography>
        <Typography variant="body2" color="text.secondary">
          Emails the same run-counts/token-usage/cost PDF shown in the Usage Report panel below to
          the listed recipients on a recurring cadence (§2.5/§8). On-demand export doesn't require
          this to be enabled.
        </Typography>
        <FormControlLabel
          control={
            <Switch checked={usageReportEnabled} onChange={(e) => setUsageReportEnabled(e.target.checked)} />
          }
          label="Enabled"
        />
        <TextField
          label="Recipients (comma-separated emails)"
          value={usageReportRecipients}
          onChange={(e) => setUsageReportRecipients(e.target.value)}
          fullWidth
        />
        <FormControl fullWidth>
          <InputLabel id="usage-report-frequency-label">Frequency</InputLabel>
          <Select
            labelId="usage-report-frequency-label"
            label="Frequency"
            value={usageReportFrequency}
            onChange={(e) => setUsageReportFrequency(e.target.value as "WEEKLY" | "MONTHLY")}
          >
            <MenuItem value="WEEKLY">Weekly</MenuItem>
            <MenuItem value="MONTHLY">Monthly</MenuItem>
          </Select>
        </FormControl>

        {save.isSuccess && <Alert severity="success">Saved.</Alert>}
        {testEmail.isSuccess && <Alert severity="success">Test email sent — check your inbox.</Alert>}
        {testEmail.isError && <Alert severity="error">Test email failed to send.</Alert>}
        {testSyslog.isSuccess && <Alert severity="success">Test syslog message sent.</Alert>}
        {testSyslog.isError && (
          <Alert severity="error">
            Test syslog message failed to send:{" "}
            {testSyslog.error instanceof Error ? testSyslog.error.message : "unknown error"}
          </Alert>
        )}
        <Stack direction="row" spacing={1}>
          <Button variant="contained" disabled={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
          <Button variant="outlined" disabled={testEmail.isPending} onClick={() => testEmail.mutate()}>
            Send test email
          </Button>
          <Button variant="outlined" disabled={testSyslog.isPending} onClick={() => testSyslog.mutate()}>
            Send test syslog message
          </Button>
        </Stack>
      </Stack>
    </Box>
  );
}

interface UsageReportStats {
  periodStart: string;
  periodEnd: string;
  runCounts: Partial<Record<"PENDING" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED" | "SKIPPED", number>>;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCost: string | null;
}

function defaultDateInput(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// On-demand org-wide export (§8) — distinct from the per-user-scoped
// Dashboard tab (which only shows Projects the requesting user can see).
// CSV/PDF downloads navigate directly to the API route rather than
// fetching a blob through apiFetch: same-origin session cookies carry
// over on a plain navigation, and the API sets Content-Disposition so
// the browser handles the filename/save-as itself.
function UsageReportPanel() {
  const [from, setFrom] = useState(defaultDateInput(30));
  const [to, setTo] = useState(defaultDateInput(0));

  const statsQuery = useQuery({
    queryKey: ["usage-report", from, to],
    queryFn: () =>
      apiFetch<UsageReportStats>(`/api/admin/usage-report?from=${from}&to=${to}`),
  });

  const stats = statsQuery.data;
  const total = stats ? Object.values(stats.runCounts).reduce((sum, n) => sum + (n ?? 0), 0) : 0;
  const successRate = stats && total > 0 ? Math.round(((stats.runCounts.SUCCESS ?? 0) / total) * 100) : null;

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        Usage Report
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Org-wide run counts, success/failure rate, token usage, and cost for a date range —
        downloadable as CSV (per-run detail) or PDF (summary), independent of the recurring email
        above.
      </Typography>

      <Stack direction="row" spacing={2} sx={{ mb: 2 }} alignItems="center">
        <TextField
          label="From"
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <TextField
          label="To"
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <Button
          variant="outlined"
          component="a"
          href={`/api/admin/usage-report/csv?from=${from}&to=${to}`}
        >
          Download CSV
        </Button>
        <Button
          variant="outlined"
          component="a"
          href={`/api/admin/usage-report/pdf?from=${from}&to=${to}`}
        >
          Download PDF
        </Button>
      </Stack>

      {stats && (
        <Stack direction="row" spacing={3} flexWrap="wrap">
          <Typography variant="body2">Total runs: {total}</Typography>
          <Typography variant="body2">Success rate: {successRate === null ? "—" : `${successRate}%`}</Typography>
          <Typography variant="body2">Prompt tokens: {stats.totalPromptTokens.toLocaleString()}</Typography>
          <Typography variant="body2">Completion tokens: {stats.totalCompletionTokens.toLocaleString()}</Typography>
          <Typography variant="body2">
            Cost: {stats.totalCost === null ? "not costed" : `$${Number(stats.totalCost).toFixed(2)}`}
          </Typography>
        </Stack>
      )}
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

// Role/active-status management (§4). Name/email come from OIDC for SSO
// users and aren't editable here — a user's own account can't be
// demoted or deactivated from this screen, enforced both here and
// server-side. Local accounts (§4 break-glass path) can also be
// provisioned here — creating one sends a password-set email rather
// than requiring a temp password to communicate out of band.
function UserManagementPanel() {
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newRole, setNewRole] = useState<AdminUser["role"]>("VIEW");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const usersQuery = useQuery({
    queryKey: ["users", "admin-list"],
    queryFn: () => apiFetch<AdminUser[]>("/api/users"),
  });

  const updateUser = useMutation({
    mutationFn: ({ id, ...patch }: { id: string; role?: AdminUser["role"]; active?: boolean }) =>
      apiFetch(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["users", "admin-list"] }),
  });

  const createUser = useMutation({
    mutationFn: () =>
      apiFetch("/api/users", {
        method: "POST",
        body: JSON.stringify({ email: newEmail, displayName: newDisplayName || undefined, role: newRole }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["users", "admin-list"] });
      setCreateOpen(false);
      setNewEmail("");
      setNewDisplayName("");
      setNewRole("VIEW");
    },
  });

  const sendReset = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/users/${id}/send-password-reset`, { method: "POST" }),
  });

  const [setPasswordUser, setSetPasswordUser] = useState<AdminUser | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [passwordSetFor, setPasswordSetFor] = useState<{ email: string; password: string } | null>(null);

  const setPassword = useMutation({
    mutationFn: () =>
      apiFetch(`/api/users/${setPasswordUser!.id}/set-password`, {
        method: "POST",
        body: JSON.stringify({ newPassword }),
      }),
    onSuccess: () => {
      setPasswordSetFor({ email: setPasswordUser!.email, password: newPassword });
      setSetPasswordUser(null);
      setNewPassword("");
    },
  });

  function generatePassword(): string {
    // 20 chars from a-z/A-Z/0-9, drawn via Web Crypto rather than Math.random
    // — this is handed directly to a real user account, not a UI toy.
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    const bytes = new Uint32Array(20);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  }

  const deleteUser = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/users/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["users", "admin-list"] });
      setDeleteError(null);
    },
    onError: (err: unknown) => setDeleteError(err instanceof Error ? err.message : "delete failed"),
  });

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="h6">Users</Typography>
        <Button variant="contained" size="small" onClick={() => setCreateOpen(true)}>
          New Local User
        </Button>
      </Stack>
      {createUser.isSuccess && (
        <Alert severity="success" sx={{ mb: 1 }}>
          Account created — a password-set email was sent (if SMTP is configured).
        </Alert>
      )}
      {sendReset.isSuccess && (
        <Alert severity="success" sx={{ mb: 1 }}>
          Password reset email sent.
        </Alert>
      )}
      {passwordSetFor && (
        <Alert severity="success" sx={{ mb: 1 }} onClose={() => setPasswordSetFor(null)}>
          Password set for {passwordSetFor.email}: <strong>{passwordSetFor.password}</strong> — give this to
          the user now, it won't be shown again.
        </Alert>
      )}
      {deleteError && (
        <Alert severity="error" sx={{ mb: 1 }} onClose={() => setDeleteError(null)}>
          {deleteError}
        </Alert>
      )}

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
              {u.authSource === "LOCAL" && (
                <Button size="small" sx={{ mr: 1 }} disabled={sendReset.isPending} onClick={() => sendReset.mutate(u.id)}>
                  Send password reset
                </Button>
              )}
              {u.authSource === "LOCAL" && (
                <Button
                  size="small"
                  sx={{ mr: 2 }}
                  onClick={() => {
                    setSetPasswordUser(u);
                    setNewPassword(generatePassword());
                  }}
                >
                  Set Password
                </Button>
              )}
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
              <Button
                size="small"
                color="error"
                sx={{ ml: 2 }}
                disabled={isSelf || deleteUser.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: "Delete user?",
                    message: `Delete "${u.displayName ?? u.email}"? This can't be undone.`,
                  });
                  if (ok) deleteUser.mutate(u.id);
                }}
              >
                Delete
              </Button>
            </ListItem>
          );
        })}
        {usersQuery.data?.length === 0 && <Typography color="text.secondary">No users yet.</Typography>}
      </List>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>New Local User</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="Email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} autoFocus fullWidth />
            <TextField
              label="Display name (optional)"
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
              fullWidth
            />
            <FormControl fullWidth>
              <InputLabel id="new-user-role-label">Role</InputLabel>
              <Select
                labelId="new-user-role-label"
                label="Role"
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as AdminUser["role"])}
              >
                <MenuItem value="ADMIN">Admin</MenuItem>
                <MenuItem value="EDITOR">Editor</MenuItem>
                <MenuItem value="VIEW">View</MenuItem>
              </Select>
            </FormControl>
            <Typography variant="body2" color="text.secondary">
              No password is set here — the new user gets an email with a link to set their own,
              same as a self-service password reset.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button variant="contained" disabled={!newEmail || createUser.isPending} onClick={() => createUser.mutate()}>
            Create
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!setPasswordUser} onClose={() => setSetPasswordUser(null)} fullWidth maxWidth="sm">
        <DialogTitle>Set Password for {setPasswordUser?.email}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              Sets the password immediately — no email involved. Useful when SMTP isn't configured, or
              when handing the user their password directly.
            </Typography>
            <TextField
              label="New password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoFocus
              fullWidth
              helperText="At least 12 characters"
            />
            <Button size="small" onClick={() => setNewPassword(generatePassword())} sx={{ alignSelf: "flex-start" }}>
              Generate random password
            </Button>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSetPasswordUser(null)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={newPassword.length < 12 || setPassword.isPending}
            onClick={() => setPassword.mutate()}
          >
            Set Password
          </Button>
        </DialogActions>
      </Dialog>
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
interface CostRateFormState {
  agentId: string;
  promptRate: string;
  completionRate: string;
}

const BLANK_COST_RATE_FORM: CostRateFormState = { agentId: "", promptRate: "", completionRate: "" };

function CostRateFormFields({
  form,
  onChange,
}: {
  form: CostRateFormState;
  onChange: (next: CostRateFormState) => void;
}) {
  return (
    <Stack spacing={2} sx={{ mt: 1 }}>
      <TextField
        label="Agent ID (optional — blank applies as the global default)"
        value={form.agentId}
        onChange={(e) => onChange({ ...form, agentId: e.target.value })}
        fullWidth
      />
      <TextField
        label="Prompt rate ($ per million tokens)"
        type="number"
        value={form.promptRate}
        onChange={(e) => onChange({ ...form, promptRate: e.target.value })}
        fullWidth
      />
      <TextField
        label="Completion rate ($ per million tokens)"
        type="number"
        value={form.completionRate}
        onChange={(e) => onChange({ ...form, completionRate: e.target.value })}
        fullWidth
      />
    </Stack>
  );
}

function CostRatesPanel() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CostRateFormState>(BLANK_COST_RATE_FORM);
  const [editingRate, setEditingRate] = useState<CostRate | null>(null);
  const [editForm, setEditForm] = useState<CostRateFormState>(BLANK_COST_RATE_FORM);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const ratesQuery = useQuery({
    queryKey: ["cost-rates"],
    queryFn: () => apiFetch<CostRate[]>("/api/cost-rates"),
  });

  const createRate = useMutation({
    mutationFn: () =>
      apiFetch("/api/cost-rates", {
        method: "POST",
        body: JSON.stringify({
          agentId: createForm.agentId || undefined,
          promptRatePerMillion: Number(createForm.promptRate),
          completionRatePerMillion: Number(createForm.completionRate),
        }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["cost-rates"] });
      setCreateOpen(false);
      setCreateForm(BLANK_COST_RATE_FORM);
    },
  });

  const updateRate = useMutation({
    mutationFn: () =>
      apiFetch(`/api/cost-rates/${editingRate!.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          agentId: editForm.agentId || null,
          promptRatePerMillion: Number(editForm.promptRate),
          completionRatePerMillion: Number(editForm.completionRate),
        }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["cost-rates"] });
      setEditingRate(null);
    },
  });

  const deleteRate = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/cost-rates/${id}`, { method: "DELETE" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["cost-rates"] }),
    onError: (err: unknown) => setDeleteError(err instanceof Error ? err.message : "delete failed"),
  });

  const openEdit = (rate: CostRate) => {
    setEditingRate(rate);
    setEditForm({
      agentId: rate.agentId ?? "",
      promptRate: rate.promptRatePerMillion,
      completionRate: rate.completionRatePerMillion,
    });
  };

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

      {deleteError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setDeleteError(null)}>
          {deleteError}
        </Alert>
      )}

      <List dense>
        {ratesQuery.data?.map((rate) => (
          <ListItem
            key={rate.id}
            divider
            secondaryAction={
              <Stack direction="row" spacing={1}>
                <Button size="small" onClick={() => openEdit(rate)}>
                  Edit
                </Button>
                <Button
                  size="small"
                  color="error"
                  disabled={deleteRate.isPending}
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Delete cost rate?",
                      message: `Delete the rate for ${rate.agentId ?? "the global default"} effective ${rate.effectiveFrom}? This can't be undone.`,
                    });
                    if (ok) deleteRate.mutate(rate.id);
                  }}
                >
                  Delete
                </Button>
              </Stack>
            }
          >
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
          <CostRateFormFields form={createForm} onChange={setCreateForm} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!createForm.promptRate || !createForm.completionRate || createRate.isPending}
            onClick={() => createRate.mutate()}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!editingRate} onClose={() => setEditingRate(null)} fullWidth maxWidth="sm">
        <DialogTitle>Edit Cost Rate</DialogTitle>
        <DialogContent>
          <CostRateFormFields form={editForm} onChange={setEditForm} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditingRate(null)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!editForm.promptRate || !editForm.completionRate || updateRate.isPending}
            onClick={() => updateRate.mutate()}
          >
            Save
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
interface ClassificationLabelFormState {
  text: string;
  abbreviation: string;
  badgeBgColor: string;
  badgeTextColor: string;
  sortOrder: number;
  isDefault: boolean;
}

const BLANK_LABEL_FORM: ClassificationLabelFormState = {
  text: "",
  abbreviation: "",
  badgeBgColor: "#b71c1c",
  badgeTextColor: "#ffffff",
  sortOrder: 0,
  isDefault: false,
};

function ClassificationLabelFormFields({
  form,
  onChange,
}: {
  form: ClassificationLabelFormState;
  onChange: (next: ClassificationLabelFormState) => void;
}) {
  return (
    <Stack spacing={2} sx={{ mt: 1 }}>
      <TextField
        label="Text"
        value={form.text}
        onChange={(e) => onChange({ ...form, text: e.target.value })}
        autoFocus
        fullWidth
      />
      <TextField
        label="Abbreviation (optional, shown on badge)"
        value={form.abbreviation}
        onChange={(e) => onChange({ ...form, abbreviation: e.target.value })}
        fullWidth
      />
      <Stack direction="row" spacing={2}>
        <TextField
          label="Badge background color"
          type="color"
          value={form.badgeBgColor}
          onChange={(e) => onChange({ ...form, badgeBgColor: e.target.value })}
          fullWidth
        />
        <TextField
          label="Badge text color"
          type="color"
          value={form.badgeTextColor}
          onChange={(e) => onChange({ ...form, badgeTextColor: e.target.value })}
          fullWidth
        />
      </Stack>
      <TextField
        label="Sort order"
        type="number"
        value={form.sortOrder}
        onChange={(e) => onChange({ ...form, sortOrder: Number(e.target.value) })}
        fullWidth
      />
      <FormControlLabel
        control={
          <Checkbox
            checked={form.isDefault}
            onChange={(e) => onChange({ ...form, isDefault: e.target.checked })}
          />
        }
        label="Default for new Projects"
      />
    </Stack>
  );
}

function ClassificationLabelsPanel() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<ClassificationLabelFormState>(BLANK_LABEL_FORM);
  const [editLabel, setEditLabel] = useState<ClassificationLabel | null>(null);
  const [editForm, setEditForm] = useState<ClassificationLabelFormState>(BLANK_LABEL_FORM);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const labelsQuery = useQuery({
    queryKey: ["classification-labels"],
    queryFn: () => apiFetch<ClassificationLabel[]>("/api/classification-labels"),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["classification-labels"] });

  const createLabel = useMutation({
    mutationFn: () =>
      apiFetch("/api/classification-labels", {
        method: "POST",
        body: JSON.stringify({ ...createForm, abbreviation: createForm.abbreviation || undefined }),
      }),
    onSuccess: () => {
      void invalidate();
      setCreateOpen(false);
      setCreateForm(BLANK_LABEL_FORM);
    },
  });

  const updateLabel = useMutation({
    mutationFn: () =>
      apiFetch(`/api/classification-labels/${editLabel!.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...editForm, abbreviation: editForm.abbreviation || undefined }),
      }),
    onSuccess: () => {
      void invalidate();
      setEditLabel(null);
    },
  });

  const deleteLabel = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/classification-labels/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void invalidate();
      setDeleteError(null);
    },
    onError: async (err: unknown) => {
      // apiFetch throws a bare Error on non-2xx; the API's actual 409
      // message (Project count still tagged with this label) is more
      // useful than a generic "request failed."
      if (err instanceof Error) {
        setDeleteError(err.message);
      }
    },
  });

  const openEdit = (label: ClassificationLabel) => {
    setEditLabel(label);
    setEditForm({
      text: label.text,
      abbreviation: label.abbreviation ?? "",
      badgeBgColor: label.badgeBgColor,
      badgeTextColor: label.badgeTextColor,
      sortOrder: label.sortOrder,
      isDefault: label.isDefault,
    });
  };

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

      {deleteError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setDeleteError(null)}>
          {deleteError}
        </Alert>
      )}

      <List dense>
        {labelsQuery.data?.map((label) => (
          <ListItem
            key={label.id}
            divider
            secondaryAction={
              <Stack direction="row" spacing={1}>
                <Button size="small" onClick={() => openEdit(label)}>
                  Edit
                </Button>
                <Button
                  size="small"
                  color="error"
                  disabled={deleteLabel.isPending}
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Delete classification label?",
                      message: `Delete "${label.text}"? Projects currently tagged with it will lose that label. This can't be undone.`,
                    });
                    if (ok) deleteLabel.mutate(label.id);
                  }}
                >
                  Delete
                </Button>
              </Stack>
            }
          >
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
          <ClassificationLabelFormFields form={createForm} onChange={setCreateForm} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!createForm.text || createLabel.isPending}
            onClick={() => createLabel.mutate()}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!editLabel} onClose={() => setEditLabel(null)} fullWidth maxWidth="sm">
        <DialogTitle>Edit Classification Label</DialogTitle>
        <DialogContent>
          <ClassificationLabelFormFields form={editForm} onChange={setEditForm} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditLabel(null)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!editForm.text || updateLabel.isPending}
            onClick={() => updateLabel.mutate()}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
