import { Stack, Typography } from "@mui/material";
import { useAuth } from "../context/AuthContext";
import { SystemStatusGraph } from "../components/SystemStatusGraph";

// Live system map — admin-owned. This is operational data ("is Redis
// reachable right now"), which the platform owner acts on; regular
// users don't need it, and the Knowledge Base deliberately carries only
// static documentation (the KB Architecture article explains the same
// topology as a diagram, without live state).
export function SystemMapPage() {
  const { user } = useAuth();
  if (user?.role !== "ADMIN") {
    return <Typography color="error">Admin role required.</Typography>;
  }

  return (
    <Stack spacing={2}>
      <Typography variant="h4">System Map</Typography>
      <SystemStatusGraph />

      <Typography variant="h6">How it&apos;s determined</Typography>
      <Typography variant="body2" color="text.secondary">
        Two different mechanisms feed the same diagram, because reachability isn&apos;t always knowable
        from one side. Postgres, Redis, and the PDF service are probed directly by the API on every
        refresh — there&apos;s exactly one true status per link, so the API checking it once is enough.
        LibreChat and the OCR service, and the Worker&apos;s own liveness, can only be checked by the
        Worker itself (nothing else in this app calls them directly): the Worker publishes what it
        finds to Redis every 30 seconds with a short expiry, so if the Worker crashes or is scaled to
        zero the published status simply expires and shows as &quot;No recent report&quot; rather than a stale
        last-known-good value. For the OCR service the probe is a real health check (its /healthz),
        not mere TCP reachability.
      </Typography>

      <Typography variant="h6">Reading the colors</Typography>
      <Typography variant="body2" color="text.secondary">
        Green — reachable right now. Red — configured, but the last check failed. Grey &quot;No recent
        report&quot; — no reachability data has arrived recently; for Worker-reported components this
        almost always means the Worker itself isn&apos;t running, not that the component is down. Grey
        &quot;Not configured&quot; — the component is optional and this deployment hasn&apos;t enabled it (today:
        the OCR service without OCR_SERVICE_URL set on the Worker — jobs still run, attachments are
        simply not extracted).
      </Typography>
    </Stack>
  );
}
